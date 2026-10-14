import { ActivityError, type ActivityAction, type ActivityButton, type ActivityCell, type ActivityView } from "./types.js";

/** Explicit local rules, not recovered reference-server odds or equipment values. */
export type ChanceGameId = "wheel" | "devil" | "ddplay" | "carnival";
export interface ChanceGameResult {
  state: unknown;
  cost: number;
  points: number;
  rewardUnits: number;
  completed: boolean;
  message: string;
}
export interface ChanceGameView {
  rules: string[];
  stats: ActivityView["stats"];
  actions: ActivityButton[];
  cells?: ActivityCell[];
  columns?: number;
}
interface WheelState { version: 1; kind: "wheel"; round: number; phase: "idle" | "active" | "failed" | "settled"; stars: number }
interface DevilState { version: 1; kind: "devil"; round: number; phase: "idle" | "active" | "settled"; multiplier: number; lastDie: number }
interface DDPlayState { version: 1; kind: "ddplay"; spins: number; faces: number[] }
interface CarnivalState { version: 1; kind: "carnival"; rolls: number; distance: number; pool: number }
type ChanceState = WheelState | DevilState | DDPlayState | CarnivalState;
type Random = () => number;
const LIMIT = 1_000_000_000;
const FACES = ["星星", "月亮", "铃铛", "宝石", "王冠", "太阳"];
const TRIPLES = [3, 3, 3, 5, 5, 10];
const CARNIVAL_CELLS = [
  { label: "起点", points: 0, share: 0 }, { label: "积分小礼", points: 2, share: 0 },
  { label: "幸运补给", points: 4, share: 0 }, { label: "惊喜份额", points: 0, share: 5 },
  { label: "积分小礼", points: 2, share: 0 }, { label: "参与补给", points: 6, share: 0 },
  { label: "旅程补给", points: 4, share: 0 }, { label: "幸运份额", points: 0, share: 20 },
  { label: "积分小礼", points: 2, share: 0 }, { label: "旅程补给", points: 6, share: 0 },
  { label: "积分小礼", points: 4, share: 0 }, { label: "至尊份额", points: 0, share: 50 },
] as const;

function fail(message: string): never { throw new ActivityError(message); }
function integer(value: unknown, min = 0, max = LIMIT): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function random(rng: Random) {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) fail("随机结果无效，请稍后重试。");
  return value;
}
function increment(value: number) {
  if (!integer(value + 1)) fail("本地活动次数已达上限。");
  return value + 1;
}
function result(state: ChanceState, cost: number, points: number, rewardUnits: number, completed: boolean, message: string): ChanceGameResult {
  return { state, cost, points, rewardUnits, completed, message };
}
function defaultState(id: ChanceGameId): ChanceState {
  switch (id) {
    case "wheel": return { version: 1, kind: id, round: 0, phase: "idle", stars: 0 };
    case "devil": return { version: 1, kind: id, round: 0, phase: "idle", multiplier: 0, lastDie: 0 };
    case "ddplay": return { version: 1, kind: id, spins: 0, faces: [] };
    case "carnival": return { version: 1, kind: id, rolls: 0, distance: 0, pool: 100 };
    default: return fail("不支持此活动。");
  }
}
/** Only server-persisted state is accepted. Construct fresh objects, including fresh arrays. */
function readState(id: ChanceGameId, value: unknown): ChanceState {
  const initial = defaultState(id);
  if (value === undefined) return initial;
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("活动状态无效。");
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || state.kind !== id) fail("活动状态版本或类型不匹配。");
  switch (id) {
    case "wheel": {
      const { round, phase, stars } = state;
      if (!integer(round) || !integer(stars, 0, 5) || typeof phase !== "string" || !["idle", "active", "failed", "settled"].includes(phase)
        || (phase === "idle" ? round !== 0 || stars !== 0 : round === 0)
        || (phase === "active" && stars === 0) || (phase === "failed" && stars === 5)) fail("转盘状态无效。");
      return { version: 1, kind: id, round, phase: phase as WheelState["phase"], stars };
    }
    case "devil": {
      const { round, phase, multiplier, lastDie } = state;
      if (!integer(round) || !integer(multiplier, 0, 12) || !integer(lastDie, 0, 6)
        || typeof phase !== "string" || !["idle", "active", "settled"].includes(phase)
        || (phase === "idle" ? round !== 0 || multiplier !== 0 || lastDie !== 0 : round === 0)
        || (phase === "active" && multiplier === 0)) fail("恶魔宝藏状态无效。");
      return { version: 1, kind: id, round, phase: phase as DevilState["phase"], multiplier, lastDie };
    }
    case "ddplay": {
      const { spins, faces } = state;
      if (!integer(spins) || !Array.isArray(faces) || faces.length !== (spins === 0 ? 0 : 3)
        || faces.some(face => !integer(face, 0, FACES.length - 1))) fail("弹弹乐状态无效。");
      return { version: 1, kind: id, spins, faces: [...faces] as number[] };
    }
    case "carnival": {
      const { rolls, distance, pool } = state;
      if (!integer(rolls) || !integer(distance) || !integer(pool) || distance < rolls || distance > rolls * 6
        || (rolls === 0 && (distance !== 0 || pool !== 100))) fail("节日狂欢状态无效。");
      return { version: 1, kind: id, rolls, distance, pool };
    }
  }
}
function multiplier(faces: number[]) {
  if (faces.length !== 3) return 0;
  const unique = new Set(faces).size;
  return unique === 1 ? TRIPLES[faces[0]] : unique === 2 ? 2 : 0;
}

