import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { createActivityState } from "../src/activities/engine.js";
import { TREASURE_ENTRIES, TREASURE_IDS, TREASURE_POOL_VERSION, type TreasureEntry } from "../src/activities/treasure-catalog.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction } from "../src/activities/types.js";
import { q } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// Real HTTP/auth, isolated PGlite, resource files, SQL rollback and immutable receipts.
// approvedOwners simulates future owner verification ONLY for transaction-path tests; real policy stays blocked.
const control = vi.hoisted(() => ({ approvedOwners: false, rngCalls: 0, fraction: 0,
  locks: [] as number[][], afterLock: undefined as (() => void) | undefined }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (max: number) => { control.rngCalls++; return Math.floor(control.fraction * max); } }));
vi.mock("../src/lib/db.js", async original => {
  const actual = await original<typeof import("../src/lib/db.js")>(), { PgDialect } = await import("drizzle-orm/pg-core");
  return { ...actual, q: async (...args: Parameters<typeof actual.q>) => {
    const rows = await actual.q(...args), query = new PgDialect().sqlToQuery(args[1]);
    if (query.sql.includes('FROM game."Shop_Goods"') && query.sql.trim().endsWith("FOR SHARE")) {
      control.locks.push(query.params.map(Number)); control.afterLock?.();
    }
    return rows;
  } };
});
vi.mock("../src/activities/treasure-catalog.js", async original => {
  const actual = await original<typeof import("../src/activities/treasure-catalog.js")>();
  return { ...actual, inspectTreasureCatalog: (...args: Parameters<typeof actual.inspectTreasureCatalog>) => {
    const catalog = actual.inspectTreasureCatalog(...args);
    if (control.approvedOwners) {
      for (const row of catalog.preview) {
        row.reasons = row.reasons.filter(reason => !["官方武器属性与完整特效尚未通过交付核验", "装备属性或技能尚未核验", "实际用途尚未核验"].includes(reason));
        row.status = row.reasons.length ? "blocked" : "ready";
      }
      const blocked = catalog.preview.filter(row => row.status === "blocked").map(row => ({ entryKey: row.entryKey, reasons: [...row.reasons] }));
      catalog.readiness = { status: blocked.length ? "blocked" : "ready", totalRows: 158, readyRows: 158 - blocked.length,
        blocked, description: blocked.length ? "Isolated fixture has blocked rows" : "Isolated fixture owners approved" };
    }
    return catalog;
  } };
});

const tmp = mkdtempSync(join(tmpdir(), "ddt-treasure-v2-service-")), uid = 671, secret = "treasure-v2-service-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, JWT_SECRET: secret,
  RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "", FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "",
  RESOURCE_DIR: join(tmp, "resource"), UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"),
  RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "treasure-v2-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId = randomUUID()) => built.app.inject({ method: "POST",
  url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId: uid, requestId, action } });
async function snapshot() {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); return response.json<ActivityResult>();
}
async function command(id: string, action: ActivityAction, status = 200, requestId = randomUUID()) {
  const response = await post(id, action, requestId); expect(response.statusCode, response.body).toBe(status); return response.json<ActivityResult>();
}
const draw = async (mode: "normal" | "advanced" = "normal"): Promise<ActivityAction> => ({ type: "draw", mode, count: 1,
  choice: (await snapshot()).nativeTreasure.bagToken, selection: mode === "advanced" ? [4, 1, 9, 2] : [], poolVersion: TREASURE_POOL_VERSION });
const legacy = () => ({ bag: [{ templateId: 11019, count: 2 }], draws: 9, score: 30, fragments: 10, pity: 9,
  choices: PRIZES.map(row => row.name), claimed: [] });
const originalReward = (entry: TreasureEntry) => ({ templateId: entry.templateId, count: entry.count, validDays: 0,
  origin: "original-catalog", entryKey: entry.entryKey, sourceOriginalIndex: entry.sourceOriginalIndex, poolVersion: TREASURE_POOL_VERSION });
