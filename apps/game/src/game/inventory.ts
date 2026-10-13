/**
 * Port of Game.Server/GameUtils/AbstractInventory.cs + PlayerInventory.cs + PlayerEquipInventory.cs.
 * Change batching (BeginChanges/CommitChanges/OnPlaceChanged) is kept: the client receives one GRID_GOODS (64)
 * packet per committed batch, listing every changed slot (AbstractPacketLib.SendUpdateInventorySlot).
 */
import { ItemInfo, isRing, type ItemTemplate } from "./item.js";

export interface InventoryHooks {
  /** PlayerInventory.UpdateChangedPlaces -> Out.SendUpdateInventorySlot(bag, slots). */
  onSlotsChanged(bag: PlayerInventory, slots: number[]): void;
  /** PlayerEquipInventory.UpdateChangedPlaces when an equip slot (< 31) changed. */
  onEquipChanged?(bag: PlayerInventory): void;
  /** GamePlayer.OnNewGearEvent: an unused item was equipped for the first time (NewGearCondition). */
  onNewGear?(item: ItemInfo): void;
  /** Player.CanEquip (level/sex). */
  canEquip?(t: ItemTemplate): boolean;
}

export class PlayerInventory {
  protected items: (ItemInfo | null)[];
  protected changedPlaces: number[] = [];
  protected changeCount = 0;
  /** Removed / taken-out persisted items; unsaved bags retain tombstones for items moved in from saved bags. */
  readonly removed: ItemInfo[] = [];
  /** Owner player id (PlayerInventory.AddItemTo sets item.UserID). */
  ownerId = 0;
  /** Slots filled by the last addTemplate call (lets callers equip a freshly bought item). */
  lastAdded: ItemInfo[] = [];

  constructor(
    readonly bagType: number,
    public capacity: number,
    readonly beginSlot: number,
    readonly autoStack: boolean,
    readonly saveToDb: boolean,
    protected hooks: InventoryHooks,
  ) {
    this.items = new Array(capacity).fill(null);
  }

  setHooks(h: InventoryHooks): void {
    this.hooks = h;
  }

  // ------------------------------------------------------------------ change batching
  beginChanges(): void {
    this.changeCount++;
  }

  commitChanges(): void {
    this.changeCount--;
    if (this.changeCount < 0) this.changeCount = 0;
    if (this.changeCount <= 0 && this.changedPlaces.length > 0) this.updateChangedPlaces();
  }

  protected onPlaceChanged(place: number): void {
    if (!this.changedPlaces.includes(place)) this.changedPlaces.push(place);
    if (this.changeCount <= 0 && this.changedPlaces.length > 0) this.updateChangedPlaces();
  }

  protected updateChangedPlaces(): void {
    const slots = this.changedPlaces.slice();
    this.changedPlaces = [];
    this.hooks.onSlotsChanged(this, slots);
  }

  // ------------------------------------------------------------------ queries
  getItemAt(slot: number): ItemInfo | null {
    if (slot < 0 || slot >= this.capacity) return null;
    return this.items[slot] ?? null;
  }

  isEmpty(slot: number): boolean {
    return slot < 0 || slot >= this.capacity || this.items[slot] == null;
  }

  getItems(minSlot = 0, maxSlot = this.capacity - 1): ItemInfo[] {
    const out: ItemInfo[] = [];
    for (let i = minSlot; i <= Math.min(maxSlot, this.capacity - 1); i++) if (this.items[i]) out.push(this.items[i]!);
    return out;
  }

  /** AbstractInventory.FindFirstEmptySlot(minSlot). */
  findFirstEmptySlot(minSlot = this.beginSlot): number {
    if (minSlot >= this.capacity) return -1;
    for (let i = Math.max(0, minSlot); i < this.capacity; i++) if (this.items[i] == null) return i;
    return -1;
  }

