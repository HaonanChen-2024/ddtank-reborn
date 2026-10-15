#!/usr/bin/env node
// Opt-in only: a NEW cluster, template0 database and four real test connections. No live configuration is read.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(repo, "../../runtime");
const parent = join(runtime, "activity-carnival-completion-20261015");
const expectedNode = join(runtime, "tools/node-v24.21.0-win-x64/node.exe");
const testFile = "apps/api/test/carnival-global-postgres.test.ts";
const token = randomUUID(), database = `workshop_carnival_${token.replaceAll("-", "")}`;
const directory = join(parent, `pg-race-${token}`), cluster = join(directory, "cluster");
let password = "", pg, admin, marker, activeChild, stopPromise, interrupted = false;
const receipt = { version: 1, token, database, directory, cluster, startedAt: new Date().toISOString(), phase: "prepared",
  liveConfigurationRead: false, liveDatabaseOpened: false, liveServiceStarted: false,
  databaseCreated: false, markerCreated: false, databaseRemoved: false, clusterRetained: true, portClosed: false };
const redact = value => {
  let text = String(value);
  for (const secret of [password, encodeURIComponent(password)].filter(Boolean)) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted-postgres-url]");
};
const save = () => writeFileSync(join(directory, "receipt.json"), redact(JSON.stringify(receipt, null, 2)) + "\n");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const filePin = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const within = (base, path) => { const rel = relative(base, path); assert(rel && !rel.startsWith("..") && !isAbsolute(rel)); };

