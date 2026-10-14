import { createHash } from "node:crypto";
import { LOCAL_RULES as C, PRIZES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityWallet } from "./types.js";

/** The existing per-draw games.treasure save, shared by web and original window. */
export interface TreasureState {
  bag: ActivityReward[]; draws: number; score: number; fragments: number; pity: number; choices: string[]; claimed: number[];
}
type Clock = Pick<ActivityContext, "now">;
type Funds = Pick<ActivityWallet, "points">;
type Selection = { index: number; templateId: number; itemCount: number };
type PrizeRoll = (guaranteed: boolean, choices: string[]) => ActivityReward;
export const treasureNativeLocalRules = Object.freeze({ version: 1, normalCost: C.treasureCost, advancedCost: C.treasureCost * 2,
  bagCapacity: C.bagCapacity, recycleUnitPoints: 2, exchange: { fragmentCost: 10, templateId: 11021, itemCount: 2 },
  description: "本地规则：原窗口只开放强化石1级、朱雀石1级、强化石2级、朱雀石2级四类材料。普通每次30活动积分，按已选材料的55/25/15/5本地权重重新分配；高级每次60积分，须全选四类且数量翻倍。第10次固定强化石2级×2，高级×4，保底不受分类筛选限制。单次1至5次，连续按钮仅一次有限五次批量，不自动重复消费；积分寻宝按普通30积分计价，不兑换幸运彩石。暂存包与网页共用，按每抽一格，最多30格；点取整格或全部领取均寄永久绑定材料邮件。全部回收每个材料数量返2活动积分。10碎片兑换强化石2级×2，10/20/30进度各领一次普通材料，每日500次操作上限不影响分类和已有奖励结算。原14类奖池、券购买、礼金/点券付款、全服和跨服排行及排行奖未复刻。",
});
export type TreasureNativeEffect =
  | { type: "drawn"; mode: "normal" | "advanced"; count: number; cost: number; score: number; draws: number;
      rewards: (Selection & { sourceOriginalIndex: number })[] }
  | { type: "chosen"; index: number; selected: boolean }
  | { type: "taken"; itemCount: number; items: Selection[] }
  | { type: "recycled"; pointsAwarded: number; score: number; items: Selection[] }
  | { type: "exchanged"; fragmentsSpent: number; fragments: number; templateId: number; itemCount: number }
  | { type: "progress-claimed"; tier: number; templateId: number; itemCount: number };
export interface TreasureResult {
  state: TreasureState; pointsDelta: number; rewards: ActivityReward[]; completed: boolean; draws: number;
  effects: TreasureNativeEffect[]; message: string;
}
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new ActivityError(message); }
function int(value: unknown, min = 0, max = 2_147_483_647): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function dayOf(ctx: Clock) {
  need(ctx?.now instanceof Date && Number.isFinite(ctx.now.getTime()), "寻宝日期无效。");
  return ctx.now.toISOString().slice(0, 10);
}
function balance(funds: Funds, delta = 0) {
  need(int(funds?.points) && int(funds.points + delta), "活动积分不足或结算超过上限。"); return funds.points + delta;
}
const empty = (): TreasureState => ({ bag: [], draws: 0, score: 0, fragments: 0, pity: 0, choices: PRIZES.map(p => p.name), claimed: [] });
function material(reward: ActivityReward) {
  need(reward && typeof reward === "object" && !Array.isArray(reward) && PRIZES.some(p => p.templateId === reward.templateId)
    && int(reward.count, 1, 4) && (reward.templateId === 11021 ? [1, 2, 4] : [1, 2]).includes(reward.count)
    && (reward.validDays === undefined || reward.validDays === 0), "寻宝材料配方无效。");
  return { templateId: reward.templateId, count: reward.count, ...(reward.validDays === 0 ? { validDays: 0 } : {}) };
}
export function readTreasureState(value: unknown): TreasureState {
  if (value === undefined) return empty();
  need(value && typeof value === "object" && !Array.isArray(value), "寻宝存档无效。"); const state = value as TreasureState;
  need([state.draws, state.score, state.fragments].every(n => int(n, 0, 1_000_000_000)) && int(state.pity, 0, C.cavePity - 1)
    && Array.isArray(state.bag) && state.bag.length <= C.bagCapacity && Array.isArray(state.claimed) && state.claimed.length <= 3
    && state.claimed.every(tier => int(tier, 1, 3)) && new Set(state.claimed).size === state.claimed.length
    && Array.isArray(state.choices) && state.choices.length >= 1 && state.choices.length <= PRIZES.length
    && state.choices.every(name => PRIZES.some(p => p.name === name)) && new Set(state.choices).size === state.choices.length,
    "寻宝次数、背包或进度存档无效。");
  return { bag: Array.from(state.bag, material), draws: state.draws, score: state.score, fragments: state.fragments,
    pity: state.pity, choices: [...state.choices], claimed: [...state.claimed] };
}
function bagRows(state: Pick<TreasureState, "bag">) {
  return state.bag.map((item, index) => ({ index, templateId: item.templateId, itemCount: item.count, recycleUnitPoints: 2 as const }));
}
function bagToken(state: TreasureState, ctx: Clock) {
  return `${dayOf(ctx)}:${createHash("sha256").update(JSON.stringify(state)).digest("base64url")}`;
}
function validNativeAction(action: ActivityAction, state: TreasureState, ctx: Clock) {
  need(action && typeof action === "object" && !Array.isArray(action) && Object.hasOwn(action, "type")
    && Object.hasOwn(action, "choice") && typeof action.choice === "string", "寻宝操作或参数无效。");
  const fields: Record<string, string[]> = { draw: ["mode", "count"], choose: ["index", "marked"], take: ["index"], recycle: [], exchange: [], progress: ["tier"] };
  need(Object.hasOwn(fields, action.type) && Object.keys(action).every(key => key === "type" || key === "choice" || fields[action.type].includes(key)), "寻宝操作或参数无效。");
  need(action.choice === bagToken(state, ctx), "临时包、分类或日期已更新，请重新查看后再确认。");
  if (action.type === "draw") need(Object.hasOwn(action, "mode") && ["normal", "advanced"].includes(action.mode!)
    && Object.hasOwn(action, "count") && int(action.count, 1, 5), "寻宝模式或1至5次批量无效。");
  if (action.type === "choose") need(Object.hasOwn(action, "index") && int(action.index, 0, PRIZES.length - 1)
    && Object.hasOwn(action, "marked") && typeof action.marked === "boolean", "宝物分类无效。");
  if (action.type === "take" && Object.hasOwn(action, "index")) need(int(action.index, 0, state.bag.length - 1), "临时包格子无效。");
  if (action.type === "progress") need(Object.hasOwn(action, "tier") && int(action.tier, 1, 3), "寻宝奖励档位无效。");
}

