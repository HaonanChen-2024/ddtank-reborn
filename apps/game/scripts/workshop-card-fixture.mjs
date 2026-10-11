#!/usr/bin/env node
// Deterministic free-card validation in a NEW persistent database and independent real API/game processes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = resolve(repo, "../../runtime");
const settings = parseEnv(readFileSync(join(repo, ".env.workshop"), "utf8"));
const bin = resolve(settings.PGTOOLS_DIR ?? join(runtime, "tools/postgres-tools/bin"));
const database = `workshop_card_fixture_${Date.now()}_${randomBytes(3).toString("hex")}`;
assert.match(database, /^workshop_card_fixture_[0-9]+_[a-f0-9]{6}$/);
const dir = join(runtime, "runtime-research", database);
mkdirSync(dir, { recursive: true });
const file = join(dir, "fixture-report.json");
const ports = { api: 18080, tcp: 19200, ws: 19300, policy: 19843, internal: 19400 };
const childEnv = { ...process.env, ...settings, TZ: "UTC", PGHOST: "127.0.0.1", PGPORT: "55432", PGUSER: "postgres", PGPASSWORD: settings.PG_PASSWORD, PGCONNECT_TIMEOUT: "5" };
const report = { started: new Date().toISOString(), ok: false, controlledFixture: true, protocolOnly: true, database, ports, map: 1007, reward: { template: -100, count: 15000, probability: 1 }, children: [], checks: [] };
const children = [];
let stopping = false;
const checkpoint = () => writeFileSync(file, JSON.stringify(report, null, 2));
const delay = ms => new Promise(r => setTimeout(r, ms));

