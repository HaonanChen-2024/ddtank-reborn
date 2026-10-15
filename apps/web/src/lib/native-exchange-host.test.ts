import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import { type NativeActivityHost } from "./native-activity-host";
import { attachNativeExchangeHost, retryNativeExchangeRequest, type NativeExchangeCallbackTarget, type NativeExchangeEnvelope } from "./native-exchange-host";
import { attachNativeDDPlayHost, type NativeDDPlayCallbackTarget } from "./native-ddplay-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const stateToken = "2026-10-15." + "A".repeat(43), templates = [11019, 11001, 11021, 11002];
const rules = [["local-strengthen-up", 11019, 4, 11021, 1], ["local-zhuque-up", 11001, 4, 11002, 1],
  ["local-strengthen-down", 11021, 2, 11019, 3], ["local-zhuque-down", 11002, 2, 11001, 3]] as const;
const material = (templateId: number, count: number) => ({ templateId, name: "本地材料", count });
const reward = (templateId: number, count: number) => ({ ...material(templateId, count), bound: true, validDays: 0 });
function projection(options: { authority?: "online" | "offline" | "unavailable"; available?: boolean; revision?: number; empty?: boolean; counts?: number[]; exchanged?: number[] } = {}) {
  const { authority = "online", available = authority === "online", revision = 1, empty = false,
    counts = [40, 40, 20, 20], exchanged = [0, 0, 0, 0] } = options;
  return { version: 1, catalogVersion: "exchange-native-v1-local-4", day: "2026-10-15", revision, authority, available,
    reason: "本地材料兑换", materialSource: "prop-bag", stateToken: available ? stateToken : null,
    category: { id: "local-materials", title: "本地材料" },
    materials: empty ? [] : templates.map((templateId, index) => ({ templateId, name: "本地材料", eligibleCount: authority === "online" ? counts[index] : null })),
    recipes: empty ? [] : rules.map(([catalogId, input, cost, output, amount], index) => {
      const maxCount = available ? Math.min(10 - exchanged[index]!, Math.floor(counts[templates.indexOf(input)]! / cost)) : 0;
      return { index, catalogId, title: "本地配方", inputs: [material(input, cost)], outputs: [reward(output, amount)], dailyLimit: 10,
        exchanged: exchanged[index], remaining: 10 - exchanged[index]!, maxCount, canExchange: maxCount > 0, reason: "本地规则" };
    }), rules: ["每条每日10份，真实背包材料兑换"], unavailable: [{ id: "reference-catalog", reason: "原服其它分类未移植" }, { id: "offline-exchange", reason: "离线不扣背包" }] };
}
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse => ({ characterId: id, revision: 1,
  points: 100, earned: 100, day: "2026-10-15", activities: [], tasks: [], history: [], nativeExchange: projection(), ...extra });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const action = (extra: Record<string, unknown> = {}) => ({ type: "exchange", index: 0, count: 2, choice: stateToken, ...extra });
