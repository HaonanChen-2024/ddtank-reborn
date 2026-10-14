import { LOCAL_RULES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityWallet } from "./types.js";

/** Shared legacy save. Native refresh fills the original eight slots; legacy refresh still fills three. */
export interface GypsyState {
  day: string; refreshes: number;
  offers: { templateId: number; count: number; price: number; sold: boolean }[];
}
type Clock = Pick<ActivityContext, "now">;
type Funds = Pick<ActivityWallet, "points">;
type Random = () => number;
export const gypsyNativeLocalRules = Object.freeze({ version: 1, slots: 8, refreshPointCost: 5,
  description: "本地规则：每天首刷免费，再刷5活动积分；原窗口每轮8个报价，由四种普通材料配方各2份洗牌组成，每格限买一个报价包。旧网页刷新仍为3格，两入口共用当前货架和售罄存档；旧3格在原窗口留5个空格，只有明确刷新才替换为8格。顶部只预览本地普通材料，无稀有装备、保底或付款；价格与包数量由服务端配置，奖励通过游戏邮件交付。非参考服数值。",
});
export type GypsyNativeEffect =
  | { type: "refreshed"; shelfKey: string; offerCount: 8; cost: number; score: number; free: boolean }
  | { type: "bought"; shelfKey: string; index: number; templateId: number; itemCount: number; cost: number; score: number };
export interface GypsyResult {
  state: GypsyState; cost: number; rewards: ActivityReward[]; completed: boolean; message: string;
  effects: GypsyNativeEffect[];
}
function fail(message: string): never { throw new ActivityError(message); }
function int(value: unknown, min = 0, max = 2_147_483_647): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function dayOf(ctx: Clock) {
  if (!(ctx?.now instanceof Date) || !Number.isFinite(ctx.now.getTime())) fail("商店日期无效。");
  return ctx.now.toISOString().slice(0, 10);
}
function fundsEnough(funds: Funds, cost = 0) {
  if (!int(funds?.points) || !int(cost) || funds.points < cost) fail("活动积分不足，先完成上方本地任务。");
  return funds.points - cost;
}
export function readGypsyState(value: unknown): GypsyState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("商店存档无效。");
  const shop = value as GypsyState;
  if (typeof shop.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(shop.day) || !Number.isFinite(Date.parse(shop.day))
    || new Date(shop.day).toISOString().slice(0, 10) !== shop.day || !int(shop.refreshes, 1, 1_000_000_000)
    || !Array.isArray(shop.offers) || ![3, gypsyNativeLocalRules.slots].includes(shop.offers.length)) fail("商店日期、次数或货架无效。");
  const offers = Array.from(shop.offers, offer => {
    if (!offer || typeof offer !== "object" || Array.isArray(offer) || typeof offer.sold !== "boolean"
      || !LOCAL_RULES.shop.some(p => p.templateId === offer.templateId && p.count === offer.count && p.price === offer.price)) fail("商店报价配置无效。");
    return { templateId: offer.templateId, count: offer.count, price: offer.price, sold: offer.sold };
  });
  for (const prize of LOCAL_RULES.shop) {
    const count = offers.filter(offer => offer.templateId === prize.templateId).length;
    if (shop.offers.length === 3 ? count > 1 : count !== 2) fail("商店报价数量无效。");
  }
  return { day: shop.day, refreshes: shop.refreshes, offers };
}
const shelfKey = (shop: GypsyState) => `${shop.day}:${shop.refreshes}`;
function validNativeAction(action: ActivityAction) {
  if (!action || typeof action !== "object" || Array.isArray(action) || !Object.hasOwn(action, "type")) fail("商店操作或参数无效。");
  if (action.type === "refresh" && Object.hasOwn(action, "choice") && ["free", "points"].includes(action.choice!)
    && Object.keys(action).every(key => key === "type" || key === "choice")) return;
  if (action.type === "buy" && Object.hasOwn(action, "index") && int(action.index, 0, gypsyNativeLocalRules.slots - 1)
    && Object.hasOwn(action, "choice") && typeof action.choice === "string"
    && Object.keys(action).every(key => key === "type" || key === "index" || key === "choice")) return;
  fail("商店操作或参数无效。");
}

