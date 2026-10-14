import { describe, expect, it } from "vitest";
import { advanceWheelNative, readWheelNativeState, viewWheelNative, type WheelNativeState } from "../src/activities/wheel-native.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext } from "../src/activities/types.js";

const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), signDays: [], ownedTemplateIds: [] };
const funds = { points: 1000, earned: 40, revision: 0 }, templates = [11019, 11001, 11021, 11002];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function sequence(...values: number[]) {
  let index = 0;
  return () => { if (index >= values.length) throw new Error("Unexpected extra random draw"); return values[index++]; };
}
const noRandom = () => { throw new Error("This action must not draw randomness"); };
function act(state: WheelNativeState | undefined, type: string, rng: () => number = noRandom, extra: Partial<ActivityAction> = {}) {
  return advanceWheelNative(freeze(state), { type, choice: viewWheelNative(state, ctx, funds).roundToken, ...extra }, ctx, funds, rng);
}
function reject(state: WheelNativeState | undefined, action: ActivityAction, wallet = funds) {
  const before = state === undefined ? undefined : clone(state);
  expect(() => advanceWheelNative(freeze(state), action, ctx, freeze(wallet), noRandom)).toThrow(ActivityError);
  expect(state).toEqual(before);
}
const token = (state: WheelNativeState | undefined) => viewWheelNative(state, ctx, funds).roundToken;

