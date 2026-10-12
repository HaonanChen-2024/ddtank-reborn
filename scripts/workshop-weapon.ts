#!/usr/bin/env node
// Add one explicitly configured local weapon. No grants, resource writes, service restart or inferred physics.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { createDb, game, type DbHandle } from "../packages/db/src/index.js";
import { q, q1 } from "../apps/api/src/lib/db.js";
import { readStarterSession, type StarterBinding } from "./workshop-starter-activity.js";

const { sql, getTableColumns } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Row = Record<string, unknown>;
type Table = typeof game.Shop_Goods | typeof game.BallConfig | typeof game.Ball;
export interface WeaponPackage {
  schemaVersion: 1;
  mode: "local-compat";
  owner: string;
  metadata: Row;
  Shop_Goods: Row;
  BallConfig: Row;
  Ball: Row[];
}
interface WeaponJournal {
  schemaVersion: 1;
  phase: "prepared";
  packageSha256: string;
  binding: StarterBinding;
  package: WeaponPackage;
}

function object(value: unknown, label: string): asserts value is Row {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, label + " must be a plain object");
}
function jsonValue(value: unknown, depth = 0): void {
  assert.ok(depth <= 32, "metadata nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { assert.ok(Number.isFinite(value), "non-finite metadata number"); return; }
  if (Array.isArray(value)) { for (const entry of value) jsonValue(entry, depth + 1); return; }
  object(value, "metadata value"); for (const entry of Object.values(value)) jsonValue(entry, depth + 1);
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function intId(value: unknown, label: string): asserts value is number {
  assert.ok(typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647, label + " must be a positive int32");
}

// Require every actual DB column, including nullable/defaulted columns: no hidden defaults or property rewriting.
function validateRow(value: unknown, table: Table, label: string): asserts value is Row {
  object(value, label);
  const columns = getTableColumns(table);
  assert.deepEqual(Object.keys(value).sort(), Object.keys(columns).sort(), label + " must contain exactly the complete table row");
  for (const [key, column] of Object.entries(columns)) {
    const field: unknown = value[key];
    const name = label + "." + key;
    if (field === null) { assert.ok(!column.notNull, name + " cannot be null"); continue; }
    switch (column.dataType) {
      case "number":
        assert.ok(typeof field === "number" && Number.isFinite(field), name + " must be a finite number");
        if (column.columnType === "PgInteger") assert.ok(Number.isInteger(field) && field >= -2147483648 && field <= 2147483647, name + " must be int32");
        break;
      case "boolean": assert.equal(typeof field, "boolean", name + " must be boolean"); break;
      case "string":
        assert.equal(typeof field, "string", name + " must be string");
        if ("length" in column && typeof column.length === "number") assert.ok((field as string).length <= column.length, name + " is too long");
        break;
      case "date": {
        assert.equal(typeof field, "string", name + " must be an explicit UTC ISO timestamp or null");
        const date = new Date(field as string);
        assert.ok(Number.isFinite(date.getTime()) && date.toISOString() === field, name + " must be canonical UTC ISO");
        break;
      }
      default: assert.fail("unsupported column type: " + name);
    }
  }
}

export function validateWeaponPackage(input: unknown): WeaponPackage {
  object(input, "weapon package");
  assert.deepEqual(Object.keys(input).sort(), ["schemaVersion", "mode", "owner", "metadata", "Shop_Goods", "BallConfig", "Ball"].sort(), "unknown weapon package fields");
  assert.equal(input.schemaVersion, 1); assert.equal(input.mode, "local-compat");
  assert.ok(typeof input.owner === "string" && /^ddtank-workshop\/weapon\/[a-z0-9][a-z0-9-]{0,63}$/.test(input.owner), "invalid weapon owner");
  object(input.metadata, "metadata"); assert.ok(Object.keys(input.metadata).length > 0, "source metadata is required"); jsonValue(input.metadata);
  validateRow(input.Shop_Goods, game.Shop_Goods, "Shop_Goods");
  validateRow(input.BallConfig, game.BallConfig, "BallConfig");
  assert.equal(input.Shop_Goods.CategoryID, 7, "only weapon CategoryID 7 is supported");
  intId(input.Shop_Goods.TemplateID, "Shop_Goods.TemplateID");
  assert.equal(input.BallConfig.TemplateID, input.Shop_Goods.TemplateID, "BallConfig must target this weapon");
  assert.ok(Array.isArray(input.Ball) && input.Ball.length > 0 && input.Ball.length <= 4, "Ball must contain 1 to 4 complete rows");
  const ids = new Set<number>();
  for (const ball of input.Ball) {
    validateRow(ball, game.Ball, "Ball"); intId(ball.ID, "Ball.ID");
    assert.ok(!ids.has(ball.ID), "duplicate Ball.ID"); ids.add(ball.ID);
  }
  const referenced = new Set<number>();
  for (const key of ["Common", "CommonAddWound", "CommonMultiBall", "Special"]) {
    const id: unknown = input.BallConfig[key]; intId(id, "BallConfig." + key);
    assert.ok(ids.has(id), "BallConfig." + key + " must reference a Ball in this package"); referenced.add(id);
  }
  assert.equal(referenced.size, ids.size, "unreferenced Ball rows are not supported");
  // Detach from a caller that might mutate the input while the transaction is waiting for its lock.
  return JSON.parse(JSON.stringify(input)) as WeaponPackage;
}

export function planWeaponInstall(input: unknown) {
  const config = validateWeaponPackage(input);
  config.Ball.sort((a, b) => Number(a.ID) - Number(b.ID));
  return { schemaVersion: 1 as const, mode: config.mode, owner: config.owner, packageSha256: hash(config),
    templateId: Number(config.Shop_Goods.TemplateID), ballIds: config.Ball.map(row => Number(row.ID)),
    counts: { Shop_Goods: 1, BallConfig: 1, Ball: config.Ball.length }, config,
    databaseConnected: false, installed: false, resourcesAccepted: false, fightAssetsLoaded: false };
}

function readJournal(path: string): WeaponJournal | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as WeaponJournal : null;
}
function publishJournal(path: string, journal: WeaponJournal): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600); let written = false;
  try { writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n"); fsyncSync(fd); written = true; }
  finally { closeSync(fd); if (!written) unlinkSync(path); }
}

