#!/usr/bin/env node
// One dated free calendar activity. Installation never grants rewards or resets claims.
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
const OWNER = "ddtank-workshop/local-festival", ACTIVE_ID = 100002, AWARD_ID = 100002;
type Row = Record<string, unknown>;
export interface FestivalConfig { owner: string; version: 1; Active: Row; Award: Row }
interface Journal { phase: "prepared"; configSha256: string; binding: StarterBinding; config: FestivalConfig }
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

function object(value: unknown): asserts value is Row {
  assert.ok(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, "expected plain configuration object");
}
export function validateFestivalConfig(input: unknown): FestivalConfig {
  object(input); assert.deepEqual(Object.keys(input).sort(), ["Active", "Award", "owner", "version"]);
  assert.equal(input.owner, OWNER); assert.equal(input.version, 1);
  object(input.Active); object(input.Award); const a = input.Active, award = input.Award;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(getTableColumns(game.Active)).sort());
  assert.deepEqual(Object.keys(award).sort(), Object.keys(getTableColumns(game.Active_Award)).sort());
  assert.equal(a.ActiveID, ACTIVE_ID); assert.equal(a.HasKey, 3); assert.equal(a.IsOnly, 1);
  for (const key of ["Type", "ActiveType", "IconID"]) assert.equal(a[key], 0);
  for (const key of ["IsAdvance", "IsShow", "CanCreateCode"]) assert.equal(a[key], false);
  for (const key of ["GoodsExchangeTypes", "GoodsExchangeNum", "limitType", "limitValue"]) assert.equal(a[key], "");
  for (const [key, max] of [["Title", 200], ["Description", 2000], ["Content", 2000], ["AwardContent", 2000], ["ActionTimeContent", 50]] as const)
    assert.ok(typeof a[key] === "string" && (a[key] as string).trim().length > 0 && (a[key] as string).length <= max, "invalid activity text: " + key);
  for (const key of ["StartDate", "EndDate"]) {
    const value = a[key]; assert.equal(typeof value, "string", "explicit UTC dates required");
    const date = new Date(value as string); assert.ok(Number.isFinite(date.getTime()) && date.toISOString() === value, "canonical UTC dates required");
  }
  const duration = Date.parse(a.EndDate as string) - Date.parse(a.StartDate as string);
  assert.ok(duration > 0 && duration <= 31 * 86400000, "festival must have a fixed window of at most 31 days");
  assert.equal(award.ID, AWARD_ID); assert.equal(award.ActiveID, ACTIVE_ID);
  assert.equal(award.ItemID, 11904); assert.equal(award.Count, 1);
  for (const key of Object.keys(award).filter(key => !["ID", "ActiveID", "ItemID", "Count"].includes(key)))
    assert.equal(award[key], 0, "only the ordinary free potion is supported");
  return structuredClone(input) as unknown as FestivalConfig;
}
export function readFestivalConfig(path = join(repo, "research/activities/local-festival.json")) {
  return validateFestivalConfig(JSON.parse(readFileSync(path, "utf8")));
}
export function planFestivalActivity(input: unknown = readFestivalConfig()) {
  const config = validateFestivalConfig(input);
  return { config, configSha256: hash(config), activeId: ACTIVE_ID, awardId: AWARD_ID,
    plannedActive: 1, plannedAwards: 1, rewardTemplateId: 11904, grants: 0, cacheReloadRequiredAfterInstall: true };
}
function normalizeActive(row: Row): Row {
  const copy = { ...row };
  for (const key of ["StartDate", "EndDate"]) {
    const value = copy[key];
    copy[key] = value instanceof Date ? value.toISOString() : new Date(String(value) + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? "" : "Z")).toISOString();
  }
  return copy;
}
function publishJournal(path: string, journal: Journal) {
  mkdirSync(dirname(path), { recursive: true }); const fd = openSync(path, "wx", 0o600); let written = false;
  try { writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n"); fsyncSync(fd); written = true; }
  finally { closeSync(fd); if (!written) unlinkSync(path); }
}

// Tests supply an isolated PGlite DB. The CLI below checks the existing native Workshop session.
export async function runFestivalActivity(h: DbHandle, options: {
  command: "verify" | "install"; binding: StarterBinding; journalPath: string;
  config?: FestivalConfig; checkBinding?: () => void;
}) {
  const { command, binding, journalPath } = options;
  assert.ok(command === "verify" || command === "install");
  const plan = planFestivalActivity(options.config ?? readFestivalConfig());
  const intent: Journal = { phase: "prepared", configSha256: plan.configSha256, binding: structuredClone(binding), config: plan.config };
  return h.db.transaction(async tx => {
    const th = { ...h, db: tx }; options.checkBinding?.();
    if (command === "verify") await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    else await tx.execute(sql`LOCK TABLE game."Active", game."Active_Award", app."EventClaims", player."Active_Number" IN SHARE ROW EXCLUSIVE MODE`);
    const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) as Journal : null;
    if (journal) assert.equal(canonical(journal), canonical(intent), "festival ownership, database binding or configuration differs");
    const active = await q<Row>(th, sql`SELECT * FROM game."Active" WHERE "ActiveID"=${ACTIVE_ID}`);
    const awards = await q<Row>(th, sql`SELECT * FROM game."Active_Award" WHERE "ActiveID"=${ACTIVE_ID} OR "ID"=${AWARD_ID}`);
    const claims = (await q1<{ count: number }>(th, sql`SELECT count(*)::int AS count FROM app."EventClaims" WHERE "Kind"='active' AND "Key"=${String(ACTIVE_ID)}`))!.count;
    const codes = (await q1<{ count: number }>(th, sql`SELECT count(*)::int AS count FROM player."Active_Number" WHERE "ActiveID"=${ACTIVE_ID}`))!.count;
    assert.equal(codes, 0, "unexpected activation codes preserved");
    const empty = active.length === 0 && awards.length === 0;
    if (!empty) {
      assert.ok(journal, "unowned activity or reward collision preserved");
      assert.equal(active.length, 1, "incomplete or conflicting activity preserved");
      assert.equal(awards.length, 1, "incomplete or conflicting reward preserved");
      assert.deepEqual(normalizeActive(active[0]), plan.config.Active, "owned activity differs");
      assert.deepEqual(awards[0], plan.config.Award, "owned reward differs");
    } else assert.equal(claims, 0, "claims without an installed festival preserved");
    const template = await q1<Row>(th, sql`SELECT "CategoryID","Property1","Property2","MaxCount","NeedSex","NeedLevel","Level","Attack","Defence","Agility","Luck","CanUse","CanStrengthen","CanCompose" FROM game."Shop_Goods" WHERE "TemplateID"=11904`);
    assert.deepEqual(template, { CategoryID: 11, Property1: 21, Property2: 10000, MaxCount: 1, NeedSex: 0, NeedLevel: 1, Level: 1, Attack: 0, Defence: 0, Agility: 0, Luck: 0, CanUse: true, CanStrengthen: false, CanCompose: false }, "11904 must remain the existing ordinary experience potion");
    const result = { installed: !empty, state: empty ? (journal ? "prepared" : "absent") : "installed", activeId: ACTIVE_ID, awardId: AWARD_ID,
      insertedActive: 0, insertedAwards: 0, claims, configSha256: plan.configSha256, cacheReloadRequired: false, playerDataWritten: false, clientAccepted: false };
    if (!empty || command === "verify") { options.checkBinding?.(); return result; }
    // A prepared file is an intent only. Every retry reads both DB rows and accepts exact/all-empty state only.
    if (!journal) publishJournal(journalPath, intent);
    await tx.insert(game.Active).values({ ...plan.config.Active, StartDate: new Date(plan.config.Active.StartDate as string), EndDate: new Date(plan.config.Active.EndDate as string) } as typeof game.Active.$inferInsert);
    await tx.insert(game.Active_Award).values(plan.config.Award as typeof game.Active_Award.$inferInsert);
    assert.deepEqual(normalizeActive((await q<Row>(th, sql`SELECT * FROM game."Active" WHERE "ActiveID"=${ACTIVE_ID}`))[0]), plan.config.Active);
    assert.deepEqual(await q<Row>(th, sql`SELECT * FROM game."Active_Award" WHERE "ActiveID"=${ACTIVE_ID} OR "ID"=${AWARD_ID}`), [plan.config.Award]);
    options.checkBinding?.();
    return { ...result, installed: true, state: "installed", insertedActive: 1, insertedAwards: 1, cacheReloadRequired: true };
  });
}

