import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createDb, game, migrateDb, seedDatabase, type DbHandle } from "../packages/db/src/index.js";
import { buildApp } from "../apps/api/src/app.js";
import { q, q1 } from "../apps/api/src/lib/db.js";
import { pullDown } from "../apps/api/src/request/endpoints/events.js";
import { readStarterConfig, type StarterBinding } from "./workshop-starter-activity.js";
import { planFestivalActivity, readFestivalConfig, runFestivalActivity, validateFestivalConfig } from "./workshop-festival-activity.js";

const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), config = readFestivalConfig(), starter = readStarterConfig();
const binding: StarterBinding = { databaseName: "isolated-festival-test", dataDirectory: "pglite:memory" };
const now = new Date("2026-10-12T04:00:00.000Z"), uid = 711;
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>, appPath: string;

function privateTemp() {
  const path = mkdtempSync(join(tmpdir(), "ddt-festival-"));
  assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir()));
  assert.ok(path.startsWith(join(tmpdir(), "ddt-festival-")));
  return path;
}
function removePrivateTemp(path: string) {
  assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir()));
  assert.ok(path.startsWith(join(tmpdir(), "ddt-festival-")));
  rmSync(path, { recursive: true, force: true });
}
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  const items = JSON.parse(gunzipSync(readFileSync(join(repo, "packages/db/seed/game/Shop_Goods.json.gz"))).toString("utf8"));
  const potion = items.find((row: { TemplateID: number }) => row.TemplateID === 11904); assert.ok(potion);
  await h.db.insert(game.Shop_Goods).values({ ...potion, AddTime: new Date(potion.AddTime + "Z") });
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","NickName","Sex","IsFirst") VALUES (${uid}, 'Festival test', true, 1), (712, 'Festival female test', false, 1)`);
  appPath = privateTemp();
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config: {
    NODE_ENV: "test", DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, GAME_INTERNAL_URL: "",
    FLASH_DIR: join(appPath, "flash"), RESOURCE_DIR: join(appPath, "resource"), UPLOAD_DIR: join(appPath, "uploads"),
  } });
});
beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE app."EventClaims", player."Active_Number", player."User_Messages", player."Sys_Users_Goods"`);
  await seedDatabase(h, { only: ["game.Active", "game.Active_Award"] });
  await h.db.insert(game.Active).values({ ...starter.Active, StartDate: new Date(starter.Active.StartDate as string), EndDate: new Date(starter.Active.EndDate as string) } as typeof game.Active.$inferInsert);
  await h.db.insert(game.Active_Award).values({ ActiveID: 100001, ...starter.Award } as typeof game.Active_Award.$inferInsert);
  await h.db.execute(sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (${uid},'active','100001')`);
  await h.db.execute(sql`INSERT INTO player."Active_Number" ("AwardID","ActiveID") VALUES ('preserved-old-code',1)`);
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await built?.app.close(); await h?.close(); if (appPath) removePrivateTemp(appPath); });

