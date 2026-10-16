/**
 * Mail (01 §6): 116 SEND_MAIL, 113 GET_MAIL_ATTACHMENT, 112 DELETE_MAIL, 114 UPDATE_MAIL, 118 MAIL_CANCEL.
 * The list itself is HTTP (LoadUserMail.ashx / MailSenderList.ashx in apps/api); 117 MAIL_RESPONSE makes the client
 * reload it. Attachments are Sys_Users_Goods rows with UserID = 0 referenced by Annex1..5.
 *
 * Anti-dupe: an annex is cleared from the mail with a conditional UPDATE (only if it still holds that ItemID)
 * before the item is given, so a repeated/concurrent packet can never hand out the same row twice; items that do
 * not fit stay in the mail (the original removed them first and could lose them).
 */
import { and, eq } from "drizzle-orm";
import { player } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { findUserIdByNickName } from "../db/characters.js";
import { saveItem } from "../db/items.js";
import { sendMail } from "../db/social.js";
import { ItemInfo, type GoodsRow } from "../game/item.js";
import type { GamePlayer } from "../game/player.js";
import * as Out from "../packets/out.js";
import type { ServerContext } from "../session/context.js";
import type { HandlerRegistry } from "./registry.js";

const M = player.User_Messages;
const G = player.Sys_Users_Goods;
type AnnexKey = "Annex1" | "Annex2" | "Annex3" | "Annex4" | "Annex5";
const ANNEX: AnnexKey[] = ["Annex1", "Annex2", "Annex3", "Annex4", "Annex5"];

async function getMail(ctx: ServerContext, userId: number, mailId: number) {
  return (await ctx.db.db.select().from(M).where(and(eq(M.ID, mailId), eq(M.ReceiverID, userId), eq(M.IsExist, true))).limit(1))[0] ?? null;
}

/** MailGetAttachHandler.GetAnnex: moves the annex row into the player's bag. False = no space (row untouched). */
async function takeAnnex(ctx: ServerContext, p: GamePlayer, mailId: number, key: AnnexKey, itemId: number): Promise<boolean | null> {
  const db = ctx.db.db;
  const row = (await db.select().from(G).where(eq(G.ItemID, itemId)).limit(1))[0] as GoodsRow | undefined;
  const t = row ? ctx.templates.findItem(row.TemplateID) : undefined;
  if (!row || !t || row.UserID !== 0) {
    await db.update(M).set({ [key]: null }).where(eq(M.ID, mailId));
    return null; // dangling annex: drop it
  }
  const inv = p.getItemInventory(t);
  if (!inv || inv.findFirstEmptySlot() < 0) return false;
  const claimed = await db.update(M).set({ [key]: null }).where(and(eq(M.ID, mailId), eq(M[key], String(itemId)))).returning({ ID: M.ID });
  if (!claimed.length) return null;
  const item = ItemInfo.fromRow(row, t);
  item.UserID = p.id;
  item.IsExist = true;
  if (!inv.addItem(item)) {
    await db.update(M).set({ [key]: String(itemId) }).where(eq(M.ID, mailId));
    return false;
  }
  await saveItem(db, item);
  return true;
}

