import type { ActivityAction, ActivityRequest, ActivityResponse } from "./activities";
import { ActivityRequestError } from "./activities";
import {
  attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost,
} from "./native-activity-host";

export type NativeCarnivalEnvelope = NativeActivityEnvelope;
export interface NativeCarnivalPlayer {
  workshopCarnivalAcceptSnapshot?: (envelope: NativeCarnivalEnvelope) => unknown;
  workshopCarnivalRejectRequest?: (envelope: NativeCarnivalEnvelope) => unknown;
}
export interface NativeCarnivalCallbackTarget {
  workshopCarnivalRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopCarnivalRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopCarnivalReport?: (status: unknown) => void;
}
export interface NativeCarnivalHostOptions {
  player: NativeCarnivalPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeCarnivalCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeCarnivalCallbackTarget {
  workshopShowCarnival?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const token = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{43}$/.test(value);
const day = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const materials = [11019, 11001, 11021, 11002] as const;
const recipes = [[0, 5, 10], [1, 5, 10], [2, 2, 10], [3, 2, 10], [0, 10, 20], [1, 10, 20], [2, 5, 20]] as const;
function nativeAction(value: unknown): ActivityAction | null {
  if (!nativeObject(value) || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "choice") || !token(value.choice)
    || !Object.hasOwn(value, "count")) return null;
  if (value.type === "draw" && integer(value.count, 1, 5)
    && Object.keys(value).every(key => ["type", "choice", "count"].includes(key)))
    return { type: "draw", choice: value.choice, count: value.count };
  if (value.type === "exchange" && integer(value.count, 1, 10) && Object.hasOwn(value, "index") && integer(value.index, 0, 6)
    && Object.keys(value).every(key => ["type", "choice", "index", "count"].includes(key)))
    return { type: "exchange", choice: value.choice, index: value.index, count: value.count };
  return null;
}
function validateRanking(value: unknown, personalScore: number, characterId: number, fail: () => never): void {
  // Older ordinary candidates omit this optional projection; null means a read is still needed.
  if (value === undefined || value === null) return;
  const keys = ["version", "kind", "scope", "metric", "entries", "personalScore", "personalRank"];
  if (!nativeObject(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || value.version !== 1 || value.kind !== "carnival-native-ranking" || value.scope !== "local"
    || value.metric !== "cumulative-native-draws" || value.personalScore !== personalScore
    || !Array.isArray(value.entries) || value.entries.length > 10
    || (personalScore === 0 ? value.personalRank !== null : !integer(value.personalRank, 1, 2_147_483_647))) return fail();
  const seen = new Set<number>(); let previous: { score: number; characterId: number; rank: number } | null = null;
  let own = false, sameScore = false, above = 0;
  for (const [index, row] of value.entries.entries()) {
    if (!nativeObject(row) || Object.keys(row).length !== 4 || Object.keys(row).some(key => !["rank", "characterId", "nickName", "score"].includes(key))
      || !integer(row.rank, 1, 10) || !integer(row.characterId, 1, 2_147_483_647) || seen.has(row.characterId)
      || typeof row.nickName !== "string" || !row.nickName.trim() || row.nickName.length > 200 || !integer(row.score, 1, 100_000_000)) return fail();
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
function validatePublic(snapshot: ActivityResponse) {
  const p = snapshot.nativeCarnival;
  const fail = () => { throw new ActivityRequestError("原版节日狂欢公开数据不完整，请重试原操作。", true); };
  if (!nativeObject(p) || p.version !== 1 || p.kind !== "carnival-native" || typeof p.started !== "boolean"
    || !day(p.day) || p.day !== snapshot.day || !token(p.stateToken) || !p.stateToken.startsWith(p.day + ":")
    || p.activityState !== 1 || p.startDate !== p.day + "T00:00:00.000Z"
    || p.endDate !== new Date(new Date(p.startDate).getTime() + 86_400_000).toISOString()
    || !integer(p.score, 0, 2_147_483_647) || p.score !== snapshot.points
    || !integer(p.personalScore, 0, 100_000_000) || !integer(p.redPackageCount, 0, Math.min(300_000_000, p.personalScore * 3))
    || !integer(p.remainDrawCount, 0, Math.min(500, Math.floor(p.score / 10), 100_000_000 - p.personalScore))
    || p.maxBatchCount !== Math.min(5, p.remainDrawCount) || p.canDraw !== (p.remainDrawCount > 0)
    || !Array.isArray(p.prizes) || p.prizes.length !== 12 || !Array.isArray(p.exchange) || p.exchange.length !== 7
    || !Array.isArray(p.records) || p.records.length !== Math.min(20, p.personalScore)
    || !nativeObject(p.rules) || p.rules.version !== 1 || p.rules.drawCost !== 10 || p.rules.maxBatchCount !== 5
    || p.rules.exchangeMaxCount !== 10 || p.rules.maxDraws !== 100_000_000 || p.rules.maxRedPackets !== 300_000_000
    || p.rules.recordLimit !== 20 || p.rules.probabilityNumerator !== 1 || p.rules.probabilityDenominator !== 12
    || typeof p.rules.description !== "string" || !p.rules.description
    || !Array.isArray(p.unavailable) || p.unavailable.length !== 5 || p.unavailable.some(value => typeof value !== "string" || !value)
    || ["state", "games", "seed", "rng", "futureResults"].some(key => key in p)) return fail();
  if (!p.started && (p.personalScore !== 0 || p.redPackageCount !== 0)) return fail();
  for (const [index, row] of p.prizes.entries()) {
    const count = Math.floor(index / 4) + 1;
    if (!nativeObject(row) || row.id !== index + 1 || row.index !== index || row.templateId !== materials[index % 4]
      || row.itemCount !== count || row.redPackets !== count || typeof row.name !== "string" || !row.name) return fail();
  }
  for (const [index, row] of p.exchange.entries()) {
    const [material, count, cost] = recipes[index];
    if (!nativeObject(row) || row.id !== index + 1 || row.index !== index || row.templateId !== materials[material]
      || row.itemCount !== count || row.redPacketsCost !== cost || row.canExchange !== (p.redPackageCount >= cost)
      || typeof row.name !== "string" || !row.name) return fail();
  }
  for (const [index, row] of p.records.entries()) {
    if (!nativeObject(row) || row.drawId !== p.personalScore - index || !integer(row.prizeId, 1, 12) || !day(row.day)) return fail();
    const prize = p.prizes[row.prizeId - 1];
    if (!nativeObject(prize) || row.templateId !== prize.templateId || row.itemCount !== prize.itemCount || row.redPackets !== prize.redPackets) return fail();
  }
  validateRanking(p.ranking, p.personalScore, snapshot.characterId, fail);
}
export const retryNativeCarnivalRequest = (request: ActivityRequest) =>
  request.activityId === "carnival-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeCarnivalHost(options: NativeCarnivalHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopCarnivalAcceptSnapshot === "function" && typeof options.player.workshopCarnivalRejectRequest === "function",
    accept: envelope => options.player.workshopCarnivalAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopCarnivalRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopCarnivalRead = read; target.workshopCarnivalRequest = request; target.workshopCarnivalReport = report;
      return () => {
        if (target.workshopCarnivalRead === read) delete target.workshopCarnivalRead;
        if (target.workshopCarnivalRequest === request) delete target.workshopCarnivalRequest;
        if (target.workshopCarnivalReport === report) delete target.workshopCarnivalReport;
      };
    },
  }, { activityId: "carnival-native", title: "原版节日狂欢", effectKey: "nativeCarnivalAction", parseAction: nativeAction, validatePublic });
}
