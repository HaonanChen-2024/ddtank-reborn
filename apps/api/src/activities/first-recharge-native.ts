/** Original first-recharge window with explicit local task entitlements. No payment/card-item imports. */
import { createHash, randomUUID } from "node:crypto";
import { LOCAL_RULES } from "./config.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityWallet } from "./types.js";
export type Tier = 1 | 2 | 3;
export type CardKind = 1 | 2 | 3;
export type MaterialId = 11019 | 11001 | 11021 | 11002;
export interface MaterialReward { templateId: MaterialId; count: number; validDays: 0; bound: true }
export type PreviewCells = [MaterialReward | null, MaterialReward | null, MaterialReward | null,
  MaterialReward | null, MaterialReward | null, MaterialReward | null];
export type UnavailableCode = "missing-original-ui" | "missing-original-art" | "missing-reward-box-catalog"
  | "pending-shop-catalog" | "pending-card-semantics" | "missing-vip-coupons-resource"
  | "legacy-shared-owner-conflict" | "gift-transaction-not-implemented";
export interface Unavailable { feature: "original-window" | "shop" | "cards" | "gift"; code: UnavailableCode; message: string }

export interface TierView {
  tier: Tier;
  /** Tier 1 is EXACTLY first-gift, not a second native claim. */
  claimKey: "first-gift" | "first-recharge-native:tier:2" | "first-recharge-native:tier:3";
  title: string;
  qualification: { metric: "completed-board" | "task-earned" | "received-card"; current: number; target: number; met: boolean };
  entitlementStatus: "locked" | "ready" | "reserved" | "active" | "claimed" | "gifted";
  activeCardId: string | null;
  claimed: boolean;
  canClaim: boolean;
  rewards: PreviewCells;
  reason: string;
}
export interface MaterialShopRow {
  index: number;
  catalogId: string;
  kind: "material";
  name: string;
  reward: MaterialReward;
  unitPoints: number;
  quantityEditable: false;
  /** Original 13 source rows are MstType=2; preserve the fixed-quantity confirmation. */
  maxPerRequest: 1;
  period: "utc-day";
  limit: number;
  bought: number;
  remaining: number;
  canBuy: number;
}
/** A separate explicit LOCAL policy; no original item 12772 is minted or consumed. */
export interface CardDefinition {
  kind: CardKind;
  label: string;
  associatedTier: Tier;
  source: "earned-task-entitlement";
  validity: "permanent";
  unitPoints: 0;
  maxPerCharacter: 1;
  transferable: boolean;
  /** A card points at the SAME canonical tier claim, never a second reward bundle. */
  entitlement: "canonical-tier-claim";
}
export interface CardView {
  cardId: string;
  kind: CardKind;
  associatedTier: Tier;
  status: "owned" | "active" | "used" | "gifted";
  acquiredAt: string;
  expiresAt: null;
  senderName: string | null;
  canValidate: boolean;
  canUse: boolean;
  canGift: boolean;
  reason: string;
}
export interface CardsCapability {
  availability: "local-defined";
  policyVersion: 1;
  definitions: [CardDefinition, CardDefinition, CardDefinition];
  cards: CardView[];
}
export interface FirstRechargeNativeView {
  version: 1;
  kind: "first-recharge-native";
  rulesVersion: number;
  day: string;
  stateToken: string;
  currency: "local-task-points";
  points: number;
  taskEarned: number;
  tiers: [TierView, TierView, TierView];
  shop: {
    availability: "local-defined" | "unavailable";
    catalogVersion: string;
    rows: MaterialShopRow[];
    reason: string;
  };
  cards: CardsCapability;
  capabilities: { reward: boolean; materialShop: boolean; validateCard: boolean; useCard: boolean; giftCard: boolean };
  rules: { source: "explicit-local-rules"; description: string[] };
  unavailable: Unavailable[];
}

