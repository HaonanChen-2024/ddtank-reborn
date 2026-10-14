import { describe, expect, it } from "vitest";
import { advanceMinesNative, createMinesNative, minesNativeLocalRules, viewMinesNative, type MinesNativeState } from "../src/activities/mines-native.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityWallet } from "../src/activities/types.js";

const last = () => 0.99;
const ctx = (day = "2026-10-15"): ActivityContext => ({ now: new Date(`${day}T12:00:00Z`), signDays: [], ownedTemplateIds: [] });
const funds = (points = 1000): ActivityWallet => ({ points, earned: 0, revision: 0 });
const copy = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const act = (s: MinesNativeState, action: ActivityAction, points = 1000, clock = ctx()) => advanceMinesNative(freeze(s), action, clock, funds(points), last);
function walked(count: number) {
  let s = createMinesNative(ctx(), last);
  for (let index = 0; index < count; index++) s = act(s, { type: "walk", index }).state;
  return s;
}
function rejected(s: MinesNativeState, action: ActivityAction, points = 1000, clock = ctx()) {
  const before = copy(s); expect(() => act(s, action, points, clock)).toThrow(ActivityError); expect(s).toEqual(before);
}
function started(value: ReturnType<typeof viewMinesNative>) {
  if (!value.started) throw new Error("board not started");
  return value;
}

