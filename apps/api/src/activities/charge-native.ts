import { createHash } from "node:crypto";
import { LOCAL_RULES, PRIZES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityWallet } from "./types.js";

export type ChargePage = 0 | 1 | 2;
export type ChargeTier = 1 | 2 | 3;
export type ChargeMaterialId = 11019 | 11001 | 11021 | 11002;
export interface ChargeMaterialReward { templateId: ChargeMaterialId; count: number; validDays: 0; bound: true }
export type ChargeRewardSlots = [ChargeMaterialReward | null, ChargeMaterialReward | null, ChargeMaterialReward | null, ChargeMaterialReward | null];
export type ChargeMetric = "today-claimed-task-points" | "lifetime-task-earned" | "gross-spent-since-tracking";
export interface ChargeNativeTierView {
  tier: ChargeTier; title: string; claimKey: string; current: number; target: number; claimed: boolean; canClaim: boolean;
  rewards: ChargeRewardSlots; reason: string;
}
export interface ChargeNativePageView {
  index: ChargePage; originalRate: 1 | 2 | 4; title: string; metric: ChargeMetric; period: "utc-day" | "permanent";
  current: number; tiers: [ChargeNativeTierView, ChargeNativeTierView, ChargeNativeTierView]; description: string;
}
export interface ChargeNativeExchangeRow {
  index: number; catalogId: string; name: string; count: 1; reward: ChargeMaterialReward; unitPoints: number;
  qualification: { metric: "lifetime-task-earned"; current: number; target: number; met: boolean };
  period: "utc-day"; limit: 1 | 2 | 3; bought: number; remaining: number; canExchange: boolean; confirmRequired: true; reason: string;
}
export interface ChargeNativeView {
  version: 1; kind: "charge-native"; rulesVersion: 1; day: string; stateToken: string;
  currency: "local-task-points"; points: number; taskEarned: number; todayClaimedTaskPoints: number;
  grossSpent: number; grossCapped: boolean; trackingStartedAt: string | null;
  pages: [ChargeNativePageView, ChargeNativePageView, ChargeNativePageView];
  exchange: { catalogVersion: "charge-material-v1"; rows: ChargeNativeExchangeRow[]; description: string };
  rules: { source: "explicit-local-rules"; grossLimit: 2147483647; description: string[] };
  unavailable: { feature: "original-payment" | "original-rate4-rewards" | "original-item-exchange"; reason: string }[];
}
export type ChargeNativeEffect =
  | { type: "claimed"; index: ChargePage; tier: ChargeTier; claimKey: string; rewards: ChargeMaterialReward[] }
  | { type: "exchanged"; index: number; catalogId: string; count: 1; cost: number; points: number; rewards: ChargeMaterialReward[] };
/** Independent progress, never reconstructed from balance, truncated history or old receipts. */
export interface ChargeNativeState {
  version: 1; kind: "charge-native"; rulesVersion: 1; grossSpent: number; grossCapped: boolean; trackingStartedAt: string | null;
  day: string; catalogVersion: "charge-material-v1"; bought: [number, number, number, number, number, number, number];
}
const LIMIT = 2_147_483_647, CATALOG = "charge-material-v1" as const;
type Clock = Pick<ActivityContext, "now">;
type Funds = Pick<ActivityWallet, "points" | "earned">;
const targets = [[40, 100, 200], [100, 300, 600], [100, 300, 600]] as const;
const reward = (templateId: ChargeMaterialId, count: number): ChargeMaterialReward => ({ templateId, count, validDays: 0, bound: true });
const bundles: ChargeMaterialReward[][][] = [
  [[reward(11019, 1), reward(11001, 1), reward(11021, 1), reward(11002, 1)],
    [reward(11019, 2), reward(11001, 1), reward(11021, 1)], [reward(11019, 3), reward(11001, 2), reward(11002, 1)]],
  [[reward(11019, 3)], [reward(11019, 6)], [reward(11019, 9)]],
  [[reward(11019, 2), reward(11001, 1)], [reward(11019, 3), reward(11021, 1)], [reward(11019, 5), reward(11002, 1)]],
];
export const chargeNativeRecipes = [
  [11019, 3, 15, 0, 1], [11001, 3, 20, 0, 2], [11021, 1, 25, 100, 3], [11002, 1, 30, 100, 3],
  [11019, 6, 35, 300, 3], [11021, 2, 40, 300, 3], [11002, 2, 50, 600, 3],
].map(([templateId, count, unitPoints, qualification, limit], index) => Object.freeze({ index, catalogId: `charge-exchange:${index + 1}`,
  reward: reward(templateId as ChargeMaterialId, count), name: `${PRIZES.find(p => p.templateId === templateId)!.name}×${count}`,
  unitPoints, qualification, limit: limit as 1 | 2 | 3 }));
