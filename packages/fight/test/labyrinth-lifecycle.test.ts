import { describe, expect, it } from "vitest";
import { GameState, Player, PveGame, type FightCommand, type FightEvent, type GameMap, type PlayerSpec, type RawEvent } from "../src/index.js";
import "../src/pve/scripts/index.js";
import { loadPackedAssets } from "../src/node.js";
import { data, pves } from "./pve-data.js";

const assets = loadPackedAssets();
const userId = 1;
const originalProcessAwards = Array.from({ length: 99 }, (_, i) => String(i)).join("-");
const spec: PlayerSpec = {
  userId, nickname: "labyrinth-lifecycle", team: 1, grade: 40, attack: 200, defence: 150,
  agility: 200, lucky: 150, baseAttack: 250, baseDefence: 100, hp: 1_000_000,
  weapon: { templateId: 7001, property8: 5 },
};

function maze(currentFloor = 1, processAwards = originalProcessAwards, dropCalls: number[][] = []): PveGame {
  // These are engine-only headers: the production seeds lack Pve_Info 401 and
  // Mission_Info 40001..40030. They do not install or assert production turns,
  // difficulty, drops or reward values. All 30 registered original mission AIs,
  // actual seeded NPCs/brains and packed collision maps remain in use.
  return new PveGame({
    id: currentFloor, roomType: 15, gameType: 7, timeType: 3, assets, players: [spec],
    seed: 3, now: 0, currentFloor, hardLevel: 0, strictScripts: true,
    labyrinthProcessAwards: new Map([[userId, processAwards]]),
    pveInfo: { ...pves.get(2)!, ID: 401, Type: 15, SimpleGameScript: "GameServerScript.AI.Game.Labyrinth" },
    data: {
      npc: data.npc,
      mission: (id) => id >= 40001 && id <= 40030 ? {
        ...data.mission(1085)!, Id: id, TotalCount: id % 2 ? 10 : 1, TotalTurn: 1000,
        Script: `GameServerScript.AI.Messions.Labyrinth${id}`,
      } : undefined,
    },
    // Deterministic UI-list fixture only; not the missing production loot table.
    drops: { copyDrop: (missionId, floor) => {
      dropCalls.push([missionId, floor]);
      return [{ templateId: 11020, count: 1 }, { templateId: 11916, count: 2 }];
    } },
  });
}

class Clock {
  now = 0;
  readonly events: FightEvent[] = [];
  constructor(readonly game: PveGame) {}

  send(command: FightCommand, from = userId): void {
    this.events.push(...this.game.handle(from, command, this.now));
  }

  tick(): void {
    this.now += 40;
    this.events.push(...this.game.update(this.now));
    if (this.game.state === GameState.Loading) {
      for (const p of this.game.players) if (p.loadingProcess < 100) this.send({ cmd: "LOAD", progress: 100 }, p.spec.userId);
    }
  }

  until(done: () => boolean, reason: string, maxMs = 180_000): void {
    const end = this.now + maxMs;
    while (!done() && this.now < end && this.game.state !== GameState.Stopped) this.tick();
    expect(done(), `${reason}; state=${this.game.state}, floor=${this.game.SessionId}, turn=${this.game.turnIndex}, errors=${this.game.scriptErrors.join("; ")}`).toBe(true);
  }

  forMs(ms: number): void {
    const end = this.now + ms;
    while (this.now < end) this.tick();
  }

  raw(code: number): RawEvent[] {
    return this.events.filter((e): e is RawEvent => e.cmd === "RAW" && e.code === code);
  }

  gates(): RawEvent[] {
    return this.raw(48).filter((e) => e.body[4]?.[1] === "asset.game.transmitted");
  }

  awards() {
    return this.events.filter((e) => e.cmd === "LABYRINTH_AWARD");
  }

  playerTurn(): void {
    this.until(() => this.game.state === GameState.Playing && this.game.currentLiving instanceof Player && this.game.currentLiving.isAttacking,
      "the actual mission never reached an attacking player turn");
  }

  skip(): void { this.send({ cmd: "SKIPNEXT", spendTime: 0 }); }

