import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, game, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { ItemInfo, BagType, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { changeItemPlace, registerItems } from "../src/handlers/items.js";
import { lotteryFinish } from "../src/handlers/activities.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Only a fresh in-memory database; no workshop account, native DB or browser is used.
let h: DbHandle, template: ItemTemplate, seq = 0;
beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods"] });
  template = (await h.db.select().from(game.Shop_Goods).where(eq(game.Shop_Goods.TemplateID, 10018)))[0]!;
  expect(template).toBeDefined();
});
afterAll(async () => { await h.close(); });

async function fixture() {
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `consumption${++seq}`, NickName: `consumption${seq}`, Grade: 8, IsFirst: 1 }).returning();
  const info = (await loadPlayerInfo(h.db, row!.UserID))!;
  const p = new GamePlayer({ send: () => {}, disconnect: () => {}, remoteAddress: "test" }, info, defaultMatch(info.ID), 1, "test");
  const ctx = { db: h, lang: { t: (key: string) => key } } as unknown as ServerContext;
  return { p, ctx };
}
const rows = (id: number) => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, id));
const item = (count = 1) => ItemInfo.createFromTemplate(template, count, 0);
async function takeTemp(p: GamePlayer, ctx: ServerContext, place: number) {
  const registry = new HandlerRegistry(); registerItems(registry);
  const pkt = new GSPacket(108); pkt.writeInt(place); pkt.offset = 20;
  await registry.get(108)!.handle(ctx, { player: p } as GameClient, pkt);
}

describe("persisted consumables passing through an unsaved FightBag", () => {
  it.each([false, true])("removes both loaded units, with intermediate save=%s", async (intermediateSave) => {
    const { p, ctx } = await fixture(), original = item(2), untouched = item(7);
    p.propBag.addItemTo(original, 13); p.propBag.addItemTo(untouched, 14);
    await p.saveIntoDatabase(h.db);
    const before = (await rows(p.id)).find((r) => r.ItemID === untouched.ItemID)!;
    changeItemPlace(ctx, p, BagType.PropBag, 13, BagType.FightBag, 0, 1);
    changeItemPlace(ctx, p, BagType.PropBag, 13, BagType.FightBag, 1, 1);
    const split = p.fightBag.getItemAt(0)!;
    expect(split.ItemID).toBe(0);
    expect(p.fightBag.getItemAt(1)).toBe(original);
    if (intermediateSave) {
      await p.saveIntoDatabase(h.db);
      expect(p.propBag.removed).toEqual([]);
      expect((await rows(p.id)).find((r) => r.ItemID === original.ItemID)).toMatchObject({ IsExist: true, BagType: 3, Place: 1, Count: 1 });
    }
    // DdtGame.usePropItem delegates accepted 10018 consumption to this owner.
    expect(p.fightBag.removeItem(split)).toBe(true);
    expect(p.fightBag.removeItem(original)).toBe(true);
    await p.saveIntoDatabase(h.db);
    const stored = await rows(p.id);
    expect(stored).toHaveLength(2); // the unsaved split must not become a DB row
    expect(stored.find((r) => r.ItemID === original.ItemID)).toMatchObject({ IsExist: false, BagType: -1, Place: -1, Count: 1 });
    expect(stored.find((r) => r.ItemID === untouched.ItemID)).toEqual(before);
    expect(p.fightBag.removed).toEqual([]);
    expect(split.ItemID).toBe(0);
  });

  it("keeps an unused moved item alive when it returns after an intermediate save", async () => {
    const { p, ctx } = await fixture(), original = item();
    p.propBag.addItemTo(original, 13); await p.saveIntoDatabase(h.db);
    changeItemPlace(ctx, p, 1, 13, 3, 0, 1); await p.saveIntoDatabase(h.db);
    changeItemPlace(ctx, p, 3, 0, 1, 13, 1); await p.saveIntoDatabase(h.db);
    expect(await rows(p.id)).toEqual([expect.objectContaining({ ItemID: original.ItemID, IsExist: true, BagType: 1, Place: 13, Count: 1 })]);
  });

  it("retries a failed tombstone update without clearing the queue or inserting a new item", async () => {
    const { p, ctx } = await fixture(), original = item();
    p.propBag.addItemTo(original, 13); await p.saveIntoDatabase(h.db);
    changeItemPlace(ctx, p, 1, 13, 3, 0, 1); await p.saveIntoDatabase(h.db);
    expect(p.propBag.removed).toEqual([]);
    p.fightBag.removeItem(original);
    await h.db.execute(sql`CREATE FUNCTION player.inventory_consumption_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test tombstone update failure'; END $$`);
    await h.db.execute(sql`CREATE TRIGGER test_consumption_failure BEFORE UPDATE ON player."Sys_Users_Goods" FOR EACH ROW EXECUTE FUNCTION player.inventory_consumption_failure()`);
    try {
      await expect(p.saveIntoDatabase(h.db)).rejects.toThrow();
      expect(p.fightBag.removed).toEqual([original]);
      expect(original.isDirty).toBe(true);
      expect(await rows(p.id)).toEqual([expect.objectContaining({ ItemID: original.ItemID, IsExist: true, BagType: 3, Place: 0 })]);
    } finally {
      await h.db.execute(sql`DROP TRIGGER test_consumption_failure ON player."Sys_Users_Goods"`);
      await h.db.execute(sql`DROP FUNCTION player.inventory_consumption_failure()`);
    }
    const id = original.ItemID;
    await p.saveIntoDatabase(h.db);
    expect(await rows(p.id)).toEqual([expect.objectContaining({ ItemID: id, IsExist: false, BagType: -1, Place: -1 })]);
    expect(p.fightBag.removed).toEqual([]);
    expect(original.ItemID).toBe(id);
  });

  it("never saves fresh FightBag items, whether unused or consumed", async () => {
    const { p } = await fixture(), consumed = item(), unused = item();
    p.fightBag.addItemTo(consumed, 0); p.fightBag.addItemTo(unused, 1);
    await p.saveIntoDatabase(h.db);
    expect(p.fightBag.removeItem(consumed)).toBe(true);
    expect(consumed.IsExist).toBe(false);
    expect(p.fightBag.removeItem(consumed)).toBe(false);
    await p.saveIntoDatabase(h.db);
    expect(await rows(p.id)).toEqual([]);
    expect(p.fightBag.getItemAt(1)).toBe(unused);
    expect(unused.IsExist).toBe(true);
    expect([consumed.ItemID, unused.ItemID]).toEqual([0, 0]);
  });

  it("retains ordinary persisted bag deletion and rejects removal from the wrong bag", async () => {
    const { p } = await fixture(), original = item();
    p.propBag.addItemTo(original, 0); await p.saveIntoDatabase(h.db);
    expect(p.fightBag.removeItem(original)).toBe(false);
    expect(original.IsExist).toBe(true);
    expect(p.propBag.removeItem(original, 9)).toBe(true);
    await p.saveIntoDatabase(h.db);
    expect(await rows(p.id)).toEqual([expect.objectContaining({ IsExist: false, RemoveType: 9, BagType: -1, Place: -1 })]);
  });
});

