/**
 * 192/193/194 AUCTION_ADD / AUCTION_UPDATE / AUCTION_DELETE — auction house. Ports
 * Game.Server/Packets/Client/Auction{Add,Update,Delete}Handler.cs and the settlement half of
 * SqlDataProvider procs SP_Auction_Add/_Update/_Delete/_Scan (research/db/.../procedures).
 * Browsing/search stays HTTP (`Tank.Request/AuctionPageList.ashx`, 01 §7) — not this module.
 *
 * Listing fee is Gold (needGold = max(1, price * 0.03 * {1,3,6} by duration)); the bid/buyout price itself is
 * always Money — the original hard-codes `payType = 1` in AuctionAddHandler regardless of what the client sent,
 * so the Gold-priced branch in AuctionUpdateHandler is dead code here too (kept for shape parity, never reached).
 *
 * Fixes vs the original:
 *  - Every state change (bid, buyout, cancel, expiry) is a single `UPDATE ... WHERE "IsExist" = true RETURNING`;
 *    only the caller that flips the row pays out or refunds, so a retried bid or two overlapping scan ticks
 *    cannot double-pay — same idempotent-UPDATE pattern as mail.ts.
 *  - Settlement tax is applied once (`Server_Config.Cess`, default 10%) to the seller's payout. The original
 *    SP_Auction_Update mail insert applies the tax a second time (`@NewPrice * 0.9`) on top of the already
 *    taxed `@NewPrice` — not reproduced; this handler pays the seller `price - cess` exactly once.
 *  - `IsLimitCount` (a daily listing counter) is not ported.
 */
import { and, eq, sql } from "drizzle-orm";
import { PacketOut } from "@ddt/protocol";
import { player } from "@ddt/db";
import { saveItem } from "../db/items.js";
import { sendMail } from "../db/social.js";
import { ItemInfo } from "../game/item.js";
import type { GamePlayer } from "../game/player.js";
import * as Out from "../packets/out.js";
import type { ServerContext } from "../session/context.js";
import { HandlerRegistry } from "./registry.js";

const A = player.Auction;
type AuctionRow = typeof A.$inferSelect;

/** GameProperties.CustomLimit: "sendattackmail|addaution|PresentGoods|PresentMoney|unknow" default "20|20|20|20|20". */
function limitLevel(ctx: ServerContext, index: number): number {
  const parts = String(ctx.templates.serverConfig.get("CustomLimit") ?? "20|20|20|20|20").split("|");
  return Number(parts[index]) || 0;
}
/** GamePlayer.isPlayerWarrior (same check as forge.ts / use.ts). */
function isWarrior(p: GamePlayer): boolean {
  return (p.extra as { coupleBossBoxNum?: number } | null)?.coupleBossBoxNum === 9;
}
function cess(ctx: ServerContext): number {
  const v = Number(ctx.templates.serverConfig.get("Cess"));
  return Number.isFinite(v) && v >= 0 ? v : 0.1;
}

/** ItemInfo.CloneFromTemplate(goods.Template, goods): copy stats, detach (UserID 0 / BagType -1), fresh count. */
function cloneForAuction(src: ItemInfo, count: number, now: Date): ItemInfo {
  const it = ItemInfo.createFromTemplate(src.template, count, 30);
  it.StrengthenLevel = src.StrengthenLevel; it.StrengthenExp = src.StrengthenExp;
  it.AttackCompose = src.AttackCompose; it.DefendCompose = src.DefendCompose;
  it.LuckCompose = src.LuckCompose; it.AgilityCompose = src.AgilityCompose;
  it.Hole1 = src.Hole1; it.Hole2 = src.Hole2; it.Hole3 = src.Hole3; it.Hole4 = src.Hole4; it.Hole5 = src.Hole5; it.Hole6 = src.Hole6;
  it.Hole5Level = src.Hole5Level; it.Hole5Exp = src.Hole5Exp; it.Hole6Level = src.Hole6Level; it.Hole6Exp = src.Hole6Exp;
  it.Color = src.Color; it.Skin = src.Skin; it.isGold = src.isGold; it.goldValidDate = src.goldValidDate; it.ValidDate = src.ValidDate;
  it.BeginDate = now; it.UserID = 0; it.BagType = -1; it.Place = -1;
  return it;
}

