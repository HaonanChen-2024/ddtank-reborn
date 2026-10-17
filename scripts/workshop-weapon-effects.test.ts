import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { createDb, game, type DbHandle } from "../packages/db/src/index.js";
import { q } from "../apps/api/src/lib/db.js";
import { planWeaponInstall, type WeaponPackage } from "./workshop-weapon.js";
import { readOfficialWeaponEvidence, runWeaponEffectsUpgrade, validateWeaponEffectsPackage, weaponEffectsPackage } from "./workshop-weapon-effects.js";
import { smithEnabledWeapon } from "./workshop-weapon-smith.js";

const { sql, getTableColumns } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const normalBall = { ID: 15601, Name: "local-bubble-tea-visual-adaptation-15601", Power: 1, Radii: 55,
  FlyingPartical: "7", BombPartical: "15601", Crater: "161", AttackResponse: 0, IsSpin: false, Mass: 10,
  SpinVA: 0, SpinV: 0, Amount: 1, Wind: 240, DragIndex: 1, Weight: 70, Shake: true,
  ShootSound: "025", BombSound: "087", Delay: 200, ActionType: 0, HasTunnel: true };
const visualPackage: WeaponPackage = { schemaVersion: 1, mode: "local-compat", owner: "ddtank-workshop/weapon/bubble-tea-7258",
  metadata: { source: "isolated effects regression fixture" },
  Shop_Goods: { TemplateID: 9107258, CanRecycle: 0, Name: "极·泡泡茶", Remark: "官方强0属性；本地4.1弹体效果兼容", CategoryID: 7,
    Description: "泡泡茶本地兼容配置。暂不开放强化、合成与转移。", Attack: 57, Defence: 200, Agility: 100, Luck: 81,
    Level: 1, Quality: 5, Pic: "15601", MaxCount: 1, NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false,
    CanDrop: true, CanEquip: true, CanUse: true, CanDelete: true, Script: "", Data: "", Colors: "", Property1: 0, Property2: 0,
    Property3: 0, Property4: 0, Property5: 20, Property6: 65, Property7: 235, Property8: 2, Valid: 0, Count: 1,
    AddTime: "2026-10-12T00:00:00.000Z", BindType: 1, FusionType: 0, FusionRate: 0, FusionNeedRate: 0,
    Hole: "0,-1|0,-1|0,-1|0,-1|0,-1|0,-1", RefineryLevel: 0, ReclaimValue: 100, ReclaimType: 1, FloorPrice: 0,
    SuitId: 0, CanTransfer: 0, Price: null, FineSuitType: 0 },
  BallConfig: { TemplateID: 9107258, Common: 15601, CommonAddWound: 156012, CommonMultiBall: 156011, Special: 156013 },
  Ball: [normalBall, { ...normalBall, ID: 156012, Name: "local-bubble-tea-visual-adaptation-156012", FlyingPartical: "118" },
    { ...normalBall, ID: 156011, Name: "local-bubble-tea-visual-adaptation-156011" },
    { ...normalBall, ID: 156013, Name: "local-bubble-tea-visual-adaptation-156013", Power: 0.6, Radii: 45, FlyingPartical: "8",
      BombPartical: "15602", Crater: "171", Amount: 3, ShootSound: "083", BombSound: "088" }] };
const oldIds = { 15601: 161, 156012: 1612, 156011: 1611, 156013: 171 };
const sharedPackage: WeaponPackage = { ...visualPackage, schemaVersion: 2, Ball: [],
  BallConfig: { TemplateID: 9107258, Common: 161, CommonAddWound: 1612, CommonMultiBall: 1611, Special: 171 },
  BallReferences: visualPackage.Ball.map(ball => { const id = oldIds[Number(ball.ID) as keyof typeof oldIds];
    return { ...ball, ID: id, Name: "Ball " + id, BombPartical: id === 171 ? "171" : "161" }; }) };
