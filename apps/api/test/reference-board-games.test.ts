import { describe, expect, it } from "vitest";
import { actMinesweeper, createMinesweeper, viewMinesweeper, type MinesweeperAction, type MinesweeperState } from "../src/activities/minesweeper.js";
import { actPairBox, createPairBox, viewPairBox, type PairBoxAction, type PairBoxState } from "../src/activities/pair-box.js";

const first = () => 0, last = () => 0.999999;
const restore = <T>(state: T): T => JSON.parse(JSON.stringify(state));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function mineNoop(state: MinesweeperState, action: MinesweeperAction) {
  const before = restore(state);
  expect(actMinesweeper(freeze(state), action, first)).toEqual({ state: before, changed: false, effects: [] });
  expect(state).toEqual(before);
}
function pairNoop(state: PairBoxState, action: PairBoxAction) {
  const before = restore(state);
  expect(actPairBox(freeze(state), action, first)).toEqual({ state: before, changed: false, effects: [] });
  expect(state).toEqual(before);
}

describe("local minesweeper state machine", () => {
  it("rejects invalid boards and reward milestones before allocating or using randomness", () => {
    const valid = { width: 3, height: 2, mineCount: 2, lives: 2 };
    for (const change of [{ width: 0 }, { height: -1 }, { width: 1.5 }, { width: Infinity },
      { width: 4097 }, { width: 4096, height: 2 }, { mineCount: 6 }, { mineCount: -1 },
      { lives: 0 }, { maxRevives: -1 }, { maxRestarts: 0.5 }, { rewardSteps: [0] }, { rewardSteps: [5] }, { rewardSteps: [1, 1] }]) {
      expect(() => createMinesweeper({ ...valid, ...change }, () => { throw new Error("must not call RNG"); })).toThrow(RangeError);
    }
  });

  it("injects randomness, owns configuration, and guarantees the first open is safe without leaking the board", () => {
    const options = { width: 3, height: 3, mineCount: 2, lives: 2, rewardSteps: [3, 1] };
    const state = createMinesweeper(options, first);
    expect(state.mines).toEqual([0, 1]);
    expect(createMinesweeper(options, last).mines).toEqual([8, 7]);
    expect(options.rewardSteps).toEqual([3, 1]);
    options.rewardSteps.push(2);
    expect(state.options.rewardSteps).toEqual([1, 3]);
    const initialView = viewMinesweeper(state);
    expect(initialView).not.toHaveProperty("mines");
    expect(initialView.cells.every(cell => !("mine" in cell) && !("adjacentMines" in cell))).toBe(true);
    const before = restore(state);
    const result = actMinesweeper(freeze(state), { type: "open", index: 0 }, first);
    expect(state).toEqual(before);
    expect(result.state.mines).toEqual([2, 1]);
    expect(result.state.opened).toEqual([0]);
    expect(result.state.lives).toBe(2);
    expect(result.effects).toEqual([
      { type: "opened", round: 1, index: 0, adjacentMines: 1, safeOpened: 1 },
      { type: "milestone", round: 1, safeOpened: 1 },
    ]);
    const view = viewMinesweeper(result.state);
    expect(view.cells[0]).toMatchObject({ opened: true, mine: false, adjacentMines: 1 });
    expect(view.cells.slice(1).every(cell => !("mine" in cell) && !("adjacentMines" in cell))).toBe(true);
  });

  it("opens only one cell and counts milestones/win once across JSON restore", () => {
    let state = createMinesweeper({ width: 2, height: 2, mineCount: 0, lives: 1, rewardSteps: [1, 3, 4] }, first);
    const effects = [];
    for (const index of [0, 2, 1, 3]) {
      const result = actMinesweeper(freeze(restore(state)), { type: "open", index }, first);
      expect(result.changed).toBe(true);
      expect(result.state.opened).toHaveLength(state.opened.length + 1);
      effects.push(...result.effects);
      state = result.state;
      mineNoop(state, { type: "open", index });
    }
    expect(effects.filter(effect => effect.type === "milestone")).toEqual([
      { type: "milestone", round: 1, safeOpened: 1 }, { type: "milestone", round: 1, safeOpened: 3 },
      { type: "milestone", round: 1, safeOpened: 4 },
    ]);
    expect(effects.filter(effect => effect.type === "won")).toEqual([{ type: "won", round: 1, safeOpened: 4 }]);
    expect(state.status).toBe("won");
    expect(viewMinesweeper(restore(state))).toEqual(viewMinesweeper(state));
    mineNoop(state, { type: "probe" });
    mineNoop(state, { type: "revive" });
  });

  it("makes mark/unmark explicit and repeat-safe, and rejects invalid indices or marked/opened cells", () => {
    let state = createMinesweeper({ width: 3, height: 2, mineCount: 1, lives: 2 }, first);
    for (const index of [-1, 6, 1.1, NaN, Infinity]) {
      mineNoop(state, { type: "open", index });
      mineNoop(state, { type: "mark", index, marked: true });
    }
    state = actMinesweeper(freeze(state), { type: "mark", index: 1, marked: true }).state;
    mineNoop(state, { type: "mark", index: 1, marked: true });
    mineNoop(state, { type: "open", index: 1 });
    state = actMinesweeper(state, { type: "mark", index: 1, marked: false }).state;
    mineNoop(state, { type: "mark", index: 1, marked: false });
    state = actMinesweeper(state, { type: "open", index: 1 }).state;
    mineNoop(state, { type: "mark", index: 1, marked: true });
  });

  it("probes only an undiscovered adjacent mine without opening it or leaking other cells", () => {
    let state = createMinesweeper({ width: 3, height: 2, mineCount: 2, lives: 2 }, first);
    mineNoop(state, { type: "probe" });
    state = actMinesweeper(state, { type: "open", index: 2 }).state;
    const result = actMinesweeper(freeze(state), { type: "probe" }, first);
    expect(result.effects).toEqual([{ type: "probed", round: 1, index: 1 }]);
    expect(result.state.opened).toEqual([2]);
    expect(viewMinesweeper(result.state).cells[1]).toMatchObject({ opened: false, probed: true, mine: true });
    expect(viewMinesweeper(result.state).cells[0]).not.toHaveProperty("mine");
    mineNoop(result.state, { type: "probe" });
    // Opposite row edges are not neighbors just because their linear indices touch.
    state = createMinesweeper({ width: 3, height: 2, mineCount: 1, lives: 2 }, last);
    state = actMinesweeper(state, { type: "open", index: 0 }).state;
    mineNoop(state, { type: "probe" });
  });

  it("enforces death/revive/restart limits and carries restart usage across rounds", () => {
    let state = createMinesweeper({ width: 5, height: 1, mineCount: 3, lives: 1, maxRevives: 1, maxRestarts: 1 }, first);
    mineNoop(state, { type: "revive" });
    mineNoop(state, { type: "restart" });
    state = actMinesweeper(state, { type: "open", index: 4 }).state;
    const hit = actMinesweeper(state, { type: "open", index: 0 });
    expect(hit.effects).toEqual([{ type: "mine", round: 1, index: 0, lives: 0 }]);
    state = hit.state;
    expect(state.status).toBe("lost");
    for (const action of [{ type: "open", index: 3 }, { type: "mark", index: 3, marked: true }, { type: "probe" }] as const) mineNoop(state, action);
    const revive = actMinesweeper(freeze(restore(state)), { type: "revive" });
    expect(revive.effects).toEqual([{ type: "revived", round: 1, lives: 1 }]);
    expect(revive.state.opened).toEqual([4, 0]);
    mineNoop(revive.state, { type: "revive" });
    state = actMinesweeper(revive.state, { type: "open", index: 1 }).state;
    mineNoop(state, { type: "revive" });
    const restarted = actMinesweeper(freeze(state), { type: "restart" }, last);
    expect(restarted.effects).toEqual([{ type: "restarted", round: 2 }]);
    expect(restarted.state).toMatchObject({ round: 2, status: "ready", lives: 1, revivesUsed: 0, restartsUsed: 1,
      opened: [], marked: [], probed: [], rewardStepsReached: [], position: null });
    state = actMinesweeper(restarted.state, { type: "open", index: 0 }).state;
    mineNoop(state, { type: "restart" });
  });

  it("keeps input unchanged when injected randomness fails and supports the smallest safe board", () => {
    const state = createMinesweeper({ width: 2, height: 1, mineCount: 1, lives: 1 }, first);
    for (const bad of [1, -0.1, Infinity, NaN]) {
      expect(() => actMinesweeper(freeze(state), { type: "open", index: 0 }, () => bad)).toThrow(RangeError);
      expect(state.opened).toEqual([]);
      expect(state.mines).toEqual([0]);
    }
    const smallest = createMinesweeper({ width: 1, height: 1, mineCount: 0, lives: 1 }, first);
    expect(actMinesweeper(smallest, { type: "open", index: 0 }).state.status).toBe("won");
  });
});

