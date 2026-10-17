import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { RoomType } from "@ddt/fight";
import { GSPacket } from "@ddt/protocol";
import { VirtualPlayer } from "../src/bots/bot.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { Templates } from "../src/db/templates.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { registerForge } from "../src/handlers/forge.js";
import { registerItems } from "../src/handlers/items.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Complete original seed rows. Template names/P1 contain +5; instance strengthen stays zero.
const goods = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString("utf8")) as ItemTemplate[];
const levels = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/LevelInfo.json.gz", import.meta.url))).toString("utf8")) as { Grade: number; GP: number; Blood: number }[];
const templates = new Templates();
templates.items = new Map(goods.filter(row => [7006, 8514, 9523, 11019].includes(row.TemplateID)).map(row => [row.TemplateID, row]));
const blood = new Map(levels.map(row => [row.Grade, row.Blood])), now = new Date("2026-10-16T08:00:00Z");
const registry = new HandlerRegistry(); registerItems(registry); registerForge(registry);
const baseline = { Attack: 250, Defence: 60, Agility: 40, Luck: 30, hp: 2456 };
const armlet = { Attack: 303, Defence: 113, Agility: 93, Luck: 83, hp: 2461 };
const armlets = { Attack: 356, Defence: 166, Agility: 146, Luck: 136, hp: 2466 };
const ring = { Attack: 330, Defence: 140, Agility: 120, Luck: 110, hp: 2464 };
const rings = { Attack: 410, Defence: 220, Agility: 200, Luck: 190, hp: 2472 };
const allJewelry = { Attack: 516, Defence: 326, Agility: 306, Luck: 296, hp: 2482 };
const cases = [
  { name: "one 8514", ids: [8514], slots: [7], steps: [armlet] },
  { name: "one 9523", ids: [9523], slots: [9], steps: [ring] },
  { name: "two independent 8514", ids: [8514, 8514], slots: [7, 8], steps: [armlet, armlets] },
  { name: "two independent 9523", ids: [9523, 9523], slots: [9, 10], steps: [ring, rings] },
  { name: "all four slots", ids: [8514, 8514, 9523, 9523], slots: [7, 8, 9, 10],
    steps: [armlet, armlets, { Attack: 436, Defence: 246, Agility: 226, Luck: 216, hp: 2474 }, allJewelry] },
];
let h: DbHandle, sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await h?.close(); });

function stats(p: GamePlayer) {
  const { Attack, Defence, Agility, Luck, hp } = p.info;
  return { Attack, Defence, Agility, Luck, hp };
}
function balances(p: GamePlayer) {
  const { Gold, Money, GiftToken, GP, Grade } = p.info;
  return { Gold, Money, GiftToken, GP, Grade };
}
async function fixture(ids: number[]) {
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `jewelry${++sequence}`, NickName: `Jewelry${sequence}`,
    Grade: 20, GP: 538554, IsFirst: 1, Gold: 5000, Money: 12, GiftToken: 34 }).returning();
  const sent: GSPacket[] = [], error = vi.fn(), disconnect = vi.fn();
  const makePlayer = async () => {
    const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect, remoteAddress: "jewelry-isolated-memory" },
      (await loadPlayerInfo(h.db, row!.UserID))!, defaultMatch(row!.UserID), 1, "test", grade => blood.get(grade) ?? 0);
    p.statTables = templates.stats; return p;
  };
  const p = await makePlayer();
  expect(levels.find(level => level.Grade === 20)).toMatchObject({ Grade: 20, GP: 538554, Blood: 2450 });
  expect(p.equipBag.addItemTo(ItemInfo.createFromTemplate(templates.findItem(7006)!, 1, 0, now), 6)).toBe(true);
  const jewelry = ids.map((id, index) => {
    const item = ItemInfo.createFromTemplate(templates.findItem(id)!, 1, 0, now);
    item.IsBinds = true; // The API treasure attachment is bound, with the original template unchanged.
    expect(item).toMatchObject({ ItemID: 0, StrengthenLevel: 0, Count: 1 });
    expect(item.template).toMatchObject({ CategoryID: id === 8514 ? 8 : 9, CanEquip: true, CanStrengthen: false,
      CanCompose: true, NeedLevel: 0, NeedSex: 0, MaxCount: 1, Property1: 5, SuitId: 0,
      Attack: id === 8514 ? 53 : 80, Defence: id === 8514 ? 53 : 80, Agility: id === 8514 ? 53 : 80, Luck: id === 8514 ? 53 : 80 });
    expect(p.canEquip(item.template)).toBe(true);
    expect(p.equipBag.addItemTo(item, 31 + index)).toBe(true); return item;
  });
  await p.saveIntoDatabase(h.db);
  expect(jewelry.every(item => item.ItemID > 0)).toBe(true);
  expect(new Set(jewelry.map(item => item.ItemID)).size).toBe(ids.length);
  sent.length = 0;
  const ctx = { db: h, templates, now: () => new Date(now), lang: { t: (key: string) => key }, log: { error } } as unknown as ServerContext;
  const request = async (target: GamePlayer, packet: GSPacket) => {
    await registry.get(packet.code)!.handle(ctx, { player: target } as GameClient, GSPacket.parse(packet.encode()));
    expect(error).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled();
  };
  const move = (target: GamePlayer, fromBag: number, from: number, toBag: number, to: number) => {
    const packet = new GSPacket(49);
    packet.writeByte(fromBag); packet.writeInt(from); packet.writeByte(toBag); packet.writeInt(to); packet.writeInt(0); packet.writeBoolean(false);
    return request(target, packet);
  };
  const reload = async () => {
    const loaded = await makePlayer(), bags = await loadUserItems(h.db, p.id, templates.findItem, templates.findGoldTemplate);
    for (const bag of loaded.allBags()) bag.loadItems(bags.get(bag.bagType) ?? []);
    loaded.recalcStats(now); return loaded;
  };
  const rows = () => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id)).orderBy(player.Sys_Users_Goods.ItemID);
  const savedProfile = () => h.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, p.id));
  return { p, jewelry, sent, request, move, reload, rows, savedProfile };
}

