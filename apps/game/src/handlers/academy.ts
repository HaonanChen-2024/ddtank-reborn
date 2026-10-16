/**
 * 141 ACADEMY (master / apprentice) — AcademyHandler.cs + Managers/AcademyMgr.cs + PlayerInfo master/apprentice helpers
 * (SqlDataProvider/Data/PlayerInfo.cs:2511-2563). Requests are in memory (1 h, AcademyMgr.RemoveOldRequest); the relation
 * columns are written straight to Sys_Users_Detail (PlayerBussiness.UpdateAcademyPlayer / SP_UsersAcademy_Update).
 */
import { sql } from "drizzle-orm";
import { PacketOut } from "@ddt/protocol";
import { loadPlayerInfo } from "../db/characters.js";
import { saveItem } from "../db/items.js";
import { sendMail } from "../db/social.js";
import { ItemInfo } from "../game/item.js";
import type { GamePlayer } from "../game/player.js";
import type { PlayerInfo } from "../game/player-info.js";
import * as Out from "../packets/out.js";
import type { ServerContext } from "../session/context.js";
import { SubRouter, type HandlerRegistry } from "./registry.js";

// AcademyMgr static ctor
export const LEVEL_GAP = 5;
export const TARGET_PLAYER_MIN_LEVEL = 6;
export const ACADEMY_LEVEL_MIN = 20;
export const ACADEMY_LEVEL_MAX = 16;
export const MASTER_STATE = 2;
export const MASTER_FULL_STATE = 3;

export const checkCanApp = (lvl: number) => lvl >= TARGET_PLAYER_MIN_LEVEL && lvl <= ACADEMY_LEVEL_MAX;
export const checkCanMaster = (lvl: number) => lvl >= ACADEMY_LEVEL_MIN;

type Rel = Pick<PlayerInfo, "ID" | "NickName" | "masterID" | "masterOrApprentices" | "apprenticeshipState" | "graduatesCount" | "honourOfMaster" | "freezesDate"> & { Grade: number; Sex: boolean };

/** PlayerInfo.updateMasterOrApprenticesArr: "id|nick,id|nick". */
export function parseRel(s: string | null | undefined): Map<number, string> {
  const m = new Map<number, string>();
  for (const part of String(s ?? "").split(",")) {
    if (!part) continue;
    const i = part.indexOf("|");
    const id = Number(i < 0 ? part : part.slice(0, i));
    if (id) m.set(id, i < 0 ? "" : part.slice(i + 1));
  }
  return m;
}

/** PlayerInfo.ConvertMasterOrApprentices: rewrites the string and apprenticeshipState. */
export function writeRel(p: Rel, m: Map<number, string>): void {
  p.apprenticeshipState = m.size === 0 ? 0 : m.size >= 3 ? 3 : p.masterID !== 0 ? 1 : 2;
  p.masterOrApprentices = [...m].map(([id, n]) => `${id}|${n}`).join(",");
}
export function addRel(p: Rel, id: number, nick: string): boolean {
  const m = parseRel(p.masterOrApprentices);
  if (m.has(id)) return false;
  m.set(id, nick);
  writeRel(p, m);
  return true;
}
export function removeRel(p: Rel, id: number): boolean {
  const m = parseRel(p.masterOrApprentices);
  if (!m.delete(id)) return false;
  writeRel(p, m);
  return true;
}

interface AcademyRequest { sender: number; receiver: number; type: number; at: number }
const requestsByCtx = new WeakMap<ServerContext, AcademyRequest[]>();
function requests(ctx: ServerContext): AcademyRequest[] {
  let l = requestsByCtx.get(ctx);
  if (!l) requestsByCtx.set(ctx, (l = []));
  const now = Date.now();
  for (let i = l.length - 1; i >= 0; i--) if (l[i]!.at + 3_600_000 < now) l.splice(i, 1);
  return l;
}
const getRequest = (ctx: ServerContext, sender: number, receiver: number) => requests(ctx).find((r) => r.sender === sender && r.receiver === receiver);
const removeRequest = (ctx: ServerContext, r: AcademyRequest) => {
  const l = requests(ctx);
  const i = l.indexOf(r);
  if (i >= 0) l.splice(i, 1);
};

