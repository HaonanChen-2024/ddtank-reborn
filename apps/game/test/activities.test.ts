import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { game, player } from "@ddt/db";
import type { GameServer } from "../src/server.js";
import type { ServerContext } from "../src/session/context.js";
import { eventsRuntime } from "../src/handlers/events.js";
import { drawDistinct, labyrinthTryAgainMoney, luckyDraw, pickLotteryBoard, type Card, type LabyrinthRow } from "../src/handlers/activities.js";
import { loggedIn, sharedDb, startServer } from "./helpers.js";

let server: GameServer;
let ctx: ServerContext;
beforeAll(async () => { server = await startServer(); ctx = (server as unknown as { ctx: ServerContext }).ctx; });
afterAll(async () => { await server.stop(); });

describe("caddy/lottery pure helpers", () => {
  it("pickLotteryBoard: always 18 slots, dedups by (template,count), samples with repeats if the pool is small", () => {
    const rows = [1, 2, 3].map((i) => ({ ID: 1, TemplateId: i, IsSelect: false, IsBind: true, ItemValid: 0, ItemCount: 1, StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, AgilityCompose: 0, LuckCompose: 0, Random: 100, IsTips: 0, IsLogs: false }));
    const board = pickLotteryBoard(rows as never, () => 0.5);
    expect(board).toHaveLength(18);
    expect(board.every((r) => [1, 2, 3].includes(r.TemplateId))).toBe(true);
  });

  it("drawDistinct: never repeats a templateId while the pool has unused ones", () => {
    const pool = [{ templateId: 1, count: 1 }, { templateId: 2, count: 1 }, { templateId: 3, count: 1 }, { templateId: 4, count: 1 }];
    const cards = drawDistinct(pool, 4);
    expect(new Set(cards.map((c) => c.templateId)).size).toBe(4);
    cards.forEach((c, i) => expect(c.position).toBe(i));
  });

  it("luckyDraw: weighted pick stays within the board, coin slot re-rolls ~97% of the time", () => {
    const rewards: Card[] = [
      { templateId: 201193, count: 1, strengthenLevel: 0, validDate: 0, atk: 0, def: 0, agi: 0, luck: 0, position: 0, isSelected: false, isSeeded: false, isBind: true, weight: 10000 },
      { templateId: 99, count: 1, strengthenLevel: 0, validDate: 0, atk: 0, def: 0, agi: 0, luck: 0, position: 1, isSelected: false, isSeeded: false, isBind: true, weight: 1 },
    ];
    let sawOther = false;
    for (let i = 0; i < 50; i++) if (luckyDraw({ rewards, award: null, lastTurn: 0, coins: 500 }).templateId === 99) sawOther = true;
    expect(sawOther).toBe(true); // the coin-reroll rule must occasionally land on the only other slot
  });
});

