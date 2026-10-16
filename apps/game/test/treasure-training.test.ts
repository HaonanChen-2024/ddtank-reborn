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
import type { ExerciseRow } from "../src/game/stats.js";
import { texp, registerUse } from "../src/handlers/use.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Complete original rows; independent Python gzip CRC and full-row equality are
// recorded under runtime/treasure-next-use-20261016. No installed/workshop DB.
const data = JSON.parse(readFileSync(new URL("./fixtures/treasure-training.json", import.meta.url), "utf8")) as { goods: ItemTemplate[]; exercise: ExerciseRow[] };
const begin = new Date("2026-10-16T08:00:00Z");
let h: DbHandle, sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await h?.close(); });

async function fixture(templateId = 40001, count = 3, place = 2) {
  const templates = new Templates(); templates.items = new Map(data.goods.map(t => [t.TemplateID, { ...t }]));
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `train${++sequence}`, NickName: `train${sequence}`, Grade: 20, IsFirst: 1, Gold: 5000 }).returning();
  const sent: GSPacket[] = [], p = new GamePlayer({ send: pkt => sent.push(GSPacket.parse(pkt.encode())), disconnect() {}, remoteAddress: "training-isolated-memory" }, (await loadPlayerInfo(h.db, row!.UserID))!, defaultMatch(row!.UserID), 1, "test");
  templates.stats.exercise = data.exercise; p.statTables = templates.stats; p.info.Texp.texpTaskDate = begin; p.recalcStats();
  const add = (id: number, slot: number, amount = 3) => { const added = ItemInfo.createFromTemplate(templates.findItem(id)!, amount, 0, begin); p.storeBag.addItemTo(added, slot); return added; };
  const potion = add(templateId, place, count);
  const save = async () => { await p.saveIntoDatabase(h.db); sent.length = 0; };
  await save();
  const clock = { time: begin.getTime() }, error = vi.fn();
  const ctx = { db: h, templates, now: () => new Date(clock.time), lang: { t: (key: string) => key }, log: { error } } as unknown as ServerContext;
  const use = (index = 0, id = templateId, slot = place) => texp(ctx, p, index, id, slot);
  const rows = () => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id));
  const reload = () => loadUserItems(h.db, p.id, templates.findItem, templates.findGoldTemplate);
  const info = () => loadPlayerInfo(h.db, p.id);
  const packet = (index = 0, length = 12) => { const pkt = new GSPacket(99); pkt.writeInt(index); pkt.writeInt(templateId); pkt.writeInt(place); if (length !== 12) pkt.setBody(new Uint8Array(length)); return GSPacket.parse(pkt.encode()); };
  const registry = new HandlerRegistry(); registerUse(registry);
  const throughRegistry = (index = 0, length = 12) => registry.get(99)!.handle(ctx, { player: p } as GameClient, packet(index, length));
  return { p, potion, templates, sent, ctx, clock, error, use, rows, reload, info, save, add, place, throughRegistry };
}

async function trainingBuff(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<GamePlayer["buffs"][number]> = {}) {
  const buff = { UserID: f.p.id, Type: 71, Value: 5, BeginDate: begin, ValidDate: 1440, TemplateID: 11911, ValidCount: 0, Data: null, IsExist: true, ...overrides };
  f.p.buffs.push(buff); await f.save(); return buff;
}

