import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { TREASURE_DRILL_POOL_VERSION, TREASURE_ENTRIES, TREASURE_IDS, TREASURE_POOL_VERSION, TREASURE_PREVIOUS_POOL_VERSION,
  TREASURE_STRENGTHEN_POOL_VERSION, TREASURE_COMPOSE_HONOR_POOL_VERSION, TREASURE_TRAINING_POOL_VERSION,
  TREASURE_SECOND_WEAPON_POOL_VERSION, TREASURE_NECKLACE_POOL_VERSION, TREASURE_CARD_BOX_POOL_VERSION } from "../src/activities/treasure-catalog.js";
import type { TreasureState } from "../src/activities/treasure-native.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";
import { assertPublicActivityStates } from "./public-activity-state.js";

// Actual HTTP/auth/source rows, indexed test PNGs, PGlite transactions and mail attachments.
// The 1px files exercise resource gates only; no actual icon/native-client acceptance is claimed.
const observed=vi.hoisted(()=>({randomCalls:0,queries:[] as {sql:string;params:unknown[]}[]}));
vi.mock("node:crypto",async original=>({...await original<typeof import("node:crypto")>(),randomInt:()=>{observed.randomCalls++;return 0;}}));
vi.mock("../src/lib/db.js",async original=>{
  const actual=await original<typeof import("../src/lib/db.js")>(),{PgDialect}=await import("drizzle-orm/pg-core");
  return {...actual,q:async(...args:Parameters<typeof actual.q>)=>{const rows=await actual.q(...args);observed.queries.push(new PgDialect().sqlToQuery(args[1]));return rows;}};
});
const fixture=JSON.parse(readFileSync(new URL("./fixtures/treasure-jewelry.json",import.meta.url),"utf8"));
const ids=[8514,9523],entries=ids.map(id=>TREASURE_ENTRIES.find(row=>row.templateId===id)!);
const versions=[TREASURE_PREVIOUS_POOL_VERSION,TREASURE_DRILL_POOL_VERSION,TREASURE_STRENGTHEN_POOL_VERSION,TREASURE_COMPOSE_HONOR_POOL_VERSION,
  TREASURE_TRAINING_POOL_VERSION,TREASURE_SECOND_WEAPON_POOL_VERSION,TREASURE_NECKLACE_POOL_VERSION,TREASURE_CARD_BOX_POOL_VERSION,TREASURE_POOL_VERSION];
const tmp=mkdtempSync(join(tmpdir(),"ddt-treasure-jewelry-")),uid=735,secret="treasure-jewelry-tests-only";
const config={NODE_ENV:"test" as const,DB_MIGRATE:false,DB_SEED_IF_EMPTY:false,JWT_SECRET:secret,RSA_USE_VENDOR_KEY:false,RSA_PRIVATE_KEY:"",GAME_INTERNAL_URL:"",
  FLASH_DIR:join(tmp,"flash"),FLASH_OVERLAY_DIR:"",RESOURCE_DIR:join(tmp,"resource"),UPLOAD_DIR:join(tmp,"uploads"),REQUEST_SNAPSHOT_DIR:join(tmp,"snapshots"),RUFFLE_DIR:join(tmp,"ruffle"),CELEB_REBUILD_MIN:0};