/** Exact per-action fields. Extra fields fail 400, not silently ignored. */
export type FirstRechargeNativeAction =
  | { type: "claim"; tier: Tier; choice: string }
  | { type: "buy"; index: number; count: 1; choice: string }
  | { type: "issue-card"; tier: Tier; choice: string }
  | { type: "validate-card"; cardId: string; choice: string }
  | { type: "use-card"; cardId: string; choice: string }
  | { type: "gift-card"; cardId: string; recipientName: string; choice: string };

export type FirstRechargeNativeEffect =
  | { type: "claimed"; tier: Tier; rewards: MaterialReward[]; consumedCardId: string | null }
  | { type: "bought"; index: number; catalogId: string; count: number; cost: number; points: number; rewards: MaterialReward[] }
  | { type: "card-issued"; card: CardView; reservedTier: Tier }
  | { type: "card-validated"; cardId: string; valid: boolean; reason: string }
  | { type: "card-used"; cardId: string; tier: Tier; expiresAt: null }
  | { type: "card-gifted"; cardId: string; tier: Tier; recipientName: string };
export interface FirstRechargeNativeEnvelope { requestId: string; effects: FirstRechargeNativeEffect[] }
export interface FirstRechargeNativeCommand { characterId: number; requestId: string; action: FirstRechargeNativeAction }

/** Private SAVE proposal, never send this object through HTTP. Claims remain in root claims. */
export interface FirstRechargeNativeStateV1 {
  version: 1;
  kind: "first-recharge-native";
  rulesVersion: number;
  shopDay: string;
  catalogVersion: string;
  bought: number[];
  cardPolicyVersion: 1;
  /** Fixed 3 slots, one lifecycle per tier per character, including a received card. */
  cardSlots: [SavedTaskCard | null, SavedTaskCard | null, SavedTaskCard | null];
}
export interface SavedTaskCard {
    cardId: string; kind: CardKind; associatedTier: Tier;
    status: "owned" | "active" | "used" | "gifted";
    acquiredAt: string; expiresAt: null; senderName: string | null;
    /** Server-generated immutable proof; never accept this data from a client. */
    origin: { characterId: number; issuedAt: string; metric: "completed-board" | "task-earned"; observed: number; target: number };
    /** Recipient ID private, omitted from general HTTP views. */
    giftedToCharacterId?: number;
}

export interface FirstRechargeEntitlements { claims: readonly string[]; boardCompletions: number }
export type FirstRechargeNativeState = FirstRechargeNativeStateV1;
const day = (now: Date) => now.toISOString().slice(0, 10);
const isInt = (n: unknown, min = 0, max = 2147483647): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
function need(ok: unknown, message: string, status = 400): asserts ok { if (!ok) throw new ActivityError(message, status); }
const clone = <T>(v: T): T => structuredClone(v);
export const firstRechargeNativeClaimKeys = ["first-gift", "first-recharge-native:tier:2", "first-recharge-native:tier:3"] as const;
const thresholds = [1, 200, 600] as const;
export const firstRechargeNativeLocalRules = { version: 1, cardPolicyVersion: 1, shopDailyLimit: 10,
  cardValidity: "permanent", giftHops: 1, shopQuantity: 1 } as const;
const material = (templateId: MaterialId, count: number): MaterialReward => ({ templateId, count, validDays: 0, bound: true });
export const firstRechargeNativeRewards = [
  [material(11019, 5), material(11021, 1)], [material(11019, 10), material(11001, 3)], [material(11021, 2), material(11002, 1)],
] as const;
export const firstRechargeNativeShop = LOCAL_RULES.shop.map((p, index) => ({ index, catalogId: `first-shop:${p.templateId}:${p.count}`,
  reward: material(p.templateId, p.count), unitPoints: p.price }));
const names: Record<MaterialId, string> = { 11019: "强化石1级", 11001: "朱雀石1级", 11021: "强化石2级", 11002: "朱雀石2级" };
const definitions: [CardDefinition, CardDefinition, CardDefinition] = ([1, 2, 3] as const).map(kind => ({ kind,
  label: `第${kind}档任务奖励凭证`, associatedTier: kind, source: "earned-task-entitlement", validity: "permanent", unitPoints: 0,
  maxPerCharacter: 1, transferable: true, entitlement: "canonical-tier-claim" })) as [CardDefinition, CardDefinition, CardDefinition];
