import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { performActivity, readPendingActivity, savePendingActivity, type ActivityRequest, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeTreasureHost, retryNativeTreasureRequest, type NativeTreasureCallbackTarget, type NativeTreasureEnvelope } from "./native-treasure-host";
import { attachNativeMoonlightHost, type NativeMoonlightCallbackTarget } from "./native-moonlight-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const bagToken = "2026-10-15:" + "B".repeat(43), poolVersion = "a".repeat(64);
const response = (value: unknown) => new Response(JSON.stringify(value));
let nextId = 900;
type BagRow = { index: number; templateId: number; itemCount: number; origin: string; recycleUnitPoints: number | null;
  entryKey?: string; sourceOriginalIndex?: number; poolVersion?: string };
function projection(ready = true) {
  let sourceRow = 0;
  const preview = [12, 12, 12, 12, 12, 9, 10, 12, 5, 8, 12, 6, 12, 12, 12].flatMap((size, type) =>
    Array.from({ length: size }, (_, index) => {
      sourceRow++;
      const id = (type === 6 || type === 11) && index === 0 ? 11905 : 200000 + sourceRow;
      return { entryKey: `row-${sourceRow}`, sourceRow, sourceId: sourceRow, sourceOriginalIndex: type + 1,
        sourceTemplateId: id, templateId: id, count: type === 6 ? 10 : type === 7 || type === 11 ? 5 : 1,
        name: `原条目${sourceRow}`, categoryId: 11, pic: `preview-${sourceRow}`, needSex: 0,
        status: ready ? "ready" : "blocked", reasons: ready ? [] as string[] : ["missing-template"] };
    }));
  return {
    version: 2, kind: "treasure-native", started: false, day: "2026-10-15", score: 1000, normalCost: 30, advancedCost: 60,
    poolVersion, readiness: { status: ready ? "ready" : "blocked", totalRows: 158, readyRows: ready ? 158 : 0,
      blocked: ready ? [] : preview.map(row => ({ entryKey: row.entryKey, reasons: [...row.reasons] })), description: "隔离测试目录，非生产就绪证据" },
    drawChoices: ["normal", "advanced"].flatMap(mode => [1, 2, 3, 4, 5].map(count => ({ mode, count,
      cost: count * (mode === "normal" ? 30 : 60), requiredSelection: mode === "normal" ? 0 : 4, canDraw: ready }))),
    bagCapacity: 100, bagSlotsUsed: 0, bagToken, draws: 0, progressScore: 0, fragments: 0, pityRemaining: 10,
    categories: Array.from({ length: 15 }, (_, index) => ({ index, sourceOriginalIndex: index + 1, name: `原类别${index + 1}`,
      selectable: index < 14, special: index === 14, entryKeys: preview.filter(row => row.sourceOriginalIndex === index + 1).map(row => row.entryKey) })),
    canDraw: ready, canTake: false, canRecycle: false, bag: [] as BagRow[], preview, records: [] as string[],
    exchange: { fragmentCost: 10, templateId: 11021, itemCount: 2, canExchange: false },
    progress: [1, 2, 3].map(tier => ({ tier, target: tier * 10, templateId: 11019, itemCount: tier * 2, claimed: false, canClaim: false })),
    localRules: { version: 2, description: "本地普通30、高级60积分，原行等权，不使用旧四材料保底" },
  };
}
const legacy = (index: number, templateId = 11019, itemCount = 1): BagRow => ({ index, templateId, itemCount, origin: "legacy-four-material", recycleUnitPoints: 2 });
const stocked = () => ({ ...projection(), started: true, draws: 3, progressScore: 3, fragments: 3, pityRemaining: 7,
  bagSlotsUsed: 3, canTake: true, canRecycle: true, bag: [legacy(0), legacy(1, 11019, 2), legacy(2, 11021, 4)] });
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse => ({
  characterId: id, revision: 1, points: 1000, earned: 1000, day: "2026-10-15", activities: [], tasks: [], history: [], nativeTreasure: projection(), ...extra,
});
const drawAction = (mode = "normal", count = 1, selection = mode === "advanced" ? [14, 2, 9, 1] : []) => ({
  type: "draw", choice: bagToken, mode, count, selection, poolVersion,
});
function drawResult(mode: string, count: number, sources = Array.from({ length: count }, () => 15)) {
  const p = projection(); p.started = true; p.score -= count * (mode === "advanced" ? 60 : 30);
  p.draws = p.fragments = count; p.progressScore = count * (mode === "advanced" ? 2 : 1);
  p.progress.forEach(row => { row.canClaim = p.progressScore >= row.target; });
  p.bag = sources.map((source, index) => {
    const row = p.preview.find(row => row.sourceOriginalIndex === source)!;
    return { index, templateId: row.templateId, itemCount: row.count, origin: "original-catalog", recycleUnitPoints: null,
      entryKey: row.entryKey, sourceOriginalIndex: row.sourceOriginalIndex, poolVersion };
  });
  p.bagSlotsUsed = count; p.canTake = true;
  const effect = { type: "drawn", mode, count, cost: 1000 - p.score, score: p.score, draws: p.draws,
    rewards: p.bag.map(({ index, templateId, itemCount, entryKey, sourceOriginalIndex }) => ({ index, templateId, itemCount, entryKey, sourceOriginalIndex })) };
  return { p, effect };
}
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
function setup(isCurrent: () => boolean = () => true) {
  const id = ++nextId, generation = "treasure-" + id, target: NativeTreasureCallbackTarget = {};
  const accept = vi.fn((e: NativeTreasureEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence,
    pending: false, revision: e.snapshot!.revision })), reject = vi.fn();
  const host = attachNativeTreasureHost({ characterId: id, generation, target, isCurrent,
    player: { workshopTreasureAcceptSnapshot: accept, workshopTreasureRejectRequest: reject } }); hosts.push(host);
  return { id, generation, target, accept, reject, host,
    read: () => target.workshopTreasureRead!(id, generation, 1),
    request: (action: unknown, sequence = 1) => target.workshopTreasureRequest!(id, generation, sequence, action) };
}
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });

