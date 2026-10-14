import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { clearPendingActivity, performActivity, readPendingActivity, type ActivityResponse } from "./activities";
import { retryNativeActivityRequest, type NativeActivityHost } from "./native-activity-host";
import { attachNativeMinesHost, type NativeMinesCallbackTarget, type NativeMinesEnvelope } from "./native-mines-host";
import { attachNativePairHost, type NativePairCallbackTarget } from "./native-pair-host";

const fetchMock = vi.fn<typeof fetch>();
let nextId = 200;
const hosts: NativeActivityHost[] = [];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function snapshot(id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse {
  return { characterId: id, revision: 1, points: 100, earned: 100, day: "2026-10-15", activities: [], tasks: [], history: [],
    nativeMines: { started: false, localRules: { version: 1, width: 10, height: 7, manualClaims: true } },
    nativePair: { started: false, localRules: { version: 1, slots: 32 } }, ...extra };
}
function board() {
  return { started: true, version: 1, kind: "mines-native", width: 10, height: 7, hp: 3, openCount: 0, currentIndex: null,
    claims: [{ tier: 1 }, { tier: 2 }, { tier: 3 }],
    localRules: { version: 1, width: 10, height: 7, manualClaims: true },
    cells: Array.from({ length: 70 }, (_, index) => ({ index, opened: false, marked: false, probed: false })) };
}
function setup(id = ++nextId) {
  const generation = "generation-" + id;
  const target: NativeMinesCallbackTarget = {};
  const accept = vi.fn((e: NativeMinesEnvelope): unknown => ({ characterId: id, generation,
    sequence: e.sequence, pending: false, revision: e.snapshot!.revision }));
  const reject = vi.fn(), isCurrent = vi.fn(() => true);
  const host = attachNativeMinesHost({ characterId: id, generation, target, isCurrent,
    player: { workshopMinesAcceptSnapshot: accept, workshopMinesRejectRequest: reject } });
  hosts.push(host);
  return { id, generation, target, accept, reject, isCurrent, host,
    request: (action: unknown, seq = 1) => target.workshopMinesRequest!(id, generation, seq, action),
    read: () => target.workshopMinesRead!(id, generation, 1) };
}
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });

describe("native 70-cell mines host", () => {
  it("opens with a read only, strips effects from both modules and never creates a board", async () => {
    const x = setup();
    fetchMock.mockResolvedValue(response(snapshot(x.id, {
      nativePairAction: { requestId: "old-pair", effects: ["old"] }, nativeMinesAction: { requestId: "old-mines", effects: ["old"] },
    })));
    expect(x.read()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeMinesAction");
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativePairAction");
    expect(readPendingActivity(x.id)).toBeNull();
  });

  it.each([0, 69])("accepts the original zero-based cell %i and binds fresh effects to the stored UUID", async index => {
    const x = setup();
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeMines: board(),
      nativeMinesAction: { requestId: sent().requestId, effects: [{ type: "walked", index }] },
      nativePairAction: { requestId: "unrelated", effects: ["wrong"] } })));
    const ack = x.request({ type: "walk", index });
    expect(ack.accepted).toBe(true);
    expect(readPendingActivity(x.id)?.activityId).toBe("mines-native");
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "walk", index });
    expect(x.accept.mock.calls[0][0].snapshot?.nativeMinesAction?.requestId).toBe(ack.requestId);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativePairAction");
    expect(readPendingActivity(x.id)).toBeNull();
  });

  it("rejects paid choice coercion, missing mark state, out-of-range cells, extra fields and protocol inheritance", () => {
    const x = setup();
    for (const action of [
      { type: "walk", index: -1 }, { type: "walk", index: 70 }, { type: "mark", index: 0 },
      { type: "mark", index: 1, marked: 1 }, { type: "claim", tier: "1" }, { type: "claim", tier: 4 },
      { type: "reset", choice: { toString: () => "points" } }, { type: "start", count: 1 },
      { type: "constructor" }, Object.create({ type: "start" }),
    ]) expect(x.request(action)).toEqual({ accepted: false });
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });

  it("does not forward a closed-cell mine leak or overwrite its uncertain action", async () => {
    const x = setup(), unsafe = board();
    Object.assign(unsafe.cells[20], { mine: true });
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeMines: unsafe,
      nativeMinesAction: { requestId: sent().requestId, effects: [] } })));
    const ack = x.request({ type: "start" });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled();
    expect(x.reject.mock.calls[0][0]).toMatchObject({ definitive: false, requestId: ack.requestId });
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    expect(x.request({ type: "start" }, 2)).toEqual({ accepted: false });
  });

  it("keeps a failed native acknowledgement for web receipt recovery using the exact UUID", async () => {
    const x = setup(); x.accept.mockReturnValue(false);
    fetchMock.mockImplementation(async () => response(snapshot(x.id, {
      nativeMinesAction: { requestId: sent().requestId, effects: [{ type: "started" }] },
    })));
    const ack = x.request({ type: "start" });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const pending = readPendingActivity(x.id)!;
    expect(pending.requestId).toBe(ack.requestId);
    expect(retryNativeActivityRequest(pending)).toBeNull();
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true })));
    await expect(performActivity(pending)).resolves.toMatchObject({ replayed: true });
    expect(sent().requestId).toBe(ack.requestId); expect(x.accept).toHaveBeenCalledOnce();
    clearPendingActivity(pending);
    expect(readPendingActivity(x.id)).toBeNull();
  });

  it("keeps pair and mines hosts independent while serializing their character's pending ledger", async () => {
    const x = setup(), target: NativePairCallbackTarget = {};
    const pair = attachNativePairHost({ characterId: x.id, generation: "pair-generation", target, isCurrent: () => true,
      player: { workshopPairAcceptSnapshot: vi.fn(), workshopPairRejectRequest: vi.fn() } });
    hosts.push(pair);
    fetchMock.mockRejectedValue(new Error("lost"));
    const ack = x.request({ type: "start" });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(target.workshopPairRequest!(x.id, "pair-generation", 1, { type: "start" })).toEqual({ accepted: false });
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    pair.cancel();
    expect(x.target.workshopMinesRequest).toBeTypeOf("function");
    expect(x.request({ type: "revive" }, 2)).toEqual({ accepted: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