describe("131 LABYRINTH economy", () => {
  it.each([false, true])("131 sub 2 uses the original client field order and exact body length (invert=%s)", async invert => {
    const { c, ch: p, player: getPlayer } = await loggedIn(server, { grade: 10 });
    try {
      const h = await sharedDb();
      const row: LabyrinthRow = {
        UserID: p.userId, myProgress: 17, myRanking: 29, completeChallenge: !invert,
        isDoubleAward: invert, currentFloor: 3, accumulateExp: 53, remainTime: 41,
        currentRemainTime: 97, cleanOutAllTime: 67, cleanOutGold: 79,
        tryAgainComplete: invert, isInGame: !invert, isCleanOut: invert,
        serverMultiplyingPower: !invert, LastDate: ctx.now(), ProcessAward: "-1",
      };
      await h.db.insert(player.Sys_Users_Labyrinth).values(row);
      expect(getPlayer().propBag.getItemByTemplateID(0, 11916)).toBeNull();
      const mark = c.mark();
      // No labyrinth stone: this branch replies without changing the stored fields.
      c.out(131, o => { o.writeInt(1); o.writeBoolean(false); });
      const response = await c.code(131, 2, mark);
      const [stored] = await h.db.select().from(player.Sys_Users_Labyrinth).where(eq(player.Sys_Users_Labyrinth.UserID, p.userId));
      expect(stored).toEqual(row);
      const pkt = response.pkt;
      expect(pkt.readByte()).toBe(2);
      // Original LabyrinthManager reader / SendLabyrinthUpdataInfo: seven ints and five booleans.
      const actual = {
        myProgress: pkt.readInt(), currentFloor: pkt.readInt(), completeChallenge: pkt.readBoolean(),
        remainTime: pkt.readInt(), accumulateExp: pkt.readInt(), cleanOutAllTime: pkt.readInt(),
        cleanOutGold: pkt.readInt(), myRanking: pkt.readInt(), isDoubleAward: pkt.readBoolean(),
        isInGame: pkt.readBoolean(), isCleanOut: pkt.readBoolean(), serverMultiplyingPower: pkt.readBoolean(),
      };
      expect.soft(pkt.length).toBe(54); // 20-byte header + subtype + 33-byte public body.
      expect(actual).toEqual({
        myProgress: row.myProgress, currentFloor: row.currentFloor, completeChallenge: row.completeChallenge,
        remainTime: row.remainTime, accumulateExp: row.accumulateExp, cleanOutAllTime: row.cleanOutAllTime,
        cleanOutGold: row.cleanOutGold, myRanking: row.myRanking, isDoubleAward: row.isDoubleAward,
        isInGame: row.isInGame, isCleanOut: row.isCleanOut, serverMultiplyingPower: row.serverMultiplyingPower,
      });
      expect(pkt.offset).toBe(pkt.length);
      expect(pkt.dataLeft).toBe(0);
    } finally { c.close(); }
  });

  it("labyrinthTryAgainMoney: price big every even checkpoint floor below myProgress, else small", () => {
    eventsRuntime(ctx).scheduler.setEvents([{ id: 1, kind: "labyrinth", title: "", enabled: true, weekdays: "", startTime: "00:00", durationMin: 0, startDate: null, endDate: null, params: { priceBig: 5000, priceSmall: 1000 } }]);
    const row = (currentFloor: number, myProgress: number): LabyrinthRow => ({ UserID: 1, myProgress, myRanking: 0, completeChallenge: false, isDoubleAward: false, currentFloor, accumulateExp: 0, remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0, cleanOutGold: 0, tryAgainComplete: false, isInGame: false, isCleanOut: false, serverMultiplyingPower: false, LastDate: new Date(), ProcessAward: "-1" });
    expect(labyrinthTryAgainMoney(ctx, row(0, 5))).toBe(5000);
    expect(labyrinthTryAgainMoney(ctx, row(1, 5))).toBe(1000);
    eventsRuntime(ctx).scheduler.setEvents([]);
  });

  it("131 sub 3 CLEAN_OUT: starts a paid countdown without advancing floors or paying immediate GP", async () => {
    const { c, ch: p } = await loggedIn(server, { grade: 10 });
    const h = await sharedDb();
    await h.db.insert(player.Sys_Users_Labyrinth).values({ UserID: p.userId, myProgress: 4, myRanking: 0, completeChallenge: true, isDoubleAward: false, currentFloor: 1, accumulateExp: 0, remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0, cleanOutGold: 50, tryAgainComplete: true, isInGame: false, isCleanOut: false, serverMultiplyingPower: false, LastDate: new Date(), ProcessAward: "-1" } as never).onConflictDoNothing();
    eventsRuntime(ctx).scheduler.setEvents([{ id: 2, kind: "labyrinth", title: "", enabled: true, weekdays: "", startTime: "00:00", durationMin: 0, startDate: null, endDate: null, params: { cleanOutGiftToken: 0 } }]);
    const gp = ctx.world.get(p.userId)!;
    const gpBefore = gp.info.GP;
    const m = c.mark();
    c.out(131, (o) => o.writeInt(3));
    await c.code(131, undefined, m);
    const [row] = await h.db.select().from(player.Sys_Users_Labyrinth).where(eq(player.Sys_Users_Labyrinth.UserID, p.userId));
    expect(row).toMatchObject({ currentFloor: 1, isCleanOut: true, isInGame: true, remainTime: 480 });
    expect(gp.info.GP).toBe(gpBefore);
    eventsRuntime(ctx).scheduler.setEvents([]);
    c.close();
  });
});

