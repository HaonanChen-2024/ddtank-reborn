import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { appearanceFixtureSex, createAppearanceRow, planAppearance } from "../scripts/workshop-appearance-plan.js";

const folders: Record<number, string> = { 1: "head", 2: "glass", 3: "hair", 4: "eff", 5: "cloth", 6: "face", 13: "suits" };
const item = (categoryId = 13, needSex = 0, property8 = 1) => {
  const root = `/image/equip/${needSex === 1 ? "m" : "f"}/${folders[categoryId]}/source`;
  return { templateId: 13988, name: "Visual candidate", categoryId, needSex, property8, pic: `${root}/1/${categoryId === 3 ? "a/" : ""}show.png`, previewPic: `${root}/icon_1.png`, description: "Reference visual only" };
};
const seeds: Record<string, any>[] = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString("utf8"));
const baseline = (id: number) => seeds.find(row => row.TemplateID === id)!;

describe("workshop appearance import plan", () => {
  it("uses actual sex-compatible local suit baselines and preserves neutral NeedSex", () => {
    for (const [needSex, sourceId, fixture] of [[0, 13100, "f"], [1, 13841, "m"], [2, 13842, "f"]] as const) {
      const candidate = item(13, needSex), plan = planAppearance(candidate, true), source = baseline(sourceId);
      expect(plan).toMatchObject({ sourceId, sex: fixture, folder: "suits" });
      expect(source).toMatchObject({ TemplateID: sourceId, CategoryID: 13, NeedSex: needSex, CanEquip: true, Property1: 0 });
      const before = structuredClone(source), row = createAppearanceRow(candidate, source, 13999100, "r8c258", true);
      expect(row.NeedSex).toBe(needSex);
      for (const key of Object.keys(source).filter(key => !["TemplateID", "Pic", "Name", "Description", "Remark", "Property8"].includes(key))) expect(row[key], key).toEqual(source[key]);
      expect(source).toEqual(before);
      expect(appearanceFixtureSex(needSex)).toBe(fixture);
    }
    expect(baseline(13101).NeedSex).toBe(0); expect(baseline(13201).NeedSex).toBe(0);
    expect(() => createAppearanceRow(item(13, 1), baseline(13101), 13999100, "r8c258", true)).toThrow(/wrong local appearance baseline/);
    expect(() => createAppearanceRow(item(), { ...baseline(13100), NeedSex: 2 }, 13999100, "r8c258", true)).toThrow();
  });

  it("requires independent game1 for every suit layer, and retains ordinary hair A/B paths", () => {
    expect(planAppearance(item(), true).refs).toEqual(["icon_1.png", "1/show.png", "1/game.png", "1/game1.png"]);
    const multi = planAppearance(item(13, 1, 123), true).refs;
    expect(multi).toHaveLength(10);
    for (const layer of [1, 2, 3]) expect(multi).toContain(`${layer}/game1.png`);
    const hair = planAppearance(item(3, 1, 123), true).refs;
    expect(hair).toHaveLength(13);
    for (const layer of [1, 2, 3]) for (const variant of ["a", "b"]) expect(hair).toContain(`${layer}/${variant}/game.png`);
    expect(hair.some(path => path.endsWith("game1.png"))).toBe(false);
  });

  it("rejects private-server stats or extra metadata before constructing a local row", () => {
    for (const [key, value] of [["attack", 999999], ["Attack", 999999], ["property1", 1], ["Property8", 123], ["script", "remote"], ["price", 1], ["category", "suits"]]) {
      expect(() => createAppearanceRow({ ...item(), [key!]: value }, baseline(13100), 13999100, "r8c258", true)).toThrow(/visual metadata only/);
    }
    expect(() => planAppearance({ ...item(), pic: "/image/equip/m/suits/source/1/show.png" }, true)).toThrow(/resource path/);
    expect(() => planAppearance({ ...item(), property8: 101 }, true)).toThrow();
    expect(() => planAppearance({ ...item(), property8: 11 }, true)).toThrow();
    expect(() => planAppearance({ ...item(), categoryId: 7 }, true)).toThrow(/unsupported appearance category/);
  });

  it("preserves categories 1-6 baselines, reference inheritance and official numeric overrides", () => {
    for (let category = 1; category <= 6; category++) for (const sex of [1, 2]) {
      const candidate = item(category, sex, 12), sourceId = category * 1000 + sex * 100 + 1, source = baseline(sourceId);
      const plan = planAppearance(candidate, true);
      expect(plan.sourceId).toBe(sourceId);
      const row = createAppearanceRow(candidate, source, category * 1000000 + 999100, "local", true);
      expect(row.Attack).toBe(source.Attack); expect(row.Property8).toBe(12);
      expect(() => planAppearance(item(category, 0), true)).toThrow(/NeedSex/);
    }
    const official = { ...item(5, 1), attack: 9, defence: 8, agility: 7, luck: 6, quality: 4, ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`property${i + 1}`, i === 7 ? 1 : i])) };
    const row = createAppearanceRow(official, baseline(5101), 5999100, "local", false);
    expect(row).toMatchObject({ Attack: 9, Defence: 8, Agility: 7, Luck: 6, Quality: 4, Property1: 0, Property7: 6, Property8: 1 });
    expect(row.Remark).toBe("Official DIY 13988; local rules from 5101");
  });
});
