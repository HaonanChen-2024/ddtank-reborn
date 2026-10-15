import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { createActivityState } from "../src/activities/engine.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

const tmp = mkdtempSync(join(tmpdir(), "ddt-forthright-native-")), uid = 911, ids = [911, 912, 913, 914];
const secret = "forthright-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "forthright-native-test", role: "player" }, secret, 3600)}` });
const post = (value: ActivityAction, characterId = uid, requestId: string = randomUUID(), activity = "forthright-native") => built.app.inject({
  method: "POST", url: `/api/account/activities/${activity}/action`, headers: headers(), payload: { characterId, requestId, action: value } });
async function snapshot(characterId = uid): Promise<ActivityResult> {
  const r = await built.app.inject({ url: `/api/account/activities?characterId=${characterId}`, headers: headers() });
  expect(r.statusCode, r.body).toBe(200); expect(r.body).not.toMatch(/"(?:games|seed|creatorId|characterIdInternal|terminalClaimKey)"\s*:/);
  return r.json();
}
async function action(value: ActivityAction, characterId = uid, requestId: string = randomUUID()) {
  const r = await post(value, characterId, requestId); expect(r.statusCode, r.body).toBe(200); return r.json<ActivityResult>();
}
async function request(value: ActivityAction, characterId = uid, requestId: string = randomUUID()) {
  return action({ ...value, choice: (await snapshot(characterId)).nativeForthright.stateToken }, characterId, requestId);
}
const saved = async (id = uid) => (await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${id} AND "Activity"='reference'`))?.State;
async function seedState(edit: (s: ActivityState) => void, id = uid) {
  const s = (await saved(id)) ?? createActivityState(new Date()); edit(s);
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${id},'reference',${JSON.stringify(s)}::jsonb)
    ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=excluded."State"`);
}
async function persisted() { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`), states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`), goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`), mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
const ownGroup = async (id = uid) => (await snapshot(id)).nativeForthright.pages.groups.createdOrders[0];
async function inspect(code: string, id = 912) { return (await action({ type: "inspect-group", choice: code }, id)).nativeForthright.pages.groups.inspected!; }
const open = (index = 0, id = uid, requestId: string = randomUUID()) => request({ type: "open-group", index, tier: 0, count: 1, marked: true }, id, requestId);
async function joinGroup(code: string, id: number, requestId: string = randomUUID()) { return action({ type: "join-group", count: 1, choice: (await inspect(code, id)).actionToken }, id, requestId); }
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  const template: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "Material", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 2,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  await h.db.insert(game.Shop_Goods).values(PRIZES.map(p => ({ ...template, TemplateID: p.templateId, Name: p.name }))); await rebuild();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T02:00:00Z"));
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS forthright_mail_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS forthright_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false,"MaxCount"=2`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'forthright-native-test','tests-only'),(2,'foreign-test','tests-only')`);
  for (const id of ids) {
    await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst") VALUES (${id},'forthright-native-test',${`角色${id}`},true,'2000-01-01',1)`);
    await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${id},1000,1000)`);
  }
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst") VALUES (999,'foreign-test','外部角色',true,'2000-01-01',1)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close(); const base = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(base, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory"); rmSync(target, { recursive: true, force: true });
});
describe("forthright native real atomic HTTP", () => {
  it("GET and inspect do not write; foreign roles and injected economy fields are rejected", async () => {
    await h.db.execute(sql`DELETE FROM app."ActivityWallet"`); const before = await persisted(), p = await snapshot();
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post({ type: "claim", tier: 1, choice: p.nativeForthright.stateToken }, 999)).statusCode).toBe(403);
    for (const value of [{ type: "draw", count: 2, choice: p.nativeForthright.stateToken }, { type: "draw", count: 1, choice: p.nativeForthright.stateToken, tier: 1 },
      { type: "open-group", index: 0, tier: 0, marked: true, count: 1, choice: p.nativeForthright.stateToken, price: 0 }]) {
      expect([400, 409]).toContain((await post(value)).statusCode);
    }
    expect((await post({ type: "inspect-group", choice: "gpb-1" })).statusCode).toBe(404); expect(await persisted()).toEqual(before);
  });
  it("old and native luxury share one entitlement and honor cap500", async () => {
    expect((await post({ type: "claim", tier: 1 }, uid, randomUUID(), "luxury")).statusCode).toBe(200);
    await seedState(s => { s.daily.actions = 500; s.games.keep = { exact: 7 }; });
    expect((await snapshot()).nativeForthright.pages.luxury.tiers[0].claimed).toBe(true);
    const result = await request({ type: "claim", tier: 3 }); expect(result.mailedCount).toBe(2); expect(result.earned).toBe(1000);
    expect((await post({ type: "claim", tier: 3 }, uid, randomUUID(), "luxury")).statusCode).toBe(400);
    expect((await saved())!.games.keep).toEqual({ exact: 7 }); expect((await saved())!.daily.actions).toBe(500);
  });
  it("three true roles complete once, split original stacks, refund cashback and preserve all independent saves", async () => {
    for (const id of ids) await seedState(s => { s.games.keep = { id }; s.claims.push(`keep:${id}`); }, id);
    const templates = await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`);
    await open(); const code = (await ownGroup()).code; const beforeInspect = await persisted(); await inspect(code); expect(await persisted()).toEqual(beforeInspect);
    await joinGroup(code, 912); const value = { type: "join-group", count: 1, choice: (await inspect(code, 913)).actionToken }, requestId = randomUUID();
    const results = await Promise.all([action(value, 913, requestId), action(value, 913, requestId)]);
    expect(results.filter(r => r.replayed)).toHaveLength(1); expect(results.filter(r => r.nativeForthrightAction)).toHaveLength(1);
    const p = await persisted(); expect(p.goods).toHaveLength(9); expect(p.goods.map(g => Number(g.Count))).toEqual([2, 2, 1, 2, 2, 1, 2, 2, 1]);
    expect(p.goods.every(g => g.IsBinds && Number(g.ValidDate) === 0 && Number(g.TemplateID) === 11019)).toBe(true);
    for (const id of ids.slice(0, 3)) { const snap = await snapshot(id); expect(snap).toMatchObject({ points: 969, earned: 1000, nativeCharge: { grossSpent: 32 } });
      expect((await saved(id))!.games.keep).toEqual({ id }); expect((await saved(id))!.claims).toContain(`keep:${id}`); }
    expect((await ownGroup()).status).toBe("completed"); expect(await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(templates);
  });
  it("leave refunds only the actor, leaves room for replacement, and forbids old member rejoin", async () => {
    await open(); const code = (await ownGroup()).code; await joinGroup(code, 912);
    const leave = await action({ type: "leave-group", choice: (await inspect(code, 912)).actionToken }, 912);
    expect(leave).toMatchObject({ points: 1000, earned: 1000, nativeCharge: { grossSpent: 32 } }); expect((await ownGroup()).status).toBe("pending");
    expect((await post({ type: "join-group", count: 1, choice: (await inspect(code, 912)).actionToken }, 912)).statusCode).toBe(409);
    await joinGroup(code, 913); await joinGroup(code, 914); const p = await persisted();
    expect(p.goods.filter(g => Number(g.UserID) === 912)).toHaveLength(0); expect(p.goods).toHaveLength(9);
    expect((await ownGroup()).members.find(m => m.nickname === "角色912")).toMatchObject({ status: "left", paid: 32, credited: 32, rewardMailed: false });
  });
  it("noncreator cannot cancel, creator cannot leave, cancellation refunds all at cap and records no earned", async () => {
    await open(); const code = (await ownGroup()).code; await joinGroup(code, 912);
    expect((await post({ type: "cancel-group", choice: (await inspect(code, 912)).actionToken }, 912)).statusCode).toBe(409);
    expect((await post({ type: "leave-group", choice: (await ownGroup()).actionToken })).statusCode).toBe(409);
    await seedState(s => { s.daily.actions = 500; });
    const result = await action({ type: "cancel-group", choice: (await ownGroup()).actionToken }); expect(result.points).toBe(1000);
    expect((await snapshot(912)).points).toBe(1000); expect((await saved())!.daily.actions).toBe(500);
    expect((await persisted()).goods).toHaveLength(0); expect(result.nativeCharge.grossSpent).toBe(32);
  });
  it("retains due credit across full wallets and settles without redelivering or increasing earned", async () => {
    await open(); const code = (await ownGroup()).code; await joinGroup(code, 912);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=2147483647 WHERE "UserID"=912`);
    await action({ type: "leave-group", choice: (await inspect(code, 912)).actionToken }, 912);
    expect((await inspect(code, 912)).refundDue).toBe(32);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"="Points"-20 WHERE "UserID"=912`);
    await action({ type: "settle-group", choice: (await ownGroup()).actionToken });
    expect((await inspect(code, 912)).refundDue).toBe(12); expect((await snapshot(912)).earned).toBe(1000); expect((await persisted()).goods).toHaveLength(0);
  });
  it("expiry is read-only until explicit settlement and preserves cross-day frozen amounts", async () => {
    vi.setSystemTime(new Date("2026-10-15T23:50:00Z")); await open(); const code = (await ownGroup()).code;
    vi.setSystemTime(new Date("2026-10-16T00:05:00Z")); await joinGroup(code, 912);
    vi.setSystemTime(new Date("2026-10-16T00:20:00Z")); const before = await persisted(); expect((await inspect(code, 912)).status).toBe("expired-unsettled"); expect(await persisted()).toEqual(before);
    await action({ type: "settle-group", choice: (await inspect(code, 912)).actionToken }, 912); expect((await snapshot()).points).toBe(1000); expect((await snapshot(912)).points).toBe(1000);
  });
  it("rolls back all three wallets/states/mail/items/receipt if final group delivery or receipt fails", async () => {
    await open(); const code = (await ownGroup()).code; await joinGroup(code, 912);
    for (const failure of ["mail", "receipt"] as const) {
      const value = { type: "join-group", count: 1, choice: (await inspect(code, 913)).actionToken }, requestId = randomUUID(), before = await persisted();
      if (failure === "mail") await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT forthright_mail_failure CHECK ("Annex5" IS NOT NULL) NOT VALID`);
      else await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT forthright_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
      const response = await post(value, 913, requestId); expect(response.statusCode, response.body).toBe(500); expect(await persisted()).toEqual(before);
      if (failure === "mail") await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT forthright_mail_failure`);
      else await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT forthright_receipt_failure`);
      if (failure === "receipt") { await action(value, 913, requestId); expect((await ownGroup()).status).toBe("completed"); }
    }
  });
  it("refund late receipt failure rolls back canonical membership and every credit, then same UUID succeeds once", async () => {
    await open(); const code = (await ownGroup()).code; await joinGroup(code, 912);
    const value = { type: "cancel-group", choice: (await ownGroup()).actionToken }, requestId = randomUUID(), before = await persisted();
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT forthright_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    expect((await post(value, uid, requestId)).statusCode).toBe(500); expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT forthright_receipt_failure`); await action(value, uid, requestId);
    const committed = await persisted(); expect((await action(value, uid, requestId)).replayed).toBe(true); expect(await persisted()).toEqual(committed);
  });
  it("recognizes committed UUID even after group archive and app restart, without another effect or mail", async () => {
    const requestId = randomUUID(), value = { type: "open-group", index: 0, tier: 0, count: 1, marked: true, choice: (await snapshot()).nativeForthright.stateToken };
    await action(value, uid, requestId); await seedState(s => { (s.games.forthrightNativeV1 as { createdGroups: unknown }).createdGroups = {}; });
    await built.app.close(); await rebuild(); const before = await persisted();
    const replay = await action(value, uid, requestId); expect(replay.replayed).toBe(true); expect(replay.nativeForthrightAction).toBeUndefined(); expect(await persisted()).toEqual(before);
    expect((await post({ ...value, index: 1 }, uid, requestId)).statusCode).toBe(409);
  });
  it("deposit/balance and expired refund use exact UTC phase, old gross ledger, original material stacks and settlement exemption", async () => {
    await request({ type: "deposit", index: 0, count: 1 }); expect((await persisted()).goods).toHaveLength(0);
    await seedState(s => { s.daily.actions = 500; }); vi.setSystemTime(new Date("2026-10-15T08:00:00Z"));
    const order = (await snapshot()).nativeForthright.pages.shop.offers[0].order!;
    const result = await action({ type: "pay-balance", choice: order.actionToken }); expect(result).toMatchObject({ points: 984, earned: 1000, nativeCharge: { grossSpent: 16 } });
    expect((await persisted()).goods.map(g => Number(g.Count))).toEqual([2, 1]); expect((await saved())!.daily.actions).toBe(500);
    vi.setSystemTime(new Date("2026-10-16T02:00:00Z")); await request({ type: "deposit", index: 0, count: 1 });
    vi.setSystemTime(new Date("2026-10-16T16:00:00Z")); const p = await snapshot(), before = await persisted(); expect(p.nativeForthright.pages.shop.offers[0].canBuyFullPrice).toBe(false); expect(await persisted()).toEqual(before);
    const refund = await action({ type: "settle-order", choice: p.nativeForthright.pages.shop.unsettledOrders[0].actionToken }); expect(refund.points).toBe(984); expect(refund.nativeCharge.grossSpent).toBe(20);
    expect(refund.nativeForthright.pages.shop.offers[0].canBuyFullPrice).toBe(true);
  });
});