// ------------------------------------------------------------------ packets (AbstractPacketLib.cs:66-99)
export function appState(c: Rel, removeUserId: number): PacketOut {
  const p = new PacketOut(141);
  p.writeByte(10);
  p.writeInt(c.apprenticeshipState);
  p.writeInt(c.masterID);
  p.writeString(c.masterOrApprentices ?? "");
  p.writeInt(removeUserId);
  p.writeInt(c.graduatesCount);
  p.writeString(c.honourOfMaster ?? "");
  Out.wd(p, c.freezesDate);
  return p;
}
export function systemNotice(text: string, isAlert: boolean): PacketOut {
  const p = new PacketOut(141);
  p.writeByte(17);
  p.writeString(text);
  p.writeBoolean(isAlert);
  return p;
}
export function graduate(type: number, appId: number, nick: string): PacketOut {
  const p = new PacketOut(141);
  p.writeByte(11);
  p.writeInt(type);
  p.writeInt(appId);
  p.writeString(nick);
  return p;
}
function askPacket(sub: number, id: number, nick: string, msg: string): PacketOut {
  const p = new PacketOut(141);
  p.writeByte(sub);
  p.writeInt(id);
  p.writeString(nick);
  p.writeString(msg);
  return p;
}

/** PlayerBussiness.UpdateAcademyPlayer (SP_UsersAcademy_Update). */
async function saveAcademy(ctx: ServerContext, c: Rel): Promise<void> {
  await ctx.db.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "apprenticeshipState" = ${c.apprenticeshipState}, "masterID" = ${c.masterID},
    "masterOrApprentices" = ${c.masterOrApprentices ?? ""}, "graduatesCount" = ${c.graduatesCount}, "honourOfMaster" = ${c.honourOfMaster ?? ""},
    "freezesDate" = ${c.freezesDate ?? new Date()} WHERE "UserID" = ${c.ID}`);
}

async function infoOf(ctx: ServerContext, id: number): Promise<{ info: Rel; online?: GamePlayer } | null> {
  const online = ctx.world.get(id);
  if (online) return { info: online.info as Rel, online };
  const info = await loadPlayerInfo(ctx.db.db, id);
  return info ? { info: info as Rel } : null;
}

/** GamePlayer.SendMailToUser / WorldEventMgr.SendItem(s)ToMail: items (≤ 5 per mail) or a text mail. */
async function mailTo(ctx: ServerContext, toId: number, toNick: string, title: string, content: string, items: ItemInfo[] = []): Promise<void> {
  const chunks = items.length ? Array.from({ length: Math.ceil(items.length / 5) }, (_, i) => items.slice(i * 5, i * 5 + 5)) : [[]];
  for (const chunk of chunks) {
    const mail: Record<string, unknown> = {};
    let remark = "";
    for (const [k, it] of chunk.entries()) {
      it.UserID = 0; it.BagType = -1; it.Place = -1;
      await saveItem(ctx.db.db, it);
      mail[`Annex${k + 1}`] = String(it.ItemID);
      mail[`Annex${k + 1}Name`] = it.template.Name ?? "";
      remark += `${k + 1}、${it.template.Name}x${it.Count};`;
    }
    await sendMail(ctx.db.db, { ...mail, AnnexRemark: remark, Content: content, Title: title, Gold: 0, Money: 0, Type: 9, Receiver: toNick, ReceiverID: toId, Sender: toNick, SenderID: toId } as never);
  }
  ctx.world.get(toId)?.send(Out.mailResponse(toId, 1));
}

function makeItem(ctx: ServerContext, tpl: number, validDate: number): ItemInfo | null {
  const t = ctx.templates.findItem(tpl);
  if (!t) return null;
  const it = ItemInfo.createFromTemplate(t, 1, 103);
  it.IsBinds = true;
  it.ValidDate = validDate;
  return it;
}

/** AcademyMgr.AddApprentice. */
export async function addApprentice(ctx: ServerContext, master: GamePlayer, app: GamePlayer): Promise<boolean> {
  const m = master.info as Rel;
  const a = app.info as Rel;
  if (a.masterID !== 0 || !addRel(m, a.ID, a.NickName ?? "")) return false;
  a.masterID = m.ID;
  addRel(a, m.ID, m.NickName ?? "");
  app.send(appState(a, -1));
  master.send(appState(m, -1));
  await saveAcademy(ctx, a);
  await saveAcademy(ctx, m);
  return true;
}

/** AcademyMgr.FireApprentice. */
export async function fireApprentice(ctx: ServerContext, master: GamePlayer, uid: number, silent: boolean): Promise<boolean> {
  if (!removeRel(master.info as Rel, uid)) return false;
  const o = await infoOf(ctx, uid);
  if (!o) return true;
  removeRel(o.info, o.info.masterID);
  o.info.masterID = 0;
  writeRel(o.info, parseRel(o.info.masterOrApprentices));
  await saveAcademy(ctx, o.info);
  if (o.online) {
    if (!silent) o.online.send(systemNotice(ctx.lang.t("Game.Server.AppSystem.BreakApprenticeShipMsg.Apprentice", master.info.NickName), true));
    o.online.send(appState(o.info, uid));
  }
  return true;
}

/** AcademyMgr.FireMaster. */
export async function fireMaster(ctx: ServerContext, app: GamePlayer, isComplete: boolean): Promise<boolean> {
  const a = app.info as Rel;
  const masterId = a.masterID;
  if (!removeRel(a, masterId)) return false;
  const o = await infoOf(ctx, masterId);
  if (o) {
    if (isComplete) o.info.graduatesCount++;
    removeRel(o.info, app.id);
    await saveAcademy(ctx, o.info);
    if (o.online) {
      if (!isComplete) o.online.send(systemNotice(ctx.lang.t("Game.Server.AppSystem.BreakApprenticeShipMsg.Master", a.NickName), true));
      o.online.send(appState(o.info, app.id));
    }
  }
  a.masterID = 0;
  writeRel(a, parseRel(a.masterOrApprentices));
  return true;
}

const levelAwards = (s: string | undefined, def: string) =>
  new Map((s ?? def).split(",").map((x) => x.split("|").map(Number) as [number, number]).filter(([l, t]) => l && t));

/** AcademyMgr.UpdateAwardApp: level boxes for both, graduation at ACADEMY_LEVEL_MIN (FireMaster(isComplete)). */
export async function updateAwardApp(ctx: ServerContext, p: GamePlayer, oldLevel: number): Promise<void> {
  const a = p.info as Rel;
  const masterId = a.masterID;
  if (!masterId) return;
  const cfg = ctx.templates.serverConfig;
  const appAward = levelAwards(cfg.get("AcademyApprenticeAward"), "10|112085,15|112086,18|112087,20|112095");
  const masAward = levelAwards(cfg.get("AcademyMasterAward"), "10|112088,15|112089,18|112090,20|112094");
  const masterNick = parseRel(a.masterOrApprentices).get(masterId) ?? "";
  const t = (k: string, ...x: unknown[]) => ctx.lang.t(k, ...x);
  for (let i = oldLevel + 1; i <= a.Grade; i++) {
    const ai = appAward.get(i) && makeItem(ctx, appAward.get(i)!, 0);
    if (ai) await mailTo(ctx, a.ID, a.NickName ?? "", t("Game.Server.AppSystem.GraduateBox.Success", i), t("Game.Server.AppSystem.GraduateBox.Success", i), [ai]);
    const mi = masAward.get(i) && makeItem(ctx, masAward.get(i)!, 0);
    const title = t("Game.Server.AppSystem.ApprenticeLevelUp.mailTitle", a.NickName, i);
    if (mi) await mailTo(ctx, masterId, masterNick, t("Game.Server.AppSystem.TakeAppBox.Success", a.NickName, i), title, [mi]);
    else if (appAward.has(i) || masAward.has(i)) await mailTo(ctx, masterId, masterNick, title, title);
  }
  if (a.Grade < ACADEMY_LEVEL_MIN) return;
  const mo = await infoOf(ctx, masterId);
  mo?.online?.send(graduate(1, p.id, a.NickName ?? ""));
  // AcademyAppAwardComplete / AcademyMasAwardComplete: "male|male,female|female" by Sex (index Sex ? 1 : 0)
  const pick = (s: string | undefined, def: string, sex: boolean) => ((s ?? def).split(",")[sex ? 1 : 0] ?? "").split("|").map(Number).filter(Boolean);
  const appItems = pick(cfg.get("AcademyAppAwardComplete"), "1401|5293,1301|5192", !!a.Sex).map((x) => makeItem(ctx, x, 365)).filter((x): x is ItemInfo => !!x);
  await mailTo(ctx, a.ID, a.NickName ?? "", t("Game.Server.AppSystem.GraduateBox.Success"), t("Game.Server.AppSystem.GraduateBox.Success"), appItems);
  if (mo) {
    const masItems = pick(cfg.get("AcademyMasAwardComplete"), "1414|5409,1314|5306", !!mo.info.Sex).map((x) => makeItem(ctx, x, 3)).filter((x): x is ItemInfo => !!x);
    await mailTo(ctx, masterId, mo.info.NickName ?? "", t("Game.Server.AppSystem.GraduateBoxForMaster.MailTitle", a.NickName), t("Game.Server.AppSystem.GraduateBoxForMaster.MailContert"), masItems);
  }
  await fireMaster(ctx, p, true);
  await saveAcademy(ctx, a);
  p.send(appState(a, masterId));
  p.send(graduate(0, p.id, a.NickName ?? ""));
  const title = t("Game.Server.Managers.AcademyMgr.TitleGraduated");
  for (const o of ctx.world.all()) o.sendMessage(0, t("Game.Server.AppSystem.MasterGainHonour.content", mo?.info.NickName ?? "", a.NickName, title));
}

const hoursLeft = (d: Date | null | undefined) => (d && d.getTime() > Date.now() ? Math.ceil((d.getTime() - Date.now()) / 3_600_000) : 0);
const frozen = (c: Rel) => !!c.freezesDate && c.freezesDate.getTime() > Date.now();
const FROZEN_MSG = (c: Rel) => `解除师徒关系后暂时无法使用此功能，请在${hoursLeft(c.freezesDate)}小时后重试。`;

export function academyRouter(): SubRouter {
  return new SubRouter("byte", "ACADEMY")
    // the original handler ignores register / remove-register (the club list is built from every eligible player)
    .on(1, "ACADEMY_REGISTER", () => {}, "stub")
    .on(3, "ACADEMY_REMOVE", () => {}, "stub")
    .on(4, "ACADEMY_FOR_APPRENTICE", (ctx, p, pkt) => {
      const id = pkt.readInt();
      const msg = pkt.readString();
      if (getRequest(ctx, p.id, id)) return;
      if (frozen(p.info as Rel)) return p.sendMessage(0, FROZEN_MSG(p.info as Rel));
      const o = ctx.world.get(id);
      if (!o || o.info.apprenticeshipState >= MASTER_FULL_STATE || !checkCanMaster(o.info.Grade)) return p.sendMessage(0, "该玩家不在线。");
      requests(ctx).push({ sender: p.id, receiver: id, type: 1, at: Date.now() });
      o.send(askPacket(4, p.id, p.info.NickName ?? "", msg));
    })
    .on(5, "ACADEMY_FOR_MASTER", (ctx, p, pkt) => {
      const id = pkt.readInt();
      const msg = pkt.readString();
      if (getRequest(ctx, p.id, id)) return;
      if (frozen(p.info as Rel)) return p.sendMessage(0, FROZEN_MSG(p.info as Rel));
      const o = ctx.world.get(id);
      if (!o || o.info.masterID !== 0 || !checkCanApp(o.info.Grade)) return p.sendMessage(0, "该玩家不在线。");
      requests(ctx).push({ sender: p.id, receiver: id, type: 0, at: Date.now() });
      o.send(askPacket(5, p.id, p.info.NickName ?? "", msg));
    })
    .on(6, "MASTER_CONFIRM", async (ctx, p, pkt) => {
      const id = pkt.readInt();
      const r = getRequest(ctx, id, p.id);
      if (!r || r.type !== 1) return p.sendMessage(0, "申请不存在或已被移除。");
      removeRequest(ctx, r);
      if (frozen(p.info as Rel)) return p.sendMessage(0, FROZEN_MSG(p.info as Rel));
      if (p.info.apprenticeshipState >= MASTER_FULL_STATE || !checkCanMaster(p.info.Grade)) return p.sendMessage(0, "该玩家已是师父，请重试！");
      const app = ctx.world.get(id);
      if (!app || !checkCanApp(app.info.Grade)) return p.sendMessage(0, "该玩家不在线，请稍后重试！");
      if (!(await addApprentice(ctx, p, app))) return p.sendMessage(0, "该玩家已有师父。");
      app.send(systemNotice(`[${p.info.NickName}]已同意收你为徒`, true));
      await mailTo(ctx, p.id, p.info.NickName ?? "", ctx.lang.t("Game.Server.AppSystem.TakeApprenticeMail.Title"), ctx.lang.t("Game.Server.AppSystem.TakeApprenticeMail.Content"));
      p.sendMessage(0, `[${app.info.NickName}]已同意成为你的徒弟`);
    })
    .on(7, "APPRENTICE_CONFIRM", async (ctx, p, pkt) => {
      const id = pkt.readInt();
      const r = getRequest(ctx, id, p.id);
      if (!r || r.type !== 0) return p.sendMessage(0, ctx.lang.t("Game.Server.AppSystem.AppClub.RemoveInfo.RecordNotFound"));
      removeRequest(ctx, r);
      if (frozen(p.info as Rel)) return p.sendMessage(0, ctx.lang.t("Game.Server.AppSystem.BeApprentice.Frozen", hoursLeft(p.info.freezesDate)));
      if (p.info.masterID !== 0 || !checkCanApp(p.info.Grade)) return p.sendMessage(0, ctx.lang.t("Game.Server.AppSystem.BeApprentice.Failed"));
      const master = ctx.world.get(id);
      if (!master || master.info.Grade < p.info.Grade + LEVEL_GAP || !checkCanMaster(master.info.Grade)) return p.sendMessage(0, ctx.lang.t("LoginServerConnector.HandleSysMess.Msg2"));
      if (!(await addApprentice(ctx, master, p))) return p.sendMessage(0, ctx.lang.t("Game.Server.AppSystem.AlreadlyHasRelationship.Apprentice"));
      master.send(systemNotice(ctx.lang.t("Game.Server.AppSystem.ApprenticeConfirm", p.info.NickName), true));
      await mailTo(ctx, master.id, master.info.NickName ?? "", ctx.lang.t("Game.Server.AppSystem.TakeApprenticeMail.Title"), ctx.lang.t("Game.Server.AppSystem.TakeApprenticeMail.Content"));
      p.sendMessage(0, ctx.lang.t("Game.Server.AppSystem.MasterConfirm", master.info.NickName));
    })
    .on(8, "MASTER_REFUSE", (ctx, p, pkt) => {
      const id = pkt.readInt();
      const r = getRequest(ctx, id, p.id);
      if (!r || r.type !== 1) return;
      removeRequest(ctx, r);
      ctx.world.get(id)?.send(systemNotice(ctx.lang.t("Game.Server.AppSystem.MasterRefuse", p.info.NickName), false));
    })
    .on(9, "APPRENTICE_REFUSE", (ctx, p, pkt) => {
      const id = pkt.readInt();
      const r = getRequest(ctx, id, p.id);
      if (!r || r.type !== 0) return;
      removeRequest(ctx, r);
      ctx.world.get(id)?.send(systemNotice(ctx.lang.t("Game.Server.AppSystem.ApprenticeRefuse", p.info.NickName), false));
    })
    .on(12, "FIRE_MASTER", async (ctx, p, pkt) => {
      const id = pkt.readInt();
      // fixed: the original took the 10000 gold before checking the relation (and kept it on failure)
      if (p.info.Gold < 10000) return p.sendMessage(0, ctx.lang.t("Game.Server.AppSystem.BreakApprentice.NotEnoughGold"));
      if (p.info.masterID !== id || !(await fireMaster(ctx, p, false))) return p.sendMessage(0, ctx.lang.t("Game.Server.AppSystem.BreakApprentice.FireApprenticeCD"));
      p.removeGold(10000);
      p.info.freezesDate = new Date(Date.now() + ctx.templates.cfgInt("AcademyApprenticeFreezeHours", 24) * 3_600_000);
      await saveAcademy(ctx, p.info as Rel);
      p.send(appState(p.info as Rel, id));
    })
    .on(13, "FIRE_APPRENTICE", async (ctx, p, pkt) => {
      const id = pkt.readInt();
      if (p.info.Gold < 20000) return p.sendMessage(0, ctx.lang.t("Game.Server.AppSystem.BreakApprentice.NotEnoughGold"));
      if (p.info.apprenticeshipState < MASTER_STATE || !(await fireApprentice(ctx, p, id, false))) return p.sendMessage(0, ctx.lang.t("Game.Server.AppSystem.BreakApprentice.FireApprenticeCD"));
      p.removeGold(20000);
      p.info.freezesDate = new Date(Date.now() + ctx.templates.cfgInt("AcademyMasterFreezeHours", 48) * 3_600_000);
      await saveAcademy(ctx, p.info as Rel);
      p.send(appState(p.info as Rel, id));
    });
}

export function registerAcademy(r: HandlerRegistry): SubRouter {
  const a = academyRouter();
  r.player(141, "ACADEMY", a.handler);
  return a;
}
