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

// Actual HTTP, authorization, engine, SQL transaction and mail. Only Date/RNG are deterministic.
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(0.99 * min) : min + Math.floor(0.99 * (max - min)) }));
const tmp = mkdtempSync(join(tmpdir(), "ddt-mines-native-"));
const uid = 311, otherUid = 312, secret = "mines-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "mines-native-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
async function action(id: string, value: ActivityAction, requestId = randomUUID(), status = 200): Promise<ActivityResult> {
  const r = await post(id, value, requestId); expect(r.statusCode, `${id}/${value.type}: ${r.body}`).toBe(status);
  expect(r.body).not.toMatch(/minesNativeV1|nativeMinesEffects|"(?:board|mines|games)"\s*:/); return r.json();
}
const native = (value: ActivityAction, requestId = randomUUID(), status = 200) => action("mines-native", value, requestId, status);
async function snapshot(): Promise<ActivityResult> {
  const r = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(r.statusCode, r.body).toBe(200); expect(r.body).not.toMatch(/minesNativeV1|nativeMinesEffects|"(?:board|mines|games)"\s*:/);
  const result = r.json<ActivityResult>(); expect(result).not.toHaveProperty("nativeMinesAction"); return result;
}
function board(result: ActivityResult) { if (!result.nativeMines.started) throw new Error("board not started"); return result.nativeMines; }
const saved = async () => (await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))?.State;
async function persisted() { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
async function walk(count: number, start = 0) { for (let index = start; index < start + count; index++) await native({ type: "walk", index }); }
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
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS mines_native_mail_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions", app."ActivityStates", app."ActivityWallet", app."EventClaims",
    member."Accounts", player."Sys_Users_Detail", player."Sys_Users_Goods", player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'mines-native-test','tests-only'),(2,'other-mines-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'mines-native-test','Mines native test',true,'2000-01-01',1),(${otherUid},'other-mines-test','Other test',true,'2000-01-01',1)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("native 70-cell mines through the real API and atomic reward mail", () => {
  it("does not start on GET, requires account ownership, rejects invalid actions without writes and hides closed mines", async () => {
    const before = await persisted(); expect((await snapshot()).nativeMines).toMatchObject({ started: false }); expect(await persisted()).toEqual(before);
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post("mines-native", { type: "start" }, randomUUID(), otherUid)).statusCode).toBe(403);
    await native({ type: "walk", index: 0 }, randomUUID(), 400); await native({ type: "start", choice: "free" }, randomUUID(), 400);
    expect(await persisted()).toEqual(before);
    const started = board(await native({ type: "start" })); expect(started.cells).toHaveLength(70);
    expect(started.cells.every(c => !Object.hasOwn(c, "mine") && !Object.hasOwn(c, "aroundMineCount"))).toBe(true);
    const afterStart = await persisted(); await snapshot(); expect(await persisted()).toEqual(afterStart);
    await native({ type: "walk", index: 70 }, randomUUID(), 400); expect(await persisted()).toEqual(afterStart);
    const opened = board(await native({ type: "walk", index: 0 }));
    expect(opened.cells[0]).toMatchObject({ opened: true, mine: false, aroundMineCount: 0 });
    expect(opened.cells.slice(1).every(c => !Object.hasOwn(c, "mine") && !Object.hasOwn(c, "aroundMineCount"))).toBe(true);
  });

  it("keeps legacy 36-cell saves and player profiles intact, and grants tasks from fresh reveals only", async () => {
    const profiles = await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`);
    await action("mines", { type: "start" }); await action("mines", { type: "open", index: 0 });
    const old = (await saved())!.games.mines;
    await native({ type: "start" }); await walk(10);
    const phase = await snapshot(); expect(phase.tasks.find(t => t.id === "mines")).toMatchObject({ current: 8, claimed: false });
    expect(phase.activities.find(a => a.id === "first-gift")!.actions[0].disabled).toBe(true);
    expect((await persisted()).mails).toHaveLength(0); expect((await saved())!.daily.safe).toBe(11);
    const moved = await native({ type: "walk", index: 0 }); expect(moved.nativeMinesAction?.effects).toMatchObject([{ type: "walked", newlyOpened: false }]);
    expect((await saved())!.daily.safe).toBe(11); expect((await saved())!.games.mines).toEqual(old);
    const earned = await action("tasks", { type: "claim", choice: "mines" }); expect(earned).toMatchObject({ points: 60, earned: 60 });
    const claimed = await native({ type: "claim", tier: 1 }); expect(claimed.mailedCount).toBe(1);
    expect(claimed.activities.find(a => a.id === "first-gift")!.actions[0].disabled).toBe(false);
    expect((await saved())!.games.mines).toEqual(old); expect((await saved())!.completed["mines-native"]).toBe(1);
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`)).toEqual(profiles);
  });

  it("serializes repeated and racing claims, returns latest state on replay and never reanimates or remails", async () => {
    await native({ type: "start" }); await walk(10); const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => post("mines-native", { type: "claim", tier: 1 }, id)));
    expect(results.every(r => r.statusCode === 200)).toBe(true); expect(results.filter(r => r.json().replayed)).toHaveLength(7);
    expect(results.filter(r => r.json().nativeMinesAction)).toHaveLength(1);
    for (const r of results.filter(r => r.json().replayed)) expect(r.json()).not.toHaveProperty("nativeMinesAction");
    expect((await persisted()).mails).toHaveLength(1); expect((await persisted()).goods).toHaveLength(1);
    await walk(20, 10); const { nativeExchange: _exchange, ...latest } = await snapshot(), before = await persisted();
    const replay = await native({ type: "claim", tier: 1 }, id); expect(replay).toMatchObject({ ...latest, replayed: true, mailedCount: 1 });
    expect(replay).not.toHaveProperty("nativeMinesAction"); await native({ type: "claim", tier: 2 }, id, 409); expect(await persisted()).toEqual(before);
    const racing = await Promise.all([post("mines-native", { type: "claim", tier: 2 }), post("mines-native", { type: "claim", tier: 2 })]);
    expect(racing.map(r => r.statusCode).sort()).toEqual([200, 400]);
    expect((await persisted()).mails).toHaveLength(2); expect((await persisted()).goods).toHaveLength(2);
    await walk(30, 30); expect((await persisted()).mails).toHaveLength(2);
    const third = await native({ type: "claim", tier: 3 }); expect(third.mailedCount).toBe(1);
    expect(board(third).claims.every(c => c.eligible && c.claimed)).toBe(true);
    const delivered = await persisted(); expect(delivered.mails).toHaveLength(3); expect(delivered.goods).toHaveLength(3);
    expect(delivered.goods.reduce((sum, row) => sum + Number(row.Count), 0)).toBe(6);
    await native({ type: "claim", tier: 3 }, randomUUID(), 400); expect(await persisted()).toEqual(delivered);
    expect((await persisted()).receipts.every(r => Object.keys(r.Result as object).sort().join(",") === "mailedCount,message")).toBe(true);
  });

  it("rolls back a late mail failure and an unavailable template before retrying the same UUID exactly once", async () => {
    await native({ type: "start" }); await walk(10); const before = await persisted(), id = randomUUID();
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT mines_native_mail_failure CHECK ("Annex2" IS NOT NULL) NOT VALID`);
    const failed = await post("mines-native", { type: "claim", tier: 1 }, id);
    expect(failed.statusCode, failed.body).toBe(500); expect(failed.body).not.toMatch(/Annex|INSERT|UPDATE|minesNativeV1/); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT mines_native_mail_failure`);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true`);
    expect((await post("mines-native", { type: "claim", tier: 1 }, id)).statusCode).toBe(503); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
    expect((await native({ type: "claim", tier: 1 }, id)).mailedCount).toBe(1);
    const after = await persisted(); expect((await native({ type: "claim", tier: 1 }, id)).replayed).toBe(true); expect(await persisted()).toEqual(after);
  });

  it("atomically charges probe/revive/reset, deduplicates paid retries and preserves pending claims", async () => {
    await native({ type: "start" }); await native({ type: "walk", index: 50 });
    const empty = await persisted(); await native({ type: "probe" }, randomUUID(), 400); expect(await persisted()).toEqual(empty);
    await walk(8); await action("tasks", { type: "claim", choice: "mines" });
    await native({ type: "walk", index: 50 }); const probeId = randomUUID(); const probed = await native({ type: "probe" }, probeId);
    expect(probed).toMatchObject({ points: 55, mailedCount: 0, nativeMines: { findMineTimes: 1 } });
    const afterProbe = await persisted(); expect((await native({ type: "probe" }, probeId)).replayed).toBe(true); expect(await persisted()).toEqual(afterProbe);
    for (const index of [60, 61, 62]) await native({ type: "walk", index });
    expect(board(await snapshot()).hp).toBe(0); const reviveId = randomUUID();
    expect(await native({ type: "revive" }, reviveId)).toMatchObject({ points: 40, nativeMines: { hp: 3, revivesRemaining: 0 } });
    const afterRevive = await persisted(); await native({ type: "revive" }, reviveId); expect(await persisted()).toEqual(afterRevive);
    await native({ type: "walk", index: 8 }); // 10th fresh safe reveal: milestone remains manual.
    const beforeReset = await persisted(); await native({ type: "reset", choice: "free" }, randomUUID(), 400); expect(await persisted()).toEqual(beforeReset);
    await native({ type: "claim", tier: 1 }); await native({ type: "reset", choice: "free" }); await native({ type: "walk", index: 0 });
    const resetId = randomUUID(); expect(await native({ type: "reset", choice: "points" }, resetId)).toMatchObject({ points: 30, nativeMines: { round: 3 } });
    const afterReset = await persisted(); await native({ type: "reset", choice: "points" }, resetId); expect(await persisted()).toEqual(afterReset);
  });

  it("restores all 70 cells after app restart and renews daily allowances on read without altering the save", async () => {
    await native({ type: "start" }); await walk(10); await native({ type: "claim", tier: 1 });
    const old = await snapshot(), before = await persisted(); await built.app.close(); await rebuild();
    expect(await snapshot()).toEqual(old); expect(await persisted()).toEqual(before);
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const next = await snapshot(); expect(board(next)).toMatchObject({ day: "2026-10-16", round: 1, openCount: 10, roundsRemaining: 3, freeResetCount: 1 });
    expect(board(next).cells).toEqual(board(old).cells); expect(await persisted()).toEqual(before);
    const reset = await native({ type: "reset", choice: "free" }); expect(board(reset)).toMatchObject({ round: 2, openCount: 0, roundsRemaining: 2 });
    const items = await q(h, sql`SELECT * FROM player."Sys_Users_Goods"`), mails = await q(h, sql`SELECT * FROM player."User_Messages"`);
    expect(items).toHaveLength(1); expect(mails).toHaveLength(1); expect(mails[0].ReceiverID).toBe(uid); expect(Number(mails[0].Annex1)).toBe(items[0].ItemID);
    expect(items[0]).toMatchObject({ TemplateID: 11019, Count: 1, UserID: 0, Place: -1, IsBinds: true, ValidDate: 0, StrengthenLevel: 0,
      AttackCompose: 0, DefendCompose: 0, AgilityCompose: 0, LuckCompose: 0 });
  });
});
