#!/usr/bin/env node
// Opt-in native PG validation. Only postgres (catalog administration) and one NEW template0 DB are opened.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

assert(process.argv.includes("--execute"), "Explicit --execute required");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), runtime = resolve(repo, "../../runtime");
const postgres = createRequire(join(repo, "packages/db/package.json"))("postgres");
const settings = parseEnv(readFileSync(join(repo, ".env.workshop"), "utf8"));
assert(settings.PG_PASSWORD?.length >= 16, "Local PG password unavailable");
const token = randomUUID(), database = `workshop_native_exchange_${token.replaceAll("-", "")}`;
assert.match(database, /^workshop_native_exchange_[a-f0-9]{32}$/);
const directory = join(runtime, "reference-activities-completion-20261014", `native-exchange-postgres-${token}`);
mkdirSync(directory, { recursive: false });
const urlFor = name => {
  assert(name === "postgres" || name === database, "Refuse existing application databases");
  return `postgres://postgres:${encodeURIComponent(settings.PG_PASSWORD)}@127.0.0.1:55432/${name}`;
};
const redact = value => [settings.PG_PASSWORD, encodeURIComponent(settings.PG_PASSWORD)].reduce((s, secret) => s.replaceAll(secret, "[redacted]"), String(value));
const sources = ['apps/game/test/native-exchange-postgres.test.ts','apps/game/test/native-exchange-fixture.ts','apps/game/test/activity-exchange-native.test.ts','apps/game/src/game/activity-exchange-native.ts','apps/game/src/admin/http.ts','apps/game/src/server.ts','apps/game/src/session/client.ts','apps/api/src/activities/service.ts','apps/api/src/activities/types.ts','apps/api/src/activities/exchange-native.ts','apps/api/test/exchange-native-integration.test.ts','scripts/workshop-native-exchange-postgres.mjs'];
const hashes = () => Object.fromEntries(sources.map(path => [path, createHash("sha256").update(readFileSync(join(repo, path))).digest("hex")]));
const receipt = { version: 1, database, token, startedAt: new Date().toISOString(), phase: "prepared", source: hashes(),
  scope: "Fresh template0 database; real game/API connections plus independent lock/observation connections", liveDatabaseOpened: false, liveServiceStarted: false, databaseRemoved: false };
const save = () => writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
save();
console.log(JSON.stringify({ receipt: join(directory,"receipt.json"), phase: "prepared", database }));
const open = name => postgres(urlFor(name), { max: 1, connect_timeout: 5, idle_timeout: 10, onnotice: () => {}, connection: { TimeZone: "UTC", application_name: "workshop_native_activity_test_admin" } });
const admin = open("postgres");
let created = false, marker;
try {
  const [identity] = await admin`SELECT current_database() AS database, inet_server_port() AS port, current_setting('data_directory') AS directory, current_setting('server_version') AS version`;
  assert.equal(identity.database, "postgres"); assert.equal(identity.port, 55432);
  assert.equal(realpathSync(identity.directory), realpathSync(join(runtime, "data/postgres")), "Unexpected native PG cluster");
  receipt.serverVersion = identity.version;
  assert.equal((await admin`SELECT datname FROM pg_database WHERE datname=${database}`).length, 0, "Test database already exists");
  await admin.unsafe(`CREATE DATABASE "${database}" TEMPLATE template0`); created = true;
  receipt.phase = "created"; save();
  marker = open(database);
  const [testIdentity] = await marker`SELECT current_database() AS database`;
  assert.equal(testIdentity.database, database);
  await marker`CREATE TABLE public."WorkshopNativeActivityTest" (token text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`;
  await marker`INSERT INTO public."WorkshopNativeActivityTest" (token) VALUES (${token})`;
  await marker.end({ timeout: 5 }); marker = undefined;
  const testUrl = urlFor(database);
  const result = await new Promise((complete, reject) => {
    const child = spawn(process.execPath, [join(repo,"node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", "test/native-exchange-postgres.test.ts"], {
      cwd: join(repo, "apps/game"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TZ: "UTC", WORKSHOP_NATIVE_EXCHANGE_URL: testUrl, WORKSHOP_NATIVE_EXCHANGE_TOKEN: token, WORKSHOP_NATIVE_EXCHANGE_OUTPUT: directory },
    });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    child.once("error", reject); child.once("exit", code => complete({ code, output: redact(output) }));
  });
  writeFileSync(join(directory, "test.log"), result.output);
  receipt.exitCode = result.code; receipt.phase = "tested"; save();
  console.log(result.output); assert.equal(result.code, 0, "Native activity tests failed");
  assert.deepEqual(hashes(), receipt.source, "Sources changed while native tests ran; repeat against stable sources");
  const evidence = JSON.parse(readFileSync(join(directory, "test-evidence.json"), "utf8"));
  assert.equal(evidence.database, database); assert.equal(evidence.token, token);
  assert.equal(evidence.passed, 8); assert.equal(evidence.closedConnections, true);
  receipt.passed = evidence.passed; receipt.connectionPids = evidence.connectionPids; receipt.lockScenarios = evidence.scenarios.length;
  receipt.phase = "passed";
} catch (error) {
  receipt.phase = "failed"; receipt.error = redact(error?.message ?? error); process.exitCode = 1;
} finally {
  try {
    if (marker) await marker.end({ timeout: 5 });
    if (created) {
    // The exact database was created by this process. No wildcard, existing DB, FORCE, or other connection termination.
    assert.match(database, /^workshop_native_exchange_[a-f0-9]{32}$/);
    const guard = open(database);
    try {
      const [identity] = await guard`SELECT current_database() AS database`;
      assert.equal(identity.database, database);
      const rows = await guard`SELECT token FROM public."WorkshopNativeActivityTest"`;
      assert.deepEqual(rows.map(row => row.token), [token], "Test ownership marker mismatch; refuse cleanup");
    } finally { await guard.end({ timeout: 5 }); }
    await admin.unsafe(`DROP DATABASE "${database}"`);
    assert.equal((await admin`SELECT datname FROM pg_database WHERE datname=${database}`).length, 0);
      receipt.databaseRemoved = true;
    }
  } catch(error) {
    receipt.cleanupError = redact(error?.message ?? error); process.exitCode = 1;
  } finally {
    await admin.end({ timeout: 5 }); receipt.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ receipt: join(directory, "receipt.json"), phase: receipt.phase, passed: receipt.passed, databaseRemoved: receipt.databaseRemoved }));
}
