#!/usr/bin/env node
// Consistent native Postgres backups; verification always restores into a NEW database.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(repo, "../../runtime");
let config;
function nativeConfig() {
  if (!config) {
    const settings = parseEnv(readFileSync(join(repo, ".env.workshop"), "utf8"));
    assert.ok(settings.PG_PASSWORD?.length >= 16, "missing local PG password");
    config = { settings, bin: resolve(repo, settings.PGTOOLS_DIR ?? join(runtime, "tools/postgres-tools/bin")),
      childEnv: { ...process.env, TZ: "UTC", PGHOST: "127.0.0.1", PGPORT: "55432", PGUSER: "postgres", PGPASSWORD: settings.PG_PASSWORD, PGCONNECT_TIMEOUT: "5" } };
  }
  return config;
}

function native(tool, args) {
  const { bin, childEnv } = nativeConfig();
  assert.ok(existsSync(join(bin, tool + ".exe")), `missing Postgres client tool: ${tool}`);
  return new Promise((res, rej) => {
    const child = spawn(join(bin, tool + ".exe"), args, { env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", b => { output += b; });
    child.stderr.on("data", b => { error += b; });
    child.once("error", rej);
    child.once("exit", code => code === 0 ? res(output.trim()) : rej(new Error(`${tool} failed (${code}): ${error.trim()}`)));
  });
}
const checksum = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const tables = { accounts: 'member."Accounts"', players: 'player."Sys_Users_Detail"', goods: 'player."Sys_Users_Goods"', templates: 'game."Shop_Goods"', shop: 'game."Shop"', maps: 'game."Game_Map"' };
export function validateDatabaseName(database) {
  assert.ok(database === "ddtank" || /^workshop_restore_\d+_[a-f0-9]{6}$/.test(database), "invalid Workshop database name");
  return database;
}
function validateFingerprint(value) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), Object.keys(tables).sort(), "invalid backup fingerprint tables");
  for (const row of Object.values(value)) assert.ok(Number.isSafeInteger(row.count) && row.count >= 0 && /^[a-f0-9]{32}$/.test(row.digest), "invalid backup fingerprint");
}
export function readBackup(manifestPath) {
  assert.ok(manifestPath, "requires a backup .dump.json path");
  const path = realpathSync(resolve(manifestPath));
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(typeof manifest.dump === "string" && basename(manifest.dump) === manifest.dump && manifest.dump.endsWith(".dump"), "invalid dump filename");
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/, "invalid backup checksum");
  validateFingerprint(manifest.fingerprint);
  const dump = join(dirname(path), manifest.dump);
  assert.equal(checksum(dump), manifest.sha256, "backup checksum mismatch");
  return { path, dump, manifest };
}
export function readRestoredBackup(manifestPath) {
  const backup = readBackup(manifestPath);
  const proof = readFileSync(backup.path + ".restore.json");
  const restored = JSON.parse(proof.toString("utf8"));
  assert.equal(restored.ok, true, "restore verification did not succeed");
  assert.equal(restored.originalDatabaseUntouched, true, "restore must have preserved the original database");
  validateDatabaseName(restored.database);
  assert.notEqual(restored.database, "ddtank", "restored activation cannot select the original database");
  assert.equal(restored.dumpSha256, backup.manifest.sha256, "restore record belongs to another dump");
  assert.deepEqual(restored.fingerprint, backup.manifest.fingerprint, "restore record fingerprint differs from backup");
  return { ...backup, database: restored.database, restoreProofSha256: createHash("sha256").update(proof).digest("hex") };
}
export function assertRestoredFingerprint(restored, actual) {
  assert.deepEqual(actual, restored.manifest.fingerprint, "restored database changed or does not match the verified backup");
}
export async function databaseIdentity(database) {
  validateDatabaseName(database);
  const actual = await native("psql", ["--dbname", database, "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", "SELECT current_database()"]);
  assert.equal(actual, database, "connected database identity differs from selection");
  return actual;
}
export async function confirmRestoredDatabase(restored, dataDir, bindingPath, readIdentity = databaseIdentity, readFingerprint = fingerprint) {
  const binding = { databaseName: restored.database, pgDir: realpathSync(dataDir), manifestPath: restored.path, dumpSha256: restored.manifest.sha256, restoreProofSha256: restored.restoreProofSha256 };
  const continued = existsSync(bindingPath);
  if (continued) assert.deepEqual(JSON.parse(readFileSync(bindingPath, "utf8")), binding, "restored database binding differs; refusing to reuse it");
  assert.equal(await readIdentity(restored.database), restored.database, "connected database identity differs from selection");
  if (!continued) {
    assertRestoredFingerprint(restored, await readFingerprint(restored.database));
    mkdirSync(dirname(bindingPath), { recursive: true });
    writeFileSync(bindingPath, JSON.stringify(binding, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  return { databaseName: restored.database, continued };
}
export function selectedDatabase(session) {
  if (!session) return "ddtank";
  assert.ok(Number.isInteger(session.managerPid) && session.managerPid > 0, "invalid Workshop session");
  try { process.kill(session.managerPid, 0); } catch { throw new Error("Workshop session is not running; refusing an ambiguous backup source"); }
  return validateDatabaseName(session.databaseName ?? "ddtank");
}
export async function fingerprint(database) {
  validateDatabaseName(database);
  // Only counts/digests leave Postgres; password hashes and player rows are never printed.
  const pairs = [];
  for (const [name, table] of Object.entries(tables)) {
    pairs.push(`'${name}', (SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(v, E'\\n' ORDER BY v),''))) FROM (SELECT row_to_json(t)::text AS v FROM ${table} t) q)`);
  }
  return JSON.parse(await native("psql", ["--dbname", database, "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", `SELECT json_build_object(${pairs.join(",")})`]));
}
async function backup() {
  const sessionFile = join(runtime, "workshop-session.json");
  const session = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, "utf8")) : null;
  const database = selectedDatabase(session);
  const { settings } = nativeConfig();
  const dir = join(runtime, "backups");
  mkdirSync(dir, { recursive: true });
  const name = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex");
  const file = join(dir, name + ".dump");
  assert.ok(!existsSync(file));
  const before = await fingerprint(database);
  await native("pg_dump", ["--dbname", database, "--format=custom", "--no-owner", "--no-acl", "--file", file]);
  const after = await fingerprint(database);
  assert.deepEqual(after, before, "data changed during backup; repeat when project clients are idle");
  const manifest = { createdAt: new Date().toISOString(), sourceDatabase: database, dump: basename(file), sha256: checksum(file), fingerprint: before, uploads: settings.UPLOAD_DIR, clientOverlay: settings.FLASH_OVERLAY_DIR };
  writeFileSync(file + ".json", JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, databaseName: database, manifest: file + ".json", fingerprint: before }, null, 2));
}
async function verify(manifestPath) {
  const { path, dump, manifest } = readBackup(manifestPath);
  const database = "workshop_restore_" + Date.now() + "_" + randomBytes(3).toString("hex");
  // createdb fails on collision. Never --clean, DROP, or restore into ddtank.
  await native("createdb", [database]);
  await native("pg_restore", ["--dbname", database, "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", dump]);
  const restored = await fingerprint(database);
  assert.deepEqual(restored, manifest.fingerprint, "restored rows differ from backup");
  const result = { ok: true, checkedAt: new Date().toISOString(), database, sourceDatabase: manifest.sourceDatabase ?? "ddtank", dumpSha256: manifest.sha256, fingerprint: restored, originalDatabaseUntouched: true };
  writeFileSync(path + ".restore.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  if (process.argv[2] === "backup") await backup();
  else if (process.argv[2] === "verify") await verify(process.argv[3]);
  else throw new Error("usage: node scripts/workshop-backup.mjs backup|verify <backup.dump.json>");
} catch (error) { console.error(error.message); process.exitCode = 1; }
