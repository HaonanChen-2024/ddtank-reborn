import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, migrateDb, seedDatabase, game, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { PveGame, type FightEvent } from "@ddt/fight";
import { GamePlayer } from "../src/game/player.js";
import { ItemInfo } from "../src/game/item.js";
import { defaultMatch } from "../src/game/player-info.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { World, type ServerContext } from "../src/session/context.js";
import { worldBossCreationDelay } from "../src/game/world-boss-access.js";
import { parseWorldBossSetup } from "../src/handlers/world-boss-setup.js";
import { registerRooms } from "../src/handlers/rooms.js";
import { registerEvents, eventsRuntime, worldBossFightWindow, worldBossOpen, eventsOnQuit } from "../src/handlers/events.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import { RoomMgr } from "../src/rooms/room-mgr.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import type { FightEngine, FightGame, StartPveOptions } from "../src/fight/types.js";
import type { ActiveWindow } from "../src/game/scheduler.js";
import { data, pves } from "../../../packages/fight/test/pve-data.js";

let db: DbHandle, weapon: typeof game.Shop_Goods.$inferSelect, seq = 0;
const NOW = Date.UTC(2026, 9, 13, 12);
beforeAll(async () => {
  db = await createDb("pglite:memory"); await migrateDb(db); await seedDatabase(db, { only: ["Shop_Goods"] });
  weapon = (await db.db.select().from(game.Shop_Goods)).find((x) => x.TemplateID === 7001)!;
});
afterAll(async () => { await db.close(); });
afterEach(() => { vi.restoreAllMocks(); });
function window(id = 1): ActiveWindow {
  return { key: `access:${id}`, start: new Date(NOW), end: new Date(NOW + 3_600_000), ev: { id, kind: "worldboss", title: "test", enabled: true,
    weekdays: "0,1,2,3,4,5,6", startTime: "12:00", durationMin: 60, startDate: null, endDate: null, params: { pveId: 1243, bossHp: 1_000_000 } } };
}
async function character(id?: number) {
  if (!id) id = (await db.db.insert(player.Sys_Users_Detail).values({ UserName: `access_${++seq}`, NickName: `Access${seq}`, IsFirst: 1, Grade: 8, Money: 2000 }).returning())[0]!.UserID;
  const info = (await loadPlayerInfo(db.db, id))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect() {}, remoteAddress: "isolated-test" }, info, defaultMatch(id), 1, "test");
  const item = ItemInfo.createFromTemplate(weapon, 1, 0); item.UserID = id; item.Place = 6; p.equipBag.loadItems([item]);
  p.info.FightPower = 100; return { p, sent };
}
async function fixture(realEngine = false) {
  const { p, sent } = await character(); let now = NOW;
  const ctx = { db, world: new World(), now: () => new Date(now), lang: { t: (k: string) => k }, log: { info() {}, debug() {}, warn() {}, error() {} } } as unknown as ServerContext;
  ctx.world.add(p); const rt = eventsRuntime(ctx); await rt.onStart(window());
  const starts: StartPveOptions[] = [], games: FightGame[] = [];
  const stub: FightEngine = { name: "access-test", startPvp: () => null, startPve: vi.fn((s: StartPveOptions) => {
    starts.push(s); const g = { id: starts.length, mapId: s.pveId, processData() {}, removePlayer(m) { s.onParticipantFinished?.(m.id); }, stop() { s.onStopped(); } } satisfies FightGame;
    games.push(g); return g;
  }) };
  const engine = new DdtFightEngine({ manualClock: true, seed: () => 9, pve: { data, pveInfo: (id) => pves.get(id), drop: () => null },
    worldBossWindow: (id) => worldBossFightWindow(ctx, id) });
  const rooms = new RoomMgr({ maxRooms: 5, fight: realEngine ? engine : stub, lang: (k) => k, random: () => 0, worldBossAccess: rt.bossAccess }); ctx.rooms = rooms;
  const registry = new HandlerRegistry(); registerRooms(registry); registerEvents(registry);
  const send = async (code: number, fill: (pkt: GSPacket) => void = () => {}, who = p) => {
    const out = new GSPacket(code); fill(out); const pkt = GSPacket.parse(out.encode());
    await registry.get(code)!.handle(ctx, { player: who } as GameClient, pkt); return pkt;
  };
  const create = async (type = 14) => { await send(94, (o) => { o.writeInt(0); o.writeByte(type); o.writeByte(3); o.writeUTF(""); o.writeUTF("random"); }); rooms.tick(now); return p.currentRoom!; };
  const setup = async (layout: "A" | "B" | "C" = "A", map = 1243, type = 14) => { const pkt = setupPacket(layout, map, type); await registry.get(94)!.handle(ctx, { player: p } as GameClient, pkt); rooms.tick(now); return pkt; };
  const start = async (code = 94) => { await send(code, (o) => { if (code === 94) o.writeInt(7); }); rooms.tick(now); };
  return { p, sent, ctx, rt, rooms, registry, engine, stub, starts, games, send, create, setup, start, setTime: (ms: number) => { now = NOW + ms; } };
}
function setupPacket(layout: "A" | "B" | "C", map = 1243, type = 14) {
  const out = new GSPacket(94); out.writeInt(2); out.writeInt(map); out.writeByte(type);
  if (layout !== "A") out.writeBoolean(false);
  out.writeUTF("0.123456789"); out.writeUTF(""); out.writeByte(3); out.writeByte(0); out.writeInt(0); out.writeBoolean(false);
  if (layout === "B") out.writeInt(123456); // Actual original sendGameRoomSetUp param10.
  return GSPacket.parse(out.encode());
}

