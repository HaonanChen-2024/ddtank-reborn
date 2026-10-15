import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { q } from "../src/lib/db.js";
import { pullDown } from "../src/request/endpoints/events.js";
import { TEMPLATES } from "../src/templates/defs.js";

const tmp = mkdtempSync(join(tmpdir(), "ddt-calendar-state-"));
const md5 = (value: string) => createHash("md5").update(value).digest("hex");
let h: DbHandle;
let built: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","IsFirst")
    VALUES (111, 'calendar-one', 'One', true, 1), (112, 'calendar-two', 'Two', false, 1)`);
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config: {
    NODE_ENV: "test", DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, GAME_INTERNAL_URL: "",
    FLASH_DIR: join(tmp, "flash"), RESOURCE_DIR: join(tmp, "resource"), UPLOAD_DIR: join(tmp, "uploads"),
  } });
});
beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE app."LoginSessions", app."EventClaims", player."DailyLogList", player."Active_Number", player."User_Messages", player."Sys_Users_Goods", game."Active_Award", game."Active"`);
  await h.db.execute(sql`INSERT INTO app."LoginSessions" ("UserName","WebKey","GameKey","UserID","Count","ExpiresAt","GameKeyExpiresAt")
    VALUES ('calendar-one', 'web-one', 'game-one', 111, 1, '2100-01-01', '2100-01-01'),
      ('calendar-two', 'web-two', 'game-two', 112, 1, '2100-01-01', '2100-01-01')`);
  for (const id of [101, 102, 103, 104]) await h.db.insert(game.Active).values({ ActiveID: id, Title: `Activity ${id}`,
    HasKey: id === 103 ? 3 : id === 104 ? 4 : id - 100, StartDate: new Date("2020-01-01Z"), EndDate: new Date("2100-01-01Z"),
    Description: "Keep <all> & fields", Content: "Content", AwardContent: "Reward", ActionTimeContent: "Window" });
  await h.db.insert(game.Active_Award).values({ ActiveID: 103, ItemID: 0, Count: 0, Gold: 10 });
});
afterAll(async () => { await built?.app.close(); await h?.close(); });

async function request(uid = "111", key: string | null = md5("game-one"), post = false) {
  const params = new URLSearchParams({ selfid: uid }); if (key !== null) params.set("key", key);
  const response = await built.app.inject(post
    ? { method: "POST", url: "/request/usercalendar.ashx", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: params.toString() }
    : { method: "GET", url: "/Request/UserCalendar.ashx?" + params });
  return { response, text: inflateSync(response.rawPayload).toString("utf8") };
}
const entry = (text: string, id: number) => text.match(new RegExp(`<Item ActiveID="${id}"[^>]* />`))?.[0];
async function counts() {
  return q(h, sql`SELECT (SELECT count(*)::int FROM app."EventClaims") AS claims,
    (SELECT count(*)::int FROM player."User_Messages") AS mails,
    (SELECT count(*)::int FROM player."Sys_Users_Goods") AS items,
    (SELECT count(*)::int FROM player."DailyLogList") AS calendars`);
}

