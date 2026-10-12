import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { createDb, migrateDb, seedDatabase, game, player, type Database, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { exchangeActivity, parseExchangeRequest } from "../src/game/activity-exchange.js";
import { GamePlayer } from "../src/game/player.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { defaultMatch } from "../src/game/player-info.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { Templates, toShopItem } from "../src/db/templates.js";
import { buyGoods } from "../src/handlers/items.js";
import { hasClaim } from "../src/game/events.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { eventsRuntime, registerEvents, weeklyReset } from "../src/handlers/events.js";
import type { ActiveWindow } from "../src/game/scheduler.js";
import { quitPlayer } from "../src/session/login.js";
import type { GameClient } from "../src/session/client.js";
import { World, type ServerContext } from "../src/session/context.js";
import { RoomMgr } from "../src/rooms/room-mgr.js";
import { StubFightEngine } from "../src/fight/stub.js";
import { takeCardDrop } from "../src/server.js";

// This file always creates a migrated, seeded in-memory database. No running
// server, runtime credentials, network ports or live DB are involved.
let h: DbHandle;
let templates: Map<number, ItemTemplate>;
let seq = 0;
const G = player.Sys_Users_Goods;
const NOW = new Date("2026-10-13T03:00:00Z");
beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods"] });
  templates = new Map((await h.db.select().from(game.Shop_Goods)).map((t) => [t.TemplateID, t]));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.db.execute(sql`DROP TRIGGER IF EXISTS test_exchange_goods_failure ON player."Sys_Users_Goods"`);
  await h.db.execute(sql`DROP TRIGGER IF EXISTS test_exchange_mail_failure ON player."User_Messages"`);
  await h.db.execute(sql`DROP TRIGGER IF EXISTS test_exchange_claim_failure ON app."EventClaims"`);
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_exchange_failure()`);
});
afterAll(async () => { await h.close(); });

function packet(activeId: number, selections = [[11001, 0, 1]], trailer = false) {
  const pkt = new GSPacket(31, 2147483647); // Header cannot choose the owner.
  pkt.writeInt(activeId); pkt.writeInt(selections.length);
  for (const row of selections) for (const n of row) pkt.writeInt(n);
  if (trailer) pkt.writeByte(0);
  pkt.offset = 20;
  return pkt;
}

async function fixture(count = 5, bound = false) {
  const activeId = 700000 + ++seq;
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `exchange${seq}`, NickName: `Exchange${seq}`, Password: "test", IsFirst: 1 }).returning();
  const info = (await loadPlayerInfo(h.db, owner!.UserID))!;
  const sent: GSPacket[] = [];
  const p = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "test" }, info, defaultMatch(info.ID), 1, "test");
  const [row] = await h.db.insert(G).values({ UserID: p.id, BagType: 1, Place: 0, TemplateID: 11001, Count: count, IsBinds: bound }).returning();
  const material = ItemInfo.fromRow(row!, templates.get(11001)!);
  p.propBag.loadItems([material]);
  await h.db.insert(game.Active).values({ ActiveID: activeId, Title: "本地规则兑换", ActiveType: 1, HasKey: 6, IsOnly: 1, IsShow: false,
    StartDate: new Date("2026-10-12T00:00:00Z"), EndDate: new Date("2026-10-18T23:59:59Z"),
    GoodsExchangeTypes: "11", GoodsExchangeNum: "2", limitType: "1", limitValue: "1" });
  const [award] = await h.db.insert(game.Active_Award).values({ ActiveID: activeId, ItemID: 11005, Count: 1 }).returning();
  const [convert] = await h.db.insert(game.Active_Convert_Item).values({ ActiveID: activeId, TemplateID: 11001, ItemType: 0, ItemCount: 2 }).returning();
  const tpl = new Templates(); tpl.items = templates;
  const ctx = { db: h, templates: tpl, lang: { t: (key: string) => key }, now: () => NOW, world: new World(), rooms: { waitingRemove: () => {} }, log: { error: vi.fn(), info: vi.fn() } } as unknown as ServerContext;
  ctx.world.add(p);
  sent.length = 0;
  return { p, ctx, activeId, sent, material, award: award!, convert: convert! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const mails = (f: Fixture) => h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, f.p.id));
const stored = async (f: Fixture) => (await h.db.select().from(G).where(eq(G.ItemID, f.material.ItemID)))[0]!;
const claim = (f: Fixture) => hasClaim(h.db, f.p.id, "exchange", String(f.activeId));
async function unchanged(f: Fixture, before = f.material.toRow()) {
  expect(f.material.toRow()).toEqual(before);
  expect(await claim(f)).toBe(false);
  expect(await mails(f)).toEqual([]);
  expect(f.sent.filter((p) => p.code === 64 || p.code === 117)).toEqual([]);
}
async function rejectWrites(table: "goods" | "claim" | "mail") {
  await h.db.execute(sql`CREATE FUNCTION player.test_exchange_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected exchange failure'; END; $$`);
  const tables = { goods: 'player."Sys_Users_Goods"', claim: 'app."EventClaims"', mail: 'player."User_Messages"' };
  await h.db.execute(sql.raw(`CREATE TRIGGER test_exchange_${table}_failure BEFORE INSERT OR UPDATE ON ${tables[table]}
    FOR EACH ROW EXECUTE FUNCTION player.test_exchange_failure()`));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Hold the real COMMIT result before exchangeActivity can apply it to memory.
 * Holding a PGlite transaction open would also block the boss claim INSERT and
 * accidentally hide this race behind its single DB connection. */
function committedExchangeGate(f: Fixture) {
  const entered = deferred(), release = deferred();
  const gated = new Proxy(h.db, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return async (work: (tx: Database) => Promise<unknown>) => {
      const result = await target.transaction((tx) => work(tx as unknown as Database));
      entered.resolve(); await release.promise; return result;
    };
  } }) as Database;
  return { entered, release, ctx: { ...f.ctx, db: { ...h, db: gated } } };
}