/** Structured last result for the native window; never parse localized web labels. */
export function viewDDPlayOutcome(value: unknown) {
  const current = readState("ddplay", value) as DDPlayState;
  if (Array.from(current.faces).some(face => !integer(face, 0, FACES.length - 1))) fail("弹弹乐状态无效。");
  return { spins: current.spins, faces: [...current.faces], multiplier: multiplier(current.faces) };
}

/** Caller atomically checks funds/revision, persists state, and applies returned costs/rewards. */
export function advanceChanceGame(id: ChanceGameId, state: unknown, action: ActivityAction, rng: Random): ChanceGameResult {
  const current = readState(id, state);
  if (!action || typeof action !== "object" || typeof action.type !== "string") fail("活动操作无效。");
  if (current.kind === "wheel") {
    if (action.type === "start") {
      if (current.phase !== "idle" && current.phase !== "settled") fail("请先结算本轮转盘。");
      current.round = increment(current.round); current.phase = "active"; current.stars = 1;
      return result(current, 20, 0, 0, false, "转盘已开始，当前1星；可追加或直接领取。");
    }
    if (action.type === "take") {
      if (current.phase !== "active" && current.phase !== "failed") fail("本轮转盘没有可领取的奖励。");
      current.phase = "settled";
      return result(current, 0, 0, current.stars, true, `转盘已结算，领取${current.stars}份奖励。`);
    }
    if (action.type !== "continue" && action.type !== "protect") fail("转盘不支持此操作。");
    if (current.phase !== "active") fail("本轮已停止追加，请先领取结算。");
    if (current.stars >= 5) fail("已达到5星，请领取奖励。");
    const success = random(rng) < 0.6, protectedAttempt = action.type === "protect";
    if (success) current.stars++;
    else if (!protectedAttempt) { current.stars = Math.max(0, current.stars - (1 + Math.floor(random(rng) * 2))); current.phase = "failed"; }
    const message = success ? `追加成功，当前${current.stars}星。`
      : protectedAttempt ? `保护追加失败，保留${current.stars}星，可继续追加或领取。` : `普通追加失败，降至${current.stars}星，本轮停止追加，请结算。`;
    return result(current, protectedAttempt ? 20 : 10, 0, 0, false, message);
  }
  if (current.kind === "devil") {
    if (action.type === "start") {
      if (current.phase === "active") fail("请先领取或放弃本轮宝藏。");
      current.round = increment(current.round); current.phase = "active"; current.multiplier = 1; current.lastDie = 0;
      return result(current, 20, 0, 0, false, "探险已开始，当前1倍，可投骰或领取。");
    }
    if (!["continue", "take", "giveup"].includes(action.type)) fail("恶魔宝藏不支持此操作。");
    if (current.phase !== "active") fail("本轮宝藏已经结束或尚未开始。");
    if (action.type === "giveup") {
      current.phase = "settled"; current.multiplier = 0;
      return result(current, 0, 0, 0, true, "已放弃本轮宝藏，不发放奖励。");
    }
    if (action.type === "take") {
      current.phase = "settled";
      return result(current, 0, 0, current.multiplier, true, `已领取${current.multiplier}倍宝藏，共${current.multiplier}份奖励。`);
    }
    if (current.multiplier >= 12) fail("已达到12倍，请领取宝藏。");
    const die = 1 + Math.floor(random(rng) * 6);
    current.lastDie = die;
    if (die === 1) {
      current.multiplier = 0; current.phase = "settled";
      return result(current, 10, 0, 0, true, "掷出1点，本轮宝藏失去，探险结束。");
    }
    current.multiplier = Math.min(12, die === 6 ? current.multiplier * 2 : current.multiplier + die - 1);
    return result(current, 10, 0, 0, false, `掷出${die}点，宝藏累计至${current.multiplier}倍。`);
  }
  if (current.kind === "ddplay") {
    if (action.type !== "spin") fail("弹弹乐不支持此操作。");
    current.spins = increment(current.spins);
    current.faces = Array.from({ length: 3 }, () => Math.floor(random(rng) * FACES.length));
    const multiple = multiplier(current.faces), points = 10 * multiple;
    return result(current, 10, points, 0, true, `${current.faces.map(face => FACES[face]).join("、")}：${multiple}倍，获得${points}活动积分。`);
  }
  if (action.type !== "roll") fail("节日狂欢不支持此操作。");
  const die = 1 + Math.floor(random(rng) * 6), previousDistance = current.distance;
  current.rolls = increment(current.rolls);
  current.distance += die;
  current.pool += 5;
  if (!integer(current.distance) || !integer(current.pool)) fail("本地活动进度已达上限。");
  const cell = CARNIVAL_CELLS[current.distance % 12];
  const sharePoints = Math.floor(current.pool * cell.share / 100);
  current.pool -= sharePoints;
  const milestonePoints = current.rolls % 6 === 0 ? 5 : 0;
  const points = cell.points + sharePoints + milestonePoints;
  const rewardUnits = Math.floor(current.distance / 12) - Math.floor(previousDistance / 12);
  const detail = cell.share ? `领取本角色奖池的${cell.share}%份额（${sharePoints}积分）` : `获得${cell.points}积分`;
  return result(current, 10, points, rewardUnits, rewardUnits > 0,
    `掷出${die}点，到达${cell.label}，${detail}${milestonePoints ? "；参与满6次，另得5积分" : ""}${rewardUnits ? "；完成一圈，获得1份奖励" : ""}。`);
}

