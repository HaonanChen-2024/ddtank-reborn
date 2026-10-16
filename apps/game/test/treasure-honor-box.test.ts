import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { Templates, type ItemBoxRow } from "../src/db/templates.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { openBox, registerUse } from "../src/handlers/use.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Complete rows from committed Shop_Goods/Shop_Goods_Box; Python stdlib gzip was
// independently used only to prepare this fixture (the test has no gzip dependency).
const data = JSON.parse(readFileSync(new URL("./fixtures/treasure-honor-box.json", import.meta.url), "utf8")) as { goods: ItemTemplate[]; boxes: ItemBoxRow[] };
const begin = new Date("2026-10-16T00:00:00Z");
let h: DbHandle, sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await h?.close(); });

async function fixture(id = 11917, count = 3) {
  const templates = new Templates(); templates.items = new Map(data.goods.map(t => [t.TemplateID, structuredClone(t)]));
  for (const row of data.boxes) templates.itemBoxes.set(row.ID, [...(templates.itemBoxes.get(row.ID) ?? []), structuredClone(row)]);
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `ark${++sequence}`, NickName: `ark${sequence}`, Grade: 20, IsFirst: 1, myHonor: 21 }).returning();
  const info = (await loadPlayerInfo(h.db, row!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: pkt => sent.push(GSPacket.parse(pkt.encode())), disconnect() {}, remoteAddress: "box-isolated-memory" }, info, defaultMatch(info.ID), 1, "test");
  p.statTables = templates.stats;
  const box = ItemInfo.createFromTemplate(templates.findItem(id)!, count, 0, begin); p.propBag.addItemTo(box, 0);
  await p.saveIntoDatabase(h.db); sent.length = 0;
  const error = vi.fn(), clock = { time: begin.getTime() };
  const ctx = { db: h, templates, now: () => new Date(clock.time), lang: { t: (key: string) => key }, log: { error } } as unknown as ServerContext;
  const packet = (num = 1, bag = 1, slot = 0, length = 9) => { const out = new GSPacket(63); out.writeByte(bag); out.writeInt(slot); out.writeInt(num); if (length !== 9) out.setBody(new Uint8Array(length)); return GSPacket.parse(out.encode()); };
  const use = (num = 1, sample = 0) => openBox(ctx, p, packet(num), () => sample);
  const rows = () => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id));
  const mails = () => h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, p.id));
  const reload = () => loadUserItems(h.db, p.id, templates.findItem, templates.findGoldTemplate);
  const save = async () => { await p.saveIntoDatabase(h.db); sent.length = 0; };
  const replaceRows = (rows: ItemBoxRow[]) => { templates.itemBoxes.set(id, rows); };
  const award = (templateId: number, count: number, extra: Partial<ItemBoxRow> = {}): ItemBoxRow => ({ ...data.boxes.find(row => row.ID === 11917)!, ID: id, TemplateId: templateId, ItemCount: count, ...extra });
  return { p, ctx, box, templates, sent, error, clock, packet, use, rows, mails, reload, save, replaceRows, award };
}

function response(sent: GSPacket[]) {
  const out = sent.find(p => p.code === 63)!; expect(out).toBeDefined();
  const name = out.readString(), count = out.readByte(), items = [];
  for (let i = 0; i < count; i++) items.push({ id: out.readInt(), count: out.readInt(), bound: out.readBoolean(), valid: out.readInt(), strengthen: out.readInt(), attack: out.readInt(), defend: out.readInt(), agility: out.readInt(), luck: out.readInt() });
  return { name, items };
}

