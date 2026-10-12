/**
 * Daily / activity / event packets (spec 01 §8 + §14, 02 §10) and the scheduled systems:
 *   13 DAILY_AWARD (0 login buff, 2 egg, 3 VIP box, 5 sign-in), 90 GET_SIGNAWARD, 53 GET_TIME_BOX, 230 ACHIEVEMENT_FINISH,
 *   338 ACCUMULATIVELOGIN_AWARD, 259 FIRSTRECHARGE (free claim: no real payments), 219 WEEKLY_CLICK_CNT, 103 DAILYRECORD,
 *   162 ELITEGAME, 102 WORLDBOSS_CMD (lobby room), plus `EventsRuntime` = template cache + `EventScheduler` hooks
 *   (world boss open/close + rank rewards, league notice 42, elite state 162/1, weekly reset, double exp/gold).
 * Every claim goes through `claimOnce` (app."EventClaims") so a repeated packet never grants twice.
 */
import { and, eq, sql } from "drizzle-orm";
import { GSPacket } from "@ddt/protocol";
import { player as P } from "@ddt/db";
import type { GamePlayer } from "../game/player.js";
import type { ServerContext } from "../session/context.js";
import { EventData, canCompleteAchievement, claimOnce, dayKey, grantRewards, insertAchievementData, monthKey, updateRecords, type Reward } from "../game/events.js";
import { EventScheduler, loadScheduledEvents, type ActiveWindow } from "../game/scheduler.js";
import { createItemBox } from "./use.js";
import { mailItems } from "./items.js";
import * as Out from "../packets/out.js";
import type { HandlerRegistry } from "./registry.js";

// ------------------------------------------------------------------ runtime
export interface BossPlayer { x: number; y: number; state: number }
export interface WorldBossState {
  window: ActiveWindow | null;
  name: string;
  resourceId: string;
  pveId: number;
  maxBlood: number;
  blood: number;
  players: Map<number, BossPlayer>;
  /** userId -> damage/honor this window (UpdateRank). */
  rank: Map<number, { nick: string; damage: number; honor: number }>;
}

export class EventsRuntime {
  data = new EventData();
  scheduler: EventScheduler;
  boss: WorldBossState = { window: null, name: "boss", resourceId: "0", pveId: 0, maxBlood: 0, blood: 0, players: new Map(), rank: new Map() };
  /** EliteGameController bitmask: 1 score 30-40, 2 champion 30-40, 4 score 41-50, 8 champion 41-50. 0 = closed. */
  eliteStatus = 0;
  leagueOpen = false;
  log: string[] = [];

  constructor(private readonly ctx: ServerContext) {
    this.scheduler = new EventScheduler(() => ctx.now(), { onStart: (w) => this.onStart(w), onEnd: (w) => this.onEnd(w) });
  }

  async reload(): Promise<void> {
    await this.data.load(this.ctx.db.db);
    this.scheduler.setEvents(await loadScheduledEvents(this.ctx.db.db).catch(() => []));
    await this.scheduler.tick();
  }

  private note(s: string): void {
    this.log.unshift(`${this.ctx.now().toISOString()} ${s}`);
    this.log.length = Math.min(this.log.length, 50);
    this.ctx.log.info(`[events] ${s}`);
  }

  private broadcast(pkt: GSPacket | ((p: GamePlayer) => GSPacket)): void {
    for (const p of this.ctx.world.all()) p.send(typeof pkt === "function" ? pkt(p) : pkt);
  }

  async onStart(w: ActiveWindow): Promise<void> {
    const prm = w.ev.params;
    switch (w.ev.kind) {
      case "worldboss": {
        const b = this.boss;
        b.window = w;
        b.name = String(prm.name ?? "Dragão Divino");
        b.resourceId = String(prm.resourceId ?? "1");
        b.pveId = Number(prm.pveId ?? 1243);
        b.maxBlood = Number(prm.bossHp ?? 20_000_000);
        b.blood = b.maxBlood;
        b.players.clear();
        b.rank.clear();
        this.broadcast((p) => worldBossOpen(this, p));
        this.broadcast(Out.message(1, String(prm.notice ?? `Boss mundial ${b.name} apareceu! Entre pelo ícone no hall.`)));
        break;
      }
      case "league":
        this.leagueOpen = true;
        this.broadcast((p) => Out.leagueNotice(p.id, p.match.restCount ?? 0, Number(prm.maxCount ?? 10), 1));
        this.broadcast(Out.message(1, "O Deus da Guerra começou, entre logo na sala para lutar!"));
        break;
      case "elite":
        this.eliteStatus = Number(prm.status ?? 5);
        this.broadcast(eliteStatusPkt(this.eliteStatus));
        break;
      case "weekly_reset":
        await weeklyReset(this.ctx, w.key);
        break;
      case "double_exp":
      case "double_gold":
        this.broadcast(Out.message(1, `${w.ev.title || w.ev.kind}: x${Number(prm.rate ?? 2)} até ${w.end.toISOString().slice(11, 16)} UTC.`));
        break;
    }
    this.note(`start ${w.ev.kind} #${w.ev.id} ${w.start.toISOString()} → ${w.end.toISOString()}`);
  }

