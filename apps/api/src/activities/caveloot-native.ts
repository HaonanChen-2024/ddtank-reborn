import { createHash } from "node:crypto";
import { PRIZES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityState, type ActivityWallet } from "./types.js";
/** Shared legacy cave owner and original-window local adaptation. */
export type CaveType = 1 | 2;
export type Token = string; // YYYY-MM-DD + '.' + full 43-char SHA256 base64url = 54 chars.
export interface Material { templateId: 11019 | 11001 | 11021 | 11002; count: number; validDays?: 0 }
export interface BagDraw extends Material { caveType?: CaveType; [unknownField: string]: unknown }
export interface CaveExtensionV1 {
  version: 1;
  normalDraws: number; advancedDraws: number; // Only post-extension real draws; no history guessing.
  normalCoins: number; advancedCoins: number;
  claimedExtraProgress: number[]; // IDs 4..11; IDs 1..3 use canonical legacy claimed[] only.
  shopDay: string; shopBought: [number[], number[]]; // UTC, four entries per type.
  [unknownField: string]: unknown;
}
/** Existing games.cave owner; preserve original fields and all unknown fields. */
export interface CaveState {
  bag: BagDraw[]; draws: number; score: number; fragments: number; pity: number;
  choices: string[]; claimed: number[]; native?: CaveExtensionV1;
  [unknownField: string]: unknown;
}
/** Strict existing HTTP fields. Every action includes an exact full token. */
export type CaveAction =
  | { type: 'draw'; tier: CaveType; index: 0 | 1 | 2; count: number; choice: Token }
  | { type: 'take-item' | 'recycle-item'; tier: CaveType; index: 0 | 1 | 2 | 3; count: number; choice: Token }
  | { type: 'take-all' | 'recycle-all'; tier: CaveType; choice: Token }
  | { type: 'take-legacy' | 'recycle-legacy'; choice: Token }
  | { type: 'progress'; tier: number; choice: Token }
  | { type: 'exchange'; choice: Token }
  | { type: 'buy'; tier: CaveType; index: 0 | 1 | 2 | 3; count: number; choice: Token };
export interface Reward { templateId: Material['templateId']; name: string; itemCount: number; bound: true; validDays: 0 }
export interface BagRow {
  index: 0 | 1 | 2 | 3; templateId: Material['templateId']; name: string; itemCount: number;
  recycleUnitCoins: 2; maxTakeCount: number; maxRecycleCount: number; canTake: boolean; canRecycle: boolean; reason: string;
}
export interface DrawQuote {
  tier: CaveType; index: 0 | 1 | 2; bundleSize: 1 | 3 | 5; maxCount: number;
  quotes: { count: number; draws: number; freeDraws: number; cost: number; canDraw: boolean; reason: string }[];
}
export interface CaveView {
  version: 1; kind: 'caveloot-native'; available: true; day: string; started: boolean; stateToken: Token;
  catalogVersion: 'caveloot-local-v1'; points: number; actionsRemaining: number;
  freeRemaining: number; bagCapacity: 30; bagSlotsUsed: number; draws: number; progressScore: number; fragments: number; pityRemaining: number;
  types: { tier: CaveType; label: string; newDraws: number; coins: number; rows: BagRow[]; canTakeAll: boolean; canRecycleAll: boolean; reason: string }[];
  legacyBag: { label: '历史混合包'; records: number; itemCount: number; rewards: Reward[]; canTake: boolean; canRecycle: boolean; recyclePoints: number; reason: string };
  pool: { tier: CaveType; index: number; templateId: Material['templateId']; name: string; itemCount: number; weight: number }[];
  drawChoices: DrawQuote[];
  floorPreview: { tier: CaveType; target: 10; current: number; shared: true; reward: Reward; rule: string }[];
  progress: { id: number; page: 1 | 2; target: number; current: number; progressPercentRequired: number; claimed: boolean; canClaim: boolean; rewards: Reward[]; reason: string }[];
  personalProgressPercent: number; // Individual post-extension progress, never server-wide.
  shop: { tier: CaveType; index: number; unitCoins: number; bought: number; dailyLimit: 5; remaining: number; maxCount: number; canBuy: boolean; reward: Reward; reason: string }[];
  exchange: { fragmentCost: 10; reward: Reward; canExchange: boolean; reason: string };
  rank: { available: false; rows: []; myRank: null; myScore: number; reason: string };
  records: string[]; localRules: { version: 1; description: string };
  unavailable: { id: 'original-payments' | 'original-pool' | 'global-progress' | 'global-rank'; reason: string }[];
}
export interface CaveUnavailable {
  version: 1; kind: 'caveloot-native'; available: false; day: string; started: boolean;
  stateToken: null; reason: string; localRules: { version: 1; description: string };
}
export type CaveProjection = CaveView | CaveUnavailable;
export type CaveEffect =
  | { type: 'drawn'; tier: CaveType; animationBand: 0 | 1 | 2; draws: number; freeDraws: number; cost: number; guaranteedDraws: number; results: Reward[] }
  | { type: 'taken'; source: CaveType | 'legacy'; itemCount: number; rewards: Reward[] }
  | { type: 'recycled'; source: CaveType | 'legacy'; itemCount: number; coinsAwarded: number; pointsAwarded: number; consumed: Reward[] }
  | { type: 'progress-claimed'; id: number; rewards: Reward[] }
  | { type: 'exchanged'; fragmentsSpent: 10; rewards: Reward[] }
  | { type: 'bought'; tier: CaveType; index: number; count: number; coinsSpent: number; rewards: Reward[] };
