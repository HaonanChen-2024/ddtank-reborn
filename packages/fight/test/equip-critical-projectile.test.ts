import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionType, AssimilateDamageEffect, MakeCriticalEffect, PvpGame, type PlayerSpec } from "../src/index.js";
import { loadPackedAssets } from "../src/node.js";

const assets = loadPackedAssets();
const spec = (userId: number, team: number): PlayerSpec => ({
  userId, nickname: `p${userId}`, team, grade: 20, attack: 300, defence: 200, agility: 300, lucky: 200,
  baseAttack: 250, baseDefence: 150, hp: 1500, weapon: { templateId: 7001, property8: 5 },
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const game = new PvpGame({ id: 1, roomType: 0, gameType: 0, timeType: 3, mapId: 1001, assets, players: [spec(1, 1), spec(2, 2)], seed: 7 });
  const [owner, victim] = game.players;
  owner!.reset(); victim!.reset();
  owner!.place(200, 200); victim!.place(500, 200);
  game.map.addPhysical(owner!); game.map.addPhysical(victim!);
  game.drain();
  // No ordinary critical; a 100% gem still procs. The actual SimpleBomb performs flight, collision and damage.
  vi.spyOn(game.rng, "nextMax").mockReturnValue(99);
  const fire = () => {
    expect(game.shootImp(owner!, owner!.currentBall.id, victim!.x, victim!.y - 10, 100, 90, 1, 1)).toBe(true);
    const event = game.drain().find(e => e.cmd === "FIRE");
    if (!event || event.cmd !== "FIRE") throw new Error("Projectile did not emit FIRE");
    const hit = event.bombs.flatMap(b => b.actions).find(a => a.type === ActionType.KILL_PLAYER && a.param1 === victim!.id);
    expect(hit).toBeDefined();
    return hit!;
  };
  return { game, owner: owner!, victim: victim!, fire };
}

describe("MakeCritical through real projectile collision", () => {
  it("procs on the shooter before victim damage hooks using the exact C# gem formula", () => {
    const { owner, victim, fire } = fixture();
    new MakeCriticalEffect(0, 100).start(owner);
    let baseDamage = 0, critical = 0;
    victim.hooks.on("beforeTakeDamage", (_l, source, d) => {
      expect(source).toBe(owner); baseDamage = d.damage; critical = d.critical;
    });
    const hit = fire();
    expect(baseDamage).toBeGreaterThan(0);
    expect(critical).toBe(Math.trunc(0.5 + owner.lucky * 0.0005 * baseDamage));
    expect(critical).toBeGreaterThan(0);
    expect(hit.param2).toBe(baseDamage + critical); expect(hit.param3).toBe(2);
    expect(owner.attackGemLimit).toBe(4); expect(victim.attackGemLimit).toBe(0);
  });

  it("does not let a victim's attack gem boost an unequipped shooter's hit", () => {
    const { owner, victim, fire } = fixture();
    new MakeCriticalEffect(0, 100).start(victim);
    const hit = fire();
    expect(hit.param3).toBe(1);
    expect(owner.attackGemLimit).toBe(0); expect(victim.attackGemLimit).toBe(0);
  });

  it("lets the victim absorb the shooter's already computed critical without reversing either gem owner", () => {
    const { owner, victim, fire } = fixture();
    new MakeCriticalEffect(0, 100).start(owner);
    new AssimilateDamageEffect(500, 100).start(victim);
    const before = victim.blood;
    const hit = fire();
    expect(hit.param2).toBe(0); expect(hit.param3).toBe(1);
    expect(victim.blood).toBe(before);
    expect(owner.attackGemLimit).toBe(4); expect(victim.defendGemLimit).toBe(3);
  });

  it("cleans the proc particle after shooting and detaches both hooks when stopped", () => {
    const { owner, victim, fire } = fixture();
    const effect = new MakeCriticalEffect(0, 100);
    effect.start(owner); fire();
    expect(owner.flyingPartical).toBe(65);
    expect(owner.shoot(victim.x, victim.y - 10, 100, 90)).toBe(true);
    expect(owner.flyingPartical).toBe(0);
    effect.stop(); owner.attackGemLimit = 0; victim.blood = victim.maxBlood; victim.isLiving = true;
    // A second projectile at a fresh target position must not use the detached owner hook.
    victim.place(500, 200);
    expect(fire().param3).toBe(1); expect(owner.attackGemLimit).toBe(0);
    owner.flyingPartical = 17; owner.hooks.emit("afterPlayerShooted", owner);
    expect(owner.flyingPartical).toBe(17);
  });
});
