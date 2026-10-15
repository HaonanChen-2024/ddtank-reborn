import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeCarnivalHost, retryNativeCarnivalRequest, type NativeCarnivalCallbackTarget, type NativeCarnivalEnvelope } from "./native-carnival-host";
import { attachNativeTreasureHost, type NativeTreasureCallbackTarget } from "./native-treasure-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const stateToken = "2026-10-15:" + "C".repeat(43), response = (value: unknown) => new Response(JSON.stringify(value));
const materials = [11019, 11001, 11021, 11002], recipes = [[0, 5, 10], [1, 5, 10], [2, 2, 10], [3, 2, 10], [0, 10, 20], [1, 10, 20], [2, 5, 20]];
const limitForTest = 2_147_483_647;
let nextId = 8000;
const projection = (personalScore = 0, redPackageCount = 0, remainDrawCount = 100) => ({
  version: 1, kind: "carnival-native", started: personalScore > 0, day: "2026-10-15", stateToken,
  activityState: 1, startDate: "2026-10-15T00:00:00.000Z", endDate: "2026-10-16T00:00:00.000Z",
  score: 1000, personalScore, redPackageCount, remainDrawCount, maxBatchCount: Math.min(5, remainDrawCount), canDraw: remainDrawCount > 0,
  prizes: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, index, templateId: materials[index % 4],
    name: "普通材料", itemCount: Math.floor(index / 4) + 1, redPackets: Math.floor(index / 4) + 1 })),
  exchange: recipes.map(([material, count, cost], index) => ({ id: index + 1, index, templateId: materials[material],
    name: "普通材料", itemCount: count, redPacketsCost: cost, canExchange: redPackageCount >= cost })),
  records: Array.from({ length: Math.min(20, personalScore) }, (_, index) => ({ drawId: personalScore - index,
    prizeId: 1, templateId: materials[0], itemCount: 1, redPackets: 1, day: "2026-10-15" })),
  rules: { version: 1, drawCost: 10, maxBatchCount: 5, exchangeMaxCount: 10, maxDraws: 100_000_000,
    maxRedPackets: 300_000_000, recordLimit: 20, probabilityNumerator: 1, probabilityDenominator: 12,
    description: "本地积分及红包，无真实付款" },
  unavailable: ["全服奖池", "私服及跨服排行与排行奖", "轮次大奖", "大奖直播原窗口与动画", "真实付款"],
});
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse => ({ characterId: id, revision: 1,
  points: 1000, earned: 1000, day: "2026-10-15", activities: [], tasks: [], history: [], nativeCarnival: projection(), ...extra });
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
const round = (roundId: number) => ({ type: "round-completed", roundId, globalRevision: roundId * 100,
  settledAt: "2026-10-15T10:00:00.000Z", participantCount: 3,
  awards: [11019, 11021, 11002].map((templateId, slot) => ({ slot, characterId: 101 + slot, nickName: `真实角色${slot}`,
    templateId, itemCount: slot === 0 ? 100 : 2 })) });
const globalView = (totalDraws = 0, actorRevision = 1, myRoundDraws = 0) => ({ version: 1, kind: "carnival-native-global", scope: "local-server",
  revision: totalDraws, actorRevision, roundId: Math.floor(totalDraws / 100) + 1, roundDraws: totalDraws % 100, roundTarget: 100,
  totalDraws, participantCount: totalDraws % 100 ? 1 : 0, myRoundDraws,
  pool: { templateId: 11019, itemCount: totalDraws % 100, contributionPerDraw: 1 },
  roundRewards: [{ slot: 1, templateId: 11021, itemCount: 2 }, { slot: 2, templateId: 11002, itemCount: 2 }],
  recentRounds: Array.from({ length: Math.min(10, Math.floor(totalDraws / 100)) }, (_, i) => round(Math.floor(totalDraws / 100) - i)) });
const current = (personalScore = 0, redPackets = 0, global = globalView()) => ({ ...projection(personalScore, redPackets), globalMode: "local-server", global,
  unavailable: ["私服及跨服排行与排行奖", "大奖直播原窗口与动画", "真实付款"] });
