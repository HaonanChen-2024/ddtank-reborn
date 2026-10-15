import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// Actual HTTP/auth, engine, in-memory PGlite transaction, UUID receipt and ordinary mail.
// Only Date and RNG are deterministic; no real service, character or resource directory is modified.
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(0.99 * min) : min + Math.floor(0.99 * (max - min)) }));
const tmp = mkdtempSync(join(tmpdir(), "ddt-ddplay-native-"));
const uid = 411, otherUid = 412, secret = "ddplay-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "ddplay-native-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
async function action(id: string, value: ActivityAction, requestId = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(id, value, requestId); expect(response.statusCode, response.body).toBe(status);
  expect(response.body).not.toMatch(/nativeDDPlayEffects|"(?:faces|games|state|nextFaces|seed)"\s*:/); return response.json();
}
const native = (value: ActivityAction, requestId = randomUUID(), status = 200) => action("ddplay-native", value, requestId, status);
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); expect(response.body).not.toMatch(/nativeDDPlayEffects|"(?:faces|games|state|nextFaces|seed)"\s*:/);
  const result = response.json<ActivityResult>(); expect(result).not.toHaveProperty("nativeDDPlayAction"); return result;
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
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 5,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  await h.db.insert(game.Shop_Goods).values(template); await rebuild();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS ddplay_native_mail_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions", app."ActivityStates", app."ActivityWallet", app."EventClaims",
    member."Accounts", player."Sys_Users_Detail", player."Sys_Users_Goods", player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'ddplay-native-test','tests-only'),(2,'other-ddplay-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'ddplay-native-test','DDPlay native test',true,'2000-01-01',1),(${otherUid},'other-ddplay-test','Other test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},100,40)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("native DDPlay through the existing transactional API", () => {
  it("keeps GET read-only, requires current ownership and rejects invalid actions without creating a save", async () => {
    await h.db.execute(sql`DELETE FROM app."ActivityWallet"`);
    const before = await persisted();
    expect((await snapshot()).nativeDDPlay).toMatchObject({ spins: 0, score: 0, lastResult: null, canSpin: false, canExchange: false });
    expect(await persisted()).toEqual(before);
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post("ddplay-native", { type: "spin" }, randomUUID(), otherUid)).statusCode).toBe(403);
    await native({ type: "spin" }, randomUUID(), 400);
    for (const invalid of [{ type: "spin", count: 1 }, { type: "exchange" }, { type: "exchange", count: 0 },
      { type: "exchange", count: 11 }, { type: "exchange", count: "1" }, { type: "exchange", count: 1, tier: 1 }]) {
      await native(invalid as ActivityAction, randomUUID(), 400);
    }
    expect(await persisted()).toEqual(before);
  });

  it("charges and awards one spin under concurrent UUID retries and replays the latest shared legacy progress without animation", async () => {
    const id = randomUUID(), profiles = await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`);
    const responses = await Promise.all(Array.from({ length: 8 }, () => post("ddplay-native", { type: "spin" }, id)));
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(responses.filter(response => response.json().replayed)).toHaveLength(7);
    expect(responses.filter(response => response.json().nativeDDPlayAction)).toHaveLength(1);
    const fresh = responses.find(response => !response.json().replayed)!.json<ActivityResult>();
    expect(fresh).toMatchObject({ points: 190, earned: 40, revision: 1, mailedCount: 0, nativeDDPlay: { spins: 1, score: 190 },
      nativeDDPlayAction: { requestId: id, effects: [{ type: "spun", multiplier: 10, reels: [3, 3, 3], pointsDelta: 90, score: 190 }] } });
    const legacy = await action("ddplay", { type: "spin" }); expect(legacy).toMatchObject({ points: 280, nativeDDPlay: { spins: 2 } });
    expect(legacy).not.toHaveProperty("nativeDDPlayAction");
    expect((await saved())!.games.ddplay).toEqual({ version: 1, kind: "ddplay", spins: 2, faces: [5, 5, 5] });
    expect((await saved())!.completed.ddplay).toBe(2); expect((await saved())!.games).not.toHaveProperty("ddplayNativeV1");
    const before = await persisted(), { nativeExchange: _exchange, ...latest } = await snapshot(), replay = await native({ type: "spin" }, id);
    expect(replay).toMatchObject({ ...latest, replayed: true, mailedCount: 0 }); expect(replay).not.toHaveProperty("nativeDDPlayAction");
    await native({ type: "exchange", count: 1 }, id, 409); expect(await persisted()).toEqual(before);
    expect(before.goods).toHaveLength(0); expect(before.mails).toHaveLength(0);
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`)).toEqual(profiles);
  });

  it("deduplicates a point exchange and serializes different requests against the same balance, mailing real materials once", async () => {
    const id = randomUUID(), responses = await Promise.all(Array.from({ length: 8 }, () => post("ddplay-native", { type: "exchange", count: 4 }, id)));
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(responses.filter(response => response.json().nativeDDPlayAction)).toHaveLength(1);
    expect((await snapshot()).points).toBe(60); expect((await persisted()).goods).toHaveLength(1); expect((await persisted()).mails).toHaveLength(1);
    const racing = await Promise.all([post("ddplay-native", { type: "exchange", count: 4 }), post("ddplay-native", { type: "exchange", count: 4 })]);
    expect(racing.map(response => response.statusCode).sort()).toEqual([200, 400]);
    const delivered = await persisted(); expect(delivered.goods).toHaveLength(2); expect(delivered.mails).toHaveLength(2);
    expect(delivered.goods.reduce((sum, row) => sum + Number(row.Count), 0)).toBe(8); expect((await snapshot()).points).toBe(20);
    for (const item of delivered.goods) expect(item).toMatchObject({ TemplateID: 11019, Count: 4, UserID: 0, Place: -1, IsBinds: true,
      ValidDate: 0, StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, AgilityCompose: 0, LuckCompose: 0 });
    expect(delivered.mails.map(mail => Number(mail.Annex1))).toEqual(delivered.goods.map(item => item.ItemID));
    expect(delivered.mails.every(mail => mail.ReceiverID === uid)).toBe(true);
    expect(delivered.receipts.every(receipt => Object.keys(receipt.Result as object).sort().join(",") === "mailedCount,message")).toBe(true);
  });

  it("rolls back points, state, items and receipts after late mail failure or invalid material template before retrying the same UUID", async () => {
    await native({ type: "spin" }); const before = await persisted(), id = randomUUID();
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT ddplay_native_mail_failure CHECK ("Annex2" IS NOT NULL) NOT VALID`);
    const failed = await post("ddplay-native", { type: "exchange", count: 4 }, id);
    expect(failed.statusCode, failed.body).toBe(500); expect(failed.body).not.toMatch(/Annex|INSERT|UPDATE|faces/); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT ddplay_native_mail_failure`);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true`);
    await native({ type: "exchange", count: 4 }, id, 503); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
    const committed = await native({ type: "exchange", count: 4 }, id);
    expect(committed).toMatchObject({ points: 150, nativeDDPlay: { spins: 1, lastResult: { multiplier: 10, reels: [3, 3, 3] } },
      nativeDDPlayAction: { effects: [{ type: "exchanged", count: 4, cost: 40, templateId: 11019, itemCount: 4, score: 150 }] } });
    const after = await persisted(); expect((await native({ type: "exchange", count: 4 }, id)).replayed).toBe(true); expect(await persisted()).toEqual(after);
    expect(after.mails).toHaveLength(1); expect(after.goods).toHaveLength(1);
  });

  it("refuses overflowing settlement without writes, accepts the same UUID after funds are repaired and observes original stack limits", async () => {
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=2147483647 WHERE "UserID"=${uid}`);
    const before = await persisted(), id = randomUUID();
    await native({ type: "spin" }, id, 400); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=100 WHERE "UserID"=${uid}`);
    const spin = await native({ type: "spin" }, id); expect(spin.points).toBe(190);
    const exchange = await native({ type: "exchange", count: 10 }); expect(exchange).toMatchObject({ points: 90, mailedCount: 1 });
    const delivered = await persisted(); expect(delivered.goods.map(item => item.Count)).toEqual([5, 5]);
    expect(delivered.mails).toHaveLength(1); expect(Number(delivered.mails[0].Annex1)).toBe(delivered.goods[0].ItemID);
    expect(Number(delivered.mails[0].Annex2)).toBe(delivered.goods[1].ItemID);
  });

  it("restores legacy progress on application restart, refreshes the date on read and permits earned points exchange at the play ceiling", async () => {
    await action("ddplay", { type: "spin" }); const state = (await saved())!; state.daily.actions = 500;
    await h.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid} AND "Activity"='reference'`);
    const old = await snapshot(), before = await persisted(); expect(old.nativeDDPlay).toMatchObject({ spins: 1, score: 190, canSpin: false, canExchange: true });
    await built.app.close(); await rebuild(); expect(await snapshot()).toEqual(old); expect(await persisted()).toEqual(before);
    await native({ type: "spin" }, randomUUID(), 400); expect(await persisted()).toEqual(before);
    await native({ type: "exchange", count: 1 }); expect((await saved())!.daily.actions).toBe(500);
    expect((await saved())!.games.ddplay).toEqual(state.games.ddplay);
    const savedBeforeDay = await persisted(); vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    expect((await snapshot()).nativeDDPlay).toMatchObject({ spins: 1, score: 180, canSpin: true, canExchange: true, lastResult: { multiplier: 10 } });
    expect(await persisted()).toEqual(savedBeforeDay);
  });
});
