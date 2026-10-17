import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { Templates, type StrengthenGoodsRow, type StrengthenRow } from "../src/db/templates.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import type { GoldEquipRow } from "../src/game/stats.js";
import { registerForge, strengthen } from "../src/handlers/forge.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";
import { smithEnabledWeapon } from "../../../scripts/workshop-weapon-smith.js";

// Exact complete rows selected from the committed gzip seeds; hashes/independent
// deep-equality audit are in runtime/treasure-forge-materials-20261016. This fixture
// avoids the separately recorded native Node gzip initialization failure.
const data = JSON.parse(readFileSync(new URL("./fixtures/treasure-strengthen-goods.json", import.meta.url), "utf8")) as {
  goods: ItemTemplate[]; strengthen: StrengthenRow[]; strengthenGoods: StrengthenGoodsRow[]; goldEquip: GoldEquipRow[];
};
const begin = new Date("2026-10-16T00:00:00Z");
let h: DbHandle, sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(async () => { await h?.close(); });

async function fixture(id = 7006, level = 0, stoneId = 11019, count = 3) {
  const templates = new Templates();
  templates.items = new Map(data.goods.map(t => [t.TemplateID, t]));
  if ([9107243, 9107258].includes(id)) {
    const stats = id === 9107243 ? { Attack: 78, Defence: 208, Agility: 195, Luck: 39, Property7: 247 }
      : { Attack: 57, Defence: 200, Agility: 100, Luck: 81, Property7: 235 };
    templates.items.set(id, smithEnabledWeapon({ ...templates.findItem(7006)!, ...stats, TemplateID: id,
      Level: 1, CanStrengthen: false, CanCompose: false, CanTransfer: 0, Description: "暂不开放强化、合成与转移。" }));
  }
  templates.strengthen = new Map(data.strengthen.map(r => [r.StrengthenLevel, r]));
  templates.strengthenGoods = [...data.strengthenGoods];
  templates.stats.goldEquip = id => data.goldEquip.find(r => r.OldTemplateId === id);
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `str${++sequence}`, NickName: `str${sequence}`, Grade: 20, IsFirst: 1, Gold: 5000 }).returning();
  const info = (await loadPlayerInfo(h.db, row!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: pkt => sent.push(GSPacket.parse(pkt.encode())), disconnect() {}, remoteAddress: "strengthen-isolated-memory" }, info, defaultMatch(info.ID), 1, "test");
  p.statTables = templates.stats;
  const item = ItemInfo.createFromTemplate(templates.findItem(id)!, 1, 0, begin);
  item.StrengthenLevel = level; item.AttackCompose = 17; item.Hole1 = 311109; item.IsBinds = false;
  const stone = ItemInfo.createFromTemplate(templates.findItem(stoneId)!, count, 0, begin); stone.IsBinds = true;
  p.storeBag.addItemTo(item, 5); p.storeBag.addItemTo(stone, 0);
  await p.saveIntoDatabase(h.db); sent.length = 0;
  const clock = { time: begin.getTime() }, error = vi.fn();
  const ctx = { db: h, templates, now: () => new Date(clock.time), lang: { t: (key: string) => key }, log: { error } } as unknown as ServerContext;
  const packet = (guild = false, length = 1) => { const raw = new GSPacket(59); raw.writeBoolean(guild); if (length !== 1) raw.setBody(new Uint8Array(length)); return GSPacket.parse(raw.encode()); };
  const use = (sample = 0, guild = false, length = 1) => strengthen(ctx, p, packet(guild, length), () => sample);
  const reply = () => { const out = sent.filter(pkt => pkt.code === 59).at(-1)!; expect(out).toBeDefined(); expect(out.clientId).toBe(p.id); expect(out.length).toBe(22); return [out.readByte(), out.readBoolean()]; };
  const rows = () => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id));
  const reload = () => loadUserItems(h.db, p.id, templates.findItem, templates.findGoldTemplate);
  const save = async () => { await p.saveIntoDatabase(h.db); sent.length = 0; };
  const add = (templateId: number, slot: number, amount = 3) => { const added = ItemInfo.createFromTemplate(templates.findItem(templateId)!, amount, 0, begin); p.storeBag.addItemTo(added, slot); return added; };
  return { p, ctx, templates, item, stone, sent, clock, error, packet, use, reply, rows, reload, save, add };
}

