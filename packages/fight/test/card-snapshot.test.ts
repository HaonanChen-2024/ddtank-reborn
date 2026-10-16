import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PveGame, PvpGame, type CardSetTables, type PlayerSpec } from "../src/index.js";
import { FiveGodSoldier2Effect, FiveGodSoldier5Effect, FourArtifacts2Effect, FourArtifacts4Effect } from "../src/game/cardEffects.js";
import { loadPackedAssets } from "../src/node.js";
import { SimpleNpc } from "../src/pve/livings.js";
import { data, npcs, pves } from "./pve-data.js";
import "../src/pve/scripts/index.js";

// Real, unchanged same-version seed rows. The adapter owns CardBuff's equipped
// slots/minimum-level construction; these engine inputs include its sentinel.
function rows<T>(name: string): T[] {
  const decoded = JSON.parse(gunzipSync(readFileSync(new URL(`../../db/seed/game/${name}.json.gz`, import.meta.url))).toString("utf8"));
  return Array.isArray(decoded) ? decoded : decoded.rows;
}
const groupRows = rows<{ CardID: number; TemplateID: number }>("Card_Group");
const buffRows = rows<{ CardID: number; condition: number; value: string }>("Card_Buff");
const assets = loadPackedAssets();
function sourceTables() {
  const groups = new Map([5, 9].map(id => [id, groupRows.filter(row => row.CardID === id).map(row => row.TemplateID)]));
  const values = new Map([5, 9].map(id => [id, buffRows.filter(row => row.CardID === id && row.condition > 0)
    .sort((a, b) => b.condition - a.condition).map(row => ({ condition: row.condition, value: row.value }))]));
  const tables: CardSetTables = { groups, buffs: id => values.get(id) };
  return { tables, values };
}
const members = (id: number) => groupRows.filter(row => row.CardID === id && row.TemplateID > 0).map(row => row.TemplateID);
const deck = (id = 5, count = 2, level = 0) => [...members(id).slice(0, count), ...(count >= 2 ? [1000 + level] : [])];
const spec = (userId: number, team: number, cardEffects?: PlayerSpec["cardEffects"]): PlayerSpec => ({
  userId, nickname: `cards${userId}`, team, grade: 30, attack: 300, defence: 200, agility: 300, lucky: 200,
  baseAttack: 250, baseDefence: 150, hp: 10000, weapon: { templateId: 7001, property8: 5 }, cardEffects,
});
function battle(cards?: number[], roomType = 0) {
  const source = sourceTables(), input = cards ? { cards, tables: source.tables } : undefined;
  const game = new PvpGame({ id: 1, roomType, gameType: 0, timeType: 3, mapId: 1001, assets,
    players: [spec(1, 1, input), spec(2, 2)], seed: 7 });
  const [owner, target] = game.players;
  target.reset();
  return { ...source, input, game, owner, target, hit: () => target.takeDamage(owner, { damage: 10, critical: 0 }) };
}
function dungeon(roomType: number) {
  const { tables } = sourceTables();
  const game = new PveGame({ id: 2, roomType, gameType: 7, timeType: 3, assets,
    players: [spec(1, 1, { cards: deck(), tables })], seed: 7, pveInfo: pves.get(2)!, hardLevel: 0, data });
  const owner = game.players[0]; owner.reset();
  const npc = new SimpleNpc(100, game, npcs.get(21001)!, 0, -1, ""); npc.reset();
  return { game, owner, npc };
}

