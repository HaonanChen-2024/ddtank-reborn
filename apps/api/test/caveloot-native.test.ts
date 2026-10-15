import { describe, expect, it, vi } from "vitest";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { createCaveState, viewCaveLoot, type CaveState, type CaveView } from "../src/activities/caveloot-native.js";
import type { ActivityAction, ActivityContext, ActivityState, ActivityWallet } from "../src/activities/types.js";
const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), characterId: 917, signDays: [], ownedTemplateIds: [] };
const wallet: ActivityWallet = { points: 1000, earned: 40, revision: 0 };
const fresh = () => createActivityState(ctx.now);
const cave = (s: ActivityState) => s.games.cave as CaveState;
const view = (s: ActivityState, w = wallet, context = ctx): CaveView => { const v = viewCaveLoot(s, context, w); if (!v.available) throw Error("Unavailable fixture"); return v; };
const act = (s: ActivityState, action: ActivityAction, w = wallet, rng = () => 0, context = ctx) => transitionActivity(s, "caveloot-native", { ...action, choice: view(s, w, context).stateToken }, context, w, rng);
const ext = () => ({ version: 1 as const, normalDraws: 0, advancedDraws: 0, normalCoins: 0, advancedCoins: 0, claimedExtraProgress: [], shopDay: "2026-10-15", shopBought: [[0, 0, 0, 0], [0, 0, 0, 0]] as [number[], number[]] });
describe("caveloot shared owner and native rules", () => {
  it("projects all four pages read-only with full tokens and 6 finite quote groups", () => {
    const s = fresh(), before = structuredClone(s), v = view(s); expect(s).toEqual(before); expect(v.stateToken).toMatch(/^2026-10-15\.[\w-]{43}$/);
    expect(v).toMatchObject({ started: false, freeRemaining: 3, bagSlotsUsed: 0, actionsRemaining: 500, rank: { rows: [], myRank: null, available: false } });
    expect(v.drawChoices.map(q => [q.tier, q.bundleSize, q.quotes.length, q.maxCount])).toEqual([[1, 1, 5, 5], [1, 3, 1, 1], [1, 5, 1, 1], [2, 1, 5, 5], [2, 3, 1, 1], [2, 5, 1, 1]]);
    expect(v.progress).toHaveLength(11); expect(v.shop).toHaveLength(8); expect(v.types.map(t => t.rows.length)).toEqual([4, 4]); expect(v.unavailable).toHaveLength(4);
    expect(viewActivities(s, wallet, ctx).activities).toHaveLength(17); expect(v.stateToken).toBe(view(s).stateToken);
  });
  it("strictly validates all action fields and finite batch sizes before RNG", () => {
    const s = fresh(), rng = vi.fn(() => 0), token = view(s).stateToken;
    for (const a of [{ type: "draw", tier: 1, index: 0, count: 6 }, { type: "draw", tier: 1, index: 1, count: 2 }, { type: "draw", tier: 1, index: 2, count: 0 }, { type: "draw", tier: 3, index: 0, count: 1 }, { type: "draw", tier: 1, index: 0, count: 1, marked: true }, { type: "take-all", tier: 1, count: 1 }, { type: "progress", tier: 12 }, { type: "buy", tier: 2, index: 0, count: 1.5 }, { type: "take-item", tier: 1, index: 0, count: 1001 }, { type: "exchange", tier: 1 }])
      expect(() => transitionActivity(s, "caveloot-native", { ...a, choice: token } as ActivityAction, ctx, wallet, rng)).toThrow();
    expect(() => transitionActivity(s, "caveloot-native", { type: "draw", tier: 1, index: 0, count: 1 }, ctx, wallet, rng)).toThrow(/令牌/); expect(rng).not.toHaveBeenCalled(); expect(s.games).toEqual({});
  });
  it("preserves old costs, free quota, RNG consumption and shared ten-draw pity", () => {
    let s = fresh(); const rng = vi.fn(() => 0.99);
    const a = transitionActivity(s, "cave", { type: "draw", count: 5 }, ctx, wallet, rng); s = a.state;
    expect(a.pointsDelta).toBe(-30); expect(a.rewards).toEqual([]); expect(s.daily).toMatchObject({ "cave:free": 3, draws: 5, actions: 1 }); expect(cave(s).bag.every(r => r.caveType === 1)).toBe(true);
    const b = transitionActivity(s, "cave", { type: "draw", count: 5, choice: "advanced" }, ctx, wallet, rng);
    expect(b.pointsDelta).toBe(-175); expect(cave(b.state)).toMatchObject({ draws: 10, score: 15, fragments: 10, pity: 0 }); expect(cave(b.state).bag[9]).toMatchObject({ templateId: 11021, count: 4, caveType: 2 }); expect(rng).toHaveBeenCalledTimes(10);
    expect(cave(b.state).native).toBeUndefined(); expect(b.state.completed.cave).toBe(2);
  });
  it("starts extension only on a successful native POST and never backfills typed or mixed history", () => {
    let s = fresh(); s.games.cave = { ...createCaveState(), bag: [{ templateId: 11001, count: 7 }], draws: 20, score: 20 };
    s = transitionActivity(s, "cave", { type: "draw", count: 2 }, ctx, wallet).state; expect(view(s).types[0]!.newDraws).toBe(0); expect(cave(s).native).toBeUndefined();
    s = act(s, { type: "draw", tier: 2, index: 0, count: 1 }).state;
    expect(cave(s).native).toMatchObject({ normalDraws: 0, advancedDraws: 1 }); expect(view(s).legacyBag.itemCount).toBe(7);
    s = transitionActivity(s, "cave", { type: "draw", count: 1 }, ctx, wallet).state; expect(cave(s).native!.normalDraws).toBe(1); expect(cave(s).bag[0]).toEqual({ templateId: 11001, count: 7 });
  });
  it("prechecks whole native batch capacity and cost without RNG or partial quota consumption", () => {
    const s = fresh(), rng = vi.fn(() => 0); s.games.cave = { ...createCaveState(), bag: Array.from({ length: 29 }, () => ({ templateId: 11019, count: 1, caveType: 1 })) };
    expect(() => act(s, { type: "draw", tier: 1, index: 1, count: 1 }, wallet, rng)).toThrow(/空间/); expect(rng).not.toHaveBeenCalled();
    delete s.games.cave; expect(() => act(s, { type: "draw", tier: 2, index: 2, count: 1 }, { ...wallet, points: 174 }, rng)).toThrow(/不足/); expect(rng).not.toHaveBeenCalled(); expect(s.daily).toEqual({});
  });
  it("consumes FIFO partial records preserving unknown fields, types and history", () => {
    const s = fresh(); s.games.cave = { ...createCaveState(), private: { note: "preserve" }, bag: [ { templateId: 11019, count: 3, caveType: 1, x: "old" }, { templateId: 11019, count: 4, caveType: 1, x: "new" }, { templateId: 11019, count: 2, caveType: 2 }, { templateId: 11019, count: 9, x: "history" } ] };
    const r = act(s, { type: "take-item", tier: 1, index: 0, count: 5 }); expect(r.rewards).toEqual([{ templateId: 11019, count: 5, validDays: 0 }]);
    expect(cave(r.state).bag).toEqual([{ templateId: 11019, count: 2, caveType: 1, x: "new" }, { templateId: 11019, count: 2, caveType: 2 }, { templateId: 11019, count: 9, x: "history" }]); expect(cave(r.state).private).toEqual({ note: "preserve" });
    expect(cave(s).bag).toHaveLength(4); expect(view(r.state).bagSlotsUsed).toBe(3);
  });
  it("never awards both minecoins and global points for the same shared bag", () => {
    const s = fresh(); s.games.cave = { ...createCaveState(), bag: [{ templateId: 11019, count: 3, caveType: 1 }, { templateId: 11001, count: 4, caveType: 2 }, { templateId: 11021, count: 2 }] };
    const r = act(s, { type: "recycle-all", tier: 1 }); expect(r.pointsDelta).toBe(0); expect(cave(r.state).native!.normalCoins).toBe(6); expect(cave(r.state).native!.advancedCoins).toBe(0);
    const legacy = transitionActivity(r.state, "cave", { type: "recycle" }, ctx, wallet); expect(legacy.pointsDelta).toBe(12); expect(cave(legacy.state).bag).toEqual([]); expect(cave(legacy.state).native!.normalCoins).toBe(6);
    expect(() => act(legacy.state, { type: "take-all", tier: 2 })).toThrow(/数量/); expect(legacy.earnedDelta).toBe(0);
    const history = act(s, { type: "recycle-legacy" }); expect(history.pointsDelta).toBe(4); expect(cave(history.state).bag).toHaveLength(2); expect(cave(history.state).native!.normalCoins).toBe(0);
  });
  it("shares progress1..3 canonical claims and separates new personal milestones", () => {
    const s = fresh(); s.games.cave = { ...createCaveState(), score: 200, draws: 1000, claimed: [1], native: { ...ext(), normalDraws: 25 } };
    expect(view(s).progress[0]!.canClaim).toBe(false); expect(view(s).personalProgressPercent).toBe(12); expect(view(s).progress[7]!.canClaim).toBe(true); expect(view(s).progress[8]!.canClaim).toBe(false);
    const first = act(s, { type: "progress", tier: 2 }); expect(cave(first.state).claimed).toEqual([1, 2]); expect(() => transitionActivity(first.state, "cave", { type: "progress", tier: 2 }, ctx, wallet)).toThrow(/已经/);
    const second = act(first.state, { type: "progress", tier: 8 }); expect(cave(second.state).native!.claimedExtraProgress).toEqual([8]); expect(second.rewards).toEqual([{ templateId: 11001, count: 4, validDays: 0 }]);
    expect(view(second.state).progress[7]!.canClaim).toBe(false);
  });
  it("allows all earned settlements at500, isolates currencies and resets only shop daily quotas", () => {
    const s = fresh(); s.daily.actions = 500; s.games.cave = { ...createCaveState(), fragments: 10, score: 200, native: { ...ext(), normalCoins: 100, advancedCoins: 120 } };
    expect(() => act(s, { type: "draw", tier: 1, index: 0, count: 1 })).toThrow(/上限/);
    const r = act(s, { type: "buy", tier: 1, index: 0, count: 5 }); expect(cave(r.state).native).toMatchObject({ normalCoins: 50, advancedCoins: 120, shopBought: [[5, 0, 0, 0], [0, 0, 0, 0]] }); expect(r.state.daily.actions).toBe(500); expect(r.pointsDelta).toBe(0); expect(r.state.games.chargeNativeV1).toBeUndefined();
    expect(() => act(r.state, { type: "buy", tier: 1, index: 0, count: 1 })).toThrow(/售罄/); expect(act(r.state, { type: "exchange" }).rewards[0]!.count).toBe(2);
    const tomorrow = { ...ctx, now: new Date("2026-10-16T00:00:00Z") }, v = view(r.state, wallet, tomorrow); expect(v.shop[0]).toMatchObject({ bought: 0, remaining: 5 }); expect(v.freeRemaining).toBe(3); expect(v.actionsRemaining).toBe(500); expect(cave(r.state).native!.shopBought[0][0]).toBe(5);
    expect(() => transitionActivity(r.state, "caveloot-native", { type: "exchange", choice: view(r.state).stateToken }, tomorrow, wallet)).toThrow(/变化/);
  });
  it("preserves unknown/corrupt extensions without rejecting any old cave action", () => {
    for (const unknown of [{ version: 2, secret: "future" }, { ...ext(), normalCoins: -1 }, null]) {
      const s = fresh(); s.games.cave = { ...createCaveState(), native: unknown, fragments: 10, bag: [{ templateId: 11019, count: 3 }] };
      expect(viewCaveLoot(s, ctx, wallet)).toMatchObject({ available: false, stateToken: null }); const copy = structuredClone(s);
      const r = transitionActivity(s, "cave", { type: "draw", count: 1 }, ctx, wallet); expect(cave(r.state).native).toEqual(unknown); expect(s).toEqual(copy);
      expect(() => transitionActivity(s, "caveloot-native", { type: "exchange", choice: `2026-10-15.${"a".repeat(43)}` }, ctx, wallet)).toThrow(/不兼容/); expect(viewActivities(s, wallet, ctx).activities).toHaveLength(17);
    }
    const malformed = fresh(); malformed.games.cave = { version: 999, future: "untouched" };
    expect(viewActivities(malformed, wallet, ctx)).toMatchObject({ nativeCaveLoot: { available: false, stateToken: null } }); expect(malformed.games.cave).toEqual({ version: 999, future: "untouched" });
  });
  it("fingerprints full bag, unknown fields, sidecar, wallet, free quota and day", () => {
    const s = fresh(); s.games.cave = { ...createCaveState(), native: ext(), bag: [{ templateId: 11019, count: 2, caveType: 1, private: { x: 1 } }] }; const old = view(s).stateToken;
    const mutations = [(n: ActivityState) => { cave(n).bag[0]!.private = { x: 2 }; }, (n: ActivityState) => { cave(n).bag[0]!.caveType = 2; }, (n: ActivityState) => { cave(n).native!.normalCoins++; }, (n: ActivityState) => { n.daily["cave:free"] = 2; }, (n: ActivityState) => { n.daily.actions = 1; }];
    for (const mutate of mutations) { const next = structuredClone(s); mutate(next); expect(view(next).stateToken).not.toBe(old); expect(() => transitionActivity(next, "caveloot-native", { type: "take-all", tier: 1, choice: old }, ctx, wallet)).toThrow(/变化/); }
    expect(view(s, { ...wallet, revision: 1 }).stateToken).not.toBe(old); expect(view(s, { ...wallet, earned: 41 }).stateToken).not.toBe(old);
  });
  it("saturates only new extension statistics and still lets old successful draws continue", () => {
    const s = fresh(); s.games.cave = { ...createCaveState(), native: { ...ext(), normalDraws: 1_000_000_000, advancedDraws: 1_000_000_000 } };
    const r = transitionActivity(s, "cave", { type: "draw", count: 1 }, ctx, wallet); expect(cave(r.state).native).toMatchObject({ normalDraws: 1_000_000_000, advancedDraws: 1_000_000_000 }); expect(cave(r.state).draws).toBe(1);
  });
});
