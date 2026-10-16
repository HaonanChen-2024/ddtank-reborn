import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserCardBag } from "../src/db/pets-cards.js";
import { Templates } from "../src/db/templates.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { CardInventory, newCard } from "../src/game/cards.js";
import { commitPlayerMutation, PlayerMutationCommittedError } from "../src/game/player-transaction.js";
import type { ServerContext } from "../src/session/context.js";

// Full unchanged source seed rows, selected and CRC-checked by the packet-216
// worker. Card balances below are explicit synthetic player state.
const goods = JSON.parse(readFileSync(new URL("./fixtures/treasure-card-boxes.json", import.meta.url), "utf8")) as ItemTemplate[];
const box = goods.find(row => row.CategoryID === 18)!;
const card = goods.find(row => row.TemplateID === box.Property5)!;
const C = player.Sys_Users_Card, D = player.Sys_Users_Detail, G = player.Sys_Users_Goods;
let h: DbHandle, sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of ['player."Sys_Users_Card"', 'player."Sys_Users_Detail"', 'player."Sys_Users_Goods"'])
    await h.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_card_transaction_failure ON ${table}`));
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_card_transaction_failure()`);
});
afterAll(async () => { await h?.close(); });

async function fixture() {
  const [owner] = await h.db.insert(D).values({ UserName: `card_tx_${++sequence}`, NickName: `Card ${sequence}`, Grade: 20, IsFirst: 1, Gold: 100 }).returning();
  const sent: GSPacket[] = [], info = (await loadPlayerInfo(h.db, owner!.UserID))!;
  const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "card-transaction-isolated-memory" }, info, defaultMatch(info.ID), 1, "test");
  const [stored] = await h.db.insert(G).values({ UserID: p.id, BagType: 0, Place: 20, TemplateID: box.TemplateID, Count: 3, IsBinds: true }).returning();
  const item = ItemInfo.fromRow(stored!, box); p.equipBag.loadItems([item]);
  const { CardID: _id, dirty: _dirty, ...cardValues } = newCard(p.id, card.TemplateID, 5);
  const [row] = await h.db.insert(C).values({ ...cardValues, Place: 5 }).returning();
  p.cardBag.load([{ ...row!, dirty: false }]);
  const templates = new Templates(); for (const row of goods) templates.items.set(row.TemplateID, row);
  const ctx = { db: h, templates, now: () => new Date("2026-10-16T08:00:00Z") } as unknown as ServerContext;
  sent.length = 0;
  return { p, item, ctx, sent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const rows = (f: Fixture) => h.db.select().from(C).where(eq(C.UserID, f.p.id)).orderBy(C.CardID);
const database = async (f: Fixture) => ({ cards: await rows(f), goods: await h.db.select().from(G).where(eq(G.UserID, f.p.id)), profile: (await h.db.select().from(D).where(eq(D.UserID, f.p.id)))[0] });
const memory = (f: Fixture) => structuredClone({ info: f.p.info, match: f.p.match, cards: f.p.cards, cardBag: { userId: f.p.cardBag.userId, capacity: f.p.cardBag.capacity, beginSlot: f.p.cardBag.beginSlot, cards: f.p.cardBag.cards, removed: f.p.cardBag.removed, changed: [...f.p.cardBag.changed] }, items: f.p.equipBag.getItems().map(it => ({ ...it.toRow(), dirty: it.isDirty })) });
const mutate = (staged: GamePlayer) => { staged.info.Gold -= 7; staged.equipBag.removeCountFromStack(staged.equipBag.getItemAt(20), 1); staged.cardBag.addCard(card.TemplateID, 2); };
const run = (f: Fixture, work: (p: GamePlayer) => void | Promise<void> = mutate, enabled = true) => f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (_db, staged) => { await work(staged); return { value: { applied: true } }; }, enabled ? { cards: true } : undefined));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe("explicit card bag opt-in in player mutation", () => {
  it("detaches card bag, card rows and stat cards even when work returns null", async () => {
    const f = await fixture(), before = memory(f), stored = await database(f);
    f.p.cards = [f.p.cardBag.getItemAt(5)!]; const starting = memory(f);
    expect(await f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (_db, staged) => {
      expect(staged.cardBag).not.toBe(f.p.cardBag); expect(staged.cardBag.getItemAt(5)).not.toBe(f.p.cardBag.getItemAt(5)); expect(staged.cards).not.toBe(f.p.cards); expect(staged.cards[0]).not.toBe(f.p.cards[0]);
      staged.cardBag.addCard(card.TemplateID, 2); staged.cards[0]!.Attack = 99; return null;
    }))).toBeNull();
    expect(memory(f)).toEqual(starting); expect(await database(f)).toEqual(stored); expect(f.sent).toEqual([]); expect(before.cardBag.cards[5]!.Count).toBe(5);
  });
  it("rejects default card mutation without leaking live changes or SQL", async () => {
    const f = await fixture(), before = memory(f), stored = await database(f);
    await expect(run(f, mutate, false)).rejects.toBeDefined(); expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(stored); expect(f.sent).toEqual([]);
  });
  it("persists merged card, consumed ordinary item and profile together before publication", async () => {
    const f = await fixture(), before = memory(f), original = f.p.cardBag.getItemAt(5)!;
    await run(f, staged => { mutate(staged); expect(memory(f)).toEqual(before); expect(f.sent).toEqual([]); });
    expect(f.p.cardBag.getItemAt(5)).toBe(original); expect(original).toMatchObject({ Count: 7, dirty: false });
    expect((await rows(f))[0]!.Count).toBe(7); expect(f.item.Count).toBe(2); expect(f.p.info.Gold).toBe(93);
    expect((await database(f)).goods[0]!.Count).toBe(2); expect((await database(f)).profile!.Gold).toBe(93);
    expect(f.sent.filter(packet => packet.code === 216)).toHaveLength(1); expect(f.p.cardBag.changed.size).toBe(0);
    expect((await loadUserCardBag(h.db, f.p.id))[0]).toMatchObject({ Count: 7, dirty: false });
    await f.p.saveIntoDatabase(h.db); expect((await rows(f))[0]!.Count).toBe(7);
  });
  it("persists a newly inserted card identity and publishes the same committed row once", async () => {
    const f = await fixture(); await h.db.delete(C).where(eq(C.UserID, f.p.id)); f.p.cardBag = new CardInventory(f.p.id);
    await run(f); const live = f.p.cardBag.getItemAt(5)!, stored = (await rows(f))[0]!;
    expect(live).toMatchObject({ CardID: stored.CardID, TemplateID: card.TemplateID, Count: 2, Place: 5, dirty: false }); expect(live.CardID).toBeGreaterThan(0);
    await f.p.saveIntoDatabase(h.db); expect(await rows(f)).toHaveLength(1); expect((await rows(f))[0]).toEqual(stored);
  });
  it.each(["target slot", "same template in another slot"] as const)("rejects a database card missing from live bag at %s", async kind => {
    const f = await fixture();
    if (kind === "same template in another slot") await h.db.update(C).set({ Place: 6 }).where(eq(C.CardID, f.p.cardBag.getItemAt(5)!.CardID));
    f.p.cardBag = new CardInventory(f.p.id);
    const before = memory(f), stored = await database(f);
    await expect(run(f)).rejects.toBeDefined(); expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(stored); expect(f.sent).toEqual([]);
  });
  it.each(["cards", "profile", "goods", "commit"] as const)("rolls back actual %s SQL failure without memory or packets", async kind => {
    const f = await fixture(), before = memory(f), stored = await database(f);
    await h.db.execute(sql`CREATE FUNCTION player.test_card_transaction_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected card transaction failure'; RETURN NEW; END; $$`);
    const target = { cards: 'player."Sys_Users_Card"', profile: 'player."Sys_Users_Detail"', goods: 'player."Sys_Users_Goods"', commit: 'player."Sys_Users_Detail"' }[kind];
    await h.db.execute(sql.raw(kind === "commit" ? `CREATE CONSTRAINT TRIGGER test_card_transaction_failure AFTER UPDATE ON ${target} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION player.test_card_transaction_failure()` : `CREATE TRIGGER test_card_transaction_failure BEFORE INSERT OR UPDATE ON ${target} FOR EACH ROW EXECUTE FUNCTION player.test_card_transaction_failure()`));
    await expect(run(f)).rejects.toBeDefined(); expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(stored); expect(f.sent).toEqual([]);
  });
  it.each(["insert", "commit"] as const)("does not publish a newly allocated identity after %s failure", async kind => {
    const f = await fixture(); await h.db.delete(C).where(eq(C.UserID, f.p.id)); f.p.cardBag = new CardInventory(f.p.id);
    const before = memory(f), stored = await database(f);
    await h.db.execute(sql`CREATE FUNCTION player.test_card_transaction_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'new card transaction failure'; RETURN NEW; END; $$`);
    await h.db.execute(sql.raw(kind === "insert" ? 'CREATE TRIGGER test_card_transaction_failure BEFORE INSERT ON player."Sys_Users_Card" FOR EACH ROW EXECUTE FUNCTION player.test_card_transaction_failure()' : 'CREATE CONSTRAINT TRIGGER test_card_transaction_failure AFTER UPDATE ON player."Sys_Users_Detail" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION player.test_card_transaction_failure()'));
    await expect(run(f)).rejects.toBeDefined(); expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(stored); expect(f.sent).toEqual([]);
  });
  it("rejects an unsaved dirty card whose old balance differs from SQL", async () => {
    const f = await fixture(); const c = f.p.cardBag.getItemAt(5)!; c.Count++; c.dirty = true; f.p.cardBag.changed.add(5);
    const before = memory(f), stored = await database(f);
    await expect(run(f)).rejects.toThrow("Player card changed before mutation"); expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(stored); expect(f.sent).toEqual([]);
  });
  it("accepts an already dirty card only when its complete old row still matches SQL", async () => {
    const f = await fixture(); f.p.cardBag.getItemAt(5)!.dirty = true; f.p.cardBag.changed.add(5);
    await run(f); expect(f.p.cardBag.getItemAt(5)).toMatchObject({ Count: 7, dirty: false }); expect((await rows(f))[0]!.Count).toBe(7);
  });
  it("detaches pending card tombstones and change tracking from default rejected work", async () => {
    const f = await fixture(); f.p.cardBag.removed.push({ ...newCard(f.p.id, card.TemplateID, 1), CardID: 999999, Place: 6 }); f.p.cardBag.changed.add(6);
    const before = memory(f), stored = await database(f);
    expect(await commitPlayerMutation(f.ctx, f.p, async (_db, staged) => {
      expect(staged.cardBag.removed[0]).not.toBe(f.p.cardBag.removed[0]); staged.cardBag.removed[0]!.Count = 123; staged.cardBag.changed.clear(); return null;
    })).toBeNull();
    expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(stored); expect(f.sent).toEqual([]);
  });
  it.each([
    ["foreign owner", (p: GamePlayer) => { p.cardBag.getItemAt(5)!.UserID++; }],
    ["row identity", (p: GamePlayer) => { p.cardBag.getItemAt(5)!.CardID++; }],
    ["template", (p: GamePlayer) => { p.cardBag.getItemAt(5)!.TemplateID++; }],
    ["move", (p: GamePlayer) => { p.cardBag.moveCard(5, 6); }],
    ["remove", (p: GamePlayer) => { p.cardBag.removeCardAt(5); }],
    ["replace", (p: GamePlayer) => { p.cardBag.cards[5] = { ...p.cardBag.cards[5]! }; }],
    ["stat", (p: GamePlayer) => { p.cardBag.getItemAt(5)!.Attack++; }],
    ["zero", (p: GamePlayer) => { p.cardBag.getItemAt(5)!.Count = 0; }],
    ["fraction", (p: GamePlayer) => { p.cardBag.getItemAt(5)!.Count = 6.5; }],
    ["overflow", (p: GamePlayer) => { p.cardBag.getItemAt(5)!.Count = 2_147_483_648; }],
    ["capacity", (p: GamePlayer) => { Object.assign(p.cardBag, { capacity: 101 }); }],
    ["begin slot", (p: GamePlayer) => { Object.assign(p.cardBag, { beginSlot: 0 }); }],
    ["array length", (p: GamePlayer) => { p.cardBag.cards.push(null); }],
    ["duplicate row", (p: GamePlayer) => { p.cardBag.cards[6] = p.cardBag.cards[5]!; }],
    ["equipped insertion", (p: GamePlayer) => { p.cardBag.addCardTo(newCard(p.id, card.TemplateID, 1), 0); }],
  ] as const)("rejects staged %s outside add/merge contract", async (_kind, change) => {
    const f = await fixture(), before = memory(f), stored = await database(f);
    await expect(run(f, staged => { mutate(staged); change(staged); })).rejects.toBeDefined(); expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(stored); expect(f.sent).toEqual([]);
  });
  it.each(["count", "row", "bag", "changed", "removed", "stat cards"] as const)("rejects concurrent live %s change without overwriting it", async kind => {
    const f = await fixture(), stored = await database(f), entered = deferred(), release = deferred();
    const pending = run(f, async staged => { mutate(staged); entered.resolve(); await release.promise; }); const rejected = expect(pending).rejects.toBeDefined(); await entered.promise;
    if (kind === "count") f.p.cardBag.getItemAt(5)!.Count++;
    if (kind === "row") f.p.cardBag.cards[5] = { ...f.p.cardBag.getItemAt(5)! };
    if (kind === "bag") { const old = f.p.cardBag.all(); f.p.cardBag = new CardInventory(f.p.id); f.p.cardBag.load(old); }
    if (kind === "changed") f.p.cardBag.changed.add(6);
    if (kind === "removed") f.p.cardBag.removed.push({ ...f.p.cardBag.getItemAt(5)! });
    if (kind === "stat cards") f.p.cards = [{ ...f.p.cardBag.getItemAt(5)!, Attack: 1 }];
    const outside = memory(f); release.resolve(); await rejected; expect(memory(f)).toEqual(outside); expect(await database(f)).toEqual(stored); expect(f.sent).toEqual([]);
  });
  it.each(["count", "owner", "delete"] as const)("does not overwrite separately committed card %s", async kind => {
    const f = await fixture(), before = memory(f), key = eq(C.CardID, f.p.cardBag.getItemAt(5)!.CardID);
    if (kind === "count") await h.db.update(C).set({ Count: 4 }).where(key);
    if (kind === "owner") await h.db.update(C).set({ UserID: f.p.id + 100_000 }).where(key);
    if (kind === "delete") await h.db.delete(C).where(key);
    const stored = await database(f); await expect(run(f)).rejects.toBeDefined(); expect(await database(f)).toEqual(stored); expect(memory(f)).toEqual(before); expect(f.sent).toEqual([]);
  });
  it("does not query or flush cards for a default profile/items-only mutation", async () => {
    const f = await fixture(); await h.db.delete(C).where(eq(C.UserID, f.p.id));
    const reads: unknown[] = [], writes: unknown[] = [], flush = vi.spyOn(f.p, "flushCards");
    const transaction = h.db.transaction.bind(h.db);
    vi.spyOn(h.db, "transaction").mockImplementationOnce(work => transaction(async tx => {
      const select = tx.select.bind(tx);
      vi.spyOn(tx, "select").mockImplementation(((...args: Parameters<typeof tx.select>) => {
        const query = select(...args), from = query.from.bind(query);
        vi.spyOn(query, "from").mockImplementation(((table: Parameters<typeof query.from>[0]) => {
          reads.push(table); return from(table);
        }) as typeof query.from);
        return query;
      }) as typeof tx.select);
      const insert = vi.spyOn(tx, "insert"), update = vi.spyOn(tx, "update"), remove = vi.spyOn(tx, "delete");
      const result = await work(tx);
      writes.push(...insert.mock.calls.map(call => call[0]), ...update.mock.calls.map(call => call[0]), ...remove.mock.calls.map(call => call[0]));
      return result;
    }));
    await run(f, p => { p.info.Gold--; }, false);
    expect(reads).toContain(D); expect(writes).toContain(D);
    expect(reads).not.toContain(C); expect(writes).not.toContain(C); expect(flush).not.toHaveBeenCalled(); expect(f.sent.filter(p => p.code === 216)).toHaveLength(0);
  });
  it("fully publishes committed card/item/profile before transport failure is reported", async () => {
    const f = await fixture(); vi.spyOn(f.p.sink, "send").mockImplementation(() => { throw new Error("injected card transport failure"); });
    let failure: unknown; try { await run(f); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PlayerMutationCommittedError); expect(failure).toMatchObject({ value: { applied: true } });
    expect(f.p.cardBag.getItemAt(5)).toMatchObject({ Count: 7, dirty: false }); expect(f.item.Count).toBe(2); expect(f.p.info.Gold).toBe(93); expect((await rows(f))[0]!.Count).toBe(7);
    expect(f.p.cardBag.changed.size).toBe(0); await f.p.saveIntoDatabase(h.db); expect((await rows(f))[0]!.Count).toBe(7);
  });
});