describe("132 league battleground stats", () => {
  it("sub 5 returns the original's fixed reference stats (not derived from the player)", async () => {
    const { c } = await loggedIn(server);
    const m = c.mark();
    c.out(132, (o) => o.writeByte(5));
    const r = await c.code(132, undefined, m);
    expect(r.pkt.readByte()).toBe(5);
    expect(r.pkt.readInt()).toBe(1700); // Attack
    expect(r.pkt.readInt()).toBe(1500); // Defend
    expect(r.pkt.readInt()).toBe(1600); // Agility
    expect(r.pkt.readInt()).toBe(1500); // Lucky
    c.close();
  });

  it("sub 3/b2=1 returns MatchInfo prestige + the fixed fairBattleDayPrestige", async () => {
    const { c } = await loggedIn(server);
    const m = c.mark();
    c.out(132, (o) => { o.writeByte(3); o.writeByte(1); });
    const r = await c.code(132, undefined, m);
    r.pkt.readByte(); r.pkt.readBoolean(); r.pkt.readByte();
    r.pkt.readInt(); r.pkt.readInt();
    expect(r.pkt.readInt()).toBe(2000);
    c.close();
  });
});

describe("258 NOVICEACTIVITY idempotency", () => {
  it("grants once per (ActivityType, Condition) at grade >= Condition, a repeat claims nothing more", async () => {
    const h = await sharedDb();
    await h.db.delete(game.Event_Reward_Goods).where(eq(game.Event_Reward_Goods.ActivityType, 9001));
    await h.db.insert(game.Event_Reward_Goods).values({ ActivityType: 9001, SubActivityType: 1, TemplateId: -100, Count: 777, IsBind: true, ValidDate: 0 } as never);
    await eventsRuntime(ctx).reload();
    const { c, ch: p } = await loggedIn(server, { grade: 1, gold: 0 });
    const gp = ctx.world.get(p.userId)!;
    const goldBefore = gp.info.Gold;
    const m = c.mark();
    c.out(258, (o) => { o.writeInt(9001); o.writeInt(1); });
    await c.code(3, undefined, m); // GM_NOTICE reply ("Nhận quà sự kiện thành công!")
    expect(gp.info.Gold).toBe(goldBefore + 777);
    const after1 = gp.info.Gold;
    c.out(258, (o) => { o.writeInt(9001); o.writeInt(1); });
    await new Promise((r) => setTimeout(r, 200));
    expect(gp.info.Gold).toBe(after1); // claimOnce refuses the repeat — no double grant
    c.close();
  });

  it("refuses when the player's grade is below the condition", async () => {
    const h = await sharedDb();
    await h.db.delete(game.Event_Reward_Goods).where(eq(game.Event_Reward_Goods.ActivityType, 9002));
    await h.db.insert(game.Event_Reward_Goods).values({ ActivityType: 9002, SubActivityType: 1, TemplateId: -100, Count: 999, IsBind: true, ValidDate: 0 } as never);
    await h.db.insert(game.Event_Reward_Goods).values({ ActivityType: 9002, SubActivityType: 5, TemplateId: -100, Count: 999, IsBind: true, ValidDate: 0 } as never);
    await eventsRuntime(ctx).reload();
    const { c, ch: p } = await loggedIn(server, { grade: 1, gold: 0 });
    const gp = ctx.world.get(p.userId)!;
    const goldBefore = gp.info.Gold;
    // Condition 5 > player's Grade 1: "Điều kiện không đủ" — refused before claimOnce, nothing granted.
    c.out(258, (o) => { o.writeInt(9002); o.writeInt(5); });
    await new Promise((r) => setTimeout(r, 200));
    expect(gp.info.Gold).toBe(goldBefore);
    c.close();
  });
});
