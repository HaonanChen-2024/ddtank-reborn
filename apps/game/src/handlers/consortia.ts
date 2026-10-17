/**
 * 129 CONSORTIA_CMD (ConsortiaHandler -> ConsortiaLogicProcessor, int sub ConsortiaPackageType) — ports of
 * Game.Server/Consortia/Handle/*.cs. Replies are 129 {byte sub, …}; the center broadcasts (128 CONSORTIA_RESPONSE,
 * LoginServerConnector.SendConsortia* / Handle*) are local loops over the online members.
 * Permission and cost rules: src/game/consortia.ts; procedures: src/db/consortia.ts.
 */
import { PacketOut, type GSPacket } from "@ddt/protocol";
import * as Db from "../db/consortia.js";
import { sendMail } from "../db/social.js";
import { CREATE_MONEY, MAIL_RICHES, TASK_RESET_MONEY, Right, buffTypeForGroup, checkBadge, checkCreate, defaultByteCount, donationRiches, fightRewards, hasRight, personalRiches, skillCost, upgradeMsg, upgradeNoticeKey, type UpgradeKind } from "../game/consortia.js";
import { ConsortiaMgr, consortiaMgr } from "../game/consortia-mgr.js";
import type { GamePlayer } from "../game/player.js";
import * as Out from "../packets/out.js";
import type { ServerContext } from "../session/context.js";
import { SubRouter, type HandlerRegistry } from "./registry.js";

/** eMessageType.GM_NOTICE / Normal = 0, ChatNormal = 2. */
const GM_NOTICE = 0;

function reply(sub: number, playerId = 0): PacketOut {
  const p = new PacketOut(129, playerId);
  p.writeByte(sub);
  return p;
}

function lastRequest(p: GamePlayer): { t: number } {
  const o = p as unknown as { __consortiaLast?: { t: number } };
  return (o.__consortiaLast ??= { t: 0 });
}

/** 128.1 (SendConsortiaUserPass) — the joined member's ConsortiaUserInfo. */
function userPassPacket(j: Db.JoinedMember, isInvite: boolean, otherId: number, otherName: string): PacketOut {
  const p = ConsortiaMgr.response(1);
  p.writeInt(j.memberRowId); p.writeBoolean(isInvite); p.writeInt(j.consortiaId); p.writeString(j.consortiaName);
  p.writeInt(j.userId); p.writeString(j.userName); p.writeInt(otherId); p.writeString(otherName);
  p.writeInt(j.duty.DutyID); p.writeString(j.duty.DutyName); p.writeInt(j.detail.Offer); p.writeInt(j.detail.RichesOffer); p.writeInt(j.detail.RichesRob);
  Out.wd(p, j.detail.LastDate); p.writeInt(j.detail.Grade); p.writeInt(j.duty.Level); p.writeInt(j.detail.State); p.writeBoolean(j.detail.Sex);
  p.writeInt(j.duty.Right); p.writeInt(j.detail.Win); p.writeInt(j.detail.Total); p.writeInt(j.detail.Escape); p.writeInt(j.repute);
  p.writeString(j.detail.UserName); p.writeInt(j.detail.FightPower); p.writeInt(j.detail.AchievementPoint); p.writeString(j.detail.Honor);
  p.writeInt(j.detail.UseOffer);
  return p;
}

/** HandleConsortiaUserPass: the new member's PlayerInfo is updated, then every member of the guild gets 128.1. */
async function onJoined(ctx: ServerContext, m: ConsortiaMgr, j: Db.JoinedMember, isInvite: boolean, otherId: number, otherName: string): Promise<void> {
  const c = await Db.getConsortia(ctx.db.db, j.consortiaId);
  const joined = ctx.world.get(j.userId);
  if (joined && c) {
    joined.beginChanges();
    m.applyGuild(joined, c);
    Object.assign(joined.info, { DutyName: j.duty.DutyName, DutyLevel: j.duty.Level, Right: j.duty.Right, IsBanChat: false });
    joined.commitChanges();
    joined.send(m.buffPacket(joined, ctx.now()));
  }
  if (c) for (const o of m.online(c.ConsortiaID)) if (o !== joined) o.info.ConsortiaRiches = c.Riches;
  const pkt = userPassPacket(j, isInvite, otherId, otherName);
  for (const o of m.online(j.consortiaId)) o.send(pkt);
}