function finishBoss(f: Fixture, items = [{ templateId: 11001, count: 1 }], giftToken = 0) {
  const rt = eventsRuntime(f.ctx);
  const window: ActiveWindow = { key: `exchange-boss-${f.activeId}`, start: NOW, end: NOW,
    ev: { id: f.activeId, kind: "worldboss", title: "test", enabled: true, weekdays: "", startTime: "00:00", durationMin: 1,
      startDate: null, endDate: null, params: { rankAwards: [{ rank: 1, items, giftToken }] } } };
  rt.boss.rank.set(f.p.id, { nick: f.p.info.NickName ?? "", damage: 100, honor: 0 });
  rt.boss.window = window;
  return { end: () => rt.onEnd(window), key: window.key };
}

const nextEventTurns = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

function roomsFor(f: Fixture) {
  f.p.equipBag.addItemTo(ItemInfo.createFromTemplate(templates.get(7001)!, 1, 101), 6);
  const rooms = new RoomMgr({ maxRooms: 2, fight: new StubFightEngine(() => 1001), lang: (key) => key, random: () => 0 });
  f.ctx.rooms = rooms;
  return rooms;
}

function weeklyBulkGate(f: Fixture) {
  const entered = deferred(), release = deferred();
  let held = false;
  const gated = new Proxy(h.db, { get(target, key, receiver) {
    if (key !== "update") return Reflect.get(target, key, receiver);
    return (table: typeof player.Sys_Users_Detail) => {
      if (table !== player.Sys_Users_Detail || held) return target.update(table);
      return { set: (values: typeof player.Sys_Users_Detail.$inferInsert) => ({ where: (condition: SQL | undefined) => {
        held = true;
        const query = target.update(table).set(values).where(condition);
        entered.resolve(); return release.promise.then(() => query);
      } }) };
    };
  } }) as Database;
  return { entered, release, ctx: { ...f.ctx, db: { ...h, db: gated } } };
}