describe("equipped card effects as a battle snapshot", () => {
  it("uses genuine groups 5/9 and descending positive seed tiers", () => {
    const { tables } = sourceTables();
    expect(tables.groups.get(5)).toEqual([314120, 314119, 314118, 314117, 0]);
    expect(tables.groups.get(9)).toEqual([314139, 314138, 314137, 314136, 314135]);
    expect(tables.buffs(5)).toEqual([{ condition: 4, value: "10|20|30|40" }, { condition: 2, value: "1|2|3|4" }]);
    expect(tables.buffs(9)).toEqual([{ condition: 5, value: "5|7|9|11" }, { condition: 2, value: "2|4|6|8" }]);
  });

  it("does not attach card effects in the constructor, and attaches them on reset", () => {
    const f = battle(deck());
    expect(f.owner.cardEffectList.all).toEqual([]);
    expect(f.hit()).toBe(true); expect(f.owner.dander).toBe(0);
    f.owner.reset(); expect(f.owner.cardEffectList.all.map(effect => effect.type)).toEqual([7]);
    f.hit(); expect(f.owner.dander).toBe(1); expect(f.target.isLiving).toBe(true); expect(f.owner.totalKill).toBe(0);
  });

  it("keeps ordinary players without a card snapshot unchanged", () => {
    const f = battle(); f.owner.reset(); f.hit();
    expect(f.owner.cardEffectList.all).toEqual([]); expect(f.owner.dander).toBe(0);
    expect([f.owner.attack, f.owner.defence, f.owner.agility, f.owner.lucky, f.owner.blood]).toEqual([300, 200, 300, 200, 10000]);
  });

  it.each([0, 1, 2, 3, 4])("requires two original group-5 members with %i equipped", count => {
    const f = battle(deck(5, count, 30)); f.owner.reset(); f.hit();
    expect(f.owner.dander).toBe(count >= 2 ? 4 : 0);
    expect(f.owner.cardEffectList.all.map(effect => effect.type)).toEqual(count >= 2 ? [7] : []);
    // Four cards still select the final eligible two-card row. Do not enable
    // the original unreachable four-card stat bonus by picking a highest tier.
    expect([f.owner.attack, f.owner.defence, f.owner.agility, f.owner.lucky]).toEqual([300, 200, 300, 200]);
  });

  it.each([[0, 1], [9, 1], [10, 2], [19, 2], [20, 3], [29, 3], [30, 4]])(
    "uses minimum-card level %i for a per-hit dander bonus of %i", (level, value) => {
      const f = battle(deck(5, 2, level)); f.owner.reset();
      f.hit(); f.hit();
      expect(f.owner.dander).toBe(value * 2); expect(f.target.blood).toBe(9980); expect(f.owner.totalKill).toBe(0);
    });

  it("honors the minimum-level sentinel even when an unrelated equipped card lowers it", () => {
    const f = battle([...members(5).slice(0, 2), members(9)[0], 1009]); f.owner.reset(); f.hit();
    expect(f.owner.grade).toBe(30); expect(f.owner.dander).toBe(1);
  });

  it("preserves the original member-by-card counting for repeated template ids", () => {
    const f = battle([members(5)[0], members(5)[0], 1000]); f.owner.reset(); f.hit();
    expect(f.owner.spec.cardEffects!.cards).toEqual([314120, 314120, 1000]);
    expect(f.owner.dander).toBe(1); expect(f.owner.cardEffectList.all.map(effect => effect.type)).toEqual([7]);
  });

  it("retains the final global group-9 match rather than combining two eligible decks", () => {
    const f = battle([...members(5).slice(0, 2), ...members(9).slice(0, 2), 1030]);
    f.owner.reset(); f.owner.blood = 500; f.hit();
    expect(f.owner.cardEffectList.all.map(effect => effect.type)).toEqual([17]);
    expect(f.owner.dander).toBe(0); expect(f.owner.blood).toBe(500);
  });

  it.each([0, 1])("grants dander after a real nonlethal hit in room %i", roomType => {
    const f = battle(deck(), roomType); f.owner.reset(); f.hit();
    expect(f.owner.dander).toBe(1); expect(f.target.isLiving).toBe(true); expect(f.owner.totalKill).toBe(0);
  });

  it.each([12, 13, 18])("does not grant group-5 dander in non-Match/Freedom room %i", roomType => {
    const f = battle(deck(), roomType); f.owner.reset(); f.hit();
    expect(f.owner.dander).toBe(0);
  });

  it.each([0, 1, 4])("does not activate the group-5 bonus in a real PvE game with room %i", roomType => {
    const { owner, npc } = dungeon(roomType);
    expect(npc.takeDamage(owner, { damage: 10, critical: 0 })).toBe(true);
    expect(npc.isLiving).toBe(true); expect(owner.dander).toBe(0);
  });

  it.each([0, 1])("keeps the isolated group-5/9 effect classes dormant in a real PvE game with room %i", roomType => {
    const { owner, npc } = dungeon(roomType);
    // Isolated class contracts only: the real descending seed dispatcher does
    // not route to these four/five-card bonuses.
    FourArtifacts4Effect(3, "10|20|30|40")(owner);
    FiveGodSoldier2Effect(3, "2|4|6|8")(owner);
    FiveGodSoldier5Effect(3, "5|7|9|11")(owner);
    owner.hooks.emit("playerAfterReset", owner);
    expect([owner.attack, owner.defence, owner.agility, owner.lucky]).toEqual([300, 200, 300, 200]);
    owner.blood = 500; npc.takeDamage(owner, { damage: 10, critical: 0 }); expect(owner.blood).toBe(500);
    const npcBlood = npc.blood; owner.takeDamage(npc, { damage: 100, critical: 19 });
    expect(owner.blood).toBe(381); expect(npc.blood).toBe(npcBlood);
  });

  it("removes old hooks before reapplying the snapshot on every reset", () => {
    const f = battle(deck()); FourArtifacts2Effect(0, "40")(f.owner);
    for (let i = 0; i < 4; i++) {
      f.owner.reset(); f.hit();
      expect(f.owner.dander).toBe(1); expect(f.owner.cardEffectList.all).toHaveLength(1);
    }
    f.owner.cardEffectList.stopAll(); f.owner.setDander(0); f.hit();
    expect(f.owner.dander).toBe(0); expect(f.owner.cardEffectList.all).toEqual([]);
    f.owner.reset(); f.hit(); expect(f.owner.dander).toBe(1);
  });

  it("restores base stats and binds the new card hooks before playerAfterReset", () => {
    const f = battle(deck()), observed: unknown[] = [];
    f.owner.hooks.on("playerAfterReset", player => observed.push({ attack: player.attack, blood: player.blood, effects: player.cardEffectList.all.map(effect => effect.type) }));
    f.owner.attack = 9999; f.owner.blood = 1; f.owner.reset();
    expect(observed).toEqual([{ attack: 300, blood: 10000, effects: [7] }]);
  });

  it("copies the equipped list, group maps/members, and buff arrays/rows before the first reset", () => {
    const cards = deck(5, 2, 30), f = battle(cards), copied = f.owner.spec.cardEffects!;
    expect(copied).not.toBe(f.input); expect(copied.cards).not.toBe(cards);
    expect(copied.tables.groups).not.toBe(f.tables.groups);
    expect(copied.tables.groups.get(5)).not.toBe(f.tables.groups.get(5));
    expect(copied.tables.buffs(5)).not.toBe(f.values.get(5));
    expect(copied.tables.buffs(5)![1]).not.toBe(f.values.get(5)![1]);
    cards.splice(0); f.tables.groups.get(5)!.splice(0); f.tables.groups.clear();
    f.values.get(5)![1].condition = 99; f.values.get(5)![1].value = "99|99|99|99";
    f.values.get(5)!.splice(0); f.values.set(5, [{ condition: 1, value: "88|88|88|88" }]);
    f.tables.buffs = () => [{ condition: 1, value: "77|77|77|77" }];
    for (let i = 0; i < 2; i++) { f.owner.reset(); f.hit(); expect(f.owner.dander).toBe(4); }
    expect(copied.cards).toEqual(deck(5, 2, 30));
    expect(copied.tables.buffs(5)).toEqual([{ condition: 4, value: "10|20|30|40" }, { condition: 2, value: "1|2|3|4" }]);
  });

  it.each([0, 1, 2, 3, 4, 5])("keeps the original group-9 lifesteal dead and five-card thorns unreachable with %i equipped", count => {
    const f = battle(deck(9, count, 30)); f.owner.reset(); f.owner.blood = 500; f.hit();
    expect(f.owner.blood).toBe(500);
    const targetBefore = f.target.blood;
    expect(f.owner.takeDamage(f.target, { damage: 100, critical: 19 })).toBe(true);
    expect(f.owner.blood).toBe(381); expect(f.target.blood).toBe(targetBefore);
    expect(f.owner.cardEffectList.all.map(effect => effect.type)).toEqual(count >= 2 ? [17] : []);
  });
});
