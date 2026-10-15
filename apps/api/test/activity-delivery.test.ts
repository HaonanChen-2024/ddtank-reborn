import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDb, migrateDb, game, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppCtx } from "../src/context.js";
import { loadConfig } from "../src/config.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";
import { CiTree, ResourceIndex } from "../src/lib/resources.js";
import { activityRoutes } from "../src/routes/activities.js";
import { transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityState } from "../src/activities/types.js";
import { advanceWardrobe, viewWardrobe } from "../src/activities/wardrobe.js";
import { viewPairNative } from "../src/activities/pair-native.js";
import { viewMinesNative } from "../src/activities/mines-native.js";
import { viewDDPlayNative } from "../src/activities/ddplay-native.js";
import { viewGypsyNative } from "../src/activities/gypsy-native.js";
import { viewMoonlightNative } from "../src/activities/moonlight-native.js";
import { viewTreasureNative } from "../src/activities/treasure-native.js";
import { viewWheelNative } from "../src/activities/wheel-native.js";
import { viewCarnivalNative } from "../src/activities/carnival-native.js";
import { viewFirstRechargeNative } from "../src/activities/first-recharge-native.js";

// These tests exercise auth, actual SQL transactions and original mail delivery, not engine rules.
vi.mock("../src/activities/engine.js", () => ({
  createActivityState: (now: Date) => ({ version: 1, day: now.toISOString().slice(0, 10), daily: {}, games: {}, completed: {}, claims: [], history: [] }),
  transitionActivity: vi.fn(), viewActivities: vi.fn(),
}));

let h: DbHandle, app: FastifyInstance, ctx: AppCtx;
let resourceDir: string, resourceTree: CiTree;
const uid = 111, otherUid = 112, templateId = 11019;
const token = signJwt({ sub: 1, name: "activity-test", role: "player" }, "activity-tests-only", 3600);
const headers = { authorization: `Bearer ${token}` };
const item = { TemplateID: templateId, Name: "Original material", CanRecycle: 0, CategoryID: 11, Attack: 12, Defence: 13, Agility: 14, Luck: 15,
  Level: 1, Quality: 1, MaxCount: 2, NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false,
  CanUse: true, CanDelete: true, Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
  BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };

beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await h.db.insert(game.Shop_Goods).values([item, { ...item, TemplateID: 1001, Name: "Original hat", CategoryID: 1 }]);
  app = Fastify({ logger: false });
  resourceDir = mkdtempSync(join(tmpdir(), "activity-wardrobe-icons-"));
  resourceTree = new CiTree(resourceDir);
  // Use the actual static resource index; unrelated cache/storage fields are not used by this route.
  ctx = { h, cfg: loadConfig({}, { NODE_ENV: "test", JWT_SECRET: "activity-tests-only", GAME_INTERNAL_URL: "" }),
    resources: new ResourceIndex([resourceTree]),
    log: { info() {}, warn() {}, error() {} } } as unknown as AppCtx;
  await activityRoutes(app, ctx);
  await app.ready();
});
beforeEach(async () => {
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS activity_second_mail_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions", app."ActivityStates", app."ActivityWallet", app."EventClaims", app."Translations", member."Accounts", player."Sys_Users_Detail", player."Sys_Users_Goods", player."User_Messages"`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'activity-test','tests-only'),(2,'other-account','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst") VALUES (${uid},'activity-test','Activity test',true,'2000-01-01',1),(${otherUid},'other-account','Other test',false,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},10,10)`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CategoryID"=11,"CanEquip"=false,"MaxCount"=2,"NeedSex"=0 WHERE "TemplateID"=${templateId}`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CategoryID"=1,"NeedSex"=0,"Pic"=NULL WHERE "TemplateID"=1001`);
  ctx.cfg.GAME_INTERNAL_URL = "";
  vi.mocked(transitionActivity).mockReset();
  vi.mocked(viewActivities).mockReset().mockImplementation((state, wallet, context) => ({ ...wallet, day: state.day, activities: [], tasks: [], history: state.history, nativePair: viewPairNative(undefined, context), nativeMines: viewMinesNative(undefined, context), nativeDDPlay: viewDDPlayNative(undefined, wallet), nativeGypsy: viewGypsyNative(undefined, context, wallet), nativeMoonlight: viewMoonlightNative(undefined, context, wallet), nativeTreasure: viewTreasureNative(undefined, context, wallet), nativeWheel: viewWheelNative(undefined, context, wallet), nativeCarnival: viewCarnivalNative(undefined, context, wallet), nativeFirstRecharge: viewFirstRechargeNative(undefined, context, wallet, { claims: [], boardCompletions: 0 }) }));
  vi.mocked(transitionActivity).mockImplementation((state) => ({ state: { ...state, games: { serverOnlyLayout: [7, 8, 9] }, history: ["真实提交"] }, pointsDelta: -3, earnedDelta: 0, rewards: [{ templateId, count: 14, validDays: 7 }], message: "已发送" }));
});
afterEach(() => { vi.useRealTimers(); headers.authorization = `Bearer ${token}`; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  await app?.close(); await h?.close();
  if (resourceDir) rmSync(resourceDir, { recursive: true, force: true });
});

