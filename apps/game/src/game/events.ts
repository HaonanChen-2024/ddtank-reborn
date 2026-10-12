/**
 * Daily / activity / event systems (spec 01 §8, 02 §10): template cache (`EventData`), idempotent claims
 * (app."EventClaims"), achievement records (Game.Server/Achievement/*Condition.cs) and the reward grant helper.
 *
 * Idempotency rule: every claim first INSERTs its (UserID, Kind, Key) row with ON CONFLICT DO NOTHING RETURNING; only
 * the request that inserted the row grants anything, so repeated / concurrent packets (or a client replaying the
 * request) never duplicate rewards. The original trusted the client for most of these (see notes per handler).
 */
import { and, eq, sql } from "drizzle-orm";
import { game, player, type Database } from "@ddt/db";
import { ItemInfo, templateBagType, type ItemTemplate } from "./item.js";
import type { GamePlayer } from "./player.js";
import type { RecordRow } from "../db/social.js";

export type DailyAwardRow = typeof game.Daily_Award.$inferSelect;
export type UserBoxRow = typeof game.LoadUserBox.$inferSelect;
export type AchievementRow = typeof game.Achievement.$inferSelect;
export type AchievementCondRow = typeof game.AchievementCondition.$inferSelect;
export type AchievementGoodsRow = typeof game.Achievement_Goods.$inferSelect;
export type EventRewardGoodsRow = typeof game.Event_Reward_Goods.$inferSelect;
export type LoginAwardRow = typeof game.Login_Award_Item_Template.$inferSelect;

/** Template caches of the event systems (AwardMgr, UserBoxMgr, AchievementMgr, EventRewardMgr). Reloaded by /reload-templates. */
export class EventData {
  dailyAward: DailyAwardRow[] = [];
  userBox: UserBoxRow[] = [];
  achievements = new Map<number, AchievementRow>();
  achConds = new Map<number, AchievementCondRow[]>();
  achGoods = new Map<number, AchievementGoodsRow[]>();
  eventGoods: EventRewardGoodsRow[] = [];
  loginAward: LoginAwardRow[] = [];

  async load(db: Database): Promise<this> {
    const [da, ub, ach, ac, ag, eg, la, online] = await Promise.all([
      db.select().from(game.Daily_Award),
      db.select().from(game.LoadUserBox),
      db.select().from(game.Achievement),
      db.select().from(game.AchievementCondition),
      db.select().from(game.Achievement_Goods),
      db.select().from(game.Event_Reward_Goods),
      db.select().from(game.Login_Award_Item_Template),
      db.select().from(game.User_Box).where(eq(game.User_Box.Type, 0)),
    ]);
    this.dailyAward = da;
    // Online boxes share the original User_Box source with LoadUserBox.xml; level/VIP keep their existing source.
    this.userBox = [...online, ...ub.filter((b) => b.Type !== 0)].sort((a, b) => a.ID - b.ID);
    this.achievements = new Map(ach.map((a) => [a.ID, a]));
    this.achConds = group(ac, (c) => c.AchievementID);
    this.achGoods = group(ag, (g) => g.AchievementID);
    this.eventGoods = eg;
    this.loginAward = la;
    return this;
  }

  /** Sign-in reward tiers (Type 1 items + Type 7 gift tokens by AwardDays > 0), i.e. what SignAwardFrame lists. */
  signTiers(): number[] {
    return [...new Set(this.dailyAward.filter((d) => d.AwardDays > 0 && (d.Type === 1 || d.Type === 7)).map((d) => d.AwardDays))].sort((a, b) => a - b);
  }

  /** UserBoxMgr.FindTemplateByCondition(type, level, condition) — same iteration order (ID) and comparisons. */
  findBox(type: number, level: number, condition: number): UserBoxRow | undefined {
    for (const b of this.userBox) {
      if (type === 0) { if (b.Type === 0 && level <= b.Level && condition < b.Condition) return b; }
      else if (b.Type === type && level < b.Level && condition === b.Condition) return b;
    }
    return undefined;
  }
}

