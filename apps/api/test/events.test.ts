import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { q, q1 } from "../src/lib/db.js";
import { pullDown } from "../src/request/endpoints/events.js";

const tmp = mkdtempSync(join(tmpdir(), "ddt-api-events-"));
const now = new Date("2026-10-11T12:00:00Z");
const userId = 111, activeId = 101, templateId = 1001;
let h: DbHandle;
let built: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","NickName","Sex","IsFirst") VALUES (${userId}, 'Event test', true, 1), (112, 'Female test', false, 1)`);
  const template: typeof game.Shop_Goods.$inferInsert = {
    TemplateID: templateId, Name: "Ordinary test item", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 1000,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true,
    CanEquip: false, CanUse: true, CanDelete: true, Property1: 0, Property2: 0,
    Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0,
    ReclaimValue: 0, ReclaimType: 0,
  };
  await h.db.insert(game.Shop_Goods).values([template, { ...template, TemplateID: -200, MaxCount: 1 }]);
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config: {
    NODE_ENV: "test", DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, GAME_INTERNAL_URL: "",
    FLASH_DIR: join(tmp, "flash"), RESOURCE_DIR: join(tmp, "resource"), UPLOAD_DIR: join(tmp, "uploads"),
  } });
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE app."EventClaims", player."Active_Number", player."User_Messages", player."Sys_Users_Goods", game."Active_Award", game."Active"`);
  await h.db.insert(game.Active).values({ ActiveID: activeId, Title: "Test event", HasKey: 3, StartDate: new Date("2020-01-01T00:00:00Z"), EndDate: new Date("2100-01-01T00:00:00Z") });
  built.ctx.cfg.GAME_INTERNAL_URL = "";
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS test_reject_mail`);
  await h.db.execute(sql`DROP TRIGGER IF EXISTS test_reject_second_mail ON player."User_Messages"`);
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_reject_second_mail()`);
});
afterAll(async () => { await built?.app.close(); await h?.close(); });

const claim = (code = "", uid = userId, at = now) => pullDown(built.ctx, activeId, code, uid, at);
async function award(o: Partial<typeof game.Active_Award.$inferInsert> = {}) {
  await h.db.insert(game.Active_Award).values({ ActiveID: activeId, ItemID: templateId, Count: 2, ValidDate: 7, ...o });
}
async function mode(HasKey: number, IsOnly = 0) {
  await h.db.execute(sql`UPDATE game."Active" SET "HasKey" = ${HasKey}, "IsOnly" = ${IsOnly} WHERE "ActiveID" = ${activeId}`);
}
async function code(AwardID: string, Mark = 0) {
  await h.db.execute(sql`INSERT INTO player."Active_Number" ("AwardID","ActiveID","Mark") VALUES (${AwardID}, ${activeId}, ${Mark})`);
}
async function counts() {
  return q1<{ claims: number; items: number; mails: number; taken: number }>(h, sql`SELECT
    (SELECT count(*)::int FROM app."EventClaims") AS claims,
    (SELECT count(*)::int FROM player."Sys_Users_Goods") AS items,
    (SELECT count(*)::int FROM player."User_Messages") AS mails,
    (SELECT count(*)::int FROM player."Active_Number" WHERE "PullDown" = true) AS taken`);
}
const empty = { claims: 0, items: 0, mails: 0, taken: 0 };

describe("ActivePullDown atomic reward delivery", () => {
  it("serves configured material fields through the original compressed ActiveList route and keeps ordinary activities unchanged", async () => {
    await h.db.execute(sql`UPDATE game."Active" SET "ActiveType"=1,"HasKey"=6,"GoodsExchangeTypes"='11',"GoodsExchangeNum"='2',"limitType"='1',"limitValue"='1' WHERE "ActiveID"=${activeId}`);
    await h.db.insert(game.Active).values({ ActiveID: 102, Title: "Ordinary", HasKey: 3, StartDate: now, EndDate: now });
    await built.ctx.cache.buildAll(d => d.endpoint === "/ActiveList.ashx");
    const response = await built.app.inject({ method: "GET", url: "/Request/ActiveList.xml" });
    expect(response.statusCode).toBe(200);
    const text = inflateSync(response.rawPayload).toString("utf8");
    const exchange = text.match(/<Item ActiveID="101"[^>]*\/>/)?.[0];
    expect(exchange).toContain('ActiveType="1" IsAdvance="false" GoodsExchangeTypes="11" GoodsExchangeNum="2" limitType="1" limitValue="1"');
    const ordinary = text.match(/<Item ActiveID="102"[^>]*\/>/)?.[0];
    expect(ordinary).toContain('ActiveType="0" IsAdvance="false" GoodsExchangeTypes="" GoodsExchangeNum="" limitType="" limitValue=""');
    expect(text).not.toContain("isAttend=");
  });

  it.each([1, 2, -1])("does not grant or consume a claim for non-free ActiveType %i even if HasKey allows it", async (activeType) => {
    await award();
    await h.db.execute(sql`UPDATE game."Active" SET "ActiveType"=${activeType} WHERE "ActiveID"=${activeId}`);
    expect(await claim()).toBe(11);
    const response = await built.app.inject({ method: "GET", url: `/Request/ActivePullDown.ashx?selfid=${userId}&activeID=${activeId}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<Result value="false" message="该活动不能直接领取，请通过对应活动界面操作。" />');
    expect(await counts()).toEqual(empty);
    await h.db.execute(sql`UPDATE game."Active" SET "ActiveType"=0 WHERE "ActiveID"=${activeId}`);
    expect(await claim()).toBe(0);
    expect(await counts()).toEqual({ claims: 1, items: 1, mails: 1, taken: 0 });
  });

  it("delivers every attachment once, batches by five and preserves template/player properties", async () => {
    const templates = await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`);
    const player = await q1(h, sql`SELECT * FROM player."Sys_Users_Detail" WHERE "UserID" = ${userId}`);
    for (let i = 0; i < 6; i++) await award({ Count: i + 1, Gold: 3, Money: 2 });
    expect(await claim()).toBe(0);
    expect(await claim()).toBe(6);
    expect(await counts()).toEqual({ claims: 1, items: 6, mails: 2, taken: 0 });
    const items = await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`);
    expect(items.map((x) => x.Count)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const item of items) expect(item).toMatchObject({ UserID: 0, Place: -1, TemplateID: templateId, ValidDate: 7, IsBinds: true, StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, LuckCompose: 0, AgilityCompose: 0 });
    const mails = await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`);
    expect(mails.map((m) => [m.Gold, m.Money, m.GiftToken])).toEqual([[18, 12, 0], [0, 0, 0]]);
    const annexes = mails.flatMap((m) => [m.Annex1, m.Annex2, m.Annex3, m.Annex4, m.Annex5].filter(Boolean).map(Number));
    expect(annexes).toEqual(items.map((item) => item.ItemID));
    expect(await q(h, sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(templates);
    expect(await q1(h, sql`SELECT * FROM player."Sys_Users_Detail" WHERE "UserID" = ${userId}`)).toEqual(player);
  });

  it("allows one of eight concurrent claims and no extra deliveries", async () => {
    await award();
    const results = await Promise.all(Array.from({ length: 8 }, () => claim()));
    expect(results.filter((x) => x === 0)).toHaveLength(1);
    expect(results.filter((x) => x === 6)).toHaveLength(7);
    expect(await counts()).toEqual({ claims: 1, items: 1, mails: 1, taken: 0 });
  });

  it("does not burn an empty pool and permits a claim after configuration is repaired", async () => {
    expect(await claim()).toBe(3);
    expect(await counts()).toEqual(empty);
    await award({ ItemID: 0, Count: 0, ValidDate: 0 });
    expect(await claim()).toBe(3);
    expect(await counts()).toEqual(empty);
    await award();
    expect(await claim()).toBe(0);
  });

  it("rejects pools with no applicable sex/mark and accepts both after repair", async () => {
    await award({ Sex: 2 });
    await award({ Sex: 1, Mark: 1 });
    expect(await claim()).toBe(3);
    expect(await counts()).toEqual(empty);
    expect(await claim("", 112)).toBe(0);
    await award({ Sex: 1 });
    expect(await claim()).toBe(0);
    expect(await counts()).toEqual({ claims: 2, items: 2, mails: 2, taken: 0 });
  });

  it.each([
    { ItemID: 999999 }, { Count: 0 }, { Count: -1 }, { ItemID: -200, Count: 0, ValidDate: 1, Money: 1 }, { ValidDate: -1 },
    { Gold: -1 }, { Money: -1 }, { StrengthenLevel: 1 }, { AttackCompose: 1 },
    { DefendCompose: 1 }, { LuckCompose: 1 }, { AgilityCompose: 1 },
    { ItemID: -999, Count: 0, ValidDate: 0, Money: 1 },
    { ItemID: -200, Count: 1, ValidDate: 0, Money: 1 },
  ])("rejects an undeliverable plan without claims or partial mail: %j", async (invalid) => {
    await award(); // a valid row first must not be partially delivered
    await award(invalid);
    expect(await claim()).toBe(3);
    expect(await counts()).toEqual(empty);
  });

  it("rejects nonpositive template stack limits and permits retry after repair", async () => {
    await award();
    try {
      for (const maxCount of [0, -1]) {
        await h.db.execute(sql`UPDATE game."Shop_Goods" SET "MaxCount" = ${maxCount} WHERE "TemplateID" = ${templateId}`);
        expect(await claim()).toBe(3);
        expect(await counts()).toEqual(empty);
      }
    } finally {
      await h.db.execute(sql`UPDATE game."Shop_Goods" SET "MaxCount" = 1000 WHERE "TemplateID" = ${templateId}`);
    }
    expect(await claim()).toBe(0);
  });

  it("rejects currency overflow and retains existing zero/negative-ID currency-only semantics", async () => {
    await award({ ItemID: 0, Gold: 2147483647, ValidDate: 0 });
    await award({ ItemID: 0, Gold: 1, ValidDate: 0 });
    expect(await claim()).toBe(3);
    expect(await counts()).toEqual(empty);
    await h.db.execute(sql`DELETE FROM game."Active_Award"`);
    await award({ ItemID: 0, Count: 1, ValidDate: 0, Gold: 12, Money: 4 });
    await award({ ItemID: -200, Count: 0, ValidDate: 0, Money: 3 });
    expect(await claim()).toBe(0);
    expect(await counts()).toEqual({ claims: 1, items: 0, mails: 1, taken: 0 });
    expect(await q1(h, sql`SELECT "Gold","Money","GiftToken","Annex1" FROM player."User_Messages"`)).toEqual({ Gold: 12, Money: 7, GiftToken: 0, Annex1: null });
  });

  it("rolls back attachments and a claim when the first real mail insert fails", async () => {
    await award();
    await h.db.execute(sql`UPDATE game."Active" SET "Title"='' WHERE "ActiveID"=${activeId}`);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT test_reject_mail CHECK ("ReceiverID" <> 111)`);
    await expect(claim()).rejects.toThrow();
    const failed = await built.app.inject({ method: "GET", url: `/Request/ActivePullDown.ashx?selfid=${userId}&activeID=${activeId}` });
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toBe('<Result value="false" message="领取活动奖励失败，请稍后重试。" />');
    expect(await counts()).toEqual(empty);
    await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT test_reject_mail`);
    expect(await claim()).toBe(0);
    expect(await q1(h, sql`SELECT "Title","Content" FROM player."User_Messages"`)).toEqual({ Title: "活动奖励", Content: "活动奖励：" });
  });

  it("rolls back the first mail and all six attachments when the second mail fails", async () => {
    for (let i = 0; i < 6; i++) await award();
    await h.db.execute(sql`CREATE FUNCTION player.test_reject_second_mail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT count(*) FROM player."User_Messages" WHERE "ReceiverID" = NEW."ReceiverID") >= 1 THEN
          RAISE EXCEPTION 'test second mail insert failed';
        END IF;
        RETURN NEW;
      END $$`);
    await h.db.execute(sql`CREATE TRIGGER test_reject_second_mail BEFORE INSERT ON player."User_Messages" FOR EACH ROW EXECUTE FUNCTION player.test_reject_second_mail()`);
    await expect(claim()).rejects.toThrow();
    expect(await counts()).toEqual(empty);
    await h.db.execute(sql`DROP TRIGGER test_reject_second_mail ON player."User_Messages"`);
    expect(await claim()).toBe(0);
    expect(await counts()).toEqual({ claims: 1, items: 6, mails: 2, taken: 0 });
  });

  it("splits ordinary MaxCount 1 rewards across mails without losing quantity or repeating currency", async () => {
    await award({ Count: 7, Gold: 30, Money: 12 });
    try {
      await h.db.execute(sql`UPDATE game."Shop_Goods" SET "MaxCount" = 1 WHERE "TemplateID" = ${templateId}`);
      expect(await claim()).toBe(0);
      expect(await counts()).toEqual({ claims: 1, items: 7, mails: 2, taken: 0 });
      const items = await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`);
      expect(items.map((item) => item.Count)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect(items.reduce((total, item) => total + Number(item.Count), 0)).toBe(7);
      for (const item of items) expect(item).toMatchObject({ TemplateID: templateId, ValidDate: 7, IsBinds: true, StrengthenLevel: 0, AttackCompose: 0, DefendCompose: 0, LuckCompose: 0, AgilityCompose: 0 });
      const mails = await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`);
      expect(mails.map((m) => [m.Gold, m.Money, m.GiftToken])).toEqual([[30, 12, 0], [0, 0, 0]]);
      expect(mails.flatMap((m) => [m.Annex1, m.Annex2, m.Annex3, m.Annex4, m.Annex5].filter(Boolean).map(Number))).toEqual(items.map((item) => item.ItemID));
      expect(await claim()).toBe(6);
    } finally {
      await h.db.execute(sql`UPDATE game."Shop_Goods" SET "MaxCount" = 1000 WHERE "TemplateID" = ${templateId}`);
    }
  });

  it("rolls back all split stacks when their second mail fails, then retries the complete remainder", async () => {
    await award({ Count: 20, Gold: 5, Money: 4 });
    try {
      await h.db.execute(sql`UPDATE game."Shop_Goods" SET "MaxCount" = 3 WHERE "TemplateID" = ${templateId}`);
      await h.db.execute(sql`CREATE FUNCTION player.test_reject_second_mail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF (SELECT count(*) FROM player."User_Messages" WHERE "ReceiverID" = NEW."ReceiverID") >= 1 THEN
            RAISE EXCEPTION 'test second mail insert failed';
          END IF;
          RETURN NEW;
        END $$`);
      await h.db.execute(sql`CREATE TRIGGER test_reject_second_mail BEFORE INSERT ON player."User_Messages" FOR EACH ROW EXECUTE FUNCTION player.test_reject_second_mail()`);
      await expect(claim()).rejects.toThrow();
      expect(await counts()).toEqual(empty);
      await h.db.execute(sql`DROP TRIGGER test_reject_second_mail ON player."User_Messages"`);
      expect(await claim()).toBe(0);
      expect(await counts()).toEqual({ claims: 1, items: 7, mails: 2, taken: 0 });
      const items = await q<{ Count: number }>(h, sql`SELECT "Count" FROM player."Sys_Users_Goods" ORDER BY "ItemID"`);
      expect(items.map((item) => item.Count)).toEqual([3, 3, 3, 3, 3, 3, 2]);
      expect(items.every((item) => item.Count > 0 && item.Count <= 3)).toBe(true);
      expect(items.reduce((total, item) => total + item.Count, 0)).toBe(20);
      const mails = await q(h, sql`SELECT "Gold","Money" FROM player."User_Messages" ORDER BY "ID"`);
      expect(mails).toEqual([{ Gold: 5, Money: 4 }, { Gold: 0, Money: 0 }]);
    } finally {
      await h.db.execute(sql`UPDATE game."Shop_Goods" SET "MaxCount" = 1000 WHERE "TemplateID" = ${templateId}`);
    }
  });

  it("preserves missing user/activity and closed-window codes, with inclusive boundaries", async () => {
    await award();
    expect(await pullDown(built.ctx, 999, "", userId, now)).toBe(1);
    expect(await claim("", 999)).toBe(2);
    expect(await claim("", userId, new Date("2019-12-31T23:59:59Z"))).toBe(7);
    expect(await claim("", userId, new Date("2100-01-01T00:00:01Z"))).toBe(8);
    expect(await counts()).toEqual(empty);
    expect(await claim("", userId, new Date("2020-01-01T00:00:00Z"))).toBe(0);
    expect(await claim("", 112, new Date("2100-01-01T00:00:00Z"))).toBe(0);
  });

  it("rejects null/reversed windows and an invalid clock without writes", async () => {
    await award();
    expect(await claim("", userId, new Date(NaN))).toBe(3);
    await h.db.execute(sql`UPDATE game."Active" SET "EndDate" = NULL`);
    expect(await claim()).toBe(3);
    await h.db.execute(sql`UPDATE game."Active" SET "EndDate" = '2010-01-01'::timestamp`);
    expect(await claim()).toBe(3);
    expect(await counts()).toEqual(empty);
  });

  it("preserves HasKey 1 wrong/used/one-account codes and serializes distinct concurrent codes", async () => {
    await mode(1, 1); await award({ Mark: 2 }); await code("first", 2); await code("second", 2);
    expect(await claim()).toBe(4);
    expect(await claim("wrong")).toBe(4);
    const results = await Promise.all([claim("first"), claim("second")]);
    expect(results.slice().sort()).toEqual([0, 6]);
    const taken = await q1<{ AwardID: string }>(h, sql`SELECT "AwardID" FROM player."Active_Number" WHERE "PullDown" = true`);
    expect(await claim(taken!.AwardID)).toBe(5);
    expect(await counts()).toEqual({ claims: 0, items: 1, mails: 1, taken: 1 });
  });

  it("preserves HasKey 2 per-user authorization, mark and repeat codes", async () => {
    await mode(2); await award({ Mark: 2 });
    expect(await claim()).toBe(10);
    await code(`${activeId}-2-${userId}`, 2);
    expect(await claim()).toBe(0);
    expect(await claim()).toBe(6);
    expect(await claim("", 112)).toBe(10);
    expect(await counts()).toEqual({ claims: 0, items: 1, mails: 1, taken: 1 });
  });

  it("preserves HasKey 4 shared-code behavior and does not apply HasKey 1 IsOnly", async () => {
    await mode(4, 1); await award(); await code("first"); await code("second");
    expect(await claim()).toBe(4);
    expect(await claim("wrong")).toBe(4);
    expect(await claim("first")).toBe(0);
    expect(await claim("first", 112)).toBe(5);
    expect(await claim("second")).toBe(0);
    expect(await counts()).toEqual({ claims: 0, items: 2, mails: 2, taken: 2 });
  });

  it.each([1, 2, 4])("rolls back code activation on a bad reward for HasKey %i, allowing repair/retry", async (hasKey) => {
    await mode(hasKey); const key = hasKey === 2 ? `${activeId}-2-${userId}` : "activation";
    await code(key); await award({ Count: 0 });
    expect(await claim(key)).toBe(3);
    expect(await counts()).toEqual(empty);
    const pending = await q1(h, sql`SELECT "PullDown","UserID" FROM player."Active_Number" WHERE "AwardID" = ${key}`);
    expect(pending).toEqual({ PullDown: false, UserID: 0 });
    await h.db.execute(sql`UPDATE game."Active_Award" SET "Count" = 1`);
    expect(await claim(key)).toBe(0);
  });

  it("notifies only after commit and an offline notification cannot undo successful delivery", async () => {
    await award(); built.ctx.cfg.GAME_INTERNAL_URL = "http://game.invalid";
    const transact = h.db.transaction.bind(h.db);
    let committed = false;
    vi.spyOn(h.db, "transaction").mockImplementation(async (fn, cfg) => {
      const result = await transact(fn, cfg); committed = true; return result;
    });
    const notices: boolean[] = [];
    const fetch = vi.fn(async () => { notices.push(committed); throw new Error("game offline"); });
    vi.stubGlobal("fetch", fetch);
    expect(await claim()).toBe(0);
    expect(notices).toEqual([true]);
    expect(fetch).toHaveBeenCalledWith("http://game.invalid/mail-notice", expect.objectContaining({ method: "POST", body: JSON.stringify({ userId }) }));
    expect(await claim()).toBe(6);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({ claims: 1, items: 1, mails: 1, taken: 0 });
  });

  it("retains GET/POST parameters and uncompressed success/failure XML", async () => {
    await award();
    await h.db.execute(sql`UPDATE game."Active" SET "Title"='本地启程补给' WHERE "ActiveID"=${activeId}`);
    const first = await built.app.inject({ method: "GET", url: `/Request/ActivePullDown.ashx?selfid=${userId}&activeID=${activeId}` });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("text/plain");
    expect(first.body).toBe('<Result value="true" message="领取成功，奖励已发送到您的邮箱。" />');
    expect(await q1(h, sql`SELECT "Title","Content" FROM player."User_Messages"`)).toEqual({ Title: "本地启程补给", Content: "活动奖励：本地启程补给" });
    const repeat = await built.app.inject({ method: "POST", url: "/request/ActivePullDown.ashx", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `selfid=${userId}&activeID=${activeId}&activeKey=` });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.body).toContain('value="false"');
    expect(repeat.body).toContain('message="您已经领取过该奖励。"');
    expect(await counts()).toEqual({ claims: 1, items: 1, mails: 1, taken: 0 });
  });
});
