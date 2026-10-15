/** Shared persisted charge accounting only; no prices, rewards, HTTP or database access. */
export interface ChargePersistentState {
  version: 1; kind: "charge-native"; rulesVersion: 1; grossSpent: number; grossCapped: boolean; trackingStartedAt: string | null;
  day: string; catalogVersion: "charge-material-v1"; bought: [number, number, number, number, number, number, number];
}
export class ActivityAccountingError extends Error {}
export const ACTIVITY_GROSS_LIMIT = 2_147_483_647;
export const CHARGE_BUY_LIMITS = [1, 2, 3, 3, 3, 3, 3] as const;
const int = (n: unknown, min = 0, max = ACTIVITY_GROSS_LIMIT): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new ActivityAccountingError(message); }
export function activityUtcDay(now: Date) {
  need(now instanceof Date && Number.isFinite(now.getTime()), "任务活动日期无效。"); return now.toISOString().slice(0, 10);
}
export function validActivityDay(n: unknown): n is string {
  return typeof n === "string" && /^\d{4}-\d{2}-\d{2}$/.test(n) && Number.isFinite(new Date(n + "T00:00:00Z").getTime())
    && new Date(n + "T00:00:00Z").toISOString().slice(0, 10) === n;
}
export function readChargePersistentState(value: unknown, now: Date): ChargePersistentState {
  const day = activityUtcDay(now);
  if (value === undefined) return { version: 1, kind: "charge-native", rulesVersion: 1, grossSpent: 0, grossCapped: false,
    trackingStartedAt: null, day, catalogVersion: "charge-material-v1", bought: [0, 0, 0, 0, 0, 0, 0] };
  need(value && typeof value === "object" && !Array.isArray(value), "任务活动存档无效。");
  const s = value as ChargePersistentState;
  need(s.version === 1 && s.kind === "charge-native" && s.rulesVersion === 1 && s.catalogVersion === "charge-material-v1"
    && validActivityDay(s.day) && int(s.grossSpent) && typeof s.grossCapped === "boolean" && (!s.grossCapped || s.grossSpent === ACTIVITY_GROSS_LIMIT)
    && (s.trackingStartedAt === null || typeof s.trackingStartedAt === "string" && Number.isFinite(new Date(s.trackingStartedAt).getTime())
      && new Date(s.trackingStartedAt).toISOString() === s.trackingStartedAt)
    && (s.grossSpent === 0 || s.trackingStartedAt !== null)
    && Array.isArray(s.bought) && s.bought.length === 7 && s.bought.every((n, i) => int(n, 0, CHARGE_BUY_LIMITS[i])), "任务活动进度或目录无效。");
  const next = structuredClone(s); if (next.day !== day) { next.day = day; next.bought = [0, 0, 0, 0, 0, 0, 0]; } return next;
}
/** Preserve the existing cost metadata semantics and saturate without blocking successful spending. */
export function recordActivitySpending(value: unknown, now: Date, cost: number): ChargePersistentState {
  const s = readChargePersistentState(value, now);
  if (cost > 0) { s.trackingStartedAt ??= now.toISOString(); s.grossCapped ||= cost >= ACTIVITY_GROSS_LIMIT - s.grossSpent;
    s.grossSpent = Math.min(ACTIVITY_GROSS_LIMIT, s.grossSpent + cost); }
  return s;
}
