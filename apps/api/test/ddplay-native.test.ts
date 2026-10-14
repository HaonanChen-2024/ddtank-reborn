import { describe, expect, it } from "vitest";
import { advanceDDPlayNative, viewDDPlayNative } from "../src/activities/ddplay-native.js";
import { advanceChanceGame, viewChanceGame } from "../src/activities/chance-games.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext } from "../src/activities/types.js";

const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), signDays: [], ownedTemplateIds: [] };
const wallet = { points: 100, earned: 40, revision: 3 };
const noRandom = () => { throw new Error("Unexpected random draw"); };
const sequence = (...values: number[]) => { let index = 0; return () => {
  if (index >= values.length) throw new Error("Unexpected extra random draw"); return values[index++];
}; };
const roll = (faces: number[]) => sequence(...faces.map(face => (face + 0.5) / 6));

describe("original DDPlay local projection and shared legacy save", () => {
  it("uses the existing six-face engine and deterministically projects every multiplier onto the three original reels", () => {
    for (const [faces, multiplier, reels] of [
      [[0, 1, 2], 0, [1, 2, 3]], [[1, 2, 1], 2, [1, 2, 1]], [[0, 0, 0], 3, [1, 1, 1]],
      [[3, 3, 3], 5, [2, 2, 2]], [[5, 5, 5], 10, [3, 3, 3]],
    ] as const) {
      const result = advanceDDPlayNative(undefined, { type: "spin" }, wallet, roll([...faces]));
      expect(result.state).toEqual(advanceChanceGame("ddplay", undefined, { type: "spin" }, roll([...faces])).state);
      expect(result).toMatchObject({ cost: 10, points: 10 * multiplier, rewards: [], completed: true,
        effects: [{ type: "spun", multiplier, reels: [...reels], pointsDelta: 10 * multiplier - 10,
          spins: 1, score: 90 + 10 * multiplier, cost: 10, pointsAwarded: 10 * multiplier }] });
      const before = JSON.stringify(result.state), restored = JSON.parse(before);
      const view = viewDDPlayNative(restored, { points: 90 + 10 * multiplier });
      expect(view.lastResult).toEqual({ multiplier, reels: [...reels] }); expect(JSON.stringify(restored)).toBe(before);
      expect(view).not.toHaveProperty("faces"); expect(view).not.toHaveProperty("effects");
      expect(view.localRules.description).toContain("非参考服或官方赔率");
    }
  });

  it("keeps spin costs, stored progress, completion counters and old web rules identical across both entry points", () => {
    const initial = createActivityState(ctx.now);
    initial.games.ddplay = { version: 1, kind: "ddplay", spins: 7, faces: [0, 0, 0] };
    initial.completed.ddplay = 7; initial.games.unrelated = { untouched: true };
    const before = structuredClone(initial);
    const native = transitionActivity(initial, "ddplay-native", { type: "spin" }, ctx, wallet, roll([5, 5, 5]));
    const old = transitionActivity(initial, "ddplay", { type: "spin" }, ctx, wallet, roll([5, 5, 5]));
    expect(native.state.games).toEqual(old.state.games); expect(native.state.daily).toEqual(old.state.daily);
    expect(native.state.completed).toEqual(old.state.completed); expect(native).toMatchObject({ pointsDelta: 90, earnedDelta: 0, rewards: [] });
    expect(initial).toEqual(before); expect(native.state.games).not.toHaveProperty("ddplayNativeV1");
    const projected = viewActivities(native.state, { ...wallet, points: 190 }, ctx);
    expect(projected.activities.find(activity => activity.id === "ddplay")!.stats).toEqual(viewChanceGame("ddplay", native.state.games.ddplay).stats);
    expect(projected.nativeDDPlay).toMatchObject({ spins: 8, score: 190, lastResult: { multiplier: 10 } });
  });

  it("rejects extra or inherited action fields, coercions and invalid counts before randomness or mutation", () => {
    const initial = { version: 1, kind: "ddplay", spins: 1, faces: [1, 1, 2] }, before = structuredClone(initial);
    const bad = [null, [], {}, { type: "spin", count: 1 }, { type: "spin", index: 0 },
      { type: "exchange" }, { type: "exchange", count: 0 }, { type: "exchange", count: 11 },
      { type: "exchange", count: 1.5 }, { type: "exchange", count: "1" }, { type: "exchange", count: 1, choice: "11019" },
      Object.create({ type: "spin" }), Object.assign(Object.create({ count: 1 }), { type: "exchange" })];
    for (const action of bad) expect(() => advanceDDPlayNative(initial, action as ActivityAction, wallet, noRandom)).toThrow(ActivityError);
    for (const points of [-1, 1.5, NaN, Infinity, 2_147_483_648]) expect(() => advanceDDPlayNative(initial, { type: "exchange", count: 1 }, { points }, noRandom)).toThrow(ActivityError);
    expect(initial).toEqual(before);
  });

  it("exchanges a single allowed ordinary material, changes no last result and preserves old spin count", () => {
    const initial = { version: 1, kind: "ddplay", spins: 12, faces: [3, 3, 3] }, before = structuredClone(initial);
    const result = advanceDDPlayNative(initial, { type: "exchange", count: 10 }, wallet, noRandom);
    expect(result).toMatchObject({ cost: 100, points: 0, completed: false, state: initial, rewards: [{ templateId: 11019, count: 10 }],
      effects: [{ type: "exchanged", count: 10, cost: 100, templateId: 11019, itemCount: 10, score: 0 }] });
    expect(initial).toEqual(before); expect(result.state).not.toBe(initial);
    expect(viewDDPlayNative(result.state, { points: 0 })).toMatchObject({ spins: 12, canSpin: false, canExchange: false, lastResult: { multiplier: 5 } });
    expect(() => advanceDDPlayNative(initial, { type: "exchange", count: 2 }, { points: 19 }, noRandom)).toThrow(/积分不足/);
    expect(() => advanceDDPlayNative(initial, { type: "spin" }, { points: 9 }, noRandom)).toThrow(/积分不足/);
  });

  it("bounds balances and stored spin counts and does not expose or generate future results on read", () => {
    const initial = { version: 1, kind: "ddplay", spins: 999_999_999, faces: [5, 5, 5] };
    const last = advanceDDPlayNative(initial, { type: "spin" }, wallet, roll([0, 1, 2]));
    expect(viewDDPlayNative(last.state, { points: 90 })).toMatchObject({ spins: 1_000_000_000, canSpin: false, canExchange: true });
    expect(() => advanceDDPlayNative(last.state, { type: "spin" }, wallet, noRandom)).toThrow(/次数已达上限/);
    expect(() => advanceDDPlayNative(undefined, { type: "spin" }, { points: 2_147_483_647 }, roll([5, 5, 5]))).toThrow(/积分超过上限/);
    for (const value of [null, { version: 2, kind: "ddplay" }, { version: 1, kind: "ddplay", spins: 1, faces: [1, 1, 6] },
      { version: 1, kind: "ddplay", spins: 1, faces: Array(3) }]) expect(() => viewDDPlayNative(value, wallet)).toThrow(ActivityError);
    const empty = viewDDPlayNative(undefined, wallet);
    expect(empty).toMatchObject({ spins: 0, lastResult: null, score: 100, spinCost: 10, exchange: { templateId: 11019, cost: 10, maxCount: 10, itemCount: 1 } });
    expect(JSON.stringify(empty)).not.toMatch(/seed|nextFaces|games|effects/);
  });

  it("blocks new spins at the daily ceiling while still settling an existing points balance", () => {
    const state = createActivityState(ctx.now); state.daily.actions = 500;
    state.games.ddplay = { version: 1, kind: "ddplay", spins: 1, faces: [1, 2, 3] };
    expect(() => transitionActivity(state, "ddplay-native", { type: "spin" }, ctx, wallet, noRandom)).toThrow(/今日玩法次数/);
    expect(viewActivities(state, wallet, ctx).nativeDDPlay).toMatchObject({ canSpin: false, canExchange: true, lastResult: { multiplier: 0 } });
    const exchanged = transitionActivity(state, "ddplay-native", { type: "exchange", count: 1 }, ctx, wallet, noRandom);
    expect(exchanged.state.daily.actions).toBe(500); expect(exchanged.state.completed).toEqual(state.completed);
  });
});
