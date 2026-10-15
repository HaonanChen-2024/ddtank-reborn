import { describe, expect, it } from "vitest";
import { advanceCarnivalGlobal, readCarnivalGlobalState, viewCarnivalGlobal,
  type CarnivalGlobalState } from "../src/activities/carnival-global.js";

const now = new Date("2026-10-15T12:00:00.000Z");
const people = [{ characterId: 11, nickName: "甲" }, { characterId: 22, nickName: "乙" }, { characterId: 33, nickName: "丙" }];
function contribute(state: CarnivalGlobalState | undefined, characterId: number, count: number, revision = 1) {
  let value = state, next = revision;
  for (let left = count; left > 0; left -= 5) value = advanceCarnivalGlobal(value, { characterId, walletRevision: next++, draws: Math.min(left, 5), now,
    eligibleParticipants: people }, () => 0).state;
  return { state: value!, revision: next };
}
const input = (draws = 1) => ({ characterId: 11, walletRevision: 21, draws, now, eligibleParticipants: people });

describe("shared native carnival rounds", () => {
  it("projects an empty unpersisted era and withholds only a stale actor's contribution", () => {
    expect(viewCarnivalGlobal(undefined, 11, 0)).toMatchObject({ revision: 0, actorRevision: 0, roundId: 1,
      roundDraws: 0, participantCount: 0, myRoundDraws: 0, pool: { templateId: 11019, itemCount: 0 }, recentRounds: [] });
    const { state } = contribute(undefined, 11, 2);
    expect(viewCarnivalGlobal(state, 11, 0)).toBeNull();
    const view = viewCarnivalGlobal(state, 22, 0)!;
    expect(view).toMatchObject({ revision: 2, participantCount: 1, myRoundDraws: 0 });
    expect(JSON.stringify(view)).not.toMatch(/contributions|walletRevision|eligible|weight|seed/);
    view.pool.itemCount = 999; view.recentRounds.push({} as never);
    expect(viewCarnivalGlobal(state, 22, 0)!.pool.itemCount).toBe(2);
    expect(state.recentRounds).toEqual([]);
  });

  it("selects three committed material winners by real contributions, preferring distinct people", () => {
    let state = contribute(undefined, 11, 70).state;
    state = contribute(state, 22, 20).state;
    state = contribute(state, 33, 9).state;
    const before = structuredClone(state), samples = [0.75, 0.99, 0]; let index = 0;
    const result = advanceCarnivalGlobal(state, { ...input(), walletRevision: 15 }, () => samples[index++]);
    expect(state).toEqual(before); expect(index).toBe(3);
    expect(result.worldEffects).toHaveLength(1);
    expect(result.worldEffects[0]).toMatchObject({ roundId: 1, globalRevision: 100, participantCount: 3, settledAt: now.toISOString() });
    expect(result.worldEffects[0].awards.map(a => [a.slot, a.characterId, a.templateId, a.itemCount]))
      .toEqual([[0, 22, 11019, 100], [1, 33, 11021, 2], [2, 11, 11002, 2]]);
    expect(result.state).toMatchObject({ totalDraws: 100, contributions: [], recentRounds: result.worldEffects });
    expect(result.rewards).toHaveLength(3);
  });

  it("allows one real participant to win all three without inventing bots and carries a batch into the next round", () => {
    const { state } = contribute(undefined, 11, 99);
    const result = advanceCarnivalGlobal(state, input(5), () => 0.99999);
    expect(result.worldEffects[0].awards.map(a => a.characterId)).toEqual([11, 11, 11]);
    expect(result.rewards).toEqual([{ characterId: 11, rewards: [{ templateId: 11019, count: 100 },
      { templateId: 11021, count: 2 }, { templateId: 11002, count: 2 }] }]);
    expect(result.state.totalDraws).toBe(104);
    expect(result.state.contributions).toEqual([{ characterId: 11, count: 4, walletRevision: 21 }]);
    expect(viewCarnivalGlobal(result.state, 11, 21)).toMatchObject({ roundId: 2, roundDraws: 4, myRoundDraws: 4, participantCount: 1 });
    expect(100 * result.state.recentRounds.length + result.state.totalDraws % 100).toBe(104);
  });

  it("excludes invalid participants from selection while preserving the true round participant count", () => {
    const { state } = contribute(undefined, 11, 99);
    const result = advanceCarnivalGlobal(state, { characterId: 22, walletRevision: 1, draws: 1, now,
      eligibleParticipants: [people[1]] }, () => 0);
    expect(result.worldEffects[0].participantCount).toBe(2);
    expect(result.worldEffects[0].awards.every(a => a.characterId === 22)).toBe(true);
  });

  it("preserves valid 200-character and padded real nicknames while rejecting blank or oversized candidates", () => {
    const { state } = contribute(undefined, 11, 99), nickName = " " + "名".repeat(198) + " ";
    const result = advanceCarnivalGlobal(state, { ...input(), eligibleParticipants: [{ characterId: 11, nickName }] }, () => 0);
    expect(result.worldEffects[0].awards.every(a => a.nickName === nickName)).toBe(true);
    expect(readCarnivalGlobalState(result.state).recentRounds[0].awards[0].nickName).toBe(nickName);
    for (const invalid of [" ", "名".repeat(201)]) {
      expect(() => advanceCarnivalGlobal(state, { ...input(), eligibleParticipants: [{ characterId: 11, nickName: invalid }] }, () => 0)).toThrow();
    }
  });

  it("does not sample RNG or settle on projection/nonterminal contribution, and does not reset at midnight", () => {
    const noRandom = () => { throw new Error("RNG is forbidden"); };
    const { state } = contribute(undefined, 11, 3);
    const result = advanceCarnivalGlobal(state, { ...input(2), now: new Date("2026-10-16T00:00:00Z") }, noRandom);
    expect(result.worldEffects).toEqual([]); expect(result.rewards).toEqual([]);
    expect(result.state.totalDraws).toBe(5); expect(viewCarnivalGlobal(result.state, 11, 21)!.roundId).toBe(1);
  });

  it("rejects malformed saves, duplicate candidates, stale wallet versions and invalid random results without mutation", () => {
    const { state } = contribute(undefined, 11, 99), before = structuredClone(state);
    for (const corrupt of [null, { ...state, version: 2 }, { ...state, totalDraws: -1 }, { ...state, totalDraws: 2147483648 },
      { ...state, contributions: [...state.contributions, ...state.contributions] }, { ...state, recentRounds: [{}] }]) {
      expect(() => readCarnivalGlobalState(corrupt)).toThrow();
    }
    for (const sample of [NaN, Infinity, -0.1, 1]) expect(() => advanceCarnivalGlobal(state, input(), () => sample)).toThrow();
    expect(() => advanceCarnivalGlobal(state, { ...input(), eligibleParticipants: [] }, () => 0)).toThrow();
    expect(() => advanceCarnivalGlobal(state, { ...input(), eligibleParticipants: [people[0], people[0]] }, () => 0)).toThrow();
    expect(() => advanceCarnivalGlobal(state, { ...input(), walletRevision: 20 }, () => 0)).toThrow();
    expect(() => advanceCarnivalGlobal(state, input(6), () => 0)).toThrow();
    expect(state).toEqual(before);
  });

  it("retains exactly ten continuous settlement proofs and rejects changed material awards or history gaps", () => {
    const { state } = contribute(undefined, 11, 1203);
    expect(state.recentRounds.map(r => r.roundId)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(state.contributions[0].count).toBe(3);
    for (const alter of [(s: CarnivalGlobalState) => { s.recentRounds[0].awards[0].itemCount = 99; },
      (s: CarnivalGlobalState) => { s.recentRounds[0].globalRevision++; },
      (s: CarnivalGlobalState) => { s.recentRounds[0].settledAt = "2026-10-15"; },
      (s: CarnivalGlobalState) => { s.recentRounds.pop(); }]) {
      const bad = structuredClone(state); alter(bad); expect(() => readCarnivalGlobalState(bad)).toThrow();
    }
  });
});
