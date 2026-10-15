import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { advanceForthrightGroup, decodeForthrightCode, readForthrightNativeState, validateForthrightNativeAction,
  viewForthrightNative, type ForthrightRole, type PrivateGroup, type PrivateState } from "../src/activities/forthright-native.js";
import type { ActivityAction, ActivityContext, ActivityState, ActivityWallet } from "../src/activities/types.js";

const clock = (iso = "2026-10-15T02:00:00Z", id = 11): ActivityContext => ({ now: new Date(iso), characterId: id, requestId: randomUUID(), signDays: [], ownedTemplateIds: [] });
const wallet = (points = 1000, earned = 1000): ActivityWallet => ({ points, earned, revision: 0 });
const root = (ctx = clock()) => createActivityState(ctx.now);
const projection = (r: ActivityState, c = clock(), w = wallet()) => viewForthrightNative(r, c, w);
function single(r: ActivityState, action: ActivityAction, ctx = clock(), w = wallet(), rng = () => .99) {
  const changed = transitionActivity(r, "forthright-native", { ...action, choice: action.choice ?? projection(r, ctx, w).stateToken }, ctx, w, rng);
  return { root: changed.state, wallet: { points: w.points + changed.pointsDelta, earned: w.earned + changed.earnedDelta, revision: w.revision + 1 }, changed };
}
const role = (id: number): ForthrightRole => ({ characterId: id, nickname: `角色${id}`, root: root(), wallet: wallet() });
function group(roles: ForthrightRole[], action: ActivityAction, actor = 11, iso = "2026-10-15T02:00:00Z") {
  const ctx = clock(iso, actor), g = roles.flatMap(r => Object.values(readForthrightNativeState(r.root.games.forthrightNativeV1).createdGroups));
  ctx.forthrightGroups = g;
  const mine = roles.find(r => r.characterId === actor)!, view = projection(mine.root, ctx, mine.wallet);
  const a = { ...action, choice: action.choice ?? (action.type === "open-group" ? view.stateToken : view.pages.groups.createdOrders[0]?.actionToken ?? view.pages.groups.offers.flatMap(o => o.groups)[0]?.actionToken) };
  const result = advanceForthrightGroup(roles, a, ctx);
  const next = roles.map(r => { const changed = result.roles.find(x => x.characterId === r.characterId); return changed ? { characterId: r.characterId, nickname: r.nickname, root: changed.root,
    wallet: { points: changed.wallet.points - changed.cost + changed.credited, earned: changed.wallet.earned, revision: changed.wallet.revision + 1 } } : r; });
  return { roles: next, result };
}
function token(roles: ForthrightRole[], actor: number, iso = "2026-10-15T02:00:00Z") {
  const ctx = clock(iso, actor), mine = roles.find(r => r.characterId === actor)!;
  ctx.forthrightGroups = roles.flatMap(r => Object.values(readForthrightNativeState(r.root.games.forthrightNativeV1).createdGroups));
  const p = projection(mine.root, ctx, mine.wallet); return [...p.pages.groups.createdOrders, ...p.pages.groups.joinedOrders, ...p.pages.groups.offers.flatMap(o => o.groups)][0].actionToken;
}
describe("native forthright four-page local owner", () => {
  it("projects all four pages without persisting or exposing private IDs", () => {
    const r = root(), before = structuredClone(r), p = projection(r);
    expect(p.pages.luxury.tiers.map(t => [t.target, t.reward])).toEqual([200, 500, 1000].map((n, i) => [n, { kind: "item", templateId: 11019, count: (i + 1) * 5, validDays: 0, bound: true }]));
    expect(p.pages.groups.offers).toHaveLength(8); expect(p.pages.shop.offers).toHaveLength(8); expect(p.pages.wheel.slots).toHaveLength(10);
    expect(p.stateToken).toMatch(/^2026-10-15\.[A-Za-z0-9_-]{43}$/); expect(r).toEqual(before); expect(JSON.stringify(p)).not.toMatch(/"(?:characterId|creatorId|id|seed|games)":/);
  });
  it("shares old luxury keys in both directions and settles at daily500", () => {
    const ctx = clock(), r = root(ctx); r.daily.actions = 500;
    const n = single(r, { type: "claim", tier: 1 }, ctx); expect(n.changed.rewards).toEqual([{ templateId: 11019, count: 5, validDays: 0 }]);
    expect(() => transitionActivity(n.root, "luxury", { type: "claim", tier: 1 }, ctx, n.wallet)).toThrow(/已经领取/);
    const old = transitionActivity(r, "luxury", { type: "claim", tier: 2 }, ctx, wallet());
    expect(projection(old.state).pages.luxury.tiers[1]).toMatchObject({ can: false, claimed: true });
    expect(n.root.daily.actions).toBe(500);
  });
  it("draws exactly thirty nonreplacement slots, advances rounds and grants six real local coupons", () => {
    let r = root(), w = wallet(); const prizes: number[] = [];
    for (let i = 0; i < 30; i++) { const n = single(r, { type: "draw", count: 1 }, clock(), w); r = n.root; w = n.wallet;
      const effect = n.changed.nativeForthrightEffects![0]; expect(effect.type).toBe("drawn"); if (effect.type === "drawn") prizes.push(effect.prizeId); }
    const p = projection(r, clock(), w);
    expect(new Set(prizes).size).toBe(30); expect(p.pages.wheel).toMatchObject({ allRoundsComplete: true, keySpent: 30, round: 3, canDraw: false });
    expect(p.pages.wheel.slots.every(s => s.probabilityDenominator === 0)).toBe(true);
    expect(p.pages.groups.coupons.map(c => c.issued)).toEqual([3, 3]); expect(w.points).toBe(1000);
    expect(() => single(r, { type: "draw", count: 1 }, clock(), w)).toThrow();
  });
  it("keeps old native owners and unknown root/owner fields intact", () => {
    const r = root(); r.games.carnival = { sentinel: 7 }; const s = readForthrightNativeState(undefined) as PrivateState & { future: unknown }; s.future = { keep: 1 }; r.games.forthrightNativeV1 = s;
    const n = single(r, { type: "draw", count: 1 }); expect(n.root.games.carnival).toEqual({ sentinel: 7 }); expect(n.root.games.forthrightNativeV1).toHaveProperty("future", { keep: 1 }); expect(r.claims).toEqual([]);
  });
  it.each([NaN, -1, 1, Infinity])("rejects invalid random source %s without mutating state", n => {
    const r = root(); expect(() => single(r, { type: "draw", count: 1 }, clock(), wallet(), () => n)).toThrow(); expect(r.games).toEqual({});
  });
  it("rejects extra fields, noncanonical code and stale/full state tokens", () => {
    expect(() => validateForthrightNativeAction({ type: "draw", count: 1, choice: projection(root()).stateToken, index: 0 })).toThrow();
    expect(decodeForthrightCode("gzik0zj-zik0zj")).toEqual({ ownerId: 2147483647, sequence: 2147483647 });
    for (const code of ["g01-1", "g1-01", "gZ-1", "gzik0zk-1", "g1-0"]) expect(() => decodeForthrightCode(code)).toThrow();
    const r = root(), old = projection(r).stateToken;
    expect(() => single(r, { type: "draw", count: 1, choice: old }, clock(), wallet(999))).toThrow(/状态已变化/);
    expect(() => single(r, { type: "draw", count: 1, choice: old }, clock("2026-10-16T02:00:00Z"))).toThrow(/状态已变化/);
  });
  it("rejects malformed wheel/coupon save rather than resetting it", () => {
    const s = readForthrightNativeState(undefined); s.wheel.keySpent = 1; expect(() => readForthrightNativeState(s)).toThrow();
    s.wheel.keySpent = 0; s.coupons["six-fold"].issued = 1; expect(() => readForthrightNativeState(s)).toThrow();
  });
  it("single purchase charges full price without coupon and uses shared gross ledger", () => {
    const n = single(root(), { type: "buy-alone", index: 0, tier: 0, count: 1 });
    expect(n.wallet.points).toBe(960); expect(n.root.games.chargeNativeV1).toMatchObject({ grossSpent: 40 }); expect(n.changed.rewards[0].count).toBe(5);
  });
  it("member leave refunds only that member and keeps the group open for another real member", () => {
    let x = group([role(11), role(12), role(13), role(14)], { type: "open-group", index: 0, tier: 0, count: 1, marked: true });
    x = group(x.roles, { type: "join-group", count: 1, choice: token(x.roles, 12) }, 12);
    x = group(x.roles, { type: "leave-group", choice: token(x.roles, 12) }, 12);
    expect(x.result.group.status).toBe("pending"); expect(x.roles.find(r => r.characterId === 12)!.wallet.points).toBe(1000);
    expect(x.result.group.members[1]).toMatchObject({ status: "left", credited: 32, creditDue: 0, rewardMailed: false });
    expect(() => group(x.roles, { type: "join-group", count: 1, choice: token(x.roles, 12) }, 12)).toThrow();
    x = group(x.roles, { type: "join-group", count: 1, choice: token(x.roles, 13) }, 13);
    x = group(x.roles, { type: "join-group", count: 1, choice: token(x.roles, 14) }, 14);
    expect(x.result.group.status).toBe("completed"); expect(x.result.roles.filter(r => r.rewards.length).map(r => r.characterId).sort()).toEqual([11, 13, 14]);
    expect(x.result.group.members.find(m => m.characterId === 12)!.rewardMailed).toBe(false);
    expect(x.roles.find(r => r.characterId === 11)!.wallet.points).toBe(969);
    expect(x.result.roles.every(r => r.wallet.earned === 1000)).toBe(true);
  });
  it("only creator may cancel whole group; creator cannot leave", () => {
    let x = group([role(11), role(12)], { type: "open-group", index: 0, tier: 0, count: 1, marked: true });
    x = group(x.roles, { type: "join-group", count: 1, choice: token(x.roles, 12) }, 12);
    expect(() => group(x.roles, { type: "cancel-group", choice: token(x.roles, 12) }, 12)).toThrow();
    expect(() => group(x.roles, { type: "leave-group", choice: token(x.roles, 11) }, 11)).toThrow();
    x = group(x.roles, { type: "cancel-group", choice: token(x.roles, 11) }); expect(x.result.group.status).toBe("cancelled");
    expect(x.roles.map(r => r.wallet.points)).toEqual([1000, 1000]); expect(x.result.roles.every(r => r.rewards.length === 0)).toBe(true);
  });
  it("retains overflow creditDue, permits historical member settlement and never increases earned", () => {
    let x = group([role(11), role(12)], { type: "open-group", index: 0, tier: 0, count: 1, marked: true });
    x = group(x.roles, { type: "join-group", count: 1, choice: token(x.roles, 12) }, 12);
    x.roles.find(r => r.characterId === 12)!.wallet.points = 2147483647;
    x = group(x.roles, { type: "leave-group", choice: token(x.roles, 12) }, 12);
    expect(x.result.group.members[1].creditDue).toBe(32); x.roles.find(r => r.characterId === 12)!.wallet.points -= 20;
    x = group(x.roles, { type: "settle-group", choice: token(x.roles, 11) });
    expect(x.result.group.members[1]).toMatchObject({ credited: 20, creditDue: 12 }); expect(x.result.group.status).toBe("pending");
  });
  it("GET shows expired-unsettled without mutation and any historical member settles at daily500", () => {
    let x = group([role(11), role(12)], { type: "open-group", index: 0, tier: 0, count: 1, marked: true });
    x = group(x.roles, { type: "join-group", count: 1, choice: token(x.roles, 12) }, 12);
    const iso = "2026-10-15T02:30:00Z", ctx = clock(iso, 12); ctx.forthrightGroups = [x.result.group]; const before = structuredClone(x.roles);
    expect(projection(x.roles[1].root, ctx, x.roles[1].wallet).pages.groups.joinedOrders[0].status).toBe("expired-unsettled"); expect(x.roles).toEqual(before);
    x.roles[1].root.daily.actions = 500; x = group(x.roles, { type: "settle-group", choice: token(x.roles, 12, iso) }, 12, iso);
    expect(x.roles[1].root.daily.actions).toBe(500); expect(x.roles.map(r => r.wallet.points)).toEqual([1000, 1000]);
  });
  it("deposit then balance produces one reward and only actual total cost in gross ledger, at cap", () => {
    const ctx = clock(), a = single(root(ctx), { type: "deposit", index: 0, count: 1 }, ctx); expect(a.changed.rewards).toEqual([]); expect(a.wallet.points).toBe(996);
    a.root.daily.actions = 500; const bctx = clock("2026-10-15T08:00:00Z"), view = projection(a.root, bctx, a.wallet).pages.shop.offers[0].order!;
    const b = single(a.root, { type: "pay-balance", choice: view.actionToken }, bctx, a.wallet);
    expect(b.wallet.points).toBe(984); expect(b.root.games.chargeNativeV1).toMatchObject({ grossSpent: 16 }); expect(b.changed.rewards).toEqual([{ templateId: 11019, count: 3, validDays: 0 }]); expect(b.root.daily.actions).toBe(500);
    expect(() => single(b.root, { type: "pay-balance", choice: view.actionToken }, bctx, b.wallet)).toThrow();
  });
  it("expired deposit refunds explicitly without reducing gross or earned and releases same-day full-price slot", () => {
    const ctx = clock(), a = single(root(ctx), { type: "deposit", index: 0, count: 1 }, ctx), bctx = clock("2026-10-15T16:00:00Z");
    const p = projection(a.root, bctx, a.wallet); expect(p.pages.shop.offers[0].canBuyFullPrice).toBe(false);
    const b = single(a.root, { type: "settle-order", choice: p.pages.shop.unsettledOrders[0].actionToken }, bctx, a.wallet);
    expect(b.wallet).toMatchObject({ points: 1000, earned: 1000 }); expect(b.root.games.chargeNativeV1).toMatchObject({ grossSpent: 4 });
    expect(b.changed.nativeForthrightNotification).toMatch(/退回4积分/); expect(projection(b.root, bctx, b.wallet).pages.shop.offers[0].canBuyFullPrice).toBe(true);
    const c = single(b.root, { type: "buy-full-price", index: 0, count: 1 }, bctx, b.wallet); expect(c.wallet.points).toBe(980); expect(c.changed.rewards).toHaveLength(1);
  });
  it("snapshot includes the additive native projection and leaves old luxury view available", () => {
    const p = viewActivities(root(), wallet(), clock()); expect(p.nativeForthright.kind).toBe("forthright-native"); expect(p.activities.some(a => a.id === "luxury")).toBe(true);
  });
});
