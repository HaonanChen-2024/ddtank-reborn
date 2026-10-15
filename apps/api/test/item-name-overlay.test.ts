import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, createDb, game, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { Templates } from "../../game/src/db/templates.js";
import { TemplateCache } from "../src/templates/cache.js";
import { TEMPLATES } from "../src/templates/defs.js";
import type { XEl } from "../src/lib/flash-xml.js";

const file = fileURLToPath(new URL("../../../research/i18n/zh-CN-item-names.json", import.meta.url));
const names = (JSON.parse(readFileSync(file, "utf8")) as { names: Record<string, string> }).names;
const definition = TEMPLATES.find((d) => d.endpoint === "/TemplateAllList.ashx")!;
const pveFile = fileURLToPath(new URL("../../../research/i18n/zh-CN-pve-overrides.json", import.meta.url));
const pveEntries = (JSON.parse(readFileSync(pveFile, "utf8")) as {
  entries: { table: string; id: number; text: Record<string, string> }[];
}).entries;
let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite:memory"); // Isolated migration/seed; no configured DB or HTTP listener.
  await migrateDb(h); await seedDatabase(h, { only: ["Shop_Goods", "Pve_Info", "Mission_Info", "NPC_Info"] });
  await h.db.insert(app.Translations).values([
    { table: "Shop_Goods", column: "Name", rowId: "11001", lang: "pt-BR", text: "Existing name" },
    { table: "Shop_Goods", column: "Description", rowId: "11001", lang: "pt-BR", text: "Existing description" },
    { table: "Pve_Info", column: "Name", rowId: "2", lang: "pt-BR", text: "Existing dungeon" },
    { table: "Pve_Info", column: "Name", rowId: "3", lang: "pt-BR", text: "Uncovered dungeon" },
    { table: "NPC_Info", column: "Name", rowId: "2001", lang: "pt-BR", text: "Existing ant" },
  ]);
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: "name_overlay_history", NickName: "History", Password: "test", IsFirst: 1 }).returning();
  await h.db.insert(player.Sys_Users_Goods).values({ UserID: owner!.UserID, TemplateID: 11001, Count: 3, BagType: 1, Place: 0 });
  await h.db.insert(player.User_Messages).values({ ReceiverID: owner!.UserID, Title: "Caixa de tempo", Content: "Historic body", Annex1Name: "Historic item" });
});
beforeEach(() => {
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", "");
  vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", "");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => h?.close());
const snapshot = async () => ({
  goods: await h.db.select().from(game.Shop_Goods).orderBy(game.Shop_Goods.TemplateID),
  translations: await h.db.select().from(app.Translations),
  profiles: await h.db.select().from(player.Sys_Users_Detail),
  items: await h.db.select().from(player.Sys_Users_Goods),
  mail: await h.db.select().from(player.User_Messages),
  pve: await h.db.select().from(game.Pve_Info),
  missions: await h.db.select().from(game.Mission_Info),
  npcs: await h.db.select().from(game.NPC_Info),
});

it("shares the seven PvE display rows with API and Game while preserving every other field, row and stored record", async () => {
  const before = await snapshot(), oldGame = await new Templates().load(h.db, 1);
  const definitions = ["/LoadPVEItems.ashx", "/NPCInfoList.ashx"].map(endpoint => TEMPLATES.find(d => d.endpoint === endpoint)!);
  const oldXml = await Promise.all(definitions.map(d => d.build(h)));
  const xmlRows = (xml: XEl) => new Map(xml.children.map(row => [Number(new Map(row.attrs).get("ID")), row.attrs]));
  expect(new Map(xmlRows(oldXml[0]!).get(2)).get("Name")).toBe("Existing dungeon");
  expect(oldGame.pveInfos.get(3)!.Name).toBe("Uncovered dungeon");
  vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", pveFile);
  const currentGame = await new Templates().load(h.db, 1), currentXml = await Promise.all(definitions.map(d => d.build(h)));
  expect(pveEntries.map(e => `${e.table}:${e.id}`)).toEqual([
    "Pve_Info:2", "Mission_Info:2001", "Mission_Info:2002", "NPC_Info:2001", "NPC_Info:2002", "NPC_Info:2003", "NPC_Info:2004",
  ]);
  const groups = [
    { table: "Pve_Info", before: oldGame.pveInfos, after: currentGame.pveInfos },
    { table: "Mission_Info", before: oldGame.missions, after: currentGame.missions },
    { table: "NPC_Info", before: oldGame.npcs, after: currentGame.npcs },
  ];
  for (const group of groups) {
    expect(group.after.size).toBe(group.before.size);
    for (const [id, original] of group.before) {
      const text = pveEntries.find(e => e.table === group.table && e.id === id)?.text ?? {};
      expect(group.after.get(id)).toEqual({ ...original, ...text });
      for (const [key, value] of Object.entries(text)) {
        const prior = (original as Record<string, unknown>)[key];
        expect(typeof prior).toBe("string");
        const markup = (s: string) => s.match(/<[^>]*>|\{\d+(?::[^}]*)?\}/g) ?? [];
        expect(markup(value)).toEqual(markup(prior as string));
        if (key === "Title") expect(value.split(",")).toHaveLength((prior as string).split(",").length);
      }
    }
  }
  expect(currentGame.items).toEqual(oldGame.items);
  expect(currentGame.pveInfos.get(2)!.Name).toBe("魔蚁之巢");
  expect(currentGame.missions.get(2001)!.Title).toBe("回合,击败敌人");
  expect(currentGame.missions.get(2002)!.Failure).toBe("被敌人击败<br>回合数耗尽");
  expect([2001, 2002, 2003, 2004].map(id => currentGame.npcs.get(id)!.Name)).toEqual(["先锋蚁", "侦察蚁", "蚁后", "卫兵蚁"]);
  for (const [index, table] of ["Pve_Info", "NPC_Info"].entries()) {
    const oldRows = xmlRows(oldXml[index]!), newRows = xmlRows(currentXml[index]!);
    expect(newRows.size).toBe(oldRows.size);
    for (const [id, attrs] of oldRows) {
      const text = pveEntries.find(e => e.table === table && e.id === id)?.text ?? {};
      expect(newRows.get(id)).toEqual(attrs.map(([key, value]) => [key, text[key] ?? value]));
    }
    const cache = new TemplateCache(h); await cache.rebuild(definitions[index]!);
    const cached = cache.get(index === 0 ? "LoadPVEItems" : "NPCInfoList")!;
    expect(cached.compressed).toBe(true);
    expect(inflateSync(cached.body).toString("utf8")).toBe(currentXml[index]!.toString());
  }
  expect(await snapshot()).toEqual(before);
  vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", "");
  const restored = await new Templates().load(h.db, 1);
  expect(restored.pveInfos).toEqual(oldGame.pveInfos);
  expect(restored.missions).toEqual(oldGame.missions);
  expect(restored.npcs).toEqual(oldGame.npcs);
  expect((await definitions[0]!.build(h)).toString()).toBe(oldXml[0]!.toString());
});
const rows = (xml: XEl) => new Map(xml.children[0]!.children.map((row) => [Number(new Map(row.attrs).get("TemplateID")), row.attrs]));

it("uses the same 21 names in API plain/zlib templates and Game without changing other fields or historical data", async () => {
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", "");
  const before = await snapshot(), oldGame = await new Templates().load(h.db, 1), oldXml = await definition.build(h);
  const oldRows = rows(oldXml);
  expect(new Map(oldRows.get(11001)).get("Name")).toBe("Existing name");
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", file);
  const currentGame = await new Templates().load(h.db, 1), currentXml = await definition.build(h);
  const currentRows = rows(currentXml);
  expect(Object.keys(names)).toHaveLength(21);
  const signNames = { 11023: "强化石4级", 11035: "开孔钻头1级", 11041: "初级SUPER·古枪碎片", 11024: "强化石5级",
    11029: "幸运符50%", 13689: "龙骑士套装", 11560: "攻击祝福宝珠" };
  expect(names).toMatchObject(signNames);
  for (const [id, name] of Object.entries(signNames)) expect(currentGame.findItem(Number(id))?.Name).toBe(name);
  expect(currentRows.size).toBe(oldRows.size);
  for (const [id, oldItem] of oldGame.items) {
    const translated = currentGame.findItem(id)!;
    expect(translated).toEqual({ ...oldItem, Name: names[id] ?? oldItem.Name });
    const attrs = currentRows.get(id)!;
    expect(new Map(attrs).get("Name")).toBe(translated.Name);
    expect(attrs.filter(([key]) => key !== "Name")).toEqual(oldRows.get(id)!.filter(([key]) => key !== "Name"));
  }
  const cache = new TemplateCache(h); await cache.rebuild(definition);
  const plain = cache.get("TemplateAlllist1")!, compressed = cache.get("TemplateAlllist")!;
  expect(plain.compressed).toBe(false); expect(compressed.compressed).toBe(true);
  expect(plain.body.toString("utf8")).toBe(currentXml.toString());
  expect(inflateSync(compressed.body)).toEqual(plain.body);
  expect(await snapshot()).toEqual(before);
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", "");
  expect((await definition.build(h)).toString()).toBe(oldXml.toString());
  expect((await new Templates().load(h.db, 1)).items).toEqual(oldGame.items);
});
