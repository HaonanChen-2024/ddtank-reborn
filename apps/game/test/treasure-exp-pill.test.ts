import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { Templates } from "../src/db/templates.js";
import { consortiaMgr } from "../src/game/consortia-mgr.js";
import { BagType, ItemInfo } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { registerUse } from "../src/handlers/use.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Real committed templates, level table, 183 registry and in-memory SQL only: no native/workshop account.
const now = new Date("2026-10-16T08:00:00Z");
const registry = new HandlerRegistry(); registerUse(registry);
let h: DbHandle, templates: Templates, ctx: ServerContext, sequence = 0;
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods", "LevelInfo"] });
  templates = await new Templates().load(h.db, 1, "zh-CN");
  ctx = { db: h, templates, now: () => now, lang: { t: (key: string) => key },
    world: { all: () => [] }, log: { warn() {}, error() {} } } as unknown as ServerContext;
  await consortiaMgr(ctx); // Await/stop the real optional guild hook rather than leaving unhandled async work.
});
afterAll(async () => {
  if (ctx) (await consortiaMgr(ctx)).stop();
  await h?.close();
});

function makePlayer(info: NonNullable<Awaited<ReturnType<typeof loadPlayerInfo>>>, sent: GSPacket[]) {
  const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "exp-pill-memory" },
    info, defaultMatch(info.ID), 1, "test", grade => templates.levels.get(grade) ?? 0);
  p.gradeForGp = gp => templates.gradeForGp(gp); p.statTables = templates.stats;
  return p;
}
async function fixture(templateId = 11905, count = 1) {
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `treasurePill${++sequence}`,
    NickName: `treasurePill${sequence}`, Grade: 1, GP: 100, IsFirst: 1 }).returning();
  const sent: GSPacket[] = [], p = makePlayer((await loadPlayerInfo(h.db, row!.UserID))!, sent);
  const template = templates.findItem(templateId)!;
  // A01's 11905 count 10/5 is ten/five instances, not one illegal stack: its real MaxCount is 1.
  for (let remaining = count, slot = 0; remaining > 0; remaining -= template.MaxCount, slot++) {
    expect(p.propBag.addItemTo(ItemInfo.createFromTemplate(template, Math.min(remaining, template.MaxCount), 0, now), slot)).toBe(true);
  }
  await p.saveIntoDatabase(h.db); sent.length = 0;
  const rows = () => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id));
  const reload = async () => {
    const loaded = makePlayer((await loadPlayerInfo(h.db, p.id))!, sent);
    const bags = await loadUserItems(h.db, p.id, templates.findItem);
    for (const bag of loaded.allBags()) bag.loadItems(bags.get(bag.bagType) ?? []);
    return loaded;
  };
  return { p, sent, rows, reload };
}
async function use(p: GamePlayer, place: number, bag: number = BagType.PropBag) {
  const packet = new GSPacket(183);
  packet.writeInt(bag); packet.writeInt(place); packet.writeInt(0); packet.writeInt(0); packet.writeBoolean(false);
  await registry.get(183)!.handle(ctx, { player: p } as GameClient, GSPacket.parse(packet.encode()));
  await consortiaMgr(ctx); // Flush the existing async onUseItem hook before SQL inspection/teardown.
}

