import type { ActivityAction, ActivityRequest, ActivityResponse } from "./activities";
import { ActivityRequestError } from "./activities";
import { attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost } from "./native-activity-host";

export type NativeChargeEnvelope = NativeActivityEnvelope;
export interface NativeChargePlayer {
  workshopChargeAcceptSnapshot?: (envelope: NativeChargeEnvelope) => unknown;
  workshopChargeRejectRequest?: (envelope: NativeChargeEnvelope) => unknown;
}
export interface NativeChargeCallbackTarget {
  workshopChargeRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopChargeRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopChargeReport?: (status: unknown) => void;
}
export interface NativeChargeHostOptions {
  player: NativeChargePlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeChargeCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeChargeCallbackTarget {
  workshopShowCharge?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (v: unknown, min = 0, max = 2_147_483_647): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, max = 2048): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const token = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).length === allowed.length && allowed.every(key => Object.hasOwn(v, key));
function nativeAction(v: unknown): ActivityAction | null {
  if (!nativeObject(v) || !token(v.choice)) return null;
  if (v.type === "claim" && keys(v, ["type", "index", "tier", "choice"]) && integer(v.index, 0, 2) && integer(v.tier, 1, 3))
    return { type: "claim", index: v.index, tier: v.tier, choice: v.choice };
  if (v.type === "exchange" && keys(v, ["type", "index", "count", "choice"]) && integer(v.index, 0, 6) && v.count === 1)
    return { type: "exchange", index: v.index, count: 1, choice: v.choice };
  return null;
}
const targets = [[40, 100, 200], [100, 300, 600], [100, 300, 600]];
const metrics = ["today-claimed-task-points", "lifetime-task-earned", "gross-spent-since-tracking"];
const templates = [11019, 11001, 11021, 11002, 11019, 11021, 11002], counts = [3, 3, 1, 1, 6, 2, 2];
const prices = [15, 20, 25, 30, 35, 40, 50], qualifications = [0, 0, 100, 100, 300, 300, 600], limits = [1, 2, 3, 3, 3, 3, 3];
function validatePublic(snapshot: ActivityResponse) {
  const p = snapshot.nativeCharge;
  const fail = (): never => { throw new ActivityRequestError("原版充值大赠送公开数据不完整，请重试原操作。", true); };
  const reward = (v: unknown) => nativeObject(v) && integer(v.templateId) && [11019, 11001, 11021, 11002].includes(v.templateId)
    && integer(v.count, 1, 10) && v.validDays === 0 && v.bound === true;
  const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  if (!nativeObject(p) || p.version !== 1 || p.rulesVersion !== 1 || p.kind !== "charge-native" || p.day !== snapshot.day
    || !date(p.day + "T00:00:00.000Z") || !token(p.stateToken) || !p.stateToken.startsWith(p.day + ".")
    || p.currency !== "local-task-points" || !integer(p.points) || p.points !== snapshot.points
    || !integer(p.taskEarned) || p.taskEarned !== snapshot.earned || !integer(p.todayClaimedTaskPoints, 0, 200)
    || !integer(p.grossSpent) || typeof p.grossCapped !== "boolean" || (p.grossCapped && p.grossSpent !== 2_147_483_647)
    || (p.trackingStartedAt !== null && !date(p.trackingStartedAt)) || (p.trackingStartedAt === null && p.grossSpent !== 0)
    || !Array.isArray(p.pages) || p.pages.length !== 3 || !nativeObject(p.exchange)
    || p.exchange.catalogVersion !== "charge-material-v1" || !text(p.exchange.description)
    || !Array.isArray(p.exchange.rows) || p.exchange.rows.length !== 7
    || !nativeObject(p.rules) || p.rules.source !== "explicit-local-rules" || p.rules.grossLimit !== 2_147_483_647
    || !Array.isArray(p.rules.description) || !p.rules.description.length || p.rules.description.some(v => !text(v))
    || !Array.isArray(p.unavailable) || p.unavailable.length !== 3
    || ["state", "games", "claims", "daily"].some(k => k in p)) return fail();
  const progress = [p.todayClaimedTaskPoints, p.taskEarned, p.grossSpent];
  for (const [index, page] of p.pages.entries()) {
    if (!nativeObject(page) || page.index !== index || page.originalRate !== [1, 2, 4][index]
      || page.metric !== metrics[index] || page.period !== (index === 0 ? "utc-day" : "permanent")
      || !text(page.title) || !text(page.description) || page.current !== progress[index]
      || !Array.isArray(page.tiers) || page.tiers.length !== 3) return fail();
    for (const [i, tier] of page.tiers.entries()) {
      if (!nativeObject(tier) || tier.tier !== i + 1 || !text(tier.title) || !text(tier.reason)
        || !text(tier.claimKey, 256) || (index === 1 && tier.claimKey !== "points-gift:" + (i + 1))
        || tier.current !== page.current || tier.target !== targets[index]![i]
        || typeof tier.claimed !== "boolean" || typeof tier.canClaim !== "boolean"
        || (tier.canClaim && (tier.claimed || Number(tier.current) < Number(tier.target)))
        || !Array.isArray(tier.rewards) || tier.rewards.length !== 4
        || !tier.rewards.some(v => v !== null) || tier.rewards.some(v => v !== null && !reward(v))) return fail();
    }
  }
  for (const [index, row] of p.exchange.rows.entries()) {
    if (!nativeObject(row) || row.index !== index || row.catalogId !== "charge-exchange:" + (index + 1)
      || row.count !== 1 || !text(row.name) || !reward(row.reward) || !nativeObject(row.reward)
      || row.reward.templateId !== templates[index] || row.reward.count !== counts[index] || row.unitPoints !== prices[index]
      || !nativeObject(row.qualification) || row.qualification.metric !== "lifetime-task-earned"
      || row.qualification.current !== p.taskEarned || row.qualification.target !== qualifications[index]
      || row.qualification.met !== (p.taskEarned >= qualifications[index]!)
      || row.period !== "utc-day" || row.limit !== limits[index] || !integer(row.bought, 0, limits[index])
      || row.remaining !== limits[index]! - row.bought || typeof row.canExchange !== "boolean"
      || (row.canExchange && (row.remaining === 0 || p.points < prices[index]! || !row.qualification.met))
      || row.confirmRequired !== true || !text(row.reason)) return fail();
  }
  const features = new Set<string>();
  for (const unavailable of p.unavailable) {
    if (!nativeObject(unavailable) || !["original-payment", "original-rate4-rewards", "original-item-exchange"].includes(String(unavailable.feature))
      || features.has(String(unavailable.feature)) || !text(unavailable.reason)) return fail();
    features.add(String(unavailable.feature));
  }
}
export const retryNativeChargeRequest = (request: ActivityRequest) =>
  request.activityId === "charge-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeChargeHost(options: NativeChargeHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopChargeAcceptSnapshot === "function" && typeof options.player.workshopChargeRejectRequest === "function",
    accept: envelope => options.player.workshopChargeAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopChargeRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopChargeRead = read; target.workshopChargeRequest = request; target.workshopChargeReport = report;
      return () => {
        if (target.workshopChargeRead === read) delete target.workshopChargeRead;
        if (target.workshopChargeRequest === request) delete target.workshopChargeRequest;
        if (target.workshopChargeReport === report) delete target.workshopChargeReport;
      };
    },
  }, { activityId: "charge-native", title: "原版充值大赠送", effectKey: "nativeChargeAction", parseAction: nativeAction, validatePublic });
}
