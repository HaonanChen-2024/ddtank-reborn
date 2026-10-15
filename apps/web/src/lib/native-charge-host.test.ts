import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeChargeHost, retryNativeChargeRequest, type NativeChargeCallbackTarget, type NativeChargeEnvelope } from "./native-charge-host";
const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const stateToken = "2026-10-15." + "C".repeat(43);
const reward = (templateId = 11019, count = 1) => ({ templateId, count, validDays: 0, bound: true });
const templates = [11019, 11001, 11021, 11002, 11019, 11021, 11002], counts = [3, 3, 1, 1, 6, 2, 2];
const prices = [15, 20, 25, 30, 35, 40, 50], qualifications = [0, 0, 100, 100, 300, 300, 600], limits = [1, 2, 3, 3, 3, 3, 3];
const projection = () => ({
  version: 1, kind: "charge-native", rulesVersion: 1, day: "2026-10-15", stateToken,
  currency: "local-task-points", points: 1000, taskEarned: 1000, todayClaimedTaskPoints: 200,
  grossSpent: 600, grossCapped: false, trackingStartedAt: "2026-10-15T00:00:00.000Z" as string | null,
  pages: [0, 1, 2].map(index => ({ index, originalRate: [1, 2, 4][index], title: "本地奖励",
    metric: ["today-claimed-task-points", "lifetime-task-earned", "gross-spent-since-tracking"][index],
    period: index === 0 ? "utc-day" : "permanent", current: [200, 1000, 600][index], description: "本地任务及真实扣费",
    tiers: [1, 2, 3].map(tier => ({ tier, title: "第" + tier + "档",
      claimKey: index === 1 ? "points-gift:" + tier : "charge:" + index + ":" + tier,
      current: [200, 1000, 600][index], target: (index === 0 ? [40, 100, 200] : [100, 300, 600])[tier - 1],
      claimed: false, canClaim: true, rewards: [reward(), null, null, null], reason: "可领取" })) })),
  exchange: { catalogVersion: "charge-material-v1", description: "积分兑换普通材料",
    rows: templates.map((templateId, index) => ({ index, catalogId: "charge-exchange:" + (index + 1), name: "普通材料",
      count: 1, reward: reward(templateId, counts[index]), unitPoints: prices[index],
      qualification: { metric: "lifetime-task-earned", current: 1000, target: qualifications[index], met: true },
      period: "utc-day", limit: limits[index], bought: 0, remaining: limits[index], canExchange: true, confirmRequired: true, reason: "可兑换" })) },
  rules: { source: "explicit-local-rules", grossLimit: 2_147_483_647, description: ["本地任务，无真实付款"] },
  unavailable: ["original-payment", "original-rate4-rewards", "original-item-exchange"].map(feature => ({ feature, reason: "使用明确的本地规则" })),
});
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse => ({
  characterId: id, revision: 1, points: 1000, earned: 1000, day: "2026-10-15", activities: [], tasks: [], history: [], nativeCharge: projection(), ...extra,
});
const response = (v: unknown) => new Response(JSON.stringify(v)), sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
let nextId = 10000;
function setup(isCurrent = () => true, ready = true) {
  const id = ++nextId, generation = "charge-" + id, target: NativeChargeCallbackTarget = {};
  const accept = vi.fn((e: NativeChargeEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence, pending: false, revision: e.snapshot!.revision })), reject = vi.fn();
  const host = attachNativeChargeHost({ characterId: id, generation, target, isCurrent,
    player: ready ? { workshopChargeAcceptSnapshot: accept, workshopChargeRejectRequest: reject } : {} }); hosts.push(host);
  return { id, generation, target, accept, reject, host, read: () => target.workshopChargeRead!(id, generation, 1),
    request: (action: unknown, sequence = 1) => target.workshopChargeRequest!(id, generation, sequence, action) };
}
beforeEach(() => {
  const data = new Map<string, string>(); vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); },
  }); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
const effectKeys = ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction",
  "nativeTreasureAction", "nativeWheelAction", "nativeCarnivalAction", "nativeFirstRechargeAction", "nativeChargeAction"] as const;
