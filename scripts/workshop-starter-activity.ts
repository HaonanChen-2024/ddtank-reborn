#!/usr/bin/env node
// One local free activity; original tables, player progress and claim rows are never rewritten.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { gunzipSync } from "node:zlib";
import { createDb, game, type DbHandle } from "../packages/db/src/index.js";
import { q, q1 } from "../apps/api/src/lib/db.js";

// Resolve the existing dependency from its workspace owner; add no root dependency.
const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const { selectedDatabase } = await import(new URL("./workshop-backup.mjs", import.meta.url).href) as { selectedDatabase: (session: { managerPid: number; databaseName?: string }) => string };
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "ddtank-workshop/local-starter";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Row = Record<string, unknown>;
type Fingerprint = { count: number; sha256: string };
type Baseline = { Active: Fingerprint; Active_Award: Fingerprint };
export interface StarterConfig { owner: string; version: number; Active: Row; Award: Row }
export interface StarterBinding { databaseName: string; dataDirectory: string }
interface Journal {
  owner: string; version: number; configSha256: string; binding: StarterBinding; baseline: Baseline;
  activeId: number; awardId: number; activeSha256: string; awardSha256: string; preparedAt: string;
}

function dates(row: Row): Row {
  const result = { ...row };
  for (const field of ["StartDate", "EndDate"]) if (result[field] != null) {
    const value = result[field];
    const date = value instanceof Date ? value : new Date(String(value) + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? "" : "Z"));
    assert.ok(Number.isFinite(date.getTime()), "invalid activity date"); result[field] = date.toISOString();
  }
  return result;
}
const canonical = (row: Row) => JSON.stringify(Object.fromEntries(Object.entries(dates(row)).sort(([a], [b]) => a.localeCompare(b))));
const digest = (row: Row) => hash(canonical(row));
const fingerprint = (rows: Row[]): Fingerprint => ({ count: rows.length, sha256: hash(rows.map(canonical).sort().join("\n")) });

export function readStarterConfig(path = join(repo, "research/activities/local-starter.json")): StarterConfig {
  return validateStarterConfig(JSON.parse(readFileSync(path, "utf8")) as StarterConfig);
}
function validateStarterConfig(config: StarterConfig): StarterConfig {
  assert.deepEqual(Object.keys(config).sort(), ["Active", "Award", "owner", "version"].sort());
  assert.equal(config.owner, OWNER); assert.equal(config.version, 1);
  const a = config.Active, reward = config.Award;
  assert.deepEqual(Object.keys(a).sort(), ["ActiveID", "Title", "Description", "Content", "AwardContent", "HasKey", "StartDate", "EndDate", "IsOnly", "Type", "ActionTimeContent", "IsAdvance", "GoodsExchangeTypes", "GoodsExchangeNum", "limitType", "limitValue", "IsShow", "ActiveType", "IconID", "CanCreateCode"].sort());
  assert.equal(a.ActiveID, 100001); assert.equal(a.HasKey, 3); assert.equal(a.IsOnly, 1);
  for (const field of ["Type", "ActiveType", "IconID"]) assert.equal(a[field], 0);
  for (const field of ["IsAdvance", "IsShow", "CanCreateCode"]) assert.equal(a[field], false);
  for (const field of ["GoodsExchangeTypes", "GoodsExchangeNum", "limitType", "limitValue"]) assert.equal(a[field], "");
  for (const [field, max] of [["Title", 200], ["Description", 2000], ["Content", 2000], ["AwardContent", 2000], ["ActionTimeContent", 50]] as const)
    assert.ok(typeof a[field] === "string" && (a[field] as string).length > 0 && (a[field] as string).length <= max, "invalid activity text: " + field);
  const normalized = dates(a); for (const field of ["StartDate", "EndDate"]) assert.equal(a[field], normalized[field], "use explicit UTC ISO activity dates");
  assert.ok(String(a.StartDate) < String(a.EndDate));
  assert.deepEqual(Object.keys(reward).sort(), ["ItemID", "Count", "ValidDate", "StrengthenLevel", "AttackCompose", "DefendCompose", "LuckCompose", "AgilityCompose", "Gold", "Money", "Sex", "Mark"].sort());
  assert.equal(reward.ItemID, 11904); assert.equal(reward.Count, 1);
  for (const field of Object.keys(reward).filter(key => !["ItemID", "Count"].includes(key))) assert.equal(reward[field], 0, "only one ordinary free item is supported");
  return config;
}

