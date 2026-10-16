import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createDb, loadTranslations, migrateDb, seedDatabase } from "@ddt/db";
import { sql } from "drizzle-orm";
import { parsePveTextOverrides, parseTemplateTextOverrides } from "../../../packages/db/src/translations.js";
import { LanguageMgr as FightLanguage, setTranslator } from "../../../packages/fight/src/pve/cs.js";
import { Templates } from "../../game/src/db/templates.js";
import { loadBadges } from "../../game/src/db/consortia.js";
import { HotSpringMgr } from "../../game/src/handlers/hotspring.js";
import type { ServerContext } from "../../game/src/session/context.js";
import { LanguageMgr } from "../../game/src/util/lang.js";
import type { XEl } from "../src/lib/flash-xml.js";
import { TEMPLATES } from "../src/templates/defs.js";
import { TemplateCache } from "../src/templates/cache.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const displayFile = join(repo, "research/i18n/zh-CN-template-text.json");
const entries = parseTemplateTextOverrides(readFileSync(displayFile, "utf8"));
const readJson = (name: string) => JSON.parse(readFileSync(join(repo, "research/i18n", name), "utf8"));

it("resolves every static generated PvE dialogue through the runtime translator, including keys absent from the shipped dictionary", () => {
  const language = LanguageMgr.fromFile(join(repo, "data/i18n/pt-BR/server-language.txt"));
  for (const [key, text] of Object.entries(readJson("zh-CN-server-overrides.json"))) language.set(key, text as string);
  for (const [key, variants] of Object.entries(readJson("zh-CN-server-row-overrides.json").entries)) {
    const values = variants as { source: string; translation: string }[];
    const original = language.t(key);
    language.set(key, values.find(row => row.source.replace(/\t/g, "") === original)!.translation);
  }
  for (const [key, text] of Object.entries(readJson("zh-CN-server-additions.json"))) language.set(key, text as string);
  const keys = new Set<string>();
  const scan = (directory: string) => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, file.name);
      if (file.isDirectory()) scan(path);
      else if (file.name.endsWith(".ts")) for (const match of readFileSync(path, "utf8").matchAll(/LanguageMgr\.GetTranslation\("((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${match[1]}"`));
    }
  };
  scan(join(repo, "packages/fight/src/pve/scripts/generated"));
  expect(keys.size).toBeGreaterThan(900);
  setTranslator((key, args) => language.t(key, ...args));
  try {
    for (const key of keys) {
      const translated = String(FightLanguage.GetTranslation(key));
      expect(translated, key).not.toBe(key);
      if (key === "FightLab.question") expect(translated).toBe(""); // Preserve the original empty training prefix.
      else expect(translated, key).toMatch(/[\u3400-\u9fff]/);
    }
  } finally { setTranslator(key => key); }
});

it("loads Chinese pet, map, title and equipment display text into real API XML/cache and Game without changing stored effects", async () => {
  const tables = {
    Pet_Template_Info: ["TemplateID", "/pettemplateinfo.ashx"],
    Pet_Skill_Info: ["ID", "/petskillinfo.ashx"],
    Pet_Skill_Element_Info: ["ID", "/petskillelementinfo.ashx"],
    Rune_Template: ["TemplateID", "/runetemplatelist.ashx"],
    Game_Map: ["ID", "/LoadMapsItems.ashx"],
    New_Title: ["ID", "/newtitle.ashx"],
    Consortia_BuffTemp: ["id", "/consortiabuffertemp.ashx"],
    SuitTemplateInfo: ["SuitId", "/suittemplateinfolist.ashx"],
    Shop_Goods: ["TemplateID", "/TemplateAllList.ashx"],
    Shop_Goods_Categorys: ["ID", "/LoadItemsCategory.ashx"],
    Active: ["ActiveID", "/ActiveList.ashx"],
    Daily_Award: ["ID", "/DailyAwardList.ashx"],
    Fair_Battle_Reward_Temp: ["Level", "/DailyLeagueLevelList.ashx"],
    ClothPropertyTemplateInfo: ["ID", "clothpropertytemplateinfo"],
    Consortia_Badge: ["BadgeID", "consortiabadgeconfig"],
    Suit_TemplateID: [["ID", "ContainEquip"], "/suitpartequipinfolist.ashx"],
  } as const;
  const primaryKeys: Record<string, string | readonly string[]> = {
    ...Object.fromEntries(Object.entries(tables).map(([table, [pk]]) => [table, pk])),
    Quest: "ID", Quest_Condiction: ["QuestID", "CondictionID"], Achievement: "ID", Card_Info: "ID",
    Mission_Info_Backup: "Id", Pve_Info: "ID", Mission_Info: "Id", NPC_Info: "ID", Card_Buff: "ID",
    Event_Live: "EventID", DailyLeagueLevel: "Level", Drop_Condiction: "DropID", Edictum_List: "ID", League_Info: "ID", HotSpringRoom: "roomID",
  };
  const rowAddress = (row: Record<string, unknown>, pk: string | readonly string[]) => (typeof pk === "string" ? [pk] : pk).map(key => String(row[key])).join(":");
  const h = await createDb("pglite:memory");
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", ""); vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", ""); vi.stubEnv("TEMPLATE_TEXT_OVERRIDES_FILE", "");
  const rows = async (table: string) => ((await h.db.execute(sql.raw(`SELECT * FROM game."${table}"`))) as { rows: Record<string, unknown>[] }).rows;
  const flatten = (xml: XEl): XEl[] => [xml, ...xml.children.flatMap(flatten)];
  try {
    await migrateDb(h); await seedDatabase(h, { only: Object.keys(primaryKeys) });
    const before = new Map(await Promise.all(Object.keys(primaryKeys).map(async table => [table, await rows(table)] as const)));
    const definitions = Object.entries(tables).map(([table, [pk, endpoint]]) => ({ table, pk, def: TEMPLATES.find(d => d.endpoint === endpoint || d.files.some(f => f.name === endpoint))! }));
    expect(definitions.every(d => !!d.def)).toBe(true);
    const oldXml = await Promise.all(definitions.map(d => d.def.build(h)));
    const cardBuff = TEMPLATES.find(d => d.files.some(f => f.name === "cardbufflist"))!;
    const oldBuff = flatten(await cardBuff.build(h)).filter(n => n.name === "Item");
    const oldGame = await new Templates().load(h.db, 1);
    vi.stubEnv("TEMPLATE_TEXT_OVERRIDES_FILE", displayFile);
    vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", join(repo, "research/i18n/zh-CN-pve-overrides.json"));
    const currentGame = await new Templates().load(h.db, 1);
    const allEntries = [...entries, ...parsePveTextOverrides(JSON.stringify(readJson("zh-CN-pve-overrides.json"))).map(e => ({ ...e, rowId: String(e.id) }))];
    for (const [table, pk] of Object.entries(primaryKeys)) {
      const source = before.get(table)!, overlay = await loadTranslations(h.db, table, "pt-BR");
      const effective = new Map(source.map(row => [rowAddress(row, pk), { ...row, ...overlay.get(rowAddress(row, pk)) }]));
      for (const entry of allEntries.filter(e => e.table === table)) {
        expect(effective.has(entry.rowId), `${table}:${entry.rowId}`).toBe(true);
        expect(effective.get(entry.rowId)).toMatchObject(entry.text);
      }
      expect(await rows(table)).toEqual(source);
    }
    for (const [index, { table, pk, def }] of definitions.entries()) {
      const source = before.get(table)!, overlay = await loadTranslations(h.db, table, "pt-BR");
      const translated = new Map(source.map(row => [rowAddress(row, pk), { ...row, ...overlay.get(rowAddress(row, pk)) }]));
      const expected = entries.filter(e => e.table === table);
      expect(expected.length, table).toBeGreaterThan(0);
      for (const entry of expected) {
        expect(translated.has(entry.rowId), `${table}:${entry.rowId}`).toBe(true);
        expect(translated.get(entry.rowId)).toMatchObject(entry.text);
      }
      const current = await def.build(h), oldNodes = flatten(oldXml[index]!), newNodes = flatten(current);
      expect(newNodes.length).toBe(oldNodes.length);
      for (const [i, node] of oldNodes.entries()) {
        const next = newNodes[i]!, attributes = new Map(node.attrs), keys = typeof pk === "string" ? [pk] : pk;
        const id = keys.every(key => attributes.has(key)) ? keys.map(key => attributes.get(key)).join(":") : undefined;
        expect(next.name).toBe(node.name);
        const text = id === undefined ? {} : overlay.get(id) ?? {};
        expect(next.attrs).toEqual(node.attrs.map(([key, value]) => [key, text[key] ?? value]));
      }
      const cache = new TemplateCache(h); await cache.rebuild(def);
      expect(await rows(table)).toEqual(source);
    }
    for (const [id, row] of oldGame.pets.templates) expect(currentGame.pets.templates.get(id)).toEqual({ ...row, ...entries.find(e => e.table === "Pet_Template_Info" && e.rowId === String(id))?.text });
    for (const [id, row] of oldGame.pets.skills) expect(currentGame.pets.skills.get(id)).toEqual({ ...row, ...entries.find(e => e.table === "Pet_Skill_Info" && e.rowId === String(id))?.text });
    for (const [id, row] of oldGame.items) expect(currentGame.items.get(id)).toEqual({ ...row, ...entries.find(e => e.table === "Shop_Goods" && e.rowId === String(id))?.text });
    for (const row of oldGame.dropConditions) expect(currentGame.dropConditions.find(r => r.DropID === row.DropID)).toEqual({ ...row, ...entries.find(e => e.table === "Drop_Condiction" && e.rowId === String(row.DropID))?.text });
    const badges = await loadBadges(h.db);
    for (const row of before.get("Consortia_Badge")!) expect(badges.find(r => r.BadgeID === row.BadgeID)).toEqual({ ...row, ...entries.find(e => e.table === "Consortia_Badge" && e.rowId === String(row.BadgeID))?.text });
    const buffRows = [...before.get("Card_Buff")!].sort((a, b) => Number(a.CardID) - Number(b.CardID) || Number(a.ID) - Number(b.ID));
    const newBuff = flatten(await cardBuff.build(h)).filter(n => n.name === "Item");
    expect(newBuff.length).toBe(buffRows.length);
    for (const [i, row] of buffRows.entries()) expect(newBuff[i]!.attrs).toEqual(oldBuff[i]!.attrs.map(([key, value]) => [key, key === "Description" ? entries.find(e => e.table === "Card_Buff" && e.rowId === String(row.ID))?.text.Description ?? value : value]));
    const spaContext = { db: h, templates: currentGame } as unknown as ServerContext;
    const spa = new HotSpringMgr(spaContext); await spa.load();
    expect(spa.rooms.get(1)!.info.roomName).toBe(entries.find(e => e.table === "HotSpringRoom" && e.rowId === "1")!.text.roomName);
    await h.db.execute(sql`UPDATE game."HotSpringRoom" SET "roomName"='Player room', "roomIntroduction"='Player note' WHERE "roomID"=1`);
    await h.db.execute(sql`UPDATE game."HotSpringRoom" SET "playerID"=99 WHERE "roomID"=2`);
    const customSpa = new HotSpringMgr(spaContext); await customSpa.load();
    expect(customSpa.rooms.get(1)!.info).toMatchObject({ roomName: "Player room", roomIntroduction: "Player note" });
    expect(customSpa.rooms.get(2)!.info.roomName).toBe(before.get("HotSpringRoom")!.find(r => r.roomID === 2)!.roomName);
    vi.stubEnv("TEMPLATE_TEXT_OVERRIDES_FILE", "");
    vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", "");
    expect((await Promise.all(definitions.map(d => d.def.build(h)))).map(x => x.toString())).toEqual(oldXml.map(x => x.toString()));
  } finally { vi.unstubAllEnvs(); await h.close(); }
});
