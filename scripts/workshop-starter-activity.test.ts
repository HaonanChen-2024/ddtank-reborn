import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { gunzipSync } from "node:zlib";
import { createDb, game, migrateDb, seedDatabase, type DbHandle } from "../packages/db/src/index.js";
import { q, q1 } from "../apps/api/src/lib/db.js";
import { readStarterConfig, readStarterSession, runStarterActivity, type StarterBinding } from "./workshop-starter-activity.js";
import { runFestivalActivity } from "./workshop-festival-activity.js";

const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), config = readStarterConfig();
const binding: StarterBinding = { databaseName: "isolated-starter-test", dataDirectory: "pglite:memory" };
let h: DbHandle;

beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  const templates = JSON.parse(gunzipSync(readFileSync(join(repo, "packages/db/seed/game/Shop_Goods.json.gz"))).toString("utf8"));
  const potion = templates.find((row: { TemplateID: number }) => row.TemplateID === 11904);
  assert.ok(potion); await h.db.insert(game.Shop_Goods).values({ ...potion, AddTime: new Date(potion.AddTime + "Z") });
});
beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE app."EventClaims", player."Active_Number"`);
  await seedDatabase(h, { only: ["game.Active", "game.Active_Award"] });
});
afterAll(async () => { await h?.close(); });

function fixture(t: { onTestFinished: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), "ddt-starter-activity-"));
  assert.equal(dirname(path), resolve(tmpdir()));
  assert.ok(realpathSync(path).startsWith(resolve(tmpdir()) + "/") || realpathSync(path).startsWith(resolve(tmpdir()) + "\\"));
  assert.ok(path.startsWith(join(tmpdir(), "ddt-starter-activity-")));
  t.onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  const journalPath = join(path, "local-starter.json");
  const run = (command: "verify" | "install" = "verify", options = {}) => runStarterActivity(h, { command, binding, journalPath, ...options });
  return { path, journalPath, run };
}
async function rows() {
  return { active: await q(h, sql`SELECT * FROM game."Active" ORDER BY "ActiveID"`), awards: await q(h, sql`SELECT * FROM game."Active_Award" ORDER BY "ID"`),
    claims: await q(h, sql`SELECT * FROM app."EventClaims" ORDER BY "UserID","Kind","Key"`), codes: await q(h, sql`SELECT * FROM player."Active_Number" ORDER BY "AwardID"`),
    potion: await q1(h, sql`SELECT * FROM game."Shop_Goods" WHERE "TemplateID"=11904`) };
}

test("the public fixture is one ordinary free potion with explicit UTC dates and no fake reminder icon", () => {
  assert.equal(config.Active.Title, "本地启程补给"); assert.equal(config.Active.HasKey, 3); assert.equal(config.Active.Type, 0);
  assert.equal(config.Active.IsShow, false); assert.equal(config.Active.IconID, 0);
  assert.equal(config.Award.ItemID, 11904); assert.equal(config.Award.Count, 1);
  assert.equal(config.Active.StartDate, "2026-01-01T00:00:00.000Z"); assert.equal(config.Active.EndDate, "2031-01-01T00:00:00.000Z");
});

test("verify is read-only, preserves all source rows and creates no journal", async t => {
  const f = fixture(t), before = await rows(), result = await f.run();
  assert.equal(result.installed, false); assert.equal(result.insertedActive, 0); assert.equal(result.insertedAwards, 0);
  assert.deepEqual([result.baseline.Active.count, result.baseline.Active_Award.count], [33, 310]);
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
});

test("install adds exactly two rows, preserves every original column and repeats without resetting claims", async t => {
  const f = fixture(t), before = await rows(), first = await f.run("install"), afterInstall = await rows();
  assert.equal(first.insertedActive, 1); assert.equal(first.insertedAwards, 1); assert.equal(first.cacheReloadRequired, true); assert.equal(first.clientAccepted, false);
  assert.deepEqual(afterInstall.active.filter(row => row.ActiveID !== 100001), before.active);
  assert.deepEqual(afterInstall.awards.filter(row => row.ActiveID !== 100001), before.awards);
  assert.deepEqual(afterInstall.potion, before.potion); assert.deepEqual(afterInstall.claims, before.claims); assert.deepEqual(afterInstall.codes, before.codes);
  const reward = afterInstall.awards.find(row => row.ActiveID === 100001)!;
  assert.deepEqual(reward, { ID: first.awardId, ActiveID: 100001, ...config.Award });
  const journal = readFileSync(f.journalPath);
  // Simulate a legitimate completed claim, without invoking the live claim handler or giving any item.
  await h.db.execute(sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (91234,'active','100001')`);
  const afterClaim = await rows();
  for (const command of ["verify", "install"] as const) {
    const repeated = await f.run(command); assert.equal(repeated.insertedActive, 0); assert.equal(repeated.insertedAwards, 0);
    assert.equal(repeated.claims, 1); assert.equal(repeated.cacheReloadRequired, false); assert.deepEqual(await rows(), afterClaim);
  }
  const reordered = { ...config, Active: Object.fromEntries(Object.entries(config.Active).reverse()), Award: Object.fromEntries(Object.entries(config.Award).reverse()) };
  assert.equal((await f.run("install", { config: reordered })).insertedActive, 0);
  assert.deepEqual(readFileSync(f.journalPath), journal);
});

