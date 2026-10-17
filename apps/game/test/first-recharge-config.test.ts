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
import { eventsRuntime, firstRecharge } from "../src/handlers/events.js";
import { World, type ServerContext } from "../src/session/context.js";
import { LanguageMgr } from "../src/util/lang.js";

const unavailableKey = "Workshop.Events.FirstRecharge.Unavailable";
const overrides: Record<string, string> = JSON.parse(readFileSync(new URL("../../../research/i18n/zh-CN-server-overrides.json", import.meta.url), "utf8"));
const additions: Record<string, string> = JSON.parse(readFileSync(new URL("../../../research/i18n/zh-CN-server-additions.json", import.meta.url), "utf8"));
const reward = { ActivityType: 7, SubActivityType: 1, TemplateId: 11022, Count: 2, IsBind: false, ValidDate: 7, StrengthLevel: 3, AttackCompose: 1, DefendCompose: 2, AgilityCompose: 3, LuckCompose: 4 };
type Reward = typeof game.Event_Reward_Goods.$inferInsert;
let h: DbHandle, templates: Templates, sequence = 0;

beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods", "Event_Reward_Info", "Event_Reward_Goods"] });
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", fileURLToPath(new URL("../../../research/i18n/zh-CN-item-names.json", import.meta.url)));
  templates = await new Templates().load(h.db, 1);
});
afterAll(async () => { vi.unstubAllEnvs(); await h?.close(); });

async function configure(f: Fixture, info: boolean, goods: Reward[]) {
  // Replace only 7/1 in this memory DB. No fixture is a production reward definition,
  // and the tests do not require future legitimate seed configuration to stay empty.
  await h.db.delete(game.Event_Reward_Info).where(sql`"ActivityType" = 7 AND "SubActivityType" = 1`);
  await h.db.delete(game.Event_Reward_Goods).where(sql`"ActivityType" = 7 AND "SubActivityType" = 1`);
  if (info) await h.db.insert(game.Event_Reward_Info).values({ ActivityType: 7, SubActivityType: 1, Condition: 123456789 });
  if (goods.length) await h.db.insert(game.Event_Reward_Goods).values(goods);
  await eventsRuntime(f.ctx).data.load(h.db);
}

async function fixture(full = false, missingLanguage = false) {
  vi.stubEnv("FIRST_RECHARGE_FREE", "true");
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `first_config_${++sequence}`, NickName: `Config ${sequence}`, Grade: 9, IsFirst: 1 }).returning();
  const info = (await loadPlayerInfo(h.db, owner!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "first-recharge-memory" }, info, defaultMatch(info.ID), 1, "test");
  const lang = LanguageMgr.fromFile(fileURLToPath(new URL("../../../data/i18n/pt-BR/server-language.txt", import.meta.url)));
  for (const [key, value] of Object.entries({ ...overrides, ...additions })) if (!missingLanguage || key !== unavailableKey) lang.set(key, value);
  p.lang = (key, ...args) => lang.t(key, ...args);
  const ctx = { db: h, templates, lang, world: new World(), now: () => new Date("2026-10-16T08:00:00Z") } as unknown as ServerContext;
  ctx.world.add(p); eventsRuntime(ctx).data = new EventData();
  if (full) for (let place = 0; place < p.propBag.capacity; place++) {
    expect(p.propBag.addItemTo(ItemInfo.createFromTemplate(templates.findItem(334103)!, 1, 0, ctx.now()), place)).toBe(true);
  }
  await h.db.insert(player.User_Messages).values({ ReceiverID: p.id, Title: "Historic", Content: "Original body", Type: 12 });
  sent.length = 0;
  return { ctx, p, sent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const claims = (f: Fixture) => h.db.select().from(app.EventClaims).where(eq(app.EventClaims.UserID, f.p.id));
const mails = (f: Fixture) => h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, f.p.id)).orderBy(player.User_Messages.ID);
async function state(f: Fixture) {
  return {
    info: structuredClone(f.p.info),
    inventory: f.p.allBags().map(bag => bag.getItems().map(item => item.toRow())),
    storedItems: await h.db.select().from(player.Sys_Users_Goods).orderBy(player.Sys_Users_Goods.ItemID),
    mails: await mails(f), claims: await claims(f),
  };
}
function notices(f: Fixture) {
  return f.sent.filter(packet => packet.code === 3).map(packet => {
    packet.clearOffset(); expect(packet.readInt()).toBe(0);
    const text = packet.readString(); expect(packet.dataLeft).toBe(0); return text;
  });
}
async function expectUnavailable(f: Fixture, expected = "当前礼包奖励暂不可领取。") {
  const before = await state(f);
  f.sent.length = 0;
  expect(await firstRecharge(f.ctx, f.p)).toBe(false);
  expect(notices(f)).toEqual([expected]);
  expect(f.sent.map(packet => packet.code)).toEqual([3]);
  expect(await state(f)).toEqual(before);
  expect(f.p.info.IsGetAward).toBe(false);
  expect(await claims(f)).toEqual([]);
}

