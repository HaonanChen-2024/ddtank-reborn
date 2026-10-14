import { describe, expect, it } from "vitest";
import { advanceChanceGame, viewChanceGame, type ChanceGameId } from "../src/activities/chance-games.js";
import { ActivityError, type ActivityAction } from "../src/activities/types.js";

const restore = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sequence(...values: number[]) {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error("Unexpected extra random draw");
    return values[index++];
  };
}
const noRandom = () => { throw new Error("This action must not draw randomness"); };
const die = (value: number) => () => (value - 0.5) / 6;
function rejected(id: ChanceGameId, state: unknown, action: ActivityAction, message?: RegExp) {
  const before = state === undefined ? undefined : restore(state);
  expect(() => advanceChanceGame(id, freeze(state), action, noRandom)).toThrow(ActivityError);
  if (message) expect(() => advanceChanceGame(id, state, action, noRandom)).toThrow(message);
  expect(state).toEqual(before);
}

describe("local chance-game state boundaries", () => {
  it("rejects unsupported actions and malformed or cross-game persisted state in Chinese", () => {
    for (const id of ["wheel", "devil", "ddplay", "carnival"] as const) {
      rejected(id, undefined, { type: "unexpected" });
      rejected(id, undefined, { type: "restart" });
      for (const state of [null, 1, [], { version: 2, kind: id }, { version: 1, kind: "different" }]) {
        expect(() => viewChanceGame(id, state)).toThrow(ActivityError);
        expect(() => advanceChanceGame(id, state, { type: "start" }, noRandom)).toThrow(/活动状态/);
      }
    }
    expect(() => viewChanceGame("invalid" as ChanceGameId, undefined)).toThrow("不支持此活动");
    expect(() => viewChanceGame("wheel", { version: 1, kind: "wheel", round: 1, phase: ["active"], stars: 3 })).toThrow(ActivityError);
    expect(() => viewChanceGame("wheel", { version: 1, kind: "wheel", round: 1, phase: "active", stars: 999 })).toThrow(ActivityError);
    expect(() => viewChanceGame("devil", { version: 1, kind: "devil", round: 1, phase: "active", multiplier: 0, lastDie: 0 })).toThrow(ActivityError);
    expect(() => viewChanceGame("ddplay", { version: 1, kind: "ddplay", spins: 1, faces: [0, 1, 6] })).toThrow(ActivityError);
    expect(() => viewChanceGame("carnival", { version: 1, kind: "carnival", rolls: 1, distance: 12, pool: 100 })).toThrow(ActivityError);
  });

  it("returns fresh serializable state and rejects invalid random values without changing input", () => {
    const starts = [
      ["wheel", advanceChanceGame("wheel", undefined, { type: "start" }, noRandom).state, "continue"],
      ["devil", advanceChanceGame("devil", undefined, { type: "start" }, noRandom).state, "continue"],
      ["ddplay", advanceChanceGame("ddplay", undefined, { type: "spin" }, sequence(0, 0, 0)).state, "spin"],
      ["carnival", advanceChanceGame("carnival", undefined, { type: "roll" }, die(1)).state, "roll"],
    ] as const;
    for (const [id, state, type] of starts) {
      const before = restore(state);
      for (const bad of [-0.1, 1, Infinity, NaN]) {
        expect(() => advanceChanceGame(id, freeze(state), { type }, () => bad)).toThrow("随机结果无效");
        expect(state).toEqual(before);
      }
      const valid = advanceChanceGame(id, freeze(restore(state)), { type }, () => 0.1);
      expect(valid.state).not.toBe(state);
      expect(restore(valid.state)).toEqual(valid.state);
      expect(viewChanceGame(id, restore(valid.state))).toEqual(viewChanceGame(id, valid.state));
      expect(state).toEqual(before);
    }
  });
});