async function native(tool, args) {
  return new Promise((res, rej) => {
    const child = spawn(join(bin, tool + ".exe"), args, { env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { error += b; });
    child.once("error", rej);
    child.once("exit", code => code === 0 ? res(output.trim()) : rej(new Error(`${tool} exited ${code}: ${error.trim()}`)));
  });
}
const query = (db, sql) => native("psql", ["--dbname", db, "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", sql]);
async function liveFingerprint() {
  return JSON.parse(await query("ddtank", `SELECT json_build_object(
    'maps', (SELECT md5(coalesce(string_agg(v,E'\\n' ORDER BY v),'')) FROM (SELECT row_to_json(t)::text v FROM game."Map_Server" t) q),
    'drop101', (SELECT md5(coalesce(string_agg(v,E'\\n' ORDER BY v),'')) FROM (SELECT row_to_json(t)::text v FROM game."Drop_Item" t WHERE "DropId"=101) q))`));
}
async function assertFree(port) {
  await new Promise((res, rej) => {
    const s = createServer(); s.once("error", rej);
    s.listen({ host: "127.0.0.1", port, exclusive: true }, () => s.close(error => error ? rej(error) : res()));
  });
}
function launch(name, entry, env, args = []) {
  const log = createWriteStream(join(dir, name + ".log"));
  const hook = `process.on('message', message => { if(message === 'workshop-fixture-stop') process.emit('SIGTERM','SIGTERM'); });`;
  const code = hook + `await import(${JSON.stringify(pathToFileURL(entry).href)});` + (name === "battle" ? "if(process.connected)process.disconnect();" : "");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code, ...(args.length ? ["--", ...args] : [])], { cwd: repo, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout.pipe(log); child.stderr.pipe(log, { end: false });
  const item = { name, pid: child.pid, log: basename(name + ".log") };
  report.children.push(item); children.push({ child, item }); checkpoint();
  child.once("error", error => { item.error = error.message; });
  child.once("exit", (code, signal) => { item.exitCode = code; item.signal = signal; log.end(); checkpoint(); });
  return child;
}
async function waitReady(child, url, token) {
  const end = Date.now() + 60_000;
  while (Date.now() < end && !stopping) {
    assert.equal(child.exitCode, null, "fixture application exited before readiness");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000), headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (response.ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error("fixture application readiness timed out");
}
async function stop() {
  stopping = true;
  for (const { child, item } of children.toReversed()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    // The ordinary app entry owns SIGTERM saving/closing; IPC is delivered only to this run's child.
    if (child.connected) child.send("workshop-fixture-stop", () => {});
    const end = Date.now() + 10_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < end) await delay(100);
    if (child.exitCode === null && child.signalCode === null) { item.forcedOwnChildTermination = true; child.kill(); }
  }
  await delay(200); report.cleanup = "only fixture-owned children stopped; persistent fixture database retained; live PostgreSQL/API/game untouched"; checkpoint();
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void stop().then(() => process.exit(1)));

try {
  assert.equal(settings.DEV_ALLOW_ANY_TICKET, "false", "local fixture must keep ticket authentication");
  for (const p of Object.values(ports)) await assertFree(p);
  report.liveConfigBefore = await liveFingerprint(); checkpoint();
  const backups = join(runtime, "backups");
  const candidates = readdirSync(backups).filter(x => x.endsWith(".dump.json") && existsSync(join(backups, x + ".restore.json"))).sort();
  assert.ok(candidates.length, "a previously verified backup is required");
  const manifestPath = resolve(process.argv[2] ?? join(backups, candidates.at(-1)));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const verified = JSON.parse(readFileSync(manifestPath + ".restore.json", "utf8"));
  assert.equal(verified.ok, true); assert.equal(verified.originalDatabaseUntouched, true);
  assert.equal(basename(manifest.dump), manifest.dump);
  const dump = join(dirname(manifestPath), manifest.dump);
  const sha = createHash("sha256").update(readFileSync(dump)).digest("hex");
  assert.equal(sha, manifest.sha256); assert.equal(sha, verified.dumpSha256);
  report.backup = { dump: basename(dump), sha256: sha, previouslyVerified: true }; checkpoint();
  // Collision fails closed. Restore never uses --clean and never targets ddtank.
  await native("createdb", [database]);
  await native("pg_restore", ["--dbname", database, "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", dump]);
  const sql = `BEGIN;
    DO $$ BEGIN IF current_database() <> '${database}' THEN RAISE EXCEPTION 'wrong fixture database'; END IF;
      IF NOT EXISTS(SELECT 1 FROM game."Game_Map" WHERE "ID"=1007) THEN RAISE EXCEPTION 'fixture map missing'; END IF;
      IF NOT EXISTS(SELECT 1 FROM game."Drop_Condiction" WHERE "DropID"=101 AND "CondictionType"=1 AND "Para1" LIKE '%,0,%' AND "Para2" LIKE '%,0,%') THEN RAISE EXCEPTION 'Match card contract missing'; END IF;
    END $$;
    UPDATE game."Map_Server" SET "OpenMap"='1007';
    DELETE FROM game."Drop_Item" WHERE "DropId"=101;
    INSERT INTO game."Drop_Item" ("DropId","ItemId","ValueDate","IsBind","Random","BeginData","EndData") VALUES(101,-100,0,false,1,15000,15000);
    COMMIT;`;
  writeFileSync(join(dir, "fixture.sql"), sql);
  await query(database, sql);
  report.fixture = JSON.parse(await query(database, `SELECT json_build_object('database',current_database(),'mapRows',(SELECT count(*) FROM game."Map_Server" WHERE "OpenMap"='1007'),'cardRows',(SELECT count(*) FROM game."Drop_Item" WHERE "DropId"=101),'template',(SELECT "ItemId" FROM game."Drop_Item" WHERE "DropId"=101),'count',(SELECT "BeginData" FROM game."Drop_Item" WHERE "DropId"=101))`));
  assert.ok(report.fixture.mapRows > 0); assert.equal(report.fixture.cardRows, 1); assert.equal(report.fixture.template, -100); assert.equal(report.fixture.count, 15000);
  report.checks.push("verified backup restored into a unique new database; only that copy receives map/drop fixtures"); checkpoint();
  const url = `postgres://postgres:${encodeURIComponent(settings.PG_PASSWORD)}@127.0.0.1:55432/${database}`;
  const base = `http://127.0.0.1:${ports.api}`;
  const env = { ...childEnv, DATABASE_URL: url, BIND_HOST: "127.0.0.1", HOST: "127.0.0.1", PORT: String(ports.api), PUBLIC_URL: base,
    GAME_HOST: "127.0.0.1", PUBLIC_HOST: "127.0.0.1", GAME_PORT: String(ports.tcp), WS_PORT: String(ports.ws), POLICY_PORT: String(ports.policy), ADMIN_PORT: String(ports.internal), ADMIN_HOST: "127.0.0.1",
    GAME_WS_URL: `ws://127.0.0.1:${ports.ws}/ws`, WS_PUBLIC_URL: `ws://127.0.0.1:${ports.ws}/ws`, WS_ALLOWED_ORIGINS: base,
    GAME_INTERNAL_URL: `http://127.0.0.1:${ports.internal}`, GAME_INTERNAL_TOKEN: settings.ADMIN_TOKEN, SITE_URL: base, CORS_ORIGINS: base,
    DB_MIGRATE: "false", DB_SEED_IF_EMPTY: "false", RSA_USE_VENDOR_KEY: "false", DEV_ALLOW_ANY_TICKET: "false", BOT_FALLBACK_SEC: "25", UPLOAD_DIR: join(dir, "uploads") };
  const game = launch("game", join(repo, "apps/game/src/index.ts"), env);
  await waitReady(game, env.GAME_INTERNAL_URL + "/status", env.ADMIN_TOKEN);
  const api = launch("api", join(repo, "apps/api/src/index.ts"), env);
  await waitReady(api, base + "/healthz");
  report.checks.push("ordinary API/game entries run in independent authenticated loopback processes; bot fallback remains 25 real seconds"); checkpoint();
  const battle = launch("battle", join(repo, "apps/game/scripts/workshop-battle.ts"), { ...env,
    WORKSHOP_BATTLE_DATABASE_URL: url, WORKSHOP_BATTLE_API_URL: base, WORKSHOP_BATTLE_TCP_PORT: String(ports.tcp), WORKSHOP_BATTLE_WS_URL: env.GAME_WS_URL,
    WORKSHOP_BATTLE_ORIGIN: base, WORKSHOP_BATTLE_REPORT_FILE: join(dir, "battle-report.json"), WORKSHOP_BATTLE_CREDENTIAL_FILE: join(dir, "credentials.json"),
    WORKSHOP_BATTLE_EXPECT_MAP: "1007", WORKSHOP_BATTLE_EXPECT_CARD: "-100" }, ["--require-currency"]);
  const exitCode = await new Promise((res, rej) => { battle.once("error", rej); battle.once("exit", res); });
  const result = JSON.parse(readFileSync(join(dir, "battle-report.json"), "utf8"));
  assert.equal(exitCode, 0, result.error ?? "fixture battle failed"); assert.equal(result.ok, true);
  assert.equal(result.battles.length, 2); assert.deepEqual(result.battles.map(b => b.mapId), [1007, 1007]);
  for (const b of result.battles) {
    assert.equal(b.card.template, -100); assert.equal(b.card.count, 15000);
    assert.equal(b.cardBalancesAfter.gold - b.cardBalancesBefore.gold, 15000);
    assert.equal(b.persisted.after.user.gold, b.cardBalancesAfter.gold);
    assert.equal(b.returnedToLobby, true);
  }
  report.battle = { file: "battle-report.json", username: result.username, userId: result.userId, count: result.battles.length, before: result.before.user, after: result.after.user };
  report.liveConfigAfter = await liveFingerprint(); assert.deepEqual(report.liveConfigAfter, report.liveConfigBefore);
  report.checks.push("two complete real TCP/WS fights; free gold card +15000 each; disconnect persistence and fresh WS login verified; live maps/drop101 digests unchanged");
  report.ok = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally { await stop(); report.ended = new Date().toISOString(); checkpoint(); console.log(JSON.stringify({ ok: report.ok, controlledFixture: true, database, error: report.error, report: file })); }
