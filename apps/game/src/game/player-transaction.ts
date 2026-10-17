/** Atomic online profile/inventory mutation, shared by claims and Labyrinth.
 * Caller owns the player's persistence lock and packet/fight write barriers.
 * Profile, match, ordinary inventory and existing buff use-count decrements are
 * supported. Card additions/merges and existing-pet feeding require explicit opt-in. */
import { and, eq } from "drizzle-orm";
import { player, type Database } from "@ddt/db";
import type { GSPacket } from "@ddt/protocol";
import type { ServerContext } from "../session/context.js";
import { savePlayerInfo } from "../db/characters.js";
import { saveItem } from "../db/items.js";
import { saveCards, savePets } from "../db/pets-cards.js";
import type { BuffRow } from "../db/social.js";
import { mailItems } from "../handlers/items.js";
import { GamePlayer } from "./player.js";
import { ItemInfo } from "./item.js";
import { CardInventory, newCard, type UserCardRow } from "./cards.js";
import { PetInventory, type UserPetRow } from "./pets.js";
import * as Out from "../packets/out.js";

export class PlayerMutationCommittedError<T> extends Error {
  constructor(readonly value: T, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Committed player notification failed", { cause });
  }
}
class PlayerChanged extends Error {}
class PlayerMutationSkipped extends Error {}
const snapshot = (item: ItemInfo) => JSON.stringify(item.toRow());
const buffSnapshot = (b: BuffRow) => JSON.stringify([b.UserID,b.Type,b.Value,b.BeginDate,b.ValidDate,b.TemplateID,b.ValidCount,b.Data,b.IsExist]);
const cardSnapshot = (c: UserCardRow) => JSON.stringify([c.CardID,c.UserID,c.TemplateID,c.Place,c.Count,c.Attack,c.Defence,c.Agility,c.Luck,c.Guard,c.Damage,c.AttackReset,c.DefenceReset,c.AgilityReset,c.LuckReset,c.Level,c.CardGP,c.isFirstGet]);
const cardState = (p: GamePlayer) => JSON.stringify({ userId: p.cardBag.userId, capacity: p.cardBag.capacity, beginSlot: p.cardBag.beginSlot,
  cards: p.cardBag.cards.map(c => c && [cardSnapshot(c), c.dirty]), removed: p.cardBag.removed.map(c => [cardSnapshot(c), c.dirty]),
  changed: [...p.cardBag.changed], stats: p.cards });
const petSnapshot = (p: UserPetRow) => JSON.stringify([p.ID,p.TemplateID,p.Name,p.UserID,p.Attack,p.Defence,p.Luck,p.Agility,p.Blood,p.Damage,p.Guard,
  p.AttackGrow,p.DefenceGrow,p.LuckGrow,p.AgilityGrow,p.BloodGrow,p.DamageGrow,p.GuardGrow,p.Level,p.GP,p.MaxGP,p.Hunger,p.PetHappyStar,p.MP,
  p.IsEquip,p.Place,p.IsExit,p.Skill,p.SkillEquip,p.currentStarExp,p.breakGrade,p.breakAttack,p.breakDefence,p.breakAgility,p.breakLuck,p.breakBlood,p.eQPets,p.BaseProp]);
// Feeding may evolve an existing pet and restore essence stats; other pet operations keep their own owners.
const petFeedIdentity = (p: UserPetRow) => JSON.stringify([p.ID,p.UserID,p.Place,p.Name,p.Damage,p.Guard,p.DamageGrow,p.GuardGrow,p.PetHappyStar,
  p.MP,p.IsEquip,p.IsExit,p.currentStarExp,p.eQPets,p.BaseProp]);
const petState = (p: GamePlayer) => JSON.stringify({ capacity: p.petBag.capacity,
  pets: p.petBag.pets.map(pet => pet && [petSnapshot(pet), pet.dirty]), removed: p.petBag.removed.map(pet => [petSnapshot(pet), pet.dirty]),
  changed: [...p.petBag.changed], eat: p.petBag.eat, eatDirty: p.petBag.eatDirty, adopt: p.petBag.adopt, stats: p.pet });
