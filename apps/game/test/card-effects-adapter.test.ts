import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, game, migrateDb, seedDatabase, type DbHandle } from "@ddt/db";
import { type CardSetTables, RoomType } from "@ddt/fight";
import { loadPackedAssets } from "@ddt/fight/node";
import { VirtualPlayer } from "../src/bots/bot.js";
import { Templates } from "../src/db/templates.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import { newCard, type UserCardRow } from "../src/game/cards.js";
import { type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { emptyStatTables } from "../src/game/stats.js";

const seed = JSON.parse(readFileSync(new URL("./fixtures/treasure-card-groups.json", import.meta.url), "utf8")) as {
  groups: (typeof game.Card_Group.$inferInsert)[]; buffs: (typeof game.Card_Buff.$inferInsert)[];
};
const goods = JSON.parse(readFileSync(new URL("./fixtures/treasure-card-boxes.json", import.meta.url), "utf8")) as ItemTemplate[];
const assets = loadPackedAssets();
let db: DbHandle, templates: Templates;
const engines: DdtFightEngine[] = [];
beforeAll(async () => {
  db = await createDb("pglite:memory"); await migrateDb(db);
  await seedDatabase(db, { only: ["Card_Group", "Card_Buff"] });
  templates = new Templates();
  await templates.loadPetsCards(db.db, "zh-CN");
});
afterAll(async () => { await db.close(); });
afterEach(() => { for (const engine of engines.splice(0)) for (const fight of engine.games.values()) fight.stop(); });

function card(id: number, place: number, level = 0, persistedId = 100 + place): UserCardRow {
  return { ...newCard(1, id, 0), Place: place, Level: level, CardID: persistedId };
}

function fixture(cards: UserCardRow[], options: { missing?: number[]; roomType?: number; cardSets?: CardSetTables } = {}) {
  const seed = new VirtualPlayer({ id: 1, nickname: "CardBridge", sex: true, level: 20, weaponTemplateId: 7001 });
  const human = new GamePlayer({ send() {}, disconnect() {}, remoteAddress: "card-bridge-test" },
    { ...seed.info, ID: 1, UserID: 1, Attack: 500, Defence: 200, Agility: 300, Luck: 200, hp: 1500 }, defaultMatch(1), 1, "test");
  human.statTables = emptyStatTables(id => options.missing?.includes(id) ? undefined : goods.find(t => t.TemplateID === id));
  human.cardBag.load(cards);
  human.baseAttack = 250; human.baseDefence = 150;
  const bot = new VirtualPlayer({ id: 2, nickname: "NoCards", sex: false, level: 20, weaponTemplateId: 7001 });
  const engine = new DdtFightEngine({ assets, manualClock: true, seed: () => 7, cardSets: options.cardSets ?? templates.cardSets });
  engines.push(engine);
  const fight = engine.startPvp({ roomId: 1, roomType: options.roomType ?? RoomType.Match, gameType: 0, timeType: 3,
    mapId: 1001, red: [human], blue: [bot], onStopped() {} });
  expect(fight).not.toBeNull();
  const game = engine.games.get(fight!.id)!.game;
  const me = game.players.find(p => p.spec.userId === human.id)!;
  const foe = game.players.find(p => p.spec.userId === bot.id)!;
  me.reset(); foe.reset();
  return { human, me, foe, game };
}

describe("original treasure card group combat bridge", () => {
  it("loads only original groups5/9, retaining members and positive tiers in descending order", () => {
    expect([...templates.cardSets.groups.keys()]).toEqual([5, 9]);
    for (const id of [5, 9]) {
      expect(templates.cardSets.groups.get(id)).toEqual(seed.groups.filter(r => r.CardID === id).map(r => r.TemplateID));
      expect(templates.cardSets.buffs(id)).toEqual(seed.buffs.filter(r => r.CardID === id && r.condition! > 0)
        .sort((a, b) => b.condition! - a.condition!).map(r => ({ condition: r.condition, value: r.value })));
    }
    expect(templates.cardSets.buffs(1)).toBeUndefined();
  });

  it.each([[0, 1], [9, 1], [10, 2], [19, 2], [20, 3], [29, 3], [30, 4], [44, 4]])(
    "takes card level%s through the real lobby and an actual nonlethal hit (dander%s)", (level, dander) => {
      const { me, foe } = fixture([card(314117, 0, level), card(314118, 1, level)]);
      expect(me.spec.cardEffects?.cards).toEqual([314117, 314118, 1000 + Math.min(30, level)]);
      foe.takeDamage(me, { damage: 10, critical: 0 });
      expect(foe.isLiving).toBe(true); expect(me.dander).toBe(dander);
    });

  it("uses the lowest valid worn card even when it has CardID0; skips missing templates and unworn slots", () => {
    const { me } = fixture([card(314117, 0, 30), card(314118, 1, 30), card(314135, 2, 10, 0),
      card(314136, 3, 0), card(314137, 5, 0)], { missing: [314136] });
    expect(me.spec.cardEffects?.cards).toEqual([314117, 314118, 1010]);
  });

  it("retains the original nested-match count for repeated identities and zero-count equipped copies", () => {
    const { me, foe } = fixture([card(314117, 0), card(314117, 1)]);
    foe.takeDamage(me, { damage: 10, critical: 0 });
    expect(me.cardEffectList.all).toHaveLength(1); expect(me.dander).toBe(1);
    expect(me.spec.cardEffects?.cards).toEqual([314117, 314117, 1000]);
  });

  it("keeps one card and bots without card bags silent", () => {
    const { me, foe } = fixture([card(314117, 0, 30)]);
    expect(me.spec.cardEffects).toBeUndefined(); expect(foe.spec.cardEffects).toBeUndefined();
    foe.takeDamage(me, { damage: 10, critical: 0 }); expect(me.dander).toBe(0);
  });

  it("preserves the original persistence identity gate for newly equipped CardID0 copies", () => {
    const { human, me, foe } = fixture([card(314117, 0, 30, 0), card(314118, 1, 30, 0)]);
    expect(me.spec.cardEffects).toBeUndefined();
    human.cardBag.getItemAt(0)!.CardID = 401; human.cardBag.getItemAt(1)!.CardID = 402;
    me.reset(); foe.takeDamage(me, { damage: 10, critical: 0 });
    expect(me.dander).toBe(0); // Saved identities can affect the next fight, never an existing snapshot.
  });

  it("preserves the original global overwrite when two cards from each deck are worn", () => {
    const { me, foe } = fixture([314117, 314118, 314135, 314136].map((id, i) => card(id, i, 30)));
    me.blood = 500;
    foe.takeDamage(me, { damage: 100, critical: 0 });
    expect(me.cardEffectList.all.map(e => e.type)).toEqual([17]);
    expect(me.dander).toBe(0); expect(me.blood).toBe(500);
  });

  it("freezes worn rows and table values for the battle and rebuilds without duplicate hooks", () => {
    const tables: CardSetTables = { groups: new Map([...templates.cardSets.groups].map(([id, members]) => [id, [...members]])),
      buffs: id => rows.get(id) };
    const rows = new Map([5, 9].map(id => [id, templates.cardSets.buffs(id)!.map(r => ({ ...r }))]));
    const { human, me, foe } = fixture([card(314117, 0, 20), card(314118, 1, 20)], { cardSets: tables });
    human.cardBag.getItemAt(0)!.Level = 0; human.cardBag.removeCardAt(1);
    tables.groups.get(5)!.splice(0); rows.get(5)![1]!.value = "99|99|99|99";
    for (let i = 0; i < 3; i++) me.reset();
    foe.takeDamage(me, { damage: 10, critical: 0 });
    expect(me.dander).toBe(3); expect(me.cardEffectList.all).toHaveLength(1);
  });

  it("preserves the original lower-tier overwrite with four cards and the original dead five-card heal", () => {
    const four = fixture([314117, 314118, 314119, 314120].map((id, i) => card(id, i, 30)));
    expect(four.me.attack).toBe(500); expect(four.me.cardEffectList.all.map(e => e.type)).toEqual([7]);
    four.foe.takeDamage(four.me, { damage: 100, critical: 0 }); expect(four.me.dander).toBe(4);
    const five = fixture([314135, 314136, 314137, 314138, 314139].map((id, i) => card(id, i, 30)));
    five.me.blood = 500; five.foe.blood = 500;
    five.foe.takeDamage(five.me, { damage: 100, critical: 0 }); expect(five.me.blood).toBe(500);
    five.me.takeDamage(five.foe, { damage: 100, critical: 0 }); expect(five.foe.blood).toBe(400);
    expect(five.me.cardEffectList.all.map(e => e.type)).toEqual([17]);
  });
});