describe("wheel addition and one-time settlement", () => {
  it("charges each kind of attempt and preserves stars on protected failure", () => {
    const start = advanceChanceGame("wheel", undefined, { type: "start" }, noRandom);
    expect(start).toMatchObject({ cost: 20, points: 0, rewardUnits: 0, completed: false, state: { stars: 1, phase: "active", round: 1 } });
    rejected("wheel", start.state, { type: "start" }, /先结算/);
    const protection = advanceChanceGame("wheel", freeze(start.state), { type: "protect" }, sequence(0.6));
    expect(protection).toMatchObject({ cost: 20, rewardUnits: 0, completed: false, state: { stars: 1, phase: "active" } });
    const success = advanceChanceGame("wheel", protection.state, { type: "continue" }, sequence(0.599999));
    expect(success).toMatchObject({ cost: 10, rewardUnits: 0, state: { stars: 2 } });
    const take = advanceChanceGame("wheel", freeze(restore(success.state)), { type: "take" }, noRandom);
    expect(take).toMatchObject({ cost: 0, points: 0, rewardUnits: 2, completed: true, state: { phase: "settled", stars: 2 } });
    rejected("wheel", take.state, { type: "take" });
    rejected("wheel", take.state, { type: "continue" });
    const next = advanceChanceGame("wheel", take.state, { type: "start" }, noRandom);
    expect(next).toMatchObject({ cost: 20, rewardUnits: 0, state: { round: 2, stars: 1 } });
  });

  it("ends ordinary addition on failure and allows only one reduced-star settlement", () => {
    for (const [dropRandom, expectedStars] of [[0, 3], [0.999999, 2]]) {
      let state = advanceChanceGame("wheel", undefined, { type: "start" }, noRandom).state;
      for (let i = 0; i < 3; i++) state = advanceChanceGame("wheel", state, { type: "continue" }, sequence(0)).state;
      const failure = advanceChanceGame("wheel", freeze(state), { type: "continue" }, sequence(0.8, dropRandom));
      expect(failure).toMatchObject({ cost: 10, rewardUnits: 0, completed: false, state: { phase: "failed", stars: expectedStars } });
      for (const type of ["continue", "protect", "start"]) rejected("wheel", failure.state, { type });
      const settled = advanceChanceGame("wheel", restore(failure.state), { type: "take" }, noRandom);
      expect(settled.rewardUnits).toBe(expectedStars);
      rejected("wheel", settled.state, { type: "take" });
    }
    const start = advanceChanceGame("wheel", undefined, { type: "start" }, noRandom);
    const failed = advanceChanceGame("wheel", start.state, { type: "continue" }, sequence(0.99, 0.99));
    expect(advanceChanceGame("wheel", failed.state, { type: "take" }, noRandom).rewardUnits).toBe(0);
  });

  it("caps at five stars and makes UI controls match legal transitions", () => {
    rejected("wheel", undefined, { type: "take" });
    let state = advanceChanceGame("wheel", undefined, { type: "start" }, noRandom).state;
    for (let i = 0; i < 4; i++) state = advanceChanceGame("wheel", state, { type: "continue" }, sequence(0)).state;
    rejected("wheel", state, { type: "continue" }, /5星/);
    rejected("wheel", state, { type: "protect" });
    const view = viewChanceGame("wheel", state);
    expect(view.actions.filter(button => !button.disabled).map(button => button.action.type)).toEqual(["take"]);
    expect(view.rules.join(" ")).toContain("本地规则");
    expect(advanceChanceGame("wheel", state, { type: "take" }, noRandom).rewardUnits).toBe(5);
  });
});

describe("devil dice risk and payout", () => {
  it("uses each die result, charging continuation and losing the round on one", () => {
    for (let value = 1; value <= 6; value++) {
      const start = advanceChanceGame("devil", undefined, { type: "start" }, noRandom);
      expect(start).toMatchObject({ cost: 20, rewardUnits: 0, state: { multiplier: 1 } });
      rejected("devil", start.state, { type: "start" });
      const continued = advanceChanceGame("devil", freeze(start.state), { type: "continue" }, die(value));
      expect(continued.cost).toBe(10);
      expect(continued.rewardUnits).toBe(0);
      expect(continued.state).toMatchObject({ multiplier: value === 1 ? 0 : value === 6 ? 2 : value, lastDie: value });
      if (value === 1) {
        expect(continued.completed).toBe(true);
        for (const type of ["take", "giveup", "continue"]) rejected("devil", continued.state, { type });
      } else {
        const taken = advanceChanceGame("devil", restore(continued.state), { type: "take" }, noRandom);
        expect(taken).toMatchObject({ cost: 0, points: 0, completed: true, rewardUnits: value === 6 ? 2 : value });
        rejected("devil", taken.state, { type: "take" });
      }
    }
  });

  it("caps doubling at twelve and makes giveup irreversible with no payout", () => {
    let state = advanceChanceGame("devil", undefined, { type: "start" }, noRandom).state;
    for (let i = 0; i < 4; i++) state = advanceChanceGame("devil", state, { type: "continue" }, die(6)).state;
    expect(state).toMatchObject({ multiplier: 12 });
    rejected("devil", state, { type: "continue" }, /12倍/);
    expect(advanceChanceGame("devil", state, { type: "take" }, noRandom).rewardUnits).toBe(12);
    const abandoned = advanceChanceGame("devil", freeze(state), { type: "giveup" }, noRandom);
    expect(abandoned).toMatchObject({ cost: 0, points: 0, rewardUnits: 0, completed: true, state: { multiplier: 0, phase: "settled" } });
    for (const type of ["take", "giveup", "continue"]) rejected("devil", abandoned.state, { type });
    expect(advanceChanceGame("devil", abandoned.state, { type: "start" }, noRandom)).toMatchObject({ cost: 20, state: { multiplier: 1, round: 2 } });
  });
});