// Quit may mark State=0 while waiting for this same persistence lock.
const profile = (p: GamePlayer) => JSON.stringify({ info: { ...p.info, State: 0 }, match: p.match });
const inventory = (p: GamePlayer) => p.allBags().map((bag) => ({ bag, capacity: bag.capacity,
  items: bag.getItems(), removed: [...bag.removed], dirty: bag.dirtyItems() }));

function stage(ctx: ServerContext, p: GamePlayer) {
  const sent: GSPacket[] = [], gradeUps: number[] = [];
  const staged = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "player-transaction-stage" },
    structuredClone(p.info), structuredClone(p.match), p.zoneId, p.zoneName, (g) => ctx.templates.levels.get(g) ?? 0);
  staged.statTables = p.statTables;
  const petBag = p.petBag, petRows = [...petBag.pets], removedPets = [...petBag.removed], statPet = p.pet;
  const petCopies = new Map([...petRows, ...removedPets].filter((pet): pet is UserPetRow => !!pet).map(pet => [pet, structuredClone(pet)]));
  const detachedPets = new PetInventory(petBag.capacity);
  petRows.forEach((pet, i) => { detachedPets.pets[i] = pet ? petCopies.get(pet)! : null; });
  detachedPets.removed.push(...removedPets.map(pet => petCopies.get(pet)!));
  for (const place of petBag.changed) detachedPets.changed.add(place);
  detachedPets.eat = structuredClone(petBag.eat); detachedPets.eatDirty = petBag.eatDirty;
  detachedPets.adopt = structuredClone(petBag.adopt);
  staged.petBag = detachedPets;
  staged.pet = statPet ? petCopies.get(statPet as UserPetRow) ?? structuredClone(statPet) : null;
  const detachedPet = staged.pet, petsBefore = petState(p);
  const cardBag = p.cardBag, cardRows = [...cardBag.cards], removedCards = [...cardBag.removed], statCards = p.cards, statCardRows = [...p.cards];
  const cardCopies = new Map([...cardRows, ...removedCards].filter((c): c is UserCardRow => !!c).map(c => [c, structuredClone(c)]));
  const detachedCards = new CardInventory(cardBag.userId, cardBag.capacity, cardBag.beginSlot);
  cardRows.forEach((c, i) => { detachedCards.cards[i] = c ? cardCopies.get(c)! : null; });
  detachedCards.removed.push(...removedCards.map(c => cardCopies.get(c)!));
  for (const place of cardBag.changed) detachedCards.changed.add(place);
  staged.cardBag = detachedCards;
  staged.cards = statCards.map(c => cardCopies.get(c as UserCardRow) ?? structuredClone(c));
  const cardsBefore = cardState(p), statCardsBefore = JSON.stringify(p.cards);
  const buffs = p.buffs.map((live) => ({ live, copy: structuredClone(live), before: buffSnapshot(live) }));
  staged.buffs = buffs.map((b) => b.copy);
  staged.gradeForGp = p.gradeForGp; staged.lang = p.lang;
  staged.onGradeUp = (old) => gradeUps.push(old);
  const bags = inventory(p), original = new Map<ItemInfo, { copy: ItemInfo; before: string; dirty: boolean; cellLocked: boolean; existed: boolean }>();
  const copy = (item: ItemInfo) => {
    let entry = original.get(item);
    if (!entry) {
      const clone = ItemInfo.fromRow({ ...structuredClone(item.toRow()), ItemID: item.ItemID }, item.template);
      clone.cellLocked = item.cellLocked;
      entry = { copy: clone, before: snapshot(item), dirty: item.isDirty, cellLocked: item.cellLocked, existed: item.IsExist }; original.set(item, entry);
    }
    return entry.copy;
  };
  for (const { bag, items, removed } of bags) {
    const target = staged.getInventory(bag.bagType)!;
    target.capacity = bag.capacity;
    for (const item of items) if (!target.addItemTo(copy(item), item.Place)) throw new PlayerChanged();
    target.removed.push(...removed.map(copy));
  }
  for (const [item, entry] of original) { Object.assign(entry.copy, structuredClone(item.toRow())); entry.copy.isDirty = entry.dirty; }
  // Loading equipped copies recalculates stats; use the exact live starting profile.
  staged.info = structuredClone(p.info); staged.match = structuredClone(p.match);
  staged.baseAttack = p.baseAttack; staged.baseDefence = p.baseDefence;
  sent.length = 0;
  return { staged, sent, gradeUps, original, bags, buffs, profileBefore: profile(p),
    cardBag, cardRows, removedCards, cardCopies, detachedCards, cardsBefore, statCards, statCardRows, statCardsBefore,
    petBag, petRows, removedPets, petCopies, detachedPets, statPet, detachedPet, petsBefore };
}

