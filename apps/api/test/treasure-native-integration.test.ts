import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { TREASURE_ENTRIES, TREASURE_IDS, TREASURE_POOL_VERSION } from "../src/activities/treasure-catalog.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// Actual HTTP/auth, shared treasure save, in-memory PGlite transaction, receipt and original mail.
// Date/RNG and completion of a template-lock await are controlled; no existing database or service is opened.
const random = vi.hoisted(() => ({ fraction: 0, calls: 0 }));
const futureTreasureEvidence = vi.hoisted(() => ({ ready: false, locks: [] as number[][] }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => { random.calls++; return max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)); } }));
vi.mock("../src/lib/db.js", async original => {
  const actual = await original<typeof import("../src/lib/db.js")>(), { PgDialect } = await import("drizzle-orm/pg-core");
  return { ...actual, q: async (...args: Parameters<typeof actual.q>) => {
    const rows = await actual.q(...args), query = new PgDialect().sqlToQuery(args[1]);
    if (query.sql.includes('FROM game."Shop_Goods"') && query.sql.trim().endsWith("FOR SHARE")) futureTreasureEvidence.locks.push(query.params.map(Number));
    return rows;
  } };
});
// Test-only future owner evidence: retain real identities/SQL/locks, never accept readiness from HTTP.
vi.mock("../src/activities/treasure-catalog.js", async original => {
  const actual = await original<typeof import("../src/activities/treasure-catalog.js")>();
  return { ...actual, inspectTreasureCatalog: (...args: Parameters<typeof actual.inspectTreasureCatalog>) => {
    const value = actual.inspectTreasureCatalog(...args);
    if (!futureTreasureEvidence.ready || args[0]?.length !== actual.TREASURE_IDS.length) return value;
    const simulated = new Set(["实际用途尚未核验", "装备属性或技能尚未核验", "官方武器属性与完整特效尚未通过交付核验", "本地图标尚未就绪"]);
    for (const row of value.preview) { row.reasons = row.reasons.filter(reason => !simulated.has(reason)); row.status = row.reasons.length ? "blocked" : "ready"; }
    const blocked = value.preview.filter(row => row.status === "blocked").map(row => ({ entryKey: row.entryKey, reasons: [...row.reasons] }));
    value.readiness = { status: blocked.length ? "blocked" : "ready", totalRows: 158, readyRows: 158 - blocked.length, blocked,
      description: blocked.length ? "完整奖池的真实模板身份尚未就绪。" : "Test-only future complete use and asset evidence" };
    return value;
  } };
});
const tmp = mkdtempSync(join(tmpdir(), "ddt-treasure-native-"));
const uid = 611, otherUid = 612, secret = "treasure-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
let templates: typeof game.Shop_Goods.$inferSelect[];
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "treasure-native-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId: string = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
const publicStates: Record<string, readonly string[]> = {
  "root.nativeChristmasSnowfield.scene": ["outside", "loading", "inside", "fighting", "settling"],
  "root.nativeChristmasSnowfield.attempt": ["none", "admitted", "launching", "fighting", "settling"],
  "root.nativeChristmasSnowfield.challenges[]": ["unavailable", "alive", "reserved", "fighting", "dead"],
};
function expectPublicActivityJson(value: unknown, path = "root"): void {
  if (Array.isArray(value)) { for (const item of value) expectPublicActivityJson(item, `${path}[]`); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "origin") { expect(path, "only declared treasure bag origins are public").toBe("root.nativeTreasure.bag[]");
      expect(["legacy-four-material", "original-catalog"]).toContain(child); }
    else expect(["games", "seed", "choices", "nativeTreasureEffects"], `${path}.${key} must remain private`).not.toContain(key);
    // Only the declared public snowfield enums may use "state"; raw saved state stays private.
    if (key === "state") expect(publicStates[path] ?? [], `${path}.state must be a public enum`).toContain(child);
    expectPublicActivityJson(child, `${path}.${key}`);
  }
}
async function action(id: string, value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(id, value, requestId); expect(response.statusCode, response.body).toBe(status);
  const result = response.json<ActivityResult>(); expectPublicActivityJson(result); return result;
}
const native = (value: ActivityAction, requestId: string = randomUUID(), status = 200) => action("treasure-native", value, requestId, status);
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<ActivityResult>(); expectPublicActivityJson(result); expect(result).not.toHaveProperty("nativeTreasureAction"); return result;
}
const saved = async () => (await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))?.State;
async function persisted() { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  const template: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "Material", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 2,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  await h.db.insert(game.Shop_Goods).values(PRIZES.map(prize => ({ ...template, TemplateID: prize.templateId, Name: prize.name })));
  const exp = TREASURE_ENTRIES.find(row => row.templateId === 11901)!, dir = join(config.RESOURCE_DIR,"image","unfrightprop",exp.pic);
  mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"icon.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==","base64"));
  templates = await h.db.select().from(game.Shop_Goods); await rebuild();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z")); random.fraction = 0; random.calls = 0;
  futureTreasureEvidence.ready = false; futureTreasureEvidence.locks = [];
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS treasure_native_mail_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS treasure_native_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.delete(game.Shop_Goods); await h.db.insert(game.Shop_Goods).values(templates);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'treasure-native-test','tests-only'),(2,'other-treasure-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'treasure-native-test','Treasure native test',true,'2000-01-01',1),(${otherUid},'other-treasure-test','Other test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});

