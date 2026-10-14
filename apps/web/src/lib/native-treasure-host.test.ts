import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeTreasureHost, retryNativeTreasureRequest, type NativeTreasureCallbackTarget, type NativeTreasureEnvelope } from "./native-treasure-host";
import { attachNativeMoonlightHost, type NativeMoonlightCallbackTarget } from "./native-moonlight-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const bagToken = "2026-10-15:" + "B".repeat(43), response = (value: unknown) => new Response(JSON.stringify(value));
const materials = [11019, 11001, 11021, 11002];
let nextId = 900;
const projection = () => ({
  version: 1, kind: "treasure-native", started: false, day: "2026-10-15", score: 1000, normalCost: 30, advancedCost: 60,
  drawChoices: ["normal", "advanced"].flatMap(mode => [1, 2, 3, 4, 5].map(count => ({ mode, count, cost: count * (mode === "normal" ? 30 : 60), canDraw: true }))),
  bagCapacity: 30, bagSlotsUsed: 0, bagToken, draws: 0, progressScore: 0, fragments: 0, pityRemaining: 10,
  categories: materials.map((templateId, index) => ({ index, sourceOriginalIndex: index + 1, templateId, name: "材料" + index, selected: true })),
  canDraw: true, canTake: false, canRecycle: false, bag: [] as { index: number; templateId: number; itemCount: number; recycleUnitPoints: number }[],
  previewTemplateIds: materials, records: [] as string[],
  exchange: { fragmentCost: 10, templateId: 11021, itemCount: 2, canExchange: false },
  progress: [1, 2, 3].map(tier => ({ tier, target: tier * 10, templateId: 11019, itemCount: tier * 2, claimed: false, canClaim: false })),
  localRules: { version: 1, description: "本地普通30、高级60积分，连续为5次有限批次" },
});
const stocked = () => ({ ...projection(), started: true, draws: 3, progressScore: 3, fragments: 3, pityRemaining: 7,
  bagSlotsUsed: 3, canTake: true, canRecycle: true,
  bag: [{ index: 0, templateId: 11019, itemCount: 1, recycleUnitPoints: 2 },
    { index: 1, templateId: 11019, itemCount: 2, recycleUnitPoints: 2 },
    { index: 2, templateId: 11021, itemCount: 4, recycleUnitPoints: 2 }] });
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse => ({
  characterId: id, revision: 1, points: 1000, earned: 1000, day: "2026-10-15", activities: [], tasks: [], history: [],
  nativeTreasure: projection(), ...extra,
});
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
function setup(isCurrent: () => boolean = () => true) {
  const id = ++nextId, generation = "treasure-" + id, target: NativeTreasureCallbackTarget = {};
  const accept = vi.fn((e: NativeTreasureEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence,
    pending: false, revision: e.snapshot!.revision })), reject = vi.fn();
  const host = attachNativeTreasureHost({ characterId: id, generation, target, isCurrent,
    player: { workshopTreasureAcceptSnapshot: accept, workshopTreasureRejectRequest: reject } }); hosts.push(host);
  return { id, generation, target, accept, reject, host,
    request: (action: unknown, sequence = 1) => target.workshopTreasureRequest!(id, generation, sequence, action) };
}
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });

