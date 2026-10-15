/**
 * Bolsa, equipamento, venda, loja e presente (pacotes 44/47/49/62/74/127/221/252).
 * O que cada função faz (todas recebem o pacote já aberto e o jogador logado):
 * - changeItemPlace: arrastar item entre slots/bolsas (split, stack, troca).
 * - mailItems: manda excedente pro correio em cartas de 5 anexos (tipo 8).
 * - buyGoods: carrinho da loja (preço em 7 moedas + item de custo, veste ao comprar).
 * - sendGift: presente de charme pra amigo (cobra Money, dá charmGP + carta 55).
 * - itemContinue: renova validade de item temporário pagando preço de loja.
 * - registerItems: liga cada código de pacote à função (tabela no fim do arquivo).
 */
import { ItemInfo, isAvatar, BagType, templateBagType } from "../game/item.js";
import { getEquipControl } from "../db/consortia.js";
import { bankCapacity, canBuyGuildShop, personalRiches } from "../game/consortia.js";
import type { GamePlayer } from "../game/player.js";
import type { PlayerInventory } from "../game/inventory.js";
import { loadEquippedItems } from "../db/items.js";
import { loadPlayerInfo, loadPlayerInfoByNick, addCharmGP } from "../db/characters.js";
import { saveItem } from "../db/items.js";
import { sendMail, addUserGift, getAllUserReceivedGifts, loadUserRanks } from "../db/social.js";
import type { ShopItemInfo } from "../db/templates.js";
import * as Out from "../packets/out.js";
import { GSPacket } from "@ddt/protocol";
import type { HandlerRegistry } from "./registry.js";
import type { ServerContext } from "../session/context.js";

export interface PriceTotals {
  gold: number; money: number; offer: number; gifttoken: number; petScore: number; score: number; dmgScore: number;
}

/**
 * ItemInfo.GetItemPrice (SqlDataProvider/Data/ItemInfo.cs:1023): price type -1 Money, -2 Gold, -3 Offer, -4 GiftToken,
 * -6 Score, -8 petScore, -9 damageScore; > 0 = required item template (value = count). Value * Beat, truncated.
 */
export function getItemPrice(price: number, value: number, beat: number, t: PriceTotals): { templateId: number; count: number } | null {
  const v = Math.trunc(value * beat);
  switch (price) {
    case -4: t.gifttoken += v; return null;
    case -3: t.offer += v; return null;
    case -2: t.gold += v; return null;
    case -1: t.money += v; return null;
    case -8: t.petScore += v; return null;
    case -6: t.score += v; return null;
    case -9: t.dmgScore += v; return null;
  }
  return price > 0 ? { templateId: price, count: value } : null;
}

/** ItemInfo.SetItemType (ItemInfo.cs:1251): tier 1/2/3 = A/B/C price triples. Returns [tpl, count, tpl, count...]. */
export function setItemType(s: ShopItemInfo, type: number, t: PriceTotals): number[] {
  const tier = type === 1 ? "A" : type === 2 ? "B" : type === 3 ? "C" : null;
  if (!tier) return [];
  const rec = s as unknown as Record<string, number>;
  const out: number[] = [];
  for (const i of [1, 2, 3]) {
    const r = getItemPrice(rec[`${tier}Price${i}`]!, rec[`${tier}Value${i}`]!, s.Beat, t);
    if (r && r.templateId > 0) out.push(r.templateId, r.count);
  }
  return out;
}

/** ShopMgr.CanBuy (Bussiness/Managers/ShopMgr.cs:23) — guild shops 11..15: `guild` = canBuyGuildShop() result (src/game/consortia.ts). */
export function canBuyShop(shopId: number, guild = false): { ok: boolean; isBinds: boolean } {
  if (shopId >= 1 && shopId <= 4) return { ok: true, isBinds: false };
  if (shopId === 20 || shopId === 72 || shopId === 91) return { ok: true, isBinds: true };
  if (shopId >= 11 && shopId <= 15) return { ok: guild, isBinds: true };
  return { ok: false, isBinds: true };
}

function bagLocked(ctx: ServerContext, p: GamePlayer): boolean {
  if (p.info.HasBagPassword && p.info.IsLocked) {
    p.sendMessage(0, ctx.lang.t("Bag.Locked"));
    return true;
  }
  return false;
}

