import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { applyTranslations, createDb, game, loadTranslations, migrateDb, seedDatabase, type DbHandle } from "@ddt/db";
import { parseTemplateTextOverrides } from "../../../packages/db/src/translations.js";
import { TEMPLATES } from "../src/templates/defs.js";

const supplement = fileURLToPath(new URL("../../../research/i18n/zh-CN-feedback-text.json", import.meta.url));
const entries = parseTemplateTextOverrides(readFileSync(supplement, "utf8"));
const achievement = TEMPLATES.find(d => d.endpoint === "/achievementlist.ashx")!;
const goods = TEMPLATES.find(d => d.files.some(f => f.name.toLowerCase() === "templatealllist1"))!;
let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await seedDatabase(h, { only: ["Achievement", "AchievementCondition", "Achievement_Goods", "Shop_Goods"] });
}, 120_000);
beforeEach(() => {
  for (const key of ["ITEM_NAME_OVERRIDES_FILE", "PVE_TEXT_OVERRIDES_FILE", "TEMPLATE_TEXT_OVERRIDES_FILE", "TEMPLATE_TEXT_SUPPLEMENT_FILE"]) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await h?.close(); });

it("admits title display labels by full reward identity and only reviewed item Data IDs", () => {
  expect(entries.filter(e => e.table === "Achievement_Goods")).toHaveLength(60);
  expect(entries.filter(e => e.table === "Shop_Goods")).toHaveLength(311);
  for (const entry of [
    { table: "Achievement_Goods", rowId: "5091", text: { RewardPara: "错误地址" } },
    { table: "Achievement_Goods", rowId: "5091:2:58", text: { RewardPara: "非称号奖励" } },
    { table: "Achievement_Goods", rowId: "5091:1:58", text: { RewardCount: "999" } },
    { table: "Shop_Goods", rowId: "10001", text: { Data: "禁止覆盖机器参数" } },
  ]) expect(() => parseTemplateTextOverrides(JSON.stringify({ schemaVersion: 1, entries: [entry] }))).toThrow();
  const row = { AchievementID: 5091, RewardType: 2, RewardValueId: 58, RewardPara: "machine", RewardCount: 1 };
  const overlay = new Map(entries.filter(e => e.table === "Achievement_Goods").map(e => [e.rowId, e.text]));
  expect(applyTranslations(row, ["AchievementID", "RewardType", "RewardValueId"], overlay)).toBe(row);
});

it("changes the 60 reward labels and 311 item descriptions while preserving every other XML attribute and SQL row", async () => {
  const beforeRows = await h.db.select().from(game.Shop_Goods);
  const beforeRewards = await h.db.select().from(game.Achievement_Goods);
  const before = await Promise.all([achievement.build(h), goods.build(h)]);
  vi.stubEnv("TEMPLATE_TEXT_SUPPLEMENT_FILE", supplement);
  const after = await Promise.all([achievement.build(h), goods.build(h)]);
  const beforeXml = before.map(x => x.toString()), afterXml = after.map(x => x.toString());
  expect(afterXml[0]).toContain('RewardPara="天下无双"');
  expect(afterXml[1]).toContain('Data="激活此功能需要650点券,激活后30天内不会被踢出房间."');
  const withoutLabels = (xml: string) => xml.replace(/ RewardPara="[^"]*"/g, ' RewardPara=""');
  const withoutData = (xml: string) => xml.replace(/ Data="[^"]*"/g, ' Data=""');
  expect(withoutLabels(afterXml[0]!)).toBe(withoutLabels(beforeXml[0]!));
  expect(withoutData(afterXml[1]!)).toBe(withoutData(beforeXml[1]!));
  const itemOverlay = await loadTranslations(h.db, "Shop_Goods", "pt-BR");
  let changed = 0, retainedMachineData = 0;
  for (const row of beforeRows) {
    const translated = applyTranslations(row, "TemplateID", itemOverlay);
    if (translated.Data !== row.Data) changed++;
    else if (row.Data?.trim()) retainedMachineData++;
    expect({ ...translated, Data: row.Data }).toEqual(row);
  }
  expect(changed).toBe(311); expect(retainedMachineData).toBe(569);
  expect(await h.db.select().from(game.Shop_Goods)).toEqual(beforeRows);
  expect(await h.db.select().from(game.Achievement_Goods)).toEqual(beforeRewards);
  vi.stubEnv("TEMPLATE_TEXT_SUPPLEMENT_FILE", "");
  expect((await achievement.build(h)).toString()).toBe(beforeXml[0]);
  expect((await goods.build(h)).toString()).toBe(beforeXml[1]);
}, 120_000);

it("merges the supplement with the existing Chinese overlay without replacing item names or exposing it to unlisted tables", async () => {
  vi.stubEnv("TEMPLATE_TEXT_OVERRIDES_FILE", fileURLToPath(new URL("../../../research/i18n/zh-CN-template-text.json", import.meta.url)));
  const before = await loadTranslations(h.db, "Shop_Goods", "pt-BR");
  vi.stubEnv("TEMPLATE_TEXT_SUPPLEMENT_FILE", supplement);
  const after = await loadTranslations(h.db, "Shop_Goods", "pt-BR");
  expect(after.get("11995")).toEqual({ ...before.get("11995"), Data: entries.find(e => e.table === "Shop_Goods" && e.rowId === "11995")!.text.Data });
  expect(after.get("11995")!.Name).toBe(before.get("11995")!.Name);
  vi.stubEnv("TEMPLATE_TEXT_SUPPLEMENT_FILE", "missing-supplement.json");
  await expect(loadTranslations(h.db, "Achievement_Goods", "pt-BR")).rejects.toThrow(/ENOENT/);
  await expect(loadTranslations(h.db, "LoadUserBox", "pt-BR")).resolves.toEqual(new Map());
});
