import { describe, expect, it } from "vitest";
import { advanceTreasure, readTreasureState, viewTreasureNative } from "../src/activities/treasure-native.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityState, type ActivityWallet } from "../src/activities/types.js";

const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), signDays: [], ownedTemplateIds: [] };
const next = { ...ctx, now: new Date("2026-10-16T12:00:00Z") };
const wallet = { points: 2000, earned: 40, revision: 0 };
const noRandom = () => { throw new Error("Unexpected draw during settlement"); };
function session() {
  let state = createActivityState(ctx.now), funds = { ...wallet };
  const view = () => viewActivities(state, funds, ctx).nativeTreasure;
  return { get state() { return state; }, get wallet() { return funds; }, view,
    act(action: ActivityAction, id = "treasure-native", rng: () => number = noRandom) {
      const result = transitionActivity(state, id, action, ctx, funds, rng);
      state = JSON.parse(JSON.stringify(result.state)) as ActivityState;
      funds = { ...funds, points: funds.points + result.pointsDelta, earned: funds.earned + result.earnedDelta, revision: funds.revision + 1 };
      return result;
    }, draw(count = 1, mode: "normal" | "advanced" = "normal", rng = () => 0) {
      return this.act({ type: "draw", mode, count, choice: view().bagToken }, "treasure-native", rng);
    }, choose(index: number, marked: boolean) { return this.act({ type: "choose", index, marked, choice: view().bagToken }); },
  };
}
const token = (value: unknown) => viewTreasureNative(value, ctx, wallet).bagToken;
const advance = (value: unknown, action: ActivityAction, funds: Pick<ActivityWallet, "points"> = wallet) =>
  advanceTreasure(value, { ...action, choice: token(value) }, ctx, funds, noRandom, true);