/** UserChangeItemPlaceHandler.cs:19 (Store/Bank/Consortia helper paths simplified to direct moves).
 *
 * Como lê esse código (cada variável):
 * - bag / toBag: bolsa origem e destino (PlayerInventory: prop=0, equip, banco, guilda, store...).
 *   Vêm de `player.getInventory(bagType)`; `toBag !== bag` = troca entre bolsas.
 * - place / toPlace: slot origem e destino. toPlace -1 = "primeiro slot livre".
 * - count: quantas unidades mover (0 = pilha toda; arrasto parcial manda o nº).
 * - item: o ItemInfo na origem (TemplateID=o quê, Count=quantas, Place=slot).
 * - cap: teto do banco da guilda = StoreLevel × 10 slots (sem guilda = 0, bloqueia).
 */
export function changeItemPlace(ctx: ServerContext, p: GamePlayer, bagType: number, place: number, toBagType: number, toPlace: number, count: number): void {
  const bag = p.getInventory(bagType);
  const toBag = p.getInventory(toBagType);
  if (!bag || !toBag) return;
  const item = bag.getItemAt(place);
  if (!item) return;
  if (count < 0 || count > item.Count) {
    p.sink.disconnect("item move count out of range"); // anti-dupe (UserChangeItemPlaceHandler.cs:41)
    return;
  }
  if (toPlace !== -1 && (toPlace < 0 || toPlace >= toBag.capacity)) return; // port: validate slot range
  if (toBagType === BagType.Consortia) {
    // guild bank: only for members, StoreLevel × 10 slots (ConsortiaBag capacity follows the bank level)
    const cap = p.info.ConsortiaID ? bankCapacity(p.info.StoreLevel) : 0;
    if (toPlace === -1 && bagType !== toBagType) toPlace = toBag.findFirstEmptySlotIn(0, cap);
    if (toPlace < 0 || toPlace >= cap) return p.sendMessage(1, ctx.lang.t("UserChangeItemPlaceHandler.full"));
  }
  bag.beginChanges();
  if (toBag !== bag) toBag.beginChanges();
  try {
    if (toBagType === BagType.EquipBag) {
      if (toBag.findFirstEmptySlot() === -1 && toPlace >= 31) return;
    } else if (toBag.findFirstEmptySlot() === -1) return;
    if (toPlace === -1) {
      let full = false;
      if (bagType === toBagType && toBagType === BagType.EquipBag) {
        let slot = toBag.findFirstEmptySlot(toBag.beginSlot);
        if (isAvatar(item.template)) slot = toBag.findFirstEmptySlot(81);
        if (!bag.moveItem(place, slot, count)) full = true;
      } else if (toBag.stackItemToAnother(item)) bag.removeItem(item, 26);
      else if (toBag.addItem(item)) bag.takeOutItem(item);
      else full = true;
      if (full) p.sendMessage(1, ctx.lang.t("UserChangeItemPlaceHandler.full"));
    } else if (bagType === toBagType) {
      if (toBagType === BagType.EquipBag && toPlace < bag.beginSlot) item.IsBinds = true;
      const at = bag.getItemAt(toPlace);
      if (at && toPlace >= bag.beginSlot) {
        // The C# re-targets a busy bag slot to the first free one (and stacking never happens here).
        let slot = toBag.findFirstEmptySlot(toBag.beginSlot);
        if (isAvatar(item.template)) slot = toBag.findFirstEmptySlot(81);
        if (at.canStackedTo(item)) slot = toPlace;
        bag.moveItem(place, slot, count);
      } else bag.moveItem(place, toPlace, count);
    } else {
      // Cross-bag (prop <-> bank/consortia/store): move or swap like MoveToBank/MoveFromBank.
      const to = toBag.getItemAt(toPlace);
      if (!to && count > 0 && count < item.Count) {
        // split part of a stack into the other bag (pet food / texp potion → StoreBag[0]); before, the whole stack moved
        const part = item.clone();
        part.ItemID = 0;
        part.Count = count;
        if (toBag.addItemTo(part, toPlace)) bag.removeCountFromStack(item, count);
      } else if (!to) {
        if (toBag.addItemTo(item, toPlace)) bag.takeOutItem(item);
      } else if (item.canStackedTo(to) && item.Count + to.Count <= item.template.MaxCount) {
        if (toBag.addCountToStack(to, item.Count)) bag.removeCountFromStack(item, item.Count);
      } else {
        bag.takeOutItem(item);
        toBag.takeOutItem(to);
        bag.addItemTo(to, place);
        toBag.addItemTo(item, toPlace);
      }
    }
  } finally {
    bag.commitChanges();
    if (toBag !== bag) toBag.commitChanges();
  }
}

