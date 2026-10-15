import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { getToken: () => "test-token" } }));
import { readPendingActivity, type ActivityResponse } from "./activities";
import type { NativeActivityHost } from "./native-activity-host";
import { attachNativeChristmasHost, type NativeChristmasCallbackTarget, type NativeChristmasEnvelope } from "./native-christmas-host";
import type { ChristmasSnowfieldPublic } from "./native-christmas-snowfield-public";

const fetchMock = vi.fn<typeof fetch>(), hosts: NativeActivityHost[] = [];
const choice = "2026-10-15." + "A".repeat(43), materials = [11019, 11001, 11021, 11002], quantities = [3, 5, 8, 2];
const reward = (tier: number) => ({ templateId: materials[tier - 1], itemCount: quantities[tier - 1], name: "本地材料", bound: true, validDays: 0 });
function projection(options: { count?: number; exp?: number; used?: number; points?: number; cycle?: number; revision?: number; actions?: number; completed?: boolean[]; authority?: string; claimed?: boolean[] } = {}) {
  const { count = 0, exp = 0, used = 0, points = 500, cycle = 0, revision = 2, actions = 500,
    completed = [true, true, true, true], authority = "online", claimed = [false, false, false] } = options;
  const available = authority === "online", entitlement = [5, 10, 10, 5].reduce((sum, packs, i) => sum + (completed[i] ? packs : 0), 0), balance = entitlement - used;
  const quotes = [false, true].flatMap(double => Array.from({ length: 10 }, (_, i) => {
    const n = i + 1, xp = n * (double ? 2 : 1), cost = double ? n * 2 : 0;
    const canCraft = available && actions > 0 && balance >= n && points >= cost && count + Math.floor((exp + xp) / 10) <= 1_000_000_000;
    return { count: n, double, resourceCost: n, pointCost: cost, experienceGained: xp, canCraft, reason: canCraft ? "可以制作" : "当前不可制作" };
  }));
  return { version: 1, kind: "christmas-native", rulesVersion: 1, catalogVersion: "christmas-snowman-local-v1",
    day: "2026-10-15", revision, authority, available, reason: available ? "" : "角色不可用", stateToken: available ? choice : null,
    activity: { open: true, beginAt: "1970-01-01T00:00:00.000Z", endAt: "2099-12-31T23:59:59.999Z", title: "本地常驻圣诞活动" },
    snowfield: { available: false, reason: "雪场战斗尚未移植" }, currency: "local-task-points", points, taskEarned: 500, dailyActionsRemaining: actions,
    snowman: { resource: "local-task-snowpacks", resourceLabel: "本地任务雪包", balance, entitlement, usedToday: used, count, exp, totalExp: 10,
      maxCount: Math.max(0, ...quotes.filter(q => !q.double && q.canCraft).map(q => q.count)),
      maxDoubleCount: Math.max(0, ...quotes.filter(q => q.double && q.canCraft).map(q => q.count)),
      tasks: ["sign", "mines", "pair", "explore"].map((id, i) => ({ id, claimKey: `task:2026-10-15:${id}`, completed: completed[i], packs: [5, 10, 10, 5][i] })), quotes },
    rewards: [1, 2, 3, 4].map(tier => {
      const repeated = tier === 4, nextTarget = repeated ? 6 + 2 * (cycle + 1) : [1, 3, 6][tier - 1]!;
      const isClaimed = repeated ? false : claimed[tier - 1]!;
      const canClaim = available && !isClaimed && count >= nextTarget && (!repeated || cycle < 499_999_998);
      return { tier, title: "雪人进度礼", repeatable: repeated, threshold: repeated ? 6 : nextTarget, cycle: repeated ? cycle : 0,
        nextTarget, claimed: isClaimed, canClaim, reason: canClaim ? "可以领取" : "当前不可领取", reward: reward(tier) };
    }), rules: ["本地任务资格，不接真实付款"], unavailable: ["original-economy", "snowfield", "official-snowpacks"].map(id => ({ id, reason: "原后台未接入" })) };
}
function unavailable() {
  const p = projection({ authority: "unavailable", completed: [false, false, false, false] });
  p.snowman.tasks = []; p.snowman.quotes = []; p.rewards = []; return p;
}
const snapshot = (id: number, p = projection(), extra: Partial<ActivityResponse> = {}): ActivityResponse => ({
  characterId: id, points: p.points, earned: p.taskEarned, revision: p.revision, day: p.day,
  activities: [], tasks: [], history: [], nativeChristmas: p, ...extra,
});
const sceneHash = "B".repeat(43);
const snowPrize = (templateId: number) => ({ templateId, name: "本地材料", itemCount: 1 as const, bound: true as const, validDays: 0 as const });
function snowfield(): ChristmasSnowfieldPublic {
  return { version: 1, kind: "christmas-snowfield", rulesVersion: 1, catalogVersion: "christmas-snowfield-local-v1", day: "2026-10-15", revision: 2,
    serverNow: "2026-10-15T00:05:00.000Z", authority: "online", available: true, reason: "本地雪场", stateToken: choice, currency: "local-task-points", points: 500, taskEarned: 500,
    entry: { available: true, reason: "可以入场" },
    ticket: { claimKey: "task:2026-10-15:sign", qualifiedToday: true, issuedToday: true, issuedAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-15T00:30:00.000Z", valid: true, durationSeconds: 1800 },
    scene: { revision: sceneHash, state: "inside", people: 1, capacity: 20, canResume: false, reason: "雪场中" },
    challenges: [11019, 11001, 11021].map((id, index) => ({ index, type: index, title: "本地雪人", monsterId: 100 + index, state: "alive",
      originalMissionId: 40001 + index, localPveId: 164001 + index, battleMapId: 1201, usedToday: 0, remainingToday: 3, limit: 3, canChallenge: true, reason: "可以挑战", reward: snowPrize(id) })),
    attempt: { state: "none", type: null, canResume: false, refundPending: false, reason: "没有挑战" },
    npc: { hasSettledWinToday: false, claimed: false, canClaim: false, reason: "等待首胜", reward: snowPrize(11002) }, rules: ["本地规则"],
    unavailable: [{ id: "original-economy", reason: "本地经济" }, { id: "original-mission-rules", reason: "本地1201地图" }] };
}
function snowResult(type: "enter" | "challenge" | "npc-claim", index = 0) {
  const p = projection(), f = snowfield(), action = type === "challenge" ? { type, index, choice } : { type, choice };
  let effect: Record<string, unknown>;
  if (type === "enter") {
    Object.assign(f.scene, { state: "loading", canResume: true }); f.challenges.forEach(c => { c.canChallenge = false; });
    effect = { type: "entered", issued: true, issuedAt: f.ticket.issuedAt, expiresAt: f.ticket.expiresAt };
  } else if (type === "challenge") {
    const c = f.challenges[index]!; Object.assign(c, { state: "reserved", usedToday: 1, remainingToday: 2, canChallenge: false });
    Object.assign(f.attempt, { state: "admitted", type: index, canResume: true });
    effect = { type: "challenged", index, monsterId: c.monsterId, originalMissionId: c.originalMissionId, localPveId: c.localPveId, usedToday: 1 };
  } else {
    Object.assign(f.npc, { hasSettledWinToday: true, claimed: true }); effect = { type: "npc-claimed", rewards: [snowPrize(11002)] };
  }
  p.snowfield = { ...f.entry }; Object.assign(effect, { committedRevision: 2, committedSceneRevision: sceneHash });
  return { p, f, action, effect, mailedCount: type === "npc-claim" ? 1 : 0 };
}
let idCounter = 3900;
function setup() {
  const id = ++idCounter, generation = "christmas-" + id, target: NativeChristmasCallbackTarget = {};
  let current = true;
  const accept = vi.fn((e: NativeChristmasEnvelope): unknown => ({ characterId: id, generation, sequence: e.sequence, pending: false, revision: e.snapshot!.revision }));
  const reject = vi.fn(), host = attachNativeChristmasHost({ characterId: id, generation, target, isCurrent: () => current,
    player: { workshopChristmasAcceptSnapshot: accept, workshopChristmasRejectRequest: reject } });
  hosts.push(host);
  return { id, generation, target, host, accept, reject, cancelRole: () => { current = false; },
    request: (action: unknown, sequence = 1) => target.workshopChristmasRequest!(id, generation, sequence, action) };
}
const response = (v: unknown) => new Response(JSON.stringify(v));
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
const staleEffects = () => Object.fromEntries(["Pair", "Mines", "DDPlay", "Gypsy", "Moonlight", "Treasure", "Wheel", "Carnival", "FirstRecharge", "Charge", "Forthright", "Exchange", "Devil", "CaveLoot", "Christmas"].map(n => ["native" + n + "Action", { requestId: "old", effects: ["old"] }]));
beforeEach(() => {
  const store = new Map<string, string>(); vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { for (const host of hosts.splice(0)) host.cancel(); vi.unstubAllGlobals(); });
describe("original Christmas host", () => {
  it.each(["online", "offline", "unavailable"])("reads %s state with GET only and strips all fifteen effect envelopes", async authority => {
    const x = setup(), p = authority === "unavailable" ? unavailable() : projection({ authority });
    fetchMock.mockResolvedValue(response(snapshot(x.id, p, staleEffects())));
    expect(x.target.workshopChristmasRead!(x.id, x.generation, 1).accepted).toBe(true);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of Object.keys(staleEffects())) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each([[1, false, 0, 1], [10, false, 1, 0], [1, true, 0, 2], [5, true, 1, 0], [10, true, 2, 0]] as const)("settles count %s / double %s once with matching animation delta", async (count, double, afterCount, afterExp) => {
    const x = setup(), xp = count * (double ? 2 : 1), cost = double ? count * 2 : 0;
    const effect = { type: "crafted", count, double, resourceCost: count, pointCost: cost, experienceGained: xp,
      before: { count: 0, exp: 0 }, after: { count: afterCount, exp: afterExp }, isUp: afterCount > 0, committedRevision: 2 };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, projection({ count: afterCount, exp: afterExp, used: count, points: 500 - cost }),
      { ...staleEffects(), mailedCount: 0, nativeChristmasAction: { requestId: sent().requestId, effects: [effect] } })));
    const action = { type: "craft", count, marked: double, choice }, ack = x.request(action);
    expect(ack.accepted).toBe(true); expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(sent().action).toEqual(action); expect(readPendingActivity(x.id)).toBeNull();
    const delivered = x.accept.mock.calls[0][0].snapshot!; expect(delivered.nativeChristmasAction?.effects).toEqual([effect]);
    for (const key of Object.keys(staleEffects()).filter(k => k !== "nativeChristmasAction")) expect(delivered).not.toHaveProperty(key);
  });
  it.each([1, 2, 3, 4])("claims tier %s with the committed cycle and mail even at the daily craft cap", async tier => {
    const x = setup(), claimed = [false, false, false]; if (tier < 4) claimed[tier - 1] = true;
    const cycle = tier === 4 ? 1 : 0, p = projection({ count: 8, actions: 0, cycle, claimed });
    const effect = { type: "claimed", tier, cycle, rewards: [reward(tier)], committedRevision: 2 };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, p, { mailedCount: 1, nativeChristmasAction: { requestId: sent().requestId, effects: [effect] } })));
    expect(x.request({ type: "claim", tier, index: 0, choice }).accepted).toBe(true);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("rejects inherited, coerced, extra, over-count and wrong-cycle input without writing the UUID ledger", () => {
    const x = setup();
    for (const action of [{ type: "craft", count: 0, marked: false }, { type: "craft", count: 11, marked: true },
      { type: "craft", count: "1", marked: false }, { type: "craft", count: 1, marked: 1 }, { type: "craft", count: 1 },
      { type: "craft", count: 1, marked: false, seed: 7 }, { type: "claim", tier: 0, index: 0 },
      { type: "claim", tier: "4", index: 0 }, { type: "claim", tier: 1, index: 1 }, { type: "claim", tier: 4, index: 499_999_999 },
      { type: "claim", tier: 4, index: 0, count: 1 }, { type: "constructor" }]) expect(x.request({ ...action, choice }).accepted).toBe(false);
    expect(x.request(Object.create({ type: "craft", count: 1, marked: false, choice })).accepted).toBe(false);
    expect(x.request({ type: "craft", count: 1, marked: false, choice: choice.replace("10-15", "02-30") }).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it("preserves the UUID on a lost POST and explicit replay synchronizes without another animation", async () => {
    const x = setup(); fetchMock.mockRejectedValueOnce(new Error("connection lost"));
    const ack = x.request({ type: "craft", count: 1, marked: false, choice }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.request({ type: "craft", count: 2, marked: false, choice }, 2).accepted).toBe(false);
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, projection({ used: 1, exp: 1 }), { ...staleEffects(), replayed: true })));
    await x.host.retry(readPendingActivity(x.id)!); expect(sent().requestId).toBe(ack.requestId); expect(readPendingActivity(x.id)).toBeNull();
    for (const key of Object.keys(staleEffects())) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it.each(["zero-task", "point-limit", "count-limit", "daily-limit"])("accepts disabled authoritative quotes at %s", async boundary => {
    const x = setup(), p = projection(boundary === "zero-task" ? { completed: [false, false, false, false] } : boundary === "point-limit" ? { points: 1 }
      : boundary === "count-limit" ? { count: 1_000_000_000, exp: 9 } : { actions: 0 });
    fetchMock.mockResolvedValue(response(snapshot(x.id, p))); x.target.workshopChristmasRead!(x.id, x.generation, 1);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce()); expect(x.reject).not.toHaveBeenCalled();
  });
  it.each(["bad-date", "wrong-token-day", "private-root", "private-task", "private-reward", "fake-snowfield", "wrong-entitlement", "wrong-cost", "wrong-max", "mixed-empty", "wrong-threshold", "wrong-cycle"])("rejects malformed public %s", async kind => {
    const x = setup(), p = projection();
    if (kind === "bad-date") p.day = "2026-02-30";
    if (kind === "wrong-token-day") p.stateToken = "2026-10-14." + "A".repeat(43);
    if (kind === "private-root") Object.assign(p, { accountId: 7 });
    if (kind === "private-task") Object.assign(p.snowman.tasks[0]!, { claims: {} });
    if (kind === "private-reward") Object.assign(p.rewards[0]!.reward, { mailId: 7 });
    if (kind === "fake-snowfield") p.snowfield.available = true;
    if (kind === "wrong-entitlement") p.snowman.entitlement = 25;
    if (kind === "wrong-cost") p.snowman.quotes[10]!.pointCost = 0;
    if (kind === "wrong-max") p.snowman.maxDoubleCount = 1;
    if (kind === "mixed-empty") p.snowman.tasks = [];
    if (kind === "wrong-threshold") p.rewards[3]!.threshold = 2;
    if (kind === "wrong-cycle") p.rewards[3]!.nextTarget = 10;
    fetchMock.mockResolvedValue(response(snapshot(x.id, p))); x.target.workshopChristmasRead!(x.id, x.generation, 1);
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
  });
  it.each(["wrong-delta", "wrong-animation", "wrong-price", "private-effect", "wrong-revision", "fake-mail"])("keeps uncertain UUID for malformed committed %s", async kind => {
    const x = setup(), effect = { type: "crafted", count: 1, double: false, resourceCost: 1, pointCost: 0, experienceGained: 1,
      before: { count: 0, exp: 0 }, after: { count: 0, exp: 1 }, isUp: false, committedRevision: 2 };
    if (kind === "wrong-delta") effect.before.exp = 5;
    if (kind === "wrong-animation") effect.isUp = true;
    if (kind === "wrong-price") effect.pointCost = 2;
    if (kind === "private-effect") Object.assign(effect, { rng: 42 });
    if (kind === "wrong-revision") effect.committedRevision = 1;
    fetchMock.mockImplementation(async () => response(snapshot(x.id, projection({ used: 1, exp: 1 }),
      { mailedCount: kind === "fake-mail" ? 1 : 0, nativeChristmasAction: { requestId: sent().requestId, effects: [effect] } })));
    const ack = x.request({ type: "craft", count: 1, marked: false, choice }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it.each(["old-cycle", "wrong-material", "unclaimed"])("keeps claim UUID on %s", async kind => {
    const x = setup(), tier = kind === "unclaimed" ? 1 : 4, cycle = tier === 4 ? 1 : 0;
    const effect = { type: "claimed", tier, cycle: kind === "old-cycle" ? 0 : cycle, rewards: [reward(kind === "wrong-material" ? 1 : tier)], committedRevision: 2 };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, projection({ count: 8, cycle }), { mailedCount: 1,
      nativeChristmasAction: { requestId: sent().requestId, effects: [effect] } })));
    const ack = x.request({ type: "claim", tier, index: 0, choice }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); expect(x.accept).not.toHaveBeenCalled();
  });
  it.each(["cancel", "role"])("does not deliver late POST after %s and retains the pending UUID", async kind => {
    const x = setup(); let finish!: (r: Response) => void; fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const ack = x.request({ type: "craft", count: 1, marked: false, choice }); await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    if (kind === "cancel") x.host.cancel(); else x.cancelRole();
    finish(response(snapshot(x.id, projection(), { replayed: true })));
    await new Promise(resolve => setTimeout(resolve, 0)); expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("retains the UUID after an unacknowledged callback for explicit web recovery", async () => {
    const x = setup(); x.accept.mockReturnValue(undefined);
    fetchMock.mockImplementation(async () => response(snapshot(x.id, projection({ exp: 1, used: 1 }), { mailedCount: 0, nativeChristmasAction: {
      requestId: sent().requestId, effects: [{ type: "crafted", count: 1, double: false, resourceCost: 1, pointCost: 0, experienceGained: 1,
        before: { count: 0, exp: 0 }, after: { count: 0, exp: 1 }, isUp: false, committedRevision: 2 }] } })));
    const ack = x.request({ type: "craft", count: 1, marked: false, choice }); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId); expect(x.host.retry(readPendingActivity(x.id)!)).toBeNull();
  });
  it.each(["enter", "challenge", "npc-claim"] as const)("uses the original callback and UUID ledger for fresh %s", async type => {
    const x = setup(), r = snowResult(type, 1);
    fetchMock.mockImplementation(async () => response(snapshot(x.id, r.p, { ...staleEffects(), nativeChristmasSnowfield: r.f,
      mailedCount: r.mailedCount, nativeChristmasAction: { requestId: sent().requestId, effects: [r.effect] } })));
    const ack = x.request(r.action); expect(ack.accepted).toBe(true); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/account/activities/christmas-native/action");
    expect(sent()).toEqual({ characterId: x.id, requestId: ack.requestId, action: r.action });
    expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
    expect(x.accept.mock.calls[0][0].snapshot?.nativeChristmasAction?.effects).toEqual([r.effect]);
    for (const key of Object.keys(staleEffects()).filter(k => k !== "nativeChristmasAction")) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
  });
  it("rejects malformed snowfield actions before creating any UUID", () => {
    const x = setup();
    for (const action of [{ type: "enter", choice, index: 0 }, { type: "npc-claim", choice, tier: 1 }, { type: "challenge", choice },
      { type: "challenge", choice, index: "1" }, { type: "challenge", choice, index: 3 }, { type: "challenge", choice, index: 0, monsterId: 100 },
      { type: "enter", choice: choice.slice(0, -1) }, Object.create({ type: "enter", choice })]) expect(x.request(action).accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each(["entry", "reason", "wallet", "day", "scene", "private", "missing"])("rejects mismatched optional snowfield %s", async kind => {
    const x = setup(), r = snowResult("enter");
    if (kind === "entry") r.p.snowfield.available = false;
    if (kind === "reason") r.p.snowfield.reason = "旧理由";
    if (kind === "wallet") r.f.points--;
    if (kind === "day") r.f.day = "2026-10-14";
    if (kind === "scene") r.f.scene.revision = "B".repeat(42);
    if (kind === "private") Object.assign(r.f.attempt, { attemptId: "private" });
    fetchMock.mockResolvedValue(response(snapshot(x.id, r.p, kind === "missing" ? {} : { nativeChristmasSnowfield: r.f })));
    x.target.workshopChristmasRead!(x.id, x.generation, 1); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce()); expect(x.accept).not.toHaveBeenCalled();
  });
  it.each(["enter", "challenge", "npc-claim"] as const)("GET and replay %s resume state never deliver an effect or send another POST", async type => {
    const x = setup(), r = snowResult(type);
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, r.p, { ...staleEffects(), nativeChristmasSnowfield: r.f })));
    x.target.workshopChristmasRead!(x.id, x.generation, 1); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET"); for (const key of Object.keys(staleEffects())) expect(x.accept.mock.calls[0][0].snapshot).not.toHaveProperty(key);
    fetchMock.mockRejectedValueOnce(new Error("lost POST")); const ack = x.request(r.action, 2);
    await vi.waitFor(() => expect(x.reject).toHaveBeenCalledTimes(1)); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
    fetchMock.mockResolvedValueOnce(response(snapshot(x.id, r.p, { ...staleEffects(), nativeChristmasSnowfield: r.f, replayed: true, mailedCount: r.mailedCount })));
    await x.host.retry(readPendingActivity(x.id)!); expect(x.accept).toHaveBeenCalledTimes(2); expect(sent().requestId).toBe(ack.requestId);
    for (const key of Object.keys(staleEffects())) expect(x.accept.mock.calls[1][0].snapshot).not.toHaveProperty(key);
    expect(fetchMock).toHaveBeenCalledTimes(3); expect(readPendingActivity(x.id)).toBeNull();
  });
  it.each(["stale-scene", "stale-revision", "no-resume", "wrong-monster", "wrong-day", "private-effect", "foreign-uuid", "malformed-replay"])("keeps challenge UUID for uncertain %s", async kind => {
    const x = setup(), r = snowResult("challenge");
    if (kind === "stale-scene") r.effect.committedSceneRevision = "C".repeat(43);
    if (kind === "stale-revision") r.effect.committedRevision = 1;
    if (kind === "no-resume") r.f.attempt.canResume = false;
    if (kind === "wrong-monster") r.effect.monsterId = 999;
    if (kind === "wrong-day") r.action.choice = "2026-10-14." + "A".repeat(43);
    if (kind === "private-effect") r.effect.attemptId = "private";
    fetchMock.mockImplementation(async () => {
      const data = snapshot(x.id, r.p, { nativeChristmasSnowfield: r.f, mailedCount: 0,
        nativeChristmasAction: { requestId: kind === "foreign-uuid" ? crypto.randomUUID() : sent().requestId, effects: [r.effect] } });
      if (kind === "malformed-replay") Object.assign(data, { replayed: "true" });
      return response(data);
    });
    const ack = x.request(r.action); await vi.waitFor(() => expect(x.reject).toHaveBeenCalledOnce());
    expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it.each(["cancel", "role"])("does not hand off a late challenge after %s", async kind => {
    const x = setup(), r = snowResult("challenge"); let finish!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; })); const ack = x.request(r.action);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); if (kind === "cancel") x.host.cancel(); else x.cancelRole();
    finish(response(snapshot(x.id, r.p, { nativeChristmasSnowfield: r.f, mailedCount: 0, nativeChristmasAction: { requestId: ack.requestId!, effects: [r.effect] } })));
    await new Promise(resolve => setTimeout(resolve, 0)); expect(x.accept).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)?.requestId).toBe(ack.requestId);
  });
  it("keeps original craft functional while a present snowfield is unavailable", async () => {
    const x = setup(), p = projection({ used: 1, exp: 1 }), f = snowfield();
    f.available = false; f.stateToken = null; f.entry.available = false; f.challenges.forEach(c => { c.canChallenge = false; });
    p.snowfield = { ...f.entry };
    fetchMock.mockImplementation(async () => response(snapshot(x.id, p, { nativeChristmasSnowfield: f, mailedCount: 0, nativeChristmasAction: {
      requestId: sent().requestId, effects: [{ type: "crafted", count: 1, double: false, resourceCost: 1, pointCost: 0, experienceGained: 1,
        before: { count: 0, exp: 0 }, after: { count: 0, exp: 1 }, isUp: false, committedRevision: 2 }] } })));
    x.request({ type: "craft", count: 1, marked: false, choice }); await vi.waitFor(() => expect(x.accept).toHaveBeenCalledOnce());
    expect(x.reject).not.toHaveBeenCalled(); expect(readPendingActivity(x.id)).toBeNull();
  });
});