const descriptions = [
  "本地任务规则：今日已领取任务积分按签到40、扫雷60、翻牌60、寻宝40计算；仅已领取的UTC当日任务计入，最高200。每日档位40/100/200，奖励不扣积分。",
  "累计任务积分档位100/300/600，与旧积分礼包共用领取标记及强化石1级3/6/9份奖励，每角色每档只领一次；返还和回收不计任务积分。",
  "启用后累计消费仅记录本版本成功事务中实际扣除的活动积分，不减返还、不补算历史。档位100/300/600为本地规则；消费计量达到2147483647后饱和显示，不阻止原有操作。",
];
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new ActivityError(message); }
function int(n: unknown, min = 0, max = LIMIT): n is number { return typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max; }
function validDay(n: unknown): n is string {
  return typeof n === "string" && /^\d{4}-\d{2}-\d{2}$/.test(n) && Number.isFinite(new Date(n + "T00:00:00Z").getTime())
    && new Date(n + "T00:00:00Z").toISOString().slice(0, 10) === n;
}
function today(ctx: Clock) { need(ctx.now instanceof Date && Number.isFinite(ctx.now.getTime()), "任务活动日期无效。"); return ctx.now.toISOString().slice(0, 10); }
const empty = (day: string): ChargeNativeState => ({ version: 1, kind: "charge-native", rulesVersion: 1, grossSpent: 0, grossCapped: false,
  trackingStartedAt: null, day, catalogVersion: CATALOG, bought: [0, 0, 0, 0, 0, 0, 0] });