/** Sends overflow items by mail (5 annexes per mail, default type 8 BuyItem) — UserBuyItemHandler.cs:239-325.
 *
 * Como lê esse código (cada variável):
 * - chunk: fatia de até 5 itens (carta só tem Annex1..5). Vem do `slice` do array.
 * - mail: linhas da carta (Annex1..5 = IDs dos itens, viram UserID 0 = "no correio").
 * - remark: texto da carta ("1、nome×qtd;..."). `it` = cada ItemInfo excedente.
 */
export async function mailItems(ctx: ServerContext, p: GamePlayer, items: ItemInfo[], title?: string, type = 8, body?: string): Promise<void> {
  for (let i = 0; i < items.length; i += 5) {
    const chunk = items.slice(i, i + 5);
    const mail: Record<string, unknown> = {};
    let remark = ctx.lang.t("GoodsPresentHandler.AnnexRemark");
    for (const [k, it] of chunk.entries()) {
      it.UserID = 0;
      it.BagType = -1;
      it.Place = -1;
      await saveItem(ctx.db.db, it);
      mail[`Annex${k + 1}`] = String(it.ItemID);
      mail[`Annex${k + 1}Name`] = it.template.Name ?? "";
      remark += `${k + 1}、${it.template.Name}x${it.Count};`;
    }
    const content = title ?? `${ctx.lang.t("UserBuyItemHandler.Title")}${chunk[0]!.template.Name ?? ""}]`;
    await sendMail(ctx.db.db, {
      ...mail, AnnexRemark: remark, Content: body ?? content, Title: content, Gold: 0, Money: 0, Type: type,
      Receiver: p.info.NickName, ReceiverID: p.id, Sender: p.info.NickName, SenderID: p.id,
    });
  }
  if (items.length) p.send(Out.mailResponse(p.id, 1)); // 117: the client reloads LoadUserMail.ashx
}

/** UserBuyItemHandler.cs:22 (44 BUY_GOODS): carrinho multi-linha em 1 pacote.
 * Pacote: int count (1..99); por linha [goodsId, type A/B/C, color, dress, skin, place].
 * Cobra tudo junto (sem falha parcial) e veste se dress=true; sem espaço vai pro correio.
 *
 * Como lê esse código (cada variável):
 * - totals (PriceTotals): soma do custo em 7 moedas (gold/money/offer/gifttoken/petScore/score/dmgScore).
 * - need: mapa templateID->qtd de ITENS exigidos como custo (ex. pedra de troca).
 * - buy: lista do que entregar [{item, dress, place}]; `place` = slot p/ anel/bracelete 7-10.
 * - goodsId/type: linha da Shop_Goods; type 1/2/3 = tripla de preço A/B/C (setItemType).
 * - unit: validade (BuyType 0, dias) ou quantidade (BuyType != 0) da unidade comprada.
 * - eMsg/msg: 0=ok, 1=erro (texto vai pro chat); reply 44 sempre [1,3] no fim.
 */