describe("genuine treasure jewelry through registered equip, stats and durable identities", () => {
  // Original 7fcb5529: PlayerEquipInventory.FindItemEpuipSlot/CanEquipSlotContains; ItemInfo four-stat getters.
  // Hand-checked results: real grade-20 Blood=2450, weapon7006=250/60/40/30, jewelry53/80 per occupied slot.
  // Property1=5 is not StrengthenLevel and never applies a 1.1 multiplier to these four stats.
  it.each(cases)("equips $name, reloads, removes via 47 and reloads without merging identities", async value => {
    const f = await fixture(value.ids), before = balances(f.p);
    expect(stats(f.p)).toEqual(baseline);
    for (const [index, item] of f.jewelry.entries()) {
      const slot = value.slots[index]!;
      expect(f.p.equipBag.findItemEquipSlot(item.template)).toBe(slot);
      await f.move(f.p, 0, 31 + index, 0, slot);
      expect(f.p.equipBag.getItemAt(slot)).toBe(item); expect(f.p.equipBag.getItemAt(31 + index)).toBeNull();
      expect(item).toMatchObject({ Count: 1, IsBinds: true, IsUsed: true, StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, AgilityCompose: 0, LuckCompose: 0 });
      expect(stats(f.p)).toEqual(value.steps[index]);
    }
    expect(f.sent.some(packet => packet.code === 64)).toBe(true); expect(f.sent.some(packet => packet.code === 67)).toBe(true);
    await f.p.saveIntoDatabase(h.db);
    const loaded = await f.reload(); expect(loaded).not.toBe(f.p); expect(stats(loaded)).toEqual(value.steps.at(-1));
    for (const [index, item] of f.jewelry.entries()) {
      const worn = loaded.equipBag.getItemAt(value.slots[index]!)!;
      expect(worn).not.toBe(item);
      expect(worn).toMatchObject({ ItemID: item.ItemID, TemplateID: value.ids[index], Place: value.slots[index], BagType: 0, Count: 1,
        IsBinds: true, IsUsed: true, StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, AgilityCompose: 0, LuckCompose: 0 });
    }
    if (value.ids.length === 4) {
      const engine = new DdtFightEngine({ manualClock: true, seed: () => 7 });
      try {
        const bot = new VirtualPlayer({ id: 99999, nickname: "JewelryTarget", sex: false, level: 20, weaponTemplateId: 7006 });
        const started = engine.startPvp({ roomId: 1, roomType: RoomType.Match, gameType: 0, timeType: 3, mapId: 1001, red: [loaded], blue: [bot], onStopped() {} });
        expect(started).not.toBeNull();
        const spec = engine.games.get(started!.id)!.game.players.find(p => p.spec.userId === loaded.id)!.spec;
        expect(spec).toMatchObject({ attack: 516, defence: 326, agility: 306, lucky: 296, hp: 2482, grade: 20 });
        expect(spec).toMatchObject({ baseAttack: 205, baseDefence: 0 }); // True weapon7006.Property7; jewelry P7=0.
      } finally { for (const fight of engine.games.values()) fight.stop(); }
    }
    for (const [index, slot] of value.slots.entries()) {
      const remove = new GSPacket(47); remove.writeInt(slot); await f.request(loaded, remove);
      expect(loaded.equipBag.getItemAt(slot)).toBeNull();
      expect(loaded.equipBag.getItemAt(31 + index)).toMatchObject({ ItemID: f.jewelry[index]!.ItemID, TemplateID: value.ids[index], Count: 1 });
    }
    expect(stats(loaded)).toEqual(baseline); await loaded.saveIntoDatabase(h.db);
    const removed = await f.reload(), rows = await f.rows();
    expect(removed).not.toBe(loaded); expect(stats(removed)).toEqual(baseline); expect(balances(removed)).toEqual(before);
    expect(rows).toHaveLength(value.ids.length + 1);
    for (const [index, item] of f.jewelry.entries()) {
      expect(removed.equipBag.getItemAt(value.slots[index]!)).toBeNull();
      expect(removed.equipBag.getItemAt(31 + index)).toMatchObject({ ItemID: item.ItemID, TemplateID: item.TemplateID, Count: 1, StrengthenLevel: 0 });
      expect(rows.find(row => row.ItemID === item.ItemID)).toMatchObject({ TemplateID: item.TemplateID, BagType: 0, Place: 31 + index, Count: 1, IsExist: true, IsBinds: true, StrengthenLevel: 0 });
    }
  });

  it.each([8514, 9523])("rejects registered 59 for non-strengthenable %i without material, wallet or saved-row changes", async id => {
    const f = await fixture([id]), item = f.jewelry[0]!;
    const stone = ItemInfo.createFromTemplate(templates.findItem(11019)!, 3, 0, now); stone.IsBinds = true;
    expect(stone.template).toMatchObject({ CategoryID: 11, Property1: 2, Level: 1 });
    expect(f.p.propBag.addItemTo(stone, 0)).toBe(true);
    await f.move(f.p, 0, 31, 12, 5); await f.move(f.p, 1, 0, 12, 0); await f.p.saveIntoDatabase(h.db);
    expect(item).toMatchObject({ UserID: f.p.id, BagType: 12, Place: 5, Count: 1, StrengthenLevel: 0, StrengthenTimes: 0, IsExist: true, cellLocked: false });
    expect(item.isValidItem(now)).toBe(true); expect(templates.findItem(id)).toBe(item.template);
    const beforeRows = await f.rows(), beforeProfile = await f.savedProfile(), before = balances(f.p), rng = vi.spyOn(Math, "random");
    f.sent.length = 0;
    const packet = new GSPacket(59); packet.writeBoolean(false); await f.request(f.p, packet);
    expect(rng).not.toHaveBeenCalled(); expect(f.sent.map(packet => packet.code)).toEqual([3]);
    const message = f.sent[0]!; expect(message.readInt()).toBe(0); expect(message.readString()).toBe("强化装备状态无效，请保留物品并重试。");
    expect(item).toMatchObject({ StrengthenLevel: 0, StrengthenTimes: 0, Count: 1, Place: 5, IsExist: true });
    expect(f.p.storeBag.getItemAt(5)).toBe(item); expect(f.p.storeBag.getItemAt(0)).toBe(stone); expect(stone.Count).toBe(3);
    expect(balances(f.p)).toEqual(before); expect(await f.rows()).toEqual(beforeRows); expect(await f.savedProfile()).toEqual(beforeProfile);
    await f.p.saveIntoDatabase(h.db); const loaded = await f.reload();
    expect(await f.rows()).toEqual(beforeRows); expect(await f.savedProfile()).toEqual(beforeProfile); expect(balances(loaded)).toEqual(before);
    expect(loaded.storeBag.getItemAt(5)).toMatchObject({ ItemID: item.ItemID, TemplateID: id, StrengthenLevel: 0, StrengthenTimes: 0, Count: 1, IsBinds: true });
    expect(loaded.storeBag.getItemAt(0)).toMatchObject({ ItemID: stone.ItemID, TemplateID: 11019, Count: 3, IsBinds: true });
  });
  // Packet 58 composition (stone overwrite/cost) and P4 predecessor upgrades are outside this batch.
});
