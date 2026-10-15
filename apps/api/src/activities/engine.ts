import { randomInt } from "node:crypto";
import { advanceWardrobe, viewWardrobe } from "./wardrobe.js";
import { ACTIVITY_TITLES, LOCAL_RULES as C, PRIZES } from "./config.js";
import { actMinesweeper, createMinesweeper, viewMinesweeper, type MinesweeperAction, type MinesweeperState } from "./minesweeper.js";
import { actPairBox, createPairBox, viewPairBox, type PairBoxAction, type PairBoxState } from "./pair-box.js";
import { advancePairNative, viewPairNative } from "./pair-native.js";
import { advanceMinesNative, viewMinesNative } from "./mines-native.js";
import { advanceDDPlayNative, viewDDPlayNative } from "./ddplay-native.js";
import { advanceGypsy, viewGypsyNative, type GypsyState } from "./gypsy-native.js";
import { advanceMoonlight, viewMoonlightNative } from "./moonlight-native.js";
import { advanceTreasure, viewTreasureNative } from "./treasure-native.js";
import { advanceWheelNative, viewWheelNative } from "./wheel-native.js";
import { advanceCarnivalNative, viewCarnivalNative } from "./carnival-native.js";
import { advanceChanceGame, viewChanceGame } from "./chance-games.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivitySnapshot, type ActivityState, type ActivityTask, type ActivityTransition, type ActivityView, type ActivityWallet } from "./types.js";

const random = () => randomInt(0x100000000) / 0x100000000;
const day = (now: Date) => now.toISOString().slice(0, 10);
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new ActivityError(message); }
const integer = (n: unknown, min: number, max: number): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const reward = (count = 1): ActivityReward => ({ templateId: 11019, count });
function randomIndex(length: number, rng: () => number) {
  const n = rng(); need(Number.isFinite(n) && n >= 0 && n < 1, "随机源异常，请重试。");
  return Math.floor(n * length);
}
const chanceIds = ["wheel", "devil", "ddplay", "carnival"] as const;
type ChanceId = typeof chanceIds[number];
interface BagState { bag: ActivityReward[]; draws: number; score: number; fragments: number; pity: number; choices: string[]; claimed: number[] }
interface SnowState { cells: number[]; opened: number[]; found: number; expires: string; claimed: boolean; round: number }
function bagState(state: ActivityState, id: string): BagState {
  return (state.games[id] as BagState | undefined) ?? { bag: [], draws: 0, score: 0, fragments: 0, pity: 0, choices: PRIZES.map(p => p.name), claimed: [] };
}
function rollPrize(rng: () => number, guaranteed = false, choices?: string[]): ActivityReward {
  const n = rng(); need(Number.isFinite(n) && n >= 0 && n < 1, "随机源异常，请重试。");
  if (guaranteed) return { templateId: 11021, count: 2 };
  const pool = choices ? PRIZES.filter(p => choices.includes(p.name)) : [...PRIZES];
  need(pool.length > 0, "请先选择有效的宝物分类。");
  let sum = 0; const total = pool.reduce((v, p) => v + p.weight, 0);
  const p = pool.find(p => (sum += p.weight) > n * total)!;
  return { templateId: p.templateId, count: p.count };
}
function normalize(state: ActivityState, now: Date) {
  need(state.version === 1, "活动存档版本不兼容，请保留存档并联系维护者。");
  const next = structuredClone(state);
  if (next.day !== day(now)) { next.day = day(now); next.daily = {}; }
  return next;
}
export function createActivityState(now: Date): ActivityState {
  return { version: 1, day: day(now), daily: {}, games: {}, completed: {}, claims: [], history: [] };
}
function taskList(s: ActivityState, ctx: ActivityContext): ActivityTask[] {
  const entries = [
    { id: "sign", title: "完成今日签到", current: ctx.signDays.includes(s.day) ? 1 : 0, target: 1, points: 40 },
    { id: "mines", title: "扫雷翻开8个安全格", current: s.daily.safe ?? 0, target: 8, points: 60 },
    { id: "pair", title: "成功配对3组卡牌", current: s.daily.pairs ?? 0, target: 3, points: 60 },
    { id: "explore", title: "完成3次寻宝或开矿", current: s.daily.draws ?? 0, target: 3, points: 40 },
  ];
  return entries.map(t => ({ ...t, current: Math.min(t.current, t.target), claimed: s.claims.includes(`task:${s.day}:${t.id}`) }));
}

