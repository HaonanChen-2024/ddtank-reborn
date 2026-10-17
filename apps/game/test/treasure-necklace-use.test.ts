import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { Templates } from "../src/db/templates.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { registerItems } from "../src/handlers/items.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Read the complete shipped seed rows, not synthetic necklaces or current official stats.
const goods = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString("utf8")) as ItemTemplate[];
const levels = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/LevelInfo.json.gz", import.meta.url))).toString("utf8")) as { Grade: number; Blood: number }[];
const cases = [
  { id: 14006, property1: 18, attribute: 0, hp: 2898 },
  { id: 14007, property1: 28, attribute: 0, hp: 3143 },
  { id: 14008, property1: 38, attribute: 0, hp: 3389 },
  { id: 14009, property1: 48, attribute: 0, hp: 3634 },
  { id: 14010, property1: 58, attribute: 0, hp: 3880 },
  { id: 14028, property1: 63, attribute: 20, hp: 4006 },
  { id: 14038, property1: 78, attribute: 30, hp: 4377 },
  { id: 14046, property1: 80, attribute: 35, hp: 4426 },
  { id: 14056, property1: 83, attribute: 40, hp: 4501 },
].map(value => ({ ...value, necklaceExpAdd: 0 }));
const templates = new Templates();
templates.items = new Map(goods.filter(row => row.TemplateID === 7006 || cases.some(value => value.id === row.TemplateID)).map(row => [row.TemplateID, row]));
const bloodByGrade = new Map(levels.map(row => [row.Grade, row.Blood]));
const registry = new HandlerRegistry(); registerItems(registry);
let h: DbHandle, sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterAll(async () => { await h?.close(); });

function stats(p: GamePlayer) {
  const { Attack, Defence, Agility, Luck, hp } = p.info;
  return { Attack, Defence, Agility, Luck, hp };
}

async function fixture(id: number, necklaceExpAdd: number) {
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `neck${++sequence}`, NickName: `neck${sequence}`, Grade: 20, IsFirst: 1, necklaceExpAdd }).returning();
  const sent: GSPacket[] = [];
  const makePlayer = async () => {
    const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "necklace-isolated-memory" },
      (await loadPlayerInfo(h.db, row!.UserID))!, defaultMatch(row!.UserID), 1, "test", grade => bloodByGrade.get(grade) ?? 0);
    p.statTables = templates.stats;
    return p;
  };
  const p = await makePlayer();
  const weapon = ItemInfo.createFromTemplate(templates.findItem(7006)!, 1, 0);
  const necklace = ItemInfo.createFromTemplate(templates.findItem(id)!, 1, 0);
  expect(p.equipBag.addItemTo(weapon, 6)).toBe(true);
  expect(p.equipBag.addItemTo(necklace, 31)).toBe(true);
  await p.saveIntoDatabase(h.db); sent.length = 0;
  const ctx = { db: h, templates, now: () => new Date(), lang: { t: (key: string) => key } } as unknown as ServerContext;
  const request = (target: GamePlayer, packet: GSPacket) => registry.get(packet.code)!.handle(ctx, { player: target } as GameClient, GSPacket.parse(packet.encode()));
  const reload = async () => {
    const bags = await loadUserItems(h.db, p.id, templates.findItem, templates.findGoldTemplate);
    const loaded = await makePlayer();
    loaded.equipBag.loadItems(bags.get(0) ?? []); loaded.recalcStats();
    return loaded;
  };
  const rows = () => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id));
  return { p, necklace, sent, request, reload, rows };
}

describe("genuine treasure necklaces through existing equip, stats and persistence owners", () => {
  // Original Game.Server/GamePlayer.cs at vendor commit 7fcb55290e4c7aabd6887d3c1ccd2621b5080924:
  // GetBaseBlood (2577-2585), final HP (5171). These are hand-checked outputs, not computeStats calls.
  // LevelInfo[20].Blood=2450; weapon 7006 supplies 250/60/40/30, including defence/10 HP.
  // The final case also proves saved necklaceExpAdd contributes only while slot 12 is equipped.
  it.each([...cases, { ...cases[8]!, necklaceExpAdd: 7, hp: 4674 }])("equips $id with necklaceExpAdd=$necklaceExpAdd, reloads and restores stats on removal", async value => {
    const f = await fixture(value.id, value.necklaceExpAdd), baseline = { Attack: 250, Defence: 60, Agility: 40, Luck: 30, hp: 2456 };
    expect(stats(f.p)).toEqual(baseline);
    expect(f.necklace.template).toMatchObject({ CategoryID: 14, CanEquip: true, Property1: value.property1, Attack: value.attribute, Defence: value.attribute, Agility: value.attribute, Luck: value.attribute });
    expect(f.p.equipBag.findItemEquipSlot(f.necklace.template)).toBe(12);
    const equip = new GSPacket(49);
    equip.writeByte(0); equip.writeInt(31); equip.writeByte(0); equip.writeInt(12); equip.writeInt(0); equip.writeBoolean(false);
    await f.request(f.p, equip);
    const expected = { Attack: 250 + value.attribute, Defence: 60 + value.attribute, Agility: 40 + value.attribute, Luck: 30 + value.attribute, hp: value.hp };
    expect(f.p.equipBag.getItemAt(12)).toBe(f.necklace); expect(f.p.equipBag.getItemAt(31)).toBeNull();
    expect(f.necklace).toMatchObject({ IsBinds: true, IsUsed: true, Count: 1 });
    expect(stats(f.p)).toEqual(expected);
    expect(f.sent.some(packet => packet.code === 64)).toBe(true); expect(f.sent.some(packet => packet.code === 67)).toBe(true);

    await f.p.saveIntoDatabase(h.db);
    const loaded = await f.reload();
    expect(loaded.info.necklaceExpAdd).toBe(value.necklaceExpAdd);
    expect(loaded.equipBag.getItemAt(12)).toMatchObject({ ItemID: f.necklace.ItemID, TemplateID: value.id, BagType: 0, Place: 12, Count: 1, IsBinds: true, IsUsed: true });
    expect(stats(loaded)).toEqual(expected);
    const remove = new GSPacket(47); remove.writeInt(12);
    await f.request(loaded, remove);
    expect(loaded.equipBag.getItemAt(12)).toBeNull();
    expect(loaded.equipBag.getItemAt(31)).toMatchObject({ ItemID: f.necklace.ItemID, TemplateID: value.id, Count: 1 });
    expect(stats(loaded)).toEqual(baseline);

    await loaded.saveIntoDatabase(h.db);
    const removed = await f.reload(), rows = await f.rows();
    expect(stats(removed)).toEqual(baseline); expect(removed.equipBag.getItemAt(12)).toBeNull();
    expect(removed.equipBag.getItemAt(31)).toMatchObject({ ItemID: f.necklace.ItemID, TemplateID: value.id, Place: 31 });
    expect(rows).toHaveLength(2);
    expect(rows.find(item => item.ItemID === f.necklace.ItemID)).toMatchObject({ TemplateID: value.id, BagType: 0, Place: 31, Count: 1, IsExist: true });
  });
});
