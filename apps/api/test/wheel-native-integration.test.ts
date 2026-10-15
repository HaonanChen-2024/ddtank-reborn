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
import { assertPublicActivityStates } from "./public-activity-state.js";

// Real HTTP/auth, in-memory PGlite state, wallet, receipts and ordinary mail. No live DB/service.
const random = vi.hoisted(() => ({ fraction: 0.99 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)) }));
const tmp = mkdtempSync(join(tmpdir(), "ddt-wheel-native-"));
const uid = 711, otherUid = 712, secret = "wheel-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "wheel-native-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId: string = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); const result = response.json<ActivityResult>();
  expect(result).not.toHaveProperty("nativeWheelAction"); expect(response.body).not.toMatch(/nativeWheelEffects|"(?:games|seed)"\s*:/);
  assertPublicActivityStates(result); return result;
}
async function action(id: string, value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(id, value, requestId); expect(response.statusCode, response.body).toBe(status);
  expect(response.body).not.toMatch(/nativeWheelEffects|"(?:games|seed)"\s*:/);
  const result = response.json<ActivityResult>(); assertPublicActivityStates(result); return result;
}
const native = (value: ActivityAction, requestId: string = randomUUID(), status = 200) => action("wheel-native", value, requestId, status);
const play = async (type: string) => native({ type, choice: (await snapshot()).nativeWheel.roundToken });
const saved = async () => (await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))?.State;
async function persisted() { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
async function levelSeven() {
  random.fraction = 0.99; await play("start"); random.fraction = 0.1;
  for (let index = 0; index < 6; index++) await play("continue");
  const view = await snapshot(); expect(view.nativeWheel).toMatchObject({ category: 5, level: 7, spinCount: 7, roundMaterial: { templateId: 11002 } }); return view;
}
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  const template: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "Material", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 5,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  await h.db.insert(game.Shop_Goods).values(PRIZES.map(prize => ({ ...template, TemplateID: prize.templateId, Name: prize.name }))); await rebuild();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z")); random.fraction = 0.99;
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS wheel_native_mail_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS wheel_native_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'wheel-native-test','tests-only'),(2,'other-wheel-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'wheel-native-test','Wheel native test',true,'2000-01-01',1),(${otherUid},'other-wheel-test','Other test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("native wheel through the atomic account API", () => {
  it("keeps GET pure, checks role ownership, and rejects missing choices, fake templates and legacy fields", async () => {
    await h.db.execute(sql`DELETE FROM app."ActivityWallet"`); const before = await persisted(), view = await snapshot(), choice = view.nativeWheel.roundToken;
    expect(view.nativeWheel).toMatchObject({ started: false, score: 0, fragments: 0, pending: null, canStart: false });
    expect(choice).toMatch(/^2026-10-15:[A-Za-z0-9_-]{43}$/);
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post("wheel-native", { type: "start", choice }, randomUUID(), otherUid)).statusCode).toBe(403);
    for (const value of [{ type: "start" }, { type: "start", choice: "x".repeat(65) }, { type: "start", choice, price: 0 },
      { type: "start", choice, count: 1 }, { type: "start", choice, marked: true }, { type: "take-chip", choice, items: [{ index: 0, count: 1 }] },
      { type: "take-item", choice, mode: "normal" }, { type: "exchange", choice }, { type: "exchange", choice, index: 4, count: 1 },
      { type: "exchange", choice, index: 0, count: 11 }, { type: "exchange", choice, index: 0, count: 1, templateId: 999 },
      { type: "buy-coins", choice }]) await native(value as ActivityAction, randomUUID(), 400);
    expect(await persisted()).toEqual(before);
  });

  it("isolates the old save, fixes the fifth material, reaches seven and mails permanent bound stacks 5+2 exactly once", async () => {
    const templates = await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`), profiles = await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`);
    const old = await action("wheel", { type: "start" }); expect(old).not.toHaveProperty("nativeWheelAction");
    const oldState = (await saved())!.games.wheel, start = await levelSeven(), requestId = randomUUID();
    expect((await saved())!.games.wheel).toEqual(oldState);
    const value = { type: "take-item", choice: start.nativeWheel.roundToken };
    const responses = await Promise.all(Array.from({ length: 5 }, () => native(value, requestId)));
    expect(responses.filter(result => !result.replayed)).toHaveLength(1); expect(responses.filter(result => result.nativeWheelAction)).toHaveLength(1);
    const delivered = await persisted();
    expect(responses[0]).toMatchObject({ points: 900, earned: 40, mailedCount: 1, nativeWheel: { phase: "settled", pending: null, fragments: 0, level: 7 } });
    expect(delivered.goods.map(item => [item.TemplateID, Number(item.Count), item.IsBinds, item.ValidDate])).toEqual([[11002, 5, true, 0], [11002, 2, true, 0]]);
    expect(delivered.mails).toHaveLength(1); expect([delivered.mails[0].Annex1, delivered.mails[0].Annex2].map(Number)).toEqual(delivered.goods.map(item => Number(item.ItemID)));
    await native({ type: "take-chip", choice: start.nativeWheel.roundToken }, randomUUID(), 400);
    await action("wheel", { type: "take" }, requestId, 409);
    expect((await native(value, requestId.toUpperCase())).replayed).toBe(true); expect(await persisted()).toEqual(delivered);
    const nativeState = (await saved())!.games.wheelNativeV1; await action("wheel", { type: "take" });
    expect((await saved())!.games.wheelNativeV1).toEqual(nativeState);
    expect(await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(templates);
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`)).toEqual(profiles);
  });

  it("keeps protected failure fresh, settles real zero-level chips and exchanges without virtual goods or earned points", async () => {
    const initial = await play("start"), old = initial.nativeWheel.roundToken;
    random.fraction = 0.99; const protectedResult = await play("protect");
    expect(protectedResult).toMatchObject({ points: 960, nativeWheel: { level: 1, spinCount: 2 },
      nativeWheelAction: { effects: [{ type: "rotated", success: false, protectedFailure: true, toLevel: 1 }] } });
    await native({ type: "protect", choice: old }, randomUUID(), 400);
    random.fraction = 0.99; const zero = await play("continue");
    expect(zero.nativeWheel).toMatchObject({ level: 0, phase: "failed", pending: { chipAmount: 20, item: null } });
    await native({ type: "take-item", choice: zero.nativeWheel.roundToken }, randomUUID(), 400);
    const chip = await play("take-chip"); expect(chip).toMatchObject({ mailedCount: 0, earned: 40, nativeWheel: { fragments: 20, pending: null, phase: "settled" } });
    expect((await persisted()).goods).toEqual([]);
    const exchange = await native({ type: "exchange", index: 2, count: 1, choice: chip.nativeWheel.roundToken });
    expect(exchange).toMatchObject({ points: 950, earned: 40, mailedCount: 1, nativeWheel: { fragments: 0 },
      nativeWheelAction: { effects: [{ type: "exchanged", chipsSpent: 20, templateId: 11021, itemCount: 1 }] } });
    expect((await persisted()).goods.map(item => item.TemplateID)).toEqual([11021]);
    await native({ type: "exchange", index: 2, count: 1, choice: exchange.nativeWheel.roundToken }, randomUUID(), 400);
    expect((await saved())!.daily.actions).toBe(3);
  });

  it("rolls back all five tables on a real mail or final receipt failure and retries the same item UUID once", async () => {
    const initial = await levelSeven(), before = await persisted(), requestId = randomUUID(), value = { type: "take-item", choice: initial.nativeWheel.roundToken };
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT wheel_native_mail_failure CHECK ("Annex2" IS NULL) NOT VALID`);
    await native(value, requestId, 500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT wheel_native_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT wheel_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    const failed = await post("wheel-native", value, requestId); expect(failed.statusCode).toBe(500); expect(failed.body).not.toMatch(/INSERT|UPDATE|Signature|Annex/); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT wheel_native_receipt_failure`);
    const taken = await native(value, requestId); expect(taken.nativeWheel.pending).toBeNull(); expect(taken.mailedCount).toBe(1);
    const delivered = await persisted(); expect(delivered.goods.map(item => Number(item.Count))).toEqual([5, 2]);
    expect((await native(value, requestId)).replayed).toBe(true); expect(await persisted()).toEqual(delivered);
  });

  it("atomically depletes the whole chip alternative and exchange balance, including receipt and template failure", async () => {
    const initial = await levelSeven(), requestId = randomUUID(), value = { type: "take-chip", choice: initial.nativeWheel.roundToken }, before = await persisted();
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT wheel_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    await native(value, requestId, 500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT wheel_native_receipt_failure`);
    const chip = await native(value, requestId), exchangeId = randomUUID(), exchange = { type: "exchange", index: 1, count: 7, choice: chip.nativeWheel.roundToken };
    expect(chip).toMatchObject({ mailedCount: 0, nativeWheel: { fragments: 140, pending: null } });
    const chipState = await persisted();
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11001`);
    await native(exchange, exchangeId, 503); expect(await persisted()).toEqual(chipState);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11001`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT wheel_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    await native(exchange, exchangeId, 500); expect(await persisted()).toEqual(chipState);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT wheel_native_receipt_failure`);
    expect(await native(exchange, exchangeId)).toMatchObject({ mailedCount: 1, nativeWheel: { fragments: 0 } });
    const delivered = await persisted(); expect(delivered.goods.map(item => [item.TemplateID, Number(item.Count)])).toEqual([[11001, 5], [11001, 2]]);
    expect((await native(exchange, exchangeId)).replayed).toBe(true); expect(await persisted()).toEqual(delivered);
    await native({ type: "take-item", choice: (await snapshot()).nativeWheel.roundToken }, randomUUID(), 400);
  });

  it("restores fixed prize and pending across restart/day, shares 500, and still allows existing settlement and exchange", async () => {
    await play("start"); random.fraction = 0.1; const two = await play("continue"), before = await persisted();
    await built.app.close(); await rebuild(); expect((await snapshot()).nativeWheel).toEqual(two.nativeWheel); expect(await persisted()).toEqual(before);
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z")); const next = await snapshot();
    expect(next.nativeWheel.roundToken).not.toBe(two.nativeWheel.roundToken); expect(next.nativeWheel.pending).toEqual(two.nativeWheel.pending); expect(await persisted()).toEqual(before);
    await native({ type: "take-item", choice: two.nativeWheel.roundToken }, randomUUID(), 400);
    const state = (await saved())!; state.day = "2026-10-16"; state.daily.actions = 499;
    await h.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    await action("wheel", { type: "start" }); const capped = await snapshot();
    expect(capped.nativeWheel).toMatchObject({ canContinue: false, canProtect: false, canTakeChip: true });
    const capState = await persisted(); await native({ type: "continue", choice: capped.nativeWheel.roundToken }, randomUUID(), 400); expect(await persisted()).toEqual(capState);
    const chip = await play("take-chip"); expect(chip.nativeWheel.fragments).toBe(40);
    const exchange = await native({ type: "exchange", index: 0, count: 1, choice: chip.nativeWheel.roundToken });
    expect(exchange.nativeWheel.fragments).toBe(20); expect((await saved())!.daily.actions).toBe(500);
    await action("wheel", { type: "take" }); expect((await saved())!.daily.actions).toBe(500);
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z")); const reset = await play("start"); expect(reset.nativeWheel.fragments).toBe(20);
    expect((await saved())!.daily.actions).toBe(1);
  });

  it("rejects wallet revision overflow before committing any pending consumption or mail", async () => {
    const initial = await levelSeven(); await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=2147483647 WHERE "UserID"=${uid}`);
    const before = await persisted(); await native({ type: "take-item", choice: initial.nativeWheel.roundToken }, randomUUID(), 409); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=7,"Points"=2147483647 WHERE "UserID"=${uid}`);
    const result = await play("take-chip"); expect(result).toMatchObject({ points: 2147483647, nativeWheel: { fragments: 140, pending: null } });
  });
});
