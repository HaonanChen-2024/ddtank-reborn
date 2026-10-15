/** Online-only Labyrinth clean-out clock. All mutations use the actual client's
 * settlement queue; a timer never waits for work accepted by its own handler. */
import type { FightGame } from "../fight/types.js";
import type { ServerContext } from "../session/context.js";
import type { GamePlayer, PacketSink } from "./player.js";
import { advanceLabyrinthCleanOut, type LabyrinthCleanOutSnapshot, type LabyrinthRow } from "./labyrinth.js";
import { initialLabyrinthCleanOutPhase } from "./labyrinth-clean-out-checkpoint.js";

interface Task {
  readonly revision: number;
  readonly snapshot: LabyrinthCleanOutSnapshot;
  readonly seconds: number;
  readonly untilFloor: number;
  started: boolean;
  done: boolean;
  failed: boolean;
  promise: Promise<void>;
}
interface Run {
  readonly player: GamePlayer;
  readonly sink: PacketSink;
  readonly world: ServerContext["world"];
  snapshot: LabyrinthCleanOutSnapshot;
  anchor: number;
  pausedAt: number | null;
  untilFloor: number;
  revision: number;
  active: boolean;
  sealed: boolean;
  task: Task | null;
}

const day = (date: Date): string => date.toISOString().slice(0, 10);
const snapshot = (row: LabyrinthRow): LabyrinthCleanOutSnapshot => ({
  day: day(row.LastDate), currentFloor: row.currentFloor, myProgress: row.myProgress,
  remainTime: row.remainTime, currentRemainTime: row.currentRemainTime, cleanOutAllTime: row.cleanOutAllTime,
});
const paid = (row: LabyrinthRow): boolean => row.isCleanOut && row.completeChallenge
  && Number.isSafeInteger(row.currentFloor) && row.currentFloor >= 1 && row.currentFloor <= row.myProgress
  && Number.isSafeInteger(row.myProgress) && row.myProgress <= 40
  && [row.remainTime, row.currentRemainTime, row.cleanOutAllTime].every(n => Number.isSafeInteger(n) && n > 0);

const owners = new WeakMap<ServerContext, LabyrinthCleanOutOwner>();
export function labyrinthCleanOutOwner(ctx: ServerContext): LabyrinthCleanOutOwner {
  let owner = owners.get(ctx);
  if (!owner) { owner = new LabyrinthCleanOutOwner(ctx); owners.set(ctx, owner); }
  return owner;
}

export class LabyrinthCleanOutOwner {
  private readonly runs = new Map<GamePlayer, Run>();
  private readonly pending = new Set<Promise<void>>();
  private shuttingDown = false;
  constructor(private readonly ctx: ServerContext) {}
  get stopping(): boolean { return this.shuttingDown; }

  private assertOwner(run: Run): void {
    if (this.runs.get(run.player) !== run || run.player.sink !== run.sink || this.ctx.world !== run.world
      || run.world.get(run.player.id) !== run.player)
      throw new Error("Labyrinth clean-out session was replaced");
  }

  /** Called after a committed 131 update, or once when loading an existing row. */
  sync(p: GamePlayer, row: LabyrinthRow, reset = false, phase?: number | null): void {
    if (row.UserID !== p.id || this.ctx.world.get(p.id) !== p)
      throw new Error("Labyrinth clean-out player does not own this row");
    const old = this.runs.get(p);
    if (old?.task?.started && !old.task.done)
      throw new Error("Labyrinth clean-out settlement must recover before synchronization");
    if (old) this.assertOwner(old);
    if (this.shuttingDown || old?.sealed || !p.isActive || p.quitting || (p.sink as PacketSink & { closed?: boolean }).closed) return;
    const now = this.ctx.now(), time = now.getTime(), next = snapshot(row);
    const nextPhase = phase ?? initialLabyrinthCleanOutPhase(this.ctx, row);
    const knownPhase = Number.isSafeInteger(nextPhase) && nextPhase > 0
      && nextPhase + 120 * (row.myProgress - row.currentFloor) <= Math.min(row.remainTime, row.currentRemainTime);
    const active = paid(row) && next.day === day(now) && knownPhase;
    if (paid(row) && next.day === day(now) && !knownPhase)
      p.sendMessage(0, "迷宫扫荡计时无法安全恢复，请重新报价或手动加速。");
    if (!old) {
      if (!active || !p.sink.enqueueCombatSettlement) return;
      this.runs.set(p, { player: p, sink: p.sink, world: this.ctx.world, snapshot: next, anchor: time, pausedAt: null,
        untilFloor: nextPhase, revision: 0, active, sealed: false, task: null });
      return;
    }
    old.revision++; // A queued, not-yet-started tick must not apply its old snapshot.
    if (reset || old.snapshot.day !== next.day || old.snapshot.currentFloor !== next.currentFloor) {
      old.untilFloor = nextPhase; old.anchor = time; old.pausedAt = active ? null : time;
    } else if (active && old.pausedAt !== null) {
      old.anchor += Math.max(0, time - old.pausedAt); old.pausedAt = null;
    } else if (!active && old.pausedAt === null) old.pausedAt = time;
    if (knownPhase) old.untilFloor = nextPhase;
    old.snapshot = next; old.active = active;
  }