/** One rule owner; caller owns the wallet lock, mail, receipt, daily limit and RNG. */
export function advanceTreasure(value: unknown, action: ActivityAction, ctx: Clock, funds: Funds, roll: PrizeRoll, native = false): TreasureResult {
  const state = readTreasureState(value); dayOf(ctx); balance(funds);
  if (native) validNativeAction(action, state, ctx);
  const effects: TreasureNativeEffect[] = [], rewards: ActivityReward[] = [];
  let pointsDelta = 0, completed = false, draws = 0, message = "活动进度已保存。";
  if (action.type === "draw") {
    const count = action.count ?? 1;
    need(int(count, 1, 5), "每次只能进行1至5次寻宝。");
    need(native || action.choice === undefined || ["normal", "advanced"].includes(action.choice), "寻宝模式无效。");
    const mode = (native ? action.mode : action.choice) === "advanced" ? "advanced" : "normal", advanced = mode === "advanced";
    need(!advanced || state.choices.length === PRIZES.length, "高级寻宝需选择4类宝物。");
    need(state.bag.length + count <= C.bagCapacity, "临时背包已满，请先领取或回收。");
    need(int(state.draws + count, 0, 1_000_000_000) && int(state.score + count * (advanced ? 2 : 1), 0, 1_000_000_000)
      && int(state.fragments + count, 0, 1_000_000_000), "寻宝进度已达上限。");
    pointsDelta = -C.treasureCost * (advanced ? 2 : 1) * count; const score = balance(funds, pointsDelta);
    const found: (Selection & { sourceOriginalIndex: number })[] = [];
    for (let i = 0; i < count; i++) {
      state.pity++; const guaranteed = state.pity >= C.cavePity;
      const result = material(roll(guaranteed, [...state.choices]));
      need(result.count === (guaranteed ? 2 : 1) && (!guaranteed || result.templateId === 11021)
        && (guaranteed || PRIZES.some(p => p.templateId === result.templateId && state.choices.includes(p.name))), "寻宝奖池配方无效。");
      const item = { ...result, count: result.count * (advanced ? 2 : 1) };
      if (guaranteed) state.pity = 0;
      found.push({ index: state.bag.length, sourceOriginalIndex: PRIZES.findIndex(p => p.templateId === item.templateId) + 1,
        templateId: item.templateId, itemCount: item.count });
      state.bag.push(item); state.draws++; state.score += advanced ? 2 : 1; state.fragments++;
    }
    if (native) effects.push({ type: "drawn", mode, count, cost: -pointsDelta, score, draws: state.draws, rewards: found });
    completed = true; draws = count; message = `完成${count}次迷宫寻宝，奖品留在临时背包。`;
  } else if (action.type === "take" || action.type === "recycle") {
    need(state.bag.length > 0, "临时背包为空。");
    const rows = bagRows(state), selections: Selection[] = native && action.type === "take" && action.index !== undefined
      ? [rows[action.index]] : rows;
    const itemCount = selections.reduce((count, item) => count + item.itemCount, 0);
    if (action.type === "take") {
      rewards.push(...selections.map(item => ({ ...state.bag[item.index] })));
      if (native) effects.push({ type: "taken", itemCount, items: selections.map(({ index, templateId, itemCount }) => ({ index, templateId, itemCount })) });
      message = native && action.index !== undefined ? "选中整格材料已寄往游戏邮箱，其余格子保留。" : "临时背包已全部寄往游戏邮箱。";
    } else {
      pointsDelta = itemCount * 2; const score = balance(funds, pointsDelta);
      if (native) effects.push({ type: "recycled", pointsAwarded: pointsDelta, score,
        items: selections.map(({ index, templateId, itemCount }) => ({ index, templateId, itemCount })) });
      message = `已回收临时背包，获得${pointsDelta}活动积分。`;
    }
    const removed = new Set(selections.map(item => item.index)); state.bag = state.bag.filter((_, index) => !removed.has(index));
  } else if (action.type === "exchange") {
    need(state.fragments >= 10, "需要10枚活动碎片。"); state.fragments -= 10; rewards.push({ templateId: 11021, count: 2 });
    if (native) effects.push({ type: "exchanged", fragmentsSpent: 10, fragments: state.fragments, templateId: 11021, itemCount: 2 });
    message = "10枚碎片已兑换，奖励已寄出。";
  } else if (action.type === "progress") {
    need(int(action.tier, 1, 3) && state.score >= action.tier * 10, "尚未达到该档寻宝进度。");
    need(!state.claimed.includes(action.tier), "这档进度奖励已经领取。"); state.claimed.push(action.tier); rewards.push({ templateId: 11019, count: action.tier * 2 });
    if (native) effects.push({ type: "progress-claimed", tier: action.tier, templateId: 11019, itemCount: action.tier * 2 });
  } else if (action.type === (native ? "choose" : "category")) {
    need(native || action.choice && PRIZES.some(p => p.name === action.choice), "宝物分类无效。");
    const name = native ? PRIZES[action.index!].name : action.choice!, selected = native ? action.marked! : !state.choices.includes(name);
    if (!selected) { need(!state.choices.includes(name) || state.choices.length > 1, "请至少保留一类宝物。"); state.choices = state.choices.filter(c => c !== name); }
    else if (!state.choices.includes(name)) state.choices.push(name);
    if (native) effects.push({ type: "chosen", index: action.index!, selected });
  } else throw new ActivityError("寻宝操作无效。");
  return { state, pointsDelta, rewards, completed, draws, effects, message };
}

