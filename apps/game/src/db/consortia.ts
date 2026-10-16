/**
 * Guild persistence: ports of the Project_Player34 consortia procedures (research/db/Project_Player34/schema/
 * procedures/SP_Consortia*.sql). Each function returns the proc's @Result code (0 = ok) and the output parameters;
 * permission / cost rules come from `src/game/consortia.ts`. Original bugs fixed are noted per function.
 */
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { applyTranslations, game, loadTranslations, player, type Database } from "@ddt/db";
import { DEFAULT_DUTIES, Right, checkRemoveMember, dutyMove, gradeChange, hasRight, kickBudget, upgrade, userRemarkAllowed, type GuildBuildings, type LevelRow, type UpgradeKind } from "../game/consortia.js";

const C = player.Consortia;
const U = player.Consortia_Users;
const Du = player.Consortia_Duty;
const A = player.Consortia_Apply_Users;
const I = player.Consortia_Invite_Users;
const E = player.Consortia_Event;
const EC = player.Consortia_Equip_Control;
const D = player.Sys_Users_Detail;

export type ConsortiaRow = typeof C.$inferSelect;
export type DutyRow = typeof Du.$inferSelect;

export interface DutyInfo {
  DutyID: number;
  Level: number;
  DutyName: string;
  Right: number;
}

/** V_Consortia_Users row (only what the procs read). */
export interface MemberInfo {
  ID: number;
  ConsortiaID: number;
  UserID: number;
  UserName: string;
  DutyID: number;
  Level: number;
  DutyName: string;
  Right: number;
  IsBanChat: boolean;
}

/** SP_Consortia_Level_All (player DB, as ConsortiaExtraMgr). */
export async function loadLevels(db: Database): Promise<Map<number, LevelRow>> {
  const rows = await db.select().from(player.Consortia_Level);
  return new Map(rows.map((r) => [r.Level, r]));
}

export async function loadBuffTemps(db: Database) {
  return db.select().from(player.Consortia_Buff_Temp);
}

export async function loadBadges(db: Database) {
  const rows = await db.select().from(game.Consortia_Badge);
  const overlay = await loadTranslations(db, "Consortia_Badge", "pt-BR");
  return rows.map(row => applyTranslations(row, "BadgeID", overlay));
}

export async function getConsortia(db: Database, id: number): Promise<ConsortiaRow | null> {
  if (!id) return null;
  const r = await db.select().from(C).where(and(eq(C.ConsortiaID, id), eq(C.IsExist, true))).limit(1);
  return r[0] ?? null;
}

/** V_Consortia_Users where ConsortiaID and UserID (IsExist). */
export async function getMember(db: Database, consortiaId: number, userId: number): Promise<MemberInfo | null> {
  const r = await db
    .select({ ID: U.ID, ConsortiaID: U.ConsortiaID, UserID: U.UserID, UserName: U.UserName, DutyID: U.DutyID, Level: Du.Level, DutyName: Du.DutyName, Right: Du.Right, IsBanChat: U.IsBanChat })
    .from(U)
    .leftJoin(Du, eq(Du.DutyID, U.DutyID))
    .where(and(eq(U.ConsortiaID, consortiaId), eq(U.UserID, userId), eq(U.IsExist, true)))
    .limit(1);
  const m = r[0];
  return m ? { ...m, Level: m.Level ?? 0, DutyName: m.DutyName ?? "", Right: m.Right ?? 0 } : null;
}

export async function listMembers(db: Database, consortiaId: number): Promise<{ UserID: number; UserName: string; State: number }[]> {
  return db
    .select({ UserID: U.UserID, UserName: U.UserName, State: D.State })
    .from(U)
    .innerJoin(D, eq(D.UserID, U.UserID))
    .where(and(eq(U.ConsortiaID, consortiaId), eq(U.IsExist, true)));
}

async function duties(db: Database, consortiaId: number): Promise<DutyRow[]> {
  return db.select().from(Du).where(and(eq(Du.ConsortiaID, consortiaId), eq(Du.IsExist, true)));
}

/** "select … from Consortia_Duty where Level in (select Max(Level) …)" — the lowest rank. */
async function lowestDuty(db: Database, consortiaId: number): Promise<DutyRow | null> {
  const ds = await duties(db, consortiaId);
  return ds.reduce<DutyRow | null>((a, d) => (!a || d.Level > a.Level ? d : a), null);
}

export async function addEvent(db: Database, consortiaId: number, type: number, nick: string, value: number, manager: string | null, remark = ""): Promise<void> {
  await db.insert(E).values({ ConsortiaID: consortiaId, Date: new Date(), Type: type, NickName: nick, EventValue: value, ManagerName: manager, IsExist: true, Remark: remark });
}

// ------------------------------------------------------------------------------------------------- create / disband

