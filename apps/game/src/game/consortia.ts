/**
 * Guild (consortia) rules that lived inside the Project_Player34 stored procedures (permission bits, costs, level
 * thresholds) — pure functions so they can be unit-tested. The DB side is `src/db/consortia.ts`, the 129 handlers
 * `src/handlers/consortia.ts`. Each function cites the proc / C# file it mirrors.
 */

/** Consortia_Duty.Right bitmask (client ddt/data/ConsortiaDutyType.as). */
export const Right = {
  Ratify: 1, // accept/reject applications (SP_ConsortiaApplyUser_Pass/_Delete)
  Invite: 2, // SP_ConsortiaInviteUser_Add
  BanChat: 4, // SP_ConsortiaIsBanChat_Update
  Notice: 8, // SP_ConsortiaPlacard_Update
  Enounce: 16, // SP_ConsortiaDescription_Update, SP_ConsortiaRiches_Update, SP_ConsortiaBadge_Update
  Expel: 32, // SP_ConsortiaUser_Delete (kick)
  Diplomatism: 64, // SP_ConsortiaDuty_Update (allies in later versions)
  Manage: 128, // member remark (see userRemarkAllowed)
  ConsortiaUp: 256,
  ChangeMan: 512,
  Disband: 1024,
  UpGrade: 2048, // SP_ConsortiaUserGrade_Update (promote/demote)
  Exit: 4096,
} as const;

export function hasRight(right: number | null | undefined, bit: number): boolean {
  return right != null && (right & bit) !== 0;
}

/** SP_Consortia_Add: the five default duties (Level, translation key, Right). */
export const DEFAULT_DUTIES: readonly { level: number; key: string; name: string; right: number }[] = [
  { level: 1, key: "SP_Consortia_Add.Duty1", name: "会长", right: 4095 },
  { level: 2, key: "SP_Consortia_Add.Duty2", name: "副会长", right: 6191 },
  { level: 3, key: "SP_Consortia_Add.Duty3", name: "官员", right: 4103 },
  { level: 4, key: "SP_Consortia_Add.Duty4", name: "精英", right: 4096 },
  { level: 5, key: "SP_Consortia_Add.Duty5", name: "会员", right: 4096 },
];

/** ConsortiaCreate.cs: Money >= 500 and Grade >= 5, plus Consortia_Level[1].NeedGold. */
export const CREATE_MONEY = 500;
export const CREATE_GRADE = 5;
/** ConsortiaMail.cs: mass mail costs 1000 guild riches. */
export const MAIL_RICHES = 1000;
/** ResetTask.cs: 500 Money. */
export const TASK_RESET_MONEY = 500;

/**
 * Encoding.Default.GetByteCount (Windows code page of the original server): ASCII = 1 byte, anything else counted
 * as 2 (DBCS) — the strictest reading, so names accepted here always fit the original column limits.
 */
export function defaultByteCount(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) < 0x80 ? 1 : 2;
  return n;
}

export interface CreateInput {
  ConsortiaID: number;
  Gold: number;
  Grade: number;
  Money: number;
  MoneyLock: number;
}

/** ConsortiaCreate.cs:16-30. "inGuild" = silently ignored (return 0), "name" = ConsortiaCreateHandler.Long. */
export function checkCreate(p: CreateInput, name: string, needGold: number): "ok" | "inGuild" | "name" | "cost" {
  if (p.ConsortiaID !== 0) return "inGuild";
  if (!name || defaultByteCount(name) > 12) return "name";
  if (p.Gold >= needGold && p.Grade >= CREATE_GRADE && p.Money + p.MoneyLock >= CREATE_MONEY) return "ok";
  return "cost";
}

/** ConsortiaRichesOffer.cs: riches = money / 2 (integer); money must be >= 1 and <= Money. */
export function donationRiches(money: number, playerMoney: number): { ok: boolean; riches: number; err?: "NoMoney" | "RichIsNotFound" } {
  if (money < 1 || playerMoney < money) return { ok: false, riches: 0, err: "NoMoney" };
  const riches = Math.trunc(money / 2);
  if (riches <= 0) return { ok: false, riches: 0, err: "RichIsNotFound" };
  return { ok: true, riches };
}

export interface LevelRow {
  Level: number;
  Count: number;
  Riches: number;
  Reward: number;
  NeedGold: number;
  StoreRiches: number;
  SmithRiches: number;
  ShopRiches: number;
  BufferRiches: number;
  KickMax: number;
}

