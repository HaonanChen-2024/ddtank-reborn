/** Server-owned Labyrinth admission and accepted-outcome lifetime. No packet
 * supplies a fight id, player session, award or run generation to this owner. */
import { randomUUID } from "node:crypto";
import { listScripts, type FightEvent, type PveInfo } from "@ddt/fight";
import type { LabyrinthFightBinding } from "../fight/ddt.js";
import type { FightGame, StartPveOptions } from "../fight/types.js";
import type { BaseRoom } from "../rooms/room.js";
import type { ServerContext } from "../session/context.js";
import { GamePlayer, type PacketSink, type RoomMember } from "./player.js";
import { awardLabyrinthFloor, finishLabyrinthRun, prepareLabyrinthRun, type LabyrinthRunSnapshot } from "./labyrinth.js";

type Award = Extract<FightEvent, { cmd: "LABYRINTH_AWARD" }>;
interface Task {
  work: () => Promise<void>;
  promise: Promise<void>;
  error?: unknown;
  failed: boolean;
  done: boolean;
}
interface Run {
  readonly generation: string;
  readonly player: GamePlayer;
  readonly sink: PacketSink;
  readonly room: BaseRoom;
  readonly hardLevel: number;
  readonly timeType: number;
  readonly gameType: number;
  readonly levelLimits: number;
  readonly expiresAt: number;
  snapshot: LabyrinthRunSnapshot | null;
  fight: FightGame | null;
  fightId: number | null;
  sealed: boolean;
  outcome: boolean | null;
  readonly awards: Map<number, Task>;
  closing: Task | null;
  timer: ReturnType<typeof setTimeout> | null;
  previousRoomLeft: (() => void) | undefined;
  roomLeft: () => void;
}

/** These exact six missing dependencies were checked against donor NPC exports,
 * not the similarly named Boss0 classes. Complete mission headers are required
 * too; strict PveGame never substitutes a generic brain when a script is absent. */
const requiredBrains = [
  [40004, "DCSM40004Boss"], [40007, "DCSM40006Boss"], [40009, "DCSM40008Boss"],
  [40022, "DCSM40016Boss"], [40030, "DCSM40022Boss"], [40032, "DCSM40024Boss"],
] as const;

const ctxLevel = (ctx: ServerContext): number => ctx.templates.pveInfos.get(401)?.LevelLimits ?? 0;

export function labyrinthConfigurationReady(ctx: ServerContext, hardLevel: number): boolean {
  const info = ctx.templates.pveInfos.get(401) as PveInfo | undefined;
  if (!info) return false;
  const scripts = new Map(listScripts().map(s => [s.name, s.kind]));
  const gameScript = [info.SimpleGameScript, info.NormalGameScript, info.HardGameScript, info.TerrorGameScript, info.EpicGameScript][hardLevel === 5 ? 0 : hardLevel];
  if (gameScript !== "GameServerScript.AI.Game.Labyrinth" || scripts.get(gameScript) !== "game") return false;
  for (let id = 40001; id <= 40030; id++) {
    const mission = ctx.templates.missions.get(id);
    if (!mission?.Script || scripts.get(mission.Script.trim()) !== "mission") return false;
  }
  return requiredBrains.every(([id, brain]) => {
    const npc = ctx.templates.npcs.get(id), name = `GameServerScript.AI.NPC.${brain}`;
    return npc?.Script === name && scripts.get(name) === "brain";
  });
}

const owners = new WeakMap<ServerContext, LabyrinthCombatOwner>();
export function labyrinthCombatOwner(ctx: ServerContext): LabyrinthCombatOwner {
  let owner = owners.get(ctx);
  if (!owner) { owner = new LabyrinthCombatOwner(ctx); owners.set(ctx, owner); }
  return owner;
}

export class LabyrinthCombatOwner {
  private readonly runs = new Map<GamePlayer, Run>();
  private readonly pending = new Set<Promise<void>>();
  private shuttingDown = false;
  constructor(private readonly ctx: ServerContext) {}
  get stopping(): boolean { return this.shuttingDown; }

  busy(p: GamePlayer): boolean {
    const run = this.runs.get(p);
    if (run && !run.fight && (this.ctx.now().getTime() > run.expiresAt || !this.roomMatches(p, run.room)))
      void this.finish(run, false).catch(() => {});
    return !!run;
  }

  private forget(run: Run): void {
    if (run.timer) clearTimeout(run.timer);
    if ((run.player as RoomMember).onRoomLeft === run.roomLeft) {
      if (run.previousRoomLeft) (run.player as RoomMember).onRoomLeft = run.previousRoomLeft;
      else delete (run.player as RoomMember).onRoomLeft;
    }
    if (this.runs.get(run.player) === run) this.runs.delete(run.player);
  }

