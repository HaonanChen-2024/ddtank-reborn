/** Ranked world-boss awards preserve this port's immediate online delivery.
 * Offline currencies stay direct; offline item rewards and online overflow use mail.
 * Only detached state is touched until the claim and full pending save commit. */
import { eq, sql } from "drizzle-orm";
import { player, type Database } from "@ddt/db";
import type { GSPacket } from "@ddt/protocol";
import type { ServerContext } from "../session/context.js";
import { loadPlayerInfo, savePlayerInfo } from "../db/characters.js";
import { saveItem } from "../db/items.js";
import { mailItems } from "../handlers/items.js";
import { claimOnce, grantRewards, type Reward } from "./events.js";
import { GamePlayer } from "./player.js";
import { ItemInfo } from "./item.js";
import { defaultMatch } from "./player-info.js";
import { withWorldBossAdmission } from "./world-boss.js";
import * as Out from "../packets/out.js";

class WorldBossChanged extends Error {}
const snapshot = (item: ItemInfo) => JSON.stringify(item.toRow());
// Quit may mark State=0 while it waits on the same persistence lock.
const profile = (p: GamePlayer) => JSON.stringify({ info: { ...p.info, State: 0 }, match: p.match });
const inventory = (p: GamePlayer) => p.allBags().map((bag) => ({ bag, capacity: bag.capacity,
  items: bag.getItems(), removed: [...bag.removed], dirty: bag.dirtyItems() }));

/** Only detached objects may be mutated while SQL can still fail. Reuse the
 * original grantRewards/PlayerInventory stacking and overflow rules. */
function stage(ctx: ServerContext, p: GamePlayer) {
  const sent: GSPacket[] = [], gradeUps: number[] = [];
  const staged = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "world-boss-stage" },
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
    for (const item of items) if (!target.addItemTo(copy(item), item.Place)) throw new WorldBossChanged();
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

/** The scheduled rank-award contract is gold, gift tokens and concrete items.
 * Do not consume a claim for an unknown currency or a missing item template. */
function validate(ctx: ServerContext, key: string, rewards: Reward[]): void {
  if (!key || key.length > 64) throw new Error("Invalid world boss occurrence key");
  for (const r of rewards) {
    if (!Number.isSafeInteger(r.count) || r.count < 0 || !Number.isSafeInteger(r.templateId)) throw new Error("Invalid world boss reward");
    if (r.templateId === -100 || r.templateId === -1100) continue;
    if (r.templateId <= 0 || r.templateId === 11107 || !ctx.templates.findItem(r.templateId)) throw new Error("Unsupported world boss reward template");
  }
}

async function online(ctx: ServerContext, p: GamePlayer, key: string, rewards: Reward[]): Promise<string | null> {
  const now = ctx.now();
  const committed = await ctx.db.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const [owner] = await tx.select({ id: player.Sys_Users_Detail.UserID }).from(player.Sys_Users_Detail)
      .where(eq(player.Sys_Users_Detail.UserID, p.id)).for("update");
    if (!owner) throw new Error("World boss recipient missing");
    if (!(await claimOnce(db, p.id, "worldboss", key))) return null;
    const plan = stage(ctx, p), { staged, original } = plan;
    const grant = grantRewards(staged, rewards, ctx.templates.findItem, now);
    const rewarded = new Set(staged.allBags().flatMap((b) => b.getItems()).filter((item) => {
      const old = [...original.values()].find((entry) => entry.copy === item);
      return !old || snapshot(item) !== old.before;
    }));
    const pending = [...new Set(staged.allBags().filter((b) => b.saveToDb).flatMap((b) => b.dirtyItems()))];
    const ids = new Set<number>();
    for (const item of pending) {
      if (item.ItemID > 0) {
        if (ids.has(item.ItemID)) throw new WorldBossChanged();
        ids.add(item.ItemID);
        const [stored] = await tx.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, item.ItemID)).for("update");
        const old = [...original.values()].find((entry) => entry.copy === item);
        if (!stored || stored.UserID !== p.id || stored.TemplateID !== item.TemplateID || !old ||
            (!old.dirty && !plan.bags.some((b) => b.dirty.some((it) => original.get(it) === old)) && snapshot(ItemInfo.fromRow(stored, item.template)) !== old.before)) throw new WorldBossChanged();
      }
      await saveItem(db, item);
    }
    await savePlayerInfo(db, staged.info, staged.match);
    if (grant.overflow.length) await mailItems({ ...ctx, db: { ...ctx.db, db } }, staged, grant.overflow, "Boss mundial", 12);
    const current = inventory(p);
    if (profile(p) !== plan.profileBefore || [...original].some(([item, old]) => snapshot(item) !== old.before || item.isDirty !== old.dirty) ||
        current.some((b, i) => b.capacity !== plan.bags[i]!.capacity || ["items", "removed", "dirty"].some((key) => {
          const field = key as "items" | "removed" | "dirty", old = plan.bags[i]![field];
          return b[field].length !== old.length || b[field].some((item, n) => item !== old[n]);
        }))) throw new WorldBossChanged("World boss recipient changed before commit");
    return { ...plan, pending, rewarded, summary: grant.summary.join(", ") };
  });
  if (!committed) return null;
  const { staged, original, pending } = committed;
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
  // Complete memory publication before any transport callback can fail.
  let notificationError: unknown;
  for (const bag of bags) { try { bag.commitChanges(); } catch (error) { notificationError ??= error; } }
  if (notificationError) throw notificationError;
  p.updateProperties();
  if (committed.sent.some((pkt) => pkt.code === 117)) p.send(Out.mailResponse(p.id, 1));
  return committed.summary;
}

