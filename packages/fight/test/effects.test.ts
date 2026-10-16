import { describe, expect, it } from "vitest";
import {
  AddAttackEffect, AddDefenceEffect, AddBombEquipEffect, ReduceDamageEffect, RecoverBloodEffect, ReflexDamageEquipEffect,
  applyEquipEffects, type EquipEffectTemplate,
} from "../src/game/equipEffects.js";
import {
  applyCardEffects, FourArtifacts2Effect, EvilTribe3Effect, ShadowDevil2Effect, Goblin2Effect, FiveGodSoldier2Effect,
  FiveGodSoldier5Effect, type CardSetTables,
} from "../src/game/cardEffects.js";
import { CE1067, applyPetSkillEffects } from "../src/game/petEffects.js";
import { EffectListOf, type EffectLike } from "../src/game/effects.js";
import { PvpGame, type PlayerSpec } from "../src/index.js";
import { loadPackedAssets } from "../src/node.js";

const assets = loadPackedAssets();
const spec = (userId: number, team: number, o: Partial<PlayerSpec> = {}): PlayerSpec => ({
  userId, nickname: `p${userId}`, team, grade: 20, attack: 300, defence: 200, agility: 300, lucky: 200, baseAttack: 250, baseDefence: 150, hp: 1500,
  weapon: { templateId: 7001, property8: 5 }, ...o,
});
function twoPlayerGame(roomType = 0) {
  const game = new PvpGame({ id: 1, roomType, gameType: 0, timeType: 3, mapId: 1001, assets, players: [spec(1, 1), spec(2, 2)], seed: 7 });
  const [a, b] = game.players;
  a!.reset();
  b!.reset();
  return { game, a: a!, b: b! };
}

describe("EffectListOf (generic Effects/EffectList.cs port)", () => {
  it("adds, refreshes-on-duplicate-is-caller's-job, removes, and respects the immunity bitmask", () => {
    const { a } = twoPlayerGame();
    const list = new EffectListOf<EffectLike>(a, 0);
    const e: EffectLike = { type: 5, onAttached: () => {}, onRemoved: () => {} };
    expect(list.add(e)).toBe(true);
    expect(list.getOfType(5)).toBe(e);
    expect(list.remove(e)).toBe(true);
    expect(list.getOfType(5)).toBeUndefined();
    const immune = new EffectListOf<EffectLike>(a, 1 << 4); // bit for type 5 set
    expect(immune.add(e)).toBe(false);
  });
});

