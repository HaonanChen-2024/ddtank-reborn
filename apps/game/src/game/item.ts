/**
 * Item templates (game."Shop_Goods" = ItemTemplateInfo) and item instances (player."Sys_Users_Goods" = ItemInfo).
 * Ported from SqlDataProvider/Data/ItemInfo.cs, ItemTemplateInfo.cs, Equip.cs.
 */
import type { game, player } from "@ddt/db";

export type ItemTemplate = typeof game.Shop_Goods.$inferSelect;
export type GoodsRow = typeof player.Sys_Users_Goods.$inferSelect;

/** eBageType (SqlDataProvider/eBageType.cs; 01-packet-handlers §3). */
export const BagType = {
  EquipBag: 0,
  PropBag: 1,
  TaskBag: 2,
  FightBag: 3,
  TempBag: 4,
  CaddyBag: 5,
  Consortia: 11,
  Store: 12,
  FarmBag: 13,
  Vegetable: 14,
  Card: 15,
  BeadBag: 21,
  Food: 34,
  PetEgg: 35,
  BankBag: 51,
} as const;

/** ItemTemplateInfo.BagType (ItemTemplateInfo.cs:11). */
export function templateBagType(t: ItemTemplate): number {
  switch (t.CategoryID) {
    case 10:
    case 11:
    case 12:
    case 20:
    case 26:
    case 34:
    case 35:
    case 53:
      return BagType.PropBag;
    case 32:
      return BagType.FarmBag;
    default:
      return BagType.EquipBag;
  }
}

/** Equip.isAvatar (SqlDataProvider/Data/Equip.cs:5) — switches on TemplateID in the original (sic). */
export function isAvatar(t: ItemTemplate): boolean {
  switch (t.TemplateID) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 13:
    case 15:
      return true;
    default:
      return false;
  }
}

/** Equip.isDress always returns false in this build. */
export function isDress(_t: ItemTemplate): boolean {
  return false;
}

/** ItemTemplateInfo.IsRing: CategoryID 9 with Property1? (used only for slot 16) — ring templates 9/29 with Property7>0 are not in 4.1; keep false. */
export function isRing(_t: ItemTemplate): boolean {
  return false;
}

/** ItemTemplateInfo.IsSpecial: gold/money/giftToken/exp pseudo templates. */
export function isSpecialTemplate(t: ItemTemplate): boolean {
  return t.TemplateID === -100 || t.TemplateID === -200 || t.TemplateID === -300 || t.TemplateID === 11107;
}

let tempIdSeq = 0;

export class ItemInfo {
  ItemID = 0;
  UserID = 0;
  BagType = -1;
  TemplateID: number;
  Place = -1;
  Count = 1;
  IsJudge = true;
  Color = "";
  IsExist = true;
  StrengthenLevel = 0;
  StrengthenExp = 0;
  AttackCompose = 0;
  DefendCompose = 0;
  LuckCompose = 0;
  AgilityCompose = 0;
  Skin = "";
  IsBinds = false;
  IsUsed = false;
  BeginDate: Date = new Date();
  ValidDate = 0;
  RemoveDate: Date = new Date();
  RemoveType = 0;
  Hole1 = -1;
  Hole2 = -1;
  Hole3 = -1;
  Hole4 = -1;
  Hole5 = -1;
  Hole6 = -1;
  Hole5Level = 0;
  Hole5Exp = 0;
  Hole6Level = 0;
  Hole6Exp = 0;
  StrengthenTimes = 0;
  StrengthenRefineryLevel = 0;
  isGold = false;
  goldValidDate = 0;
  goldBeginTime: Date = new Date();
  /** Resolved from the exact base-ID gold mapping; never replaces the persisted TemplateID. */
  goldTemplate: ItemTemplate | null = null;
  Blood = 0;
  latentEnergyCurStr = "0,0,0,0";
  latentEnergyNewStr = "0,0,0,0";
  latentEnergyEndTime: Date = new Date();
  curExp = 0;
  cellLocked = false;

  /** IsDirty: set on every mutation in C#; here set by inventory operations and explicit markDirty(). */
  isDirty = true;
  /** Unique in-memory id for not-yet-persisted items. */
  readonly tempId = ++tempIdSeq;

  constructor(readonly template: ItemTemplate) {
    this.TemplateID = template.TemplateID;
  }

  /** ItemInfo.CreateFromTemplate (ItemInfo.cs:901). */
  static createFromTemplate(t: ItemTemplate, count: number, removeType: number, now = new Date()): ItemInfo {
    const it = new ItemInfo(t);
    it.BeginDate = now;
    it.Count = count;
    it.IsBinds = t.BindType === 1;
    it.RemoveDate = now;
    it.RemoveType = removeType;
    it.goldBeginTime = now;
    it.latentEnergyEndTime = now;
    it.IsJudge = true;
    it.isDirty = false;
    return it;
  }

