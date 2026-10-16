import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, player, seedDatabase, type Database, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import * as itemDb from "../src/db/items.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { Templates } from "../src/db/templates.js";
import { VirtualPlayer } from "../src/bots/bot.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { registerForge } from "../src/handlers/forge.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

const seed = <T>(name: string): T[] => JSON.parse(gunzipSync(readFileSync(new URL(`../../../packages/db/seed/game/${name}.json.gz`, import.meta.url))).toString());
const goods = seed<ItemTemplate>("Shop_Goods");
const config = seed<{ Name: string; Value: string }>("Server_Config");
const begin = new Date("2026-10-16T08:00:00Z");
const tiers = [[11035, 0, 2, 5], [11036, 1, 5, 8], [11026, 2, 8, 11], [11027, 3, 11, 14], [11034, 4, 14, 17]] as const;
afterEach(() => vi.restoreAllMocks());

function route(ctx: ServerContext, p: GamePlayer, values: number[], bodyLength?: number) {
  const packet = new GSPacket(217); values.forEach(value => packet.writeInt(value));
  if (bodyLength !== undefined) {
    const body = new Uint8Array(bodyLength); body.set(packet.body().subarray(0, bodyLength)); packet.setBody(body);
  }
  const registry = new HandlerRegistry(); registerForge(registry);
  return registry.get(217)!.handle(ctx, { player: p } as GameClient, GSPacket.parse(packet.encode()));
}

/** Real registry/player/bags/committed seeds; fake SQL transaction is explicit, with detached saveItem writes. */
function fixture(drillId = 11034, hole = 5, templateId = 70062) {
  const sent: GSPacket[] = [], writes: ItemInfo[] = [];
  const templates = new Templates(); templates.items = new Map(goods.map(item => [item.TemplateID, item]));
  templates.serverConfig = new Map(config.map(row => [row.Name, row.Value]));
  const bot = new VirtualPlayer({ id: 1, nickname: "Drill", sex: true, level: 20, weaponTemplateId: templateId });
  const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "drill-offline" },
    { ...bot.info, ID: 1, UserID: 1, HasBagPassword: false, IsLocked: false, Gold: 5000, Money: 500 }, defaultMatch(1), 1, "test");
  const item = ItemInfo.createFromTemplate(templates.findItem(templateId)!, 1, 0, begin);
  item.Hole1 = 311109; item.AttackCompose = 17; item.IsBinds = false;
  item.Hole5Level = item.Hole6Level = tiers.find(row => row[0] === drillId)?.[1] ?? 0;
  const drill = ItemInfo.createFromTemplate(templates.findItem(drillId)!, 3, 0, begin); drill.IsBinds = false;
  p.storeBag.addItemTo(item, 0); p.propBag.addItemTo(drill, 0); sent.length = 0;
  const tx = {} as Database;
  const transaction = vi.fn(async (work: (db: Database) => Promise<void>) => work(tx));
  vi.spyOn(itemDb, "saveItem").mockImplementation(async (db, staged) => {
    expect(db).toBe(tx); writes.push(staged); staged.ItemID ||= 100 + writes.length; staged.isDirty = false;
  });
  const clock = { time: begin.getTime() }, error = vi.fn();
  const ctx = { templates, zoneId: 1, now: () => new Date(clock.time), lang: { t: (key: string) => key }, db: { db: { transaction } }, log: { error } } as unknown as ServerContext;
  const fields = [0, hole, drillId];
  const send = async (values = fields, bodyLength?: number) => { await route(ctx, p, values, bodyLength); };
  const reply = () => {
    const packet = sent.filter(value => value.code === 217).at(-1);
    expect(packet, "217 reply").toBeDefined(); expect(packet!.clientId).toBe(p.id); expect(packet!.length).toBe(26);
    expect(packet!.readByte()).toBe(0);
    return { upgraded: packet!.readBoolean(), hole: packet!.readInt() };
  };
  return { p, item, drill, sent, templates, transaction, writes, ctx, clock, error, fields, send, reply, tx };
}

