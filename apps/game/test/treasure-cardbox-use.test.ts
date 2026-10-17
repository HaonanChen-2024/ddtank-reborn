import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { RoomType } from "@ddt/fight";
import { loadPackedAssets } from "@ddt/fight/node";
import { GSPacket } from "@ddt/protocol";
import { VirtualPlayer } from "../src/bots/bot.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { loadUserCardBag } from "../src/db/pets-cards.js";
import { Templates } from "../src/db/templates.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { registerPets } from "../src/handlers/pets.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Complete shipped rows, including the ordinary grade-20 requirement. No toy cards or upgrades.
const goods = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString("utf8")) as ItemTemplate[];
const levels = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/LevelInfo.json.gz", import.meta.url))).toString("utf8")) as { Grade: number; Blood: number }[];
const cases = [
  { box: 20117, card: 314117, Attack: 252, Defence: 62, Agility: 46, Luck: 32 },
  { box: 20118, card: 314118, Attack: 252, Defence: 66, Agility: 42, Luck: 32 },
  { box: 20119, card: 314119, Attack: 256, Defence: 62, Agility: 42, Luck: 32 },
  { box: 20120, card: 314120, Attack: 252, Defence: 62, Agility: 42, Luck: 36 },
  { box: 20135, card: 314135, Attack: 254, Defence: 64, Agility: 43, Luck: 33 },
  { box: 20136, card: 314136, Attack: 253, Defence: 63, Agility: 44, Luck: 34 },
  { box: 20137, card: 314137, Attack: 254, Defence: 63, Agility: 44, Luck: 33 },
  { box: 20138, card: 314138, Attack: 253, Defence: 64, Agility: 43, Luck: 34 },
  { box: 20139, card: 314139, Attack: 254, Defence: 64, Agility: 44, Luck: 34 },
];
const baseline = { Attack: 250, Defence: 60, Agility: 40, Luck: 30, hp: 2456 };
const now = new Date("2026-10-16T08:00:00Z"), blood = new Map(levels.map(row => [row.Grade, row.Blood]));
const registry = new HandlerRegistry(); registerPets(registry);
const assets = loadPackedAssets(), engines: DdtFightEngine[] = [];
let h: DbHandle, templates: Templates, sequence = 0;
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  await seedDatabase(h, { only: ["CardUpdateCondition", "CardUpdateInfo", "Card_Group", "Card_Buff"] });
  templates = await new Templates().load(h.db, 1, "original");
  templates.items = new Map(goods.filter(row => row.TemplateID === 7006 || cases.some(value => value.box === row.TemplateID || value.card === row.TemplateID)).map(row => [row.TemplateID, row]));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) for (const fight of engine.games.values()) fight.stop();
});
afterAll(async () => { await h?.close(); });

function stats(p: GamePlayer) {
  const { Attack, Defence, Agility, Luck, hp } = p.info;
  return { Attack, Defence, Agility, Luck, hp };
}
function balances(p: GamePlayer) {
  const { Gold, Money, GiftToken, GP, Grade } = p.info;
  return { Gold, Money, GiftToken, GP, Grade };
}
async function fixture(id: number, count = 3) {
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `carduse${++sequence}`, NickName: `CardUse${sequence}`, Grade: 20, IsFirst: 1 }).returning();
  const sent: GSPacket[] = [], world = new Map<number, GamePlayer>(), error = vi.fn();
  const makePlayer = async () => {
    const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "cardbox-use-isolated-memory" },
      (await loadPlayerInfo(h.db, row!.UserID))!, defaultMatch(row!.UserID), 1, "test", grade => blood.get(grade) ?? 0);
    p.statTables = templates.stats;
    return p;
  };
  const p = await makePlayer(); world.set(p.id, p);
  const addBox = (target: GamePlayer, templateId: number, place: number, n: number) => {
    const item = ItemInfo.createFromTemplate(templates.findItem(templateId)!, n, 0, now);
    item.IsBinds = true; // A bound treasure reward, preserved in its real goods row.
    expect(target.equipBag.addItemTo(item, place)).toBe(true); return item;
  };
  expect(p.equipBag.addItemTo(ItemInfo.createFromTemplate(templates.findItem(7006)!, 1, 0, now), 6)).toBe(true);
  const box = addBox(p, id, 31, count);
  expect(box.ItemID).toBe(0); expect(box.template.NeedLevel).toBe(20); expect(p.info.Grade).toBe(20);
  await p.saveIntoDatabase(h.db); expect(box.ItemID).toBeGreaterThan(0); sent.length = 0;
  const ctx = { db: h, templates, now: () => new Date(now), world, log: { error }, lang: { t: (key: string) => key } } as unknown as ServerContext;
  const command = async (target: GamePlayer, sub: number, ...args: number[]) => {
    const packet = new GSPacket(216); packet.writeInt(sub); for (const arg of args) packet.writeInt(arg);
    await registry.get(216)!.handle(ctx, { player: target } as GameClient, GSPacket.parse(packet.encode()));
    expect(error).not.toHaveBeenCalled();
  };
  const reload = async () => {
    const loaded = await makePlayer(), items = await loadUserItems(h.db, p.id, templates.findItem, templates.findGoldTemplate);
    loaded.equipBag.loadItems(items.get(0) ?? []);
    loaded.cardBag.load(await loadUserCardBag(h.db, p.id)); loaded.cards = loaded.cardBag.equipped();
    loaded.recalcStats(now); world.set(p.id, loaded); return loaded;
  };
  return { p, box, command, reload, sent, addBox };
}

