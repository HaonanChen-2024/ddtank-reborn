import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { signIn } from "../src/handlers/events.js";
import { hasClaim } from "../src/game/events.js";
import type { GamePlayer } from "../src/game/player.js";
import type { ServerContext } from "../src/session/context.js";

// Persistence integration tests: real transactions/triggers in a fresh in-memory DB, never the runtime DB.
let h: DbHandle;
let sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterEach(async () => {
  await h.db.execute(sql`DROP TRIGGER IF EXISTS test_sign_log_failure ON player."DailyLogList"`);
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_sign_log_failure()`);
});
afterAll(async () => { await h.close(); });

async function character() {
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({
    UserName: `atomic_sign_${++sequence}`, NickName: `Sign ${sequence}`, Password: "test", Sex: true, IsFirst: 1,
  }).returning({ id: player.Sys_Users_Detail.UserID });
  return { id: row!.id } as GamePlayer;
}
const context = (date: string) => ({ db: h, now: () => new Date(date) }) as ServerContext;
const calendar = (p: GamePlayer) => h.db.select().from(player.DailyLogList).where(eq(player.DailyLogList.UserID, p.id));
async function rejectCalendarWrites() {
  await h.db.execute(sql`CREATE FUNCTION player.test_sign_log_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected calendar write failure'; END; $$`);
  await h.db.execute(sql`CREATE TRIGGER test_sign_log_failure BEFORE INSERT OR UPDATE ON player."DailyLogList"
    FOR EACH ROW EXECUTE FUNCTION player.test_sign_log_failure()`);
}

describe("sign-in claim and calendar atomicity", () => {
  it("rolls back a first sign when the calendar insert fails, then permits retry", async () => {
    const p = await character(), ctx = context("2026-10-13T01:00:00Z");
    await rejectCalendarWrites();
    await expect(signIn(ctx, p)).rejects.toMatchObject({ cause: { message: "injected calendar write failure" } });
    expect(await hasClaim(h.db, p.id, "sign", "2026-10-13")).toBe(false);
    expect(await calendar(p)).toEqual([]);
    await h.db.execute(sql`DROP TRIGGER test_sign_log_failure ON player."DailyLogList"`);
    expect(await signIn(ctx, p)).toBe(true);
    const [row] = await calendar(p);
    expect(row!.DayLog!.split(",").filter((x) => x === "True")).toHaveLength(1);
    expect(row!.UserAwardLog).toBe(1);
  });

  it("preserves the previous calendar and releases today's claim when an update fails", async () => {
    const p = await character();
    expect(await signIn(context("2026-10-12T01:00:00Z"), p)).toBe(true);
    const before = await calendar(p);
    await rejectCalendarWrites();
    await expect(signIn(context("2026-10-13T01:00:00Z"), p)).rejects.toMatchObject({ cause: { message: "injected calendar write failure" } });
    expect(await calendar(p)).toEqual(before);
    expect(await hasClaim(h.db, p.id, "sign", "2026-10-12")).toBe(true);
    expect(await hasClaim(h.db, p.id, "sign", "2026-10-13")).toBe(false);
    await h.db.execute(sql`DROP TRIGGER test_sign_log_failure ON player."DailyLogList"`);
    expect(await signIn(context("2026-10-13T01:00:00Z"), p)).toBe(true);
    expect((await calendar(p))[0]!.UserAwardLog).toBe(2);
  });

  it("commits only one calendar row for concurrent duplicate requests and keeps another player separate", async () => {
    const p = await character(), other = await character(), ctx = context("2026-10-13T01:00:00Z");
    const results = await Promise.all(Array.from({ length: 8 }, () => signIn(ctx, p)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await calendar(p)).toHaveLength(1);
    expect((await calendar(p))[0]!.UserAwardLog).toBe(1);
    expect(await calendar(other)).toEqual([]);
    expect(await signIn(ctx, other)).toBe(true);
    expect(await signIn(ctx, p)).toBe(false);
  });

  it("retains both days across midnight and resets the calendar at the next month", async () => {
    const p = await character();
    expect(await Promise.all([
      signIn(context("2026-10-30T23:59:59Z"), p),
      signIn(context("2026-10-31T00:00:01Z"), p),
    ])).toEqual([true, true]);
    expect((await calendar(p))[0]!.UserAwardLog).toBe(2);
    expect(await signIn(context("2026-11-01T00:00:01Z"), p)).toBe(true);
    const [row] = await calendar(p);
    expect(row!.DayLog).toBe("True");
    expect(row!.UserAwardLog).toBe(1);
    expect(await hasClaim(h.db, p.id, "sign", "2026-10-30")).toBe(true);
  });

  it("does not create claim or calendar records without a character owner", async () => {
    const p = { id: 2147483647 } as GamePlayer;
    expect(await signIn(context("2026-10-13T01:00:00Z"), p)).toBe(false);
    expect(await calendar(p)).toEqual([]);
    expect(await hasClaim(h.db, p.id, "sign", "2026-10-13")).toBe(false);
  });
});
