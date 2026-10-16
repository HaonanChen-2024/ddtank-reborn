import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionType, PveGame, PvpGame, type PlayerSpec } from "../src/index.js";
import { loadPackedAssets } from "../src/node.js";
import { shellDamage } from "../src/game/formulas.js";
import { SimpleNpc } from "../src/pve/livings.js";
import { CE1067 } from "../src/game/petEffects.js";
import "../src/pve/scripts/index.js";

const assets = loadPackedAssets();
// Complete, unchanged rows selected from the same-version db seed; their original
// gzip CRC / field comparison is recorded in the local shield-worker evidence.
const training = {
  ID: 112, Name: "Tân thủ đoạt rương ải 6-2", Type: 10, LevelLimits: 0, SimpleTemplateIds: "10008",
  NormalTemplateIds: "", HardTemplateIds: "", TerrorTemplateIds: "", Pic: "1076", Description: "",
  SimpleGameScript: "GameServerScript.AI.Game.NewTrainingGame2", NormalGameScript: "GameServerScript.AI.Game.NewTrainingGame2",
  HardGameScript: "GameServerScript.AI.Game.NewTrainingGame2", TerrorGameScript: "GameServerScript.AI.Game.NewTrainingGame2",
  Ordering: 0, AdviceTips: "", BossFightNeedMoney: null, LastFloor: null,
};
const trainingMission = {
  Id: 1085, Name: "Hạ các gà xấu xí này để lấy lại đạo cụ 10%", TotalCount: 2, TotalTurn: 100,
  Script: "GameServerScript.AI.Messions.NTM1085", Success: "Hạ toàn bộ gà.", Failure: "Vượt quá turn",
  Description: "Hạ các gà xấu xí này để lấy lại đạo cụ 10%", IncrementDelay: 2400, Delay: 0,
  Title: "TURN,Hạ Gà xấu xí", Param1: -1, Param2: -1, TakeCard: 1, TryAgain: false, TryAgainCost: 0,
};
const trainingNpc = {
  ID: 21001, Name: "Gà tinh anh", Level: 2, Camp: 2, Type: 1, X: -10, Y: -20, Width: 20, Height: 20, Blood: 200,
  MoveMin: 250, MoveMax: 350, BaseDamage: 150, BaseGuard: 0, Defence: 0, Agility: 0, Lucky: 30, Attack: 0,
  ModelID: "game.living.Living002", ResourcesPath: "image/game/living/Living002.swf", DropRate: "5", Experience: 1,
  Delay: 2400, Immunity: 0, Alert: 800, Range: 200, Preserve: 10, Script: "GameServerScript.AI.NPC.NewTrainingNpc21001",
  FireX: 0, FireY: 0, DropId: 0, CurrentBallId: 0, speed: 3, MagicAttack: 0, MagicDefence: 0,
};
const spec = (userId: number, team: number, secondId = 17006, strengthenLevel = 3): PlayerSpec => ({
  userId, nickname: `shield${userId}`, team, grade: 20, attack: 300, defence: 200, agility: 300, lucky: 200,
  baseAttack: 250, baseDefence: 150, hp: 100000, weapon: { templateId: 7001, property8: 5 },
  deputyWeapon: { template: { ...assets.items.get(secondId)! }, strengthenLevel },
});
afterEach(() => vi.restoreAllMocks());

function fixture(secondId = 17006, level = 3) {
  const game = new PvpGame({ id: 1, roomType: 0, gameType: 0, timeType: 3, mapId: 1001, assets,
    players: [spec(1, 1, secondId, level), spec(2, 2)], seed: 7 });
  const [owner, attacker] = game.players; owner!.reset(); attacker!.reset(); game.drain();
  owner!.isAttacking = true; owner!.energy = 2000;
  return { game, owner: owner!, attacker: attacker!, pictures: () => game.drain().filter(e => e.cmd === "SEND_PICTURE") };
}

