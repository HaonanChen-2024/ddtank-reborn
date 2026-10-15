/** Server-private sweep phase. Call writes from the same transaction holding
 * the player/Labyrinth row locks, never through the activity wallet. */
import { eq } from "drizzle-orm";
import { app, type Database } from "@ddt/db";
import type { ServerContext } from "../session/context.js";
import type { LabyrinthRow } from "./labyrinth.js";

const fields = ["currentFloor", "myProgress", "remainTime", "currentRemainTime", "cleanOutAllTime"] as const;
const day = (row: LabyrinthRow): string => row.LastDate.toISOString().slice(0, 10);
const validPhase = (row: LabyrinthRow, phase: number): boolean => Number.isSafeInteger(phase) && phase > 0
  && Number.isSafeInteger(row.currentFloor) && row.currentFloor >= 1 && row.currentFloor <= row.myProgress
  && Number.isSafeInteger(row.myProgress) && row.myProgress <= 40
  && [row.remainTime, row.currentRemainTime, row.cleanOutAllTime].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)
  && phase + 120 * (row.myProgress - row.currentFloor) <= Math.min(row.remainTime, row.currentRemainTime);

export async function readLabyrinthCleanOutPhase(db: Database, row: LabyrinthRow): Promise<number | null> {
  const [saved] = await db.select().from(app.LabyrinthCleanOutPhases)
    .where(eq(app.LabyrinthCleanOutPhases.UserID, row.UserID));
  return saved && saved.Day === day(row) && fields.every(key => saved[key] === row[key]) && validPhase(row, saved.untilFloor)
    ? saved.untilFloor : null;
}

export async function saveLabyrinthCleanOutPhase(db: Database, row: LabyrinthRow, phase: number | null): Promise<void> {
  if (phase === null) {
    await db.delete(app.LabyrinthCleanOutPhases).where(eq(app.LabyrinthCleanOutPhases.UserID, row.UserID));
    return;
  }
  if (!validPhase(row, phase)) throw new Error("Invalid Labyrinth clean-out checkpoint phase");
  const saved = { UserID: row.UserID, Day: day(row), currentFloor: row.currentFloor, myProgress: row.myProgress,
    remainTime: row.remainTime, currentRemainTime: row.currentRemainTime, cleanOutAllTime: row.cleanOutAllTime, untilFloor: phase };
  await db.insert(app.LabyrinthCleanOutPhases).values(saved)
    .onConflictDoUpdate({ target: app.LabyrinthCleanOutPhases.UserID, set: saved });
}

/** Zero means an old row has no safely recoverable phase. Never extend its
 * paid remaining time or guess a partial phase under a changed first-phase cfg. */
export function initialLabyrinthCleanOutPhase(ctx: ServerContext, row: LabyrinthRow): number {
  const first = ctx.templates.cfgInt("WarriorFamRaidTimeRemain", 120);
  if (!Number.isSafeInteger(first) || first < 1) return 0;
  const later = 120 * (row.myProgress - row.currentFloor);
  if (row.remainTime === row.currentRemainTime && row.currentRemainTime === row.cleanOutAllTime
    && row.cleanOutAllTime === first + later && validPhase(row, first)) return first;
  const residual = Math.min(row.remainTime, row.currentRemainTime) - later;
  return first === 120 && residual <= 120 && validPhase(row, residual) ? residual : 0;
}
