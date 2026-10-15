import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeFirstRechargeHost, retryNativeFirstRechargeRequest, type NativeFirstRechargeCallbackTarget, type NativeFirstRechargeEnvelope } from "./native-first-recharge-host";
import { attachNativeCarnivalHost, type NativeCarnivalCallbackTarget } from "./native-carnival-host";
const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const stateToken = "2026-10-15." + "F".repeat(43), cardId = "d0b78c9a-33ce-49f6-a1ca-3747fe309a43";
const materials = [11019, 11001, 11021, 11002], counts = [3, 3, 1, 1], prices = [15, 20, 25, 30];
const reward = (templateId = 11019, count = 1) => ({ templateId, count, validDays: 0, bound: true });
const projection = () => ({
  version: 1, kind: "first-recharge-native", rulesVersion: 1, day: "2026-10-15", stateToken,
  currency: "local-task-points", points: 1000, taskEarned: 1000,
  tiers: [1, 2, 3].map(tier => ({ tier, claimKey: tier === 1 ? "first-gift" : "first-recharge-native:tier:" + tier,
    title: "任务第" + tier + "档", qualification: { metric: tier === 1 ? "completed-board" : "task-earned", current: tier === 1 ? 1 : 1000, target: tier === 1 ? 1 : tier === 2 ? 200 : 600, met: true },
    entitlementStatus: "ready", activeCardId: null, claimed: false, canClaim: true,
    rewards: [reward(), reward(11021), null, null, null, null], reason: "已解锁" })),
  shop: { availability: "local-defined", catalogVersion: "first-shop-v1", reason: "积分商城",
    rows: materials.map((templateId, index) => ({ index, catalogId: "first-shop:" + templateId + ":" + counts[index],
      kind: "material", name: "普通材料", reward: reward(templateId, counts[index]), unitPoints: prices[index],
      quantityEditable: false, maxPerRequest: 1, period: "utc-day", limit: 10, bought: 0, remaining: 10, canBuy: 1 })) },
  cards: { availability: "local-defined", policyVersion: 1,
    definitions: [1, 2, 3].map(kind => ({ kind, label: "任务凭证" + kind, associatedTier: kind, source: "earned-task-entitlement",
      validity: "permanent", unitPoints: 0, maxPerCharacter: 1, transferable: true, entitlement: "canonical-tier-claim" })), cards: [] as Record<string, unknown>[] },
  capabilities: { reward: true, materialShop: true, validateCard: true, useCard: true, giftCard: true },
  rules: { source: "explicit-local-rules", description: ["任务解锁，无真实付款"] }, unavailable: [],
});
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse => ({
  characterId: id, revision: 1, points: 1000, earned: 1000, day: "2026-10-15",
  activities: [], tasks: [], history: [], nativeFirstRecharge: projection(), ...extra,
});
const response = (v: unknown) => new Response(JSON.stringify(v)), sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
let nextId = 9000;
function setup(isCurrent = () => true, ready = true) {
  const id = ++nextId, generation = "first-" + id, target: NativeFirstRechargeCallbackTarget = {};
  const accept = vi.fn((e: NativeFirstRechargeEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence, pending: false, revision: e.snapshot!.revision })), reject = vi.fn();
  const host = attachNativeFirstRechargeHost({ characterId: id, generation, target, isCurrent,
    player: ready ? { workshopFirstRechargeAcceptSnapshot: accept, workshopFirstRechargeRejectRequest: reject } : {} }); hosts.push(host);
  return { id, generation, target, accept, reject, host,
    read: () => target.workshopFirstRechargeRead!(id, generation, 1),
    request: (action: unknown, sequence = 1) => target.workshopFirstRechargeRequest!(id, generation, sequence, action) };
}
beforeEach(() => {
  const data = new Map<string, string>(); vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); },
  }); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
const effectKeys = ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction",
  "nativeTreasureAction", "nativeWheelAction", "nativeCarnivalAction", "nativeFirstRechargeAction"] as const;
