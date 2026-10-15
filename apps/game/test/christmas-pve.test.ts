import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState, PveGame, type PlayerSpec, solveAim } from "@ddt/fight";
import { loadPackedAssets } from "@ddt/fight/node";
import { GSPacket } from "@ddt/protocol";
import { ChristmasLocalGame, ChristmasLocalMission } from "../../../packages/fight/src/pve/scripts/manual/christmas.js";
import { data, pves, npcs, missions } from "../../../packages/fight/test/pve-data.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import type { StartPveOptions } from "../src/fight/types.js";
import { VirtualPlayer } from "../src/bots/bot.js";
import { BaseRoom } from "../src/rooms/room.js";
import type { RoomMember } from "../src/game/player.js";
import * as ChristmasPve from "../src/game/christmas-pve.js";
import { CHRISTMAS_PVE_DEFINITIONS, CHRISTMAS_PVE_CLIENT_READINESS, assertChristmasPveTerrainReady, bindChristmasPveAdmission, christmasPveDefinition, consumeChristmasPveAdmission, createChristmasPveOverlay, readChristmasPveAdmission, revokeChristmasPveAdmission } from "../src/game/christmas-pve.js";

const assets = loadPackedAssets();
const base = { data, pveInfo: (id: number) => pves.get(id) };
afterEach(() => vi.restoreAllMocks());

/** Deliberately exercise only server physics. Production ready stays false; this fixture is not client acceptance. */
function serverPhysicsOnly() { vi.spyOn(ChristmasPve, "assertChristmasPveReady").mockImplementation(assertChristmasPveTerrainReady); }

/** Real engine/protocol with a structural in-memory human seat; no server, fake clients, database or network. */
function fixture(id = 164001, hp = 3000) {
  const sent: GSPacket[] = [], logs: string[] = [];
  const seed = new VirtualPlayer({ id: 1, nickname: "PveTest", sex: true, level: 8, weaponTemplateId: 7001 });
  const p: RoomMember = {
    id: 1, isBot: false, currentRoom: null, roomIndex: -1, roomTeam: 1, isViewer: false, hasMainWeapon: true, playerState: 1,
    info: { ...seed.info, ID: 1, UserID: 1, GP: 123, Attack: 500, Defence: 150, Agility: 200, Luck: 100, hp },
    view() { return { ...seed.view(), id: this.id, info: this.info, roomIndex: this.roomIndex, roomTeam: this.roomTeam, inRoom: this.currentRoom !== null }; },
    send(pkt) { sent.push(pkt); }, sendMessage() {},
  };
  Object.assign(p, { baseAttack: 2000, baseDefence: 100 });
  const room = new BaseRoom(41, { onRoomChanged() {}, lang: (key) => key });
  room.start(); room.RoomType = 40; room.MapId = id; room.HardLevel = 0; room.addPlayer(p);
  const onStopped = vi.fn(), onFinished = vi.fn(), drop = vi.fn(() => [{ templateId: 11020, count: 5 }]), pay = vi.fn(() => true), give = vi.fn();
  const engine = new DdtFightEngine({ assets, manualClock: true, seed: () => 13, pve: { ...base, drop }, payTakeCard: pay, giveItems: give, log: (s) => logs.push(s) });
  const s: StartPveOptions = { roomId: room.RoomId, roomType: 40, gameType: 7, timeType: 3, pveId: id, hardLevel: 0, levelLimits: 0, currentFloor: 0, players: [p], onStopped, onFinished };
  const permit = { player: p, localPveId: id as 164001, attemptId: randomUUID(), serverInstance: randomUUID() };
  let now = Date.now();
  const bind = () => bindChristmasPveAdmission(room, permit);
  const cmd = (g: ReturnType<DdtFightEngine["startPve"]>, sub: number, fill: (pkt: GSPacket) => void = () => {}) => {
    const pkt = new GSPacket(91); pkt.writeByte(sub); fill(pkt);
    return g!.processData(p, GSPacket.parse(pkt.encode()));
  };
  const tick = () => { engine.tick(now += 40); };
  const run = (g: NonNullable<ReturnType<DdtFightEngine["startPve"]>>, shoot = false) => {
    const game = engine.games.get(g.id)!.game as PveGame;
    const turns = new Set<number>();
    for (let i = 0; i < 50000 && engine.games.has(g.id); i++) {
      tick();
      if (game.state === GameState.Loading) cmd(g, 16, (pkt) => pkt.writeInt(100));
      const me = game.players[0], npc = game.livings.find((n) => n.isLiving);
      if (me.isAttacking && !turns.has(game.turnIndex)) {
        turns.add(game.turnIndex);
        const aim = shoot && npc ? solveAim({ map: game.map, ball: me.currentBall, from: me, target: { x: npc.x, y: npc.y - 40 }, bodies: [{ id: npc.id, x: npc.x, y: npc.y, team: npc.team, bound: npc.bound }] }) : null;
        if (aim) {
          cmd(g, 96, (pkt) => { pkt.writeBoolean(true); pkt.writeByte(2); });
          cmd(g, 2, (pkt) => { pkt.writeInt(aim.muzzle.x); pkt.writeInt(aim.muzzle.y); pkt.writeInt(aim.force); pkt.writeInt(aim.angle); });
        } else cmd(g, 12, (pkt) => pkt.writeByte(1));
      }
    }
    return game;
  };
  return { p, room, s, permit, engine, bind, cmd, tick, run, sent, logs, onStopped, onFinished, drop, pay, give };
}

