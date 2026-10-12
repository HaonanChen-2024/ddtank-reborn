import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { createDb, game, migrateDb, type DbHandle } from "../packages/db/src/index.js";
import { q } from "../apps/api/src/lib/db.js";
import { planWeaponInstall, runWeaponInstall, validateWeaponPackage, type WeaponPackage } from "./workshop-weapon.js";

const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seed = (name: string) => JSON.parse(gunzipSync(readFileSync(join(repo, "packages/db/seed/game", name + ".json.gz"))).toString("utf8")) as Record<string, unknown>[];
const sourceItem = seed("Shop_Goods").find(row => row.TemplateID === 7001)!;
const sourceBall = seed("Ball").find(row => row.ID === 106)!;
const templateId = 9707243, ballIds = [14301, 143012, 143011, 143013];
const binding = { databaseName: "isolated-weapon-test", dataDirectory: "pglite:memory" };
let h: DbHandle;

function config(): WeaponPackage {
  const item = { ...sourceItem, TemplateID: templateId, Name: "Isolated test weapon", Pic: "14301", Attack: 78, Defence: 208, Agility: 195, Luck: 39,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 15, Property6: 65, Property7: 247, Property8: 2,
    AddTime: sourceItem.AddTime === null ? null : new Date(String(sourceItem.AddTime) + "Z").toISOString() };
  return { schemaVersion: 1, mode: "local-compat", owner: "ddtank-workshop/weapon/isolated-test",
    metadata: { fixture: true, source: "test input; copied physics is not official", officialTemplateId: 7243 }, Shop_Goods: item,
    BallConfig: { TemplateID: templateId, Common: ballIds[0], CommonAddWound: ballIds[1], CommonMultiBall: ballIds[2], Special: ballIds[3] },
    Ball: ballIds.map(ID => ({ ...sourceBall, ID, Name: `isolated-${ID}` })) };
}

beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE game."Shop_Goods", game."BallConfig", game."Ball"`);
  await h.db.insert(game.Shop_Goods).values({ ...sourceItem, AddTime: sourceItem.AddTime === null ? null : new Date(String(sourceItem.AddTime) + "Z") } as typeof game.Shop_Goods.$inferInsert);
  await h.db.insert(game.Ball).values(sourceBall as typeof game.Ball.$inferInsert);
  await h.db.insert(game.BallConfig).values({ TemplateID: 7001, Common: 106, CommonAddWound: 106, CommonMultiBall: 106, Special: 106 });
});
afterAll(async () => { await h?.close(); });

function fixture(t: { onTestFinished: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), "ddt-weapon-test-"));
  assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir()));
  assert.ok(path.startsWith(join(tmpdir(), "ddt-weapon-test-")));
  t.onTestFinished(() => {
    assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir()));
    rmSync(path, { recursive: true, force: true });
  });
  const journalPath = join(path, "owned.json");
  const run = (command: "verify" | "install" = "verify", extra: Partial<Parameters<typeof runWeaponInstall>[1]> = {}) =>
    runWeaponInstall(h, { command, config: config(), binding, journalPath, ...extra });
  return { path, journalPath, run };
}
async function rows() {
  return { items: await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`),
    configs: await q(h, sql`SELECT * FROM game."BallConfig" ORDER BY "TemplateID"`),
    balls: await q(h, sql`SELECT * FROM game."Ball" ORDER BY "ID"`) };
}
function originalOnly(actual: Awaited<ReturnType<typeof rows>>) {
  return { items: actual.items.filter(row => row.TemplateID !== templateId), configs: actual.configs.filter(row => row.TemplateID !== templateId),
    balls: actual.balls.filter(row => !ballIds.includes(Number(row.ID))) };
}

