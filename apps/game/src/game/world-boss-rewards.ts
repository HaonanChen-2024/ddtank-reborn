/** Ranked world-boss awards preserve this port's immediate online delivery.
 * Offline currencies stay direct; offline item rewards and online overflow use mail.
 * Only detached state is touched until the claim and full pending save commit. */
import { eq, sql } from "drizzle-orm";
import { player, type Database } from "@ddt/db";
import type { ServerContext } from "../session/context.js";
import { loadPlayerInfo } from "../db/characters.js";
import { mailItems } from "../handlers/items.js";
import { claimOnce, grantRewards, type Reward } from "./events.js";
import { GamePlayer } from "./player.js";
import { defaultMatch } from "./player-info.js";
import { withWorldBossAdmission } from "./world-boss.js";
import { commitPlayerMutation } from "./player-transaction.js";

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

/** Caller owns the persistence lock (and any active fight lease). Only the
 * supplied eligibility/claim and detached reward state run in this transaction.
 * World-boss rules stay in its caller; packet 90 supplies its own monthly claim. */
export async function grantClaimRewards(ctx: ServerContext, p: GamePlayer, rewards: Reward[], title: string,
  claim: (db: Database, now: Date) => Promise<boolean>): Promise<string | null> {
  return commitPlayerMutation(ctx, p, async (db, staged, now) => {
    if (!(await claim(db, now))) return null;
    const grant = grantRewards(staged, rewards, ctx.templates.findItem, now);
    return { value: grant.summary.join(", "), overflow: grant.overflow, mailTitle: title };
  });
}

async function online(ctx: ServerContext, p: GamePlayer, key: string, rewards: Reward[]): Promise<string | null> {
  return grantClaimRewards(ctx, p, rewards, "Boss mundial", (db) => claimOnce(db, p.id, "worldboss", key));
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
