/**
 * Card bag (Game.Server/GameUtils/CardAbstractInventory.cs + CardInventory.cs, 100 slots, 0..4 = equipped copies) and
 * the CardDataHandler (216) rules. Pure: handlers/cards.ts sends 216, db/cards.ts persists.
 */
export interface UserCardRow {
  CardID: number; UserID: number; TemplateID: number; Place: number; Count: number;
  Attack: number; Defence: number; Agility: number; Luck: number; Guard: number; Damage: number;
  AttackReset: number; DefenceReset: number; AgilityReset: number; LuckReset: number;
  Level: number; CardGP: number; isFirstGet: boolean;
  dirty?: boolean;
}
export interface CardUpdateCond { Level: number; Exp: number; MinExp: number; MaxExp: number; UpdateCardCount: number }
export interface CardUpdateRowFull { Id: number; Level: number; Attack: number; Defend: number; Agility: number; Lucky: number; Guard: number; Damage: number }

export const CARD_EQUIP_SLOTS = 5;

export function newCard(userId: number, templateId: number, count: number): UserCardRow {
  return {
    CardID: 0, UserID: userId, TemplateID: templateId, Place: -1, Count: count, Attack: 0, Defence: 0, Agility: 0, Luck: 0, Guard: 0, Damage: 0,
    AttackReset: 0, DefenceReset: 0, AgilityReset: 0, LuckReset: 0, Level: 0, CardGP: 0, isFirstGet: false, dirty: true,
  };
}

/** UsersCardInfo.Clone + Count = 0 (the equipped copy, CardDataHandler case 0). */
export function cloneCard(c: UserCardRow): UserCardRow {
  return { ...c, CardID: 0, Count: 0, dirty: true };
}

/** UsersCardInfo.CopyProp: level/stats of the bag card onto its equipped copy. */
export function copyProp(to: UserCardRow, from: UserCardRow): void {
  to.Level = from.Level; to.CardGP = from.CardGP;
  to.Attack = from.Attack; to.Defence = from.Defence; to.Agility = from.Agility; to.Luck = from.Luck; to.Damage = from.Damage; to.Guard = from.Guard;
  to.AttackReset = from.AttackReset; to.DefenceReset = from.DefenceReset; to.AgilityReset = from.AgilityReset; to.LuckReset = from.LuckReset;
  to.dirty = true;
}

export class CardInventory {
  readonly cards: (UserCardRow | null)[];
  /** removed rows (deleted on save) */
  readonly removed: UserCardRow[] = [];
  readonly changed = new Set<number>();
  constructor(readonly userId: number, readonly capacity = 100, readonly beginSlot = CARD_EQUIP_SLOTS) {
    this.cards = new Array(capacity).fill(null);
  }
  load(rows: UserCardRow[]): void {
    for (const r of rows) if (r.Place >= 0 && r.Place < this.capacity && !this.cards[r.Place]) this.cards[r.Place] = r;
  }
  getItemAt(slot: number): UserCardRow | null {
    return slot >= 0 && slot < this.capacity ? this.cards[slot]! : null;
  }
  equipped(): UserCardRow[] {
    return this.cards.slice(0, CARD_EQUIP_SLOTS).filter((c): c is UserCardRow => !!c);
  }
  all(): UserCardRow[] {
    return this.cards.filter((c): c is UserCardRow => !!c);
  }
  isCardEquip(templateId: number): boolean {
    return this.equipped().some((c) => c.TemplateID === templateId);
  }
  getCardEquip(templateId: number): UserCardRow | null {
    return this.equipped().find((c) => c.TemplateID === templateId) ?? null;
  }
  getByTemplate(templateId: number, minSlot = this.beginSlot): UserCardRow | null {
    for (let i = minSlot; i < this.capacity; i++) if (this.cards[i]?.TemplateID === templateId) return this.cards[i]!;
    return null;
  }
  findFirstEmptySlot(minSlot = this.beginSlot): number {
    for (let i = minSlot; i < this.capacity; i++) if (!this.cards[i]) return i;
    return -1;
  }
  addCardTo(c: UserCardRow, place: number): boolean {
    if (place < 0 || place >= this.capacity || this.cards[place]) return false;
    this.cards[place] = c;
    c.Place = place;
    c.UserID = this.userId;
    c.dirty = true;
    this.changed.add(place);
    return true;
  }
  removeCardAt(place: number): boolean {
    const c = this.getItemAt(place);
    if (!c) return false;
    this.cards[place] = null;
    this.removed.push(c);
    this.changed.add(place);
    return true;
  }
  /** CardInventory.AddCard(templateId, count): stack on the bag card of the same template or take the first free slot. */
  addCard(templateId: number, count: number): boolean {
    const ex = this.getByTemplate(templateId);
    if (ex) {
      ex.Count += count;
      ex.dirty = true;
      this.changed.add(ex.Place);
      return true;
    }
    const slot = this.findFirstEmptySlot();
    return slot >= 0 && this.addCardTo(newCard(this.userId, templateId, count), slot);
  }
  updateCard(c: UserCardRow): void {
    c.dirty = true;
    if (c.Place >= 0) this.changed.add(c.Place);
  }
  /** MoveCard: StackCards (same template) or ExchangeCards. */
  moveCard(from: number, to: number): boolean {
    if (from < 0 || to < 0 || from >= this.capacity || to >= this.capacity || from === to) return false;
    const a = this.cards[from], b = this.cards[to];
    if (a && b && a.TemplateID === b.TemplateID) {
      b.Count += a.Count;
      b.dirty = true;
      this.cards[from] = null;
      this.removed.push(a);
    } else {
      this.cards[from] = b;
      this.cards[to] = a;
      if (b) { b.Place = from; b.dirty = true; }
      if (a) { a.Place = to; a.dirty = true; }
    }
    this.changed.add(from);
    this.changed.add(to);
    return true;
  }
  takeChanged(): number[] {
    const c = [...this.changed].sort((a, b) => a - b);
    this.changed.clear();
    return c;
  }
}