export async function buyGoods(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const tpl = ctx.templates;
  const totals: PriceTotals = { gold: 0, money: 0, offer: 0, gifttoken: 0, petScore: 0, score: 0, dmgScore: 0 };
  const need = new Map<number, number>();
  const buy: { item: ItemInfo; dress: boolean; place: number }[] = [];
  const count = pkt.readInt();
  if (count <= 0 || count > 99) return p.sendMessage(0, ctx.lang.t("UserBuyItemHandler.SystemError"));
  for (let i = 0; i < count; i++) {
    const goodsId = pkt.readInt();
    const type = pkt.readInt();
    const color = pkt.readString();
    const dress = pkt.readBoolean();
    const skin = pkt.readString();
    const place = pkt.readInt();
    const shop = tpl.shop.get(goodsId);
    if (!shop || !tpl.isOnShop(shop.ID)) continue;
    let guildOk = false;
    if (shop.ShopID >= 11 && shop.ShopID <= 15 && p.info.ConsortiaID) {
      const th = await getEquipControl(ctx.db.db, p.info.ConsortiaID, shop.ShopID - 10, 1);
      guildOk = canBuyGuildShop(shop.ShopID, p.info.ConsortiaID, p.info.ShopLevel, personalRiches(p.info), th);
    }
    const can = canBuyShop(shop.ShopID, guildOk);
    if (shop.ShopID === 2 || !can.ok) return p.sendMessage(1, ctx.lang.t("UserBuyItemHandler.FailByPermission"));
    const t = tpl.findItem(shop.TemplateID);
    if (!t) continue;
    if (shop.ShopID === 20) {
      // Limited free daily goods (WorldMgr.UpdateShopFreeCount): one per day.
      const last = p.info.ShopFinallyGottenTime;
      if (last && last.toISOString().slice(0, 10) === ctx.now().toISOString().slice(0, 10)) return p.sendMessage(1, ctx.lang.t("UserBuyItemHandler.FailByPermission2"));
      p.info.ShopFinallyGottenTime = ctx.now();
      need.set(-9999, 1);
    }
    const item = ItemInfo.createFromTemplate(t, 1, 102, ctx.now());
    const unit = type === 1 ? shop.AUnit : type === 2 ? shop.BUnit : type === 3 ? shop.CUnit : null;
    if (unit !== null) {
      if (shop.BuyType === 0) item.ValidDate = unit;
      else item.Count = unit;
    }
    item.Color = color ?? "";
    item.Skin = skin ?? "";
    item.IsBinds = true; // UserBuyItemHandler.cs:117 — every purchase is bound in this build
    buy.push({ item, dress, place });
    const req = setItemType(shop, type, totals);
    for (let j = 0; j < req.length; j += 2) need.set(req[j]!, (need.get(req[j]!) ?? 0) + req[j + 1]!);
  }
  if (buy.length === 0) return;
  if (bagLocked(ctx, p)) return;
  for (const [k, v] of need) if (k !== -9999 && p.getTemplateCount(k, tpl.findItem) < v) return p.sendMessage(1, ctx.lang.t("UserBuyItemHandler.NoBuyItem"));
  const { gold, money, offer, gifttoken, petScore, score, dmgScore } = totals;
  const anyCost = gold > 0 || money > 0 || offer > 0 || gifttoken > 0 || petScore > 0 || score > 0 || dmgScore > 0 || need.size > 0;
  if (!(gold >= 0 && money >= 0 && offer >= 0 && gifttoken >= 0 && petScore >= 0 && score >= 0 && dmgScore >= 0 && anyCost)) {
    return p.sendMessage(0, ctx.lang.t("UserBuyItemHandler.SystemError"));
  }
  const c = p.info;
  let eMsg = 0;
  let msg = "UserBuyItemHandler.Success";
  if (gold <= c.Gold && money <= c.Money + c.MoneyLock && offer <= c.Offer && gifttoken <= c.GiftToken && petScore <= c.petScore && score <= c.Score && dmgScore <= c.damageScores) {
    p.beginChanges();
    p.removeMoney(money); p.removeGold(gold); p.removeOffer(offer); p.removeGiftToken(gifttoken);
    p.removePetScore(petScore); p.removeScore(score); p.removeDamageScores(dmgScore);
    for (const [k, v] of need) if (k !== -9999) p.removeTemplateInShop(k, v, tpl.findItem);
    p.commitChanges();
    p.questInv?.onPaid(money, gold, offer, gifttoken, buy.map((b) => b.item.TemplateID)); // GamePlayer.OnPaid -> ShopCondition
    const overflow: ItemInfo[] = [];
    for (const b of buy) {
      const bagType = templateBagType(b.item.template);
      const inv = p.getInventory(bagType);
      if (inv && inv.addTemplate(b.item, b.item.Count)) {
        if (!b.dress || !b.item.canEquip()) continue;
        let slot = p.equipBag.findItemEquipSlot(b.item.template);
        if ((slot === 9 || slot === 10) && (b.place === 9 || b.place === 10)) slot = b.place;
        else if ((slot === 7 || slot === 8) && (b.place === 7 || b.place === 8)) slot = b.place;
        const placed = (inv as PlayerInventory).lastAdded[0];
        if (placed && inv === p.equipBag) p.equipBag.moveItem(placed.Place, slot, 0);
        msg = "UserBuyItemHandler.Save";
      } else overflow.push(b.item);
    }
    if (overflow.length) {
      await mailItems(ctx, p, overflow);
      eMsg = 1;
      msg = "UserBuyItemHandler.Mail";
    }
  } else {
    if (money > c.Money && money > 0) msg = "UserBuyItemHandler.NoMoney";
    if (gold > c.Gold) msg = "UserBuyItemHandler.NoGold";
    if (offer > c.Offer) msg = "UserBuyItemHandler.NoOffer";
    if (gifttoken > c.GiftToken) msg = "UserBuyItemHandler.GiftToken";
    if (petScore > c.petScore) msg = "UserBuyItemHandler.petScore";
    if (score > c.Score || dmgScore > c.damageScores) msg = "UserBuyItemHandler.boguScore";
    eMsg = 1;
  }
  p.sendMessage(eMsg, ctx.lang.t(msg));
  const reply = new GSPacket(44, p.id);
  reply.writeInt(1);
  reply.writeInt(3);
  p.send(reply);
}

