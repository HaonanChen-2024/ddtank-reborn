import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeCaveLootHost, type NativeCaveLootCallbackTarget, type NativeCaveLootEnvelope } from "./native-caveloot-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const choice = "2026-10-15." + "A".repeat(43), materials = [11019, 11001, 11021, 11002];
const reward = (templateId = 11019, itemCount = 1) => ({ templateId, itemCount, name: "本地材料", bound: true, validDays: 0 });
const progressRewards = [[11019, 2], [11019, 4], [11019, 6], [11019, 8], [11019, 10], [11019, 12], [11001, 2], [11001, 4], [11021, 2], [11021, 4], [11002, 2]];
function projection() {
  return { version: 1, kind: "caveloot-native", available: true, day: "2026-10-15", started: false, stateToken: choice,
    catalogVersion: "caveloot-local-v1", points: 500, actionsRemaining: 500, freeRemaining: 3, bagCapacity: 30,
    bagSlotsUsed: 0, draws: 0, progressScore: 0, fragments: 0, pityRemaining: 10,
    types: [1, 2].map(tier => ({ tier, label: "本地洞窟", newDraws: 0, coins: 100,
      rows: materials.map((templateId, index) => ({ index, templateId, name: "本地材料", itemCount: 0,
        recycleUnitCoins: 2, maxTakeCount: 0, maxRecycleCount: 0, canTake: false, canRecycle: false, reason: "暂无物品" })),
      canTakeAll: false, canRecycleAll: false, reason: "暂无物品" })),
    legacyBag: { label: "历史混合包", records: 0, itemCount: 0, rewards: [], canTake: false, canRecycle: false, recyclePoints: 0, reason: "暂无历史物品" },
    pool: [1, 2].flatMap(tier => materials.map((templateId, index) => ({ tier, index, templateId, name: "本地材料", itemCount: tier, weight: [55, 25, 15, 5][index] }))),
    drawChoices: [1, 2].flatMap(tier => [1, 3, 5].map((bundleSize, index) => ({ tier, index, bundleSize,
      maxCount: Math.floor(5 / bundleSize), quotes: Array.from({ length: Math.floor(5 / bundleSize) }, (_, i) => {
        const count = i + 1, draws = count * bundleSize, freeDraws = tier === 1 ? Math.min(3, draws) : 0;
        return { count, draws, freeDraws, cost: (draws - freeDraws) * (tier === 1 ? 15 : 35), canDraw: true, reason: "可以寻宝" };
      }) }))),
    floorPreview: [1, 2].map(tier => ({ tier, target: 10, current: 0, shared: true, reward: reward(11021, tier * 2), rule: "两档共享十抽保底" })),
    progress: progressRewards.map(([templateId, itemCount], i) => ({ id: i + 1, page: i < 6 ? 1 : 2,
      target: [10, 20, 30, 50, 100, 200, 10, 25, 50, 100, 200][i], current: 0,
      progressPercentRequired: [0, 0, 0, 0, 0, 0, 5, 12, 25, 50, 100][i], claimed: false, canClaim: false,
      rewards: [reward(templateId, itemCount)], reason: "尚未达到" })),
    personalProgressPercent: 0,
    shop: [1, 2].flatMap(tier => materials.map((templateId, index) => ({ tier, index, unitCoins: [10, 12, 15, 20][index],
      bought: 0, dailyLimit: 5, remaining: 5, maxCount: 5, canBuy: true, reward: reward(templateId), reason: "本地矿币商店" }))),
    exchange: { fragmentCost: 10, reward: reward(11021, 2), canExchange: false, reason: "碎片不足" },
    rank: { available: false, rows: [], myRank: null, myScore: 0, reason: "全服排行未接入" }, records: [],
    localRules: { version: 1, description: "本地普通材料规则，不接真实付款。" },
    unavailable: ["original-payments", "original-pool", "global-progress", "global-rank"].map(id => ({ id, reason: "原后台未接入" })),
  };
}
const snapshot = (id: number, p: unknown = projection(), extra: Partial<ActivityResponse> = {}): ActivityResponse => ({
  characterId: id, points: 500, earned: 500, revision: 1, day: "2026-10-15", activities: [], tasks: [], history: [], nativeCaveLoot: p, ...extra,
});
let idCounter = 2700;
function setup() {
  const id = ++idCounter, generation = "caveloot-" + id, target: NativeCaveLootCallbackTarget = {};
  let current = true;
  const accept = vi.fn((e: NativeCaveLootEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence, pending: false, revision: e.snapshot!.revision }));
  const reject = vi.fn();
  const host = attachNativeCaveLootHost({ characterId: id, generation, target, isCurrent: () => current,
    player: { workshopCaveLootAcceptSnapshot: accept, workshopCaveLootRejectRequest: reject } });
  hosts.push(host);
  return { id, generation, target, host, accept, reject, cancelRole: () => { current = false; },
    request: (action: unknown, sequence = 1) => target.workshopCaveLootRequest!(id, generation, sequence, action) };
}
const response = (v: unknown) => new Response(JSON.stringify(v));
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
const staleEffects = () => Object.fromEntries(["Pair", "Mines", "DDPlay", "Gypsy", "Moonlight", "Treasure", "Wheel", "Carnival", "FirstRecharge", "Charge", "Forthright", "Exchange", "Devil", "CaveLoot"].map(n => ["native" + n + "Action", { requestId: "old", effects: ["old"] }]));
beforeEach(() => {
  const store = new Map<string, string>(); vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ...[1, 2].flatMap(tier => [0, 1, 2].map(index => {
    const draws = [1, 3, 5][index]!, freeDraws = tier === 1 ? Math.min(3, draws) : 0;
    return [`draw tier${tier} band${index}`, { type: "draw", tier, index, count: 1 }, { type: "drawn", tier, animationBand: index, draws, freeDraws,
      cost: (draws - freeDraws) * (tier === 1 ? 15 : 35), guaranteedDraws: 0, results: [reward(11019, tier * draws)] }] as [string, Record<string, unknown>, Record<string, unknown>];
  })),
  ["five single draws in one request", { type: "draw", tier: 1, index: 0, count: 5 }, { type: "drawn", tier: 1, animationBand: 0, draws: 5, freeDraws: 3, cost: 30, guaranteedDraws: 0, results: [reward(11019, 5)] }],
  ["take typed partial", { type: "take-item", tier: 1, index: 0, count: 2 }, { type: "taken", source: 1, itemCount: 2, rewards: [reward(11019, 2)] }],
  ["recycle typed partial", { type: "recycle-item", tier: 2, index: 1, count: 2 }, { type: "recycled", source: 2, itemCount: 2, coinsAwarded: 4, pointsAwarded: 0, consumed: [reward(11001, 2)] }],
  ["take tier", { type: "take-all", tier: 2 }, { type: "taken", source: 2, itemCount: 2, rewards: [reward(11001, 2)] }],
  ["recycle tier", { type: "recycle-all", tier: 1 }, { type: "recycled", source: 1, itemCount: 1, coinsAwarded: 2, pointsAwarded: 0, consumed: [reward()] }],
  ["take historical mixed", { type: "take-legacy" }, { type: "taken", source: "legacy", itemCount: 1, rewards: [reward()] }],
  ["recycle historical mixed", { type: "recycle-legacy" }, { type: "recycled", source: "legacy", itemCount: 2, coinsAwarded: 0, pointsAwarded: 4, consumed: [reward(11001, 2)] }],
  ["shared old progress claim", { type: "progress", tier: 1 }, { type: "progress-claimed", id: 1, rewards: [reward(11019, 2)] }],
  ["new personal progress claim", { type: "progress", tier: 11 }, { type: "progress-claimed", id: 11, rewards: [reward(11002, 2)] }],
  ["exchange", { type: "exchange" }, { type: "exchanged", fragmentsSpent: 10, rewards: [reward(11021, 2)] }],
  ["five shop units", { type: "buy", tier: 2, index: 3, count: 5 }, { type: "bought", tier: 2, index: 3, count: 5, coinsSpent: 100, rewards: [reward(11002, 5)] }],
];
describe("original CaveLoot host", () => {
  it("opens with GET only and strips all fourteen stale effect envelopes", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, projection(), staleEffects())));
    expect(x.target.workshopCaveLootRead!(x.id, x.generation, 1).accepted).toBe(true);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    for (const key of Object.keys(staleEffects())) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each(cases)("owns one exact UUID and finite committed effect: %s", async (_name, input, effect) => {
    const x = setup(); fetchMock.mockImplementation(async () => response(snapshot(x.id, projection(), { ...staleEffects(), nativeCaveLootAction: { requestId: sent().requestId, effects: [effect] } })));
    const action = { ...input, choice }, ack = x.request(action);
    expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual(action); expect(readPendingActivity(x.id)).toBeNull();
    const delivered = x.accept.mock.calls[0][0].snapshot!; expect(delivered.nativeCaveLootAction?.effects).toEqual([effect]);
    for (const key of Object.keys(staleEffects()).filter(k => k !== "nativeCaveLootAction")) expect(delivered).not.toHaveProperty(key);
  });
  it("rejects inherited, coerced, extra or over-five draw actions without a ledger write", () => {
    const x = setup();
    for (const a of [{ type: "draw", tier: 1, index: 1, count: 2 }, { type: "draw", tier: 2, index: 2, count: 6 },
      { type: "draw", tier: "1", index: 0, count: 1 }, { type: "draw", tier: 0, index: 0, count: 1 },
      { type: "draw", tier: 1, index: 0, count: 1, seed: 9 }, { type: "take-item", tier: 1, index: 4, count: 1 },
      { type: "take-item", tier: 1, index: 0, count: 1001 },
      { type: "progress", tier: 12 }, { type: "buy", tier: 2, index: 0, count: 6 }, { type: "exchange", tier: 1 },
      { type: "constructor" }]) expect(x.request({ ...a, choice }).accepted).toBe(false);
    expect(x.request(Object.create({ type: "exchange", choice })).accepted).toBe(false);
    expect(x.request({ type: "exchange", choice: choice.replace("10-15", "02-30") }).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("retains the UUID on network loss and replays without any fresh effect", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new Error("connection lost"));
    const ack = x.request({ type: "exchange", choice }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, projection(), { ...staleEffects(), replayed: true })));
    await x.host.retry(readPendingActivity(x.id)!); expect(sent().requestId).toBe(ack.requestId); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of Object.keys(staleEffects())) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it("isolates unknown-version unavailability while leaving other activities readable", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, { version: 1, kind: "caveloot-native", available: false,
      day: "2026-10-15", started: false, stateToken: null, reason: "未知版本保留", localRules: { version: 1, description: "本地规则" } })));
    x.target.workshopCaveLootRead!(x.id, x.generation, 1); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it("accepts legal INT32 mine coins and shop settlement at the 500-batch cap", async () => {
    const x = setup(), p = projection(); p.actionsRemaining = 0; p.types[0]!.coins = 2_147_483_647;
    for (const c of p.drawChoices) { c.maxCount = 0; for (const q of c.quotes) q.canDraw = false; }
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, p)));
    x.target.workshopCaveLootRead!(x.id, x.generation, 1); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    p.types[0]!.coins -= 50; Object.assign(p.shop[0]!, { bought: 5, remaining: 0, maxCount: 0, canBuy: false });
    fetchMock.mockImplementation(async () => response(snapshot(x.id, p, { nativeCaveLootAction: { requestId: sent().requestId,
      effects: [{ type: "bought", tier: 1, index: 0, count: 5, coinsSpent: 50, rewards: [reward(11019, 5)] }] } })));
    expect(x.request({ type: "buy", tier: 1, index: 0, count: 5, choice }, 2).accepted).toBe(true);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledTimes(2)); expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each(["duplicate", "units", "guarantee"])("rejects invalid aggregated draw %s without losing the UUID", async kind => {
    const x = setup(), effect = { type: "drawn", tier: 1, animationBand: 2, draws: 5, freeDraws: 3, cost: 30,
      guaranteedDraws: kind === "guarantee" ? 1 : 0,
      results: kind === "duplicate" ? [reward(11019, 2), reward(11019, 3)] : [reward(11019, kind === "units" ? 4 : 6)] };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, projection(), { nativeCaveLootAction: { requestId: sent().requestId, effects: [effect] } })));
    const ack = x.request({ type: "draw", tier: 1, index: 2, count: 1, choice }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it.each(["raw-bag", "dual-currency", "foreign-template", "fake-global-rank", "wrong-quote", "duplicate-progress", "bad-date", "string-tier"])("keeps uncertain UUID for malformed %s", async kind => {
    const x = setup(), p = projection(), effect = { type: "recycled", source: 1, itemCount: 1, coinsAwarded: 2, pointsAwarded: 0, consumed: [reward()] };
    if (kind === "raw-bag") Object.assign(p, { bag: [{ templateId: 11019, seed: 7 }] });
    if (kind === "dual-currency") effect.pointsAwarded = 2;
    if (kind === "foreign-template") p.pool[0]!.templateId = 99999;
    if (kind === "fake-global-rank") Object.assign(p.rank, { available: true, rows: [{ rank: 1 }] });
    if (kind === "wrong-quote") p.drawChoices[0]!.quotes[0]!.cost = 999;
    if (kind === "duplicate-progress") p.progress[10]!.id = 1;
    if (kind === "bad-date") p.stateToken = choice.replace("10-15", "02-30");
    if (kind === "string-tier") Object.assign(p.types[0]!, { tier: "1" });
    fetchMock.mockImplementation(async () => response(snapshot(x.id, p, { nativeCaveLootAction: { requestId: sent().requestId, effects: [effect] } })));
    const ack = x.request({ type: "recycle-all", tier: 1, choice }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("rejects stale roles and generations and never POSTs on close or report", () => {
    const x = setup(); expect(x.target.workshopCaveLootRead!(x.id + 1, x.generation, 1).accepted).toBe(false);
    expect(x.target.workshopCaveLootRead!(x.id, "old", 1).accepted).toBe(false);
    x.target.workshopCaveLootReport!({ characterId: x.id, generation: x.generation, sequence: 0 });
    x.cancelRole(); expect(x.request({ type: "exchange", choice }).accepted).toBe(false); x.host.cancel();
    expect(x.target.workshopCaveLootRequest).toBeUndefined(); expect(fetchMock).not.toHaveBeenCalled();
  });
});