describe("genuine treasure card boxes through registered packets, stats and saved identities", () => {
  // Original CardDataHandler.cs cases 0/2: consume the whole stack, keep the bag count,
  // equip a Count=0/CardID=0 copy, delete only that copy on unequip.
  // PlayerEquipInventory.cs 314-340: template + rolled + per-level stats; only saved IDs enter CardBuff.
  it.each(cases)("opens $box into $card, equips, reloads, unequips and reloads without duplicating cards", async value => {
    const f = await fixture(value.box), before = balances(f.p), itemId = f.box.ItemID;
    expect(stats(f.p)).toEqual(baseline);
    expect(f.box.template).toMatchObject({ CategoryID: 18, Property5: value.card });
    expect(templates.findItem(value.card)).toMatchObject({ CategoryID: 26, BindType: 1 });
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.999).mockReturnValueOnce(0);
    await f.command(f.p, 2, 31, 1); // Requested one; all three boxes produce 2+3+2 cards.
    expect(f.p.equipBag.getItemAt(31)).toBeNull(); expect(f.box).toMatchObject({ ItemID: itemId, IsExist: false, IsBinds: true });
    const bag = f.p.cardBag.getItemAt(5)!;
    expect(bag).toMatchObject({ UserID: f.p.id, TemplateID: value.card, Count: 7, Place: 5, Level: 0, CardGP: 0 });
    expect(bag.CardID).toBeGreaterThan(0);
    await f.command(f.p, 0, 5, 0);
    const worn = f.p.cardBag.getItemAt(0)!;
    expect(worn).toMatchObject({ CardID: 0, UserID: f.p.id, TemplateID: value.card, Place: 0, Count: 0, Level: 0 });
    expect(f.p.cardBag.getItemAt(5)).toBe(bag); expect(bag.Count).toBe(7);
    const { Attack, Defence, Agility, Luck } = value, expected = { Attack, Defence, Agility, Luck, hp: 2456 };
    expect(stats(f.p)).toEqual(expected);
    await f.p.saveIntoDatabase(h.db); expect(worn.CardID).toBeGreaterThan(0); expect(worn.CardID).not.toBe(bag.CardID);
    const loaded = await f.reload();
    expect(loaded).not.toBe(f.p); expect(loaded.cardBag.getItemAt(0)).not.toBe(worn);
    expect(loaded.cardBag.getItemAt(0)).toMatchObject({ CardID: worn.CardID, Count: 0, TemplateID: value.card });
    expect(loaded.cardBag.getItemAt(5)).toMatchObject({ CardID: bag.CardID, Count: 7 }); expect(stats(loaded)).toEqual(expected);
    await f.command(loaded, 0, 0, 5);
    expect(loaded.cardBag.getItemAt(0)).toBeNull(); expect(stats(loaded)).toEqual(baseline);
    await loaded.saveIntoDatabase(h.db);
    const removed = await f.reload();
    expect(removed.cardBag.getItemAt(0)).toBeNull(); expect(stats(removed)).toEqual(baseline); expect(balances(removed)).toEqual(before);
    expect(await loadUserCardBag(h.db, removed.id)).toEqual([expect.objectContaining({ CardID: bag.CardID, TemplateID: value.card, Place: 5, Count: 7, dirty: false })]);
    const rows = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, removed.id));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.ItemID === itemId)).toMatchObject({ TemplateID: value.box, IsBinds: true, IsExist: false, BagType: -1, Place: -1 });
    expect(f.sent.some(packet => packet.code === 216)).toBe(true); expect(f.sent.some(packet => packet.code === 64)).toBe(true);
  });

  it.each([{ box: 20117, card: 314117, rolled: 5, Attack: 262, Defence: 62, Agility: 46, Luck: 32 },
    { box: 20139, card: 314139, rolled: 6, Attack: 266, Defence: 64, Agility: 44, Luck: 34 }])(
    "upgrades $card using actual level-1 cost/GP/update rows and preserves both copies on reload", async value => {
      const f = await fixture(value.box, 15), before = balances(f.p);
      expect(templates.cardConditions.get(1)).toMatchObject({ Exp: 50, MinExp: 2, MaxExp: 5, UpdateCardCount: 3 });
      expect(templates.cardUpdates.get(`${value.card}:1`)).toMatchObject({ Attack: value.rolled, Defend: 0, Agility: 0, Lucky: 0, Guard: 0, Damage: 0 });
      vi.spyOn(Math, "random").mockReturnValue(0.999);
      await f.command(f.p, 2, 31, 1); expect(f.p.cardBag.getItemAt(5)!.Count).toBe(45);
      await f.command(f.p, 0, 5, 0);
      for (let i = 0; i < 13; i++) await f.command(f.p, 3, 5);
      expect(f.p.cardBag.getItemAt(5)).toMatchObject({ Count: 6, Level: 1, CardGP: 52, Attack: value.rolled });
      expect(f.p.cardBag.getItemAt(0)).toMatchObject({ Count: 0, Level: 1, CardGP: 52, Attack: value.rolled });
      const { Attack, Defence, Agility, Luck } = value, expected = { Attack, Defence, Agility, Luck, hp: 2456 };
      expect(stats(f.p)).toEqual(expected); expect(balances(f.p)).toEqual(before);
      await f.p.saveIntoDatabase(h.db);
      const loaded = await f.reload(); expect(stats(loaded)).toEqual(expected);
      expect(loaded.cardBag.getItemAt(5)).toMatchObject({ Count: 6, Level: 1, CardGP: 52, Attack: value.rolled });
      expect(loaded.cardBag.getItemAt(0)).toMatchObject({ Count: 0, Level: 1, CardGP: 52, Attack: value.rolled });
      await f.command(loaded, 0, 0, 5); await loaded.saveIntoDatabase(h.db);
      const removed = await f.reload(); expect(stats(removed)).toEqual(baseline); expect(balances(removed)).toEqual(before);
      expect(await loadUserCardBag(h.db, removed.id)).toEqual([expect.objectContaining({ TemplateID: value.card, Count: 6, Level: 1, CardGP: 52, Attack: value.rolled, Place: 5 })]);
    });

  it("admits two genuine group5 cards to the battle snapshot only after real SQL identities are saved", async () => {
    const f = await fixture(20117); vi.spyOn(Math, "random").mockReturnValue(0);
    f.addBox(f.p, 20118, 32, 3); await f.p.saveIntoDatabase(h.db);
    await f.command(f.p, 2, 31, 1); await f.command(f.p, 2, 32, 1);
    await f.command(f.p, 0, 5, 0); await f.command(f.p, 0, 6, 1);
    expect(f.p.cardBag.equipped().map(card => card.CardID)).toEqual([0, 0]);
    const fight = (human: GamePlayer) => {
      const bot = new VirtualPlayer({ id: 99999, nickname: "CardIdentityTarget", sex: false, level: 20, weaponTemplateId: 7006 });
      const engine = new DdtFightEngine({ assets, manualClock: true, seed: () => 7, cardSets: templates.cardSets }); engines.push(engine);
      const started = engine.startPvp({ roomId: 1, roomType: RoomType.Match, gameType: 0, timeType: 3, mapId: 1001, red: [human], blue: [bot], onStopped() {} });
      expect(started).not.toBeNull();
      const game = engine.games.get(started!.id)!.game, me = game.players.find(p => p.spec.userId === human.id)!, foe = game.players.find(p => p.spec.userId === bot.id)!;
      me.reset(); foe.reset(); return { me, foe };
    };
    const unsaved = fight(f.p); expect(unsaved.me.spec.cardEffects).toBeUndefined();
    await f.p.saveIntoDatabase(h.db); const loaded = await f.reload();
    expect(loaded.cardBag.equipped().every(card => card.CardID > 0 && card.Count === 0)).toBe(true);
    const saved = fight(loaded); expect(saved.me.spec.cardEffects?.cards).toEqual([314117, 314118, 1000]);
    saved.foe.takeDamage(saved.me, { damage: 10, critical: 0 }); expect(saved.me.dander).toBe(1);
    unsaved.foe.takeDamage(unsaved.me, { damage: 10, critical: 0 }); expect(unsaved.me.dander).toBe(0);
  });
});
