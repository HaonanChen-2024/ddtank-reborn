import type { ActivityAction, ActivityRequest, ActivityResponse } from "./activities";
import { ActivityRequestError } from "./activities";
import {
  attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost,
} from "./native-activity-host";

export type NativeFirstRechargeEnvelope = NativeActivityEnvelope;
export interface NativeFirstRechargePlayer {
  workshopFirstRechargeAcceptSnapshot?: (envelope: NativeFirstRechargeEnvelope) => unknown;
  workshopFirstRechargeRejectRequest?: (envelope: NativeFirstRechargeEnvelope) => unknown;
}
export interface NativeFirstRechargeCallbackTarget {
  workshopFirstRechargeRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopFirstRechargeRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopFirstRechargeReport?: (status: unknown) => void;
}
export interface NativeFirstRechargeHostOptions {
  player: NativeFirstRechargePlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeFirstRechargeCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeFirstRechargeCallbackTarget {
  workshopShowFirstRecharge?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (v: unknown, min = 0, max = 2_147_483_647): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const token = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v);
const cardId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).length === allowed.length && allowed.every(key => Object.hasOwn(v, key));
function nativeAction(v: unknown): ActivityAction | null {
  if (!nativeObject(v) || !Object.hasOwn(v, "type") || !Object.hasOwn(v, "choice") || !token(v.choice)) return null;
  if ((v.type === "claim" || v.type === "issue-card") && keys(v, ["type", "tier", "choice"]) && integer(v.tier, 1, 3))
    return { type: v.type, tier: v.tier, choice: v.choice };
  if (v.type === "buy" && keys(v, ["type", "index", "count", "choice"]) && integer(v.index, 0, 3) && v.count === 1)
    return { type: "buy", index: v.index, count: 1, choice: v.choice };
  if ((v.type === "validate-card" || v.type === "use-card") && keys(v, ["type", "cardId", "choice"]) && cardId(v.cardId))
    return { type: v.type, cardId: v.cardId, choice: v.choice };
  if (v.type === "gift-card" && keys(v, ["type", "cardId", "recipientName", "choice"]) && cardId(v.cardId)
    && text(v.recipientName, 64) && v.recipientName.trim() === v.recipientName && !/[\u0000-\u001f\u007f]/.test(v.recipientName))
    return { type: "gift-card", cardId: v.cardId, recipientName: v.recipientName, choice: v.choice };
  return null;
}
const materials = [11019, 11001, 11021, 11002];
const shopCounts = [3, 3, 1, 1], prices = [15, 20, 25, 30];
function validatePublic(snapshot: ActivityResponse) {
  const p = snapshot.nativeFirstRecharge;
  const fail = (): never => { throw new ActivityRequestError("原版首充大礼公开数据不完整，请重试原操作。", true); };
  const reward = (r: unknown): boolean => nativeObject(r) && materials.includes(Number(r.templateId))
    && integer(r.templateId, 1) && integer(r.count, 1, 10) && r.validDays === 0 && r.bound === true;
  const validDate = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  if (!nativeObject(p) || p.version !== 1 || p.rulesVersion !== 1 || p.kind !== "first-recharge-native"
    || p.day !== snapshot.day || !token(p.stateToken) || !p.stateToken.startsWith(p.day + ".")
    || !validDate(p.day + "T00:00:00.000Z") || p.currency !== "local-task-points"
    || !integer(p.points) || p.points !== snapshot.points || !integer(p.taskEarned) || p.taskEarned !== snapshot.earned
    || !Array.isArray(p.tiers) || p.tiers.length !== 3 || !nativeObject(p.shop)
    || p.shop.availability !== "local-defined" || p.shop.catalogVersion !== "first-shop-v1" || !text(p.shop.reason, 1024)
    || !Array.isArray(p.shop.rows) || p.shop.rows.length !== 4 || !nativeObject(p.cards)
    || p.cards.availability !== "local-defined" || p.cards.policyVersion !== 1 || !Array.isArray(p.cards.definitions)
    || p.cards.definitions.length !== 3 || !Array.isArray(p.cards.cards) || p.cards.cards.length > 3
    || !nativeObject(p.capabilities) || !["reward", "materialShop", "validateCard", "useCard", "giftCard"].every(k => p.capabilities && nativeObject(p.capabilities) && p.capabilities[k] === true)
    || !nativeObject(p.rules) || p.rules.source !== "explicit-local-rules" || !Array.isArray(p.rules.description)
    || !p.rules.description.length || p.rules.description.some(s => !text(s, 2048)) || !Array.isArray(p.unavailable)
    || ["state", "games", "origin", "cardSlots"].some(k => k in p)) return fail();
  for (const [i, t] of p.tiers.entries()) {
    if (!nativeObject(t) || t.tier !== i + 1 || !text(t.title) || !text(t.reason, 1024)
      || t.claimKey !== (i === 0 ? "first-gift" : "first-recharge-native:tier:" + (i + 1))
      || typeof t.claimed !== "boolean" || typeof t.canClaim !== "boolean"
      || !["locked", "ready", "reserved", "active", "claimed", "gifted"].includes(String(t.entitlementStatus))
      || (t.claimed && t.canClaim) || (t.activeCardId !== null && !cardId(t.activeCardId))
      || !nativeObject(t.qualification) || !["completed-board", "task-earned", "received-card"].includes(String(t.qualification.metric))
      || !integer(t.qualification.current) || !integer(t.qualification.target, 1) || typeof t.qualification.met !== "boolean"
      || !Array.isArray(t.rewards) || t.rewards.length !== 6 || t.rewards.some(r => r !== null && !reward(r))) return fail();
  }
  for (const [i, r] of p.shop.rows.entries()) {
    if (!nativeObject(r) || r.index !== i || r.catalogId !== "first-shop:" + materials[i] + ":" + shopCounts[i]
      || r.kind !== "material" || !text(r.name) || !reward(r.reward) || !nativeObject(r.reward)
      || r.reward.templateId !== materials[i] || r.reward.count !== shopCounts[i] || r.unitPoints !== prices[i]
      || r.quantityEditable !== false || r.maxPerRequest !== 1 || r.period !== "utc-day" || r.limit !== 10
      || !integer(r.bought, 0, 10) || r.remaining !== 10 - r.bought
      || !integer(r.canBuy, 0, 1) || (r.canBuy === 1 && (r.remaining === 0 || p.points < prices[i]!))) return fail();
  }
  for (const [i, d] of p.cards.definitions.entries()) {
    if (!nativeObject(d) || d.kind !== i + 1 || d.associatedTier !== i + 1 || !text(d.label)
      || d.source !== "earned-task-entitlement" || d.validity !== "permanent" || d.unitPoints !== 0
      || d.maxPerCharacter !== 1 || d.transferable !== true || d.entitlement !== "canonical-tier-claim") return fail();
  }
  const ids = new Set<string>(), tiers = new Set<number>();
  for (const c of p.cards.cards) {
    if (!nativeObject(c) || !cardId(c.cardId) || ids.has(c.cardId) || !integer(c.kind, 1, 3)
      || tiers.has(c.kind) || c.associatedTier !== c.kind || !["owned", "active", "used", "gifted"].includes(String(c.status))
      || !validDate(c.acquiredAt) || c.expiresAt !== null || (c.senderName !== null && !text(c.senderName, 64))
      || !["canValidate", "canUse", "canGift"].every(k => typeof c[k] === "boolean") || !text(c.reason, 1024)
      || (c.status !== "owned" && (c.canUse || c.canGift)) || (c.senderName !== null && c.canGift)
      || ["origin", "giftedToCharacterId"].some(k => k in c)) return fail();
    ids.add(c.cardId); tiers.add(c.kind);
  }
}
export const retryNativeFirstRechargeRequest = (request: ActivityRequest) =>
  request.activityId === "first-recharge-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeFirstRechargeHost(options: NativeFirstRechargeHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopFirstRechargeAcceptSnapshot === "function" && typeof options.player.workshopFirstRechargeRejectRequest === "function",
    accept: envelope => options.player.workshopFirstRechargeAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopFirstRechargeRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopFirstRechargeRead = read; target.workshopFirstRechargeRequest = request; target.workshopFirstRechargeReport = report;
      return () => {
        if (target.workshopFirstRechargeRead === read) delete target.workshopFirstRechargeRead;
        if (target.workshopFirstRechargeRequest === request) delete target.workshopFirstRechargeRequest;
        if (target.workshopFirstRechargeReport === report) delete target.workshopFirstRechargeReport;
      };
    },
  }, { activityId: "first-recharge-native", title: "原版首充大礼", effectKey: "nativeFirstRechargeAction", parseAction: nativeAction, validatePublic });
}