describe("temporary rewards transfer without deletion", () => {
  it("lotteryFinish keeps a full-bag CaddyBag reward's mail attachment alive", async () => {
    const { p, ctx } = await fixture(), reward = item();
    for (let slot = 0; slot < p.propBag.capacity; slot++) p.propBag.addItemTo(item(template.MaxCount), slot);
    p.caddyBag.addItemTo(reward, 0);
    await lotteryFinish(ctx, p); await p.saveIntoDatabase(h.db);
    const attachment = (await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, reward.ItemID)))[0]!;
    const mails = await h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, p.id));
    expect(p.caddyBag.getItems()).toEqual([]);
    expect(attachment).toMatchObject({ UserID: 0, IsExist: true, BagType: -1, Place: -1 });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.Annex1).toBe(String(reward.ItemID));
  });

  it("packet108 keeps the transferred reward alive after saving", async () => {
    const { p, ctx } = await fixture(), reward = item();
    p.tempBag.addItemTo(reward, 0);
    await takeTemp(p, ctx, 0); await p.saveIntoDatabase(h.db);
    expect(p.tempBag.getItems()).toEqual([]);
    expect(p.propBag.getItemAt(0)).toBe(reward);
    expect(await rows(p.id)).toEqual([expect.objectContaining({ ItemID: reward.ItemID, IsExist: true, BagType: 1, Place: 0 })]);
  });

  it("packet108 keeps a mailed overflow attachment alive after saving", async () => {
    const { p, ctx } = await fixture(), reward = item();
    for (let slot = 0; slot < p.propBag.capacity; slot++) p.propBag.addItemTo(item(), slot);
    p.tempBag.addItemTo(reward, 0);
    await takeTemp(p, ctx, -1); await p.saveIntoDatabase(h.db);
    const attachment = (await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, reward.ItemID)))[0]!;
    const mails = await h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, p.id));
    expect(p.tempBag.getItems()).toEqual([]);
    expect(attachment).toMatchObject({ UserID: 0, IsExist: true, BagType: -1, Place: -1 });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.Annex1).toBe(String(reward.ItemID));
  });
});

