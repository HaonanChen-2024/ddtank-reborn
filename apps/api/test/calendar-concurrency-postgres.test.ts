import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inflateSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb, migrateDb, player, type Database, type DbHandle } from "@ddt/db";
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
const context = () => ({ db: game, now: () => new Date(clock.now) }) as ServerContext;
async function character() {
  const [owner] = await monitor.db.insert(player.Sys_Users_Detail).values({ UserName: `calendar-${++sequence}`, NickName: `Calendar ${sequence}`, Password: "test", Sex: true, IsFirst: 1 }).returning();
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

describe.skipIf(!url || !token)("Calendar opt-in fresh PostgreSQL cross-owner serialization", () => {
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
});