export interface GuildBuildings {
  Level: number;
  Riches: number;
  StoreLevel: number;
  ShopLevel: number;
  SmithLevel: number;
  SkillLevel: number;
}

/** CONSORTIA_LEVEL_UP byte: 1 guild, 2 store (bank), 3 shop, 4 smith, 5 skill (buffer). */
export type UpgradeKind = 1 | 2 | 3 | 4 | 5;

export interface UpgradeResult {
  /** Proc return value: 0 ok, 3 = cannot (max / guild level too low), 4 = guild: riches / building: no template, 5 = riches. */
  code: number;
  cost: number;
  /** New values to write (only when code 0). */
  set?: Partial<GuildBuildings> & { MaxCount?: number };
  newLevel?: number;
}

/**
 * SP_Consortia_UpGrade / _Store_UpGrade / _Shop_UpGrade / _Smith_UpGrade / _Skill_UpGrade (chairman check is done by
 * the caller: code 2). Building levels are capped by the guild level (shop: by Level/2).
 */
export function upgrade(kind: UpgradeKind, g: GuildBuildings, levels: ReadonlyMap<number, LevelRow>): UpgradeResult {
  if (kind === 1) {
    const next = levels.get(g.Level + 1);
    if (!next || !next.Count) return { code: 3, cost: 0 };
    if (g.Riches < next.Riches) return { code: 4, cost: next.Riches };
    return { code: 0, cost: next.Riches, set: { Level: g.Level + 1, MaxCount: next.Count, Riches: g.Riches + next.Reward - next.Riches }, newLevel: g.Level + 1 };
  }
  const field = ({ 2: "StoreLevel", 3: "ShopLevel", 4: "SmithLevel", 5: "SkillLevel" } as const)[kind];
  const costCol = ({ 2: "StoreRiches", 3: "ShopRiches", 4: "SmithRiches", 5: "BufferRiches" } as const)[kind];
  const cur = g[field];
  const cap = kind === 3 ? Math.trunc(g.Level / 2) : g.Level;
  if (cap <= cur) return { code: 3, cost: 0 };
  const cost = levels.get(cur + 1)?.[costCol] ?? 0;
  if (!cost) return { code: 4, cost: 0 };
  if (g.Riches < cost) return { code: 5, cost };
  return { code: 0, cost, set: { [field]: cur + 1, Riches: g.Riches - cost }, newLevel: cur + 1 };
}

/** ConsortiaBussiness.UpGrade*Consortia message keys per proc code (+ fix: building code 5 "riches" mapped to Msg4). */
export function upgradeMsg(kind: UpgradeKind, code: number): string | null {
  const name = ({ 1: "UpGradeConsortia", 2: "UpGradeStoreConsortia", 3: "UpGradeShopConsortia", 4: "UpGradeSmithConsortia", 5: "UpGradeSkillConsortia" } as const)[kind];
  if (kind === 1) return code >= 2 && code <= 4 ? `ConsortiaBussiness.${name}.Msg${code}` : null;
  // original mapped 2/3/4 only, so "not enough riches" (5) showed the generic failure and 4 (no template) said "riches"
  if (code === 2) return `ConsortiaBussiness.${name}.Msg2`;
  if (code === 3 || code === 4) return `ConsortiaBussiness.${name}.Msg3`;
  if (code === 5) return `ConsortiaBussiness.${name}.Msg4`;
  return null;
}

/** ConsortiaLevelUp.cs: thresholds that broadcast a SYS_NOTICE. Fix: the skill notice printed SmithLevel. */
export function upgradeNoticeKey(kind: UpgradeKind, level: number): string | null {
  if (kind === 1 && level >= 5) return "ConsortiaUpGradeHandler.Notice";
  if (kind === 3 && level >= 2) return "ConsortiaShopUpGradeHandler.Notice";
  if (kind === 4 && level >= 3) return "ConsortiaSmithUpGradeHandler.Notice";
  if (kind === 5 && level >= 3) return "ConsortiaBufferUpGradeHandler.Notice";
  return null;
}

/** SP_ConsortiaUser_Delete: daily kick budget (KickDate/KickCount, Consortia_Level.KickMax). */
export function kickBudget(kickDate: Date, kickCount: number, kickMax: number, today: Date): { ok: boolean; date: Date; count: number } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const sameDay = day(kickDate) === day(today);
  if (sameDay && kickCount <= 0) return { ok: false, date: kickDate, count: kickCount };
  const count = (sameDay ? kickCount : kickMax) - 1;
  return { ok: true, date: new Date(`${day(today)}T00:00:00Z`), count };
}

