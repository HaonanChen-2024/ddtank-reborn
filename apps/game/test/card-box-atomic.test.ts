import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { Templates } from "../src/db/templates.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { loadUserCardBag } from "../src/db/pets-cards.js";
import { GamePlayer } from "../src/game/player.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { newCard } from "../src/game/cards.js";
import { defaultMatch } from "../src/game/player-info.js";
import { PlayerMutationCommittedError } from "../src/game/player-transaction.js";
import { cardCommand, registerPets } from "../src/handlers/pets.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Eighteen complete, CRC-checked Shop_Goods seed rows: nine boxes and their
// nine fixed cards. Synthetic card rows below model capacity, not new content.
const goods = JSON.parse(readFileSync(new URL("./fixtures/treasure-card-boxes.json", import.meta.url), "utf8")) as ItemTemplate[];
const ids = goods.filter(t => t.CategoryID === 18).map(t => t.TemplateID);
const now = new Date("2026-10-16T08:00:00Z"), C = player.Sys_Users_Card, G = player.Sys_Users_Goods;
let h: DbHandle, sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of ['player."Sys_Users_Card"', 'player."Sys_Users_Goods"', 'player."Sys_Users_Detail"'])
    await h.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_card_box_failure ON ${table}`));
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_card_box_failure()`);
});
afterAll(async () => { await h?.close(); });

async function fixture(id = 20117, count = 3) {
  const templates = new Templates(); templates.items = new Map(goods.map(t => [t.TemplateID, { ...t }]));
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `cardbox${++sequence}`, NickName: `Card ${sequence}`, Grade: 20, IsFirst: 1 }).returning();
  const sent: GSPacket[] = [], p = new GamePlayer({ send: pkt => sent.push(GSPacket.parse(pkt.encode())), disconnect() {}, remoteAddress: "card-box-isolated" },
    (await loadPlayerInfo(h.db, owner!.UserID))!, defaultMatch(owner!.UserID), 1, "test");
  const world = new Map([[p.id, p]]), error = vi.fn();
  const ctx = { db: h, templates, now: () => new Date(now), world, log: { error } } as unknown as ServerContext;
  const add = (slot: number, n: number) => { const item = ItemInfo.createFromTemplate(templates.findItem(id)!, n, 0, now); expect(p.equipBag.addItemTo(item, slot)).toBe(true); return item; };
  const box = add(5, count), save = async () => { await p.saveIntoDatabase(h.db); sent.length = 0; };
  await save();
  const packet = (cmd = 2, a = 5, b = 1) => { const pkt = new GSPacket(216); pkt.writeInt(cmd); pkt.writeInt(a); pkt.writeInt(b); return GSPacket.parse(pkt.encode()); };
  const registry = new HandlerRegistry(); registerPets(registry);
  const use = (slot = 5, requested = 1) => registry.get(216)!.handle(ctx, { player: p } as GameClient, packet(2, slot, requested));
  return { p, box, ctx, sent, world, error, templates, add, save, packet, registry, use };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const rows = (f: Fixture) => h.db.select().from(G).where(eq(G.UserID, f.p.id)).orderBy(G.ItemID);
const cards = (f: Fixture) => loadUserCardBag(h.db, f.p.id);
const memory = (f: Fixture) => structuredClone({ info: f.p.info, match: f.p.match,
  items: f.p.allBags().map(b => ({ items: b.getItems().map(i => ({ ...i.toRow(), dirty: i.isDirty })), removed: b.removed.map(i => ({ ...i.toRow(), dirty: i.isDirty })) })),
  cards: f.p.cardBag.all(), removed: f.p.cardBag.removed, changed: [...f.p.cardBag.changed], equipped: f.p.cards });
