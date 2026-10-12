import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { game, player as playerSchema, seedDatabase } from "@ddt/db";
import type { GameServer } from "../src/server.js";
import type { ServerContext } from "../src/session/context.js";
import { EventScheduler, nextStart, occurrenceAt, rateOf, windowsAt, type ScheduledEvent } from "../src/game/scheduler.js";
import { claimOnce, EventData } from "../src/game/events.js";
import type { GamePlayer } from "../src/game/player.js";
import { eventsRuntime, weeklyReset, worldBossDamage } from "../src/handlers/events.js";
import { quitPlayer } from "../src/session/login.js";
import { createCharacter, FakeClient, loggedIn, sharedDb, startServer } from "./helpers.js";

const ev = (o: Partial<ScheduledEvent>): ScheduledEvent => ({
  id: 1, kind: "worldboss", title: "", enabled: true, weekdays: "0,1,2,3,4,5,6", startTime: "12:00", durationMin: 30,
  startDate: null, endDate: null, params: {}, ...o,
});

describe("EventScheduler windows", () => {
  it("opens daily windows at HH:MM UTC for durationMin", () => {
    const e = ev({});
    expect(occurrenceAt(e, new Date("2026-10-02T11:59:59Z"))).toBeNull();
    const w = occurrenceAt(e, new Date("2026-10-02T12:10:00Z"))!;
    expect(w.start.toISOString()).toBe("2026-10-02T12:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-02T12:30:00.000Z");
    expect(occurrenceAt(e, new Date("2026-10-02T12:30:00Z"))).toBeNull();
  });
  it("respects weekdays, midnight crossing, date range and enabled", () => {
    // 2026-10-03 is a Saturday (6)
    const sat = ev({ weekdays: "6", startTime: "23:00", durationMin: 120 });
    expect(occurrenceAt(sat, new Date("2026-10-04T00:30:00Z"))?.start.toISOString()).toBe("2026-10-03T23:00:00.000Z");
    expect(occurrenceAt(sat, new Date("2026-10-02T23:30:00Z"))).toBeNull(); // Friday
    expect(occurrenceAt({ ...sat, enabled: false }, new Date("2026-10-03T23:30:00Z"))).toBeNull();
    expect(occurrenceAt({ ...sat, endDate: new Date("2026-10-03T00:00:00Z") }, new Date("2026-10-03T23:30:00Z"))).toBeNull();
    expect(nextStart(sat, new Date("2026-10-02T10:00:00Z"))?.toISOString()).toBe("2026-10-03T23:00:00.000Z");
  });
  it("double exp/gold rate = max of open windows", () => {
    const now = new Date("2026-10-04T10:00:00Z"); // Sunday
    const open = windowsAt([ev({ id: 2, kind: "double_exp", weekdays: "0", startTime: "00:00", durationMin: 1440, params: { rate: 3 } }), ev({ id: 3, kind: "double_exp", weekdays: "0", startTime: "09:00", durationMin: 120, params: { rate: 2 } })], now);
    expect(rateOf(open, "double_exp")).toBe(3);
    expect(rateOf(open, "double_gold")).toBe(1);
  });
  it("fires start once and end once per occurrence; force/stop", async () => {
    let now = new Date("2026-10-02T11:59:00Z");
    const log: string[] = [];
    const s = new EventScheduler(() => now, { onStart: (w) => void log.push(`start ${w.ev.kind}`), onEnd: (w) => void log.push(`end ${w.ev.kind}`) });
    s.setEvents([ev({})]);
    await s.tick();
    now = new Date("2026-10-02T12:00:00Z");
    await s.tick();
    await s.tick();
    now = new Date("2026-10-02T12:31:00Z");
    await s.tick();
    expect(log).toEqual(["start worldboss", "end worldboss"]);
    s.force("league", 10);
    await s.tick();
    expect(s.isOpen("league")).toBeTruthy();
    s.stop("league");
    await s.tick();
    expect(s.isOpen("league")).toBeUndefined();
    expect(log.slice(2)).toEqual(["start league", "end league"]);
  });
});

