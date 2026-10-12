/** Online part of UserGetBoxHandler.cs:38-48,76-108,130-134. The existing
 * server-only elapsed-time rule stays intact; claim, progress and rewards now
 * commit together. Level/VIP boxes keep their existing handlers. */
import { eq } from "drizzle-orm";
import { player, type Database } from "@ddt/db";
import type { GSPacket } from "@ddt/protocol";
import type { ServerContext } from "../session/context.js";
import { savePlayerInfo } from "../db/characters.js";
import { saveItem } from "../db/items.js";
import { createItemBox } from "../handlers/use.js";
import { mailItems } from "../handlers/items.js";
import { claimOnce, dayKey, grantRewards, type EventData, type Reward } from "./events.js";
import { GamePlayer } from "./player.js";
import { ItemInfo } from "./item.js";
import * as Out from "../packets/out.js";

const begins = new WeakMap<GamePlayer, number>();
export function startOnlineBoxTimer(p: GamePlayer, now: Date): void { begins.set(p, now.getTime()); }
class OnlineBoxChanged extends Error {}
const snapshot = (item: ItemInfo) => JSON.stringify(item.toRow());
// Quit may mark State=0 while it waits on the same persistence lock.
const profile = (p: GamePlayer) => JSON.stringify({ info: { ...p.info, State: 0 }, match: p.match });
const inventory = (p: GamePlayer) => p.allBags().map((bag) => ({ bag, capacity: bag.capacity,
  items: bag.getItems(), removed: [...bag.removed], dirty: bag.dirtyItems() }));

/** Only detached objects may be mutated while SQL can still fail. Reuse the
 * original grantRewards/PlayerInventory stacking and overflow rules. */
function stage(ctx: ServerContext, p: GamePlayer) {
  const sent: GSPacket[] = [], gradeUps: number[] = [];
  const staged = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "online-box-stage" },
    structuredClone(p.info), structuredClone(p.match), p.zoneId, p.zoneName, (g) => ctx.templates.levels.get(g) ?? 0);
  staged.statTables = p.statTables; staged.cards = p.cards; staged.pet = p.pet;
  staged.cardBag = p.cardBag; staged.petBag = p.petBag; // Stats only read these; no reward mutates them.
  staged.gradeForGp = p.gradeForGp; staged.lang = p.lang;
  staged.onGradeUp = (old) => gradeUps.push(old);
  const bags = inventory(p), original = new Map<ItemInfo, { copy: ItemInfo; before: string; dirty: boolean }>();
  const copy = (item: ItemInfo) => {
    let entry = original.get(item);
    if (!entry) {
      const clone = ItemInfo.fromRow({ ...item.toRow(), ItemID: item.ItemID }, item.template);
      clone.cellLocked = item.cellLocked;
      entry = { copy: clone, before: snapshot(item), dirty: item.isDirty }; original.set(item, entry);
    }
    return entry.copy;
  };
  for (const { bag, items, removed } of bags) {
    const target = staged.getInventory(bag.bagType)!;
    target.capacity = bag.capacity;
    for (const item of items) if (!target.addItemTo(copy(item), item.Place)) throw new OnlineBoxChanged();
    target.removed.push(...removed.map(copy));
  }
  for (const [item, entry] of original) { Object.assign(entry.copy, item.toRow()); entry.copy.isDirty = entry.dirty; }
  // Loading equipped copies can recalculate the staging profile. Start the
  // actual reward from the exact live profile, not those loading side effects.
  staged.info = structuredClone(p.info); staged.match = structuredClone(p.match);
  staged.baseAttack = p.baseAttack; staged.baseDefence = p.baseDefence;
  sent.length = 0;
  return { staged, sent, gradeUps, original, bags, profileBefore: profile(p) };
}