  /** AbstractInventory.FindFirstEmptySlot(minSlot, maxSlot) — maxSlot exclusive. */
  findFirstEmptySlotIn(minSlot: number, maxSlot: number): number {
    if (minSlot >= maxSlot) return -1;
    for (let i = minSlot; i < Math.min(maxSlot, this.capacity); i++) if (this.items[i] == null) return i;
    return -1;
  }

  getEmptyCount(minSlot = this.beginSlot): number {
    let n = 0;
    for (let i = minSlot; i < this.capacity; i++) if (this.items[i] == null) n++;
    return n;
  }

  getItemByTemplateID(minSlot: number, templateId: number): ItemInfo | null {
    for (let i = minSlot; i < this.capacity; i++) {
      const it = this.items[i];
      if (it && it.TemplateID === templateId) return it;
    }
    return null;
  }

  /** AbstractInventory.GetItemByCategoryID(minSlot, categoryID, property1). */
  getItemByCategoryID(minSlot: number, categoryId: number, property: number): ItemInfo | null {
    for (let i = minSlot; i < this.capacity; i++) {
      const it = this.items[i];
      if (it && it.template.CategoryID === categoryId && (property === -1 || it.template.Property1 === property)) return it;
    }
    return null;
  }

  getItemCount(templateId: number, minSlot = 0): number {
    let n = 0;
    for (let i = minSlot; i < this.capacity; i++) {
      const it = this.items[i];
      if (it && it.TemplateID === templateId) n += it.Count;
    }
    return n;
  }

  // ------------------------------------------------------------------ mutations
  addItem(item: ItemInfo | null, minSlot = this.beginSlot): boolean {
    if (!item) return false;
    return this.addItemTo(item, this.findFirstEmptySlot(minSlot));
  }

  /** AbstractInventory.AddItemTo. */
  addItemTo(item: ItemInfo | null, place: number): boolean {
    if (!item || place >= this.capacity || place < 0) return false;
    if (this.items[place] != null) return false;
    this.items[place] = item;
    item.Place = place;
    item.BagType = this.bagType;
    item.UserID = this.ownerId;
    item.IsExist = true;
    item.isDirty = true;
    this.onPlaceChanged(place);
    return true;
  }

  /** AbstractInventory.TakeOutItem (no removal from DB: the item moves elsewhere). */
  takeOutItem(item: ItemInfo | null): boolean {
    if (!item) return false;
    const place = this.items.indexOf(item);
    if (place === -1) return false;
    this.items[place] = null;
    this.onPlaceChanged(place);
    if (item.BagType === this.bagType) {
      item.Place = -1;
      item.BagType = -1;
    }
    if (this.saveToDb && item.ItemID > 0) this.removed.push(item);
    return true;
  }

  /** PlayerInventory.RemoveItem: also schedules the DB row as removed (IsExist=false). */
  removeItem(item: ItemInfo | null, removeType = 0): boolean {
    if (!item) return false;
    const place = this.items.indexOf(item);
    if (place === -1) return false;
    this.items[place] = null;
    this.onPlaceChanged(place);
    if (item.BagType === this.bagType) {
      item.Place = -1;
      item.BagType = -1;
    }
    // PlayerInventory.cs:223-243 marks deletion even in an unsaved FightBag;
    // ItemInfo.IsExist's C# setter also marks the object dirty.
    item.IsExist = false;
    item.isDirty = true;
    if (this.saveToDb) {
      item.RemoveType = removeType;
      item.RemoveDate = new Date();
    }
    // A source bag may already have flushed its taken-out list before use.
    if (item.ItemID > 0) this.removed.push(item);
    return true;
  }

  removeItemAt(place: number): boolean {
    return this.removeItem(this.getItemAt(place));
  }

  addCountToStack(item: ItemInfo | null, count: number): boolean {
    if (!item || count <= 0 || item.BagType !== this.bagType) return false;
    if (item.Count + count > item.template.MaxCount) return false;
    item.Count += count;
    item.isDirty = true;
    this.onPlaceChanged(item.Place);
    return true;
  }

