import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, seedDatabase, game, player, type Database, type DbHandle } from "@ddt/db";
import { GSPacket, RollingKeyCipher, encodeFrame } from "@ddt/protocol";
import { loadMatchInfo, loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { Templates } from "../src/db/templates.js";
import { WorldBossSettlementGate } from "../src/fight/world-boss-settlement.js";
import { ItemInfo } from "../src/game/item.js";
import { labyrinthCleanOutOwner } from "../src/game/labyrinth-clean-out.js";
import { readLabyrinthCleanOutPhase } from "../src/game/labyrinth-clean-out-checkpoint.js";
import { advanceLabyrinthCleanOut, initProcessAward, labyrinthHandler, type LabyrinthCleanOutSnapshot, type LabyrinthRow } from "../src/game/labyrinth.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { eventsRuntime } from "../src/handlers/events.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { registerRooms } from "../src/handlers/rooms.js";
import { BaseRoom } from "../src/rooms/room.js";
import { GameClient } from "../src/session/client.js";
import { World, type ServerContext } from "../src/session/context.js";

// Isolated PGlite + actual GameClient packet/settlement queues. These fixtures
// neither touch the running game nor prove that production missions exist.
let h: DbHandle, base: Templates, sequence = 0;
const NOW = new Date("2026-10-16T12:00:00.000Z");
const PROCESS = "kept-original-sweep-marker";
const TABLES = ["Sys_Users_Labyrinth", "Sys_Users_Detail", "Sys_Users_Goods", "User_Messages"] as const;
type FailureTable = typeof TABLES[number] | "LabyrinthCleanOutPhases";
const failureTarget = (table: FailureTable) => `${table === "LabyrinthCleanOutPhases" ? "app" : "player"}."${table}"`;
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods"] });
  base = new Templates(); base.items = new Map((await h.db.select().from(game.Shop_Goods)).map(row => [row.TemplateID, row]));
});
afterAll(async () => { await h.close(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of TABLES) await h.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_labyrinth_sweep_failure ON player."${table}"`));
  await h.db.execute(sql`DROP TRIGGER IF EXISTS test_labyrinth_sweep_failure ON app."LabyrinthCleanOutPhases"`);
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_labyrinth_sweep_failure()`);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(yes => setImmediate(yes));

async function fixture(over: Partial<LabyrinthRow> = {}, firstPhase = 120) {
  const [who] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `lab_sweep_${++sequence}`,
    NickName: `Lab sweep ${sequence}`, IsFirst: 1, Grade: 20, GiftToken: 1000, Money: 1000000 }).returning();
  const info = (await loadPlayerInfo(h.db, who!.UserID))!, templates = new Templates();
  templates.items = new Map(base.items); templates.serverConfig.set("WarriorFamRaidTimeRemain", String(firstPhase));
  const frames: Uint8Array[] = [], sent: { code: number; body: Uint8Array }[] = [], handlers = new HandlerRegistry();
  let now = NOW;
  const ctx = { db: h, templates, world: new World(), now: () => now,
    cfg: { LOGIN_TIMEOUT_SEC: 0, PACKET_RATE_PER_SEC: 1000, PACKET_RATE_BURST: 1000 },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, lang: { t: (key: string) => key },
    rooms: { waitingRemove: vi.fn(), sendUpdateRoom: vi.fn() },
  } as unknown as ServerContext;
  const client = new GameClient({ kind: "fake", remoteAddress: "isolated-labyrinth-sweep",
    write: bytes => frames.push(bytes), close: () => {} }, ctx, handlers);
  const p = new GamePlayer(client, info, defaultMatch(info.ID), 1, "test"); client.player = p; ctx.world.add(p);
  const originalSend = p.send.bind(p);
  const recordSend = (pkt: GSPacket) => { sent.push({ code: pkt.code, body: pkt.body().slice() }); originalSend(pkt); };
  vi.spyOn(p, "send").mockImplementation(recordSend);
  const row: LabyrinthRow = { UserID: p.id, myProgress: 2, myRanking: 0, completeChallenge: true, isDoubleAward: false,
    currentFloor: 1, accumulateExp: 0, remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0, cleanOutGold: 50,
    tryAgainComplete: true, isInGame: false, isCleanOut: false, serverMultiplyingPower: false,
    LastDate: NOW, ProcessAward: PROCESS, ...over };
  await h.db.insert(player.Sys_Users_Labyrinth).values(row);
  eventsRuntime(ctx).scheduler.setEvents([{ id: 131, kind: "labyrinth", title: "", enabled: true, weekdays: "",
    startTime: "00:00", durationMin: 0, startDate: null, endDate: null, params: { cleanOutGiftToken: 5, pricePerMin: 3 } }]);
  handlers.player(131, "actual Labyrinth handler", labyrinthHandler);
  const owner = labyrinthCleanOutOwner(ctx), cipher = new RollingKeyCipher(true);
  const sendPacket = (code: number, fill: (pkt: GSPacket) => void) => {
    const pkt = new GSPacket(code); fill(pkt); client.receive(encodeFrame(pkt, cipher));
  };
  const send = (sub: number) => sendPacket(131, pkt => pkt.writeInt(sub));
  const request = async (sub: number) => { send(sub); await client.idle(); return progress(p); };
  const advance = (seconds: number) => { now = new Date(now.getTime() + seconds * 1000); };
  const tick = async (seconds: number) => { advance(seconds); owner.tick(); await client.idle(); };
  return { p, ctx, client, owner, sent, frames, send, sendPacket, handlers, request, advance, tick, recordSend };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** New process/session objects load only committed data. A failed old owner is
 * intentionally not drained here: crash-recovery tests must not retry its work. */
