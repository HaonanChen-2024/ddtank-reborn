import type { ActivityAction, ActivityResponse } from "./activities";

// F2 public-only contract. Admission, tickets, combat and rewards remain server-owned.
interface SnowfieldReward { templateId: number; name: string; itemCount: 1; bound: true; validDays: 0 }
export interface ChristmasSnowfieldPublic {
  version: 1; kind: "christmas-snowfield"; rulesVersion: 1; catalogVersion: "christmas-snowfield-local-v1";
  day: string; serverNow: string; revision: number; authority: "online" | "offline" | "unavailable";
  available: boolean; reason: string; stateToken: string | null; currency: "local-task-points"; points: number; taskEarned: number;
  entry: { available: boolean; reason: string };
  ticket: { claimKey: string; qualifiedToday: boolean; issuedToday: boolean; issuedAt: string | null; expiresAt: string | null; valid: boolean; durationSeconds: 1800 };
  scene: { revision: string | null; state: "outside" | "loading" | "inside" | "fighting" | "settling"; people: number; capacity: 20; canResume: boolean; reason: string };
  challenges: { index: number; type: number; title: string; monsterId: number | null; state: "unavailable" | "alive" | "reserved" | "fighting" | "dead";
    originalMissionId: number; localPveId: number; battleMapId: 1201; usedToday: number; remainingToday: number; limit: 3; canChallenge: boolean; reason: string; reward: SnowfieldReward }[];
  attempt: { state: "none" | "admitted" | "launching" | "fighting" | "settling"; type: number | null; canResume: boolean; refundPending: boolean; reason: string };
  npc: { hasSettledWinToday: boolean; claimed: boolean; canClaim: boolean; reason: string; reward: SnowfieldReward | null };
  rules: string[]; unavailable: { id: "original-economy" | "original-mission-rules"; reason: string }[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const int = (v: unknown, min = 0, max = 2_147_483_647): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 1000;
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const digest = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const token = (v: unknown): v is string => typeof v === "string" && day(v.slice(0, 10)) && v[10] === "." && digest(v.slice(11));
const reward = (v: unknown, templateId: number): boolean => object(v) && exact(v, ["templateId", "name", "itemCount", "bound", "validDays"])
  && v.templateId === templateId && text(v.name) && v.itemCount === 1 && v.bound === true && v.validDays === 0;

export function parseChristmasSnowfieldAction(v: unknown): ActivityAction | null {
  if (!object(v) || !token(v.choice)) return null;
  if ((v.type === "enter" || v.type === "npc-claim") && exact(v, ["type", "choice"])) return { type: v.type, choice: v.choice };
  if (v.type === "challenge" && exact(v, ["type", "index", "choice"]) && int(v.index, 0, 2)) return { type: v.type, index: v.index, choice: v.choice };
  return null;
}

export function validChristmasSnowfieldPublic(v: unknown, snapshot: Pick<ActivityResponse, "day" | "revision" | "points" | "earned">,
  mirror: Record<string, unknown>): v is ChristmasSnowfieldPublic {
  if (!object(v) || !exact(v, ["version", "kind", "rulesVersion", "catalogVersion", "day", "serverNow", "revision", "authority", "available", "reason", "stateToken", "currency", "points", "taskEarned", "entry", "ticket", "scene", "challenges", "attempt", "npc", "rules", "unavailable"])
    || v.version !== 1 || v.kind !== "christmas-snowfield" || v.rulesVersion !== 1 || v.catalogVersion !== "christmas-snowfield-local-v1"
    || !day(v.day) || v.day !== snapshot.day || !instant(v.serverNow) || v.serverNow.slice(0, 10) !== v.day
    || !int(v.revision) || v.revision !== snapshot.revision || typeof v.authority !== "string" || !["online", "offline", "unavailable"].includes(v.authority)
    || typeof v.available !== "boolean" || !text(v.reason) || (v.available ? v.authority !== "online" || !token(v.stateToken) || !v.stateToken.startsWith(v.day + ".") : v.stateToken !== null)
    || v.currency !== "local-task-points" || !int(v.points) || v.points !== snapshot.points || !int(v.taskEarned) || v.taskEarned !== snapshot.earned) return false;
  const e = v.entry, t = v.ticket, s = v.scene, a = v.attempt, n = v.npc;
  if (!object(e) || !exact(e, ["available", "reason"]) || typeof e.available !== "boolean" || !text(e.reason) || e.available && !v.available
    || !exact(mirror, ["available", "reason"]) || e.available !== mirror.available || e.reason !== mirror.reason
    || !object(t) || !exact(t, ["claimKey", "qualifiedToday", "issuedToday", "issuedAt", "expiresAt", "valid", "durationSeconds"])
    || t.claimKey !== `task:${v.day}:sign` || ![t.qualifiedToday, t.issuedToday, t.valid].every(x => typeof x === "boolean") || t.durationSeconds !== 1800
    || !(t.issuedAt === null && t.expiresAt === null || instant(t.issuedAt) && instant(t.expiresAt) && Date.parse(t.expiresAt) - Date.parse(t.issuedAt) === 1_800_000)
    || t.issuedToday && (!instant(t.issuedAt) || t.issuedAt.slice(0, 10) !== v.day)
    || t.valid && (!instant(t.issuedAt) || !instant(t.expiresAt) || Date.parse(t.issuedAt) > Date.parse(v.serverNow) || Date.parse(t.expiresAt) <= Date.parse(v.serverNow))
    || !object(s) || !exact(s, ["revision", "state", "people", "capacity", "canResume", "reason"])
    || !(digest(s.revision) || s.revision === null && v.authority === "unavailable") || typeof s.state !== "string" || !["outside", "loading", "inside", "fighting", "settling"].includes(s.state)
    || !int(s.people, 0, 20) || s.capacity !== 20 || typeof s.canResume !== "boolean" || !text(s.reason) || s.canResume && (!v.available || !t.valid || s.state !== "loading")
    || !object(a) || !exact(a, ["state", "type", "canResume", "refundPending", "reason"])
    || typeof a.state !== "string" || !["none", "admitted", "launching", "fighting", "settling"].includes(a.state) || !(a.state === "none" ? a.type === null : int(a.type, 0, 2))
    || ![a.canResume, a.refundPending].every(x => typeof x === "boolean") || !text(a.reason) || a.canResume && (!v.available || !t.valid || a.state !== "admitted" || s.state !== "inside")
    || !object(n) || !exact(n, ["hasSettledWinToday", "claimed", "canClaim", "reason", "reward"])
    || ![n.hasSettledWinToday, n.claimed, n.canClaim].every(x => typeof x === "boolean") || !text(n.reason)
    || n.claimed && !n.hasSettledWinToday || n.canClaim && (!v.available || !n.hasSettledWinToday || n.claimed)
    || !Array.isArray(v.rules) || v.rules.length < 1 || v.rules.length > 20 || !v.rules.every(text)
    || !Array.isArray(v.unavailable) || v.unavailable.length !== 2 || !v.unavailable.every((u, i) => object(u) && exact(u, ["id", "reason"]) && u.id === ["original-economy", "original-mission-rules"][i] && text(u.reason))
    || !Array.isArray(v.challenges)) return false;
  if (v.challenges.length === 0) return v.authority === "unavailable" && !v.available && !e.available && s.revision === null && s.state === "outside"
    && s.people === 0 && !s.canResume && !t.qualifiedToday && !t.issuedToday && t.issuedAt === null && !t.valid
    && a.state === "none" && !a.canResume && !a.refundPending && !n.hasSettledWinToday && !n.claimed && !n.canClaim && n.reward === null;
  return reward(n.reward, 11002) && v.challenges.length === 3 && v.challenges.every((c, i) => object(c)
    && exact(c, ["index", "type", "title", "monsterId", "state", "originalMissionId", "localPveId", "battleMapId", "usedToday", "remainingToday", "limit", "canChallenge", "reason", "reward"])
    && c.index === i && c.type === i && text(c.title) && (c.monsterId === null || int(c.monsterId, 1)) && typeof c.state === "string" && ["unavailable", "alive", "reserved", "fighting", "dead"].includes(c.state)
    && c.originalMissionId === 40001 + i && c.localPveId === 164001 + i && c.battleMapId === 1201 && int(c.usedToday, 0, 3)
    && c.remainingToday === 3 - Number(c.usedToday) && c.limit === 3 && typeof c.canChallenge === "boolean" && text(c.reason) && reward(c.reward, [11019, 11001, 11021][i]!)
    && (!c.canChallenge || v.available && t.valid && s.state === "inside" && c.state === "alive" && c.monsterId !== null && (Number(c.remainingToday) > 0 || a.refundPending && a.type === i)));
}

export function validChristmasSnowfieldEffect(v: unknown, action: ActivityAction, field: ChristmasSnowfieldPublic, mailedCount: unknown): boolean {
  if (!field.available || field.authority !== "online" || !object(v) || v.committedRevision !== field.revision || !int(v.committedRevision, 1)
    || !digest(v.committedSceneRevision) || v.committedSceneRevision !== field.scene.revision || !token(action.choice) || !action.choice.startsWith(field.day + ".")) return false;
  if (action.type === "enter") return exact(v, ["type", "issued", "issuedAt", "expiresAt", "committedRevision", "committedSceneRevision"])
    && v.type === "entered" && typeof v.issued === "boolean" && instant(v.issuedAt) && instant(v.expiresAt) && v.issuedAt === field.ticket.issuedAt && v.expiresAt === field.ticket.expiresAt
    && Date.parse(v.expiresAt) - Date.parse(v.issuedAt) === 1_800_000 && field.scene.canResume && mailedCount === 0;
  if (action.type === "challenge") {
    if (!int(action.index, 0, 2)) return false;
    const c = field.challenges[action.index];
    return !!c && exact(v, ["type", "index", "monsterId", "originalMissionId", "localPveId", "usedToday", "committedRevision", "committedSceneRevision"])
      && v.type === "challenged" && v.index === action.index && int(v.monsterId, 1) && v.monsterId === c.monsterId
      && v.originalMissionId === c.originalMissionId && v.localPveId === c.localPveId && int(v.usedToday, 1, 3) && v.usedToday === c.usedToday
      && field.attempt.canResume && field.attempt.type === action.index && mailedCount === 0;
  }
  return action.type === "npc-claim" && exact(v, ["type", "rewards", "committedRevision", "committedSceneRevision"])
    && v.type === "npc-claimed" && Array.isArray(v.rewards) && v.rewards.length === 1 && reward(v.rewards[0], 11002)
    && field.npc.hasSettledWinToday && field.npc.claimed && int(mailedCount, 1, 1000);
}