const binding = { databaseName: "isolated-effects-test", dataDirectory: "pglite:memory" };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const officialBallsXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Result value="true" message="Success!">' +
  [[15601, "1.0", 60, 518, 15601, 1, 254, 252], [156011, "1.0", 60, 518, 15601, 1, 255, 252],
    [156012, "1.0", 60, 518, 15601, 1, 256, 252], [156013, "0.65", 65, 498, 15602, 3, 257, 253]]
    .map(([id, power, radii, particle, bomb, amount, shoot, sound]) => `<Item ID="${id}" Power="${power}" Radii="${radii}" FlyingPartical="${particle}" BombPartical="${bomb}" Crater="${bomb}" AttackResponse="0" IsSpin="false" SpinV="0" SpinVA="0.0" Amount="${amount}" Wind="240" DragIndex="1" Weight="70" Shake="true" ShootSound="${shoot}" BombSound="${sound}" ActionType="0" Mass="10" BombType="0"/>`).join("") + "</Result>";
const officialBombXml = '<Result value="true" message="Success!"><Item TemplateID="7258" Common="15601" CommonAddWound="156012" CommonMultiBall="156011" Special="156013"/></Result>';
const officialEvidence = readOfficialWeaponEvidence(officialBallsXml, officialBombXml);
const effectsPackage = () => weaponEffectsPackage(visualPackage, officialEvidence, "official");
let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite:memory"); await h.db.execute(sql`CREATE SCHEMA game`);
  for (const [name, table, primary] of [["Shop_Goods", game.Shop_Goods, "TemplateID"], ["BallConfig", game.BallConfig, "TemplateID"], ["Ball", game.Ball, "ID"]] as const) {
    const columns = Object.entries(getTableColumns(table)).map(([key, column]) => '"' + key + '" ' + column.getSQLType() + (column.notNull ? " NOT NULL" : ""));
    await h.db.execute(sql.raw('CREATE TABLE game."' + name + '" (' + [...columns, 'PRIMARY KEY ("' + primary + '")'].join(",") + ')'));
  }
  await h.db.execute(sql`CREATE TABLE game.effects_test_audit (entry text)`);
  await h.db.execute(sql.raw(`CREATE FUNCTION game.effects_test_audit_write() RETURNS trigger AS $$ BEGIN INSERT INTO game.effects_test_audit VALUES (TG_TABLE_NAME || ':' || TG_OP); RETURN NEW; END $$ LANGUAGE plpgsql`));
  for (const name of ["Shop_Goods", "BallConfig", "Ball"]) await h.db.execute(sql.raw(`CREATE TRIGGER audit_write AFTER INSERT OR UPDATE OR DELETE ON game."${name}" FOR EACH ROW EXECUTE FUNCTION game.effects_test_audit_write()`));
}, 30000);
beforeEach(async () => {
  await h.db.execute(sql`DROP TRIGGER IF EXISTS effects_test_drift ON game."Ball"`);
  await h.db.execute(sql`ALTER TABLE game."Ball" DROP CONSTRAINT IF EXISTS effects_test_block`);
  await h.db.execute(sql`TRUNCATE game."Shop_Goods", game."BallConfig", game."Ball", game.effects_test_audit`);
  await h.db.insert(game.Shop_Goods).values({ ...visualPackage.Shop_Goods, AddTime: new Date(String(visualPackage.Shop_Goods.AddTime)) } as typeof game.Shop_Goods.$inferInsert);
  await h.db.insert(game.Ball).values([...visualPackage.Ball, ...sharedPackage.BallReferences!] as (typeof game.Ball.$inferInsert)[]);
  await h.db.insert(game.BallConfig).values([visualPackage.BallConfig, { ...sharedPackage.BallConfig, TemplateID: 7006 }] as (typeof game.BallConfig.$inferInsert)[]);
  await h.db.execute(sql`TRUNCATE game.effects_test_audit`);
});
afterAll(async () => { await h?.close(); });