describe("local Christmas exact overlay and single-use admission", () => {
  it("maps actual living2/3 exports and preserves all old lookup identities", () => {
    const overlay = createChristmasPveOverlay(base);
    expect(CHRISTMAS_PVE_DEFINITIONS.map((d) => [d.localPveId, d.originalMissionId, d.mapId, d.modelId, d.hp, d.meleeDamage])).toEqual([
      [164001, 40001, 1201, "game.living.Living0012", 300, 0], [164002, 40002, 1201, "game.living.Living0014", 600, 30], [164003, 40003, 1201, "game.living.Living0013", 900, 45],
    ]);
    for (const d of CHRISTMAS_PVE_DEFINITIONS) {
      expect(npcs.has(d.localPveId) || missions.has(d.localPveId) || pves.has(d.localPveId)).toBe(false);
      expect(overlay.data.npc(d.localPveId)).toMatchObject({ Blood: d.hp, ModelID: d.modelId, ResourcesPath: d.resourcePath, DropId: 0, Experience: 0, Immunity: 0 });
      expect(overlay.data.mission(d.localPveId)).toMatchObject({ TakeCard: 0, TotalTurn: 30, Param1: d.mapId });
      assertChristmasPveTerrainReady(d, assets);
    }
    for (const id of [40001, 40002, 40003, 21001]) { expect(overlay.data.npc(id)).toBe(npcs.get(id)); expect(overlay.data.mission(id)).toBe(missions.get(id)); }
    expect(overlay.pveInfo(2, 4, 0)).toBe(pves.get(2));
    expect(overlay.pveInfo(164001, 4, 0)).toBeUndefined();
    expect(christmasPveDefinition(40001)).toBeUndefined();
  });
  it("refuses every unadmitted40 and cross-room local ID without invoking base lookup", () => {
    const f = fixture(); const lookup = vi.spyOn(f.engine.o.pve!, "pveInfo");
    expect(f.engine.startPve(f.s)).toBeNull();
    expect(f.engine.startPve({ ...f.s, pveId: 40001 })).toBeNull();
    expect(f.engine.startPve({ ...f.s, roomType: 4 })).toBeNull();
    expect(lookup).not.toHaveBeenCalled(); expect(f.engine.games.size).toBe(0);
  });
  it("production refuses even a valid admission while exact client resources/loading remain unverified", () => {
    const f = fixture(); f.bind();
    expect(CHRISTMAS_PVE_CLIENT_READINESS.ready).toBe(false);
    expect(f.engine.startPve(f.s)).toBeNull(); expect(f.engine.games.size).toBe(0);
    expect(f.logs.join("\n")).toContain("Christmas client unavailable"); expect(f.onFinished).not.toHaveBeenCalled();
  });
  it("checks UUID, actual single owner/room/setup, and never resurrects consumed or retired permits", () => {
    const f = fixture();
    expect(() => bindChristmasPveAdmission(f.room, { ...f.permit, attemptId: "forged" })).toThrow();
    f.bind(); expect(Object.isFrozen(readChristmasPveAdmission(f.room))).toBe(true);
    expect(consumeChristmasPveAdmission({ ...f.s, roomId: 99 })).toBeNull();
    expect(consumeChristmasPveAdmission({ ...f.s, players: [{ ...f.p }] })).toBeNull();
    expect(consumeChristmasPveAdmission({ ...f.s, pveId: 164002 })).toBeNull();
    f.room.HardLevel = 1; expect(consumeChristmasPveAdmission(f.s)).toBeNull(); f.room.HardLevel = 0;
    f.room.currentFloor = 1; expect(consumeChristmasPveAdmission(f.s)).toBeNull(); f.room.currentFloor = 0;
    expect(consumeChristmasPveAdmission(f.s)?.attemptId).toBe(f.permit.attemptId);
    f.bind(); expect(readChristmasPveAdmission(f.room)).toBeNull(); expect(consumeChristmasPveAdmission(f.s)).toBeNull();
    revokeChristmasPveAdmission(f.room, f.permit.attemptId); f.bind(); expect(consumeChristmasPveAdmission(f.s)).toBeNull();
    const next = { ...f.permit, attemptId: randomUUID() }; bindChristmasPveAdmission(f.room, next);
    revokeChristmasPveAdmission(f.room, f.permit.attemptId); expect(readChristmasPveAdmission(f.room)?.attemptId).toBe(next.attemptId);
    revokeChristmasPveAdmission(f.room, next.attemptId); expect(() => f.bind()).toThrow();
  });
});