function sourceBaseline(repoRoot: string): Baseline {
  const load = (name: string) => JSON.parse(gunzipSync(readFileSync(join(repoRoot, "packages/db/seed/game", name + ".json.gz"))).toString("utf8")) as Row[];
  const active = load("Active"), awards = load("Active_Award");
  assert.equal(active.length, 33); assert.equal(awards.length, 310);
  assert.equal(new Set(active.map(row => row.ActiveID)).size, 33); assert.equal(new Set(awards.map(row => row.ID)).size, 310);
  assert.ok(active.every(row => row.ActiveID !== 100001) && awards.every(row => row.ActiveID !== 100001), "source seeds already occupy the local activity ID");
  return { Active: fingerprint(active), Active_Award: fingerprint(awards) };
}

function readJournal(path: string): Journal | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Journal : null;
}
function publishJournal(path: string, journal: Journal) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600); let written = false;
  try { writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n"); fsyncSync(fd); written = true; }
  finally { closeSync(fd); if (!written) unlinkSync(path); }
}

// Tests use a new PGlite database and a private temporary journal; the CLI always binds the running native session.
export async function runStarterActivity(h: DbHandle, options: {
  command: "verify" | "install"; binding: StarterBinding; journalPath: string;
  config?: StarterConfig; repoRoot?: string; checkBinding?: () => void;
}) {
  const { command, binding, journalPath } = options;
  assert.ok(command === "verify" || command === "install");
  const config = validateStarterConfig(options.config ?? readStarterConfig()), baseline = sourceBaseline(options.repoRoot ?? repo);
  const configSha256 = hash(JSON.stringify({ owner: config.owner, version: config.version, Active: canonical(config.Active), Award: canonical(config.Award) }));
  const activeId = Number(config.Active.ActiveID), desiredActive = config.Active;
  let published = false;
  const result = await h.db.transaction(async tx => {
    const th = { ...h, db: tx };
    options.checkBinding?.();
    if (command === "verify") await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    else await tx.execute(sql`LOCK TABLE game."Active", game."Active_Award", app."EventClaims", player."Active_Number" IN SHARE ROW EXCLUSIVE MODE`);
    const keys = await q<{ table: string; columns: string[] }>(th, sql`SELECT c.conrelid::regclass::text AS "table",
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.ord) AS columns
      FROM pg_constraint c WHERE c.contype='p' AND c.conrelid IN ('game."Active"'::regclass,'game."Active_Award"'::regclass,'app."EventClaims"'::regclass,'player."Active_Number"'::regclass)`);
    const expectedKeys = new Map([["game.\"Active\"", ["ActiveID"]], ["game.\"Active_Award\"", ["ID"]], ["app.\"EventClaims\"", ["UserID", "Kind", "Key"]], ["player.\"Active_Number\"", ["AwardID"]]]);
    assert.equal(keys.length, 4); for (const key of keys) assert.deepEqual(key.columns, expectedKeys.get(key.table), "activity tables have unknown uniqueness constraints");
    const journal = readJournal(journalPath);
    const active = await q<Row>(th, sql`SELECT * FROM game."Active"`), awards = await q<Row>(th, sql`SELECT * FROM game."Active_Award"`);
    // This one separately owned activity may coexist with the immutable seed baseline. Never accept
    // arbitrary new rows, or a prepared journal alone: the config, binding and both full DB rows must match.
    let ownedFestivalId: number | null = null;
    if (active.some(row => row.ActiveID === 100002) || awards.some(row => row.ActiveID === 100002 || row.ID === 100002)) {
      // Deferred to avoid a static cycle: the festival CLI reuses readStarterSession from this module.
      const { readFestivalConfig, planFestivalActivity } = await import("./workshop-festival-activity.js");
      const festival = planFestivalActivity(readFestivalConfig(join(options.repoRoot ?? repo, "research/activities/local-festival.json")));
      const festivalJournalPath = join(dirname(journalPath), `local-festival-${binding.databaseName}.json`);
      assert.ok(existsSync(festivalJournalPath), "coexisting festival lacks its ownership journal");
      const festivalJournal = JSON.parse(readFileSync(festivalJournalPath, "utf8"));
      assert.deepEqual(festivalJournal, { phase: "prepared", configSha256: festival.configSha256, binding, config: festival.config }, "coexisting festival ownership or configuration differs");
      assert.deepEqual(active.filter(row => row.ActiveID === festival.activeId).map(dates), [festival.config.Active], "coexisting festival activity differs");
      assert.deepEqual(awards.filter(row => row.ActiveID === festival.activeId || row.ID === festival.awardId), [festival.config.Award], "coexisting festival reward differs");
      ownedFestivalId = festival.activeId;
    }
    const claims = await q1<{ count: number }>(th, sql`SELECT count(*)::int AS count FROM app."EventClaims" WHERE "Kind"='active' AND "Key"=${String(activeId)}`);
    const codes = await q1<{ count: number }>(th, sql`SELECT count(*)::int AS count FROM player."Active_Number" WHERE "ActiveID"=${activeId}`);
    const existingActive = active.filter(row => row.ActiveID === activeId), existingAwards = awards.filter(row => row.ActiveID === activeId);
    if (journal) {
      assert.equal(journal.owner, OWNER); assert.equal(journal.version, 1); assert.equal(journal.configSha256, configSha256, "installed starter configuration differs; preserve it");
      assert.deepEqual(journal.binding, binding, "starter journal belongs to a different database");
      assert.deepEqual(journal.baseline, baseline, "source activity baseline differs");
      assert.equal(journal.activeId, activeId); assert.ok(Number.isSafeInteger(journal.awardId) && journal.awardId > 0);
      assert.equal(existingActive.length, 1, "incomplete starter installation preserved"); assert.equal(existingAwards.length, 1, "incomplete starter reward preserved");
      assert.equal(existingAwards[0].ID, journal.awardId, "starter award ownership differs");
      assert.equal(digest(existingActive[0]), journal.activeSha256); assert.equal(digest(existingActive[0]), digest(desiredActive));
      const desiredAward = { ID: journal.awardId, ActiveID: activeId, ...config.Award };
      assert.equal(digest(existingAwards[0]), journal.awardSha256); assert.equal(digest(existingAwards[0]), digest(desiredAward));
      assert.equal(codes?.count, 0, "unexpected activation codes preserved");
    } else {
      assert.equal(existingActive.length, 0, "candidate ActiveID is already occupied; no journal owns it");
      assert.equal(existingAwards.length, 0, "candidate ActiveID has unowned awards");
      assert.equal(claims?.count, 0, "candidate ActiveID has existing claims"); assert.equal(codes?.count, 0, "candidate ActiveID has existing activation codes");
    }
    const isBaseline = (row: Row) => row.ActiveID !== activeId && row.ActiveID !== ownedFestivalId;
    const actualBaseline = { Active: fingerprint(active.filter(isBaseline)), Active_Award: fingerprint(awards.filter(isBaseline)) };
    assert.deepEqual(actualBaseline, baseline, "original/shared activity tables changed; preserve all rows");
    const template = await q1<Row>(th, sql`SELECT "CategoryID","Property1","Property2","MaxCount","NeedSex","NeedLevel","Level","Attack","Defence","Agility","Luck","CanUse","CanStrengthen","CanCompose" FROM game."Shop_Goods" WHERE "TemplateID"=11904`);
    assert.deepEqual(template, { CategoryID: 11, Property1: 21, Property2: 10000, MaxCount: 1, NeedSex: 0, NeedLevel: 1, Level: 1, Attack: 0, Defence: 0, Agility: 0, Luck: 0, CanUse: true, CanStrengthen: false, CanCompose: false }, "11904 must be the existing ordinary experience potion");
    if (journal || command === "verify") { options.checkBinding?.(); return { installed: Boolean(journal), insertedActive: 0, insertedAwards: 0, activeId, awardId: journal?.awardId ?? null, baseline, claims: claims!.count }; }
    await tx.insert(game.Active).values({ ...desiredActive, StartDate: new Date(String(desiredActive.StartDate)), EndDate: new Date(String(desiredActive.EndDate)) } as typeof game.Active.$inferInsert);
    const [reward] = await tx.insert(game.Active_Award).values({ ActiveID: activeId, ...config.Award } as typeof game.Active_Award.$inferInsert).returning();
    assert.ok(reward && Number.isSafeInteger(reward.ID) && reward.ID > 0);
    const newActive = await q<Row>(th, sql`SELECT * FROM game."Active"`), newAwards = await q<Row>(th, sql`SELECT * FROM game."Active_Award"`);
    assert.equal(newActive.length, active.length + 1); assert.equal(newAwards.length, awards.length + 1);
    assert.deepEqual({ Active: fingerprint(newActive.filter(isBaseline)), Active_Award: fingerprint(newAwards.filter(isBaseline)) }, baseline, "source activities changed during insertion");
    const ownedActive = newActive.filter(row => row.ActiveID === activeId), ownedAwards = newAwards.filter(row => row.ActiveID === activeId);
    assert.equal(ownedActive.length, 1); assert.equal(ownedAwards.length, 1);
    assert.equal(digest(ownedActive[0]), digest(desiredActive)); assert.equal(digest(ownedAwards[0]), digest({ ID: reward.ID, ActiveID: activeId, ...config.Award }));
    assert.equal((await q1<{ count: number }>(th, sql`SELECT count(*)::int AS count FROM app."EventClaims" WHERE "Kind"='active' AND "Key"=${String(activeId)}`))?.count, 0);
    assert.equal((await q1<{ count: number }>(th, sql`SELECT count(*)::int AS count FROM player."Active_Number" WHERE "ActiveID"=${activeId}`))?.count, 0);
    // Write the exclusive journal before COMMIT: file failure rolls back both inserts. If COMMIT is interrupted,
    // the durable journal remains; a later call accepts exact committed rows or refuses the incomplete outcome.
    options.checkBinding?.();
    publishJournal(journalPath, { owner: OWNER, version: 1, configSha256, binding, baseline, activeId, awardId: reward.ID,
      activeSha256: digest(ownedActive[0]), awardSha256: digest(ownedAwards[0]), preparedAt: new Date().toISOString() });
    published = true;
    return { installed: true, insertedActive: 1, insertedAwards: 1, activeId, awardId: reward.ID, baseline, claims: 0 };
  });
  return { ...result, configSha256, journalPublished: published, originalRowsPreserved: true, playerDataWritten: false,
    cacheReloadRequired: result.insertedActive > 0, clientAccepted: false };
}

