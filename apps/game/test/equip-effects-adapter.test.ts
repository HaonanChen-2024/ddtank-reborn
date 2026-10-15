import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EquipEffectTemplate, type Player, GameState, solveAim } from "@ddt/fight";
import { loadPackedAssets } from "@ddt/fight/node";
import { GSPacket } from "@ddt/protocol";
import { VirtualPlayer } from "../src/bots/bot.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { emptyStatTables } from "../src/game/stats.js";

// Actual committed local templates, not reference-server stats or replacements for missing A01 IDs.
const templates = new Map((JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString()) as ItemTemplate[]).map(t => [t.TemplateID, t]));
const assets = loadPackedAssets();
const running: DdtFightEngine[] = [];
afterEach(() => { for (const e of running.splice(0)) for (const g of e.games.values()) g.stop(); vi.restoreAllMocks(); });

function worn(place: number, holes: number[], templateId = 1101) {
  const item = ItemInfo.createFromTemplate(templates.get(templateId)!, 1, 0);
  item.Place = place;
  holes.forEach((id, i) => { item[`Hole${i + 1}` as "Hole1"] = id; });
  return item;
}

/** Real lobby GamePlayer + PlayerEquipInventory -> DdtFightEngine -> pure combat Player, with no I/O. */
function fixture(items: ItemInfo[], missing: number[] = []) {
  const seed = new VirtualPlayer({ id: 1, nickname: "EquipBridge", sex: true, level: 20, weaponTemplateId: 7001 });
  const human = new GamePlayer({ send() {}, disconnect() {}, remoteAddress: "equip-bridge-test" },
    { ...seed.info, ID: 1, UserID: 1, Attack: 500, Defence: 200, Agility: 300, Luck: 200, hp: 1500 }, defaultMatch(1), 1, "test");
  human.statTables = emptyStatTables(id => missing.includes(id) ? undefined : templates.get(id));
  // Loading is tested through the real inventory; stat recomputation/packet output are unrelated to this bridge.
  human.equipBag.setHooks({ onSlotsChanged() {} });
  human.equipBag.loadItems([worn(6, [], 7001), ...items]);
  human.baseAttack = 250; human.baseDefence = 150;
  const bot = new VirtualPlayer({ id: 2, nickname: "NoBags", sex: false, level: 20, weaponTemplateId: 7001 });
  const logs: string[] = [];
  const engine = new DdtFightEngine({ assets, manualClock: true, seed: () => 7, log: s => logs.push(s) });
  running.push(engine);
  const fight = engine.startPvp({ roomId: 1, roomType: 0, gameType: 0, timeType: 3, mapId: 1001, red: [human], blue: [bot], onStopped() {} });
  expect(fight, logs.join("\n")).not.toBeNull();
  const game = engine.games.get(fight!.id)!.game;
  const me = game.players.find(p => p.spec.userId === human.id)!;
  const foe = game.players.find(p => p.spec.userId === bot.id)!;
  return { human, bot, engine, game, fight: fight!, me, foe };
}

function effects(player: Player): readonly EquipEffectTemplate[] | undefined {
  return (player.spec as typeof player.spec & { equipEffects?: EquipEffectTemplate[] }).equipEffects;
}