describe("actual DdtFightEngine Christmas lifecycle", () => {
  it.each([164001, 164002, 164003])("wins %i only through an actual ballistic shot/kill, without default awards or payment", (id) => {
    serverPhysicsOnly();
    const f = fixture(id); f.bind(); const g = f.engine.startPve(f.s)!; expect(g).not.toBeNull();
    const game = f.engine.games.get(g.id)!.game as PveGame;
    const emit = vi.spyOn(game, "emit");
    f.cmd(g, 114, (pkt) => pkt.writeByte(1));
    const played = f.run(g, true);
    expect(f.logs, "script/runtime log").not.toEqual(expect.arrayContaining([expect.stringMatching(/error|failed|generic/i)]));
    expect(played.TotalKillCount).toBe(1); expect(played.missingScripts).toEqual([]); expect(played.scriptErrors).toEqual([]);
    expect(played.map.info.posX).toBe("424,1112"); expect(assets.maps.get(1201)?.posX).toBe("124,798|424,1112|581,568|860,955");
    expect(emit.mock.calls.find(([e]) => e.cmd === "GAME_LOAD")?.[0]).toMatchObject({ mapId: 1201, files: [{ type: 2, path: christmasPveDefinition(id)!.resourcePath, className: christmasPveDefinition(id)!.modelId }] });
    expect(f.sent.some((pkt) => pkt.code === 91 && pkt.buffer[20] === 2)).toBe(true);
    expect(f.onFinished.mock.calls).toEqual([[true]]); expect(f.onStopped).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls.map(([e]) => e).filter((e) => e.cmd === "GAME_MISSION_OVER")).toEqual([expect.objectContaining({ isWin: true, bossCardCount: 0, players: [expect.objectContaining({ gainGP: 0 })] })]);
    expect(f.p.info.GP).toBe(123); expect(f.drop).not.toHaveBeenCalled(); expect(f.give).not.toHaveBeenCalled(); expect(f.pay).not.toHaveBeenCalled();
    g.removePlayer(f.p); g.stop(); expect(f.onFinished).toHaveBeenCalledTimes(1); expect(f.onStopped).toHaveBeenCalledTimes(1);
    expect(f.engine.startPve(f.s)).toBeNull();
  });
  it("passive Living0012 never attacks and loses on the real turn30 limit", () => {
    serverPhysicsOnly();
    const f = fixture(); f.bind(); const g = f.engine.startPve(f.s)!;
    const game = f.run(g);
    expect(game.TurnIndex).toBe(30); expect(game.TotalKillCount).toBe(0); expect(game.players[0].blood).toBe(3000);
    expect(f.sent.some((pkt) => pkt.code === 91 && pkt.buffer[20] === 58)).toBe(false);
    expect(f.onFinished.mock.calls).toEqual([[false]]); expect(f.onStopped).toHaveBeenCalledTimes(1);
  });
  it.each([164002, 164003])("actual %i melee can kill the player and reports loss once", (id) => {
    serverPhysicsOnly();
    const f = fixture(id, 1); f.bind(); const g = f.engine.startPve(f.s)!;
    const before = f.engine.games.get(g.id)!.game as PveGame;
    const damaged = vi.spyOn(before.players[0], "takeDamage");
    const emit = vi.spyOn(before, "emit");
    const game = f.run(g);
    expect(f.sent.some((pkt) => pkt.code === 91 && pkt.buffer[20] === 58), JSON.stringify({ turn:game.TurnIndex, me:{x:game.players[0].x,y:game.players[0].y,blood:game.players[0].blood}, npc:game.livings.map(n=>({x:n.x,y:n.y,blood:n.blood})), logs:f.logs, finished:f.onFinished.mock.calls })).toBe(true);
    expect(game.players[0].isLiving).toBe(false); expect(game.TotalKillCount).toBe(0);
    expect(damaged).toHaveBeenCalledTimes(1); expect(damaged.mock.calls[0][0]).toBe(game.livings[0]);
    expect(damaged.mock.calls[0][1].damage).toBeGreaterThan(0);
    expect(emit.mock.calls.some(([e]) => e.cmd === "RAW" && e.code === 55)).toBe(true);
    expect(emit.mock.calls.some(([e]) => e.cmd === "RAW" && e.code === 58 && e.livingId === game.livings[0].id)).toBe(true);
    expect(game.TurnIndex).toBeLessThan(30); expect(game.scriptErrors).toEqual([]);
    expect(f.onFinished.mock.calls).toEqual([[false]]); expect(f.onStopped).toHaveBeenCalledTimes(1);
  });
  it("exiting the real participant cannot become a win or duplicate a terminal callback", () => {
    serverPhysicsOnly();
    const f = fixture(); f.bind(); const g = f.engine.startPve(f.s)!;
    for (let i = 0; i < 500; i++) { f.tick(); const game = f.engine.games.get(g.id)!.game; if (game.state === GameState.Loading) f.cmd(g, 16, (pkt) => pkt.writeInt(100)); if (game.state === GameState.Playing) break; }
    g.removePlayer(f.p); g.removePlayer(f.p); g.stop();
    expect(f.engine.games.size).toBe(0); expect(f.onFinished).not.toHaveBeenCalled(); expect(f.onStopped).toHaveBeenCalledTimes(1);
  });
  it("strict prepare errors and first-tick errors stop the actual game with no Generic fallback", () => {
    serverPhysicsOnly();
    const f = fixture(); f.bind(); vi.spyOn(ChristmasLocalMission.prototype, "OnPrepareNewSession").mockImplementation(() => { throw new Error("injected prepare failure"); });
    const g = f.engine.startPve(f.s)!; for (let i = 0; i < 20 && f.engine.games.size; i++) f.tick();
    expect(f.engine.games.size).toBe(0); expect(f.onStopped).toHaveBeenCalledTimes(1); expect(f.onFinished).not.toHaveBeenCalled();
    expect(f.logs.join("\n")).toContain("injected prepare failure"); expect(f.logs.join("\n")).not.toContain("generic mission");
    vi.restoreAllMocks(); serverPhysicsOnly(); const first = fixture(); first.bind();
    vi.spyOn(ChristmasLocalGame.prototype, "OnPrepated").mockImplementation(() => { throw new Error("injected first tick failure"); });
    expect(first.engine.startPve(first.s)).toBeNull(); expect(first.engine.games.size).toBe(0); expect(first.onStopped).toHaveBeenCalledTimes(1); expect(first.onFinished).not.toHaveBeenCalled();
  });
  it("strict unknown scripts throw, while an ordinary game keeps its original Generic behavior", () => {
    const p: PlayerSpec = { userId: 2, nickname: "test", team: 1, grade: 5, attack: 200, defence: 100, agility: 200, lucky: 100, hp: 1000, baseAttack: 250, baseDefence: 100, weapon: { templateId: 7001, property8: 5 } };
    const args = { id: 200, roomType: 4, gameType: 7, timeType: 3, assets, players: [p], pveInfo: { ID: 2, Name: "unknown", Type: 4, LevelLimits: 0, SimpleGameScript: "missing.ChristmasScript" }, hardLevel: 0, data };
    expect(() => new PveGame({ ...args, strictScripts: true })).toThrow("Required game script missing");
    const ordinary = new PveGame(args); expect(ordinary.missingScripts).toHaveLength(1); expect(ordinary.strictScripts).toBe(false); expect(ordinary.calculateExperience(ordinary.players[0])).toBe(1);
    const overlay = createChristmasPveOverlay(base);
    const strict = new PveGame({ ...args, roomType: 40, pveInfo: overlay.pveInfo(164001, 40, 0)!, data: overlay.data, strictScripts: true });
    expect(() => strict.SetupMissions("99999999")).toThrow("Required Mission_Info");
    expect(() => strict.LoadResources([99999999])).toThrow("Required resource NPC");
    const missingMission = new PveGame({ ...args, roomType: 40, pveInfo: overlay.pveInfo(164001, 40, 0)!, data: { ...overlay.data, mission: (id) => ({ ...overlay.data.mission(id)!, Script: "missing.NoSuchChristmasMission" }) }, strictScripts: true });
    expect(() => { for (let now = 0; now < 10000; now += 40) missingMission.update(now); }).toThrow("Required mission script missing");
    expect(missingMission.missingScripts).toEqual([{ kind: "mission", name: "missing.NoSuchChristmasMission" }]);
    const missingBrain = new PveGame({ ...args, roomType: 40, pveInfo: overlay.pveInfo(164001, 40, 0)!, data: { ...overlay.data, npc: (id) => ({ ...overlay.data.npc(id)!, Script: "missing.LocalBrain" }) }, strictScripts: true });
    expect(() => missingBrain.CreateNpc(164001, 514, 1161, 0, -1, "stand")).toThrow("Required brain script missing");
  });
  it("missing terrain refuses admission without an orphan game or fallback map", () => {
    serverPhysicsOnly();
    const f = fixture(); f.bind(); vi.spyOn(assets, "createMap").mockImplementation(() => { throw new Error("missing packed terrain"); });
    expect(f.engine.startPve(f.s)).toBeNull(); expect(f.engine.games.size).toBe(0); expect(readChristmasPveAdmission(f.room)).toBeNull();
    expect(f.onFinished).not.toHaveBeenCalled();
  });
});