export function viewTreasureNative(value: unknown, ctx: Clock, funds: Funds, actionsRemaining = true, history: string[] = []) {
  const state = readTreasureState(value), score = balance(funds), bag = bagRows(state);
  const drawChoices = (["normal", "advanced"] as const).flatMap(mode => [1, 2, 3, 4, 5].map(count => {
    const advanced = mode === "advanced", cost = C.treasureCost * (advanced ? 2 : 1) * count;
    return { mode, count, cost, canDraw: actionsRemaining && score >= cost && state.bag.length + count <= C.bagCapacity
      && (!advanced || state.choices.length === PRIZES.length) && state.draws + count <= 1_000_000_000
      && state.score + count * (advanced ? 2 : 1) <= 1_000_000_000 && state.fragments + count <= 1_000_000_000 };
  }));
  return { version: 1 as const, kind: "treasure-native" as const, started: value !== undefined, day: dayOf(ctx), score,
    normalCost: C.treasureCost, advancedCost: C.treasureCost * 2, bagCapacity: C.bagCapacity, bagSlotsUsed: state.bag.length, bagToken: bagToken(state, ctx),
    draws: state.draws, progressScore: state.score, fragments: state.fragments, pityRemaining: C.cavePity - state.pity,
    categories: PRIZES.map((item, index) => ({ index, sourceOriginalIndex: index + 1, templateId: item.templateId, name: item.name, selected: state.choices.includes(item.name) })),
    canDraw: drawChoices[0].canDraw, drawChoices, canTake: bag.length > 0,
    canRecycle: bag.length > 0 && score + bag.reduce((n, row) => n + row.itemCount * 2, 0) <= 2_147_483_647, bag,
    previewTemplateIds: PRIZES.map(item => item.templateId),
    exchange: { ...treasureNativeLocalRules.exchange, canExchange: state.fragments >= 10 },
    progress: [1, 2, 3].map(tier => ({ tier, target: tier * 10, templateId: 11019, itemCount: tier * 2,
      claimed: state.claimed.includes(tier), canClaim: state.score >= tier * 10 && !state.claimed.includes(tier) })),
    records: history.filter(text => text.includes(" 迷宫寻宝：") || text.includes(" 原生迷宫寻宝：")).slice(0, 20),
    localRules: { version: treasureNativeLocalRules.version, description: treasureNativeLocalRules.description } };
}
export type TreasureNativeView = ReturnType<typeof viewTreasureNative>;
