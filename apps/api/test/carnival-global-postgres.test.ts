import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { advanceCarnivalGlobal } from "../src/activities/carnival-global.js";
import { advanceCarnivalNative, viewCarnivalNative } from "../src/activities/carnival-native.js";
import { createActivityState } from "../src/activities/engine.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(0.99 * min) : min + Math.floor(0.99 * (max - min)) }));
const url = process.env.WORKSHOP_CARNIVAL_GLOBAL_URL, token = process.env.WORKSHOP_CARNIVAL_GLOBAL_TOKEN;
const output = process.env.WORKSHOP_CARNIVAL_GLOBAL_OUTPUT;
const roles = [{ characterId: 811, nickName: "共享甲", name: "carnival-pg-a", account: 1 },
  { characterId: 812, nickName: "共享乙", name: "carnival-pg-b", account: 2 }];
const secret = "isolated-carnival-global-tests-only";
type App = Awaited<ReturnType<typeof buildApp>>;
let observer: DbHandle, holder: DbHandle, a: DbHandle, b: DbHandle, appA: App, appB: App;
let config: NonNullable<Parameters<typeof buildApp>[0]>["config"], passed = 0;
const pids: number[] = [], locks: unknown[] = [];
const headers = (id: number) => { const role = roles.find(r => r.characterId === id)!;
  return { authorization: `Bearer ${signJwt({ sub: role.account, name: role.name, role: "player" }, secret, 3600)}` }; };
const post = (app: App, id: number, action: ActivityAction, requestId = randomUUID()) => app.app.inject({
  method: "POST", url: "/api/account/activities/carnival-native/action", headers: headers(id), payload: { characterId: id, requestId, action } });