it.each([
  { name: "missing info and goods", info: false, goods: [] },
  { name: "info only", info: true, goods: [] },
  { name: "goods only", info: false, goods: [reward] },
  { name: "one missing template rejects the entire group", info: true, goods: [reward, { ...reward, TemplateId: 2147483647 }] },
  { name: "zero count", info: true, goods: [{ ...reward, Count: 0 }] },
  { name: "negative count", info: true, goods: [{ ...reward, Count: -1 }] },
  { name: "null count", info: true, goods: [{ ...reward, Count: null }] },
])("$name rejects before claiming and can be repaired without losing the reward", async ({ info, goods }) => {
  const f = await fixture();
  await configure(f, info, goods);
  expect(eventsRuntime(f.ctx).data.firstRechargeGoods(templates.findItem)).toBeUndefined();
  await expectUnavailable(f);
  await expectUnavailable(f);
  await configure(f, true, [reward]);
  expect(await firstRecharge(f.ctx, f.p)).toBe(true);
  expect(f.p.propBag.getItemByTemplateID(0, 11022)).toMatchObject({ Count: 2 });
  expect(await claims(f)).toHaveLength(1);
  expect(f.p.info.IsGetAward).toBe(true);
});

it.each([false, true])("complete memory configuration preserves every reward field and once-only delivery (full=%s)", async full => {
  const f = await fixture(full);
  await configure(f, true, [reward]);
  const historic = await mails(f);
  expect(await firstRecharge(f.ctx, f.p)).toBe(true);
  expect(notices(f)).toEqual([`礼包领取成功。 ${templates.findItem(11022)!.Name} x2`]);
  const packets = f.sent.filter(packet => packet.code === 259); expect(packets).toHaveLength(1);
  packets[0]!.clearOffset(); expect([packets[0]!.readBoolean(), packets[0]!.readBoolean()]).toEqual([true, true]); expect(packets[0]!.dataLeft).toBe(0);
  const fields = { TemplateID: 11022, Count: 2, IsBinds: false, ValidDate: 7, StrengthenLevel: 3, AttackCompose: 1, DefendCompose: 2, AgilityCompose: 3, LuckCompose: 4 };
  if (full) {
    const [old, ...created] = await mails(f); expect(old).toEqual(historic[0]); expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ Title: "首次礼包奖励", Content: "首次礼包奖励", Type: 12 });
    const [item] = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, Number(created[0]!.Annex1)));
    expect(item).toMatchObject({ ...fields, UserID: 0, BagType: -1, Place: -1 });
  } else {
    expect(f.p.propBag.getItemByTemplateID(0, 11022)).toMatchObject(fields);
    expect(await mails(f)).toEqual(historic);
  }
  expect(await claims(f)).toMatchObject([{ Kind: "firstrecharge", Key: "once" }]);
  // Already-claimed feedback has priority even if configuration is removed later,
  // including SQL idempotency when the in-memory flag is stale.
  await configure(f, false, []);
  for (const staleFlag of [false, true]) {
    if (staleFlag) f.p.info.IsGetAward = false;
    const before = await state(f); f.sent.length = 0;
    expect(await firstRecharge(f.ctx, f.p)).toBe(false);
    expect(notices(f)).toEqual([f.ctx.lang.t("FirstRechargeGetAward.AlreadyGetAward")]);
    expect(f.sent.map(packet => packet.code)).toEqual([3]); expect(await state(f)).toEqual(before);
  }
});

it("preserves free/recharged qualification while missing configuration rejects recharged players", async () => {
  const f = await fixture(); await configure(f, false, []);
  vi.stubEnv("FIRST_RECHARGE_FREE", "false");
  f.p.info.IsRecharged = false;
  const before = await state(f);
  expect(await firstRecharge(f.ctx, f.p)).toBe(false); expect(f.sent).toEqual([]); expect(await state(f)).toEqual(before);
  f.p.info.IsRecharged = true; await expectUnavailable(f);
  await configure(f, true, [reward]);
  f.p.info.IsRecharged = false; f.sent.length = 0;
  expect(await firstRecharge(f.ctx, f.p)).toBe(false); expect(f.sent).toEqual([]); expect(await claims(f)).toEqual([]);
  f.p.info.IsRecharged = true; expect(await firstRecharge(f.ctx, f.p)).toBe(true);
});

it("uses the Chinese fallback when the new unavailable key is missing", async () => {
  const f = await fixture(false, true); await configure(f, false, []);
  await expectUnavailable(f, "礼包暂不可用。");
});

it("preserves all existing currency and experience reward branches with nonzero once-only results", async () => {
  const f = await fixture();
  const ids = [-100, -200, -300, -800, -1100, 11107];
  await configure(f, true, ids.map(TemplateId => ({ ...reward, TemplateId, Count: 2 })));
  const before = { Gold: f.p.info.Gold, Money: f.p.info.Money, GiftToken: f.p.info.GiftToken, myHonor: f.p.info.myHonor, GP: f.p.info.GP };
  const beforeMail = await mails(f);
  expect(eventsRuntime(f.ctx).data.firstRechargeGoods(templates.findItem)?.map(row => row.TemplateId)).toEqual(ids);
  expect(await firstRecharge(f.ctx, f.p)).toBe(true);
  expect(f.p.info).toMatchObject(Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value + 2])));
  expect(f.p.propBag.getItemByTemplateID(0, 11408)).toMatchObject({ TemplateID: 11408, Count: 2 });
  expect(await mails(f)).toEqual(beforeMail);
  expect(f.sent.filter(packet => packet.code === 259)).toHaveLength(1);
  expect(await claims(f)).toHaveLength(1);
  const delivered = await state(f); f.sent.length = 0;
  expect(await firstRecharge(f.ctx, f.p)).toBe(false);
  expect(notices(f)).toEqual([f.ctx.lang.t("FirstRechargeGetAward.AlreadyGetAward")]);
  expect(await state(f)).toEqual(delivered);
});