/** SP_Consortia_Add: 2 name taken, 3 already a member; creates the 5 default duties and the chairman row. */
export async function createConsortia(
  db: Database,
  o: { userId: number; nick: string; name: string; level: LevelRow; dutyName: (key: string, fallback: string) => string; now: Date },
): Promise<{ code: number; consortiaId?: number; duty?: DutyInfo }> {
  const same = await db.select({ n: sql<number>`count(*)::int` }).from(C).where(and(eq(C.ConsortiaName, o.name), eq(C.IsExist, true)));
  if ((same[0]?.n ?? 0) !== 0) return { code: 2 };
  const ex = await db.select({ ID: U.ID, IsExist: U.IsExist }).from(U).where(eq(U.UserID, o.userId)).orderBy(desc(U.IsExist)).limit(1);
  if (ex[0]?.IsExist) return { code: 3 };
  return db.transaction(async (tx) => {
    const [c] = await tx
      .insert(C)
      .values({
        BuildDate: o.now, CelebCount: 0, ChairmanID: o.userId, ChairmanName: o.nick, ConsortiaName: o.name, CreatorID: o.userId, CreatorName: o.nick,
        Description: "", Honor: 0, IP: "", IsExist: true, Level: o.level.Level, MaxCount: o.level.Count, Placard: "", Port: 0, Repute: 0, Count: 1, Riches: o.level.Riches,
      })
      .returning({ ID: C.ConsortiaID });
    const cid = c!.ID;
    let chair: DutyInfo | null = null;
    for (const d of DEFAULT_DUTIES) {
      const name = o.dutyName(d.key, d.name);
      const [row] = await tx.insert(Du).values({ ConsortiaID: cid, Level: d.level, DutyName: name, Right: d.right, IsExist: true }).returning({ ID: Du.DutyID });
      if (d.level === 1) chair = { DutyID: row!.ID, Level: 1, DutyName: name, Right: d.right };
    }
    if (ex[0]) await tx.update(U).set({ ConsortiaID: cid, RatifierID: o.userId, RatifierName: o.nick, DutyID: chair!.DutyID, Remark: "", IsExist: true, IsBanChat: false }).where(eq(U.ID, ex[0].ID));
    else await tx.insert(U).values({ ConsortiaID: cid, UserID: o.userId, UserName: o.nick, RatifierID: o.userId, RatifierName: o.nick, DutyID: chair!.DutyID, Remark: "", IsExist: true, IsBanChat: false });
    await tx.update(D).set({ ConsortiaID: cid, IsConsortia: true }).where(and(eq(D.UserID, o.userId), eq(D.IsExist, true)));
    return { code: 0, consortiaId: cid, duty: chair! };
  });
}

/** SP_Consortia_Delete: 2 not the chairman, 3 guild level >= 4 cannot be disbanded. Members' riches reset. */
export async function disbandConsortia(db: Database, consortiaId: number, userId: number): Promise<number> {
  const c = await getConsortia(db, consortiaId);
  if (!c || c.ChairmanID !== userId) return 2;
  if (c.Level >= 4) return 3;
  await db.transaction(async (tx) => {
    await tx.update(EC).set({ IsExist: false }).where(and(eq(EC.ConsortiaID, consortiaId), eq(EC.IsExist, true)));
    await tx.update(C).set({ IsExist: false }).where(eq(C.ConsortiaID, consortiaId));
    await tx.update(A).set({ IsExist: false }).where(eq(A.ConsortiaID, consortiaId));
    await tx.update(I).set({ IsExist: false }).where(eq(I.ConsortiaID, consortiaId));
    await tx.update(Du).set({ IsExist: false }).where(eq(Du.ConsortiaID, consortiaId));
    await tx.update(U).set({ IsExist: false }).where(eq(U.ConsortiaID, consortiaId));
    await tx.update(E).set({ IsExist: false }).where(eq(E.ConsortiaID, consortiaId));
    await tx.update(player.Consortia_Ally).set({ IsExist: false }).where(sql`("Consortia1ID" = ${consortiaId} OR "Consortia2ID" = ${consortiaId})`);
    await tx.update(player.Consortia_Apply_Ally).set({ IsExist: false }).where(sql`("Consortia1ID" = ${consortiaId} OR "Consortia2ID" = ${consortiaId})`);
    await tx.update(D).set({ ConsortiaID: 0, RichesOffer: 0, RichesRob: 0 }).where(eq(D.ConsortiaID, consortiaId));
  });
  return 0;
}

// ------------------------------------------------------------------------------------------------- applications

/**
 * SP_ConsortiaApplyUser_Add: 2 guild missing, 6 full. Fix: 7 when the guild closed applications (the C# maps
 * Msg7 "not accepting" but the proc never checked OpenApply, so CONSORTIA_APPLY_STATE did nothing).
 */
