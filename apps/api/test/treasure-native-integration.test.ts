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

// Actual HTTP/auth, shared treasure save, in-memory PGlite transaction, receipt and original mail.
// Only Date/RNG are controlled; no existing database or service is opened.
const random = vi.hoisted(() => ({ fraction: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)) }));
const tmp = mkdtempSync(join(tmpdir(), "ddt-treasure-native-"));
const uid = 611, otherUid = 612, secret = "treasure-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "treasure-native-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId: string = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
async function action(id: string, value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(id, value, requestId); expect(response.statusCode, response.body).toBe(status);
  expect(response.body).not.toMatch(/nativeTreasureEffects|"(?:games|state|seed|choices)"\s*:/); return response.json();
}
const native = (value: ActivityAction, requestId: string = randomUUID(), status = 200) => action("treasure-native", value, requestId, status);
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); expect(response.body).not.toMatch(/nativeTreasureEffects|"(?:games|state|seed)"\s*:/);
  const result = response.json<ActivityResult>(); expect(result).not.toHaveProperty("nativeTreasureAction"); return result;
}
const draw = async (count: number, mode: "normal" | "advanced" = "normal") => native({ type: "draw", mode, count, choice: (await snapshot()).nativeTreasure.bagToken });
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
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z")); random.fraction = 0;
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS treasure_native_mail_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS treasure_native_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'treasure-native-test','tests-only'),(2,'other-treasure-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'treasure-native-test','Treasure native test',true,'2000-01-01',1),(${otherUid},'other-treasure-test','Other test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("original Treasure through the shared transactional API", () => {
  it("keeps GET pure, enforces ownership and reserves mode and selection contracts for their modules", async () => {
    await h.db.execute(sql`DELETE FROM app."ActivityWallet"`); const before = await persisted(), view = await snapshot();
    expect(view.nativeTreasure).toMatchObject({ started: false, score: 0, canDraw: false, bag: [], bagSlotsUsed: 0 });
    expect(view.nativeTreasure.bagToken).toMatch(/^2026-10-15:[A-Za-z0-9_-]{43}$/); expect(await persisted()).toEqual(before);
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post("treasure-native", { type: "draw", mode: "normal", choice: view.nativeTreasure.bagToken, count: 1 }, randomUUID(), otherUid)).statusCode).toBe(403);
    for (const value of [{ type: "draw", choice: view.nativeTreasure.bagToken, count: 1 }, { type: "draw", mode: "normal", choice: view.nativeTreasure.bagToken },
      { type: "draw", mode: "paid", choice: view.nativeTreasure.bagToken, count: 1 }, { type: "draw", mode: "normal", choice: "x".repeat(65), count: 1 },
      { type: "draw", mode: "normal", choice: view.nativeTreasure.bagToken, count: "1" }, { type: "draw", mode: "normal", choice: view.nativeTreasure.bagToken, count: 1, price: 0 },
      { type: "choose", choice: view.nativeTreasure.bagToken, index: 4, marked: true }, { type: "choose", choice: view.nativeTreasure.bagToken, index: 0, marked: "false" },
      { type: "take", choice: view.nativeTreasure.bagToken, index: 0, count: 1 }, { type: "recycle", choice: view.nativeTreasure.bagToken, index: 0 },
      { type: "take", choice: view.nativeTreasure.bagToken, items: [{ index: 0, count: 1 }] }]) await native(value as ActivityAction, randomUUID(), 400);
    for (const id of ["treasure", "moon", "moonlight-native", "gypsy-native", "ddplay-native", "cave"]) {
      await action(id, { type: "draw", mode: "normal", count: 1, choice: view.nativeTreasure.bagToken }, randomUUID(), 400);
    }
    expect(await persisted()).toEqual(before);
  });

  it("shares legacy category filtering, whole individual rows and original mail without changing role or item templates", async () => {
    const profiles = await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`), templates = await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`);
    const old = await action("treasure", { type: "draw", count: 2 }); expect(old).not.toHaveProperty("nativeTreasureAction");
    random.fraction = 0.99; const advanced = await draw(2, "advanced");
    expect(advanced).toMatchObject({ points: 820, nativeTreasure: { draws: 4, progressScore: 6, bagSlotsUsed: 4 } });
    expect(advanced.nativeTreasure.bag.map(row => [row.index, row.templateId, row.itemCount])).toEqual([[0, 11019, 1], [1, 11019, 1], [2, 11002, 2], [3, 11002, 2]]);
    const take = await native({ type: "take", index: 2, choice: advanced.nativeTreasure.bagToken });
    expect(take).toMatchObject({ mailedCount: 1, nativeTreasureAction: { effects: [{ type: "taken", itemCount: 2, items: [{ index: 2, templateId: 11002, itemCount: 2 }] }] } });
    expect(take.nativeTreasure.bag.map(row => [row.index, row.templateId, row.itemCount])).toEqual([[0, 11019, 1], [1, 11019, 1], [2, 11002, 2]]);
    const before = await persisted(); await native({ type: "take", index: 2, choice: advanced.nativeTreasure.bagToken }, randomUUID(), 400); expect(await persisted()).toEqual(before);
    const legacy = await action("treasure", { type: "take" }); expect(legacy).toMatchObject({ mailedCount: 1, nativeTreasure: { bag: [] } });
    expect((await persisted()).goods.map(item => [item.TemplateID, item.Count, item.IsBinds, item.ValidDate])).toEqual([
      [11002, 2, true, 0], [11019, 1, true, 0], [11019, 1, true, 0], [11002, 2, true, 0] ]);
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`)).toEqual(profiles);
    expect(await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(templates);
    for (const index of [1, 2, 3]) await native({ type: "choose", index, marked: false, choice: (await snapshot()).nativeTreasure.bagToken });
    const filtered = await action("treasure", { type: "draw", count: 2 }); expect(filtered.nativeTreasure.bag.every(row => row.templateId === 11019)).toBe(true);
    await native({ type: "draw", mode: "advanced", count: 1, choice: filtered.nativeTreasure.bagToken }, randomUUID(), 400);
    await native({ type: "choose", index: 0, marked: false, choice: filtered.nativeTreasure.bagToken }, randomUUID(), 400);
    expect((await saved())!.daily.actions).toBe(3);
  });

  it("commits one bounded five-draw transaction, handles duplicate UUIDs and never reanimates replay or GET", async () => {
    const initial = await snapshot(), requestId = randomUUID(), value = { type: "draw", mode: "advanced" as const, count: 5, choice: initial.nativeTreasure.bagToken };
    const responses = await Promise.all(Array.from({ length: 8 }, () => native(value, requestId)));
    expect(responses.filter(result => !result.replayed)).toHaveLength(1);
    expect(responses.filter(result => result.nativeTreasureAction)).toHaveLength(1); expect(responses.every(result => result.points === 700)).toBe(true);
    const receipt = await q<{ Result: Record<string, unknown> }>(h, sql`SELECT "Result" FROM app."ActivityActions"`);
    expect(receipt).toHaveLength(1); expect(Object.keys(receipt[0].Result).sort()).toEqual(["mailedCount", "message"]);
    expect((await saved())!.daily).toMatchObject({ draws: 5, actions: 1 }); expect((await persisted()).goods).toEqual([]);
    await action("treasure", { type: "draw", count: 1 }, requestId, 409);
    await native({ type: "draw", mode: "normal", count: 5, choice: initial.nativeTreasure.bagToken }, requestId, 409);
    const current = await snapshot(); await native({ type: "choose", index: 0, marked: false, choice: current.nativeTreasure.bagToken });
    const before = await persisted(); await native({ type: "draw", mode: "normal", count: 1, choice: current.nativeTreasure.bagToken }, randomUUID(), 400); expect(await persisted()).toEqual(before);
    const replay = await native(value, requestId.toUpperCase()); expect(replay.replayed).toBe(true); expect(replay).not.toHaveProperty("nativeTreasureAction");
    expect(replay.nativeTreasure.categories[0].selected).toBe(false); expect(await persisted()).toEqual(before);
  });

  it("rolls back every mail stack and all state on late receipt or mail failure, then retries the same UUID once", async () => {
    random.fraction = 0.99; await draw(5, "advanced"); const drawn = await draw(5, "advanced");
    expect(drawn.nativeTreasure.bag[9]).toMatchObject({ index: 9, templateId: 11021, itemCount: 4 });
    const before = await persisted(), requestId = randomUUID(), value = { type: "take", choice: drawn.nativeTreasure.bagToken };
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT treasure_native_mail_failure CHECK ("Annex2" IS NOT NULL) NOT VALID`);
    expect((await post("treasure-native", value, requestId)).statusCode).toBe(500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT treasure_native_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT treasure_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    const failed = await post("treasure-native", value, requestId); expect(failed.statusCode).toBe(500); expect(failed.body).not.toMatch(/INSERT|UPDATE|Signature|Annex/); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT treasure_native_receipt_failure`);
    const taken = await native(value, requestId); expect(taken).toMatchObject({ points: 400, revision: 3, mailedCount: 3, nativeTreasure: { bag: [] } });
    const delivered = await persisted(); expect(delivered.goods.map(item => [item.TemplateID, item.Count])).toEqual([
      ...Array.from({ length: 9 }, () => [11002, 2]), [11021, 2], [11021, 2] ]);
    expect(delivered.mails).toHaveLength(3); const annexes = delivered.mails.flatMap(mail => [mail.Annex1, mail.Annex2, mail.Annex3, mail.Annex4, mail.Annex5].filter(Boolean).map(Number));
    expect(annexes).toEqual(delivered.goods.map(item => item.ItemID));
    expect((await native(value, requestId)).replayed).toBe(true); expect(await persisted()).toEqual(delivered);
  });

  it("rolls back single-row mail, recycling, exchange and progress, including unavailable delivery templates", async () => {
    await draw(5, "advanced"); const initial = await draw(5, "advanced"), before = await persisted(), requestId = randomUUID();
    const take = { type: "take", index: 4, choice: initial.nativeTreasure.bagToken };
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11019`);
    await native(take, requestId, 503); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11019`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT treasure_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    for (const value of [take, { type: "recycle", choice: initial.nativeTreasure.bagToken }, { type: "exchange", choice: initial.nativeTreasure.bagToken },
      { type: "progress", tier: 2, choice: initial.nativeTreasure.bagToken }]) {
      await native(value, value === take ? requestId : randomUUID(), 500); expect(await persisted()).toEqual(before);
    }
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT treasure_native_receipt_failure`);
    const taken = await native(take, requestId); expect(taken.nativeTreasure.bag).toHaveLength(9);
    const recycled = await native({ type: "recycle", choice: taken.nativeTreasure.bagToken }); expect(recycled).toMatchObject({ points: 440, earned: 40, nativeTreasure: { bag: [] },
      nativeTreasureAction: { effects: [{ type: "recycled", pointsAwarded: 40, score: 440 }] } });
    const exchange = await native({ type: "exchange", choice: recycled.nativeTreasure.bagToken });
    expect(exchange).toMatchObject({ mailedCount: 1, nativeTreasure: { fragments: 0 }, nativeTreasureAction: { effects: [{ type: "exchanged", templateId: 11021, itemCount: 2 }] } });
    await action("treasure", { type: "exchange" }, randomUUID(), 400);
    const progress = await native({ type: "progress", tier: 2, choice: exchange.nativeTreasure.bagToken });
    expect(progress.nativeTreasure.progress[1]).toMatchObject({ claimed: true, canClaim: false }); await action("treasure", { type: "progress", tier: 2 }, randomUUID(), 400);
    expect((await persisted()).goods.map(item => [item.TemplateID, item.Count])).toEqual([[11019, 2], [11021, 2], [11019, 2], [11019, 2]]);
  });

  it("restores shared partial rows across restart and day switch, and protects revision and whole-recycle overflow at daily 500", async () => {
    const initial = await draw(3, "advanced"); await native({ type: "take", index: 1, choice: initial.nativeTreasure.bagToken });
    const old = await snapshot(), before = await persisted(); await built.app.close(); await rebuild(); expect(await snapshot()).toEqual(old); expect(await persisted()).toEqual(before);
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z")); const next = await snapshot();
    expect(next.nativeTreasure.bag).toEqual(old.nativeTreasure.bag); expect(next.nativeTreasure.bagToken).not.toBe(old.nativeTreasure.bagToken); expect(await persisted()).toEqual(before);
    await native({ type: "take", index: 1, choice: old.nativeTreasure.bagToken }, randomUUID(), 400); expect(await persisted()).toEqual(before);
    const state = (await saved())!; state.day = "2026-10-16"; state.daily.actions = 500;
    await h.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    const capped = await snapshot(); expect(capped.nativeTreasure.drawChoices.every(row => !row.canDraw)).toBe(true); expect(capped.nativeTreasure.canTake).toBe(true);
    await native({ type: "draw", mode: "normal", count: 1, choice: capped.nativeTreasure.bagToken }, randomUUID(), 400);
    const choose = await native({ type: "choose", index: 0, marked: false, choice: capped.nativeTreasure.bagToken }); expect((await saved())!.daily.actions).toBe(500);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=2147483647 WHERE "UserID"=${uid}`);
    const revision = await persisted(); await native({ type: "take", index: 0, choice: choose.nativeTreasure.bagToken }, randomUUID(), 409); expect(await persisted()).toEqual(revision);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=3,"Points"=2147483640 WHERE "UserID"=${uid}`);
    const noHeadroom = await snapshot(), full = await persisted(); expect(noHeadroom.nativeTreasure.canRecycle).toBe(false);
    await native({ type: "recycle", choice: noHeadroom.nativeTreasure.bagToken }, randomUUID(), 400); expect(await persisted()).toEqual(full);
    const settled = await native({ type: "take", choice: noHeadroom.nativeTreasure.bagToken }); expect(settled).toMatchObject({ points: 2147483640, nativeTreasure: { bag: [] }, mailedCount: 1 });
    expect((await saved())!.daily.actions).toBe(500);
  });
});