describe("A01 real 11905 experience pills through 183", () => {
  it("keeps the exact original template and all five previous experience pill templates", () => {
    expect(templates.findItem(11905)).toMatchObject({ CategoryID: 11, Property1: 21, Property2: 20_000, CanDelete: true, MaxCount: 1 });
    for (const [id, gp] of [[11901, 1000], [11902, 2000], [11903, 5000], [11904, 10000], [11906, 100000]]) {
      expect(templates.findItem(id!)).toMatchObject({ Property1: 21, Property2: gp, CanDelete: true });
    }
  });

  it.each([[10, 200_100, 15], [5, 100_100, 13]])("uses the original %i-pill reward once and reloads GP=%i/grade=%i", async (count, gp, grade) => {
    const f = await fixture(11905, count), original = await f.rows();
    expect(original).toHaveLength(count); expect(original.every(row => row.Count === 1 && row.IsExist && row.TemplateID === 11905)).toBe(true);
    const unaffected = { Gold: f.p.info.Gold, Money: f.p.info.Money, GiftToken: f.p.info.GiftToken };
    // Active multiplier must not inflate GP pills: CardUse's AddGP(...,false) uses the exact seed value.
    f.p.buffs.push({ UserID: f.p.id, Type: 13, Value: 2, BeginDate: new Date(), ValidDate: 1440,
      TemplateID: 11901, ValidCount: 0, Data: null, IsExist: true });
    expect(f.p.gpAddPlus).toBe(2);
    for (let slot = 0; slot < count; slot++) {
      await use(f.p, slot);
      expect(f.p.info.GP).toBe(100 + (slot + 1) * 20_000);
      expect(f.p.propBag.getItemAt(slot)).toBeNull();
    }
    expect(f.p.info).toMatchObject({ GP: gp, Grade: grade, ...unaffected });
    expect(f.sent.filter(packet => packet.code === 64)).toHaveLength(count);
    const packets = f.sent.length;
    await Promise.all([use(f.p, 0), use(f.p, count - 1)]);
    expect(f.p.info.GP).toBe(gp); expect(f.sent).toHaveLength(packets);
    await f.p.saveIntoDatabase(h.db);
    const stored = await f.rows();
    expect(stored.map(row => row.ItemID)).toEqual(original.map(row => row.ItemID));
    expect(stored.every(row => !row.IsExist && row.BagType === -1 && row.Place === -1)).toBe(true);
    const loaded = await f.reload();
    expect(loaded.info).toMatchObject({ GP: gp, Grade: grade, ...unaffected });
    expect(loaded.propBag.getItems()).toEqual([]);
    f.sent.length = 0; await use(loaded, 0); await loaded.saveIntoDatabase(h.db);
    expect(loaded.info.GP).toBe(gp); expect(f.sent).toHaveLength(0);
    expect(await f.rows()).toEqual(stored);
    expect((await loadPlayerInfo(h.db, loaded.id))!).toMatchObject({ GP: gp, Grade: grade });
  });

  it("rejects an expired actual instance without GP, removal or persisted mutation", async () => {
    const f = await fixture(), pill = f.p.propBag.getItemAt(0)!;
    pill.IsUsed = true; pill.ValidDate = 1; pill.BeginDate = new Date(now.getTime() - 2 * 86400000);
    f.p.propBag.updateItem(pill); await f.p.saveIntoDatabase(h.db); f.sent.length = 0;
    const before = await f.rows(); expect(pill.isValidItem(now)).toBe(false);
    await use(f.p, 0); await f.p.saveIntoDatabase(h.db);
    expect(f.p.info.GP).toBe(100); expect(f.p.propBag.getItemAt(0)).toBe(pill);
    expect(f.sent).toHaveLength(0); expect(await f.rows()).toEqual(before);
    const loaded = await f.reload();
    expect(loaded.info.GP).toBe(100); expect(loaded.propBag.getItemAt(0)).toMatchObject({ TemplateID: 11905, Count: 1, IsExist: true });
    f.sent.length = 0; // loadItems publishes the existing slot; only the subsequent rejected use must be silent.
    await use(loaded, 0); await loaded.saveIntoDatabase(h.db);
    expect(loaded.info.GP).toBe(100); expect(f.sent).toHaveLength(0); expect(await f.rows()).toEqual(before);
  });

  it("does not create pills or award GP for an absent slot or unknown bag", async () => {
    const f = await fixture(), before = await f.rows();
    await use(f.p, 1); await use(f.p, 0, 999);
    expect(f.p.info.GP).toBe(100); expect(f.sent).toHaveLength(0);
    await f.p.saveIntoDatabase(h.db); expect(await f.rows()).toEqual(before);
    const loaded = await f.reload(); expect(loaded.info.GP).toBe(100);
    expect(loaded.propBag.getItems()).toHaveLength(1);
  });

  it.each([[11901, 1, 1000], [11902, 1, 2000], [11903, 1, 5000], [11904, 1, 10000], [11906, 3, 300000]])(
    "preserves old pill %i, consumes the complete legal stack %i and adds exactly %i GP", async (id, count, gain) => {
      const f = await fixture(id, count), item = f.p.propBag.getItemAt(0)!;
      expect(item.Count).toBe(count); expect(item.Count).toBeLessThanOrEqual(item.template.MaxCount);
      await use(f.p, 0); expect(f.p.info.GP).toBe(100 + gain); expect(f.p.propBag.getItems()).toEqual([]);
      await use(f.p, 0); expect(f.p.info.GP).toBe(100 + gain);
      await f.p.saveIntoDatabase(h.db); const loaded = await f.reload();
      expect(loaded.info.GP).toBe(100 + gain); expect(loaded.propBag.getItems()).toEqual([]);
      expect(await f.rows()).toEqual([expect.objectContaining({ ItemID: item.ItemID, TemplateID: id, IsExist: false, BagType: -1, Place: -1 })]);
    });
});