export async function addApply(db: Database, consortiaId: number, userId: number, nick: string, now: Date): Promise<number> {
  const c = await getConsortia(db, consortiaId);
  if (!c || !c.ConsortiaName) return 2;
  if (c.Count + 1 > c.MaxCount) return 6;
  if (!c.OpenApply) return 7;
  const ex = await db.select({ ID: A.ID }).from(A).where(and(eq(A.UserID, userId), eq(A.ConsortiaID, consortiaId))).limit(1);
  if (ex[0]) await db.update(A).set({ ConsortiaName: c.ConsortiaName, ApplyDate: now, Remark: "", IsExist: true }).where(eq(A.ID, ex[0].ID));
  else await db.insert(A).values({ ConsortiaID: consortiaId, ConsortiaName: c.ConsortiaName, UserID: userId, UserName: nick, ApplyDate: now, Remark: "", IsExist: true });
  return 0;
}

/** SP_ConsortiaApplyUser_Delete: guild side needs Ratify (2); the applicant can cancel his own (3 otherwise). */
export async function deleteApply(db: Database, applyId: number, userId: number, consortiaId: number): Promise<number> {
  if (consortiaId !== 0) {
    const m = await getMember(db, consortiaId, userId);
    if (!hasRight(m?.Right, Right.Ratify)) return 2;
    await db.update(A).set({ IsExist: false }).where(and(eq(A.ID, applyId), eq(A.ConsortiaID, consortiaId)));
    return 0;
  }
  const r = await db.select({ UserID: A.UserID }).from(A).where(and(eq(A.ID, applyId), eq(A.IsExist, true))).limit(1);
  if (!r[0] || r[0].UserID !== userId) return 3;
  await db.update(A).set({ IsExist: false }).where(eq(A.ID, applyId));
  return 0;
}

/** Output of SP_ConsortiaApplyUser_Pass / SP_ConsortiaInviteUser_Pass (ConsortiaUserInfo + repute). */
export interface JoinedMember {
  memberRowId: number;
  consortiaId: number;
  consortiaName: string;
  userId: number;
  userName: string;
  duty: DutyInfo;
  repute: number;
  /** the other side: approver (apply) / inviter (invite) */
  otherId: number;
  otherName: string;
  detail: { Offer: number; RichesOffer: number; RichesRob: number; LastDate: Date; Win: number; Total: number; Escape: number; Grade: number; State: number; Sex: boolean; UserName: string; FightPower: number; AchievementPoint: number; Honor: string; UseOffer: number };
}

async function joinGuild(db: Database, c: ConsortiaRow, userId: number, userName: string, ratifierId: number, ratifierName: string, eventManager: string | null): Promise<JoinedMember | number> {
  if (c.Count + 1 > c.MaxCount) return 6;
  const duty = await lowestDuty(db, c.ConsortiaID);
  if (!duty) return 4;
  const ex = await db.select({ ID: U.ID, IsExist: U.IsExist }).from(U).where(eq(U.UserID, userId)).orderBy(desc(U.IsExist)).limit(1);
  if (ex[0]?.IsExist) return 5;
  return db.transaction(async (tx) => {
    await tx.update(A).set({ IsExist: false }).where(and(eq(A.UserID, userId), eq(A.IsExist, true)));
    await tx.update(I).set({ IsExist: false }).where(and(eq(I.UserID, userId), eq(I.IsExist, true)));
    await tx.update(C).set({ Count: sql`${C.Count} + 1` }).where(eq(C.ConsortiaID, c.ConsortiaID));
    let rowId: number;
    if (ex[0]) {
      await tx.update(U).set({ ConsortiaID: c.ConsortiaID, RatifierID: ratifierId, RatifierName: ratifierName, DutyID: duty.DutyID, Remark: "", IsExist: true, IsBanChat: false }).where(eq(U.ID, ex[0].ID));
      rowId = ex[0].ID;
    } else {
      const [r] = await tx.insert(U).values({ ConsortiaID: c.ConsortiaID, UserID: userId, UserName: userName, RatifierID: ratifierId, RatifierName: ratifierName, DutyID: duty.DutyID, Remark: "", IsExist: true, IsBanChat: false }).returning({ ID: U.ID });
      rowId = r!.ID;
    }
    const [d] = await tx
      .update(D)
      .set({ ConsortiaID: c.ConsortiaID, IsConsortia: true })
      .where(eq(D.UserID, userId))
      .returning({ Offer: D.Offer, RichesOffer: D.RichesOffer, RichesRob: D.RichesRob, LastDate: D.LastDate, Win: D.Win, Total: D.Total, Escape: D.Escape, Grade: D.Grade, State: D.State, Sex: D.Sex, UserName: D.UserName, FightPower: D.FightPower, AchievementPoint: D.AchievementPoint, Honor: D.Honor, UseOffer: D.UseOffer });
    if (eventManager != null) await tx.insert(E).values({ ConsortiaID: c.ConsortiaID, Date: new Date(), Type: 6, NickName: userName, EventValue: 0, ManagerName: eventManager, IsExist: true, Remark: "" });
    return {
      memberRowId: rowId, consortiaId: c.ConsortiaID, consortiaName: c.ConsortiaName, userId, userName, repute: c.Repute, otherId: ratifierId, otherName: ratifierName,
      duty: { DutyID: duty.DutyID, Level: duty.Level, DutyName: duty.DutyName, Right: duty.Right },
      detail: { ...d!, UserName: d!.UserName ?? "", Honor: d!.Honor ?? "" },
    };
  });
}