describe("original wheel local state and finite rules", () => {
  it("has a pure default view and strict state ownership without reading the old five-star save", () => {
    const view = viewWheelNative(undefined, ctx, funds);
    expect(view).toMatchObject({ started: false, level: 0, category: 0, roundMaterial: null, pending: null, fragments: 0, canStart: true });
    expect(view.roundToken).toMatch(/^2026-10-15:[A-Za-z0-9_-]{43}$/);
    for (const raw of [null, [], 1, { version: 1, kind: "wheel", round: 1, phase: "active", stars: 5 },
      { ...readWheelNativeState(undefined), extra: true }, { ...readWheelNativeState(undefined), fragments: 20 }]) {
      expect(() => viewWheelNative(raw, ctx, funds)).toThrow(ActivityError);
    }
    const started = act(undefined, "start", sequence(0)).state;
    for (const change of [{ version: 2 }, { rulesVersion: 2 }, { category: 6 }, { materialIndex: 1 }, { round: 0 },
      { spinCount: 0 }, { level: 0 }, { level: 8 }, { fragments: -1 }, { pending: null }, { phase: "settled" }]) {
      expect(() => readWheelNativeState({ ...started, ...change })).toThrow(ActivityError);
    }
    for (const pending of [{ ...started.pending!, chipAmount: 0 }, { ...started.pending!, round: 2 },
      { ...started.pending!, category: 2 }, { ...started.pending!, item: { templateId: 11019, itemCount: 1 } },
      { ...started.pending!, hidden: true }]) expect(() => readWheelNativeState({ ...started, pending })).toThrow(ActivityError);
    expect(() => readWheelNativeState({ ...started, level: 7, pending: { ...started.pending, level: 7, chipAmount: 140,
      item: { templateId: 11019, itemCount: 7 } } })).toThrow(/实际追加次数/);
    expect(() => readWheelNativeState({ ...started, phase: "failed", level: 0, pending: { ...started.pending, level: 0 } })).toThrow(/实际追加次数/);
    expect(() => viewWheelNative(undefined, { now: new Date("invalid") }, funds)).toThrow(ActivityError);
    for (const points of [-1, 2147483648, NaN]) expect(() => viewWheelNative(undefined, ctx, { points })).toThrow(ActivityError);
  });

  it("fully supports five local categories and seven levels while fixing each material at start", () => {
    for (let category = 1; category <= 5; category++) for (const material of category === 5 ? [0, 1, 2, 3] : [category - 1]) {
      const start = act(undefined, "start", sequence((category - 0.5) / 5, (material + 0.5) / 4));
      let state = start.state;
      expect(start).toMatchObject({ cost: 20, rewards: [], state: { category, materialIndex: material, level: 1 } });
      for (let level = 1; level <= 7; level++) {
        const before = clone(state), view = viewWheelNative(freeze(state), ctx, funds);
        expect(view).toMatchObject({ category, level, roundMaterial: { templateId: templates[material] },
          pending: { chipAmount: 20 * level, item: level === 1 ? null : { templateId: templates[material], itemCount: level } } });
        expect(state).toEqual(before);
        if (level < 7) {
          const next = act(state, "continue", sequence(0));
          expect(next.effects[0]).toMatchObject({ type: "rotated", fromLevel: level, toLevel: level + 1, success: true, templateId: templates[material] });
          state = next.state;
        }
      }
      expect(viewWheelNative(state, ctx, funds)).toMatchObject({ canContinue: false, canProtect: false, canTakeItem: true });
      reject(state, { type: "continue", choice: token(state) }); reject(state, { type: "protect", choice: token(state) });
      expect(act(state, "take-item")).toMatchObject({ cost: 0, completed: true, rewards: [{ templateId: templates[material], count: 7 }],
        state: { phase: "settled", pending: null, level: 7, fragments: 0 } });
    }
  });

  it("uses the 60 percent edge, stops ordinary failure at zero and keeps protected failure active with a fresh token", () => {
    let state = act(undefined, "start", sequence(0.99, 0.6)).state;
    const oldToken = token(state), preserved = clone(state.pending);
    const protect = act(state, "protect", sequence(0.6));
    expect(protect).toMatchObject({ cost: 20, state: { level: 1, phase: "active", spinCount: 2, pending: preserved },
      effects: [{ type: "rotated", success: false, protectedFailure: true, toLevel: 1 }] });
    expect(token(protect.state)).not.toBe(oldToken); reject(protect.state, { type: "protect", choice: oldToken });
    state = act(protect.state, "continue", sequence(0.599999)).state; expect(state.level).toBe(2);
    for (const [drop, level] of [[0, 1], [0.999999, 0]]) {
      const failed = act(state, "continue", sequence(0.6, drop));
      expect(failed).toMatchObject({ cost: 10, state: { phase: "failed", level, materialIndex: 2, pending: { chipAmount: 20, item: null } },
        effects: [{ type: "rotated", success: false, protectedFailure: false, toLevel: level }] });
      for (const type of ["continue", "protect", "start", "take-item"]) reject(failed.state, { type, choice: token(failed.state) });
      const taken = act(failed.state, "take-chip");
      expect(taken).toMatchObject({ completed: true, rewards: [], state: { fragments: 20, phase: "settled", pending: null } });
      reject(taken.state, { type: "take-chip", choice: token(taken.state) });
    }
  });

  it("requires an explicit full token and rejects client prices, unknown keys, old fields and malformed exchanges", () => {
    const started = act(undefined, "start", sequence(0)).state, choice = token(started);
    for (const value of [{ type: "take" }, { type: "buy-coins", choice }, { type: "continue", choice, count: 1 },
      { type: "start", choice, index: 1 }, { type: "protect", choice, marked: true }, { type: "take-chip", choice, items: [{ index: 0, count: 1 }] },
      { type: "take-item", choice, mode: "normal" }, { type: "exchange", choice }, { type: "exchange", choice, index: 4, count: 1 },
      { type: "exchange", choice, index: 0, count: 0 }, { type: "exchange", choice, index: 0, count: 11 },
      { type: "exchange", choice, index: 0, count: 1, price: 0 }, { type: "protect", choice: "stale" }]) reject(started, value as ActivityAction);
    const inherited = Object.create({ type: "take-chip", choice }); reject(started, inherited);
    reject(started, { type: "continue", choice }, { ...funds, points: 9 });
    const before = clone(started);
    for (const bad of [-0.1, 1, Infinity, NaN]) expect(() => act(started, "continue", () => bad)).toThrow(ActivityError);
    expect(started).toEqual(before);
    for (const bad of [-0.1, 1, NaN]) expect(() => act(undefined, "start", () => bad)).toThrow(ActivityError);
  });

  it("consumes the whole chip or item entitlement once and exchanges existing chips without additional randomness", () => {
    let state = act(undefined, "start", sequence(0.99, 0.99)).state;
    for (let i = 0; i < 6; i++) state = act(state, "protect", sequence(0)).state;
    const taken = act(state, "take-chip");
    expect(taken).toMatchObject({ rewards: [], state: { fragments: 140, pending: null, phase: "settled" } });
    reject(taken.state, { type: "take-item", choice: token(taken.state) });
    let exchanged = taken.state;
    for (let index = 0; index < 4; index++) {
      const result = act(exchanged, "exchange", noRandom, { index, count: 1 });
      expect(result).toMatchObject({ cost: 0, completed: false, rewards: [{ templateId: templates[index], count: 1 }],
        effects: [{ type: "exchanged", chipsSpent: 20, itemCount: 1 }] });
      exchanged = result.state;
    }
    expect(exchanged.fragments).toBe(60); expect(exchanged.spinCount).toBe(7);
    reject(exchanged, { type: "exchange", index: 0, count: 4, choice: token(exchanged) });
    const snapshot = viewWheelNative(exchanged, ctx, funds);
    expect(snapshot.exchange.every(item => item.affordableCount === 3 && item.canExchange)).toBe(true);
    snapshot.categories[4].templateIds.push(11019);
    expect(viewWheelNative(exchanged, ctx, funds).categories[4].templateIds).toEqual(templates);
  });

  it("preserves settlement at counter and fragment boundaries while invalidating UTC-day and whole-ledger tokens", () => {
    const state = act(undefined, "start", sequence(0)).state;
    const capped = { ...clone(state), spinCount: 1_000_000_000, fragments: 1_000_000_000 };
    const view = viewWheelNative(capped, ctx, funds);
    expect(view).toMatchObject({ canContinue: false, canProtect: false, canTakeChip: false });
    reject(capped, { type: "continue", choice: token(capped) }); reject(capped, { type: "take-chip", choice: token(capped) });
    const exchange = act(capped, "exchange", noRandom, { index: 0, count: 10 });
    expect(act(exchange.state, "take-chip").state).toMatchObject({ fragments: 999999820, spinCount: 1_000_000_000, phase: "settled" });
    const tomorrow = { now: new Date("2026-10-16T00:00:00Z") };
    expect(viewWheelNative(state, tomorrow, funds).roundToken).not.toBe(token(state));
    expect(() => advanceWheelNative(state, { type: "take-chip", choice: token(state) }, tomorrow, funds, noRandom)).toThrow(/已更新/);
    const next = act(state, "continue", sequence(0)).state;
    expect(() => readWheelNativeState({ ...next, pending: { ...next.pending, item: { templateId: 999, itemCount: 2 } } })).toThrow(ActivityError);
  });

  it("shares the global allowance and wallet while preserving both old and native slots and eligible settlement", () => {
    const root = createActivityState(ctx.now);
    const old = transitionActivity(root, "wheel", { type: "start" }, ctx, funds, noRandom);
    const native = transitionActivity(old.state, "wheel-native", { type: "start", choice: viewActivities(old.state, funds, ctx).nativeWheel.roundToken }, ctx, funds, sequence(0));
    expect(native.state.games.wheel).toEqual(old.state.games.wheel); expect(native.pointsDelta).toBe(-20);
    const before = clone(native.state.games.wheelNativeV1);
    const continued = transitionActivity(native.state, "wheel", { type: "continue" }, ctx, funds, sequence(0));
    expect(continued.state.games.wheelNativeV1).toEqual(before); expect(continued.state.daily.actions).toBe(3);
    const capped = clone(continued.state); capped.daily.actions = 500;
    const view = viewActivities(capped, funds, ctx).nativeWheel;
    expect(view).toMatchObject({ canStart: false, canContinue: false, canProtect: false, canTakeChip: true });
    expect(() => transitionActivity(capped, "wheel-native", { type: "protect", choice: view.roundToken }, ctx, funds, noRandom)).toThrow(/今日玩法次数/);
    const taken = transitionActivity(capped, "wheel-native", { type: "take-chip", choice: view.roundToken }, ctx, funds, noRandom);
    expect(taken.state.daily.actions).toBe(500); expect(taken.state.completed["wheel-native"]).toBe(1); expect(taken.state.completed.wheel).toBeUndefined();
    const exchange = transitionActivity(taken.state, "wheel-native", { type: "exchange", index: 1, count: 1,
      choice: viewActivities(taken.state, funds, ctx).nativeWheel.roundToken }, ctx, funds, noRandom);
    expect(exchange).toMatchObject({ pointsDelta: 0, earnedDelta: 0, rewards: [{ templateId: 11001, count: 1 }] });
    expect(exchange.state.daily.actions).toBe(500);
  });
});
