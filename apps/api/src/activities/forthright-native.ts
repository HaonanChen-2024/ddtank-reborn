import { createHash } from "node:crypto";
import { LOCAL_RULES, PRIZES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityState, type ActivityWallet, type ActivityReward } from "./types.js";
export type StateToken = string; // UTC YYYY-MM-DD + '.' + full SHA-256/base64url(43): exactly 54 chars.
export type GroupCode = string; // g<creator-ID base36>-<creator sequence base36>, 4..14 chars.
export type OrderCode = string; // o<owner-ID base36>-<owner sequence base36>, 4..14 chars.
export type GroupToken = string; // GroupCode + '.' + full SHA-256/base64url(43): at most 58 chars.
export type OrderToken = string; // OrderCode + '.' + full SHA-256/base64url(43): at most 58 chars.
export type Reward = { kind: "item"; templateId: 11019 | 11001 | 11021 | 11002; count: number; validDays: 0; bound: true }
  | { kind: "coupon"; coupon: "six-fold" | "five-fold"; count: 1; name: string };
export type CouponChoice = 0 | 1 | 2; // none / six-fold / five-fold; server owned ledger, never bag Place.
export type Index8 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Action =
  | { type: "claim"; tier: 1 | 2 | 3; choice: StateToken }
  | { type: "draw"; count: 1; choice: StateToken }
  | { type: "buy-alone"; index: Index8; tier: CouponChoice; count: 1; choice: StateToken }
  | { type: "open-group"; index: Index8; tier: CouponChoice; marked: boolean; count: 1; choice: StateToken }
  | { type: "join-group"; count: 1; choice: GroupToken }
  | { type: "leave-group" | "cancel-group" | "settle-group"; choice: GroupToken }
  | { type: "inspect-group"; choice: GroupCode } // authenticated read-only branch, no state/wallet/receipt writes.
  | { type: "deposit" | "buy-full-price"; index: Index8; count: 1; choice: StateToken }
  | { type: "pay-balance" | "settle-order"; choice: OrderToken };

export interface CouponView { coupon: "six-fold" | "five-fold"; name: string; basisPoints: 6000 | 5000;
  issued: number; reserved: number; consumed: number; available: number }
export interface Entitlement { can: boolean; reason: string }
export interface LuxuryTier extends Entitlement { tier: 1 | 2 | 3; target: 200 | 500 | 1000;
  claimKey: "luxury:1" | "luxury:2" | "luxury:3"; claimed: boolean; reward: Reward; current: number }
export interface WheelSlot { index: number; prizeId: number; reward: Reward; drawn: boolean;
  probabilityNumerator: 0 | 1; probabilityDenominator: number }
export interface Quote extends Entitlement { tier: CouponChoice; coupon: null | "six-fold" | "five-fold";
  cost: number; successCost: number; successCashback: number }
export interface GroupOffer { index: Index8; catalogId: string; round: 1 | 2 | 3 | 4; name: string; reward: Reward;
  listPoints: number; groupBaseBasisPoints: 8000; quotes: [Quote, Quote, Quote];
  personalLimit: 2; bought: number; reserved: number; remaining: number; groups: GroupView[]; reason: string }
export interface GroupMember { nickname: string; self: boolean; creator: boolean; status: "active" | "left"; joinedAt: string;
  paid: number; credited: number; creditDue: number; rewardMailed: boolean }
export interface GroupView { code: GroupCode; actionToken: GroupToken; catalogId: string; name: string;
  createdAt: string; expiresAt: string; requiredMembers: 3; members: GroupMember[];
  status: "pending" | "completed" | "cancelled" | "expired-unsettled" | "refunded";
  publicListing: boolean; coupon: null | "six-fold" | "five-fold"; unitPrepaid: number;
  unitSuccessCost: number; refundDue: number; canJoin: boolean; canLeave: boolean; canCancel: boolean; canSettle: boolean; reason: string }
export interface ShopOffer { index: Index8; catalogId: string; round: 1 | 2 | 3 | 4 | 5; name: string; reward: Reward;
  fullPoints: number; discountedPoints: number; depositPoints: number; balancePoints: number;
  personalLimit: 1; bought: number; reserved: number; remaining: number;
  canDeposit: boolean; canBuyFullPrice: boolean; order: OrderView | null; reason: string }
export interface OrderView { code: OrderCode; actionToken: OrderToken; catalogId: string; name: string;
  createdAt: string; balanceStartsAt: string; balanceEndsAt: string;
  status: "deposit-paid" | "balance-paid" | "full-paid" | "expired-unsettled" | "refund-due" | "refunded";
  depositPoints: number; balancePoints: number; credited: number; refundDue: number;
  rewardMailed: boolean; canPayBalance: boolean; canSettle: boolean; reason: string }
export interface NativeForthrightView {
  version: 1; kind: "forthright-native"; rulesVersion: 1; catalogVersion: "forthright-material-v1";
  day: string; serverNow: string; stateToken: StateToken; currency: "local-task-points";
  points: number; taskEarned: number; dailyActionsRemaining: number;
  pages: {
    luxury: { index: 0; title: "累计任务礼"; tiers: [LuxuryTier, LuxuryTier, LuxuryTier] };
    wheel: { index: 1; title: "任务钥匙轮盘"; keyEarned: number; keySpent: number; keyAvailable: number;
      keyTaskPoints: 20; maxKeys: 30; round: 1 | 2 | 3; allRoundsComplete: boolean;
      slots: WheelSlot[]; drawnPrizeIds: number[]; canDraw: boolean; reason: string };
    groups: { index: 2; title: "三人积分拼团"; cycle: string; round: 1 | 2 | 3 | 4;
      offers: GroupOffer[]; createdOrders: GroupView[]; joinedOrders: GroupView[];
      coupons: [CouponView, CouponView]; inspected: GroupView | null; pendingGroupLimit: 1;
      groupMinutes: 30; globalStock: "not-ported-personal-limits" };
    shop: { index: 3; title: "积分分期商店"; cycle: string; round: 1 | 2 | 3 | 4 | 5;
      phase: "deposit" | "balance" | "full-price"; phaseStartsAt: string; phaseEndsAt: string;
      offers: ShopOffer[]; unsettledOrders: OrderView[]; globalStock: "not-ported-personal-limits" };
  };
  rules: { source: "explicit-local-rules"; description: string[] };
  unavailable: { feature: "original-payment" | "original-global-stock" | "original-cross-server-invites" | "original-broadcast" | "original-unverified-economy"; reason: string }[];
}
export type Effect =
  | { type: "claimed"; tier: 1 | 2 | 3; claimKey: string; rewards: Reward[] }
  | { type: "drawn"; round: 1 | 2 | 3; prizeId: number; index: number; rewards: Reward[]; nextRound: 1 | 2 | 3; allRoundsComplete: boolean }
  | { type: "bought-alone" | "deposited" | "balance-paid" | "full-paid"; catalogId: string; code: OrderCode | null; cost: number; rewards: Reward[] }
  | { type: "group-opened" | "group-joined" | "group-left" | "group-completed" | "group-cancelled" | "group-settled";
      code: GroupCode; cost: number; credited: number; creditDue: number; rewards: Reward[] }
  | { type: "order-settled"; code: OrderCode; credited: number; creditDue: number; rewards: [] };
