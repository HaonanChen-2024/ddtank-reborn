import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { Templates } from "../src/db/templates.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { compose, registerForge } from "../src/handlers/forge.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Exact complete seed rows. Independent CRC-checked extraction and source hashes
// are recorded in runtime/treasure-compose-honor-20261016/compose.
const data = JSON.parse(readFileSync(new URL("./fixtures/treasure-compose-goods.json", import.meta.url), "utf8")) as { goods: ItemTemplate[] };
const begin = new Date("2026-10-16T00:00:00Z");
let h: DbHandle, sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await h?.close(); });

async function fixture(stoneId = 11030, count = 3) {
  const templates = new Templates(); templates.items = new Map(data.goods.map(t => [t.TemplateID, t]));
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `cmp${++sequence}`, NickName: `cmp${sequence}`, Grade: 20, IsFirst: 1, Gold: 5000 }).returning();
  const info = (await loadPlayerInfo(h.db, row!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: pkt => sent.push(GSPacket.parse(pkt.encode())), disconnect() {}, remoteAddress: "compose-isolated-memory" }, info, defaultMatch(info.ID), 1, "test");
  p.statTables = templates.stats;
  const add = (templateId: number, slot: number, amount = 3) => { const added = ItemInfo.createFromTemplate(templates.findItem(templateId)!, amount, 0, begin); p.storeBag.addItemTo(added, slot); return added; };
  const item = add(7006, 1, 1); item.IsBinds = false; item.StrengthenLevel = 3; item.Hole1 = 311109;
  const stone = add(stoneId, 2, count); stone.IsBinds = true;
  const save = async () => { await p.saveIntoDatabase(h.db); sent.length = 0; };
  await save();
  const clock = { time: begin.getTime() }, error = vi.fn();
  const ctx = { db: h, templates, now: () => new Date(clock.time), lang: { t: (key: string) => key }, log: { error } } as unknown as ServerContext;
  const packet = (guild = false, length = 1) => { const raw = new GSPacket(58); raw.writeBoolean(guild); if (length !== 1) raw.setBody(new Uint8Array(length)); return GSPacket.parse(raw.encode()); };
  const use = (sample = 0, guild = false, length = 1) => compose(ctx, p, packet(guild, length), () => sample);
  const reply = () => { const out = sent.filter(pkt => pkt.code === 58).at(-1)!; expect(out).toBeDefined(); expect(out.clientId).toBe(p.id); expect(out.length).toBe(21); return out.readByte(); };
  const rows = () => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id));
  const reload = () => loadUserItems(h.db, p.id, templates.findItem, templates.findGoldTemplate);
  const gold = async () => (await loadPlayerInfo(h.db, p.id))!.Gold;
  return { p, templates, item, stone, sent, ctx, clock, error, packet, use, reply, rows, reload, gold, save, add };
}

async function guild(id: number, exists = true) {
  await h.db.insert(player.Consortia).values({ ConsortiaID: id, ConsortiaName: `compose${id}`, Honor: 0, CreatorID: 1, CreatorName: "test", ChairmanID: 1, ChairmanName: "test", Level: 1, MaxCount: 20, CelebCount: 0, BuildDate: begin, IP: "127.0.0.1", Port: 0, IsExist: exists, SmithLevel: 2 });
}

