/**
 * EventScheduler — the timed systems the original left commented out (GameServer.cs:316 world-boss timer,
 * ActiveSystemMgr league scan, Center ExerciseMgr elite state 904–912, weekly reset in GamePlayer login) as one
 * scheduler driven by app."ScheduledEvents" (admin Events page). Pure window maths in `windowsAt` (tested), the class
 * polls every `tickMs`, fires `onStart/onEnd` on transitions and exposes the double exp/gold rates.
 * All times are UTC (TZ=UTC, like the rest of the port).
 */
import { sql } from "drizzle-orm";
import type { Database } from "@ddt/db";

export type ScheduledKind = "worldboss" | "league" | "elite" | "weekly_reset" | "double_exp" | "double_gold" | string;

export interface ScheduledEvent {
  id: number;
  kind: ScheduledKind;
  title: string;
  enabled: boolean;
  /** "0,1,...,6" — 0 = Sunday (Date.getUTCDay). */
  weekdays: string;
  /** "HH:MM" UTC. */
  startTime: string;
  durationMin: number;
  startDate: Date | null;
  endDate: Date | null;
  params: Record<string, unknown>;
}

export interface ActiveWindow {
  ev: ScheduledEvent;
  start: Date;
  end: Date;
  /** Stable id of this occurrence (`<eventId>@<start ISO>`), used for once-per-window side effects. */
  key: string;
}

const DAY = 86_400_000;

function parseTime(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return 0;
  return (Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]))) * 60_000;
}

function days(s: string): Set<number> {
  return new Set(s.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6));
}

/** Occurrence of `ev` that contains `now`, if any (an occurrence may start the previous day and cross midnight). */
export function occurrenceAt(ev: ScheduledEvent, now: Date): ActiveWindow | null {
  if (!ev.enabled || ev.durationMin <= 0) return null;
  if (ev.startDate && now < ev.startDate) return null;
  if (ev.endDate && now >= ev.endDate) return null;
  const wd = days(ev.weekdays);
  const t = parseTime(ev.startTime);
  const today = Math.floor(now.getTime() / DAY) * DAY;
  const span = ev.durationMin * 60_000;
  // look back far enough for windows longer than a day
  const back = Math.ceil(span / DAY);
  for (let d = 0; d <= back; d++) {
    const base = today - d * DAY;
    if (!wd.has(new Date(base).getUTCDay())) continue;
    const start = base + t;
    if (now.getTime() >= start && now.getTime() < start + span) {
      const s = new Date(start);
      return { ev, start: s, end: new Date(start + span), key: `${ev.id}@${s.toISOString()}` };
    }
  }
  return null;
}

/** Every window open at `now`. */
export function windowsAt(events: ScheduledEvent[], now: Date): ActiveWindow[] {
  const out: ActiveWindow[] = [];
  for (const e of events) {
    const w = occurrenceAt(e, now);
    if (w) out.push(w);
  }
  return out;
}

/** Next start of `ev` strictly after `now` (searches 14 days). */
export function nextStart(ev: ScheduledEvent, now: Date): Date | null {
  if (!ev.enabled) return null;
  const wd = days(ev.weekdays);
  const t = parseTime(ev.startTime);
  const today = Math.floor(now.getTime() / DAY) * DAY;
  for (let d = 0; d < 14; d++) {
    const base = today + d * DAY;
    if (!wd.has(new Date(base).getUTCDay())) continue;
    const s = base + t;
    if (s <= now.getTime()) continue;
    if (ev.endDate && s >= ev.endDate.getTime()) return null;
    if (ev.startDate && s < ev.startDate.getTime()) continue;
    return new Date(s);
  }
  return null;
}

/** Multiplier from open double_exp / double_gold windows (params.rate, default 2; several windows do not stack: max). */
export function rateOf(open: ActiveWindow[], kind: "double_exp" | "double_gold"): number {
  let r = 1;
  for (const w of open) if (w.ev.kind === kind) r = Math.max(r, Number(w.ev.params.rate ?? 2) || 1);
  return r;
}

export interface SchedulerHooks {
  onStart?(w: ActiveWindow): void | Promise<void>;
  onEnd?(w: ActiveWindow): void | Promise<void>;
}

export async function loadScheduledEvents(db: Database): Promise<ScheduledEvent[]> {
  const res = (await db.execute(sql`SELECT * FROM "app"."ScheduledEvents" ORDER BY "id"`)) as unknown;
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    title: String(r.title ?? ""),
    enabled: !!r.enabled,
    weekdays: String(r.weekdays ?? ""),
    startTime: String(r.startTime ?? "00:00"),
    durationMin: Number(r.durationMin ?? 0),
    startDate: r.startDate ? new Date(r.startDate as string) : null,
    endDate: r.endDate ? new Date(r.endDate as string) : null,
    params: (typeof r.params === "string" ? JSON.parse(r.params) : (r.params ?? {})) as Record<string, unknown>,
  }));
}

