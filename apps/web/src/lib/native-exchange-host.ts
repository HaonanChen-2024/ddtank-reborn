import type { ActivityAction, ActivityRequest, ActivityResponse } from "./activities";
import { ActivityRequestError } from "./activities";
import { attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost } from "./native-activity-host";

export type NativeExchangeEnvelope = NativeActivityEnvelope;
export interface NativeExchangePlayer {
  workshopExchangeAcceptSnapshot?: (envelope: NativeExchangeEnvelope) => unknown;
  workshopExchangeRejectRequest?: (envelope: NativeExchangeEnvelope) => unknown;
}
export interface NativeExchangeCallbackTarget {
  workshopExchangeRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopExchangeRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopExchangeReport?: (status: unknown) => void;
}
export interface NativeExchangeHostOptions {
  player: NativeExchangePlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeExchangeCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeExchangeCallbackTarget {
  workshopShowExchange?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (v: unknown, min = 0, max = 2_147_483_647): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2048;
const token = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).length === allowed.length && allowed.every(k => Object.hasOwn(v, k));
function nativeAction(v: unknown): ActivityAction | null {
  return nativeObject(v) && keys(v, ["type", "index", "count", "choice"]) && v.type === "exchange"
    && integer(v.index, 0, 3) && integer(v.count, 1, 10) && token(v.choice)
    ? { type: v.type, index: v.index, count: v.count, choice: v.choice } : null;
}
const fail = (): never => { throw new ActivityRequestError("原版兑换活动公开数据不完整，请重试原操作。", true); };
const record = (v: unknown) => nativeObject(v) ? v : fail();
const array = (v: unknown, max = 10) => Array.isArray(v) && v.length <= max ? v as unknown[] : fail();
const templates = [11019, 11001, 11021, 11002];
// Versioned local catalogue: validate a quote; the game process owns its pricing and settlement.
const recipes = [
  ["local-strengthen-up", 11019, 4, 11021, 1], ["local-zhuque-up", 11001, 4, 11002, 1],
  ["local-strengthen-down", 11021, 2, 11019, 3], ["local-zhuque-down", 11002, 2, 11001, 3],
] as const;
const privateKeys = ["state", "games", "actor", "accountId", "accountName", "sessionId", "itemId", "ItemID", "place", "Place", "tempId", "bagType", "BagType", "itemFingerprint", "signature"];
const publicRecord = (v: unknown) => { const r = record(v); if (privateKeys.some(k => k in r)) fail(); return r; };
function item(v: unknown, templateId: number, count: number, reward = false) {
  const i = publicRecord(v);
  if (i.templateId !== templateId || i.count !== count || !text(i.name) || reward && (i.bound !== true || i.validDays !== 0)) fail();
}
function validatePublic(snapshot: ActivityResponse, action?: ActivityAction) {
  const p = publicRecord(snapshot.nativeExchange), category = record(p.category), materials = array(p.materials, 4), rows = array(p.recipes, 4);
  const day = new Date(String(p.day) + "T00:00:00.000Z");
  if (p.version !== 1 || p.catalogVersion !== "exchange-native-v1-local-4" || p.day !== snapshot.day || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== p.day
    || p.revision !== snapshot.revision || !integer(p.revision) || !["online", "offline", "unavailable"].includes(String(p.authority))
    || typeof p.available !== "boolean" || !text(p.reason) || p.materialSource !== "prop-bag"
    || category.id !== "local-materials" || !text(category.title) || p.available && p.authority !== "online"
    || (p.available ? !token(p.stateToken) || !p.stateToken.startsWith(p.day + ".") : p.stateToken !== null)
    || !array(p.rules).length || array(p.rules).some(v => !text(v))) fail();
  const unavailable = array(p.unavailable, 2).map(publicRecord);
  if (unavailable.length !== 2 || new Set(unavailable.map(v => v.id)).size !== 2
    || unavailable.some(v => !["reference-catalog", "offline-exchange"].includes(String(v.id)) || !text(v.reason))) fail();
  const emptyUnavailable = p.authority === "unavailable" && materials.length === 0 && rows.length === 0;
  if (!emptyUnavailable) {
    if (materials.length !== 4 || rows.length !== 4) fail();
    materials.forEach((v, index) => {
      const m = publicRecord(v);
      if (m.templateId !== templates[index] || !text(m.name) || (p.authority === "online" ? !integer(m.eligibleCount) : m.eligibleCount !== null)) fail();
    });
    rows.forEach((v, index) => {
      const r = publicRecord(v), [id, input, cost, output, amount] = recipes[index]!, ins = array(r.inputs, 8), outs = array(r.outputs, 6);
      const material = publicRecord(materials[templates.indexOf(input)]);
      if (r.index !== index || r.catalogId !== id || !text(r.title) || ins.length !== 1 || outs.length !== 1 || r.dailyLimit !== 10
        || !integer(r.exchanged, 0, 10) || r.remaining !== 10 - r.exchanged || !integer(r.maxCount, 0, 10)
        || r.maxCount !== (p.available ? Math.min(Number(r.remaining), Math.floor(Number(material.eligibleCount) / cost)) : 0)
        || r.canExchange !== (r.maxCount > 0) || !text(r.reason)) fail();
      item(ins[0], input, cost); item(outs[0], output, amount, true);
    });
  }
  if (action && !snapshot.replayed) {
    const envelope = record(snapshot.nativeExchangeAction), effects = array(envelope.effects, 1);
    if (!text(envelope.requestId) || effects.length !== 1) fail();
    const e = publicRecord(effects[0]), recipe = recipes[Number(action.index)];
    if (!recipe || e.type !== "exchanged" || e.index !== action.index || e.count !== action.count || !integer(e.count, 1, 10)
      || !integer(e.committedRevision, 1, snapshot.revision) || array(e.consumed, 8).length !== 1 || array(e.rewards, 6).length !== 1) fail();
    item(array(e.consumed)[0], recipe[1], recipe[2] * Number(e.count));
    item(array(e.rewards)[0], recipe[3], recipe[4] * Number(e.count), true);
  }
}
export const retryNativeExchangeRequest = (request: ActivityRequest) => request.activityId === "exchange-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeExchangeHost(options: NativeExchangeHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopExchangeAcceptSnapshot === "function" && typeof options.player.workshopExchangeRejectRequest === "function",
    accept: envelope => options.player.workshopExchangeAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopExchangeRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopExchangeRead = read; target.workshopExchangeRequest = request; target.workshopExchangeReport = report;
      return () => {
        if (target.workshopExchangeRead === read) delete target.workshopExchangeRead;
        if (target.workshopExchangeRequest === request) delete target.workshopExchangeRequest;
        if (target.workshopExchangeReport === report) delete target.workshopExchangeReport;
      };
    },
  }, { activityId: "exchange-native", title: "原版兑换活动", effectKey: "nativeExchangeAction", parseAction: nativeAction, validatePublic });
}
