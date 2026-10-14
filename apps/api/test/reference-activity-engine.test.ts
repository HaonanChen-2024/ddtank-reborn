import { describe, expect, it } from "vitest";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityState, type ActivityWallet } from "../src/activities/types.js";
import type { MinesweeperState } from "../src/activities/minesweeper.js";

const first = () => 0, last = () => 0.999999;
const restore = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const context = (when = "2026-10-14T12:00:00Z", signDays: string[] = []): ActivityContext => ({ now: new Date(when), signDays, ownedTemplateIds: [] });
const wallet = (points = 1000, earned = 0): ActivityWallet => ({ points, earned, revision: 0 });
function session(ctx = context(), funds = wallet()) {
  let state = createActivityState(ctx.now), currentWallet = { ...funds };
  return {
    get state() { return state; }, get wallet() { return currentWallet; },
    act(id: string, action: ActivityAction, rng = first, currentContext = ctx) {
      const result = transitionActivity(freeze(state), id, action, currentContext, freeze(currentWallet), rng);
      state = restore(result.state);
      currentWallet = { points: currentWallet.points + result.pointsDelta, earned: currentWallet.earned + result.earnedDelta, revision: currentWallet.revision + 1 };
      return result;
    },
    view(currentContext = ctx) { return viewActivities(freeze(state), freeze(currentWallet), currentContext); },
  };
}
function rejected(state: ActivityState, id: string, action: ActivityAction, funds: ActivityWallet, ctx = context(), rng = first) {
  const before = restore(state), walletBefore = { ...funds };
  expect(() => transitionActivity(freeze(state), id, action, ctx, freeze(funds), rng)).toThrow(ActivityError);
  expect(state).toEqual(before);
  expect(funds).toEqual(walletBefore);
}

describe("activity engine atomic state and wallet boundary", () => {
  it("rejects insufficient funds without consuming state, daily counts, rewards or the supplied wallet", () => {
    const state = createActivityState(context().now), funds = wallet(0);
    for (const [id, action] of [["moon", { type: "draw" }], ["treasure", { type: "draw" }],
      ["ddplay", { type: "spin" }], ["exchange", { type: "exchange", index: 0 }]] as const)
      rejected(state, id, action, funds);
    expect(state).toEqual(createActivityState(context().now));
  });

  it("rejects a whole five-draw batch even after tentative free draws and one affordable draw", () => {
    const state = createActivityState(context().now);
    rejected(state, "cave", { type: "draw", count: 5 }, wallet(15));
    expect(state.games.cave).toBeUndefined();
    expect(state.daily["cave:free"]).toBeUndefined();
    rejected(state, "moon", { type: "draw", count: 5 }, wallet(80));
    let draws = 0;
    rejected(state, "moon", { type: "draw", count: 5 }, wallet(100), context(), () => ++draws === 4 ? NaN : 0);
    expect(draws).toBe(4);
    const retry = transitionActivity(state, "cave", { type: "draw", count: 3 }, context(), wallet(0), first);
    expect(retry.pointsDelta).toBe(0);
    expect(retry.state.daily["cave:free"]).toBe(3);
  });

  it("makes temporary-bag take and recycle mutually exclusive, including after JSON reload", () => {
    for (const id of ["treasure", "moon", "cave"]) for (const choice of ["take", "recycle"]) {
      const run = session();
      const draw = run.act(id, { type: "draw", count: 2 });
      expect(draw.rewards).toEqual([]);
      const resolved = run.act(id, { type: choice });
      expect(resolved.earnedDelta).toBe(0);
      if (choice === "take") { expect(resolved.rewards.map(reward => [reward.templateId, reward.count])).toEqual([[11019, 1], [11019, 1]]); expect(resolved.pointsDelta).toBe(0); }
      else { expect(resolved.rewards).toEqual([]); expect(resolved.pointsDelta).toBe(4); }
      for (const type of ["take", "recycle"]) rejected(restore(run.state), id, { type }, run.wallet);
      expect((run.state.games[id] as { bag: unknown[] }).bag).toEqual([]);
    }
  });

  it("applies milestones, fragments, pity and each progress reward at most once", () => {
    const run = session();
    run.act("moon", { type: "draw", count: 5 });
    run.act("moon", { type: "draw", count: 5 });
    const bag = run.state.games.moon as { bag: { templateId: number; count: number }[]; pity: number; fragments: number; score: number };
    expect(bag.bag[9]).toEqual({ templateId: 11021, count: 2 });
    expect(bag).toMatchObject({ pity: 0, fragments: 10, score: 10 });
    expect(run.act("moon", { type: "exchange" }).rewards).toEqual([{ templateId: 11021, count: 2 }]);
    rejected(run.state, "moon", { type: "exchange" }, run.wallet);
    expect(run.act("moon", { type: "progress", tier: 1 }).rewards).toEqual([{ templateId: 11019, count: 2 }]);
    rejected(run.state, "moon", { type: "progress", tier: 1 }, run.wallet);
    rejected(run.state, "moon", { type: "progress", tier: 2 }, run.wallet);
    expect(run.act("moon", { type: "take" }).rewards).toHaveLength(10);
  });

  it("rejects an advanced Moon draw rather than doubling its prize for the ordinary price", () => {
    rejected(createActivityState(context().now), "moon", { type: "draw", choice: "advanced" }, wallet());
  });
});

