import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { Templates } from "../src/db/templates.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { ItemInfo } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { registerItems } from "../src/handlers/items.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { STRENGTH_GIFT_BAG, STRENGTH_GIFT_BAG_PRICE } from "../src/handlers/shop-shortcuts.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Isolated memory-only handlers and database: no listening service or game connection.
let db: DbHandle, templates: Templates, sequence = 0;
const now = new Date("2026-10-17T08:00:00Z");
const registry = new HandlerRegistry(); registerItems(registry);
beforeAll(async () => {
  db = await createDb("pglite:memory"); await migrateDb(db);
  await seedDatabase(db, { only: ["Shop_Goods", "Shop", "ShopGoodsShowList", "Shop_Goods_Box"] });
  templates = await new Templates().load(db.db, 1, "original");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.db.execute(sql`DROP TRIGGER IF EXISTS test_purchase_failure ON player."Sys_Users_Goods"`);
  await db.db.execute(sql`DROP FUNCTION IF EXISTS player.test_purchase_failure()`);
});
afterAll(async () => { await db?.close(); });

async function fixture(money = 1234) {
  const [row] = await db.db.insert(player.Sys_Users_Detail).values({ UserName: `purchase${++sequence}`, NickName: `Purchase${sequence}`,
    Money: money, Gold: 321, Grade: 20, IsFirst: 1 }).returning();
  const sent: GSPacket[] = [];
  const p = new GamePlayer({ send: pkt => sent.push(GSPacket.parse(pkt.encode())), disconnect() {}, remoteAddress: "isolated-test" },
    (await loadPlayerInfo(db.db, row!.UserID))!, defaultMatch(row!.UserID), 1, "test");
  const tpl = Object.assign(new Templates(), templates, { shop: new Map(templates.shop), items: new Map(templates.items), showList: new Set(templates.showList) });
  tpl.findItem = id => tpl.items.get(id);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = { db, templates: tpl, now: () => now, log, lang: { t: (key: string) => key } } as unknown as ServerContext;
  const run = async (code: number, fill: (pkt: GSPacket) => void) => {
    const pkt = new GSPacket(code, 999999); fill(pkt); pkt.offset = 20;
    await registry.get(code)!.handle(ctx, { player: p } as GameClient, pkt);
  };
  const add = (id: number, place: number, bag = p.storeBag) => {
    const item = ItemInfo.createFromTemplate(tpl.findItem(id)!, 1, 0, now);
    expect(bag.addItemTo(item, place)).toBe(true); return item;
  };
  const messages = () => sent.filter(pkt => pkt.code === 3).map(pkt => { pkt.offset = 20; pkt.readInt(); return pkt.readString(); });
  const stored = () => loadUserItems(db.db, p.id, tpl.findItem);
  return { p, ctx, tpl, log, sent, run, add, messages, stored };
}
const gift = (f: Awaited<ReturnType<typeof fixture>>) => f.run(46, pkt => pkt.writeInt(STRENGTH_GIFT_BAG));
const cart = (f: Awaited<ReturnType<typeof fixture>>, ids: number[]) => f.run(44, pkt => {
  pkt.writeInt(ids.length);
  for (const id of ids) { pkt.writeInt(id); pkt.writeInt(1); pkt.writeString(""); pkt.writeBoolean(false); pkt.writeString(""); pkt.writeInt(0); }
});

