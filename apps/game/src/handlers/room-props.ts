/** RoomPropCell.as -> PropBuyHandler.cs / PropSellHandler.cs (54 / 55).
 * Room gold-shop purchases use A-tier prices and a temporary three-slot FightBag.
 * Bind refunds to this server's purchase, instead of trusting the client's shop ID. */
import type { GSPacket } from "@ddt/protocol";
import { ItemInfo } from "../game/item.js";
import { commitPlayerMutation, PlayerMutationCommittedError } from "../game/player-transaction.js";
import type { GamePlayer } from "../game/player.js";
import type { ServerContext } from "../session/context.js";
import { setItemType, type PriceTotals } from "./items.js";

const integer = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647;
const purchases = new WeakMap<ItemInfo, { playerId: number; shopId: number; gold: number; count: number }>();
const available = (p: GamePlayer) => p.isActive && !p.quitting && !p.currentRoom?.IsPlaying;

function reject(ctx: ServerContext, p: GamePlayer, code: number, reason: string, message: string): void {
  ctx.log.warn("purchase rejected", { code, playerId: p.id, reason });
  p.sendMessage(0, message);
}

function quote(ctx: ServerContext, shopId: number) {
  const shop = ctx.templates.shop.get(shopId), template = shop && ctx.templates.findItem(shop.TemplateID);
  // PropItemMgr.PropFightBag is exactly 10001..10022. RoomPropCell only selects the gold shop.
  if (!shop || !template || template.CategoryID !== 10 || !integer(template.TemplateID) ||
    template.TemplateID < 10001 || template.TemplateID > 10022 || !integer(shop.AUnit) ||
    ![0, 1].includes(shop.BuyType) || (shop.BuyType === 1 && shop.AUnit < 1) ||
    !Number.isFinite(shop.Beat) || shop.Beat < 0) return null;
  for (const i of [1, 2, 3] as const) {
    const price = shop[`APrice${i}`], value = shop[`AValue${i}`];
    if (!Number.isSafeInteger(price) || !integer(value) || (value > 0 && price !== -2)) return null;
  }
  const totals: PriceTotals = { gold: 0, money: 0, offer: 0, gifttoken: 0, petScore: 0, score: 0, dmgScore: 0 };
  setItemType(shop, 1, totals);
  if (!integer(totals.gold)) return null;
  return { shop, template, gold: totals.gold };
}

export async function buyRoomProp(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  if (pkt.length - pkt.offset !== 4) return reject(ctx, p, 54, "invalid_request", "战斗道具购买请求无效。");
  const shopId = pkt.readInt();
  return p.withPersistenceLock(async () => {
    if (!available(p)) return reject(ctx, p, 54, "unavailable", "当前不能购买战斗道具，请在战斗结束后重试。");
    let reason = "invalid_quote", message = "该战斗道具暂不可购买，金币未扣除。";
    let bought: { place: number; gold: number; count: number } | null = null;
    try {
      bought = await commitPlayerMutation(ctx, p, async (_db, staged, now) => {
        if (!available(p)) return null;
        const selected = quote(ctx, shopId);
        if (!selected) return null;
        if (!integer(staged.info.Gold) || staged.info.Gold < selected.gold) {
          reason = "insufficient_gold"; message = `购买需要${selected.gold}金币，当前金币不足。`; return null;
        }
        const place = staged.fightBag.findFirstEmptySlot(0);
        if (place < 0) { reason = "bag_full"; message = "战斗道具栏已满，请先出售一个道具。"; return null; }
        const item = ItemInfo.createFromTemplate(selected.template, 1, 102, now);
        if (selected.shop.BuyType === 0) item.ValidDate = selected.shop.AUnit;
        else item.Count = selected.shop.AUnit;
        if (!staged.fightBag.addItemTo(item, place)) throw Error("Room prop delivery failed");
        staged.removeGold(selected.gold);
        return { value: { place, gold: selected.gold, count: item.Count } };
      });
    } catch (error) {
      if (error instanceof PlayerMutationCommittedError) { bought = error.value as typeof bought; ctx.log.error("Room prop notification failed after commit", error); }
      else { ctx.log.error("Room prop purchase transaction failed", error); return reject(ctx, p, 54, "save_failed", "购买保存失败，金币未扣除，请稍后重试。"); }
    }
    if (!bought) return reject(ctx, p, 54, reason, message);
    const item = p.fightBag.getItemAt(bought.place)!;
    purchases.set(item, { playerId: p.id, shopId, gold: bought.gold, count: bought.count });
    ctx.log.info("purchase completed", { code: 54, playerId: p.id, shopId, gold: bought.gold });
  });
}

export async function sellRoomProp(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  if (pkt.length - pkt.offset !== 8) return reject(ctx, p, 55, "invalid_request", "战斗道具出售请求无效。");
  const place = pkt.readInt(), shopId = pkt.readInt();
  return p.withPersistenceLock(async () => {
    if (!available(p)) return reject(ctx, p, 55, "unavailable", "当前不能出售战斗道具，请在战斗结束后重试。");
    const item = p.fightBag.getItemAt(place), receipt = item && purchases.get(item), selected = quote(ctx, shopId);
    if (!item || !receipt || receipt.playerId !== p.id || receipt.shopId !== shopId || !selected ||
      item.TemplateID !== selected.template.TemplateID || item.Count !== receipt.count || selected.gold !== receipt.gold)
      return reject(ctx, p, 55, "invalid_refund", "该道具无法按此价格出售，请重新打开房间道具栏。");
    let sold = false;
    try {
      sold = await commitPlayerMutation(ctx, p, async (_db, staged) => {
        if (!available(p) || !integer(staged.info.Gold) || !integer(staged.info.Gold + receipt.gold)) return null;
        const copy = staged.fightBag.getItemAt(place);
        if (!copy || copy.TemplateID !== item.TemplateID || copy.Count !== receipt.count || copy.cellLocked || !copy.IsExist ||
          copy.UserID !== p.id || !staged.fightBag.removeItem(copy)) return null;
        staged.addGold(receipt.gold);
        return { value: true };
      }) ?? false;
    } catch (error) {
      if (error instanceof PlayerMutationCommittedError) { sold = true; ctx.log.error("Room prop refund notification failed after commit", error); }
      else { ctx.log.error("Room prop refund transaction failed", error); return reject(ctx, p, 55, "save_failed", "出售保存失败，道具和金币未改变，请稍后重试。"); }
    }
    if (!sold) return reject(ctx, p, 55, "invalid_refund", "该道具暂时无法出售，道具和金币未改变。");
    purchases.delete(item);
    ctx.log.info("purchase refunded", { code: 55, playerId: p.id, shopId, gold: receipt.gold });
  });
}