describe("A01 drills through the original 217 route", () => {
  it.each([5, 6])("uses the real seed threshold for hole %i instead of the old hard-coded 800", async hole => {
    const f = fixture(11034, hole), random = vi.spyOn(Math, "random").mockReturnValue(0);
    const exp = hole === 5 ? "Hole5Exp" : "Hole6Exp", level = hole === 5 ? "Hole5Level" : "Hole6Level";
    f.item[exp] = 790; await f.send();
    expect(f.item[level]).toBe(4); expect(f.item[exp]).toBe(804); expect(f.drill.Count).toBe(2);
    expect(f.reply()).toEqual({ upgraded: false, hole }); expect(random).toHaveBeenCalledOnce();
    f.clock.time += 100; f.item[exp] = 1186; await f.send();
    expect(f.item[level]).toBe(5); expect(f.item[exp]).toBe(0); expect(f.drill.Count).toBe(1);
    expect(f.reply()).toEqual({ upgraded: true, hole });
  });

  it.each(tiers)("uses exact tier %i at level %i with [%i,%i) experience", async (id, level, min, max) => {
    for (const hole of [5, 6]) {
      const f = fixture(id, hole), random = vi.spyOn(Math, "random").mockReturnValue(0.999999);
      const exp = hole === 5 ? "Hole5Exp" : "Hole6Exp", levelKey = hole === 5 ? "Hole5Level" : "Hole6Level";
      await f.send(); expect(f.item[exp]).toBe(max - 1); expect(f.item[levelKey]).toBe(level);
      expect(f.drill.Count).toBe(2); expect(f.reply()).toEqual({ upgraded: false, hole }); expect(random).toHaveBeenCalled();
      expect(f.item.Hole1).toBe(311109); expect(f.item.AttackCompose).toBe(17); expect(f.p.info.Gold).toBe(5000); expect(f.p.info.Money).toBe(500);
      f.clock.time += 100; random.mockReturnValue(0);
      f.item[exp] = Number(f.templates.serverConfig.get("HoleLevelUpExpList")!.split("|")[level]) - min;
      f.item[hole === 5 ? "Hole5" : "Hole6"] = -1; await f.send();
      expect(f.item[levelKey]).toBe(level + 1); expect(f.item[exp]).toBe(0); expect(f.drill.Count).toBe(1);
      expect(f.item[hole === 5 ? "Hole5" : "Hole6"]).toBe(0); expect(f.reply()).toEqual({ upgraded: true, hole });
      vi.restoreAllMocks();
    }
  });

  it.each([70062, 1101, 5101])("upgrades supported equip %i only once, clears overflow and opens a negative hole", async templateId => {
    const f = fixture(11035, 5, templateId); vi.spyOn(Math, "random").mockReturnValue(0);
    f.item.Hole5 = -1; f.item.Hole5Exp = 1000; await f.send();
    expect(f.item.Hole5Level).toBe(1); expect(f.item.Hole5Exp).toBe(0); expect(f.item.Hole5).toBe(0);
    expect(f.item.Hole6Level).toBe(0); expect(f.item.Hole6Exp).toBe(0); expect(f.reply()).toEqual({ upgraded: true, hole: 5 });
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])("preserves original equip/drill bindings %s/%s (the C# local binding variable was never assigned)", async (itemBound, drillBound) => {
    const f = fixture(); f.item.IsBinds = itemBound; f.drill.IsBinds = drillBound;
    vi.spyOn(Math, "random").mockReturnValue(0); await f.send();
    expect(f.item.IsBinds).toBe(itemBound); expect(f.drill.IsBinds).toBe(drillBound); expect(f.drill.Count).toBe(2);
    expect(f.writes[0]!.IsBinds).toBe(itemBound); expect(f.writes[1]!.IsBinds).toBe(drillBound);
  });

  it("reads configured thresholds and uses the original default only when the complete setting is missing", async () => {
    const configured = fixture(11034); configured.templates.serverConfig.set("HoleLevelUpExpList", "3|6|7|8|20");
    vi.spyOn(Math, "random").mockReturnValue(0); configured.item.Hole5Exp = 6; await configured.send();
    expect(configured.item.Hole5Level).toBe(5); expect(configured.item.Hole5Exp).toBe(0);
    vi.restoreAllMocks();
    const missing = fixture(11034); missing.templates.serverConfig.delete("HoleLevelUpExpList");
    vi.spyOn(Math, "random").mockReturnValue(0); missing.item.Hole5Exp = 786; await missing.send();
    expect(missing.item.Hole5Level).toBe(5); expect(missing.reply().upgraded).toBe(true);
  });

  it.each(["", "400|600|700|800", "400|600|700|800|1200|1", "400|600|700|800|bad", "400|600|700|800|1.5", "400|600|700|800|0", "400|600|700|800|2147483648"])("refuses malformed existing thresholds %s before RNG, consumption or 217 success", async value => {
    const f = fixture(), random = vi.spyOn(Math, "random").mockReturnValue(0); f.templates.serverConfig.set("HoleLevelUpExpList", value);
    const before = [f.item.toRow(), f.drill.toRow()]; await f.send();
    expect([f.item.toRow(), f.drill.toRow()]).toEqual(before); expect(random).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
    expect(f.sent.filter(packet => packet.code === 64 || packet.code === 217)).toHaveLength(0);
  });

  it.each([0, 1, 4, 8, 11, 13, 16])("rejects an actual %i-byte body rather than zero-padding into a valid request", async length => {
    const f = fixture(11035), random = vi.spyOn(Math, "random").mockReturnValue(0); await f.send(f.fields, length);
    expect(f.drill.Count).toBe(3); expect(f.item.Hole5Exp).toBe(0); expect(f.transaction).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled();
    expect(f.sent.filter(packet => packet.code === 217)).toHaveLength(0);
  });

  it("rejects bad identity/state/locked or expired instances and wrong holes without persisting", async () => {
    const cases: ((f: ReturnType<typeof fixture>) => void)[] = [
      f => { f.fields[0] = -1; }, f => { f.fields[0] = 20; }, f => { f.fields[1] = 4; }, f => { f.fields[1] = 7; },
      f => { f.fields[2] = 11035; }, f => { f.item.IsExist = false; }, f => { f.drill.IsExist = false; },
      f => { f.item.Count = 0; }, f => { f.drill.Count = 0; }, f => { f.drill.Place = 1; }, f => { f.item.BagType = 0; },
      f => { f.item.cellLocked = true; }, f => { f.drill.cellLocked = true; },
      f => { f.item.IsUsed = true; f.item.ValidDate = 1; f.item.BeginDate = new Date(begin.getTime() - 2 * 86400000); },
      f => { f.drill.IsUsed = true; f.drill.ValidDate = 1; f.drill.BeginDate = new Date(begin.getTime() - 2 * 86400000); },
      f => { f.item.Hole5Level = -1; }, f => { f.item.Hole5Level = 5; }, f => { f.item.Hole5Exp = -1; },
      f => { f.item.Hole5Exp = 2147483647; }, f => { f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; },
      f => { f.p.currentRoom = { IsPlaying: true } as NonNullable<GamePlayer["currentRoom"]>; },
    ];
    for (const mutate of cases) {
      const f = fixture(); mutate(f); const before = [f.item.toRow(), f.drill.toRow()]; await f.send();
      expect([f.item.toRow(), f.drill.toRow()]).toEqual(before); expect(f.transaction).not.toHaveBeenCalled();
      expect(f.sent.filter(packet => packet.code === 64 || packet.code === 217)).toHaveLength(0); vi.restoreAllMocks();
    }
  });

  it("retains the original non-upgraded reply for a real drill of the wrong tier", async () => {
    const f = fixture(11035); f.item.Hole5Level = 1; const random = vi.spyOn(Math, "random").mockReturnValue(0);
    await f.send(); expect(f.reply()).toEqual({ upgraded: false, hole: 5 }); expect(f.drill.Count).toBe(3);
    expect(random).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
  });

  it.each([NaN, -0.1, 1, Infinity])("rejects invalid random sample %s without consumption", async sample => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(sample); await f.send();
    expect(f.item.Hole5Exp).toBe(0); expect(f.drill.Count).toBe(3); expect(f.transaction).not.toHaveBeenCalled();
    expect(f.sent.filter(packet => packet.code === 64 || packet.code === 217)).toHaveLength(0);
  });

  it("reports a random source exception before any transaction or inventory publication", async () => {
    const f = fixture(); vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("drill random fault"); });
    await f.send(); expect(f.error).toHaveBeenCalledOnce(); expect(f.item.Hole5Exp).toBe(0); expect(f.drill.Count).toBe(3);
    expect(f.transaction).not.toHaveBeenCalled(); expect(f.sent.filter(packet => packet.code === 64 || packet.code === 217)).toHaveLength(0);
  });

  it("keeps the original 100ms throttle and serializes competing packets", async () => {
    const f = fixture(11035); vi.spyOn(Math, "random").mockReturnValue(0);
    await Promise.all([f.send(), f.send()]); expect(f.transaction).toHaveBeenCalledOnce(); expect(f.drill.Count).toBe(2);
    f.clock.time += 99; await f.send(); expect(f.drill.Count).toBe(2);
    f.clock.time++; await f.send(); expect(f.drill.Count).toBe(1); expect(f.item.Hole5Exp).toBe(4);
    expect(f.transaction).toHaveBeenCalledTimes(2);
  });

  it("saves only detached equipment and last-drill tombstone, publishing after COMMIT", async () => {
    const f = fixture(); f.drill.Count = 1; vi.spyOn(Math, "random").mockReturnValue(0);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.transaction.mockImplementationOnce(async work => { await work(f.tx); await gate; });
    const pending = f.send(); await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    expect(f.item.Hole5Exp).toBe(0); expect(f.drill.IsExist).toBe(true); expect(f.sent).toHaveLength(0);
    expect(f.writes[0]).not.toBe(f.item); expect(f.writes[1]).not.toBe(f.drill);
    expect(f.writes[1]).toMatchObject({ IsExist: false, Count: 1, Place: -1, BagType: -1, RemoveType: 0, RemoveDate: begin });
    release(); await pending; expect(f.p.propBag.getItemAt(0)).toBeNull(); expect(f.drill.IsExist).toBe(false);
    expect(f.item.ItemID).toBe(f.writes[0]!.ItemID); expect(f.drill.ItemID).toBe(f.writes[1]!.ItemID);
    expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(2); expect(f.reply().upgraded).toBe(false);
  });

  it("leaves live state intact on a transaction tail fault and can retry after the original throttle", async () => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    const before = [f.item.toRow(), f.drill.toRow()];
    f.transaction.mockImplementationOnce(async work => { await work(f.tx); throw new Error("drill commit fault"); });
    await f.send(); expect([f.item.toRow(), f.drill.toRow()]).toEqual(before); expect(f.error).toHaveBeenCalledOnce();
    expect(f.sent.filter(packet => packet.code === 64 || packet.code === 217)).toHaveLength(0);
    f.clock.time += 100; await f.send(); expect(f.item.Hole5Exp).toBe(14); expect(f.drill.Count).toBe(2); expect(f.reply().upgraded).toBe(false);
  });

  it("rereads the actual slot and configuration after a previous save lock releases", async () => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    let release!: () => void; const earlier = f.p.withPersistenceLock(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve(); const pending = f.send();
    const replacement = ItemInfo.createFromTemplate(f.item.template, 1, 0, begin); replacement.Hole5Level = 4; replacement.Hole5Exp = 6;
    expect(f.p.storeBag.takeOutItem(f.item)).toBe(true); expect(f.p.storeBag.addItemTo(replacement, 0)).toBe(true);
    f.templates.serverConfig.set("HoleLevelUpExpList", "3|6|7|8|20"); f.sent.length = 0;
    release(); await earlier; await pending;
    expect(f.item.Hole5Level).toBe(4); expect(f.item.Hole5Exp).toBe(0); expect(replacement.Hole5Level).toBe(5); expect(replacement.Hole5Exp).toBe(0);
  });

  it("rereads expiry and time under the save lock before consuming", async () => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    let release!: () => void; const earlier = f.p.withPersistenceLock(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve(); const pending = f.send(); f.drill.IsUsed = true; f.drill.ValidDate = 1; f.drill.BeginDate = begin;
    f.clock.time += 2 * 86400000; release(); await earlier; await pending;
    expect(f.drill.Count).toBe(3); expect(f.transaction).not.toHaveBeenCalled(); expect(f.sent.filter(packet => packet.code === 217)).toHaveLength(0);
  });

  it("keeps committed state and releases every bag batch when publication throws", async () => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    const send = vi.spyOn(f.p, "send").mockImplementation(() => { throw new Error("drill disconnected sink"); });
    await expect(f.send()).rejects.toThrow("drill disconnected sink"); expect(f.transaction).toHaveBeenCalledOnce();
    expect(f.item.Hole5Exp).toBe(14); expect(f.drill.Count).toBe(2); expect(send).toHaveBeenCalledTimes(2);
    send.mockRestore(); f.sent.length = 0; f.p.storeBag.updateItem(f.item); f.p.propBag.updateItem(f.drill);
    expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(2);
  });
});