export class EventScheduler {
  events: ScheduledEvent[] = [];
  open = new Map<string, ActiveWindow>();
  private timer: NodeJS.Timeout | null = null;
  /** Manual overrides from the admin channel: kind -> forced window end (start now). */
  private forced = new Map<string, ActiveWindow>();
  /** Occurrences closed early by `stop` (they reopen at their next scheduled start). */
  private suppressed = new Set<string>();
  private ending = new Set<string>();
  private starting = new Set<string>();
  private ticking: Promise<{ started: ActiveWindow[]; ended: ActiveWindow[] }> | null = null;

  constructor(
    private readonly now: () => Date,
    private readonly hooks: SchedulerHooks = {},
  ) {}

  setEvents(events: ScheduledEvent[]): void {
    this.events = events;
  }

  /** Recomputes the open windows and fires start/end hooks. Returns the transitions (tests). */
  tick(): Promise<{ started: ActiveWindow[]; ended: ActiveWindow[] }> {
    // Timer, admin reload and stop can overlap while a reward transaction awaits.
    // Share that transition pass; failed end hooks remain pending for the next tick.
    if (!this.ticking) this.ticking = this.transition().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async transition(): Promise<{ started: ActiveWindow[]; ended: ActiveWindow[] }> {
    const now = this.now();
    for (const [k, w] of this.forced) if (now >= w.end) this.forced.delete(k);
    const cur = new Map(windowsAt(this.events, now).map((w) => [w.key, w]));
    for (const k of this.suppressed) if (!cur.has(k)) this.suppressed.delete(k);
    for (const k of this.suppressed) cur.delete(k);
    for (const w of this.forced.values()) cur.set(w.key, w);
    const started = [...cur.values()].filter((w) => !this.open.has(w.key) || this.starting.has(w.key));
    const ended = [...this.open.values()].filter((w) => !cur.has(w.key) || this.ending.has(w.key));
    for (const w of ended) {
      this.ending.add(w.key);
      await this.hooks.onEnd?.(w);
      this.open.delete(w.key);
      this.ending.delete(w.key);
      this.starting.delete(w.key);
    }
    for (const w of started) {
      // A hook can establish state before a notification fails. Keep that
      // occurrence so crossing its end still closes it instead of orphaning it.
      this.open.set(w.key, w);
      this.starting.add(w.key);
      await this.hooks.onStart?.(w);
      this.starting.delete(w.key);
    }
    return { started, ended };
  }

  /** Admin "start now" for `minutes` (uses the first event of that kind for params, or an ad-hoc one). */
  force(kind: string, minutes: number): ActiveWindow {
    const now = this.now();
    const base = this.events.find((e) => e.kind === kind);
    const ev: ScheduledEvent = base ? { ...base, enabled: true } : { id: 0, kind, title: kind, enabled: true, weekdays: "", startTime: "00:00", durationMin: minutes, startDate: null, endDate: null, params: {} };
    const w: ActiveWindow = { ev, start: now, end: new Date(now.getTime() + minutes * 60_000), key: `force:${kind}@${now.toISOString()}` };
    this.forced.set(kind, w);
    return w;
  }

  /** Admin "stop now": closes forced and scheduled windows of `kind` until their next occurrence. */
  stop(kind: string): void {
    this.forced.delete(kind);
    for (const w of this.open.values()) if (w.ev.kind === kind) this.suppressed.add(w.key);
  }

  isOpen(kind: string): ActiveWindow | undefined {
    for (const w of this.open.values()) if (w.ev.kind === kind && !this.ending.has(w.key)) return w;
    return undefined;
  }

  rate(kind: "double_exp" | "double_gold"): number {
    return rateOf([...this.open.values()].filter((w) => !this.ending.has(w.key)), kind);
  }

  start(tickMs = 30_000): void {
    this.stopTimer();
    this.timer = setInterval(() => void this.tick().catch(() => {}), tickMs);
    this.timer.unref?.();
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): Record<string, unknown> {
    const now = this.now();
    return {
      now: now.toISOString(),
      pendingEnd: [...this.ending],
      pendingStart: [...this.starting],
      open: [...this.open.values()].map((w) => ({ id: w.ev.id, kind: w.ev.kind, title: w.ev.title, start: w.start, end: w.end })),
      next: this.events.filter((e) => e.enabled).map((e) => ({ id: e.id, kind: e.kind, title: e.title, next: nextStart(e, now) })),
      rates: { exp: this.rate("double_exp"), gold: this.rate("double_gold") },
    };
  }
}
