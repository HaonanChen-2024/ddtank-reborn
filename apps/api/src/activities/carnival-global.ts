import { ActivityError, type ActivityReward } from "./types.js";

const LIMIT = 2147483647;
export const carnivalGlobalKey = "native-v1";
export const carnivalGlobalRules = Object.freeze({ roundTarget: 100, poolTemplateId: 11019,
  contributionPerDraw: 1, historyLimit: 10, maxTotalDraws: LIMIT });
const awards = [{ slot: 0, templateId: 11019, itemCount: 100 }, { slot: 1, templateId: 11021, itemCount: 2 },
  { slot: 2, templateId: 11002, itemCount: 2 }] as const;
export interface CarnivalRoundAward { slot: 0 | 1 | 2; characterId: number; nickName: string; templateId: number; itemCount: number }
export interface CarnivalRoundResult {
  type: "round-completed"; roundId: number; globalRevision: number; settledAt: string;
  participantCount: number; awards: CarnivalRoundAward[];
}
export interface CarnivalGlobalContribution { characterId: number; count: number; walletRevision: number }
export interface CarnivalGlobalState {
  version: 1; kind: "carnival-native-global-state"; rulesVersion: 1; totalDraws: number;
  contributions: CarnivalGlobalContribution[]; recentRounds: CarnivalRoundResult[];
}
export interface CarnivalNativeGlobal {
  version: 1; kind: "carnival-native-global"; scope: "local-server"; revision: number; actorRevision: number;
  roundId: number; roundDraws: number; roundTarget: 100; totalDraws: number; participantCount: number; myRoundDraws: number;
  pool: { templateId: 11019; itemCount: number; contributionPerDraw: 1 };
  roundRewards: { slot: 1 | 2; templateId: number; itemCount: number }[]; recentRounds: CarnivalRoundResult[];
}
function need(ok: unknown, message = "共享狂欢存档或版本无效。", status = 503): asserts ok {
  if (!ok) throw new ActivityError(message, status);
}
const int = (v: unknown, min = 0, max = LIMIT): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const object = (v: unknown, fields: string[]): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const name = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && v.trim().length > 0;
function iso(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
/** Empty is an in-memory projection only. The service inserts the singleton inside a fresh draw transaction. */
export function readCarnivalGlobalState(value: unknown): CarnivalGlobalState {
  if (value === undefined) return { version: 1, kind: "carnival-native-global-state", rulesVersion: 1,
    totalDraws: 0, contributions: [], recentRounds: [] };
  need(object(value, ["version", "kind", "rulesVersion", "totalDraws", "contributions", "recentRounds"])
    && value.version === 1 && value.kind === "carnival-native-global-state" && value.rulesVersion === 1 && int(value.totalDraws));
  const total = value.totalDraws, remainder = total % 100, completed = Math.floor(total / 100);
  need(Array.isArray(value.contributions) && value.contributions.length <= remainder);
  let count = 0, lastId = 0;
  for (const row of value.contributions) {
    need(object(row, ["characterId", "count", "walletRevision"]) && int(row.characterId, lastId + 1)
      && int(row.count, 1, 99) && int(row.walletRevision, 1));
    count += row.count; lastId = row.characterId;
  }
  need(count === remainder);
  need(Array.isArray(value.recentRounds) && value.recentRounds.length === Math.min(10, completed));
  for (let index = 0; index < value.recentRounds.length; index++) {
    const r = value.recentRounds[index];
    need(object(r, ["type", "roundId", "globalRevision", "settledAt", "participantCount", "awards"])
      && r.type === "round-completed" && r.roundId === completed - index && r.globalRevision === Number(r.roundId) * 100
      && iso(r.settledAt) && int(r.participantCount, 1, 100) && Array.isArray(r.awards) && r.awards.length === 3);
    for (let slot = 0; slot < awards.length; slot++) {
      const a = r.awards[slot], expected = awards[slot];
      need(object(a, ["slot", "characterId", "nickName", "templateId", "itemCount"]) && a.slot === slot
        && int(a.characterId, 1) && name(a.nickName) && a.templateId === expected.templateId && a.itemCount === expected.itemCount);
    }
  }
  return structuredClone(value) as unknown as CarnivalGlobalState;
}
/** Never publishes contribution weights or wallet revisions. A stale actor snapshot is withheld. */
export function viewCarnivalGlobal(value: unknown, characterId: number, actorRevision: number): CarnivalNativeGlobal | null {
  need(int(characterId, 1) && int(actorRevision), "共享狂欢角色版本无效。");
  const state = readCarnivalGlobalState(value), mine = state.contributions.find(row => row.characterId === characterId);
  if (mine && mine.walletRevision > actorRevision) return null;
  const roundDraws = state.totalDraws % 100;
  return { version: 1, kind: "carnival-native-global", scope: "local-server", revision: state.totalDraws, actorRevision,
    roundId: Math.floor(state.totalDraws / 100) + 1, roundDraws, roundTarget: 100, totalDraws: state.totalDraws,
    participantCount: state.contributions.length, myRoundDraws: mine?.count ?? 0,
    pool: { templateId: 11019, itemCount: roundDraws, contributionPerDraw: 1 },
    roundRewards: [{ slot: 1, templateId: 11021, itemCount: 2 }, { slot: 2, templateId: 11002, itemCount: 2 }],
    recentRounds: state.recentRounds };
}
export interface CarnivalGlobalInput {
  characterId: number; walletRevision: number; draws: number; now: Date;
  eligibleParticipants: { characterId: number; nickName: string }[];
}
export interface CarnivalGlobalAdvance {
  state: CarnivalGlobalState; worldEffects: CarnivalRoundResult[];
  rewards: { characterId: number; rewards: ActivityReward[] }[];
}
/** Caller owns actor-wallet -> global-row locks and all mail/receipt work in the same transaction. */
export function advanceCarnivalGlobal(value: unknown, input: CarnivalGlobalInput, rng: () => number): CarnivalGlobalAdvance {
  need(input && int(input.characterId, 1) && int(input.walletRevision, 1) && int(input.draws, 1, 5)
    && input.now instanceof Date && Number.isFinite(input.now.getTime()) && Array.isArray(input.eligibleParticipants)
    && input.eligibleParticipants.length <= 100, "共享狂欢请求无效。", 400);
  const eligible = new Map<number, string>();
  for (const row of input.eligibleParticipants) {
    need(object(row, ["characterId", "nickName"]) && int(row.characterId, 1) && name(row.nickName)
      && !eligible.has(row.characterId), "共享狂欢参与角色无效。", 400);
    eligible.set(row.characterId, row.nickName);
  }
  const state = readCarnivalGlobalState(value), worldEffects: CarnivalRoundResult[] = [];
  const recipients = new Map<number, ActivityReward[]>();
  need(state.totalDraws + input.draws <= LIMIT, "本地共享狂欢次数已达上限。", 409);
  const previous = state.contributions.find(row => row.characterId === input.characterId);
  need(!previous || input.walletRevision > previous.walletRevision, "共享狂欢角色版本已更新。", 409);
  for (let n = 0; n < input.draws; n++) {
    const mine = state.contributions.find(row => row.characterId === input.characterId);
    if (mine) {
      // A finite batch uses one new wallet revision, including all its contributions.
      mine.count++; mine.walletRevision = input.walletRevision;
    } else state.contributions.push({ characterId: input.characterId, count: 1, walletRevision: input.walletRevision });
    state.contributions.sort((a, b) => a.characterId - b.characterId);
    state.totalDraws++;
    if (state.totalDraws % 100 !== 0) continue;
    const all = state.contributions.filter(row => eligible.has(row.characterId));
    need(all.length > 0, "本轮没有可交付的真实参与角色。", 409);
    let candidates = all.slice();
    const roundAwards: CarnivalRoundAward[] = [];
    for (const prize of awards) {
      if (!candidates.length) candidates = all.slice();
      const sample = rng(); need(Number.isFinite(sample) && sample >= 0 && sample < 1, "共享狂欢随机源无效。", 503);
      let target = sample * candidates.reduce((sum, row) => sum + row.count, 0);
      const selected = candidates.find(row => (target -= row.count) < 0)!;
      need(selected, "共享狂欢随机源无效。");
      roundAwards.push({ ...prize, characterId: selected.characterId, nickName: eligible.get(selected.characterId)! });
      const rewards = recipients.get(selected.characterId) ?? [];
      rewards.push({ templateId: prize.templateId, count: prize.itemCount }); recipients.set(selected.characterId, rewards);
      candidates = candidates.filter(row => row.characterId !== selected.characterId);
    }
    const result: CarnivalRoundResult = { type: "round-completed", roundId: state.totalDraws / 100,
      globalRevision: state.totalDraws, settledAt: input.now.toISOString(), participantCount: state.contributions.length, awards: roundAwards };
    state.recentRounds.unshift(result); state.recentRounds = state.recentRounds.slice(0, 10);
    worldEffects.push(structuredClone(result)); state.contributions = [];
  }
  return { state: readCarnivalGlobalState(state), worldEffects, rewards: [...recipients].map(([characterId, rewards]) => ({ characterId, rewards })) };
}