async function futureReady() {
  const base=templates[0],unique=[...new Map(TREASURE_ENTRIES.map(row=>[row.templateId,row])).values()];
  await h.db.insert(game.Shop_Goods).values(unique.map(row=>({...base,TemplateID:row.templateId,Name:row.name,
    CategoryID:row.categoryId,Pic:row.pic,NeedSex:row.needSex,CanEquip:row.categoryId===7,
    Property1:[11560,11561,11562].includes(row.templateId)?10:[11901,11902,11903,11904,11906].includes(row.templateId)?21:0,Property2:300})))
    .onConflictDoUpdate({target:game.Shop_Goods.TemplateID,set:{Pic:sql`excluded."Pic"`,CategoryID:sql`excluded."CategoryID"`,NeedSex:sql`excluded."NeedSex"`}});
  futureTreasureEvidence.ready=true;
  expect((await q<{TemplateID:number}>(h,sql`SELECT "TemplateID" FROM game."Shop_Goods" WHERE "TemplateID" IN (${sql.join(TREASURE_IDS.map(id=>sql`${id}`),sql`,`)}) ORDER BY "TemplateID"`)).map(row=>row.TemplateID)).toEqual(TREASURE_IDS);
  expect((await snapshot()).nativeTreasure.readiness.status).toBe("ready");
}
const ticketPurchase = async (mode:"normal"|"advanced"="normal",count=1):Promise<ActivityAction> => ({type:"buy-tickets",mode,count,
  choice:(await snapshot()).nativeTreasure.bagToken,poolVersion:TREASURE_POOL_VERSION});
const ticketDraw = async (mode:"normal"|"advanced"="normal",count=1):Promise<ActivityAction> => ({type:"draw",mode,count,funding:"tickets",
  choice:(await snapshot()).nativeTreasure.bagToken,poolVersion:TREASURE_POOL_VERSION,selection:mode==="advanced"?[4,1,12,7]:[]});
