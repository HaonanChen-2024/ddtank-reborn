import { createHash } from "node:crypto";
import { LOCAL_RULES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityWallet } from "./types.js";

/** Original windows and flow, explicit local economy; never migrate the legacy single-die save. */
export type Day = string; // strict UTC YYYY-MM-DD
export type StateToken = string; // `${day}.${base64url(sha256(fullCanonicalInput))}`; 54 chars
export type Four<T> = [T, T, T, T];
export type Five<T> = [T, T, T, T, T];
export type Three<T> = [T, T, T];
export type MaterialId = 11019 | 11001 | 11021 | 11002;
export type BoxIndex = 0 | 1 | 2;
export type BeadIndex = 0 | 1 | 2 | 3 | 4;
export interface Reward { templateId: MaterialId; count: number; bound: true; validDays: 0 }
export interface Reasoned { reason: string }
export type Grant =
  | { kind: "material"; reward: Reward }
  | { kind: "bead"; index: BeadIndex; count: 1 }
  | { kind: "box"; index: BoxIndex; count: 1 }
  | { kind: "marks"; count: 3 };
export interface Slot {
  index: number; prizeId: number; originalRenderType: 1 | 2 | 3;
  label: string; weight: number; weightTotal: 100;
  // The bead slot shows five original asset.deviturn.beadN skins, not new item templates.
  grant: Exclude<Grant, { kind: "bead" }> | { kind: "random-bead"; count: 1; eachWeight: 1; weightTotal: 5 };
}
export interface DrawResult { sequence: number; prizeId: number; grant: Grant; marksEarned: number }
export type DiceUiState = 1 | 2 | 3; // ready / successful / failed
export interface DiceResult { left: number; right: number; sum: number; success: boolean }
export interface PrivateRound {
  id: number; boxIndex: BoxIndex; phase: 1 | 2 | 3 | 4 | 5; state: DiceUiState;
  retries: number; lastDice: DiceResult | null;
  // The maximum marks payable by this box remain capacity-reserved until terminal settlement.
}
export interface PrivateDevilState {
  [unknownExistingField: string]: unknown;
  version: 1; kind: "devil-native"; day: Day;
  freeClaimed: boolean; shopBought: Four<number>;
  turns: number; beads: Five<number>; boxes: Three<number>; marks: number;
  draws: number; roundSequence: number; activeRound: PrivateRound | null;
  milestoneClaimed: number[]; recentDraws: DrawResult[]; // bounded to last 10, no future RNG
}
// Stored ONLY at ActivityStates(Activity='reference').State.games.devilNativeV1.
// Preserve all other root/games keys, especially legacy games.devil. No legacy migration.
export interface DiceStage {
  phase: number; rangeMin: number; rangeMax: number;
  winningPairs: number; possiblePairs: 36; reward: Reward; marks: number;
}
export interface RoundView extends Reasoned {
  id: number; boxIndex: BoxIndex; phase: number; state: DiceUiState;
  rangeMin: number; rangeMax: number; stages: Five<DiceStage>; lastDice: DiceResult | null;
  retryPoints: 10; canRoll: boolean; canContinue: boolean; canTake: boolean; canAbandon: boolean;
}
export interface BoxView extends Reasoned {
  index: BoxIndex; name: string; count: number; expireAt: null;
  beadCosts: Five<number>; canConvert: boolean; canOpen: boolean;
}
export interface MilestoneView extends Reasoned {
  index: number; catalogId: number; drawsRequired: number; claimed: boolean;
  canClaim: boolean; reward: Reward;
}
export interface ShopItem extends Reasoned {
  index: number; catalogId: number; unitMarks: number; reward: Reward;
  dailyLimit: 10; boughtToday: number; maxCount: number; canBuy: boolean;
}
export interface DevilView {
  version: 1; catalogVersion: "local-devil-native-v1"; day: Day; stateToken: StateToken;
  available: true; points: number; dailyActionsRemaining: number;
  turns: number; freeAvailable: boolean; canBuyOne: boolean; canBuyTen: boolean;
  drawMaxCount: number; draws: number; marks: number; beads: Five<number>;
  purchase: { onePoints: 20; tenPoints: 200; freePerUtcDay: 1; freeGrantsTurns: 1 };
  slots: Slot[]; boxes: Three<BoxView>; round: RoundView | null;
  milestones: MilestoneView[]; shop: Four<ShopItem>; recentDraws: DrawResult[];
  rules: string[];
  unavailable: { id: "reference-economy" | "global-jackpot-ranking" | "timed-box-expiry"; reason: string }[];
}
// Existing POST /api/account/activities/devil-native/action envelope is unchanged:
// { characterId, requestId: UUID, action }. Strict per-action keys, no extra values/default aliases.
export type DevilAction =
  | { type: "free-turn"; choice: StateToken }
  | { type: "buy-turns"; count: 1 | 10; choice: StateToken }
  | { type: "draw"; count: number; choice: StateToken } // strict integer 1..10
  | { type: "convert-box"; index: BoxIndex; choice: StateToken }
  | { type: "open-box"; index: BoxIndex; choice: StateToken }
  | { type: "roll-dice"; choice: StateToken }
  | { type: "continue-dice"; choice: StateToken }
  | { type: "take-box"; choice: StateToken }
  | { type: "abandon-box"; choice: StateToken }
  | { type: "claim-milestone"; index: number; choice: StateToken } // 0..8
  | { type: "buy-item"; index: number; count: number; choice: StateToken }; // index0..3,count1..10