describe("activity engine daily tasks and permanent gifts", () => {
  it("uses the exact stored day boundary, resets daily progress, and does not reset permanent claims or bags", () => {
    const before = context("2026-10-14T23:59:59.999Z", ["2026-10-14", "2026-10-15"]);
    const after = context("2026-10-15T00:00:00.000Z", before.signDays);
    const run = session(before, wallet(0));
    run.act("tasks", { type: "claim", choice: "sign" });
    run.act("cave", { type: "draw", count: 3 });
    const saved = restore(run.state), observed = run.view(after);
    expect(observed.day).toBe("2026-10-15");
    expect(observed.tasks.find(task => task.id === "sign")).toMatchObject({ current: 1, claimed: false });
    expect(observed.tasks.find(task => task.id === "explore")).toMatchObject({ current: 0, claimed: false });
    expect(run.state).toEqual(saved);
    rejected(run.state, "tasks", { type: "claim", choice: "sign" }, run.wallet, before);
    const next = run.act("tasks", { type: "claim", choice: "sign" }, first, after);
    expect(next).toMatchObject({ pointsDelta: 40, earnedDelta: 40 });
    expect(next.state.claims).toContain("task:2026-10-14:sign");
    expect(next.state.claims).toContain("task:2026-10-15:sign");
    expect((next.state.games.cave as { bag: unknown[] }).bag).toHaveLength(3);
    expect(run.act("cave", { type: "draw", count: 3 }, first, after).pointsDelta).toBe(0);
  });

  it("counts only task awards toward earned, never bag recycling or slot returns", () => {
    const ctx = context("2026-10-14T12:00:00Z", ["2026-10-14"]), run = session(ctx, wallet(100));
    expect(run.act("tasks", { type: "claim", choice: "sign" })).toMatchObject({ pointsDelta: 40, earnedDelta: 40 });
    rejected(run.state, "tasks", { type: "claim", choice: "sign" }, run.wallet, ctx);
    run.act("cave", { type: "draw", count: 3 });
    expect(run.act("tasks", { type: "claim", choice: "explore" })).toMatchObject({ pointsDelta: 40, earnedDelta: 40 });
    expect(run.act("cave", { type: "recycle" })).toMatchObject({ pointsDelta: 6, earnedDelta: 0 });
    expect(run.act("ddplay", { type: "spin" }, last)).toMatchObject({ pointsDelta: 90, earnedDelta: 0 });
    expect(run.wallet.earned).toBe(80);
    expect(run.wallet.points).toBeGreaterThan(100);
    rejected(run.state, "points-gift", { type: "claim", tier: 1 }, run.wallet, ctx);
    expect(run.act("tasks", { type: "claim", choice: "sign" }, first, context("2026-10-15T12:00:00Z", ["2026-10-15"])).earnedDelta).toBe(40);
    const gift = run.act("points-gift", { type: "claim", tier: 1 }, first, context("2026-10-15T12:00:00Z"));
    expect(gift).toMatchObject({ pointsDelta: 0, earnedDelta: 0, rewards: [{ templateId: 11019, count: 3 }] });
    rejected(run.state, "points-gift", { type: "claim", tier: 1 }, run.wallet, context("2026-10-16T12:00:00Z"));
  });

  it("unlocks first-gift through an actual minesweeper milestone and permits it only once per character", () => {
    const run = session();
    rejected(run.state, "first-gift", { type: "claim" }, run.wallet);
    run.act("mines", { type: "start" });
    const layout = run.state.games.mines as MinesweeperState;
    const safe = Array.from({ length: 36 }, (_, index) => index).filter(index => !layout.mines.includes(index));
    for (const index of safe.slice(0, 8)) run.act("mines", { type: "open", index });
    expect(run.state.completed.mines).toBe(1);
    const gift = run.act("first-gift", { type: "claim" });
    expect(gift.rewards).toEqual([{ templateId: 11019, count: 5 }, { templateId: 11021, count: 1 }]);
    expect(gift.pointsDelta).toBe(0);
    rejected(run.state, "first-gift", { type: "claim" }, run.wallet);
    rejected(restore(run.state), "first-gift", { type: "claim" }, run.wallet, context("2026-10-15T12:00:00Z"));
  });
});