export interface CaveActionEnvelope { requestId: string; effects: CaveEffect[] }
export const proposedNames = { http: 'caveloot-native', projection: 'nativeCaveLoot', effect: 'nativeCaveLootAction', privateOwner: 'games.cave' } as const;
export const localRules = {
  catalogVersion: 'caveloot-local-v1', normalCost: 15, advancedCost: 35, dailyNormalFree: 3,
  bundleSizes: [1, 3, 5], maxDrawsPerRequest: 5, sharedPity: 10, sharedBagRecords: 30,
  maxCountedBatchesPerDay: 500, recycleUnitCoins: 2, legacyRecycleUnitPoints: 2, shopDailyLimitPerEntry: 5,
  prizes: [
    { templateId: 11019, weight: 55, count: 1 }, { templateId: 11001, weight: 25, count: 1 },
    { templateId: 11021, weight: 15, count: 1 }, { templateId: 11002, weight: 5, count: 1 },
  ], guaranteed: { templateId: 11021, count: 2 }, // Advanced doubles ordinary and guaranteed quantity.
  shop: [
    { index: 0, templateId: 11019, count: 1, unitCoins: 10 }, { index: 1, templateId: 11001, count: 1, unitCoins: 12 },
    { index: 2, templateId: 11021, count: 1, unitCoins: 15 }, { index: 3, templateId: 11002, count: 1, unitCoins: 20 },
  ], // Both types use identical catalog, isolated currencies and no conversion.
  progress: [
    { id: 1, page: 1, targetScore: 10, templateId: 11019, count: 2, canonicalLegacyTier: 1 },
    { id: 2, page: 1, targetScore: 20, templateId: 11019, count: 4, canonicalLegacyTier: 2 },
    { id: 3, page: 1, targetScore: 30, templateId: 11019, count: 6, canonicalLegacyTier: 3 },
    { id: 4, page: 1, targetScore: 50, templateId: 11019, count: 8 },
    { id: 5, page: 1, targetScore: 100, templateId: 11019, count: 10 },
    { id: 6, page: 1, targetScore: 200, templateId: 11019, count: 12 },
    { id: 7, page: 2, targetNewDraws: 10, progressPercent: 5, templateId: 11001, count: 2 },
    { id: 8, page: 2, targetNewDraws: 25, progressPercent: 12, templateId: 11001, count: 4 },
    { id: 9, page: 2, targetNewDraws: 50, progressPercent: 25, templateId: 11021, count: 2 },
    { id: 10, page: 2, targetNewDraws: 100, progressPercent: 50, templateId: 11021, count: 4 },
    { id: 11, page: 2, targetNewDraws: 200, progressPercent: 100, templateId: 11002, count: 2 },
  ],
} as const;

