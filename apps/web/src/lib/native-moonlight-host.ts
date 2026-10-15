import { ActivityRequestError, type ActivityAction, type ActivityRequest, type ActivityResponse } from "./activities";
import {
  attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost,
} from "./native-activity-host";

export type NativeMoonlightEnvelope = NativeActivityEnvelope;
export interface NativeMoonlightPlayer {
  workshopMoonlightAcceptSnapshot?: (envelope: NativeMoonlightEnvelope) => unknown;
  workshopMoonlightRejectRequest?: (envelope: NativeMoonlightEnvelope) => unknown;
}
export interface NativeMoonlightCallbackTarget {
  workshopMoonlightRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopMoonlightRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopMoonlightReport?: (status: unknown) => void;
}
export interface NativeMoonlightHostOptions {
  player: NativeMoonlightPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeMoonlightCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeMoonlightCallbackTarget {
  workshopShowMoonlight?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const token = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{43}$/.test(value);
const materials = [11019, 11001, 11021, 11002] as const;
const drawCounts = [1, 3, 5] as const;
function nativeAction(value: unknown): ActivityAction | null {
  if (!nativeObject(value) || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "choice") || !token(value.choice)) return null;
  const exact = (...keys: string[]) => Object.keys(value).every(key => ["type", "choice", ...keys].includes(key));
  if (value.type === "draw" && Object.hasOwn(value, "count") && integer(value.count, 1, 5)
    && drawCounts.includes(value.count as 1 | 3 | 5) && exact("count"))
    return { type: "draw", choice: value.choice, count: value.count };
  if (value.type === "exchange" && exact("count")) {
    if (Object.hasOwn(value, "count")) return integer(value.count, 1, 10)
      ? { type: "exchange", choice: value.choice, count: value.count } : null;
    return { type: "exchange", choice: value.choice };
  }
  if (value.type === "progress" && Object.hasOwn(value, "tier") && integer(value.tier, 1, 3) && exact("tier"))
    return { type: "progress", choice: value.choice, tier: value.tier };
  if ((value.type === "take" || value.type === "recycle") && exact("items") && Object.hasOwn(value, "items")
    && Array.isArray(value.items) && value.items.length >= 1 && value.items.length <= 4) {
    const indices = new Set<number>(), items: { index: number; count: number }[] = [];
    for (const item of value.items) {
      if (!nativeObject(item) || !Object.hasOwn(item, "index") || !Object.hasOwn(item, "count")
        || !integer(item.index, 0, 3) || !integer(item.count, 1, 60) || indices.has(item.index)
        || Object.keys(item).some(key => key !== "index" && key !== "count")) return null;
      indices.add(item.index); items.push({ index: item.index, count: item.count });
    }
    return { type: value.type, choice: value.choice, items };
  }
  return null;
}
function validateRanking(value: unknown, personalScore: number, characterId: number, fail: () => never): void {
  if (value === undefined || value === null) return;
  const keys = ["version", "kind", "scope", "metric", "entries", "personalScore", "personalRank"];
  if (!nativeObject(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || value.version !== 1 || value.kind !== "moonlight-native-ranking" || value.scope !== "local"
    || value.metric !== "cumulative-box-draws" || value.personalScore !== personalScore
    || !Array.isArray(value.entries) || value.entries.length > 10
    || (personalScore === 0 ? value.personalRank !== null : !integer(value.personalRank, 1, 2_147_483_647))) return fail();
  const seen = new Set<number>(); let previous: { score: number; characterId: number; rank: number } | null = null;
  let own = false, sameScore = false, above = 0;
  for (const [index, row] of value.entries.entries()) {
    if (!nativeObject(row) || Object.keys(row).length !== 4 || Object.keys(row).some(key => !["rank", "characterId", "nickName", "score"].includes(key))
      || !integer(row.rank, 1, 10) || !integer(row.characterId, 1, 2_147_483_647) || seen.has(row.characterId)
      || typeof row.nickName !== "string" || !row.nickName.trim() || row.nickName.length > 200 || !integer(row.score, 1, 1_000_000_000)) return fail();
    if (previous && (previous.score < row.score || (previous.score === row.score && previous.characterId >= row.characterId))) return fail();
    if (row.rank !== (previous && previous.score === row.score ? previous.rank : index + 1)) return fail();
    if (row.score > personalScore) above++;
    if (row.score === personalScore) sameScore = true;
    if (row.characterId === characterId) {
      if (row.score !== personalScore || row.rank !== value.personalRank) return fail();
      own = true;
    }
    seen.add(row.characterId); previous = { score: row.score, characterId: row.characterId, rank: row.rank };
  }
  if (personalScore > 0) {
    if (!previous) return fail();
    if (value.entries.length < 10 || personalScore >= previous.score) {
      if (!sameScore || value.personalRank !== above + 1) return fail();
      if (!own && (value.entries.length < 10 || personalScore > previous.score || characterId <= previous.characterId)) return fail();
    } else if (!integer(value.personalRank, 11, 2_147_483_647) || own) return fail();
  }
}
function validatePublic(snapshot: ActivityResponse, action?: ActivityAction) {
  const p = snapshot.nativeMoonlight;
  const fail = () => { throw new ActivityRequestError("原版月光宝盒公开数据不完整，请重试原操作。", true); };
  if (!nativeObject(p) || p.version !== 1 || p.kind !== "moonlight-native" || typeof p.started !== "boolean"
    || !day(p.day) || p.day !== snapshot.day || !integer(p.score, 0, 2_147_483_647) || p.score !== snapshot.points
    || p.drawCost !== 20 || p.bagCapacity !== 30 || !integer(p.bagSlotsUsed, 0, 30)
    || !token(p.bagToken) || !p.bagToken.startsWith(p.day + ":")
    || !integer(p.draws, 0, 1_000_000_000) || !integer(p.progressScore, 0, 1_000_000_000)
    || !integer(p.fragments, 0, 1_000_000_000) || !integer(p.pityRemaining, 1, 10)
    || typeof p.canDraw !== "boolean" || typeof p.canTake !== "boolean" || typeof p.canRecycle !== "boolean"
    || !Array.isArray(p.bag) || p.bag.length > 4 || (p.bag.length === 0) !== (p.bagSlotsUsed === 0)
    || p.canTake !== (p.bag.length > 0) || p.canRecycle !== (p.bag.length > 0 && p.score <= 2_147_483_645)
    || !Array.isArray(p.previewTemplateIds) || p.previewTemplateIds.length !== 4
    || p.previewTemplateIds.some((id, i) => id !== materials[i])
    || !nativeObject(p.localRules) || p.localRules.version !== 1 || typeof p.localRules.description !== "string"
    || ["state", "games", "seed", "rng"].some(key => key in p)) return fail();
  const seen = new Set<number>();
  for (const [index, item] of p.bag.entries()) {
    if (!nativeObject(item) || item.index !== index || !integer(item.templateId, 1, 2_147_483_647)
      || !materials.includes(item.templateId as typeof materials[number]) || seen.has(item.templateId)
      || !integer(item.itemCount, 1, 60) || item.recycleUnitPoints !== 2) return fail();
    seen.add(item.templateId);
  }
  if (!Array.isArray(p.drawChoices) || p.drawChoices.length !== 3) return fail();
  for (const [index, choice] of p.drawChoices.entries()) {
    const count = drawCounts[index];
    if (!nativeObject(choice) || choice.count !== count || choice.cost !== count * 20
      || typeof choice.canDraw !== "boolean" || choice.canDraw && (p.score < count * 20 || p.bagSlotsUsed + count > 30)) return fail();
  }
  if (p.canDraw !== p.drawChoices[0].canDraw || !nativeObject(p.exchange) || p.exchange.fragmentCost !== 10
    || p.exchange.templateId !== 11021 || p.exchange.itemCount !== 2 || p.exchange.maxCount !== 10
    || p.exchange.affordableCount !== Math.min(10, Math.floor(p.fragments / 10)) || typeof p.exchange.canExchange !== "boolean"
    || p.exchange.canExchange !== (p.fragments >= 10) || !Array.isArray(p.progress) || p.progress.length !== 3) return fail();
  for (const [index, tier] of p.progress.entries()) {
    const target = (index + 1) * 10;
    if (!nativeObject(tier) || tier.tier !== index + 1 || tier.target !== target || tier.templateId !== 11019
      || tier.itemCount !== (index + 1) * 2 || typeof tier.claimed !== "boolean" || typeof tier.canClaim !== "boolean"
      || tier.canClaim !== (!tier.claimed && p.progressScore >= target)) return fail();
  }
  if (!p.started && (p.bag.length || p.draws !== 0 || p.progressScore !== 0 || p.fragments !== 0 || p.pityRemaining !== 10
    || p.progress.some(tier => tier.claimed))) return fail();
  validateRanking(p.ranking, p.draws, snapshot.characterId, fail);
  if (action?.type === "exchange" && !snapshot.replayed) {
    const count = action.count ?? 1, effects = snapshot.nativeMoonlightAction?.effects;
    if (!integer(count, 1, 10) || !Array.isArray(effects) || effects.length !== 1) return fail();
    const effect = effects[0];
    if (!nativeObject(effect) || effect.type !== "exchanged" || effect.count !== count || effect.fragmentsSpent !== count * 10
      || effect.fragments !== p.fragments || effect.templateId !== 11021 || effect.itemCount !== count * 2) return fail();
  }
}
export const retryNativeMoonlightRequest = (request: ActivityRequest) =>
  request.activityId === "moonlight-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeMoonlightHost(options: NativeMoonlightHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopMoonlightAcceptSnapshot === "function" && typeof options.player.workshopMoonlightRejectRequest === "function",
    accept: envelope => options.player.workshopMoonlightAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopMoonlightRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopMoonlightRead = read; target.workshopMoonlightRequest = request; target.workshopMoonlightReport = report;
      return () => {
        if (target.workshopMoonlightRead === read) delete target.workshopMoonlightRead;
        if (target.workshopMoonlightRequest === request) delete target.workshopMoonlightRequest;
        if (target.workshopMoonlightReport === report) delete target.workshopMoonlightReport;
      };
    },
  }, { activityId: "moonlight-native", title: "原版月光宝盒", effectKey: "nativeMoonlightAction", parseAction: nativeAction, validatePublic });
}
