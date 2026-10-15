import { createHash } from "node:crypto";
import { LOCAL_RULES as C, PRIZES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityWallet } from "./types.js";

/** The existing games.moon save; native selection never creates another bag or currency. */
export interface MoonlightState {
  bag: ActivityReward[]; draws: number; score: number; fragments: number; pity: number; choices: string[]; claimed: number[];
}
export interface MoonlightNativeRanking {
  version: 1; kind: "moonlight-native-ranking"; scope: "local"; metric: "cumulative-box-draws";
  entries: { rank: number; characterId: number; nickName: string; score: number }[];
  personalScore: number; personalRank: number | null;
}
type Clock = Pick<ActivityContext, "now">;
type Funds = Pick<ActivityWallet, "points">;
type Selection = { index: number; templateId: number; itemCount: number };
type PrizeRoll = (guaranteed: boolean) => ActivityReward;
const shopCatalog = Object.freeze({ version: 1 as const, kind: "moonlight-native-shop" as const, currency: "local-fragments" as const, maxCount: 10,
  entries: Object.freeze([
    Object.freeze({ index: 0, templateId: 11021, itemCount: 2, fragmentCost: 10, sourceGoodsId: 0 }),
    Object.freeze({ index: 1, templateId: 40002, itemCount: 1, fragmentCost: 5, sourceGoodsId: 160000024 }),
  ]) });
export const moonlightNativeLocalRules = Object.freeze({ version: 1, drawCost: C.moonCost, bagCapacity: C.bagCapacity,
  recycleUnitPoints: 2, exchange: { fragmentCost: 10, templateId: 11021, itemCount: 2, maxCount: 10 },
  description: "本地规则：原窗口三档分别开启1/3/5盒，每盒20活动积分，共20/60/100积分；四种普通材料按55/25/15/5本地权重抽取，第10次保底强化石2级×2。奖品先存共用临时包，最多30抽取记录；原窗口可勾选材料与数量取出邮件或回收，每个材料数量回收2积分。旧网页仍支持1至5次开启和全取/全回收。每包10碎片兑换强化石2级×2，原窗口每次可选1至10包；旧网页保留单包兑换。商店另售修炼药水2级×1，5碎片的价格参考私服公开商品160000024，使用本地原模板。商店1至10份为本地每次请求上限，原服个人限购未复刻；购买消耗本地每日玩法次数，已有碎片兑换保持原规则。修炼药水增加修炼经验，仍守现有等级、VIP和每日使用上限，不提升人物等级。10/20/30进度各领一次普通材料。本地榜按旧网页与原窗口共用的真实累计寻宝次数排名，显示前十及本人名次，同分并列，不发排名奖励。私服开盒档位、钥匙价、概率和原服排名及奖励未复刻，不产生钥匙货币或真实付款。",
});
export type MoonlightNativeEffect =
  | { type: "drawn"; count: number; cost: number; score: number; draws: number; rewards: { templateId: number; itemCount: number }[] }
  | { type: "taken"; itemCount: number; items: Selection[] }
  | { type: "recycled"; pointsAwarded: number; score: number; items: Selection[] }
  | { type: "exchanged"; count: number; fragmentsSpent: number; fragments: number; templateId: number; itemCount: number }
  | { type: "purchased"; index: number; count: number; templateId: number; itemCount: number; fragmentsSpent: number; fragments: number }
  | { type: "progress-claimed"; tier: number; templateId: number; itemCount: number };
