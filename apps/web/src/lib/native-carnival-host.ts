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
const limit = 2_147_483_647;
const invalid = (): never => { throw new ActivityRequestError("原版节日狂欢公开数据不完整，请重试原操作。", true); };
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => nativeObject(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
interface RoundResult {
  type: "round-completed"; roundId: number; globalRevision: number; settledAt: string; participantCount: number;
  awards: { slot: number; characterId: number; nickName: string; templateId: number; itemCount: number }[];
}
interface GlobalView {
  version: 1; kind: "carnival-native-global"; scope: "local-server"; revision: number; actorRevision: number;
  roundId: number; roundDraws: number; roundTarget: 100; totalDraws: number; participantCount: number; myRoundDraws: number;
  pool: { templateId: 11019; itemCount: number; contributionPerDraw: 1 };
  roundRewards: { slot: number; templateId: number; itemCount: number }[]; recentRounds: RoundResult[];
}
type GlobalMode = "legacy" | "personal-only" | "local-server";
interface ConfirmedView { score: number; personalScore: number; redPackageCount: number; stateToken: string; global: GlobalView | null; mode: GlobalMode }
function globalMode(p: Record<string, unknown>, world: GlobalView | null): GlobalMode {
  if (p.globalMode === undefined && world === null) return "legacy";
  if (p.globalMode === "personal-only" && p.global === null) return "personal-only";
  if (p.globalMode === "local-server") return "local-server";
  return invalid();
}
function validateRound(value: unknown): asserts value is RoundResult {
  if (!exact(value, ["type", "roundId", "globalRevision", "settledAt", "participantCount", "awards"])
    || value.type !== "round-completed" || !integer(value.roundId, 1, Math.floor(limit / 100))
    || value.globalRevision !== value.roundId * 100 || !integer(value.participantCount, 1, 100)
    || typeof value.settledAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.settledAt)
    || !Number.isFinite(Date.parse(value.settledAt)) || new Date(value.settledAt).toISOString() !== value.settledAt
    || !Array.isArray(value.awards) || value.awards.length !== 3) return invalid();
  for (const [slot, award] of value.awards.entries()) {
    if (!exact(award, ["slot", "characterId", "nickName", "templateId", "itemCount"]) || award.slot !== slot
      || !integer(award.characterId, 1, limit) || typeof award.nickName !== "string" || !award.nickName.trim() || award.nickName.length > 200
      || award.templateId !== [11019, 11021, 11002][slot] || award.itemCount !== [100, 2, 2][slot]) return invalid();
  }
}
function validateGlobal(value: unknown, revision: number): GlobalView | null {
  if (value === undefined || value === null) return null; // Old windows and temporarily inconsistent GETs have no shared authority.
  if (!exact(value, ["version", "kind", "scope", "revision", "actorRevision", "roundId", "roundDraws", "roundTarget", "totalDraws",
    "participantCount", "myRoundDraws", "pool", "roundRewards", "recentRounds"])
    || value.version !== 1 || value.kind !== "carnival-native-global" || value.scope !== "local-server"
    || !integer(value.totalDraws, 0, limit) || value.revision !== value.totalDraws || value.actorRevision !== revision
    || value.roundId !== Math.floor(value.totalDraws / 100) + 1 || value.roundDraws !== value.totalDraws % 100 || value.roundTarget !== 100
    || !integer(value.participantCount, value.roundDraws === 0 ? 0 : 1, value.roundDraws as number)
    || !integer(value.myRoundDraws, 0, value.roundDraws as number)
    || (value.myRoundDraws > 0 && (value.participantCount as number) > (value.roundDraws as number) - (value.myRoundDraws as number) + 1)
    || (value.myRoundDraws > 0 && value.myRoundDraws < (value.roundDraws as number) && value.participantCount === 1)
    || !exact(value.pool, ["templateId", "itemCount", "contributionPerDraw"]) || value.pool.templateId !== 11019
    || value.pool.itemCount !== value.roundDraws || value.pool.contributionPerDraw !== 1
    || !Array.isArray(value.roundRewards) || value.roundRewards.length !== 2
    || !Array.isArray(value.recentRounds) || value.recentRounds.length !== Math.min(10, Math.floor(value.totalDraws / 100))) return invalid();
  for (const [index, award] of value.roundRewards.entries())
    if (!exact(award, ["slot", "templateId", "itemCount"]) || award.slot !== index + 1
      || award.templateId !== [11021, 11002][index] || award.itemCount !== 2) return invalid();
  for (const [index, round] of value.recentRounds.entries()) {
    validateRound(round);
    if (round.roundId !== Math.floor(value.totalDraws / 100) - index || round.globalRevision > value.totalDraws) return invalid();
  }
  return value as unknown as GlobalView;
}
const sameRound = (a: RoundResult, b: RoundResult) => a.roundId === b.roundId && a.globalRevision === b.globalRevision
  && a.settledAt === b.settledAt && a.participantCount === b.participantCount
  && a.awards.every((row, i) => Object.entries(row).every(([key, value]) => value === b.awards[i]?.[key as keyof typeof row]));