const blank = (now: Date): FirstRechargeNativeState => ({ version: 1, kind: "first-recharge-native", rulesVersion: 1,
  shopDay: day(now), catalogVersion: "first-shop-v1", bought: [0, 0, 0, 0], cardPolicyVersion: 1, cardSlots: [null, null, null] });
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function ownQualification(tier: Tier, info: FirstRechargeEntitlements, wallet: ActivityWallet) {
  return (tier === 1 ? info.boardCompletions : wallet.earned) >= thresholds[tier - 1];
}
export function readFirstRechargeNativeState(raw: unknown, now: Date, info: FirstRechargeEntitlements): FirstRechargeNativeState {
  if (raw === undefined) return blank(now);
  const bad = "首充任务凭证存档不兼容，请保留存档并联系维护者。";
  need(object(raw) && raw.version === 1 && raw.kind === "first-recharge-native" && raw.rulesVersion === 1 && raw.cardPolicyVersion === 1, bad, 503);
  need(typeof raw.shopDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.shopDay) && raw.shopDay <= day(now)
    && raw.catalogVersion === "first-shop-v1" && Array.isArray(raw.bought) && raw.bought.length === 4
    && raw.bought.every(n => isInt(n, 0, 10)) && Array.isArray(raw.cardSlots) && raw.cardSlots.length === 3, bad, 503);
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const card = raw.cardSlots[i]; if (card === null) continue;
    need(object(card) && uuid(card.cardId) && !ids.has(card.cardId) && card.kind === i + 1 && card.associatedTier === i + 1
      && ["owned", "active", "used", "gifted"].includes(String(card.status)) && card.expiresAt === null
      && typeof card.acquiredAt === "string" && Number.isFinite(Date.parse(card.acquiredAt))
      && (card.senderName === null || typeof card.senderName === "string" && card.senderName.length > 0 && card.senderName.length <= 64)
      && object(card.origin) && isInt(card.origin.characterId, 1) && typeof card.origin.issuedAt === "string"
      && Number.isFinite(Date.parse(card.origin.issuedAt)) && card.acquiredAt >= card.origin.issuedAt
      && card.origin.metric === (i === 0 ? "completed-board" : "task-earned") && card.origin.target === thresholds[i]
      && isInt(card.origin.observed, thresholds[i]) && (card.status === "gifted"
        ? isInt(card.giftedToCharacterId, 1) && card.giftedToCharacterId !== card.origin.characterId && card.senderName === null
        : card.giftedToCharacterId === undefined), bad, 503);
    need(info.claims.includes(firstRechargeNativeClaimKeys[i]) === ["used", "gifted"].includes(String(card.status)), bad, 503);
    ids.add(card.cardId);
  }
  // Preserve unknown saved fields; only the UTC-day shop counters roll over.
  const state = clone(raw) as unknown as FirstRechargeNativeState;
  if (state.shopDay !== day(now)) { state.shopDay = day(now); state.bought = [0, 0, 0, 0]; }
  return state;
}
function token(state: FirstRechargeNativeState, ctx: ActivityContext, wallet: ActivityWallet, info: FirstRechargeEntitlements, dailyRemaining: number) {
  return `${day(ctx.now)}.${createHash("sha256").update(canonical({ state, wallet, claims: info.claims, boardCompletions: info.boardCompletions,
    dailyRemaining, rules: firstRechargeNativeLocalRules, thresholds, rewards: firstRechargeNativeRewards, shop: firstRechargeNativeShop, definitions })).digest("base64url")}`;
}
function cardView(card: SavedTaskCard, ctx: ActivityContext): CardView {
  const live = card.status === "owned" || card.status === "active";
  return { cardId: card.cardId, kind: card.kind, associatedTier: card.associatedTier, status: card.status, acquiredAt: card.acquiredAt,
    expiresAt: null, senderName: card.senderName, canValidate: true, canUse: card.status === "owned",
    canGift: card.status === "owned" && card.senderName === null && card.origin.characterId === ctx.characterId,
    reason: live ? card.status === "active" ? "凭证已激活，可领取同一档奖励。" : "可激活领取；本人发行的未激活凭证也可赠送一次。"
      : card.status === "used" ? "凭证已消费，奖励不会重复发放。" : "奖励权利已赠送，本角色不再领取。" };
}
export function viewFirstRechargeNative(raw: unknown, ctx: ActivityContext, wallet: ActivityWallet,
  info: FirstRechargeEntitlements, dailyRemaining: number = LOCAL_RULES.maxDailyActions): FirstRechargeNativeView {
  const state = readFirstRechargeNativeState(raw, ctx.now, info);
  const tiers = ([1, 2, 3] as const).map(tier => {
    const i = tier - 1, card = state.cardSlots[i], claimed = info.claims.includes(firstRechargeNativeClaimKeys[i]);
    const received = card?.status === "active" && card.senderName !== null;
    const met = received || ownQualification(tier, info, wallet);
    const current = received ? 1 : tier === 1 ? info.boardCompletions : wallet.earned;
    const target = received ? 1 : thresholds[i];
    const status = card?.status === "gifted" ? "gifted" : claimed ? "claimed" : card?.status === "active" ? "active"
      : card?.status === "owned" ? "reserved" : met ? "ready" : "locked";
    const rewards = [...clone(firstRechargeNativeRewards[i]), null, null, null, null] as PreviewCells;
    return { tier, claimKey: firstRechargeNativeClaimKeys[i], title: `第${tier}档任务礼`, qualification: {
      metric: received ? "received-card" : tier === 1 ? "completed-board" : "task-earned", current: Math.min(current, target), target, met },
      entitlementStatus: status, activeCardId: card?.status === "active" ? card.cardId : null, claimed,
      canClaim: !claimed && (card ? card.status === "active" : met), rewards,
      reason: status === "gifted" ? "已赠送本档奖励权利，本角色不能重复领取。" : claimed ? "本档已领取。"
        : status === "reserved" ? "权利已保存在任务凭证中，请先激活或赠送。" : met ? "可直接领奖，也可将任务权利保存为凭证。"
          : tier === 1 ? "完成一次扫雷阶段奖励或整局配对。" : `累计任务积分达到${target}后解锁。` };
  }) as [TierView, TierView, TierView];
  return { version: 1, kind: "first-recharge-native", rulesVersion: 1, day: day(ctx.now), stateToken: token(state, ctx, wallet, info, dailyRemaining),
    currency: "local-task-points", points: wallet.points, taskEarned: wallet.earned, tiers,
    shop: { availability: "local-defined", catalogVersion: state.catalogVersion, reason: "本地普通材料目录；每次固定购买一包。",
      rows: firstRechargeNativeShop.map(row => { const remaining = 10 - state.bought[row.index]; return { ...clone(row), kind: "material" as const,
        name: names[row.reward.templateId], quantityEditable: false as const, maxPerRequest: 1 as const, period: "utc-day" as const,
        limit: 10, bought: state.bought[row.index], remaining, canBuy: dailyRemaining > 0 && wallet.points >= row.unitPoints ? Math.min(1, remaining) : 0 }; }) },
    cards: { availability: "local-defined", policyVersion: 1, definitions: clone(definitions), cards: state.cardSlots.filter((c): c is SavedTaskCard => c !== null).map(c => cardView(c, ctx)) },
    capabilities: { reward: true, materialShop: true, validateCard: true, useCard: true, giftCard: true },
    rules: { source: "explicit-local-rules", description: ["三档任务礼每角色各一次，第1档与旧新手任务礼共用领取记录。",
      "商城使用活动积分，每包每日限购10次；不增加累计任务积分，不接真实付款。",
      "凭证保留同一份任务奖励权利，长期有效；本人发行的未激活凭证可赠送一次，受赠凭证不能转赠。",
      "激活不发物品；领奖在服务端一次寄往邮箱，凭证不额外赠送第二包。"] }, unavailable: [] };
}
export function validateFirstRechargeNativeAction(action: ActivityAction): FirstRechargeNativeAction {
  const fields: Record<string, string[]> = { claim: ["type", "tier", "choice"], buy: ["type", "index", "count", "choice"],
    "issue-card": ["type", "tier", "choice"], "validate-card": ["type", "cardId", "choice"],
    "use-card": ["type", "cardId", "choice"], "gift-card": ["type", "cardId", "recipientName", "choice"] };
  const allowed = fields[action.type];
  need(allowed && Object.keys(action).length === allowed.length && Object.keys(action).every(k => allowed.includes(k)), "任务礼操作字段无效。");
  need(typeof action.choice === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(action.choice), "请刷新任务礼后重试。", 409);
  if (["claim", "issue-card"].includes(action.type)) need(isInt(action.tier, 1, 3), "任务礼档位无效。");
  if (action.type === "buy") need(isInt(action.index, 0, 3) && action.count === 1, "原商城每次固定购买一包。");
  if (action.type.endsWith("card") && action.type !== "issue-card") need(uuid(action.cardId), "任务凭证编号无效。");
  if (action.type === "gift-card") need(typeof action.recipientName === "string" && action.recipientName === action.recipientName.trim()
    && action.recipientName.length > 0 && action.recipientName.length <= 64 && !/[\u0000-\u001f\u007f]/.test(action.recipientName), "收件角色昵称无效。");
  return action as FirstRechargeNativeAction;
}
export function claimFirstRechargeTier(raw: unknown, tier: Tier, ctx: ActivityContext, wallet: ActivityWallet, info: FirstRechargeEntitlements, legacy = false) {
  const state = readFirstRechargeNativeState(raw, ctx.now, info), i = tier - 1, key = firstRechargeNativeClaimKeys[i], card = state.cardSlots[i];
  need(!info.claims.includes(key), "本档奖励已经领取或赠送。", legacy ? 400 : 409);
  need(!card || card.status === "active", "权利已保存在任务凭证中，请先激活。", 409);
  need(card?.status === "active" || ownQualification(tier, info, wallet), "本档任务资格尚未完成。", legacy ? 400 : 409);
  if (card) card.status = "used";
  return { state, claimKey: key, rewards: [...clone(firstRechargeNativeRewards[i])],
    effect: { type: "claimed" as const, tier, rewards: [...clone(firstRechargeNativeRewards[i])], consumedCardId: card?.cardId ?? null } };
}
export function advanceFirstRechargeNative(raw: unknown, action: ActivityAction, ctx: ActivityContext, wallet: ActivityWallet,
  info: FirstRechargeEntitlements, dailyRemaining: number = LOCAL_RULES.maxDailyActions, nextId: () => string = randomUUID) {
  const a = validateFirstRechargeNativeAction(action), state = readFirstRechargeNativeState(raw, ctx.now, info);
  need(a.choice === token(state, ctx, wallet, info, dailyRemaining), "任务礼状态已变化，请刷新后重试。", 409);
  let claimKey: string | undefined, cost = 0, purchases = 0, rewards: ActivityReward[] = [];
  const effects: FirstRechargeNativeEffect[] = [];
  if (a.type === "claim") {
    const r = claimFirstRechargeTier(state, a.tier, ctx, wallet, info); claimKey = r.claimKey; rewards = r.rewards;
    state.cardSlots = r.state.cardSlots; effects.push(r.effect);
  } else if (a.type === "buy") {
    const row = firstRechargeNativeShop[a.index];
    need(dailyRemaining > 0 && state.bought[a.index] < 10, "今日购买次数已用完。", 409);
    need(wallet.points >= row.unitPoints, "活动积分不足。", 409);
    cost = row.unitPoints; purchases = 1; state.bought[a.index]++; rewards = [clone(row.reward)];
    effects.push({ type: "bought", index: a.index, catalogId: row.catalogId, count: 1, cost, points: wallet.points - cost, rewards: [clone(row.reward)] });
  } else if (a.type === "issue-card") {
    const i = a.tier - 1;
    need(!info.claims.includes(firstRechargeNativeClaimKeys[i]) && state.cardSlots[i] === null, "本档已经领取、保留或转出，不能重复发行。", 409);
    need(ownQualification(a.tier, info, wallet), "请先完成本档个人任务资格。", 409);
    need(isInt(ctx.characterId, 1), "任务凭证角色上下文无效。", 503);
    const id = nextId(); need(uuid(id), "任务凭证编号生成失败。", 503);
    const card: SavedTaskCard = { cardId: id, kind: a.tier, associatedTier: a.tier, status: "owned", acquiredAt: ctx.now.toISOString(),
      expiresAt: null, senderName: null, origin: { characterId: ctx.characterId, issuedAt: ctx.now.toISOString(),
        metric: a.tier === 1 ? "completed-board" : "task-earned", observed: a.tier === 1 ? info.boardCompletions : wallet.earned, target: thresholds[i] } };
    state.cardSlots[i] = card; effects.push({ type: "card-issued", card: cardView(card, ctx), reservedTier: a.tier });
  } else if (a.type === "gift-card") throw new ActivityError("赠送必须通过双角色原子结算。", 503);
  else {
    const card = state.cardSlots.find(c => c?.cardId === a.cardId);
    need(card, "本角色没有这张任务凭证。", 409);
    if (a.type === "validate-card") effects.push({ type: "card-validated", cardId: card.cardId,
      valid: card.status === "owned" || card.status === "active", reason: cardView(card, ctx).reason });
    else { need(card.status === "owned", "凭证已经激活、使用或转出。", 409); card.status = "active";
      effects.push({ type: "card-used", cardId: card.cardId, tier: card.associatedTier, expiresAt: null }); }
  }
  return { state, claimKey, cost, purchases, rewards, effects };
}
export function transferFirstRechargeCard(sourceRaw: unknown, targetRaw: unknown, action: ActivityAction,
  sourceCtx: ActivityContext, targetCtx: ActivityContext, sourceWallet: ActivityWallet, sourceInfo: FirstRechargeEntitlements,
  targetInfo: FirstRechargeEntitlements, senderName: string, recipientName: string, dailyRemaining: number) {
  const a = validateFirstRechargeNativeAction(action); need(a.type === "gift-card", "赠送操作无效。");
  const source = readFirstRechargeNativeState(sourceRaw, sourceCtx.now, sourceInfo), target = readFirstRechargeNativeState(targetRaw, sourceCtx.now, targetInfo);
  need(a.choice === token(source, sourceCtx, sourceWallet, sourceInfo, dailyRemaining), "任务凭证状态已变化，请刷新后重试。", 409);
  need(isInt(sourceCtx.characterId, 1) && isInt(targetCtx.characterId, 1) && sourceCtx.characterId !== targetCtx.characterId, "收件角色无效。", 409);
  const card = source.cardSlots.find(c => c?.cardId === a.cardId);
  need(card && card.status === "owned" && card.senderName === null && card.origin.characterId === sourceCtx.characterId, "仅本人发行且未激活的凭证可赠送一次。", 409);
  const i = card.associatedTier - 1, key = firstRechargeNativeClaimKeys[i];
  need(!targetInfo.claims.includes(key) && target.cardSlots[i] === null, "收件角色本档已领取、已有凭证或已转出。", 409);
  target.cardSlots[i] = { ...clone(card), acquiredAt: sourceCtx.now.toISOString(), senderName };
  card.status = "gifted"; card.giftedToCharacterId = targetCtx.characterId;
  return { source, target, claimKey: key,
    effect: { type: "card-gifted" as const, cardId: card.cardId, tier: card.associatedTier, recipientName } };
}
