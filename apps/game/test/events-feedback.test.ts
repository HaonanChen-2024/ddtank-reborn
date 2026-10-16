import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { app, createDb, game, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { Templates } from "../src/db/templates.js";
import { EventData } from "../src/game/events.js";
import { ItemInfo } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { eventsRuntime, firstRecharge, registerEvents } from "../src/handlers/events.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import { World, type ServerContext } from "../src/session/context.js";
import { LanguageMgr } from "../src/util/lang.js";

const namesFile = fileURLToPath(new URL("../../../research/i18n/zh-CN-item-names.json", import.meta.url));
const strings: Record<string, string> = JSON.parse(readFileSync(new URL("../../../research/i18n/zh-CN-server-overrides.json", import.meta.url), "utf8"));
const additions: Record<string, string> = JSON.parse(readFileSync(new URL("../../../research/i18n/zh-CN-server-additions.json", import.meta.url), "utf8"));
const feedbackKeys = ["Workshop.Events.FirstRecharge.Title", "Workshop.Events.FirstRecharge.Success", "Workshop.Events.AccumulativeLogin.Title", "Workshop.Events.AccumulativeLogin.Success"];
const registry = new HandlerRegistry(); registerEvents(registry);
let h: DbHandle, templates: Templates, data: EventData, sequence = 0;

beforeAll(async () => {
  h = await createDb("pglite:memory"); // No configured DB, listening server, or browser.
  await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods", "Login_Award_Item_Template", "Event_Reward_Goods"] });
  // Use an explicit memory-only delivery fixture, independent of production
  // reward configuration; this setup does not establish production availability.
  await h.db.delete(game.Event_Reward_Goods).where(sql`"ActivityType" = 7 AND "SubActivityType" = 1`);
  await h.db.delete(game.Event_Reward_Info).where(sql`"ActivityType" = 7 AND "SubActivityType" = 1`);
  await h.db.insert(game.Event_Reward_Info).values({ ActivityType: 7, SubActivityType: 1, Condition: 0 });
  await h.db.insert(game.Event_Reward_Goods).values({ ActivityType: 7, SubActivityType: 1, TemplateId: 11022, Count: 2, IsBind: true, ValidDate: 0 });
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", namesFile);
  vi.stubEnv("FIRST_RECHARGE_FREE", "true");
  templates = await new Templates().load(h.db, 1);
  data = await new EventData().load(h.db);
});
afterAll(async () => { vi.unstubAllEnvs(); await h?.close(); });

async function fixture(full: boolean, locale: "Chinese" | "missing") {
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `feedback_${++sequence}`, NickName: `Feedback ${sequence}`, Grade: 9, IsFirst: 1 }).returning();
  const info = (await loadPlayerInfo(h.db, owner!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "events-feedback-memory" }, info, defaultMatch(info.ID), 1, "test");
  const lang = LanguageMgr.fromFile(fileURLToPath(new URL("../../../data/i18n/pt-BR/server-language.txt", import.meta.url)));
  for (const [key, value] of Object.entries({ ...strings, ...additions })) {
    if (locale !== "missing" || !feedbackKeys.includes(key)) lang.set(key, value);
  }
  p.lang = (key, ...args) => lang.t(key, ...args);
  const ctx = { db: h, templates, lang, world: new World(), now: () => new Date("2026-10-16T08:00:00Z") } as unknown as ServerContext;
  ctx.world.add(p); eventsRuntime(ctx).data = data;
  if (full) {
    for (let place = 0; place < p.propBag.capacity; place++) {
      const item = ItemInfo.createFromTemplate(templates.findItem(334103)!, 1, 0, ctx.now());
      expect(p.propBag.addItemTo(item, place)).toBe(true);
    }
  }
  const [historic] = await h.db.insert(player.User_Messages).values({ ReceiverID: p.id, Title: "Historic", Content: "Original body", Type: 12 }).returning();
  sent.length = 0;
  return { ctx, p, sent, historic: historic! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const mails = (f: Fixture) => h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, f.p.id)).orderBy(player.User_Messages.ID);