export function readChargeNativeState(value: unknown, ctx: Clock): ChargeNativeState {
  const day = today(ctx); if (value === undefined) return empty(day);
  need(value && typeof value === "object" && !Array.isArray(value), "任务活动存档无效。");
  const s = value as ChargeNativeState;
  need(s.version === 1 && s.kind === "charge-native" && s.rulesVersion === 1 && s.catalogVersion === CATALOG
    && validDay(s.day) && int(s.grossSpent) && typeof s.grossCapped === "boolean" && (!s.grossCapped || s.grossSpent === LIMIT)
    && (s.trackingStartedAt === null || typeof s.trackingStartedAt === "string" && Number.isFinite(new Date(s.trackingStartedAt).getTime())
      && new Date(s.trackingStartedAt).toISOString() === s.trackingStartedAt)
    && (s.grossSpent === 0 || s.trackingStartedAt !== null)
    && Array.isArray(s.bought) && s.bought.length === 7 && s.bought.every((n, i) => int(n, 0, chargeNativeRecipes[i].limit)), "任务活动进度或目录无效。");
  const next = structuredClone(s); if (next.day !== day) { next.day = day; next.bought = [0, 0, 0, 0, 0, 0, 0]; } return next;
}
/** Costs are explicit owner metadata. Saturation must never reject an otherwise valid legacy purchase. */
export function recordChargeNativeSpending(value: unknown, ctx: Clock, cost: number): ChargeNativeState {
  const s = readChargeNativeState(value, ctx);
  if (cost > 0) { s.trackingStartedAt ??= ctx.now.toISOString(); s.grossCapped ||= cost >= LIMIT - s.grossSpent; s.grossSpent = Math.min(LIMIT, s.grossSpent + cost); }
  return s;
}
export function chargeNativeTodayPoints(claims: string[], day: string) {
  return [["sign", 40], ["mines", 60], ["pair", 60], ["explore", 40]].reduce((sum, [id, points]) => sum + (claims.includes(`task:${day}:${id}`) ? Number(points) : 0), 0);
}
function key(index: ChargePage, tier: ChargeTier, day: string) {
  return index === 0 ? `charge-native:daily:${day}:${tier}` : index === 1 ? `points-gift:${tier}` : `charge-native:spent:${tier}`;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function fingerprint(s: ChargeNativeState, funds: Funds, claims: string[], remaining: number) {
  return `${s.day}.${createHash("sha256").update(canonical({ state: s, funds, claims: [...claims].sort(), remaining,
    targets, bundles, recipes: chargeNativeRecipes, descriptions, rulesVersion: 1 })).digest("base64url")}`;
}
export function viewChargeNative(value: unknown, ctx: Clock, funds: Funds, claims: string[], dailyActionsRemaining: number = LOCAL_RULES.maxDailyActions): ChargeNativeView {
  const s = readChargeNativeState(value, ctx);
  need(int(funds.points) && int(funds.earned) && int(dailyActionsRemaining, 0, LOCAL_RULES.maxDailyActions), "任务活动积分或次数无效。");
  const current = [chargeNativeTodayPoints(claims, s.day), funds.earned, s.grossSpent];
  const titles = ["今日任务礼", "累计任务礼", "累计消费礼"];
  const metrics: ChargeMetric[] = ["today-claimed-task-points", "lifetime-task-earned", "gross-spent-since-tracking"];
  const pages = targets.map((thresholds, page) => ({ index: page as ChargePage, originalRate: [1, 2, 4][page] as 1 | 2 | 4,
    title: titles[page], metric: metrics[page], period: page === 0 ? "utc-day" as const : "permanent" as const,
    current: current[page], description: descriptions[page], tiers: thresholds.map((target, i) => {
      const tier = (i + 1) as ChargeTier, claimKey = key(page as ChargePage, tier, s.day), claimed = claims.includes(claimKey);
      const items = bundles[page][i].map(r => ({ ...r }));
      return { tier, title: `${target}积分档`, claimKey, current: current[page], target, claimed, canClaim: !claimed && current[page] >= target,
        rewards: [...items, ...Array(4 - items.length).fill(null)] as ChargeRewardSlots,
        reason: claimed ? "本档奖励已经领取。" : current[page] < target ? `达到${target}后可领取。` : "已达标，可免费领取邮件奖励。" };
    }) as ChargeNativePageView["tiers"] })) as ChargeNativeView["pages"];
  return { version: 1, kind: "charge-native", rulesVersion: 1, day: s.day, stateToken: fingerprint(s, funds, claims, dailyActionsRemaining),
    currency: "local-task-points", points: funds.points, taskEarned: funds.earned, todayClaimedTaskPoints: current[0],
    grossSpent: s.grossSpent, grossCapped: s.grossCapped, trackingStartedAt: s.trackingStartedAt, pages,
    exchange: { catalogVersion: CATALOG, rows: chargeNativeRecipes.map(r => {
      const bought = s.bought[r.index], remaining = r.limit - bought, met = funds.earned >= r.qualification;
      return { index: r.index, catalogId: r.catalogId, name: r.name, count: 1, reward: { ...r.reward }, unitPoints: r.unitPoints,
        qualification: { metric: "lifetime-task-earned", current: funds.earned, target: r.qualification, met },
        period: "utc-day", limit: r.limit, bought, remaining, canExchange: remaining > 0 && met && funds.points >= r.unitPoints && dailyActionsRemaining > 0,
        confirmRequired: true, reason: remaining === 0 ? "本配方今日次数已用完。" : !met ? `累计任务积分达到${r.qualification}后解锁。`
          : funds.points < r.unitPoints ? "活动积分不足。" : dailyActionsRemaining === 0 ? "今日新玩法次数已用完，已得奖励仍可领取。" : "确认后扣积分并寄出普通材料。" };
    }), description: "本地普通材料兑换：每次固定一包；左侧为积分费用及累计任务资格，资格不扣除，不消耗原私服材料。UTC每天限购1/2/3/3/3/3/3次，兑换计一次共用新玩法次数。" },
    rules: { source: "explicit-local-rules", grossLimit: LIMIT, description: [...descriptions, "不接真实付款；保留原四页窗口，原私服装备属性和巨额奖励不导入。"] },
    unavailable: [{ feature: "original-payment", reason: "已以本地任务积分适配，不连接充值或支付。" },
      { feature: "original-rate4-rewards", reason: "原Rate4公开表无奖励行，当前三档为明示本地普通材料规则。" },
      { feature: "original-item-exchange", reason: "原双材料及装备配方不导入，当前七条使用本地积分及任务资格兑换普通材料。" }] };
}
/** Caller owns the wallet lock, canonical root claims, delivery and final receipt transaction. */
export function advanceChargeNative(value: unknown, action: ActivityAction, ctx: Clock, funds: Funds, claims: string[], dailyActionsRemaining: number = LOCAL_RULES.maxDailyActions) {
  const state = readChargeNativeState(value, ctx), view = viewChargeNative(value, ctx, funds, claims, dailyActionsRemaining);
  need(action && typeof action === "object" && !Array.isArray(action) && Object.hasOwn(action, "type") && ["claim", "exchange"].includes(action.type), "任务活动操作无效。");
  const fields = action.type === "claim" ? ["type", "index", "tier", "choice"] : ["type", "index", "count", "choice"];
  need(fields.every(k => Object.hasOwn(action, k)) && Object.keys(action).every(k => fields.includes(k)) && action.choice === view.stateToken,
    "任务活动记录、积分或目录已更新，请重新查看并确认。");
  let cost = 0, claimKey: string | undefined; const effects: ChargeNativeEffect[] = []; let rewards: ChargeMaterialReward[]; let message: string;
  if (action.type === "claim") {
    need(int(action.index, 0, 2) && int(action.tier, 1, 3), "任务礼包档位无效。");
    const row = view.pages[action.index].tiers[action.tier - 1]; need(row.canClaim, row.reason); claimKey = row.claimKey;
    rewards = row.rewards.filter((r): r is ChargeMaterialReward => r !== null); effects.push({ type: "claimed", index: action.index as ChargePage,
      tier: action.tier as ChargeTier, claimKey, rewards: rewards.map(r => ({ ...r })) }); message = "本地任务礼包已寄往游戏邮箱，同档不会重复领取。";
  } else {
    need(int(action.index, 0, 6) && action.count === 1, "材料兑换每次只能确认一包。");
    const row = view.exchange.rows[action.index]; need(row.canExchange, row.reason); cost = row.unitPoints; state.bought[action.index]++;
    rewards = [{ ...row.reward }]; effects.push({ type: "exchanged", index: action.index, catalogId: row.catalogId, count: 1, cost,
      points: funds.points - cost, rewards: rewards.map(r => ({ ...r })) }); message = "兑换已扣除本地积分，永久绑定普通材料已寄往游戏邮箱。";
  }
  return { state, cost, rewards, effects, claimKey, message };
}