export interface FreshEnvelope { nativeForthrightAction?: { requestId: string; effects: Effect[] } }

/** Literal local catalogue; rows repeat by round, only round/catalogId changes. */
export const groupRows = [
  { index: 0, templateId: 11019, count: 5, listPoints: 40 },
  { index: 1, templateId: 11001, count: 5, listPoints: 50 },
  { index: 2, templateId: 11021, count: 2, listPoints: 60 },
  { index: 3, templateId: 11002, count: 2, listPoints: 70 },
  { index: 4, templateId: 11019, count: 8, listPoints: 80 },
  { index: 5, templateId: 11001, count: 8, listPoints: 90 },
  { index: 6, templateId: 11021, count: 4, listPoints: 100 },
  { index: 7, templateId: 11002, count: 4, listPoints: 120 },
] as const;
export const shopRows = [
  { index: 0, templateId: 11019, count: 3, fullPoints: 20 },
  { index: 1, templateId: 11001, count: 3, fullPoints: 25 },
  { index: 2, templateId: 11021, count: 1, fullPoints: 30 },
  { index: 3, templateId: 11002, count: 1, fullPoints: 35 },
  { index: 4, templateId: 11019, count: 6, fullPoints: 40 },
  { index: 5, templateId: 11001, count: 6, fullPoints: 45 },
  { index: 6, templateId: 11021, count: 2, fullPoints: 50 },
  { index: 7, templateId: 11002, count: 2, fullPoints: 60 },
] as const;
export const wheelItemsByRound = [
  [[11019,1],[11001,1],[11019,2],[11001,2],[11021,1],[11002,1],[11019,3],[11001,3]],
  [[11019,2],[11001,2],[11019,3],[11001,3],[11021,1],[11002,1],[11019,4],[11001,4]],
  [[11019,3],[11001,3],[11019,4],[11001,4],[11021,2],[11002,2],[11019,5],[11001,5]],
] as const; // indices 8/9 of every round are one six-fold / five-fold coupon; nonreplacement, uniform remaining slots.

/** Private outline, never serialized to HTTP. Preserve unknown enclosing and owner fields. */
export interface PrivateState {
  version: 1; kind: "forthright-native"; rulesVersion: 1; nextSequence: number;
  wheel: { keySpent: number; round: 1 | 2 | 3; drawn: number[][]; allRoundsComplete: boolean };
  coupons: { "six-fold": { issued: number; consumed: number; reservations: Record<string, 1> };
    "five-fold": { issued: number; consumed: number; reservations: Record<string, 1> } };
  createdGroups: Record<string, PrivateGroup>;
  joinedGroupCodes: string[];
  orders: Record<string, PrivateOrder>;
  purchases: Record<string, { fulfilled: number; reservedCodes: string[]; attempts: number }>;
}
export interface PrivateGroup {
  id: string; sequence: number; code: GroupCode; revision: number; creatorId: number;
  cycle: string; catalogId: string; row: number; round: number;
  createdAt: string; expiresAt: string; publicListing: boolean;
  status: "pending" | "completed" | "cancelled" | "expired";
  coupon: null | "six-fold" | "five-fold"; unitPrepaid: number; unitSuccessCost: number;
  reward: Reward; // immutable server-local item snapshot; never client input.
  members: { characterId: number; nickname: string; status: "active" | "left"; joinedAt: string; paid: number;
    credited: number; creditDue: number; rewardMailed: boolean; terminalClaimKey: string | null }[];
}
export interface PrivateOrder {
  id: string; sequence: number; code: OrderCode; revision: number; ownerId: number;
  cycle: string; catalogId: string; row: number; round: number;
  createdAt: string; balanceStartsAt: string; balanceEndsAt: string;
  status: "deposit-paid" | "balance-paid" | "full-paid" | "cancelled";
  depositPoints: number; balancePoints: number; credited: number; refundDue: number;
  reward: Reward; rewardMailed: boolean; terminalClaimKey: string | null;
}