const drawResult = (id: number, count: number, oldPersonal = 0, oldPackets = 0, oldTotal = 0) => {
  const world = globalView(oldTotal + count, 2, Math.min(count, (oldTotal + count) % 100));
  const p = { ...current(oldPersonal + count, oldPackets + count, world), score: 1000 - count * 10,
    remainDrawCount: 100 - count, maxBatchCount: 5 };
  return snapshot(id, { revision: 2, points: p.score, nativeCarnival: p, nativeCarnivalAction: { requestId: sent().requestId,
    effects: Array.from({ length: count }, (_, batchIndex) => ({ type: "drawn", drawId: oldPersonal + batchIndex + 1,
      prizeId: 1, index: 0, templateId: 11019, itemCount: 1, redPackets: 1, redPackageCount: oldPackets + batchIndex + 1,
      cost: 10, score: 1000 - (batchIndex + 1) * 10, batchIndex, batchCount: count })),
    worldEffects: Math.floor((oldTotal + count) / 100) > Math.floor(oldTotal / 100) ? [round(Math.floor((oldTotal + count) / 100))] : [],
  } as ActivityResponse["nativeCarnivalAction"] });
};
function setup(isCurrent: () => boolean = () => true, ready = true) {
  const id = ++nextId, generation = "carnival-" + id, target: NativeCarnivalCallbackTarget = {};
  const accept = vi.fn((envelope: NativeCarnivalEnvelope): unknown => ({ characterId: id, generation, sequence: envelope.sequence,
    pending: false, revision: envelope.snapshot!.revision })), reject = vi.fn();
  const host = attachNativeCarnivalHost({ characterId: id, generation, target, isCurrent,
    player: ready ? { workshopCarnivalAcceptSnapshot: accept, workshopCarnivalRejectRequest: reject } : {} }); hosts.push(host);
  return { id, generation, target, accept, reject, host,
    read: () => target.workshopCarnivalRead!(id, generation, 1),
    request: (action: unknown, sequence = 1) => target.workshopCarnivalRequest!(id, generation, sequence, action) };
}
async function prime(x: ReturnType<typeof setup>, p: Record<string, unknown> = current()) {
  fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: p })));
  x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
  x.accept.mockClear(); fetchMock.mockClear();
}
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
const effectKeys = ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction",
  "nativeTreasureAction", "nativeWheelAction", "nativeCarnivalAction"] as const;