/** Mail a single detached item (or just currency) — same shape as academy.ts's mailTo, kept local on purpose. */
async function mailTo(ctx: ServerContext, toId: number, toNick: string, title: string, content: string, item?: ItemInfo, gold = 0, money = 0, type = 2): Promise<void> {
  const row: Record<string, unknown> = { Content: content, Title: title, Gold: gold, Money: money, Type: type, Receiver: toNick, ReceiverID: toId, Sender: "拍卖行", SenderID: 0 };
  if (item) { row.Annex1 = String(item.ItemID); row.Annex1Name = item.template.Name ?? ""; }
  await sendMail(ctx.db.db, row as never);
  ctx.world.get(toId)?.send(Out.mailResponse(toId, 1));
}

/** AbstractPacketLib.SendAuctionRefresh — own-listing refresh (own panel / confirmation), format unverified
 *  against the live AS3 client this session (no client send/read pair was located); kept internally consistent. */
function auctionRefresh(row: AuctionRow | null, auctionId: number, ok: boolean): PacketOut {
  const p = new PacketOut(192);
  p.writeBoolean(ok);
  p.writeInt(auctionId);
  if (row) {
    p.writeInt(row.TemplateID); p.writeString(row.Name); p.writeInt(row.Category);
    p.writeInt(row.Price); p.writeInt(row.Mouthful); p.writeInt(row.PayType); p.writeInt(row.goodsCount ?? 0);
    p.writeInt(row.ValidDate); Out.wd(p, row.BeginDate); p.writeInt(row.AuctioneerID); p.writeString(row.AuctioneerName);
    p.writeInt(row.BuyerID); p.writeString(row.BuyerName);
  }
  return p;
}

/** AuctionAddHandler.cs — list an item. */
async function add(ctx: ServerContext, p: GamePlayer, pkt: { readByte(): number; readInt(): number }): Promise<void> {
  const bagType = pkt.readByte();
  const place = pkt.readInt();
  pkt.readByte(); // payType from the client is ignored — forced to Money below, like the original
  const price = pkt.readInt();
  const mouthful = pkt.readInt();
  const durationCode = pkt.readInt();
  const goodsCount = pkt.readInt();
  const fail = (key: string, ...args: unknown[]) => p.sendMessage(0, ctx.lang.t(key, ...args));

  if (isWarrior(p)) return p.sendMessage(0, "此账号无权使用该功能。");
  if (p.info.HasBagPassword && p.info.IsLocked) return p.sendMessage(0, ctx.lang.t("Bag.Locked"));
  if (price < 0 || (mouthful !== 0 && mouthful < price)) return; // silent, like the original
  const needGold = Math.max(1, Math.trunc(price * 0.03 * (durationCode === 0 ? 1 : durationCode === 1 ? 3 : 6)));
  const inv = p.getInventory(bagType);
  const goods = inv?.getItemAt(place) ?? null;
  if (!goods) return fail("AuctionAddHandler.Msg13");
  if (goods.Count < goodsCount || goodsCount <= 0) return fail("AuctionAddHandler.Msg11");
  const limit = limitLevel(ctx, 1);
  if (p.info.Grade < limit) return fail("AuctionAddHandler.Msg12", limit);
  if (needGold > p.info.Gold) return fail("AuctionAddHandler.Msg3");
  if (goods.IsBinds) return fail("AuctionAddHandler.Msg5");

  const now = ctx.now();
  const randMin = ctx.templates.cfgInt("BeginAuction", 0);
  const randMax = Math.max(randMin, ctx.templates.cfgInt("EndAuction", 0));
  const random = randMin + Math.floor(Math.random() * (randMax - randMin + 1));
  const validHours = durationCode === 0 ? 8 : durationCode === 1 ? 24 : 48;
  const listed = cloneForAuction(goods, goodsCount, now);
  await saveItem(ctx.db.db, listed);
  inv!.removeCountFromStack(goods, goodsCount);

  const [row] = await ctx.db.db.insert(A).values({
    Name: goods.template.Name ?? "", Category: goods.template.CategoryID ?? 0, AuctioneerID: p.id, AuctioneerName: p.info.NickName ?? "",
    ItemID: listed.ItemID, PayType: 1, Price: price, Rise: Math.max(1, Math.trunc(price / 10)), Mouthful: mouthful,
    BeginDate: now, ValidDate: validHours, BuyerID: 0, BuyerName: "", IsExist: true, TemplateID: goods.TemplateID, Random: random, goodsCount,
  }).returning();
  p.removeGold(needGold);
  p.send(auctionRefresh(row!, row!.AuctionID, true));
  p.sendMessage(0, ctx.lang.t("AuctionAddHandler.Msg6"));
}

