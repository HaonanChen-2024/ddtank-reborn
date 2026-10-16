/**
 * 233-253, 213, 249 Marriage & church (01 §11). Ports Packets/Client/Marry*.cs, DivorceApplyHandler.cs,
 * UserEnterMarrySceneHandler.cs, UserLeaveMarryRoom.cs, SceneMarryRooms/* (chapel rooms + 249 MARRY_CMD subs),
 * procs SP_Insert_Marry_Notice / SP_Users_Marry (marriage/divorce side-effects on Sys_Users_Detail),
 * SP_MarryInfo_Add/_Update/_Delete (matchmaking board), SP_Insert_Marry_Room_Info / SP_Update_Marry_Room_Info
 * (chapel rooms). Chapel rooms are in-memory only (like PvP/PvE rooms) — a Marry_Room_Info row is still written
 * for the admin panel / audit trail, but is not reloaded into a live room on restart.
 *
 * Fixes vs the original:
 *  - 248 DIVORCE_APPLY charged `PRICE_DIVORCED(_DISCOUNT)` twice: `MoneyDirect` already deducts it on success,
 *    then the handler called `RemoveMoney` again unconditionally. This port charges once.
 *  - 237 vs 253 code collision: the client sends board-description edits (`sendModifyMarryInfo`-style
 *    {bool isPublishEquip, str intro}) on 237 MARRYINFO_UPDATE and chapel-room edits
 *    (`sendModifyChurchDiscription` {str name, bool changePwd, str pwd, str intro}) on 253
 *    MARRY_ROOM_INFO_UPDATE, but the original registered the chapel-room handler (MarryRoomInfoUpdateHandler) on
 *    237 — so a board edit from the client was parsed with the wrong field layout. This port gives each shape
 *    its own code: 237 = board update, 253 = chapel-room update.
 *
 * Wire formats confirmed against the live AS3 client (`Source Flash/src/ddt/manager/ChurchManager.as`):
 * 246 MARRY_STATUS reply, 247 MARRY_APPLY notice, 250 MARRY_APPLY_REPLY, 248 DIVORCE_APPLY reply, 234 "LoadMarryProp"
 * (sent here as part of the 247/250/248 flows), 242 MARRY_ROOM_LOGIN / SendMarryRoomInfo, 249/4 INVITE. The other
 * 249 MARRY_CMD sub-replies and 253/237/236/235 are best-effort (no AS3 reader was located this pass) — correctness
 * of money/state/DB is covered by tests; exact client rendering of those few packets is unverified.
 */
import { and, eq } from "drizzle-orm";
import { PacketOut } from "@ddt/protocol";
import { player } from "@ddt/db";
import { saveItem } from "../db/items.js";
import { sendMail } from "../db/social.js";
import { ItemInfo } from "../game/item.js";
import type { GamePlayer } from "../game/player.js";
import * as Out from "../packets/out.js";
import type { ServerContext } from "../session/context.js";
import { SubRouter, type HandlerRegistry } from "./registry.js";

const DETAIL = player.Sys_Users_Detail;
const MARRY_INFO = player.Marry_Info;
const MARRY_ROOM = player.Marry_Room_Info;

const RING_TEMPLATE = 11103;
const WEDDING_RING_TEMPLATE = 9022;
const GOOD_MAN_CARD_TEMPLATE = 11105;

function limitLevel(ctx: ServerContext, index: number): number {
  const parts = String(ctx.templates.serverConfig.get("CustomLimit") ?? "20|20|20|20|20").split("|");
  return Number(parts[index]) || 0;
}
const PRICE_DIVORCED = (ctx: ServerContext) => ctx.templates.cfgInt("DivorcedMoney", 2000);
const PRICE_DIVORCED_DISCOUNT = (ctx: ServerContext) => ctx.templates.cfgInt("DivorcedMoneyDiscount", 1000);
const PRICE_PROPOSE = (ctx: ServerContext) => ctx.templates.cfgInt("HymenealMoney", 500);
const PRICE_MARRY_ROOM = (hours: number) => (hours === 2 ? 700 : hours === 3 ? 900 : 1000);