const get = (characterId = uid) => app.inject({ method: "GET", url: `/api/account/activities?characterId=${characterId}`, headers });
const post = (requestId: string = randomUUID(), action: Record<string, unknown> = { type: "claim" }, characterId = uid, activity = "treasure") => app.inject({ method: "POST", url: `/api/account/activities/${activity}/action`, headers, payload: { characterId, requestId, action } });
const counts = () => q1<{ actions: number; states: number; items: number; mails: number }>(h, sql`SELECT
  (SELECT count(*)::int FROM app."ActivityActions") AS actions,(SELECT count(*)::int FROM app."ActivityStates") AS states,
  (SELECT count(*)::int FROM player."Sys_Users_Goods") AS items,(SELECT count(*)::int FROM player."User_Messages") AS mails`);
const empty = { actions: 0, states: 0, items: 0, mails: 0 };
const wallet = () => q1(h, sql`SELECT * FROM app."ActivityWallet" WHERE "UserID"=${uid}`);
const installIcon = (relative: string) => {
  const file = join(resourceDir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  resourceTree.reindex();
  return file;
};
const showWardrobeCatalog = () => vi.mocked(viewActivities).mockImplementation((state, wallet, context) => ({
  ...wallet, day: state.day, tasks: [], history: state.history, nativePair: viewPairNative(undefined, context), nativeMines: viewMinesNative(undefined, context), nativeDDPlay: viewDDPlayNative(undefined, wallet), nativeGypsy: viewGypsyNative(undefined, context, wallet), nativeMoonlight: viewMoonlightNative(undefined, context, wallet), nativeTreasure: viewTreasureNative(undefined, context, wallet), nativeWheel: viewWheelNative(undefined, context, wallet), nativeCarnival: viewCarnivalNative(undefined, context, wallet), nativeFirstRecharge: viewFirstRechargeNative(undefined, context, wallet, { claims: [], boardCompletions: 0 }),
  activities: [{ id: "wardrobe", title: "魔法衣橱", subtitle: "", ...viewWardrobe(advanceWardrobe(undefined, { type: "page", index: 0, choice: "catalog" }), context) }],
}));

describe("reference activity API delivery", () => {
  it("requires JWT and keeps GET read-only, including absent wallet/state", async () => {
    expect((await app.inject({ url: `/api/account/activities?characterId=${uid}` })).statusCode).toBe(401);
    await h.db.execute(sql`DELETE FROM app."ActivityWallet"`);
    expect((await get()).json()).toMatchObject({ characterId: uid, points: 0, revision: 0 });
    expect(await q(h, sql`SELECT * FROM app."ActivityWallet"`)).toEqual([]);
    expect(await counts()).toEqual(empty);
    expect(transitionActivity).not.toHaveBeenCalled();
  });

  it("rechecks removed/banned accounts and character ownership after token issue", async () => {
    expect((await get(otherUid)).statusCode).toBe(403);
    expect((await post(randomUUID(), { type: "claim" }, otherUid)).statusCode).toBe(403);
    await h.db.execute(sql`UPDATE member."Accounts" SET "IsBanned"=true WHERE "ID"=1`);
    expect((await get()).statusCode).toBe(403);
    expect((await post()).statusCode).toBe(403);
    await h.db.execute(sql`DELETE FROM member."Accounts" WHERE "ID"=1`);
    expect((await get()).statusCode).toBe(401);
    expect(await counts()).toEqual(empty);
    expect(await q(h, sql`SELECT * FROM app."ActivityWallet" WHERE "UserID"=${otherUid}`)).toEqual([]);
  });

  it.each([sql`"IsExist"=false`, sql`"ForbidDate"='2100-01-01'`])("refuses unavailable characters on reads and writes", async (change) => {
    await h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET ${change} WHERE "UserID"=${uid}`);
    expect((await get()).statusCode).toBe(403);
    expect((await post()).statusCode).toBe(403);
    expect(await counts()).toEqual(empty);
  });

  it("rejects invalid UUID, spoofed completed/points and sign mutation without committing", async () => {
    expect((await post("not-a-uuid")).statusCode).toBe(400);
    expect((await post(randomUUID(), { type: "claim", completed: true, points: 1000 })).statusCode).toBe(400);
    expect((await post(randomUUID(), { type: "sign" }, uid, "sign")).statusCode).toBe(400);
    expect(transitionActivity).not.toHaveBeenCalled();
    expect(await counts()).toEqual(empty);
  });

  it("supplies committed sign proof and real owned Chinese wardrobe rows to the engine", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await h.db.execute(sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (${uid},'sign',${day}),(${otherUid},'sign','2000-01-01')`);
    await h.db.execute(sql`INSERT INTO player."Sys_Users_Goods" ("UserID","TemplateID","BagType","Place","Count","IsExist") VALUES (${uid},1001,0,1,1,true),(${uid},1001,0,2,1,false),(${otherUid},${templateId},1,1,1,true)`);
    await h.db.execute(sql`INSERT INTO app."Translations" ("table","column","rowId","lang","text") VALUES ('Shop_Goods','Name','1001','zh-CN','中文帽子')`);
    expect((await get()).statusCode).toBe(200);
    expect(vi.mocked(viewActivities).mock.calls.at(-1)?.[2]).toMatchObject({ signDays: [day], ownedTemplateIds: [1001], wardrobeItems: [{ templateId: 1001, name: "中文帽子", category: 1 }] });
  });

  it("includes uncollected installed clothing without pretending the character owns it", async () => {
    expect((await get()).statusCode).toBe(200);
    expect(vi.mocked(viewActivities).mock.calls.at(-1)?.[2]).toMatchObject({ ownedTemplateIds: [], wardrobeItems: [{ templateId: 1001, name: "Original hat", category: 1 }] });
    expect(await counts()).toEqual(empty);
  });

  it("resolves real indexed clothing and wing icons using original category and template-sex paths", async () => {
    showWardrobeCatalog();
    const cases = [
      { category: 1, sex: 1, pic: "Hat Mix", path: "image/equip/m/head/hat mix/icon_1.png" },
      { category: 2, sex: 0, pic: "Glasses", path: "image/equip/f/glass/glasses/icon_1.png" },
      { category: 3, sex: 1, pic: "Hair", path: "image/equip/m/hair/hair/icon_1.png" },
      { category: 4, sex: 2, pic: "Effect", path: "image/equip/f/eff/effect/icon_1.png" },
      { category: 5, sex: 2, pic: "Cloth", path: "image/equip/f/cloth/cloth/icon_1.png" },
      { category: 6, sex: 0, pic: "Face", path: "image/equip/f/face/face/icon_1.png" },
      { category: 13, sex: 1, pic: "SuitCase", path: "image/equip/m/suits/SuitCase/icon_1.png" },
      { category: 15, sex: 0, pic: "WingCase", path: "image/equip/wing/WingCase/icon.png" },
    ];
    for (const entry of cases) {
      const file = installIcon(entry.path.toUpperCase());
      await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CategoryID"=${entry.category},"NeedSex"=${entry.sex},"Pic"=${entry.pic} WHERE "TemplateID"=1001`);
      const response = await get();
      expect(response.statusCode).toBe(200);
      const icon = `/resource/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
      expect(response.json().activities[0].cells[0]).toMatchObject({ label: "Original hat", image: icon, detail: "编号 1001 · 未拥有 · 本地已安装" });
      expect(ctx.resources.resolve(decodeURIComponent(icon.slice("/resource/".length)))).toBe(file);
      expect(vi.mocked(viewActivities).mock.calls.at(-1)?.[2].ownedTemplateIds).toEqual([]);
      expect(response.body).not.toContain(resourceDir);
      expect(response.body).not.toContain("NeedSex");
      expect(response.body).not.toContain("Pic");
    }
    expect(await counts()).toEqual(empty);
    expect(ctx.resources.misses.size).toBe(0);
  });

  it("omits absent or unsafe icon paths instead of returning placeholders or external resources", async () => {
    showWardrobeCatalog();
    installIcon("image/equip/m/head/hat mix/icon_1.png");
    const deleted = installIcon("image/equip/m/head/deleted/icon_1.png");
    rmSync(deleted); // Deliberately leave a stale index entry, as a removed local file can do.
    for (const pic of [null, "", "missing", "deleted", ".", "..", "../hat mix", "..\\hat mix", "hat mix/../hat mix", "https://example.test/a", "//example.test/a", "%2e%2e", "hat mix?x=1", " hat mix"]) {
      await h.db.execute(sql`UPDATE game."Shop_Goods" SET "NeedSex"=1,"Pic"=${pic} WHERE "TemplateID"=1001`);
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json().activities[0].cells[0]).toMatchObject({ label: "Original hat", detail: "编号 1001 · 未拥有 · 本地已安装" });
      expect(response.json().activities[0].cells[0]).not.toHaveProperty("image");
      expect(vi.mocked(viewActivities).mock.calls.at(-1)?.[2].wardrobeItems![0]).not.toHaveProperty("icon");
      expect(response.body).not.toContain("example.test");
    }
    expect(await counts()).toEqual(empty);
    expect(ctx.resources.misses.size).toBe(0);
  });

  it("uses original validity rules: unused timed items remain owned, used expired items do not", async () => {
    await h.db.execute(sql`INSERT INTO player."Sys_Users_Goods" ("UserID","TemplateID","BagType","Place","Count","IsExist","IsUsed","ValidDate","BeginDate")
      VALUES (${uid},1001,0,1,1,true,false,1,'2000-01-01'),(${uid},${templateId},1,1,1,true,true,1,'2000-01-01')`);
    expect((await get()).statusCode).toBe(200);
    expect(vi.mocked(viewActivities).mock.calls.at(-1)?.[2].ownedTemplateIds).toEqual([1001]);
    await h.db.execute(sql`UPDATE player."Sys_Users_Goods" SET "IsUsed"=true WHERE "TemplateID"=1001`);
    expect((await get()).statusCode).toBe(200);
    expect(vi.mocked(viewActivities).mock.calls.at(-1)?.[2].ownedTemplateIds).toEqual([]);
    await h.db.execute(sql`UPDATE player."Sys_Users_Goods" SET "ValidDate"=0 WHERE "TemplateID"=1001`);
    expect((await get()).statusCode).toBe(200);
    expect(vi.mocked(viewActivities).mock.calls.at(-1)?.[2].ownedTemplateIds).toEqual([1001]);
  });

  it("atomically splits all rewards by MaxCount/five, preserves base values and returns only public view", async () => {
    const original = await q(h, sql`SELECT * FROM player."Sys_Users_Detail"`);
    const templates = await q(h, sql`SELECT * FROM game."Shop_Goods"`);
    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ points: 7, earned: 10, revision: 1, message: "已发送", mailedCount: 2 });
    expect(response.body).not.toContain("serverOnlyLayout");
    expect(await counts()).toEqual({ actions: 1, states: 1, items: 7, mails: 2 });
    const items = await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`);
    expect(items.map((i) => i.Count)).toEqual([2, 2, 2, 2, 2, 2, 2]);
    for (const i of items) expect(i).toMatchObject({ UserID: 0, Place: -1, TemplateID: templateId, ValidDate: 7, IsBinds: true, StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, LuckCompose: 0, AgilityCompose: 0 });
    const mails = await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`);
    expect(mails.map((m) => [m.Annex1, m.Annex2, m.Annex3, m.Annex4, m.Annex5].filter(Boolean).length)).toEqual([5, 2]);
    expect(await q(h, sql`SELECT * FROM player."Sys_Users_Detail"`)).toEqual(original);
    expect(await q(h, sql`SELECT * FROM game."Shop_Goods"`)).toEqual(templates);
    const stored = await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates"`);
    expect(stored?.State.games).toEqual({ serverOnlyLayout: [7, 8, 9] });
    expect((await get()).json()).toMatchObject({ points: 7, history: ["真实提交"] });
  });

  it("serializes eight retries, returns the saved result and refuses a reused id with different payload", async () => {
    const id = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => post(id)));
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses.filter((r) => r.json().replayed)).toHaveLength(7);
    expect(transitionActivity).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({ actions: 1, states: 1, items: 7, mails: 2 });
    expect((await post(id, { type: "claim", count: 2 })).statusCode).toBe(409);
    expect((await post(id, { type: "claim" }, uid, "moon")).statusCode).toBe(409);
    expect((await wallet())?.Points).toBe(7);
  });

  it("replays the current page after another action, retaining the original delivery receipt", async () => {
    const id = randomUUID();
    const first = await post(id);
    const receipt = await q1(h, sql`SELECT * FROM app."ActivityActions" WHERE "RequestID"=${id}`);
    vi.mocked(transitionActivity).mockImplementation((state) => ({ state: { ...state, history: [...state.history, "后续进展"] }, pointsDelta: -1, earnedDelta: 0, rewards: [], message: "后续操作" }));
    expect((await post()).statusCode).toBe(200);
    const current = (await get()).json();
    const replay = (await post(id)).json();
    expect(first.json().points).toBe(7);
    expect(replay).toMatchObject({ ...current, points: 6, revision: 2, history: ["真实提交", "后续进展"], message: "已发送", mailedCount: 2, replayed: true });
    expect(transitionActivity).toHaveBeenCalledTimes(2);
    expect(await counts()).toEqual({ actions: 2, states: 1, items: 7, mails: 2 });
    expect(await q1(h, sql`SELECT * FROM app."ActivityActions" WHERE "RequestID"=${id}`)).toEqual(receipt);
  });

  it("rebuilds replay context across a day boundary even if revision is unchanged", async () => {
    const id = randomUUID();
    vi.mocked(viewActivities).mockImplementation((state, wallet, context) => ({ ...wallet, day: context.now.toISOString().slice(0, 10), activities: [], tasks: [], history: state.history, nativePair: viewPairNative(undefined, context), nativeMines: viewMinesNative(undefined, context), nativeDDPlay: viewDDPlayNative(undefined, wallet), nativeGypsy: viewGypsyNative(undefined, context, wallet), nativeMoonlight: viewMoonlightNative(undefined, context, wallet), nativeTreasure: viewTreasureNative(undefined, context, wallet), nativeWheel: viewWheelNative(undefined, context, wallet), nativeCarnival: viewCarnivalNative(undefined, context, wallet), nativeFirstRecharge: viewFirstRechargeNative(undefined, context, wallet, { claims: [], boardCompletions: 0 }) }));
    const first = (await post(id)).json();
    const receipt = await q1(h, sql`SELECT * FROM app."ActivityActions" WHERE "RequestID"=${id}`);
    const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(tomorrow);
    headers.authorization = `Bearer ${signJwt({ sub: 1, name: "activity-test", role: "player" }, "activity-tests-only", 3600)}`;
    const current = (await get()).json();
    const replay = (await post(id)).json();
    expect(replay.day).not.toBe(first.day);
    expect(replay).toMatchObject({ ...current, revision: first.revision, message: "已发送", mailedCount: 2, replayed: true });
    expect(transitionActivity).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({ actions: 1, states: 1, items: 7, mails: 2 });
    expect(await q1(h, sql`SELECT * FROM app."ActivityActions" WHERE "RequestID"=${id}`)).toEqual(receipt);
  });

  it("rolls back the wallet, state, request and first batch if a later mail fails", async () => {
    const before = await wallet();
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT activity_second_mail_failure CHECK ("Annex5" IS NOT NULL)`);
    const id = randomUUID();
    const failed = await post(id);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("Annex5");
    expect(await counts()).toEqual(empty);
    expect(await wallet()).toEqual(before);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT activity_second_mail_failure`);
    expect((await post(id)).statusCode).toBe(200);
    expect(await counts()).toEqual({ actions: 1, states: 1, items: 7, mails: 2 });
  });

  it.each([{ templateId: 999999, count: 1 }, { templateId, count: -1 }, { templateId: -200, count: 1 }, { templateId, count: 1, validDays: -1 }])("rejects undeliverable rewards without spending: %j", async (reward) => {
    const before = await wallet();
    vi.mocked(transitionActivity).mockImplementation((state) => ({ state, pointsDelta: -3, earnedDelta: 0, rewards: [{ templateId, count: 1 }, reward], message: "" }));
    expect((await post()).statusCode).toBe(503);
    expect(await counts()).toEqual(empty);
    expect(await wallet()).toEqual(before);
  });

  it.each([sql`"CategoryID"=7`, sql`"CanEquip"=true`, sql`"MaxCount"=0`, sql`"NeedSex"=2`])("refuses equipment, invalid stacks and incompatible-sex templates", async (change) => {
    await h.db.execute(sql`UPDATE game."Shop_Goods" SET ${change} WHERE "TemplateID"=${templateId}`);
    expect((await post()).statusCode).toBe(503);
    expect(await counts()).toEqual(empty);
    expect((await wallet())?.Points).toBe(10);
  });

  it("rejects insufficient balance and engine errors without persisting a request", async () => {
    vi.mocked(transitionActivity).mockImplementation((state) => ({ state, pointsDelta: -11, earnedDelta: 0, rewards: [], message: "" }));
    expect((await post()).statusCode).toBe(409);
    vi.mocked(transitionActivity).mockImplementation(() => { throw new ActivityError("尚未完成任务。", 409); });
    expect((await post()).statusCode).toBe(409);
    expect(await counts()).toEqual(empty);
    expect((await wallet())?.Points).toBe(10);
  });

  it("notifies only after COMMIT and treats unreachable game notice as a committed success", async () => {
    ctx.cfg.GAME_INTERNAL_URL = "http://activity-notice.invalid";
    const fetch = vi.fn(async () => {
      expect(await counts()).toEqual({ actions: 1, states: 1, items: 7, mails: 2 });
      expect((await wallet())?.Points).toBe(7);
      return new Response("", { status: 503 });
    });
    vi.stubGlobal("fetch", fetch);
    const id = randomUUID();
    expect((await post(id)).statusCode).toBe(200);
    expect((await post(id)).json().replayed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