describe("daily play limit never strands earned rewards", () => {
  const capped = (state: ActivityState, actions = 500) => {
    const saved = restore(state); saved.daily.actions = actions; return saved;
  };

  it("does not count 499 wardrobe page changes, set browsing or mode/category switches as play", () => {
    const run = session();
    run.act("cave", { type: "draw" });
    for (let i = 0; i < 499; i++) run.act("wardrobe", { type: "page", index: i % 2, choice: "sets" });
    const select = run.view().activities.find(a => a.id === "wardrobe")!.cells![0].action!;
    expect(select.type).toBe("select-set");
    run.act("wardrobe", select);
    run.act("wardrobe", { type: "directory" });
    for (const choice of ["mark", "open"]) run.act("mines", { type: "mode", choice });
    run.act("treasure", { type: "category", choice: "强化石1级" });
    expect(run.state.daily.actions).toBe(1);
    expect(run.act("cave", { type: "take" })).toMatchObject({ pointsDelta: 0, rewards: [{ templateId: 11019, count: 1 }] });
    expect(run.state.daily.actions).toBe(1);
    const atLimit = capped(run.state);
    for (const [id, action] of [["wardrobe", { type: "page", index: 0, choice: "owned" }],
      ["mines", { type: "mode", choice: "mark" }], ["treasure", { type: "category", choice: "强化石1级" }]] as const) {
      const result = transitionActivity(freeze(atLimit), id, action, context(), freeze(run.wallet));
      expect(result).toMatchObject({ pointsDelta: 0, earnedDelta: 0, rewards: [], state: { daily: { actions: 500 } } });
    }
  });

  it("can take or recycle each existing bag at or above the old cap, but cannot do either twice", () => {
    for (const id of ["treasure", "moon", "cave"]) for (const type of ["take", "recycle"]) {
      const run = session(); run.act(id, { type: "draw", count: 2 });
      const saved = capped(run.state, 501), before = restore(saved);
      const result = transitionActivity(freeze(saved), id, { type }, context(), freeze(run.wallet));
      expect(saved).toEqual(before);
      expect(result.state.daily.actions).toBe(501);
      expect(result.earnedDelta).toBe(0);
      if (type === "take") { expect(result.rewards).toHaveLength(2); expect(result.pointsDelta).toBe(0); }
      else { expect(result.rewards).toEqual([]); expect(result.pointsDelta).toBe(4); }
      for (const again of ["take", "recycle"]) rejected(result.state, id, { type: again }, run.wallet);
    }
  });

  it("settles only the fragments and progress already earned, with their original depletion checks", () => {
    for (const id of ["treasure", "moon", "cave"]) {
      const run = session();
      run.act(id, { type: "draw", count: 5 }); run.act(id, { type: "draw", count: 5 });
      const progress = transitionActivity(capped(run.state), id, { type: "progress", tier: 1 }, context(), run.wallet);
      expect(progress.rewards).toEqual([{ templateId: 11019, count: 2 }]);
      rejected(progress.state, id, { type: "progress", tier: 1 }, run.wallet);
      rejected(progress.state, id, { type: "progress", tier: 2 }, run.wallet);
      const exchange = transitionActivity(progress.state, id, { type: "exchange" }, context(), run.wallet);
      expect(exchange.rewards).toEqual([{ templateId: 11021, count: 2 }]);
      expect(exchange.state.daily.actions).toBe(500);
      expect((exchange.state.games[id] as { fragments: number }).fragments).toBe(0);
      rejected(exchange.state, id, { type: "exchange" }, run.wallet);
    }
  });

  it("allows eligible tasks and gift tiers at the cap without relaxing their eligibility or once-only claims", () => {
    const ctx = context("2026-10-14T12:00:00Z", ["2026-10-14"]), run = session(ctx, wallet(1000, 1000));
    run.act("mines", { type: "start" }, last);
    for (let index = 0; index < 8; index++) run.act("mines", { type: "open", index });
    run.act("cave", { type: "draw", count: 3 });
    let state = capped(run.state);
    const eligible: [string, ActivityAction][] = [
      ...["sign", "mines", "explore"].map(choice => ["tasks", { type: "claim", choice }] as [string, ActivityAction]),
      ["first-gift", { type: "claim" }],
      ...["points-gift", "luxury"].flatMap(id => [1, 2, 3].map(tier => [id, { type: "claim", tier }] as [string, ActivityAction])),
    ];
    for (const [id, action] of eligible) {
      const result = transitionActivity(freeze(state), id, action, ctx, run.wallet);
      expect(result.state.daily.actions).toBe(500);
      if (id === "tasks") expect(result.earnedDelta).toBeGreaterThan(0);
      else expect(result.rewards.length).toBeGreaterThan(0);
      state = result.state;
      rejected(state, id, action, run.wallet, ctx);
    }
    rejected(state, "tasks", { type: "claim", choice: "pair" }, run.wallet, ctx);
    const unearned = capped(createActivityState(ctx.now));
    for (const id of ["first-gift", "points-gift", "luxury"]) rejected(unearned, id, { type: "claim", tier: 1 }, wallet(1000), ctx);
  });

  it("allows one chance-game settlement or giveup at the cap, without permitting a new round", () => {
    for (const id of ["wheel", "devil"]) {
      const run = session(); run.act(id, { type: "start" });
      const result = transitionActivity(capped(run.state), id, { type: "take" }, context(), run.wallet);
      expect(result.rewards).toEqual([{ templateId: 11019, count: 1 }]);
      expect(result.state.daily.actions).toBe(500);
      rejected(result.state, id, { type: "take" }, run.wallet);
      rejected(result.state, id, { type: "start" }, run.wallet);
    }
    const run = session(); run.act("devil", { type: "start" });
    const givenUp = transitionActivity(capped(run.state), "devil", { type: "giveup" }, context(), run.wallet);
    expect(givenUp).toMatchObject({ pointsDelta: 0, rewards: [], state: { daily: { actions: 500 } } });
    rejected(givenUp.state, "devil", { type: "take" }, run.wallet);
    rejected(givenUp.state, "devil", { type: "giveup" }, run.wallet);
  });

  it("delivers already found snowmen after expiration and the play cap, exactly once", () => {
    const run = session(); run.act("christmas", { type: "start" }, last);
    run.act("christmas", { type: "open", index: 0 });
    const expired = context("2026-10-14T12:30:00Z");
    const result = transitionActivity(capped(run.state), "christmas", { type: "take" }, expired, run.wallet);
    expect(result.rewards).toEqual([{ templateId: 11019, count: 1 }]);
    expect(result.state.daily.actions).toBe(500);
    rejected(result.state, "christmas", { type: "take" }, run.wallet, expired);
    rejected(result.state, "christmas", { type: "start" }, run.wallet, expired);
  });

  it("blocks every new-play route at 500 before spending or randomness, then resets only daily counters", () => {
    const run = session(); run.act("cave", { type: "draw" });
    const lastAction = transitionActivity(capped(run.state, 499), "ddplay", { type: "spin" }, context(), run.wallet, last);
    expect(lastAction.state.daily.actions).toBe(500);
    const state = freeze(lastAction.state), before = restore(state), funds = freeze(run.wallet);
    const actions: [string, ActivityAction][] = [
      ...["treasure", "moon", "cave"].map(id => [id, { type: "draw", count: 1 }] as [string, ActivityAction]),
      ["cave", { type: "draw", count: 5 }], ["gypsy", { type: "refresh" }], ["gypsy", { type: "buy", index: 0 }],
      ["exchange", { type: "exchange", index: 0 }],
      ...["start", "restart", "open", "probe", "revive", "mark"].map(type => ["mines", { type, index: 0, marked: true }] as [string, ActivityAction]),
      ...["start", "restart", "flip", "hide"].map(type => ["pair", { type, index: 0 }] as [string, ActivityAction]),
      ...["start", "continue", "protect"].map(type => ["wheel", { type }] as [string, ActivityAction]),
      ...["start", "continue"].map(type => ["devil", { type }] as [string, ActivityAction]),
      ["ddplay", { type: "spin" }], ["carnival", { type: "roll" }],
      ...["start", "open", "extend"].map(type => ["christmas", { type, index: 0 }] as [string, ActivityAction]),
    ];
    for (const [id, action] of actions) expect(() => transitionActivity(state, id, action, context(), funds,
      () => { throw new Error("A capped action must not consume randomness"); })).toThrow("今日玩法次数已达上限");
    expect(state).toEqual(before);
    const tomorrow = transitionActivity(state, "cave", { type: "draw" }, context("2026-10-15T12:00:00Z"), funds, first);
    expect(tomorrow).toMatchObject({ pointsDelta: 0, state: { day: "2026-10-15", daily: { actions: 1, "cave:free": 1 } } });
    expect((tomorrow.state.games.cave as { bag: unknown[] }).bag).toHaveLength(2);
  });
});