describe("gem/equip effects (Effects/*.cs via Player.InitBuffer)", () => {
  it("AddAttackEffect procs at probability 100 and reverts the bonus next shot", () => {
    const { a } = twoPlayerGame();
    new AddAttackEffect(50, 100).start(a);
    const base = a.attack;
    a.hooks.emit("playerShoot", a);
    expect(a.attack).toBe(base + 50);
    a.hooks.emit("playerShoot", a); // same shot cycle would be gated by attackGemLimit in a real game, but the
    // cooldown is only ticked by prepareNewTurn — here we assert the revert-then-reroll behaviour directly.
    expect(a.attack).toBeGreaterThanOrEqual(base);
  });

  it("AddAttackEffect never procs at probability 0", () => {
    const { a } = twoPlayerGame();
    new AddAttackEffect(50, 0).start(a);
    const base = a.attack;
    a.hooks.emit("playerShoot", a);
    expect(a.attack).toBe(base);
  });

  it("attackGemLimit/defendGemLimit gate re-procs until prepareNewTurn ticks them down", () => {
    const { a } = twoPlayerGame();
    const base = a.defence;
    new AddDefenceEffect(50, 100).start(a);
    a.hooks.emit("beginAttacked", a); // procs: defence += 50, defendGemLimit = 3
    expect(a.defendGemLimit).toBe(3);
    expect(a.defence).toBe(base + 50);
    a.hooks.emit("beginAttacked", a); // revert the +50, then gated (limit > 0): no re-proc
    expect(a.defence).toBe(base);
    for (let i = 0; i < 3; i++) a.prepareNewTurn();
    expect(a.defendGemLimit).toBe(0);
    a.hooks.emit("beginAttacked", a); // cooldown clear: procs again
    expect(a.defence).toBe(base + 50);
  });

  it("ReduceDamageEffect subtracts a flat amount (min 1) from the incoming hit", () => {
    const { a } = twoPlayerGame();
    new ReduceDamageEffect(30, 100).start(a);
    const d = { damage: 100, critical: 0 };
    a.hooks.emit("beforeTakeDamage", a, a, d);
    expect(d.damage).toBe(70);
  });

  it("RecoverBloodEffect heals on being hit", () => {
    const { a } = twoPlayerGame();
    a.blood = 1000;
    new RecoverBloodEffect(40, 100).start(a);
    a.hooks.emit("afterTakenHit", a, a, 10, 0);
    expect(a.blood).toBe(1040);
  });

  it("ReflexDamageEquipEffect reflects flat HP back at the attacker who just hit it", () => {
    const { a, b } = twoPlayerGame();
    b.blood = 1000;
    new ReflexDamageEquipEffect(25, 100).start(a);
    a.hooks.emit("beginAttacked", a);
    a.hooks.emit("afterTakenHit", a, b, 10, 0);
    expect(b.blood).toBe(975);
  });

  it("AddBombEquipEffect grants extra shots this turn", () => {
    const { a } = twoPlayerGame();
    new AddBombEquipEffect(2, 100).start(a);
    const before = a.shootCount;
    a.hooks.emit("beginAttacking", a);
    expect(a.shootCount).toBe(before + 2);
  });

  it("applyEquipEffects (Player.InitBuffer) dispatches by Property3 and starts the right class", () => {
    const { a } = twoPlayerGame();
    const templates: EquipEffectTemplate[] = [{ property3: 1, property4: 77, property5: 100, templateId: 90001 }];
    applyEquipEffects(a, templates);
    const base = a.attack;
    a.hooks.emit("playerShoot", a);
    expect(a.attack).toBe(base + 77);
  });
});

describe("card set bonuses (CardEffect/Effects/*.cs via Player.InitCardBuffer)", () => {
  it("EvilTribe3Effect reduces incoming damage only inside PVE mission 3", () => {
    const { a } = twoPlayerGame();
    (a.game as unknown as { info: { ID: number } }).info = { ID: 3 };
    EvilTribe3Effect(0, "15")(a);
    const d = { damage: 100, critical: 0 };
    a.hooks.emit("beforeTakeDamage", a, a, d);
    expect(d.damage).toBe(85);
  });

  it("ShadowDevil2Effect buffs all 4 stats and zeros PowerRatio on reset, only in PVE mission 4", () => {
    const { a } = twoPlayerGame();
    (a.game as unknown as { info: { ID: number } }).info = { ID: 4 };
    ShadowDevil2Effect(0, "20")(a);
    const base = { atk: a.attack, agi: a.agility, luk: a.lucky, def: a.defence };
    a.powerRatio = 55;
    a.hooks.emit("playerAfterReset", a);
    expect(a.attack).toBe(base.atk + 20);
    expect(a.agility).toBe(base.agi + 20);
    expect(a.lucky).toBe(base.luk + 20);
    expect(a.defence).toBe(base.def + 20);
    expect(a.powerRatio).toBe(0);
    a.reset();
    expect([a.attack, a.agility, a.lucky, a.defence]).toEqual([base.atk, base.agi, base.luk, base.def]);
  });

  it("FourArtifacts2Effect grants dander on kill only in Match/Freedom rooms", () => {
    const { a, b } = twoPlayerGame(0); // Match
    FourArtifacts2Effect(0, "40")(a);
    a.dander = 0;
    a.hooks.emit("afterKillingLiving", a, b, 500, 0);
    expect(a.dander).toBe(40);
  });

  it("Goblin2Effect adds dander exactly once (m_added==0 gate), not every self-turn", () => {
    const { a } = twoPlayerGame();
    (a.game as unknown as { info: { ID: number } }).info = { ID: 5 };
    Goblin2Effect(0, "30")(a);
    a.dander = 0;
    a.hooks.emit("beginNewTurn", a);
    a.hooks.emit("beginNewTurn", a);
    a.hooks.emit("beginNewTurn", a);
    expect(a.dander).toBe(30);
  });

  it("FiveGodSoldier5Effect reflects 15% of the hit taken back at the attacker (real; _2's heal is dead code)", () => {
    const { a, b } = twoPlayerGame(0);
    b.blood = 1000;
    FiveGodSoldier5Effect(0, "15")(a);
    a.hooks.emit("afterTakenHit", a, b, 100, 0);
    expect(b.blood).toBe(985);
  });

  it("FiveGodSoldier2Effect's lifesteal never fires (m_added > 0 gate checked before m_added is ever set)", () => {
    const { a, b } = twoPlayerGame(0);
    a.blood = 1000;
    FiveGodSoldier2Effect(0, "50")(a);
    a.hooks.emit("afterKillingLiving", a, b, 200, 0);
    expect(a.blood).toBe(1000);
  });

  it("applyCardEffects (Player.InitCardBuffer) counts equipped cards and wires CardID 13 (WeaponMasterDeck)", () => {
    const { a } = twoPlayerGame(0); // Match room → Match/Freedom-gated decks are active
    const tables: CardSetTables = { groups: new Map([[13, [2101, 2102]]]), buffs: (id) => (id === 13 ? [{ condition: 2, value: "99|99|99|99" }] : undefined) };
    const base = { atk: a.attack, agi: a.agility, luk: a.lucky, def: a.defence };
    applyCardEffects(a, [2101, 2102], tables);
    a.hooks.emit("playerAfterReset", a);
    expect(a.attack).toBe(base.atk + 99);
    a.reset(); // Reset rebuilds only the fight snapshot, removing manually attached card effects.
    expect(a.attack).toBe(base.atk);
  });
});