export async function claimOnlineBox(ctx: ServerContext, p: GamePlayer, data: EventData): Promise<{ ok: boolean; summary: string }> {
  try {
    return await p.withPersistenceLock(async () => {
      // Existing battle callbacks are synchronous; use the same room-entry /
      // persistence exclusion as material exchange, without consuming the timer.
      if (!p.isActive || p.quitting || p.currentRoom) return { ok: false, summary: "" };
      const now = ctx.now(), box = data.findBox(0, p.info.Grade, p.info.BoxProgression ?? 0);
      const minutes = Math.floor((now.getTime() - (begins.get(p) ?? now.getTime())) / 60_000);
      if (!box || minutes < box.Condition) return { ok: false, summary: "" };
      const committed = await ctx.db.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        const [owner] = await tx.select({ id: player.Sys_Users_Detail.UserID }).from(player.Sys_Users_Detail)
          .where(eq(player.Sys_Users_Detail.UserID, p.id)).for("update");
        if (!owner || !(await claimOnce(db, p.id, "timebox", `${dayKey(now)}:${box.Condition}`))) return null;
        const plan = stage(ctx, p), { staged, original } = plan;
        // Same mapping as openBoxRewards. Do not alter its independent VIP/level path.
        const r = createItemBox(ctx.templates.itemBoxes.get(box.TemplateID));
        const rewards: Reward[] = r ? [
          { templateId: -100, count: r.gold }, { templateId: -200, count: r.money }, { templateId: -1100, count: r.giftToken },
          { templateId: -300, count: r.medal }, { templateId: 11107, count: r.exp }, { templateId: -800, count: r.honor },
          ...r.items.map((x) => ({ templateId: x.row.TemplateId, count: x.count, validDate: x.row.ItemValid, isBind: x.row.IsBind, strengthenLevel: x.row.StrengthenLevel })),
        ] : [{ templateId: box.TemplateID, count: 1 }];
        const grant = grantRewards(staged, rewards, ctx.templates.findItem, now);
        const rewarded = new Set(staged.allBags().flatMap((b) => b.getItems()).filter((item) => {
          const old = [...original.values()].find((entry) => entry.copy === item);
          return !old || snapshot(item) !== old.before;
        }));
        staged.info.BoxProgression = box.Condition; staged.info.BoxGetDate = now; staged.info.AlreadyGetBox = 0;
        const pending = [...new Set(staged.allBags().filter((b) => b.saveToDb).flatMap((b) => b.dirtyItems()))];
        const ids = new Set<number>();
        for (const item of pending) {
          if (item.ItemID > 0) {
            if (ids.has(item.ItemID)) throw new OnlineBoxChanged();
            ids.add(item.ItemID);
            const [stored] = await tx.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, item.ItemID)).for("update");
            const old = [...original.values()].find((entry) => entry.copy === item);
            if (!stored || stored.UserID !== p.id || stored.TemplateID !== item.TemplateID || !old ||
                (!old.dirty && !plan.bags.some((b) => b.dirty.some((it) => original.get(it) === old)) && snapshot(ItemInfo.fromRow(stored, item.template)) !== old.before)) throw new OnlineBoxChanged();
          }
          await saveItem(db, item);
        }
        await savePlayerInfo(db, staged.info, staged.match);
        if (grant.overflow.length) await mailItems({ ...ctx, db: { ...ctx.db, db } }, staged, grant.overflow,
          ctx.lang.t("UserGetTimeBoxHandler.title"), 12, ctx.lang.t("UserGetTimeBoxHandler.mail"));
        const current = inventory(p);
        if (profile(p) !== plan.profileBefore || [...original].some(([item, old]) => snapshot(item) !== old.before || item.isDirty !== old.dirty) ||
            current.some((b, i) => b.capacity !== plan.bags[i]!.capacity || ["items", "removed", "dirty"].some((key) => {
              const field = key as "items" | "removed" | "dirty", old = plan.bags[i]![field];
              return b[field].length !== old.length || b[field].some((item, n) => item !== old[n]);
            }))) throw new OnlineBoxChanged();
        return { ...plan, pending, rewarded, summary: grant.summary.join(", ") };
      });
      if (!committed) return { ok: false, summary: "" };
      const { staged, original, pending } = committed;
      // Preserve existing item identities (clients/other models may retain them).
      const real = new Map([...original].map(([item, old]) => [old.copy, item]));
      for (const item of pending) {
        const existing = real.get(item);
        if (existing) { Object.assign(existing, item.toRow()); existing.isDirty = false; }
      }
      const bags = p.allBags(); bags.forEach((bag) => bag.beginChanges());
      for (const bag of staged.allBags()) {
        const target = p.getInventory(bag.bagType)!;
        for (const item of bag.getItems()) {
          if (!real.has(item)) { target.addItemTo(item, item.Place); item.isDirty = !bag.saveToDb; }
          else if (committed.rewarded.has(item)) target.updateItem(real.get(item)!);
        }
        for (let i = target.removed.length - 1; i >= 0; i--) if (pending.some((item) => real.get(item) === target.removed[i])) target.removed.splice(i, 1);
      }
      for (const item of pending) { const existing = real.get(item); if (existing) existing.isDirty = false; }
      const state = p.info.State;
      Object.assign(p.info, staged.info); p.info.State = state;
      p.baseAttack = staged.baseAttack; p.baseDefence = staged.baseDefence;
      startOnlineBoxTimer(p, now);
      // Finish ALL memory updates before the first transport callback. A broken
      // socket after COMMIT must not leave a later save with pre-reward progress.
      let notificationError: unknown;
      for (const bag of bags) { try { bag.commitChanges(); } catch (error) { notificationError ??= error; } }
      if (notificationError) throw notificationError;
      // Staging packets refer to copies/temporary IDs. Send only fresh live state.
      if (committed.gradeUps.length && p.showPP) p.send(Out.playerProperty(p.id));
      p.updateProperties();
      if (committed.sent.some((pkt) => pkt.code === 117)) p.send(committed.sent.find((pkt) => pkt.code === 117)!);
      for (const old of committed.gradeUps) { p.questInv?.refresh(); p.onGradeUp?.(old); }
      return { ok: true, summary: committed.summary };
    });
  } catch (error) {
    if (!(error instanceof OnlineBoxChanged)) throw error;
    return { ok: false, summary: "" };
  }
}