function countsDailyAction(id: string, type: string): boolean {
  // Navigation neither earns rewards nor advances a game. Keep this list explicit so
  // a future wardrobe/game action does not inherit an unlimited-play exemption.
  if (id === "wardrobe" && ["page", "select-set", "directory"].includes(type)) return false;
  if (id === "mines" && type === "mode" || id === "treasure" && type === "category" || id === "treasure-native" && type === "choose") return false;
  // Settle only previously earned entitlements, using the normal one-time/balance
  // checks below. In particular, bag exchange spends existing fragments, while
  // the separate points-funded exchange activity still counts as a play action.
  if (["treasure", "treasure-native", "moon", "moonlight-native", "cave"].includes(id) && ["take", "recycle", "progress", "exchange"].includes(type)) return false;
  if (["tasks", "first-gift", "points-gift", "luxury"].includes(id) && type === "claim") return false;
  if (["wheel", "devil", "christmas"].includes(id) && type === "take") return false;
  if (id === "devil" && type === "giveup") return false;
  if (id === "pair-native" && type === "exchange") return false;
  if (id === "ddplay-native" && type === "exchange") return false;
  if (id === "mines-native" && type === "claim") return false;
  if (id === "wheel-native" && ["take-chip", "take-item", "exchange"].includes(type)) return false;
  if (id === "carnival-native" && type === "exchange") return false;
  return true;
}

const hasCompletedBoard = (s: ActivityState) => (s.completed.mines ?? 0) + (s.completed.pair ?? 0) + (s.completed["pair-native"] ?? 0) + (s.completed["mines-native"] ?? 0) > 0;