describe("original Treasure window with the existing local per-draw bag", () => {
  it("keeps projection read-only, shows ten bounded batch choices and only genuine current-role records", () => {
    const state = readTreasureState(undefined), before = structuredClone(state);
    const view = viewTreasureNative(undefined, ctx, { points: 100 }, true,
      ["2026-10-15T12:00:00Z 原生迷宫寻宝：完成1次", "2026-10-15T11:00:00Z 月光宝盒：完成1次", "2026-10-15T10:00:00Z 迷宫寻宝：领取"]);
    expect(view).toMatchObject({ version: 1, kind: "treasure-native", started: false, day: "2026-10-15", score: 100,
      normalCost: 30, advancedCost: 60, bagCapacity: 30, bagSlotsUsed: 0, draws: 0, progressScore: 0, fragments: 0,
      pityRemaining: 10, canDraw: true, canTake: false, canRecycle: false, bag: [], previewTemplateIds: [11019, 11001, 11021, 11002] });
    expect(view.bagToken).toMatch(/^2026-10-15:[A-Za-z0-9_-]{43}$/); expect(view.bagToken).toHaveLength(54);
    expect(viewTreasureNative(undefined, ctx, wallet).bagToken).toBe(view.bagToken); expect(viewTreasureNative(undefined, next, wallet).bagToken).not.toBe(view.bagToken);
    expect(view.drawChoices.map(row => [row.mode, row.count, row.cost, row.canDraw])).toEqual([
      ["normal", 1, 30, true], ["normal", 2, 60, true], ["normal", 3, 90, true], ["normal", 4, 120, false], ["normal", 5, 150, false],
      ["advanced", 1, 60, true], ["advanced", 2, 120, false], ["advanced", 3, 180, false], ["advanced", 4, 240, false], ["advanced", 5, 300, false] ]);
    expect(view.categories.map(row => [row.index, row.sourceOriginalIndex, row.templateId, row.selected])).toEqual([
      [0, 1, 11019, true], [1, 2, 11001, true], [2, 3, 11021, true], [3, 4, 11002, true] ]);
    expect(view.records).toHaveLength(2); expect(view.records.join()).not.toContain("月光"); expect(state).toEqual(before);
    expect(view.localRules.description).toContain("原14类奖池"); expect(view.localRules.description).toContain("不自动重复消费");
    expect(JSON.stringify(view)).not.toMatch(/"(?:state|games|seed|effects|choices)"\s*:/);
  });

  it("shares category filtering with legacy web, requires four advanced categories and doubles only actual quantities", () => {
    const run = session(); run.choose(1, false); run.act({ type: "category", choice: "强化石2级" }, "treasure"); run.choose(3, false);
    expect(run.view().categories.map(row => row.selected)).toEqual([true, false, false, false]);
    expect(run.view().drawChoices.filter(row => row.mode === "advanced").every(row => !row.canDraw)).toBe(true);
    expect(() => run.choose(0, false)).toThrow(/至少保留/); expect(() => run.draw(1, "advanced")).toThrow(/4类/);
    const draw = run.draw(2, "normal", () => 0.99);
    expect(draw).toMatchObject({ pointsDelta: -60, earnedDelta: 0, rewards: [], state: { completed: { treasure: 1 }, daily: { draws: 2, actions: 1 } },
      nativeTreasureEffects: [{ type: "drawn", mode: "normal", count: 2, cost: 60, score: 1940, draws: 2,
        rewards: [{ index: 0, sourceOriginalIndex: 1, templateId: 11019, itemCount: 1 }, { index: 1, sourceOriginalIndex: 1, templateId: 11019, itemCount: 1 }] }] });
    const old = run.act({ type: "draw", count: 1 }, "treasure", () => 0.99); expect(old.nativeTreasureEffects).toBeUndefined();
    for (const index of [1, 2, 3]) run.choose(index, true);
    const advanced = run.draw(2, "advanced", () => 0.99); expect(advanced.pointsDelta).toBe(-120);
    expect(readTreasureState(run.state.games.treasure).bag.slice(-2)).toEqual([{ templateId: 11002, count: 2 }, { templateId: 11002, count: 2 }]);
    expect(run.view()).toMatchObject({ draws: 5, progressScore: 7, fragments: 5, bagSlotsUsed: 5 });
    expect(run.state.games).not.toHaveProperty("treasureNativeV1"); expect(run.view().records).toHaveLength(9);
  });

  it("takes a whole individual draw row, retains duplicate rows and reindexes with a new stale-selection token", () => {
    const run = session(); run.draw(3, "advanced"); const oldToken = run.view().bagToken;
    expect(run.view().bag.map(row => [row.index, row.itemCount])).toEqual([[0, 2], [1, 2], [2, 2]]);
    const take = run.act({ type: "take", index: 1, choice: oldToken });
    expect(take).toMatchObject({ pointsDelta: 0, rewards: [{ templateId: 11019, count: 2 }],
      nativeTreasureEffects: [{ type: "taken", itemCount: 2, items: [{ index: 1, templateId: 11019, itemCount: 2 }] }] });
    expect(run.view().bag.map(row => [row.index, row.itemCount])).toEqual([[0, 2], [1, 2]]);
    expect(() => run.act({ type: "take", index: 1, choice: oldToken })).toThrow(/已更新/);
    const oldTake = run.act({ type: "take" }, "treasure"); expect(oldTake.rewards).toEqual([{ templateId: 11019, count: 2 }, { templateId: 11019, count: 2 }]);
    expect(run.view().bag).toEqual([]); expect(oldTake.nativeTreasureEffects).toBeUndefined();
    run.draw(3, "advanced"); expect(run.act({ type: "recycle", choice: run.view().bagToken })).toMatchObject({ pointsDelta: 12, earnedDelta: 0,
      nativeTreasureEffects: [{ type: "recycled", pointsAwarded: 12, score: 1652 }] });
    expect(run.view().bag).toEqual([]);
  });

  it("binds the complete state and UTC day, rejects forged templates, partial quantities and misplaced action fields", () => {
    const run = session(); run.draw(2); const state = readTreasureState(run.state.games.treasure), before = structuredClone(state), choice = token(state);
    for (const action of [null, [], {}, { type: "draw", choice }, { type: "draw", mode: "normal", count: 0, choice },
      { type: "draw", mode: "normal", count: "1", choice }, { type: "draw", mode: "paid", count: 1, choice }, { type: "draw", mode: "normal", count: 1, choice, price: 0 },
      { type: "choose", index: 0, choice }, { type: "choose", index: 0, marked: "false", choice }, { type: "choose", index: 4, marked: true, choice },
      { type: "take", index: 2, choice }, { type: "take", index: 0, count: 1, choice }, { type: "take", choice, items: [{ index: 0, count: 1 }] },
      { type: "take", index: "0", choice }, { type: "recycle", index: 0, choice }, { type: "progress", tier: "1", choice },
      { type: "exchange", count: 1, choice }, { type: "category", index: 0, marked: true, choice }, Object.create({ type: "take", choice })]) {
      expect(() => advanceTreasure(state, action as ActivityAction, ctx, wallet, noRandom, true)).toThrow(ActivityError);
    }
    expect(state).toEqual(before); expect(() => advanceTreasure(state, { type: "take", index: 0, choice }, next, wallet, noRandom, true)).toThrow(/日期已更新/);
    for (const key of ["draws", "score", "fragments", "pity"] as const) expect(token({ ...state, [key]: state[key] + 1 })).not.toBe(choice);
    expect(token({ ...state, choices: state.choices.slice(1) })).not.toBe(choice); expect(token({ ...state, claimed: [1] })).not.toBe(choice);
    for (const bad of [{ ...state, bag: [{ templateId: 1001, count: 1 }] }, { ...state, bag: [{ templateId: 11019, count: 4 }] },
      { ...state, bag: [{ templateId: 11021, count: 3 }] }, { ...state, bag: [{ templateId: 11019, count: 1, validDays: 7 }] },
      { ...state, bag: Array(30) }, { ...state, choices: [] }, { ...state, choices: ["fake"] }, { ...state, pity: 10 }, { ...state, claimed: [1, 1] }]) {
      expect(() => viewTreasureNative(bad, ctx, wallet)).toThrow(ActivityError);
    }
  });

  it("keeps the ten-draw guarantee outside the filtered pool, advanced progress and one-time exchange/tiers", () => {
    const run = session(); run.draw(5, "advanced", () => 0.99); run.draw(5, "advanced", () => 0.99);
    const state = readTreasureState(run.state.games.treasure);
    expect(state).toMatchObject({ draws: 10, score: 20, fragments: 10, pity: 0 }); expect(state.bag[9]).toEqual({ templateId: 11021, count: 4 });
    expect(run.act({ type: "exchange", choice: run.view().bagToken })).toMatchObject({ rewards: [{ templateId: 11021, count: 2 }],
      nativeTreasureEffects: [{ type: "exchanged", fragmentsSpent: 10, fragments: 0, templateId: 11021, itemCount: 2 }] });
    const claim = run.act({ type: "progress", tier: 2, choice: run.view().bagToken });
    expect(claim).toMatchObject({ rewards: [{ templateId: 11019, count: 4 }], nativeTreasureEffects: [{ type: "progress-claimed", tier: 2, templateId: 11019, itemCount: 4 }] });
    expect(() => run.act({ type: "progress", tier: 2, choice: run.view().bagToken })).toThrow(/已经领取/);
    expect(() => run.act({ type: "exchange", choice: run.view().bagToken })).toThrow(/10枚/);
    const filtered = session(); for (const index of [1, 2, 3]) filtered.choose(index, false);
    filtered.draw(5, "normal", () => 0.99); filtered.draw(5, "normal", () => 0.99);
    expect(readTreasureState(filtered.state.games.treasure).bag[9]).toEqual({ templateId: 11021, count: 2 });
  });

  it("bounds batch cost, per-draw capacity, counters and the entire recycled-wallet budget", () => {
    const state = readTreasureState(undefined); state.bag = Array.from({ length: 28 }, () => ({ templateId: 11019, count: 2 }));
    expect(viewTreasureNative(state, ctx, wallet).drawChoices.filter(row => row.mode === "normal").map(row => row.canDraw)).toEqual([true, true, false, false, false]);
    expect(() => advance(state, { type: "draw", mode: "normal", count: 3 })).toThrow(/已满/);
    expect(() => advance(state, { type: "draw", mode: "advanced", count: 2 }, { points: 119 })).toThrow(/积分不足/);
    expect(viewTreasureNative({ ...state, score: 999_999_999 }, ctx, wallet).drawChoices.filter(row => row.mode === "advanced").every(row => !row.canDraw)).toBe(true);
    expect(() => advance({ ...state, score: 999_999_999 }, { type: "draw", mode: "advanced", count: 1 })).toThrow(/已达上限/);
    const points = 2_147_483_647 - 112;
    expect(viewTreasureNative(state, ctx, { points })).toMatchObject({ canTake: true, canRecycle: true });
    expect(advance(state, { type: "recycle" }, { points }).pointsDelta).toBe(112);
    expect(viewTreasureNative(state, ctx, { points: points + 1 }).canRecycle).toBe(false);
    expect(() => advance(state, { type: "recycle" }, { points: points + 1 })).toThrow(/超过上限/);
    expect(advance(state, { type: "take", index: 0 }, { points: 2_147_483_647 }).rewards).toEqual([{ templateId: 11019, count: 2 }]);
  });

  it("rolls back invalid multi-draw RNG and keeps choices and all earned settlements available at daily 500", () => {
    const state = createActivityState(ctx.now), before = structuredClone(state); let rolls = 0;
    expect(() => transitionActivity(state, "treasure-native", { type: "draw", mode: "normal", count: 5, choice: token(undefined) }, ctx, wallet,
      () => ++rolls === 4 ? NaN : 0)).toThrow(/随机源/); expect(state).toEqual(before); expect(rolls).toBe(4);
    const run = session(); run.draw(5, "advanced"); run.draw(5, "advanced"); run.state.daily.actions = 500;
    expect(run.view().drawChoices.every(row => !row.canDraw)).toBe(true); expect(() => run.draw()).toThrow(/今日玩法次数/);
    for (const action of [{ type: "choose", index: 0, marked: false }, { type: "progress", tier: 1 }, { type: "exchange" }, { type: "take", index: 0 }, { type: "recycle" }]) {
      const result = run.act({ ...action, choice: run.view().bagToken }); expect(result.state.daily.actions).toBe(500); expect(result.earnedDelta).toBe(0);
    }
  });
});