export function viewChanceGame(id: ChanceGameId, state: unknown): ChanceGameView {
  const current = readState(id, state);
  if (current.kind === "wheel") {
    const canStart = current.phase === "idle" || current.phase === "settled", canContinue = current.phase === "active" && current.stars < 5;
    return {
      rules: ["本地规则：开局20积分，从1星开始，最高5星。", "普通追加10积分，成功率60%；失败下降1–2星并停止追加，可领取剩余星级。",
        "保护追加20积分，成功率60%；失败保留星级，可继续。", "每星对应1份奖励，每轮只可结算一次。"],
      stats: [{ label: "轮次", value: current.round }, { label: "星级", value: current.stars },
        { label: "状态", value: { idle: "未开始", active: "可追加", failed: "等待结算", settled: "已结算" }[current.phase] }],
      actions: [{ label: "开始转盘 · 20积分", action: { type: "start" }, disabled: !canStart, help: "每轮开局消耗20活动积分" },
        { label: "普通追加", action: { type: "continue" }, disabled: !canContinue, help: "10积分" },
        { label: "保护追加", action: { type: "protect" }, disabled: !canContinue, help: "20积分" },
        { label: "领取结算", action: { type: "take" }, disabled: canStart }],
    };
  }
  if (current.kind === "devil") {
    const active = current.phase === "active";
    return {
      rules: ["本地规则：开局20积分，从1倍开始。每次投骰10积分，六个点数等概率。", "1点失去本轮宝藏；2–5点增加1–4倍；6点当前倍率翻倍，最高12倍。",
        "可随时领取当前倍率对应的奖励份数；领取后不可再投或再领。放弃不发奖励。"],
      stats: [{ label: "轮次", value: current.round }, { label: "当前倍率", value: current.multiplier },
        { label: "上次骰子", value: current.lastDie || "尚未投骰" }, { label: "状态", value: active ? "探险中" : current.phase === "idle" ? "未开始" : "已结束" }],
      actions: [{ label: "开始探险", action: { type: "start" }, disabled: active, help: "20积分" },
        { label: "继续投骰", action: { type: "continue" }, disabled: !active || current.multiplier >= 12, help: "10积分" },
        { label: "领取宝藏", action: { type: "take" }, disabled: !active }, { label: "放弃本轮", action: { type: "giveup" }, disabled: !active }],
    };
  }
  if (current.kind === "ddplay") return {
    rules: ["本地规则：每次10活动积分，三个位置各自从六种图案中等概率抽取。", "三种不同0倍，两种相同2倍；三个星星/月亮/铃铛3倍，三个宝石/王冠5倍，三个太阳10倍。",
      "所得积分=10×倍率；仅展示已经完成的一次结果，不预生成或暴露下一次结果。"],
    stats: [{ label: "参与次数", value: current.spins }, { label: "上次倍率", value: multiplier(current.faces) }],
    actions: [{ label: "转一次", action: { type: "spin" }, help: "10积分" }], columns: 3,
    cells: Array.from({ length: 3 }, (_, index) => ({ label: current.faces.length ? FACES[current.faces[index]] : "未转动", tone: current.faces.length ? "gold" : "hidden" })),
  };
  return {
    rules: ["本地规则：每次10积分，投1–6点等概率骰子，在12格环形盘上前进；累计每12格完成一圈，获得1份奖励。",
      "落点领取格子积分；每参与6次另获5积分。每次投骰给本角色奖池加入5积分，初始奖池100积分。",
      "5%/20%/50%是到达指定格后领取的奖池份额，向下取整，绝不是中奖概率；此奖池按角色独立记录。"],
    stats: [{ label: "当前位置", value: current.distance % 12 + 1 }, { label: "参与次数", value: current.rolls },
      { label: "累计步数", value: current.distance }, { label: "已完成圈数", value: Math.floor(current.distance / 12) },
      { label: "本角色奖池积分", value: current.pool }, { label: "下个参与里程", value: `${current.rolls % 6}/6` }],
    actions: [{ label: "投骰前进", action: { type: "roll" }, help: "10积分" }], columns: 4,
    cells: CARNIVAL_CELLS.map((cell, index) => ({ label: `${index + 1}. ${cell.label}`,
      detail: cell.share ? `奖池份额${cell.share}%` : `落点积分+${cell.points}`,
      tone: index === current.distance % 12 ? "success" : cell.share ? "gold" : "hidden" })),
  };
}
