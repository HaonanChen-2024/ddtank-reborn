import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GSPacket } from "@ddt/protocol";
import type { Database } from "@ddt/db";
import { saveItem } from "../src/db/items.js";
import { VirtualPlayer } from "../src/bots/bot.js";
import { Templates } from "../src/db/templates.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { emptyStatTables, type GoldEquipRow } from "../src/game/stats.js";
import { registerForge } from "../src/handlers/forge.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { ServerContext } from "../src/session/context.js";
import type { GameClient } from "../src/session/client.js";

vi.mock("../src/db/items.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/db/items.js")>(), saveItem: vi.fn(),
}));

const seed = <T>(name: string): T[] => JSON.parse(gunzipSync(readFileSync(new URL(`../../../packages/db/seed/game/${name}.json.gz`, import.meta.url))).toString());
const goods = seed<ItemTemplate>("Shop_Goods");
const golds = seed<GoldEquipRow>("GoldEquipTemplateLoad");
const now = new Date("2026-10-16T08:00:00Z");
afterEach(() => vi.restoreAllMocks());

/** Actual registry/GamePlayer/bags and committed seed data; detached writes use a fake transaction, not a real DB. */
function fixture(templateId = 70062, beadId = 11560, zoneId = 1) {
  const sent: GSPacket[] = [];
  const templates = new Templates();
  templates.items = new Map(goods.map(t => [t.TemplateID, t]));
  templates.stats = { ...emptyStatTables(templates.findItem), goldEquip: (id, cat) => golds.find(g => g.OldTemplateId === id) ?? golds.find(g => g.OldTemplateId === -1 && g.CategoryID === cat) };
  const bot = new VirtualPlayer({ id: 1, nickname: "WishBead", sex: true, level: 20, weaponTemplateId: templateId });
  const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "wishbead-offline" },
    { ...bot.info, ID: 1, UserID: 1, HasBagPassword: false, IsLocked: false, Gold: 5000, Money: 500 }, defaultMatch(1), zoneId, "test");
  p.statTables = templates.stats;
  const item = ItemInfo.createFromTemplate(templates.findItem(templateId)!, 1, 0, now);
  item.Place = 31; item.StrengthenLevel = 12; item.Hole1 = 311109; item.AttackCompose = 17; item.IsBinds = false;
  const bead = ItemInfo.createFromTemplate(templates.findItem(beadId)!, 3, 0, now); bead.Place = 0;
  p.equipBag.loadItems([item]); p.propBag.loadItems([bead]); sent.length = 0;
  const writes: ItemInfo[] = [], tx = {} as Database;
  const transaction = vi.fn(async (work: (db: Database) => Promise<void>) => work(tx));
  vi.mocked(saveItem).mockImplementation(async (db, staged) => {
    expect(db).toBe(tx); writes.push(staged); staged.ItemID ||= 100 + writes.length; staged.isDirty = false;
  });
  const error = vi.fn();
  const ctx = { templates, zoneId, now: () => new Date(now), lang: { t: (key: string) => key }, db: { db: { transaction } }, log: { error } } as unknown as ServerContext;
  const registry = new HandlerRegistry(); registerForge(registry);
  const fields = [31, 0, templateId, 0, 1, beadId];
  const send = async (values = fields, bodyLength?: number) => {
    const packet = new GSPacket(106); values.forEach(v => packet.writeInt(v));
    if (bodyLength != null) { const body = new Uint8Array(bodyLength); body.set(packet.body().subarray(0, bodyLength)); packet.setBody(body); }
    expect(await registry.get(106)!.handle(ctx, { player: p } as GameClient, GSPacket.parse(packet.encode()))).toBeUndefined();
  };
  const result = () => {
    const packet = sent.filter(packet => packet.code === 106).at(-1);
    expect(packet, "106 reply").toBeDefined(); expect(packet!.length).toBe(24); expect(packet!.clientId).toBe(p.id);
    return packet!.readInt();
  };
  return { p, ctx, templates, registry, item, bead, sent, fields, send, result, transaction, writes, error, tx };
}