interface ChapelRoom {
  id: number; name: string; pwd: string; mapIndex: number; maxCount: number; guestInvite: boolean; introduction: string;
  creatorId: number; creatorName: string; groomID: number; groomName: string; brideID: number; brideName: string;
  createTime: Date; availHours: number; breakTime: Date; isHymeneal: boolean; isGunsaluteUsed: boolean; started: boolean;
  members: Set<GamePlayer>; forbidden: Set<number>; mapByPlayer: Map<number, number>;
}
const roomsByCtx = new WeakMap<ServerContext, Map<number, ChapelRoom>>();
let roomSeq = 1;
function rooms(ctx: ServerContext): Map<number, ChapelRoom> {
  let m = roomsByCtx.get(ctx);
  if (!m) roomsByCtx.set(ctx, (m = new Map()));
  return m;
}
function roomOf(ctx: ServerContext, p: GamePlayer): ChapelRoom | undefined {
  for (const r of rooms(ctx).values()) if (r.members.has(p)) return r;
  return undefined;
}
function isCouple(r: ChapelRoom, id: number): boolean { return id === r.groomID || id === r.brideID; }
function broadcast(r: ChapelRoom, pkt: PacketOut, except?: GamePlayer): void {
  for (const m of r.members) if (m !== except) m.send(pkt);
}

/** AbstractPacketLib.SendMarryRoomInfo (242) — also used for the 240 scene-list broadcast and the 241 create echo. */
function roomInfoPacket(r: ChapelRoom | null): PacketOut {
  const p = new PacketOut(242);
  p.writeBoolean(!!r);
  if (!r) return p;
  p.writeInt(r.id); p.writeString(r.name); p.writeInt(r.mapIndex); p.writeInt(r.availHours); p.writeInt(r.members.size);
  p.writeInt(r.creatorId); p.writeString(r.creatorName); p.writeInt(r.groomID); p.writeString(r.groomName);
  p.writeInt(r.brideID); p.writeString(r.brideName); Out.wd(p, r.createTime); p.writeBoolean(r.started);
  p.writeByte(r.isHymeneal ? 2 : 1); p.writeString(r.introduction); p.writeBoolean(r.guestInvite);
  p.writeInt(1); p.writeBoolean(r.isGunsaluteUsed);
  return p;
}
function marryPropPacket(c: { IsMarried: boolean; SpouseID: number; SpouseName: string | null; IsCreatedMarryRoom: boolean; SelfMarryRoomID: number; IsGotRing: boolean }): PacketOut {
  const p = new PacketOut(234);
  p.writeBoolean(c.IsMarried); p.writeInt(c.SpouseID); p.writeString(c.SpouseName ?? "");
  p.writeBoolean(c.IsCreatedMarryRoom); p.writeInt(c.SelfMarryRoomID); p.writeBoolean(c.IsGotRing);
  return p;
}
function statusPacket(targetId: number, isMarried: boolean): PacketOut {
  const p = new PacketOut(246); p.writeInt(targetId); p.writeBoolean(isMarried); return p;
}
function applyNoticePacket(proposerId: number, proposerNick: string, love: string, noticeId: number): PacketOut {
  const p = new PacketOut(247); p.writeInt(proposerId); p.writeString(proposerNick); p.writeString(love); p.writeInt(noticeId); return p;
}
function applyReplyPacket(otherId: number, accepted: boolean, otherNick: string, isApplicant: boolean): PacketOut {
  const p = new PacketOut(250); p.writeInt(otherId); p.writeBoolean(accepted); p.writeString(otherNick); p.writeBoolean(isApplicant); return p;
}
function divorceReplyPacket(ok: boolean, discount: boolean): PacketOut {
  const p = new PacketOut(248); p.writeBoolean(ok); p.writeBoolean(discount); return p;
}
function marryInfoRefreshPacket(row: { ID: number; IsPublishEquip: boolean; Introduction: string | null } | null, infoId: number, exists: boolean): PacketOut {
  const p = new PacketOut(235); p.writeInt(infoId); p.writeBoolean(exists);
  if (row) { p.writeInt(row.ID); p.writeBoolean(row.IsPublishEquip); p.writeString(row.Introduction ?? ""); }
  return p;
}

