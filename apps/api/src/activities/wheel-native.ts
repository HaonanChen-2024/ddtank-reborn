import { createHash } from "node:crypto";
import { PRIZES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityWallet } from "./types.js";

/** Explicit local economy; original tables prove the UI shape, not server odds or prices. */
export const wheelNativeLocalRules = Object.freeze({
  version: 1, startCost: 20, normalCost: 10, protectCost: 20, maxLevel: 7,
  successNumerator: 3, successDenominator: 5,
  maxRounds: 1_000_000_000, maxSpins: 1_000_000_000, maxFragments: 1_000_000_000,
  exchangeChipCost: 20, exchangeUnitCount: 1, exchangeMaxCount: 10,
  description: "本地规则：七级转盘与旧网页五星转盘分别存档，共用活动积分和每日500次新玩法上限。开局20积分、普通追加10积分、保护追加20积分，追加成功率60%，最高7级；普通失败下降1至2级并停止，保护失败保级继续。开局五类等概率，第五类再从四种普通材料等概率选一个，整轮分类与材料固定。0或1级可领20芯片，2至7级可选20×等级芯片或等级数量的本轮材料，必须明确二选一；芯片仅本活动记账，每20芯片可兑换任一四种普通材料×1，每次1至10份，永久绑定材料通过游戏邮件交付。原双轮与窗口保留；原概率、私服装备、高额芯片表、免费次数、扭扭币购买、商城161限购、付款、全服和跨服排行及排行奖未复刻。",
});
const L = wheelNativeLocalRules, LIMIT = 2_147_483_647;
type Clock = Pick<ActivityContext, "now">;
type Funds = Pick<ActivityWallet, "points">;
type Random = () => number;
type Phase = "idle" | "active" | "failed" | "settled";
export interface WheelPending {
  round: number; category: number; level: number; chipAmount: number;
  item: null | { templateId: number; itemCount: number };
}
/** New versioned slot. Never read, translate or write the existing games.wheel save. */
export interface WheelNativeState {
  version: 1; kind: "wheel-native"; rulesVersion: 1;
  round: number; spinCount: number; phase: Phase; level: number; category: number;
  materialIndex: number | null; fragments: number; pending: WheelPending | null;
}
export type WheelNativeEffect =
  | { type: "rotated"; action: "start" | "continue" | "protect"; round: number; spinCount: number;
      fromLevel: number; toLevel: number; category: number; templateId: number; success: boolean;
      protectedFailure: boolean; phase: "active" | "failed"; cost: number; score: number;
      pending: { chipAmount: number; item: WheelPending["item"] } }
  | { type: "chip-taken"; round: number; chipAmount: number; fragments: number }
  | { type: "item-taken"; round: number; templateId: number; itemCount: number }
  | { type: "exchanged"; index: number; count: number; chipsSpent: number; fragments: number; templateId: number; itemCount: number };
export interface WheelNativeResult {
  state: WheelNativeState; cost: number; rewards: ActivityReward[];
  effects: WheelNativeEffect[]; completed: boolean; message: string;
}
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new ActivityError(message); }
function int(value: unknown, min = 0, max = LIMIT): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function object(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && fields.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => fields.includes(key));
}
function dayOf(ctx: Clock) {
  need(ctx?.now instanceof Date && Number.isFinite(ctx.now.getTime()), "转盘日期无效。");
  return ctx.now.toISOString().slice(0, 10);
}
function balance(funds: Funds, cost = 0) {
  need(int(funds?.points) && int(cost) && funds.points >= cost, "活动积分不足或数值无效。");
  return funds.points - cost;
}
function randomIndex(length: number, rng: Random) {
  const value = rng(); need(Number.isFinite(value) && value >= 0 && value < 1, "转盘随机结果无效。");
  return Math.floor(value * length);
}
function success(rng: Random) {
  const value = rng(); need(Number.isFinite(value) && value >= 0 && value < 1, "转盘随机结果无效。");
  return value < L.successNumerator / L.successDenominator;
}
const empty = (): WheelNativeState => ({ version: 1, kind: "wheel-native", rulesVersion: 1,
  round: 0, spinCount: 0, phase: "idle", level: 0, category: 0, materialIndex: null, fragments: 0, pending: null });
