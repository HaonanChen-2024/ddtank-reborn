import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { TREASURE_CARD_BOX_IDS, TREASURE_CARD_IDS, TREASURE_DRILL_POOL_VERSION, TREASURE_ENTRIES, TREASURE_IDS,
  TREASURE_POOL_VERSION, TREASURE_PREVIOUS_POOL_VERSION, TREASURE_STRENGTHEN_POOL_VERSION, TREASURE_COMPOSE_HONOR_POOL_VERSION,
  TREASURE_TRAINING_POOL_VERSION, TREASURE_SECOND_WEAPON_POOL_VERSION, TREASURE_NECKLACE_POOL_VERSION } from "../src/activities/treasure-catalog.js";
import type { TreasureState } from "../src/activities/treasure-native.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";
import { assertPublicActivityStates } from "./public-activity-state.js";

// Actual HTTP/auth/resource index, isolated PGlite and unaltered local source rows.
// Indexed 1px test icons prove only resource gating, never native-client/icon acceptance.
const observed=vi.hoisted(()=>({randomCalls:0,queries:[] as {sql:string;params:unknown[]}[]}));
vi.mock("node:crypto",async original=>({...await original<typeof import("node:crypto")>(),randomInt:()=>{observed.randomCalls++;return 0;}}));
vi.mock("../src/lib/db.js",async original=>{
  const actual=await original<typeof import("../src/lib/db.js")>(),{PgDialect}=await import("drizzle-orm/pg-core");
  return {...actual,q:async(...args:Parameters<typeof actual.q>)=>{
    const query=new PgDialect().sqlToQuery(args[1]);observed.queries.push(query);return actual.q(...args);
  }};
});
const fixture=JSON.parse(readFileSync(new URL("./fixtures/treasure-cardbox.json",import.meta.url),"utf8"));
const ids=TREASURE_CARD_BOX_IDS,entries=ids.map(id=>TREASURE_ENTRIES.find(row=>row.templateId===id)!);
const versions=[TREASURE_PREVIOUS_POOL_VERSION,TREASURE_DRILL_POOL_VERSION,TREASURE_STRENGTHEN_POOL_VERSION,TREASURE_COMPOSE_HONOR_POOL_VERSION,
  TREASURE_TRAINING_POOL_VERSION,TREASURE_SECOND_WEAPON_POOL_VERSION,TREASURE_NECKLACE_POOL_VERSION,TREASURE_POOL_VERSION];
const tmp=mkdtempSync(join(tmpdir(),"ddt-treasure-cardbox-")),uid=734,secret="treasure-cardbox-tests-only";
const config={NODE_ENV:"test" as const,DB_MIGRATE:false,DB_SEED_IF_EMPTY:false,JWT_SECRET:secret,RSA_USE_VENDOR_KEY:false,RSA_PRIVATE_KEY:"",GAME_INTERNAL_URL:"",
  FLASH_DIR:join(tmp,"flash"),FLASH_OVERLAY_DIR:"",RESOURCE_DIR:join(tmp,"resource"),UPLOAD_DIR:join(tmp,"uploads"),REQUEST_SNAPSHOT_DIR:join(tmp,"snapshots"),RUFFLE_DIR:join(tmp,"ruffle"),CELEB_REBUILD_MIN:0};
