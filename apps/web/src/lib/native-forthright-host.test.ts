import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeForthrightHost, retryNativeForthrightRequest, type NativeForthrightCallbackTarget, type NativeForthrightEnvelope } from "./native-forthright-host";
const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [], stateToken = "2026-10-15." + "F".repeat(43);
const groupToken = "g1-1." + "G".repeat(43), orderToken = "o1-1." + "O".repeat(43);
const reward = (templateId: number, count: number) => ({ kind: "item", templateId, count, validDays: 0, bound: true });
const templates = [11019, 11001, 11021, 11002, 11019, 11001, 11021, 11002], groupCounts = [5, 5, 2, 2, 8, 8, 4, 4], groupPrices = [40, 50, 60, 70, 80, 90, 100, 120];
const shopCounts = [3, 3, 1, 1, 6, 6, 2, 2], shopPrices = [20, 25, 30, 35, 40, 45, 50, 60];
const dayIndex = Math.floor(Date.parse("2026-10-15T00:00:00.000Z") / 86_400_000), groupRound = 1 + dayIndex % 4, shopRound = 1 + dayIndex % 5;
const projection = () => ({
  version: 1, rulesVersion: 1, kind: "forthright-native", catalogVersion: "forthright-material-v1", day: "2026-10-15", serverNow: "2026-10-15T04:00:00.000Z",
  stateToken, currency: "local-task-points", points: 1000, taskEarned: 1000, dailyActionsRemaining: 500,
  pages: {
    luxury: { index: 0, title: "累计任务礼", tiers: [200, 500, 1000].map((target, i) => ({ tier: i + 1, target, claimKey: "luxury:" + (i + 1), claimed: false,
      reward: reward(11019, (i + 1) * 5), current: 1000, can: true, reason: "可领取" })) },
    wheel: { index: 1, title: "任务钥匙轮盘", keyEarned: 30, keySpent: 0, keyAvailable: 30, keyTaskPoints: 20, maxKeys: 30, round: 1, allRoundsComplete: false,
      slots: [[11019, 1], [11001, 1], [11019, 2], [11001, 2], [11021, 1], [11002, 1], [11019, 3], [11001, 3], [0, 0], [0, 0]].map(([id, n], index) => ({
        index, prizeId: 101 + index, reward: index < 8 ? reward(id!, n!) : { kind: "coupon", coupon: index === 8 ? "six-fold" : "five-fold", count: 1, name: "本地折扣凭证" },
        drawn: false, probabilityNumerator: 1, probabilityDenominator: 10 })), drawnPrizeIds: [] as number[], canDraw: true, reason: "可抽取" },
    groups: { index: 2, title: "三人积分拼团", cycle: "2026-10-15", round: groupRound, pendingGroupLimit: 1, groupMinutes: 30, globalStock: "not-ported-personal-limits",
      offers: templates.map((id, index) => ({ index, catalogId: `forthright-group:r${groupRound}:${index}`, round: groupRound, name: "普通材料", reward: reward(id, groupCounts[index]!),
        listPoints: groupPrices[index], groupBaseBasisPoints: 8000, quotes: [0.8, 0.6, 0.5].map((discount, tier) => { const cost = Math.ceil(groupPrices[index]! * discount), successCost = Math.ceil(cost * 0.95);
          return { tier, coupon: [null, "six-fold", "five-fold"][tier], cost, successCost, successCashback: cost - successCost, can: tier === 0, reason: "本地规则" }; }),
        personalLimit: 2, bought: 0, reserved: 0, remaining: 2, groups: [] as Record<string, unknown>[], reason: "可购买" })),
      createdOrders: [] as Record<string, unknown>[], joinedOrders: [] as Record<string, unknown>[], inspected: null as Record<string, unknown> | null,
      coupons: ["six-fold", "five-fold"].map((coupon, i) => ({ coupon, name: "本地折扣凭证", basisPoints: [6000, 5000][i], issued: 0, reserved: 0, consumed: 0, available: 0 })) },
    shop: { index: 3, title: "积分分期商店", cycle: "2026-10-15", round: shopRound, phase: "deposit", phaseStartsAt: "2026-10-15T00:00:00.000Z", phaseEndsAt: "2026-10-15T08:00:00.000Z",
      globalStock: "not-ported-personal-limits", unsettledOrders: [] as Record<string, unknown>[], offers: templates.map((id, index) => {
        const discountedPoints = Math.ceil(shopPrices[index]! * 0.8), depositPoints = Math.ceil(discountedPoints * 0.25);
        return { index, catalogId: `forthright-shop:r${shopRound}:${index}`, round: shopRound, name: "普通材料", reward: reward(id, shopCounts[index]!), fullPoints: shopPrices[index],
          discountedPoints, depositPoints, balancePoints: discountedPoints - depositPoints, personalLimit: 1, bought: 0, reserved: 0, remaining: 1,
          canDeposit: true, canBuyFullPrice: false, order: null as Record<string, unknown> | null, reason: "可付订金" }; }) },
  }, rules: { source: "explicit-local-rules", description: ["采用本地任务积分，不接真实付款"] },
  unavailable: ["original-payment", "original-global-stock", "original-cross-server-invites", "original-broadcast", "original-unverified-economy"].map(feature => ({ feature, reason: "未移植原后台" })),
});
const snapshot = (id: number, extra: Partial<ActivityResponse> = {}): ActivityResponse => ({ characterId: id, revision: 1, points: 1000, earned: 1000, day: "2026-10-15", activities: [], tasks: [], history: [], nativeForthright: projection(), ...extra });
const response = (value: unknown) => new Response(JSON.stringify(value)), sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
let nextId = 20000;
function setup(isCurrent = () => true, ready = true) {
  const id = ++nextId, generation = "forthright-" + id, target: NativeForthrightCallbackTarget = {};
  const accept = vi.fn((e: NativeForthrightEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence, pending: false, revision: e.snapshot!.revision })), reject = vi.fn();
  const host = attachNativeForthrightHost({ characterId: id, generation, target, isCurrent,
    player: ready ? { workshopForthrightAcceptSnapshot: accept, workshopForthrightRejectRequest: reject } : {} }); hosts.push(host);
  return { id, generation, target, accept, reject, host, read: () => target.workshopForthrightRead!(id, generation, 1),
    request: (action: unknown, sequence = 1) => target.workshopForthrightRequest!(id, generation, sequence, action) };
}
beforeEach(() => { const data = new Map<string, string>(); vi.stubGlobal("sessionStorage", { getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } }); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
const effectKeys = ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction", "nativeTreasureAction",
  "nativeWheelAction", "nativeCarnivalAction", "nativeFirstRechargeAction", "nativeChargeAction", "nativeForthrightAction"] as const;
