import type { ActivityAction, ActivityRequest, ActivityResponse } from "./activities";
import { ActivityRequestError } from "./activities";
import {
  attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost,
} from "./native-activity-host";

export type NativePurrEnvelope = NativeActivityEnvelope;
export interface NativePurrPlayer {
  workshopPurrAcceptSnapshot?: (envelope: NativePurrEnvelope) => unknown;
  workshopPurrRejectRequest?: (envelope: NativePurrEnvelope) => unknown;
}
export interface NativePurrCallbackTarget {
  workshopPurrRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopPurrRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopPurrReport?: (status: unknown) => void;
}
export interface NativePurrHostOptions {
  player: NativePurrPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativePurrCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativePurrCallbackTarget {
  workshopShowPurr?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const token = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{43}$/.test(v);
const materials = [11019, 11001, 11021, 11002] as const;
function nativeAction(value: unknown): ActivityAction | null {
  if (!nativeObject(value) || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "choice") || !token(value.choice)) return null;
  const exact = (...keys: string[]) => Object.keys(value).every(key => ["type", "choice", ...keys].includes(key));
  if (["start", "continue", "protect", "take-chip", "take-item"].includes(value.type as string) && exact())
    return { type: value.type as string, choice: value.choice };
  if (value.type === "exchange" && Object.hasOwn(value, "index") && integer(value.index, 0, 3)
    && Object.hasOwn(value, "count") && integer(value.count, 1, 10) && exact("index", "count"))
    return { type: "exchange", choice: value.choice, index: value.index, count: value.count };
  return null;
}
function validatePublic(snapshot: ActivityResponse) {
  const p = snapshot.nativeWheel;
  const fail = () => { throw new ActivityRequestError("原版啵咕大转盘公开数据不完整，请重试原操作。", true); };
  if (!nativeObject(p) || p.version !== 1 || p.kind !== "wheel-native" || typeof p.started !== "boolean"
    || typeof p.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.day) || p.day !== snapshot.day
    || !integer(p.score, 0, 2_147_483_647) || p.score !== snapshot.points
    || !integer(p.round, 0, 1_000_000_000) || !integer(p.spinCount, p.round, 1_000_000_000)
    || !integer(p.level, 0, 7) || !integer(p.category, 0, 5) || !integer(p.fragments, 0, 1_000_000_000)
    || !["idle", "active", "failed", "settled"].includes(p.phase as string)
    || !token(p.roundToken) || !p.roundToken.startsWith(p.day + ":")
    || p.startCost !== 20 || p.normalCost !== 10 || p.protectCost !== 20 || p.maxLevel !== 7
    || !Array.isArray(p.categories) || p.categories.length !== 5 || !Array.isArray(p.exchange) || p.exchange.length !== 4
    || !nativeObject(p.localRules) || p.localRules.version !== 1 || typeof p.localRules.description !== "string"
    || ["state", "games", "seed", "rng", "materialIndex"].some(key => key in p)
    || ["canStart", "canContinue", "canProtect", "canTakeChip", "canTakeItem"].some(key => typeof p[key] !== "boolean")) return fail();
  for (const [index, row] of p.categories.entries()) {
    const ids = index < 4 ? [materials[index]] : [...materials];
    if (!nativeObject(row) || row.sourceOriginalIndex !== index + 1 || typeof row.name !== "string" || !row.name
      || !Array.isArray(row.templateIds) || row.templateIds.length !== ids.length || row.templateIds.some((id, i) => id !== ids[i])) return fail();
  }
  const idle = p.phase === "idle", pending = p.phase === "active" || p.phase === "failed";
  const minimumAdditions = p.phase === "failed" ? p.level + 1
    : p.phase === "settled" && p.level === 0 ? 1 : Math.max(0, p.level - 1);
  if (p.spinCount < p.round + minimumAdditions) return fail();
  if (idle ? p.round !== 0 || p.spinCount !== 0 || p.level !== 0 || p.category !== 0 || p.fragments !== 0 || p.roundMaterial !== null
    : p.round === 0 || p.category === 0 || !nativeObject(p.roundMaterial)
      || !materials.includes(p.roundMaterial.templateId as typeof materials[number]) || typeof p.roundMaterial.name !== "string"
      || !p.roundMaterial.name || p.category < 5 && p.roundMaterial.templateId !== materials[p.category - 1]) return fail();
  if (!p.started && !idle || p.phase === "active" && p.level === 0 || p.phase === "failed" && p.level > 5) return fail();
  if (pending) {
    if (!nativeObject(p.pending) || p.pending.chipAmount !== 20 * Math.max(p.level, 1)) return fail();
    if (p.level <= 1 ? p.pending.item !== null : !nativeObject(p.pending.item)
      || !nativeObject(p.roundMaterial) || p.pending.item.templateId !== p.roundMaterial.templateId || p.pending.item.itemCount !== p.level) return fail();
  } else if (p.pending !== null) return fail();
  const chipAmount = pending && nativeObject(p.pending) ? p.pending.chipAmount as number : 0;
  if (p.canTakeChip !== (pending && p.fragments + chipAmount <= 1_000_000_000)
    || p.canTakeItem !== (pending && p.level > 1)
    || p.canStart && (!(idle || p.phase === "settled") || p.score < 20 || p.round >= 1_000_000_000 || p.spinCount >= 1_000_000_000)
    || p.canContinue && (p.phase !== "active" || p.level >= 7 || p.score < 10 || p.spinCount >= 1_000_000_000)
    || p.canProtect && (p.phase !== "active" || p.level >= 7 || p.score < 20 || p.spinCount >= 1_000_000_000)) return fail();
  for (const [index, row] of p.exchange.entries()) {
    if (!nativeObject(row) || row.index !== index || row.templateId !== materials[index] || row.chipCost !== 20
      || row.itemCount !== 1 || row.maxCount !== 10 || row.affordableCount !== Math.min(10, Math.floor(p.fragments / 20))
      || row.canExchange !== (p.fragments >= 20)) return fail();
  }
}
export const retryNativePurrRequest = (request: ActivityRequest) =>
  request.activityId === "wheel-native" ? retryNativeActivityRequest(request) : null;
export function attachNativePurrHost(options: NativePurrHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopPurrAcceptSnapshot === "function" && typeof options.player.workshopPurrRejectRequest === "function",
    accept: envelope => options.player.workshopPurrAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopPurrRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopPurrRead = read; target.workshopPurrRequest = request; target.workshopPurrReport = report;
      return () => {
        if (target.workshopPurrRead === read) delete target.workshopPurrRead;
        if (target.workshopPurrRequest === request) delete target.workshopPurrRequest;
        if (target.workshopPurrReport === report) delete target.workshopPurrReport;
      };
    },
  }, { activityId: "wheel-native", title: "原版啵咕大转盘", effectKey: "nativeWheelAction", parseAction: nativeAction, validatePublic });
}
