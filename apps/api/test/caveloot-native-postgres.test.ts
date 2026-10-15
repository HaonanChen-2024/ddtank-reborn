import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDb, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { available, buildTestApi, clean, native, persistState, persisted, post, seedNative, seedTemplates, snapshot, state, uid } from "./caveloot-native-fixture.js";
import { q, q1 } from "../src/lib/db.js";
import type { ActivityAction } from "../src/activities/types.js";
const random = vi.hoisted(() => ({ fraction: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomInt: (min: number, max?: number) =>
  max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)) }));
const url = process.env.WORKSHOP_NATIVE_CAVELOOT_URL, token = process.env.WORKSHOP_NATIVE_CAVELOOT_TOKEN;
let monitor: DbHandle, holder: DbHandle, a: DbHandle, b: DbHandle, appA: Awaited<ReturnType<typeof buildTestApi>>, appB: Awaited<ReturnType<typeof buildTestApi>>;
let database: string, output: string, passed = 0; const pids: number[] = [], scenarios: unknown[] = [];
const check = (label: string, run: () => Promise<void>) => it(label, async () => { await run(); passed++; });
const wallet = () => q1<{ Points: number; Earned: number; Revision: number }>(monitor, sql`SELECT "Points","Earned","Revision" FROM app."ActivityWallet" WHERE "UserID"=${uid}`);
async function race(label: string, commands: (() => ReturnType<typeof post>)[], lock: "wallet" | "role" = "wallet") {
  let release!: () => void, enter!: () => void; const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { enter = r; });
  const held = holder.db.transaction(async tx => {
    if (lock === "wallet") await tx.execute(sql`SELECT "UserID" FROM app."ActivityWallet" WHERE "UserID"=${uid} FOR UPDATE`);
    else await tx.execute(sql`SELECT "UserID" FROM player."Sys_Users_Detail" WHERE "UserID"=${uid} FOR UPDATE`);
    enter(); await gate;
  });
  await ready; const before = await persisted(monitor), calls = commands.map(c => c()); for (const call of calls) void call.catch(() => {}); let failure: unknown;
  try {
    const deadline = performance.now() + 6000; let rows: { pid: number; blockers: number[]; wait_event_type: string; query: string }[] = [];
    while (performance.now() < deadline) {
      rows = await q(monitor, sql`SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type,query FROM pg_stat_activity WHERE datname=${database} AND pid IN (${pids[2]},${pids[3]}) ORDER BY pid`);
      if (rows.length === 2 && rows.every(r => r.wait_event_type === "Lock" && r.blockers.length)) break; await delay(25);
    }
    expect(rows).toHaveLength(2); expect(rows.every(r => r.wait_event_type === "Lock" && r.blockers.length)).toBe(true);
    if (lock === "wallet") expect(rows.every(r => r.query.includes("ActivityWallet"))).toBe(true);
    else { expect(rows.some(r => r.blockers.includes(pids[1]))).toBe(true); expect(rows.some(r => r.blockers.some(pid => pid === pids[2] || pid === pids[3]))).toBe(true); }
    expect(await persisted(monitor)).toEqual(before); scenarios.push({ label, lock, waits: rows.map(({ pid, blockers, wait_event_type, query }) => ({ pid, blockers, wait_event_type, query })) });
  } catch (error) { failure = error; } finally { release(); await held; }
  const results = await Promise.all(calls); if (failure) throw failure; return results;
}
const duplicates = (action: ActivityAction, id = randomUUID(), count = 6) => Array.from({ length: count }, (_, i) => () => post(i % 2 ? appB : appA, action, id));
function oneCommit(results: Awaited<ReturnType<typeof post>>[]) {
  expect(results.map(r => r.statusCode)).toEqual(results.map(() => 200)); expect(results.filter(r => r.json().replayed)).toHaveLength(results.length - 1);
  expect(results.filter(r => r.json().nativeCaveLootAction)).toHaveLength(1);
  for (const result of results.filter(r => r.json().replayed)) expect(result.json()).not.toHaveProperty("nativeCaveLootAction");
}
describe.skipIf(!url || !token)("A17 opt-in fresh native PostgreSQL", () => {
  beforeAll(async () => {
    assert(url && token); const parsed = new URL(url); database = parsed.pathname.slice(1); output = process.env.WORKSHOP_NATIVE_CAVELOOT_OUTPUT!;
    assert.match(token, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/); assert.equal(database, `workshop_native_caveloot_${token.replaceAll("-", "")}`);
    assert.equal(parsed.hostname, "127.0.0.1"); assert.equal(parsed.port, "55432"); assert(output);
    monitor = await createDb(url, { max: 1 });
    expect(await q(monitor, sql`SELECT token FROM public."WorkshopNativeActivityTest"`)).toEqual([{ token }]);
    expect(await q(monitor, sql`SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`)).toEqual([{ tablename: "WorkshopNativeActivityTest" }]);
    await migrateDb(monitor); holder = await createDb(url, { max: 1 }); a = await createDb(url, { max: 1 }); b = await createDb(url, { max: 1 });
    for (const [index, h] of [monitor, holder, a, b].entries()) { const identity = await q1<{ database: string; pid: number }>(h, sql`SELECT current_database() AS database,pg_backend_pid() AS pid`);
      assert.equal(identity?.database, database); pids.push(identity!.pid); await h.db.execute(sql`SELECT set_config('application_name',${`native_caveloot_test_${index}`},false)`); await h.db.execute(sql`SET statement_timeout='15000ms'`); }
    expect(new Set(pids).size).toBe(4); await seedTemplates(monitor); appA = await buildTestApi(a, join(output, "resource")); appB = await buildTestApi(b, join(output, "resource"));
  });
  beforeEach(async () => { random.fraction = 0; await clean(monitor); });
  afterAll(async () => { await appA?.close(); await appB?.close(); await Promise.all([monitor, holder, a, b].filter(Boolean).map(h => h.close()));
    if (output) writeFileSync(join(output, "test-evidence.json"), JSON.stringify({ database, token, passed, connectionPids: pids, scenarios, closedConnections: true }, null, 2) + "\n"); });
  check("serializes six same-UUID five-draw batches behind real wallet locks", async () => {
    await seedNative(monitor); const before = await persisted(monitor), choice = available(await snapshot(appA)).stateToken;
    oneCommit(await race("same-uuid-five-draws", duplicates({ type: "draw", tier: 1, index: 2, count: 1, choice })));
    expect(await wallet()).toEqual({ Points: 970, Earned: 40, Revision: 1 }); const after = await persisted(monitor);
    expect(after.receipts.length - before.receipts.length).toBe(1); expect(after.goods).toEqual([]); expect(after.mails).toEqual([]);
    expect((await state(monitor))!.daily).toMatchObject({ actions: 1, draws: 5, "cave:free": 3 }); expect(available(await snapshot(appB))).toMatchObject({ draws: 5, bagSlotsUsed: 5 });
  });
  check("rejects different UUIDs with the same token after exactly one finite batch", async () => {
    await seedNative(monitor); const action = { type: "draw", tier: 2, index: 2, count: 1, choice: available(await snapshot(appA)).stateToken };
    const results = await race("different-uuid-one-batch", [() => post(appA, action), () => post(appB, action)]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]); expect((await persisted(monitor)).receipts).toHaveLength(1);
    expect(await wallet()).toEqual({ Points: 825, Earned: 40, Revision: 1 }); expect(available(await snapshot(appB)).draws).toBe(5);
  });
  check("shares wallet safely with the unchanged paid legacy cave owner", async () => {
    const initial = await seedNative(monitor); await monitor.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=35 WHERE "UserID"=${uid}`);
    const action = { type: "draw", tier: 2, index: 0, count: 1, choice: available(await snapshot(appA)).stateToken };
    const results = await race("old-new-cave-wallet-competition", [() => post(appA, action), () => post(appB, { type: "draw", count: 1, choice: "advanced" }, randomUUID(), "cave")]);
    expect(results.filter(r => r.statusCode === 200)).toHaveLength(1); expect([400, 409]).toContain(results.find(r => r.statusCode !== 200)!.statusCode);
    expect(await wallet()).toEqual({ Points: 0, Earned: 40, Revision: 1 });
    expect((await state(monitor))!.games.untouched).toEqual(initial.games.untouched); expect((await state(monitor))!.games.chargeNativeV1).toMatchObject({ grossSpent: 35 });
  });
  check("delivers the shared bag once at500 with actual MaxCount split stacks", async () => {
    await seedNative(monitor, { bag: [{ templateId: 11019, count: 28, caveType: 1 }] }, 500);
    const action = { type: "take-all", tier: 1, choice: available(await snapshot(appA)).stateToken }; oneCommit(await race("same-uuid-take-at500", duplicates(action)));
    const rows = await persisted(monitor); expect(rows.goods.map(g => g.Count)).toEqual([5, 5, 5, 5, 5, 3]); expect(rows.mails).toHaveLength(2); expect((await state(monitor))!.daily.actions).toBe(500);
    expect(available(await snapshot(appB)).bagSlotsUsed).toBe(0); expect((await native(appB, { type: "take-all", tier: 1 })).statusCode).toBe(409);
  });
  check("rolls back five tables at final receipt and retries same UUID once", async () => {
    await seedNative(monitor, { bag: [{ templateId: 11021, count: 28, caveType: 2 }] }); const action = { type: "take-all", tier: 2, choice: available(await snapshot(appA)).stateToken }, id = randomUUID(), before = await persisted(monitor);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT caveloot_receipt_failure CHECK (false) NOT VALID`);
    expect((await post(appA, action, id)).statusCode).toBe(500); expect(await persisted(monitor)).toEqual(before);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT caveloot_receipt_failure`);
    oneCommit(await race("receipt-failure-same-uuid-retry", duplicates(action, id))); const after = await persisted(monitor);
    expect(after.goods).toHaveLength(6); expect(after.mails).toHaveLength(2); expect(after.receipts).toHaveLength(1);
  });
  check("exchanges minecoins at500 once without consuming shared daily actions or points", async () => {
    await seedNative(monitor); const init = await native(appA, { type: "draw", tier: 1, index: 0, count: 1 }); expect(init.statusCode).toBe(200);
    const root = (await state(monitor))!; const cave = root.games.cave as { native: { normalCoins: number } }; cave.native.normalCoins = 100; root.daily.actions = 500; await persistState(monitor, root);
    const action = { type: "buy", tier: 1, index: 0, count: 5, choice: available(await snapshot(appA)).stateToken };
    const results = await race("coin-shop-different-uuid-at500", [() => post(appA, action), () => post(appB, action)]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]); const rows = await persisted(monitor);
    expect(rows.goods.map(g => g.Count)).toEqual([5]); expect(rows.mails).toHaveLength(1); expect(available(await snapshot(appB)).types[0]!.coins).toBe(50);
    expect((await state(monitor))!.daily.actions).toBe(500); expect((await state(monitor))!.games.chargeNativeV1).toBeUndefined(); expect(await wallet()).toEqual({ Points: 1000, Earned: 40, Revision: 2 });
  });
  check("replays committed UUID before unknown extension checks without resetting its save", async () => {
    const action = { type: "draw", tier: 1, index: 0, count: 1, choice: available(await snapshot(appA)).stateToken }, id = randomUUID(); expect((await post(appA, action, id)).statusCode).toBe(200);
    const root = (await state(monitor))!; (root.games.cave as { native: unknown }).native = { version: 9, future: "preserve exact data" }; await persistState(monitor, root);
    const before = await persisted(monitor), result = await post(appB, action, id);
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ replayed: true, nativeCaveLoot: { available: false, stateToken: null } });
    expect(result.json()).not.toHaveProperty("nativeCaveLootAction"); expect(await persisted(monitor)).toEqual(before);
    expect((await post(appB, action)).statusCode).toBe(409); expect(await persisted(monitor)).toEqual(before);
  });
  check("holds wallet before authoritative role lock and never publishes dirty state", async () => {
    await seedNative(monitor); const action = { type: "draw", tier: 2, index: 2, count: 1, choice: available(await snapshot(appA)).stateToken };
    oneCommit(await race("wallet-then-role-lock-order", duplicates(action), "role"));
    expect(await wallet()).toEqual({ Points: 825, Earned: 40, Revision: 1 }); expect((await state(monitor))!.games.chargeNativeV1).toMatchObject({ grossSpent: 175 });
  });
  check("serializes legacy take and native recycle against the one canonical bag", async () => {
    await seedNative(monitor, { bag: [{ templateId: 11019, count: 4, caveType: 1 }] }); const action = { type: "recycle-all", tier: 1, choice: available(await snapshot(appA)).stateToken };
    const results = await race("legacy-take-vs-native-recycle", [() => post(appA, action), () => post(appB, { type: "take" }, randomUUID(), "cave")]);
    expect(results.filter(r => r.statusCode === 200)).toHaveLength(1); expect([400, 409]).toContain(results.find(r => r.statusCode !== 200)!.statusCode);
    const latest = available(await snapshot(appB)), rows = await persisted(monitor); expect(latest.bagSlotsUsed).toBe(0); expect(rows.receipts).toHaveLength(1);
    if (results[0].statusCode === 200) { expect(latest.types[0]!.coins).toBe(8); expect(rows.goods).toEqual([]); }
    else { expect(latest.types[0]!.coins).toBe(0); expect(rows.goods.map(g => g.Count)).toEqual([4]); }
    expect((await wallet())!.Revision).toBe(1);
  });
});