/** One owner for both entry points. Caller owns wallet, stock, UUID and ordinary mail transaction. */
export function advanceGypsy(value: unknown, action: ActivityAction, ctx: Clock, funds: Funds, rng: Random, native = false): GypsyResult {
  if (native) validNativeAction(action);
  const current = readGypsyState(value), today = dayOf(ctx); fundsEnough(funds);
  const effects: GypsyNativeEffect[] = [];
  if (action.type === "refresh") {
    const free = !current || current.day !== today, cost = free ? 0 : gypsyNativeLocalRules.refreshPointCost;
    if (native && action.choice !== (free ? "free" : "points")) fail("刷新费用已变化，请重新查看货架并确认；不会自动改为扣积分。");
    const score = fundsEnough(funds, cost), refreshes = free ? 1 : current!.refreshes + 1;
    if (!int(refreshes, 1, 1_000_000_000)) fail("商店刷新次数已达上限。");
    const picks = native ? [...LOCAL_RULES.shop, ...LOCAL_RULES.shop] : [...LOCAL_RULES.shop];
    for (let i = picks.length - 1; i > 0; i--) {
      const value = rng(); if (!Number.isFinite(value) || value < 0 || value >= 1) fail("随机源异常，请重试。");
      const j = Math.floor(value * (i + 1)); [picks[i], picks[j]] = [picks[j], picks[i]];
    }
    const state: GypsyState = { day: today, refreshes, offers: picks.slice(0, native ? gypsyNativeLocalRules.slots : 3).map(p => ({ ...p, sold: false })) };
    if (native) effects.push({ type: "refreshed", shelfKey: shelfKey(state), offerCount: 8, cost, score, free });
    return { state, cost, rewards: [], completed: false, effects, message: free ? "已使用今日免费刷新。" : "已花费5积分刷新货架。" };
  }
  if (action.type !== "buy") fail("商店操作无效。");
  if (!current || !int(action.index, 0, current.offers.length - 1)) fail("请先刷新货架。");
  if (native && action.choice !== shelfKey(current)) fail("货架已经更新，这个报价已过期，请重新选择商品。");
  const prize = current.offers[action.index]; if (prize.sold) fail("这件商品已售罄。");
  const score = fundsEnough(funds, prize.price); prize.sold = true;
  if (native) effects.push({ type: "bought", shelfKey: shelfKey(current), index: action.index,
    templateId: prize.templateId, itemCount: prize.count, cost: prize.price, score });
  return { state: current, cost: prize.price, rewards: [{ templateId: prize.templateId, count: prize.count }], completed: true, effects,
    message: "购买成功，商品已寄往邮箱。" };
}

/** Read-only, current batch only. No future shuffle or private root state is exposed. */
export function viewGypsyNative(value: unknown, ctx: Clock, funds: Funds, actionsRemaining = true) {
  const shop = readGypsyState(value), today = dayOf(ctx), score = fundsEnough(funds);
  const freeRefresh = !shop || shop.day !== today, refreshCost = freeRefresh ? 0 : gypsyNativeLocalRules.refreshPointCost;
  return { version: 1 as const, kind: "gypsy-native" as const, started: Boolean(shop), day: today, score,
    shelfKey: shop ? shelfKey(shop) : null, shelfDay: shop?.day ?? null, refreshes: shop?.refreshes ?? 0,
    slots: gypsyNativeLocalRules.slots, freeRefresh, refreshCost,
    canRefresh: actionsRemaining && score >= refreshCost && (freeRefresh || shop!.refreshes < 1_000_000_000),
    offers: shop?.offers.map((prize, index) => ({ index, templateId: prize.templateId, itemCount: prize.count, price: prize.price,
      sold: prize.sold, canBuy: actionsRemaining && !prize.sold && score >= prize.price })) ?? [],
    previewTemplateIds: LOCAL_RULES.shop.map(prize => prize.templateId),
    localRules: { version: gypsyNativeLocalRules.version, description: gypsyNativeLocalRules.description } };
}
export type GypsyNativeView = ReturnType<typeof viewGypsyNative>;