describe("63 genuine treasure honor essence and ordinary box durability", () => {
  it("commits 11917 CanUse=false through its real registry and -800 row, without autosave or a synthetic 63 item reply", async () => {
    const f = await fixture(); expect(f.box.template.CanUse).toBe(false);
    const registry = new HandlerRegistry(); registerUse(registry);
    await registry.get(63)!.handle(f.ctx, { player: f.p } as GameClient, f.packet());
    expect(f.box.Count).toBe(2); expect(f.p.info.myHonor).toBe(521);
    expect((await loadPlayerInfo(h.db, f.p.id))!.myHonor).toBe(521); expect((await f.reload()).get(1)!.find(it => it.Place === 0)!.Count).toBe(2);
    expect(f.sent.some(pkt => pkt.code === 63)).toBe(false); expect(f.sent.some(pkt => pkt.code === 64)).toBe(true);
    expect(await f.mails()).toHaveLength(0);
  });

  it.each([0, -1, 4, 2147483647])("preserves original requested-count %i fallback to the entire stack", async num => {
    const f = await fixture(); await f.use(num);
    expect(f.p.info.myHonor).toBe(1521); expect(f.p.propBag.getItemAt(0)).toBeNull();
    expect((await f.rows()).find(it => it.ItemID === f.box.ItemID)).toMatchObject({ Count: 3, IsExist: false, Place: -1, BagType: -1 });
    expect((await f.reload()).get(1) ?? []).toHaveLength(0);
  });

  it("opens the actual level-one essence at grade one and saves a full 9999-unit stack", async () => {
    const f = await fixture(11917, 9999); f.p.info.Grade = 1; await f.save(); await f.use(0);
    expect(f.p.info.myHonor).toBe(4999521); expect((await loadPlayerInfo(h.db, f.p.id))!.myHonor).toBe(4999521);
    expect(f.p.propBag.getItemAt(0)).toBeNull();
  });

  it("saves the last unit and accepts no second reward from its consumed slot", async () => {
    const f = await fixture(11917, 1); await f.use(); await f.use();
    expect(f.p.info.myHonor).toBe(521); expect((await loadPlayerInfo(h.db, f.p.id))!.myHonor).toBe(521);
    expect((await f.rows()).find(it => it.ItemID === f.box.ItemID)!.IsExist).toBe(false);
  });

  it("treats a new packet against a remaining stack as a new opening", async () => {
    const f = await fixture(); await f.use(); await f.use(); expect(f.p.info.myHonor).toBe(1021); expect(f.box.Count).toBe(1);
  });

  it("grants the genuine selected 15-day 7019 weapon row and preserves the 63 merged packet", async () => {
    const f = await fixture(11262); await f.use(2);
    const loaded = (await f.reload()).get(0)!;
    expect(loaded.filter(it => it.TemplateID === 7019)).toHaveLength(2);
    for (const it of loaded) expect(it).toMatchObject({ Count: 1, IsBinds: true, ValidDate: 15, StrengthenLevel: 0 });
    expect(response(f.sent)).toEqual({ name: f.box.template.Name, items: [{ id: 7019, count: 2, bound: true, valid: 15, strengthen: 0, attack: 0, defend: 0, agility: 0, luck: 0 }] });
    expect((await f.rows()).find(it => it.ItemID === f.box.ItemID)!.Count).toBe(1);
  });

  it("grants the actual 112133 two-item and eight-medal rows in the same transaction", async () => {
    const f = await fixture(112133); await f.use();
    const loaded = (await f.reload()).get(1)!;
    expect(loaded.find(it => it.TemplateID === 40001)).toMatchObject({ Count: 2, IsBinds: true });
    expect(loaded.find(it => it.TemplateID === 11408)).toMatchObject({ Count: 8, IsBinds: true });
    expect(f.box.Count).toBe(2); expect(response(f.sent).items.map(x => [x.id, x.count])).toEqual([[40001, 2]]);
  });

  it("commits ordinary currency totals and GP without GP-buff multiplication", async () => {
    const f = await fixture(); f.replaceRows([-100, -200, -1100, -800, -900, 11107].map(id => f.award(id, 2)));
    f.p.buffs = [{ UserID: f.p.id, Type: 13, Value: 2, BeginDate: begin, ValidDate: 99999999, TemplateID: 1, ValidCount: 0, Data: null, IsExist: true }];
    const before = { ...f.p.info }; await f.use(2);
    const info = (await loadPlayerInfo(h.db, f.p.id))!;
    for (const k of ["Gold", "Money", "GiftToken", "myHonor", "hardCurrency", "GP"] as const) expect(info[k]).toBe(before[k] + 4);
    expect(f.box.Count).toBe(1); expect(f.sent.some(p => p.code === 63)).toBe(false);
  });

  it("routes full ordinary reward bags to committed mail instead of dropping their contents", async () => {
    const f = await fixture(11262); f.p.equipBag.capacity = 31; await f.use(2);
    const mails = await f.mails(); expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ Type: 12, ReceiverID: f.p.id, Title: "开箱奖励" });
    const ids = [mails[0]!.Annex1, mails[0]!.Annex2].map(Number); expect(ids.every(id => id > 0)).toBe(true);
    const attached = await h.db.select().from(player.Sys_Users_Goods).where(sql`${player.Sys_Users_Goods.ItemID} in (${ids[0]}, ${ids[1]})`);
    expect(attached).toHaveLength(2); for (const it of attached) expect(it).toMatchObject({ TemplateID: 7019, Count: 1, UserID: 0, BagType: -1, Place: -1, IsBinds: true, ValidDate: 15 });
    expect(f.box.Count).toBe(1); expect(f.sent.some(p => p.code === 117)).toBe(true);
  });

  it("mails both genuine 112133 item and medal rewards when the prop bag is full", async () => {
    const f = await fixture(112133); f.p.propBag.capacity = 1; await f.use();
    const mails = await f.mails(); expect(mails).toHaveLength(1);
    const rows = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, 0));
    const ids = [mails[0]!.Annex1, mails[0]!.Annex2].map(Number);
    expect(rows.filter(r => ids.includes(r.ItemID)).map(r => [r.TemplateID, r.Count]).sort()).toEqual([[11408, 8], [40001, 2]]);
    expect(f.box.Count).toBe(2);
  });

  it("splits large ordinary awards at MaxCount and preserves each unit in overflow mail", async () => {
    const f = await fixture(112133); f.p.propBag.capacity = 1;
    const t = f.templates.findItem(40001)!; f.replaceRows([f.award(40001, t.MaxCount * 2 + 3, { IsBind: false, ItemValid: 7, StrengthenLevel: 2, AttackCompose: 5, DefendCompose: 6, AgilityCompose: 7, LuckCompose: 8 })]);
    await f.use(); const [mail] = await f.mails(); expect(mail).toBeDefined();
    const ids = [mail!.Annex1, mail!.Annex2, mail!.Annex3].map(Number);
    const rows = (await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, 0))).filter(r => ids.includes(r.ItemID));
    expect(rows.map(r => r.Count).sort((a,b) => a-b)).toEqual([3, t.MaxCount, t.MaxCount]);
    for (const row of rows) expect(row).toMatchObject({ IsBinds: false, ValidDate: 7, StrengthenLevel: 2, AttackCompose: 5, DefendCompose: 6, AgilityCompose: 7, LuckCompose: 8 });
    expect(response(f.sent).items[0]!.count).toBe(t.MaxCount * 2 + 3);
  });

  it("retains source and all outputs if a possible ordinary item template is absent", async () => {
    const f = await fixture(); f.replaceRows([f.award(-800, 500), f.award(99999999, 1, { IsSelect: false })]);
    const random = vi.fn(() => 0); await openBox(f.ctx, f.p, f.packet(), random);
    expect(random).not.toHaveBeenCalled(); expect(f.p.info.myHonor).toBe(21); expect(f.box.Count).toBe(3); expect(await f.mails()).toHaveLength(0);
    expect((await loadPlayerInfo(h.db, f.p.id))!.myHonor).toBe(21); expect(f.sent.some(p => [63,64].includes(p.code))).toBe(false);
  });

  it.each([-1000, -1200, -1300, -777])("retains source for unimplemented currency %i", async id => {
    const f = await fixture(); f.replaceRows([f.award(-800, 500), f.award(id, 1)]); await f.use(); expect(f.box.Count).toBe(3); expect(f.p.info.myHonor).toBe(21);
  });

  it("retains source if medal template is absent or a resulting SQL integer would overflow", async () => {
    const medal = await fixture(112133); medal.templates.items.delete(11408); await medal.use(); expect(medal.box.Count).toBe(3); expect(await medal.mails()).toHaveLength(0);
    const honor = await fixture(); honor.p.info.myHonor = 2147483640; await honor.save(); await honor.use();
    expect(honor.box.Count).toBe(3); expect((await loadPlayerInfo(h.db, honor.p.id))!.myHonor).toBe(2147483640);
  });

  it("rejects a nonfinite random result without consuming an ordinary randomized box", async () => {
    const f = await fixture(); f.replaceRows([f.award(-800, 500, { IsSelect: false })]); await f.use(1, NaN);
    expect(f.box.Count).toBe(3); expect(f.p.info.myHonor).toBe(21); expect(f.error).toHaveBeenCalled();
  });
});