let server: GameServer;
let ctx: ServerContext;
beforeAll(async () => {
  // sharedDb is always pglite:memory; never seed or truncate a configured runtime database.
  const h = await sharedDb();
  await seedDatabase(h, { only: ["User_Box", "LoadUserBox", "Shop_Goods_Box"] });
  server = await startServer();
  ctx = (server as unknown as { ctx: ServerContext }).ctx;
  await h.db.delete(game.Daily_Award);
  await h.db.insert(game.Daily_Award).values([
    { ID: 9001, Type: 1, TemplateID: -100, Count: 500, ValidDate: 0, IsBinds: true, Sex: 0, AwardDays: 3, GetWay: 0 },
    { ID: 9002, Type: 7, TemplateID: -1100, Count: 100, ValidDate: 0, IsBinds: true, Sex: 0, AwardDays: 3, GetWay: 0 },
  ] as never);
  await h.db.insert(game.Achievement).values({ ID: 99001, PlaceID: 1, Title: "Lv5", Detail: "", NeedMinLevel: 0, NeedMaxLevel: 100, PreAchievementID: "0,", IsOther: 0, AchievementType: 1, CanHide: false, StartDate: new Date("2000-01-01"), EndDate: new Date("2100-01-01"), AchievementPoint: 10, IsActive: 1, PicID: 1, IsShare: false } as never).onConflictDoNothing();
  await h.db.insert(game.AchievementCondition).values({ AchievementID: 99001, CondictionID: 1, CondictionType: 10, Condiction_Para1: "0", Condiction_Para2: 5 } as never).onConflictDoNothing();
  await h.db.insert(game.Achievement).values({ ID: 99002, PlaceID: 1, Title: "Lv90", Detail: "", NeedMinLevel: 0, NeedMaxLevel: 100, PreAchievementID: "0,", IsOther: 0, AchievementType: 1, CanHide: false, StartDate: new Date("2000-01-01"), EndDate: new Date("2100-01-01"), AchievementPoint: 10, IsActive: 1, PicID: 1, IsShare: false } as never).onConflictDoNothing();
  await h.db.insert(game.AchievementCondition).values({ AchievementID: 99002, CondictionID: 1, CondictionType: 10, Condiction_Para1: "0", Condiction_Para2: 90 } as never).onConflictDoNothing();
  await eventsRuntime(ctx).reload();
});
afterAll(async () => {
  await server.stop();
});

