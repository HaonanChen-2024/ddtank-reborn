import { describe, expect, it } from "vitest";
import { advancePairNative, createPairNative, pairNativeLocalRules as L, viewPairNative, type PairNativeState } from "../src/activities/pair-native.js";
import { ActivityError, type ActivityAction } from "../src/activities/types.js";

const ctx = { now: new Date("2026-10-14T01:00:00Z") };
const funds = { points: 1000 };
const rng = () => 0.31;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
const create = () => createPairNative(ctx, rng);
const act = (state: unknown, action: ActivityAction, points = 1000) => advancePairNative(state, action, ctx, { points }, rng);
const finish = (state = create()) => act(state, { type: "flip-all", choice: "points" });
const reset = (state: PairNativeState) => act(state, { type: "reset", choice: "free" }).state;
function rejectsWithoutMutation(state: PairNativeState, action: ActivityAction, points = 1000) {
  const before = clone(state);
  expect(() => act(freeze(state), action, points)).toThrow(ActivityError);
  expect(state).toEqual(before);
}

describe("native PairBox local state", () => {
  it("requires explicit start and projects no hidden deck or unearned pairing partners", () => {
    expect(viewPairNative(undefined, ctx)).toMatchObject({ started: false, localRules: { slots: 32 } });
    const started = act(undefined, { type: "start" });
    expect(started.cost).toBe(0); expect(started.rewards).toEqual([]);
    expect(started.effects).toEqual([{ type: "started", round: 1 }]);
    const state = freeze(started.state), before = clone(state), view = viewPairNative(state, ctx);
    expect(view).toEqual(viewPairNative(createPairNative(ctx, () => 0.9), ctx));
    expect(view.started && view.cards).toEqual(Array.from({ length: 32 }, (_, i) => ({ pos: i + 1, ID: -1, isGet: false, otherPos: 0 })));
    expect(JSON.stringify(view)).not.toMatch(/hiddenDeck|revealed|matches|shuffleSeed/);
    expect(state).toEqual(before);
    expect(L.prizes.map(p => p.templateId)).toEqual([11019, 11001, 11021, 11002]);
    expect(new Set(state.hiddenDeck).size).toBe(4);
    for (const prize of L.prizes) expect(state.hiddenDeck.filter(id => id === prize.id)).toHaveLength(8);
    rejectsWithoutMutation(clone(state), { type: "start" });
  });

  it("keeps mismatched revealed cards visible and refuses re-flip or hide", () => {
    let state = create();
    const first = 1, second = state.hiddenDeck.findIndex(id => id !== state.hiddenDeck[0]) + 1;
    state = act(state, { type: "flip", index: first }).state;
    state = act(state, { type: "flip", index: second }).state;
    const view = viewPairNative(state, ctx);
    expect(view.started && view.hiddenRemaining).toBe(30);
    expect(view.started && view.cards.filter(c => c.ID > 0)).toHaveLength(2);
    expect(view.started && view.cards.filter(c => c.isGet)).toHaveLength(0);
    expect(state.freeReels).toBe(30);
    rejectsWithoutMutation(clone(state), { type: "flip", index: first });
    rejectsWithoutMutation(clone(state), { type: "hide" });
  });

  it("pairs on the server once, projects reciprocal positions and grants one reward per pair", () => {
    let state = create();
    const positions = state.hiddenDeck.flatMap((id, i) => id === state.hiddenDeck[0] ? [i + 1] : []);
    let rewards = 0;
    for (let i = 0; i < positions.length; i++) {
      const result = act(state, { type: "flip", index: positions[i] }); state = result.state;
      expect(result.rewards.length).toBe(i % 2 === 0 ? 0 : 1);
      expect(result.effects.filter(e => e.type === "matched").length).toBe(i % 2 === 0 ? 0 : 1);
      rewards += result.rewards.length;
    }
    expect(rewards).toBe(4); expect(state.marks).toBe(4); expect(state.totalMatchedPairs).toBe(4);
    const view = viewPairNative(state, ctx);
    if (!view.started) throw new Error("expected started view");
    for (const [a, b] of state.matches) {
      expect(view.cards[a - 1]).toMatchObject({ isGet: true, otherPos: b });
      expect(view.cards[b - 1]).toMatchObject({ isGet: true, otherPos: a });
    }
    for (const pos of positions) rejectsWithoutMutation(clone(state), { type: "flip", index: pos });
  });

  it("uses identical single/batch reveal logic, costs, effects and completion", () => {
    const original = reset(finish().state); // No free reels remain; explicit points are needed.
    const batch = act(freeze(clone(original)), { type: "flip-all", choice: "points" });
    let state = original, cost = 0; const rewards = [], effects = [];
    for (let pos = 1; pos <= 32; pos++) {
      const step = act(state, { type: "flip", index: pos, choice: "points" }, funds.points - cost);
      expect(step.completed).toBe(pos === 32);
      state = step.state; cost += step.cost; rewards.push(...step.rewards); effects.push(...step.effects);
    }
    expect(batch.state).toEqual(state); expect(batch.cost).toBe(64); expect(batch.cost).toBe(cost);
    expect(batch.rewards).toEqual(rewards); expect(batch.effects).toEqual(effects); expect(batch.completed).toBe(true);
    expect(batch.rewards).toHaveLength(16);
    expect(batch.state.marks).toBe(32);
    rejectsWithoutMutation(clone(state), { type: "flip-all", choice: "points" });
  });

  it("spends free reels then bought reels, and never silently buys or spends points", () => {
    let state = reset(finish().state);
    rejectsWithoutMutation(clone(state), { type: "flip", index: 1 });
    rejectsWithoutMutation(clone(state), { type: "flip-all" });
    const purchase = act(state, { type: "buy-reels", count: 3 });
    expect(purchase.cost).toBe(6); expect(purchase.rewards).toEqual([]);
    state = purchase.state;
    const partial = act(state, { type: "flip-all", choice: "tickets" }, 0);
    expect(partial.cost).toBe(0); expect(partial.state.revealed).toHaveLength(3); expect(partial.state.reels).toBe(0);
    expect(partial.effects.filter(e => e.type === "revealed").map(e => e.consume)).toEqual(["reel", "reel", "reel"]);
    rejectsWithoutMutation(clone(partial.state), { type: "flip", index: 4 });
    const explicit = act(partial.state, { type: "flip", index: 4, choice: "points" }, 2);
    expect(explicit.cost).toBe(2);
    expect(explicit.effects[0]).toMatchObject({ type: "revealed", consume: "points" });
    const fresh = act(act(create(), { type: "buy-reels", count: 1 }).state, { type: "flip", index: 1 });
    expect(fresh.state.freeReels).toBe(31); expect(fresh.state.reels).toBe(1);
  });

  it("preflights full batch budgets and purchases without partially changing state", () => {
    const state = reset(finish().state);
    rejectsWithoutMutation(clone(state), { type: "flip-all", choice: "points" }, 63);
    rejectsWithoutMutation(clone(state), { type: "flip", index: 1, choice: "points" }, 1);
    rejectsWithoutMutation(clone(state), { type: "buy-reels", count: 3 }, 5);
    rejectsWithoutMutation(clone(state), { type: "buy-reels", count: 65 });
    const capped = act(state, { type: "buy-reels", count: 64 }).state;
    rejectsWithoutMutation(clone(capped), { type: "buy-reels", count: 1 });
    const flipCapped = { ...clone(state), daily: { ...state.daily, flips: 96 } };
    rejectsWithoutMutation(flipCapped, { type: "flip", index: 1, choice: "points" });
  });

  it("requires completed boards and explicit reset mode, with bounded free and paid resets", () => {
    rejectsWithoutMutation(create(), { type: "reset", choice: "free" });
    const done = finish().state;
    rejectsWithoutMutation(clone(done), { type: "reset" });
    const second = act(done, { type: "reset", choice: "free" });
    expect(second.cost).toBe(0); expect(second.state.freeResets).toBe(0);
    expect(second.state.freeReels).toBe(0); expect(second.state.round).toBe(2);
    expect(second.state.marks).toBe(16); expect(second.state.totalMatchedPairs).toBe(16);
    const doneSecond = finish(second.state).state;
    rejectsWithoutMutation(clone(doneSecond), { type: "reset", choice: "free" });
    rejectsWithoutMutation(clone(doneSecond), { type: "reset", choice: "points" }, 9);
    const third = act(doneSecond, { type: "reset", choice: "points" }, 10);
    expect(third.cost).toBe(10); expect(third.state.round).toBe(3);
    const doneThird = finish(third.state).state;
    expect(doneThird.daily.flips).toBe(96);
    rejectsWithoutMutation(clone(doneThird), { type: "reset", choice: "points" });
  });

  it("exchanges marks only on an explicit bounded request and grants no automatic exchange", () => {
    const state = finish().state, before = clone(state);
    viewPairNative(freeze(state), ctx); expect(state).toEqual(before); expect(state.marks).toBe(16);
    const result = act(state, { type: "exchange", choice: "11019", count: 2 });
    expect(result.cost).toBe(0); expect(result.state.marks).toBe(8);
    expect(result.rewards).toEqual([{ templateId: 11019, count: 2 }]);
    expect(result.effects).toEqual([{ type: "exchanged", templateId: 11019, count: 2, marksSpent: 8 }]);
    rejectsWithoutMutation(create(), { type: "exchange", choice: "11019" });
    rejectsWithoutMutation(clone(state), { type: "exchange", choice: "999999" });
    rejectsWithoutMutation(clone(state), { type: "exchange", choice: "11019", count: 11 });
    rejectsWithoutMutation(clone(state), { type: "exchange", choice: "11002", count: 3 });
  });

  it("projects a new day without writes, carries purchased reels/marks and refreshes only in the committed result", () => {
    const state = freeze(act(finish().state, { type: "buy-reels", count: 2 }).state), before = clone(state);
    const tomorrow = { now: new Date("2026-10-15T01:00:00Z") };
    const view = viewPairNative(state, tomorrow);
    expect(view).toMatchObject({ freeReelCount: 32, reelCount: 2, markCount: 16, freeResetCount: 1, todayBuyCount: 0, roundsRemaining: 3 });
    expect(state).toEqual(before);
    const next = advancePairNative(state, { type: "reset", choice: "free" }, tomorrow, funds, rng).state;
    expect(next.day).toBe("2026-10-15"); expect(next.daily).toEqual({ rounds: 1, flips: 0, reelsBought: 0 });
    expect(next.freeReels).toBe(32); expect(next.reels).toBe(2); expect(next.marks).toBe(16);
    expect(() => viewPairNative(next, ctx)).toThrow(ActivityError);
  });

  it("caps carried reels and rejects a late overflow atomically", () => {
    let state = act(create(), { type: "buy-reels", count: 64 }).state;
    const tomorrow = { now: new Date("2026-10-15T01:00:00Z") };
    state = advancePairNative(state, { type: "buy-reels", count: 32 }, tomorrow, funds, rng).state;
    const before = clone(state);
    expect(() => advancePairNative(freeze(state), { type: "buy-reels", count: 1 }, tomorrow, funds, rng)).toThrow(ActivityError);
    expect(state).toEqual(before); expect(state.reels).toBe(96);
    const saturated = create(); saturated.round = 6251; saturated.marks = 100_000; saturated.totalMatchedPairs = 100_000;
    rejectsWithoutMutation(saturated, { type: "flip-all" });
  });

  it("round-trips server saves and public JSON, with no returned aliases to the input", () => {
    const state = act(create(), { type: "flip", index: 1 }).state, before = clone(state);
    expect(viewPairNative(clone(state), ctx)).toEqual(viewPairNative(state, ctx));
    expect(clone(viewPairNative(state, ctx))).toEqual(viewPairNative(state, ctx));
    const publicView = viewPairNative(state, ctx);
    if (publicView.started) publicView.cards[0].ID = 99;
    publicView.localRules.prizes[0].name = "朱雀石1级";
    expect(state).toEqual(before); expect(L.prizes[0].name).toBe("强化石1级");
    const next = act(state, { type: "buy-reels", count: 1 }).state;
    next.hiddenDeck[0] = 99; next.revealed.push(32); next.daily.flips = 95;
    expect(state).toEqual(before);
  });

  it("rejects legacy saves, corrupt decks, impossible pairings and invalid numeric state", () => {
    const bad: unknown[] = [null, [], {}, { version: 1, cards: [], flipped: [], matched: [], status: "playing" },
      { ...create(), kind: "pair" }, { ...create(), rulesVersion: 2 }, { ...create(), day: "2026-02-30" },
      { ...create(), hiddenDeck: Array(32).fill(1) }, { ...create(), hiddenDeck: Array(32) },
      { ...create(), revealed: [1, 1] }, { ...create(), revealed: [0] }, { ...create(), revealed: Array(1) },
      { ...create(), matches: [[1, 2]] }, { ...create(), matches: Array(1) },
      { ...create(), freeReels: -1 }, { ...create(), reels: 97 }, { ...create(), marks: 1 },
      { ...create(), totalMatchedPairs: NaN }, { ...create(), totalMatchedPairs: 1 }, { ...create(), round: Infinity },
      { ...create(), daily: { rounds: 4, flips: 0, reelsBought: 0 } },
      { ...create(), daily: { rounds: 1, flips: 97, reelsBought: 0 } },
    ];
    for (const value of bad) {
      expect(() => viewPairNative(value, ctx)).toThrow(ActivityError);
      expect(() => act(value, { type: "flip", index: 1 })).toThrow(ActivityError);
    }
    expect(() => viewPairNative(undefined, { now: new Date(NaN) })).toThrow(ActivityError);
  });

  it("rejects malformed action/funds and invalid RNG without changing a completed save", () => {
    const state = create();
    for (const action of [{ type: "flip", index: 0 }, { type: "flip", index: 33 }, { type: "flip", index: 1.5 },
      { type: "flip", index: 1, choice: "cash" }, { type: "flip-all", count: 1 }, { type: "buy-reels", count: 0 },
      { type: "reset", choice: "auto" }, { type: "claim" }, { type: "flip", index: 1, marked: true }]) {
      rejectsWithoutMutation(clone(state), action);
    }
    for (const points of [-1, NaN, Infinity]) rejectsWithoutMutation(clone(state), { type: "flip", index: 1 }, points);
    for (const value of [-0.1, 1, NaN, Infinity]) expect(() => createPairNative(ctx, () => value)).toThrow(ActivityError);
    const done = freeze(finish().state), before = clone(done);
    expect(() => advancePairNative(done, { type: "reset", choice: "free" }, ctx, funds, () => NaN)).toThrow(ActivityError);
    expect(done).toEqual(before);
  });
});