function alive(pid: unknown) {
  assert.ok(Number.isInteger(pid) && Number(pid) > 0, "invalid Workshop process binding");
  try { process.kill(Number(pid), 0); } catch { assert.fail("Workshop session is not running"); }
}
export function readStarterSession(runtimeRoot: string) {
  const sessionPath = join(runtimeRoot, "workshop-session.json"), readyPath = join(runtimeRoot, "postgres-ready.json");
  const sessionBytes = readFileSync(sessionPath), readyBytes = readFileSync(readyPath);
  const session = JSON.parse(sessionBytes.toString("utf8")), ready = JSON.parse(readyBytes.toString("utf8"));
  assert.equal(session.publicHost ?? "127.0.0.1", "127.0.0.1");
  const databaseName = selectedDatabase(session);
  assert.equal(session.ports?.db, 55432); assert.equal(ready.port, 55432); assert.equal(ready.databaseName, databaseName);
  const db = session.children?.filter((child: { name: string }) => child.name === "db");
  assert.equal(db?.length, 1); assert.equal(db[0].pid, ready.pid); alive(ready.pid);
  const dataDirectory = realpathSync(join(runtimeRoot, "data/postgres"));
  const check = () => {
    assert.deepEqual(readFileSync(sessionPath), sessionBytes, "Workshop session changed during activity preparation");
    assert.deepEqual(readFileSync(readyPath), readyBytes, "Workshop database restarted during activity preparation");
    alive(session.managerPid); alive(ready.pid);
  };
  return { binding: { databaseName, dataDirectory }, check };
}

