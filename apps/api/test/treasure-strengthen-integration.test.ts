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
import { TREASURE_DRILL_POOL_VERSION, TREASURE_ENTRIES, TREASURE_IDS, TREASURE_POOL_VERSION, TREASURE_PREVIOUS_POOL_VERSION } from "../src/activities/treasure-catalog.js";
import type { TreasureState } from "../src/activities/treasure-native.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";
import { assertPublicActivityStates } from "./public-activity-state.js";

// Real HTTP/auth, seed templates, resource index, PGlite transactions and mail.
// No catalog mock or future-ready fixture: the incomplete 157-template pool always stays blocked.
const observed = vi.hoisted(() => ({ randomCalls: 0, locks: [] as number[][] }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: () => { observed.randomCalls++; return 0; } }));
vi.mock("../src/lib/db.js", async original => {
  const actual = await original<typeof import("../src/lib/db.js")>(), { PgDialect } = await import("drizzle-orm/pg-core");
  return { ...actual, q: async (...args: Parameters<typeof actual.q>) => {
    const rows = await actual.q(...args), query = new PgDialect().sqlToQuery(args[1]);
    if (query.sql.includes('FROM game."Shop_Goods"') && query.sql.trim().endsWith("FOR SHARE")) observed.locks.push(query.params.map(Number));
    return rows;
  } };
});
const ids = [11019, 11021, 11022, 11023, 11024];
const entries = ids.map(id => TREASURE_ENTRIES.find(row => row.templateId === id && row.sourceOriginalIndex === 9)!);
const tmp = mkdtempSync(join(tmpdir(), "ddt-treasure-strengthen-")), uid = 711, secret = "treasure-strengthen-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>, materials: typeof game.Shop_Goods.$inferSelect[];
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "treasure-strengthen-test", role: "player" }, secret, 3600)}` });
const post = (action: ActivityAction, requestId: string = randomUUID()) => built.app.inject({ method: "POST",
  url: "/api/account/activities/treasure-native/action", headers: headers(), payload: { characterId: uid, requestId, action } });
function publicResult(value: ActivityResult): ActivityResult {
  assertPublicActivityStates(value);
  expect(JSON.stringify(value)).not.toMatch(/"(?:games|seed|choices|nativeTreasureEffects)":/);
  return value;
}
async function native(value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(value, requestId); expect(response.statusCode, response.body).toBe(status);
  return publicResult(response.json<ActivityResult>());
}
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200);
  const result = publicResult(response.json<ActivityResult>()); expect(result).not.toHaveProperty("nativeTreasureAction"); return result;
}
const readTemplates = () => h.db.select().from(game.Shop_Goods).orderBy(game.Shop_Goods.TemplateID);
async function persisted() { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
async function store(state: ActivityState) {
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(state)}::jsonb)
    ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
}
function oldBag(mixed = false) {
  const rows = mixed ? [...entries, entries[0]] : entries;
  const treasure: Omit<TreasureState, "tickets"> = { version: 2, bag: rows.map((row, index) => ({ templateId: row.templateId,
    count: row.count, validDays: 0, origin: "original-catalog", entryKey: row.entryKey, sourceOriginalIndex: row.sourceOriginalIndex,
    poolVersion: mixed && index === 0 ? TREASURE_PREVIOUS_POOL_VERSION : TREASURE_DRILL_POOL_VERSION })),
    draws: 10, score: 20, fragments: 10, pity: 8, choices: [PRIZES[0].name], claimed: [] };
  const state: ActivityState = { version: 1, day: "2026-10-16", daily: {}, completed: { treasure: 10 }, claims: [], history: [], games: { treasure } };
  return { state, treasure };
}
beforeAll(async () => {
  type SeedTemplate = Omit<typeof game.Shop_Goods.$inferSelect, "AddTime"> & { AddTime: string | null };
  const seed = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString("utf8")) as SeedTemplate[];
  materials = ids.map(id => {
    const item = seed.find(row => row.TemplateID === id)!;
    return { ...item, AddTime: item.AddTime === null ? null : new Date(item.AddTime + "Z") };
  });
  expect(materials.map(item => [item.TemplateID, item.CategoryID, item.Pic, item.NeedSex, item.Property1, item.Property2, item.Level, item.Quality, item.CanUse, item.MaxCount]))
    .toEqual(ids.map((id, index) => [id, 11, entries[index].pic, 0, 2, [1, 4, 15, 55, 215][index], index + 1, index + 1, false, 9999]));
  expect(entries.map(row => [row.count, row.sourceOriginalIndex])).toEqual(ids.map(() => [1, 9]));
  for (const row of entries) {
    const dir = join(config.RESOURCE_DIR, "image", "unfrightprop", row.pic); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "icon.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  }
  h = await createDb("pglite:memory"); await migrateDb(h);
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config });
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  observed.randomCalls = 0; observed.locks = [];
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.delete(game.Shop_Goods); await h.db.insert(game.Shop_Goods).values(materials);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'treasure-strengthen-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'treasure-strengthen-test','Treasure strengthen test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("genuine strengthen materials and issued treasure entitlements", () => {
  it("delivers genuine CanUse=false stones from mixed issued v1/v2 bags in two mails, preserving templates and UUID replay", async () => {
    expect(TREASURE_DRILL_POOL_VERSION).toBe("0865704466025c6222181f7bd8eff5234cdd9b30df796e1ed7df1a784b2c4e22");
    expect([TREASURE_PREVIOUS_POOL_VERSION, TREASURE_DRILL_POOL_VERSION]).not.toContain(TREASURE_POOL_VERSION);
    const { state, treasure } = oldBag(true); await store(state);
    expect(await readTemplates()).toEqual(materials);
    const before = await persisted(), view = await snapshot();
    const token = "2026-10-16:" + createHash("sha256").update(JSON.stringify(treasure)).digest("base64url");
    expect(view.nativeTreasure).toMatchObject({ poolVersion: TREASURE_POOL_VERSION, bagToken: token, canTake: true, bagSlotsUsed: 6,
      readiness: { status: "blocked", totalRows: 158, readyRows: 5 } });
    expect(view.nativeTreasure.bag.map(item => [item.templateId, item.itemCount, item.poolVersion])).toEqual(treasure.bag.map(item => [item.templateId, item.count, item.poolVersion]));
    expect(await persisted()).toEqual(before);
    const take = { type: "take", choice: token }, id = randomUUID(), taken = await native(take, id);
    expect(taken).toMatchObject({ points: 1000, earned: 40, revision: 1, mailedCount: 2, nativeCharge: { grossSpent: 0 },
      nativeTreasure: { bag: [], draws: 10, progressScore: 20, fragments: 10, readiness: { status: "blocked" } } });
    const final = await persisted();
    // Every original row awards one stone, below its genuine MaxCount=9999; six rows cross the five-attachment mail boundary.
    expect(final.goods.map(item => [item.TemplateID, item.Count, item.IsBinds, item.ValidDate])).toEqual([...ids, ids[0]].map(id => [id, 1, true, 0]));
    expect(final.mails).toHaveLength(2);
    const annexes = final.mails.map(mail => [mail.Annex1, mail.Annex2, mail.Annex3, mail.Annex4, mail.Annex5].filter(Boolean).map(Number));
    expect(annexes.map(items => items.length)).toEqual([5, 1]); expect(annexes.flat()).toEqual(final.goods.map(item => item.ItemID));
    expect(new Set(annexes.flat()).size).toBe(6); expect(final.receipts).toHaveLength(1); expect(await readTemplates()).toEqual(materials);
    for (const replay of await Promise.all(Array.from({ length: 8 }, () => native(take, id.toUpperCase())))) {
      expect(replay).toMatchObject({ replayed: true, revision: 1, mailedCount: 2, nativeTreasure: { bag: [] } });
      expect(replay).not.toHaveProperty("nativeTreasureAction");
    }
    await native({ ...take, index: 0 }, id, 409);
    expect(await persisted()).toEqual(final); expect(await readTemplates()).toEqual(materials);
    expect(observed.randomCalls).toBe(0); expect(observed.locks).toEqual([ids]);
  });

  it("rejects wrong Property1 or Level for each exact old-v2 stone without losing rights or writing five tables", async () => {
    const { state } = oldBag(); await store(state); const initial = await snapshot(), originals = await readTemplates();
    let retry: { action: ActivityAction; id: string } | undefined;
    for (const [index, template] of materials.entries()) {
      for (const patch of [{ Property1: 35 }, { Level: template.Level + 1 }]) {
        await h.db.update(game.Shop_Goods).set({ Property1: template.Property1, Level: template.Level, ...patch })
          .where(sql`${game.Shop_Goods.TemplateID}=${template.TemplateID}`);
        const changedTemplates = await readTemplates(), before = await persisted(), value = { type: "take", index, choice: initial.nativeTreasure.bagToken }, id = randomUUID();
        const refused = await native(value, id, 503); expect(refused.message).toBe("寻宝原目录奖励暂不可交付，请保留临时包。");
        expect(await persisted()).toEqual(before); expect(await readTemplates()).toEqual(changedTemplates); expect(observed.randomCalls).toBe(0);
        await h.db.update(game.Shop_Goods).set({ Property1: template.Property1, Level: template.Level })
          .where(sql`${game.Shop_Goods.TemplateID}=${template.TemplateID}`);
        retry = { action: value, id };
      }
    }
    const unchanged = await snapshot(); expect(unchanged.nativeTreasure.bag).toEqual(initial.nativeTreasure.bag);
    expect(unchanged.nativeTreasure.bagToken).toBe(initial.nativeTreasure.bagToken); expect(await readTemplates()).toEqual(originals);
    expect(observed.locks).toEqual(ids.flatMap(id => [[id], [id]]));
    const retried = await native(retry!.action, retry!.id);
    expect(retried).toMatchObject({ revision: 1, points: 1000, mailedCount: 1, nativeTreasure: { bagSlotsUsed: 4, readiness: { status: "blocked" } } });
    expect((await persisted()).goods.map(item => [item.TemplateID, item.Count])).toEqual([[11024, 1]]);
    expect(await readTemplates()).toEqual(originals); expect(observed.randomCalls).toBe(0);
  });

  it("keeps v1/v2 new actions and current incomplete-pool actions closed, and rejects unknown saved versions without charging or RNG", async () => {
    const { state } = oldBag(); await store(state); const view = await snapshot(), before = await persisted();
    expect(view.nativeTreasure.readiness).toMatchObject({ status: "blocked", totalRows: 158, readyRows: 5 });
    for (const poolVersion of [TREASURE_PREVIOUS_POOL_VERSION, TREASURE_DRILL_POOL_VERSION, "f".repeat(64), TREASURE_POOL_VERSION]) {
      for (const mode of ["normal", "advanced"] as const) {
        const draw: ActivityAction = { type: "draw", mode, count: 1, poolVersion, choice: view.nativeTreasure.bagToken,
          selection: mode === "normal" ? [] : [4, 1, 12, 7] };
        for (const value of [draw, { ...draw, funding: "tickets" as const }, { type: "buy-tickets", mode, count: 1, poolVersion, choice: view.nativeTreasure.bagToken }]) {
          const refused = await native(value, randomUUID(), 400);
          if (poolVersion !== TREASURE_POOL_VERSION) expect(refused.message).toBe("原奖池版本已更新，请刷新原窗口。");
          else expect(refused.message).toMatch(/完整奖池尚有\d+条未就绪/);
          expect(await persisted()).toEqual(before); expect(observed.randomCalls).toBe(0);
        }
      }
    }
    expect(observed.locks).toEqual(Array.from({ length: 24 }, () => TREASURE_IDS));
    const treasure = state.games.treasure as Omit<TreasureState, "tickets">;
    treasure.bag[0].poolVersion = "f".repeat(64); await store(state); const unknownBefore = await persisted();
    const invalid = await post({ type: "take", choice: view.nativeTreasure.bagToken });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(invalid.json()).toMatchObject({ message: "寻宝原目录奖品版本或身份无效，请保留存档。" });
    expect(await persisted()).toEqual(unknownBefore); expect(await readTemplates()).toEqual(materials); expect(observed.randomCalls).toBe(0);
  });
});