test("offline plan preserves every supplied property and source metadata without guessing physics", () => {
  const input = config(), before = structuredClone(input), result = planWeaponInstall(input);
  assert.deepEqual(input, before); assert.deepEqual(result.config.Shop_Goods, input.Shop_Goods);
  assert.deepEqual(result.config.metadata, input.metadata); assert.equal(result.config.Shop_Goods.Property1, 0);
  assert.deepEqual(result.counts, { Shop_Goods: 1, BallConfig: 1, Ball: 4 });
  assert.equal(result.databaseConnected, false); assert.equal(result.installed, false);
  const reordered = { ...input, Ball: [...input.Ball].reverse(), Shop_Goods: Object.fromEntries(Object.entries(input.Shop_Goods).reverse()) };
  assert.equal(planWeaponInstall(reordered).packageSha256, result.packageSha256);
});

test("schema rejects non-finite or coerced fields, incomplete rows and open/duplicate Ball references", () => {
  const changes: ((value: WeaponPackage) => void)[] = [
    v => { v.schemaVersion = 2 as 1; }, v => { v.mode = "official" as "local-compat"; }, v => { v.owner = "../unknown"; },
    v => { v.Shop_Goods.CategoryID = 13; }, v => { v.Shop_Goods.Attack = NaN; }, v => { v.Shop_Goods.Property7 = Infinity; },
    v => { v.Shop_Goods.TemplateID = 2147483648; }, v => { v.Shop_Goods.CanEquip = "true"; },
    v => { v.Shop_Goods.AddTime = "2026-10-12"; }, v => { delete v.Shop_Goods.Luck; },
    v => { v.Shop_Goods.Unowned = 1; }, v => { v.Ball[0].Power = NaN; }, v => { v.Ball[0].Mass = "10"; },
    v => { delete v.Ball[0].HasTunnel; }, v => { v.Ball[0].Amount = 1.5; },
    v => { v.BallConfig.TemplateID = 7001; }, v => { v.BallConfig.Common = 0; },
    v => { v.BallConfig.Special = 98765; }, v => { v.BallConfig.Special = v.BallConfig.Common; },
    v => { v.Ball[1].ID = v.Ball[0].ID; }, v => { v.metadata.bad = Infinity; }, v => { v.metadata = {}; },
  ];
  for (const change of changes) { const value = config(); change(value); assert.throws(() => validateWeaponPackage(value)); }
  const shared = config(); shared.Ball = [shared.Ball[0]];
  for (const key of ["Common", "CommonAddWound", "CommonMultiBall", "Special"]) shared.BallConfig[key] = shared.Ball[0].ID;
  assert.equal(validateWeaponPackage(shared).Ball.length, 1);
});

test("verify is read-only and creates no journal", async t => {
  const f = fixture(t), before = await rows(), result = await f.run();
  assert.equal(result.status, "ready"); assert.equal(result.installed, false);
  assert.deepEqual(result.inserted, { Shop_Goods: 0, BallConfig: 0, Ball: 0 });
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
});

test("install adds only the three owned sets and exact repeat is a no-op", async t => {
  const f = fixture(t), before = await rows(), first = await f.run("install"), installed = await rows();
  assert.equal(first.installed, true); assert.deepEqual(first.inserted, { Shop_Goods: 1, BallConfig: 1, Ball: 4 });
  assert.equal(first.playerDataWritten, false); assert.equal(first.fightAssetsLoaded, false); assert.equal(first.clientAccepted, false);
  assert.deepEqual(originalOnly(installed), before);
  const journal = readFileSync(f.journalPath), saved = JSON.parse(journal.toString("utf8"));
  assert.equal(saved.phase, "prepared"); assert.deepEqual(saved.package.metadata, config().metadata);
  assert.equal(installed.items.find(row => row.TemplateID === templateId)?.Property1, 0);
  assert.equal(installed.items.find(row => row.TemplateID === templateId)?.Property7, 247);
  for (const command of ["verify", "install"] as const) {
    const result = await f.run(command); assert.equal(result.status, "installed");
    assert.deepEqual(result.inserted, { Shop_Goods: 0, BallConfig: 0, Ball: 0 });
    assert.equal(result.journalPublished, false); assert.deepEqual(await rows(), installed);
  }
  assert.deepEqual(readFileSync(f.journalPath), journal);
});