describe("event claims (idempotency)", () => {
  it("claimOnce lets exactly one of N concurrent claims win", async () => {
    const h = await sharedDb();
    const res = await Promise.all(Array.from({ length: 8 }, () => claimOnce(h.db, 424242, "test", "k1")));
    expect(res.filter(Boolean)).toHaveLength(1);
  });

  it("13/5 signs once a day, 90 pays a reached tier once a month", async () => {
    const { c, ch: p } = await loggedIn(server, { gold: 0 });
    const h = await sharedDb();
    // three earlier sign-ins this month (+ today = 4 >= tier 3)
    const now = new Date();
    const d = now.getUTCDate();
    const days = Array.from({ length: d - 1 }, (_, i) => (i < 3 ? "True" : "False"));
    await h.db.execute(sql`DELETE FROM player."DailyLogList" WHERE "UserID" = ${p.userId}`);
    await h.db.execute(sql`INSERT INTO player."DailyLogList" ("UserID","UserAwardLog","DayLog","LastDate") VALUES (${p.userId}, 3, ${days.join(",")}, ${now})`);
    for (let i = 0; i < 3; i++) c.out(13, (o) => o.writeInt(5));
    await new Promise((r) => setTimeout(r, 400));
    const [row] = ((await h.db.execute(sql`SELECT "DayLog" FROM player."DailyLogList" WHERE "UserID" = ${p.userId}`)) as unknown as { rows: { DayLog: string }[] }).rows;
    expect(row!.DayLog.split(",").filter((x) => x === "True")).toHaveLength(d >= 4 ? 4 : Math.min(d, 4));
    const gp = ctx.world.get(p.userId)!;
    const g0 = gp.info.GiftToken;
    for (let i = 0; i < 3; i++) c.out(90, (o) => o.writeInt(3));
    await new Promise((r) => setTimeout(r, 400));
    if (d >= 3) {
      expect(gp.info.Gold).toBe(500);
      expect(gp.info.GiftToken - g0).toBe(100);
    }
    c.out(90, (o) => o.writeInt(18)); // tier not configured / not reached
    await new Promise((r) => setTimeout(r, 200));
    expect(gp.info.Gold).toBe(d >= 3 ? 500 : 0);
    c.close();
  });

  it("13/0 daily award once per day", async () => {
    const { c, ch: p } = await loggedIn(server);
    const gp = ctx.world.get(p.userId)!;
    const before = gp.info.DayLoginCount ?? 0;
    for (let i = 0; i < 3; i++) { c.out(13, (o) => o.writeInt(0)); await new Promise((r) => setTimeout(r, 550)); }
    expect((gp.info.DayLoginCount ?? 0) - before).toBe(1);
    c.close();
  });

  it("230 only completes achievements whose records are reached, once", async () => {
    const { c, ch: p } = await loggedIn(server, { grade: 10 });
    await c.code(228);
    let m = c.mark();
    c.out(230, (o) => o.writeInt(99002)); // needs level 90
    c.out(230, (o) => o.writeInt(99001));
    c.out(230, (o) => o.writeInt(99001));
    const r = await c.code(230, undefined, m);
    expect(r.pkt.readInt()).toBe(99001);
    await new Promise((res) => setTimeout(res, 300));
    expect(c.received.slice(m).filter((x) => x.code === 230)).toHaveLength(1);
    expect(ctx.world.get(p.userId)!.info.AchievementPoint).toBe(10);
    m = c.mark();
    c.close();
  });

  it("weekly reset runs once per window; world boss ranking rewards once", async () => {
    const h = await sharedDb();
    expect(await weeklyReset(ctx, "test-week")).toBe(true);
    expect(await weeklyReset(ctx, "test-week")).toBe(false);
    void h;
    const { c, ch: p } = await loggedIn(server);
    const rt = eventsRuntime(ctx);
    rt.scheduler.setEvents([{ id: 77, kind: "worldboss", title: "t", enabled: false, weekdays: "", startTime: "00:00", durationMin: 1, startDate: null, endDate: null, params: { bossHp: 1000, rankAwards: [{ rank: 1, giftToken: 50 }] } }]);
    rt.scheduler.force("worldboss", 5);
    await rt.scheduler.tick();
    expect(rt.boss.window).toBeTruthy();
    const gp = ctx.world.get(p.userId)!;
    const g0 = gp.info.GiftToken;
    worldBossDamage(ctx, gp, 300);
    expect(rt.boss.blood).toBe(700);
    rt.scheduler.stop("worldboss");
    await rt.scheduler.tick();
    await rt.scheduler.tick();
    expect(rt.boss.window).toBeNull();
    expect(gp.info.GiftToken - g0).toBe(50);
    c.close();
  });
});

const onlineBoxes = [
  { ID: 1, Condition: 15, TemplateID: 1120090, rewards: [11001, 11005, 11009, 11013] },
  { ID: 2, Condition: 40, TemplateID: 1120091, rewards: [11002, 11006, 11010, 11014] },
  { ID: 3, Condition: 60, TemplateID: 1120092, rewards: [11003, 11007, 11011, 11015] },
  { ID: 4, Condition: 75, TemplateID: 1120093, rewards: [11233] },
];
const onlineRewardIds = new Set(onlineBoxes.flatMap((b) => b.rewards));
const rewardSnapshot = (p: GamePlayer) => p.allBags().flatMap((b) => b.getItems()).filter((i) => onlineRewardIds.has(i.TemplateID))
  .map((i) => ({ templateId: i.TemplateID, count: i.Count, bound: i.IsBinds, days: i.ValidDate, strengthen: i.StrengthenLevel,
    compose: [i.AttackCompose, i.DefendCompose, i.AgilityCompose, i.LuckCompose] }))
  .sort((a, b) => a.templateId - b.templateId);
const expectedRewards = (tiers: number, count = 1) => onlineBoxes.slice(0, tiers).flatMap((b) => b.rewards)
  .map((templateId) => ({ templateId, count, bound: true, days: 0, strengthen: 0, compose: [0, 0, 0, 0] }))
  .sort((a, b) => a.templateId - b.templateId);

async function requestOnlineBox(c: FakeClient) {
  const from = c.mark();
  c.out(53, (o) => { o.writeInt(1); o.writeInt(0); });
  const r = await c.code(53, undefined, from);
  expect(r.pkt.readInt()).toBe(1);
  expect(r.pkt.readInt()).toBe(0);
  return { ok: r.pkt.readBoolean(), progression: r.pkt.readInt() };
}

