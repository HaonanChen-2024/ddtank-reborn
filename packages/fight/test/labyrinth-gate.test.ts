import { describe, expect, it } from "vitest";
import { GameState, PveGame, type PlayerSpec } from "../src/index.js";
import "../src/pve/scripts/index.js";
import { loadPackedAssets } from "../src/node.js";
import { data, pves } from "./pve-data.js";

const assets = loadPackedAssets();
const player: PlayerSpec = {
  userId: 1, nickname: "gate-test", team: 1, grade: 40, attack: 200, defence: 150,
  agility: 200, lucky: 150, baseAttack: 250, baseDefence: 100, hp: 1_000_000,
  weapon: { templateId: 7001, property8: 5 },
};

function newMaze(): PveGame {
  // Engine-only fixture: production seeds lack Pve_Info 401 / Mission_Info 40001..40030.
  // Keep the actual registered game, first-floor mission, NPC brain and map; these headers
  // are not an installation of the missing production difficulty/reward configuration.
  return new PveGame({
    id: 1, roomType: 15, gameType: 7, timeType: 3, assets, players: [player], seed: 3,
    pveInfo: { ...pves.get(2)!, ID: 401, Type: 15, SimpleGameScript: "GameServerScript.AI.Game.Labyrinth" },
    hardLevel: 0, strictScripts: true,
    data: {
      npc: data.npc,
      mission: (id) => id >= 40001 && id <= 40030 ? {
        ...data.mission(1085)!, Id: id, TotalCount: 10, TotalTurn: 1000,
        Script: `GameServerScript.AI.Messions.Labyrinth${id}`,
      } : undefined,
    },
  });
}

describe("Labyrinth donor gate contract", () => {
  it("actual first-floor AI enables the gate after all ten NPCs die without spawning a gate at (1,0)", () => {
    const game = newMaze();
    expect(game.TotalMissionCount).toBe(30);
    expect([...game.Misssions.values()].map((mission) => mission.Id)).toEqual(Array.from({ length: 30 }, (_, i) => 40001 + i));
    for (let now = 0; now < 120_000 && game.livings.length < 10; now += 40) {
      game.update(now);
      if (game.state === GameState.Loading) game.handle(1, { cmd: "LOAD", progress: 100 }, now);
    }
    expect(game.state).toBe(GameState.Playing);
    expect(game.map.info.id).toBe(1224);
    expect(game.livings).toHaveLength(10);
    expect(game.canGameOver()).toBe(false);
    expect(game.CanEnterGate).toBe(false);
    const physicals = [...game.physObjs];
    for (const npc of [...game.livings]) npc.takeDamage(game.players[0]!, { damage: npc.blood, critical: 0 });
    game.drain();

    expect(game.canGameOver()).toBe(true);
    expect(game.CanEnterGate).toBe(true);
    expect([...game.physObjs]).toEqual(physicals);
    expect(game.drain().filter((e) => e.cmd === "RAW" && e.code === 48)).toEqual([]);
    // Rechecking the same completed mission must not add duplicate physical gates either.
    expect(game.canGameOver()).toBe(true);
    expect([...game.physObjs]).toEqual(physicals);
    expect(game.drain()).toEqual([]);
    expect(game.missingScripts).toEqual([]);
    expect(game.scriptErrors).toEqual([]);
  });

  it("the boolean API also clears permission without a physical-object packet", () => {
    const game = newMaze();
    expect(game.CreateGate(true)).toBeUndefined();
    expect(game.CanEnterGate).toBe(true);
    expect(game.CreateGate(false)).toBeUndefined();
    expect(game.CanEnterGate).toBe(false);
    expect(game.physObjs.size).toBe(0);
    expect(game.drain()).toEqual([]);
  });

  it("preserves the coordinate overload for existing physical-gate callers", () => {
    const game = newMaze();
    const gate = game.CreateGate(250, 340, "coordinate-gate", "fixture.gate", "open");
    expect([gate.x, gate.y, gate.name, gate.model, gate.currentAction]).toEqual([250, 340, "coordinate-gate", "fixture.gate", "open"]);
    expect(game.physObjs.has(gate)).toBe(true);
    expect(game.CanEnterGate).toBe(false);
    expect(game.drain().filter((e) => e.cmd === "RAW" && e.code === 48)).toHaveLength(1);
  });
});
