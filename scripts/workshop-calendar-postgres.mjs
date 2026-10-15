#!/usr/bin/env node
// Opt-in only: a new UUID cluster and template0 DB. Application configuration/services are never used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.deepEqual(process.argv.slice(2), ["--execute"], "Only explicit --execute is accepted");
assert.equal(process.versions.node.split(".")[0], "24", "Node 24 is required");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), runtime = resolve(repo, "../../runtime");
const token = randomUUID(), database = `workshop_calendar_${token.replaceAll("-", "")}`, port = 55439;
assert.match(database, /^workshop_calendar_[a-f0-9]{32}$/);
const parent = join(runtime, "calendar-sign-recovery-20261016"), directory = join(parent, `native-postgres-${token}`), cluster = join(directory, "data");
mkdirSync(parent, { recursive: true }); mkdirSync(directory, { recursive: false });
const password = randomBytes(32).toString("base64url");
const redact = value => [password, encodeURIComponent(password)]
  .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value))
  .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted PostgreSQL URL]");
const allowed = new Set(["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp", "userprofile", "home", "appdata", "localappdata",
  "number_of_processors", "processor_architecture", "programfiles", "programfiles(x86)", "programw6432"]);
// No DATABASE_URL, PG*, dotenv, NODE_OPTIONS or previous test URLs enter any child.
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))),
  NODE_ENV: "test", TZ: "UTC", LC_MESSAGES: "C", CI: "1", NO_COLOR: "1" };
const sources = ["apps/api/test/calendar-concurrency-postgres.test.ts", "scripts/workshop-calendar-postgres.mjs",
  "apps/api/src/request/endpoints/social.ts", "apps/api/src/request/endpoints/activity-state.ts",
  "apps/api/src/request/types.ts", "apps/api/src/routes/request.ts", "apps/game/src/handlers/events.ts", "apps/game/src/game/world-boss-rewards.ts"];
const hashes = () => Object.fromEntries(sources.map(path => [path, createHash("sha256").update(readFileSync(join(repo, path))).digest("hex")]));
const receipt = { version: 2, database, token, directory, cluster, port, startedAt: new Date().toISOString(), phase: "prepared",
  scope: "Fresh owned cluster/template0 DB; four independent calendar/sign-in PostgreSQL connections", liveConfigurationRead: false,
  liveDatabaseOpened: false, liveServiceStarted: false, databaseRemoved: false, clusterRetained: true, portClosed: false };
const save = () => writeFileSync(join(directory, "receipt.json"), redact(JSON.stringify(receipt, null, 2)) + "\n");
const fail = (error, field = "error") => { receipt.phase = "failed"; receipt[field] = redact(error?.message ?? error); process.exitCode = 1; };
save(); writeFileSync(join(directory, "test.log"), "");
const ownerPath = join(directory, "cluster-owner.json"), ownership = { token, database, cluster, port };
writeFileSync(ownerPath, JSON.stringify(ownership, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ receipt: join(directory, "receipt.json"), phase: "prepared", database, port }));

