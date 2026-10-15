import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { createActivityState } from "../src/activities/engine.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// Isolated authenticated HTTP + real PGlite transactions/mail. No live service or DB.
const tmp = mkdtempSync(join(tmpdir(), "ddt-first-recharge-native-"));
const uid = 881, friend = 882, third = 883, secret = "first-recharge-native-tests-only";
const account = (id: number) => id - 880;
const username = (id: number) => `first-native-${id}`;
const nickname = (id: number) => `Local friend ${id}`;
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp,"flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp,"resource"),
  UPLOAD_DIR: join(tmp,"uploads"), REQUEST_SNAPSHOT_DIR: join(tmp,"snapshots"), RUFFLE_DIR: join(tmp,"ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = (id = uid) => ({ authorization: `Bearer ${signJwt({ sub: account(id), name: username(id), role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, who = uid, requestId = randomUUID()) => built.app.inject({ method: "POST",
  url: `/api/account/activities/${id}/action`, headers: headers(who), payload: { characterId: who, requestId, action } });
async function snapshot(who = uid) {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${who}`, headers: headers(who) });
  expect(response.statusCode,response.body).toBe(200); expect(response.body).not.toMatch(/"(?:origin|games|state|seed)"\s*:/);
  const result = response.json<ActivityResult>(); expect(result.nativeFirstRechargeAction).toBeUndefined(); return result;
}
async function native(value: ActivityAction, who = uid, requestId = randomUUID(), status = 200) {
  const action = value.choice === undefined ? { ...value, choice: (await snapshot(who)).nativeFirstRecharge.stateToken } : value;
  const response = await post("first-recharge-native",action,who,requestId); expect(response.statusCode,response.body).toBe(status);
  expect(response.body).not.toMatch(/"(?:origin|games|state|seed)"\s*:/); return response.json<ActivityResult>();
}
const saved = async (who = uid) => (await q1<{State:ActivityState}>(h,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${who} AND "Activity"='reference'`))?.State;
async function persisted() { return {
  wallets: await q(h,sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`), states: await q(h,sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h,sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`), goods: await q(h,sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h,sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
const card = (result: ActivityResult, tier: number) => result.nativeFirstRecharge.cards.cards.find(c=>c.kind===tier)!;
beforeAll(async()=>{
  h=await createDb("pglite:memory"); await migrateDb(h);
  const template: typeof game.Shop_Goods.$inferInsert = { TemplateID:11019,Name:"Material",CanRecycle:0,CategoryID:11,
    Attack:12,Defence:13,Agility:14,Luck:15,Level:1,Quality:1,MaxCount:2,NeedSex:0,NeedLevel:1,
    CanStrengthen:false,CanCompose:false,CanDrop:true,CanEquip:false,CanUse:true,CanDelete:true,
    Property1:0,Property2:0,Property3:0,Property4:0,Property5:0,Property6:0,Property7:0,Property8:0,
    BindType:0,FusionType:0,FusionRate:0,FusionNeedRate:0,RefineryLevel:0,ReclaimValue:0,ReclaimType:0 };
  await h.db.insert(game.Shop_Goods).values(PRIZES.map(p=>({...template,TemplateID:p.templateId,Name:p.name}))); await rebuild();
});
beforeEach(async()=>{
  vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  await h.db.execute(sql`ALTER TABLE app."ActivityStates" DROP CONSTRAINT IF EXISTS first_native_recipient_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS first_native_receipt_failure`);
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS first_native_mail_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false,"MaxCount"=2`);
  for(const id of [uid,friend,third]) {
    await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (${account(id)},${username(id)},'tests-only')`);
    await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst") VALUES (${id},${username(id)},${nickname(id)},true,'2000-01-01',1)`);
    await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${id},${id===uid?1000:0},${id===uid?600:0})`);
  }
  const state=createActivityState(new Date()); state.completed.pair=1; state.games.existing={preserved:true};
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(state)}::jsonb)`);
});
afterEach(()=>vi.useRealTimers());
afterAll(async()=>{
  await built?.app.close(); await h?.close();
  const root=realpathSync(tmpdir()),target=realpathSync(tmp),part=relative(root,target);
  if(!part||part.startsWith("..")||isAbsolute(part))throw new Error("Unsafe temporary test directory");
  rmSync(target,{recursive:true,force:true});
});

