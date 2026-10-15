import { describe, expect, it } from "vitest";
import { advanceMoonlight, readMoonlightState, viewMoonlightNative } from "../src/activities/moonlight-native.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityState, type ActivityWallet } from "../src/activities/types.js";

const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), signDays: [], ownedTemplateIds: [] };
const next = { ...ctx, now: new Date("2026-10-16T12:00:00Z") };
const wallet = { points: 1000, earned: 40, revision: 0 };
const noRandom = () => { throw new Error("Unexpected draw during settlement"); };
function session() {
  let state = createActivityState(ctx.now), funds = { ...wallet };
  const view = () => viewActivities(state, funds, ctx).nativeMoonlight;
  return { get state() { return state; }, get wallet() { return funds; }, view,
    act(action: ActivityAction, id = "moonlight-native", rng: () => number = noRandom) {
      const result = transitionActivity(state, id, action, ctx, funds, rng);
      state = JSON.parse(JSON.stringify(result.state)) as ActivityState;
      funds = { ...funds, points: funds.points + result.pointsDelta, earned: funds.earned + result.earnedDelta, revision: funds.revision + 1 };
      return result;
    }, draw(count: number, rng = () => 0) { return this.act({ type: "draw", count, choice: view().bagToken }, "moonlight-native", rng); },
  };
}
const token = (value: unknown) => viewMoonlightNative(value, ctx, wallet).bagToken;
const advance = (value: unknown, action: ActivityAction, funds: Pick<ActivityWallet, "points"> = wallet) =>
  advanceMoonlight(value, { ...action, choice: token(value) }, ctx, funds, noRandom, true);