describe("local pair-box state machine", () => {
  it("validates pair identities and deterministically shuffles two copies without sharing input", () => {
    for (const pairs of [[], [""], [" "], ["a", "a"], Array.from({ length: 129 }, (_, index) => String(index))])
      expect(() => createPairBox({ pairs }, first)).toThrow(RangeError);
    for (const maxRestarts of [-1, 0.1, Infinity]) expect(() => createPairBox({ pairs: ["a"], maxRestarts }, first)).toThrow(RangeError);
    const options = { pairs: ["a", "b", "c"] };
    const state = createPairBox(options, last);
    expect(state.cards).toEqual(["a", "a", "b", "b", "c", "c"]);
    expect(createPairBox(options, first).cards).not.toEqual(state.cards);
    expect(createPairBox(options, first).cards.slice().sort()).toEqual(state.cards);
    options.pairs.push("d");
    expect(state.options.pairs).toEqual(["a", "b", "c"]);
    for (const bad of [1, -1, NaN, Infinity]) expect(() => createPairBox({ pairs: ["a"] }, () => bad)).toThrow(RangeError);
  });

  it("reveals only flipped/matched values and persists a mismatch until explicit hide", () => {
    let state = createPairBox({ pairs: ["ruby", "jade", "pearl"] }, last);
    const initial = viewPairBox(state);
    expect(initial.cards.every(card => !("value" in card))).toBe(true);
    expect(initial).not.toHaveProperty("options");
    const before = restore(state);
    state = actPairBox(freeze(state), { type: "flip", index: 0 }).state;
    expect(before.flipped).toEqual([]);
    expect(viewPairBox(state).cards.filter(card => "value" in card)).toEqual([{ index: 0, matched: false, faceUp: true, value: "ruby" }]);
    pairNoop(state, { type: "flip", index: 0 });
    pairNoop(state, { type: "hide" });
    const mismatch = actPairBox(freeze(restore(state)), { type: "flip", index: 2 });
    expect(mismatch.effects).toEqual([{ type: "flipped", round: 1, index: 2, value: "jade" }, { type: "mismatched", round: 1, indices: [0, 2] }]);
    expect(mismatch.state.turns).toBe(1);
    pairNoop(mismatch.state, { type: "flip", index: 4 });
    state = restore(mismatch.state);
    expect(viewPairBox(state)).toEqual(viewPairBox(mismatch.state));
    const hidden = actPairBox(freeze(state), { type: "hide" });
    expect(hidden.effects).toEqual([{ type: "hidden", round: 1, indices: [0, 2] }]);
    expect(viewPairBox(hidden.state).cards.every(card => !("value" in card))).toBe(true);
    pairNoop(hidden.state, { type: "hide" });
  });

  it("produces one match per pair and one completion, with repeat-safe reward effects after restore", () => {
    let state = createPairBox({ pairs: ["a", "b"], maxRestarts: 1 }, last);
    const effects = [];
    for (const index of [0, 1, 2, 3]) {
      const result = actPairBox(freeze(restore(state)), { type: "flip", index });
      expect(result.changed).toBe(true);
      effects.push(...result.effects);
      state = result.state;
      pairNoop(state, { type: "flip", index });
    }
    expect(effects.filter(effect => effect.type === "matched")).toEqual([
      { type: "matched", round: 1, indices: [0, 1], value: "a", matchedPairs: 1 },
      { type: "matched", round: 1, indices: [2, 3], value: "b", matchedPairs: 2 },
    ]);
    expect(effects.filter(effect => effect.type === "won")).toEqual([{ type: "won", round: 1, matchedPairs: 2, turns: 2 }]);
    expect(viewPairBox(state)).toMatchObject({ status: "won", matchedPairs: 2, canHide: false });
    pairNoop(state, { type: "hide" });
    const restarted = actPairBox(freeze(state), { type: "restart" }, first);
    expect(restarted.effects).toEqual([{ type: "restarted", round: 2 }]);
    expect(restarted.state).toMatchObject({ round: 2, status: "playing", flipped: [], matched: [], turns: 0, restartsUsed: 1 });
    expect(viewPairBox(restarted.state).cards.every(card => !("value" in card))).toBe(true);
    state = restarted.state;
    for (const value of ["a", "b"]) for (const index of state.cards.flatMap((card, index) => card === value ? [index] : []))
      state = actPairBox(state, { type: "flip", index }).state;
    expect(state.status).toBe("won");
    pairNoop(state, { type: "restart" });
  });

  it("rejects early restarts, invalid indices and failed RNG without changing the saved board", () => {
    let state = createPairBox({ pairs: ["a"] }, last);
    pairNoop(state, { type: "restart" });
    for (const index of [-1, 2, 0.5, NaN, Infinity]) pairNoop(state, { type: "flip", index });
    state = actPairBox(state, { type: "flip", index: 0 }).state;
    pairNoop(state, { type: "restart" });
    state = actPairBox(state, { type: "flip", index: 1 }).state;
    const before = restore(state);
    expect(() => actPairBox(freeze(state), { type: "restart" }, () => 1)).toThrow(RangeError);
    expect(state).toEqual(before);
    const view = viewPairBox(state);
    view.cards[0].value = "mutated view";
    expect(state.cards).toEqual(["a", "a"]);
  });
});