test("simultaneous same-package installs create one weapon and one journal", async t => {
  const f = fixture(t), before = await rows();
  const result = await Promise.all([f.run("install"), f.run("install")]);
  assert.deepEqual(result.map(entry => entry.inserted.Shop_Goods).sort(), [0, 1]);
  assert.deepEqual(result.map(entry => entry.inserted.Ball).sort(), [0, 4]);
  assert.deepEqual(originalOnly(await rows()), before);
});

test("a fresh collision in any table is refused even when the existing row is identical", async t => {
  const f = fixture(t), value = config();
  const insertions = [
    () => h.db.insert(game.Shop_Goods).values({ ...value.Shop_Goods, AddTime: new Date(String(value.Shop_Goods.AddTime)) } as typeof game.Shop_Goods.$inferInsert),
    () => h.db.insert(game.BallConfig).values(value.BallConfig as typeof game.BallConfig.$inferInsert),
    () => h.db.insert(game.Ball).values(value.Ball[0] as typeof game.Ball.$inferInsert),
  ];
  for (const insert of insertions) {
    await insert(); const before = await rows();
    await assert.rejects(() => f.run("install"), /occupied without an ownership journal/);
    assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
    await h.db.execute(sql`DELETE FROM game."Shop_Goods" WHERE "TemplateID"=${templateId}`);
    await h.db.execute(sql`DELETE FROM game."BallConfig" WHERE "TemplateID"=${templateId}`);
    await h.db.execute(sql`DELETE FROM game."Ball" WHERE "ID"=${ballIds[0]}`);
  }
});

test("an absent Ball already referenced by another weapon cannot be claimed", async t => {
  const f = fixture(t);
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Special"=${ballIds[0]} WHERE "TemplateID"=7001`);
  const before = await rows(); await assert.rejects(() => f.run("install"), /already referenced/);
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
});

test("third-table failure rolls back all inserts; prepared journal permits only an empty-state safe retry", async t => {
  const f = fixture(t), before = await rows();
  await h.db.execute(sql`ALTER TABLE game."Ball" ADD CONSTRAINT reject_weapon_ball CHECK ("ID"<>143013)`);
  try { await assert.rejects(() => f.run("install")); }
  finally { await h.db.execute(sql`ALTER TABLE game."Ball" DROP CONSTRAINT reject_weapon_ball`); }
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), true);
  const preparedBytes = readFileSync(f.journalPath), verification = await f.run("verify");
  assert.equal(verification.status, "prepared"); assert.equal(verification.installed, false);
  assert.deepEqual(await rows(), before);
  const retry = await f.run("install"); assert.equal(retry.installed, true); assert.equal(retry.journalPublished, false);
  assert.deepEqual(retry.inserted, { Shop_Goods: 1, BallConfig: 1, Ball: 4 });
  assert.deepEqual(readFileSync(f.journalPath), preparedBytes); assert.deepEqual(originalOnly(await rows()), before);
});

test("journal publication failure leaves all three tables unchanged", async t => {
  const f = fixture(t), before = await rows(), blocked = join(f.path, "not-a-directory"); writeFileSync(blocked, "keep");
  await assert.rejects(() => f.run("install", { journalPath: join(blocked, "journal.json") }));
  assert.deepEqual(await rows(), before); assert.equal(readFileSync(blocked, "utf8"), "keep");
});

