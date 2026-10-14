import { advanceChanceGame, viewDDPlayOutcome } from "./chance-games.js";
import { ActivityError, type ActivityAction, type ActivityReward, type ActivityWallet } from "./types.js";

/** The original three reels show the server multiplier; these odds and prices are local rules. */
export const ddplayNativeLocalRules = Object.freeze({ version: 1, spinCost: 10,
  exchange: Object.freeze({ cost: 10, maxCount: 10, templateId: 11019, itemCount: 1 }),
  description: "本地规则：每次10活动积分，共用旧弹弹乐三列六种等概率抽取及0/2/3/5/10倍结算；原窗口以三种啵咕展示已结算倍率。每10积分兑换强化石1级×1，每次1至10份，由游戏邮件交付。这些是本地规则，非参考服或官方赔率，不涉及付款。",
});
type Funds = Pick<ActivityWallet, "points">;
type Random = () => number;
type Reels = [number, number, number];
export type DDPlayNativeEffect =
  | { type: "spun"; multiplier: number; reels: Reels; pointsDelta: number; spins: number; score: number; cost: number; pointsAwarded: number }
  | { type: "exchanged"; count: number; cost: number; templateId: number; itemCount: number; score: number };
export interface DDPlayNativeResult {
  state: unknown; cost: number; points: number; rewards: ActivityReward[];
  effects: DDPlayNativeEffect[]; completed: boolean; message: string;
}
function fail(message: string): never { throw new ActivityError(message); }
function int(value: unknown, min = 0, max = 2_147_483_647): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function balance(funds: Funds, cost = 0) {
  if (!int(funds?.points) || !int(cost) || funds.points < cost) fail("活动积分不足或数值无效。");
  return funds.points;
}
function validAction(action: ActivityAction) {
  if (!action || typeof action !== "object" || Array.isArray(action) || !Object.hasOwn(action, "type")
    || !["spin", "exchange"].includes(action.type)
    || Object.keys(action).some(key => key !== "type" && (action.type !== "exchange" || key !== "count"))
    || action.type === "exchange" && (!Object.hasOwn(action, "count") || !int(action.count, 1, ddplayNativeLocalRules.exchange.maxCount))) fail("弹弹乐操作或参数无效。");
}
function lastResult(value: unknown) {
  const result = viewDDPlayOutcome(value);
  if (!result.spins) return null;
  let reels: Reels;
  if (result.multiplier === 3) reels = [1, 1, 1];
  else if (result.multiplier === 5) reels = [2, 2, 2];
  else if (result.multiplier === 10) reels = [3, 3, 3];
  else if (result.multiplier === 2) {
    const pairedFace = result.faces.find(face => result.faces.filter(other => other === face).length === 2)!;
    reels = result.faces.map(face => face === pairedFace ? 1 : 2) as Reels;
  } else reels = [1, 2, 3];
  return { multiplier: result.multiplier, reels };
}

/** Caller commits the shared save, point settlement, mail and UUID receipt together. */
export function advanceDDPlayNative(value: unknown, action: ActivityAction, funds: Funds, rng: Random): DDPlayNativeResult {
  validAction(action); balance(funds);
  // Validate the existing shared save before either action; never reinterpret localized labels.
  const previous = viewDDPlayOutcome(value);
  if (action.type === "spin") {
    balance(funds, ddplayNativeLocalRules.spinCost);
    const result = advanceChanceGame("ddplay", value, action, rng), outcome = viewDDPlayOutcome(result.state), show = lastResult(result.state)!;
    const score = funds.points - result.cost + result.points;
    if (!int(score)) fail("弹弹乐结算积分超过上限。");
    return { ...result, rewards: [], effects: [{ type: "spun", ...show, pointsDelta: result.points - result.cost,
      spins: outcome.spins, score, cost: result.cost, pointsAwarded: result.points }] };
  }
  const count = action.count!, prize = ddplayNativeLocalRules.exchange, cost = prize.cost * count, score = balance(funds, cost) - cost;
  return { state: { version: 1, kind: "ddplay", spins: previous.spins, faces: [...previous.faces] }, cost, points: 0,
    rewards: [{ templateId: prize.templateId, count: prize.itemCount * count }], completed: false,
    effects: [{ type: "exchanged", count, cost, templateId: prize.templateId, itemCount: prize.itemCount * count, score }],
    message: `已用${cost}本地活动积分兑换强化石1级×${count}，奖励已寄往游戏邮箱。` };
}

/** JSON-safe finished result only. GET does not spin, deduct points or generate a future result. */
export function viewDDPlayNative(value: unknown, funds: Funds, actionsRemaining = true) {
  const score = balance(funds), outcome = viewDDPlayOutcome(value), rules = ddplayNativeLocalRules;
  return { version: 1 as const, kind: "ddplay-native" as const, spins: outcome.spins, score, spinCost: rules.spinCost,
    exchange: { ...rules.exchange }, lastResult: lastResult(value),
    canSpin: actionsRemaining && outcome.spins < 1_000_000_000 && score >= rules.spinCost, canExchange: score >= rules.exchange.cost,
    localRules: { version: rules.version, description: rules.description } };
}
export type DDPlayNativeView = ReturnType<typeof viewDDPlayNative>;
