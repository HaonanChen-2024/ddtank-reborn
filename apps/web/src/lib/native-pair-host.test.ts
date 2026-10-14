import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import {
  clearPendingActivity, isActivityInFlight, performActivity, readPendingActivity, savePendingActivity,
  type ActivityRequest, type ActivityResponse,
} from "./activities";
import {
  attachNativePairHost, retryNativePairRequest, type NativePairCallbackTarget, type NativePairEnvelope,
  type NativePairHost,
} from "./native-pair-host";

const fetchMock = vi.fn<typeof fetch>();
let characterId = 100;
let host: NativePairHost | undefined;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function snapshot(id: number, revision = 1, extra: Partial<ActivityResponse> = {}): ActivityResponse {
  return { characterId: id, revision, points: 100, earned: 100, day: "2026-10-15", activities: [], tasks: [], history: [],
    nativePair: { started: false, localRules: { version: 1, slots: 32 } }, ...extra };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const id = ++characterId, generation = `generation-${id}`;
  const target: NativePairCallbackTarget = {};
  const accept = vi.fn((envelope: NativePairEnvelope): unknown => ({ characterId: id, generation,
    sequence: envelope.sequence, pending: false, revision: envelope.snapshot!.revision }));
  const reject = vi.fn();
  const onSnapshot = vi.fn(), onStatus = vi.fn(), isCurrent = vi.fn(() => true);
  host = attachNativePairHost({ player: { workshopPairAcceptSnapshot: accept, workshopPairRejectRequest: reject },
    characterId: id, generation, target, isCurrent, onSnapshot, onStatus });
  const request = (sequence = 1, action: unknown = { type: "start" }) => target.workshopPairRequest!(id, generation, sequence, action);
  const read = (sequence = 1) => target.workshopPairRead!(id, generation, sequence);
  return { id, generation, target, accept, reject, onSnapshot, onStatus, isCurrent, request, read, host };
}
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body)) as ActivityRequest;
const complete = async (count = 1) => { await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(count), { interval: 1 }); };

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { host?.cancel(); vi.unstubAllGlobals(); });