export type DevilEffect =
  | { type: "turns-added"; source: "free" | "points"; count: number; pointsSpent: number }
  | { type: "drawn"; results: DrawResult[]; mailedRewards: Reward[] }
  | { type: "box-converted"; index: BoxIndex; beadsSpent: Five<number> }
  | { type: "box-opened"; index: BoxIndex; roundId: number }
  | { type: "dice-rolled"; roundId: number; phase: number; result: DiceResult }
  | { type: "dice-continued"; roundId: number; phase: number; retried: boolean; pointsSpent: number }
  | { type: "box-taken"; roundId: number; phase: number; marks: number; reward: Reward }
  | { type: "box-abandoned"; roundId: number }
  | { type: "milestone-claimed"; index: number; reward: Reward }
  | { type: "item-bought"; index: number; count: number; marksSpent: number; reward: Reward };
export interface FreshEnvelope { requestId: string; effects: DevilEffect[] }
export interface UnavailableDevilView { version: 1; catalogVersion: "local-devil-native-v1"; day: Day; available: false; stateToken: null; reason: string }
export type DevilProjection = DevilView | UnavailableDevilView;
// ActivitySnapshot.nativeDevil = DevilProjection; fresh ActivityResult.nativeDevilAction = FreshEnvelope.
// GET and committed UUID replay have NO fresh effect envelope. Existing shared receipts stay immutable.
export interface PureTransition {
  state: PrivateDevilState; cost: number; countedActions: number;
  rewards: Reward[]; effects: DevilEffect[]; message: string;
}

