import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { createDb, game, type DbHandle } from "../packages/db/src/index.js";
import { q } from "../apps/api/src/lib/db.js";
import { planWeaponInstall, type WeaponPackage } from "./workshop-weapon.js";
import { runWeaponVisualUpgrade } from "./workshop-weapon-visuals.js";
import { smithEnabledWeapon } from "./workshop-weapon-smith.js";

const { sql, getTableColumns } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
// Frozen exact copies of the previously owned package and the official visual candidate; no runtime fixture dependency.
const oldPackage: WeaponPackage = {"schemaVersion":2,"mode":"local-compat","owner":"ddtank-workshop/weapon/bubble-tea-7258","metadata":{"status":"prepared-schema-v2-not-installed-or-live-verified","officialTemplateId":7258,"stage":"strong0","proposedLocalTemplateId":9107258,"liveIdAvailabilityChecked":false,"officialStatsSource":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\runtime\\online-box-followup-20261013\\weapon-next\\evidence.json","officialAssetsSource":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\runtime\\online-box-followup-20261013\\weapon-next\\assets\\manifest.json","localRuleBase":{"templateId":7001,"policy":"existing cream compatibility rules; no strengthening/composition/transfer"},"localCombatSource":{"templateId":7006,"branchSource":{"path":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\source\\ddtank-reborn\\packages\\db\\seed\\game\\BallConfig.json.gz","bytes":6850,"sha256":"e4da3c98dad8a2f6448fe7e6aad40b65930487a5f2ef1562cb971b666218fa9b"},"ballSource":{"path":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\source\\ddtank-reborn\\packages\\db\\seed\\game\\Ball.json.gz","bytes":18422,"sha256":"1b5c47877f844a25d72b4b098cb372d88a4637d222fe64e7f5ea3610f89ef6fa"},"classification":"local-4.1-compatibility-not-official-bubble-tea"},"visualSplit":"official bubble-tea equipment PNGs; existing local 7006 projectile/explosion/crater/sound/particle effects","dependencyPolicy":"BallReferences are immutable expected snapshots, never inserted/updated/deleted/owned by this package"},"Shop_Goods":{"TemplateID":9107258,"CanRecycle":0,"Name":"极·泡泡茶","Remark":"官方强0属性；本地4.1弹体效果兼容","CategoryID":7,"Description":"泡泡茶官方强0属性与装备外观；弹体、爆炸、坑形、声音、尾迹及物理采用本地7006兼容配置，非官方泡泡茶特效。暂不开放强化、合成与转移。","Attack":57,"Defence":200,"Agility":100,"Luck":81,"Level":1,"Quality":5,"Pic":"15601","MaxCount":1,"NeedSex":0,"NeedLevel":1,"CanStrengthen":false,"CanCompose":false,"CanDrop":true,"CanEquip":true,"CanUse":true,"CanDelete":true,"Script":"","Data":"","Colors":"","Property1":0,"Property2":0,"Property3":0,"Property4":0,"Property5":20,"Property6":65,"Property7":235,"Property8":2,"Valid":0,"Count":1,"AddTime":"2026-10-12T00:00:00.000Z","BindType":1,"FusionType":0,"FusionRate":0,"FusionNeedRate":0,"Hole":"0,-1|0,-1|0,-1|0,-1|0,-1|0,-1","RefineryLevel":0,"ReclaimValue":100,"ReclaimType":1,"FloorPrice":0,"SuitId":0,"CanTransfer":0,"Price":null,"FineSuitType":0},"BallConfig":{"TemplateID":9107258,"Common":161,"CommonAddWound":1612,"CommonMultiBall":1611,"Special":171},"Ball":[],"BallReferences":[{"ID":161,"Name":"Ball 161","Power":1,"Radii":55,"FlyingPartical":"7","BombPartical":"161","Crater":"161","AttackResponse":0,"IsSpin":false,"Mass":10,"SpinVA":0,"SpinV":0,"Amount":1,"Wind":240,"DragIndex":1,"Weight":70,"Shake":true,"ShootSound":"025","BombSound":"087","Delay":200,"ActionType":0,"HasTunnel":true},{"ID":171,"Name":"Ball 171","Power":0.6,"Radii":45,"FlyingPartical":"8","BombPartical":"171","Crater":"171","AttackResponse":0,"IsSpin":false,"Mass":10,"SpinVA":0,"SpinV":0,"Amount":3,"Wind":240,"DragIndex":1,"Weight":70,"Shake":true,"ShootSound":"083","BombSound":"088","Delay":200,"ActionType":0,"HasTunnel":true},{"ID":1611,"Name":"Ball 1611","Power":1,"Radii":55,"FlyingPartical":"7","BombPartical":"161","Crater":"161","AttackResponse":0,"IsSpin":false,"Mass":10,"SpinVA":0,"SpinV":0,"Amount":1,"Wind":240,"DragIndex":1,"Weight":70,"Shake":true,"ShootSound":"025","BombSound":"087","Delay":200,"ActionType":0,"HasTunnel":true},{"ID":1612,"Name":"Ball 1612","Power":1,"Radii":55,"FlyingPartical":"118","BombPartical":"161","Crater":"161","AttackResponse":0,"IsSpin":false,"Mass":10,"SpinVA":0,"SpinV":0,"Amount":1,"Wind":240,"DragIndex":1,"Weight":70,"Shake":true,"ShootSound":"025","BombSound":"087","Delay":200,"ActionType":0,"HasTunnel":true}]};
const newPackage: WeaponPackage = {"schemaVersion":1,"mode":"local-compat","owner":"ddtank-workshop/weapon/bubble-tea-7258","metadata":{"status":"prepared-official-visual-local-binding-not-installed-or-live-verified","officialTemplateId":7258,"stage":"strong0","proposedLocalTemplateId":9107258,"liveIdAvailabilityChecked":false,"officialStatsSource":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\runtime\\online-box-followup-20261013\\weapon-next\\evidence.json","officialAssetsSource":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\runtime\\online-box-followup-20261013\\weapon-next\\assets\\manifest.json","localRuleBase":{"templateId":7001,"policy":"existing cream compatibility rules; no strengthening/composition/transfer"},"localCombatSource":{"templateId":7006,"branchSource":{"path":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\source\\ddtank-reborn\\packages\\db\\seed\\game\\BallConfig.json.gz","bytes":6850,"sha256":"e4da3c98dad8a2f6448fe7e6aad40b65930487a5f2ef1562cb971b666218fa9b"},"ballSource":{"path":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\source\\ddtank-reborn\\packages\\db\\seed\\game\\Ball.json.gz","bytes":18422,"sha256":"1b5c47877f844a25d72b4b098cb372d88a4637d222fe64e7f5ea3610f89ef6fa"},"classification":"local-4.1-compatibility-not-official-bubble-tea"},"visualSplit":"Unmodified official DIY projectile and explosion SWFs; local compatibility branch binding, physics, crater, sound and trail.","dependencyPolicy":"Own only these four newly cloned Ball rows; preserve all former reference rows and all Shop_Goods fields.","bindingEvidence":"candidate-address-not-authoritative-binding","officialBallConfigObtained":false,"officialVisuals":true,"localVisualAdaptation":true,"soundAndTrail":"unchanged local 7006 compatibility","priorPackage":{"path":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\runtime\\online-box-followup-20261013\\weapon-next\\database-v2-ready.json","sha256":"d4b2dc89551d6eb620934c35a841004db99b02c462284c7cb74770002a52513e","bytes":5248},"priorFightExtension":{"path":"C:\\Users\\11322\\Desktop\\新方向\\DDTank-Workshop\\runtime\\online-box-followup-20261013\\weapon-next\\fight-combined-candidate.json","sha256":"475d9572b46734808a065b1fb3eb176ca430ed704a688750701161214a075c66","bytes":9729},"branchMapping":[{"branch":"Common","oldBallId":161,"newBallId":15601,"bombPartical":"15601","craterPreserved":"161"},{"branch":"CommonAddWound","oldBallId":1612,"newBallId":156012,"bombPartical":"15601","craterPreserved":"161"},{"branch":"CommonMultiBall","oldBallId":1611,"newBallId":156011,"bombPartical":"15601","craterPreserved":"161"},{"branch":"Special","oldBallId":171,"newBallId":156013,"bombPartical":"15602","craterPreserved":"171"}],"actualDatabaseIdAvailabilityChecked":false},"Shop_Goods":{"TemplateID":9107258,"CanRecycle":0,"Name":"极·泡泡茶","Remark":"官方强0属性；本地4.1弹体效果兼容","CategoryID":7,"Description":"泡泡茶官方强0属性与装备外观；弹体、爆炸、坑形、声音、尾迹及物理采用本地7006兼容配置，非官方泡泡茶特效。暂不开放强化、合成与转移。","Attack":57,"Defence":200,"Agility":100,"Luck":81,"Level":1,"Quality":5,"Pic":"15601","MaxCount":1,"NeedSex":0,"NeedLevel":1,"CanStrengthen":false,"CanCompose":false,"CanDrop":true,"CanEquip":true,"CanUse":true,"CanDelete":true,"Script":"","Data":"","Colors":"","Property1":0,"Property2":0,"Property3":0,"Property4":0,"Property5":20,"Property6":65,"Property7":235,"Property8":2,"Valid":0,"Count":1,"AddTime":"2026-10-12T00:00:00.000Z","BindType":1,"FusionType":0,"FusionRate":0,"FusionNeedRate":0,"Hole":"0,-1|0,-1|0,-1|0,-1|0,-1|0,-1","RefineryLevel":0,"ReclaimValue":100,"ReclaimType":1,"FloorPrice":0,"SuitId":0,"CanTransfer":0,"Price":null,"FineSuitType":0},"BallConfig":{"TemplateID":9107258,"Common":15601,"CommonAddWound":156012,"CommonMultiBall":156011,"Special":156013},"Ball":[{"ID":15601,"Name":"local-bubble-tea-visual-adaptation-15601","Power":1,"Radii":55,"FlyingPartical":"7","BombPartical":"15601","Crater":"161","AttackResponse":0,"IsSpin":false,"Mass":10,"SpinVA":0,"SpinV":0,"Amount":1,"Wind":240,"DragIndex":1,"Weight":70,"Shake":true,"ShootSound":"025","BombSound":"087","Delay":200,"ActionType":0,"HasTunnel":true},{"ID":156012,"Name":"local-bubble-tea-visual-adaptation-156012","Power":1,"Radii":55,"FlyingPartical":"118","BombPartical":"15601","Crater":"161","AttackResponse":0,"IsSpin":false,"Mass":10,"SpinVA":0,"SpinV":0,"Amount":1,"Wind":240,"DragIndex":1,"Weight":70,"Shake":true,"ShootSound":"025","BombSound":"087","Delay":200,"ActionType":0,"HasTunnel":true},{"ID":156011,"Name":"local-bubble-tea-visual-adaptation-156011","Power":1,"Radii":55,"FlyingPartical":"7","BombPartical":"15601","Crater":"161","AttackResponse":0,"IsSpin":false,"Mass":10,"SpinVA":0,"SpinV":0,"Amount":1,"Wind":240,"DragIndex":1,"Weight":70,"Shake":true,"ShootSound":"025","BombSound":"087","Delay":200,"ActionType":0,"HasTunnel":true},{"ID":156013,"Name":"local-bubble-tea-visual-adaptation-156013","Power":0.6,"Radii":45,"FlyingPartical":"8","BombPartical":"15602","Crater":"171","AttackResponse":0,"IsSpin":false,"Mass":10,"SpinVA":0,"SpinV":0,"Amount":3,"Wind":240,"DragIndex":1,"Weight":70,"Shake":true,"ShootSound":"083","BombSound":"088","Delay":200,"ActionType":0,"HasTunnel":true}]};

const binding = { databaseName: "isolated-visual-test", dataDirectory: "pglite:memory" };
const oldIds = planWeaponInstall(oldPackage).referencedBallIds!, newIds = planWeaponInstall(newPackage).ballIds;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite:memory");
  await h.db.execute(sql`CREATE SCHEMA game`);
  // Only the three authoritative table schemas are needed; avoid the full game migration/seed pipeline.
  for (const [name, table, primary] of [["Shop_Goods", game.Shop_Goods, "TemplateID"], ["BallConfig", game.BallConfig, "TemplateID"], ["Ball", game.Ball, "ID"]] as const) {
    const columns = Object.entries(getTableColumns(table)).map(([key, column]) => '"' + key + '" ' + column.getSQLType() + (column.notNull ? " NOT NULL" : ""));
    await h.db.execute(sql.raw('CREATE TABLE game."' + name + '" (' + [...columns, 'PRIMARY KEY ("' + primary + '")'].join(",") + ')'));
  }
  await h.db.execute(sql`CREATE TABLE game.visual_test_audit (entry text)`);
  await h.db.execute(sql.raw(`CREATE FUNCTION game.visual_test_audit_write() RETURNS trigger AS $$ BEGIN INSERT INTO game.visual_test_audit VALUES (TG_TABLE_NAME || ':' || TG_OP); RETURN NEW; END $$ LANGUAGE plpgsql`));
  for (const name of ["Shop_Goods", "BallConfig", "Ball"]) await h.db.execute(sql.raw(`CREATE TRIGGER audit_write AFTER INSERT OR UPDATE OR DELETE ON game."${name}" FOR EACH ROW EXECUTE FUNCTION game.visual_test_audit_write()`));
}, 30000);
beforeEach(async () => {
  await h.db.execute(sql`DROP TRIGGER IF EXISTS visual_test_change_old ON game."BallConfig"`);
  await h.db.execute(sql`ALTER TABLE game."Ball" DROP CONSTRAINT IF EXISTS visual_test_block`);
  await h.db.execute(sql`TRUNCATE game."Shop_Goods", game."BallConfig", game."Ball", game.visual_test_audit`);
  await h.db.insert(game.Shop_Goods).values({ ...oldPackage.Shop_Goods, AddTime: oldPackage.Shop_Goods.AddTime === null ? null : new Date(String(oldPackage.Shop_Goods.AddTime)) } as typeof game.Shop_Goods.$inferInsert);
  await h.db.insert(game.Ball).values(oldPackage.BallReferences! as (typeof game.Ball.$inferInsert)[]);
  await h.db.insert(game.BallConfig).values(oldPackage.BallConfig as typeof game.BallConfig.$inferInsert);
  // Another real branch retains all four shared old IDs throughout the upgrade.
  await h.db.insert(game.BallConfig).values({ ...oldPackage.BallConfig, TemplateID: 7006 } as typeof game.BallConfig.$inferInsert);
  await h.db.execute(sql`TRUNCATE game.visual_test_audit`);
});
afterAll(async () => { await h?.close(); });

function fixture(t: { onTestFinished: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), "ddt-weapon-visuals-"));
  assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir()));
  t.onTestFinished(() => { assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir())); rmSync(path, { recursive: true, force: true }); });
  const originalJournalPath = join(path, "original.json"), upgradeJournalPath = join(path, "visual-upgrade.json");
  const journal = { schemaVersion: 1, phase: "prepared", binding, packageSha256: planWeaponInstall(oldPackage).packageSha256, package: oldPackage };
  writeFileSync(originalJournalPath, JSON.stringify(journal, null, 2) + "\n");
  const run = (extra: Partial<Parameters<typeof runWeaponVisualUpgrade>[1]> = {}) => runWeaponVisualUpgrade(h, {
    oldConfig: oldPackage, newConfig: newPackage, binding, originalJournalPath, upgradeJournalPath, ...extra,
  });
  return { path, originalJournalPath, upgradeJournalPath, run, journal };
}
async function rows() {
  return { items: await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`),
    configs: await q(h, sql`SELECT * FROM game."BallConfig" ORDER BY "TemplateID"`),
    balls: await q(h, sql`SELECT * FROM game."Ball" ORDER BY "ID"`),
    audit: await q(h, sql`SELECT * FROM game.visual_test_audit ORDER BY entry`) };
}
function preserved(state: Awaited<ReturnType<typeof rows>>) {
  return { items: state.items, configs: state.configs.filter(row => row.TemplateID !== 9107258), balls: state.balls.filter(row => oldIds.includes(Number(row.ID))) };
}

test("exact owned package upgrades only four visual rows and branch bindings; repeat does not write", async t => {
  const f = fixture(t), before = await rows(), originalBytes = readFileSync(f.originalJournalPath), first = await f.run(), installed = await rows();
  assert.equal(first.status, "upgraded"); assert.deepEqual(first.inserted, { Ball: 4 }); assert.deepEqual(first.updated, { BallConfig: 1 });
  assert.equal(first.journalPublished, true); assert.equal(first.playerDataWritten, false); assert.equal(first.resourcesWritten, false);
  assert.deepEqual(preserved(installed), preserved(before)); assert.equal(installed.balls.length, before.balls.length + 4);
  assert.deepEqual(installed.configs.find(row => row.TemplateID === 9107258), newPackage.BallConfig);
  assert.deepEqual(installed.balls.filter(row => newIds.includes(Number(row.ID))), planWeaponInstall(newPackage).config.Ball);
  assert.equal(installed.audit.length, 5); assert.deepEqual(readFileSync(f.originalJournalPath), originalBytes);
  const savedBytes = readFileSync(f.upgradeJournalPath), savedTime = statSync(f.upgradeJournalPath).mtimeMs;
  const intent = JSON.parse(savedBytes.toString("utf8"));
  assert.equal(intent.originalJournal.sha256, hash(originalBytes)); assert.equal(intent.originalJournal.packageSha256, first.oldPackageSha256);
  for (let i = 0; i < 2; i++) {
    const result = await f.run(); assert.equal(result.status, "unchanged"); assert.equal(result.journalPublished, false);
    assert.deepEqual(result.inserted, { Ball: 0 }); assert.deepEqual(result.updated, { BallConfig: 0 }); assert.deepEqual(await rows(), installed);
  }
  assert.deepEqual(readFileSync(f.originalJournalPath), originalBytes); assert.deepEqual(readFileSync(f.upgradeJournalPath), savedBytes);
  assert.equal(statSync(f.upgradeJournalPath).mtimeMs, savedTime);
});

test("completed visuals accept the exact later smith upgrade without changing official stats", async t => {
  const f = fixture(t); await f.run();
  const upgraded = smithEnabledWeapon(oldPackage.Shop_Goods);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "Level"=3, "CanStrengthen"=true, "CanCompose"=true,
    "CanTransfer"=1, "Description"=${upgraded.Description} WHERE "TemplateID"=9107258`);
  const before = await rows(); assert.equal((await f.run()).status, "unchanged"); assert.deepEqual(await rows(), before);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "Attack"="Attack"+1 WHERE "TemplateID"=9107258`);
  await assert.rejects(f.run(), /owned Shop_Goods/);
});

test("prepared intent precedes writes; failure rolls back and exact old-state retry succeeds", async t => {
  const f = fixture(t), before = await rows(), original = readFileSync(f.originalJournalPath); let checks = 0;
  await assert.rejects(f.run({ checkBinding() {
    if (++checks === 2) { assert.equal(existsSync(f.upgradeJournalPath), true); throw Error("injected session replacement"); }
  } }), /injected session replacement/);
  assert.equal(checks, 2); assert.deepEqual(await rows(), before); assert.deepEqual(readFileSync(f.originalJournalPath), original);
  const intent = readFileSync(f.upgradeJournalPath), result = await f.run();
  assert.equal(result.status, "upgraded"); assert.equal(result.journalPublished, false); assert.deepEqual(readFileSync(f.upgradeJournalPath), intent);
});

test("constraint and trigger failures restore every old/shared row and keep retryable intent", async t => {
  const f = fixture(t), before = await rows();
  await h.db.execute(sql.raw('ALTER TABLE game."Ball" ADD CONSTRAINT visual_test_block CHECK ("ID" <> ' + newIds[2] + ')'));
  await assert.rejects(f.run()); assert.deepEqual(await rows(), before); assert.equal(existsSync(f.upgradeJournalPath), true);
  await h.db.execute(sql`ALTER TABLE game."Ball" DROP CONSTRAINT visual_test_block`);
  await h.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION game.visual_test_change_old() RETURNS trigger AS $$ BEGIN UPDATE game."Ball" SET "Power"="Power"+1 WHERE "ID"=${oldIds[0]}; RETURN NEW; END $$ LANGUAGE plpgsql`));
  await h.db.execute(sql`CREATE TRIGGER visual_test_change_old AFTER UPDATE ON game."BallConfig" FOR EACH ROW EXECUTE FUNCTION game.visual_test_change_old()`);
  await assert.rejects(f.run(), /old shared BallReferences/); assert.deepEqual(await rows(), before);
  await h.db.execute(sql`DROP TRIGGER visual_test_change_old ON game."BallConfig"`);
  assert.equal((await f.run()).status, "upgraded");
});