  removeCountFromStack(item: ItemInfo | null, count: number): boolean {
    if (!item || count <= 0 || item.BagType !== this.bagType) return false;
    if (item.Count < count) return false;
    if (item.Count === count) return this.removeItem(item);
    item.Count -= count;
    item.isDirty = true;
    this.onPlaceChanged(item.Place);
    return true;
  }

  updateItem(item: ItemInfo): void {
    if (item.BagType === this.bagType) {
      item.isDirty = true;
      this.onPlaceChanged(item.Place);
    }
  }

  /** AbstractInventory.StackItemToAnother: merge into an existing stack (scans from the end). */
  stackItemToAnother(item: ItemInfo | null): boolean {
    if (!item) return false;
    for (let i = this.capacity - 1; i >= 0; i--) {
      const other = this.items[i];
      if (other && other !== item && item.canStackedTo(other) && other.Count + item.Count <= item.template.MaxCount) {
        other.Count += item.Count;
        item.IsExist = false;
        item.RemoveType = 26;
        this.updateItem(other);
        return true;
      }
    }
    return false;
  }

  addTemplate(cloneItem: ItemInfo, count = cloneItem.Count): boolean {
    return this.addTemplateRange(cloneItem, count, this.beginSlot, this.capacity - 1);
  }

  /** AbstractInventory.AddTemplate(cloneItem, count, minSlot, maxSlot). */
  addTemplateRange(cloneItem: ItemInfo, count: number, minSlot: number, maxSlot: number): boolean {
    const t = cloneItem.template;
    if (count <= 0) return false;
    if (minSlot < this.beginSlot || minSlot > this.capacity - 1) return false;
    if (maxSlot < this.beginSlot || maxSlot > this.capacity - 1 || minSlot > maxSlot) return false;
    const list: number[] = [];
    let num = count;
    for (let i = minSlot; i <= maxSlot; i++) {
      const it = this.items[i];
      if (it == null) {
        num -= t.MaxCount;
        list.push(i);
      } else if (this.autoStack && cloneItem.canStackedTo(it)) {
        num -= t.MaxCount - it.Count;
        list.push(i);
      }
      if (num <= 0) break;
    }
    if (num > 0) return false;
    this.lastAdded = [];
    this.beginChanges();
    try {
      num = count;
      for (const slot of list) {
        let it = this.items[slot];
        if (it == null) {
          it = cloneItem.clone();
          it.Count = num < t.MaxCount ? num : t.MaxCount;
          num -= it.Count;
          this.addItemTo(it, slot);
          this.lastAdded.push(it);
        } else if (it.TemplateID === t.TemplateID) {
          const add = it.Count + num < t.MaxCount ? num : t.MaxCount - it.Count;
          it.Count += add;
          num -= add;
          it.isDirty = true;
          this.lastAdded.push(it);
          this.onPlaceChanged(slot);
        }
      }
    } finally {
      this.commitChanges();
    }
    return true;
  }

  /** AbstractInventory.RemoveTemplate(templateId, count) over the whole bag. */
  removeTemplate(templateId: number, count: number, minSlot = 0, maxSlot = this.capacity - 1): boolean {
    if (count <= 0) return false;
    let total = 0;
    for (let i = minSlot; i <= maxSlot; i++) if (this.items[i]?.TemplateID === templateId) total += this.items[i]!.Count;
    if (total < count) return false;
    this.beginChanges();
    try {
      let left = count;
      for (let i = minSlot; i <= maxSlot && left > 0; i++) {
        const it = this.items[i];
        if (!it || it.TemplateID !== templateId) continue;
        if (it.Count <= left) {
          left -= it.Count;
          this.removeItem(it);
        } else {
          it.Count -= left;
          left = 0;
          it.isDirty = true;
          this.onPlaceChanged(i);
        }
      }
    } finally {
      this.commitChanges();
    }
    return true;
  }

