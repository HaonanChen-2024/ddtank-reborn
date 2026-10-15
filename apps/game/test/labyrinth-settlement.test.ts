import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { player } from "@ddt/db";
import type { GameServer } from "../src/server.js";
import type { LabyrinthRow } from "../src/handlers/activities.js";
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
});
