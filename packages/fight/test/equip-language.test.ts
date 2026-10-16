import { afterEach, describe, expect, it } from "vitest";
import { AddAttackEffect, AddDefenceEffect, FatalEffect } from "../src/game/equipEffects.js";
import { PvpGame, type PlayerSpec } from "../src/index.js";
import { loadPackedAssets } from "../src/node.js";
import { setTranslator } from "../src/pve/cs.js";

const assets = loadPackedAssets();
const spec = (userId: number, team: number): PlayerSpec => ({
  userId, nickname: `p${userId}`, team, grade: 20, attack: 300, defence: 200, agility: 300, lucky: 200,
  baseAttack: 250, baseDefence: 150, hp: 1500, weapon: { templateId: 7001, property8: 5 },
});

afterEach(() => setTranslator(key => key));

function fixture() {
  const game = new PvpGame({ id: 1, roomType: 0, gameType: 0, timeType: 3, mapId: 1001, assets, players: [spec(1, 1), spec(2, 2)], seed: 7 });
  const [owner, victim] = game.players;
  owner!.reset(); victim!.reset();
  new AddAttackEffect(50, 100).start(owner!);
  new AddDefenceEffect(50, 100).start(victim!);
  new FatalEffect(0, 15112004).start(owner!);
  game.drain();
  return () => {
    owner!.hooks.emit("playerShoot", owner!);
    victim!.hooks.emit("beginAttacked", victim!);
    return game.drain().filter(e => e.cmd === "EQUIP_EFFECT_MSG").map(e => e.message);
  };
}

describe("equipment effect runtime language", () => {
  it("keeps the original English notices without a translator and preserves one-time proc messages", () => {
    const proc = fixture();
    expect(proc()).toEqual(["Attack gem effect!", "First shot: guided!", "Defence gem effect!"]);
    expect(proc()).toEqual([]);
  });

  it("uses the translator installed after imports and effect construction without adding messages", () => {
    const proc = fixture();
    const translated: Record<string, string> = {
      "AttackEffect.Success": "攻击宝珠生效",
      "DefenceEffect.Success": "防御宝珠生效",
      "FatalEffect.Success": "首发引导生效",
    };
    setTranslator(key => translated[key] ?? key);
    expect(proc()).toEqual(["攻击宝珠生效", "首发引导生效", "防御宝珠生效"]);
    expect(proc()).toEqual([]);
  });
});
