#!/usr/bin/env node
// Consistent native Postgres backups; verification always restores into a NEW database.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(repo, "../../runtime");
const settings = parseEnv(readFileSync(join(repo, ".env.workshop"), "utf8"));
assert.ok(settings.PG_PASSWORD?.length >= 16, "missing local PG password");
const bin = resolve(settings.PGTOOLS_DIR ?? join(runtime, "tools/postgres-tools/bin"));
for (const tool of ["psql", "pg_dump", "pg_restore", "createdb"]) assert.ok(existsSync(join(bin, tool + ".exe")), `missing Postgres client tool: ${tool}`);
const childEnv = { ...process.env, TZ: "UTC", PGHOST: "127.0.0.1", PGPORT: "55432", PGUSER: "postgres", PGPASSWORD: settings.PG_PASSWORD, PGCONNECT_TIMEOUT: "5" };

function native(tool, args) {
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
async function fingerprint(database) {
  // Only counts/digests leave Postgres; password hashes and player rows are never printed.
  const pairs = [];
  for (const [name, table] of Object.entries(tables)) {
    pairs.push(`'${name}', (SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(v, E'\\n' ORDER BY v),''))) FROM (SELECT row_to_json(t)::text AS v FROM ${table} t) q)`);
  }
  return JSON.parse(await native("psql", ["--dbname", database, "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", `SELECT json_build_object(${pairs.join(",")})`]));
}
async function backup() {
  const dir = join(runtime, "backups");
  mkdirSync(dir, { recursive: true });
  const name = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex");
  const file = join(dir, name + ".dump");
  assert.ok(!existsSync(file));
  const before = await fingerprint("ddtank");
  await native("pg_dump", ["--dbname", "ddtank", "--format=custom", "--no-owner", "--no-acl", "--file", file]);
  const after = await fingerprint("ddtank");
  assert.deepEqual(after, before, "data changed during backup; repeat when project clients are idle");
  const manifest = { createdAt: new Date().toISOString(), dump: basename(file), sha256: checksum(file), fingerprint: before, uploads: settings.UPLOAD_DIR, clientOverlay: settings.FLASH_OVERLAY_DIR };
  writeFileSync(file + ".json", JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, manifest: file + ".json", fingerprint: before }, null, 2));
}
async function verify(manifestPath) {
  assert.ok(manifestPath, "verify requires a backup .dump.json path");
  const path = resolve(manifestPath);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(basename(manifest.dump), manifest.dump, "invalid dump filename");
  const dump = join(dirname(path), manifest.dump);
  assert.equal(checksum(dump), manifest.sha256, "backup checksum mismatch");
  const database = "workshop_restore_" + Date.now() + "_" + randomBytes(3).toString("hex");
  // createdb fails on collision. Never --clean, DROP, or restore into ddtank.
  await native("createdb", [database]);
  await native("pg_restore", ["--dbname", database, "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", dump]);
  const restored = await fingerprint(database);
  assert.deepEqual(restored, manifest.fingerprint, "restored rows differ from backup");
  const result = { ok: true, checkedAt: new Date().toISOString(), database, dumpSha256: manifest.sha256, fingerprint: restored, originalDatabaseUntouched: true };
  writeFileSync(path + ".restore.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
try {
  if (process.argv[2] === "backup") await backup();
  else if (process.argv[2] === "verify") await verify(process.argv[3]);
  else throw new Error("usage: node scripts/workshop-backup.mjs backup|verify <backup.dump.json>");
} catch (error) { console.error(error.message); process.exitCode = 1; }