function fixture(t: { onTestFinished: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), "ddt-weapon-effects-"));
  assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir()));
  t.onTestFinished(() => { assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir())); rmSync(path, { recursive: true, force: true }); });
  const visualJournalPath = join(path, "visual-upgrade.json"), upgradeJournalPath = join(path, "effects-upgrade.json");
  const journal = { schemaVersion: 1, phase: "prepared", owner: visualPackage.owner, templateId: 9107258, binding,
    originalJournal: { path: join(path, "original.json"), sha256: "a".repeat(64), packageSha256: planWeaponInstall(sharedPackage).packageSha256 },
    oldPackageSha256: planWeaponInstall(sharedPackage).packageSha256, newPackageSha256: planWeaponInstall(visualPackage).packageSha256,
    oldPackage: sharedPackage, newPackage: visualPackage };
  writeFileSync(visualJournalPath, JSON.stringify(journal, null, 2) + "\n");
  const run = (extra: Partial<Parameters<typeof runWeaponEffectsUpgrade>[1]> = {}) => runWeaponEffectsUpgrade(h, {
    visualConfig: visualPackage, officialEvidence, particleMode: "official", binding, visualJournalPath, upgradeJournalPath, ...extra });
  return { path, visualJournalPath, upgradeJournalPath, journal, run };
}
async function rows() {
  return { items: await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`),
    configs: await q(h, sql`SELECT * FROM game."BallConfig" ORDER BY "TemplateID"`),
    balls: await q(h, sql`SELECT * FROM game."Ball" ORDER BY "ID"`),
    audit: await q(h, sql`SELECT * FROM game.effects_test_audit ORDER BY entry`) };
}

test("official XML proves six differing columns; all local-only and other official columns stay intact", () => {
  const original = structuredClone(visualPackage), result = effectsPackage();
  assert.deepEqual(visualPackage, original); assert.deepEqual(validateWeaponEffectsPackage(visualPackage, result, officialEvidence, "official"), result);
  const sounds = new Map([[15601, "254"], [156012, "256"], [156011, "255"], [156013, "257"]]);
  for (const ball of result.Ball) assert.deepEqual(ball, { ...visualPackage.Ball.find(r => r.ID === ball.ID),
    Crater: ball.ID === 156013 ? "15602" : "15601", FlyingPartical: ball.ID === 156013 ? "498" : "518",
    Power: ball.ID === 156013 ? 0.65 : 1, Radii: ball.ID === 156013 ? 65 : 60,
    ShootSound: sounds.get(Number(ball.ID)), BombSound: ball.ID === 156013 ? "253" : "252" });
  for (const key of ["Power", "Radii", "Mass", "Amount", "Delay", "BombPartical", "Crater", "ShootSound"])
    assert.throws(() => { const changed = structuredClone(result); changed.Ball[0][key] = typeof changed.Ball[0][key] === "number" ? Number(changed.Ball[0][key]) + 1 : "wrong"; validateWeaponEffectsPackage(visualPackage, changed, officialEvidence, "official"); });
  assert.throws(() => weaponEffectsPackage(sharedPackage, officialEvidence, "official"));
  assert.throws(() => weaponEffectsPackage({ ...visualPackage, BallConfig: { ...visualPackage.BallConfig, Common: 156012, CommonAddWound: 15601 } }, officialEvidence, "official"));
});

test("XML evidence retains raw attributes and whole-file hashes; missing, duplicate and malformed records fail closed", () => {
  assert.equal(officialEvidence.ballListSha256, hash(Buffer.from(officialBallsXml)));
  assert.equal(officialEvidence.bombConfigSha256, hash(Buffer.from(officialBombXml)));
  assert.equal(officialEvidence.Ball[0].Power, "1.0"); assert.equal(officialEvidence.Ball[0].IsSpin, "false");
  for (const xml of [officialBallsXml.replace('ID="15601"', 'ID="999"'),
    officialBallsXml.replace('ID="15601"', 'ID="15601" ID="15601"'),
    officialBallsXml.replace('ID="15601"', 'ID="156011"'),
    officialBallsXml.replace(' BombType="0"', ''),
    officialBallsXml.replace('<Item ', '<Item unexpected '),
    officialBallsXml.replace('Power="1.0"', 'Power="&external;"'),
    officialBallsXml.replace('<Result ', '<!DOCTYPE Result><Result ')]) assert.throws(() => readOfficialWeaponEvidence(xml, officialBombXml));
  assert.throws(() => readOfficialWeaponEvidence(officialBallsXml, officialBombXml.replace('Common="15601"', 'Common="156012"')));
  assert.throws(() => readOfficialWeaponEvidence(officialBallsXml, officialBombXml.replace('</Result>', officialBombXml.match(/<Item[^>]+\/>/)![0] + '</Result>')));
});

test("unsupported official differences and invalid types cannot enlarge the approved six-column migration", () => {
  for (const [key, value] of [["Mass", "11"], ["BombPartical", "other"], ["Amount", "2"], ["BombType", "1"],
    ["Power", "NaN"], ["Radii", "60.5"], ["Shake", "0"], ["NewPhysics", "1"]]) {
    const evidence = structuredClone(officialEvidence); evidence.Ball[0][key] = value;
    assert.throws(() => weaponEffectsPackage(visualPackage, evidence, "official"));
  }
});

test("retained particle mode preserves only old trails while applying every other official difference", async t => {
  const f = fixture(t), official = effectsPackage(), retained = weaponEffectsPackage(visualPackage, officialEvidence, "retained");
  for (const ball of retained.Ball) assert.deepEqual(ball, { ...official.Ball.find(row => row.ID === ball.ID),
    FlyingPartical: visualPackage.Ball.find(row => row.ID === ball.ID)!.FlyingPartical });
  const result = await f.run({ particleMode: "retained" }); assert.equal(result.particleMode, "retained");
  assert.deepEqual((await rows()).balls.filter(row => Number(row.ID) >= 10000), retained.Ball);
  assert.equal((await f.run({ particleMode: "retained" })).status, "unchanged");
  const before = await rows(); await assert.rejects(f.run(), /effects ownership journal differs/); assert.deepEqual(await rows(), before);
});

test("exact owned state updates four Ball rows, preserves all other rows and journals, then is idempotent", async t => {
  const f = fixture(t), before = await rows(), originalBytes = readFileSync(f.visualJournalPath), first = await f.run(), installed = await rows();
  assert.equal(first.status, "upgraded"); assert.deepEqual(first.updated, { Ball: 4 }); assert.equal(first.journalPublished, true);
  assert.equal(first.playerDataWritten, false); assert.equal(first.resourcesWritten, false);
  assert.deepEqual(installed.items, before.items); assert.deepEqual(installed.configs, before.configs);
  assert.deepEqual(installed.balls.filter(r => Number(r.ID) < 10000), before.balls.filter(r => Number(r.ID) < 10000));
  assert.deepEqual(installed.balls.filter(r => Number(r.ID) >= 10000), effectsPackage().Ball);
  assert.deepEqual(installed.audit, Array.from({ length: 4 }, () => ({ entry: "Ball:UPDATE" })));
  const bytes = readFileSync(f.upgradeJournalPath), time = statSync(f.upgradeJournalPath).mtimeMs, intent = JSON.parse(bytes.toString("utf8"));
  assert.equal(intent.visualJournal.sha256, hash(originalBytes)); assert.equal(intent.visualJournal.packageSha256, planWeaponInstall(visualPackage).packageSha256);
  assert.equal(intent.selection, "official-capture-v17.1.1"); assert.equal(intent.particleMode, "official");
  assert.deepEqual(intent.officialEvidence, officialEvidence); assert.equal(intent.officialEvidenceSha256, first.officialEvidenceSha256);
  for (let i = 0; i < 2; i++) { const result = await f.run(); assert.equal(result.status, "unchanged"); assert.deepEqual(result.updated, { Ball: 0 });
    assert.equal(result.journalPublished, false); assert.deepEqual(await rows(), installed); }
  assert.deepEqual(readFileSync(f.visualJournalPath), originalBytes); assert.deepEqual(readFileSync(f.upgradeJournalPath), bytes);
  assert.equal(statSync(f.upgradeJournalPath).mtimeMs, time);
});

test("the exact smith-enabled Shop_Goods is accepted before and after effects without item writes", async t => {
  const f = fixture(t), smith = smithEnabledWeapon(visualPackage.Shop_Goods);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "Level"=3, "CanStrengthen"=true, "CanCompose"=true,
    "CanTransfer"=1, "Description"=${smith.Description} WHERE "TemplateID"=9107258`);
  const before = await rows(); assert.equal((await f.run()).status, "upgraded"); assert.equal((await f.run()).status, "unchanged");
  assert.deepEqual((await rows()).items, before.items);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "Attack"="Attack"+1 WHERE "TemplateID"=9107258`);
  const drift = await rows(); await assert.rejects(f.run(), /owned Shop_Goods/); assert.deepEqual(await rows(), drift);
});

test("physics, visual and mixed effect drift are rejected before ownership publication", async t => {
  const f = fixture(t);
  for (const change of [sql`UPDATE game."Ball" SET "Power"=2 WHERE "ID"=15601`,
    sql`UPDATE game."Ball" SET "Crater"='20' WHERE "ID"=15601`,
    sql`UPDATE game."Ball" SET "ShootSound"='254' WHERE "ID"=15601`,
    sql`UPDATE game."Ball" SET "BombPartical"='changed' WHERE "ID"=15601`]) {
    const ball = visualPackage.Ball[0]; await h.db.execute(sql`UPDATE game."Ball" SET "Power"=${ball.Power}, "Crater"=${ball.Crater},
      "ShootSound"=${ball.ShootSound}, "BombPartical"=${ball.BombPartical} WHERE "ID"=15601`);
    await h.db.execute(change); const before = await rows(); await assert.rejects(f.run(), /partial, mixed or changed/);
    assert.deepEqual(await rows(), before); assert.equal(existsSync(f.upgradeJournalPath), false);
  }
});

test("missing rows, changed complete mappings and shared ownership are refused", async t => {
  const f = fixture(t);
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Common"=15601 WHERE "TemplateID"=7006`);
  let before = await rows(); await assert.rejects(f.run(), /shared or unreferenced/); assert.deepEqual(await rows(), before);
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Common"=161 WHERE "TemplateID"=7006`);
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Common"=156012, "CommonAddWound"=15601 WHERE "TemplateID"=9107258`);
  before = await rows(); await assert.rejects(f.run(), /owned BallConfig/); assert.deepEqual(await rows(), before);
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Common"=15601, "CommonAddWound"=156012 WHERE "TemplateID"=9107258`);
  await h.db.execute(sql`DELETE FROM game."Ball" WHERE "ID"=156013`);
  before = await rows(); await assert.rejects(f.run(), /partial, mixed or changed/); assert.deepEqual(await rows(), before);
  assert.equal(existsSync(f.upgradeJournalPath), false);
});

