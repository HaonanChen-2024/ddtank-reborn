import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { pairNativeLocalRules, type PairNativeState } from "../src/activities/pair-native.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// Only RNG and Date are controlled. Actual HTTP/auth, engine, SQL transactions and mail run.
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined
    ? Math.floor(0.99 * min) : min + Math.floor(0.99 * (max - min)),
}));

const tmp = mkdtempSync(join(tmpdir(), "ddt-pair-native-"));
const uid = 211, otherUid = 212, secret = "native-pair-integration-tests-only";
const start = new Date("2026-10-15T12:00:00Z");
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = {
  NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"),
  CELEB_REBUILD_MIN: 0,
};
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "native-pair-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action },
});
async function action(id: string, value: ActivityAction, requestId = randomUUID(), status = 200): Promise<ActivityResult> {
  const r = await post(id, value, requestId);
  expect(r.statusCode, `${id}/${value.type}: ${r.body}`).toBe(status);
  expect(r.body).not.toMatch(/hiddenDeck|shuffleSeed|pairNativeV1|nativePairEffects|"(?:games|matches|revealed)"\s*:/);
  return r.json();
}
const native = (value: ActivityAction, requestId = randomUUID(), status = 200) => action("pair-native", value, requestId, status);
async function snapshot(): Promise<ActivityResult> {
  const r = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).not.toMatch(/hiddenDeck|shuffleSeed|pairNativeV1|nativePairEffects|"(?:games|matches|revealed)"\s*:/);
  const result = r.json<ActivityResult>(); expect(result).not.toHaveProperty("nativePairAction"); return result;
}
const active = (result: ActivityResult) => {
  expect(result.nativePair.started).toBe(true);
  if (!result.nativePair.started) throw new Error("native board not started");
  return result.nativePair;
};
const saved = async () => (await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))?.State;
async function persisted() {
  return {
    wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
    states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
    receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
    goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
    mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
  };
}
const pairTask = (result: ActivityResult) => result.tasks.find(t => t.id === "pair")!;
const firstGift = (result: ActivityResult) => result.activities.find(a => a.id === "first-gift")!.actions[0];
async function completeAndEarn() {
  await native({ type: "start" });
  await native({ type: "flip-all" });
  return action("tasks", { type: "claim", choice: "pair" });
}
async function materialTotals() {
  const items = await q<{ ItemID: number; TemplateID: number; Count: number; [key: string]: unknown }>(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`);
  const mails = await q<Record<string, unknown>>(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`);
  const refs: number[] = [], totals: Record<number, number> = {};
  for (const mail of mails) {
    expect(mail.ReceiverID).toBe(uid);
    const ids = [mail.Annex1, mail.Annex2, mail.Annex3, mail.Annex4, mail.Annex5].filter(Boolean).map(Number);
    expect(ids.length).toBeGreaterThan(0); expect(ids.length).toBeLessThanOrEqual(5); refs.push(...ids);
  }
  expect(new Set(refs).size).toBe(refs.length);
  expect(refs.sort((a, b) => a - b)).toEqual(items.map(i => i.ItemID).sort((a, b) => a - b));
  for (const item of items) {
    expect(pairNativeLocalRules.prizes.some(p => p.templateId === item.TemplateID)).toBe(true);
    expect(item).toMatchObject({ UserID: 0, Place: -1, IsBinds: true, ValidDate: 0, StrengthenLevel: 0,
      AttackCompose: 0, DefendCompose: 0, LuckCompose: 0, AgilityCompose: 0 });
    expect(item.Count).toBeGreaterThan(0); expect(item.Count).toBeLessThanOrEqual(5);
    totals[item.TemplateID] = (totals[item.TemplateID] ?? 0) + item.Count;
  }
  return totals;
}

beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  const template: typeof game.Shop_Goods.$inferInsert = {
    TemplateID: 11019, Name: "Material", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 5,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true,
    CanEquip: false, CanUse: true, CanDelete: true, Property1: 0, Property2: 0, Property3: 0, Property4: 0,
    Property5: 0, Property6: 0, Property7: 0, Property8: 0, BindType: 0, FusionType: 0, FusionRate: 0,
    FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0,
  };
  await h.db.insert(game.Shop_Goods).values(pairNativeLocalRules.prizes.map(p => ({ ...template, TemplateID: p.templateId, Name: p.name })));
  await rebuild();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start);
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS pair_native_late_mail_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions", app."ActivityStates", app."ActivityWallet", app."EventClaims",
    member."Accounts", player."Sys_Users_Detail", player."Sys_Users_Goods", player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'native-pair-test','tests-only'),(2,'other-pair-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'native-pair-test','Native pair test',true,'2000-01-01',1),(${otherUid},'other-pair-test','Other test',true,'2000-01-01',1)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("native PairBox through the actual activity API and atomic mail", () => {
  it("keeps GET and rejected starts read-only, authorizes the character, and exposes no hidden identities", async () => {
    const empty = await persisted(), initial = await snapshot();
    expect(initial.nativePair).toMatchObject({ started: false, localRules: { slots: 32 } });
    expect(initial.activities).toHaveLength(17); expect(await persisted()).toEqual(empty);
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${otherUid}`, headers: headers() })).statusCode).toBe(403);
    expect((await post("pair-native", { type: "start" }, randomUUID(), otherUid)).statusCode).toBe(403);
    await native({ type: "flip", index: 1 }, randomUUID(), 400);
    await native({ type: "start", choice: "points" }, randomUUID(), 400);
    expect(await persisted()).toEqual(empty);
    const started = await native({ type: "start" });
    expect(active(started).cards).toEqual(Array.from({ length: 32 }, (_, i) => ({ pos: i + 1, ID: -1, isGet: false, otherPos: 0 })));
    const afterStart = await persisted(); await snapshot(); expect(await persisted()).toEqual(afterStart);
    const next = await native({ type: "flip", index: 1 });
    expect(active(next).cards[0]).toMatchObject({ pos: 1, ID: 1, isGet: false, otherPos: 0 });
    expect(active(next).cards.slice(1).every(c => c.ID === -1 && c.otherPos === 0 && !c.isGet)).toBe(true);
    expect(next.nativePairAction?.effects).toEqual([{ type: "revealed", pos: 1, ID: 1, consume: "free" }]);
    expect((await saved())?.games.pairNativeV1).toHaveProperty("hiddenDeck");
  });

  it("preserves the legacy pair game and unlocks tasks/first-gift only from committed native matches/completion", async () => {
    const profiles = await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`);
    const templates = await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`);
    await action("pair", { type: "start" }); await action("pair", { type: "flip", index: 0 });
    const oldGame = (await saved())!.games.pair, oldView = (await snapshot()).activities.find(a => a.id === "pair");
    await native({ type: "start" });
    for (let index = 1; index <= 6; index++) await native({ type: "flip", index });
    const partial = await snapshot();
    expect(pairTask(partial)).toMatchObject({ current: 3, target: 3, claimed: false });
    expect(firstGift(partial).disabled).toBe(true);
    await action("first-gift", { type: "claim" }, randomUUID(), 400);
    const earned = await action("tasks", { type: "claim", choice: "pair" });
    expect(earned).toMatchObject({ points: 60, earned: 60 }); expect(earned).not.toHaveProperty("nativePairAction");
    await action("tasks", { type: "claim", choice: "pair" }, randomUUID(), 400);
    const finished = await native({ type: "flip-all" });
    expect(active(finished)).toMatchObject({ isAllOpen: true, matchedPairs: 16, markCount: 16 });
    expect(firstGift(finished).disabled).toBe(false);
    expect((await saved())?.completed).toEqual({ "pair-native": 1 });
    expect((await saved())?.games.pair).toEqual(oldGame);
    expect(finished.activities.find(a => a.id === "pair")).toEqual(oldView);
    expect(await materialTotals()).toEqual({ 11019: 4, 11001: 4, 11021: 4, 11002: 4 });
    await action("first-gift", { type: "claim" });
    await action("first-gift", { type: "claim" }, randomUUID(), 400);
    expect(await materialTotals()).toEqual({ 11019: 9, 11001: 4, 11021: 5, 11002: 4 });
    const nativeSave = (await saved())!.games.pairNativeV1;
    await action("pair", { type: "flip", index: 1 });
    expect((await saved())!.games.pairNativeV1).toEqual(nativeSave);
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail" ORDER BY "UserID"`)).toEqual(profiles);
    expect(await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(templates);
  });

  it("serializes UUID retries for purchases and rewarded flips, and replays the latest board without effects", async () => {
    await completeAndEarn(); await native({ type: "reset", choice: "free" });
    const buyId = randomUUID(), beforeBuy = await persisted();
    const bought = await Promise.all(Array.from({ length: 8 }, () => post("pair-native", { type: "buy-reels", count: 2 }, buyId)));
    expect(bought.every(r => r.statusCode === 200)).toBe(true);
    expect(bought.filter(r => r.json().replayed)).toHaveLength(7);
    expect(bought.filter(r => r.json().nativePairAction)).toHaveLength(1);
    expect(await snapshot()).toMatchObject({ points: 56, nativePair: { reelCount: 2 } });
    expect((await persisted()).receipts).toHaveLength(beforeBuy.receipts.length + 1);
    await native({ type: "flip", index: 1 }); await native({ type: "flip", index: 2 });
    await native({ type: "flip", index: 3, choice: "points" });
    const matchId = randomUUID(), beforeMatch = await persisted();
    const results = await Promise.all(Array.from({ length: 8 }, () => post("pair-native", { type: "flip", index: 4, choice: "points" }, matchId)));
    expect(results.every(r => r.statusCode === 200)).toBe(true);
    expect(results.filter(r => r.json().replayed)).toHaveLength(7);
    const fresh = results.find(r => !r.json().replayed)!.json<ActivityResult>();
    expect(fresh).toMatchObject({ points: 52, mailedCount: 1, nativePairAction: { requestId: matchId } });
    expect(fresh.nativePairAction?.effects.filter(e => e.type === "matched")).toHaveLength(1);
    for (const response of results.filter(r => r.json().replayed)) expect(response.json()).not.toHaveProperty("nativePairAction");
    expect((await persisted()).goods).toHaveLength(beforeMatch.goods.length + 1);
    expect((await persisted()).mails).toHaveLength(beforeMatch.mails.length + 1);
    await native({ type: "flip", index: 5, choice: "points" });
    const { nativeExchange: _exchange, ...current } = await snapshot(), beforeRetry = await persisted();
    const replay = await native({ type: "flip", index: 4, choice: "points" }, matchId);
    expect(replay).toMatchObject({ ...current, replayed: true, message: fresh.message, mailedCount: fresh.mailedCount });
    expect(replay).not.toHaveProperty("nativePairAction");
    await native({ type: "flip", index: 6, choice: "points" }, matchId, 409);
    await native({ type: "flip", index: 4, choice: "points" }, randomUUID(), 400);
    expect(await persisted()).toEqual(beforeRetry);
    const racing = await Promise.all([post("pair-native", { type: "flip", index: 6, choice: "points" }), post("pair-native", { type: "flip", index: 6, choice: "points" })]);
    expect(racing.map(r => r.statusCode).sort()).toEqual([200, 400]);
    expect((await saved())?.daily.pairs).toBe(19); // First board 16 plus three newly committed pairs.
    expect((await persisted()).receipts.every(row => Object.keys(row.Result as object).sort().join(",") === "mailedCount,message")).toBe(true);
    await materialTotals();
  });

  it("rolls back rejected budgets and a late mail failure, then retries the same uncommitted UUID once", async () => {
    await completeAndEarn(); await native({ type: "reset", choice: "free" });
    const insufficient = await persisted();
    await native({ type: "flip-all", choice: "points" }, randomUUID(), 400); // 64 needed, only 60 earned.
    await native({ type: "flip" , index: 1 }, randomUUID(), 400);
    await native({ type: "buy-reels", count: 65 }, randomUUID(), 400);
    await native({ type: "reset", choice: "points" }, randomUUID(), 400);
    expect(await persisted()).toEqual(insufficient);
    await action("cave", { type: "draw", count: 3 });
    await action("tasks", { type: "claim", choice: "explore" });
    expect((await snapshot()).points).toBe(100);
    const before = await persisted(), requestId = randomUUID();
    // Existing rows are left intact; the fourth new mail has only one attachment and fails.
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT pair_native_late_mail_failure CHECK ("Annex5" IS NOT NULL) NOT VALID`);
    const failed = await post("pair-native", { type: "flip-all", choice: "points" }, requestId);
    expect(failed.statusCode, failed.body).toBe(500);
    expect(failed.body).not.toMatch(/Annex5|hiddenDeck|pairNativeV1|INSERT|UPDATE/);
    expect(await persisted()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT pair_native_late_mail_failure`);
    const retried = await native({ type: "flip-all", choice: "points" }, requestId);
    expect(retried).toMatchObject({ points: 36, mailedCount: 4, nativePair: { round: 2, isAllOpen: true, markCount: 32 } });
    expect((await saved())?.completed["pair-native"]).toBe(2);
    expect((await persisted()).goods).toHaveLength(before.goods.length + 16);
    expect((await persisted()).receipts).toHaveLength(before.receipts.length + 1);
    expect(await materialTotals()).toEqual({ 11019: 8, 11001: 8, 11021: 8, 11002: 8 });
    const after = await persisted();
    expect((await native({ type: "flip-all", choice: "points" }, requestId)).replayed).toBe(true);
    expect(await persisted()).toEqual(after);
  });

  it("delivers mark exchanges only once and rejects unavailable material templates atomically", async () => {
    await completeAndEarn();
    const id = randomUUID();
    const exchanged = await native({ type: "exchange", choice: "11019", count: 2 }, id);
    expect(exchanged).toMatchObject({ points: 60, mailedCount: 1, nativePair: { markCount: 8 } });
    const before = await persisted();
    expect((await native({ type: "exchange", choice: "11019", count: 2 }, id)).replayed).toBe(true);
    expect(await persisted()).toEqual(before);
    await native({ type: "exchange", choice: "11002", count: 2 }, randomUUID(), 400);
    await native({ type: "exchange", choice: "11019", count: 11 }, randomUUID(), 400);
    expect(await persisted()).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11002`);
    const badTemplate = await post("pair-native", { type: "exchange", choice: "11002", count: 1 });
    expect(badTemplate.statusCode, badTemplate.body).toBe(503);
    expect(await persisted()).toEqual(before);
    expect(await materialTotals()).toEqual({ 11019: 6, 11001: 4, 11021: 4, 11002: 4 });
  });

  it("restores through app rebuild/login and projects a new day without persisting or replaying the old action", async () => {
    await native({ type: "start" });
    for (let index = 1; index <= 6; index++) await native({ type: "flip", index });
    await action("tasks", { type: "claim", choice: "pair" });
    const buyId = randomUUID(); await native({ type: "buy-reels", count: 3 }, buyId);
    const old = await snapshot(), before = await persisted();
    const oldToken = headers();
    await built.app.close(); await rebuild();
    expect(await snapshot()).toEqual(old); expect(await persisted()).toEqual(before);
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    expect((await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: oldToken })).statusCode).toBe(401);
    const { nativeExchange: _exchange, ...tomorrow } = await snapshot(); // Fresh token; optional A05 read is outside old owner transactions.
    expect(tomorrow).toMatchObject({ day: "2026-10-16", points: 54, revision: old.revision,
      nativePair: { day: "2026-10-16", freeReelCount: 32, reelCount: 3, markCount: 3, todayBuyCount: 0 } });
    expect(active(tomorrow).cards).toEqual(active(old).cards);
    expect(pairTask(tomorrow)).toMatchObject({ current: 0, claimed: false });
    expect(await persisted()).toEqual(before);
    const replay = await native({ type: "buy-reels", count: 3 }, buyId);
    expect(replay).toMatchObject({ ...tomorrow, replayed: true }); expect(replay).not.toHaveProperty("nativePairAction");
    expect(await persisted()).toEqual(before);
    await native({ type: "flip", index: 7 });
    const state = (await saved())!, board = state.games.pairNativeV1 as PairNativeState;
    expect(state.day).toBe("2026-10-16"); expect(board.day).toBe("2026-10-16");
    expect(board.freeReels).toBe(31); expect(board.reels).toBe(3); expect(board.daily.flips).toBe(1);
    const priorBoard = (before.states[0].State as ActivityState).games.pairNativeV1 as PairNativeState;
    expect(board.hiddenDeck).toEqual(priorBoard.hiddenDeck);
    await native({ type: "flip", index: 8 });
    expect(pairTask(await snapshot())).toMatchObject({ current: 1, claimed: false });
  });
});