export interface MoonlightResult {
  state: MoonlightState; pointsDelta: number; cost: number; rewards: ActivityReward[]; completed: boolean; draws: number;
  effects: MoonlightNativeEffect[]; message: string;
}
function fail(message: string): never { throw new ActivityError(message); }
function need(ok: unknown, message: string): asserts ok { if (!ok) fail(message); }
function int(value: unknown, min = 0, max = 2_147_483_647): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function dayOf(ctx: Clock) {
  need(ctx?.now instanceof Date && Number.isFinite(ctx.now.getTime()), "宝盒日期无效。");
  return ctx.now.toISOString().slice(0, 10);
}
function balance(funds: Funds, delta = 0) {
  need(int(funds?.points) && int(funds.points + delta), "活动积分不足或结算超过上限。"); return funds.points + delta;
}
const empty = (): MoonlightState => ({ bag: [], draws: 0, score: 0, fragments: 0, pity: 0, choices: PRIZES.map(p => p.name), claimed: [] });
function material(reward: ActivityReward) {
  need(reward && typeof reward === "object" && !Array.isArray(reward) && PRIZES.some(p => p.templateId === reward.templateId)
    && int(reward.count, 1, reward.templateId === 11021 ? 2 : 1) && (reward.validDays === undefined || reward.validDays === 0), "宝盒材料配方无效。");
  return { templateId: reward.templateId, count: reward.count, ...(reward.validDays === 0 ? { validDays: 0 } : {}) };
}
export function readMoonlightState(value: unknown): MoonlightState {
  if (value === undefined) return empty();
  need(value && typeof value === "object" && !Array.isArray(value), "宝盒存档无效。"); const state = value as MoonlightState;
  need([state.draws, state.score, state.fragments].every(n => int(n, 0, 1_000_000_000)) && int(state.pity, 0, C.moonPity - 1)
    && Array.isArray(state.bag) && state.bag.length <= C.bagCapacity && Array.isArray(state.claimed) && state.claimed.length <= 3
    && state.claimed.every(tier => int(tier, 1, 3)) && new Set(state.claimed).size === state.claimed.length
    && Array.isArray(state.choices) && state.choices.length >= 1 && state.choices.length <= PRIZES.length
    && state.choices.every(name => PRIZES.some(p => p.name === name)) && new Set(state.choices).size === state.choices.length, "宝盒次数、背包或进度存档无效。");
  return { bag: Array.from(state.bag, material), draws: state.draws, score: state.score, fragments: state.fragments,
    pity: state.pity, choices: [...state.choices], claimed: [...state.claimed] };
}
function bagRows(state: Pick<MoonlightState, "bag">) {
  const rows: { index: number; templateId: number; itemCount: number; recycleUnitPoints: 2 }[] = [];
  for (const item of state.bag) {
    const row = rows.find(row => row.templateId === item.templateId);
    if (row) row.itemCount += item.count;
    else rows.push({ index: rows.length, templateId: item.templateId, itemCount: item.count, recycleUnitPoints: 2 });
  }
  return rows;
}
function bagToken(state: MoonlightState, ctx: Clock) {
  return `${dayOf(ctx)}:${createHash("sha256").update(JSON.stringify(state)).digest("base64url")}`;
}
function shopToken(state: MoonlightState, ctx: Clock) {
  return `${dayOf(ctx)}:${createHash("sha256").update(JSON.stringify({ state, catalog: shopCatalog })).digest("base64url")}`;
}
function validNativeAction(action: ActivityAction, state: MoonlightState, ctx: Clock) {
  need(action && typeof action === "object" && !Array.isArray(action) && Object.hasOwn(action, "type")
    && Object.hasOwn(action, "choice") && typeof action.choice === "string", "宝盒操作或参数无效。");
  const fields: Record<string, string[]> = { draw: ["count"], take: ["items"], recycle: ["items"], exchange: ["count"], progress: ["tier"], buy: ["index", "count"] };
  need(Object.hasOwn(fields, action.type) && Object.keys(action).every(key => key === "type" || key === "choice" || fields[action.type].includes(key)), "宝盒操作或参数无效。");
  need(action.choice === (action.type === "buy" ? shopToken(state, ctx) : bagToken(state, ctx)), "临时包、商品或日期已更新，请重新查看后再确认。");
  if (action.type === "draw") need(Object.hasOwn(action, "count") && int(action.count, 1, 5) && [1, 3, 5].includes(action.count), "原窗口开盒档位只能是1、3或5。");
  if (action.type === "exchange" && Object.hasOwn(action, "count")) need(int(action.count, 1, moonlightNativeLocalRules.exchange.maxCount), "每次只能兑换1至10包。");
  if (action.type === "progress") need(Object.hasOwn(action, "tier") && int(action.tier, 1, 3), "宝盒奖励档位无效。");
  if (action.type === "buy") need(Object.hasOwn(action, "index") && int(action.index, 0, shopCatalog.entries.length - 1)
    && Object.hasOwn(action, "count") && int(action.count, 1, shopCatalog.maxCount), "商品索引或数量无效，每次只能购买1至10份。");
}
function select(state: MoonlightState, action: ActivityAction): Selection[] {
  const rows = bagRows(state), indexes = new Set<number>();
  need(Object.hasOwn(action, "items") && Array.isArray(action.items) && action.items.length >= 1 && action.items.length <= PRIZES.length, "请选择要结算的材料与数量。");
  return Array.from(action.items, item => {
    need(item && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item, "index") && Object.hasOwn(item, "count")
      && Object.keys(item).every(key => key === "index" || key === "count") && int(item.index, 0, rows.length - 1)
      && !indexes.has(item.index) && int(item.count, 1, rows[item.index].itemCount), "材料索引或数量无效，不能重复选择。");
    indexes.add(item.index); return { index: item.index, templateId: rows[item.index].templateId, itemCount: item.count };
  }).sort((a, b) => a.index - b.index);
}
function subtract(state: MoonlightState, selections: Selection[]) {
  const left = new Map(selections.map(item => [item.templateId, item.itemCount]));
  state.bag = state.bag.flatMap(item => {
    const used = Math.min(left.get(item.templateId) ?? 0, item.count); left.set(item.templateId, (left.get(item.templateId) ?? 0) - used);
    return used === item.count ? [] : [{ ...item, count: item.count - used }];
  });
}

