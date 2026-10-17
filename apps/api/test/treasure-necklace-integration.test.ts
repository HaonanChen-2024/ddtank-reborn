import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { TREASURE_DRILL_POOL_VERSION, TREASURE_ENTRIES, TREASURE_IDS, TREASURE_POOL_VERSION, TREASURE_PREVIOUS_POOL_VERSION, TREASURE_STRENGTHEN_POOL_VERSION, TREASURE_COMPOSE_HONOR_POOL_VERSION, TREASURE_TRAINING_POOL_VERSION, TREASURE_SECOND_WEAPON_POOL_VERSION } from "../src/activities/treasure-catalog.js";
import type { TreasureState } from "../src/activities/treasure-native.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";
import { assertPublicActivityStates } from "./public-activity-state.js";

// Real HTTP/auth, seed templates, resource index, PGlite transactions and mail.
// No catalog mock or future-ready fixture: the incomplete 157-template pool always stays blocked.
const observed = vi.hoisted(() => ({ randomCalls: 0, locks: [] as number[][] }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: () => { observed.randomCalls++; return 0; } }));
vi.mock("../src/lib/db.js", async original => {
  const actual = await original<typeof import("../src/lib/db.js")>(), { PgDialect } = await import("drizzle-orm/pg-core");
  return { ...actual, q: async (...args: Parameters<typeof actual.q>) => {
    const rows = await actual.q(...args), query = new PgDialect().sqlToQuery(args[1]);
    if (query.sql.includes('FROM game."Shop_Goods"') && query.sql.trim().endsWith("FOR SHARE")) observed.locks.push(query.params.map(Number));
    return rows;
  } };
});
const ids = [14006,14007,14008,14009,14010,14028,14038,14046,14056], sortedIds = [...ids].sort((a,b)=>a-b);
const fixture = JSON.parse(readFileSync(new URL("./fixtures/treasure-necklace.json", import.meta.url), "utf8"));
const entries = ids.map(id => TREASURE_ENTRIES.find(row => row.templateId === id && row.sourceOriginalIndex === 13)!);
const tmp = mkdtempSync(join(tmpdir(), "ddt-treasure-necklace-")), uid = 733, secret = "treasure-necklace-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>, materials: typeof game.Shop_Goods.$inferSelect[];
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "treasure-necklace-test", role: "player" }, secret, 3600)}` });
const post = (action: ActivityAction, requestId: string = randomUUID()) => built.app.inject({ method: "POST",
  url: "/api/account/activities/treasure-native/action", headers: headers(), payload: { characterId: uid, requestId, action } });
function publicResult(value: ActivityResult): ActivityResult {
  assertPublicActivityStates(value);
  expect(JSON.stringify(value)).not.toMatch(/"(?:games|seed|choices|nativeTreasureEffects|boxRewards)":/);
  return value;
}
async function native(value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(value, requestId); expect(response.statusCode, response.body).toBe(status);
  return publicResult(response.json<ActivityResult>());
}
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200);
  const result = publicResult(response.json<ActivityResult>()); expect(result).not.toHaveProperty("nativeTreasureAction"); return result;
}
const readTemplates = () => h.db.select().from(game.Shop_Goods).orderBy(game.Shop_Goods.TemplateID);
async function persisted() { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
async function store(state: ActivityState) {
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(state)}::jsonb)
    ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
}
function oldBag() {
  const treasure: Omit<TreasureState, "tickets"> = { version: 2, bag: entries.map((row, index) => ({ templateId: row.templateId,
    count: row.count, validDays: 0, origin: "original-catalog", entryKey: row.entryKey, sourceOriginalIndex: row.sourceOriginalIndex,
    poolVersion: [TREASURE_PREVIOUS_POOL_VERSION, TREASURE_DRILL_POOL_VERSION, TREASURE_STRENGTHEN_POOL_VERSION, TREASURE_COMPOSE_HONOR_POOL_VERSION, TREASURE_TRAINING_POOL_VERSION, TREASURE_SECOND_WEAPON_POOL_VERSION, TREASURE_POOL_VERSION][index % 7] })),
    draws: 10, score: 20, fragments: 10, pity: 8, choices: [PRIZES[0].name], claimed: [] };
  const state: ActivityState = { version: 1, day: "2026-10-16", daily: {}, completed: { treasure: 10 }, claims: [], history: [], games: { treasure } };
  return { state, treasure };
}
beforeAll(async () => {
  type SeedTemplate = Omit<typeof game.Shop_Goods.$inferSelect, "AddTime"> & { AddTime: string | null };
  const seed = fixture.goods as SeedTemplate[];
  materials = ids.map(id => {
    const item = seed.find(row => row.TemplateID === id)!;
    return { ...item, AddTime: item.AddTime === null ? null : new Date(item.AddTime + "Z") };
  });
  expect(materials.map(item => [item.TemplateID,item.CategoryID,item.Property3,item.CanEquip,item.MaxCount]))
    .toEqual(ids.map(id=>[id,14,0,true,1]));
  expect(createHash("sha256").update(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).digest("hex"))
    .toBe(fixture.source.gzipSha256);
  expect(entries.map(row=>[row.count,row.sourceOriginalIndex])).toEqual(ids.map(()=>[1,13]));
  // Isolated indexed PNGs exercise delivery gates only, not real icon/Flash visual acceptance.
  for (const row of entries) {
    const dir = join(config.RESOURCE_DIR, "image", "equip", "necklace", row.pic); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "icon.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  }
  h = await createDb("pglite:memory"); await migrateDb(h);
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config });
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  observed.randomCalls = 0; observed.locks = [];
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.delete(game.Shop_Goods); await h.db.insert(game.Shop_Goods).values(materials);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'treasure-necklace-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'treasure-necklace-test','Treasure necklace test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("genuine necklace treasure entitlements", () => {
  it("delivers all nine original quantities from v1-v6/current mixed bags without changing old tokens or UUID rights", async () => {
    expect(TREASURE_SECOND_WEAPON_POOL_VERSION).toBe("3d5ce0281aba81b5a732b14fa2912983a7db3720ac7dcbf051ea28061f52d7f9");
    const {state,treasure} = oldBag(); await store(state);
    const before = await persisted(), view = await snapshot();
    const token = "2026-10-16:"+createHash("sha256").update(JSON.stringify(treasure)).digest("base64url");
    expect(view.nativeTreasure).toMatchObject({poolVersion:TREASURE_POOL_VERSION,bagToken:token,canTake:true,bagSlotsUsed:9,
      readiness:{status:"blocked",totalRows:158,readyRows:9}});
    expect(view.nativeTreasure.categories.filter(row=>row.selectable)).toHaveLength(14);
    expect(view.nativeTreasure.preview).toHaveLength(158); expect(await persisted()).toEqual(before);
    const action = {type:"take",choice:token}, id = randomUUID(), taken = await native(action,id);
    expect(taken).toMatchObject({points:1000,earned:40,revision:1,mailedCount:2,nativeCharge:{grossSpent:0},
      nativeTreasure:{bag:[],draws:10,progressScore:20,fragments:10,readiness:{status:"blocked"}}});
    const final = await persisted();
    expect(final.goods.map(row=>[row.TemplateID,row.Count,row.IsBinds,row.ValidDate])).toEqual(entries.map(row=>[row.templateId,1,true,0]));
    expect(final.mails).toHaveLength(2);
    for (let i=0;i<3;i++) { expect((await native(action,id)).replayed).toBe(true); expect(await persisted()).toEqual(final); }
    await native({...action,index:0},id,409);
    expect(await persisted()).toEqual(final); expect(await readTemplates()).toEqual(materials);
    expect(observed.randomCalls).toBe(0); expect(observed.locks).toEqual([sortedIds]);
  });
  it.each(ids)("rechecks genuine necklace %i fields under lock and allows the same rejected UUID after repair", async (templateId) => {
    const {state} = oldBag(); await store(state); const view = await snapshot(), index = ids.indexOf(templateId);
    const original = materials.find(row=>row.TemplateID===templateId)!;
    const changes = [{CategoryID:7},{CanEquip:false},{CanUse:false},{CanStrengthen:true},{MaxCount:2},{NeedLevel:1},
      {Property1:original.Property1+1},{Property2:original.Property2+1},{Property3:1},{Property4:1},{Property5:1},{Property6:1},{Property7:1},{Property8:0},
      {Attack:original.Attack+1},{Defence:original.Defence+1},{Agility:original.Agility+1},{Luck:original.Luck+1},{SuitId:12},{Pic:"wrong"},{NeedSex:1}];
    let retry: {action:ActivityAction;id:string}|undefined;
    for (const patch of changes) {
      await h.db.update(game.Shop_Goods).set(patch).where(sql`${game.Shop_Goods.TemplateID}=${templateId}`);
      const changed = await readTemplates(), before = await persisted(), action = {type:"take",index,choice:view.nativeTreasure.bagToken},id=randomUUID();
      expect((await native(action,id,503)).message).toBe("寻宝原目录奖励暂不可交付，请保留临时包。");
      expect(await persisted()).toEqual(before); expect(await readTemplates()).toEqual(changed); expect(observed.randomCalls).toBe(0);
      await h.db.update(game.Shop_Goods).set(original).where(sql`${game.Shop_Goods.TemplateID}=${templateId}`);
      retry={action,id};
    }
    expect((await snapshot()).nativeTreasure.bagToken).toBe(view.nativeTreasure.bagToken);
    expect(observed.locks).toEqual(Array.from({length:changes.length},()=>[templateId]));
    expect(await native(retry!.action,retry!.id)).toMatchObject({revision:1,points:1000,mailedCount:1,nativeTreasure:{bagSlotsUsed:8}});
    const final = await persisted(); expect(final.goods.map(row=>[row.TemplateID,row.Count])).toEqual([[templateId,1]]);
    expect((await native(retry!.action,retry!.id)).replayed).toBe(true); expect(await persisted()).toEqual(final);
  });
  it("rejects all new spending from old versions and the current incomplete full pool without RNG or five-table writes", async () => {
    const {state} = oldBag(); await store(state); const view = await snapshot(), before = await persisted();
    for (const poolVersion of [TREASURE_PREVIOUS_POOL_VERSION,TREASURE_DRILL_POOL_VERSION,TREASURE_STRENGTHEN_POOL_VERSION,
      TREASURE_COMPOSE_HONOR_POOL_VERSION,TREASURE_TRAINING_POOL_VERSION,TREASURE_SECOND_WEAPON_POOL_VERSION,"f".repeat(64),TREASURE_POOL_VERSION]) for (const mode of ["normal","advanced"] as const) {
      const draw:ActivityAction = {type:"draw",mode,count:1,poolVersion,choice:view.nativeTreasure.bagToken,selection:mode==="normal"?[]:[4,1,12,7]};
      for (const action of [draw,{...draw,funding:"tickets" as const},{type:"buy-tickets",mode,count:1,poolVersion,choice:view.nativeTreasure.bagToken}]) {
        const refused = await native(action,randomUUID(),400);
        expect(refused.message).toMatch(poolVersion===TREASURE_POOL_VERSION?/完整奖池尚有\d+条未就绪/:/原奖池版本已更新/);
        expect(await persisted()).toEqual(before); expect(observed.randomCalls).toBe(0);
      }
    }
    expect(observed.locks).toEqual(Array.from({length:48},()=>TREASURE_IDS));
    (state.games.treasure as Omit<TreasureState,"tickets">).bag[0].poolVersion="f".repeat(64); await store(state);
    const unknown = await persisted(), response = await post({type:"take",choice:view.nativeTreasure.bagToken});
    expect(response.statusCode).toBe(400); expect(response.json()).toMatchObject({message:"寻宝原目录奖品版本或身份无效，请保留存档。"});
    expect(await persisted()).toEqual(unknown); expect(await readTemplates()).toEqual(materials); expect(observed.randomCalls).toBe(0);
  });
  it("replays an already committed v6 draw UUID through the new policy without spending or granting again", async () => {
    const {state,treasure} = oldBag();
    for (const row of treasure.bag) row.poolVersion=TREASURE_SECOND_WEAPON_POOL_VERSION;
    await store(state);
    // Stored signature follows the existing recursively sorted request contract.
    const action:ActivityAction = {choice:"2026-10-16:"+"a".repeat(43),count:1,mode:"normal",
      poolVersion:TREASURE_SECOND_WEAPON_POOL_VERSION,selection:[],type:"draw"};
    const id=randomUUID(), signature=createHash("sha256").update(JSON.stringify({action,activityId:"treasure-native"})).digest("hex");
    await h.db.execute(sql`INSERT INTO app."ActivityActions" ("UserID","RequestID","Signature","Result")
      VALUES (${uid},${id},${signature},${JSON.stringify({message:"既有v6抽取已提交",mailedCount:0})}::jsonb)`);
    const before=await persisted(), replay=await native(action,id);
    expect(replay).toMatchObject({replayed:true,message:"既有v6抽取已提交",mailedCount:0,points:1000,revision:0,
      nativeTreasure:{poolVersion:TREASURE_POOL_VERSION,bagSlotsUsed:9,readiness:{status:"blocked"}}});
    expect(replay.nativeTreasure.bag.every(row=>row.poolVersion===TREASURE_SECOND_WEAPON_POOL_VERSION)).toBe(true);
    expect(await persisted()).toEqual(before); expect(observed.randomCalls).toBe(0); expect(observed.locks).toEqual([]);
  });
  it("preserves unresolved 14029/14050 display conflicts and missing 14057 entitlements without substituting templates", async () => {
    for (const templateId of [14029,14050]) {
      const raw = fixture.goods.find((row:{TemplateID:number})=>row.TemplateID===templateId);
      await h.db.insert(game.Shop_Goods).values({...raw,AddTime:raw.AddTime===null?null:new Date(raw.AddTime+"Z")});
    }
    for (const templateId of [14029,14050,14057]) {
      const {state,treasure} = oldBag(), row = TREASURE_ENTRIES.find(entry=>entry.templateId===templateId)!;
      treasure.bag = [{templateId,count:1,validDays:0,origin:"original-catalog",entryKey:row.entryKey,
        sourceOriginalIndex:13,poolVersion:TREASURE_SECOND_WEAPON_POOL_VERSION}];
      await store(state);
      const view = await snapshot(), before = await persisted(), templates = await readTemplates();
      expect(view.nativeTreasure.preview.find(entry=>entry.templateId===templateId)).toMatchObject({status:"blocked"});
      await native({type:"take",choice:view.nativeTreasure.bagToken},randomUUID(),503);
      expect(await persisted()).toEqual(before); expect(await readTemplates()).toEqual(templates); expect(observed.randomCalls).toBe(0);
    }
  });
});