  killNpc(id: number): void {
    const npc = this.game.enemiesOf(this.game.players[0]!).find((living) => "npcInfo" in living && (living.npcInfo as { ID: number }).ID === id);
    expect(npc, `actual NPC ${id} did not spawn`).toBeDefined();
    npc!.takeDamage(this.game.players[0]!, { damage: npc!.blood, critical: 0 });
    this.events.push(...this.game.drain());
    expect(npc!.isLiving).toBe(false);
  }
}

function expectClean(game: PveGame): void {
  expect(game.missingScripts).toEqual([]);
  expect(game.scriptErrors).toEqual([]);
}

function expectGate(clock: Clock, clearedMap: GameMap, gateIndex = 0): void {
  expect(clock.gates()).toHaveLength(gateIndex + 1);
  const gate = clock.gates()[gateIndex]!;
  const game = clock.game, player = game.players[0]!;
  const width = clearedMap.info.foregroundWidth ?? clearedMap.bound.width;
  const x = player.x + 150 <= width ? player.x + 150 : player.x - 150;
  const ground = clearedMap.findYLineNotEmptyPointDown(x, player.y);
  const y = ground.x === 0 && ground.y === 0 ? clearedMap.bound.height + 1 : ground.y;
  expect(gate.livingId).toBe(0);
  // Original EnterNextFloor: offset 150, ground search then -60, transmitted/out.
  expect(gate.body.slice(1, 9)).toEqual([
    ["i32", 3], ["i32", x], ["i32", y - 60], ["str", "asset.game.transmitted"],
    ["str", "out"], ["i32", 1], ["i32", 1], ["i32", 1],
  ]);
}

function expectAward(clock: Clock, floor: number, bigAward: boolean): void {
  expect(clock.awards().filter((e) => e.floor === floor)).toEqual([{
    cmd: "LABYRINTH_AWARD", code: 0, livingId: clock.game.players[0]!.id, userId,
    floor, missionId: 40000 + floor, bigAward,
  }]);
}

function clearOddFloor(clock: Clock): void {
  for (const npc of [...clock.game.livings]) {
    npc.takeDamage(clock.game.players[0]!, { damage: npc.blood, critical: 0 });
    clock.events.push(...clock.game.drain());
  }
  clock.skip();
}

