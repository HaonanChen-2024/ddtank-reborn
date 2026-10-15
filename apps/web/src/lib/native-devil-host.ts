import type { ActivityAction, ActivityRequest, ActivityResponse } from "./activities";
import { ActivityRequestError } from "./activities";
import { attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost } from "./native-activity-host";

export type NativeDevilEnvelope = NativeActivityEnvelope;
export interface NativeDevilPlayer {
  workshopDevilAcceptSnapshot?: (envelope: NativeDevilEnvelope) => unknown;
  workshopDevilRejectRequest?: (envelope: NativeDevilEnvelope) => unknown;
}
export interface NativeDevilCallbackTarget {
  workshopDevilRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopDevilRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopDevilReport?: (status: unknown) => void;
}
export interface NativeDevilHostOptions {
  player: NativeDevilPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeDevilCallbackTarget; onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global { interface Window extends NativeDevilCallbackTarget {
  workshopShowDevil?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
} }

const integer = (v: unknown, min = 0, max = 2_147_483_647): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const token = (v: unknown): v is string => typeof v === "string" && v.length === 54 && day(v.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const actions: Record<string, string[]> = {
  "free-turn": [], "buy-turns": ["count"], draw: ["count"], "convert-box": ["index"], "open-box": ["index"],
  "roll-dice": [], "continue-dice": [], "take-box": [], "abandon-box": [], "claim-milestone": ["index"], "buy-item": ["index", "count"],
};
function parseAction(v: unknown): ActivityAction | null {
  if (!nativeObject(v) || typeof v.type !== "string" || !Object.hasOwn(actions, v.type) || !token(v.choice)
    || !exact(v, ["type", "choice", ...actions[v.type]!])) return null;
  if ("index" in v && !integer(v.index, 0, v.type === "claim-milestone" ? 8 : v.type === "buy-item" ? 3 : 2)) return null;
  if ("count" in v && (!integer(v.count, 1, 10) || v.type === "buy-turns" && v.count !== 1 && v.count !== 10)) return null;
  return { type: v.type, choice: v.choice, ...("index" in v ? { index: Number(v.index) } : {}), ...("count" in v ? { count: Number(v.count) } : {}) };
}
const fail = (): never => { throw new ActivityRequestError("原版恶魔宝藏公开数据不完整，请重试原操作。", true); };
const record = (v: unknown): Record<string, unknown> => nativeObject(v) ? v : fail();
const array = (v: unknown, min = 0, max = 10): unknown[] => Array.isArray(v) && v.length >= min && v.length <= max ? v : fail();
const privateKeys = new Set(["games", "accountId", "accountName", "sessionId", "signature", "rng", "seed", "nextRoll", "nextPrize", "activeRound", "roundSequence", "milestoneClaimed", "shopBought"]);
function publicTree(v: unknown, depth = 0): void {
  if (depth > 10) fail();
  if (Array.isArray(v)) { if (v.length > 100) fail(); v.forEach(x => publicTree(x, depth + 1)); }
  else if (nativeObject(v)) for (const [key, value] of Object.entries(v)) { if (privateKeys.has(key) || key === "state" && !integer(value, 1, 3)) fail(); publicTree(value, depth + 1); }
}
const materials = [11019, 11001, 11021, 11002];
const boxCosts = [[1, 1, 1, 0, 0], [2, 2, 0, 2, 0], [0, 0, 3, 3, 3]];
const stageAmounts = [1, 2, 3, 5, 8], stageMarks = [1, 2, 4, 6, 10], winningPairs = [36, 34, 30, 24, 16];
const thresholds = [10, 30, 50, 100, 200, 300, 500, 800, 1000];
const milestoneRewards = [[11019, 3], [11001, 3], [11021, 1], [11002, 1], [11019, 5], [11001, 5], [11021, 3], [11002, 3], [11019, 10]];
const shopRewards = [[11019, 3], [11001, 3], [11021, 1], [11002, 1]], shopCosts = [15, 20, 25, 30];
function reward(v: unknown, template?: number, count?: number) {
  const r = record(v);
  if (!materials.includes(Number(r.templateId)) || !integer(r.templateId) || !integer(r.count, 1) || r.bound !== true || r.validDays !== 0
    || template !== undefined && r.templateId !== template || count !== undefined && r.count !== count) fail();
  return r;
}
function dice(v: unknown, phase: number) {
  const d = record(v);
  if (!integer(d.left, 1, 6) || !integer(d.right, 1, 6) || d.sum !== d.left + d.right
    || d.success !== (Number(d.sum) >= phase + 1 && Number(d.sum) <= 13 - phase)) fail();
  return d;
}
function grant(v: unknown) {
  const g = record(v);
  if (g.kind === "material") reward(g.reward);
  else if (g.kind === "bead") { if (!integer(g.index, 0, 4) || g.count !== 1) fail(); }
  else if (g.kind === "box") { if (!integer(g.index, 0, 2) || g.count !== 1) fail(); }
  else if (g.kind === "marks") { if (g.count !== 3) fail(); }
  else fail();
  return g;
}
function drawn(v: unknown) {
  const r = record(v), g = grant(r.grant);
  if (!integer(r.sequence, 1) || !integer(r.prizeId, 1, 8) || r.marksEarned !== (g.kind === "marks" ? 4 : 1)) fail();
  const id = Number(r.prizeId);
  if (id === 1 || id === 2 || id === 8) {
    if (g.kind !== "material") fail(); reward(g.reward, id === 1 ? 11019 : id === 2 ? 11001 : 11021, 1);
  } else if (id === 3 ? g.kind !== "bead" : id === 4 ? g.kind !== "marks" : g.kind !== "box" || g.index !== id - 5) fail();
  return r;
}
function validatePublic(snapshot: ActivityResponse, action?: ActivityAction) {
  const p = record(snapshot.nativeDevil); publicTree(p);
  if (p.version !== 1 || p.catalogVersion !== "local-devil-native-v1" || !day(p.day) || p.day !== snapshot.day) fail();
  if (p.available === false) {
    if (!exact(p, ["version", "catalogVersion", "day", "available", "stateToken", "reason"]) || p.stateToken !== null || !text(p.reason) || action && !snapshot.replayed) fail();
    return;
  }
  if (p.available !== true || !token(p.stateToken) || !p.stateToken.startsWith(p.day + ".") || !integer(p.points) || p.points !== snapshot.points
    || !integer(p.dailyActionsRemaining, 0, 500) || ![p.turns, p.draws, p.marks].every(v => integer(v))
    || typeof p.freeAvailable !== "boolean" || typeof p.canBuyOne !== "boolean" || typeof p.canBuyTen !== "boolean"
    || p.canBuyOne && (p.points < 20 || p.dailyActionsRemaining < 1) || p.canBuyTen && (p.points < 200 || p.dailyActionsRemaining < 1)
    || !integer(p.drawMaxCount, 0, Math.min(10, Number(p.turns), p.dailyActionsRemaining))) fail();
  const purchase = record(p.purchase);
  if (purchase.onePoints !== 20 || purchase.tenPoints !== 200 || purchase.freePerUtcDay !== 1 || purchase.freeGrantsTurns !== 1) fail();
  if (array(p.beads, 5, 5).some(v => !integer(v))) fail();
  array(p.slots, 8, 8).forEach((v, index) => {
    const s = record(v), g = record(s.grant);
    if (s.index !== index || s.prizeId !== index + 1 || s.originalRenderType !== [2, 2, 3, 2, 1, 2, 1, 2][index]
      || !text(s.label) || s.weight !== [25, 20, 30, 10, 5, 5, 2, 3][index] || s.weightTotal !== 100) fail();
    if (index === 2) { if (g.kind !== "random-bead" || g.count !== 1 || g.eachWeight !== 1 || g.weightTotal !== 5) fail(); }
    else { grant(g); if (index === 0 || index === 1 || index === 7) reward(g.reward, index === 0 ? 11019 : index === 1 ? 11001 : 11021, 1);
      else if (index === 3 ? g.kind !== "marks" : g.kind !== "box" || g.index !== index - 4) fail(); }
  });
  array(p.boxes, 3, 3).forEach((v, index) => {
    const b = record(v);
    if (b.index !== index || !text(b.name) || !text(b.reason) || !integer(b.count) || b.expireAt !== null
      || typeof b.canConvert !== "boolean" || typeof b.canOpen !== "boolean"
      || array(b.beadCosts, 5, 5).some((n, i) => n !== boxCosts[index]![i])
      || b.canConvert && boxCosts[index]!.some((n, i) => Number(array(p.beads)[i]) < n)) fail();
  });
  if (p.round !== null) {
    const r = record(p.round);
    if (!integer(r.id, 1) || !integer(r.boxIndex, 0, 2) || !integer(r.phase, 1, 5) || !integer(r.state, 1, 3)
      || r.rangeMin !== r.phase + 1 || r.rangeMax !== 13 - r.phase || r.retryPoints !== 10 || !text(r.reason)
      || [r.canRoll, r.canContinue, r.canTake, r.canAbandon].some(v => typeof v !== "boolean")
      || r.canRoll && (r.state !== 1 || Number(p.dailyActionsRemaining) < 1)
      || r.canTake && r.state !== 2 || r.canAbandon && r.state !== 3
      || r.canContinue && !(r.state === 2 && r.phase < 5 || r.state === 3 && Number(p.points) >= 10 && Number(p.dailyActionsRemaining) > 0)) fail();
    if (r.lastDice !== null) { const d = dice(r.lastDice, Number(r.phase)); if (r.state === 2 && d.success !== true || r.state === 3 && d.success !== false) fail(); }
    else if (r.state !== 1) fail();
    array(r.stages, 5, 5).forEach((v, index) => {
      const s = record(v);
      if (s.phase !== index + 1 || s.rangeMin !== index + 2 || s.rangeMax !== 12 - index || s.winningPairs !== winningPairs[index]
        || s.possiblePairs !== 36 || s.marks !== stageMarks[index]! * (Number(r.boxIndex) + 1)) fail();
      reward(s.reward, [11019, 11001, 11021][r.boxIndex as number], stageAmounts[index]);
    });
  }
  array(p.milestones, 9, 9).forEach((v, index) => {
    const m = record(v), expected = milestoneRewards[index]!;
    if (m.index !== index || !integer(m.catalogId, 1) || m.drawsRequired !== thresholds[index] || !text(m.reason)
      || typeof m.claimed !== "boolean" || typeof m.canClaim !== "boolean" || m.canClaim && (m.claimed || Number(p.draws) < thresholds[index]!)) fail();
    reward(m.reward, expected[0], expected[1]);
  });
  array(p.shop, 4, 4).forEach((v, index) => {
    const s = record(v), expected = shopRewards[index]!;
    if (s.index !== index || !integer(s.catalogId, 1) || s.unitMarks !== shopCosts[index] || !text(s.reason) || s.dailyLimit !== 10
      || !integer(s.boughtToday, 0, 10) || !integer(s.maxCount, 0, Math.min(10 - s.boughtToday, Math.floor(Number(p.marks) / shopCosts[index]!)))
      || typeof s.canBuy !== "boolean" || s.canBuy !== (s.maxCount > 0)) fail();
    reward(s.reward, expected[0], expected[1]);
  });
  const recent = array(p.recentDraws); recent.forEach(drawn);
  if (recent.some((v, i) => i > 0 && Number(record(v).sequence) !== Number(record(recent[i - 1]).sequence) - 1)
    || recent.length && record(recent[0]).sequence !== p.draws || !array(p.rules, 1, 20).every(text)) fail();
  const unavailable = array(p.unavailable, 3, 3).map(record);
  if (new Set(unavailable.map(v => v.id)).size !== 3 || unavailable.some(v => !["reference-economy", "global-jackpot-ranking", "timed-box-expiry"].includes(String(v.id)) || !text(v.reason))) fail();
  if (!action || snapshot.replayed) return;
  const envelope = record(snapshot.nativeDevilAction), effects = array(envelope.effects, 1, 1); publicTree(effects);
  if (!text(envelope.requestId)) fail();
  const e = record(effects[0]);
  switch (action.type) {
    case "free-turn": case "buy-turns":
      if (e.type !== "turns-added" || e.source !== (action.type === "free-turn" ? "free" : "points")
        || e.count !== (action.type === "free-turn" ? 1 : action.count) || e.pointsSpent !== (action.type === "free-turn" ? 0 : 20 * Number(action.count))) fail(); break;
    case "draw": {
      const results = array(e.results, Number(action.count), Number(action.count));
      if (e.type !== "drawn") fail(); results.forEach(drawn);
      const materialResults = results.map(v => record(record(v).grant)).filter(g => g.kind === "material").map(g => record(g.reward));
      const mailed = array(e.mailedRewards, materialResults.length, materialResults.length);
      mailed.forEach((v, i) => reward(v, Number(materialResults[i]!.templateId), Number(materialResults[i]!.count))); break;
    }
    case "convert-box":
      if (e.type !== "box-converted" || e.index !== action.index || array(e.beadsSpent, 5, 5).some((v, i) => v !== boxCosts[Number(action.index)]![i])) fail(); break;
    case "open-box": if (e.type !== "box-opened" || e.index !== action.index || !integer(e.roundId, 1)) fail(); break;
    case "roll-dice": if (e.type !== "dice-rolled" || !integer(e.roundId, 1) || !integer(e.phase, 1, 5)) fail(); dice(e.result, Number(e.phase)); break;
    case "continue-dice":
      if (e.type !== "dice-continued" || !integer(e.roundId, 1) || !integer(e.phase, 1, 5) || typeof e.retried !== "boolean" || e.pointsSpent !== (e.retried ? 10 : 0)) fail(); break;
    case "take-box":
      if (e.type !== "box-taken" || !integer(e.roundId, 1) || !integer(e.phase, 1, 5) || ![1, 2, 3].some(n => e.marks === stageMarks[Number(e.phase) - 1]! * n)) fail();
      reward(e.reward, [11019, 11001, 11021][Number(e.marks) / stageMarks[Number(e.phase) - 1]! - 1], stageAmounts[Number(e.phase) - 1]); break;
    case "abandon-box": if (e.type !== "box-abandoned" || !integer(e.roundId, 1)) fail(); break;
    case "claim-milestone": {
      const expected = milestoneRewards[Number(action.index)]!;
      if (e.type !== "milestone-claimed" || e.index !== action.index) fail(); reward(e.reward, expected[0], expected[1]); break;
    }
    case "buy-item": {
      const expected = shopRewards[Number(action.index)]!;
      if (e.type !== "item-bought" || e.index !== action.index || e.count !== action.count || e.marksSpent !== shopCosts[Number(action.index)]! * Number(action.count)) fail();
      reward(e.reward, expected[0], expected[1]! * Number(action.count)); break;
    }
    default: fail();
  }
}
export const retryNativeDevilRequest = (request: ActivityRequest) => request.activityId === "devil-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeDevilHost(options: NativeDevilHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopDevilAcceptSnapshot === "function" && typeof options.player.workshopDevilRejectRequest === "function",
    accept: e => options.player.workshopDevilAcceptSnapshot?.(e), reject: e => options.player.workshopDevilRejectRequest?.(e),
    bind: ({ read, request, report }) => {
      target.workshopDevilRead = read; target.workshopDevilRequest = request; target.workshopDevilReport = report;
      return () => { if (target.workshopDevilRead === read) delete target.workshopDevilRead; if (target.workshopDevilRequest === request) delete target.workshopDevilRequest; if (target.workshopDevilReport === report) delete target.workshopDevilReport; };
    },
  }, { activityId: "devil-native", title: "原版恶魔宝藏", effectKey: "nativeDevilAction", parseAction, validatePublic });
}
