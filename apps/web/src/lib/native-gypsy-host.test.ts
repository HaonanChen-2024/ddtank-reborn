import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import { type NativeActivityHost } from "./native-activity-host";
import { attachNativeGypsyHost, retryNativeGypsyRequest, type NativeGypsyCallbackTarget, type NativeGypsyEnvelope } from "./native-gypsy-host";
import { attachNativeDDPlayHost, type NativeDDPlayCallbackTarget } from "./native-ddplay-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
let nextId = 500;
const response = (value: unknown) => new Response(JSON.stringify(value));
const projection = () => ({ version: 1, kind: "gypsy-native", started: false, day: "2026-10-15", score: 100,
  shelfKey: null as string | null, shelfDay: null as string | null, refreshes: 0, slots: 8, freeRefresh: true,
  refreshCost: 0, canRefresh: true, offers: [] as unknown[], previewTemplateIds: [11019, 11001, 11021, 11002],
  localRules: { version: 1, description: "本地8格货架，旧网页3格兼容" } });
const stocked = (size: 3 | 8 = 8) => ({ ...projection(), started: true, shelfKey: "2026-10-15:1",
  shelfDay: "2026-10-15", refreshes: 1, freeRefresh: false, refreshCost: 5,
  offers: Array.from({ length: size }, (_, index) => {
    const [templateId, itemCount, price] = [[11019, 3, 15], [11001, 3, 20], [11021, 1, 25], [11002, 1, 30]][index % 4];
    return { index, templateId, itemCount, price, sold: false, canBuy: true };
  }) });
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse =>
  ({ characterId: id, revision: 1, points: 100, earned: 100, day: "2026-10-15", activities: [], tasks: [], history: [],
    nativeGypsy: projection(), ...extra });
