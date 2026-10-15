/**
 * GamePlayer (Game.Server/GamePlayer.cs) — online character state, bags, currencies and persistence.
 * Bags constructed as in the GamePlayer ctor (GamePlayer.cs:1126-1137).
 */
import { saveRecords } from "./events.js";
import type { GSPacket } from "@ddt/protocol";
import type { Database } from "@ddt/db";
import { savePlayerInfo } from "../db/characters.js";
import { saveItem } from "../db/items.js";
import type { AchievementDataRow, BuffRow, ExtraRow, QuestDataRow, RecordRow } from "../db/social.js";
import * as Out from "../packets/out.js";
import { BagType, ItemInfo, templateBagType, isSpecialTemplate, type ItemTemplate } from "./item.js";
import { PlayerEquipInventory, PlayerInventory, type InventoryHooks } from "./inventory.js";
import type { MatchRow, PlayerInfo } from "./player-info.js";
import type { BaseRoom } from "../rooms/room.js";
import type { QuestInventory } from "./quests.js";
import { saveBuffs, saveQuests } from "../db/social.js";
import { computeStats, emptyStatTables, userNimbus, type StatTables, type UserCard, type UserPet } from "./stats.js";
import { PetInventory, reduceProp, getPetEquips } from "./pets.js";
import { CardInventory } from "./cards.js";
import { savePets, saveCards, saveEatPets } from "../db/pets-cards.js";

/** ePlayerState. */
export const PlayerState = { Offline: 0, Manual: 1, Online: 1, Away: 2 } as const;

export interface PacketSink {
  send(pkt: GSPacket): void;
  disconnect(reason: string): void;
  readonly remoteAddress: string;
  /** Resolves when every packet already queued for this connection was handled (GameClient.idle). */
  idle?(): Promise<void>;
  /** Timed world-boss awards join the same queue as ordinary inbound packets. */
  enqueueWorldBossAward?<T>(work: () => Promise<T>): Promise<T>;
  /** Runs at the next packet boundary; the current handler must not await work it just enqueued. */
  enqueueCombatSettlement?<T>(work: () => Promise<T>): Promise<T>;
}

export interface RoomMember {
  readonly id: number;
  readonly isBot: boolean;
  view(): Out.PlayerView;
  send(pkt: GSPacket): void;
  sendMessage(type: number, msg: string): void;
  currentRoom: BaseRoom | null;
  roomIndex: number;
  roomTeam: number;
  isViewer: boolean;
  readonly hasMainWeapon: boolean;
  readonly playerState: number;
  readonly info: PlayerInfo;
  onRoomLeft?(): void;
  /** Real players defer a synchronous room entry while persistence is pending. */
  runRoomEntry?(work: () => void): void | Promise<void>;
  readonly worldBossAwardPending?: Promise<void> | null;
}