  private roomMatches(p: GamePlayer, room: BaseRoom): boolean {
    return this.ctx.world.get(p.id) === p && p.isActive && !p.quitting && !this.shuttingDown
      && p.currentRoom === room && room.host === p && room.IsUsing && !room.game && !room.IsPlaying
      && room.RoomType === 15 && (room.MapId === 0 || room.MapId === 401)
      && room.getPlayers().length === 1 && room.getPlayersFight()[0] === p;
  }

  /** Called by 94/7 while the actual host's packet owns its client queue. Solo
   * admission is implemented; party admission requires joining every seat's queue. */
  async prepareStart(p: GamePlayer, room: BaseRoom): Promise<boolean> {
    if (this.busy(p) || !this.roomMatches(p, room) || p.worldBossAwardPending || !p.sink.enqueueCombatSettlement) return false;
    if (!labyrinthConfigurationReady(this.ctx, room.HardLevel)) {
      p.sendMessage(0, "迷宫原始关卡配置或怪物脚本尚未补齐，暂不能开始挑战。"); return false;
    }
    if (p.info.Grade < ctxLevel(this.ctx)) { p.sendMessage(0, `角色等级不足，需要${ctxLevel(this.ctx)}级才能挑战迷宫。`); return false; }
    const run: Run = { generation: randomUUID(), player: p, sink: p.sink, room, hardLevel: room.HardLevel,
      gameType: room.GameType, timeType: room.TimeMode, levelLimits: room.LevelLimits,
      expiresAt: this.ctx.now().getTime() + 30000, snapshot: null, fight: null, fightId: null,
      sealed: false, outcome: null, awards: new Map(), closing: null, timer: null,
      previousRoomLeft: (p as RoomMember).onRoomLeft, roomLeft: () => {} };
    run.roomLeft = () => {
      try { run.previousRoomLeft?.(); }
      finally { void this.finish(run, false).catch(() => {}); run.fight?.stop(); }
    };
    (p as RoomMember).onRoomLeft = run.roomLeft;
    this.runs.set(p, run);
    try {
      const row = await p.withWorldBossAward(() => prepareLabyrinthRun(this.ctx, p));
      if (!row) { if (!run.closing) this.forget(run); return false; }
      run.snapshot = { day: row.LastDate.toISOString().slice(0, 10), processAward: row.ProcessAward, currentFloor: row.currentFloor };
      if (!this.roomMatches(p, room)) { void this.finish(run, false).catch(() => {}); return false; }
      // Original SetupChange.cs: map0 means Pve_Info401, with the saved next-floor cursor.
      room.MapId = 401; room.currentFloor = row.currentFloor; room.sendRoomSetupChange();
      run.timer = setTimeout(() => { if (!run.fightId && this.runs.get(p) === run) void this.finish(run, false).catch(() => {}); }, 30000);
      run.timer.unref?.();
      return true;
    } catch (error) {
      if (run.snapshot) void this.finish(run, false).catch(() => {});
      else if (!run.closing) this.forget(run);
      throw error;
    }
  }

  /** Synchronous engine-side consume, tied to the exact room/player objects and
   * configuration captured above. Replays and substituted sessions cannot bind. */
  admit(s: StartPveOptions, fightId: number): LabyrinthFightBinding | null {
    const p = s.players[0];
    if (!(p instanceof GamePlayer)) return null;
    const run = this.runs.get(p);
    if (!run || run.sealed || run.fightId !== null) return null;
    if (!run.snapshot || p.sink !== run.sink || !this.roomMatches(p, run.room)
      || run.room.MapId !== 401 || run.room.currentFloor !== run.snapshot.currentFloor
      || run.room.HardLevel !== run.hardLevel || run.room.TimeMode !== run.timeType
      || run.room.GameType !== run.gameType || run.room.LevelLimits !== run.levelLimits
      || s.players.length !== 1 || s.roomType !== 15 || s.roomId !== run.room.RoomId || s.pveId !== 401
      || s.hardLevel !== run.hardLevel || s.gameType !== run.gameType || s.timeType !== run.timeType
      || s.levelLimits !== run.levelLimits || s.currentFloor !== run.snapshot.currentFloor
      || !Number.isSafeInteger(fightId) || fightId < 1 || this.ctx.now().getTime() > run.expiresAt
      || !labyrinthConfigurationReady(this.ctx, s.hardLevel)) {
      void this.finish(run, false).catch(() => {}); return null;
    }
    run.fightId = fightId;
    if (run.timer) { clearTimeout(run.timer); run.timer = null; }
    return {
      processAwards: new Map([[p.id, run.snapshot.processAward]]),
      started: fight => {
        if (fight.id !== fightId || this.runs.get(p) !== run || run.fight) throw new Error("Invalid Labyrinth fight binding");
        run.fight = fight;
      },
      award: (member, event) => this.award(run, member, event),
      finish: won => this.finish(run, won),
    };
  }