/** One owner for old moon and original window. The caller owns wallet/receipt/mail transaction and RNG. */
export function advanceMoonlight(value: unknown, action: ActivityAction, ctx: Clock, funds: Funds, roll: PrizeRoll, native = false): MoonlightResult {
  const state = readMoonlightState(value); dayOf(ctx); balance(funds);
  if (native) validNativeAction(action, state, ctx);
  const effects: MoonlightNativeEffect[] = [], rewards: ActivityReward[] = [];
  let pointsDelta = 0, cost = 0, completed = false, draws = 0, message = "活动进度已保存。";
  if (action.type === "draw") {
    const count = action.count ?? 1;
    need(int(count, 1, 5), "每次只能进行1至5次寻宝。");
    need(native || action.choice === undefined || action.choice === "normal", "月光宝盒没有高级寻宝模式。");
    need(state.bag.length + count <= C.bagCapacity, "临时背包已满，请先领取或回收。");
    need([state.draws, state.score, state.fragments].every(n => int(n + count, 0, 1_000_000_000)), "宝盒进度已达上限。");
    cost = C.moonCost * count; pointsDelta = -cost; const score = balance(funds, pointsDelta), found: ActivityReward[] = [];
    for (let i = 0; i < count; i++) {
      state.pity++; const guaranteed = state.pity >= C.moonPity;
      const item = material(roll(guaranteed)); if (guaranteed) state.pity = 0;
      state.bag.push(item); found.push(item); state.draws++; state.score++; state.fragments++;
    }
    if (native) effects.push({ type: "drawn", count, cost: C.moonCost * count, score, draws: state.draws,
      rewards: bagRows({ bag: found }).map(item => ({ templateId: item.templateId, itemCount: item.itemCount })) });
    completed = true; draws = count; message = `完成${count}次月光宝盒，奖品留在临时背包。`;
  } else if (action.type === "take" || action.type === "recycle") {
    need(state.bag.length > 0, "临时背包为空。");
    const selections = native ? select(state, action) : bagRows(state).map(({ index, templateId, itemCount }) => ({ index, templateId, itemCount }));
    const itemCount = selections.reduce((count, item) => count + item.itemCount, 0);
    if (action.type === "take") {
      // Preserve legacy per-draw mail rewards; native sends one atomic selected material package.
      rewards.push(...(native ? selections.map(item => ({ templateId: item.templateId, count: item.itemCount })) : state.bag));
      if (native) effects.push({ type: "taken", itemCount, items: selections }); message = native ? "选中的材料已寄往游戏邮箱，剩余数量保留。" : "临时背包已全部寄往游戏邮箱。";
    } else {
      pointsDelta = itemCount * 2; const score = balance(funds, pointsDelta);
      if (native) effects.push({ type: "recycled", pointsAwarded: pointsDelta, score, items: selections }); message = `已回收${native ? "选中的材料" : "临时背包"}，获得${pointsDelta}活动积分。`;
    }
    subtract(state, selections);
  } else if (action.type === "buy") {
    need(native && int(action.index, 0, shopCatalog.entries.length - 1) && int(action.count, 1, shopCatalog.maxCount), "商品索引或数量无效。");
    const product = shopCatalog.entries[action.index], fragmentsSpent = action.count * product.fragmentCost, itemCount = action.count * product.itemCount;
    need(state.fragments >= fragmentsSpent, `需要${fragmentsSpent}枚活动碎片。`);
    state.fragments -= fragmentsSpent; rewards.push({ templateId: product.templateId, count: itemCount });
    effects.push({ type: "purchased", index: product.index, count: action.count, templateId: product.templateId, itemCount, fragmentsSpent, fragments: state.fragments });
    message = `${fragmentsSpent}枚碎片已购买${action.count}份商品，物品已寄往游戏邮箱。`;
  } else if (action.type === "exchange") {
    const count = native ? action.count ?? 1 : 1, fragmentsSpent = count * 10, itemCount = count * 2;
    need(state.fragments >= fragmentsSpent, `需要${fragmentsSpent}枚活动碎片。`);
    state.fragments -= fragmentsSpent; rewards.push({ templateId: 11021, count: itemCount });
    if (native) effects.push({ type: "exchanged", count, fragmentsSpent, fragments: state.fragments, templateId: 11021, itemCount });
    message = native ? `${fragmentsSpent}枚碎片已兑换${count}包，奖励已寄出。` : "10枚碎片已兑换，奖励已寄出。";
  } else if (action.type === "progress") {
    need(int(action.tier, 1, 3) && state.score >= action.tier * 10, "尚未达到该档寻宝进度。");
    need(!state.claimed.includes(action.tier), "这档进度奖励已经领取。"); state.claimed.push(action.tier); rewards.push({ templateId: 11019, count: action.tier * 2 });
    if (native) effects.push({ type: "progress-claimed", tier: action.tier, templateId: 11019, itemCount: action.tier * 2 });
  } else fail("寻宝操作无效。");
  return { state, pointsDelta, cost, rewards, completed, draws, effects, message };
}