export class GamePlayer implements RoomMember {
  readonly isBot = false;
  readonly equipBag: PlayerEquipInventory;
  readonly propBag: PlayerInventory;
  readonly consortiaBag: PlayerInventory;
  readonly bankBag: PlayerInventory;
  readonly storeBag: PlayerInventory;
  readonly fightBag: PlayerInventory;
  readonly tempBag: PlayerInventory;
  readonly caddyBag: PlayerInventory;
  readonly farmBag: PlayerInventory;
  readonly foodBag: PlayerInventory;
  readonly petEggBag: PlayerInventory;
  friends = new Map<number, number>();
  quests: QuestDataRow[] = [];
  /** QuestInventory (set at login). */
  questInv: QuestInventory | null = null;
  /** LevelMgr.GetLevel(GP) (set at login). */
  gradeForGp: (gp: number) => number | undefined = () => undefined;
  /** LanguageMgr.GetTranslation (set at login) for messages built inside the player (quests). */
  lang: (key: string, ...args: unknown[]) => string = (k) => k;
  achievements: AchievementDataRow[] = [];
  records: RecordRow[] = [];
  buffs: BuffRow[] = [];
  extra: ExtraRow | null = null;
  currentRoom: BaseRoom | null = null;
  roomIndex = -1;
  roomTeam = 1;
  isViewer = false;
  playerState: number = PlayerState.Manual;
  lastChatTime = 0;
  /** GamePlayer.LastOpenHole (OpenFiveSixHoleHandler.cs throttle). */
  lastOpenHole = 0;
  /** GamePlayer.TimeCheckHack (unix seconds of the last 300 heartbeat). */
  timeCheckHack = 0;
  pingStart = 0;
  pingTime = 0;
  /** GamePlayer.m_showPP: ViewCurrent only sends 167 after the login burst. */
  showPP = false;
  readonly tempProperties = new Map<string, number>();
  isActive = true;
  /** Set by quitPlayer: every caller awaits the same quit (and its final save). */
  quitting: Promise<void> | null = null;
  /** Attribute tables (Templates.stats); set at login. */
  statTables: StatTables = emptyStatTables();
  /** Sys_Users_Card rows (equipped = Place 0..4) and the equipped Sys_Users_Pet (loaded at login). */
  cards: UserCard[] = [];
  pet: UserPet | null = null;
  /** PetInventory (20 slots) and CardInventory (100 slots, 0..4 equipped): loaded at login (session/login.ts). */
  petBag = new PetInventory(20);
  cardBag: CardInventory;
  /** GamePlayer.GetBaseAttack / GetBaseDefence from the last recalcStats (fight specs). */
  baseAttack = 0;
  baseDefence = 0;
  private changeDepth = 0;
  private propsPending = false;

  constructor(
    readonly sink: PacketSink,
    public info: PlayerInfo,
    public match: MatchRow,
    public zoneId: number,
    public zoneName: string,
    private readonly levelBlood: (grade: number) => number = () => 0,
  ) {
    const hooks: InventoryHooks = {
      onSlotsChanged: (bag, slots) => this.send(Out.inventorySlots(this.id, bag, slots)),
      onEquipChanged: () => this.updatePlayerProperties(),
      canEquip: (t) => this.canEquip(t),
      onNewGear: (it) => this.questInv?.onNewGear(it.template.CategoryID),
    };
    this.equipBag = new PlayerEquipInventory(hooks);
    this.cardBag = new CardInventory(info.ID);
    this.propBag = new PlayerInventory(BagType.PropBag, 96, 0, true, true, hooks);
    this.consortiaBag = new PlayerInventory(BagType.Consortia, 100, 0, true, true, hooks);
    this.bankBag = new PlayerInventory(BagType.BankBag, 198, 0, true, true, hooks);
    this.storeBag = new PlayerInventory(BagType.Store, 20, 0, true, true, hooks);
    this.fightBag = new PlayerInventory(BagType.FightBag, 3, 0, false, false, hooks);
    this.tempBag = new PlayerInventory(BagType.TempBag, 60, 0, true, false, hooks);
    this.caddyBag = new PlayerInventory(BagType.CaddyBag, 30, 0, true, false, hooks);
    this.farmBag = new PlayerInventory(BagType.FarmBag, 30, 0, true, true, hooks);
    this.foodBag = new PlayerInventory(BagType.Food, 30, 0, true, true, hooks);
    this.petEggBag = new PlayerInventory(BagType.PetEgg, 30, 0, true, true, hooks);
    for (const b of this.allBags()) b.ownerId = info.ID;
  }

  get id(): number {
    return this.info.ID;
  }

  allBags(): PlayerInventory[] {
    return [this.equipBag, this.propBag, this.consortiaBag, this.bankBag, this.storeBag, this.fightBag, this.tempBag, this.caddyBag, this.farmBag, this.foodBag, this.petEggBag];
  }

  send(pkt: GSPacket): void {
    this.sink.send(pkt);
  }

  sendMessage(type: number, msg: string): void {
    this.send(Out.message(type, msg));
  }