const inventory = (f: Fixture) => f.p.allBags().map(bag => bag.getItems().map(item => item.toRow()));
async function claims(f: Fixture) {
  return h.db.select({ Kind: app.EventClaims.Kind, Key: app.EventClaims.Key }).from(app.EventClaims)
    .where(eq(app.EventClaims.UserID, f.p.id)).orderBy(app.EventClaims.Kind, app.EventClaims.Key);
}
function notices(f: Fixture) {
  return f.sent.filter(packet => packet.code === 3).map(packet => {
    packet.clearOffset(); expect(packet.readInt()).toBe(0);
    const text = packet.readString(); expect(packet.dataLeft).toBe(0); return text;
  });
}
function response(f: Fixture, code: number) {
  const packets = f.sent.filter(packet => packet.code === code);
  expect(packets).toHaveLength(1);
  packets[0]!.clearOffset(); return packets[0]!;
}
function rewardCounts(items: { templateId: number; count: number }[]) {
  const counts = new Map<number, number>();
  for (const item of items) counts.set(item.templateId, (counts.get(item.templateId) ?? 0) + item.count);
  return [...counts].sort(([a], [b]) => a - b);
}

it.each([false, true])("first gift delivers once with Chinese feedback and untranslated-key fallback (full=%s)", async full => {
  for (const locale of ["Chinese", "missing"] as const) {
    const f = await fixture(full, locale), beforeMail = await mails(f);
    expect(f.p.info.IsGetAward).toBe(false);
    expect(await firstRecharge(f.ctx, f.p)).toBe(true);
    const summary = `${templates.findItem(11022)!.Name} x2`;
    expect(notices(f)).toEqual([locale === "Chinese" ? `礼包领取成功。 ${summary}` : `Presente recebido! ${summary}`]);
    const packet = response(f, 259);
    expect([packet.readBoolean(), packet.readBoolean()]).toEqual([true, true]); expect(packet.dataLeft).toBe(0);
    expect(f.p.info.IsGetAward).toBe(true);
    const [historic, ...created] = await mails(f); expect(historic).toEqual(beforeMail[0]);
    if (full) {
      expect(created).toHaveLength(1);
      const title = locale === "Chinese" ? "首次礼包奖励" : "Presente da primeira recarga";
      expect(created[0]).toMatchObject({ Title: title, Content: title, Type: 12 });
      const [item] = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, Number(created[0]!.Annex1)));
      expect(item).toMatchObject({ UserID: 0, BagType: -1, Place: -1, TemplateID: 11022, Count: 2, IsBinds: true, ValidDate: 0, StrengthenLevel: 0 });
    } else {
      expect(created).toEqual([]);
      expect(f.p.propBag.getItemByTemplateID(0, 11022)).toMatchObject({ Count: 2, IsBinds: true, ValidDate: 0, StrengthenLevel: 0 });
    }
    expect(await claims(f)).toEqual([{ Kind: "firstrecharge", Key: "once" }]);
    const beforeInventory = inventory(f), deliveredMail = await mails(f);
    // Both the live award flag and the existing SQL idempotency row reject replays.
    for (const resetFlag of [false, true]) {
      if (resetFlag) f.p.info.IsGetAward = false;
      f.sent.length = 0;
      expect(await firstRecharge(f.ctx, f.p)).toBe(false);
      expect(notices(f)).toEqual([f.ctx.lang.t("FirstRechargeGetAward.AlreadyGetAward")]);
      expect(f.sent.some(packet => packet.code === 259)).toBe(false);
      expect(inventory(f)).toEqual(beforeInventory); expect(await mails(f)).toEqual(deliveredMail);
      expect(await claims(f)).toEqual([{ Kind: "firstrecharge", Key: "once" }]);
    }
  }
});

