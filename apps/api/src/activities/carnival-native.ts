import { createHash } from "node:crypto";
import { LOCAL_RULES, PRIZES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityWallet } from "./types.js";

/** Original resources establish 12 slots and 7 recipes, never the private server's odds or economy. */
export const carnivalNativeLocalRules = Object.freeze({
  version: 1, drawCost: 10, maxBatchCount: 5, exchangeMaxCount: 10, maxDraws: 100_000_000,
  maxRedPackets: 300_000_000, recordLimit: 20, probabilityNumerator: 1, probabilityDenominator: 12,
  description: "本地规则：12格等概率，每次10活动积分，仅发永久绑定普通材料与本活动红包；材料直接寄往游戏邮箱。连续模式一次确认1至5次、一个请求编号，全部结果一次提交，停止或关闭不会撤销已提交奖励，动画不再次抽奖或发奖。每次抽奖计入共用每日500次新玩法上限；红包兑换不占新玩法次数，每次1至10份。活动积分由本地任务获得，红包仅在本活动记账；旧网页骰盘单独存档并共用积分钱包。个人记录仅显示本人最近20次，个人分数为累计抽奖次数。本地累计榜只显示真实角色已提交的狂欢次数，同分同名次，不发排行奖。原私服概率、装备、高额奖励、真实付款、全服奖池、私服及跨服排行奖励、轮次大奖及缺失的大奖直播原资源均未复刻。",
});
const L = carnivalNativeLocalRules, LIMIT = 2_147_483_647;
type Clock = Pick<ActivityContext, "now" | "carnivalNativeRanking">;
type Funds = Pick<ActivityWallet, "points">;
type Random = () => number;
export const carnivalNativePrizes = Object.freeze(Array.from({ length: 12 }, (_, index) => Object.freeze({
  id: index + 1, index, templateId: PRIZES[index % 4].templateId, name: PRIZES[index % 4].name,
  itemCount: Math.floor(index / 4) + 1, redPackets: Math.floor(index / 4) + 1,
})));
export const carnivalNativeRecipes = Object.freeze([
  { material: 0, itemCount: 5, redPacketsCost: 10 }, { material: 1, itemCount: 5, redPacketsCost: 10 },
  { material: 2, itemCount: 2, redPacketsCost: 10 }, { material: 3, itemCount: 2, redPacketsCost: 10 },
  { material: 0, itemCount: 10, redPacketsCost: 20 }, { material: 1, itemCount: 10, redPacketsCost: 20 },
  { material: 2, itemCount: 5, redPacketsCost: 20 },
].map((recipe, index) => Object.freeze({ id: index + 1, index, templateId: PRIZES[recipe.material].templateId,
  name: PRIZES[recipe.material].name, itemCount: recipe.itemCount, redPacketsCost: recipe.redPacketsCost })));
export interface CarnivalNativeRecord {
  drawId: number; prizeId: number; templateId: number; itemCount: number; redPackets: number; day: string;
}
export interface CarnivalNativeRanking {
  version: 1; kind: "carnival-native-ranking"; scope: "local"; metric: "cumulative-native-draws";
  entries: { rank: number; characterId: number; nickName: string; score: number }[];
  personalScore: number; personalRank: number | null;
}
/** Independent slot: never translate or modify the old games.carnival dice state. */
export interface CarnivalNativeState {
  version: 1; kind: "carnival-native"; rulesVersion: 1; drawCount: number;
  redPacketsEarned: number; redPacketsSpent: number; records: CarnivalNativeRecord[];
}
export type CarnivalNativeEffect =
  | { type: "drawn"; drawId: number; prizeId: number; index: number; templateId: number; itemCount: number;
      redPackets: number; redPackageCount: number; cost: number; score: number; batchIndex: number; batchCount: number }
  | { type: "exchanged"; index: number; catalogId: number; count: number; templateId: number; itemCount: number;
      redPacketsSpent: number; redPackageCount: number };