  async onEnd(w: ActiveWindow): Promise<void> {
    switch (w.ev.kind) {
      case "worldboss":
        await finishWorldBoss(this.ctx, this, w);
        break;
      case "league":
        this.leagueOpen = false;
        this.broadcast((p) => Out.leagueNotice(p.id, p.match.restCount ?? 0, 0, 2));
        break;
      case "elite":
        this.eliteStatus = 0;
        this.broadcast(eliteStatusPkt(0));
        break;
    }
    this.note(`end ${w.ev.kind} #${w.ev.id}`);
  }

  status(): Record<string, unknown> {
    return {
      ...this.scheduler.status(),
      worldBoss: this.boss.window ? { name: this.boss.name, blood: this.boss.blood, maxBlood: this.boss.maxBlood, players: this.boss.players.size, ranking: rankList(this) } : null,
      eliteStatus: this.eliteStatus,
      leagueOpen: this.leagueOpen,
      log: this.log.slice(0, 20),
    };
  }
}

const runtimes = new WeakMap<ServerContext, EventsRuntime>();
export function eventsRuntime(ctx: ServerContext): EventsRuntime {
  let r = runtimes.get(ctx);
  if (!r) runtimes.set(ctx, (r = new EventsRuntime(ctx)));
  return r;
}

// ------------------------------------------------------------------ packets
/** 102/0 OPEN (AbstractPacketLib.SendOpenWorldBoss :2593) with the live window. */
export function worldBossOpen(rt: EventsRuntime, _p: GamePlayer): GSPacket {
  const b = rt.boss;
  const open = !!b.window;
  const p = new GSPacket(102);
  p.writeByte(0);
  p.writeString(open ? b.resourceId : "0");
  p.writeInt(open ? b.pveId : 0);
  p.writeString("Fera Divina");
  p.writeString(b.name);
  p.writeInt(b.maxBlood);
  p.writeInt(0); p.writeInt(0);
  p.writeInt(1); p.writeInt(265); p.writeInt(1030);
  Out.wd(p, b.window?.start ?? new Date(0)); Out.wd(p, b.window?.end ?? new Date(0));
  p.writeInt(b.window ? Math.round((b.window.end.getTime() - b.window.start.getTime()) / 60000) : 0);
  p.writeBoolean(!open || b.blood <= 0); // fightOver
  p.writeBoolean(!open); // roomClose
  p.writeInt(11573); p.writeInt(0); p.writeInt(15); p.writeInt(1000);
  p.writeInt(1); p.writeInt(1); p.writeString("Aumentar Dano"); p.writeInt(30); p.writeString("Dano base aumenta em 200."); p.writeInt(-1);
  p.writeBoolean(true); p.writeBoolean(false);
  return p;
}

function eliteStatusPkt(status: number): GSPacket {
  const p = new GSPacket(162);
  p.writeByte(1);
  p.writeInt(status);
  return p;
}

function rankList(rt: EventsRuntime): { id: number; nick: string; damage: number }[] {
  return [...rt.boss.rank.entries()].map(([id, r]) => ({ id, nick: r.nick, damage: r.damage })).sort((a, b) => b.damage - a.damage);
}

function worldBossRanking(rt: EventsRuntime, final: boolean): GSPacket {
  const list = rankList(rt).slice(0, 10);
  const p = new GSPacket(102);
  p.writeByte(10);
  p.writeBoolean(final);
  p.writeInt(list.length);
  for (const r of list) { p.writeInt(r.id); p.writeString(r.nick); p.writeInt(r.damage); }
  return p;
}

/** Called by the fight layer (or tests) with the damage a player dealt to the world boss (BaseWorldBossRoom.ReduceBlood + UpdateRank). */
export function worldBossDamage(ctx: ServerContext, p: GamePlayer, damage: number): void {
  const rt = eventsRuntime(ctx);
  const b = rt.boss;
  if (!b.window || damage <= 0 || b.blood <= 0) return;
  const dealt = Math.min(damage, b.blood);
  b.blood -= dealt;
  const r = b.rank.get(p.id) ?? { nick: p.info.NickName ?? "", damage: 0, honor: 0 };
  r.damage += dealt;
  r.honor += Math.floor(dealt / 1000);
  b.rank.set(p.id, r);
  const up = new GSPacket(102);
  up.writeByte(5); up.writeBoolean(false); up.writeInt(b.maxBlood); up.writeInt(b.blood);
  for (const id of b.players.keys()) ctx.world.get(id)?.send(up);
  if (b.blood <= 0) {
    const over = new GSPacket(102);
    over.writeByte(8); over.writeBoolean(true);
    for (const pl of ctx.world.all()) pl.send(over);
  }
}