describe("original AddGuardEquipEffect through UseSecondWeapon", () => {
  it("reduces incoming base damage by the original two H deductions and preserves critical", () => {
    const { game, owner, attacker } = fixture(); expect(owner.useSecondWeapon()).toBe(true);
    const before = owner.blood, d = { damage: 1000, critical: 75 }; expect(owner.takeDamage(attacker, d)).toBe(true);
    expect(d).toEqual({ damage: 788, critical: 75 }); expect(before - owner.blood).toBe(863);
    expect(game.drain()).toContainEqual({ cmd: "SEND_PICTURE", code: 128, livingId: owner.id, type: 6, state: true });
  });

  it("retains armor until the second self-turn and publishes its exact picture off", () => {
    const { owner, pictures } = fixture(); owner.useSecondWeapon(); expect(pictures()).toHaveLength(1);
    owner.prepareSelfTurn(); expect(owner.addArmor).toBe(true); expect(owner.armorBonus()).toBe(106); expect(pictures()).toEqual([]);
    owner.prepareSelfTurn(); expect(owner.addArmor).toBe(false); expect(owner.armorBonus()).toBe(0);
    expect(pictures()).toEqual([{ cmd: "SEND_PICTURE", code: 128, livingId: owner.id, type: 6, state: false }]);
  });

  it.each([
    { id: 17006, base: 80, third: 106, twelfth: 251 },
    { id: 17012, base: 100, third: 133, twelfth: 314 },
    { id: 17022, base: 100, third: 133, twelfth: 314 },
    { id: 17016, base: 120, third: 160, twelfth: 377 },
    { id: 17023, base: 120, third: 160, twelfth: 377 },
  ].flatMap(t => [{ ...t, level: 0, h: t.base }, { ...t, level: 3, h: t.third }, { ...t, level: 12, h: t.twelfth }]))("uses genuine deputy $id at strengthen $level without changing its original P7", ({ id, base, level, h }) => {
    const { owner, attacker } = fixture(id, level); expect(owner.spec.deputyWeapon!.template.property7).toBe(base); owner.useSecondWeapon(); expect(owner.armorBonus()).toBe(h);
    const d = { damage: 2000, critical: 99 }; owner.takeDamage(attacker, d); expect(d).toEqual({ damage: 2000 - 2 * h, critical: 99 });
  });

  it.each([0, -5, 1, 211, 212, 213])("floors base damage %i to one after the two deductions without changing critical", damage => {
    const { owner, attacker } = fixture(); owner.useSecondWeapon(); const d = { damage, critical: 75 }; const blood = owner.blood; owner.takeDamage(attacker, d);
    expect(d).toEqual({ damage: 1, critical: 75 }); expect(blood - owner.blood).toBe(76);
  });

  it("keeps shield handlers in the common victim-hook order and never pre-deducts damage", () => {
    const { owner, attacker } = fixture(), seen: number[] = [];
    owner.hooks.on("beforeTakeDamage", (_l, _s, d) => { seen.push(d.damage); d.damage *= 2; });
    owner.useSecondWeapon(); owner.hooks.on("beforeTakeDamage", (_l, _s, d) => { seen.push(d.damage); });
    const d = { damage: 200, critical: 30 }; owner.takeDamage(attacker, d); expect(seen).toEqual([200, 188]); expect(d).toEqual({ damage: 188, critical: 30 });
  });

  it("refreshes only the existing effect's turn counter, retains H and subscribes exactly once", () => {
    const { owner, attacker, pictures } = fixture(); owner.useSecondWeapon(); const effect = owner.effectList.getOfType(39); pictures(); owner.prepareSelfTurn();
    // Deliberate mid-fight change verifies Start's refresh contract: the original
    // effect retains its captured H, while the ordinary armor accessor reads the current item.
    owner.spec.deputyWeapon!.strengthenLevel = 12; expect(owner.useSecondWeapon()).toBe(true);
    expect(owner.effectList.getOfType(39)).toBe(effect); expect(owner.effectList.all.filter(e => e.type === 39)).toHaveLength(1); expect(pictures()).toEqual([]);
    owner.prepareSelfTurn(); expect(owner.addArmor).toBe(true); expect(pictures()).toEqual([]);
    const d = { damage: 1000, critical: 0 }; owner.takeDamage(attacker, d); expect(d.damage).toBe(788); expect(owner.armorBonus()).toBe(251);
    owner.prepareSelfTurn(); expect(owner.addArmor).toBe(false); expect(pictures()).toEqual([{ cmd: "SEND_PICTURE", code: 128, livingId: owner.id, type: 6, state: false }]);
    const after = { damage: 1000, critical: 0 }; owner.takeDamage(attacker, after); expect(after.damage).toBe(1000);
  });

  it("does not expire on a global round or the opponent's self-turn", () => {
    const { owner, attacker, pictures } = fixture(); owner.useSecondWeapon(); pictures();
    for (let i = 0; i < 4; i++) { owner.prepareNewTurn(); attacker.prepareSelfTurn(); }
    expect(owner.addArmor).toBe(true); expect(owner.effectList.getOfType(39)).toBeDefined(); expect(pictures()).toEqual([]);
  });

  it("reset removes the effect and both hooks, sends one off picture and permits a clean later use", () => {
    const { owner, attacker, pictures } = fixture(); owner.useSecondWeapon(); pictures(); owner.reset();
    expect(owner.addArmor).toBe(false); expect(owner.effectList.getOfType(39)).toBeUndefined(); expect(pictures()).toEqual([{ cmd: "SEND_PICTURE", code: 128, livingId: owner.id, type: 6, state: false }]);
    const d = { damage: 1000, critical: 15 }; owner.takeDamage(attacker, d); expect(d).toEqual({ damage: 1000, critical: 15 });
    owner.prepareSelfTurn(); owner.prepareSelfTurn(); expect(pictures()).toEqual([]); owner.reset(); expect(pictures()).toEqual([]);
    owner.isAttacking = true; owner.energy = 2000; owner.useSecondWeapon(); expect(pictures()).toEqual([{ cmd: "SEND_PICTURE", code: 128, livingId: owner.id, type: 6, state: true }]);
    const next = { damage: 1000, critical: 15 }; owner.takeDamage(attacker, next); expect(next.damage).toBe(788);
  });

  it("preserves energy, delay, usage-count, shot-count and deputy-remaining packet behavior", () => {
    const { game, owner } = fixture(); const energy = owner.energy, delay = owner.delay, remaining = owner.deputyWeaponResCount, uses = owner.useItemCount;
    owner.shootCount = 3; expect(owner.useSecondWeapon()).toBe(true);
    expect(owner.energy).toBe(energy - 200); expect(owner.delay).toBe(delay + 2); expect(owner.deputyWeaponResCount).toBe(remaining - 1); expect(owner.useItemCount).toBe(uses + 1); expect(owner.shootCount).toBe(1);
    expect(game.drain()).toEqual([
      { cmd: "SEND_PICTURE", code: 128, livingId: owner.id, type: 6, state: true },
      { cmd: "ADDATTACK", code: 46, livingId: owner.id, shootCount: 1 },
      { cmd: "PROP", code: 32, livingId: owner.id, type: 254, place: -2, templateId: 17006, userLivingId: owner.id },
      { cmd: "USE_DEPUTY_WEAPON", code: 84, livingId: owner.id, remaining: remaining - 1 },
    ]);
  });

  it("preserves all existing use guards without attaching a shield or spending", () => {
    for (const change of [(p: ReturnType<typeof fixture>["owner"]) => { p.energy = 199; }, (p: ReturnType<typeof fixture>["owner"]) => { p.isAttacking = false; }, (p: ReturnType<typeof fixture>["owner"]) => { p.deputyWeaponResCount = 0; }, (p: ReturnType<typeof fixture>["owner"]) => { p.setBall(3); }]) {
      const { game, owner } = fixture(); change(owner); game.drain(); const energy = owner.energy, delay = owner.delay, remaining = owner.deputyWeaponResCount, uses = owner.useItemCount;
      expect(owner.useSecondWeapon()).toBe(false); expect(owner.useItemCount).toBe(uses + 1); expect(owner.energy).toBe(energy); expect(owner.delay).toBe(delay); expect(owner.deputyWeaponResCount).toBe(remaining); expect(owner.addArmor).toBe(false); expect(owner.effectList.getOfType(39)).toBeUndefined(); expect(game.drain()).toEqual([]);
    }
  });

  it("keeps the real non-shield 17011 healing weapon path separate", () => {
    const { owner, attacker, pictures } = fixture(17011); expect(owner.spec.deputyWeapon!.template.property3).toBe(32); expect(owner.useSecondWeapon()).toBe(true);
    expect(owner.currentBall.id).toBe(120); expect(owner.addArmor).toBe(false); expect(owner.effectList.getOfType(39)).toBeUndefined(); expect(pictures()).toEqual([]);
    const d = { damage: 1000, critical: 20 }; owner.takeDamage(attacker, d); expect(d).toEqual({ damage: 1000, critical: 20 });
  });

  it("applies ordinary shell armor H and the two hook deductions through an actual PvP projectile", () => {
    const { game, owner, attacker } = fixture(); owner.place(500, 200); attacker.place(200, 200); game.map.addPhysical(owner); game.map.addPhysical(attacker);
    let ordinary = 0, raw = 0; owner.hooks.on("beforeTakeDamage", (_l, _s, d) => { ordinary = d.damage; }); owner.useSecondWeapon();
    attacker.baseDamage = 2000; vi.spyOn(game.rng, "nextMax").mockReturnValue(99); game.drain();
    owner.hooks.on("beforeTakeDamage", (_l, _s, d) => { raw = d.damage; expect(d.critical).toBe(0); });
    const before = owner.blood; expect(game.shootImp(attacker, attacker.currentBall.id, owner.x, owner.y - 10, 100, 90, 1, 1)).toBe(true);
    const fire = game.drain().find(e => e.cmd === "FIRE"); if (!fire || fire.cmd !== "FIRE") throw new Error("FIRE missing");
    const hit = fire.bombs.flatMap(b => b.actions).find(a => a.type === ActionType.KILL_PLAYER && a.param1 === owner.id)!;
    expect(hit).toBeDefined(); expect(raw).toBeGreaterThan(1); expect(raw).toBe(ordinary - 212); expect(hit.param2).toBe(raw); expect(before - owner.blood).toBe(raw);
    // Independent unshielded replay establishes the ordinary armor stage too.
    const plain = fixture(); plain.owner.place(500, 200); plain.attacker.place(200, 200); plain.game.map.addPhysical(plain.owner); plain.game.map.addPhysical(plain.attacker); plain.attacker.baseDamage = 2000; vi.spyOn(plain.game.rng, "nextMax").mockReturnValue(99); plain.game.drain();
    expect(plain.game.shootImp(plain.attacker, plain.attacker.currentBall.id, plain.owner.x, plain.owner.y - 10, 100, 90, 1, 1)).toBe(true);
    const plainFire = plain.game.drain().find(e => e.cmd === "FIRE"); if (!plainFire || plainFire.cmd !== "FIRE") throw new Error("plain FIRE missing");
    const plainHit = plainFire.bombs.flatMap(b => b.actions).find(a => a.type === ActionType.KILL_PLAYER && a.param1 === plain.owner.id)!;
    expect(plainHit.param2).toBeGreaterThan(hit.param2 + 212);
    const ordinaryShield = shellDamage(attacker, { baseGuard: owner.baseGuard, defence: owner.defence, armorBonus: 106 }, 0, attacker.currentBall.radii);
    expect(raw).toBeLessThanOrEqual(ordinaryShield - 212);
  });

  it.each([false, true])("keeps the two victim-hook deductions when projectile ignoreArmor is %s", ignoreArmor => {
    const { game, owner, attacker } = fixture(); attacker.ignoreArmor = ignoreArmor; owner.useSecondWeapon();
    const ordinary = shellDamage(attacker, { baseGuard: owner.baseGuard, defence: owner.defence, armorBonus: owner.armorBonus() }, 0, attacker.currentBall.radii);
    if (ignoreArmor) expect(ordinary).toBe(shellDamage(attacker, { baseGuard: 0, defence: 0 }, 0, attacker.currentBall.radii));
    const d = { damage: ordinary, critical: 73 }; owner.takeDamage(attacker, d);
    expect(d).toEqual({ damage: Math.max(1, ordinary - 212), critical: 73 });
  });

  it("deducts the shield before existing player damage reduction and final damage hooks", () => {
    const { owner, attacker } = fixture(); owner.reduceDamePlus = 20; owner.useSecondWeapon();
    let final: number[] = []; owner.hooks.on("afterTakenHit", (_l, _s, damage, critical) => { final = [damage, critical]; });
    const d = { damage: 1000, critical: 75 }, before = owner.blood; owner.takeDamage(attacker, d);
    expect(final).toEqual([788, 75]); expect(before - owner.blood).toBe(863 - Math.trunc(863 * 0.2));
  });

  it("passes shield-reduced ordinary damage, without critical, to the existing CE1067 reflection", () => {
    const { owner, attacker } = fixture(); owner.useSecondWeapon(); new CE1067(1).start(owner); owner.prepareSelfTurn();
    const before = attacker.blood; owner.takeDamage(attacker, { damage: 1000, critical: 75 });
    expect(before - attacker.blood).toBe(Math.trunc(788 * 0.3)); expect(owner.addArmor).toBe(true);
  });

  it("preserves frozen-hit immunity and thawing without consuming or applying the shield", () => {
    const { owner, attacker } = fixture(); owner.useSecondWeapon(); owner.startEffect("ice", 1);
    const before = owner.blood, frozen = { damage: 1000, critical: 75 }; expect(owner.takeDamage(attacker, frozen)).toBe(false);
    expect(frozen).toEqual({ damage: 1000, critical: 75 }); expect(owner.blood).toBe(before); expect(owner.isFrost).toBe(false); expect(owner.addArmor).toBe(true);
    const thawed = { damage: 1000, critical: 75 }; expect(owner.takeDamage(attacker, thawed)).toBe(true); expect(thawed).toEqual({ damage: 788, critical: 75 });
  });

  it("runs the same shield through a genuine PvE NPC's queued melee and raw58 result", () => {
    const game = new PveGame({ id: 1, roomType: 10, gameType: 10, timeType: 3, assets, players: [spec(1, 1)], seed: 7,
      pveInfo: training, hardLevel: 0, strictScripts: true,
      data: { npc: id => id === trainingNpc.ID ? trainingNpc : undefined, mission: id => id === trainingMission.Id ? trainingMission : undefined } });
    const owner = game.players[0]!; owner.reset(); owner.place(200, 200); owner.isAttacking = true; owner.energy = 2000;
    const npc = new SimpleNpc(200, game, trainingNpc, 0, -1, ""); npc.reset(); npc.setXY(180, 200);
    const unshielded = game.livingMakeDamage(npc, owner); owner.useSecondWeapon(); const ordinary = game.livingMakeDamage(npc, owner);
    expect(ordinary).toBeGreaterThan(0); expect(ordinary).toBeLessThan(unshielded); expect(ordinary).toBeLessThanOrEqual(212);
    const before = owner.blood; game.drain(); expect(game.livingBeat(npc, owner, "beatA", 0, 7, 0)).toBe(true);
    const beat = game.update(0).find(e => e.cmd === "RAW" && e.code === 58); expect(before - owner.blood).toBe(8);
    expect(beat).toEqual({ cmd: "RAW", code: 58, livingId: npc.id,
      body: [["str", "beatA"], ["i32", 1], ["i32", owner.id], ["i32", 8], ["i32", owner.blood], ["i32", owner.dander], ["i32", 1]] });
    expect(game.scriptErrors).toEqual([]); expect(game.missingScripts).toEqual([]);
  });
});
