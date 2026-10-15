/**
 * Player attribute / FightPower formulas (pure, unit-tested in test/stats.test.ts).
 *
 * Mirrors:
 *  - PlayerEquipInventory.UpdatePlayerProperties (Game.Server/GameUtils/PlayerEquipInventory.cs:200-466)
 *  - GamePlayer.UpdateBaseProperties (GamePlayer.cs:5160) — hp
 *  - GamePlayer.GetBaseAttack / GetBaseDefence / GetBaseBlood (GamePlayer.cs:2436-2655)
 *  - GamePlayer.getHertAddition (GamePlayer.cs:2732), GamePlayer.UpdateFightPower (GamePlayer.cs:5212)
 *  - ExerciseMgr.GetExercise (Game.Logic/ExerciseMgr.cs:54), TotemMgr.GetTotemProp (TotemMgr.cs:104)
 *  - PropertySuit / Congthongso (PlayerEquipInventory.cs:470-690)
 * Pet equipment (eQPets) and pet "moe" properties (Pet_Moe_Property) are now wired in (PlayerEquipInventory.cs:
 * 368-394, see `petEquips`/`eat` below and game/pets.ts `petEquipMoeBonus`). Still not ported (no module in this
 * server yet): titles/rank (Sys_User_Rank), avatar collection, fight-spirit gem souls (Sys_User_Gemstone).
 */
import type { ItemInfo, ItemTemplate } from "./item.js";

export interface ExerciseRow { Grage: number; GP: number; ExerciseA: number; ExerciseAG: number; ExerciseD: number; ExerciseH: number; ExerciseL: number }
export interface TotemRow { ID: number; AddAttack: number; AddDefence: number; AddAgility: number; AddLuck: number; AddBlood: number; AddDamage: number; AddGuard: number }
export interface GoldEquipRow { OldTemplateId: number; NewTemplateId: number; CategoryID: number; Attack: number; Defence: number; Agility: number; Luck: number; Boold: number }
export interface CardUpdateRow { Id: number; Level: number; Attack: number; Defend: number; Agility: number; Lucky: number }
export interface PetFightRow { ID: number; Attack: number; Defence: number; Agility: number; Lucky: number; Blood: number; Exp: number }
export interface SuitInfoRow { SuitId: number; Skill2: string; Skill3: string; Skill4: string; Skill5: string }
/** Sys_Users_Card row (equipped = Place 0..4). */
export interface UserCard { TemplateID: number; Place: number; Level: number; Attack: number; Defence: number; Agility: number; Luck: number; AttackReset: number; DefenceReset: number; AgilityReset: number; LuckReset: number; Damage: number; Guard: number }
/** Sys_Users_Pet row (equipped pet). */
export interface UserPet { Attack: number; Defence: number; Agility: number; Luck: number; Blood: number; PetHappyStar: number; breakAttack: number; breakDefence: number; breakAgility: number; breakLuck: number; breakBlood: number }

export interface StatTables {
  findItem(id: number): ItemTemplate | undefined;
  /** ExerciseInfo ordered by Grage (level 1..max). */
  exercise: ExerciseRow[];
  totems: Map<number, TotemRow>;
  /** GoldEquipMgr.FindGoldEquipByTemplate(templateId, categoryId). */
  goldEquip(templateId: number, categoryId: number): GoldEquipRow | undefined;
  /** CardMgr.GetCardUpdateInfo(templateId, level). */
  cardUpdate(templateId: number, level: number): CardUpdateRow | undefined;
  /** PetMgr.FindFightProperty(evolutionGrade). */
  petFight(grade: number): PetFightRow | undefined;
  /** PetMoePropertyMgr.FindPetMoeProperty(level) — pet gear "manh hoa" tiers (PlayerEquipInventory.cs:368-394). */
  petMoe(level: number): { Attack: number; Lucky: number; Defence: number; Guard: number; Agility: number; Blood: number } | undefined;
  /** Suit_TemplateID rows (ID = suit id) -> ContainEquip strings. */
  suitParts: Map<number, string[]>;
  suits: Map<number, SuitInfoRow>;
}