describe("original Treasure v2 host", () => {
  it("reads all 15 original classes and 158 rows without consumption or stale animation envelopes", async () => {
    const x = setup(), stale = { requestId: "old", effects: ["old"] };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativePairAction: stale, nativeMinesAction: stale,
      nativeDDPlayAction: stale, nativeGypsyAction: stale, nativeMoonlightAction: stale, nativeTreasureAction: stale })));
    expect(x.read()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction", "nativeTreasureAction"])
      expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each(["normal", "advanced"].flatMap(mode => [1, 2, 3, 4, 5].map(count => ({ mode, count }))))
    ("sends one versioned $mode batch of $count, preserving its ordered selection and UUID", async ({ mode, count }) => {
      const x = setup(), { p, effect } = drawResult(mode, count), action = drawAction(mode, count), expected = structuredClone(action);
      fetchMock.mockImplementation(async () => response(snapshot(x.id, { points: p.score, nativeTreasure: p,
        nativeTreasureAction: { requestId: sent().requestId, effects: [effect] } })));
      const ack = x.request(action); expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
      action.selection.push(3); action.poolVersion = "b".repeat(64);
      expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
      await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
      expect(fetchMock).toHaveBeenCalledOnce(); expect(sent().action).toEqual(expected);
      expect(x.accept.mock.calls[0][0].snapshot?.nativeTreasureAction?.requestId).toBe(ack.requestId); expect(readPendingActivity(x.id)).toBeNull();
    });
  it.each([undefined, 0, 29, 30, 99])("keeps whole-bag or whole-slot take index %s unchanged", async index => {
    const x = setup(), action = { type: "take", choice: bagToken, ...(index === undefined ? {} : { index }) };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeTreasureAction: { requestId: sent().requestId, effects: [{ type: "taken" }] } })));
    expect(x.request(action).accepted).toBe(true); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(sent().action).toEqual(action);
  });
  it("rejects legacy draw/choose, malformed selections, versions, paid and partial-slot commands before POST", () => {
    const x = setup();
    const invalid = [
      { type: "draw", choice: bagToken, mode: "normal", count: 1 }, { ...drawAction(), mode: "paid" }, { ...drawAction(), count: 6 },
      { ...drawAction(), count: "1" }, { ...drawAction(), price: 30 }, { ...drawAction(), continuous: true },
      { ...drawAction(), selection: [1] }, ...[[], [1, 2, 3], [1, 2, 3, 4, 5], [1, 2, 2, 4], [0, 2, 3, 4], [15, 2, 3, 4], ["1", 2, 3, 4], [1, 2, 3, ,]]
        .map(selection => ({ ...drawAction("advanced"), selection })),
      { ...drawAction(), poolVersion: "A".repeat(64) }, { ...drawAction(), poolVersion: "a".repeat(63) },
      { type: "choose", choice: bagToken, index: 2, marked: true }, { type: "category", choice: "武器" },
      { type: "take", choice: bagToken, index: "0" }, { type: "take", choice: bagToken, index: 100 }, { type: "take", choice: bagToken, index: 1, count: 1 },
      { type: "take", choice: bagToken, items: [{ index: 0, count: 1 }] }, { type: "take", choice: bagToken, templateId: 11019 },
      { type: "progress", choice: bagToken, tier: 4 }, { type: "recycle", choice: "2026-10-15:" + "A".repeat(64) },
      { type: "buy", choice: bagToken }, Object.create({ type: "take", choice: bagToken }),
    ];
    for (const action of invalid) expect(x.request(action).accepted, JSON.stringify(action)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("accepts a globally blocked complete preview and old material settlement without inventing category selections", async () => {
    const x = setup(), p = { ...projection(false), started: true, bagSlotsUsed: 1, canTake: true, canRecycle: true, bag: [legacy(0, 11021)] };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeTreasure: p }))); x.read();
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it("distinguishes duplicate 11905 source rows and original counts instead of guessing class by template position", async () => {
    const x = setup(), { p, effect } = drawResult("advanced", 2, [7, 12]);
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { points: p.score, nativeTreasure: p,
      nativeTreasureAction: { requestId: sent().requestId, effects: [effect] } })));
    x.request(drawAction("advanced", 2, [7, 12, 2, 1]));
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(effect.rewards.map(row => [row.templateId, row.sourceOriginalIndex, row.itemCount])).toEqual([[11905, 7, 10], [11905, 12, 5]]);
  });
  it.each([
    ["v1", (p: ReturnType<typeof projection>) => { p.version = 1; }],
    ["capacity", (p: ReturnType<typeof projection>) => { p.bagCapacity = 30; }],
    ["incomplete preview", (p: ReturnType<typeof projection>) => { p.preview.pop(); }],
    ["reordered source row", (p: ReturnType<typeof projection>) => { p.preview.reverse(); }],
    ["duplicate key", (p: ReturnType<typeof projection>) => { p.preview[1].entryKey = p.preview[0].entryKey; }],
    ["wrong category", (p: ReturnType<typeof projection>) => { p.categories[0].sourceOriginalIndex = 15; }],
    ["selectable special", (p: ReturnType<typeof projection>) => { p.categories[14].selectable = true; }],
    ["missing class", (p: ReturnType<typeof projection>) => { p.categories.pop(); }],
    ["class membership", (p: ReturnType<typeof projection>) => { p.categories[0].entryKeys.pop(); }],
    ["legacy selected field", (p: ReturnType<typeof projection>) => { Object.assign(p.categories[0], { selected: true }); }],
    ["forged ready count", (p: ReturnType<typeof projection>) => { p.readiness.readyRows = 157; }],
    ["missing blocked row", (p: ReturnType<typeof projection>) => { Object.assign(p, projection(false)); p.readiness.blocked.pop(); }],
    ["blocked draw bypass", (p: ReturnType<typeof projection>) => { Object.assign(p, projection(false)); p.drawChoices[5].canDraw = true; }],
    ["wrong blocked reason", (p: ReturnType<typeof projection>) => { Object.assign(p, projection(false)); p.readiness.blocked[0].reasons = ["another"]; }],
    ["private state", (p: ReturnType<typeof projection>) => { Object.assign(p, { seed: 123 }); }],
    ["injected stats", (p: ReturnType<typeof projection>) => { Object.assign(p.preview[0], { Attack: 999999 }); }],
    ["bad pool version", (p: ReturnType<typeof projection>) => { p.poolVersion = "0"; }],
    ["bad token", (p: ReturnType<typeof projection>) => { p.bagToken = "2026-10-16:" + "B".repeat(43); }],
    ["bad currency", (p: ReturnType<typeof projection>) => { p.normalCost = 1; }],
    ["required selection", (p: ReturnType<typeof projection>) => { p.drawChoices[5].requiredSelection = 0; }],
  ])("rejects %s projection", async (_, mutate) => {
    const x = setup(), p = projection(); mutate(p); fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeTreasure: p }))); x.read();
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
  });
  it.each(["source", "entry", "count", "selection", "version", "bag", "missing-effect"])("rejects a fresh confirmed result with forged %s while retaining its UUID", async change => {
    const x = setup(), { p, effect } = drawResult("advanced", 1, [15]);
    if (change === "source") effect.rewards[0].sourceOriginalIndex = 1;
    if (change === "entry") effect.rewards[0].entryKey = p.preview[0].entryKey;
    if (change === "count") effect.rewards[0].itemCount++;
    if (change === "selection") { const other = drawResult("advanced", 1, [7]); Object.assign(p, other.p); Object.assign(effect, other.effect); }
    if (change === "version") p.poolVersion = "b".repeat(64);
    if (change === "bag") p.bag[0].itemCount++;
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { points: p.score, nativeTreasure: p,
      nativeTreasureAction: { requestId: sent().requestId, effects: change === "missing-effect" ? [] : [effect] } })));
    const ack = x.request(drawAction("advanced")); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("retains a full 100-slot legacy bag for settlement when all draw limits are exhausted", async () => {
    const x = setup(), p = { ...stocked(), bagSlotsUsed: 100, bag: Array.from({ length: 100 }, (_, i) => legacy(i)),
      canDraw: false, drawChoices: projection().drawChoices.map(row => ({ ...row, canDraw: false })) };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeTreasure: p }))); x.read();
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it("retains mixed and historical catalog bags for take, without applying legacy recycling", async () => {
    for (const historical of [false, true]) {
      const x = setup(), p = stocked(), item = drawResult("normal", 1).p.bag[0];
      if (historical) { item.poolVersion = "b".repeat(64); item.entryKey = "historical-row"; item.templateId = 987654; }
      p.bag.push({ ...item, index: 3 }); p.bagSlotsUsed = 4; p.canRecycle = false;
      fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeTreasure: p }))); x.read();
      await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("rejects mixed-bag recycling and malformed original bag identities", async () => {
    for (const kind of ["recycle", "entry", "count", "source", "origin"] as const) {
      const x = setup(), p = stocked(), item = { ...drawResult("normal", 1).p.bag[0], index: 3 };
      p.bag.push(item); p.bagSlotsUsed = 4; p.canRecycle = kind === "recycle";
      if (kind === "entry") item.entryKey = "not-in-catalog"; if (kind === "count") item.itemCount++;
      if (kind === "source") item.sourceOriginalIndex = 1; if (kind === "origin") item.origin = "guessed";
      fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeTreasure: p }))); x.read();
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("accepts the exact legacy recycle overflow boundary while retaining take", async () => {
    for (const headroom of [13, 14]) {
      const x = setup(), score = 2_147_483_647 - headroom, p = { ...stocked(), score, canRecycle: headroom >= 14 };
      fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { points: score, nativeTreasure: p }))); x.read();
      await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("retains an unknown versioned five-draw UUID and retries its exact body without another batch or animation", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    const ack = x.request(drawAction("advanced", 5)); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const pending = readPendingActivity(x.id)!; expect(pending.requestId).toBe(ack.requestId); const first = sent();
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeTreasure: stocked(),
      nativeTreasureAction: { requestId: ack.requestId!, effects: ["old animation"] } })));
    await retryNativeTreasureRequest(pending);
    expect(sent()).toEqual(first); expect(fetchMock).toHaveBeenCalledTimes(2); expect(readPendingActivity(x.id)).toBeNull();
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeTreasureAction");
  });
  it("retries a stored legacy draw unchanged rather than adding selection or the current poolVersion", async () => {
    const old: ActivityRequest = { characterId: ++nextId, activityId: "treasure-native", requestId: crypto.randomUUID(),
      action: { type: "draw", choice: bagToken, mode: "advanced", count: 5 } };
    savePendingActivity(old); fetchMock.mockResolvedValueOnce(response(snapshot(old.characterId, { replayed: true })));
    await performActivity(readPendingActivity(old.characterId)!);
    expect(sent()).toEqual({ characterId: old.characterId, requestId: old.requestId, action: old.action });
    expect(readPendingActivity(old.characterId)?.action).toEqual(old.action);
  });
  it("cancels the receiver without late reopening or losing an uncertain UUID", async () => {
    const x = setup(); let resolve!: (result: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const ack = x.request({ type: "take", choice: bagToken, index: 2 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); x.host.cancel();
    resolve(response(snapshot(x.id, { nativeTreasureAction: { requestId: ack.requestId!, effects: ["late"] } })));
    await vi.waitFor(() => expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId));
    await new Promise(r => setTimeout(r, 0)); expect(x.accept).not.toHaveBeenCalled(); expect(x.target.workshopTreasureRequest).toBeUndefined();
  });
  it("shares the unresolved UUID lock with Moonlight and rejects old role/generation callbacks", async () => {
    let current = true; const x = setup(() => current), target: NativeMoonlightCallbackTarget = {};
    fetchMock.mockRejectedValueOnce(new TypeError("lost")); x.request({ type: "take", choice: bagToken });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const moon = attachNativeMoonlightHost({ characterId: x.id, generation: "moon", target, isCurrent: () => true,
      player: { workshopMoonlightAcceptSnapshot: () => true, workshopMoonlightRejectRequest: () => true } }); hosts.push(moon);
    expect(target.workshopMoonlightRequest!(x.id, "moon", 1, { type: "draw", choice: bagToken, count: 1 }).accepted).toBe(false);
    expect(x.target.workshopTreasureRead!(x.id + 1, x.generation, 2).accepted).toBe(false);
    expect(x.target.workshopTreasureRead!(x.id, "old", 2).accepted).toBe(false); current = false;
    expect(x.request({ type: "take", choice: bagToken }, 3).accepted).toBe(false); expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// These fixtures use the API's full source catalog and transition owner. Readiness
// is injected only into isolated tests; it does not certify production assets.
const apiClock = () => ({ now: new Date("2026-10-15T12:00:00.000Z") });
type TreasureCatalog = Pick<ReturnType<typeof projection>, "poolVersion" | "preview" | "readiness">;
type ApiClock = ReturnType<typeof apiClock> & { treasureCatalog?: TreasureCatalog };
type ApiReward = { templateId: number; count: number; validDays?: number; origin?: string; entryKey?: string; sourceOriginalIndex?: number; poolVersion?: string };
type ApiState = { version: 2; bag: ApiReward[]; draws: number; score: number; fragments: number; pity: number; choices: string[]; claimed: number[] };
type ApiEffect = { type: "drawn"; mode: "normal" | "advanced"; count: number; cost: number; score: number; draws: number;
  rewards: { index: number; templateId: number; itemCount: number; entryKey: string; sourceOriginalIndex: number }[] }
  | { type: "taken" | "recycled" | "exchanged" | "progress-claimed" };
type ApiOwner = {
  readTreasureState: (state: unknown) => ApiState;
  viewTreasureNative: (state: unknown, ctx: ApiClock, funds: { points: number }) => ReturnType<typeof projection>;
  advanceTreasure: (state: unknown, action: import("./activities").ActivityAction, ctx: ApiClock, funds: { points: number }, rng: () => number, native?: boolean) =>
    { state: ApiState; pointsDelta: number; rewards: ApiReward[]; effects: ApiEffect[] };
};
// Execute real API modules while keeping Web tsc and API tsc as separate gates.
const nativeApiPath = new URL("../../../api/src/activities/treasure-native.ts", import.meta.url).href;
const catalogApiPath = new URL("../../../api/src/activities/treasure-catalog.ts", import.meta.url).href;
const { advanceTreasure, readTreasureState, viewTreasureNative } = await import(/* @vite-ignore */ nativeApiPath) as ApiOwner;
const { inspectTreasureCatalog } = await import(/* @vite-ignore */ catalogApiPath) as { inspectTreasureCatalog: () => TreasureCatalog };
function readyApiClock() {
  const catalog = inspectTreasureCatalog();
  const treasureCatalog: TreasureCatalog = { ...catalog,
    preview: catalog.preview.map(row => ({ ...row, status: "ready", reasons: [] })),
    readiness: { status: "ready", totalRows: 158, readyRows: 158, blocked: [], description: "隔离互通测试，非生产就绪证据" } };
  return { ...apiClock(), treasureCatalog };
}
describe("Treasure API v2 interoperability", () => {
  it("delivers the API default complete blocked catalog without a substitute pool", async () => {
    const x = setup(), p = viewTreasureNative(undefined, apiClock(), { points: 1000 });
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeTreasure: p }))); x.read();
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
    expect(p.categories).toHaveLength(15); expect(p.preview).toHaveLength(158);
    expect(new Set(p.preview.map(row => row.sourceTemplateId)).size).toBe(157);
    expect(p.readiness.status).toBe("blocked"); expect(p.readiness.blocked).toHaveLength(158);
    expect(p.drawChoices.every(row => !row.canDraw)).toBe(true);
  });
  it("keeps every draw blocked when just one actual source row becomes ready", async () => {
    const x = setup(), treasureCatalog = inspectTreasureCatalog();
    treasureCatalog.preview[0] = { ...treasureCatalog.preview[0], status: "ready", reasons: [] };
    treasureCatalog.readiness.readyRows = 1; treasureCatalog.readiness.blocked.shift();
    const p = viewTreasureNative(undefined, { ...apiClock(), treasureCatalog }, { points: 1000 });
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeTreasure: p }))); x.read();
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(p.readiness.status).toBe("blocked"); expect(p.drawChoices.every(row => !row.canDraw)).toBe(true);
  });
  it.each(["normal", "advanced"] as const)("accepts real %s transition identities, quantities and ordered selections", async mode => {
    const x = setup(), ctx = readyApiClock(), first = viewTreasureNative(undefined, ctx, { points: 1000 });
    const selection = mode === "advanced" ? [14, 7, 12, 1] : [];
    const desired = mode === "advanced" ? [14, 7, 12, 15] : [7, 12];
    const candidates = ctx.treasureCatalog.preview.filter(row => mode === "normal" || selection.includes(row.sourceOriginalIndex) || row.sourceOriginalIndex === 15);
    const picked = desired.map(source => candidates.findIndex(row => row.sourceOriginalIndex === source && (source !== 7 && source !== 12 || row.sourceTemplateId === 11905)));
    expect(picked.every(index => index >= 0)).toBe(true);
    const action = { type: "draw", choice: first.bagToken, mode, count: picked.length, selection, poolVersion: first.poolVersion };
    fetchMock.mockImplementation(async () => {
      let next = 0;
      const result = advanceTreasure(undefined, sent().action, ctx, { points: 1000 }, () => (picked[next++] + 0.25) / candidates.length, true);
      const points = 1000 + result.pointsDelta, p = viewTreasureNative(result.state, ctx, { points });
      return response(snapshot(x.id, { points, nativeTreasure: p, nativeTreasureAction: { requestId: sent().requestId, effects: result.effects } }));
    });
    const ack = x.request(action); expect(ack.accepted).toBe(true);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
    expect(sent().action.selection).toEqual(selection); expect(readPendingActivity(x.id)).toBeNull();
    const effect = x.accept.mock.calls[0][0].snapshot!.nativeTreasureAction!.effects[0] as { rewards: { templateId: number; itemCount: number; sourceOriginalIndex: number }[] };
    expect(effect.rewards.map(row => row.sourceOriginalIndex)).toEqual(desired);
    expect(effect.rewards.filter(row => row.templateId === 11905).map(row => [row.sourceOriginalIndex, row.itemCount])).toEqual([[7, 10], [12, 5]]);
  });
  it("rejects swapping the real duplicate template's source class in a confirmed effect", async () => {
    const x = setup(), ctx = readyApiClock(), first = viewTreasureNative(undefined, ctx, { points: 1000 });
    const index = ctx.treasureCatalog.preview.findIndex(row => row.sourceOriginalIndex === 7 && row.sourceTemplateId === 11905);
    const action = { type: "draw", choice: first.bagToken, mode: "normal", count: 1, selection: [], poolVersion: first.poolVersion };
    fetchMock.mockImplementation(async () => {
      const result = advanceTreasure(undefined, sent().action, ctx, { points: 1000 }, () => (index + 0.25) / 158, true);
      const effect = result.effects[0]; if (effect.type !== "drawn") throw new Error("Expected drawn effect");
      effect.rewards[0].sourceOriginalIndex = 12;
      const points = 1000 + result.pointsDelta;
      return response(snapshot(x.id, { points, nativeTreasure: viewTreasureNative(result.state, ctx, { points }),
        nativeTreasureAction: { requestId: sent().requestId, effects: result.effects } }));
    });
    const ack = x.request(action); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("settles an actual old unversioned bag through the API while the complete catalog remains blocked", async () => {
    const x = setup(), ctx = apiClock(), old = { ...readTreasureState(undefined), version: undefined,
      bag: [{ templateId: 11021, count: 4 }], draws: 1, score: 1, fragments: 1, pity: 1 };
    const first = viewTreasureNative(old, ctx, { points: 1000 });
    expect(first.canTake).toBe(true); expect(first.canRecycle).toBe(true);
    fetchMock.mockImplementation(async () => {
      const result = advanceTreasure(old, sent().action, ctx, { points: 1000 }, () => { throw new Error("Take must not use RNG"); }, true);
      expect(result.rewards).toEqual([{ templateId: 11021, count: 4, origin: "legacy-four-material" }]);
      return response(snapshot(x.id, { nativeTreasure: viewTreasureNative(result.state, ctx, { points: 1000 }),
        nativeTreasureAction: { requestId: sent().requestId, effects: result.effects } }));
    });
    x.request({ type: "take", choice: first.bagToken }); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("takes an old slot from an actual mixed bag without losing its original catalog reward", async () => {
    const x = setup(), ready = readyApiClock(), first = viewTreasureNative(undefined, ready, { points: 1000 });
    const result = advanceTreasure(undefined, { type: "draw", choice: first.bagToken, mode: "normal", count: 1,
      selection: [], poolVersion: first.poolVersion }, ready, { points: 1000 }, () => 0, true);
    result.state.bag.unshift({ templateId: 11019, count: 2, origin: "legacy-four-material" });
    const ctx = apiClock(), mixed = viewTreasureNative(result.state, ctx, { points: 970 });
    expect(mixed.canRecycle).toBe(false); expect(mixed.bag[1].origin).toBe("original-catalog");
    fetchMock.mockImplementation(async () => {
      const taken = advanceTreasure(result.state, sent().action, ctx, { points: 970 }, () => { throw new Error("Take must not use RNG"); }, true);
      expect(taken.state.bag).toEqual([result.state.bag[1]]);
      return response(snapshot(x.id, { points: 970, nativeTreasure: viewTreasureNative(taken.state, ctx, { points: 970 }),
        nativeTreasureAction: { requestId: sent().requestId, effects: taken.effects } }));
    });
    x.request({ type: "take", choice: mixed.bagToken, index: 0 }); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("retries an unknown UUID unchanged and synchronizes an already-claimed API bag without resurrecting rewards", async () => {
    const x = setup(), ctx = readyApiClock(), first = viewTreasureNative(undefined, ctx, { points: 1000 }), rng = vi.fn(() => 0);
    const action = { type: "draw", choice: first.bagToken, mode: "normal", count: 1, selection: [], poolVersion: first.poolVersion };
    let committed: ReturnType<ApiOwner["advanceTreasure"]> | undefined;
    fetchMock.mockImplementationOnce(async () => {
      committed = advanceTreasure(undefined, sent().action, ctx, { points: 1000 }, rng, true);
      throw new TypeError("Committed response was lost");
    });
    const ack = x.request(action); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    if (!committed) throw new Error("Expected a committed draw before the lost response");
    expect(committed.state.bag[0].origin).toBe("original-catalog");
    const requestBody = sent(), pending = readPendingActivity(x.id)!;
    expect(pending.requestId).toBe(ack.requestId);
    const latest = viewTreasureNative(committed.state, apiClock(), { points: 970 });
    const taken = advanceTreasure(committed.state, { type: "take", choice: latest.bagToken }, apiClock(), { points: 970 },
      () => { throw new Error("Take cannot use RNG"); }, true);
    const afterClaim = viewTreasureNative(taken.state, apiClock(), { points: 970 });
    expect(afterClaim.bag).toEqual([]); expect(afterClaim.readiness.status).toBe("blocked");
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { points: 970, nativeTreasure: afterClaim, replayed: true,
      mailedCount: 1, message: "原有回执", nativeTreasureAction: { requestId: ack.requestId!, effects: committed.effects } })));
    await retryNativeTreasureRequest(pending);
    expect(sent()).toEqual(requestBody); expect(rng).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readPendingActivity(x.id)).toBeNull(); expect(x.accept).toHaveBeenCalledOnce();
    const accepted = x.accept.mock.calls[0][0].snapshot!;
    expect(accepted.nativeTreasure).toEqual(afterClaim); expect(accepted).not.toHaveProperty("nativeTreasureAction");
    expect(accepted.mailedCount).toBe(1); expect(accepted.message).toBe("原有回执");
  });
});
