import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// Only randomness is controlled. HTTP/auth, engine, migrations, transactions and mail are real.
const random = vi.hoisted(() => ({ fraction: 0.99 }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined
    ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)),
}));

const tmp = mkdtempSync(join(tmpdir(), "ddt-reference-activities-"));
const uid = 111, secret = "reference-activity-integration-tests-only";
const start = new Date("2026-10-15T12:00:00Z");
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = {
  NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"),
  CELEB_REBUILD_MIN: 0,
};
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "integration-test", role: "player" }, secret, 3600)}` });
const view = (s: ActivityResult, id: string) => {
  const v = s.activities.find(a => a.id === id);
  expect(v, `activity ${id}`).toBeDefined();
  return v!;
};
const stat = (s: ActivityResult, id: string, label: string) => view(s, id).stats.find(x => x.label === label)?.value;
async function snapshot(): Promise<ActivityResult> {
  const r = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function action(id: string, value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const r = await built.app.inject({ method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(),
    payload: { characterId: uid, requestId, action: value } });
  expect(r.statusCode, `${id}/${value.type}: ${r.body}`).toBe(status);
  return r.json();
}
const counts = () => q1<{ actions: number; items: number; mails: number }>(h, sql`SELECT
  (SELECT count(*)::int FROM app."ActivityActions") AS actions,
  (SELECT count(*)::int FROM player."Sys_Users_Goods") AS items,
  (SELECT count(*)::int FROM player."User_Messages") AS mails`);

beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  const template: typeof game.Shop_Goods.$inferInsert = {
    TemplateID: 11019, Name: "Material", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 5,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true,
    CanEquip: false, CanUse: true, CanDelete: true, Property1: 0, Property2: 0, Property3: 0, Property4: 0,
    Property5: 0, Property6: 0, Property7: 0, Property8: 0, BindType: 0, FusionType: 0, FusionRate: 0,
    FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0,
  };
  await h.db.insert(game.Shop_Goods).values(PRIZES.map(p => ({ ...template, TemplateID: p.templateId, Name: p.name })));
  await rebuild();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  random.fraction = 0.99;
  await h.db.execute(sql`TRUNCATE app."ActivityActions", app."ActivityStates", app."ActivityWallet", app."EventClaims",
    member."Accounts", player."Sys_Users_Detail", player."Sys_Users_Goods", player."User_Messages"`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'integration-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'integration-test','Integration test',true,'2000-01-01',1)`);
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await built?.app.close(); await h?.close(); });

