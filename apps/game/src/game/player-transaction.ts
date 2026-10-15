/** Atomic online profile/inventory mutation, shared by claims and Labyrinth.
 * Caller owns the player's persistence lock and packet/fight write barriers.
 * Only profile, match and ordinary inventory may be changed: cards/pets are
 * shared read-only for stat calculations, not part of this transaction. */
import { eq } from "drizzle-orm";
import { player, type Database } from "@ddt/db";
import type { GSPacket } from "@ddt/protocol";
import type { ServerContext } from "../session/context.js";
import { savePlayerInfo } from "../db/characters.js";
import { saveItem } from "../db/items.js";
import { mailItems } from "../handlers/items.js";
import { GamePlayer } from "./player.js";
import { ItemInfo } from "./item.js";
import * as Out from "../packets/out.js";

export class PlayerMutationCommittedError<T> extends Error {
  constructor(readonly value: T, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Committed player notification failed", { cause });
  }
}
class PlayerChanged extends Error {}
class PlayerMutationSkipped extends Error {}
const snapshot = (item: ItemInfo) => JSON.stringify(item.toRow());
// Quit may mark State=0 while waiting for this same persistence lock.
const profile = (p: GamePlayer) => JSON.stringify({ info: { ...p.info, State: 0 }, match: p.match });
const inventory = (p: GamePlayer) => p.allBags().map((bag) => ({ bag, capacity: bag.capacity,
  items: bag.getItems(), removed: [...bag.removed], dirty: bag.dirtyItems() }));

function stage(ctx: ServerContext, p: GamePlayer) {
  const sent: GSPacket[] = [], gradeUps: number[] = [];
  const staged = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "player-transaction-stage" },
    structuredClone(p.info), structuredClone(p.match), p.zoneId, p.zoneName, (g) => ctx.templates.levels.get(g) ?? 0);
  staged.statTables = p.statTables; staged.cards = p.cards; staged.pet = p.pet;
  staged.cardBag = p.cardBag; staged.petBag = p.petBag;
  staged.gradeForGp = p.gradeForGp; staged.lang = p.lang;
  staged.onGradeUp = (old) => gradeUps.push(old);
  const bags = inventory(p), original = new Map<ItemInfo, { copy: ItemInfo; before: string; dirty: boolean; cellLocked: boolean; existed: boolean }>();
  const copy = (item: ItemInfo) => {
    let entry = original.get(item);
    if (!entry) {
      const clone = ItemInfo.fromRow({ ...structuredClone(item.toRow()), ItemID: item.ItemID }, item.template);
      clone.cellLocked = item.cellLocked;
      entry = { copy: clone, before: snapshot(item), dirty: item.isDirty, cellLocked: item.cellLocked, existed: item.IsExist }; original.set(item, entry);
    }
    return entry.copy;
  };
  for (const { bag, items, removed } of bags) {
    const target = staged.getInventory(bag.bagType)!;
    target.capacity = bag.capacity;
    for (const item of items) if (!target.addItemTo(copy(item), item.Place)) throw new PlayerChanged();
    target.removed.push(...removed.map(copy));
  }
  for (const [item, entry] of original) { Object.assign(entry.copy, structuredClone(item.toRow())); entry.copy.isDirty = entry.dirty; }
  // Loading equipped copies recalculates stats; use the exact live starting profile.
  staged.info = structuredClone(p.info); staged.match = structuredClone(p.match);
  staged.baseAttack = p.baseAttack; staged.baseDefence = p.baseDefence;
  sent.length = 0;
  return { staged, sent, gradeUps, original, bags, profileBefore: profile(p) };
}

/** work executes under the SQL owner-row lock and receives only detached state.
 * Return null to roll back a rejected/replayed claim. Notifications
 * occur after publication; their failure carries the already committed value. */