async function saveTreasure(value: unknown) {
  const root = createActivityState(new Date()); root.games.treasure = value;
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(root)}::jsonb)
    ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
}
async function persisted() { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
// Paths are from the original PathManager icon branches, not /resource's placeholder response.
function iconPath(entry: TreasureEntry) {
  const roots: Record<number, string> = { 7: `arm/${entry.pic}/1`, 8: `equip/armlet/${entry.pic}`, 9: `equip/ring/${entry.pic}`,
    11: `unfrightprop/${entry.pic}`, 13: `equip/f/suits/${entry.pic}`, 14: `equip/necklace/${entry.pic}`,
    17: `equip/offhand/${entry.pic}`, 18: `cardbox/${entry.pic}`, 20: `unfrightprop/${entry.pic}`,
    34: `unfrightprop/${entry.pic}`, 35: `unfrightprop/${entry.pic}`, 50: `petequip/arm/${entry.pic}`,
    51: `petequip/hat/${entry.pic}`, 52: `petequip/cloth/${entry.pic}` };
  return join(config.RESOURCE_DIR, "image", roots[entry.categoryId], entry.categoryId === 13 ? "icon_1.png" : "icon.png");
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  for (const entry of TREASURE_ENTRIES) { const path = iconPath(entry); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, png); }
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config });
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  control.approvedOwners = false; control.rngCalls = 0; control.fraction = 0; control.locks = []; control.afterLock = undefined;
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS treasure_v2_mail_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS treasure_v2_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages",game."Shop_Goods"`);
  const template: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "Fixture material", CanRecycle: 0, CategoryID: 11,
    Attack: 1, Defence: 1, Agility: 1, Luck: 1, Level: 1, Quality: 1, MaxCount: 2, NeedSex: 0, NeedLevel: 1,
    CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  const entries = new Map(TREASURE_ENTRIES.map(entry => [entry.templateId, entry]));
  await h.db.insert(game.Shop_Goods).values([...entries.values()].map(entry => ({ ...template, TemplateID: entry.templateId,
    Name: "Fixture local name", CategoryID: entry.categoryId, Pic: entry.pic, NeedSex: entry.needSex,
    Property1: [11560, 11561, 11562].includes(entry.templateId) ? 10 : [11901, 11902, 11903, 11904, 11906].includes(entry.templateId) ? 21 : 0,
    Property2: 300 })));
  for (const prize of PRIZES) if (!entries.has(prize.templateId)) await h.db.insert(game.Shop_Goods).values({ ...template, TemplateID: prize.templateId });
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'treasure-v2-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'treasure-v2-test','Treasure v2 test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
});
afterEach(() => { control.afterLock = undefined; vi.useRealTimers(); });
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("full original catalog through the transaction owner", () => {
  it("rejects a client-supplied readiness object without RNG or persistence", async () => {
    const value = await draw(), before = await persisted();
    const response = await built.app.inject({ method: "POST", url: "/api/account/activities/treasure-native/action", headers: headers(),
      payload: { characterId: uid, requestId: randomUUID(), action: { ...value, readiness: { status: "ready" } } } });
    expect(response.statusCode).toBe(400); expect(control.rngCalls).toBe(0); expect(await persisted()).toEqual(before);
  });
  it("GET uses actual templates and local resources, retains all rows and never saves normalization", async () => {
    await saveTreasure(legacy()); const before = await persisted(), view = await snapshot();
    expect(view.nativeTreasure).toMatchObject({ version: 2, bagCapacity: 100, poolVersion: TREASURE_POOL_VERSION,
      readiness: { status: "blocked", totalRows: 158, readyRows: 8 }, pityRemaining: 1,
      bag: [{ origin: "legacy-four-material", templateId: 11019, itemCount: 2 }] });
    expect(view.nativeTreasure.preview).toHaveLength(158); expect(view.nativeTreasure.categories).toHaveLength(15);
    expect(view.nativeTreasure.preview.filter(row => row.templateId === 11905)).toHaveLength(2);
    expect(view.nativeTreasure.preview.filter(row => row.status === "ready").map(row => row.templateId)).toEqual([11560,11561,11562,11901,11902,11903,11904,11906]);
    expect(await persisted()).toEqual(before); expect(control.rngCalls).toBe(0);
  });
  it("a deleted indexed file becomes blocked despite /resource returning a placeholder", async () => {
    const entry = TREASURE_ENTRIES.find(row => row.templateId === 11901)!, path = iconPath(entry); unlinkSync(path);
    try {
      const view = await snapshot(); expect(view.nativeTreasure.readiness.readyRows).toBe(7);
      expect(view.nativeTreasure.preview.find(row => row.entryKey === entry.entryKey)?.reasons).toContain("本地图标尚未就绪");
      for (const tree of built.ctx.resources.trees) tree.remove("image/unfrightprop/exp1/icon.png");
      const placeholder = await built.app.inject({ url: "/resource/image/unfrightprop/exp1/icon.png" });
      expect(placeholder.statusCode).toBe(200); expect(placeholder.headers["x-placeholder"]).toBe("1");
      expect((await snapshot()).nativeTreasure.readiness.readyRows).toBe(7);
    } finally { writeFileSync(path, png); for (const tree of built.ctx.resources.trees) tree.reindex(); }
  });
  for (const id of ["treasure", "treasure-native"]) for (const mode of ["normal", "advanced"] as const) {
    it(`${id}/${mode} locks all 157 IDs and rejects the real blocked catalog before RNG or spending`, async () => {
      const value = await draw(mode), before = await persisted(); control.locks = [];
      await command(id, value, 400); expect(control.locks).toEqual([TREASURE_IDS]);
      expect(control.rngCalls).toBe(0); expect(await persisted()).toEqual(before);
    });
  }
  it("an unselected missing target blocks advanced draw even when other owners are approved in isolation", async () => {
    control.approvedOwners = true; const value = await draw("advanced"), requestId = randomUUID();
    expect((await snapshot()).nativeTreasure.readiness.status).toBe("ready");
    const missing = TREASURE_ENTRIES.find(row => row.sourceOriginalIndex === 12)!;
    await h.db.execute(sql`DELETE FROM game."Shop_Goods" WHERE "TemplateID"=${missing.templateId}`);
    const before = await persisted(); control.locks = []; await command("treasure-native", value, 400, requestId);
    expect(control.locks).toEqual([TREASURE_IDS]); expect(control.rngCalls).toBe(0); expect(await persisted()).toEqual(before);
  });
  it("rejects incomplete, duplicate, stale and ordinary-mode selections without mutation", async () => {
    const base = await draw("advanced"), before = await persisted();
    const invalid: ActivityAction[] = [{ ...base, selection: [1, 2, 3] }, { ...base, selection: [1, 1, 2, 3] },
      { ...base, selection: [] }, { ...base, selection: undefined }, { ...base, poolVersion: "0".repeat(64) },
      { ...base, poolVersion: undefined }, { ...base, mode: "normal" }, { ...base, selection: [1, 2, 3, 15] }];
    for (const value of invalid) await command("treasure-native", value, 400);
    expect(control.rngCalls).toBe(0); expect(await persisted()).toEqual(before);
  });
  it("reserves new action fields for A01 and keeps readiness independent of the actor's sex", async () => {
    const male = (await snapshot()).nativeTreasure.readiness;
    await h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "Sex"=false WHERE "UserID"=${uid}`);
    expect((await snapshot()).nativeTreasure.readiness).toEqual(male);
    const before = await persisted();
    for (const field of [{ selection: [] }, { poolVersion: TREASURE_POOL_VERSION }])
      await command("exchange", { type: "exchange", index: 0, ...field }, 400);
    expect(await persisted()).toEqual(before);
  });
  it("keeps exact selection order in the immutable signature and original quantities in a simulated ready draw", async () => {
    control.approvedOwners = true; control.fraction = 0.99; const value = { ...await draw("advanced"), count: 3 }, requestId = randomUUID();
    const result = await command("treasure-native", value, 200, requestId);
    const candidates = TREASURE_ENTRIES.filter(row => row.sourceOriginalIndex === 15 || value.selection!.includes(row.sourceOriginalIndex));
    const winner = candidates[Math.floor(0.99 * candidates.length)];
    expect(result).toMatchObject({ points: 820, revision: 1, nativeTreasure: { draws: 3, progressScore: 6, pityRemaining: 10,
      bag: Array.from({ length: 3 }, () => ({ entryKey: winner.entryKey, templateId: winner.templateId, itemCount: winner.count, origin: "original-catalog" })) } });
    expect(control.rngCalls).toBe(3); const before = await persisted();
    await command("treasure-native", { ...value, selection: [...value.selection!].reverse() }, 409, requestId);
    expect(await persisted()).toEqual(before); expect(control.rngCalls).toBe(3);
    control.approvedOwners = false; const replay = await command("treasure-native", value, 200, requestId);
    expect(replay.replayed).toBe(true); expect(replay).not.toHaveProperty("nativeTreasureAction"); expect(control.rngCalls).toBe(3);
  });
  it("rechecks the day after the full template-lock await before spending or RNG", async () => {
    control.approvedOwners = true; vi.setSystemTime(new Date("2026-10-16T23:59:59Z")); const value = await draw(), before = await persisted();
    control.afterLock = () => vi.setSystemTime(new Date("2026-10-17T00:00:01Z"));
    await command("treasure-native", value, 400); expect(control.rngCalls).toBe(0); expect(await persisted()).toEqual(before);
  });
  for (const id of ["treasure", "treasure-native"]) {
    it(`${id} replays an old UUID without adding v2 action defaults or validating the new pool`, async () => {
      await saveTreasure(legacy()); const old: ActivityAction = id === "treasure" ? { type: "draw", count: 1 }
        : { type: "draw", count: 1, mode: "normal", choice: (await snapshot()).nativeTreasure.bagToken };
      const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
        : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
      const requestId = randomUUID(), signature = createHash("sha256").update(canonical({ activityId: id, action: old })).digest("hex");
      await h.db.execute(sql`INSERT INTO app."ActivityActions" ("UserID","RequestID","Signature","Result")
        VALUES (${uid},${requestId},${signature},${JSON.stringify({ message: "Original immutable receipt", mailedCount: 7 })}::jsonb)`);
      const before = await persisted(); control.locks = []; const replay = await command(id, old, 200, requestId);
      expect(replay).toMatchObject({ replayed: true, message: "Original immutable receipt", mailedCount: 7, nativeTreasure: { version: 2 } });
      expect(replay).not.toHaveProperty("nativeTreasureAction"); expect(control.locks).toEqual([]); expect(control.rngCalls).toBe(0);
      expect(await persisted()).toEqual(before); await command(id, old, 400); expect(await persisted()).toEqual(before);
    });
    it(`${id} settles an earned legacy bag while the full new pool is blocked`, async () => {
      await saveTreasure(legacy()); const value: ActivityAction = { type: "take", ...(id === "treasure-native" ? { choice: (await snapshot()).nativeTreasure.bagToken } : {}) };
      const result = await command(id, value); expect(result).toMatchObject({ mailedCount: 1, points: 1000, nativeTreasure: { bag: [], readiness: { status: "blocked" } } });
      expect((await persisted()).goods.map(row => [row.TemplateID, row.Count, row.IsBinds, row.ValidDate])).toEqual([[11019, 2, true, 0]]);
    });
  }
  it.each(["recycle", "exchange", "progress"])("keeps earned legacy %s independent of global readiness", async type => {
    await saveTreasure(legacy()); const value: ActivityAction = { type, choice: (await snapshot()).nativeTreasure.bagToken, ...(type === "progress" ? { tier: 1 } : {}) };
    const result = await command("treasure-native", value); expect(result.nativeTreasure.readiness.status).toBe("blocked"); expect(control.rngCalls).toBe(0);
  });
  it("delivers a verified original row with private validation while all unrelated rows remain blocked", async () => {
    const entry = TREASURE_ENTRIES.find(row => row.templateId === 11901)!;
    await saveTreasure({ ...legacy(), version: 2, bag: [originalReward(entry)] }); const token = (await snapshot()).nativeTreasure.bagToken;
    const result = await command("treasure-native", { type: "take", index: 0, choice: token });
    expect(result).toMatchObject({ mailedCount: 1, points: 1000, nativeTreasure: { bag: [], readiness: { status: "blocked" } } });
    expect((await persisted()).goods.map(row => [row.TemplateID, row.Count, row.IsBinds, row.ValidDate])).toEqual([[11901, 2, true, 0], [11901, 2, true, 0], [11901, 1, true, 0]]);
  });
  it("rejects whole mixed-bag recycling without losing either entitlement", async () => {
    const entry = TREASURE_ENTRIES.find(row => row.templateId === 11901)!;
    await saveTreasure({ ...legacy(), version: 2, bag: [{ templateId: 11019, count: 2, origin: "legacy-four-material" }, originalReward(entry)] });
    const value = { type: "recycle", choice: (await snapshot()).nativeTreasure.bagToken }, before = await persisted();
    await command("treasure-native", value, 400); expect(await persisted()).toEqual(before);
  });
  it.each(["mail", "receipt"])("rolls back complete mixed take on %s failure and retries the same UUID once", async failure => {
    const entry = TREASURE_ENTRIES.find(row => row.templateId === 11901)!;
    await saveTreasure({ ...legacy(), version: 2, bag: [{ templateId: 11019, count: 2, origin: "legacy-four-material" }, originalReward(entry)] });
    const value = { type: "take", choice: (await snapshot()).nativeTreasure.bagToken }, requestId = randomUUID(), before = await persisted();
    if (failure === "mail") await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT treasure_v2_mail_failure CHECK ("ReceiverID" <> 671)`);
    else await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT treasure_v2_receipt_failure CHECK ("UserID" <> 671)`);
    await command("treasure-native", value, 500, requestId); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS treasure_v2_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS treasure_v2_receipt_failure`);
    await command("treasure-native", value, 200, requestId); const committed = await persisted();
    const replay = await command("treasure-native", value, 200, requestId); expect(replay.replayed).toBe(true); expect(await persisted()).toEqual(committed);
  });
  it("does not make catalog-only rewards part of another activity's ordinary delivery allowlist", async () => {
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CategoryID"=7 WHERE "TemplateID"=11019`);
    const before = await persisted(); await command("exchange", { type: "exchange", index: 0 }, 503); expect(await persisted()).toEqual(before);
  });
});