function group<T>(rows: T[], key: (r: T) => number): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const k = key(r);
    const l = m.get(k);
    if (l) l.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Inserts the claim row; true only for the first caller (idempotent). */
export async function claimOnce(db: Database, userId: number, kind: string, key: string): Promise<boolean> {
  const res = (await db.execute(sql`INSERT INTO "app"."EventClaims" ("UserID","Kind","Key") VALUES (${userId}, ${kind}, ${key})
    ON CONFLICT DO NOTHING RETURNING "UserID"`)) as unknown;
  const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

export async function hasClaim(db: Database, userId: number, kind: string, key: string): Promise<boolean> {
  const res = (await db.execute(sql`SELECT 1 FROM "app"."EventClaims" WHERE "UserID" = ${userId} AND "Kind" = ${kind} AND "Key" = ${key}`)) as unknown;
  const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

/** Releases a claim (grant failed after the row was inserted). */
export async function unclaim(db: Database, userId: number, kind: string, key: string): Promise<void> {
  await db.execute(sql`DELETE FROM "app"."EventClaims" WHERE "UserID" = ${userId} AND "Kind" = ${kind} AND "Key" = ${key}`);
}

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
/** ISO-ish week id: Monday-based week start date. */
export function weekKey(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;
  return dayKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)));
}

// ------------------------------------------------------------------ achievement records (BaseUserRecord.CreateCondition)
/**
 * Record types derived from the character (ChangeAttack/Defence/Agility/Lucky, ChangeFightPower, ChangeGrade,
 * ChangeTotal, ChangeWin, ChangeOnlineTime, PlayerLogin): UpdateUserAchievement(type, value, 1) keeps the max.
 */
export function snapshotRecords(p: GamePlayer): Map<number, number> {
  const c = p.info;
  return new Map<number, number>([
    [1, c.Attack ?? 0], [2, c.Defence ?? 0], [3, c.Agility ?? 0], [4, c.Luck ?? 0],
    [9, c.FightPower ?? 0], [10, c.Grade ?? 0], [11, c.Total ?? 0], [12, c.Win ?? 0],
    [13, Math.floor((c.OnlineTime ?? 0) / 60)], [37, c.DayLoginCount ?? 0],
  ]);
}

/** Merges snapshot + counter updates into p.records; returns the rows that changed (sent as 229). */
export function updateRecords(p: GamePlayer, add: Map<number, number> = new Map()): RecordRow[] {
  const changed: RecordRow[] = [];
  const get = (id: number) => {
    let r = p.records.find((x) => x.RecordID === id);
    if (!r) {
      r = { UserID: p.id, RecordID: id, Total: 0 };
      p.records.push(r);
    }
    return r;
  };
  for (const [id, v] of snapshotRecords(p)) {
    const r = get(id);
    if (r.Total < v) { r.Total = v; changed.push(r); }
  }
  for (const [id, v] of add) {
    if (v <= 0) continue;
    const r = get(id);
    r.Total += v;
    changed.push(r);
  }
  if (changed.length) dirtyRecords.add(p);
  return changed;
}

const dirtyRecords = new WeakSet<GamePlayer>();

/** SP_Users_Record_Add equivalent: rewrite the player's record rows (table has no PK). */
export async function saveRecords(db: Database, p: GamePlayer): Promise<void> {
  if (!dirtyRecords.has(p)) return;
  dirtyRecords.delete(p);
  await db.transaction(async (tx) => {
    await tx.delete(player.Sys_Users_Record).where(eq(player.Sys_Users_Record.UserID, p.id));
    if (p.records.length) await tx.insert(player.Sys_Users_Record).values(p.records.map((r) => ({ UserID: p.id, RecordID: r.RecordID, Total: r.Total })));
  });
}