/** SP_ConsortiaApplyUser_Pass: 2 no Ratify right, 3 no such application, 6 full, 4 no duty, 5 already a member. */
export async function passApply(db: Database, applyId: number, userId: number, userName: string, consortiaId: number): Promise<JoinedMember | number> {
  const m = await getMember(db, consortiaId, userId);
  if (!hasRight(m?.Right, Right.Ratify)) return 2;
  const ap = await db.select({ UserID: A.UserID, UserName: A.UserName }).from(A).where(and(eq(A.ID, applyId), eq(A.ConsortiaID, consortiaId), eq(A.IsExist, true))).limit(1);
  if (!ap[0]?.UserID) return 3;
  const c = await getConsortia(db, consortiaId);
  if (!c) return 6;
  return joinGuild(db, c, ap[0].UserID, ap[0].UserName, userId, userName, userName);
}

// ------------------------------------------------------------------------------------------------- invitations

/** SP_ConsortiaInviteUser_Add: 2 no Invite right, 4 nick unknown, 5 already in a guild, 3 guild missing, 6 full. */
export async function addInvite(db: Database, o: { consortiaId: number; inviterId: number; inviterName: string; nick: string; now: Date }): Promise<{ code: number; id?: number; userId?: number; consortiaName?: string }> {
  const m = await getMember(db, o.consortiaId, o.inviterId);
  if (!hasRight(m?.Right, Right.Invite)) return { code: 2 };
  const t = await db.select({ UserID: D.UserID, ConsortiaID: D.ConsortiaID }).from(D).where(and(eq(D.NickName, o.nick), eq(D.IsExist, true))).limit(1);
  if (!t[0]?.UserID) return { code: 4 };
  if (t[0].ConsortiaID !== 0) return { code: 5, userId: t[0].UserID };
  const c = await getConsortia(db, o.consortiaId);
  if (!c?.ConsortiaName) return { code: 3, userId: t[0].UserID };
  if (c.Count + 1 > c.MaxCount) return { code: 6, userId: t[0].UserID };
  const ex = await db.select({ ID: I.ID }).from(I).where(and(eq(I.UserID, t[0].UserID), eq(I.ConsortiaID, o.consortiaId))).limit(1);
  let id: number;
  if (ex[0]) {
    id = ex[0].ID;
    await db.update(I).set({ InviteDate: o.now, InviteID: o.inviterId, InviteName: o.inviterName, Remark: "", IsExist: true }).where(eq(I.ID, id));
  } else {
    const [r] = await db.insert(I).values({ ConsortiaID: o.consortiaId, ConsortiaName: c.ConsortiaName, InviteDate: o.now, InviteID: o.inviterId, InviteName: o.inviterName, IsExist: true, Remark: "", UserID: t[0].UserID, UserName: o.nick }).returning({ ID: I.ID });
    id = r!.ID;
  }
  return { code: 0, id, userId: t[0].UserID, consortiaName: c.ConsortiaName };
}

/** SP_ConsortiaInviteUser_Pass: 3 no such invitation, 6 full, 4 no duty, 5 already a member. */
export async function passInvite(db: Database, inviteId: number, userId: number, userName: string): Promise<JoinedMember | number> {
  const inv = await db.select({ InviteID: I.InviteID, InviteName: I.InviteName, ConsortiaID: I.ConsortiaID }).from(I).where(and(eq(I.ID, inviteId), eq(I.UserID, userId), eq(I.IsExist, true))).limit(1);
  if (!inv[0]?.InviteID) return 3;
  const c = await getConsortia(db, inv[0].ConsortiaID);
  if (!c) return 6;
  return joinGuild(db, c, userId, userName, inv[0].InviteID, inv[0].InviteName, null);
}

/** SP_ConsortiaInviteUser_Delete (always 0). */
export async function deleteInvite(db: Database, inviteId: number, userId: number): Promise<number> {
  await db.update(I).set({ IsExist: false }).where(and(eq(I.ID, inviteId), eq(I.UserID, userId), eq(I.IsExist, true)));
  return 0;
}

// ------------------------------------------------------------------------------------------------- members