export async function runWeaponInstall(h: DbHandle, options: {
  command: "verify" | "install"; config: unknown; binding: StarterBinding; journalPath: string; checkBinding?: () => void;
}) {
  assert.ok(options.command === "verify" || options.command === "install", "invalid weapon command");
  const plan = planWeaponInstall(options.config), { config, templateId, ballIds, packageSha256 } = plan;
  object(options.binding, "binding");
  assert.ok(typeof options.binding.databaseName === "string" && options.binding.databaseName.length > 0 && typeof options.binding.dataDirectory === "string" && options.binding.dataDirectory.length > 0, "database binding is required");
  const binding = { ...options.binding };
  let journalPublished = false;
  const result = await h.db.transaction(async tx => {
    const th = { ...h, db: tx };
    options.checkBinding?.();
    if (options.command === "verify") await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    else await tx.execute(sql`LOCK TABLE game."Shop_Goods", game."BallConfig", game."Ball" IN SHARE ROW EXCLUSIVE MODE`);
    const existing = {
      Shop_Goods: await q<Row>(th, sql`SELECT * FROM game."Shop_Goods" WHERE "TemplateID"=${templateId}`),
      BallConfig: await q<Row>(th, sql`SELECT * FROM game."BallConfig" WHERE "TemplateID"=${templateId}`),
      Ball: await q<Row>(th, sql`SELECT * FROM game."Ball" WHERE "ID" IN (${sql.join(ballIds.map(id => sql`${id}`), sql`,`)}) ORDER BY "ID"`),
    };
    const journal = readJournal(options.journalPath);
    if (journal) {
      assert.equal(journal.schemaVersion, 1); assert.equal(journal.phase, "prepared", "unknown weapon journal phase");
      assert.deepEqual(journal.binding, binding, "weapon journal belongs to a different database");
      assert.equal(journal.packageSha256, packageSha256, "weapon package differs from prepared ownership journal");
      assert.equal(planWeaponInstall(journal.package).packageSha256, packageSha256, "weapon journal package differs");
    }
    const empty = existing.Shop_Goods.length === 0 && existing.BallConfig.length === 0 && existing.Ball.length === 0;
    if (!empty) {
      assert.ok(journal, "weapon target keys are occupied without an ownership journal");
      assert.equal(existing.Shop_Goods.length, 1, "partial weapon installation preserved");
      assert.equal(existing.BallConfig.length, 1, "partial weapon installation preserved");
      assert.equal(existing.Ball.length, ballIds.length, "partial weapon installation preserved");
      assert.equal(canonical(existing.Shop_Goods[0]), canonical(config.Shop_Goods), "installed Shop_Goods differs; preserved");
      assert.equal(canonical(existing.BallConfig[0]), canonical(config.BallConfig), "installed BallConfig differs; preserved");
      assert.equal(canonical(existing.Ball), canonical(config.Ball), "installed Ball rows differ; preserved");
      options.checkBinding?.();
      return { status: "installed" as const, installed: true, inserted: { Shop_Goods: 0, BallConfig: 0, Ball: 0 } };
    }
    // An absent Ball row can still be referenced by another weapon; do not silently change that weapon.
    const references = await q<Row>(th, sql`SELECT "TemplateID" FROM game."BallConfig" WHERE
      "Common" IN (${sql.join(ballIds.map(id => sql`${id}`), sql`,`)}) OR
      "CommonAddWound" IN (${sql.join(ballIds.map(id => sql`${id}`), sql`,`)}) OR
      "CommonMultiBall" IN (${sql.join(ballIds.map(id => sql`${id}`), sql`,`)}) OR
      "Special" IN (${sql.join(ballIds.map(id => sql`${id}`), sql`,`)})`);
    assert.equal(references.length, 0, "new Ball IDs are already referenced by another weapon");
    if (options.command === "verify") {
      options.checkBinding?.();
      return { status: journal ? "prepared" as const : "ready" as const, installed: false, inserted: { Shop_Goods: 0, BallConfig: 0, Ball: 0 } };
    }
    // A prepared file is an ownership intent, never a COMMIT receipt. If this transaction fails, a retry may
    // proceed only when all three target sets are empty; partial or changed rows are always refused above.
    if (!journal) {
      publishJournal(options.journalPath, { schemaVersion: 1, phase: "prepared", binding, packageSha256, package: config });
      journalPublished = true;
    }
    const item = { ...config.Shop_Goods, AddTime: config.Shop_Goods.AddTime === null ? null : new Date(String(config.Shop_Goods.AddTime)) };
    const [createdItem] = await tx.insert(game.Shop_Goods).values(item as typeof game.Shop_Goods.$inferInsert).returning();
    const [createdConfig] = await tx.insert(game.BallConfig).values(config.BallConfig as typeof game.BallConfig.$inferInsert).returning();
    const createdBalls = await tx.insert(game.Ball).values(config.Ball as (typeof game.Ball.$inferInsert)[]).returning();
    assert.equal(canonical(createdItem), canonical(config.Shop_Goods), "inserted Shop_Goods was changed");
    assert.equal(canonical(createdConfig), canonical(config.BallConfig), "inserted BallConfig was changed");
    createdBalls.sort((a, b) => a.ID - b.ID);
    assert.equal(canonical(createdBalls), canonical(config.Ball), "inserted Ball rows were changed");
    options.checkBinding?.();
    return { status: "installed" as const, installed: true, inserted: { ...plan.counts } };
  });
  return { ...result, packageSha256, templateId, ballIds, journalPublished, originalRowsPreserved: true,
    playerDataWritten: false, resourcesWritten: false, fightAssetsLoaded: false, cacheReloadRequired: result.inserted.Shop_Goods > 0,
    fightReloadRequired: result.inserted.Shop_Goods > 0, clientAccepted: false };
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("tsx scripts/workshop-weapon.ts [plan|verify|install] <package.json>\nplan is offline. verify/install bind the current local Workshop session. install only inserts the three owned template tables; it does not prepare fight assets, upload resources, grant items or restart services."); return;
  }
  const command = args.length === 1 ? "plan" : args[0], file = args.length === 1 ? args[0] : args[1];
  assert.ok(args.length >= 1 && args.length <= 2 && ["plan", "verify", "install"].includes(command ?? "") && file, "usage: workshop-weapon.ts [plan|verify|install] <package.json>");
  const plan = planWeaponInstall(JSON.parse(readFileSync(resolve(file), "utf8")));
  if (command === "plan") { console.log(JSON.stringify(plan)); return; }
  const runtime = resolve(repo, "../../runtime"), selected = readStarterSession(runtime), { binding } = selected;
  const settings = parseEnv(readFileSync(join(repo, ".env.workshop"), "utf8"));
  assert.ok(settings.PG_PASSWORD && settings.PG_PASSWORD.length >= 16, "missing local PG password");
  const h = await createDb(`postgres://postgres:${encodeURIComponent(settings.PG_PASSWORD)}@127.0.0.1:55432/${binding.databaseName}`, { max: 1 });
  try {
    if (command === "verify") await h.db.execute(sql`SET default_transaction_read_only=on`);
    const identity = await q1<{ databaseName: string; dataDirectory: string; port: number; timezone: string }>(h, sql`SELECT current_database() AS "databaseName", current_setting('data_directory') AS "dataDirectory", inet_server_port() AS port, current_setting('TimeZone') AS timezone`);
    assert.equal(identity?.databaseName, binding.databaseName); assert.equal(identity?.port, 55432); assert.equal(identity?.timezone, "UTC");
    assert.equal(realpathSync(identity!.dataDirectory), binding.dataDirectory); selected.check();
    const slug = plan.owner.split("/").at(-1)!;
    const result = await runWeaponInstall(h, { command: command as "verify" | "install", config: plan.config, binding,
      journalPath: join(runtime, "weapons", `${slug}-${binding.databaseName}.json`), checkBinding: selected.check });
    selected.check(); console.log(JSON.stringify({ databaseName: binding.databaseName, ...result }));
  } finally { await h.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(() => { console.error("Weapon package refused or installation failed. No grant, resource upload or restart was attempted; inspect the package, ownership journal and database readback before retrying. No credentials are logged."); process.exitCode = 1; });
