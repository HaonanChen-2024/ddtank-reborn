import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeCarnivalHost, retryNativeCarnivalRequest, type NativeCarnivalCallbackTarget, type NativeCarnivalEnvelope } from "./native-carnival-host";
import { attachNativeTreasureHost, type NativeTreasureCallbackTarget } from "./native-treasure-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const stateToken = "2026-10-15:" + "C".repeat(43), response = (value: unknown) => new Response(JSON.stringify(value));
const materials = [11019, 11001, 11021, 11002], recipes = [[0, 5, 10], [1, 5, 10], [2, 2, 10], [3, 2, 10], [0, 10, 20], [1, 10, 20], [2, 5, 20]];
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
  unavailable: ["全服奖池", "全服排行与排行奖", "轮次大奖", "大奖直播原窗口与动画", "真实付款"],
});
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse => ({ characterId: id, revision: 1,
  points: 1000, earned: 1000, day: "2026-10-15", activities: [], tasks: [], history: [], nativeCarnival: projection(), ...extra });
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
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
  it("opens with one GET, strips all eight action envelopes and never starts a draw", async () => {
    const x = setup(), stale = Object.fromEntries(effectKeys.map(key => [key, { requestId: "old", effects: ["old"] }]));
    fetchMock.mockResolvedValue(response(snapshot(x.id, stale)));
    expect(x.read()).toEqual({ accepted: true }); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of effectKeys) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each([1, 5])("submits %s draws in one immutable UUID without following POSTs", async count => {
    const x = setup(), action = { type: "draw", choice: stateToken, count };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeCarnival: projection(count, count),
      nativeCarnivalAction: { requestId: sent().requestId, effects: Array.from({ length: count }, (_, batchIndex) => ({ type: "drawn", batchIndex })) },
      nativeWheelAction: { requestId: "other", effects: ["other"] } })));
    const ack = x.request(action); expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); action.count = 100;
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][0]).toBe("/api/account/activities/carnival-native/action");
    expect(sent().action).toEqual({ type: "draw", choice: stateToken, count });
    expect(x.accept.mock.calls[0][0].snapshot?.nativeCarnivalAction?.effects).toHaveLength(count);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeWheelAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each([1, 10])("copies a bounded exchange of %s and never accepts a client price or reward", async count => {
    const x = setup(), action = { type: "exchange", choice: stateToken, index: 6, count };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeCarnival: projection(200, 0),
      nativeCarnivalAction: { requestId: sent().requestId, effects: [{ type: "exchanged" }] } })));
    expect(x.request(action).accepted).toBe(true); action.index = 0; action.count = 100;
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "exchange", choice: stateToken, index: 6, count }); expect(fetchMock).toHaveBeenCalledOnce();
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