const MSG = {
  apply: { 2: "ConsortiaBussiness.AddConsortiaApplyUsers.Msg2", 6: "ConsortiaBussiness.AddConsortiaApplyUsers.Msg6", 7: "ConsortiaBussiness.AddConsortiaApplyUsers.Msg7" },
  applyDel: { 2: "ConsortiaBussiness.DeleteConsortiaApplyUsers.Msg2" },
  applyPass: { 2: "ConsortiaBussiness.PassConsortiaApplyUsers.Msg2", 3: "ConsortiaBussiness.PassConsortiaApplyUsers.Msg3", 6: "ConsortiaBussiness.PassConsortiaApplyUsers.Msg6" },
  invite: { 2: "ConsortiaBussiness.AddConsortiaInviteUsers.Msg2", 4: "ConsortiaBussiness.AddConsortiaInviteUsers.Msg4", 5: "ConsortiaBussiness.AddConsortiaInviteUsers.Msg5", 6: "ConsortiaBussiness.AddConsortiaInviteUsers.Msg6" },
  invitePass: { 3: "ConsortiaBussiness.PassConsortiaInviteUsers.Msg3", 6: "ConsortiaBussiness.PassConsortiaInviteUsers.Msg6" },
  disband: { 2: "ConsortiaBussiness.DeleteConsortia.Msg2", 3: "ConsortiaBussiness.DeleteConsortia.Msg3" },
  remove: { 2: "ConsortiaBussiness.DeleteConsortiaUser.Msg2", 3: "ConsortiaBussiness.DeleteConsortiaUser.Msg3", 4: "ConsortiaBussiness.DeleteConsortiaUser.Msg4", 5: "ConsortiaBussiness.DeleteConsortiaUser.Msg5" },
  chairman: { 1: "ConsortiaBussiness.UpdateConsortiaChairman.Msg3", 2: "ConsortiaBussiness.UpdateConsortiaChairman.Msg2" },
  grade: { 2: "ConsortiaBussiness.UpdateConsortiaUserGrade.Msg2", 4: "ConsortiaBussiness.UpdateConsortiaUserGrade.Msg4", 5: "ConsortiaBussiness.UpdateConsortiaUserGrade.Msg5" },
  ban: { 2: "ConsortiaBussiness.UpdateConsortiaIsBanChat.Msg2", 3: "ConsortiaBussiness.UpdateConsortiaIsBanChat.Msg3" },
  dutyDel: { 2: "ConsortiaBussiness.DeleteConsortiaDuty.Msg2", 3: "ConsortiaBussiness.DeleteConsortiaDuty.Msg3" },
  duty: { 2: "ConsortiaBussiness.UpdateConsortiaDuty.Msg2", 3: "ConsortiaBussiness.UpdateConsortiaDuty.Msg3", 4: "ConsortiaBussiness.UpdateConsortiaDuty.Msg3", 5: "ConsortiaBussiness.DeleteConsortiaDuty.Msg5" },
  placard: { 2: "ConsortiaBussiness.UpdateConsortiaPlacard.Msg2" },
  desc: { 2: "ConsortiaBussiness.UpdateConsortiaDescription.Msg2" },
  remark: { 2: "ConsortiaBussiness.UpdateConsortiaUserRemark.Msg2" },
  applyState: { 2: "ConsortiaBussiness.UpdateConsotiaApplyState.Msg2" },
} as const;

function pick(map: Record<number, string>, code: number, dflt: string): string {
  return map[code] ?? dflt;
}