function exp1Random(mode:"normal"|"advanced") {
  const candidates=TREASURE_ENTRIES.filter(row=>mode==="normal"||row.sourceOriginalIndex===15||[4,1,12,7].includes(row.sourceOriginalIndex));
  random.fraction=(candidates.findIndex(row=>row.templateId===11901)+0.1)/candidates.length;
}
async function store(state:ActivityState) {
  await h.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid} AND "Activity"='reference'`);
}

describe("treasure ticket HTTP transactions with explicit future-ready evidence",()=>{
  for(const mode of ["normal","advanced"] as const)it(`${mode} exchanges points once, deduplicates ticket draws and mails actual exp1 stacks`,async()=>{
    await futureReady();const buy=await ticketPurchase(mode,3),buyId=randomUUID(),cost=mode==="normal"?90:180;
    const bought=await Promise.all(Array.from({length:8},()=>native(buy,buyId)));
    expect(bought.filter(result=>!result.replayed)).toHaveLength(1);expect(bought.filter(result=>result.nativeTreasureAction)).toHaveLength(1);
    expect(random.calls).toBe(0);const state=(await saved())!;
    expect(state.games.treasure).toMatchObject({draws:0,score:0,fragments:0,tickets:{normal:mode==="normal"?3:0,advanced:mode==="advanced"?3:0}});
    expect(state.completed.treasure).toBeUndefined();expect(state.daily).toMatchObject({actions:1});expect(state.daily.draws??0).toBe(0);
    expect((await snapshot()).nativeCharge.grossSpent).toBe(cost);
    const value=await ticketDraw(mode,3),id=randomUUID();exp1Random(mode);
    const draws=await Promise.all(Array.from({length:8},()=>native(value,id)));
    expect(draws.filter(result=>!result.replayed)).toHaveLength(1);expect(draws.filter(result=>result.nativeTreasureAction)).toHaveLength(1);expect(random.calls).toBe(3);
    const fresh=draws.find(result=>!result.replayed)!;expect(fresh).toMatchObject({points:1000-cost,earned:40,nativeCharge:{grossSpent:cost},
      nativeTreasure:{draws:3,progressScore:mode==="normal"?3:6,fragments:3,tickets:{normal:0,advanced:0}},
      nativeTreasureAction:{effects:[{type:"drawn",cost:0,funding:"tickets",ticketsSpent:3,tickets:{normal:0,advanced:0}}]}});
    expect((await saved())!.daily).toMatchObject({actions:2,draws:3});expect((await saved())!.completed.treasure).toBe(1);
    expect(futureTreasureEvidence.locks).toEqual([TREASURE_IDS,TREASURE_IDS]);
    // Explicit public HTTP fixture for AS validation only; future-ready evidence is not production readiness.
    if(mode==="advanced"&&process.env.TREASURE_TICKETS_SNAPSHOT_OUTPUT)
      writeFileSync(process.env.TREASURE_TICKETS_SNAPSHOT_OUTPUT,JSON.stringify(fresh.nativeTreasure,null,2)+"\n");
    const take=await native({type:"take",choice:fresh.nativeTreasure.bagToken});expect(take).toMatchObject({points:1000-cost,mailedCount:2,nativeCharge:{grossSpent:cost},nativeTreasure:{bag:[]}});
    const delivered=await persisted();expect(delivered.goods.map(row=>[row.TemplateID,row.Count,row.IsBinds,row.ValidDate])).toEqual(Array.from({length:3},()=>[[11901,2,true,0],[11901,2,true,0],[11901,1,true,0]]).flat());
    expect(delivered.mails.flatMap(row=>[row.Annex1,row.Annex2,row.Annex3,row.Annex4,row.Annex5].filter(Boolean).map(Number))).toEqual(delivered.goods.map(row=>row.ItemID));
    expect(delivered.receipts).toHaveLength(3);expect((await saved())!.daily.actions).toBe(2);
  });
  it("keeps held tickets and legacy rights while real blocked pools reject purchase and every funding mode without RNG or writes",async()=>{
    await futureReady();futureTreasureEvidence.ready=false;const state=await legacyBag();state.games.treasure={...state.games.treasure as object,tickets:{normal:5,advanced:5}};await store(state);
    const before=await persisted();expect((await snapshot()).nativeTreasure.tickets).toEqual({normal:5,advanced:5});
    for(const mode of ["normal","advanced"] as const){await native(await ticketPurchase(mode),randomUUID(),400);const ticket=await ticketDraw(mode);
      await native(ticket,randomUUID(),400);const {funding:_funding,...points}=ticket;await native(points,randomUUID(),400);}
    expect(random.calls).toBe(0);expect(await persisted()).toEqual(before);expect(futureTreasureEvidence.locks).toEqual(Array.from({length:6},()=>TREASURE_IDS));
    await native({type:"take",choice:(await snapshot()).nativeTreasure.bagToken});expect((await snapshot()).nativeTreasure.tickets).toEqual({normal:5,advanced:5});
  });
  it("keeps old zero-ticket tokens and UUID signatures without injecting a default funding field",async()=>{
    await futureReady();await legacyBag();const first=await snapshot(),normalized={version:2,bag:[{templateId:11019,count:2,origin:"legacy-four-material"},{templateId:11021,count:4,origin:"legacy-four-material"}],draws:10,score:20,fragments:10,pity:8,choices:[PRIZES[0].name],claimed:[]};
    expect(first.nativeTreasure.bagToken).toBe("2026-10-15:"+createHash("sha256").update(JSON.stringify(normalized)).digest("base64url"));
    const value:ActivityAction={type:"draw",mode:"normal",count:1,selection:[],poolVersion:TREASURE_POOL_VERSION,choice:first.nativeTreasure.bagToken},id=randomUUID();
    const canonical=`{"action":{"choice":${JSON.stringify(value.choice)},"count":1,"mode":"normal","poolVersion":${JSON.stringify(TREASURE_POOL_VERSION)},"selection":[],"type":"draw"},"activityId":"treasure-native"}`;
    const oldSignature=createHash("sha256").update(canonical).digest("hex"),fresh=await native(value,id);
    expect(Object.keys(fresh.nativeTreasureAction!.effects[0]).sort()).toEqual(["type","mode","count","cost","score","draws","rewards"].sort());
    expect((await q1<{Signature:string}>(h,sql`SELECT "Signature" FROM app."ActivityActions" WHERE "RequestID"=${id}`))!.Signature).toBe(oldSignature);
    futureTreasureEvidence.ready=false;const before=await persisted(),calls=random.calls,replay=await native(value,id.toUpperCase());
    expect(replay).toMatchObject({replayed:true,nativeTreasure:{readiness:{status:"blocked"}}});expect(replay).not.toHaveProperty("nativeTreasureAction");
    await native({...value,funding:"tickets"},id,409);expect(random.calls).toBe(calls);expect(await persisted()).toEqual(before);
  });
  it("enforces 1..99, strict ticket fields, separate balances and overflow without consuming failed UUIDs",async()=>{
    await futureReady();const value=await ticketPurchase(),before=await persisted();
    for(const invalid of [{...value,count:0},{...value,count:100},{...value,count:1.5},{...value,count:"1"},{...value,funding:"tickets"},{...value,selection:[]},{...value,price:0},{...value,readiness:{status:"ready"}},{...value,poolVersion:"0".repeat(64)}]){
      expect((await post("treasure-native",invalid as ActivityAction)).statusCode).toBe(400);expect(await persisted()).toEqual(before);}
    expect(random.calls).toBe(0);await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=10000 WHERE "UserID"=${uid}`);
    await native(await ticketPurchase("normal",99));await native(await ticketPurchase("advanced",99));expect((await snapshot()).points).toBe(1090);
    const state=(await saved())!;state.games.treasure={...state.games.treasure as object,tickets:{normal:1_000_000_000,advanced:0}};await store(state);
    const capped=await persisted();await native(await ticketPurchase(),randomUUID(),400);await native(await ticketDraw("advanced"),randomUUID(),400);
    for(const funding of ["points","ticket",null])expect((await post("treasure-native",{...await ticketDraw(),funding} as ActivityAction)).statusCode).toBe(400);
    expect(await persisted()).toEqual(capped);expect(random.calls).toBe(0);
  });
  it("rolls back ticket purchases, draws and late multi-mail delivery on receipt failures before exact UUID retries",async()=>{
    await futureReady();const buy=await ticketPurchase("normal",2),buyId=randomUUID(),before=await persisted();
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT treasure_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    await native(buy,buyId,500);expect(await persisted()).toEqual(before);expect(random.calls).toBe(0);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT treasure_native_receipt_failure`);await native(buy,buyId);
    const value=await ticketDraw("normal",2),id=randomUUID(),paid=await persisted();exp1Random("normal");
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT treasure_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    await native(value,id,500);expect(await persisted()).toEqual(paid);expect(random.calls).toBe(2);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT treasure_native_receipt_failure`);await native(value,id);
    const take={type:"take",choice:(await snapshot()).nativeTreasure.bagToken},takeId=randomUUID(),drawn=await persisted();
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT treasure_native_mail_failure CHECK ("Annex2" IS NOT NULL) NOT VALID`);
    await native(take,takeId,500);expect(await persisted()).toEqual(drawn);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT treasure_native_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT treasure_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    await native(take,takeId,500);expect(await persisted()).toEqual(drawn);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT treasure_native_receipt_failure`);
    const delivered=await native(take,takeId);expect(delivered).toMatchObject({points:940,revision:3,mailedCount:2,nativeTreasure:{tickets:{normal:0,advanced:0},bag:[]},nativeCharge:{grossSpent:60}});
    const final=await persisted();expect(final.goods).toHaveLength(6);expect(final.mails).toHaveLength(2);expect(final.receipts).toHaveLength(3);
    expect((await native(buy,buyId)).replayed).toBe(true);expect((await native(value,id)).replayed).toBe(true);expect((await native(take,takeId)).replayed).toBe(true);
    expect(random.calls).toBe(4);expect(await persisted()).toEqual(final);
  });
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