test("new state without an intent cannot be adopted; newly shared effects state is refused", async t => {
  const f = fixture(t); await f.run(); const intent = readFileSync(f.upgradeJournalPath); rmSync(f.upgradeJournalPath);
  let before = await rows(); await assert.rejects(f.run(), /no effects ownership journal/); assert.deepEqual(await rows(), before);
  writeFileSync(f.upgradeJournalPath, intent);
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Common"=15601 WHERE "TemplateID"=7006`);
  before = await rows(); await assert.rejects(f.run(), /shared or unreferenced/); assert.deepEqual(await rows(), before);
});

test("visual journal package, owner and database binding changes cannot grant effects ownership", async t => {
  const f = fixture(t), bytes = readFileSync(f.visualJournalPath), before = await rows();
  for (const mutate of [
    (j: typeof f.journal) => { j.binding.databaseName = "elsewhere"; },
    (j: typeof f.journal) => { j.owner += "-other"; },
    (j: typeof f.journal) => { j.newPackageSha256 = "0".repeat(64); },
    (j: typeof f.journal) => { j.newPackage.metadata.changed = true; },
    (j: typeof f.journal) => { j.oldPackageSha256 = "0".repeat(64); },
    (j: typeof f.journal) => { j.phase = "unknown"; },
  ]) { const journal = JSON.parse(bytes.toString("utf8")); mutate(journal); writeFileSync(f.visualJournalPath, JSON.stringify(journal));
    await assert.rejects(f.run()); assert.deepEqual(await rows(), before); assert.equal(existsSync(f.upgradeJournalPath), false); }
});