/** CardDataHandler case 0 (move / equip / unequip). Returns a message key to show, or null. */
export function moveOrEquipCard(bag: CardInventory, slot: number, place: number): { changedStats: boolean; msg?: string } {
  if (slot === place && slot >= CARD_EQUIP_SLOTS) return { changedStats: false };
  if ((slot < CARD_EQUIP_SLOTS && place >= CARD_EQUIP_SLOTS) || (slot === place && slot < CARD_EQUIP_SLOTS)) {
    return { changedStats: bag.removeCardAt(slot) };
  }
  if (slot >= CARD_EQUIP_SLOTS && place < CARD_EQUIP_SLOTS) {
    const c = bag.getItemAt(slot);
    if (!c) return { changedStats: false };
    if (bag.isCardEquip(c.TemplateID)) return { changedStats: false, msg: "该卡牌已装备。" };
    bag.removeCardAt(place);
    bag.addCardTo(cloneCard(c), place);
    return { changedStats: true };
  }
  bag.moveCard(slot, place);
  return { changedStats: false };
}

/** CardDataHandler case 3 (upgrade): spend UpdateCardCount copies, +rand(MinExp, MaxExp) GP, level up at Exp. */
export function upgradeCard(bag: CardInventory, slot: number, cond: (level: number) => CardUpdateCond | undefined, upd: (templateId: number, level: number) => CardUpdateRowFull | undefined,
  maxLevel: number, rnd: () => number = Math.random): { ok: boolean; levelUp: boolean; msg?: string } {
  if (slot < CARD_EQUIP_SLOTS) return { ok: false, levelUp: false };
  const c = bag.getItemAt(slot);
  if (!c) return { ok: false, levelUp: false };
  if (c.Level >= maxLevel) return { ok: false, levelUp: false, msg: "卡牌已达最高等级，无法继续升级。" };
  const k = cond(c.Level + 1);
  if (!k || c.Count < k.UpdateCardCount) return { ok: false, levelUp: false, msg: "卡牌数量不足，无法升级。" };
  c.Count -= k.UpdateCardCount;
  c.CardGP += k.MaxExp > k.MinExp ? k.MinExp + Math.floor(rnd() * (k.MaxExp - k.MinExp)) : k.MinExp;
  let levelUp = false;
  if (c.CardGP >= k.Exp) {
    const u = upd(c.TemplateID, k.Level);
    if (u) {
      c.Level++;
      c.Attack += u.Attack; c.Defence += u.Defend; c.Agility += u.Agility; c.Luck += u.Lucky; c.Damage += u.Damage; c.Guard += u.Guard;
      levelUp = true;
      const eq = bag.getCardEquip(c.TemplateID);
      if (eq) {
        copyProp(eq, c);
        bag.updateCard(eq);
      }
    }
  }
  bag.updateCard(c);
  return { ok: true, levelUp };
}
