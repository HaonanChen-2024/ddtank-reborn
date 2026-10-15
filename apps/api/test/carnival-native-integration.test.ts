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

// Real HTTP/auth/SQL/mail in an isolated in-memory PGlite. No live DB or service.
const random = vi.hoisted(() => ({ fraction: 0.99 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)) }));
const tmp = mkdtempSync(join(tmpdir(), "ddt-carnival-native-"));
const uid = 811, otherUid = 812, secret = "carnival-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "carnival-native-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId: string = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); const result = response.json<ActivityResult>();
  expect(result).not.toHaveProperty("nativeCarnivalAction"); expect(response.body).not.toMatch(/nativeCarnivalEffects|"(?:games|state|seed)"\s*:/); return result;
}
async function action(id: string, value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(id, value, requestId); expect(response.statusCode, response.body).toBe(status);
  expect(response.body).not.toMatch(/nativeCarnivalEffects|"(?:games|state|seed)"\s*:/); return response.json();
}
const native = (value: ActivityAction, requestId: string = randomUUID(), status = 200) => action("carnival-native", value, requestId, status);
const draw = async (count = 1) => native({ type: "draw", count, choice: (await snapshot()).nativeCarnival.stateToken });
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
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z")); random.fraction = 0.99;
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS carnival_native_second_mail_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS carnival_native_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false,"MaxCount"=2`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'carnival-native-test','tests-only'),(2,'other-carnival-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'carnival-native-test','Carnival native test',true,'2000-01-01',1),(${otherUid},'other-carnival-test','Other test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("native carnival through atomic account API", () => {
  it("keeps GET pure and rejects foreign characters, fake templates, wrong counts, legacy actions and missing fingerprints", async () => {
    await h.db.execute(sql`DELETE FROM app."ActivityWallet"`); const before = await persisted(), view = await snapshot(), choice = view.nativeCarnival.stateToken;
    expect(view.nativeCarnival).toMatchObject({ started: false, score: 0, remainDrawCount: 0, records: [] });
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post("carnival-native", { type: "draw", count: 1, choice }, randomUUID(), otherUid)).statusCode).toBe(403);
    for (const value of [{ type: "draw", count: 1 }, { type: "draw", choice }, { type: "draw", count: 6, choice },
      { type: "draw", count: 1, choice, index: 0 }, { type: "draw", count: 1, choice, price: 0 },
      { type: "draw", count: 1, choice, templateId: 999 }, { type: "exchange", index: 7, count: 1, choice },
      { type: "exchange", index: 0, count: 11, choice }, { type: "take", choice }, { type: "roll", choice }]) {
      await native(value as ActivityAction, randomUUID(), 400);
    }
    expect(await persisted()).toEqual(before);
  });

  it("commits finite continuous draws once, mails real stacks and keeps old dice save and template attributes intact", async () => {
    const templates = await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`);
    const legacy = await action("carnival", { type: "roll" }); const old = structuredClone((await saved())!.games.carnival);
    const value = { type: "draw", count: 5, choice: (await snapshot()).nativeCarnival.stateToken }, requestId = randomUUID();
    const responses = await Promise.all([native(value, requestId), native(value, requestId)]);
    expect(responses.filter(result => !result.replayed)).toHaveLength(1); expect(responses.filter(result => result.nativeCarnivalAction)).toHaveLength(1);
    const committed = responses.find(result => !result.replayed)!;
    expect(committed).toMatchObject({ points: legacy.points - 50, earned: 40, mailedCount: 2, nativeCarnival: { personalScore: 5, redPackageCount: 15 } });
    expect(committed.nativeCarnivalAction!.effects.map(effect => effect.type === "drawn" && effect.drawId)).toEqual([1, 2, 3, 4, 5]);
    expect((await saved())!.games.carnival).toEqual(old); expect((await saved())!.daily.actions).toBe(6);
    const delivered = await persisted(); expect(delivered.goods.map(item => Number(item.Count))).toEqual([2, 2, 2, 2, 2, 2, 2, 1]);
    expect(delivered.goods.every(item => item.IsBinds && Number(item.ValidDate) === 0 && Number(item.TemplateID) === 11002)).toBe(true);
    const annexes = delivered.mails.flatMap(mail => [mail.Annex1, mail.Annex2, mail.Annex3, mail.Annex4, mail.Annex5].filter(Boolean).map(Number));
    expect(annexes).toEqual(delivered.goods.map(item => Number(item.ItemID))); expect(new Set(annexes).size).toBe(8);
    expect(await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(templates);
    expect((await native(value, requestId)).replayed).toBe(true); expect(await persisted()).toEqual(delivered);
    await native({ ...value, count: 1 }, requestId, 409); await action("carnival", { type: "roll" }, requestId, 409);
    const nativeSave = structuredClone((await saved())!.games.carnivalNativeV1);
    await action("carnival", { type: "roll" }); expect((await saved())!.games.carnivalNativeV1).toEqual(nativeSave);
  });

  it("restores mailed results after a lost response/restart and replays only current snapshot without another animation or reward", async () => {
    const choice = (await snapshot()).nativeCarnival.stateToken, requestId = randomUUID(), value = { type: "draw", count: 5, choice };
    // Discard first HTTP response: mail/state/receipt still have to survive re-entry.
    await post("carnival-native", value, requestId); const delivered = await persisted();
    await built.app.close(); await rebuild(); const reopened = await snapshot(); expect(reopened.nativeCarnival.records).toHaveLength(5);
    const again = await native(value, requestId); expect(again).toMatchObject({ replayed: true, mailedCount: 2 });
    expect(again).not.toHaveProperty("nativeCarnivalAction"); expect(await persisted()).toEqual(delivered);
    await draw(); const newer = await snapshot(); const replay = await native(value, requestId);
    expect(replay.nativeCarnival).toEqual(newer.nativeCarnival); expect(replay).not.toHaveProperty("nativeCarnivalAction");
    const receipt = await q1<{ Result: Record<string, unknown> }>(h, sql`SELECT "Result" FROM app."ActivityActions" WHERE "RequestID"=${requestId}`);
    expect(receipt!.Result).toEqual({ message: again.message, mailedCount: 2 });
  });

  it("rolls back the second mail and final receipt across all five tables, then retries the entire same batch UUID", async () => {
    const value = { type: "draw", count: 5, choice: (await snapshot()).nativeCarnival.stateToken }, requestId = randomUUID(), before = await persisted();
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT carnival_native_second_mail_failure CHECK ("Annex5" IS NOT NULL) NOT VALID`);
    await native(value, requestId, 500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT carnival_native_second_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT carnival_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    const failed = await post("carnival-native", value, requestId); expect(failed.statusCode).toBe(500); expect(failed.body).not.toMatch(/INSERT|UPDATE|Signature|Annex/);
    expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT carnival_native_receipt_failure`);
    expect(await native(value, requestId)).toMatchObject({ points: 950, mailedCount: 2, nativeCarnival: { redPackageCount: 15, personalScore: 5 } });
    const delivered = await persisted(); expect((await native(value, requestId)).replayed).toBe(true); expect(await persisted()).toEqual(delivered);
  });

  it("rejects stale or repeated packet exchange, delivers bounded stacks and rolls back unsafe template or receipt failures", async () => {
    await draw(5); const initial = await draw(5), value = { type: "exchange", index: 4, count: 1, choice: initial.nativeCarnival.stateToken }, requestId = randomUUID();
    const before = await persisted(); await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11019`);
    await native(value, requestId, 503); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11019`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT carnival_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    await native(value, requestId, 500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT carnival_native_receipt_failure`);
    const exchanged = await native(value, requestId); expect(exchanged).toMatchObject({ points: 900, earned: 40, mailedCount: 1,
      nativeCarnival: { redPackageCount: 10 }, nativeCarnivalAction: { effects: [{ type: "exchanged", catalogId: 5, redPacketsSpent: 20, itemCount: 10 }] } });
    expect((await saved())!.daily.actions).toBe(10); const delivered = await persisted();
    expect(delivered.goods.filter(item => Number(item.TemplateID) === 11019).map(item => Number(item.Count))).toEqual([2, 2, 2, 2, 2]);
    await native(value, randomUUID(), 400); expect(await persisted()).toEqual(delivered);
    const late = { type: "exchange", index: 0, count: 1, choice: exchanged.nativeCarnival.stateToken };
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z")); const nextDay = await snapshot(); expect(nextDay.nativeCarnival.stateToken).not.toBe(late.choice);
    await native(late, randomUUID(), 400); expect(await persisted()).toEqual(delivered);
    expect(await native({ ...late, choice: nextDay.nativeCarnival.stateToken })).toMatchObject({ nativeCarnival: { redPackageCount: 0 } });
  });

  it("counts each draw in shared 500 allowance, refuses oversized batches and permits cap/day packet settlement", async () => {
    await draw(5); const state = (await saved())!; state.daily.actions = 497;
    await h.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    const partial = await snapshot(); expect(partial.nativeCarnival).toMatchObject({ remainDrawCount: 3, maxBatchCount: 3 });
    const before = await persisted(); await native({ type: "draw", count: 5, choice: partial.nativeCarnival.stateToken }, randomUUID(), 400); expect(await persisted()).toEqual(before);
    await action("carnival", { type: "roll" }); await draw(2); const capped = await snapshot(); expect(capped.nativeCarnival).toMatchObject({ canDraw: false, remainDrawCount: 0 });
    const cappedState = await persisted(); await native({ type: "draw", count: 1, choice: capped.nativeCarnival.stateToken }, randomUUID(), 400); expect(await persisted()).toEqual(cappedState);
    await native({ type: "exchange", index: 0, count: 1, choice: capped.nativeCarnival.stateToken }); expect((await saved())!.daily.actions).toBe(500);
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z")); await draw(5); expect((await saved())!.daily.actions).toBe(5);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=49 WHERE "UserID"=${uid}`); const poor = await snapshot(), poorState = await persisted();
    expect(poor.nativeCarnival.maxBatchCount).toBe(4); await native({ type: "draw", count: 5, choice: poor.nativeCarnival.stateToken }, randomUUID(), 400); expect(await persisted()).toEqual(poorState);
  });

  it("rejects wallet revision overflow before draw, mail or packet changes", async () => {
    const initial = await snapshot(); await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=2147483647 WHERE "UserID"=${uid}`);
    const before = await persisted(); await native({ type: "draw", count: 5, choice: initial.nativeCarnival.stateToken }, randomUUID(), 409); expect(await persisted()).toEqual(before);
  });

  it("serializes competing fingerprints so distinct UUIDs cannot consume the same pre-draw or packet state twice", async () => {
    const initial = await snapshot(), value = { type: "draw", count: 5, choice: initial.nativeCarnival.stateToken };
    const draws = await Promise.all([post("carnival-native", value), post("carnival-native", value)]);
    expect(draws.map(response => response.statusCode).sort()).toEqual([200, 400]);
    expect((await snapshot()).nativeCarnival).toMatchObject({ personalScore: 5, redPackageCount: 15 });
    const exchange = { type: "exchange", index: 0, count: 1, choice: (await snapshot()).nativeCarnival.stateToken };
    const exchanges = await Promise.all([post("carnival-native", exchange), post("carnival-native", exchange)]);
    expect(exchanges.map(response => response.statusCode).sort()).toEqual([200, 400]);
    const delivered = await persisted(); expect(delivered.receipts).toHaveLength(2);
    expect((await snapshot()).nativeCarnival.redPackageCount).toBe(5); expect((await saved())!.daily.actions).toBe(5);
  });
});