describe("independent native 70-cell mines rules", () => {
  it("keeps opening read-only and exposes only opened or explicitly probed cell facts", () => {
    expect(viewMinesNative(undefined, ctx())).toMatchObject({ started: false, localRules: { width: 10, height: 7, manualClaims: true } });
    let s = createMinesNative(ctx(), last);
    const before = copy(s), v = started(viewMinesNative(freeze(s), ctx()));
    expect(v.cells).toHaveLength(70); expect(v.currentIndex).toBeNull();
    expect(v.cells.every(c => !Object.hasOwn(c, "mine") && !Object.hasOwn(c, "aroundMineCount"))).toBe(true);
    expect(s).toEqual(before); expect(JSON.stringify(v)).not.toMatch(/"(?:board|mines|opened|marked|probed|claimed)"\s*:\[/);
    s = act(s, { type: "walk", index: 50 }).state;
    const moved = started(viewMinesNative(s, ctx()));
    expect(moved.cells[50]).toMatchObject({ opened: true, mine: false, aroundMineCount: 2 });
    expect(moved.cells.filter(c => !c.opened).every(c => !Object.hasOwn(c, "mine") && !Object.hasOwn(c, "aroundMineCount"))).toBe(true);
    s = act(s, { type: "probe" }).state;
    const probed = started(viewMinesNative(s, ctx())), revealed = probed.cells.filter(c => c.probed);
    expect(revealed).toHaveLength(1); expect(revealed[0]).toMatchObject({ mine: true, opened: false });
    expect(revealed[0]).not.toHaveProperty("aroundMineCount"); expect(s.board.mines).toHaveLength(10);
  });

  it("guarantees the local first-open safety rule and does not mutate rejected inputs", () => {
    const s = createMinesNative(ctx(), last), original = copy(s);
    expect(s.board.mines).toContain(69);
    const opened = act(s, { type: "walk", index: 69 });
    expect(s).toEqual(original); expect(opened.state.board.mines).not.toContain(69);
    expect(opened.state.board.lives).toBe(3); expect(opened.rewards).toEqual([]);
    for (const action of [{ type: "walk", index: -1 }, { type: "walk", index: 70 }, { type: "walk", index: 0.5 },
      { type: "mark", index: 1 }, { type: "start", choice: "free" }, { type: "claim", choice: "1" },
      { type: "constructor" }, { type: "walk", index: 0, count: 2 }]) rejected(s, action);
    expect(() => advanceMinesNative(undefined, { type: "start" }, ctx(), funds(), () => NaN)).toThrow();
    expect(() => viewMinesNative(undefined, { now: new Date("invalid") })).toThrow(ActivityError);
  });

  it("revisits an opened safe cell by moving only, never counts a second reveal or reward", () => {
    const s = walked(10), before = copy(s), r = act(s, { type: "walk", index: 0 });
    expect(r.state.board.position).toBe(0); expect(r.state.board.opened).toEqual(before.board.opened);
    expect(r.effects).toEqual([{ type: "walked", round: 1, index: 0, previousIndex: 9, newlyOpened: false, aroundMineCount: 0, openCount: 10 }]);
    expect(r.rewards).toEqual([]); expect(r.cost).toBe(0); expect(r.completed).toBe(false); expect(s).toEqual(before);
    rejected(r.state, { type: "walk", index: 0 });
    rejected(s, { type: "mark", index: 0, marked: true });
    const marked = act(s, { type: "mark", index: 20, marked: true }).state;
    rejected(marked, { type: "walk", index: 20 }); rejected(marked, { type: "mark", index: 20, marked: true });
    expect(act(marked, { type: "mark", index: 20, marked: false }).state.board.marked).toEqual([]);
  });

  it("has a single manual claim owner for all three milestones and protects unclaimed rewards on reset", () => {
    let s = createMinesNative(ctx(), last);
    for (let index = 0; index < 60; index++) {
      const r = act(s, { type: "walk", index }); s = r.state;
      expect(r.rewards).toEqual([]); expect(r.completed).toBe(false);
      if (index === 9 || index === 29) rejected(s, { type: "reset", choice: "free" });
    }
    expect(started(viewMinesNative(s, ctx())).claims.every(c => c.eligible && !c.claimed)).toBe(true);
    expect(s.board.status).toBe("won"); rejected(s, { type: "reset", choice: "points" });
    for (const tier of [1, 2, 3]) {
      const r = act(s, { type: "claim", tier }); s = r.state;
      expect(r.rewards).toEqual([{ templateId: 11019, count: tier }]); expect(r.completed).toBe(true);
      rejected(s, { type: "claim", tier });
    }
    expect(started(viewMinesNative(s, ctx())).canFreeReset).toBe(true);
    const reset = act(s, { type: "reset", choice: "free" });
    expect(reset.state).toMatchObject({ claimed: [], dailyRounds: 2, freeResets: 0, board: { round: 2, opened: [], lives: 3 } });
    expect(reset.rewards).toEqual([]);
  });

  it("checks point budgets before probe/revive/reset and enforces daily and round caps", () => {
    let s = act(createMinesNative(ctx(), last), { type: "walk", index: 50 }).state;
    rejected(s, { type: "probe" }, 4);
    const probed = act(s, { type: "probe" }, 5); expect(probed.cost).toBe(5); s = probed.state;
    for (const index of [60, 61, 62]) s = act(s, { type: "walk", index }).state;
    expect(s.board).toMatchObject({ status: "lost", lives: 0 });
    rejected(s, { type: "revive" }, 14);
    const revived = act(s, { type: "revive" }, 15); expect(revived.cost).toBe(15); s = revived.state;
    expect(s.board).toMatchObject({ status: "playing", lives: 3, revivesUsed: 1 });
    for (const index of [63, 64, 65]) s = act(s, { type: "walk", index }).state;
    rejected(s, { type: "revive" }); s = act(s, { type: "reset", choice: "free" }).state;
    s = act(s, { type: "walk", index: 0 }).state;
    rejected(s, { type: "reset", choice: "free" }); rejected(s, { type: "reset", choice: "points" }, 9);
    const paid = act(s, { type: "reset", choice: "points" }, 10); expect(paid.cost).toBe(10); s = paid.state;
    s = act(s, { type: "walk", index: 0 }).state; rejected(s, { type: "reset", choice: "points" });
    expect(started(viewMinesNative(s, ctx())).roundsRemaining).toBe(0);
    const before = copy(s), tomorrow = started(viewMinesNative(s, ctx("2026-10-16")));
    expect(tomorrow).toMatchObject({ round: 3, openCount: 1, freeResetCount: 1, roundsRemaining: 3 }); expect(s).toEqual(before);
    s = act(s, { type: "reset", choice: "free" }, 0, ctx("2026-10-16")).state;
    expect(s).toMatchObject({ day: "2026-10-16", dailyRounds: 1, board: { round: 4 } });
    rejected(s, { type: "walk", index: 0 }, 1000, ctx("2026-10-15"));
  });

  it("rejects malformed or incompatible private saves instead of repairing or leaking them", () => {
    const original = walked(10);
    const cases = [(s: MinesNativeState) => { s.rulesVersion = 2 as 1; }, (s: MinesNativeState) => { s.board.options.width = 6; },
      (s: MinesNativeState) => { s.board.mines[0] = s.board.mines[1]; }, (s: MinesNativeState) => { s.board.opened.push(70); },
      (s: MinesNativeState) => { s.board.lives = 2; }, (s: MinesNativeState) => { s.claimed.push(2); },
      (s: MinesNativeState) => { s.board.rewardStepsReached = []; }, (s: MinesNativeState) => { s.board.probed = [0]; },
      (s: MinesNativeState) => { s.board.position = 22; }, (s: MinesNativeState) => { s.board.status = "won"; },
      (s: MinesNativeState) => { s.day = "2026-02-31"; }, (s: MinesNativeState) => { s.board.round = 3; }];
    for (const mutate of cases) { const s = copy(original); mutate(s); const before = copy(s);
      expect(() => viewMinesNative(s, ctx())).toThrow(ActivityError); expect(() => act(s, { type: "walk", index: 11 })).toThrow(ActivityError); expect(s).toEqual(before); }
    expect(() => viewMinesNative({ version: 1, mines: [] }, ctx())).toThrow(ActivityError);
    expect(minesNativeLocalRules.rewards.map(p => p.requiredOpenCount)).toEqual([10, 30, 60]);
  });

  it("preserves old 36-cell state, shares the existing task owner, and permits earned claims at the play cap", () => {
    let s = createActivityState(ctx().now);
    s = transitionActivity(s, "mines", { type: "start" }, ctx(), funds(), last).state;
    const old = copy(s.games.mines);
    s = transitionActivity(s, "mines-native", { type: "start" }, ctx(), funds(), last).state;
    for (let index = 0; index < 10; index++) s = transitionActivity(s, "mines-native", { type: "walk", index }, ctx(), funds(), last).state;
    expect(s.games.mines).toEqual(old); expect(s.daily.safe).toBe(10); expect(s.completed["mines-native"]).toBeUndefined();
    expect(viewActivities(s, funds(), ctx()).tasks.find(t => t.id === "mines")).toMatchObject({ current: 8, target: 8 });
    const revisit = transitionActivity(s, "mines-native", { type: "walk", index: 0 }, ctx(), funds(), last);
    s = revisit.state; expect(s.daily.safe).toBe(10); expect(revisit.rewards).toEqual([]);
    s.daily.actions = 500;
    expect(() => transitionActivity(s, "mines-native", { type: "walk", index: 11 }, ctx(), funds(), last)).toThrow(ActivityError);
    const claim = transitionActivity(s, "mines-native", { type: "claim", tier: 1 }, ctx(), funds(0), last);
    expect(claim.state.daily.actions).toBe(500); expect(claim.state.completed["mines-native"]).toBe(1);
    expect(claim.rewards).toEqual([{ templateId: 11019, count: 1 }]); expect(claim.state.games.mines).toEqual(old);
    expect(viewActivities(claim.state, funds(), ctx()).activities).toHaveLength(17);
  });
});