const MAX = 2_147_483_647;
type Clock = Pick<ActivityContext, "now" | "characterId">;
type Random = () => number;
const material = (templateId: MaterialId, count: number): Reward => ({ templateId, count, bound: true, validDays: 0 });
export const devilNativeRules = {
  catalogVersion: "local-devil-native-v1" as const, onePoints: 20 as const, tenPoints: 200 as const,
  freePerUtcDay: 1 as const, freeGrantsTurns: 1 as const, retryPoints: 10 as const,
  maxBatch: 10, dailyShopLimit: 10, counterLimit: MAX,
  ranges: [[2, 12], [3, 11], [4, 10], [5, 9], [6, 8]], winningPairs: [36, 34, 30, 24, 16],
  stageCounts: [1, 2, 3, 5, 8], stageMarks: [1, 2, 4, 6, 10], boxTemplates: [11019, 11001, 11021],
  beadCosts: [[1, 1, 1, 0, 0], [2, 2, 0, 2, 0], [0, 0, 3, 3, 3]],
  description: ["本地玩法：每日UTC免费领1次，20活动积分购1次或200积分购10次；有限连续探险最多10次，结果一次结算，动画不再抽奖。",
    "8格本地权重25/20/30/10/5/5/2/3，总100；珠槽五色等概率。每抽另得1印记，材料直接寄邮件，珠、箱、印记仅是本活动计数。",
    "箱永久有效，每角色同时一局双骰五阶段；成功可领或免费进阶，失败10积分重投当前阶段或放弃。关闭、掉线不会丢弃本局。",
    "次数礼永久每档一次；宝物商店消费印记，每项每日UTC限10份。真实付款、原服经济、全服奖池排行、时限箱规则未接入。"],
};
const L = devilNativeRules;
export const devilNativeSlots: Slot[] = [
  { index: 0, prizeId: 1, originalRenderType: 2, label: "强化石1级×1", weight: 25, weightTotal: 100, grant: { kind: "material", reward: material(11019, 1) } },
  { index: 1, prizeId: 2, originalRenderType: 2, label: "朱雀石1级×1", weight: 20, weightTotal: 100, grant: { kind: "material", reward: material(11001, 1) } },
  { index: 2, prizeId: 3, originalRenderType: 3, label: "五色珠随机1颗（活动计数）", weight: 30, weightTotal: 100, grant: { kind: "random-bead", count: 1, eachWeight: 1, weightTotal: 5 } },
  { index: 3, prizeId: 4, originalRenderType: 2, label: "宝藏印记×3（活动计数）", weight: 10, weightTotal: 100, grant: { kind: "marks", count: 3 } },
  { index: 4, prizeId: 5, originalRenderType: 1, label: "宝箱一×1（活动计数）", weight: 5, weightTotal: 100, grant: { kind: "box", index: 0, count: 1 } },
  { index: 5, prizeId: 6, originalRenderType: 2, label: "宝箱二×1（活动计数）", weight: 5, weightTotal: 100, grant: { kind: "box", index: 1, count: 1 } },
  { index: 6, prizeId: 7, originalRenderType: 1, label: "宝箱三×1（活动计数）", weight: 2, weightTotal: 100, grant: { kind: "box", index: 2, count: 1 } },
  { index: 7, prizeId: 8, originalRenderType: 2, label: "强化石2级×1", weight: 3, weightTotal: 100, grant: { kind: "material", reward: material(11021, 1) } },
];
const milestones = [10, 30, 50, 100, 200, 300, 500, 800, 1000].map((drawsRequired, index) => ({ index, catalogId: index + 1, drawsRequired,
  reward: material(([11019, 11001, 11021, 11002] as MaterialId[])[index % 4], [3, 3, 1, 1, 5, 5, 3, 3, 10][index]) }));
const shop = [11019, 11001, 11021, 11002].map((id, index) => ({ index, catalogId: index + 1,
  unitMarks: [15, 20, 25, 30][index], reward: material(id as MaterialId, [3, 3, 1, 1][index]) }));
const unavailable: DevilView["unavailable"] = [
  { id: "reference-economy", reason: "采用明示本地积分、材料与双骰规则，未复刻原私服经济、真实付款或装备属性。" },
  { id: "global-jackpot-ranking", reason: "原全服奖池与排行奖励后台未知；只显示个人印记，不虚构全服数据。" },
  { id: "timed-box-expiry", reason: "本地箱永久有效，未移植原时限箱过期与补偿后台。" },
];
function need(ok: unknown, message: string, status = 400): asserts ok { if (!ok) throw new ActivityError(message, status); }
const int = (n: unknown, min = 0, max = MAX): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function today(ctx: Clock) { need(ctx.now instanceof Date && Number.isFinite(ctx.now.getTime()), "恶魔宝藏日期无效。"); return ctx.now.toISOString().slice(0, 10); }
function validDay(x: unknown): x is string { return typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)
  && Number.isFinite(Date.parse(x + "T00:00:00Z")) && new Date(x + "T00:00:00Z").toISOString().slice(0, 10) === x; }
function empty(day: Day): PrivateDevilState { return { version: 1, kind: "devil-native", day, freeClaimed: false, shopBought: [0, 0, 0, 0],
  turns: 0, beads: [0, 0, 0, 0, 0], boxes: [0, 0, 0], marks: 0, draws: 0, roundSequence: 0, activeRound: null, milestoneClaimed: [], recentDraws: [] }; }
