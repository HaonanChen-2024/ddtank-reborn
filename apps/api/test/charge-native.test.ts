import { describe, expect, it } from "vitest";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { readChargeNativeState, recordChargeNativeSpending, type ChargeNativeState } from "../src/activities/charge-native.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityState, type ActivityWallet } from "../src/activities/types.js";

const ctx: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), signDays: ["2026-10-15"], ownedTemplateIds: [] };
const wallet: ActivityWallet = { points: 1000, earned: 600, revision: 0 };
const initial = () => createActivityState(ctx.now);
const view = (s: ActivityState, w = wallet, c = ctx) => viewActivities(s, w, c).nativeCharge;
const act = (s: ActivityState, a: ActivityAction, w = wallet, c = ctx) => transitionActivity(s, "charge-native", { ...a, choice: view(s,w,c).stateToken }, c,w);
const charge = (s: ActivityState) => s.games.chargeNativeV1 as ChargeNativeState;
const rejects = (s: ActivityState, a: ActivityAction, w = wallet) => { const before = structuredClone(s); expect(() => act(s,a,w)).toThrow(ActivityError); expect(s).toEqual(before); };

describe("native charge explicit local tasks and gross spending", () => {
  it("projects three pages, four real-or-hidden reward cells and seven recipes without creating a save", () => {
    const s = initial(), before = structuredClone(s), v = view(s); expect(s).toEqual(before);
    expect(v.stateToken).toMatch(/^2026-10-15\.[A-Za-z0-9_-]{43}$/); expect(v.grossSpent).toBe(0); expect(v.trackingStartedAt).toBeNull();
    expect(v.pages.map(p => [p.originalRate,p.metric,p.tiers.map(t=>t.target)])).toEqual([
      [1,"today-claimed-task-points",[40,100,200]],[2,"lifetime-task-earned",[100,300,600]],[4,"gross-spent-since-tracking",[100,300,600]]]);
    expect(v.pages.flatMap(p=>p.tiers.map(t=>t.rewards.length))).toEqual(Array(9).fill(4));
    expect(v.pages[1].tiers[1]).toMatchObject({claimKey:"points-gift:2",rewards:[{templateId:11019,count:6},null,null,null]});
    expect(v.exchange.rows.map(r=>[r.catalogId,r.unitPoints,r.limit])).toEqual([
      ["charge-exchange:1",15,1],["charge-exchange:2",20,2],["charge-exchange:3",25,3],["charge-exchange:4",30,3],
      ["charge-exchange:5",35,3],["charge-exchange:6",40,3],["charge-exchange:7",50,3]]);
    v.pages[0].tiers[0].rewards[0]!.count=999; v.exchange.rows[0].reward.count=999;
    expect(view(s).exchange.rows[0].reward.count).toBe(3); expect(view(s).pages[0].tiers[0].rewards[0]!.count).toBe(1);
  });

  it("derives only the exact UTC day's claimed tasks, deduplicates keys and permits all daily tiers", () => {
    let s=initial(); s.daily={safe:8,pairs:3,draws:3}; expect(view(s).todayClaimedTaskPoints).toBe(0);
    for(const id of ["sign","mines","pair","explore"]) s=transitionActivity(s,"tasks",{type:"claim",choice:id},ctx,wallet).state;
    s.claims.push("task:2026-10-14:sign","task:2026-10-15:sign","task:2026-10-15:fake");
    expect(view(s).todayClaimedTaskPoints).toBe(200);
    for(const tier of [1,2,3]) s=act(s,{type:"claim",index:0,tier}).state;
    expect(s.claims).toContain("charge-native:daily:2026-10-15:3"); rejects(s,{type:"claim",index:0,tier:1});
    const tomorrow={...ctx,now:new Date("2026-10-16T00:00:00Z")}; expect(view(s,wallet,tomorrow).todayClaimedTaskPoints).toBe(0);
  });

  it("shares every permanent points-gift entitlement in both directions without touching other gift families", () => {
    let s=transitionActivity(initial(),"points-gift",{type:"claim",tier:1},ctx,wallet).state;
    expect(view(s).pages[1].tiers[0].claimed).toBe(true); rejects(s,{type:"claim",index:1,tier:1});
    const native=act(s,{type:"claim",index:1,tier:2}); s=native.state;
    expect(native.rewards).toMatchObject([{templateId:11019,count:6}]); expect(native.pointsDelta).toBe(0);
    expect(()=>transitionActivity(s,"points-gift",{type:"claim",tier:2},ctx,wallet)).toThrow(ActivityError);
    expect(transitionActivity(s,"luxury",{type:"claim",tier:2},ctx,wallet).rewards).toEqual([{templateId:11019,count:10}]);
    rejects(initial(),{type:"claim",index:1,tier:1},{...wallet,earned:99});
  });

  it("counts actual gross costs even when a roll returns more points, but never task earnings or recycled returns", () => {
    const dd=transitionActivity(initial(),"ddplay",{type:"spin"},ctx,wallet,()=>0.99);
    expect(dd.pointsDelta).toBeGreaterThan(0); expect(charge(dd.state).grossSpent).toBe(10);
    let s=transitionActivity(dd.state,"moon",{type:"draw",count:1},ctx,wallet,()=>0).state;
    expect(charge(s).grossSpent).toBe(30); s=transitionActivity(s,"moon",{type:"recycle"},ctx,wallet).state;
    expect(charge(s).grossSpent).toBe(30); s=transitionActivity(s,"treasure",{type:"draw",count:1,choice:"advanced"},ctx,wallet,()=>0).state;
    expect(charge(s).grossSpent).toBe(90); s=transitionActivity(s,"treasure",{type:"recycle"},ctx,wallet).state;
    expect(charge(s).grossSpent).toBe(90); s=transitionActivity(s,"tasks",{type:"claim",choice:"sign"},ctx,wallet).state;
    expect(charge(s).grossSpent).toBe(90); expect(charge(s).trackingStartedAt).toBe(ctx.now.toISOString());
  });

  it("tracks native and old owner costs once and preserves independent game saves", () => {
    let s=initial(); s.games.unrelated={keep:true};
    const old=transitionActivity(s,"moon",{type:"draw",count:1},ctx,wallet,()=>0); s=old.state;
    const token=viewActivities(s,wallet,ctx).nativeMoonlight.bagToken;
    s=transitionActivity(s,"moonlight-native",{type:"draw",count:3,choice:token},ctx,wallet,()=>0).state;
    expect(charge(s).grossSpent).toBe(80); expect((s.games.moon as {draws:number}).draws).toBe(4);
    const before=structuredClone(s); expect(()=>transitionActivity(s,"treasure",{type:"draw",count:5},ctx,{...wallet,points:0})).toThrow(ActivityError); expect(s).toEqual(before);
    expect(s.games.unrelated).toEqual({keep:true});
  });

  it("requires strict full-fingerprint claims/exchanges and rejects stale balances, progress, dates and extra fields", () => {
    const s=initial(),a={type:"claim",index:1,tier:1,choice:view(s).stateToken};
    for(const changed of [{...wallet,points:999},{...wallet,earned:601},{...wallet,revision:1}]) expect(()=>transitionActivity(s,"charge-native",a,ctx,changed)).toThrow(ActivityError);
    const p=initial(); p.claims.push("task:2026-10-15:sign"); expect(()=>transitionActivity(p,"charge-native",a,ctx,wallet)).toThrow(ActivityError);
    for(const bad of [{type:"claim",index:3,tier:1},{type:"claim",index:1,tier:4},{type:"claim",index:1,tier:1,count:1},
      {type:"exchange",index:7,count:1},{type:"exchange",index:0,count:2},{type:"exchange",index:0,count:1,tier:1}]) rejects(s,bad);
    expect(()=>transitionActivity(s,"charge-native",a,{...ctx,now:new Date("2027-10-15T12:00:00Z")},wallet)).toThrow(ActivityError);
    expect(()=>transitionActivity(s,"charge-native",{...a,price:0} as ActivityAction,ctx,wallet)).toThrow(ActivityError);
  });

  it("enforces UTC daily exchange limits and the shared 500 action cap without blocking qualified claims", () => {
    let s=initial(); s.daily.actions=499;
    const exchanged=act(s,{type:"exchange",index:0,count:1}); s=exchanged.state;
    expect(exchanged).toMatchObject({pointsDelta:-15,earnedDelta:0,rewards:[{templateId:11019,count:3}]});
    expect(charge(s).grossSpent).toBe(15); expect(s.daily.actions).toBe(500); expect(view(s).exchange.rows.every(r=>!r.canExchange)).toBe(true);
    rejects(s,{type:"exchange",index:1,count:1}); expect(act(s,{type:"claim",index:1,tier:3}).state.daily.actions).toBe(500);
    const tomorrow={...ctx,now:new Date("2026-10-16T00:00:00Z")}; expect(view(s,wallet,tomorrow).exchange.rows[0]).toMatchObject({bought:0,remaining:1,canExchange:true});
    expect(view(s,wallet,tomorrow).grossSpent).toBe(15); expect(view(initial(),{...wallet,earned:99}).exchange.rows[2].canExchange).toBe(false);
  });

  it("saturates new gross tracking without rejecting old successful spending and preserves unknown state fields", () => {
    let s=initial(); const existing=recordChargeNativeSpending(undefined,ctx,2147483640); s.games.chargeNativeV1={...existing,future:{keep:true}};
    s=transitionActivity(s,"ddplay",{type:"spin"},ctx,wallet,()=>0.99).state;
    expect(charge(s)).toMatchObject({grossSpent:2147483647,grossCapped:true,future:{keep:true}});
    expect(transitionActivity(s,"exchange",{type:"exchange",index:0},ctx,wallet).pointsDelta).toBeLessThan(0);
    expect(readChargeNativeState(undefined,ctx).grossSpent).toBe(0); expect(view(initial()).grossSpent).toBe(0);
    const malformed=initial(); malformed.games.chargeNativeV1={...existing,bought:[0]}; expect(()=>view(malformed)).toThrow(ActivityError);
  });
});
