import { describe, expect, it } from "vitest";
import { advanceDevilNative as advance, devilNativeSlots, readDevilNativeState as read, viewDevilNative as project,
  type DevilView, type PrivateDevilState } from "../src/activities/devil-native.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext } from "../src/activities/types.js";
const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), characterId: 915, signDays: [], ownedTemplateIds: [] };
const wallet = { points: 1000, earned: 40, revision: 0 }, noRandom = () => { throw Error("Unexpected randomness"); };
const fresh = () => read(undefined, ctx);
const view = (s: unknown = undefined, remaining = 500, clock = ctx, w = wallet, claims: string[] = []) => project(s, clock, w, remaining, claims) as DevilView;
const act = (s: PrivateDevilState, action: ActivityAction, rng: () => number = noRandom, remaining = 500) => advance(s, { ...action, choice: view(s, remaining).stateToken }, ctx, wallet, rng, remaining);
function sequence(...samples: number[]) { let i = 0; return () => { if (i >= samples.length) throw Error("Extra sample"); return samples[i++]; }; }
function freeze<T>(s: T): T { if (s && typeof s === "object") { Object.values(s).forEach(freeze); Object.freeze(s); } return s; }
function success(box = 0, phase = 1) { const s = fresh(); s.roundSequence = 1; s.activeRound = { id: 1, boxIndex: box as 0 | 1 | 2,
  phase: phase as 1 | 2 | 3 | 4 | 5, state: 2, retries: 0, lastDice: { left: 3, right: 4, sum: 7, success: true } }; return s; }
function history(draws: number) { const s = fresh(); s.draws = draws; s.recentDraws = Array.from({ length: Math.min(10, draws) }, (_, i) => ({ sequence: draws - i,
  prizeId: 1, grant: { kind: "material" as const, reward: { templateId: 11019 as const, count: 1, bound: true as const, validDays: 0 as const } }, marksEarned: 1 })); return s; }
