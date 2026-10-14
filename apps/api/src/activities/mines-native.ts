import { actMinesweeper, createMinesweeper, viewMinesweeper, type MinesweeperAction, type MinesweeperState } from "./minesweeper.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityWallet } from "./types.js";

/** Original board dimensions; all prices, limits, mine generation and rewards are explicit local rules. */
export const minesNativeLocalRules = Object.freeze({
  version: 1, width: 10, height: 7, mineCount: 10, lives: 3,
  maxRevivesPerRound: 1, freeResetsPerDay: 1, maxRoundsPerDay: 3, maxLifetimeRounds: 1001,
  probePointCost: 5, revivePointCost: 15, resetPointCost: 10,
  firstOpenSafe: true, probeRemovesMine: false, manualClaims: true,
  rewards: Object.freeze([
    Object.freeze({ tier: 1, requiredOpenCount: 10, templateId: 11019, count: 1 }),
    Object.freeze({ tier: 2, requiredOpenCount: 30, templateId: 11019, count: 2 }),
    Object.freeze({ tier: 3, requiredOpenCount: 60, templateId: 11019, count: 3 }),
  ]),
});
const L = minesNativeLocalRules;
const options = { width: L.width, height: L.height, mineCount: L.mineCount, lives: L.lives,
  maxRevives: L.maxRevivesPerRound, maxRestarts: L.maxLifetimeRounds - 1,
  rewardSteps: L.rewards.map(r => r.requiredOpenCount) };
type Clock = Pick<ActivityContext, "now">;
type Funds = Pick<ActivityWallet, "points">;
type Random = () => number;

/** Private, independently versioned save. Never convert or overwrite the older 36-cell game. */
export interface MinesNativeState {
  version: 1; kind: "mines-native"; rulesVersion: 1; day: string;
  board: MinesweeperState; claimed: number[]; freeResets: number; dailyRounds: number;
}
export type MinesNativeEffect =
  | { type: "started" | "round-completed"; round: number }
  | { type: "walked"; round: number; index: number; previousIndex: number | null; newlyOpened: boolean; aroundMineCount: number; openCount: number }
  | { type: "mine"; round: number; index: number; previousIndex: number | null; hp: number }
  | { type: "marked"; round: number; index: number; marked: boolean }
  | { type: "probed"; round: number; index: number }
  | { type: "revived"; round: number; hp: number }
  | { type: "reset"; round: number; mode: "free" | "points" }
  | { type: "claimed"; round: number; tier: number };