describe("original Moonlight shared bag and local three-draw contract", () => {
  it("keeps GET static and aggregates only real template quantities with a complete day-bound token", () => {
    const view = viewMoonlightNative(undefined, ctx, { points: 100 });
    expect(view).toMatchObject({ version: 1, kind: "moonlight-native", started: false, day: "2026-10-15", score: 100,
      drawCost: 20, bagCapacity: 30, bagSlotsUsed: 0, draws: 0, progressScore: 0, fragments: 0, pityRemaining: 10,
      canDraw: true, canTake: false, canRecycle: false, bag: [], previewTemplateIds: [11019, 11001, 11021, 11002] });
    expect(view.bagToken).toMatch(/^2026-10-15:[A-Za-z0-9_-]{43}$/); expect(view.bagToken).toHaveLength(54);
    expect(view.drawChoices).toEqual([{ count: 1, cost: 20, canDraw: true }, { count: 3, cost: 60, canDraw: true }, { count: 5, cost: 100, canDraw: true }]);
    expect(viewMoonlightNative(undefined, ctx, wallet).bagToken).toBe(view.bagToken); // Token binds bag state, not unrelated wallet changes.
    expect(viewMoonlightNative(undefined, next, wallet).bagToken).not.toBe(view.bagToken);
    expect(view.localRules.description).toContain("私服开盒档位"); expect(view.localRules.description).toContain("本地权重");
    expect(view.ranking).toBeNull(); expect(view.localRules.description).toContain("真实累计寻宝次数");
    expect(view.localRules.description).toContain("不发排名奖励");
    expect(JSON.stringify(view)).not.toMatch(/"(?:state|games|seed|effects|choices)"\s*:/);
  });

  it("retains all three original draw buttons, shared legacy counters and per-draw full-take semantics", () => {
    const run = session(), before = structuredClone(run.state);
    const draw = run.draw(3);
    expect(draw).toMatchObject({ pointsDelta: -60, earnedDelta: 0, rewards: [], state: { completed: { moon: 1 }, daily: { draws: 3, actions: 1 } },
      nativeMoonlightEffects: [{ type: "drawn", count: 3, cost: 60, score: 940, draws: 3, rewards: [{ templateId: 11019, itemCount: 3 }] }] });
    expect(run.view().bag).toEqual([{ index: 0, templateId: 11019, itemCount: 3, recycleUnitPoints: 2 }]);
    expect(run.view().bagSlotsUsed).toBe(3); expect(before.games).toEqual({}); expect(run.state.games).not.toHaveProperty("moonlightNativeV1");
    const oldDraw = run.act({ type: "draw", count: 2 }, "moon", () => 0.9);
    expect(oldDraw.pointsDelta).toBe(-40); expect(oldDraw.nativeMoonlightEffects).toBeUndefined();
    expect(run.view()).toMatchObject({ draws: 5, progressScore: 5, fragments: 5, bagSlotsUsed: 5 });
    expect(run.act({ type: "take" }, "moon").rewards).toEqual([{ templateId: 11019, count: 1 }, { templateId: 11019, count: 1 },
      { templateId: 11019, count: 1 }, { templateId: 11021, count: 1 }, { templateId: 11021, count: 1 }]);
    expect(run.view().bag).toEqual([]);
    expect(() => run.act({ type: "draw", choice: "advanced" }, "moon", () => 0)).toThrow(/没有高级/);
  });

  it("partially settles multiple template quantities atomically, keeps remaining raw entries and never rerolls", () => {
    const run = session(); run.act({ type: "draw", count: 2 }, "moon", () => 0); run.draw(3, () => 0.9);
    const before = structuredClone(run.state), oldToken = run.view().bagToken;
    const take = run.act({ type: "take", choice: oldToken, items: [{ index: 1, count: 2 }, { index: 0, count: 1 }] });
    expect(take).toMatchObject({ pointsDelta: 0, rewards: [{ templateId: 11019, count: 1 }, { templateId: 11021, count: 2 }],
      nativeMoonlightEffects: [{ type: "taken", itemCount: 3, items: [{ index: 0, templateId: 11019, itemCount: 1 }, { index: 1, templateId: 11021, itemCount: 2 }] }] });
    expect(readMoonlightState(take.state.games.moon).bag).toEqual([{ templateId: 11019, count: 1 }, { templateId: 11021, count: 1 }]);
    expect(before).not.toEqual(take.state); expect(run.view().bagToken).not.toBe(oldToken);
    expect(() => run.act({ type: "recycle", choice: oldToken, items: [{ index: 0, count: 1 }] })).toThrow(/已更新/);
    const recycled = run.act({ type: "recycle", choice: run.view().bagToken, items: [{ index: 0, count: 1 }] });
    expect(recycled).toMatchObject({ pointsDelta: 2, earnedDelta: 0, rewards: [], nativeMoonlightEffects: [{ type: "recycled", pointsAwarded: 2, score: 902 }] });
    expect(run.view().bag).toEqual([{ index: 0, templateId: 11021, itemCount: 1, recycleUnitPoints: 2 }]);
    expect(run.act({ type: "recycle" }, "moon").pointsDelta).toBe(2); expect(run.view().bag).toEqual([]);
  });

  it("validates every selected quantity and all native fields without coercion or partial mutation", () => {
    const run = session(); run.draw(5); const state = readMoonlightState(run.state.games.moon), before = structuredClone(state), choice = token(state);
    for (const value of [null, [], {}, { type: "draw", choice }, { type: "draw", choice, count: 2 }, { type: "draw", choice, count: "3" },
      { type: "draw", choice, count: 3, tier: 1 }, { type: "take", choice }, { type: "take", choice, items: [] },
      { type: "take", choice, items: [{ index: 0, count: 0 }] }, { type: "take", choice, items: [{ index: 0, count: 6 }] },
      { type: "take", choice, items: [{ index: 0, count: 1 }, { index: 0, count: 1 }] }, { type: "take", choice, items: [{ index: 0, count: "1" }] },
      { type: "take", choice, items: [{ index: 0, count: 1, templateId: 1001 }] }, { type: "take", choice, items: [{ index: 1, count: 1 }] },
      { type: "recycle", choice, items: [{ index: 0.5, count: 1 }] }, { type: "take", choice, count: 1, items: [{ index: 0, count: 1 }] },
      { type: "exchange", choice, count: 0 }, { type: "progress", choice, tier: "1" }, Object.create({ type: "draw", choice, count: 1 })]) {
      expect(() => advanceMoonlight(state, value as ActivityAction, ctx, wallet, noRandom, true)).toThrow(ActivityError);
    }
    expect(state).toEqual(before);
    expect(() => advanceMoonlight(state, { type: "take", choice, items: [{ index: 0, count: 1 }] }, next, wallet, noRandom, true)).toThrow(/日期已更新/);
    for (const bad of [{ ...before, bag: [{ templateId: 1001, count: 1 }] }, { ...before, bag: [{ templateId: 11019, count: 2 }] },
      { ...before, bag: [{ templateId: 11021, count: 3 }] }, { ...before, bag: [{ templateId: 11019, count: 1, validDays: 7 }] },
      { ...before, bag: Array(30) }, { ...before, pity: 10 }, { ...before, claimed: [1, 1] }, { ...before, choices: ["fake"] }]) {
      expect(() => viewMoonlightNative(bad, ctx, wallet)).toThrow(ActivityError);
    }
  });

  it("binds every bag, counter and claimed-tier change while retaining the existing pity and progress rules", () => {
    const run = session(); run.draw(5, () => 0.9); const oldToken = run.view().bagToken; run.draw(5, () => 0.9);
    const state = readMoonlightState(run.state.games.moon);
    expect(state).toMatchObject({ draws: 10, score: 10, fragments: 10, pity: 0 }); expect(state.bag[9]).toEqual({ templateId: 11021, count: 2 });
    expect(run.view().bag[0].itemCount).toBe(11); expect(run.view().bagSlotsUsed).toBe(10);
    expect(() => run.act({ type: "take", choice: oldToken, items: [{ index: 0, count: 1 }] })).toThrow(/已更新/);
    const beforeExchange = run.view().bagToken, exchange = run.act({ type: "exchange", choice: beforeExchange });
    expect(exchange).toMatchObject({ rewards: [{ templateId: 11021, count: 2 }], nativeMoonlightEffects: [{ type: "exchanged", fragmentsSpent: 10, fragments: 0, templateId: 11021, itemCount: 2 }] });
    expect(run.view().bagToken).not.toBe(beforeExchange); expect(run.view().exchange.canExchange).toBe(false);
    const beforeClaim = run.view().bagToken, claim = run.act({ type: "progress", tier: 1, choice: beforeClaim });
    expect(claim).toMatchObject({ rewards: [{ templateId: 11019, count: 2 }], nativeMoonlightEffects: [{ type: "progress-claimed", tier: 1, itemCount: 2 }] });
    expect(run.view().bagToken).not.toBe(beforeClaim); expect(run.view().progress.map(t => [t.claimed, t.canClaim])).toEqual([[true, false], [false, false], [false, false]]);
    expect(() => run.act({ type: "progress", tier: 1, choice: run.view().bagToken })).toThrow(/已经领取/);
    expect(() => run.act({ type: "exchange", choice: run.view().bagToken })).toThrow(/10枚/);
  });

  it("exchanges a bounded native quantity without changing the recipe or legacy single-package settlement", () => {
    const state = readMoonlightState(undefined); state.fragments = 105; const before = structuredClone(state);
    expect(viewMoonlightNative(state, ctx, wallet).exchange).toEqual({ fragmentCost: 10, templateId: 11021, itemCount: 2, maxCount: 10, affordableCount: 10, canExchange: true });
    const batch = advance(state, { type: "exchange", count: 10 });
    expect(batch).toMatchObject({ state: { fragments: 5 }, pointsDelta: 0, cost: 0, rewards: [{ templateId: 11021, count: 20 }],
      effects: [{ type: "exchanged", count: 10, fragmentsSpent: 100, fragments: 5, templateId: 11021, itemCount: 20 }] });
    expect(state).toEqual(before); expect(viewMoonlightNative(batch.state, ctx, wallet).exchange).toMatchObject({ affordableCount: 0, canExchange: false });
    expect(advance(state, { type: "exchange" }).state.fragments).toBe(95);
    expect(advanceMoonlight(state, { type: "exchange" }, ctx, wallet, noRandom).rewards).toEqual([{ templateId: 11021, count: 2 }]);
    for (const count of [0, -1, 11, 1.5, NaN, Infinity, "2", null, undefined]) {
      expect(() => advance(state, { type: "exchange", count } as ActivityAction)).toThrow(/1至10/);
    }
    const limited = { ...state, fragments: 25 };
    expect(viewMoonlightNative(limited, ctx, wallet).exchange.affordableCount).toBe(2);
    expect(() => advance(limited, { type: "exchange", count: 3 })).toThrow(/30枚/);
    expect(limited.fragments).toBe(25);
    expect(() => advanceMoonlight(batch.state, { type: "exchange", count: 1, choice: token(state) }, ctx, wallet, noRandom, true)).toThrow(/已更新/);
  });

  it("bounds raw bag capacity, batch affordability, counter limits and recyclable wallet headroom", () => {
    const state = readMoonlightState(undefined); state.bag = Array.from({ length: 28 }, () => ({ templateId: 11019, count: 1 }));
    expect(viewMoonlightNative(state, ctx, wallet).drawChoices.map(c => c.canDraw)).toEqual([true, false, false]);
    expect(() => advance(state, { type: "draw", count: 3 })).toThrow(/已满/);
    expect(viewMoonlightNative(undefined, ctx, { points: 59 }).drawChoices.map(c => c.canDraw)).toEqual([true, false, false]);
    expect(() => advance(undefined, { type: "draw", count: 3 }, { points: 59 })).toThrow(/积分不足/);
    expect(viewMoonlightNative({ ...state, draws: 999_999_999 }, ctx, wallet).drawChoices.map(c => c.canDraw)).toEqual([true, false, false]);
    expect(() => advance({ ...state, score: 1_000_000_000 }, { type: "draw", count: 1 })).toThrow(/已达上限/);
    expect(viewMoonlightNative(state, ctx, { points: 2_147_483_646 })).toMatchObject({ canTake: true, canRecycle: false });
    expect(() => advance(state, { type: "recycle", items: [{ index: 0, count: 1 }] }, { points: 2_147_483_646 })).toThrow(/超过上限/);
    expect(advance(state, { type: "recycle", items: [{ index: 0, count: 1 }] }, { points: 2_147_483_645 }).pointsDelta).toBe(2);
    expect(() => advance(state, { type: "recycle", items: [{ index: 0, count: 2 }] }, { points: 2_147_483_645 })).toThrow(/超过上限/);
    for (const points of [-1, NaN, Infinity, 1.5, 2_147_483_648]) expect(() => viewMoonlightNative(state, ctx, { points })).toThrow(ActivityError);
  });

  it("rolls back a multi-draw failure in pure state and permits existing settlements at the daily ceiling", () => {
    const state = createActivityState(ctx.now), before = structuredClone(state), choice = token(undefined); let rolls = 0;
    expect(() => transitionActivity(state, "moonlight-native", { type: "draw", count: 5, choice }, ctx, wallet, () => ++rolls === 4 ? NaN : 0)).toThrow(/随机源/);
    expect(rolls).toBe(4); expect(state).toEqual(before);
    const run = session(); run.draw(5); run.draw(5); run.state.daily.actions = 500;
    expect(run.view().drawChoices.every(c => !c.canDraw)).toBe(true);
    expect(() => run.draw(1)).toThrow(/今日玩法次数/);
    for (const action of [{ type: "progress", tier: 1 }, { type: "exchange" }, { type: "take", items: [{ index: 0, count: 1 }] },
      { type: "recycle", items: [{ index: 0, count: 1 }] }]) {
      const result = run.act({ ...action, choice: run.view().bagToken }); expect(result.state.daily.actions).toBe(500); expect(result.earnedDelta).toBe(0);
    }
  });
});