/** World boss end: ranking rewards (params.rankAwards [{rank, giftToken?, gold?, items?}], claim per window) + 102/1 OVER. */
async function finishWorldBoss(ctx: ServerContext, rt: EventsRuntime, w: ActiveWindow): Promise<void> {
  const awards = (Array.isArray(w.ev.params.rankAwards) ? w.ev.params.rankAwards : []) as { rank: number; giftToken?: number; gold?: number; items?: Reward[] }[];
  const list = rankList(rt);
  for (const [i, r] of list.entries()) {
    const tier = awards.filter((a) => i + 1 <= a.rank).sort((a, b) => a.rank - b.rank)[0];
    if (!tier || !(await claimOnce(ctx.db.db, r.id, "worldboss", w.key.slice(0, 64)))) continue;
    const rewards: Reward[] = [...(tier.items ?? [])];
    if (tier.giftToken) rewards.push({ templateId: -1100, count: tier.giftToken });
    if (tier.gold) rewards.push({ templateId: -100, count: tier.gold });
    const pl = ctx.world.get(r.id);
    if (pl) {
      const g = grantRewards(pl, rewards, ctx.templates.findItem, ctx.now());
      if (g.overflow.length) await mailItems(ctx, pl, g.overflow, "Boss mundial", 12);
      pl.sendMessage(0, `Boss mundial: ${i + 1}º lugar (${r.damage} de dano). Prêmio: ${g.summary.join(", ")}.`);
    } else {
      await offlineCurrency(ctx, r.id, rewards);
    }
  }
  const final = worldBossRanking(rt, true);
  const over = new GSPacket(102);
  over.writeByte(1);
  for (const pl of ctx.world.all()) { if (rt.boss.players.has(pl.id)) pl.send(final); pl.send(over); }
  rt.boss.window = null;
  rt.boss.players.clear();
}