function fixture(t: { onTestFinished: (fn: () => void) => void }) {
  const path = privateTemp(); t.onTestFinished(() => removePrivateTemp(path));
  const journalPath = join(path, "festival.json");
  const run = (command: "verify" | "install" = "verify", options = {}) => runFestivalActivity(h, { command, binding, journalPath, ...options });
  return { path, journalPath, run };
}
async function rows() {
  return { active: await q(h, sql`SELECT * FROM game."Active" ORDER BY "ActiveID"`), awards: await q(h, sql`SELECT * FROM game."Active_Award" ORDER BY "ID"`),
    claims: await q(h, sql`SELECT * FROM app."EventClaims" ORDER BY "UserID","Kind","Key"`), codes: await q(h, sql`SELECT * FROM player."Active_Number" ORDER BY "AwardID"`),
    potion: await q1(h, sql`SELECT * FROM game."Shop_Goods" WHERE "TemplateID"=11904`), players: await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`) };
}
async function deliveries() {
  return q1(h, sql`SELECT (SELECT count(*)::int FROM app."EventClaims" WHERE "Key"='100002' AND "Kind"='active') AS claims,
    (SELECT count(*)::int FROM player."Sys_Users_Goods") AS items, (SELECT count(*)::int FROM player."User_Messages") AS mails`);
}
const emptyDelivery = { claims: 0, items: 0, mails: 0 };

test("offline plan has a seven-day Beijing window, an independent key and one unchanged ordinary reward", () => {
  const plan = planFestivalActivity(config);
  assert.equal(plan.activeId, 100002); assert.notEqual(plan.activeId, starter.Active.ActiveID);
  assert.equal(config.Active.StartDate, "2026-10-11T16:00:00.000Z");
  assert.equal(config.Active.EndDate, "2026-10-18T15:59:59.999Z");
  assert.equal(Date.parse(config.Active.EndDate as string) - Date.parse(config.Active.StartDate as string) + 1, 7 * 86400000);
  assert.equal(plan.rewardTemplateId, 11904); assert.equal(plan.grants, 0);
  assert.equal(config.Active.HasKey, 3); assert.equal(config.Active.IsOnly, 1);
  assert.equal(config.Active.IsShow, false); assert.equal(config.Active.IconID, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(config.Award).filter(([key]) => !["ID", "ActiveID"].includes(key))), starter.Award);
});

test("invalid dates, an unlimited window, paid/enhanced rewards and extra fields are rejected before DB access", () => {
  for (const update of [{ EndDate: null }, { EndDate: "invalid" }, { StartDate: "2026-10-11" }, { EndDate: "2031-01-01T00:00:00.000Z" }, { ActiveID: 100001 }, { HasKey: 1 }]) {
    const invalid = structuredClone(config); Object.assign(invalid.Active, update); assert.throws(() => validateFestivalConfig(invalid));
  }
  for (const update of [{ ItemID: 90000 }, { Count: 2 }, { Money: 1 }, { StrengthenLevel: 10 }, { AttackCompose: NaN }, { ID: 1 }, { ActiveID: 100001 }]) {
    const invalid = structuredClone(config); Object.assign(invalid.Award, update); assert.throws(() => validateFestivalConfig(invalid));
  }
  assert.throws(() => validateFestivalConfig({ ...config, resetClaims: true }));
});

test("verify writes nothing; install preserves seeded activities, starter, its claim, codes and players", async t => {
  const f = fixture(t), before = await rows();
  assert.equal((await f.run()).state, "absent"); assert.equal(existsSync(f.journalPath), false); assert.deepEqual(await rows(), before);
  const first = await f.run("install"), after = await rows();
  assert.equal(first.insertedActive, 1); assert.equal(first.insertedAwards, 1); assert.equal(first.cacheReloadRequired, true); assert.equal(first.clientAccepted, false);
  assert.deepEqual(after.active.filter(row => row.ActiveID !== 100002), before.active);
  assert.deepEqual(after.awards.filter(row => row.ActiveID !== 100002), before.awards);
  assert.deepEqual({ ...after, active: before.active, awards: before.awards }, before);
  assert.deepEqual(await deliveries(), emptyDelivery);
  const journal = readFileSync(f.journalPath);
  const [a, b] = await Promise.all([f.run("install"), f.run("verify")]);
  assert.equal(a.insertedActive, 0); assert.equal(b.state, "installed");
  assert.deepEqual(await rows(), after); assert.deepEqual(readFileSync(f.journalPath), journal);
});

test("concurrent installers create one owned pair", async t => {
  const f = fixture(t), results = await Promise.all([f.run("install"), f.run("install")]);
  assert.deepEqual(results.map(r => r.insertedActive).sort(), [0, 1]);
  assert.deepEqual(results.map(r => r.insertedAwards).sort(), [0, 1]);
});

test("unowned activity, award key, orphan reward, claim and activation code collisions are preserved", async t => {
  const f = fixture(t);
  for (const operation of [
    sql`INSERT INTO game."Active" ("ActiveID","Title") VALUES (100002,'existing')`,
    sql`INSERT INTO game."Active_Award" ("ID","ActiveID","ItemID") VALUES (100002,1,11904)`,
    sql`INSERT INTO game."Active_Award" ("ActiveID","ItemID") VALUES (100002,11904)`,
    sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (${uid},'active','100002')`,
    sql`INSERT INTO player."Active_Number" ("AwardID","ActiveID") VALUES ('festival-code',100002)`,
  ]) {
    await h.db.execute(operation); const before = await rows();
    await assert.rejects(() => f.run("install")); assert.deepEqual(await rows(), before); assert.equal(existsSync(f.journalPath), false);
    await h.db.execute(sql`DELETE FROM game."Active" WHERE "ActiveID"=100002`);
    await h.db.execute(sql`DELETE FROM game."Active_Award" WHERE "ActiveID"=100002 OR "ID"=100002`);
    await h.db.execute(sql`DELETE FROM app."EventClaims" WHERE "Key"='100002' AND "Kind"='active'`);
    await h.db.execute(sql`DELETE FROM player."Active_Number" WHERE "ActiveID"=100002`);
  }
});

