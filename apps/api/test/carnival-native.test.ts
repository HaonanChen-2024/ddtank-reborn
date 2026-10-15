import { describe, expect, it } from "vitest";
import { advanceCarnivalNative, carnivalNativeLocalRules as L, carnivalNativePrizes, carnivalNativeRecipes,
  readCarnivalNativeState, viewCarnivalNative, type CarnivalNativeState, type CarnivalNativeRanking } from "../src/activities/carnival-native.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext } from "../src/activities/types.js";

const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), signDays: [], ownedTemplateIds: [] };
const wallet = { points: 1000, earned: 40, revision: 0 };
const noRandom = () => { throw new Error("No randomness allowed"); };
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); } return value;
}
function sequence(...numbers: number[]) { let index = 0; return () => { if (index >= numbers.length) throw new Error("Extra randomness"); return numbers[index++]; }; }
const token = (value?: CarnivalNativeState, clock = ctx) => viewCarnivalNative(value, clock, wallet).stateToken;
const draw = (value: CarnivalNativeState | undefined, count = 1, rng = () => 0) => advanceCarnivalNative(frozen(value),
  { type: "draw", count, choice: token(value) }, ctx, frozen(wallet), rng);
function reject(value: CarnivalNativeState | undefined, action: ActivityAction, clock = ctx) {
  const before = structuredClone(value);
  expect(() => advanceCarnivalNative(frozen(value), action, clock, frozen(wallet), noRandom)).toThrow(ActivityError);
  expect(value).toEqual(before);
}