function pendingOf(state: WheelNativeState): WheelPending {
  return { round: state.round, category: state.category, level: state.level, chipAmount: 20 * Math.max(state.level, 1),
    item: state.level > 1 ? { templateId: PRIZES[state.materialIndex!].templateId, itemCount: state.level } : null };
}
export function readWheelNativeState(value: unknown): WheelNativeState {
  if (value === undefined) return empty();
  need(object(value, ["version", "kind", "rulesVersion", "round", "spinCount", "phase", "level", "category", "materialIndex", "fragments", "pending"]),
    "原生转盘存档无效。");
  need(value.version === 1 && value.kind === "wheel-native" && value.rulesVersion === 1, "原生转盘存档版本不匹配。");
  need(int(value.round, 0, L.maxRounds) && int(value.spinCount, 0, L.maxSpins) && value.spinCount >= value.round
    && int(value.level, 0, L.maxLevel) && int(value.category, 0, 5) && int(value.fragments, 0, L.maxFragments)
    && typeof value.phase === "string" && ["idle", "active", "failed", "settled"].includes(value.phase), "转盘等级、轮次或芯片存档无效。");
  const idle = value.phase === "idle";
  need(idle ? value.round === 0 && value.spinCount === 0 && value.level === 0 && value.category === 0
    && value.materialIndex === null && value.fragments === 0 && value.pending === null
    : value.round > 0 && int(value.category, 1, 5) && int(value.materialIndex, 0, PRIZES.length - 1)
      && (value.category === 5 || value.materialIndex === value.category - 1), "转盘分类或固定材料存档无效。");
  need(value.phase !== "active" || value.level > 0, "可追加转盘等级无效。");
  need(value.phase !== "failed" || value.level <= 5, "停止追加转盘等级无效。");
  const state: WheelNativeState = { version: 1, kind: "wheel-native", rulesVersion: 1,
    round: value.round, spinCount: value.spinCount, phase: value.phase as Phase, level: value.level,
    category: value.category, materialIndex: value.materialIndex as number | null, fragments: value.fragments, pending: null };
  const minimumAdditions = state.phase === "failed" ? state.level + 1
    : state.phase === "settled" && state.level === 0 ? 1 : Math.max(0, state.level - 1);
  need(state.spinCount >= state.round + minimumAdditions, "转盘等级与实际追加次数不一致。");
  if (state.phase === "active" || state.phase === "failed") {
    const pending = value.pending, expected = pendingOf(state);
    need(object(pending, ["round", "category", "level", "chipAmount", "item"]) && pending.round === expected.round
      && pending.category === expected.category && pending.level === expected.level && pending.chipAmount === expected.chipAmount,
      "转盘待领取权益存档无效。");
    need(expected.item === null ? pending.item === null : object(pending.item, ["templateId", "itemCount"])
      && pending.item.templateId === expected.item.templateId && pending.item.itemCount === expected.item.itemCount,
      "转盘待领取材料存档无效。");
    state.pending = expected;
  } else need(value.pending === null, "已结算转盘不能保留待领取权益。");
  return state;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** State fingerprint, not a MAC: identity and atomic settlement remain owned by the service. */
function roundToken(state: WheelNativeState, ctx: Clock) {
  return `${dayOf(ctx)}:${createHash("sha256").update(canonical(state)).digest("base64url")}`;
}
function validAction(action: ActivityAction, state: WheelNativeState, ctx: Clock) {
  need(action && typeof action === "object" && !Array.isArray(action) && Object.hasOwn(action, "type") && typeof action.type === "string"
    && Object.hasOwn(action, "choice") && typeof action.choice === "string", "转盘操作或参数无效。");
  const fields: Record<string, string[]> = { start: [], continue: [], protect: [], "take-chip": [], "take-item": [], exchange: ["index", "count"] };
  need(Object.hasOwn(fields, action.type) && Object.keys(action).every(key => key === "type" || key === "choice" || fields[action.type].includes(key)),
    "转盘操作或参数无效。");
  need(action.choice === roundToken(state, ctx), "转盘轮次、芯片或权益已更新，请重新查看后确认。");
  if (action.type === "exchange") need(Object.hasOwn(action, "index") && int(action.index, 0, PRIZES.length - 1)
    && Object.hasOwn(action, "count") && int(action.count, 1, L.exchangeMaxCount), "芯片兑换配方或数量无效。");
}

/** Caller owns the shared wallet lock, UUID receipt, daily allowance and ordinary mail transaction. */
export function advanceWheelNative(value: unknown, action: ActivityAction, ctx: Clock, funds: Funds, rng: Random): WheelNativeResult {
  const state = readWheelNativeState(value); dayOf(ctx); balance(funds); validAction(action, state, ctx);
  const rewards: ActivityReward[] = [], effects: WheelNativeEffect[] = [];
  let cost = 0, completed = false, message = "转盘进度已保存。";
  if (["start", "continue", "protect"].includes(action.type)) {
    const fromLevel = action.type === "start" ? 0 : state.level;
    need(state.spinCount < L.maxSpins, "本地转盘次数已达上限，仍可结算或兑换已有权益。");
    let successful = true;
    if (action.type === "start") {
      need(state.phase === "idle" || state.phase === "settled", "请先明确领取本轮芯片或材料。");
      need(state.round < L.maxRounds, "本地转盘轮次已达上限。");
      cost = L.startCost; balance(funds, cost);
      state.category = randomIndex(5, rng) + 1;
      state.materialIndex = state.category === 5 ? randomIndex(PRIZES.length, rng) : state.category - 1;
      state.round++; state.level = 1; state.phase = "active"; state.pending = pendingOf(state);
      message = "转盘已开始，当前1级；本轮分类与材料已固定，可追加或领取20芯片。";
    } else {
      need(state.phase === "active" && state.level > 0 && state.level < L.maxLevel, "本轮不能再追加，请明确领取已有权益。");
      cost = action.type === "protect" ? L.protectCost : L.normalCost; balance(funds, cost);
      successful = success(rng);
      if (successful) { state.level++; state.pending = pendingOf(state); }
      else if (action.type === "continue") {
        state.level = Math.max(0, state.level - 1 - randomIndex(2, rng)); state.phase = "failed"; state.pending = pendingOf(state);
      }
      message = successful ? `追加成功，当前${state.level}级。` : action.type === "protect"
        ? `保护追加失败，保留${state.level}级，可继续追加或领取。`
        : `普通追加失败，降至${state.level}级，停止追加；仍可明确领取当前芯片或材料。`;
    }
    state.spinCount++;
    effects.push({ type: "rotated", action: action.type as "start" | "continue" | "protect", round: state.round,
      spinCount: state.spinCount, fromLevel, toLevel: state.level, category: state.category,
      templateId: PRIZES[state.materialIndex!].templateId, success: successful, protectedFailure: !successful && action.type === "protect",
      phase: state.phase as "active" | "failed", cost, score: balance(funds, cost),
      pending: { chipAmount: state.pending!.chipAmount, item: state.pending!.item && { ...state.pending!.item } } });
  } else if (action.type === "take-chip" || action.type === "take-item") {
    need((state.phase === "active" || state.phase === "failed") && state.pending, "本轮没有待领取权益。");
    if (action.type === "take-chip") {
      const chipAmount = state.pending.chipAmount;
      need(int(state.fragments + chipAmount, 0, L.maxFragments), "芯片余额已达上限，请先兑换已有芯片。");
      state.fragments += chipAmount;
      effects.push({ type: "chip-taken", round: state.round, chipAmount, fragments: state.fragments });
      message = `已明确领取${chipAmount}芯片，本轮材料权益同时结算；芯片可兑换普通材料邮件。`;
    } else {
      need(state.pending.item, "0级或1级只有芯片可领，请明确选择芯片。");
      const item = state.pending.item;
      rewards.push({ templateId: item.templateId, count: item.itemCount });
      effects.push({ type: "item-taken", round: state.round, ...item });
      message = `已明确领取本轮材料×${item.itemCount}，芯片权益同时结算；材料已寄往游戏邮箱。`;
    }
    state.phase = "settled"; state.pending = null; completed = true;
  } else {
    const chipsSpent = L.exchangeChipCost * action.count!;
    need(state.fragments >= chipsSpent, "本轮活动芯片不足。");
    const templateId = PRIZES[action.index!].templateId, itemCount = L.exchangeUnitCount * action.count!;
    state.fragments -= chipsSpent; rewards.push({ templateId, count: itemCount });
    effects.push({ type: "exchanged", index: action.index!, count: action.count!, chipsSpent, fragments: state.fragments, templateId, itemCount });
    message = `已用${chipsSpent}芯片兑换${PRIZES[action.index!].name}×${itemCount}，材料已寄往游戏邮箱。`;
  }
  return { state, cost, rewards, effects, completed, message };
}

/** Finished public state only. Viewing never starts, rerolls, purchases or claims. */
export function viewWheelNative(value: unknown, ctx: Clock, funds: Funds, actionsRemaining = true) {
  const state = readWheelNativeState(value), score = balance(funds), pending = state.pending;
  const canSpin = actionsRemaining && state.spinCount < L.maxSpins;
  const canAdd = canSpin && state.phase === "active" && state.level < L.maxLevel;
  return { version: 1 as const, kind: "wheel-native" as const, started: value !== undefined, day: dayOf(ctx),
    round: state.round, spinCount: state.spinCount, phase: state.phase, level: state.level, category: state.category,
    score, fragments: state.fragments, roundToken: roundToken(state, ctx), startCost: L.startCost,
    normalCost: L.normalCost, protectCost: L.protectCost, maxLevel: L.maxLevel,
    categories: [...PRIZES.map((prize, index) => ({ sourceOriginalIndex: index + 1, name: prize.name, templateIds: [prize.templateId] })),
      { sourceOriginalIndex: 5, name: "随机材料", templateIds: PRIZES.map(prize => prize.templateId) }],
    roundMaterial: state.materialIndex === null ? null : { templateId: PRIZES[state.materialIndex].templateId, name: PRIZES[state.materialIndex].name },
    pending: pending && { chipAmount: pending.chipAmount, item: pending.item && { ...pending.item } },
    canStart: canSpin && state.round < L.maxRounds && ["idle", "settled"].includes(state.phase) && score >= L.startCost,
    canContinue: canAdd && score >= L.normalCost, canProtect: canAdd && score >= L.protectCost,
    canTakeChip: !!pending && state.fragments + pending.chipAmount <= L.maxFragments,
    canTakeItem: !!pending?.item,
    exchange: PRIZES.map((prize, index) => ({ index, templateId: prize.templateId, chipCost: L.exchangeChipCost,
      itemCount: L.exchangeUnitCount, maxCount: L.exchangeMaxCount,
      affordableCount: Math.min(L.exchangeMaxCount, Math.floor(state.fragments / L.exchangeChipCost)), canExchange: state.fragments >= L.exchangeChipCost })),
    localRules: { version: L.version, description: L.description } };
}
export type WheelNativeView = ReturnType<typeof viewWheelNative>;