export interface TexpExp { attTexpExp: number; defTexpExp: number; spdTexpExp: number; lukTexpExp: number; hpTexpExp: number }

export interface StatInput {
  /** EquipBag slots 0..30 (index = place). */
  equip: (ItemInfo | null)[];
  grade: number;
  /** LevelInfo.Blood for the grade (GamePlayer.LevelPlusBlood). */
  levelBlood: number;
  necklaceExpAdd: number;
  totemId: number;
  texp: TexpExp;
  cards: UserCard[];
  pet: UserPet | null;
  evolutionGrade: number;
  /** PetEquipInfo.eqType list of the equipped pet's gear (0 weapon/1 hat/2 clothes); [] when nothing is worn. */
  petEquips?: { eqType: number }[];
  /** Sys_Eat_Pets levels (per-player, not per-pet). */
  eat?: { weaponLevel: number; clothesLevel: number; hatLevel: number };
  now?: Date;
}

export interface StatResult {
  attack: number; defence: number; agility: number; luck: number; hp: number;
  baseAttack: number; baseDefence: number; baseBlood: number; fightPower: number;
  /** Highest strengthen level among equipped items (ApertureEquip / Nimbus). */
  strengthenLevel: number;
}

/** .NET Math.Round(double) = banker's rounding (MidpointRounding.ToEven). */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/** GamePlayer.getHertAddition(p1, p2) = Round(p1 * 1.1^p2 - p1). */
export function getHertAddition(p7: number, level: number): number {
  return roundHalfEven(p7 * Math.pow(1.1, level) - p7);
}

/** ExerciseMgr.GetExercise(GP, type): value of the highest level whose GP threshold is below `gp`. */
export function getExercise(rows: ExerciseRow[], gp: number, key: "ExerciseA" | "ExerciseAG" | "ExerciseD" | "ExerciseH" | "ExerciseL"): number {
  let v = 0;
  for (const r of rows) {
    if (r.GP >= gp) return v;
    v = r[key];
  }
  return v;
}

/** TotemMgr.GetTotemProp(id, type): sum over totems 10001..id. */
export function getTotemProp(totems: Map<number, TotemRow>, id: number, key: "AddAttack" | "AddDefence" | "AddAgility" | "AddLuck" | "AddBlood" | "AddDamage" | "AddGuard"): number {
  let s = 0;
  for (let i = 10001; i <= id; i++) s += totems.get(i)?.[key] ?? 0;
  return s;
}

const holes = (it: ItemInfo) => [it.Hole1, it.Hole2, it.Hole3, it.Hole4, it.Hole5, it.Hole6];
/** Attribute gem: category 11, Property1 31, Property2 3 (AddBaseProperty / BaseAttack / BaseDefence). */
function attrGem(t: StatTables, id: number): ItemTemplate | undefined {
  if (id <= 0) return undefined;
  const g = t.findItem(id);
  return g && g.CategoryID === 11 && g.Property1 === 31 && g.Property2 === 3 ? g : undefined;
}

/** `!ItemInfo.IsValidLatentEnergy()` (ItemInfo.cs:1342: EndTime.Date < Now.Date): potential counts until its end day. */
function latentActive(it: ItemInfo, now: Date): boolean {
  const day = (d: Date) => Math.floor(d.getTime() / 86_400_000);
  return !(day(it.latentEnergyEndTime) < day(now));
}

/** Suit bonus ids hard-coded in Congthongso (PlayerEquipInventory.cs:680). [atk, def, agi, luck, hp] */
export function suitSkillBonus(skill: number): number[] {
  switch (skill) {
    case 1010000: return [0, 0, 0, 0, 300];
    case 1010400: return [10, 0, 0, 0, 300];
    case 2000000: return [0, 0, 0, 0, 300];
    case 2000001:
    case 2000002: return [20, 20, 20, 20, 300];
    default: return [0, 0, 0, 0, 0];
  }
}