async function freshSession(old: Fixture, offlineSeconds = 3600): Promise<Fixture> {
  await old.client.idle(); old.owner.beginShutdown(); old.client.disconnect("isolated process replacement");
  old.p.isActive = false; old.ctx.world.remove(old.p);
  let now = new Date(old.ctx.now().getTime() + offlineSeconds * 1000);
  const ctx = { ...old.ctx, world: new World(), now: () => now } as ServerContext;
  const handlers = new HandlerRegistry(), frames: Uint8Array[] = [], sent: Fixture["sent"] = [];
  const client = new GameClient({ kind: "fake", remoteAddress: "isolated-labyrinth-reconnect",
    write: bytes => frames.push(bytes), close: () => {} }, ctx, handlers);
  const [info, match, items] = await Promise.all([loadPlayerInfo(h.db, old.p.id), loadMatchInfo(h.db, old.p.id),
    loadUserItems(h.db, old.p.id, ctx.templates.findItem)]);
  const p = new GamePlayer(client, info!, match, 1, "test"); client.player = p; ctx.world.add(p);
  const originalSend = p.send.bind(p);
  const recordSend = (pkt: GSPacket) => { sent.push({ code: pkt.code, body: pkt.body().slice() }); originalSend(pkt); };
  vi.spyOn(p, "send").mockImplementation(recordSend);
  for (const bag of p.allBags()) {
    bag.capacity = old.p.getInventory(bag.bagType)!.capacity;
    bag.loadItems(items.get(bag.bagType) ?? []);
  }
  eventsRuntime(ctx).scheduler.setEvents(eventsRuntime(old.ctx).scheduler.events);
  handlers.player(131, "actual Labyrinth handler after reconnect", labyrinthHandler);
  const owner = labyrinthCleanOutOwner(ctx), cipher = new RollingKeyCipher(true);
  const sendPacket = (code: number, fill: (pkt: GSPacket) => void) => {
    const pkt = new GSPacket(code); fill(pkt); client.receive(encodeFrame(pkt, cipher));
  };
  const send = (sub: number) => sendPacket(131, pkt => pkt.writeInt(sub));
  const request = async (sub: number) => { send(sub); await client.idle(); return progress(p); };
  const advance = (seconds: number) => { now = new Date(now.getTime() + seconds * 1000); };
  const tick = async (seconds: number) => { advance(seconds); owner.tick(); await client.idle(); };
  expect(ctx.world).not.toBe(old.ctx.world); expect(p).not.toBe(old.p); expect(client).not.toBe(old.client); expect(owner).not.toBe(old.owner);
  return { p, ctx, client, owner, sent, frames, send, sendPacket, handlers, request, advance, tick, recordSend };
}

async function attachSavedPhase(f: Fixture): Promise<number | null> {
  const row = await progress(f.p), phase = await readLabyrinthCleanOutPhase(f.ctx.db.db, row);
  f.owner.sync(f.p, row, false, phase); return phase;
}

const progress = async (p: GamePlayer) => (await h.db.select().from(player.Sys_Users_Labyrinth)
  .where(eq(player.Sys_Users_Labyrinth.UserID, p.id)))[0]!;
const profile = async (p: GamePlayer) => (await h.db.select().from(player.Sys_Users_Detail)
  .where(eq(player.Sys_Users_Detail.UserID, p.id)))[0]!;
const mails = (p: GamePlayer) => h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, p.id));
const wallet = (p: GamePlayer) => ({ gp: p.info.GP, hardCurrency: p.info.hardCurrency, giftToken: p.info.GiftToken, money: p.info.Money });
const snapshot = (l: LabyrinthRow): LabyrinthCleanOutSnapshot => ({ day: l.LastDate.toISOString().slice(0, 10),
  currentFloor: l.currentFloor, myProgress: l.myProgress, remainTime: l.remainTime,
  currentRemainTime: l.currentRemainTime, cleanOutAllTime: l.cleanOutAllTime });
