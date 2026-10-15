import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, inflateSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb, game as gameTables, migrateDb, player, type Database, type DbHandle } from "@ddt/db";
import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPlayerInfo } from "../../game/src/db/characters.js";
import { Templates } from "../../game/src/db/templates.js";
import { hasClaim } from "../../game/src/game/events.js";
import { GamePlayer } from "../../game/src/game/player.js";
import { defaultMatch } from "../../game/src/game/player-info.js";
import { eventsRuntime, signAward, signIn } from "../../game/src/handlers/events.js";
import { World, type ServerContext } from "../../game/src/session/context.js";
import type { AppCtx } from "../src/context.js";
import { createActivityState } from "../src/activities/engine.js";
import type { FirstRechargeNativeState } from "../src/activities/first-recharge-native.js";
import { advanceMoonlight, viewMoonlightNative } from "../src/activities/moonlight-native.js";
import { activityAction, activitySnapshot } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { requestRoutes } from "../src/routes/request.js";

const clock = vi.hoisted(() => ({ now: "2026-10-15T01:00:00Z" }));
vi.mock("../src/lib/flash-xml.js", async original => ({
  ...await original<typeof import("../src/lib/flash-xml.js")>(), wallNow: () => new Date(clock.now),
}));

const url = process.env.WORKSHOP_CALENDAR_URL, token = process.env.WORKSHOP_CALENDAR_TOKEN;
let monitor: DbHandle, a: DbHandle, b: DbHandle, game: DbHandle, apiA: FastifyInstance, apiB: FastifyInstance;
let database: string, output: string, passed = 0, sequence = 0;
const connectionPids: number[] = [], scenarios: unknown[] = [];
const check = (label: string, run: () => Promise<void>) => it(label, async () => { await run(); passed++; });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
type Pause = { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; used: boolean };
let pause: Pause | undefined;

