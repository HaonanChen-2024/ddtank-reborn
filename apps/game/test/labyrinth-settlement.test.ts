import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { player, type Database } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import type { GameServer } from "../src/server.js";
import type { LabyrinthRow } from "../src/handlers/activities.js";
import { labyrinthHandler } from "../src/game/labyrinth.js";
import { ItemInfo } from "../src/game/item.js";
import { StubFightEngine } from "../src/fight/stub.js";
import { RoomMgr } from "../src/rooms/room-mgr.js";
import { eventsRuntime } from "../src/handlers/events.js";
import { type FakeClient, loggedIn, sharedDb, startServer } from "./helpers.js";

let server: GameServer;
const clients: FakeClient[] = [];
beforeAll(async () => { server = await startServer(); });
afterAll(async () => { await server.stop(); });
beforeEach(() => {
  eventsRuntime(server.ctx).scheduler.setEvents([{
    id: 131, kind: "labyrinth", title: "", enabled: true, weekdays: "", startTime: "00:00",
    durationMin: 0, startDate: null, endDate: null, params: { cleanOutGiftToken: 5, pricePerMin: 3 },
  }]);
});
afterEach(() => { clients.splice(0).forEach(c => c.close()); eventsRuntime(server.ctx).scheduler.setEvents([]); });

async function fixture(over: Partial<LabyrinthRow> = {}, money = 100) {
  const f = await loggedIn(server, { grade: 10, money });
  clients.push(f.c);
  const db = await sharedDb();
  const row: LabyrinthRow = {
    UserID: f.ch.userId, myProgress: 4, myRanking: 9, completeChallenge: true, isDoubleAward: false,
    currentFloor: 1, accumulateExp: 0, remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0,
    cleanOutGold: 50, tryAgainComplete: true, isInGame: false, isCleanOut: false,
    serverMultiplyingPower: false, LastDate: server.ctx.now(), ProcessAward: "kept-sweep-marker", ...over,
  };
  await db.db.insert(player.Sys_Users_Labyrinth).values(row);
  f.player().info.GiftToken = 20;
  const read = async () => (await db.db.select().from(player.Sys_Users_Labyrinth)
    .where(eq(player.Sys_Users_Labyrinth.UserID, f.ch.userId)))[0]!;
  const wallet = () => {
    const p = f.player().info;
    return { gp: p.GP, hardCurrency: p.hardCurrency, giftToken: p.GiftToken, money: p.Money, gold: p.Gold };
  };
  const request = async (sub: number, again = false) => {
    const mark = f.c.mark();
    f.c.out(131, pkt => { pkt.writeInt(sub); if (sub === 9) { pkt.writeBoolean(again); pkt.writeBoolean(false); } });
    const response = await f.c.code(131, 2, mark);
    expect(response.pkt.length).toBe(54);
    return read(); // update response follows the awaited row write
  };
  return { ...f, read, wallet, request };
}

const idle = { isCleanOut: false, isInGame: false, remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0 };

function command(sub: number, value = false): GSPacket {
  const pkt = new GSPacket(131); pkt.writeInt(sub);
  if (sub === 1 || sub === 9) pkt.writeBoolean(value);
  if (sub === 9) pkt.writeBoolean(false);
  pkt.offset = 20;
  return pkt;
}

async function failWrite(id: number, table: "Sys_Users_Detail" | "Sys_Users_Labyrinth" | "Sys_Users_Goods"): Promise<() => Promise<void>> {
  const db = await sharedDb();
  // The ID comes from the inserted test character, never from a packet/string.
  if (!Number.isSafeInteger(id)) throw new Error("Invalid test character ID");
  await db.db.execute(sql.raw(`CREATE FUNCTION player.test_labyrinth_131_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."UserID" = ${id} THEN RAISE EXCEPTION 'injected 131 profile failure'; END IF; RETURN NEW; END; $$`));
  await db.db.execute(sql.raw(`CREATE TRIGGER test_labyrinth_131_failure BEFORE UPDATE ON player."${table}"
    FOR EACH ROW EXECUTE FUNCTION player.test_labyrinth_131_failure()`));
  return async () => {
    await db.db.execute(sql.raw(`DROP TRIGGER test_labyrinth_131_failure ON player."${table}"`));
    await db.db.execute(sql`DROP FUNCTION player.test_labyrinth_131_failure()`);
  };
}

