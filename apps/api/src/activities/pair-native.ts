import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityWallet } from "./types.js";

/** Local rules only. Neither the reference server's hidden generation nor its odds were recovered. */
export const pairNativeLocalRules = Object.freeze({
  version: 1, slots: 32, copiesPerPrize: 8, freeReelsPerDay: 32, freeResetsPerDay: 1,
  maxRoundsPerDay: 3, maxFlipsPerDay: 96, maxReelsBoughtPerDay: 64, maxReels: 96,
  reelPointCost: 2, flipPointCost: 2, resetPointCost: 10, maxMarks: 100_000,
  resetRequiresAllRevealed: true,
  prizes: Object.freeze([
    Object.freeze({ id: 1, templateId: 11019, name: "强化石1级", count: 1, markCost: 4 }),
    Object.freeze({ id: 2, templateId: 11001, name: "朱雀石1级", count: 1, markCost: 4 }),
    Object.freeze({ id: 3, templateId: 11021, name: "强化石2级", count: 1, markCost: 8 }),
    Object.freeze({ id: 4, templateId: 11002, name: "朱雀石2级", count: 1, markCost: 8 }),
  ]),
});
const L = pairNativeLocalRules, LIMIT = 1_000_000_000, ROUND_LIMIT = 1_000_000;
type Clock = Pick<ActivityContext, "now">;
type Funds = Pick<ActivityWallet, "points">;
type Random = () => number;

/** Server-only save. Never return this object through HTTP or the Flash bridge. */
export interface PairNativeState {
  version: 1; kind: "pair-native"; rulesVersion: 1; day: string; round: number;
  hiddenDeck: number[];
  /** One-based positions in reveal order. Revealed unmatched cards stay face-up. */
  revealed: number[];
  matches: [number, number][];
  freeReels: number; reels: number; marks: number; freeResets: number; totalMatchedPairs: number;
  daily: { rounds: number; flips: number; reelsBought: number };
}
export type PairNativeEffect =
  | { type: "started" | "round-completed"; round: number }
  | { type: "revealed"; pos: number; ID: number; consume: "free" | "reel" | "points" }
  | { type: "matched"; positions: [number, number]; ID: number; marksAdded: 1 }
  | { type: "reels-bought"; count: number }
  | { type: "reset"; round: number; mode: "free" | "points" }
  | { type: "exchanged"; templateId: number; count: number; marksSpent: number };
