import { ActivityRequestError, type ActivityAction, type ActivityRequest, type ActivityResponse } from "./activities";
import {
  attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost,
} from "./native-activity-host";

export type NativeTreasureEnvelope = NativeActivityEnvelope;
export interface NativeTreasurePlayer {
  workshopTreasureAcceptSnapshot?: (envelope: NativeTreasureEnvelope) => unknown;
  workshopTreasureRejectRequest?: (envelope: NativeTreasureEnvelope) => unknown;
}
export interface NativeTreasureCallbackTarget {
  workshopTreasureRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopTreasureRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopTreasureReport?: (status: unknown) => void;
}
export interface NativeTreasureHostOptions {
  player: NativeTreasurePlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeTreasureCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeTreasureCallbackTarget {
  workshopShowTreasure?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const token = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{43}$/.test(value);
const materials = [11019, 11001, 11021, 11002] as const;
function nativeAction(value: unknown): ActivityAction | null {
  if (!nativeObject(value) || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "choice") || !token(value.choice)) return null;
  const exact = (...keys: string[]) => Object.keys(value).every(key => ["type", "choice", ...keys].includes(key));
  if (value.type === "draw" && Object.hasOwn(value, "mode") && (value.mode === "normal" || value.mode === "advanced")
    && Object.hasOwn(value, "count") && integer(value.count, 1, 5) && exact("mode", "count"))
    return { type: "draw", choice: value.choice, mode: value.mode, count: value.count };
  if (value.type === "choose" && Object.hasOwn(value, "index") && integer(value.index, 0, 3)
    && Object.hasOwn(value, "marked") && typeof value.marked === "boolean" && exact("index", "marked"))
    return { type: "choose", choice: value.choice, index: value.index, marked: value.marked };
  if (value.type === "take" && exact("index") && (!Object.hasOwn(value, "index") || integer(value.index, 0, 29)))
    return { type: "take", choice: value.choice, ...(Object.hasOwn(value, "index") ? { index: value.index as number } : {}) };
  if ((value.type === "recycle" || value.type === "exchange") && exact()) return { type: value.type, choice: value.choice };
  if (value.type === "progress" && Object.hasOwn(value, "tier") && integer(value.tier, 1, 3) && exact("tier"))
    return { type: "progress", choice: value.choice, tier: value.tier };
  return null;
}
function validatePublic(snapshot: ActivityResponse) {
  const p = snapshot.nativeTreasure;
  const fail = () => { throw new ActivityRequestError("原版迷宫寻宝公开数据不完整，请重试原操作。", true); };
  if (!nativeObject(p) || p.version !== 1 || p.kind !== "treasure-native" || typeof p.started !== "boolean"
    || !day(p.day) || p.day !== snapshot.day || !integer(p.score, 0, 2_147_483_647) || p.score !== snapshot.points
    || p.normalCost !== 30 || p.advancedCost !== 60 || p.bagCapacity !== 30 || !integer(p.bagSlotsUsed, 0, 30)
    || !token(p.bagToken) || !p.bagToken.startsWith(p.day + ":")
    || !integer(p.draws, 0, 1_000_000_000) || !integer(p.progressScore, 0, 1_000_000_000)
    || !integer(p.fragments, 0, 1_000_000_000) || !integer(p.pityRemaining, 1, 10)
    || typeof p.canDraw !== "boolean" || typeof p.canTake !== "boolean" || typeof p.canRecycle !== "boolean"
    || !Array.isArray(p.bag) || p.bag.length !== p.bagSlotsUsed || p.canTake !== (p.bag.length > 0)
    || !Array.isArray(p.categories) || p.categories.length !== 4
    || !Array.isArray(p.previewTemplateIds) || p.previewTemplateIds.length !== 4
    || p.previewTemplateIds.some((id, i) => id !== materials[i])
    || !Array.isArray(p.records) || p.records.length > 20 || p.records.some(record => typeof record !== "string")
    || !nativeObject(p.localRules) || p.localRules.version !== 1 || typeof p.localRules.description !== "string"
    || ["state", "games", "seed", "rng"].some(key => key in p)) return fail();
  let selected = 0, recycle = 0;
  for (const [index, item] of p.categories.entries()) {
    if (!nativeObject(item) || item.index !== index || item.sourceOriginalIndex !== index + 1 || item.templateId !== materials[index]
      || typeof item.name !== "string" || !item.name || typeof item.selected !== "boolean") return fail();
    if (item.selected) selected++;
  }
  if (selected === 0) return fail();
  for (const [index, item] of p.bag.entries()) {
    if (!nativeObject(item) || item.index !== index || !materials.includes(item.templateId as typeof materials[number])
      || !integer(item.itemCount, 1, 4) || !(item.templateId === 11021 ? [1, 2, 4] : [1, 2]).includes(item.itemCount) || item.recycleUnitPoints !== 2) return fail();
    recycle += item.itemCount * 2;
  }
  if (p.canRecycle !== (p.bag.length > 0 && p.score + recycle <= 2_147_483_647)
    || !Array.isArray(p.drawChoices) || p.drawChoices.length !== 10) return fail();
  for (const [index, option] of p.drawChoices.entries()) {
    const mode = index < 5 ? "normal" : "advanced", count = index % 5 + 1, advanced = mode === "advanced";
    if (!nativeObject(option) || option.mode !== mode || option.count !== count || option.cost !== count * (advanced ? 60 : 30)
      || typeof option.canDraw !== "boolean" || option.canDraw && (p.score < option.cost || p.bagSlotsUsed + count > 30
        || advanced && selected !== 4 || p.draws + count > 1_000_000_000 || p.fragments + count > 1_000_000_000
        || p.progressScore + count * (advanced ? 2 : 1) > 1_000_000_000)) return fail();
  }
  if (p.canDraw !== p.drawChoices[0].canDraw || !nativeObject(p.exchange) || p.exchange.fragmentCost !== 10
    || p.exchange.templateId !== 11021 || p.exchange.itemCount !== 2 || typeof p.exchange.canExchange !== "boolean"
    || p.exchange.canExchange !== (p.fragments >= 10) || !Array.isArray(p.progress) || p.progress.length !== 3) return fail();
  for (const [index, tier] of p.progress.entries()) {
    const target = (index + 1) * 10;
    if (!nativeObject(tier) || tier.tier !== index + 1 || tier.target !== target || tier.templateId !== 11019
      || tier.itemCount !== (index + 1) * 2 || typeof tier.claimed !== "boolean" || typeof tier.canClaim !== "boolean"
      || tier.canClaim !== (!tier.claimed && p.progressScore >= target)) return fail();
  }
  if (!p.started && (p.bag.length || p.draws !== 0 || p.progressScore !== 0 || p.fragments !== 0 || p.pityRemaining !== 10
    || p.progress.some(tier => tier.claimed))) return fail();
}
export const retryNativeTreasureRequest = (request: ActivityRequest) =>
  request.activityId === "treasure-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeTreasureHost(options: NativeTreasureHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopTreasureAcceptSnapshot === "function" && typeof options.player.workshopTreasureRejectRequest === "function",
    accept: envelope => options.player.workshopTreasureAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopTreasureRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopTreasureRead = read; target.workshopTreasureRequest = request; target.workshopTreasureReport = report;
      return () => {
        if (target.workshopTreasureRead === read) delete target.workshopTreasureRead;
        if (target.workshopTreasureRequest === request) delete target.workshopTreasureRequest;
        if (target.workshopTreasureReport === report) delete target.workshopTreasureReport;
      };
    },
  }, { activityId: "treasure-native", title: "原版迷宫寻宝", effectKey: "nativeTreasureAction", parseAction: nativeAction, validatePublic });
}