describe("world boss setup packet boundaries", () => {
  it.each(["A", "B", "C"] as const)("accepts the complete %s layout and consumes exactly its bytes", (layout) => {
    const pkt = setupPacket(layout); pkt.readInt();
    expect(parseWorldBossSetup(pkt)).toMatchObject({ mapId: 1243, roomType: 14, password: "0.123456789", name: "", timeMode: 3, hardLevel: 0, isOpenBoss: false });
    expect(pkt.dataLeft).toBe(0);
  });
  it("rejects truncation despite zero-padded backing, invalid bools and unknown trailing bytes", () => {
    for (const layout of ["A", "B", "C"] as const) {
      const bytes = setupPacket(layout).encode();
      for (let n = 24; n < bytes.length; n++) {
        if (layout === "B" && n === bytes.length - 4) continue; // Explicitly supported C legacy.
        const copy = bytes.slice(0, n); new DataView(copy.buffer).setInt16(2, n);
        const p = GSPacket.parse(copy); p.readInt(); expect(parseWorldBossSetup(p), `${layout}:${n}`).toBeNull();
      }
      const p = setupPacket(layout); p.offset = p.length; p.writeByte(255); p.offset = 24;
      expect(parseWorldBossSetup(p)).toBeNull();
    }
    const bad = setupPacket("C"); bad.buffer[29] = 2; bad.offset = 24; expect(parseWorldBossSetup(bad)).toBeNull();
  });
  it("keeps ordinary Dungeon and Freshman setup unchanged", async () => {
    const f = await fixture(); await f.create(4); await f.setup("C", 1001, 4); expect(f.p.currentRoom?.MapId).toBe(1001);
    await f.setup("A", 1001, 10); expect(f.p.currentRoom?.RoomType).toBe(10); expect(f.p.currentRoom?.TimeMode).toBe(3);
  });
});