export interface MinesNativeResult {
  state: MinesNativeState; cost: number; rewards: ActivityReward[]; effects: MinesNativeEffect[];
  completed: boolean; message: string;
}
function fail(message: string): never { throw new ActivityError(message); }
function int(value: unknown, min = 0, max = 1_000_000_000): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function dayOf(ctx: Clock) {
  if (!(ctx?.now instanceof Date) || !Number.isFinite(ctx.now.getTime())) fail("活动日期无效。");
  return ctx.now.toISOString().slice(0, 10);
}
function list(value: unknown, max: number, limit: number): value is number[] {
  return Array.isArray(value) && value.length <= limit && Array.from(value).every(n => int(n, 0, max)) && new Set(value).size === value.length;
}
function readState(value: unknown): MinesNativeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("原生扫雷状态无效。");
  const s = value as MinesNativeState, b = s.board;
  if (s.version !== 1 || s.kind !== "mines-native" || s.rulesVersion !== 1) fail("原生扫雷状态版本不匹配，不能转换旧36格存档。");
  if (typeof s.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.day) || !Number.isFinite(Date.parse(s.day))
    || new Date(s.day).toISOString().slice(0, 10) !== s.day
    || !int(s.freeResets, 0, L.freeResetsPerDay) || !int(s.dailyRounds, 0, L.maxRoundsPerDay)) fail("扫雷日期或次数无效。");
  if (!b || typeof b !== "object" || Array.isArray(b) || b.version !== 1 || !b.options
    || Object.entries(options).some(([key, expected]) => key === "rewardSteps"
      ? !Array.isArray(b.options.rewardSteps) || b.options.rewardSteps.length !== options.rewardSteps.length
        || Array.from(b.options.rewardSteps).some((n, i) => n !== options.rewardSteps[i])
      : b.options[key as keyof typeof options] !== expected)
    || !int(b.round, 1, L.maxLifetimeRounds) || !int(b.restartsUsed, 0, L.maxLifetimeRounds - 1)
    || b.round !== b.restartsUsed + 1 || s.dailyRounds > b.round
    || !int(b.lives, 0, L.lives) || !int(b.revivesUsed, 0, L.maxRevivesPerRound)) fail("扫雷棋盘规则或轮次无效。");
  const size = L.width * L.height;
  if (!list(b.mines, size - 1, L.mineCount) || b.mines.length !== L.mineCount
    || !list(b.opened, size - 1, size) || !list(b.marked, size - 1, size) || !list(b.probed, size - 1, L.mineCount)
    || b.marked.some(i => b.opened.includes(i)) || b.probed.some(i => !b.mines.includes(i))
    || !list(b.rewardStepsReached, size, L.rewards.length) || !list(s.claimed, 3, 3) || s.claimed.includes(0)
    || (b.position !== null && (!int(b.position, 0, size - 1) || !b.opened.includes(b.position)))) fail("扫雷格子或领奖记录无效。");
  const safe = b.opened.filter(i => !b.mines.includes(i)).length;
  const reached = options.rewardSteps.filter(n => safe >= n);
  if (b.rewardStepsReached.length !== reached.length || b.rewardStepsReached.some((n, i) => n !== reached[i])
    || s.claimed.some(tier => safe < L.rewards[tier - 1].requiredOpenCount)
    || b.lives !== L.lives * (b.revivesUsed + 1) - b.opened.filter(i => b.mines.includes(i)).length
    || !["ready", "playing", "lost", "won"].includes(b.status)
    || (b.status === "ready" ? b.opened.length !== 0 || b.position !== null || b.lives !== L.lives || b.revivesUsed !== 0
      : b.opened.length === 0 || b.position === null)
    || (b.opened.length > 0 && b.mines.includes(b.opened[0]))
    || (b.lives === 0) !== (b.status === "lost")
    || (safe === size - L.mineCount) !== (b.status === "won")) fail("扫雷进度或生命记录不一致。");
  return { version: 1, kind: "mines-native", rulesVersion: 1, day: s.day,
    board: { ...b, options: { ...options, rewardSteps: [...options.rewardSteps] }, mines: [...b.mines], opened: [...b.opened],
      marked: [...b.marked], probed: [...b.probed], rewardStepsReached: [...b.rewardStepsReached] },
    claimed: [...s.claimed], freeResets: s.freeResets, dailyRounds: s.dailyRounds };
}
/** Project renewed daily allowances without mutating or resetting the persisted board. */
function currentState(value: unknown, ctx: Clock) {
  const s = readState(value), today = dayOf(ctx);
  if (today < s.day) fail("活动时间早于存档日期。");
  if (today !== s.day) { s.day = today; s.freeResets = L.freeResetsPerDay; s.dailyRounds = 0; }
  return s;
}
function fundsEnough(funds: Funds, cost: number) {
  if (!int(funds?.points, 0, 2_147_483_647) || !int(cost) || funds.points < cost) fail("活动积分不足。");
}
function validAction(action: ActivityAction) {
  const fields: Record<string, string[]> = { start: [], walk: ["index"], mark: ["index", "marked"], probe: [], revive: [], reset: ["choice"], claim: ["tier"] };
  if (!action || typeof action !== "object" || Array.isArray(action) || !Object.hasOwn(fields, action.type)
    || Object.keys(action).some(k => k !== "type" && !fields[action.type].includes(k))) fail("扫雷操作或参数无效。");
}
export function createMinesNative(ctx: Clock, rng: Random): MinesNativeState {
  return { version: 1, kind: "mines-native", rulesVersion: 1, day: dayOf(ctx),
    board: createMinesweeper(options, rng), claimed: [], freeResets: L.freeResetsPerDay, dailyRounds: 1 };
}