/** SP_ConsortiaUser_Delete: leave (self) or kick. 2 no right, 3 chairman leaving, 4 target chairman, 5 kick budget. */
export async function removeMember(db: Database, actorId: number, targetId: number, consortiaId: number, now: Date): Promise<{ code: number; nick?: string }> {
  const actor = await getMember(db, consortiaId, actorId);
  const c = await getConsortia(db, consortiaId);
  const self = actorId === targetId;
  const code = checkRemoveMember(actor ? { level: actor.Level, right: actor.Right } : null, self, !!c && c.ChairmanID === targetId);
  if (code) return { code };
  if (!c) return { code: 2 };
  let kick = { date: c.KickDate, count: c.KickCount };
  if (!self) {
    const lv = await db.select({ KickMax: player.Consortia_Level.KickMax }).from(player.Consortia_Level).where(eq(player.Consortia_Level.Level, c.Level)).limit(1);
    const b = kickBudget(c.KickDate, c.KickCount, lv[0]?.KickMax ?? 10, now);
    if (!b.ok) return { code: 5 };
    kick = { date: b.date, count: b.count };
  }
  const target = await getMember(db, consortiaId, targetId);
  if (!target) return { code: 2 };
  let nick = "";
  await db.transaction(async (tx) => {
    await tx.update(C).set({ Count: sql`${C.Count} - 1`, KickDate: kick.date, KickCount: kick.count }).where(eq(C.ConsortiaID, consortiaId));
    await tx.update(U).set({ IsExist: false }).where(and(eq(U.UserID, targetId), eq(U.ConsortiaID, consortiaId), eq(U.IsExist, true)));
    const r = await tx.update(D).set({ ConsortiaID: 0, RichesOffer: 0, RichesRob: 0 }).where(and(eq(D.UserID, targetId), eq(D.ConsortiaID, consortiaId))).returning({ NickName: D.NickName });
    nick = r[0]?.NickName ?? target.UserName;
    await tx.insert(E).values({ ConsortiaID: consortiaId, Date: new Date(), Type: self ? 8 : 7, NickName: nick, EventValue: 0, ManagerName: self ? null : actor!.UserName, IsExist: true, Remark: "" });
  });
  return { code: 0, nick };
}

/**
 * SP_ConsortiaChangeChairman: 2 not chairman / target below grade 5, 1 nick unknown, 3 target not a member (or
 * already chairman), 4/5 duties missing. The old chairman drops to the lowest duty.
 */
export async function changeChairman(db: Database, nick: string, consortiaId: number, userId: number): Promise<{ code: number; target?: { id: number; name: string }; chairDuty?: DutyInfo; oldDuty?: DutyInfo }> {
  const c = await getConsortia(db, consortiaId);
  if (!c || c.ChairmanID !== userId) return { code: 2 };
  const t = await db.select({ UserID: D.UserID, Grade: D.Grade, IsExist: D.IsExist }).from(D).where(eq(D.NickName, nick)).limit(1);
  if (!t[0]?.IsExist) return { code: 1 };
  if ((t[0].Grade ?? 0) < 5) return { code: 2 };
  const tm = await getMember(db, consortiaId, t[0].UserID);
  if (!tm || tm.Level === 1) return { code: 3 };
  const ds = await duties(db, consortiaId);
  const chair = ds.find((d) => d.Level === 1);
  if (!chair) return { code: 4 };
  const low = ds.reduce<DutyRow | null>((a, d) => (!a || d.Level > a.Level ? d : a), null);
  if (!low) return { code: 5 };
  await db.transaction(async (tx) => {
    await tx.update(C).set({ ChairmanID: tm.UserID, ChairmanName: tm.UserName }).where(and(eq(C.ConsortiaID, consortiaId), eq(C.IsExist, true)));
    await tx.update(U).set({ DutyID: low.DutyID }).where(and(eq(U.DutyID, chair.DutyID), eq(U.ConsortiaID, consortiaId), eq(U.IsExist, true)));
    await tx.update(U).set({ DutyID: chair.DutyID }).where(and(eq(U.ID, tm.ID), eq(U.ConsortiaID, consortiaId), eq(U.IsExist, true)));
  });
  const di = (d: DutyRow): DutyInfo => ({ DutyID: d.DutyID, Level: d.Level, DutyName: d.DutyName, Right: d.Right });
  return { code: 0, target: { id: tm.UserID, name: tm.UserName }, chairDuty: di(chair), oldDuty: di(low) };
}