export function consortiaRouter(): SubRouter {
  const r = new SubRouter("int", "CONSORTIA_CMD");

  // 0 ConsortiaTryin.cs
  r.on(0, "CONSORTIA_TRYIN", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID !== 0) return;
    const cid = pkt.readInt();
    const code = await Db.addApply(ctx.db.db, cid, p.id, p.info.NickName ?? "", ctx.now());
    const msg = code === 0 ? (cid !== 0 ? "ConsortiaApplyLoginHandler.ADD_Success" : "ConsortiaApplyLoginHandler.DELETE_Success") : pick(MSG.apply, code, "ConsortiaApplyLoginHandler.ADD_Failed");
    const out = reply(0);
    out.writeInt(cid); out.writeBoolean(code === 0); out.writeString(ctx.lang.t(msg));
    p.send(out);
  });

  // 1 ConsortiaCreate.cs
  r.on(1, "CONSORTIA_CREATE", async (ctx, p, pkt) => {
    const m = await consortiaMgr(ctx);
    const name = pkt.readString();
    const lv1 = m.levels.get(1);
    if (!lv1) return;
    const chk = checkCreate(p.info, name, lv1.NeedGold);
    if (chk === "inGuild") return;
    if (chk === "name") return p.sendMessage(GM_NOTICE, ctx.lang.t("ConsortiaCreateHandler.Long"));
    let ok = false;
    let cid = 0;
    let msg = "ConsortiaCreateHandler.Failed";
    let duty = { Level: 0, DutyName: "", Right: 0 };
    if (chk === "ok") {
      const res = await Db.createConsortia(ctx.db.db, { userId: p.id, nick: p.info.NickName ?? "", name, level: lv1, dutyName: (k, f) => m.t(k, f), now: ctx.now() });
      if (res.code === 0) {
        cid = res.consortiaId!;
        duty = res.duty!;
        p.beginChanges();
        const c = await Db.getConsortia(ctx.db.db, cid);
        if (c) m.applyGuild(p, c);
        Object.assign(p.info, { DutyLevel: duty.Level, DutyName: duty.DutyName, Right: duty.Right, IsBanChat: false });
        p.removeGold(lv1.NeedGold);
        p.removeMoney(CREATE_MONEY);
        p.commitChanges();
        await p.saveIntoDatabase(ctx.db.db);
        ok = true;
        msg = "ConsortiaCreateHandler.Success";
      } else if (res.code === 2) msg = "ConsortiaBussiness.AddConsortia.Msg2";
    }
    const out = reply(1);
    out.writeString(name); out.writeBoolean(ok); out.writeInt(cid); out.writeString(name); out.writeString(ctx.lang.t(msg));
    out.writeInt(duty.Level); out.writeString(duty.DutyName ?? ""); out.writeInt(duty.Right);
    p.send(out);
  });

  // 2 ConsortiaDisband.cs (captcha check not ported: no CHECK_CODE system). Fix: the failure reply had no bool, so
  // the client read the user id as the result flag.
  r.on(2, "CONSORTIA_DISBAND", async (ctx, p) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const cid = p.info.ConsortiaID;
    const name = p.info.ConsortiaName;
    const code = await Db.disbandConsortia(ctx.db.db, cid, p.id);
    let text = ctx.lang.t(pick(MSG.disband, code, "ConsortiaDisbandHandler.Failed"));
    if (code === 0) {
      text = ctx.lang.t("ConsortiaDisbandHandler.Success1") + name + ctx.lang.t("ConsortiaDisbandHandler.Success2");
      // HandleConsortiaDelete: every online member cleared (AddRobRiches(-RichesRob)), then 128.2
      const pk = ConsortiaMgr.response(2);
      pk.writeInt(cid);
      for (const o of m.online(cid)) {
        await m.clearConsortia(o);
        if (o !== p) o.send(pk);
      }
      m.tasks.delete(cid);
      void m.saveTask(null, cid);
    }
    const out = reply(2);
    out.writeBoolean(code === 0); out.writeInt(p.id); out.writeString(text);
    p.send(out);
  });

  // 3 ConsortiaRenegade.cs: leave (own id) or kick
  r.on(3, "CONSORTIA_RENEGADE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const id = pkt.readInt();
    const self = id === p.id;
    const cid = p.info.ConsortiaID;
    const res = await Db.removeMember(ctx.db.db, p.id, id, cid, ctx.now());
    let msg = pick(MSG.remove, res.code, self ? "ConsortiaUserDeleteHandler.ExitFailed" : "ConsortiaUserDeleteHandler.KickFailed");
    if (res.code === 0) {
      msg = self ? "ConsortiaUserDeleteHandler.ExitSuccess" : "ConsortiaUserDeleteHandler.KickSuccess";
      const pk = ConsortiaMgr.response(3);
      pk.writeInt(id); pk.writeInt(cid); pk.writeBoolean(!self); pk.writeString(res.nick ?? ""); pk.writeString(p.info.NickName ?? "");
      const target = ctx.world.get(id);
      const recipients = new Set([...m.online(cid), ...(target ? [target] : [])]);
      if (target) await m.clearConsortia(target);
      if (self) p.send(Out.mailResponse(p.id, 1));
      for (const o of recipients) o.send(pk);
    }
    const out = reply(3);
    out.writeInt(id); out.writeBoolean(res.code === 0); out.writeString(ctx.lang.t(msg));
    p.send(out);
  });

  // 4 ConsortiaTryinPass.cs
  r.on(4, "CONSORTIA_TRYIN_PASS", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const applyId = pkt.readInt();
    const res = await Db.passApply(ctx.db.db, applyId, p.id, p.info.NickName ?? "", p.info.ConsortiaID);
    const ok = typeof res !== "number";
    if (ok) await onJoined(ctx, m, res, false, p.id, p.info.NickName ?? "");
    const out = reply(4);
    out.writeInt(applyId); out.writeBoolean(ok);
    out.writeString(ctx.lang.t(ok ? "ConsortiaApplyLoginPassHandler.Success" : pick(MSG.applyPass, res, "ConsortiaApplyLoginPassHandler.Failed")));
    p.send(out);
  });

  // 5 ConsortiaTryinDel.cs
  r.on(5, "CONSORTIA_TRYIN_DEL", async (ctx, p, pkt) => {
    const applyId = pkt.readInt();
    const code = await Db.deleteApply(ctx.db.db, applyId, p.id, p.info.ConsortiaID);
    const msg = code === 0 ? (p.id === 0 ? "ConsortiaApplyAllyDeleteHandler.Success" : "ConsortiaApplyAllyDeleteHandler.Success2") : pick(MSG.applyDel, code, "ConsortiaApplyAllyDeleteHandler.Failed");
    const out = reply(5);
    out.writeInt(applyId); out.writeBoolean(code === 0); out.writeString(ctx.lang.t(msg));
    p.send(out);
  });

  // 6 ConsortiaRichesOffer.cs
  r.on(6, "CONSORTIA_RICHES_OFFER", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const money = pkt.readInt();
    if (p.info.HasBagPassword && p.info.IsLocked) return p.sendMessage(0, ctx.lang.t("Bag.Locked"));
    const d = donationRiches(money, p.info.Money);
    if (!d.ok) return p.sendMessage(0, d.err === "NoMoney" ? ctx.lang.t("ConsortiaRichesOfferHandler.NoMoney") : "捐献数量无效。");
    const cid = p.info.ConsortiaID;
    const res = await Db.addRiches(ctx.db.db, cid, d.riches, 5, p.info.NickName ?? "", (n, v) => m.t("SP_Consortia_Riches_Add.Msg1", " 成员{0}捐献了{1}公会财富！", n, v));
    if (res.ok) {
      p.beginChanges();
      p.info.RichesOffer += d.riches;
      p.info.RichesRob += d.riches;
      p.removeMoney(money);
      p.commitChanges();
      await p.saveIntoDatabase(ctx.db.db); // the guild riches are already committed: persist the payment now (no crash dupe)
      await m.refreshRiches(cid);
      m.onDonate(p, d.riches);
      const pk = ConsortiaMgr.response(9);
      pk.writeInt(cid); pk.writeInt(p.id); pk.writeString(p.info.NickName ?? ""); pk.writeInt(d.riches);
      // + 128.16 (client: reload ConsortiaList for the own guild) so the other members' screens show the new riches;
      // the original only refreshed the donor's own counter and the chairman saw "riches insufficient" until reentry
      const refresh = ConsortiaMgr.response(16);
      for (const o of m.online(cid)) {
        o.send(pk);
        if (o !== p) o.send(refresh);
      }
    }
    const out = reply(6);
    out.writeInt(money); out.writeBoolean(res.ok); out.writeString(ctx.lang.t(res.ok ? "ConsortiaRichesOfferHandler.Successed" : "ConsortiaRichesOfferHandler.Failed"));
    p.send(out);
  });

  // 7 ConsotiaApplyState.cs
  r.on(7, "CONSORTIA_APPLY_STATE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const open = pkt.readBoolean();
    const code = await Db.setApplyState(ctx.db.db, p.info.ConsortiaID, p.id, open);
    const out = reply(7);
    out.writeBoolean(open); out.writeBoolean(code === 0);
    out.writeString(ctx.lang.t(code === 0 ? "CONSORTIA_APPLY_STATE.Success" : pick(MSG.applyState, code, "CONSORTIA_APPLY_STATE.Failed")));
    p.send(out);
  });

  // 9 ConsortiaDutyDelete.cs
  r.on(9, "CONSORTIA_DUTY_DELETE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const dutyId = pkt.readInt();
    const code = await Db.deleteDuty(ctx.db.db, dutyId, p.info.ConsortiaID);
    const out = reply(9);
    out.writeInt(dutyId); out.writeBoolean(code === 0);
    out.writeString(ctx.lang.t(code === 0 ? "ConsortiaDutyDeleteHandler.Success" : pick(MSG.dutyDel, code, "ConsortiaDutyDeleteHandler.Failed")));
    p.send(out);
  });

  // 10 ConsortiaDutyUpdate.cs: no direct reply, only 128.8
  r.on(10, "CONSORTIA_DUTY_UPDATE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const dutyId = pkt.readInt();
    const type = pkt.readByte();
    let name = "";
    if (type === 1) return;
    if (type === 2) {
      name = pkt.readString();
      if (!name || defaultByteCount(name) > 10) return p.sendMessage(GM_NOTICE, ctx.lang.t("ConsortiaDutyUpdateHandler.Long"));
      pkt.readInt(); // Right: ignored by SP_ConsortiaDuty_Update
    }
    const res = await Db.updateDuty(ctx.db.db, { dutyId, consortiaId: p.info.ConsortiaID, userId: p.id, type, name });
    if (res.code !== 0) return p.sendMessage(GM_NOTICE, ctx.lang.t(pick(MSG.duty, res.code, "ConsortiaDutyUpdateHandler.Failed")));
    m.broadcastDuty(type, p.info.ConsortiaID, 0, "", res.duty!.Level, res.duty!.DutyName, res.duty!.Right, 0, "");
  });

  // 11 ConsortiaInviteAdd.cs
  r.on(11, "CONSORTIA_INVITE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const nick = pkt.readString();
    if (!nick) return;
    const res = await Db.addInvite(ctx.db.db, { consortiaId: p.info.ConsortiaID, inviterId: p.id, inviterName: p.info.NickName ?? "", nick, now: ctx.now() });
    if (res.code === 0) {
      const target = ctx.world.get(res.userId!);
      if (target) {
        const pk = ConsortiaMgr.response(4);
        pk.writeInt(res.id!); pk.writeInt(res.userId!); pk.writeString(nick); pk.writeInt(p.id); pk.writeString(p.info.NickName ?? "");
        pk.writeInt(p.info.ConsortiaID); pk.writeString(res.consortiaName ?? p.info.ConsortiaName);
        target.send(pk);
      }
    }
    const out = reply(11);
    out.writeString(nick); out.writeBoolean(res.code === 0);
    out.writeString(ctx.lang.t(res.code === 0 ? "ConsortiaInviteAddHandler.Success" : pick(MSG.invite, res.code, "ConsortiaInviteAddHandler.Failed")));
    p.send(out);
  });

  // 12 ConsortiaInvitePass.cs — fix: the C# wrote the result fields into the *incoming* packet, so the reply was
  // only {12, id} and the client read garbage.
  r.on(12, "CONSORTIA_INVITE_PASS", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID !== 0) return;
    const m = await consortiaMgr(ctx);
    const inviteId = pkt.readInt();
    const res = await Db.passInvite(ctx.db.db, inviteId, p.id, p.info.NickName ?? "");
    const ok = typeof res !== "number";
    if (ok) await onJoined(ctx, m, res, true, res.otherId, res.otherName);
    const out = reply(12);
    out.writeInt(inviteId); out.writeBoolean(ok); out.writeInt(ok ? res.consortiaId : 0); out.writeString(ok ? res.consortiaName : "");
    out.writeString(ctx.lang.t(ok ? "ConsortiaInvitePassHandler.Success" : pick(MSG.invitePass, res, "ConsortiaInvitePassHandler.Failed")));
    p.send(out);
  });

  // 13 ConsortiaInviteDelete.cs
  r.on(13, "CONSORTIA_INVITE_DELETE", async (ctx, p, pkt) => {
    const id = pkt.readInt();
    const code = await Db.deleteInvite(ctx.db.db, id, p.id);
    const out = reply(13);
    out.writeInt(id); out.writeBoolean(code === 0); out.writeString(ctx.lang.t(code === 0 ? "ConsortiaInviteDeleteHandler.Success" : "ConsortiaInviteDeleteHandler.Failed"));
    p.send(out);
  });

  // 14 ConsortiaDescriptionUpdate.cs / 15 ConsortiaPlacardUpdate.cs
  for (const [sub, field, name, h, map] of [
    [14, "Description", "CONSORTIA_DESCRIPTION_UPDATE", "ConsortiaDescriptionUpdateHandler", MSG.desc],
    [15, "Placard", "CONSORTIA_PLACARD_UPDATE", "ConsortiaPlacardUpdateHandler", MSG.placard],
  ] as const) {
    r.on(sub, name, async (ctx, p, pkt) => {
      const text = pkt.readString();
      if (defaultByteCount(text) > 300) return p.sendMessage(GM_NOTICE, ctx.lang.t(`${h}.Long`));
      const code = p.info.ConsortiaID ? await Db.setText(ctx.db.db, field, p.info.ConsortiaID, p.id, text) : 2;
      const out = reply(sub);
      out.writeString(text); out.writeBoolean(code === 0); out.writeString(ctx.lang.t(code === 0 ? `${h}.Success` : pick(map, code, `${h}.Failed`)));
      p.send(out);
    });
  }

  // 16 ConsortiaIsBanChat.cs
  r.on(16, "CONSORTIA_BANCHAT_UPDATE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const id = pkt.readInt();
    const ban = pkt.readBoolean();
    const res = await Db.setBanChat(ctx.db.db, id, p.info.ConsortiaID, p.id, ban);
    if (res.code === 0) {
      const t = ctx.world.get(res.id!);
      if (t) {
        t.info.IsBanChat = ban;
        const pk = ConsortiaMgr.response(5);
        pk.writeBoolean(ban); pk.writeInt(res.id!); pk.writeString(res.name ?? ""); pk.writeInt(p.id); pk.writeString(p.info.NickName ?? "");
        t.send(pk);
      }
    }
    const out = reply(16);
    out.writeInt(id); out.writeBoolean(ban); out.writeBoolean(res.code === 0);
    out.writeString(ctx.lang.t(res.code === 0 ? "ConsortiaIsBanChatHandler.Success" : pick(MSG.ban, res.code, "ConsortiaIsBanChatHandler.Failed")));
    p.send(out);
  });

  // 17 ConsortiaUserRemark.cs
  r.on(17, "CONSORTIA_USER_REMARK_UPDATE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const id = pkt.readInt();
    const text = pkt.readString();
    if (!text || defaultByteCount(text) > 100) return p.sendMessage(GM_NOTICE, ctx.lang.t("ConsortiaUserRemarkHandler.Long"));
    const code = await Db.setUserRemark(ctx.db.db, id, p.info.ConsortiaID, p.id, text);
    const out = reply(17);
    out.writeInt(id); out.writeString(text); out.writeBoolean(code === 0);
    out.writeString(ctx.lang.t(code === 0 ? "ConsortiaUserRemarkHandler.Success" : pick(MSG.remark, code, "ConsortiaUserRemarkHandler.Failed")));
    p.send(out);
  });

  // 18 ConsortiaUserGradeUpdate.cs
  r.on(18, "CONSORTIA_USER_GRADE_UPDATE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const id = pkt.readInt();
    const up = pkt.readBoolean();
    const res = await Db.updateUserGrade(ctx.db.db, id, p.info.ConsortiaID, p.id, up);
    if (res.code === 0) m.broadcastDuty(up ? 6 : 7, p.info.ConsortiaID, id, res.userName ?? "", res.duty!.Level, res.duty!.DutyName, res.duty!.Right, p.id, p.info.NickName ?? "");
    const out = reply(18);
    out.writeInt(id); out.writeBoolean(up); out.writeBoolean(res.code === 0);
    out.writeString(ctx.lang.t(res.code === 0 ? "ConsortiaUserGradeUpdateHandler.Success" : pick(MSG.grade, res.code, "ConsortiaUserGradeUpdateHandler.Failed")));
    p.send(out);
  });

  // 19 ConsortiaChangeChairman.cs
  r.on(19, "CONSORTIA_CHAIRMAN_CHAHGE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const nick = pkt.readString();
    let ok = false;
    let msg = "ConsortiaChangeChairmanHandler.Failed";
    if (!nick) msg = "ConsortiaChangeChairmanHandler.NoName";
    else if (nick === p.info.NickName) msg = "ConsortiaChangeChairmanHandler.Self";
    else {
      const cid = p.info.ConsortiaID;
      const res = await Db.changeChairman(ctx.db.db, nick, cid, p.id);
      if (res.code === 0) {
        ok = true;
        msg = "ConsortiaChangeChairmanHandler.Success1";
        const cd = res.chairDuty!;
        m.broadcastDuty(9, cid, res.target!.id, res.target!.name, cd.Level, cd.DutyName, cd.Right, 0, "");
        m.broadcastDuty(8, cid, p.id, p.info.NickName ?? "", res.oldDuty!.Level, res.oldDuty!.DutyName, res.oldDuty!.Right, 0, "");
        for (const o of m.online(cid)) o.info.ChairmanName = res.target!.name;
      } else msg = pick(MSG.chairman, res.code, msg);
    }
    const out = reply(19);
    out.writeString(nick); out.writeBoolean(ok);
    out.writeString(ok ? ctx.lang.t(msg) + nick + ctx.lang.t("ConsortiaChangeChairmanHandler.Success2") : ctx.lang.t(msg));
    p.send(out);
  });

  // 20 ConsortiaChat.cs (the client chats through 19 channel 3; the C# echoed the incoming packet, whose int sub
  // did not match the byte sub the client reads — rebuilt as {20, byte, str sender, str msg}).
  r.on(20, "CONSORTIA_CHAT", (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    if (p.info.IsBanChat) return p.sendMessage(GM_NOTICE, ctx.lang.t("ConsortiaChatHandler.IsBanChat"));
    const type = pkt.readByte();
    pkt.readString();
    const text = pkt.readString();
    const out = reply(20, p.id);
    out.writeByte(type); out.writeString(p.info.NickName ?? ""); out.writeString(text);
    for (const o of ctx.world.all()) if (o.info.ConsortiaID === p.info.ConsortiaID) o.send(out);
  });

  // 21 ConsortiaLevelUp.cs
  r.on(21, "CONSORTIA_LEVEL_UP", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const kind = pkt.readByte() as UpgradeKind;
    if (kind < 1 || kind > 5) return;
    const cid = p.info.ConsortiaID;
    const h = ({ 1: "ConsortiaUpGradeHandler", 2: "ConsortiaStoreUpGradeHandler", 3: "ConsortiaShopUpGradeHandler", 4: "ConsortiaSmithUpGradeHandler", 5: "ConsortiaBufferUpGradeHandler" } as const)[kind];
    let msg = `${h}.Failed`;
    let level = 0;
    let ok = false;
    const c = await Db.getConsortia(ctx.db.db, cid);
    const next = m.levels.get((c?.Level ?? 0) + 1);
    if (!c) msg = kind === 5 ? "ConsortiaUpGradeHandler.NoConsortia" : `${h}.NoConsortia`;
    else if (kind === 1 && !next) msg = "ConsortiaUpGradeHandler.NoUpGrade";
    else if (kind === 1 && next!.NeedGold > p.info.Gold) msg = "ConsortiaUpGradeHandler.NoGold";
    else {
      const res = await Db.upgradeBuilding(ctx.db.db, kind, cid, p.id, m.levels);
      if (res.code === 0) {
        ok = true;
        level = res.level!;
        msg = `${h}.Success`;
        if (kind === 1) {
          p.removeGold(next!.NeedGold);
          await p.saveIntoDatabase(ctx.db.db);
        }
        const nc = res.consortia!;
        const sub = ({ 1: 6, 2: 12, 3: 10, 4: 11, 5: 13 } as const)[kind];
        const pk = ConsortiaMgr.response(sub);
        pk.writeInt(cid); pk.writeString(nc.ConsortiaName); pk.writeInt(level);
        for (const o of m.online(cid)) {
          m.applyGuild(o, nc);
          o.send(pk);
          o.updateProperties();
        }
        const nk = upgradeNoticeKey(kind, level);
        if (nk) {
          const notice = new PacketOut(10);
          notice.writeInt(2);
          notice.writeString(ctx.lang.t(nk, nc.ConsortiaName, level));
          for (const o of ctx.world.all()) if (o !== p) o.send(notice);
        }
      } else msg = upgradeMsg(kind, res.code) ?? msg;
    }
    const out = reply(21);
    out.writeByte(kind); out.writeByte(level); out.writeBoolean(ok); out.writeString(ctx.lang.t(msg));
    p.send(out);
  });

  // 22 CConsortiaTask.cs -> ConsortiaTaskLogicProcessor (int ConsortiaTaskType)
  r.on(22, "CONSORTIA_TASK_RELEASE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const sub = pkt.readInt();
    const now = ctx.now();
    const cid = p.info.ConsortiaID;
    switch (sub) {
      case 0: {
        // ReleaseTask.cs: the 4.1 client sends no level (C# read past the end -> 1)
        const level = pkt.dataLeft >= 4 ? pkt.readInt() : 1;
        if (m.activeTask(cid, now)) return p.send(m.taskInfoPacket(m.activeTask(cid, now)));
        const c = await Db.getConsortia(ctx.db.db, cid);
        if (!c) return;
        const cost = m.missionCost(c.Level);
        if (c.Riches < cost || (await Db.spendRiches(ctx.db.db, cid, p.id, cost)) !== 0) return p.sendMessage(GM_NOTICE, m.t("ConsortiaBussiness.Riches.Msg3", "公会财富不足。"));
        await m.refreshRiches(cid);
        m.tasks.delete(cid); // expired one
        const t = m.createTask(cid, level <= 0 ? 1 : level, now);
        for (const o of m.online(cid)) o.send(m.taskInfoPacket(t));
        return;
      }
      case 1: {
        // ResetTask.cs
        if (p.info.Money < TASK_RESET_MONEY) return p.sendMessage(GM_NOTICE, "点券不足，无法刷新任务。");
        p.removeMoney(TASK_RESET_MONEY);
        const t = m.resetTask(cid, now);
        return p.send(m.taskInfoPacket(t));
      }
      case 2: {
        // SumbitTask: SendSumbitTask(true)
        const out = reply(22);
        out.writeByte(2); out.writeBoolean(!!m.activeTask(cid, now));
        return p.send(out);
      }
      case 3:
        return p.send(m.taskInfoPacket(m.activeTask(cid, now)));
    }
  });

  // 23 Donate.cs: unimplemented in the original (logs the item type)
  r.on(23, "DONATE", (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    ctx.log.debug(`consortia donate: undefined itemType ${pkt.readInt()}`);
  }, "stub");

  // 24 ConsortiaEquipControl.cs — fix: reply order matches the client (7 ints, bool, msg); the C# wrote the bool
  // first and no message.
  r.on(24, "CONSORTIA_EQUIP_CONTROL", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const cid = p.info.ConsortiaID;
    const vals: [number, number, number][] = [];
    for (let i = 0; i < 5; i++) vals.push([i + 1, 1, pkt.readInt()]);
    vals.push([0, 2, pkt.readInt()]);
    vals.push([0, 3, pkt.readInt()]);
    let ok = true;
    for (const [level, type, riches] of vals) if ((await Db.setEquipControl(ctx.db.db, cid, p.id, level, type, riches)) !== 0) ok = false;
    const out = reply(24);
    for (const [, , riches] of vals) out.writeInt(riches);
    out.writeBoolean(ok);
    out.writeString(ctx.lang.t(ok ? "ConsortiaEquipControlHandler.Success" : "ConsortiaBussiness.AddAndUpdateConsortiaEuqipControl.Msg2"));
    p.send(out);
  });

  // 25 POLL_CANDIDATE: sent by the client, no handler in the original
  r.on(25, "POLL_CANDIDATE", () => {}, "stub");

  // 26 SkillSocket.cs
  r.on(26, "SKILL_SOCKET", async (ctx, p, pkt, client) => {
    if (p.info.ConsortiaID === 0) return client.disconnect("consortia SKILL_SOCKET without guild");
    const m = await consortiaMgr(ctx);
    const last = lastRequest(p);
    const nowMs = Date.now();
    if (last.t + 2000 > nowMs) return p.sendMessage(0, ctx.lang.t("GoSlow"));
    last.t = nowMs;
    pkt.readBoolean();
    const id = pkt.readInt();
    const days = pkt.readInt();
    const payType = pkt.readInt();
    const buff = m.buffs.get(id);
    if (!buff) return p.sendMessage(GM_NOTICE, ctx.lang.t("Consortia.Msg1"));
    const c = await Db.getConsortia(ctx.db.db, p.info.ConsortiaID);
    if (!c) return;
    const cost = skillCost(buff, days, payType, c, { riches: personalRiches(p.info), medals: p.medal });
    if (!cost.ok) return p.sendMessage(GM_NOTICE, ctx.lang.t(cost.msg));
    const bt = buffTypeForGroup(buff.group);
    if (!bt) return p.sendMessage(GM_NOTICE, ctx.lang.t("Consortia.Msg2"));
    if (cost.source === "guild") {
      if (!(await Db.removeRiches(ctx.db.db, c.ConsortiaID, cost.amount))) return p.sendMessage(GM_NOTICE, ctx.lang.t("Consortia.Msg6"));
      await m.refreshRiches(c.ConsortiaID);
    } else if (cost.source === "player") {
      p.info.RichesOffer = Math.max(0, p.info.RichesOffer - cost.amount);
      p.updateProperties();
    } else p.removeMedal(cost.amount);
    const now = ctx.now();
    const add = (o: GamePlayer) => {
      const ex = o.buffs.find((b) => b.Type === bt.type && b.IsExist && b.BeginDate.getTime() + b.ValidDate * 60_000 > now.getTime());
      if (ex) {
        ex.ValidDate += cost.minutes;
        ex.Value = buff.value;
        ex.Data = String(buff.id);
      } else {
        o.buffs = o.buffs.filter((b) => b.Type !== bt.type);
        o.buffs.push({ UserID: o.id, Type: bt.type, Value: buff.value, BeginDate: now, ValidDate: cost.minutes, TemplateID: 0, ValidCount: 1, Data: String(buff.id), IsExist: true });
      }
      o.send(Out.bufferList(o.id, o.buffs));
      o.send(m.buffPacket(o, now));
    };
    if (bt.guildWide) {
      for (const o of m.online(c.ConsortiaID)) {
        add(o);
        if (o !== p) o.sendMessage(GM_NOTICE, ctx.lang.t("Consortia.Msg3"));
      }
      await Db.saveGuildBuffer(ctx.db.db, { ConsortiaID: c.ConsortiaID, BufferID: buff.id, IsOpen: true, BeginDate: now, ValidDate: cost.minutes, Type: bt.type, Value: buff.value });
    } else add(p);
    p.sendMessage(GM_NOTICE, ctx.lang.t("Consortia.Msg4"));
  });

  // 28 BuyBadge.cs
  r.on(28, "BUY_BADGE", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const badgeId = pkt.readInt();
    const badge = m.badges.get(badgeId);
    if (!badge) return p.sendMessage(0, ctx.lang.t("BuyBadge.BadgeNotFound"));
    const cid = p.info.ConsortiaID;
    const c = await Db.getConsortia(ctx.db.db, cid);
    if (!c) return;
    const chk = checkBadge(c.Riches, badge.Cost, p.info.Right);
    if (chk === "riches") return p.sendMessage(0, m.t("ConsortiaBussiness.Riches.Msg3", "公会财富不足。"));
    const now = ctx.now();
    const buyTime = now.toISOString().slice(0, 19).replace("T", " ");
    const validDate = 30;
    let ok = chk === "ok" && (await Db.setBadge(ctx.db.db, cid, p.id, badgeId, validDate, buyTime)) === 0;
    // the C# deducted the cost afterwards with SP_ConsortiaRiches_Update (Enounce right, same as the badge proc)
    if (ok && (await Db.spendRiches(ctx.db.db, cid, p.id, badge.Cost)) !== 0) ok = false;
    if (ok) {
      await m.refreshRiches(cid);
      for (const o of m.online(cid)) {
        o.info.badgeID = badgeId;
        if (o !== p) o.sendMessage(0, ctx.lang.t("Consortia.Msg7"));
        o.updateProperties();
      }
    }
    const out = reply(28, p.id);
    out.writeInt(cid); out.writeInt(badgeId); out.writeInt(validDate); Out.wd(out, now); out.writeBoolean(ok);
    p.send(out);
    p.sendMessage(0, ctx.lang.t(ok ? "BuyBadgeHandler.Success" : chk === "right" ? "ConsortiaBussiness.BuyBadge.Msg2" : "BuyBadgeHandler.Fail"));
  });

  // 29 ConsortiaMail.cs
  r.on(29, "CONSORTION_MAIL", async (ctx, p, pkt) => {
    if (p.info.ConsortiaID === 0) return;
    const m = await consortiaMgr(ctx);
    const title = pkt.readString();
    const content = pkt.readString();
    const cid = p.info.ConsortiaID;
    const c = await Db.getConsortia(ctx.db.db, cid);
    if (!c) return;
    if (c.Riches < MAIL_RICHES) return p.sendMessage(0, m.t("ConsortiaBussiness.Riches.Msg3", "公会财富不足。"));
    // charge first (SP_ConsortiaRiches_Update needs the Enounce right); the C# mailed first and charged after
    let ok = hasRight(p.info.Right, Right.Enounce) && (await Db.spendRiches(ctx.db.db, cid, p.id, MAIL_RICHES)) === 0;
    if (ok) {
      ok = false;
      for (const mem of await Db.listMembers(ctx.db.db, cid)) {
        if (mem.UserID === p.id) continue;
        await sendMail(ctx.db.db, { SenderID: p.id, Sender: `公会 ${c.ConsortiaName}`, ReceiverID: mem.UserID, Receiver: mem.UserName, Title: title, Content: content, Type: 59, Gold: 0, Money: 0 });
        ok = true;
        ctx.world.get(mem.UserID)?.send(Out.mailResponse(mem.UserID, 1));
      }
      if (!ok) await Db.addRiches(ctx.db.db, cid, MAIL_RICHES, 0, "", () => ""); // nobody to mail: refund
      p.send(Out.mailResponse(p.id, 2));
      await m.refreshRiches(cid);
    }
    const out = reply(29);
    out.writeBoolean(ok);
    p.send(out);
  });

  return r;
}