describe("58 actual compose materials and durable result", () => {
  it("persists equipment, source stone and gold before acknowledging a successful real request", async () => {
    const f = await fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    const registry = new HandlerRegistry(); registerForge(registry);
    await registry.get(58)!.handle(f.ctx, { player: f.p } as GameClient, f.packet());
    expect(f.reply()).toBe(0);
    expect((await f.reload()).get(12)!.find(it => it.Place === 1)).toMatchObject({ TemplateID: 7006, AttackCompose: 50, StrengthenLevel: 3, Hole1: 311109, IsBinds: true });
    expect((await f.rows()).find(it => it.ItemID === f.stone.ItemID)!.Count).toBe(2);
    expect(await f.gold()).toBe(3400);
  });

  it("consumes the selected slot 2 rather than an earlier same-template workbench stack", async () => {
    const f = await fixture(), earlier = f.add(11030, 0, 9999); await f.save(); await f.use(0);
    expect(f.reply()).toBe(0); expect(earlier.Count).toBe(9999); expect(f.stone.Count).toBe(2);
    const rows = await f.rows(); expect(rows.find(it => it.ItemID === earlier.ItemID)!.Count).toBe(9999); expect(rows.find(it => it.ItemID === f.stone.ItemID)!.Count).toBe(2);
  });

  it.each([11030, 11031, 11032, 11033].flatMap(id => [true, false].map(success => ({ id, success }))))("uses true stone $id on a successful=$success roll", async ({ id, success }) => {
    const f = await fixture(id), keys = ["AttackCompose", "DefendCompose", "AgilityCompose", "LuckCompose"] as const;
    for (const key of keys) f.item[key] = 17;
    const target = keys[id - 11030]!; f.item[target] = 0; f.p.storeBag.updateItem(f.item); await f.save();
    const hook = vi.fn(); f.p.questInv = { onItemCompose: hook } as unknown as GamePlayer["questInv"];
    await f.use(success ? 0.04 : 0.05);
    expect(f.reply()).toBe(success ? 0 : 1); expect(f.p.info.Gold).toBe(3400); expect(await f.gold()).toBe(3400);
    const loaded = (await f.reload()).get(12)!;
    for (const key of keys) expect(loaded.find(it => it.Place === 1)![key]).toBe(key === target ? (success ? 50 : 0) : 17);
    expect(loaded.find(it => it.Place === 1)).toMatchObject({ IsBinds: true, StrengthenLevel: 3, Hole1: 311109 });
    expect(loaded.find(it => it.Place === 2)!.Count).toBe(2);
    if (success) expect(hook).toHaveBeenCalledExactlyOnceWith(id); else expect(hook).not.toHaveBeenCalled();
  });

  it("uses real luck Property2, consumes one selected unit and preserves a spare luck stack", async () => {
    const plain = await fixture(); await plain.use(0.09); expect(plain.reply()).toBe(1);
    const lucky = await fixture(), luck = lucky.add(11028, 0, 9999), spare = lucky.add(11028, 3, 9999);
    lucky.stone.IsBinds = false; lucky.p.storeBag.updateItem(lucky.stone); luck.IsBinds = true; await lucky.save(); await lucky.use(0.09);
    expect(lucky.reply()).toBe(0); expect(lucky.item.IsBinds).toBe(true); expect(luck.Count).toBe(9998); expect(spare.Count).toBe(9999);
    const rows = await lucky.rows(); expect(rows.find(it => it.ItemID === luck.ItemID)!.Count).toBe(9998); expect(rows.find(it => it.ItemID === spare.ItemID)!.Count).toBe(9999);
  });

  it("gives the original default +1% only to an empty luck slot, with strict integer-roll comparison", async () => {
    const empty = await fixture(11001); empty.stone.IsBinds = false; empty.p.storeBag.updateItem(empty.stone); await empty.save(); await empty.use(0.8); expect(empty.reply()).toBe(0); expect(empty.item.IsBinds).toBe(false);
    const occupied = await fixture(11001), other = occupied.add(11019, 0); occupied.stone.IsBinds = false; occupied.p.storeBag.updateItem(occupied.stone); other.IsBinds = true; await occupied.save(); await occupied.use(0.8);
    expect(occupied.reply()).toBe(1); expect(occupied.item.IsBinds).toBe(false); expect(other.Count).toBe(3); expect((await occupied.reload()).get(12)!.find(it => it.Place === 0)!.Count).toBe(3);
  });

  it.each([0, 77402, 77403])("continues at zero bonus after the original missing-guild notice for ID %i", async id => {
    const f = await fixture(); if (id === 77403) await guild(id, false);
    f.p.info.ConsortiaID = id; f.p.info.SmithLevel = 99; await f.save();
    const notice = vi.spyOn(f.p, "sendMessage"); await f.use(0.05, true);
    expect(notice).toHaveBeenCalledWith(0, "ItemStrengthenHandler.Fail"); expect(f.reply()).toBe(1); expect(await f.gold()).toBe(3400); expect(f.stone.Count).toBe(2);
  });

  it("uses the exact guild threshold and smith multiplier; refuses insufficient contribution before RNG", async () => {
    const denied = await fixture(); denied.p.info.ConsortiaID = 77401; denied.p.info.SmithLevel = 2; denied.p.info.RichesOffer = 99; await denied.save();
    await guild(77401);
    await h.db.insert(player.Consortia_Equip_Control).values({ ConsortiaID: 77401, Type: 2, Level: 0, Riches: 100, IsExist: true });
    const random = vi.fn(() => 0), notice = vi.spyOn(denied.p, "sendMessage"); await compose(denied.ctx, denied.p, denied.packet(true), random);
    expect(notice).toHaveBeenCalledWith(1, "ItemStrengthenHandler.FailbyPermission"); expect(random).not.toHaveBeenCalled(); expect(await denied.gold()).toBe(5000); expect(denied.stone.Count).toBe(3);
    const allowed = await fixture(); allowed.p.info.ConsortiaID = 77401; allowed.p.info.SmithLevel = 2; allowed.p.info.RichesOffer = 60; allowed.p.info.RichesRob = 40; await allowed.save(); await allowed.use(0.05, true);
    expect(allowed.reply()).toBe(0); expect(await allowed.gold()).toBe(3400); expect((await allowed.reload()).get(12)!.find(it => it.Place === 1)!.AttackCompose).toBe(50);
    const boundary = await fixture(); boundary.p.info.ConsortiaID = 77401; boundary.p.info.SmithLevel = 99; boundary.p.info.RichesOffer = 100; await boundary.save(); await boundary.use(0.06, true); expect(boundary.reply()).toBe(1);
  });

  it("persists the last stone and luck tombstones and preserves unrelated workbench equipment", async () => {
    const f = await fixture(11030, 1), luck = f.add(11017, 0, 1), spare = f.add(7006, 6, 1); await f.save(); await f.use(0.99);
    expect(f.reply()).toBe(1); expect(f.p.storeBag.getItemAt(2)).toBeNull(); expect(f.p.storeBag.getItemAt(0)).toBeNull();
    const rows = await f.rows();
    for (const material of [f.stone, luck]) expect(rows.find(it => it.ItemID === material.ItemID)).toMatchObject({ IsExist: false, Count: 1, BagType: -1, Place: -1 });
    expect((await f.reload()).get(12)!.find(it => it.ItemID === spare.ItemID)).toMatchObject({ TemplateID: 7006, Place: 6 });
    expect(await f.gold()).toBe(3400);
  });

  it("keeps every input and RNG untouched when the target attribute is already at its stone ceiling", async () => {
    const f = await fixture(); f.item.AttackCompose = 50; f.p.storeBag.updateItem(f.item); await f.save();
    const before = await f.rows(), random = vi.fn(() => 0), notice = vi.spyOn(f.p, "sendMessage"); await compose(f.ctx, f.p, f.packet(), random);
    expect(notice).toHaveBeenCalledWith(0, "ItemComposeHandler.NoLevel"); expect(random).not.toHaveBeenCalled(); expect(await f.rows()).toEqual(before); expect(await f.gold()).toBe(5000);
  });

  it("uses the configured nonnegative gold price and admits exactly sufficient funds", async () => {
    const f = await fixture(); f.templates.serverConfig.set("PRICE_COMPOSE_GOLD", "2500"); f.p.info.Gold = 2500; await f.save(); await f.use(0.99);
    expect(f.reply()).toBe(1); expect(await f.gold()).toBe(0); expect(f.stone.Count).toBe(2);
  });
});