test("occupied or already referenced new IDs are refused before publishing ownership", async t => {
  const f = fixture(t);
  await h.db.insert(game.Ball).values(newPackage.Ball[0] as typeof game.Ball.$inferInsert);
  let before = await rows(); await assert.rejects(f.run(), /partial, occupied, shared or changed/);
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.upgradeJournalPath), false);
  await h.db.execute(sql`DELETE FROM game."Ball" WHERE "ID"=${newPackage.Ball[0].ID}`);
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Common"=${newIds[0]} WHERE "TemplateID"=7006`);
  before = await rows(); await assert.rejects(f.run(), /partial, occupied, shared or changed/);
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.upgradeJournalPath), false);
});

test("partial or unowned new state cannot be adopted, and newly shared upgraded state is refused", async t => {
  const f = fixture(t); await f.run();
  const intent = readFileSync(f.upgradeJournalPath); rmSync(f.upgradeJournalPath);
  let before = await rows(); await assert.rejects(f.run(), /no upgrade ownership journal/); assert.deepEqual(await rows(), before);
  writeFileSync(f.upgradeJournalPath, intent);
  await h.db.execute(sql`UPDATE game."BallConfig" SET "Common"=${newIds[0]} WHERE "TemplateID"=7006`);
  before = await rows(); await assert.rejects(f.run(), /partial, occupied, shared or changed/); assert.deepEqual(await rows(), before);
});

