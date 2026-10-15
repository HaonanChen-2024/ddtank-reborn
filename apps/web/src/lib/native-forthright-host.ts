import type { ActivityAction, ActivityRequest, ActivityResponse } from "./activities";
import { ActivityRequestError } from "./activities";
import { attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost } from "./native-activity-host";

export type NativeForthrightEnvelope = NativeActivityEnvelope;
export interface NativeForthrightPlayer {
  workshopForthrightAcceptSnapshot?: (envelope: NativeForthrightEnvelope) => unknown;
  workshopForthrightRejectRequest?: (envelope: NativeForthrightEnvelope) => unknown;
}
export interface NativeForthrightCallbackTarget {
  workshopForthrightRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopForthrightRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopForthrightReport?: (status: unknown) => void;
}
export interface NativeForthrightHostOptions {
  player: NativeForthrightPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeForthrightCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeForthrightCallbackTarget {
  workshopShowForthright?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (v: unknown, min = 0, max = 2_147_483_647): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, max = 2048): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const token = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v);
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).length === allowed.length && allowed.every(key => Object.hasOwn(v, key));
function code(v: unknown, prefix: "g" | "o"): v is string {
  if (typeof v !== "string" || !new RegExp("^" + prefix + "[0-9a-z]{1,6}-[0-9a-z]{1,6}$").test(v)) return false;
  return v.slice(1).split("-").every(part => { const n = Number.parseInt(part, 36); return integer(n, 1) && n.toString(36) === part; });
}
function entityToken(v: unknown, prefix: "g" | "o"): v is string {
  if (typeof v !== "string") return false;
  const parts = v.split("."); return parts.length === 2 && code(parts[0], prefix) && /^[A-Za-z0-9_-]{43}$/.test(parts[1]!);
}
function nativeAction(v: unknown): ActivityAction | null {
  if (!nativeObject(v)) return null;
  if (v.type === "inspect-group" && keys(v, ["type", "choice"]) && code(v.choice, "g")) return { type: v.type, choice: v.choice };
  if (["join-group", "leave-group", "cancel-group", "settle-group"].includes(String(v.type)) && entityToken(v.choice, "g")) {
    if (v.type === "join-group" && keys(v, ["type", "count", "choice"]) && v.count === 1) return { type: v.type, count: 1, choice: v.choice };
    if (v.type !== "join-group" && keys(v, ["type", "choice"])) return { type: String(v.type), choice: v.choice };
  }
  if (["pay-balance", "settle-order"].includes(String(v.type)) && keys(v, ["type", "choice"]) && entityToken(v.choice, "o"))
    return { type: String(v.type), choice: v.choice };
  if (!token(v.choice)) return null;
  if (v.type === "claim" && keys(v, ["type", "tier", "choice"]) && integer(v.tier, 1, 3)) return { type: v.type, tier: v.tier, choice: v.choice };
  if (v.type === "draw" && keys(v, ["type", "count", "choice"]) && v.count === 1) return { type: v.type, count: 1, choice: v.choice };
  if (["deposit", "buy-full-price"].includes(String(v.type)) && keys(v, ["type", "index", "count", "choice"]) && integer(v.index, 0, 7) && v.count === 1)
    return { type: String(v.type), index: v.index, count: 1, choice: v.choice };
  if (v.type === "buy-alone" && keys(v, ["type", "index", "tier", "count", "choice"]) && integer(v.index, 0, 7) && integer(v.tier, 0, 2) && v.count === 1)
    return { type: v.type, index: v.index, tier: v.tier, count: 1, choice: v.choice };
  if (v.type === "open-group" && keys(v, ["type", "index", "tier", "marked", "count", "choice"]) && integer(v.index, 0, 7) && integer(v.tier, 0, 2)
    && typeof v.marked === "boolean" && v.count === 1) return { type: v.type, index: v.index, tier: v.tier, marked: v.marked, count: 1, choice: v.choice };
  return null;
}
const fail = (): never => { throw new ActivityRequestError("原版至尊豪礼公开数据不完整，请重试原操作。", true); };
const record = (v: unknown) => nativeObject(v) ? v : fail();
const array = (v: unknown, max = 1000) => Array.isArray(v) && v.length <= max ? v as unknown[] : fail();
function material(v: unknown, templateId?: number, count?: number): boolean {
  return nativeObject(v) && v.kind === "item" && [11019, 11001, 11021, 11002].includes(Number(v.templateId))
    && integer(v.templateId) && integer(v.count, 1, 60) && v.validDays === 0 && v.bound === true
    && (templateId === undefined || v.templateId === templateId) && (count === undefined || v.count === count);
}
function coupon(v: unknown, name: "six-fold" | "five-fold"): boolean {
  return nativeObject(v) && v.kind === "coupon" && v.coupon === name && v.count === 1 && text(v.name) && !Object.hasOwn(v, "templateId");
}
const groupTemplates = [11019, 11001, 11021, 11002, 11019, 11001, 11021, 11002];
const groupCounts = [5, 5, 2, 2, 8, 8, 4, 4], groupPrices = [40, 50, 60, 70, 80, 90, 100, 120];
const shopCounts = [3, 3, 1, 1, 6, 6, 2, 2], shopPrices = [20, 25, 30, 35, 40, 45, 50, 60];
const wheelItems = [
  [[11019, 1], [11001, 1], [11019, 2], [11001, 2], [11021, 1], [11002, 1], [11019, 3], [11001, 3]],
  [[11019, 2], [11001, 2], [11019, 3], [11001, 3], [11021, 1], [11002, 1], [11019, 4], [11001, 4]],
  [[11019, 3], [11001, 3], [11019, 4], [11001, 4], [11021, 2], [11002, 2], [11019, 5], [11001, 5]],
];
function group(v: unknown, now: number) {
  const g = record(v), members = array(g.members), active = members.map(record).filter(m => m.status === "active"), self = members.map(record).filter(m => m.self);
  if (!code(g.code, "g") || !entityToken(g.actionToken, "g") || !(g.actionToken as string).startsWith(g.code + ".") || !text(g.catalogId) || !text(g.name)
    || !date(g.createdAt) || !date(g.expiresAt) || Date.parse(g.expiresAt) <= Date.parse(g.createdAt) || g.requiredMembers !== 3
    || !members.length || active.length > 3 || self.length > 1 || members.map(record).filter(m => m.creator).length !== 1
    || !["pending", "completed", "cancelled", "expired-unsettled", "refunded"].includes(String(g.status)) || typeof g.publicListing !== "boolean"
    || ![null, "six-fold", "five-fold"].includes(g.coupon as null | string) || !integer(g.unitPrepaid, 1) || !integer(g.unitSuccessCost, 1, g.unitPrepaid)
    || !integer(g.refundDue) || !text(g.reason) || ["canJoin", "canLeave", "canCancel", "canSettle"].some(k => typeof g[k] !== "boolean")) fail();
  for (const value of members) {
    const m = record(value);
    if (!text(m.nickname, 64) || typeof m.self !== "boolean" || typeof m.creator !== "boolean" || !["active", "left"].includes(String(m.status))
      || !date(m.joinedAt) || !integer(m.paid) || !integer(m.credited) || !integer(m.creditDue) || m.credited + m.creditDue > m.paid
      || typeof m.rewardMailed !== "boolean" || (m.status === "left" && m.rewardMailed)
      || ["characterId", "accountId", "id", "state", "games"].some(k => k in m)) fail();
  }
  const pending = g.status === "pending" && now < Date.parse(g.expiresAt as string);
  if (g.canJoin && (!pending || active.length >= 3 || self.length) || g.canLeave && (!pending || self[0]?.creator || self[0]?.status !== "active")
    || g.canCancel && (!pending || !self[0]?.creator) || g.status === "completed" && (active.length !== 3 || active.some(m => !m.rewardMailed))) fail();
}
function order(v: unknown, characterId: number) {
  const o = record(v);
  if (!code(o.code, "o") || Number.parseInt(o.code.slice(1).split("-")[0]!, 36) !== characterId || !entityToken(o.actionToken, "o")
    || !(o.actionToken as string).startsWith(o.code + ".") || !text(o.catalogId) || !text(o.name) || !date(o.createdAt) || !date(o.balanceStartsAt) || !date(o.balanceEndsAt)
    || Date.parse(o.balanceStartsAt) >= Date.parse(o.balanceEndsAt) || !["deposit-paid", "balance-paid", "full-paid", "expired-unsettled", "refund-due", "refunded"].includes(String(o.status))
    || !integer(o.depositPoints) || !integer(o.balancePoints) || !integer(o.credited) || !integer(o.refundDue) || o.credited + o.refundDue > o.depositPoints
    || typeof o.rewardMailed !== "boolean" || typeof o.canPayBalance !== "boolean" || typeof o.canSettle !== "boolean" || !text(o.reason)
    || (o.canPayBalance && o.status !== "deposit-paid") || ["id", "ownerId", "state"].some(k => k in o)) fail();
}
function validatePublic(snapshot: ActivityResponse, action?: ActivityAction) {
  const p = record(snapshot.nativeForthright), pages = record(p.pages), luxury = record(pages.luxury), wheel = record(pages.wheel), groups = record(pages.groups), shop = record(pages.shop);
  if (p.version !== 1 || p.rulesVersion !== 1 || p.kind !== "forthright-native" || p.catalogVersion !== "forthright-material-v1"
    || p.day !== snapshot.day || !token(p.stateToken) || !p.stateToken.startsWith(p.day + ".") || !date(p.serverNow) || !p.serverNow.startsWith(p.day + "T")
    || p.currency !== "local-task-points" || p.points !== snapshot.points || !integer(p.points) || p.taskEarned !== snapshot.earned || !integer(p.taskEarned)
    || !integer(p.dailyActionsRemaining, 0, 500) || ["state", "games", "claims", "daily", "seed", "createdGroups", "orders"].some(k => k in p)
    || !keys(pages, ["luxury", "wheel", "groups", "shop"])) fail();
  if (luxury.index !== 0 || !text(luxury.title) || array(luxury.tiers).length !== 3) fail();
  array(luxury.tiers).forEach((value, index) => { const t = record(value);
    if (t.tier !== index + 1 || t.target !== [200, 500, 1000][index] || t.claimKey !== "luxury:" + (index + 1) || t.current !== p.taskEarned
      || typeof t.claimed !== "boolean" || typeof t.can !== "boolean" || t.can && (t.claimed || Number(t.current) < Number(t.target))
      || !material(t.reward, 11019, (index + 1) * 5) || !text(t.reason)) fail();
  });
  const slots = array(wheel.slots, 10), drawn = array(wheel.drawnPrizeIds, 10);
  if (wheel.index !== 1 || !text(wheel.title) || wheel.keyTaskPoints !== 20 || wheel.maxKeys !== 30 || !integer(wheel.round, 1, 3)
    || wheel.keyEarned !== Math.min(30, Math.floor(Number(p.taskEarned) / 20)) || !integer(wheel.keySpent, 0, Number(wheel.keyEarned))
    || wheel.keyAvailable !== Number(wheel.keyEarned) - wheel.keySpent || typeof wheel.allRoundsComplete !== "boolean" || typeof wheel.canDraw !== "boolean"
    || !text(wheel.reason) || slots.length !== 10 || new Set(drawn).size !== drawn.length || drawn.some(id => !integer(id, Number(wheel.round) * 100 + 1, Number(wheel.round) * 100 + 10))) fail();
  const remaining = 10 - drawn.length;
  slots.forEach((value, index) => { const s = record(value), expected = wheelItems[Number(wheel.round) - 1]![index];
    if (s.index !== index || s.prizeId !== Number(wheel.round) * 100 + index + 1 || s.drawn !== drawn.includes(s.prizeId)
      || s.probabilityNumerator !== (s.drawn ? 0 : 1) || s.probabilityDenominator !== remaining
      || (index < 8 ? !material(s.reward, expected![0], expected![1]) : !coupon(s.reward, index === 8 ? "six-fold" : "five-fold"))) fail();
  });
  if (wheel.keySpent !== (Number(wheel.round) - 1) * 10 + drawn.length || wheel.allRoundsComplete !== (wheel.round === 3 && drawn.length === 10)
    || wheel.canDraw && (wheel.allRoundsComplete || wheel.keyAvailable === 0 || p.dailyActionsRemaining === 0)) fail();
  const now = Date.parse(p.serverNow as string);
  if (groups.index !== 2 || !text(groups.title) || groups.cycle !== p.day || !integer(groups.round, 1, 4) || groups.pendingGroupLimit !== 1
    || groups.groupMinutes !== 30 || groups.globalStock !== "not-ported-personal-limits" || array(groups.offers, 8).length !== 8 || array(groups.coupons, 2).length !== 2) fail();
  array(groups.coupons, 2).forEach((value, index) => { const c = record(value);
    if (c.coupon !== ["six-fold", "five-fold"][index] || c.basisPoints !== [6000, 5000][index] || !text(c.name)
      || !integer(c.issued, 0, 3) || !integer(c.reserved, 0, c.issued) || !integer(c.consumed, 0, c.issued)
      || !integer(c.available) || c.available !== c.issued - c.reserved - c.consumed) fail();
  });
  array(groups.offers, 8).forEach((value, index) => { const row = record(value);
    if (row.index !== index || row.round !== groups.round || row.catalogId !== `forthright-group:r${groups.round}:${index}` || !text(row.name)
      || !material(row.reward, groupTemplates[index], groupCounts[index]) || row.listPoints !== groupPrices[index] || row.groupBaseBasisPoints !== 8000
      || row.personalLimit !== 2 || !integer(row.bought, 0, 2) || !integer(row.reserved, 0, 2) || row.remaining !== 2 - row.bought - row.reserved
      || !integer(row.remaining, 0, 2) || !text(row.reason) || array(row.quotes, 3).length !== 3) fail();
    array(row.quotes, 3).forEach((value, tier) => { const q = record(value), cost = Math.ceil(groupPrices[index]! * [0.8, 0.6, 0.5][tier]!), successCost = Math.ceil(cost * 0.95);
      if (q.tier !== tier || q.coupon !== [null, "six-fold", "five-fold"][tier] || q.cost !== cost || q.successCost !== successCost || q.successCashback !== cost - successCost
        || typeof q.can !== "boolean" || !text(q.reason) || q.can && (Number(p.points) < cost || row.remaining === 0 || p.dailyActionsRemaining === 0)) fail();
    });
    for (const g of array(row.groups)) group(g, now);
  });
  for (const value of [...array(groups.createdOrders), ...array(groups.joinedOrders)]) group(value, now);
  if (groups.inspected !== null) group(groups.inspected, now);
  if (action?.type === "inspect-group" && record(groups.inspected).code !== action.choice) fail();
  if (shop.index !== 3 || !text(shop.title) || shop.cycle !== p.day || !integer(shop.round, 1, 5) || !["deposit", "balance", "full-price"].includes(String(shop.phase))
    || !date(shop.phaseStartsAt) || !date(shop.phaseEndsAt) || Date.parse(shop.phaseStartsAt) >= Date.parse(shop.phaseEndsAt)
    || shop.globalStock !== "not-ported-personal-limits" || array(shop.offers, 8).length !== 8) fail();
  array(shop.offers, 8).forEach((value, index) => { const row = record(value), discount = Math.ceil(shopPrices[index]! * 0.8), deposit = Math.ceil(discount * 0.25);
    if (row.index !== index || row.round !== shop.round || row.catalogId !== `forthright-shop:r${shop.round}:${index}` || !text(row.name)
      || !material(row.reward, groupTemplates[index], shopCounts[index]) || row.fullPoints !== shopPrices[index] || row.discountedPoints !== discount
      || row.depositPoints !== deposit || row.balancePoints !== discount - deposit || row.personalLimit !== 1 || !integer(row.bought, 0, 1) || !integer(row.reserved, 0, 1)
      || !integer(row.remaining, 0, 1) || row.remaining !== 1 - row.bought - row.reserved || !text(row.reason)
      || typeof row.canDeposit !== "boolean" || typeof row.canBuyFullPrice !== "boolean"
      || row.canDeposit && (shop.phase !== "deposit" || row.remaining === 0 || Number(p.points) < deposit || p.dailyActionsRemaining === 0)
      || row.canBuyFullPrice && (shop.phase !== "full-price" || row.remaining === 0 || Number(p.points) < shopPrices[index]! || p.dailyActionsRemaining === 0)) fail();
    if (row.order !== null) order(row.order, snapshot.characterId);
  });
  for (const value of array(shop.unsettledOrders)) order(value, snapshot.characterId);
  const rules = record(p.rules), unavailable = array(p.unavailable, 5), features = new Set<string>();
  if (rules.source !== "explicit-local-rules" || !array(rules.description).length || array(rules.description).some(v => !text(v)) || unavailable.length !== 5) fail();
  for (const value of unavailable) { const u = record(value);
    if (!["original-payment", "original-global-stock", "original-cross-server-invites", "original-broadcast", "original-unverified-economy"].includes(String(u.feature))
      || features.has(String(u.feature)) || !text(u.reason)) fail(); features.add(String(u.feature));
  }
}
export const retryNativeForthrightRequest = (request: ActivityRequest) =>
  request.activityId === "forthright-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeForthrightHost(options: NativeForthrightHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopForthrightAcceptSnapshot === "function" && typeof options.player.workshopForthrightRejectRequest === "function",
    accept: envelope => options.player.workshopForthrightAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopForthrightRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopForthrightRead = read; target.workshopForthrightRequest = request; target.workshopForthrightReport = report;
      return () => {
        if (target.workshopForthrightRead === read) delete target.workshopForthrightRead;
        if (target.workshopForthrightRequest === request) delete target.workshopForthrightRequest;
        if (target.workshopForthrightReport === report) delete target.workshopForthrightReport;
      };
    },
  }, { activityId: "forthright-native", title: "原版至尊豪礼", effectKey: "nativeForthrightAction", parseAction: nativeAction, validatePublic,
    isReadOnlyAction: action => action.type === "inspect-group" });
}
