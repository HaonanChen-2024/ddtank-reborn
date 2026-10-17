import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { TREASURE_ENTRIES, TREASURE_IDS, TREASURE_JEWELRY_POOL_VERSION, TREASURE_POOL_VERSION } from "../src/activities/treasure-catalog.js";
import type { TreasureState } from "../src/activities/treasure-native.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";
import { assertPublicActivityStates } from "./public-activity-state.js";

// Real HTTP/auth, original gzip row, resource index, PGlite transactions and mail.
// A temporary indexed pixel exercises the icon gate only, never native-client visual acceptance.
const observed = vi.hoisted(() => ({ randomCalls: 0, queries: [] as { sql: string; params: unknown[] }[] }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: () => { observed.randomCalls++; return 0; } }));
vi.mock("../src/lib/db.js", async original => {
  const actual = await original<typeof import("../src/lib/db.js")>(), { PgDialect } = await import("drizzle-orm/pg-core");
  return { ...actual, q: async (...args: Parameters<typeof actual.q>) => {
    const rows = await actual.q(...args); observed.queries.push(new PgDialect().sqlToQuery(args[1])); return rows;
  } };
});
const entry = TREASURE_ENTRIES.find(row => row.sourceRow === 60)!;
const versions = [TREASURE_JEWELRY_POOL_VERSION, TREASURE_POOL_VERSION];
const tmp = mkdtempSync(join(tmpdir(), "ddt-treasure-petfood-")), uid = 736, secret = "treasure-petfood-tests-only";
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>, material: typeof game.Shop_Goods.$inferSelect;
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "treasure-petfood-test", role: "player" }, secret, 3600)}` });
const post = (action: ActivityAction, requestId = randomUUID()) => built.app.inject({ method: "POST",
  url: "/api/account/activities/treasure-native/action", headers: headers(), payload: { characterId: uid, requestId, action } });
function publicResult(value: ActivityResult) {
  assertPublicActivityStates(value); expect(JSON.stringify(value)).not.toMatch(/"(?:games|seed|choices|cardConfig|boxRewards)":/); return value;
}
async function native(action: ActivityAction, requestId = randomUUID(), status = 200) {
  const response = await post(action, requestId); expect(response.statusCode, response.body).toBe(status); return publicResult(response.json<ActivityResult>());
}
async function snapshot() {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); return publicResult(response.json<ActivityResult>());
}
async function persisted() { return {
  wallet: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
async function store(poolVersion = TREASURE_JEWELRY_POOL_VERSION) {
  const treasure: Omit<TreasureState, "tickets"> = { version: 2,
    bag: [{ templateId: entry.templateId, count: entry.count, validDays: 0, origin: "original-catalog", entryKey: entry.entryKey,
      sourceOriginalIndex: entry.sourceOriginalIndex, poolVersion }],
    draws: 10, score: 20, fragments: 10, pity: 8, choices: [PRIZES[0].name], claimed: [] };
  const state: ActivityState = { version: 1, day: "2026-10-16", daily: {}, completed: { treasure: 10 }, claims: [], history: [], games: { treasure } };
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(state)}::jsonb)`);
  return treasure;
}
function assertLocks(ids: readonly number[] = [334103], delivered = false) {
  const locks = observed.queries.filter(row => row.sql.includes('FROM game."Shop_Goods"') && row.sql.trim().endsWith("FOR SHARE"));
  expect(locks.map(row => row.params.map(Number))).toEqual([ids]);
  const insert = observed.queries.findIndex(row => row.sql.includes('INSERT INTO player."Sys_Users_Goods"'));
  if (delivered) expect(insert).toBeGreaterThan(observed.queries.indexOf(locks[0]!)); else expect(insert).toBe(-1);
}
function assertAttachments(rows: Record<string, unknown>[]) {
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ TemplateID: 334103, Count: 5, StrengthenLevel: 0, IsBinds: true, ValidDate: 0,
    AttackCompose: 0, DefendCompose: 0, AgilityCompose: 0, LuckCompose: 0, IsUsed: false });
}
beforeAll(async () => {
  const bytes = readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("8850565ed5e743f01cba4bd3679e2cb65b3448e05ade0db7c4437406c275cc53");
  type Seed = Omit<typeof game.Shop_Goods.$inferSelect, "AddTime"> & { AddTime: string | null };
  const original = (JSON.parse(gunzipSync(bytes).toString("utf8")) as Seed[]).find(row => row.TemplateID === 334103)!;
  material = { ...original, AddTime: original.AddTime === null ? null : new Date(`${original.AddTime}Z`) };
  expect(material).toMatchObject({ TemplateID: 334103, CategoryID: 34, Pic: "Enrichmentrations", NeedSex: 0, NeedLevel: 0,
    MaxCount: 9999, CanEquip: false, CanUse: true, CanStrengthen: false, CanCompose: false, Level: 2, Quality: 3, SuitId: 0,
    Property1: 1500, Property2: 20000, Property3: 20000 });
  expect(entry).toMatchObject({ sourceRow: 60, sourceOriginalIndex: 5, sourceTemplateId: 334103, templateId: 334103, count: 5, categoryId: 34, pic: "Enrichmentrations" });
  expect(TREASURE_JEWELRY_POOL_VERSION).toBe("fa8df945f65d175282a29fa13cdd97c29d870efd47ffebbd35579752a2f4de74");
  expect(TREASURE_POOL_VERSION).not.toBe(TREASURE_JEWELRY_POOL_VERSION);
  const dir = join(config.RESOURCE_DIR, "image", "unfrightprop", entry.pic); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "icon.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  h = await createDb("pglite:memory"); await migrateDb(h); built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config });
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-16T12:00:00Z")); observed.randomCalls = 0; observed.queries = [];
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS treasure_petfood_mail_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages",game."Shop_Goods"`);
  await h.db.insert(game.Shop_Goods).values(material);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'treasure-petfood-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'treasure-petfood-test','Treasure petfood test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(() => { vi.useRealTimers(); expect(observed.randomCalls).toBe(0); });
afterAll(async () => {
  await built?.app.close(); await h?.close(); const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory"); rmSync(target, { recursive: true, force: true });
});

describe("genuine petfood treasure entitlement delivery", () => {
  it.each(versions)("takes the exact row60 five-food entitlement from policy %s once without spending", async poolVersion => {
    const treasure = await store(poolVersion), before = await persisted(), view = await snapshot();
    const token = "2026-10-16:" + createHash("sha256").update(JSON.stringify(treasure)).digest("base64url");
    expect(view.nativeTreasure).toMatchObject({ poolVersion: TREASURE_POOL_VERSION, bagToken: token, canTake: true, bagSlotsUsed: 1,
      readiness: { status: "blocked", totalRows: 158, readyRows: 1 } });
    expect(view.nativeTreasure.preview).toHaveLength(158); expect(view.nativeTreasure.preview.find(row => row.sourceRow === 60)).toMatchObject({ templateId: 334103, count: 5, status: "ready" });
    expect(await persisted()).toEqual(before); observed.queries = [];
    const action: ActivityAction = { type: "take", choice: token }, id = randomUUID();
    expect(await native(action, id)).toMatchObject({ points: 1000, earned: 40, revision: 1, mailedCount: 1,
      nativeCharge: { grossSpent: 0 }, nativeTreasure: { bag: [], draws: 10, progressScore: 20, fragments: 10 } });
    assertLocks([334103], true); const final = await persisted(); assertAttachments(final.goods); expect(final.mails).toHaveLength(1); expect(final.receipts).toHaveLength(1);
    await h.db.delete(game.Shop_Goods); expect((await native(action, id)).replayed).toBe(true); expect(await persisted()).toEqual(final);
    await native({ ...action, index: 0 }, id, 409); expect(await persisted()).toEqual(final);
  });

  it.each(["Property1", "Property2"] as const)("keeps rights on %s drift after preview and repairs the same rejected UUID", async field => {
    await store(); const view = await snapshot(), before = await persisted(), action: ActivityAction = { type: "take", choice: view.nativeTreasure.bagToken }, id = randomUUID();
    await h.db.update(game.Shop_Goods).set({ [field]: material[field] + 1 }); observed.queries = [];
    expect((await native(action, id, 503)).message).toBe("寻宝原目录奖励暂不可交付，请保留临时包。"); assertLocks(); expect(await persisted()).toEqual(before);
    await h.db.update(game.Shop_Goods).set(material); expect((await snapshot()).nativeTreasure.bagToken).toBe(view.nativeTreasure.bagToken); observed.queries = [];
    expect(await native(action, id)).toMatchObject({ points: 1000, revision: 1, mailedCount: 1, nativeTreasure: { bagSlotsUsed: 0 } }); assertLocks([334103], true);
    const final = await persisted(); assertAttachments(final.goods); expect((await native(action, id)).replayed).toBe(true); expect(await persisted()).toEqual(final);
  });

  it("retains the bag and UUID when its genuine template disappears, then delivers after restoration", async () => {
    await store(); const view = await snapshot(), before = await persisted(), action: ActivityAction = { type: "take", choice: view.nativeTreasure.bagToken }, id = randomUUID();
    await h.db.delete(game.Shop_Goods); observed.queries = []; await native(action, id, 503); assertLocks(); expect(await persisted()).toEqual(before);
    await h.db.insert(game.Shop_Goods).values(material); expect((await snapshot()).nativeTreasure.bagToken).toBe(view.nativeTreasure.bagToken); observed.queries = [];
    expect(await native(action, id)).toMatchObject({ points: 1000, revision: 1, mailedCount: 1, nativeTreasure: { bagSlotsUsed: 0 } }); assertLocks([334103], true);
    const final = await persisted(); assertAttachments(final.goods); expect((await native(action, id)).replayed).toBe(true); expect(await persisted()).toEqual(final);
  });

  it("rolls back the actual attachment and receipt on mail SQL failure, then accepts the same UUID once", async () => {
    await store(); const view = await snapshot(), before = await persisted(), action: ActivityAction = { type: "take", choice: view.nativeTreasure.bagToken }, id = randomUUID();
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT treasure_petfood_mail_failure CHECK ("ReceiverID"<>736)`);
    observed.queries = []; const failed = await post(action, id); expect(failed.statusCode, failed.body).toBe(500); assertLocks([334103], true); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT treasure_petfood_mail_failure`);
    expect(await native(action, id)).toMatchObject({ points: 1000, revision: 1, mailedCount: 1, nativeTreasure: { bagSlotsUsed: 0 } });
    const final = await persisted(); assertAttachments(final.goods); expect(final.mails).toHaveLength(1); expect(final.receipts).toHaveLength(1);
    expect((await native(action, id)).replayed).toBe(true); expect(await persisted()).toEqual(final);
  });

  it("rejects new v9 draws and all spending against the current incomplete full158 pool without random selection", async () => {
    await store(); const view = await snapshot(), before = await persisted(), choice = view.nativeTreasure.bagToken;
    expect(view.nativeTreasure).toMatchObject({ poolVersion: TREASURE_POOL_VERSION, canDraw: false, readiness: { status: "blocked", totalRows: 158, readyRows: 1 } });
    expect(view.nativeTreasure.preview).toHaveLength(158); expect(view.nativeTreasure.drawChoices.every(row => !row.canDraw)).toBe(true);
    expect(view.nativeTreasure.ticketDrawChoices.every(row => !row.canDraw)).toBe(true); expect(view.nativeTreasure.ticketShop.offers.every(row => !row.canBuy)).toBe(true);
    const oldDraw: ActivityAction = { type: "draw", mode: "normal", count: 1, poolVersion: TREASURE_JEWELRY_POOL_VERSION, choice, selection: [] };
    observed.queries = []; expect((await native(oldDraw, randomUUID(), 400)).message).toMatch(/原奖池版本已更新/); assertLocks(TREASURE_IDS); expect(await persisted()).toEqual(before);
    for (const mode of ["normal", "advanced"] as const) {
      const draw: ActivityAction = { type: "draw", mode, count: 1, poolVersion: TREASURE_POOL_VERSION, choice, selection: mode === "normal" ? [] : [4, 1, 12, 7] };
      for (const action of [draw, { ...draw, funding: "tickets" as const }, { type: "buy-tickets", mode, count: 1, poolVersion: TREASURE_POOL_VERSION, choice }]) {
        observed.queries = []; expect((await native(action, randomUUID(), 400)).message).toMatch(/完整奖池尚有157条未就绪/); assertLocks(TREASURE_IDS); expect(await persisted()).toEqual(before);
      }
    }
  });
});