  /** GamePlayer.GetInventory (GamePlayer.cs:2737). */
  getInventory(bagType: number): PlayerInventory | null {
    switch (bagType) {
      case BagType.CaddyBag: return this.caddyBag;
      case BagType.Consortia: return this.consortiaBag;
      case BagType.FarmBag: return this.farmBag;
      case BagType.EquipBag: return this.equipBag;
      case BagType.FightBag: return this.fightBag;
      case BagType.Food: return this.foodBag;
      case BagType.PetEgg: return this.petEggBag;
      case BagType.PropBag: return this.propBag;
      case BagType.Store: return this.storeBag;
      case BagType.TempBag: return this.tempBag;
      case BagType.BankBag: return this.bankBag;
      default: return null;
    }
  }

  getItemInventory(t: ItemTemplate): PlayerInventory | null {
    return this.getInventory(templateBagType(t));
  }

  get mainWeapon(): ItemInfo | null {
    return this.equipBag.getItemAt(6);
  }
  get hasMainWeapon(): boolean {
    return this.mainWeapon != null;
  }
  get secondWeapon(): ItemInfo | null {
    return this.equipBag.getItemAt(15);
  }

  /** GamePlayer.CanEquip: NeedLevel and NeedSex (0 any, 1 male, 2 female). */
  canEquip(t: ItemTemplate): boolean {
    if (t.NeedLevel > this.info.Grade) return false;
    if (t.NeedSex !== 0 && t.NeedSex !== (this.info.Sex ? 1 : 2)) return false;
    return t.CanEquip;
  }

  /** Medal = count of item 11408 (GetMedalNum). */
  get medal(): number {
    return this.propBag.getItemCount(11408);
  }

  view(): Out.PlayerView {
    return {
      id: this.id,
      info: this.info,
      match: this.match,
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      roomIndex: this.roomIndex,
      roomTeam: this.roomTeam,
      inRoom: this.currentRoom != null,
      pingTime: this.pingTime,
      weaponTemplateId: this.mainWeapon?.TemplateID ?? -1,
      secondWeaponTemplateId: this.secondWeapon?.TemplateID ?? 0,
      medal: this.medal,
    };
  }

  // -------------------------------------------------------------------- properties
  beginChanges(): void {
    this.changeDepth++;
  }
  commitChanges(): void {
    this.changeDepth = Math.max(0, this.changeDepth - 1);
    this.updateProperties();
  }

  /** GamePlayer.UpdateProperties (GamePlayer.cs:5352): 38 to self, 67 to self and the room. */
  updateProperties(): void {
    if (this.changeDepth > 0) {
      this.propsPending = true;
      return;
    }
    this.propsPending = false;
    this.send(Out.privateInfo(this.info, this.medal));
    const pub = Out.publicPlayer(this.info, this.match);
    this.send(pub);
    this.currentRoom?.sendToAll(pub, this);
  }

  /**
   * PlayerEquipInventory.UpdatePlayerProperties (PlayerEquipInventory.cs:200): attributes, hp and FightPower via
   * game/stats.ts (items, compose, strengthen, gems, potential, gold plating, training, cards, pet, suits, totem),
   * style/colors/skin string, then 38/67 property packets.
   */
  updatePlayerProperties(): void {
    this.recalcStats();
    if (this.showPP) this.send(Out.playerProperty(this.id));
    this.updateProperties();
  }

