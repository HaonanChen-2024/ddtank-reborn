import type { ActivityAction, ActivityRequest, ActivityResponse } from "./activities";
import { ActivityRequestError } from "./activities";
import { attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost } from "./native-activity-host";

export type NativeCaveLootEnvelope = NativeActivityEnvelope;
export interface NativeCaveLootPlayer {
  workshopCaveLootAcceptSnapshot?: (envelope: NativeCaveLootEnvelope) => unknown;
  workshopCaveLootRejectRequest?: (envelope: NativeCaveLootEnvelope) => unknown;
}
export interface NativeCaveLootCallbackTarget {
  workshopCaveLootRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopCaveLootRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopCaveLootReport?: (status: unknown) => void;
}
export interface NativeCaveLootHostOptions {
  player: NativeCaveLootPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeCaveLootCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeCaveLootCallbackTarget {
  workshopShowCaveLoot?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (v: unknown, min = 0, max = 2_147_483_647): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= 4096;
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const token = (v: unknown): v is string => typeof v === "string" && v.length === 54 && day(v.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const actions: Record<string, string[]> = {
  draw: ["tier", "index", "count"], "take-item": ["tier", "index", "count"], "recycle-item": ["tier", "index", "count"],
  "take-all": ["tier"], "recycle-all": ["tier"], "take-legacy": [], "recycle-legacy": [], progress: ["tier"], exchange: [], buy: ["tier", "index", "count"],
};
function parseAction(v: unknown): ActivityAction | null {
  if (!nativeObject(v) || typeof v.type !== "string" || !Object.hasOwn(actions, v.type) || !token(v.choice)
    || !exact(v, ["type", "choice", ...actions[v.type]!])) return null;
  if ("tier" in v && !integer(v.tier, 1, v.type === "progress" ? 11 : 2)) return null;
  if ("index" in v && !integer(v.index, 0, v.type === "draw" ? 2 : 3)) return null;
  if ("count" in v && !integer(v.count, 1, v.type === "draw" ? Math.floor(5 / [1, 3, 5][Number(v.index)]!) : v.type === "buy" ? 5 : 1000)) return null;
  return { type: v.type, choice: v.choice, ...("tier" in v ? { tier: Number(v.tier) } : {}),
    ...("index" in v ? { index: Number(v.index) } : {}), ...("count" in v ? { count: Number(v.count) } : {}) };
}
const fail = (): never => { throw new ActivityRequestError("原版矿洞寻宝公开数据不完整，请重试原操作。", true); };
const record = (v: unknown): Record<string, unknown> => nativeObject(v) ? v : fail();
const array = (v: unknown, min = 0, max = 100): unknown[] => Array.isArray(v) && v.length >= min && v.length <= max ? v : fail();
const materials = [11019, 11001, 11021, 11002], weights = [55, 25, 15, 5], prices = [10, 12, 15, 20];
const privateKeys = new Set(["games", "native", "accountId", "accountName", "sessionId", "signature", "rng", "seed", "nextRoll", "nextPrize", "bag", "choices", "claimedExtraProgress", "shopBought"]);
function publicTree(v: unknown, depth = 0): void {
  if (depth > 10) fail();
  if (Array.isArray(v)) { if (v.length > 100) fail(); v.forEach(x => publicTree(x, depth + 1)); }
  else if (nativeObject(v)) for (const [key, value] of Object.entries(v)) { if (privateKeys.has(key) || key === "claimed" && typeof value !== "boolean") fail(); publicTree(value, depth + 1); }
}
function reward(v: unknown, templateId?: number, itemCount?: number) {
  const r = record(v);
  if (!integer(r.templateId) || !materials.includes(r.templateId) || !integer(r.itemCount, 1) || !text(r.name, 1)
    || r.bound !== true || r.validDays !== 0 || templateId !== undefined && r.templateId !== templateId
    || itemCount !== undefined && r.itemCount !== itemCount) fail();
  return r;
}
const rewards = (v: unknown, min = 0, max = 30) => array(v, min, max).map(x => reward(x));
const amount = (rows: Record<string, unknown>[]) => rows.reduce((sum, r) => sum + Number(r.itemCount), 0);
const progressRewards = [[11019, 2], [11019, 4], [11019, 6], [11019, 8], [11019, 10], [11019, 12], [11001, 2], [11001, 4], [11021, 2], [11021, 4], [11002, 2]];
const thresholds = [10, 20, 30, 50, 100, 200, 10, 25, 50, 100, 200], requiredPercent = [0, 0, 0, 0, 0, 0, 5, 12, 25, 50, 100];
function validatePublic(snapshot: ActivityResponse, action?: ActivityAction) {
  const p = record(snapshot.nativeCaveLoot); publicTree(p);
  const rules = record(p.localRules);
  if (p.version !== 1 || p.kind !== "caveloot-native" || !day(p.day) || p.day !== snapshot.day || typeof p.started !== "boolean"
    || rules.version !== 1 || !text(rules.description, 1)) fail();
  if (p.available === false) {
    if (!exact(p, ["version", "kind", "available", "day", "started", "stateToken", "reason", "localRules"])
      || p.stateToken !== null || !text(p.reason, 1) || action && !snapshot.replayed) fail();
    return;
  }
  if (p.available !== true || p.catalogVersion !== "caveloot-local-v1" || !token(p.stateToken) || !p.stateToken.startsWith(p.day + ".")
    || !integer(p.points) || p.points !== snapshot.points || !integer(p.actionsRemaining, 0, 500) || !integer(p.freeRemaining, 0, 3)
    || p.bagCapacity !== 30 || !integer(p.bagSlotsUsed, 0, 30) || !integer(p.draws) || !integer(p.progressScore)
    || !integer(p.fragments) || !integer(p.pityRemaining, 1, 10) || !integer(p.personalProgressPercent, 0, 100)) fail();
  const types = array(p.types, 2, 2).map(record);
  types.forEach((t, i) => {
    if (t.tier !== i + 1 || !text(t.label, 1) || !integer(t.newDraws, 0, 1_000_000_000) || !integer(t.coins)
      || typeof t.canTakeAll !== "boolean" || typeof t.canRecycleAll !== "boolean" || !text(t.reason)) fail();
    array(t.rows, 4, 4).forEach((v, index) => {
      const r = record(v);
      if (r.index !== index || r.templateId !== materials[index] || !text(r.name, 1) || !integer(r.itemCount) || r.recycleUnitCoins !== 2
        || !integer(r.maxTakeCount, 0, r.itemCount) || !integer(r.maxRecycleCount, 0, r.itemCount) || typeof r.canTake !== "boolean"
        || typeof r.canRecycle !== "boolean" || r.canTake !== (r.maxTakeCount > 0) || r.canRecycle !== (r.maxRecycleCount > 0) || !text(r.reason)) fail();
    });
  });
  const newDraws = Number(types[0]!.newDraws) + Number(types[1]!.newDraws);
  if (p.personalProgressPercent !== Math.min(100, Math.floor(newDraws / 2))) fail();
  const legacy = record(p.legacyBag), legacyRewards = rewards(legacy.rewards, 0, 4);
  if (legacy.label !== "历史混合包" || !integer(legacy.records, 0, Number(p.bagSlotsUsed)) || !integer(legacy.itemCount)
    || amount(legacyRewards) !== legacy.itemCount || !integer(legacy.recyclePoints) || legacy.recyclePoints !== legacy.itemCount * 2
    || typeof legacy.canTake !== "boolean" || typeof legacy.canRecycle !== "boolean" || !text(legacy.reason)) fail();
  array(p.pool, 8, 8).forEach((v, n) => {
    const r = record(v), index = n % 4, tier = Math.floor(n / 4) + 1;
    if (r.tier !== tier || r.index !== index || r.templateId !== materials[index] || !text(r.name, 1) || r.itemCount !== tier || r.weight !== weights[index]) fail();
  });
  array(p.drawChoices, 6, 6).forEach((v, n) => {
    const c = record(v), tier = Math.floor(n / 3) + 1, index = n % 3, size = [1, 3, 5][index]!;
    if (c.tier !== tier || c.index !== index || c.bundleSize !== size || !integer(c.maxCount, 0, Math.floor(5 / size))) fail();
    const quotes = array(c.quotes, Math.floor(5 / size), Math.floor(5 / size)).map(record);
    quotes.forEach((q, i) => {
      if (q.count !== i + 1 || q.draws !== size * (i + 1) || !integer(q.freeDraws, 0, tier === 1 ? Number(q.draws) : 0)
        || !integer(q.cost) || q.cost !== (Number(q.draws) - Number(q.freeDraws)) * (tier === 1 ? 15 : 35)
        || typeof q.canDraw !== "boolean" || q.canDraw && (q.cost > Number(p.points) || Number(p.actionsRemaining) < 1 || Number(p.bagSlotsUsed) + Number(q.draws) > 30)
        || !text(q.reason)) fail();
    });
    if (c.maxCount !== Math.max(0, ...quotes.filter(q => q.canDraw).map(q => Number(q.count)))) fail();
  });
  array(p.floorPreview, 2, 2).forEach((v, i) => {
    const f = record(v); if (f.tier !== i + 1 || f.target !== 10 || f.current !== 10 - Number(p.pityRemaining) || f.shared !== true || !text(f.rule, 1)) fail();
    reward(f.reward, 11021, (i + 1) * 2);
  });
  array(p.progress, 11, 11).forEach((v, i) => {
    const r = record(v), expected = progressRewards[i]!, rs = rewards(r.rewards, 1, 1);
    if (r.id !== i + 1 || r.page !== (i < 6 ? 1 : 2) || r.target !== thresholds[i] || r.current !== (i < 6 ? p.progressScore : newDraws)
      || r.progressPercentRequired !== requiredPercent[i] || typeof r.claimed !== "boolean" || typeof r.canClaim !== "boolean"
      || r.canClaim && (r.claimed || Number(r.current) < Number(r.target)) || !text(r.reason)) fail();
    reward(rs[0], expected[0], expected[1]);
  });
  array(p.shop, 8, 8).forEach((v, n) => {
    const s = record(v), index = n % 4, tier = Math.floor(n / 4) + 1;
    if (s.tier !== tier || s.index !== index || s.unitCoins !== prices[index] || s.dailyLimit !== 5 || !integer(s.bought, 0, 5)
      || s.remaining !== 5 - s.bought || !integer(s.maxCount, 0, Math.min(Number(s.remaining), Math.floor(Number(types[tier - 1]!.coins) / prices[index]!)))
      || typeof s.canBuy !== "boolean" || s.canBuy !== (s.maxCount > 0) || !text(s.reason)) fail();
    reward(s.reward, materials[index], 1);
  });
  const exchange = record(p.exchange), rank = record(p.rank);
  if (exchange.fragmentCost !== 10 || typeof exchange.canExchange !== "boolean" || exchange.canExchange && Number(p.fragments) < 10 || !text(exchange.reason)) fail();
  reward(exchange.reward, 11021, 2);
  if (rank.available !== false || array(rank.rows, 0, 0).length || rank.myRank !== null || rank.myScore !== p.progressScore || !text(rank.reason, 1)) fail();
  if (!array(p.records, 0, 30).every(x => text(x))) fail();
  const unavailable = array(p.unavailable, 4, 4).map(record);
  if (new Set(unavailable.map(v => v.id)).size !== 4 || unavailable.some(v => !["original-payments", "original-pool", "global-progress", "global-rank"].includes(String(v.id)) || !text(v.reason, 1))) fail();
  if (!action || snapshot.replayed) return;
  const envelope = record(snapshot.nativeCaveLootAction), effects = array(envelope.effects, 1, 1); publicTree(effects);
  if (!text(envelope.requestId, 1)) fail();
  const e = record(effects[0]), source = action.type.endsWith("legacy") ? "legacy" : action.tier;
  switch (action.type) {
    case "draw": {
      const draws = [1, 3, 5][Number(action.index)]! * Number(action.count);
      if (e.type !== "drawn" || e.tier !== action.tier || e.animationBand !== action.index || e.draws !== draws || !integer(e.freeDraws, 0, action.tier === 1 ? draws : 0)
        || !integer(e.cost) || e.cost !== (draws - e.freeDraws) * (action.tier === 1 ? 15 : 35) || !integer(e.guaranteedDraws, 0, 1)) fail();
      const result = rewards(e.results, 1, 4);
      if (amount(result) !== (draws + Number(e.guaranteedDraws)) * Number(action.tier)
        || result.some((r, i) => Number(r.itemCount) % Number(action.tier) !== 0
          || i > 0 && materials.indexOf(Number(r.templateId)) <= materials.indexOf(Number(result[i - 1]!.templateId)))
        || e.guaranteedDraws === 1 && Number(result.find(r => r.templateId === 11021)?.itemCount ?? 0) < 2 * Number(action.tier)) fail();
      break;
    }
    case "take-item": case "take-all": case "take-legacy":
      if (e.type !== "taken" || e.source !== source || !integer(e.itemCount, 1) || amount(rewards(e.rewards, 1)) !== e.itemCount
        || action.type === "take-item" && (e.itemCount !== action.count || rewards(e.rewards).some(r => r.templateId !== materials[Number(action.index)]))) fail(); break;
    case "recycle-item": case "recycle-all": case "recycle-legacy":
      if (e.type !== "recycled" || e.source !== source || !integer(e.itemCount, 1) || amount(rewards(e.consumed, 1)) !== e.itemCount
        || e.coinsAwarded !== (source === "legacy" ? 0 : e.itemCount * 2) || e.pointsAwarded !== (source === "legacy" ? e.itemCount * 2 : 0)
        || action.type === "recycle-item" && (e.itemCount !== action.count || rewards(e.consumed).some(r => r.templateId !== materials[Number(action.index)]))) fail(); break;
    case "progress": {
      const expected = progressRewards[Number(action.tier) - 1]!;
      if (e.type !== "progress-claimed" || e.id !== action.tier) fail(); reward(rewards(e.rewards, 1, 1)[0], expected[0], expected[1]); break;
    }
    case "exchange": if (e.type !== "exchanged" || e.fragmentsSpent !== 10) fail(); reward(rewards(e.rewards, 1, 1)[0], 11021, 2); break;
    case "buy":
      if (e.type !== "bought" || e.tier !== action.tier || e.index !== action.index || e.count !== action.count || e.coinsSpent !== prices[Number(action.index)]! * Number(action.count)) fail();
      reward(rewards(e.rewards, 1, 1)[0], materials[Number(action.index)], Number(action.count)); break;
    default: fail();
  }
}
export const retryNativeCaveLootRequest = (request: ActivityRequest) => request.activityId === "caveloot-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeCaveLootHost(options: NativeCaveLootHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopCaveLootAcceptSnapshot === "function" && typeof options.player.workshopCaveLootRejectRequest === "function",
    accept: e => options.player.workshopCaveLootAcceptSnapshot?.(e), reject: e => options.player.workshopCaveLootRejectRequest?.(e),
    bind: ({ read, request, report }) => {
      target.workshopCaveLootRead = read; target.workshopCaveLootRequest = request; target.workshopCaveLootReport = report;
      return () => { if (target.workshopCaveLootRead === read) delete target.workshopCaveLootRead; if (target.workshopCaveLootRequest === request) delete target.workshopCaveLootRequest; if (target.workshopCaveLootReport === report) delete target.workshopCaveLootReport; };
    },
  }, { activityId: "caveloot-native", title: "原版矿洞寻宝", effectKey: "nativeCaveLootAction", parseAction, validatePublic });
}