test("changed package, database binding, owned values, partial rows and missing journal are refused", async t => {
  const f = fixture(t); await f.run("install"); const initial = await rows(), journal = readFileSync(f.journalPath);
  const changed = config(); changed.Shop_Goods.Attack = 79;
  await assert.rejects(() => f.run("install", { config: changed }), /package differs/); assert.deepEqual(await rows(), initial);
  const changedSource = config(); changedSource.metadata.source = "different source";
  await assert.rejects(() => f.run("install", { config: changedSource }), /package differs/);
  await assert.rejects(() => f.run("install", { binding: { ...binding, databaseName: "other" } }), /different database/);
  await h.db.execute(sql`UPDATE game."Ball" SET "Power"=1.77 WHERE "ID"=${ballIds[0]}`);
  const drifted = await rows(); await assert.rejects(() => f.run("install"), /Ball rows differ/); assert.deepEqual(await rows(), drifted);
  await h.db.execute(sql`DELETE FROM game."Ball" WHERE "ID"=${ballIds[3]}`);
  const partial = await rows(); await assert.rejects(() => f.run("install"), /partial weapon installation/); assert.deepEqual(await rows(), partial);
  rmSync(f.journalPath); await assert.rejects(() => f.run("install"), /occupied without/); assert.deepEqual(await rows(), partial);
  writeFileSync(f.journalPath, journal);
});

test("session changes after writes roll back every row and leave only prepared intent", async t => {
  const f = fixture(t), before = await rows(); let checks = 0;
  await assert.rejects(() => f.run("install", { checkBinding: () => { if (++checks === 2) throw new Error("session changed"); } }), /session changed/);
  assert.equal(checks, 2); assert.deepEqual(await rows(), before);
  assert.equal((await f.run()).status, "prepared");
});

function referenceConfig(): WeaponPackage {
  const value = config();
  value.schemaVersion = 2; value.Ball = []; value.BallReferences = [structuredClone(sourceBall)];
  for (const key of ["Common", "CommonAddWound", "CommonMultiBall", "Special"]) value.BallConfig[key] = sourceBall.ID;
  return value;
}

test("v2 separates owned Ball rows from exact read-only dependencies and rejects ambiguous declarations", () => {
  const value = referenceConfig(), before = structuredClone(value), plan = planWeaponInstall(value);
  assert.deepEqual(value, before); assert.deepEqual(plan.ballIds, []); assert.deepEqual(plan.referencedBallIds, [sourceBall.ID]);
  assert.deepEqual(plan.counts, { Shop_Goods: 1, BallConfig: 1, Ball: 0 });
  const changes: ((v: WeaponPackage) => void)[] = [
    v => { delete v.BallReferences; }, v => { v.BallReferences = []; },
    v => { v.BallReferences!.push(structuredClone(sourceBall)); },
    v => { v.Ball.push(structuredClone(sourceBall)); },
    v => { delete v.BallReferences![0].HasTunnel; },
    v => { v.BallReferences![0].Amount = "3"; },
    v => { v.BallReferences![0].unexpected = true; },
    v => { v.BallReferences!.push({ ...sourceBall, ID: 107 }); },
    v => { v.BallConfig.Special = 98765; },
    v => { v.schemaVersion = 1; },
  ];
  for (const change of changes) { const modified = referenceConfig(); change(modified); assert.throws(() => validateWeaponPackage(modified)); }
  const two = referenceConfig(); two.BallReferences!.push({ ...sourceBall, ID: 107 }); two.BallConfig.Special = 107;
  const reversed = structuredClone(two); reversed.BallReferences!.reverse();
  assert.equal(planWeaponInstall(two).packageSha256, planWeaponInstall(reversed).packageSha256);
  const legacy = planWeaponInstall(config()); assert.equal(legacy.schemaVersion, 1);
  assert.equal(Object.hasOwn(legacy.config, "BallReferences"), false); assert.equal(Object.hasOwn(legacy, "referencedBallIds"), false);
});

