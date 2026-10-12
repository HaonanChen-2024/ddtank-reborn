import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { createDb, game, migrateDb, seedDatabase, type DbHandle } from "../packages/db/src/index.js";
import { q } from "../apps/api/src/lib/db.js";
import { runStarterActivity, type StarterBinding } from "./workshop-starter-activity.js";
import { runFestivalActivity } from "./workshop-festival-activity.js";
import { readExchangeConfig, runMaterialExchange, validateExchangeConfig } from "./workshop-material-exchange.js";
const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), config = readExchangeConfig();
const binding: StarterBinding = { databaseName: "isolated-exchange-install", dataDirectory: "pglite:memory" };
let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  const all = JSON.parse(gunzipSync(readFileSync(join(repo, "packages/db/seed/game/Shop_Goods.json.gz"))).toString("utf8"));
  for (const id of [11001, 11005, 11904]) {
    const row = all.find((r: { TemplateID: number }) => r.TemplateID === id); assert.ok(row);
    await h.db.insert(game.Shop_Goods).values({ ...row, AddTime: new Date(row.AddTime + "Z") });
  }
});
beforeEach(async () => {
  await h.db.execute(sql`DROP TRIGGER IF EXISTS exchange_install_fail ON game."Active_Convert_Item"`);
  await h.db.execute(sql`DROP FUNCTION IF EXISTS game.exchange_install_fail()`);
  await h.db.execute(sql`TRUNCATE app."EventClaims", player."Active_Number", game."Active_Convert_Item"`);
  await seedDatabase(h, { only: ["game.Active", "game.Active_Award"] });
});
afterAll(async () => { await h?.close(); });
function fixture(t: { onTestFinished: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), "ddt-material-exchange-"));
  assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir())); assert.ok(path.startsWith(join(tmpdir(), "ddt-material-exchange-")));
  t.onTestFinished(() => { assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir())); rmSync(path, { recursive: true, force: true }); });
  const journalPath = join(path, `local-material-exchange-${binding.databaseName}.json`);
  return { path, journalPath, run: (command: "verify" | "install" = "verify", other = {}) => runMaterialExchange(h, { command, binding, journalPath, ...other }) };
}
async function rows() {
  return {
    active: await q(h, sql`SELECT * FROM game."Active" ORDER BY "ActiveID"`),
    awards: await q(h, sql`SELECT * FROM game."Active_Award" ORDER BY "ID"`),
    materials: await q(h, sql`SELECT * FROM game."Active_Convert_Item" ORDER BY "ID"`),
    claims: await q(h, sql`SELECT * FROM app."EventClaims" ORDER BY "UserID","Kind","Key"`),
    goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods"`),
    mails: await q(h, sql`SELECT * FROM player."User_Messages"`),
  };
}
test("configuration is an explicit local ordinary-material recipe, with a bounded window and exact input identity", () => {
  assert.equal(config.provenance, "local-workshop-recipe-v1");
  assert.equal(config.Active.StartDate, "2026-10-12T16:00:00.000Z");
  assert.equal(config.Active.EndDate, "2026-10-19T15:59:59.999Z");
  for (const change of [{ HasKey: 3 }, { ActiveType: 0 }, { GoodsExchangeTypes: "11001" }, { EndDate: null }]) {
    const changed = structuredClone(config); Object.assign(changed.Active, change); assert.throws(() => validateExchangeConfig(changed));
  }
  for (const change of [{ TemplateID: 11005 }, { ItemType: 1 }, { ItemCount: 1 }, { IsBind: false }, { LimitValue: 0 }]) {
    const changed = structuredClone(config); Object.assign(changed.Materials[0], change); assert.throws(() => validateExchangeConfig(changed));
  }
  for (const change of [{ ItemID: 11904 }, { Money: 1 }, { StrengthenLevel: 1 }, { Count: 2 }]) {
    const changed = structuredClone(config); Object.assign(changed.Award, change); assert.throws(() => validateExchangeConfig(changed));
  }
});
test("verify is read-only; install adds only three configuration rows, preserves originals and resumes exactly", async t => {
  const f = fixture(t), before = await rows();
  assert.equal((await f.run()).state, "absent"); assert.equal(existsSync(f.journalPath), false); assert.deepEqual(await rows(), before);
  const installed = await f.run("install"), after = await rows();
  assert.deepEqual([installed.insertedActive, installed.insertedAwards, installed.insertedMaterials], [1, 1, 1]);
  assert.deepEqual(after.active.filter(x => x.ActiveID !== 100003), before.active);
  assert.deepEqual(after.awards.filter(x => x.ActiveID !== 100003), before.awards);
  assert.deepEqual(after.materials, config.Materials); assert.deepEqual(after.claims, before.claims);
  assert.deepEqual(after.goods, before.goods); assert.deepEqual(after.mails, before.mails);
  const journal = readFileSync(f.journalPath);
  assert.equal((await f.run("install")).insertedActive, 0); assert.equal((await f.run()).state, "installed");
  assert.deepEqual(await rows(), after); assert.deepEqual(readFileSync(f.journalPath), journal);
});
test("failed third insert rolls back the first two and keeps a prepared journal that can safely resume", async t => {
  const f = fixture(t), before = await rows();
  await h.db.execute(sql`CREATE FUNCTION game.exchange_install_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'exchange install fault'; END $$`);
  await h.db.execute(sql`CREATE TRIGGER exchange_install_fail BEFORE INSERT ON game."Active_Convert_Item" FOR EACH ROW EXECUTE FUNCTION game.exchange_install_fail()`);
  await assert.rejects(() => f.run("install")); assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), true);
  assert.equal((await f.run()).state, "prepared");
  await h.db.execute(sql`DROP TRIGGER exchange_install_fail ON game."Active_Convert_Item"`);
  assert.equal((await f.run("install")).insertedMaterials, 1); assert.equal((await f.run()).state, "installed");
});
test("unowned keys, incomplete data, old claims and unexpected codes never get overwritten", async t => {
  const operations = [
    sql`INSERT INTO game."Active" ("ActiveID","Title") VALUES (100003,'unowned')`,
    sql`INSERT INTO game."Active_Award" ("ID","ActiveID","ItemID") VALUES (100003,1,11005)`,
    sql`INSERT INTO game."Active_Convert_Item" ("ID","ActiveID","TemplateID") VALUES (100003,1,11001)`,
    sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (1,'exchange','100003')`,
    sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (1,'active','100003')`,
    sql`INSERT INTO player."Active_Number" ("AwardID","ActiveID") VALUES ('unexpected',100003)`,
  ];
  for (const op of operations) {
    const f = fixture(t); await h.db.execute(op); const before = await rows();
    await assert.rejects(() => f.run("install")); assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
    await h.db.execute(sql`DELETE FROM game."Active" WHERE "ActiveID"=100003`);
    await h.db.execute(sql`DELETE FROM game."Active_Award" WHERE "ID"=100003 OR "ActiveID"=100003`);
    await h.db.execute(sql`TRUNCATE game."Active_Convert_Item", app."EventClaims", player."Active_Number"`);
  }
});
test("two installers serialize; ownership binding, material drift and partial committed rows refuse further changes", async t => {
  const f = fixture(t), installed = await Promise.all([f.run("install"), f.run("install")]);
  assert.deepEqual(installed.map(x => x.insertedMaterials).sort(), [0, 1]);
  const journal = readFileSync(f.journalPath), parsed = JSON.parse(journal.toString("utf8"));
  writeFileSync(f.journalPath, JSON.stringify({ ...parsed, binding: { ...binding, databaseName: "other" } }));
  await assert.rejects(() => f.run(), /binding/); writeFileSync(f.journalPath, journal);
  await h.db.execute(sql`UPDATE game."Active_Convert_Item" SET "TemplateID"=11005 WHERE "ID"=100003`);
  const changed = await rows(); await assert.rejects(() => f.run("install"), /whitelist/); assert.deepEqual(await rows(), changed);
  await h.db.execute(sql`DELETE FROM game."Active_Convert_Item" WHERE "ID"=100003`);
  await assert.rejects(() => f.run(), /whitelist/);
});
test("starter accepts only the exact owned exchange plus festival, and still detects unrelated or partial changes", async t => {
  const f = fixture(t), starterPath = join(f.path, "starter.json");
  await runStarterActivity(h, { command: "install", binding, journalPath: starterPath });
  await runFestivalActivity(h, { command: "install", binding, journalPath: join(f.path, `local-festival-${binding.databaseName}.json`) });
  await f.run("install");
  const verify = () => runStarterActivity(h, { command: "verify", binding, journalPath: starterPath });
  assert.equal((await verify()).installed, true);
  await h.db.execute(sql`UPDATE game."Active_Convert_Item" SET "ItemCount"=3 WHERE "ID"=100003`);
  await assert.rejects(verify, /whitelist/);
  await h.db.execute(sql`UPDATE game."Active_Convert_Item" SET "ItemCount"=2 WHERE "ID"=100003`);
  assert.equal((await verify()).installed, true);
  await h.db.execute(sql`INSERT INTO game."Active" ("ActiveID","Title") VALUES (199999,'unrelated')`);
  await assert.rejects(verify, /original\/shared/);
});