describe("217 real isolated in-memory SQL persistence", () => {
  let h: DbHandle, templates: Templates, sequence = 0;
  beforeAll(async () => {
    h = await createDb("pglite:memory"); await migrateDb(h); await seedDatabase(h, { only: ["Shop_Goods", "Server_Config"] });
    templates = await new Templates().load(h.db, 1, "zh-CN"); await templates.loadForge(h.db);
  });
  afterAll(async () => { await h?.close(); });
  async function durable(count = 2) {
    const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `drill${++sequence}`, NickName: `drill${sequence}`, Grade: 20, IsFirst: 1 }).returning();
    const info = (await loadPlayerInfo(h.db, row!.UserID))!, sent: GSPacket[] = [];
    const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "drill-memory" }, info, defaultMatch(info.ID), 1, "test");
    p.statTables = templates.stats;
    const item = ItemInfo.createFromTemplate(templates.findItem(70062)!, 1, 0, begin), drill = ItemInfo.createFromTemplate(templates.findItem(11034)!, count, 0, begin);
    item.Hole5Level = 4; item.Hole5Exp = 1186; item.Hole5 = -1; item.Hole1 = 311109; item.AttackCompose = 17;
    p.storeBag.addItemTo(item, 0); p.propBag.addItemTo(drill, 0); await p.saveIntoDatabase(h.db); sent.length = 0;
    const clock = { time: begin.getTime() }, ctx = { db: h, templates, now: () => new Date(clock.time), lang: { t: (key: string) => key }, log: { error() {} } } as unknown as ServerContext;
    const send = async () => { await route(ctx, p, [0, 5, 11034]); };
    const rows = () => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id));
    const reload = () => itemDb.loadUserItems(h.db, p.id, templates.findItem);
    return { p, item, drill, sent, ctx, clock, send, rows, reload };
  }

  it("commits real hole progress and one drill together, then reloads the exact fields", async () => {
    const f = await durable(); vi.spyOn(Math, "random").mockReturnValue(0); await f.send();
    const bags = await f.reload(), equip = bags.get(12)!.find(item => item.Place === 0)!;
    expect(equip).toMatchObject({ Hole5Level: 5, Hole5Exp: 0, Hole5: 0, Hole1: 311109, AttackCompose: 17 });
    expect(bags.get(1)!.find(item => item.TemplateID === 11034)!.Count).toBe(1);
    expect(equip.TemplateID).toBe(70062); expect(f.sent.filter(packet => packet.code === 217)).toHaveLength(1);
  });

  it("persists the last drill tombstone and unchanged binding without an autosave", async () => {
    const f = await durable(1); f.item.IsBinds = false; f.drill.IsBinds = true;
    vi.spyOn(Math, "random").mockReturnValue(0); await f.send();
    expect((await f.reload()).get(1) ?? []).toHaveLength(0);
    const rows = await f.rows(); expect(rows.find(row => row.TemplateID === 11034)!).toMatchObject({ IsExist: false, IsBinds: true });
    expect(rows.find(row => row.TemplateID === 70062)!).toMatchObject({ IsBinds: false, Hole5Level: 5, Hole5Exp: 0 });
  });

  it("rolls back both actual SQL writes on COMMIT failure, then retries without duplicate consumption", async () => {
    const f = await durable(), before = await f.rows(), equip = f.item.toRow(), drill = f.drill.toRow();
    vi.spyOn(Math, "random").mockReturnValue(0); const transaction = h.db.transaction.bind(h.db);
    const spy = vi.spyOn(h.db, "transaction").mockImplementationOnce(fn => transaction(async tx => { await fn(tx); throw new Error("217 actual commit failure"); }));
    try { await f.send(); } finally { spy.mockRestore(); }
    expect(await f.rows()).toEqual(before); expect(f.item.toRow()).toEqual(equip); expect(f.drill.toRow()).toEqual(drill);
    expect(f.sent.filter(packet => packet.code === 64 || packet.code === 217)).toHaveLength(0);
    f.clock.time += 100; await f.send(); const bags = await f.reload();
    expect(bags.get(12)![0]!.Hole5Level).toBe(5); expect(bags.get(1)![0]!.Count).toBe(1);
  });
});