export type ForthrightNativeEffect = Effect;
export type ForthrightNativeView = NativeForthrightView;
const MAX = 2147483647;
const DURATION = 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dayOf = (now: Date) => now.toISOString().slice(0, 10);
const integer = (n: unknown, min = 0, max = MAX): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new ActivityError(message, 409); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("base64url");
const nameOf = (r: Reward) => r.kind === "item" ? `${PRIZES.find(p => p.templateId === r.templateId)!.name}×${r.count}` : r.name;
const item = (templateId: number, count: number): Reward => ({ kind: "item", templateId: templateId as 11019, count, validDays: 0, bound: true });
export const forthrightItems = (rewards: Reward[]): ActivityReward[] => rewards.flatMap(r => r.kind === "item" ? [{ templateId: r.templateId, count: r.count, validDays: 0 }] : []);
export function decodeForthrightCode(code: unknown, prefix: "g" | "o" = "g"): { ownerId: number; sequence: number } {
  need(typeof code === "string" && code.length <= 14, "订单编号无效。");
  const m = new RegExp(`^${prefix}([1-9a-z][0-9a-z]{0,5})-([1-9a-z][0-9a-z]{0,5})$`).exec(code);
  need(m, "订单编号无效。");
  const ownerId = parseInt(m[1], 36), sequence = parseInt(m[2], 36);
  need(integer(ownerId, 1) && integer(sequence, 1) && ownerId.toString(36) === m[1] && sequence.toString(36) === m[2], "订单编号无效。");
  return { ownerId, sequence };
}
export const forthrightEntityCode = (choice: string) => choice.split(".")[0];
const codeOf = (prefix: "g" | "o", ownerId: number, sequence: number) => `${prefix}${ownerId.toString(36)}-${sequence.toString(36)}`;
const validReward = (r: unknown): r is Reward => object(r) && (r.kind === "item" ? PRIZES.some(p => p.templateId === r.templateId) && integer(r.count, 1, 100) && r.validDays === 0 && r.bound === true : r.kind === "coupon" && ["six-fold", "five-fold"].includes(String(r.coupon)) && r.count === 1 && typeof r.name === "string");
export function validateForthrightGroup(value: unknown): PrivateGroup {
  need(object(value), "拼团存档无效，请保留原件。");
  const g = value as unknown as PrivateGroup, parsed = decodeForthrightCode(g.code);
  need(UUID.test(g.id) && integer(g.revision, 0) && parsed.ownerId === g.creatorId && parsed.sequence === g.sequence &&
    typeof g.cycle === "string" && typeof g.catalogId === "string" && integer(g.row, 0, 7) && integer(g.round, 1, 4) &&
    Number.isFinite(Date.parse(g.createdAt)) && Number.isFinite(Date.parse(g.expiresAt)) && typeof g.publicListing === "boolean" &&
    ["pending", "completed", "cancelled", "expired"].includes(g.status) && (g.coupon === null || ["six-fold", "five-fold"].includes(g.coupon)) &&
    integer(g.unitPrepaid, 1) && integer(g.unitSuccessCost, 1, g.unitPrepaid) && validReward(g.reward) && g.reward.kind === "item" && Array.isArray(g.members) && g.members.length > 0,
    "拼团存档无效，请保留原件。");
  const ids = new Set<number>();
  for (const m of g.members) {
    need(object(m) && integer(m.characterId, 1) && !ids.has(m.characterId) && typeof m.nickname === "string" && m.nickname.length > 0 &&
      ["active", "left"].includes(m.status) && Number.isFinite(Date.parse(m.joinedAt)) && m.paid === g.unitPrepaid && integer(m.credited, 0, m.paid) &&
      integer(m.creditDue, 0, m.paid - m.credited) && typeof m.rewardMailed === "boolean" && (m.terminalClaimKey === null || typeof m.terminalClaimKey === "string"), "拼团成员存档无效。");
    ids.add(m.characterId);
  }
  need(g.members.some(m => m.characterId === g.creatorId && m.status === "active") && g.members.filter(m => m.status === "active").length <= 3, "拼团成员状态无效。");
  return structuredClone(g);
}
export function readForthrightNativeState(value: unknown): PrivateState {
  if (value === undefined) return { version: 1, kind: "forthright-native", rulesVersion: 1, nextSequence: 1,
    wheel: { keySpent: 0, round: 1, drawn: [[], [], []], allRoundsComplete: false },
    coupons: { "six-fold": { issued: 0, consumed: 0, reservations: {} }, "five-fold": { issued: 0, consumed: 0, reservations: {} } },
    createdGroups: {}, joinedGroupCodes: [], orders: {}, purchases: {} };
  need(object(value), "至尊豪礼存档无效，请保留原件。");
  const s = structuredClone(value) as unknown as PrivateState;
  need(s.version === 1 && s.kind === "forthright-native" && s.rulesVersion === 1 && integer(s.nextSequence, 1) && object(s.wheel) &&
    integer(s.wheel.keySpent, 0, 30) && integer(s.wheel.round, 1, 3) && typeof s.wheel.allRoundsComplete === "boolean" && Array.isArray(s.wheel.drawn) && s.wheel.drawn.length === 3 &&
    object(s.coupons) && object(s.createdGroups) && object(s.orders) && object(s.purchases) && Array.isArray(s.joinedGroupCodes), "至尊豪礼存档无效，请保留原件。");
  let draws = 0;
  for (let i = 0; i < 3; i++) { const a = s.wheel.drawn[i]; need(Array.isArray(a) && a.length <= 10 && new Set(a).size === a.length && a.every(n => integer(n, (i + 1) * 100 + 1, (i + 1) * 100 + 10)), "钥匙轮盘存档无效。"); draws += a.length; }
  need(draws === s.wheel.keySpent && s.wheel.allRoundsComplete === (draws === 30) && s.wheel.round === Math.min(3, Math.floor(draws / 10) + 1) &&
    s.wheel.drawn.every((a, i) => i + 1 < s.wheel.round ? a.length === 10 : i + 1 > s.wheel.round ? a.length === 0 : true), "钥匙轮盘进度无效。");
  for (const [j, key] of (["six-fold", "five-fold"] as const).entries()) {
    const c = s.coupons[key];
    need(object(c) && integer(c.issued, 0, 3) && integer(c.consumed, 0, 3) && object(c.reservations) && Object.values(c.reservations).every(x => x === 1) &&
      c.issued === s.wheel.drawn.filter((a, i) => a.includes((i + 1) * 100 + 9 + j)).length && c.consumed + Object.keys(c.reservations).length <= c.issued, "优惠券存档无效。");
  }
  for (const [key, g] of Object.entries(s.createdGroups)) { validateForthrightGroup(g); need(key === String(g.sequence), "拼团索引无效。"); }
  for (const code of s.joinedGroupCodes) decodeForthrightCode(code);
  need(new Set(s.joinedGroupCodes).size === s.joinedGroupCodes.length, "参团存档无效。");
  for (const [key, o] of Object.entries(s.orders)) {
    const p = decodeForthrightCode(o.code, "o");
    need(object(o) && UUID.test(o.id) && p.ownerId === o.ownerId && p.sequence === o.sequence && key === String(o.sequence) && integer(o.revision) &&
      integer(o.row, 0, 7) && integer(o.round, 1, 5) && typeof o.cycle === "string" && typeof o.catalogId === "string" && Number.isFinite(Date.parse(o.createdAt)) &&
      Number.isFinite(Date.parse(o.balanceStartsAt)) && Number.isFinite(Date.parse(o.balanceEndsAt)) && ["deposit-paid", "balance-paid", "full-paid", "cancelled"].includes(o.status) &&
      integer(o.depositPoints) && integer(o.balancePoints) && integer(o.credited, 0, o.depositPoints) && integer(o.refundDue, 0, o.depositPoints - o.credited) && validReward(o.reward) && o.reward.kind === "item" && typeof o.rewardMailed === "boolean", "分期订单存档无效。");
  }
  for (const p of Object.values(s.purchases)) need(object(p) && integer(p.fulfilled) && integer(p.attempts) && Array.isArray(p.reservedCodes) && new Set(p.reservedCodes).size === p.reservedCodes.length && p.reservedCodes.every(c => typeof c === "string"), "限购存档无效。");
  return s;
}
export function validateForthrightNativeAction(action: ActivityAction): Action {
  need(object(action) && typeof action.type === "string", "活动操作无效。");
  const fields: Record<string, string[]> = { claim: ["tier", "choice"], draw: ["count", "choice"], "buy-alone": ["index", "tier", "count", "choice"],
    "open-group": ["index", "tier", "marked", "count", "choice"], "join-group": ["count", "choice"], "leave-group": ["choice"], "cancel-group": ["choice"], "settle-group": ["choice"],
    "inspect-group": ["choice"], deposit: ["index", "count", "choice"], "buy-full-price": ["index", "count", "choice"], "pay-balance": ["choice"], "settle-order": ["choice"] };
  const keys = fields[action.type]; need(keys && Object.keys(action).length === keys.length + 1 && Object.keys(action).every(k => k === "type" || keys.includes(k)), "活动字段无效。");
  need(typeof action.choice === "string", "请重新打开活动刷新状态。");
  if (keys.includes("count")) need(action.count === 1, "每次操作数量固定为1。");
  if (keys.includes("index")) need(integer(action.index, 0, 7), "商品编号无效。");
  if (keys.includes("tier")) need(integer(action.tier, action.type === "claim" ? 1 : 0, action.type === "claim" ? 3 : 2), "档位无效。");
  if (keys.includes("marked")) need(typeof action.marked === "boolean", "公开拼团选项无效。");
  if (action.type === "inspect-group") decodeForthrightCode(action.choice);
  else if (["join-group", "leave-group", "cancel-group", "settle-group", "pay-balance", "settle-order"].includes(action.type)) {
    const parts = action.choice.split("."); need(parts.length === 2 && /^[A-Za-z0-9_-]{43}$/.test(parts[1]), "订单状态凭据无效。");
    decodeForthrightCode(parts[0], action.type.includes("group") ? "g" : "o");
  } else need(/^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(action.choice), "活动状态凭据无效。");
  return action as Action;
}
function timing(now: Date) {
  const ordinal = Math.floor(now.getTime() / DURATION), start = ordinal * DURATION, part = Math.floor((now.getTime() - start) / 28800000);
  return { day: dayOf(now), groupRound: (ordinal % 4 + 1) as 1 | 2 | 3 | 4, shopRound: (ordinal % 5 + 1) as 1 | 2 | 3 | 4 | 5,
    phase: (["deposit", "balance", "full-price"] as const)[part], phaseStart: new Date(start + part * 28800000).toISOString(), phaseEnd: new Date(start + (part + 1) * 28800000).toISOString(),
    balanceStart: new Date(start + 28800000).toISOString(), balanceEnd: new Date(start + 57600000).toISOString() };
}
const dailyRemaining = (root: ActivityState, ctx: ActivityContext) => Math.max(0, LOCAL_RULES.maxDailyActions - (root.day === dayOf(ctx.now) ? root.daily.actions ?? 0 : 0));
const purchaseKey = (kind: "g" | "s", cycle: string, catalogId: string) => `${kind}:${cycle}:${catalogId}`;
function purchase(s: PrivateState, key: string) { return s.purchases[key] ?? (s.purchases[key] = { fulfilled: 0, reservedCodes: [], attempts: 0 }); }
const existingPurchase = (s: PrivateState, key: string) => s.purchases[key] ?? { fulfilled: 0, reservedCodes: [], attempts: 0 };
const pendingGroup = (s: PrivateState) => Object.entries(s.purchases).some(([key, p]) => key.startsWith("g:") && p.reservedCodes.length > 0);
const couponKey = (tier: number) => tier === 1 ? "six-fold" as const : tier === 2 ? "five-fold" as const : null;
const couponAvailable = (s: PrivateState, key: "six-fold" | "five-fold") => s.coupons[key].issued - s.coupons[key].consumed - Object.keys(s.coupons[key].reservations).length;
function baseFingerprint(root: ActivityState, s: PrivateState, ctx: ActivityContext, wallet: ActivityWallet) {
  return { day: dayOf(ctx.now), phase: timing(ctx.now).phase, actor: ctx.characterId, wallet, claims: root.claims, state: s,
    dailyActionsRemaining: dailyRemaining(root, ctx), catalog: "forthright-material-v1", rules: 1 };
}
const stateToken = (root: ActivityState, s: PrivateState, ctx: ActivityContext, w: ActivityWallet) => `${dayOf(ctx.now)}.${hash(baseFingerprint(root, s, ctx, w))}`;
const groupToken = (root: ActivityState, s: PrivateState, ctx: ActivityContext, w: ActivityWallet, g: PrivateGroup) => `${g.code}.${hash({ base: baseFingerprint(root, s, ctx, w), group: g, expired: Date.parse(g.expiresAt) <= ctx.now.getTime() })}`;
const orderToken = (root: ActivityState, s: PrivateState, ctx: ActivityContext, w: ActivityWallet, o: PrivateOrder) => `${o.code}.${hash({ base: baseFingerprint(root, s, ctx, w), order: o, expired: Date.parse(o.balanceEndsAt) <= ctx.now.getTime() })}`;
function wheelReward(round: number, index: number): Reward {
  if (index < 8) { const r = wheelItemsByRound[round - 1][index]; return item(r[0], r[1]); }
  return { kind: "coupon", coupon: index === 8 ? "six-fold" : "five-fold", count: 1, name: index === 8 ? "本地六折券" : "本地五折券" };
}
function groupProjection(root: ActivityState, s: PrivateState, ctx: ActivityContext, wallet: ActivityWallet, g: PrivateGroup): GroupView {
  const actor = ctx.characterId, member = g.members.find(m => m.characterId === actor), expired = Date.parse(g.expiresAt) <= ctx.now.getTime(), pending = g.status === "pending" && !expired;
  const p = existingPurchase(s, purchaseKey("g", g.cycle, g.catalogId));
  const remaining = 2 - p.fulfilled - p.reservedCodes.length, attempts = existingPurchase(s, `attempt:${dayOf(ctx.now)}`).attempts;
  const canJoin = pending && !member && !pendingGroup(s) && remaining > 0 && attempts < 3 && wallet.points >= g.unitPrepaid && dailyRemaining(root, ctx) > 0;
  const refundable = g.members.some(m => m.creditDue > 0);
  const status: GroupView["status"] = g.status === "pending" ? expired ? "expired-unsettled" : "pending" : g.status === "completed" ? "completed" : refundable ? "cancelled" : "refunded";
  return { code: g.code, actionToken: groupToken(root, s, ctx, wallet, g), catalogId: g.catalogId, name: nameOf(g.reward), createdAt: g.createdAt, expiresAt: g.expiresAt,
    requiredMembers: 3, members: g.members.map(m => ({ nickname: m.nickname, self: m.characterId === actor, creator: m.characterId === g.creatorId, status: m.status, joinedAt: m.joinedAt, paid: m.paid, credited: m.credited, creditDue: m.creditDue, rewardMailed: m.rewardMailed })),
    status, publicListing: g.publicListing, coupon: g.coupon, unitPrepaid: g.unitPrepaid, unitSuccessCost: g.unitSuccessCost,
    refundDue: member?.creditDue ?? 0, canJoin, canLeave: pending && member?.status === "active" && actor !== g.creatorId,
    canCancel: pending && actor === g.creatorId, canSettle: !!member && (g.status === "pending" && expired || g.members.some(m => m.creditDue > 0)),
    reason: status === "pending" ? canJoin ? "可支付等额积分加入真实三人团。" : member ? "已参团；团长可取消，参团者可单独退出。" : "需满足积分、个人限购、每日发起/加入次数及单个待成团限制。" : status === "expired-unsettled" ? "团已过期，成员可显式结算退款。" : "此团已结算；历史成员不能再次加入。" };
}
function orderProjection(root: ActivityState, s: PrivateState, ctx: ActivityContext, wallet: ActivityWallet, o: PrivateOrder): OrderView {
  const expired = ctx.now.getTime() >= Date.parse(o.balanceEndsAt), balance = ctx.now.getTime() >= Date.parse(o.balanceStartsAt) && !expired;
  const status: OrderView["status"] = o.status === "deposit-paid" ? expired ? "expired-unsettled" : "deposit-paid" : o.status === "cancelled" ? o.refundDue > 0 ? "refund-due" : "refunded" : o.status;
  return { code: o.code, actionToken: orderToken(root, s, ctx, wallet, o), catalogId: o.catalogId, name: nameOf(o.reward), createdAt: o.createdAt,
    balanceStartsAt: o.balanceStartsAt, balanceEndsAt: o.balanceEndsAt, status, depositPoints: o.depositPoints, balancePoints: o.balancePoints, credited: o.credited,
    refundDue: o.refundDue, rewardMailed: o.rewardMailed, canPayBalance: o.status === "deposit-paid" && balance && wallet.points >= o.balancePoints,
    canSettle: o.status === "deposit-paid" && expired || o.status === "cancelled" && o.refundDue > 0,
    reason: status === "expired-unsettled" ? "未付尾款；请显式结算退回订金。" : status === "deposit-paid" ? balance ? "当前为尾款时段，可支付冻结尾款领取物品。" : "订金已付，UTC08:00起可支付尾款。" : "订单已结算；退款不增加累计任务积分。" };
}
export function viewForthrightNative(root: ActivityState, ctx: ActivityContext, wallet: ActivityWallet): NativeForthrightView {
  const s = readForthrightNativeState(root.games.forthrightNativeV1), t = timing(ctx.now), remaining = dailyRemaining(root, ctx), actor = ctx.characterId;
  const known = new Map<string, PrivateGroup>();
  for (const g of [...(ctx.forthrightGroups ?? []), ...Object.values(s.createdGroups)]) known.set(g.code, validateForthrightGroup(g));
  const allGroups = [...known.values()].map(g => groupProjection(root, s, ctx, wallet, g));
  const keyEarned = Math.min(30, Math.floor(wallet.earned / 20)), keyAvailable = keyEarned - s.wheel.keySpent;
  const coupons = (["six-fold", "five-fold"] as const).map(k => ({ coupon: k, name: k === "six-fold" ? "本地六折券" : "本地五折券", basisPoints: k === "six-fold" ? 6000 : 5000,
    issued: s.coupons[k].issued, reserved: Object.keys(s.coupons[k].reservations).length, consumed: s.coupons[k].consumed, available: couponAvailable(s, k) })) as [CouponView, CouponView];
  const canDraw = !s.wheel.allRoundsComplete && keyAvailable > 0 && remaining > 0;
  const groupOffers = groupRows.map((r): GroupOffer => {
    const catalogId = `forthright-group:r${t.groupRound}:${r.index}`, p = existingPurchase(s, purchaseKey("g", t.day, catalogId)), available = Math.max(0, 2 - p.fulfilled - p.reservedCodes.length);
    const quotes = ([0, 1, 2] as const).map(tier => { const coupon = couponKey(tier), cost = Math.ceil(r.listPoints * (coupon === "six-fold" ? .6 : coupon === "five-fold" ? .5 : .8)), successCost = Math.ceil(cost * .95);
      return { tier, coupon, cost, successCost, successCashback: cost - successCost, can: available > 0 && wallet.points >= cost && remaining > 0 && (!coupon || couponAvailable(s, coupon) > 0), reason: "本地积分单购/拼团报价；开团另需没有待成团且今日尝试少于3次。" }; }) as [Quote, Quote, Quote];
    return { index: r.index, catalogId, round: t.groupRound, name: nameOf(item(r.templateId, r.count)), reward: item(r.templateId, r.count), listPoints: r.listPoints, groupBaseBasisPoints: 8000,
      quotes, personalLimit: 2, bought: p.fulfilled, reserved: p.reservedCodes.length, remaining: available, groups: allGroups.filter(g => g.catalogId === catalogId && g.publicListing && g.status === "pending"), reason: "每角色每日此商品最多2份；真实三人成团，30分钟未满可结算退款。" };
  });
  const orderViews = Object.values(s.orders).map(o => orderProjection(root, s, ctx, wallet, o));
  const shopOffers = shopRows.map((r): ShopOffer => {
    const catalogId = `forthright-shop:r${t.shopRound}:${r.index}`, p = existingPurchase(s, purchaseKey("s", t.day, catalogId));
    const discountedPoints = Math.ceil(r.fullPoints * .8), depositPoints = Math.ceil(discountedPoints * .25), balancePoints = discountedPoints - depositPoints;
    const available = Math.max(0, 1 - p.fulfilled - p.reservedCodes.length), order = orderViews.find(o => o.catalogId === catalogId && p.reservedCodes.includes(o.code)) ?? null;
    return { index: r.index, catalogId, round: t.shopRound, name: nameOf(item(r.templateId, r.count)), reward: item(r.templateId, r.count), fullPoints: r.fullPoints,
      discountedPoints, depositPoints, balancePoints, personalLimit: 1, bought: p.fulfilled, reserved: p.reservedCodes.length, remaining: available,
      canDeposit: t.phase === "deposit" && available > 0 && remaining > 0 && wallet.points >= depositPoints,
      canBuyFullPrice: t.phase === "full-price" && available > 0 && remaining > 0 && wallet.points >= r.fullPoints, order,
      reason: "UTC00–08付订金、08–16付尾款、16–24可原价购买；每角色每日每商品1份。" };
  });
  const tiers = LOCAL_RULES.luxuryGift.map((target, i): LuxuryTier => { const tier = (i + 1) as 1 | 2 | 3, claimKey = `luxury:${tier}` as LuxuryTier["claimKey"], claimed = root.claims.includes(claimKey);
    return { tier, target, claimKey, claimed, reward: item(11019, tier * 5), current: wallet.earned, can: !claimed && wallet.earned >= target, reason: claimed ? "此档已从原豪礼或本窗口领取。" : wallet.earned >= target ? "已达到累计任务积分，可领取。" : "需继续领取本地任务积分。" }; }) as [LuxuryTier, LuxuryTier, LuxuryTier];
  return { version: 1, kind: "forthright-native", rulesVersion: 1, catalogVersion: "forthright-material-v1", day: t.day, serverNow: ctx.now.toISOString(), stateToken: stateToken(root, s, ctx, wallet),
    currency: "local-task-points", points: wallet.points, taskEarned: wallet.earned, dailyActionsRemaining: remaining,
    pages: { luxury: { index: 0, title: "累计任务礼", tiers }, wheel: { index: 1, title: "任务钥匙轮盘", keyEarned, keySpent: s.wheel.keySpent, keyAvailable,
      keyTaskPoints: 20, maxKeys: 30, round: s.wheel.round, allRoundsComplete: s.wheel.allRoundsComplete,
      slots: Array.from({ length: 10 }, (_, index) => { const prizeId = s.wheel.round * 100 + index + 1, drawn = s.wheel.drawn[s.wheel.round - 1].includes(prizeId); return { index, prizeId, reward: wheelReward(s.wheel.round, index), drawn, probabilityNumerator: drawn ? 0 as const : 1 as const, probabilityDenominator: 10 - s.wheel.drawn[s.wheel.round - 1].length }; }),
      drawnPrizeIds: [...s.wheel.drawn[s.wheel.round - 1]], canDraw, reason: canDraw ? "每20累计任务积分解锁1把永久钥匙；当前轮剩余格等概率且不放回。" : "需可用钥匙及今日玩法次数；永久最多30次。" },
      groups: { index: 2, title: "三人积分拼团", cycle: t.day, round: t.groupRound, offers: groupOffers,
        createdOrders: allGroups.filter(g => known.get(g.code)!.creatorId === actor), joinedOrders: allGroups.filter(g => s.joinedGroupCodes.includes(g.code)), coupons,
        inspected: ctx.forthrightInspectCode ? allGroups.find(g => g.code === ctx.forthrightInspectCode) ?? null : null,
        pendingGroupLimit: 1, groupMinutes: 30, globalStock: "not-ported-personal-limits" },
      shop: { index: 3, title: "积分分期商店", cycle: t.day, round: t.shopRound, phase: t.phase, phaseStartsAt: t.phaseStart, phaseEndsAt: t.phaseEnd,
        offers: shopOffers, unsettledOrders: orderViews.filter(o => ["deposit-paid", "expired-unsettled", "refund-due"].includes(o.status)), globalStock: "not-ported-personal-limits" } },
    rules: { source: "explicit-local-rules", description: ["全部支付使用本地任务积分，不接真实付款；物品均为本地普通材料。", "累计任务礼沿用原luxury领取键，不能从两个入口重复领取。", "钥匙、五折/六折券是本活动永久凭证；每轮不放回等概率，原私服权重未采用。", "拼团仅限真实角色，满3人后邮件交付并返5%差额；成员退出只退本人，团长可取消整团。", "过期不在GET自动退款，需成员显式结算；退款/返差额只增加余额，不增加earned，也不减少已发生gross消费。", "全服库存、真实付款、跨服邀请与全服公告未移植；公开选项仅控制本地团列表。"] },
    unavailable: [{ feature: "original-payment", reason: "使用本地任务积分。" }, { feature: "original-global-stock", reason: "使用明确的每角色每日限购。" }, { feature: "original-cross-server-invites", reason: "仅支持本地真实角色与订单码。" }, { feature: "original-broadcast", reason: "仅提供本地公开团列表。" }, { feature: "original-unverified-economy", reason: "原表所有奖励均为11906×1，无法证明真实奖池与价格；采用本地普通材料规则。" }] };
}