describe("63 rollback, barriers and publication", () => {
  it("rolls back a genuine deferred SQL failure, then safely accepts the same request", async () => {
    const f = await fixture(), before = await f.rows(), live = f.box.toRow(); const hook = vi.fn(); f.p.questInv = { onUsingItem: hook } as unknown as GamePlayer["questInv"];
    await h.db.execute(sql.raw(`CREATE FUNCTION player.ark_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '63 deferred fault'; RETURN NEW; END $$`));
    await h.db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER ark_test_fault AFTER UPDATE ON player."Sys_Users_Detail" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."UserID" = ${f.p.id}) EXECUTE FUNCTION player.ark_test_fault()`));
    try {
      await f.use(); expect(f.error).toHaveBeenCalled(); expect(await f.rows()).toEqual(before); expect(f.box.toRow()).toEqual(live); expect(f.p.info.myHonor).toBe(21);
      expect((await loadPlayerInfo(h.db, f.p.id))!.myHonor).toBe(21); expect(hook).not.toHaveBeenCalled(); expect(f.sent.some(p => [63, 64, 117].includes(p.code))).toBe(false);
    } finally {
      await h.db.execute(sql.raw('DROP TRIGGER ark_test_fault ON player."Sys_Users_Detail"')); await h.db.execute(sql.raw("DROP FUNCTION player.ark_test_fault()"));
    }
    await f.use(); expect(f.box.Count).toBe(2); expect(f.p.info.myHonor).toBe(521); expect(hook).toHaveBeenCalledExactlyOnceWith(11917); f.p.questInv = null;
  });

  it("rolls back source, medal, item and overflow mail when the mail insert fails", async () => {
    const f = await fixture(112133); f.p.propBag.capacity = 1; const before = await f.rows();
    await h.db.execute(sql.raw(`CREATE FUNCTION player.ark_mail_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '63 mail fault'; RETURN NEW; END $$`));
    await h.db.execute(sql.raw(`CREATE TRIGGER ark_mail_fault BEFORE INSERT ON player."User_Messages" FOR EACH ROW WHEN (NEW."ReceiverID" = ${f.p.id}) EXECUTE FUNCTION player.ark_mail_fault()`));
    try { await f.use(); expect(f.box.Count).toBe(3); expect(await f.rows()).toEqual(before); expect(await f.mails()).toHaveLength(0); expect(f.error).toHaveBeenCalled(); }
    finally { await h.db.execute(sql.raw('DROP TRIGGER ark_mail_fault ON player."User_Messages"')); await h.db.execute(sql.raw("DROP FUNCTION player.ark_mail_fault()")); }
    await f.use(); expect(f.box.Count).toBe(2); expect(await f.mails()).toHaveLength(1);
  });

  it("serializes autosave and room entry until the complete profile/items commit, with hooks afterwards", async () => {
    const f = await fixture(), transaction = h.db.transaction.bind(h.db); const hook = vi.fn(); f.p.questInv = { onUsingItem: hook, takeDirty: () => [] } as unknown as GamePlayer["questInv"];
    let release!: () => void, staged!: () => void; const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { staged = r; });
    vi.spyOn(h.db, "transaction").mockImplementationOnce(fn => transaction(async tx => { const result = await fn(tx); staged(); await gate; return result; }));
    const pending = f.use(); await ready; expect(f.box.Count).toBe(3); expect(f.p.info.myHonor).toBe(21); expect(f.sent).toHaveLength(0); expect(hook).not.toHaveBeenCalled();
    let entered = -1; const save = f.p.saveIntoDatabase(h.db), room = f.p.runRoomEntry(() => { entered = f.p.info.myHonor; });
    await Promise.resolve(); expect(entered).toBe(-1); release(); await pending; f.p.questInv = null; await save; await room;
    expect(entered).toBe(521); expect(hook).toHaveBeenCalledExactlyOnceWith(11917); expect((await loadPlayerInfo(h.db, f.p.id))!.myHonor).toBe(521);
  });

  it("rechecks expiry after waiting for persistence and never rolls or consumes stale material", async () => {
    const f = await fixture(); let release!: () => void; const prior = f.p.withPersistenceLock(() => new Promise<void>(r => { release = r; })); await Promise.resolve();
    const rnd = vi.fn(() => 0), pending = openBox(f.ctx, f.p, f.packet(), rnd); f.box.IsUsed = true; f.box.ValidDate = 1; f.box.BeginDate = begin; f.clock.time += 2 * 86400000;
    release(); await prior; await pending; expect(rnd).not.toHaveBeenCalled(); expect(f.box.Count).toBe(3); expect(f.p.info.myHonor).toBe(21);
  });

  it.each(["locked", "cell", "fight", "inactive", "quitting", "level", "owner"])("rejects %s state without consuming", async reason => {
    const f = await fixture();
    if (reason === "locked") { f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; }
    if (reason === "cell") f.box.cellLocked = true;
    if (reason === "fight") f.p.currentRoom = { IsPlaying: true } as GamePlayer["currentRoom"];
    if (reason === "inactive") f.p.isActive = false;
    if (reason === "quitting") f.p.quitting = Promise.resolve();
    if (reason === "level") f.p.info.Grade = 0;
    if (reason === "owner") f.box.UserID++;
    await f.use(); expect(f.box.Count).toBe(3); expect(f.p.info.myHonor).toBe(21);
  });

  it.each([0, 8, 10])("rejects malformed %i-byte requests before persistence", async n => {
    const f = await fixture(); const transaction = vi.spyOn(h.db, "transaction"); await openBox(f.ctx, f.p, f.packet(1, 1, 0, n)); expect(transaction).not.toHaveBeenCalled(); expect(f.box.Count).toBe(3);
  });

  it("publishes all committed state after transport disconnection and does not leave bag change depth open", async () => {
    const f = await fixture(); const hook = vi.fn(); f.p.questInv = { onUsingItem: hook } as unknown as GamePlayer["questInv"];
    const send = f.p.sink.send.bind(f.p.sink); const spy = vi.spyOn(f.p.sink, "send").mockImplementation(pkt => { if (pkt.code === 64) throw new Error("63 disconnected"); send(pkt); });
    await expect(f.use()).rejects.toThrow("63 disconnected"); spy.mockRestore();
    expect(f.box.Count).toBe(2); expect(f.p.info.myHonor).toBe(521); expect((await loadPlayerInfo(h.db, f.p.id))!.myHonor).toBe(521);
    expect((await f.reload()).get(1)!.find(it => it.ItemID === f.box.ItemID)!.Count).toBe(2); expect(hook).toHaveBeenCalledExactlyOnceWith(11917);
    f.sent.length = 0; f.p.propBag.updateItem(f.box); expect(f.sent.filter(pkt => pkt.code === 64)).toHaveLength(1); f.p.questInv = null;
  });
});