export interface MemberRef {
  /** Duty level (1 = chairman). */
  level: number;
  right: number;
}

/** SP_ConsortiaUser_Delete codes: 2 no right, 3 chairman cannot leave, 4 target is chairman. (5 = kick budget.) */
export function checkRemoveMember(actor: MemberRef | null, selfLeave: boolean, targetIsChairman: boolean): number {
  if (!actor) return 2;
  if (!selfLeave && !hasRight(actor.right, Right.Expel)) return 2;
  if (selfLeave && actor.level === 1) return 3;
  if (targetIsChairman) return 4;
  return 0;
}

/** SP_ConsortiaUserGrade_Update: returns the proc code and the target duty level. */
export function gradeChange(actorRight: number | null, targetLevel: number | null, maxLevel: number | null, promote: boolean): { code: number; level: number } {
  if (!hasRight(actorRight, Right.UpGrade)) return { code: 2, level: 0 };
  if (targetLevel == null || targetLevel === 1) return { code: 3, level: 0 };
  if (promote) {
    if (targetLevel === 2) return { code: 4, level: 0 };
    return { code: 0, level: targetLevel - 1 };
  }
  if (maxLevel == null || maxLevel <= targetLevel) return { code: 5, level: 0 };
  return { code: 0, level: targetLevel + 1 };
}

/** SP_ConsortiaDuty_Update types 3 (move up: level-1) / 4 (move down: level+1) validity. */
export function dutyMove(type: 3 | 4, current: number | null, max: number | null): number {
  if (type === 3) {
    if (current == null || current < 3) return 3;
    if (max == null || max === current) return 4;
    return 0;
  }
  if (current == null || current === 1) return 3;
  if (max == null || max < current + 2) return 4;
  return 0;
}

/**
 * SP_ConsortiaUserRemark_Update checked `(@tempRight & 0) = 0`, which is always true, so every remark update failed
 * (the client never calls it either). Ported with the Manage bit instead.
 */
export function userRemarkAllowed(right: number | null | undefined): boolean {
  return hasRight(right, Right.Manage);
}

/** Consortia_Equip_Control default when no row (ConsortiaBussiness.GetConsortiaEuqipRiches): 100 riches. */
export const DEFAULT_EQUIP_RICHES = 100;

/**
 * ShopMgr.CanBuy cases 11..15: guild shop tier n = ShopID-10 needs guild ShopLevel >= n and personal riches
 * (RichesOffer + RichesRob) >= Consortia_Equip_Control(Type 1, Level n).Riches. Items are always bound.
 */
export function canBuyGuildShop(shopId: number, consortiaId: number, shopLevel: number, playerRiches: number, threshold: number | undefined): boolean {
  if (shopId < 11 || shopId > 15 || consortiaId === 0) return false;
  const tier = shopId - 10;
  return shopLevel >= tier && playerRiches >= (threshold ?? DEFAULT_EQUIP_RICHES);
}

/** PlayerInfo.Riches => RichesRob + RichesOffer. */
export function personalRiches(p: { RichesOffer: number; RichesRob: number }): number {
  return (p.RichesOffer ?? 0) + (p.RichesRob ?? 0);
}

/** ItemStrengthenHandler.cs:88-103 / ItemComposeHandler.cs:105-129: +10 % per smith level when riches >= Type 2 threshold. */
export function smithBonusLevel(useGuild: boolean, inGuild: boolean, smithLevel: number, playerRiches: number, threshold: number | undefined): { level: number; denied: boolean } {
  if (!useGuild) return { level: 0, denied: false };
  if (!inGuild) return { level: 0, denied: true };
  if (playerRiches < (threshold ?? DEFAULT_EQUIP_RICHES)) return { level: 0, denied: true };
  return { level: smithLevel, denied: false };
}

/** Guild bank (bag 11) usable slots: StoreLevel × 10 (ConsortiaBag / UserChangeItemPlaceHandler). */
export function bankCapacity(storeLevel: number): number {
  return Math.max(0, storeLevel) * 10;
}

/** GameProperties.MissionRiches "a|b|c..." indexed by guild level (ConsortiaTaskMgr.GetMissionRichesWithLevel). */
export function missionRiches(cfg: string | undefined, guildLevel: number): number {
  const parts = (cfg ?? "").split("|");
  if (guildLevel < 1 || guildLevel > parts.length) return 0;
  return Number.parseInt(parts[guildLevel - 1]!, 10) || 0;
}