/** work executes under the SQL owner-row lock and receives only detached state.
 * Return null to roll back a rejected/replayed claim. Notifications
 * occur after publication; their failure carries the already committed value. */
export async function commitPlayerMutation<T>(ctx: ServerContext, p: GamePlayer,
  work: (db: Database, staged: GamePlayer, now: Date) => Promise<{ value: T; overflow?: ItemInfo[]; mailTitle?: string } | null>,
  options?: { cards?: boolean; petUpdates?: boolean }): Promise<T | null> {
  const committed = await ctx.db.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const [owner] = await tx.select({ id: player.Sys_Users_Detail.UserID }).from(player.Sys_Users_Detail)
      .where(eq(player.Sys_Users_Detail.UserID, p.id)).for("update");
    if (!owner) throw new Error("Player transaction recipient missing");
    const now = ctx.now(), plan = stage(ctx, p), { staged, original } = plan;
    const result = await work(db, staged, now);
    if (!result) throw new PlayerMutationSkipped();
    const pendingCards: UserCardRow[] = [], changedCards: number[] = [];
    if (staged.cardBag !== plan.detachedCards || JSON.stringify(staged.cards) !== plan.statCardsBefore ||
      (!options?.cards && cardState(staged) !== plan.cardsBefore)) throw new PlayerChanged("Cards are read-only without explicit opt-in");
    if (options?.cards) {
      const bag = staged.cardBag;
      if (bag.userId !== p.id || bag.capacity !== 100 || bag.beginSlot !== 5 || bag.cards.length !== bag.capacity ||
        bag.capacity !== plan.cardBag.capacity || bag.beginSlot !== plan.cardBag.beginSlot ||
        bag.removed.length !== plan.removedCards.length || bag.removed.some((c, i) => c !== plan.cardCopies.get(plan.removedCards[i]!) ||
          cardSnapshot(c) !== cardSnapshot(plan.removedCards[i]!) || c.dirty !== plan.removedCards[i]!.dirty))
        throw new PlayerChanged("Card inventory structure is outside the add/merge contract");
      const cardIds = new Set<number>();
      for (let place = 0; place < bag.capacity; place++) {
        const c = bag.cards[place], old = plan.cardRows[place];
        if (old) {
          if (c !== plan.cardCopies.get(old) || !c || cardSnapshot({ ...c, Count: old.Count }) !== cardSnapshot(old) || c.Count < old.Count ||
            (c.Count === old.Count && c.dirty !== old.dirty))
            throw new PlayerChanged("Only in-place card count increases are supported");
          if (c.Count !== old.Count) changedCards.push(place);
        } else if (c) {
          if (place < bag.beginSlot || cardSnapshot(c) !== cardSnapshot({ ...newCard(p.id, c.TemplateID, c.Count), Place: place }))
            throw new PlayerChanged("Invalid new card row");
          changedCards.push(place);
        }
        if (!c) continue;
        if (c.UserID !== p.id || c.Place !== place || !Number.isSafeInteger(c.CardID) || c.CardID < 0 ||
          !Number.isSafeInteger(c.TemplateID) || c.TemplateID <= 0 || c.TemplateID > 2_147_483_647 ||
          !Number.isSafeInteger(c.Count) || c.Count > 2_147_483_647 || (changedCards.includes(place) && (c.Count <= 0 || place < bag.beginSlot)) ||
          (c.CardID > 0 && cardIds.has(c.CardID))) throw new PlayerChanged("Invalid card identity or count");
        if (c.CardID > 0) cardIds.add(c.CardID);
        if (changedCards.includes(place)) c.dirty = true;
        if (c.dirty) pendingCards.push(c);
      }
      const allowedPlaces = new Set([...plan.cardBag.changed, ...changedCards]);
      if ([...bag.changed].some(place => !allowedPlaces.has(place)) || [...plan.cardBag.changed].some(place => !bag.changed.has(place)))
        throw new PlayerChanged("Invalid card change notification");
      for (const place of changedCards) bag.changed.add(place);
      // New slots also need a complete owner snapshot: an unloaded SQL card
      // must not be duplicated by an apparently empty in-memory slot/template.
      const storedCards = await tx.select().from(player.Sys_Users_Card).where(eq(player.Sys_Users_Card.UserID, p.id)).for("update");
      const oldCards = new Map(plan.cardRows.filter((c): c is UserCardRow => !!c && c.CardID > 0).map(c => [c.CardID, c]));
      if (storedCards.length !== oldCards.size || storedCards.some(c => !oldCards.has(c.CardID) || cardSnapshot(c) !== cardSnapshot(oldCards.get(c.CardID)!)))
        throw new PlayerChanged("Player card changed before mutation");
      await saveCards(db, pendingCards, []);
    }
    const pendingPets: UserPetRow[] = [], changedPets: number[] = [];
    if (staged.petBag !== plan.detachedPets || (!options?.petUpdates && petState(staged) !== plan.petsBefore))
      throw new PlayerChanged("Pets are read-only without explicit opt-in");
    if (options?.petUpdates) {
      const bag = staged.petBag;
      if (bag.capacity !== plan.petBag.capacity || bag.pets.length !== plan.petRows.length ||
          bag.removed.length !== plan.removedPets.length || bag.removed.some((pet, i) => pet !== plan.petCopies.get(plan.removedPets[i]!) ||
            petSnapshot(pet) !== petSnapshot(plan.removedPets[i]!) || pet.dirty !== plan.removedPets[i]!.dirty) ||
          JSON.stringify(bag.eat) !== JSON.stringify(plan.petBag.eat) || bag.eatDirty !== plan.petBag.eatDirty ||
          JSON.stringify(bag.adopt) !== JSON.stringify(plan.petBag.adopt) ||
          (!plan.petCopies.has(plan.statPet as UserPetRow) && JSON.stringify(plan.detachedPet) !== JSON.stringify(plan.statPet)) ||
          (staged.pet !== plan.detachedPet && staged.pet !== bag.equipped()))
        throw new PlayerChanged("Pet inventory structure is outside the feeding contract");
      const ids = new Set<number>();
      for (let place = 0; place < bag.capacity; place++) {
        const pet = bag.pets[place], old = plan.petRows[place];
        if (!old) { if (pet) throw new PlayerChanged("Pet additions are outside the feeding contract"); continue; }
        if (!pet || pet !== plan.petCopies.get(old) || petFeedIdentity(pet) !== petFeedIdentity(old))
          throw new PlayerChanged("Only existing pet feeding is supported");
        if (petSnapshot(pet) === petSnapshot(old)) {
          if (pet.dirty !== old.dirty && pet.dirty !== true) throw new PlayerChanged("Invalid pet dirty state");
          // Essence can succeed without changing a stat. Keep its dirty target
          // (and already pending online progress) in the same atomic save.
          if (!pet.dirty) continue;
        }
        if (!Number.isSafeInteger(pet.ID) || pet.ID <= 0 || ids.has(pet.ID) || pet.UserID !== p.id || pet.Place !== place || !pet.IsExit)
          throw new PlayerChanged("Invalid existing pet identity");
        ids.add(pet.ID);
        changedPets.push(place); pet.dirty = true; pendingPets.push(pet);
      }
      const allowedPlaces = new Set([...plan.petBag.changed, ...changedPets]);
      if ([...bag.changed].some(place => !allowedPlaces.has(place)) || [...plan.petBag.changed].some(place => !bag.changed.has(place)))
        throw new PlayerChanged("Invalid pet change notification");
      for (const place of changedPets) bag.changed.add(place);
      for (const pet of [...pendingPets].sort((a, b) => a.ID - b.ID)) {
        const old = plan.petRows[pet.Place]!;
        const [stored] = await tx.select().from(player.Sys_Users_Pet).where(eq(player.Sys_Users_Pet.ID, pet.ID)).for("update");
        // Dirty online hunger/progress is authoritative, as with ordinary item mutations.
        if (!stored || stored.UserID !== p.id || stored.Place !== old.Place || !stored.IsExit ||
            (!old.dirty && petSnapshot({ ...stored, Name: stored.Name ?? "", Skill: stored.Skill ?? "", SkillEquip: stored.SkillEquip ?? "" }) !== petSnapshot(old)))
          throw new PlayerChanged("Player pet changed before feeding");
      }
      await savePets(db, pendingPets);
    }
    // Buff grants, expiry changes and removal retain their existing owners.
    // A consumable may only spend an existing buff's remaining use count.
    if (staged.buffs.length !== plan.buffs.length || staged.buffs.some((b, i) => b !== plan.buffs[i]!.copy ||
      buffSnapshot({ ...b, ValidCount: plan.buffs[i]!.live.ValidCount }) !== plan.buffs[i]!.before))
      throw new PlayerChanged("Buff mutation is outside the player mutation contract");
    const buffChanges = plan.buffs.filter((b) => buffSnapshot(b.copy) !== b.before);
    for (const b of buffChanges) {
      if (b.copy.UserID !== p.id || !Number.isSafeInteger(b.copy.ValidCount) || b.copy.ValidCount < 0 ||
        !Number.isSafeInteger(b.live.ValidCount) || b.live.ValidCount > 2_147_483_647 || b.copy.ValidCount > b.live.ValidCount)
        throw new PlayerChanged("Invalid buff use count");
      const where = and(eq(player.User_Buff.UserID, p.id), eq(player.User_Buff.Type, b.copy.Type));
      const [stored] = await tx.select().from(player.User_Buff).where(where).for("update");
      if (!stored || buffSnapshot(stored) !== b.before) throw new PlayerChanged("Player buff changed before consumption");
      await tx.update(player.User_Buff).set({ ValidCount: b.copy.ValidCount }).where(where);
    }
    if (staged.allBags().some((bag, i) => bag.capacity !== plan.bags[i]!.capacity)) throw new PlayerChanged("Inventory capacity is outside the player mutation contract");
    const byCopy = new Map([...original.values()].map((old) => [old.copy, old]));
    const changed = new Set(staged.allBags().flatMap((b) => b.getItems()).filter((item) => {
      const old = byCopy.get(item);
      return !old || snapshot(item) !== old.before;
    }));
    // Fight/Temp bags are transient, but tombstones of persisted items are not.
    const pending = [...new Set(staged.allBags().flatMap((b) => b.saveToDb ? b.dirtyItems() : b.removed))];
    const ids = new Set<number>();
    for (const item of pending) {
      if (item.ItemID > 0) {
        if (ids.has(item.ItemID)) throw new PlayerChanged();
        ids.add(item.ItemID);
        const [stored] = await tx.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, item.ItemID)).for("update");
        const old = byCopy.get(item);
        if (!stored || stored.UserID !== p.id || stored.TemplateID !== item.TemplateID || !old || (old.existed && !stored.IsExist) ||
            (!old.dirty && !plan.bags.some((b) => b.dirty.some((it) => original.get(it) === old)) && snapshot(ItemInfo.fromRow(stored, item.template)) !== old.before)) throw new PlayerChanged();
      }
      await saveItem(db, item);
    }
    await savePlayerInfo(db, staged.info, staged.match);
    if (result.overflow?.length) await mailItems({ ...ctx, db: { ...ctx.db, db } }, staged, result.overflow, result.mailTitle ?? "活动奖励", 12);
    const current = inventory(p);
    if (profile(p) !== plan.profileBefore || p.petBag !== plan.petBag || p.pet !== plan.statPet || petState(p) !== plan.petsBefore ||
        plan.petRows.some((pet, i) => p.petBag.pets[i] !== pet) || plan.removedPets.some((pet, i) => p.petBag.removed[i] !== pet) ||
        p.cardBag !== plan.cardBag || p.cards !== plan.statCards || cardState(p) !== plan.cardsBefore ||
        plan.cardRows.some((c, i) => p.cardBag.cards[i] !== c) || plan.removedCards.some((c, i) => p.cardBag.removed[i] !== c) ||
        p.cards.some((c, i) => c !== plan.statCardRows[i]) || p.buffs.length !== plan.buffs.length ||
        plan.buffs.some((b, i) => p.buffs[i] !== b.live || buffSnapshot(b.live) !== b.before) ||
        [...original].some(([item, old]) => snapshot(item) !== old.before || item.isDirty !== old.dirty || item.cellLocked !== old.cellLocked) ||
        current.some((b, i) => b.capacity !== plan.bags[i]!.capacity || ["items", "removed", "dirty"].some((key) => {
          const field = key as "items" | "removed" | "dirty", old = plan.bags[i]![field];
          return b[field].length !== old.length || b[field].some((item, n) => item !== old[n]);
        }))) throw new PlayerChanged("Player transaction recipient changed before commit");
    return { ...plan, pending, changed, buffChanges, pendingCards, changedCards, pendingPets, changedPets, value: result.value };
  }).catch((error: unknown) => { if (error instanceof PlayerMutationSkipped) return null; throw error; });
  if (!committed) return null;
  const { staged, original, pending } = committed;
  const real = new Map([...original].map(([item, old]) => [old.copy, item]));
  const bags = p.allBags(); bags.forEach((bag) => bag.beginChanges());
  // Remove using the OLD slot/row before assigning consumed Place=-1. This also
  // frees a slot reused by a reward in the same transaction.
  for (const { bag, items } of committed.bags) {
    const after = staged.getInventory(bag.bagType)!;
    for (const item of items) {
      const copy = original.get(item)!.copy;
      if (after.getItemAt(item.Place) !== copy) bag.takeOutItem(item);
    }
  }
  for (const [item, old] of original) {
    Object.assign(item, old.copy.toRow()); item.isDirty = old.copy.isDirty;
  }
  for (const bag of staged.allBags()) {
    const target = p.getInventory(bag.bagType)!;
    for (const item of bag.getItems()) {
      const existing = real.get(item), live = existing ?? item;
      if (target.getItemAt(item.Place) !== live) target.addItemTo(live, item.Place);
      else if (committed.changed.has(item)) target.updateItem(live);
      // add/update marks dirty; the committed rows are already saved.
      if (pending.includes(item)) live.isDirty = false;
    }
    for (let i = target.removed.length - 1; i >= 0; i--) if (pending.some((item) => (real.get(item) ?? item) === target.removed[i])) target.removed.splice(i, 1);
  }
  for (const item of pending) { const existing = real.get(item); if (existing) existing.isDirty = false; }
  const state = p.info.State;
  Object.assign(p.info, staged.info); p.info.State = state;
  Object.assign(p.match, staged.match);
  p.baseAttack = staged.baseAttack; p.baseDefence = staged.baseDefence;
  for (const b of committed.buffChanges) b.live.ValidCount = b.copy.ValidCount;
  for (const c of committed.pendingCards) {
    const live = committed.cardRows[c.Place];
    if (live) Object.assign(live, c);
    else p.cardBag.cards[c.Place] = c;
  }
  for (const place of committed.changedCards) p.cardBag.changed.add(place);
  for (const pet of committed.pendingPets) Object.assign(committed.petRows[pet.Place]!, pet);
  for (const place of committed.changedPets) p.petBag.changed.add(place);
  if (committed.pendingPets.length) p.pet = p.petBag.equipped();
  // Finish ALL memory publication before any transport callback can fail.
  let notificationError: unknown;
  const notify = (fn: () => void) => { try { fn(); } catch (error) { notificationError ??= error; } };
  for (const old of committed.gradeUps) {
    notify(() => { p.questInv?.refresh(); }); notify(() => { p.onGradeUp?.(old); });
  }
  for (const bag of bags) notify(() => bag.commitChanges());
  if (committed.pendingCards.length) notify(() => p.flushCards());
  if (committed.pendingPets.length) notify(() => p.flushPets());
  if ((committed.gradeUps.length || committed.pendingPets.length) && p.showPP) notify(() => p.send(Out.playerProperty(p.id)));
  notify(() => p.updateProperties());
  if (committed.sent.some((pkt) => pkt.code === 117)) notify(() => p.send(Out.mailResponse(p.id, 1)));
  if (notificationError) throw new PlayerMutationCommittedError(committed.value, notificationError);
  return committed.value;
}