export interface CarnivalNativeResult {
  state: CarnivalNativeState; cost: number; draws: number; rewards: ActivityReward[];
  effects: CarnivalNativeEffect[]; message: string;
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
  need(ctx?.now instanceof Date && Number.isFinite(ctx.now.getTime()), "狂欢日期无效。");
  return ctx.now.toISOString().slice(0, 10);
}
function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = new Date(value + "T00:00:00Z");
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === value;
}
function balance(funds: Funds, cost = 0) {
  need(int(funds?.points) && int(cost) && funds.points >= cost, "活动积分不足或数值无效。");
  return funds.points - cost;
}
function allowance(value: number) { need(int(value, 0, LOCAL_RULES.maxDailyActions), "狂欢每日次数无效。"); return value; }
const empty = (): CarnivalNativeState => ({ version: 1, kind: "carnival-native", rulesVersion: 1,
  drawCount: 0, redPacketsEarned: 0, redPacketsSpent: 0, records: [] });
export function readCarnivalNativeState(value: unknown): CarnivalNativeState {
  if (value === undefined) return empty();
  need(object(value, ["version", "kind", "rulesVersion", "drawCount", "redPacketsEarned", "redPacketsSpent", "records"])
    && value.version === 1 && value.kind === "carnival-native" && value.rulesVersion === 1, "原生狂欢存档或版本无效。");
  need(int(value.drawCount, 0, L.maxDraws) && int(value.redPacketsEarned, value.drawCount, Math.min(L.maxRedPackets, value.drawCount * 3))
    && int(value.redPacketsSpent, 0, value.redPacketsEarned) && value.redPacketsSpent % 10 === 0, "狂欢次数或红包存档无效。");
  need(Array.isArray(value.records) && value.records.length === Math.min(value.drawCount, L.recordLimit), "狂欢个人记录存档无效。");
  const records = value.records.map((record: unknown, index: number): CarnivalNativeRecord => {
    need(object(record, ["drawId", "prizeId", "templateId", "itemCount", "redPackets", "day"])
      && record.drawId === (value.drawCount as number) - index && int(record.prizeId, 1, 12) && validDay(record.day), "狂欢个人记录序号或日期无效。");
    const prize = carnivalNativePrizes[(record.prizeId as number) - 1];
    need(record.templateId === prize.templateId && record.itemCount === prize.itemCount && record.redPackets === prize.redPackets,
      "狂欢个人记录奖励无效。");
    return { drawId: record.drawId as number, prizeId: prize.id, templateId: prize.templateId,
      itemCount: prize.itemCount, redPackets: prize.redPackets, day: record.day as string };
  });
  const recentPackets = records.reduce((sum, record) => sum + record.redPackets, 0), older = value.drawCount - records.length;
  need(value.redPacketsEarned >= recentPackets + older && value.redPacketsEarned <= recentPackets + older * 3,
    "狂欢红包与个人记录不一致。");
  return { version: 1, kind: "carnival-native", rulesVersion: 1, drawCount: value.drawCount,
    redPacketsEarned: value.redPacketsEarned, redPacketsSpent: value.redPacketsSpent, records };
}
/** Only a server-built public ranking is accepted. It never authorizes a draw or changes the action token. */
function viewRanking(value: unknown, personalScore: number): CarnivalNativeRanking | null {
  if (value === undefined || value === null) return null;
  need(object(value, ["version", "kind", "scope", "metric", "entries", "personalScore", "personalRank"])
    && value.version === 1 && value.kind === "carnival-native-ranking" && value.scope === "local"
    && value.metric === "cumulative-native-draws" && int(value.personalScore, 0, L.maxDraws), "狂欢榜单投影无效。");
  // The actor's save is authoritative; a concurrent query must not splice an older score into a newer view.
  if (value.personalScore !== personalScore) return null;
  need(value.personalScore === 0 ? value.personalRank === null : int(value.personalRank, 1), "狂欢本人名次无效。");
  need(Array.isArray(value.entries) && value.entries.length <= 10, "狂欢榜单条数无效。");
  const ids = new Set<number>(); let previous: CarnivalNativeRanking["entries"][number] | undefined;
  const entries = value.entries.map((entry: unknown, index: number): CarnivalNativeRanking["entries"][number] => {
    need(object(entry, ["rank", "characterId", "nickName", "score"]) && int(entry.rank, 1)
      && int(entry.characterId, 1) && int(entry.score, 1, L.maxDraws)
      && typeof entry.nickName === "string" && !!entry.nickName.trim() && entry.nickName.length <= 200,
    "狂欢榜单条目无效。");
    need(!ids.has(entry.characterId) && (!previous || previous.score > entry.score
      || previous.score === entry.score && previous.characterId < entry.characterId), "狂欢榜单角色或顺序无效。");
    need(entry.rank === (previous?.score === entry.score ? previous.rank : index + 1), "狂欢并列名次无效。");
    const row = { rank: entry.rank, characterId: entry.characterId, nickName: entry.nickName, score: entry.score };
    ids.add(row.characterId); previous = row; return row;
  });
  if (personalScore > 0) {
    need(entries.length > 0, "狂欢本人名次与榜单不符。");
    const above = entries.filter(row => row.score > personalScore).length;
    if (entries.length < 10 || personalScore >= entries.at(-1)!.score)
      need(entries.some(row => row.score === personalScore) && value.personalRank === above + 1, "狂欢本人名次与榜单不符。");
    else need((value.personalRank as number) > 10, "狂欢榜外名次无效。");
  }
  return { version: 1, kind: "carnival-native-ranking", scope: "local", metric: "cumulative-native-draws",
    entries, personalScore, personalRank: value.personalRank as number | null };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Full day + complete state/catalog fingerprint, not an authentication credential. */
function stateToken(state: CarnivalNativeState, ctx: Clock) {
  return `${dayOf(ctx)}:${createHash("sha256").update(canonical({ state, rules: L, prizes: carnivalNativePrizes, exchange: carnivalNativeRecipes })).digest("base64url")}`;
}
function validAction(action: ActivityAction, state: CarnivalNativeState, ctx: Clock) {
  need(action && typeof action === "object" && !Array.isArray(action) && Object.hasOwn(action, "type")
    && ["draw", "exchange"].includes(action.type) && Object.hasOwn(action, "choice") && typeof action.choice === "string",
    "狂欢操作或参数无效。");
  const fields = action.type === "draw" ? ["type", "choice", "count"] : ["type", "choice", "index", "count"];
  need(Object.keys(action).every(key => fields.includes(key)), "狂欢操作或参数无效。");
  need(action.choice === stateToken(state, ctx), "狂欢记录、红包或目录已更新，请重新查看后确认。");
  need(Object.hasOwn(action, "count") && int(action.count, 1, action.type === "draw" ? L.maxBatchCount : L.exchangeMaxCount), "狂欢数量无效。");
  if (action.type === "exchange") need(Object.hasOwn(action, "index") && int(action.index, 0, carnivalNativeRecipes.length - 1), "红包兑换配方无效。");
}
/** Caller owns wallet row lock, receipt and all ordinary mail delivery in one transaction. */
export function advanceCarnivalNative(value: unknown, action: ActivityAction, ctx: Clock, funds: Funds, rng: Random,
  dailyActionsRemaining: number = LOCAL_RULES.maxDailyActions): CarnivalNativeResult {
  const state = readCarnivalNativeState(value), today = dayOf(ctx); balance(funds); allowance(dailyActionsRemaining); validAction(action, state, ctx);
  const rewards: ActivityReward[] = [], effects: CarnivalNativeEffect[] = []; let cost = 0, draws = 0, message: string;
  if (action.type === "draw") {
    draws = action.count!; cost = L.drawCost * draws; balance(funds, cost);
    need(draws <= dailyActionsRemaining, "今日新玩法剩余次数不足，请减少连续次数，已有红包仍可兑换。");
    need(state.drawCount + draws <= L.maxDraws && state.redPacketsEarned + draws * 3 <= L.maxRedPackets,
      "本地狂欢次数或红包计数已达上限，已有红包仍可兑换。");
    for (let index = 0; index < draws; index++) {
      const random = rng(); need(Number.isFinite(random) && random >= 0 && random < 1, "狂欢随机结果无效。");
      const prize = carnivalNativePrizes[Math.floor(random * carnivalNativePrizes.length)];
      state.drawCount++; state.redPacketsEarned += prize.redPackets;
      state.records.unshift({ drawId: state.drawCount, prizeId: prize.id, templateId: prize.templateId,
        itemCount: prize.itemCount, redPackets: prize.redPackets, day: today });
      state.records = state.records.slice(0, L.recordLimit);
      const previous = rewards.find(reward => reward.templateId === prize.templateId);
      if (previous) previous.count += prize.itemCount; else rewards.push({ templateId: prize.templateId, count: prize.itemCount });
      effects.push({ type: "drawn", drawId: state.drawCount, prizeId: prize.id, index: prize.index,
        templateId: prize.templateId, itemCount: prize.itemCount, redPackets: prize.redPackets,
        redPackageCount: state.redPacketsEarned - state.redPacketsSpent, cost: L.drawCost,
        score: funds.points - L.drawCost * (index + 1), batchIndex: index, batchCount: draws });
    }
    message = `已完成${draws}次本地狂欢抽奖，普通材料已寄往游戏邮箱，红包已记账；动画不再次发奖。`;
  } else {
    const recipe = carnivalNativeRecipes[action.index!], spent = recipe.redPacketsCost * action.count!, itemCount = recipe.itemCount * action.count!;
    need(state.redPacketsEarned - state.redPacketsSpent >= spent, "本活动红包不足。");
    state.redPacketsSpent += spent; rewards.push({ templateId: recipe.templateId, count: itemCount });
    effects.push({ type: "exchanged", index: recipe.index, catalogId: recipe.id, count: action.count!, templateId: recipe.templateId,
      itemCount, redPacketsSpent: spent, redPackageCount: state.redPacketsEarned - state.redPacketsSpent });
    message = `已用${spent}红包兑换${recipe.name}×${itemCount}，材料已寄往游戏邮箱。`;
  }
  return { state, cost, draws, rewards, effects, message };
}
/** Committed public results only. GET never creates a save, draws, exchanges or grants mail. */
export function viewCarnivalNative(value: unknown, ctx: Clock, funds: Funds, dailyActionsRemaining: number = LOCAL_RULES.maxDailyActions) {
  const state = readCarnivalNativeState(value), score = balance(funds), today = dayOf(ctx), redPackageCount = state.redPacketsEarned - state.redPacketsSpent;
  const remainDrawCount = Math.max(0, Math.min(Math.floor(score / L.drawCost), allowance(dailyActionsRemaining),
    L.maxDraws - state.drawCount, Math.floor((L.maxRedPackets - state.redPacketsEarned) / 3)));
  return { version: 1 as const, kind: "carnival-native" as const, started: value !== undefined, day: today,
    stateToken: stateToken(state, ctx), activityState: 1, startDate: today + "T00:00:00.000Z",
    endDate: new Date(new Date(today + "T00:00:00Z").getTime() + 86_400_000).toISOString(),
    score, personalScore: state.drawCount, redPackageCount, remainDrawCount,
    maxBatchCount: Math.min(L.maxBatchCount, remainDrawCount), canDraw: remainDrawCount > 0,
    prizes: carnivalNativePrizes.map(prize => ({ ...prize })),
    exchange: carnivalNativeRecipes.map(recipe => ({ ...recipe, canExchange: redPackageCount >= recipe.redPacketsCost })),
    records: state.records.map(record => ({ ...record })), rules: { ...L },
    ranking: viewRanking(ctx.carnivalNativeRanking, state.drawCount),
    unavailable: ["全服奖池", "私服及跨服排行与排行奖", "轮次大奖", "大奖直播原窗口与动画", "真实付款"] };
}
export type CarnivalNativeView = ReturnType<typeof viewCarnivalNative>;
