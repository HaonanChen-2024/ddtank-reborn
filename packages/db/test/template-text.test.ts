import { describe, expect, it } from "vitest";
import { applyTranslations, parseTemplateTextOverrides } from "../src/translations.js";

const entry = { table: "Quest_Condiction", rowId: "341:1", text: { CondictionTitle: "赢得4场战斗" } };
const config = (entries: unknown = [entry]) => ({ schemaVersion: 1, entries });

describe("explicit item and quest display text", () => {
  it("addresses duplicate suit IDs by their full equipment list and permits only the existing zero league level", () => {
    const parts: { table: string; rowId: string; text: Record<string, string> }[] = [
      { table: "Suit_TemplateID", rowId: "1:7050,70501", text: { PartName: "武士套装" } },
      { table: "Suit_TemplateID", rowId: "1:7051,70511", text: { PartName: "蚂蚁套装" } },
      { table: "DailyLeagueLevel", rowId: "0", text: { Name: "大元帅" } },
    ];
    expect(parseTemplateTextOverrides(JSON.stringify(config(parts)))).toEqual(parts);
    const overlay = new Map(parts.map(e => [e.rowId, e.text]));
    const row = { ID: 1, ContainEquip: "7051,70511", PartName: "Original", damage: 30 };
    expect(applyTranslations(row, ["ID", "ContainEquip"], overlay)).toEqual({ ...row, PartName: "蚂蚁套装" });
    expect(row.PartName).toBe("Original");
    for (const rowId of ["1", "1:", "1:0", "1:7050,", "1:7050:7051", "1:2147483648", "1:7050;DROP"]) {
      expect(() => parseTemplateTextOverrides(JSON.stringify(config([{ ...parts[0], rowId }])))).toThrow();
    }
    expect(() => parseTemplateTextOverrides(JSON.stringify(config([{ ...parts[2], table: "Shop_Goods" }])))).toThrow();
  });
  it.each([
    null, [], {}, { ...config(), extra: true }, { ...config(), schemaVersion: 2 }, config(null), config({}), config([null]),
    config([{ ...entry, extra: true }]), config([{ ...entry, table: "__proto__" }]),
    config([{ ...entry, table: "Quest_Goods" }]), config([{ ...entry, table: "NPC_Info" }]),
    ...[341, "341", "341:0", "341:01", "0:1", "-1:1", "341:1:2", "2147483648:1", "341:1.5", "341: 1"]
      .map(rowId => config([{ ...entry, rowId }])),
    config([{ table: "Quest", rowId: "341:1", text: { Title: "错误地址" } }]),
    config([{ table: "Shop_Goods", rowId: "011028", text: { Name: "错误地址" } }]),
    ...[null, [], {}, { CondictionTitle: " " }, { CondictionTitle: 4 }, { Para2: "1" }, { CondictionTitle: "目标", Para1: "0" }]
      .map(text => config([{ ...entry, text }])),
    config([{ table: "Quest", rowId: "341", text: { RewardGP: "999999" } }]),
    config([{ table: "Shop_Goods", rowId: "11028", text: { Property2: "999999" } }]),
    config([entry, { ...entry, text: { CondictionTitle: "重复" } }]),
  ])("rejects malformed data, ambiguous condition addresses and gameplay changes %#", value => {
    expect(() => parseTemplateTextOverrides(JSON.stringify(value))).toThrow(/TEMPLATE_TEXT_OVERRIDES_FILE/);
  });

  it("preserves supplied display strings and ordered complete keys without mutating source rows", () => {
    const entries = [entry, { table: "Shop_Goods", rowId: "11028", text: { Name: "幸运符100%", Description: "进度 {0:N0}<br/>奖励 & 名称" } }];
    expect(parseTemplateTextOverrides(JSON.stringify(config(entries)))).toEqual(entries);
    const overlay = new Map([["341:1", entry.text], ["346:1", { CondictionTitle: "简单副本" }]]);
    const source = { QuestID: 341, CondictionID: 1, CondictionTitle: "Vietnamese", CondictionType: 6, Para1: 0, Para2: 4 };
    expect(applyTranslations(source, ["QuestID", "CondictionID"], overlay)).toEqual({ ...source, ...entry.text });
    expect(applyTranslations({ ...source, QuestID: 345 }, ["QuestID", "CondictionID"], overlay)).toEqual({ ...source, QuestID: 345 });
    expect(source.CondictionTitle).toBe("Vietnamese");
    expect(applyTranslations(source, "QuestID", overlay)).toBe(source);
  });

  it("admits only explicit display columns for the remaining template tables and the five virtual rewards", () => {
    const entries: { table: string; rowId: string; text: Record<string, string> }[] = [
      { table: "Game_Map", rowId: "1001", text: { Name: "蚂蚁之巢", Description: "挑战蚁后" } },
      { table: "Pet_Skill_Info", rowId: "1", text: { Name: "强击", Description: "伤害提高10%" } },
      { table: "Pet_Skill_Element_Info", rowId: "1", text: { Description: "持续{0}回合<br/>" } },
      { table: "New_Title", rowId: "1", text: { Name: "初露锋芒", Desc: "完成目标后获得" } },
      ...["-900", "-800", "-300", "-200", "-100"].map(rowId => ({ table: "Shop_Goods", rowId, text: { Name: "虚拟奖励名称" } })),
    ];
    expect(parseTemplateTextOverrides(JSON.stringify(config(entries)))).toEqual(entries);
    const source = { ID: 1, Name: "Old name", Description: "Old description", Damage: 123, Probability: 0.4 };
    expect(applyTranslations(source, "ID", new Map([["1", entries[1]!.text]]))).toEqual({ ...source, ...entries[1]!.text });
    expect(source.Name).toBe("Old name");
    for (const entry of [
      { table: "Pet_Skill_Info", rowId: "1", text: { Damage: "999" } },
      { table: "Pet_Skill_Element_Info", rowId: "1", text: { Probability: "1" } },
      { table: "Game_Map", rowId: "1001", text: { ForePic: "other" } },
      { table: "Shop_Goods", rowId: "-301", text: { Name: "非法虚拟地址" } },
    ]) expect(() => parseTemplateTextOverrides(JSON.stringify(config([entry])))).toThrow(/TEMPLATE_TEXT_OVERRIDES_FILE/);
  });
});
