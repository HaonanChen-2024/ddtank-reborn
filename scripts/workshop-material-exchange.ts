#!/usr/bin/env node
// Local v1 recipe, not a reconstruction of undocumented official exchange rules. Installs configuration only.
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
const OWNER = "ddtank-workshop/local-material-exchange", ID = 100003;
type Row = Record<string, unknown>;
export interface ExchangeConfig { owner: string; version: 1; provenance: string; Active: Row; Award: Row; Materials: Row[] }
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function object(value: unknown): asserts value is Row {
  assert.ok(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, "expected a plain configuration object");
}
export function validateExchangeConfig(input: unknown): ExchangeConfig {
  object(input); assert.deepEqual(Object.keys(input).sort(), ["Active", "Award", "Materials", "owner", "provenance", "version"]);
  assert.equal(input.owner, OWNER); assert.equal(input.version, 1); assert.equal(input.provenance, "local-workshop-recipe-v1");
  object(input.Active); object(input.Award); const a = input.Active, award = input.Award;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(getTableColumns(game.Active)).sort());
  assert.deepEqual(Object.keys(award).sort(), Object.keys(getTableColumns(game.Active_Award)).sort());
  assert.equal(a.ActiveID, ID); assert.equal(a.HasKey, 6); assert.equal(a.IsOnly, 1); assert.equal(a.ActiveType, 1);
  for (const field of ["Type", "IconID"]) assert.equal(a[field], 0);
  for (const field of ["IsAdvance", "IsShow", "CanCreateCode"]) assert.equal(a[field], false);
  assert.equal(a.GoodsExchangeTypes, "11"); assert.equal(a.GoodsExchangeNum, "2"); assert.equal(a.limitType, "1"); assert.equal(a.limitValue, "1");
  for (const [field, max] of [["Title", 200], ["Description", 2000], ["Content", 2000], ["AwardContent", 2000], ["ActionTimeContent", 50]] as const)
    assert.ok(typeof a[field] === "string" && (a[field] as string).trim().length > 0 && (a[field] as string).length <= max, "invalid activity text: " + field);
  for (const field of ["StartDate", "EndDate"]) {
    assert.equal(typeof a[field], "string"); const date = new Date(a[field] as string);
    assert.ok(Number.isFinite(date.getTime()) && date.toISOString() === a[field], "explicit canonical UTC dates required");
  }
  const duration = Date.parse(a.EndDate as string) - Date.parse(a.StartDate as string);
  assert.ok(duration > 0 && duration <= 31 * 86400000, "a fixed window of at most 31 days is required");
  assert.equal(award.ID, ID); assert.equal(award.ActiveID, ID); assert.equal(award.ItemID, 11005); assert.equal(award.Count, 1);
  for (const field of Object.keys(award).filter(field => !["ID", "ActiveID", "ItemID", "Count"].includes(field))) assert.equal(award[field], 0);
  // Local v1: ItemType is the zero-based input slot, never a legacy material/reward discriminator.
  // IsBind=true is a version marker, not a requirement that the input item already be bound.
  assert.deepEqual(input.Materials, [{ ID, ActiveID: ID, TemplateID: 11001, ItemType: 0, ItemCount: 2, LimitValue: -1, IsBind: true, ValidDate: 0 }]);
  return structuredClone(input) as unknown as ExchangeConfig;
}
export function readExchangeConfig(path = join(repo, "research/activities/local-material-exchange.json")) {
  return validateExchangeConfig(JSON.parse(readFileSync(path, "utf8")));
}
export function planMaterialExchange(input: unknown = readExchangeConfig()) {
  const config = validateExchangeConfig(input);
  return { config, configSha256: hash(config), activeId: ID, awardId: ID, materialIds: [ID], plannedActive: 1, plannedAwards: 1, plannedMaterials: 1, grants: 0 };
}
function normalizeActive(row: Row): Row {
  const copy = { ...row };
  for (const field of ["StartDate", "EndDate"]) {
    const value = copy[field];
    copy[field] = value instanceof Date ? value.toISOString() : new Date(String(value) + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? "" : "Z")).toISOString();
  }
  return copy;
}
function publishJournal(path: string, intent: unknown) {
  mkdirSync(dirname(path), { recursive: true }); const fd = openSync(path, "wx", 0o600); let written = false;
  try { writeFileSync(fd, JSON.stringify(intent, null, 2) + "\n"); fsyncSync(fd); written = true; }
  finally { closeSync(fd); if (!written) unlinkSync(path); }
}
export function exchangeIntent(config: ExchangeConfig, binding: StarterBinding) {
  const plan = planMaterialExchange(config);
  return { phase: "prepared", configSha256: plan.configSha256, binding: structuredClone(binding), config: plan.config };
}
export function assertOwnedExchange(config: ExchangeConfig, binding: StarterBinding, journalPath: string, active: Row[], awards: Row[], materials: Row[]) {
  assert.ok(existsSync(journalPath), "coexisting exchange lacks its ownership journal");
  assert.deepEqual(JSON.parse(readFileSync(journalPath, "utf8")), exchangeIntent(config, binding), "exchange ownership, database binding or configuration differs");
  assert.deepEqual(active.map(normalizeActive), [config.Active], "owned exchange activity differs");
  assert.deepEqual(awards, [config.Award], "owned exchange reward differs");
  assert.deepEqual(materials, config.Materials, "owned exchange material whitelist differs");
}
export async function runMaterialExchange(h: DbHandle, options: {
  command: "verify" | "install"; binding: StarterBinding; journalPath: string; config?: ExchangeConfig; checkBinding?: () => void;
}) {
  const { command, binding, journalPath } = options;
  assert.ok(command === "verify" || command === "install");
  const plan = planMaterialExchange(options.config ?? readExchangeConfig()), intent = exchangeIntent(plan.config, binding);
  return h.db.transaction(async tx => {
    const th = { ...h, db: tx }; options.checkBinding?.();
    if (command === "verify") await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    else await tx.execute(sql`LOCK TABLE game."Active", game."Active_Award", game."Active_Convert_Item", app."EventClaims", player."Active_Number" IN SHARE ROW EXCLUSIVE MODE`);
    if (existsSync(journalPath)) assert.deepEqual(JSON.parse(readFileSync(journalPath, "utf8")), intent, "exchange ownership, database binding or configuration differs");
    const read = async () => ({
      active: await q<Row>(th, sql`SELECT * FROM game."Active" WHERE "ActiveID"=${ID}`),
      awards: await q<Row>(th, sql`SELECT * FROM game."Active_Award" WHERE "ActiveID"=${ID} OR "ID"=${ID} ORDER BY "ID"`),
      materials: await q<Row>(th, sql`SELECT * FROM game."Active_Convert_Item" WHERE "ActiveID"=${ID} OR "ID"=${ID} ORDER BY "ID"`),
    });
    const rows = await read();
    const claims = (await q1<{ count: number }>(th, sql`SELECT count(*)::int AS count FROM app."EventClaims" WHERE "Kind"='exchange' AND "Key"=${String(ID)}`))!.count;
    const wrongClaims = (await q1<{ count: number }>(th, sql`SELECT count(*)::int AS count FROM app."EventClaims" WHERE "Kind"='active' AND "Key"=${String(ID)}`))!.count;
    const codes = (await q1<{ count: number }>(th, sql`SELECT count(*)::int AS count FROM player."Active_Number" WHERE "ActiveID"=${ID}`))!.count;
    assert.equal(codes, 0, "unexpected activation codes preserved"); assert.equal(wrongClaims, 0, "unexpected free-activity claims preserved");
    const empty = !rows.active.length && !rows.awards.length && !rows.materials.length;
    if (!empty) assertOwnedExchange(plan.config, binding, journalPath, rows.active, rows.awards, rows.materials);
    else assert.equal(claims, 0, "claims without an installed exchange preserved");
    for (const [id, pic, kind] of [[11001, "zhuque1", 1], [11005, "xuanwu1", 2]] as const) {
      const template = await q1<Row>(th, sql`SELECT "CategoryID","Pic","Property1","Property3","Property4","MaxCount","NeedSex","NeedLevel","Level","Attack","Defence","Agility","Luck","CanUse","CanStrengthen","CanCompose" FROM game."Shop_Goods" WHERE "TemplateID"=${id}`);
      assert.deepEqual(template, { CategoryID: 11, Pic: pic, Property1: 1, Property3: kind, Property4: 10, MaxCount: 9999, NeedSex: 0, NeedLevel: 1, Level: 1, Attack: 0, Defence: 0, Agility: 0, Luck: 0, CanUse: false, CanStrengthen: false, CanCompose: false }, "original level-one stone differs: " + id);
    }
    const result = { installed: !empty, state: empty ? (existsSync(journalPath) ? "prepared" : "absent") : "installed", activeId: ID, insertedActive: 0, insertedAwards: 0, insertedMaterials: 0, claims, configSha256: plan.configSha256, cacheReloadRequired: false, playerDataWritten: false, clientAccepted: false };
    if (!empty || command === "verify") { options.checkBinding?.(); return result; }
    if (!existsSync(journalPath)) publishJournal(journalPath, intent);
    await tx.insert(game.Active).values({ ...plan.config.Active, StartDate: new Date(plan.config.Active.StartDate as string), EndDate: new Date(plan.config.Active.EndDate as string) } as typeof game.Active.$inferInsert);
    await tx.insert(game.Active_Award).values(plan.config.Award as typeof game.Active_Award.$inferInsert);
    await tx.insert(game.Active_Convert_Item).values(plan.config.Materials as typeof game.Active_Convert_Item.$inferInsert[]);
    const installed = await read(); assertOwnedExchange(plan.config, binding, journalPath, installed.active, installed.awards, installed.materials);
    options.checkBinding?.();
    return { ...result, installed: true, state: "installed", insertedActive: 1, insertedAwards: 1, insertedMaterials: 1, cacheReloadRequired: true };
  });
}
async function main(args: string[]) {
  if (args[0] === "--help") { console.log("tsx scripts/workshop-material-exchange.ts [plan|verify|install] [config.json] (default: offline plan)"); return; }
  const command = args[0] ?? "plan"; assert.ok(args.length <= 2 && ["plan", "verify", "install"].includes(command), "invalid exchange command");
  const config = readExchangeConfig(args[1]);
  if (command === "plan") { console.log(JSON.stringify(planMaterialExchange(config), null, 2)); return; }
  const runtime = resolve(repo, "../../runtime"), selected = readStarterSession(runtime), { binding } = selected;
  const settings = parseEnv(readFileSync(join(repo, ".env.workshop"), "utf8")); assert.ok(settings.PG_PASSWORD && settings.PG_PASSWORD.length >= 16);
  const h = await createDb(`postgres://postgres:${encodeURIComponent(settings.PG_PASSWORD)}@127.0.0.1:55432/${binding.databaseName}`, { max: 1 });
  try {
    if (command === "verify") await h.db.execute(sql`SET default_transaction_read_only=on`);
    const identity = await q1<{ databaseName: string; dataDirectory: string; port: number; timezone: string }>(h, sql`SELECT current_database() AS "databaseName", current_setting('data_directory') AS "dataDirectory", inet_server_port() AS port, current_setting('TimeZone') AS timezone`);
    assert.equal(identity?.databaseName, binding.databaseName); assert.equal(identity?.port, 55432); assert.equal(identity?.timezone, "UTC"); assert.equal(realpathSync(identity!.dataDirectory), binding.dataDirectory); selected.check();
    const result = await runMaterialExchange(h, { command: command as "verify" | "install", config, binding, journalPath: join(runtime, "activities", `local-material-exchange-${binding.databaseName}.json`), checkBinding: selected.check });
    selected.check(); console.log(JSON.stringify({ databaseName: binding.databaseName, ...result }));
  } finally { await h.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(() => { console.error("Material exchange refused or failed; inspect configuration, ownership journal and database readback. No credentials are logged."); process.exitCode = 1; });
