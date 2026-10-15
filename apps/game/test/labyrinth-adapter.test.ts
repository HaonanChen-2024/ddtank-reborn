/** Isolated combat headers and a deferred owner, never production Labyrinth configuration. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState, PveGame, type FightEvent, type PveInfo } from "@ddt/fight";
import { GSPacket, PacketOut } from "@ddt/protocol";
import { loadPackedAssets } from "@ddt/fight/node";
import { data, pves } from "../../../packages/fight/test/pve-data.js";
import { VirtualPlayer } from "../src/bots/bot.js";
import { DdtFightEngine, type LabyrinthFightBinding } from "../src/fight/ddt.js";
import type { FightGame, StartPveOptions } from "../src/fight/types.js";
import type { RoomMember } from "../src/game/player.js";

const assets = loadPackedAssets();
const deferreds: (() => void)[] = [];
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  deferreds.push(resolve);
  return { promise, resolve, reject };
}
const active: FightGame[] = [];
afterEach(async () => {
  for (const resolve of deferreds.splice(0)) resolve();
  for (const fight of active.splice(0)) { fight.stop(); await fight.waitWorldBossSettlement?.().catch(() => {}); }
  vi.restoreAllMocks();
});

function fixture(o: { rejectAdmission?: boolean; startedError?: Error; pveInfo?: Partial<PveInfo>; finish?: () => Promise<void> } = {}) {
  const seed = new VirtualPlayer({ id: 1, nickname: "Labyrinth adapter", sex: true, level: 20, weaponTemplateId: 7001 });
  const send = vi.fn(), reduceHunger = vi.fn(), drop = vi.fn(() => []), log = vi.fn();
  const member: RoomMember = {
    id: 1, isBot: false, currentRoom: null, roomIndex: 0, roomTeam: 1, isViewer: false, hasMainWeapon: true, playerState: 1,
    info: { ...seed.info, hp: 1_000_000 }, send, sendMessage: vi.fn(), view() { return { ...seed.view(), id: this.id, info: this.info }; },
  };
  Object.assign(member, { petBag: { equipped: () => ({ ID: 1, Place: 0, TemplateID: 1, Name: "fixture", UserID: 1, Level: 1, SkillEquip: "" }), reduceHunger } });
  const awardDone = deferred();
  const award = vi.fn(() => awardDone.promise);
  const finish = vi.fn(o.finish ?? (() => Promise.resolve()));
  const started = vi.fn((_fight: FightGame) => { if (o.startedError) throw o.startedError; });
  const binding: LabyrinthFightBinding = { processAwards: new Map([[1, Array.from({ length: 99 }, (_, i) => i).join("-")]]), started, award, finish };
  const admit = vi.fn(() => o.rejectAdmission ? null : binding);
  const engine = new DdtFightEngine({ assets, manualClock: true, seed: () => 3, log, labyrinth: { admit }, pve: {
    pveInfo: () => ({ ...pves.get(2)!, ID: 401, Type: 15, SimpleGameScript: "GameServerScript.AI.Game.Labyrinth", ...o.pveInfo }),
    data: { npc: data.npc, mission: id => id >= 40001 && id <= 40030 ? {
      ...data.mission(1085)!, Id: id, TotalCount: id % 2 ? 10 : 1, TotalTurn: 1000, Script: `GameServerScript.AI.Messions.Labyrinth${id}`,
    } : undefined }, drop,
  } });
  const setup: StartPveOptions = { roomId: 1, roomType: 15, gameType: 7, timeType: 3, pveId: 401, hardLevel: 0, levelLimits: 0, currentFloor: 1,
    players: [member], onStopped: vi.fn(), onFinished: vi.fn() };
  const fight = engine.startPve(setup);
  if (fight) active.push(fight);
  const live = fight && engine.games.get(fight.id)!;
  if (live) {
    for (let n = 1; (live.game as PveGame).SessionId < 1 && n < 10; n++) engine.tick(Date.now() + n * 40);
    expect((live.game as PveGame).MissionInfo.Id).toBe(40001);
    expect((live.game as PveGame).strictScripts).toBe(true);
  }
  send.mockClear();
  return { engine, setup, fight, live: live!, member, send, reduceHunger, drop, admit, started, award, awardDone, finish, log };
}

function candidate(f: ReturnType<typeof fixture>, patch: Partial<Extract<FightEvent, { cmd: "LABYRINTH_AWARD" }>> = {}): FightEvent {
  return { cmd: "LABYRINTH_AWARD", code: 0, livingId: f.live.game.players[0]!.id, userId: 1, floor: 1, missionId: 40001, bigAward: false, ...patch };
}
function marker(value: number): FightEvent { return { cmd: "RAW", code: 53, livingId: 0, body: [["i32", value]] }; }
function packet(sub: number): GSPacket { const p = new PacketOut(91); p.writeByte(sub); return GSPacket.parse(p.toBytes()); }

describe("Labyrinth durable combat adapter (isolated fixtures)", () => {
  it("refuses a rejected admission before creating games, drops, packets or pet hunger", () => {
    const f = fixture({ rejectAdmission: true });
    expect(f.fight).toBeNull(); expect(f.engine.games.size).toBe(0);
    for (const spy of [f.started, f.award, f.finish, f.drop, f.send, f.reduceHunger]) expect(spy).not.toHaveBeenCalled();
  });

  it("cleans a failed binding and preserves its failure for the bound fight drain", async () => {
    const error = new Error("binding fixture failed"), f = fixture({ startedError: error });
    expect(f.fight).toBeNull(); expect(f.engine.games.size).toBe(0); expect(f.reduceHunger).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(false);
    const bound = f.started.mock.calls[0]![0] as FightGame;
    await expect(bound.waitWorldBossSettlement!()).rejects.toBe(error);
  });

  it("never replaces a missing original script with generic AI", async () => {
    const f = fixture({ pveInfo: { SimpleGameScript: "Missing.Labyrinth.Script" } });
    expect(f.fight).toBeNull(); expect(f.engine.games.size).toBe(0); expect(f.reduceHunger).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.log.mock.calls.some(([message]) => message.includes("Required game script missing"))).toBe(true);
  });

  it("cleans the admitted fight after a fatal first tick and preserves the original error", async () => {
    const error = new Error("first tick fixture failed");
    vi.spyOn(PveGame.prototype, "update").mockImplementationOnce(() => { throw error; });
    const f = fixture();
    expect(f.fight).toBeNull(); expect(f.engine.games.size).toBe(0); expect(f.finish).toHaveBeenCalledExactlyOnceWith(false);
    const bound = f.started.mock.calls[0]![0];
    await expect(bound.waitWorldBossSettlement!()).rejects.toBe(error);
  });

  it("pauses the rest of this batch, this tick's bot update and subsequent ticks until commit", async () => {
    const f = fixture(), order: string[] = [];
    f.award.mockImplementation(() => { order.push("award registered"); return f.awardDone.promise; });
    f.send.mockImplementation(() => order.push("packet"));
    const update = vi.spyOn(f.live.game, "update").mockReturnValueOnce([candidate(f), marker(1)]).mockReturnValue([]);
    const bots = vi.spyOn(f.live.bots, "update").mockImplementation(() => { order.push("bots"); return []; });
    f.live.tick(Date.now() + 1000); f.live.tick(Date.now() + 1040);
    expect(order).toEqual(["award registered"]); expect(update).toHaveBeenCalledTimes(1); expect(bots).not.toHaveBeenCalled();
    f.awardDone.resolve(); await f.fight!.waitWorldBossSettlement!();
    expect(order).toEqual(["award registered", "packet", "bots", "bots"]);
    expect(f.award).toHaveBeenCalledExactlyOnceWith(f.member, expect.objectContaining({ livingId: f.live.game.players[0]!.id, missionId: 40001 }));
  });

  it.each(["processData", "missionStart"] as const)("%s returns before its own queued award and resumes remaining packets after commit", async method => {
    const f = fixture();
    vi.spyOn(f.live.game, "handle").mockReturnValueOnce([candidate(f), marker(1)]).mockReturnValue([]);
    const value = method === "processData" ? f.fight!.processData(f.member, packet(137)) : f.fight!.missionStart!();
    expect(value).toBeUndefined(); expect(f.award).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
    f.awardDone.resolve(); await f.fight!.waitWorldBossSettlement!(); expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("does not read a subsequent packet while an award is pending", async () => {
    const f = fixture();
    vi.spyOn(f.live.game, "update").mockReturnValueOnce([candidate(f)]);
    const handle = vi.spyOn(f.live.game, "handle").mockReturnValue([marker(2)]);
    f.live.tick(Date.now() + 1000);
    const next = packet(137), offset = next.offset, queued = f.fight!.processData(f.member, next);
    expect(queued).toBeInstanceOf(Promise); expect(next.offset).toBe(offset); expect(handle).not.toHaveBeenCalled();
    f.awardDone.resolve(); await queued; await f.fight!.waitWorldBossSettlement!();
    expect(handle).toHaveBeenCalledTimes(1); expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a second same-batch candidate ahead of queued ticks until both commits finish", async () => {
    const second = deferred(), f = fixture();
    f.award.mockImplementationOnce(() => f.awardDone.promise).mockImplementationOnce(() => second.promise);
    const update = vi.spyOn(f.live.game, "update").mockReturnValueOnce([candidate(f), candidate(f), marker(1)]).mockReturnValue([]);
    const bots = vi.spyOn(f.live.bots, "update").mockReturnValue([]);
    f.live.tick(Date.now() + 1000); f.live.tick(Date.now() + 1040);
    f.awardDone.resolve();
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(f.award).toHaveBeenCalledTimes(2); expect(update).toHaveBeenCalledTimes(1); expect(bots).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    second.resolve(); await f.fight!.waitWorldBossSettlement!();
    expect(f.send).toHaveBeenCalledTimes(1); expect(bots).toHaveBeenCalledTimes(2);
  });

  it("accepts the candidate produced by the actual original floor-one mission, withholds its grounded gate until commit", async () => {
    const f = fixture(), game = f.live.game as PveGame;
    let now = Date.now() + 1000, killed = false;
    for (let n = 0; n < 4500 && !f.award.mock.calls.length; n++, now += 40) {
      f.live.tick(now);
      if (game.state === GameState.Loading) {
        const p = new PacketOut(91); p.writeByte(16); p.writeInt(100);
        f.fight!.processData(f.member, GSPacket.parse(p.toBytes()));
      }
      if (!killed && game.state === GameState.Playing && game.currentLiving === game.players[0] && game.currentLiving.isAttacking) {
        for (const npc of [...game.livings]) npc.takeDamage(game.players[0]!, { damage: npc.blood, critical: 0 });
        const p = new PacketOut(91); p.writeByte(12); p.writeByte(0);
        f.fight!.processData(f.member, GSPacket.parse(p.toBytes()));
        killed = true;
      }
    }
    expect(killed).toBe(true); expect(f.award).toHaveBeenCalledExactlyOnceWith(f.member, expect.objectContaining({ floor: 1, missionId: 40001, bigAward: false }));
    const sent = f.send.mock.calls.length;
    f.live.tick(now + 40); expect(f.send).toHaveBeenCalledTimes(sent);
    expect(game.SessionId).toBe(1); expect(game.missingScripts).toEqual([]); expect(game.scriptErrors).toEqual([]);
    f.awardDone.resolve(); await f.fight!.waitWorldBossSettlement!();
    expect(f.send.mock.calls.length).toBeGreaterThan(sent);
  });

  it("drops subsequent batch work on failed commit and makes the failure observable on every drain", async () => {
    const f = fixture(), error = new Error("durable award fixture failed");
    vi.spyOn(f.live.game, "update").mockReturnValueOnce([candidate(f), marker(1)]);
    const bots = vi.spyOn(f.live.bots, "update");
    f.live.tick(Date.now() + 1000); f.awardDone.reject(error);
    await expect(f.fight!.waitWorldBossSettlement!()).rejects.toBe(error);
    await expect(f.fight!.waitWorldBossSettlement!()).rejects.toBe(error);
    expect(f.send).not.toHaveBeenCalled(); expect(bots).not.toHaveBeenCalled(); expect(f.engine.games.size).toBe(0);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(false); expect(f.setup.onStopped).toHaveBeenCalledTimes(1);
  });

  it("also seals and exposes a synchronous award-owner exception without leaking a lease", async () => {
    const f = fixture(), error = new Error("award admission fixture failed");
    f.award.mockImplementation(() => { throw error; });
    vi.spyOn(f.live.game, "handle").mockReturnValueOnce([candidate(f), marker(1)]);
    expect(f.fight!.processData(f.member, packet(137))).toBeUndefined();
    await expect(f.fight!.waitWorldBossSettlement!()).rejects.toBe(error);
    expect(f.send).not.toHaveBeenCalled(); expect(f.engine.games.size).toBe(0); expect(f.finish).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each(["stop", "removePlayer"] as const)("%s seals once and waits for the accepted award and finish before cleanup", async method => {
    const finished = deferred(), f = fixture({ finish: () => finished.promise });
    vi.spyOn(f.live.game, "update").mockReturnValueOnce([candidate(f), marker(1)]);
    const bots = vi.spyOn(f.live.bots, "update");
    f.live.tick(Date.now() + 1000);
    if (method === "stop") f.fight!.stop(); else f.fight!.removePlayer(f.member);
    f.fight!.stop(); f.fight!.removePlayer(f.member);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(false); expect(f.setup.onStopped).not.toHaveBeenCalled();
    f.awardDone.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.setup.onStopped).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(bots).not.toHaveBeenCalled();
    finished.resolve(); await f.fight!.waitWorldBossSettlement!();
    expect(f.setup.onStopped).toHaveBeenCalledTimes(1); expect(f.engine.games.size).toBe(0);
  });

  it("preserves terminal win and emits room completion only after the once-only finish commits", async () => {
    const finished = deferred(), f = fixture({ finish: () => finished.promise });
    vi.spyOn(f.live.game, "update").mockReturnValueOnce([candidate(f), { cmd: "PVE_STOPPED", code: 0, livingId: 0, isWin: true, hasNextMission: false }]);
    f.live.tick(Date.now() + 1000); expect(f.finish).not.toHaveBeenCalled();
    f.awardDone.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(true); expect(f.setup.onFinished).not.toHaveBeenCalled();
    f.fight!.stop(); finished.resolve(); await f.fight!.waitWorldBossSettlement!();
    expect(f.setup.onFinished).toHaveBeenCalledExactlyOnceWith(true); expect(f.setup.onStopped).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate finish or room completion for repeated terminal events", async () => {
    const f = fixture();
    vi.spyOn(f.live.game, "update").mockReturnValueOnce([
      { cmd: "PVE_STOPPED", code: 0, livingId: 0, isWin: true, hasNextMission: false },
      { cmd: "PVE_STOPPED", code: 0, livingId: 0, isWin: false, hasNextMission: false },
    ]);
    f.live.tick(Date.now() + 1000); await f.fight!.waitWorldBossSettlement!();
    f.fight!.stop(); f.fight!.removePlayer(f.member);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(true); expect(f.setup.onFinished).toHaveBeenCalledExactlyOnceWith(true); expect(f.setup.onStopped).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed exit even when no award occurred", async () => {
    const error = new Error("durable exit fixture failed"), f = fixture({ finish: () => Promise.reject(error) });
    f.fight!.stop(); await expect(f.fight!.waitWorldBossSettlement!()).rejects.toBe(error);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(false); expect(f.engine.games.size).toBe(0);
  });

  it.each([{ userId: 999 }, { livingId: 999 }, { floor: 2, missionId: 40002 }, { missionId: 40002 }, { bigAward: true }])("rejects a candidate outside the actual member/mission context %j", patch => {
    const f = fixture(); vi.spyOn(f.live.game, "update").mockReturnValueOnce([candidate(f, patch)]);
    expect(() => f.live.tick(Date.now() + 1000)).toThrow(/does not match its active mission\/member/);
    expect(f.award).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
});
