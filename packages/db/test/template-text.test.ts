import { describe, expect, it } from "vitest";
import { applyTranslations, parseTemplateTextOverrides } from "../src/translations.js";

const entry = { table: "Quest_Condiction", rowId: "341:1", text: { CondictionTitle: "赢得4场战斗" } };
const config = (entries: unknown = [entry]) => ({ schemaVersion: 1, entries });

describe("explicit item and quest display text", () => {
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
});