describe("original devil local contract", () => {
  it("projects all original shapes, stable full token and isolated corrupt/future save without writes", () => {
    const s = freeze(fresh()), before = structuredClone(s), v = view(s); expect(v).toEqual(view(s)); expect(s).toEqual(before);
    expect(v.slots).toHaveLength(8); expect(v.boxes).toHaveLength(3); expect(v.shop).toHaveLength(4); expect(v.milestones).toHaveLength(9);
    expect(v.stateToken).toMatch(/^2026-10-15\.[\w-]{43}$/); expect(v.slots.reduce((n, p) => n + p.weight, 0)).toBe(100);
    expect(v.unavailable.map(x => x.id)).toEqual(["reference-economy", "global-jackpot-ranking", "timed-box-expiry"]);
    for (const invalid of [null, {}, { ...s, version: 2 }, { ...s, kind: "devil" }, { ...s, marks: -1 }, { ...s, beads: [1] }, { ...s, activeRound: undefined }]) {
      expect(project(invalid, ctx, wallet)).toMatchObject({ available: false, stateToken: null });
      expect(() => advance(invalid, { type: "free-turn", choice: v.stateToken }, ctx, wallet, noRandom)).toThrow(ActivityError);
    }
  });
  it("preserves unknown owner/root fields and legacy single-die progress while exposing no private fields", () => {
    const s = fresh(); s.futurePrivate = { seed: "never-public" }; const a = act(freeze(s), { type: "free-turn" });
    expect(a.state.futurePrivate).toEqual(s.futurePrivate); expect(JSON.stringify(view(a.state))).not.toContain("never-public");
    const root = createActivityState(ctx.now); root.games.devil = { version: 1, kind: "devil", round: 2, phase: "active", multiplier: 4, lastDie: 3 };
    root.games.keep = { value: "preserve" }; const next = transitionActivity(root, "devil-native", { type: "free-turn", choice: view().stateToken }, ctx, wallet);
    expect(next.state.games.devil).toEqual(root.games.devil); expect(next.state.games.keep).toEqual(root.games.keep);
    const bad = structuredClone(root); bad.games.devilNativeV1 = { version: 2 };
    expect(viewActivities(bad, wallet, ctx).nativeDevil).toMatchObject({ available: false });
    expect(transitionActivity(bad, "devil", { type: "take" }, ctx, wallet).rewards).toEqual([{ templateId: 11019, count: 4 }]);
  });
  it("grants one daily free turn, buys one/ten once and resets only UTC daily fields", () => {
    const free = act(fresh(), { type: "free-turn" }); expect(free).toMatchObject({ cost: 0, countedActions: 0, state: { turns: 1, freeClaimed: true } });
    expect(() => act(free.state, { type: "free-turn" })).toThrow();
    for (const n of [1, 10]) expect(act(free.state, { type: "buy-turns", count: n })).toMatchObject({ cost: n * 20, countedActions: 1, state: { turns: n + 1 } });
    const clock = { ...ctx, now: new Date("2026-10-16T00:00:00Z") }, saved = free.state; saved.shopBought[0] = 10; saved.marks = 33; saved.beads[2] = 5;
    expect(project(saved, clock, wallet)).toMatchObject({ day: "2026-10-16", freeAvailable: true, marks: 33, beads: [0, 0, 5, 0, 0], shop: Array.from({ length: 4 }, () => ({ boughtToday: 0 })) });
    expect(saved.day).toBe("2026-10-15");
  });
  it("covers all eight weighted slots, all five beads, ordered finite batches and no post-draw charge", () => {
    let threshold = 0;
    for (const slot of devilNativeSlots) {
      const s = fresh(); s.turns = 1; const rng = sequence((threshold + slot.weight / 2) / 100, 0.99), result = act(s, { type: "draw", count: 1 }, rng);
      expect(result.cost).toBe(0); expect(result.countedActions).toBe(1); expect(result.state.draws).toBe(1); expect(result.state.turns).toBe(0);
      expect(result.state.recentDraws[0].prizeId).toBe(slot.prizeId); expect(read(result.state, ctx)).toEqual(result.state); threshold += slot.weight;
    }
    for (let bead = 0; bead < 5; bead++) { const s = fresh(); s.turns = 1; expect(act(s, { type: "draw", count: 1 }, sequence(0.5, (bead + 0.5) / 5)).state.beads[bead]).toBe(1); }
    const s = fresh(); s.turns = 10; const a = act(freeze(s), { type: "draw", count: 10 }, () => 0);
    expect(a.rewards).toHaveLength(10); expect(a.state.recentDraws.map(r => r.sequence)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(a.effects[0]).toMatchObject({ type: "drawn", results: Array.from({ length: 10 }, (_, i) => expect.objectContaining({ sequence: i + 1 })) });
    expect(s.turns).toBe(10); expect(() => act(s, { type: "draw", count: 10 }, sequence(0, NaN))).toThrow(); expect(s.draws).toBe(0);
  });
  it("exchanges exact five-bead recipes, reserves one box and restores an active round without a second open", () => {
    for (let index = 0; index < 3; index++) { const s = fresh(); s.beads = [9, 9, 9, 9, 9]; const a = act(s, { type: "convert-box", index }, noRandom, 0);
      expect(a.state.boxes[index]).toBe(1); expect(a.countedActions).toBe(0); expect(a.state.beads).toEqual(s.beads.map((n, i) => n - view(s).boxes[index].beadCosts[i]));
      const opened = act(a.state, { type: "open-box", index }, noRandom, 0); expect(opened.state.boxes[index]).toBe(0);
      expect(view(opened.state, 0).round).toMatchObject({ id: 1, phase: 1, state: 1, canRoll: false });
      expect(() => act(opened.state, { type: "open-box", index })).toThrow(); expect(read(opened.state, ctx)).toEqual(opened.state);
    }
  });
  it("checks every one of the 36 ordered dice pairs at all five phases", () => {
    const counts: number[] = [];
    for (let phase = 1; phase <= 5; phase++) { let won = 0;
      for (let left = 1; left <= 6; left++) for (let right = 1; right <= 6; right++) {
        const s = success(0, phase); s.activeRound!.state = 1; s.activeRound!.lastDice = null;
        const result = act(s, { type: "roll-dice" }, sequence((left - 0.5) / 6, (right - 0.5) / 6)), dice = result.state.activeRound!.lastDice!;
        expect(dice).toMatchObject({ left, right, sum: left + right }); expect(dice.sum).toBeGreaterThanOrEqual(2); expect(dice.sum).toBeLessThanOrEqual(12);
        if (dice.success) won++; expect(result.countedActions).toBe(1); expect(read(result.state, ctx)).toEqual(result.state);
      } counts.push(won);
    } expect(counts).toEqual([36, 34, 30, 24, 16]);
  });
  it("keeps success continuation free, charges failed retry once and settles only the current successful tier", () => {
    const s = success(), continued = act(s, { type: "continue-dice" }, noRandom, 0); expect(continued).toMatchObject({ cost: 0, countedActions: 0, state: { activeRound: { phase: 2, state: 1 } } });
    expect(() => act(continued.state, { type: "take-box" })).toThrow();
    const failed = act(continued.state, { type: "roll-dice" }, () => 0); expect(failed.state.activeRound!.state).toBe(3);
    expect(act(failed.state, { type: "continue-dice" })).toMatchObject({ cost: 10, countedActions: 1, state: { activeRound: { phase: 2, state: 1, retries: 1 } } });
    expect(act(failed.state, { type: "abandon-box" }, noRandom, 0)).toMatchObject({ rewards: [], state: { activeRound: null } });
    for (let box = 0; box < 3; box++) { const s5 = success(box, 5), taken = act(s5, { type: "take-box" }, noRandom, 0);
      expect(taken.rewards[0].count).toBe(8); expect(taken.state.marks).toBe((box + 1) * 10); expect(taken.state.activeRound).toBeNull();
      expect(() => act(s5, { type: "continue-dice" })).toThrow(); expect(() => act(taken.state, { type: "take-box" })).toThrow();
    }
  });
  it("reserves maximum marks so capacity cannot strand a successful round at the integer limit", () => {
    const max = 2147483647, s = fresh(); s.boxes[2] = 1; s.marks = max - 30;
    const opened = act(s, { type: "open-box", index: 2 }).state; expect(view(opened).drawMaxCount).toBe(0);
    const awarded = { ...opened, activeRound: success(2, 5).activeRound }; expect(act(awarded, { type: "take-box" }, noRandom, 0).state.marks).toBe(max);
    s.marks++; expect(view(s).boxes[2].canOpen).toBe(false); expect(() => act(s, { type: "open-box", index: 2 })).toThrow();
    const roundLimit = fresh(); roundLimit.boxes[0] = 1; roundLimit.roundSequence = max; expect(() => act(roundLimit, { type: "open-box", index: 0 })).toThrow();
    expect(roundLimit.boxes[0]).toBe(1);
  });
  it("keeps nine once-only milestones and daily mark shop available at 500 with strict quantity limits", () => {
    let s = history(1000); for (let index = 0; index < 9; index++) { const a = act(s, { type: "claim-milestone", index }, noRandom, 0);
      expect(a.claimKey).toBe(`devil-native:milestone:${index + 1}`); expect(a.countedActions).toBe(0); s = a.state;
      expect(() => act(s, { type: "claim-milestone", index }, noRandom, 0)).toThrow(); }
    s.marks = 1000; const bought = act(s, { type: "buy-item", index: 0, count: 10 }, noRandom, 0); expect(bought).toMatchObject({ cost: 0, countedActions: 0, rewards: [{ templateId: 11019, count: 30 }], state: { marks: 850 } });
    expect(view(bought.state, 0).shop[0].maxCount).toBe(0); expect(() => act(bought.state, { type: "buy-item", index: 0, count: 1 })).toThrow();
    expect(view(history(10), 0, ctx, wallet, ["devil-native:milestone:1"]).milestones[0].canClaim).toBe(false);
  });
  it("rejects every unexpected field, wrong index/count/token and invalid random sample without mutating input", () => {
    const s = freeze(fresh()), before = structuredClone(s), token = view(s).stateToken;
    const bad = [{ type: "free-turn", choice: token, count: 1 }, { type: "free-turn" }, { type: "draw", count: 0, choice: token },
      { type: "buy-turns", count: 2, choice: token }, { type: "convert-box", index: -1, choice: token }, { type: "open-box", index: 3, choice: token },
      { type: "claim-milestone", index: 9, choice: token }, { type: "buy-item", index: 0, count: 1.5, choice: token }, { type: "free-turn", choice: token, marked: true },
      { type: "start", choice: token }, { type: "free-turn", choice: token, templateId: 12772 }];
    for (const a of bad) expect(() => advance(s, a as ActivityAction, ctx, wallet, noRandom)).toThrow(ActivityError); expect(s).toEqual(before);
    const funded = fresh(); funded.turns = 1; for (const n of [-1, 1, Infinity, NaN]) expect(() => act(funded, { type: "draw", count: 1 }, () => n)).toThrow();
  });
  it("fingerprints wallet, role, day, shared allowance, canonical claims and all saved extensions", () => {
    const s = fresh(), token = view(s).stateToken;
    for (const v of [view(s, 499), view(s, 500, { ...ctx, characterId: 916 }), view(s, 500, { ...ctx, now: new Date("2026-10-16Z") }),
      view(s, 500, ctx, { ...wallet, revision: 1 }), view(s, 500, ctx, { ...wallet, earned: 41 }), view(s, 500, ctx, wallet, ["claimed"]), view({ ...s, unknown: 1 })]) expect(v.stateToken).not.toBe(token);
  });
  it("counts finite paid actions and gross exactly once while cap settlements do not change legacy or task progress", () => {
    let root = createActivityState(ctx.now); const before = viewActivities(root, wallet, ctx).nativeDevil as DevilView;
    const bought = transitionActivity(root, "devil-native", { type: "buy-turns", count: 10, choice: before.stateToken }, ctx, wallet);
    expect(bought.pointsDelta).toBe(-200); expect(bought.earnedDelta).toBe(0); expect(bought.state.daily.actions).toBe(1);
    expect(bought.state.games.chargeNativeV1).toMatchObject({ grossSpent: 200 }); root = bought.state;
    const w = { ...wallet, points: 800, revision: 1 }; const drawn = transitionActivity(root, "devil-native", { type: "draw", count: 10, choice: (viewActivities(root, w, ctx).nativeDevil as DevilView).stateToken }, ctx, w, () => 0);
    expect(drawn.state.daily.actions).toBe(11); expect(drawn.state.daily.draws).toBeUndefined(); expect(drawn.nativeDevilEffects).toHaveLength(1);
    drawn.state.daily.actions = 500; const capped = viewActivities(drawn.state, w, ctx).nativeDevil as DevilView;
    const claim = transitionActivity(drawn.state, "devil-native", { type: "claim-milestone", index: 0, choice: capped.stateToken }, ctx, w);
    expect(claim.state.daily.actions).toBe(500); expect(claim.state.claims).toContain("devil-native:milestone:1");
  });
});