const reserve = (s: PrivateDevilState) => s.activeRound ? 10 * (s.activeRound.boxIndex + 1) : 0;
function validDice(x: unknown, phase: number): x is DiceResult {
  return object(x) && int(x.left, 1, 6) && int(x.right, 1, 6) && x.sum === x.left + x.right && typeof x.success === "boolean"
    && x.success === (x.sum >= L.ranges[phase - 1][0] && x.sum <= L.ranges[phase - 1][1]);
}
function validDraw(x: unknown, sequence: number): x is DrawResult {
  if (!object(x) || x.sequence !== sequence || !int(x.prizeId, 1, 8) || !object(x.grant)) return false;
  const slot = devilNativeSlots[x.prizeId - 1];
  return x.marksEarned === (slot.prizeId === 4 ? 4 : 1) && (slot.grant.kind === "random-bead"
    ? x.grant.kind === "bead" && int(x.grant.index, 0, 4) && x.grant.count === 1 : canonical(x.grant) === canonical(slot.grant));
}
/** Clone and validate only this owner's save; unknown fields survive successful transitions. */
export function readDevilNativeState(value: unknown, ctx: Clock): PrivateDevilState {
  const day = today(ctx); if (value === undefined) return empty(day);
  const bad = "恶魔宝藏存档或版本不兼容，请保留存档并联系维护者。";
  need(object(value) && value.version === 1 && value.kind === "devil-native" && validDay(value.day), bad, 503);
  for (const key of ["turns", "marks", "draws", "roundSequence"]) need(int(value[key]), bad, 503);
  need(typeof value.freeClaimed === "boolean" && Array.isArray(value.shopBought) && value.shopBought.length === 4 && value.shopBought.every(n => int(n, 0, 10)), bad, 503);
  for (const [key, length] of [["beads", 5], ["boxes", 3]] as const) need(Array.isArray(value[key]) && value[key].length === length && value[key].every(n => int(n)), bad, 503);
  need(Array.isArray(value.milestoneClaimed) && value.milestoneClaimed.every(n => int(n, 1, 9)) && new Set(value.milestoneClaimed).size === value.milestoneClaimed.length, bad, 503);
  need(Array.isArray(value.recentDraws) && value.recentDraws.length === Math.min(value.draws as number, 10)
    && value.recentDraws.every((row, index) => validDraw(row, (value.draws as number) - index)), bad, 503);
  if (value.activeRound !== null) {
    const round = value.activeRound;
    need(object(round) && int(round.id, 1, value.roundSequence as number) && int(round.boxIndex, 0, 2) && int(round.phase, 1, 5)
      && int(round.state, 1, 3) && int(round.retries), bad, 503);
    need(round.state === 1 ? round.lastDice === null : validDice(round.lastDice, round.phase) && round.lastDice.success === (round.state === 2), bad, 503);
    need((value.marks as number) <= MAX - 10 * (round.boxIndex + 1), bad, 503);
  }
  const s = structuredClone(value) as unknown as PrivateDevilState;
  if (s.day !== day) { s.day = day; s.freeClaimed = false; s.shopBought = [0, 0, 0, 0]; }
  return s;
}
function inputs(ctx: Clock, wallet: ActivityWallet, remaining: number, claims: string[]) {
  today(ctx); need([wallet.points, wallet.earned, wallet.revision].every(n => int(n)) && int(remaining, 0, LOCAL_RULES.maxDailyActions)
    && Array.isArray(claims) && claims.every(c => typeof c === "string"), "恶魔宝藏积分或次数无效。");
}
function token(s: PrivateDevilState, ctx: Clock, wallet: ActivityWallet, remaining: number, claims: string[]) {
  return `${today(ctx)}.${createHash("sha256").update(canonical({ state: s, characterId: ctx.characterId ?? 0, wallet, remaining, claims,
    rules: L, slots: devilNativeSlots, milestones, shop })).digest("base64url")}`;
}
const claimKey = (id: number) => `devil-native:milestone:${id}`;
const publicDice = (d: DiceResult | null): DiceResult | null => d ? { left: d.left, right: d.right, sum: d.sum, success: d.success } : null;
function publicDraw(d: DrawResult): DrawResult {
  const slot = devilNativeSlots[d.prizeId - 1];
  const grant: Grant = slot.grant.kind === "random-bead" ? { kind: "bead", index: (d.grant as { index: BeadIndex }).index, count: 1 } : structuredClone(slot.grant);
  return { sequence: d.sequence, prizeId: d.prizeId, grant, marksEarned: d.marksEarned };
}
function maxDraw(s: PrivateDevilState, remaining: number) { return Math.max(0, Math.min(10, remaining, s.turns, MAX - s.draws,
  Math.floor((MAX - reserve(s) - s.marks) / 4), ...s.beads.map(n => MAX - n), ...s.boxes.map(n => MAX - n))); }