  /** AbstractInventory.MoveItem: Combine || Stack || Exchange. */
  moveItem(fromSlot: number, toSlot: number, count: number): boolean {
    if (fromSlot < 0 || toSlot < 0 || fromSlot >= this.capacity || toSlot >= this.capacity) return false;
    if (this.items[fromSlot] == null) return false;
    const ok = this.stackItems(fromSlot, toSlot, count) || this.exchangeItems(fromSlot, toSlot);
    if (ok) {
      this.beginChanges();
      try {
        this.onPlaceChanged(fromSlot);
        this.onPlaceChanged(toSlot);
      } finally {
        this.commitChanges();
      }
    }
    return ok;
  }

  protected stackItems(fromSlot: number, toSlot: number, itemCount: number): boolean {
    const from = this.items[fromSlot]!;
    const to = this.items[toSlot];
    if (itemCount === 0) itemCount = from.Count > 0 ? from.Count : 1;
    if (to && to.TemplateID === from.TemplateID && to.canStackedTo(from)) {
      if (from.Count + to.Count > from.template.MaxCount) {
        from.Count -= to.template.MaxCount - to.Count;
        to.Count = to.template.MaxCount;
      } else {
        to.Count += itemCount;
        this.removeItem(from);
      }
      from.isDirty = true;
      to.isDirty = true;
      return true;
    }
    if (to != null || from.Count <= itemCount) return false;
    const split = from.clone();
    split.Count = itemCount;
    if (this.addItemTo(split, toSlot)) {
      from.Count -= itemCount;
      from.isDirty = true;
      return true;
    }
    return false;
  }

  protected exchangeItems(fromSlot: number, toSlot: number): boolean {
    const a = this.items[toSlot] ?? null;
    const b = this.items[fromSlot] ?? null;
    this.items[fromSlot] = a;
    this.items[toSlot] = b;
    if (a) {
      a.Place = fromSlot;
      a.isDirty = true;
    }
    if (b) {
      b.Place = toSlot;
      b.isDirty = true;
    }
    return true;
  }

  /** AbstractInventory.ClearBag (used for TempBag on room leave). */
  clearBag(): void {
    this.beginChanges();
    try {
      for (let i = 0; i < this.capacity; i++) if (this.items[i]) this.removeItem(this.items[i]);
    } finally {
      this.commitChanges();
    }
  }

  /** PlayerInventory.LoadFromDatabase body: place loaded rows (wrong-place equip handled by the equip bag). */
  loadItems(items: ItemInfo[]): void {
    this.beginChanges();
    try {
      for (const it of items) this.placeLoaded(it);
    } finally {
      this.commitChanges();
    }
  }

  protected placeLoaded(it: ItemInfo): void {
    if (!this.addItemTo(it, it.Place)) {
      // Slot taken or out of range: put it in the first free slot like a fresh add.
      this.addItem(it);
    }
    it.isDirty = it.isDirty && it.ItemID === 0;
  }

  /** Items that must be written on save (dirty or removed). */
  dirtyItems(): ItemInfo[] {
    const out = new Set<ItemInfo>(this.items.filter((i): i is ItemInfo => !!i && i.isDirty));
    for (const r of this.removed) out.add(r);
    return [...out];
  }
}

/** PlayerEquipInventory (capacity 127, begin slot 31). */
export class PlayerEquipInventory extends PlayerInventory {
  constructor(hooks: InventoryHooks) {
    super(0, 127, 31, true, true, hooks);
  }

  static isEquipSlot(slot: number): boolean {
    return slot >= 0 && slot < 31;
  }

