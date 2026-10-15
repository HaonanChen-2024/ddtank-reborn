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
import { advanceCarnivalGlobal, type CarnivalGlobalState } from "../src/activities/carnival-global.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

const notice = vi.hoisted(() => ({ ids: [] as number[] }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? 0 : min }));
vi.mock("../src/routes/public.js", async original => ({ ...await original<typeof import("../src/routes/public.js")>(),
  gameInternalPost: async (_app: unknown, path: string, payload: { userId: number }) => {
    if (path === "/mail-notice") notice.ids.push(payload.userId);
  } }));
const tmp = mkdtempSync(join(tmpdir(), "ddt-carnival-global-"));
const alice = 821, bob = 822, secret = "carnival-global-test-only";
const people = [{ characterId: alice, nickName: "Alice" }, { characterId: bob, nickName: "Bob" }];
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = (id: number) => ({ authorization: `Bearer ${signJwt({ sub: id, name: `global-${id}`, role: "player" }, secret, 3600)}` });
const post = (id: number, action: ActivityAction, requestId = randomUUID()) => built.app.inject({ method: "POST",
  url: "/api/account/activities/carnival-native/action", headers: headers(id), payload: { characterId: id, requestId, action } });
async function get(id = alice) {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${id}`, headers: headers(id) });
  expect(response.statusCode, response.body).toBe(200); return response.json<ActivityResult>();
}
async function draw(id = alice, count = 1, requestId = randomUUID()) {
  const before = await get(id), action = { type: "draw", count, choice: before.nativeCarnival.stateToken };
  const response = await post(id, action, requestId); expect(response.statusCode, response.body).toBe(200);
  return { result: response.json<ActivityResult>(), action, requestId };
}
const shared = async () => (await q1<{ State: CarnivalGlobalState }>(h, sql`SELECT "State" FROM app."CarnivalGlobalState" WHERE "Key"='native-v1'`))?.State;
async function persisted() { return {
  global: await q(h, sql`SELECT * FROM app."CarnivalGlobalState" ORDER BY "Key"`),
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
/** Canonical pure owners seed the first 99 committed-shape draws, leaving the final HTTP transaction under test. */
async function seed99() {
  let state = createActivityState(new Date()), value: CarnivalGlobalState | undefined;
  let wallet = { points: 10000, earned: 40, revision: 0 };
  for (let left = 99; left > 0; left -= 5) {
    const count = Math.min(left, 5), ctx = { now: new Date(), characterId: alice, signDays: [], ownedTemplateIds: [] };
    const token = viewActivities(state, wallet, ctx).nativeCarnival.stateToken;
    const next = transitionActivity(state, "carnival-native", { type: "draw", count, choice: token }, ctx, wallet, () => 0);
    wallet = { points: wallet.points + next.pointsDelta, earned: wallet.earned, revision: wallet.revision + 1 }; state = next.state;
    value = advanceCarnivalGlobal(value, { characterId: alice, walletRevision: wallet.revision, draws: count,
      now: new Date(), eligibleParticipants: people }, () => 0).state;
  }
  await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=${wallet.points},"Revision"=${wallet.revision} WHERE "UserID"=${alice}`);
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${alice},'reference',${JSON.stringify(state)}::jsonb)`);
  await h.db.execute(sql`INSERT INTO app."CarnivalGlobalState" ("Key","State") VALUES ('native-v1',${JSON.stringify(value)}::jsonb)`);
}
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h); await migrateDb(h);
  const template: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "Material", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 9999,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  await h.db.insert(game.Shop_Goods).values(PRIZES.map(p => ({ ...template, TemplateID: p.templateId, Name: p.name })));
  await rebuild();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z")); notice.ids = [];
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS carnival_global_winner_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS carnival_global_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."CarnivalGlobalState",app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false`);
  for (const person of people) {
    await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (${person.characterId},${`global-${person.characterId}`},'test-only')`);
    await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
      VALUES (${person.characterId},${`global-${person.characterId}`},${person.nickName},true,'2000-01-01',1)`);
    await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${person.characterId},10000,40)`);
  }
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

describe("shared carnival through real account HTTP and isolated PGlite", () => {
  it("keeps missing-migration personal play usable, never runs DDL on GET or backfills earlier personal draws", async () => {
    await h.db.execute(sql`DROP TABLE app."CarnivalGlobalState"`);
    let legacy: Awaited<ReturnType<typeof draw>>;
    try {
      expect((await get()).nativeCarnival).toMatchObject({ globalMode: "personal-only", global: null });
      legacy = await draw(alice, 5);
      expect(legacy.result.nativeCarnival).toMatchObject({ globalMode: "personal-only", global: null, personalScore: 5 });
      expect(legacy.result.nativeCarnival.unavailable).toHaveLength(5);
      expect(legacy.result.nativeCarnivalAction!.worldEffects).toEqual([]);
      expect((await q1<{ Name: unknown }>(h, sql`SELECT to_regclass('app."CarnivalGlobalState"') AS "Name"`))!.Name).toBeNull();
    } finally {
      await h.db.execute(sql`CREATE TABLE app."CarnivalGlobalState" ("Key" varchar(32) PRIMARY KEY NOT NULL,"State" jsonb NOT NULL)`);
    }
    const initial = await get(); expect(initial.nativeCarnival).toMatchObject({ globalMode: "local-server", global: { totalDraws: 0 } });
    expect(await shared()).toBeUndefined();
    const replay = await post(alice, legacy!.action, legacy!.requestId); expect(replay.statusCode).toBe(200);
    expect(replay.json<ActivityResult>()).not.toHaveProperty("nativeCarnivalAction"); expect(await shared()).toBeUndefined();
    expect((await draw()).result.nativeCarnival).toMatchObject({ personalScore: 6, global: { totalDraws: 1, myRoundDraws: 1 } });
  });

  it("keeps GET and invalid/foreign requests pure and returns the empty shared era without creating a row", async () => {
    const before = await persisted(), first = await get();
    expect(first.nativeCarnival).toMatchObject({ globalMode: "local-server", global: { totalDraws: 0, roundId: 1, participantCount: 0 } });
    expect((await post(alice, { type: "draw", count: 6, choice: first.nativeCarnival.stateToken })).statusCode).toBe(400);
    const foreign = await built.app.inject({ url: `/api/account/activities?characterId=${bob}`, headers: headers(alice) });
    expect(foreign.statusCode).toBe(403); expect(await persisted()).toEqual(before); expect(notice.ids).toEqual([]);
  });

  it("refreshes another participant's committed rounds, pool and rank without advancing the reader or replaying rewards", async () => {
    await seed99(); const before = await get();
    expect(before.nativeCarnival.global).toMatchObject({ totalDraws: 99, roundId: 1, roundDraws: 99 });
    await draw(bob);
    const settled = await persisted(), notices = [...notice.ids], round = await get();
    expect(round.revision).toBe(before.revision);
    expect(round.nativeCarnival.personalScore).toBe(before.nativeCarnival.personalScore);
    expect(round.nativeCarnival.global).toMatchObject({ actorRevision: before.revision, totalDraws: 100,
      roundId: 2, roundDraws: 0, pool: { itemCount: 0 }, recentRounds: [{ roundId: 1, globalRevision: 100 }] });
    expect(round.nativeCarnival.ranking!.entries).toContainEqual({ rank: 2, characterId: bob, nickName: "Bob", score: 1 });
    expect(round).not.toHaveProperty("nativeCarnivalAction");
    expect(await persisted()).toEqual(settled); expect(notice.ids).toEqual(notices);
    await draw(bob, 2);
    const advanced = await persisted(), nextNotices = [...notice.ids], current = await get();
    expect(current.revision).toBe(before.revision);
    expect(current.nativeCarnival.global).toMatchObject({ actorRevision: before.revision, totalDraws: 102,
      roundId: 2, roundDraws: 2, pool: { itemCount: 2 }, myRoundDraws: 0 });
    expect(current.nativeCarnival.ranking!.entries).toContainEqual({ rank: 2, characterId: bob, nickName: "Bob", score: 3 });
    expect(current).not.toHaveProperty("nativeCarnivalAction");
    expect((await get()).nativeCarnival).toEqual(current.nativeCarnival);
    expect(await persisted()).toEqual(advanced); expect(notice.ids).toEqual(nextNotices);
  });

  it("settles two real participants into three bound material mails without changing another wallet", async () => {
    await seed99(); const aliceWallet = await q1(h, sql`SELECT * FROM app."ActivityWallet" WHERE "UserID"=${alice}`);
    const { result } = await draw(bob);
    expect(result.nativeCarnival.global).toMatchObject({ totalDraws: 100, roundId: 2, roundDraws: 0, participantCount: 0 });
    expect(result.nativeCarnivalAction!.worldEffects[0].awards.map(a => [a.slot, a.characterId, a.templateId, a.itemCount]))
      .toEqual([[0, alice, 11019, 100], [1, bob, 11021, 2], [2, alice, 11002, 2]]);
    expect(result.mailedCount).toBe(2); expect(notice.ids.sort()).toEqual([alice, bob]);
    expect(await q1(h, sql`SELECT * FROM app."ActivityWallet" WHERE "UserID"=${alice}`)).toEqual(aliceWallet);
    const items = await q<{ UserID: number; TemplateID: number; Count: number; IsBinds: boolean; ValidDate: number }>(h,
      sql`SELECT m."ReceiverID" AS "UserID",g."TemplateID",g."Count",g."IsBinds",g."ValidDate" FROM player."User_Messages" m
        JOIN player."Sys_Users_Goods" g ON g."ItemID"::text=ANY(ARRAY[m."Annex1",m."Annex2",m."Annex3",m."Annex4",m."Annex5"])
        ORDER BY m."ReceiverID",g."TemplateID"`);
    expect(items.map(i => [i.UserID, i.TemplateID, i.Count])).toEqual([[alice, 11002, 2], [alice, 11019, 100], [bob, 11019, 1], [bob, 11021, 2]]);
    expect(items.every(i => i.IsBinds && i.ValidDate === 0)).toBe(true);
    expect(JSON.stringify(result.nativeCarnival.global)).not.toMatch(/contributions|walletRevision|seed|eligible/);
  });

  it("rolls back ordinary/winner mail, shared round, wallet and receipt on winner or tail receipt failure, then retries one UUID", async () => {
    await seed99(); const choice = (await get(bob)).nativeCarnival.stateToken, action = { type: "draw", count: 1, choice }, requestId = randomUUID();
    const before = await persisted();
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT carnival_global_winner_failure CHECK ("ReceiverID"<>821) NOT VALID`);
    expect((await post(bob, action, requestId)).statusCode).toBe(500); expect(await persisted()).toEqual(before); expect(notice.ids).toEqual([]);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT carnival_global_winner_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT carnival_global_receipt_failure CHECK ("Signature"='never') NOT VALID`);
    expect((await post(bob, action, requestId)).statusCode).toBe(500); expect(await persisted()).toEqual(before); expect(notice.ids).toEqual([]);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT carnival_global_receipt_failure`);
    expect((await post(bob, action, requestId)).statusCode).toBe(200); expect((await shared())!.totalDraws).toBe(100);
  });

  it("rolls back an unsafe jackpot template and lets the same uncommitted UUID recover", async () => {
    await seed99(); const action = { type: "draw", count: 1, choice: (await get(bob)).nativeCarnival.stateToken }, requestId = randomUUID();
    const before = await persisted();
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11021`);
    expect((await post(bob, action, requestId)).statusCode).toBe(503); expect(await persisted()).toEqual(before); expect(notice.ids).toEqual([]);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11021`);
    expect((await post(bob, action, requestId)).statusCode).toBe(200);
  });

  it("replays after restart and a later round without another contribution, reward or fresh effects", async () => {
    await seed99(); const first = await draw(bob); await draw(alice, 3); const before = await persisted();
    await built.app.close(); await rebuild(); notice.ids = [];
    const replay = await post(bob, first.action, first.requestId); expect(replay.statusCode).toBe(200);
    const result = replay.json<ActivityResult>(); expect(result).toMatchObject({ replayed: true, mailedCount: first.result.mailedCount,
      nativeCarnival: { global: { totalDraws: 103, myRoundDraws: 0 } } });
    expect(result).not.toHaveProperty("nativeCarnivalAction"); expect(await persisted()).toEqual(before); expect(notice.ids).toEqual([]);
    expect((await post(bob, { ...first.action, count: 2 }, first.requestId)).statusCode).toBe(409); expect(await persisted()).toEqual(before);
  });

  it("excludes banned prior participants and delivers all three to the remaining real player", async () => {
    await seed99(); await h.db.execute(sql`UPDATE member."Accounts" SET "IsBanned"=true WHERE "ID"=${alice}`);
    const { result } = await draw(bob); const round = result.nativeCarnivalAction!.worldEffects[0];
    expect(round.participantCount).toBe(2); expect(round.awards.every(a => a.characterId === bob)).toBe(true);
    expect(notice.ids).toEqual([bob]);
  });

  it("preserves a real padded 50-character winner name in the completed round and reward mail", async () => {
    await seed99(); const nickName = " " + "名".repeat(48) + " ";
    await h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "NickName"=${nickName} WHERE "UserID"=${alice}`);
    const { result } = await draw(bob);
    const wins = result.nativeCarnivalAction!.worldEffects[0].awards.filter(a => a.characterId === alice);
    expect(wins).toHaveLength(2); expect(wins.every(a => a.nickName === nickName)).toBe(true);
    const mail = await q1<{ Receiver: string }>(h, sql`SELECT "Receiver" FROM player."User_Messages" WHERE "ReceiverID"=${alice}`);
    expect(mail!.Receiver).toBe(nickName);
  });

  it("withholds a mixed GET at the exact completed-round boundary even after current contributions are cleared", async () => {
    await seed99(); const old = await get(), action = { type: "draw", count: 1, choice: old.nativeCarnival.stateToken };
    const execute = h.db.execute.bind(h.db), dialect = new PgDialect(); let crossed = false;
    const spy = vi.spyOn(h.db, "execute").mockImplementation((...args) => {
      const statement = typeof args[0] === "string" ? args[0] : dialect.sqlToQuery(args[0].getSQL()).sql;
      const query = execute(...args);
      if (!crossed && statement.includes("to_regclass")) {
        crossed = true; const run = query.execute.bind(query);
        query.execute = async () => { expect((await post(alice, action)).statusCode).toBe(200); return run(); };
      }
      return query;
    });
    try {
      const result = await get(); expect(crossed).toBe(true); expect(result.revision).toBe(old.revision);
      expect(result.nativeCarnival).toMatchObject({ globalMode: "local-server", global: null });
    } finally { spy.mockRestore(); }
    expect((await shared())!.contributions).toEqual([]);
    expect((await get()).nativeCarnival.global).toMatchObject({ totalDraws: 100, roundId: 2 });
  });
});