let h:DbHandle,built:Awaited<ReturnType<typeof buildApp>>,materials:typeof game.Shop_Goods.$inferSelect[];
const headers=()=>({authorization:`Bearer ${signJwt({sub:1,name:"treasure-cardbox-test",role:"player"},secret,3600)}`});
const post=(action:ActivityAction,requestId=randomUUID())=>built.app.inject({method:"POST",url:"/api/account/activities/treasure-native/action",headers:headers(),payload:{characterId:uid,requestId,action}});
function publicResult(value:ActivityResult){assertPublicActivityStates(value);expect(JSON.stringify(value)).not.toMatch(/"(?:games|seed|choices|cardConfig|boxRewards)":/);return value;}
async function native(action:ActivityAction,id=randomUUID(),status=200){const r=await post(action,id);expect(r.statusCode,r.body).toBe(status);return publicResult(r.json<ActivityResult>());}
async function snapshot(){const r=await built.app.inject({url:`/api/account/activities?characterId=${uid}`,headers:headers()});expect(r.statusCode,r.body).toBe(200);return publicResult(r.json<ActivityResult>());}
async function persisted(){return {wallet:await q(h,sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states:await q(h,sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),receipts:await q(h,sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods:await q(h,sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),mails:await q(h,sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`)};}
async function store(state:ActivityState){await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(state)}::jsonb)
  ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);}
function oldBag(){
  const treasure:Omit<TreasureState,"tickets">={version:2,bag:entries.map((row,i)=>({templateId:row.templateId,count:row.count,validDays:0,origin:"original-catalog",
    entryKey:row.entryKey,sourceOriginalIndex:row.sourceOriginalIndex,poolVersion:versions[i%versions.length]})),draws:10,score:20,fragments:10,pity:8,choices:[PRIZES[0].name],claimed:[]};
  const state:ActivityState={version:1,day:"2026-10-16",daily:{},completed:{treasure:10},claims:[],history:[],games:{treasure}};return {state,treasure};
}
function assertLocks(expectedIds:readonly number[],delivered=false,dependencies=true){
  const locks=observed.queries.filter(row=>row.sql.includes('FROM game."Shop_Goods"')&&row.sql.trim().endsWith("FOR SHARE"));
  expect(locks.map(row=>row.params.map(Number))).toEqual(dependencies?[expectedIds,TREASURE_CARD_IDS]:[expectedIds]);
  const configLock=observed.queries.findIndex(row=>row.sql==='LOCK TABLE game."Card_Group",game."Card_Buff",game."CardUpdateCondition",game."CardUpdateInfo" IN SHARE MODE');
  expect(configLock).toBeGreaterThanOrEqual(0);
  const rereads=["Card_Group","Card_Buff","CardUpdateCondition","CardUpdateInfo"].map(table=>
    observed.queries.findIndex((row,index)=>index>configLock&&row.sql.includes(`FROM game."${table}"`)));
  for(const index of rereads)if(dependencies)expect(index).toBeGreaterThan(configLock);else expect(index).toBe(-1);
  for(const query of locks)expect(observed.queries.indexOf(query)).toBeGreaterThan(configLock);
  const firstAttachment=observed.queries.findIndex(row=>row.sql.includes('INSERT INTO player."Sys_Users_Goods"'));
  if(delivered)expect(firstAttachment).toBeGreaterThan(Math.max(...rereads,...locks.map(row=>observed.queries.indexOf(row))));
  else expect(firstAttachment).toBe(-1);
}
beforeAll(async()=>{
  materials=fixture.goods.map((row:Record<string,unknown>)=>({...row,AddTime:row.AddTime===null?null:new Date(`${row.AddTime}Z`)}));
  for(const row of entries){const dir=join(config.RESOURCE_DIR,"image","cardbox",row.pic);mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,"icon.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==","base64"));}
  h=await createDb("pglite:memory");await migrateDb(h);built=await buildApp({db:h,logger:false,skipTemplates:true,env:{},config});
});
beforeEach(async()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));observed.randomCalls=0;observed.queries=[];
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages",
    game."Shop_Goods",game."Card_Group",game."Card_Buff",game."CardUpdateCondition",game."CardUpdateInfo"`);
  await h.db.insert(game.Shop_Goods).values(materials);await h.db.insert(game.Card_Group).values(fixture.groups);await h.db.insert(game.Card_Buff).values(fixture.buffs);
  await h.db.insert(game.CardUpdateCondition).values(fixture.conditions);await h.db.insert(game.CardUpdateInfo).values(fixture.updates);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'treasure-cardbox-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst") VALUES (${uid},'treasure-cardbox-test','Treasure cardbox test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(()=>vi.useRealTimers());
afterAll(async()=>{await built?.app.close();await h?.close();const root=realpathSync(tmpdir()),target=realpathSync(tmp),part=relative(root,target);
  if(!part||part.startsWith("..")||isAbsolute(part))throw Error("Unsafe temporary test directory");rmSync(target,{recursive:true,force:true});});

describe("nine source card boxes treasure admission",()=>{
  it("delivers all nine from mixed v1-v7/current bags, keeps their token and committed take UUID, and emits only mail attachments",async()=>{
    expect(TREASURE_NECKLACE_POOL_VERSION).toBe("a8cd548f7462ac10441245fbaf073f6a02f62f5e072b903fc5f140ceb5eec3c3");
    const {state,treasure}=oldBag();await store(state);const before=await persisted(),view=await snapshot();
    const token="2026-10-16:"+createHash("sha256").update(JSON.stringify(treasure)).digest("base64url");
    expect(view.nativeTreasure).toMatchObject({poolVersion:TREASURE_POOL_VERSION,bagToken:token,canTake:true,bagSlotsUsed:9,readiness:{status:"blocked",totalRows:158,readyRows:9}});
    expect(view.nativeTreasure.preview).toHaveLength(158);expect(view.nativeTreasure.categories.filter(row=>row.selectable)).toHaveLength(14);expect(await persisted()).toEqual(before);
    observed.queries=[];const action={type:"take",choice:token},id=randomUUID(),taken=await native(action,id);
    expect(taken).toMatchObject({points:1000,earned:40,revision:1,mailedCount:2,nativeCharge:{grossSpent:0},nativeTreasure:{bag:[],draws:10,progressScore:20,fragments:10}});
    assertLocks(ids,true);const final=await persisted();expect(final.goods.map(row=>[row.TemplateID,row.Count,row.IsBinds,row.ValidDate])).toEqual(ids.map(id=>[id,1,true,0]));expect(final.mails).toHaveLength(2);
    // A later configuration failure cannot revoke a committed UUID or duplicate its two mails.
    await h.db.delete(game.Card_Buff);for(let i=0;i<2;i++){expect((await native(action,id)).replayed).toBe(true);expect(await persisted()).toEqual(final);}
    await native({...action,index:0},id,409);expect(await persisted()).toEqual(final);expect(observed.randomCalls).toBe(0);
    expect(await h.db.select().from(game.Shop_Goods).orderBy(game.Shop_Goods.TemplateID)).toEqual(materials);
  });
  it.each(ids)("rechecks box %i under lock after preview and permits its rejected UUID after exact repair",async templateId=>{
    const {state}=oldBag();await store(state);const view=await snapshot(),index=ids.indexOf(templateId),original=materials.find(row=>row.TemplateID===templateId)!;
    const before=await persisted(),action={type:"take",index,choice:view.nativeTreasure.bagToken},id=randomUUID();
    await h.db.update(game.Shop_Goods).set({Property5:original.Property5+1}).where(sql`${game.Shop_Goods.TemplateID}=${templateId}`);
    observed.queries=[];expect((await native(action,id,503)).message).toBe("寻宝原目录奖励暂不可交付，请保留临时包。");assertLocks([templateId],false,false);expect(await persisted()).toEqual(before);
    await h.db.update(game.Shop_Goods).set(original).where(sql`${game.Shop_Goods.TemplateID}=${templateId}`);
    expect((await snapshot()).nativeTreasure.bagToken).toBe(view.nativeTreasure.bagToken);
    expect(await native(action,id)).toMatchObject({points:1000,revision:1,mailedCount:1,nativeTreasure:{bagSlotsUsed:8}});expect(observed.randomCalls).toBe(0);
  });
  it("requires every genuine dependent card and its combat identity instead of merely an existing P5 target",async()=>{
    const {state}=oldBag();await store(state);const view=await snapshot(),before=await persisted();
    for(const templateId of TREASURE_CARD_IDS){
      const original=materials.find(row=>row.TemplateID===templateId)!;await h.db.delete(game.Shop_Goods).where(sql`${game.Shop_Goods.TemplateID}=${templateId}`);
      const action={type:"take",choice:view.nativeTreasure.bagToken},id=randomUUID();observed.queries=[];await native(action,id,503);assertLocks(ids);expect(await persisted()).toEqual(before);
      await h.db.insert(game.Shop_Goods).values({...original,Attack:original.Attack+1});observed.queries=[];await native(action,id,503);assertLocks(ids);expect(await persisted()).toEqual(before);
      await h.db.update(game.Shop_Goods).set(original).where(sql`${game.Shop_Goods.TemplateID}=${templateId}`);
    }
    expect((await snapshot()).nativeTreasure.bagToken).toBe(view.nativeTreasure.bagToken);expect(observed.randomCalls).toBe(0);
  });
  it.each(["Card_Group","Card_Buff","CardUpdateCondition","CardUpdateInfo"] as const)("rejects changed/missing/extra %s configuration without any entitlement or wallet write",async table=>{
    const {state}=oldBag();await store(state);const view=await snapshot(),before=await persisted(),action={type:"take",choice:view.nativeTreasure.bagToken},id=randomUUID();
    const original=table==="Card_Group"?fixture.groups[0]:table==="Card_Buff"?fixture.buffs[0]:table==="CardUpdateCondition"?fixture.conditions[0]:fixture.updates[0];
    if(table==="Card_Group")await h.db.execute(sql`UPDATE game."Card_Group" SET "TemplateID"="TemplateID"+1 WHERE "ID"=${original.ID}`);
    if(table==="Card_Buff")await h.db.execute(sql`UPDATE game."Card_Buff" SET "value"='999|999|999|999' WHERE "ID"=${original.ID}`);
    if(table==="CardUpdateCondition")await h.db.execute(sql`UPDATE game."CardUpdateCondition" SET "MaxExp"="MaxExp"+1 WHERE "Level"=${original.Level}`);
    if(table==="CardUpdateInfo")await h.db.execute(sql`UPDATE game."CardUpdateInfo" SET "Attack"="Attack"+1 WHERE "Id"=${original.Id} AND "Level"=${original.Level}`);
    observed.queries=[];await native(action,id,503);assertLocks(ids);expect(await persisted()).toEqual(before);
    if(table==="Card_Group"){await h.db.delete(game.Card_Group).where(sql`${game.Card_Group.ID}=${original.ID}`);await native(action,id,503);await h.db.insert(game.Card_Group).values(original);await h.db.insert(game.Card_Group).values({...original,ID:999999});}
    if(table==="Card_Buff"){await h.db.delete(game.Card_Buff).where(sql`${game.Card_Buff.ID}=${original.ID}`);await native(action,id,503);await h.db.insert(game.Card_Buff).values(original);await h.db.insert(game.Card_Buff).values({...original,ID:999999,condition:0});}
    if(table==="CardUpdateCondition"){await h.db.delete(game.CardUpdateCondition).where(sql`${game.CardUpdateCondition.Level}=${original.Level}`);await native(action,id,503);await h.db.insert(game.CardUpdateCondition).values(original);await h.db.insert(game.CardUpdateCondition).values({...original,Level:32});}
    if(table==="CardUpdateInfo"){await h.db.delete(game.CardUpdateInfo).where(sql`${game.CardUpdateInfo.Id}=${original.Id} AND ${game.CardUpdateInfo.Level}=${original.Level}`);await native(action,id,503);await h.db.insert(game.CardUpdateInfo).values(original);await h.db.insert(game.CardUpdateInfo).values({...original,Level:31});}
    expect(await persisted()).toEqual(before);observed.queries=[];await native(action,id,503);assertLocks(ids);expect(await persisted()).toEqual(before);expect(observed.randomCalls).toBe(0);
  });
  it("keeps all new spending blocked for v1-v7 and the current incomplete full pool, including ticket funding and advanced choices",async()=>{
    const {state}=oldBag();await store(state);const view=await snapshot(),before=await persisted();
    for(const poolVersion of versions)for(const mode of ["normal","advanced"] as const){
      const draw:ActivityAction={type:"draw",mode,count:1,poolVersion,choice:view.nativeTreasure.bagToken,selection:mode==="normal"?[]:[4,1,12,7]};
      for(const action of [draw,{...draw,funding:"tickets" as const},{type:"buy-tickets",mode,count:1,poolVersion,choice:view.nativeTreasure.bagToken}]){
        const r=await native(action,randomUUID(),400);expect(r.message).toMatch(poolVersion===TREASURE_POOL_VERSION?/完整奖池尚有149条未就绪/:/原奖池版本已更新/);expect(await persisted()).toEqual(before);
      }
    }
    expect(observed.randomCalls).toBe(0);
    const locks=observed.queries.filter(row=>row.sql.includes('FROM game."Shop_Goods"')&&row.sql.trim().endsWith("FOR SHARE"));
    expect(locks.map(row=>row.params.map(Number))).toEqual(Array.from({length:48},()=>[TREASURE_IDS,TREASURE_CARD_IDS]).flat());
  });
  it("replays an already committed v7 draw UUID without revalidation, spending or another grant",async()=>{
    const {state,treasure}=oldBag();for(const row of treasure.bag)row.poolVersion=TREASURE_NECKLACE_POOL_VERSION;await store(state);
    const action:ActivityAction={choice:"2026-10-16:"+"a".repeat(43),count:1,mode:"normal",poolVersion:TREASURE_NECKLACE_POOL_VERSION,selection:[],type:"draw"};
    const id=randomUUID(),signature=createHash("sha256").update(JSON.stringify({action,activityId:"treasure-native"})).digest("hex");
    await h.db.execute(sql`INSERT INTO app."ActivityActions" ("UserID","RequestID","Signature","Result") VALUES (${uid},${id},${signature},${JSON.stringify({message:"既有v7抽取已提交",mailedCount:0})}::jsonb)`);
    await h.db.delete(game.Card_Group);const before=await persisted();observed.queries=[];
    expect(await native(action,id)).toMatchObject({replayed:true,message:"既有v7抽取已提交",mailedCount:0,points:1000,revision:0,nativeTreasure:{bagSlotsUsed:9,readiness:{status:"blocked",readyRows:0}}});
    expect(await persisted()).toEqual(before);expect(observed.randomCalls).toBe(0);expect(observed.queries.some(row=>row.sql.includes("FOR SHARE"))).toBe(false);
  });
});