export interface PairNativeResult {
  state: PairNativeState; cost: number; rewards: ActivityReward[]; effects: PairNativeEffect[];
  completed: boolean; message: string;
}
function fail(message: string): never { throw new ActivityError(message); }
function int(value: unknown, min = 0, max = LIMIT): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function dayOf(ctx: Clock): string {
  if (!(ctx?.now instanceof Date) || !Number.isFinite(ctx.now.getTime())) fail("活动日期无效。");
  return ctx.now.toISOString().slice(0, 10);
}
function deck(rng: Random): number[] {
  const cards = L.prizes.flatMap(p => Array<number>(L.copiesPerPrize).fill(p.id));
  for (let i = cards.length - 1; i > 0; i--) {
    const n = rng();
    if (!Number.isFinite(n) || n < 0 || n >= 1) fail("随机结果无效，请稍后重试。");
    const j = Math.floor(n * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/** Starting is explicit. Opening a view never starts, shuffles, pays, exchanges or resets. */
export function createPairNative(ctx: Clock, rng: Random): PairNativeState {
  return { version: 1, kind: "pair-native", rulesVersion: 1, day: dayOf(ctx), round: 1,
    hiddenDeck: deck(rng), revealed: [], matches: [], freeReels: L.freeReelsPerDay,
    reels: 0, marks: 0, freeResets: L.freeResetsPerDay, totalMatchedPairs: 0,
    daily: { rounds: 1, flips: 0, reelsBought: 0 } };
}

function readState(value: unknown): PairNativeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("原生揭牌状态无效。");
  const s = value as PairNativeState;
  if (s.version !== 1 || s.kind !== "pair-native" || s.rulesVersion !== 1) fail("原生揭牌状态版本不匹配，不能转换旧配对存档。");
  if (typeof s.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.day)
    || !Number.isFinite(Date.parse(s.day)) || new Date(s.day).toISOString().slice(0, 10) !== s.day
    || !int(s.round, 1, ROUND_LIMIT)) fail("揭牌轮次或日期无效。");
  if (!Array.isArray(s.hiddenDeck) || s.hiddenDeck.length !== L.slots
    || Array.from(s.hiddenDeck).some(id => !int(id, 1, L.prizes.length))
    || L.prizes.some(p => s.hiddenDeck.filter(id => id === p.id).length !== L.copiesPerPrize)) fail("揭牌牌组无效。");
  if (!Array.isArray(s.revealed) || s.revealed.length > L.slots
    || Array.from(s.revealed).some(pos => !int(pos, 1, L.slots)) || new Set(s.revealed).size !== s.revealed.length
    || !Array.isArray(s.matches) || s.matches.length > L.slots / 2) fail("揭牌记录无效。");
  const waiting = new Map<number, number>(), expected: [number, number][] = [];
  for (const pos of s.revealed) {
    const id = s.hiddenDeck[pos - 1], other = waiting.get(id);
    if (other === undefined) waiting.set(id, pos);
    else { expected.push([other, pos]); waiting.delete(id); }
  }
  if (Array.from(s.matches).some((pair, i) => !Array.isArray(pair) || pair.length !== 2 || !expected[i]
    || pair[0] !== expected[i][0] || pair[1] !== expected[i][1]) || expected.length !== s.matches.length) fail("配对结算记录无效。");
  if (!int(s.freeReels, 0, L.freeReelsPerDay) || !int(s.reels, 0, L.maxReels)
    || !int(s.freeResets, 0, L.freeResetsPerDay) || !int(s.marks, 0, L.maxMarks)
    || !int(s.totalMatchedPairs) || s.totalMatchedPairs !== (s.round - 1) * L.slots / 2 + s.matches.length || s.marks > s.totalMatchedPairs
    || !s.daily || typeof s.daily !== "object" || Array.isArray(s.daily)
    || !int(s.daily.rounds, 0, L.maxRoundsPerDay) || s.daily.rounds > s.round
    || !int(s.daily.flips, 0, L.maxFlipsPerDay) || s.freeReels + s.daily.flips < L.freeReelsPerDay
    || !int(s.daily.reelsBought, 0, L.maxReelsBoughtPerDay)) fail("揭牌次数或余额无效。");
  return { version: 1, kind: "pair-native", rulesVersion: 1, day: s.day, round: s.round,
    hiddenDeck: [...s.hiddenDeck], revealed: [...s.revealed], matches: s.matches.map(p => [p[0], p[1]]),
    freeReels: s.freeReels, reels: s.reels, marks: s.marks, freeResets: s.freeResets,
    totalMatchedPairs: s.totalMatchedPairs, daily: { rounds: s.daily.rounds, flips: s.daily.flips, reelsBought: s.daily.reelsBought } };
}
/** A fresh-day allowance is projected on a private copy; only a committed action saves it. */
function currentState(value: unknown, ctx: Clock): PairNativeState {
  const s = readState(value), today = dayOf(ctx);
  if (today < s.day) fail("活动时间早于存档日期。");
  if (today !== s.day) {
    s.day = today; s.freeReels = L.freeReelsPerDay; s.freeResets = L.freeResetsPerDay;
    s.daily = { rounds: 0, flips: 0, reelsBought: 0 };
  }
  return s;
}
function requireFunds(funds: Funds, cost: number) {
  if (!int(funds?.points) || !int(cost) || funds.points < cost) fail("活动积分不足。");
}
function validAction(action: ActivityAction) {
  if (!action || typeof action !== "object" || Array.isArray(action)) fail("揭牌操作无效。");
  const fields: Record<string, string[]> = { start: [], flip: ["index", "choice"], "flip-all": ["choice"], "buy-reels": ["count"], reset: ["choice"], exchange: ["choice", "count"] };
  if (!Object.hasOwn(fields, action.type) || Object.keys(action).some(k => k !== "type" && !fields[action.type].includes(k))) fail("揭牌操作或参数无效。");
}

/** Caller must atomically persist state, charge cost, apply rewards and deduplicate request UUIDs.
 * Single and batch reveal share one operation; all budget/cap checks happen before any returned effect. */
export function advancePairNative(value: unknown, action: ActivityAction, ctx: Clock, funds: Funds, rng: Random): PairNativeResult {
  validAction(action); requireFunds(funds, 0);
  if (action.type === "start") {
    if (value !== undefined) { readState(value); fail("揭牌已经开始，请继续当前一局。"); }
    const state = createPairNative(ctx, rng);
    return { state, cost: 0, rewards: [], effects: [{ type: "started", round: 1 }], completed: false, message: "原生揭牌已开始；本地规则为32格持续揭牌。" };
  }
  const s = currentState(value, ctx), rewards: ActivityReward[] = [], effects: PairNativeEffect[] = [];
  let cost = 0, completed = false, message = "揭牌进度已保存。";
  if (action.type === "flip" || action.type === "flip-all") {
    if (action.choice !== undefined && action.choice !== "tickets" && action.choice !== "points") fail("请选择仅用卷轴或明确使用活动积分。");
    const allowPoints = action.choice === "points";
    const remaining = Array.from({ length: L.slots }, (_, i) => i + 1).filter(pos => !s.revealed.includes(pos));
    let positions: number[];
    if (action.type === "flip") {
      if (!int(action.index, 1, L.slots) || s.revealed.includes(action.index)) fail("此位置无效或已经揭开。");
      positions = [action.index];
    } else positions = remaining.slice(0, allowPoints ? remaining.length : s.freeReels + s.reels);
    if (positions.length === 0) fail(remaining.length ? "卷轴不足；不会自动购买或扣积分。" : "本轮已全部揭开。");
    if (s.daily.flips + positions.length > L.maxFlipsPerDay) fail("今日揭牌次数已达上限。");
    const useFree = Math.min(s.freeReels, positions.length), useReels = Math.min(s.reels, positions.length - useFree);
    const paid = positions.length - useFree - useReels;
    if (paid > 0 && !allowPoints) fail("卷轴不足；不会自动购买或扣积分。");
    cost = paid * L.flipPointCost; requireFunds(funds, cost);
    // Simulate on the validated private copy; a later failure still leaves the caller's save unchanged.
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i], id = s.hiddenDeck[pos - 1];
      const other = s.revealed.find(p => s.hiddenDeck[p - 1] === id && !s.matches.some(pair => pair.includes(p)));
      s.revealed.push(pos);
      effects.push({ type: "revealed", pos, ID: id, consume: i < useFree ? "free" : i < useFree + useReels ? "reel" : "points" });
      if (other !== undefined) {
        if (s.marks >= L.maxMarks) fail("印记已达上限，请先兑换。");
        s.matches.push([other, pos]); s.marks++; s.totalMatchedPairs++;
        const prize = L.prizes[id - 1];
        rewards.push({ templateId: prize.templateId, count: prize.count });
        effects.push({ type: "matched", positions: [other, pos], ID: id, marksAdded: 1 });
      }
    }
    s.freeReels -= useFree; s.reels -= useReels; s.daily.flips += positions.length;
    completed = s.revealed.length === L.slots;
    if (completed) effects.push({ type: "round-completed", round: s.round });
    message = `已揭开${positions.length}格，完成${rewards.length}组配对；配对奖励通过游戏邮件发放。`;
  } else if (action.type === "buy-reels") {
    if (!int(action.count, 1, L.maxReelsBoughtPerDay) || s.daily.reelsBought + action.count > L.maxReelsBoughtPerDay
      || s.reels + action.count > L.maxReels) fail("购买数量超过今日限额或卷轴容量。");
    cost = action.count * L.reelPointCost; requireFunds(funds, cost);
    s.reels += action.count; s.daily.reelsBought += action.count;
    effects.push({ type: "reels-bought", count: action.count }); message = `已用活动积分兑换${action.count}张卷轴。`;
  } else if (action.type === "reset") {
    if (action.choice !== "free" && action.choice !== "points") fail("请明确选择免费重置或积分重置。");
    if (s.revealed.length !== L.slots) fail("本地规则要求先揭完32格，再重置本轮。");
    if (s.daily.rounds >= L.maxRoundsPerDay || s.round >= ROUND_LIMIT) fail("揭牌轮次已达上限。");
    if (action.choice === "free" && s.freeResets === 0) fail("免费重置次数已用完；不会自动扣积分。");
    cost = action.choice === "points" ? L.resetPointCost : 0; requireFunds(funds, cost);
    const nextDeck = deck(rng);
    s.hiddenDeck = nextDeck; s.revealed = []; s.matches = []; s.round++; s.daily.rounds++;
    if (action.choice === "free") s.freeResets--;
    effects.push({ type: "reset", round: s.round, mode: action.choice }); message = "新一轮牌面已保存，卷轴不会因重置而补发。";
  } else if (action.type === "exchange") {
    const prize = L.prizes.find(p => String(p.templateId) === action.choice), count = action.count ?? 1;
    if (!prize || !int(count, 1, 10)) fail("印记兑换物品或数量无效。");
    const marksSpent = prize.markCost * count;
    if (s.marks < marksSpent) fail("印记不足。");
    s.marks -= marksSpent; rewards.push({ templateId: prize.templateId, count });
    effects.push({ type: "exchanged", templateId: prize.templateId, count, marksSpent }); message = "印记兑换已结算，奖励通过游戏邮件发放。";
  }
  return { state: readState(s), cost, rewards, effects, completed, message };
}

