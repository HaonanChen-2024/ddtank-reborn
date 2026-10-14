import { ActivityRequestError, type ActivityAction, type ActivityRequest, type ActivityResponse } from "./activities";
import {
  attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost,
} from "./native-activity-host";

export type NativePairEnvelope = NativeActivityEnvelope;
export type NativePairHost = NativeActivityHost;
export interface NativePairPlayer {
  workshopPairAcceptSnapshot?: (envelope: NativePairEnvelope) => unknown;
  workshopPairRejectRequest?: (envelope: NativePairEnvelope) => unknown;
}
export interface NativePairCallbackTarget {
  workshopPairRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopPairRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopPairReport?: (status: unknown) => void;
}
export interface NativePairHostOptions {
  player: NativePairPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativePairCallbackTarget;
  onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global {
  interface Window extends NativePairCallbackTarget {
    workshopShowPair?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
  }
}
function nativeAction(value: unknown): ActivityAction | null {
  if (!nativeObject(value) || typeof value.type !== "string") return null;
  const fields: Record<string, string[]> = { start: [], flip: ["index", "choice"], "flip-all": ["choice"],
    "buy-reels": ["count"], reset: ["choice"], exchange: ["choice", "count"] };
  const allowed = Object.hasOwn(fields, value.type) ? fields[value.type] : undefined;
  if (!allowed || Object.keys(value).some(key => key !== "type" && !allowed.includes(key))) return null;
  const positive = (n: unknown, max: number) => typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= max;
  const choice = (choices: string[]) => typeof value.choice === "string" && choices.includes(value.choice);
  if (value.type === "flip" && (!positive(value.index, 32) || !choice(["tickets", "points"]))) return null;
  if (value.type === "flip-all" && !choice(["tickets", "points"])) return null;
  if (value.type === "reset" && !choice(["free", "points"])) return null;
  if (value.type === "buy-reels" && !positive(value.count, 64)) return null;
  if (value.type === "exchange" && (!positive(value.count, 10) || !choice(["11019", "11001", "11021", "11002"]))) return null;
  return { ...value } as unknown as ActivityAction;
}
export const retryNativePairRequest = (request: ActivityRequest) => request.activityId === "pair-native" ? retryNativeActivityRequest(request) : null;
export function attachNativePairHost(options: NativePairHostOptions): NativePairHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopPairAcceptSnapshot === "function" && typeof options.player.workshopPairRejectRequest === "function",
    accept: envelope => options.player.workshopPairAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopPairRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopPairRead = read; target.workshopPairRequest = request; target.workshopPairReport = report;
      return () => {
        if (target.workshopPairRead === read) delete target.workshopPairRead;
        if (target.workshopPairRequest === request) delete target.workshopPairRequest;
        if (target.workshopPairReport === report) delete target.workshopPairReport;
      };
    },
  }, { activityId: "pair-native", title: "原版翻牌", effectKey: "nativePairAction", parseAction: nativeAction,
    validatePublic(snapshot) {
      const p = snapshot.nativePair;
      if (!nativeObject(p) || "hiddenDeck" in p || "state" in p || typeof p.started !== "boolean"
        || !nativeObject(p.localRules) || p.localRules.version !== 1 || p.localRules.slots !== 32)
        throw new ActivityRequestError("原版翻牌公开数据不完整，请重试原操作。", true);
    },
  });
}
