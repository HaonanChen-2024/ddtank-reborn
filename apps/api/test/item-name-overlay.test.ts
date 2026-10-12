import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { app, createDb, game, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { Templates } from "../../game/src/db/templates.js";
import { TemplateCache } from "../src/templates/cache.js";
import { TEMPLATES } from "../src/templates/defs.js";
import type { XEl } from "../src/lib/flash-xml.js";

const file = fileURLToPath(new URL("../../../research/i18n/zh-CN-item-names.json", import.meta.url));
const names = (JSON.parse(readFileSync(file, "utf8")) as { names: Record<string, string> }).names;
const definition = TEMPLATES.find((d) => d.endpoint === "/TemplateAllList.ashx")!;
let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite:memory"); // Isolated migration/seed; no configured DB or HTTP listener.
  await migrateDb(h); await seedDatabase(h, { only: ["Shop_Goods"] });
  await h.db.insert(app.Translations).values([
    { table: "Shop_Goods", column: "Name", rowId: "11001", lang: "pt-BR", text: "Existing name" },
    { table: "Shop_Goods", column: "Description", rowId: "11001", lang: "pt-BR", text: "Existing description" },
  ]);
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: "name_overlay_history", NickName: "History", Password: "test", IsFirst: 1 }).returning();
  await h.db.insert(player.Sys_Users_Goods).values({ UserID: owner!.UserID, TemplateID: 11001, Count: 3, BagType: 1, Place: 0 });
  await h.db.insert(player.User_Messages).values({ ReceiverID: owner!.UserID, Title: "Caixa de tempo", Content: "Historic body", Annex1Name: "Historic item" });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => h?.close());
const snapshot = async () => ({
  goods: await h.db.select().from(game.Shop_Goods).orderBy(game.Shop_Goods.TemplateID),
  translations: await h.db.select().from(app.Translations),
  profiles: await h.db.select().from(player.Sys_Users_Detail),
  items: await h.db.select().from(player.Sys_Users_Goods),
  mail: await h.db.select().from(player.User_Messages),
});
const rows = (xml: XEl) => new Map(xml.children[0]!.children.map((row) => [Number(new Map(row.attrs).get("TemplateID")), row.attrs]));

it("uses the same 13 names in API plain/zlib templates and Game without changing other fields or historical data", async () => {
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", "");
  const before = await snapshot(), oldGame = await new Templates().load(h.db, 1), oldXml = await definition.build(h);
  const oldRows = rows(oldXml);
  expect(new Map(oldRows.get(11001)).get("Name")).toBe("Existing name");
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", file);
  const currentGame = await new Templates().load(h.db, 1), currentXml = await definition.build(h);
  const currentRows = rows(currentXml);
  expect(Object.keys(names)).toHaveLength(13);
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