/** SP_ConsortiaUserGrade_Update: promote / demote one step (codes from gradeChange, 6 = duty missing). */
export async function updateUserGrade(db: Database, targetId: number, consortiaId: number, userId: number, promote: boolean): Promise<{ code: number; userName?: string; duty?: DutyInfo }> {
  const actor = await getMember(db, consortiaId, userId);
  const target = await getMember(db, consortiaId, targetId);
  const ds = await duties(db, consortiaId);
  const maxLevel = ds.length ? Math.max(...ds.map((d) => d.Level)) : null;
  const g = gradeChange(actor?.Right ?? null, target?.Level ?? null, maxLevel, promote);
  if (g.code) return { code: g.code };
  const duty = ds.find((d) => d.Level === g.level);
  if (!duty) return { code: 6 };
  await db.update(U).set({ DutyID: duty.DutyID }).where(and(eq(U.UserID, targetId), eq(U.ConsortiaID, consortiaId), eq(U.IsExist, true)));
  return { code: 0, userName: target!.UserName, duty: { DutyID: duty.DutyID, Level: duty.Level, DutyName: duty.DutyName, Right: duty.Right } };
}

/** SP_ConsortiaIsBanChat_Update: 2 no BanChat right or target missing. */
export async function setBanChat(db: Database, targetId: number, consortiaId: number, userId: number, ban: boolean): Promise<{ code: number; id?: number; name?: string }> {
  const actor = await getMember(db, consortiaId, userId);
  if (!hasRight(actor?.Right, Right.BanChat)) return { code: 2 };
  const t = await getMember(db, consortiaId, targetId);
  if (!t) return { code: 2 };
  await db.update(U).set({ IsBanChat: ban }).where(and(eq(U.ConsortiaID, consortiaId), eq(U.UserID, targetId), eq(U.IsExist, true)));
  return { code: 0, id: t.UserID, name: t.UserName };
}

/** SP_ConsortiaUserRemark_Update (fixed right check, see userRemarkAllowed). @ID = Consortia_Users.ID. */
export async function setUserRemark(db: Database, rowId: number, consortiaId: number, userId: number, remark: string): Promise<number> {
  const actor = await getMember(db, consortiaId, userId);
  if (!userRemarkAllowed(actor?.Right)) return 2;
  await db.update(U).set({ Remark: remark }).where(and(eq(U.ConsortiaID, consortiaId), eq(U.ID, rowId), eq(U.IsExist, true)));
  return 0;
}

/** SP_ConsortiaPlacard_Update (Notice) / SP_ConsortiaDescription_Update (Enounce). */
export async function setText(db: Database, field: "Placard" | "Description", consortiaId: number, userId: number, text: string): Promise<number> {
  const actor = await getMember(db, consortiaId, userId);
  if (!hasRight(actor?.Right, field === "Placard" ? Right.Notice : Right.Enounce)) return 2;
  await db.update(C).set({ [field]: text }).where(eq(C.ConsortiaID, consortiaId));
  return 0;
}

/** SP_Consortia_Apply_State: chairman only. */
export async function setApplyState(db: Database, consortiaId: number, userId: number, open: boolean): Promise<number> {
  const r = await db.update(C).set({ OpenApply: open }).where(and(eq(C.ConsortiaID, consortiaId), eq(C.ChairmanID, userId), eq(C.IsExist, true))).returning({ ID: C.ConsortiaID });
  return r.length ? 0 : 2;
}

// ------------------------------------------------------------------------------------------------- duties

/** SP_ConsortiaDuty_Delete: 3 chairman/lowest duty; its members move to the lowest duty. (No right check, as original.) */
export async function deleteDuty(db: Database, dutyId: number, consortiaId: number): Promise<number> {
  const ds = await duties(db, consortiaId);
  const cur = ds.find((d) => d.DutyID === dutyId);
  if (!cur || cur.Level === 1) return 3;
  const low = ds.reduce<DutyRow | null>((a, d) => (!a || d.Level > a.Level ? d : a), null);
  if (!low || low.Level === cur.Level) return 3;
  await db.transaction(async (tx) => {
    await tx.update(Du).set({ IsExist: false }).where(and(eq(Du.DutyID, dutyId), eq(Du.IsExist, true)));
    await tx.update(Du).set({ Level: sql`${Du.Level} - 1` }).where(and(eq(Du.ConsortiaID, consortiaId), sql`${Du.Level} > ${cur.Level}`, eq(Du.IsExist, true)));
    await tx.update(U).set({ DutyID: low.DutyID }).where(and(eq(U.DutyID, dutyId), eq(U.IsExist, true)));
  });
  return 0;
}

/**
 * SP_ConsortiaDuty_Update (Diplomatism right): 2 rename (the proc writes DutyName and reads back the old Right/Level
 * — the client's right value is ignored), 3 move up, 4 move down. Codes 2 (right), 3/4 (move), 5.
 */