async function setMarried(ctx: ServerContext, userId: number, v: { IsMarried: boolean; SpouseID: number; SpouseName: string; IsCreatedMarryRoom?: boolean; SelfMarryRoomID?: number; IsGotRing?: boolean }): Promise<void> {
  const online = ctx.world.get(userId);
  const patch: Record<string, unknown> = { IsMarried: v.IsMarried, SpouseID: v.SpouseID, SpouseName: v.SpouseName };
  if (v.IsCreatedMarryRoom !== undefined) patch.IsCreatedMarryRoom = v.IsCreatedMarryRoom;
  if (v.SelfMarryRoomID !== undefined) patch.SelfMarryRoomID = v.SelfMarryRoomID;
  if (v.IsGotRing !== undefined) patch.IsGotRing = v.IsGotRing;
  if (online) Object.assign(online.info, patch);
  await ctx.db.db.update(DETAIL).set(patch).where(eq(DETAIL.UserID, userId));
}

async function mailItem(ctx: ServerContext, toId: number, toNick: string, title: string, content: string, item?: ItemInfo, money = 0): Promise<void> {
  const row: Record<string, unknown> = { Content: content, Title: title, Gold: 0, Money: money, Type: 14, Receiver: toNick, ReceiverID: toId, Sender: "Igreja", SenderID: 0 };
  if (item) { row.Annex1 = String(item.ItemID); row.Annex1Name = item.template.Name ?? ""; }
  await sendMail(ctx.db.db, row as never);
  ctx.world.get(toId)?.send(Out.mailResponse(toId, 1));
}

function findShop(ctx: ServerContext, templateId: number) {
  for (const s of ctx.templates.shop.values()) if (s.TemplateID === templateId) return s;
  return undefined;
}

