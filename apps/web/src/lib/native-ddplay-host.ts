import { ActivityRequestError, type ActivityAction, type ActivityRequest, type ActivityResponse } from "./activities";
import {
  attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost,
} from "./native-activity-host";

export type NativeDDPlayEnvelope = NativeActivityEnvelope;
export interface NativeDDPlayPlayer {
  workshopDDPlayAcceptSnapshot?: (envelope: NativeDDPlayEnvelope) => unknown;
  workshopDDPlayRejectRequest?: (envelope: NativeDDPlayEnvelope) => unknown;
}
export interface NativeDDPlayCallbackTarget {
  workshopDDPlayRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopDDPlayRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopDDPlayReport?: (status: unknown) => void;
}
export interface NativeDDPlayHostOptions {
  player: NativeDDPlayPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeDDPlayCallbackTarget;
  onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global {
  interface Window extends NativeDDPlayCallbackTarget {
    workshopShowDDPlay?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
  }
}
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
function nativeAction(value: unknown): ActivityAction | null {
  if (!nativeObject(value) || !Object.hasOwn(value, "type")) return null;
  if (value.type === "spin" && Object.keys(value).length === 1) return { type: "spin" };
  if (value.type === "exchange" && Object.hasOwn(value, "count") && Object.keys(value).every(key => key === "type" || key === "count")
    && integer(value.count, 1, 10)) return { type: "exchange", count: value.count };
  return null;
}
function validatePublic(snapshot: ActivityResponse) {
  const p = snapshot.nativeDDPlay;
  const fail = () => { throw new ActivityRequestError("原版弹弹乐公开数据不完整，请重试原操作。", true); };
  if (!nativeObject(p) || p.version !== 1 || p.kind !== "ddplay-native"
    || !integer(p.spins, 0, 1_000_000_000) || !integer(p.score, 0, 2_147_483_647) || p.score !== snapshot.points
    || p.spinCost !== 10 || typeof p.canSpin !== "boolean" || typeof p.canExchange !== "boolean"
    || !nativeObject(p.exchange) || p.exchange.cost !== 10 || p.exchange.maxCount !== 10
    || p.exchange.templateId !== 11019 || p.exchange.itemCount !== 1
    || !nativeObject(p.localRules) || p.localRules.version !== 1 || typeof p.localRules.description !== "string"
    || ["state", "games", "seed"].some(key => key in p)) return fail();
  if (p.lastResult === null) { if (p.spins !== 0) return fail(); return; }
  const r = p.lastResult;
  if (p.spins === 0 || !nativeObject(r) || ![0, 2, 3, 5, 10].includes(r.multiplier as number)
    || !Array.isArray(r.reels) || r.reels.length !== 3 || r.reels.some(n => !integer(n, 1, 3))) return fail();
  const unique = new Set(r.reels).size;
  const multiplier = unique === 3 ? 0 : unique === 2 ? 2 : [3, 5, 10][(r.reels[0] as number) - 1];
  if (r.multiplier !== multiplier) return fail();
}
export const retryNativeDDPlayRequest = (request: ActivityRequest) =>
  request.activityId === "ddplay-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeDDPlayHost(options: NativeDDPlayHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopDDPlayAcceptSnapshot === "function" && typeof options.player.workshopDDPlayRejectRequest === "function",
    accept: envelope => options.player.workshopDDPlayAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopDDPlayRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopDDPlayRead = read; target.workshopDDPlayRequest = request; target.workshopDDPlayReport = report;
      return () => {
        if (target.workshopDDPlayRead === read) delete target.workshopDDPlayRead;
        if (target.workshopDDPlayRequest === request) delete target.workshopDDPlayRequest;
        if (target.workshopDDPlayReport === report) delete target.workshopDDPlayReport;
      };
    },
  }, { activityId: "ddplay-native", title: "原版弹弹乐", effectKey: "nativeDDPlayAction", parseAction: nativeAction, validatePublic });
}