describe("131 local sweep settlement lifecycle", () => {
  it("settles once, persists completion, and rejects queued clean/speed/update replays", async () => {
    const f = await fixture();
    const before = f.wallet();
    const completed = await f.request(3);
    const paid = f.wallet();
    expect(paid.giftToken).toBe(before.giftToken - 5);
    expect(paid.money).toBe(before.money);
    expect(paid.gp).toBeGreaterThan(before.gp);
    expect(paid.hardCurrency).toBeGreaterThan(before.hardCurrency);
    expect(completed).toMatchObject({ ...idle, completeChallenge: false, currentFloor: 4, ProcessAward: "kept-sweep-marker" });
    const mark = f.c.mark();
    for (const sub of [3, 3, 4, 2]) f.c.out(131, pkt => pkt.writeInt(sub));
    await f.c.waitFor(r => r.code === 131 && f.c.received.slice(mark).filter(p => p.code === 131).length === 4, 4000, mark);
    expect(f.wallet()).toEqual(paid);
    expect(await f.read()).toEqual(completed);
  });

  it.each([
    { myProgress: 0, currentFloor: 1, completeChallenge: true },
    { myProgress: 4, currentFloor: 6, completeChallenge: true },
    { myProgress: 4, currentFloor: 4, completeChallenge: false },
  ])("does not charge or invent time for unavailable progress %j", async over => {
    const f = await fixture(over);
    const before = f.wallet();
    await f.request(3);
    expect(await f.request(2)).toMatchObject({ remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0 });
    expect(f.wallet()).toEqual(before);
  });

  it("keeps a legitimate unclaimed final floor eligible even when cursor equals progress", async () => {
    const f = await fixture({ currentFloor: 4 });
    const before = f.wallet();
    expect(await f.request(3)).toMatchObject({ completeChallenge: false, currentFloor: 4 });
    const after = f.wallet();
    expect(after.gp).toBeGreaterThan(before.gp);
    expect(after.giftToken).toBe(before.giftToken - 5);
    await f.request(3);
    expect(f.wallet()).toEqual(after);
  });

  it("keeps insufficient GiftToken retryable without using Money", async () => {
    const f = await fixture();
    f.player().info.GiftToken = 4;
    const before = f.wallet();
    expect(await f.request(3)).toMatchObject({ completeChallenge: true, currentFloor: 1, isCleanOut: false });
    expect(f.wallet()).toEqual(before);
    f.player().info.GiftToken = 5;
    expect(await f.request(3)).toMatchObject({ completeChallenge: false });
    expect(f.wallet().giftToken).toBe(0);
    expect(f.wallet().money).toBe(before.money);
  });

  it("reopens one explicit reset with clean state; a second reset cannot reopen completion", async () => {
    const f = await fixture({ completeChallenge: false, currentFloor: 4, accumulateExp: 123,
      isCleanOut: true, isInGame: true, remainTime: 121, currentRemainTime: 121, cleanOutAllTime: 480 });
    const before = f.wallet();
    const reset = await f.request(6);
    expect(reset).toMatchObject({ ...idle, completeChallenge: true, currentFloor: 1, accumulateExp: 0, tryAgainComplete: false });
    expect(reset.ProcessAward.split("-")).toEqual(Array.from({ length: 99 }, (_, i) => String(i)));
    await f.request(4); // stale acceleration cannot skip the new sweep's entry fee
    expect(f.wallet()).toEqual(before);
    expect(await f.request(3)).toMatchObject({ completeChallenge: false });
    const paid = f.wallet();
    expect(await f.request(6)).toMatchObject({ completeChallenge: false, tryAgainComplete: false });
    await f.request(3);
    expect(f.wallet()).toEqual(paid);
  });

  it("clears stale sweep state at the UTC daily reset and permits only one new settlement", async () => {
    const yesterday = new Date(server.ctx.now().getTime() - 86400_000);
    const f = await fixture({ LastDate: yesterday, completeChallenge: false, currentFloor: 4,
      tryAgainComplete: false, isCleanOut: true, isInGame: true, remainTime: 121, currentRemainTime: 121, cleanOutAllTime: 480 });
    const before = f.wallet();
    expect(await f.request(5)).toMatchObject({ ...idle, completeChallenge: true, currentFloor: 1, tryAgainComplete: true });
    await f.request(4);
    expect(f.wallet()).toEqual(before);
    await f.request(3);
    const paid = f.wallet();
    expect(paid.giftToken).toBe(before.giftToken - 5);
    await f.request(3);
    expect(f.wallet()).toEqual(paid);
  });

  it.each([
    { completeChallenge: false, currentFloor: 4, myProgress: 4 },
    { completeChallenge: true, currentFloor: 1, myProgress: 0 },
  ])("rejects stale active acceleration without charging %j", async over => {
    const f = await fixture({ ...over, isCleanOut: true, currentRemainTime: 121 });
    const before = f.wallet();
    await f.request(4);
    expect(f.wallet()).toEqual(before);
  });

  it("preserves the existing floor-minute Money price on a valid legacy active sweep", async () => {
    const f = await fixture({ isCleanOut: true, isInGame: true, currentRemainTime: 121 });
    const before = f.wallet();
    expect(await f.request(4)).toMatchObject({ ...idle, completeChallenge: false });
    const paid = f.wallet();
    expect(paid.money).toBe(before.money - 6); // floor(121 / 60) * 3, original server tariff
    expect(paid.giftToken).toBe(before.giftToken);
    expect(paid.gp).toBeGreaterThan(before.gp);
    await f.request(4);
    expect(f.wallet()).toEqual(paid);
  });

  it("leaves a valid active sweep unchanged when Money is insufficient", async () => {
    const f = await fixture({ isCleanOut: true, currentRemainTime: 121 }, 5);
    const before = f.wallet(), row = await f.read();
    expect(await f.request(4)).toEqual(row);
    expect(f.wallet()).toEqual(before);
  });

  it("retains the existing paid TRY_AGAIN reopen path as a separate fidelity gap", async () => {
    const f = await fixture({ completeChallenge: false, currentFloor: 4 }, 1000);
    const before = f.wallet();
    expect(await f.request(9, true)).toMatchObject({ completeChallenge: true, isInGame: true });
    expect(f.wallet()).toEqual({ ...before, money: 0 });
  });

  it.each([3, 9].flatMap(sub => (["Sys_Users_Detail", "Sys_Users_Labyrinth"] as const).map(table => ({ sub, table }))))
  ("rolls back the live wallet and stored row if 131 sub $sub fails on $table", async ({ sub, table }) => {
    const f = await fixture({}, 1000), p = f.player(), before = structuredClone(p.info), row = await f.read();
    const db = await sharedDb(), stored = (await db.db.select().from(player.Sys_Users_Detail)
      .where(eq(player.Sys_Users_Detail.UserID, p.id)))[0]!;
    const remove = await failWrite(p.id, table);
    try {
      await expect(labyrinthHandler(server.ctx, p, command(sub, true))).rejects.toThrow();
      expect(p.info).toEqual(before); expect(await f.read()).toEqual(row);
      expect((await db.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, p.id)))[0]).toEqual(stored);
    } finally { await remove(); }
    await labyrinthHandler(server.ctx, p, command(sub, true));
    expect(await f.read()).toMatchObject(sub === 3 ? { completeChallenge: false } : { isInGame: true });
    expect(sub === 3 ? p.info.GiftToken : p.info.Money).toBe(sub === 3 ? before.GiftToken - 5 : 0);
  });

  it.each(["Sys_Users_Detail", "Sys_Users_Goods"] as const)
  ("commits DOUBLE_REWARD's last 11916 and its row together, preserving the live slot on $table failure", async table => {
    const f = await fixture(), p = f.player(), db = await sharedDb();
    const [goods] = await db.db.insert(player.Sys_Users_Goods).values({ UserID: p.id, BagType: 1, Place: 0,
      TemplateID: 11916, Count: 1, IsBinds: true }).returning();
    const item = ItemInfo.fromRow(goods!, server.ctx.templates.findItem(11916)!);
    p.propBag.loadItems([item]);
    const row = await f.read(), itemBefore = item.toRow(), dirtyBefore = item.isDirty;
    const remove = await failWrite(p.id, table);
    try {
      await expect(labyrinthHandler(server.ctx, p, command(1, true))).rejects.toThrow();
      expect(await f.read()).toEqual(row); expect(p.propBag.getItemAt(0)).toBe(item);
      expect(item.toRow()).toEqual(itemBefore); expect(item.isDirty).toBe(dirtyBefore);
      expect((await db.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, item.ItemID)))[0]).toEqual(goods);
    } finally { await remove(); }
    await labyrinthHandler(server.ctx, p, command(1, true));
    expect(await f.read()).toMatchObject({ isDoubleAward: true }); expect(p.propBag.getItemAt(0)).toBeNull();
    expect((await db.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, item.ItemID)))[0]).toMatchObject({ IsExist: false });
    await labyrinthHandler(server.ctx, p, command(1, true));
    expect(await f.read()).toMatchObject({ isDoubleAward: true });
  });

  it("initializes the original 99 slots only for a new or provably unused legacy row", async () => {
    const f = await fixture({ myProgress: 0, ProcessAward: "-1" });
    expect((await f.request(2)).ProcessAward.split("-")).toEqual(Array.from({ length: 99 }, (_, i) => String(i)));
    const progressed = await fixture({ ProcessAward: "-1" });
    expect((await progressed.request(2)).ProcessAward).toBe("-1");
    const fresh = await loggedIn(server, { grade: 10 }); clients.push(fresh.c);
    await labyrinthHandler(server.ctx, fresh.player(), command(2));
    const db = await sharedDb(), [row] = await db.db.select().from(player.Sys_Users_Labyrinth)
      .where(eq(player.Sys_Users_Labyrinth.UserID, fresh.ch.userId));
    expect(row).toMatchObject({ currentFloor: 1, myProgress: 0 });
    expect(row!.ProcessAward.split("-")).toEqual(Array.from({ length: 99 }, (_, i) => String(i)));
  });

  it("rejects in-fight commands and rechecks quit after waiting for the persistence owner", async () => {
    const f = await fixture(), p = f.player(), row = await f.read(), before = f.wallet();
    p.currentRoom = { game: {} } as never;
    try { await labyrinthHandler(server.ctx, p, command(3)); } finally { p.currentRoom = null; }
    expect(await f.read()).toEqual(row); expect(f.wallet()).toEqual(before);
    let release!: () => void;
    const held = p.withPersistenceLock(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const pending = labyrinthHandler(server.ctx, p, command(3));
    p.quitting = Promise.resolve(); release();
    try { await held; await pending; } finally { p.quitting = null; }
    expect(await f.read()).toEqual(row); expect(f.wallet()).toEqual(before);
  });

  it("reads the UTC day only after acquiring the persistence owner, resetting a queued previous-day request", async () => {
    const previousDay = new Date("2026-10-16T23:59:59.000Z"), nextDay = new Date("2026-10-17T00:00:01.000Z");
    const f = await fixture({ LastDate: previousDay, completeChallenge: false, currentFloor: 4,
      tryAgainComplete: false, accumulateExp: 123, isInGame: true, isCleanOut: true }), p = f.player();
    const originalNow = server.ctx.now;
    let now = previousDay, release!: () => void;
    server.ctx.now = () => now;
    try {
      const held = p.withPersistenceLock(() => new Promise<void>(resolve => { release = resolve; }));
      await Promise.resolve();
      const pending = labyrinthHandler(server.ctx, p, command(5));
      now = nextDay; release(); await held; await pending;
      const row = await f.read();
      expect(row).toMatchObject({ ...idle, completeChallenge: true, currentFloor: 1, tryAgainComplete: true, accumulateExp: 0 });
      expect(row.LastDate).toEqual(nextDay);
      expect(row.ProcessAward.split("-")).toEqual(Array.from({ length: 99 }, (_, i) => String(i)));
    } finally { server.ctx.now = originalNow; }
  });

  it("holds the existing room-start barrier through SQL COMMIT and live publication for another client's host", async () => {
    const f = await fixture(), p = f.player(), host = await loggedIn(server, { grade: 10 }); clients.push(host.c);
    const db = await sharedDb(), rooms = new RoomMgr({ maxRooms: 1, fight: new StubFightEngine(id => id), lang: key => key });
    const room = rooms.rooms[0]!; room.start(); room.updateRoom("test", "", 1, 3, 10000);
    room.addPlayer(host.player()); room.addPlayer(p); room.updatePlayerState(p, 1, true);
    expect(room.host).toBe(host.player()); expect(room.canStart()).toBe(true);
    let entered!: () => void, release!: () => void;
    const enteredCommit = new Promise<void>(resolve => { entered = resolve; }), releaseCommit = new Promise<void>(resolve => { release = resolve; });
    const ctx = { ...server.ctx, db: { ...db, db: new Proxy(db.db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return async (work: (tx: Database) => Promise<unknown>) => {
        const result = await target.transaction(tx => work(tx as unknown as Database));
        entered(); await releaseCommit; return result;
      };
    } }) as Database } };
    eventsRuntime(ctx).scheduler.setEvents([{
      id: 131, kind: "labyrinth", title: "", enabled: true, weekdays: "", startTime: "00:00", durationMin: 0,
      startDate: null, endDate: null, params: { cleanOutGiftToken: 5 },
    }]);
    const running = labyrinthHandler(ctx, p, command(3));
    try {
      await enteredCommit;
      expect(p.worldBossAwardPending).not.toBeNull(); expect(p.info.GiftToken).toBe(20);
      const [committed] = await db.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, p.id));
      expect(committed!.GiftToken).toBe(15);
      rooms.startGame(room); rooms.tick(); expect(room.game).toBeNull();
      await labyrinthHandler(ctx, p, command(6)); // Busy rejection never waits on itself or reopens the stored run.
      expect(await f.read()).toMatchObject({ completeChallenge: false, tryAgainComplete: true });
      release(); await running;
      expect(p.info.GiftToken).toBe(15); expect(p.worldBossAwardPending).toBeNull();
      await Promise.resolve(); rooms.tick(); expect(room.game).not.toBeNull();
    } finally {
      release(); await running.catch(() => {}); room.game?.stop();
      room.removePlayer(p); room.removePlayer(host.player()); rooms.stop();
    }
  });
});