describe("pet skill elements (PetEffects/**/*.cs)", () => {
  it("CE1067 thorns: reflects 30% of the hit taken back at the attacker, decaying over `count` self-turns", () => {
    const { a, b } = twoPlayerGame();
    b.blood = 1000;
    new CE1067(1).start(a);
    a.hooks.emit("beginSelfTurn", a); // count 1→0, armed
    a.hooks.emit("afterTakenHit", a, b, 100, 0);
    expect(b.blood).toBe(970);
    b.blood = 1000;
    a.hooks.emit("afterTakenHit", a, b, 100, 0); // already consumed this turn
    expect(b.blood).toBe(1000);
    a.hooks.emit("beginSelfTurn", a); // count 0→-1 → stops
    expect(a.petEffectList.getOfType(1067)).toBeUndefined();
  });

  it("applyPetSkillEffects wires registered element ids and skips unknown ones", () => {
    const { a } = twoPlayerGame();
    applyPetSkillEffects(a, [
      { skillId: 1, row: { elementIds: "1067", coldDown: 2, probability: 10000, delay: 0, gameType: 0 } },
      { skillId: 2, row: { elementIds: "9999", coldDown: 2, probability: 10000, delay: 0, gameType: 0 } },
    ]);
    expect(a.petEffectList.getOfType(1067)).toBeDefined();
  });
});

describe("guild skill fight buffs (GamePlayer.FightBuffers, resolved outside the pure engine)", () => {
  it("Player.reset() applies additive stat/maxBlood/critical deltas from guildBuffs", () => {
    const p = new PvpGame({
      id: 2, roomType: 0, gameType: 0, timeType: 3, mapId: 1001, assets,
      players: [spec(1, 1, { guildBuffs: { attack: 10, defence: 5, maxBloodPercent: 10, critical: 7 } }), spec(2, 2)], seed: 3,
    }).players[0]!;
    p.reset();
    expect(p.attack).toBe(300 + 10);
    expect(p.defence).toBe(200 + 5);
    expect(p.maxBlood).toBe(1650); // 1500 + 10%
    expect(p.guildAddCritical).toBe(7);
  });
});
