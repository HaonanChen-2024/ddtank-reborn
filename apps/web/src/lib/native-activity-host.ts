import {
  ActivityRequestError, clearPendingActivity, getActivities, isActivityInFlight,
  performActivity, readPendingActivity, sameActivityRequest, savePendingActivity,
  type ActivityAction, type ActivityRequest, type ActivityResponse,
} from "./activities";

export interface NativeActivityEnvelope {
  generation: string; sequence: number; requestId?: string; snapshot?: ActivityResponse;
  definitive?: boolean; message?: string;
}
export interface NativeActivityAcknowledgement { accepted: boolean; requestId?: string }
export interface NativeActivityCallbacks {
  read: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  request: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  report: (status: unknown) => void;
}
export interface NativeActivityHostOptions {
  characterId: number; generation: string; isCurrent: () => boolean; ready: () => boolean;
  accept: (envelope: NativeActivityEnvelope) => unknown;
  reject: (envelope: NativeActivityEnvelope) => unknown;
  bind: (callbacks: NativeActivityCallbacks) => () => void;
  onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
export interface NativeActivitySpec {
  activityId: "pair-native" | "mines-native" | "ddplay-native" | "gypsy-native"; title: string;
  effectKey: "nativePairAction" | "nativeMinesAction" | "nativeDDPlayAction" | "nativeGypsyAction";
  parseAction: (value: unknown) => ActivityAction | null;
  validatePublic: (snapshot: ActivityResponse) => void;
}
interface Operation { sequence: number; request?: ActivityRequest; promise?: Promise<ActivityResponse>; deliveryFailed?: boolean }
export interface NativeActivityHost { cancel: () => void; retry: (request: ActivityRequest) => Promise<ActivityResponse> | null }
const hosts = new Map<string, NativeActivityHost>();
export const nativeObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const message = (error: unknown) => error instanceof Error ? error.message : "活动结果尚未确认，请重试原操作。";

/** Explicit retry only; all modules still use the single character-owned UUID ledger. */
export const retryNativeActivityRequest = (request: ActivityRequest) => hosts.get(request.activityId)?.retry(request) ?? null;

/** The caller owns the actual player methods and callback names; this owner handles delivery once. */
export function attachNativeActivityHost(options: NativeActivityHostOptions, spec: NativeActivitySpec): NativeActivityHost {
  if (!Number.isSafeInteger(options.characterId) || options.characterId <= 0 || !options.generation)
    throw new Error("原活动宿主需要真实角色和固定代次。");
  hosts.get(spec.activityId)?.cancel();
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
    try { options.reject({ generation: options.generation, sequence: op.sequence,
      requestId: op.request?.requestId, definitive, message: message(error) }); } catch { /* Keep the UUID. */ }
    notice(message(error));
  };
  const deliver = (op: Operation, next: ActivityResponse) => {
    if (!owns(op)) throw new ActivityRequestError("游戏页面已更换，操作编号已保留，请显式重试。", true);
    if (next.characterId !== options.characterId || !Number.isSafeInteger(next.revision) || next.revision < Math.max(0, revision))
      throw new ActivityRequestError("返回角色或活动版本不匹配，请重试原操作。", true);
    spec.validatePublic(next);
    if (op.request && !next.replayed && next[spec.effectKey]?.requestId !== op.request.requestId)
      throw new ActivityRequestError("返回操作编号不匹配，请重试原操作。", true);
    const snapshot = { ...next };
    // GET and replay synchronize current state, including when another module returned old effects.
    for (const key of ["nativePairAction", "nativeMinesAction", "nativeDDPlayAction", "nativeGypsyAction"] as const)
      if (!op.request || snapshot.replayed || key !== spec.effectKey) delete snapshot[key];
    try {
      const accepted = options.accept({ generation: options.generation,
        sequence: op.sequence, requestId: op.request?.requestId, snapshot });
      if (!nativeObject(accepted) || accepted.characterId !== options.characterId || accepted.generation !== options.generation
        || accepted.sequence !== op.sequence || accepted.pending !== false || !Number.isSafeInteger(accepted.revision)
        || (accepted.revision as number) < snapshot.revision)
        throw new ActivityRequestError("游戏未确认收到活动结果，请重试原操作。", true);
      if (!owns(op)) throw new Error("游戏页面已更换。");
      if (op.request) clearPendingActivity(op.request);
    } catch {
      // AS may consume the envelope before rendering fails; recover its receipt through the web.
      op.deliveryFailed = true;
      throw new ActivityRequestError("原窗口未确认活动结果，请在活动中心重试原操作；核对后重新进入游戏恢复原窗口。", true);
    }
    revision = snapshot.revision; operation = null;
    try { options.onSnapshot?.(snapshot); } catch { /* Confirmed delivery is not another request. */ }
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
    && gen === options.generation && Number.isSafeInteger(seq) && seq > sequence && !operation && options.ready();
  const callbacks: NativeActivityCallbacks = {
    read(id, gen, seq) {
      if (!valid(id, gen, seq)) return { accepted: false };
      try {
        if (readPendingActivity(id) || isActivityInFlight(id)) { notice("请先在活动中心重试上一次未确认操作。"); return { accepted: false }; }
        sequence = seq; const op: Operation = { sequence }; operation = op;
        queueMicrotask(() => { if (owns(op)) void execute(op).catch(() => {}); });
        return { accepted: true };
      } catch (error) { notice(message(error)); return { accepted: false }; }
    },
    request(id, gen, seq, action) {
      const parsed = spec.parseAction(action);
      if (!valid(id, gen, seq) || !parsed) return { accepted: false };
      try {
        if (readPendingActivity(id) || isActivityInFlight(id)) { notice("请先在活动中心确认上一次操作。"); return { accepted: false }; }
        const pending: ActivityRequest = { characterId: id, activityId: spec.activityId, action: parsed, requestId: crypto.randomUUID() };
        savePendingActivity(pending);
        sequence = seq; const op: Operation = { sequence, request: pending }; operation = op;
        queueMicrotask(() => { if (owns(op)) void execute(op).catch(() => {}); });
        return { accepted: true, requestId: pending.requestId };
      } catch (error) { notice(message(error)); return { accepted: false }; }
    },
    report(status) {
      if (!live() || !nativeObject(status) || status.characterId !== options.characterId || status.generation !== options.generation
        || status.sequence !== sequence) return;
      try { options.onStatus?.(status); } catch { /* UI observer only. */ }
    },
  };
  const unbind = options.bind(callbacks);
  const host: NativeActivityHost = {
    cancel() {
      if (cancelled) return;
      cancelled = true; controller.abort(); unbind();
      if (hosts.get(spec.activityId) === host) hosts.delete(spec.activityId);
    },
    retry(pending) {
      return live() && operation?.request && !operation.deliveryFailed && sameActivityRequest(operation.request, pending) ? execute(operation) : null;
    },
  };
  hosts.set(spec.activityId, host);
  return host;
}
