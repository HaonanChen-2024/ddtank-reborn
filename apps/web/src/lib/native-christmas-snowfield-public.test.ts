import { describe, expect, it } from "vitest";
import { parseChristmasSnowfieldAction, validChristmasSnowfieldEffect, validChristmasSnowfieldPublic, type ChristmasSnowfieldPublic } from "./native-christmas-snowfield-public";

const choice = "2026-10-15." + "A".repeat(43), sceneHash = "B".repeat(43);
const wallet = { day: "2026-10-15", revision: 2, points: 500, earned: 500 };
const prize = (templateId: number) => ({ templateId, name: "本地材料", itemCount: 1 as const, bound: true as const, validDays: 0 as const });
function view(): ChristmasSnowfieldPublic {
  return { version: 1, kind: "christmas-snowfield", rulesVersion: 1, catalogVersion: "christmas-snowfield-local-v1", day: wallet.day, revision: wallet.revision, points: wallet.points,
    taskEarned: wallet.earned, serverNow: "2026-10-15T00:05:00.000Z", authority: "online", available: true, reason: "本地雪场", stateToken: choice, currency: "local-task-points",
    entry: { available: true, reason: "可以入场" },
    ticket: { claimKey: "task:2026-10-15:sign", qualifiedToday: true, issuedToday: true, issuedAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-15T00:30:00.000Z", valid: true, durationSeconds: 1800 },
    scene: { revision: sceneHash, state: "inside", people: 1, capacity: 20, canResume: false, reason: "雪场中" },
    challenges: [11019, 11001, 11021].map((id, i) => ({ index: i, type: i, title: "本地雪人", monsterId: 100 + i, state: "alive",
      originalMissionId: 40001 + i, localPveId: 164001 + i, battleMapId: 1201, usedToday: 0, remainingToday: 3, limit: 3, canChallenge: true, reason: "可以挑战", reward: prize(id) })),
    attempt: { state: "none", type: null, canResume: false, refundPending: false, reason: "没有待启动挑战" },
    npc: { hasSettledWinToday: false, claimed: false, canClaim: false, reason: "等待首胜", reward: prize(11002) }, rules: ["明确本地规则"],
    unavailable: [{ id: "original-economy", reason: "不接原服经济" }, { id: "original-mission-rules", reason: "本地1201战斗地图" }] };
}
const valid = (p: ChristmasSnowfieldPublic) => validChristmasSnowfieldPublic(p, wallet, p.entry);
const entered = () => ({ type: "entered", issued: true, issuedAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-15T00:30:00.000Z", committedRevision: 2, committedSceneRevision: sceneHash });

describe("Christmas snowfield F2 public contract", () => {
  it("parses only the three closed actions with a complete real-day token", () => {
    for (const action of [{ type: "enter", choice }, { type: "npc-claim", choice }, ...[0, 1, 2].map(index => ({ type: "challenge", index, choice }))])
      expect(parseChristmasSnowfieldAction(action)).toEqual(action);
    for (const action of [{ type: "enter", choice, count: 1 }, { type: "npc-claim", choice, index: 0 }, { type: "challenge", choice },
      { type: "challenge", choice, index: "1" }, { type: "challenge", choice, index: -1 }, { type: "challenge", choice, index: 3 },
      { type: "challenge", choice, index: 0, monsterId: 100 }, { type: "enter", choice: choice.slice(0, -1) },
      { type: "enter", choice: choice.replace("10-15", "02-30") }, { type: ["enter"], choice }, { type: ["challenge"], index: 0, choice }, Object.create({ type: "enter", choice })]) expect(parseChristmasSnowfieldAction(action)).toBeNull();
  });
  it("accepts the ordered three rows and exactly paired wallet and entry", () => {
    const p = view(); expect(valid(p)).toBe(true);
    for (const change of [{ day: "2026-10-16" }, { revision: 3 }, { points: 499 }, { earned: 499 }])
      expect(validChristmasSnowfieldPublic(p, { ...wallet, ...change }, p.entry)).toBe(false);
    expect(validChristmasSnowfieldPublic(p, wallet, { ...p.entry, available: false })).toBe(false);
    expect(validChristmasSnowfieldPublic(p, wallet, { ...p.entry, reason: "旧原因" })).toBe(false);
  });
  it("accepts a still-valid prior-day ticket and a once-issued expired ticket without renewal", () => {
    const p = view(); p.ticket.issuedToday = false; p.ticket.issuedAt = "2026-10-14T23:50:00.000Z"; p.ticket.expiresAt = "2026-10-15T00:20:00.000Z";
    expect(valid(p)).toBe(true); p.serverNow = "2026-10-15T00:21:00.000Z"; p.ticket.valid = false; p.entry.available = false;
    p.challenges.forEach(c => { c.canChallenge = false; }); expect(valid(p)).toBe(true);
  });
  it("keeps earned NPC claims independent of an expired entry ticket", () => {
    const p = view(); p.serverNow = "2026-10-15T01:00:00.000Z"; p.ticket.valid = false; p.entry.available = false;
    p.challenges.forEach(c => { c.canChallenge = false; }); p.npc.hasSettledWinToday = true; p.npc.canClaim = true;
    expect(valid(p)).toBe(true);
  });
  it("accepts quota-three retry only for the same-type definitely-unlaunched refund", () => {
    const p = view(), c = p.challenges[1]!; c.usedToday = 3; c.remainingToday = 0;
    expect(valid(p)).toBe(false); Object.assign(p.attempt, { state: "admitted", type: 1, refundPending: true }); expect(valid(p)).toBe(true);
    p.attempt.type = 2; expect(valid(p)).toBe(false);
  });
  it("accepts a complete offline catalogue and an empty unreachable skeleton with preserved wallet", () => {
    const p = view(); p.authority = "offline"; p.available = false; p.stateToken = null; p.entry.available = false;
    p.challenges.forEach(c => { c.canChallenge = false; }); expect(valid(p)).toBe(true);
    p.authority = "unavailable"; p.challenges = []; p.npc.reward = null;
    Object.assign(p.ticket, { qualifiedToday: false, issuedToday: false, issuedAt: null, expiresAt: null, valid: false });
    Object.assign(p.scene, { revision: null, state: "outside", people: 0 }); expect(valid(p)).toBe(true);
    p.npc.canClaim = true; expect(valid(p)).toBe(false);
  });
  it.each(["private-root", "private-ticket", "private-scene", "private-attempt", "private-row", "private-reward", "wrong-order", "wrong-mission", "wrong-local", "wrong-map", "wrong-prize", "bad-quota", "bad-time", "expired-valid", "bad-hash", "null-hash", "mixed-empty", "offline-action", "bad-token", "wrong-day", "wrong-authority", "wrong-claim", "unknown-rule"])("rejects %s", kind => {
    const p = view();
    if (kind === "private-root") Object.assign(p, { serverInstance: "private" });
    if (kind === "private-ticket") Object.assign(p.ticket, { receiptId: "private" });
    if (kind === "private-scene") Object.assign(p.scene, { members: [] });
    if (kind === "private-attempt") Object.assign(p.attempt, { attemptId: "private" });
    if (kind === "private-row") Object.assign(p.challenges[0]!, { generation: 1 });
    if (kind === "private-reward") Object.assign(p.challenges[0]!.reward, { mailId: 1 });
    if (kind === "wrong-order") p.challenges.reverse();
    if (kind === "wrong-mission") p.challenges[0]!.originalMissionId = 40002;
    if (kind === "wrong-local") p.challenges[0]!.localPveId = 40001;
    if (kind === "wrong-map") Object.assign(p.challenges[0]!, { battleMapId: 70022 });
    if (kind === "wrong-prize") p.challenges[0]!.reward.templateId = 11002;
    if (kind === "bad-quota") p.challenges[0]!.remainingToday = 2;
    if (kind === "bad-time") p.ticket.expiresAt = "2026-10-15T00:31:00.000Z";
    if (kind === "expired-valid") p.serverNow = p.ticket.expiresAt!;
    if (kind === "bad-hash") p.scene.revision = "B".repeat(42);
    if (kind === "null-hash") p.scene.revision = null;
    if (kind === "mixed-empty") p.challenges = [];
    if (kind === "offline-action") { p.authority = "offline"; p.available = false; p.stateToken = null; p.entry.available = false; }
    if (kind === "bad-token") p.stateToken = "2026-10-14." + "A".repeat(43);
    if (kind === "wrong-day") p.serverNow = "2026-10-16T00:00:00.000Z";
    if (kind === "wrong-authority") Object.assign(p, { authority: "future" });
    if (kind === "wrong-claim") p.npc.claimed = true;
    if (kind === "unknown-rule") Object.assign(p.unavailable[0]!, { id: "new-rule" });
    expect(valid(p)).toBe(false);
  });
  it.each(["authority", "scene", "attempt", "monster"])("rejects array-coerced %s even when all operation gates are closed", kind => {
    const p = view(); p.challenges.forEach(c => { c.canChallenge = false; });
    if (kind === "authority") { Object.assign(p, { authority: ["offline"], available: false, stateToken: null }); p.entry.available = false; }
    if (kind === "scene") Object.assign(p.scene, { state: ["inside"] });
    if (kind === "attempt") Object.assign(p.attempt, { state: ["admitted"], type: 0 });
    if (kind === "monster") Object.assign(p.challenges[0]!, { state: ["alive"] });
    expect(valid(p)).toBe(false);
  });
  it("accepts only the committed loading phase for an entered effect", () => {
    const p = view(), e = entered(); Object.assign(p.scene, { state: "loading", canResume: true }); p.challenges.forEach(c => { c.canChallenge = false; });
    expect(valid(p)).toBe(true); expect(validChristmasSnowfieldEffect(e, { type: "enter", choice }, p, 0)).toBe(true);
    p.scene.canResume = false; expect(validChristmasSnowfieldEffect(e, { type: "enter", choice }, p, 0)).toBe(false);
  });
  it.each([0, 1, 2])("accepts committed challenge row %s and rejects mismatched identities", index => {
    const p = view(), c = p.challenges[index]!; Object.assign(c, { state: "reserved", usedToday: 1, remainingToday: 2, canChallenge: false });
    Object.assign(p.attempt, { state: "admitted", type: index, canResume: true });
    const e = { type: "challenged", index, monsterId: c.monsterId, originalMissionId: c.originalMissionId, localPveId: c.localPveId, usedToday: 1, committedRevision: 2, committedSceneRevision: sceneHash };
    expect(valid(p)).toBe(true); expect(validChristmasSnowfieldEffect(e, { type: "challenge", index, choice }, p, 0)).toBe(true);
    expect(validChristmasSnowfieldEffect({ ...e, monsterId: 999 }, { type: "challenge", index, choice }, p, 0)).toBe(false);
    expect(validChristmasSnowfieldEffect({ ...e, usedToday: 2 }, { type: "challenge", index, choice }, p, 0)).toBe(false);
    p.attempt.canResume = false; expect(validChristmasSnowfieldEffect(e, { type: "challenge", index, choice }, p, 0)).toBe(false);
  });
  it("accepts the settled NPC claim with canClaim false and no live ticket", () => {
    const p = view(); p.serverNow = "2026-10-15T01:00:00.000Z"; p.ticket.valid = false; p.entry.available = false;
    p.challenges.forEach(c => { c.canChallenge = false; }); Object.assign(p.npc, { hasSettledWinToday: true, claimed: true });
    const e = { type: "npc-claimed", rewards: [prize(11002)], committedRevision: 2, committedSceneRevision: sceneHash };
    expect(valid(p)).toBe(true); expect(validChristmasSnowfieldEffect(e, { type: "npc-claim", choice }, p, 1)).toBe(true);
    expect(validChristmasSnowfieldEffect(e, { type: "npc-claim", choice }, p, 0)).toBe(false);
    expect(validChristmasSnowfieldEffect({ ...e, rewards: [prize(11019)] }, { type: "npc-claim", choice }, p, 1)).toBe(false);
  });
  it.each(["revision", "scene", "day", "mail", "private", "stale-ticket", "unavailable"])("rejects fresh entered %s mismatch", kind => {
    const p = view(), e = entered(); Object.assign(p.scene, { state: "loading", canResume: true });
    let mailedCount = 0, actionChoice = choice;
    if (kind === "revision") e.committedRevision = 1;
    if (kind === "scene") e.committedSceneRevision = "C".repeat(43);
    if (kind === "day") actionChoice = "2026-10-14." + "A".repeat(43);
    if (kind === "mail") mailedCount = 1;
    if (kind === "private") Object.assign(e, { admissionId: "private" });
    if (kind === "stale-ticket") { e.issuedAt = "2026-10-14T23:50:00.000Z"; e.expiresAt = "2026-10-15T00:20:00.000Z"; }
    if (kind === "unavailable") p.available = false;
    expect(validChristmasSnowfieldEffect(e, { type: "enter", choice: actionChoice }, p, mailedCount)).toBe(false);
  });
});
