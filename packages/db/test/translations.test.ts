import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, migrateDb, type DbHandle } from "../src/index.js";
import { Translations } from "../src/schema/app.js";
import { applyTranslations, loadTranslations, parseItemNameOverrides, parsePveTextOverrides } from "../src/translations.js";

const config = (names: unknown = { "11001": "朱雀石1级" }) => ({ schemaVersion: 1, table: "Shop_Goods", names });
const temp = mkdtempSync(join(tmpdir(), "ddt-item-names-")), file = join(temp, "names.json");
const pveFile = join(temp, "pve.json");
const pveEntry = { table: "Mission_Info", id: 2001, text: { Name: "魔蚁之巢·第一关", Title: "回合,击败敌人", Failure: "被敌人击败<br>回合数耗尽" } };
const pveConfig = (entries: unknown = [pveEntry]) => ({ schemaVersion: 1, entries });
let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite:memory"); // Explicit isolated database; never use DATABASE_URL.
  await migrateDb(h);
  await h.db.insert(Translations).values([
    { table: "Shop_Goods", column: "Name", rowId: "11001", lang: "pt-BR", text: "DB name" },
    { table: "Shop_Goods", column: "Description", rowId: "11001", lang: "pt-BR", text: "DB description" },
    { table: "NPC_Info", column: "Name", rowId: "11001", lang: "pt-BR", text: "NPC name" },
    { table: "Mission_Info", column: "Name", rowId: "2001", lang: "pt-BR", text: "DB mission" },
    { table: "Mission_Info", column: "Description", rowId: "2001", lang: "pt-BR", text: "DB mission description" },
    { table: "Mission_Info", column: "Name", rowId: "2002", lang: "pt-BR", text: "Uncovered mission" },
  ]);
});
beforeEach(() => {
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", "");
  vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", "");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await h?.close();
  if (dirname(resolve(temp)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
  rmSync(temp, { recursive: true, force: true });
});

describe("optional PvE display text", () => {
  it.each([
    null, [], {}, { ...pveConfig(), schemaVersion: 2 }, { ...pveConfig(), extra: true },
    pveConfig(null), pveConfig({}), pveConfig([null]), pveConfig([{ ...pveEntry, extra: true }]),
    pveConfig([{ ...pveEntry, table: "Shop_Goods" }]), pveConfig([{ ...pveEntry, table: "__proto__" }]),
    ...["2001", 0, -1, 1.5, 2147483648].map(id => pveConfig([{ ...pveEntry, id }])),
    ...[null, [], {}, { Name: " " }, { Name: 1 }, { Title: "回合", HP: 999 }, { Script: "changed" }, { Rewards: "changed" }]
      .map(text => pveConfig([{ ...pveEntry, text }])),
    pveConfig([{ table: "NPC_Info", id: 2001, text: { Description: "not allowed" } }]),
    pveConfig([{ table: "Pve_Info", id: 2, text: { Title: "not allowed" } }]),
    pveConfig([pveEntry, { ...pveEntry, text: { Name: "duplicate" } }]),
  ])("rejects malformed, duplicate or gameplay configuration %#", (input) => {
    expect(() => parsePveTextOverrides(JSON.stringify(input))).toThrow(/PVE_TEXT_OVERRIDES_FILE/);
  });

  it("preserves literal HTML, format placeholders and the ASCII title separator", () => {
    expect(() => parsePveTextOverrides("{")).toThrow();
    const entries = [{ ...pveEntry, text: { ...pveEntry.text, Description: "进度 {0:N0}<br/>奖励 & 名称" } }];
    expect(parsePveTextOverrides(JSON.stringify(pveConfig(entries)))).toEqual(entries);
  });

  it("merges only configured display columns over DB text, preserving other rows and source gameplay values", async () => {
    writeFileSync(pveFile, JSON.stringify(pveConfig()));
    const before = await h.db.select().from(Translations);
    const source = { Id: 2001, Name: "source", TotalTurn: 200, TotalCount: 20, Script: "mission", Experience: 12 };
    const oldOverlay = await loadTranslations(h.db, "Mission_Info", "pt-BR");
    expect(applyTranslations(source, "Id", oldOverlay)).toEqual({ ...source, Name: "DB mission", Description: "DB mission description" });
    vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", pveFile);
    const overlay = await loadTranslations(h.db, "Mission_Info", "pt-BR");
    expect(applyTranslations(source, "Id", overlay)).toEqual({ ...source, ...pveEntry.text, Description: "DB mission description" });
    expect(overlay.get("2002")).toEqual(oldOverlay.get("2002"));
    expect(applyTranslations({ Id: 999, Name: "unchanged" }, "Id", overlay)).toEqual({ Id: 999, Name: "unchanged" });
    expect((await loadTranslations(h.db, "Mission_Info", "zh-CN")).get("2001")).toEqual(pveEntry.text);
    expect(source.Name).toBe("source");
    expect(await h.db.select().from(Translations)).toEqual(before);
    vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", "");
    expect(await loadTranslations(h.db, "Mission_Info", "pt-BR")).toEqual(oldOverlay);
  });

  it("keeps item-name and PvE contracts separate and does not read the PvE file for unrelated tables", async () => {
    writeFileSync(file, JSON.stringify(config())); vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", file);
    writeFileSync(pveFile, JSON.stringify(pveConfig([{ table: "NPC_Info", id: 11001, text: { Name: "中文怪物" } }])));
    vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", pveFile);
    expect((await loadTranslations(h.db, "Shop_Goods", "pt-BR")).get("11001")).toEqual({ Name: "朱雀石1级", Description: "DB description" });
    expect((await loadTranslations(h.db, "NPC_Info", "pt-BR")).get("11001")).toEqual({ Name: "中文怪物" });
    writeFileSync(pveFile, JSON.stringify(pveConfig([{ ...pveEntry, text: { Blood: 999 } }])));
    await expect(loadTranslations(h.db, "NPC_Info", "pt-BR")).rejects.toThrow(/PVE_TEXT_OVERRIDES_FILE/);
    vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", join(temp, "missing-pve.json"));
    await expect(loadTranslations(h.db, "Pve_Info", "pt-BR")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadTranslations(h.db, "Shop_Goods", "pt-BR")).get("11001")!.Name).toBe("朱雀石1级");
    expect(await loadTranslations(h.db, "Quest", "pt-BR")).toEqual(new Map());
  });
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
