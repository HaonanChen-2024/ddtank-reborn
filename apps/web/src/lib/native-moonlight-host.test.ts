import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import { type NativeActivityHost } from "./native-activity-host";
import { attachNativeMoonlightHost, retryNativeMoonlightRequest, type NativeMoonlightCallbackTarget, type NativeMoonlightEnvelope } from "./native-moonlight-host";
import { attachNativeGypsyHost, type NativeGypsyCallbackTarget } from "./native-gypsy-host";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const bagToken = "2026-10-15:" + "A".repeat(43), response = (value: unknown) => new Response(JSON.stringify(value));
let nextId = 700;
const projection = () => ({
  version: 1, kind: "moonlight-native", started: false, day: "2026-10-15", score: 100, drawCost: 20,
  drawChoices: [1, 3, 5].map(count => ({ count, cost: count * 20, canDraw: true })),
  bagCapacity: 30, bagSlotsUsed: 0, bagToken, draws: 0, progressScore: 0, fragments: 0, pityRemaining: 10,
  canDraw: true, canTake: false, canRecycle: false, bag: [] as unknown[], previewTemplateIds: [11019, 11001, 11021, 11002],
  exchange: { fragmentCost: 10, templateId: 11021, itemCount: 2, maxCount: 10, affordableCount: 0, canExchange: false },
  progress: [1, 2, 3].map(tier => ({ tier, target: tier * 10, templateId: 11019, itemCount: tier * 2, claimed: false, canClaim: false })),
  localRules: { version: 1, description: "本地1/3/5开盒，每单位回收2分" },
});
const stocked = () => ({ ...projection(), started: true, draws: 3, progressScore: 3, fragments: 3, pityRemaining: 7,
  bagSlotsUsed: 3, canTake: true, canRecycle: true,
  bag: [{ index: 0, templateId: 11019, itemCount: 3, recycleUnitPoints: 2 },
    { index: 1, templateId: 11001, itemCount: 1, recycleUnitPoints: 2 }] });
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse =>
  ({ characterId: id, revision: 1, points: 100, earned: 100, day: "2026-10-15", activities: [], tasks: [], history: [],
    nativeMoonlight: projection(), ...extra });
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
function setup(isCurrent: () => boolean = () => true) {
  const id = ++nextId, generation = "moonlight-" + id, target: NativeMoonlightCallbackTarget = {};
  const accept = vi.fn((e: NativeMoonlightEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence,
    pending: false, revision: e.snapshot!.revision })), reject = vi.fn();
  const host = attachNativeMoonlightHost({ characterId: id, generation, target, isCurrent,
    player: { workshopMoonlightAcceptSnapshot: accept, workshopMoonlightRejectRequest: reject } }); hosts.push(host);
  return { id, generation, target, accept, reject, host,
    request: (action: unknown, sequence = 1) => target.workshopMoonlightRequest!(id, generation, sequence, action) };
}
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
describe("original Moonlight host", () => {
  const ranking = (id: number) => ({ version: 1, kind: "moonlight-native-ranking", scope: "local", metric: "cumulative-box-draws",
    entries: [{ rank: 1, characterId: 2, nickName: "甲", score: 9 }, { rank: 1, characterId: 3, nickName: "乙", score: 9 },
      { rank: 3, characterId: id, nickName: "本人", score: 3 }], personalScore: 3, personalRank: 3 });
  it("reads the real local cumulative-box board with competition ranks without submitting an action", async () => {
    const x = setup(), p = { ...stocked(), ranking: ranking(x.id), ordinaryFutureCaption: "compatible" };
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeMoonlight: p })));
    x.target.workshopMoonlightRead!(x.id, x.generation, 1);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(x.accept.mock.calls[0][0].snapshot?.nativeMoonlight).toEqual(p);
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("accepts legacy omission, null, a genuine zero board, tie cutoff, outside rank and the billion-draw ceiling", async () => {
    for (const kind of ["legacy", "null", "zero", "tie", "outside", "ceiling"] as const) {
      const x = setup(), board = ranking(x.id), p: Record<string, unknown> = kind === "zero" ? projection() : stocked();
      if (kind === "null") p.ranking = null;
      if (kind === "zero") p.ranking = { ...board, entries: [], personalScore: 0, personalRank: null };
      if (kind === "tie") p.ranking = { ...board, personalRank: 1, entries: Array.from({ length: 10 }, (_, i) => ({
        rank: 1, characterId: i + 1, nickName: `角色${i + 1}`, score: 3 })) };
      if (kind === "outside") p.ranking = { ...board, personalRank: 11, entries: Array.from({ length: 10 }, (_, i) => ({
        rank: i + 1, characterId: i + 1, nickName: `角色${i + 1}`, score: 20 - i })) };
      if (kind === "ceiling") { p.draws = 1_000_000_000; p.ranking = { ...board, personalScore: p.draws, personalRank: 1,
        entries: [{ rank: 1, characterId: x.id, nickName: "本人", score: 1_000_000_000 }] }; }
      fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeMoonlight: p })));
      x.target.workshopMoonlightRead!(x.id, x.generation, 1);
      await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled(); x.host.cancel();
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
  it("rejects private ranking data, stale personal scores, bad ties and a missing actor who belongs in the top ten", async () => {
    const mutations: ((r: ReturnType<typeof ranking>) => unknown)[] = [
      r => ({ ...r, version: 2 }), r => ({ ...r, kind: "carnival-native-ranking" }), r => ({ ...r, scope: "cross-server" }),
      r => ({ ...r, metric: "payment" }), r => ({ ...r, personalScore: 2 }), r => ({ ...r, personalRank: null }),
      r => ({ ...r, personalRank: 2 }), r => ({ ...r, entries: [] }), r => ({ ...r, entries: Array(11).fill(r.entries[0]) }),
      r => ({ ...r, seed: "private" }), r => ({ ...r, entries: [{ ...r.entries[0], accountId: 99 }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [{ ...r.entries[0], state: {} }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [{ ...r.entries[0], score: 0 }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [{ ...r.entries[0], score: 1_000_000_001 }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [{ ...r.entries[0], nickName: " " }, ...r.entries.slice(1)] }),
      r => ({ ...r, entries: [r.entries[0], { ...r.entries[1], characterId: 2 }, r.entries[2]] }),
      r => ({ ...r, entries: [r.entries[1], r.entries[0], r.entries[2]] }),
      r => ({ ...r, entries: [r.entries[0], { ...r.entries[1], rank: 2 }, r.entries[2]] }),
      r => ({ ...r, entries: [r.entries[0], r.entries[1], { ...r.entries[2], rank: 2 }] }),
      r => ({ ...r, entries: [r.entries[0], r.entries[1], { ...r.entries[2], score: 2 }] }),
      r => ({ ...r, entries: [r.entries[0], r.entries[1], { ...r.entries[2], characterId: 900000 }] }),
      r => ({ ...r, personalRank: 2, entries: Array.from({ length: 10 }, (_, i) => ({ rank: i < 2 ? i + 1 : 3,
        characterId: i + 1, nickName: `角色${i + 1}`, score: i === 0 ? 9 : i === 1 ? 3 : 2 })) }),
      r => ({ ...r, personalRank: 1, entries: Array.from({ length: 10 }, (_, i) => ({ rank: 1,
        characterId: 900000 + i, nickName: `角色${i + 1}`, score: 3 })) }),
    ];
    for (const mutate of mutations) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeMoonlight: { ...stocked(), ranking: mutate(ranking(x.id)) } })));
      x.target.workshopMoonlightRead!(x.id, x.generation, 1);
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled(); x.host.cancel();
    }
  });
  it("accepts a null POST ranking without weakening the original exchange count or reward effect contract", async () => {
    const x = setup(); fetchMock.mockImplementationOnce(async () => response(snapshot(x.id, {
      nativeMoonlight: { ...stocked(), ranking: null, fragments: 0 },
      nativeMoonlightAction: { requestId: sent().requestId, effects: [{ type: "exchanged", count: 2,
        fragmentsSpent: 20, fragments: 0, templateId: 11021, itemCount: 4 }] } })));
    const ack = x.request({ type: "exchange", choice: bagToken, count: 2 });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(sent()).toMatchObject({ requestId: ack.requestId, action: { count: 2 } });
    expect(x.accept.mock.calls[0][0].snapshot?.nativeMoonlight).toMatchObject({ ranking: null, draws: 3 });
    expect(readPendingActivity(x.id)).toBeNull();
  });
  it("opens with GET only and strips all five effects without opening a box", async () => {
    const x = setup(), stale = { requestId: "old", effects: ["old"] };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativePairAction: stale, nativeMinesAction: stale,
      nativeDDPlayAction: stale, nativeGypsyAction: stale, nativeMoonlightAction: stale })));
    expect(x.target.workshopMoonlightRead!(x.id, x.generation, 1)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction"])
      expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each([1, 3, 5])("keeps the explicit %i-box choice and UUID, delivering only its fresh effects", async count => {
    const x = setup(), other = { requestId: "other", effects: ["other"] };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeMoonlight: stocked(),
      nativeMoonlightAction: { requestId: sent().requestId, effects: [{ type: "drawn", count }] }, nativeGypsyAction: other })));
    const ack = x.request({ type: "draw", choice: bagToken, count });
    expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "draw", choice: bagToken, count });
    expect(x.accept.mock.calls[0][0].snapshot?.nativeMoonlightAction?.requestId).toBe(ack.requestId);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeGypsyAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("sends a copied multi-item quantity selection in one request", async () => {
    const x = setup(), items = [{ index: 0, count: 2 }, { index: 1, count: 1 }];
    fetchMock.mockImplementation(async () => response(snapshot(x.id, {
      nativeMoonlightAction: { requestId: sent().requestId, effects: [{ type: "taken", itemCount: 3 }] } })));
    x.request({ type: "take", choice: bagToken, items }); items[0].count = 60;
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sent().action).toEqual({ type: "take", choice: bagToken, items: [{ index: 0, count: 2 }, { index: 1, count: 1 }] });
  });
  it("rejects missing quotes, duplicate selections, coerced quantities and paid actions without posting", () => {
    const x = setup();
    for (const action of [{ type: "draw", choice: bagToken }, { type: "draw", choice: bagToken, count: 2 },
      { type: "draw", choice: bagToken, count: 1, price: 20 }, { type: "draw", choice: bagToken, count: "1" },
      { type: "take", choice: bagToken, items: [] }, { type: "take", choice: bagToken, items: [{ index: 0, count: 0 }] },
      { type: "take", choice: bagToken, items: [{ index: 0, count: 1 }, { index: 0, count: 1 }] },
      { type: "recycle", choice: bagToken, items: [{ index: 0, count: 1, templateId: 11019 }] },
      { type: "recycle", choice: bagToken, items: [{ index: 4, count: 1 }] },
      { type: "progress", choice: bagToken, tier: 4 },
      ...[0,-1,11,1.5,"2",null,undefined].map(count => ({ type: "exchange", choice: bagToken, count })),
      { type: "exchange", choice: bagToken, count: 2, price: 1 },
      { type: "buy", choice: bagToken }, { type: "rank", choice: bagToken }, { type: "draw", choice: "2026-10-15:short", count: 1 },
      Object.create({ type: "draw", choice: bagToken, count: 1 }),
      Object.assign(Object.create({ choice: bagToken }), { type: "draw", count: 1 })])
      expect(x.request(action)).toEqual({ accepted: false });
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("keeps a UUID unresolved if the quoted bag has duplicate materials", async () => {
    const x = setup(), invalid = stocked(); invalid.bag[1].templateId = 11019;
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeMoonlight: invalid,
      nativeMoonlightAction: { requestId: sent().requestId, effects: [] } })));
    const ack = x.request({ type: "recycle", choice: bagToken, items: [{ index: 0, count: 2 }] });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    expect(x.request({ type: "draw", choice: bagToken, count: 1 }, 2)).toEqual({ accepted: false });
  });
  it("rejects inconsistent balance, token, capacity, costs, recycling and private data", async () => {
    for (const invalid of [{ ...stocked(), score: 101 }, { ...stocked(), bagToken: "2026-10-14:" + "A".repeat(43) },
      { ...stocked(), bagCapacity: 29 }, { ...stocked(), canTake: false },
      { ...stocked(), drawChoices: [{ count: 1, cost: 0, canDraw: true }] },
      { ...stocked(), bag: [{ index: 0, templateId: 11019, itemCount: 2, recycleUnitPoints: 100 }] },
      { ...stocked(), seed: "private" }, { ...stocked(), progress: [] },
      { ...stocked(), exchange: { ...projection().exchange, maxCount: 11 } },
      { ...stocked(), exchange: { ...projection().exchange, affordableCount: 1 } }]) {
      const x = setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { nativeMoonlight: invalid })));
      x.target.workshopMoonlightRead!(x.id, x.generation, 1);
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
    }
  });
  it("allows bag settlement when drawing is limited without rewriting the shared save", async () => {
    const x = setup(), limited = { ...stocked(), canDraw: false,
      drawChoices: [1, 3, 5].map(count => ({ count, cost: count * 20, canDraw: false })) };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeMoonlight: limited })));
    x.target.workshopMoonlightRead!(x.id, x.generation, 1);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(x.accept.mock.calls[0][0].snapshot!.nativeMoonlight).toEqual(limited);
  });
  it("respects the API recycle flag when even one unit would overflow the wallet", async () => {
    const x = setup(), full = { ...stocked(), score: 2_147_483_647, canRecycle: false };
    fetchMock.mockResolvedValue(response(snapshot(x.id, { points: full.score, nativeMoonlight: full })));
    x.target.workshopMoonlightRead!(x.id, x.generation, 1);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(x.accept.mock.calls[0][0].snapshot!.nativeMoonlight).toEqual(full);
  });
  it("recovers the exact UUID after a lost reply and strips replayed effects", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new Error("lost"));
    const ack = x.request({ type: "draw", choice: bagToken, count: 3 });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); const pending = readPendingActivity(x.id)!;
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeMoonlight: stocked(),
      nativeMoonlightAction: { requestId: ack.requestId!, effects: ["must not replay"] } })));
    await retryNativeMoonlightRequest(pending);
    expect(sent().requestId).toBe(ack.requestId); expect(sent().action.count).toBe(3);
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeMoonlightAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each([undefined,1,2,10])("preserves the original exchange quantity %s and validates its complete material effect", async count => {
    const x = setup(), action = { type: "exchange", choice: bagToken, ...(count === undefined ? {} : { count }) }, quantity = count ?? 1;
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeMoonlight: { ...projection(), started: true },
      nativeMoonlightAction: { requestId: sent().requestId, effects: [{ type: "exchanged", count: quantity, fragmentsSpent: quantity * 10,
        fragments: 0, templateId: 11021, itemCount: quantity * 2 }] } })));
    const ack = x.request(action); expect(ack.accepted).toBe(true); action.count = 99;
    expect(x.request({ type: "exchange", choice: bagToken, count: 1 }, 2)).toEqual({ accepted: false });
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual({ type: "exchange", choice: bagToken, ...(count === undefined ? {} : { count }) });
    expect(x.accept.mock.calls[0][0]).toMatchObject({ generation: x.generation, sequence: 1, requestId: ack.requestId });
    expect(fetchMock).toHaveBeenCalledOnce(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("keeps an exchange unresolved when fresh count, cost, quantity or reward identity is inconsistent", async () => {
    for (const patch of [{ count: 1 }, { count: undefined }, { fragmentsSpent: 10 }, { itemCount: 2 }, { fragments: 1 }, { templateId: 11019 }]) {
      const x = setup(); fetchMock.mockImplementation(async () => response(snapshot(x.id, { nativeMoonlight: { ...projection(), started: true },
        nativeMoonlightAction: { requestId: sent().requestId, effects: [{ type: "exchanged", count: 2, fragmentsSpent: 20,
          fragments: 0, templateId: 11021, itemCount: 4, ...patch }] } })));
      const ack = x.request({ type: "exchange", choice: bagToken, count: 2 });
      await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
      expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toMatchObject({ requestId: ack.requestId, action: { count: 2 } });
      expect(x.target.workshopMoonlightRead!(x.id, x.generation, 2)).toEqual({ accepted: false });
    }
  });
  it("retries the same exchange count and UUID after transport loss and never replays the old award", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new Error("lost"));
    const ack = x.request({ type: "exchange", choice: bagToken, count: 3 });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); const pending = readPendingActivity(x.id)!;
    expect(retryNativeMoonlightRequest({ ...pending, action: { ...pending.action, count: 2 } })).toBeNull();
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeMoonlight: { ...projection(), started: true },
      nativeMoonlightAction: { requestId: ack.requestId!, effects: ["old award must not replay"] } })));
    await retryNativeMoonlightRequest(pending);
    expect(sent()).toMatchObject({ requestId: ack.requestId, action: { type: "exchange", choice: bagToken, count: 3 } });
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeMoonlightAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("shares the pending character lock while keeping merchant callbacks separate", async () => {
    const x = setup(), target: NativeGypsyCallbackTarget = {};
    hosts.push(attachNativeGypsyHost({ characterId: x.id, generation: "gypsy", target, isCurrent: () => true,
      player: { workshopGypsyAcceptSnapshot: vi.fn(), workshopGypsyRejectRequest: vi.fn() } }));
    fetchMock.mockRejectedValue(new Error("lost")); x.request({ type: "draw", choice: bagToken, count: 1 });
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(target.workshopGypsyRequest!(x.id, "gypsy", 1, { type: "refresh", choice: "free" })).toEqual({ accepted: false });
    expect(target.workshopGypsyRead).toBeTypeOf("function"); expect(x.target.workshopMoonlightRead).toBeTypeOf("function");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("ignores a late POST after the game changes, retaining the original operation for receipt recovery", async () => {
    let current = true, resolve!: (value: Response) => void; const x = setup(() => current);
    fetchMock.mockImplementation(() => new Promise<Response>(r => { resolve = r; }));
    const ack = x.request({ type: "take", choice: bagToken, items: [{ index: 0, count: 1 }] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); current = false;
    resolve(response(snapshot(x.id, { nativeMoonlightAction: { requestId: ack.requestId!, effects: [] } })));
    await new Promise(r => setTimeout(r, 0));
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("refuses a different character, generation or departed game before any request", () => {
    let current = true; const x = setup(() => current);
    expect(x.target.workshopMoonlightRequest!(x.id + 1, x.generation, 1, { type: "draw", choice: bagToken, count: 1 })).toEqual({ accepted: false });
    expect(x.target.workshopMoonlightRead!(x.id, "other", 1)).toEqual({ accepted: false });
    current = false; expect(x.request({ type: "draw", choice: bagToken, count: 1 })).toEqual({ accepted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