describe("authenticated Calendar claim snapshot", () => {
  it("keeps the legacy compressed failure XML when its transaction cannot start", async () => {
    const before = await counts();
    const transaction = vi.spyOn(h.db, "transaction").mockRejectedValueOnce(new Error("calendar transaction unavailable"));
    try {
      const response = await built.app.inject({ url: "/request/dailyloglist.ashx?selfid=111&key=x" });
      const text = inflateSync(response.rawPayload).toString("utf8");
      expect(response.statusCode).toBe(200);
      expect(text).toMatch(/^<Result value="false" message="Fail!" nowDate="[^"]+" \/>$/);
      expect(await counts()).toEqual(before);
    } finally { transaction.mockRestore(); }
  });

  it("returns unclaimed, claimed and rotated-session state without a second reward", async () => {
    expect(entry((await request()).text, 103)).toContain('isAttend="false"');
    expect(await pullDown(built.ctx, 103, "", 111)).toBe(0);
    const claimed = await request(); expect(entry(claimed.text, 103)).toContain('isAttend="true"');
    expect(claimed.text).toContain('UserID="111"');
    expect(claimed.text).toContain("<DailyLogList UserAwardLog="); expect(claimed.text).toContain('nowDate="');
    expect(claimed.response.headers["cache-control"]).toBe("no-store"); expect(claimed.response.headers.etag).toBeUndefined();
    await h.db.execute(sql`UPDATE app."LoginSessions" SET "GameKey" = 'new-game-one' WHERE "UserID" = 111`);
    expect((await request()).text).toContain('value="false"');
    expect(entry((await request("111", md5("new-game-one"), true)).text, 103)).toContain('isAttend="true"');
    const before = await counts(); expect(await pullDown(built.ctx, 103, "", 111)).toBe(6); expect(await counts()).toEqual(before);
  });

  it("never exposes another user's claims and preserves shared ActiveList bytes/ETag", async () => {
    const def = TEMPLATES.find((x) => x.endpoint === "/ActiveList.ashx")!; await built.ctx.cache.rebuild(def);
    const before = await built.app.inject({ url: "/Request/ActiveList.xml" });
    expect(await pullDown(built.ctx, 103, "", 111)).toBe(0);
    expect(entry((await request()).text, 103)).toContain('isAttend="true"');
    expect(entry((await request("112", md5("game-two"))).text, 103)).toContain('isAttend="false"');
    expect((await request("112", md5("game-one"))).text).not.toContain("<Item");
    const after = await built.app.inject({ url: "/Request/ActiveList.xml" });
    expect(after.rawPayload).toEqual(before.rawPayload); expect(after.headers.etag).toBe(before.headers.etag);
    const publicXml = inflateSync(after.rawPayload).toString("utf8"); expect(publicXml).not.toContain("isAttend");
    const personal = (await request()).text;
    for (const id of [101, 102, 103, 104]) expect(entry(personal, id)?.replace(/ isAttend="(?:true|false)"/, "")).toBe(entry(publicXml, id));
  });

  it("leaves non-HasKey3 attendance unspecified even if unrelated records exist", async () => {
    for (const id of [101, 102, 104]) {
      await h.db.execute(sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (111, 'active', ${String(id)})`);
      await h.db.execute(sql`INSERT INTO player."Active_Number" ("AwardID","ActiveID","UserID","PullDown") VALUES (${String(id)}, ${id}, 111, true)`);
    }
    const personal = (await request()).text;
    for (const id of [101, 102, 104]) expect(entry(personal, id)).not.toContain("isAttend");
    expect(entry(personal, 103)).toContain('isAttend="false"');
  });

  it("uses only the owner's exchange claim for a once-per-event material activity", async () => {
    for (const [id, activeType, hasKey, isOnly] of [[105, 1, 6, 1], [106, 1, 6, 0], [107, 0, 6, 1], [108, 1, 3, 1]])
      await h.db.insert(game.Active).values({ ActiveID: id!, Title: "材料兑换", ActiveType: activeType!, HasKey: hasKey!, IsOnly: isOnly!,
        StartDate: new Date("2020-01-01Z"), EndDate: new Date("2100-01-01Z"), GoodsExchangeTypes: "11", GoodsExchangeNum: "2", limitType: "1", limitValue: "1" });
    await h.db.execute(sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (111, 'active', '105'), (112, 'exchange', '105')`);
    expect(entry((await request()).text, 105)).toContain('isAttend="false"');
    expect(entry((await request("112", md5("game-two"))).text, 105)).toContain('isAttend="true"');
    await h.db.execute(sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (111, 'exchange', '105')`);
    const personal = await request(), before = await counts();
    expect(entry(personal.text, 105)).toContain('isAttend="true"');
    expect(entry(personal.text, 105)).toContain('GoodsExchangeNum="2"');
    expect(personal.response.headers["cache-control"]).toBe("no-store");
    for (const id of [106, 107, 108]) expect(entry(personal.text, id)).not.toContain("isAttend");
    expect(await pullDown(built.ctx, 105, "", 111)).toBe(11); expect(await counts()).toEqual(before);
    const def = TEMPLATES.find(x => x.endpoint === "/ActiveList.ashx")!; await built.ctx.cache.rebuild(def);
    const shared = await built.app.inject({url: "/Request/ActiveList.xml"});
    expect(inflateSync(shared.rawPayload).toString("utf8")).not.toContain("isAttend");
  });

  it.each([["111", null], ["111", "bad"], ["111", "game-one"], ["111", md5("web-one")], ["111", md5("wrong")],
    ["111junk", md5("game-one")], ["0", md5("game-one")], ["2147483648", md5("game-one")], ["999", md5("game-one")]])
  ("rejects invalid identity %s without calendar or reward writes", async (uid, key) => {
    const before = await counts(), response = await request(uid!, key);
    expect(response.text).toBe('<Result value="false" message="游戏会话无效，请重新登录。" />');
    expect(await counts()).toEqual(before);
  });

  it.each(["expired", "missing-key", "unconsumed", "wrong-owner"])("rejects %s session before reading private state", async (mode) => {
    if (mode === "expired") await h.db.execute(sql`UPDATE app."LoginSessions" SET "GameKeyExpiresAt" = '2000-01-01' WHERE "UserID" = 111`);
    if (mode === "missing-key") await h.db.execute(sql`UPDATE app."LoginSessions" SET "GameKey" = NULL WHERE "UserID" = 111`);
    if (mode === "unconsumed") await h.db.execute(sql`UPDATE app."LoginSessions" SET "Count" = 0 WHERE "UserID" = 111`);
    if (mode === "wrong-owner") await h.db.execute(sql`UPDATE app."LoginSessions" SET "UserID" = 112 WHERE "UserName" = 'calendar-one'`);
    const before = await counts(); expect((await request()).text).not.toContain("<Item"); expect(await counts()).toEqual(before);
  });
});