test("two concurrent installers add one owned pair and the follower inserts nothing", async t => {
  const f = fixture(t), before = await rows();
  const results = await Promise.all([f.run("install"), f.run("install")]);
  assert.deepEqual(results.map(row => row.insertedActive).sort(), [0, 1]);
  assert.deepEqual(results.map(row => row.insertedAwards).sort(), [0, 1]);
  const installed = await rows();
  assert.deepEqual(installed.active.filter(row => row.ActiveID !== 100001), before.active);
  assert.deepEqual(installed.awards.filter(row => row.ActiveID !== 100001), before.awards);
});

test("the exactly owned festival coexists before and after starter install without resetting claims", async t => {
  const f = fixture(t), festivalJournal = join(f.path, `local-festival-${binding.databaseName}.json`);
  await runFestivalActivity(h, { command: "install", binding, journalPath: festivalJournal });
  assert.equal((await f.run()).installed, false);
  assert.equal((await f.run("install")).insertedActive, 1);
  await h.db.execute(sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (2233,'active','100001'),(2233,'active','100002')`);
  const before = await rows();
  assert.equal((await f.run()).installed, true); assert.equal((await f.run("install")).insertedActive, 0);
  assert.deepEqual(await rows(), before);
});

test("festival ownership requires the full matching journal and both exact rows", async t => {
  const f = fixture(t), festivalJournal = join(f.path, `local-festival-${binding.databaseName}.json`);
  await f.run("install");
  await runFestivalActivity(h, { command: "install", binding, journalPath: festivalJournal });
  assert.equal((await f.run()).installed, true);
  const intent = readFileSync(festivalJournal), before = await rows();
  writeFileSync(festivalJournal, JSON.stringify({ ...JSON.parse(intent.toString("utf8")), binding: { ...binding, databaseName: "another" } }));
  await assert.rejects(() => f.run("install"), /festival ownership/); assert.deepEqual(await rows(), before);
  writeFileSync(festivalJournal, intent);
  await h.db.execute(sql`UPDATE game."Active_Award" SET "Count"=2 WHERE "ID"=100002`);
  const changed = await rows(); await assert.rejects(() => f.run(), /festival reward differs/); assert.deepEqual(await rows(), changed);
  await h.db.execute(sql`DELETE FROM game."Active_Award" WHERE "ID"=100002`);
  const partial = await rows(); await assert.rejects(() => f.run(), /festival reward differs/); assert.deepEqual(await rows(), partial);
});

test("an identical festival with no journal and third-party edits alongside an owned festival stay rejected", async t => {
  const f = fixture(t), journalPath = join(f.path, "unrecognized-journal.json");
  await runFestivalActivity(h, { command: "install", binding, journalPath });
  const before = await rows(); await assert.rejects(() => f.run(), /lacks its ownership journal/); assert.deepEqual(await rows(), before);
  writeFileSync(join(f.path, `local-festival-${binding.databaseName}.json`), readFileSync(journalPath));
  await h.db.execute(sql`UPDATE game."Active" SET "Content"='Third party edit' WHERE "ActiveID"=1`);
  const changed = await rows(); await assert.rejects(() => f.run("install"), /original\/shared activity tables changed/); assert.deepEqual(await rows(), changed);
  await h.db.execute(sql`UPDATE game."Active" SET "Content"=${before.active.find(row => row.ActiveID === 1)!.Content as string | null} WHERE "ActiveID"=1`);
  await h.db.execute(sql`INSERT INTO game."Active" ("ActiveID","Title") VALUES (778899,'Third party event')`);
  const extra = await rows(); await assert.rejects(() => f.run(), /original\/shared activity tables changed/); assert.deepEqual(await rows(), extra);
});

test("fresh installation refuses collisions in each of the four independent tables", async t => {
  const f = fixture(t);
  const operations = [
    sql`INSERT INTO game."Active" ("ActiveID","Title") VALUES (100001,'Existing')`,
    sql`INSERT INTO game."Active_Award" ("ActiveID","ItemID") VALUES (100001,11904)`,
    sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (112,'active','100001')`,
    sql`INSERT INTO player."Active_Number" ("AwardID","ActiveID") VALUES ('existing-code',100001)`,
  ];
  for (const operation of operations) {
    await h.db.transaction(async tx => {
      await tx.execute(operation);
      // This callback's temporary transaction must close before the installer opens its transaction.
    });
    const before = await rows(); await assert.rejects(() => f.run("install")); assert.deepEqual(await rows(), before);
    assert.equal(existsSync(f.journalPath), false);
    await h.db.execute(sql`DELETE FROM game."Active" WHERE "ActiveID"=100001`);
    await h.db.execute(sql`DELETE FROM game."Active_Award" WHERE "ActiveID"=100001`);
    await h.db.execute(sql`DELETE FROM app."EventClaims" WHERE "Kind"='active' AND "Key"='100001'`);
    await h.db.execute(sql`DELETE FROM player."Active_Number" WHERE "ActiveID"=100001`);
  }
});