  /** The computation half of UpdatePlayerProperties (no packets): used before the login burst too. */
  recalcStats(): void {
    const styleIndex = [1, 2, 3, 4, 5, 6, 11, 13, 14, 15, 16, 17, 18, 19, 20];
    const s0 = this.equipBag.getItemAt(0);
    let style = s0 ? `${s0.TemplateID}|${s0.Pic}` : "";
    let color = s0 ? s0.Color : "";
    const skin = this.equipBag.getItemAt(5)?.Skin ?? "";
    for (const idx of styleIndex) {
      style += ",";
      color += ",";
      const it = this.equipBag.getItemAt(idx);
      if (it) {
        style += `${it.TemplateID}|${it.Pic}`;
        color += it.Color;
      }
    }
    const c = this.info;
    const equip: (ItemInfo | null)[] = [];
    for (let i = 0; i < 31; i++) equip.push(this.equipBag.getItemAt(i));
    const r = computeStats({
      equip, grade: c.Grade, levelBlood: this.levelBlood(c.Grade), necklaceExpAdd: c.necklaceExpAdd ?? 0, totemId: c.totemId ?? 0,
      texp: c.Texp ?? { attTexpExp: 0, defTexpExp: 0, spdTexpExp: 0, lukTexpExp: 0, hpTexpExp: 0 },
      cards: this.cardBag.equipped().length ? this.cardBag.equipped() : this.cards, pet: this.petBag.equipped() ?? this.pet, evolutionGrade: c.evolutionGrade ?? 0,
      petEquips: this.petBag.equipped() ? getPetEquips(this.petBag.equipped()!) : [], eat: this.petBag.eat,
    }, this.statTables);
    c.Attack = r.attack; c.Defence = r.defence; c.Agility = r.agility; c.Luck = r.luck; c.hp = r.hp;
    c.FightPower = r.fightPower;
    this.baseAttack = r.baseAttack;
    this.baseDefence = r.baseDefence;
    c.Nimbus = userNimbus(equip); // GetUserNimbus (strengthen / gilded aura tiers)
    c.Style = style; c.Colors = color; c.Skin = skin;
  }