  /** PlayerEquipInventory.FindItemEpuipSlot (PlayerEquipInventory.cs:721). */
  findItemEquipSlot(t: ItemTemplate): number {
    switch (t.CategoryID) {
      case 8:
      case 28:
        return this.items[7] == null ? 7 : 8;
      case 9:
      case 29:
        return this.items[9] == null ? 9 : 10;
      case 13:
        return 11;
      case 14:
        return 12;
      case 15:
        return 13;
      case 16:
        return 14;
      case 27:
        return 6;
      case 17:
      case 31:
        return 15;
      case 40:
        return 17;
      case 70:
        return 18;
      case 64:
        return 20;
      default:
        return t.CategoryID - 1;
    }
  }

  /** PlayerEquipInventory.CanEquipSlotContains (PlayerEquipInventory.cs:769). */
  canEquipSlotContains(slot: number, t: ItemTemplate): boolean {
    const c = t.CategoryID;
    if (c === 8 || c === 28) return slot === 7 || slot === 8;
    if (c === 9 || c === 29) return isRing(t) ? slot === 9 || slot === 10 || slot === 16 : slot === 9 || slot === 10;
    if (c === 13) return slot === 11;
    if (c === 14) return slot === 12;
    if (c === 15) return slot === 13;
    if (c === 16) return slot === 14;
    if (c === 17) return slot === 15;
    if (c === 27) return slot === 6;
    if (c === 40) return slot === 17;
    return c - 1 === slot;
  }

  /** PlayerInventory.IsWrongPlace (PlayerInventory.cs:78). */
  isWrongPlace(it: ItemInfo): boolean {
    const c = it.template.CategoryID;
    return (c === 7 && it.Place !== 6) || (c === 27 && it.Place !== 6) || (c === 17 && it.Place !== 15) || (c === 31 && it.Place !== 15);
  }

  protected override placeLoaded(it: ItemInfo): void {
    if (this.isWrongPlace(it) && it.Place < 31) {
      const slot = this.findFirstEmptySlot(31);
      it.Place = slot;
      it.isDirty = true;
      if (slot === -1 || !this.addItemTo(it, slot)) return;
      return;
    }
    super.placeLoaded(it);
  }

  /** PlayerEquipInventory.MoveItem (PlayerEquipInventory.cs:118). */
  override moveItem(fromSlot: number, toSlot: number, count: number): boolean {
    if (fromSlot < 0 || toSlot < 0 || fromSlot >= this.capacity || toSlot >= this.capacity || this.items[fromSlot] == null) return false;
    const from = this.items[fromSlot]!;
    const to = this.items[toSlot];
    const eq = PlayerEquipInventory.isEquipSlot;
    if (eq(fromSlot) && !eq(toSlot) && to && to.template.CategoryID !== from.template.CategoryID) {
      if (!this.canEquipSlotContains(fromSlot, to.template)) toSlot = this.findFirstEmptySlot(31);
    } else {
      if (eq(toSlot)) {
        if (!this.canEquipSlotContains(toSlot, from.template)) {
          this.updateItem(from);
          return false;
        }
        if ((this.hooks.canEquip && !this.hooks.canEquip(from.template)) || !from.isValidItem()) {
          this.updateItem(from);
          return false;
        }
      }
      if (eq(fromSlot) && to && !this.canEquipSlotContains(fromSlot, to.template)) {
        this.updateItem(to);
        return false;
      }
    }
    return super.moveItem(fromSlot, toSlot, count);
  }

  /** PlayerEquipInventory.UpdateChangedPlaces: equipping binds + marks used, then recompute properties. */
  protected override updateChangedPlaces(): void {
    let updateStyle = false;
    for (const slot of this.changedPlaces) {
      if (!PlayerEquipInventory.isEquipSlot(slot)) continue;
      const it = this.getItemAt(slot);
      if (it) {
        it.IsBinds = true;
        if (!it.IsUsed) {
          it.IsUsed = true;
          it.BeginDate = new Date();
          this.hooks.onNewGear?.(it);
        }
        it.isDirty = true;
      }
      updateStyle = true;
      break;
    }
    super.updateChangedPlaces();
    if (updateStyle) this.hooks.onEquipChanged?.(this);
  }
}