/**
 * UserSendGiftHandler.cs:12 (221 USER_SEND_GIFTS) — shop "charm gift" to a friend: nick, shop-item id, count
 * (1..9999), one unused trailing int. Cost = ShopItemInfo.AValue1 × count Money; receiver gets
 * ItemTemplate.Property2 × count charmGP (SP_Users_UpdateCharmGP) + a log row (SP_Users_Gift_Add) + mail type 55
 * (UserGiftSystem.MailTitle). An online receiver's charmGP/public-info is bumped live and told via 117 (Gift).
 *
 * Como lê esse código (cada variável):
 * - nick/shopItemId/count: quem recebe, qual item da loja, quantos (lidos do pacote, nessa ordem).
 * - shop/t: linha Shop_Goods + ItemTemplate (Property2 = charme por unidade).
 * - online/info: jogador alvo (na memória se online, senão carrega do banco pelo nick).
 * - cost/charm: Money cobrado = AValue1×count; charme dado = Property2×count.
 */
export async function sendGift(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const nick = pkt.readString();
  const shopItemId = pkt.readInt();
  const count = pkt.readInt();
  pkt.readInt(); // unused — the original reads and discards it too
  if (nick === p.info.NickName || count <= 0 || count > 9999) return;
  const shop = ctx.templates.shop.get(shopItemId);
  if (!shop || shop.AValue1 <= 0) return;
  const t = ctx.templates.findItem(shop.TemplateID);
  if (!t) return;
  const online = ctx.world.getByNick(nick);
  const info = online?.info ?? (await loadPlayerInfoByNick(ctx.db.db, nick));
  if (!info) return p.sendMessage(0, ctx.lang.t("GoodsPresentHandler.NoUser"));
  const cost = shop.AValue1 * count;
  if (cost > p.info.Money + p.info.MoneyLock) return p.sendMessage(0, ctx.lang.t("GoodsPresentHandler.NoMoney"));
  p.removeMoney(cost);
  const charm = (t.Property2 ?? 0) * count;
  await addUserGift(ctx.db.db, p.id, info.ID, t.TemplateID, count);
  await addCharmGP(ctx.db.db, info.ID, charm);
  await sendMail(ctx.db.db, {
    SenderID: p.id, Sender: p.info.NickName ?? "", ReceiverID: info.ID, Receiver: info.NickName ?? "",
    Title: ctx.lang.t("UserGiftSystem.MailTitle"),
    Content: `${p.info.NickName ?? ""}${ctx.lang.t("GoodsPresentHandler.Content")}${t.Name ?? ""}]`,
    Type: 55, Gold: 0, Money: 0,
  });
  if (online) {
    online.info.charmGP += charm;
    online.updateProperties();
    online.send(Out.mailResponse(online.id, 4)); // eMailRespose.Gift
  }
  const reply = new GSPacket(221, p.id);
  reply.writeBoolean(true);
  p.send(reply);
  p.sendMessage(0, ctx.lang.t("GoodsPresentHandler.Success"));
}

/**
 * UserItemContineueHandler.cs (62 ITEM_CONTINUE): extends an owned item's ValidDate using its shop listing price
 * (tier A/B/C like BUY_GOODS); the item must be a timed EquipBag slot (>= 31)/PropBag/StoreBag item.
 *
 * Como lê esse código (cada variável):
 * - count: quantas renovações o pacote pede; bagType/place/shopId/type: onde está o item,
 *   qual linha da loja paga, qual tripla A/B/C.
 * - need/totals: custo (itens + moedas) calculado por setItemType.
 * - validDate/count0/wasValid: backup pra restaurar se faltar dinheiro; item expirado
 *   renascido ganha BeginDate nova (soma em cima se ainda válido).
 */
