/** Thin authenticated game-owner adapter; no material prices or bag writes belong to the API. */
import type { AppCtx } from "../context.js";
import type { Claims } from "../lib/jwt.js";
import { PRIZES } from "./config.js";
import { ActivityError, type ActivityAction } from "./types.js";

export interface ExchangeItem { templateId: number; name: string; count: number }
export interface ExchangeReward extends ExchangeItem { bound: true; validDays: 0 }
export interface ExchangeNativeView {
  version: 1; catalogVersion: string; day: string; revision: number;
  authority: "online" | "offline" | "unavailable"; available: boolean; reason: string;
  materialSource: "prop-bag"; stateToken: string | null;
  category: { id: "local-materials"; title: string };
  materials: { templateId: number; name: string; eligibleCount: number | null }[];
  recipes: { index: number; catalogId: string; title: string; inputs: ExchangeItem[]; outputs: ExchangeReward[];
    dailyLimit: 10; exchanged: number; remaining: number; maxCount: number; canExchange: boolean; reason: string }[];
  rules: string[]; unavailable: { id: string; reason: string }[];
}
export interface ExchangeEffect { type: "exchanged"; index: number; count: number; consumed: ExchangeItem[]; rewards: ExchangeReward[]; committedRevision: number }
export interface ExchangeEnvelope { requestId: string; effects: ExchangeEffect[] }
interface ExchangeResult { view: ExchangeNativeView; requestId: string; replayed: boolean; message: string; mailedCount: number; nativeExchangeAction?: ExchangeEnvelope }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = 2147483647): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 1000;
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const token = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v) && day(v.slice(0, 10));
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && Object.keys(v).every(k => fields.includes(k));
const item = (v: unknown): v is ExchangeItem => object(v) && integer(v.templateId, 1) && PRIZES.some(p => p.templateId === v.templateId) && text(v.name) && integer(v.count, 1);
const reward = (v: unknown): v is ExchangeReward => item(v) && (v as ExchangeReward).bound === true && (v as ExchangeReward).validDays === 0;