export function registerMail(r: HandlerRegistry): void {
  /** UserUpdateMailHandler.cs: mark read (ValidDate 72 h for Type < 100). */
  r.player(114, "UPDATE_MAIL", async (ctx, p, pkt) => {
    const id = pkt.readInt();
    const m = await getMail(ctx, p.id, id);
    const out = new GSPacket(114, p.id);
    if (m && !m.IsRead) {
      await ctx.db.db.update(M).set(m.Type < 100 ? { IsRead: true, ValidDate: 72, SendTime: new Date() } : { IsRead: true }).where(eq(M.ID, id));
      out.writeBoolean(true);
    } else out.writeBoolean(false);
    p.send(out);
  });

  /** UserDeleteMailHandler.cs: refused while an annex is still attached. */
  r.player(112, "DELETE_MAIL", async (ctx, p, pkt) => {
    const id = pkt.readInt();
    const out = new GSPacket(112, p.id);
    out.writeInt(id);
    if (p.info.HasBagPassword && p.info.IsLocked) return p.sendMessage(0, ctx.lang.t("Bag.Locked"));
    const m = await getMail(ctx, p.id, id);
    if (!m) out.writeBoolean(false);
    else if (ANNEX.some((k) => Number.parseInt(m[k] ?? "", 10) > 0)) {
      out.writeBoolean(false);
      p.send(Out.mailResponse(p.id, 1));
    } else {
      await ctx.db.db.update(M).set({ IsExist: false, IsDelR: true }).where(eq(M.ID, id));
      p.send(Out.mailResponse(m.SenderID, 1));
      out.writeBoolean(true);
    }
    p.send(out);
  });

  /** MailGetAttachHandler.cs: byte which (0 all, 1-5 annex, 6 gold, 7 money). COD (Type > 100) is paid first. */
  r.player(113, "GET_MAIL_ATTACHMENT", async (ctx, p, pkt) => {
    const id = pkt.readInt();
    const which = pkt.readByte();
    if (p.info.HasBagPassword && p.info.IsLocked) return p.sendMessage(0, ctx.lang.t("Bag.Locked"));
    const db = ctx.db.db;
    const m = await getMail(ctx, p.id, id);
    if (!m) return p.sendMessage(1, ctx.lang.t("MailGetAttachHandler.Falied"));
    const types: number[] = [];
    let msg = "";
    if (m.Type > 100 && m.Money > 0) {
      // MoneyDirect: pay the sender (COD); the claim is atomic so a repeated packet cannot pay twice
      if (p.info.Money + p.info.MoneyLock < m.Money) return p.sendMessage(0, ctx.lang.t("UserBuyItemHandler.NoMoney"));
      const paid = await db.update(M).set({ Money: 0 }).where(and(eq(M.ID, id), eq(M.Money, m.Money))).returning({ ID: M.ID });
      if (!paid.length) return;
      p.removeMoney(m.Money);
      await sendMail(db, {
        SenderID: p.id, Sender: p.info.NickName, ReceiverID: m.SenderID, Receiver: m.Sender, Title: ctx.lang.t("MailGetAttachHandler.Deduct"),
        Content: m.Title ?? "", Money: m.Money, Gold: 0, Type: 1, IsExist: true,
      } as never);
      ctx.world.get(m.SenderID)?.send(Out.mailResponse(m.SenderID, 1));
      msg = ctx.lang.t("MailGetAttachHandler.Deduct");
    }
    if (!m.IsRead) await db.update(M).set({ IsRead: true, ValidDate: 72, SendTime: new Date() }).where(eq(M.ID, id));
    let full = false;
    for (const [i, k] of ANNEX.entries()) {
      if (which !== 0 && which !== i + 1) continue;
      const itemId = Number.parseInt(m[k] ?? "", 10);
      if (!(itemId > 0)) continue;
      const ok = await takeAnnex(ctx, p, id, k, itemId);
      if (ok) types.push(i + 1);
      else if (ok === false) full = true;
    }
    if ((which === 0 || which === 6) && m.Gold > 0) {
      const g = await db.update(M).set({ Gold: 0 }).where(and(eq(M.ID, id), eq(M.Gold, m.Gold))).returning({ ID: M.ID });
      if (g.length) {
        p.addGold(m.Gold);
        types.push(6);
      }
    }
    if ((which === 0 || which === 7) && m.Type < 100 && m.Money > 0) {
      const g = await db.update(M).set({ Money: 0 }).where(and(eq(M.ID, id), eq(M.Money, m.Money))).returning({ ID: M.ID });
      if (g.length) {
        p.info.Money += m.Money;
        p.updateProperties();
        types.push(7);
      }
    }
    if (m.Type > 100 && (m.GiftToken ?? 0) > 0) {
      const g = await db.update(M).set({ GiftToken: 0 }).where(and(eq(M.ID, id), eq(M.GiftToken, m.GiftToken!))).returning({ ID: M.ID });
      if (g.length) {
        p.addGiftToken(m.GiftToken!);
        types.push(8);
      }
    }
    const out = new GSPacket(113, p.id);
    out.writeInt(id);
    out.writeInt(types.length);
    for (const t of types) out.writeInt(t);
    p.send(out);
    if (full) msg = ctx.lang.t("Game.Server.Quests.BagFull");
    p.sendMessage(0, msg || ctx.lang.t("MailGetAttachHandler.Success"));
  });

  /** UserSendMailHandler.cs: 100 gold fee, up to 4 unbound items, money gift or COD price. */
  r.player(116, "SEND_MAIL", async (ctx, p, pkt) => {
    const reply = (ok: boolean) => {
      const o = new GSPacket(116, p.id);
      o.writeBoolean(ok);
      p.send(o);
    };
    const t = (k: string) => ctx.lang.t(k);
    if (p.info.Gold < 100) {
      p.sendMessage(0, "金币不足，无法支付邮件费用。");
      return reply(false);
    }
    const nick = pkt.readString().trim();
    const title = pkt.readString();
    const content = pkt.readString();
    const isPay = pkt.readBoolean();
    const validDate = pkt.readInt();
    const money = pkt.readInt();
    const annex: { bag: number; place: number }[] = [];
    for (let i = 0; i < 4; i++) annex.push({ bag: pkt.readByte(), place: pkt.readInt() });
    if ((money !== 0 || annex.some((a) => a.place !== -1)) && p.info.HasBagPassword && p.info.IsLocked) {
      p.sendMessage(0, t("Bag.Locked"));
      return reply(false);
    }
    const target = ctx.world.getByNick(nick);
    const targetId = target?.id ?? (nick ? await findUserIdByNickName(ctx.db.db, nick) : null);
    if (!targetId || nick === p.info.NickName) {
      p.sendMessage(1, t("UserSendMailHandler.Failed2"));
      return reply(false);
    }
    const items: { item: ItemInfo; bag: number }[] = [];
    const mail: Record<string, unknown> = {
      SenderID: p.id, Sender: p.info.NickName, ReceiverID: targetId, Receiver: nick, IsExist: true, Gold: 0, Money: 0, Title: title, Content: content,
    };
    let remark = t("UserSendMailHandler.AnnexRemark");
    let n = 0;
    for (const a of annex) {
      if (a.place === -1) continue;
      const item = p.getInventory(a.bag)?.getItemAt(a.place) ?? null;
      if (!item || item.IsBinds || items.some((x) => x.item === item)) continue;
      items.push({ item, bag: a.bag });
    }
    if (isPay && (money <= 0 || !items.length)) return reply(false);
    // detach the items first (UserID 0, out of the bag, saved now: ItemID known) so nothing can be used twice
    for (const { item, bag } of items) {
      const inv = p.getInventory(bag)!;
      inv.takeOutItem(item);
      const i = inv.removed.indexOf(item);
      if (i >= 0) inv.removed.splice(i, 1);
      item.UserID = 0;
      item.BagType = -1;
      item.Place = -1;
      item.IsExist = true;
      await saveItem(ctx.db.db, item);
      n++;
      mail[`Annex${n}`] = String(item.ItemID);
      mail[`Annex${n}Name`] = item.template.Name ?? "";
      remark += `${n}、${item.template.Name}x${item.Count};`;
    }
    if (isPay) {
      mail.ValidDate = validDate === 1 ? 1 : 6;
      mail.Type = 101;
      mail.Money = money;
      remark += `${++n}、${t("UserSendMailHandler.PayMoney")}${money};`;
    } else {
      mail.Type = 1;
      if (money > 0 && p.info.Money >= money) {
        mail.Money = money;
        p.removeMoney(money);
        remark += `${++n}、${t("UserSendMailHandler.Money")}${money};`;
      }
    }
    mail.AnnexRemark = remark;
    await sendMail(ctx.db.db, mail as never);
    p.removeGold(100);
    await p.saveIntoDatabase(ctx.db.db);
    p.sendMessage(0, t("UserSendMailHandler.Success"));
    reply(true);
    target?.send(Out.mailResponse(targetId, 1));
    p.send(Out.mailResponse(p.id, 2));
  });

  /** MailPaymentCancelHandler.cs: return a COD mail to its sender (items and all). */
  r.player(118, "MAIL_CANCEL", async (ctx, p, pkt) => {
    const id = pkt.readInt();
    const db = ctx.db.db;
    const m = await getMail(ctx, p.id, id);
    const out = new GSPacket(118, p.id);
    out.writeInt(id);
    if (m && m.Type > 100 && m.Money > 0) {
      await db.update(M).set({ ReceiverID: m.SenderID, Receiver: m.Sender, SenderID: p.id, Sender: p.info.NickName, Type: 1, Money: 0, IsRead: false, SendTime: new Date(), ValidDate: 72 }).where(eq(M.ID, id));
      ctx.world.get(m.SenderID)?.send(Out.mailResponse(m.SenderID, 1));
      p.send(Out.mailResponse(p.id, 1));
      out.writeBoolean(true);
    } else out.writeBoolean(false);
    p.send(out);
  });
}
