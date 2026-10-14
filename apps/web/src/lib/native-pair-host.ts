import {
  ActivityRequestError, clearPendingActivity, getActivities, isActivityInFlight,
  performActivity, readPendingActivity, sameActivityRequest, savePendingActivity,
  type ActivityAction, type ActivityRequest, type ActivityResponse,
} from "./activities";

export interface NativePairEnvelope {
  generation: string; sequence: number; requestId?: string; snapshot?: ActivityResponse;
  definitive?: boolean; message?: string;
}
export interface NativePairPlayer {
  workshopPairAcceptSnapshot?: (envelope: NativePairEnvelope) => unknown;
  workshopPairRejectRequest?: (envelope: NativePairEnvelope) => unknown;
}
type Acknowledgement = { accepted: boolean; requestId?: string };
export interface NativePairCallbackTarget {
  workshopPairRead?: (characterId: number, generation: string, sequence: number) => Acknowledgement;
  workshopPairRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => Acknowledgement;
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
interface Operation { sequence: number; request?: ActivityRequest; promise?: Promise<ActivityResponse>; deliveryFailed?: boolean }
export interface NativePairHost { cancel: () => void; retry: (request: ActivityRequest) => Promise<ActivityResponse> | null }
let currentHost: NativePairHost | null = null;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const message = (error: unknown) => error instanceof Error ? error.message : "活动结果尚未确认，请重试原操作。";

function nativeAction(value: unknown): ActivityAction | null {
  if (!object(value) || typeof value.type !== "string") return null;
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

function validateSnapshot(value: ActivityResponse, id: number, revision: number) {
  if (value.characterId !== id || !Number.isSafeInteger(value.revision) || value.revision < Math.max(0, revision))
    throw new ActivityRequestError("返回角色或活动版本不匹配，请重试原操作。", true);
  const p = value.nativePair;
  if (!object(p) || "hiddenDeck" in p || "state" in p || typeof p.started !== "boolean"
    || !object(p.localRules) || p.localRules.version !== 1 || p.localRules.slots !== 32)
    throw new ActivityRequestError("原版翻牌公开数据不完整，请重试原操作。", true);
}

/** Explicit UI retry only. A removed host leaves its UUID for the ordinary web retry path. */
export const retryNativePairRequest = (request: ActivityRequest) => currentHost?.retry(request) ?? null;

/** One host per actual game player; ordinary window close must not detach it. */
export function attachNativePairHost(options: NativePairHostOptions): NativePairHost {
  if (!Number.isSafeInteger(options.characterId) || options.characterId <= 0 || !options.generation)
    throw new Error("原翻牌宿主需要真实角色和固定代次。");
  currentHost?.cancel();
  const target = options.target ?? window;
  const controller = new AbortController();
  let cancelled = false, sequence = 0, revision = -1, operation: Operation | null = null;
  const live = () => !cancelled && !controller.signal.aborted && options.isCurrent();
  const owns = (op: Operation) => live() && operation === op;
  const notice = (text: string) => {
    if (live()) { try { options.onStatus?.({ characterId: options.characterId, generation: options.generation,
      sequence, pending: Boolean(operation), requestId: operation?.request?.requestId ?? "", message: text }); } catch { /* UI observer only. */ } }
  };
  const reject = (op: Operation, error: unknown, definitive: boolean) => {
    if (!owns(op)) return;
    try { options.player.workshopPairRejectRequest?.({ generation: options.generation, sequence: op.sequence,
      requestId: op.request?.requestId, definitive, message: message(error) }); } catch { /* Preserve the stored UUID. */ }
    notice(message(error));
  };
  const deliver = (op: Operation, next: ActivityResponse) => {
    if (!owns(op)) throw new ActivityRequestError("游戏页面已更换，操作编号已保留，请显式重试。", true);
    validateSnapshot(next, options.characterId, revision);
    if (op.request && !next.replayed && next.nativePairAction?.requestId !== op.request.requestId)
      throw new ActivityRequestError("返回操作编号不匹配，请重试原操作。", true);
    const snapshot = { ...next };
    // GET and receipt replay synchronize current state; neither may animate old effects.
    if (!op.request || snapshot.replayed) delete snapshot.nativePairAction;
    try {
      const accepted = options.player.workshopPairAcceptSnapshot?.({ generation: options.generation,
        sequence: op.sequence, requestId: op.request?.requestId, snapshot });
      if (!object(accepted) || accepted.characterId !== options.characterId || accepted.generation !== options.generation
        || accepted.sequence !== op.sequence || accepted.pending !== false || !Number.isSafeInteger(accepted.revision)
        || (accepted.revision as number) < snapshot.revision)
        throw new ActivityRequestError("游戏未确认收到活动结果，请重试原操作。", true);
      if (!owns(op)) throw new Error("游戏页面已更换。");
      if (op.request) clearPendingActivity(op.request);
    } catch {
      // AS may have consumed its pending envelope before a rendering exception.
      // Never resend that envelope blindly; the web retry can still recover the UUID receipt.
      op.deliveryFailed = true;
      throw new ActivityRequestError("原窗口未确认活动结果，请在活动中心重试原操作；核对后重新进入游戏恢复原窗口。", true);
    }
    revision = snapshot.revision; operation = null;
    try { options.onSnapshot?.(snapshot); } catch { /* Confirmed delivery must not become another request. */ }
    return snapshot;
  };
  const execute = (op: Operation): Promise<ActivityResponse> => {
    if (op.promise) return op.promise;
    const work = async () => {
      try {
        if (!owns(op)) throw new ActivityRequestError("游戏页面已更换，请重试原操作。", true);
        const next = op.request ? await performActivity(op.request, controller.signal)
          : await getActivities(options.characterId, controller.signal);
        return deliver(op, next);
      } catch (error) {
        if (owns(op)) {
          let definitive = !op.request || error instanceof ActivityRequestError && !error.uncertain;
          if (definitive && op.request) {
            try { clearPendingActivity(op.request); } catch { definitive = false; }
          }
          reject(op, error, definitive);
          if (definitive) operation = null;
        }
        throw error;
      } finally { op.promise = undefined; }
    };
    op.promise = work();
    return op.promise;
  };
  const valid = (id: number, gen: string, seq: number) => live() && id === options.characterId
    && gen === options.generation && Number.isSafeInteger(seq) && seq > sequence && !operation
    && typeof options.player.workshopPairAcceptSnapshot === "function" && typeof options.player.workshopPairRejectRequest === "function";
  const read: NonNullable<NativePairCallbackTarget["workshopPairRead"]> = (id, gen, seq) => {
    if (!valid(id, gen, seq)) return { accepted: false };
    try {
      if (readPendingActivity(id) || isActivityInFlight(id)) { notice("请先在活动中心重试上一次未确认操作。"); return { accepted: false }; }
      sequence = seq; const op: Operation = { sequence }; operation = op;
      queueMicrotask(() => { if (owns(op)) void execute(op).catch(() => {}); });
      return { accepted: true };
    } catch (error) { notice(message(error)); return { accepted: false }; }
  };
  const request: NonNullable<NativePairCallbackTarget["workshopPairRequest"]> = (id, gen, seq, action) => {
    const parsed = nativeAction(action);
    if (!valid(id, gen, seq) || !parsed) return { accepted: false };
    try {
      if (readPendingActivity(id) || isActivityInFlight(id)) { notice("请先在活动中心确认上一次操作。"); return { accepted: false }; }
      const pending: ActivityRequest = { characterId: id, activityId: "pair-native", action: parsed, requestId: crypto.randomUUID() };
      savePendingActivity(pending);
      sequence = seq; const op: Operation = { sequence, request: pending }; operation = op;
      queueMicrotask(() => { if (owns(op)) void execute(op).catch(() => {}); });
      return { accepted: true, requestId: pending.requestId };
    } catch (error) { notice(message(error)); return { accepted: false }; }
  };
  const report: NonNullable<NativePairCallbackTarget["workshopPairReport"]> = status => {
    if (!live() || !object(status) || status.characterId !== options.characterId || status.generation !== options.generation
      || status.sequence !== sequence) return;
    try { options.onStatus?.(status); } catch { /* UI observer only. */ }
  };
  const host: NativePairHost = {
    cancel() {
      if (cancelled) return;
      cancelled = true; controller.abort();
      if (target.workshopPairRead === read) delete target.workshopPairRead;
      if (target.workshopPairRequest === request) delete target.workshopPairRequest;
      if (target.workshopPairReport === report) delete target.workshopPairReport;
      if (currentHost === host) currentHost = null;
    },
    retry(pending) {
      return live() && operation?.request && !operation.deliveryFailed && sameActivityRequest(operation.request, pending) ? execute(operation) : null;
    },
  };
  target.workshopPairRead = read; target.workshopPairRequest = request; target.workshopPairReport = report;
  currentHost = host;
  return host;
}