export async function updateDuty(db: Database, o: { dutyId: number; consortiaId: number; userId: number; type: number; name: string }): Promise<{ code: number; duty?: DutyInfo }> {
  const actor = await getMember(db, o.consortiaId, o.userId);
  if (!hasRight(actor?.Right, Right.Diplomatism)) return { code: 2 };
  const ds = await duties(db, o.consortiaId);
  const cur = ds.find((d) => d.DutyID === o.dutyId);
  if (o.type === 2) {
    if (!cur) return { code: 0, duty: { DutyID: o.dutyId, Level: 0, DutyName: o.name, Right: 0 } };
    await db.update(Du).set({ DutyName: o.name }).where(and(eq(Du.ConsortiaID, o.consortiaId), eq(Du.DutyID, o.dutyId), eq(Du.IsExist, true)));
    return { code: 0, duty: { DutyID: cur.DutyID, Level: cur.Level, DutyName: o.name, Right: cur.Right } };
  }
  if (o.type === 3 || o.type === 4) {
    const maxL = ds.length ? Math.max(...ds.map((d) => d.Level)) : null;
    const code = dutyMove(o.type, cur?.Level ?? null, maxL);
    if (code) return { code };
    const next = o.type === 3 ? cur!.Level - 1 : cur!.Level + 1;
    await db.transaction(async (tx) => {
      await tx.update(Du).set({ Level: cur!.Level }).where(and(eq(Du.ConsortiaID, o.consortiaId), eq(Du.Level, next), eq(Du.IsExist, true)));
      await tx.update(Du).set({ Level: next }).where(and(eq(Du.ConsortiaID, o.consortiaId), eq(Du.DutyID, o.dutyId), eq(Du.IsExist, true)));
    });
    return { code: 0, duty: { DutyID: cur!.DutyID, Level: next, DutyName: cur!.DutyName, Right: cur!.Right } };
  }
  return { code: 5 };
}

// ------------------------------------------------------------------------------------------------- riches

/** SP_Consortia_Riches_Add: clamps negatives to the balance; type 5 (donation) logs a Consortia_Event. */
export async function addRiches(db: Database, consortiaId: number, riches: number, type: number, userName: string, remark: (nick: string, v: number) => string): Promise<{ ok: boolean; riches: number }> {
  const c = await getConsortia(db, consortiaId);
  if (!c) return { ok: false, riches };
  if (riches < 0 && c.Riches < -riches) riches = -c.Riches;
  await db.update(C).set({ Riches: sql`${C.Riches} + ${riches}`, WarnDate: new Date() }).where(eq(C.ConsortiaID, consortiaId));
  if (type === 5) await addEvent(db, consortiaId, 5, userName, riches, userName, remark(userName, riches));
  return { ok: true, riches };
}

/** SP_Consortia_Riches_Remove — fix: fails (false) when the guild cannot pay (the proc returned 0 anyway). */
export async function removeRiches(db: Database, consortiaId: number, riches: number): Promise<boolean> {
  const r = await db.update(C).set({ Riches: sql`${C.Riches} - ${riches}` }).where(and(eq(C.ConsortiaID, consortiaId), eq(C.IsExist, true), sql`${C.Riches} >= ${riches}`)).returning({ ID: C.ConsortiaID });
  return r.length > 0;
}

/** SP_ConsortiaRiches_Update: Enounce right, Riches -= value (badge, mass mail, mission release). Fix: never below 0. */
export async function spendRiches(db: Database, consortiaId: number, userId: number, riches: number): Promise<number> {
  const actor = await getMember(db, consortiaId, userId);
  if (!hasRight(actor?.Right, Right.Enounce)) return 2;
  return (await removeRiches(db, consortiaId, riches)) ? 0 : 3;
}

/** SP_Consortia_UpGrade / *_UpGrade (chairman only: 2). */
export async function upgradeBuilding(db: Database, kind: UpgradeKind, consortiaId: number, userId: number, levels: ReadonlyMap<number, LevelRow>): Promise<{ code: number; level?: number; consortia?: ConsortiaRow }> {
  const c = await db.select().from(C).where(and(eq(C.ConsortiaID, consortiaId), eq(C.ChairmanID, userId), eq(C.IsExist, true))).limit(1);
  if (!c[0] || !c[0].Level) return { code: 2 };
  const r = upgrade(kind, c[0] as GuildBuildings, levels);
  if (r.code) return { code: r.code };
  // optimistic: only if riches did not change meanwhile
  const ok = await db.update(C).set(r.set!).where(and(eq(C.ConsortiaID, consortiaId), eq(C.Riches, c[0].Riches))).returning({ ID: C.ConsortiaID });
  if (!ok.length) return { code: 1 };
  return { code: 0, level: r.newLevel, consortia: { ...c[0], ...r.set } as ConsortiaRow };
}

// ------------------------------------------------------------------------------------------------- equip control / badge