function awardLogs(f: Fixture) {
  return f.sent.filter(pkt => pkt.code === 131 && pkt.body[0] === 7).map(pkt => {
    const parsed = new GSPacket(131); parsed.write(pkt.body); parsed.offset = 20;
    expect(parsed.readByte()).toBe(7);
    const floor = parsed.readInt(), gp = parsed.readInt(), count = parsed.readInt();
    const items = Array.from({ length: count }, () => ({ templateId: parsed.readInt(), count: parsed.readInt() }));
    return { floor, gp, items, hardCurrency: parsed.readInt() };
  });
}
async function putItem(f: Fixture, templateId: number, count = 1) {
  const place = f.p.propBag.getItems().length;
  const [row] = await h.db.insert(player.Sys_Users_Goods).values({ UserID: f.p.id, BagType: 1, Place: place,
    TemplateID: templateId, Count: count, IsBinds: true }).returning();
  const item = ItemInfo.fromRow(row!, f.ctx.templates.findItem(templateId)!);
  f.p.propBag.loadItems([...f.p.propBag.getItems(), item]); return item;
}
function fixedDrop(f: Fixture) {
  return vi.spyOn(f.ctx.templates, "pveDrop").mockReturnValue([{ templateId: 11005, count: 91, isBind: false, validDate: 0 }]);
}
async function failWrites(table: FailureTable) {
  await h.db.execute(sql`CREATE FUNCTION player.test_labyrinth_sweep_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected sweep SQL failure'; END; $$`);
  await h.db.execute(sql.raw(`CREATE TRIGGER test_labyrinth_sweep_failure BEFORE INSERT OR UPDATE OR DELETE ON ${failureTarget(table)}
    FOR EACH ROW EXECUTE FUNCTION player.test_labyrinth_sweep_failure()`));
  return async () => {
    await h.db.execute(sql.raw(`DROP TRIGGER test_labyrinth_sweep_failure ON ${failureTarget(table)}`));
    await h.db.execute(sql`DROP FUNCTION player.test_labyrinth_sweep_failure()`);
  };
}
async function blockedClient(f: Fixture) {
  const entered = deferred(), release = deferred();
  const work = f.client.enqueueActivityExchange(async () => { entered.resolve(); await release.promise; });
  await entered.promise; return { release: release.resolve, work };
}

