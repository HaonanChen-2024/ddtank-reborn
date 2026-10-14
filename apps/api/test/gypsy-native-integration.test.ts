import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// Actual HTTP/auth, shared shop owner, in-memory PGlite transaction, UUID receipt and mail.
// Only Date/RNG are controlled. No existing database or service is opened.
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(0.99 * min) : min + Math.floor(0.99 * (max - min)) }));
const tmp = mkdtempSync(join(tmpdir(), "ddt-gypsy-native-"));
const uid = 511, otherUid = 512, secret = "gypsy-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "gypsy-native-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId: string = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
async function action(id: string, value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(id, value, requestId); expect(response.statusCode, response.body).toBe(status);
  expect(response.body).not.toMatch(/nativeGypsyEffects|"(?:games|state|seed|nextOffers)"\s*:/); return response.json();
}
const native = (value: ActivityAction, requestId: string = randomUUID(), status = 200) => action("gypsy-native", value, requestId, status);
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); expect(response.body).not.toMatch(/nativeGypsyEffects|"(?:games|state|seed|nextOffers)"\s*:/);
  const result = response.json<ActivityResult>(); expect(result).not.toHaveProperty("nativeGypsyAction"); return result;
}
const saved = async () => (await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))?.State;
async function persisted() { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  const template: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "Material", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 2,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  await h.db.insert(game.Shop_Goods).values(PRIZES.map(prize => ({ ...template, TemplateID: prize.templateId, Name: prize.name }))); await rebuild();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS gypsy_native_mail_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS gypsy_native_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'gypsy-native-test','tests-only'),(2,'other-gypsy-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'gypsy-native-test','Gypsy native test',true,'2000-01-01',1),(${otherUid},'other-gypsy-test','Other test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},100,40)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("native Gypsy through the shared transactional API", () => {
  it("does not create or refresh a shelf on GET, requires character ownership and rejects malformed actions without writes", async () => {
    await h.db.execute(sql`DELETE FROM app."ActivityWallet"`); const before = await persisted();
    expect((await snapshot()).nativeGypsy).toMatchObject({ started: false, score: 0, offers: [], freeRefresh: true, canRefresh: true, refreshCost: 0 });
    expect(await persisted()).toEqual(before);
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post("gypsy-native", { type: "refresh", choice: "free" }, randomUUID(), otherUid)).statusCode).toBe(403);
    for (const invalid of [{ type: "refresh" }, { type: "refresh", choice: "points" }, { type: "refresh", choice: "free", count: 1 },
      { type: "buy", index: 0 }, { type: "buy", index: 8, choice: "2026-10-15:1" }, { type: "buy", index: "0", choice: "2026-10-15:1" },
      { type: "buy", index: 0, choice: "2026-10-15:1", count: 1 }]) await native(invalid as ActivityAction, randomUUID(), 400);
    expect(await persisted()).toEqual(before);
  });

  it("preserves old three-slot saves, shares eight-slot purchases with the old webpage and restores three slots only on explicit legacy refresh", async () => {
    const profiles = await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`);
    const legacy = await action("gypsy", { type: "refresh" }); expect(legacy.nativeGypsy.offers).toHaveLength(3); expect(legacy).not.toHaveProperty("nativeGypsyAction");
    const before = await persisted(); await native({ type: "buy", index: 3, choice: legacy.nativeGypsy.shelfKey! }, randomUUID(), 400);
    expect(await persisted()).toEqual(before);
    const firstBought = await native({ type: "buy", index: 0, choice: legacy.nativeGypsy.shelfKey! });
    expect(firstBought.points).toBe(85); expect(firstBought.nativeGypsy.offers[0]).toMatchObject({ index: 0, sold: true, canBuy: false });
    await action("gypsy", { type: "buy", index: 0 }, randomUUID(), 400);
    const nativeShelf = await native({ type: "refresh", choice: "points" }); expect(nativeShelf.nativeGypsy.offers).toHaveLength(8); expect(nativeShelf.points).toBe(80);
    const oldBuy = await action("gypsy", { type: "buy", index: 7 }); expect(oldBuy).toMatchObject({ points: 50 });
    expect(oldBuy.nativeGypsy.offers[7].sold).toBe(true); expect(oldBuy.activities.find(a => a.id === "gypsy")!.cells).toHaveLength(8);
    await native({ type: "buy", index: 7, choice: nativeShelf.nativeGypsy.shelfKey! }, randomUUID(), 400);
    const restored = await action("gypsy", { type: "refresh" }); expect(restored.points).toBe(45); expect(restored.nativeGypsy.offers).toHaveLength(3);
    expect((await saved())!.completed.gypsy).toBe(2); expect((await saved())!.games).not.toHaveProperty("gypsyNativeV1");
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`)).toEqual(profiles);
  });

  it("allows one of two free refresh UUIDs without converting the losing request into a paid refresh and charges a paid retry once", async () => {
    const free = await Promise.all([post("gypsy-native", { type: "refresh", choice: "free" }), post("gypsy-native", { type: "refresh", choice: "free" })]);
    expect(free.map(response => response.statusCode).sort()).toEqual([200, 400]);
    expect((await snapshot()).nativeGypsy).toMatchObject({ score: 100, refreshes: 1, refreshCost: 5 });
    expect((await persisted()).receipts).toHaveLength(1);
    const id = randomUUID(), paid = await Promise.all(Array.from({ length: 8 }, () => post("gypsy-native", { type: "refresh", choice: "points" }, id)));
    expect(paid.every(response => response.statusCode === 200)).toBe(true); expect(paid.filter(response => response.json().nativeGypsyAction)).toHaveLength(1);
    expect(paid.filter(response => response.json().replayed)).toHaveLength(7);
    expect((await snapshot())).toMatchObject({ points: 95, earned: 40, revision: 2, nativeGypsy: { refreshes: 2, shelfKey: "2026-10-15:2" } });
    const before = await persisted(); await native({ type: "buy", index: 0, choice: "2026-10-15:1" }, randomUUID(), 400); expect(await persisted()).toEqual(before);
    const latest = await snapshot(), replay = await native({ type: "refresh", choice: "points" }, id);
    expect(replay).toMatchObject({ ...latest, replayed: true }); expect(replay).not.toHaveProperty("nativeGypsyAction"); expect(await persisted()).toEqual(before);
  });

  it("deduplicates purchases, independently limits duplicate material slots and protects competing balances and cross-module UUIDs", async () => {
    await native({ type: "refresh", choice: "free" }); const id = randomUUID(), value = { type: "buy", index: 0, choice: "2026-10-15:1" };
    const same = await Promise.all(Array.from({ length: 8 }, () => post("gypsy-native", value, id)));
    expect(same.every(response => response.statusCode === 200)).toBe(true); expect(same.filter(response => response.json().nativeGypsyAction)).toHaveLength(1);
    expect((await snapshot()).nativeGypsy.offers[4]).toMatchObject({ templateId: 11019, sold: false, canBuy: true });
    const racing = await Promise.all([post("gypsy-native", { type: "buy", index: 4, choice: value.choice }), post("gypsy-native", { type: "buy", index: 4, choice: value.choice })]);
    expect(racing.map(response => response.statusCode).sort()).toEqual([200, 400]);
    const delivered = await persisted(); expect(delivered.goods).toHaveLength(4); expect(delivered.mails).toHaveLength(2);
    expect(delivered.goods.reduce((sum, row) => sum + Number(row.Count), 0)).toBe(6); expect((await snapshot()).points).toBe(70);
    const beforeConflict = await persisted(); await action("ddplay-native", { type: "spin" }, id, 409); expect(await persisted()).toEqual(beforeConflict);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=20 WHERE "UserID"=${uid}`);
    const funds = await Promise.all([post("gypsy-native", { type: "buy", index: 1, choice: value.choice }), post("gypsy-native", { type: "buy", index: 2, choice: value.choice })]);
    expect(funds.map(response => response.statusCode).sort()).toEqual([200, 400]); expect((await snapshot()).points).toBe(0);
  });

  it("rolls back late mail and final receipt failures with the stock, points and earlier items, then retries the same UUID once", async () => {
    await native({ type: "refresh", choice: "free" }); const before = await persisted(), id = randomUUID(), value = { type: "buy", index: 0, choice: "2026-10-15:1" };
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT gypsy_native_mail_failure CHECK ("Annex3" IS NOT NULL) NOT VALID`);
    expect((await post("gypsy-native", value, id)).statusCode).toBe(500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT gypsy_native_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT gypsy_native_receipt_failure CHECK ("Signature" = 'cannot-pass-test') NOT VALID`);
    const failed = await post("gypsy-native", value, id); expect(failed.statusCode, failed.body).toBe(500);
    expect(failed.body).not.toMatch(/gypsy_native_receipt_failure|INSERT|UPDATE|Annex/); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT gypsy_native_receipt_failure`);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11019`);
    await native(value, id, 503); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11019`);
    const fresh = await native(value, id); expect(fresh).toMatchObject({ points: 85, mailedCount: 1, nativeGypsyAction: { requestId: id,
      effects: [{ type: "bought", shelfKey: value.choice, index: 0, templateId: 11019, itemCount: 3, cost: 15, score: 85 }] } });
    const delivered = await persisted(); expect(delivered.goods.map(item => item.Count)).toEqual([2, 1]); expect(delivered.mails).toHaveLength(1);
    expect([Number(delivered.mails[0].Annex1), Number(delivered.mails[0].Annex2)]).toEqual(delivered.goods.map(item => item.ItemID));
    for (const item of delivered.goods) expect(item).toMatchObject({ TemplateID: 11019, UserID: 0, Place: -1, IsBinds: true, ValidDate: 0,
      StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, AgilityCompose: 0, LuckCompose: 0 });
    expect((await native(value, id)).replayed).toBe(true); expect(await persisted()).toEqual(delivered);
    expect(delivered.receipts.every(receipt => Object.keys(receipt.Result as object).sort().join(",") === "mailedCount,message")).toBe(true);
  });

  it("restores stock after app restart, preserves a prior-day shelf on GET, and refuses integer-overflow commits without stock or mail writes", async () => {
    const initial = await native({ type: "refresh", choice: "free" }); await native({ type: "buy", index: 0, choice: initial.nativeGypsy.shelfKey! });
    const old = await snapshot(), before = await persisted(); await built.app.close(); await rebuild(); expect(await snapshot()).toEqual(old); expect(await persisted()).toEqual(before);
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const next = await snapshot(); expect(next.nativeGypsy).toMatchObject({ day: "2026-10-16", shelfDay: "2026-10-15", freeRefresh: true, refreshCost: 0 });
    expect(next.nativeGypsy.offers).toEqual(old.nativeGypsy.offers); expect(await persisted()).toEqual(before);
    await native({ type: "buy", index: 4, choice: initial.nativeGypsy.shelfKey! });
    await native({ type: "refresh", choice: "points" }, randomUUID(), 400); // Free refresh cannot be converted into a charge.
    const reset = await native({ type: "refresh", choice: "free" }); expect(reset.nativeGypsy).toMatchObject({ shelfKey: "2026-10-16:1", refreshes: 1 });
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=2147483647,"Revision"=2147483647 WHERE "UserID"=${uid}`);
    const overflow = await persisted(); await native({ type: "buy", index: 0, choice: reset.nativeGypsy.shelfKey! }, randomUUID(), 409);
    expect(await persisted()).toEqual(overflow);
  });
});
