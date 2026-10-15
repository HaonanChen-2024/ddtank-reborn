import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { pairNativeLocalRules } from "../src/activities/pair-native.js";
import { createActivityState } from "../src/activities/engine.js";
import { TREASURE_ENTRIES, TREASURE_IDS, TREASURE_POOL_VERSION } from "../src/activities/treasure-catalog.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityReward, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// No normal-suite DB connection. The dedicated runner creates a NEW template0 DB and ownership marker.
const random = vi.hoisted(() => ({ fraction: 0.99, calls: 0 }));
const futureTreasureEvidence = vi.hoisted(() => ({ ready: false }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => { random.calls++; return max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)); } }));
// Future full-pool transaction fixture, never enabled by an HTTP field or ordinary suite setup.
// Keep the real catalog identity/stack checks and SQL reads/locks; only simulate missing use/asset evidence.
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
const url = process.env.WORKSHOP_NATIVE_ACTIVITIES_URL, token = process.env.WORKSHOP_NATIVE_ACTIVITIES_TOKEN;
const uid = 601, secret = "native-activity-pg-tests-only", name = "native-activity-pg-test";
type App = Awaited<ReturnType<typeof buildApp>>;
let monitor: DbHandle, holder: DbHandle, a: DbHandle, b: DbHandle, appA: App, appB: App;
let database: string, output: string, day: string, passed = 0;
const connectionPids: number[] = [], scenarios: unknown[] = [];
const friend = 602, friendName = "native-activity-pg-friend", friendNick = "Native PG friend";
const headers = (who = uid) => ({ authorization: `Bearer ${signJwt({ sub: who === uid ? 1 : 2, name: who === uid ? name : friendName, role: "player" }, secret, 3600)}` });
const post = (app: App, id: string, action: ActivityAction, requestId: string = randomUUID(), who = uid) => app.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(who), payload: { characterId: who, requestId, action } });
async function action(id: string, value: ActivityAction, requestId: string = randomUUID(), app = appA): Promise<ActivityResult> {
  const response = await post(app, id, value, requestId); expect(response.statusCode, response.body).toBe(200); return response.json();
}
const pair = (value: ActivityAction) => action("pair-native", value);
const mines = (value: ActivityAction) => action("mines-native", value);
async function saved() { return {
  wallets: await q(monitor, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(monitor, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(monitor, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(monitor, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(monitor, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// UUID replays re-read the complete GET projection; Forthright and Snowfield clocks may advance.
const latestView = (value: ActivityResult) => ({...value, nativeForthright:{...value.nativeForthright,
  serverNow:expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)},
  ...(value.nativeChristmasSnowfield?{nativeChristmasSnowfield:{...value.nativeChristmasSnowfield,
    serverNow:expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)}}:{})});
async function wallet() { return (await q1<{ Points: number; Revision: number }>(monitor, sql`SELECT "Points","Revision" FROM app."ActivityWallet" WHERE "UserID"=${uid}`))!; }
async function snapshot(app = appB, who = uid) {
  const response = await app.app.inject({ url: `/api/account/activities?characterId=${who}`, headers: headers(who) });
  expect(response.statusCode, response.body).toBe(200); const result = response.json<ActivityResult>();
  for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction", "nativeTreasureAction", "nativeWheelAction", "nativeCarnivalAction", "nativeFirstRechargeAction", "nativeChargeAction", "nativeForthrightAction", "nativeExchangeAction"]) expect(result).not.toHaveProperty(key);
  return result;
}
const wheel = async (type: string) => action("wheel-native", {type,choice:(await snapshot()).nativeWheel.roundToken});
async function walk(count: number, start = 0) { for (let index = start; index < start + count; index++) await mines({ type: "walk", index }); }
async function pairPaidReady() {
  await pair({ type: "start" }); await pair({ type: "flip-all" }); await action("tasks", { type: "claim", choice: "pair" });
  await pair({ type: "reset", choice: "free" }); await pair({ type: "buy-reels", count: 2 });
  for (const index of [1, 2, 3]) await pair({ type: "flip", index, choice: "points" });
}
async function race(label: string, requests: (() => ReturnType<typeof post>)[], heldIds = [uid]) {
  const before = await saved();
  let unlock!: () => void, acquired!: () => void;
  const released = new Promise<void>(resolve => { unlock = resolve; });
  const locked = new Promise<void>(resolve => { acquired = resolve; });
  const held = holder.db.transaction(async tx => {
    await tx.execute(sql`SELECT "UserID" FROM app."ActivityWallet" WHERE "UserID" IN (${sql.join(heldIds.map(id=>sql`${id}`),sql`,`)}) ORDER BY "UserID" FOR UPDATE`);
    acquired(); await released;
  });
  await locked; const calls = requests.map(request => request());
  for (const call of calls) void call.catch(() => {});
  let failure: unknown;
  try {
    const deadline = performance.now() + 6000;
    let locks: { pid: number; blockers: number[]; wait_event_type: string; query: string }[] = [];
    while (performance.now() < deadline) {
      locks = await q(monitor, sql`SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, query FROM pg_stat_activity
        WHERE datname=${database} AND pid IN (${connectionPids[2]},${connectionPids[3]}) ORDER BY pid`);
      if (locks.length === 2 && locks.every(row => row.wait_event_type === "Lock" && row.blockers.length > 0 && row.query.includes("ActivityWallet"))) break;
      await delay(25);
    }
    expect(locks).toHaveLength(2); expect(locks.every(row => row.wait_event_type === "Lock" && row.blockers.length > 0 && row.query.includes("ActivityWallet"))).toBe(true);
    expect(await saved()).toEqual(before); // A third connection cannot observe state, charge or mail halfway through.
    scenarios.push({ label, connections: locks.map(({ pid, blockers, wait_event_type }) => ({ pid, blockers, wait_event_type })), beforeDigest: digest(before) });
  } catch(error) { failure = error; }
  finally { unlock(); await held; }
  const results = await Promise.all(calls);
  if (failure) throw failure;
  return results;
}
async function treasureLockWait(label: string, heldQuery: SQL, request: () => ReturnType<typeof post>, blockedQuery: string,
  whileBlocked: () => Promise<void> = async () => {}, beforeRelease?: SQL) {
  const before = await saved();
  let unlock!: () => void, acquired!: () => void, lockFailed!: (reason: unknown) => void;
  const released = new Promise<void>(resolve => { unlock = resolve; });
  const locked = new Promise<void>((resolve, reject) => { acquired = resolve; lockFailed = reject; });
  const held = holder.db.transaction(async tx => {
    await tx.execute(heldQuery); acquired(); await released;
    if (beforeRelease) await tx.execute(beforeRelease);
  });
  void held.catch(lockFailed); await locked;
  const call = request(); void call.catch(() => {});
  let failure: unknown;
  try {
    const deadline = performance.now() + 6000;
    let observed: { pid: number; blockers: number[]; wait_event_type: string; query: string } | undefined;
    while (performance.now() < deadline) {
      observed = await q1(monitor, sql`SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, query FROM pg_stat_activity
        WHERE datname=${database} AND pid=${connectionPids[2]}`) ?? undefined;
      if (observed?.wait_event_type === "Lock" && observed.blockers.includes(connectionPids[1]) && observed.query.includes(blockedQuery)) break;
      await delay(25);
    }
    expect(observed).toMatchObject({pid:connectionPids[2],blockers:[connectionPids[1]],wait_event_type:"Lock"});
    expect(observed!.query).toContain(blockedQuery);
    expect(await saved()).toEqual(before);
    scenarios.push({label,observed,beforeDigest:digest(before)});
    await whileBlocked();
  } catch (error) { failure = error; }
  finally { unlock(); await held; }
  const result = await call;
  if (failure) throw failure;
  return result;
}
async function treasureSeed(at = new Date(), oldDailyActions = 0) {
  await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
  const state = createActivityState(at); state.daily = {actions:oldDailyActions,draws:77};
  await monitor.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(state)}::jsonb)`);
}
async function treasureTemplatesFixture() {
  const base = (await monitor.db.select().from(game.Shop_Goods).limit(1))[0]!;
  const unique = [...new Map(TREASURE_ENTRIES.map(row => [row.templateId, row])).values()];
  await monitor.db.insert(game.Shop_Goods).values(unique.map(row => ({ ...base, TemplateID: row.templateId, Name: row.name,
    CategoryID: row.categoryId, Pic: row.pic, NeedSex: row.needSex, CanEquip: row.categoryId === 7, MaxCount: 5 })))
    .onConflictDoUpdate({ target: game.Shop_Goods.TemplateID, set: { Pic: sql`excluded."Pic"`, CategoryID: sql`excluded."CategoryID"`, NeedSex: sql`excluded."NeedSex"` } });
  expect((await q(monitor, sql`SELECT "TemplateID" FROM game."Shop_Goods" WHERE "TemplateID" IN (${sql.join(TREASURE_IDS.map(id => sql`${id}`),sql`,`)}) ORDER BY "TemplateID"`))
    .map(row => row.TemplateID)).toEqual(TREASURE_IDS);
}
async function treasureReady() { await treasureTemplatesFixture(); futureTreasureEvidence.ready = true; }
async function treasureLegacyBag(bag: ActivityReward[]) {
  await treasureSeed();
  await editState(uid, state => { state.games.treasure = { bag, draws: bag.length, score: bag.length * 2, fragments: bag.length,
    pity: 0, choices: ["强化石1级"], claimed: [] }; });
}
async function treasureDraw(count = 1, mode: "normal" | "advanced" = "normal", app = appB): Promise<ActivityAction> {
  return { type: "draw", mode, count, choice: (await snapshot(app)).nativeTreasure.bagToken,
    selection: mode === "advanced" ? [14,7,1,12] : [], poolVersion: TREASURE_POOL_VERSION };
}
function duplicateResults(results: Awaited<ReturnType<typeof post>>[], key: "nativePairAction" | "nativeMinesAction" | "nativeDDPlayAction" | "nativeGypsyAction" | "nativeMoonlightAction" | "nativeTreasureAction" | "nativeWheelAction" | "nativeCarnivalAction" | "nativeFirstRechargeAction" | "nativeChargeAction" | "nativeForthrightAction") {
  expect(results.map(r => r.statusCode)).toEqual(Array(results.length).fill(200));
  expect(results.filter(r => r.json().replayed)).toHaveLength(results.length - 1);
  expect(results.filter(r => r.json()[key])).toHaveLength(1);
  for (const r of results.filter(r => r.json().replayed)) expect(r.json()).not.toHaveProperty(key);
}
const duplicates = (id: string, value: ActivityAction, requestId: string, count = 8) => Array.from({ length: count }, (_, i) => () => post(i % 2 ? appB : appA, id, value, requestId));
async function rechargeSeed(recipientCompleted = false) {
  await monitor.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (2,${friendName},'tests-only')`);
  await monitor.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst") VALUES (${friend},${friendName},${friendNick},true,'2000-01-01',1)`);
  for (const who of [uid,friend]) {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${who},1000,600)`);
    const state=createActivityState(new Date()); if(who===uid||recipientCompleted)state.completed.pair=1;
    await monitor.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${who},'reference',${JSON.stringify(state)}::jsonb)`);
  }
}
async function recharge(value: ActivityAction, who=uid, requestId: string=randomUUID(), app=appA) {
  const a={...value,choice:value.choice??(await snapshot(app,who)).nativeFirstRecharge.stateToken};
  const result=await post(app,"first-recharge-native",a,requestId,who); expect(result.statusCode,result.body).toBe(200); return result.json<ActivityResult>();
}
const rechargeCard=(result:ActivityResult,tier:number)=>result.nativeFirstRecharge.cards.cards.find(card=>card.kind===tier)!;
const third = 603, replacement = 604, forthrightId = "forthright-native";
async function forthrightSeed() {
  await rechargeSeed(true);
  for (const id of [third, replacement]) {
    await monitor.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst") VALUES (${id},${friendName},${`Native PG ${id}`},true,'2000-01-01',1)`);
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${id},1000,1000)`);
    await monitor.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${id},'reference',${JSON.stringify(createActivityState(new Date()))}::jsonb)`);
  }
}
async function forthright(value: ActivityAction, who = uid, requestId: string = randomUUID(), app = appA) {
  const choice = value.choice ?? (await snapshot(app, who)).nativeForthright.stateToken;
  const response = await post(app, forthrightId, { ...value, choice }, requestId, who);
  expect(response.statusCode, response.body).toBe(200); return response.json<ActivityResult>();
}
const openForthright = async (index = 0) => (await forthright({type:"open-group", index, tier:0, count:1, marked:true})).nativeForthright.pages.groups.createdOrders.at(-1)!;
const inspectForthright = async (code: string, who = friend) => (await forthright({type:"inspect-group", choice:code},who)).nativeForthright.pages.groups.inspected!;
const joinForthright = async (code: string, who = friend) => forthright({type:"join-group",count:1,choice:(await inspectForthright(code,who)).actionToken},who);
const forthrightDuplicates = (value: ActivityAction, requestId: string, who = uid) => Array.from({length:8},(_,i)=>()=>post(i%2?appB:appA,forthrightId,value,requestId,who));
async function editState(who: number, edit: (state: ActivityState) => void) {
  const row = await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${who} AND "Activity"='reference'`);
  const state = row!.State; edit(state);
  await monitor.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${who} AND "Activity"='reference'`);
}

