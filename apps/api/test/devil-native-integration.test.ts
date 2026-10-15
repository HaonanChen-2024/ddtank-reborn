import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDb, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { available, buildTestApi, clean, drawHistory, headers, native, persistState, persisted, post, seedNative, seedTemplates, snapshot, state, uid } from "./devil-native-fixture.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction } from "../src/activities/types.js";
const random = vi.hoisted(() => ({ fraction: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomInt: (min: number, max?: number) =>
  max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)) }));
let h: DbHandle, api: Awaited<ReturnType<typeof buildTestApi>>;
const fixtures: { label: string; snapshot: ActivityResult }[] = [];
const collect = async (label: string, value?: ActivityResult) => { const result = value ?? await snapshot(api); fixtures.push({ label, snapshot: result }); return result; };
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); await seedTemplates(h); api = await buildTestApi(h, join(process.cwd(), "test/nonexistent-devil-resource")); });
beforeEach(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z")); random.fraction = 0; await clean(h); });
afterEach(() => vi.useRealTimers());
afterAll(async () => { await api?.close(); await h?.close(); if (process.env.WORKSHOP_DEVIL_FIXTURE_OUTPUT)
  writeFileSync(process.env.WORKSHOP_DEVIL_FIXTURE_OUTPUT, JSON.stringify({ version: 1, syntheticOnly: true, source: "Actual authenticated API projections, isolated PGlite, 4 synthetic ordinary templates", fixtures }, null, 2) + "\n"); });
describe("native devil through authenticated atomic API", () => {
  it("keeps GET pure and rejects foreign roles, missing tokens, unsafe fields and unknown save writes", async () => {
    const before = await persisted(h), view = await collect("initial"); expect(await persisted(h)).toEqual(before);
    expect((await api.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post(api, { type: "free-turn", choice: available(view).stateToken }, randomUUID(), "devil-native", 916)).statusCode).toBe(403);
    for (const action of [{ type: "free-turn" }, { type: "free-turn", choice: available(view).stateToken, count: 1 },
      { type: "buy-turns", count: 2, choice: available(view).stateToken }, { type: "free-turn", choice: available(view).stateToken, templateId: 12772 }])
      expect((await post(api, action as ActivityAction)).statusCode).toBe(400);
    expect(await persisted(h)).toEqual(before);
    const root = await seedNative(h); root.games.devilNativeV1 = { version: 2, private: "preserve future" }; await persistState(h, root);
    const corrupted = await persisted(h); await collect("future-save-unavailable");
    expect((await native(api, { type: "free-turn" }).catch(() => null))).toBeNull();
    expect((await post(api, { type: "free-turn", choice: available(view).stateToken })).statusCode).toBe(503);
    expect(await persisted(h)).toEqual(corrupted);
    expect((await post(api, { type: "take" }, randomUUID(), "devil")).statusCode).toBe(200);
    expect((await state(h))!.games.devilNativeV1).toEqual(root.games.devilNativeV1);
  });
  it("purchases and draws ten atomically, preserves old saves/templates and replays latest state without fresh effects", async () => {
    const original = await seedNative(h, { turns: 10 }); const requestId = randomUUID(), initial = await snapshot(api);
    const action = { type: "draw", count: 10, choice: available(initial).stateToken }, result = await post(api, action, requestId);
    expect(result.statusCode, result.body).toBe(200); const fresh = await collect("fresh-ten-draw", result.json());
    expect(fresh).toMatchObject({ points: 1000, earned: 40, mailedCount: 2, nativeDevil: { turns: 0, draws: 10, marks: 10 } });
    expect(fresh.nativeDevilAction?.effects[0]).toMatchObject({ type: "drawn", results: Array.from({ length: 10 }, (_, i) => expect.objectContaining({ sequence: i + 1 })) });
    const committed = await persisted(h); expect(committed.goods).toHaveLength(10); expect(committed.goods.every(g => g.Count === 1 && g.IsBinds)).toBe(true);
    expect(committed.mails).toHaveLength(2); expect((await state(h))!.games.devil).toEqual(original.games.devil);
    const free = await native(api, { type: "free-turn" }); expect(free.statusCode).toBe(200); await collect("daily-free-owned", free.json());
    const afterNewer = await persisted(h), replay = await post(api, action, requestId); expect(replay.statusCode).toBe(200);
    await collect("replay-after-newer-revision", replay.json()); expect(replay.json()).toMatchObject({ replayed: true, nativeDevil: { turns: 1, draws: 10 } });
    expect(replay.json()).not.toHaveProperty("nativeDevilAction"); expect(await persisted(h)).toEqual(afterNewer);
    expect((await post(api, { ...action, count: 1 }, requestId)).statusCode).toBe(409);
  });
  it("rolls back earlier mails plus state/wallet/final receipt, then retries the same finite batch once", async () => {
    await seedNative(h, { turns: 10 }); const action = { type: "draw", count: 9, choice: available(await snapshot(api)).stateToken }, id = randomUUID(), before = await persisted(h);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT devil_mail_failure CHECK ("Annex5" IS NOT NULL) NOT VALID`);
    expect((await post(api, action, id)).statusCode).toBe(500); expect(await persisted(h)).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT devil_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT devil_receipt_failure CHECK (false) NOT VALID`);
    const failed = await post(api, action, id); expect(failed.statusCode).toBe(500); expect(failed.body).not.toMatch(/INSERT|UPDATE|Signature|Annex/); expect(await persisted(h)).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT devil_receipt_failure`);
    expect((await post(api, action, id)).statusCode).toBe(200); const after = await persisted(h);
    expect((await post(api, action, id)).json().replayed).toBe(true); expect(await persisted(h)).toEqual(after);
  });
  it("runs real box/double-dice/continue/take once; failed dice retry and abandon persist without animation writes", async () => {
    await seedNative(h, { boxes: [1, 0, 0] }); const opened = await native(api, { type: "open-box", index: 0 }); expect(opened.statusCode).toBe(200); await collect("box-ready", opened.json());
    const rolled = await native(api, { type: "roll-dice" }); expect(rolled.statusCode).toBe(200); await collect("dice-success", rolled.json());
    await native(api, { type: "continue-dice" }); await collect("next-stage-ready");
    const failed = await native(api, { type: "roll-dice" }); expect(failed.statusCode).toBe(200); await collect("dice-failed", failed.json());
    const retried = await native(api, { type: "continue-dice" }); expect(retried.json()).toMatchObject({ points: 990, nativeDevil: { round: { phase: 2, state: 1 } } }); await collect("paid-retry-ready", retried.json());
    random.fraction = 0.5; await native(api, { type: "roll-dice" }); const before = await snapshot(api), id = randomUUID(), action = { type: "take-box", choice: available(before).stateToken };
    const take = await post(api, action, id); expect(take.statusCode).toBe(200); expect(take.json()).toMatchObject({ nativeDevil: { round: null, marks: 2 }, mailedCount: 1 }); await collect("box-taken", take.json());
    const committed = await persisted(h); expect((await post(api, action, id)).json().replayed).toBe(true); expect((await post(api, action)).statusCode).toBe(409); expect(await persisted(h)).toEqual(committed);
    const root = await state(h); const s = available(before).round!; root!.games.devilNativeV1 = { ...(root!.games.devilNativeV1 as object), activeRound: { id: s.id, boxIndex: 0, phase: 2, state: 3, retries: 0, lastDice: { left: 1, right: 1, sum: 2, success: false } } };
    await persistState(h, root!); const abandoned = await native(api, { type: "abandon-box" }); expect(abandoned.json()).toMatchObject({ nativeDevil: { round: null } }); await collect("box-abandoned", abandoned.json());
  });
  it("settles cap milestones/shop/conversion with real split stacks and UTC quotas, without earned/gross inflation", async () => {
    await seedNative(h, { draws: 1000, recentDraws: drawHistory(1000), marks: 1000, beads: [9, 9, 9, 9, 9] }, 500); await collect("daily500-earned-entitlements");
    const claim = await native(api, { type: "claim-milestone", index: 0 }); expect(claim.statusCode).toBe(200);
    expect((await state(h))!.claims).toContain("devil-native:milestone:1"); await collect("milestone-claimed", claim.json());
    const bought = await native(api, { type: "buy-item", index: 0, count: 10 }); expect(bought.statusCode).toBe(200); expect(bought.json()).toMatchObject({ mailedCount: 2, points: 1000, earned: 40, nativeDevil: { marks: 850 } }); await collect("shop-sold-out", bought.json());
    expect((await persisted(h)).goods.filter(g => g.Count === 5)).toHaveLength(6); expect((await state(h))!.daily.actions).toBe(500);
    expect((await state(h))!.games.chargeNativeV1).toBeUndefined(); expect((await native(api, { type: "convert-box", index: 0 })).statusCode).toBe(200);
    expect((await native(api, { type: "buy-turns", count: 1 })).statusCode).toBe(400);
    const stale = available(await snapshot(api)).stateToken; vi.setSystemTime(new Date("2026-10-16T00:00:00Z")); const next = await collect("next-utc-day");
    expect(available(next).shop[0].maxCount).toBe(10); expect((await post(api, { type: "free-turn", choice: stale })).statusCode).toBe(409);
  });
  it("keeps template and receipt failures atomic for take, never masks owner data after a successful commit", async () => {
    await seedNative(h, { roundSequence: 1, activeRound: { id: 1, boxIndex: 2, phase: 5, state: 2, retries: 0, lastDice: { left: 3, right: 4, sum: 7, success: true } } }, 500);
    await collect("fifth-stage-take-at500"); const before = await persisted(h), action = { type: "take-box", choice: available(await snapshot(api)).stateToken }, id = randomUUID();
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11021`);
    expect((await post(api, action, id)).statusCode).toBe(503); expect(await persisted(h)).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11021`);
    expect((await post(api, action, id)).statusCode).toBe(200); const after = await persisted(h); expect(after.goods.map(g => g.Count)).toEqual([5, 3]);
    expect((await native(api, { type: "take-box" })).statusCode).toBe(400); expect(await persisted(h)).toEqual(after);
  });
  it("serializes distinct token competitors and preserves immutable receipts across day and latest revision", async () => {
    const action = { type: "buy-turns", count: 10, choice: available(await snapshot(api)).stateToken }, id = randomUUID();
    const results = await Promise.all([post(api, action, id), post(api, action)]); expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await state(h))!.games.chargeNativeV1).toMatchObject({ grossSpent: 200 }); expect((await snapshot(api)).points).toBe(800);
    const before = await persisted(h); vi.setSystemTime(new Date("2026-10-16T00:00:00Z")); const replay = await post(api, action, id);
    if (results[0].statusCode === 200) { expect(replay.statusCode).toBe(200); expect(replay.json()).toMatchObject({ replayed: true, day: "2026-10-16" }); expect(replay.json()).not.toHaveProperty("nativeDevilAction"); }
    expect(await persisted(h)).toEqual(before); const afterGet = await snapshot(api); expect(afterGet).not.toHaveProperty("nativeDevilAction");
  });
});
