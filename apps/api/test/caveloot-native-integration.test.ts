import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDb, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actionFor, available, buildTestApi, clean, headers, native, persistState, persisted, post, seedNative, seedTemplates, snapshot, state, uid } from "./caveloot-native-fixture.js";
import { createCaveState, type CaveState } from "../src/activities/caveloot-native.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction } from "../src/activities/types.js";
const random = vi.hoisted(() => ({ fraction: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomInt: (min: number, max?: number) => max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)) }));
let h: DbHandle, api: Awaited<ReturnType<typeof buildTestApi>>;
const fixtures: { label: string; snapshot: ActivityResult; action?: ActivityAction }[] = [];
const collect = async (label: string, value?: ActivityResult) => { const result = value ?? await snapshot(api), action = actionFor(result); fixtures.push({ label, snapshot: result, ...(action ? { action } : {}) }); return result; };
const cave = async () => (await state(h))!.games.cave as CaveState;
const ext = () => ({ version: 1 as const, normalDraws: 0, advancedDraws: 0, normalCoins: 0, advancedCoins: 0, claimedExtraProgress: [] as number[], shopDay: "2026-10-15", shopBought: [[0, 0, 0, 0], [0, 0, 0, 0]] as [number[], number[]] });
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); await seedTemplates(h); api = await buildTestApi(h, join(process.cwd(), "test/nonexistent-caveloot-resource")); });
beforeEach(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z")); random.fraction = 0; await clean(h); });
afterEach(() => vi.useRealTimers());
afterAll(async () => { await api?.close(); await h?.close(); if (process.env.WORKSHOP_CAVELOOT_FIXTURE_OUTPUT)
  writeFileSync(process.env.WORKSHOP_CAVELOOT_FIXTURE_OUTPUT, JSON.stringify({ version: 1, syntheticOnly: true, source: "Actual authenticated API projections, isolated PGlite, 4 synthetic ordinary templates", fixtures }, null, 2) + "\n"); });
describe("native caveloot authenticated atomic API", () => {
  it("projects GET without writes, rejects wrong owner and malformed/extra action fields", async () => {
    const before = await persisted(h), initial = await collect("initial-not-started"); expect(await persisted(h)).toEqual(before);
    expect((await api.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    expect((await post(api, { type: "exchange", choice: available(initial).stateToken }, randomUUID(), "caveloot-native", 918)).statusCode).toBe(403);
    for (const action of [{ type: "constructor", choice: available(initial).stateToken }, { type: "__proto__", choice: available(initial).stateToken }, { type: "draw", tier: 1, index: 0, count: 1 }, { type: "draw", tier: 1, index: 1, count: 2, choice: available(initial).stateToken }, { type: "take-all", tier: 1, count: 1, choice: available(initial).stateToken }, { type: "exchange", choice: available(initial).stateToken, price: 0 }])
      expect((await post(api, action as ActivityAction)).statusCode).toBe(400);
    expect(await persisted(h)).toEqual(before);
  });
  it("shares old/new free quota and commits one finite batch, then replays latest state without fresh result", async () => {
    await seedNative(h, { pity: 8 }); await post(api, { type: "draw", count: 1 }, randomUUID(), "cave"); await collect("legacy-typed-before-extension");
    const token = available(await snapshot(api)).stateToken, action = { type: "draw", tier: 1, index: 2, count: 1, choice: token }, id = randomUUID();
    const result = await post(api, action, id); expect(result.statusCode, result.body).toBe(200); const fresh = await collect("fresh-five-draw", result.json());
    expect(fresh).toMatchObject({ points: 955, earned: 40, mailedCount: 0, nativeCaveLoot: { started: true, draws: 6, pityRemaining: 6, freeRemaining: 0 }, nativeCaveLootAction: { requestId: id, effects: [{ type: "drawn", tier: 1, animationBand: 2, draws: 5, freeDraws: 2, cost: 45, guaranteedDraws: 1 }] } });
    expect((await cave()).native!.normalDraws).toBe(5); expect((await persisted(h)).goods).toEqual([]); expect((await state(h))!.games.chargeNativeV1).toMatchObject({ grossSpent: 45 });
    expect((await state(h))!.daily).toMatchObject({ actions: 2, draws: 6 });
    const advanced = await native(api, { type: "draw", tier: 2, index: 1, count: 1 }); expect(advanced.statusCode).toBe(200); await collect("advanced-three-draw", advanced.json());
    const committed = await persisted(h), replay = await post(api, action, id); expect(replay.statusCode).toBe(200); await collect("replay-latest-no-fresh", replay.json());
    expect(replay.json()).toMatchObject({ replayed: true, points: 850, nativeCaveLoot: { draws: 9 } }); expect(replay.json()).not.toHaveProperty("nativeCaveLootAction"); expect(await persisted(h)).toEqual(committed);
    expect((await post(api, { ...action, count: 2 }, id)).statusCode).toBe(409);
  });
  it("consumes a shared mixed bag by FIFO quantity and excludes old/new double settlement", async () => {
    const original = await seedNative(h, { bag: [{ templateId: 11019, count: 3, caveType: 1, private: "first" }, { templateId: 11019, count: 4, caveType: 1, private: "second" }, { templateId: 11001, count: 2, caveType: 2 }, { templateId: 11021, count: 3, private: "untyped" }] }); await collect("mixed-bag");
    const take = await native(api, { type: "take-item", tier: 1, index: 0, count: 5 }); expect(take.statusCode).toBe(200); await collect("partial-item-taken", take.json());
    expect((await cave()).bag[0]).toEqual({ templateId: 11019, count: 2, caveType: 1, private: "second" }); expect((await persisted(h)).goods.map(r => r.Count)).toEqual([5]);
    const recycled = await native(api, { type: "recycle-all", tier: 2 }); expect(recycled.statusCode).toBe(200); await collect("advanced-recycled-coins", recycled.json()); expect(recycled.json()).toMatchObject({ points: 1000, earned: 40 });
    expect((await cave()).native!.advancedCoins).toBe(4); expect((await cave()).native!.normalCoins).toBe(0);
    const history = await native(api, { type: "recycle-legacy" }); expect(history.statusCode).toBe(200); await collect("history-recycled-points", history.json()); expect(history.json()).toMatchObject({ points: 1006, earned: 40 });
    const old = await post(api, { type: "take" }, randomUUID(), "cave"); expect(old.statusCode).toBe(200); await collect("legacy-take-clears-new-bag", old.json()); expect((await cave()).bag).toEqual([]);
    expect((await native(api, { type: "take-all", tier: 1 })).statusCode).toBe(409); expect((await state(h))!.games.untouched).toEqual(original.games.untouched);
  });
  it("supports all-item/legacy take and item recycle without duplicating rewards or global earned", async () => {
    await seedNative(h, { bag: [{ templateId: 11019, count: 2, caveType: 1 }, { templateId: 11021, count: 4, caveType: 2 }, { templateId: 11001, count: 3 }] });
    const recycled = await native(api, { type: "recycle-item", tier: 2, index: 2, count: 3 }); expect(recycled.statusCode).toBe(200); await collect("partial-item-recycled", recycled.json());
    expect((await cave()).native!.advancedCoins).toBe(6); expect((await cave()).bag.find(r => r.caveType === 2)!.count).toBe(1);
    const take = await native(api, { type: "take-all", tier: 1 }); expect(take.statusCode).toBe(200); await collect("all-normal-taken", take.json());
    const hist = await native(api, { type: "take-legacy" }); expect(hist.statusCode).toBe(200); await collect("legacy-bag-taken", hist.json());
    expect((await persisted(h)).goods.map(r => r.Count)).toEqual([2, 3]); expect((await snapshot(api))).toMatchObject({ points: 1000, earned: 40 });
  });
  it("settles claims/fragments and coin shop at500, enforces canonical legacy claims and UTC shop limits", async () => {
    await seedNative(h, { score: 200, fragments: 10, native: { ...ext(), normalDraws: 200, normalCoins: 100, advancedCoins: 100 } }, 500); await collect("daily500-existing-rights");
    expect((await native(api, { type: "draw", tier: 1, index: 0, count: 1 })).statusCode).toBe(400);
    const id = randomUUID(), action = { type: "progress", tier: 1, choice: available(await snapshot(api)).stateToken };
    const shared = await post(api, action, id); expect(shared.statusCode).toBe(200); await collect("shared-progress1-claimed", shared.json());
    expect((await post(api, { type: "progress", tier: 1 }, randomUUID(), "cave")).statusCode).toBe(400);
    const replay = await post(api, action, id); expect(replay.json().replayed).toBe(true); await collect("shared-progress1-replay", replay.json());
    expect((await native(api, { type: "progress", tier: 1 })).statusCode).toBe(409);
    expect((await native(api, { type: "progress", tier: 2 })).statusCode).toBe(200); expect((await post(api, { type: "progress", tier: 2 }, randomUUID(), "cave")).statusCode).toBe(400);
    const local = await native(api, { type: "progress", tier: 11 }); expect(local.statusCode).toBe(200); await collect("personal-progress11-claimed", local.json());
    const exchange = await native(api, { type: "exchange" }); expect(exchange.statusCode).toBe(200); await collect("fragments-exchanged", exchange.json());
    const bought = await native(api, { type: "buy", tier: 1, index: 0, count: 5 }); expect(bought.statusCode).toBe(200); await collect("normal-shop-sold-out", bought.json());
    expect((await cave()).native).toMatchObject({ normalCoins: 50, advancedCoins: 100, shopBought: [[5, 0, 0, 0], [0, 0, 0, 0]] }); expect((await state(h))!.daily.actions).toBe(500); expect((await state(h))!.games.chargeNativeV1).toBeUndefined();
    const stale = available(await snapshot(api)).stateToken; vi.setSystemTime(new Date("2026-10-16T00:00:00Z")); const next = await collect("next-utc-day"); expect(available(next).shop[0]).toMatchObject({ bought: 0, remaining: 5, maxCount: 5 });
    expect((await post(api, { type: "buy", tier: 1, index: 0, count: 1, choice: stale })).statusCode).toBe(409); expect((await cave()).native!.shopBought[0][0]).toBe(5);
  });
  it("rolls back mail, final receipt, wallet and state together and retries the same UUID once", async () => {
    await seedNative(h, { bag: [{ templateId: 11019, count: 28, caveType: 1 }] }); const action = { type: "take-all", tier: 1, choice: available(await snapshot(api)).stateToken }, id = randomUUID(), before = await persisted(h);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT caveloot_mail_failure CHECK ("Annex5" IS NOT NULL) NOT VALID`);
    expect((await post(api, action, id)).statusCode).toBe(500); expect(await persisted(h)).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT caveloot_mail_failure`);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT caveloot_receipt_failure CHECK (false) NOT VALID`);
    const failed = await post(api, action, id); expect(failed.statusCode).toBe(500); expect(failed.body).not.toMatch(/INSERT|Signature|Annex|UPDATE/); expect(await persisted(h)).toEqual(before);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT caveloot_receipt_failure`);
    const retry = await post(api, action, id); expect(retry.statusCode).toBe(200); await collect("retried-once-real-split-mail", retry.json()); const committed = await persisted(h);
    expect(committed.goods.map(r => r.Count)).toEqual([5, 5, 5, 5, 5, 3]); expect(committed.mails).toHaveLength(2); expect(committed.receipts).toHaveLength(1);
    expect((await post(api, action, id)).json().replayed).toBe(true); expect(await persisted(h)).toEqual(committed);
  });
  it("rejects bad reward templates atomically and preserves unknown extensions for legacy actions", async () => {
    await seedNative(h, { bag: [{ templateId: 11021, count: 8, caveType: 2 }] }); const before = await persisted(h), action = { type: "take-all", tier: 2, choice: available(await snapshot(api)).stateToken }, id = randomUUID();
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=true WHERE "TemplateID"=11021`); expect((await post(api, action, id)).statusCode).toBe(503); expect(await persisted(h)).toEqual(before);
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false WHERE "TemplateID"=11021`); expect((await post(api, action, id)).statusCode).toBe(200);
    const root = await state(h); root!.games.cave = { ...createCaveState(), native: { version: 99, private: [1, 2, 3] }, bag: [{ templateId: 11019, count: 1 }] }; await persistState(h, root!);
    const unavailable = await collect("future-extension-unavailable"); expect(unavailable.nativeCaveLoot).toMatchObject({ available: false, stateToken: null }); const preserved = await persisted(h);
    expect((await post(api, { type: "exchange", choice: action.choice })).statusCode).toBe(409); expect(await persisted(h)).toEqual(preserved);
    expect((await post(api, { type: "draw", count: 1 }, randomUUID(), "cave")).statusCode).toBe(200); expect((await cave()).native).toEqual({ version: 99, private: [1, 2, 3] });
    await collect("legacy-works-with-unknown-extension");
  });
  it("honors capacity/cost/max quantity, no native partial commits or historical type inference", async () => {
    await seedNative(h, { bag: Array.from({ length: 29 }, () => ({ templateId: 11019, count: 1, caveType: 1 as const })) }); const before = await persisted(h); await collect("bag29-capacity-boundary");
    expect((await native(api, { type: "draw", tier: 1, index: 1, count: 1 })).statusCode).toBe(409); expect(await persisted(h)).toEqual(before);
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Points"=0 WHERE "UserID"=${uid}`); await seedNative(h); await collect("zero-points-free-only"); expect((await native(api, { type: "draw", tier: 2, index: 0, count: 1 })).statusCode).toBe(409);
    const draw = await native(api, { type: "draw", tier: 1, index: 1, count: 1 }); expect(draw.statusCode).toBe(200); expect(draw.json().points).toBe(0); expect((await cave()).native!.normalDraws).toBe(3);
    await collect("free-three-at-zero-points", draw.json()); expect((await native(api, { type: "take-item", tier: 1, index: 0, count: 4 })).statusCode).toBe(409);
  });
  it("includes shared advanced pity in the committed five-draw result, with no second floor reward", async () => {
    await seedNative(h, { pity: 9 }); const result = await native(api, { type: "draw", tier: 2, index: 2, count: 1 }); expect(result.statusCode).toBe(200);
    const value = await collect("advanced-five-guaranteed", result.json()); expect(value).toMatchObject({ points: 825, mailedCount: 0, nativeCaveLoot: { pityRemaining: 6 }, nativeCaveLootAction: { effects: [{ type: "drawn", draws: 5, guaranteedDraws: 1, cost: 175, freeDraws: 0 }] } });
    expect(value.nativeCaveLootAction!.effects[0]).toMatchObject({ results: [{ templateId: 11019, itemCount: 8 }, { templateId: 11021, itemCount: 4 }] });
    const before = await persisted(h); expect((await native(api, { type: "floor" })).statusCode).toBe(400); expect(await persisted(h)).toEqual(before);
  });
  it("projects lawful high coins and settles only the exact INT32 recycle room at500", async () => {
    await seedNative(h, { bag: [{ templateId: 11019, count: 3, caveType: 1 }], native: { ...ext(), normalCoins: 2147483645, advancedCoins: 1500000000 } }, 500);
    const initial = await collect("high-coins-int32-recycle-room"); expect(available(initial).types[0]).toMatchObject({ coins: 2147483645, canRecycleAll: false, rows: [expect.objectContaining({ itemCount: 3, maxRecycleCount: 1, canRecycle: true }), expect.anything(), expect.anything(), expect.anything()] });
    const before = await persisted(h); expect((await native(api, { type: "recycle-all", tier: 1 })).statusCode).toBe(409); expect(await persisted(h)).toEqual(before);
    const settled = await native(api, { type: "recycle-item", tier: 1, index: 0, count: 1 }); expect(settled.statusCode).toBe(200); await collect("high-coins-int32-partial-at500", settled.json());
    expect((await cave()).native!.normalCoins).toBe(2147483647); expect(available(settled.json()).types[0]!.rows[0]!.maxRecycleCount).toBe(0);
    expect((await native(api, { type: "take-all", tier: 1 })).statusCode).toBe(200); expect((await state(h))!.daily.actions).toBe(500);
  });
});