test("package changes to item, physics, crater, sound, trail, owner, template or overlapping IDs are rejected", async t => {
  const f = fixture(t), before = await rows();
  const changes: ((value: WeaponPackage) => void)[] = [
    value => { value.Shop_Goods.Attack = Number(value.Shop_Goods.Attack) + 1; },
    ...["Power", "Mass", "Delay"].map(key => (value: WeaponPackage) => { value.Ball[0][key] = Number(value.Ball[0][key]) + 1; }),
    ...["Crater", "FlyingPartical", "ShootSound", "BombSound"].map(key => (value: WeaponPackage) => { value.Ball[0][key] = "unapproved"; }),
    value => { value.owner = "ddtank-workshop/weapon/other"; },
    value => { value.Shop_Goods.TemplateID = 9107259; value.BallConfig.TemplateID = 9107259; },
    value => { const oldId = value.Ball[0].ID; value.Ball[0].ID = oldIds[0]; for (const key of ["Common", "CommonAddWound", "CommonMultiBall", "Special"]) if (value.BallConfig[key] === oldId) value.BallConfig[key] = oldIds[0]; },
  ];
  for (const change of changes) { const candidate = structuredClone(newPackage); change(candidate); await assert.rejects(f.run({ newConfig: candidate })); }
  await assert.rejects(f.run({ oldConfig: newPackage, newConfig: oldPackage }));
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.upgradeJournalPath), false);
});