async function snapshot(app = appA, id = 811) {
  const r = await app.app.inject({ url: `/api/account/activities?characterId=${id}`, headers: headers(id) });
  expect(r.statusCode, r.body).toBe(200); return r.json<ActivityResult>();
}
const drawAction = async (id = 811, count = 1): Promise<ActivityAction> => ({ type: "draw", count, choice: (await snapshot(appA, id)).nativeCarnival.stateToken });
async function saved() { return {
  global: await q(observer, sql`SELECT * FROM app."CarnivalGlobalState" ORDER BY "Key"`),
  wallets: await q(observer, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(observer, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(observer, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  mails: await q(observer, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
  goods: await q(observer, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
}; }
async function seed(draws: number) {
  let world: unknown;
  const counts = [Math.ceil(draws / 2), Math.floor(draws / 2)];
  for (const [index, role] of roles.entries()) {
    const root = createActivityState(new Date());
    let walletRevision = 0;
    for (let done = 0; done < counts[index]!;) {
      const count = Math.min(5, counts[index]! - done), now = new Date(), points = { points: 100_000 };
      root.games.carnivalNativeV1 = advanceCarnivalNative(root.games.carnivalNativeV1, {
        type: "draw", count, choice: viewCarnivalNative(root.games.carnivalNativeV1, { now }, points).stateToken,
      }, { now }, points, () => 0.99).state;
      const result = advanceCarnivalGlobal(world, { characterId: role.characterId, walletRevision: ++walletRevision,
        draws: count, now, eligibleParticipants: roles.map(({ characterId, nickName }) => ({ characterId, nickName })) }, () => 0.99);
      expect(result.worldEffects).toHaveLength(0); world = result.state; done += count;
    }
    root.daily.actions = counts[index]!;
    await observer.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=${Math.max(1, walletRevision)} WHERE "UserID"=${role.characterId}`);
    await observer.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State")
      VALUES (${role.characterId},'reference',${JSON.stringify(root)}::jsonb)`);
  }
  if (world !== undefined) await observer.db.execute(sql`INSERT INTO app."CarnivalGlobalState" ("Key","State") VALUES ('native-v1',${JSON.stringify(world)}::jsonb)`);
}
async function race(label: string, calls: (() => ReturnType<typeof post>)[], target: "global" | "wallet" = "global") {
  const before = await saved(); let acquired!: () => void, release!: () => void;
  const locked = new Promise<void>(resolve => { acquired = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const transaction = holder.db.transaction(async tx => {
    if (target === "global") await tx.execute(sql`SELECT "Key" FROM app."CarnivalGlobalState" WHERE "Key"='native-v1' FOR UPDATE`);
    else await tx.execute(sql`SELECT "UserID" FROM app."ActivityWallet" WHERE "UserID"=811 FOR UPDATE`);
    acquired(); await gate;
  });
  await locked; const promises = calls.map(call => call()); for (const p of promises) void p.catch(() => {});
  let failure: unknown;
  try {
    const deadline = performance.now() + 8_000; let observed: { pid: number; blockers: number[]; wait_event_type: string; query: string }[] = [];
    while (performance.now() < deadline) {
      observed = await q(observer, sql`SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type,query FROM pg_stat_activity
        WHERE pid IN (${pids[2]},${pids[3]}) ORDER BY pid`);
      if (observed.length === 2 && observed.every(r => r.wait_event_type === "Lock" && r.blockers.length > 0)) break;
      await delay(25);
    }
    expect(observed).toHaveLength(2);
    expect(observed.every(r => r.wait_event_type === "Lock" && r.blockers.length > 0)).toBe(true);
    expect(observed.every(r => r.query.includes(target === "global" ? "CarnivalGlobalState" : "ActivityWallet"))).toBe(true);
    expect(await saved()).toEqual(before);
    locks.push({ label, target, connections: observed.map(({ pid, blockers, wait_event_type }) => ({ pid, blockers, wait_event_type })) });
  } catch (error) { failure = error; }
  finally { release(); await transaction; }
  const results = await Promise.all(promises); if (failure) throw failure; return results;
}
async function totals() {
  return await q<{ TemplateID: number; count: number }>(observer, sql`SELECT "TemplateID",sum("Count")::int AS count FROM player."Sys_Users_Goods"
    GROUP BY "TemplateID" ORDER BY "TemplateID"`);
}

describe.skipIf(!url)("shared Carnival native PostgreSQL atomic rounds", () => {
  beforeAll(async () => {
    assert(url && token && output); const u = new URL(url), database = u.pathname.slice(1);
    assert.match(token, /^[a-f0-9-]{36}$/); assert.equal(database, `workshop_carnival_${token.replaceAll("-", "")}`);
    assert.equal(u.hostname, "127.0.0.1"); assert.equal(u.port, process.env.WORKSHOP_CARNIVAL_GLOBAL_PORT);
    assert.notEqual(u.port, "55432"); assert.equal(u.search, "");
    observer = await createDb(url, { max: 1 });
    expect(await q(observer, sql`SELECT token FROM public."WorkshopCarnivalTest"`)).toEqual([{ token }]);
    expect(await q(observer, sql`SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`)).toEqual([{ tablename: "WorkshopCarnivalTest" }]);
    await migrateDb(observer); holder = await createDb(url, { max: 1 }); a = await createDb(url, { max: 1 }); b = await createDb(url, { max: 1 });
    for (const [index, h] of [observer, holder, a, b].entries()) {
      const identity = await q1<{ database: string; pid: number; host: string }>(h, sql`SELECT current_database() AS database,pg_backend_pid() AS pid,host(inet_server_addr()) AS host`);
      assert.equal(identity?.database, database); assert.equal(identity.host, "127.0.0.1"); pids.push(identity!.pid);
      await h.db.execute(sql`SELECT set_config('application_name',${`carnival_global_test_${index}`},false)`);
      await h.db.execute(sql`SET statement_timeout='20000ms'`);
    }
    expect(new Set(pids).size).toBe(4);
    const template: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "PG material", CanRecycle: 0, CategoryID: 11,
      Attack: 0, Defence: 0, Agility: 0, Luck: 0, Level: 1, Quality: 1, MaxCount: 9999, NeedSex: 0, NeedLevel: 1,
      CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
      Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
      BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
    await observer.db.insert(game.Shop_Goods).values(PRIZES.map(p => ({ ...template, TemplateID: p.templateId, Name: p.name })));
    config = { NODE_ENV: "test", DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false,
      RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "", FLASH_DIR: join(output, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(output, "resource"),
      UPLOAD_DIR: join(output, "uploads"), REQUEST_SNAPSHOT_DIR: join(output, "snapshots"), RUFFLE_DIR: join(output, "ruffle"), CELEB_REBUILD_MIN: 0 };
    appA = await buildApp({ db: a, logger: false, skipTemplates: true, env: {}, config });
    appB = await buildApp({ db: b, logger: false, skipTemplates: true, env: {}, config });
  });
  beforeEach(async () => {
    await observer.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS carnival_global_mail_failure`);
    await observer.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS carnival_global_receipt_failure`);
    await observer.db.execute(sql`TRUNCATE app."CarnivalGlobalState",app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
      member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
    for (const role of roles) {
      await observer.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (${role.account},${role.name},'tests-only')`);
      await observer.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
        VALUES (${role.characterId},${role.name},${role.nickName},true,'2000-01-01',1)`);
      await observer.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned","Revision") VALUES (${role.characterId},1000,0,1)`);
    }
  });
  afterAll(async () => {
    await appA?.app.close(); await appB?.app.close();
    await Promise.all([observer, holder, a, b].filter(Boolean).map(h => h.close()));
    if (output) writeFileSync(join(output, "test-evidence.json"), JSON.stringify({ token, passed, connectionPids: pids, locks, closedConnections: true }, null, 2) + "\n");
  });
  it("reads an absent shared era without creating or backfilling it", async () => {
    await seed(0); const before = await saved();
    for (const role of roles) expect((await snapshot(appA, role.characterId)).nativeCarnival.global).toMatchObject({ revision: 0, actorRevision: 1,
      totalDraws: 0, roundId: 1, roundDraws: 0, participantCount: 0, myRoundDraws: 0 });
    expect(await saved()).toEqual(before); passed++;
  });
  it("serializes two actual actors at the round boundary and awards exactly once", async () => {
    await seed(99); const actions = await Promise.all(roles.map(r => drawAction(r.characterId)));
    const results = await race("different-actors-one-shared-boundary", [() => post(appA, 811, actions[0]!), () => post(appB, 812, actions[1]!)]);
    expect(results.map(r => r.statusCode)).toEqual([200, 200]);
    expect(results.map(r => r.json().nativeCarnivalAction.worldEffects.length).sort()).toEqual([0, 1]);
    const result = await snapshot(); expect(result.nativeCarnival.global).toMatchObject({ revision: 101, totalDraws: 101, roundId: 2, roundDraws: 1 });
    expect(result.nativeCarnival.global!.recentRounds).toHaveLength(1);
    expect((await saved()).wallets).toMatchObject([{ UserID: 811, Points: 990, Revision: 11 }, { UserID: 812, Points: 990, Revision: 11 }]);
    expect(await totals()).toEqual([{ TemplateID: 11002, count: 8 }, { TemplateID: 11019, count: 100 }, { TemplateID: 11021, count: 2 }]); passed++;
  });
  it("deduplicates eight same-UUID retries before shared progression", async () => {
    await seed(99); const action = await drawAction(), id = randomUUID();
    const results = await race("same-uuid-eight-retries", Array.from({ length: 8 }, (_, i) => () => post(i % 2 ? appB : appA, 811, action, id)), "wallet");
    expect(results.every(r => r.statusCode === 200)).toBe(true);
    expect(results.filter(r => r.json().replayed)).toHaveLength(7);
    expect(results.filter(r => r.json().nativeCarnivalAction)).toHaveLength(1);
    expect((await snapshot()).nativeCarnival.global).toMatchObject({ revision: 100, roundId: 2, roundDraws: 0 });
    expect((await saved()).receipts).toHaveLength(1); passed++;
  });
  it("keeps a five-draw batch atomic across one round and records its remainder", async () => {
    await seed(98); const result = await post(appA, 811, await drawAction(811, 5)); expect(result.statusCode, result.body).toBe(200);
    const body = result.json<ActivityResult>(); expect(body.nativeCarnivalAction!.effects).toHaveLength(5);
    expect(body.nativeCarnivalAction!.worldEffects).toHaveLength(1);
    expect(body.nativeCarnival.global).toMatchObject({ revision: 103, roundId: 2, roundDraws: 3, myRoundDraws: 3, pool: { templateId: 11019, itemCount: 3 } });
    expect((await saved()).receipts).toHaveLength(1); passed++;
  });
  it("rolls back all actors' awards, shared pool, debit and UUID on recipient mail failure", async () => {
    await seed(99); const action = await drawAction(), id = randomUUID(), before = await saved();
    await observer.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT carnival_global_mail_failure CHECK ("ReceiverID"<>812) NOT VALID`);
    const failed = await post(appA, 811, action, id); expect(failed.statusCode).toBe(500); expect(await saved()).toEqual(before);
    await observer.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT carnival_global_mail_failure`);
    const retried = await post(appB, 811, action, id); expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().nativeCarnivalAction.worldEffects).toHaveLength(1);
    expect((await snapshot()).nativeCarnival.global).toMatchObject({ revision: 100 });
    expect((await saved()).receipts).toHaveLength(1); passed++;
  });
  it("rolls back a completed round if its receipt fails, then retries the identical UUID once", async () => {
    await seed(99); const action = await drawAction(), id = randomUUID(), before = await saved();
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    // PostgreSQL utility statements cannot retain prepared parameters in a CHECK definition.
    await observer.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT carnival_global_receipt_failure CHECK ("RequestID"<>${sql.raw("'" + id + "'")}) NOT VALID`);
    expect((await post(appA, 811, action, id)).statusCode).toBe(500); expect(await saved()).toEqual(before);
    await observer.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT carnival_global_receipt_failure`);
    expect((await post(appB, 811, action, id)).statusCode).toBe(200);
    expect((await snapshot()).nativeCarnival.global!.recentRounds).toHaveLength(1); passed++;
  });
  it("replays a prior round request as the newest view without further awards", async () => {
    await seed(99); const first = await drawAction(), id = randomUUID(); expect((await post(appA, 811, first, id)).statusCode).toBe(200);
    expect((await post(appB, 812, await drawAction(812))).statusCode).toBe(200); const before = await saved();
    const replay = await post(appB, 811, first, id); expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, nativeCarnival: { global: { revision: 101 } } });
    expect(replay.json()).not.toHaveProperty("nativeCarnivalAction"); expect(await saved()).toEqual(before); passed++;
  });
  it("excludes a banned contributor from all three actual mail awards", async () => {
    await seed(99); await observer.db.execute(sql`UPDATE member."Accounts" SET "IsBanned"=true WHERE "ID"=2`);
    const r = await post(appA, 811, await drawAction()); expect(r.statusCode, r.body).toBe(200);
    expect(r.json().nativeCarnivalAction.worldEffects[0].awards.map((a: { characterId: number }) => a.characterId)).toEqual([811, 811, 811]);
    expect((await saved()).mails.every((m: unknown) => (m as { ReceiverID: number }).ReceiverID === 811)).toBe(true); passed++;
  });
  it("waits for a concurrent account ban before deciding shared award eligibility", async () => {
    await seed(99); const action = await drawAction(), before = await saved();
    let acquired!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ban = holder.db.transaction(async tx => {
      await tx.execute(sql`UPDATE member."Accounts" SET "IsBanned"=true WHERE "ID"=2`);
      acquired(); await gate;
    });
    await locked; let completed = false;
    const request = post(appA, 811, action).then(result => { completed = true; return result; });
    void request.catch(() => {});
    let failure: unknown;
    try {
      const deadline = performance.now() + 8_000;
      let observed: { pid: number; blockers: number[]; wait_event_type: string; query: string }[] = [];
      while (performance.now() < deadline) {
        observed = await q(observer, sql`SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type,query
          FROM pg_stat_activity WHERE pid=${pids[2]}`);
        if (observed[0]?.wait_event_type === "Lock" && observed[0].blockers.includes(pids[1]!)) break;
        await delay(25);
      }
      expect(completed).toBe(false); expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ wait_event_type: "Lock", blockers: [pids[1]] });
      expect(observed[0]!.query).toContain('Accounts'); expect(await saved()).toEqual(before);
      locks.push({ label: "ban-before-qualification", target: "account", connections: observed });
    } catch (error) { failure = error; }
    finally { release(); await ban; }
    const response = await request; if (failure) throw failure;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().nativeCarnivalAction.worldEffects[0].awards.map((award: { characterId: number }) => award.characterId)).toEqual([811, 811, 811]);
    expect((await saved()).mails.every((mail: unknown) => (mail as { ReceiverID: number }).ReceiverID === 811)).toBe(true); passed++;
  }, 20_000);
  it("recovers the shared era and immutable settlements after rebuilding one API", async () => {
    await seed(99); expect((await post(appA, 811, await drawAction())).statusCode).toBe(200);
    const before = await saved(), view = (await snapshot()).nativeCarnival.global;
    await appA.app.close(); appA = await buildApp({ db: a, logger: false, skipTemplates: true, env: {}, config });
    expect((await snapshot()).nativeCarnival.global).toEqual(view); expect(await saved()).toEqual(before); passed++;
  });
});