describe("original timed Labyrinth sweep on the real client queue", () => {
  it("charges entry only once, waits 119 seconds, and awards every inclusive floor at its 120-second boundary", async () => {
    const f = await fixture(), before = wallet(f.p), drop = fixedDrop(f);
    expect(await f.request(3)).toMatchObject({ isCleanOut: true, isInGame: true, currentFloor: 1, remainTime: 240 });
    expect(wallet(f.p)).toEqual({ ...before, giftToken: before.giftToken - 5 }); expect(awardLogs(f)).toEqual([]);
    await f.request(3); expect(f.p.info.GiftToken).toBe(before.giftToken - 5);
    await f.tick(119);
    expect(await progress(f.p)).toMatchObject({ currentFloor: 1, remainTime: 121, currentRemainTime: 121 });
    expect(f.p.info.GP).toBe(before.gp); expect(awardLogs(f)).toEqual([]);
    await f.request(2); expect((await progress(f.p)).remainTime).toBe(121);
    await f.tick(1);
    expect(awardLogs(f)).toEqual([{ floor: 1, gp: 660, items: [], hardCurrency: 0 }]);
    expect(await progress(f.p)).toMatchObject({ currentFloor: 2, remainTime: 120, cleanOutAllTime: 240, ProcessAward: PROCESS });
    await f.tick(120);
    expect(awardLogs(f)).toEqual([{ floor: 1, gp: 660, items: [], hardCurrency: 0 },
      { floor: 2, gp: 1350, items: [{ templateId: 11005, count: 2 }], hardCurrency: 2 }]);
    expect(wallet(f.p)).toEqual({ ...before, giftToken: before.giftToken - 5, gp: before.gp + 2010, hardCurrency: before.hardCurrency + 2 });
    expect(await progress(f.p)).toMatchObject({ currentFloor: 2, completeChallenge: false, isCleanOut: false, isInGame: false,
      remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0, ProcessAward: PROCESS });
    const finished = await profile(f.p); await f.tick(120); await f.request(3); await f.request(4);
    expect(await profile(f.p)).toEqual(finished); expect(drop).toHaveBeenCalledExactlyOnceWith("copy", 2, 40002);
    expect(f.frames.length).toBeGreaterThan(0);
  });

  it("reads the configured first phase and uses 120 seconds after the first awarded floor", async () => {
    const f = await fixture({}, 2); fixedDrop(f); await f.request(3);
    await f.tick(1); expect(awardLogs(f)).toEqual([]);
    await f.tick(1); expect(awardLogs(f).map(x => x.floor)).toEqual([1]);
    await f.tick(119); expect(awardLogs(f).map(x => x.floor)).toEqual([1]);
    await f.tick(1); expect(awardLogs(f).map(x => x.floor)).toEqual([1, 2]);
    expect((await progress(f.p)).completeChallenge).toBe(false);
  });

  it("quotes the configured 180-second first phase plus the 120-second final floor without exhausting time early", async () => {
    const f = await fixture({}, 180); fixedDrop(f);
    expect(await f.request(2)).toMatchObject({ remainTime: 300, currentRemainTime: 300, cleanOutAllTime: 300 });
    await f.request(3);
    expect(await readLabyrinthCleanOutPhase(f.ctx.db.db, await progress(f.p))).toBe(180);
    await f.tick(179); expect(awardLogs(f)).toEqual([]);
    await f.tick(1); expect(awardLogs(f).map(log => log.floor)).toEqual([1]);
    expect(await progress(f.p)).toMatchObject({ currentFloor: 2, remainTime: 120, currentRemainTime: 120 });
    await f.tick(119); expect(awardLogs(f).map(log => log.floor)).toEqual([1]);
    await f.tick(1); expect(awardLogs(f).map(log => log.floor)).toEqual([1, 2]);
    expect(await progress(f.p)).toMatchObject({ completeChallenge: false, isCleanOut: false, remainTime: 0 });
  });

  it("pauses without clearing isInGame or time and resumes the same uncompleted phase", async () => {
    const f = await fixture(); await f.request(3); await f.tick(61);
    const paused = await f.request(5);
    expect(paused).toMatchObject({ isCleanOut: false, isInGame: true, currentFloor: 1, remainTime: 179,
      currentRemainTime: 179, cleanOutAllTime: 240, ProcessAward: PROCESS });
    await f.tick(600); expect(await progress(f.p)).toEqual(paused); expect(awardLogs(f)).toEqual([]);
    await f.request(3); await f.tick(58); expect(awardLogs(f)).toEqual([]);
    await f.tick(1); expect(awardLogs(f).map(x => x.floor)).toEqual([1]);
    expect((await progress(f.p)).remainTime).toBe(120);
  });

  it("does not stretch a paused final second when the client requests another quote", async () => {
    const f = await fixture({ myProgress: 1 }); await f.request(3); await f.tick(119);
    const paused = await f.request(5);
    expect(paused).toMatchObject({ currentFloor: 1, remainTime: 1, currentRemainTime: 1, isCleanOut: false, isInGame: true });
    expect(await readLabyrinthCleanOutPhase(f.ctx.db.db, paused)).toBe(1);
    expect(await f.request(2)).toEqual(paused);
    expect(await readLabyrinthCleanOutPhase(f.ctx.db.db, await progress(f.p))).toBe(1);
    await f.request(3); await f.tick(1);
    expect(awardLogs(f)).toEqual([{ floor: 1, gp: 660, items: [], hardCurrency: 0 }]);
    expect(await progress(f.p)).toMatchObject({ completeChallenge: false, isCleanOut: false, remainTime: 0 });
  });

  it("retains only online time when a saved active row is attached to a newly logged-in player", async () => {
    const f = await fixture({ isCleanOut: true, isInGame: true, remainTime: 240, currentRemainTime: 240, cleanOutAllTime: 240 });
    const before = wallet(f.p); f.advance(3600); f.owner.sync(f.p, await progress(f.p));
    f.owner.tick(); await f.client.idle(); expect(wallet(f.p)).toEqual(before); expect((await progress(f.p)).remainTime).toBe(240);
    await f.tick(119); expect(awardLogs(f)).toEqual([]);
    await f.tick(1); expect(awardLogs(f).map(x => x.floor)).toEqual([1]);
    expect((await progress(f.p)).remainTime).toBe(120);
  });

  it("restores a durable partial-floor checkpoint in a new session without counting an offline hour", async () => {
    const f = await fixture(), before = wallet(f.p); fixedDrop(f);
    await f.request(3); await f.tick(90);
    const saved = await progress(f.p);
    expect(saved).toMatchObject({ currentFloor: 1, remainTime: 150, currentRemainTime: 150, cleanOutAllTime: 240 });
    expect(await readLabyrinthCleanOutPhase(f.ctx.db.db, saved)).toBe(30);
    await f.owner.beforeQuit(f.p);
    const next = await freshSession(f); expect(await attachSavedPhase(next)).toBe(30);
    next.owner.tick(); await next.client.idle();
    expect(await progress(next.p)).toEqual(saved); expect(next.p.info.GP).toBe(before.gp); expect(awardLogs(next)).toEqual([]);
    await next.tick(29); expect(awardLogs(next)).toEqual([]);
    await next.tick(1); expect(awardLogs(next).map(log => log.floor)).toEqual([1]);
    expect(await progress(next.p)).toMatchObject({ currentFloor: 2, remainTime: 120 });
    expect(await readLabyrinthCleanOutPhase(next.ctx.db.db, await progress(next.p))).toBe(120);
    await next.tick(119); expect(awardLogs(next).map(log => log.floor)).toEqual([1]);
    await next.tick(1);
    expect(awardLogs(next).map(log => log.floor)).toEqual([1, 2]);
    expect(next.p.info.GP).toBe(before.gp + 2010); expect((await profile(next.p)).GP).toBe(before.gp + 2010);
    expect(await progress(next.p)).toMatchObject({ currentFloor: 2, completeChallenge: false, isCleanOut: false,
      isInGame: false, remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0, ProcessAward: PROCESS });
  });

  it("recovers one remaining second of the final floor once and never replays it on a later login", async () => {
    const f = await fixture(); fixedDrop(f); await f.request(3); await f.tick(239);
    expect(awardLogs(f).map(log => log.floor)).toEqual([1]);
    const saved = await progress(f.p), gp = f.p.info.GP;
    expect(saved).toMatchObject({ currentFloor: 2, remainTime: 1, currentRemainTime: 1 });
    expect(await readLabyrinthCleanOutPhase(f.ctx.db.db, saved)).toBe(1);
    await f.owner.beforeQuit(f.p);
    const next = await freshSession(f); expect(await attachSavedPhase(next)).toBe(1);
    next.owner.tick(); await next.client.idle(); expect(next.p.info.GP).toBe(gp);
    await next.tick(1); expect(awardLogs(next).map(log => log.floor)).toEqual([2]);
    expect(next.p.info.GP).toBe(gp + 1350); expect((await progress(next.p)).completeChallenge).toBe(false);
    await next.owner.beforeQuit(next.p);
    const third = await freshSession(next); await attachSavedPhase(third); await third.tick(600);
    expect(third.p.info.GP).toBe(gp + 1350); expect(awardLogs(third)).toEqual([]);
    expect(await progress(third.p)).toMatchObject({ completeChallenge: false, isCleanOut: false, remainTime: 0, ProcessAward: PROCESS });
  });

  it.each(["Sys_Users_Detail", "Sys_Users_Goods", "User_Messages", "LabyrinthCleanOutPhases"] as const)
  ("rolls the checkpoint back with the floor economy on %s failure before a fresh session retries", async table => {
    const f = await fixture({ currentFloor: 2, myProgress: 2, isDoubleAward: true }); fixedDrop(f);
    const card = await putItem(f, 11916, 2); f.p.propBag.capacity = 1;
    await f.request(3); await f.tick(90);
    const saved = await progress(f.p), before = wallet(f.p), stored = await profile(f.p), originalCard = card.toRow();
    expect(saved).toMatchObject({ currentFloor: 2, remainTime: 30 });
    expect(await readLabyrinthCleanOutPhase(f.ctx.db.db, saved)).toBe(30);
    const remove = await failWrites(table); await f.tick(30);
    expect(await progress(f.p)).toEqual(saved); expect(wallet(f.p)).toEqual(before); expect(await profile(f.p)).toEqual(stored);
    expect(card.toRow()).toEqual(originalCard); expect(await mails(f.p)).toEqual([]); expect(awardLogs(f)).toEqual([]);
    expect(await readLabyrinthCleanOutPhase(f.ctx.db.db, saved)).toBe(30);
    await remove();
    // Simulate process replacement, not the old owner's automatic failure retry.
    const next = await freshSession(f); expect(await attachSavedPhase(next)).toBe(30);
    next.owner.tick(); await next.client.idle(); expect(wallet(next.p)).toEqual(before);
    await next.tick(29); expect(awardLogs(next)).toEqual([]); expect(next.p.info.GP).toBe(before.gp);
    await next.tick(1);
    expect(awardLogs(next)).toEqual([{ floor: 2, gp: 2700, items: [{ templateId: 11005, count: 4 }], hardCurrency: 4 }]);
    expect(next.p.info.GP).toBe(before.gp + 2700); expect(next.p.info.hardCurrency).toBe(before.hardCurrency + 4);
    expect(next.p.propBag.getItemByTemplateID(0, 11916)?.Count).toBe(1); expect(await mails(next.p)).toHaveLength(1);
    const completed = await progress(next.p); await next.tick(120);
    expect(await progress(next.p)).toEqual(completed); expect(awardLogs(next)).toHaveLength(1); expect(await mails(next.p)).toHaveLength(1);
  });

  it("accelerates all 40 original reward rows, consumes cards even when doubling is off, and overwrites drop Count", async () => {
    const f = await fixture({ myProgress: 40 }), drop = fixedDrop(f), card = await putItem(f, 11916, 40), before = wallet(f.p);
    await f.request(3); await f.request(4);
    const materials = [0,2,0,2,0,2,0,3,0,3,0,3,0,4,0,4,0,4,0,5,0,5,0,5,0,6,0,6,0,6,0,8,0,8,0,8,0,10,0,10];
    const currency = [0,2,0,2,0,3,0,3,0,4,0,4,0,5,0,5,0,6,0,6,0,7,0,7,0,8,0,8,0,10,0,10,0,11,0,11,0,12,0,12];
    const logs = awardLogs(f), gp = Array.from({ length: 40 }, (_, i) => 660 + 690 * i).reduce((a,b) => a+b, 0);
    expect(logs).toEqual(materials.map((count, i) => ({ floor: i+1, gp: 660+690*i,
      items: count ? [{ templateId: 11005, count }] : [], hardCurrency: currency[i] })));
    expect(wallet(f.p)).toEqual({ ...before, giftToken: before.giftToken-5, money: before.money-240,
      gp: before.gp+gp, hardCurrency: before.hardCurrency+currency.reduce((a,b) => a+b, 0) });
    expect(card.IsExist).toBe(false); expect(f.p.propBag.getItemByTemplateID(0,11916)).toBeNull();
    const goods = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID,f.p.id));
    expect(goods.filter(x => x.IsExist && x.TemplateID===11005).reduce((n,x) => n+x.Count,0)).toBe(materials.reduce((a,b) => a+b,0));
    expect(goods.filter(x => x.IsExist && x.TemplateID===11005).every(x => x.IsBinds)).toBe(true);
    expect(drop).toHaveBeenCalledTimes(20); expect(drop.mock.calls.every(args => args.join(",")==="copy,2,40002")).toBe(true);
    expect(await progress(f.p)).toMatchObject({ currentFloor: 40, accumulateExp: gp, completeChallenge: false, ProcessAward: PROCESS });
    const completed = await profile(f.p); await f.request(4); await f.request(3); expect(await profile(f.p)).toEqual(completed);
  });

  it("uses floor-minute Money pricing, including zero price under one minute, and disables doubling after cards run out", async () => {
    const f = await fixture({ myProgress: 3, isDoubleAward: true }); fixedDrop(f); await putItem(f,11916,2);
    const before = wallet(f.p); await f.request(3); await f.tick(301); await f.request(4);
    expect(awardLogs(f)).toEqual([{ floor:1,gp:1320,items:[],hardCurrency:0 },
      { floor:2,gp:2700,items:[{ templateId:11005,count:4 }],hardCurrency:4 }, { floor:3,gp:2040,items:[],hardCurrency:0 }]);
    expect(f.p.info.Money).toBe(before.money); expect((await progress(f.p)).isDoubleAward).toBe(false);
  });

  it.each(["Sys_Users_Detail", "Sys_Users_Goods", "User_Messages"] as const)
  ("rolls back card, GP, bound overflow mail and logs together on %s failure, then retries once", async table => {
    const f = await fixture({ currentFloor:2,myProgress:2,isDoubleAward:true }); fixedDrop(f);
    const card = await putItem(f,11916,2); f.p.propBag.capacity = 1;
    await f.request(3); const before = wallet(f.p), row = await progress(f.p), item = card.toRow(), mark = awardLogs(f).length;
    const remove = await failWrites(table); await f.tick(120);
    expect(wallet(f.p)).toEqual(before); expect(await progress(f.p)).toEqual(row); expect(card.toRow()).toEqual(item);
    expect(await mails(f.p)).toHaveLength(0); expect(awardLogs(f)).toHaveLength(mark);
    await expect(f.owner.drain()).rejects.toThrow();
    await remove(); await f.owner.beforeQuit(f.p); await f.owner.drain();
    expect(f.p.info.GP).toBe(before.gp+2700); expect(f.p.info.hardCurrency).toBe(before.hardCurrency+4); expect(card.Count).toBe(1);
    const received = await mails(f.p); expect(received).toHaveLength(1);
    const id = Number(received[0]!.Annex1), [attachment] = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID,id));
    expect(attachment).toMatchObject({ UserID:0,TemplateID:11005,Count:4,IsBinds:true,IsExist:true });
    expect(awardLogs(f)).toHaveLength(mark+1); await f.owner.beforeQuit(f.p); expect(await mails(f.p)).toEqual(received);
  });

  it.each(["quit", "shutdown"] as const)("drains an accepted tick after closed/quitting on %s without accepting more seconds", async method => {
    const f = await fixture(); await f.request(3); await f.tick(119); const block = await blockedClient(f), before = wallet(f.p);
    f.advance(1); f.owner.tick(); f.p.quitting = Promise.resolve(); f.client.disconnect("isolated lifecycle test");
    let done = false;
    if (method === "shutdown") f.owner.beginShutdown();
    const finish = (method === "quit" ? f.owner.beforeQuit(f.p) : f.owner.drain()).then(() => { done=true; });
    await flush(); expect(done).toBe(false); expect(f.p.info.GP).toBe(before.gp);
    block.release(); await Promise.all([block.work, finish, f.client.idle()]);
    expect((await profile(f.p)).GP).toBe(before.gp+660); expect(f.p.info.GP).toBe(before.gp+660);
    const row = await progress(f.p); f.advance(120); f.owner.tick(); await f.client.idle(); expect(await progress(f.p)).toEqual(row);
    expect(awardLogs(f).map(x=>x.floor)).toEqual([1]);
  });

  it("holds the actual current fight through SQL and publication when a fight starts after tick acceptance", async () => {
    const f = await fixture(); await f.request(3); await f.tick(119); const block = await blockedClient(f), gp=f.p.info.GP;
    f.advance(1); f.owner.tick();
    const gate = new WorldBossSettlementGate(), initialRelease = await gate.acquire(), requested=deferred();
    const room = new BaseRoom(sequence+10000,{ onRoomChanged:()=>{},lang:key=>key }); room.start();
    room.updateRoom("isolated current fight","",1,3,1201); room.addPlayer(f.p);
    room.startGame({ id:sequence+20000,mapId:1201,processData:()=>{},removePlayer:()=>{},stop:()=>{},
      holdWorldBossSettlement:async()=>{requested.resolve();return gate.acquire();} });
    const held:boolean[]=[];
    vi.spyOn(f.p,"send").mockImplementation(pkt=>{held.push(gate.held);f.recordSend(pkt);});
    block.release(); await requested.promise; await flush();
    expect(f.p.info.GP).toBe(gp); expect((await profile(f.p)).GP).toBe(gp);
    initialRelease(); await Promise.all([block.work,f.client.idle()]); await gate.waitIdle();
    expect(f.p.info.GP).toBe(gp+660); expect(held.length).toBeGreaterThan(0); expect(held.every(Boolean)).toBe(true);
  });

  it("publishes the per-floor log only after SQL COMMIT and complete live publication", async () => {
    const f=await fixture(); await f.request(3); await f.tick(119); const gp=f.p.info.GP, entered=deferred(), release=deferred();
    f.ctx.db={...h,db:new Proxy(h.db,{get(target,key,receiver){
      if(key!=="transaction")return Reflect.get(target,key,receiver);
      return async(work:(tx:Database)=>Promise<unknown>)=>{
        const result=await target.transaction(tx=>work(tx as unknown as Database)); entered.resolve(); await release.promise; return result;
      };
    }}) as Database};
    f.advance(1);f.owner.tick();
    try{
      await entered.promise; expect((await profile(f.p)).GP).toBe(gp+660); expect(f.p.info.GP).toBe(gp);expect(awardLogs(f)).toEqual([]);
      release.resolve(); await f.client.idle();
      expect(f.p.info.GP).toBe(gp+660);expect(awardLogs(f).map(x=>x.floor)).toEqual([1]);
    }finally{release.resolve();await f.client.idle();}
  });

  it("finishes a real inbound 91 awaiting a deferred fight command before the queued sweep takes that fight gate", async () => {
    const f = await fixture(); await f.request(3); await f.tick(119);
    const gate = new WorldBossSettlementGate(), externalRelease = await gate.acquire(), entered = deferred(), order: string[] = [];
    const room = new BaseRoom(sequence + 30000, { onRoomChanged: () => {}, lang: key => key });
    room.start(); room.updateRoom("isolated deferred inbound command", "", 1, 3, 1201); room.addPlayer(f.p);
    const hold = vi.fn(() => gate.acquire());
    let handlerFinished = false;
    room.startGame({ id: sequence + 40000, mapId: 1201, removePlayer: () => {}, stop: () => {}, holdWorldBossSettlement: hold,
      processData: (from, packet) => {
        expect(from).toBe(f.p); expect(packet.code).toBe(91); entered.resolve();
        return gate.defer(() => { expect(packet.readByte()).toBe(25); handlerFinished = true; order.push("91"); });
      } });
    registerRooms(f.handlers);
    vi.spyOn(f.p, "send").mockImplementation(packet => {
      if (packet.code === 131 && packet.body()[0] === 7) order.push("sweep"); f.recordSend(packet);
    });
    const gp = f.p.info.GP;
    f.sendPacket(91, packet => packet.writeByte(25)); await entered.promise;
    f.advance(1); f.owner.tick();
    expect(handlerFinished).toBe(false); expect(hold).not.toHaveBeenCalled(); expect(f.p.info.GP).toBe(gp);
    externalRelease(); await f.client.idle(); await f.owner.drain(); await gate.waitIdle();
    expect(handlerFinished).toBe(true); expect(order).toEqual(["91", "sweep"]); expect(hold).toHaveBeenCalledTimes(1);
    expect(gate.held).toBe(false); expect(f.p.info.GP).toBe(gp + 660); expect((await profile(f.p)).GP).toBe(gp + 660);
    expect(awardLogs(f)).toEqual([{ floor: 1, gp: 660, items: [], hardCurrency: 0 }]);
  },5000);

  it("never takes a fight lease when a committed revision cancels a queued tick before it starts", async () => {
    const f = await fixture(); await f.request(3); await f.tick(119);
    const block = await blockedClient(f), gate = new WorldBossSettlementGate(), externalRelease = await gate.acquire(), gp = f.p.info.GP;
    const hold = vi.fn(() => gate.acquire()), room = new BaseRoom(sequence + 50000, { onRoomChanged: () => {}, lang: key => key });
    room.start(); room.updateRoom("isolated cancelled tick", "", 1, 3, 1201); room.addPlayer(f.p);
    room.startGame({ id: sequence + 60000, mapId: 1201, processData: () => {}, removePlayer: () => {}, stop: () => {}, holdWorldBossSettlement: hold });
    f.advance(1); f.owner.tick(); expect(hold).not.toHaveBeenCalled();
    await h.db.update(player.Sys_Users_Labyrinth).set({ isCleanOut: false }).where(eq(player.Sys_Users_Labyrinth.UserID, f.p.id));
    const paused = await progress(f.p); f.owner.sync(f.p, paused);
    externalRelease(); block.release(); await Promise.all([block.work, f.client.idle()]); await f.owner.drain(); await gate.waitIdle();
    expect(hold).not.toHaveBeenCalled(); expect(gate.held).toBe(false); expect(f.p.info.GP).toBe(gp);
    expect(await progress(f.p)).toEqual(paused); expect(awardLogs(f)).toEqual([]);
  });

  it("refuses an outdated durable snapshot without changing the replacement row or wallet", async () => {
    const f=await fixture(); await f.request(3); const old=snapshot(await progress(f.p)), before=wallet(f.p);
    await h.db.update(player.Sys_Users_Labyrinth).set({currentFloor:2,remainTime:120,currentRemainTime:120})
      .where(eq(player.Sys_Users_Labyrinth.UserID,f.p.id));
    const replaced=await progress(f.p), mark=awardLogs(f).length;
    await expect(f.client.enqueueCombatSettlement(()=>f.p.withWorldBossAward(()=>advanceLabyrinthCleanOut(f.ctx,f.p,old,120,120))))
      .rejects.toThrow("run was replaced");
    expect(await progress(f.p)).toEqual(replaced); expect(wallet(f.p)).toEqual(before); expect(awardLogs(f)).toHaveLength(mark);
  });

  it("clears a paused phase on explicit reset and UTC day change rather than rewarding a stale generation", async () => {
    const f=await fixture(); await f.request(3); await f.tick(119); await f.request(5); await f.request(6);
    expect(await progress(f.p)).toMatchObject({currentFloor:1,remainTime:0,isCleanOut:false,isInGame:false,ProcessAward:initProcessAward()});
    await f.request(3); await f.tick(1); expect(awardLogs(f)).toEqual([]); await f.tick(119);
    expect(awardLogs(f).map(x=>x.floor)).toEqual([1]);
    f.advance(86400); await f.request(2); const reset=await progress(f.p);
    expect(reset).toMatchObject({currentFloor:1,isCleanOut:false,isInGame:false,accumulateExp:0,ProcessAward:initProcessAward()});
    f.owner.tick(); await f.client.idle(); expect(await progress(f.p)).toEqual(reset); expect(awardLogs(f).map(x=>x.floor)).toEqual([1]);
  });
});