/** All returned changes (including costs and rewards) must commit in one transaction. */
export function transitionActivity(input: ActivityState, id: string, action: ActivityAction, ctx: ActivityContext, wallet: ActivityWallet, rng = random): ActivityTransition {
  const s = normalize(input, ctx.now), rewards: ActivityReward[] = [];
  let pointsDelta = 0, earnedDelta = 0, message = "活动进度已保存。";
  let nativePairEffects: ActivityTransition["nativePairEffects"];
  let nativeMinesEffects: ActivityTransition["nativeMinesEffects"];
  let nativeDDPlayEffects: ActivityTransition["nativeDDPlayEffects"];
  let nativeGypsyEffects: ActivityTransition["nativeGypsyEffects"];
  let nativeMoonlightEffects: ActivityTransition["nativeMoonlightEffects"];
  let nativeTreasureEffects: ActivityTransition["nativeTreasureEffects"];
  let nativeWheelEffects: ActivityTransition["nativeWheelEffects"];
  let nativeCarnivalEffects: ActivityTransition["nativeCarnivalEffects"];
  const charge = (n: number) => { need(wallet.points + pointsDelta >= n, "活动积分不足，先完成上方本地任务。"); pointsDelta -= n; };
  const earn = (n: number, task = false) => { pointsDelta += n; if (task) earnedDelta += n; };
  const count = (key: string, n = 1) => { s.daily[key] = (s.daily[key] ?? 0) + n; };
  const done = () => { s.completed[id] = (s.completed[id] ?? 0) + 1; };
  const once = (key: string) => { need(!s.claims.includes(key), "这份奖励已经领取。"); s.claims.push(key); };
  need(action && typeof action.type === "string", "活动操作无效。");
  need(id === "tasks" || id === "pair-native" || id === "mines-native" || id === "ddplay-native" || id === "gypsy-native" || id === "moonlight-native" || id === "treasure-native" || id === "wheel-native" || id === "carnival-native" || Object.hasOwn(ACTIVITY_TITLES, id), "活动不存在。");
  const counted = countsDailyAction(id, action.type);
  let countedActions = counted ? 1 : 0;
  need(!counted || (s.daily.actions ?? 0) < C.maxDailyActions, "今日玩法次数已达上限，仍可浏览和领取已有奖励，明日可继续游玩。");

  if (id === "tasks") {
    need(action.type === "claim", "任务操作无效。");
    const task = taskList(s, ctx).find(t => t.id === action.choice);
    need(task && task.current >= task.target && !task.claimed, "任务尚未完成或已经领取。");
    once(`task:${s.day}:${task.id}`); earn(task.points, true); message = `任务完成，获得${task.points}活动积分。`;
  } else if (id === "pair-native") {
    const result = advancePairNative(s.games.pairNativeV1, action, ctx, wallet, rng);
    charge(result.cost); s.games.pairNativeV1 = result.state; rewards.push(...result.rewards);
    for (const effect of result.effects) if (effect.type === "matched") count("pairs");
    if (result.completed) done();
    nativePairEffects = result.effects; message = result.message;
  } else if (id === "mines-native") {
    const result = advanceMinesNative(s.games.minesNativeV1, action, ctx, wallet, rng);
    charge(result.cost); s.games.minesNativeV1 = result.state; rewards.push(...result.rewards);
    for (const effect of result.effects) if (effect.type === "walked" && effect.newlyOpened) count("safe");
    if (result.completed) done();
    nativeMinesEffects = result.effects; message = result.message;
  } else if (id === "ddplay-native") {
    const result = advanceDDPlayNative(s.games.ddplay, action, wallet, rng);
    charge(result.cost); earn(result.points); s.games.ddplay = result.state; rewards.push(...result.rewards);
    // Spin is the same completed play whether initiated by the existing web view or the native window.
    if (result.completed) s.completed.ddplay = (s.completed.ddplay ?? 0) + 1;
    nativeDDPlayEffects = result.effects; message = result.message;
  } else if (id === "mines" || id === "pair") {
    if (id === "mines" && action.type === "mode") {
      need(action.choice === "open" || action.choice === "mark", "扫雷操作模式无效。");
      s.games.minesMode = action.choice;
    } else if (action.type === "start" || action.type === "restart") {
      need((s.daily[`${id}:rounds`] ?? 0) < C.maxBoardRounds, "今日棋盘轮次已用完，明日可继续。");
      if (action.type === "start") {
        need(!s.games[id], "棋盘已经开始，请继续当前一局。");
        s.games[id] = id === "mines" ? createMinesweeper({ width: 6, height: 6, mineCount: 6, lives: 3, maxRestarts: 1000, rewardSteps: [8, 18, 30] }, rng)
          : createPairBox({ pairs: ["太阳", "月亮", "星星", "花朵", "宝石", "羽毛"], maxRestarts: 1000 }, rng);
        count(`${id}:rounds`); message = "新棋盘已保存，重新登录也可继续。";
      } else {
        need(s.games[id], "请先开始棋盘。");
        const result = id === "mines" ? actMinesweeper(s.games[id] as MinesweeperState, { type: "restart" }, rng)
          : actPairBox(s.games[id] as PairBoxState, { type: "restart" }, rng);
        need(result.changed, "当前棋盘还不能重开。"); s.games[id] = result.state; count(`${id}:rounds`);
      }
    } else if (id === "mines") {
      need(s.games[id], "请先开始扫雷。");
      const result = actMinesweeper(s.games[id] as MinesweeperState, action as MinesweeperAction, rng);
      need(result.changed, "此格已处理，或当前不能执行该操作。");
      if (action.type === "probe") charge(5);
      if (action.type === "revive") charge(15);
      s.games[id] = result.state;
      for (const e of result.effects) {
        if (e.type === "opened") count("safe");
        if (e.type === "milestone") { rewards.push(reward()); done(); }
      }
      message = result.effects.some(e => e.type === "mine") ? "踩到地雷，已扣除一条生命。" : "棋盘进度已保存。";
    } else {
      need(s.games[id], "请先开始翻牌。");
      const result = actPairBox(s.games[id] as PairBoxState, action as PairBoxAction, rng);
      need(result.changed, "此牌已处理，或请先合上未配对的卡牌。"); s.games[id] = result.state;
      for (const e of result.effects) {
        if (e.type === "matched") count("pairs");
        if (e.type === "won") { rewards.push(reward(3)); done(); message = "全部配对成功！奖励已寄往游戏邮箱。"; }
      }
    }
  } else if (id === "wheel-native") {
    const result = advanceWheelNative(s.games.wheelNativeV1, action, ctx, wallet, rng);
    charge(result.cost); s.games.wheelNativeV1 = result.state; rewards.push(...result.rewards);
    if (result.completed) done();
    nativeWheelEffects = result.effects; message = result.message;
  } else if (id === "carnival-native") {
    const result = advanceCarnivalNative(s.games.carnivalNativeV1, action, ctx, wallet, rng, Math.max(0, C.maxDailyActions - (s.daily.actions ?? 0)));
    charge(result.cost); s.games.carnivalNativeV1 = result.state; rewards.push(...result.rewards);
    countedActions = result.draws;
    if (result.draws) s.completed[id] = (s.completed[id] ?? 0) + result.draws;
    nativeCarnivalEffects = result.effects; message = result.message;
  } else if (chanceIds.includes(id as ChanceId)) {
    const result = advanceChanceGame(id as ChanceId, s.games[id], action, rng);
    charge(result.cost); earn(result.points); s.games[id] = result.state;
    if (result.rewardUnits > 0) rewards.push(reward(result.rewardUnits));
    if (result.completed) done(); message = result.message;
  } else if (id === "moon" || id === "moonlight-native") {
    const result = advanceMoonlight(s.games.moon, action, ctx, wallet, guaranteed => rollPrize(rng, guaranteed), id === "moonlight-native");
    s.games.moon = result.state; pointsDelta += result.pointsDelta; rewards.push(...result.rewards);
    if (result.completed) s.completed.moon = (s.completed.moon ?? 0) + 1;
    if (result.draws) count("draws", result.draws);
    if (id === "moonlight-native") nativeMoonlightEffects = result.effects;
    message = result.message;
  } else if (id === "treasure" || id === "treasure-native") {
    const result = advanceTreasure(s.games.treasure, action, ctx, wallet, (guaranteed, choices) => rollPrize(rng, guaranteed, choices), id === "treasure-native");
    s.games.treasure = result.state; pointsDelta += result.pointsDelta; rewards.push(...result.rewards);
    if (result.completed) s.completed.treasure = (s.completed.treasure ?? 0) + 1;
    if (result.draws) count("draws", result.draws);
    if (id === "treasure-native") nativeTreasureEffects = result.effects;
    message = result.message;
  } else if (id === "cave") {
    const b = bagState(s, id); s.games[id] = b;
    if (action.type === "draw") {
      const n = action.count ?? 1; need(integer(n, 1, 5), "每次只能进行1至5次寻宝。");
      need(b.bag.length + n <= C.bagCapacity, "临时背包已满，请先领取或回收。");
      need(action.choice === undefined || ["normal", "advanced"].includes(action.choice), "寻宝模式无效。");
      const advanced = action.choice === "advanced";
      for (let i = 0; i < n; i++) {
        const free = id === "cave" && !advanced && (s.daily["cave:free"] ?? 0) < C.caveDailyFree;
        if (free) count("cave:free");
        else charge(advanced ? C.caveAdvancedCost : C.caveCost);
        b.pity++; const pity = b.pity >= C.cavePity;
        const item = rollPrize(rng, pity); if (pity) b.pity = 0;
        if (advanced) item.count *= 2;
        b.bag.push(item); b.draws++; b.score += advanced ? 2 : 1; b.fragments++; count("draws");
      }
      done(); message = `完成${n}次${ACTIVITY_TITLES[id]}，奖品留在临时背包。`;
    } else if (action.type === "take" || action.type === "recycle") {
      need(b.bag.length > 0, "临时背包为空。");
      if (action.type === "take") { rewards.push(...b.bag); message = "临时背包已全部寄往游戏邮箱。"; }
      else { const n = b.bag.reduce((a, r) => a + r.count * 2, 0); earn(n); message = `已回收临时背包，获得${n}活动积分。`; }
      b.bag = [];
    } else if (action.type === "exchange") {
      need(b.fragments >= 10, "需要10枚活动碎片。"); b.fragments -= 10; rewards.push({ templateId: 11021, count: 2 }); message = "10枚碎片已兑换，奖励已寄出。";
    } else if (action.type === "progress") {
      need(integer(action.tier, 1, 3) && b.score >= action.tier * 10, "尚未达到该档寻宝进度。");
      need(!b.claimed.includes(action.tier), "这档进度奖励已经领取。"); b.claimed.push(action.tier); rewards.push(reward(action.tier * 2));
    } else throw new ActivityError("寻宝操作无效。");
  } else if (id === "gypsy" || id === "gypsy-native") {
    const result = advanceGypsy(s.games.gypsy, action, ctx, wallet, rng, id === "gypsy-native");
    charge(result.cost); s.games.gypsy = result.state; rewards.push(...result.rewards);
    if (result.completed) s.completed.gypsy = (s.completed.gypsy ?? 0) + 1;
    if (id === "gypsy-native") nativeGypsyEffects = result.effects;
    message = result.message;
  } else if (id === "exchange") {
    need(action.type === "exchange" && integer(action.index, 0, C.shop.length - 1), "兑换配方无效。");
    const p = C.shop[action.index]; need((s.daily[`exchange:${action.index}`] ?? 0) < 3, "此配方今日已兑换3次。");
    charge(p.price); rewards.push({ templateId: p.templateId, count: p.count }); count(`exchange:${action.index}`); done(); message = "兑换成功，材料已寄往游戏邮箱。";
  } else if (id === "wardrobe") {
    s.games.wardrobe = advanceWardrobe(s.games.wardrobe, action);
  } else if (id === "points-gift" || id === "luxury" || id === "first-gift") {
    need(action.type === "claim", "领奖操作无效。");
    if (id === "first-gift") {
      need(hasCompletedBoard(s), "完成一次扫雷阶段奖励或整局配对后解锁。");
      once(id); rewards.push(reward(5), { templateId: 11021, count: 1 });
    } else {
      const tiers = id === "points-gift" ? C.pointsGift : C.luxuryGift;
      need(integer(action.tier, 1, 3), "奖励档位无效。"); const target = tiers[action.tier - 1];
      need(wallet.earned >= target, `累计任务积分达到${target}后解锁。`);
      once(`${id}:${action.tier}`); rewards.push(reward(action.tier * (id === "luxury" ? 5 : 3)));
    }
    message = "奖励已领取并寄往游戏邮箱，无需付款。";
  } else if (id === "christmas") {
    let snow = s.games.christmas as SnowState | undefined;
    if (action.type === "start") {
      need(!snow || snow.claimed || ctx.now >= new Date(snow.expires), "请先完成当前雪地。");
      need(!snow || snow.claimed || snow.found === 0, "上一轮仍有奖励，请先领取后再开始。");
      need((s.daily["snow:rounds"] ?? 0) < 3, "今日雪地轮次已用完。");
      if ((s.daily["snow:rounds"] ?? 0) > 0) charge(20);
      const cells = Array.from({ length: 16 }, (_, i) => i);
      for (let i = cells.length - 1; i > 0; i--) { const j = randomIndex(i + 1, rng); [cells[i], cells[j]] = [cells[j], cells[i]]; }
      snow = { cells: cells.slice(0, 3), opened: [], found: 0, expires: new Date(ctx.now.getTime() + 30 * 60_000).toISOString(), claimed: false, round: (snow?.round ?? 0) + 1 };
      s.games.christmas = snow; count("snow:rounds"); message = "开始30分钟雪地探索，寻找3个雪人。";
    } else {
      need(snow && !snow.claimed, "请先开始雪地探索。");
      if (action.type === "open") {
        need(ctx.now < new Date(snow.expires), "本轮时间已结束，请领取已有奖励后重新开始。");
        need(integer(action.index, 0, 15) && !snow.opened.includes(action.index), "这个雪块已打开或不存在。");
        snow.opened.push(action.index); if (snow.cells.includes(action.index)) snow.found++;
        message = snow.cells.includes(action.index) ? "找到一位雪人！" : "这个雪块下没有雪人，再试一处。";
      } else if (action.type === "take") {
        need(snow.found > 0, "至少找到一个雪人才能领取奖励。"); snow.claimed = true; rewards.push(reward(snow.found)); done();
        message = `完成雪地探索，${snow.found}份奖励已寄往邮箱。`;
      } else if (action.type === "extend") {
        need(ctx.now < new Date(snow.expires), "本轮已过期。"); charge(20); snow.expires = new Date(new Date(snow.expires).getTime() + 30 * 60_000).toISOString();
      } else throw new ActivityError("雪地操作无效。");
    }
  } else throw new ActivityError("请通过游戏内原签到窗口签到，活动中心会同步已保存的进度。");
  if (countedActions) count("actions", countedActions);
  s.history = [`${ctx.now.toISOString()} ${id === "pair-native" ? "原生欧皇秘宝" : id === "mines-native" ? "原生弹弹扫雷" : id === "ddplay-native" ? "原生弹弹乐" : id === "gypsy-native" ? "原生吉普赛商人" : id === "moonlight-native" ? "原生月光宝盒" : id === "treasure-native" ? "原生迷宫寻宝" : id === "wheel-native" ? "原生啵咕大转盘" : id === "carnival-native" ? "原生节日狂欢" : ACTIVITY_TITLES[id] ?? "本地任务"}：${message}`, ...s.history].slice(0, 20);
  return { state: s, pointsDelta, earnedDelta, rewards, message, ...(nativePairEffects ? { nativePairEffects } : {}), ...(nativeMinesEffects ? { nativeMinesEffects } : {}), ...(nativeDDPlayEffects ? { nativeDDPlayEffects } : {}), ...(nativeGypsyEffects ? { nativeGypsyEffects } : {}), ...(nativeMoonlightEffects ? { nativeMoonlightEffects } : {}), ...(nativeTreasureEffects ? { nativeTreasureEffects } : {}), ...(nativeWheelEffects ? { nativeWheelEffects } : {}), ...(nativeCarnivalEffects ? { nativeCarnivalEffects } : {}) };
}