export async function itemContinue(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  if (bagLocked(ctx, p)) return;
  const count = pkt.readInt();
  for (let i = 0; i < count; i++) {
    const bagType = pkt.readByte();
    const place = pkt.readInt();
    const shopId = pkt.readInt();
    const type = pkt.readByte();
    pkt.readBoolean();
    if (!((bagType === BagType.EquipBag && place >= 31) || bagType === BagType.PropBag || bagType === BagType.Store)) {
      p.sendMessage(0, ctx.lang.t("UserItemContineueHandler.CanNotContineu"));
      continue;
    }
    const bag = p.getInventory(bagType);
    const item = bag?.getItemAt(place);
    if (!bag || !item || item.ValidDate === 0) { p.sendMessage(0, ctx.lang.t("UserItemContineueHandler.CanNotContineu")); continue; }
    const shop = ctx.templates.shop.get(shopId);
    if (!shop || shop.TemplateID !== item.TemplateID) {
      p.sendMessage(0, ctx.lang.t("UserItemContineueHandler.InvalidShopItem"));
      return; // the original's loop can only exit (via `break`) on this exact mismatch
    }
    const totals: PriceTotals = { gold: 0, money: 0, offer: 0, gifttoken: 0, petScore: 0, score: 0, dmgScore: 0 };
    const need = setItemType(shop, type, totals);
    const validDate = item.ValidDate, count0 = item.Count, wasValid = item.isValidItem(ctx.now());
    let ok = true;
    for (let j = 0; j < need.length; j += 2) if (p.getTemplateCount(need[j]!, ctx.templates.findItem) < need[j + 1]!) ok = false;
    if (!ok) return p.sendMessage(1, ctx.lang.t("UserBuyItemHandler.NoBuyItem"));
    const c = p.info;
    if (totals.gold <= c.Gold && totals.money <= c.Money + c.MoneyLock && totals.offer <= c.Offer && totals.gifttoken <= c.GiftToken && totals.petScore <= c.petScore && totals.score <= c.Score) {
      p.removeMoney(totals.money); p.removeGold(totals.gold); p.removeOffer(totals.offer); p.removeGiftToken(totals.gifttoken);
      p.removePetScore(totals.petScore); p.removeScore(totals.score);
      for (let j = 0; j < need.length; j += 2) p.removeTemplateInShop(need[j]!, need[j + 1]!, ctx.templates.findItem);
      const unit = type === 1 ? shop.AUnit : type === 2 ? shop.BUnit : type === 3 ? shop.CUnit : 0;
      item.ValidDate = unit;
      if (!wasValid) { item.BeginDate = ctx.now(); item.IsUsed = false; }
      else item.ValidDate += validDate;
      item.IsBinds = true;
      bag.updateItem(item);
      p.sendMessage(0, ctx.lang.t("UserItemContineueHandler.Success"));
    } else {
      item.ValidDate = validDate;
      item.Count = count0;
      p.sendMessage(0, ctx.lang.t("UserItemContineueHandler.NoMoney"));
    }
  }
}