describe("automatic return from FightBag", () => {
  it("persists deletion of an already-saved source when auto-stacking", async () => {
    const { p, ctx } = await fixture(), source = item(), target = item(2);
    p.propBag.addItemTo(source, 13); p.propBag.addItemTo(target, 14); await p.saveIntoDatabase(h.db);
    changeItemPlace(ctx, p, 1, 13, 3, 0, 1); await p.saveIntoDatabase(h.db);
    expect(p.propBag.removed).toEqual([]);
    expect((await rows(p.id)).find((r) => r.ItemID === source.ItemID)).toMatchObject({ IsExist: true, BagType: 3, Place: 0 });
    const ids = [source.ItemID, target.ItemID];
    changeItemPlace(ctx, p, 3, 0, 1, -1, 1); await p.saveIntoDatabase(h.db);
    expect(p.fightBag.getItems()).toEqual([]);
    const stored = await rows(p.id);
    expect(stored.map((r) => r.ItemID).sort((a, b) => a - b)).toEqual(ids.sort((a, b) => a - b));
    expect(stored.find((r) => r.ItemID === target.ItemID)).toMatchObject({ IsExist: true, BagType: 1, Place: 14, Count: 3 });
    expect(stored.find((r) => r.ItemID === source.ItemID)).toMatchObject({ IsExist: false, BagType: -1, Place: -1, RemoveType: 26 });
    expect(p.fightBag.removed).toEqual([]);
  });

  it("retries a failed merged-source update without incrementing the saved target twice", async () => {
    const { p, ctx } = await fixture(), source = item(), target = item(2);
    p.propBag.addItemTo(source, 13); p.propBag.addItemTo(target, 14); await p.saveIntoDatabase(h.db);
    changeItemPlace(ctx, p, 1, 13, 3, 0, 1); await p.saveIntoDatabase(h.db);
    changeItemPlace(ctx, p, 3, 0, 1, -1, 1);
    await h.db.execute(sql`CREATE FUNCTION player.inventory_return_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."IsExist" = false THEN RAISE EXCEPTION 'test merged-source update failure'; END IF; RETURN NEW; END $$`);
    await h.db.execute(sql`CREATE TRIGGER test_return_failure BEFORE UPDATE ON player."Sys_Users_Goods" FOR EACH ROW EXECUTE FUNCTION player.inventory_return_failure()`);
    try {
      await expect(p.saveIntoDatabase(h.db)).rejects.toThrow();
      expect(p.fightBag.removed).toEqual([source]);
      expect(source.isDirty).toBe(true);
      expect((await rows(p.id)).find((r) => r.ItemID === target.ItemID)).toMatchObject({ IsExist: true, Count: 3 });
      expect((await rows(p.id)).find((r) => r.ItemID === source.ItemID)).toMatchObject({ IsExist: true, BagType: 3, Place: 0, Count: 1 });
    } finally {
      await h.db.execute(sql`DROP TRIGGER test_return_failure ON player."Sys_Users_Goods"`);
      await h.db.execute(sql`DROP FUNCTION player.inventory_return_failure()`);
    }
    const ids = [source.ItemID, target.ItemID]; await p.saveIntoDatabase(h.db);
    const stored = await rows(p.id);
    expect(stored.map((r) => r.ItemID).sort((a, b) => a - b)).toEqual(ids.sort((a, b) => a - b));
    expect(stored.find((r) => r.ItemID === target.ItemID)).toMatchObject({ IsExist: true, Count: 3 });
    expect(stored.find((r) => r.ItemID === source.ItemID)).toMatchObject({ IsExist: false, BagType: -1, Place: -1, RemoveType: 26 });
    expect(p.fightBag.removed).toEqual([]);
  });

  it.each([false, true])("keeps the same live row when auto-return uses an empty slot; full peer=%s", async (fullPeer) => {
    const { p, ctx } = await fixture(), source = item();
    p.propBag.addItemTo(source, 13);
    if (fullPeer) p.propBag.addItemTo(item(template.MaxCount), 14);
    await p.saveIntoDatabase(h.db); const id = source.ItemID;
    changeItemPlace(ctx, p, 1, 13, 3, 0, 1); await p.saveIntoDatabase(h.db);
    const peersBefore = (await rows(p.id)).filter((r) => r.ItemID !== id);
    changeItemPlace(ctx, p, 3, 0, 1, -1, 1); await p.saveIntoDatabase(h.db);
    const stored = await rows(p.id);
    expect(p.propBag.getItemAt(0)).toBe(source);
    expect(p.fightBag.getItems()).toEqual([]);
    expect(stored.find((r) => r.ItemID === id)).toMatchObject({ ItemID: id, IsExist: true, BagType: 1, Place: 0, Count: 1 });
    expect(stored.filter((r) => r.ItemID !== id)).toEqual(peersBefore);
    expect(stored).toHaveLength(fullPeer ? 2 : 1);
    expect(p.fightBag.removed).toEqual([]);
  });

  it("does not insert an ID0 source that automatically merges into a saved stack", async () => {
    const { p, ctx } = await fixture(), source = item(), target = item(2);
    p.propBag.addItemTo(target, 14); await p.saveIntoDatabase(h.db);
    p.fightBag.addItemTo(source, 0);
    changeItemPlace(ctx, p, 3, 0, 1, -1, 1); await p.saveIntoDatabase(h.db);
    expect(await rows(p.id)).toEqual([expect.objectContaining({ ItemID: target.ItemID, IsExist: true, BagType: 1, Place: 14, Count: 3 })]);
    expect(source.ItemID).toBe(0); expect(source.IsExist).toBe(false);
    expect(p.fightBag.getItems()).toEqual([]); expect(p.fightBag.removed).toEqual([]);
  });
});
