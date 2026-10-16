/**
 * ConsortiaExtraMgr (levels, buff/badge templates) + ConsortiaTaskMgr (guild missions, 129/22) + the parts of
 * ConsortiaMgr / LoginServerConnector that keep online members' PlayerInfo guild fields in sync (the center's
 * 128 CONSORTIA_RESPONSE broadcasts — single process here, so they are local loops over WorldMgr).
 */
import { PacketOut } from "@ddt/protocol";
import type { ServerContext } from "../session/context.js";
import type { GamePlayer } from "./player.js";
import * as Db from "../db/consortia.js";
import { sendMail } from "../db/social.js";
import * as Out from "../packets/out.js";
import { missionRiches, type LevelRow } from "./consortia.js";

type BuffTemp = Awaited<ReturnType<typeof Db.loadBuffTemps>>[number];
type Badge = Awaited<ReturnType<typeof Db.loadBadges>>[number];
type TaskCfg = Awaited<ReturnType<typeof Db.loadTaskConfig>>[number];

/** ConsortiaTaskConditionInfo (serialised as JSON in Consortia_Task_Info.ConditionData, same keys as C#). */
export interface TaskCondition {
  ID: number;
  TaskID: number;
  Type: number;
  Content: string;
  Value: number;
  Target: number;
  Finish: number;
  TemplateID: number;
  MustWin: boolean;
  MissionID: number;
}

export interface GuildTask {
  consortiaId: number;
  beginTime: Date;
  contribution: number;
  experience: number;
  offer: number;
  buffId: number;
  level: number;
  riches: number;
  /** minutes */
  time: number;
  conditions: TaskCondition[];
  rank: Map<number, number>;
  points: number;
}

const mgrs = new WeakMap<ServerContext, ConsortiaMgr>();

/** One manager per server context (created on first use; templates loaded once). */
export async function consortiaMgr(ctx: ServerContext): Promise<ConsortiaMgr> {
  let m = mgrs.get(ctx);
  if (!m) {
    m = new ConsortiaMgr(ctx);
    mgrs.set(ctx, m);
  }
  await m.ready;
  return m;
}