describe("original charge local host", () => {
  it("opens read-only and strips all ten historical action envelopes", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, Object.fromEntries(effectKeys.map(k => [k, { requestId: "old", effects: ["old"] }])))));
    x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); expect(readPendingActivity(x.id)).toBeNull();
    for (const k of effectKeys) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(k);
  });
  it.each([
    { type: "claim", index: 0, tier: 1, choice: stateToken }, { type: "claim", index: 1, tier: 2, choice: stateToken },
    { type: "claim", index: 2, tier: 3, choice: stateToken }, { type: "exchange", index: 0, count: 1, choice: stateToken },
    { type: "exchange", index: 6, count: 1, choice: stateToken },
  ])("submits one immutable server-owned action: $type/$index", async action => {
    const x = setup(), expected = { ...action }, mutable = { ...action } as Record<string, unknown>;
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeChargeAction: { requestId: sent().requestId, effects: ["fresh"] },
      nativeFirstRechargeAction: { requestId: "old", effects: ["old"] } })));
    expect(x.request(mutable).accepted).toBe(true); mutable.type = "paid"; mutable.index = 99;
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(sent().action).toEqual(expected); expect(fetchMock).toHaveBeenCalledOnce();
    expect(x.accept.mock.calls[0][0].snapshot?.nativeChargeAction?.effects).toEqual(["fresh"]);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeFirstRechargeAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("rejects payment, reward injection, extra keys and unbounded exchange quantities before fetching", () => {
    const x = setup(); let sequence = 0;
    for (const action of [
      { type: "claim", index: 3, tier: 1, choice: stateToken }, { type: "claim", index: 0, tier: 0, choice: stateToken },
      { type: "claim", index: 0, tier: 4, choice: stateToken }, { type: "claim", index: 0, tier: 1, choice: stateToken, reward: 999 },
      { type: "claim", index: 0, tier: 1, choice: stateToken.slice(0, -1) }, { type: "claim", index: 0, tier: 1 },
      { type: "exchange", index: 0, count: 2, choice: stateToken }, { type: "exchange", index: -1, count: 1, choice: stateToken },
      { type: "exchange", index: 7, count: 1, choice: stateToken }, { type: "exchange", index: 0, count: 1, choice: stateToken, cost: 0 },
      { type: "pay", index: 0, count: 1, choice: stateToken }, Object.create({ type: "claim", index: 0, tier: 1, choice: stateToken }),
    ]) expect(x.request(action, ++sequence).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each(["price", "canonical-claim", "private-state", "untracked-gross"])("refuses incompatible public data: %s", async kind => {
    const x = setup(), p = projection();
    if (kind === "price") p.exchange.rows[0]!.unitPoints = 0;
    if (kind === "canonical-claim") p.pages[1]!.tiers[0]!.claimKey = "second-award";
    if (kind === "private-state") Object.assign(p, { state: {} });
    if (kind === "untracked-gross") p.trackingStartedAt = null;
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeCharge: p }))); x.read();
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
  });
  it("accepts a daily-cap snapshot with purchases disabled and task claims still readable", async () => {
    const x = setup(), p = projection(); for (const row of p.exchange.rows) row.canExchange = false;
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeCharge: p }))); x.read();
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it("retries an uncertain exchange with the same UUID and suppresses replay effects", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    const ack = x.request({ type: "exchange", index: 0, count: 1, choice: stateToken });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); const pending = readPendingActivity(x.id)!, first = sent(); expect(pending.requestId).toBe(ack.requestId);
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeChargeAction: { requestId: ack.requestId!, effects: ["old"] } })));
    await retryNativeChargeRequest(pending); expect(sent()).toEqual(first); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeChargeAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("refuses wrong role, generation, retired player and missing player callbacks", () => {
    let current = true; const x = setup(() => current);
    expect(x.target.workshopChargeRead!(x.id + 1, x.generation, 1).accepted).toBe(false);
    expect(x.target.workshopChargeRead!(x.id, "old", 2).accepted).toBe(false); current = false;
    expect(x.read().accepted).toBe(false); const missing = setup(() => true, false); expect(missing.read().accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); x.host.cancel(); expect(x.target.workshopChargeRequest).toBeUndefined();
  });
});