function filesIn(path, suffix) {
  return readdirSync(join(repo, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const next = `${path}/${entry.name}`;
    assert(!entry.isSymbolicLink(), `Source symlink not allowed: ${next}`);
    return entry.isDirectory() ? filesIn(next, suffix) : suffix.some(ext => entry.name.endsWith(ext)) ? [next] : [];
  });
}
function sourcePins() {
  const files = ["scripts/workshop-native-carnival-postgres.mjs", testFile, "apps/api/vitest.config.ts", "package.json", "pnpm-lock.yaml", "tsconfig.base.json",
    ...["apps/api", "packages/db", "packages/auth", "packages/fight", "packages/protocol"].flatMap(path => [`${path}/package.json`, ...filesIn(`${path}/src`, [".ts", ".json"])]),
    ...filesIn("packages/db/drizzle", [".sql", ".json"])];
  return Object.fromEntries([...new Set(files)].sort().map(path => [path, filePin(join(repo, path))]));
}
function cleanEnvironment() {
  const allowed = new Set(["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp", "userprofile", "home", "appdata", "localappdata",
    "number_of_processors", "processor_architecture", "programfiles", "programfiles(x86)", "programw6432"]);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))),
    NODE_ENV: "test", TZ: "UTC", LC_MESSAGES: "C", CI: "1", NO_COLOR: "1" };
}
function command(executable, args, { timeout = 30_000, input, label, cwd = repo } = {}) {
  return new Promise((complete, reject) => {
    const started = performance.now(), child = spawn(executable, args, { cwd, env: process.env, windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    activeChild = { child, label };
    let output = "", bytes = 0, timedOut = false, overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const receive = chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { overflow = true; child.kill(); return; }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    child.stdin?.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    child.once("error", error => { clearTimeout(timer); if (activeChild?.child === child) activeChild = undefined; reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer); if (activeChild?.child === child) activeChild = undefined;
      complete({ code, signal, pid: child.pid, timedOut, overflow, milliseconds: Math.round(performance.now() - started), output: redact(output) });
    });
  });
}
async function deadline(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function unusedPort() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise((accept, reject) => {
      const server = createServer(); server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        const value = server.address().port; server.close(error => error ? reject(error) : accept(value));
      });
    });
    if (port !== 55432) return port;
  }
  throw new Error("No permitted loopback port available");
}
async function listening(port) {
  return await new Promise((accept, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); accept(true); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Port closure probe timed out")); });
    socket.once("error", error => { socket.destroy(); error.code === "ECONNREFUSED" ? accept(false) : reject(error); });
  });
}
function postmasterIdentity() {
  assert.equal(realpathSync(dirname(cluster)), realpathSync(directory));
  const lines = readFileSync(join(cluster, "postmaster.pid"), "utf8").trim().split(/\r?\n/);
  assert.equal(Number(lines[0]), pg.process?.pid, "Postmaster PID is not owned by this runner");
  assert.equal(realpathSync(lines[1]), realpathSync(cluster), "Postmaster data directory mismatch");
  assert.equal(Number(lines[3]), receipt.port, "Postmaster port mismatch");
  return Number(lines[0]);
}
async function checkCluster(client, expectedDatabase) {
  const [identity] = await client`SELECT current_database() AS database, current_user AS owner, host(inet_server_addr()) AS host,
    inet_server_port() AS port, current_setting('data_directory') AS directory,
    current_setting('server_version_num')::int AS version, (SELECT system_identifier::text FROM pg_control_system()) AS system_id`;
  assert.equal(identity.database, expectedDatabase); assert.equal(identity.owner, "postgres");
  assert.equal(identity.host, "127.0.0.1"); assert.equal(identity.port, receipt.port);
  assert.equal(realpathSync(identity.directory), realpathSync(cluster));
  assert(identity.version >= 180000 && identity.version < 190000, "Expected installed PostgreSQL 18");
  if (receipt.serverIdentity) assert.equal(identity.system_id, receipt.serverIdentity.system_id, "Cluster identity changed");
  postmasterIdentity(); return identity;
}
async function checkMarker(client) {
  await checkCluster(client, database);
  assert.deepEqual((await client`SELECT token FROM public."WorkshopCarnivalTest"`).map(row => row.token), [token]);
  const shape = await client`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS required
    FROM pg_attribute a WHERE a.attrelid='public."WorkshopCarnivalTest"'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`;
  assert.deepEqual(shape.map(row => ({ ...row })), [{ name: "token", type: "text", required: true }]);
  const constraints = await client`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public."WorkshopCarnivalTest"'::regclass`;
  assert.deepEqual(constraints.map(row => row.definition).sort(), ["NOT NULL token", "PRIMARY KEY (token)"]);
  const schemas = await client`SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' ORDER BY nspname`;
  assert(schemas.every(row => ["app", "drizzle", "game", "member", "player", "public"].includes(row.nspname)), "Unexpected schema; refuse DROP");
  return schemas.map(row => row.nspname);
}
function testEvidence() {
  const evidencePath = join(directory, "test-evidence.json"), evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.token, token); assert.equal(evidence.passed, 10); assert.equal(evidence.closedConnections, true);
  const pids = evidence.connectionPids;
  assert(Array.isArray(pids) && pids.length === 4 && pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  assert.equal(new Set(pids).size, 4); assert(!pids.includes(receipt.postmasterPid));
  assert(Array.isArray(evidence.locks) && evidence.locks.length === 3);
  for (const [index, lock] of evidence.locks.entries()) {
    assert.equal(lock.label, ["different-actors-one-shared-boundary", "same-uuid-eight-retries", "ban-before-qualification"][index]);
    assert.equal(lock.target, ["global", "wallet", "account"][index]); assert.equal(lock.connections.length, index === 2 ? 1 : 2);
    assert.deepEqual(lock.connections.map(row => row.pid), (index === 2 ? [pids[2]] : pids.slice(2)).sort((a, b) => a - b));
    assert(lock.connections.every(row => row.wait_event_type === "Lock" && row.blockers.length > 0
      && row.blockers.every(pid => pids.includes(pid) && pid !== row.pid)));
    assert(lock.connections.some(row => row.blockers.includes(pids[1])), "Holder was not observed blocking test connections");
  }
  return { passed: evidence.passed, connectionPids: pids, locks: evidence.locks, closedConnections: true, file: filePin(evidencePath) };
}
async function main() {
  if (!process.argv.includes("--execute")) {
    assert.equal(process.argv.length, 2, "Only --execute is accepted");
    console.log("Prepared only. --execute creates an isolated pg-race-UUID cluster and runs exactly 10 Carnival PostgreSQL tests; no live configuration or database is used.");
    return;
  }
  assert.deepEqual(process.argv.slice(2), ["--execute"], "Only --execute is accepted");
  mkdirSync(directory, { recursive: false });
  assert.equal(realpathSync(dirname(directory)), realpathSync(parent));
  save();
  let open;
  const signal = () => { interrupted = true; if (["vitest", "initdb", "password-bootstrap"].includes(activeChild?.label)) activeChild.child.kill(); };
  process.on("SIGINT", signal); process.on("SIGTERM", signal);
  try {
    assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64");
    assert.equal(process.versions.node.split(".")[0], "24", "Run with the frozen Node 24 runtime");
    assert.equal(realpathSync(process.execPath), realpathSync(expectedNode));
    assert.match(token, /^[a-f0-9-]{36}$/); assert.match(database, /^workshop_carnival_[a-f0-9]{32}$/);
    within(directory, cluster); assert(!existsSync(cluster)); mkdirSync(cluster);
    // Deliberately do not forward DATABASE_URL, PG*, NODE_OPTIONS, dotenv or application settings.
    process.env = cleanEnvironment(); receipt.environmentKeys = Object.keys(process.env).sort();
    password = randomBytes(32).toString("base64url");
    const requireDb = createRequire(join(repo, "packages/db/package.json"));
    const embeddedPath = requireDb.resolve("embedded-postgres"), embeddedRequire = createRequire(embeddedPath);
    const embeddedPackagePath = resolve(dirname(embeddedPath), "../package.json");
    const embeddedPackage = JSON.parse(readFileSync(embeddedPackagePath, "utf8"));
    assert.equal(embeddedPackage.version, "18.4.0-beta.17");
    const binaries = await import(pathToFileURL(embeddedRequire.resolve("@embedded-postgres/windows-x64")).href);
    const postgres = requireDb("postgres");
    receipt.source = sourcePins();
    receipt.binaries = Object.fromEntries([process.execPath, binaries.initdb, binaries.postgres, binaries.pg_ctl,
      embeddedPackagePath, embeddedPath, join(repo, "node_modules/vitest/vitest.mjs")].map(path => [path, filePin(path)]));
    writeFileSync(join(directory, "source-freeze.json"), JSON.stringify(receipt.source, null, 2) + "\n");
    receipt.port = await unusedPort(); assert.notEqual(receipt.port, 55432); assert(!(await listening(receipt.port)));
    let pgLogBytes = 0;
    const pgLog = message => {
      try {
        const text = redact(message); pgLogBytes += Buffer.byteLength(text);
        assert(pgLogBytes <= 8 * 1024 * 1024, "Postgres log exceeds bounded output limit");
        appendFileSync(join(directory, "postgres.log"), text);
      } catch (error) { receipt.postgresLogError = redact(error?.message ?? error); interrupted = true; }
    };
    // Do not import EmbeddedPostgres: its async-exit-hook beforeExit handler forces process.exit(0).
    pg = { process: undefined, start: () => new Promise((accept, reject) => {
      const child = spawn(binaries.postgres, ["-D", cluster, "-p", String(receipt.port), "-c", "listen_addresses=127.0.0.1",
        "-c", "timezone=UTC", "-c", "log_timezone=UTC", "-c", "lc_messages=C"],
      { cwd: repo, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      pg.process = child;
      let tail = "";
      const receive = chunk => {
        const message = chunk.toString("utf8"); pgLog(message); tail = (tail + message).slice(-1024);
        if (tail.includes("database system is ready to accept connections")) accept();
      };
      child.stdout.on("data", receive); child.stderr.on("data", receive);
      child.once("error", reject);
      child.once("close", (code, signal) => reject(new Error(`Owned Postgres closed before readiness: ${code}/${signal}`)));
    }) };
    // Only the exact owned pg_ctl target may stop this child. Never taskkill or delete cluster files.
    pg.stop = () => {
      if (!pg.process || pg.process.exitCode !== null || pg.process.signalCode !== null) return Promise.resolve();
      return stopPromise ??= (async () => {
        postmasterIdentity();
        const result = await command(binaries.pg_ctl, ["stop", "-D", cluster, "-m", "fast", "-w", "-t", "20"], { timeout: 25_000, label: "pg_ctl" });
        writeFileSync(join(directory, "pg-stop.log"), result.output); const { output, ...processReceipt } = result;
        receipt.stop = processReceipt; assert.equal(result.code, 0, "Owned pg_ctl stop failed"); assert(!result.timedOut && !result.overflow);
      })();
    };
    receipt.phase = "initializing"; save();
    // Windows initdb treats --pwfile=- as a filename. Initialize without listening, then use single-user stdin.
    const initialized = await command(binaries.initdb, ["-D", cluster, "--username=postgres", "--auth=trust", "--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      { timeout: 30_000, label: "initdb" });
    writeFileSync(join(directory, "initdb.log"), initialized.output); const { output: initOutput, ...initProcess } = initialized;
    receipt.initialization = initProcess; assert.equal(initialized.code, 0, "Isolated initdb failed"); assert(!initialized.timedOut && !initialized.overflow && !interrupted);
    assert.equal(readFileSync(join(cluster, "PG_VERSION"), "utf8").trim(), "18");
    assert.match(password, /^[A-Za-z0-9_-]{43}$/);
    const configured = await command(binaries.postgres, ["--single", "-D", cluster, "-c", "password_encryption=scram-sha-256",
      "-c", "log_statement=none", "-c", "log_min_error_statement=panic", "-c", "logging_collector=off", "postgres"],
    { timeout: 30_000, label: "password-bootstrap", input: `ALTER ROLE postgres PASSWORD '${password}';\nSELECT '${token}' AS initialized FROM pg_authid WHERE rolname='postgres' AND rolpassword LIKE 'SCRAM-SHA-256$%';\n` });
    // command() redacts stdout/stderr in memory before any output is saved; its stdin is never logged.
    writeFileSync(join(directory, "password-bootstrap.log"), configured.output);
    const { output: configuredOutput, ...passwordProcess } = configured; receipt.passwordBootstrap = passwordProcess;
    assert.equal(configured.code, 0, "Single-user password bootstrap failed");
    assert(!configured.timedOut && !configured.overflow && !interrupted && !/\b(?:ERROR|FATAL|PANIC):/.test(configuredOutput));
    assert(configuredOutput.includes(token), "Single-user SCRAM marker missing");
    const hba = "# Isolated Carnival runner: only authenticated IPv4 loopback is permitted.\n"
      + "host all postgres 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n";
    writeFileSync(join(directory, "pg-hba-initial.conf"), readFileSync(join(cluster, "pg_hba.conf")));
    writeFileSync(join(cluster, "pg_hba.conf"), hba); assert.equal(readFileSync(join(cluster, "pg_hba.conf"), "utf8"), hba);
    receipt.authentication = { passwordFileUsed: false, singleUserStdin: true, scramMarker: token,
      networkServerStartedAfterHba: true, hba: filePin(join(cluster, "pg_hba.conf")) };
    receipt.phase = "starting"; save(); await deadline(pg.start(), 30_000, "Owned Postgres start");
    receipt.postmasterPid = postmasterIdentity();
    open = name => {
      assert(name === "postgres" || name === database, "Only catalog administration and the new owned DB are permitted");
      return postgres({ host: "127.0.0.1", port: receipt.port, username: "postgres", password, database: name,
        max: 1, connect_timeout: 5, idle_timeout: 5, onnotice: () => {}, connection: { TimeZone: "UTC", application_name: "workshop_carnival_isolated_runner", statement_timeout: "5000" } });
    };
    admin = open("postgres"); receipt.serverIdentity = await checkCluster(admin, "postgres");
    assert.deepEqual((await admin`SELECT datname FROM pg_database ORDER BY datname`).map(row => row.datname), ["postgres", "template0", "template1"]);
    assert(!interrupted); await admin.unsafe(`CREATE DATABASE "${database}" TEMPLATE template0`); receipt.databaseCreated = true;
    receipt.databaseOid = (await admin`SELECT oid::text AS oid FROM pg_database WHERE datname=${database}`)[0].oid;
    marker = open(database); await checkCluster(marker, database);
    await marker`CREATE TABLE public."WorkshopCarnivalTest" (token text PRIMARY KEY)`;
    await marker`INSERT INTO public."WorkshopCarnivalTest" (token) VALUES (${token})`; receipt.markerCreated = true;
    receipt.initialSchemas = await checkMarker(marker);
    assert.deepEqual((await marker`SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename`)
      .map(row => ({ ...row })), [{ schemaname: "public", tablename: "WorkshopCarnivalTest" }]);
    await marker.end({ timeout: 5 }); marker = undefined;
    assert.deepEqual(sourcePins(), receipt.source, "Sources changed before tests"); assert(!interrupted);
    const url = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${receipt.port}/${database}`;
    const testEnv = { ...process.env, WORKSHOP_CARNIVAL_GLOBAL_URL: url, WORKSHOP_CARNIVAL_GLOBAL_TOKEN: token,
      WORKSHOP_CARNIVAL_GLOBAL_OUTPUT: directory, WORKSHOP_CARNIVAL_GLOBAL_PORT: String(receipt.port) };
    receipt.testCommand = { executable: process.execPath, args: ["--max-old-space-size=8192", join(repo, "node_modules/vitest/vitest.mjs"),
      "run", "--config", "vitest.config.ts", "--pool=threads", "--maxWorkers=1", "test/carnival-global-postgres.test.ts"], cwd: join(repo, "apps/api"),
      environmentKeys: Object.keys(testEnv).sort(), timeoutMilliseconds: 120_000 };
    receipt.phase = "testing"; save();
    // One threaded worker: timeout kills only the exact spawned Node process, without taskkill or orphaned child workers.
    const beforeEnv = process.env;
    let result;
    try {
      process.env = testEnv;
      // command's cwd is intentionally overridden only for the one existing API Vitest config.
      result = await command(process.execPath, receipt.testCommand.args, { timeout: 120_000, label: "vitest", cwd: join(repo, "apps/api") });
    } finally { process.env = beforeEnv; }
    writeFileSync(join(directory, "test.log"), result.output); const { output: testOutput, ...testProcess } = result;
    receipt.test = testProcess; receipt.sourcesStable = JSON.stringify(sourcePins()) === JSON.stringify(receipt.source);
    assert(!interrupted && !result.timedOut && !result.overflow, "Test interrupted, timed out or exceeded output bound");
    assert.equal(result.code, 0, "Carnival PostgreSQL tests failed"); assert.match(testOutput, /\b10 passed\b/);
    assert(receipt.sourcesStable, "Sources changed while tests ran"); receipt.evidence = testEvidence(); receipt.phase = "verified";
  } catch (error) {
    receipt.phase = "failed"; receipt.error = redact(error?.stack ?? error); process.exitCode = 1;
  } finally {
    try {
      await marker?.end({ timeout: 5 }); marker = undefined;
      if (receipt.databaseCreated) {
        assert(receipt.markerCreated && open && admin, "No completed ownership marker; retain DB and refuse DROP");
        await checkCluster(admin, "postgres");
        assert.equal((await admin`SELECT oid::text AS oid FROM pg_database WHERE datname=${database}`)[0]?.oid, receipt.databaseOid, "Owned database was replaced");
        const guard = open(database);
        try { receipt.cleanupSchemas = await checkMarker(guard); }
        finally { await guard.end({ timeout: 5 }); }
        // No FORCE, backend termination, wildcard, or existing application DB. Active leftovers cause a safe failure.
        const remaining = await admin`SELECT pid FROM pg_stat_activity WHERE datname=${database}`;
        assert.equal(remaining.length, 0, "Connections remain; refuse DROP and do not terminate them");
        await admin.unsafe(`DROP DATABASE "${database}"`);
        assert.equal((await admin`SELECT datname FROM pg_database WHERE datname=${database}`).length, 0); receipt.databaseRemoved = true;
      }
    } catch (error) { receipt.cleanupError = redact(error?.stack ?? error); receipt.phase = "failed"; process.exitCode = 1; }
    try { await admin?.end({ timeout: 5 }); }
    catch (error) { receipt.adminCloseError = redact(error?.message ?? error); receipt.phase = "failed"; process.exitCode = 1; }
    try {
      await pg?.stop();
      if (receipt.port) {
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!(await listening(receipt.port))) { receipt.portClosed = true; break; } await delay(100);
        }
        assert(receipt.portClosed, "Selected test port remains open; no unrelated process will be stopped");
      }
    } catch (error) { receipt.stopError = redact(error?.stack ?? error); receipt.phase = "failed"; process.exitCode = 1; }
    if (receipt.source) {
      try { receipt.sourcesStable = JSON.stringify(sourcePins()) === JSON.stringify(receipt.source); assert(receipt.sourcesStable); }
      catch (error) { receipt.sourceFreezeError = redact(error?.message ?? error); receipt.phase = "failed"; process.exitCode = 1; }
    }
    if (receipt.phase === "verified" && receipt.databaseRemoved && receipt.portClosed && receipt.stop?.code === 0 && !receipt.postgresLogError) receipt.phase = "passed";
    else { receipt.phase = "failed"; process.exitCode = 1; }
    receipt.exitCode = receipt.phase === "passed" ? 0 : 1; process.exitCode = receipt.exitCode;
    receipt.finishedAt = new Date().toISOString();
    receipt.cleanupCandidates = [{ path: cluster, retained: true, condition: "Only after receipt confirms owned server stopped and separate cleanup authorization" }];
    save(); process.off("SIGINT", signal); process.off("SIGTERM", signal);
    console.log(JSON.stringify({ receipt: join(directory, "receipt.json"), phase: receipt.phase, passed: receipt.evidence?.passed,
      databaseRemoved: receipt.databaseRemoved, portClosed: receipt.portClosed, clusterRetained: true }));
  }
}
await main();
