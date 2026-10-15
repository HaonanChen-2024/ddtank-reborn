import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app, createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { signJwt } from "../src/lib/jwt.js";
import { q, q1 } from "../src/lib/db.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction } from "../src/activities/types.js";
import { validExchangeView } from "../src/activities/exchange-native.js";
import { actNativeExchange, readNativeExchange } from "../../game/src/game/activity-exchange-native.js";
import { exchangeFixture, seedExchangeTemplates } from "../../game/test/native-exchange-fixture.js";

const temp = mkdtempSync(join(tmpdir(), "ddt-a05-http-")), secret = "native-exchange-http-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>, f: Awaited<ReturnType<typeof exchangeFixture>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, JWT_SECRET: secret,
  RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "http://a05-tests.invalid", GAME_INTERNAL_TOKEN: "local-tests-only",
  FLASH_DIR: join(temp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(temp, "resource"), UPLOAD_DIR: join(temp, "uploads"),
  REQUEST_SNAPSHOT_DIR: join(temp, "snapshots"), RUFFLE_DIR: join(temp, "ruffle"), CELEB_REBUILD_MIN: 0 };
let mode: "normal" | "timeout" | "non200" | "malformed" | "reject" | "after-commit" | "private-leak" | "concurrent" = "normal";
const calls: { path: string; body: Record<string, unknown> }[] = [];
const fixtures: { label: string; snapshot: ActivityResult }[] = [];
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 905, name: "native-exchange-905", role: "player" }, secret, 3600)}` });
const post = (action: ActivityAction, requestId = randomUUID(), activity = "exchange-native", characterId = 905) => built.app.inject({
  method: "POST", url: `/api/account/activities/${activity}/action`, headers: headers(), payload: { characterId, requestId, action } });
async function snapshot() {
  const r = await built.app.inject({ url: "/api/account/activities?characterId=905", headers: headers() }); expect(r.statusCode, r.body).toBe(200);
  const s = r.json<ActivityResult>(); expect(validExchangeView(s.nativeExchange)).toBe(true); return s;
}
async function action(index = 0, count = 1) { return { type: "exchange", index, count, choice: (await snapshot()).nativeExchange!.stateToken! }; }
const stored = async () => ({ wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`), receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`), mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`) });
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h); await seedExchangeTemplates(h);
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config });
});
beforeEach(async () => {
  mode = "normal"; calls.length = 0;
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  f = await exchangeFixture(h);
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as Record<string, unknown>, path = new URL(url).pathname;
    calls.push({ path, body });
    if (path === "/mail-notice") return Response.json({ sent: true });
    if (mode === "timeout") throw new Error("simulated transport timeout");
    if (mode === "non200") return new Response("upstream error", { status: 500 });
    if (mode === "malformed") return Response.json({ ok: true, value: { invalid: true } });
    if (mode === "reject") return Response.json({ ok: false, status: 409, message: "材料已变化，请刷新。" });
    const result = path.endsWith("/read") ? await readNativeExchange(f.ctx, body, f.client) : await actNativeExchange(f.ctx, body, f.client);
    if (mode === "after-commit" && path.endsWith("/action")) { mode = "normal"; throw new Error("response lost after commit"); }
    if (mode === "concurrent" && path.endsWith("/action")) { await h.db.update(app.ActivityWallet).set({ Revision: 2 }).where(eq(app.ActivityWallet.UserID, 905)); mode = "normal"; }
    if (mode === "private-leak" && result.ok) Object.assign(result.value, { privateItemId: 123 });
    return Response.json(result);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => {
  if (process.env.A05_PUBLIC_FIXTURES) writeFileSync(process.env.A05_PUBLIC_FIXTURES, JSON.stringify({ source: "actual API HTTP + game owner synthetic PGlite fixtures", fixtures }, null, 2) + "\n");
  await built?.app.close(); await h?.close();
  const base = realpathSync(tmpdir()), target = realpathSync(temp), rel = relative(base, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe test temporary directory"); rmSync(target, { recursive: true, force: true });
});
describe("A05 real game owner through authenticated API HTTP", () => {
  it("GET is read-only with real online material counts and JWT-derived internal actor", async () => {
    const before = await stored(), s = await snapshot(); expect(await stored()).toEqual(before);
    expect(s.nativeExchange!.authority).toBe("online"); expect(s.nativeExchange!.materials[0]!.eligibleCount).toBe(40);
    expect(calls[0]!.body.actor).toEqual({ accountId: 905, accountName: "native-exchange-905" });
    fixtures.push({ label: "online-ready", snapshot: s });
  });
  it("batch action returns only one committed effect, quota and matching global revision", async () => {
    const r = await post(await action(0, 3)); expect(r.statusCode, r.body).toBe(200); const s = r.json<ActivityResult>();
    expect(s.nativeExchangeAction!.effects).toHaveLength(1); expect(s.nativeExchangeAction!.effects[0]).toMatchObject({ count: 3, committedRevision: 1, consumed: [{ count: 12 }] });
    expect(s.nativeExchange!.revision).toBe(s.revision); expect(s.nativeExchange!.recipes[0]!.exchanged).toBe(3);
    expect((await stored()).states.every(row => row.Activity === "exchange-native")).toBe(true); fixtures.push({ label: "fresh-count3", snapshot: s });
  });
  it("response lost after commit retries the same UUID with no second deduction/mail/effect", async () => {
    const a = await action(), id = randomUUID(); mode = "after-commit";
    expect((await post(a, id)).statusCode).toBe(503); const before = await stored();
    const r = await post(a, id); expect(r.statusCode, r.body).toBe(200); const s = r.json<ActivityResult>();
    expect(s.replayed).toBe(true); expect(s.nativeExchangeAction).toBeUndefined(); expect(await stored()).toEqual(before); fixtures.push({ label: "replay-no-effect", snapshot: s });
  });
  it("committed UUID can replay offline without a material token or new mail", async () => {
    const a = await action(), id = randomUUID(); expect((await post(a, id)).statusCode).toBe(200);
    f.ctx.world.remove(f.p); f.client.closed = true; const before = await stored();
    const r = await post(a, id); expect(r.statusCode, r.body).toBe(200); const s = r.json<ActivityResult>();
    expect(s.nativeExchange!.authority).toBe("offline"); expect(s.nativeExchange!.stateToken).toBeNull(); expect(await stored()).toEqual(before);
    fixtures.push({ label: "offline-replay", snapshot: s });
  });
  it.each(["timeout", "non200", "malformed"] as const)("%s leaves all other activities available and POST outcome explicitly uncertain", async failure => {
    const a = await action(), before = await stored(); mode = failure;
    const s = await snapshot(); expect(s.activities).toHaveLength(17); expect(s.nativeExchange).toMatchObject({ authority: "unavailable", available: false, stateToken: null, materials: [], recipes: [] });
    const r = await post(a); expect(r.statusCode, r.body).toBe(503); expect(r.body).toContain("同一请求编号"); expect(await stored()).toEqual(before);
    if (failure === "timeout") fixtures.push({ label: "service-unavailable", snapshot: s });
  });
  it("preserves determinate game rejection and rejects unsafe extra action fields before internal calls", async () => {
    const a = await action(); mode = "reject"; const r = await post(a); expect(r.statusCode).toBe(409); expect(r.body).toContain("材料已变化");
    calls.length = 0;
    expect((await post({ ...a, templateId: 11021 } as ActivityAction)).statusCode).toBe(400); expect(calls).toEqual([]);
    expect((await post({ ...a, count: 1.5 })).statusCode).toBe(400); expect(calls).toEqual([]);
  });
  it("ordinary old actions never call game while holding a wallet transaction", async () => {
    await h.db.insert(app.ActivityWallet).values({ UserID: 905, Points: 100, Earned: 100 });
    await snapshot(); calls.length = 0;
    const r = await post({ type: "claim", tier: 1 }, randomUUID(), "points-gift"); expect(r.statusCode, r.body).toBe(200);
    expect(calls.map(c => c.path)).toEqual(["/mail-notice"]);
    expect(r.json<ActivityResult>().nativeExchange).toBeUndefined();
  });
  it("checks character/account ownership before any command and blocks private upstream leakage", async () => {
    const a = await action(); calls.length = 0;
    expect((await post(a, randomUUID(), "exchange-native", 999)).statusCode).toBe(403); expect(calls).toEqual([]);
    mode = "private-leak"; const s = await snapshot(); expect(s.nativeExchange!.authority).toBe("unavailable"); expect(JSON.stringify(s)).not.toContain("privateItemId");
  });
  it("reconciles a concurrent wallet revision with a fresh authority read after commit", async () => {
    const a = await action(); mode = "concurrent"; const r = await post(a); expect(r.statusCode, r.body).toBe(200); const s = r.json<ActivityResult>();
    expect(s.revision).toBe(2); expect(s.nativeExchange!.revision).toBe(2); expect(s.nativeExchangeAction!.effects[0]!.committedRevision).toBe(1);
    expect(calls.filter(c => c.path.endsWith("/read")).length).toBeGreaterThan(1); fixtures.push({ label: "fresh-after-concurrent-wallet", snapshot: s });
  });
  it("actual quantity limits, room/locked states and quota are published without fake zero material counts", async () => {
    const a = await action(0, 10), r = await post(a); expect(r.statusCode, r.body).toBe(200); fixtures.push({ label: "fresh-count10-sold-out", snapshot: r.json() });
    fixtures.push({ label: "quota-sold-out", snapshot: await snapshot() });
    f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; const locked = await snapshot(); expect(locked.nativeExchange!.stateToken).toBeNull(); fixtures.push({ label: "online-bag-locked", snapshot: locked });
    f.p.info.IsLocked = false; f.p.currentRoom = {} as typeof f.p.currentRoom; const room = await snapshot(); expect(room.nativeExchange!.authority).toBe("online"); fixtures.push({ label: "online-in-room", snapshot: room });
    f.p.currentRoom = null; f.ctx.world.remove(f.p); const off = await snapshot(); expect(off.nativeExchange!.materials.every(m => m.eligibleCount === null)).toBe(true); fixtures.push({ label: "offline-no-token", snapshot: off });
  });
  it("insufficient qualified materials and quantity11 have no effect or state writes", async () => {
    f.material.Count = 3; f.material.isDirty = true; const s = await snapshot(); expect(s.nativeExchange!.recipes[0]!.maxCount).toBe(0);
    fixtures.push({ label: "online-insufficient", snapshot: s }); const before = await stored();
    expect((await post({ type: "exchange", index: 0, count: 11, choice: s.nativeExchange!.stateToken! })).statusCode).toBe(400);
    expect((await post({ type: "exchange", index: 0, count: 1, choice: s.nativeExchange!.stateToken! })).statusCode).toBe(409); expect(await stored()).toEqual(before);
  });
});
