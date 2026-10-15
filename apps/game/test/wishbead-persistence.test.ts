import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { Templates } from "../src/db/templates.js";
import { ItemInfo } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { wishBead } from "../src/handlers/forge.js";
import type { ServerContext } from "../src/session/context.js";

let h: DbHandle, templates: Templates, seq = 0;
const begin = new Date("2026-10-16T08:00:00Z");
beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods", "GoldEquipTemplateLoad"] });
  templates = await new Templates().load(h.db, 1, "zh-CN");
  await templates.loadForge(h.db);
});
afterAll(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await h.close(); });

async function fixture(beadCount = 2) {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(begin);
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `wish${++seq}`, NickName: `wish${seq}`, Grade: 20, IsFirst: 1 }).returning();
  const info = (await loadPlayerInfo(h.db, row!.UserID))!;
  const sent: GSPacket[] = [];
  const makePlayer = () => {
    const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "wishbead-memory" },
      { ...info }, defaultMatch(info.ID), 1, "test");
    p.statTables = templates.stats;
    return p;
  };
  const p = makePlayer();
  const item = ItemInfo.createFromTemplate(templates.findItem(70062)!, 1, 0, begin); item.StrengthenLevel = 12;
  p.equipBag.addItemTo(item, 6);
  const bead = ItemInfo.createFromTemplate(templates.findItem(11560)!, beadCount, 0, begin);
  p.propBag.addItemTo(bead, 0);
  await p.saveIntoDatabase(h.db); sent.length = 0;
  const ctx = { db: h, templates, zoneId: 1, now: () => new Date(), lang: { t: (key: string) => key }, log: { error() {} } } as unknown as ServerContext;
  const use = async (roll: number) => {
    const packet = new GSPacket(106);
    [6, 0, item.displayTemplateId(), 0, 1, 11560].forEach(n => packet.writeInt(n)); packet.offset = 20;
    await wishBead(ctx, p, packet, () => roll);
  };
  const reload = async () => {
    const bags = await loadUserItems(h.db, p.id, templates.findItem, templates.findGoldTemplate);
    const copy = makePlayer(); copy.equipBag.loadItems(bags.get(0) ?? []); copy.propBag.loadItems(bags.get(1) ?? []); copy.recalcStats();
    return copy;
  };
  const rows = () => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id));
  return { p, item, bead, sent, ctx, use, reload, rows };
}

describe("wish-bead durable base identity and expiry (isolated in-memory database)", () => {
  it("saves and reloads the exact gold mapping, spent bead, holes and composition, then restores base stats at expiry", async () => {
    const f = await fixture(); f.item.Hole1 = 311109; f.item.AttackCompose = 7;
    await f.use(0);
    const stored = (await f.rows()).find(r => r.ItemID === f.item.ItemID)!;
    expect(stored.TemplateID).toBe(70062); expect(stored.isGold).toBe(true); expect(stored.goldValidDate).toBe(3);
    expect(stored.goldBeginTime).toEqual(begin); expect(stored.Hole1).toBe(311109); expect(stored.AttackCompose).toBe(7);
    const copy = await f.reload(), loaded = copy.mainWeapon!;
    expect(loaded.displayTemplateId()).toBe(70063); expect(copy.info.Attack).toBe(495);
    expect(copy.propBag.getItemCount(11560)).toBe(1); expect(copy.info.Nimbus).toBe(5);
    const end = new Date(begin.getTime() + 3 * 86_400_000);
    vi.setSystemTime(end); f.sent.length = 0; copy.recalcStats();
    expect(loaded.TemplateID).toBe(70062); expect(loaded.displayTemplateId()).toBe(70062);
    expect(copy.info.Attack).toBe(397); expect(copy.info.Nimbus).toBe(3);
    expect(copy.info.Style).toContain("70062|bombpack3");
    const grids = f.sent.filter(packet => packet.code === 64);
    expect(grids.length).toBeGreaterThan(0);
    const count = grids.length; copy.recalcStats(); expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(count);
    await copy.saveIntoDatabase(h.db);
    const expired = (await f.rows()).find(r => r.ItemID === loaded.ItemID)!;
    expect(expired.TemplateID).toBe(70062); expect(expired.isGold).toBe(false);
    expect((await f.reload()).mainWeapon!.displayTemplateId()).toBe(70062);
  });

  it("persists the consumed last bead and binding on an ordinary unsuccessful attempt", async () => {
    const f = await fixture(1); await f.use(0.999);
    const copy = await f.reload();
    expect(copy.mainWeapon!.IsBinds).toBe(true); expect(copy.mainWeapon!.isValidGoldItem()).toBe(false);
    expect(copy.propBag.getItemCount(11560)).toBe(0);
    const rows = await f.rows();
    expect(rows.find(r => r.TemplateID === 11560)!.IsExist).toBe(false);
    expect(rows.find(r => r.TemplateID === 70062)!.TemplateID).toBe(70062);
  });

  it("rolls back both real SQL writes when commit fails, publishing no inventory changes", async () => {
    const f = await fixture();
    const beforeRows = await f.rows(), beforeItem = f.item.toRow(), beforeBead = f.bead.toRow();
    const transaction = h.db.transaction.bind(h.db);
    const spy = vi.spyOn(h.db, "transaction").mockImplementationOnce(fn => transaction(async tx => {
      await fn(tx);
      throw new Error("wish-bead commit fault");
    }));
    try { await f.use(0); } finally { spy.mockRestore(); }
    expect(await f.rows()).toEqual(beforeRows);
    expect(f.item.toRow()).toEqual(beforeItem); expect(f.bead.toRow()).toEqual(beforeBead);
    expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(0);
    const response = f.sent.find(packet => packet.code === 106)!;
    expect(response.readInt()).toBe(5);
    await f.use(0);
    expect((await f.reload()).mainWeapon!.displayTemplateId()).toBe(70063);
    expect((await f.reload()).propBag.getItemCount(11560)).toBe(1);
  });

  it("keeps committed results after a sink failure and releases both inventory batches", async () => {
    const f = await fixture(), send = f.p.sink.send.bind(f.p.sink);
    let fail = true;
    const spy = vi.spyOn(f.p.sink, "send").mockImplementation(packet => {
      if (packet.code === 64 && fail) { fail = false; throw new Error("wish-bead sink fault"); }
      send(packet);
    });
    try { await expect(f.use(0)).rejects.toThrow("wish-bead sink fault"); } finally { spy.mockRestore(); }
    const copy = await f.reload();
    expect(copy.mainWeapon!.displayTemplateId()).toBe(70063); expect(copy.propBag.getItemCount(11560)).toBe(1);
    f.sent.length = 0;
    f.p.propBag.updateItem(f.bead);
    expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(1);
    await f.use(0);
    expect(f.sent.filter(packet => packet.code === 106).at(-1)!.readInt()).toBe(6);
    expect((await f.reload()).propBag.getItemCount(11560)).toBe(1);
  });
});