  // -------------------------------------------------------------------- currencies (GamePlayer Add*/Remove*)
  /** Level-up hook (GamePlayer.AddGP → AcademyMgr.UpdateAwardApp when masterID != 0). */
  onGradeUp?: (oldGrade: number) => void;
  /** GamePlayer.AddGP: level-up recomputes HP, refreshes grade quests; the client re-requests quests on Grade change. */
  addGP(v: number, useMultiple = true): void {
    if (v <= 0) return;
    // GamePlayer.AddGP (GamePlayer.cs:1357): GPAddPlus (type 13 GP buff, e.g. x2 exp card) multiplies; AddGP(gp, false) does not.
    if (useMultiple && this.gpAddPlus > 0) v = Math.trunc(v * this.gpAddPlus);
    this.info.GP += v;
    const g = this.gradeForGp(this.info.GP);
    if (g && g > this.info.Grade) {
      const old = this.info.Grade;
      this.info.Grade = g;
      this.updatePlayerProperties();
      this.questInv?.refresh();
      this.onGradeUp?.(old);
    } else this.updateProperties();
  }
  /** GamePlayer.RemoveGP (GamePlayer.cs:3876): cancel the whole deduction if it would lose a level. */
  removeGP(v: number): number {
    if (!Number.isFinite(v) || v <= 0) return 0;
    this.info.GP = Math.max(1, this.info.GP - v);
    const grade = this.gradeForGp(this.info.GP);
    if (grade !== undefined && this.info.Grade > grade) this.info.GP += v;
    // UpdateLevel also recalculates derived properties when the stored grade
    // changes. Publish one consistent update, including for old mismatched saves.
    const finalGrade = this.gradeForGp(this.info.GP);
    if (finalGrade !== undefined && finalGrade !== this.info.Grade) {
      const old = this.info.Grade;
      this.info.Grade = finalGrade;
      this.updatePlayerProperties();
      this.questInv?.refresh();
      if (finalGrade > old) this.onGradeUp?.(old);
    } else this.updateProperties();
    return v; // The original returns the requested penalty, including a cancelled one.
  }
  /** GamePlayer.GPAddPlus: product of the active GP-multiplier buffs (type 13). */
  get gpAddPlus(): number {
    let m = 1;
    const now = Date.now();
    for (const b of this.buffs) if (b.Type === 13 && b.IsExist && b.BeginDate.getTime() + b.ValidDate * 60_000 > now) m *= b.Value || 1;
    return m;
  }
  addMoney(v: number): void { if (v > 0) { this.info.Money += v; this.updateProperties(); } }
  addOffer(v: number): void { if (v > 0) { this.info.Offer += v; this.updateProperties(); } }
  addHonor(v: number): void { if (v > 0) { this.info.myHonor += v; this.updateProperties(); } }
  addHardCurrency(v: number): void { if (v > 0) { this.info.hardCurrency += v; this.updateProperties(); } }
  /** GamePlayer.AddMedal (GamePlayer.cs:3961): medals are item 11408 in the PropBag. */
  addMedal(v: number, find: (id: number) => ItemTemplate | undefined): void {
    if (v <= 0) return;
    const it = this.propBag.getItemByTemplateID(0, 11408);
    if (it && this.propBag.addCountToStack(it, v)) { this.updateProperties(); return; }
    const t = find(11408);
    if (t) this.propBag.addTemplate(ItemInfo.createFromTemplate(t, v, 104), v);
    this.updateProperties();
  }
  addGold(v: number): void { if (v > 0) { this.info.Gold += v; this.updateProperties(); } }
  removeGold(v: number): void { if (v > 0) { this.info.Gold -= v; this.updateProperties(); } }
  addGiftToken(v: number): void { if (v > 0) { this.info.GiftToken += v; this.updateProperties(); } }
  removeGiftToken(v: number): void { if (v > 0) { this.info.GiftToken -= v; this.updateProperties(); } }
  removeOffer(v: number): void { if (v > 0) { this.info.Offer -= v; this.updateProperties(); } }
  removePetScore(v: number): void { if (v > 0) { this.info.petScore -= v; this.updateProperties(); } }
  /** GamePlayer.AddPetScore (GamePlayer.cs:1626). */
  addPetScore(v: number): void { if (v > 0) { this.info.petScore += v; this.updateProperties(); } }
  removeScore(v: number): void { if (v > 0) { this.info.Score -= v; this.updateProperties(); } }
  removeDamageScores(v: number): void { if (v > 0) { this.info.damageScores -= v; this.updateProperties(); } }
  /** GamePlayer.RemoveMoney: bound money (MoneyLock) first, then Money. */
  removeMoney(v: number): void {
    if (v <= 0) return;
    const fromLock = Math.min(this.info.MoneyLock, v);
    this.info.MoneyLock -= fromLock;
    this.info.Money -= v - fromLock;
    this.updateProperties();
  }
  removeMedal(count: number): void {
    this.propBag.removeTemplate(11408, count);
  }

  /** GamePlayer.GetTemplateCount (GamePlayer.cs:1823). */
  getTemplateCount(templateId: number, find: (id: number) => ItemTemplate | undefined): number {
    const t = find(templateId);
    if (!t) return 0;
    return this.getItemInventory(t)?.getItemCount(templateId) ?? 0;
  }

  /** GamePlayer.RemoveTemplateInShop (GamePlayer.cs:1810). */
  removeTemplateInShop(templateId: number, count: number, find: (id: number) => ItemTemplate | undefined): boolean {
    const t = find(templateId);
    if (!t) return false;
    return this.getItemInventory(t)?.removeTemplate(templateId, count) ?? false;
  }

  /** GamePlayer.AddTemplate(cloneItem, bagType, count, backToMail) (GamePlayer.cs:1789). */
  addTemplateToBag(item: ItemInfo, bagType: number, count: number): boolean {
    const inv = this.getInventory(bagType);
    if (!inv || isSpecialTemplate(item.template)) return false;
    return inv.addTemplate(item, count);
  }