/** AchievementInventory.CanCompleted + CheckAchievementData (level / guild / spouse / prerequisites / end date). */
export function canCompleteAchievement(data: EventData, p: GamePlayer, id: number, now: Date): boolean {
  const a = data.achievements.get(id);
  if (!a || !a.IsActive) return false;
  if (a.EndDate && a.EndDate < now) return false;
  if (a.NeedMaxLevel && a.NeedMaxLevel < p.info.Grade) return false;
  if (a.NeedMinLevel && a.NeedMinLevel > p.info.Grade) return false;
  if (a.IsOther === 1 && p.info.ConsortiaID <= 0) return false;
  if (a.IsOther === 2 && (p.info.SpouseID ?? 0) <= 0) return false;
  const pre = String(a.PreAchievementID ?? "0,").split(",").map(Number).filter((x) => x > 0);
  for (const pid of pre) if (!p.achievements.some((d) => d.AchievementID === pid)) return false;
  const conds = data.achConds.get(id) ?? [];
  if (!conds.length) return false;
  return conds.every((c) => (p.records.find((r) => r.RecordID === c.CondictionType)?.Total ?? 0) >= c.Condiction_Para2);
}

export async function insertAchievementData(db: Database, userId: number, achievementId: number, now: Date): Promise<boolean> {
  const rows = await db.insert(player.AchievementData).values({ UserID: userId, AchievementID: achievementId, IsComplete: true, CompletedDate: now } as never)
    .onConflictDoNothing().returning({ id: player.AchievementData.AchievementID });
  return rows.length > 0;
}

export async function achievementDone(db: Database, userId: number, achievementId: number): Promise<boolean> {
  const rows = await db.select({ id: player.AchievementData.AchievementID }).from(player.AchievementData)
    .where(and(eq(player.AchievementData.UserID, userId), eq(player.AchievementData.AchievementID, achievementId))).limit(1);
  return rows.length > 0;
}

// ------------------------------------------------------------------ reward grant
export interface Reward {
  templateId: number;
  count: number;
  validDate?: number;
  isBind?: boolean;
  strengthenLevel?: number;
  attack?: number; defence?: number; agility?: number; luck?: number;
}

/**
 * Gives currencies (special ids like ItemBoxMgr: -100 gold, -200 money, -300 medal, -800 honor, -1100 giftToken,
 * 11107 exp) and items (stack-split by MaxCount); items that do not fit are returned for mailing.
 * Returns the mailed overflow and a short "name xN" summary.
 */
export function grantRewards(p: GamePlayer, rewards: Reward[], find: (id: number) => ItemTemplate | undefined, now: Date): { overflow: ItemInfo[]; summary: string[] } {
  const overflow: ItemInfo[] = [];
  const summary: string[] = [];
  p.beginChanges();
  try {
    for (const r of rewards) {
      if (r.count <= 0) continue;
      switch (r.templateId) {
        case -100: p.addGold(r.count); summary.push(`${r.count} ouro`); continue;
        case -200: p.addMoney(r.count); summary.push(`${r.count} xu`); continue;
        case -300: p.addMedal(r.count, find); summary.push(`${r.count} medalha`); continue;
        case -800: p.addHonor(r.count); continue;
        case -1100: p.addGiftToken(r.count); summary.push(`${r.count} Cupons`); continue;
        case 11107: p.addGP(r.count, false); summary.push(`${r.count} exp`); continue;
      }
      const t = find(r.templateId);
      if (!t) continue;
      summary.push(`${t.Name ?? r.templateId} x${r.count}`);
      const max = Math.max(1, t.MaxCount || 1);
      for (let left = r.count; left > 0; left -= max) {
        const n = Math.min(max, left);
        const it = ItemInfo.createFromTemplate(t, n, 113, now);
        it.ValidDate = r.validDate ?? 0;
        it.IsBinds = r.isBind ?? true;
        it.StrengthenLevel = r.strengthenLevel ?? 0;
        it.AttackCompose = r.attack ?? 0; it.DefendCompose = r.defence ?? 0; it.AgilityCompose = r.agility ?? 0; it.LuckCompose = r.luck ?? 0;
        if (!p.addTemplateToBag(it, templateBagType(t), n)) overflow.push(it);
      }
    }
  } finally {
    p.commitChanges();
  }
  return { overflow, summary };
}