export function registerItems(r: HandlerRegistry): void {
  r.player(49, "CHANGE_PLACE_GOODS", (ctx, p, pkt) => {
    const bagType = pkt.readByte();
    const place = pkt.readInt();
    const toBag = pkt.readByte();
    const toPlace = pkt.readInt();
    const count = pkt.readInt();
    pkt.readBoolean();
    changeItemPlace(ctx, p, bagType, place, toBag, toPlace, count);
  }, "partial");

  /** UserUnchainItemHandler.cs:8 — not during a game. */
  r.player(47, "UNCHAIN_EQUIP", (_ctx, p, pkt) => {
    if (p.currentRoom?.IsPlaying) return;
    const from = pkt.readInt();
    if (!(from >= 0 && from < 31)) return;
    p.equipBag.moveItem(from, p.equipBag.findFirstEmptySlot(31), 0);
  });

  /** ItemReclaimHandler.cs:12 — removes the whole stack (original behaviour) but credits only `count`. */
  r.player(127, "REClAIM_GOODS", (ctx, p, pkt) => {
    const bag = p.getInventory(pkt.readByte());
    const place = pkt.readInt();
    let count = pkt.readInt();
    const it = bag?.getItemAt(place);
    if (!bag || !it) return p.sendMessage(0, ctx.lang.t("ItemReclaimHandler.NoSuccess"));
    if (bagLocked(ctx, p)) return;
    if (count <= 0) return; // port: reject non-positive counts
    if (it.Count <= count) count = it.Count;
    const t = it.template;
    const price = count * t.ReclaimValue;
    if (t.ReclaimType === 3) return p.sendMessage(0, ctx.lang.t("UserReclaimItemHandler.fail"));
    if (t.ReclaimType === 2) {
      p.addGiftToken(price);
      p.sendMessage(0, ctx.lang.t("ItemReclaimHandler.Success1", price));
    } else if (t.ReclaimType === 1) {
      p.addGold(price);
      p.sendMessage(0, ctx.lang.t("ItemReclaimHandler.Success2", price));
    }
    bag.removeItemAt(place);
  });

  r.player(44, "BUY_GOODS", (ctx, p, pkt) => buyGoods(ctx, p, pkt));

  r.player(221, "USER_SEND_GIFTS", (ctx, p, pkt) => sendGift(ctx, p, pkt));

  /**
   * ChangeSexHandler.cs:12 — item 11569 ("Thẻ đổi giới tính"/sex-change card). Same packet code as
   * MARRY_ROOM_STATE (252); ChangeSexHandler wins in the original (spec 01-packet-handlers.md:125).
   */
  r.player(252, "USE_CHANGE_SEX", async (ctx, p, pkt) => {
    const bagType = pkt.readByte();
    const slot = pkt.readInt();
    const inv = p.getInventory(bagType);
    const item = inv?.getItemAt(slot);
    if (!inv || !item || item.TemplateID !== 11569) return;
    // Best-effort divorce: a same-sex marriage becomes invalid once Sex flips (ChangeSexHandler.cs:22-42).
    if (p.info.SpouseID > 0) {
      p.info.IsMarried = false;
      p.info.SpouseID = 0;
      p.info.MarryInfoID = 0;
    }
    const newSex = !p.info.Sex;
    p.info.Sex = newSex;
    // Unequip now-invalid gender-locked gear (NeedSex) instead of leaving it illegally equipped.
    for (let s = 0; s < 31; s++) {
      const eq = p.equipBag.getItemAt(s);
      if (eq && !p.canEquip(eq.template)) p.equipBag.moveItem(s, p.equipBag.findFirstEmptySlot(31), 0);
    }
    inv.removeCountFromStack(item, 1);
    p.updatePlayerProperties();
    p.sendMessage(0, ctx.lang.t("ChangeSexHandlerHandler.Success"));
    // Varredura pt.2: save immediately (like quest claim / mail attachment) — Sex, divorce and the item
    // consumption otherwise sit unpersisted until the 10-minute autosave tick.
    await p.saveIntoDatabase(ctx.db.db);
  });

  /** UserEquipListHandler.cs: view another player's equipment (online or from DB). */
  r.player(74, "ITEM_EQUIP", async (ctx, p, pkt) => {
    const byId = pkt.readBoolean();
    let id = 0;
    let nick = "";
    if (byId) id = pkt.readInt();
    else nick = pkt.readString();
    const online = byId ? ctx.world.get(id) : ctx.world.getByNick(nick);
    let info = online?.info ?? null;
    let items = online ? online.equipBag.getItems(0, 30) : null;
    if (!online) {
      info = byId ? await loadPlayerInfo(ctx.db.db, id) : await loadPlayerInfoByNick(ctx.db.db, nick);
      if (info) items = await loadEquippedItems(ctx.db.db, info.ID, ctx.templates.findItem, ctx.templates.findGoldTemplate);
    }
    if (!info || !items) return p.sendMessage(3, ctx.lang.t("UserEquipListHandler.InvalidPlayer"));
    p.send(Out.userEquip(info, items, ctx.now()));
  });

  /** ChangeDesignationHandler.cs (34 USER_RANK): show/hide the guild tag over the player's head. */
  r.player(34, "USER_RANK", (_ctx, p, pkt) => {
    p.info.IsShowConsortia = pkt.readBoolean();
  });

  r.player(62, "ITEM_CONTINUE", (ctx, p, pkt) => itemContinue(ctx, p, pkt));

  /**
   * GoodsCountHandler.cs (168 GOODS_COUNT): global daily-stock counters for shop goods bought today
   * (WorldMgr.GetAllShopFreeCount). Deviation (same as 44 BUY_GOODS, see HANDLERS.md): shop id 20's daily limit is
   * enforced per player here, not as a shared global stock, so there is nothing to report — the list is empty.
   */
  r.player(168, "GOODS_COUNT", (_ctx, p) => {
    const out = new GSPacket(168, p.id);
    out.writeInt(0);
    p.send(out);
  }, "partial");

  /** UserChangeItemColorHandler.cs (182 USE_COLOR_CARD): recolor an equip slot using a PropBag color item, or Money. */
  r.player(182, "USE_COLOR_CARD", (ctx, p, pkt) => {
    pkt.readInt();
    const propSlot = pkt.readInt();
    pkt.readInt();
    const equipSlot = pkt.readInt();
    const color = pkt.readString();
    const skin = pkt.readString();
    const templateId = pkt.readInt();
    const item = p.equipBag.getItemAt(equipSlot);
    if (!item) return;
    const colorItem = p.propBag.getItemAt(propSlot);
    let ok = false;
    if (colorItem?.isValidItem(ctx.now())) { p.propBag.removeCountFromStack(colorItem, 1); ok = true; }
    else {
      const price = ctx.templates.shopByTemplate(templateId).find((s) => s.APrice1 === -1 && s.AValue1 !== 0)?.AValue1 ?? 0;
      if (price <= p.info.Money + p.info.MoneyLock) { p.removeMoney(price); ok = true; }
    }
    if (ok) {
      item.Color = color ?? "";
      item.Skin = skin ?? "";
      p.equipBag.updateItem(item);
    }
    p.sendMessage(0, ctx.lang.t("UserChangeItemColorHandler.Success"));
  });

  /** ReworkRankHandler.cs (189 USER_CHANGE_RANK): switch the displayed title to one of the player's own, earned
   * (Sys_User_Rank) titles — or clear it when the name doesn't match any. */
  r.player(189, "USER_CHANGE_RANK", async (ctx, p, pkt) => {
    const honor = pkt.readString();
    if (!honor) return;
    const now = ctx.now();
    const ranks = await loadUserRanks(ctx.db.db, p.id);
    const match = ranks.find((rk) => (rk.Name ?? "").includes(honor) && (rk.Validate <= 0 || rk.BeginDate.getTime() + rk.Validate * 86_400_000 > now.getTime()));
    p.info.Honor = match ? honor : "";
    p.info.honorId = 0; // NewTitleID table was never migrated (see HANDLERS.md "Player stats") — honor is matched by Name only
    p.updatePlayerProperties();
  });

  /** UserGetGiftHandler.cs (218 USER_GET_GIFTS): list every gift a player (self or anyone else, int userId) has
   * ever received, summed by TemplateID. (PlayerGiftHandler, also registered on 218 in the original, is a dead
   * single-int no-op the C# reflection loader shadows — this port keeps the meaningful one.) */
  r.player(218, "USER_GET_GIFTS", async (ctx, p, pkt) => {
    const userId = pkt.readInt();
    const online = ctx.world.get(userId);
    const info = online?.info ?? (userId === p.id ? p.info : await loadPlayerInfo(ctx.db.db, userId));
    if (!info) return;
    const gifts = await getAllUserReceivedGifts(ctx.db.db, userId);
    const out = new GSPacket(218, p.id);
    out.writeInt(info.ID);
    out.writeInt(info.charmGP ?? 0);
    out.writeInt(gifts.length);
    for (const g of gifts) { out.writeInt(g.TemplateID); out.writeInt(g.Count); }
    p.send(out);
  });

  /** PropDeleteHandler.cs (75 PROP_DELETE): discard a prop from the in-fight hand (FightBag). */
  r.player(75, "PROP_DELETE", (_ctx, p, pkt) => {
    p.fightBag.removeItemAt(pkt.readInt());
  });

  /** GameTakeTempItemsHandler.cs (108 GAME_TAKE_TEMP): pick one (int place) or all (-1) TempBag items into their
   * real bags; overflow mails the whole remaining TempBag. The original's `item.Template.BagType == eBageType.Card`
   * branch is dead code — ItemTemplateInfo.BagType's switch (ItemTemplateInfo.cs:11-31) never returns Card for any
   * CategoryID, so cards never take that path; every item goes through the normal `GetItemInventory` add. */
  r.player(108, "GAME_TAKE_TEMP", async (ctx, p, pkt) => {
    const place = pkt.readInt();
    const take = async (it: ItemInfo): Promise<boolean> => {
      const inv = p.getItemInventory(it.template);
      if (inv?.addItem(it)) { p.tempBag.takeOutItem(it); return true; }
      return false;
    };
    if (place !== -1) {
      const it = p.tempBag.getItemAt(place);
      if (it) await take(it);
    } else {
      for (const it of p.tempBag.getItems()) if (!(await take(it))) break;
    }
    const left = p.tempBag.getItems();
    if (left.length) {
      await mailItems(ctx, p, left, ctx.lang.t("GameTakeTempItemsHandler.MailTitle"), 9);
      for (const it of left) p.tempBag.takeOutItem(it);
      p.sendMessage(1, ctx.lang.t("GameTakeTempItemsHandler.Msg")); // eMessageType.BIGBUGLE_NOTICE
    }
  });

  // Confirmed dead in the original vendor/DDTank41 (no [PacketHandler] class anywhere carries these codes):
  // 66 PROP_USE, 77 ITEM_OVERDUE, 171 USE_REWORK_NAME, 188 USE_CONSORTIA_REWORK_NAME, 205 USE_CHANGE_COLOR_SHELL,
  // 222 EQUIP_RECYCLE_ITEM, 265 NEWTITLE_CARD.
  for (const [code, name] of [[66, "PROP_USE"], [77, "ITEM_OVERDUE"], [171, "USE_REWORK_NAME"], [188, "USE_CONSORTIA_REWORK_NAME"],
    [205, "USE_CHANGE_COLOR_SHELL"], [222, "EQUIP_RECYCLE_ITEM"], [265, "NEWTITLE_CARD"]] as [number, string][]) {
    r.player(code, name, () => undefined, "stub");
  }
}