export async function commitPlayerMutation<T>(ctx: ServerContext, p: GamePlayer,
  work: (db: Database, staged: GamePlayer, now: Date) => Promise<{ value: T; overflow?: ItemInfo[]; mailTitle?: string } | null>): Promise<T | null> {
  const committed = await ctx.db.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const [owner] = await tx.select({ id: player.Sys_Users_Detail.UserID }).from(player.Sys_Users_Detail)
      .where(eq(player.Sys_Users_Detail.UserID, p.id)).for("update");
    if (!owner) throw new Error("Player transaction recipient missing");
    const now = ctx.now(), plan = stage(ctx, p), { staged, original } = plan;
    const result = await work(db, staged, now);
    if (!result) throw new PlayerMutationSkipped();
    if (staged.allBags().some((bag, i) => bag.capacity !== plan.bags[i]!.capacity)) throw new PlayerChanged("Inventory capacity is outside the player mutation contract");
    const byCopy = new Map([...original.values()].map((old) => [old.copy, old]));
    const changed = new Set(staged.allBags().flatMap((b) => b.getItems()).filter((item) => {
      const old = byCopy.get(item);
      return !old || snapshot(item) !== old.before;
    }));
    // Fight/Temp bags are transient, but tombstones of persisted items are not.
    const pending = [...new Set(staged.allBags().flatMap((b) => b.saveToDb ? b.dirtyItems() : b.removed))];
    const ids = new Set<number>();
    for (const item of pending) {
      if (item.ItemID > 0) {
        if (ids.has(item.ItemID)) throw new PlayerChanged();
        ids.add(item.ItemID);
        const [stored] = await tx.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, item.ItemID)).for("update");
        const old = byCopy.get(item);
        if (!stored || stored.UserID !== p.id || stored.TemplateID !== item.TemplateID || !old || (old.existed && !stored.IsExist) ||
            (!old.dirty && !plan.bags.some((b) => b.dirty.some((it) => original.get(it) === old)) && snapshot(ItemInfo.fromRow(stored, item.template)) !== old.before)) throw new PlayerChanged();
      }
      await saveItem(db, item);
    }
    await savePlayerInfo(db, staged.info, staged.match);
    if (result.overflow?.length) await mailItems({ ...ctx, db: { ...ctx.db, db } }, staged, result.overflow, result.mailTitle ?? "活动奖励", 12);
    const current = inventory(p);
    if (profile(p) !== plan.profileBefore || [...original].some(([item, old]) => snapshot(item) !== old.before || item.isDirty !== old.dirty || item.cellLocked !== old.cellLocked) ||
        current.some((b, i) => b.capacity !== plan.bags[i]!.capacity || ["items", "removed", "dirty"].some((key) => {
          const field = key as "items" | "removed" | "dirty", old = plan.bags[i]![field];
          return b[field].length !== old.length || b[field].some((item, n) => item !== old[n]);
        }))) throw new PlayerChanged("Player transaction recipient changed before commit");
    return { ...plan, pending, changed, value: result.value };
  }).catch((error: unknown) => { if (error instanceof PlayerMutationSkipped) return null; throw error; });
  if (!committed) return null;
  const { staged, original, pending } = committed;
  const real = new Map([...original].map(([item, old]) => [old.copy, item]));
  const bags = p.allBags(); bags.forEach((bag) => bag.beginChanges());
  // Remove using the OLD slot/row before assigning consumed Place=-1. This also
  // frees a slot reused by a reward in the same transaction.
  for (const { bag, items } of committed.bags) {
    const after = staged.getInventory(bag.bagType)!;
    for (const item of items) {
      const copy = original.get(item)!.copy;
      if (after.getItemAt(item.Place) !== copy) bag.takeOutItem(item);
    }
  }
  for (const [item, old] of original) {
    Object.assign(item, old.copy.toRow()); item.isDirty = old.copy.isDirty;
  }
  for (const bag of staged.allBags()) {
    const target = p.getInventory(bag.bagType)!;
    for (const item of bag.getItems()) {
      const existing = real.get(item), live = existing ?? item;
      if (target.getItemAt(item.Place) !== live) target.addItemTo(live, item.Place);
      else if (committed.changed.has(item)) target.updateItem(live);
      // add/update marks dirty; the committed rows are already saved.
      if (pending.includes(item)) live.isDirty = false;
    }
    for (let i = target.removed.length - 1; i >= 0; i--) if (pending.some((item) => (real.get(item) ?? item) === target.removed[i])) target.removed.splice(i, 1);
  }
  for (const item of pending) { const existing = real.get(item); if (existing) existing.isDirty = false; }
  const state = p.info.State;
  Object.assign(p.info, staged.info); p.info.State = state;
  Object.assign(p.match, staged.match);
  p.baseAttack = staged.baseAttack; p.baseDefence = staged.baseDefence;
  // Finish ALL memory publication before any transport callback can fail.
  let notificationError: unknown;
  const notify = (fn: () => void) => { try { fn(); } catch (error) { notificationError ??= error; } };
  for (const old of committed.gradeUps) {
    notify(() => { p.questInv?.refresh(); }); notify(() => { p.onGradeUp?.(old); });
  }
  for (const bag of bags) notify(() => bag.commitChanges());
  if (committed.gradeUps.length && p.showPP) notify(() => p.send(Out.playerProperty(p.id)));
  notify(() => p.updateProperties());
  if (committed.sent.some((pkt) => pkt.code === 117)) notify(() => p.send(Out.mailResponse(p.id, 1)));
  if (notificationError) throw new PlayerMutationCommittedError(committed.value, notificationError);
  return committed.value;
}