async function timeBoxLogin(grade: number) {
  const h = await sharedDb(), ch = await createCharacter(h, { grade });
  // The schema defaults ForbidDate to wall-clock now; fixed test clocks must explicitly start unbanned.
  await h.db.update(playerSchema.Sys_Users_Detail).set({ ForbidDate: new Date("2000-01-01T00:00:00Z") }).where(eq(playerSchema.Sys_Users_Detail.UserID, ch.userId));
  const c = FakeClient.memory(server);
  c.login(ch.user, ch.pass); await c.code(95);
  return { c, ch, player: () => ctx.world.get(ch.userId)! };
}

describe("online boxes from the committed User_Box seed", () => {
  it("loads the four original online identities in ID order while preserving every level/VIP row", async () => {
    const h = await sharedDb();
    const legacy = (await h.db.select().from(game.LoadUserBox)).sort((a, b) => a.ID - b.ID);
    const original = (await h.db.select().from(game.User_Box)).sort((a, b) => a.ID - b.ID);
    expect(legacy.filter((b) => b.Type === 0).map((b) => b.Condition)).toEqual([15, 40, 60, 60]);
    // Reinsert the actual seed rows backwards to exercise the loader's ordering, only in this memory DB.
    const online = original.filter((b) => b.Type === 0);
    await h.db.delete(game.User_Box).where(eq(game.User_Box.Type, 0));
    await h.db.insert(game.User_Box).values([...online].reverse());
    const data = await new EventData().load(h.db);
    expect(data.userBox.filter((b) => b.Type === 0)).toEqual(onlineBoxes.map(({ ID, Condition, TemplateID }) => ({ ID, Type: 0, Level: 60, Condition, TemplateID })));
    expect(data.userBox.filter((b) => b.Type !== 0)).toEqual(legacy.filter((b) => b.Type !== 0));
    expect(data.userBox.map((b) => b.ID)).toEqual(data.userBox.map((b) => b.ID).sort((a, b) => a - b));
    for (const box of onlineBoxes) {
      const pool = ctx.templates.itemBoxes.get(box.TemplateID)!;
      expect(pool.map((r) => r.TemplateId).sort((a, b) => a - b)).toEqual(box.rewards);
      for (const row of pool) {
        expect(ctx.templates.findItem(row.TemplateId)).toBeDefined();
        expect([row.IsSelect, row.IsBind, row.ItemCount, row.ItemValid, row.StrengthenLevel]).toEqual([true, true, 1, 0, 0]);
        expect([row.AttackCompose, row.DefendCompose, row.AgilityCompose, row.LuckCompose]).toEqual([0, 0, 0, 0]);
      }
    }
    // Loading templates never rewrites either source table.
    expect((await h.db.select().from(game.LoadUserBox)).sort((a, b) => a.ID - b.ID)).toEqual(legacy);
    expect((await h.db.select().from(game.User_Box)).sort((a, b) => a.ID - b.ID)).toEqual(original);
  });

  it("rejects early reports, grants all four exact pools, rejects a fifth, saves across relogin and resets next day", async () => {
    const realNow = ctx.now;
    let now = new Date("2026-10-12T00:00:00Z");
    ctx.now = () => new Date(now);
    const logged = await timeBoxLogin(9);
    let c = logged.c;
    const player = () => ctx.world.get(logged.ch.userId)!;
    const relogin = async () => {
      await quitPlayer(ctx, player()); c.close();
      c = FakeClient.memory(server); c.login(logged.ch.user, logged.ch.pass); await c.code(95);
    };
    try {
      const money = [player().info.Gold, player().info.Money, player().info.GiftToken, player().info.GP];
      c.out(53, (o) => { o.writeInt(0); o.writeInt(999999); }); // client minutes never earn a box
      expect(await requestOnlineBox(c)).toEqual({ ok: false, progression: 0 });
      expect(rewardSnapshot(player())).toEqual([]);
      for (const [index, box] of onlineBoxes.entries()) {
        now = new Date(now.getTime() + (box.Condition - 1) * 60_000);
        expect(await requestOnlineBox(c)).toEqual({ ok: false, progression: index ? onlineBoxes[index - 1].Condition : 0 });
        expect(rewardSnapshot(player())).toEqual(expectedRewards(index));
        now = new Date(now.getTime() + 60_000);
        expect(await requestOnlineBox(c)).toEqual({ ok: true, progression: box.Condition });
        expect(rewardSnapshot(player())).toEqual(expectedRewards(index + 1));
        expect(await requestOnlineBox(c)).toEqual({ ok: false, progression: box.Condition });
      }
      // These are waits since login/last claim: 15+40+60+75 minutes, not cumulative 75 minutes.
      expect(now.toISOString()).toBe("2026-10-12T03:10:00.000Z");
      now = new Date(now.getTime() + 120 * 60_000);
      expect(await requestOnlineBox(c)).toEqual({ ok: false, progression: 75 });
      const saved = rewardSnapshot(player());
      await relogin();
      expect(player().info.BoxProgression).toBe(75);
      expect(rewardSnapshot(player())).toEqual(saved);
      expect(await requestOnlineBox(c)).toEqual({ ok: false, progression: 75 });
      expect([player().info.Gold, player().info.Money, player().info.GiftToken, player().info.GP]).toEqual(money);
      now = new Date("2026-10-13T00:00:00Z");
      await relogin();
      expect(player().info.BoxProgression).toBe(0);
      expect(await requestOnlineBox(c)).toEqual({ ok: false, progression: 0 });
      now = new Date(now.getTime() + 15 * 60_000);
      expect(await requestOnlineBox(c)).toEqual({ ok: true, progression: 15 });
      const expected = expectedRewards(4).map((r) => ({ ...r, count: onlineBoxes[0].rewards.includes(r.templateId) ? 2 : 1 }));
      expect(rewardSnapshot(player())).toEqual(expected);
    } finally {
      if (ctx.world.get(logged.ch.userId)) await quitPlayer(ctx, player());
      c.close(); ctx.now = realNow;
    }
  });

  it("keeps characters independent and a burst of duplicate packets delivers the next tier only once", async () => {
    const realNow = ctx.now;
    let now = new Date("2026-10-14T00:00:00Z"); ctx.now = () => new Date(now);
    const a = await timeBoxLogin(9), b = await timeBoxLogin(9);
    try {
      now = new Date(now.getTime() + 15 * 60_000);
      expect(await requestOnlineBox(a.c)).toEqual({ ok: true, progression: 15 });
      expect(rewardSnapshot(b.player())).toEqual([]);
      expect(b.player().info.BoxProgression).toBe(0);
      expect(await requestOnlineBox(b.c)).toEqual({ ok: true, progression: 15 });
      expect(rewardSnapshot(b.player())).toEqual(expectedRewards(1));
      now = new Date(now.getTime() + 40 * 60_000);
      let from = a.c.mark();
      for (let i = 0; i < 8; i++) a.c.out(53, (o) => { o.writeInt(1); o.writeInt(0); });
      const accepted: boolean[] = [];
      for (let i = 0; i < 8; i++) {
        const r = await a.c.code(53, undefined, from); from = a.c.received.indexOf(r) + 1;
        expect(r.pkt.readInt()).toBe(1); expect(r.pkt.readInt()).toBe(0);
        accepted.push(r.pkt.readBoolean()); expect(r.pkt.readInt()).toBe(40);
      }
      expect(accepted.filter(Boolean)).toHaveLength(1);
      expect(rewardSnapshot(a.player())).toEqual(expectedRewards(2));
      expect(b.player().info.BoxProgression).toBe(15);
      expect(rewardSnapshot(b.player())).toEqual(expectedRewards(1));
    } finally {
      for (const logged of [a, b]) { if (logged.player()) await quitPlayer(ctx, logged.player()); logged.c.close(); }
      ctx.now = realNow;
    }
  });

  it.each([1, 60, 61])("keeps the original online level boundary at grade %i", async (grade) => {
    const realNow = ctx.now;
    let now = new Date("2026-10-15T00:00:00Z"); ctx.now = () => new Date(now);
    const logged = await timeBoxLogin(grade);
    try {
      now = new Date(now.getTime() + 15 * 60_000);
      expect(await requestOnlineBox(logged.c)).toEqual({ ok: grade <= 60, progression: grade <= 60 ? 15 : 0 });
      expect(rewardSnapshot(logged.player())).toEqual(expectedRewards(grade <= 60 ? 1 : 0));
    } finally {
      if (logged.player()) await quitPlayer(ctx, logged.player()); logged.c.close(); ctx.now = realNow;
    }
  });
});