// Earned v1 fixture: new draws are intentionally blocked on the real incomplete original catalog.
async function legacyBag(bag = [{ templateId: 11019, count: 2 }, { templateId: 11021, count: 4 }]) {
  const state: ActivityState = { version: 1, day: "2026-10-15", daily: {}, completed: { treasure: 10 }, claims: [], history: [],
    games: { treasure: { bag, draws: 10, score: 20, fragments: 10, pity: 8, choices: [PRIZES[0].name], claimed: [] } } };
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(state)}::jsonb)
    ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
  return state;
}
describe("v2 treasure with real legacy transaction and incomplete original catalog", () => {
  it("keeps GET and old normalization read-only and enforces ownership", async () => {
    await legacyBag(); const before = await persisted(), view = await snapshot();
    expect(view.nativeTreasure).toMatchObject({ version: 2, bagCapacity: 100, draws: 10, bagSlotsUsed: 2, canTake: true, canRecycle: true,
      readiness: { status: "blocked", totalRows: 158 } });
    expect((await saved())!.games.treasure).not.toHaveProperty("version"); expect(await persisted()).toEqual(before);
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post("treasure-native", {type:"take",choice:view.nativeTreasure.bagToken},randomUUID(),otherUid)).statusCode).toBe(403);
    expect(await persisted()).toEqual(before);
  });
  for (const id of ["treasure", "treasure-native"]) it(`${id} never substitutes a four-material draw for the incomplete 158-row pool`, async () => {
    const initial = await snapshot(), value: ActivityAction = {type:"draw",mode:"advanced",count:5,selection:[4,1,7,12],
      poolVersion:initial.nativeTreasure.poolVersion,choice:initial.nativeTreasure.bagToken};
    const before = await persisted(); random.calls = 0;
    await action(id,value,randomUUID(),400); expect(random.calls).toBe(0); expect(await persisted()).toEqual(before);
    await action(id,{type:"draw",count:1},randomUUID(),400); expect(random.calls).toBe(0); expect(await persisted()).toEqual(before);
  });
  it("takes exactly one earned row then the remaining rows without changing player profile or templates", async () => {
    await legacyBag([{templateId:11019,count:2},{templateId:11021,count:4},{templateId:11019,count:2}]);
    const profile = await q(h,sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`), goods = await q(h,sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`);
    const initial = await snapshot(), taken = await native({type:"take",index:1,choice:initial.nativeTreasure.bagToken});
    expect(taken).toMatchObject({mailedCount:1,nativeTreasure:{bagSlotsUsed:2},nativeTreasureAction:{effects:[{type:"taken",itemCount:4,items:[{index:1,templateId:11021,itemCount:4}]}]}});
    expect((await saved())!.games.treasure).toMatchObject({version:2,pity:8,choices:[PRIZES[0].name]});
    const before = await persisted(); await native({type:"take",index:1,choice:initial.nativeTreasure.bagToken},randomUUID(),400); expect(await persisted()).toEqual(before);
    await action("treasure",{type:"take"});
    expect((await persisted()).goods.map(x=>[x.TemplateID,x.Count,x.IsBinds,x.ValidDate])).toEqual([[11021,2,true,0],[11021,2,true,0],[11019,2,true,0],[11019,2,true,0]]);
    expect(await q(h,sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`)).toEqual(profile);
    expect(await q(h,sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(goods);
  });
  it("deduplicates eight simultaneous takes, stores only immutable receipt data and returns the latest bag on replay", async () => {
    await legacyBag(); const initial = await snapshot(), requestId = randomUUID(), value = {type:"take",index:0,choice:initial.nativeTreasure.bagToken};
    const results = await Promise.all(Array.from({length:8},()=>native(value,requestId)));
    expect(results.filter(x=>!x.replayed)).toHaveLength(1); expect(results.filter(x=>x.nativeTreasureAction)).toHaveLength(1);
    const receipt = await q<{Result:Record<string,unknown>}>(h,sql`SELECT "Result" FROM app."ActivityActions"`);
    expect(receipt).toHaveLength(1); expect(Object.keys(receipt[0].Result).sort()).toEqual(["mailedCount","message"]);
    await action("treasure",{type:"take"}); const before = await persisted(); random.calls = 0;
    const replay = await native(value,requestId.toUpperCase()); expect(replay).toMatchObject({replayed:true,nativeTreasure:{bag:[]}});
    expect(replay).not.toHaveProperty("nativeTreasureAction"); expect(random.calls).toBe(0); expect(await persisted()).toEqual(before);
    await native({...value,index:1},requestId,409); expect(await persisted()).toEqual(before);
  });
  it("rolls back all stacks, mails, state and receipt on both late mail and receipt failures then retries once", async () => {
    await legacyBag(Array.from({length:6},()=>({templateId:11021,count:4})));
    const initial = await snapshot(), before = await persisted(), requestId = randomUUID(), value = {type:"take",choice:initial.nativeTreasure.bagToken};
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT treasure_native_mail_failure CHECK ("Annex3" IS NOT NULL) NOT VALID`);
    expect((await post("treasure-native",value,requestId)).statusCode).toBe(500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT treasure_native_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT treasure_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    const failed = await post("treasure-native",value,requestId); expect(failed.statusCode).toBe(500); expect(failed.body).not.toMatch(/INSERT|UPDATE|Signature|Annex/); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT treasure_native_receipt_failure`);
    const delivered = await native(value,requestId); expect(delivered).toMatchObject({points:1000,revision:1,mailedCount:3,nativeTreasure:{bag:[]}});
    const after = await persisted(); expect(after.goods).toHaveLength(12); expect(after.mails).toHaveLength(3);
    expect(after.goods.every(x=>x.TemplateID===11021&&x.Count===2&&x.IsBinds&&x.ValidDate===0)).toBe(true);
    expect(after.mails.flatMap(x=>[x.Annex1,x.Annex2,x.Annex3,x.Annex4,x.Annex5].filter(Boolean).map(Number))).toEqual(after.goods.map(x=>x.ItemID));
    expect((await native(value,requestId)).replayed).toBe(true); expect(await persisted()).toEqual(after);
  });
  it("rolls back all four settlement paths and rejects unavailable ordinary delivery templates", async () => {
    await legacyBag(); const initial = await snapshot(), before = await persisted(), take = {type:"take",index:0,choice:initial.nativeTreasure.bagToken};
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11019`);
    await native(take,randomUUID(),503); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11019`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT treasure_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    for (const value of [take,{type:"recycle",choice:initial.nativeTreasure.bagToken},{type:"exchange",choice:initial.nativeTreasure.bagToken},{type:"progress",tier:2,choice:initial.nativeTreasure.bagToken}]) {
      await native(value,randomUUID(),500); expect(await persisted()).toEqual(before);
    }
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT treasure_native_receipt_failure`);
    const recycled = await native({type:"recycle",choice:initial.nativeTreasure.bagToken}); expect(recycled).toMatchObject({points:1012,earned:40,nativeTreasure:{bag:[]}});
    const exchanged = await native({type:"exchange",choice:recycled.nativeTreasure.bagToken}); expect(exchanged.nativeTreasure.fragments).toBe(0);
    const progress = await native({type:"progress",tier:2,choice:exchanged.nativeTreasure.bagToken}); expect(progress.nativeTreasure.progress[1].claimed).toBe(true);
    await action("treasure",{type:"progress",tier:2},randomUUID(),400);
  });
  it("restores a partial old bag across app restart and UTC change without automatic persistence", async () => {
    await legacyBag(); const initial = await snapshot(); await native({type:"take",index:0,choice:initial.nativeTreasure.bagToken});
    const old = await snapshot(), before = await persisted(); await built.app.close(); await rebuild(); expect(await snapshot()).toEqual(old); expect(await persisted()).toEqual(before);
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z")); const next = await snapshot(); expect(next.nativeTreasure.bag).toEqual(old.nativeTreasure.bag); expect(next.nativeTreasure.bagToken).not.toBe(old.nativeTreasure.bagToken); expect(await persisted()).toEqual(before);
    await native({type:"take",choice:old.nativeTreasure.bagToken},randomUUID(),400); expect(await persisted()).toEqual(before);
    await native({type:"take",choice:next.nativeTreasure.bagToken}); expect((await saved())!.day).toBe("2026-10-16");
  });
  it("preserves settlements at daily 500 while protecting revision and recycle overflow", async () => {
    const state = await legacyBag(); state.daily.actions = 500;
    await h.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=2147483647 WHERE "UserID"=${uid}`);
    let view = await snapshot(), before = await persisted(); await native({type:"take",choice:view.nativeTreasure.bagToken},randomUUID(),409); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=3,"Points"=2147483640 WHERE "UserID"=${uid}`);
    view = await snapshot(); before = await persisted(); expect(view.nativeTreasure.canRecycle).toBe(false);
    await native({type:"recycle",choice:view.nativeTreasure.bagToken},randomUUID(),400); expect(await persisted()).toEqual(before);
    const taken = await native({type:"take",choice:view.nativeTreasure.bagToken}); expect(taken).toMatchObject({points:2147483640,nativeTreasure:{bag:[]}}); expect((await saved())!.daily.actions).toBe(500);
  });
});