/** SP_Consortia_Equip_Control_Add: chairman only (2). */
export async function setEquipControl(db: Database, consortiaId: number, userId: number, level: number, type: number, riches: number): Promise<number> {
  const c = await getConsortia(db, consortiaId);
  if (!c || c.ChairmanID !== userId) return 2;
  const ex = await db.select({ n: sql<number>`count(*)::int` }).from(EC).where(and(eq(EC.ConsortiaID, consortiaId), eq(EC.Level, level), eq(EC.Type, type)));
  if ((ex[0]?.n ?? 0) === 0) await db.insert(EC).values({ ConsortiaID: consortiaId, Level: level, Type: type, Riches: riches, IsExist: true });
  else await db.update(EC).set({ Riches: riches, IsExist: true }).where(and(eq(EC.ConsortiaID, consortiaId), eq(EC.Level, level), eq(EC.Type, type)));
  return 0;
}

/** SP_Consortia_Equip_Control_Single (undefined = no row: callers use the 100 default). */
export async function getEquipControl(db: Database, consortiaId: number, level: number, type: number): Promise<number | undefined> {
  const r = await db.select({ Riches: EC.Riches }).from(EC).where(and(eq(EC.ConsortiaID, consortiaId), eq(EC.Level, level), eq(EC.Type, type))).limit(1);
  return r[0]?.Riches;
}

/** SP_ConsortiaBadge_Update (Enounce right). */
export async function setBadge(db: Database, consortiaId: number, userId: number, badgeId: number, validDate: number, buyTime: string): Promise<number> {
  const actor = await getMember(db, consortiaId, userId);
  if (!hasRight(actor?.Right, Right.Enounce)) return 2;
  await db.update(C).set({ BadgeID: badgeId, BadgeBuyTime: buyTime, ValidDate: validDate }).where(eq(C.ConsortiaID, consortiaId));
  await db.update(D).set({ badgeID: badgeId }).where(eq(D.ConsortiaID, consortiaId));
  return 0;
}

// ------------------------------------------------------------------------------------------------- buffs (Consortia_Buffer)

export type ConsortiaBufferRow = typeof player.Consortia_Buffer.$inferSelect;

export async function loadGuildBuffers(db: Database, consortiaId: number): Promise<ConsortiaBufferRow[]> {
  return db.select().from(player.Consortia_Buffer).where(eq(player.Consortia_Buffer.ConsortiaID, consortiaId));
}

/** PlayerBussiness.SaveConsortiaBuffer (GetUserConsortiaBufferSingle + extend). */
export async function saveGuildBuffer(db: Database, row: Omit<ConsortiaBufferRow, "ID">): Promise<void> {
  const B = player.Consortia_Buffer;
  const ex = await db.select().from(B).where(and(eq(B.ConsortiaID, row.ConsortiaID!), eq(B.BufferID, row.BufferID!))).limit(1);
  if (ex[0]) await db.update(B).set(row).where(eq(B.ID, ex[0].ID));
  else await db.insert(B).values(row);
}

// ------------------------------------------------------------------------------------------------- guild task

export type TaskInfoRow = typeof player.Consortia_Task_Info.$inferSelect;

export async function loadTasks(db: Database): Promise<TaskInfoRow[]> {
  return db.select().from(player.Consortia_Task_Info).where(eq(player.Consortia_Task_Info.IsExist, true));
}

/** SP_Consortia_Task_Info_Create_Or_Update / _Delete (one row per guild). */
export async function saveTask(db: Database, row: Omit<TaskInfoRow, "ID" | "IsExist"> | null, consortiaId: number): Promise<void> {
  const T = player.Consortia_Task_Info;
  if (!row) {
    await db.update(T).set({ IsExist: false }).where(eq(T.ConsortiaID, consortiaId));
    return;
  }
  const ex = await db.select({ ID: T.ID }).from(T).where(eq(T.ConsortiaID, consortiaId)).limit(1);
  if (ex[0]) await db.update(T).set({ ...row, IsExist: true }).where(eq(T.ID, ex[0].ID));
  else await db.insert(T).values({ ...row, IsExist: true });
}

export async function loadTaskConfig(db: Database) {
  return db.select().from(game.Consortia_TaskConfig);
}

/** Server_Config value (player DB first, then game DB). */
export async function serverConfig(db: Database, name: string): Promise<string | undefined> {
  for (const t of [player.Server_Config, game.Server_Config]) {
    const r = await db.select({ Value: t.Value }).from(t).where(eq(t.Name, name)).limit(1);
    if (r[0]?.Value != null) return r[0].Value;
  }
  return undefined;
}

/** Members' ids/levels for many guilds (fight rewards). */
export async function guildLevels(db: Database, ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const r = await db.select({ ID: C.ConsortiaID, Level: C.Level }).from(C).where(and(inArray(C.ConsortiaID, ids), eq(C.IsExist, true)));
  return new Map(r.map((x) => [x.ID, x.Level]));
}

export async function maxDutyLevel(db: Database, consortiaId: number): Promise<number> {
  const r = await db.select({ m: max(Du.Level) }).from(Du).where(and(eq(Du.ConsortiaID, consortiaId), eq(Du.IsExist, true)));
  return r[0]?.m ?? 0;
}