export class ConsortiaMgr {
  levels = new Map<number, LevelRow>();
  buffs = new Map<number, BuffTemp>();
  badges = new Map<number, Badge>();
  taskCfg: TaskCfg[] = [];
  missionRichesCfg = "";
  readonly tasks = new Map<number, GuildTask>();
  readonly ready: Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly ctx: ServerContext) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const db = this.ctx.db.db;
    const [levels, buffs, badges, cfg, mr, tasks] = await Promise.all([
      Db.loadLevels(db),
      Db.loadBuffTemps(db).catch(() => []),
      Db.loadBadges(db).catch(() => []),
      Db.loadTaskConfig(db).catch(() => []),
      Db.serverConfig(db, "MissionRiches").catch(() => undefined),
      Db.loadTasks(db).catch(() => []),
    ]);
    this.levels = levels;
    this.buffs = new Map(buffs.map((b) => [b.id, b]));
    this.badges = new Map(badges.map((b) => [b.BadgeID, b]));
    this.taskCfg = cfg;
    this.missionRichesCfg = mr ?? "3000|3000|5000|5000|8000|8000|10000|10000|12000|12000";
    for (const t of tasks) {
      if (!t.ConsortiaID || !t.ConditionData) continue;
      try {
        const conditions = JSON.parse(t.ConditionData) as TaskCondition[];
        const rank = new Map<number, number>(Object.entries(JSON.parse(t.RankTable || "{}") as Record<string, number>).map(([k, v]) => [Number(k), v]));
        this.tasks.set(t.ConsortiaID, {
          consortiaId: t.ConsortiaID, beginTime: t.BeginTime ?? new Date(0), contribution: t.Contribution ?? 0, experience: t.Expirience ?? 0, offer: t.Offer ?? 0, buffId: t.BuffID ?? -1,
          level: t.Level ?? 1, riches: t.Riches ?? 0, time: t.Time ?? 120, conditions, rank, points: conditions.reduce((a, c) => a + c.Target, 0),
        });
      } catch {
        /* broken row: ignored like the C# (CreateTaskConditions returns null) */
      }
    }
    // ConsortiaTaskMgr._scanTimer = new Timer(Scan, null, 30000, 60000)
    this.timer = setInterval(() => void this.scan().catch((e) => this.ctx.log.warn(`consortia task scan: ${e}`)), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  t(key: string, fallback: string, ...args: unknown[]): string {
    const s = this.ctx.lang.t(key, ...args);
    if (s !== key) return s;
    return fallback.replace(/\{(\d+)\}/g, (m, n: string) => (Number(n) < args.length ? String(args[Number(n)]) : m));
  }

  online(consortiaId: number): GamePlayer[] {
    if (!consortiaId) return [];
    return this.ctx.world.all().filter((p) => p.info.ConsortiaID === consortiaId);
  }

  /** PlayerInfo.ClearConsortia (+ GamePlayer.ClearConsortia: guild-bank items go back by mail, type 13 StoreCanel). */
  async clearConsortia(p: GamePlayer): Promise<void> {
    const c = p.info;
    Object.assign(c, {
      ConsortiaID: 0, ConsortiaName: "", RichesOffer: 0, RichesRob: 0, ConsortiaRepute: 0, ConsortiaLevel: 0, StoreLevel: 0, ShopLevel: 0, SmithLevel: 0, SkillLevel: 0,
      ConsortiaHonor: 0, DutyLevel: 0, DutyName: "", Right: 0, ConsortiaRiches: 0, ChairmanName: "", IsBanChat: false, badgeID: 0,
    });
    p.buffs = p.buffs.filter((b) => !(b.Type > 100 && b.Type < 115));
    await this.returnBankItems(p);
    p.updateProperties();
  }

  async returnBankItems(p: GamePlayer): Promise<void> {
    if (p.info.ConsortiaID !== 0) return;
    const items = p.consortiaBag.getItems();
    if (!items.length) return;
    for (const it of items) p.consortiaBag.takeOutItem(it);
    const { mailItems } = await import("../handlers/items.js");
    await mailItems(this.ctx, p, items, this.t("Game.Server.GameUtils.ConsortiaBag.Title", "公会保险箱"), 13);
  }

  /** Copy a consortia row into a member's PlayerInfo. */
  applyGuild(p: GamePlayer, c: Db.ConsortiaRow): void {
    Object.assign(p.info, {
      ConsortiaID: c.ConsortiaID, ConsortiaName: c.ConsortiaName, ConsortiaLevel: c.Level, ConsortiaRepute: c.Repute, ConsortiaHonor: c.Honor, ConsortiaRiches: c.Riches,
      StoreLevel: c.StoreLevel, ShopLevel: c.ShopLevel, SmithLevel: c.SmithLevel, SkillLevel: c.SkillLevel, ChairmanName: c.ChairmanName, badgeID: c.BadgeID,
    });
  }

  async refreshRiches(consortiaId: number): Promise<void> {
    const c = await Db.getConsortia(this.ctx.db.db, consortiaId);
    if (c) for (const p of this.online(consortiaId)) p.info.ConsortiaRiches = c.Riches;
  }

  /** 128 CONSORTIA_RESPONSE builder. */
  static response(sub: number): PacketOut {
    const p = new PacketOut(128);
    p.writeByte(sub);
    return p;
  }

  /** LoginServerConnector.SendConsortiaDuty (128.8). */
  static dutyPacket(type: number, cid: number, playerId: number, playerName: string, level: number, dutyName: string, right: number, handleId: number, handleName: string): PacketOut {
    const p = ConsortiaMgr.response(8);
    p.writeByte(type); p.writeInt(cid); p.writeInt(playerId); p.writeString(playerName); p.writeInt(level); p.writeString(dutyName); p.writeInt(right);
    p.writeInt(handleId); p.writeString(handleName);
    return p;
  }

  /** LoginServerConnector.HandleConsortiaDuty: update the online members, then forward 128.8. */
  broadcastDuty(type: number, cid: number, playerId: number, playerName: string, level: number, dutyName: string, right: number, handleId: number, handleName: string): void {
    const pkt = ConsortiaMgr.dutyPacket(type, cid, playerId, playerName, level, dutyName, right, handleId, handleName);
    for (const p of this.online(cid)) {
      if (type === 2 && p.info.DutyLevel === level) p.info.DutyName = dutyName;
      else if (p.id === playerId && type >= 5 && type <= 9) Object.assign(p.info, { DutyLevel: level, DutyName: dutyName, Right: right });
      p.send(pkt);
    }
  }

  /** 129/26 SendUpdateConsotiaBuffer (AbstractPacketLib.cs:589): every buff template with this player's state. */
  buffPacket(p: GamePlayer, now: Date): PacketOut {
    const pkt = new PacketOut(129, p.id);
    pkt.writeByte(26);
    const list = [...this.buffs.values()];
    pkt.writeInt(list.length);
    for (const b of list) {
      const own = p.info.ConsortiaID ? p.buffs.find((x) => x.Type > 100 && x.Type < 115 && x.Data === String(b.id) && x.IsExist && x.BeginDate.getTime() + x.ValidDate * 60_000 > now.getTime()) : undefined;
      pkt.writeInt(b.id);
      pkt.writeBoolean(!!own);
      Out.wd(pkt, own ? own.BeginDate : now);
      pkt.writeInt(own ? Math.trunc(own.ValidDate / 24 / 60) : 0);
    }
    return pkt;
  }

  // ----------------------------------------------------------------------------------------------- guild task

  missionCost(guildLevel: number): number {
    return missionRiches(this.missionRichesCfg, guildLevel);
  }

  activeTask(consortiaId: number, now: Date): GuildTask | null {
    const t = this.tasks.get(consortiaId);
    return t && t.beginTime.getTime() + t.time * 60_000 > now.getTime() ? t : null;
  }

  /** ConsortiaTaskMgr.CreateTask(player, level): 3 random distinct condition types from Consortia_TaskConfig. */
  createTask(consortiaId: number, level: number, now: Date, rnd: () => number = Math.random): GuildTask {
    const existing = this.tasks.get(consortiaId);
    if (existing) return existing;
    let cost = this.missionCost(level);
    if (cost === 0) cost = 3000;
    const types: number[] = [];
    let guard = 0;
    while (types.length < 3 && guard++ < 1000) {
      const r = 1 + Math.floor(rnd() * 49); // ThreadSafeRandom.NextStatic(1, 50)
      const type = r < 10 ? 1 : r < 20 ? 2 : r < 30 ? 3 : r < 40 ? 4 : 5;
      if (!types.includes(type)) types.push(type);
    }
    const conditions: TaskCondition[] = types.map((type, i) => {
      const cfg = this.taskCfg.find((c) => c.Type === type && c.Level === level) ?? this.taskCfg.find((c) => c.Type === type);
      const target = cfg?.TargetCount ?? 10;
      return {
        ID: i, TaskID: 0, Type: type, Content: (cfg?.Content ?? "{0}").replace("{0}", String(target)), Value: 0, Target: target, Finish: 0,
        TemplateID: cfg?.Target ?? 0, MustWin: !!cfg?.Para2, MissionID: cfg?.Target ?? 0,
      };
    });
    const rank = new Map<number, number>();
    for (const p of this.online(consortiaId)) rank.set(p.id, 0);
    const task: GuildTask = {
      consortiaId, beginTime: now, contribution: level * 5000, experience: level * 10000, offer: level * 1000, buffId: -1, level,
      riches: Math.trunc((cost * 3) / 2), time: 120, conditions, rank, points: conditions.reduce((a, c) => a + c.Target, 0),
    };
    this.tasks.set(consortiaId, task);
    void this.saveTask(task);
    return task;
  }

  /** ConsortiaTaskMgr.ResetTask: same level, new conditions. */
  resetTask(consortiaId: number, now: Date): GuildTask {
    const old = this.tasks.get(consortiaId);
    this.tasks.delete(consortiaId);
    return this.createTask(consortiaId, old?.level ?? 1, now);
  }

  async saveTask(t: GuildTask | null, consortiaId = t?.consortiaId ?? 0): Promise<void> {
    await Db.saveTask(
      this.ctx.db.db,
      t && {
        ConsortiaID: t.consortiaId, BeginTime: t.beginTime, Contribution: t.contribution, Expirience: t.experience, Offer: t.offer, BuffID: t.buffId, Level: t.level, Riches: t.riches,
        Time: t.time, ConditionData: JSON.stringify(t.conditions), RankTable: JSON.stringify(Object.fromEntries(t.rank)),
      },
      consortiaId,
    );
  }

  /** ConsortiaTaskPacketsOut.SendTaskInfo. Fix: the C# wrote contribution and level too (a later client layout). */
  taskInfoPacket(t: GuildTask | null): PacketOut {
    const p = new PacketOut(129);
    p.writeByte(22);
    p.writeByte(3); // GET_TASKINFO
    if (!t) {
      p.writeInt(0);
      return p;
    }
    p.writeInt(t.conditions.length);
    for (const c of t.conditions) {
      p.writeInt(c.ID); p.writeInt(c.Type); p.writeString(c.Content); p.writeInt(c.Value); p.writeInt(c.Target); p.writeInt(c.Finish);
    }
    p.writeInt(t.experience); p.writeInt(t.offer); p.writeInt(t.riches); p.writeInt(t.buffId);
    Out.wd(p, t.beginTime);
    p.writeInt(t.time);
    return p;
  }

  static taskChat(msg: string): PacketOut {
    const p = new PacketOut(129, 0);
    p.writeByte(20); p.writeByte(3); p.writeString(""); p.writeString(msg);
    return p;
  }

  /** Condition progress (PvPBattleCondition / GuildBattleCondition / UseItemCondition / MissionCompleteCondition / DonateRichesCondition). */
  private progress(p: GamePlayer, type: number, amount: number, filter?: (c: TaskCondition) => boolean): void {
    const now = this.ctx.now();
    const t = this.activeTask(p.info.ConsortiaID, now);
    if (!t) return;
    const c = t.conditions.find((x) => x.Type === type);
    if (!c || (filter && !filter(c))) return;
    if (c.Value >= c.Target) return;
    const add = Math.min(amount, c.Target - c.Value);
    if (add <= 0) return;
    c.Value += add;
    c.Finish += add;
    t.rank.set(p.id, (t.rank.get(p.id) ?? 0) + add);
    const upd = new PacketOut(129);
    upd.writeByte(22); upd.writeByte(4); upd.writeInt(c.ID); upd.writeInt(c.Value); upd.writeInt(c.Finish);
    for (const m of this.online(t.consortiaId)) m.send(upd);
    if (c.Value >= c.Target) {
      const msg = ConsortiaMgr.taskChat(this.t("Consortia.TaskCondition.Completed", "公会任务：{0}已完成！", c.Content));
      for (const m of this.online(t.consortiaId)) m.send(msg);
    }
    void this.saveTask(t);
  }

  onGameOver(p: GamePlayer, g: { roomType: number; gameType: number; isWin: boolean }): void {
    if (!p.info.ConsortiaID) return;
    // PvPBattleCondition: Match rooms; GuildBattleCondition: guild games (fix: the C# dereferenced a null condition
    // when the player was the room host)
    if (g.roomType === 0) this.progress(p, 1, 1, (c) => !c.MustWin || g.isWin);
    if (g.gameType === 1) this.progress(p, 2, 1, (c) => !c.MustWin || g.isWin);
  }

  onUseItem(p: GamePlayer, templateId: number, count: number): void {
    if (p.info.ConsortiaID) this.progress(p, 3, count, (c) => c.TemplateID === templateId);
  }

  /** MissionCompleteCondition — fix: the C# `||` chain counted every mission (and crashed without the condition). */
  onMission(p: GamePlayer, missionId: number, isWin: boolean): void {
    if (p.info.ConsortiaID && isWin) this.progress(p, 4, 1, (c) => !c.MissionID || c.MissionID === missionId);
  }

  onDonate(p: GamePlayer, riches: number): void {
    if (p.info.ConsortiaID && riches > 0) this.progress(p, 5, riches);
  }

  /** ConsortiaTaskMgr.Scan: expired -> "task complete" notice; all conditions done -> rewards by rank share. */
  async scan(): Promise<void> {
    const now = this.ctx.now();
    for (const t of [...this.tasks.values()]) {
      const members = this.online(t.consortiaId);
      const done = t.conditions.every((c) => c.Value >= c.Target);
      if (t.beginTime.getTime() + t.time * 60_000 < now.getTime()) {
        const msg = ConsortiaMgr.taskChat(this.t("Consortia.Task.Complete", "公会任务已结束。"));
        for (const m of members) m.send(msg);
        this.tasks.delete(t.consortiaId);
        await this.saveTask(null, t.consortiaId);
        continue;
      }
      if (!done) continue;
      const c = await Db.getConsortia(this.ctx.db.db, t.consortiaId);
      if (c) {
        const add = Math.trunc((this.missionCost(c.Level) * 3) / 2);
        await Db.addRiches(this.ctx.db.db, t.consortiaId, add, 0, "", () => "");
        for (const m of members) {
          const share = t.rank.get(m.id) ?? 0;
          const exp = t.points ? Math.trunc((t.experience * share) / t.points) : 0;
          const offer = t.points ? Math.trunc((t.offer * share) / t.points) : 0;
          const contrib = t.points ? Math.trunc((t.contribution * share) / t.points) : 0;
          m.addGP(exp);
          m.addOffer(offer);
          m.info.RichesOffer += contrib;
          m.updateProperties();
          m.sendMessage(2, this.t("Consortia.Task.Reward", "你获得了公会奖励。"));
          await sendMail(this.ctx.db.db, {
            Content: `奖励包括：\n${exp}经验。\n${offer}贡献`, Title: "公会任务", Gold: 0, Money: 0, Type: 59,
            Receiver: m.info.NickName ?? "", ReceiverID: m.id, Sender: m.info.ConsortiaName, SenderID: 0,
          });
          m.send(Out.mailResponse(m.id, 1));
          m.send(ConsortiaMgr.taskChat(this.t("Consortia.Task.Complete", "公会任务已结束。")));
        }
        await this.refreshRiches(t.consortiaId);
      }
      this.tasks.delete(t.consortiaId);
      await this.saveTask(null, t.consortiaId);
    }
  }
}