const effect = (index = 0, count = 2, committedRevision = 2) => {
  const [, input, cost, output, amount] = rules[index]!;
  return { type: "exchanged", index, count, consumed: [material(input, cost * count)], rewards: [reward(output, amount * count)], committedRevision };
};
let nextId = 2200;
function setup(isCurrent = () => true) {
  const id = ++nextId, generation = "exchange-" + id, target: NativeExchangeCallbackTarget = {};
  const accept = vi.fn((e: NativeExchangeEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence, pending: false, revision: e.snapshot!.revision })), reject = vi.fn();
  const host = attachNativeExchangeHost({ characterId: id, generation, target, isCurrent,
    player: { workshopExchangeAcceptSnapshot: accept, workshopExchangeRejectRequest: reject } }); hosts.push(host);
  return { id, generation, target, accept, reject, host,
    read: (sequence = 1) => target.workshopExchangeRead!(id, generation, sequence),
    request: (value: unknown = action(), sequence = 1) => target.workshopExchangeRequest!(id, generation, sequence, value) };
}
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
const fresh = (id: number, requestId: string, index = 0, count = 2) => snapshot(id, { revision: 2, nativeExchange: projection({ revision: 2 }), nativeExchangeAction: { requestId, effects: [effect(index, count)] } });
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
describe("original material exchange host", () => {
  it("opens read-only and strips all twelve old or current effects", async () => {
    const x = setup(), stale = { requestId: "old", effects: ["old"] }, envelopes = Object.fromEntries(
      ["Pair", "Mines", "DDPlay", "Gypsy", "Moonlight", "Treasure", "Wheel", "Carnival", "FirstRecharge", "Charge", "Forthright", "Exchange"].map(name => ["native" + name + "Action", stale]));
    fetchMock.mockResolvedValue(response(snapshot(x.id, envelopes))); expect(x.read()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(fetchMock.mock.calls[0]![1]?.method).toBe("GET");
    for (const key of Object.keys(envelopes)) expect(x.accept.mock.calls[0]![0].snapshot).not.toHaveProperty(key);
    expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each(["offline", "unavailable"] as const)("accepts explicit %s without inventing material balances", async authority => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeExchange: projection({ authority, empty: authority === "unavailable" }) })));
    x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect((x.accept.mock.calls[0]![0].snapshot!.nativeExchange as Record<string, unknown>).stateToken).toBeNull();
  });
  it("accepts real counts with a locked bag while leaving exchange unavailable", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeExchange: projection({ available: false }) })));
    x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
  });
  it.each([0, 1, 2, 3])("submits recipe %i and exact quantity once, retaining only its committed effect", async index => {
    const x = setup(); fetchMock.mockImplementation(async () => response({ ...fresh(x.id, sent().requestId, index, 10), nativeForthrightAction: { requestId: "other", effects: [] } }));
    const ack = x.request(action({ index, count: 10 })); expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual(action({ index, count: 10 })); expect(fetchMock.mock.calls[0]![0]).toBe("/api/account/activities/exchange-native/action");
    expect(x.accept.mock.calls[0]![0].snapshot!.nativeExchangeAction?.requestId).toBe(ack.requestId);
    expect(x.accept.mock.calls[0]![0].snapshot).not.toHaveProperty("nativeForthrightAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("rejects malformed or inherited commands and client prices or stack identifiers before HTTP", () => {
    const x = setup();
    for (const value of [action({ count: 0 }), action({ count: 11 }), action({ count: 1.5 }), action({ count: "2" }), action({ index: -1 }), action({ index: 4 }),
      action({ type: "claim" }), action({ choice: stateToken.slice(0, -1) }), action({ choice: "2026-10-15" }), action({ templateId: 11019 }),
      action({ price: 0 }), action({ items: [] }), action({ place: 1 }), action({ mode: "normal" }), { type: "exchange", index: 0, count: 1 },
      Object.assign(Object.create({ choice: stateToken }), { type: "exchange", index: 0, count: 1 })]) expect(x.request(value)).toEqual({ accepted: false });
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("rejects inconsistent public balances, limits, rewards, authority, versions and private data", async () => {
    const mutations: ((p: ReturnType<typeof projection>) => unknown)[] = [
      p => ({ ...p, revision: 2 }), p => ({ ...p, day: "2026-02-30" }), p => ({ ...p, stateToken: "2026-10-16." + "A".repeat(43) }),
      p => ({ ...p, authority: "offline" }), p => ({ ...p, available: false }), p => ({ ...p, catalogVersion: "unverified" }), p => ({ ...p, materials: [] }),
      p => ({ ...p, state: {} }), p => ({ ...p, materials: p.materials.map((m, i) => i ? m : { ...m, eligibleCount: -1 }) }),
      p => ({ ...p, materials: p.materials.map((m, i) => i ? m : { ...m, ItemID: 9 }) }),
      p => ({ ...p, recipes: p.recipes.map((r, i) => i ? r : { ...r, maxCount: 11 }) }),
      p => ({ ...p, recipes: p.recipes.map((r, i) => i ? r : { ...r, remaining: 9 }) }),
      p => ({ ...p, recipes: p.recipes.map((r, i) => i ? r : { ...r, outputs: [reward(7001, 1)] }) }),
      p => ({ ...p, unavailable: [{ id: "reference-catalog", reason: "x" }, { id: "reference-catalog", reason: "x" }] }),
    ];
    for (const mutate of mutations) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeExchange: mutate(projection()) })));
      x.read(); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
    }
  });
  it.each(["missing", "mismatched-uuid", "wrong-cost", "wrong-reward", "future-revision", "duplicate-effect"])("keeps the UUID when fresh %s effect is invalid", async flaw => {
    const x = setup(); fetchMock.mockImplementation(async () => {
      const value = fresh(x.id, sent().requestId), e = effect();
      if (flaw === "missing") delete value.nativeExchangeAction;
      else if (flaw === "mismatched-uuid") value.nativeExchangeAction!.requestId = crypto.randomUUID();
      else if (flaw === "wrong-cost") value.nativeExchangeAction!.effects = [{ ...e, consumed: [material(11019, 1)] }];
      else if (flaw === "wrong-reward") value.nativeExchangeAction!.effects = [{ ...e, rewards: [{ ...reward(11021, 2), bound: false }] }];
      else if (flaw === "future-revision") value.nativeExchangeAction!.effects = [{ ...e, committedRevision: 3 }];
      else value.nativeExchangeAction!.effects.push(e);
      return response(value);
    });
    const ack = x.request(); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("retries transport uncertainty with the same UUID and accepts effect-free replay", async () => {
    const x = setup(); fetchMock.mockResolvedValueOnce(response({ message: "结果未知" }, 503)); const ack = x.request();
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); const pending = readPendingActivity(x.id)!;
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { revision: 3, nativeExchange: projection({ revision: 3, authority: "offline" }), replayed: true,
      nativeExchangeAction: { requestId: "stale", effects: ["must strip"] } })));
    await retryNativeExchangeRequest(pending); expect(sent().requestId).toBe(ack.requestId); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(x.accept.mock.calls[0]![0].snapshot).not.toHaveProperty("nativeExchangeAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("clears a definite stale-token rejection so a new read is possible", async () => {
    const x = setup(); fetchMock.mockResolvedValueOnce(response({ message: "材料已变化" }, 409)); x.request();
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(readPendingActivity(x.id)).toBeNull();
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id))); expect(x.read(2)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
  });
  it("shares the unresolved character lock with other native activities", async () => {
    const x = setup(), target: NativeDDPlayCallbackTarget = {};
    hosts.push(attachNativeDDPlayHost({ characterId: x.id, generation: "ddplay", target, isCurrent: () => true,
      player: { workshopDDPlayAcceptSnapshot: vi.fn(), workshopDDPlayRejectRequest: vi.fn() } }));
    fetchMock.mockRejectedValue(new Error("lost")); x.request(); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(target.workshopDDPlayRequest!(x.id, "ddplay", 1, { type: "spin" })).toEqual({ accepted: false }); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("preserves a closing window's pending request and never delivers its late response", async () => {
    const x = setup(); let finish!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const ack = x.request(); await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); x.host.cancel(); finish(response(fresh(x.id, ack.requestId!)));
    await new Promise(resolve => setTimeout(resolve, 0)); expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    expect(x.target.workshopExchangeRequest).toBeUndefined();
  });
  it("rejects a different role, generation, repeated sequence or departed player", () => {
    let current = true; const x = setup(() => current);
    expect(x.target.workshopExchangeRead!(x.id + 1, x.generation, 1)).toEqual({ accepted: false });
    expect(x.target.workshopExchangeRequest!(x.id, "other", 1, action())).toEqual({ accepted: false });
    expect(x.read(0)).toEqual({ accepted: false });
    current = false; expect(x.read()).toEqual({ accepted: false }); expect(fetchMock).not.toHaveBeenCalled();
  });
});