// The SELECT runs on the real connection before its result is paused. Transactions
// retain their real locks; this changes scheduling, never returned rows or SQL.
function instrument(db: Database): Database {
  return new Proxy(db, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (key === "execute") return async (query: SQL) => {
      const result = await target.execute(query);
      const current = pause;
      if (current && !current.used && /\bFROM\s+player\."DailyLogList"/i.test(new PgDialect().sqlToQuery(query).sql)) {
        current.used = true; current.entered.resolve(); await current.release.promise;
      }
      return result;
    };
    if (key === "transaction") return (work: (tx: Database) => Promise<unknown>, ...args: unknown[]) =>
      value.call(target, (tx: Database) => work(instrument(tx)), ...args);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

async function buildApi(h: DbHandle) {
  const api = Fastify({ logger: false });
  await requestRoutes(api, { h, cache: { byEndpoint: () => undefined }, log: { warn: () => {}, error: () => {} } } as unknown as AppCtx);
  return api;
}
async function calendar(api: FastifyInstance, uid: number, authenticated = false) {
  const key = authenticated ? createHash("md5").update(`game-${uid}`).digest("hex") : "x";
  const response = await api.inject({ method: "GET", url: `/request/${authenticated ? "UserCalendar" : "dailyloglist"}.ashx?selfid=${uid}&key=${key}` });
  return { response, text: inflateSync(response.rawPayload).toString("utf8") };
}
const rows = (uid: number) => monitor.db.select().from(player.DailyLogList).where(eq(player.DailyLogList.UserID, uid));
const context = () => ({ db: game, now: () => new Date(clock.now), lang: { t: (key: string) => key } }) as ServerContext;
async function character() {
  const [owner] = await monitor.db.insert(player.Sys_Users_Detail).values({ UserName: `calendar-${++sequence}`, NickName: `Calendar ${sequence}`, Password: "test", Sex: true, IsFirst: 1, ForbidDate: new Date("2000-01-01T00:00:00Z") }).returning();
  const uid = owner!.UserID;
  await monitor.db.execute(sql`INSERT INTO app."LoginSessions" ("UserName","WebKey","GameKey","UserID","Count","ExpiresAt","GameKeyExpiresAt")
    VALUES (${owner!.UserName}, ${`web-${uid}`}, ${`game-${uid}`}, ${uid}, 1, '2100-01-01', '2100-01-01')`);
  return uid;
}
async function interleave<T>(label: string, first: () => Promise<unknown>, secondPid: number, second: () => Promise<T>, beforeRelease?: () => void) {
  const gate = { entered: deferred(), release: deferred(), used: false }; pause = gate;
  const firstCall = first(); void firstCall.catch(() => {});
  let secondCall: Promise<T> | undefined, settled = false, observed: unknown, failure: unknown;
  try {
    await Promise.race([gate.entered.promise, delay(5000).then(() => { throw new Error("Calendar SELECT pause not reached"); })]);
    secondCall = second(); void secondCall.then(() => { settled = true; }, () => { settled = true; });
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const state = await q1<{ pid: number; blockers: number[]; wait: string; query: string }>(monitor,
        sql`SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type AS wait,query FROM pg_stat_activity WHERE pid=${secondPid}`);
      if (state?.wait === "Lock" && state.blockers.includes(connectionPids[1]!)) { observed = { state: "blocked", ...state }; break; }
      if (settled) { observed = { state: "completed-before-release", pid: secondPid }; break; }
      await delay(10);
    }
    assert(observed, "Neither real owner-lock wait nor completion observed");
    scenarios.push({ label, observed });
    beforeRelease?.();
  } catch (error) { failure = error; } finally { gate.release.resolve(); pause = undefined; }
  const results = await Promise.allSettled([firstCall, secondCall]);
  if (failure) throw failure;
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return { firstResult: (results[0] as PromiseFulfilledResult<unknown>).value,
    secondResult: (results[1] as PromiseFulfilledResult<T>).value };
}
function success(text: string) { expect(text).toContain('value="true"'); expect(text).toContain('<DailyLogList UserAwardLog='); }

describe.skipIf(!url || !token)("Calendar and activity clocks through fresh PostgreSQL owner locks", () => {
  beforeAll(async () => {
    assert(url && token); const parsed = new URL(url); database = parsed.pathname.slice(1); output = process.env.WORKSHOP_CALENDAR_OUTPUT!;
    assert.match(token, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.equal(database, `workshop_calendar_${token.replaceAll("-", "")}`);
    assert.equal(parsed.protocol, "postgres:"); assert.equal(parsed.hostname, "127.0.0.1");
    assert.equal(process.env.WORKSHOP_CALENDAR_PORT, "55439"); assert.equal(parsed.port, process.env.WORKSHOP_CALENDAR_PORT);
    assert(!parsed.search && !parsed.hash && output);
    assert.equal(process.env.WORKSHOP_CALENDAR_CLUSTER, resolve(output, "data"));
    monitor = await createDb(url, { max: 1, logger: false });
    expect(await q(monitor, sql`SELECT token FROM public."WorkshopCalendarTest"`)).toEqual([{ token }]);
    expect(await q(monitor, sql`SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`)).toEqual([{ tablename: "WorkshopCalendarTest" }]);
    await migrateDb(monitor);
    const templates = (JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString()) as
      (Omit<typeof gameTables.Shop_Goods.$inferInsert, "AddTime"> & { AddTime: string })[]).filter(item => [40002, 11019].includes(item.TemplateID));
    assert.equal(templates.length, 2);
    await monitor.db.insert(gameTables.Shop_Goods).values(templates.map(item => ({ ...item, AddTime: new Date(item.AddTime) })));
    a = await createDb(url, { max: 1 }); b = await createDb(url, { max: 1 }); game = await createDb(url, { max: 1 });
    for (const [index, h] of [monitor, a, b, game].entries()) {
      assert.equal(h.kind, "postgres");
      const identity = await q1<{ database: string; port: number; pid: number; directory: string }>(h,
        sql`SELECT current_database() AS database,inet_server_port() AS port,pg_backend_pid() AS pid,current_setting('data_directory') AS directory`);
      assert.equal(identity?.database, database); assert.equal(identity.port, 55439);
      assert.equal(realpathSync(identity.directory), realpathSync(resolve(output, "data"))); connectionPids.push(identity.pid);
      await h.db.execute(sql`SELECT set_config('application_name',${`workshop_calendar_test_${index}`},false)`);
      await h.db.execute(sql`SET statement_timeout='10000ms'`);
    }
    expect(new Set(connectionPids).size).toBe(4);
    apiA = await buildApi({ ...a, db: instrument(a.db) }); apiB = await buildApi(b);
  });
  beforeEach(async () => { clock.now = "2026-10-15T01:00:00Z"; });
  afterAll(async () => {
    pause?.release.resolve();
    const apps = await Promise.allSettled([apiA, apiB].filter(Boolean).map(api => api.close()));
    const connections = await Promise.allSettled([monitor, a, b, game].filter(Boolean).map(h => h.close()));
    const closedConnections = connections.every(result => result.status === "fulfilled");
    if (output) writeFileSync(join(output, "test-evidence.json"), JSON.stringify({ database, token, passed, connectionPids, scenarios, closedConnections }, null, 2) + "\n");
    for (const result of [...apps, ...connections]) if (result.status === "rejected") throw result.reason;
  });

  check("both calendar entry points preserve a concurrent real sign and the reached packet-90 reward", async () => {
    for (const authenticated of [true, false]) {
      const uid = await character();
      await monitor.db.insert(player.DailyLogList).values({ UserID: uid, DayLog: "True,True", UserAwardLog: 2, LastDate: new Date(clock.now) });
      const { firstResult, secondResult } = await interleave(`existing-calendar-${authenticated ? "authenticated" : "legacy"}`,
        () => calendar(apiA, uid, authenticated), connectionPids[3]!, () => signIn(context(), { id: uid } as GamePlayer));
      success((firstResult as Awaited<ReturnType<typeof calendar>>).text); expect(secondResult).toBe(true);
      const saved = await rows(uid); expect(saved).toHaveLength(1); expect(saved[0]!.UserAwardLog).toBe(3);
      expect(saved[0]!.DayLog!.split(",").filter(day => day === "True")).toHaveLength(3);
      expect(await hasClaim(monitor.db, uid, "sign", "2026-10-15")).toBe(true);
      expect(await signIn(context(), { id: uid } as GamePlayer)).toBe(false);
      const info = (await loadPlayerInfo(game.db, uid))!;
      const p = new GamePlayer({ send: () => {}, disconnect: () => {}, remoteAddress: "calendar-test" }, info, defaultMatch(uid), 1, "test");
      const ctx = { ...context(), templates: new Templates(), world: new World() } as ServerContext; ctx.world.add(p);
      eventsRuntime(ctx).data.dailyAward = [{ ID: 1, Type: 7, TemplateID: -1100, Count: 9, AwardDays: 3, Sex: 0 }] as never;
      expect(await signAward(ctx, p, 3)).toBe(true); expect(await signAward(ctx, p, 3)).toBe(false);
      expect((await q1<{ GiftToken: number }>(monitor, sql`SELECT "GiftToken" FROM player."Sys_Users_Detail" WHERE "UserID"=${uid}`))!.GiftToken).toBe(info.GiftToken);
      expect(p.info.GiftToken).toBe(9);
    }
  });

  check("two legacy first loads for one existing character create exactly one calendar", async () => {
    const uid = await character();
    const { firstResult, secondResult } = await interleave("legacy-first-creation", () => calendar(apiA, uid), connectionPids[2]!, () => calendar(apiB, uid));
    success((firstResult as Awaited<ReturnType<typeof calendar>>).text); success(secondResult.text);
    expect(await rows(uid)).toHaveLength(1);
    expect(await q(monitor, sql`SELECT 1 FROM app."EventClaims" WHERE "UserID"=${uid}`)).toEqual([]);
  });

  check("legacy month normalization cannot erase a newly committed first sign of the next month", async () => {
    const uid = await character(); clock.now = "2026-11-01T00:00:01Z";
    await monitor.db.insert(player.DailyLogList).values({ UserID: uid, DayLog: "True,True", UserAwardLog: 2, LastDate: new Date("2026-10-31T23:59:59Z") });
    await interleave("legacy-month-rollover", () => calendar(apiA, uid), connectionPids[3]!, () => signIn(context(), { id: uid } as GamePlayer));
    expect(await rows(uid)).toMatchObject([{ DayLog: "True", UserAwardLog: 1, LastDate: new Date(clock.now) }]);
    expect(await hasClaim(monitor.db, uid, "sign", "2026-11-01")).toBe(true);
    expect(await signIn(context(), { id: uid } as GamePlayer)).toBe(false);
  });

  check("packet-90 eligibility uses the current month after waiting for the real owner lock", async () => {
    const uid = await character(); clock.now = "2026-10-31T23:59:59Z";
    await monitor.db.insert(player.DailyLogList).values({ UserID: uid, DayLog: "True,True,True", UserAwardLog: 3, LastDate: new Date(clock.now) });
    const info = (await loadPlayerInfo(game.db, uid))!;
    const sent: unknown[] = [];
    const p = new GamePlayer({ send: packet => { sent.push(packet); }, disconnect: () => {}, remoteAddress: "calendar-test" }, info, defaultMatch(uid), 1, "test");
    const ctx = { ...context(), templates: new Templates(), world: new World() } as ServerContext; ctx.world.add(p);
    eventsRuntime(ctx).data.dailyAward = [{ ID: 1, Type: 7, TemplateID: -1100, Count: 9, AwardDays: 3, Sex: 0 }] as never;
    const before = p.info.GiftToken;
    const { firstResult, secondResult } = await interleave("queued-date-sign-award", () => calendar(apiA, uid, true),
      connectionPids[3]!, () => signAward(ctx, p, 3), () => { clock.now = "2026-11-01T00:00:01Z"; });
    success((firstResult as Awaited<ReturnType<typeof calendar>>).text);
    expect(secondResult).toBe(false);
    expect(await hasClaim(monitor.db, uid, "signaward", "2026-10:3")).toBe(false);
    expect(await hasClaim(monitor.db, uid, "signaward", "2026-11:3")).toBe(false);
    expect(p.info.GiftToken).toBe(before);
    expect((await q1<{ GiftToken: number }>(monitor, sql`SELECT "GiftToken" FROM player."Sys_Users_Detail" WHERE "UserID"=${uid}`))!.GiftToken).toBe(before);
    expect(sent).toEqual([]);
    expect(await q(monitor, sql`SELECT 1 FROM player."User_Messages" WHERE "ReceiverID"=${uid}`)).toEqual([]);
    expect(await q(monitor, sql`SELECT 1 FROM player."Sys_Users_Goods" WHERE "UserID"=${uid}`)).toEqual([]);
  });

  check("retains compressed legacy GET and authenticated XML contracts and leaves failed calendar writes uncommitted", async () => {
    const uid = await character();
    await monitor.db.execute(sql`CREATE FUNCTION public.calendar_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected calendar failure'; END; $$`);
    await monitor.db.execute(sql`CREATE TRIGGER calendar_write_failure BEFORE INSERT OR UPDATE ON player."DailyLogList" FOR EACH ROW EXECUTE FUNCTION public.calendar_write_failure()`);
    try {
      for (const authenticated of [false, true]) {
        const failed = await calendar(apiA, uid, authenticated);
        expect(failed.text).toContain('value="false" message="Fail!"');
        expect(failed.text).toContain('nowDate="2026-10-15');
        expect(await rows(uid)).toEqual([]);
        expect(await q(monitor, sql`SELECT 1 FROM app."EventClaims" WHERE "UserID"=${uid}`)).toEqual([]);
      }
    } finally { await monitor.db.execute(sql`DROP TRIGGER calendar_write_failure ON player."DailyLogList"`); await monitor.db.execute(sql`DROP FUNCTION public.calendar_write_failure()`); }
    const legacy = await calendar(apiA, uid), authenticated = await calendar(apiB, uid, true);
    for (const result of [legacy, authenticated]) {
      expect(result.response.statusCode).toBe(200); expect(result.response.headers["cache-control"]).toBe("no-store"); success(result.text);
      expect(result.text).toContain('nowDate="2026-10-15');
      expect(result.text).toMatch(/<DailyLogList UserAwardLog="0" DayLog="[^"]*" luckyNum="0" myLuckyNum="0" \/>/);
    }
    expect(authenticated.text).toContain(`UserID="${uid}"`); expect(legacy.text).not.toContain(`UserID="${uid}"`);
    expect(authenticated.text.match(/<DailyLogList [^>]+\/>/)![0]).toBe(legacy.text.match(/<DailyLogList [^>]+\/>/)![0]);
    expect(await rows(uid)).toHaveLength(1);
    // Preserve the registered legacy endpoint's pre-existing unknown-UID success
    // contract. Identity policy belongs to UserCalendar and is not changed here.
    const unknown = 2147483647;
    success((await calendar(apiA, unknown)).text); expect(await rows(unknown)).toHaveLength(1);
    expect((await calendar(apiB, unknown, true)).text).toContain('value="false"');
    expect(await rows(unknown)).toHaveLength(1);
  });

  check("both calendar entry points use the new month after waiting behind a real sign-in transaction", async () => {
    const outcomes: { entry: string; DayLog: string | null; UserAwardLog: number; LastDate: string; responseCurrent: boolean }[] = [];
    for (const authenticated of [false, true]) {
      const uid = await character(); clock.now = "2026-10-31T23:59:59Z";
      await monitor.db.insert(player.DailyLogList).values({ UserID: uid, DayLog: "True,True", UserAwardLog: 2, LastDate: new Date(clock.now) });
      const locked = deferred(), advance = deferred(); let signedBeforeRelease: Awaited<ReturnType<typeof rows>> = [];
      const holder = game.db.transaction(async tx => {
        await tx.execute(sql`SELECT "UserID" FROM player."Sys_Users_Detail" WHERE "UserID"=${uid} FOR UPDATE`);
        locked.resolve(); await advance.promise; clock.now = "2026-11-01T00:00:01Z";
        // A real nested SAVEPOINT runs the original signIn business owner on
        // this connection; no calendar/claim success rows are fabricated.
        const scoped = { ...game, db: tx as unknown as Database };
        const signed = await signIn({ db: scoped, now: () => new Date(clock.now) } as ServerContext, { id: uid } as GamePlayer);
        signedBeforeRelease = await tx.select().from(player.DailyLogList).where(eq(player.DailyLogList.UserID, uid));
        return signed;
      });
      void holder.catch(() => {}); await locked.promise;
      const pending = calendar(apiA, uid, authenticated); void pending.catch(() => {});
      let observed: { pid: number; blockers: number[]; wait: string; query: string } | undefined, failure: unknown;
      try {
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          const state = await q1<{ pid: number; blockers: number[]; wait: string; query: string }>(monitor,
            sql`SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type AS wait,query FROM pg_stat_activity WHERE pid=${connectionPids[1]!}`);
          if (state?.wait === "Lock" && state.blockers.includes(connectionPids[3]!)) { observed = state; break; }
          await delay(10);
        }
        assert(observed, "API must wait on the real game-owned row before the date advances");
        scenarios.push({ label: `queued-date-${authenticated ? "authenticated" : "legacy"}`, observed: { state: "blocked", ...observed } });
      } catch (error) { failure = error; } finally { advance.resolve(); }
      const results = await Promise.allSettled([holder, pending]);
      if (failure) throw failure;
      for (const result of results) if (result.status === "rejected") throw result.reason;
      expect((results[0] as PromiseFulfilledResult<boolean>).value).toBe(true);
      expect(signedBeforeRelease).toMatchObject([{ DayLog: "True", UserAwardLog: 1, LastDate: new Date("2026-11-01T00:00:01Z") }]);
      expect(await hasClaim(monitor.db, uid, "sign", "2026-11-01")).toBe(true);
      const response = (results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof calendar>>>).value; success(response.text);
      const saved = await rows(uid); expect(saved).toHaveLength(1);
      outcomes.push({ entry: authenticated ? "authenticated" : "legacy", DayLog: saved[0]!.DayLog, UserAwardLog: saved[0]!.UserAwardLog,
        LastDate: saved[0]!.LastDate.toISOString(), responseCurrent: response.text.includes('nowDate="2026-11-01') });
    }
    expect(outcomes).toEqual(["legacy", "authenticated"].map(entry => ({ entry, DayLog: "True", UserAwardLog: 1,
      LastDate: "2026-11-01T00:00:01.000Z", responseCurrent: true })));
  });

  check("game sign-in uses the new month after waiting behind a calendar transaction", async () => {
    const uid = await character(); clock.now = "2026-10-31T23:59:59Z";
    await monitor.db.insert(player.DailyLogList).values({ UserID: uid, DayLog: "True,True", UserAwardLog: 2, LastDate: new Date(clock.now) });
    const { firstResult, secondResult } = await interleave("queued-date-game", () => calendar(apiA, uid), connectionPids[3]!,
      () => signIn(context(), { id: uid } as GamePlayer), () => { clock.now = "2026-11-01T00:00:01Z"; });
    success((firstResult as Awaited<ReturnType<typeof calendar>>).text); expect(secondResult).toBe(true);
    const saved = await rows(uid); expect(saved).toHaveLength(1);
    expect({ DayLog: saved[0]!.DayLog, UserAwardLog: saved[0]!.UserAwardLog, LastDate: saved[0]!.LastDate.toISOString(),
      oldClaim: await hasClaim(monitor.db, uid, "sign", "2026-10-31"), newClaim: await hasClaim(monitor.db, uid, "sign", "2026-11-01") })
      .toEqual({ DayLog: "True", UserAwardLog: 1, LastDate: "2026-11-01T00:00:01.000Z", oldClaim: false, newClaim: true });
  });

  const activityApp = () => ({ h: b, cfg: { GAME_INTERNAL_URL: "" } }) as unknown as AppCtx;
  const activityRows = async () => ({
    wallets: await q(monitor, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
    states: await q(monitor, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
    receipts: await q(monitor, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
    goods: await q(monitor, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
    mails: await q(monitor, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
  });
  async function moonlightRole(actions = 499) {
    const uid = await character(), name = `calendar-${sequence}`;
    await monitor.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (${uid},${name},'test-only')`);
    const state = createActivityState(new Date(clock.now));
    for (let i = 0; i < 2; i++) state.games.moon = advanceMoonlight(state.games.moon, { type: "draw", count: 5 },
      { now: new Date(clock.now) }, { points: 1000 }, () => ({ templateId: 11019, count: 1 })).state;
    state.daily.actions = actions;
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
    await monitor.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(state)}::jsonb)`);
    const issued = Math.floor(new Date(clock.now).getTime() / 1000);
    const claims = { sub: uid, name, role: "player" as const, iat: issued, exp: issued + 3600 };
    const call = (id: string, requestId: string, action: ActivityAction) => activityAction(activityApp(), claims, uid, id, requestId, action);
    return { uid, state, call };
  }
  async function afterOwnerWait<T>(label: string, uid: number, account: boolean, crossDay: boolean, work: () => Promise<T>,
    beforeRelease?: (observed: { pid: number; blockers: number[]; wait: string; query: string }) => Promise<unknown>) {
    const locked = deferred(), release = deferred();
    const holder = a.db.transaction(async tx => {
      await tx.execute(account ? sql`SELECT "ID" FROM member."Accounts" WHERE "ID"=${uid} FOR UPDATE`
        : sql`SELECT "UserID" FROM player."Sys_Users_Detail" WHERE "UserID"=${uid} FOR UPDATE`);
      locked.resolve(); await release.promise;
    });
    void holder.catch(() => {}); await locked.promise;
    const pending = work(); void pending.catch(() => {});
    let failure: unknown;
    try {
      let observed: { pid: number; blockers: number[]; wait: string; query: string } | undefined;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const row = await q1<{ pid: number; blockers: number[]; wait: string; query: string }>(monitor,
          sql`SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type AS wait,query FROM pg_stat_activity WHERE pid=${connectionPids[2]!}`);
        if (row?.wait === "Lock" && row.blockers.includes(connectionPids[1]!) && row.query.includes("FOR SHARE")
          && row.query.includes(account ? 'member."Accounts"' : 'player."Sys_Users_Detail"')) { observed = row; break; }
        await delay(10);
      }
      assert(observed, "Activity must reach the real authority share lock after its wallet lock");
      const details = await beforeRelease?.(observed);
      scenarios.push({ label, observed: { state: "blocked", ...observed }, ...(details ? { details } : {}) });
      if (crossDay) { clock.now = "2026-11-01T00:00:01Z"; vi.setSystemTime(new Date(clock.now)); }
    } catch (error) { failure = error; } finally { release.resolve(); }
    const results = await Promise.allSettled([holder, pending]);
    if (failure) throw failure;
    if (results[0].status === "rejected") throw results[0].reason;
    return results[1];
  }
  for (const account of [false, true]) check(`old shop token expires while waiting for the ${account ? "account" : "character"} authority lock`, async () => {
    clock.now = "2026-10-31T23:59:59Z"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(clock.now));
    try {
      const role = await moonlightRole(), requestId = randomUUID();
      const token = viewMoonlightNative(role.state.games.moon, { now: new Date(clock.now) }, { points: 1000 }).shop.token;
      const before = await activityRows();
      const result = await afterOwnerWait(`queued-shop-${account ? "account" : "character"}`, role.uid, account, true,
        () => role.call("moonlight-native", requestId, { type: "buy", index: 1, count: 2, choice: token }));
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toMatchObject({ statusCode: 400 });
      expect(await activityRows()).toEqual(before);
      const freshToken = viewMoonlightNative(role.state.games.moon, { now: new Date(clock.now) }, { points: 1000 }).shop.token;
      const freshId = randomUUID(), buy = { type: "buy", index: 1, count: 2, choice: freshToken } as const;
      const bought = await role.call("moonlight-native", freshId, buy);
      expect(bought).toMatchObject({ day: "2026-11-01", points: 1000, revision: 1, mailedCount: 1, nativeMoonlight: { fragments: 0 } });
      const after = await activityRows(), saved = after.states.find(row => row.UserID === role.uid)!.State as ActivityState;
      expect(saved).toMatchObject({ day: "2026-11-01", daily: { actions: 1 } });
      expect(saved.history[0]).toContain("2026-11-01T00:00:01.000Z");
      expect(await role.call("moonlight-native", freshId, buy)).toMatchObject({ day: "2026-11-01", replayed: true });
      expect(await activityRows()).toEqual(after);
    } finally { vi.useRealTimers(); }
  });
  check("legacy moon draw resets yesterday's play ceiling after the character lock wait", async () => {
    clock.now = "2026-10-31T23:59:59Z"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(clock.now));
    try {
      const role = await moonlightRole(500);
      const result = await afterOwnerWait("queued-moon-daily", role.uid, false, true,
        () => role.call("moon", randomUUID(), { type: "draw", count: 1 }));
      expect(result.status).toBe("fulfilled");
      expect((result as PromiseFulfilledResult<unknown>).value).toMatchObject({ day: "2026-11-01", points: 980, revision: 1, mailedCount: 0 });
      const saved = (await activityRows()).states.find(row => row.UserID === role.uid)!.State as ActivityState;
      expect(saved).toMatchObject({ day: "2026-11-01", daily: { actions: 1 }, games: { moon: { draws: 11, fragments: 11 } } });
    } finally { vi.useRealTimers(); }
  });
  check("same-day shop purchase keeps its earned token and original delivery after the character lock wait", async () => {
    clock.now = "2026-10-31T23:59:59Z"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(clock.now));
    try {
      const role = await moonlightRole(), before = await activityRows();
      const token = viewMoonlightNative(role.state.games.moon, { now: new Date(clock.now) }, { points: 1000 }).shop.token;
      const result = await afterOwnerWait("queued-shop-same-day", role.uid, false, false,
        () => role.call("moonlight-native", randomUUID(), { type: "buy", index: 1, count: 2, choice: token }));
      expect(result.status).toBe("fulfilled");
      expect((result as PromiseFulfilledResult<unknown>).value).toMatchObject({ day: "2026-10-31", points: 1000, revision: 1, mailedCount: 1 });
      const after = await activityRows(), saved = after.states.find(row => row.UserID === role.uid)!.State as ActivityState;
      expect(saved).toMatchObject({ day: "2026-10-31", daily: { actions: 500 }, games: { moon: { fragments: 0 } } });
      expect(after.receipts.length).toBe(before.receipts.length + 1); expect(after.mails.length).toBe(before.mails.length + 1);
      expect(after.goods.slice(before.goods.length)).toMatchObject([{ TemplateID: 40002, Count: 2, IsBinds: true, ValidDate: 0 }]);
    } finally { vi.useRealTimers(); }
  });

  async function activityRole(activityId = "forthright-native", points = 1000, earned = 1000) {
    const uid = await character(), name = `calendar-${sequence}`;
    await monitor.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (${uid},${name},'test-only')`);
    await monitor.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},${points},${earned})`);
    const issued = Math.floor(new Date(clock.now).getTime() / 1000);
    const claims = { sub: uid, name, role: "player" as const, iat: issued, exp: issued + 7200 };
    return { uid, claims, call: (action: ActivityAction, requestId = randomUUID()) =>
      activityAction(activityApp(), claims, uid, activityId, requestId, action) };
  }
  async function forthrightPair() {
    const creator = await activityRole(), member = await activityRole(), actor = await activityRole();
    const snapshot = await activitySnapshot(activityApp(), creator.claims, creator.uid);
    const opened = await creator.call({ type: "open-group", index: 0, tier: 0, count: 1, marked: true, choice: snapshot.nativeForthright.stateToken });
    const group = opened.nativeForthright.pages.groups.createdOrders[0]!;
    const inspected = (await member.call({ type: "inspect-group", choice: group.code })).nativeForthright.pages.groups.inspected!;
    const memberAction = { type: "join-group", count: 1, choice: inspected.actionToken }, memberRequestId = randomUUID();
    const joined = await member.call(memberAction, memberRequestId);
    expect(joined.nativeForthright.pages.groups.joinedOrders[0]).toMatchObject({ status: "pending", members: [{ status: "active" }, { status: "active" }] });
    expect((await activityRows()).states.some(row => row.UserID === actor.uid)).toBe(false);
    return { creator, member, actor, group, memberAction, memberRequestId, ids: [creator.uid, member.uid, actor.uid] };
  }
  async function afterForthrightWait<T>(label: string, pair: Awaited<ReturnType<typeof forthrightPair>>, account: boolean, nextTime: string, work: () => Promise<T>) {
    // The creator's character is a non-actor member: this can block only the final
    // member SELECT, after the third actor's own account/character checks passed.
    return afterOwnerWait(label, account ? pair.actor.uid : pair.creator.uid, account, false, work, async observed => {
      expect(observed.pid).toBe(connectionPids[2]); expect(observed.blockers).toEqual([connectionPids[1]]);
      const query = observed.query.replace(/\s+/g, " ").trim();
      expect(query).toMatch(account
        ? /^SELECT "ID","UserName","IsBanned" FROM member\."Accounts" WHERE "ID"=\$\d+ AND lower\("UserName"\)=lower\(\$\d+\) FOR SHARE$/
        : /^SELECT "UserID","NickName","Sex" FROM player\."Sys_Users_Detail" WHERE "UserID" IN \([^)]+\) ORDER BY "UserID" FOR SHARE$/);
      const walletProbes = [];
      for (const uid of pair.ids) {
        let code: unknown;
        try { await game.db.execute(sql`SELECT "UserID" FROM app."ActivityWallet" WHERE "UserID"=${uid} FOR UPDATE NOWAIT`); }
        catch (error) { const pg = error as { code?: unknown; cause?: { code?: unknown } }; code = pg.cause?.code ?? pg.code; }
        expect(code).toBe("55P03"); walletProbes.push({ uid, code });
      }
      const previousTime = clock.now; clock.now = nextTime; vi.setSystemTime(new Date(clock.now));
      return { walletProbePid: connectionPids[3], walletProbes, previousTime, releasedAt: clock.now,
        authority: account ? "actor-account" : "non-actor-member", expiresAt: pair.group.expiresAt };
    });
  }
  async function completedForthright(pair: Awaited<ReturnType<typeof forthrightPair>>, before: Awaited<ReturnType<typeof activityRows>>) {
    const after = await activityRows();
    expect(after.receipts).toHaveLength(before.receipts.length + 1);
    for (const uid of pair.ids) {
      const old = before.wallets.find(row => row.UserID === uid)!, wallet = after.wallets.find(row => row.UserID === uid)!;
      expect(wallet).toMatchObject({ Points: 969, Earned: 1000, Revision: Number(old.Revision) + 1 });
      expect((after.states.find(row => row.UserID === uid)!.State as ActivityState).day).toBe(clock.now.slice(0, 10));
    }
    const mails = after.mails.slice(before.mails.length), goods = after.goods.slice(before.goods.length);
    expect(mails).toHaveLength(6);
    expect(mails.filter(row => row.Title === "本地活动奖励").map(row => row.ReceiverID).sort((x, y) => Number(x) - Number(y))).toEqual(pair.ids);
    expect(goods.every(row => row.TemplateID === 11019 && row.IsBinds === true && row.ValidDate === 0)).toBe(true);
    expect(goods.reduce((sum, row) => sum + Number(row.Count), 0)).toBe(15);
    return after;
  }
  for (const account of [true, false]) for (const expired of [true, false]) check(
    `third forthright member ${expired ? "rejects an expired group" : "completes before expiry"} after the ${account ? "actor account" : "non-actor member"} lock wait`, async () => {
      clock.now = "2026-10-15T01:00:00Z"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(clock.now));
      try {
        const pair = await forthrightPair();
        clock.now = expired ? "2026-10-15T01:29:59Z" : "2026-10-15T01:29:58Z"; vi.setSystemTime(new Date(clock.now));
        const inspected = (await pair.actor.call({ type: "inspect-group", choice: pair.group.code })).nativeForthright.pages.groups.inspected!;
        expect(inspected.canJoin).toBe(true);
        const before = await activityRows(), requestId = randomUUID();
        const action = { type: "join-group", count: 1, choice: inspected.actionToken };
        const result = await afterForthrightWait(`queued-forthright-${account ? "account" : "member"}-${expired ? "expired" : "current"}`, pair, account,
          expired ? "2026-10-15T01:30:01Z" : "2026-10-15T01:29:59Z", () => pair.actor.call(action, requestId));
        if (expired) {
          expect(result.status).toBe("rejected"); expect((result as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
          expect(await activityRows()).toEqual(before);
        } else {
          expect(result.status).toBe("fulfilled");
          expect((result as PromiseFulfilledResult<unknown>).value).toMatchObject({ mailedCount: 6,
            nativeForthrightAction: { requestId, effects: [{ type: "group-completed" }] } });
          const after = await completedForthright(pair, before);
          expect(await pair.actor.call(action, requestId)).toMatchObject({ replayed: true }); expect(await activityRows()).toEqual(after);
        }
      } finally { vi.useRealTimers(); }
    });
  check("a stateless third member rejects its old-day group token after the member lock and initializes on a fresh retry", async () => {
    clock.now = "2026-10-31T23:45:00Z"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(clock.now));
    try {
      const pair = await forthrightPair();
      clock.now = "2026-10-31T23:59:59Z"; vi.setSystemTime(new Date(clock.now));
      const inspected = (await pair.actor.call({ type: "inspect-group", choice: pair.group.code })).nativeForthright.pages.groups.inspected!;
      expect(inspected.canJoin).toBe(true);
      const before = await activityRows();
      const result = await afterForthrightWait("queued-forthright-member-midnight", pair, false, "2026-11-01T00:00:01Z",
        () => pair.actor.call({ type: "join-group", count: 1, choice: inspected.actionToken }));
      expect(result.status).toBe("rejected"); expect((result as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
      expect(await activityRows()).toEqual(before);
      const refreshed = (await pair.actor.call({ type: "inspect-group", choice: pair.group.code })).nativeForthright.pages.groups.inspected!;
      expect(refreshed.canJoin).toBe(true); expect(refreshed.actionToken).not.toBe(inspected.actionToken);
      expect(await pair.actor.call({ type: "join-group", count: 1, choice: refreshed.actionToken })).toMatchObject({ day: "2026-11-01", mailedCount: 6 });
      const after = await completedForthright(pair, before), state = after.states.find(row => row.UserID === pair.actor.uid)!.State as ActivityState;
      expect(state).toMatchObject({ day: "2026-11-01", daily: { actions: 1 } }); expect(state.history[0]).toMatch(/^2026-11-01 /);
    } finally { vi.useRealTimers(); }
  });
  check("a committed forthright UUID replay projects expiry after the actor account lock without repeating any delivery", async () => {
    clock.now = "2026-10-15T01:00:00Z"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(clock.now));
    try {
      const pair = await forthrightPair(), before = await activityRows();
      clock.now = "2026-10-15T01:29:59Z"; vi.setSystemTime(new Date(clock.now));
      // A committed replay locks only its own wallet, then returns the current
      // projection; the immutable receipt and original action token stay intact.
      const result = await afterForthrightWait("queued-forthright-account-replay-expired",
        { ...pair, actor: pair.member, ids: [pair.member.uid] }, true, "2026-10-15T01:30:01Z",
        () => pair.member.call(pair.memberAction, pair.memberRequestId));
      expect(result.status).toBe("fulfilled");
      const replay = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof pair.member.call>>>).value;
      expect(replay).toMatchObject({ replayed: true, nativeForthright: { serverNow: "2026-10-15T01:30:01.000Z",
        pages: { groups: { joinedOrders: [{ status: "expired-unsettled", canJoin: false }] } } } });
      expect(replay).not.toHaveProperty("nativeForthrightAction"); expect(await activityRows()).toEqual(before);
    } finally { vi.useRealTimers(); }
  });

  async function firstRechargePair() {
    const sender = await activityRole("first-recharge-native"), recipient = await activityRole("first-recharge-native", 0, 0);
    const state = createActivityState(new Date(clock.now)); state.daily.actions = 7;
    await monitor.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${sender.uid},'reference',${JSON.stringify(state)}::jsonb)`);
    const names = await q<{ UserID: number; NickName: string }>(monitor,
      sql`SELECT "UserID","NickName" FROM player."Sys_Users_Detail" WHERE "UserID" IN (${sender.uid},${recipient.uid}) ORDER BY "UserID"`);
    const senderName = names.find(row => row.UserID === sender.uid)!.NickName, recipientName = names.find(row => row.UserID === recipient.uid)!.NickName;
    const snapshot = await activitySnapshot(activityApp(), sender.claims, sender.uid);
    const issued = await sender.call({ type: "issue-card", tier: 2, choice: snapshot.nativeFirstRecharge.stateToken });
    const saved = (await activityRows()).states.find(row => row.UserID === sender.uid)!.State as ActivityState;
    const card = (saved.games.firstRechargeNativeV1 as FirstRechargeNativeState).cardSlots[1]!;
    expect(issued.nativeFirstRecharge.cards.cards).toMatchObject([{ cardId: card.cardId, status: "owned", expiresAt: null, canGift: true }]);
    expect((await activityRows()).states.some(row => row.UserID === recipient.uid)).toBe(false);
    return { sender, recipient, senderName, recipientName, card, ids: [sender.uid, recipient.uid],
      action: { type: "gift-card", cardId: card.cardId, recipientName, choice: issued.nativeFirstRecharge.stateToken } };
  }
  type GiftAuthority = "sender-account" | "recipient-detail" | "recipient-account";
  async function afterGiftWait<T>(label: string, pair: Awaited<ReturnType<typeof firstRechargePair>>, authority: GiftAuthority, nextTime: string, work: () => Promise<T>) {
    const sender = authority === "sender-account", account = authority !== "recipient-detail";
    return afterOwnerWait(label, sender ? pair.sender.uid : pair.recipient.uid, account, false, work, async observed => {
      expect(observed.pid).toBe(connectionPids[2]); expect(observed.blockers).toEqual([connectionPids[1]]);
      const query = observed.query.replace(/\s+/g, " ").trim();
      expect(query).toMatch(sender
        ? /^SELECT "ID","UserName","IsBanned" FROM member\."Accounts" WHERE "ID"=\$\d+ AND lower\("UserName"\)=lower\(\$\d+\) FOR SHARE$/
        : /^SELECT d\."UserID",d\."NickName",d\."IsExist",d\."ForbidDate",a\."IsBanned" FROM player\."Sys_Users_Detail" d JOIN member\."Accounts" a ON lower\(a\."UserName"\)=lower\(d\."UserName"\) WHERE d\."UserID"=\$\d+ AND lower\(d\."NickName"\)=lower\(\$\d+\) FOR SHARE OF d,a$/);
      const walletProbes = [];
      for (const uid of pair.ids) {
        let code: unknown;
        try { await game.db.execute(sql`SELECT "UserID" FROM app."ActivityWallet" WHERE "UserID"=${uid} FOR UPDATE NOWAIT`); }
        catch (error) { const pg = error as { code?: unknown; cause?: { code?: unknown } }; code = pg.cause?.code ?? pg.code; }
        expect(code).toBe("55P03"); walletProbes.push({ uid, code });
      }
      const previousTime = clock.now; clock.now = nextTime; vi.setSystemTime(new Date(clock.now));
      return { walletProbePid: connectionPids[3], walletProbes, previousTime, releasedAt: clock.now, authority };
    });
  }
  async function completedGift(pair: Awaited<ReturnType<typeof firstRechargePair>>, before: Awaited<ReturnType<typeof activityRows>>, requestId: string, crossDay: boolean) {
    const after = await activityRows(), now = new Date(clock.now).toISOString(), day = now.slice(0, 10);
    expect(after.receipts).toHaveLength(before.receipts.length + 1); expect(after.mails).toEqual(before.mails); expect(after.goods).toEqual(before.goods);
    expect(after.receipts.find(row => row.UserID === pair.sender.uid && row.RequestID === requestId)).toMatchObject({ Result: { mailedCount: 0 } });
    for (const uid of pair.ids) {
      const wallet = before.wallets.find(row => row.UserID === uid)!;
      expect(after.wallets.find(row => row.UserID === uid)).toEqual({ ...wallet, Revision: Number(wallet.Revision) + 1 });
      const state = after.states.find(row => row.UserID === uid)!.State as ActivityState;
      expect(state.day).toBe(day); expect(state.history[0]?.startsWith(`${now} `)).toBe(true);
      expect(state.daily).toEqual(uid === pair.sender.uid && !crossDay ? { actions: 7 } : {}); expect(state.completed).toEqual({});
      const native = state.games.firstRechargeNativeV1 as FirstRechargeNativeState;
      expect(native.shopDay).toBe(day);
      expect(native.cardSlots).toEqual([null, uid === pair.sender.uid ? { ...pair.card, status: "gifted", giftedToCharacterId: pair.recipient.uid }
        : { ...pair.card, acquiredAt: now, senderName: pair.senderName }, null]);
      expect(state.claims).toEqual(uid === pair.sender.uid ? ["first-recharge-native:tier:2"] : []);
    }
    return after;
  }
  for (const authority of ["sender-account", "recipient-detail", "recipient-account"] as const) for (const crossDay of authority === "recipient-account" ? [true, false] : [true]) check(
    `first-recharge gift ${crossDay ? "rejects an old-day token then transfers the permanent card on refresh" : "completes in the same day"} after the ${authority} lock wait`, async () => {
      clock.now = "2026-10-31T23:59:59Z"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(clock.now));
      try {
        const pair = await firstRechargePair(), before = await activityRows(), requestId = randomUUID();
        const result = await afterGiftWait(`queued-firstrecharge-${authority}-${crossDay ? "midnight" : "current"}`, pair, authority,
          crossDay ? "2026-11-01T00:00:01Z" : "2026-10-31T23:59:59Z", () => pair.sender.call(pair.action, requestId));
        let submittedAction = pair.action;
        let sent: Awaited<ReturnType<typeof pair.sender.call>>;
        if (crossDay) {
          expect(result.status).toBe("rejected"); expect((result as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
          expect(await activityRows()).toEqual(before);
          const refreshed = await activitySnapshot(activityApp(), pair.sender.claims, pair.sender.uid);
          expect(refreshed.nativeFirstRecharge.stateToken).toMatch(/^2026-11-01\./);
          expect(refreshed.nativeFirstRecharge.stateToken).not.toBe(pair.action.choice);
          expect(refreshed.nativeFirstRecharge.cards.cards).toMatchObject([{ cardId: pair.card.cardId, status: "owned", expiresAt: null, canGift: true }]);
          submittedAction = { ...pair.action, choice: refreshed.nativeFirstRecharge.stateToken };
          sent = await pair.sender.call(submittedAction, requestId);
        } else { expect(result.status).toBe("fulfilled"); sent = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof pair.sender.call>>>).value; }
        expect(sent).toMatchObject({ day: clock.now.slice(0, 10), mailedCount: 0,
          nativeFirstRecharge: { day: clock.now.slice(0, 10) },
          nativeFirstRechargeAction: { requestId, effects: [{ type: "card-gifted", cardId: pair.card.cardId, tier: 2, recipientName: pair.recipientName }] } });
        const after = await completedGift(pair, before, requestId, crossDay);
        // Preserve the exact submitted action for UUID replay, including the refreshed token.
        expect(await pair.sender.call(submittedAction, requestId)).toMatchObject({ replayed: true, mailedCount: 0 });
        expect(await activityRows()).toEqual(after);
      } finally { vi.useRealTimers(); }
    });
  check("a committed first-recharge gift UUID replay uses the new day after the sender account wait even after recipient rename", async () => {
    clock.now = "2026-10-31T23:59:59Z"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(clock.now));
    try {
      const pair = await firstRechargePair(), requestId = randomUUID(), committed = await pair.sender.call(pair.action, requestId);
      await monitor.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "NickName"=${`Renamed ${pair.recipient.uid}`} WHERE "UserID"=${pair.recipient.uid}`);
      expect(await q(monitor, sql`SELECT "UserID" FROM player."Sys_Users_Detail" WHERE lower("NickName")=lower(${pair.recipientName})`)).toEqual([]);
      const before = await activityRows();
      const result = await afterGiftWait("queued-firstrecharge-sender-account-replay-midnight", { ...pair, ids: [pair.sender.uid] }, "sender-account", "2026-11-01T00:00:01Z",
        () => pair.sender.call(pair.action, requestId));
      expect(result.status).toBe("fulfilled");
      const replay = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof pair.sender.call>>>).value;
      expect(replay).toMatchObject({ replayed: true, day: "2026-11-01", message: committed.message, mailedCount: 0, nativeFirstRecharge: { day: "2026-11-01" } });
      expect(replay.nativeFirstRecharge.stateToken).toMatch(/^2026-11-01\./);
      expect(replay).not.toHaveProperty("nativeFirstRechargeAction"); expect(await activityRows()).toEqual(before);
    } finally { vi.useRealTimers(); }
  });
});
