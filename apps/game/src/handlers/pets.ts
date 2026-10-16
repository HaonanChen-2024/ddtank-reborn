/**
 * 68 PET (PetHandler.cs → PetLogicProcessor, byte sub = PetPackageType; Game.Server/Pet/Handle/*.cs) and 216 CARDS_DATA
 * (CardDataHandler.cs). Logic in game/pets.ts and game/cards.ts; 68/1 and 216 replies via GamePlayer.flushPets/flushCards.
 */
import { GSPacket } from "@ddt/protocol";
import type { GamePlayer } from "../game/player.js";
import type { ServerContext } from "../session/context.js";
import {
  cfgNum, createPet, feedPet, reduceProp, createAdoptList, petRisingStar, eatPetsUpgrade, hungBuCacCho, moeNeedExp,
} from "../game/pets.js";
import { moveOrEquipCard, upgradeCard, type CardUpdateRowFull } from "../game/cards.js";
import { loadUserPets } from "../db/pets-cards.js";
import { ItemInfo } from "../game/item.js";
import { mailItems } from "./items.js";
import * as Out from "../packets/out.js";
import type { HandlerRegistry } from "./registry.js";

/** PetInventory.MaxLevelByGrade = min(player level, Pet_Config MaxLevel). */
export function petMaxLevelByGrade(ctx: ServerContext, p: GamePlayer): number {
  return Math.min(p.info.Grade, cfgNum(ctx.templates.pets, "MaxLevel", 50));
}

function petsChanged(p: GamePlayer, stats: boolean): void {
  p.pet = p.petBag.equipped();
  p.flushPets();
  if (stats) p.updatePlayerProperties();
}

/** MoneyDirect(cost, false, false): bound-first Money check-and-remove; false when unaffordable (nothing removed). */
function tryRemoveMoney(p: GamePlayer, cost: number): boolean {
  if (p.info.Money + p.info.MoneyLock < cost) return false;
  p.removeMoney(cost);
  return true;
}