test("missing or changed old rows and mismatched original journal binding/hash/package are refused", async t => {
  const f = fixture(t), original = readFileSync(f.originalJournalPath);
  for (const change of [
    (value: typeof f.journal) => { value.packageSha256 = "0".repeat(64); },
    (value: typeof f.journal) => { value.binding.databaseName = "elsewhere"; },
    (value: typeof f.journal) => { value.package.metadata.tampered = true; },
    (value: typeof f.journal) => { value.phase = "unknown"; },
  ]) { const value = JSON.parse(original.toString("utf8")); change(value); writeFileSync(f.originalJournalPath, JSON.stringify(value)); const before = await rows(); await assert.rejects(f.run()); assert.deepEqual(await rows(), before); }
  writeFileSync(f.originalJournalPath, original);
  await h.db.execute(sql`UPDATE game."Ball" SET "BombSound"='changed' WHERE "ID"=${oldIds[0]}`);
  let before = await rows(); await assert.rejects(f.run(), /old shared BallReferences/); assert.deepEqual(await rows(), before);
  await h.db.execute(sql`DELETE FROM game."Shop_Goods" WHERE "TemplateID"=9107258`);
  before = await rows(); await assert.rejects(f.run(), /owned Shop_Goods/); assert.deepEqual(await rows(), before);
  assert.equal(existsSync(f.upgradeJournalPath), false);
});

