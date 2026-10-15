/** Room callback ownership only: a fake combat port, no Labyrinth tables, database or live server. */
import { describe, expect, it, vi } from "vitest";
import { VirtualPlayer } from "../src/bots/bot.js";
import type { FightEngine, FightGame, StartPveOptions } from "../src/fight/types.js";
import type { RoomMember } from "../src/game/player.js";
import { RoomMgr } from "../src/rooms/room-mgr.js";

function fixture(earlyStop = false) {
  const seed = new VirtualPlayer({ id: 1, nickname: "Room lifecycle", sex: true, level: 20, weaponTemplateId: 7001 });
  const member: RoomMember = {
    id: 1, isBot: false, currentRoom: null, roomIndex: -1, roomTeam: 1, isViewer: false, hasMainWeapon: true, playerState: 1,
    info: { ...seed.info, ID: 1, UserID: 1 }, send: vi.fn(), sendMessage: vi.fn(),
    view() { return { ...seed.view(), id: this.id, info: this.info, roomIndex: this.roomIndex, inRoom: this.currentRoom !== null }; },
  };
  const starts: StartPveOptions[] = [];
  const games: (FightGame & { stop: ReturnType<typeof vi.fn> })[] = [];
  const fight: FightEngine = {
    name: "room-lifecycle-test-port", startPvp: () => null,
    startPve: vi.fn((s: StartPveOptions) => {
      starts.push(s);
      const game = { id: starts.length, mapId: s.pveId, processData() {}, removePlayer() {}, stop: vi.fn(() => s.onStopped()) };
      games.push(game);
      if (earlyStop) s.onStopped();
      return game;
    }),
  };
  const rooms = new RoomMgr({ maxRooms: 1, fight, lang: key => key, random: () => 0 });
  let now = 1000;
  const tick = () => rooms.tick(now += 400);
  rooms.createRoom(member, "labyrinth callback test", "", 15, 3); tick();
  const room = member.currentRoom!;
  // Room metadata exercises the port contract. No configuration claims are made for Pve_Info 401.
  room.MapId = 401; room.currentFloor = 3; room.Pic = "old run"; room.isOpenBoss = true;
  const start = () => { rooms.startGame(room); tick(); };
  const reuse = (type: number) => {
    room.removePlayer(member); tick();
    expect(room.IsUsing).toBe(false);
    rooms.createRoom(member, "replacement callback test", "", type, 3); tick();
    expect(member.currentRoom).toBe(room);
    room.MapId = 12345; room.currentFloor = 7; room.Pic = "replacement run"; room.isOpenBoss = true;
    start();
  };
  return { rooms, room, member, fight, starts, games, start, reuse };
}

describe("Labyrinth RoomMgr accepted-fight lifecycle", () => {
  it("clears the accepted game once when its stop arrives", () => {
    const f = fixture(), stopped = vi.spyOn(f.room, "onGameStopped");
    f.start();
    expect(f.starts).toHaveLength(1); expect(f.starts[0]).toMatchObject({ roomType: 15, pveId: 401, currentFloor: 3 });
    expect(f.room.game).toBe(f.games[0]); expect(f.room.IsPlaying).toBe(true);
    f.starts[0]!.onFinished!(true); f.starts[0]!.onStopped(); f.starts[0]!.onStopped();
    expect(f.room.game).toBeNull(); expect(f.room.IsPlaying).toBe(false); expect(stopped).toHaveBeenCalledTimes(1);
    expect(f.room.host).toBe(f.member); expect(f.member.currentRoom).toBe(f.room);
  });

  it("refuses a fight whose first tick already called onStopped before startPve returned", () => {
    const f = fixture(true), accepted = vi.spyOn(f.room, "startGame"), stopped = vi.spyOn(f.room, "onGameStopped");
    f.start();
    expect(f.starts).toHaveLength(1); expect(f.games[0]!.stop).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled(); expect(stopped).not.toHaveBeenCalled();
    expect(f.room.game).toBeNull(); expect(f.room.IsPlaying).toBe(false);
    expect(f.room.host).toBe(f.member); expect(f.room.IsUsing).toBe(true);
    f.starts[0]!.onStopped(); f.starts[0]!.onFinished!(true);
    expect(f.room.game).toBeNull(); expect(accepted).not.toHaveBeenCalled();
  });

  it.each([15, 4])("ignores the old stop/finish after the same BaseRoom is reused for room type %i and a new fight", type => {
    const f = fixture(); f.start();
    const old = f.starts[0]!;
    f.reuse(type);
    const replacement = f.games[1]!, setup = vi.spyOn(f.room, "sendRoomSetupChange"), stopped = vi.spyOn(f.room, "onGameStopped");
    expect(f.room.RoomType).toBe(type); expect(f.room.game).toBe(replacement); expect(f.room.IsPlaying).toBe(true);
    for (let n = 0; n < 2; n++) { old.onFinished!(n === 0); old.onStopped(); }
    expect(f.room.game).toBe(replacement); expect(f.room.IsPlaying).toBe(true);
    expect(f.room).toMatchObject({ MapId: 12345, currentFloor: 7, Pic: "replacement run", isOpenBoss: true });
    expect(setup).not.toHaveBeenCalled(); expect(stopped).not.toHaveBeenCalled(); expect(replacement.stop).not.toHaveBeenCalled();
  });

  it("ignores repeated old callbacks after a normal stop and a second accepted game in the same room", () => {
    const f = fixture(); f.start(); const old = f.starts[0]!;
    old.onStopped(); expect(f.room.game).toBeNull();
    f.room.currentFloor = 4; f.start();
    const replacement = f.games[1]!, stopped = vi.spyOn(f.room, "onGameStopped");
    old.onStopped(); old.onFinished!(true); old.onStopped(); old.onFinished!(false);
    expect(f.room.game).toBe(replacement); expect(f.room.IsPlaying).toBe(true); expect(f.room.currentFloor).toBe(4); expect(stopped).not.toHaveBeenCalled();
    f.starts[1]!.onStopped(); expect(f.room.game).toBeNull(); expect(f.room.IsPlaying).toBe(false); expect(stopped).toHaveBeenCalledTimes(1);
  });
});