test("v2 verify and install reuse a Ball already referenced by an old weapon without owning or writing it", async t => {
  const f = fixture(t), value = referenceConfig(), before = await rows();
  const verified = await f.run("verify", { config: value });
  assert.equal(verified.status, "ready"); assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
  const first = await f.run("install", { config: value }), installed = await rows();
  assert.deepEqual(first.inserted, { Shop_Goods: 1, BallConfig: 1, Ball: 0 });
  assert.deepEqual(first.ballIds, []); assert.deepEqual(first.referencedBallIds, [sourceBall.ID]);
  assert.deepEqual(installed.balls, before.balls); assert.deepEqual(originalOnly(installed), before);
  const journal = readFileSync(f.journalPath), saved = JSON.parse(journal.toString("utf8"));
  assert.equal(saved.schemaVersion, 1); assert.equal(saved.package.schemaVersion, 2);
  assert.deepEqual(saved.package.Ball, []); assert.deepEqual(saved.package.BallReferences, [sourceBall]);
  for (const command of ["verify", "install"] as const) {
    const repeat = await f.run(command, { config: value });
    assert.equal(repeat.status, "installed"); assert.deepEqual(repeat.inserted, { Shop_Goods: 0, BallConfig: 0, Ball: 0 });
    assert.deepEqual(await rows(), installed); assert.deepEqual(readFileSync(f.journalPath), journal);
  }
});

test("v2 checks every dependency column and missing rows before publishing a journal, including on repeat", async t => {
  const f = fixture(t), value = referenceConfig();
  for (const [key, original] of Object.entries(sourceBall)) {
    if (key === "ID") continue;
    const changed = typeof original === "number" ? original + 1 : typeof original === "boolean" ? !original : String(original) + "x";
    await h.db.execute(sql`UPDATE game."Ball" SET ${sql.identifier(key)}=${changed} WHERE "ID"=${sourceBall.ID}`);
    const drifted = await rows();
    for (const command of ["verify", "install"] as const) await assert.rejects(() => f.run(command, { config: value }), /BallReferences missing or changed/);
    assert.deepEqual(await rows(), drifted); assert.equal(existsSync(f.journalPath), false);
    await h.db.execute(sql`UPDATE game."Ball" SET ${sql.identifier(key)}=${original} WHERE "ID"=${sourceBall.ID}`);
  }
  await h.db.execute(sql`DELETE FROM game."Ball" WHERE "ID"=${sourceBall.ID}`);
  const missing = await rows(); await assert.rejects(() => f.run("install", { config: value }), /BallReferences missing or changed/);
  assert.deepEqual(await rows(), missing); assert.equal(existsSync(f.journalPath), false);
  await h.db.insert(game.Ball).values(sourceBall as typeof game.Ball.$inferInsert);
  await f.run("install", { config: value });
  await h.db.execute(sql`UPDATE game."Ball" SET "BombSound"='changed' WHERE "ID"=${sourceBall.ID}`);
  const drifted = await rows();
  await assert.rejects(() => f.run("install", { config: value }), /BallReferences missing or changed/);
  assert.deepEqual(await rows(), drifted);
});

test("v2 mixed packages create only new balls, allow shared dependencies, and still reject referenced new IDs", async t => {
  const f = fixture(t), value = referenceConfig(), newBall = config().Ball[0];
  value.Ball = [newBall]; value.BallConfig.Special = newBall.ID;
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Special"=${newBall.ID} WHERE "TemplateID"=7001`);
  const conflict = await rows(); await assert.rejects(() => f.run("install", { config: value }), /already referenced/);
  assert.deepEqual(await rows(), conflict); assert.equal(existsSync(f.journalPath), false);
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Special"=${sourceBall.ID} WHERE "TemplateID"=7001`);
  const before = await rows(), result = await f.run("install", { config: value }), installed = await rows();
  assert.deepEqual(result.ballIds, [newBall.ID]); assert.deepEqual(result.referencedBallIds, [sourceBall.ID]);
  assert.deepEqual(result.inserted, { Shop_Goods: 1, BallConfig: 1, Ball: 1 });
  assert.deepEqual(originalOnly(installed), before);
  assert.deepEqual((await f.run("install", { config: value })).inserted, { Shop_Goods: 0, BallConfig: 0, Ball: 0 });
});