export interface FightRewardInput {
  gameType: number; // 0 Free, 1 Guild
  roomType: number; // 0 Match
  playerCount: number;
  totalHurt: number;
  offerRate: number;
  richesRate: number;
  winLevel: number;
  loseLevel: number;
}

/**
 * ConsortiaMgr.ConsortiaFight + SP_Consortia_Fight. Only Match rooms. Guild war: riches =
 * trunc((n/2 + totalHurt/2000) × RichesRate) when both guilds are level >= 3 (else 0), min 1; winners
 * +(n/2 + 10) × OfferRate offer, losers +round(n/2 × 0.5) × OfferRate − 10. Free match: riches 1, +3 / −3.
 * Fix: the original added the riches to the winning guild twice (inside SP_Consortia_Fight and again with
 * ConsortiaRichAdd); here once.
 */
export function fightRewards(i: FightRewardInput): { riches: number; winOffer: number; loseOfferAdd: number; loseOfferRemove: number } | null {
  if (i.roomType !== 0) return null;
  const guild = i.gameType === 1;
  const half = guild ? Math.trunc(i.playerCount / 2) : 0;
  const base = guild ? 10 : 3;
  let riches = 0;
  if (guild && half >= 1 && i.winLevel >= 3 && i.loseLevel >= 3) {
    // SQL: (@PlayerCount + @TotalKillHealth/2000) * @modulus / 2 * @RichesRate, int arithmetic until the numeric
    // rate, assigned back to int (truncation). ConsortiaMgr passes State = 2 -> @modulus = 2.
    riches = Math.trunc(Math.trunc(((half + Math.trunc(i.totalHurt / 2000)) * 2) / 2) * i.richesRate);
  }
  if (riches <= 0) riches = 1;
  const rate = Math.trunc(i.offerRate) || 1;
  return { riches, winOffer: (half + base) * rate, loseOfferAdd: Math.round(half * 0.5) * rate, loseOfferRemove: base };
}

/** BuyBadge.cs: badge must exist and guild riches >= cost; Right Enounce (SP_ConsortiaBadge_Update). */
export function checkBadge(riches: number, cost: number | undefined, right: number): "ok" | "notFound" | "riches" | "right" {
  if (cost == null) return "notFound";
  if (riches < cost) return "riches";
  if (!hasRight(right, Right.Enounce)) return "right";
  return "ok";
}

/**
 * SkillSocket.cs: payType 1 = riches (type-1 buffs from guild riches, others from the player's RichesOffer),
 * else medals. Fix: SP_Consortia_Riches_Remove returned success even when the guild could not pay, so type-1
 * guild buffs were granted for free; now the guild must have the riches.
 */
export function skillCost(buff: { type: number; level: number; riches: number; metal: number }, days: number, payType: number, guild: { Level: number; Riches: number }, player: { riches: number; medals: number }):
  { ok: true; source: "guild" | "player" | "medal"; amount: number; minutes: number } | { ok: false; msg: "Consortia.Msg5" | "Consortia.Msg6" } {
  const count = days < 0 ? 1 : days;
  const byRiches = payType === 1;
  const amount = count * (byRiches ? buff.riches : buff.metal);
  const enough = byRiches ? (buff.type === 1 ? guild.Riches >= amount : player.riches >= amount) : player.medals >= amount;
  // C# checked the player's riches for every riches buff, then charged the guild for type 1
  if (!(byRiches ? player.riches >= amount : player.medals >= amount) || !enough) return { ok: false, msg: "Consortia.Msg6" };
  if (buff.level > guild.Level) return { ok: false, msg: "Consortia.Msg5" };
  return { ok: true, source: byRiches ? (buff.type === 1 ? "guild" : "player") : "medal", amount, minutes: 1440 * count };
}

/** ConsortiaMgr.AddBuffConsortia: buff group -> BufferList pay-buffer type; personal groups vs whole guild. */
export function buffTypeForGroup(group: number): { type: number; guildWide: boolean } | null {
  const personal: Record<number, number> = { 1: 101, 3: 103, 6: 106, 11: 111, 12: 112 };
  const guild: Record<number, number> = { 2: 102, 4: 104, 5: 105, 7: 107, 9: 109, 10: 110 };
  if (personal[group]) return { type: personal[group]!, guildWide: false };
  if (guild[group]) return { type: guild[group]!, guildWide: true };
  return null; // group 8: "Consortia.Msg2" (not supported)
}