function validateEffects(snapshot: ActivityResponse, action: ActivityAction, before: ConfirmedView | null, world: GlobalView | null,
  mode: GlobalMode, sharedSeen: boolean): void {
  if (snapshot.replayed) return;
  const p = snapshot.nativeCarnival as Record<string, unknown>, result: unknown = snapshot.nativeCarnivalAction;
  if (!before || action.choice !== before.stateToken || !nativeObject(result) || !Array.isArray(result.effects)) return invalid();
  const effects = result.effects, count = action.count!;
  const legacy = mode === "legacy" && before.mode === "legacy" && !sharedSeen
    && !Object.hasOwn(p, "global") && !Object.hasOwn(p, "globalMode") && !Object.hasOwn(result, "worldEffects");
  if (!legacy && (!Array.isArray(result.worldEffects) || mode === "legacy"
    || (mode === "personal-only" && result.worldEffects.length !== 0))) return invalid();
  if (action.type === "draw") {
    if (effects.length !== count || p.personalScore !== before.personalScore + count || p.score !== before.score - count * 10) return invalid();
    let packets = before.redPackageCount;
    for (const [index, effect] of effects.entries()) {
      if (!exact(effect, ["type", "drawId", "prizeId", "index", "templateId", "itemCount", "redPackets", "redPackageCount", "cost", "score", "batchIndex", "batchCount"])
        || effect.type !== "drawn" || !integer(effect.prizeId, 1, 12) || effect.index !== effect.prizeId - 1
        || effect.drawId !== before.personalScore + index + 1 || effect.batchIndex !== index || effect.batchCount !== count
        || effect.cost !== 10 || effect.score !== before.score - 10 * (index + 1)) return invalid();
      const slot = effect.prizeId - 1, amount = Math.floor(slot / 4) + 1;
      packets += amount;
      if (effect.templateId !== materials[slot % 4] || effect.itemCount !== amount || effect.redPackets !== amount || effect.redPackageCount !== packets) return invalid();
      const record = (p.records as Record<string, unknown>[])[count - index - 1];
      if (!record || record.prizeId !== effect.prizeId || record.drawId !== effect.drawId) return invalid();
    }
    if (p.redPackageCount !== packets) return invalid();
    if (legacy || mode === "personal-only") return; // Exact old API or explicitly unavailable shared storage; normal receipts remain fully checked.
    if (!world || !Array.isArray(result.worldEffects) || world.totalDraws < count) return invalid();
    const crossed = Math.floor(world.totalDraws / 100) > Math.floor((world.totalDraws - count) / 100);
    if (result.worldEffects.length !== (crossed ? 1 : 0)) return invalid();
    for (const round of result.worldEffects) {
      validateRound(round);
      if (round.roundId !== Math.floor(world.totalDraws / 100) || !world.recentRounds.some(row => sameRound(row, round))) return invalid();
    }
    if (world.myRoundDraws < Math.min(count, world.roundDraws) || (crossed && world.myRoundDraws !== world.roundDraws)) return invalid();
    if (before.global && (world.totalDraws < before.global.totalDraws + count
      || (world.roundId === before.global.roundId && world.myRoundDraws !== before.global.myRoundDraws + count))) return invalid();
  } else {
    if (effects.length !== 1 || (!legacy && (!Array.isArray(result.worldEffects) || result.worldEffects.length !== 0))) return invalid();
    const [material, amount, cost] = recipes[action.index!], effect = effects[0];
    if (!exact(effect, ["type", "index", "catalogId", "count", "templateId", "itemCount", "redPacketsSpent", "redPackageCount"])
      || effect.type !== "exchanged" || effect.index !== action.index || effect.catalogId !== action.index! + 1 || effect.count !== count
      || effect.templateId !== materials[material] || effect.itemCount !== amount * count || effect.redPacketsSpent !== cost * count
      || effect.redPackageCount !== before.redPackageCount - cost * count || p.redPackageCount !== effect.redPackageCount
      || p.score !== before.score || p.personalScore !== before.personalScore) return invalid();
  }
}
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
    || !Array.isArray(p.unavailable) || ![3, 5].includes(p.unavailable.length) || p.unavailable.some(value => typeof value !== "string" || !value)
    || ["state", "games", "seed", "rng", "futureResults"].some(key => key in p)) return fail();
  if (!p.started && (p.personalScore !== 0 || p.redPackageCount !== 0)) return fail();
  const missing = ["私服及跨服排行与排行奖", "大奖直播原窗口与动画", "真实付款"];
  const expectedMissing = p.unavailable.length === 5 ? ["全服奖池", missing[0], "轮次大奖", missing[1], missing[2]] : missing;
  if (p.unavailable.some((value, index) => value !== expectedMissing[index])
    || (p.globalMode === "local-server" && p.unavailable.length !== 3)
    || (p.globalMode === "personal-only" && p.unavailable.length !== 5)
    || (p.global !== undefined && p.global !== null && p.unavailable.length !== 3)) return fail();
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
  let confirmed: ConfirmedView | null = null, shared: GlobalView | null = null, localServerSeen = false;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopCarnivalAcceptSnapshot === "function" && typeof options.player.workshopCarnivalRejectRequest === "function",
    accept: envelope => options.player.workshopCarnivalAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopCarnivalRejectRequest?.(envelope),
    onSnapshot: snapshot => {
      const p = snapshot.nativeCarnival as Record<string, unknown>, global = validateGlobal(p.global, snapshot.revision);
      confirmed = { score: p.score as number, personalScore: p.personalScore as number, redPackageCount: p.redPackageCount as number,
        stateToken: p.stateToken as string, global: global ? structuredClone(global) : null, mode: globalMode(p, global) };
      if (global) shared = structuredClone(global); // Null/legacy data never erases the last independently confirmed shared version.
      if (confirmed.mode === "local-server") localServerSeen = true;
      options.onSnapshot?.(snapshot);
    },
    bind: ({ read, request, report }) => {
      target.workshopCarnivalRead = read; target.workshopCarnivalRequest = request; target.workshopCarnivalReport = report;
      return () => {
        if (target.workshopCarnivalRead === read) delete target.workshopCarnivalRead;
        if (target.workshopCarnivalRequest === request) delete target.workshopCarnivalRequest;
        if (target.workshopCarnivalReport === report) delete target.workshopCarnivalReport;
      };
    },
  }, { activityId: "carnival-native", title: "原版节日狂欢", effectKey: "nativeCarnivalAction", parseAction: nativeAction,
    validatePublic: (snapshot, action) => {
      validatePublic(snapshot);
      const p = snapshot.nativeCarnival as Record<string, unknown>, world = validateGlobal(p.global, snapshot.revision);
      const mode = globalMode(p, world);
      if (localServerSeen && mode === "personal-only") return invalid();
      if (world && world.myRoundDraws > (p.personalScore as number)) return invalid();
      if (shared && world) {
        if (world.revision < shared.revision || (world.revision === shared.revision
          && (world.myRoundDraws !== shared.myRoundDraws || world.participantCount !== shared.participantCount))) return invalid();
        for (const old of shared.recentRounds) {
          const current = world.recentRounds.find(row => row.roundId === old.roundId);
          if (current && !sameRound(current, old)) return invalid();
        }
      }
      if (action) validateEffects(snapshot, action, confirmed, world, mode, localServerSeen || shared !== null);
    },
  });
}