export function viewMoonlightNative(value: unknown, ctx: Clock, funds: Funds, actionsRemaining = true) {
  const state = readMoonlightState(value), score = balance(funds), bag = bagRows(state);
  const drawChoices = [1, 3, 5].map(count => ({ count, cost: C.moonCost * count, canDraw: actionsRemaining && score >= C.moonCost * count
    && state.bag.length + count <= C.bagCapacity && [state.draws, state.score, state.fragments].every(n => n + count <= 1_000_000_000) }));
  return { version: 1 as const, kind: "moonlight-native" as const, started: value !== undefined, day: dayOf(ctx), score,
    drawCost: C.moonCost, bagCapacity: C.bagCapacity, bagSlotsUsed: state.bag.length, bagToken: bagToken(state, ctx),
    draws: state.draws, progressScore: state.score, fragments: state.fragments, pityRemaining: C.moonPity - state.pity,
    canDraw: drawChoices[0].canDraw, drawChoices,
    canTake: bag.length > 0, canRecycle: bag.length > 0 && score <= 2_147_483_645, bag,
    previewTemplateIds: PRIZES.map(item => item.templateId),
    // Complete GET/replay snapshots fill this after authentication, outside wallet transactions; fresh actions do not.
    ranking: null as MoonlightNativeRanking | null,
    shop: { ...shopCatalog, token: shopToken(state, ctx), entries: shopCatalog.entries.map(product => {
      const affordableCount = Math.min(shopCatalog.maxCount, Math.floor(state.fragments / product.fragmentCost));
      return { ...product, affordableCount, canBuy: actionsRemaining && affordableCount > 0 };
    }) },
    exchange: { ...moonlightNativeLocalRules.exchange, affordableCount: Math.min(moonlightNativeLocalRules.exchange.maxCount, Math.floor(state.fragments / 10)), canExchange: state.fragments >= 10 },
    progress: [1, 2, 3].map(tier => ({ tier, target: tier * 10, templateId: 11019, itemCount: tier * 2,
      claimed: state.claimed.includes(tier), canClaim: state.score >= tier * 10 && !state.claimed.includes(tier) })),
    localRules: { version: moonlightNativeLocalRules.version, description: moonlightNativeLocalRules.description } };
}
export type MoonlightNativeView = ReturnType<typeof viewMoonlightNative>;