async function offline(ctx: ServerContext, id: number, key: string, rewards: Reward[]): Promise<void> {
  await ctx.db.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const [owner] = await tx.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, id)).for("update");
    if (!owner) throw new Error("World boss recipient missing");
    if (!(await claimOnce(db, id, "worldboss", key))) return;
    const gold = rewards.filter((r) => r.templateId === -100).reduce((sum, r) => sum + r.count, 0);
    const giftToken = rewards.filter((r) => r.templateId === -1100).reduce((sum, r) => sum + r.count, 0);
    await tx.update(player.Sys_Users_Detail).set({ Gold: sql`${player.Sys_Users_Detail.Gold} + ${gold}`,
      GiftToken: sql`${player.Sys_Users_Detail.GiftToken} + ${giftToken}` }).where(eq(player.Sys_Users_Detail.UserID, id));
    // Detached zero-capacity bags route all concrete rewards through the exact
    // MaxCount/attributes mapping used online. No live inventory is constructed.
    const info = (await loadPlayerInfo(db, id))!;
    const detached = new GamePlayer({ send: () => {}, disconnect: () => {}, remoteAddress: "world-boss-offline" }, info, defaultMatch(id), 1, "");
    for (const bag of detached.allBags()) bag.capacity = 0;
    const grant = grantRewards(detached, rewards.filter((r) => r.templateId > 0), ctx.templates.findItem, ctx.now());
    if (grant.overflow.length) await mailItems({ ...ctx, db: { ...ctx.db, db } }, detached, grant.overflow, "Boss mundial", 12);
  });
}

/** Caller already froze the occurrence and rank. Never truncate the claim key. */
export async function awardWorldBoss(ctx: ServerContext, id: number, key: string, rewards: Reward[], description: string): Promise<void> {
  validate(ctx, key, rewards);
  for (;;) {
    const p = ctx.world.get(id);
    if (p?.quitting) { await p.quitting; continue; }
    if (!p) {
      const delivered = await withWorldBossAdmission(ctx.world, id, async () => {
        if (ctx.world.get(id)) return false;
        await offline(ctx, id, key, rewards); return true;
      });
      if (delivered) return;
      continue;
    }
    const work = () => p.withWorldBossAward(() => {
      const afterLease = (release?: () => void) => {
        // Queue synchronously when there is no fight. A later quit must save
        // this already-admitted reward, even though it marks State=0 at once.
        const admitted = ctx.world.get(id) === p && !p.quitting && p.isActive;
        return p.withPersistenceLock(async () => {
          try {
            if (!admitted || ctx.world.get(id) !== p) return false;
            const summary = await online(ctx, p, key, rewards);
            if (summary !== null) p.sendMessage(0, `${description} Prêmio: ${summary}.`);
            return true;
          } finally { release?.(); }
        }).finally(() => release?.());
      };
      const game = p.currentRoom?.game;
      return game?.holdWorldBossSettlement ? game.holdWorldBossSettlement().then(afterLease) : afterLease();
    });
    if (await (p.sink.enqueueWorldBossAward?.(work) ?? work())) return;
  }
}
