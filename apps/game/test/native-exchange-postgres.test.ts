import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, createDb, game, migrateDb, player, type DbHandle } from "@ddt/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actNativeExchange, readNativeExchange } from "../src/game/activity-exchange-native.js";
import { exchangeFixture, seedExchangeTemplates } from "./native-exchange-fixture.js";
import { buildApp } from "../../api/src/app.js";
import { signJwt } from "../../api/src/lib/jwt.js";
import { q, q1 } from "../../api/src/lib/db.js";

const url = process.env.WORKSHOP_NATIVE_EXCHANGE_URL, token = process.env.WORKSHOP_NATIVE_EXCHANGE_TOKEN;
let monitor: DbHandle, holder: DbHandle, a: DbHandle, b: DbHandle, api: Awaited<ReturnType<typeof buildApp>>;
let database: string, output: string, passed = 0, f: Awaited<ReturnType<typeof exchangeFixture>>;
const check = (name: string, work: () => Promise<void>) => it(name, async () => { await work(); passed++; });
const pids: number[] = [], scenarios: unknown[] = [], secret = "a05-native-pg-tests-only";
const header = () => ({ authorization: `Bearer ${signJwt({ sub: 905, name: "native-exchange-905", role: "player" }, secret, 3600)}` });
const oldPost = () => api.app.inject({ method: "POST", url: "/api/account/activities/points-gift/action", headers: header(), payload: { characterId: 905, requestId: randomUUID(), action: { type: "claim", tier: 1 } } });
const read = async () => { const r = await readNativeExchange(f.ctx, f.input, f.client); if (!r.ok) throw new Error(r.message); return r.value; };
const command = async (index = 0, count = 1, requestId = randomUUID()) => ({ ...f.input, requestId, action: { type: "exchange" as const, index, count, choice: (await read()).stateToken! } });
const saved = async () => ({ wallets: await q(monitor, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`), states: await q(monitor, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(monitor, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`), goods: await q(monitor, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(monitor, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`), profiles: await q(monitor, sql`SELECT "UserID","Gold" FROM player."Sys_Users_Detail" ORDER BY "UserID"`) });

async function lockedRace(label: string, lock: "wallet" | "detail" | "goods", start: () => Promise<unknown>[]) {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const held = holder.db.transaction(async tx => {
    if (lock === "wallet") await tx.execute(sql`SELECT "UserID" FROM app."ActivityWallet" WHERE "UserID"=905 FOR UPDATE`);
    else if (lock === "detail") await tx.execute(sql`SELECT "UserID" FROM player."Sys_Users_Detail" WHERE "UserID"=905 FOR UPDATE`);
    else await tx.execute(sql`SELECT "ItemID" FROM player."Sys_Users_Goods" WHERE "ItemID"=${f.material.ItemID} FOR UPDATE`);
    entered(); await gate;
  });
  await ready; const before = await saved(), requests = start(); let failure: unknown;
  try {
    let waits: { pid: number; blockers: number[]; wait_event_type: string; query: string }[] = [];
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      waits = await q(monitor, sql`SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type,query FROM pg_stat_activity WHERE datname=${database} AND pid IN (${pids[2]},${pids[3]}) ORDER BY pid`);
      if (waits.length === 2 && waits.filter(r => r.wait_event_type === 'Lock' && r.blockers.length > 0).length >= (lock === "wallet" || lock === "detail" ? 2 : 1)) break;
      await delay(25);
    }
    const blocked = waits.filter(r => r.wait_event_type === "Lock" && r.blockers.length > 0);
    expect(blocked).toHaveLength(lock === "goods" ? 1 : 2);
    if (lock === "wallet") expect(blocked.every(r => r.query.includes("ActivityWallet"))).toBe(true);
    // pg_stat_activity truncates the long Detail SELECT before its FROM clause.
    // Prove the wait on our known Detail-row holder through PostgreSQL's blocker graph.
    if (lock === "detail") expect(blocked.some(r => r.blockers.includes(pids[1]!))).toBe(true);
    if (lock === "goods") expect(blocked[0]!.query).toContain("Sys_Users_Goods");
    expect(await saved()).toEqual(before); scenarios.push({ label, lock, blocked: blocked.map(({ pid, blockers, wait_event_type }) => ({ pid, blockers, wait_event_type })) });
  } catch (err) { failure = err; } finally { release(); await held; }
  const results = await Promise.all(requests); if (failure) throw failure; return results;
}
describe.skipIf(!url || !token)("A05 opt-in native PostgreSQL real inventory and wallet locks", () => {
  beforeAll(async () => {
    assert(url && token); const parsed = new URL(url); database = parsed.pathname.slice(1); assert.match(database, /^workshop_native_exchange_[a-f0-9]{32}$/);
    assert.equal(parsed.hostname, "127.0.0.1"); assert.equal(parsed.port, "55432"); output = process.env.WORKSHOP_NATIVE_EXCHANGE_OUTPUT!; assert(output);
    monitor = await createDb(url, { max: 1 }); holder = await createDb(url, { max: 1 }); a = await createDb(url, { max: 1 }); b = await createDb(url, { max: 1 });
    const marker = await q<{ token: string }>(monitor, sql`SELECT token FROM public."WorkshopNativeActivityTest"`); expect(marker.map(r => r.token)).toEqual([token]);
    await migrateDb(monitor); await seedExchangeTemplates(monitor);
    for (const h of [monitor, holder, a, b]) pids.push((await q1<{ pid: number }>(h, sql`SELECT pg_backend_pid() AS pid`))!.pid);
    expect(new Set(pids).size).toBe(4);
    api = await buildApp({ db: b, logger: false, skipTemplates: true, env: {}, config: { NODE_ENV: "test", DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, JWT_SECRET: secret,
      RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "", FLASH_DIR: join(output, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(output, "resource"),
      UPLOAD_DIR: join(output, "uploads"), REQUEST_SNAPSHOT_DIR: join(output, "snapshots"), RUFFLE_DIR: join(output, "ruffle"), CELEB_REBUILD_MIN: 0 } });
  });
  beforeEach(async () => {
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS a05_pg_failure`);
    await monitor.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
    await monitor.db.execute(sql`UPDATE game."Shop_Goods" SET "MaxCount"=9999`);
    f = await exchangeFixture(a); await monitor.db.insert(app.ActivityWallet).values({ UserID: 905, Points: 100, Earned: 100 });
  });

  afterAll(async () => {
    await api?.app.close(); let closedConnections = false;
    try { await Promise.all([monitor, holder, a, b].filter(Boolean).map(h => h.close())); closedConnections = true; }
    finally { if (output) writeFileSync(join(output, "test-evidence.json"), JSON.stringify({ database, token, passed, connectionPids: pids, scenarios, closedConnections }, null, 2) + "\n"); }
  });
  check("two real connections block on ActivityWallet; native materials and old point gift cannot overwrite each other", async () => {
    const c = await command(); const results = await lockedRace("native-vs-old-wallet", "wallet", () => [actNativeExchange(f.ctx, c, f.client), oldPost()]);
    const native = results[0] as Awaited<ReturnType<typeof actNativeExchange>>, old = results[1] as Awaited<ReturnType<typeof oldPost>>;
    expect(old.statusCode, old.body).toBe(200); expect(native.ok || native.status === 409).toBe(true);
    const s = await saved(); expect(s.wallets[0]).toMatchObject({ Points: 100, Earned: 100, Revision: native.ok ? 2 : 1 });
    expect(f.material.Count).toBe(native.ok ? 36 : 40); expect(s.mails).toHaveLength(native.ok ? 2 : 1);
  });
  check("wallet before Detail order remains acyclic while native and old owner both wait", async () => {
    const c = await command(), requests = await lockedRace("detail-before-release-no-cycle", "detail", () => [actNativeExchange(f.ctx, c, f.client), oldPost()]);
    const native = requests[0] as Awaited<ReturnType<typeof actNativeExchange>>;
    expect(native.ok || native.status === 409).toBe(true); expect((requests[1] as Awaited<ReturnType<typeof oldPost>>).statusCode).toBe(200);
    expect((await saved()).wallets[0]).toMatchObject({ Revision: native.ok ? 2 : 1, Points: 100 });
  });
  check("real source goods lock prevents intermediate deduction visibility", async () => {
    const c = await command(); const results = await lockedRace("source-goods-lock", "goods", () => [actNativeExchange(f.ctx, c, f.client)]);
    expect((results[0] as Awaited<ReturnType<typeof actNativeExchange>>).ok).toBe(true); expect(f.material.Count).toBe(36);
  });
  check("receipt-tail fault rolls back five ledgers/profile and retains online dirty data for exact UUID retry", async () => {
    f.material.Count = 44; f.material.isDirty = true; f.p.info.Gold = 123; const c = await command(), before = await saved(), memory = f.material.toRow();
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT a05_pg_failure CHECK ("Signature"='never')`);
    await expect(actNativeExchange(f.ctx, c, f.client)).rejects.toThrow(); expect(await saved()).toEqual(before); expect(f.material.toRow()).toEqual(memory); expect(f.material.isDirty).toBe(true);
    await monitor.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT a05_pg_failure`);
    const retry = await actNativeExchange(f.ctx, c, f.client); expect(retry.ok).toBe(true); expect(f.material.Count).toBe(40); expect((await saved()).receipts).toHaveLength(1);
  });
  check("ten same-UUID commands share one real socket chain and one immutable receipt", async () => {
    const c = await command(0, 3); const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => actNativeExchange({ ...f.ctx, db: i % 2 ? b : a }, c, f.client)));
    expect(replies.every(r => r.ok)).toBe(true); expect(replies.filter(r => r.ok && !r.value.replayed)).toHaveLength(1);
    expect((await saved()).wallets[0]!.Revision).toBe(1); expect(f.material.Count).toBe(28); expect((await saved()).mails).toHaveLength(1);
  });
  check("offline replay on another real connection neither requires current token nor repeats reward", async () => {
    const c = await command(); expect((await actNativeExchange(f.ctx, c, f.client)).ok).toBe(true); const before = await saved();
    f.ctx.world.remove(f.p); f.client.closed = true; const replay = await actNativeExchange({ ...f.ctx, db: b }, c);
    expect(replay).toMatchObject({ ok: true, value: { replayed: true, view: { authority: "offline", stateToken: null } } }); expect(await saved()).toEqual(before);
  });
  check("actual MaxCount5 output produces six detached stacks and two five-attachment mails", async () => {
    await monitor.db.execute(sql`TRUNCATE player."Sys_Users_Goods",player."Sys_Users_Detail",member."Accounts"`);
    await monitor.db.update(game.Shop_Goods).set({ MaxCount: 5 }).where(eq(game.Shop_Goods.TemplateID, 11019));
    f = await exchangeFixture(a, 905, 11021, 20); const c = await command(2, 10), r = await actNativeExchange(f.ctx, c, f.client); expect(r.ok).toBe(true);
    const s = await saved(); expect(s.mails).toHaveLength(2); expect(s.goods.filter(g => g.UserID === 0)).toHaveLength(6);
    expect(s.goods.filter(g => g.UserID === 0).every(g => g.Count === 5 && g.IsBinds === true)).toBe(true); expect(f.material.IsExist).toBe(false);
    await f.p.saveIntoDatabase(a.db); expect((await saved()).goods).toEqual(s.goods);
  });
  check("online persistence barrier prevents command from observing or writing an autosave snapshot early", async () => {
    const c = await command(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
    const saving = f.p.withPersistenceLock(async () => { entered(); await gate; }); await ready;
    let settled = false; const action = actNativeExchange(f.ctx, c, f.client).then(r => { settled = true; return r; });
    await delay(30); expect(settled).toBe(false); expect((await saved()).receipts).toEqual([]); release(); await saving;
    expect((await action).ok).toBe(true); expect(f.material.Count).toBe(36); scenarios.push({ label: "online-persistence-barrier", activeConnections: 4 });
  });
});