describe("original Labyrinth mission lifecycle (engine fixtures, not production configuration)", () => {
  it("three actual floors reset readiness each time and require a new valid 137 after every grounded door", () => {
    const game = maze(), clock = new Clock(game);
    clock.playerTurn();
    expect(game.map.info.id).toBe(1224);
    const clearedMap = game.map;
    expect(game.livings.filter((npc) => npc.isLiving)).toHaveLength(10);
    const ready = game.pp.get(game.players[0]!)!.ready;
    clock.send({ cmd: "DELIVER", ready: true }); // Playing is not a ready state in the original.
    expect(game.pp.get(game.players[0]!)!.ready).toBe(ready);
    expect(game.SessionId).toBe(1);

    clearOddFloor(clock);
    clock.until(() => clock.gates().length > 0, "odd-floor clear did not enter the original win movie and create its door");
    expect(game.IsWin).toBe(true); // Set by the actual Labyrinth40001.OnGameOverMovie.
    expectGate(clock, clearedMap);
    expect(clock.raw(136)).toEqual([]);
    expectAward(clock, 1, false);

    clock.forMs(2000);
    expect(clock.events.filter((e) => e.cmd === "GAME_LOAD")).toHaveLength(1);
    const waitingReady = game.pp.get(game.players[0]!)!.ready;
    clock.send({ cmd: "DELIVER", ready: false });
    clock.send({ cmd: "DELIVER", ready: true }, 999_999);
    expect(game.pp.get(game.players[0]!)!.ready).toBe(waitingReady);
    clock.forMs(2000);
    expect(clock.events.filter((e) => e.cmd === "GAME_LOAD")).toHaveLength(1);

    clock.send({ cmd: "DELIVER", ready: true });
    clock.until(() => clock.events.filter((e) => e.cmd === "GAME_LOAD").length === 2, "valid 137 never loaded floor 2");
    const loads = clock.events.filter((e) => e.cmd === "GAME_LOAD");
    expect(loads.map((e) => e.mapId)).toEqual([1224, 1237]);
    expect(game.SessionId).toBe(2);
    clock.playerTurn();
    expect(game.pp.get(game.players[0]!)!.ready).toBe(false);

    const secondMap = game.map;
    clock.killNpc(40002);
    clock.skip();
    clock.until(() => clock.raw(136).length === 1, "the actual second floor never reached its big box");
    clock.skip();
    clock.until(() => clock.gates().length === 2, "the actual second floor never created its door");
    expectGate(clock, secondMap, 1);
    expectAward(clock, 2, true);
    clock.forMs(2000);
    expect(clock.events.filter((e) => e.cmd === "GAME_LOAD")).toHaveLength(2);

    clock.send({ cmd: "DELIVER", ready: true });
    clock.until(() => clock.events.filter((e) => e.cmd === "GAME_LOAD").length === 3, "a fresh 137 never loaded floor 3");
    clock.playerTurn();
    expect(game.map.info.id).toBe(1232);
    expect(game.pp.get(game.players[0]!)!.ready).toBe(false);
    const thirdMap = game.map;
    expect(game.livings.filter((npc) => npc.isLiving)).toHaveLength(10);
    clearOddFloor(clock);
    clock.until(() => clock.gates().length === 3, "the actual third floor never created its door");
    expectGate(clock, thirdMap, 2);
    expectAward(clock, 3, false);
    clock.forMs(4000);
    expect(clock.events.filter((e) => e.cmd === "GAME_LOAD")).toHaveLength(3);
    expect(clock.awards()).toHaveLength(3);
    expect(clock.raw(136)).toHaveLength(1);
    expectClean(game);
  });

  it("the original even-floor boss shows RAW136 once on a subsequent player turn and the later door does not repeat it", () => {
    const dropCalls: number[][] = [];
    const game = maze(2, originalProcessAwards, dropCalls), clock = new Clock(game);
    clock.playerTurn();
    expect(game.map.info.id).toBe(1237);
    const clearedMap = game.map;
    const killedDuringTurn = game.turnIndex;
    clock.killNpc(40002);
    expect(clock.raw(136)).toEqual([]);
    clock.skip();
    clock.until(() => clock.raw(136).length > 0, "even-floor boss never produced the original player-turn big box");
    expect(game.turnIndex).toBeGreaterThan(killedDuringTurn);
    expect(game.currentLiving).toBeInstanceOf(Player);
    expect(clock.raw(136)).toHaveLength(1);
    expect(clock.raw(136)[0]!.livingId).toBe(game.players[0]!.id);
    expect(clock.raw(136)[0]!.body).toEqual([["i32", 2], ["i32", 11020], ["i32", 11916]]);
    expectAward(clock, 2, true);
    expect(dropCalls).toEqual([[40002, 2]]); // Original CopyDrop receives the floor, not a user/living id.
    clock.forMs(2000);
    expect(clock.raw(136)).toHaveLength(1);
    expect(clock.awards()).toHaveLength(1);

    clock.skip();
    clock.until(() => clock.gates().length > 0, "even-floor big box did not reach its successful door");
    expect(game.IsWin).toBe(true);
    expectGate(clock, clearedMap);
    clock.forMs(2000);
    expect(clock.raw(136)).toHaveLength(1);
    expect(clock.events.filter((e) => e.cmd === "GAME_LOAD")).toHaveLength(1);
    clock.send({ cmd: "DELIVER", ready: true });
    clock.until(() => clock.events.filter((e) => e.cmd === "GAME_LOAD").length === 2, "even-floor 137 never loaded floor 3");
    expect(game.map.info.id).toBe(1232);
    expect(clock.raw(136)).toHaveLength(1);
    expect(clock.awards()).toHaveLength(1);
    expect(dropCalls).toEqual([[40002, 2]]);
    expectClean(game);
  });

  it.each([1, 2])("a previously claimed floor %i slot cannot emit a box or candidate award", (floor) => {
    // The other original numeric slots remain, including 11/12. They must not
    // match floors 1/2 by substring after that exact slot became 'i'.
    const processAwards = originalProcessAwards.split("-");
    processAwards[floor] = "i";
    expect(processAwards).toContain(String(floor + 10));
    expect(processAwards).not.toContain(String(floor));
    const game = maze(floor, processAwards.join("-")), clock = new Clock(game);
    clock.playerTurn();
    const clearedMap = game.map;
    if (floor === 1) {
      clearOddFloor(clock);
    } else {
      const killedDuringTurn = game.turnIndex;
      clock.killNpc(40002);
      clock.skip();
      clock.until(() => game.turnIndex > killedDuringTurn && game.currentLiving instanceof Player && game.currentLiving.isAttacking,
        "an already claimed even floor did not reach the subsequent player turn");
      expect(clock.raw(136)).toEqual([]);
      clock.skip();
    }
    clock.until(() => clock.gates().length > 0, "already claimed floors must still retain their original door progression");
    expect(game.IsWin).toBe(true);
    expectGate(clock, clearedMap);
    clock.forMs(2000);
    expect(clock.raw(136)).toEqual([]);
    expect(clock.awards()).toEqual([]);
    expectClean(game);
  });

  it("a real player death ends in defeat without a success door, big box or next-floor load", () => {
    const game = maze(), clock = new Clock(game);
    clock.playerTurn();
    clock.send({ cmd: "SUICIDE" });
    clock.until(() => game.state === GameState.Stopped, "defeated Labyrinth never stopped");
    const over = clock.events.find((e) => e.cmd === "GAME_MISSION_OVER");
    expect(over?.cmd === "GAME_MISSION_OVER" && over.isWin).toBe(false);
    expect(game.IsWin).toBe(false);
    expect(clock.gates()).toEqual([]);
    expect(clock.raw(136)).toEqual([]);
    expect(clock.awards()).toEqual([]);
    expect(clock.events.filter((e) => e.cmd === "GAME_LOAD")).toHaveLength(1);
    expectClean(game);
  });

  it("the actual 30th mission's three boss stages clear and stop without a nonexistent 31st floor", () => {
    const game = maze(30), clock = new Clock(game);
    clock.playerTurn();
    expect(game.map.info.id).toBe(1280);
    for (const id of [40041, 40042, 40038]) {
      clock.playerTurn();
      clock.killNpc(id);
      clock.skip();
      if (id !== 40038) {
        const nextId = id === 40041 ? 40042 : 40038;
        clock.until(() => game.enemiesOf(game.players[0]!).some((npc) => "npcInfo" in npc && (npc.npcInfo as { ID: number }).ID === nextId),
          `actual final mission did not create boss stage ${nextId}`);
      }
    }
    clock.until(() => clock.raw(136).length > 0, "final mission did not show its big box");
    clock.skip();
    clock.until(() => game.state === GameState.Stopped, "final successful mission did not stop naturally");
    expect(game.IsWin).toBe(true);
    const missionOver = clock.events.filter((e) => e.cmd === "GAME_MISSION_OVER");
    expect(missionOver).toHaveLength(1);
    expect(missionOver[0]).toMatchObject({ code: 112, missionId: 40030, isWin: true });
    expect(clock.events.filter((e) => e.cmd === "PVE_STOPPED")).toHaveLength(1);
    expect(clock.events.find((e) => e.cmd === "PVE_STOPPED")).toMatchObject({ isWin: true, hasNextMission: false });
    expect(clock.raw(111)).toEqual([]);
    expect(clock.events.filter((e) => e.cmd === "GAME_OVER" || e.cmd === "GAME_ALL_MISSION_OVER")).toEqual([]);
    expect(clock.raw(136)).toHaveLength(1);
    expectAward(clock, 30, true);
    expect(clock.awards()).toHaveLength(1);
    expect(clock.gates()).toEqual([]);
    expect(clock.events.filter((e) => e.cmd === "GAME_LOAD")).toHaveLength(1);
    expect(game.Misssions.has(31)).toBe(false);
    expectClean(game);
  });
});
