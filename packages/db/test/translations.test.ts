import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, migrateDb, type DbHandle } from "../src/index.js";
import { Translations } from "../src/schema/app.js";
import { applyTranslations, loadTranslations, parseItemNameOverrides } from "../src/translations.js";

const config = (names: unknown = { "11001": "朱雀石1级" }) => ({ schemaVersion: 1, table: "Shop_Goods", names });
const temp = mkdtempSync(join(tmpdir(), "ddt-item-names-")), file = join(temp, "names.json");
let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite:memory"); // Explicit isolated database; never use DATABASE_URL.
  await migrateDb(h);
  await h.db.insert(Translations).values([
    { table: "Shop_Goods", column: "Name", rowId: "11001", lang: "pt-BR", text: "DB name" },
    { table: "Shop_Goods", column: "Description", rowId: "11001", lang: "pt-BR", text: "DB description" },
    { table: "NPC_Info", column: "Name", rowId: "11001", lang: "pt-BR", text: "NPC name" },
  ]);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await h?.close();
  if (dirname(resolve(temp)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
  rmSync(temp, { recursive: true, force: true });
});

describe("optional item display names", () => {
  it.each([
    null, [], {}, { ...config(), schemaVersion: 2 }, { ...config(), table: "NPC_Info" },
    { ...config(), Attack: 999 }, config([]), config(null), config({ "01": "bad" }),
    config({ "-1": "bad" }), config({ "2147483648": "bad" }), config({ "11001": 1 }),
    config({ "11001": { Name: "bad", Attack: 999 } }), config({ "11001": "  " }),
  ])("rejects malformed or non-Name configuration %#", (input) => {
    expect(() => parseItemNameOverrides(JSON.stringify(input))).toThrow(/ITEM_NAME_OVERRIDES_FILE/);
  });

  it("requires valid JSON and preserves literal display text", () => {
    expect(() => parseItemNameOverrides("{")).toThrow();
    expect(parseItemNameOverrides(JSON.stringify(config({ "11001": "中文 & <名称>" })))).toEqual({ "11001": "中文 & <名称>" });
  });

  it("keeps legacy translations and source object identity when unconfigured", async () => {
    vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", "");
    const overlay = await loadTranslations(h.db, "Shop_Goods", "pt-BR");
    const source = { TemplateID: 11001, Name: "source", Attack: 7 };
    expect(applyTranslations(source, "TemplateID", overlay)).toEqual({ ...source, Name: "DB name", Description: "DB description" });
    expect(source.Name).toBe("source");
    expect(applyTranslations(source, "TemplateID", await loadTranslations(h.db, "Shop_Goods", "missing"))).toBe(source);
  });

  it("overrides only Name for Shop_Goods in memory and keeps DB rows untouched", async () => {
    writeFileSync(file, JSON.stringify(config())); vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", file);
    const before = await h.db.select().from(Translations);
    const overlay = await loadTranslations(h.db, "Shop_Goods", "pt-BR");
    expect(overlay.get("11001")).toEqual({ Name: "朱雀石1级", Description: "DB description" });
    expect((await loadTranslations(h.db, "Shop_Goods", "zh-CN")).get("11001")).toEqual({ Name: "朱雀石1级" });
    expect((await loadTranslations(h.db, "NPC_Info", "pt-BR")).get("11001")).toEqual({ Name: "NPC name" });
    expect(await h.db.select().from(Translations)).toEqual(before);
  });

  it("fails on an invalid configured file but never reads it for other tables", async () => {
    writeFileSync(file, JSON.stringify({ ...config(), Pic: "wrong" })); vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", file);
    await expect(loadTranslations(h.db, "Shop_Goods", "pt-BR")).rejects.toThrow(/ITEM_NAME_OVERRIDES_FILE/);
    vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", join(temp, "missing.json"));
    await expect(loadTranslations(h.db, "Shop_Goods", "pt-BR")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadTranslations(h.db, "NPC_Info", "pt-BR")).get("11001")).toEqual({ Name: "NPC name" });
  });
});
