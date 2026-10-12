import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDb, migrateDb, seedDatabase, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { Templates } from "../src/db/templates.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { EventData } from "../src/game/events.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { ItemInfo } from "../src/game/item.js";
import { startOnlineBoxTimer } from "../src/game/online-box.js";
import { eventsRuntime, timeBox } from "../src/handlers/events.js";
import { mailItems } from "../src/handlers/items.js";
import { World, type ServerContext } from "../src/session/context.js";
import { LanguageMgr } from "../src/util/lang.js";

const namesFile = fileURLToPath(new URL("../../../research/i18n/zh-CN-item-names.json", import.meta.url));
const names = (JSON.parse(readFileSync(namesFile, "utf8")) as { names: Record<string, string> }).names;
const strings: Record<string, string> = JSON.parse(readFileSync(new URL("../../../research/i18n/zh-CN-server-overrides.json", import.meta.url), "utf8"));
let h: DbHandle, templates: Templates, data: EventData, seq = 0;
beforeAll(async () => {
  h = await createDb("pglite:memory"); // No live DB, network server or elapsed-time changes outside the fixture.
  await migrateDb(h); await seedDatabase(h, { only: ["Shop_Goods", "Shop_Goods_Box", "User_Box", "LoadUserBox"] });
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", namesFile);
  templates = await new Templates().load(h.db, 1);
  data = new EventData(); await data.load(h.db);
});
afterAll(async () => { vi.unstubAllEnvs(); await h?.close(); });
async function fixture(full = false) {
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `zh_box_${++seq}`, NickName: `Box ${seq}`, Password: "test", IsFirst: 1, Grade: 9 }).returning();
  const info = (await loadPlayerInfo(h.db, owner!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "test" }, info, defaultMatch(info.ID), 1, "test");
  if (full) {
    const rows = await h.db.insert(player.Sys_Users_Goods).values(Array.from({ length: 96 }, (_, Place) => ({ UserID: p.id, BagType: 1, Place, TemplateID: 11001, Count: templates.findItem(11001)!.MaxCount, IsBinds: true }))).returning();
    p.propBag.loadItems(rows.map((row) => ItemInfo.fromRow(row, templates.findItem(row.TemplateID)!)));
  }
  const lang = LanguageMgr.fromFile(fileURLToPath(new URL("../../../data/i18n/pt-BR/server-language.txt", import.meta.url)));
  for (const [key, value] of Object.entries(strings)) lang.set(key, value);
  let now = new Date("2026-10-13T01:00:00Z");
  const ctx = { db: h, templates, lang, world: new World(), now: () => now } as unknown as ServerContext;
  ctx.world.add(p); eventsRuntime(ctx).data = data; startOnlineBoxTimer(p, now); sent.length = 0;
  return { p, ctx, sent, advance: (minutes: number) => { now = new Date(+now + minutes * 60_000); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(f: Fixture) {
  f.sent.length = 0;
  const pkt = new GSPacket(53, f.p.id); pkt.writeInt(1); pkt.writeInt(0); pkt.clearOffset();
  await timeBox(f.ctx, f.p, pkt);
  const response = f.sent.find((p) => p.code === 53)!; response.clearOffset();
  expect(response.length).toBe(25);
  const ok = response.readBoolean(), progression = response.readInt(); expect(response.dataLeft).toBe(0);
  const message = f.sent.find((p) => p.code === 3)!; message.clearOffset(); expect(message.readInt()).toBe(0);
  const text = message.readString(); expect(message.dataLeft).toBe(0);
  return { ok, progression, text };
}
const mails = (f: Fixture) => h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, f.p.id)).orderBy(player.User_Messages.ID);