describe("original first-recharge local host", () => {
  it("opens read-only and strips all nine historical action envelopes", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, Object.fromEntries(effectKeys.map(k => [k, { requestId: "old", effects: ["old"] }])))));
    x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); expect(readPendingActivity(x.id)).toBeNull();
    for (const k of effectKeys) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(k);
  });
  it.each([
    { type: "claim", tier: 1, choice: stateToken }, { type: "claim", tier: 3, choice: stateToken },
    { type: "issue-card", tier: 2, choice: stateToken }, { type: "buy", index: 3, count: 1, choice: stateToken },
    { type: "validate-card", cardId, choice: stateToken }, { type: "use-card", cardId, choice: stateToken },
    { type: "gift-card", cardId, recipientName: "本地好友", choice: stateToken },
  ])("submits one immutable server-owned action: $type", async action => {
    const x = setup(), expected = { ...action }, mutable = { ...action } as Record<string, unknown>;
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeFirstRechargeAction: { requestId: sent().requestId, effects: ["fresh"] },
      nativeCarnivalAction: { requestId: "old", effects: ["old"] } })));
    expect(x.request(mutable).accepted).toBe(true); mutable.type = "paid"; mutable.cardId = "other"; mutable.recipientName = "other";
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(sent().action).toEqual(expected); expect(fetchMock).toHaveBeenCalledOnce();
    expect(x.accept.mock.calls[0][0].snapshot?.nativeFirstRechargeAction?.effects).toEqual(["fresh"]);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeCarnivalAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("rejects payment, price/template injection, unbounded or inherited fields and bad recipient input", () => {
    const x = setup();
    for (const action of [
      { type: "claim", tier: 0, choice: stateToken }, { type: "claim", tier: 4, choice: stateToken },
      { type: "claim", tier: 1, choice: stateToken, reward: 999 }, { type: "claim", tier: 1 },
      { type: "buy", index: 0, count: 2, choice: stateToken }, { type: "buy", index: 4, count: 1, choice: stateToken },
      { type: "buy", index: 0, count: 1, choice: stateToken, cost: 0 }, { type: "buy-card", tier: 1, choice: stateToken },
      { type: "use-card", cardId: "12772", choice: stateToken }, { type: "gift-card", cardId, recipientName: " friend", choice: stateToken },
      { type: "gift-card", cardId, recipientName: "x".repeat(65), choice: stateToken }, { type: "gift-card", cardId, recipientName: "a\nb", choice: stateToken },
      { type: "validate-card", cardId, choice: "old" }, Object.create({ type: "claim", tier: 1, choice: stateToken }),
    ]) expect(x.request(action).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("refuses incompatible balances, catalogs, card rights and private proof leaks", async () => {
    const mutate = [
      (p: ReturnType<typeof projection>) => { p.points--; }, (p: ReturnType<typeof projection>) => { p.shop.rows[0]!.unitPoints = 0; },
      (p: ReturnType<typeof projection>) => { p.shop.rows[0]!.remaining--; }, (p: ReturnType<typeof projection>) => { p.tiers[0]!.claimKey = "new"; },
      (p: ReturnType<typeof projection>) => { p.tiers[0]!.claimed = true; }, (p: ReturnType<typeof projection>) => { p.cards.definitions[0]!.validity = "monthly"; },
      (p: ReturnType<typeof projection>) => { Object.assign(p, { cardSlots: [] }); }, (p: ReturnType<typeof projection>) => { p.day = "2026-02-30"; },
    ];
    for (const change of mutate) {
      const x = setup(), p = projection(); change(p); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeFirstRecharge: p })));
      x.read(); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("accepts a received permanent card that cannot be gifted again", async () => {
    const x = setup(), p = projection(); p.cards.cards.push({ cardId, kind: 2, associatedTier: 2, status: "owned",
      acquiredAt: "2026-10-15T01:00:00.000Z", expiresAt: null, senderName: "好友", canValidate: true, canUse: true, canGift: false, reason: "受赠凭证" });
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeFirstRecharge: p }))); x.read();
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it("keeps task claims readable when the shared daily action cap disables material purchases", async () => {
    const x = setup(), p = projection(); for (const row of p.shop.rows) row.canBuy = 0;
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeFirstRecharge: p }))); x.read();
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it("retries an uncertain gift with the same UUID and suppresses replay effects", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new TypeError("lost response")); const ack = x.request({ type: "gift-card", cardId, recipientName: "好友", choice: stateToken });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); const pending = readPendingActivity(x.id)!, first = sent(); expect(pending.requestId).toBe(ack.requestId);
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeFirstRechargeAction: { requestId: ack.requestId!, effects: ["old-gift"] } })));
    await retryNativeFirstRechargeRequest(pending); expect(sent()).toEqual(first); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeFirstRechargeAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("leaves a late submitted gift pending when its player is closed", async () => {
    const x = setup(); let done!: (v: Response) => void; fetchMock.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const ack = x.request({ type: "gift-card", cardId, recipientName: "好友", choice: stateToken }); await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    x.host.cancel(); done(response(snapshot(x.id))); await new Promise(resolve => setTimeout(resolve, 0));
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); expect(x.target.workshopFirstRechargeRequest).toBeUndefined();
  });
  it("shares the character ledger and refuses wrong role, generation and missing player methods", async () => {
    let current = true; const x = setup(() => current); fetchMock.mockRejectedValueOnce(new TypeError("lost"));
    x.request({ type: "issue-card", tier: 1, choice: stateToken }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const target: NativeCarnivalCallbackTarget = {}, other = attachNativeCarnivalHost({ characterId: x.id, generation: "c", target, isCurrent: () => true,
      player: { workshopCarnivalAcceptSnapshot: () => true, workshopCarnivalRejectRequest: () => true } }); hosts.push(other);
    expect(target.workshopCarnivalRead!(x.id, "c", 1).accepted).toBe(false);
    expect(x.target.workshopFirstRechargeRead!(x.id + 1, x.generation, 2).accepted).toBe(false);
    expect(x.target.workshopFirstRechargeRead!(x.id, "old", 2).accepted).toBe(false); current = false;
    expect(x.read().accepted).toBe(false); const missing = setup(() => true, false); expect(missing.read().accepted).toBe(false); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
