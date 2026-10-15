import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { advanceMoonlight } from "../src/activities/moonlight-native.js";
import { createActivityState } from "../src/activities/engine.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// Actual HTTP/auth, shared moon save, in-memory PGlite transaction, receipt and original mail.
// Only Date/RNG are controlled; no existing database or service is opened.
const random = vi.hoisted(() => ({ fraction: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)) }));
const tmp = mkdtempSync(join(tmpdir(), "ddt-moonlight-native-"));
const uid = 611, otherUid = 612, secret = "moonlight-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "moonlight-native-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId: string = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
async function action(id: string, value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(id, value, requestId); expect(response.statusCode, response.body).toBe(status);
  expect(response.body).not.toMatch(/nativeMoonlightEffects|"(?:games|seed|choices)"\s*:/); const result = response.json();
  expect(result).not.toHaveProperty("state"); if (result.nativeMoonlight) expect(JSON.stringify(result.nativeMoonlight)).not.toMatch(/"state"\s*:/); return result;
}
const native = (value: ActivityAction, requestId: string = randomUUID(), status = 200) => action("moonlight-native", value, requestId, status);
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); expect(response.body).not.toMatch(/nativeMoonlightEffects|"(?:games|seed)"\s*:/);
  const result = response.json<ActivityResult>(); expect(result).not.toHaveProperty("nativeMoonlightAction"); expect(result).not.toHaveProperty("state");
  expect(JSON.stringify(result.nativeMoonlight)).not.toMatch(/"state"\s*:/); return result;
}
const draw = async (count: number) => native({ type: "draw", count, choice: (await snapshot()).nativeMoonlight.bagToken });
const saved = async () => (await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))?.State;
async function storeScore(characterId: number, score: number, activity = "reference", corrupt = false) {
  const state = createActivityState(new Date());
  // Build the shared save through its real owner, never a fabricated public ranking result.
  for (let left = score; left > 0; left -= 5) state.games.moon = advanceMoonlight(state.games.moon,
    { type: "draw", count: Math.min(left, 5) }, { now: new Date() }, { points: 1000 }, guaranteed => ({ templateId: guaranteed ? 11021 : 11019, count: guaranteed ? 2 : 1 })).state;
  if (corrupt) (state.games.moon as { draws: number }).draws = -1;
  state.games.privateOtherActivity = { seed: "must-never-be-public", board: [7, 8, 9] };
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${characterId},1000,40) ON CONFLICT DO NOTHING`);
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${characterId},${activity},${JSON.stringify(state)}::jsonb)
    ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
}
async function addRankRole(characterId: number, score: number, account = true) {
  const userName = `rank-role-${characterId}`;
  if (account) await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (${characterId},${userName},'tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${characterId},${userName},${`榜单角色${characterId}`},true,'2000-01-01',1)`);
  await storeScore(characterId, score);
}
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
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS moonlight_native_mail_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS moonlight_native_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'moonlight-native-test','tests-only'),(2,'other-moonlight-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'moonlight-native-test','Moonlight native test',true,'2000-01-01',1),(${otherUid},'other-moonlight-test','Other test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("original Moonlight through the shared transactional API", () => {
  it("reads a genuine local top ten with competition ties, deterministic ids and the actor's rank outside the slice without writes", async () => {
    await storeScore(uid, 2);
    const scores = [12, 12, 11, 10, 9, 8, 7, 6, 5, 5, 5];
    for (let index = scores.length - 1; index >= 0; index--) await addRankRole(900 + index, scores[index]);
    const before = await persisted(), rank = (await snapshot()).nativeMoonlight.ranking!;
    expect(rank).toMatchObject({ version: 1, kind: "moonlight-native-ranking", scope: "local", metric: "cumulative-box-draws", personalScore: 2, personalRank: 12 });
    expect(rank.entries.map(row => [row.characterId, row.rank, row.score])).toEqual(scores.slice(0, 10).map((score, index) => [900 + index, index === 1 ? 1 : index === 9 ? 9 : index + 1, score]));
    expect(rank.entries.every(row => Object.keys(row).sort().join(",") === "characterId,nickName,rank,score")).toBe(true);
    expect(JSON.stringify(rank)).not.toMatch(/must-never-be-public|rank-role-|fragments|claimed|wallet|seed|board/);
    expect(await persisted()).toEqual(before);
  });

  it("excludes banned, deleted, forbidden, unnamed, orphaned, zero, malformed and other-activity roles, respecting account ownership", async () => {
    await storeScore(uid, 1); await storeScore(otherUid, 2);
    await h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "NickName"='2026-10-15 12:00:00' WHERE "UserID"=${otherUid}`);
    for (let id = 900; id <= 906; id++) await addRankRole(id, 5, id !== 904);
    await h.db.execute(sql`UPDATE member."Accounts" SET "IsBanned"=true WHERE "ID"=900`);
    await h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "IsExist"=false WHERE "UserID"=901`);
    await h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "ForbidDate"='2099-01-01' WHERE "UserID"=902`);
    await h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "NickName"='  ' WHERE "UserID"=903`);
    await storeScore(905, 5, "reference", true);
    await h.db.execute(sql`DELETE FROM app."ActivityStates" WHERE "UserID"=906`); await storeScore(906, 5, "different-activity");
    await addRankRole(907, 0);
    const before = await persisted(), rank = (await snapshot()).nativeMoonlight.ranking!;
    expect(rank.entries.map(row => [row.characterId, row.score])).toEqual([[otherUid, 2], [uid, 1]]);
    expect(rank.personalRank).toBe(2); expect(rank.entries[0].nickName).toBe("2026-10-15 12:00:00");
    const foreign = await built.app.inject({ url: `/api/account/activities?characterId=${otherUid}`, headers: headers() });
    expect(foreign.statusCode).toBe(403); expect(foreign.body).not.toMatch(/entries|Other test|ranking|seed|board/);
    expect(await persisted()).toEqual(before);
  });

  it("counts old and native committed draws once, excludes settlements, leaves POST ranking null and persists across restart and midnight", async () => {
    const unstarted = await snapshot(), before = await persisted();
    expect(unstarted.nativeMoonlight.ranking).toMatchObject({ entries: [], personalScore: 0, personalRank: null });
    expect(await persisted()).toEqual(before);
    await storeScore(otherUid, 1); const first = await snapshot(); await storeScore(otherUid, 2); const fresh = await snapshot();
    expect(fresh.nativeMoonlight.bagToken).toBe(first.nativeMoonlight.bagToken); expect(fresh.nativeMoonlight.ranking!.entries[0].score).toBe(2);
    const old = await action("moon", { type: "draw", count: 2 }); expect(old.nativeMoonlight.ranking).toBeNull();
    const choice = (await snapshot()).nativeMoonlight.bagToken, requestId = randomUUID(), value = { type: "draw", count: 3, choice };
    const beforeDraw = await persisted();
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT moonlight_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    expect((await post("moonlight-native", value, requestId)).statusCode).toBe(500); expect(await persisted()).toEqual(beforeDraw);
    expect((await snapshot()).nativeMoonlight.ranking!.personalScore).toBe(2);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT moonlight_native_receipt_failure`);
    const drawn = await native(value, requestId); expect(drawn.nativeMoonlight.ranking).toBeNull();
    const delivered = await persisted(), replay = await native(value, requestId);
    expect(replay.nativeMoonlight.ranking).toBeNull(); expect(await persisted()).toEqual(delivered);
    const rank = (await snapshot()).nativeMoonlight.ranking!; expect(rank).toMatchObject({ personalScore: 5, personalRank: 1 });
    await action("moon", { type: "take" }); expect((await snapshot()).nativeMoonlight.ranking).toEqual(rank);
    await built.app.close(); await rebuild(); expect((await snapshot()).nativeMoonlight.ranking).toEqual(rank);
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z")); expect((await snapshot()).nativeMoonlight.ranking).toEqual(rank);
    expect((await persisted()).receipts).toHaveLength(3);
  });

  it("withholds a ranking when a real draw commit crosses the actor snapshot and its later ranking read", async () => {
    await storeScore(uid, 2);
    const execute = h.db.execute.bind(h.db), dialect = new PgDialect(); let changed = false;
    const reader = vi.spyOn(h.db, "execute").mockImplementation((...args) => {
      const statement = typeof args[0] === "string" ? args[0] : dialect.sqlToQuery(args[0].getSQL()).sql, query = execute(...args);
      if (!changed && statement.includes('AS "Public"') && statement.includes("->'moon'")) {
        changed = true; const run = query.execute.bind(query);
        query.execute = async () => { await storeScore(uid, 3); return run(); };
      }
      return query;
    });
    try {
      const crossed = await snapshot(); expect(changed).toBe(true);
      expect(crossed.nativeMoonlight.draws).toBe(2); expect(crossed.nativeMoonlight.ranking).toBeNull();
    } finally { reader.mockRestore(); }
    expect((await snapshot()).nativeMoonlight.ranking).toMatchObject({ personalScore: 3, personalRank: 1 });
  });

  it("keeps an absent bag read-only, verifies account ownership and reserves nested selections for the native route", async () => {
    await h.db.execute(sql`DELETE FROM app."ActivityWallet"`); const before = await persisted(), view = await snapshot();
    expect(view.nativeMoonlight).toMatchObject({ started: false, score: 0, canDraw: false, bag: [], bagSlotsUsed: 0 });
    expect(view.nativeMoonlight.bagToken).toMatch(/^2026-10-15:[A-Za-z0-9_-]{43}$/); expect(await persisted()).toEqual(before);
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post("moonlight-native", { type: "draw", choice: view.nativeMoonlight.bagToken, count: 1 }, randomUUID(), otherUid)).statusCode).toBe(403);
    for (const value of [{ type: "draw", choice: view.nativeMoonlight.bagToken }, { type: "draw", choice: view.nativeMoonlight.bagToken, count: 2 },
      { type: "draw", choice: view.nativeMoonlight.bagToken, count: "3" }, { type: "draw", choice: "x".repeat(65), count: 1 },
      { type: "draw", choice: view.nativeMoonlight.bagToken, count: 1, price: 0 }, { type: "take", choice: view.nativeMoonlight.bagToken, items: [{ index: 0, count: 1, templateId: 1001 }] },
      { type: "take", choice: view.nativeMoonlight.bagToken, items: [{ index: 0, count: "1" }] }, { type: "take", choice: view.nativeMoonlight.bagToken, items: [{ index: 4, count: 1 }] }]) {
      await native(value as ActivityAction, randomUUID(), 400);
    }
    for (const id of ["moon", "gypsy", "ddplay-native", "treasure"]) await action(id, { type: "take", items: [{ index: 0, count: 1 }] }, randomUUID(), 400);
    expect(await persisted()).toEqual(before);
  });

  it("shares old draws and native selected quantities, sends ordinary mail and preserves the old whole-bag settlement", async () => {
    const profiles = await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`);
    const templates = await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`);
    const first = await action("moon", { type: "draw", count: 2 }); expect(first).not.toHaveProperty("nativeMoonlightAction");
    random.fraction = 0.9; const second = await draw(3); expect(second).toMatchObject({ points: 900, nativeMoonlight: { draws: 5, bagSlotsUsed: 5 } });
    expect(second.nativeMoonlight.bag).toEqual([{ index: 0, templateId: 11019, itemCount: 2, recycleUnitPoints: 2 }, { index: 1, templateId: 11021, itemCount: 3, recycleUnitPoints: 2 }]);
    const before = await persisted();
    for (const items of [[{ index: 0, count: 1 }, { index: 0, count: 1 }], [{ index: 0, count: 1 }, { index: 1, count: 4 }]]) {
      await native({ type: "take", choice: second.nativeMoonlight.bagToken, items }, randomUUID(), 400); expect(await persisted()).toEqual(before);
    }
    const requestId = randomUUID(), value = { type: "take", choice: second.nativeMoonlight.bagToken, items: [{ index: 1, count: 2 }, { index: 0, count: 1 }] };
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11021`);
    await native(value, requestId, 503); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11021`);
    const take = await native(value, requestId);
    expect(take).toMatchObject({ points: 900, mailedCount: 1, nativeMoonlightAction: { requestId, effects: [{ type: "taken", itemCount: 3,
      items: [{ index: 0, templateId: 11019, itemCount: 1 }, { index: 1, templateId: 11021, itemCount: 2 }] }] } });
    const partial = await persisted(); expect(partial.goods.map(item => [item.TemplateID, item.Count])).toEqual([[11019, 1], [11021, 2]]);
    expect(take.nativeMoonlight).toMatchObject({ bagSlotsUsed: 2, bag: [{ index: 0, itemCount: 1 }, { index: 1, itemCount: 1 }] });
    await native({ type: "recycle", choice: second.nativeMoonlight.bagToken, items: [{ index: 0, count: 1 }] }, randomUUID(), 400);
    const oldTake = await action("moon", { type: "take" }); expect(oldTake.nativeMoonlight.bag).toEqual([]); expect(oldTake).not.toHaveProperty("nativeMoonlightAction");
    expect((await persisted()).goods.reduce((sum, item) => sum + Number(item.Count), 0)).toBe(5);
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`)).toEqual(profiles);
    expect(await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(templates);
    expect((await saved())!.games).not.toHaveProperty("moonlightNativeV1");
    for (const item of (await persisted()).goods) expect(item).toMatchObject({ UserID: 0, Place: -1, IsBinds: true, ValidDate: 0,
      StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, AgilityCompose: 0, LuckCompose: 0 });
  });

  it("deduplicates batch draws, serializes take versus recycle and returns only current static projections on replay", async () => {
    const requestId = randomUUID(), value = { type: "draw", count: 3, choice: (await snapshot()).nativeMoonlight.bagToken };
    const same = await Promise.all(Array.from({ length: 8 }, () => post("moonlight-native", value, requestId)));
    expect(same.every(response => response.statusCode === 200)).toBe(true); expect(same.filter(response => response.json().nativeMoonlightAction)).toHaveLength(1);
    expect(same.filter(response => response.json().replayed)).toHaveLength(7);
    const first = await snapshot(); expect(first).toMatchObject({ points: 940, revision: 1, nativeMoonlight: { draws: 3, bagSlotsUsed: 3 } });
    const choice = first.nativeMoonlight.bagToken, items = [{ index: 0, count: 3 }];
    const competing = await Promise.all([post("moonlight-native", { type: "take", choice, items }), post("moonlight-native", { type: "recycle", choice, items })]);
    expect(competing.map(response => response.statusCode).sort()).toEqual([200, 400]);
    const committed = competing.find(response => response.statusCode === 200)!.json<ActivityResult>(), { nativeExchange: _exchange, ...final } = await snapshot(), after = await persisted();
    expect(final.nativeMoonlight.bag).toEqual([]); expect(after.receipts).toHaveLength(2);
    const took = committed.nativeMoonlightAction!.effects[0].type === "taken";
    expect(final.points).toBe(took ? 940 : 946); expect(after.goods).toHaveLength(took ? 2 : 0); expect(after.mails).toHaveLength(took ? 1 : 0);
    const replay = await native(value, requestId); expect(replay).toMatchObject({ points: final.points, earned: final.earned, revision: final.revision, nativeMoonlight: { ...final.nativeMoonlight, ranking: null }, replayed: true }); expect(replay).not.toHaveProperty("nativeMoonlightAction");
    await native({ ...value, count: 5 }, requestId, 409); await action("ddplay-native", { type: "spin" }, requestId, 409);
    expect(await persisted()).toEqual(after); expect(after.receipts.every(row => Object.keys(row.Result as object).sort().join(",") === "mailedCount,message")).toBe(true);
  });

  it("reverts earlier goods and first mail on second-mail failure, then reverts mail, bag and wallet on final-receipt failure", async () => {
    await draw(5); const initial = await draw(5), before = await persisted(), requestId = randomUUID();
    expect(initial.nativeMoonlight.bag).toMatchObject([{ index: 0, templateId: 11019, itemCount: 9 }, { index: 1, templateId: 11021, itemCount: 2 }]);
    const value = { type: "take", choice: initial.nativeMoonlight.bagToken, items: [{ index: 0, count: 9 }, { index: 1, count: 2 }] };
    // Nine ordinary units split 2+2+2+2+1, then two pity units: first five-annex mail passes, second fails.
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT moonlight_native_mail_failure CHECK ("Annex2" IS NOT NULL) NOT VALID`);
    const failedMail = await post("moonlight-native", value, requestId); expect(failedMail.statusCode, failedMail.body).toBe(500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT moonlight_native_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT moonlight_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    const failedReceipt = await post("moonlight-native", value, requestId); expect(failedReceipt.statusCode, failedReceipt.body).toBe(500);
    expect(failedReceipt.body).not.toMatch(/moonlight_native_receipt_failure|INSERT|UPDATE|Annex/); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT moonlight_native_receipt_failure`);
    const taken = await native(value, requestId); expect(taken).toMatchObject({ points: 800, revision: 3, mailedCount: 2, nativeMoonlight: { bag: [], bagSlotsUsed: 0 } });
    const delivered = await persisted(); expect(delivered.goods.map(item => item.Count)).toEqual([2, 2, 2, 2, 1, 2]); expect(delivered.mails).toHaveLength(2);
    const annexes = delivered.mails.flatMap(mail => [mail.Annex1, mail.Annex2, mail.Annex3, mail.Annex4, mail.Annex5].filter(Boolean).map(Number));
    expect(annexes).toEqual(delivered.goods.map(item => item.ItemID));
    expect((await native(value, requestId)).replayed).toBe(true); expect(await persisted()).toEqual(delivered);
  });

  it("rolls back recycled points, fragment exchange and progress mail as one transaction and shares legacy depletion checks", async () => {
    await draw(5); const initial = await draw(5), requestId = randomUUID();
    const recycle = { type: "recycle", choice: initial.nativeMoonlight.bagToken, items: [{ index: 0, count: 2 }] }, before = await persisted();
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT moonlight_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    expect((await post("moonlight-native", recycle, requestId)).statusCode).toBe(500); expect(await persisted()).toEqual(before);
    for (const value of [{ type: "exchange", choice: initial.nativeMoonlight.bagToken }, { type: "progress", tier: 1, choice: initial.nativeMoonlight.bagToken }]) {
      expect((await post("moonlight-native", value)).statusCode).toBe(500); expect(await persisted()).toEqual(before);
    }
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT moonlight_native_receipt_failure`);
    const fresh = await native(recycle, requestId); expect(fresh).toMatchObject({ points: 804, earned: 40, nativeMoonlight: { bag: [{ index: 0, itemCount: 7 }, { index: 1, itemCount: 2 }] },
      nativeMoonlightAction: { effects: [{ type: "recycled", pointsAwarded: 4, score: 804 }] } });
    const exchange = await native({ type: "exchange", choice: fresh.nativeMoonlight.bagToken });
    expect(exchange).toMatchObject({ mailedCount: 1, nativeMoonlight: { fragments: 0 }, nativeMoonlightAction: { effects: [{ type: "exchanged", fragmentsSpent: 10, templateId: 11021, itemCount: 2 }] } });
    await action("moon", { type: "exchange" }, randomUUID(), 400);
    const claim = await native({ type: "progress", tier: 1, choice: exchange.nativeMoonlight.bagToken });
    expect(claim.mailedCount).toBe(1); expect(claim.nativeMoonlight.progress[0]).toMatchObject({ tier: 1, claimed: true, canClaim: false });
    await action("moon", { type: "progress", tier: 1 }, randomUUID(), 400);
    expect((await persisted()).goods.map(item => [item.TemplateID, item.Count])).toEqual([[11021, 2], [11019, 2]]);
  });

  it("atomically batches fragment exchange, rolls back mail and receipt failures and replays one UUID once", async () => {
    await draw(1); const state = (await saved())!;
    // Prepare earned fragments only in this isolated in-memory save; production counters and rules are untouched.
    (state.games.moon as { fragments: number }).fragments = 100;
    await h.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    const first = await snapshot(), before = await persisted(), requestId = randomUUID();
    expect(first.nativeMoonlight.exchange).toMatchObject({ maxCount: 10, affordableCount: 10, canExchange: true });
    const value = { type: "exchange", count: 10, choice: first.nativeMoonlight.bagToken };
    for (const count of [0, 11, 1.5, "2", null]) await native({ ...value, count } as ActivityAction, randomUUID(), 400);
    expect(await persisted()).toEqual(before);
    // Ten max-stack-two attachments require two ordinary mails; a mail failure must also roll back fragment debit and goods.
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT moonlight_native_mail_failure CHECK ("Annex1" IS NULL) NOT VALID`);
    await native(value, requestId, 500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT moonlight_native_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT moonlight_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    await native(value, requestId, 500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT moonlight_native_receipt_failure`);
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => post("moonlight-native", value, requestId)));
    expect(outcomes.every(response => response.statusCode === 200)).toBe(true);
    expect(outcomes.filter(response => response.json().nativeMoonlightAction)).toHaveLength(1);
    expect(outcomes.filter(response => response.json().replayed)).toHaveLength(3);
    const committed = outcomes.find(response => response.json().nativeMoonlightAction)!.json<ActivityResult>();
    expect(committed).toMatchObject({ points: 980, revision: 2, mailedCount: 2, nativeMoonlight: { fragments: 0, exchange: { affordableCount: 0, canExchange: false } },
      nativeMoonlightAction: { requestId, effects: [{ type: "exchanged", count: 10, fragmentsSpent: 100, fragments: 0, templateId: 11021, itemCount: 20 }] } });
    const after = await persisted(); expect(after.goods.map(item => [item.TemplateID, item.Count])).toEqual(Array.from({ length: 10 }, () => [11021, 2]));
    expect(after.mails).toHaveLength(2); expect(after.receipts).toHaveLength(2);
    await native({ ...value, count: 1 }, requestId, 409);
    await native({ type: "exchange", count: 1, choice: committed.nativeMoonlight.bagToken }, randomUUID(), 400);
    expect((await native(value, requestId)).replayed).toBe(true); expect(await persisted()).toEqual(after);
  });

  it("serializes competing quantities against the same fragment token without a partial second award", async () => {
    await draw(5); const initial = await draw(5), before = await persisted(), choice = initial.nativeMoonlight.bagToken;
    const responses = await Promise.all([post("moonlight-native", { type: "exchange", count: 1, choice }), post("moonlight-native", { type: "exchange", count: 1, choice })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 400]);
    const after = await persisted(); expect(after.goods.map(item => [item.TemplateID, item.Count])).toEqual([[11021, 2]]);
    expect(after.mails).toHaveLength(1); expect(after.receipts).toHaveLength(before.receipts.length + 1);
    expect((await snapshot()).nativeMoonlight.fragments).toBe(0);
  });

  it("restores partial bags across app restart and midnight, rejects old tokens and permits earned settlements at the play ceiling", async () => {
    const initial = await draw(3); await native({ type: "take", choice: initial.nativeMoonlight.bagToken, items: [{ index: 0, count: 1 }] });
    const old = await snapshot(), before = await persisted(); await built.app.close(); await rebuild(); expect(await snapshot()).toEqual(old); expect(await persisted()).toEqual(before);
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z")); const next = await snapshot();
    expect(next.nativeMoonlight.bag).toEqual(old.nativeMoonlight.bag); expect(next.nativeMoonlight.bagToken).not.toBe(old.nativeMoonlight.bagToken); expect(await persisted()).toEqual(before);
    await native({ type: "take", choice: old.nativeMoonlight.bagToken, items: [{ index: 0, count: 1 }] }, randomUUID(), 400); expect(await persisted()).toEqual(before);
    const state = (await saved())!; state.day = "2026-10-16"; state.daily.actions = 500;
    await h.db.execute(sql`UPDATE app."ActivityStates" SET "State"=${JSON.stringify(state)}::jsonb WHERE "UserID"=${uid}`);
    const capped = await snapshot(); expect(capped.nativeMoonlight.drawChoices.every(c => !c.canDraw)).toBe(true); expect(capped.nativeMoonlight.canTake).toBe(true);
    await native({ type: "draw", count: 1, choice: capped.nativeMoonlight.bagToken }, randomUUID(), 400);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=2147483647 WHERE "UserID"=${uid}`);
    const overflow = await persisted(); await native({ type: "take", choice: capped.nativeMoonlight.bagToken, items: [{ index: 0, count: 1 }] }, randomUUID(), 409); expect(await persisted()).toEqual(overflow);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=2,"Points"=2147483646 WHERE "UserID"=${uid}`);
    const noHeadroom = await snapshot(), full = await persisted(); expect(noHeadroom.nativeMoonlight.canRecycle).toBe(false);
    await native({ type: "recycle", choice: noHeadroom.nativeMoonlight.bagToken, items: [{ index: 0, count: 1 }] }, randomUUID(), 400); expect(await persisted()).toEqual(full);
    const settled = await native({ type: "take", choice: noHeadroom.nativeMoonlight.bagToken, items: [{ index: 0, count: 2 }] });
    expect(settled).toMatchObject({ points: 2147483646, nativeMoonlight: { bag: [] }, mailedCount: 1 }); expect((await saved())!.daily.actions).toBe(500);
  });
});