/** Public projection only. No deck, shuffle seed, future ID, or future matching partner is exposed. */
export function viewPairNative(value: unknown, ctx: Clock) {
  const localRules = { ...L, prizes: L.prizes.map(p => ({ ...p })), description: "本地规则：32格，4种材料各8张，均匀洗牌；揭牌持续保留，相同ID每两张结算一次。非参考服或官方概率。" };
  if (value === undefined) { dayOf(ctx); return { started: false as const, localRules }; }
  const s = currentState(value, ctx);
  return { started: true as const, version: 1, kind: "pair-native", day: s.day, round: s.round, columns: 8, localRules,
    freeReelCount: s.freeReels, reelCount: s.reels, markCount: s.marks, freeResetCount: s.freeResets,
    todayBuyCount: s.daily.reelsBought, hiddenRemaining: L.slots - s.revealed.length, matchedPairs: s.matches.length,
    isAllOpen: s.revealed.length === L.slots, flipsRemaining: L.maxFlipsPerDay - s.daily.flips,
    roundsRemaining: L.maxRoundsPerDay - s.daily.rounds, buyRemaining: Math.min(L.maxReelsBoughtPerDay - s.daily.reelsBought, L.maxReels - s.reels),
    canFreeReset: s.revealed.length === L.slots && s.freeResets > 0 && s.daily.rounds < L.maxRoundsPerDay && s.round < ROUND_LIMIT,
    canPointsReset: s.revealed.length === L.slots && s.daily.rounds < L.maxRoundsPerDay && s.round < ROUND_LIMIT,
    cards: Array.from({ length: L.slots }, (_, i) => {
      const pos = i + 1, faceUp = s.revealed.includes(pos), pair = s.matches.find(p => p.includes(pos));
      return { pos, ID: faceUp ? s.hiddenDeck[i] : -1, isGet: Boolean(pair), otherPos: pair ? pair.find(p => p !== pos)! : 0 };
    }) };
}

/** JSON-safe public contract. The private save and unrevealed identities are excluded. */
export type PairNativeView = ReturnType<typeof viewPairNative>;
