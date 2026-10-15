import type { ActivityAction, ActivityRequest, ActivityResponse } from "./activities";
import { ActivityRequestError } from "./activities";
import { attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost } from "./native-activity-host";

export type NativeChristmasEnvelope = NativeActivityEnvelope;
export interface NativeChristmasPlayer {
  workshopChristmasAcceptSnapshot?: (envelope: NativeChristmasEnvelope) => unknown;
  workshopChristmasRejectRequest?: (envelope: NativeChristmasEnvelope) => unknown;
}
export interface NativeChristmasCallbackTarget {
  workshopChristmasRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopChristmasRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopChristmasReport?: (status: unknown) => void;
}
export interface NativeChristmasHostOptions {
  player: NativeChristmasPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeChristmasCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeChristmasCallbackTarget {
  workshopShowChristmas?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (v: unknown, min = 0, max = 2_147_483_647): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= 4096;
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const token = (v: unknown): v is string => typeof v === "string" && v.length === 54 && day(v.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const fail = (): never => { throw new ActivityRequestError("原版圣诞活动公开数据不完整，请重试原操作。", true); };
const record = (v: unknown, fields: string[]): Record<string, unknown> => nativeObject(v) && exact(v, fields) ? v : fail();
const array = (v: unknown, min = 0, max = 100): unknown[] => Array.isArray(v) && v.length >= min && v.length <= max ? v : fail();
const materials = [11019, 11001, 11021, 11002], quantities = [3, 5, 8, 2], thresholds = [1, 3, 6, 0];
function parseAction(v: unknown): ActivityAction | null {
  if (!nativeObject(v) || !token(v.choice)) return null;
  if (v.type === "craft" && exact(v, ["type", "count", "marked", "choice"]) && integer(v.count, 1, 10) && typeof v.marked === "boolean")
    return { type: v.type, count: v.count, marked: v.marked, choice: v.choice };
  if (v.type === "claim" && exact(v, ["type", "tier", "index", "choice"]) && integer(v.tier, 1, 4)
    && integer(v.index, 0, v.tier === 4 ? 499_999_998 : 0)) return { type: v.type, tier: v.tier, index: v.index, choice: v.choice };
  return null;
}
function reward(v: unknown, tier: number) {
  const r = record(v, ["templateId", "name", "itemCount", "bound", "validDays"]);
  if (r.templateId !== materials[tier - 1] || r.itemCount !== quantities[tier - 1] || !text(r.name, 1) || r.bound !== true || r.validDays !== 0) fail();
}
function progress(v: unknown) {
  const r = record(v, ["count", "exp"]);
  if (!integer(r.count, 0, 1_000_000_000) || !integer(r.exp, 0, 9)) fail();
  return { count: Number(r.count), exp: Number(r.exp) };
}
function validatePublic(snapshot: ActivityResponse, action?: ActivityAction) {
  const p = record(snapshot.nativeChristmas, ["version", "kind", "rulesVersion", "catalogVersion", "day", "revision", "authority", "available", "reason", "stateToken",
    "activity", "snowfield", "currency", "points", "taskEarned", "dailyActionsRemaining", "snowman", "rewards", "rules", "unavailable"]);
  if (p.version !== 1 || p.kind !== "christmas-native" || p.rulesVersion !== 1 || p.catalogVersion !== "christmas-snowman-local-v1"
    || !day(p.day) || p.day !== snapshot.day || !integer(p.revision) || p.revision !== snapshot.revision
    || !["online", "offline", "unavailable"].includes(String(p.authority)) || typeof p.available !== "boolean" || !text(p.reason)
    || p.available && p.authority !== "online" || !p.available && !text(p.reason, 1)
    || p.available && (!token(p.stateToken) || !p.stateToken.startsWith(p.day + ".")) || !p.available && p.stateToken !== null
    || p.currency !== "local-task-points" || !integer(p.points) || p.points !== snapshot.points || !integer(p.taskEarned) || p.taskEarned !== snapshot.earned
    || !integer(p.dailyActionsRemaining, 0, 500)) fail();
  const activity = record(p.activity, ["open", "beginAt", "endAt", "title"]), snowfield = record(p.snowfield, ["available", "reason"]);
  if (activity.open !== true || activity.beginAt !== "1970-01-01T00:00:00.000Z" || activity.endAt !== "2099-12-31T23:59:59.999Z"
    || !text(activity.title, 1) || snowfield.available !== false || !text(snowfield.reason, 1)) fail();
  if (!array(p.rules, 1, 30).every(v => text(v, 1))) fail();
  const unavailable = array(p.unavailable, 3, 3).map(v => record(v, ["id", "reason"]));
  if (new Set(unavailable.map(v => v.id)).size !== 3 || unavailable.some(v => !["original-economy", "snowfield", "official-snowpacks"].includes(String(v.id)) || !text(v.reason, 1))) fail();
  const s = record(p.snowman, ["resource", "resourceLabel", "balance", "entitlement", "usedToday", "count", "exp", "totalExp", "maxCount", "maxDoubleCount", "tasks", "quotes"]);
  if (s.resource !== "local-task-snowpacks" || !text(s.resourceLabel, 1) || !integer(s.balance, 0, 30) || !integer(s.entitlement, 0, 30)
    || !integer(s.usedToday, 0, 30) || s.balance !== Number(s.entitlement) - Number(s.usedToday) || !integer(s.count, 0, 1_000_000_000)
    || !integer(s.exp, 0, 9) || s.totalExp !== 10 || !integer(s.maxCount, 0, 10) || !integer(s.maxDoubleCount, 0, 10)) fail();
  const tasks = array(s.tasks, 0, 4), quotes = array(s.quotes, 0, 20), tiers = array(p.rewards, 0, 4);
  const empty = tasks.length === 0 && quotes.length === 0 && tiers.length === 0;
  if (empty) {
    if (p.authority !== "unavailable" || p.available || [s.balance, s.entitlement, s.usedToday, s.count, s.exp, s.maxCount, s.maxDoubleCount].some(v => v !== 0)) fail();
  } else {
    if (tasks.length !== 4 || quotes.length !== 20 || tiers.length !== 4) fail();
    let entitlement = 0;
    tasks.forEach((v, i) => {
      const t = record(v, ["id", "claimKey", "completed", "packs"]), id = ["sign", "mines", "pair", "explore"][i];
      if (t.id !== id || t.claimKey !== `task:${p.day}:${id}` || typeof t.completed !== "boolean" || t.packs !== [5, 10, 10, 5][i]) fail();
      if (t.completed) entitlement += Number(t.packs);
    });
    if (s.entitlement !== entitlement) fail();
    const maxima = [0, 0];
    quotes.forEach((v, i) => {
      const q = record(v, ["count", "double", "resourceCost", "pointCost", "experienceGained", "canCraft", "reason"]), count = i % 10 + 1, double = i >= 10;
      if (q.count !== count || q.double !== double || q.resourceCost !== count || q.pointCost !== (double ? count * 2 : 0)
        || q.experienceGained !== count * (double ? 2 : 1) || typeof q.canCraft !== "boolean" || !text(q.reason)
        || !q.canCraft && !text(q.reason, 1) || q.canCraft && (!p.available || Number(p.dailyActionsRemaining) < 1
          || count > Number(s.balance) || Number(q.pointCost) > Number(p.points)
          || Number(s.count) + Math.floor((Number(s.exp) + Number(q.experienceGained)) / 10) > 1_000_000_000)) fail();
      if (q.canCraft) maxima[double ? 1 : 0] = count;
    });
    if (s.maxCount !== maxima[0] || s.maxDoubleCount !== maxima[1]) fail();
    tiers.forEach((v, i) => {
      const t = record(v, ["tier", "title", "repeatable", "threshold", "cycle", "nextTarget", "claimed", "canClaim", "reason", "reward"]);
      const repeatable = i === 3;
      if (t.tier !== i + 1 || !text(t.title, 1) || t.repeatable !== repeatable || !integer(t.cycle, 0, repeatable ? 499_999_998 : 0)
        || t.threshold !== (repeatable ? 6 : thresholds[i]) || t.nextTarget !== (repeatable ? 6 + 2 * (Number(t.cycle) + 1) : thresholds[i])
        || typeof t.claimed !== "boolean" || repeatable && t.claimed !== false || typeof t.canClaim !== "boolean" || !text(t.reason)
        || !t.canClaim && !text(t.reason, 1) || t.canClaim && (!p.available || t.claimed || Number(s.count) < Number(t.nextTarget)
          || repeatable && t.cycle === 499_999_998)) fail();
      reward(t.reward, i + 1);
    });
  }
  if (!action || snapshot.replayed) return;
  if (!p.available || p.authority !== "online") fail();
  const envelope = record(snapshot.nativeChristmasAction, ["requestId", "effects"]);
  if (!text(envelope.requestId, 1)) fail();
  const value = array(envelope.effects, 1, 1)[0];
  if (action.type === "craft") {
    const e = record(value, ["type", "count", "double", "resourceCost", "pointCost", "experienceGained", "before", "after", "isUp", "committedRevision"]);
    const before = progress(e.before), after = progress(e.after), xp = Number(action.count) * (action.marked ? 2 : 1);
    if (e.type !== "crafted" || e.count !== action.count || e.double !== action.marked || e.resourceCost !== action.count
      || e.pointCost !== (action.marked ? Number(action.count) * 2 : 0) || e.experienceGained !== xp
      || after.count !== before.count + Math.floor((before.exp + xp) / 10) || after.exp !== (before.exp + xp) % 10
      || after.count !== s.count || after.exp !== s.exp || e.isUp !== (after.count > before.count) || e.committedRevision !== p.revision
      || snapshot.mailedCount !== 0) fail();
  } else if (action.type === "claim") {
    const e = record(value, ["type", "tier", "cycle", "rewards", "committedRevision"]), tier = Number(action.tier), cycle = tier === 4 ? Number(action.index) + 1 : 0;
    const projected = record(tiers[tier - 1], ["tier", "title", "repeatable", "threshold", "cycle", "nextTarget", "claimed", "canClaim", "reason", "reward"]);
    if (e.type !== "claimed" || e.tier !== tier || e.cycle !== cycle || projected.cycle !== cycle || tier !== 4 && projected.claimed !== true
      || e.committedRevision !== p.revision || !integer(snapshot.mailedCount, 1)) fail();
    reward(array(e.rewards, 1, 1)[0], tier);
  } else fail();
}
export const retryNativeChristmasRequest = (request: ActivityRequest) => request.activityId === "christmas-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeChristmasHost(options: NativeChristmasHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopChristmasAcceptSnapshot === "function" && typeof options.player.workshopChristmasRejectRequest === "function",
    accept: e => options.player.workshopChristmasAcceptSnapshot?.(e), reject: e => options.player.workshopChristmasRejectRequest?.(e),
    bind: ({ read, request, report }) => {
      target.workshopChristmasRead = read; target.workshopChristmasRequest = request; target.workshopChristmasReport = report;
      return () => { if (target.workshopChristmasRead === read) delete target.workshopChristmasRead; if (target.workshopChristmasRequest === request) delete target.workshopChristmasRequest; if (target.workshopChristmasReport === report) delete target.workshopChristmasReport; };
    },
  }, { activityId: "christmas-native", title: "原版圣诞活动", effectKey: "nativeChristmasAction", parseAction, validatePublic });
}