export function registerConsortia(r: HandlerRegistry): SubRouter {
  const c = consortiaRouter();
  r.player(129, "CONSORTIA_CMD", c.handler);
  return c;
}

/** Login hook: guild buffers (BufferList.LoadFromDatabase: Consortia_Buffer for guild-wide buffs) + 129/26. */
export async function consortiaOnLogin(ctx: ServerContext, p: GamePlayer): Promise<void> {
  const m = await consortiaMgr(ctx);
  const now = ctx.now();
  if (p.info.ConsortiaID) {
    for (const b of await Db.loadGuildBuffers(ctx.db.db, p.info.ConsortiaID)) {
      if (!b.IsOpen || !b.BeginDate || !b.Type || b.BeginDate.getTime() + (b.ValidDate ?? 0) * 60_000 <= now.getTime()) continue;
      if (p.buffs.some((x) => x.Type === b.Type && x.IsExist)) continue;
      p.buffs.push({ UserID: p.id, Type: b.Type, Value: b.Value ?? 0, BeginDate: b.BeginDate, ValidDate: b.ValidDate ?? 0, TemplateID: 0, ValidCount: 1, Data: String(b.BufferID), IsExist: true });
    }
    const t = m.tasks.get(p.info.ConsortiaID);
    if (t && !t.rank.has(p.id)) t.rank.set(p.id, 0);
    p.send(m.buffPacket(p, now)); // BufferList.UpdateChangedBuffers -> SendUpdateConsotiaBuffer (members only here)
  } else {
    p.buffs = p.buffs.filter((b) => !(b.Type > 100 && b.Type < 115));
    await m.returnBankItems(p); // kicked / disbanded while offline (GamePlayer.ClearConsortia(false))
  }
}

