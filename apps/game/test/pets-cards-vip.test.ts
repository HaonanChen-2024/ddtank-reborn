import { describe, expect, it } from "vitest";
import { activeEquipSkill, buildProp, createPet, emptyPetTables, feedPet, PetInventory, petLevelForGp, type UserPetRow } from "../src/game/pets.js";
import { CardInventory, moveOrEquipCard, upgradeCard } from "../src/game/cards.js";
import { addExpVip, applyVipDays, checkVipExpire, setTypeVIP, vipExpTable, vipPrice } from "../src/game/vip.js";
import { userNimbus } from "../src/game/stats.js";

const T = emptyPetTables();
for (const [l, gp] of [[1, 0], [2, 55], [3, 243], [4, 757], [5, 1924]] as const) T.levelGp.set(l, gp);
T.config.set("MaxHunger", "10000");
const tpl = { TemplateID: 100101, Name: "Gà Con", KindID: 1, StarLevel: 1, RareLevel: 1, HighBlood: 15000, HighAttack: 340, HighDefence: 400, HighAgility: 300, HighLuck: 300, HighBloodGrow: 2200, HighAttackGrow: 340, HighDefenceGrow: 400, HighAgilityGrow: 300, HighLuckGrow: 300 } as never;
T.templates.set(100101, tpl);

describe("pets (PetMgr / UsersPetInfo)", () => {
  it("CreatePet: grows inside the template range, level 1 props from BuildProp", () => {
    const p = createPet(T, tpl, 1, 0, 25, 0, () => 0.5);
    expect(p.AttackGrow).toBeGreaterThanOrEqual(Math.trunc(340 / 1.6));
    expect(p.AttackGrow).toBeLessThan(340 - Math.trunc(340 / 17.1));
    expect(p.Attack).toBe(Math.trunc(Math.ceil(p.AttackGrow / 10) / 10));
    expect(p.SkillEquip).toBe("0,0|-1,1|-1,2|-1,3|-1,4");
  });
  it("BuildProp level 30 uses grade-2 growth", () => {
    const p = { BloodGrow: 100, AttackGrow: 100, DefenceGrow: 100, AgilityGrow: 100, LuckGrow: 100, Level: 30 } as UserPetRow;
    buildProp(p);
    expect(p.Attack).toBe(Math.trunc(Math.ceil((100 + 29 * 100) / 10) / 10)); // (L-30)*g2 + 29*g1
  });
  it("level from GP and skill slots by level / VIP 7", () => {
    expect(petLevelForGp(T, 300, 5)).toBe(3);
    expect(petLevelForGp(T, 99999, 5)).toBe(5);
    expect(activeEquipSkill(30, 7)).toBe("0,0|0,1|0,2|-1,3|0,4");
  });
  it("FeedPet levels up and caps hunger; equip needs hunger > 0", () => {
    const p = createPet(T, tpl, 1, 0, 25, 0, () => 0.5);
    p.Hunger = 5000;
    const r = feedPet(T, p, { TemplateID: 334102, Count: 3, Property1: 1000, Property2: 100 }, 5, 0);
    expect(r.ok).toBe(true);
    expect(p.Level).toBe(3);
    expect(p.Hunger).toBe(8000);
    const bag = new PetInventory();
    bag.addPetTo(p, 0);
    p.Hunger = 0;
    expect(bag.equipPet(0, true)).toBe(false);
    p.Hunger = 10;
    expect(bag.equipPet(0, true)).toBe(true);
    expect(bag.equipped()).toBe(p);
  });
});

describe("cards (CardDataHandler)", () => {
  it("equip copies to slot 0..4 once per template, unequip removes the copy, upgrade spends copies", () => {
    const bag = new CardInventory(1);
    bag.addCard(314101, 8);
    const slot = bag.getByTemplate(314101)!.Place;
    expect(moveOrEquipCard(bag, slot, 0).changedStats).toBe(true);
    expect(bag.getItemAt(0)?.Count).toBe(0);
    expect(moveOrEquipCard(bag, slot, 1).msg).toBeDefined(); // already equipped
    const r = upgradeCard(bag, slot, () => ({ Level: 1, Exp: 50, MinExp: 60, MaxExp: 61, UpdateCardCount: 3 }), () => ({ Id: 314101, Level: 1, Attack: 2, Defend: 1, Agility: 0, Lucky: 0, Guard: 0, Damage: 0 }), 30);
    expect(r.levelUp).toBe(true);
    expect(bag.getItemAt(slot)!.Count).toBe(5);
    expect(bag.getItemAt(0)!.Level).toBe(1); // equipped copy follows (CopyProp)
    expect(moveOrEquipCard(bag, 0, 10).changedStats).toBe(true);
    expect(bag.getItemAt(0)).toBeNull();
  });
});

describe("VIP", () => {
  const base = () => ({ typeVIP: 0, VIPLevel: 0, VIPExp: 0, VIPExpireDay: new Date(0), VIPLastDate: new Date(0), VIPNextLevelDaysNeeded: 0, CanTakeVipReward: false, LastVIPPackTime: new Date(0) });
  it("renewal, type, levels from VIPExpForEachLv, price, expiry", () => {
    const now = new Date("2026-10-02T00:00:00Z");
    const c = base();
    expect(applyVipDays(c, 90, now).opened).toBe(true);
    expect(c.typeVIP).toBe(1); // 90/31 = 2
    expect(setTypeVIP(0, 93)).toBe(2);
    expect(c.VIPExpireDay.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    addExpVip(c, 2790, vipExpTable(undefined));
    expect(c.VIPLevel).toBe(5);
    expect(vipPrice({ AUnit: 30, AValue1: 930, BUnit: 90, BValue1: 2790, CUnit: 180, CValue1: 5580 }, 90)).toBe(2790);
    checkVipExpire(c, new Date("2027-02-01T00:00:00Z"));
    expect(c.typeVIP).toBe(0);
  });
});

describe("Nimbus (GetUserNimbus)", () => {
  const it2 = (cat: number, s: number, gold = false) => ({ StrengthenLevel: s, isValidGoldItem: () => gold, template: { CategoryID: cat } }) as never;
  it("aura tiers: armour hundreds, weapon units, gilded = 5", () => {
    expect(userNimbus([it2(1, 12), null, null, null, null, null, it2(7, 9)])).toBe(302);
    expect(userNimbus([it2(1, 4), it2(7, 15, true)])).toBe(5);
  });
});