/** Caller owns the one transaction for this save, point charge, UUID receipt and reward mail. */
export function advanceMinesNative(value: unknown, action: ActivityAction, ctx: Clock, funds: Funds, rng: Random): MinesNativeResult {
  validAction(action); fundsEnough(funds, 0);
  if (action.type === "start") {
    if (value !== undefined) { readState(value); fail("扫雷已经开始，请继续当前一局。"); }
    const state = createMinesNative(ctx, rng);
    return { state, cost: 0, rewards: [], effects: [{ type: "started", round: 1 }], completed: false, message: "原生70格扫雷已开始；规则和奖励由本地服务提供。" };
  }
  const s = currentState(value, ctx), b = s.board, publicBoard = viewMinesweeper(b);
  const effects: MinesNativeEffect[] = [], rewards: ActivityReward[] = [];
  let cost = 0, completed = false, message = "扫雷进度已保存。";
  if (action.type === "claim") {
    if (!int(action.tier, 1, 3)) fail("领奖档位无效。");
    const prize = L.rewards[action.tier - 1];
    if (publicBoard.safeOpened < prize.requiredOpenCount || s.claimed.includes(action.tier)) fail("此档奖励尚未达成或已经领取。");
    s.claimed.push(action.tier); rewards.push({ templateId: prize.templateId, count: prize.count });
    effects.push({ type: "claimed", round: b.round, tier: action.tier }); completed = true;
    message = `第${action.tier}档奖励已通过游戏邮件发放；开格不会自动发相同奖励。`;
  } else if (action.type === "reset") {
    if (action.choice !== "free" && action.choice !== "points") fail("请明确选择免费重置或积分重置。");
    if (s.dailyRounds >= L.maxRoundsPerDay || b.round >= L.maxLifetimeRounds || b.status === "ready") fail("当前不能重置，或今日轮次已达上限。");
    if (L.rewards.some(p => publicBoard.safeOpened >= p.requiredOpenCount && !s.claimed.includes(p.tier))) fail("请先领取本轮已达成的奖励，再重置。");
    if (action.choice === "free" && s.freeResets === 0) fail("免费重置次数已用完；不会自动扣积分。");
    cost = action.choice === "points" ? L.resetPointCost : 0; fundsEnough(funds, cost);
    const result = actMinesweeper(b, { type: "restart" }, rng);
    if (!result.changed) fail("当前棋盘不能重置。");
    s.board = result.state; s.claimed = []; s.dailyRounds++;
    if (action.choice === "free") s.freeResets--;
    effects.push({ type: "reset", round: s.board.round, mode: action.choice }); message = "新一轮70格棋盘已保存。";
  } else if (action.type === "walk" && int(action.index, 0, 69) && b.opened.includes(action.index) && !b.mines.includes(action.index)) {
    if (b.status !== "playing" || b.position === action.index) fail("当前不能移动，或已经位于此格。");
    const previousIndex = b.position;
    s.board.position = action.index;
    effects.push({ type: "walked", round: b.round, index: action.index, previousIndex,
      newlyOpened: false, aroundMineCount: publicBoard.cells[action.index].adjacentMines!, openCount: publicBoard.safeOpened });
    message = "已移动到打开的安全格；不重复计数或发奖。";
  } else {
    if (action.type === "walk" && !int(action.index, 0, 69) || action.type === "mark" && (!int(action.index, 0, 69) || typeof action.marked !== "boolean")) fail("扫雷格子或标记状态无效。");
    const mapped = action.type === "walk" ? { type: "open", index: action.index } : action;
    const previousIndex = b.position;
    cost = action.type === "probe" ? L.probePointCost : action.type === "revive" ? L.revivePointCost : 0;
    fundsEnough(funds, cost);
    const result = actMinesweeper(b, mapped as MinesweeperAction, rng);
    if (!result.changed) fail("此格已处理，附近没有可探明地雷，或当前不能执行此操作。");
    s.board = result.state;
    for (const e of result.effects) {
      if (e.type === "opened") effects.push({ type: "walked", round: e.round, index: e.index, previousIndex, newlyOpened: true, aroundMineCount: e.adjacentMines, openCount: e.safeOpened });
      else if (e.type === "mine") effects.push({ type: "mine", round: e.round, index: e.index, previousIndex, hp: e.lives });
      else if (e.type === "marked" || e.type === "probed") effects.push(e);
      else if (e.type === "revived") effects.push({ type: "revived", round: e.round, hp: e.lives });
      else if (e.type === "won") effects.push({ type: "round-completed", round: e.round });
      // Reaching a milestone only enables manual claim; it never creates another reward owner.
    }
    if (action.type === "probe") message = "已探明附近一颗地雷，地雷仍在原位；这是本地规则。";
    else if (action.type === "revive") message = "已用活动积分复活，本局生命恢复。";
    else if (result.effects.some(e => e.type === "mine")) message = "踩到地雷，已扣除一条生命。";
  }
  return { state: readState(s), cost, rewards, effects, completed, message };
}