describe("99 genuine training potions, durable use", () => {
  it("saves consumed potion and training experience before returning without autosave", async () => {
    const f = await fixture(); await f.use();
    expect(f.p.info.Texp).toMatchObject({ hpTexpExp: 30, texpCount: 1, texpTaskCount: 1 });
    expect((await f.info())!.Texp).toMatchObject({ hpTexpExp: 30, texpCount: 1, texpTaskCount: 1 });
    expect((await f.rows()).find(x => x.ItemID === f.potion.ItemID)!.Count).toBe(2);
  });

  it("consumes the selected workbench cell rather than an earlier same-template stack", async () => {
    const f = await fixture(), spare = f.add(40001, 0, 10); await f.save(); await f.use();
    expect(spare.Count).toBe(10); expect(f.potion.Count).toBe(2);
    expect((await f.rows()).find(x => x.ItemID === f.potion.ItemID)!.Count).toBe(2);
  });

  it.each([40001, 40002, 40003].flatMap(id => [0, 1, 2, 3, 4].map(index => ({ id, index }))))("uses genuine potion $id in training channel $index through the actual registry", async ({ id, index }) => {
    const f = await fixture(id), keys = ["hpTexpExp", "attTexpExp", "defTexpExp", "spdTexpExp", "lukTexpExp"] as const, hook = vi.fn();
    f.p.questInv = { onUsingItem: hook } as unknown as GamePlayer["questInv"];
    await f.throughRegistry(index);
    const stored = (await f.info())!.Texp;
    for (let i = 0; i < keys.length; i++) expect(stored[keys[i]!]).toBe(i === index ? f.potion.template.Property2 : 0);
    expect(stored).toMatchObject({ texpCount: 1, texpTaskCount: 1 });
    expect(hook.mock.calls).toEqual([[id], [45001 + ((index + 4) % 5)]]);
    expect((await f.reload()).get(12)!.find(x => x.ItemID === f.potion.ItemID)!.Count).toBe(2);
  });

  it("keeps the real three potion rows and training-master buff unchanged", () => {
    for (const [id, exp] of [[40001, 30], [40002, 300], [40003, 900]]) expect(data.goods.find(t => t.TemplateID === id)).toMatchObject({ CategoryID: 20, Property1: 0, Property2: exp, Property3: 1, CanUse: true, CanDelete: true, NeedLevel: 0, MaxCount: 9999 });
    expect(data.goods.find(t => t.TemplateID === 11911)).toMatchObject({ Property1: 71, Property2: 5, Property3: 0 });
  });

  it.each([0, 1, 2, 3, 4])("recalculates actual player attributes from genuine ExerciseInfo in channel %i", async index => {
    const f = await fixture(40003), field = (["hp", "Attack", "Defence", "Agility", "Luck"] as const)[index]!, before = f.p.info[field];
    await f.use(index); expect(f.p.info[field] - before).toBe(index === 0 ? 50 : 5);
    const loaded = new GamePlayer({ send() {}, disconnect() {}, remoteAddress: "training-relogin" }, (await f.info())!, defaultMatch(f.p.id), 1, "test");
    loaded.statTables = f.templates.stats; loaded.recalcStats(); expect(loaded.info[field]).toBe(f.p.info[field]);
  });

  it("saves the final potion tombstone and reloads the exact training result once", async () => {
    const f = await fixture(40003, 1); await f.use(4); const rows = await f.rows();
    expect(rows).toEqual([expect.objectContaining({ ItemID: f.potion.ItemID, IsExist: false, BagType: -1, Place: -1 })]);
    expect((await f.info())!.Texp).toMatchObject({ lukTexpExp: 900, texpCount: 1, texpTaskCount: 1 }); expect((await f.reload()).get(12) ?? []).toHaveLength(0);
    const packets = f.sent.length; await f.use(4); expect(await f.rows()).toEqual(rows); expect(f.sent).toHaveLength(packets);
  });

  it.each([{ vip: 2, cap: 40 }, { vip: 3, cap: 60 }])("keeps original grade times multiplier cap at VIP $vip", async ({ vip, cap }) => {
    const f = await fixture(); f.p.info.VIPLevel = vip; f.p.info.Texp.texpCount = cap - 1; await f.save(); await f.use();
    expect((await f.info())!.Texp.texpCount).toBe(cap); expect(f.potion.Count).toBe(2);
    const before = await f.rows(), notice = vi.spyOn(f.p, "sendMessage"); await f.use();
    expect(await f.rows()).toEqual(before); expect((await f.info())!.Texp.texpCount).toBe(cap); expect(notice).toHaveBeenCalledWith(0, "texpSystem.texpCountToplimit");
  });

  it("applies the real training-master +5 while retaining its unlimited-use counter", async () => {
    const f = await fixture(); f.p.info.Texp.texpCount = 44; const buff = await trainingBuff(f); await f.use();
    expect((await f.info())!.Texp.texpCount).toBe(45); expect(f.potion.Count).toBe(2); expect(buff.ValidCount).toBe(0);
    await f.use(); expect(f.potion.Count).toBe(2); expect((await f.info())!.Texp.texpCount).toBe(45);
    expect((await h.db.select().from(player.User_Buff).where(eq(player.User_Buff.UserID, f.p.id)))[0]).toMatchObject({ ValidCount: 0, Value: 5, TemplateID: 11911 });
  });

  it("uses an inclusive buff expiry and rejects expired, missing-template or inactive buffs", async () => {
    const atEnd = await fixture(); atEnd.p.info.Texp.texpCount = 40; await trainingBuff(atEnd); atEnd.clock.time += 86_400_000; atEnd.p.info.Texp.texpTaskDate = new Date(atEnd.clock.time); await atEnd.save(); await atEnd.use(); expect(atEnd.potion.Count).toBe(2);
    for (const tweak of [{ BeginDate: new Date(begin.getTime() - 86_400_001) }, { TemplateID: 999999999 }, { IsExist: false }]) {
      const f = await fixture(); f.p.info.Texp.texpCount = 40; await trainingBuff(f, tweak); await f.use(); expect(f.potion.Count).toBe(3); expect((await f.info())!.Texp.texpCount).toBe(40);
    }
  });

  it("retains original limited UsePayBuff counter semantics in the same transaction", async () => {
    // No real seed Train_Good has Property3>0. This explicit rule simulation
    // exercises GamePlayer.UsePayBuff's supported limited-use branch only.
    const f = await fixture(); f.templates.findItem(11911)!.Property3 = 2; f.p.info.Texp.texpCount = 40;
    await trainingBuff(f, { ValidCount: 2 }); await f.use();
    expect(f.potion.Count).toBe(2); expect(f.p.buffs[0]!.ValidCount).toBe(1);
    expect((await h.db.select().from(player.User_Buff).where(eq(player.User_Buff.UserID, f.p.id)))[0]!.ValidCount).toBe(1);
    f.p.info.Texp.texpCount = 45; await f.save(); await f.use();
    expect(f.potion.Count).toBe(2); expect(f.p.buffs[0]!.ValidCount).toBe(0);
    expect((await h.db.select().from(player.User_Buff).where(eq(player.User_Buff.UserID, f.p.id)))[0]!.ValidCount).toBe(0);
    f.p.info.Texp.texpCount = 40; await f.save(); await f.use(); expect(f.potion.Count).toBe(2); expect(f.p.buffs[0]!.ValidCount).toBe(0);
  });

  it("resets only a previous-day count already at its current cap", async () => {
    const f = await fixture(); f.p.info.Texp.texpCount = 40; f.p.info.Texp.texpTaskCount = 90; f.p.info.Texp.texpTaskDate = new Date(begin.getTime() - 86_400_000); await f.save(); await f.use();
    expect((await f.info())!.Texp).toMatchObject({ texpCount: 1, texpTaskCount: 91, texpTaskDate: begin });
    const below = await fixture(); below.p.info.Texp.texpCount = 39; below.p.info.Texp.texpTaskDate = new Date(begin.getTime() - 86_400_000); await below.save(); await below.use();
    expect((await below.info())!.Texp).toMatchObject({ texpCount: 40, texpTaskDate: new Date(begin.getTime() - 86_400_000) });
  });

  it("compares the server local calendar across UTC midnight and local midnight", async () => {
    const oldZone = process.env.TZ; process.env.TZ = "Asia/Shanghai";
    try {
      expect(new Date(2026, 9, 16).getTimezoneOffset()).toBe(-480);
      const sameDay = await fixture(); sameDay.p.info.Texp.texpCount = 40; sameDay.p.info.Texp.texpTaskDate = new Date(2026, 9, 16, 7, 30); sameDay.clock.time = new Date(2026, 9, 16, 8, 30).getTime(); await sameDay.save(); await sameDay.use();
      expect(sameDay.potion.Count).toBe(3); expect((await sameDay.info())!.Texp.texpCount).toBe(40);
      const nextDay = await fixture(); nextDay.p.info.Texp.texpCount = 40; nextDay.p.info.Texp.texpTaskDate = new Date(2026, 9, 16, 23, 59); nextDay.clock.time = new Date(2026, 9, 17, 0, 1).getTime(); await nextDay.save(); await nextDay.use();
      expect(nextDay.potion.Count).toBe(2); expect((await nextDay.info())!.Texp).toMatchObject({ texpCount: 1, texpTaskDate: new Date(nextDay.clock.time) });
    } finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
  });
});

