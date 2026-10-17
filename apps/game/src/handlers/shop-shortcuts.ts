/** Existing client purchase packets missing from the port: 46 smith bundle / 126 gold box / 57 gift notice. */
import type { GSPacket } from "@ddt/protocol";
import { ItemInfo, BagType, templateBagType } from "../game/item.js";
import type { GamePlayer } from "../game/player.js";
import { commitPlayerMutation, PlayerMutationCommittedError } from "../game/player-transaction.js";
import type { ServerContext } from "../session/context.js";
import { createItemBox } from "./use.js";

export const STRENGTH_GIFT_BAG = 112051100;
// Match the local client's confirmation text. The donor's hardcoded 1950 price
// disagrees with both its client check (988) and our displayed quote (998).
export const STRENGTH_GIFT_BAG_PRICE = 998;
const smithMaterials = [11023, 11023, 11023, 11020, 11018] as const;
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647;
const permitted = (p: GamePlayer) => p.isActive && !p.quitting && !p.currentRoom?.IsPlaying && !(p.info.HasBagPassword && p.info.IsLocked);

function reject(ctx: ServerContext, p: GamePlayer, code: number, reason: string, message: string): void {
  ctx.log.warn("purchase rejected", { code, playerId: p.id, reason });
  p.sendMessage(0, message);
}

/** UserPresentGoodsHandler.cs intentionally disables ordinary shop gifting.
 * Preserve that rule with a visible response, instead of silently dropping 57.
 * Charm gifts use the separate, already implemented 221 handler. */
export function presentGoodsUnavailable(ctx: ServerContext, p: GamePlayer): void {
  reject(ctx, p, 57, "shop_gifting_disabled", "商城赠送功能暂未开放，未扣除点券。");
}

/** BuyGiftBagHandler.cs + GamePlayer.ClearStoreBagWithOutPlace(5): return
 * existing bench materials, preserve equipment slot 5, then fill slots 0..4.
 * No new packet fields or reply format: normal inventory/profile updates + message. */
export async function buyGiftBag(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  if (pkt.length - pkt.offset !== 4 || pkt.readInt() !== STRENGTH_GIFT_BAG)
    return reject(ctx, p, 46, "invalid_request", "强化礼包购买请求无效，请重新打开铁匠铺。");
  return p.withPersistenceLock(async () => {
    if (!permitted(p)) return reject(ctx, p, 46, "unavailable", "当前不能购买，请先返回大厅并解锁背包。");
    let reason = "configuration", message = "强化礼包配置暂不可用，未扣除点券。", bought = false;
    try {
      bought = await commitPlayerMutation(ctx, p, async (_db, staged, now) => {
        if (!permitted(p)) return null;
        const templates = smithMaterials.map(id => ctx.templates.findItem(id));
        if (templates.some(t => !t || t.CategoryID !== 11)) return null;
        if (staged.info.Money + staged.info.MoneyLock < STRENGTH_GIFT_BAG_PRICE) {
          reason = "insufficient_money"; message = `购买礼包需要${STRENGTH_GIFT_BAG_PRICE}点券，当前点券不足。`; return null;
        }
        const overflow: ItemInfo[] = [];
        for (const item of staged.storeBag.getItems()) {
          if (item.Place === 5) continue;
          const dest = templateBagType(item.template) === BagType.PropBag ? staged.propBag : staged.equipBag;
          const place = dest.findFirstEmptySlot(dest === staged.equipBag ? 31 : 0);
          if (!staged.storeBag.takeOutItem(item)) throw new Error("Smith bench item move failed");
          if (place < 0) overflow.push(item);
          else if (!dest.addItemTo(item, place)) throw new Error("Smith material return failed");
        }
        for (const [place, template] of templates.entries()) {
          const item = ItemInfo.createFromTemplate(template!, 1, 101, now);
          item.ValidDate = 0; item.IsBinds = true;
          if (!staged.storeBag.addItemTo(item, place)) throw new Error("Smith bundle delivery failed");
        }
        staged.removeMoney(STRENGTH_GIFT_BAG_PRICE);
        return { value: true, overflow, mailTitle: "铁匠铺退还道具" };
      }) ?? false;
    } catch (error) {
      if (error instanceof PlayerMutationCommittedError) { bought = true; ctx.log.error("Smith purchase notification failed after commit", error); }
      else { ctx.log.error("Smith purchase transaction failed", error); return reject(ctx, p, 46, "save_failed", "购买保存失败，未扣除点券，请稍后重试。"); }
    }
    if (!bought) return reject(ctx, p, 46, reason, message);
    ctx.log.info("purchase completed", { code: 46, playerId: p.id, money: STRENGTH_GIFT_BAG_PRICE });
    p.sendMessage(0, `强化礼包购买成功，已扣除${STRENGTH_GIFT_BAG_PRICE}点券，材料已放入强化槽。`);
  });
}

/** QuickBuyGoldBoxHandler.cs: shop row 1123301, count * AValue1 Money,
 * count * the original gold-box reward. AS3 sends just an int; accept the
 * donor's optional trailing boolean as well. */
export async function quickBuyGoldBox(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const length = pkt.length - pkt.offset;
  if (length !== 4 && length !== 5) return reject(ctx, p, 126, "invalid_request", "金币宝箱购买请求无效。");
  const count = pkt.readInt();
  if (length === 5) pkt.readBoolean();
  if (!integer(count) || count < 1) return reject(ctx, p, 126, "invalid_count", "请选择正确的金币宝箱数量。");
  return p.withPersistenceLock(async () => {
    if (!permitted(p)) return reject(ctx, p, 126, "unavailable", "当前不能购买，请先返回大厅并解锁背包。");
    let reason = "configuration", message = "金币宝箱暂不可购买，未扣除点券。";
    let result: { cost: number; gold: number } | null = null;
    try {
      result = await commitPlayerMutation(ctx, p, async (_db, staged) => {
        if (!permitted(p)) return null;
        const shop = ctx.templates.shop.get(1123301), template = shop && ctx.templates.findItem(shop.TemplateID);
        const reward = template && createItemBox(ctx.templates.itemBoxes.get(template.TemplateID));
        if (!shop || !template || shop.APrice1 !== -1 || shop.AValue1 <= 0 || !reward || reward.gold <= 0) return null;
        const cost = count * shop.AValue1, gold = count * reward.gold;
        if (!integer(cost) || !integer(gold) || !integer(staged.info.Gold + gold)) return null;
        if (staged.info.Money + staged.info.MoneyLock < cost) {
          reason = "insufficient_money"; message = `购买需要${cost}点券，当前点券不足。`; return null;
        }
        staged.removeMoney(cost); staged.addGold(gold);
        return { value: { cost, gold } };
      });
    } catch (error) {
      if (error instanceof PlayerMutationCommittedError) { result = error.value as { cost: number; gold: number }; ctx.log.error("Gold box notification failed after commit", error); }
      else { ctx.log.error("Gold box purchase transaction failed", error); return reject(ctx, p, 126, "save_failed", "购买保存失败，未扣除点券，请稍后重试。"); }
    }
    if (!result) return reject(ctx, p, 126, reason, message);
    ctx.log.info("purchase completed", { code: 126, playerId: p.id, count, money: result.cost, gold: result.gold });
    p.sendMessage(0, `金币宝箱购买成功，获得${result.gold}金币。`);
  });
}
