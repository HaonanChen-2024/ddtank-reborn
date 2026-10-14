import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativePurrHost, retryNativePurrRequest, type NativePurrCallbackTarget, type NativePurrEnvelope } from "./native-purr-host";
import { attachNativeTreasureHost, type NativeTreasureCallbackTarget } from "./native-treasure-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const roundToken = "2026-10-15:" + "P".repeat(43), response = (v: unknown) => new Response(JSON.stringify(v));
const materials = [11019, 11001, 11021, 11002];
let nextId = 7000;
const exchange = (fragments: number) => materials.map((templateId, index) => ({ index, templateId, chipCost: 20,
  itemCount: 1, maxCount: 10, affordableCount: Math.min(10, Math.floor(fragments / 20)), canExchange: fragments >= 20 }));
const projection = () => ({
  version: 1, kind: "wheel-native", started: false, day: "2026-10-15", round: 0, spinCount: 0,
  phase: "idle", level: 0, category: 0, score: 1000, fragments: 0, roundToken,
  startCost: 20, normalCost: 10, protectCost: 20, maxLevel: 7,
  categories: [...materials.map((templateId, index) => ({ sourceOriginalIndex: index + 1, name: "材料" + index, templateIds: [templateId] })),
    { sourceOriginalIndex: 5, name: "随机材料", templateIds: materials }],
  roundMaterial: null, pending: null, canStart: true, canContinue: false, canProtect: false, canTakeChip: false, canTakeItem: false,
  exchange: exchange(0), localRules: { version: 1, description: "本地七级转盘与旧五级分别存档" },
});
const active = (level = 2, category = 5, fragments = 0) => ({ ...projection(), started: true, round: 1, spinCount: level === 0 ? 2 : level,
  phase: level === 0 ? "failed" : "active", level, category, fragments, canStart: false,
  roundMaterial: { templateId: category === 5 ? 11002 : materials[category - 1], name: "本轮固定材料" },
  pending: { chipAmount: 20 * Math.max(level, 1), item: level <= 1 ? null : { templateId: category === 5 ? 11002 : materials[category - 1], itemCount: level } },
  canContinue: level > 0 && level < 7, canProtect: level > 0 && level < 7,
  canTakeChip: fragments + 20 * Math.max(level, 1) <= 1_000_000_000, canTakeItem: level > 1, exchange: exchange(fragments),
});
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse => ({ characterId: id, revision: 1,
  points: 1000, earned: 1000, day: "2026-10-15", activities: [], tasks: [], history: [], nativeWheel: projection(), ...extra });
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
function setup(isCurrent: () => boolean = () => true) {
  const id = ++nextId, generation = "purr-" + id, target: NativePurrCallbackTarget = {};
  const accept = vi.fn((e: NativePurrEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence,
    pending: false, revision: e.snapshot!.revision })), reject = vi.fn();
  const host = attachNativePurrHost({ characterId: id, generation, target, isCurrent,
    player: { workshopPurrAcceptSnapshot: accept, workshopPurrRejectRequest: reject } }); hosts.push(host);
  return { id, generation, target, accept, reject, host,
    request: (action: unknown, sequence = 1) => target.workshopPurrRequest!(id, generation, sequence, action) };
}
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });

