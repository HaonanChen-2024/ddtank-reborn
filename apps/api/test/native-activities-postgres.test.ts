import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { pairNativeLocalRules } from "../src/activities/pair-native.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// No normal-suite DB connection. The dedicated runner creates a NEW template0 DB and ownership marker.
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(0.99 * min) : min + Math.floor(0.99 * (max - min)) }));
const url = process.env.WORKSHOP_NATIVE_ACTIVITIES_URL, token = process.env.WORKSHOP_NATIVE_ACTIVITIES_TOKEN;
const uid = 601, secret = "native-activity-pg-tests-only", name = "native-activity-pg-test";
type App = Awaited<ReturnType<typeof buildApp>>;
let monitor: DbHandle, holder: DbHandle, a: DbHandle, b: DbHandle, appA: App, appB: App;
let database: string, output: string, day: string, passed = 0;
const connectionPids: number[] = [], scenarios: unknown[] = [];
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name, role: "player" }, secret, 3600)}` });
const post = (app: App, id: string, action: ActivityAction, requestId: string = randomUUID()) => app.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId: uid, requestId, action } });
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
async function wallet() { return (await q1<{ Points: number; Revision: number }>(monitor, sql`SELECT "Points","Revision" FROM app."ActivityWallet" WHERE "UserID"=${uid}`))!; }
async function snapshot(app = appB) {
  const response = await app.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); const result = response.json<ActivityResult>();
  for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction", "nativeMoonlightAction", "nativeTreasureAction"]) expect(result).not.toHaveProperty(key);
  return result;
}
async function walk(count: number, start = 0) { for (let index = start; index < start + count; index++) await mines({ type: "walk", index }); }
async function pairPaidReady() {
  await pair({ type: "start" }); await pair({ type: "flip-all" }); await action("tasks", { type: "claim", choice: "pair" });
  await pair({ type: "reset", choice: "free" }); await pair({ type: "buy-reels", count: 2 });
  for (const index of [1, 2, 3]) await pair({ type: "flip", index, choice: "points" });
}
async function race(label: string, requests: (() => ReturnType<typeof post>)[]) {
  const before = await saved();
  let unlock!: () => void, acquired!: () => void;
  const released = new Promise<void>(resolve => { unlock = resolve; });
  const locked = new Promise<void>(resolve => { acquired = resolve; });
  const held = holder.db.transaction(async tx => {
    await tx.execute(sql`SELECT "UserID" FROM app."ActivityWallet" WHERE "UserID"=${uid} FOR UPDATE`);
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
function duplicateResults(results: Awaited<ReturnType<typeof post>>[], key: "nativePairAction" | "nativeMinesAction" | "nativeDDPlayAction" | "nativeGypsyAction" | "nativeMoonlightAction" | "nativeTreasureAction") {
  expect(results.map(r => r.statusCode)).toEqual(Array(results.length).fill(200));
  expect(results.filter(r => r.json().replayed)).toHaveLength(results.length - 1);
  expect(results.filter(r => r.json()[key])).toHaveLength(1);
  for (const r of results.filter(r => r.json().replayed)) expect(r.json()).not.toHaveProperty(key);
}
const duplicates = (id: string, value: ActivityAction, requestId: string, count = 8) => Array.from({ length: count }, (_, i) => () => post(i % 2 ? appB : appA, id, value, requestId));

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
    expect(new Date().toISOString().slice(0,10)).toBe(day);
    await monitor.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS native_test_mail_failure`);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS native_test_receipt_failure`);
    await monitor.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
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

  it("deduplicates a paid Pair match UUID and replays the latest view without another effect/mail", async () => {
    await pairPaidReady(); const before = await saved(), w = await wallet(), id = randomUUID();
    const result = await race("pair-paid-match-same-uuid", duplicates("pair-native",{type:"flip",index:4,choice:"points"},id));
    duplicateResults(result,"nativePairAction"); expect(await wallet()).toEqual({Points:w.Points-2,Revision:w.Revision+1});
    const after = await saved(); expect(after.mails.length-before.mails.length).toBe(1); expect(after.goods.length-before.goods.length).toBe(1); expect(after.receipts.length-before.receipts.length).toBe(1);
    expect(await snapshot()).toMatchObject({points:52,nativePair:{matchedPairs:2,hiddenRemaining:28}});
    await pair({type:"flip",index:5,choice:"points"}); const current = await snapshot(), prior = await saved();
    expect(await action("pair-native",{type:"flip",index:4,choice:"points"},id,appB)).toMatchObject({...current,replayed:true});
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
    if(nativeWon) expect(raced[1].json()).toHaveProperty("nativeMoonlightAction");
    else expect(raced[1].json().message).toContain("临时包或日期已更新");
    expect(await wallet()).toEqual({Points:nativeWon?880:900,Revision:nativeWon?3:2});
    expect(current.nativeMoonlight).toMatchObject({draws,bagSlotsUsed:draws,bag:[{index:0,templateId:11002,itemCount:draws,recycleUnitPoints:2}]});
    expect(after.receipts).toHaveLength(nativeWon?3:2); expect(after.goods).toEqual([]); expect(after.mails).toEqual([]);
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State;
    expect(state.completed.moon).toBe(nativeWon?3:2); expect(state.games).not.toHaveProperty("moonlightNativeV1");
    const replay = await action("moonlight-native",value,id,appB); expect(replay).toMatchObject({...current,replayed:true});
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
  it("keeps Treasure classifications shared, deduplicates five advanced draws and serializes old/native draws into the same bag", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    const initial = await snapshot();
    const chosen = await action("treasure-native",{type:"choose",index:3,marked:false,choice:initial.nativeTreasure.bagToken});
    expect(await wallet()).toEqual({Points:1000,Revision:1});
    const unavailable = await saved();
    expect((await post(appB,"treasure-native",{type:"draw",mode:"advanced",count:5,choice:chosen.nativeTreasure.bagToken})).statusCode).toBe(400);
    expect(await saved()).toEqual(unavailable);
    const restored = await action("treasure",{type:"category",choice:"朱雀石2级"}), id = randomUUID();
    const value = {type:"draw",mode:"advanced" as const,count:5,choice:restored.nativeTreasure.bagToken};
    const same = await race("treasure-native-five-advanced-draws-same-uuid",duplicates("treasure-native",value,id));
    duplicateResults(same,"nativeTreasureAction"); expect(await wallet()).toEqual({Points:700,Revision:3});
    const first = await snapshot(); expect(first.nativeTreasure).toMatchObject({draws:5,bagSlotsUsed:5});
    expect(first.nativeTreasure.bag.map(row=>[row.index,row.templateId,row.itemCount])).toEqual(Array.from({length:5},(_,index)=>[index,11002,2]));
    expect(same.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeTreasureAction:{requestId:id,
      effects:[{type:"drawn",mode:"advanced",count:5,cost:300,score:700,draws:5,
        rewards:Array.from({length:5},(_,index)=>({index,sourceOriginalIndex:4,templateId:11002,itemCount:2}))}]}});
    const competing = await race("treasure-legacy-native-draws-different-uuids",[
      ()=>post(appA,"treasure",{type:"draw",count:2}),
      ()=>post(appB,"treasure-native",{type:"draw",mode:"normal",count:1,choice:first.nativeTreasure.bagToken})]);
    expect(competing[0].statusCode,competing[0].body).toBe(200); expect([200,400]).toContain(competing[1].statusCode);
    const nativeWon = competing[1].statusCode===200, draws = nativeWon?8:7, current = await snapshot(), after = await saved();
    expect(competing[0].json()).not.toHaveProperty("nativeTreasureAction");
    if(nativeWon) expect(competing[1].json()).toHaveProperty("nativeTreasureAction");
    else expect(competing[1].json().message).toContain("临时包、分类或日期已更新");
    expect(await wallet()).toEqual({Points:nativeWon?610:640,Revision:nativeWon?5:4});
    expect(current.nativeTreasure).toMatchObject({draws,bagSlotsUsed:draws});
    expect(current.nativeTreasure.bag.map(row=>[row.index,row.templateId,row.itemCount])).toEqual(Array.from({length:draws},(_,index)=>[index,11002,index<5?2:1]));
    expect(after.receipts).toHaveLength(nativeWon?5:4); expect(after.goods).toEqual([]); expect(after.mails).toEqual([]);
    const state = (await q1<{State:ActivityState}>(monitor,sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))!.State;
    expect(state.games).not.toHaveProperty("treasureNativeV1"); expect(state.daily.actions).toBe(nativeWon?3:2);
    const replay = await action("treasure-native",value,id,appB); expect(replay).toMatchObject({...current,replayed:true});
    expect(replay).not.toHaveProperty("nativeTreasureAction");
    expect((await post(appA,"moonlight-native",{type:"draw",count:1,choice:(await snapshot()).nativeMoonlight.bagToken},id)).statusCode).toBe(409);
    expect(await saved()).toEqual(after); passed++;
  });
  it("takes one Treasure slot per UUID, preserves the other draw rows and settles one legacy/native whole-bag competitor", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    const ready = await action("treasure-native",{type:"draw",mode:"advanced",count:5,choice:(await snapshot()).nativeTreasure.bagToken});
    const id = randomUUID(), value = {type:"take",index:2,choice:ready.nativeTreasure.bagToken}, before = await saved();
    const one = await race("treasure-single-slot-take-same-uuid",duplicates("treasure-native",value,id));
    duplicateResults(one,"nativeTreasureAction"); expect(await wallet()).toEqual({Points:700,Revision:2});
    const partial = await saved(), current = await snapshot();
    expect(current.nativeTreasure.bag.map(row=>[row.index,row.templateId,row.itemCount])).toEqual(Array.from({length:4},(_,index)=>[index,11002,2]));
    expect(current.nativeTreasure.bagToken).not.toBe(ready.nativeTreasure.bagToken);
    expect(partial.goods.map(item=>[item.TemplateID,item.Count])).toEqual([[11002,2]]); expect(partial.mails).toHaveLength(1);
    expect(partial.goods[0]).toMatchObject({UserID:0,Place:-1,IsBinds:true,ValidDate:0}); expect(Number(partial.mails[0].Annex1)).toBe(partial.goods[0].ItemID);
    expect(partial.receipts.length-before.receipts.length).toBe(1);
    expect(one.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeTreasureAction:{requestId:id,effects:[{type:"taken",itemCount:2,items:[{index:2,templateId:11002,itemCount:2}]}]}});
    expect((await post(appA,"treasure-native",{type:"take",index:2,choice:ready.nativeTreasure.bagToken})).statusCode).toBe(400);
    expect(await saved()).toEqual(partial);
    const whole = await race("treasure-native-take-legacy-recycle-different-uuids",[
      ()=>post(appA,"treasure-native",{type:"take",choice:current.nativeTreasure.bagToken}),
      ()=>post(appB,"treasure",{type:"recycle"})]);
    expect(whole.map(response=>response.statusCode).sort()).toEqual([200,400]);
    const took = whole[0].statusCode===200, after = await saved(); expect(await wallet()).toEqual({Points:took?700:716,Revision:3});
    expect((await snapshot()).nativeTreasure.bag).toEqual([]); expect(after.receipts.length-partial.receipts.length).toBe(1);
    if(took) {
      expect(whole[0].json()).toMatchObject({mailedCount:1,nativeTreasureAction:{effects:[{type:"taken",itemCount:8}]}});
      expect(after.goods.slice(partial.goods.length).map(item=>item.Count)).toEqual([2,2,2,2]);
      expect(after.mails.length-partial.mails.length).toBe(1);
    } else {
      expect(whole[1].json()).not.toHaveProperty("nativeTreasureAction"); expect(after.goods).toEqual(partial.goods); expect(after.mails).toEqual(partial.mails);
    }
    const expired = `${new Date(Date.parse(`${day}T00:00:00Z`)-86400000).toISOString().slice(0,10)}:${current.nativeTreasure.bagToken.split(":")[1]}`;
    expect((await post(appB,"treasure-native",{type:"draw",mode:"normal",count:1,choice:expired})).statusCode).toBe(400);
    const replay = await action("treasure-native",value,id,appA); expect(replay).toMatchObject({replayed:true,mailedCount:1}); expect(replay.nativeTreasure.bag).toEqual([]);
    expect(replay).not.toHaveProperty("nativeTreasureAction"); expect(await saved()).toEqual(after); passed++;
  });
  it("reverts Treasure full-bag mail and recycled points on final receipt failures, then retries each UUID once", async () => {
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,0)`);
    const first = await action("treasure-native",{type:"draw",mode:"advanced",count:5,choice:(await snapshot()).nativeTreasure.bagToken});
    const ready = await action("treasure-native",{type:"draw",mode:"advanced",count:5,choice:first.nativeTreasure.bagToken});
    expect(ready.nativeTreasure.bag.map(row=>[row.templateId,row.itemCount])).toEqual([...Array.from({length:9},()=>[11002,2]),[11021,4]]);
    const id = randomUUID(), value = {type:"take",choice:ready.nativeTreasure.bagToken}, before = await saved();
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${id}') NOT VALID`));
    const failed = await post(appB,"treasure-native",value,id); expect(failed.statusCode,failed.body).toBe(500);
    expect(failed.body).not.toMatch(/native_test_receipt_failure|INSERT|UPDATE|Annex/); expect(await saved()).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const retry = await race("treasure-full-mail-tail-failure-retry-same-uuid",duplicates("treasure-native",value,id));
    duplicateResults(retry,"nativeTreasureAction"); expect(await wallet()).toEqual({Points:400,Revision:3});
    const delivered = await saved(), items = delivered.goods.slice(before.goods.length), mails = delivered.mails.slice(before.mails.length);
    expect(retry.find(response=>!response.json().replayed)!.json()).toMatchObject({mailedCount:2,nativeTreasureAction:{requestId:id,effects:[{type:"taken",itemCount:22}]}});
    expect(items.map(item=>[item.TemplateID,item.Count])).toEqual([...Array.from({length:9},()=>[11002,2]),[11021,4]]); expect(mails).toHaveLength(2);
    expect(items.every(item=>item.UserID===0&&item.Place===-1&&item.IsBinds===true&&item.ValidDate===0&&Number(item.Count)<=5)).toBe(true);
    expect(items.filter(item=>item.TemplateID===11002).reduce((sum,item)=>sum+Number(item.Count),0)).toBe(18);
    expect(items.filter(item=>item.TemplateID===11021).reduce((sum,item)=>sum+Number(item.Count),0)).toBe(4);
    expect(mails.flatMap(mail=>[mail.Annex1,mail.Annex2,mail.Annex3,mail.Annex4,mail.Annex5].filter(Boolean).map(Number))).toEqual(items.map(item=>item.ItemID));
    expect(delivered.receipts.length-before.receipts.length).toBe(1); expect((await snapshot()).nativeTreasure.bag).toEqual([]);
    const refill = await action("treasure-native",{type:"draw",mode:"advanced",count:1,choice:(await snapshot()).nativeTreasure.bagToken});
    const recycleId = randomUUID(), recycle = {type:"recycle",choice:refill.nativeTreasure.bagToken}, recycleBefore = await saved();
    assert.match(recycleId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await monitor.db.execute(sql.raw(`ALTER TABLE app."ActivityActions" ADD CONSTRAINT native_test_receipt_failure CHECK ("RequestID" <> '${recycleId}') NOT VALID`));
    expect((await post(appA,"treasure-native",recycle,recycleId)).statusCode).toBe(500); expect(await saved()).toEqual(recycleBefore);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT native_test_receipt_failure`);
    const recycled = await race("treasure-full-recycle-tail-failure-retry-same-uuid",duplicates("treasure-native",recycle,recycleId));
    duplicateResults(recycled,"nativeTreasureAction"); expect(await wallet()).toEqual({Points:344,Revision:5});
    expect(recycled.find(response=>!response.json().replayed)!.json()).toMatchObject({nativeTreasureAction:{requestId:recycleId,effects:[{type:"recycled",pointsAwarded:4,score:344}]}});
    const final = await saved(); expect(final.goods).toEqual(recycleBefore.goods); expect(final.mails).toEqual(recycleBefore.mails);
    expect(final.receipts.length-recycleBefore.receipts.length).toBe(1); expect((await snapshot()).nativeTreasure.bag).toEqual([]);
    const replay = await action("treasure-native",value,id,appB); expect(replay).toMatchObject({replayed:true,points:344});
    expect(replay).not.toHaveProperty("nativeTreasureAction"); expect(await saved()).toEqual(final); passed++;
  });
});
