import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeDevilHost, type NativeDevilCallbackTarget, type NativeDevilEnvelope } from "./native-devil-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const choice = "2026-10-15." + "A".repeat(43);
const reward = (templateId = 11019, count = 1) => ({ templateId, count, bound: true, validDays: 0 });
const costs = [[1, 1, 1, 0, 0], [2, 2, 0, 2, 0], [0, 0, 3, 3, 3]];
const milestoneRewards = [[11019, 3], [11001, 3], [11021, 1], [11002, 1], [11019, 5], [11001, 5], [11021, 3], [11002, 3], [11019, 10]];
const row = (sequence: number) => ({ sequence, prizeId: 1, grant: { kind: "material", reward: reward() }, marksEarned: 1 });
function projection() {
  const grants = [{ kind: "material", reward: reward() }, { kind: "material", reward: reward(11001) },
    { kind: "random-bead", count: 1, eachWeight: 1, weightTotal: 5 }, { kind: "marks", count: 3 },
    ...[0, 1, 2].map(index => ({ kind: "box", index, count: 1 })), { kind: "material", reward: reward(11021) }];
  return { version: 1, catalogVersion: "local-devil-native-v1", day: "2026-10-15", available: true, stateToken: choice,
    points: 500, dailyActionsRemaining: 500, turns: 10, freeAvailable: true, canBuyOne: true, canBuyTen: true,
    drawMaxCount: 10, draws: 0, marks: 100, beads: [5, 5, 5, 5, 5],
    purchase: { onePoints: 20, tenPoints: 200, freePerUtcDay: 1, freeGrantsTurns: 1 },
    slots: grants.map((grant, index) => ({ index, prizeId: index + 1, originalRenderType: [2, 2, 3, 2, 1, 2, 1, 2][index],
      label: "本地奖励", weight: [25, 20, 30, 10, 5, 5, 2, 3][index], weightTotal: 100, grant })),
    boxes: costs.map((beadCosts, index) => ({ index, name: "本地箱", count: 1, expireAt: null, beadCosts,
      canConvert: true, canOpen: true, reason: "活动计数" })), round: null as unknown,
    milestones: milestoneRewards.map(([templateId, count], index) => ({ index, catalogId: index + 1,
      drawsRequired: [10, 30, 50, 100, 200, 300, 500, 800, 1000][index], claimed: false, canClaim: false,
      reward: reward(templateId, count), reason: "累计探险次数礼" })),
    shop: [15, 20, 25, 30].map((unitMarks, index) => ({ index, catalogId: index + 1, unitMarks,
      reward: reward([11019, 11001, 11021, 11002][index], index < 2 ? 3 : 1), dailyLimit: 10, boughtToday: 0,
      maxCount: Math.floor(100 / unitMarks), canBuy: true, reason: "本地印记商店" })),
    recentDraws: [] as ReturnType<typeof row>[], rules: ["本地规则，不接付款。"],
    unavailable: ["reference-economy", "global-jackpot-ranking", "timed-box-expiry"].map(id => ({ id, reason: "尚未接入原后台" })),
  };
}
function round() {
  return { id: 1, boxIndex: 0, phase: 2, state: 2, rangeMin: 3, rangeMax: 11, retryPoints: 10,
    canRoll: false, canContinue: true, canTake: true, canAbandon: false, reason: "双骰成功",
    lastDice: { left: 3, right: 4, sum: 7, success: true },
    stages: [1, 2, 3, 5, 8].map((count, index) => ({ phase: index + 1, rangeMin: index + 2, rangeMax: 12 - index,
      winningPairs: [36, 34, 30, 24, 16][index], possiblePairs: 36, reward: reward(11019, count), marks: [1, 2, 4, 6, 10][index] })),
  };
}
const snapshot = (id: number, p: unknown = projection(), extra: Partial<ActivityResponse> = {}): ActivityResponse => ({
  characterId: id, points: 500, earned: 500, revision: 1, day: "2026-10-15", activities: [], tasks: [], history: [], nativeDevil: p, ...extra,
});
let idCounter = 1700;
function setup() {
  const id = ++idCounter, generation = "devil-" + id, target: NativeDevilCallbackTarget = {};
  let current = true;
  const accept = vi.fn((e: NativeDevilEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence, pending: false, revision: e.snapshot!.revision }));
  const reject = vi.fn(), status = vi.fn();
  const host = attachNativeDevilHost({ characterId: id, generation, target, isCurrent: () => current, onStatus: status,
    player: { workshopDevilAcceptSnapshot: accept, workshopDevilRejectRequest: reject } });
  hosts.push(host);
  return { id, generation, target, host, accept, reject, status, cancelRole: () => { current = false; },
    request: (action: unknown, sequence = 1) => target.workshopDevilRequest!(id, generation, sequence, action) };
}
const response = (v: unknown) => new Response(JSON.stringify(v));
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
const staleEffects = () => Object.fromEntries(["Pair", "Mines", "DDPlay", "Gypsy", "Moonlight", "Treasure", "Wheel", "Carnival", "FirstRecharge", "Charge", "Forthright", "Exchange", "Devil"].map(n => ["native" + n + "Action", { requestId: "old", effects: ["old"] }]));
beforeEach(() => {
  const store = new Map<string, string>(); vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ["free turn", { type: "free-turn" }, { type: "turns-added", source: "free", count: 1, pointsSpent: 0 }],
  ...[1, 10].map(count => ["buy " + count, { type: "buy-turns", count }, { type: "turns-added", source: "points", count, pointsSpent: 20 * count }] as [string, Record<string, unknown>, Record<string, unknown>]),
  ...[1, 10].map(count => ["draw " + count, { type: "draw", count }, { type: "drawn", results: Array.from({ length: count }, (_, i) => row(i + 1)), mailedRewards: Array.from({ length: count }, () => reward()) }] as [string, Record<string, unknown>, Record<string, unknown>]),
  ["convert box", { type: "convert-box", index: 0 }, { type: "box-converted", index: 0, beadsSpent: costs[0] }],
  ["open box", { type: "open-box", index: 0 }, { type: "box-opened", index: 0, roundId: 1 }],
  ["two dice", { type: "roll-dice" }, { type: "dice-rolled", roundId: 1, phase: 2, result: round().lastDice }],
  ["free next stage", { type: "continue-dice" }, { type: "dice-continued", roundId: 1, phase: 2, retried: false, pointsSpent: 0 }],
  ["paid retry", { type: "continue-dice" }, { type: "dice-continued", roundId: 1, phase: 2, retried: true, pointsSpent: 10 }],
  ["take box", { type: "take-box" }, { type: "box-taken", roundId: 1, phase: 2, marks: 2, reward: reward(11019, 2) }],
  ["abandon", { type: "abandon-box" }, { type: "box-abandoned", roundId: 1 }],
  ["milestone", { type: "claim-milestone", index: 0 }, { type: "milestone-claimed", index: 0, reward: reward(11019, 3) }],
  ["mark shop", { type: "buy-item", index: 0, count: 2 }, { type: "item-bought", index: 0, count: 2, marksSpent: 30, reward: reward(11019, 6) }],
];
describe("original Devil host", () => {
  it("reads only on open and strips all thirteen effects", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, projection(), staleEffects())));
    expect(x.target.workshopDevilRead!(x.id, x.generation, 1)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    for (const key of Object.keys(staleEffects())) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each(cases)("owns one exact UUID action and fresh effect: %s", async (_name, input, effect) => {
    const x = setup(), p = projection();
    if (input.type === "draw") { p.draws = Number(input.count); p.recentDraws = Array.from({ length: p.draws }, (_, i) => row(p.draws - i)); p.turns -= p.draws; p.drawMaxCount = p.turns; }
    if (input.type === "roll-dice") p.round = round();
    fetchMock.mockImplementation(async () => response(snapshot(x.id, p, { ...staleEffects(), nativeDevilAction: { requestId: sent().requestId, effects: [effect] } })));
    const action = { ...input, choice }, ack = x.request(action);
    expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual(action); expect(readPendingActivity(x.id)).toBeNull();
    const delivered = x.accept.mock.calls[0][0].snapshot!;
    expect(delivered.nativeDevilAction?.effects).toEqual([effect]);
    for (const key of Object.keys(staleEffects()).filter(k => k !== "nativeDevilAction")) expect(delivered).not.toHaveProperty(key);
  });
  it("rejects coerced, inherited, protocol and out-of-range action fields before writing", () => {
    const x = setup();
    for (const a of [{ type: "draw", count: "1", choice }, { type: "draw", count: 0, choice }, { type: "draw", count: 11, choice },
      { type: "buy-turns", count: 2, choice }, { type: "buy-item", index: 4, count: 1, choice }, { type: "convert-box", index: 3, choice },
      { type: "free-turn", count: 1, choice }, { type: "roll-dice", left: 6, right: 6, choice }, { type: "roll-dice", choice: choice.replace("10-15", "02-30") },
      { type: "constructor", choice }, Object.create({ type: "free-turn", choice }), { type: "take-box" }]) expect(x.request(a).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("keeps the exact UUID after a network loss and strips replay effects on explicit retry", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new Error("connection lost"));
    const ack = x.request({ type: "free-turn", choice }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, projection(), { ...staleEffects(), replayed: true })));
    await x.host.retry(readPendingActivity(x.id)!);
    expect(sent().requestId).toBe(ack.requestId); expect(fetchMock).toHaveBeenCalledTimes(2); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of Object.keys(staleEffects())) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it("delivers isolated unavailability without breaking the other activity data", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, { version: 1, catalogVersion: "local-devil-native-v1", day: "2026-10-15", available: false, stateToken: null, reason: "未知存档版本已保留。" })));
    x.target.workshopDevilRead!(x.id, x.generation, 1); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it.each(["dice-sum", "dice-string", "private-state", "wrong-prize", "history-order", "bad-date"])("holds uncertain results when %s is malformed", async kind => {
    const x = setup(), p = projection();
    if (kind === "dice-sum") p.round = { ...round(), lastDice: { left: 3, right: 4, sum: 8, success: true } };
    if (kind === "dice-string") p.round = { ...round(), state: "2" };
    if (kind === "private-state") Object.assign(p, { games: { devilNativeV1: { seed: 6 } } });
    if (kind === "wrong-prize") Object.assign(p.slots[0]!.grant, { reward: reward(99999) });
    if (kind === "history-order") { p.draws = 2; p.recentDraws = [row(1), row(2)]; }
    if (kind === "bad-date") p.stateToken = choice.replace("10-15", "02-30");
    fetchMock.mockImplementation(async () => response(snapshot(x.id, p, { nativeDevilAction: { requestId: sent().requestId, effects: [{ type: "turns-added", source: "free", count: 1, pointsSpent: 0 }] } })));
    const ack = x.request({ type: "free-turn", choice }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("rejects wrong-role callbacks, stale generations and requests after role departure", () => {
    const x = setup(); expect(x.target.workshopDevilRead!(x.id + 1, x.generation, 1).accepted).toBe(false);
    expect(x.target.workshopDevilRead!(x.id, "old", 1).accepted).toBe(false); x.cancelRole();
    expect(x.request({ type: "free-turn", choice }).accepted).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not POST when closing or receiving repeated reports", () => {
    const x = setup(); x.target.workshopDevilReport!({ characterId: x.id, generation: x.generation, sequence: 0 }); x.host.cancel();
    expect(x.target.workshopDevilRequest).toBeUndefined(); expect(fetchMock).not.toHaveBeenCalled();
  });
});
