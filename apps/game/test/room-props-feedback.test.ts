import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { Templates } from "../src/db/templates.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { registerRooms } from "../src/handlers/rooms.js";
import { registerUse } from "../src/handlers/use.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Memory-only players and PGlite. No listening service, socket or existing player save.
let db: DbHandle, templates: Templates, sequence = 0;
const now = new Date("2026-10-17T08:00:00Z");
const registry = new HandlerRegistry(); registerRooms(registry); registerUse(registry);
beforeAll(async () => {
  db = await createDb("pglite:memory"); await migrateDb(db);
  await seedDatabase(db, { only: ["Shop_Goods", "Shop", "ShopGoodsShowList"] });
  templates = await new Templates().load(db.db, 1, "original");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.db.execute(sql`DROP TRIGGER IF EXISTS test_prop_failure ON player."Sys_Users_Detail"`);
  await db.db.execute(sql`DROP FUNCTION IF EXISTS player.test_prop_failure()`);
});
afterAll(async () => { await db?.close(); });

async function fixture(gold = 321, money = 1234) {
  const [row] = await db.db.insert(player.Sys_Users_Detail).values({ UserName: `roomprop${++sequence}`, NickName: `RoomProp${sequence}`,
    Money: money, Gold: gold, Grade: 20, IsFirst: 1 }).returning();
  const sent: GSPacket[] = [];
  const p = new GamePlayer({ send: pkt => sent.push(GSPacket.parse(pkt.encode())), disconnect() {}, remoteAddress: "isolated-test" },
    (await loadPlayerInfo(db.db, row!.UserID))!, defaultMatch(row!.UserID), 1, "test");
  const tpl = Object.assign(new Templates(), templates, { shop: new Map(templates.shop), items: new Map(templates.items), showList: new Set(templates.showList) });
  tpl.findItem = id => tpl.items.get(id);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = { db, templates: tpl, now: () => now, log, lang: { t: (key: string) => key }, world: { all: () => [p] } } as unknown as ServerContext;
  const run = async (code: number, fill: (pkt: GSPacket) => void) => {
    const pkt = new GSPacket(code, 999999); fill(pkt); pkt.offset = 20;
    await registry.get(code)!.handle(ctx, { player: p } as GameClient, pkt);
  };
  const messages = () => sent.filter(pkt => pkt.code === 3).map(pkt => { pkt.offset = 20; pkt.readInt(); return pkt.readString(); });
  const shop = (id: number, fields: Partial<NonNullable<ReturnType<typeof tpl.shop.get>>>) => {
    tpl.shop.set(id, { ...tpl.shop.get(id)!, ...fields });
  };
  return { p, ctx, tpl, log, sent, run, messages, shop };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const buy = (f: Fixture, id = 1001202) => f.run(54, p => p.writeInt(id));
const sell = (f: Fixture, place = 0, id = 1001202) => f.run(55, p => { p.writeInt(place); p.writeInt(id); });
const vip = (f: Fixture, days: number) => f.run(92, p => { p.writeString(f.p.info.NickName); p.writeInt(days); });
const card = (f: Fixture, id: number) => f.run(183, p => {
  p.writeInt(1); p.writeInt(-1); p.writeInt(1); p.writeInt(id); p.writeInt(0); p.writeBoolean(false);
});
function vipShop(f: Fixture) { return [...f.tpl.shop.values()].find(s => s.TemplateID === 11992)!; }

describe("room prop packets 54/55", () => {
  it("registers the original RoomPropCell packet codes", () => {
    expect(registry.get(54)?.name).toBe("PROP_BUY"); expect(registry.get(55)?.name).toBe("PROP_SELL");
  });
  it("buys and sells the actual free beginner prop without creating a durable item", async () => {
    const f = await fixture(); expect(f.tpl.shop.get(1001202)!.AValue1).toBe(0);
    await buy(f);
    expect(f.p.fightBag.getItemAt(0)).toMatchObject({ TemplateID: 10012, Count: 1, BagType: 3 });
    expect(f.p.info.Gold).toBe(321); expect(f.p.info.Money).toBe(1234);
    expect((await loadUserItems(db.db, f.p.id, f.tpl.findItem)).get(3) ?? []).toEqual([]);
    expect(f.sent.some(p => p.code === 64)).toBe(true);
    await sell(f); expect(f.p.fightBag.getItems()).toEqual([]); expect(f.p.info.Gold).toBe(321);
  });
  it("uses all A-tier gold columns and Beat, persists the debit and exact refund, and allows a gold-only bag lock", async () => {
    const f = await fixture(); f.shop(1001202, { AValue1: 200, APrice2: -2, AValue2: 30, Beat: 0.5 });
    f.p.info.HasBagPassword = true; f.p.info.IsLocked = true;
    await buy(f); expect(f.p.info.Gold).toBe(206); expect((await loadPlayerInfo(db.db, f.p.id))!.Gold).toBe(206);
    await sell(f); expect(f.p.info.Gold).toBe(321); expect((await loadPlayerInfo(db.db, f.p.id))!.Gold).toBe(321);
    expect(f.p.info.Money).toBe(1234);
  });
  it("keeps count/validity semantics and refunds one whole untouched purchase", async () => {
    const f = await fixture(); f.shop(1001202, { AValue1: 100, AUnit: 3 }); await buy(f);
    expect(f.p.fightBag.getItemAt(0)?.Count).toBe(3); await sell(f); expect(f.p.info.Gold).toBe(321);
    f.shop(1001202, { AValue1: 100, BuyType: 0, AUnit: 7 }); await buy(f);
    expect(f.p.fightBag.getItemAt(0)).toMatchObject({ Count: 1, ValidDate: 7 });
  });
  it("rejects insufficient gold and a full FightBag without any debit", async () => {
    const f = await fixture(99); f.shop(1001202, { AValue1: 100 }); await buy(f);
    expect(f.messages().join()).toContain("金币不足"); expect(f.p.info.Gold).toBe(99); expect(f.p.fightBag.getItems()).toEqual([]);
    const full = await fixture(); for (let i = 0; i < 3; i++) await buy(full);
    full.shop(1001202, { AValue1: 100 }); await buy(full);
    expect(full.messages().join()).toContain("道具栏已满"); expect(full.p.info.Gold).toBe(321);
  });
  it("rejects forged shop/template, non-gold quote and malformed packets visibly", async () => {
    const f = await fixture(); await buy(f, -1);
    f.shop(1001202, { TemplateID: 7001 }); await buy(f);
    f.shop(1001202, { TemplateID: 10012, APrice1: -1, AValue1: 100 }); await buy(f);
    await f.run(54, () => {}); await f.run(55, p => p.writeInt(0));
    expect(f.messages()).toHaveLength(5); expect(f.log.warn).toHaveBeenCalledTimes(5);
    expect(f.p.info.Gold).toBe(321); expect(f.p.info.Money).toBe(1234); expect(f.p.fightBag.getItems()).toEqual([]);
  });
  it("refuses another shop's price, repeat refund and a partially consumed purchase", async () => {
    const f = await fixture(); await buy(f); const item = f.p.fightBag.getItemAt(0)!;
    await sell(f, 0, 1001102); expect(f.p.fightBag.getItemAt(0)).toBe(item); expect(f.p.info.Gold).toBe(321);
    await sell(f); await sell(f); expect(f.p.info.Gold).toBe(321); expect(f.messages()).toHaveLength(2);
    f.shop(1001202, { AUnit: 3, AValue1: 100 }); await buy(f);
    f.p.fightBag.removeCountFromStack(f.p.fightBag.getItemAt(0)!, 1);
    await sell(f); expect(f.p.info.Gold).toBe(221); expect(f.p.fightBag.getItemAt(0)?.Count).toBe(2);
  });
  it("rejects purchases and refunds once a fight has started", async () => {
    const f = await fixture(); await buy(f); f.p.currentRoom = { IsPlaying: true } as typeof f.p.currentRoom;
    await buy(f); await sell(f); expect(f.messages()).toHaveLength(2); expect(f.p.fightBag.getItems()).toHaveLength(1);
  });
  it("rolls back the profile and transient bag on a database save failure", async () => {
    const f = await fixture(); f.shop(1001202, { AValue1: 100 });
    await db.db.execute(sql`CREATE FUNCTION player.test_prop_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected prop failure'; END; $$`);
    await db.db.execute(sql`CREATE TRIGGER test_prop_failure BEFORE UPDATE ON player."Sys_Users_Detail" FOR EACH ROW EXECUTE FUNCTION player.test_prop_failure()`);
    await buy(f); expect(f.p.info.Gold).toBe(321); expect(f.p.fightBag.getItems()).toEqual([]);
    expect((await loadPlayerInfo(db.db, f.p.id))!.Gold).toBe(321); expect(f.messages().join()).toContain("保存失败");
  });
  it("retains a purchased item and its receipt when refund persistence fails, allowing one later refund", async () => {
    const f = await fixture(); f.shop(1001202, { AValue1: 100 }); await buy(f);
    const item = f.p.fightBag.getItemAt(0)!;
    await db.db.execute(sql`CREATE FUNCTION player.test_prop_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected prop failure'; END; $$`);
    await db.db.execute(sql`CREATE TRIGGER test_prop_failure BEFORE UPDATE ON player."Sys_Users_Detail" FOR EACH ROW EXECUTE FUNCTION player.test_prop_failure()`);
    await sell(f); expect(f.p.info.Gold).toBe(221); expect(f.p.fightBag.getItemAt(0)).toBe(item);
    expect((await loadPlayerInfo(db.db, f.p.id))!.Gold).toBe(221); expect(f.messages().join()).toContain("保存失败");
    await db.db.execute(sql`DROP TRIGGER test_prop_failure ON player."Sys_Users_Detail"`);
    await sell(f); await sell(f); expect(f.p.info.Gold).toBe(321); expect(f.p.fightBag.getItems()).toEqual([]);
  });
  it("serializes overlapping requests against one balance", async () => {
    const f = await fixture(100); f.shop(1001202, { AValue1: 100 });
    await Promise.all([buy(f), buy(f)]); expect(f.p.info.Gold).toBe(0); expect(f.p.fightBag.getItems()).toHaveLength(1);
    expect(f.messages().join()).toContain("金币不足");
    await Promise.all([sell(f), sell(f)]); expect(f.p.info.Gold).toBe(100); expect(f.p.fightBag.getItems()).toEqual([]);
  });
});

describe("visible VIP and quick-card purchase failures", () => {
  it.each([0, -1])("rejects invalid VIP duration %s in Chinese without charging", async days => {
    const f = await fixture(); await vip(f, days);
    expect(f.messages()).toContain("请选择正确的贵宾开通天数。"); expect(f.p.info.Money).toBe(1234);
    expect(f.log.warn).toHaveBeenCalledWith("purchase rejected", { code: 92, playerId: f.p.id, reason: "invalid_duration" });
  });
  it("reports missing and invalid VIP quotes without charging", async () => {
    const f = await fixture(); const s = vipShop(f); f.tpl.shop.delete(s.ID); await vip(f, 31);
    expect(f.messages().join()).toContain("价格配置暂不可用"); expect(f.p.info.Money).toBe(1234);
    f.tpl.shop.set(s.ID, { ...s, AUnit: 31, AValue1: -1 }); await vip(f, 31);
    expect(f.messages()).toHaveLength(2); expect(f.p.info.Money).toBe(1234);
  });
  it("reports insufficient VIP balance and retains valid A/B/C/prorated prices", async () => {
    for (const [days, price] of [[31, 300], [93, 800], [186, 1500], [10, 97]]) {
      const f = await fixture(321, 2000); const s = vipShop(f);
      f.shop(s.ID, { AUnit: 31, AValue1: 300, BUnit: 93, BValue1: 800, CUnit: 186, CValue1: 1500 });
      await vip(f, days!); expect(f.p.info.Money).toBe(2000 - price!); expect(f.p.info.VIPExpireDay.getTime()).toBe(now.getTime() + days! * 86400000);
    }
    const f = await fixture(321, 1); await vip(f, vipShop(f).AUnit);
    expect(f.messages().join()).toContain("点券不足"); expect(f.p.info.Money).toBe(1); expect(f.log.warn).toHaveBeenCalled();
  });
  it("reports non-coupon and unaffordable quick cards without debit or applying a buff", async () => {
    const f = await fixture(321, 1); const s = vipShop(f); f.tpl.showList.add(s.ID);
    f.shop(s.ID, { APrice1: -2, AValue1: 100 }); await card(f, s.ID);
    expect(f.messages().join()).toContain("不支持快捷购买"); expect(f.p.info.Money).toBe(1);
    f.shop(s.ID, { APrice1: -1 }); await card(f, s.ID);
    expect(f.messages().join()).toContain("点券不足"); expect(f.p.info.Money).toBe(1); expect(f.p.info.typeVIP).toBe(0); expect(f.p.buffs).toEqual([]);
    expect(f.log.warn).toHaveBeenCalledTimes(2);
  });
  it("keeps quick-card AValue1 pricing without applying shop Beat and supports locked coupons", async () => {
    const f = await fixture(321, 50); const s = vipShop(f); f.tpl.showList.add(s.ID);
    f.p.info.MoneyLock = 60; f.shop(s.ID, { APrice1: -1, AValue1: 100, AUnit: 31, Beat: 0.5 });
    await card(f, s.ID); expect(f.p.info.Money + f.p.info.MoneyLock).toBe(10); expect(f.p.info.Gold).toBe(321); expect(f.p.info.typeVIP).toBe(1);
  });
});