describe("99 failure boundaries and atomic publication", () => {
  it("rolls back actual deferred SQL failure, including limited buff, and accepts a later retry", async () => {
    const f = await fixture(40001, 1); f.templates.findItem(11911)!.Property3 = 1; await trainingBuff(f, { ValidCount: 1 });
    const before = await f.rows(), beforeInfo = await f.info(), beforeBuff = await h.db.select().from(player.User_Buff).where(eq(player.User_Buff.UserID, f.p.id));
    const hook = vi.fn(); f.p.questInv = { onUsingItem: hook } as unknown as GamePlayer["questInv"];
    await h.db.execute(sql.raw(`CREATE FUNCTION player.training_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '99 deferred fault'; RETURN NEW; END $$`));
    await h.db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER training_test_fault AFTER UPDATE ON player."Sys_Users_Detail" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."UserID" = ${f.p.id}) EXECUTE FUNCTION player.training_test_fault()`));
    try {
      await f.use(); expect(f.error).toHaveBeenCalled(); expect(await f.rows()).toEqual(before); expect(await f.info()).toEqual(beforeInfo); expect(f.potion.IsExist).toBe(true); expect(f.p.buffs[0]!.ValidCount).toBe(1); expect(hook).not.toHaveBeenCalled();
      expect(await h.db.select().from(player.User_Buff).where(eq(player.User_Buff.UserID, f.p.id))).toEqual(beforeBuff); expect(f.sent.filter(pkt => [64, 229].includes(pkt.code))).toHaveLength(0);
    } finally { await h.db.execute(sql.raw(`DROP TRIGGER training_test_fault ON player."Sys_Users_Detail"`)); await h.db.execute(sql.raw("DROP FUNCTION player.training_test_fault()")); }
    await f.use(); expect((await f.info())!.Texp.hpTexpExp).toBe(30); expect(f.p.buffs[0]!.ValidCount).toBe(0); expect(hook).toHaveBeenCalledTimes(2); expect(f.p.storeBag.getItemAt(f.place)).toBeNull();
  });

  it("holds room entry and autosave until publication and runs quests only after commit", async () => {
    const f = await fixture(), transaction = h.db.transaction.bind(h.db); let release!: () => void, staged!: () => void;
    const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { staged = r; });
    const hook = vi.fn(); f.p.questInv = { onUsingItem: hook, takeDirty: () => [] } as unknown as GamePlayer["questInv"];
    vi.spyOn(h.db, "transaction").mockImplementationOnce(fn => transaction(async tx => { const result = await fn(tx); staged(); await gate; return result; }));
    const pending = f.use(); await ready; expect(f.p.info.Texp.hpTexpExp).toBe(0); expect(f.potion.Count).toBe(3); expect(f.sent).toHaveLength(0); expect(hook).not.toHaveBeenCalled();
    let entered = -1; const save = f.p.saveIntoDatabase(h.db), room = f.p.runRoomEntry(() => { entered = f.p.info.Texp.hpTexpExp; }); await Promise.resolve(); expect(entered).toBe(-1);
    release(); await pending; f.p.questInv = null; await save; await room; expect(entered).toBe(30); expect(hook).toHaveBeenCalledTimes(2); expect((await f.info())!.Texp.hpTexpExp).toBe(30);
  });

  it("rechecks potion expiry and the active session after either lock wait", async () => {
    const first = await fixture(); first.potion.IsUsed = true; first.potion.ValidDate = 1; first.p.storeBag.updateItem(first.potion); await first.save();
    let unlock!: () => void; const prior = first.p.withPersistenceLock(() => new Promise<void>(r => { unlock = r; })); await Promise.resolve(); const waiting = first.use(); first.clock.time += 86_400_000; unlock(); await prior; await waiting;
    expect(first.potion.Count).toBe(3); expect((await first.info())!.Texp.hpTexpExp).toBe(0);
    for (const change of [(f: Awaited<ReturnType<typeof fixture>>) => { f.p.isActive = false; }, (f: Awaited<ReturnType<typeof fixture>>) => { f.p.quitting = Promise.resolve(); }, (f: Awaited<ReturnType<typeof fixture>>) => { f.p.currentRoom = { IsPlaying: true } as GamePlayer["currentRoom"]; }, (f: Awaited<ReturnType<typeof fixture>>) => { f.potion.IsUsed = true; f.potion.ValidDate = 1; f.clock.time += 86_400_000; }]) {
      const f = await fixture(), transaction = h.db.transaction.bind(h.db); vi.spyOn(h.db, "transaction").mockImplementationOnce(fn => transaction(async tx => { change(f); return fn(tx); }));
      await f.use(); expect(f.potion.Count).toBe(3); expect((await f.info())!.Texp.hpTexpExp).toBe(0); vi.restoreAllMocks();
    }
  });

  it("keeps committed experience and consumption after transport failure and releases inventory notifications", async () => {
    const f = await fixture(), original = f.p.sink.send.bind(f.p.sink), hook = vi.fn(); f.p.questInv = { onUsingItem: hook } as unknown as GamePlayer["questInv"];
    const spy = vi.spyOn(f.p.sink, "send").mockImplementation(pkt => { if (pkt.code === 64) throw new Error("99 transport failed"); original(pkt); });
    await expect(f.use()).rejects.toThrow("99 transport failed"); spy.mockRestore(); expect((await f.info())!.Texp.hpTexpExp).toBe(30); expect(f.potion.Count).toBe(2); expect(hook).toHaveBeenCalledTimes(2);
    f.sent.length = 0; f.p.storeBag.updateItem(f.potion); expect(f.sent.filter(pkt => pkt.code === 64)).toHaveLength(1);
  });

  it("serializes concurrent requests as distinct uses of a remaining stack", async () => {
    const f = await fixture(); await Promise.all([f.use(1), f.use(1), f.use(1), f.use(1)]);
    expect((await f.info())!.Texp).toMatchObject({ attTexpExp: 90, texpCount: 3, texpTaskCount: 3 }); expect(f.p.storeBag.getItemAt(f.place)).toBeNull();
  });

  it("rejects malformed packets, invalid training channels and invalid selected cells without changing SQL", async () => {
    for (const length of [0, 4, 8, 13]) { const f = await fixture(), before = await f.rows(); await f.throughRegistry(0, length); expect(await f.rows()).toEqual(before); expect(f.sent).toHaveLength(0); }
    const changes: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
      f => { f.p.isActive = false; }, f => { f.p.quitting = Promise.resolve(); }, f => { f.p.currentRoom = { IsPlaying: true } as GamePlayer["currentRoom"]; },
      f => { f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; }, f => { f.p.extra = { coupleBossBoxNum: 9 } as NonNullable<GamePlayer["extra"]>; },
      f => { f.potion.cellLocked = true; }, f => { f.potion.UserID++; }, f => { f.potion.Place = 10; }, f => { f.potion.BagType = 1; }, f => { f.potion.IsExist = false; },
      f => { f.potion.Count = 0; }, f => { f.potion.Count = 10000; }, f => { f.potion.template.CategoryID = 11; }, f => { f.potion.template.Property2 = -1; },
      f => { f.potion.template.Property2 = NaN; }, f => { f.p.info.Grade = 0; }, f => { f.p.info.Texp.hpTexpExp = 2_147_483_647; }, f => { f.p.info.Texp.texpTaskCount = 2_147_483_647; },
    ];
    for (const change of changes) { const f = await fixture(), before = await f.rows(), beforeInfo = await f.info(); change(f); await f.use(); expect(await f.rows()).toEqual(before); expect(await f.info()).toEqual(beforeInfo); expect(f.sent.filter(pkt => [64, 229].includes(pkt.code))).toHaveLength(0); }
    for (const [index, id, place] of [[-1,40001,2],[5,40001,2],[1.5,40001,2],[0,40002,2],[0,40001,-1],[0,40001,20]]) { const f = await fixture(), before = await f.rows(); await f.use(index,id,place); expect(await f.rows()).toEqual(before); expect((await f.info())!.Texp.hpTexpExp).toBe(0); }
  });
});
