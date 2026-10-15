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
const poolVersion = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const reasons = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);
const exact = (value: Record<string, unknown>, ...keys: string[]) => Object.keys(value).every(key => keys.includes(key));
function nativeAction(value: unknown): ActivityAction | null {
  if (!nativeObject(value) || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "choice") || !token(value.choice)) return null;
  const exact = (...keys: string[]) => Object.keys(value).every(key => ["type", "choice", ...keys].includes(key));
  if (value.type === "draw" && Object.hasOwn(value, "mode") && (value.mode === "normal" || value.mode === "advanced")
    && Object.hasOwn(value, "count") && integer(value.count, 1, 5) && exact("mode", "count", "selection", "poolVersion")
    && Object.hasOwn(value, "poolVersion") && poolVersion(value.poolVersion) && Object.hasOwn(value, "selection")
    && Array.isArray(value.selection) && Array.from(value.selection).every(index => integer(index, 1, 14))
    && new Set(value.selection).size === value.selection.length && value.selection.length === (value.mode === "advanced" ? 4 : 0))
    return { type: "draw", choice: value.choice, mode: value.mode, count: value.count, selection: [...value.selection], poolVersion: value.poolVersion };
  if (value.type === "take" && exact("index") && (!Object.hasOwn(value, "index") || integer(value.index, 0, 99)))
    return { type: "take", choice: value.choice, ...(Object.hasOwn(value, "index") ? { index: value.index as number } : {}) };
  if ((value.type === "recycle" || value.type === "exchange") && exact()) return { type: value.type, choice: value.choice };
  if (value.type === "progress" && Object.hasOwn(value, "tier") && integer(value.tier, 1, 3) && exact("tier"))
    return { type: "progress", choice: value.choice, tier: value.tier };
  return null;
}
function validatePublic(snapshot: ActivityResponse, action?: ActivityAction) {
  const p = snapshot.nativeTreasure;
  const fail = () => { throw new ActivityRequestError("原版迷宫寻宝公开数据不完整，请重试原操作。", true); };
  if (!nativeObject(p) || p.version !== 2 || p.kind !== "treasure-native" || typeof p.started !== "boolean"
    || !day(p.day) || p.day !== snapshot.day || !integer(p.score, 0, 2_147_483_647) || p.score !== snapshot.points
    || p.normalCost !== 30 || p.advancedCost !== 60 || p.bagCapacity !== 100 || !integer(p.bagSlotsUsed, 0, 100)
    || !token(p.bagToken) || !p.bagToken.startsWith(p.day + ":") || !poolVersion(p.poolVersion)
    || !integer(p.draws, 0, 1_000_000_000) || !integer(p.progressScore, 0, 1_000_000_000)
    || !integer(p.fragments, 0, 1_000_000_000) || !integer(p.pityRemaining, 1, 10)
    || typeof p.canDraw !== "boolean" || typeof p.canTake !== "boolean" || typeof p.canRecycle !== "boolean"
    || !Array.isArray(p.bag) || p.bag.length !== p.bagSlotsUsed || p.canTake !== (p.bag.length > 0)
    || !Array.isArray(p.categories) || p.categories.length !== 15 || !Array.isArray(p.preview) || p.preview.length !== 158
    || !Array.isArray(p.records) || p.records.length > 20 || p.records.some(record => typeof record !== "string")
    || !nativeObject(p.localRules) || p.localRules.version !== 2 || !nonempty(p.localRules.description)
    || ["state", "games", "seed", "rng", "previewTemplateIds"].some(key => key in p)) return fail();
  const catalog = new Map<string, Record<string, unknown>>();
  const groups: string[][] = Array.from({ length: 15 }, () => []);
  const blocked = new Map<string, string[]>();
  const sourceTemplates = new Set<number>();
  for (const [index, row] of p.preview.entries()) {
    if (!nativeObject(row) || !exact(row, "entryKey", "sourceRow", "sourceId", "sourceOriginalIndex", "sourceTemplateId", "templateId", "count", "name", "categoryId", "pic", "needSex", "status", "reasons")
      || !nonempty(row.entryKey) || catalog.has(row.entryKey) || row.sourceRow !== index + 1
      || !integer(row.sourceId, 1, 2_147_483_647) || !integer(row.sourceOriginalIndex, 1, 15)
      || !integer(row.sourceTemplateId, 1, 2_147_483_647) || !integer(row.templateId, 1, 2_147_483_647)
      || !integer(row.count, 1, 2_147_483_647) || !nonempty(row.name) || !integer(row.categoryId, 1, 2_147_483_647)
      || typeof row.pic !== "string" || !integer(row.needSex, 0, 2) || !reasons(row.reasons)
      || row.status !== "blocked" && row.status !== "ready" || (row.status === "ready") !== (row.reasons.length === 0)) return fail();
    catalog.set(row.entryKey, row); groups[row.sourceOriginalIndex - 1].push(row.entryKey); sourceTemplates.add(row.sourceTemplateId);
    if (row.status === "blocked") blocked.set(row.entryKey, row.reasons);
  }
  if (sourceTemplates.size !== 157) return fail();
  for (const [index, category] of p.categories.entries()) {
    if (!nativeObject(category) || !exact(category, "index", "sourceOriginalIndex", "name", "selectable", "special", "entryKeys")
      || category.index !== index || category.sourceOriginalIndex !== index + 1 || !nonempty(category.name)
      || category.selectable !== (index < 14) || category.special !== (index === 14)
      || !Array.isArray(category.entryKeys) || !category.entryKeys.length
      || JSON.stringify(category.entryKeys) !== JSON.stringify(groups[index])) return fail();
  }
  const readiness = p.readiness;
  if (!nativeObject(readiness) || !exact(readiness, "status", "totalRows", "readyRows", "blocked", "description")
    || readiness.status !== "blocked" && readiness.status !== "ready" || readiness.totalRows !== 158
    || readiness.readyRows !== 158 - blocked.size || !nonempty(readiness.description) || !Array.isArray(readiness.blocked)
    || readiness.blocked.length !== blocked.size || (readiness.status === "ready") !== (blocked.size === 0)) return fail();
  const seenBlocked = new Set<string>();
  for (const row of readiness.blocked) {
    if (!nativeObject(row) || !exact(row, "entryKey", "reasons") || !nonempty(row.entryKey) || seenBlocked.has(row.entryKey)
      || !blocked.has(row.entryKey) || !reasons(row.reasons) || JSON.stringify(row.reasons) !== JSON.stringify(blocked.get(row.entryKey))) return fail();
    seenBlocked.add(row.entryKey);
  }
  let recycle = 0, legacyOnly = true;
  for (const [index, item] of p.bag.entries()) {
    if (!nativeObject(item) || item.index !== index || !integer(item.templateId, 1, 2_147_483_647) || !integer(item.itemCount, 1, 2_147_483_647)) return fail();
    if (item.origin === "legacy-four-material") {
      if (!exact(item, "index", "templateId", "itemCount", "origin", "recycleUnitPoints") || !materials.includes(item.templateId as typeof materials[number])
        || !(item.templateId === 11021 ? [1, 2, 4] : [1, 2]).includes(item.itemCount) || item.recycleUnitPoints !== 2) return fail();
      recycle += item.itemCount * 2;
    } else if (item.origin === "original-catalog") {
      const row = typeof item.entryKey === "string" ? catalog.get(item.entryKey) : undefined;
      if (!exact(item, "index", "templateId", "itemCount", "origin", "recycleUnitPoints", "entryKey", "sourceOriginalIndex", "poolVersion")
        || item.recycleUnitPoints !== null || !nonempty(item.entryKey) || !integer(item.sourceOriginalIndex, 1, 15) || !poolVersion(item.poolVersion)
        || item.poolVersion === p.poolVersion && (!row || item.sourceOriginalIndex !== row.sourceOriginalIndex || item.templateId !== row.templateId || item.itemCount !== row.count)) return fail();
      legacyOnly = false;
    } else return fail();
  }
  if (p.canRecycle !== (p.bag.length > 0 && legacyOnly && p.score + recycle <= 2_147_483_647)
    || !Array.isArray(p.drawChoices) || p.drawChoices.length !== 10) return fail();
  for (const [index, option] of p.drawChoices.entries()) {
    const mode = index < 5 ? "normal" : "advanced", count = index % 5 + 1, advanced = mode === "advanced";
    if (!nativeObject(option) || option.mode !== mode || option.count !== count || option.cost !== count * (advanced ? 60 : 30)
      || option.requiredSelection !== (advanced ? 4 : 0) || typeof option.canDraw !== "boolean"
      || option.canDraw && (readiness.status !== "ready" || p.score < option.cost || p.bagSlotsUsed + count > 100
        || p.draws + count > 1_000_000_000 || p.fragments + count > 1_000_000_000
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
  if (action?.type === "draw" && !snapshot.replayed) {
    const effects = snapshot.nativeTreasureAction?.effects;
    if (!Array.isArray(effects) || effects.length !== 1) return fail();
    const effect = effects[0];
    if (!nativeObject(effect) || effect.type !== "drawn" || effect.mode !== action.mode || effect.count !== action.count
      || action.poolVersion !== p.poolVersion || readiness.status !== "ready" || effect.score !== p.score || effect.draws !== p.draws
      || effect.cost !== (action.count ?? 0) * (action.mode === "advanced" ? 60 : 30)
      || !Array.isArray(effect.rewards) || effect.rewards.length !== action.count) return fail();
    for (const [index, reward] of effect.rewards.entries()) {
      if (!nativeObject(reward) || !exact(reward, "index", "templateId", "itemCount", "entryKey", "sourceOriginalIndex") || !nonempty(reward.entryKey)) return fail();
      const row = catalog.get(reward.entryKey), item = p.bag[p.bag.length - effect.rewards.length + index];
      if (!row || row.status !== "ready" || reward.sourceOriginalIndex !== row.sourceOriginalIndex || reward.templateId !== row.templateId || reward.itemCount !== row.count
        || !nativeObject(item) || item.origin !== "original-catalog" || reward.index !== item.index || reward.entryKey !== item.entryKey
        || item.templateId !== reward.templateId || item.itemCount !== reward.itemCount || item.sourceOriginalIndex !== reward.sourceOriginalIndex || item.poolVersion !== p.poolVersion
        || action.mode === "advanced" && reward.sourceOriginalIndex !== 15 && !action.selection?.includes(reward.sourceOriginalIndex as number)) return fail();
    }
  }
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