function setup(isCurrent: () => boolean = () => true) {
  const id = ++nextId, generation = "gypsy-" + id, target: NativeGypsyCallbackTarget = {};
  const accept = vi.fn((e: NativeGypsyEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence,
    pending: false, revision: e.snapshot!.revision })), reject = vi.fn();
  const host = attachNativeGypsyHost({ characterId: id, generation, target, isCurrent,
    player: { workshopGypsyAcceptSnapshot: accept, workshopGypsyRejectRequest: reject } }); hosts.push(host);
  return { id, generation, target, accept, reject, host,
    request: (action: unknown, sequence = 1) => target.workshopGypsyRequest!(id, generation, sequence, action) };
}
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
describe("original Gypsy host", () => {
  it("only reads and strips all four effect envelopes without refreshing a shelf", async () => {
    const x = setup(), stale = { requestId: "old", effects: ["old"] };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativePairAction: stale, nativeMinesAction: stale,
      nativeDDPlayAction: stale, nativeGypsyAction: stale })));
    expect(x.target.workshopGypsyRead!(x.id, x.generation, 1)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction"])
      expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
    expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each([3, 8] as const)("accepts the shared %i-offer shelf without rewriting it", async size => {
    const x = setup();
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeGypsy: stocked(size) })));
    x.target.workshopGypsyRead!(x.id, x.generation, 1);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(x.accept.mock.calls[0][0].snapshot!.nativeGypsy).toEqual(stocked(size));
  });
  it("stores a UUID before explicit free refresh and delivers only its own fresh effects", async () => {
    const x = setup(), other = { requestId: "other", effects: ["other"] };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeGypsy: stocked(),
      nativeGypsyAction: { requestId: sent().requestId, effects: [{ type: "refreshed", offerCount: 8, cost: 0 }] },
      nativePairAction: other, nativeMinesAction: other, nativeDDPlayAction: other })));
    const ack = x.request({ type: "refresh", choice: "free" });
    expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "refresh", choice: "free" });
    expect(x.accept.mock.calls[0][0].snapshot?.nativeGypsyAction?.requestId).toBe(ack.requestId);
    for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction"])
      expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
    expect(readPendingActivity(x.id)).toBeNull();
  });
  it("keeps a valid legacy shelf with a different saved date and the API free-refresh semantics", async () => {
    const x = setup(), old = { ...stocked(3), shelfDay: "2026-10-16", shelfKey: "2026-10-16:1", freeRefresh: true, refreshCost: 0 };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeGypsy: old })));
    x.target.workshopGypsyRead!(x.id, x.generation, 1);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(x.accept.mock.calls[0][0].snapshot!.nativeGypsy).toEqual(old);
  });
  it("buys the eighth quoted bundle with its exact shelf token and no client amount or price", async () => {
    const x = setup();
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeGypsy: stocked(),
      nativeGypsyAction: { requestId: sent().requestId, effects: [{ type: "bought", index: 7 }] } })));
    expect(x.request({ type: "buy", index: 7, choice: "2026-10-15:1" }).accepted).toBe(true);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "buy", index: 7, choice: "2026-10-15:1" });
  });
  it("rejects coerced, inherited, extra, unquoted or payment actions without a request", () => {
    const x = setup();
    for (const action of [{ type: "refresh" }, { type: "refresh", choice: "coins" }, { type: "refresh", choice: "free", index: 0 },
      { type: "buy", index: "1", choice: "2026-10-15:1" }, { type: "buy", index: 8, choice: "2026-10-15:1" },
      { type: "buy", index: 0 }, { type: "buy", index: 0, choice: "2026-10-15:0" },
      { type: "buy", index: 0, choice: "2026-10-15:1000000001" },
      { type: "buy", index: 0, choice: "2026-10-15:1", count: 1 },
      { type: "buy", index: 0, choice: "2026-10-15:1", templateId: 11019 },
      Object.assign(Object.create({ choice: "free" }), { type: "refresh" }), Object.create({ type: "refresh", choice: "free" })])
      expect(x.request(action)).toEqual({ accepted: false });
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("keeps the request unresolved when the public quoted bundle is inconsistent", async () => {
    const x = setup(), invalid = stocked(); invalid.offers[0] = { index: 0, templateId: 11019, itemCount: 99, price: 15, sold: false, canBuy: true };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeGypsy: invalid,
      nativeGypsyAction: { requestId: sent().requestId, effects: [] } })));
    const ack = x.request({ type: "buy", index: 0, choice: "2026-10-15:1" });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    expect(x.request({ type: "refresh", choice: "points" }, 2)).toEqual({ accepted: false });
  });
  it("rejects malformed balance, shelf, prices, preview, flags and private state before native delivery", async () => {
    const duplicate = stocked(); duplicate.offers[7] = { index: 7, templateId: 11019, itemCount: 3, price: 15, sold: false, canBuy: true };
    for (const invalid of [{ ...stocked(), score: 101 }, { ...stocked(), slots: 3 }, { ...stocked(), shelfKey: "2026-10-15:2" },
      { ...stocked(), refreshCost: 0 }, { ...stocked(), shelfDay: "2026-10-16" }, { ...stocked(), offers: stocked().offers.slice(0, 4) }, duplicate,
      { ...stocked(), previewTemplateIds: [11019, 11001, 11021, 99999] }, { ...stocked(), state: {} },
      { ...projection(), shelfKey: "2026-10-15:1" }]) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeGypsy: invalid })));
      x.target.workshopGypsyRead!(x.id, x.generation, 1);
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
    }
  });
  it("retries the same UUID explicitly after a lost reply and strips replayed effects", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new Error("lost"));
    const ack = x.request({ type: "refresh", choice: "free" });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); const pending = readPendingActivity(x.id)!;
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeGypsy: stocked(),
      nativeGypsyAction: { requestId: ack.requestId!, effects: ["must not repeat"] } })));
    await retryNativeGypsyRequest(pending);
    expect(sent().requestId).toBe(ack.requestId); expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeGypsyAction");
    expect(readPendingActivity(x.id)).toBeNull();
  });
  it("keeps separate DDPlay callbacks while sharing the character-wide pending lock", async () => {
    const x = setup(), target: NativeDDPlayCallbackTarget = {};
    hosts.push(attachNativeDDPlayHost({ characterId: x.id, generation: "ddplay", target, isCurrent: () => true,
      player: { workshopDDPlayAcceptSnapshot: vi.fn(), workshopDDPlayRejectRequest: vi.fn() } }));
    fetchMock.mockRejectedValue(new Error("lost")); const ack = x.request({ type: "refresh", choice: "free" });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(target.workshopDDPlayRequest!(x.id, "ddplay", 1, { type: "spin" })).toEqual({ accepted: false });
    expect(x.target.workshopGypsyRequest).toBeTypeOf("function"); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("rejects a different role, generation or a departed game instance before starting", () => {
    let current = true; const x = setup(() => current);
    expect(x.target.workshopGypsyRequest!(x.id + 1, x.generation, 1, { type: "refresh", choice: "free" })).toEqual({ accepted: false });
    expect(x.target.workshopGypsyRead!(x.id, "other", 1)).toEqual({ accepted: false });
    current = false; expect(x.request({ type: "refresh", choice: "free" })).toEqual({ accepted: false }); expect(fetchMock).not.toHaveBeenCalled();
  });
});