describe("original Carnival host", () => {
  const ranking = (id: number) => ({ version: 1, kind: "carnival-native-ranking", scope: "local", metric: "cumulative-native-draws",
    entries: [{ rank: 1, characterId: 2, nickName: "甲", score: 9 }, { rank: 1, characterId: 3, nickName: "乙", score: 9 },
      { rank: 3, characterId: id, nickName: "本人", score: 5 }], personalScore: 5, personalRank: 3 });
  it("passes the genuine local board with competition ranks and personal rank through one read-only GET", async () => {
    const x = setup(), board = ranking(x.id), p = { ...projection(5, 5), ranking: board, ordinaryFutureCaption: "legacy fields remain compatible" };
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: p })));
    x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(x.accept.mock.calls[0][0].snapshot?.nativeCarnival).toEqual(p);
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("accepts omitted legacy ranking, explicit null, zero-score empty boards and a real own rank outside ten", async () => {
    for (const kind of ["legacy", "null", "empty", "outside", "tie-cutoff"] as const) {
      const x = setup(), board = ranking(x.id), p: Record<string, unknown> = projection(kind === "empty" ? 0 : 5);
      if (kind === "null") p.ranking = null;
      if (kind === "empty") p.ranking = { ...board, entries: [], personalScore: 0, personalRank: null };
      if (kind === "outside") p.ranking = { ...board, personalRank: 11, entries: Array.from({ length: 10 }, (_, i) => ({
        rank: i + 1, characterId: i + 1, nickName: `角色${i + 1}`, score: 20 - i })) };
      if (kind === "tie-cutoff") p.ranking = { ...board, personalRank: 1, entries: Array.from({ length: 10 }, (_, i) => ({
        rank: 1, characterId: i + 1, nickName: `角色${i + 1}`, score: 5 })) };
      fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: p })));
      x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
      expect(x.reject).not.toHaveBeenCalled(); x.host.cancel();
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it("rejects private data, invented scopes, bad competition ranks, stale actor scores and omitted top-ten actors", async () => {
    const mutations: ((r: ReturnType<typeof ranking>) => unknown)[] = [
      r => ({ ...r, scope: "cross-server" }), r => ({ ...r, metric: "payment" }), r => ({ ...r, personalScore: 4 }),
      r => ({ ...r, personalRank: null }), r => ({ ...r, personalRank: 2 }), r => ({ ...r, entries: [] }),
      r => ({ ...r, entries: Array(11).fill(r.entries[0]) }), r => ({ ...r, seed: "private" }),
      r => ({ ...r, entries: [{ ...r.entries[0], state: {} }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [{ ...r.entries[0], accountId: 99 }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [{ ...r.entries[0], score: 0 }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [{ ...r.entries[0], nickName: " " }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [r.entries[0], { ...r.entries[1], characterId: 2 }, r.entries[2]] }),
      r => ({ ...r, entries: [r.entries[1], r.entries[0], r.entries[2]] }),
      r => ({ ...r, entries: [r.entries[0], { ...r.entries[1], rank: 2 }, r.entries[2]] }),
      r => ({ ...r, entries: [r.entries[0], r.entries[1], { ...r.entries[2], rank: 2 }] }),
      r => ({ ...r, entries: [r.entries[0], r.entries[1], { ...r.entries[2], score: 4 }] }),
      r => ({ ...r, entries: [r.entries[0], r.entries[1], { ...r.entries[2], characterId: 900000 }] }),
      r => ({ ...r, personalRank: 2, entries: Array.from({ length: 10 }, (_, i) => ({ rank: i < 2 ? i + 1 : 3,
        characterId: i + 1, nickName: `角色${i + 1}`, score: i === 0 ? 9 : i === 1 ? 5 : 4 })) }),
      r => ({ ...r, personalRank: 1, entries: Array.from({ length: 10 }, (_, i) => ({ rank: 1,
        characterId: 900000 + i, nickName: `角色${i + 1}`, score: 5 })) }),
    ];
    for (const mutate of mutations) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: { ...projection(5, 5), ranking: mutate(ranking(x.id)) } })));
      x.read(); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
      expect(x.accept).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("opens with one GET, strips all eight action envelopes and never starts a draw", async () => {
    const x = setup(), stale = Object.fromEntries(effectKeys.map(key => [key, { requestId: "old", effects: ["old"] }]));
    fetchMock.mockResolvedValue(response(snapshot(x.id, stale)));
    expect(x.read()).toEqual({ accepted: true }); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of effectKeys) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each([1, 5])("submits %s draws in one immutable UUID without following POSTs", async count => {
    const x = setup(), action = { type: "draw", choice: stateToken, count };
    await prime(x);
    fetchMock.mockImplementation(async () => response({ ...drawResult(x.id, count), nativeWheelAction: { requestId: "other", effects: ["other"] } }));
    const ack = x.request(action, 2); expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); action.count = 100;
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][0]).toBe("/api/account/activities/carnival-native/action");
    expect(sent().action).toEqual({ type: "draw", choice: stateToken, count });
    expect(x.accept.mock.calls[0][0].snapshot?.nativeCarnivalAction?.effects).toHaveLength(count);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeWheelAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each([1, 10])("copies a bounded exchange of %s and never accepts a client price or reward", async count => {
    const x = setup(), action = { type: "exchange", choice: stateToken, index: 6, count };
    await prime(x, current(200, 200));
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { revision: 2, nativeCarnival: current(200, 200 - count * 20, globalView(0, 2)),
      nativeCarnivalAction: { requestId: sent().requestId, effects: [{ type: "exchanged", index: 6, catalogId: 7, count,
        templateId: 11021, itemCount: count * 5, redPacketsSpent: count * 20, redPackageCount: 200 - count * 20 }],
        worldEffects: [] } as ActivityResponse["nativeCarnivalAction"] })));
    expect(x.request(action, 2).accepted).toBe(true); action.index = 0; action.count = 100;
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "exchange", choice: stateToken, index: 6, count }); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("reads the empty shared era without submitting or inventing participation", async () => {
    const x = setup(); await prime(x);
    expect(readPendingActivity(x.id)).toBeNull(); expect(x.reject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled(); // Nothing is scheduled after the confirmed opening GET.
  });
  it.each([1, 5])("confirms %s real draws crossing the local round boundary with one settlement and no extra POST", async count => {
    const x = setup(), beforeTotal = 100 - count;
    await prime(x, current(0, 0, globalView(beforeTotal)));
    fetchMock.mockImplementation(async () => response(drawResult(x.id, count, 0, 0, beforeTotal)));
    expect(x.request({ type: "draw", count, choice: stateToken }, 2).accepted).toBe(true);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    const result = x.accept.mock.calls[0][0].snapshot!.nativeCarnivalAction as unknown as { effects: unknown[]; worldEffects: ReturnType<typeof round>[] };
    expect(result.effects).toHaveLength(count); expect(result.worldEffects).toEqual([round(1)]);
    expect(fetchMock).toHaveBeenCalledOnce(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("validates a five-draw batch that settles then contributes to the next round", async () => {
    const x = setup(); await prime(x, current(0, 0, globalView(98)));
    fetchMock.mockImplementation(async () => response(drawResult(x.id, 5, 0, 0, 98)));
    x.request({ type: "draw", count: 5, choice: stateToken }, 2);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect((x.accept.mock.calls[0][0].snapshot?.nativeCarnival as ReturnType<typeof current>).global.myRoundDraws).toBe(3);
    expect(x.reject).not.toHaveBeenCalled();
  });
  it("rejects false shared counters, history, private data and altered ordinary award constants", async () => {
    const mutations: ((g: ReturnType<typeof globalView>) => unknown)[] = [
      g => ({ ...g, scope: "cross-server" }), g => ({ ...g, revision: 99 }), g => ({ ...g, actorRevision: 2 }),
      g => ({ ...g, roundId: 1 }), g => ({ ...g, roundTarget: 10000 }), g => ({ ...g, roundDraws: 1 }),
      g => ({ ...g, totalDraws: limitForTest + 1 }), g => ({ ...g, participantCount: 1 }), g => ({ ...g, myRoundDraws: 1 }),
      g => ({ ...g, pool: { ...g.pool, itemCount: 100 } }), g => ({ ...g, pool: { ...g.pool, templateId: 40002 } }),
      g => ({ ...g, pool: { ...g.pool, contributionPerDraw: 10 } }), g => ({ ...g, state: {} }), g => ({ ...g, contributions: [] }),
      g => ({ ...g, roundRewards: g.roundRewards.map(r => ({ ...r, itemCount: 3 })) }),
      g => ({ ...g, recentRounds: [] }), g => ({ ...g, recentRounds: [round(2)] }),
      g => ({ ...g, recentRounds: [{ ...round(1), settledAt: "2026-02-30T10:00:00.000Z" }] }),
      g => ({ ...g, recentRounds: [{ ...round(1), globalRevision: 99 }] }),
      g => ({ ...g, recentRounds: [{ ...round(1), seed: 1 }] }),
      g => ({ ...g, recentRounds: [{ ...round(1), awards: round(1).awards.slice(0, 2) }] }),
      g => ({ ...g, recentRounds: [{ ...round(1), awards: round(1).awards.map(a => ({ ...a, templateId: 1 })) }] }),
      g => ({ ...g, recentRounds: [{ ...round(1), awards: round(1).awards.map(a => ({ ...a, nickName: " " })) }] }),
      g => ({ ...g, recentRounds: [{ ...round(1), awards: round(1).awards.map(a => ({ ...a, accountId: 7 })) }] }),
    ];
    for (const mutate of mutations) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: { ...current(), global: mutate(globalView(100)) } })));
      x.read(); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
      expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull(); x.host.cancel();
    }
  });
  it("uses shared revision independently of equal personal revisions and does not reset it on null or legacy reads", async () => {
    const x = setup(); await prime(x, current(0, 0, globalView(10)));
    for (const [sequence, total] of [[2, 20], [3, null], [4, undefined]] as const) {
      fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: { ...current(), global: total == null ? total : globalView(total) } })));
      x.target.workshopCarnivalRead!(x.id, x.generation, sequence);
      await vi.waitFor(() => expect(x.accept).toHaveBeenCalledTimes(sequence - 1));
    }
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: current(0, 0, globalView(19)) })));
    x.target.workshopCarnivalRead!(x.id, x.generation, 5);
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(4); // No automatic retry or economic action.
  });
  it("rejects a changed historical winner even at a newer shared revision", async () => {
    const x = setup(); await prime(x, current(0, 0, globalView(100)));
    const changed = globalView(101); changed.recentRounds[0].awards[0].characterId = 999;
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: current(0, 0, changed) })));
    x.target.workshopCarnivalRead!(x.id, x.generation, 2);
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
  });
  it("does not trust a fresh draw without an acknowledged pre-request view", async () => {
    const x = setup(); fetchMock.mockImplementation(async () => response(drawResult(x.id, 1)));
    const ack = x.request({ type: "draw", count: 1, choice: stateToken });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("rejects self-consistent but false first costs, packets, catalog effects and settlement receipts, preserving the UUID", async () => {
    const mutations: ((s: ActivityResponse) => void)[] = [
      s => { (s.nativeCarnival as Record<string, unknown>).global = null; },
      s => { delete (s.nativeCarnivalAction as unknown as Record<string, unknown>).worldEffects; },
      s => { (s.nativeCarnivalAction as unknown as Record<string, unknown>).worldEffects = []; },
      s => { (s.nativeCarnivalAction as unknown as Record<string, unknown>).worldEffects = [round(1), round(1)]; },
      s => { (s.nativeCarnivalAction!.effects[0] as Record<string, unknown>).templateId = 40002; },
      s => { (s.nativeCarnivalAction!.effects[0] as Record<string, unknown>).batchCount = 1; },
      s => { (s.nativeCarnivalAction!.effects[0] as Record<string, unknown>).redPackets = 2; },
      s => { s.nativeCarnivalAction!.effects.pop(); },
      s => { s.nativeCarnivalAction!.requestId = "wrong-uuid"; },
      s => { const p = s.nativeCarnival as Record<string, unknown>; s.points += 10; p.score = s.points;
        for (const e of s.nativeCarnivalAction!.effects as Record<string, unknown>[]) e.score = (e.score as number) + 10; },
      s => { const p = s.nativeCarnival as Record<string, unknown>; p.redPackageCount = (p.redPackageCount as number) + 1;
        for (const e of s.nativeCarnivalAction!.effects as Record<string, unknown>[]) e.redPackageCount = (e.redPackageCount as number) + 1; },
      s => { const result = (s.nativeCarnivalAction as unknown as { worldEffects: ReturnType<typeof round>[] }); result.worldEffects[0].awards[0].nickName = "假赢家"; },
      s => { (s.nativeCarnival as ReturnType<typeof current>).global.myRoundDraws = 0; },
    ];
    for (const mutate of mutations) {
      const x = setup(); await prime(x, current(0, 0, globalView(98)));
      fetchMock.mockImplementation(async () => { const next = drawResult(x.id, 5, 0, 0, 98); mutate(next); return response(next); });
      const ack = x.request({ type: "draw", count: 5, choice: stateToken }, 2);
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
      expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); expect(fetchMock).toHaveBeenCalledOnce(); x.host.cancel();
    }
  });
  it("verifies all seven ordinary exchange recipes against the pre-request packet balance", async () => {
    for (const [index, [material, amount, cost]] of recipes.entries()) {
      const x = setup(); await prime(x, current(200, 200));
      fetchMock.mockImplementation(async () => response(snapshot(x.id, { revision: 2, nativeCarnival: { ...current(200, 200 - cost * 2), global: null },
        nativeCarnivalAction: { requestId: sent().requestId, effects: [{ type: "exchanged", index, catalogId: index + 1, count: 2,
          templateId: materials[material], itemCount: amount * 2, redPacketsSpent: cost * 2, redPackageCount: 200 - cost * 2 }], worldEffects: [] } as ActivityResponse["nativeCarnivalAction"] })));
      x.request({ type: "exchange", index, count: 2, choice: stateToken }, 2);
      await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("rejects incomplete or falsely balanced exchange receipts without losing the original operation", async () => {
    const mutations: ((p: Record<string, unknown>, effect: Record<string, unknown>, result: Record<string, unknown>) => void)[] = [
      (_p, e) => { e.index = 1; }, (_p, e) => { e.catalogId = 3; }, (_p, e) => { e.count = 2; },
      (_p, e) => { e.templateId = 40002; }, (_p, e) => { e.itemCount = 50; }, (_p, e) => { e.redPacketsSpent = 0; },
      (p, e) => { p.redPackageCount = 195; e.redPackageCount = 195; },
      (_p, e) => { e.reward = "unquoted"; }, (_p, _e, r) => { r.worldEffects = [round(1)]; },
      (_p, _e, r) => { delete r.worldEffects; }, (_p, _e, r) => { r.effects = [{ type: "exchanged" }]; },
    ];
    for (const mutate of mutations) {
      const x = setup(); await prime(x, current(200, 200));
      fetchMock.mockImplementation(async () => {
        const p = { ...current(200, 190, globalView(0, 2)) }, e: Record<string, unknown> = { type: "exchanged", index: 0,
          catalogId: 1, count: 1, templateId: 11019, itemCount: 5, redPacketsSpent: 10, redPackageCount: 190 };
        const result: Record<string, unknown> = { requestId: sent().requestId, effects: [e], worldEffects: [] };
        mutate(p, e, result); return response(snapshot(x.id, { revision: 2, nativeCarnival: p,
          nativeCarnivalAction: result as ActivityResponse["nativeCarnivalAction"] }));
      });
      const ack = x.request({ type: "exchange", index: 0, count: 1, choice: stateToken }, 2);
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
      expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); x.host.cancel();
    }
  });
  it("rejects contradictory participation at the same shared version even when the personal version advances", async () => {
    const x = setup(); await prime(x, current(5, 5, globalView(10)));
    const global = { ...globalView(10, 2, 2), participantCount: 2 };
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { revision: 2, nativeCarnival: current(5, 5, global) })));
    x.target.workshopCarnivalRead!(x.id, x.generation, 2);
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
  });
  it("does not reopen or deliver a valid late settlement after its host closes", async () => {
    const x = setup(); await prime(x, current(0, 0, globalView(98)));
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const ack = x.request({ type: "draw", count: 5, choice: stateToken }, 2);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); const late = drawResult(x.id, 5, 0, 0, 98);
    x.host.cancel(); resolve(response(late)); await new Promise(done => setTimeout(done, 0));
    expect(x.accept).not.toHaveBeenCalled(); expect(x.target.workshopCarnivalRead).toBeUndefined();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("replays an uncertain crossing with the original UUID and current shared view without settlement animation", async () => {
    const x = setup(); await prime(x, current(0, 0, globalView(98)));
    fetchMock.mockRejectedValueOnce(new TypeError("lost committed settlement"));
    const ack = x.request({ type: "draw", count: 5, choice: stateToken }, 2);
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const pending = readPendingActivity(x.id)!, first = sent();
    fetchMock.mockImplementationOnce(async () => response({ ...drawResult(x.id, 5, 0, 0, 98), replayed: true }));
    await retryNativeCarnivalRequest(pending);
    expect(sent()).toEqual(first); expect(ack.requestId).toBe(first.requestId);
    expect(x.accept).toHaveBeenCalledOnce(); expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeCarnivalAction");
    expect(readPendingActivity(x.id)).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each(["personal-only", "legacy"])("keeps real ordinary draws playable with explicitly %s shared capability", async mode => {
    const x = setup(), before = mode === "legacy" ? projection() : { ...projection(), globalMode: "personal-only", global: null };
    await prime(x, before);
    fetchMock.mockImplementation(async () => {
      const next = drawResult(x.id, 1), p = next.nativeCarnival as Record<string, unknown>;
      p.unavailable = projection().unavailable;
      if (mode === "legacy") {
        delete p.globalMode; delete p.global; delete (next.nativeCarnivalAction as unknown as Record<string, unknown>).worldEffects;
      } else { p.globalMode = "personal-only"; p.global = null; }
      return response(next);
    });
    x.request({ type: "draw", count: 1, choice: stateToken }, 2);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each(["personal-only", "legacy"])("preserves the old exchange with %s shared capability", async mode => {
    const x = setup(); await prime(x, mode === "legacy" ? projection(200, 200) : { ...projection(200, 200), globalMode: mode, global: null });
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { revision: 2, nativeCarnival: { ...projection(200, 190),
      ...(mode === "legacy" ? {} : { globalMode: mode, global: null }) }, nativeCarnivalAction: { requestId: sent().requestId,
      effects: [{ type: "exchanged", index: 0, catalogId: 1, count: 1, templateId: 11019, itemCount: 5, redPacketsSpent: 10, redPackageCount: 190 }],
      ...(mode === "legacy" ? {} : { worldEffects: [] }) } as ActivityResponse["nativeCarnivalAction"] })));
    x.request({ type: "exchange", index: 0, count: 1, choice: stateToken }, 2);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("does not turn an enabled null projection into personal-only or silently downgrade a previously enabled host", async () => {
    for (const downgrade of [false, true]) {
      const x = setup(); await prime(x);
      fetchMock.mockImplementation(async () => {
        const next = drawResult(x.id, 1), p = next.nativeCarnival as Record<string, unknown>; p.global = null;
        if (downgrade) { p.globalMode = "personal-only"; p.unavailable = projection().unavailable; }
        return response(next);
      });
      const ack = x.request({ type: "draw", count: 1, choice: stateToken }, 2);
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
      expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); x.host.cancel();
    }
  });
  it("still verifies the first true cost in personal-only mode rather than weakening compatibility receipts", async () => {
    const x = setup(); await prime(x, { ...projection(), globalMode: "personal-only", global: null });
    fetchMock.mockImplementation(async () => {
      const next = drawResult(x.id, 1), p = next.nativeCarnival as Record<string, unknown>;
      p.globalMode = "personal-only"; p.global = null; p.unavailable = projection().unavailable; p.score = 1000; next.points = 1000;
      (next.nativeCarnivalAction!.effects[0] as Record<string, unknown>).score = 1000;
      return response(next);
    });
    const ack = x.request({ type: "draw", count: 1, choice: stateToken }, 2);
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("refuses unbounded loops, hidden payouts, payments and unquoted or inherited actions", () => {
    const x = setup();
    for (const action of [{ type: "draw" }, { type: "draw", choice: stateToken }, { type: "draw", choice: stateToken, count: 0 },
      { type: "draw", choice: stateToken, count: 6 }, { type: "draw", choice: stateToken, count: "1" },
      { type: "draw", choice: stateToken, count: 1, templateId: 11019 }, { type: "draw", choice: stateToken, count: 1, cost: 0 },
      { type: "continue", choice: stateToken, count: 5 }, { type: "take", choice: stateToken, count: 1 },
      { type: "exchange", choice: stateToken, index: -1, count: 1 }, { type: "exchange", choice: stateToken, index: 7, count: 1 },
      { type: "exchange", choice: stateToken, index: 0, count: 11 }, { type: "exchange", choice: stateToken, index: 0 },
      { type: "buy", choice: stateToken, count: 1 }, { type: "draw", choice: "old-token", count: 1 },
      Object.create({ type: "draw", choice: stateToken, count: 1 })]) expect(x.request(action).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("keeps valid exchanges available at the daily and lifetime draw limits", async () => {
    for (const score of [10, 100_000_000]) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: projection(score, 10, 0) })));
      x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("rejects legacy dice, changed catalogs, leaked state and inconsistent public records", async () => {
    const mutations = [
      () => ({ ...projection(), kind: "carnival" }), () => ({ ...projection(), score: 999 }),
      () => ({ ...projection(), day: "2026-02-30" }), () => ({ ...projection(), stateToken: "2026-10-16:" + "C".repeat(43) }),
      () => ({ ...projection(), prizes: projection().prizes.slice(0, 11) }),
      () => ({ ...projection(), prizes: projection().prizes.map(row => ({ ...row, templateId: 1 })) }),
      () => ({ ...projection(), exchange: projection().exchange.map(row => ({ ...row, redPacketsCost: 1 })) }),
      () => ({ ...projection(), rules: { ...projection().rules, probabilityDenominator: 1 } }),
      () => ({ ...projection(), maxBatchCount: 100 }), () => ({ ...projection(), canDraw: false }),
      () => ({ ...projection(), seed: 1 }), () => ({ ...projection(), futureResults: [] }),
      () => ({ ...projection(1, 1), records: [] }), () => ({ ...projection(1, 1), started: false }),
      () => ({ ...projection(1, 1), records: [{ ...projection(1, 1).records[0], drawId: 2 }] }),
      () => ({ ...projection(1, 1), redPackageCount: 4 }), () => ({ ...projection(), endDate: "2050-12-15" }),
    ];
    for (const mutate of mutations) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeCarnival: mutate() })));
      x.read(); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("retries a lost batch using the same UUID and suppresses replay animation envelopes", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    const ack = x.request({ type: "draw", choice: stateToken, count: 5 }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const pending = readPendingActivity(x.id)!, first = sent(); expect(pending.requestId).toBe(ack.requestId);
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeCarnival: projection(5, 5),
      nativeCarnivalAction: { requestId: ack.requestId!, effects: ["old"] }, nativeWheelAction: { requestId: "old", effects: ["old"] } })));
    await retryNativeCarnivalRequest(pending); expect(sent()).toEqual(first); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readPendingActivity(x.id)).toBeNull();
    for (const key of effectKeys) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it("cancels a late result without reopening or discarding the already submitted UUID", async () => {
    const x = setup(); let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const ack = x.request({ type: "draw", choice: stateToken, count: 5 }); await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    x.host.cancel(); resolve(response(snapshot(x.id, { nativeCarnivalAction: { requestId: ack.requestId!, effects: ["late"] } })));
    await new Promise(done => setTimeout(done, 0)); expect(x.accept).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); expect(x.target.workshopCarnivalRequest).toBeUndefined();
  });
  it("shares the unresolved-request lock and rejects wrong roles, generations or absent player callbacks", async () => {
    let current = true; const x = setup(() => current), target: NativeTreasureCallbackTarget = {};
    fetchMock.mockRejectedValueOnce(new TypeError("lost")); x.request({ type: "exchange", choice: stateToken, index: 0, count: 1 });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const treasure = attachNativeTreasureHost({ characterId: x.id, generation: "treasure", target, isCurrent: () => true,
      player: { workshopTreasureAcceptSnapshot: () => true, workshopTreasureRejectRequest: () => true } }); hosts.push(treasure);
    expect(target.workshopTreasureRequest!(x.id, "treasure", 1, { type: "take", choice: stateToken }).accepted).toBe(false);
    expect(x.target.workshopCarnivalRead!(x.id + 1, x.generation, 2).accepted).toBe(false);
    expect(x.target.workshopCarnivalRead!(x.id, "old", 2).accepted).toBe(false); current = false;
    expect(x.request({ type: "draw", choice: stateToken, count: 1 }, 3).accepted).toBe(false); expect(fetchMock).toHaveBeenCalledOnce();
    const unready = setup(() => true, false); expect(unready.read().accepted).toBe(false);
    expect(unready.request({ type: "draw", choice: stateToken, count: 1 }).accepted).toBe(false); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