  /** Registers at most one immutable elapsed interval for each online player. */
  tick(): void {
    if (this.shuttingDown) return;
    const now = this.ctx.now(), time = now.getTime();
    for (const run of this.runs.values()) {
      if (!run.active || run.sealed || run.task || !run.player.isActive || run.player.quitting
        || this.ctx.world !== run.world || run.world.get(run.player.id) !== run.player || run.player.sink !== run.sink
        || (run.sink as PacketSink & { closed?: boolean }).closed) continue;
      // Midnight is reset by the existing 131 handler, never by this producer.
      if (run.snapshot.day !== day(now)) continue;
      const seconds = Math.floor((time - run.anchor) / 1000);
      if (!Number.isSafeInteger(seconds) || seconds < 1) continue;
      const task: Task = { revision: run.revision, snapshot: { ...run.snapshot }, seconds,
        untilFloor: run.untilFloor, started: false, done: false, failed: false, promise: Promise.resolve() };
      run.task = task; this.schedule(run, task);
    }
  }

  private schedule(run: Run, task: Task): void {
    task.failed = false;
    const work = async (): Promise<void> => {
      let release: (() => void) | undefined;
      try {
        if (!task.started && task.revision !== run.revision) {
          task.done = true; if (run.task === task) run.task = null; return;
        }
        task.started = true;
        await run.player.withWorldBossAward(async () => {
          this.assertOwner(run);
          const current = run.player.currentRoom?.game;
          // A running packet may itself await a deferred fight command. Taking
          // its gate before this client-queue checkpoint would deadlock it.
          // Paid sweep and the only queue-external gate producer (solo room15)
          // are mutually exclusive at Labyrinth admission.
          if (current) release = await this.hold(current);
          this.assertOwner(run);
          if (run.player.currentRoom?.game !== current) throw new Error("Labyrinth clean-out fight was replaced");
          const result = await advanceLabyrinthCleanOut(this.ctx, run.player, task.snapshot, task.seconds, task.untilFloor);
          if (result) {
            run.snapshot = snapshot(result.row); run.untilFloor = result.untilFloor;
            run.anchor += task.seconds * 1000; run.active = paid(result.row);
          } else {
            run.active = false; run.sealed = true;
            if (this.runs.get(run.player) === run) this.runs.delete(run.player);
          }
          task.done = true;
          if (run.task === task) run.task = null;
        });
      } catch (error) { task.started = true; task.failed = true; throw error; }
      finally { release?.(); }
    };
    let promise: Promise<void>;
    try { promise = run.sink.enqueueCombatSettlement!(work); }
    catch (error) {
      task.started = true; task.failed = true; promise = Promise.reject(error);
    }
    task.promise = promise; this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), error => {
      this.pending.delete(promise);
      this.ctx.log.error(`Labyrinth clean-out ${run.player.id}: settlement failed`, error);
    });
  }

  private hold(fight: FightGame): Promise<() => void> {
    if (!fight.holdWorldBossSettlement) throw new Error("Labyrinth clean-out fight has no settlement barrier");
    return fight.holdWorldBossSettlement();
  }

  /** 131 cannot await a retry it just accepted on its own packet queue. */
  recovering(p: GamePlayer): boolean {
    const run = this.runs.get(p), task = run?.task;
    if (!run || !task?.started) return false;
    if (task.failed) this.schedule(run, task);
    return !task.done;
  }

  private async settle(run: Run): Promise<void> {
    const task = run.task;
    if (task?.failed) this.schedule(run, task);
    if (task) await task.promise;
    if (run.task?.failed) throw new Error("Labyrinth clean-out settlement is not durable; database close refused");
    if (run.sealed && this.runs.get(run.player) === run) this.runs.delete(run.player);
  }

  async beforeQuit(p: GamePlayer): Promise<void> {
    const run = this.runs.get(p);
    if (!run) return;
    run.sealed = true;
    await this.settle(run);
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    for (const run of this.runs.values()) run.sealed = true;
  }

  async drain(): Promise<void> {
    if (this.shuttingDown) for (const run of [...this.runs.values()]) await this.settle(run);
    while (this.pending.size) await Promise.all([...this.pending]);
    if ([...this.runs.values()].some(run => run.task?.failed))
      throw new Error("Labyrinth clean-out settlement is not durable; database close refused");
  }
}