/** AuctionUpdateHandler.cs — bid or buyout. */
async function update(ctx: ServerContext, p: GamePlayer, pkt: { readInt(): number }): Promise<void> {
  const auctionId = pkt.readInt();
  const money = pkt.readInt();
  const reply = (ok: boolean) => { const g = new PacketOut(193, p.id); g.writeBoolean(ok); g.writeInt(auctionId); p.send(g); };

  if (isWarrior(p)) { p.sendMessage(0, "此账号无权使用该功能。"); return reply(false); }
  const limit = limitLevel(ctx, 0);
  if (p.info.Grade < limit) { p.sendMessage(0, `需要达到${limit}级才能进行此操作！`); return reply(false); }
  if (p.info.HasBagPassword && p.info.IsLocked) { p.sendMessage(0, ctx.lang.t("Bag.Locked")); return reply(false); }

  const [row] = await ctx.db.db.select().from(A).where(and(eq(A.AuctionID, auctionId), eq(A.IsExist, true))).limit(1);
  let msg = "AuctionUpdateHandler.Fail";
  let ok = false;
  let resultRow: AuctionRow | null = row ?? null;
  if (!row) msg = "AuctionUpdateHandler.Msg1";
  else if (money > p.info.Money + p.info.MoneyLock) msg = "AuctionUpdateHandler.Msg2";
  else if (row.BuyerID === 0 && row.Price > money) msg = "AuctionUpdateHandler.Msg4";
  else if (row.BuyerID !== 0 && row.Price + row.Rise > money && (row.Mouthful === 0 || row.Mouthful > money)) msg = "AuctionUpdateHandler.Msg5";
  else {
    const buyout = row.Mouthful !== 0 && money >= row.Mouthful;
    const newPrice = buyout ? row.Mouthful : money;
    const upd = await ctx.db.db.update(A).set({ BuyerID: p.id, BuyerName: p.info.NickName ?? "", Price: newPrice, IsExist: !buyout })
      .where(and(eq(A.AuctionID, auctionId), eq(A.IsExist, true))).returning();
    if (upd.length) {
      ok = true;
      resultRow = upd[0]!;
      p.removeMoney(newPrice);
      if (row.BuyerID !== 0) await mailTo(ctx, row.BuyerID, row.BuyerName, `竞价被超过：${row.Name}`, `你对${row.Name}的出价已被${p.info.NickName ?? ""}超过，退还原出价${row.Price}点券。`, undefined, 0, row.Price, 5);
      msg = buyout ? "AuctionUpdateHandler.Msg7" : "AuctionUpdateHandler.Msg6";
      if (buyout) await settle(ctx, resultRow);
    }
  }
  p.send(auctionRefresh(resultRow, auctionId, resultRow?.IsExist ?? false));
  if (msg) p.sendMessage(0, ctx.lang.t(msg));
  reply(ok);
}