describe("activity view is playable without revealing server secrets", () => {
  it("does not disclose unopened mine locations, hidden cards, or hidden snowmen", () => {
    const run = session();
    for (const id of ["mines", "pair", "christmas"]) run.act(id, { type: "start" }, last);
    const snapshot = run.view();
    expect(snapshot).not.toHaveProperty("games");
    expect(snapshot.activities.find(activity => activity.id === "mines")?.cells?.every(cell => cell.label === "？" && cell.tone === "hidden")).toBe(true);
    expect(snapshot.activities.find(activity => activity.id === "pair")?.cells?.every(cell => cell.label === "？" && cell.tone === "hidden")).toBe(true);
    expect(snapshot.activities.find(activity => activity.id === "christmas")?.cells?.every(cell => cell.label === "雪块" && cell.tone === "hidden")).toBe(true);
    const before = restore(run.state);
    snapshot.history.push("view mutation");
    expect(run.state).toEqual(before);
  });

  it("provides visible mark/unmark operations so a marked minesweeper cell cannot trap the UI", () => {
    const run = session();
    run.act("mines", { type: "start" });
    const board = () => run.view().activities.find(activity => activity.id === "mines")!;
    expect(board().cells?.[6].action).toEqual({ type: "open", index: 6 });
    const markMode = board().actions.find(button => button.action.type === "mode" && button.action.choice === "mark");
    expect(markMode).toBeDefined();
    expect(markMode!.disabled).not.toBe(true);
    run.act("mines", markMode!.action);
    const mark = board().cells?.[6].action;
    expect(mark).toEqual({ type: "mark", index: 6, marked: true });
    run.act("mines", mark!);
    expect(board().cells?.[6]).toMatchObject({ label: "旗", action: { type: "mark", index: 6, marked: false } });
    const openMode = board().actions.find(button => button.action.type === "mode" && button.action.choice === "open");
    expect(openMode).toBeDefined();
    run.act("mines", openMode!.action);
    const unmark = board().cells?.[6].action;
    expect(unmark).toEqual({ type: "mark", index: 6, marked: false });
    run.act("mines", unmark!);
    expect(board().cells?.[6]).toMatchObject({ label: "？", action: { type: "open", index: 6 } });
    run.act("mines", board().cells![6].action!);
    expect((run.state.games.mines as MinesweeperState).opened).toContain(6);
  });

  it("uses the selected treasure category to constrain the actual draw pool", () => {
    const run = session();
    const categories = run.view().activities.find(activity => activity.id === "treasure")!.actions
      .filter(button => button.action.type === "category").map(button => button.action.choice!);
    expect(categories).toHaveLength(4);
    expect(categories).toContain("强化石1级");
    for (const choice of categories.filter(choice => choice !== "强化石1级")) run.act("treasure", { type: "category", choice });
    run.act("treasure", { type: "draw" }, () => 0.6);
    const bag = run.state.games.treasure as { choices: string[]; bag: { templateId: number }[] };
    expect(bag.choices).toEqual(["强化石1级"]);
    expect(bag.bag[0].templateId).toBe(11019);
    rejected(run.state, "treasure", { type: "draw", choice: "advanced" }, run.wallet);
  });
});