async function loginRequest(f: Fixture, selected = 0) {
  const packet = new GSPacket(338, f.p.id); packet.writeInt(selected);
  await registry.get(338)!.handle(f.ctx, { player: f.p } as GameClient, GSPacket.parse(packet.encode()));
}
it.each([false, true])("338 grants original days 1..3 with separate day/summary arguments and stable replays (full=%s)", async full => {
  for (const locale of ["Chinese", "missing"] as const) {
    const f = await fixture(full, locale); f.p.info.accumulativeLoginDays = 3; f.p.info.accumulativeAwardDays = 0;
    const summaries = [1, 2, 3].map(day => data.loginAward.filter(row => row.Type === day).map(row => `${templates.findItem(row.RewardItemID)!.Name} x${row.RewardItemCount}`).join(", "));
    await loginRequest(f);
    expect(notices(f)).toEqual(summaries.map((summary, i) => locale === "Chinese" ? `累计登录${i + 1}天奖励领取成功。 ${summary}` : `Presente de ${i + 1} dia(s) de login: ${summary}`));
    const packet = response(f, 338);
    expect([packet.readInt(), packet.readInt()]).toEqual([3, 3]); expect(packet.dataLeft).toBe(0);
    expect(f.p.info.accumulativeAwardDays).toBe(3);
    const [historic, ...created] = await mails(f); expect(historic).toEqual(f.historic);
    const rows = data.loginAward.filter(row => row.Type >= 1 && row.Type <= 3);
    if (full) {
      expect(created.map(mail => mail.Title)).toEqual([1, 2, 3].map(day => locale === "Chinese" ? `累计登录${day}天奖励` : `Presente de ${day} dia(s) de login`));
      const delivered: { templateId: number; count: number }[] = [];
      for (const mail of created) {
        expect(mail).toMatchObject({ Content: mail.Title, Type: 12 });
        for (const id of [mail.Annex1, mail.Annex2, mail.Annex3, mail.Annex4, mail.Annex5].filter(Boolean)) {
          const [item] = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, Number(id)));
          delivered.push({ templateId: item!.TemplateID, count: item!.Count });
          expect(item).toMatchObject({ UserID: 0, BagType: -1, Place: -1, IsBinds: true, ValidDate: 0, StrengthenLevel: 0 });
          expect(item!.Count).toBeLessThanOrEqual(templates.findItem(item!.TemplateID)!.MaxCount);
        }
      }
      expect(rewardCounts(delivered)).toEqual(rewardCounts(rows.map(row => ({ templateId: row.RewardItemID, count: row.RewardItemCount }))));
    } else {
      expect(created).toEqual([]);
      for (const id of new Set(rows.map(row => row.RewardItemID))) {
        const items = f.p.propBag.getItems().filter(item => item.TemplateID === id);
        expect(items.reduce((sum, item) => sum + item.Count, 0)).toBe(rows.filter(row => row.RewardItemID === id).reduce((sum, row) => sum + row.RewardItemCount, 0));
        for (const item of items) {
          expect(item).toMatchObject({ IsBinds: true, ValidDate: 0, StrengthenLevel: 0 });
          expect(item.Count).toBeLessThanOrEqual(item.template.MaxCount);
        }
      }
    }
    const expectedClaims = [1, 2, 3].map(day => ({ Kind: "accaward", Key: String(day) }));
    expect(await claims(f)).toEqual(expectedClaims);
    const beforeInventory = inventory(f), beforeMail = await mails(f);
    for (const resetFlag of [false, true]) {
      if (resetFlag) f.p.info.accumulativeAwardDays = 0;
      f.sent.length = 0; await loginRequest(f);
      expect(notices(f)).toEqual([]); expect(inventory(f)).toEqual(beforeInventory); expect(await mails(f)).toEqual(beforeMail);
      expect(await claims(f)).toEqual(expectedClaims);
      const replay = response(f, 338);
      expect([replay.readInt(), replay.readInt()]).toEqual([3, 3]); expect(replay.dataLeft).toBe(0);
    }
  }
});