/** AuctionDeleteHandler.cs — seller cancels (only while unsold). */
async function remove(ctx: ServerContext, p: GamePlayer, pkt: { readInt(): number }): Promise<void> {
  const auctionId = pkt.readInt();
  const [row] = await ctx.db.db.select().from(A).where(and(eq(A.AuctionID, auctionId), eq(A.AuctioneerID, p.id), eq(A.IsExist, true))).limit(1);
  let msg = "AuctionDeleteHandler.Fail";
  if (row && row.BuyerID === 0) {
    const upd = await ctx.db.db.update(A).set({ IsExist: false }).where(and(eq(A.AuctionID, auctionId), eq(A.IsExist, true))).returning();
    if (upd.length) {
      msg = "AuctionDeleteHandler.Succeed";
      const it = await itemById(ctx, row.ItemID);
      await mailTo(ctx, p.id, p.info.NickName ?? "", "拍卖取消", "拍卖已取消，道具已退回附件。", it ?? undefined, 0, 0, 3);
    }
  }
  p.send(auctionRefresh(null, auctionId, false));
  p.sendMessage(0, ctx.lang.t(msg));
}

async function itemById(ctx: ServerContext, itemId: number): Promise<ItemInfo | null> {
  const rows = await ctx.db.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, itemId)).limit(1);
  const r = rows[0];
  if (!r) return null;
  const t = ctx.templates.findItem(r.TemplateID);
  return t ? ItemInfo.fromRow(r, t) : null;
}

/** Settle a closed auction (buyout or Scan-found expiry): mail the item to the buyer (or back to the seller if
 *  unsold) and the (taxed) proceeds to the seller. `row` must already be the post-update state (IsExist=false). */
async function settle(ctx: ServerContext, row: AuctionRow): Promise<void> {
  const it = await itemById(ctx, row.ItemID);
  if (row.BuyerID === 0) {
    await mailTo(ctx, row.AuctioneerID, row.AuctioneerName, `拍卖到期：${row.Name}`, `${row.Name}到期未成交，道具已退回附件。`, it ?? undefined, 0, 0, 3);
    return;
  }
  const net = Math.round(row.Price - cess(ctx) * row.Price);
  await mailTo(ctx, row.BuyerID, row.BuyerName, `竞拍成功：${row.Name}`, `你以${row.Price}点券拍得${row.AuctioneerName}出售的${row.Name}，道具已放入附件。`, it ?? undefined, 0, 0, 4);
  if (row.AuctioneerID !== row.BuyerID) await mailTo(ctx, row.AuctioneerID, row.AuctioneerName, `拍卖成交：${row.Name}`, `${row.BuyerName}以${row.Price}点券拍得你的${row.Name}，扣除手续费后的所得已放入附件。`, undefined, 0, net, 2);
}

/** SP_Auction_Scan — periodic expiry. Call from a timer; safe to call concurrently/often (idempotent UPDATE). */
export async function scanExpiredAuctions(ctx: ServerContext): Promise<number> {
  const now = ctx.now();
  const expired = await ctx.db.db.execute(sql`SELECT * FROM player."Auction" WHERE "IsExist" = true AND EXTRACT(EPOCH FROM (${now}::timestamp - "BeginDate")) / 3600.0 > "ValidDate"`);
  const rows = (Array.isArray(expired) ? expired : ((expired as { rows?: unknown[] }).rows ?? [])) as AuctionRow[];
  let n = 0;
  for (const r of rows) {
    const upd = await ctx.db.db.update(A).set({ IsExist: false }).where(and(eq(A.AuctionID, r.AuctionID), eq(A.IsExist, true))).returning();
    if (!upd.length) continue;
    await settle(ctx, { ...r, IsExist: false });
    n++;
  }
  return n;
}

export function registerAuction(r: HandlerRegistry): void {
  r.player(192, "AUCTION_ADD", (ctx, p, pkt) => add(ctx, p, pkt), "partial");
  r.player(193, "AUCTION_UPDATE", (ctx, p, pkt) => update(ctx, p, pkt), "partial");
  r.player(194, "AUCTION_DELETE", (ctx, p, pkt) => remove(ctx, p, pkt), "implemented");
}