/** Fixture is the original sign owner's committed record, never a client completion/points flag. */
async function dailyTasks(restart = false) {
  random.fraction = 0.99; // Mines in the last row; shuffled paired cards remain adjacent.
  const day = new Date().toISOString().slice(0, 10);
  await h.db.execute(sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (${uid},'sign',${day})`);
  await action("mines", { type: restart ? "restart" : "start" });
  for (let index = 0; index < 8; index++) await action("mines", { type: "open", index });
  await action("pair", { type: restart ? "restart" : "start" });
  for (let index = 0; index < 12; index++) await action("pair", { type: "flip", index });
  await action("cave", { type: "draw", count: 3 });
  await action("cave", { type: "take" });
  const ready = await snapshot();
  expect(ready.tasks.map(t => [t.id, t.current, t.target, t.claimed])).toEqual([
    ["sign", 1, 1, false], ["mines", 8, 8, false], ["pair", 3, 3, false], ["explore", 3, 3, false],
  ]);
  const signRequest = randomUUID();
  await action("tasks", { type: "claim", choice: "sign" }, signRequest);
  for (const choice of ["mines", "pair", "explore"]) await action("tasks", { type: "claim", choice });
  const done = await snapshot();
  expect(done.tasks.every(t => t.claimed)).toBe(true);
  expect(stat(done, "cave", "今日免费")).toBe(0);
  return { done, signRequest };
}

async function checkMailAttachments() {
  const items = await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`);
  const mails = await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`);
  expect(mails.length).toBeGreaterThan(0);
  const refs: number[] = [];
  for (const m of mails) {
    expect(m.ReceiverID).toBe(uid);
    const ids = [m.Annex1, m.Annex2, m.Annex3, m.Annex4, m.Annex5].filter(Boolean).map(Number);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(5);
    refs.push(...ids);
  }
  expect(new Set(refs).size).toBe(refs.length);
  expect(refs.sort((a, b) => a - b)).toEqual(items.map(i => Number(i.ItemID)).sort((a, b) => a - b));
  for (const i of items) {
    expect(PRIZES.some(p => p.templateId === i.TemplateID)).toBe(true);
    expect(i.Count).toBeGreaterThan(0);
    expect(i.Count).toBeLessThanOrEqual(5);
    expect(i).toMatchObject({ UserID: 0, Place: -1, IsBinds: true, ValidDate: 0, StrengthenLevel: 0,
      AttackCompose: 0, DefendCompose: 0, LuckCompose: 0, AgilityCompose: 0 });
  }
}

describe("reference activities through the actual app and persistence", () => {
  it("earns task points, delivers shops/bags once and resumes public state after rebuilding the app", async () => {
    const profiles = await q(h, sql`SELECT * FROM player."Sys_Users_Detail"`);
    const templates = await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`);
    const initial = await snapshot();
    // Catalog coverage is distinct from the runtime flows below; sign remains the original game owner.
    expect(initial.activities.map(a => a.id)).toEqual([
      "treasure", "mines", "gypsy", "pair", "exchange", "wardrobe", "moon", "sign", "points-gift",
      "wheel", "carnival", "ddplay", "first-gift", "luxury", "devil", "christmas", "cave",
    ]);
    expect(initial).toMatchObject({ points: 0, earned: 0, revision: 0 });
    expect(await q(h, sql`SELECT * FROM app."ActivityWallet"`)).toEqual([]);
    expect(await q(h, sql`SELECT * FROM app."ActivityStates"`)).toEqual([]);
    await action("tasks", { type: "claim", choice: "mines" }, randomUUID(), 400);
    await action("first-gift", { type: "claim" }, randomUUID(), 400);
    expect(await counts()).toEqual({ actions: 0, items: 0, mails: 0 });
    expect((await dailyTasks()).done).toMatchObject({ points: 200, earned: 200 });
    expect((await action("first-gift", { type: "claim" })).mailedCount).toBe(1);
    await action("first-gift", { type: "claim" }, randomUUID(), 400);

    const beforeShop = await snapshot();
    expect((await action("gypsy", { type: "refresh" })).points).toBe(beforeShop.points);
    const bought = await action("gypsy", { type: "buy", index: 0 });
    expect(bought.points).toBe(beforeShop.points - 15);
    expect(view(bought, "gypsy").cells?.[0].action).toBeUndefined();
    await action("gypsy", { type: "buy", index: 0 }, randomUUID(), 400);
    expect((await action("exchange", { type: "exchange", index: 0 })).points).toBe(bought.points - 15);

    expect(stat(await action("treasure", { type: "draw" }), "treasure", "临时背包")).toBe("1/30");
    const takeId = randomUUID(), taken = await action("treasure", { type: "take" }, takeId);
    expect(taken.mailedCount).toBe(1);
    await action("treasure", { type: "take" }, randomUUID(), 400);
    const moon = await action("moon", { type: "draw" });
    expect(stat(moon, "moon", "临时背包")).toBe("1/30");
    const recycled = await action("moon", { type: "recycle" });
    expect(recycled.points).toBe(moon.points + 2);
    expect(recycled.earned).toBe(200);
    const caveBefore = await snapshot(), cave = await action("cave", { type: "draw" });
    expect(cave.points).toBe(caveBefore.points - 15);
    await action("cave", { type: "take" });
    // Leave a new unclaimed bag to distinguish current replay from an obsolete saved snapshot.
    await action("treasure", { type: "draw" });
    const saved = await snapshot(), beforeRetry = await counts();
    await built.app.close();
    await rebuild();
    expect(await snapshot()).toEqual(saved);
    const replayed = await action("treasure", { type: "take" }, takeId);
    expect(replayed).toMatchObject({ points: saved.points, earned: saved.earned, revision: saved.revision,
      message: taken.message, mailedCount: taken.mailedCount, replayed: true });
    expect(replayed.activities).toEqual(saved.activities);
    expect(stat(replayed, "treasure", "临时背包")).toBe("1/30");
    expect(await counts()).toEqual(beforeRetry);
    await action("treasure", { type: "recycle" }, takeId, 409);
    const receipts = await q<{ Result: Record<string, unknown> }>(h, sql`SELECT "Result" FROM app."ActivityActions"`);
    expect(receipts.every(r => Object.keys(r.Result).sort().join(",") === "mailedCount,message")).toBe(true);
    await checkMailAttachments();
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail"`)).toEqual(profiles);
    expect(await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(templates);
  });

  it("settles chance games and timed Christmas rewards through real HTTP without duplicate mail", async () => {
    const { done } = await dailyTasks();
    random.fraction = 0.1;
    await action("wheel", { type: "start" });
    await action("wheel", { type: "continue" });
    const wheel = await action("wheel", { type: "protect" });
    expect(stat(wheel, "wheel", "星级")).toBe(3);
    expect(wheel.points).toBe(done.points - 50);
    const wheelId = randomUUID();
    expect((await action("wheel", { type: "take" }, wheelId)).mailedCount).toBe(1);
    const afterWheel = await counts();
    expect((await action("wheel", { type: "take" }, wheelId)).replayed).toBe(true);
    expect(await counts()).toEqual(afterWheel);
    await action("wheel", { type: "take" }, randomUUID(), 400);

    random.fraction = 0.99;
    await action("devil", { type: "start" });
    const devil = await action("devil", { type: "continue" });
    expect(stat(devil, "devil", "当前倍率")).toBe(2);
    expect(stat(devil, "devil", "上次骰子")).toBe(6);
    await action("devil", { type: "take" });
    await action("devil", { type: "take" }, randomUUID(), 400);
    random.fraction = 0.2;
    const beforePlay = await snapshot(), play = await action("ddplay", { type: "spin" });
    expect(stat(play, "ddplay", "上次倍率")).toBe(3);
    expect(play.points).toBe(beforePlay.points + 20);
    random.fraction = 0.4;
    const beforeCarnival = await snapshot();
    let carnival = beforeCarnival;
    for (let n = 0; n < 4; n++) carnival = await action("carnival", { type: "roll" });
    expect(stat(carnival, "carnival", "已完成圈数")).toBe(1);
    expect(carnival.points).toBe(beforeCarnival.points - 25);
    expect(carnival.mailedCount).toBe(1);
    expect(carnival.earned).toBe(200); // Chance returns never count as task-earned thresholds.

    random.fraction = 0.99;
    const snow = await action("christmas", { type: "start" });
    expect(snow.points).toBe(carnival.points);
    expect(view(snow, "christmas").cells?.every(c => c.label === "雪块")).toBe(true);
    for (let index = 0; index < 3; index++) await action("christmas", { type: "open", index });
    const extended = await action("christmas", { type: "extend" });
    expect(stat(extended, "christmas", "找到雪人")).toBe("3/3");
    expect(stat(extended, "christmas", "剩余秒数")).toBe(3600);
    const snowId = randomUUID();
    expect((await action("christmas", { type: "take" }, snowId)).mailedCount).toBe(1);
    const delivered = await counts();
    await action("christmas", { type: "take" }, randomUUID(), 400);
    vi.setSystemTime(new Date(start.getTime() + 2 * 60 * 60_000));
    const replay = await action("christmas", { type: "take" }, snowId);
    expect(replay.replayed).toBe(true);
    expect(stat(replay, "christmas", "剩余秒数")).toBe(0);
    expect(await counts()).toEqual(delivered);
    await checkMailAttachments();
  });

  it("unlocks all task-earned gift tiers over five test days and cannot roll back on an old request", async () => {
    const profiles = await q(h, sql`SELECT * FROM player."Sys_Users_Detail"`);
    let oldSignId = "", firstReceipt: unknown;
    for (let dayIndex = 0; dayIndex < 5; dayIndex++) {
      vi.setSystemTime(new Date(start.getTime() + dayIndex * 24 * 60 * 60_000));
      if (dayIndex > 0) {
        const freshDay = await snapshot();
        expect(freshDay.tasks.every(t => !t.claimed && t.current === 0)).toBe(true);
        expect(stat(freshDay, "cave", "今日免费")).toBe(3);
      }
      const { done, signRequest } = await dailyTasks(dayIndex > 0);
      expect(done).toMatchObject({ points: 200 * (dayIndex + 1), earned: 200 * (dayIndex + 1) });
      if (dayIndex === 0) {
        oldSignId = signRequest;
        firstReceipt = await q1(h, sql`SELECT * FROM app."ActivityActions" WHERE "RequestID"=${oldSignId}`);
        await action("points-gift", { type: "claim", tier: 2 }, randomUUID(), 400);
        await action("luxury", { type: "claim", tier: 3 }, randomUUID(), 400);
      }
    }
    const beforeGifts = await snapshot();
    for (const id of ["points-gift", "luxury"]) {
      for (const tier of [1, 2, 3]) {
        const claimed = await action(id, { type: "claim", tier });
        expect(claimed).toMatchObject({ points: 1000, earned: 1000, mailedCount: 1 });
        await action(id, { type: "claim", tier }, randomUUID(), 400);
      }
    }
    const final = await snapshot(), delivered = await counts();
    expect(final.revision).toBe(beforeGifts.revision + 6);
    expect(["points-gift", "luxury"].every(id => view(final, id).actions.every(a => a.disabled))).toBe(true);
    const replayed = await action("tasks", { type: "claim", choice: "sign" }, oldSignId);
    expect(replayed).toMatchObject({ points: 1000, earned: 1000, revision: final.revision, day: "2026-10-19", replayed: true });
    expect(replayed.activities).toEqual(final.activities);
    expect(replayed.tasks).toEqual(final.tasks);
    expect(await counts()).toEqual(delivered);
    expect(await q1(h, sql`SELECT * FROM app."ActivityActions" WHERE "RequestID"=${oldSignId}`)).toEqual(firstReceipt);
    await checkMailAttachments();
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail"`)).toEqual(profiles);
  });
});