describe("native first-recharge through atomic account HTTP",()=>{
  it("keeps GET pure and rejects foreign characters, unsupported fields, quantity edits and invalid card operations",async()=>{
    await h.db.execute(sql`DELETE FROM app."ActivityStates"`); await h.db.execute(sql`DELETE FROM app."ActivityWallet"`);
    const before=await persisted(),choice=(await snapshot()).nativeFirstRecharge.stateToken;
    expect((await built.app.inject({url:`/api/account/activities?characterId=${uid}`})).statusCode).toBe(401);
    expect((await built.app.inject({url:`/api/account/activities?characterId=${friend}`,headers:headers()})).statusCode).toBe(403);
    for(const value of [{type:"claim",tier:1,choice,price:0},{type:"buy",index:0,count:2,choice},
      {type:"issue-card",tier:4,choice},{type:"use-card",cardId:randomUUID(),choice}]) {
      const response=await post("first-recharge-native",value); expect([400,409]).toContain(response.statusCode);
    }
    expect((await post("first-gift",{type:"claim",cardId:randomUUID()})).statusCode).toBe(400);
    expect(await persisted()).toEqual(before);
  });

  it("shares historical first-gift and delivers each new tier once with fresh effects and replay recovery",async()=>{
    const old=await post("first-gift",{type:"claim"}); expect(old.statusCode,old.body).toBe(200);
    expect((await snapshot()).nativeFirstRecharge.tiers[0].claimed).toBe(true);
    await native({type:"claim",tier:1},uid,randomUUID(),409); await native({type:"issue-card",tier:1},uid,randomUUID(),409);
    const value={type:"claim",tier:2,choice:(await snapshot()).nativeFirstRecharge.stateToken},requestId=randomUUID();
    const claimed=await native(value,uid,requestId); expect(claimed).toMatchObject({earned:600,points:1000,mailedCount:2,nativeFirstRechargeAction:{requestId,effects:[{type:"claimed",tier:2}]}});
    const delivered=await persisted(); await built.app.close(); await rebuild();
    const replay=await native(value,uid,requestId); expect(replay.replayed).toBe(true); expect(replay.nativeFirstRechargeAction).toBeUndefined(); expect(await persisted()).toEqual(delivered);
    expect((await post("first-recharge-native",{...value,tier:3},uid,requestId)).statusCode).toBe(409);
    await native({type:"claim",tier:3}); const state=(await saved())!;
    expect(state.claims).toEqual(["first-gift","first-recharge-native:tier:2","first-recharge-native:tier:3"]); expect(state.games.existing).toEqual({preserved:true});
  });

  it("reserves without minting items and prevents old claim bypass before activation and after consumption",async()=>{
    const issued=await native({type:"issue-card",tier:1}),id=card(issued,1).cardId;
    expect(issued).toMatchObject({points:1000,earned:600,mailedCount:0}); expect((await persisted()).goods).toEqual([]);
    expect((await post("first-gift",{type:"claim"})).statusCode).toBe(409);
    await native({type:"claim",tier:1},uid,randomUUID(),409); await native({type:"issue-card",tier:1},uid,randomUUID(),409);
    expect((await native({type:"validate-card",cardId:id})).nativeFirstRechargeAction!.effects).toMatchObject([{type:"card-validated",valid:true}]);
    await native({type:"use-card",cardId:id}); const old=await post("first-gift",{type:"claim"}); expect(old.statusCode,old.body).toBe(200);
    const result=await snapshot(); expect(card(result,1).status).toBe("used"); expect(result.nativeFirstRecharge.tiers[0].claimed).toBe(true);
    await native({type:"claim",tier:1},uid,randomUUID(),409); expect((await persisted()).goods.map(g=>Number(g.TemplateID))).not.toContain(12772);
  });

  it("transfers one entitlement without forging recipient progress and replays after recipient rename without new writes",async()=>{
    const issued=await native({type:"issue-card",tier:2}),id=card(issued,2).cardId,requestId=randomUUID();
    const value={type:"gift-card",cardId:id,recipientName:nickname(friend),choice:issued.nativeFirstRecharge.stateToken};
    const sent=await native(value,uid,requestId); expect(sent.mailedCount).toBe(0); expect((await persisted()).goods).toEqual([]);
    const received=await snapshot(friend); expect(received).toMatchObject({earned:0,points:0}); expect(card(received,2)).toMatchObject({status:"owned",senderName:nickname(uid),canGift:false});
    await native({type:"gift-card",cardId:id,recipientName:nickname(third)},friend,randomUUID(),409);
    await native({type:"use-card",cardId:id},friend); const claim=await native({type:"claim",tier:2},friend);
    expect(claim).toMatchObject({earned:0,points:0,mailedCount:2}); expect((await saved(friend))!.completed).toEqual({});
    await native({type:"claim",tier:2},friend,randomUUID(),409); await native({type:"issue-card",tier:2},uid,randomUUID(),409);
    await h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "NickName"='Renamed friend' WHERE "UserID"=${friend}`);
    await h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "NickName"=${nickname(friend)} WHERE "UserID"=${third}`);
    await h.db.execute(sql`DELETE FROM app."ActivityWallet" WHERE "UserID"=${third}`);
    const before=await persisted(),replayed=await native(value,uid,requestId);
    expect(replayed.replayed).toBe(true); expect(replayed.nativeFirstRechargeAction).toBeUndefined(); expect(await persisted()).toEqual(before);
  });

  it("rolls back both roles on recipient-state and final-receipt failure then retries the same gift UUID",async()=>{
    const issued=await native({type:"issue-card",tier:2}),value={type:"gift-card",cardId:card(issued,2).cardId,recipientName:nickname(friend),choice:issued.nativeFirstRecharge.stateToken};
    const requestId=randomUUID(),before=await persisted();
    await h.db.execute(sql`ALTER TABLE app."ActivityStates" ADD CONSTRAINT first_native_recipient_failure CHECK ("UserID"<>882 OR ("State" #>> '{games,firstRechargeNativeV1,cardSlots,1,cardId}') IS NULL) NOT VALID`);
    await native(value,uid,requestId,500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityStates" DROP CONSTRAINT first_native_recipient_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT first_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    await native(value,uid,requestId,500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT first_native_receipt_failure`);
    await native(value,uid,requestId); expect(card(await snapshot(),2).status).toBe("gifted"); expect(card(await snapshot(friend),2).status).toBe("owned");
  });

  it("rolls back stacked material mail and receipt failures across five tables and retries one claim",async()=>{
    const value={type:"claim",tier:2,choice:(await snapshot()).nativeFirstRecharge.stateToken},requestId=randomUUID(),before=await persisted();
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT first_native_mail_failure CHECK ("Annex5" IS NOT NULL) NOT VALID`);
    await native(value,uid,requestId,500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT first_native_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT first_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    await native(value,uid,requestId,500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT first_native_receipt_failure`);
    expect((await native(value,uid,requestId)).mailedCount).toBe(2);
    expect((await persisted()).goods.map(g=>Number(g.Count))).toEqual([2,2,2,2,2,2,1]);
  });

  it("keeps fixed shop pricing and UTC caps while allowing card and reward settlement at daily500",async()=>{
    const state=(await saved())!; state.daily.actions=490;
    await h.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    for(let i=0;i<10;i++)await native({type:"buy",index:0,count:1});
    expect((await snapshot()).points).toBe(850); expect((await saved())!.daily.actions).toBe(500);
    await native({type:"buy",index:1,count:1},uid,randomUUID(),400);
    const issued=await native({type:"issue-card",tier:3}); await native({type:"use-card",cardId:card(issued,3).cardId}); await native({type:"claim",tier:3});
    expect((await saved())!.daily.actions).toBe(500);
    const late={type:"buy",index:1,count:1,choice:(await snapshot()).nativeFirstRecharge.stateToken};
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z")); await native(late,uid,randomUUID(),409);
    expect((await native({type:"buy",index:1,count:1})).points).toBe(830); expect((await saved())!.daily.actions).toBe(1);
  });
});