describe("59 actual workbench strengthening and durable consumption", () => {
  it.each([9107243, 9107258])("imported weapon %i strengthens, persists, and survives a failed Level 3 roll", async id => {
    const f = await fixture(id); const base = { ...f.item.template };
    await f.use(0);
    expect(f.reply()).toEqual([0, true]);
    expect((await f.reload()).get(12)!.find(it => it.Place === 5)).toMatchObject({ TemplateID: id, StrengthenLevel: 1 });
    f.item.StrengthenLevel = 8; f.p.storeBag.updateItem(f.item); await f.save(); await f.use(0.9999);
    expect(f.reply()).toEqual([1, false]);
    expect((await f.reload()).get(12)!.find(it => it.Place === 5)).toMatchObject({ TemplateID: id, StrengthenLevel: 7, IsExist: true });
    expect(f.item.template).toEqual(base);
  });
  it("commits the actual registry result and material before acknowledging success, without autosave", async () => {
    const f = await fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    const registry = new HandlerRegistry(); registerForge(registry);
    await registry.get(59)!.handle(f.ctx, { player: f.p } as GameClient, f.packet());
    expect(f.reply()).toEqual([0, true]);
    const loaded = (await f.reload()).get(12)!;
    expect(loaded.find(it => it.Place === 5)).toMatchObject({ TemplateID: 7006, StrengthenLevel: 1, StrengthenTimes: 1, AttackCompose: 17, Hole1: 311109, IsBinds: true });
    expect(loaded.find(it => it.Place === 0)!.Count).toBe(2);
    expect((await loadPlayerInfo(h.db, f.p.id))!.Gold).toBe(5000);
  });

  it.each([11019, 11021, 11022, 11023, 11024])("uses the actual A01 stone %i via its true Level", async id => {
    const f = await fixture(7006, 0, id); await f.use(0);
    expect(f.reply()).toEqual([0, true]); expect((await f.reload()).get(12)!.find(it => it.Place === 5)!.StrengthenLevel).toBe(1);
    expect((await f.rows()).find(it => it.TemplateID === id)!.Count).toBe(2);
  });

  it.each([1101, 5101, 17001])("uses the actual category-specific next-level Rock for %i", async id => {
    const f = await fixture(id); await f.use(0); expect(f.reply()).toEqual([0, true]);
    expect((await f.reload()).get(12)!.find(it => it.Place === 5)!.StrengthenLevel).toBe(1);
  });

  it("commits an ordinary failure, binding, counter and exactly one consumed stone", async () => {
    const f = await fixture(7006, 8); await f.use(0.9999);
    expect(f.reply()).toEqual([1, false]);
    const loaded = (await f.reload()).get(12)!;
    expect(loaded.find(it => it.Place === 5)).toMatchObject({ StrengthenLevel: 7, StrengthenTimes: 1, IsBinds: true });
    expect(loaded.find(it => it.Place === 0)!.Count).toBe(2);
    expect(f.p.records.find(r => r.RecordID === 32)).toBeUndefined();
  });

  it("keeps a Level3 item below +5 on a failed roll", async () => {
    const f = await fixture(7006, 4); await f.use(0.9999);
    expect(f.reply()).toEqual([1, false]); expect((await f.reload()).get(12)!.find(it => it.Place === 5)!.StrengthenLevel).toBe(4);
  });

  it("persists destruction of a non-Level3 item on failure", async () => {
    const f = await fixture(1101, 8); await f.use(0.9999);
    expect(f.reply()).toEqual([1, false]); expect((await f.reload()).get(12)!.some(it => it.Place === 5)).toBe(false);
    expect((await f.rows()).find(it => it.ItemID === f.item.ItemID)).toMatchObject({ IsExist: false, Count: 0, RemoveType: 14, Place: -1, BagType: -1 });
  });

  it("consumes and persists the last stone tombstone", async () => {
    const f = await fixture(7006, 0, 11019, 1); await f.use(0);
    expect(f.p.storeBag.getItemAt(0)).toBeNull();
    expect((await f.rows()).find(it => it.ItemID === f.stone.ItemID)).toMatchObject({ IsExist: false, Count: 1, Place: -1, BagType: -1 });
    expect((await f.reload()).get(12)!.some(it => it.TemplateID === 11019)).toBe(false);
  });

  it("keeps the per-used-slot one-unit contract for 9999 stacks, luck and divine protection", async () => {
    const f = await fixture(7006, 8, 11019, 9999);
    const second = f.add(11021, 1, 9999), third = f.add(11022, 2, 9999), god = f.add(11020, 3, 9999), luck = f.add(11028, 4, 9999);
    god.IsBinds = true; await f.save(); await f.use(0.9999);
    expect(f.reply()).toEqual([1, false]); expect(f.item.StrengthenLevel).toBe(8);
    for (const it of [f.stone, second, third, god, luck]) expect(it.Count).toBe(9998);
    const loaded = (await f.reload()).get(12)!; expect(loaded.filter(it => it.Place < 5).map(it => it.Count)).toEqual([9998, 9998, 9998, 9998, 9998]);
  });

  it("preserves the original lucky integer division, VIP 30% and strict roll boundary", async () => {
    const plain = await fixture(7006, 0); await plain.use(0.375); expect(plain.reply()).toEqual([1, false]);
    const vip = await fixture(7006, 0); vip.p.info.typeVIP = 1; await vip.save(); await vip.use(0.375); expect(vip.reply()).toEqual([0, true]);
    const luck = await fixture(7006, 0); luck.add(11017, 4); await luck.save(); await luck.use(0.7); expect(luck.reply()).toEqual([0, true]);
  });

  it("continues with smith=0 after an unqualified guild notice and retains the live warrior override", async () => {
    const denied = await fixture(); denied.p.info.ConsortiaID = 0; await denied.use(0.375, true);
    expect(denied.reply()).toEqual([1, false]); expect(denied.sent.some(pkt => pkt.code === 3)).toBe(true);
    const warrior = await fixture(7006, 11, 11024); warrior.p.extra = { coupleBossBoxNum: 9 } as GamePlayer["extra"];
    const random = vi.fn(() => { throw new Error("warrior should not roll"); });
    await strengthen(warrior.ctx, warrior.p, warrior.packet(), random); expect(random).not.toHaveBeenCalled(); expect(warrior.reply()).toEqual([0, true]);
  });

  it("inserts a real evolved weapon and tombstones the old durable row atomically", async () => {
    const f = await fixture(70061, 11, 11024); const old = f.item.ItemID; await f.use(0);
    const result = f.p.storeBag.getItemAt(5)!; expect(result.TemplateID).toBe(70062); expect(result.ItemID).not.toBe(old);
    expect(result).toMatchObject({ AttackCompose: 17, Hole1: 311109, StrengthenLevel: 12, StrengthenTimes: 1 });
    const rows = await f.rows(); expect(rows.find(it => it.ItemID === old)).toMatchObject({ TemplateID: 70061, IsExist: false });
    expect(rows.find(it => it.ItemID === result.ItemID)).toMatchObject({ TemplateID: 70062, IsExist: true, StrengthenLevel: 12 });
    expect((await f.reload()).get(12)!.filter(it => it.Place === 5)).toHaveLength(1);
  });

  it("persists reverse evolution after a genuine failed +12 weapon attempt", async () => {
    const f = await fixture(70062, 12); const old = f.item.ItemID; await f.use(0.9999);
    expect(f.reply()).toEqual([1, false]); expect(f.p.storeBag.getItemAt(5)).toMatchObject({ TemplateID: 70061, StrengthenLevel: 11 });
    expect((await f.rows()).find(it => it.ItemID === old)!.IsExist).toBe(false);
    expect((await f.reload()).get(12)!.find(it => it.Place === 5)!.TemplateID).toBe(70061);
  });

  it("opens original level-gated holes without overwriting already mounted gems", async () => {
    const f = await fixture(7006, 5, 11024); f.item.Hole1 = 311109; f.item.Hole2 = -1; f.p.storeBag.updateItem(f.item); await f.save(); await f.use(0);
    expect(f.item.StrengthenLevel).toBe(6); expect(f.item.Hole1).toBe(311109); expect(f.item.Hole2).toBe(0);
    expect((await f.reload()).get(12)!.find(it => it.Place === 5)).toMatchObject({ Hole1: 311109, Hole2: 0 });
  });

  it("preserves valid derived gold identity and expires it normally after strengthening", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(begin);
    const f = await fixture(70062, 11, 11024); f.item.isGold = true; f.item.goldValidDate = 3; f.item.goldBeginTime = begin; f.item.goldTemplate = f.templates.findItem(70063)!;
    f.p.storeBag.updateItem(f.item);
    await f.save(); await f.use(0);
    expect(f.reply()).toEqual([0, true]); expect(f.p.storeBag.getItemAt(5)).toBe(f.item);
    expect(f.item.displayTemplateId()).toBe(70063); expect(f.item.TemplateID).toBe(70062);
    const loaded = (await f.reload()).get(12)!.find(it => it.Place === 5)!;
    expect(loaded).toMatchObject({ TemplateID: 70062, StrengthenLevel: 12, goldValidDate: 3, goldBeginTime: begin }); expect(loaded.displayTemplateId()).toBe(70063);
    vi.setSystemTime(new Date(begin.getTime() + 3 * 86400000)); f.p.recalcStats();
    expect(f.item.displayTemplateId()).toBe(70062); expect(f.item.isGold).toBe(false);
  });

  it("retains the real gold mapping and original three-day period across +15 template evolution", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(begin);
    const f = await fixture(70062, 14, 11024), old = f.item.ItemID;
    f.item.isGold = true; f.item.goldValidDate = 3; f.item.goldBeginTime = begin; f.item.goldTemplate = f.templates.findItem(70063)!;
    f.p.storeBag.updateItem(f.item); await f.save(); await f.use(0);
    expect(f.reply()).toEqual([0, true]);
    const evolved = f.p.storeBag.getItemAt(5)!;
    expect(evolved.ItemID).not.toBe(old); expect(evolved.TemplateID).toBe(70064); expect(evolved.displayTemplateId()).toBe(70063);
    expect(evolved).toMatchObject({ StrengthenLevel: 15, goldValidDate: 3, goldBeginTime: begin });
    expect((await f.rows()).find(it => it.ItemID === old)).toMatchObject({ TemplateID: 70062, IsExist: false });
    const loaded = (await f.reload()).get(12)!.find(it => it.Place === 5)!;
    expect(loaded).toMatchObject({ TemplateID: 70064, StrengthenLevel: 15, goldValidDate: 3, goldBeginTime: begin }); expect(loaded.displayTemplateId()).toBe(70063);
    vi.setSystemTime(new Date(begin.getTime() + 3 * 86400000)); f.p.recalcStats();
    expect(evolved.isGold).toBe(false); expect(evolved.displayTemplateId()).toBe(70064);
    await f.save(); expect((await f.reload()).get(12)!.find(it => it.Place === 5)!.displayTemplateId()).toBe(70064);
  });
});