/**
 * PVPGame.CalculateGuildMatchResult + ConsortiaMgr.ConsortiaFight (Match rooms only): guild riches and offer for the
 * winning / losing guilds, the "<guild> won" chat line (center 158 -> HandleConsortiaFight, ChatNormal) and, in guild
 * games, PVPGame.GameOver's per-player ConsortiaRichAdd(count + TotalHurt / 2000). Also feeds guild-task conditions.
 * Deviation: guildless players get no ±3 offer in free matches (the C# matched them as "ConsortiaID 0" guilds).
 */
export async function consortiaGameOver(ctx: ServerContext, g: { roomType: number; gameType: number; players: { member: unknown; team: number; win: boolean; totalHurt: number }[] }): Promise<void> {
  const m = await consortiaMgr(ctx);
  const ps = g.players.map((x) => ({ ...x, p: x.member as GamePlayer })).filter((x) => x.p?.info);
  for (const x of ps) m.onGameOver(x.p, { roomType: g.roomType, gameType: g.gameType, isWin: x.win });
  if (g.roomType !== 0) return;
  const winners = ps.filter((x) => x.win);
  const losers = ps.filter((x) => !x.win);
  const winP = winners.at(-1);
  const loseP = losers.at(-1);
  if (!winP || !loseP) return;
  const db = ctx.db.db;
  const totalHurt = ps.reduce((a, x) => a + x.totalHurt, 0);
  const winCid = winP.p.info.ConsortiaID;
  const loseCid = loseP.p.info.ConsortiaID;
  const lv = await Db.guildLevels(db, [winCid, loseCid].filter(Boolean));
  const r = fightRewards({ gameType: g.gameType, roomType: g.roomType, playerCount: ps.length, totalHurt, offerRate: 1, richesRate: 1, winLevel: lv.get(winCid) ?? 0, loseLevel: lv.get(loseCid) ?? 0 });
  if (!r) return;
  if (winCid) await Db.addRiches(db, winCid, r.riches, 0, "", () => "");
  for (const x of ps) {
    const cid = x.p.info.ConsortiaID;
    if (!cid) continue;
    if (cid === winCid) {
      x.p.info.RichesRob += r.riches;
      x.p.addOffer(r.winOffer);
    } else if (cid === loseCid) {
      x.p.addOffer(r.loseOfferAdd);
      x.p.removeOffer(r.loseOfferRemove);
    }
  }
  if (g.gameType === 1) {
    const perPlayer = losers.length + Math.trunc(totalHurt / 2000);
    for (const x of ps) if (x.p.info.ConsortiaID) await Db.addRiches(db, x.p.info.ConsortiaID, perPlayer, 0, "", () => "");
    const winStr = ctx.lang.t("Game.Server.SceneGames.OnStopping.Msg5").replace("Game.Server.SceneGames.OnStopping.Msg5", "") + winners.map((x) => `[${x.p.info.NickName}]`).join("") +
      ctx.lang.t("Game.Server.SceneGames.OnStopping.Msg1") + loseP.p.info.ConsortiaName + ctx.lang.t("Game.Server.SceneGames.OnStopping.Msg2");
    for (const o of m.online(winCid)) o.sendMessage(2, winStr);
  }
  for (const cid of new Set([winCid, loseCid])) if (cid) await m.refreshRiches(cid);
  for (const x of ps) x.p.updateProperties();
}
