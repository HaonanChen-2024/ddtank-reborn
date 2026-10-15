import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, seedDatabase, game, player, type DbHandle } from "@ddt/db";
import { GSPacket, RollingKeyCipher, encodeFrame } from "@ddt/protocol";
import * as Fight from "@ddt/fight";
import { loadPlayerInfo } from "../src/db/characters.js";
import { Templates } from "../src/db/templates.js";
import type { LabyrinthFightBinding } from "../src/fight/ddt.js";
import type { FightGame, StartPveOptions } from "../src/fight/types.js";
import { WorldBossSettlementGate } from "../src/fight/world-boss-settlement.js";
import { labyrinthCombatOwner, labyrinthConfigurationReady } from "../src/game/labyrinth-combat.js";
import { initProcessAward, labyrinthHandler } from "../src/game/labyrinth.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { BaseRoom } from "../src/rooms/room.js";
import { GameClient } from "../src/session/client.js";
import { World, type ServerContext } from "../src/session/context.js";
import { quitPlayer } from "../src/session/login.js";

// Isolated owner/persistence tests, never the running local game. The synthetic
// headers/script inventory below are admission fixtures, NOT production content
// or evidence that the missing original Labyrinth scripts can execute.
let h: DbHandle, base: Templates, sequence = 0;
const NOW = new Date("2026-10-16T12:00:00Z");
const BRAINS = [
  [40004, "DCSM40004Boss"], [40007, "DCSM40006Boss"], [40009, "DCSM40008Boss"],
  [40022, "DCSM40016Boss"], [40030, "DCSM40022Boss"], [40032, "DCSM40024Boss"],
] as const;
const GAME_SCRIPT = "GameServerScript.AI.Game.Labyrinth";
const MISSION_SCRIPT = "GameServerScript.AI.Messions.IsolatedLabyrinthOwnerFixture";
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods", "Pve_Info", "Mission_Info", "NPC_Info"] });
  base = new Templates();
  base.items = new Map((await h.db.select().from(game.Shop_Goods)).map(row => [row.TemplateID, row]));
  base.pveInfos = new Map((await h.db.select().from(game.Pve_Info)).map(row => [row.ID, row]));
  base.missions = new Map((await h.db.select().from(game.Mission_Info)).map(row => [row.Id, row]));
  base.npcs = new Map((await h.db.select().from(game.NPC_Info)).map(row => [row.ID, row]));
});
afterAll(async () => { await h.close(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await h.db.execute(sql`DROP TRIGGER IF EXISTS test_labyrinth_owner_failure ON player."Sys_Users_Labyrinth"`);
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_labyrinth_owner_failure()`);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(yes => setImmediate(yes));

function testConfiguration(templates: Templates) {
  const scripts: ReturnType<typeof Fight.listScripts> = [
    { name: GAME_SCRIPT, kind: "game", origin: "isolated-owner-fixture" },
    { name: MISSION_SCRIPT, kind: "mission", origin: "isolated-owner-fixture" },
    ...BRAINS.map(([, name]) => ({ name: `GameServerScript.AI.NPC.${name}`, kind: "brain" as const, origin: "isolated-owner-fixture" })),
  ];
  const old = templates.pveInfos.values().next().value!;
  templates.pveInfos.set(401, { ...old, ID: 401, Type: 15, LevelLimits: 19, SimpleGameScript: GAME_SCRIPT });
  const mission = templates.missions.values().next().value!;
  for (let id = 40001; id <= 40030; id++) templates.missions.set(id, { ...mission, Id: id, Script: MISSION_SCRIPT });
  const npc = templates.npcs.values().next().value!;
  for (const [id, name] of BRAINS) templates.npcs.set(id, { ...npc, ID: id, Script: `GameServerScript.AI.NPC.${name}` });
  vi.spyOn(Fight, "listScripts").mockImplementation(() => scripts);
  return scripts;
}

async function fixture(ready = true) {
  const [who] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `lab_owner_${++sequence}`, NickName: `Lab owner ${sequence}`, IsFirst: 1, Grade: 20 }).returning();
  const info = (await loadPlayerInfo(h.db, who!.UserID))!, templates = new Templates();
  templates.items = new Map(base.items); templates.pveInfos = new Map(base.pveInfos);
  templates.missions = new Map(base.missions); templates.npcs = new Map(base.npcs);
  const scripts = ready ? testConfiguration(templates) : null;
  const frames: Uint8Array[] = [], handlers = new HandlerRegistry();
  let now = NOW;
  const ctx = { db: h, templates, world: new World(), now: () => now,
    cfg: { LOGIN_TIMEOUT_SEC: 0, PACKET_RATE_PER_SEC: 1000, PACKET_RATE_BURST: 1000 },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, lang: { t: (key: string) => key },
    rooms: { waitingRemove: vi.fn(), sendUpdateRoom: vi.fn() },
  } as unknown as ServerContext;
  const client = new GameClient({ kind: "fake", remoteAddress: "labyrinth-owner-test", write: bytes => frames.push(bytes), close: () => {} }, ctx, handlers);
  const p = new GamePlayer(client, info, defaultMatch(info.ID), 1, "test"); client.player = p; ctx.world.add(p);
  const room = new BaseRoom(sequence, { onRoomChanged: () => {}, lang: key => key });
  room.start(); room.updateRoom("isolated Labyrinth", "", 15, 3, 0); expect(room.addPlayer(p)).toBe(true);
  const owner = labyrinthCombatOwner(ctx);
  const options = (): StartPveOptions => ({ roomId: room.RoomId, roomType: room.RoomType, gameType: room.GameType,
    timeType: room.TimeMode, pveId: room.MapId, hardLevel: room.HardLevel, levelLimits: room.LevelLimits,
    currentFloor: room.currentFloor, players: [p], onStopped: () => {} });
  const fight = (id = sequence + 1000): FightGame => ({ id, mapId: 1201, processData: () => {}, removePlayer: () => {}, stop: () => {} });
  const start = async () => {
    expect(await owner.prepareStart(p, room)).toBe(true);
    const battle = fight(), binding = owner.admit(options(), battle.id)!;
    expect(binding).not.toBeNull(); binding.started(battle); room.startGame(battle);
    return { binding, battle };
  };
  const cipher = new RollingKeyCipher(true), send = (code: number, fill?: (pkt: GSPacket) => void) => {
    const pkt = new GSPacket(code); fill?.(pkt); client.receive(encodeFrame(pkt, cipher));
  };
  return { p, ctx, client, room, owner, frames, options, fight, start, scripts, handlers, send, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const progress = async (f: Fixture) => (await h.db.select().from(player.Sys_Users_Labyrinth).where(eq(player.Sys_Users_Labyrinth.UserID, f.p.id)))[0];
const profile = async (f: Fixture) => (await h.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, f.p.id)))[0]!;
const candidate = (f: Fixture, floor = 1): Parameters<LabyrinthFightBinding["award"]>[1] => ({ cmd: "LABYRINTH_AWARD", code: 0, livingId: 1, userId: f.p.id, floor, missionId: 40000 + floor, bigAward: floor % 2 === 0 });
async function failWrites(f: Fixture) {
  await h.db.execute(sql.raw(`CREATE FUNCTION player.test_labyrinth_owner_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."UserID" = ${f.p.id} THEN RAISE EXCEPTION 'owner injected SQL failure'; END IF; RETURN NEW; END; $$`));
  await h.db.execute(sql`CREATE TRIGGER test_labyrinth_owner_failure BEFORE UPDATE ON player."Sys_Users_Labyrinth" FOR EACH ROW EXECUTE FUNCTION player.test_labyrinth_owner_failure()`);
  return async () => { await h.db.execute(sql`DROP TRIGGER test_labyrinth_owner_failure ON player."Sys_Users_Labyrinth"`); };
}
async function blockedClient(f: Fixture) {
  const entered = deferred(), release = deferred();
  const work = f.client.enqueueActivityExchange(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  return { release: release.resolve, work };
}

describe("Labyrinth admission is bound to real server objects", () => {
  it("refuses the current production seed with missing 401/30 mission headers/exact brains without writing player data", async () => {
    const f = await fixture(false), before = await profile(f);
    expect(base.pveInfos.has(401)).toBe(false);
    expect(Array.from({ length: 30 }, (_, n) => base.missions.has(40001 + n)).some(Boolean)).toBe(false);
    expect(labyrinthConfigurationReady(f.ctx, f.room.HardLevel)).toBe(false);
    expect(await f.owner.prepareStart(f.p, f.room)).toBe(false);
    expect(await progress(f)).toBeUndefined(); expect(await profile(f)).toEqual(before); expect(f.owner.busy(f.p)).toBe(false);
  });

  it.each(["pve", "mission", ...BRAINS.map(([, name]) => name)])("refuses an incomplete isolated configuration (%s) without creating a run row", async missing => {
    const f = await fixture();
    if (missing === "pve") f.ctx.templates.pveInfos.delete(401);
    else if (missing === "mission") f.ctx.templates.missions.delete(40030);
    else f.scripts!.splice(f.scripts!.findIndex(script => script.name === `GameServerScript.AI.NPC.${missing}`), 1);
    expect(await f.owner.prepareStart(f.p, f.room)).toBe(false); expect(await progress(f)).toBeUndefined();
  });

  it("preserves the original 401 level gate and refuses a low-level character without changing the database", async () => {
    const f = await fixture(); f.p.info.Grade = 18;
    await h.db.update(player.Sys_Users_Detail).set({ Grade: 18 }).where(eq(player.Sys_Users_Detail.UserID, f.p.id));
    const before = await profile(f);
    expect(await f.owner.prepareStart(f.p, f.room)).toBe(false);
    expect(await progress(f)).toBeUndefined(); expect(await profile(f)).toEqual(before); expect(f.owner.busy(f.p)).toBe(false);
  });

  it.each(["room-left", "expired", "configuration-changed"])("cancels a prepared run after %s instead of keeping it permanently busy", async reason => {
    const f = await fixture(); expect(await f.owner.prepareStart(f.p, f.room)).toBe(true);
    if (reason === "room-left") f.room.removePlayer(f.p);
    else if (reason === "expired") { f.advance(30001); expect(f.owner.busy(f.p)).toBe(true); }
    else { f.ctx.templates.missions.delete(40030); expect(f.owner.admit(f.options(), f.fight().id)).toBeNull(); }
    await f.client.idle(); await f.owner.drain();
    expect(f.owner.busy(f.p)).toBe(false); expect(await progress(f)).toMatchObject({ isInGame: false, completeChallenge: false });
  });

  it("prepares and consumes only once, then requires started plus the actual room.game before awarding", async () => {
    const f = await fixture(), gp = f.p.info.GP;
    expect(await f.owner.prepareStart(f.p, f.room)).toBe(true);
    expect(await progress(f)).toMatchObject({ isInGame: true, currentFloor: 1, ProcessAward: initProcessAward() });
    expect(f.room.MapId).toBe(401); expect(f.room.currentFloor).toBe(1);
    const battle = f.fight(), binding = f.owner.admit(f.options(), battle.id)!;
    expect(binding.processAwards.get(f.p.id)).toBe(initProcessAward());
    expect(f.owner.admit(f.options(), battle.id + 1)).toBeNull();
    expect(() => binding.award(f.p, candidate(f))).toThrow("no longer admitted");
    expect(() => binding.started(f.fight(battle.id + 1))).toThrow("Invalid Labyrinth fight binding");
    binding.started(battle);
    expect(() => binding.award(f.p, candidate(f))).toThrow("no longer admitted");
    f.room.startGame(battle);
    const award = binding.award(f.p, candidate(f));
    expect(binding.award(f.p, candidate(f))).toBe(award);
    await award; expect(f.p.info.GP).toBe(gp + 660); expect((await profile(f)).GP).toBe(gp + 660);
    await binding.award(f.p, candidate(f)); expect(f.p.info.GP).toBe(gp + 660);
    expect(await progress(f)).toMatchObject({ currentFloor: 2, myProgress: 2, accumulateExp: 660 });
    await binding.finish(false); expect(f.owner.busy(f.p)).toBe(false);
  });

  it.each(["room", "member", "floor", "mission", "user", "expired", "client"])("rejects a substituted admission %s", async mismatch => {
    const f = await fixture(); expect(await f.owner.prepareStart(f.p, f.room)).toBe(true);
    const options = f.options();
    if (mismatch === "room") options.roomId++;
    if (mismatch === "member") options.players = [{ ...f.p } as GamePlayer];
    if (mismatch === "floor") options.currentFloor++;
    if (mismatch === "mission") options.pveId++;
    if (mismatch === "user") { f.ctx.world.remove(f.p); }
    if (mismatch === "expired") f.advance(30001);
    const sink = f.p.sink;
    if (mismatch === "client") Object.defineProperty(f.p, "sink", { value: { ...sink }, configurable: true });
    expect(f.owner.admit(options, f.fight().id)).toBeNull();
    if (mismatch === "client") Object.defineProperty(f.p, "sink", { value: sink, configurable: true });
    if (mismatch === "user") f.ctx.world.add(f.p);
    await f.owner.beforeQuit(f.p);
  });

  it("rejects wrong event member, player, mission, floor, room or replaced socket before registering any award", async () => {
    const f = await fixture(), { binding, battle } = await f.start(), gp = f.p.info.GP;
    expect(() => binding.award({ ...f.p } as GamePlayer, candidate(f))).toThrow("no longer admitted");
    for (const raw of [{ ...candidate(f), userId: f.p.id + 1 }, { ...candidate(f), missionId: 40002 }, candidate(f, 2), { ...candidate(f), bigAward: true }])
      expect(() => binding.award(f.p, raw)).toThrow("does not match");
    f.room.game = f.fight(battle.id); expect(() => binding.award(f.p, candidate(f))).toThrow("no longer admitted"); f.room.game = battle;
    const sink = f.p.sink; Object.defineProperty(f.p, "sink", { value: { ...sink }, configurable: true });
    expect(() => binding.award(f.p, candidate(f))).toThrow("was replaced"); Object.defineProperty(f.p, "sink", { value: sink, configurable: true });
    expect(f.p.info.GP).toBe(gp); await binding.finish(false);
  });
});

describe("Labyrinth accepted outcomes survive lifecycle changes", () => {
  it("drains a real inbound combat candidate before a queued 131 packet, preserving the active progress row", async () => {
    const f = await fixture(), { binding } = await f.start(), gp = f.p.info.GP;
    let award!: Promise<void>;
    f.handlers.player(50, "isolated candidate producer", () => { award = binding.award(f.p, candidate(f)); });
    f.handlers.player(131, "real Labyrinth status", labyrinthHandler);
    f.send(50); f.send(131, pkt => pkt.writeInt(6));
    await f.client.idle(); await award;
    expect((await profile(f)).GP).toBe(gp + 660);
    expect(await progress(f)).toMatchObject({ isInGame: true, completeChallenge: true, currentFloor: 2, accumulateExp: 660 });
    await binding.finish(false);
  });

  it("carries the committed snapshot to the next floor and grants original even-floor GP, currency and material counts", async () => {
    const f = await fixture(), { binding } = await f.start(), gp = f.p.info.GP, hc = f.p.info.hardCurrency;
    const drop = vi.spyOn(f.ctx.templates, "pveDrop").mockReturnValue([{ templateId: 11005, count: 91, isBind: false, validDate: 0 }]);
    await binding.award(f.p, candidate(f)); await binding.award(f.p, candidate(f, 2));
    expect((await profile(f)).GP).toBe(gp + 660 + 1350); expect(f.p.info.hardCurrency).toBe(hc + 2);
    const goods = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, f.p.id));
    expect(goods.filter(item => item.IsExist)).toMatchObject([{ TemplateID: 11005, Count: 2, IsBinds: true }]);
    expect(drop).toHaveBeenCalledExactlyOnceWith("copy", 2, 40002);
    expect(await progress(f)).toMatchObject({ currentFloor: 3, accumulateExp: 2010 });
    await binding.finish(false);
  });

  it("refuses a durable row from a replaced run instead of applying the accepted callback to it", async () => {
    const f = await fixture(), { binding } = await f.start(), gp = f.p.info.GP;
    await h.db.update(player.Sys_Users_Labyrinth).set({ LastDate: new Date("2026-10-17T12:00:00Z") }).where(eq(player.Sys_Users_Labyrinth.UserID, f.p.id));
    await expect(binding.award(f.p, candidate(f))).rejects.toThrow("run was replaced");
    expect((await profile(f)).GP).toBe(gp); expect((await progress(f))?.accumulateExp).toBe(0);
    await expect(binding.finish(false)).rejects.toThrow("must commit before resetting");
    await expect(f.owner.drain()).rejects.toThrow("not durable");
  });

  it("commits an already accepted award after quitting, closed transport and room removal; finish resets only afterwards", async () => {
    const f = await fixture(), { binding } = await f.start(), block = await blockedClient(f), gp = f.p.info.GP;
    const award = binding.award(f.p, candidate(f)), finish = binding.finish(false);
    f.p.quitting = Promise.resolve(); f.p.currentRoom = null; f.p.isActive = false; f.client.disconnect("isolated test");
    expect((await progress(f))?.isInGame).toBe(true); expect(f.p.info.GP).toBe(gp);
    block.release(); await Promise.all([block.work, award, finish, f.client.idle()]);
    expect((await profile(f)).GP).toBe(gp + 660);
    expect(await progress(f)).toMatchObject({ currentFloor: 2, accumulateExp: 660, isInGame: false, completeChallenge: false, ProcessAward: initProcessAward() });
    expect(() => binding.award(f.p, candidate(f))).toThrow(); expect(f.owner.busy(f.p)).toBe(false);
  });

  it("refuses all 131 changes while the run owns its row, even before room.game exists", async () => {
    const f = await fixture(); expect(await f.owner.prepareStart(f.p, f.room)).toBe(true);
    const before = await progress(f), beforeProfile = await profile(f);
    for (const sub of [1, 2, 3, 4, 5, 6, 9]) {
      const pkt = new GSPacket(131); pkt.writeInt(sub); pkt.offset = 20;
      await labyrinthHandler(f.ctx, f.p, pkt);
    }
    expect(await progress(f)).toEqual(before); expect(await profile(f)).toEqual(beforeProfile);
    await f.owner.beforeQuit(f.p);
  });

  it("an old binding cannot award after a finished run and a new reset/admission", async () => {
    const f = await fixture(), first = await f.start();
    await first.binding.finish(false); f.room.onGameStopped();
    await h.db.update(player.Sys_Users_Labyrinth).set({ completeChallenge: true }).where(eq(player.Sys_Users_Labyrinth.UserID, f.p.id));
    const second = await f.start();
    expect(() => first.binding.award(f.p, candidate(f))).toThrow("was replaced");
    await second.binding.award(f.p, candidate(f)); await second.binding.finish(false);
    expect((await progress(f))?.accumulateExp).toBe(660);
  });

  it("SQL failure keeps award and reset uncommitted, then beforeQuit retries in the same order exactly once", async () => {
    const f = await fixture(), { binding } = await f.start(), dropFailure = await failWrites(f), gp = f.p.info.GP;
    const award = binding.award(f.p, candidate(f)), finish = binding.finish(false);
    await expect(award).rejects.toMatchObject({ cause: { message: "owner injected SQL failure" } }); await expect(finish).rejects.toThrow("must commit before resetting");
    expect((await profile(f)).GP).toBe(gp); expect(await progress(f)).toMatchObject({ isInGame: true, currentFloor: 1, accumulateExp: 0 });
    await expect(f.owner.drain()).rejects.toThrow("not durable");
    await dropFailure(); await f.owner.beforeQuit(f.p); await f.owner.drain();
    expect((await profile(f)).GP).toBe(gp + 660);
    expect(await progress(f)).toMatchObject({ isInGame: false, completeChallenge: false, currentFloor: 2, accumulateExp: 660, ProcessAward: initProcessAward() });
    await f.owner.beforeQuit(f.p); expect((await profile(f)).GP).toBe(gp + 660);
  });

  it("shutdown seals producers, refuses database-close drain on failure, and completes a later retry", async () => {
    const f = await fixture(), { binding } = await f.start(), block = await blockedClient(f), dropFailure = await failWrites(f), gp = f.p.info.GP;
    const award = binding.award(f.p, candidate(f));
    f.owner.beginShutdown(); expect(() => binding.award(f.p, candidate(f, 2))).toThrow("no longer admitted");
    const drainFailure = expect(f.owner.drain()).rejects.toThrow(); block.release();
    await expect(award).rejects.toMatchObject({ cause: { message: "owner injected SQL failure" } }); await drainFailure;
    expect(f.owner.busy(f.p)).toBe(true); expect((await profile(f)).GP).toBe(gp);
    await dropFailure(); await f.client.idle(); await f.owner.drain();
    expect(f.owner.busy(f.p)).toBe(false); expect((await profile(f)).GP).toBe(gp + 660);
    expect((await progress(f))?.isInGame).toBe(false); expect(await f.owner.prepareStart(f.p, f.room)).toBe(false);
  });

  it("quitPlayer waits for accepted award/reset before its final save and world removal", async () => {
    const f = await fixture(), { binding } = await f.start(), block = await blockedClient(f), gp = f.p.info.GP;
    const award = binding.award(f.p, candidate(f));
    let quitDone = false; const quit = quitPlayer(f.ctx, f.p).then(() => { quitDone = true; });
    await flush(); expect(quitDone).toBe(false); expect(f.ctx.world.get(f.p.id)).toBe(f.p);
    block.release(); await Promise.all([award, quit, f.client.idle()]);
    expect(f.ctx.world.get(f.p.id)).toBeUndefined(); expect(f.p.isActive).toBe(false);
    expect(await profile(f)).toMatchObject({ GP: gp + 660, State: 0 }); expect((await progress(f))?.isInGame).toBe(false);
  });

  it("failed quit retains the online owner and can retry after SQL is repaired", async () => {
    const f = await fixture(), { binding } = await f.start(), dropFailure = await failWrites(f), gp = f.p.info.GP;
    await expect(binding.award(f.p, candidate(f))).rejects.toMatchObject({ cause: { message: "owner injected SQL failure" } });
    await expect(quitPlayer(f.ctx, f.p)).rejects.toThrow();
    expect(f.ctx.world.get(f.p.id)).toBe(f.p); expect(f.p.isActive).toBe(true); expect(f.p.quitting).toBeNull();
    expect((await profile(f)).GP).toBe(gp);
    await dropFailure(); await quitPlayer(f.ctx, f.p);
    expect(f.ctx.world.get(f.p.id)).toBeUndefined(); expect(await profile(f)).toMatchObject({ GP: gp + 660, State: 0 });
  });

  it.each(["beforeQuit", "shutdown-drain"])("%s recovery freezes the player's current fight instead of the failed run's old fight", async method => {
    const f = await fixture(), { binding } = await f.start(), dropFailure = await failWrites(f), gp = f.p.info.GP;
    await expect(binding.award(f.p, candidate(f))).rejects.toMatchObject({ cause: { message: "owner injected SQL failure" } });
    await expect(binding.finish(false)).rejects.toThrow("must commit before resetting");
    await dropFailure(); f.room.removePlayer(f.p);
    const currentRoom = new BaseRoom(sequence + 10000, { onRoomChanged: () => {}, lang: key => key });
    currentRoom.start(); currentRoom.updateRoom("new real room identity", "", 1, 3, 1201); currentRoom.addPlayer(f.p);
    const gate = new WorldBossSettlementGate(), requested = deferred(), initialRelease = await gate.acquire();
    const released = vi.fn();
    const hold = vi.fn(async () => {
      requested.resolve(); const release = await gate.acquire();
      return () => { released(); release(); };
    });
    currentRoom.startGame({ ...f.fight(sequence + 2000), holdWorldBossSettlement: hold });
    const publicationHeld: boolean[] = [], originalSend = f.p.send.bind(f.p);
    vi.spyOn(f.p, "send").mockImplementation(pkt => { publicationHeld.push(gate.held); originalSend(pkt); });
    if (method === "shutdown-drain") f.owner.beginShutdown();
    let complete = false;
    const recovery = (method === "beforeQuit" ? f.owner.beforeQuit(f.p) : f.owner.drain()).then(() => { complete = true; });
    await requested.promise; await flush();
    expect(complete).toBe(false); expect(f.p.info.GP).toBe(gp); expect((await profile(f)).GP).toBe(gp);
    expect(await progress(f)).toMatchObject({ isInGame: true, currentFloor: 1, accumulateExp: 0 });
    initialRelease(); await recovery; await f.client.idle(); await gate.waitIdle();
    expect((await profile(f)).GP).toBe(gp + 660); expect(f.p.info.GP).toBe(gp + 660);
    expect(await progress(f)).toMatchObject({ isInGame: false, currentFloor: 2, accumulateExp: 660 });
    expect(publicationHeld.length).toBeGreaterThan(0); expect(publicationHeld.every(Boolean)).toBe(true);
    expect(hold).toHaveBeenCalledTimes(2); expect(released).toHaveBeenCalledTimes(2); expect(gate.held).toBe(false);
  });
});