export async function petCommand(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const t = ctx.lang.t.bind(ctx.lang);
  const T = ctx.templates.pets;
  const sub = pkt.readByte();
  ctx.log.debug(`pet ${p.id} sub ${sub}`);
  // PetHandler.HandlePacket: grade < 25 (Pet_Config LimitGrade) → "not open"
  if (p.info.Grade < cfgNum(T, "LimitGrade", 25)) return p.sendMessage(0, t("PetHandler.Msg23"));
  const bag = p.petBag;
  switch (sub) {
    case 1: {
      // UpdatePet: int userId — online bag or Sys_Users_Pet
      const uid = pkt.readInt();
      const other = uid === p.id ? p : ctx.world.get(uid);
      const pets = other ? other.petBag.getPets() : await loadUserPets(ctx.db.db, uid);
      const slots = pets.map((pet) => ({ place: pet.Place, pet: { ...pet, PetHappyStarReduce: (v: number) => reduceProp(pet, v) } }));
      p.send(Out.updateUserPet(uid, p.zoneId, slots, other?.petBag.eat ?? { weaponLevel: 0, clothesLevel: 0, hatLevel: 0 }));
      return;
    }
    case 2: {
      // AddPet: int place, int bagType — hatch an egg (template = item Property5)
      const place = pkt.readInt();
      const bagType = pkt.readInt();
      const slot = bag.findFirstEmptySlot();
      if (slot === -1) return p.sendMessage(0, t("PetHandler.Msg3"));
      const inv = p.getInventory(bagType);
      const it = inv?.getItemAt(place) ?? null;
      const info = it ? T.templates.get(it.template.Property5) : undefined;
      if (!inv || !it || !info) return p.sendMessage(0, t("PetHandler.Msg4"));
      const pet = createPet(T, info, p.id, slot, petMaxLevelByGrade(ctx, p), p.info.VIPLevel);
      pet.BaseProp = JSON.stringify({ ...pet, dirty: undefined });
      if (!inv.removeCountFromStack(it, 1)) return;
      bag.addPetTo(pet, slot);
      if (info.StarLevel > 4) {
        const msg = t("PetHandler.Msg5", p.info.NickName, info.Name, info.StarLevel);
        for (const o of ctx.world.all()) o.sendMessage(0, msg);
      } else p.sendMessage(0, t("PetHandler.Msg6", info.Name, info.StarLevel));
      p.flushPets();
      p.send(Out.petAdded(info.TemplateID));
      void p.saveIntoDatabase(ctx.db.db).catch((e) => ctx.log.warn(`pet save: ${e}`));
      return;
    }
    case 4: {
      // FeedPet: int itemPlace, int bagType, int petPlace. Fixed: the original always consumed from the StoreBag.
      const itemPlace = pkt.readInt();
      const inv = p.getInventory(pkt.readInt());
      const pet = bag.getPetAt(pkt.readInt());
      const it = inv?.getItemAt(itemPlace) ?? null;
      if (!inv || !it) return p.sendMessage(0, t("PetHandler.Msg9"));
      if (!pet) return;
      const r = feedPet(T, pet, {
        TemplateID: it.TemplateID, Count: it.Count, Property1: it.template.Property1, Property2: it.template.Property2,
        DefendCompose: it.DefendCompose, holes: [it.Hole1, it.Hole2, it.Hole3, it.Hole4, it.Hole5], Blood: (it as unknown as { Blood?: number }).Blood ?? 0,
      }, petMaxLevelByGrade(ctx, p), p.info.VIPLevel);
      if (r.consume > 0) {
        if (it.TemplateID === 334100) inv.removeItem(it);
        else inv.removeCountFromStack(it, Math.min(r.consume, it.Count));
      }
      if (r.ok) bag.changed.add(pet.Place);
      petsChanged(p, r.ok);
      if (r.msg) p.sendMessage(0, t(...r.msg));
      return;
    }
    case 7: {
      // EquipSkillPet: int place, int skillId, int slot (slot 4 needs VIP 7)
      const place = pkt.readInt(), skillId = pkt.readInt(), slot = pkt.readInt();
      if (slot === 4 && p.info.VIPLevel < 7) return p.sendMessage(0, t("PetHandler.Msg181"));
      const r = bag.equipSkill(place, skillId, slot);
      if (r.msg) p.sendMessage(0, t(r.msg));
      petsChanged(p, false);
      return;
    }
    case 8: {
      // ReleasePet: int place — WashGetCount × 12656 by mail (not ported: no item mail helper here → bag)
      const pet = bag.getPetAt(pkt.readInt());
      if (!pet || !bag.removePet(pet)) return;
      const info = T.templates.get(pet.TemplateID);
      const wash = info?.WashGetCount ?? 0;
      const tpl = wash > 0 ? ctx.templates.findItem(12656) : undefined;
      if (tpl) {
        const { ItemInfo } = await import("../game/item.js");
        const item = ItemInfo.createFromTemplate(tpl, wash, 105, ctx.now());
        item.IsBinds = true;
        if (!p.getItemInventory(tpl)?.addTemplate(item, wash)) p.tempBag.addTemplate(item, wash);
      }
      p.sendMessage(0, t("PetHandler.Msg19"));
      petsChanged(p, pet.IsEquip);
      p.updatePlayerProperties();
      return;
    }
    case 9: {
      // RenamePet: int place, str name — Pet_Config ChangeNameCost Money (MoneyDirect)
      const place = pkt.readInt();
      const name = pkt.readString().trim().slice(0, 32);
      const cost = cfgNum(T, "ChangeNameCost", 1900);
      if (!name || !bag.getPetAt(place)) return;
      if (p.info.Money + p.info.MoneyLock < cost) return p.sendMessage(0, t("UserBuyItemHandler.Money"));
      p.removeMoney(cost);
      bag.renamePet(place, name);
      p.sendMessage(0, t("PetHandler.Msg20"));
      petsChanged(p, false);
      return;
    }
    case 17: {
      // FightPet: int place, bool equip — battle pet (level must fit the player cap, hunger > 0)
      const place = pkt.readInt();
      const equip = pkt.readBoolean();
      const pet = bag.getPetAt(place);
      if (!pet) return;
      if (pet.Level > petMaxLevelByGrade(ctx, p) && !pet.IsEquip) return p.sendMessage(0, t("PetHandler.Msg21"));
      if (!bag.equipPet(place, equip)) return p.sendMessage(0, t("PetHandler.Msg22"));
      petsChanged(p, true);
      return;
    }
    case 5: {
      // RefereshPet.cs: bool refreshBtn (+ an unread 2nd bool from the client). false = just re-show the current
      // offer; true = reroll (AdoptRefereshCost Money, or 1 FreeRefereshID item instead — no PetScore then).
      const refreshBtn = pkt.readBoolean();
      if (refreshBtn) {
        const cost = cfgNum(T, "AdoptRefereshCost", 190);
        const freeId = cfgNum(T, "FreeRefereshID", 0);
        const freeItem = freeId > 0 ? p.propBag.getItemByTemplateID(0, freeId) : null;
        let addScore = true;
        if (freeItem) { p.propBag.removeCountFromStack(freeItem, 1); addScore = false; }
        else if (!tryRemoveMoney(p, cost)) return;
        if (addScore) p.addPetScore(Math.trunc(cost * 0.1));
        bag.adopt = createAdoptList(T, () => ctx.templates.petAdoptPick(), p.id, petMaxLevelByGrade(ctx, p), p.info.VIPLevel);
      }
      const reply = Out.refreshPet(bag.adopt, refreshBtn);
      if (reply) p.send(reply);
      return;
    }
    case 6: {
      // AdoptPet.cs: int place in the current adopt offer -> moved into the first empty pet slot.
      const place = pkt.readInt();
      const slot = bag.findFirstEmptySlot();
      if (slot === -1) { p.sendMessage(0, "宠物数量已达上限！"); return; }
      if (place < 0 || place >= bag.adopt.length) { p.sendMessage(0, "未找到宠物！"); return; }
      const picked = bag.adopt[place];
      if (!picked) return;
      if (bag.addPetTo(picked, slot)) {
        const info = T.templates.get(picked.TemplateID);
        if (info && (info.StarLevel > 3 || info.KindID >= 5)) {
          const msg = `[${p.zoneName}]玩家[${p.info.NickName}]幸运地捕获了${info.StarLevel}星宠物${info.Name}。`;
          for (const o of ctx.world.all()) o.sendMessage(0, msg);
        } else p.sendMessage(0, "捕获成功。");
      }
      bag.adopt = [];
      p.flushPets();
      void p.saveIntoDatabase(ctx.db.db).catch((e) => ctx.log.warn(`pet adopt save: ${e}`));
      return;
    }
    case 18: {
      // RevertPet.cs ("wash"/revert to the pet's hatched stats): RecycleCost Money; grow/break/skills reset to
      // BaseProp (the row saved at hatch time), gear removed (returned bound), and the player gets a 334100
      // "pet essence" item carrying the washed-away GP/MaxGP/break stats (same essence FeedPet consumes).
      const place = pkt.readInt();
      const cost = cfgNum(T, "RecycleCost", 10000);
      if (!tryRemoveMoney(p, cost)) return;
      const pet = bag.getPetAt(place);
      if (!pet) return;
      let base: Partial<typeof pet> | null = null;
      try { base = JSON.parse(pet.BaseProp || "null"); } catch { base = null; }
      if (!base) { p.sendMessage(0, t("PetHandler.Msg7")); return; }
      const essenceTpl = ctx.templates.findItem(334100);
      if (essenceTpl) {
        const essence = ItemInfo.createFromTemplate(essenceTpl, 1, 102, ctx.now());
        essence.IsBinds = true;
        essence.DefendCompose = pet.GP; essence.AgilityCompose = pet.MaxGP;
        essence.Hole1 = pet.breakGrade; essence.Hole2 = pet.breakAttack; essence.Hole3 = pet.breakDefence;
        essence.Hole4 = pet.breakAgility; essence.Hole5 = pet.breakLuck; essence.Blood = pet.breakBlood;
        if (!p.propBag.addTemplate(essence, 1)) await mailItems(ctx, p, [essence], undefined, 7);
      }
      pet.breakGrade = base.breakGrade ?? 0; pet.breakAttack = base.breakAttack ?? 0; pet.breakDefence = base.breakDefence ?? 0;
      pet.breakAgility = base.breakAgility ?? 0; pet.breakLuck = base.breakLuck ?? 0; pet.breakBlood = base.breakBlood ?? 0;
      pet.Attack = base.Attack ?? pet.Attack; pet.Defence = base.Defence ?? pet.Defence; pet.Agility = base.Agility ?? pet.Agility;
      pet.Luck = base.Luck ?? pet.Luck; pet.Blood = base.Blood ?? pet.Blood;
      pet.AttackGrow = base.AttackGrow ?? pet.AttackGrow; pet.DefenceGrow = base.DefenceGrow ?? pet.DefenceGrow;
      pet.AgilityGrow = base.AgilityGrow ?? pet.AgilityGrow; pet.LuckGrow = base.LuckGrow ?? pet.LuckGrow; pet.BloodGrow = base.BloodGrow ?? pet.BloodGrow;
      pet.TemplateID = base.TemplateID ?? pet.TemplateID; pet.Skill = base.Skill ?? pet.Skill; pet.SkillEquip = base.SkillEquip ?? pet.SkillEquip;
      pet.GP = 0; pet.Level = 1; pet.MaxGP = 55;
      for (const eq of [0, 1, 2]) {
        const removed = bag.removeEqPet(place, eq);
        if (removed) {
          const gt = ctx.templates.findItem(removed.eqTemplateID);
          if (gt) {
            const item = ItemInfo.createFromTemplate(gt, 1, 105, ctx.now());
            item.IsBinds = true; item.IsUsed = true; item.ValidDate = removed.ValidDate; item.BeginDate = removed.startTime;
            if (!p.getItemInventory(gt)?.addTemplate(item, 1)) await mailItems(ctx, p, [item]);
          }
        }
      }
      bag.changed.add(place);
      p.sendMessage(0, t("PetHandler.Msg8"));
      petsChanged(p, pet.IsEquip);
      void p.saveIntoDatabase(ctx.db.db).catch((e) => ctx.log.warn(`pet revert save: ${e}`));
      return;
    }
    case 20: {
      // AddPetEquip.cs: int bagType, int slot, int place (pet). The item itself must be pet gear (cat. 50/51/52).
      const bagType = pkt.readInt();
      const slot = pkt.readInt();
      const place = pkt.readInt();
      const inv = p.getInventory(bagType);
      const item = inv?.getItemAt(slot);
      const pet = bag.getPetAt(place);
      if (!item || !pet || ![50, 51, 52].includes(item.template.CategoryID)) return p.sendMessage(0, t("AddPetEquip.WrongItem"));
      if (pet.Level < item.template.Property2) return p.sendMessage(0, t("AddPetEquip.WrongLevel"));
      const eqType = item.template.CategoryID === 51 ? 1 : item.template.CategoryID === 52 ? 2 : 0;
      if (!bag.addEqPet(place, eqType, item.TemplateID, item.ValidDate, item.IsUsed ? item.BeginDate : ctx.now())) return;
      inv!.takeOutItem(item);
      bag.changed.add(place);
      petsChanged(p, true);
      p.sendMessage(0, "宠物装备穿戴成功！");
      return;
    }
    case 21: {
      // DelPetEquip.cs: int petPlace, int eqType.
      const place = pkt.readInt();
      const eqType = pkt.readInt();
      const removed = bag.removeEqPet(place, eqType);
      if (!removed) return;
      const gt = ctx.templates.findItem(removed.eqTemplateID);
      if (gt) {
        const item = ItemInfo.createFromTemplate(gt, 1, 105, ctx.now());
        item.IsBinds = true; item.IsUsed = true; item.ValidDate = removed.ValidDate; item.BeginDate = removed.startTime;
        if (!p.getItemInventory(gt)?.addTemplate(item, 1)) await mailItems(ctx, p, [item]);
      }
      bag.changed.add(place);
      petsChanged(p, true);
      return;
    }
    case 22: {
      // PetRisingStar.cs: int templateId (rising-star item, 11162), int count, int petPlace.
      const templateId = pkt.readInt();
      const count = pkt.readInt();
      const petPlace = pkt.readInt();
      const pet = bag.getPetAt(petPlace);
      if (!pet) return p.sendMessage(0, t("PetRisingStar.PetNotFound"));
      const found = p.propBag.getItemByTemplateID(0, templateId);
      if (!found || found.TemplateID !== 11162) { p.sendMessage(0, t("PetRisingStar.ItemNotFound")); p.send(Out.petRisingStarReply(false)); return; }
      const r = petRisingStar(T, pet, found.template.Property2, Math.min(count, found.Count), petMaxLevelByGrade(ctx, p), p.info.VIPLevel);
      if (!r) { p.sendMessage(0, t("PetRisingStar.UnSupport")); p.send(Out.petRisingStarReply(false)); return; }
      if (r.consumed > 0) p.propBag.removeCountFromStack(found, r.consumed);
      bag.changed.add(petPlace);
      petsChanged(p, pet.IsEquip);
      p.send(Out.petRisingStarReply(r.success));
      return;
    }
    case 23: {
      // PetEvolution.cs: item 11163 (templateId), count -> player.evolutionGrade/Exp (Pet_Fight_Property tiers).
      const templateId = pkt.readInt();
      let count = pkt.readInt();
      if (templateId !== 11163) return;
      const food = p.propBag.getItemByTemplateID(0, templateId);
      if (!food || count <= 0) return;
      if (food.Count < count) count = food.Count;
      const exp = food.template.Property2 * count;
      if (exp <= 0) return;
      const total = (p.info.evolutionExp ?? 0) + exp;
      let leveledUp = false;
      let grade = p.info.evolutionGrade ?? 0;
      const maxLv = ctx.templates.petFightMax; // PetMgr.GetEvolutionMax = Pet_Fight_Property row count
      for (let i = grade; i <= maxLv; i++) {
        const f = ctx.templates.stats.petFight(i + 1);
        if (f && f.Exp <= total) { grade = i + 1; leveledUp = true; }
      }
      p.info.evolutionGrade = grade;
      p.info.evolutionExp = total;
      p.propBag.removeCountFromStack(food, count);
      p.updatePlayerProperties();
      p.send(Out.petEvolutionReply(leveledUp));
      return;
    }
    case 33: {
      // EatPet.cs: int amor (0 weapon/1 clothes/2 hat), int type (1 = sacrifice pets, else item 201567).
      const amor = pkt.readInt() as 0 | 1 | 2;
      const type = pkt.readInt();
      const eat = bag.eat;
      const blocked = hungBuCacCho(eat.weaponLevel, eat.clothesLevel, eat.hatLevel);
      const names = ["衣服或帽子", "武器和帽子", "武器和衣服"] as const;
      if (([eat.weaponLevel, eat.clothesLevel, eat.hatLevel][amor]) === blocked) {
        return p.sendMessage(0, `请先升级${names[amor]}！`);
      }
      if (type === 1) {
        const count = pkt.readInt();
        let totalPoint = 0;
        for (let i = 0; i < count; i++) {
          const slot = pkt.readInt();
          const tplId = pkt.readInt();
          const petAt = bag.getPetAt(slot);
          if (petAt) {
            const info = T.templates.get(tplId);
            if (info) totalPoint += Math.trunc(10 ** (info.StarLevel - 2) + 5 * Math.max(petAt.Level - 8, petAt.Level * 0.2));
          }
          if (petAt && bag.removePet(petAt)) eatPetsUpgrade(T, eat, amor, totalPoint);
        }
      } else {
        const count = pkt.readInt();
        const eatItemId = 201567;
        const info2 = p.propBag.getItemByTemplateID(0, eatItemId);
        if (!info2) return p.sendMessage(0, "强化石不足！");
        let totalPoint = count * info2.template.Property2;
        const need = moeNeedExp(T, [eat.weaponExp, eat.clothesExp, eat.hatExp][amor]!, [eat.weaponLevel, eat.clothesLevel, eat.hatLevel][amor]!);
        let realCount = count;
        if (totalPoint > need && info2.template.Property2 > 0) { realCount = Math.ceil(need / info2.template.Property2); totalPoint = info2.template.Property2; }
        if (!p.propBag.removeCountFromStack(info2, realCount)) return p.sendMessage(0, "强化石不足！");
        eatPetsUpgrade(T, eat, amor, totalPoint);
      }
      bag.eatDirty = true;
      p.send(Out.eatPetsInfo(eat));
      p.updatePlayerProperties();
      return;
    }
    default:
      // Confirmed dead in the original (no Handle class carries this PetPackageType, PetHandleMgr logs
      // "LoadCommandHandler" and drops the packet): 16 PAY_SKILL, 24 PET_FORMINFO, 25 PET_FOLLOW, 32 PET_WAKE.
      ctx.log.debug(`pet sub ${sub} not ported`);
  }
}