function requestUUID(ctx: ActivityContext) { need(typeof ctx.requestId === "string" && UUID.test(ctx.requestId), "缺少服务端请求编号。"); return ctx.requestId; }
function nextSequence(s: PrivateState) { need(s.nextSequence < MAX, "活动订单编号已满，请保留存档。"); return s.nextSequence++; }
function once(root: ActivityState, key: string) { need(!root.claims.includes(key), "这份活动奖励已经领取。"); root.claims.push(key); }
function normalized(root: ActivityState, ctx: ActivityContext): ActivityState {
  need(root.version === 1, "活动存档版本不兼容。");
  const r = structuredClone(root); if (r.day !== dayOf(ctx.now)) { r.day = dayOf(ctx.now); r.daily = {}; } return r;
}
function consumeCoupon(s: PrivateState, key: null | "six-fold" | "five-fold", reservation?: string) {
  if (!key) return;
  if (reservation) { need(s.coupons[key].reservations[reservation] === 1, "优惠券预留已失效。"); delete s.coupons[key].reservations[reservation]; }
  else need(couponAvailable(s, key) > 0, "优惠券不足。");
  s.coupons[key].consumed++;
}
function clearReservation(s: PrivateState, key: string, code: string, fulfilled: boolean) {
  const p = purchase(s, key); need(p.reservedCodes.includes(code), "订单预留记录不一致。"); p.reservedCodes = p.reservedCodes.filter(x => x !== code); if (fulfilled) p.fulfilled++;
}
export interface ForthrightSingleResult { state: PrivateState; cost: number; credited: number; rewards: ActivityReward[]; effects: Effect[]; claimKeys: string[]; notification?: string; message: string }
export function advanceForthrightNative(root: ActivityState, action: ActivityAction, ctx: ActivityContext, wallet: ActivityWallet, rng: () => number): ForthrightSingleResult {
  const a = validateForthrightNativeAction(action), s = readForthrightNativeState(root.games.forthrightNativeV1), v = viewForthrightNative(root, ctx, wallet), t = timing(ctx.now);
  need(integer(ctx.characterId, 1), "缺少已认证角色。");
  let cost = 0, credited = 0, rewards: Reward[] = [], effects: Effect[] = [], claimKeys: string[] = [], notification: string | undefined;
  if (["claim", "draw", "buy-alone", "deposit", "buy-full-price"].includes(a.type)) need(a.choice === v.stateToken, "活动状态已变化，请刷新后重试。");
  if (a.type === "claim") {
    const row = v.pages.luxury.tiers[a.tier - 1]; need(row.can, row.reason); rewards = [row.reward]; claimKeys = [row.claimKey]; effects = [{ type: "claimed", tier: a.tier, claimKey: row.claimKey, rewards }];
  } else if (a.type === "draw") {
    need(v.pages.wheel.canDraw, v.pages.wheel.reason); const remaining = v.pages.wheel.slots.filter(x => !x.drawn), random = rng();
    need(Number.isFinite(random) && random >= 0 && random < 1, "随机源异常，请重试。");
    const chosen = remaining[Math.floor(random * remaining.length)], round = s.wheel.round;
    s.wheel.drawn[round - 1].push(chosen.prizeId); s.wheel.keySpent++;
    if (chosen.reward.kind === "coupon") s.coupons[chosen.reward.coupon].issued++;
    if (s.wheel.drawn[round - 1].length === 10) { if (round < 3) s.wheel.round = (round + 1) as 2 | 3; else s.wheel.allRoundsComplete = true; }
    rewards = [chosen.reward]; claimKeys = [`forthright:draw:${round}:${chosen.prizeId}`];
    effects = [{ type: "drawn", round, prizeId: chosen.prizeId, index: chosen.index, rewards, nextRound: s.wheel.round, allRoundsComplete: s.wheel.allRoundsComplete }];
  } else if (a.type === "buy-alone") {
    const row = v.pages.groups.offers[a.index], quote = row.quotes[a.tier]; need(quote.can, quote.reason);
    cost = a.tier === 0 ? row.listPoints : quote.cost; need(wallet.points >= cost, "本地活动积分不足。"); consumeCoupon(s, quote.coupon);
    purchase(s, purchaseKey("g", t.day, row.catalogId)).fulfilled++; rewards = [row.reward]; claimKeys = [`forthright:direct:${requestUUID(ctx)}`];
    effects = [{ type: "bought-alone", catalogId: row.catalogId, code: null, cost, rewards }];
  } else if (a.type === "deposit" || a.type === "buy-full-price") {
    const row = v.pages.shop.offers[a.index], full = a.type === "buy-full-price"; need(full ? row.canBuyFullPrice : row.canDeposit, row.reason);
    const sequence = nextSequence(s), id = requestUUID(ctx), code = codeOf("o", ctx.characterId, sequence), p = purchase(s, purchaseKey("s", t.day, row.catalogId));
    const o: PrivateOrder = { id, sequence, code, revision: 0, ownerId: ctx.characterId, cycle: t.day, catalogId: row.catalogId, row: a.index, round: row.round,
      createdAt: ctx.now.toISOString(), balanceStartsAt: t.balanceStart, balanceEndsAt: t.balanceEnd, status: full ? "full-paid" : "deposit-paid",
      depositPoints: full ? row.fullPoints : row.depositPoints, balancePoints: full ? 0 : row.balancePoints, credited: 0, refundDue: 0, reward: row.reward,
      rewardMailed: full, terminalClaimKey: full ? `forthright:order:${id}` : null };
    s.orders[String(sequence)] = o; cost = o.depositPoints;
    if (full) { p.fulfilled++; rewards = [row.reward]; claimKeys = [o.terminalClaimKey!]; } else p.reservedCodes.push(code);
    effects = [{ type: full ? "full-paid" : "deposited", catalogId: row.catalogId, code, cost, rewards }];
  } else if (a.type === "pay-balance" || a.type === "settle-order") {
    const { ownerId, sequence } = decodeForthrightCode(forthrightEntityCode(a.choice), "o"); need(ownerId === ctx.characterId, "这不是当前角色的订单。");
    const o = s.orders[String(sequence)]; need(o && a.choice === orderToken(root, s, ctx, wallet, o), "订单状态已变化，请刷新后重试。");
    const view = orderProjection(root, s, ctx, wallet, o); need(o.revision < MAX, "订单版本已满。");
    if (a.type === "pay-balance") {
      need(view.canPayBalance, view.reason); cost = o.balancePoints; rewards = [o.reward]; o.status = "balance-paid"; o.rewardMailed = true; o.terminalClaimKey = `forthright:order:${o.id}`; claimKeys = [o.terminalClaimKey];
      clearReservation(s, purchaseKey("s", o.cycle, o.catalogId), o.code, true);
      effects = [{ type: "balance-paid", catalogId: o.catalogId, code: o.code, cost, rewards }];
    } else {
      need(view.canSettle, view.reason);
      if (o.status === "deposit-paid") { o.status = "cancelled"; o.refundDue = o.depositPoints; clearReservation(s, purchaseKey("s", o.cycle, o.catalogId), o.code, false); }
      credited = Math.min(o.refundDue, MAX - wallet.points); need(credited > 0 || o.credited === 0 && o.revision === 0, "钱包已满，消费部分积分后再结清退款。");
      o.credited += credited; o.refundDue -= credited; notification = `本地分期订单${o.code}已取消，退回${credited}积分，待退${o.refundDue}积分。`;
      effects = [{ type: "order-settled", code: o.code, credited, creditDue: o.refundDue, rewards: [] }];
    }
    o.revision++;
  } else throw new ActivityError("此操作需要拼团事务或只读查询入口。");
  return { state: s, cost, credited, rewards: forthrightItems(rewards), effects, claimKeys, ...(notification ? { notification } : {}), message: notification ?? "本地豪礼活动已结算；奖励在提交时发放，动画不再发奖。" };
}