  static fromRow(row: GoodsRow, t: ItemTemplate, goldTemplate: ItemTemplate | null = null): ItemInfo {
    const it = new ItemInfo(t);
    it.goldTemplate = goldTemplate;
    Object.assign(it, {
      ItemID: row.ItemID,
      UserID: row.UserID,
      BagType: row.BagType,
      Place: row.Place,
      Count: row.Count,
      IsJudge: row.IsJudge,
      Color: row.Color ?? "",
      IsExist: row.IsExist,
      StrengthenLevel: row.StrengthenLevel,
      StrengthenExp: row.StrengthenExp,
      AttackCompose: row.AttackCompose,
      DefendCompose: row.DefendCompose,
      LuckCompose: row.LuckCompose,
      AgilityCompose: row.AgilityCompose,
      Skin: row.Skin ?? "",
      IsBinds: row.IsBinds,
      IsUsed: row.IsUsed,
      BeginDate: row.BeginDate,
      ValidDate: row.ValidDate,
      RemoveDate: row.RemoveDate,
      RemoveType: row.RemoveType,
      Hole1: row.Hole1,
      Hole2: row.Hole2,
      Hole3: row.Hole3,
      Hole4: row.Hole4,
      Hole5: row.Hole5,
      Hole6: row.Hole6,
      Hole5Level: row.Hole5Level,
      Hole5Exp: row.Hole5Exp,
      Hole6Level: row.Hole6Level,
      Hole6Exp: row.Hole6Exp,
      StrengthenTimes: row.StrengthenTimes,
      StrengthenRefineryLevel: row.StrengthenRefineryLevel,
      isGold: row.isGold,
      goldValidDate: row.goldValidDate,
      goldBeginTime: row.goldBeginTime,
      Blood: row.Blood,
      latentEnergyCurStr: row.latentEnergyCurStr,
      latentEnergyNewStr: row.latentEnergyNewStr,
      latentEnergyEndTime: row.latentEnergyEndTime,
      curExp: row.curExp,
      cellLocked: row.cellLocked,
    });
    it.isDirty = false;
    return it;
  }

  toRow(): Omit<GoodsRow, "ItemID"> & { ItemID?: number } {
    const r = {
      UserID: this.UserID,
      BagType: this.BagType,
      TemplateID: this.TemplateID,
      Place: this.Place,
      Count: this.Count,
      IsJudge: this.IsJudge,
      Color: this.Color,
      IsExist: this.IsExist,
      StrengthenLevel: this.StrengthenLevel,
      StrengthenExp: this.StrengthenExp,
      AttackCompose: this.AttackCompose,
      DefendCompose: this.DefendCompose,
      LuckCompose: this.LuckCompose,
      AgilityCompose: this.AgilityCompose,
      Skin: this.Skin,
      IsBinds: this.IsBinds,
      IsUsed: this.IsUsed,
      BeginDate: this.BeginDate,
      ValidDate: this.ValidDate,
      RemoveDate: this.RemoveDate,
      RemoveType: this.RemoveType,
      Hole1: this.Hole1,
      Hole2: this.Hole2,
      Hole3: this.Hole3,
      Hole4: this.Hole4,
      Hole5: this.Hole5,
      Hole6: this.Hole6,
      Hole5Level: this.Hole5Level,
      Hole5Exp: this.Hole5Exp,
      Hole6Level: this.Hole6Level,
      Hole6Exp: this.Hole6Exp,
      StrengthenTimes: this.StrengthenTimes,
      StrengthenRefineryLevel: this.StrengthenRefineryLevel,
      isGold: this.isValidGoldItem(),
      goldValidDate: this.goldValidDate,
      goldBeginTime: this.goldBeginTime,
      Blood: this.Blood,
      latentEnergyCurStr: this.latentEnergyCurStr,
      latentEnergyNewStr: this.latentEnergyNewStr,
      latentEnergyEndTime: this.latentEnergyEndTime,
      curExp: this.curExp,
      cellLocked: this.cellLocked,
    };
    return this.ItemID > 0 ? { ...r, ItemID: this.ItemID } : r;
  }

