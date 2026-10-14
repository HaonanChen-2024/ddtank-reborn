import { describe, expect, it } from "vitest";
import { advanceGypsy, readGypsyState, viewGypsyNative } from "../src/activities/gypsy-native.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { LOCAL_RULES } from "../src/activities/config.js";
import { ActivityError, type ActivityAction, type ActivityContext } from "../src/activities/types.js";

const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), signDays: [], ownedTemplateIds: [] };
const next: ActivityContext = { ...ctx, now: new Date("2026-10-16T12:00:00Z") };
const wallet = { points: 100, earned: 40, revision: 3 }, last = () => 0.999999;
const noRandom = () => { throw new Error("Unexpected random draw"); };
const nativeRefresh = (state?: unknown, choice = "free") => advanceGypsy(state, { type: "refresh", choice }, ctx, wallet, last, true);
const buy = (state: unknown, index: number, choice: string) => advanceGypsy(state, { type: "buy", index, choice }, ctx, wallet, noRandom, true);

describe("original eight-slot Gypsy shop and shared legacy save", () => {
  it("keeps an absent or old three-slot shelf static on read, with explicit prices and no future inventory", () => {
    expect(viewGypsyNative(undefined, ctx, { points: 0 })).toMatchObject({ started: false, score: 0, shelfKey: null,
      refreshes: 0, slots: 8, freeRefresh: true, refreshCost: 0, canRefresh: true, offers: [] });
    const old = advanceGypsy(undefined, { type: "refresh" }, ctx, wallet, last).state, before = structuredClone(old);
    const view = viewGypsyNative(old, ctx, wallet);
    expect(view).toMatchObject({ started: true, shelfKey: "2026-10-15:1", refreshes: 1, freeRefresh: false, refreshCost: 5 });
    expect(view.offers).toHaveLength(3); expect(view.offers.map(o => [o.index, o.templateId, o.itemCount, o.price, o.sold, o.canBuy]))
      .toEqual([[0, 11019, 3, 15, false, true], [1, 11001, 3, 20, false, true], [2, 11021, 1, 25, false, true]]);
    expect(view.previewTemplateIds).toEqual([11019, 11001, 11021, 11002]); expect(old).toEqual(before);
    expect(view.localRules.description).toContain("旧网页刷新仍为3格"); expect(view.localRules.description).toContain("无稀有装备");
    expect(JSON.stringify(view)).not.toMatch(/"(?:state|games|seed|effects|nextOffers)"\s*:/);
  });

  it("fills eight native slots and independently sells repeated templates while legacy refresh and purchase remain compatible", () => {
    const initial = createActivityState(ctx.now), native = transitionActivity(initial, "gypsy-native", { type: "refresh", choice: "free" }, ctx, wallet, last);
    const shop = readGypsyState(native.state.games.gypsy)!; expect(shop.offers).toHaveLength(8);
    for (const prize of LOCAL_RULES.shop) expect(shop.offers.filter(offer => offer.templateId === prize.templateId)).toHaveLength(2);
    expect(native.nativeGypsyEffects).toEqual([{ type: "refreshed", shelfKey: "2026-10-15:1", offerCount: 8, cost: 0, score: 100, free: true }]);
    const bought = transitionActivity(native.state, "gypsy-native", { type: "buy", index: 0, choice: "2026-10-15:1" }, ctx, wallet, noRandom);
    expect(bought).toMatchObject({ pointsDelta: -15, earnedDelta: 0, rewards: [{ templateId: 11019, count: 3 }], nativeGypsyEffects: [{ type: "bought", itemCount: 3, score: 85 }] });
    expect(readGypsyState(bought.state.games.gypsy)!.offers.filter(offer => offer.templateId === 11019).map(offer => offer.sold)).toEqual([true, false]);
    const legacy = transitionActivity(bought.state, "gypsy", { type: "buy", index: 4 }, ctx, { ...wallet, points: 85 }, noRandom);
    expect(legacy.pointsDelta).toBe(-15); expect(legacy.nativeGypsyEffects).toBeUndefined(); expect(legacy.state.completed.gypsy).toBe(2);
    expect(viewActivities(legacy.state, { ...wallet, points: 70 }, ctx).activities.find(a => a.id === "gypsy")!.cells).toHaveLength(8);
    const restored = transitionActivity(legacy.state, "gypsy", { type: "refresh" }, ctx, { ...wallet, points: 70 }, last);
    expect(restored.pointsDelta).toBe(-5); expect(readGypsyState(restored.state.games.gypsy)!.offers).toHaveLength(3);
    expect(viewActivities(restored.state, { ...wallet, points: 65 }, ctx).nativeGypsy.offers).toHaveLength(3);
    expect(native.state.games).not.toHaveProperty("gypsyNativeV1"); expect(initial.games).toEqual({});
  });

  it("requires the exact displayed free/paid mode and batch token instead of silently charging or buying a new batch", () => {
    expect(() => nativeRefresh(undefined, "points")).toThrow(/刷新费用已变化/);
    const first = nativeRefresh().state, before = structuredClone(first);
    expect(() => nativeRefresh(first, "free")).toThrow(/刷新费用已变化/); expect(first).toEqual(before);
    const paid = nativeRefresh(first, "points"); expect(paid).toMatchObject({ cost: 5, state: { refreshes: 2 }, effects: [{ score: 95, free: false }] });
    expect(() => buy(paid.state, 0, "2026-10-15:1")).toThrow(/报价已过期/);
    expect(() => buy(first, 3, "2026-10-15:1")).not.toThrow();
    const old = advanceGypsy(undefined, { type: "refresh" }, ctx, wallet, last).state;
    expect(() => buy(old, 3, "2026-10-15:1")).toThrow(/请先刷新/);
    expect(() => advanceGypsy(first, { type: "refresh", choice: "points" }, ctx, { points: 4 }, noRandom, true)).toThrow(/积分不足/);
    expect(() => advanceGypsy(first, { type: "buy", index: 0, choice: "2026-10-15:1" }, ctx, { points: 14 }, noRandom, true)).toThrow(/积分不足/);
  });

  it("rejects coercions, inherited and extra fields, out-of-range indexes and tampered prices without mutation", () => {
    const first = nativeRefresh().state, before = structuredClone(first);
    for (const action of [null, [], {}, { type: "refresh" }, { type: "refresh", choice: "free", count: 1 },
      { type: "refresh", choice: "honour" }, { type: "buy", index: 0 }, { type: "buy", index: 0, choice: "2026-10-15:1", count: 1 },
      { type: "buy", index: "0", choice: "2026-10-15:1" }, { type: "buy", index: 8, choice: "2026-10-15:1" },
      { type: "buy", index: -1, choice: "2026-10-15:1" }, { type: "buy", index: 0.5, choice: "2026-10-15:1" },
      { type: "buy", index: 0, choice: "2026-10-15:1", templateId: 1001, price: 0 }, Object.create({ type: "refresh", choice: "free" })]) {
      expect(() => advanceGypsy(first, action as ActivityAction, ctx, wallet, noRandom, true)).toThrow(ActivityError);
    }
    for (const field of ["templateId", "count", "price"] as const) {
      const bad = structuredClone(first); bad.offers[0][field] = 999;
      expect(() => viewGypsyNative(bad, ctx, wallet)).toThrow(/报价配置/);
    }
    expect(first).toEqual(before);
  });

  it("checks saved dates, shuffle, integer bounds and wallet limits, while preserving an existing shelf when reads cross midnight", () => {
    const first = nativeRefresh().state, before = structuredClone(first);
    for (const points of [-1, 1.5, NaN, Infinity, 2_147_483_648]) expect(() => viewGypsyNative(first, ctx, { points })).toThrow(ActivityError);
    expect(viewGypsyNative(first, ctx, { points: 2_147_483_647 }).score).toBe(2_147_483_647);
    for (const value of [null, [], { ...first, day: "2026-02-30" }, { ...first, refreshes: 0 }, { ...first, refreshes: 1_000_000_001 },
      { ...first, offers: first.offers.slice(0, 7) }, { ...first, offers: Array(8) },
      { ...first, offers: first.offers.map(() => ({ ...first.offers[0] })) }]) expect(() => viewGypsyNative(value, ctx, wallet)).toThrow(ActivityError);
    for (const bad of [-0.1, 1, NaN, Infinity]) expect(() => advanceGypsy(first, { type: "refresh", choice: "points" }, ctx, wallet, () => bad, true)).toThrow(/随机源/);
    const capped = { ...first, refreshes: 1_000_000_000 }; expect(viewGypsyNative(capped, ctx, wallet).canRefresh).toBe(false);
    expect(() => advanceGypsy(capped, { type: "refresh", choice: "points" }, ctx, wallet, noRandom, true)).toThrow(/刷新次数/);
    const nextView = viewGypsyNative(first, next, wallet); expect(nextView).toMatchObject({ day: "2026-10-16", shelfDay: "2026-10-15", shelfKey: "2026-10-15:1", freeRefresh: true, refreshCost: 0 });
    expect(nextView.offers).toEqual(viewGypsyNative(first, ctx, wallet).offers); expect(first).toEqual(before);
    const nextBought = advanceGypsy(first, { type: "buy", index: 0, choice: nextView.shelfKey! }, next, wallet, noRandom, true);
    expect(nextBought.cost).toBe(15); expect(nextBought.state.day).toBe(first.day);
    const nextRefresh = advanceGypsy(nextBought.state, { type: "refresh", choice: "free" }, next, wallet, last, true);
    expect(nextRefresh.state).toMatchObject({ day: "2026-10-16", refreshes: 1 }); expect(nextRefresh.cost).toBe(0);
  });

  it("enforces the existing play ceiling while exposing stock and balances accurately", () => {
    const state = createActivityState(ctx.now); state.games.gypsy = nativeRefresh().state; state.daily.actions = 500;
    const view = viewActivities(state, wallet, ctx).nativeGypsy;
    expect(view.canRefresh).toBe(false); expect(view.offers.every(offer => !offer.canBuy && !offer.sold)).toBe(true);
    for (const action of [{ type: "refresh", choice: "points" }, { type: "buy", index: 0, choice: view.shelfKey! }]) {
      expect(() => transitionActivity(state, "gypsy-native", action, ctx, wallet, noRandom)).toThrow(/今日玩法次数/);
    }
  });
});