const inspectedProjection = () => {
  const p=projection(); p.pages.groups.inspected={code:"g1-1",actionToken:groupToken,catalogId:`forthright-group:r${groupRound}:0`,name:"本地拼团",
    createdAt:"2026-10-15T04:00:00.000Z",expiresAt:"2026-10-15T04:30:00.000Z",requiredMembers:3,
    members:[{nickname:"团长",self:false,creator:true,status:"active",joinedAt:"2026-10-15T04:00:00.000Z",paid:32,credited:0,creditDue:0,rewardMailed:false}],
    status:"pending",publicListing:true,coupon:null,unitPrepaid:32,unitSuccessCost:31,refundDue:0,canJoin:true,canLeave:false,canCancel:false,canSettle:false,reason:"可加入真实三人团"};
  return p;
};
describe("original forthright four-page host", () => {
  it("opens read-only without replaying any of eleven action envelopes", async () => {
    const x = setup(); fetchMock.mockResolvedValue(response(snapshot(x.id, Object.fromEntries(effectKeys.map(k => [k, { requestId: "old", effects: ["old"] }])))));
    x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    for (const k of effectKeys) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(k); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each([
    { type: "claim", tier: 1, choice: stateToken }, { type: "draw", count: 1, choice: stateToken },
    { type: "buy-alone", index: 7, tier: 2, count: 1, choice: stateToken }, { type: "open-group", index: 0, tier: 1, marked: false, count: 1, choice: stateToken },
    { type: "join-group", count: 1, choice: groupToken }, { type: "leave-group", choice: groupToken }, { type: "cancel-group", choice: groupToken },
    { type: "settle-group", choice: groupToken }, { type: "inspect-group", choice: "g1-1" }, { type: "deposit", index: 0, count: 1, choice: stateToken },
    { type: "buy-full-price", index: 7, count: 1, choice: stateToken }, { type: "pay-balance", choice: orderToken }, { type: "settle-order", choice: orderToken },
  ])("submits an immutable exact $type action", async action => {
    const x = setup(), mutable = { ...action } as Record<string, unknown>, expected = { ...action };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, { ...(action.type==="inspect-group" ? {nativeForthright:inspectedProjection()}
      : {nativeForthrightAction:{requestId:sent().requestId,effects:["fresh"]}}),nativeChargeAction:{requestId:"old",effects:["old"]} })));
    expect(x.request(mutable).accepted).toBe(true); mutable.type = "paid"; mutable.choice = "changed";
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(sent().action).toEqual(expected); expect(fetchMock).toHaveBeenCalledOnce();
    expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeChargeAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("accepts an effect-free inspection at the same revision, clears its ledger and permits joining next",async()=>{
    const x=setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id))); x.read(); await vi.waitFor(()=>expect(x.accept).toHaveBeenCalledTimes(1));
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id,{nativeForthright:inspectedProjection(),...Object.fromEntries(effectKeys.map(k=>[k,{requestId:"old",effects:["old"]}]))})));
    expect(x.request({type:"inspect-group",choice:"g1-1"},2).accepted).toBe(true); await vi.waitFor(()=>expect(x.accept).toHaveBeenCalledTimes(2));
    for(const key of effectKeys) expect(x.accept.mock.calls[1][0].snapshot).not.toHaveProperty(key); expect(readPendingActivity(x.id)).toBeNull();
    fetchMock.mockImplementationOnce(async()=>response(snapshot(x.id,{revision:2,nativeForthrightAction:{requestId:sent().requestId,effects:["joined"]}})));
    expect(x.request({type:"join-group",count:1,choice:groupToken},3).accepted).toBe(true); await vi.waitFor(()=>expect(x.accept).toHaveBeenCalledTimes(3));
    expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("retries an uncertain read-only inspection using the same UUID without requiring a server receipt",async()=>{
    const x=setup(); fetchMock.mockRejectedValueOnce(new TypeError("response lost")); x.request({type:"inspect-group",choice:"g1-1"});
    await vi.waitFor(()=>expect(x.reject).toHaveBeenCalledOnce()); const pending=readPendingActivity(x.id)!,first=sent();
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id,{nativeForthright:inspectedProjection()})));
    await retryNativeForthrightRequest(pending); expect(sent().requestId).toBe(first.requestId); expect(x.accept).toHaveBeenCalledOnce();
    expect(readPendingActivity(x.id)).toBeNull(); expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeForthrightAction");
  });
  it("retains a pending inspection if the returned group differs from the requested code",async()=>{
    const x=setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id,{nativeForthright:inspectedProjection()})));
    x.request({type:"inspect-group",choice:"g1-2"}); await vi.waitFor(()=>expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.action.choice).toBe("g1-2");
  });
  it("still requires an exact fresh receipt for write actions",async()=>{
    const x=setup(); fetchMock.mockResolvedValueOnce(response(snapshot(x.id))); x.request({type:"join-group",count:1,choice:groupToken});
    await vi.waitFor(()=>expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).not.toBeNull();
  });
  it("rejects payment, fake members, short tokens, ten-draw and extra cost fields before fetching", () => {
    const x = setup(); let sequence = 0;
    for (const action of [
      { type: "draw", count: 10, choice: stateToken }, { type: "draw", count: 1, choice: stateToken.slice(0, -1) }, { type: "claim", tier: 4, choice: stateToken },
      { type: "buy-alone", index: 8, tier: 0, count: 1, choice: stateToken }, { type: "open-group", index: 0, tier: 0, marked: true, count: 1, choice: stateToken, members: [1, 2, 3] },
      { type: "join-group", count: 1, choice: "g1-1" }, { type: "leave-group", choice: groupToken, cost: 0 }, { type: "pay-balance", choice: groupToken },
      { type: "inspect-group", choice: "g01-1" }, { type: "inspect-group", choice: "g0-1" }, { type: "inspect-group", choice: "gzzzzzz-1" },
      { type: "deposit", index: 0, count: 1, choice: stateToken, cost: 0 }, { type: "pay", choice: stateToken }, Object.create({ type: "draw", count: 1, choice: stateToken }),
    ]) expect(x.request(action, ++sequence).accepted).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["canonical", "reward", "probability", "coupon", "private", "shop-price", "fake-stock"])("refuses incompatible public projection: %s", async kind => {
    const x = setup(), p = projection();
    if (kind === "canonical") p.pages.luxury.tiers[0]!.claimKey = "second-award";
    if (kind === "reward") p.pages.wheel.slots[0]!.reward = reward(11906, 1);
    if (kind === "probability") p.pages.wheel.slots[0]!.probabilityDenominator = 1;
    if (kind === "coupon") p.pages.groups.coupons[0]!.available = 1;
    if (kind === "private") Object.assign(p, { games: {} });
    if (kind === "shop-price") p.pages.shop.offers[0]!.depositPoints = 0;
    if (kind === "fake-stock") p.pages.groups.globalStock = "global-unlimited";
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeForthright: p }))); x.read(); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
  });
  it("accepts cap-disabled purchases while leaving earned claims available", async () => {
    const x = setup(), p = projection(); p.dailyActionsRemaining = 0; p.pages.wheel.canDraw = false;
    for (const row of p.pages.groups.offers) for (const quote of row.quotes) quote.can = false;
    for (const row of p.pages.shop.offers) row.canDeposit = false;
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeForthright: p }))); x.read(); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it.each(["valid", "fake-completion", "member-cancel", "private-member"])("checks the real-member projection: %s", async kind => {
    const x = setup(), p = projection();
    const g = { code: "g1-1", actionToken: groupToken, catalogId: `forthright-group:r${groupRound}:0`, name: "本地拼团", createdAt: "2026-10-15T04:00:00.000Z", expiresAt: "2026-10-15T04:30:00.000Z",
      requiredMembers: 3, members: [true, false].map(creator => ({ nickname: creator ? "团长" : "本人", self: !creator, creator, status: "active", joinedAt: "2026-10-15T04:00:00.000Z", paid: 32, credited: 0, creditDue: 0, rewardMailed: false })),
      status: "pending", publicListing: true, coupon: null, unitPrepaid: 32, unitSuccessCost: 31, refundDue: 0, canJoin: false, canLeave: true, canCancel: false, canSettle: false, reason: "等待第三个真实角色" };
    if (kind === "fake-completion") g.status = "completed";
    if (kind === "member-cancel") g.canCancel = true;
    if (kind === "private-member") Object.assign(g.members[0]!, { characterId: 1 });
    p.pages.groups.inspected = g; fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeForthright: p }))); x.read();
    if (kind === "valid") await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    else { await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled(); }
  });
  it.each([false, true])("checks owned deposit order codes (foreign=%s)", async foreign => {
    const x = setup(), p = projection(), code = "o" + (x.id + Number(foreign)).toString(36) + "-1";
    const o = { code, actionToken: code + "." + "O".repeat(43), catalogId: `forthright-shop:r${shopRound}:0`, name: "本人分期订单", createdAt: "2026-10-15T01:00:00.000Z", balanceStartsAt: "2026-10-15T08:00:00.000Z", balanceEndsAt: "2026-10-15T16:00:00.000Z",
      status: "deposit-paid", depositPoints: 4, balancePoints: 12, credited: 0, refundDue: 0, rewardMailed: false, canPayBalance: false, canSettle: false, reason: "等待尾款阶段" };
    p.pages.shop.offers[0]!.order = o; p.pages.shop.offers[0]!.reserved = 1; p.pages.shop.offers[0]!.remaining = 0; p.pages.shop.offers[0]!.canDeposit = false; p.pages.shop.unsettledOrders.push(o);
    fetchMock.mockResolvedValue(response(snapshot(x.id, { nativeForthright: p }))); x.read();
    if (foreign) { await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled(); }
    else await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
  });
  it("retries an uncertain member payment under the same UUID without replay animation", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    const ack = x.request({ type: "join-group", count: 1, choice: groupToken }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    const pending = readPendingActivity(x.id)!, first = sent(); expect(pending.requestId).toBe(ack.requestId);
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, { replayed: true, nativeForthrightAction: { requestId: ack.requestId!, effects: ["old"] } })));
    await retryNativeForthrightRequest(pending); expect(sent()).toEqual(first); expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty("nativeForthrightAction"); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("refuses a retired owner, wrong role/generation and absent game callbacks", () => {
    let current = true; const x = setup(() => current);
    expect(x.target.workshopForthrightRead!(x.id + 1, x.generation, 1).accepted).toBe(false); expect(x.target.workshopForthrightRead!(x.id, "old", 2).accepted).toBe(false);
    current = false; expect(x.read().accepted).toBe(false); const missing = setup(() => true, false); expect(missing.read().accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); x.host.cancel(); expect(x.target.workshopForthrightRequest).toBeUndefined();
  });
});