/** Closed unknown cells contain neither hidden mine identity nor an adjacent-mine count. */
export function viewMinesNative(value: unknown, ctx: Clock) {
  const localRules = { ...L, rewards: L.rewards.map(p => ({ ...p })), description: "本地规则：10列7行、10雷、3条生命，首开安全；复访安全格只移动，探雷只探明不移除。每日最多3局、1次免费重置，每局1次复活；10/30/60安全格三档手动领奖，通过游戏邮件发放。不代表官方或参考服的概率、价格、奖品或排名。" };
  if (value === undefined) { dayOf(ctx); return { started: false as const, localRules }; }
  const s = currentState(value, ctx), b = viewMinesweeper(s.board);
  const claims = L.rewards.map(p => ({ tier: p.tier, requiredOpenCount: p.requiredOpenCount,
    eligible: b.safeOpened >= p.requiredOpenCount, claimed: s.claimed.includes(p.tier), rewards: [{ templateId: p.templateId, count: p.count }] }));
  const canReset = b.status !== "ready" && s.dailyRounds < L.maxRoundsPerDay && b.round < L.maxLifetimeRounds && claims.every(p => !p.eligible || p.claimed);
  return { started: true as const, version: 1, kind: "mines-native", day: s.day, round: b.round,
    width: b.width, height: b.height, status: b.status, currentIndex: b.position, hp: b.lives, maxHp: b.maxLives,
    openCount: b.safeOpened, safeTotal: b.safeTotal, freeResetCount: s.freeResets, roundsRemaining: L.maxRoundsPerDay - s.dailyRounds,
    revivesRemaining: b.revivesRemaining, findMineTimes: s.board.probed.length,
    prices: { probe: L.probePointCost, revive: L.revivePointCost, reset: L.resetPointCost },
    canProbe: b.status === "playing" && b.position !== null, canRevive: b.status === "lost" && b.revivesRemaining > 0,
    canFreeReset: canReset && s.freeResets > 0, canPointsReset: canReset, claims,
    cells: b.cells.map(c => ({ index: c.index, opened: c.opened, marked: c.marked, probed: c.probed,
      ...(c.mine === undefined ? {} : { mine: c.mine }), ...(c.adjacentMines === undefined ? {} : { aroundMineCount: c.adjacentMines }) })), localRules };
}
export type MinesNativeView = ReturnType<typeof viewMinesNative>;