export interface ForthrightRole { characterId: number; nickname: string; root: ActivityState; wallet: ActivityWallet }
export interface ForthrightRoleChange extends ForthrightRole { cost: number; credited: number; rewards: ActivityReward[]; notification?: string }
export interface ForthrightGroupResult { roles: ForthrightRoleChange[]; effects: Effect[]; message: string; group: PrivateGroup }
/** Pure multi-role transition. Caller locks the complete historical member set before invoking it. */
export function advanceForthrightGroup(input: ForthrightRole[], action: ActivityAction, ctx: ActivityContext): ForthrightGroupResult {
  const a = validateForthrightNativeAction(action), actorId = ctx.characterId; need(integer(actorId, 1), "缺少已认证角色。");
  need(["open-group", "join-group", "leave-group", "cancel-group", "settle-group"].includes(a.type), "拼团操作无效。");
  const roles = new Map(input.map(r => [r.characterId, { ...r, root: normalized(r.root, ctx), cost: 0, credited: 0, rewards: [] as ActivityReward[] } as ForthrightRoleChange]));
  need(roles.size === input.length && roles.has(actorId), "拼团角色锁集合无效。");
  const owners = new Map([...roles].map(([id, r]) => [id, readForthrightNativeState(r.root.games.forthrightNativeV1)]));
  const actor = roles.get(actorId)!, actorState = owners.get(actorId)!, actorCtx = { ...ctx, characterId: actorId };
  let g: PrivateGroup, creator: ForthrightRoleChange, creatorState: PrivateState, effectType: Effect["type"] = "group-opened";
  const touched = new Set<number>([actorId]);
  const now = ctx.now.getTime(), t = timing(ctx.now);
  const credit = (member: PrivateGroup["members"][number]) => {
    const r = roles.get(member.characterId); need(r, "拼团成员锁集合已变化。");
    const n = Math.min(member.creditDue, MAX - r.wallet.points + r.cost - r.credited);
    member.creditDue -= n; member.credited += n; r.credited += n; touched.add(r.characterId);
    if (n > 0) r.notification = `本地拼团${g.code}退回/返还${n}积分，待退${member.creditDue}积分。`;
  };
  if (a.type === "open-group") {
    const v = viewForthrightNative(actor.root, actorCtx, actor.wallet), row = v.pages.groups.offers[a.index], quote = row.quotes[a.tier];
    need(a.choice === v.stateToken, "活动状态已变化，请刷新后重试。"); need(quote.can, quote.reason);
    need(!pendingGroup(actorState) && existingPurchase(actorState, `attempt:${t.day}`).attempts < 3, "每次只能有1个待成团，每日最多发起或加入3次。");
    const sequence = nextSequence(actorState), code = codeOf("g", actorId, sequence);
    g = { id: requestUUID(ctx), sequence, code, revision: 0, creatorId: actorId, cycle: t.day, catalogId: row.catalogId, row: a.index, round: row.round,
      createdAt: ctx.now.toISOString(), expiresAt: new Date(now + 1800000).toISOString(), publicListing: a.marked, status: "pending", coupon: quote.coupon,
      unitPrepaid: quote.cost, unitSuccessCost: quote.successCost, reward: row.reward,
      members: [{ characterId: actorId, nickname: actor.nickname, status: "active", joinedAt: ctx.now.toISOString(), paid: quote.cost, credited: 0, creditDue: 0, rewardMailed: false, terminalClaimKey: null }] };
    creator = actor; creatorState = actorState; creatorState.createdGroups[String(sequence)] = g;
    actor.cost = quote.cost; purchase(actorState, purchaseKey("g", g.cycle, g.catalogId)).reservedCodes.push(code); purchase(actorState, `attempt:${t.day}`).attempts++;
    if (quote.coupon) { need(couponAvailable(actorState, quote.coupon) > 0, "优惠券不足。"); actorState.coupons[quote.coupon].reservations[code] = 1; }
  } else {
    const { ownerId, sequence } = decodeForthrightCode(forthrightEntityCode(a.choice));
    creator = roles.get(ownerId)!; creatorState = owners.get(ownerId)!; need(creator && creatorState, "未锁定拼团团长。");
    g = creatorState.createdGroups[String(sequence)]; need(g && g.code === forthrightEntityCode(a.choice), "拼团不存在。");
    need(g.members.every(m => roles.has(m.characterId)), "拼团成员锁集合已变化。");
    need(a.choice === groupToken(actor.root, actorState, actorCtx, actor.wallet, g), "拼团状态已变化，请刷新后重试。");
    need(g.revision < MAX, "拼团版本已满。"); touched.add(ownerId);
    const view = groupProjection(actor.root, actorState, actorCtx, actor.wallet, g), member = g.members.find(m => m.characterId === actorId);
    if (a.type === "join-group") {
      need(view.canJoin, view.reason); actor.cost = g.unitPrepaid;
      g.members.push({ characterId: actorId, nickname: actor.nickname, status: "active", joinedAt: ctx.now.toISOString(), paid: g.unitPrepaid, credited: 0, creditDue: 0, rewardMailed: false, terminalClaimKey: null });
      purchase(actorState, purchaseKey("g", g.cycle, g.catalogId)).reservedCodes.push(g.code); purchase(actorState, `attempt:${t.day}`).attempts++;
      actorState.joinedGroupCodes.push(g.code); effectType = "group-joined";
      const active = g.members.filter(m => m.status === "active");
      if (active.length === 3) {
        g.status = "completed"; effectType = "group-completed"; consumeCoupon(creatorState, g.coupon, g.code);
        for (const m of active) {
          const r = roles.get(m.characterId)!, s = owners.get(m.characterId)!; need(r, "未锁定全部成团成员。");
          const claimKey = `forthright:group:${g.id}:${m.characterId}`; once(r.root, claimKey); m.terminalClaimKey = claimKey; m.rewardMailed = true;
          r.rewards = forthrightItems([g.reward]); clearReservation(s, purchaseKey("g", g.cycle, g.catalogId), g.code, true); m.creditDue = m.paid - g.unitSuccessCost; credit(m); touched.add(m.characterId);
        }
      }
    } else if (a.type === "leave-group") {
      need(view.canLeave && member, view.reason); member.status = "left"; member.creditDue = member.paid - member.credited; clearReservation(actorState, purchaseKey("g", g.cycle, g.catalogId), g.code, false); credit(member);
      actor.notification ??= `已退出本地拼团${g.code}；团仍继续招人，待退${member.creditDue}积分。`; effectType = "group-left";
    } else if (a.type === "cancel-group" || a.type === "settle-group") {
      need(a.type === "cancel-group" ? view.canCancel : view.canSettle, view.reason);
      const terminalize = g.status === "pending" && (a.type === "cancel-group" || now >= Date.parse(g.expiresAt));
      if (terminalize) {
        g.status = a.type === "cancel-group" ? "cancelled" : "expired";
        if (g.coupon) { need(creatorState.coupons[g.coupon].reservations[g.code] === 1, "优惠券预留记录不一致。"); delete creatorState.coupons[g.coupon].reservations[g.code]; }
        for (const m of g.members.filter(m => m.status === "active")) {
          m.creditDue = m.paid - m.credited; clearReservation(owners.get(m.characterId)!, purchaseKey("g", g.cycle, g.catalogId), g.code, false);
          touched.add(m.characterId); roles.get(m.characterId)!.notification = `本地拼团${g.code}已取消/到期，退款通过本次事务结算。`;
        }
      }
      let creditedNow = 0;
      for (const m of g.members) if (m.creditDue > 0) { const previous = m.credited; credit(m); creditedNow += m.credited - previous; }
      need(terminalize || creditedNow > 0, "钱包已满，消费部分积分后再结清退款。");
      effectType = a.type === "cancel-group" ? "group-cancelled" : "group-settled";
    }
    g.revision++;
  }
  need(actor.wallet.points >= actor.cost, "本地活动积分不足。");
  if (a.type === "open-group" || a.type === "join-group") { need(dailyRemaining(actor.root, ctx) > 0, "今日新玩法次数已达上限。"); actor.root.daily.actions = (actor.root.daily.actions ?? 0) + 1; }
  for (const id of touched) {
    const r = roles.get(id)!; r.root.games.forthrightNativeV1 = owners.get(id)!;
    r.root.history = [`${dayOf(ctx.now)} 至尊豪礼：${effectType}`, ...r.root.history].slice(0, 20);
  }
  const actorMember = g.members.find(m => m.characterId === actorId), rewards = actor.rewards.map(r => item(r.templateId, r.count));
  const effects: Effect[] = [{ type: effectType as "group-opened", code: g.code, cost: actor.cost, credited: actor.credited, creditDue: actorMember?.creditDue ?? 0, rewards }];
  return { roles: [...touched].map(id => roles.get(id)!), effects, group: g, message: "本地拼团已原子结算；退出只退本人，动画不会再次发奖。" };
}