describe("58 commit failures, guards and publication", () => {
  it("rolls back a real deferred SQL failure including equipment, two last-unit tombstones and gold, then accepts the same body", async () => {
    const f = await fixture(11030, 1), luck = f.add(11028, 0, 1); await f.save();
    const before = await f.rows(), info = await loadPlayerInfo(h.db, f.p.id), live = [f.item.toRow(), f.stone.toRow(), luck.toRow()];
    const hook = vi.fn(); f.p.questInv = { onItemCompose: hook } as unknown as GamePlayer["questInv"];
    await h.db.execute(sql.raw(`CREATE FUNCTION player.compose_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '58 deferred fault'; RETURN NEW; END $$`));
    await h.db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER compose_test_fault AFTER UPDATE ON player."Sys_Users_Detail" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."UserID" = ${f.p.id}) EXECUTE FUNCTION player.compose_test_fault()`));
    try {
      await f.use(0); expect(f.error).toHaveBeenCalled(); expect(await f.rows()).toEqual(before); expect(await loadPlayerInfo(h.db, f.p.id)).toEqual(info);
      expect([f.item.toRow(), f.stone.toRow(), luck.toRow()]).toEqual(live); expect(f.p.info.Gold).toBe(5000); expect(hook).not.toHaveBeenCalled();
      expect(f.sent.filter(pkt => [64, 58, 229].includes(pkt.code))).toHaveLength(0);
    } finally { await h.db.execute(sql.raw(`DROP TRIGGER compose_test_fault ON player."Sys_Users_Detail"`)); await h.db.execute(sql.raw("DROP FUNCTION player.compose_test_fault()")); }
    f.sent.length = 0; await f.use(0); expect(f.reply()).toBe(0); expect(await f.gold()).toBe(3400); expect(hook).toHaveBeenCalledExactlyOnceWith(11030);
    expect((await f.rows()).filter(it => !it.IsExist)).toHaveLength(2); expect((await f.reload()).get(12)!.find(it => it.Place === 1)!.AttackCompose).toBe(50);
  });

  it("blocks autosave and room entry until COMMIT and runs the quest hook only after durable publication", async () => {
    const f = await fixture(), transaction = h.db.transaction.bind(h.db);
    let release!: () => void, staged!: () => void; const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { staged = r; });
    const hook = vi.fn(); f.p.questInv = { onItemCompose: hook, takeDirty: () => [] } as unknown as GamePlayer["questInv"];
    const spy = vi.spyOn(h.db, "transaction").mockImplementationOnce(fn => transaction(async tx => { const result = await fn(tx); staged(); await gate; return result; }));
    const pending = f.use(0); await ready;
    expect(f.item.AttackCompose).toBe(0); expect(f.stone.Count).toBe(3); expect(f.p.info.Gold).toBe(5000); expect(f.sent).toHaveLength(0); expect(hook).not.toHaveBeenCalled();
    let entered = -1; const save = f.p.saveIntoDatabase(h.db), room = f.p.runRoomEntry(() => { entered = f.item.AttackCompose; });
    await Promise.resolve(); expect(entered).toBe(-1); release(); await pending; f.p.questInv = null; await save; await room; spy.mockRestore();
    expect(entered).toBe(50); expect(hook).toHaveBeenCalledExactlyOnceWith(11030); expect(await f.gold()).toBe(3400); expect((await f.reload()).get(12)!.find(it => it.Place === 2)!.Count).toBe(2);
  });

  it("rereads expiry after waiting for the persistence lock without rolling or spending", async () => {
    const f = await fixture(); let release!: () => void;
    const prior = f.p.withPersistenceLock(() => new Promise<void>(r => { release = r; })); await Promise.resolve();
    const random = vi.fn(() => 0), pending = compose(f.ctx, f.p, f.packet(), random);
    f.stone.IsUsed = true; f.stone.ValidDate = 1; f.stone.BeginDate = begin; f.clock.time += 86400000;
    release(); await prior; await pending; expect(random).not.toHaveBeenCalled(); expect(f.stone.Count).toBe(3); expect(await f.gold()).toBe(5000); expect(f.sent.filter(pkt => pkt.code === 58 || pkt.code === 64)).toHaveLength(0);
  });

  it("rechecks expiry after the SQL owner-lock wait", async () => {
    const f = await fixture(), transaction = h.db.transaction.bind(h.db); f.stone.IsUsed = true; f.stone.ValidDate = 1; f.p.storeBag.updateItem(f.stone); await f.save();
    let release!: () => void, entered!: () => void; const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
    const spy = vi.spyOn(h.db, "transaction").mockImplementationOnce(fn => transaction(async tx => { entered(); await gate; return fn(tx); }));
    const random = vi.fn(() => 0), pending = compose(f.ctx, f.p, f.packet(), random); await ready; f.clock.time += 86400000; release(); await pending; spy.mockRestore();
    expect(random).not.toHaveBeenCalled(); expect(await f.gold()).toBe(5000); expect(f.stone.Count).toBe(3);
  });

  it("keeps the committed SQL and live state after transport failure and releases every bag notification batch", async () => {
    const f = await fixture(), send = f.p.sink.send.bind(f.p.sink);
    const hook = vi.fn(); f.p.questInv = { onItemCompose: hook } as unknown as GamePlayer["questInv"];
    const spy = vi.spyOn(f.p.sink, "send").mockImplementation(pkt => { if (pkt.code === 64) throw new Error("58 disconnected"); send(pkt); });
    await expect(f.use(0)).rejects.toThrow("58 disconnected"); spy.mockRestore();
    expect(f.item.AttackCompose).toBe(50); expect(f.stone.Count).toBe(2); expect(f.p.info.Gold).toBe(3400); expect(await f.gold()).toBe(3400); expect(hook).toHaveBeenCalledExactlyOnceWith(11030);
    const loaded = (await f.reload()).get(12)!; expect(loaded.find(it => it.Place === 1)!.AttackCompose).toBe(50); expect(loaded.find(it => it.Place === 2)!.Count).toBe(2);
    f.sent.length = 0; f.p.storeBag.updateItem(f.stone); expect(f.sent.filter(pkt => pkt.code === 64)).toHaveLength(1);
  });

  it("rechecks the active session and playing room after entering the SQL transaction", async () => {
    for (const mutate of [(f: Awaited<ReturnType<typeof fixture>>) => { f.p.isActive = false; }, (f: Awaited<ReturnType<typeof fixture>>) => { f.p.currentRoom = { IsPlaying: true } as GamePlayer["currentRoom"]; }]) {
      const f = await fixture(), transaction = h.db.transaction.bind(h.db), random = vi.fn(() => 0);
      const spy = vi.spyOn(h.db, "transaction").mockImplementationOnce(fn => transaction(async tx => { mutate(f); return fn(tx); }));
      await compose(f.ctx, f.p, f.packet(), random); spy.mockRestore(); expect(random).not.toHaveBeenCalled(); expect(await f.gold()).toBe(5000); expect(f.stone.Count).toBe(3);
    }
  });

  it("rejects malformed packets, insufficient or unsafe prices, locked or invalid cells and session barriers without spending", async () => {
    for (const length of [0, 2, 5]) { const f = await fixture(); await f.use(0, false, length); expect(f.stone.Count).toBe(3); expect(await f.gold()).toBe(5000); expect(f.sent.filter(pkt => pkt.code === 58 || pkt.code === 64)).toHaveLength(0); }
    const mutations: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
      f => { f.item.IsExist = false; }, f => { f.item.cellLocked = true; }, f => { f.stone.cellLocked = true; },
      f => { f.stone.Count = 0; }, f => { f.stone.Place = 4; }, f => { f.item.UserID++; }, f => { f.stone.BagType = 1; },
      f => { f.p.info.Gold = 1599; }, f => { f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; },
      f => { f.p.currentRoom = { IsPlaying: true } as GamePlayer["currentRoom"]; }, f => { f.p.isActive = false; }, f => { f.p.quitting = Promise.resolve(); },
      f => { f.templates.serverConfig.set("PRICE_COMPOSE_GOLD", "-1"); }, f => { f.templates.serverConfig.set("PRICE_COMPOSE_GOLD", "1.5"); },
      f => { f.templates.items.delete(11030); }, f => { const luck = f.add(11028, 0); luck.cellLocked = true; },
    ];
    for (const mutate of mutations) { const f = await fixture(); mutate(f); const before = [f.item.toRow(), f.stone.toRow()], gold = f.p.info.Gold, random = vi.fn(() => 0); f.sent.length = 0; await compose(f.ctx, f.p, f.packet(), random); expect([f.item.toRow(), f.stone.toRow()]).toEqual(before); expect(f.p.info.Gold).toBe(gold); expect(await f.gold()).toBe(5000); expect(random).not.toHaveBeenCalled(); expect(f.sent.filter(pkt => pkt.code === 58 || pkt.code === 64)).toHaveLength(0); }
  });

  it("rejects unsafe random samples without publishing dirty cells, gold or a result packet", async () => {
    for (const sample of [NaN, -0.1, 1, Infinity]) { const f = await fixture(), before = await f.rows(); await f.use(sample); expect(await f.rows()).toEqual(before); expect(f.stone.Count).toBe(3); expect(await f.gold()).toBe(5000); expect(f.sent.filter(pkt => pkt.code === 58 || pkt.code === 64)).toHaveLength(0); }
  });
});