describe("gypsy inventory and free refresh day", () => {
  it("persists a sold-out item across reload/day change and resets stock only on a new refresh", () => {
    const ctx = context(), next = context("2026-10-15T12:00:00Z"), run = session(ctx);
    expect(run.act("gypsy", { type: "refresh" }, last).pointsDelta).toBe(0);
    const offers = (run.state.games.gypsy as { offers: { price: number; templateId: number; count: number }[] }).offers;
    expect(offers).toHaveLength(3);
    const bought = run.act("gypsy", { type: "buy", index: 0 });
    expect(bought.pointsDelta).toBe(-offers[0].price);
    expect(bought.rewards).toEqual([{ templateId: offers[0].templateId, count: offers[0].count }]);
    rejected(restore(run.state), "gypsy", { type: "buy", index: 0 }, run.wallet);
    rejected(run.state, "gypsy", { type: "buy", index: 0 }, run.wallet, next);
    expect(run.view(next).activities.find(activity => activity.id === "gypsy")?.cells?.[0].action).toBeUndefined();
    expect(run.act("gypsy", { type: "refresh" }, last, next).pointsDelta).toBe(0);
    expect(run.act("gypsy", { type: "refresh" }, last, next).pointsDelta).toBe(-5);
    expect(run.act("gypsy", { type: "buy", index: 0 }, first, next).rewards).toHaveLength(1);
  });

  it("rejects invalid refresh randomness instead of persisting a corrupt or incomplete offer", () => {
    for (const bad of [-0.1, 1, NaN, Infinity])
      rejected(createActivityState(context().now), "gypsy", { type: "refresh" }, wallet(), context(), () => bad);
  });
});