/** CardDataHandler (216): int cmd — 0 move/equip/unequip, 1 open vice slot, 2 open card box, 3 upgrade, 4 sort (no-op). */
export function cardCommand(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): void {
  const bag = p.cardBag;
  const cmd = pkt.readInt();
  let stats = false;
  switch (cmd) {
    case 0: {
      const r = moveOrEquipCard(bag, pkt.readInt(), pkt.readInt());
      stats = r.changedStats;
      if (r.msg) p.sendMessage(0, r.msg);
      break;
    }
    case 1: {
      // open a vice slot: placeholder card 314101 with Count −1 (CardDataHandler case 1)
      const place = pkt.readInt();
      if (place < 0 || place >= 5 || bag.getItemAt(place)) break;
      bag.addCardTo({ CardID: 0, UserID: p.id, TemplateID: 314101, Place: place, Count: -1, Attack: 0, Defence: 0, Agility: 0, Luck: 0, Guard: 0, Damage: 0, AttackReset: 0, DefenceReset: 0, AgilityReset: 0, LuckReset: 0, Level: 0, CardGP: 0, isFirstGet: true }, place);
      break;
    }
    case 2: {
      // open a card box (EquipBag slot): Property5 = card template (category 26); count + rand(1,3) per box
      const slot = pkt.readInt();
      const count = pkt.readInt();
      const it = p.equipBag.getItemAt(slot);
      const card = it ? ctx.templates.findItem(it.template.Property5) : undefined;
      if (!it || count <= 0 || count > it.Count || !card || card.CategoryID !== 26) {
        p.sendMessage(0, "A carta não existe.");
        return;
      }
      const n = it.Count;
      if (!p.equipBag.removeCountFromStack(it, n)) return;
      let total = n;
      for (let i = 0; i < n; i++) total += 1 + Math.floor(Math.random() * 2);
      bag.addCard(card.TemplateID, total);
      break;
    }
    case 3: {
      const k = ctx.templates;
      const r = upgradeCard(bag, pkt.readInt(), (lv) => k.cardConditions.get(lv), (tpl, lv) => k.cardUpdates.get(`${tpl}:${lv}`) as CardUpdateRowFull | undefined, k.cardMaxLevel || 30);
      if (r.msg) p.sendMessage(0, r.msg);
      stats = r.levelUp;
      break;
    }
    default:
      break; // 4 sort: reads two ints and does nothing in the original
  }
  p.cards = bag.equipped();
  p.flushCards();
  if (stats) p.updatePlayerProperties();
}

export function registerPets(r: HandlerRegistry): void {
  // Every PetPackageType sub with a real Handle class in the original is ported (1,2,4,5,6,7,8,9,17,18,20,21,22,
  // 23,33); 3 MOVE_PETBAG, 16 PAY_SKILL, 24 PET_FORMINFO, 25 PET_FOLLOW, 31 PET_BREAK, 32 PET_WAKE and 34+ (break
  // info / temporary card / fold equips / awaken / purify / seal — DDT 6600-era) have no Handle class at all in
  // vendor/DDTank41 (PetHandleMgr.LoadCommandHandler logs an error and drops them) — confirmed dead in the client.
  r.player(68, "PET", (ctx, p, pkt) => petCommand(ctx, p, pkt));
  r.player(216, "CARDS_DATA", (ctx, p, pkt) => cardCommand(ctx, p, pkt));
}