test("SQL failure rolls back both rows, and prepared intent safely retries after the constraint is removed", async t => {
  const f = fixture(t), before = await rows();
  await h.db.execute(sql`ALTER TABLE game."Active_Award" ADD CONSTRAINT reject_festival CHECK ("ActiveID" <> 100002)`);
  try { await assert.rejects(() => f.run("install")); }
  finally { await h.db.execute(sql`ALTER TABLE game."Active_Award" DROP CONSTRAINT reject_festival`); }
  assert.deepEqual(await rows(), before); assert.equal(JSON.parse(readFileSync(f.journalPath, "utf8")).phase, "prepared");
  const verified = await f.run(); assert.equal(verified.state, "prepared"); assert.equal(verified.installed, false);
  assert.equal((await f.run("install")).insertedActive, 1);
});

test("journal failure or session drift rolls back without partial rows", async t => {
  const f = fixture(t), before = await rows(), blocked = join(f.path, "not-directory"); writeFileSync(blocked, "keep");
  await assert.rejects(() => f.run("install", { journalPath: join(blocked, "journal.json") }));
  assert.deepEqual(await rows(), before); assert.equal(readFileSync(blocked, "utf8"), "keep");
  let calls = 0;
  await assert.rejects(() => f.run("install", { checkBinding: () => { if (++calls === 2) throw new Error("session drift"); } }), /session drift/);
  assert.deepEqual(await rows(), before); assert.equal((await f.run()).state, "prepared");
});

test("configuration, binding and owned row drift or partial state is refused", async t => {
  const f = fixture(t); await f.run("install"); const before = await rows();
  const changed = structuredClone(config); changed.Active.Title = "Changed festival";
  await assert.rejects(() => f.run("install", { config: changed }), /configuration differs/);
  await assert.rejects(() => f.run("install", { binding: { ...binding, databaseName: "another" } }), /binding/);
  assert.deepEqual(await rows(), before);
  await h.db.execute(sql`UPDATE game."Active_Award" SET "Count"=2 WHERE "ID"=100002`);
  const drift = await rows(); await assert.rejects(() => f.run("install"), /owned reward differs/); assert.deepEqual(await rows(), drift);
  await h.db.execute(sql`DELETE FROM game."Active_Award" WHERE "ID"=100002`);
  const partial = await rows(); await assert.rejects(() => f.run("install"), /incomplete/); assert.deepEqual(await rows(), partial);
});

test("an altered ordinary template is refused", async t => {
  const f = fixture(t); await h.db.execute(sql`UPDATE game."Shop_Goods" SET "Attack"=10000 WHERE "TemplateID"=11904`);
  try { await assert.rejects(() => f.run("install"), /ordinary experience potion/); assert.equal(existsSync(f.journalPath), false); }
  finally { await h.db.execute(sql`UPDATE game."Shop_Goods" SET "Attack"=0 WHERE "TemplateID"=11904`); }
});