  /** PetInventory.UpdateChangedPlaces → 68/1 with the changed slots (`all` = every slot, login). */
  flushPets(all = false): void {
    const places = all ? this.petBag.pets.map((_, i) => i) : this.petBag.takeChanged();
    if (all) this.petBag.changed.clear();
    if (!places.length) return;
    const slots = places.map((place) => {
      const pet = this.petBag.getPetAt(place);
      return { place, pet: pet ? { ...pet, petEquips: getPetEquips(pet), PetHappyStarReduce: (v: number) => reduceProp(pet, v) } : null };
    });
    this.send(Out.updateUserPet(this.id, this.zoneId, slots, this.petBag.eat));
  }
  /** CardInventory.UpdateChangedPlaces → 216 with the changed slots (every occupied slot at login). */
  flushCards(all = false): void {
    const places = all ? this.cardBag.cards.map((_, i) => i).filter((i) => this.cardBag.cards[i]) : this.cardBag.takeChanged();
    if (all) this.cardBag.changed.clear();
    if (!places.length) return;
    this.send(Out.cardData(this.id, places.map((place) => ({ place, card: this.cardBag.getItemAt(place) }))));
  }

  isBlackFriend(id: number): boolean {
    return this.friends.get(id) === 1;
  }

  // -------------------------------------------------------------------- persistence
  private persistenceTail: Promise<void> = Promise.resolve();
  private persistencePending = 0;
  worldBossAwardPending: Promise<void> | null = null;

  /** Room start observes this barrier even when no DdtGame exists yet. The
   * reward/administrative owner must already own the client's packet queue. */
  async withWorldBossAward<T>(work: () => Promise<T>): Promise<T> {
    while (this.worldBossAwardPending) await this.worldBossAwardPending;
    let release!: () => void;
    this.worldBossAwardPending = new Promise<void>((resolve) => { release = resolve; });
    try { return await work(); } finally { this.worldBossAwardPending = null; release(); }
  }

  /** Serialize autosave, explicit save and quit with committed inventory transactions.
   * Take inventory snapshots inside this lock, never before waiting for an earlier save. */
  withPersistenceLock<T>(work: () => Promise<T>): Promise<T> {
    this.persistencePending++;
    const result = this.persistenceTail.then(work);
    this.persistenceTail = result.then(() => { this.persistencePending--; }, () => { this.persistencePending--; });
    return result;
  }

  /** RoomMgr actions are synchronous, but may have been queued before packet 31.
   * Keep idle entry synchronous; busy entry must finish after the transaction so
   * the fight timer cannot mutate a bag during its COMMIT-to-memory window. */
  runRoomEntry(work: () => void): void | Promise<void> {
    const enter = () => { if (this.isActive && !this.quitting) work(); };
    if (this.persistencePending === 0) return enter();
    return this.withPersistenceLock(async () => enter());
  }

  /** GamePlayer.SaveIntoDatabase (GamePlayer.cs:4450): player info + every saved bag's dirty/removed items. */
  async saveIntoDatabase(db: Database): Promise<void> {
    return this.withPersistenceLock(() => this.saveUnlocked(db));
  }

  private async saveUnlocked(db: Database): Promise<void> {
    await savePlayerInfo(db, this.info, this.match);
    for (const bag of this.allBags()) {
      // FightBag/TempBag contents stay temporary, but consumption of an existing
      // DB item must persist even after its source bag's earlier save.
      for (const it of bag.saveToDb ? bag.dirtyItems() : bag.removed) {
        it.UserID = it.IsExist ? this.id : it.UserID;
        await saveItem(db, it);
      }
      bag.removed.length = 0;
    }
    if (this.questInv) await saveQuests(db, this.questInv.takeDirty());
    await savePets(db, [...this.petBag.getPets(), ...this.petBag.removed]);
    this.petBag.removed.length = 0;
    if (this.petBag.eatDirty) { await saveEatPets(db, this.id, this.petBag.eat); this.petBag.eatDirty = false; }
    await saveCards(db, this.cardBag.all(), this.cardBag.removed);
    if (this.buffs.length) await saveBuffs(db, this.buffs);
    await saveRecords(db, this);
  }
}
