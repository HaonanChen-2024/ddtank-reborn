import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { computeStats, emptyStatTables, userNimbus } from "../src/game/stats.js";
import { PlayerInventory } from "../src/game/inventory.js";
import { inventorySlots } from "../src/packets/out.js";

const templates = new Map((JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString()) as ItemTemplate[]).map(t => [t.TemplateID, t]));
const begin = new Date("2026-10-16T10:00:00.000Z");
const end = new Date("2026-10-19T10:00:00.000Z");
afterEach(() => vi.useRealTimers());

function weapon() {
  const item = ItemInfo.createFromTemplate(templates.get(70062)!, 1, 0, begin);
  item.StrengthenLevel = 12;
  item.goldBeginTime = begin;
  item.goldValidDate = 3;
  item.goldTemplate = templates.get(70063)!;
  return item;
}

function input(items: ItemInfo[], now: Date) {
  const equip: (ItemInfo | null)[] = new Array(31).fill(null);
  for (const item of items) equip[item.template.CategoryID === 7 ? 6 : 0] = item;
  return { equip, now, grade: 20, levelBlood: 1000, necklaceExpAdd: 0, totemId: 0,
    texp: { attTexpExp: 0, defTexpExp: 0, spdTexpExp: 0, lukTexpExp: 0, hpTexpExp: 0 }, cards: [], pet: null, evolutionGrade: 0 };
}

describe("wish-bead item lifetime and projection", () => {
  it("uses the original strict expiry boundary, independently of the persisted legacy flag", () => {
    const item = weapon();
    item.isGold = false;
    expect(item.isValidGoldItem(new Date(end.getTime() - 1))).toBe(true);
    expect(item.isValidGoldItem(end)).toBe(false);
    item.isGold = true;
    expect(item.isValidGoldItem(new Date(end.getTime() + 1))).toBe(false);
    item.goldValidDate = 0;
    expect(item.isValidGoldItem(begin)).toBe(false);
  });

  it("projects the original gold template without replacing the durable base identity", () => {
    const item = weapon();
    expect(item.effectiveTemplate(begin).TemplateID).toBe(70063);
    expect(item.displayTemplateId(begin)).toBe(70063);
    expect(item.TemplateID).toBe(70062);
    expect(item.toRow().TemplateID).toBe(70062);
    expect(item.effectiveTemplate(end)).toBe(item.template);
    expect(item.displayTemplateId(end)).toBe(70062);
  });

  it("restores base appearance and refinement at the deadline without rewriting the template", () => {
    vi.useFakeTimers(); vi.setSystemTime(begin);
    const item = weapon();
    expect(item.Pic).toBe("bombpack4"); expect(item.RefineryLevel).toBe(3);
    vi.setSystemTime(end);
    expect(item.Pic).toBe("bombpack3"); expect(item.RefineryLevel).toBe(2);
    expect(item.TemplateID).toBe(70062);
  });

  it("uses new-template stats plus positive extra bonuses, never the -1 sentinel as a stat", () => {
    const item = weapon(); item.AttackCompose = 7;
    const tables = emptyStatTables(id => templates.get(id));
    tables.goldEquip = () => ({ OldTemplateId: 70062, NewTemplateId: 70063, CategoryID: 7, Attack: -1, Defence: -1, Agility: -1, Luck: -1, Boold: 0 });
    const active = computeStats(input([item], begin), tables);
    expect([active.attack, active.defence, active.agility, active.luck]).toEqual([495, 111, 77, 55]);
    const expired = computeStats(input([item], end), tables);
    expect([expired.attack, expired.defence, expired.agility, expired.luck]).toEqual([397, 93, 62, 46]);
    expect(active.baseAttack).toBeGreaterThan(expired.baseAttack);
  });

  it("keeps armour base stats when only the original category-wide HP bonus exists", () => {
    const hat = ItemInfo.createFromTemplate(templates.get(1101)!, 1, 0, begin);
    hat.goldBeginTime = begin; hat.goldValidDate = 3;
    const tables = emptyStatTables(id => templates.get(id));
    tables.goldEquip = () => ({ OldTemplateId: -1, NewTemplateId: -1, CategoryID: 1, Attack: -1, Defence: -1, Agility: -1, Luck: -1, Boold: 2000 });
    const active = computeStats(input([hat], begin), tables);
    const expired = computeStats(input([hat], end), tables);
    expect([active.attack, active.defence, active.agility, active.luck]).toEqual([expired.attack, expired.defence, expired.agility, expired.luck]);
    expect(active.hp - expired.hp).toBe(2000);
  });

  it("expires the gold aura together with the stats", () => {
    const item = weapon();
    expect(userNimbus(input([item], begin).equip, begin)).toBe(5);
    expect(userNimbus(input([item], end).equip, end)).toBe(3);
  });

  it("serializes a gold display ID and conditional lifetime, then base ID and no gold payload at expiry", () => {
    vi.useFakeTimers(); vi.setSystemTime(begin);
    const item = weapon();
    const bag = new PlayerInventory(0, 96, 31, false, true, { onSlotsChanged() {} });
    bag.addItemTo(item, 6);
    const read = (now: Date) => {
      vi.setSystemTime(now);
      const out = inventorySlots(1, bag, [6], now);
      const p = out; p.offset = 20;
      p.readInt(); p.readInt(); p.readInt(); p.readBoolean();
      p.readInt(); p.readInt(); p.readInt(); p.readInt(); const id = p.readInt();
      for (let n = 0; n < 6; n++) p.readInt(); p.readBoolean(); p.readBoolean();
      p.readDateTime(); p.readInt(); p.readString(); p.readString(); p.readBoolean();
      for (let n = 0; n < 6; n++) p.readInt();
      const pic = p.readString(); const refinery = p.readInt(); p.readDateTime(); p.readInt();
      p.readByte(); p.readInt(); p.readByte(); p.readInt();
      const gold = p.readBoolean();
      if (gold) { expect(p.readInt()).toBe(3); p.readDateTime(); }
      expect(p.readString()).toBe("0,0,0,0");
      return { id, pic, refinery, gold };
    };
    expect(read(begin)).toEqual({ id: 70063, pic: "bombpack4", refinery: 3, gold: true });
    expect(read(end)).toEqual({ id: 70062, pic: "bombpack3", refinery: 2, gold: false });
    expect(item.TemplateID).toBe(70062);
  });
});