/** PropertySuit (simplified grouping: equipped items sharing a SuitId; count = items listed in Suit_TemplateID). */
export function propertySuit(items: ItemInfo[], t: StatTables): number[] {
  const out = [0, 0, 0, 0, 0];
  const bySuit = new Map<number, ItemInfo[]>();
  for (const it of items) {
    const sid = (it.template as { SuitId?: number }).SuitId ?? 0;
    if (sid > 0) bySuit.set(sid, [...(bySuit.get(sid) ?? []), it]);
  }
  for (const [sid, list] of bySuit) {
    if (list.length <= 1) continue;
    const parts = t.suitParts.get(sid) ?? [];
    if (parts.length <= 1) continue; // C#: `if (list4.Count <= 1) break;`
    let num = 0;
    for (const p of parts) {
      const ids = p.split(",").map((s) => Number(s.trim()));
      for (const it of list) if (ids.includes(it.TemplateID)) num++;
    }
    num = Math.min(num, list.length);
    if (num <= 1) continue;
    const info = t.suits.get(sid);
    if (!info) continue;
    const raw = num === 2 ? info.Skill2 : num === 3 ? info.Skill3 : num === 4 ? info.Skill4 : num === 5 ? info.Skill5 : null;
    if (raw == null) continue;
    const b = suitSkillBonus(Number(raw.replace(/,/g, "")) || 0);
    for (let i = 0; i < 5; i++) out[i]! += b[i]!;
  }
  return out;
}

/** GamePlayer.GetBaseAttack (GamePlayer.cs:2436). */
export function getBaseAttack(inp: StatInput, t: StatTables): number {
  let v = 0;
  for (const c of equippedCards(inp.cards)) v += (t.findItem(c.TemplateID)?.Property4 ?? 0) + c.Damage;
  const w = inp.equip[6];
  if (w) {
    const p7 = w.template.Property7;
    v += Math.trunc(getHertAddition(p7, w.StrengthenLevel + (w.isValidGoldItem(inp.now) ? 1 : 0)) + p7);
  }
  for (const it of [w, inp.equip[0], inp.equip[4]]) if (it) for (const h of holes(it)) v += attrGem(t, h)?.Property7 ?? 0;
  v += getTotemProp(t.totems, inp.totemId, "AddDamage");
  return v;
}

/** GamePlayer.GetBaseDefence (GamePlayer.cs:2588). */
export function getBaseDefence(inp: StatInput, t: StatTables): number {
  let v = 0;
  for (const c of equippedCards(inp.cards)) v += (t.findItem(c.TemplateID)?.Property5 ?? 0) + c.Guard;
  for (const it of [inp.equip[0], inp.equip[4]]) {
    if (!it) continue;
    const p7 = it.template.Property7;
    v += Math.trunc(getHertAddition(p7, it.StrengthenLevel + (it.isValidGoldItem(inp.now) ? 1 : 0)) + p7);
  }
  for (const it of [inp.equip[0], inp.equip[4], inp.equip[6]]) if (it) for (const h of holes(it)) v += attrGem(t, h)?.Property8 ?? 0;
  v += getTotemProp(t.totems, inp.totemId, "AddGuard");
  return v;
}

/** GamePlayer.GetBaseBlood: necklace (slot 12) Property1 + necklaceExpAdd percent. */
export function getBaseBlood(inp: StatInput): number {
  const n = inp.equip[12];
  return n ? (100 + n.template.Property1 + inp.necklaceExpAdd) / 100 : 1;
}

function equippedCards(cards: UserCard[]): UserCard[] {
  return cards.filter((c) => c.Place >= 0 && c.Place <= 4);
}

/** GamePlayer.UpdateFightPower (GamePlayer.cs:5212). */
export function fightPower(s: { attack: number; defence: number; agility: number; luck: number; hp: number }, baseAttack: number, baseDefence: number, secondWeapon: ItemInfo | null): number {
  const sum = s.attack + s.defence + s.agility + s.luck;
  let fp = Math.trunc(((sum + 1000) * (baseAttack ** 3 + 3.5 * baseDefence ** 3)) / 100_000_000 + s.hp * 0.95);
  if (secondWeapon) fp += Math.trunc(secondWeapon.template.Property7 * Math.pow(1.1, secondWeapon.StrengthenLevel));
  if (fp < 0 || fp > 2147483647) fp = 2147483647;
  return fp;
}

