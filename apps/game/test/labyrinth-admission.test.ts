/** Admission/serialization only. No game server, database, network or persistent settlement owner. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FightEvent, PveInfo } from "@ddt/fight";
import { loadPackedAssets } from "@ddt/fight/node";
import { data, pves } from "../../../packages/fight/test/pve-data.js";
import { VirtualPlayer } from "../src/bots/bot.js";
import { DdtFightEngine, serializeEvent } from "../src/fight/ddt.js";
import type { StartPveOptions } from "../src/fight/types.js";
import type { RoomMember } from "../src/game/player.js";

const assets = loadPackedAssets();
const award: FightEvent = { cmd: "LABYRINTH_AWARD", code: 0, livingId: 0, userId: 1, floor: 1, missionId: 40001, bigAward: false };
afterEach(() => vi.restoreAllMocks());

function fixture(with401: boolean, manualClock = false) {
  const seed = new VirtualPlayer({ id: 1, nickname: "Admission", sex: true, level: 10, weaponTemplateId: 7001 });
  const send = vi.fn(), addGP = vi.fn(), addHardCurrency = vi.fn(), reduceHunger = vi.fn();
  const p: RoomMember = {
    id: 1, isBot: false, currentRoom: null, roomIndex: -1, roomTeam: 1, isViewer: false, hasMainWeapon: true, playerState: 1,
    info: { ...seed.info }, send, sendMessage: vi.fn(),
    view() { return { ...seed.view(), id: this.id, info: this.info }; },
  };
  Object.assign(p, { addGP, addHardCurrency, petBag: { equipped: () => null, reduceHunger } });
  // Deliberate isolated identity fixture: supplying data must not bypass the absent settlement owner.
  const configured401: PveInfo = { ...pves.get(2)!, ID: 401, Type: 15 };
  const pveInfo = vi.fn((id: number) => id === 401 ? with401 ? configured401 : undefined : pves.get(id));
  const drop = vi.fn(() => []), giveItems = vi.fn(), onMissionOver = vi.fn(), log = vi.fn();
  const onFinished = vi.fn(), onStopped = vi.fn();
  const engine = new DdtFightEngine({ assets, manualClock, seed: () => 7, pve: { data, pveInfo, drop }, giveItems, onMissionOver, log });
  const setup: StartPveOptions = { roomId: 1, roomType: 15, gameType: 7, timeType: 3, pveId: 401,
    hardLevel: 0, levelLimits: 0, currentFloor: 1, players: [p], onFinished, onStopped };
  return { engine, setup, pveInfo, drop, giveItems, onMissionOver, addGP, addHardCurrency, reduceHunger, send, log, onFinished, onStopped };
}

describe("Labyrinth settlement admission boundary", () => {
  it.each([false, true])("refuses room15 without creating or rewarding a game (explicit401=%s)", with401 => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const f = fixture(with401), before = structuredClone(f.setup.players[0]!.info);
    try {
      expect(f.engine.startPve(f.setup) === null).toBe(true);
      expect(f.engine.games.size).toBe(0);
      expect(interval).not.toHaveBeenCalled();
      expect(f.pveInfo).not.toHaveBeenCalled();
      expect(f.log).toHaveBeenCalledWith(expect.stringContaining("original reward settlement owner"));
      for (const spy of [f.drop, f.giveItems, f.onMissionOver, f.addGP, f.addHardCurrency, f.reduceHunger, f.send, f.onFinished, f.onStopped]) expect(spy).not.toHaveBeenCalled();
      expect(f.setup.players[0]!.info).toEqual(before);
    } finally {
      // Also clean up a timer if an unfixed adapter incorrectly creates the isolated game.
      for (const game of [...f.engine.games.values()]) game.stop();
      f.engine.tick(Date.now());
    }
  });

  it.each([false, true])("never serializes an internal award into GAME_CMD (bigAward=%s)", bigAward => {
    expect(serializeEvent({ ...award, bigAward })).toBeNull();
  });

  it("throws if an internal award reaches an adapter without a settlement owner", () => {
    const f = fixture(false, true);
    const fight = f.engine.startPve({ ...f.setup, roomType: 4, pveId: 2 });
    expect(fight).not.toBeNull();
    try {
      const live = f.engine.games.get(fight!.id)!;
      f.send.mockClear();
      live.game.emit(award);
      expect(() => live.tick(Date.now() + 40)).toThrow(/Labyrinth award.*no settlement owner/);
      for (const spy of [f.drop, f.giveItems, f.onMissionOver, f.addGP, f.addHardCurrency, f.send]) expect(spy).not.toHaveBeenCalled();
    } finally { fight?.stop(); }
  });
});