  /** ItemInfo.CloneFromTemplate (ItemInfo.cs:812): same properties on another template (new ItemID). */
  static cloneFromTemplate(t: ItemTemplate, from: ItemInfo): ItemInfo {
    const c = new ItemInfo(t);
    for (const [k, v] of Object.entries(from)) {
      if (k === "tempId" || k === "template" || k === "TemplateID") continue;
      (c as unknown as Record<string, unknown>)[k] = v instanceof Date ? new Date(v.getTime()) : v;
    }
    c.ItemID = 0;
    c.isDirty = true;
    return c;
  }

  /** ItemInfo.OpenHole (ItemInfo.cs:1199): template Hole = "needLevel,type|..."; holes reached by StrengthenLevel open (-1 -> 0). */
  openHole(): void {
    const parts = (this.template.Hole ?? "").split("|");
    for (let i = 0; i < parts.length && i < 6; i++) {
      const [lv, type] = parts[i]!.split(",").map(Number);
      if (lv === undefined || type === undefined || Number.isNaN(lv) || this.StrengthenLevel < lv || type === -1) continue;
      const key = `Hole${i + 1}` as "Hole1";
      if (this[key] < 0) this[key] = 0;
    }
  }

  /** Hole type for gem inlay (template Hole "lvl,type|..."). */
  holeType(hole: number): number {
    const part = (this.template.Hole ?? "").split("|")[hole - 1];
    return part ? Number(part.split(",")[1]) : NaN;
  }

  /** ItemInfo.isDrill (ItemInfo.cs:1117): this item's own TemplateID is the right drill tier for `holelv` (0..4). */
  isDrill(holelv: number): boolean {
    switch (this.TemplateID) {
      case 11035: return holelv === 0;
      case 11036: return holelv === 1;
      case 11026: return holelv === 2;
      case 11027: return holelv === 3;
      case 11034: return holelv === 4;
      default: return false;
    }
  }

  /** ItemInfo.Clone: new instance (ItemID 0), same properties. */
  clone(): ItemInfo {
    const c = new ItemInfo(this.template);
    for (const [k, v] of Object.entries(this)) {
      if (k === "tempId" || k === "template") continue;
      (c as unknown as Record<string, unknown>)[k] = v instanceof Date ? new Date(v.getTime()) : v;
    }
    c.ItemID = 0;
    c.isDirty = true;
    return c;
  }

  get Pic(): string {
    return this.effectiveTemplate().Pic ?? "";
  }
  get RefineryLevel(): number {
    return this.effectiveTemplate().RefineryLevel;
  }
  /** ItemInfo base-property getters use the gold template only during its valid lifetime. */
  get Attack(): number {
    return this.AttackCompose + this.effectiveTemplate().Attack;
  }
  get Defence(): number {
    return this.DefendCompose + this.effectiveTemplate().Defence;
  }
  get Agility(): number {
    return this.AgilityCompose + this.effectiveTemplate().Agility;
  }
  get Luck(): number {
    return this.LuckCompose + this.effectiveTemplate().Luck;
  }

  /** ItemInfo.IsValidGoldItem (1181): strict positive days and end time > now; no legacy flag gate. */
  isValidGoldItem(now = new Date()): boolean {
    return this.goldValidDate > 0 && this.goldBeginTime.getTime() + this.goldValidDate * 86_400_000 > now.getTime();
  }

  effectiveTemplate(now = new Date()): ItemTemplate {
    return this.isValidGoldItem(now) && this.goldTemplate ? this.goldTemplate : this.template;
  }

  displayTemplateId(now = new Date()): number {
    return this.effectiveTemplate(now).TemplateID;
  }

  /** ItemInfo.CanStackedTo (ItemInfo.cs:751). */
  canStackedTo(to: ItemInfo): boolean {
    if (this.TemplateID === to.TemplateID && this.template.MaxCount > 1 && this.IsBinds === to.IsBinds && this.IsUsed === to.IsUsed) {
      // C# compares `ValidDate == ValidDate` (always true) after the BeginDate check — kept.
      if (this.ValidDate === 0 || this.BeginDate.toDateString() === to.BeginDate.toDateString()) return true;
    } else if (this.TemplateID === to.TemplateID && isDress(this.template) && isDress(to.template) && to.StrengthenLevel <= 0) {
      return true;
    }
    return false;
  }

  /** ItemInfo.IsValidItem: permanent, not yet used, or BeginDate + ValidDate days still in the future. */
  isValidItem(now = new Date()): boolean {
    if (this.ValidDate === 0 || !this.IsUsed) return true;
    return this.BeginDate.getTime() + this.ValidDate * 86_400_000 > now.getTime();
  }

  /** ItemInfo.CanEquip: template CanEquip and still valid. */
  canEquip(): boolean {
    return this.template.CanEquip && this.isValidItem();
  }
}