test("durable intent precedes UPDATE; binding failure leaves exact old state and retryable unchanged intent", async t => {
  const f = fixture(t), before = await rows(); let checks = 0;
  await assert.rejects(f.run({ checkBinding() { if (++checks === 2) { assert.equal(existsSync(f.upgradeJournalPath), true); throw Error("injected binding failure"); } } }), /injected binding failure/);
  assert.deepEqual(await rows(), before); const bytes = readFileSync(f.upgradeJournalPath);
  assert.equal((await f.run()).status, "upgraded"); assert.deepEqual(readFileSync(f.upgradeJournalPath), bytes);
});

test("visual/effects journal drift is refused without overwriting external bytes", async t => {
  const f = fixture(t), before = await rows(), original = readFileSync(f.visualJournalPath); let checks = 0;
  const changed = Buffer.concat([original, Buffer.from(" ")]);
  await assert.rejects(f.run({ checkBinding() { if (++checks === 2) writeFileSync(f.visualJournalPath, changed); } }), /visual journal changed/);
  assert.deepEqual(await rows(), before); assert.deepEqual(readFileSync(f.visualJournalPath), changed);
  await assert.rejects(f.run(), /effects ownership journal differs/);
  writeFileSync(f.visualJournalPath, original); const intent = JSON.parse(readFileSync(f.upgradeJournalPath, "utf8"));
  intent.newPackageSha256 = "f".repeat(64); writeFileSync(f.upgradeJournalPath, JSON.stringify(intent));
  await assert.rejects(f.run(), /effects ownership journal differs/); assert.deepEqual(await rows(), before);
});