/** PlayerEquipInventory.UpdatePlayerProperties + UpdateBaseProperties + UpdateFightPower. */
export function computeStats(inp: StatInput, t: StatTables): StatResult {
  const now = inp.now ?? new Date();
  let attack = 0, defence = 0, agility = 0, luck = 0, hp = 0, strengthenLevel = 0;
  const equipped: ItemInfo[] = [];
  for (let i = 0; i < 31; i++) {
    const it = inp.equip[i];
    if (!it) continue;
    equipped.push(it);
    const base = it.effectiveTemplate(now);
    let a = it.AttackCompose + base.Attack, d = it.DefendCompose + base.Defence;
    let g = it.AgilityCompose + base.Agility, l = it.LuckCompose + base.Luck;
    const gold = it.isValidGoldItem(now) ? t.goldEquip(it.TemplateID, it.template.CategoryID) : undefined;
    if (gold) {
      // ItemInfo uses the replacement ItemTemplate, then PlayerEquipInventory adds only positive mapping bonuses.
      a += Math.max(0, gold.Attack); d += Math.max(0, gold.Defence); g += Math.max(0, gold.Agility); l += Math.max(0, gold.Luck);
      hp += Math.max(0, gold.Boold);
    }
    attack += a; defence += d; agility += g; luck += l;
    strengthenLevel = Math.max(strengthenLevel, it.StrengthenLevel);
    if (latentActive(it, now)) {
      const p = (it.latentEnergyCurStr || "0,0,0,0").split(",").map((x) => Number(x) || 0);
      attack += p[0] ?? 0; defence += p[1] ?? 0; agility += p[2] ?? 0; luck += p[3] ?? 0;
    }
    for (const h of holes(it)) {
      const gem = attrGem(t, h);
      if (gem) { attack += gem.Property3; defence += gem.Property4; agility += gem.Property5; luck += gem.Property6; }
    }
  }
  // Training (texp)
  const ex = t.exercise;
  const tA = getExercise(ex, inp.texp.attTexpExp, "ExerciseA"), tD = getExercise(ex, inp.texp.defTexpExp, "ExerciseD");
  const tG = getExercise(ex, inp.texp.spdTexpExp, "ExerciseAG"), tL = getExercise(ex, inp.texp.lukTexpExp, "ExerciseL");
  const tH = getExercise(ex, inp.texp.hpTexpExp, "ExerciseH");
  // Cards (slots 0..4): template + rolled stats, then per-level CardUpdateInfo
  let cA = 0, cD = 0, cG = 0, cL = 0;
  for (const c of equippedCards(inp.cards)) {
    const ct = t.findItem(c.TemplateID);
    if (!ct) continue;
    cA += ct.Attack + c.Attack + c.AttackReset; cD += ct.Defence + c.Defence + c.DefenceReset;
    cG += ct.Agility + c.Agility + c.AgilityReset; cL += ct.Luck + c.Luck + c.LuckReset;
    for (let lv = 1; lv <= c.Level; lv++) {
      const u = t.cardUpdate(c.TemplateID, lv);
      if (u) { attack += u.Attack; defence += u.Defend; agility += u.Agility; luck += u.Lucky; }
    }
  }
  // Pet (UsersPetInfo.Total*: base - happiness reduction + break)
  let pA = 0, pD = 0, pG = 0, pL = 0, pH = 0;
  if (inp.pet) {
    const pt = inp.pet;
    const red = (v: number) => (pt.PetHappyStar === 2 ? Math.trunc((v * 20) / 100) : pt.PetHappyStar === 1 ? Math.trunc((v * 40) / 100) : 0);
    pA = pt.Attack - red(pt.Attack) + pt.breakAttack; pD = pt.Defence - red(pt.Defence) + pt.breakDefence;
    pG = pt.Agility - red(pt.Agility) + pt.breakAgility; pL = pt.Luck - red(pt.Luck) + pt.breakLuck;
    pH = pt.Blood - red(pt.Blood) + pt.breakBlood;
    const f = t.petFight(inp.evolutionGrade);
    if (f) { pA += f.Attack; pD += f.Defence; pG += f.Agility; pL += f.Lucky; pH += f.Blood; }
    // PlayerEquipInventory.cs:368-394: each equipped gear piece adds the player's moe tier for that slot.
    if (inp.eat) for (const eq of inp.petEquips ?? []) {
      if (eq.eqType === 0) { const m = t.petMoe(inp.eat.weaponLevel); if (m) { pA += m.Attack; pL += m.Lucky; } }
      else if (eq.eqType === 1) { const m = t.petMoe(inp.eat.hatLevel); if (m) pD += m.Defence; }
      else if (eq.eqType === 2) { const m = t.petMoe(inp.eat.clothesLevel); if (m) { pG += m.Agility; pH += m.Blood; } }
    }
  }
  const suit = propertySuit(equipped, t);
  attack += suit[0]!; defence += suit[1]!; agility += suit[2]!; luck += suit[3]!; hp += suit[4]!;
  // Totem
  attack += getTotemProp(t.totems, inp.totemId, "AddAttack"); defence += getTotemProp(t.totems, inp.totemId, "AddDefence");
  agility += getTotemProp(t.totems, inp.totemId, "AddAgility"); luck += getTotemProp(t.totems, inp.totemId, "AddLuck");
  hp += getTotemProp(t.totems, inp.totemId, "AddBlood");

  attack += tA + cA + pA; defence += tD + cD + pD; agility += tG + cG + pG; luck += tL + cL + pL; hp += tH + pH;
  const baseBlood = getBaseBlood(inp);
  const finalHp = Math.trunc((hp + inp.levelBlood + Math.trunc(defence / 10)) * baseBlood);
  const timed = { ...inp, now };
  const baseAttack = getBaseAttack(timed, t);
  const baseDefence = getBaseDefence(timed, t);
  const s = { attack, defence, agility, luck, hp: finalHp };
  return { ...s, baseAttack, baseDefence, baseBlood, strengthenLevel, fightPower: fightPower(s, baseAttack, baseDefence, inp.equip[15] ?? null) };
}