describe("snow exploration restored expiration", () => {
  it("allows expired earned rewards once, rejects expired opening/extension, and starts a paid second round", () => {
    const ctx = context(), expired = context("2026-10-14T12:30:00Z"), run = session(ctx);
    expect(run.act("christmas", { type: "start" }, last).pointsDelta).toBe(0);
    run.act("christmas", { type: "open", index: 0 });
    expect((run.state.games.christmas as { found: number }).found).toBe(1);
    rejected(restore(run.state), "christmas", { type: "open", index: 1 }, run.wallet, expired);
    rejected(run.state, "christmas", { type: "extend" }, run.wallet, expired);
    rejected(run.state, "christmas", { type: "start" }, run.wallet, expired);
    const claim = run.act("christmas", { type: "take" }, first, expired);
    expect(claim.rewards).toEqual([{ templateId: 11019, count: 1 }]);
    rejected(run.state, "christmas", { type: "take" }, run.wallet, expired);
    const next = run.act("christmas", { type: "start" }, last, expired);
    expect(next).toMatchObject({ pointsDelta: -20, state: { games: { christmas: { round: 2, found: 0, opened: [], claimed: false, expires: "2026-10-14T13:00:00.000Z" } } } });
  });

  it("does not offer expired snow cells as valid clickable actions", () => {
    const run = session();
    run.act("christmas", { type: "start" }, last);
    const expired = run.view(context("2026-10-14T12:30:00Z")).activities.find(activity => activity.id === "christmas")!;
    expect(expired.stats.find(stat => stat.label === "剩余秒数")?.value).toBe(0);
    expect(expired.cells?.every(cell => cell.action === undefined)).toBe(true);
    expect(expired.actions.find(button => button.action.type === "start")?.disabled).toBe(false);
  });

  it("rejects invalid snow shuffle randomness without creating a broken saved board", () => {
    for (const bad of [-0.1, 1, NaN, Infinity])
      rejected(createActivityState(context().now), "christmas", { type: "start" }, wallet(), context(), () => bad);
  });
});