describe("ordinary original carnival local contract", () => {
  it("keeps 12 original prize IDs, 7 recipes, explicit local odds and pure committed projections", () => {
    const view = viewCarnivalNative(undefined, ctx, wallet), again = viewCarnivalNative(undefined, ctx, wallet);
    expect(view).toEqual(again); expect(view).toMatchObject({ started: false, redPackageCount: 0, personalScore: 0, score: 1000,
      remainDrawCount: 100, maxBatchCount: 5, canDraw: true, records: [], day: "2026-10-15",
      startDate: "2026-10-15T00:00:00.000Z", endDate: "2026-10-16T00:00:00.000Z" });
    expect(view.stateToken).toMatch(/^2026-10-15:[A-Za-z0-9_-]{43}$/);
    expect(view.prizes.map(prize => prize.id)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(view.exchange.map(recipe => recipe.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(view.rules).toMatchObject({ probabilityNumerator: 1, probabilityDenominator: 12, drawCost: 10 });
    expect(view.unavailable).toContain("大奖直播原窗口与动画"); expect(view.ranking).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/seed|pending|"pool"/);
    view.prizes[0].itemCount = 999; view.exchange[0].redPacketsCost = 0;
    expect(viewCarnivalNative(undefined, ctx, wallet).prizes[0].itemCount).toBe(1);
    expect(viewCarnivalNative(undefined, ctx, wallet).exchange[0].redPacketsCost).toBe(10);
  });

  it("hits every slot and atomically returns immediate ordinary mail and ordered finite batch effects", () => {
    for (let index = 0; index < 12; index++) {
      const result = draw(undefined, 1, () => (index + 0.5) / 12), prize = carnivalNativePrizes[index];
      expect(result).toMatchObject({ cost: 10, draws: 1, rewards: [{ templateId: prize.templateId, count: prize.itemCount }],
        effects: [{ type: "drawn", prizeId: index + 1, index, drawId: 1, redPackets: prize.redPackets,
          redPackageCount: prize.redPackets, score: 990, batchIndex: 0, batchCount: 1 }] });
      expect(readCarnivalNativeState(result.state)).toEqual(result.state);
    }
    const result = draw(undefined, 5, sequence(0, 0.34, 0.67, 0.99, 0.99));
    expect(result.cost).toBe(50); expect(result.effects.map(effect => effect.type === "drawn" && effect.prizeId)).toEqual([1, 5, 9, 12, 12]);
    expect(result.effects.map(effect => effect.type === "drawn" && effect.score)).toEqual([990, 980, 970, 960, 950]);
    expect(result.rewards).toEqual([{ templateId: 11019, count: 6 }, { templateId: 11002, count: 6 }]);
    expect(result.state.records.map(record => record.drawId)).toEqual([5, 4, 3, 2, 1]);
    expect(result.state.redPacketsEarned).toBe(12);
  });

  it("validates every argument and random sample before allowing any mutation", () => {
    const choice = token();
    for (const action of [{ type: "draw" }, { type: "draw", count: 1 }, { type: "draw", choice },
      { type: "draw", count: 0, choice }, { type: "draw", count: 6, choice }, { type: "draw", count: 1.5, choice },
      { type: "draw", count: "1", choice }, { type: "draw", count: 1, choice, index: 0 },
      { type: "draw", count: 1, choice, price: 0 }, { type: "take", choice },
      { type: "exchange", choice, index: 7, count: 1 }, { type: "exchange", choice, count: 1 },
      { type: "exchange", choice, index: 0, count: 11 }, { type: "exchange", choice, index: 0, count: 1, templateId: 999 },
      { type: "exchange", choice, index: 0, count: 1, mode: "normal" }]) reject(undefined, action as ActivityAction);
    for (const sample of [-1, 1, Infinity, NaN]) expect(() => draw(undefined, 1, () => sample)).toThrow(ActivityError);
    const state = draw(undefined, 5, () => 0.99).state, before = structuredClone(state);
    expect(() => draw(frozen(state), 5, sequence(0.5, NaN))).toThrow(ActivityError); expect(state).toEqual(before);
    expect(() => viewCarnivalNative(undefined, { now: new Date("bad") }, wallet)).toThrow(ActivityError);
    for (const points of [-1, NaN, 2147483648]) expect(() => viewCarnivalNative(undefined, ctx, { points })).toThrow(ActivityError);
  });

  it("fingerprints full day, state, records and recipe balance; rejects late or duplicate exchanges", () => {
    const state = draw(undefined, 5, () => 0.99).state, choice = token(state);
    const action = { type: "exchange", index: 0, count: 1, choice };
    const exchanged = advanceCarnivalNative(frozen(state), action, ctx, wallet, noRandom, 0);
    expect(exchanged).toMatchObject({ cost: 0, draws: 0, rewards: [{ templateId: 11019, count: 5 }],
      effects: [{ type: "exchanged", catalogId: 1, index: 0, count: 1, redPacketsSpent: 10, redPackageCount: 5 }] });
    reject(exchanged.state, action);
    reject(state, action, { ...ctx, now: new Date("2026-10-16T00:00:00Z") });
    // same last draw / count / packet balance but changed historical ID must have a different token.
    const changed = structuredClone(state), prize = carnivalNativePrizes[8];
    changed.records[4] = { ...changed.records[4], prizeId: prize.id, templateId: prize.templateId };
    expect(token(changed)).not.toBe(choice); reject(changed, action);
    const all = draw(draw(undefined, 5, () => 0.99).state, 5, () => 0.99).state;
    for (const recipe of carnivalNativeRecipes) {
      const result = advanceCarnivalNative(all, { type: "exchange", index: recipe.index, count: 1, choice: token(all) }, ctx, wallet, noRandom, 0);
      expect(result.rewards).toEqual([{ templateId: recipe.templateId, count: recipe.itemCount }]);
    }
  });

  it("strictly rejects corrupt saves, foreign dice fields and impossible records", () => {
    const state = draw(undefined, 5, () => 0.99).state;
    for (const value of [null, [], 1, { version: 1, kind: "carnival", rolls: 1, distance: 2, pool: 100 },
      { ...state, extra: 1 }, { ...state, rulesVersion: 2 }, { ...state, drawCount: 1 }, { ...state, redPacketsEarned: 16 },
      { ...state, redPacketsSpent: 16 }, { ...state, redPacketsSpent: 1 }, { ...state, records: [] }, { ...state, records: [{ ...state.records[0], day: "2026-02-30" }, ...state.records.slice(1)] },
      { ...state, records: [{ ...state.records[0], itemCount: 999 }, ...state.records.slice(1)] }]) {
      expect(() => readCarnivalNativeState(value)).toThrow(ActivityError);
    }
    let many: CarnivalNativeState | undefined;
    for (let index = 0; index < 5; index++) many = draw(many, 5, () => 0.99).state;
    expect(many!.records).toHaveLength(20); expect(many!.records.map(record => record.drawId)).toEqual(Array.from({ length: 20 }, (_, index) => 25 - index));
    expect(readCarnivalNativeState(many)).toEqual(many);
  });

  it("preserves old dice, shares wallet and caps actual draws while leaving existing exchange available", () => {
    const input = createActivityState(ctx.now);
    input.games.carnival = { version: 1, kind: "carnival", rolls: 0, distance: 0, pool: 100 };
    input.daily.actions = 495; const original = structuredClone(input);
    const result = transitionActivity(frozen(input), "carnival-native", { type: "draw", count: 5,
      choice: viewActivities(input, wallet, ctx).nativeCarnival.stateToken }, ctx, wallet, () => 0.99);
    expect(input).toEqual(original); expect(result.state.games.carnival).toEqual(original.games.carnival);
    expect(result.state.daily.actions).toBe(500); expect(result.pointsDelta).toBe(-50); expect(result.earnedDelta).toBe(0);
    const capped = viewActivities(result.state, { ...wallet, points: 950 }, ctx).nativeCarnival;
    expect(capped).toMatchObject({ canDraw: false, maxBatchCount: 0, remainDrawCount: 0, redPackageCount: 15 });
    expect(() => transitionActivity(result.state, "carnival-native", { type: "draw", count: 1, choice: capped.stateToken }, ctx, wallet, noRandom)).toThrow(/上限/);
    const exchange = transitionActivity(result.state, "carnival-native", { type: "exchange", index: 0, count: 1, choice: capped.stateToken }, ctx, wallet, noRandom);
    expect(exchange.state.daily.actions).toBe(500); expect(exchange.pointsDelta).toBe(0); expect(exchange.rewards[0].count).toBe(5);
    const partial = structuredClone(input); partial.daily.actions = 498;
    expect(() => transitionActivity(partial, "carnival-native", { type: "draw", count: 5,
      choice: viewActivities(partial, wallet, ctx).nativeCarnival.stateToken }, ctx, wallet, noRandom)).toThrow(/剩余次数不足/);
    expect(() => advanceCarnivalNative(undefined, { type: "draw", count: 5, choice: token() }, ctx, { points: 49 }, noRandom)).toThrow(/积分不足/);
  });

  it("allows packet settlement at draw counter capacity and performs no extra RNG on projection/exchange", () => {
    const state = draw(undefined, 5, () => 0.99).state;
    state.drawCount = L.maxDraws; state.redPacketsEarned = L.maxRedPackets;
    state.records = Array.from({ length: 20 }, (_, index) => ({ ...state.records[0], drawId: L.maxDraws - index }));
    const view = viewCarnivalNative(frozen(state), ctx, wallet, 0); expect(view.canDraw).toBe(false);
    const result = advanceCarnivalNative(state, { type: "exchange", index: 4, count: 10, choice: view.stateToken }, ctx, wallet, noRandom, 0);
    expect(result.state.redPacketsSpent).toBe(200); expect(result.rewards).toEqual([{ templateId: 11019, count: 100 }]);
  });
});

describe("committed local carnival ranking projection", () => {
  const ranking = (): CarnivalNativeRanking => ({ version: 1, kind: "carnival-native-ranking", scope: "local",
    metric: "cumulative-native-draws", entries: [
      { rank: 1, characterId: 100, nickName: "甲", score: 9 },
      { rank: 1, characterId: 101, nickName: "乙", score: 9 },
      { rank: 3, characterId: 102, nickName: "本人", score: 5 },
    ], personalScore: 5, personalRank: 3 });
  const state = () => draw(undefined, 5).state;
  it("clones only the public top entries, keeps competition ranks and never changes the action token", () => {
    const source = frozen(ranking()), saved = frozen(state());
    const view = viewCarnivalNative(saved, { ...ctx, carnivalNativeRanking: source }, wallet);
    expect(view.ranking).toEqual(source); expect(view.ranking).not.toBe(source);
    expect(view.ranking!.entries[0]).not.toBe(source.entries[0]);
    expect(view.ranking!.entries.map(row => row.rank)).toEqual([1, 1, 3]);
    expect(view.stateToken).toBe(viewCarnivalNative(saved, ctx, wallet).stateToken);
    view.ranking!.entries[0].nickName = "changed";
    expect(source.entries[0].nickName).toBe("甲");
    expect(Object.keys(view.ranking!).sort()).toEqual(["version", "kind", "scope", "metric", "entries", "personalScore", "personalRank"].sort());
  });
  it("leaves absent and stale query rankings null while preserving the authoritative actor score", () => {
    const saved = state(), stale = { ...ranking(), personalScore: 4 };
    expect(viewCarnivalNative(saved, ctx, wallet).ranking).toBeNull();
    expect(viewCarnivalNative(saved, { ...ctx, carnivalNativeRanking: stale }, wallet)).toMatchObject({ personalScore: 5, ranking: null });
    expect(viewCarnivalNative(saved, { ...ctx, carnivalNativeRanking: ranking() }, wallet).ranking?.personalRank).toBe(3);
  });
  it("supports an empty genuine zero-score board and a real personal rank beyond the top ten", () => {
    const empty: CarnivalNativeRanking = { ...ranking(), entries: [], personalScore: 0, personalRank: null };
    expect(viewCarnivalNative(undefined, { ...ctx, carnivalNativeRanking: empty }, wallet).ranking).toEqual(empty);
    const outside = ranking(); outside.entries = Array.from({ length: 10 }, (_, index) => ({ rank: index + 1,
      characterId: index + 1, nickName: `角色${index + 1}`, score: 20 - index })); outside.personalRank = 11;
    expect(viewCarnivalNative(state(), { ...ctx, carnivalNativeRanking: outside }, wallet).ranking?.personalRank).toBe(11);
    const tied = ranking(); tied.entries = Array.from({ length: 10 }, (_, index) => ({ rank: 1,
      characterId: index + 1, nickName: `角色${index + 1}`, score: 5 })); tied.personalRank = 1;
    expect(viewCarnivalNative(state(), { ...ctx, carnivalNativeRanking: tied }, wallet).ranking?.personalRank).toBe(1);
  });
  it("rejects malformed, fabricated, duplicate, unordered, zero-score or wrong competition ranks", () => {
    const mutations: ((r: CarnivalNativeRanking) => unknown)[] = [
      r => ({ ...r, scope: "cross-server" }), r => ({ ...r, metric: "payment" }), r => ({ ...r, seed: "private" }),
      r => ({ ...r, entries: Array.from({ length: 11 }, () => r.entries[0]) }),
      r => ({ ...r, entries: [{ ...r.entries[0], accountId: 9 }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [{ ...r.entries[0], score: 0 }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [{ ...r.entries[0], nickName: " " }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [r.entries[1], r.entries[0], r.entries[2]] }),
      r => ({ ...r, entries: [r.entries[0], r.entries[0], r.entries[2]] }),
      r => ({ ...r, entries: [r.entries[0], { ...r.entries[1], rank: 2 }, r.entries[2]] }),
      r => ({ ...r, entries: [r.entries[0], r.entries[1], { ...r.entries[2], rank: 2 }] }),
      r => ({ ...r, personalRank: null }), r => ({ ...r, personalRank: 2 }), r => ({ ...r, entries: [] }),
    ];
    for (const mutate of mutations) expect(() => viewCarnivalNative(state(), {
      ...ctx, carnivalNativeRanking: mutate(ranking()) as CarnivalNativeRanking,
    }, wallet)).toThrow(ActivityError);
  });
});