describe.skipIf(!url)("native PostgreSQL activity transactions across independent API connections", () => {
  beforeAll(async () => {
    assert(url && token && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token));
    const parsed = new URL(url); database = parsed.pathname.slice(1); output = process.env.WORKSHOP_NATIVE_ACTIVITIES_OUTPUT!;
    assert.match(database, /^workshop_native_activities_[a-f0-9]{32}$/); assert.equal(database, `workshop_native_activities_${token.replaceAll("-", "")}`);
    assert.equal(parsed.hostname, "127.0.0.1"); assert.equal(parsed.port, "55432"); assert.equal(parsed.username, "postgres"); assert.equal(parsed.search, "");
    assert(output, "Runner output required"); day = new Date().toISOString().slice(0, 10);
    monitor = await createDb(url, { max: 1 });
    const identity = await q1<{ database: string; port: number }>(monitor, sql`SELECT current_database() AS database, inet_server_port() AS port`);
    assert.equal(identity?.database, database); assert.equal(identity?.port, 55432);
    expect(await q(monitor, sql`SELECT token FROM public."WorkshopNativeActivityTest"`)).toEqual([{ token }]);
    expect(await q(monitor, sql`SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`)).toEqual([{ tablename: "WorkshopNativeActivityTest" }]);
    await migrateDb(monitor);
    holder = await createDb(url, { max: 1 }); a = await createDb(url, { max: 1 }); b = await createDb(url, { max: 1 });
    for (const [index, handle] of [monitor, holder, a, b].entries()) {
      const row = await q1<{ database: string; pid: number }>(handle, sql`SELECT current_database() AS database, pg_backend_pid() AS pid`);
      assert.equal(row?.database, database); connectionPids.push(row!.pid);
      await handle.db.execute(sql`SELECT set_config('application_name',${`workshop_native_activity_${index}`},false)`);
      await handle.db.execute(sql`SET statement_timeout = '15000ms'`);
    }
    expect(new Set(connectionPids).size).toBe(4);
    const template: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "Test material", CanRecycle: 0, CategoryID: 11,
      Attack: 0, Defence: 0, Agility: 0, Luck: 0, Level: 1, Quality: 1, MaxCount: 5, NeedSex: 0, NeedLevel: 1,
      CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
      Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
      BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
    await monitor.db.insert(game.Shop_Goods).values(pairNativeLocalRules.prizes.map(p => ({ ...template, TemplateID: p.templateId, Name: p.name })));
    const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, JWT_SECRET: secret,
      RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "", FLASH_DIR: join(output,"flash"), FLASH_OVERLAY_DIR: "",
      RESOURCE_DIR: join(output,"resource"), UPLOAD_DIR: join(output,"uploads"), REQUEST_SNAPSHOT_DIR: join(output,"snapshots"), RUFFLE_DIR: join(output,"ruffle"), CELEB_REBUILD_MIN: 0 };
    appA = await buildApp({ db: a, logger: false, skipTemplates: true, env: {}, config });
    appB = await buildApp({ db: b, logger: false, skipTemplates: true, env: {}, config });
  });
  beforeEach(async () => {
    random.fraction = 0.99; random.calls = 0;
    futureTreasureEvidence.ready = false;
    expect(new Date().toISOString().slice(0,10)).toBe(day);
    await monitor.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS native_test_mail_failure`);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS native_test_receipt_failure`);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityStates" DROP CONSTRAINT IF EXISTS native_test_recipient_failure`);
    await monitor.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11019`);
    // Shared actor revisions belong to the same isolated test case as its reset wallets.
    await monitor.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",app."CarnivalGlobalState",
      member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
    await monitor.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,${name},'tests-only')`);
    await monitor.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
      VALUES (${uid},${name},'Native PG test',true,'2000-01-01',1)`);
    const before = await saved(); await snapshot(); expect(await saved()).toEqual(before);
  });
  afterAll(async () => {
    await appA?.app.close(); await appB?.app.close();
    await Promise.all([monitor, holder, a, b].filter(Boolean).map(handle => handle.close()));
    if (output) writeFileSync(join(output,"test-evidence.json"), JSON.stringify({ database, token, passed, connectionPids, scenarios, closedConnections: true }, null, 2)+"\n");
  });
  afterEach(() => vi.useRealTimers());

  it("deduplicates a paid Pair match UUID and replays the latest view without another effect/mail", async () => {
    await pairPaidReady(); const before = await saved(), w = await wallet(), id = randomUUID();
    const result = await race("pair-paid-match-same-uuid", duplicates("pair-native",{type:"flip",index:4,choice:"points"},id));
    duplicateResults(result,"nativePairAction"); expect(await wallet()).toEqual({Points:w.Points-2,Revision:w.Revision+1});
    const after = await saved(); expect(after.mails.length-before.mails.length).toBe(1); expect(after.goods.length-before.goods.length).toBe(1); expect(after.receipts.length-before.receipts.length).toBe(1);
    expect(await snapshot()).toMatchObject({points:52,nativePair:{matchedPairs:2,hiddenRemaining:28}});
    await pair({type:"flip",index:5,choice:"points"}); const current = await snapshot(), prior = await saved();
    expect(await action("pair-native",{type:"flip",index:4,choice:"points"},id,appB)).toMatchObject({...latestView(current),replayed:true});
    expect((await post(appB,"pair-native",{type:"flip",index:6,choice:"points"},id)).statusCode).toBe(409); expect(await saved()).toEqual(prior); passed++;
  });
  it("serializes different Pair UUIDs competing for the same paid match", async () => {
    await pairPaidReady(); const before = await saved(), w = await wallet();
    const result = await race("pair-paid-match-different-uuids",[()=>post(appA,"pair-native",{type:"flip",index:4,choice:"points"}),()=>post(appB,"pair-native",{type:"flip",index:4,choice:"points"})]);
    expect(result.map(r=>r.statusCode).sort()).toEqual([200,400]); expect(await wallet()).toEqual({Points:w.Points-2,Revision:w.Revision+1});
    const after = await saved(); expect(after.goods.length-before.goods.length).toBe(1); expect(after.mails.length-before.mails.length).toBe(1); expect(after.receipts.length-before.receipts.length).toBe(1); passed++;
  });
  it("rolls back Pair state, charge, three earlier mails and UUID when the fourth mail fails, then retries once", async () => {
    await pair({type:"start"}); await pair({type:"flip-all"}); await action("tasks",{type:"claim",choice:"pair"}); await pair({type:"reset",choice:"free"});
    await action("cave",{type:"draw",count:3}); await action("tasks",{type:"claim",choice:"explore"}); const before = await saved(), w = await wallet(), id = randomUUID();
    await monitor.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT native_test_mail_failure CHECK ("Annex5" IS NOT NULL) NOT VALID`);
    expect((await post(appB,"pair-native",{type:"flip-all",choice:"points"},id)).statusCode).toBe(500); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT native_test_mail_failure`);
    const result = await race("pair-late-failure-retry-same-uuid",duplicates("pair-native",{type:"flip-all",choice:"points"},id)); duplicateResults(result,"nativePairAction");
    const after = await saved(); expect(await wallet()).toEqual({Points:w.Points-64,Revision:w.Revision+1}); expect(after.goods.length-before.goods.length).toBe(16); expect(after.mails.length-before.mails.length).toBe(4); expect(after.receipts.length-before.receipts.length).toBe(1); passed++;
    expect(await snapshot()).toMatchObject({points:36,nativePair:{round:2,isAllOpen:true,matchedPairs:16}});
  });
  it("deduplicates Mines claim UUIDs and different UUIDs competing for the same manual reward", async () => {
    await mines({type:"start"}); await walk(10); const id = randomUUID(), before = await saved(), w = await wallet();
    duplicateResults(await race("mines-claim-same-uuid",duplicates("mines-native",{type:"claim",tier:1},id)),"nativeMinesAction");
    expect(await wallet()).toEqual({Points:w.Points,Revision:w.Revision+1}); const first = await saved(); expect(first.goods.length-before.goods.length).toBe(1); expect(first.mails.length-before.mails.length).toBe(1);
    await walk(20,10); const secondBefore = await saved(), secondWallet = await wallet();
    const result = await race("mines-claim-different-uuids",[()=>post(appA,"mines-native",{type:"claim",tier:2}),()=>post(appB,"mines-native",{type:"claim",tier:2})]);
    expect(result.map(r=>r.statusCode).sort()).toEqual([200,400]); expect(await wallet()).toEqual({Points:secondWallet.Points,Revision:secondWallet.Revision+1});
    const after = await saved(); expect(after.mails.length-secondBefore.mails.length).toBe(1); expect(after.goods.length-secondBefore.goods.length).toBe(1); expect(after.receipts.length-secondBefore.receipts.length).toBe(1); passed++;
    const claims = (await snapshot()).nativeMines; if(!claims.started) throw new Error("Mines not started");
    expect(claims.claims.map(c=>c.claimed)).toEqual([true,true,false]);
  });
  it("charges probe/reset retries once and concurrent distinct revive UUIDs only for one valid revival", async () => {
    await mines({type:"start"}); await mines({type:"walk",index:50}); await walk(8); await action("tasks",{type:"claim",choice:"mines"}); await mines({type:"walk",index:50});
    const probeId = randomUUID(), probeBefore = await saved(), w = await wallet();
    duplicateResults(await race("mines-paid-probe-same-uuid",duplicates("mines-native",{type:"probe"},probeId)),"nativeMinesAction"); expect(await wallet()).toEqual({Points:w.Points-5,Revision:w.Revision+1});
    expect((await saved()).mails).toEqual(probeBefore.mails); expect(await snapshot()).toMatchObject({points:55,nativeMines:{findMineTimes:1}});
    for(const index of [60,61,62]) await mines({type:"walk",index});
    const reviveBefore = await wallet(); const result = await race("mines-paid-revive-different-uuids",[()=>post(appA,"mines-native",{type:"revive"}),()=>post(appB,"mines-native",{type:"revive"})]);
    expect(result.map(r=>r.statusCode).sort()).toEqual([200,400]); expect(await wallet()).toEqual({Points:reviveBefore.Points-15,Revision:reviveBefore.Revision+1});
    expect(await snapshot()).toMatchObject({points:40,nativeMines:{hp:3,revivesRemaining:0}});
    await mines({type:"walk",index:8}); await mines({type:"claim",tier:1}); await mines({type:"reset",choice:"free"}); await mines({type:"walk",index:0});
    const resetBefore = await saved(), resetWallet = await wallet(); duplicateResults(await race("mines-paid-reset-same-uuid",duplicates("mines-native",{type:"reset",choice:"points"},randomUUID())),"nativeMinesAction");
    expect(await wallet()).toEqual({Points:resetWallet.Points-10,Revision:resetWallet.Revision+1}); expect((await saved()).mails).toEqual(resetBefore.mails); passed++;
    expect(await snapshot()).toMatchObject({points:30,nativeMines:{round:3,openCount:0}});
  });
  it("rolls back Mines claim state/mail/UUID after a late mail failure and retries the same UUID once", async () => {
    await mines({type:"start"}); await walk(10); const before = await saved(), w = await wallet(), id = randomUUID();
    await monitor.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT native_test_mail_failure CHECK ("Annex2" IS NOT NULL) NOT VALID`);
    expect((await post(appA,"mines-native",{type:"claim",tier:1},id)).statusCode).toBe(500); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT native_test_mail_failure`);
    duplicateResults(await race("mines-late-failure-retry-same-uuid",duplicates("mines-native",{type:"claim",tier:1},id)),"nativeMinesAction");
    const after = await saved(); expect(await wallet()).toEqual({Points:w.Points,Revision:w.Revision+1}); expect(after.goods.length-before.goods.length).toBe(1); expect(after.mails.length-before.mails.length).toBe(1); expect(after.receipts.length-before.receipts.length).toBe(1); passed++;
    expect(after.mails[0].ReceiverID).toBe(uid); expect(Number(after.mails[0].Annex1)).toBe(after.goods[0].ItemID);
  });
  it("shares the UUID and wallet lock across Pair and Mines instead of double-charging cross-module retries", async () => {
    await pair({type:"start"}); await pair({type:"flip-all"}); await action("tasks",{type:"claim",choice:"pair"}); await mines({type:"start"}); await mines({type:"walk",index:50});
    const before = await saved(), w = await wallet(), id = randomUUID();
    const result = await race("pair-mines-cross-module-uuid",[()=>post(appA,"pair-native",{type:"buy-reels",count:1},id),()=>post(appB,"mines-native",{type:"probe"},id)]);
    expect(result.map(r=>r.statusCode).sort()).toEqual([200,409]); const fresh = result.find(r=>r.statusCode===200)!.json<ActivityResult>();
    expect(await wallet()).toEqual({Points:w.Points-(fresh.nativePairAction?2:5),Revision:w.Revision+1}); const after = await saved();
    expect(after.receipts.length-before.receipts.length).toBe(1); expect(after.goods).toEqual(before.goods); expect(after.mails).toEqual(before.mails); passed++;
  });
  it("commits one native DDPlay spin per UUID and serializes two further legacy/native spins into the same save", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},100,0)`);
    const id = randomUUID(), before = await saved();
    const duplicatesResult = await race("ddplay-native-spin-same-uuid",duplicates("ddplay-native",{type:"spin"},id));
    duplicateResults(duplicatesResult,"nativeDDPlayAction"); expect(await wallet()).toEqual({Points:190,Revision:1});
    expect(duplicatesResult.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeDDPlay:{spins:1,score:190},
      nativeDDPlayAction:{requestId:id,effects:[{type:"spun",multiplier:10,reels:[3,3,3],pointsDelta:90,cost:10,pointsAwarded:100,spins:1,score:190}]}});
    expect((await saved()).receipts.length-before.receipts.length).toBe(1);
    const racing = await race("ddplay-legacy-native-distinct-uuids",[()=>post(appA,"ddplay",{type:"spin"}),()=>post(appB,"ddplay-native",{type:"spin"})]);
    expect(racing.map(response=>response.statusCode)).toEqual([200,200]);
    expect(racing[0].json()).not.toHaveProperty("nativeDDPlayAction"); expect(racing[1].json()).toHaveProperty("nativeDDPlayAction");
    expect(await wallet()).toEqual({Points:370,Revision:3}); expect(await snapshot()).toMatchObject({nativeDDPlay:{spins:3,score:370}});
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State;
    expect(state.games.ddplay).toEqual({version:1,kind:"ddplay",spins:3,faces:[5,5,5]}); expect(state.completed.ddplay).toBe(3); expect(state.games).not.toHaveProperty("ddplayNativeV1");
    const after = await saved(); expect(after.receipts.length-before.receipts.length).toBe(3); expect(after.goods).toEqual(before.goods); expect(after.mails).toEqual(before.mails);
    const replay = await action("ddplay-native",{type:"spin"},id,appB); expect(replay).toMatchObject({replayed:true,points:370,nativeDDPlay:{spins:3}});
    expect(replay).not.toHaveProperty("nativeDDPlayAction"); expect(await saved()).toEqual(after); passed++;
  });
  it("rolls back DDPlay wallet/state and already-written mail stacks when the final receipt INSERT fails, then retries exactly once", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},100,0)`);
    await action("ddplay-native",{type:"spin"}); const before = await saved(), w = await wallet(), id = randomUUID();
    expect(w).toEqual({Points:190,Revision:1});
    // UUID is generated here, never user input. The final transaction statement fails AFTER mail, wallet and state writes.
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${id}') NOT VALID`));
    const failed = await post(appB,"ddplay-native",{type:"exchange",count:6},id);
    expect(failed.statusCode,failed.body).toBe(500); expect(failed.body).not.toMatch(/native_test_receipt_failure|INSERT|UPDATE|Annex/); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const result = await race("ddplay-receipt-tail-failure-retry",duplicates("ddplay-native",{type:"exchange",count:6},id));
    duplicateResults(result,"nativeDDPlayAction"); expect(await wallet()).toEqual({Points:w.Points-60,Revision:w.Revision+1});
    const fresh = result.find(response=>!response.json().replayed)!.json<ActivityResult>();
    expect(fresh).toMatchObject({points:130,mailedCount:1,nativeDDPlayAction:{requestId:id,effects:[{type:"exchanged",count:6,cost:60,itemCount:6,score:130}]}});
    const after = await saved(); expect(after.receipts.length-before.receipts.length).toBe(1); expect(after.goods.length-before.goods.length).toBe(2); expect(after.mails.length-before.mails.length).toBe(1);
    const items = after.goods.slice(before.goods.length), mails = after.mails.slice(before.mails.length);
    expect(items.map(item=>item.Count)).toEqual([5,1]); expect(items.every(item=>item.TemplateID===11019&&item.UserID===0&&item.Place===-1&&item.IsBinds===true)).toBe(true);
    expect(mails[0].ReceiverID).toBe(uid); expect([Number(mails[0].Annex1),Number(mails[0].Annex2)]).toEqual(items.map(item=>item.ItemID));
    expect(after.states).not.toEqual(before.states); expect(await snapshot()).toMatchObject({points:130,nativeDDPlay:{spins:1,lastResult:{multiplier:10,reels:[3,3,3]}}});
    const replay = await action("ddplay-native",{type:"exchange",count:6},id,appA); expect(replay).toMatchObject({replayed:true,mailedCount:1,points:130});
    expect(replay).not.toHaveProperty("nativeDDPlayAction"); expect(await saved()).toEqual(after); passed++;
  });
  it("keeps free refresh exact under competing UUIDs, charges one paid refresh/buy and shares eight-slot stock with legacy purchases", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},100,0)`);
    const free = await race("gypsy-native-free-refresh-different-uuids", [
      () => post(appA,"gypsy-native",{type:"refresh",choice:"free"}), () => post(appB,"gypsy-native",{type:"refresh",choice:"free"})]);
    expect(free.map(response=>response.statusCode).sort()).toEqual([200,400]); expect(await wallet()).toEqual({Points:100,Revision:1});
    const first = await snapshot(); expect(first.nativeGypsy).toMatchObject({refreshes:1,shelfKey:`${day}:1`,refreshCost:5,freeRefresh:false});
    expect(first.nativeGypsy.offers).toHaveLength(8); expect((await saved()).receipts).toHaveLength(1);
    const refreshId = randomUUID(), refreshed = await race("gypsy-native-paid-refresh-same-uuid", duplicates("gypsy-native",{type:"refresh",choice:"points"},refreshId));
    duplicateResults(refreshed,"nativeGypsyAction"); expect(await wallet()).toEqual({Points:95,Revision:2});
    expect(refreshed.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeGypsyAction:{requestId:refreshId,
      effects:[{type:"refreshed",shelfKey:`${day}:2`,offerCount:8,cost:5,score:95,free:false}]}});
    const beforeStale = await saved(); expect((await post(appA,"gypsy-native",{type:"buy",index:0,choice:first.nativeGypsy.shelfKey!})).statusCode).toBe(400);
    expect(await saved()).toEqual(beforeStale);
    const buyId = randomUUID(), value = {type:"buy",index:0,choice:`${day}:2`};
    const bought = await race("gypsy-native-buy-same-uuid",duplicates("gypsy-native",value,buyId)); duplicateResults(bought,"nativeGypsyAction");
    expect(await wallet()).toEqual({Points:80,Revision:3}); expect((await snapshot()).nativeGypsy.offers[4]).toMatchObject({templateId:11019,sold:false});
    const beforeConflict = await saved(); expect((await post(appB,"ddplay-native",{type:"spin"},buyId)).statusCode).toBe(409); expect(await saved()).toEqual(beforeConflict);
    const shared = await race("gypsy-legacy-native-shared-stock-different-uuids",[
      ()=>post(appA,"gypsy",{type:"buy",index:4}),()=>post(appB,"gypsy-native",{type:"buy",index:4,choice:`${day}:2`})]);
    expect(shared.map(response=>response.statusCode).sort()).toEqual([200,400]); expect(await wallet()).toEqual({Points:65,Revision:4});
    const after = await saved(); expect(after.receipts).toHaveLength(4); expect(after.goods).toHaveLength(2); expect(after.mails).toHaveLength(2);
    expect(after.goods.map(item=>item.Count)).toEqual([3,3]); expect(after.goods.every(item=>item.TemplateID===11019&&item.IsBinds===true)).toBe(true);
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State;
    expect(state.completed.gypsy).toBe(2); expect(state.games).not.toHaveProperty("gypsyNativeV1");
    expect((await snapshot()).nativeGypsy.offers.filter(item=>item.sold).map(item=>item.index)).toEqual([0,4]);
    const legacy = await action("gypsy",{type:"refresh"}); expect(legacy.points).toBe(60); expect(legacy.nativeGypsy.offers).toHaveLength(3);
    expect(legacy).not.toHaveProperty("nativeGypsyAction"); const final = await saved();
    const replay = await action("gypsy-native",value,buyId,appB); expect(replay).toMatchObject({replayed:true,points:60});
    expect(replay.nativeGypsy.offers).toHaveLength(3); expect(replay).not.toHaveProperty("nativeGypsyAction"); expect(await saved()).toEqual(final); passed++;
  });
  it("rolls back Gypsy stock, charge and written mail on the final receipt failure, then buys the same package UUID once", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},100,0)`);
    const shelf = await action("gypsy-native",{type:"refresh",choice:"free"}), before = await saved(), id = randomUUID();
    const value = {type:"buy",index:0,choice:shelf.nativeGypsy.shelfKey!};
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    // This final receipt constraint is checked AFTER sendMail, wallet UPDATE and shared shelf INSERT.
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${id}') NOT VALID`));
    const failed = await post(appB,"gypsy-native",value,id); expect(failed.statusCode,failed.body).toBe(500);
    expect(failed.body).not.toMatch(/native_test_receipt_failure|INSERT|UPDATE|Annex/); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const retry = await race("gypsy-receipt-tail-failure-retry-same-uuid",duplicates("gypsy-native",value,id)); duplicateResults(retry,"nativeGypsyAction");
    expect(await wallet()).toEqual({Points:85,Revision:2}); const fresh = retry.find(response=>!response.json().replayed)!.json<ActivityResult>();
    expect(fresh).toMatchObject({mailedCount:1,nativeGypsyAction:{requestId:id,effects:[{type:"bought",shelfKey:value.choice,index:0,templateId:11019,itemCount:3,cost:15,score:85}]}});
    const after = await saved(), items = after.goods.slice(before.goods.length), mails = after.mails.slice(before.mails.length);
    expect(after.receipts.length-before.receipts.length).toBe(1); expect(items.map(item=>item.Count)).toEqual([3]); expect(mails).toHaveLength(1);
    expect(items.every(item=>item.TemplateID===11019&&item.UserID===0&&item.Place===-1&&item.IsBinds===true&&item.ValidDate===0)).toBe(true);
    expect(mails[0].ReceiverID).toBe(uid); expect(Number(mails[0].Annex1)).toBe(items[0].ItemID); expect(mails[0].Annex2).toBeNull();
    expect((await snapshot()).nativeGypsy.offers[0]).toMatchObject({sold:true,canBuy:false});
    expect((await snapshot()).nativeGypsy.offers[4]).toMatchObject({sold:false,canBuy:true});
    const replay = await action("gypsy-native",value,id,appA); expect(replay).toMatchObject({replayed:true,mailedCount:1,points:85});
    expect(replay).not.toHaveProperty("nativeGypsyAction"); expect(await saved()).toEqual(after); passed++;
  });
  it("deduplicates native Moonlight three-box draws and serializes legacy/native draws into their shared bag", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    const initial = await snapshot(), id = randomUUID(), value = {type:"draw",count:3,choice:initial.nativeMoonlight.bagToken};
    const same = await race("moonlight-native-three-draws-same-uuid",duplicates("moonlight-native",value,id));
    duplicateResults(same,"nativeMoonlightAction"); expect(await wallet()).toEqual({Points:940,Revision:1});
    expect(same.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeMoonlight:{draws:3,bagSlotsUsed:3},
      nativeMoonlightAction:{requestId:id,effects:[{type:"drawn",count:3,cost:60,score:940,draws:3,rewards:[{templateId:11002,itemCount:3}]}]}});
    const first = await snapshot();
    const raced = await race("moonlight-legacy-native-draws-different-uuids",[
      ()=>post(appA,"moon",{type:"draw",count:2}),
      ()=>post(appB,"moonlight-native",{type:"draw",count:1,choice:first.nativeMoonlight.bagToken})]);
    expect(raced[0].statusCode,raced[0].body).toBe(200); expect([200,400]).toContain(raced[1].statusCode);
    // Native must reject a stale quote if the unquoted legacy draw obtains the wallet lock first.
    const nativeWon = raced[1].statusCode===200, draws = nativeWon?6:5, current = await snapshot(), after = await saved();
    expect(raced[0].json()).not.toHaveProperty("nativeMoonlightAction");
    if(nativeWon) expect(raced[1].json()).toMatchObject({nativeMoonlightAction:{effects:[{type:"drawn",count:1,cost:20,score:920,draws:4}]}});
    else {
      expect(raced[1].json().message).toBe("临时包、商品或日期已更新，请重新查看后再确认。");
      expect(raced[1].json()).not.toHaveProperty("nativeMoonlightAction");
    }
    expect(await wallet()).toEqual({Points:nativeWon?880:900,Revision:nativeWon?3:2});
    expect(current.nativeMoonlight).toMatchObject({draws,bagSlotsUsed:draws,bag:[{index:0,templateId:11002,itemCount:draws,recycleUnitPoints:2}]});
    expect(after.receipts).toHaveLength(nativeWon?3:2); expect(after.goods).toEqual([]); expect(after.mails).toEqual([]);
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State;
    expect(state.completed.moon).toBe(nativeWon?3:2); expect(state.games).not.toHaveProperty("moonlightNativeV1");
    const replay = await action("moonlight-native",value,id,appB); expect(replay).toMatchObject({...latestView(current),replayed:true});
    expect(replay).not.toHaveProperty("nativeMoonlightAction");
    expect((await post(appA,"ddplay-native",{type:"spin"},id)).statusCode).toBe(409); expect(await saved()).toEqual(after); passed++;
  });
  it("settles only one competing Moonlight take/recycle selection and preserves the unselected shared bag", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    const quote = (await snapshot()).nativeMoonlight.bagToken;
    await action("moonlight-native",{type:"draw",count:3,choice:quote});
    const ready = await action("moon",{type:"draw",count:2}), before = await saved();
    const choice = ready.nativeMoonlight.bagToken, items = [{index:0,count:2}];
    const competing = await race("moonlight-partial-take-recycle-different-uuids",[
      ()=>post(appA,"moonlight-native",{type:"take",choice,items}),
      ()=>post(appB,"moonlight-native",{type:"recycle",choice,items})]);
    expect(competing.map(response=>response.statusCode).sort()).toEqual([200,400]);
    const committed = competing.find(response=>response.statusCode===200)!.json<ActivityResult>(), took = committed.nativeMoonlightAction!.effects[0].type==="taken";
    const after = await saved(), current = await snapshot(); expect(await wallet()).toEqual({Points:took?900:904,Revision:3});
    expect(current.nativeMoonlight).toMatchObject({draws:5,bagSlotsUsed:3,bag:[{index:0,templateId:11002,itemCount:3}]});
    expect(after.receipts.length-before.receipts.length).toBe(1); expect(after.goods).toHaveLength(took?1:0); expect(after.mails).toHaveLength(took?1:0);
    if(took) {
      expect(committed.nativeMoonlightAction).toMatchObject({effects:[{type:"taken",itemCount:2,items:[{index:0,templateId:11002,itemCount:2}]}]});
      expect(after.goods[0]).toMatchObject({Count:2,TemplateID:11002,IsBinds:true,UserID:0,Place:-1,ValidDate:0});
      expect(Number(after.mails[0].Annex1)).toBe(after.goods[0].ItemID); expect(after.mails[0].Annex2).toBeNull();
    } else expect(committed.nativeMoonlightAction).toMatchObject({effects:[{type:"recycled",pointsAwarded:4,score:904,items:[{index:0,templateId:11002,itemCount:2}]}]});
    expect((await post(appA,"moonlight-native",{type:"take",choice,items})).statusCode).toBe(400);
    const expired = `${new Date(Date.parse(`${day}T00:00:00Z`)-86400000).toISOString().slice(0,10)}:${current.nativeMoonlight.bagToken.split(":")[1]}`;
    expect((await post(appB,"moonlight-native",{type:"draw",count:1,choice:expired})).statusCode).toBe(400);
    expect(await saved()).toEqual(after); passed++;
  });
  it("rolls back Moonlight selected mail and recycled points on final receipt failures, then retries each UUID once without consuming the remainder", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    const first = await action("moonlight-native",{type:"draw",count:5,choice:(await snapshot()).nativeMoonlight.bagToken});
    const ready = await action("moonlight-native",{type:"draw",count:5,choice:first.nativeMoonlight.bagToken});
    expect(ready.nativeMoonlight.bag).toMatchObject([{index:0,templateId:11002,itemCount:9},{index:1,templateId:11021,itemCount:2}]);
    const id = randomUUID(), value = {type:"take",choice:ready.nativeMoonlight.bagToken,items:[{index:0,count:7},{index:1,count:1}]}, before = await saved();
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    // Fails after all selected stacks/mail, shared bag, wallet revision and state writes; MaxCount remains five.
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${id}') NOT VALID`));
    const failed = await post(appB,"moonlight-native",value,id); expect(failed.statusCode,failed.body).toBe(500);
    expect(failed.body).not.toMatch(/native_test_receipt_failure|INSERT|UPDATE|Annex/); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const retry = await race("moonlight-selected-mail-tail-failure-retry-same-uuid",duplicates("moonlight-native",value,id));
    duplicateResults(retry,"nativeMoonlightAction"); expect(await wallet()).toEqual({Points:800,Revision:3});
    const fresh = retry.find(response=>!response.json().replayed)!.json<ActivityResult>();
    expect(fresh).toMatchObject({mailedCount:1,nativeMoonlightAction:{requestId:id,effects:[{type:"taken",itemCount:8,items:[
      {index:0,templateId:11002,itemCount:7},{index:1,templateId:11021,itemCount:1}]}]}});
    const delivered = await saved(); expect(delivered.goods.map(item=>[item.TemplateID,item.Count])).toEqual([[11002,5],[11002,2],[11021,1]]);
    expect(delivered.goods.every(item=>item.UserID===0&&item.Place===-1&&item.IsBinds===true&&item.ValidDate===0)).toBe(true);
    expect(delivered.mails).toHaveLength(1); expect([delivered.mails[0].Annex1,delivered.mails[0].Annex2,delivered.mails[0].Annex3].map(Number)).toEqual(delivered.goods.map(item=>item.ItemID));
    expect(delivered.mails[0].Annex4).toBeNull(); expect(delivered.receipts.length-before.receipts.length).toBe(1);
    const remaining = await snapshot(); expect(remaining.nativeMoonlight).toMatchObject({bagSlotsUsed:3,bag:[{index:0,templateId:11002,itemCount:2},{index:1,templateId:11021,itemCount:1}]});
    const recycleId = randomUUID(), recycle = {type:"recycle",choice:remaining.nativeMoonlight.bagToken,items:[{index:0,count:1}]};
    assert.match(recycleId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${recycleId}') NOT VALID`));
    expect((await post(appA,"moonlight-native",recycle,recycleId)).statusCode).toBe(500); expect(await saved()).toEqual(delivered);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const recycled = await race("moonlight-selected-recycle-tail-failure-retry-same-uuid",duplicates("moonlight-native",recycle,recycleId));
    duplicateResults(recycled,"nativeMoonlightAction"); expect(await wallet()).toEqual({Points:802,Revision:4});
    expect(recycled.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeMoonlightAction:{requestId:recycleId,effects:[{type:"recycled",pointsAwarded:2,score:802}]}});
    const final = await saved(); expect(final.goods).toEqual(delivered.goods); expect(final.mails).toEqual(delivered.mails);
    expect(final.receipts.length-delivered.receipts.length).toBe(1); expect((await snapshot()).nativeMoonlight).toMatchObject({bagSlotsUsed:2,bag:[{index:0,itemCount:1},{index:1,itemCount:1}]});
    const replay = await action("moonlight-native",value,id,appB); expect(replay).toMatchObject({replayed:true,mailedCount:1,points:802});
    expect(replay).not.toHaveProperty("nativeMoonlightAction"); expect(await saved()).toEqual(final); passed++;
  });
  it("deduplicates five original Treasure draws and serializes old/native v2 calls with local-only classifications", async () => {
    await treasureSeed(); await treasureReady(); const initial = await snapshot(), unavailable = await saved();
    expect(initial.nativeTreasure).toMatchObject({version:2,bagCapacity:100,readiness:{status:"ready",totalRows:158,readyRows:158}});
    expect(initial.nativeTreasure.categories).toHaveLength(15); expect(initial.nativeTreasure.preview).toHaveLength(158);
    expect(initial.nativeTreasure.categories.filter(row=>row.selectable)).toHaveLength(14);
    expect(initial.nativeTreasure.categories[14]).toMatchObject({sourceOriginalIndex:15,selectable:false,special:true});
    expect((await post(appA,"treasure-native",{type:"choose",index:3,marked:false,choice:initial.nativeTreasure.bagToken})).statusCode).toBe(400);
    expect((await post(appB,"treasure",{type:"category",choice:"朱雀石2级"})).statusCode).toBe(400);
    const value = await treasureDraw(5,"advanced"), id = randomUUID();
    expect((await post(appB,"treasure-native",{...value,selection:[1,2,3,15]})).statusCode).toBe(400);
    expect((await post(appB,"treasure-native",{...value,selection:[1,2,3,3]})).statusCode).toBe(400);
    expect(await saved()).toEqual(unavailable); expect(random.calls).toBe(0);
    const same = await race("treasure-v2-five-advanced-draws-same-uuid",duplicates("treasure-native",value,id));
    duplicateResults(same,"nativeTreasureAction"); expect(await wallet()).toEqual({Points:700,Revision:1});
    const first = await snapshot(), last = TREASURE_ENTRIES.at(-1)!;
    expect(first.nativeTreasure).toMatchObject({draws:5,bagSlotsUsed:5});
    expect(first.nativeTreasure.bag.map(row=>[row.index,row.templateId,row.itemCount])).toEqual(Array.from({length:5},(_,index)=>[index,last.templateId,last.count]));
    expect(same.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeTreasureAction:{requestId:id,
      effects:[{type:"drawn",mode:"advanced",count:5,cost:300,score:700,draws:5,
        rewards:Array.from({length:5},(_,index)=>({index,entryKey:last.entryKey,sourceOriginalIndex:15,templateId:last.templateId,itemCount:last.count}))}]}});
    const competing = await race("treasure-v2-old-native-stale-token-different-uuids",[
      ()=>post(appA,"treasure",{...value,mode:"normal",selection:[],count:2,choice:first.nativeTreasure.bagToken}),
      ()=>post(appB,"treasure-native",{...value,mode:"normal",selection:[],count:1,choice:first.nativeTreasure.bagToken})]);
    expect(competing.map(r=>r.statusCode).sort()).toEqual([200,400]);
    const nativeWon=competing[1].statusCode===200,draws=nativeWon?6:7,current=await snapshot(),after=await saved();
    if(nativeWon)expect(competing[1].json()).toHaveProperty("nativeTreasureAction");
    else expect(competing[0].json()).not.toHaveProperty("nativeTreasureAction");
    expect(competing.find(r=>r.statusCode===400)!.json().message).toContain("临时包或日期已更新");
    expect(await wallet()).toEqual({Points:nativeWon?670:640,Revision:2});
    expect(current.nativeTreasure).toMatchObject({draws,bagSlotsUsed:draws});
    // 0.99 selects source row157 in the 158-row normal pool, but the final row in this advanced pool.
    const normalPick=TREASURE_ENTRIES.at(-2)!;
    expect(current.nativeTreasure.bag.map(row=>[row.index,row.templateId,row.itemCount])).toEqual([
      ...Array.from({length:5},(_,index)=>[index,last.templateId,last.count]),
      ...Array.from({length:draws-5},(_,index)=>[index+5,normalPick.templateId,normalPick.count])]);
    expect(random.calls).toBe(draws);
    expect(after.receipts).toHaveLength(2); expect(after.goods).toEqual([]); expect(after.mails).toEqual([]);
    const state=after.states[0].State as ActivityState;
    expect(state.games).not.toHaveProperty("treasureNativeV1"); expect(state.games.treasure).toMatchObject({version:2,pity:0}); expect(state.daily.actions).toBe(2);
    const replay=await action("treasure-native",value,id,appB);expect(replay).toMatchObject({...latestView(current),replayed:true});
    expect(replay).not.toHaveProperty("nativeTreasureAction");
    expect((await post(appA,"treasure-native",{...value,selection:[1,7,14,12]},id)).statusCode).toBe(409);
    expect((await post(appA,"moonlight-native",{type:"draw",count:1,choice:(await snapshot()).nativeMoonlight.bagToken},id)).statusCode).toBe(409);
    expect(await saved()).toEqual(after); passed++;
  });
  it("takes one legacy Treasure slot per UUID and settles one native-take/legacy-recycle whole-bag competitor while the new pool is blocked", async () => {
    await treasureLegacyBag(Array.from({length:5},()=>({templateId:11002,count:2})));
    const ready=await snapshot();expect(ready.nativeTreasure.readiness.status).toBe("blocked");
    const id=randomUUID(),value={type:"take",index:2,choice:ready.nativeTreasure.bagToken},before=await saved();
    const one=await race("treasure-legacy-single-slot-take-same-uuid",duplicates("treasure-native",value,id));
    duplicateResults(one,"nativeTreasureAction");expect(await wallet()).toEqual({Points:1000,Revision:1});
    const partial=await saved(),current=await snapshot();
    expect(current.nativeTreasure.bag.map(row=>[row.index,row.templateId,row.itemCount])).toEqual(Array.from({length:4},(_,index)=>[index,11002,2]));
    expect(current.nativeTreasure.bag.every(row=>row.origin==="legacy-four-material")).toBe(true);
    expect(current.nativeTreasure.bagToken).not.toBe(ready.nativeTreasure.bagToken);
    expect(partial.goods.map(item=>[item.TemplateID,item.Count])).toEqual([[11002,2]]);expect(partial.mails).toHaveLength(1);
    expect(partial.goods[0]).toMatchObject({UserID:0,Place:-1,IsBinds:true,ValidDate:0});expect(Number(partial.mails[0].Annex1)).toBe(partial.goods[0].ItemID);
    expect(partial.receipts.length-before.receipts.length).toBe(1);
    expect(one.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeTreasureAction:{requestId:id,effects:[{type:"taken",itemCount:2,items:[{index:2,templateId:11002,itemCount:2}]}]}});
    expect((await post(appA,"treasure-native",{type:"take",index:2,choice:ready.nativeTreasure.bagToken})).statusCode).toBe(400);expect(await saved()).toEqual(partial);
    const whole=await race("treasure-native-take-legacy-recycle-different-uuids",[
      ()=>post(appA,"treasure-native",{type:"take",choice:current.nativeTreasure.bagToken}),()=>post(appB,"treasure",{type:"recycle"})]);
    expect(whole.map(response=>response.statusCode).sort()).toEqual([200,400]);
    const took=whole[0].statusCode===200,after=await saved();expect(await wallet()).toEqual({Points:took?1000:1016,Revision:2});
    expect((await snapshot()).nativeTreasure.bag).toEqual([]);expect(after.receipts.length-partial.receipts.length).toBe(1);
    if(took){expect(whole[0].json()).toMatchObject({mailedCount:1,nativeTreasureAction:{effects:[{type:"taken",itemCount:8}]}});
      expect(after.goods.slice(partial.goods.length).map(item=>item.Count)).toEqual([2,2,2,2]);expect(after.mails.length-partial.mails.length).toBe(1);
    }else{expect(whole[1].json()).not.toHaveProperty("nativeTreasureAction");expect(after.goods).toEqual(partial.goods);expect(after.mails).toEqual(partial.mails);}
    const expired=`${new Date(Date.parse(`${day}T00:00:00Z`)-86400000).toISOString().slice(0,10)}:${current.nativeTreasure.bagToken.split(":")[1]}`;
    expect((await post(appB,"treasure-native",{...await treasureDraw(),choice:expired})).statusCode).toBe(400);
    const replay=await action("treasure-native",value,id,appA);expect(replay).toMatchObject({replayed:true,mailedCount:1});expect(replay.nativeTreasure.bag).toEqual([]);
    expect(replay).not.toHaveProperty("nativeTreasureAction");expect(await saved()).toEqual(after);expect(random.calls).toBe(0);passed++;
  });
  it("reverts earned legacy Treasure full-bag mail and recycle credits on receipt failures, then retries each UUID once", async () => {
    const bag=[...Array.from({length:9},()=>({templateId:11002,count:2})),{templateId:11021,count:4}];
    await treasureLegacyBag(bag);const ready=await snapshot();expect(ready.nativeTreasure.bag.map(row=>[row.templateId,row.itemCount])).toEqual(bag.map(row=>[row.templateId,row.count]));
    const id=randomUUID(),value={type:"take",choice:ready.nativeTreasure.bagToken},before=await saved();
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${id}') NOT VALID`));
    const failed=await post(appB,"treasure-native",value,id);expect(failed.statusCode,failed.body).toBe(500);
    expect(failed.body).not.toMatch(/native_test_receipt_failure|INSERT|UPDATE|Annex/);expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const retry=await race("treasure-legacy-full-mail-tail-failure-retry-same-uuid",duplicates("treasure-native",value,id));
    duplicateResults(retry,"nativeTreasureAction");expect(await wallet()).toEqual({Points:1000,Revision:1});
    const delivered=await saved(),items=delivered.goods.slice(before.goods.length),mails=delivered.mails.slice(before.mails.length);
    expect(retry.find(response=>!response.json().replayed)!.json()).toMatchObject({mailedCount:2,nativeTreasureAction:{requestId:id,effects:[{type:"taken",itemCount:22}]}});
    expect(items.map(item=>[item.TemplateID,item.Count])).toEqual([...Array.from({length:9},()=>[11002,2]),[11021,4]]);expect(mails).toHaveLength(2);
    expect(items.every(item=>item.UserID===0&&item.Place===-1&&item.IsBinds===true&&item.ValidDate===0&&Number(item.Count)<=5)).toBe(true);
    expect(items.filter(item=>item.TemplateID===11002).reduce((sum,item)=>sum+Number(item.Count),0)).toBe(18);
    expect(items.filter(item=>item.TemplateID===11021).reduce((sum,item)=>sum+Number(item.Count),0)).toBe(4);
    expect(mails.flatMap(mail=>[mail.Annex1,mail.Annex2,mail.Annex3,mail.Annex4,mail.Annex5].filter(Boolean).map(Number))).toEqual(items.map(item=>item.ItemID));
    expect(delivered.receipts.length-before.receipts.length).toBe(1);expect((await snapshot()).nativeTreasure.bag).toEqual([]);
    // This deliberately seeds another pre-v2 entitlement; no v2 original prize may use the material recycle rule.
    await editState(uid,state=>{const saved=state.games.treasure as {bag:unknown[]};saved.bag=[{templateId:11002,count:2,origin:"legacy-four-material"}];});
    const recycleId=randomUUID(),recycle={type:"recycle",choice:(await snapshot()).nativeTreasure.bagToken},recycleBefore=await saved();
    assert.match(recycleId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${recycleId}') NOT VALID`));
    const recycleSaved=await saved();expect((await post(appA,"treasure-native",recycle,recycleId)).statusCode).toBe(500);expect(await saved()).toEqual(recycleSaved);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const recycled=await race("treasure-legacy-full-recycle-tail-failure-retry-same-uuid",duplicates("treasure-native",recycle,recycleId));
    duplicateResults(recycled,"nativeTreasureAction");expect(await wallet()).toEqual({Points:1004,Revision:2});
    expect(recycled.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeTreasureAction:{requestId:recycleId,effects:[{type:"recycled",pointsAwarded:4,score:1004}]}});
    const final=await saved();expect(final.goods).toEqual(recycleBefore.goods);expect(final.mails).toEqual(recycleBefore.mails);
    expect(final.receipts.length-recycleBefore.receipts.length).toBe(1);expect((await snapshot()).nativeTreasure.bag).toEqual([]);
    const replay=await action("treasure-native",value,id,appB);expect(replay).toMatchObject({replayed:true,points:1004});
    expect(replay).not.toHaveProperty("nativeTreasureAction");expect(await saved()).toEqual(final);expect(random.calls).toBe(0);passed++;
  });
  it("locks the real full 157-target Treasure catalog before RNG and keeps every blocked draw free of charges, mail or receipts", async () => {
    await treasureSeed();await treasureTemplatesFixture();expect(futureTreasureEvidence.ready).toBe(false);
    const id=randomUUID(),value=await treasureDraw(1,"advanced"),before=await saved();
    const failed=await treasureLockWait("treasure-full-157-unselected-target-real-blocked",
      sql`SELECT "TemplateID" FROM game."Shop_Goods" WHERE "TemplateID"=11019 FOR UPDATE`,
      ()=>post(appA,"treasure-native",value,id),"FOR SHARE",async()=>{
        expect(random.calls).toBe(0);const observed=scenarios.at(-1) as {observed:{query:string}};
        expect(observed.observed.query).toContain('game."Shop_Goods"');expect(observed.observed.query).toMatch(/ORDER BY "TemplateID".*FOR SHARE/s);
        expect(new Set(observed.observed.query.match(/\$\d+/g)).size).toBe(157);
      },sql`UPDATE game."Shop_Goods" SET "Pic"='native-test-invalid-identity' WHERE "TemplateID"=11019`);
    expect(failed.statusCode,failed.body).toBe(400);expect(failed.json().message).toContain("完整奖池");expect(random.calls).toBe(0);expect(await saved()).toEqual(before);
    expect((await snapshot()).nativeTreasure).toMatchObject({readiness:{status:"blocked"},draws:0,bagSlotsUsed:0});expect(await wallet()).toEqual({Points:1000,Revision:0});
    await monitor.db.execute(sql`UPDATE game."Shop_Goods" SET "Pic"='strength1' WHERE "TemplateID"=11019`);
    futureTreasureEvidence.ready=true;const result=await action("treasure-native",value,id);expect(result.nativeTreasure).toMatchObject({draws:1,bagSlotsUsed:1});
    expect(await wallet()).toEqual({Points:940,Revision:1});expect(random.calls).toBe(1);
    const committed=await saved();expect(committed.receipts.length-before.receipts.length).toBe(1);expect(committed.goods).toEqual(before.goods);expect(committed.mails).toEqual(before.mails);
    futureTreasureEvidence.ready=false;await monitor.db.execute(sql`UPDATE game."Shop_Goods" SET "Pic"='native-test-invalid-identity' WHERE "TemplateID"=11019`);
    const replay=await action("treasure-native",value,id,appB);expect(replay).toMatchObject({replayed:true,nativeTreasure:{readiness:{status:"blocked"}}});
    expect(replay).not.toHaveProperty("nativeTreasureAction");expect(random.calls).toBe(1);expect(await saved()).toEqual(committed);
    await monitor.db.execute(sql`UPDATE game."Shop_Goods" SET "Pic"='strength1' WHERE "TemplateID"=11019`);passed++;
  });
  it("rejects an old native Treasure day token after a real full-catalog lock wait crosses UTC midnight", async () => {
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(day+"T23:59:59Z"));
    await treasureSeed();await treasureReady();const id=randomUUID(),value=await treasureDraw(),before=await saved();
    const tomorrow=new Date(Date.parse(day+"T00:00:00Z")+86400000).toISOString().slice(0,10);
    const failed=await treasureLockWait("treasure-native-full-catalog-wait-midnight",
      sql`SELECT "TemplateID" FROM game."Shop_Goods" WHERE "TemplateID"=11019 FOR UPDATE`,()=>post(appA,"treasure-native",value,id),"FOR SHARE",async()=>{
        expect(random.calls).toBe(0);vi.setSystemTime(new Date(tomorrow+"T00:00:01Z"));});
    expect(failed.statusCode,failed.body).toBe(400);expect(failed.json().message).toContain("日期已更新");expect(random.calls).toBe(0);expect(await saved()).toEqual(before);
    const fresh=await snapshot();expect(fresh.nativeTreasure.bagToken.startsWith(tomorrow+":")).toBe(true);
    const result=await action("treasure-native",{...value,choice:fresh.nativeTreasure.bagToken},id);
    expect(result.nativeTreasure).toMatchObject({day:tomorrow,draws:1,bagSlotsUsed:1});expect(await wallet()).toEqual({Points:970,Revision:1});expect(random.calls).toBe(1);
    const after=await saved(),state=after.states[0].State as ActivityState;expect(state.day).toBe(tomorrow);expect(state.daily).toMatchObject({actions:1,draws:1});expect(after.receipts).toHaveLength(1);passed++;
  });
  it("refreshes old-web Treasure v2 tokens after a UTC lock wait and resets yesterday's exhausted daily counters only on successful retry", async () => {
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(day+"T23:59:59Z"));
    await treasureSeed(new Date(),500);await treasureReady();const id=randomUUID(),before=await saved(),value=await treasureDraw(2);
    const tomorrow=new Date(Date.parse(day+"T00:00:00Z")+86400000).toISOString().slice(0,10);
    const response=await treasureLockWait("treasure-old-web-v2-full-catalog-wait-midnight",
      sql`SELECT "TemplateID" FROM game."Shop_Goods" WHERE "TemplateID"=11019 FOR UPDATE`,()=>post(appA,"treasure",value,id),"FOR SHARE",async()=>{
        expect(random.calls).toBe(0);vi.setSystemTime(new Date(tomorrow+"T00:00:01Z"));});
    expect(response.statusCode,response.body).toBe(400);expect(response.json().message).toContain("日期已更新");expect(random.calls).toBe(0);expect(await saved()).toEqual(before);
    const fresh=await snapshot(),result=await action("treasure",{...value,choice:fresh.nativeTreasure.bagToken},id);
    expect(result).not.toHaveProperty("nativeTreasureAction");expect(result.nativeTreasure).toMatchObject({day:tomorrow,draws:2,bagSlotsUsed:2});
    expect(await wallet()).toEqual({Points:940,Revision:1});expect(random.calls).toBe(2);
    const after=await saved(),state=after.states[0].State as ActivityState;expect(state.day).toBe(tomorrow);expect(state.daily).toMatchObject({actions:1,draws:2});
    expect(state.history.at(-1)).toContain(tomorrow);expect(after.receipts.length-before.receipts.length).toBe(1);expect(after.goods).toEqual(before.goods);expect(after.mails).toEqual(before.mails);passed++;
  });
  it("holds all 157 Treasure template share locks through the final receipt and releases each after commit", async () => {
    await treasureSeed();await treasureReady();const id=randomUUID(),value=await treasureDraw(1,"advanced"),before=await saved();
    const response=await treasureLockWait("treasure-full-157-shares-held-through-commit",
      sql`LOCK TABLE app."ActivityActions" IN SHARE MODE`,()=>post(appA,"treasure-native",value,id),'INSERT INTO app."ActivityActions"',async()=>{
        expect(random.calls).toBe(1);
        for(const templateId of TREASURE_IDS)await expect(b.db.transaction(tx=>tx.execute(sql`SELECT "TemplateID" FROM game."Shop_Goods" WHERE "TemplateID"=${templateId} FOR UPDATE NOWAIT`)))
          .rejects.toMatchObject({cause:{code:"55P03"}});
      });
    expect(response.statusCode,response.body).toBe(200);expect(await wallet()).toEqual({Points:940,Revision:1});
    await b.db.transaction(async tx=>{const rows=await q<{TemplateID:number}>({...b,db:tx},sql`SELECT "TemplateID" FROM game."Shop_Goods" WHERE "TemplateID" IN (${sql.join(TREASURE_IDS.map(id=>sql`${id}`),sql`,`)}) ORDER BY "TemplateID" FOR UPDATE NOWAIT`);
      expect(rows.map(row=>row.TemplateID)).toEqual(TREASURE_IDS);});
    const after=await saved();expect(after.receipts.length-before.receipts.length).toBe(1);expect(after.goods).toEqual(before.goods);expect(after.mails).toEqual(before.mails);passed++;
  });
  it("deduplicates native Wheel start, invalidates protected-failure tokens and preserves both slots under old/native wallet contention", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    const id = randomUUID(), value = {type:"start",choice:(await snapshot()).nativeWheel.roundToken};
    const same = await race("wheel-native-start-same-uuid",duplicates("wheel-native",value,id));
    duplicateResults(same,"nativeWheelAction"); expect(await wallet()).toEqual({Points:980,Revision:1});
    const first = await snapshot(); expect(first.nativeWheel).toMatchObject({round:1,spinCount:1,phase:"active",level:1,category:5,
      roundMaterial:{templateId:11002},pending:{chipAmount:20,item:null},fragments:0});
    const protectValue = {type:"protect",choice:first.nativeWheel.roundToken};
    const protectedRace = await race("wheel-protected-failure-different-uuids",[
      ()=>post(appA,"wheel-native",protectValue),()=>post(appB,"wheel-native",protectValue)]);
    expect(protectedRace.map(response=>response.statusCode).sort()).toEqual([200,400]); expect(await wallet()).toEqual({Points:960,Revision:2});
    expect(protectedRace.find(response=>response.statusCode===200)!.json()).toMatchObject({nativeWheelAction:{effects:[
      {type:"rotated",action:"protect",spinCount:2,fromLevel:1,toLevel:1,category:5,templateId:11002,success:false,protectedFailure:true,cost:20,score:960}]}});
    const protectedView = await snapshot(); expect(protectedView.nativeWheel).toMatchObject({level:1,spinCount:2,roundMaterial:{templateId:11002},pending:first.nativeWheel.pending});
    expect(protectedView.nativeWheel.roundToken).not.toBe(first.nativeWheel.roundToken);
    const unchanged = await saved(); expect((await post(appA,"wheel-native",protectValue)).statusCode).toBe(400); expect(await saved()).toEqual(unchanged);
    expect((await post(appB,"wheel-native",{type:"continue",choice:value.choice},id)).statusCode).toBe(409); expect(await saved()).toEqual(unchanged);
    random.fraction = 0.1;
    const shared = await race("wheel-legacy-native-distinct-slots-shared-wallet",[
      ()=>post(appA,"wheel",{type:"start"}),()=>post(appB,"wheel-native",{type:"continue",choice:protectedView.nativeWheel.roundToken})]);
    expect(shared.map(response=>response.statusCode)).toEqual([200,200]); expect(shared[0].json()).not.toHaveProperty("nativeWheelAction");
    expect(await wallet()).toEqual({Points:930,Revision:4});
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State;
    expect(state.games.wheel).toEqual({version:1,kind:"wheel",round:1,phase:"active",stars:1});
    expect(state.games.wheelNativeV1).toMatchObject({kind:"wheel-native",category:5,materialIndex:3,level:2,spinCount:3});
    random.fraction = 0.99; const failed = await wheel("continue"); expect(await wallet()).toEqual({Points:920,Revision:5});
    expect(failed).toMatchObject({nativeWheel:{phase:"failed",level:0,spinCount:4,category:5,roundMaterial:{templateId:11002},pending:{chipAmount:20,item:null},canTakeItem:false},
      nativeWheelAction:{effects:[{type:"rotated",action:"continue",fromLevel:2,toLevel:0,success:false,protectedFailure:false,phase:"failed",cost:10}]}});
    const beforeBadTake = await saved(); expect((await post(appA,"wheel-native",{type:"take-item",choice:failed.nativeWheel.roundToken})).statusCode).toBe(400);
    expect(await saved()).toEqual(beforeBadTake); await wheel("take-chip");
    const after = await saved(), current = await snapshot(); expect(current.nativeWheel).toMatchObject({phase:"settled",level:0,pending:null,fragments:20});
    expect(after.goods).toEqual([]); expect(after.mails).toEqual([]);
    const finalState = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State;
    expect(finalState.games.wheel).toEqual(state.games.wheel);
    const replay = await action("wheel-native",value,id,appB); expect(replay).toMatchObject({...latestView(current),replayed:true}); expect(replay).not.toHaveProperty("nativeWheelAction");
    expect(await saved()).toEqual(after); passed++;
  });
  it("chooses one complete native Wheel reward under competing UUIDs and mails the seven-level material once as five plus two", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    await wheel("start"); random.fraction = 0.1; const ready = await wheel("continue");
    expect(ready.nativeWheel.pending).toMatchObject({chipAmount:40,item:{templateId:11002,itemCount:2}});
    const choice = ready.nativeWheel.roundToken;
    const competing = await race("wheel-chip-item-exclusive-different-uuids",[
      ()=>post(appA,"wheel-native",{type:"take-chip",choice}),()=>post(appB,"wheel-native",{type:"take-item",choice})]);
    expect(competing.map(response=>response.statusCode).sort()).toEqual([200,400]); expect(await wallet()).toEqual({Points:970,Revision:3});
    const tookChip = competing[0].statusCode===200, settled = await saved(), current = await snapshot();
    expect(current.nativeWheel).toMatchObject({phase:"settled",pending:null,fragments:tookChip?40:0});
    expect(settled.goods).toHaveLength(tookChip?0:1); expect(settled.mails).toHaveLength(tookChip?0:1);
    if(!tookChip) expect(settled.goods[0]).toMatchObject({TemplateID:11002,Count:2});
    expect((await post(appA,"wheel-native",{type:"take-chip",choice})).statusCode).toBe(400); expect(await saved()).toEqual(settled);
    random.fraction = 0.99; await wheel("start"); random.fraction = 0.1;
    for(let step=0;step<6;step++) await wheel("continue");
    const seven = await snapshot(); expect(seven.nativeWheel).toMatchObject({level:7,category:5,roundMaterial:{templateId:11002},
      canContinue:false,canProtect:false,pending:{chipAmount:140,item:{templateId:11002,itemCount:7}}});
    const id = randomUUID(), value = {type:"take-item",choice:seven.nativeWheel.roundToken}, before = await saved();
    const delivered = await race("wheel-seven-item-take-same-uuid",duplicates("wheel-native",value,id));
    duplicateResults(delivered,"nativeWheelAction"); expect(await wallet()).toEqual({Points:890,Revision:11});
    expect(delivered.find(response=>!response.json().replayed)!.json()).toMatchObject({mailedCount:1,
      nativeWheelAction:{requestId:id,effects:[{type:"item-taken",round:2,templateId:11002,itemCount:7}]}});
    const after = await saved(), items = after.goods.slice(before.goods.length), mails = after.mails.slice(before.mails.length);
    expect(items.map(item=>item.Count)).toEqual([5,2]); expect(items.every(item=>item.TemplateID===11002&&item.UserID===0&&item.Place===-1&&item.IsBinds===true&&item.ValidDate===0)).toBe(true);
    expect(mails).toHaveLength(1); expect([mails[0].Annex1,mails[0].Annex2].map(Number)).toEqual(items.map(item=>item.ItemID)); expect(mails[0].Annex3).toBeNull();
    expect(after.receipts.length-before.receipts.length).toBe(1); expect((await snapshot()).nativeWheel).toMatchObject({pending:null,fragments:tookChip?40:0});
    const replay = await action("wheel-native",value,id,appB); expect(replay.replayed).toBe(true); expect(replay).not.toHaveProperty("nativeWheelAction"); expect(await saved()).toEqual(after); passed++;
  });
  it("rolls back the native Wheel zero-level chip receipt without changing the legacy five-star save, then retries once without virtual goods", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    random.fraction = 0.1; await action("wheel",{type:"start"}); for(let step=0;step<4;step++) await action("wheel",{type:"continue"});
    const legacyState = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State.games.wheel;
    expect(legacyState).toEqual({version:1,kind:"wheel",round:1,phase:"active",stars:5});
    const atFive = await saved(); expect((await post(appA,"wheel",{type:"continue"})).statusCode).toBe(400); expect((await post(appB,"wheel",{type:"protect"})).statusCode).toBe(400); expect(await saved()).toEqual(atFive);
    random.fraction = 0.99; await wheel("start"); const zero = await wheel("continue"); expect(zero.nativeWheel).toMatchObject({level:0,phase:"failed",pending:{chipAmount:20,item:null}});
    const id = randomUUID(), value = {type:"take-chip",choice:zero.nativeWheel.roundToken}, before = await saved();
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${id}') NOT VALID`));
    const failed = await post(appB,"wheel-native",value,id); expect(failed.statusCode,failed.body).toBe(500); expect(failed.body).not.toMatch(/native_test_receipt_failure|INSERT|UPDATE|Annex/); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const retry = await race("wheel-chip-tail-failure-retry-same-uuid",duplicates("wheel-native",value,id)); duplicateResults(retry,"nativeWheelAction");
    expect(await wallet()).toEqual({Points:910,Revision:8}); expect(retry.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeWheelAction:{requestId:id,effects:[{type:"chip-taken",round:1,chipAmount:20,fragments:20}]}});
    const after = await saved(); expect(after.goods).toEqual([]); expect(after.mails).toEqual([]); expect(after.receipts.length-before.receipts.length).toBe(1);
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State;
    expect(state.games.wheel).toEqual(legacyState); expect(state.games.wheelNativeV1).toMatchObject({phase:"settled",level:0,fragments:20,pending:null});
    const replay = await action("wheel-native",value,id,appA); expect(replay.replayed).toBe(true); expect(replay).not.toHaveProperty("nativeWheelAction"); expect(await saved()).toEqual(after); passed++;
  });
  it("rolls back native Wheel exchange mail stacks, chips and final receipt, then retries seven units once and keeps the remaining chips", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    await wheel("start"); await wheel("take-chip"); await wheel("start"); random.fraction = 0.1;
    for(let step=0;step<6;step++) await wheel("continue"); await wheel("take-chip");
    const ready = await snapshot(); expect(ready.nativeWheel.fragments).toBe(160);
    const id = randomUUID(), value = {type:"exchange",index:0,count:7,choice:ready.nativeWheel.roundToken}, before = await saved();
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${id}') NOT VALID`));
    const failed = await post(appB,"wheel-native",value,id); expect(failed.statusCode,failed.body).toBe(500); expect(failed.body).not.toMatch(/native_test_receipt_failure|INSERT|UPDATE|Annex/); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const retry = await race("wheel-exchange-mail-tail-failure-retry-same-uuid",duplicates("wheel-native",value,id)); duplicateResults(retry,"nativeWheelAction");
    expect(await wallet()).toEqual({Points:900,Revision:11}); expect(retry.find(response=>!response.json().replayed)!.json()).toMatchObject({mailedCount:1,
      nativeWheelAction:{requestId:id,effects:[{type:"exchanged",index:0,count:7,chipsSpent:140,fragments:20,templateId:11019,itemCount:7}]}});
    const after = await saved(), items = after.goods.slice(before.goods.length), mails = after.mails.slice(before.mails.length);
    expect(items.map(item=>item.Count)).toEqual([5,2]); expect(items.every(item=>item.TemplateID===11019&&item.UserID===0&&item.Place===-1&&item.IsBinds===true&&item.ValidDate===0)).toBe(true);
    expect(mails).toHaveLength(1); expect([mails[0].Annex1,mails[0].Annex2].map(Number)).toEqual(items.map(item=>item.ItemID)); expect(mails[0].Annex3).toBeNull();
    expect(after.receipts.length-before.receipts.length).toBe(1); expect((await snapshot()).nativeWheel).toMatchObject({fragments:20,pending:null,phase:"settled"});
    expect((await post(appA,"wheel-native",{...value,count:1},id)).statusCode).toBe(409);
    expect((await post(appB,"wheel-native",{...value,count:1})).statusCode).toBe(400);
    const replay = await action("wheel-native",value,id,appA); expect(replay).toMatchObject({replayed:true,mailedCount:1}); expect(replay).not.toHaveProperty("nativeWheelAction"); expect(await saved()).toEqual(after); passed++;
  });
  it("deduplicates a finite five-draw Carnival UUID and preserves old dice under real shared wallet contention", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    const initial = await snapshot(), id = randomUUID(), value = {type:"draw",count:5,choice:initial.nativeCarnival.stateToken};
    const same = await race("carnival-native-five-draws-one-uuid",duplicates("carnival-native",value,id));
    duplicateResults(same,"nativeCarnivalAction"); expect(await wallet()).toEqual({Points:950,Revision:1});
    const fresh = same.find(response=>!response.json().replayed)!.json<ActivityResult>();
    expect(fresh).toMatchObject({mailedCount:1,nativeCarnival:{personalScore:5,redPackageCount:15},nativeCarnivalAction:{requestId:id}});
    expect(fresh.nativeCarnivalAction!.effects.map(effect=>effect.type==="drawn"&&[effect.drawId,effect.prizeId,effect.batchIndex,effect.batchCount])).toEqual([
      [1,12,0,5],[2,12,1,5],[3,12,2,5],[4,12,3,5],[5,12,4,5]]);
    const delivered = await saved(); expect(delivered.receipts).toHaveLength(1); expect(delivered.goods.map(item=>[item.TemplateID,item.Count])).toEqual([[11002,5],[11002,5],[11002,5]]);
    expect(delivered.goods.every(item=>item.UserID===0&&item.Place===-1&&item.IsBinds===true&&item.ValidDate===0)).toBe(true);
    expect(delivered.mails).toHaveLength(1); expect([delivered.mails[0].Annex1,delivered.mails[0].Annex2,delivered.mails[0].Annex3].map(Number)).toEqual(delivered.goods.map(item=>item.ItemID));
    expect(delivered.mails[0].Annex4).toBeNull();
    const shared = await race("carnival-original-and-legacy-dice-distinct-slots-shared-wallet",[
      ()=>post(appA,"carnival",{type:"roll"}),()=>post(appB,"carnival-native",{type:"draw",count:1,choice:fresh.nativeCarnival.stateToken})]);
    expect(shared.map(response=>response.statusCode)).toEqual([200,200]); expect(shared[0].json()).not.toHaveProperty("nativeCarnivalAction");
    expect(await wallet()).toEqual({Points:934,Revision:3});
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State;
    expect(state.games.carnival).toEqual({version:1,kind:"carnival",rolls:1,distance:6,pool:105});
    expect(state.games.carnivalNativeV1).toMatchObject({kind:"carnival-native",drawCount:6,redPacketsEarned:18,redPacketsSpent:0}); expect(state.daily.actions).toBe(7);
    const after = await saved(), current = await snapshot();
    expect((await post(appA,"carnival-native",{...value,count:1},id)).statusCode).toBe(409);
    const replay = await action("carnival-native",value,id,appB); expect(replay).toMatchObject({...latestView(current),replayed:true,mailedCount:1});
    expect(replay).not.toHaveProperty("nativeCarnivalAction"); expect(await saved()).toEqual(after); passed++;
  });

  it("rolls back Carnival batch and exchange mail on final receipts, then retries each UUID once with MaxCount five splitting", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    const id = randomUUID(), value = {type:"draw",count:5,choice:(await snapshot()).nativeCarnival.stateToken}, before = await saved();
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${id}') NOT VALID`));
    const failed = await post(appB,"carnival-native",value,id); expect(failed.statusCode,failed.body).toBe(500); expect(failed.body).not.toMatch(/native_test_receipt_failure|INSERT|UPDATE|Annex/);
    expect(await saved()).toEqual(before); await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const retried = await race("carnival-five-draw-mail-tail-failure-retry-one-uuid",duplicates("carnival-native",value,id)); duplicateResults(retried,"nativeCarnivalAction");
    expect(await wallet()).toEqual({Points:950,Revision:1});
    const drawn = await saved(); expect(drawn.goods.map(item=>item.Count)).toEqual([5,5,5]); expect(drawn.mails).toHaveLength(1); expect(drawn.receipts).toHaveLength(1);
    const ready = await action("carnival-native",{type:"draw",count:5,choice:(await snapshot()).nativeCarnival.stateToken});
    expect(ready.nativeCarnival.redPackageCount).toBe(30);
    const exchangeId = randomUUID(), exchange = {type:"exchange",index:4,count:1,choice:ready.nativeCarnival.stateToken}, exchangeBefore = await saved();
    assert.match(exchangeId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${exchangeId}') NOT VALID`));
    expect((await post(appA,"carnival-native",exchange,exchangeId)).statusCode).toBe(500); expect(await saved()).toEqual(exchangeBefore);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const exchanged = await race("carnival-packet-exchange-mail-tail-failure-retry-one-uuid",duplicates("carnival-native",exchange,exchangeId)); duplicateResults(exchanged,"nativeCarnivalAction");
    expect(await wallet()).toEqual({Points:900,Revision:3});
    expect(exchanged.find(response=>!response.json().replayed)!.json()).toMatchObject({mailedCount:1,nativeCarnival:{redPackageCount:10},
      nativeCarnivalAction:{requestId:exchangeId,effects:[{type:"exchanged",index:4,catalogId:5,count:1,templateId:11019,itemCount:10,redPacketsSpent:20,redPackageCount:10}]}});
    const after = await saved(), items = after.goods.slice(exchangeBefore.goods.length), mails = after.mails.slice(exchangeBefore.mails.length);
    expect(items.map(item=>[item.TemplateID,item.Count])).toEqual([[11019,5],[11019,5]]);
    expect(items.every(item=>item.UserID===0&&item.Place===-1&&item.IsBinds===true&&item.ValidDate===0)).toBe(true);
    expect(mails).toHaveLength(1); expect([mails[0].Annex1,mails[0].Annex2].map(Number)).toEqual(items.map(item=>item.ItemID)); expect(mails[0].Annex3).toBeNull();
    expect(after.receipts.length-exchangeBefore.receipts.length).toBe(1);
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid}`))!.State;
    expect(state.daily.actions).toBe(10); const replay = await action("carnival-native",exchange,exchangeId,appB);
    expect(replay).toMatchObject({replayed:true,mailedCount:1}); expect(replay).not.toHaveProperty("nativeCarnivalAction"); expect(await saved()).toEqual(after); passed++;
  });

  it("caps actual Carnival batch draws at shared five hundred but settles existing packets once with full-date stale-token rejection", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    await action("carnival-native",{type:"draw",count:5,choice:(await snapshot()).nativeCarnival.stateToken});
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid}`))!.State;
    state.daily.actions = 499; await monitor.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    const partial = await snapshot(), before = await saved(); expect(partial.nativeCarnival).toMatchObject({remainDrawCount:1,maxBatchCount:1});
    expect((await post(appA,"carnival-native",{type:"draw",count:5,choice:partial.nativeCarnival.stateToken})).statusCode).toBe(400); expect(await saved()).toEqual(before);
    await action("carnival",{type:"roll"}); const capped = await snapshot(); expect(capped.nativeCarnival).toMatchObject({canDraw:false,remainDrawCount:0,maxBatchCount:0,redPackageCount:15});
    const capSave = await saved(); expect((await post(appB,"carnival-native",{type:"draw",count:1,choice:capped.nativeCarnival.stateToken})).statusCode).toBe(400); expect(await saved()).toEqual(capSave);
    const value = {type:"exchange",index:0,count:1,choice:capped.nativeCarnival.stateToken};
    const expired = `${new Date(Date.parse(`${day}T00:00:00Z`)-86400000).toISOString().slice(0,10)}:${value.choice.split(":")[1]}`;
    expect((await post(appA,"carnival-native",{...value,choice:expired})).statusCode).toBe(400); expect(await saved()).toEqual(capSave);
    const settled = await race("carnival-at-cap-packet-settlement-different-uuids",[
      ()=>post(appA,"carnival-native",value),()=>post(appB,"carnival-native",value)]);
    expect(settled.map(response=>response.statusCode).sort()).toEqual([200,400]); expect(await wallet()).toEqual({Points:944,Revision:3});
    const after = await saved(), final = await snapshot(); expect(final.nativeCarnival).toMatchObject({redPackageCount:5,personalScore:5,canDraw:false});
    const finalState = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid}`))!.State;
    expect(finalState.daily.actions).toBe(500); expect(after.receipts.length-capSave.receipts.length).toBe(1);
    expect(after.goods.slice(capSave.goods.length).map(item=>[item.TemplateID,item.Count])).toEqual([[11019,5]]);
    expect((await post(appB,"carnival-native",value)).statusCode).toBe(400); expect(await saved()).toEqual(after); passed++;
  });

  it("transfers one native task entitlement across both locked roles once per gift UUID",async()=>{
    await rechargeSeed(); const issued=await recharge({type:"issue-card",tier:2}),id=randomUUID();
    const value={type:"gift-card",cardId:rechargeCard(issued,2).cardId,recipientName:friendNick,choice:issued.nativeFirstRecharge.stateToken};
    const before=await saved(),results=await race("first-native-dual-role-gift-same-uuid",duplicates("first-recharge-native",value,id),[uid,friend]);
    duplicateResults(results,"nativeFirstRechargeAction"); const after=await saved();
    expect(after.wallets.map(w=>[w.UserID,w.Points,w.Earned,w.Revision])).toEqual([[uid,1000,600,2],[friend,1000,600,1]]);
    expect(after.mails).toEqual(before.mails); expect(after.goods).toEqual(before.goods); expect(after.receipts.length-before.receipts.length).toBe(1);
    expect(rechargeCard(await snapshot(),2)).toMatchObject({status:"gifted",canGift:false,canUse:false});
    const received=rechargeCard(await snapshot(appB,friend),2); expect(received).toMatchObject({cardId:value.cardId,status:"owned",senderName:"Native PG test",canGift:false});
    const targetState=after.states.find(s=>s.UserID===friend)!.State as ActivityState; expect(targetState.completed).toEqual({});
    const replay=await recharge(value,uid,id,appB); expect(replay.replayed).toBe(true); expect(replay).not.toHaveProperty("nativeFirstRechargeAction"); expect(await saved()).toEqual(after); passed++;
  });

  it("orders opposite-direction gift locks and rejects a stale second entitlement without deadlock or copying",async()=>{
    await rechargeSeed(); const one=await recharge({type:"issue-card",tier:2}),two=await recharge({type:"issue-card",tier:3},friend);
    const actions=[{type:"gift-card",cardId:rechargeCard(one,2).cardId,recipientName:friendNick,choice:(await snapshot()).nativeFirstRecharge.stateToken},
      {type:"gift-card",cardId:rechargeCard(two,3).cardId,recipientName:"Native PG test",choice:two.nativeFirstRecharge.stateToken}];
    const ids=[randomUUID(),randomUUID()],results=await race("first-native-opposite-direction-global-wallet-order",[
      ()=>post(appA,"first-recharge-native",actions[0],ids[0],uid),()=>post(appB,"first-recharge-native",actions[1],ids[1],friend)],[uid,friend]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
    const loser=results[0].statusCode===409?0:1,who=loser===0?uid:friend;
    await recharge({...actions[loser],choice:(await snapshot(appB,who)).nativeFirstRecharge.stateToken},who,randomUUID(),appB);
    const final=await saved(); expect(final.wallets.map(w=>[w.Points,w.Earned,w.Revision])).toEqual([[1000,600,3],[1000,600,3]]);
    expect(final.mails).toHaveLength(0); expect(final.goods).toHaveLength(0); expect(final.receipts).toHaveLength(4);
    expect((await snapshot()).nativeFirstRecharge.cards.cards.map(c=>[c.kind,c.status])).toEqual([[2,"gifted"],[3,"owned"]]);
    expect((await snapshot(appB,friend)).nativeFirstRecharge.cards.cards.map(c=>[c.kind,c.status])).toEqual([[2,"owned"],[3,"gifted"]]); passed++;
  });

  it("serializes recipient old first-gift claims against incoming native gifts and shares the old/native canonical claim",async()=>{
    await rechargeSeed(true); const issued=await recharge({type:"issue-card",tier:1});
    const value={type:"gift-card",cardId:rechargeCard(issued,1).cardId,recipientName:friendNick,choice:issued.nativeFirstRecharge.stateToken};
    const incoming=await race("first-native-gift-versus-qualified-recipient-old-claim",[
      ()=>post(appA,"first-recharge-native",value),()=>post(appB,"first-gift",{type:"claim"},randomUUID(),friend)],[uid,friend]);
    expect(incoming.map(r=>r.statusCode).sort()).toEqual([200,409]);
    const target=await snapshot(appB,friend); if(incoming[0].statusCode===200){
      expect(rechargeCard(target,1).status).toBe("owned"); await recharge({type:"use-card",cardId:value.cardId},friend);
      const settled=await post(appB,"first-gift",{type:"claim"},randomUUID(),friend); expect(settled.statusCode,settled.body).toBe(200);
    } else expect(target.nativeFirstRecharge.tiers[0].claimed).toBe(true);
    const after=await saved(); expect(after.mails).toHaveLength(1); expect(after.goods.map(g=>[g.TemplateID,g.Count])).toEqual([[11019,5],[11021,1]]);
    const state=after.states.find(s=>s.UserID===friend)!.State as ActivityState; expect(state.claims.filter(k=>k==="first-gift")).toHaveLength(1);
    expect((await post(appA,"first-recharge-native",{type:"claim",tier:1,choice:target.nativeFirstRecharge.stateToken},randomUUID(),friend)).statusCode).toBe(409);
    expect(await saved()).toEqual(after); passed++;
  });

  it("rolls back two-role gift state and revisions at recipient and final receipt failures before one UUID retry",async()=>{
    await rechargeSeed(); const issued=await recharge({type:"issue-card",tier:2}),id=randomUUID();
    const value={type:"gift-card",cardId:rechargeCard(issued,2).cardId,recipientName:friendNick,choice:issued.nativeFirstRecharge.stateToken},before=await saved();
    await monitor.db.execute(sql`ALTER TABLE app."ActivityStates" ADD CONSTRAINT native_test_recipient_failure CHECK ("UserID"<>602 OR ("State" #>> '{games,firstRechargeNativeV1,cardSlots,1,cardId}') IS NULL) NOT VALID`);
    expect((await post(appB,"first-recharge-native",value,id)).statusCode).toBe(500); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityStates" DROP CONSTRAINT native_test_recipient_failure`);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("Signature"='never-test-signature') NOT VALID`);
    expect((await post(appA,"first-recharge-native",value,id)).statusCode).toBe(500); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    duplicateResults(await race("first-native-dual-role-receipt-failure-uuid-retry",duplicates("first-recharge-native",value,id),[uid,friend]),"nativeFirstRechargeAction");
    const after=await saved(); expect(after.wallets.map(w=>w.Revision)).toEqual([2,1]); expect(after.receipts.length-before.receipts.length).toBe(1);
    expect(after.mails).toEqual(before.mails); expect(after.goods).toEqual(before.goods); passed++;
  });

  it("rolls back native claim mail stacks on tail failure and deduplicates both new tiers and old/native first-gift",async()=>{
    await rechargeSeed(); const id=randomUUID(),value={type:"claim",tier:2,choice:(await snapshot()).nativeFirstRecharge.stateToken},before=await saved();
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("Signature"='never-test-signature') NOT VALID`);
    expect((await post(appB,"first-recharge-native",value,id)).statusCode).toBe(500); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    duplicateResults(await race("first-native-material-claim-receipt-tail-same-uuid",duplicates("first-recharge-native",value,id)),"nativeFirstRechargeAction");
    const delivered=await saved(); expect(delivered.goods.map(g=>[g.TemplateID,g.Count])).toEqual([[11019,5],[11019,5],[11001,3]]);
    expect(delivered.goods.every(g=>g.IsBinds===true&&g.ValidDate===0&&g.UserID===0&&g.Place===-1)).toBe(true);
    expect(delivered.mails).toHaveLength(1); expect([delivered.mails[0].Annex1,delivered.mails[0].Annex2,delivered.mails[0].Annex3].map(Number)).toEqual(delivered.goods.map(g=>g.ItemID));
    const token=(await snapshot()).nativeFirstRecharge.stateToken;
    const common=await race("first-native-and-old-first-gift-one-canonical-mail",[
      ()=>post(appA,"first-gift",{type:"claim"}),()=>post(appB,"first-recharge-native",{type:"claim",tier:1,choice:token})]);
    expect(common.filter(r=>r.statusCode===200)).toHaveLength(1); expect(common.filter(r=>r.statusCode===400||r.statusCode===409)).toHaveLength(1);
    const all=await saved(); expect(all.mails).toHaveLength(2); expect(all.receipts).toHaveLength(2);
    const state=all.states.find(s=>s.UserID===uid)!.State as ActivityState; expect(state.claims.sort()).toEqual(["first-gift","first-recharge-native:tier:2"]);
    expect(await wallet()).toEqual({Points:1000,Revision:2}); passed++;
  });

  it("shares shop wallet competition with legacy exchange and settles cards and task rewards at daily500",async()=>{
    await rechargeSeed(); await monitor.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=15 WHERE "UserID"=${uid}`);
    const value={type:"buy",index:0,count:1,choice:(await snapshot()).nativeFirstRecharge.stateToken};
    const bought=await race("first-native-fixed-shop-and-legacy-exchange-one-wallet",[
      ()=>post(appA,"first-recharge-native",value),()=>post(appB,"exchange",{type:"exchange",index:0})]);
    expect(bought.filter(r=>r.statusCode===200)).toHaveLength(1); expect(bought.filter(r=>r.statusCode===400||r.statusCode===409)).toHaveLength(1);
    expect(await wallet()).toEqual({Points:0,Revision:1}); const after=await saved(); expect(after.goods.map(g=>g.Count)).toEqual([3]); expect(after.mails).toHaveLength(1);
    const state=after.states.find(s=>s.UserID===uid)!.State as ActivityState; state.daily.actions=500;
    await monitor.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    const capped=await snapshot(); expect(capped.nativeFirstRecharge.shop.rows.every(r=>r.canBuy===0)).toBe(true);
    expect((await post(appA,"first-recharge-native",{type:"buy",index:0,count:1,choice:capped.nativeFirstRecharge.stateToken})).statusCode).toBe(400);
    const issued=await recharge({type:"issue-card",tier:3}); await recharge({type:"use-card",cardId:rechargeCard(issued,3).cardId}); await recharge({type:"claim",tier:3});
    const final=await saved(),stored=final.states.find(s=>s.UserID===uid)!.State as ActivityState;
    expect(stored.daily.actions).toBe(500); expect(await wallet()).toEqual({Points:0,Revision:4}); expect(final.mails).toHaveLength(2); passed++;
  });

  it("deduplicates one confirmed Charge exchange UUID, splits MaxCount5 mail and recovers the latest view without effects",async()=>{
    await rechargeSeed(); const before=await saved(),id=randomUUID(),value={type:"exchange",index:4,count:1,choice:(await snapshot()).nativeCharge.stateToken};
    duplicateResults(await race("charge-exchange-same-uuid-one-fee-one-gross",duplicates("charge-native",value,id)),"nativeChargeAction");
    const after=await saved(); expect(await wallet()).toEqual({Points:965,Revision:1}); expect(after.goods.map(g=>[g.TemplateID,g.Count])).toEqual([[11019,5],[11019,1]]);
    expect(after.goods.every(g=>g.IsBinds===true&&g.ValidDate===0&&g.UserID===0&&g.Place===-1)).toBe(true);
    expect(after.mails).toHaveLength(1); expect([after.mails[0].Annex1,after.mails[0].Annex2].map(Number)).toEqual(after.goods.map(g=>g.ItemID));
    expect(after.receipts.length-before.receipts.length).toBe(1); expect((await snapshot()).nativeCharge.grossSpent).toBe(35); expect((await snapshot()).nativeCharge.exchange.rows[4].bought).toBe(1);
    await action("exchange",{type:"exchange",index:0}); const current=await snapshot(),delivered=await saved();
    const replay=await action("charge-native",value,id,appB); expect(replay).toMatchObject({...latestView(current),replayed:true,mailedCount:1}); expect(replay.nativeChargeAction).toBeUndefined();
    expect(current.nativeCharge.grossSpent).toBe(50); expect(await saved()).toEqual(delivered);
    expect((await post(appA,"charge-native",{...value,index:5},id)).statusCode).toBe(409); expect(await saved()).toEqual(delivered); passed++;
  });

  it("serializes native Charge and old points-gift into one permanent canonical claim at daily500",async()=>{
    await rechargeSeed(); const state=createActivityState(new Date()); state.daily.actions=500;
    await monitor.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    const value={type:"claim",index:1,tier:3,choice:(await snapshot()).nativeCharge.stateToken},before=await saved();
    const results=await race("charge-native-old-points-gift-one-canonical-at-cap",[
      ()=>post(appA,"charge-native",value),()=>post(appB,"points-gift",{type:"claim",tier:3})]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,400]); const after=await saved();
    expect(after.mails.length-before.mails.length).toBe(1); expect(after.goods.map(g=>g.Count)).toEqual([5,4]);
    expect(after.receipts.length-before.receipts.length).toBe(1); expect(await wallet()).toEqual({Points:1000,Revision:1});
    const stored=after.states.find(s=>s.UserID===uid)!.State as ActivityState; expect(stored.claims).toEqual(["points-gift:3"]); expect(stored.daily.actions).toBe(500);
    expect((await snapshot()).nativeCharge.exchange.rows.every(r=>!r.canExchange)).toBe(true); expect((await snapshot()).nativeCharge.grossSpent).toBe(0); passed++;
  });

  it("shares the actual wallet and gross counter with old exchanges under competing UUIDs and cross-module UUID collisions",async()=>{
    await rechargeSeed(); await monitor.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=15 WHERE "UserID"=${uid}`);
    const value={type:"exchange",index:0,count:1,choice:(await snapshot()).nativeCharge.stateToken};
    const results=await race("charge-native-versus-old-exchange-one-wallet",[
      ()=>post(appA,"charge-native",value),()=>post(appB,"exchange",{type:"exchange",index:0})]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,400]); expect(await wallet()).toEqual({Points:0,Revision:1});
    expect((await snapshot()).nativeCharge.grossSpent).toBe(15); const after=await saved(); expect(after.receipts).toHaveLength(1); expect(after.mails).toHaveLength(1); expect(after.goods.map(g=>g.Count)).toEqual([3]);
    await monitor.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=100 WHERE "UserID"=${uid}`);
    const id=randomUUID(),fresh={...value,index:1,choice:(await snapshot()).nativeCharge.stateToken};
    const common=await race("charge-native-old-exchange-cross-module-same-uuid",[
      ()=>post(appA,"charge-native",fresh,id),()=>post(appB,"exchange",{type:"exchange",index:0},id)]);
    expect(common.map(r=>r.statusCode).sort()).toEqual([200,409]); const progress=(await snapshot()).nativeCharge.grossSpent;
    expect([30,35]).toContain(progress); expect((await saved()).receipts).toHaveLength(2); passed++;
  });

  it("records gross old and native spending across concurrent owners, ignoring refunds and replays",async()=>{
    await rechargeSeed(); const moon={type:"draw",count:1,choice:(await snapshot()).nativeMoonlight.bagToken};
    const results=await race("charge-gross-ddplay-profit-and-native-moon-cost",[
      ()=>post(appA,"ddplay",{type:"spin"}),()=>post(appB,"moonlight-native",moon)]);
    expect(results.map(r=>r.statusCode)).toEqual([200,200]); expect(await wallet()).toEqual({Points:1070,Revision:2}); expect((await snapshot()).nativeCharge.grossSpent).toBe(30);
    await action("moon",{type:"recycle"}); expect((await snapshot()).nativeCharge.grossSpent).toBe(30);
    await treasureReady(); const id=randomUUID(),treasure=await treasureDraw(1,"advanced");
    duplicateResults(await race("charge-gross-native-treasure-retry-one-cost",duplicates("treasure-native",treasure,id)),"nativeTreasureAction");
    expect((await snapshot()).nativeCharge.grossSpent).toBe(90);
    const originalBag=await saved(); expect((await post(appA,"treasure",{type:"recycle"})).statusCode).toBe(400);
    expect(await saved()).toEqual(originalBag); expect((await snapshot()).nativeCharge.grossSpent).toBe(90);
    const before=await saved(); expect((await action("treasure-native",treasure,id,appB)).nativeCharge.grossSpent).toBe(90); expect(await saved()).toEqual(before); passed++;
  });

  it("rolls back Charge costs, gross, quota and all mail on final receipt failure and retries each UUID once",async()=>{
    await rechargeSeed();
    for(const phase of ["exchange","daily"] as const) {
      if(phase==="daily") {
        const s=(await saved()).states.find(s=>s.UserID===uid)!.State as ActivityState; s.claims.push(`task:${day}:sign`);
        await monitor.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(s)}::jsonb WHERE "UserID"=${uid}`);
      }
      const id=randomUUID(),value:ActivityAction=phase==="exchange"?{type:"exchange",index:4,count:1,choice:(await snapshot()).nativeCharge.stateToken}
        :{type:"claim",index:0,tier:1,choice:(await snapshot()).nativeCharge.stateToken};
      assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/); const before=await saved();
      await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${id}') NOT VALID`));
      const failed=await post(appB,"charge-native",value,id); expect(failed.statusCode,failed.body).toBe(500); expect(failed.body).not.toMatch(/native_test_receipt_failure|INSERT|Annex/);
      expect(await saved()).toEqual(before); await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
      duplicateResults(await race(`charge-${phase}-five-table-tail-rollback-retry`,duplicates("charge-native",value,id)),"nativeChargeAction");
      const after=await saved(); expect(after.receipts.length-before.receipts.length).toBe(1); expect(after.mails.length-before.mails.length).toBe(1);
      expect(after.goods.slice(before.goods.length).map(g=>[g.TemplateID,g.Count])).toEqual(phase==="exchange"?[[11019,5],[11019,1]]:[[11019,1],[11001,1],[11021,1],[11002,1]]);
      expect((await snapshot()).nativeCharge.grossSpent).toBe(35);
    }
    expect(await wallet()).toEqual({Points:965,Revision:2}); passed++;
  });

  it("projects UTC exchange rollover without writes and settles exact claimed task tiers without historical spending backfill",async()=>{
    await rechargeSeed(); await action("charge-native",{type:"exchange",index:0,count:1,choice:(await snapshot()).nativeCharge.stateToken});
    const s=(await saved()).states.find(s=>s.UserID===uid)!.State as ActivityState,oldDay=new Date(Date.parse(day+"T00:00:00Z")-86400000).toISOString().slice(0,10);
    s.day=oldDay; s.daily.actions=500; const tracking=s.games.chargeNativeV1 as {day:string}; tracking.day=oldDay;
    s.claims=[`task:${day}:sign`,`task:${day}:mines`,`task:${day}:pair`,`task:${day}:explore`,`task:${day}:sign`,`task:${oldDay}:mines`];
    await monitor.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(s)}::jsonb WHERE "UserID"=${uid}`);
    const before=await saved(),v=await snapshot(); expect(await saved()).toEqual(before);
    expect(v.nativeCharge).toMatchObject({todayClaimedTaskPoints:200,grossSpent:15}); expect(v.nativeCharge.exchange.rows[0]).toMatchObject({bought:0,remaining:1,canExchange:true});
    const value={type:"claim",index:0,tier:3,choice:v.nativeCharge.stateToken};
    const results=await race("charge-daily-three-qualified-different-uuids",[()=>post(appA,"charge-native",value),()=>post(appB,"charge-native",value)]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,400]); expect((await snapshot()).nativeCharge.pages[0].tiers[2].claimed).toBe(true);
    const after=await saved(),stored=after.states.find(s=>s.UserID===uid)!.State as ActivityState; expect(stored.daily.actions).toBeUndefined();
    expect(after.receipts.length-before.receipts.length).toBe(1); expect((await snapshot()).nativeCharge.grossSpent).toBe(15); passed++;
  });
  it("deduplicates Forthright creation under a real wallet lock and replays its receipt after archive", async()=>{
    await forthrightSeed(); const requestId=randomUUID(),value={type:"open-group",index:0,tier:0,count:1,marked:true,choice:(await snapshot()).nativeForthright.stateToken};
    duplicateResults(await race("forthright-open-same-uuid",forthrightDuplicates(value,requestId)),"nativeForthrightAction");
    const after=await saved(); expect(await wallet()).toEqual({Points:968,Revision:1}); expect(after.receipts).toHaveLength(1); expect(after.mails).toHaveLength(0);
    expect((await snapshot()).nativeCharge.grossSpent).toBe(32);
    await editState(uid,state=>{ (state.games.forthrightNativeV1 as {createdGroups:unknown}).createdGroups={}; });
    const archived=await saved(),replay=await forthright(value,uid,requestId,appB);
    expect(replay.replayed).toBe(true); expect(replay.nativeForthrightAction).toBeUndefined(); expect(await saved()).toEqual(archived); passed++;
  });

  it("settles three true Forthright characters once with all wallets locked and original stack mail",async()=>{
    await forthrightSeed(); const g=await openForthright(4); await joinForthright(g.code);
    const requestId=randomUUID(),value={type:"join-group",count:1,choice:(await inspectForthright(g.code,third)).actionToken};
    duplicateResults(await race("forthright-third-role-completes-same-uuid",forthrightDuplicates(value,requestId,third),[uid,friend,third]),"nativeForthrightAction");
    const all=await saved(); expect(all.wallets.slice(0,3).map(w=>[w.Points,w.Revision])).toEqual([[939,3],[939,2],[939,1]]);
    expect(all.mails).toHaveLength(6); expect(all.goods.map(g=>[g.TemplateID,g.Count])).toEqual(Array.from({length:3},()=>[[11019,5],[11019,3]]).flat());
    expect(all.goods.every(g=>g.IsBinds===true&&g.ValidDate===0&&g.UserID===0&&g.Place===-1)).toBe(true);
    for(const id of [uid,friend,third]) {const p=await snapshot(appB,id); expect(p.nativeCharge.grossSpent).toBe(64); expect(p.nativeForthright.pages.groups.createdOrders.concat(p.nativeForthright.pages.groups.joinedOrders)[0].status).toBe("completed");}
    const receipt=await saved(); await forthright(value,third,requestId,appB); expect(await saved()).toEqual(receipt); passed++;
  });

  it("refunds only a leaving member, keeps the group open and awards the replacement rather than the old member",async()=>{
    await forthrightSeed(); const g=await openForthright(); await joinForthright(g.code);
    const requestId=randomUUID(),value={type:"leave-group",choice:(await inspectForthright(g.code)).actionToken};
    duplicateResults(await race("forthright-member-leave-one-refund",forthrightDuplicates(value,requestId,friend),[uid,friend]),"nativeForthrightAction");
    expect((await snapshot(appB,friend)).points).toBe(1000); expect((await snapshot()).points).toBe(968);
    const old=await inspectForthright(g.code); expect(old.members.find(m=>m.self)).toMatchObject({status:"left",credited:32});
    expect((await post(appA,forthrightId,{type:"join-group",count:1,choice:old.actionToken},randomUUID(),friend)).statusCode).toBe(409);
    await joinForthright(g.code,third); await joinForthright(g.code,replacement);
    const all=await saved(); expect(all.mails.filter(m=>m.ReceiverID===friend)).toHaveLength(1); expect(all.goods).toHaveLength(3);
    const complete=await inspectForthright(g.code,replacement); expect(complete.status).toBe("completed"); expect(complete.members.filter(m=>m.status==="active")).toHaveLength(3);
    expect(complete.members.find(m=>m.nickname==="Native PG friend")?.rewardMailed).toBe(false); passed++;
  });

  it("rolls back creator cancellation credits and membership on final receipt failure then refunds at daily500",async()=>{
    await forthrightSeed(); const g=await openForthright(); await joinForthright(g.code);
    for(const id of [uid,friend]) await editState(id,state=>{state.daily.actions=500;});
    const requestId=randomUUID(),value={type:"cancel-group",choice:(await inspectForthright(g.code,uid)).actionToken},before=await saved();
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("Signature"='never-test-signature') NOT VALID`);
    expect((await post(appB,forthrightId,value,requestId)).statusCode).toBe(500); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    duplicateResults(await race("forthright-creator-cancel-tail-rollback",forthrightDuplicates(value,requestId),[uid,friend]),"nativeForthrightAction");
    for(const id of [uid,friend]) {const p=await snapshot(appB,id); expect(p.points).toBe(1000); expect(p.nativeCharge.grossSpent).toBe(32); expect(p.nativeForthright.dailyActionsRemaining).toBe(0);}
    expect((await inspectForthright(g.code,uid)).status).toBe("refunded"); passed++;
  });

  it("rolls back all three member wallets, states, item stacks, mail and receipts on each completion tail fault",async()=>{
    await forthrightSeed(); const g=await openForthright(4); await joinForthright(g.code);
    const value={type:"join-group",count:1,choice:(await inspectForthright(g.code,third)).actionToken},requestId=randomUUID();
    for(const target of ["mail","state","receipt"] as const) {
      const before=await saved();
      if(target==="mail") await monitor.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT native_test_mail_failure CHECK ("ReceiverID"<>603) NOT VALID`);
      else if(target==="state") await monitor.db.execute(sql`ALTER TABLE app."ActivityStates" ADD CONSTRAINT native_test_recipient_failure CHECK ("UserID"<>603) NOT VALID`);
      else await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("Signature"='never-test-signature') NOT VALID`);
      const result=await post(appB,forthrightId,value,requestId,third); expect(result.statusCode,result.body).toBe(500); expect(await saved()).toEqual(before);
      if(target==="mail") await monitor.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT native_test_mail_failure`);
      else if(target==="state") await monitor.db.execute(sql`ALTER TABLE app."ActivityStates" DROP CONSTRAINT native_test_recipient_failure`);
      else await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    }
    duplicateResults(await race("forthright-three-role-all-table-tail-retry",forthrightDuplicates(value,requestId,third),[uid,friend,third]),"nativeForthrightAction");
    expect((await saved()).goods).toHaveLength(6); expect((await inspectForthright(g.code,uid)).status).toBe("completed"); passed++;
  });

  it("keeps expiry GET read-only and preserves overflow refund due even for a banned other member",async()=>{
    await forthrightSeed(); const g=await openForthright(); await joinForthright(g.code);
    await editState(uid,state=>{const own=state.games.forthrightNativeV1 as {createdGroups:Record<string,{expiresAt:string}>}; Object.values(own.createdGroups)[0].expiresAt=new Date(Date.now()-1).toISOString();});
    await monitor.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=2147483647 WHERE "UserID" IN (${uid},${friend})`);
    await monitor.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "ForbidDate"='2099-01-01' WHERE "UserID"=${friend}`);
    const before=await saved(),expired=await inspectForthright(g.code,uid); expect(expired.status).toBe("expired-unsettled"); expect(await saved()).toEqual(before);
    await forthright({type:"settle-group",choice:expired.actionToken});
    let view=await inspectForthright(g.code,uid); expect(view.members.map(m=>m.creditDue)).toEqual([32,32]);
    await monitor.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=2147483637 WHERE "UserID" IN (${uid},${friend})`);
    const requestId=randomUUID(),value={type:"settle-group",choice:view.actionToken};
    // Wallet edits invalidate actor tokens, so fetch the authentic current token before racing.
    value.choice=(await inspectForthright(g.code,uid)).actionToken;
    duplicateResults(await race("forthright-partial-credit-due-no-earned",forthrightDuplicates(value,requestId),[uid,friend]),"nativeForthrightAction");
    view=await inspectForthright(g.code,uid); expect(view.members.map(m=>[m.credited,m.creditDue])).toEqual([[10,22],[10,22]]);
    expect((await snapshot()).earned).toBe(600); expect((await snapshot()).nativeCharge.grossSpent).toBe(32); passed++;
  });

  it("shares native and old luxury entitlement under contention while exempting claims from daily500",async()=>{
    await forthrightSeed(); await editState(uid,state=>{state.daily.actions=500;});
    const value={type:"claim",tier:1,choice:(await snapshot()).nativeForthright.stateToken};
    const results=await race("forthright-old-native-luxury-one-canonical",[()=>post(appA,forthrightId,value),()=>post(appB,"luxury",{type:"claim",tier:1})]);
    expect(results.filter(r=>r.statusCode===200)).toHaveLength(1); expect(results.filter(r=>r.statusCode===400||r.statusCode===409)).toHaveLength(1);
    const all=await saved(); expect(all.mails).toHaveLength(1); expect(all.goods.map(g=>g.Count)).toEqual([5]);
    expect((all.states.find(s=>s.UserID===uid)!.State as ActivityState).claims).toEqual(["luxury:1"]); expect(await wallet()).toEqual({Points:1000,Revision:1}); passed++;
  });

  it("serializes Forthright single purchase against a legacy exchange using one actual wallet and gross counter",async()=>{
    await forthrightSeed(); await monitor.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=40 WHERE "UserID"=${uid}`);
    const value={type:"buy-alone",index:0,tier:0,count:1,choice:(await snapshot()).nativeForthright.stateToken};
    const results=await race("forthright-single-buy-versus-old-exchange",[()=>post(appA,forthrightId,value),()=>post(appB,"exchange",{type:"exchange",index:0})]);
    expect(results.filter(r=>r.statusCode===200)).toHaveLength(1); expect(results.filter(r=>r.statusCode===400||r.statusCode===409)).toHaveLength(1);
    const v=await snapshot(); expect([0,25]).toContain(v.points); expect([15,40]).toContain(v.nativeCharge.grossSpent);
    expect((await saved()).receipts).toHaveLength(1); expect((await saved()).mails).toHaveLength(1); passed++;
  });

  it("freezes deposit and balance prices across UTC phases and rolls back final balance delivery before exact retry",async()=>{
    await forthrightSeed(); vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date(day+"T01:00:00Z"));
    await forthright({type:"deposit",index:4,count:1}); expect((await snapshot()).nativeCharge.grossSpent).toBe(8); expect((await saved()).goods).toHaveLength(0);
    vi.setSystemTime(new Date(day+"T09:00:00Z")); await editState(uid,state=>{state.daily.actions=500;});
    const order=(await snapshot()).nativeForthright.pages.shop.unsettledOrders[0],requestId=randomUUID(),value={type:"pay-balance",choice:order.actionToken},before=await saved();
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("Signature"='never-test-signature') NOT VALID`);
    expect((await post(appB,forthrightId,value,requestId)).statusCode).toBe(500); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    duplicateResults(await race("forthright-tail-payment-at-cap-retry",forthrightDuplicates(value,requestId)),"nativeForthrightAction");
    expect(await wallet()).toEqual({Points:968,Revision:2}); expect((await snapshot()).nativeCharge.grossSpent).toBe(32); expect((await saved()).goods.map(g=>g.Count)).toEqual([5,1]); passed++;
  });

  it("retains expired order refunds across UTC rollover, with explicit partial settlement and same UUID replay",async()=>{
    await forthrightSeed(); vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date(day+"T01:00:00Z"));
    await forthright({type:"deposit",index:0,count:1}); const tomorrow=new Date(Date.parse(day+"T00:00:00Z")+86400000).toISOString().slice(0,10);
    vi.setSystemTime(new Date(tomorrow+"T17:00:00Z")); await monitor.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=2147483647 WHERE "UserID"=${uid}`);
    const before=await saved(),view=await snapshot(),order=view.nativeForthright.pages.shop.unsettledOrders[0]; expect(order.status).toBe("expired-unsettled"); expect(await saved()).toEqual(before);
    const requestId=randomUUID(),value={type:"settle-order",choice:order.actionToken};
    duplicateResults(await race("forthright-order-expiry-full-wallet",forthrightDuplicates(value,requestId)),"nativeForthrightAction");
    expect((await snapshot()).nativeForthright.pages.shop.unsettledOrders[0]).toMatchObject({status:"refund-due",refundDue:4});
    await monitor.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=2147483645 WHERE "UserID"=${uid}`);
    const due=(await snapshot()).nativeForthright.pages.shop.unsettledOrders[0]; await forthright({type:"settle-order",choice:due.actionToken});
    const final=await snapshot(); expect(final.points).toBe(2147483647); expect(final.nativeForthright.pages.shop.unsettledOrders[0].refundDue).toBe(2);
    expect(final.earned).toBe(600); expect(final.nativeCharge.grossSpent).toBe(4); expect((await saved()).goods).toHaveLength(0); passed++;
  });
});