  private assertOwner(run: Run): void {
    if (this.runs.get(run.player) !== run || run.player.sink !== run.sink || this.ctx.world.get(run.player.id) !== run.player)
      throw new Error(`Labyrinth session ${run.generation} was replaced`);
  }

  private schedule(run: Run, task: Task): void {
    task.failed = false; task.done = false; task.error = undefined;
    const work = () => run.player.withWorldBossAward(async () => {
      // A failed old run can outlive its stopped room. If the same player has
      // since joined another fight, freeze that actual writer during recovery.
      const currentFight = run.player.currentRoom?.game;
      let release: (() => void) | undefined;
      try {
        if (currentFight && currentFight !== run.fight) release = await currentFight.holdWorldBossSettlement?.();
        this.assertOwner(run); await task.work(); task.done = true;
      }
      catch (error) { task.failed = true; task.error = error; throw error; }
      finally { release?.(); }
    });
    const promise = task.promise = run.sink.enqueueCombatSettlement!(work);
    this.pending.add(promise);
    void promise.then(() => { this.pending.delete(promise); }, error => {
      task.failed = true; task.error = error; this.pending.delete(promise);
      this.ctx.log.error(`Labyrinth run ${run.generation}: settlement failed`, error);
    });
  }

  private task(run: Run, work: Task["work"]): Task {
    const task: Task = { work, promise: Promise.resolve(), failed: false, done: false };
    this.schedule(run, task); return task;
  }

  private award(run: Run, member: RoomMember, raw: Award): Promise<void> {
    this.assertOwner(run);
    if (run.sealed || this.shuttingDown || member !== run.player || run.player.quitting || !run.player.isActive
      || !run.fight || run.room.game !== run.fight || run.player.currentRoom !== run.room)
      throw new Error("Labyrinth award producer is no longer admitted");
    const previous = run.awards.get(raw.floor);
    if (previous) return previous.promise;
    if (!run.snapshot || raw.userId !== run.player.id || raw.floor !== run.snapshot.currentFloor
      || raw.missionId !== 40000 + raw.floor || raw.floor < 1 || raw.floor > 30
      || typeof raw.bigAward !== "boolean" || (raw.bigAward && raw.floor % 2 !== 0))
      throw new Error("Labyrinth award does not match its bound run");
    const event = Object.freeze({ floor: raw.floor, missionId: raw.missionId, bigAward: raw.bigAward });
    const task = this.task(run, async () => {
      const result = await awardLabyrinthFloor(this.ctx, run.player, event, run.snapshot!);
      if (result) run.snapshot = { ...run.snapshot!, processAward: result.row.ProcessAward, currentFloor: result.row.currentFloor };
    });
    run.awards.set(event.floor, task);
    return task.promise;
  }

  private finish(run: Run, won: boolean): Promise<void> {
    if (run.closing) return run.closing.promise;
    run.sealed = true; run.outcome = won;
    run.closing = this.task(run, async () => {
      if ([...run.awards.values()].some(task => !task.done || task.failed)) throw new Error("Labyrinth layer awards must commit before resetting the run");
      if (run.snapshot) await finishLabyrinthRun(this.ctx, run.player, run.snapshot, run.outcome === true);
      this.forget(run);
    });
    return run.closing.promise;
  }

  private async retry(run: Run): Promise<void> {
    for (const task of run.awards.values()) {
      if (task.failed) this.schedule(run, task);
      await task.promise;
    }
    if (!run.closing) void this.finish(run, false).catch(() => {});
    if (run.closing!.failed) this.schedule(run, run.closing!);
    await run.closing!.promise;
    try { await run.fight?.waitWorldBossSettlement?.(); }
    catch (error) {
      // The adapter deliberately remembers its first failure. Once every award
      // and the close transaction have been retried durably, it can be retired.
      if (!run.closing!.done || [...run.awards.values()].some(task => !task.done || task.failed)) throw error;
      this.ctx.log.warn(`Labyrinth run ${run.generation}: failed fight retired after durable settlement: ${String(error)}`);
    }
  }

  /** Seal first. Previously accepted awards survive closed transport/quitting and
   * room removal; only after their queue drains may the final profile save run. */
  async beforeQuit(p: GamePlayer): Promise<void> {
    const run = this.runs.get(p);
    if (!run) return;
    void this.finish(run, false).catch(() => {});
    run.fight?.stop();
    await this.retry(run);
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    for (const run of this.runs.values()) {
      void this.finish(run, false).catch(() => {});
      run.fight?.stop();
    }
  }

  async drain(): Promise<void> {
    if (this.shuttingDown) for (const run of [...this.runs.values()]) await this.retry(run);
    while (this.pending.size) await Promise.all([...this.pending]);
    if ([...this.runs.values()].some(run => [...run.awards.values(), ...(run.closing ? [run.closing] : [])].some(task => task.failed)))
      throw new Error("Labyrinth settlement is not durable; database close refused");
  }
}