describe("world boss unified free admission", () => {
  it.each([[0, 45], [999999, 45], [1000000, 120], [1999999, 120], [2000000, 180], [3999999, 180], [4000000, 240], [5999999, 240], [6000000, 300], [7999999, 300], [8000000, 600]])("reference fight power %i gives %i seconds", (fp, sec) => {
    expect(worldBossCreationDelay(fp)).toBe(sec);
  });
  it("runs the original 102 entry → 94 create/setup/start → status2 chain; duplicate starts do not create a second game", async () => {
    const f = await fixture(); await f.send(102, (o) => o.writeByte(32)); await f.send(102, (o) => { o.writeByte(34); o.writeInt(265); o.writeInt(1030); });
    await f.create(); await f.setup();
    await f.send(94, (o) => o.writeInt(7)); await f.send(102, (o) => { o.writeByte(36); o.writeByte(2); }); await f.send(86);
    f.rooms.tick(NOW); expect(f.starts).toHaveLength(1); expect(f.p.currentRoom?.IsPlaying).toBe(true);
    await f.start(); await f.start(86); expect(f.starts).toHaveLength(1);
    expect(f.rt.bossAccess.remaining(f.p.id)).toBe(45); expect(f.p.info.Money).toBe(2000);
  });
  it("uses both deadlines, ignores repeated finish/old window, and survives scene leave and same-id session replacement", async () => {
    const f = await fixture(); await f.create(); await f.setup(); await f.start();
    f.setTime(40_000); f.starts[0]!.onParticipantFinished!(f.p.id); f.games[0]!.stop();
    expect(f.rt.bossAccess.remaining(f.p.id)).toBe(15);
    f.setTime(50_000); f.starts[0]!.onParticipantFinished!(f.p.id); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(5);
    await f.send(102, (o) => { o.writeByte(36); o.writeByte(1); });
    await f.send(102, (o) => o.writeByte(33)); eventsOnQuit(f.ctx, f.p); f.ctx.world.remove(f.p);
    const next = await character(f.p.id); f.ctx.world.add(next.p);
    expect(f.rt.bossAccess.check([next.p]).error).toContain("5 秒");
    f.setTime(54_999); expect(f.rt.bossAccess.check([next.p]).error).toContain("1 秒");
    f.setTime(55_000); expect(f.rt.bossAccess.check([next.p])).toEqual({ key: window().key });
    await f.rt.onEnd(window()); await f.rt.onStart(window(2));
    f.starts[0]!.onParticipantFinished!(next.p.id); expect(f.rt.bossAccess.remaining(next.p.id)).toBe(0);
  });
  it("a short fight still observes the creation interval, and UI reentry returns max remaining in seconds", async () => {
    const f = await fixture(); await f.create(); await f.setup(); await f.start();
    f.setTime(5_000); f.starts[0]!.onParticipantFinished!(f.p.id); f.games[0]!.stop();
    expect(f.rt.bossAccess.remaining(f.p.id)).toBe(40);
    await f.send(102, (o) => o.writeByte(32)); const reply = f.sent.filter((x) => x.code === 102 && x.buffer[20] === 2).at(-1)!; reply.offset = 21;
    expect(reply.readBoolean()).toBe(true); expect(reply.readBoolean()).toBe(false); expect(reply.readInt()).toBe(40);
    await f.start(86); expect(f.starts).toHaveLength(1);
  });
  it("blocks direct create, conversion, 86 and actual start with current eligibility instead of trusting a prior scene entry", async () => {
    const f = await fixture(); f.rt.boss.blood = 0; expect(await f.create()).toBeNull();
    f.rt.boss.blood = 100; await f.create(4); const room = f.p.currentRoom!;
    f.rt.boss.blood = 0; await f.setup(); expect(room.RoomType).toBe(4);
    f.rt.boss.blood = 100; await f.setup(); expect(room.RoomType).toBe(14);
    f.p.equipBag.removeItemAt(6); await f.start(86); expect(f.starts).toHaveLength(0);
    expect(room.IsPlaying).toBe(false);
  });
  it("rechecks closing windows, host/members and ongoing rooms at queued execution", async () => {
    const f = await fixture(); await f.create(); await f.setup();
    await f.send(94, (o) => o.writeInt(7)); f.setTime(3_600_000); f.rooms.tick(); expect(f.starts).toHaveLength(0);
    f.setTime(0); await f.send(86); f.p.currentRoom!.host = null; f.rooms.tick(); expect(f.starts).toHaveLength(0);
    f.p.currentRoom!.host = f.p; await f.start(); const room = f.p.currentRoom!;
    f.rooms.setupChange(room, { mapId: 1001, roomType: 4, password: "", name: "", timeMode: 3, hardLevel: 0, levelLimits: 0, isCrosszone: false, isOpenBoss: false });
    f.rooms.tick(); expect(room.RoomType).toBe(14); expect(room.game).toBe(f.games[0]);
  });
  it("rechecks eligibility after the existing award barrier releases", async () => {
    const f = await fixture(); await f.create(); await f.setup(); let release!: () => void;
    f.p.worldBossAwardPending = new Promise<void>((r) => { release = r; }); await f.start(); expect(f.starts).toHaveLength(0);
    f.rt.boss.blood = 0; f.p.worldBossAwardPending = null; release(); await Promise.resolve(); await Promise.resolve(); f.rooms.tick();
    expect(f.starts).toHaveLength(0); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(0);
  });
  it("invalid setup packets do not mutate a real room; queue-time pve and session checks fail closed", async () => {
    const f = await fixture(); await f.create(); const room = f.p.currentRoom!;
    const original = { map: room.MapId, type: room.RoomType, password: room.Password };
    const bytes = setupPacket("A").encode();
    for (let n = 24; n < bytes.length; n++) {
      const copy = bytes.slice(0, n); new DataView(copy.buffer).setInt16(2, n);
      await f.registry.get(94)!.handle(f.ctx, { player: f.p } as GameClient, GSPacket.parse(copy)); f.rooms.tick();
      expect({ map: room.MapId, type: room.RoomType, password: room.Password }).toEqual(original);
    }
    await f.setup("A", 99999); expect(room.MapId).toBe(original.map);
    const stale = setupPacket("A"); await f.registry.get(94)!.handle(f.ctx, { player: f.p } as GameClient, stale);
    f.ctx.world.remove(f.p); f.rooms.tick(); expect(room.MapId).toBe(original.map); expect(f.starts).toHaveLength(0);
  });
  it.each(["null", "stop", "finish-before-return"])("handles synchronous startup %s without orphan admission", async (mode) => {
    const f = await fixture(); await f.create(); await f.setup();
    vi.spyOn(f.stub, "startPve").mockImplementation((s) => {
      if (mode === "null") return null;
      s.onParticipantFinished?.(f.p.id);
      if (mode === "stop") s.onStopped();
      return { id: 20, mapId: 1243, processData() {}, removePlayer() {}, stop() { s.onStopped(); } };
    });
    await f.start(); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(mode === "finish-before-return" ? 45 : 0);
    expect(f.p.currentRoom?.IsPlaying).toBe(mode === "finish-before-return");
  });
});