async function main(args: string[]) {
  if (args[0] === "--help") { console.log("tsx scripts/workshop-festival-activity.ts [plan|verify|install] [config.json] (default: offline plan)"); return; }
  const command = args[0] ?? "plan";
  assert.ok(args.length <= 2 && ["plan", "verify", "install"].includes(command), "invalid festival command");
  const config = readFestivalConfig(args[1]);
  if (command === "plan") { console.log(JSON.stringify(planFestivalActivity(config), null, 2)); return; }
  const runtime = resolve(repo, "../../runtime"), selected = readStarterSession(runtime), { binding } = selected;
  const settings = parseEnv(readFileSync(join(repo, ".env.workshop"), "utf8"));
  assert.ok(settings.PG_PASSWORD && settings.PG_PASSWORD.length >= 16, "missing local PG password");
  const h = await createDb(`postgres://postgres:${encodeURIComponent(settings.PG_PASSWORD)}@127.0.0.1:55432/${binding.databaseName}`, { max: 1 });
  try {
    if (command === "verify") await h.db.execute(sql`SET default_transaction_read_only=on`);
    const identity = await q1<{ databaseName: string; dataDirectory: string; port: number; timezone: string }>(h, sql`SELECT current_database() AS "databaseName", current_setting('data_directory') AS "dataDirectory", inet_server_port() AS port, current_setting('TimeZone') AS timezone`);
    assert.equal(identity?.databaseName, binding.databaseName); assert.equal(identity?.port, 55432); assert.equal(identity?.timezone, "UTC");
    assert.equal(realpathSync(identity!.dataDirectory), binding.dataDirectory); selected.check();
    const result = await runFestivalActivity(h, { command: command as "verify" | "install", config, binding,
      journalPath: join(runtime, "activities", `local-festival-${binding.databaseName}.json`), checkBinding: selected.check });
    selected.check(); console.log(JSON.stringify({ databaseName: binding.databaseName, ...result }));
  } finally { await h.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(() => { console.error("Festival activity refused or failed; inspect configuration, ownership journal and database readback. No credentials are logged."); process.exitCode = 1; });