test("original or upgrade journal drift refuses retry and preserves external updates", async t => {
  const f = fixture(t), before = await rows(), original = readFileSync(f.originalJournalPath); let checks = 0;
  const external = Buffer.concat([original, Buffer.from(" ")]);
  await assert.rejects(f.run({ checkBinding() { if (++checks === 2) writeFileSync(f.originalJournalPath, external); } }), /original journal changed/);
  assert.deepEqual(await rows(), before); assert.deepEqual(readFileSync(f.originalJournalPath), external);
  await assert.rejects(f.run(), /upgrade ownership journal differs/);
  writeFileSync(f.originalJournalPath, original);
  const intent = JSON.parse(readFileSync(f.upgradeJournalPath, "utf8")); intent.newPackageSha256 = "f".repeat(64);
  writeFileSync(f.upgradeJournalPath, JSON.stringify(intent));
  await assert.rejects(f.run(), /upgrade ownership journal differs/); assert.deepEqual(await rows(), before);
});

test("journal publication failure and binding failure occur without database writes", async t => {
  const f = fixture(t), before = await rows(), blocked = join(f.path, "blocked"); writeFileSync(blocked, "file");
  await assert.rejects(f.run({ upgradeJournalPath: join(blocked, "intent.json") })); assert.deepEqual(await rows(), before);
  await assert.rejects(f.run({ checkBinding() { throw Error("injected initial binding failure"); } }), /injected initial binding failure/);
  assert.deepEqual(await rows(), before); assert.equal(existsSync(f.upgradeJournalPath), false);
  await assert.rejects(f.run({ upgradeJournalPath: f.originalJournalPath }), /must be separate/);
});
