import { api } from "./api";

// Public JSON contract mirrored from apps/api/src/activities/types.ts.
// Private game state, board layouts and RNG seeds never belong in this module.
export interface ActivityAction { type: string; index?: number; choice?: string; tier?: number; count?: number; marked?: boolean; mode?: "normal" | "advanced"; items?: { index: number; count: number }[] }
export interface ActivityButton { label: string; action: ActivityAction; disabled?: boolean; help?: string }
export interface ActivityCell { label: string; detail?: string; tone?: "hidden" | "success" | "danger" | "gold"; action?: ActivityAction; image?: string }
export interface ActivityView {
  id: string; title: string; subtitle: string; rules: string[];
  stats: { label: string; value: string | number }[];
  actions: ActivityButton[]; cells?: ActivityCell[]; columns?: number;
}
export interface ActivityTask { id: string; title: string; current: number; target: number; points: number; claimed: boolean }
export interface ActivitySnapshot {
  points: number; earned: number; revision: number; day: string;
  activities: ActivityView[]; tasks: ActivityTask[]; history: string[];
}
export interface ActivityResponse extends ActivitySnapshot {
  characterId: number; message?: string; mailedCount?: number; mailIds?: number[]; replayed?: boolean;
  nativePair?: unknown;
  nativePairAction?: { requestId: string; effects: unknown[] };
  nativeMines?: unknown;
  nativeMinesAction?: { requestId: string; effects: unknown[] };
  nativeDDPlay?: unknown;
  nativeDDPlayAction?: { requestId: string; effects: unknown[] };
  nativeMoonlight?: unknown;
  nativeMoonlightAction?: { requestId: string; effects: unknown[] };
  nativeWheel?: unknown;
  nativeWheelAction?: { requestId: string; effects: unknown[] };
  nativeTreasure?: unknown;
  nativeTreasureAction?: { requestId: string; effects: unknown[] };
  nativeGypsy?: unknown;
  nativeGypsyAction?: { requestId: string; effects: unknown[] };
}
export interface ActivityRequest {
  characterId: number; activityId: string; requestId: string; action: ActivityAction;
}

export class ActivityRequestError extends Error {
  constructor(message: string, public readonly uncertain: boolean) { super(message); }
}

async function request(path: string, body?: ActivityRequest, signal?: AbortSignal): Promise<ActivityResponse> {
  const headers = new Headers({ Accept: "application/json" });
  const token = api.getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, {
      method: body ? "POST" : "GET", headers,
      body: body ? JSON.stringify({ characterId: body.characterId, requestId: body.requestId, action: body.action }) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    });
  } catch {
    throw new ActivityRequestError(body ? "连接中断或请求超时，结果尚未确认。请重试这一次操作。" : "暂时无法读取活动，请稍后刷新。", Boolean(body));
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ActivityRequestError("服务器返回的活动数据不完整，请重试。", Boolean(body)); }
  if (!response.ok) {
    const message = data && typeof data === "object" && "message" in data ? String(data.message) : "活动请求未成功，请刷新后再试。";
    // These responses do not establish whether an earlier attempt with this UUID committed.
    // In particular, auth can fail before the server looks up the previous receipt.
    const uncertain = Boolean(body) && ([401, 403, 408, 429].includes(response.status) || response.status >= 500);
    const followup = !uncertain ? "" : response.status === 401 || response.status === 403
      ? " 本次结果尚未确认，请求编号已保留；重新登录正确账号后，请重试同一次操作。"
      : " 本次结果尚未确认，请求编号已保留；请稍后重试同一次操作。";
    throw new ActivityRequestError(message + followup, uncertain);
  }
  const result = data as ActivityResponse;
  if (!result || !Array.isArray(result.activities) || !Array.isArray(result.tasks) || !Array.isArray(result.history)
    || !Number.isSafeInteger(result.characterId) || !Number.isSafeInteger(result.revision) || result.revision < 0) {
    throw new ActivityRequestError("服务器返回的活动数据不完整，请重试。", Boolean(body));
  }
  if (body && result.characterId !== body.characterId) throw new ActivityRequestError("返回角色不匹配，请重试这一次操作。", true);
  return result;
}

export async function getActivities(characterId: number, signal?: AbortSignal) {
  const result = await request(`/api/account/activities?characterId=${characterId}`, undefined, signal);
  if (result.characterId !== characterId) throw new ActivityRequestError("返回角色不匹配，请刷新进度。", false);
  return result;
}
const flights = new Map<number, { pending: ActivityRequest; promise: Promise<ActivityResponse> }>();
const listeners = new Set<(characterId: number) => void>();
function changed(characterId: number) {
  for (const listener of listeners) { try { listener(characterId); } catch { /* Observers do not own a request. */ } }
}
export function subscribeActivityChanges(listener: (characterId: number) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const isActivityInFlight = (characterId: number) => flights.has(characterId);
export function sameActivityRequest(a: ActivityRequest, b: ActivityRequest) {
  const action = (value: ActivityAction) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return a.characterId === b.characterId && a.activityId === b.activityId && a.requestId === b.requestId
    && action(a.action) === action(b.action);
}
/** Web and native windows share one unresolved request and one HTTP flight per character. */
export function performActivity(pending: ActivityRequest, signal?: AbortSignal): Promise<ActivityResponse> {
  const existing = flights.get(pending.characterId);
  if (existing) return sameActivityRequest(existing.pending, pending) ? existing.promise
    : Promise.reject(new ActivityRequestError("这个角色还有活动请求正在处理，请先确认上一次操作。", true));
  try { savePendingActivity(pending); } catch (error) { return Promise.reject(error); }
  const promise = request(`/api/account/activities/${encodeURIComponent(pending.activityId)}/action`, pending, signal)
    .finally(() => { if (flights.get(pending.characterId)?.promise === promise) flights.delete(pending.characterId); changed(pending.characterId); });
  flights.set(pending.characterId, { pending, promise }); changed(pending.characterId);
  return promise;
}

const storageKey = (characterId: number) => `ddtank.activity.pending.${characterId}`;

/** Keep an unresolved action across closing the panel/reloading, without automatic submission. */
export function readPendingActivity(characterId: number): ActivityRequest | null {
  const raw = sessionStorage.getItem(storageKey(characterId));
  if (!raw) return null;
  const value = JSON.parse(raw) as ActivityRequest;
  if (value.characterId !== characterId || typeof value.requestId !== "string" || typeof value.activityId !== "string"
    || !value.action || typeof value.action.type !== "string") throw new Error("活动重试记录无法读取，请重新打开页面后重试。");
  return value;
}
export function savePendingActivity(pending: ActivityRequest) {
  const current = readPendingActivity(pending.characterId);
  if (current && !sameActivityRequest(current, pending)) throw new Error("这个角色还有未确认的活动操作，请先重试原请求。");
  try { sessionStorage.setItem(storageKey(pending.characterId), JSON.stringify(pending)); }
  catch { throw new Error("无法保存本次操作的重试记录，尚未提交。请检查浏览器存储后重试。"); }
  changed(pending.characterId);
}
export function clearPendingActivity(pending: ActivityRequest) {
  const current = readPendingActivity(pending.characterId);
  if (current && sameActivityRequest(current, pending)) { sessionStorage.removeItem(storageKey(pending.characterId)); changed(pending.characterId); }
}