describe("59 commit failures, locks and publication", () => {
  it("rolls back a real deferred SQL trigger failure and then accepts the same request without double consumption", async () => {
    const f = await fixture(), before = await f.rows(), live = [f.item.toRow(), f.stone.toRow()];
    await h.db.execute(sql.raw(`CREATE FUNCTION player.strengthen_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '59 deferred fault'; RETURN NEW; END $$`));
    await h.db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER strengthen_test_fault AFTER UPDATE ON player."Sys_Users_Detail" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."UserID" = ${f.p.id}) EXECUTE FUNCTION player.strengthen_test_fault()`));
    try {
      await f.use(0); expect(f.error).toHaveBeenCalled(); expect(await f.rows()).toEqual(before); expect([f.item.toRow(), f.stone.toRow()]).toEqual(live);
      expect(f.sent.filter(pkt => [64, 59, 229].includes(pkt.code))).toHaveLength(0);
    } finally {
      await h.db.execute(sql.raw(`DROP TRIGGER strengthen_test_fault ON player."Sys_Users_Detail"`));
      await h.db.execute(sql.raw("DROP FUNCTION player.strengthen_test_fault()"));
    }
    f.sent.length = 0; await f.use(0); expect(f.reply()).toEqual([0, true]); expect(f.stone.Count).toBe(2); expect((await f.reload()).get(12)!.find(it => it.Place === 5)!.StrengthenLevel).toBe(1);
  });

  it("blocks autosave and room entry until COMMIT, then runs hooks and releases both barriers", async () => {
    const f = await fixture(), transaction = h.db.transaction.bind(h.db);
    let release!: () => void, staged!: () => void; const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { staged = r; });
    const hook = vi.fn(); f.p.questInv = { onItemStrengthen: hook, takeDirty: () => [] } as unknown as GamePlayer["questInv"];
    const spy = vi.spyOn(h.db, "transaction").mockImplementationOnce(fn => transaction(async tx => { const result = await fn(tx); staged(); await gate; return result; }));
    const pending = f.use(0); await ready;
    expect(f.item.StrengthenLevel).toBe(0); expect(f.stone.Count).toBe(3); expect(f.sent).toHaveLength(0); expect(hook).not.toHaveBeenCalled();
    let entered = -1; const save = f.p.saveIntoDatabase(h.db), room = f.p.runRoomEntry(() => { entered = f.item.StrengthenLevel; });
    await Promise.resolve(); expect(entered).toBe(-1);
    release(); await pending; f.p.questInv = null; await save; await room; spy.mockRestore();
    expect(entered).toBe(1); expect(hook).toHaveBeenCalledExactlyOnceWith(7, 1);
    expect((await f.reload()).get(12)!.find(it => it.Place === 0)!.Count).toBe(2);
  });

  it("rereads expiry after waiting for the persistence lock, without rolling or consuming", async () => {
    const f = await fixture(); let release!: () => void;
    const prior = f.p.withPersistenceLock(() => new Promise<void>(r => { release = r; })); await Promise.resolve();
    const random = vi.fn(() => 0), pending = strengthen(f.ctx, f.p, f.packet(), random);
    f.stone.IsUsed = true; f.stone.ValidDate = 1; f.stone.BeginDate = begin; f.clock.time += 2 * 86400000;
    release(); await prior; await pending; expect(random).not.toHaveBeenCalled(); expect(f.stone.Count).toBe(3); expect(f.sent.filter(pkt => pkt.code === 59 || pkt.code === 64)).toHaveLength(0);
  });

  it("keeps SQL and live committed after transport disconnection and releases all bag batches", async () => {
    const f = await fixture(), send = f.p.sink.send.bind(f.p.sink);
    const spy = vi.spyOn(f.p.sink, "send").mockImplementation(pkt => { if (pkt.code === 64) throw new Error("59 disconnected"); send(pkt); });
    await expect(f.use(0)).rejects.toThrow("59 disconnected"); spy.mockRestore();
    expect(f.item.StrengthenLevel).toBe(1); expect(f.item.StrengthenTimes).toBe(1); expect(f.stone.Count).toBe(2);
    const loaded = (await f.reload()).get(12)!;
    expect(loaded.find(it => it.Place === 5)).toMatchObject({ StrengthenLevel: 1, StrengthenTimes: 1 });
    expect(loaded.find(it => it.Place === 0)!.Count).toBe(2); expect((await f.rows()).filter(it => it.IsExist)).toHaveLength(2);
    f.sent.length = 0; f.p.storeBag.updateItem(f.stone); expect(f.sent.filter(pkt => pkt.code === 64)).toHaveLength(1);
  });

  it("rejects malformed bodies, invalid live inputs, missing requirements and unsafe random samples without spending", async () => {
    for (const length of [0, 2, 5]) { const f = await fixture(); await f.use(0, false, length); expect(f.stone.Count).toBe(3); expect(f.sent.filter(pkt => pkt.code === 59 || pkt.code === 64)).toHaveLength(0); }
    const mutations: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
      f => { f.item.IsExist = false; }, f => { f.item.cellLocked = true; }, f => { f.stone.cellLocked = true; },
      f => { f.stone.Count = 0; }, f => { f.stone.Place = 4; }, f => { f.item.UserID++; },
      f => { f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; }, f => { f.p.currentRoom = { IsPlaying: true } as GamePlayer["currentRoom"]; },
      f => { f.templates.strengthen.clear(); }, f => { f.templates.strengthen.set(1, { ...f.templates.strengthen.get(1)!, Rock: 0 }); },
    ];
    for (const mutate of mutations) { const f = await fixture(); mutate(f); const before = [f.item.toRow(), f.stone.toRow()], random = vi.fn(() => 0); await strengthen(f.ctx, f.p, f.packet(), random); expect([f.item.toRow(), f.stone.toRow()]).toEqual(before); expect(random).not.toHaveBeenCalled(); expect(f.sent.filter(pkt => pkt.code === 59 || pkt.code === 64)).toHaveLength(0); }
    for (const sample of [NaN, -0.1, 1, Infinity]) { const f = await fixture(); const before = await f.rows(); await f.use(sample); expect(await f.rows()).toEqual(before); expect(f.stone.Count).toBe(3); expect(f.sent.filter(pkt => pkt.code === 59 || pkt.code === 64)).toHaveLength(0); }
  });
});