export function marryCmdRouter(): SubRouter {
  return new SubRouter("byte", "MARRY_CMD")
    .on(1, "MOVE", (ctx, p, pkt) => { // int x, int y
      const x = pkt.readInt(), y = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r) return;
      const out = new PacketOut(249, p.id); out.writeByte(1); out.writeInt(x); out.writeInt(y);
      broadcast(r, out, p);
    })
    .on(10, "POSITION", (ctx, p, pkt) => {
      const x = pkt.readInt(), y = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r) return;
      const out = new PacketOut(249, p.id); out.writeByte(10); out.writeInt(x); out.writeInt(y);
      broadcast(r, out, p);
    })
    .on(2, "HYMENEAL", async (ctx, p, pkt) => { // int flag (1 = cancel)
      const flag = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r || !isCouple(r, p.id) || !(r.groomID && r.brideID)) return;
      const groom = ctx.world.get(r.groomID), bride = ctx.world.get(r.brideID);
      if (flag === 1) { r.isHymeneal = false; broadcast(r, hymenealPacket(r, false)); return; }
      if (!groom || !bride) return;
      const firstTime = !groom.info.IsGotRing && !bride.info.IsGotRing;
      if (!firstTime) {
        const price = PRICE_PROPOSE(ctx);
        if (p.info.Money + p.info.MoneyLock < price) return p.sendMessage(0, "所需货币不足。");
        p.removeMoney(price);
      } else {
        const ring = ctx.templates.findItem(WEDDING_RING_TEMPLATE);
        if (ring) {
          await mailItem(ctx, groom.id, groom.info.NickName ?? "", "结婚戒指", "结婚戒指", ItemInfo.createFromTemplate(ring, 1, 102));
          await mailItem(ctx, bride.id, bride.info.NickName ?? "", "结婚戒指", "结婚戒指", ItemInfo.createFromTemplate(ring, 1, 102));
        }
        await setMarried(ctx, groom.id, { IsMarried: true, SpouseID: groom.info.SpouseID, SpouseName: groom.info.SpouseName ?? "", IsGotRing: true });
        await setMarried(ctx, bride.id, { IsMarried: true, SpouseID: bride.info.SpouseID, SpouseName: bride.info.SpouseName ?? "", IsGotRing: true });
      }
      r.isHymeneal = true;
      broadcast(r, hymenealPacket(r, true));
      setTimeout(() => { r.isHymeneal = false; broadcast(r, hymenealPacket(r, false)); }, 170_000);
    })
    .on(3, "CONTINUATION", async (ctx, p, pkt) => { // int hours (2/3/4)
      const hours = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r || !isCouple(r, p.id)) return;
      const price = PRICE_MARRY_ROOM(hours);
      const half = Math.ceil(price / 2);
      const groom = ctx.world.get(r.groomID), bride = ctx.world.get(r.brideID);
      if (((groom?.info.Money ?? 0) + (groom?.info.MoneyLock ?? 0)) < half || ((bride?.info.Money ?? 0) + (bride?.info.MoneyLock ?? 0)) < (price - half)) return p.sendMessage(0, "所需货币不足。");
      groom?.removeMoney(half); bride?.removeMoney(price - half);
      r.availHours = hours; r.breakTime = new Date(r.breakTime.getTime() + hours * 3_600_000);
      await ctx.db.db.update(MARRY_ROOM).set({ AvailTime: hours, BreakTime: r.breakTime }).where(eq(MARRY_ROOM.ID, r.id));
      broadcast(r, roomInfoPacket(r));
    })
    .on(4, "INVITE", (ctx, p, pkt) => { // int targetId
      const targetId = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r || !(isCouple(r, p.id) || r.guestInvite)) return;
      const target = ctx.world.get(targetId);
      if (!target) return;
      const out = new PacketOut(249, target.id);
      out.writeByte(4); out.writeInt(p.id); out.writeString(p.info.NickName ?? ""); out.writeBoolean(!!p.info.typeVIP); out.writeInt(p.info.VIPLevel ?? 0);
      out.writeInt(r.id); out.writeString(r.name); out.writeString(r.pwd); out.writeInt(0);
      target.send(out);
    })
    .on(5, "LARGESS", async (ctx, p, pkt) => { // int amount
      const amount = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r || amount <= 0) return;
      const limit = limitLevel(ctx, 3);
      if (p.info.Grade < limit) return p.sendMessage(0, `需要达到${limit}级才能使用此功能。`);
      if (p.info.Money + p.info.MoneyLock < amount) return p.sendMessage(0, "所需货币不足。");
      p.removeMoney(amount);
      const half = Math.trunc(amount / 2);
      if (r.groomID) await mailItem(ctx, r.groomID, r.groomName, "婚礼贺礼", `来自${p.info.NickName ?? ""}的婚礼贺礼，请查收附件。`, undefined, half);
      if (r.brideID) await mailItem(ctx, r.brideID, r.brideName, "婚礼贺礼", `来自${p.info.NickName ?? ""}的婚礼贺礼，请查收附件。`, undefined, half);
      broadcast(r, (() => { const o = new PacketOut(249, p.id); o.writeByte(5); o.writeInt(amount); return o; })());
    })
    .on(6, "USEFIRECRACKERS", (ctx, p, pkt) => { // int count, int templateId
      const count = pkt.readInt();
      const templateId = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r) return;
      const shop = findShop(ctx, templateId);
      const price = (shop?.AValue1 ?? 0) * Math.max(1, count);
      if (shop?.AUnit === -2) { if (p.info.Gold < price) return p.sendMessage(0, "所需货币不足。"); p.removeGold(price); }
      else { if (p.info.Money + p.info.MoneyLock < price) return p.sendMessage(0, "所需货币不足。"); p.removeMoney(price); }
      broadcast(r, (() => { const o = new PacketOut(249, p.id); o.writeByte(6); o.writeInt(count); o.writeInt(templateId); return o; })());
    })
    .on(7, "KICK", (ctx, p, pkt) => { // int userId
      const userId = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r || !isCouple(r, p.id)) return;
      const target = [...r.members].find((m) => m.id === userId);
      if (!target) return;
      r.members.delete(target);
      target.send((() => { const o = new PacketOut(244, userId); return o; })());
    })
    .on(8, "FORBID", (ctx, p, pkt) => { // int userId
      const userId = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r || !isCouple(r, p.id)) return;
      r.forbidden.add(userId);
      const target = [...r.members].find((m) => m.id === userId);
      if (target) { r.members.delete(target); target.send((() => { const o = new PacketOut(244, userId); return o; })()); }
    })
    .on(11, "GUNSALUTE", (ctx, p, pkt) => { // int, int templateId
      pkt.readInt(); const templateId = pkt.readInt();
      const r = roomOf(ctx, p);
      if (!r || r.isGunsaluteUsed) return;
      r.isGunsaluteUsed = true;
      broadcast(r, (() => { const o = new PacketOut(249, p.id); o.writeByte(11); o.writeInt(templateId); return o; })());
    });
}
function hymenealPacket(r: ChapelRoom, started: boolean): PacketOut {
  const p = new PacketOut(249); p.writeByte(2); p.writeInt(r.id); p.writeBoolean(started); return p;
}