describe("native pair host and shared activity ledger", () => {
  it("returns accepted UUID before any fetch or callback and clears only after an exact AS acknowledgement", async () => {
    const x = setup(), gate = deferred<Response>(); fetchMock.mockReturnValue(gate.promise);
    const ack = x.request();
    expect(ack.accepted).toBe(true);
    expect(ack.requestId).toMatch(/^[\da-f-]{36}$/);
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    expect(fetchMock).not.toHaveBeenCalled(); expect(x.accept).not.toHaveBeenCalled();
    x.accept.mockImplementation(envelope => {
      expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
      return { characterId: x.id, generation: x.generation, sequence: 1, pending: false, revision: envelope.snapshot!.revision };
    });
    await complete();
    expect(sent().requestId).toBe(ack.requestId);
    gate.resolve(response(snapshot(x.id, 1, { nativePairAction: { requestId: ack.requestId!, effects: [{ type: "started" }] } })));
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce(), { interval: 1 });
    expect(x.accept.mock.calls[0][0].snapshot?.nativePairAction?.effects).toEqual([{ type: "started" }]);
    expect(readPendingActivity(x.id)).toBeNull(); expect(x.onSnapshot).toHaveBeenCalledOnce();
  });

  it("opening reads only and never animates action effects from a GET snapshot", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, 1, { nativePairAction: { requestId: "old", effects: ["old"] } })));
    expect(x.read()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce(), { interval: 1 });
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativePairAction");
    expect(readPendingActivity(x.id)).toBeNull();
  });

  it("retains one UUID across lost response, login expiry and explicit replay retry, without replay animation", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new Error("connection lost"));
    const ack = x.request();
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce(), { interval: 1 });
    const pending = readPendingActivity(x.id)!;
    expect(x.reject.mock.calls[0][0]).toMatchObject({ definitive: false, requestId: ack.requestId });
    fetchMock.mockResolvedValueOnce(response({ message: "登录已失效" }, 401));
    await expect(retryNativePairRequest(pending)).rejects.toMatchObject({ uncertain: true });
    expect(readPendingActivity(x.id)).toEqual(pending);
    expect(x.reject.mock.calls[1][0].definitive).toBe(false);
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, 3, { replayed: true, nativePairAction: { requestId: pending.requestId, effects: ["old"] } })));
    await expect(retryNativePairRequest(pending)).resolves.toMatchObject({ revision: 3 });
    expect(fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body)).requestId)).toEqual([pending.requestId, pending.requestId, pending.requestId]);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativePairAction");
    expect(readPendingActivity(x.id)).toBeNull();
  });

  it("clears an explicitly rejected request and allows a later user action", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response({ message: "积分不足" }, 400));
    x.request();
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce(), { interval: 1 });
    expect(x.reject.mock.calls[0][0]).toMatchObject({ definitive: true, message: "积分不足" });
    expect(readPendingActivity(x.id)).toBeNull();
    expect(x.request(2).accepted).toBe(true);
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledTimes(2), { interval: 1 });
  });

  it("rejects wrong role/generation/sequence, inherited action types and coercible fields without throwing or submitting", () => {
    const x = setup();
    expect(x.target.workshopPairRead!(x.id + 1, x.generation, 1).accepted).toBe(false);
    expect(x.target.workshopPairRead!(x.id, "old-generation", 1).accepted).toBe(false);
    for (const seq of [0, -1, 0.1, NaN, Infinity]) expect(x.read(seq).accepted).toBe(false);
    for (const action of [{ type: "constructor" }, { type: "__proto__" }, { type: "toString" },
      { type: "flip", index: 33, choice: "points" }, { type: "flip", index: 1, choice: { toString: () => "points" } },
      { type: "exchange", count: 1, choice: 11019 }, { type: "start", count: 1 }]) expect(x.request(1, action).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });

  it("rejects duplicate or older sequences after successful read and bounds module status reports", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id)));
    x.read(4); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce(), { interval: 1 });
    expect(x.read(4).accepted).toBe(false); expect(x.request(3).accepted).toBe(false);
    for (const s of [{ characterId: x.id + 1, generation: x.generation, sequence: 4 },
      { characterId: x.id, generation: "old", sequence: 4 }, { characterId: x.id, generation: x.generation, sequence: 3 }]) x.target.workshopPairReport!(s);
    expect(x.onStatus).not.toHaveBeenCalled();
    const status = { characterId: x.id, generation: x.generation, sequence: 4, phase: "ready", open: true };
    x.target.workshopPairReport!(status); expect(x.onStatus).toHaveBeenCalledWith(status);
  });

  it.each(["wrong request", "wrong character", "regressed revision", "hidden state"])("retains pending without AS delivery for %s", async problem => {
    const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, 5)));
    x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce(), { interval: 1 });
    const gate = deferred<Response>(); fetchMock.mockReturnValueOnce(gate.promise);
    const ack = x.request(2);
    const value = snapshot(x.id, 6, { nativePairAction: { requestId: ack.requestId!, effects: [] } });
    if (problem === "wrong request") value.nativePairAction!.requestId = "not-this-request";
    if (problem === "wrong character") value.characterId++;
    if (problem === "regressed revision") value.revision = 4;
    if (problem === "hidden state") value.nativePair = { started: false, state: {}, localRules: { version: 1, slots: 32 } };
    await complete(2); gate.resolve(response(value));
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce(), { interval: 1 });
    expect(x.accept).toHaveBeenCalledOnce(); expect(x.reject.mock.calls[0][0].definitive).toBe(false);
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });

  it.each(["throw", "false", "missing revision"])("keeps the UUID after callback %s and permits web receipt recovery", async failure => {
    const x = setup();
    x.accept.mockImplementation(() => {
      if (failure === "throw") throw new Error("render failed after pending=false");
      if (failure === "false") return false;
      return { characterId: x.id, generation: x.generation, sequence: 1, pending: false };
    });
    const gate = deferred<Response>(); fetchMock.mockReturnValueOnce(gate.promise);
    const ack = x.request(); await complete();
    gate.resolve(response(snapshot(x.id, 2, { nativePairAction: { requestId: ack.requestId!, effects: [] } })));
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce(), { interval: 1 });
    const pending = readPendingActivity(x.id)!; expect(pending.requestId).toBe(ack.requestId);
    expect(retryNativePairRequest(pending)).toBeNull();
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, 3, { replayed: true })));
    await performActivity(pending); clearPendingActivity(pending);
    expect(sent().requestId).toBe(ack.requestId); expect(readPendingActivity(x.id)).toBeNull();
    expect(x.accept).toHaveBeenCalledOnce();
  });

  it("does not auto retry stored web work and prevents a native action from replacing it", () => {
    const x = setup(); const old = { characterId: x.id, activityId: "mines", requestId: "original-web-uuid", action: { type: "start" } };
    savePendingActivity(old);
    expect(x.read().accepted).toBe(false); expect(x.request().accepted).toBe(false);
    expect(readPendingActivity(x.id)).toEqual(old); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to submit when the pending UUID cannot be saved", () => {
    const x = setup();
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(x.request().accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(x.accept).not.toHaveBeenCalled();
    expect(x.onStatus.mock.calls.at(-1)?.[0].message).toContain("尚未提交");
  });

  it("keeps the recoverable UUID if storage removal fails after AS accepted the response", async () => {
    const x = setup(), gate = deferred<Response>(); fetchMock.mockReturnValue(gate.promise);
    const ack = x.request(); await complete();
    vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    gate.resolve(response(snapshot(x.id, 2, { nativePairAction: { requestId: ack.requestId!, effects: [] } })));
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce(), { interval: 1 });
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    expect(x.reject.mock.calls[0][0].definitive).toBe(false);
    expect(retryNativePairRequest(readPendingActivity(x.id)!)).toBeNull();
  });

  it("cancellation before the queued dispatch sends nothing and preserves explicit recovery", async () => {
    const x = setup(); const ack = x.request(); x.host.cancel();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled(); expect(x.accept).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });

  it("closing only the original window allows its pending response to synchronize without reopening it", async () => {
    const x = setup(), gate = deferred<Response>(); fetchMock.mockReturnValue(gate.promise);
    const ack = x.request(); await complete();
    const closedStatus = { characterId: x.id, generation: x.generation, sequence: 1, open: false, phase: "ready", pending: true };
    x.target.workshopPairReport!(closedStatus);
    x.accept.mockImplementation(envelope => ({ ...closedStatus, pending: false, revision: envelope.snapshot!.revision }));
    gate.resolve(response(snapshot(x.id, 2, { nativePairAction: { requestId: ack.requestId!, effects: [] } })));
    await vi.waitFor(() => expect(x.onSnapshot).toHaveBeenCalledOnce(), { interval: 1 });
    expect(x.onStatus).toHaveBeenCalledWith(closedStatus);
    expect(readPendingActivity(x.id)).toBeNull();
    // Host has only snapshot/reject capabilities; it cannot call an open callback.
    expect(x.accept).toHaveBeenCalledOnce();
  });

  it("shares a single HTTP flight and rejects web/native actions that would overwrite an unresolved request", async () => {
    const x = setup(), gate = deferred<Response>(); fetchMock.mockReturnValue(gate.promise);
    const ack = x.request(); const pending = readPendingActivity(x.id)!;
    await complete(); expect(isActivityInFlight(x.id)).toBe(true);
    const sameFlight = performActivity(pending);
    const other = { ...pending, action: { type: "reset", choice: "points" } };
    expect(() => savePendingActivity(other)).toThrow("未确认");
    await expect(performActivity(other)).rejects.toMatchObject({ uncertain: true });
    expect(x.request(2).accepted).toBe(false); expect(fetchMock).toHaveBeenCalledOnce();
    gate.resolve(response(snapshot(x.id, 2, { nativePairAction: { requestId: ack.requestId!, effects: [] } })));
    await sameFlight; await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce(), { interval: 1 });
    expect(isActivityInFlight(x.id)).toBe(false);
  });

  it("cancel aborts a POST, retains its UUID and suppresses even a successful late response", async () => {
    const x = setup(), gate = deferred<Response>(); fetchMock.mockReturnValue(gate.promise);
    const ack = x.request(); await complete();
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    x.host.cancel(); expect(signal.aborted).toBe(true);
    gate.resolve(response(snapshot(x.id, 2, { nativePairAction: { requestId: ack.requestId!, effects: [] } })));
    await vi.waitFor(() => expect(isActivityInFlight(x.id)).toBe(false), { interval: 1 });
    expect(x.accept).not.toHaveBeenCalled(); expect(x.reject).not.toHaveBeenCalled(); expect(x.onSnapshot).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });

  it("a removed role cannot deliver late callbacks even before explicit host cleanup", async () => {
    const x = setup(), gate = deferred<Response>(); fetchMock.mockReturnValue(gate.promise);
    x.read(); await complete(); x.isCurrent.mockReturnValue(false);
    gate.resolve(response(snapshot(x.id))); await new Promise(resolve => setTimeout(resolve, 10));
    expect(x.accept).not.toHaveBeenCalled(); expect(x.reject).not.toHaveBeenCalled(); expect(x.onSnapshot).not.toHaveBeenCalled();
  });

  it("old cancellation cannot delete a replacement host's callbacks or restore an old result", async () => {
    const a = setup(), gate = deferred<Response>(); fetchMock.mockReturnValueOnce(gate.promise);
    a.read(); await complete();
    const bAccept = vi.fn((envelope: NativePairEnvelope) => ({ characterId: a.id, generation: "replacement", sequence: envelope.sequence,
      pending: false, revision: envelope.snapshot!.revision }));
    host = attachNativePairHost({ characterId: a.id, generation: "replacement", isCurrent: () => true, target: a.target,
      player: { workshopPairAcceptSnapshot: bAccept, workshopPairRejectRequest: vi.fn() } });
    a.host.cancel();
    fetchMock.mockResolvedValueOnce(response(snapshot(a.id, 3)));
    expect(a.target.workshopPairRead!(a.id, "replacement", 1).accepted).toBe(true);
    await vi.waitFor(() => expect(bAccept).toHaveBeenCalledOnce(), { interval: 1 });
    gate.resolve(response(snapshot(a.id, 1))); await new Promise(resolve => setTimeout(resolve, 10));
    expect(a.accept).not.toHaveBeenCalled(); expect(a.onSnapshot).not.toHaveBeenCalled();
  });
});