test("the original compressed calendar contract lists both events; GET/POST claim delivers once via the real mail API", async t => {
  const f = fixture(t); await f.run("install"); const before = await rows();
  await built.ctx.cache.invalidate(["game.Active"]);
  const list = await built.app.inject({ method: "GET", url: "/Request/ActiveList.xml" });
  assert.equal(list.statusCode, 200); const xml = inflateSync(list.rawPayload).toString("utf8");
  assert.match(xml, /ActiveID="100002"/); assert.match(xml, /ActiveID="100001"/); assert.match(xml, /Title="本地秋日庆典"/);
  assert.match(xml, /HasKey="3"/); assert.match(xml, /ActionTimeContent="2026-10-12/);
  // Only the test clock changes. No auth, request implementation or production timestamp is modified.
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  const first = await built.app.inject({ method: "GET", url: `/Request/ActivePullDown.ashx?selfid=${uid}&activeID=100002` });
  assert.equal(first.body, '<Result value="true" message="领取成功，奖励已发送到您的邮箱。" />');
  const repeat = await built.app.inject({ method: "POST", url: "/request/ActivePullDown.ashx", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `selfid=${uid}&activeID=100002&activeKey=` });
  assert.match(repeat.body, /value="false"/); assert.match(repeat.body, /您已经领取过该奖励/);
  assert.deepEqual(await deliveries(), { claims: 1, items: 1, mails: 1 });
  const item = await q1(h, sql`SELECT "TemplateID","Count","ValidDate","IsBinds","StrengthenLevel","AttackCompose","DefendCompose","LuckCompose","AgilityCompose" FROM player."Sys_Users_Goods"`);
  assert.deepEqual(item, { TemplateID: 11904, Count: 1, ValidDate: 0, IsBinds: true, StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, LuckCompose: 0, AgilityCompose: 0 });
  assert.deepEqual(await q1(h, sql`SELECT "Title","Gold","Money" FROM player."User_Messages"`), { Title: "本地秋日庆典", Gold: 0, Money: 0 });
  assert.deepEqual((await rows()).players, before.players); assert.deepEqual((await rows()).potion, before.potion);
  const claimRows = (await rows()).claims; assert.equal(claimRows.length, 2);
  const repeated = await f.run("install"); assert.equal(repeated.insertedActive, 0); assert.equal(repeated.claims, 1);
  assert.deepEqual((await rows()).claims, claimRows); assert.deepEqual(await deliveries(), { claims: 1, items: 1, mails: 1 });
});

test("real API rejects before/after the fixed window and admits only one concurrent claim within it", async t => {
  const f = fixture(t); await f.run("install");
  assert.equal(await pullDown(built.ctx, 100002, "", uid, new Date(Date.parse(config.Active.StartDate as string) - 1)), 7);
  assert.equal(await pullDown(built.ctx, 100002, "", uid, new Date(Date.parse(config.Active.EndDate as string) + 1)), 8);
  assert.deepEqual(await deliveries(), emptyDelivery);
  const results = await Promise.all(Array.from({ length: 5 }, () => pullDown(built.ctx, 100002, "", uid, now)));
  assert.deepEqual(results.sort(), [0, 6, 6, 6, 6]); assert.deepEqual(await deliveries(), { claims: 1, items: 1, mails: 1 });
  assert.equal(await pullDown(built.ctx, 100002, "", 712, new Date(config.Active.EndDate as string)), 0);
  assert.deepEqual(await deliveries(), { claims: 2, items: 2, mails: 2 });
});

test("mail failure rolls back claim and item, then the same real API can deliver normally", async t => {
  const f = fixture(t); await f.run("install");
  await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT reject_festival_mail CHECK ("ReceiverID" <> 711)`);
  try { await assert.rejects(() => pullDown(built.ctx, 100002, "", uid, now)); }
  finally { await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT reject_festival_mail`); }
  assert.deepEqual(await deliveries(), emptyDelivery);
  assert.equal(await pullDown(built.ctx, 100002, "", uid, now), 0);
  assert.deepEqual(await deliveries(), { claims: 1, items: 1, mails: 1 });
});