describe("equipment gem production combat bridge", () => {
  it("copies all six positive holes from slots 0..30 in order, retaining duplicates and template values", () => {
    const a = worn(0, [311109, 0, -1, 311112, 311109, 312106]);
    const z = worn(30, [312103, 311209]);
    // EquipBuffer itself adds no Count, validity, category or timestamp gate to GetItemAt.
    a.Count = 0; a.ValidDate = 1; a.IsUsed = true; a.BeginDate = new Date("2000-01-01");
    const { me } = fixture([a, z, worn(31, [312103])]);
    expect(effects(me)).toEqual([311109, 311112, 311109, 312106, 312103, 311209].map(id => {
      const t = templates.get(id)!;
      return { templateId: id, property3: t.Property3, property4: t.Property4, property5: t.Property5 };
    }));
    expect(me.effectList.all.map(e => e.constructor.name)).toEqual(["MakeCriticalEffect", "AddTurnEquipEffect", "AssimilateDamageEffect", "RecoverBloodEffect"]);
  });

  it("skips missing templates and unworn/no-hole items and accepts bots without inventories", () => {
    const { me, foe } = fixture([worn(0, [311109, 987654321]), worn(4, []), worn(31, [312106])], [311109]);
    expect(effects(me)).toEqual([]);
    expect(me.effectList.all).toHaveLength(0);
    expect(foe.effectList.all).toHaveLength(0);
    expect(effects(foe) ?? []).toEqual([]);
    expect(() => { me.reset(); foe.reset(); }).not.toThrow();
  });

  it("absorbs an incoming hit through an equipped real local template", () => {
    const { game, me, foe } = fixture([worn(0, [312106])]);
    me.reset(); foe.reset(); vi.spyOn(game.rng, "nextMax").mockReturnValue(0);
    me.blood = 800;
    const hit = { damage: 100, critical: 20 };
    me.takeDamage(foe, hit);
    expect(hit).toEqual({ damage: 0, critical: 0 });
    expect(me.blood).toBe(900); expect(me.defendGemLimit).toBe(3);
  });

  it("recovers HP after taking a hit and rebuilds effects without duplicate hooks on reset", () => {
    const { game, me, foe } = fixture([worn(0, [312103, 312103])]);
    const initial = me.effectList.all[0];
    for (let i = 0; i < 3; i++) me.reset();
    foe.reset(); vi.spyOn(game.rng, "nextMax").mockReturnValue(0);
    expect(me.effectList.all).toHaveLength(1); expect(me.effectList.all[0]).not.toBe(initial);
    me.blood = 800; me.takeDamage(foe, { damage: 100, critical: 0 });
    expect(me.blood).toBe(800); expect(me.defendGemLimit).toBe(3);
    me.takeDamage(foe, { damage: 100, critical: 0 });
    expect(me.blood).toBe(700); // shared cooldown prevents another recovery
  });

  it("keeps the first duplicate's magnitude and the highest duplicate probability", () => {
    const { game, me, foe } = fixture([worn(0, [312106, 312206])]);
    me.reset(); foe.reset(); vi.spyOn(game.rng, "nextMax").mockReturnValue(3);
    me.blood = 700;
    const hit = { damage: 600, critical: 0 };
    me.takeDamage(foe, hit);
    expect(me.effectList.all).toHaveLength(1);
    expect(hit.damage).toBe(0); expect(me.blood).toBe(1200);
  });

  it("triggers an extra turn from the real Player.shoot path and applies its original template energy tier", () => {
    const { game, me, foe } = fixture([worn(0, [311112])]);
    me.reset(); foe.reset(); vi.spyOn(game.rng, "nextMax").mockReturnValue(0);
    expect(me.shoot(me.x, me.y - 10, 500, -45)).toBe(true);
    expect(me.addQuipTurn).toBe(true); expect(me.attackGemLimit).toBe(4);
    const energy = me.energy;
    me.prepareSelfTurn();
    expect(me.addQuipTurn).toBe(false); expect(me.energy).toBe(Math.trunc(energy / 2));
  });

  it("takes a critical gem from a real equipment hole through loading, reset and an actual projectile hit", () => {
    const { human, bot, engine, game, fight, me, foe } = fixture([worn(0, [311109])]);
    let now = Date.now();
    for (let i = 0; i < 1000 && game.state !== GameState.Playing; i++) {
      engine.tick(now += 40);
      if (game.state === GameState.Loading) for (const member of [human, bot]) {
        const packet = new GSPacket(91); packet.writeByte(16); packet.writeInt(100);
        fight.processData(member, GSPacket.parse(packet.encode()));
      }
    }
    expect(game.state).toBe(GameState.Playing);
    expect(me.effectList.all).toHaveLength(1);
    const aim = solveAim({ map: game.map, ball: me.currentBall, from: me, target: { x: foe.x, y: foe.y - 40 },
      bodies: [{ id: foe.id, x: foe.x, y: foe.y, team: foe.team, bound: foe.bound }] });
    expect(aim).not.toBeNull();
    // Suppress the ordinary critical roll, then deterministically exercise the unchanged 3% local gem.
    vi.spyOn(game.rng, "nextMax").mockReturnValueOnce(99).mockReturnValue(0);
    const hit = vi.spyOn(foe, "takeDamage");
    expect(me.shoot(aim!.muzzle.x, aim!.muzzle.y, aim!.force, aim!.angle)).toBe(true);
    expect(hit).toHaveBeenCalled();
    expect(hit.mock.calls[0][0]).toBe(me);
    expect(hit.mock.calls[0][1].critical).toBeGreaterThan(0);
    expect(me.attackGemLimit).toBe(4); expect(foe.attackGemLimit).toBe(0);
  });
});