test("unknown edits or additions in either shared source table are refused and preserved", async t => {
  const f = fixture(t);
  for (const operation of [
    sql`UPDATE game."Active" SET "Content"='User edit' WHERE "ActiveID"=1`,
    sql`INSERT INTO game."Active" ("ActiveID","Title") VALUES (778899,'User event')`,
    sql`UPDATE game."Active_Award" SET "Count"=7 WHERE "ID"=1`,
    sql`INSERT INTO game."Active_Award" ("ActiveID","ItemID") VALUES (778899,11904)`,
  ]) {
    await h.db.execute(operation); const before = await rows();
    await assert.rejects(() => f.run("install"), /original\/shared activity tables changed/);
    assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
    await seedDatabase(h, { only: ["game.Active", "game.Active_Award"] });
  }
});

test("an award SQL failure rolls back the new activity too", async t => {
  const f = fixture(t), before = await rows();
  await h.db.execute(sql`ALTER TABLE game."Active_Award" ADD CONSTRAINT reject_starter CHECK ("ActiveID"<>100001)`);
  try { await assert.rejects(() => f.run("install")); }
  finally { await h.db.execute(sql`ALTER TABLE game."Active_Award" DROP CONSTRAINT reject_starter`); }
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
});

test("journal creation failure rolls back both new rows without touching existing claims or codes", async t => {
  const f = fixture(t);
  await h.db.execute(sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (4455,'active','1')`);
  await h.db.execute(sql`INSERT INTO player."Active_Number" ("AwardID","ActiveID") VALUES ('keep-code',1)`);
  const before = await rows(), blocked = join(f.path, "not-a-directory"); writeFileSync(blocked, "preserve me");
  await assert.rejects(() => f.run("install", { journalPath: join(blocked, "journal.json") }));
  assert.deepEqual(await rows(), before); assert.equal(readFileSync(blocked, "utf8"), "preserve me");
});

test("changed configuration, changed owned reward, missing row or missing journal are refused", async t => {
  const f = fixture(t); await f.run("install"); const original = await rows(), journal = readFileSync(f.journalPath);
  const changedConfig = structuredClone(config); changedConfig.Active.Title = "Changed title";
  await assert.rejects(() => f.run("install", { config: changedConfig }), /configuration differs/); assert.deepEqual(await rows(), original);
  await assert.rejects(() => f.run("install", { binding: { ...binding, databaseName: "different-database" } }), /different database/);
  assert.deepEqual(await rows(), original); assert.deepEqual(readFileSync(f.journalPath), journal);
  await h.db.execute(sql`UPDATE game."Active_Award" SET "Count"=2 WHERE "ActiveID"=100001`);
  const changed = await rows(); await assert.rejects(() => f.run("install")); assert.deepEqual(await rows(), changed);
  await h.db.execute(sql`DELETE FROM game."Active_Award" WHERE "ActiveID"=100001`);
  const partial = await rows(); await assert.rejects(() => f.run("install"), /incomplete starter reward/); assert.deepEqual(await rows(), partial);
  rmSync(f.journalPath); await assert.rejects(() => f.run("install"), /already occupied/); assert.deepEqual(await rows(), partial);
  writeFileSync(f.journalPath, journal);
});

test("a binding change before journal publication rolls back both inserts", async t => {
  const f = fixture(t), before = await rows(); let checks = 0;
  await assert.rejects(() => f.run("install", { checkBinding: () => { if (++checks === 2) throw new Error("session changed"); } }), /session changed/);
  assert.equal(checks, 2); assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
});

test("unknown reward attributes are rejected before writing, and an altered template is not accepted", async t => {
  const f = fixture(t), before = await rows();
  for (const values of [{ StrengthenLevel: 10 }, { Money: 9999 }, { ItemID: 90000 }, { Count: 2 }, { Sex: 1 }, { Mark: 1 }]) {
    const changedConfig = structuredClone(config); Object.assign(changedConfig.Award, values);
    await assert.rejects(() => f.run("install", { config: changedConfig })); assert.deepEqual(await rows(), before);
  }
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "Attack"=9999 WHERE "TemplateID"=11904`);
  try { await assert.rejects(() => f.run("install"), /ordinary experience potion/); }
  finally { await h.db.execute(sql`UPDATE game."Shop_Goods" SET "Attack"=0 WHERE "TemplateID"=11904`); }
  assert.deepEqual(await rows(), before);
});

test("session and ready files must bind one live normal Workshop database and cluster", t => {
  const f = fixture(t); mkdirSync(join(f.path, "data/postgres"), { recursive: true });
  const session = { managerPid: process.pid, publicHost: "127.0.0.1", databaseName: "ddtank", ports: { db: 55432 }, children: [{ name: "db", pid: process.pid }] };
  const ready = { pid: process.pid, port: 55432, databaseName: "ddtank" };
  writeFileSync(join(f.path, "workshop-session.json"), JSON.stringify(session)); writeFileSync(join(f.path, "postgres-ready.json"), JSON.stringify(ready));
  const selected = readStarterSession(f.path); assert.equal(selected.binding.databaseName, "ddtank"); selected.check();
  writeFileSync(join(f.path, "postgres-ready.json"), JSON.stringify({ ...ready, databaseName: "another_project" }));
  assert.throws(() => selected.check(), /restarted/); assert.throws(() => readStarterSession(f.path));
  writeFileSync(join(f.path, "postgres-ready.json"), JSON.stringify(ready));
  writeFileSync(join(f.path, "workshop-session.json"), JSON.stringify({ ...session, managerPid: 0 })); assert.throws(() => readStarterSession(f.path));
});
