import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { player, type Database, type DbHandle } from "@ddt/db";
import { awardWorldBoss } from "../src/game/world-boss-rewards.js";
import { hasClaim } from "../src/game/events.js";
import * as characters from "../src/db/characters.js";
import type { GameServer } from "../src/server.js";
import { quitPlayer } from "../src/session/login.js";
import { createCharacter, FakeClient, sharedDb, startServer } from "./helpers.js";

// Real RSA/rolling-codec login and loadPlayer initialization, isolated PGlite.
let server: GameServer, db: DbHandle;
beforeAll(async () => { db = await sharedDb(); server = await startServer(); });
afterEach(async () => {
  vi.restoreAllMocks(); server.ctx.db = db;
  await db.db.execute(sql`DROP TRIGGER IF EXISTS test_boss_login_failure ON app."EventClaims"`);
  await db.db.execute(sql`DROP FUNCTION IF EXISTS app.test_boss_login_failure()`);
  for (const p of server.ctx.world.all()) await quitPlayer(server.ctx, p);
});
afterAll(async () => { await server.stop(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error("login boundary timeout"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

describe("offline world-boss award versus login admission", () => {
  it.each([false, true])("holds the actual login snapshot until offline transaction returns (SQL failure=%s)", async (fail) => {
    const ch = await createCharacter(db), entered = deferred(), release = deferred(), key = `admission-${ch.userId}`;
    const initial = (await characters.loadPlayerInfo(db.db, ch.userId))!.GiftToken;
    if (fail) {
      await db.db.execute(sql`CREATE FUNCTION app.test_boss_login_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boss SQL failure'; END; $$`);
      await db.db.execute(sql`CREATE TRIGGER test_boss_login_failure BEFORE INSERT ON app."EventClaims" FOR EACH ROW EXECUTE FUNCTION app.test_boss_login_failure()`);
    }
    server.ctx.db = { ...db, db: new Proxy(db.db, { get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      return async (work: (tx: Database) => Promise<unknown>) => {
        let result: unknown, failure: unknown;
        try { result = await target.transaction((tx) => work(tx as unknown as Database)); } catch (error) { failure = error; }
        entered.resolve(); await release.promise; if (failure) throw failure; return result;
      };
    } }) as Database };
    const awarding = awardWorldBoss(server.ctx, ch.userId, key, [{ templateId: -1100, count: 9 }], "test");
    const outcome = awarding.then(() => null, (error) => error); await entered.promise;
    const load = vi.spyOn(characters, "loadPlayerInfo"), c = FakeClient.memory(server); c.login(ch.user, ch.pass);
    await waitFor(() => server.ctx.world.loggingIn.has(ch.user.toLowerCase()));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(load).not.toHaveBeenCalled(); expect(server.ctx.world.get(ch.userId)).toBeUndefined();
    release.resolve(); const error = await outcome; expect(!!error).toBe(fail); await c.code(95);
    const p = server.ctx.world.get(ch.userId)!; expect(p.info.GiftToken).toBe(initial + (fail ? 0 : 9));
    expect(await hasClaim(db.db, ch.userId, "worldboss", key)).toBe(!fail);
    await p.saveIntoDatabase(db.db); expect((await characters.loadPlayerInfo(db.db, ch.userId))!.GiftToken).toBe(p.info.GiftToken);
    c.close();
  });
  it("lets in-progress loadPlayer initialize before the award rechecks online ownership", async () => {
    const ch = await createCharacter(db), entered = deferred(), release = deferred(), key = `load-first-${ch.userId}`;
    const original = characters.loadPlayerInfo;
    const initial = (await original(db.db, ch.userId))!.GiftToken;
    vi.spyOn(characters, "loadPlayerInfo").mockImplementationOnce(async (connection, id) => {
      entered.resolve(); await release.promise; return original(connection, id);
    });
    const c = FakeClient.memory(server); c.login(ch.user, ch.pass); await entered.promise;
    const awarding = awardWorldBoss(server.ctx, ch.userId, key, [{ templateId: -1100, count: 9 }], "test");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await hasClaim(db.db, ch.userId, "worldboss", key)).toBe(false); expect(server.ctx.world.get(ch.userId)).toBeUndefined();
    release.resolve(); await c.code(95); await awarding;
    const p = server.ctx.world.get(ch.userId)!; expect(p.info.GiftToken).toBe(initial + 9);
    await p.saveIntoDatabase(db.db);
    expect((await db.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, ch.userId)))[0]!.GiftToken).toBe(initial + 9);
    c.close();
  });
});