it("uses translated success/final/failure messages and all 13 real rewards, retaining the original 53 payload", async () => {
  const f = await fixture();
  expect(await request(f)).toEqual({ ok: false, progression: 0, text: strings["UserGetTimeBoxHandler.fail"] });
  const tiers = [[15, [11001, 11005, 11009, 11013]], [40, [11002, 11006, 11010, 11014]], [60, [11003, 11007, 11011, 11015]], [75, [11233]]] as const;
  for (const [minutes, ids] of tiers) {
    f.advance(minutes);
    const response = await request(f);
    expect(response).toEqual({ ok: true, progression: minutes, text: `${strings[minutes === 75 ? "UserGetTimeBoxHandler.todayOver" : "UserGetTimeBoxHandler.success"]} ${ids.map((id) => `${names[id]} x1`).join(", ")}` });
    const snapshot = f.p.propBag.getItems().map((item) => item.toRow());
    expect(await request(f)).toEqual({ ok: false, progression: minutes, text: strings["UserGetTimeBoxHandler.fail"] });
    expect(f.p.propBag.getItems().map((item) => item.toRow())).toEqual(snapshot);
  }
  expect(f.p.propBag.getItems().map((item) => item.TemplateID).sort((a, b) => a - b)).toEqual(Object.keys(names).map(Number).sort((a, b) => a - b));
  for (const item of f.p.propBag.getItems()) expect(item).toMatchObject({ Count: 1, IsBinds: true, ValidDate: 0, StrengthenLevel: 0 });
  expect(await mails(f)).toEqual([]);
});

it("creates translated overflow title/body/attachments only for the new mail", async () => {
  const f = await fixture(true);
  const [historic] = await h.db.insert(player.User_Messages).values({ ReceiverID: f.p.id, Title: "Caixa de tempo", Content: "Existing content", Annex1Name: "Existing name", Type: 12 }).returning();
  f.advance(15); expect((await request(f)).ok).toBe(true);
  const [old, mail] = await mails(f); expect(old).toEqual(historic);
  expect(mail).toMatchObject({ Title: "在线宝箱奖励", Content: "背包已满，在线宝箱奖励已通过邮件发送，请查收。", Type: 12, Gold: 0, Money: 0, ReceiverID: f.p.id,
    Annex1Name: "朱雀石1级", Annex2Name: "玄武石1级", Annex3Name: "青龙石1级", Annex4Name: "白虎石1级", AnnexRemark: "附件：1、朱雀石1级x1;2、玄武石1级x1;3、青龙石1级x1;4、白虎石1级x1;" });
  for (const [index, id] of [mail!.Annex1, mail!.Annex2, mail!.Annex3, mail!.Annex4].entries()) {
    const [item] = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, Number(id)));
    expect(item).toMatchObject({ UserID: 0, BagType: -1, Place: -1, Count: 1, IsBinds: true, TemplateID: [11001, 11005, 11009, 11013][index] });
  }
  expect(f.sent.filter((pkt) => pkt.code === 117)).toHaveLength(1);
  expect((await request(f)).ok).toBe(false); expect(await mails(f)).toEqual([old, mail]);
});

it.each([undefined, "Legacy title"])("keeps old mailItems body/type/grouping when no body is supplied (%s)", async (title) => {
  const f = await fixture();
  const items = Array.from({ length: 6 }, () => ItemInfo.createFromTemplate(templates.findItem(11001)!, 1, 0, f.ctx.now()));
  await mailItems(f.ctx, f.p, items, title);
  const result = await mails(f); expect(result).toHaveLength(2);
  const expected = title ?? `${f.ctx.lang.t("UserBuyItemHandler.Title")}朱雀石1级]`;
  for (const mail of result) expect(mail).toMatchObject({ Title: expected, Content: expected, Type: 8, Gold: 0, Money: 0, ReceiverID: f.p.id });
  expect(result[0]!.Annex5).toBeTruthy(); expect(result[1]!.Annex1).toBeTruthy(); expect(result[1]!.Annex2 ?? "").toBe("");
  expect(f.sent.filter((pkt) => pkt.code === 117)).toHaveLength(1);
});