export function unavailableExchange(revision: number, day: string): ExchangeNativeView {
  return { version: 1, catalogVersion: "exchange-native-v1-local-4", day, revision, authority: "unavailable", available: false,
    reason: "材料兑换服务暂不可用；其它活动可继续使用。", materialSource: "prop-bag", stateToken: null,
    category: { id: "local-materials", title: "本地材料兑换" }, materials: [], recipes: [], rules: ["材料兑换服务暂不可用，请稍后刷新。"],
    unavailable: [{ id: "reference-catalog", reason: "原服完整配方尚未审核移植。" }, { id: "offline-exchange", reason: "没有权威在线背包快照，暂不允许新兑换。" }] };
}
/** Whitelist the public schema, rejecting accidental private bag rows before forwarding. */
export function validExchangeView(v: unknown): v is ExchangeNativeView {
  if (!object(v) || !exact(v, ["version", "catalogVersion", "day", "revision", "authority", "available", "reason", "materialSource", "stateToken", "category", "materials", "recipes", "rules", "unavailable"]) ||
    v.version !== 1 || v.catalogVersion !== "exchange-native-v1-local-4" || !day(v.day) ||
    !integer(v.revision) || !["online", "offline", "unavailable"].includes(String(v.authority)) || typeof v.available !== "boolean" || !text(v.reason) || v.materialSource !== "prop-bag" ||
    !object(v.category) || !exact(v.category, ["id", "title"]) || v.category.id !== "local-materials" || !text(v.category.title) || !Array.isArray(v.materials) || !Array.isArray(v.recipes) ||
    !Array.isArray(v.rules) || v.rules.length < 1 || v.rules.length > 10 || !v.rules.every(text) || !Array.isArray(v.unavailable) || v.unavailable.length !== 2 ||
    !v.unavailable.every((u, i) => object(u) && exact(u, ["id", "reason"]) && u.id === ["reference-catalog", "offline-exchange"][i] && text(u.reason))) return false;
  if (v.available ? v.authority !== "online" || !token(v.stateToken) || !(v.stateToken as string).startsWith(`${v.day}.`) : v.stateToken !== null) return false;
  if (v.authority === "unavailable") return !v.available && v.materials.length === 0 && v.recipes.length === 0;
  if (v.materials.length !== 4 || v.recipes.length !== 4 || !v.materials.every(m => object(m) && exact(m, ["templateId", "name", "eligibleCount"]) &&
    integer(m.templateId, 1) && PRIZES.some(p => p.templateId === m.templateId) && text(m.name) && (v.authority === "offline" ? m.eligibleCount === null : integer(m.eligibleCount)))) return false;
  if (new Set(v.materials.map(m => (m as Record<string, unknown>).templateId)).size !== 4) return false;
  return v.recipes.every((r, i) => object(r) && exact(r, ["index", "catalogId", "title", "inputs", "outputs", "dailyLimit", "exchanged", "remaining", "maxCount", "canExchange", "reason"]) &&
    r.index === i && text(r.catalogId) && text(r.title) && text(r.reason) && Array.isArray(r.inputs) && r.inputs.length === 1 && r.inputs.every(x => item(x) && object(x) && exact(x, ["templateId", "name", "count"])) &&
    Array.isArray(r.outputs) && r.outputs.length === 1 && r.outputs.every(x => reward(x) && object(x) && exact(x, ["templateId", "name", "count", "bound", "validDays"])) &&
    r.dailyLimit === 10 && integer(r.exchanged, 0, 10) && integer(r.remaining, 0, 10) && r.exchanged + r.remaining === 10 && integer(r.maxCount, 0, r.remaining) &&
    r.canExchange === (r.maxCount > 0) && (v.available || r.maxCount === 0));
}
export function validateExchangeAction(action: ActivityAction) {
  if (!exact(action as unknown as Record<string, unknown>, ["type", "index", "count", "choice"]) || action.type !== "exchange" ||
    !integer(action.index, 0, 3) || !integer(action.count, 1, 10) || !token(action.choice)) throw new ActivityError("兑换配方、数量或状态凭证无效。");
}
function uncertain(): never { throw new ActivityError("兑换结果暂不确定，请保留同一请求编号重试。", 503); }
async function internal(app: AppCtx, path: string, body: unknown): Promise<Record<string, unknown>> {
  if (!app.cfg.GAME_INTERNAL_URL) return uncertain();
  try {
    const res = await fetch(`${app.cfg.GAME_INTERNAL_URL.replace(/\/+$/, "")}/activity-exchange/${path}`, { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", ...(app.cfg.GAME_INTERNAL_TOKEN ? { authorization: `Bearer ${app.cfg.GAME_INTERNAL_TOKEN}` } : {}) }, body: JSON.stringify(body) });
    if (!res.ok) return uncertain();
    const value: unknown = await res.json();
    if (!object(value) || typeof value.ok !== "boolean") return uncertain();
    if (value.ok === false) {
      if (!exact(value, ["ok", "status", "message"]) || ![400, 401, 403, 409, 503].includes(Number(value.status)) || !text(value.message)) return uncertain();
      throw new ActivityError(value.message, Number(value.status));
    }
    if (!exact(value, ["ok", "value"]) || !object(value.value)) return uncertain();
    return value.value;
  } catch (err) { if (err instanceof ActivityError) throw err; return uncertain(); }
}
const actor = (claims: Claims) => ({ accountId: claims.sub, accountName: claims.name });
export async function readExchangeProjection(app: AppCtx, claims: Claims, characterId: number, revision: number, day: string): Promise<ExchangeNativeView> {
  try {
    const v = await internal(app, "read", { actor: actor(claims), characterId });
    return validExchangeView(v) && v.revision === revision && v.day === day ? v : unavailableExchange(revision, day);
  } catch { return unavailableExchange(revision, day); }
}
export async function commandExchange(app: AppCtx, claims: Claims, characterId: number, requestId: string, action: ActivityAction): Promise<ExchangeResult> {
  validateExchangeAction(action);
  const v = await internal(app, "action", { actor: actor(claims), characterId, requestId, action });
  if (!exact(v, ["view", "requestId", "replayed", "message", "mailedCount", ...(v.replayed === false ? ["nativeExchangeAction"] : [])]) ||
    !validExchangeView(v.view) || v.requestId !== requestId || typeof v.replayed !== "boolean" || !text(v.message) || !integer(v.mailedCount, 1, 1000)) return uncertain();
  if (!v.replayed) {
    const envelope = v.nativeExchangeAction;
    if (!object(envelope) || !exact(envelope, ["requestId", "effects"]) || envelope.requestId !== requestId || !Array.isArray(envelope.effects) || envelope.effects.length !== 1) return uncertain();
    const e: unknown = envelope.effects[0];
    if (!object(e) || !exact(e, ["type", "index", "count", "consumed", "rewards", "committedRevision"]) || e.type !== "exchanged" ||
      e.index !== action.index || e.count !== action.count || !integer(e.committedRevision, 1, v.view.revision) ||
      !Array.isArray(e.consumed) || e.consumed.length !== 1 || !e.consumed.every(x => item(x) && object(x) && exact(x, ["templateId", "name", "count"])) ||
      !Array.isArray(e.rewards) || e.rewards.length !== 1 || !e.rewards.every(x => reward(x) && object(x) && exact(x, ["templateId", "name", "count", "bound", "validDays"]))) return uncertain();
    const recipe = v.view.recipes[action.index!]!;
    if (!recipe || e.consumed[0].templateId !== recipe.inputs[0]!.templateId || e.consumed[0].count !== recipe.inputs[0]!.count * action.count! ||
      e.rewards[0].templateId !== recipe.outputs[0]!.templateId || e.rewards[0].count !== recipe.outputs[0]!.count * action.count!) return uncertain();
  }
  return v as unknown as ExchangeResult;
}