/** Currency rewards for offline players (items are skipped: world-boss tiers default to gift tokens). */
async function offlineCurrency(ctx: ServerContext, userId: number, rewards: Reward[]): Promise<void> {
  const gt = rewards.filter((r) => r.templateId === -1100).reduce((s, r) => s + r.count, 0);
  const gold = rewards.filter((r) => r.templateId === -100).reduce((s, r) => s + r.count, 0);
  if (gt || gold) await ctx.db.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "GiftToken" = "GiftToken" + ${gt}, "Gold" = "Gold" + ${gold} WHERE "UserID" = ${userId}`);
}

/**
 * Weekly reset (once per window, claim UserID 0): last-week columns take this week's counters, counters go to 0
 * (Consortia week riches/honor, player week GP/offer/league score, match weekly score/games/wins). Online players get
 * the same change in memory so the autosave does not write the old values back.
 */
export async function weeklyReset(ctx: ServerContext, key: string): Promise<boolean> {
  const db = ctx.db.db;
  if (!(await claimOnce(db, 0, "weekly_reset", key.slice(0, 64)))) return false;
  // Last* are snapshots (SP_Sys_Update_Users_WeekList / _Consortia_WeekList); apps/api rank.ts computes Add* = now − snapshot.
  await db.execute(sql`UPDATE player."Consortia" SET "LastWeekRiches" = "LastWeekRiches" + "AddWeekRiches", "AddWeekRiches" = 0, "LastWeekHonor" = "Honor", "AddWeekHonor" = 0`);
  await db.execute(sql`UPDATE player."Sys_Users_Detail" SET "LastWeekGP" = "GP", "AddWeekGP" = 0, "LastWeekOffer" = "Offer", "AddWeekOffer" = 0, "AddWeekLeagueScore" = 0`);
  await db.execute(sql`UPDATE player."Sys_User_Match_Info" SET "weeklyScore" = 0, "weeklyGameCount" = 0, "WeeklyWinCount" = 0`);
  for (const p of ctx.world.all()) {
    const c = p.info as unknown as Record<string, number>;
    c.LastWeekGP = c.GP ?? 0; c.AddWeekGP = 0; c.LastWeekOffer = c.Offer ?? 0; c.AddWeekOffer = 0; c.AddWeekLeagueScore = 0;
    const m = p.match as unknown as Record<string, number>;
    m.weeklyScore = 0; m.weeklyGameCount = 0; m.WeeklyWinCount = 0;
  }
  return true;
}

// ------------------------------------------------------------------ login hook
/** Event part of the login burst (GamePlayer.Login :365-447): records 228, box reset, first recharge, world boss, league, elite, accumulative login. */
export async function eventsOnLogin(ctx: ServerContext, p: GamePlayer): Promise<void> {
  const rt = eventsRuntime(ctx);
  const now = ctx.now();
  const c = p.info;
  // GamePlayer.Login: BoxBeginTime = now (the BoxGetDate daily reset is done by the login burst)
  boxBegin.set(p, now.getTime());
  // AccumulativeUpdate once per day (max 7)
  if ((c.accumulativeLoginDays ?? 0) < 7 && (await claimOnce(ctx.db.db, p.id, "acclogin", dayKey(now)))) c.accumulativeLoginDays = (c.accumulativeLoginDays ?? 0) + 1;
  updateRecords(p);
  // EffortManager.updateWholeProgress dereferences progressEfforts[CondictionType] for EVERY achievement condition
  // (null -> exception, nothing completes): the original created one record row per type, so send them all.
  const types = new Set<number>();
  for (const l of rt.data.achConds.values()) for (const cnd of l) types.add(cnd.CondictionType);
  const all = [...p.records];
  for (const t of types) if (!all.some((r) => r.RecordID === t)) all.push({ UserID: p.id, RecordID: t, Total: 0 });
  p.send(Out.achievementRecords(228, p.id, all));
  if (rt.leagueOpen) p.send(Out.leagueNotice(p.id, p.match.restCount ?? 0, Number(rt.scheduler.isOpen("league")?.ev.params.maxCount ?? 10), 1));
  if (rt.eliteStatus) p.send(eliteStatusPkt(rt.eliteStatus));
}

/** Pushes changed achievement records (229) after property changes (grade, wins, fight power...). */
export function pushRecords(p: GamePlayer, add?: Map<number, number>): void {
  const ch = updateRecords(p, add);
  if (ch.length) p.send(Out.achievementRecords(229, p.id, ch));
}

const boxBegin = new WeakMap<GamePlayer, number>();
const throttle = new WeakMap<GamePlayer, number>();
function throttled(p: GamePlayer, ms: number): boolean {
  const now = Date.now();
  if ((throttle.get(p) ?? 0) + ms > now) return true;
  throttle.set(p, now);
  return false;
}

/** Item/currency rewards; overflow by mail type 12 (OpenUpArk) like the original. */
async function give(ctx: ServerContext, p: GamePlayer, rewards: Reward[], title: string): Promise<string> {
  const g = grantRewards(p, rewards, ctx.templates.findItem, ctx.now());
  if (g.overflow.length) await mailItems(ctx, p, g.overflow, title, 12);
  return g.summary.join(", ");
}

// ------------------------------------------------------------------ handlers
export async function dailyAward(ctx: ServerContext, p: GamePlayer, type: number): Promise<void> {
  const rt = eventsRuntime(ctx);
  const db = ctx.db.db;
  const now = ctx.now();
  const day = dayKey(now);
  const t = (k: string, fb: string) => { const v = ctx.lang.t(k); return v === k ? fb : v; };
  switch (type) {
    case 0: {
      // AwardMgr.AddDailyAward: first Daily_Award Type 0 row -> buff (CreateBufferMinutes(template, ValidDate))
      if (!(await claimOnce(db, p.id, "daily", day))) return p.sendMessage(0, t("GameUserDailyAward.Fail1", "Você já recebeu o prêmio de hoje."));
      p.info.DayLoginCount = (p.info.DayLoginCount ?? 0) + 1;
      p.info.LastAward = now;
      const row = rt.data.dailyAward.find((d) => d.Type === 0);
      const tpl = row && ctx.templates.findItem(row.TemplateID);
      if (tpl) {
        const ex = p.buffs.find((b) => b.Type === tpl.Property1 && b.IsExist && b.BeginDate.getTime() + b.ValidDate * 60_000 > now.getTime());
        if (ex) ex.ValidDate += row.ValidDate;
        else {
          p.buffs = p.buffs.filter((b) => b.Type !== tpl.Property1);
          p.buffs.push({ UserID: p.id, Type: tpl.Property1, Value: tpl.Property2, BeginDate: now, ValidDate: row.ValidDate, TemplateID: tpl.TemplateID, ValidCount: tpl.Property3, Data: null, IsExist: true });
        }
        p.send(Out.bufferList(p.id, p.buffs));
      }
      p.send(Out.dailyAward(now, now));
      pushRecords(p);
      return p.sendMessage(0, `${t("GameUserDailyAward.Success", "Prêmio diário recebido!")}${tpl ? ` ${tpl.Name}` : ""}`);
    }
    case 2: {
      if (!(await claimOnce(db, p.id, "egg", day))) return p.sendMessage(0, "Você já recebeu 1 vez hoje!");
      p.info.LastGetEgg = now;
      const s = await give(ctx, p, [{ templateId: 112059, count: 1 }], "Ovo diário");
      return p.sendMessage(0, `${t("GameServer.DailyEggReceive.Success", "Ovo diário recebido:")} ${s}`);
    }
    case 3: {
      // VIP daily box: ItemMgr.FindItemBoxTypeAndLv(2, VIPLevel) = LoadUserBox Type 2, Level = VIP level
      const box = rt.data.userBox.find((b) => b.Type === 2 && b.Level === p.info.VIPLevel);
      if (!p.info.VIPLevel || !box) return p.sendMessage(0, "Apenas para VIP.");
      if (!(await claimOnce(db, p.id, "vip", day))) {
        p.info.CanTakeVipReward = false;
        p.send(Out.openVip(p.info));
        return p.sendMessage(0, "Você já recebeu a recompensa de hoje!");
      }
      const s = await openBoxRewards(ctx, p, box.TemplateID, "Caixa VIP");
      // the client pops the VIP gift frame while CanTakeVipReward is set (ChecVipkExpireDay re-opens it the next day)
      p.info.CanTakeVipReward = false;
      p.info.LastVIPPackTime = ctx.now();
      p.send(Out.openVip(p.info));
      return p.sendMessage(0, `Caixa VIP: ${s}`);
    }
    case 5:
      return void (await signIn(ctx, p));
  }
}

/** 13 type 5 (DailyAwardHandler case 5): marks today in DailyLogList; the original accepted any number of signs per day. */
export async function signIn(ctx: ServerContext, p: GamePlayer): Promise<boolean> {
  const now = ctx.now();
  return ctx.db.db.transaction(async (tx) => {
    // The calendar row may not exist yet. Serialize on its owner, including requests across midnight.
    const [owner] = await tx.select({ id: P.Sys_Users_Detail.UserID }).from(P.Sys_Users_Detail)
      .where(eq(P.Sys_Users_Detail.UserID, p.id)).for("update");
    if (!owner || !(await claimOnce(tx, p.id, "sign", dayKey(now)))) return false;
    const [row] = await tx.select().from(P.DailyLogList).where(eq(P.DailyLogList.UserID, p.id)).limit(1);
    const sameMonth = row && row.LastDate && monthKey(row.LastDate) === monthKey(now);
    const days = sameMonth && row.DayLog ? row.DayLog.split(",") : [];
    const d = now.getUTCDate();
    while (days.length < d) days.push("False");
    days[d - 1] = "True";
    const signed = days.filter((x) => x === "True").length;
    const values = { DayLog: days.join(","), UserAwardLog: signed, LastDate: now };
    if (row) await tx.update(P.DailyLogList).set(values).where(eq(P.DailyLogList.ID, row.ID));
    else await tx.insert(P.DailyLogList).values({ UserID: p.id, ...values });
    return true;
  });
}

/** 90 GET_SIGNAWARD (AwardMgr.AddSignAwards): tier must exist and be reached this month; once per month+tier. */
export async function signAward(ctx: ServerContext, p: GamePlayer, count: number): Promise<boolean> {
  const rt = eventsRuntime(ctx);
  const db = ctx.db.db;
  const now = ctx.now();
  if (!rt.data.signTiers().includes(count)) return false;
  const [row] = await db.select().from(P.DailyLogList).where(eq(P.DailyLogList.UserID, p.id)).limit(1);
  const signed = row && row.LastDate && monthKey(row.LastDate) === monthKey(now) ? (row.DayLog ?? "").split(",").filter((x) => x === "True").length : 0;
  if (signed < count) return false;
  if (!(await claimOnce(db, p.id, "signaward", `${monthKey(now)}:${count}`))) return false;
  const rewards: Reward[] = rt.data.dailyAward.filter((d) => d.AwardDays === count && (d.Type === 1 || d.Type === 7) && (d.Sex === 0 || d.Sex === (p.info.Sex ? 1 : 2)))
    .map((d) => (d.Type === 7 ? { templateId: -1100, count: d.Count } : { templateId: d.TemplateID, count: d.Count, validDate: d.ValidDate, isBind: d.IsBinds }));
  const s = await give(ctx, p, rewards, "Prêmio de presença");
  p.sendMessage(0, `Presente de presença diária recebido com sucesso! ${s}`);
  return true;
}

async function openBoxRewards(ctx: ServerContext, p: GamePlayer, boxTemplate: number, title: string): Promise<string> {
  const r = createItemBox(ctx.templates.itemBoxes.get(boxTemplate));
  if (!r) {
    // the box id is an item itself (box template with no Shop_Goods_Box rows): give the box
    return give(ctx, p, [{ templateId: boxTemplate, count: 1 }], title);
  }
  const rewards: Reward[] = [
    { templateId: -100, count: r.gold }, { templateId: -200, count: r.money }, { templateId: -1100, count: r.giftToken },
    { templateId: -300, count: r.medal }, { templateId: 11107, count: r.exp }, { templateId: -800, count: r.honor },
    ...r.items.map((x) => ({ templateId: x.row.TemplateId, count: x.count, validDate: x.row.ItemValid, isBind: x.row.IsBind, strengthenLevel: x.row.StrengthenLevel })),
  ];
  return give(ctx, p, rewards, title);
}

/** 53 GET_TIME_BOX (UserGetBoxHandler.cs): mode 0 = client minute report (ignored for rewards), else boxType 0 time / 1 level. */
export async function timeBox(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const rt = eventsRuntime(ctx);
  const mode = pkt.readInt();
  const c = p.info;
  const now = ctx.now();
  if (mode === 0) {
    pkt.readInt();
    return;
  }
  const boxType = pkt.readInt();
  let ok = false;
  let box;
  if (boxType === 0) {
    box = rt.data.findBox(0, c.Grade, c.BoxProgression ?? 0);
    const minutes = Math.floor((now.getTime() - (boxBegin.get(p) ?? now.getTime())) / 60_000);
    // server-side elapsed time since login / last box (the original also accepted the client's report)
    if (box && minutes >= box.Condition && (await claimOnce(ctx.db.db, p.id, "timebox", `${dayKey(now)}:${box.Condition}`))) {
      c.BoxProgression = box.Condition; c.BoxGetDate = now; c.AlreadyGetBox = 0; ok = true;
    }
  } else {
    box = rt.data.findBox(1, c.GetBoxLevel ?? 0, c.Sex ? 1 : 0);
    if (box && c.Grade >= box.Level && (await claimOnce(ctx.db.db, p.id, "levelbox", String(box.Level)))) { c.GetBoxLevel = box.Level; ok = true; }
  }
  if (ok && box) {
    const s = await openBoxRewards(ctx, p, box.TemplateID, "Caixa de tempo");
    if (boxType === 0) {
      boxBegin.set(p, now.getTime());
      const next = rt.data.findBox(0, c.Grade, c.BoxProgression ?? 0);
      p.sendMessage(0, next ? `Presente do baú do tempo recebido. ${s}` : `Você já recebeu tudo de hoje. ${s}`);
    } else p.sendMessage(0, `${ctx.lang.t("UserGetTimeBoxHandler.level")} ${s}`);
  } else p.sendMessage(0, ctx.lang.t("UserGetTimeBoxHandler.fail"));
  if (boxType === 0) {
    const out = new GSPacket(53, p.id);
    out.writeInt(mode); out.writeInt(boxType);
    out.writeBoolean(ok);
    out.writeInt(c.BoxProgression ?? 0);
    p.send(out);
  }
}

/**
 * PlayerRank.AddAchievementRank (GameUtils/PlayerRank.cs:195): persists a title into player."Sys_User_Rank" instead
 * of only announcing it (the original's `NewTitleMgr` title-definition table isn't migrated, so NewTitleID stays 0
 * and the title is identified by its Name, same as the achievement reward text). Permanent (Validate 0, like
 * AddAchievementRank), equipped immediately (IsExit true) and re-sent as the full 34 USER_RANK list.
 */
async function grantTitle(ctx: ServerContext, p: GamePlayer, name: string): Promise<void> {
  const db = ctx.db.db;
  const now = ctx.now();
  const [row] = await db.select().from(P.Sys_User_Rank).where(and(eq(P.Sys_User_Rank.UserID, p.id), eq(P.Sys_User_Rank.Name, name))).limit(1);
  if (row) await db.update(P.Sys_User_Rank).set({ IsExit: true, BeginDate: now, EndDate: now, Validate: 0 }).where(eq(P.Sys_User_Rank.ID, row.ID));
  else await db.insert(P.Sys_User_Rank).values({ UserID: p.id, Name: name, NewTitleID: 0, BeginDate: now, EndDate: now, Validate: 0, IsExit: true });
  const ranks = await db.select().from(P.Sys_User_Rank).where(and(eq(P.Sys_User_Rank.UserID, p.id), eq(P.Sys_User_Rank.IsExit, true)));
  p.send(Out.userRanks(p.id, ranks));
}

/** 230 ACHIEVEMENT_FINISH: the original granted any id the client sent; the port checks CanCompleted against records. */
export async function achievementFinish(ctx: ServerContext, p: GamePlayer, id: number): Promise<boolean> {
  const rt = eventsRuntime(ctx);
  const now = ctx.now();
  updateRecords(p);
  if (!canCompleteAchievement(rt.data, p, id, now)) return false;
  if (!(await insertAchievementData(ctx.db.db, p.id, id, now))) return false;
  const a = rt.data.achievements.get(id)!;
  p.achievements.push({ UserID: p.id, AchievementID: id, IsComplete: true, CompletedDate: now });
  if (a.AchievementPoint) { p.info.AchievementPoint = (p.info.AchievementPoint ?? 0) + a.AchievementPoint; p.updateProperties(); }
  const titles = (rt.data.achGoods.get(id) ?? []).filter((g) => g.RewardType === 1).map((g) => g.RewardPara);
  const out = new GSPacket(230, p.id);
  out.writeInt(id); out.writeInt(now.getUTCFullYear()); out.writeInt(now.getUTCMonth() + 1); out.writeInt(now.getUTCDate());
  p.send(out);
  for (const name of titles) await grantTitle(ctx, p, name);
  if (titles.length) p.sendMessage(0, `Título obtido: ${titles.join(", ")}`);
  return true;
}

/** 338 ACCUMULATIVELOGIN_AWARD: days 1..6 fixed lists, day 7 the selected template (Login_Award_Item_Template Type = day). */
export async function accumulativeLogin(ctx: ServerContext, p: GamePlayer, selected: number): Promise<void> {
  const rt = eventsRuntime(ctx);
  const c = p.info;
  for (let day = (c.accumulativeAwardDays ?? 0) + 1; day <= (c.accumulativeLoginDays ?? 0); day++) {
    const rows = rt.data.loginAward.filter((r) => r.Type === day && (day < 7 || r.RewardItemID === selected));
    if (!rows.length) break;
    if (!(await claimOnce(ctx.db.db, p.id, "accaward", String(day)))) { c.accumulativeAwardDays = day; continue; }
    const s = await give(ctx, p, rows.map((r) => ({ templateId: r.RewardItemID, count: r.RewardItemCount, validDate: r.RewardItemValid, isBind: r.IsBind, strengthenLevel: r.StrengthenLevel })), `Presente de ${day} dia(s) de login`);
    c.accumulativeAwardDays = day;
    p.sendMessage(0, `Presente de ${day} dia(s) de login: ${s}`);
  }
  const out = new GSPacket(338, p.id);
  out.writeInt(c.accumulativeLoginDays ?? 0);
  out.writeInt(c.accumulativeAwardDays ?? 0);
  p.send(out);
}

/** 259 FIRSTRECHARGE: no real payments here, so the gift is a free one-time claim (FIRST_RECHARGE_FREE, default on). */
export async function firstRecharge(ctx: ServerContext, p: GamePlayer): Promise<boolean> {
  const rt = eventsRuntime(ctx);
  const free = String(process.env.FIRST_RECHARGE_FREE ?? "true") !== "false";
  if (!free && !p.info.IsRecharged) return false;
  if (p.info.IsGetAward || !(await claimOnce(ctx.db.db, p.id, "firstrecharge", "once"))) {
    p.sendMessage(0, ctx.lang.t("FirstRechargeGetAward.AlreadyGetAward"));
    return false;
  }
  const goods = rt.data.eventGoods.filter((g) => g.ActivityType === 7 && g.SubActivityType === 1);
  const s = await give(ctx, p, goods.map((g) => ({ templateId: g.TemplateId, count: g.Count ?? 1, validDate: g.ValidDate ?? 0, isBind: g.IsBind ?? true, strengthenLevel: g.StrengthLevel ?? 0, attack: g.AttackCompose ?? 0, defence: g.DefendCompose ?? 0, agility: g.AgilityCompose ?? 0, luck: g.LuckCompose ?? 0 })), "Presente da primeira recarga");
  p.info.IsGetAward = true;
  p.send(Out.firstRecharge(true, true));
  p.sendMessage(0, `Presente recebido! ${s}`);
  return true;
}

export function registerEvents(r: HandlerRegistry): void {
  r.player(13, "DAILY_AWARD", (ctx, p, pkt) => {
    const type = pkt.readInt();
    if (throttled(p, 500)) return;
    return dailyAward(ctx, p, type);
  });
  r.player(90, "GET_SIGNAWARD", (ctx, p, pkt) => void signAward(ctx, p, pkt.readInt()));
  r.player(53, "GET_TIME_BOX", (ctx, p, pkt) => timeBox(ctx, p, pkt));
  r.player(230, "ACHIEVEMENT_FINISH", (ctx, p, pkt) => void achievementFinish(ctx, p, pkt.readInt()));
  r.player(338, "ACCUMULATIVELOGIN_AWARD", (ctx, p, pkt) => accumulativeLogin(ctx, p, pkt.readInt()));
  r.player(259, "FIRSTRECHARGE", (ctx, p, pkt) => {
    pkt.readInt();
    if (throttled(p, 500)) return;
    return void firstRecharge(ctx, p);
  });
  /** UserWeeklyClickHandler: compares DateTime.Now with LastGetEgg.Date (always true in practice). */
  r.player(219, "WEEKLY_CLICK_CNT", (ctx, p) => {
    const out = new GSPacket(219, p.id);
    out.writeBoolean(!p.info.LastGetEgg || dayKey(p.info.LastGetEgg) !== dayKey(ctx.now()));
    p.send(out);
  });
  /** DailyRecordHandler: returns and deletes the DailyRecord rows. */
  r.player(103, "DAILYRECORD", async (ctx, p) => {
    const rows = await ctx.db.db.delete(P.DailyRecordInfo).where(eq(P.DailyRecordInfo.UserID, p.id)).returning();
    const out = new GSPacket(103, p.id);
    out.writeInt(rows.length);
    for (const x of rows) { out.writeInt(x.Type); out.writeString(x.Value); }
    p.send(out);
  });
  /** EliteGameHandler: 1 status, 2 start room (status 5 and grade >= 30), 3 my rank/score, 4 champions (none kept). */
  r.player(162, "ELITEGAME", (ctx, p, pkt) => {
    const rt = eventsRuntime(ctx);
    const sub = pkt.readByte();
    const out = new GSPacket(162);
    if (sub === 1) { out.writeByte(1); out.writeInt(rt.eliteStatus); }
    else if (sub === 2) { if (!(rt.eliteStatus === 5 && p.info.Grade >= 30)) return; out.writeByte(2); }
    else if (sub === 3) { out.writeByte(3); out.writeInt(p.match.eliteRank ?? 0); out.writeInt(p.match.eliteScore ?? p.info.EliteScore ?? 0); }
    else if (sub === 4) { const gt = pkt.readInt(); out.writeByte(4); out.writeInt(gt); out.writeInt(0); }
    else return;
    p.send(out);
  }, "partial");
  r.player(102, "WORLDBOSS_CMD", (ctx, p, pkt) => worldBossCmd(ctx, p, pkt), "partial");
}

function enterPkt(p: GamePlayer, bp: BossPlayer): GSPacket {
  const c = p.info;
  const o = new GSPacket(102);
  o.writeByte(3);
  o.writeInt(c.Grade); o.writeInt(c.Hide); o.writeInt(c.Repute ?? 0); o.writeInt(c.ID); o.writeString(c.NickName ?? "");
  o.writeByte(c.typeVIP ?? 0); o.writeInt(c.VIPLevel ?? 0); o.writeBoolean(!!c.Sex);
  o.writeString(c.Style ?? ""); o.writeString(c.Colors ?? ""); o.writeString(c.Skin ?? "");
  o.writeInt(bp.x); o.writeInt(bp.y); o.writeInt(c.FightPower ?? 0); o.writeInt(c.Win); o.writeInt(c.Total); o.writeInt(c.Offer);
  o.writeByte(bp.state); o.writeInt(0); o.writeInt(0); o.writeInt(0);
  return o;
}

/** WorldBoss/Handle/*.cs (byte sub). The fight itself is a PvE room type 14 on `pveId` (RoomMgr). */
function worldBossCmd(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): void {
  const rt = eventsRuntime(ctx);
  const b = rt.boss;
  const sub = pkt.readByte();
  const toRoom = (o: GSPacket) => { for (const id of b.players.keys()) ctx.world.get(id)?.send(o); };
  switch (sub) {
    case 32: { // EnterRoom
      const o = new GSPacket(102);
      o.writeByte(2); o.writeBoolean(!!b.window); o.writeBoolean(false); o.writeInt(0); o.writeInt(0);
      p.send(o);
      return;
    }
    case 34: { // AddPlayer
      const x = pkt.readInt();
      const y = pkt.readInt();
      if (!b.window) return;
      const bp: BossPlayer = { x: x || 265, y: y || 1030, state: 1 };
      const isNew = !b.players.has(p.id);
      b.players.set(p.id, bp);
      if (!b.rank.has(p.id)) b.rank.set(p.id, { nick: p.info.NickName ?? "", damage: 0, honor: 0 });
      if (isNew) toRoom(enterPkt(p, bp));
      for (const [id, o] of b.players) { const op = ctx.world.get(id); if (op && id !== p.id) p.send(enterPkt(op, o)); }
      const up = new GSPacket(102);
      up.writeByte(5); up.writeBoolean(false); up.writeInt(b.maxBlood); up.writeInt(b.blood);
      p.send(up);
      p.send(worldBossRanking(rt, false));
      return;
    }
    case 33: { // LeaveRoom
      if (!b.players.delete(p.id)) return;
      const o = new GSPacket(102);
      o.writeByte(4); o.writeInt(p.id);
      toRoom(o); p.send(o);
      return;
    }
    case 35: { // Move
      const x = pkt.readInt(); const y = pkt.readInt(); const path = pkt.readString();
      const bp = b.players.get(p.id);
      if (!bp) return;
      bp.x = x; bp.y = y;
      const o = new GSPacket(102);
      o.writeByte(6); o.writeInt(p.id); o.writeInt(x); o.writeInt(y); o.writeString(path);
      toRoom(o);
      return;
    }
    case 36: { // Status
      const st = pkt.readByte();
      const bp = b.players.get(p.id);
      if (!bp) return;
      // WorldBoss/Handle/Status.cs: state 3 (dead/back from the fight) only leaves the fight room; the player stays in
      // the boss room (fixed: we removed them, so 37 REQUEST_REVIVE was refused with "not enough Xu")
      if (st !== 3 || bp.state !== 3) {
        const o = new GSPacket(102);
        o.writeByte(7); o.writeInt(p.id); o.writeByte(st); o.writeInt(bp.x); o.writeInt(bp.y);
        toRoom(o);
      }
      bp.state = st;
      return;
    }
    case 37: { // RequestRevive: int type (1 revive / 2 refight), bool bind — ReviveMoney 1000 / ReFightMoney 1200
      const type = pkt.readInt(); pkt.readBoolean();
      const cost = type === 2 ? 1200 : 1000;
      if (!b.window) return;
      if (p.info.Money < cost) return p.sendMessage(0, ctx.lang.t("UserBuyItemHandler.NoMoney"));
      p.info.Money -= cost; p.updateProperties();
      const o = new GSPacket(102);
      o.writeByte(11); o.writeInt(p.id);
      toRoom(o);
      return;
    }
    case 38: { // BuyBuff: 30 money, charged once (the original charged twice)
      if (!b.players.has(p.id) || p.info.Money < 30) return p.sendMessage(0, ctx.lang.t("UserBuyItemHandler.NoMoney"));
      p.info.Money -= 30; p.updateProperties();
      const o = new GSPacket(102);
      o.writeByte(12); o.writeBoolean(true); o.writeInt(1);
      p.send(o);
      return;
    }
  }
}

/** Removes a quitting player from the boss room. */
export function eventsOnQuit(ctx: ServerContext, p: GamePlayer): void {
  const b = runtimes.get(ctx)?.boss;
  if (b?.players.delete(p.id)) {
    const o = new GSPacket(102);
    o.writeByte(4); o.writeInt(p.id);
    for (const id of b.players.keys()) ctx.world.get(id)?.send(o);
  }
}