let h:DbHandle,built:Awaited<ReturnType<typeof buildApp>>,materials:typeof game.Shop_Goods.$inferSelect[];
const headers=()=>({authorization:`Bearer ${signJwt({sub:1,name:"treasure-jewelry-test",role:"player"},secret,3600)}`});
const post=(action:ActivityAction,requestId=randomUUID())=>built.app.inject({method:"POST",url:"/api/account/activities/treasure-native/action",headers:headers(),payload:{characterId:uid,requestId,action}});
function publicResult(value:ActivityResult){assertPublicActivityStates(value);expect(JSON.stringify(value)).not.toMatch(/"(?:games|seed|choices|cardConfig|boxRewards)":/);return value;}
async function native(action:ActivityAction,id=randomUUID(),status=200){const r=await post(action,id);expect(r.statusCode,r.body).toBe(status);return publicResult(r.json<ActivityResult>());}
async function snapshot(){const r=await built.app.inject({url:`/api/account/activities?characterId=${uid}`,headers:headers()});expect(r.statusCode,r.body).toBe(200);return publicResult(r.json<ActivityResult>());}
async function persisted(){return {wallet:await q(h,sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),states:await q(h,sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts:await q(h,sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),goods:await q(h,sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),mails:await q(h,sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`)};}
async function store(state:ActivityState){await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(state)}::jsonb)
  ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);}
function oldBag(poolVersion=TREASURE_POOL_VERSION){
  const treasure:Omit<TreasureState,"tickets">={version:2,bag:entries.map(row=>({templateId:row.templateId,count:row.count,validDays:0,origin:"original-catalog",entryKey:row.entryKey,
    sourceOriginalIndex:row.sourceOriginalIndex,poolVersion})),draws:10,score:20,fragments:10,pity:8,choices:[PRIZES[0].name],claimed:[]};
  const state:ActivityState={version:1,day:"2026-10-16",daily:{},completed:{treasure:10},claims:[],history:[],games:{treasure}};return {state,treasure};
}
function assertLocks(expectedIds:readonly number[],delivered=false){
  const locks=observed.queries.filter(row=>row.sql.includes('FROM game."Shop_Goods"')&&row.sql.trim().endsWith("FOR SHARE"));
  expect(locks.map(row=>row.params.map(Number))).toEqual([expectedIds]);
  const firstAttachment=observed.queries.findIndex(row=>row.sql.includes('INSERT INTO player."Sys_Users_Goods"'));
  if(delivered)expect(firstAttachment).toBeGreaterThan(observed.queries.indexOf(locks[0]!));else expect(firstAttachment).toBe(-1);
}
function assertAttachments(rows:Record<string,unknown>[],expected=ids){
  expect(rows.map(row=>[row.TemplateID,row.Count,row.StrengthenLevel,row.IsBinds,row.ValidDate,row.AttackCompose,row.DefendCompose,row.AgilityCompose,row.LuckCompose,row.IsUsed]))
    .toEqual(expected.map(id=>[id,1,0,true,0,0,0,0,0,false]));
}
beforeAll(async()=>{
  materials=fixture.goods.map((row:Record<string,unknown>)=>({...row,AddTime:row.AddTime===null?null:new Date(`${row.AddTime}Z`)}));
  for(const row of entries){const dir=join(config.RESOURCE_DIR,"image","equip",row.categoryId===8?"armlet":"ring",row.pic);mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,"icon.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==","base64"));}
  h=await createDb("pglite:memory");await migrateDb(h);built=await buildApp({db:h,logger:false,skipTemplates:true,env:{},config});
});
beforeEach(async()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));observed.randomCalls=0;observed.queries=[];
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS treasure_jewelry_mail_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages",game."Shop_Goods"`);
  await h.db.insert(game.Shop_Goods).values(materials);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'treasure-jewelry-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst") VALUES (${uid},'treasure-jewelry-test','Treasure jewelry test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(()=>vi.useRealTimers());
afterAll(async()=>{await built?.app.close();await h?.close();const root=realpathSync(tmpdir()),target=realpathSync(tmp),part=relative(root,target);
  if(!part||part.startsWith("..")||isAbsolute(part))throw Error("Unsafe temporary test directory");rmSync(target,{recursive:true,force:true});});

describe("original suitless jewelry treasure entitlements",()=>{
  it.each(versions)("delivers both exact original templates from policy %s at Strengthen0 and preserves token/UUID rights",async poolVersion=>{
    expect(TREASURE_CARD_BOX_POOL_VERSION).toBe("a60b589ef43fe36fea9ebb9e6187d4dffb31db7344424f67c1b86b39024990c2");
    const {state,treasure}=oldBag(poolVersion);await store(state);const before=await persisted(),view=await snapshot();
    const token="2026-10-16:"+createHash("sha256").update(JSON.stringify(treasure)).digest("base64url");
    expect(view.nativeTreasure).toMatchObject({poolVersion:TREASURE_POOL_VERSION,bagToken:token,canTake:true,bagSlotsUsed:2,readiness:{status:"blocked",totalRows:158,readyRows:2}});
    expect(view.nativeTreasure.preview).toHaveLength(158);expect(view.nativeTreasure.categories.filter(row=>row.selectable)).toHaveLength(14);expect(await persisted()).toEqual(before);
    observed.queries=[];const action={type:"take",choice:token},id=randomUUID(),taken=await native(action,id);assertLocks(ids,true);
    expect(taken).toMatchObject({points:1000,earned:40,revision:1,mailedCount:1,nativeCharge:{grossSpent:0},nativeTreasure:{bag:[],draws:10,progressScore:20,fragments:10}});
    const final=await persisted();assertAttachments(final.goods);expect(final.mails).toHaveLength(1);
    await h.db.delete(game.Shop_Goods).where(sql`${game.Shop_Goods.TemplateID}=8514`);
    expect((await native(action,id)).replayed).toBe(true);expect(await persisted()).toEqual(final);await native({...action,index:0},id,409);expect(await persisted()).toEqual(final);expect(observed.randomCalls).toBe(0);
  });
  it.each(ids)("rechecks every selected jewelry %i field after preview under its original row lock and repairs the same rejected UUID",async templateId=>{
    const {state}=oldBag(TREASURE_CARD_BOX_POOL_VERSION);await store(state);const view=await snapshot(),index=ids.indexOf(templateId),original=materials.find(row=>row.TemplateID===templateId)!;
    const before=await persisted(),fields=["CategoryID","Pic","NeedSex","NeedLevel","MaxCount","CanEquip","CanUse","CanStrengthen","CanCompose","Level","Quality","Attack","Defence","Agility","Luck","SuitId",...Array.from({length:8},(_,i)=>`Property${i+1}`)];
    expect(fields).toHaveLength(24);
    for(const field of fields){const value=Reflect.get(original,field),patch={[field]:typeof value==="number"?value+1:typeof value==="boolean"?!value:`${value}-changed`};
      await h.db.update(game.Shop_Goods).set(patch).where(sql`${game.Shop_Goods.TemplateID}=${templateId}`);observed.queries=[];
      expect((await native({type:"take",index,choice:view.nativeTreasure.bagToken},randomUUID(),503)).message).toBe("寻宝原目录奖励暂不可交付，请保留临时包。");
      assertLocks([templateId]);expect(await persisted()).toEqual(before);await h.db.update(game.Shop_Goods).set(original).where(sql`${game.Shop_Goods.TemplateID}=${templateId}`);
    }
    await h.db.delete(game.Shop_Goods).where(sql`${game.Shop_Goods.TemplateID}=${templateId}`);const action={type:"take",index,choice:view.nativeTreasure.bagToken},id=randomUUID();observed.queries=[];
    await native(action,id,503);assertLocks([templateId]);expect(await persisted()).toEqual(before);
    await h.db.insert(game.Shop_Goods).values(original);expect((await snapshot()).nativeTreasure.bagToken).toBe(view.nativeTreasure.bagToken);
    observed.queries=[];expect(await native(action,id)).toMatchObject({revision:1,points:1000,mailedCount:1,nativeTreasure:{bagSlotsUsed:1}});assertLocks([templateId],true);
    const final=await persisted();assertAttachments(final.goods,[templateId]);expect((await native(action,id)).replayed).toBe(true);expect(await persisted()).toEqual(final);expect(observed.randomCalls).toBe(0);
  });
  it("keeps all nine Pic conflicts and the unsupported suit57 entitlement blocked without remapping or normalizing its bag",async()=>{
    for(const templateId of [8515,9526,8516,9527,8517,9528,8520,9535,8538,9538]){
      const {state,treasure}=oldBag(TREASURE_CARD_BOX_POOL_VERSION),entry=TREASURE_ENTRIES.find(row=>row.templateId===templateId)!;
      treasure.bag=[{...treasure.bag[0]!,templateId,count:entry.count,entryKey:entry.entryKey,sourceOriginalIndex:entry.sourceOriginalIndex}];await store(state);
      const before=await persisted(),view=await snapshot();observed.queries=[];await native({type:"take",choice:view.nativeTreasure.bagToken},randomUUID(),503);assertLocks([templateId]);
      expect(await persisted()).toEqual(before);expect(observed.randomCalls).toBe(0);
    }
    expect(await h.db.select().from(game.Shop_Goods).orderBy(game.Shop_Goods.TemplateID)).toEqual(materials);
  });
  it("rejects all v1-v8 and current new spending while retaining the full158 pool and advanced four-of14 contract",async()=>{
    const {state}=oldBag();await store(state);const view=await snapshot(),before=await persisted();
    for(const poolVersion of versions)for(const mode of ["normal","advanced"] as const){
      const draw:ActivityAction={type:"draw",mode,count:1,poolVersion,choice:view.nativeTreasure.bagToken,selection:mode==="normal"?[]:[4,1,12,7]};
      for(const action of [draw,{...draw,funding:"tickets" as const},{type:"buy-tickets",mode,count:1,poolVersion,choice:view.nativeTreasure.bagToken}]){
        const r=await native(action,randomUUID(),400);expect(r.message).toMatch(poolVersion===TREASURE_POOL_VERSION?/完整奖池尚有156条未就绪/:/原奖池版本已更新/);expect(await persisted()).toEqual(before);
      }
    }
    expect(observed.randomCalls).toBe(0);expect(observed.queries.filter(row=>row.sql.includes('FROM game."Shop_Goods"')&&row.sql.trim().endsWith("FOR SHARE")).map(row=>row.params.map(Number)))
      .toEqual(Array.from({length:54},()=>TREASURE_IDS));
  });
  it("replays an already committed v8 draw UUID after the v9 admission change without new spending or grant",async()=>{
    const {state}=oldBag(TREASURE_CARD_BOX_POOL_VERSION);await store(state);
    const action:ActivityAction={choice:"2026-10-16:"+"a".repeat(43),count:1,mode:"normal",poolVersion:TREASURE_CARD_BOX_POOL_VERSION,selection:[],type:"draw"};
    const id=randomUUID(),signature=createHash("sha256").update(JSON.stringify({action,activityId:"treasure-native"})).digest("hex");
    await h.db.execute(sql`INSERT INTO app."ActivityActions" ("UserID","RequestID","Signature","Result") VALUES (${uid},${id},${signature},${JSON.stringify({message:"既有v8抽取已提交",mailedCount:0})}::jsonb)`);
    await h.db.delete(game.Shop_Goods).where(sql`${game.Shop_Goods.TemplateID}=8514`);const before=await persisted();observed.queries=[];
    expect(await native(action,id)).toMatchObject({replayed:true,message:"既有v8抽取已提交",mailedCount:0,points:1000,revision:0,nativeTreasure:{poolVersion:TREASURE_POOL_VERSION,bagSlotsUsed:2}});
    expect(await persisted()).toEqual(before);expect(observed.randomCalls).toBe(0);expect(observed.queries.some(row=>row.sql.includes("FOR SHARE"))).toBe(false);
  });
  it("rolls back both real attachment inserts on mail failure, then retries the same UUID once after repair",async()=>{
    const {state}=oldBag(TREASURE_CARD_BOX_POOL_VERSION);await store(state);const view=await snapshot(),before=await persisted(),action={type:"take",choice:view.nativeTreasure.bagToken},id=randomUUID();
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT treasure_jewelry_mail_failure CHECK ("ReceiverID"<>735)`);
    observed.queries=[];const failed=await post(action,id);expect(failed.statusCode,failed.body).toBe(500);assertLocks(ids,true);expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT treasure_jewelry_mail_failure`);
    expect(await native(action,id)).toMatchObject({revision:1,points:1000,mailedCount:1,nativeTreasure:{bagSlotsUsed:0}});
    const final=await persisted();assertAttachments(final.goods);expect(final.mails).toHaveLength(1);expect((await native(action,id)).replayed).toBe(true);expect(await persisted()).toEqual(final);expect(observed.randomCalls).toBe(0);
  });
});