describe("original Purr host", () => {
  it("only reads on open and strips all seven action envelopes", async () => {
    const x = setup(), stale = { requestId: "old", effects: ["old"] };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativePairAction: stale, nativeMinesAction: stale,
      nativeDDPlayAction: stale, nativeGypsyAction: stale, nativeMoonlightAction: stale, nativeTreasureAction: stale, nativeWheelAction: stale })));
    expect(x.target.workshopPurrRead!(x.id, x.generation, 1)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction", "nativeTreasureAction", "nativeWheelAction"])
      expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each(["start", "continue", "protect", "take-chip", "take-item"])("sends one explicit %s with one UUID", async type => {
    const x = setup(), other = { requestId: "other", effects: ["other"] };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeWheel: active(),
      nativeWheelAction: { requestId: sent().requestId, effects: [{ type: "rotated" }] }, nativeTreasureAction: other })));
    const ack = x.request({ type, choice: roundToken });
    expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][0]).toBe("/api/account/activities/wheel-native/action");
    expect(sent().action).toEqual({ type, choice: roundToken });
    expect(x.accept.mock.calls[0][0].snapshot?.nativeWheelAction?.requestId).toBe(ack.requestId);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeTreasureAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each([1, 10])("copies a bounded exchange of %s without a price or template", async count => {
    const x = setup(), action = { type: "exchange", choice: roundToken, index: 3, count };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeWheel: active(2, 5, 20),
      nativeWheelAction: { requestId: sent().requestId, effects: [{ type: "exchanged" }] } })));
    expect(x.request(action).accepted).toBe(true); action.index = 0; action.count = 99;
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "exchange", choice: roundToken, index: 3, count }); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("rejects paid, old-wheel, unquoted and client-selected rewards before POST", () => {
    const x = setup();
    for (const action of [{ type: "start" }, { type: "start", choice: roundToken, cost: 20 },
      { type: "start", choice: roundToken, category: 5 }, { type: "protect", choice: roundToken, count: 1 },
      { type: "take", choice: roundToken }, { type: "take-chip", choice: roundToken, count: 140 },
      { type: "take-item", choice: roundToken, templateId: 11019 }, { type: "exchange", choice: roundToken, index: 4, count: 1 },
      { type: "exchange", choice: roundToken, index: 0, count: 0 }, { type: "exchange", choice: roundToken, index: 0, count: 11 },
      { type: "exchange", choice: roundToken, index: 0, count: "1" }, { type: "exchange", choice: roundToken, index: 0 },
      { type: "exchange", choice: roundToken, count: 1 }, { type: "exchange", choice: roundToken, index: 0, count: 1, mode: "paid" },
      { type: "buy", choice: roundToken }, { type: "start", choice: "2026-10-15:" + "P".repeat(64) },
      Object.create({ type: "start", choice: roundToken })]) expect(x.request(action).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each([0, 1, 7])("accepts actual level %s, including zero with 20 chip entitlement and level seven", async level => {
    const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeWheel: active(level) })));
    x.target.workshopPurrRead!(x.id, x.generation, 1);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
    const p = x.accept.mock.calls[0][0].snapshot?.nativeWheel as ReturnType<typeof active>;
    expect(p.level).toBe(level); expect(p.pending.chipAmount).toBe(20 * Math.max(level, 1));
  });
  it("accepts settled state at spin limits and chip overflow while keeping valid exchange/claim exits", async () => {
    for (const fragments of [1_000_000_000 - 39, 1_000_000_000 - 40]) {
      const x = setup(), p = { ...active(2, 5, fragments), spinCount: 1_000_000_000, canContinue: false, canProtect: false };
      fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeWheel: p })));
      x.target.workshopPurrRead!(x.id, x.generation, 1);
      await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled(); x.host.cancel();
    }
    const x = setup(), p = { ...active(7, 5, 140), phase: "settled", pending: null, spinCount: 1_000_000_000, canTakeChip: false, canTakeItem: false };
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeWheel: p })));
    x.target.workshopPurrRead!(x.id, x.generation, 1); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
  });
  it("rejects old five-level schema, changed chips/templates and inconsistent public entitlements", async () => {
    const mutations = [() => ({ ...projection(), maxLevel: 5 }), () => ({ ...projection(), roundToken: "2026-10-16:" + "P".repeat(43) }),
      () => ({ ...active(0), pending: { chipAmount: 0, item: null } }), () => ({ ...active(), category: 1 }),
      () => ({ ...active(7), canContinue: true }), () => ({ ...active(1), pending: { chipAmount: 20, item: { templateId: 11002, itemCount: 1 } } }),
      () => ({ ...active(), pending: { chipAmount: 40, item: { templateId: 11019, itemCount: 2 } } }),
      () => ({ ...projection(), categories: projection().categories.slice(0, 4) }),
      () => ({ ...active(), exchange: exchange(0).map(row => ({ ...row, chipCost: 1 })) }),
      () => ({ ...active(), spinCount: 0 }), () => ({ ...active(), started: false }),
      () => ({ ...projection(), rng: 1 }), () => ({ ...active(), materialIndex: 3 }),
      () => ({ ...projection(), round: 1 }), () => ({ ...active(0), phase: "active" }),
      () => ({ ...active(7), phase: "failed" }), () => ({ ...active(7), spinCount: 6 }),
      () => ({ ...active(2), phase: "failed", canContinue: false, canProtect: false, spinCount: 3 })];
    for (const mutate of mutations) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeWheel: mutate() })));
      x.target.workshopPurrRead!(x.id, x.generation, 1);
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("keeps a lost protected-spin UUID and retries without fresh animation or a second operation", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    const ack = x.request({ type: "protect", choice: roundToken }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const pending = readPendingActivity(x.id)!, first = sent(); expect(pending.requestId).toBe(ack.requestId);
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeWheel: active(),
      nativeWheelAction: { requestId: ack.requestId!, effects: ["old rotation"] } })));
    await retryNativePurrRequest(pending); expect(sent()).toEqual(first); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readPendingActivity(x.id)).toBeNull(); expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeWheelAction");
  });
  it("cancels without late reopening or losing an uncertain settlement UUID", async () => {
    const x = setup(); let resolve!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const ack = x.request({ type: "take-chip", choice: roundToken }); await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    x.host.cancel(); resolve(response(snapshot(x.id, { nativeWheelAction: { requestId: ack.requestId!, effects: ["late"] } })));
    await new Promise(r => setTimeout(r, 0)); expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    expect(x.target.workshopPurrRequest).toBeUndefined();
  });
  it("uses the common unresolved UUID lock and rejects old role/generation callbacks", async () => {
    let current = true; const x = setup(() => current), target: NativeTreasureCallbackTarget = {};
    fetchMock.mockRejectedValueOnce(new TypeError("lost")); x.request({ type: "take-chip", choice: roundToken });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const treasure = attachNativeTreasureHost({ characterId: x.id, generation: "treasure", target, isCurrent: () => true,
      player: { workshopTreasureAcceptSnapshot: () => true, workshopTreasureRejectRequest: () => true } }); hosts.push(treasure);
    expect(target.workshopTreasureRequest!(x.id, "treasure", 1, { type: "take", choice: roundToken }).accepted).toBe(false);
    expect(x.target.workshopPurrRead!(x.id + 1, x.generation, 2).accepted).toBe(false);
    expect(x.target.workshopPurrRead!(x.id, "old", 2).accepted).toBe(false); current = false;
    expect(x.request({ type: "start", choice: roundToken }, 3).accepted).toBe(false); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