test("constraint or trigger changes roll back owned rows and old shared rows", async t => {
  const f = fixture(t), before = await rows();
  await h.db.execute(sql`ALTER TABLE game."Ball" ADD CONSTRAINT effects_test_block CHECK ("ID" <> 156011 OR "Crater" <> '15601')`);
  await assert.rejects(f.run()); assert.deepEqual(await rows(), before);
  await h.db.execute(sql`ALTER TABLE game."Ball" DROP CONSTRAINT effects_test_block`);
  await h.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION game.effects_test_drift() RETURNS trigger AS $$ BEGIN
    IF NEW."ID"=15601 THEN UPDATE game."Ball" SET "Power"="Power"+1 WHERE "ID"=161; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`));
  await h.db.execute(sql`CREATE TRIGGER effects_test_drift AFTER UPDATE ON game."Ball" FOR EACH ROW EXECUTE FUNCTION game.effects_test_drift()`);
  await assert.rejects(f.run(), /old shared Ball/); assert.deepEqual(await rows(), before);
  await h.db.execute(sql`DROP TRIGGER effects_test_drift ON game."Ball"`); assert.equal((await f.run()).status, "upgraded");
});

test("official source hash, attribute and selection drift cannot adopt a previous intent", async t => {
  const f = fixture(t); await f.run(); const before = await rows();
  for (const mutate of [(e: typeof officialEvidence) => { e.ballListSha256 = "b".repeat(64); },
    (e: typeof officialEvidence) => { e.bombConfigSha256 = "c".repeat(64); },
    (e: typeof officialEvidence) => { e.Ball[0].Power = "1.00"; }]) {
    const evidence = structuredClone(officialEvidence); mutate(evidence);
    await assert.rejects(f.run({ officialEvidence: evidence }), /effects ownership journal differs/); assert.deepEqual(await rows(), before);
  }
  const bytes = readFileSync(f.upgradeJournalPath), intent = JSON.parse(bytes.toString()); intent.selection = "local-option-c";
  writeFileSync(f.upgradeJournalPath, JSON.stringify(intent)); await assert.rejects(f.run(), /effects ownership journal differs/);
  assert.deepEqual(await rows(), before);
});

test("journal path/publication errors fail before database changes", async t => {
  const f = fixture(t), before = await rows(), blocked = join(f.path, "blocked"); writeFileSync(blocked, "file");
  await assert.rejects(f.run({ upgradeJournalPath: f.visualJournalPath }), /must be separate/);
  await assert.rejects(f.run({ upgradeJournalPath: join(blocked, "intent.json") }));
  await assert.rejects(f.run({ checkBinding() { throw Error("initial binding failure"); } }), /initial binding failure/);
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.upgradeJournalPath), false);
});