test("v2 SQL failure preserves referenced rows and prepared retry revalidates dependencies", async t => {
  const f = fixture(t), value = referenceConfig(), before = await rows();
  await h.db.execute(sql`ALTER TABLE game."BallConfig" ADD CONSTRAINT reject_reference_weapon CHECK ("TemplateID"<>${sql.raw(String(templateId))})`);
  try { await assert.rejects(() => f.run("install", { config: value })); }
  finally { await h.db.execute(sql`ALTER TABLE game."BallConfig" DROP CONSTRAINT reject_reference_weapon`); }
  assert.deepEqual(await rows(), before); const journal = readFileSync(f.journalPath);
  assert.equal((await f.run("verify", { config: value })).status, "prepared");
  await h.db.execute(sql`UPDATE game."Ball" SET "Delay"="Delay"+1 WHERE "ID"=${sourceBall.ID}`);
  const drifted = await rows(); await assert.rejects(() => f.run("install", { config: value }), /BallReferences missing or changed/);
  assert.deepEqual(await rows(), drifted);
  await h.db.execute(sql`UPDATE game."Ball" SET "Delay"=${sourceBall.Delay} WHERE "ID"=${sourceBall.ID}`);
  assert.deepEqual((await f.run("install", { config: value })).inserted, { Shop_Goods: 1, BallConfig: 1, Ball: 0 });
  assert.deepEqual(readFileSync(f.journalPath), journal); assert.deepEqual((await rows()).balls, before.balls);
});

test("v2 insertion-trigger dependency drift is detected inside the transaction and fully rolled back", async t => {
  const f = fixture(t), value = referenceConfig(), before = await rows();
  await h.db.execute(sql`CREATE FUNCTION game.weapon_reference_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE game."Ball" SET "Power"="Power"+1 WHERE "ID"=106; RETURN NEW; END $$`);
  await h.db.execute(sql`CREATE TRIGGER weapon_reference_test_trigger AFTER INSERT ON game."BallConfig"
    FOR EACH ROW EXECUTE FUNCTION game.weapon_reference_test_trigger()`);
  try { await assert.rejects(() => f.run("install", { config: value }), /BallReferences missing or changed/); }
  finally {
    await h.db.execute(sql`DROP TRIGGER weapon_reference_test_trigger ON game."BallConfig"`);
    await h.db.execute(sql`DROP FUNCTION game.weapon_reference_test_trigger()`);
  }
  assert.deepEqual(await rows(), before); assert.equal((await f.run("verify", { config: value })).status, "prepared");
});

test("v2 shared dependency supports two independent owners and identical concurrent retries", async t => {
  const f = fixture(t), value = referenceConfig(), second = referenceConfig(), before = await rows();
  second.owner = "ddtank-workshop/weapon/another-test"; second.Shop_Goods.TemplateID = templateId + 1; second.BallConfig.TemplateID = templateId + 1;
  const result = await Promise.all([
    f.run("install", { config: value }), f.run("install", { config: value }),
    f.run("install", { config: second, journalPath: join(f.path, "second.json") }),
  ]);
  assert.deepEqual(result.map(x => x.inserted.Shop_Goods).sort(), [0, 1, 1]);
  assert.ok(result.every(x => x.inserted.Ball === 0));
  assert.deepEqual((await rows()).balls, before.balls);
});

test("v2 session failure after writes rolls back owned rows without changing dependencies", async t => {
  const f = fixture(t), value = referenceConfig(), before = await rows(); let checks = 0;
  await assert.rejects(() => f.run("install", { config: value, checkBinding: () => { if (++checks === 2) throw new Error("session changed"); } }), /session changed/);
  assert.equal(checks, 2); assert.deepEqual(await rows(), before);
  assert.equal((await f.run("verify", { config: value })).status, "prepared");
});