async function fill(f: Fixture, target = false) {
  for (let place = 5; place < 100; place++) {
    const tpl = target && place === 5 ? f.box.template.Property5 : 900000 + place;
    expect(f.p.cardBag.addCardTo(newCard(f.p.id, tpl, target && place === 5 ? 10 : 1), place)).toBe(true);
  }
  await f.save(); f.p.cardBag.changed.clear();
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe("216 card box atomic inventory and card delivery", () => {
  it.each(ids)("opens genuine box %i through the existing registry and survives reload without autosave", async id => {
    const f = await fixture(id); vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.999).mockReturnValueOnce(0);
    await f.use();
    expect(f.p.equipBag.getItemAt(5)).toBeNull(); expect(f.box.IsExist).toBe(false);
    expect((await rows(f))[0]).toMatchObject({ IsExist: false, BagType: -1, Place: -1 });
    const [stored] = await cards(f);
    expect(stored).toMatchObject({ UserID: f.p.id, TemplateID: f.box.template.Property5, Count: 7, Place: 5, Attack: 0, Level: 0, CardGP: 0, dirty: false });
    expect(stored!.CardID).toBeGreaterThan(0); expect(f.p.cardBag.getItemAt(5)).toEqual(stored);
    const p216 = f.sent.find(p => p.code === 216)!;
    expect(p216.readInt()).toBe(f.p.id); expect(p216.readInt()).toBe(1); expect(p216.readInt()).toBe(5); expect(p216.readBoolean()).toBe(true);
    expect([p216.readInt(), p216.readInt(), p216.readInt(), p216.readInt(), p216.readInt()]).toEqual([stored!.CardID, f.p.id, 7, 5, f.box.template.Property5]);
    expect((await loadUserItems(h.db, f.p.id, f.templates.findItem, f.templates.findGoldTemplate)).get(0) ?? []).toEqual([]);
    const loaded = new GamePlayer({ send() {}, disconnect() {}, remoteAddress: "card-box-relogin" }, (await loadPlayerInfo(h.db, f.p.id))!, defaultMatch(f.p.id), 1, "test");
    loaded.cardBag.load(await cards(f)); expect(loaded.cardBag.getItemAt(5)).toEqual(stored);
  });

  it("keeps original whole-stack consumption and uses the requested slot", async () => {
    const f = await fixture(), spare = f.add(0, 10); await f.save(); vi.spyOn(Math, "random").mockReturnValue(0.999);
    await f.use(5, 1); expect(spare.Count).toBe(10); expect((await cards(f))[0]!.Count).toBe(9);
    expect((await rows(f)).find(r => r.ItemID === spare.ItemID)!.Count).toBe(10);
  });

  it("preserves the box and rolls no randomness when all card bag cells are occupied", async () => {
    const f = await fixture(); await fill(f); const before = memory(f), stored = await rows(f), oldCards = await cards(f), random = vi.spyOn(Math, "random");
    await f.use(); expect(memory(f)).toEqual(before); expect(await rows(f)).toEqual(stored); expect(await cards(f)).toEqual(oldCards);
    expect(random).not.toHaveBeenCalled(); expect(f.sent.some(p => p.code === 216 || p.code === 64)).toBe(false);
  });

  it("merges the same bag card even when every card slot is full", async () => {
    const f = await fixture(); await fill(f, true); const old = f.p.cardBag.getItemAt(5)!; vi.spyOn(Math, "random").mockReturnValue(0);
    await f.use(); expect(f.p.cardBag.getItemAt(5)).toBe(old); expect(old.Count).toBe(16); expect((await cards(f)).find(c => c.CardID === old.CardID)!.Count).toBe(16);
    expect(f.p.cardBag.all()).toHaveLength(95); expect(f.p.equipBag.getItemAt(5)).toBeNull();
  });

  it.each(["card", "goods", "profile"] as const)("rolls back an actual %s SQL failure without spending either side", async target => {
    const f = await fixture(), before = memory(f), stored = await rows(f);
    await h.db.execute(sql`CREATE FUNCTION player.test_card_box_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected card box SQL failure'; END; $$`);
    const table = { card: 'player."Sys_Users_Card"', goods: 'player."Sys_Users_Goods"', profile: 'player."Sys_Users_Detail"' }[target];
    await h.db.execute(sql.raw(`CREATE TRIGGER test_card_box_failure BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION player.test_card_box_failure()`));
    await f.use(); expect(memory(f)).toEqual(before); expect(await rows(f)).toEqual(stored); expect(await cards(f)).toEqual([]);
    expect(f.error).toHaveBeenCalledOnce(); expect(f.sent.some(p => p.code === 216 || p.code === 64)).toBe(false);
  });

  it("rolls back failure after all SQL writes but before transaction commit", async () => {
    const f = await fixture(), before = memory(f), stored = await rows(f), transaction = h.db.transaction.bind(h.db);
    const db = Object.create(h.db); db.transaction = (work: Parameters<typeof h.db.transaction>[0]) => transaction(async tx => { await work(tx); throw new Error("injected before COMMIT"); });
    f.ctx.db = { ...h, db };
    await f.use(); expect(memory(f)).toEqual(before); expect(await rows(f)).toEqual(stored); expect(await cards(f)).toEqual([]); expect(f.error).toHaveBeenCalledOnce();
  });

  it("does not mistake a committed 216 notification error for a retryable award failure", async () => {
    const f = await fixture(); vi.spyOn(Math, "random").mockReturnValue(0); const send = f.p.send.bind(f.p);
    vi.spyOn(f.p, "send").mockImplementation(pkt => { if (pkt.code === 216) throw new Error("216 transport failed"); send(pkt); });
    await expect(f.use()).rejects.toBeInstanceOf(PlayerMutationCommittedError);
    expect((await cards(f))[0]!.Count).toBe(6); expect(f.p.cardBag.getItemAt(5)!.Count).toBe(6); expect(f.box.IsExist).toBe(false); expect(f.error).not.toHaveBeenCalled();
    expect(f.sent.some(pkt => pkt.code === 3)).toBe(false); await f.use(); await f.save();
    expect((await cards(f))[0]!.Count).toBe(6); expect((await rows(f))[0]!.IsExist).toBe(false);
  });

  it("serializes simultaneous openings so the selected stack is consumed once", async () => {
    const f = await fixture(); vi.spyOn(Math, "random").mockReturnValue(0);
    await Promise.all([f.use(), f.use()]); expect((await cards(f))).toHaveLength(1); expect((await cards(f))[0]!.Count).toBe(6);
    expect(f.sent.filter(p => p.code === 216)).toHaveLength(1); expect(f.p.worldBossAwardPending).toBeNull();
  });

  it("rechecks a stale owner after waiting for persistence", async () => {
    const f = await fixture(), before = memory(f), gate = deferred(), entered = deferred();
    const held = f.p.withPersistenceLock(async () => { entered.resolve(); await gate.promise; }); await entered.promise;
    const pending = f.use(); await Promise.resolve(); expect(f.p.worldBossAwardPending).not.toBeNull(); f.world.delete(f.p.id);
    gate.resolve(); await held; await pending; expect(memory(f)).toEqual(before); expect(await cards(f)).toEqual([]); expect(f.sent).toEqual([]);
  });

  it("holds the settlement lease through card publication and serializes a following move", async () => {
    const f = await fixture(), gate = deferred(), requested = deferred(), released = vi.fn(), original = memory(f);
    f.p.currentRoom = { sendToAll() {}, game: { holdWorldBossSettlement: async () => { requested.resolve(); await gate.promise; return released; } } } as unknown as GamePlayer["currentRoom"];
    vi.spyOn(Math, "random").mockReturnValue(0); const opening = f.use(); await requested.promise;
    const moved = cardCommand(f.ctx, f.p, f.packet(0, 5, 6)); expect(memory(f)).toEqual(original); gate.resolve();
    await opening; await moved; expect(f.p.cardBag.getItemAt(5)).toBeNull(); expect(f.p.cardBag.getItemAt(6)!.Count).toBe(6);
    expect(released).toHaveBeenCalledTimes(4); // Existing idempotent lease contract, try/finally plus outer finally.
    await f.save(); expect((await cards(f))[0]!.Place).toBe(6);
  });

  it.each([0, 4, 8, 13, 16])("rejects a malformed card-box body of %i bytes without padded reads", async length => {
    const f = await fixture(), pkt = new GSPacket(216), body = new Uint8Array(length);
    if (length >= 4) new DataView(body.buffer).setInt32(0, 2);
    pkt.setBody(body);
    await cardCommand(f.ctx, f.p, GSPacket.parse(pkt.encode())); expect(f.box.IsExist).toBe(true); expect(await cards(f)).toEqual([]);
  });

  it.each([0, -1, 4])("rejects requested count %i while preserving the whole original stack", async count => {
    const f = await fixture(); await f.use(5, count); expect(f.box.Count).toBe(3); expect(f.box.IsExist).toBe(true); expect(await cards(f)).toEqual([]);
  });
});