describe("local-v1 packet 31 material exchange", () => {
  it.each([false, true])("accepts bound=%s, mails a bound reward and persists after save/reload", async (bound) => {
    const f = await fixture(5, bound), registry = new HandlerRegistry();
    registerEvents(registry);
    await registry.get(31)!.handle(f.ctx, { player: f.p } as GameClient, packet(f.activeId));
    expect(f.material.Count).toBe(3);
    expect(f.material.isDirty).toBe(false);
    expect((await stored(f)).Count).toBe(3);
    expect(await claim(f)).toBe(true);
    const [mail] = await mails(f);
    expect(mail).toMatchObject({ ReceiverID: f.p.id, Gold: 0, Money: 0, GiftToken: 0 });
    const [reward] = await h.db.select().from(G).where(eq(G.ItemID, Number(mail!.Annex1)));
    expect(reward).toMatchObject({ UserID: 0, BagType: -1, Place: -1, TemplateID: 11005, Count: 1, IsBinds: true });
    expect(f.sent.filter((p) => p.code === 64 || p.code === 117).map((p) => p.code)).toEqual([64, 117]);
    expect(f.sent.some((p) => p.code === 31)).toBe(false);
    await f.p.saveIntoDatabase(h.db);
    const loaded = await loadUserItems(h.db, f.p.id, (id) => templates.get(id));
    expect(loaded.get(1)![0]!.Count).toBe(3);
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false);
    expect(await mails(f)).toHaveLength(1);
    expect((await stored(f)).Count).toBe(3);
  });

  it("clears a fully consumed slot only after commit; save/quit cannot resurrect it", async () => {
    const f = await fixture(2);
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(true);
    expect(f.p.propBag.getItemAt(0)).toBeNull();
    expect(f.p.propBag.removed).toEqual([]);
    expect(await stored(f)).toMatchObject({ Count: 0, IsExist: false, BagType: -1, Place: -1 });
    await quitPlayer(f.ctx, f.p);
    expect(f.ctx.log.error).not.toHaveBeenCalled();
    expect(f.ctx.world.get(f.p.id)).toBeUndefined();
    expect((await loadUserItems(h.db, f.p.id, (id) => templates.get(id))).get(1)).toBeUndefined();
  });

  it("replays concurrently only once and isolates another role", async () => {
    const f = await fixture(), other = await fixture();
    const results = await Promise.all(Array.from({ length: 6 }, () => exchangeActivity(f.ctx, f.p, packet(f.activeId))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await mails(f)).toHaveLength(1);
    expect((await stored(f)).Count).toBe(3);
    expect((await stored(other)).Count).toBe(5);
    expect(await exchangeActivity(other.ctx, other.p, packet(f.activeId))).toBe(true);
    expect(await hasClaim(h.db, other.p.id, "exchange", String(f.activeId))).toBe(true);
  });

  it("uses configured quantities for two distinct material slots in one transaction", async () => {
    const f = await fixture();
    await h.db.update(game.Active).set({ GoodsExchangeTypes: "11,11", GoodsExchangeNum: "2,3", limitType: "1,0", limitValue: "1,0" }).where(eq(game.Active.ActiveID, f.activeId));
    await h.db.insert(game.Active_Convert_Item).values({ ActiveID: f.activeId, TemplateID: 11001, ItemType: 1, ItemCount: 3 });
    const [row] = await h.db.insert(G).values({ UserID: f.p.id, BagType: 1, Place: 1, TemplateID: 11001, Count: 3 }).returning();
    const second = ItemInfo.fromRow(row!, f.material.template);
    f.p.propBag.loadItems([second]); f.sent.length = 0;
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId, [[11001, 0, 1], [11001, 1, 1]]))).toBe(true);
    expect((await stored(f)).Count).toBe(3);
    expect(f.p.propBag.getItemAt(1)).toBeNull();
    expect((await h.db.select().from(G).where(eq(G.ItemID, second.ItemID)))[0]!.IsExist).toBe(false);
    expect(await mails(f)).toHaveLength(1);
    expect(f.sent.filter((pkt) => pkt.code === 64)).toHaveLength(1);
  });

  it("delivers to mail when the original bag remains full", async () => {
    const f = await fixture();
    for (let place = 1; place < f.p.propBag.capacity; place++) {
      f.p.propBag.addItemTo(ItemInfo.createFromTemplate(templates.get(11005)!, 1, 0, NOW), place);
    }
    f.sent.length = 0;
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(true);
    expect(f.p.propBag.findFirstEmptySlot()).toBe(-1);
    expect(await mails(f)).toHaveLength(1);
    expect(f.p.propBag.getItems()).toHaveLength(f.p.propBag.capacity);
  });

  it.each([
    ["missing body", []], ["truncated header", [1]], ["zero slots", [1, 0]], ["negative slots", [1, -1]],
    ["too many slots", [1, 9]], ["truncated triple", [1, 1, 11001, 0]],
    ["extra triple", [1, 1, 11001, 0, 1, 11001, 1, 1]], ["nonpositive template", [1, 1, 0, 0, 1]],
    ["unsupported bag", [1, 1, 11001, 0, 51]], ["equipped place", [1, 1, 11001, 6, 0]],
    ["negative place", [1, 1, 11001, -1, 1]], ["out of range place", [1, 1, 11001, 96, 1]],
    ["duplicate place", [1, 2, 11001, 0, 1, 11001, 0, 1]],
  ] as const)("rejects strict packet shape: %s", (_label, values) => {
    const p = new GSPacket(31); values.forEach((n) => p.writeInt(n)); p.offset = 20;
    expect(() => parseExchangeRequest(p)).toThrow();
  });

  it("rejects trailing bytes, mismatched slot count and template spoofing without writes", async () => {
    const f = await fixture();
    for (const pkt of [packet(f.activeId, undefined, true), packet(f.activeId, [[11001, 0, 1], [11001, 1, 1]]), packet(f.activeId, [[11005, 0, 1]])]) {
      expect(await exchangeActivity(f.ctx, f.p, pkt)).toBe(false);
      await unchanged(f);
    }
  });

  it.each(["count", "cellLocked", "expired", "bagLocked", "room", "owner", "stale", "whitelist"])("rejects invalid material/player: %s", async (kind) => {
    const f = await fixture();
    if (kind === "count") f.material.Count = 1;
    if (kind === "cellLocked") f.material.cellLocked = true;
    if (kind === "expired") { f.material.IsUsed = true; f.material.ValidDate = 1; f.material.BeginDate = new Date("2026-10-01"); }
    if (kind === "bagLocked") { f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; }
    if (kind === "room") f.p.currentRoom = {} as GamePlayer["currentRoom"];
    if (kind === "owner") await h.db.update(G).set({ UserID: f.p.id + 9999 }).where(eq(G.ItemID, f.material.ItemID));
    if (kind === "stale") await h.db.update(G).set({ Count: 4 }).where(eq(G.ItemID, f.material.ItemID));
    if (kind === "whitelist") await h.db.update(game.Active_Convert_Item).set({ TemplateID: 11005 }).where(eq(game.Active_Convert_Item.ID, f.convert.ID));
    const before = f.material.toRow();
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false);
    await unchanged(f, before);
  });

  it.each([
    { ActiveType: 0 }, { HasKey: 3 }, { IsOnly: 0 }, { IsShow: true }, { IsAdvance: true }, { Type: 1 }, { CanCreateCode: true },
    { EndDate: null }, { EndDate: new Date("2026-10-12") }, { StartDate: new Date("2026-10-14") },
    { GoodsExchangeTypes: "11,11" }, { GoodsExchangeNum: "0" }, { GoodsExchangeNum: "2x" }, { limitType: "2" }, { limitValue: "99999" },
  ])("fails closed on unsupported activity config %j", async (patch) => {
    const f = await fixture();
    await h.db.update(game.Active).set(patch).where(eq(game.Active.ActiveID, f.activeId));
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false);
    await unchanged(f);
  });

  it.each([{ ItemType: 1 }, { ItemCount: 1 }, { LimitValue: 0 }, { IsBind: false }, { ValidDate: 1 }])("rejects noncanonical local-v1 whitelist markers %j", async (patch) => {
    const f = await fixture();
    await h.db.update(game.Active_Convert_Item).set(patch).where(eq(game.Active_Convert_Item.ID, f.convert.ID));
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false);
    await unchanged(f);
  });

  it.each([{ Gold: 1 }, { Money: 1 }, { Sex: 1 }, { Mark: 1 }, { StrengthenLevel: 1 }, { AttackCompose: 1 }, { DefendCompose: 1 }, { LuckCompose: 1 }, { AgilityCompose: 1 }, { Count: 0 }, { ItemID: 7001 }])("rejects unsupported reward %j", async (patch) => {
    const f = await fixture();
    await h.db.update(game.Active_Award).set(patch).where(eq(game.Active_Award.ID, f.award.ID));
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false);
    await unchanged(f);
  });

  it("rejects an absent whitelist, repeated whitelist entry, and duplicate actual material ID", async () => {
    const f = await fixture();
    await h.db.delete(game.Active_Convert_Item).where(eq(game.Active_Convert_Item.ID, f.convert.ID));
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false);
    await h.db.insert(game.Active_Convert_Item).values([f.convert, { ...f.convert, ID: f.convert.ID + 1000000 }]);
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false);
    await h.db.update(game.Active_Convert_Item).set({ ItemType: 1 }).where(eq(game.Active_Convert_Item.ID, f.convert.ID + 1000000));
    await h.db.update(game.Active).set({ GoodsExchangeTypes: "11,11", GoodsExchangeNum: "2,2", limitType: "1,1", limitValue: "1,1" }).where(eq(game.Active.ActiveID, f.activeId));
    const alias = ItemInfo.fromRow({ ...f.material.toRow(), ItemID: f.material.ItemID }, f.material.template);
    f.p.propBag.addItemTo(alias, 1);
    f.sent.length = 0;
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId, [[11001, 0, 1], [11001, 1, 1]]))).toBe(false);
    await unchanged(f);
  });

  it.each(["goods", "claim", "mail"] as const)("rolls back %s failure, preserves dirty/removed state, and permits safe retry", async (table) => {
    const f = await fixture();
    f.material.Count = 7; f.material.isDirty = true; // Legitimate online unsaved increment.
    f.p.bankBag.removed.push(f.material); // A pending move reference must survive failure.
    const before = f.material.toRow(), dbBefore = await stored(f);
    const idsBefore = await h.db.select({ id: G.ItemID }).from(G).orderBy(G.ItemID);
    await rejectWrites(table);
    await expect(exchangeActivity(f.ctx, f.p, packet(f.activeId))).rejects.toMatchObject({ cause: { message: "injected exchange failure" } });
    await unchanged(f, before);
    expect(f.material.isDirty).toBe(true);
    expect(f.p.bankBag.removed).toEqual([f.material]);
    expect(await stored(f)).toEqual(dbBefore);
    expect(await h.db.select({ id: G.ItemID }).from(G).orderBy(G.ItemID)).toEqual(idsBefore); // No orphan reward item.
    const tables = { goods: 'player."Sys_Users_Goods"', claim: 'app."EventClaims"', mail: 'player."User_Messages"' };
    await h.db.execute(sql.raw(`DROP TRIGGER test_exchange_${table}_failure ON ${tables[table]}`));
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(true);
    expect((await stored(f)).Count).toBe(5);
    expect(f.p.bankBag.removed).toEqual([]);
    await f.p.saveIntoDatabase(h.db);
    expect((await stored(f)).Count).toBe(5);
  });

  it("does not allocate a real online ItemID before commit for an unsaved stack", async () => {
    const f = await fixture();
    f.p.propBag.takeOutItem(f.material);
    const unsaved = ItemInfo.createFromTemplate(templates.get(11001)!, 4, 0, NOW);
    f.p.propBag.addItemTo(unsaved, 0);
    f.sent.length = 0;
    await rejectWrites("mail");
    await expect(exchangeActivity(f.ctx, f.p, packet(f.activeId))).rejects.toThrow();
    expect(unsaved).toMatchObject({ ItemID: 0, Count: 4, isDirty: true });
    expect(await claim(f)).toBe(false);
    expect(f.p.propBag.removed).toEqual([f.material]);
    await h.db.execute(sql`DROP TRIGGER test_exchange_mail_failure ON player."User_Messages"`);
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(true);
    expect(unsaved.ItemID).toBeGreaterThan(0);
    expect(unsaved.Count).toBe(2);
    await f.p.saveIntoDatabase(h.db);
    expect((await h.db.select().from(G).where(eq(G.ItemID, unsaved.ItemID)))[0]!.Count).toBe(2);
  });

  it.each(["merge", "split"])("atomically persists pending %s source changes, including rollback", async (mode) => {
    const f = await fixture(6);
    let source: ItemInfo;
    if (mode === "merge") {
      const [row] = await h.db.insert(G).values({ UserID: f.p.id, BagType: 1, Place: 1, TemplateID: 11001, Count: 2 }).returning();
      source = ItemInfo.fromRow(row!, f.material.template);
      f.p.propBag.loadItems([source]);
      expect(f.p.propBag.moveItem(1, 0, 0)).toBe(true);
      expect(source.IsExist).toBe(false);
      expect(f.material.Count).toBe(8);
    } else {
      source = f.material;
      expect(f.p.propBag.moveItem(0, 1, 3)).toBe(true);
      expect(source.Count).toBe(3);
    }
    const slot = mode === "merge" ? 0 : 1, before = source.toRow();
    f.sent.length = 0;
    await rejectWrites("mail");
    await expect(exchangeActivity(f.ctx, f.p, packet(f.activeId, [[11001, slot, 1]]))).rejects.toThrow();
    expect(source.toRow()).toEqual(before);
    expect(source.isDirty).toBe(true);
    expect((await h.db.select().from(G).where(eq(G.ItemID, source.ItemID)))[0]).toMatchObject(mode === "merge" ? { IsExist: true, Count: 2 } : { Count: 6 });
    expect(await claim(f)).toBe(false);
    expect(await mails(f)).toHaveLength(0);
    await h.db.execute(sql`DROP TRIGGER test_exchange_mail_failure ON player."User_Messages"`);
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId, [[11001, slot, 1]]))).toBe(true);
    const loaded = await loadUserItems(h.db, f.p.id, (id) => templates.get(id));
    expect(loaded.get(1)!.reduce((n, item) => n + item.Count, 0)).toBe(mode === "merge" ? 6 : 4);
    expect(source.isDirty).toBe(false);
    expect(f.p.propBag.removed).toHaveLength(0);
  });

  it("persists an actual pending shop payment with the exchange and rolls both back on failure", async () => {
    const f = await fixture(2, true);
    f.p.info.Gold = 100;
    await f.p.saveIntoDatabase(h.db);
    const [row] = await h.db.insert(game.Shop).values({ ID: 900000 + seq, ShopID: 1, TemplateID: 11001,
      BuyType: 1, AUnit: 2, APrice1: -2, AValue1: 10, IsContinue: false, IsCheap: false }).returning();
    const shop = toShopItem(row!);
    f.ctx.templates.shop.set(shop.ID, shop); f.ctx.templates.showList.add(shop.ID);
    const buy = new GSPacket(44);
    buy.writeInt(1); buy.writeInt(shop.ID); buy.writeInt(1); buy.writeString(""); buy.writeBoolean(false); buy.writeString(""); buy.writeInt(0); buy.offset = 20;
    await buyGoods(f.ctx, f.p, buy);
    expect(f.p.info.Gold).toBe(90);
    expect(f.material.Count).toBe(4);
    expect(f.material.isDirty).toBe(true);
    f.sent.length = 0;
    const infoBefore = structuredClone(f.p.info);
    await rejectWrites("mail");
    await expect(exchangeActivity(f.ctx, f.p, packet(f.activeId))).rejects.toThrow();
    expect(f.p.info).toEqual(infoBefore);
    expect(f.material).toMatchObject({ Count: 4, isDirty: true });
    expect((await stored(f)).Count).toBe(2);
    expect((await h.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, f.p.id)))[0]!.Gold).toBe(100);
    expect(await claim(f)).toBe(false);
    expect(await mails(f)).toHaveLength(0);
    await h.db.execute(sql`DROP TRIGGER test_exchange_mail_failure ON player."User_Messages"`);
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(true);
    expect((await stored(f)).Count).toBe(2);
    expect((await h.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, f.p.id)))[0]!.Gold).toBe(90);
    expect(f.p.info.Gold).toBe(90);
    expect(await mails(f)).toHaveLength(1);
  });

  it("waits for an autosave already holding an old item snapshot before exchanging", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    f.material.Count = 6; f.material.isDirty = true;
    const gated = new Proxy(h.db, { get(target, key, receiver) {
      if (key !== "update") return Reflect.get(target, key, receiver);
      return (table: typeof G) => {
        if (table !== G) return target.update(table);
        return { set: (values: typeof G.$inferInsert) => ({ where: (condition: SQL) => {
          const query = target.update(table).set(values).where(condition);
          entered.resolve();
          return release.promise.then(() => query);
        } }) };
      };
    } }) as Database;
    const saving = f.p.saveIntoDatabase(gated);
    await entered.promise;
    const exchanging = exchangeActivity(f.ctx, f.p, packet(f.activeId));
    await Promise.resolve();
    expect(await claim(f)).toBe(false);
    expect(f.material.Count).toBe(6);
    release.resolve();
    await saving;
    expect(await exchanging).toBe(true);
    expect((await stored(f)).Count).toBe(4);
    expect(f.material.isDirty).toBe(false);
  });

  it("preserves the real scheduled boss reward across COMMIT return, save and exchange replay", async () => {
    const f = await fixture(5, true), gate = committedExchangeGate(f), boss = finishBoss(f);
    const exchanging = exchangeActivity(gate.ctx, f.p, packet(f.activeId));
    await gate.entered.promise;
    expect((await stored(f)).Count).toBe(3); // COMMIT is real; online apply is still paused.
    expect(f.material.Count).toBe(5);
    let rewarded = false;
    const ending = boss.end().then(() => { rewarded = true; });
    try {
      await nextEventTurns();
      expect(rewarded).toBe(false);
      expect(f.material.Count).toBe(5);
    } finally { gate.release.resolve(); await Promise.all([exchanging, ending]); }
    expect(f.material).toMatchObject({ Count: 4, isDirty: false }); // The ranked award now commits its item atomically.
    expect((await stored(f)).Count).toBe(4);
    await f.p.saveIntoDatabase(h.db);
    expect((await stored(f)).Count).toBe(4);
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false);
    await boss.end(); // Both claims remain once-only.
    expect(f.material.Count).toBe(4);
    expect((await stored(f)).Count).toBe(4);
    expect(await mails(f)).toHaveLength(1);
    expect(await hasClaim(h.db, f.p.id, "worldboss", boss.key)).toBe(true);
  });

  it("saves a queued boss item before a later actual quit without deadlocking", async () => {
    const f = await fixture(5, true), gate = committedExchangeGate(f), boss = finishBoss(f);
    const exchanging = exchangeActivity(gate.ctx, f.p, packet(f.activeId));
    await gate.entered.promise;
    const ending = boss.end();
    const quitting = quitPlayer(f.ctx, f.p);
    gate.release.resolve();
    expect(await exchanging).toBe(true);
    await Promise.all([ending, quitting]);
    expect(f.ctx.log.error).not.toHaveBeenCalled();
    expect(f.ctx.world.get(f.p.id)).toBeUndefined();
    expect(f.material.Count).toBe(4);
    expect((await stored(f)).Count).toBe(4);
    expect(await mails(f)).toHaveLength(1);
  });

  it("waits outside the player lock when quit started before scheduled boss settlement", async () => {
    const f = await fixture(5, true), gate = committedExchangeGate(f), boss = finishBoss(f, [], 7);
    const initialGiftToken = f.p.info.GiftToken;
    const exchanging = exchangeActivity(gate.ctx, f.p, packet(f.activeId));
    await gate.entered.promise;
    const quitting = quitPlayer(f.ctx, f.p);
    const ending = boss.end();
    gate.release.resolve();
    expect(await exchanging).toBe(true);
    await Promise.all([quitting, ending]);
    const reloaded = (await loadPlayerInfo(h.db, f.p.id))!;
    expect(reloaded.GiftToken).toBe(initialGiftToken + 7);
    expect(reloaded.State).toBe(0);
    expect((await stored(f)).Count).toBe(3);
    expect(f.ctx.world.get(f.p.id)).toBeUndefined();
    expect(f.ctx.log.error).not.toHaveBeenCalled();
  });

  it("serializes weekly DB and online counter reset after an exchange COMMIT", async () => {
    const f = await fixture();
    Object.assign(f.p.info, { GP: 77, Offer: 44, LastWeekGP: 2, LastWeekOffer: 3, AddWeekGP: 75, AddWeekOffer: 41, AddWeekLeagueScore: 10 });
    Object.assign(f.p.match, { weeklyScore: 9, weeklyGameCount: 3, WeeklyWinCount: 2 });
    await f.p.saveIntoDatabase(h.db);
    const gate = committedExchangeGate(f);
    const exchanging = exchangeActivity(gate.ctx, f.p, packet(f.activeId));
    await gate.entered.promise;
    let resetDone = false;
    const resetting = weeklyReset(f.ctx, `exchange-week-${f.activeId}`).then((done) => { resetDone = done; });
    try {
      await nextEventTurns();
      expect(resetDone).toBe(false);
      expect(f.p.info.LastWeekGP).toBe(2);
    } finally { gate.release.resolve(); await Promise.all([exchanging, resetting]); }
    const expected = { LastWeekGP: 77, LastWeekOffer: 44, AddWeekGP: 0, AddWeekOffer: 0, AddWeekLeagueScore: 0 };
    const matchExpected = { weeklyScore: 0, weeklyGameCount: 0, WeeklyWinCount: 0 };
    expect(f.p.info).toMatchObject(expected);
    expect(await loadPlayerInfo(h.db, f.p.id)).toMatchObject(expected);
    expect(f.p.match).toMatchObject(matchExpected);
    expect((await h.db.select().from(player.Sys_User_Match_Info).where(eq(player.Sys_User_Match_Info.UserID, f.p.id)))[0]).toMatchObject(matchExpected);
    expect(await weeklyReset(f.ctx, `exchange-week-${f.activeId}`)).toBe(false);
    await f.p.saveIntoDatabase(h.db);
    expect(await loadPlayerInfo(h.db, f.p.id)).toMatchObject(expected);
    expect((await stored(f)).Count).toBe(3);
  });

  it("resets a new online session that joins while the weekly bulk SQL is waiting", async () => {
    const f = await fixture(), newcomer = await fixture(), gate = weeklyBulkGate(f);
    Object.assign(newcomer.p.info, { GP: 99, LastWeekGP: 1, Offer: 22, LastWeekOffer: 2 });
    await newcomer.p.saveIntoDatabase(h.db);
    const resetting = weeklyReset(gate.ctx, `new-online-${f.activeId}`);
    await gate.entered.promise;
    f.ctx.world.add(newcomer.p);
    gate.release.resolve();
    expect(await resetting).toBe(true);
    expect(newcomer.p.info).toMatchObject({ LastWeekGP: 99, LastWeekOffer: 22 });
    await newcomer.p.saveIntoDatabase(h.db);
    expect(await loadPlayerInfo(h.db, newcomer.p.id)).toMatchObject({ LastWeekGP: 99, LastWeekOffer: 22 });
  });

  it("resolves the replacement session after an old weekly participant quits ahead of the lock", async () => {
    const f = await fixture(), gate = weeklyBulkGate(f), releaseSave = deferred();
    Object.assign(f.p.info, { GP: 77, LastWeekGP: 1 });
    await f.p.saveIntoDatabase(h.db);
    const holding = f.p.withPersistenceLock(async () => releaseSave.promise);
    const resetting = weeklyReset(gate.ctx, `relogin-week-${f.activeId}`);
    await gate.entered.promise;
    const quitting = quitPlayer(f.ctx, f.p);
    const replacing = quitting.then(async () => {
      const info = (await loadPlayerInfo(h.db, f.p.id))!;
      const replacement = new GamePlayer(f.p.sink, info, defaultMatch(info.ID), 1, "test");
      replacement.info.GP = 202; // A new session's current unsaved progress must win over the old object.
      expect(f.ctx.world.add(replacement)).toBe(true);
      return replacement;
    });
    gate.release.resolve();
    await nextEventTurns(); // Let weeklyReset queue after the actual quit save.
    releaseSave.resolve();
    const [, , replacement] = await Promise.all([holding, resetting, replacing]);
    expect(f.ctx.world.get(f.p.id)).toBe(replacement);
    expect(replacement.info.LastWeekGP).toBe(202);
    expect(await loadPlayerInfo(h.db, f.p.id)).toMatchObject({ LastWeekGP: 202 });
    await replacement.saveIntoDatabase(h.db);
    expect(await loadPlayerInfo(h.db, f.p.id)).toMatchObject({ GP: 202, LastWeekGP: 202 });
    expect(f.ctx.log.error).not.toHaveBeenCalled();
  });

  it.each(["create", "enter"])("defers actual queued room %s through COMMIT apply before a server card reward", async (kind) => {
    const f = await fixture(5, true), rooms = roomsFor(f);
    if (kind === "enter") {
      const host = await fixture(); roomsFor(host);
      rooms.createRoom(host.p, "host", "", 0, 2); rooms.tick();
      expect(host.p.currentRoom).not.toBeNull();
      rooms.enterRoom(f.p, host.p.currentRoom!.RoomId, "", 0);
    } else rooms.createRoom(f.p, "queued", "", 0, 2);
    const gate = committedExchangeGate(f);
    const exchanging = exchangeActivity(gate.ctx, f.p, packet(f.activeId));
    await gate.entered.promise;
    try {
      rooms.tick();
      expect(f.p.currentRoom).toBeNull();
      expect(f.material.Count).toBe(5);
    } finally { gate.release.resolve(); await exchanging; }
    await f.p.withPersistenceLock(async () => {}); // Wait for the queued entry, without ticking it again.
    expect(f.p.currentRoom).not.toBeNull();
    expect(f.material.Count).toBe(3);
    f.ctx.templates.dropConditions.push({ CondictionType: 1, Para1: ",0,", Para2: ",0,", DropID: 900 } as never);
    f.ctx.templates.dropItems.set(900, [{ ItemId: 11001, Random: 100, BeginData: 1, EndData: 1, IsBind: true, ValueDate: 0 } as never]);
    expect(takeCardDrop(f.ctx.templates, f.p, 0)).toEqual({ templateId: 11001, count: 1 });
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false); // In-room gate still holds.
    f.p.currentRoom!.removePlayer(f.p);
    await f.p.saveIntoDatabase(h.db);
    expect(f.material.Count).toBe(4);
    expect((await stored(f)).Count).toBe(4);
    expect(await exchangeActivity(f.ctx, f.p, packet(f.activeId))).toBe(false); // Replay after leaving.
    expect((await stored(f)).Count).toBe(4);
  });

  it("does not run an already queued room entry after actual quit", async () => {
    const f = await fixture(), rooms = roomsFor(f), gate = committedExchangeGate(f);
    const exchanging = exchangeActivity(gate.ctx, f.p, packet(f.activeId));
    await gate.entered.promise;
    rooms.createRoom(f.p, "quit-queued", "", 0, 2); rooms.tick();
    const quitting = quitPlayer(f.ctx, f.p);
    gate.release.resolve();
    await Promise.all([exchanging, quitting]);
    expect(f.p.currentRoom).toBeNull();
    expect(rooms.usingRooms()).toHaveLength(0);
    expect(f.ctx.world.get(f.p.id)).toBeUndefined();
    expect(f.ctx.log.error).not.toHaveBeenCalled();
    expect((await stored(f)).Count).toBe(3);
  });

  it("keeps idle entry synchronous after failed persistence and catches deferred entry failure once", async () => {
    const f = await fixture(), rooms = roomsFor(f), release = deferred();
    const failure = f.p.withPersistenceLock(async () => { await release.promise; throw new Error("test persistence failure"); });
    const rejected = expect(failure).rejects.toThrow("test persistence failure");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const remove = vi.spyOn(rooms, "waitingRemove").mockImplementationOnce(() => { throw new Error("test room entry failure"); });
    rooms.createRoom(f.p, "deferred-failure", "", 0, 2); rooms.tick();
    release.resolve(); await rejected;
    await f.p.withPersistenceLock(async () => {});
    expect(log).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(f.p.currentRoom).toBeNull();
    rooms.tick();
    expect(remove).toHaveBeenCalledTimes(1); // Failed action is not replayed.
    rooms.createRoom(f.p, "idle", "", 0, 2); rooms.tick();
    expect(f.p.currentRoom).not.toBeNull(); // No Promise turn required on the idle path.
  });

  it("holds explicit save and actual quit until the exchange commit and memory apply", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    const gated = new Proxy(h.db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return (work: (tx: Database) => Promise<unknown>) => target.transaction(async (tx) => {
        const result = await work(tx as unknown as Database);
        entered.resolve(); await release.promise; return result;
      });
    } }) as Database;
    const ctx = { ...f.ctx, db: { ...h, db: gated } };
    const exchanging = exchangeActivity(ctx, f.p, packet(f.activeId));
    await entered.promise;
    let saved = false;
    const saving = f.p.saveIntoDatabase(h.db).then(() => { saved = true; });
    const quitting = quitPlayer(f.ctx, f.p);
    await Promise.resolve(); await Promise.resolve();
    expect(saved).toBe(false);
    expect(f.ctx.world.get(f.p.id)).toBe(f.p);
    expect(f.material.Count).toBe(5);
    expect(f.sent).toEqual([]);
    release.resolve();
    expect(await exchanging).toBe(true);
    await Promise.all([saving, quitting]);
    expect(f.ctx.log.error).not.toHaveBeenCalled();
    expect(f.ctx.world.get(f.p.id)).toBeUndefined();
    expect((await stored(f)).Count).toBe(3);
    expect(await mails(f)).toHaveLength(1);
  });
});