const prizeName = (id: number) => PRIZES.find(p => p.templateId === id)?.name ?? `物品${id}`;
export function viewActivities(input: ActivityState, wallet: ActivityWallet, ctx: ActivityContext): ActivitySnapshot {
  const s = normalize(input, ctx.now);
  const activities: ActivityView[] = Object.entries(ACTIVITY_TITLES).map(([id, title]) => {
    const v: ActivityView = { id, title, subtitle: "本地活动 · 奖励通过游戏邮件领取", rules: [], stats: [], actions: [] };
    const button = (label: string, action: ActivityAction, disabled = false) => v.actions.push({ label, action, disabled });
    if (chanceIds.includes(id as ChanceId)) return { ...v, ...viewChanceGame(id as ChanceId, s.games[id]) };
    if (id === "mines") {
      v.rules = ["每天最多3局；免费翻格。首次翻格安全，每局3条生命。", "安全翻格达到8、18、30格，各获强化石1级×1；探测5积分、复活15积分。"];
      const board = s.games.mines as MinesweeperState | undefined;
      if (!board) button("免费开始扫雷", { type: "start" });
      else {
        const b = viewMinesweeper(board); v.columns = b.width;
        v.stats = [{ label: "安全格", value: `${b.safeOpened}/${b.safeTotal}` }, { label: "生命", value: b.lives }, { label: "第几局", value: s.daily["mines:rounds"] ?? 0 }];
        const markMode = s.games.minesMode === "mark";
        v.cells = b.cells.map(c => ({ label: c.opened ? c.mine ? "雷" : String(c.adjacentMines) : c.marked ? "旗" : c.probed ? "已探明雷" : "？", tone: c.mine ? "danger" : c.opened ? "success" : "hidden", action: c.opened || ["lost", "won"].includes(b.status) ? undefined : markMode || c.marked ? { type: "mark", index: c.index, marked: !c.marked } : { type: "open", index: c.index }, detail: `第${c.index + 1}格` }));
        button(markMode ? "切换为翻格" : "切换为标旗 / 取消标旗", { type: "mode", choice: markMode ? "open" : "mark" });
        button("探测附近地雷 · 5积分", { type: "probe" }, b.status !== "playing");
        button("复活 · 15积分", { type: "revive" }, b.status !== "lost" || b.revivesRemaining === 0);
        button("重开本局", { type: "restart" }, b.status === "ready" || (s.daily["mines:rounds"] ?? 0) >= 3);
      }
    } else if (id === "pair") {
      v.rules = ["每天最多3局，翻牌免费。每次翻两张，相同即配对，不同需合上。", "整局6组全部配对，获得强化石1级×3；每日配对任务另奖积分。"];
      const board = s.games.pair as PairBoxState | undefined;
      if (!board) button("免费开始翻牌", { type: "start" });
      else { const b = viewPairBox(board); v.columns = 4; v.stats = [{ label: "已配对", value: `${b.matchedPairs}/${b.pairCount}` }, { label: "翻牌轮数", value: b.turns }];
        v.cells = b.cards.map(c => ({ label: c.value ?? "？", tone: c.matched ? "success" : c.faceUp ? "gold" : "hidden", action: c.faceUp ? undefined : { type: "flip", index: c.index } }));
        button("合上未配对卡牌", { type: "hide" }, !b.canHide); button("再开一局", { type: "restart" }, b.status !== "won" || (s.daily["pair:rounds"] ?? 0) >= 3);
      }
    } else if (["treasure", "moon", "cave"].includes(id)) {
      const b = bagState(s, id); const cost = id === "treasure" ? 30 : id === "moon" ? 20 : 15;
      v.rules = [`本地奖池：强化石1级55%、朱雀石1级25%、强化石2级15%、朱雀石2级5%。第10抽必得强化石2级×2。`, "奖品先存临时背包（最多30格）；领取寄邮件，回收换积分，两者只能选一种。10碎片可换强化石2级×2。", id === "cave" ? "基础开矿每天前3次免费；基础15积分、高级35积分且奖品数量翻倍。" : `普通每次${cost}积分。`];
      v.stats = [{ label: "临时背包", value: `${b.bag.length}/30` }, { label: "进度", value: b.score }, { label: "碎片", value: b.fragments }, { label: "距离保底", value: 10 - b.pity }];
      if (id === "cave") v.stats.push({ label: "今日免费", value: Math.max(0, 3 - (s.daily["cave:free"] ?? 0)) });
      button(id === "cave" ? "基础开矿" : "寻宝一次", { type: "draw", count: 1 }); button("连续五次", { type: "draw", count: 5 });
      if (id !== "moon") button(`高级寻宝 · ${id === "cave" ? 35 : 60}积分`, { type: "draw", choice: "advanced", count: 1 });
      button("全部领取", { type: "take" }, b.bag.length === 0); button("全部回收", { type: "recycle" }, b.bag.length === 0); button("10碎片兑换", { type: "exchange" }, b.fragments < 10);
      for (const tier of [1, 2, 3]) button(`${tier * 10}进度奖励`, { type: "progress", tier }, b.score < tier * 10 || b.claimed.includes(tier));
      v.cells = b.bag.map(r => ({ label: prizeName(r.templateId), detail: `×${r.count}`, tone: "gold" })); v.columns = 4;
      if (id === "treasure") { v.rules.push("普通寻宝只抽已选材料，概率按原权重重新分配；保底固定强化石2级×2。高级寻宝需全选4类，数量翻倍。");
        for (const c of PRIZES.map(p => p.name)) button(`${b.choices.includes(c) ? "✓ " : ""}${c}`, { type: "category", choice: c }); }
    } else if (id === "gypsy" || id === "exchange") {
      const shop = s.games.gypsy as GypsyState | undefined;
      const offers = id === "gypsy" ? shop?.offers ?? [] : C.shop;
      v.rules = id === "gypsy" ? ["每天第一次刷新免费，此后每次5积分。网页刷新每轮3件，原窗口刷新每轮8件，两入口共用当前货架，每格限购一次。", "商品在刷新前保持不变，购买后由游戏邮件交付。"] : ["本地积分兑换，单配方每天最多3次。", "原游戏材料兑换仍保留原规则和入口。"];
      if (id === "gypsy") button(!shop || shop.day !== s.day ? "今日免费刷新" : "刷新 · 5积分", { type: "refresh" });
      v.cells = offers.map((p, index) => ({ label: prizeName(p.templateId), detail: `×${p.count} · ${p.price}积分`, tone: "gold", action: "sold" in p && p.sold ? undefined : { type: id === "gypsy" ? "buy" : "exchange", index } })); v.columns = 3;
    } else if (id === "wardrobe") {
      Object.assign(v, viewWardrobe(s.games.wardrobe, ctx));
    } else if (id === "sign") {
      const days = ctx.signDays.filter(d => d.startsWith(s.day.slice(0, 7)));
      v.rules = ["与原游戏签到共用记录，已签到可领取上方每日任务积分。", "签到和累计奖励请在游戏原签到窗口领取；等级和奖励规则保持不变。"];
      v.stats = [{ label: "今日", value: days.includes(s.day) ? "已签到" : "未签到" }, { label: "本月累计", value: days.length }];
    } else if (["points-gift", "luxury", "first-gift"].includes(id)) {
      v.rules = ["由本地任务解锁，不接真实付款。抽奖返还、回收积分不计入累计任务积分。", "奖励不扣除积分，每档每角色仅可领取一次，永久绑定材料通过邮件交付。"];
      v.stats = [{ label: "累计任务积分", value: wallet.earned }];
      if (id === "first-gift") button("完成首次棋盘目标后领奖", { type: "claim" }, s.claims.includes(id) || !hasCompletedBoard(s));
      else (id === "points-gift" ? C.pointsGift : C.luxuryGift).forEach((n, i) => button(`${n}积分档 · 强化石×${(i + 1) * (id === "luxury" ? 5 : 3)}`, { type: "claim", tier: i + 1 }, wallet.earned < n || s.claims.includes(`${id}:${i + 1}`)));
    } else if (id === "christmas") {
      const b = s.games.christmas as SnowState | undefined;
      v.rules = ["每天首次30分钟雪地探索免费，后两轮各20积分。16个雪块中有3个雪人。", "找到雪人后可随时结束并领取，每个雪人奖励强化石1级×1；延长30分钟需20积分。"];
      button("开始雪地探索", { type: "start" }, !!b && !b.claimed && (ctx.now < new Date(b.expires) || b.found > 0));
      if (b) { v.stats = [{ label: "找到雪人", value: `${b.found}/3` }, { label: "剩余秒数", value: Math.max(0, Math.ceil((new Date(b.expires).getTime() - ctx.now.getTime()) / 1000)) }]; v.columns = 4;
        v.cells = Array.from({ length: 16 }, (_, index) => ({ label: b.opened.includes(index) ? b.cells.includes(index) ? "雪人" : "空地" : "雪块", tone: b.opened.includes(index) ? "success" : "hidden", action: b.opened.includes(index) || b.claimed || ctx.now >= new Date(b.expires) ? undefined : { type: "open", index } }));
        button("结束并领取", { type: "take" }, b.claimed || b.found === 0); button("延长30分钟 · 20积分", { type: "extend" }, b.claimed || ctx.now >= new Date(b.expires)); }
    }
    return v;
  });
  return { ...wallet, day: s.day, activities, tasks: taskList(s, ctx), history: s.history, nativePair: viewPairNative(s.games.pairNativeV1, ctx), nativeMines: viewMinesNative(s.games.minesNativeV1, ctx),
    nativeDDPlay: viewDDPlayNative(s.games.ddplay, wallet, (s.daily.actions ?? 0) < C.maxDailyActions),
    nativeGypsy: viewGypsyNative(s.games.gypsy, ctx, wallet, (s.daily.actions ?? 0) < C.maxDailyActions),
    nativeMoonlight: viewMoonlightNative(s.games.moon, ctx, wallet, (s.daily.actions ?? 0) < C.maxDailyActions),
    nativeTreasure: viewTreasureNative(s.games.treasure, ctx, wallet, (s.daily.actions ?? 0) < C.maxDailyActions, s.history),
    nativeWheel: viewWheelNative(s.games.wheelNativeV1, ctx, wallet, (s.daily.actions ?? 0) < C.maxDailyActions),
    nativeCarnival: viewCarnivalNative(s.games.carnivalNativeV1, ctx, wallet, Math.max(0, C.maxDailyActions - (s.daily.actions ?? 0))) };
}