async function main(args: string[]) {
  assert.ok(args.length <= 1 && (args[0] === undefined || ["verify", "install"].includes(args[0])), "usage: tsx scripts/workshop-starter-activity.ts verify|install");
  const command = (args[0] ?? "verify") as "verify" | "install", runtime = resolve(repo, "../../runtime");
  const selected = readStarterSession(runtime), { binding } = selected;
  const settings = parseEnv(readFileSync(join(repo, ".env.workshop"), "utf8"));
  assert.ok(settings.PG_PASSWORD && settings.PG_PASSWORD.length >= 16, "missing local PG password");
  const h = await createDb(`postgres://postgres:${encodeURIComponent(settings.PG_PASSWORD)}@127.0.0.1:55432/${binding.databaseName}`, { max: 1 });
  try {
    if (command === "verify") await h.db.execute(sql`SET default_transaction_read_only=on`);
    const identity = await q1<{ databaseName: string; dataDirectory: string; port: number; timezone: string }>(h, sql`SELECT current_database() AS "databaseName", current_setting('data_directory') AS "dataDirectory", inet_server_port() AS port, current_setting('TimeZone') AS timezone`);
    assert.equal(identity?.databaseName, binding.databaseName); assert.equal(identity?.port, 55432); assert.equal(identity?.timezone, "UTC");
    assert.equal(realpathSync(identity!.dataDirectory), binding.dataDirectory); selected.check();
    const result = await runStarterActivity(h, { command, binding, journalPath: join(runtime, "activities", `local-starter-${binding.databaseName}.json`), checkBinding: selected.check });
    selected.check(); console.log(JSON.stringify({ databaseName: binding.databaseName, ...result }));
  } finally { await h.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof assert.AssertionError ? error.message.split("\n")[0] : "Starter activity refused or failed; inspect the local guard/test evidence. No credentials are logged."); process.exitCode = 1; });