describe("actual DdtGame lifecycle and unavailable paid actions", () => {
  it("sets return delay once from a real adapter final event, ignores later stop, and protects the next window", async () => {
    const f = await fixture(true); await f.create(); await f.setup(); await f.start(); const g = [...f.engine.games.values()][0]!; expect(g).toBeDefined();
    f.setTime(50_000);
    const e: FightEvent = { cmd: "GAME_ALL_MISSION_OVER", code: 115, livingId: 0, isWin: false, resources: [], roomType: 14, gameType: 4,
      players: [{ userId: f.p.id, totalKill: 0, totalHurt: 0, totalScore: 0, totalCure: 0, totalExp: 0, isWin: false, canTakeOut: 0, turnNum: 1 }] };
    vi.spyOn(g.game, "update").mockReturnValueOnce([e]); g.tick(Date.now() + 1); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(15);
    f.setTime(55_000); g.stop(); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(10);
  });
  it("real room exit triggers participant finish and first-tick failure leaves no game or cooldown", async () => {
    const f = await fixture(true); await f.create(); await f.setup();
    const tick = vi.spyOn(PveGame.prototype, "update").mockImplementationOnce(() => { throw new Error("initial tick failed"); });
    await f.start(); expect(f.engine.games.size).toBe(0); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(0); expect(f.p.currentRoom?.game).toBeNull(); tick.mockRestore();
    await f.start(); f.setTime(50_000); await f.send(94, (o) => o.writeInt(5)); f.rooms.tick();
    expect(f.p.currentRoom).toBeNull(); expect(f.engine.games.size).toBe(0); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(15);
  });
  it("one participant exiting a real shared game does not finish the other player's attempt", async () => {
    const f = await fixture(true), other = await character(); f.ctx.world.add(other.p);
    await f.create(); await f.setup(); const room = f.p.currentRoom!; room.addPlayer(other.p); room.updatePlayerState(other.p, 1, false);
    await f.start(); expect(f.engine.games.size).toBe(1); f.setTime(50_000);
    f.rooms.exitRoom(room, f.p); f.rooms.tick(); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(15);
    expect(f.rt.bossAccess.check([other.p]).error).toContain("结束当前战斗"); expect(f.engine.games.size).toBe(1);
    f.setTime(60_000); room.game!.stop(); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(5); expect(f.rt.bossAccess.remaining(other.p.id)).toBe(15);
  });
  it("37 and all 38 shapes fail without changing currencies, status, cooldown or sending success", async () => {
    const f = await fixture(); f.rt.boss.players.set(f.p.id, { x: 1, y: 2, state: 3 });
    const before = structuredClone(f.p.info);
    for (const [sub, values] of [[37, []], [37, [1]], [37, [2, 1]], [38, []], [38, [0]], [38, [1, 999999]]] as const) {
      await f.send(102, (o) => { o.writeByte(sub); for (const n of values) o.writeInt(n); });
    }
    await f.send(102, (o) => { o.writeByte(37); o.writeInt(2); o.writeBoolean(true); }); // Exact five-byte C# extension too.
    expect(structuredClone(f.p.info)).toEqual(before); expect(f.rt.boss.players.get(f.p.id)?.state).toBe(3); expect(f.rt.bossAccess.remaining(f.p.id)).toBe(0);
    expect(f.sent.some((p) => p.code === 102 && p.buffer[20] === 11)).toBe(false);
    expect(f.sent.filter((p) => p.code === 102 && p.buffer[20] === 12).map((p) => [...p.body()])).toEqual([[12, 0], [12, 0], [12, 0]]);
    const open = worldBossOpen(f.rt, f.p); expect([...open.body().slice(-6)]).toEqual([0, 0, 0, 0, 1, 0]);
  });
});
