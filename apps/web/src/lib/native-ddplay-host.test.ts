import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { clearPendingActivity, performActivity, readPendingActivity, type ActivityResponse } from "./activities";
import { retryNativeActivityRequest, type NativeActivityHost } from "./native-activity-host";
import { attachNativeDDPlayHost, type NativeDDPlayCallbackTarget, type NativeDDPlayEnvelope } from "./native-ddplay-host";
import { attachNativeMinesHost, type NativeMinesCallbackTarget } from "./native-mines-host";

const fetchMock = vi.fn<typeof fetch>();
let nextId = 300;
const hosts: NativeActivityHost[] = [];
const response = (value: unknown) => new Response(JSON.stringify(value));
const projection = () => ({ version: 1, kind: "ddplay-native", spins: 0, score: 100, spinCost: 10,
  exchange: { cost: 10, maxCount: 10, templateId: 11019, itemCount: 1 }, lastResult: null as unknown,
  canSpin: true, canExchange: true, localRules: { version: 1, description: "本地规则" } });
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse =>
  ({ characterId: id, revision: 1, points: 100, earned: 100, day: "2026-10-15", activities: [], tasks: [], history: [],
    nativeDDPlay: projection(), ...extra });
function setup() {
  const id = ++nextId, generation = "generation-" + id, target: NativeDDPlayCallbackTarget = {};
  const accept = vi.fn((e: NativeDDPlayEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence,
    pending: false, revision: e.snapshot!.revision }));
  const reject = vi.fn();
  const host = attachNativeDDPlayHost({ characterId: id, generation, target, isCurrent: () => true,
    player: { workshopDDPlayAcceptSnapshot: accept, workshopDDPlayRejectRequest: reject } });
  hosts.push(host);
  return { id, generation, target, accept, reject, host,
    request: (action: unknown, sequence = 1) => target.workshopDDPlayRequest!(id, generation, sequence, action) };
}
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
describe("original DDPlay host", () => {
  it("only reads on open and strips all three old animation envelopes", async () => {
    const x = setup(), stale = { requestId: "old", effects: ["old"] };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativePairAction: stale, nativeMinesAction: stale, nativeDDPlayAction: stale })));
    expect(x.target.workshopDDPlayRead!(x.id, x.generation, 1)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction"])
      expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
    expect(readPendingActivity(x.id)).toBeNull();
  });
  it("stores the UUID before a fresh spin and forwards only its own confirmed effects", async () => {
    const x = setup();
    fetchMock.mockImplementation(async () => response(snapshot(x.id, {
      nativeDDPlay: { ...projection(), spins: 1, lastResult: { multiplier: 3, reels: [1, 1, 1] } },
      nativeDDPlayAction: { requestId: sent().requestId, effects: [{ type: "spun", multiplier: 3 }] },
      nativePairAction: { requestId: "other", effects: ["other"] }, nativeMinesAction: { requestId: "other", effects: ["other"] },
    })));
    const ack = x.request({ type: "spin" });
    expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "spin" });
    expect(x.accept.mock.calls[0][0].snapshot?.nativeDDPlayAction?.requestId).toBe(ack.requestId);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativePairAction");
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeMinesAction");
    expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each([1, 10])("accepts the original quantity selector boundary %i", async count => {
    const x = setup();
    fetchMock.mockImplementation(async () => response(snapshot(x.id, {
      nativeDDPlayAction: { requestId: sent().requestId, effects: [{ type: "exchanged", count }] },
    })));
    expect(x.request({ type: "exchange", count }).accepted).toBe(true);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "exchange", count });
  });
  it("rejects coercion, omitted quantity, extra fields and inherited protocol type", () => {
    const x = setup();
    for (const action of [{ type: "spin", count: 1 }, { type: "exchange" }, { type: "exchange", count: "1" },
      { type: "exchange", count: 0 }, { type: "exchange", count: 11 }, { type: "exchange", count: 1, choice: "11019" },
      { type: "constructor" }, Object.create({ type: "spin" }), Object.assign(Object.create({ count: 1 }), { type: "exchange" })])
      expect(x.request(action)).toEqual({ accepted: false });
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("keeps an uncertain request when visible reels contradict the server multiplier", async () => {
    const x = setup();
    fetchMock.mockImplementation(async () => response(snapshot(x.id, {
      nativeDDPlay: { ...projection(), spins: 1, lastResult: { multiplier: 10, reels: [1, 2, 3] } },
      nativeDDPlayAction: { requestId: sent().requestId, effects: [] },
    })));
    const ack = x.request({ type: "spin" });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    expect(x.request({ type: "spin" }, 2)).toEqual({ accepted: false });
  });
  it("strips effects on explicit same-UUID receipt replay after losing the first response", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new Error("lost"));
    const ack = x.request({ type: "spin" });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const pending = readPendingActivity(x.id)!;
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true,
      nativeDDPlayAction: { requestId: ack.requestId!, effects: ["must not animate"] } })));
    await retryNativeActivityRequest(pending);
    expect(sent().requestId).toBe(ack.requestId);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeDDPlayAction");
    expect(readPendingActivity(x.id)).toBeNull();
  });
  it("recovers a failed AS acknowledgement through the exact web receipt without a second native delivery", async () => {
    const x = setup(); x.accept.mockReturnValue(false);
    fetchMock.mockImplementation(async () => response(snapshot(x.id, {
      nativeDDPlayAction: { requestId: sent().requestId, effects: [] },
    })));
    const ack = x.request({ type: "exchange", count: 1 });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const pending = readPendingActivity(x.id)!;
    expect(retryNativeActivityRequest(pending)).toBeNull();
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true })));
    await performActivity(pending); expect(sent().requestId).toBe(ack.requestId); expect(x.accept).toHaveBeenCalledOnce();
    clearPendingActivity(pending); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("keeps DDPlay callbacks while a Mines host shares the same character request lock", async () => {
    const x = setup(), target: NativeMinesCallbackTarget = {};
    const mines = attachNativeMinesHost({ characterId: x.id, generation: "mines-generation", target, isCurrent: () => true,
      player: { workshopMinesAcceptSnapshot: vi.fn(), workshopMinesRejectRequest: vi.fn() } });
    hosts.push(mines); fetchMock.mockRejectedValue(new Error("lost"));
    const ack = x.request({ type: "spin" });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(target.workshopMinesRequest!(x.id, "mines-generation", 1, { type: "start" })).toEqual({ accepted: false });
    mines.cancel(); expect(x.target.workshopDDPlayRequest).toBeTypeOf("function");
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