const INT_MAX = 2147483647;
const STAT_MAX = 1_000_000_000;
const DESCRIPTION = "本地矿洞：普通每日前3抽免费，其后15积分；高级35积分且数量翻倍。普通、高级共用十抽保底和30条临时包。分档回收每件得2枚同档矿币，历史包及旧入口回收每件得2活动积分；同一物品只能结算一次。矿币商店每项UTC每日限5份；启用后个人里程碑不补算历史。新统计最多显示10亿。";
const int = (n: unknown, min = 0, max = INT_MAX): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const utc = (ctx: ActivityContext) => ctx.now.toISOString().slice(0, 10);
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
function need(ok: unknown, message: string, code = 400): asserts ok { if (!ok) throw new ActivityError(message, code); }
function canonical(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (obj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
const material = (templateId: number) => PRIZES.find(p => p.templateId === templateId);
const prize = (templateId: number, count: number): Reward => ({ templateId: templateId as Material["templateId"], name: material(templateId)!.name, itemCount: count, bound: true, validDays: 0 });
const raw = (r: Reward): ActivityReward => ({ templateId: r.templateId, count: r.itemCount, validDays: 0 });
function merge(rows: readonly { templateId: number; count: number }[]): Reward[] {
  return PRIZES.flatMap(p => { const count = rows.filter(r => r.templateId === p.templateId).reduce((n, r) => n + r.count, 0); return count ? [prize(p.templateId, count)] : []; });
}
export function createCaveState(): CaveState { return { bag: [], draws: 0, score: 0, fragments: 0, pity: 0, choices: PRIZES.map(p => p.name), claimed: [] }; }
function extension(day: string): CaveExtensionV1 { return { version: 1, normalDraws: 0, advancedDraws: 0, normalCoins: 0, advancedCoins: 0, claimedExtraProgress: [], shopDay: day, shopBought: [[0, 0, 0, 0], [0, 0, 0, 0]] }; }
function validExtension(v: unknown): v is CaveExtensionV1 {
  return obj(v) && v.version === 1 && [v.normalDraws, v.advancedDraws].every(n => int(n, 0, STAT_MAX)) && [v.normalCoins, v.advancedCoins].every(n => int(n))
    && Array.isArray(v.claimedExtraProgress) && v.claimedExtraProgress.every(n => int(n, 4, 11)) && new Set(v.claimedExtraProgress).size === v.claimedExtraProgress.length
    && date(v.shopDay) && Array.isArray(v.shopBought) && v.shopBought.length === 2 && v.shopBought.every(row => Array.isArray(row) && row.length === 4 && row.every(n => int(n, 0, 5)));
}
function read(root: ActivityState, ctx: ActivityContext): CaveState | null {
  const b: unknown = root.games.cave === undefined ? createCaveState() : root.games.cave;
  if (!obj(b) || !Array.isArray(b.bag) || b.bag.length > 30 || !b.bag.every(r => obj(r) && int(r.templateId) && material(r.templateId) && int(r.count, 1) && (r.validDays === undefined || r.validDays === 0) && (r.caveType === undefined || r.caveType === 1 || r.caveType === 2))
    || ![b.draws, b.score, b.fragments].every(n => int(n)) || !int(b.pity, 0, 9) || !Array.isArray(b.choices) || !b.choices.every(s => typeof s === "string")
    || !Array.isArray(b.claimed) || !b.claimed.every(n => int(n, 1, 3)) || new Set(b.claimed).size !== b.claimed.length || (b.native !== undefined && !validExtension(b.native))) return null;
  // A projection never repairs or initializes a persisted save.
  const next = structuredClone(b) as unknown as CaveState;
  if (next.native && next.native.shopDay !== utc(ctx)) { next.native.shopDay = utc(ctx); next.native.shopBought = [[0, 0, 0, 0], [0, 0, 0, 0]]; }
  return next;
}
function daily(root: ActivityState, ctx: ActivityContext) { return root.day === utc(ctx) ? root.daily : {}; }
function token(root: ActivityState, b: CaveState, ctx: ActivityContext, wallet: ActivityWallet) {
  return `${utc(ctx)}.${createHash("sha256").update(canonical({ cave: b, rawCave: root.games.cave ?? null, wallet, characterId: ctx.characterId ?? null, day: utc(ctx), daily: daily(root, ctx), rules: localRules })).digest("base64url")}`;
}
const coins = (n: CaveExtensionV1, tier: CaveType) => tier === 1 ? n.normalCoins : n.advancedCoins;
function addCoins(n: CaveExtensionV1, tier: CaveType, delta: number) { if (tier === 1) n.normalCoins += delta; else n.advancedCoins += delta; }
function track(b: CaveState, tier: CaveType) {
  if (validExtension(b.native)) {
    if (tier === 1) b.native.normalDraws = Math.min(STAT_MAX, b.native.normalDraws + 1);
    else b.native.advancedDraws = Math.min(STAT_MAX, b.native.advancedDraws + 1);
  }
}
function rowsFor(b: CaveState, source: CaveType | "legacy") { return b.bag.filter(r => source === "legacy" ? r.caveType === undefined : r.caveType === source); }
function consume(b: CaveState, source: CaveType | "legacy", templateId?: number, amount?: number): Reward[] {
  let remaining = amount ?? Infinity;
  const consumed: { templateId: number; count: number }[] = [];
  b.bag = b.bag.flatMap(r => {
    if ((source === "legacy" ? r.caveType !== undefined : r.caveType !== source) || templateId !== undefined && r.templateId !== templateId || remaining === 0) return [r];
    const count = Math.min(r.count, remaining); consumed.push({ templateId: r.templateId, count }); remaining -= count;
    return count === r.count ? [] : [{ ...r, count: r.count - count }];
  });
  return merge(consumed);
}
function quotes(root: ActivityState, b: CaveState, ctx: ActivityContext, wallet: ActivityWallet): DrawQuote[] {
  const d = daily(root, ctx), free = Math.max(0, 3 - (d["cave:free"] ?? 0));
  return ([1, 2] as const).flatMap(tier => localRules.bundleSizes.map((bundleSize, index) => {
    const entries = Array.from({ length: Math.floor(5 / bundleSize) }, (_, i) => {
      const count = i + 1, draws = bundleSize * count, freeDraws = tier === 1 ? Math.min(draws, free) : 0, cost = tier === 1 ? (draws - freeDraws) * 15 : draws * 35;
      const reason = (d.actions ?? 0) >= 500 ? "今日新开采批次已达500次，仍可结算背包与奖励。" : b.bag.length + draws > 30 ? "临时背包空间不足，请先领取或回收。" : wallet.points < cost ? "活动积分不足。" : [b.draws + draws, b.score + draws * tier, b.fragments + draws].some(n => !int(n)) ? "累计进度已达存档容量。" : "可以开采，奖品先存临时背包。";
      return { count, draws, freeDraws, cost, canDraw: (d.actions ?? 0) < 500 && b.bag.length + draws <= 30 && wallet.points >= cost && [b.draws + draws, b.score + draws * tier, b.fragments + draws].every(n => int(n)), reason };
    });
    return { tier, index: index as 0 | 1 | 2, bundleSize, maxCount: Math.max(0, ...entries.filter(e => e.canDraw).map(e => e.count)), quotes: entries };
  }));
}
export function viewCaveLoot(root: ActivityState, ctx: ActivityContext, wallet: ActivityWallet): CaveProjection {
  const b = read(root, ctx);
  if (!b) return { version: 1, kind: "caveloot-native", available: false, day: utc(ctx), started: obj(root.games.cave) && Object.hasOwn(root.games.cave, "native"), stateToken: null, reason: "矿洞存档或扩展版本暂不兼容；原存档已保留，旧入口继续按原规则使用。", localRules: { version: 1, description: DESCRIPTION } };
  const n = b.native ?? extension(utc(ctx)), d = daily(root, ctx), newDraws = n.normalDraws + n.advancedDraws, percent = Math.min(100, Math.floor(newDraws / 2));
  const legacy = rowsFor(b, "legacy"), legacyRewards = merge(legacy), legacyCount = legacy.reduce((v, r) => v + r.count, 0), legacyCanRecycle = legacyCount > 0 && int(wallet.points + legacyCount * 2);
  return { version: 1, kind: "caveloot-native", available: true, day: utc(ctx), started: !!b.native, stateToken: token(root, b, ctx, wallet), catalogVersion: "caveloot-local-v1", points: wallet.points,
    actionsRemaining: Math.max(0, 500 - (d.actions ?? 0)), freeRemaining: Math.max(0, 3 - (d["cave:free"] ?? 0)), bagCapacity: 30, bagSlotsUsed: b.bag.length, draws: b.draws, progressScore: b.score, fragments: b.fragments, pityRemaining: 10 - b.pity,
    types: ([1, 2] as const).map(tier => {
      const bag = rowsFor(b, tier), count = bag.reduce((v, r) => v + r.count, 0), canRecycle = count > 0 && int(coins(n, tier) + count * 2);
      return { tier, label: tier === 1 ? "普通矿洞" : "高级矿洞", newDraws: tier === 1 ? n.normalDraws : n.advancedDraws, coins: coins(n, tier), rows: PRIZES.map((p, index) => {
        const itemCount = bag.filter(r => r.templateId === p.templateId).reduce((v, r) => v + r.count, 0), maxRecycleCount = Math.min(1000, itemCount, Math.floor((INT_MAX - coins(n, tier)) / 2));
        return { index: index as 0 | 1 | 2 | 3, templateId: p.templateId, name: p.name, itemCount, recycleUnitCoins: 2 as const, maxTakeCount: Math.min(1000, itemCount), maxRecycleCount, canTake: itemCount > 0, canRecycle: maxRecycleCount > 0, reason: itemCount ? "领取与回收消费同一临时包，仅可选择其一。" : "暂无该材料。" };
      }), canTakeAll: count > 0, canRecycleAll: canRecycle, reason: count ? canRecycle ? "可领取邮件或回收为同档矿币。" : "矿币接近容量，仅可领取或分批回收。" : "该分档临时包为空。" };
    }),
    legacyBag: { label: "历史混合包", records: legacy.length, itemCount: legacyCount, rewards: legacyRewards, canTake: legacyCount > 0, canRecycle: legacyCanRecycle, recyclePoints: legacyCount * 2, reason: legacyCount ? "历史无类型材料仅作一包；领取或回收为活动积分，不推断普通或高级来源。" : "没有历史无类型记录。" },
    pool: ([1, 2] as const).flatMap(tier => localRules.prizes.map((p, index) => ({ tier, index, templateId: p.templateId, name: material(p.templateId)!.name, itemCount: p.count * tier, weight: p.weight }))), drawChoices: quotes(root, b, ctx, wallet),
    floorPreview: ([1, 2] as const).map(tier => ({ tier, target: 10, current: b.pity, shared: true, reward: prize(11021, 2 * tier), rule: "普通、高级共用十抽保底；保底已包含在开采结果中，无需另领。" })),
    progress: localRules.progress.map(p => {
      const current = "targetScore" in p ? b.score : newDraws, target = "targetScore" in p ? p.targetScore : p.targetNewDraws, required = "progressPercent" in p ? p.progressPercent : 0;
      const claimed = p.id <= 3 ? b.claimed.includes(p.id) : n.claimedExtraProgress.includes(p.id), canClaim = !claimed && current >= target && percent >= required;
      return { id: p.id, page: p.page, target, current, progressPercentRequired: required, claimed, canClaim, rewards: [prize(p.templateId, p.count)], reason: claimed ? "该档奖励已领取，两入口共用领取记录。" : canClaim ? "已达成本地个人进度，可领取。" : "尚未达到本地个人进度要求。" };
    }), personalProgressPercent: percent,
    shop: ([1, 2] as const).flatMap(tier => localRules.shop.map(p => {
      const bought = n.shopBought[tier - 1]![p.index]!, remaining = 5 - bought, maxCount = Math.min(remaining, Math.floor(coins(n, tier) / p.unitCoins));
      return { tier, index: p.index, unitCoins: p.unitCoins, bought, dailyLimit: 5, remaining, maxCount, canBuy: maxCount > 0, reward: prize(p.templateId, p.count), reason: !remaining ? "今日该项已售罄，UTC次日刷新。" : !maxCount ? "同档本地矿币不足。" : "消耗同档矿币，永久绑定材料寄往邮件。" };
    })), exchange: { fragmentCost: 10, reward: prize(11021, 2), canExchange: b.fragments >= 10, reason: b.fragments >= 10 ? "可用10碎片兑换，与旧入口共用余额。" : "需要10枚活动碎片。" },
    rank: { available: false, rows: [], myRank: null, myScore: b.score, reason: "未接入原全服排行与排名奖励，不生成虚假玩家。" }, records: root.history.filter(s => s.includes("矿洞") || s.includes("caveloot-native")).slice(0, 20), localRules: { version: 1, description: DESCRIPTION },
    unavailable: [ { id: "original-payments", reason: "仅使用本地任务积分，不接原充值或真实付款。" }, { id: "original-pool", reason: "原奖池属性、赔率及Protect算法未知；使用明示本地四材料规则。" }, { id: "global-progress", reason: "第二页仅为本角色启用后里程碑，不冒充全服进度。" }, { id: "global-rank", reason: "原全服排名与奖励后台未移植。" } ] };
}

interface Hooks { charge(n: number): void; earn(n: number): void; count(key: string, n?: number): void; done(): void; roll(guaranteed: boolean): ActivityReward }
export interface CaveAdvance { rewards: ActivityReward[]; message: string; effects?: CaveEffect[] }
/** Exact old cave rules, shared save. Unknown extensions are deliberately not decoded or reset. */
export function advanceLegacyCave(root: ActivityState, action: ActivityAction, hooks: Hooks): CaveAdvance {
  const b = (root.games.cave as CaveState | undefined) ?? createCaveState(); root.games.cave = b;
  const rewards: ActivityReward[] = []; let message = "活动进度已保存。";
  if (action.type === "draw") {
    const n = action.count ?? 1; need(int(n, 1, 5), "每次只能进行1至5次寻宝。"); need(b.bag.length + n <= 30, "临时背包已满，请先领取或回收。");
    need(action.choice === undefined || ["normal", "advanced"].includes(action.choice), "寻宝模式无效。"); const advanced = action.choice === "advanced", tier = advanced ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const free = !advanced && (root.daily["cave:free"] ?? 0) < 3;
      if (free) hooks.count("cave:free"); else hooks.charge(advanced ? 35 : 15);
      b.pity++; const guaranteed = b.pity >= 10, item = hooks.roll(guaranteed); if (guaranteed) b.pity = 0;
      if (advanced) item.count *= 2; b.bag.push({ ...item, caveType: tier } as BagDraw); b.draws++; b.score += advanced ? 2 : 1; b.fragments++; hooks.count("draws"); track(b, tier);
    }
    hooks.done(); message = `完成${n}次矿洞寻宝，奖品留在临时背包。`;
  } else if (action.type === "take" || action.type === "recycle") {
    need(b.bag.length > 0, "临时背包为空。");
    if (action.type === "take") { rewards.push(...b.bag); message = "临时背包已全部寄往游戏邮箱。"; }
    else { const n = b.bag.reduce((a, r) => a + r.count * 2, 0); hooks.earn(n); message = `已回收临时背包，获得${n}活动积分。`; }
    b.bag = [];
  } else if (action.type === "exchange") {
    need(b.fragments >= 10, "需要10枚活动碎片。"); b.fragments -= 10; rewards.push({ templateId: 11021, count: 2 }); message = "10枚碎片已兑换，奖励已寄出。";
  } else if (action.type === "progress") {
    need(int(action.tier, 1, 3) && b.score >= action.tier * 10, "尚未达到该档寻宝进度。"); need(!b.claimed.includes(action.tier), "这档进度奖励已经领取。"); b.claimed.push(action.tier); rewards.push({ templateId: 11019, count: action.tier * 2 });
  } else throw new ActivityError("寻宝操作无效。");
  return { rewards, message };
}
function validate(action: ActivityAction) {
  const fields: Record<string, string[]> = { draw: ["tier", "index", "count"], "take-item": ["tier", "index", "count"], "recycle-item": ["tier", "index", "count"], "take-all": ["tier"], "recycle-all": ["tier"], "take-legacy": [], "recycle-legacy": [], progress: ["tier"], exchange: [], buy: ["tier", "index", "count"] };
  const allowed = Object.hasOwn(fields, action.type) ? fields[action.type] : undefined; need(allowed && Object.keys(action).every(k => ["type", "choice", ...allowed].includes(k)) && allowed.every(k => Object.hasOwn(action, k)), "矿洞操作字段无效。");
  need(typeof action.choice === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(action.choice), "矿洞状态令牌无效。");
  if (action.type === "progress") need(int(action.tier, 1, 11), "进度奖励编号无效。");
  else if (allowed.includes("tier")) need(action.tier === 1 || action.tier === 2, "矿洞分档无效。");
  if (allowed.includes("index")) need(int(action.index, 0, action.type === "draw" ? 2 : 3), "矿洞目录索引无效。");
  if (allowed.includes("count")) need(int(action.count, 1, action.type === "draw" ? Math.floor(5 / localRules.bundleSizes[action.index as 0 | 1 | 2]) : action.type === "buy" ? 5 : 1000), "矿洞数量无效。");
}
export function advanceCaveLoot(root: ActivityState, action: ActivityAction, ctx: ActivityContext, wallet: ActivityWallet, hooks: Hooks): CaveAdvance {
  validate(action); const view = viewCaveLoot(root, ctx, wallet); need(view.available, "矿洞扩展暂不兼容，原存档已保留。", 409);
  need(action.choice === view.stateToken, "矿洞状态已变化，请刷新后重试。", 409);
  const b = read(root, ctx)!; b.native ??= extension(utc(ctx)); root.games.cave = b; const n = b.native;
  const rewards: ActivityReward[] = [], effects: CaveEffect[] = []; const tier = action.tier as CaveType;
  let message = "矿洞状态已保存。";
  if (action.type === "draw") {
    const q = view.drawChoices.find(q => q.tier === tier && q.index === action.index)!.quotes.find(q => q.count === action.count)!;
    need(q.canDraw, q.reason, 409); hooks.charge(q.cost); let guaranteedDraws = 0; const results: ActivityReward[] = [];
    for (let i = 0; i < q.draws; i++) {
      b.pity++; const guaranteed = b.pity >= 10, item = hooks.roll(guaranteed); if (guaranteed) { b.pity = 0; guaranteedDraws++; }
      item.count *= tier; b.bag.push({ ...item, caveType: tier } as BagDraw); b.draws++; b.score += tier; b.fragments++; track(b, tier); results.push(item);
    }
    hooks.count("cave:free", q.freeDraws); hooks.count("draws", q.draws); hooks.done();
    effects.push({ type: "drawn", tier, animationBand: action.index as 0 | 1 | 2, draws: q.draws, freeDraws: q.freeDraws, cost: q.cost, guaranteedDraws, results: merge(results) }); message = `完成${q.draws}次矿洞开采，结果已保存到临时包。`;
  } else if (["take-item", "recycle-item", "take-all", "recycle-all", "take-legacy", "recycle-legacy"].includes(action.type)) {
    const source = action.type.endsWith("legacy") ? "legacy" : tier, itemAction = action.type.endsWith("item"), p = itemAction ? PRIZES[action.index!]! : undefined;
    const available = rowsFor(b, source).filter(r => !p || r.templateId === p.templateId).reduce((v, r) => v + r.count, 0), amount = itemAction ? action.count! : available;
    need(amount > 0 && amount <= available, "临时包数量不足或已结算。", 409);
    const take = action.type.startsWith("take"), awarded = amount * 2;
    if (!take) need(int((source === "legacy" ? wallet.points : coins(n, source)) + awarded), "回收余额已达容量，请先消费或领取。", 409);
    const items = consume(b, source, p?.templateId, amount);
    if (take) { rewards.push(...items.map(raw)); effects.push({ type: "taken", source, itemCount: amount, rewards: items }); message = "所选矿洞材料已寄往游戏邮箱。"; }
    else { if (source === "legacy") hooks.earn(awarded); else addCoins(n, source, awarded); effects.push({ type: "recycled", source, itemCount: amount, coinsAwarded: source === "legacy" ? 0 : awarded, pointsAwarded: source === "legacy" ? awarded : 0, consumed: items }); message = source === "legacy" ? `历史包已回收，获得${awarded}活动积分。` : `已回收为${awarded}枚同档本地矿币。`; }
  } else if (action.type === "progress") {
    const p = view.progress[action.tier! - 1]!; need(p.canClaim, p.reason, 409); if (p.id <= 3) b.claimed.push(p.id); else n.claimedExtraProgress.push(p.id); rewards.push(...p.rewards.map(raw)); effects.push({ type: "progress-claimed", id: p.id, rewards: p.rewards }); message = "本地个人进度奖励已寄出。";
  } else if (action.type === "exchange") {
    need(view.exchange.canExchange, view.exchange.reason, 409); b.fragments -= 10; const items = [prize(11021, 2)]; rewards.push(...items.map(raw)); effects.push({ type: "exchanged", fragmentsSpent: 10, rewards: items }); message = "10枚共享碎片已兑换材料。";
  } else {
    const p = view.shop.find(p => p.tier === tier && p.index === action.index)!; need(action.count! <= p.maxCount, p.reason, 409); const cost = p.unitCoins * action.count!, items = [prize(p.reward.templateId, p.reward.itemCount * action.count!)];
    addCoins(n, tier, -cost); n.shopBought[tier - 1]![action.index!]! += action.count!; rewards.push(...items.map(raw)); effects.push({ type: "bought", tier, index: action.index as 0 | 1 | 2 | 3, count: action.count!, coinsSpent: cost, rewards: items }); message = "同档矿币商品已寄往游戏邮箱。";
  }
  return { rewards, message, effects };
}