export function registerMarriage(r: HandlerRegistry): void {
  const cmd = marryCmdRouter();
  r.player(249, "MARRY_CMD", cmd.handler, "partial");

  // MateTimeHandler.cs (85): int userId -> that player's last-login date (now, if the row can't be found at all);
  // the chapel UI uses it to show "last seen" for an offline spouse. Not gated to the spouse — the original
  // handler answers for any userId, online or not.
  r.player(85, "MATE_ONLINE_TIME", async (ctx, p, pkt) => {
    const id = pkt.readInt();
    const online = ctx.world.get(id);
    const lastDate = online ? online.info.LastDate : (await ctx.db.db.select({ LastDate: DETAIL.LastDate }).from(DETAIL).where(eq(DETAIL.UserID, id)).limit(1))[0]?.LastDate ?? new Date();
    const o = new PacketOut(85);
    Out.wd(o, lastDate);
    p.send(o);
  });

  r.player(246, "MARRY_STATUS", async (ctx, p, pkt) => { // int userId
    const id = pkt.readInt();
    const online = ctx.world.get(id);
    const married = online ? online.info.IsMarried : !!(await ctx.db.db.select({ IsMarried: DETAIL.IsMarried }).from(DETAIL).where(eq(DETAIL.UserID, id)).limit(1))[0]?.IsMarried;
    p.send(statusPacket(id, !!married));
  });

  r.player(247, "MARRY_APPLY", async (ctx, p, pkt) => { // int targetId, str proclamation, bool
    const targetId = pkt.readInt();
    const love = pkt.readString();
    pkt.readBoolean();
    if (p.info.IsMarried) return;
    if (p.info.HasBagPassword && p.info.IsLocked) return p.sendMessage(0, ctx.lang.t("Bag.Locked"));
    const target = ctx.world.get(targetId) ?? (await ctx.db.db.select().from(DETAIL).where(eq(DETAIL.UserID, targetId)).limit(1))[0];
    if (!target) return;
    const tSex = "info" in (target as { info?: unknown }) ? (target as GamePlayer).info.Sex : (target as { Sex: boolean }).Sex;
    const tMarried = "info" in (target as { info?: unknown }) ? (target as GamePlayer).info.IsMarried : (target as { IsMarried: boolean }).IsMarried;
    if (tSex === p.info.Sex) return;
    if (tMarried) return p.sendMessage(0, ctx.lang.t("MarryApplyHandler.Msg2"));
    let hadRing = p.propBag.getItemByTemplateID(0, RING_TEMPLATE);
    if (!hadRing) {
      const shop = findShop(ctx, RING_TEMPLATE);
      if (!shop) return p.sendMessage(0, ctx.lang.t("MarryApplyHandler.Msg6"));
      if (p.info.Money + p.info.MoneyLock < shop.AValue1) return;
      p.removeMoney(shop.AValue1);
    } else {
      p.propBag.removeItem(hadRing);
    }
    const [row] = await ctx.db.db.insert(player.Marry_Apply).values({ UserID: targetId, ApplyUserID: p.id, ApplyUserName: p.info.NickName ?? "", ApplyType: 1, LoveProclamation: love, ApplyResult: false }).returning({ ID: player.Marry_Apply.ID });
    const noticeId = row!.ID;
    p.send(applyNoticePacket(p.id, p.info.NickName ?? "", love, noticeId));
    ctx.world.get(targetId)?.send(applyNoticePacket(p.id, p.info.NickName ?? "", love, noticeId));
    p.sendMessage(0, ctx.lang.t("MarryApplyHandler.Msg3"));
  });

  r.player(250, "MARRY_APPLY_REPLY", async (ctx, p, pkt) => { // bool accept, int proposerId, int answerId
    const accept = pkt.readBoolean();
    const proposerId = pkt.readInt();
    const answerId = pkt.readInt();
    if (accept && p.info.IsMarried) return p.sendMessage(0, ctx.lang.t("MarryApplyReplyHandler.Msg2"));
    const proposer = ctx.world.get(proposerId) ?? (await ctx.db.db.select().from(DETAIL).where(eq(DETAIL.UserID, proposerId)).limit(1))[0];
    if (!proposer) return;
    const proposerNick = "info" in (proposer as { info?: unknown }) ? (proposer as GamePlayer).info.NickName ?? "" : (proposer as { NickName: string | null }).NickName ?? "";
    if (!accept) {
      const card = ctx.templates.findItem(GOOD_MAN_CARD_TEMPLATE);
      await mailItem(ctx, proposerId, proposerNick, ctx.lang.t("MarryApplyReplyHandler.Title"), ctx.lang.t("MarryApplyReplyHandler.Content"), card ? ItemInfo.createFromTemplate(card, 1, 112) : undefined);
    }
    const expired = await ctx.db.db.update(player.Marry_Apply).set({ isDeal: true, isExist: false }).where(and(eq(player.Marry_Apply.ID, answerId), eq(player.Marry_Apply.ApplyType, 1), eq(player.Marry_Apply.isDeal, false))).returning({ ID: player.Marry_Apply.ID });
    if (!expired.length) return;
    if (accept) {
      await setMarried(ctx, p.id, { IsMarried: true, SpouseID: proposerId, SpouseName: proposerNick });
      await setMarried(ctx, proposerId, { IsMarried: true, SpouseID: p.id, SpouseName: p.info.NickName ?? "" });
      p.questInv?.onMarried();
      (proposer as GamePlayer).questInv?.onMarried?.();
    }
    await ctx.db.db.insert(player.Marry_Apply).values({ UserID: p.id, ApplyUserID: proposerId, ApplyUserName: proposerNick, ApplyType: 2, LoveProclamation: "", ApplyResult: accept });
    p.send(applyReplyPacket(proposerId, accept, proposerNick, false));
    if (accept) p.send(marryPropPacket(p.info));
    ctx.world.get(proposerId)?.send(applyReplyPacket(p.id, accept, p.info.NickName ?? "", true));
  });

  r.player(248, "DIVORCE_APPLY", async (ctx, p, pkt) => { // bool discount
    const discount = pkt.readBoolean();
    if (!p.info.IsMarried) return;
    if (p.info.HasBagPassword && p.info.IsLocked) return p.sendMessage(0, ctx.lang.t("Bag.Locked"));
    if (p.info.IsCreatedMarryRoom) return p.sendMessage(0, ctx.lang.t("DivorceApplyHandler.Msg2"));
    const price = discount ? PRICE_DIVORCED_DISCOUNT(ctx) : PRICE_DIVORCED(ctx);
    if (p.info.Money + p.info.MoneyLock < price) return p.sendMessage(0, ctx.lang.t("DivorceApplyHandler.Msg1"));
    p.removeMoney(price); // charged once — see module header ("Fixes vs the original")
    const spouseId = p.info.SpouseID;
    await setMarried(ctx, p.id, { IsMarried: false, SpouseID: 0, SpouseName: "", IsGotRing: false, IsCreatedMarryRoom: false, SelfMarryRoomID: 0 });
    if (spouseId) await setMarried(ctx, spouseId, { IsMarried: false, SpouseID: 0, SpouseName: "", IsGotRing: false, IsCreatedMarryRoom: false, SelfMarryRoomID: 0 });
    await ctx.db.db.insert(player.Marry_Apply).values({ UserID: spouseId, ApplyUserID: p.id, ApplyUserName: p.info.NickName ?? "", ApplyType: 3, LoveProclamation: "", ApplyResult: false });
    p.send(divorceReplyPacket(true, true));
    p.send(marryPropPacket(p.info));
    const spouse = ctx.world.get(spouseId);
    if (spouse) { spouse.send(divorceReplyPacket(true, false)); spouse.send(marryPropPacket(spouse.info)); }
    p.sendMessage(0, ctx.lang.t("DivorceApplyHandler.Msg3"));
  });

  // ---- matchmaking board (236 add / 235 get / 237 update / 234 delete) ----
  r.player(236, "MARRYINFO_ADD", async (ctx, p) => {
    if (p.info.MarryInfoID) return;
    if (p.info.Gold < 10000) return p.sendMessage(0, ctx.lang.t("MarryInfoAddHandler.Msg1"));
    const [row] = await ctx.db.db.insert(MARRY_INFO).values({ UserID: p.id, IsPublishEquip: false, Introduction: "", RegistTime: ctx.now() }).returning();
    p.removeGold(10000);
    p.info.MarryInfoID = row!.ID;
    await ctx.db.db.update(DETAIL).set({ MarryInfoID: row!.ID }).where(eq(DETAIL.UserID, p.id));
    p.send(marryInfoRefreshPacket(row!, row!.ID, true));
    p.sendMessage(0, ctx.lang.t("MarryInfoAddHandler.Msg2"));
  });
  r.player(235, "MARRYINFO_GET", async (ctx, p, pkt) => { // int infoId
    const infoId = pkt.readInt();
    if (!p.info.MarryInfoID) return;
    const [row] = await ctx.db.db.select().from(MARRY_INFO).where(and(eq(MARRY_INFO.ID, infoId), eq(MARRY_INFO.IsExist, true))).limit(1);
    p.send(marryInfoRefreshPacket(row ?? null, infoId, !!row));
  });
  r.player(237, "MARRYINFO_UPDATE", async (ctx, p, pkt) => { // bool isPublishEquip, str introduction — BOARD edit (see header)
    const isPublishEquip = pkt.readBoolean();
    const introduction = pkt.readString();
    if (!p.info.MarryInfoID) return;
    const [row] = await ctx.db.db.select().from(MARRY_INFO).where(eq(MARRY_INFO.ID, p.info.MarryInfoID)).limit(1);
    if (!row) return p.sendMessage(0, ctx.lang.t("MarryInfoUpdateHandler.Msg1"));
    await ctx.db.db.update(MARRY_INFO).set({ IsPublishEquip: isPublishEquip, Introduction: introduction, RegistTime: ctx.now() }).where(eq(MARRY_INFO.ID, row.ID));
    p.send(marryInfoRefreshPacket({ ...row, IsPublishEquip: isPublishEquip, Introduction: introduction }, row.ID, true));
    p.sendMessage(0, ctx.lang.t("MarryInfoUpdateHandler.Succeed"));
  });
  r.player(234, "MARRYPROP_GET", async (ctx, p, pkt) => { // int infoId — board entry delete (MarryInfoDeleteHandler)
    const infoId = pkt.readInt();
    const upd = await ctx.db.db.update(MARRY_INFO).set({ IsExist: false }).where(and(eq(MARRY_INFO.ID, infoId), eq(MARRY_INFO.UserID, p.id), eq(MARRY_INFO.IsExist, true))).returning();
    if (upd.length) { p.info.MarryInfoID = 0; await ctx.db.db.update(DETAIL).set({ MarryInfoID: 0 }).where(eq(DETAIL.UserID, p.id)); }
    p.send(marryInfoRefreshPacket(null, infoId, false));
    p.sendMessage(0, ctx.lang.t(upd.length ? "MarryInfoDeleteHandler.Succeed" : "MarryInfoDeleteHandler.Fail"));
  });

  // ---- chapel scene / rooms ----
  r.player(240, "MARRY_SCENE_LOGIN", (ctx, p) => {
    p.send((() => { const o = new PacketOut(240); o.writeBoolean(true); return o; })());
    for (const room of rooms(ctx).values()) p.send(roomInfoPacket(room));
  });
  r.player(241, "MARRY_ROOM_CREATE", async (ctx, p, pkt) => {
    const name = pkt.readString(); const pwd = pkt.readString(); const mapIndex = pkt.readInt();
    let hours = pkt.readInt(); const maxCount = pkt.readInt(); const guestInvite = pkt.readBoolean(); const intro = pkt.readString();
    if (!p.info.IsMarried || p.info.IsCreatedMarryRoom) return;
    if (p.info.HasBagPassword && p.info.IsLocked) return p.sendMessage(0, ctx.lang.t("Bag.Locked"));
    if (![2, 3, 4].includes(hours)) hours = 4;
    const price = PRICE_MARRY_ROOM(hours);
    if (p.info.Money + p.info.MoneyLock < price) return;
    p.removeMoney(price);
    const spouse = ctx.world.get(p.info.SpouseID);
    const groomID = p.info.Sex ? p.info.SpouseID : p.id;
    const groomName = p.info.Sex ? p.info.SpouseName ?? "" : p.info.NickName ?? "";
    const brideID = p.info.Sex ? p.id : p.info.SpouseID;
    const brideName = p.info.Sex ? p.info.NickName ?? "" : p.info.SpouseName ?? "";
    const now = ctx.now();
    const [row] = await ctx.db.db.insert(MARRY_ROOM).values({
      Name: name, PlayerID: p.id, PlayerName: p.info.NickName ?? "", GroomID: groomID, GroomName: groomName, BrideID: brideID, BrideName: brideName,
      Pwd: pwd, AvailTime: hours, MaxCount: Math.max(2, maxCount), GuestInvite: guestInvite, MapIndex: mapIndex, BeginTime: now,
      BreakTime: new Date(now.getTime() + hours * 3_600_000), RoomIntroduction: intro, ServerID: ctx.zoneId, IsHymeneal: false,
    }).returning();
    const room: ChapelRoom = {
      id: row!.ID, name, pwd, mapIndex, maxCount: Math.max(2, maxCount), guestInvite, introduction: intro,
      creatorId: p.id, creatorName: p.info.NickName ?? "", groomID, groomName, brideID, brideName, createTime: now,
      availHours: hours, breakTime: row!.BreakTime, isHymeneal: false, isGunsaluteUsed: false, started: false,
      members: new Set([p]), forbidden: new Set(), mapByPlayer: new Map(),
    };
    rooms(ctx).set(room.id, room);
    await setMarried(ctx, p.id, { IsMarried: true, SpouseID: p.info.SpouseID, SpouseName: p.info.SpouseName ?? "", IsCreatedMarryRoom: true, SelfMarryRoomID: room.id });
    if (spouse) await setMarried(ctx, spouse.id, { IsMarried: true, SpouseID: spouse.info.SpouseID, SpouseName: spouse.info.SpouseName ?? "", SelfMarryRoomID: room.id });
    p.send(roomInfoPacket(room));
    p.send((() => { const o = new PacketOut(242); o.writeBoolean(true); return o; })());
  }, "partial");
  r.player(242, "MARRY_ROOM_LOGIN", async (ctx, p, pkt) => { // int roomId (0 = own), str pwd, int marryMap
    const roomId = pkt.readInt(); const pwd = pkt.readString(); pkt.readInt();
    let room = roomId !== 0 ? rooms(ctx).get(roomId) : [...rooms(ctx).values()].find((r) => isCouple(r, p.id));
    if (!room && roomId === 0 && p.info.SelfMarryRoomID) return p.sendMessage(0, ctx.lang.t("MarryRoomLoginHandler.RoomExist", String(ctx.zoneId), String(p.info.SelfMarryRoomID)));
    if (!room) { p.send(roomInfoPacket(null)); return; }
    if (room.forbidden.has(p.id)) { p.send(roomInfoPacket(null)); return; }
    if (roomId !== 0 && room.pwd && room.pwd !== pwd && !isCouple(room, p.id)) { p.send(roomInfoPacket(null)); return; }
    room.members.add(p);
    p.send(roomInfoPacket(room));
  });
  r.player(244, "PLAYER_EXIT_MARRY_ROOM", (ctx, p) => {
    const r = roomOf(ctx, p);
    if (!r) return;
    r.members.delete(p);
    broadcast(r, (() => { const o = new PacketOut(244, p.id); return o; })());
  });
  r.player(233, "MARRY_SCENE_CHANGE", (ctx, p, pkt) => { // int map (1 or 2)
    const map = pkt.readInt();
    const r = roomOf(ctx, p);
    if (!r) return;
    r.mapByPlayer.set(p.id, map);
    const out = new PacketOut(244, p.id); // leaves the previous map's viewers, like the original
    broadcast(r, out, p);
  }, "partial");
  r.player(251, "SCENE_STATE", (ctx, p, pkt) => { pkt.readInt(); const r = roomOf(ctx, p); if (r) p.send(roomInfoPacket(r)); }, "partial");
  r.player(253, "MARRY_ROOM_INFO_UPDATE", async (ctx, p, pkt) => { // str name, bool changePwd, str pwd, str intro — chapel edit (see header)
    const name = pkt.readString(); const changePwd = pkt.readBoolean(); const pwd = pkt.readString(); const intro = pkt.readString();
    const r = roomOf(ctx, p);
    if (!r || r.creatorId !== p.id) return;
    r.name = name; r.introduction = intro;
    if (changePwd) r.pwd = pwd;
    await ctx.db.db.update(MARRY_ROOM).set({ Name: name, Pwd: r.pwd, RoomIntroduction: intro }).where(eq(MARRY_ROOM.ID, r.id));
    broadcast(r, roomInfoPacket(r));
    p.sendMessage(0, ctx.lang.t("MarryRoomInfoUpdateHandler.Successed"));
  }, "partial");
}