describe("existing coupon purchase entries", () => {
  it("registers the actual client shortcut packet numbers", () => {
    expect(registry.get(46)?.name).toBe("BUY_GIFTBAG");
    expect(registry.get(126)?.name).toBe("BUY_QUICK_GOLDBOX");
    expect(registry.get(57)?.name).toBe("GOODS_PRESENT");
    const zh = JSON.parse(readFileSync(new URL("../../../research/i18n/zh-CN-overrides.json", import.meta.url), "utf8"));
    expect(zh["store.view.strength.buyGift"]).toContain(String(STRENGTH_GIFT_BAG_PRICE));
  });

  it("1234 coupons buys the quoted 998 bundle, fills the original five slots and persists the balance", async () => {
    const f = await fixture(); await gift(f);
    expect(f.p.info.Money).toBe(236);
    expect(f.p.info.Gold).toBe(321);
    expect((await loadPlayerInfo(db.db, f.p.id))!.Money).toBe(236);
    const expected = [11023, 11023, 11023, 11020, 11018];
    expect(f.p.storeBag.getItems().map(item => item.TemplateID)).toEqual(expected);
    for (const item of f.p.storeBag.getItems()) expect(item).toMatchObject({ Count: 1, ValidDate: 0, IsBinds: true, BagType: 12 });
    expect((await f.stored()).get(12)?.map(item => item.TemplateID)).toEqual(expected);
    expect(f.messages()).toContain("强化礼包购买成功，已扣除998点券，材料已放入强化槽。");
    expect(f.log.info).toHaveBeenCalledWith("purchase completed", { code: 46, playerId: f.p.id, money: 998 });
  });

  it("returns old materials and preserves the equipped workbench item in slot 5", async () => {
    const f = await fixture(); const old = f.add(11001, 0), weapon = f.add(7001, 5);
    await f.p.saveIntoDatabase(db.db); await gift(f);
    expect(f.p.storeBag.getItemAt(5)).toBe(weapon);
    expect(f.p.propBag.getItems()).toContain(old);
    const stored = await f.stored();
    expect(stored.get(12)?.find(item => item.Place === 5)?.ItemID).toBe(weapon.ItemID);
    expect(stored.get(1)?.some(item => item.ItemID === old.ItemID)).toBe(true);
  });

  it("returns materials through mail when the bag is full", async () => {
    const f = await fixture(); f.p.propBag.capacity = 1;
    f.add(11001, 0, f.p.propBag); const old = f.add(11005, 0);
    await f.p.saveIntoDatabase(db.db); await gift(f);
    const mail = await db.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, f.p.id));
    expect(mail).toHaveLength(1); expect(mail[0]!.Annex1).toBe(String(old.ItemID));
    expect(f.p.storeBag.getItems()).toHaveLength(5); expect(f.p.info.Money).toBe(236);
  });

  it("rejects insufficient coupons with a visible message and no debit", async () => {
    const f = await fixture(997); await gift(f);
    expect(f.p.info.Money).toBe(997); expect(f.p.storeBag.getItems()).toEqual([]);
    expect(f.messages().join()).toContain("点券不足"); expect(f.log.warn).toHaveBeenCalled();
  });

  it("does not charge when bundle configuration or database delivery fails", async () => {
    const absent = await fixture(); absent.tpl.items.delete(11023); await gift(absent);
    expect(absent.p.info.Money).toBe(1234); expect(absent.messages().join()).toContain("配置暂不可用");
    const f = await fixture();
    await db.db.execute(sql`CREATE FUNCTION player.test_purchase_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected purchase failure'; END; $$`);
    await db.db.execute(sql`CREATE TRIGGER test_purchase_failure BEFORE INSERT ON player."Sys_Users_Goods" FOR EACH ROW EXECUTE FUNCTION player.test_purchase_failure()`);
    await gift(f);
    expect(f.p.info.Money).toBe(1234); expect((await loadPlayerInfo(db.db, f.p.id))!.Money).toBe(1234);
    expect(f.p.storeBag.getItems()).toEqual([]); expect(f.messages().join()).toContain("保存失败");
  });

  it("rejects a locked bag or a forged bundle id with an explicit response", async () => {
    const locked = await fixture(); locked.p.info.HasBagPassword = true; locked.p.info.IsLocked = true; await gift(locked);
    expect(locked.p.info.Money).toBe(1234); expect(locked.messages().join()).toContain("解锁背包");
    const forged = await fixture(); await forged.run(46, pkt => pkt.writeInt(7001));
    expect(forged.p.info.Money).toBe(1234); expect(forged.messages().join()).toContain("请求无效");
  });

  it.each([false, true])("gold-box shortcut accepts current or donor payload (trailing bool %s)", async trailer => {
    const f = await fixture(); await f.run(126, pkt => { pkt.writeInt(2); if (trailer) pkt.writeBoolean(false); });
    expect(f.p.info.Money).toBe(1134); expect(f.p.info.Gold).toBe(20321);
    expect((await loadPlayerInfo(db.db, f.p.id))!.Gold).toBe(20321);
    expect(f.messages().join()).toContain("获得20000金币");
  });

  it("ordinary shop and smith single-material purchases still charge and deliver through 44", async () => {
    const f = await fixture();
    const goods = [...f.tpl.shop.values()].find(row => row.TemplateID === 11018 && row.ShopID === 1 && f.tpl.isOnShop(row.ID) && row.APrice1 === -1)!;
    expect(goods).toBeDefined();
    await cart(f, [goods.ID]);
    expect(f.p.info.Money).toBe(1234 - goods.AValue1 * goods.Beat);
    expect(f.p.propBag.getItems().some(item => item.TemplateID === 11018)).toBe(true);
    expect(f.sent.some(pkt => pkt.code === 44)).toBe(true);
  });

  it("a missing shop line no longer silently disappears or partially purchases the cart", async () => {
    const f = await fixture(); await cart(f, [1123301, -9999]);
    expect(f.p.info.Money).toBe(1234); expect(f.p.propBag.getItems()).toEqual([]);
    expect(f.messages().join()).toContain("商品已下架"); expect(f.log.warn).toHaveBeenCalled();
  });

  it("shop gifting preserves the original disabled rule but no longer silently drops packet 57", async () => {
    const f = await fixture();
    await f.run(57, pkt => {
      pkt.writeString("recipient"); pkt.writeString("gift note"); pkt.writeInt(1);
      pkt.writeInt(1123301); pkt.writeInt(1); pkt.writeString(""); pkt.writeString("");
    });
    expect(f.p.info.Money).toBe(1234); expect((await loadPlayerInfo(db.db, f.p.id))!.Money).toBe(1234);
    expect(f.p.propBag.getItems()).toEqual([]);
    expect(await db.db.select().from(player.User_Messages).where(eq(player.User_Messages.SenderID, f.p.id))).toEqual([]);
    expect(f.messages()).toContain("商城赠送功能暂未开放，未扣除点券。");
    expect(f.log.warn).toHaveBeenCalledWith("purchase rejected", { code: 57, playerId: f.p.id, reason: "shop_gifting_disabled" });
  });
});
