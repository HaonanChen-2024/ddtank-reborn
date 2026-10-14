import { ActivityRequestError, type ActivityAction, type ActivityRequest, type ActivityResponse } from "./activities";
import {
  attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost,
} from "./native-activity-host";

export type NativeMinesEnvelope = NativeActivityEnvelope;
export type NativeMinesHost = NativeActivityHost;
export interface NativeMinesPlayer {
  workshopMinesAcceptSnapshot?: (envelope: NativeMinesEnvelope) => unknown;
  workshopMinesRejectRequest?: (envelope: NativeMinesEnvelope) => unknown;
}
export interface NativeMinesCallbackTarget {
  workshopMinesRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopMinesRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopMinesReport?: (status: unknown) => void;
}
export interface NativeMinesHostOptions {
  player: NativeMinesPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeMinesCallbackTarget;
  onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global {
  interface Window extends NativeMinesCallbackTarget {
    workshopShowMines?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
  }
}
const integer = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
function nativeAction(value: unknown): ActivityAction | null {
  if (!nativeObject(value) || !Object.hasOwn(value, "type") || typeof value.type !== "string") return null;
  const fields: Record<string, string[]> = {
    start: [], walk: ["index"], mark: ["index", "marked"], probe: [], revive: [], reset: ["choice"], claim: ["tier"],
  };
  const allowed = Object.hasOwn(fields, value.type) ? fields[value.type] : undefined;
  if (!allowed || Object.keys(value).some(key => key !== "type" && !allowed.includes(key))) return null;
  if ((value.type === "walk" || value.type === "mark") && !integer(value.index, 0, 69)) return null;
  if (value.type === "mark" && typeof value.marked !== "boolean") return null;
  if (value.type === "claim" && !integer(value.tier, 1, 3)) return null;
  if (value.type === "reset" && value.choice !== "free" && value.choice !== "points") return null;
  return { ...value } as unknown as ActivityAction;
}
function validatePublic(snapshot: ActivityResponse) {
  const p = snapshot.nativeMines;
  const fail = () => { throw new ActivityRequestError("原版70格扫雷公开数据不完整，请重试原操作。", true); };
  if (!nativeObject(p) || typeof p.started !== "boolean" || !nativeObject(p.localRules)
    || p.localRules.version !== 1 || p.localRules.width !== 10 || p.localRules.height !== 7
    || p.localRules.manualClaims !== true || ["state", "board", "mines", "seed"].some(key => key in p)) return fail();
  if (!p.started) return;
  if (p.version !== 1 || p.kind !== "mines-native" || p.width !== 10 || p.height !== 7
    || !integer(p.hp, 0, 3) || !integer(p.openCount, 0, 60)
    || (p.currentIndex !== null && !integer(p.currentIndex, 0, 69))
    || !Array.isArray(p.cells) || p.cells.length !== 70 || !Array.isArray(p.claims) || p.claims.length !== 3) return fail();
  for (const [index, c] of p.cells.entries()) {
    if (!nativeObject(c) || c.index !== index || typeof c.opened !== "boolean" || typeof c.marked !== "boolean"
      || typeof c.probed !== "boolean" || (!c.opened && !c.probed && "mine" in c)
      || (!c.opened && "aroundMineCount" in c)
      || ("mine" in c && typeof c.mine !== "boolean")
      || ("aroundMineCount" in c && !integer(c.aroundMineCount, 0, 8))) return fail();
  }
}
export const retryNativeMinesRequest = (request: ActivityRequest) =>
  request.activityId === "mines-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeMinesHost(options: NativeMinesHostOptions): NativeMinesHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopMinesAcceptSnapshot === "function" && typeof options.player.workshopMinesRejectRequest === "function",
    accept: envelope => options.player.workshopMinesAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopMinesRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopMinesRead = read; target.workshopMinesRequest = request; target.workshopMinesReport = report;
      return () => {
        if (target.workshopMinesRead === read) delete target.workshopMinesRead;
        if (target.workshopMinesRequest === request) delete target.workshopMinesRequest;
        if (target.workshopMinesReport === report) delete target.workshopMinesReport;
      };
    },
  }, { activityId: "mines-native", title: "原版扫雷", effectKey: "nativeMinesAction", parseAction: nativeAction, validatePublic });
}