/** Empty tables (tests / before templates load). */
export function emptyStatTables(findItem: (id: number) => ItemTemplate | undefined = () => undefined): StatTables {
  return { findItem, exercise: [], totems: new Map(), goldEquip: () => undefined, cardUpdate: () => undefined, petFight: () => undefined, petMoe: () => undefined, suitParts: new Map(), suits: new Map() };
}

/**
 * PlayerEquipInventory.GetUserNimbus (PlayerEquipInventory.cs:823): aura tiers of the character — hundreds = clothes/hat
 * (category 1/5), units = weapon (category 7/27). +5..8 → 1, +9..11 → 2, +12..14 → 3, +15 → 4, gilded (isGold) → 5. The
 * client (PlayerInfo.Nimbus) draws the strengthen glow/halo from it.
 */
export function userNimbus(equip: (ItemInfo | null)[], now = new Date()): number {
  let a = 0, w = 0;
  for (let i = 0; i < 31; i++) {
    const it = equip[i];
    if (!it) continue;
    const s = it.StrengthenLevel;
    const cat = it.template.CategoryID;
    const armour = cat === 1 || cat === 5, weapon = cat === 7 || cat === 27;
    if (s >= 5 && s <= 8) { if (armour) a = a <= 1 ? 1 : a; if (weapon) w = w <= 1 ? 1 : w; }
    if (s >= 9 && s <= 11) { if (armour) a = a > 1 ? a : 2; if (weapon) w = w > 1 ? w : 2; }
    if (s >= 12 && s <= 14) { if (armour) a = a > 1 ? a : 3; if (weapon) w = w > 1 ? w : 3; }
    if (s === 15) { if (armour) a = a > 1 ? a : 4; if (weapon) w = w > 1 ? w : 4; }
    if (it.isValidGoldItem(now)) { if (armour) a = 5; if (weapon) w = 5; }
  }
  return a * 100 + w;
}