function stage(boxIndex: BoxIndex, index: number): DiceStage { return { phase: index + 1, rangeMin: L.ranges[index][0], rangeMax: L.ranges[index][1],
  winningPairs: L.winningPairs[index], possiblePairs: 36, reward: material(L.boxTemplates[boxIndex] as MaterialId, L.stageCounts[index]), marks: L.stageMarks[index] * (boxIndex + 1) }; }
/** GET is side-effect free, including an isolated unavailable projection for a bad/future save. */
export function viewDevilNative(value: unknown, ctx: Clock, wallet: ActivityWallet, remaining = 500, claims: string[] = []): DevilProjection {
  inputs(ctx, wallet, remaining, claims); let s: PrivateDevilState;
  try { s = readDevilNativeState(value, ctx); } catch (error) {
    if (!(error instanceof ActivityError)) throw error;
    return { version: 1, catalogVersion: L.catalogVersion, day: today(ctx), available: false, stateToken: null, reason: error.message };
  }
  const r = s.activeRound, room = MAX - s.marks - reserve(s);
  const boxes = s.boxes.map((count, index): BoxView => { const cost = L.beadCosts[index], canConvert = count < MAX && cost.every((n, i) => s.beads[i] >= n);
    const canOpen = count > 0 && !r && s.roundSequence < MAX && room >= 10 * (index + 1);
    return { index: index as BoxIndex, name: `宝箱${index + 1}（活动计数）`, count, expireAt: null, beadCosts: [...cost] as Five<number>, canConvert, canOpen,
      reason: canOpen ? "可打开一箱开始双骰探险。" : r ? "已有骰局，请恢复、领取或放弃本局。" : count ? "本地计数容量不足，先结算或兑换印记。" : "暂无宝箱，可探险获得或用五色珠兑换。" }; }) as Three<BoxView>;
  const round: RoundView | null = r ? { id: r.id, boxIndex: r.boxIndex, phase: r.phase, state: r.state, rangeMin: L.ranges[r.phase - 1][0], rangeMax: L.ranges[r.phase - 1][1],
    stages: Array.from({ length: 5 }, (_, i) => stage(r.boxIndex, i)) as Five<DiceStage>, lastDice: publicDice(r.lastDice), retryPoints: 10,
    canRoll: r.state === 1 && remaining > 0, canContinue: r.state === 2 ? r.phase < 5 : r.state === 3 && wallet.points >= 10 && remaining > 0 && r.retries < MAX,
    canTake: r.state === 2, canAbandon: r.state === 3, reason: r.state === 1 ? "等待掷出两颗骰子。" : r.state === 2 ? "已成功，可领取当前档；进阶后需再次成功。" : "本次失败，可10积分重投当前阶段或放弃。" } : null;
  return { version: 1, catalogVersion: L.catalogVersion, day: s.day, available: true, stateToken: token(s, ctx, wallet, remaining, claims), points: wallet.points,
    dailyActionsRemaining: remaining, turns: s.turns, freeAvailable: !s.freeClaimed && s.turns < MAX,
    canBuyOne: wallet.points >= 20 && remaining > 0 && s.turns < MAX, canBuyTen: wallet.points >= 200 && remaining > 0 && s.turns <= MAX - 10,
    drawMaxCount: maxDraw(s, remaining), draws: s.draws, marks: s.marks, beads: [...s.beads],
    purchase: { onePoints: 20, tenPoints: 200, freePerUtcDay: 1, freeGrantsTurns: 1 }, slots: structuredClone(devilNativeSlots), boxes, round,
    milestones: milestones.map(m => { const claimed = s.milestoneClaimed.includes(m.catalogId) || claims.includes(claimKey(m.catalogId));
      return { ...structuredClone(m), claimed, canClaim: !claimed && s.draws >= m.drawsRequired, reason: claimed ? "已经领取。" : s.draws >= m.drawsRequired ? "次数达标，可领取一次。" : "累计探险次数尚未达标。" }; }),
    shop: shop.map(item => { const maxCount = Math.min(10 - s.shopBought[item.index], Math.floor(s.marks / item.unitMarks));
      return { ...structuredClone(item), dailyLimit: 10 as const, boughtToday: s.shopBought[item.index], maxCount, canBuy: maxCount > 0,
        reason: maxCount ? "可使用本活动印记兑换。" : s.shopBought[item.index] >= 10 ? "本项今日已达限购，UTC次日刷新。" : "本活动印记不足。" }; }) as Four<ShopItem>,
    recentDraws: s.recentDraws.map(publicDraw), rules: [...L.description], unavailable: structuredClone(unavailable) };
}
function sample(rng: Random, count: number) { const n = rng(); need(Number.isFinite(n) && n >= 0 && n < 1, "恶魔宝藏随机结果无效。"); return Math.floor(n * count); }
/** Wallet lock, canonical UUID receipt, mail and all returned changes belong to the existing service transaction. */
export function advanceDevilNative(value: unknown, action: ActivityAction, ctx: Clock, wallet: ActivityWallet, rng: Random,
  remaining = 500, claims: string[] = []): PureTransition & { claimKey?: string } {
  inputs(ctx, wallet, remaining, claims); const s = readDevilNativeState(value, ctx), view = viewDevilNative(s, ctx, wallet, remaining, claims);
  need(view.available, "恶魔宝藏暂不可用。", 503);
  const fields: Record<string, string[]> = { "free-turn": [], "buy-turns": ["count"], draw: ["count"], "convert-box": ["index"], "open-box": ["index"],
    "roll-dice": [], "continue-dice": [], "take-box": [], "abandon-box": [], "claim-milestone": ["index"], "buy-item": ["index", "count"] };
  need(object(action) && typeof action.type === "string" && Object.hasOwn(fields, action.type), "恶魔宝藏操作无效。");
  const required = ["type", "choice", ...fields[action.type]];
  need(required.every(key => Object.hasOwn(action, key)) && Object.keys(action).every(key => required.includes(key)), "恶魔宝藏参数无效。");
  need(action.choice === view.stateToken, "恶魔宝藏进度、积分或日期已更新，请重新查看后确认。", 409);
  const rewards: Reward[] = [], effects: DevilEffect[] = []; let cost = 0, countedActions = 0, key: string | undefined;
  const r = s.activeRound;
  if (action.type === "free-turn" || action.type === "buy-turns") {
    const free = action.type === "free-turn", n = free ? 1 : action.count;
    need(int(n, 1, 10) && (free || n === 1 || n === 10), "购买次数必须为1或10次。");
    need(free ? view.freeAvailable : n === 1 ? view.canBuyOne : view.canBuyTen, "免费次数已领取、积分不足、次数或容量不足。");
    if (free) s.freeClaimed = true; else { cost = n * 20; countedActions = 1; }
    s.turns += n; effects.push({ type: "turns-added", source: free ? "free" : "points", count: n, pointsSpent: cost });
  } else if (action.type === "draw") {
    need(int(action.count, 1, 10) && action.count <= view.drawMaxCount, "探险数量、资格、每日次数或计数容量不足。");
    countedActions = action.count; const results: DrawResult[] = [];
    for (let i = 0; i < action.count; i++) {
      const ticket = sample(rng, 100); let sum = 0; const slot = devilNativeSlots.find(p => ticket < (sum += p.weight))!;
      const grant: Grant = slot.grant.kind === "random-bead" ? { kind: "bead", index: sample(rng, 5) as BeadIndex, count: 1 } : structuredClone(slot.grant);
      s.turns--; s.draws++; s.marks++;
      if (grant.kind === "material") rewards.push(grant.reward);
      else if (grant.kind === "bead") s.beads[grant.index]++;
      else if (grant.kind === "box") s.boxes[grant.index]++;
      else s.marks += grant.count;
      const row: DrawResult = { sequence: s.draws, prizeId: slot.prizeId, grant, marksEarned: grant.kind === "marks" ? 4 : 1 };
      results.push(row); s.recentDraws.unshift(structuredClone(row)); s.recentDraws = s.recentDraws.slice(0, 10);
    }
    effects.push({ type: "drawn", results, mailedRewards: structuredClone(rewards) });
  } else if (action.type === "convert-box" || action.type === "open-box") {
    need(int(action.index, 0, 2), "宝箱目录无效。"); const box = view.boxes[action.index];
    if (action.type === "convert-box") {
      need(box.canConvert, "珠数量不足或箱计数已满。"); s.beads = s.beads.map((n, i) => n - box.beadCosts[i]) as Five<number>; s.boxes[action.index]++;
      effects.push({ type: "box-converted", index: box.index, beadsSpent: [...box.beadCosts] });
    } else {
      need(box.canOpen, box.reason); s.boxes[action.index]--; s.roundSequence++;
      s.activeRound = { id: s.roundSequence, boxIndex: box.index, phase: 1, state: 1, retries: 0, lastDice: null };
      effects.push({ type: "box-opened", index: box.index, roundId: s.roundSequence });
    }
  } else if (["roll-dice", "continue-dice", "take-box", "abandon-box"].includes(action.type)) {
    need(r && view.round, "没有可继续的骰局。");
    if (action.type === "roll-dice") {
      need(view.round.canRoll, "当前不能投骰或今日新玩法次数不足。");
      const left = 1 + sample(rng, 6), right = 1 + sample(rng, 6), range = L.ranges[r.phase - 1];
      const result = { left, right, sum: left + right, success: left + right >= range[0] && left + right <= range[1] };
      r.lastDice = result; r.state = result.success ? 2 : 3; countedActions = 1;
      effects.push({ type: "dice-rolled", roundId: r.id, phase: r.phase, result });
    } else if (action.type === "continue-dice") {
      need(view.round.canContinue, "不能继续：已到末档、积分或次数不足。"); const retried = r.state === 3;
      if (retried) { cost = 10; countedActions = 1; r.retries++; } else r.phase = (r.phase + 1) as PrivateRound["phase"];
      r.state = 1; r.lastDice = null;
      effects.push({ type: "dice-continued", roundId: r.id, phase: r.phase, retried, pointsSpent: cost });
    } else if (action.type === "take-box") {
      need(view.round.canTake, "当前骰局尚未成功或已领取。"); const prize = stage(r.boxIndex, r.phase - 1);
      s.marks += prize.marks; rewards.push(prize.reward); s.activeRound = null;
      effects.push({ type: "box-taken", roundId: r.id, phase: r.phase, marks: prize.marks, reward: prize.reward });
    } else { need(view.round.canAbandon, "只有失败骰局可以放弃。"); s.activeRound = null; effects.push({ type: "box-abandoned", roundId: r.id }); }
  } else if (action.type === "claim-milestone") {
    need(int(action.index, 0, 8) && view.milestones[action.index].canClaim, "次数礼未达标或已经领取。"); const m = milestones[action.index];
    s.milestoneClaimed.push(m.catalogId); key = claimKey(m.catalogId); rewards.push(structuredClone(m.reward)); effects.push({ type: "milestone-claimed", index: m.index, reward: structuredClone(m.reward) });
  } else {
    need(int(action.index, 0, 3) && int(action.count, 1, 10) && action.count <= view.shop[action.index].maxCount, "商城数量、印记余额或每日限购不足。");
    const item = shop[action.index], marksSpent = item.unitMarks * action.count, reward = { ...item.reward, count: item.reward.count * action.count };
    s.marks -= marksSpent; s.shopBought[action.index] += action.count; rewards.push(reward);
    effects.push({ type: "item-bought", index: item.index, count: action.count, marksSpent, reward });
  }
  return { state: s, cost, countedActions, rewards, effects, ...(key ? { claimKey: key } : {}),
    message: rewards.length ? "恶魔宝藏已结算，普通材料已寄往游戏邮箱；动画不再次发奖。" : "恶魔宝藏进度已保存，关闭窗口不会撤销已提交结果。" };
}
