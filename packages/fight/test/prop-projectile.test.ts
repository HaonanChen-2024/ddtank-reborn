import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState, PvpGame, type GameOptions, type PlayerSpec } from "../src/index.js";
import { loadPackedAssets } from "../src/node.js";

const assets = loadPackedAssets();
const spec = (templateId: number): PlayerSpec => ({
  userId: 1, nickname: "props", team: 1, grade: 20, attack: 300, defence: 200, agility: 300, lucky: 200,
  baseAttack: 250, baseDefence: 150, hp: 10000, weapon: { templateId, property8: 5 },
});

function fixture(templateId = 7006, usePropItem?: GameOptions["usePropItem"]) {
  const game = new PvpGame({ id: 1, roomType: 0, gameType: 0, timeType: 3, mapId: 1001,
    assets, players: [spec(templateId)], seed: 7, usePropItem });
  const player = game.players[0]!;
  player.reset();
  player.isAttacking = true;
  player.energy = 2000;
  game.state = GameState.Playing;
  game.currentLiving = player;
  game.drain();
  const use = (id: number, bag = 1, place = -1) => game.propUse(player, bag, id, place);
  const fire = () => {
    expect(player.shoot(400, 200, 400, -45)).toBe(true);
    const event = game.drain().find(e => e.cmd === "FIRE");
    if (!event || event.cmd !== "FIRE") throw new Error("missing FIRE");
    return event;
  };
  return { game, player, use, fire };
}

afterEach(() => vi.restoreAllMocks());

describe("original PropUseCommand projectile selector", () => {
  // vendor/DDTank41 7fcb5529: Game.Logic/Cmd/PropUseCommand.cs:93-110.
  // The original accumulates the template IDs up to twice that ID: 20002 / 20008.
  it.each([10001, 10004])("keeps one use of %i on the ordinary projectile", id => {
    const { player, use, fire } = fixture();
    expect(use(id)).toBe(true);
    expect(fire().bombs.map(b => b.ballId)).toEqual([player.mainBallId]);
  });

  it.each([[1, -1], [1, 0], [2, 0]])("selects multi-ball after two +2 uses through bag %i place %i", (bag, place) => {
    const { player, use, fire } = fixture();
    expect(use(10001, bag, place)).toBe(true);
    expect(use(10001, bag, place)).toBe(true);
    expect(player.shootCount).toBe(5);
    expect(player.currentShootMinus).toBeCloseTo(0.36);
    expect(player.multiBallId).not.toBe(player.mainBallId);
    for (let shot = 0; shot < 5; shot++) {
      expect(fire().bombs.map(b => b.ballId)).toEqual([player.multiBallId]);
    }
    expect(player.prop).toBe(0);
    expect(player.isAttacking).toBe(false);
  });

  it.each([2, 3])("selects wound-ball after %i damage-boost uses without changing the damage multiplier", count => {
    const { player, use, fire } = fixture();
    for (let i = 0; i < count; i++) expect(use(10004)).toBe(true);
    expect(player.currentDamagePlus).toBe(1 + count * 0.5);
    expect(player.addWoundBallId).not.toBe(player.mainBallId);
    expect(fire().bombs.map(b => b.ballId)).toEqual([player.addWoundBallId]);
    expect(player.prop).toBe(0);
  });

  it("uses each weapon's configured branches, including every packed main weapon", () => {
    const { game, player, use } = fixture();
    const shot = vi.spyOn(game, "shootImp").mockReturnValue(true);
    const configs = [...assets.ballConfigs.values()].filter(c => assets.items.get(c.templateId)?.categoryId === 7);
    expect(configs.length).toBeGreaterThan(100);
    for (const config of configs) {
      for (const [id, expected] of [[10001, config.commonMultiBall], [10004, config.commonAddWound]]) {
        player.spec.weapon.templateId = config.templateId;
        player.prepareNewTurn();
        player.isAttacking = true;
        player.energy = 2000;
        expect(use(id), `weapon ${config.templateId}, first prop ${id}`).toBe(true);
        expect(use(id), `weapon ${config.templateId}, second prop ${id}`).toBe(true);
        expect(player.shoot(400, 200, 400, -45)).toBe(true);
        expect(shot.mock.lastCall?.[1], `weapon ${config.templateId}, prop ${id}`).toBe(expected);
        player.skip();
      }
    }
  });

  it("retains the original mixed-ID behavior instead of inventing a priority", () => {
    const { player, use, fire } = fixture();
    expect(use(10001)).toBe(true);
    expect(use(10004)).toBe(true);
    expect(fire().bombs.map(b => b.ballId)).toEqual([player.mainBallId]);
  });

  it.each(["energy", "inventory", "sealed"])("does not count a rejected %s use towards the appearance", reason => {
    let available = true;
    const { player, use, fire } = fixture(7006, () => available);
    if (reason === "energy") player.energy = 0;
    if (reason === "inventory") available = false;
    if (reason === "sealed") player.isSeal = true;
    expect(use(10004)).toBe(false);
    player.energy = 2000;
    available = true;
    player.isSeal = false;
    expect(use(10004)).toBe(true);
    expect(fire().bombs.map(b => b.ballId)).toEqual([player.mainBallId]);
  });

  it("keeps three-way, POW and bomb overrides ahead of prop appearance", () => {
    for (const override of ["three-way", "pow", "bomb"] as const) {
      const { player, use, fire } = fixture();
      expect(use(10004)).toBe(true);
      expect(use(10004)).toBe(true);
      if (override === "three-way") expect(use(10003)).toBe(true);
      if (override === "pow") {
        player.dander = 200;
        expect(player.useSpecialSkill()).toBe(true);
      }
      if (override === "bomb") expect(use(10022, 2, 0)).toBe(true);
      const expected = override === "pow" ? player.spBallId : override === "bomb" ? 4 : player.mainBallId;
      expect(fire().bombs.every(b => b.ballId === expected)).toBe(true);
    }
  });

  it("clears the selector on skip so a later turn starts with the ordinary appearance", () => {
    const { player, use, fire } = fixture();
    expect(use(10004)).toBe(true);
    expect(use(10004)).toBe(true);
    player.skip();
    player.prepareNewTurn();
    player.isAttacking = true;
    expect(fire().bombs.map(b => b.ballId)).toEqual([player.mainBallId]);
  });
});