describe("106 WISHBEADEQUIP original six-int route", () => {
  it.each([[70062, 11560], [5101, 11561], [1101, 11562]])("plates actual %i using its matching %i and consumes one bead", async (id, beadId) => {
    const f = fixture(id, beadId); vi.spyOn(Math, "random").mockReturnValue(0);
    await f.send();
    expect(f.result()).toBe(0); expect(f.bead.Count).toBe(2);
    expect(f.p.equipBag.getItemAt(31)).toBe(f.item);
    expect(f.item.TemplateID).toBe(id); expect(f.item.IsBinds).toBe(true); expect(f.item.isGold).toBe(true);
    expect(f.item.goldBeginTime).toEqual(now); expect(f.item.goldValidDate).toBe(3); expect(f.item.isDirty).toBe(true);
    expect(f.item.Hole1).toBe(311109); expect(f.item.StrengthenLevel).toBe(12); expect(f.item.AttackCompose).toBe(17);
    expect(f.p.info.Gold).toBe(5000); expect(f.p.info.Money).toBe(500);
    if (id === 70062) expect(f.item.goldTemplate?.TemplateID).toBe(70063);
    if (id === 70062) f.fields[2] = 70063; // actual displayed gold ID is also a server-derived identity
    await f.send(); expect(f.result()).toBe(6); expect(f.bead.Count).toBe(2);
    f.fields[2] = 70073; await f.send(); expect(f.result()).toBe(5); expect(f.bead.Count).toBe(2);
  });

  it.each([[1001, 49, 0], [1001, 50, 1], [1002, 39, 0], [1002, 40, 1], [1, 7, 0], [1, 8, 1]])("retains zone %i roll %i -> status %i with denominator1000", async (zoneId, roll, result) => {
    const f = fixture(70062, 11560, zoneId); f.templates.serverConfig.set("WishBeadRate", "1");
    const random = vi.spyOn(Math, "random").mockReturnValue(roll / 1000);
    await f.send(); expect(f.result()).toBe(result); expect(f.bead.Count).toBe(2); expect(random).toHaveBeenCalledTimes(1);
    expect(f.item.isGold).toBe(result === 0); expect(f.item.IsBinds).toBe(true);
  });

  it("does not consume, bind or roll on forged IDs, empty/invalid bags, same slot, mismatched or expired items", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const cases: ((f: ReturnType<typeof fixture>) => void)[] = [
      f => { f.fields[2] = 70063; }, f => { f.fields[5] = 11561; }, f => { f.fields[0] = 32; },
      f => { f.fields[1] = -1; }, f => { f.fields[4] = -1; },
      f => { f.fields[3] = 31; f.fields[4] = 0; f.fields[5] = 70062; },
      f => { f.item.IsUsed = true; f.item.ValidDate = 1; f.item.BeginDate = new Date(now.getTime() - 2 * 86400000); },
      f => { f.bead.IsUsed = true; f.bead.ValidDate = 1; f.bead.BeginDate = new Date(now.getTime() - 2 * 86400000); },
      f => { f.item.Count = 0; }, f => { f.bead.Count = 0; },
      f => { f.item.cellLocked = true; }, f => { f.bead.cellLocked = true; },
      f => { f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; },
    ];
    for (const mutate of cases) {
      const f = fixture(); mutate(f); const count = f.bead.Count; await f.send();
      expect(f.result()).toBe(5); expect(f.bead.Count).toBe(count); expect(f.item.IsBinds).toBe(false); expect(f.item.isGold).toBe(false);
    }
    const mismatch = fixture(5101, 11560); await mismatch.send(); expect(mismatch.result()).toBe(5); expect(mismatch.bead.Count).toBe(3);
    expect(random).not.toHaveBeenCalled();
  });

  it.each([0, 1, 4, 8, 12, 16, 20, 23, 25, 28])("rejects a %i-byte body before zero-padded overreads or extra fields can mutate inventory", async length => {
    const f = fixture(); const random = vi.spyOn(Math, "random").mockReturnValue(0);
    await f.send(f.fields, length); expect(f.result()).toBe(5); expect(f.bead.Count).toBe(3); expect(f.item.IsBinds).toBe(false); expect(random).not.toHaveBeenCalled();
  });

  it("requires an exact weapon mapping and an existing distinct category7 target", async () => {
    for (const mode of ["missing", "fallback", "missing-target", "same-target", "wrong-category"] as const) {
      const f = fixture(); const row = f.templates.stats.goldEquip(f.item.TemplateID, 7)!;
      if (mode === "missing") f.templates.stats.goldEquip = () => undefined;
      if (mode === "fallback") f.templates.stats.goldEquip = () => ({ ...row, OldTemplateId: -1 });
      if (mode === "missing-target") f.templates.items.delete(row.NewTemplateId);
      if (mode === "same-target") f.templates.stats.goldEquip = () => ({ ...row, NewTemplateId: f.item.TemplateID });
      if (mode === "wrong-category") f.templates.stats.goldEquip = () => ({ ...row, NewTemplateId: 1101 });
      await f.send(); expect(f.result()).toBe(5); expect(f.bead.Count).toBe(3); expect(f.item.IsBinds).toBe(false);
    }
  });

  it("uses the original upper-limit switch and allows the default unbounded/lower-level case", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const blocked = fixture(); blocked.templates.serverConfig.set("IsWishBeadLimit", "True"); blocked.templates.serverConfig.set("WishBeadLimitLv", "12"); blocked.item.StrengthenLevel = 13;
    await blocked.send(); expect(blocked.result()).toBe(5); expect(blocked.bead.Count).toBe(3); expect(blocked.item.IsBinds).toBe(false);
    const boundary = fixture(); boundary.templates.serverConfig.set("IsWishBeadLimit", "true"); await boundary.send(); expect(boundary.result()).toBe(0);
    const disabled = fixture(); disabled.item.StrengthenLevel = 13; await disabled.send(); expect(disabled.result()).toBe(0);
    const low = fixture(); low.item.StrengthenLevel = 0; await low.send(); expect(low.result()).toBe(0);
  });

  it("can replate an expired gold period and modifies in place even when both inventories are full", async () => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    f.item.isGold = true; f.item.goldValidDate = 3; f.item.goldBeginTime = new Date(now.getTime() - 3 * 86400000);
    for (const bag of [f.p.equipBag, f.p.propBag]) {
      for (let slot = bag.beginSlot; slot < bag.capacity; slot++) if (!bag.getItemAt(slot)) {
        const fill = ItemInfo.createFromTemplate(f.templates.findItem(1101)!, 1, 0, now); expect(bag.addItemTo(fill, slot)).toBe(true);
      }
      expect(bag.findFirstEmptySlot(bag.beginSlot)).toBe(-1);
    }
    f.sent.length = 0; await f.send(); expect(f.result()).toBe(0); expect(f.item.goldBeginTime).toEqual(now); expect(f.bead.Count).toBe(2);
  });

  it("saves only the detached equipment and last-bead tombstone before publishing inventory", async () => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(0); f.bead.Count = 1;
    let release!: () => void;
    const committing = new Promise<void>(resolve => { release = resolve; });
    f.transaction.mockImplementationOnce(async work => { await work(f.tx); await committing; });
    const pending = f.send();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    expect(f.sent).toHaveLength(0); expect(f.item.IsBinds).toBe(false); expect(f.item.ItemID).toBe(0); expect(f.bead.IsExist).toBe(true);
    expect(f.writes[0]).not.toBe(f.item); expect(f.writes[1]).not.toBe(f.bead);
    expect(f.writes[1]).toMatchObject({ IsExist: false, Place: -1, BagType: -1, Count: 1, RemoveType: 0, RemoveDate: now });
    release(); await pending;
    expect(f.result()).toBe(0); expect(f.p.propBag.getItemAt(0)).toBeNull(); expect(f.bead.IsExist).toBe(false);
    expect(f.item.ItemID).toBe(f.writes[0]!.ItemID); expect(f.bead.ItemID).toBe(f.writes[1]!.ItemID);
    expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(2);
  });

  it.each([0, 0.9])("leaves live state, bead and previous gold period untouched on COMMIT failure (roll %s)", async roll => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(roll);
    f.item.isGold = true; f.item.goldValidDate = 3; f.item.goldBeginTime = new Date(now.getTime() - 4 * 86400000);
    f.item.goldTemplate = f.templates.findItem(70063)!;
    const beforeItem = f.item.toRow(), beforeBead = f.bead.toRow();
    f.transaction.mockImplementationOnce(async work => { await work(f.tx); throw new Error("injected COMMIT failure"); });
    await f.send();
    expect(f.result()).toBe(5); expect(f.error).toHaveBeenCalledOnce();
    expect(f.item.toRow()).toEqual(beforeItem); expect(f.bead.toRow()).toEqual(beforeBead);
    expect(f.item.ItemID).toBe(0); expect(f.bead.ItemID).toBe(0); expect(f.item.IsBinds).toBe(false);
    expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(0);
  });

  it("rereads the actual slot after an earlier save lock replaces its item", async () => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    let release!: () => void;
    const earlier = f.p.withPersistenceLock(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve(); const pending = f.send();
    const replacement = ItemInfo.createFromTemplate(f.item.template, 1, 0, now); replacement.ItemID = 501;
    expect(f.p.equipBag.takeOutItem(f.item)).toBe(true); expect(f.p.equipBag.addItemTo(replacement, 31)).toBe(true); f.sent.length = 0;
    release(); await earlier; await pending;
    expect(f.result()).toBe(0); expect(f.item.IsBinds).toBe(false); expect(f.item.isGold).toBe(false);
    expect(replacement.isGold).toBe(true); expect(f.writes[0]!.ItemID).toBe(501); expect(f.bead.Count).toBe(2);
  });

  it.each(["expired-equipment", "already-gold", "mapping-removed", "playing-room"] as const)("rereads %s after waiting for the persistence lock", async change => {
    const f = fixture(); const random = vi.spyOn(Math, "random").mockReturnValue(0);
    let release!: () => void;
    const earlier = f.p.withPersistenceLock(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve(); const pending = f.send();
    if (change === "expired-equipment") {
      f.item.IsUsed = true; f.item.ValidDate = 1; f.item.BeginDate = now;
      f.ctx.now = () => new Date(now.getTime() + 2 * 86400000);
    } else if (change === "already-gold") { f.item.goldBeginTime = now; f.item.goldValidDate = 3; }
    else if (change === "mapping-removed") f.templates.stats.goldEquip = () => undefined;
    else f.p.currentRoom = { IsPlaying: true } as NonNullable<GamePlayer["currentRoom"]>;
    release(); await earlier; await pending;
    expect(f.result()).toBe(change === "already-gold" ? 6 : 5); expect(f.bead.Count).toBe(3);
    expect(random).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled(); expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(0);
  });

  it("does not undo a committed attempt or emit a rejection when later client publication fails", async () => {
    const f = fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    const send = vi.spyOn(f.p, "send").mockImplementation(() => { throw new Error("injected disconnected sink"); });
    await expect(f.send()).rejects.toThrow("injected disconnected sink");
    expect(f.transaction).toHaveBeenCalledOnce(); expect(f.writes).toHaveLength(2);
    expect(f.item.isGold).toBe(true); expect(f.item.IsBinds).toBe(true); expect(f.bead.Count).toBe(2);
    expect(f.error).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2); // Both begun bags still leave their change batches.
    send.mockRestore(); f.p.propBag.updateItem(f.bead);
    expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(1);
  });

  it.each([3, 4, 5])("does not persist temporary bag %i equipment or beads through forged 106 fields", async bagType => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    for (const moveEquipment of [true, false]) {
      const f = fixture(), bag = f.p.getInventory(bagType)!;
      const item = moveEquipment ? f.item : f.bead, source = moveEquipment ? f.p.equipBag : f.p.propBag;
      expect(source.takeOutItem(item)).toBe(true); expect(bag.addItemTo(item, 0)).toBe(true);
      if (moveEquipment) { f.fields[0] = 0; f.fields[1] = bagType; }
      else f.fields[4] = bagType;
      f.sent.length = 0; await f.send();
      expect(f.result()).toBe(5); expect(f.item.IsBinds).toBe(false); expect(f.bead.Count).toBe(3);
      expect(f.transaction).not.toHaveBeenCalled(); expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(0);
    }
    expect(random).not.toHaveBeenCalled();
  });
});