describe("original Treasure host", () => {
  it("only reads on open and removes all six animation envelopes", async () => {
    const x = setup(), stale = { requestId: "old", effects: ["old"] };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativePairAction: stale, nativeMinesAction: stale,
      nativeDDPlayAction: stale, nativeGypsyAction: stale, nativeMoonlightAction: stale, nativeTreasureAction: stale })));
    expect(x.target.workshopTreasureRead!(x.id, x.generation, 1)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction", "nativeTreasureAction"])
      expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each(["normal", "advanced"].flatMap(mode => [1, 2, 3, 4, 5].map(count => ({ mode, count }))))
    ("sends one quoted $mode batch of $count with its UUID and only fresh effects", async ({ mode, count }) => {
      const x = setup(), other = { requestId: "other", effects: ["other"] };
      fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeTreasure: stocked(),
        nativeTreasureAction: { requestId: sent().requestId, effects: [{ type: "drawn", count, mode }] }, nativeMoonlightAction: other })));
      const ack = x.request({ type: "draw", mode, count, choice: bagToken });
      expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
      expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
      await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
      expect(fetchMock).toHaveBeenCalledOnce(); expect(sent().action).toEqual({ type: "draw", mode, count, choice: bagToken });
      expect(x.accept.mock.calls[0][0].snapshot?.nativeTreasureAction?.requestId).toBe(ack.requestId);
      expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeMoonlightAction"); expect(readPendingActivity(x.id)).toBeNull();
    });
  it.each([undefined, 0, 29])("keeps whole-bag or whole-slot take index %s in a single action", async index => {
    const x = setup(), action = { type: "take", choice: bagToken, ...(index === undefined ? {} : { index }) };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeTreasureAction: { requestId: sent().requestId, effects: [{ type: "taken" }] } })));
    expect(x.request(action).accepted).toBe(true);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual(action); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("copies a category toggle without a template, amount or paid mode", async () => {
    const x = setup(), action = { type: "choose", choice: bagToken, index: 2, marked: false };
    fetchMock.mockImplementation(async () => {
      const p = projection(); p.categories[2].selected = false;
      p.drawChoices = p.drawChoices.map(option => ({ ...option, canDraw: option.mode === "normal" }));
      return response(snapshot(x.id, { nativeTreasure: { ...p, started: true, bagToken: "2026-10-15:" + "C".repeat(43) },
        nativeTreasureAction: { requestId: sent().requestId, effects: [{ type: "chosen", index: 2, selected: false }] } }));
    });
    expect(x.request(action).accepted).toBe(true); action.index = 0; action.marked = true;
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "choose", choice: bagToken, index: 2, marked: false });
  });
  it("rejects unquoted, coerced, partial-slot, paid and unbounded commands before POST", () => {
    const x = setup();
    for (const action of [{ type: "draw", choice: bagToken, count: 1 }, { type: "draw", choice: bagToken, mode: "paid", count: 1 },
      { type: "draw", choice: bagToken, mode: "normal", count: 6 }, { type: "draw", choice: bagToken, mode: "normal", count: "1" },
      { type: "draw", choice: bagToken, mode: "normal", count: 1, price: 30 }, { type: "draw", choice: bagToken, mode: "normal", count: 1, continuous: true },
      { type: "take", choice: bagToken, index: "0" }, { type: "take", choice: bagToken, index: 30 }, { type: "take", choice: bagToken, index: 1, count: 1 },
      { type: "take", choice: bagToken, items: [{ index: 0, count: 1 }] }, { type: "take", choice: bagToken, templateId: 11019 },
      { type: "choose", choice: bagToken, index: 4, marked: true }, { type: "choose", choice: bagToken, index: 0, marked: "true" },
      { type: "choose", choice: bagToken, index: 0 }, { type: "progress", choice: bagToken, tier: 4 },
      { type: "recycle", choice: "2026-10-15:" + "A".repeat(64) }, { type: "buy", choice: bagToken },
      Object.create({ type: "take", choice: bagToken })])
      expect(x.request(action).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each(["GET", "POST"])("accepts an actual ordinary 11021 quantity of one via %s", async method => {
    const x = setup(), score = method === "POST" ? 970 : 1000;
    const p = { ...stocked(), score, draws: 1, progressScore: 1, fragments: 1, pityRemaining: 9, bagSlotsUsed: 1,
      bag: [{ index: 0, templateId: 11021, itemCount: 1, recycleUnitPoints: 2 }] };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { points: score, nativeTreasure: p,
      ...(method === "POST" ? { nativeTreasureAction: { requestId: sent().requestId,
        effects: [{ type: "drawn", mode: "normal", count: 1, cost: 30, score, draws: 1,
          rewards: [{ index: 0, sourceOriginalIndex: 3, templateId: 11021, itemCount: 1 }] }] } } : {}) })));
    if (method === "GET") x.target.workshopTreasureRead!(x.id, x.generation, 1);
    else x.request({ type: "draw", choice: bagToken, mode: "normal", count: 1 });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)).toBeNull();
  });
  it("rejects altered capacity, row identities, categories, currency and private-state projections", async () => {
    const mutations = [
      () => ({ ...projection(), bagCapacity: 100 }),
      () => ({ ...projection(), bagToken: "2026-10-16:" + "B".repeat(43) }),
      () => ({ ...projection(), normalCost: 1 }),
      () => ({ ...projection(), seed: 123 }),
      () => ({ ...projection(), records: [123] }),
      () => ({ ...projection(), categories: projection().categories.map(row => ({ ...row, selected: false })) }),
      () => ({ ...projection(), categories: projection().categories.map(row => ({ ...row, sourceOriginalIndex: 15 })) }),
      () => ({ ...stocked(), bag: stocked().bag.map(row => ({ ...row, index: 0 })) }),
      () => ({ ...stocked(), bag: stocked().bag.map(row => ({ ...row, itemCount: row.index === 2 ? 3 : row.itemCount })) }),
      () => ({ ...stocked(), canRecycle: false }),
      () => ({ ...projection(), drawChoices: projection().drawChoices.map(row => ({ ...row, cost: 1 })) }),
      () => ({ ...projection(), categories: projection().categories.map((row, i) => ({ ...row, selected: i !== 0 })) }),
    ];
    for (const mutate of mutations) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeTreasure: mutate() })));
      x.target.workshopTreasureRead!(x.id, x.generation, 1);
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("accepts a full bag with settlement allowed and draw limits exhausted", async () => {
    const x = setup(), p = { ...stocked(), bagSlotsUsed: 30,
      bag: Array.from({ length: 30 }, (_, index) => ({ index, templateId: 11019, itemCount: 1, recycleUnitPoints: 2 })),
      canDraw: false, drawChoices: projection().drawChoices.map(row => ({ ...row, canDraw: false })) };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeTreasure: p })));
    x.target.workshopTreasureRead!(x.id, x.generation, 1);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it("accepts the exact whole-bag recycle overflow boundary while retaining take", async () => {
    for (const headroom of [13, 14]) {
      const x = setup(), score = 2_147_483_647 - headroom, p = { ...stocked(), score, canRecycle: headroom >= 14 };
      fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { points: score, nativeTreasure: p })));
      x.target.workshopTreasureRead!(x.id, x.generation, 1);
      await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("retains an unknown five-draw UUID and explicitly retries it without another batch", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    const ack = x.request({ type: "draw", choice: bagToken, mode: "advanced", count: 5 });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const pending = readPendingActivity(x.id)!; expect(pending.requestId).toBe(ack.requestId); const first = sent();
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeTreasure: stocked(),
      nativeTreasureAction: { requestId: ack.requestId!, effects: ["old animation"] } })));
    await retryNativeTreasureRequest(pending);
    expect(sent()).toEqual(first); expect(fetchMock).toHaveBeenCalledTimes(2); expect(readPendingActivity(x.id)).toBeNull();
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeTreasureAction");
  });
  it("cancels the receiver without late reopening or losing an uncertain UUID", async () => {
    const x = setup(); let resolve!: (result: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const ack = x.request({ type: "take", choice: bagToken, index: 2 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); x.host.cancel();
    resolve(response(snapshot(x.id, { nativeTreasureAction: { requestId: ack.requestId!, effects: ["late"] } })));
    await vi.waitFor(() => expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId));
    await new Promise(r => setTimeout(r, 0)); expect(x.accept).not.toHaveBeenCalled();
    expect(x.target.workshopTreasureRequest).toBeUndefined();
  });
  it("shares the unresolved UUID lock with Moonlight and rejects old role/generation callbacks", async () => {
    let current = true; const x = setup(() => current), target: NativeMoonlightCallbackTarget = {};
    fetchMock.mockRejectedValueOnce(new TypeError("lost"));
    x.request({ type: "take", choice: bagToken });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const moon = attachNativeMoonlightHost({ characterId: x.id, generation: "moon", target, isCurrent: () => true,
      player: { workshopMoonlightAcceptSnapshot: () => true, workshopMoonlightRejectRequest: () => true } }); hosts.push(moon);
    expect(target.workshopMoonlightRequest!(x.id, "moon", 1, { type: "draw", choice: bagToken, count: 1 }).accepted).toBe(false);
    expect(x.target.workshopTreasureRead!(x.id + 1, x.generation, 2).accepted).toBe(false);
    expect(x.target.workshopTreasureRead!(x.id, "old", 2).accepted).toBe(false); current = false;
    expect(x.request({ type: "take", choice: bagToken }, 3).accepted).toBe(false); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