describe("ddplay server-side results", () => {
  it.each([
    [[0, 1, 2], 0], [[1, 1, 2], 2], [[0, 0, 0], 3], [[3, 3, 3], 5], [[5, 5, 5], 10],
  ] as const)("settles faces %j once at multiplier %i, without a separate claim", (faces, multiple) => {
    const result = advanceChanceGame("ddplay", undefined, { type: "spin" }, sequence(...faces.map(face => (face + 0.5) / 6)));
    expect(result).toMatchObject({ cost: 10, points: 10 * multiple, rewardUnits: 0, completed: true, state: { faces: [...faces], spins: 1 } });
    rejected("ddplay", result.state, { type: "take" });
    const view = viewChanceGame("ddplay", freeze(restore(result.state)));
    expect(view.stats.find(stat => stat.label === "上次倍率")?.value).toBe(multiple);
    expect(view.cells).toHaveLength(3);
    expect(view).not.toHaveProperty("state");
    expect(JSON.stringify(view)).not.toMatch(/nextFaces|seed|deck/);
    const next = advanceChanceGame("ddplay", result.state, { type: "spin" }, sequence(0, 0.3, 0.5));
    expect(next.cost).toBe(10);
    expect(next.state).toMatchObject({ spins: 2 });
  });
});

describe("carnival movement, pool shares and participation", () => {
  it("takes 5/20/50 percent of the current pool as amounts, never as draw odds", () => {
    const first = advanceChanceGame("carnival", undefined, { type: "roll" }, die(3));
    expect(first).toMatchObject({ cost: 10, points: 5, rewardUnits: 0, completed: false, state: { rolls: 1, distance: 3, pool: 100 } });
    const second = advanceChanceGame("carnival", freeze(first.state), { type: "roll" }, die(4));
    expect(second).toMatchObject({ cost: 10, points: 21, rewardUnits: 0, state: { distance: 7, pool: 84 } });
    const third = advanceChanceGame("carnival", restore(second.state), { type: "roll" }, die(4));
    expect(third).toMatchObject({ points: 44, rewardUnits: 0, state: { distance: 11, pool: 45 } });
    const view = viewChanceGame("carnival", third.state);
    expect(view.rules.join(" ")).toContain("绝不是中奖概率");
    expect(view.cells?.filter(cell => cell.detail?.startsWith("奖池份额")).map(cell => cell.detail)).toEqual(["奖池份额5%", "奖池份额20%", "奖池份额50%"]);
  });

  it("awards one unit per crossed twelve steps and one participation bonus per six rolls", () => {
    let state: unknown;
    const outputs = [];
    for (let i = 0; i < 6; i++) {
      const result = advanceChanceGame("carnival", freeze(state), { type: "roll" }, die(6));
      outputs.push(result);
      state = restore(result.state);
    }
    expect(outputs.map(output => output.rewardUnits)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(outputs.map(output => output.completed)).toEqual([false, true, false, true, false, true]);
    expect(outputs.map(output => output.points)).toEqual([4, 0, 4, 0, 4, 5]);
    expect(state).toMatchObject({ distance: 36, rolls: 6, pool: 130 });
    rejected("carnival", state, { type: "take" });
    const next = advanceChanceGame("carnival", freeze(state), { type: "roll" }, die(1));
    expect(next).toMatchObject({ cost: 10, points: 2, rewardUnits: 0, completed: false });
    const view = viewChanceGame("carnival", state);
    expect(view.cells).toHaveLength(12);
    expect(view.stats.find(stat => stat.label === "已完成圈数")?.value).toBe(3);
    expect(view.cells?.filter(cell => cell.tone === "success")).toHaveLength(1);
  });
});
