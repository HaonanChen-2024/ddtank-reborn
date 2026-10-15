import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppCtx } from "../src/context.js";
import type { Claims } from "../src/lib/jwt.js";
import type { ActivityAction } from "../src/activities/types.js";
import { commandChristmas, unavailableChristmas, validChristmasView } from "../src/activities/christmas-native.js";
import { commandSnowfield, readSnowfieldPair, unavailableSnowfield, validateSnowfieldAction, validSnowfieldPair, validSnowfieldView, type SnowfieldPair, type SnowfieldView } from "../src/activities/christmas-snowfield.js";

const day="2026-10-15", now=`${day}T10:00:00.000Z`, hash="A".repeat(43), choice=day+"."+hash;
const requestId="0807f928-38a1-4ea9-92f9-cb9fd7f2d629";
const app={cfg:{GAME_INTERNAL_URL:"http://snowfield-tests.invalid",GAME_INTERNAL_TOKEN:"test-only"}} as AppCtx;
const claims={sub:916,name:"local-test"} as Claims;
function field():SnowfieldView {
  const reward=(templateId:11019|11001|11021|11002)=>({templateId,name:"本地材料",itemCount:1,bound:true as const,validDays:0 as const});
  return {version:1,kind:"christmas-snowfield",rulesVersion:1,catalogVersion:"christmas-snowfield-local-v1",day,serverNow:now,revision:7,authority:"online",available:true,reason:"可以使用本地雪场",stateToken:choice,currency:"local-task-points",points:100,taskEarned:200,
    entry:{available:true,reason:"可返回雪场"},ticket:{claimKey:`task:${day}:sign`,qualifiedToday:true,issuedToday:true,issuedAt:`${day}T09:50:00.000Z`,expiresAt:`${day}T10:20:00.000Z`,valid:true,durationSeconds:1800},
    scene:{revision:hash,state:"inside",people:1,capacity:20,canResume:false,reason:"已在雪场"},
    challenges:([0,1,2] as const).map(i=>({index:i,type:i,title:`本地雪人${i}`,monsterId:i+1,state:"alive",originalMissionId:40001+i,localPveId:164001+i,battleMapId:1201,usedToday:0,remainingToday:3,limit:3,canChallenge:true,reason:"可挑战",reward:reward([11019,11001,11021][i] as 11019|11001|11021)})) as SnowfieldView["challenges"],
    attempt:{state:"none",type:null,canResume:false,refundPending:false,reason:"没有待结算挑战"},npc:{hasSettledWinToday:false,claimed:false,canClaim:false,reason:"需要先真实获胜",reward:reward(11002)},rules:["本地签到票，三关各三次。"],unavailable:[{id:"original-economy",reason:"本地规则"},{id:"original-mission-rules",reason:"本地1201地图"}]};
}
function pair(f=field()):SnowfieldPair {return {snowman:{...unavailableChristmas(f.revision,f.day,f.points,f.taskEarned),snowfield:f.entry},snowfield:f};}
const response=(value:unknown)=>Response.json({ok:true,value});
afterEach(()=>vi.unstubAllGlobals());
describe("F2 snowfield authenticated thin adapter",()=>{
  it("validates the exact pair, mirror, known battle IDs and complete tokens",()=>{
    const p=pair();expect(validSnowfieldPair(p)).toBe(true);expect(validChristmasView(p.snowman)).toBe(false);expect(validChristmasView(p.snowman,true)).toBe(true);
    for(const mutate of [
      (x:SnowfieldPair)=>{x.snowman.snowfield={available:false,reason:"old"};},
      (x:SnowfieldPair)=>{x.snowfield.revision++;},
      (x:SnowfieldPair)=>{x.snowfield.challenges[0].localPveId=164003;},
      (x:SnowfieldPair)=>{x.snowfield.challenges[0].battleMapId=70022 as 1201;},
      (x:SnowfieldPair)=>{x.snowfield.stateToken=day+"."+"A".repeat(42);},
      (x:SnowfieldPair)=>{Object.assign(x.snowfield,{privateState:{bad:true}});},
      (x:SnowfieldPair)=>{x.snowfield.challenges[0].usedToday=3;},
      (x:SnowfieldPair)=>{x.snowfield.ticket.expiresAt=`${day}T09:59:00.000Z`;},
    ]){const bad=structuredClone(p);mutate(bad);expect(validSnowfieldPair(bad)).toBe(false);}
  });
  it("keeps the unavailable skeleton closed and preserves wrapper currency",()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(now));
    try{const v=unavailableSnowfield(7,day,100,200);expect(validSnowfieldView(v)).toBe(true);expect(v).toMatchObject({points:100,taskEarned:200,challenges:[],scene:{revision:null,canResume:false},npc:{reward:null,canClaim:false}});expect(validSnowfieldView({...v,entry:{available:true,reason:"wrong"}})).toBe(false);}finally{vi.useRealTimers();}
  });
  it("rejects extra keys and client-selected mission, amount or shortened credentials",()=>{
    for(const a of [{type:"enter",choice},{type:"challenge",index:2,choice},{type:"npc-claim",choice}])expect(()=>validateSnowfieldAction(a)).not.toThrow();
    for(const a of [{type:"enter",choice,count:1},{type:"challenge",index:3,choice},{type:"challenge",index:0,choice,missionId:40001},{type:"npc-claim",choice:hash},{type:"claim",choice}])expect(()=>validateSnowfieldAction(a as ActivityAction)).toThrow();
  });
  it("reads exactly one paired game projection, with no database transaction",async()=>{
    const p=pair(),fetch=vi.fn(async()=>response(p));vi.stubGlobal("fetch",fetch);
    expect(await readSnowfieldPair(app,claims,916,7,day,100,200)).toEqual(p);expect(fetch).toHaveBeenCalledOnce();
    const [url,options]=fetch.mock.calls[0] as unknown as [string,RequestInit];expect(new URL(url).pathname).toBe("/activity-christmas-snowfield/read");expect(JSON.parse(String(options.body))).toEqual({actor:{accountId:916,accountName:"local-test"},characterId:916});
  });
  it("old service fallback retains snowman and forcibly mirrors a closed snowfield",async()=>{
    const old=unavailableChristmas(7,day,100,200),fetch=vi.fn(async(url:string)=>url.includes("snowfield")?new Response("old-service",{status:404}):response(old));vi.stubGlobal("fetch",fetch);
    const p=await readSnowfieldPair(app,claims,916,7,day,100,200);expect(p.snowman.snowfield).toEqual(p.snowfield.entry);expect(p.snowfield.available).toBe(false);expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("accepts three fresh effect families in the sole envelope and replay without effects",async()=>{
    const p=pair();const cases:[ActivityAction,Record<string,unknown>,number][]=[
      [{type:"enter",choice},{type:"entered",issued:false,issuedAt:p.snowfield.ticket.issuedAt,expiresAt:p.snowfield.ticket.expiresAt},0],
      [{type:"challenge",index:1,choice},{type:"challenged",index:1,monsterId:2,originalMissionId:40002,localPveId:164002,usedToday:1},0],
      [{type:"npc-claim",choice},{type:"npc-claimed",rewards:[p.snowfield.npc.reward]},1],
    ];
    for(const [action,e,mailedCount] of cases){const value={pair:p,requestId,replayed:false,message:"已确认",mailedCount,nativeChristmasAction:{requestId,effects:[{...e,committedRevision:7,committedSceneRevision:hash}]}};
      vi.stubGlobal("fetch",vi.fn(async()=>response(value)));expect((await commandSnowfield(app,claims,916,requestId,action)).nativeChristmasAction!.effects).toHaveLength(1);
      vi.stubGlobal("fetch",vi.fn(async()=>response({...value,nativeChristmasAction:{requestId,effects:[{...e,committedRevision:7,committedSceneRevision:"short"}]}})));await expect(commandSnowfield(app,claims,916,requestId,action)).rejects.toMatchObject({statusCode:503});
    }
    vi.stubGlobal("fetch",vi.fn(async()=>response({pair:p,requestId,replayed:true,message:"原请求已提交",mailedCount:0})));expect((await commandSnowfield(app,claims,916,requestId,{type:"enter",choice})).nativeChristmasAction).toBeUndefined();
  });
  it.each(["timeout","non200","malformed"])("%s keeps a POST uncertain, never retries or switches ownership",async mode=>{
    const fetch=vi.fn(async()=>{if(mode==="timeout")throw Error("simulated network loss");return mode==="non200"?new Response("unavailable",{status:503}):response({bad:true});});vi.stubGlobal("fetch",fetch);
    await expect(commandSnowfield(app,claims,916,requestId,{type:"enter",choice})).rejects.toMatchObject({statusCode:503});expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["400","409",409.5,null,true])("malformed rejection status %s cannot abandon an unresolved UUID",async status=>{
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({ok:false,status,message:"upstream rejection"})));
    await expect(commandSnowfield(app,claims,916,requestId,{type:"enter",choice})).rejects.toMatchObject({statusCode:503});
    await expect(commandChristmas(app,claims,916,requestId,{type:"craft",count:1,marked:false,choice})).rejects.toMatchObject({statusCode:503});
  });
  it("does not coerce JSON arrays into action, authority or scene state enums",()=>{
    expect(()=>validateSnowfieldAction({type:["enter"],choice} as unknown as ActivityAction)).toThrow();
    for(const mutate of [
      (v:SnowfieldView)=>{v.authority=["offline"] as unknown as "offline";v.available=false;v.stateToken=null;v.entry.available=false;},
      (v:SnowfieldView)=>{v.scene.state=["inside"] as unknown as "inside";},
      (v:SnowfieldView)=>{v.attempt.state=["admitted"] as unknown as "admitted";v.attempt.type=0;},
      (v:SnowfieldView)=>{v.challenges[0].state=["alive"] as unknown as "alive";},
    ]){const v=field();for(const row of v.challenges)row.canChallenge=false;mutate(v);expect(validSnowfieldView(v)).toBe(false);}
  });
});
