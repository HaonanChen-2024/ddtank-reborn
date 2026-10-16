import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { Templates } from "../src/db/templates.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { commitPlayerMutation, PlayerMutationCommittedError } from "../src/game/player-transaction.js";
import type { ServerContext } from "../src/session/context.js";

// The item is an unchanged full seed row from the existing compose fixture.
// User_Buff has no source seed rows: all Buff records below are explicitly
// synthetic schema-valid state for transaction tests, not imported game content.
const goods = JSON.parse(readFileSync(new URL("./fixtures/treasure-compose-goods.json", import.meta.url), "utf8")) as { goods: ItemTemplate[] };
const template = goods.goods.find(row => row.TemplateID === 11030)!;
const B = player.User_Buff, D = player.Sys_Users_Detail, G = player.Sys_Users_Goods;
const begin = new Date("2026-10-16T00:00:00Z");
let h: DbHandle, sequence = 0;
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of ['player."User_Buff"', 'player."Sys_Users_Detail"', 'player."Sys_Users_Goods"']) {
    await h.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_buff_transaction_failure ON ${table}`));
  }
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_buff_transaction_failure()`);
});
afterAll(async () => { await h?.close(); });

async function fixture() {
  const [owner] = await h.db.insert(D).values({ UserName: `buff_tx_${++sequence}`, NickName: `Buff ${sequence}`, Grade: 20, IsFirst: 1, Gold: 100 }).returning();
  const sent: GSPacket[] = [], info = (await loadPlayerInfo(h.db, owner!.UserID))!;
  const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "buff-transaction-isolated-memory" }, info, defaultMatch(info.ID), 1, "test");
  const [stored] = await h.db.insert(G).values({ UserID: p.id, BagType: 1, Place: 0, TemplateID: template.TemplateID, Count: 3, IsBinds: true }).returning();
  const item = ItemInfo.fromRow(stored!, template); p.propBag.loadItems([item]);
  const [buff] = await h.db.insert(B).values({ UserID: p.id, Type: 71, Value: 25, BeginDate: begin, ValidDate: 60, TemplateID: 0, ValidCount: 3, Data: null, IsExist: true }).returning();
  p.buffs = [buff!];
  const templates = new Templates(); templates.items.set(template.TemplateID, template);
  const ctx = { db: h, templates, now: () => new Date(begin) } as unknown as ServerContext;
  sent.length = 0;
  return { p, item, ctx, sent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const buffs = (f: Fixture) => h.db.select().from(B).where(eq(B.UserID, f.p.id)).orderBy(B.Type);
const detail = (f: Fixture) => h.db.select().from(D).where(eq(D.UserID, f.p.id));
const items = (f: Fixture) => h.db.select().from(G).where(eq(G.UserID, f.p.id)).orderBy(G.ItemID);
const memory = (f: Fixture) => structuredClone({ info: f.p.info, match: f.p.match, buffs: f.p.buffs,
  bags: f.p.allBags().map(b => ({ items: b.getItems().map(i => ({ ...i.toRow(), dirty: i.isDirty })), removed: b.removed.map(i => ({ ...i.toRow(), dirty: i.isDirty })) })) });
const database = async (f: Fixture) => ({ profile: await detail(f), goods: await items(f), buffs: await buffs(f) });
const mutate = (staged: GamePlayer, count = 2) => {
  staged.info.Gold -= 7;
  if (!staged.propBag.removeCountFromStack(staged.propBag.getItemAt(0), 1)) throw new Error("fixture stack missing");
  staged.buffs[0]!.ValidCount = count;
};
const run = (f: Fixture, work: (p: GamePlayer) => void | Promise<void> = mutate) => f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (_db, staged) => {
  await work(staged); return { value: { applied: true } };
}));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe("existing Buff count in player mutation", () => {
  it.each([2, 0])("commits profile, item and Buff remaining count=%i together before publication", async count => {
    const f = await fixture(), before = memory(f);
    await run(f, async staged => {
      expect(staged.buffs).not.toBe(f.p.buffs); expect(staged.buffs[0]).not.toBe(f.p.buffs[0]);
      expect(staged.buffs[0]!.BeginDate).not.toBe(f.p.buffs[0]!.BeginDate);
      mutate(staged, count); expect(memory(f)).toEqual(before); expect(f.sent).toEqual([]);
    });
    expect(f.p.info.Gold).toBe(93); expect(f.item.Count).toBe(2); expect(f.item.isDirty).toBe(false);
    expect(f.p.buffs[0]!.ValidCount).toBe(count); expect((await buffs(f))[0]!.ValidCount).toBe(count);
    expect((await detail(f))[0]!.Gold).toBe(93); expect((await items(f))[0]!.Count).toBe(2);
    expect(f.sent.some(packet => packet.code === 64)).toBe(true);
    await f.p.saveIntoDatabase(h.db); expect((await buffs(f))[0]!.ValidCount).toBe(count);
  });

  it.each(["buff", "profile", "goods"] as const)("rolls back an actual %s SQL write failure with all memory and notifications unchanged", async table => {
    const f = await fixture(), before = memory(f), rows = await database(f);
    await h.db.execute(sql`CREATE FUNCTION player.test_buff_transaction_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected buff transaction failure'; END; $$`);
    const target = { buff: 'player."User_Buff"', profile: 'player."Sys_Users_Detail"', goods: 'player."Sys_Users_Goods"' }[table];
    await h.db.execute(sql.raw(`CREATE TRIGGER test_buff_transaction_failure BEFORE INSERT OR UPDATE ON ${target} FOR EACH ROW EXECUTE FUNCTION player.test_buff_transaction_failure()`));
    await expect(run(f)).rejects.toBeDefined(); expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(rows); expect(f.sent).toEqual([]);
  });

  it("rolls back a null work result without publishing staged Buff/profile/item changes", async () => {
    const f = await fixture(), before = memory(f), rows = await database(f);
    expect(await f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (_db, staged) => { mutate(staged); return null; }))).toBeNull();
    expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(rows); expect(f.sent).toEqual([]);
  });

  it.each([
    ["add", (p: GamePlayer) => { p.buffs.push({ ...p.buffs[0]!, Type: 72 }); }],
    ["delete", (p: GamePlayer) => { p.buffs.pop(); }],
    ["replace", (p: GamePlayer) => { p.buffs[0] = { ...p.buffs[0]!, ValidCount: 2 }; }],
    ["owner", (p: GamePlayer) => { p.buffs[0]!.UserID++; }],
    ["type", (p: GamePlayer) => { p.buffs[0]!.Type++; }],
    ["value", (p: GamePlayer) => { p.buffs[0]!.Value++; }],
    ["begin", (p: GamePlayer) => { p.buffs[0]!.BeginDate.setTime(begin.getTime() + 1); }],
    ["duration", (p: GamePlayer) => { p.buffs[0]!.ValidDate++; }],
    ["template", (p: GamePlayer) => { p.buffs[0]!.TemplateID++; }],
    ["data", (p: GamePlayer) => { p.buffs[0]!.Data = "changed"; }],
    ["exists", (p: GamePlayer) => { p.buffs[0]!.IsExist = false; }],
    ["negative", (p: GamePlayer) => { p.buffs[0]!.ValidCount = -1; }],
    ["increase", (p: GamePlayer) => { p.buffs[0]!.ValidCount = 4; }],
    ["fraction", (p: GamePlayer) => { p.buffs[0]!.ValidCount = 1.5; }],
    ["NaN", (p: GamePlayer) => { p.buffs[0]!.ValidCount = Number.NaN; }],
  ] as const)("rejects staged Buff %s outside the existing-count-decrease contract", async (_name, change) => {
    const f = await fixture(), before = memory(f), rows = await database(f);
    await expect(run(f, staged => { mutate(staged); change(staged); })).rejects.toBeDefined();
    expect(memory(f)).toEqual(before); expect(await database(f)).toEqual(rows); expect(f.sent).toEqual([]);
  });

  it.each(["count", "field", "add", "delete", "replace"] as const)("rejects a live Buff %s mutation during awaited work without overwriting that outside change", async kind => {
    const f = await fixture(), rows = await database(f), entered = deferred(), release = deferred();
    const pending = run(f, async staged => { mutate(staged); entered.resolve(); await release.promise; });
    // Attach rejection immediately; the injected mutation happens only after
    // detached staging and before the final live-state comparison.
    const rejected = expect(pending).rejects.toBeDefined(); await entered.promise;
    if (kind === "count") f.p.buffs[0]!.ValidCount = 1;
    if (kind === "field") f.p.buffs[0]!.Data = "outside";
    if (kind === "add") f.p.buffs.push({ ...f.p.buffs[0]!, Type: 72 });
    if (kind === "delete") f.p.buffs.pop();
    if (kind === "replace") f.p.buffs[0] = structuredClone(f.p.buffs[0]!);
    const outside = memory(f); release.resolve(); await rejected;
    expect(memory(f)).toEqual(outside); expect(await database(f)).toEqual(rows); expect(f.sent).toEqual([]);
  });

  it.each(["update", "delete"] as const)("does not overwrite a Buff %s committed in a separate transaction", async kind => {
    const f = await fixture(), before = memory(f), rowBefore = (await database(f));
    await h.db.transaction(async tx => {
      const key = and(eq(B.UserID, f.p.id), eq(B.Type, 71));
      if (kind === "update") await tx.update(B).set({ ValidCount: 1, Data: "separate committed transaction" }).where(key);
      else await tx.delete(B).where(key);
    });
    const external = await buffs(f);
    await expect(run(f)).rejects.toBeDefined(); expect(await buffs(f)).toEqual(external);
    expect(await detail(f)).toEqual(rowBefore.profile); expect(await items(f)).toEqual(rowBefore.goods); expect(memory(f)).toEqual(before); expect(f.sent).toEqual([]);
  });

  it("does not query or write Buff SQL for a normal profile/item-only mutation, including a stale unchanged Buff", async () => {
    const f = await fixture(); await h.db.delete(B).where(eq(B.UserID, f.p.id));
    const query = vi.spyOn(h.client as { query(query: string, ...args: unknown[]): Promise<unknown> }, "query");
    await run(f, staged => { staged.info.Gold -= 7; staged.propBag.removeCountFromStack(staged.propBag.getItemAt(0), 1); });
    expect(query.mock.calls.map(call => call[0]).filter(text => text.includes('"User_Buff"'))).toEqual([]);
    expect(await buffs(f)).toEqual([]); expect(f.p.buffs[0]!.ValidCount).toBe(3);
    expect(f.p.info.Gold).toBe(93); expect(f.item.Count).toBe(2);
  });

  it("fully publishes committed Buff/profile/item state before reporting transport failure with the committed value", async () => {
    const f = await fixture(); vi.spyOn(f.p.sink, "send").mockImplementation(() => { throw new Error("injected buff transport failure"); });
    let failure: unknown; try { await run(f); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PlayerMutationCommittedError);
    expect(failure).toMatchObject({ value: { applied: true }, cause: { message: "injected buff transport failure" } });
    expect(f.p.info.Gold).toBe(93); expect(f.item.Count).toBe(2); expect(f.item.isDirty).toBe(false); expect(f.p.buffs[0]!.ValidCount).toBe(2);
    expect((await detail(f))[0]!.Gold).toBe(93); expect((await items(f))[0]!.Count).toBe(2); expect((await buffs(f))[0]!.ValidCount).toBe(2);
    await f.p.saveIntoDatabase(h.db); expect((await buffs(f))[0]!.ValidCount).toBe(2);
  });
});