function command(executable, args, { input, capture = true, cwd = repo, env = environment } = {}) {
  return new Promise((complete, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true,
      stdio: capture ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : "ignore" });
    let output = "";
    child.stdout?.on("data", bytes => { output += bytes; }); child.stderr?.on("data", bytes => { output += bytes; });
    child.stdin?.on("error", () => {}); if (input !== undefined) child.stdin.end(input);
    child.once("error", reject);
    child.once("close", (code, signal) => complete({ code, signal, pid: child.pid, output: redact(output) }));
  });
}
async function assertPortAvailable() {
  await new Promise((complete, reject) => {
    const probe = createServer(); probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(error => error ? reject(error) : complete()));
  });
}
async function listening() {
  return new Promise((complete, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }); socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); complete(true); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Owned port closure probe timed out")); });
    socket.once("error", error => { socket.destroy(); error.code === "ECONNREFUSED" ? complete(false) : reject(error); });
  });
}
function ownedPostmaster() {
  assert.deepEqual(JSON.parse(readFileSync(ownerPath, "utf8")), ownership, "Owned cluster token changed; refuse stop");
  assert.equal(realpathSync(dirname(cluster)), realpathSync(directory));
  const lines = readFileSync(join(cluster, "postmaster.pid"), "utf8").trim().split(/\r?\n/), pid = Number(lines[0]);
  assert(Number.isSafeInteger(pid) && pid > 0); assert.equal(realpathSync(lines[1]), realpathSync(cluster)); assert.equal(Number(lines[3]), port);
  if (receipt.postmasterPid) assert.equal(pid, receipt.postmasterPid, "Owned postmaster PID changed");
  return pid;
}
async function checkCluster(client, expectedDatabase) {
  const [identity] = await client`SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port,
    current_setting('data_directory') AS directory, current_setting('server_version') AS version,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_id`;
  assert.equal(identity.database, expectedDatabase); assert.equal(identity.address, "127.0.0.1"); assert.equal(identity.port, port);
  assert.equal(realpathSync(identity.directory), realpathSync(cluster), "Unexpected PostgreSQL cluster");
  if (receipt.serverIdentity) assert.equal(identity.system_id, receipt.serverIdentity.system_id, "Cluster identity changed");
  ownedPostmaster(); return identity;
}
let admin, marker, binaries, open, created = false, startAttempted = false;
try {
  receipt.source = hashes(); save(); await assertPortAvailable();
  const requireDb = createRequire(join(repo, "packages/db/package.json"));
  const embeddedRequire = createRequire(requireDb.resolve("embedded-postgres"));
  // Import binary paths only; EmbeddedPostgres has an unrelated process-exit hook.
  binaries = await import(pathToFileURL(embeddedRequire.resolve("@embedded-postgres/windows-x64")).href);
  const postgres = requireDb("postgres");
  assert(!existsSync(cluster), "Cluster directory must be fresh"); mkdirSync(cluster);
  receipt.phase = "initializing"; save();
  const initialized = await command(binaries.initdb, ["-D", cluster, "--username=postgres", "--auth=trust", "--encoding=UTF8", "--locale=C", "--lc-messages=C"]);
  writeFileSync(join(directory, "initdb.log"), initialized.output); receipt.initialization = { code: initialized.code, signal: initialized.signal };
  assert.equal(initialized.code, 0, "Isolated initdb failed");
  // No password file: set SCRAM via single-user stdin before any network listener exists.
  const configured = await command(binaries.postgres, ["--single", "-D", cluster, "-c", "password_encryption=scram-sha-256",
    "-c", "log_statement=none", "-c", "log_min_error_statement=panic", "-c", "logging_collector=off", "postgres"],
  { input: `ALTER ROLE postgres PASSWORD '${password}';\nSELECT '${token}' AS initialized FROM pg_authid WHERE rolname='postgres' AND rolpassword LIKE 'SCRAM-SHA-256$%';\n` });
  writeFileSync(join(directory, "password-bootstrap.log"), configured.output);
  assert.equal(configured.code, 0, "Single-user password bootstrap failed");
  assert(!/\b(?:ERROR|FATAL|PANIC):/.test(configured.output) && configured.output.includes(token), "SCRAM bootstrap marker missing");
  writeFileSync(join(cluster, "pg_hba.conf"), "# Owned Calendar test cluster. Authenticated IPv4 loopback only.\n"
    + "host all postgres 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n");
  await assertPortAvailable(); receipt.phase = "starting"; save(); startAttempted = true;
  // Ignore stdio: postgres is a grandchild and must not inherit pg_ctl's output pipes.
  const started = await command(binaries.pg_ctl, ["start", "-D", cluster, "-l", join(directory, "postgres.log"), "-o",
    `-h 127.0.0.1 -p ${port} -c timezone=UTC -c log_timezone=UTC -c lc_messages=C`, "-w", "-t", "30"], { capture: false });
  receipt.start = { code: started.code, signal: started.signal }; assert.equal(started.code, 0, "Owned pg_ctl start failed; see postgres.log");
  receipt.postmasterPid = ownedPostmaster();
  open = name => {
    assert(name === "postgres" || name === database, "Refuse other databases");
    return postgres({ host: "127.0.0.1", port, username: "postgres", password, database: name, max: 1, connect_timeout: 5, idle_timeout: 5,
      onnotice: () => {}, connection: { TimeZone: "UTC", application_name: "workshop_calendar_isolated_runner", statement_timeout: "10000" } });
  };
  admin = open("postgres"); receipt.serverIdentity = await checkCluster(admin, "postgres");
  assert.deepEqual((await admin`SELECT datname FROM pg_database ORDER BY datname`).map(row => row.datname), ["postgres", "template0", "template1"]);
  await admin.unsafe(`CREATE DATABASE "${database}" TEMPLATE template0`); created = true; receipt.databaseCreated = true;
  receipt.databaseOid = (await admin`SELECT oid::text AS oid FROM pg_database WHERE datname=${database}`)[0].oid;
  receipt.phase = "created"; save(); marker = open(database); await checkCluster(marker, database);
  await marker`CREATE TABLE public."WorkshopCalendarTest" (token text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`;
  await marker`INSERT INTO public."WorkshopCalendarTest" (token) VALUES (${token})`; receipt.markerCreated = true;
  await marker.end({ timeout: 5 }); marker = undefined;
  const testUrl = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  const env = { ...environment, WORKSHOP_CALENDAR_URL: testUrl, WORKSHOP_CALENDAR_TOKEN: token, WORKSHOP_CALENDAR_OUTPUT: directory,
    WORKSHOP_CALENDAR_PORT: String(port), WORKSHOP_CALENDAR_CLUSTER: cluster };
  receipt.phase = "testing"; save();
  const result = await command(process.execPath, [join(repo, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts",
    "--pool=threads", "--maxWorkers=1", "test/calendar-concurrency-postgres.test.ts"], { cwd: join(repo, "apps/api"), env });
  writeFileSync(join(directory, "test.log"), result.output); receipt.exitCode = result.code; receipt.signal = result.signal;
  receipt.phase = "tested"; save(); console.log(result.output);
  // A failing baseline still supplies evidence; keep it before rejecting the nonzero exit.
  const evidencePath = join(directory, "test-evidence.json");
  if (existsSync(evidencePath)) {
    receipt.evidence = JSON.parse(redact(readFileSync(evidencePath, "utf8")));
    receipt.passed = receipt.evidence.passed; receipt.connectionPids = receipt.evidence.connectionPids; receipt.closedConnections = receipt.evidence.closedConnections; save();
  }
  assert.equal(result.code, 0, "Native calendar tests failed"); assert(receipt.evidence, "Native calendar evidence is missing");
  const evidence = receipt.evidence;
  assert.equal(evidence.database, database); assert.equal(evidence.token, token); assert.equal(evidence.passed, 7); assert.equal(evidence.closedConnections, true);
  assert(Array.isArray(evidence.connectionPids) && evidence.connectionPids.length === 4, "Four independent backend PIDs are required");
  assert(evidence.connectionPids.every(pid => Number.isSafeInteger(pid) && pid > 0)); assert.equal(new Set(evidence.connectionPids).size, 4);
  const blockers = { "existing-calendar-authenticated": 1, "existing-calendar-legacy": 1, "legacy-first-creation": 1,
    "legacy-month-rollover": 1, "queued-date-legacy": 3, "queued-date-authenticated": 3, "queued-date-game": 1, "queued-date-sign-award": 1 };
  assert(Array.isArray(evidence.scenarios), "Calendar lock scenarios are missing");
  assert.deepEqual(evidence.scenarios.map(scenario => scenario.label).sort(), Object.keys(blockers).sort(), "Expected calendar races are missing");
  assert(evidence.scenarios.every(({ label, observed }) => observed?.state === "blocked" && observed.wait === "Lock"
    && observed.blockers?.includes(evidence.connectionPids[blockers[label]])), "Every successful calendar race must observe its expected owner-row blocker");
  receipt.lockScenarios = evidence.scenarios.length; receipt.phase = "verified";
} catch (error) { fail(error); }
finally {
  try {
    await marker?.end({ timeout: 5 });
    if (created) {
      assert(receipt.markerCreated && open && admin, "No completed ownership marker; retain database");
      await checkCluster(admin, "postgres"); assert.equal((await admin`SELECT oid::text AS oid FROM pg_database WHERE datname=${database}`)[0]?.oid, receipt.databaseOid);
      const guard = open(database);
      try {
        await checkCluster(guard, database);
        assert.deepEqual((await guard`SELECT token FROM public."WorkshopCalendarTest"`).map(row => row.token), [token], "Ownership marker mismatch; refuse DROP");
      } finally { await guard.end({ timeout: 5 }); }
      assert.equal((await admin`SELECT pid FROM pg_stat_activity WHERE datname=${database}`).length, 0, "Connections remain; refuse DROP");
      // Exact process-created DB only. No FORCE or termination of database connections.
      await admin.unsafe(`DROP DATABASE "${database}"`);
      assert.equal((await admin`SELECT datname FROM pg_database WHERE datname=${database}`).length, 0); receipt.databaseRemoved = true;
    }
  } catch (error) { fail(error, "cleanupError"); }
  try { await admin?.end({ timeout: 5 }); } catch (error) { fail(error, "adminCloseError"); }
  try {
    if (startAttempted && existsSync(join(cluster, "postmaster.pid"))) {
      ownedPostmaster();
      const stopped = await command(binaries.pg_ctl, ["stop", "-D", cluster, "-m", "fast", "-w", "-t", "20"]);
      writeFileSync(join(directory, "pg-stop.log"), stopped.output); receipt.stop = { code: stopped.code, signal: stopped.signal };
      assert.equal(stopped.code, 0, "Owned pg_ctl stop failed");
    }
    if (startAttempted) {
      for (let attempt = 0; attempt < 20; attempt++) { if (!(await listening())) { receipt.portClosed = true; break; } await delay(100); }
      assert(receipt.portClosed, "Selected port remains open; no other process will be stopped");
    }
  } catch (error) { fail(error, "stopError"); }
  try {
    receipt.sourceAfter = hashes(); receipt.sourceStable = JSON.stringify(receipt.sourceAfter) === JSON.stringify(receipt.source);
    assert(receipt.sourceStable, "Sources changed during this run; repeat against stable sources");
  } catch (error) { fail(error, "sourceError"); }
  if (receipt.phase === "verified" && receipt.databaseRemoved && receipt.portClosed && receipt.stop?.code === 0) receipt.phase = "passed";
  else { receipt.phase = "failed"; process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ receipt: join(directory, "receipt.json"), phase: receipt.phase, passed: receipt.passed,
    sourceStable: receipt.sourceStable, databaseRemoved: receipt.databaseRemoved, portClosed: receipt.portClosed, clusterRetained: true }));
}
