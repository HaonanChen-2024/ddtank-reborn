import { describe, expect, it } from "vitest";
import { createActivityState, transitionActivity, transitionFirstRechargeGift, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityState, type ActivityWallet } from "../src/activities/types.js";
import type { FirstRechargeNativeState } from "../src/activities/first-recharge-native.js";

const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), characterId: 801, signDays: [], ownedTemplateIds: [] };
const recipientCtx = { ...ctx, characterId: 802 };
const wallet: ActivityWallet = { points: 1000, earned: 600, revision: 0 };
const initial = () => { const s = createActivityState(ctx.now); s.completed.pair = 1; return s; };
const view = (s: ActivityState, w = wallet, c = ctx) => viewActivities(s, w, c).nativeFirstRecharge;
const act = (s: ActivityState, a: ActivityAction, w = wallet, c = ctx) => transitionActivity(s, "first-recharge-native", { ...a, choice: view(s, w, c).stateToken }, c, w);
const cardState = (s: ActivityState) => s.games.firstRechargeNativeV1 as FirstRechargeNativeState;
const rejects = (s: ActivityState, a: ActivityAction, w = wallet) => { const before = structuredClone(s); expect(() => act(s, a, w)).toThrow(ActivityError); expect(s).toEqual(before); };

describe("native first-recharge local task entitlements", () => {
  it("projects three tiers, six cells, a fixed material shop and permanent local cards without mutating saves", () => {
    const s = initial(), before = structuredClone(s), v = view(s);
    expect(s).toEqual(before); expect(v.stateToken).toMatch(/^2026-10-15\.[A-Za-z0-9_-]{43}$/);
    expect(v.tiers.map(t => [t.tier, t.qualification.target, t.canClaim, t.rewards.length])).toEqual([[1, 1, true, 6], [2, 200, true, 6], [3, 600, true, 6]]);
    expect(v.tiers[0]).toMatchObject({ claimKey: "first-gift", rewards: [{ templateId: 11019, count: 5 }, { templateId: 11021, count: 1 }, null, null, null, null] });
    expect(v.shop.rows.map(r => [r.index, r.unitPoints, r.limit, r.canBuy, r.quantityEditable])).toEqual([[0,15,10,1,false],[1,20,10,1,false],[2,25,10,1,false],[3,30,10,1,false]]);
    expect(v.cards).toMatchObject({ availability: "local-defined", policyVersion: 1, cards: [] });
    expect(v.cards.definitions.map(d => [d.kind, d.validity, d.entitlement])).toEqual([1,2,3].map(n => [n, "permanent", "canonical-tier-claim"]));
    v.tiers[0].rewards[0]!.count = 999; v.shop.rows[0].unitPoints = 0;
    expect(view(s).tiers[0].rewards[0]!.count).toBe(5); expect(view(s).shop.rows[0].unitPoints).toBe(15);
    expect(JSON.stringify(v)).not.toMatch(/origin|characterId|12772|rechargeMoney|goldMoney|cardPolicyVersion/);
  });

  it("shares the old first-gift claim and keeps the other activity families and earned thresholds independent", () => {
    const s = initial(); s.claims.push("first-gift", "points-gift:2", "luxury:3");
    expect(view(s).tiers[0].claimed).toBe(true); rejects(s, { type: "claim", tier: 1 }); rejects(s, { type: "issue-card", tier: 1 });
    const second = act(s, { type: "claim", tier: 2 });
    expect(second.state.claims).toEqual(["first-gift", "points-gift:2", "luxury:3", "first-recharge-native:tier:2"]);
    expect(second.rewards).toMatchObject([{ templateId: 11019, count: 10 }, { templateId: 11001, count: 3 }]);
    expect(second.earnedDelta).toBe(0); expect(second.pointsDelta).toBe(0);
    rejects(initial(), { type: "claim", tier: 2 }, { points: 10000, earned: 199, revision: 0 });
    rejects(initial(), { type: "claim", tier: 3 }, { points: 10000, earned: 599, revision: 0 });
    expect(act(initial(), { type: "claim", tier: 3 }).state.claims).toEqual(["first-recharge-native:tier:3"]);
  });

  it("reserves an existing entitlement, blocks old-page bypass, then consumes the active card through the old owner", () => {
    const issued = act(initial(), { type: "issue-card", tier: 1 });
    expect(issued).toMatchObject({ rewards: [], earnedDelta: 0, pointsDelta: 0 });
    const card = cardState(issued.state).cardSlots[0]!;
    expect(card).toMatchObject({ status: "owned", expiresAt: null, origin: { characterId: 801, metric: "completed-board", observed: 1, target: 1 } });
    expect(view(issued.state).tiers[0]).toMatchObject({ entitlementStatus: "reserved", canClaim: false });
    expect(() => transitionActivity(issued.state, "first-gift", { type: "claim" }, ctx, wallet)).toThrow(ActivityError);
    rejects(issued.state, { type: "issue-card", tier: 1 }); rejects(issued.state, { type: "claim", tier: 1 });
    const active = act(issued.state, { type: "use-card", cardId: card.cardId });
    expect(active.rewards).toEqual([]);
    const claimed = transitionActivity(active.state, "first-gift", { type: "claim" }, ctx, wallet);
    expect(claimed.state.claims).toEqual(["first-gift"]); expect(cardState(claimed.state).cardSlots[0]!.status).toBe("used");
    expect(claimed.rewards.map(r => [r.templateId, r.count])).toEqual([[11019,5],[11021,1]]);
    expect(claimed.nativeFirstRechargeEffects).toBeUndefined(); rejects(claimed.state, { type: "claim", tier: 1 });
  });

  it("moves one real task entitlement to a friend without forging earned or allowing another gift", () => {
    const issued = act(initial(), { type: "issue-card", tier: 2 }).state, cardId = cardState(issued).cardSlots[1]!.cardId;
    const target = createActivityState(ctx.now), poorWallet = { points: 0, earned: 0, revision: 0 };
    const result = transitionFirstRechargeGift(issued, target, { type: "gift-card", cardId, recipientName: "Friend", choice: view(issued).stateToken },
      ctx, recipientCtx, wallet, "Sender", "Friend");
    expect(result.source.claims).toContain("first-recharge-native:tier:2"); expect(result.target.claims).toEqual([]);
    expect(cardState(result.source).cardSlots[1]).toMatchObject({ status: "gifted", giftedToCharacterId: 802 });
    expect(cardState(result.target).cardSlots[1]).toMatchObject({ cardId, status: "owned", senderName: "Sender" });
    expect(result.target.completed).toEqual({}); expect(poorWallet.earned).toBe(0);
    const active = act(result.target, { type: "use-card", cardId }, poorWallet, recipientCtx).state;
    expect(view(active, poorWallet, recipientCtx).tiers[1].qualification).toEqual({ metric: "received-card", current: 1, target: 1, met: true });
    const claimed = act(active, { type: "claim", tier: 2 }, poorWallet, recipientCtx);
    expect(claimed.rewards.map(r => [r.templateId,r.count])).toEqual([[11019,10],[11001,3]]); expect(claimed.earnedDelta).toBe(0);
    expect(() => transitionFirstRechargeGift(result.target, initial(), { type: "gift-card", cardId, recipientName: "Third", choice: view(result.target, poorWallet, recipientCtx).stateToken },
      recipientCtx, { ...ctx, characterId: 803 }, poorWallet, "Friend", "Third")).toThrow(ActivityError);
  });

  it("strictly rejects extra fields, stale full tokens, arbitrary card identifiers and bad gift input", () => {
    const s = initial();
    for (const a of [{ type: "claim", tier: 0 }, { type: "claim", tier: 4 }, { type: "claim", tier: 1, count: 1 },
      { type: "buy", index: 0, count: 2 }, { type: "buy", index: 4, count: 1 }, { type: "use-card", cardId: "12772" },
      { type: "issue-card", tier: 1, cardId: "00000000-0000-4000-8000-000000000000" },
      { type: "gift-card", cardId: "00000000-0000-4000-8000-000000000000", recipientName: " Friend" }]) rejects(s, a);
    const a = { type: "claim", tier: 2, choice: view(s).stateToken };
    expect(() => transitionActivity(s, "first-recharge-native", a, ctx, { ...wallet, revision: 1 })).toThrow(ActivityError);
    const changed = structuredClone(s); changed.claims.push("other-activity:unrelated");
    expect(() => transitionActivity(changed, "first-recharge-native", a, ctx, wallet)).toThrow(ActivityError);
    expect(() => transitionActivity(s, "first-recharge-native", a, { ...ctx, now: new Date("2027-10-15T12:00:00Z") }, wallet)).toThrow(ActivityError);
  });

  it("honors UTC shop limits and the daily consumption cap without blocking entitlement settlement", () => {
    let s = initial(), w = { ...wallet }; s.daily.actions = 490;
    for (let i = 0; i < 10; i++) { const r = act(s, { type: "buy", index: 0, count: 1 }, w); s = r.state; w = { ...w, points: w.points + r.pointsDelta, revision: w.revision + 1 }; }
    expect(s.daily.actions).toBe(500); expect(w.points).toBe(850); expect(view(s,w).shop.rows[0]).toMatchObject({ bought: 10, remaining: 0, canBuy: 0 });
    rejects(s, { type: "buy", index: 1, count: 1 }, w);
    s = act(s, { type: "issue-card", tier: 3 }, w).state;
    const cardId = cardState(s).cardSlots[2]!.cardId;
    s = act(s, { type: "use-card", cardId }, w).state;
    expect(act(s, { type: "claim", tier: 3 }, w).state.daily.actions).toBe(500);
    const tomorrow = { ...ctx, now: new Date("2026-10-16T00:00:00Z") };
    expect(view(s,w,tomorrow).shop.rows[0]).toMatchObject({ bought: 0, remaining: 10, canBuy: 1 });
  });

  it("preserves unknown root/native fields while refusing corrupt card/claim state instead of resetting it", () => {
    const s = initial(); (s as unknown as Record<string,unknown>).futureRoot = { keep: 1 }; s.games.existing = { untouched: [1,2] };
    const issued = act(s, { type: "issue-card", tier: 1 }).state;
    (cardState(issued) as unknown as Record<string,unknown>).futureNative = { keep: 2 };
    const result = act(issued, { type: "validate-card", cardId: cardState(issued).cardSlots[0]!.cardId });
    expect(result.state).toHaveProperty("futureRoot", {keep:1}); expect(result.state.games.existing).toEqual({untouched:[1,2]});
    expect(cardState(result.state)).toHaveProperty("futureNative", {keep:2});
    const broken = structuredClone(result.state); cardState(broken).cardSlots[0]!.status = "used";
    expect(() => view(broken)).toThrow(ActivityError); expect(cardState(broken).cardSlots[0]!.status).toBe("used");
    const wrong = structuredClone(result.state); cardState(wrong).cardSlots[0]!.origin.target = 0;
    expect(() => view(wrong)).toThrow(ActivityError);
  });
});
