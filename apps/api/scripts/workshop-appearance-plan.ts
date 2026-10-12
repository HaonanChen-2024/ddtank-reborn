import assert from "node:assert/strict";
import { appearanceEquipSlot } from "./workshop-appearance-identity.js";

type Row = Record<string, any>;

/** One owned ItemID per receipt entry: neutral suits are exercised only on the female fixture. */
export function appearanceFixtureSex(needSex: number): "m" | "f" {
  assert.ok([0, 1, 2].includes(needSex), "invalid appearance NeedSex");
  return needSex === 1 ? "m" : "f";
}

/** Pure import planning: no credentials, network, files, or writes. */
export function planAppearance(item: Row, reference: boolean) {
  appearanceEquipSlot(item.categoryId);
  assert.ok([1, 2].includes(item.needSex) || (item.categoryId === 13 && item.needSex === 0), "unsupported appearance NeedSex");
  if (reference) assert.ok(Object.keys(item).every(key => ["templateId", "name", "categoryId", "needSex", "pic", "previewPic", "property8", "description"].includes(key)), "reference catalog must contain visual metadata only");
  const folder = ({ 1: "head", 2: "glass", 3: "hair", 4: "eff", 5: "cloth", 6: "face", 13: "suits" } as Record<number, string>)[item.categoryId]!;
  // BaseLayer uses the template's NeedSex, not the character's Sex; neutral uses f.
  const sex = appearanceFixtureSex(item.needSex);
  const match = new RegExp(`^/image/equip/${sex}/${folder}/([A-Za-z0-9_]+)/1/${item.categoryId === 3 ? "[ab]/" : ""}show\\.png$`).exec(item.pic);
  assert.ok(match, "invalid official resource path");
  assert.equal(item.previewPic, `/image/equip/${sex}/${folder}/${match[1]}/icon_1.png`);
  const layers = String(item.property8); assert.match(layers, /^[123]{1,3}$/); assert.equal(new Set(layers).size, layers.length);
  // Default suit templates 13101/13201 both have NeedSex=0. Use actual local equip baselines.
  const sourceId = item.categoryId === 13 ? ({ 0: 13100, 1: 13841, 2: 13842 } as Record<number, number>)[item.needSex]! : item.categoryId * 1000 + item.needSex * 100 + 1;
  const refs = ["icon_1.png"];
  for (const layer of layers) for (const variant of item.categoryId === 3 ? ["a/", "b/"] : [""]) for (const kind of item.categoryId === 13 ? ["show", "game", "game1"] : ["show", "game"]) refs.push(`${layer}/${variant}${kind}.png`);
  return { folder, sex, sourcePic: match[1]!, layers, sourceId, refs };
}

export function createAppearanceRow(item: Row, source: Row, id: number, pic: string, reference: boolean): Row {
  const plan = planAppearance(item, reference);
  assert.equal(source.TemplateID, plan.sourceId, "wrong local appearance baseline");
  assert.equal(source.CategoryID, item.categoryId); assert.equal(source.NeedSex, item.needSex); assert.equal(source.CanEquip, true);
  const row: Row = { ...source, TemplateID: id, Pic: pic, Name: item.name, Description: item.description, Remark: `${reference ? "Reference visual" : "Official DIY"} ${item.templateId}; local rules from ${plan.sourceId}` };
  if (reference) row.Property8 = Number(plan.layers);
  else for (const key of ["Attack", "Defence", "Agility", "Luck", "Quality", ...Array.from({ length: 8 }, (_, i) => `Property${i + 1}`)]) {
    const value = item[key[0]!.toLowerCase() + key.slice(1)]; assert.ok(Number.isSafeInteger(value), `invalid ${key}`); row[key] = value;
  }
  return row;
}
