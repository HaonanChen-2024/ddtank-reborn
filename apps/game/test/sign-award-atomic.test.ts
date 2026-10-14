import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, seedDatabase, game, player, type Database, type DbHandle } from "@ddt/db";
import type { GSPacket } from "@ddt/protocol";
import { eventsRuntime, registerEvents, signAward } from "../src/handlers/events.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { hasClaim, monthKey } from "../src/game/events.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { Templates } from "../src/db/templates.js";
import { World, type ServerContext } from "../src/session/context.js";
import type { GameClient } from "../src/session/client.js";
import { WorldBossSettlementGate } from "../src/fight/world-boss-settlement.js";

// Explicit migrated in-memory PGlite. No configured runtime DB, server or sockets.
let h: DbHandle, items: Map<number, ItemTemplate>, seq = 0;
const D = player.Sys_Users_Detail, G = player.Sys_Users_Goods, M = player.User_Messages;
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods"] });
  items = new Map((await h.db.select().from(game.Shop_Goods)).map((row) => [row.TemplateID, row]));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of ['app."EventClaims"', 'player."Sys_Users_Goods"', 'player."Sys_Users_Detail"', 'player."User_Messages"']) {
    await h.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_sign_failure ON ${table}`));
  }
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_sign_failure()`);
});
afterAll(async () => { await h.close(); });

async function fixture(full = false, sex = true) {
  const [owner] = await h.db.insert(D).values({ UserName: `atomic_sign_${++seq}`, NickName: `Sign ${seq}`, Password: "test", IsFirst: 1, Grade: 9, GP: 95, Gold: 100, Money: 100, GiftToken: 10, Sex: sex }).returning();
  const info = (await loadPlayerInfo(h.db, owner!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "test" }, info, defaultMatch(info.ID), 1, "test");
  if (full) {
    const rows = await h.db.insert(G).values(Array.from({ length: 96 }, (_, place) => ({ UserID: p.id, BagType: 1, Place: place, TemplateID: 11001, Count: items.get(11001)!.MaxCount, IsBinds: true }))).returning();
    p.propBag.loadItems(rows.map((row) => ItemInfo.fromRow(row, items.get(row.TemplateID)!)));
  }
  let now = new Date("2026-10-14T01:00:00Z");
  const templates = new Templates(); templates.items = items;
  const ctx = { db: h, templates, lang: { t: (key: string) => key }, world: new World(), now: () => now } as unknown as ServerContext;
  ctx.world.add(p);
  const data = eventsRuntime(ctx).data;
  const award = (id: number, type: number, template: number, count: number, sex: number, days = 3) => ({ ID: id, Type: type, TemplateID: template, Count: count, ValidDate: 7, IsBinds: sex !== 0, Sex: sex, AwardDays: days, GetWay: 0 });
  data.dailyAward = [award(1, 1, -100, 31, 0), award(2, 1, -200, 11, 0), award(3, 7, -1100, 9, 0),
    award(4, 1, 11001, 2, 0), award(5, 1, 11005, 1, 1), award(6, 1, 11009, 1, 2), award(7, 1, -100, 17, 0, 6)] as never;
  await h.db.insert(player.DailyLogList).values({ UserID: p.id, DayLog: Array(6).fill("True").join(","), UserAwardLog: 6, LastDate: now });
  sent.length = 0;
  return { p, ctx, sent, data, setNow: (date: Date) => { now = date; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const claim = (f: Fixture, tier = 3) => hasClaim(h.db, f.p.id, "signaward", `${monthKey(f.ctx.now())}:${tier}`);
const goods = () => h.db.select().from(G).orderBy(G.ItemID);
const mails = () => h.db.select().from(M).orderBy(M.ID);
const detail = async (f: Fixture) => (await h.db.select().from(D).where(eq(D.UserID, f.p.id)))[0]!;
const memory = (f: Fixture) => ({ info: structuredClone(f.p.info), match: structuredClone(f.p.match), bags: f.p.allBags().map((b) => ({
  capacity: b.capacity, items: b.getItems().map((it) => ({ row: it.toRow(), dirty: it.isDirty, locked: it.cellLocked })),
  removed: b.removed.map((it) => ({ row: it.toRow(), dirty: it.isDirty, locked: it.cellLocked })),
})) });
async function rejectWrites(table: "claim" | "goods" | "profile" | "mail") {
  await h.db.execute(sql`CREATE FUNCTION player.test_sign_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected sign failure'; END; $$`);
  const target = { claim: 'app."EventClaims"', goods: 'player."Sys_Users_Goods"', profile: 'player."Sys_Users_Detail"', mail: 'player."User_Messages"' }[table];
  await h.db.execute(sql.raw(`CREATE TRIGGER test_sign_failure BEFORE INSERT OR UPDATE ON ${target} FOR EACH ROW EXECUTE FUNCTION player.test_sign_failure()`));
  return () => h.db.execute(sql.raw(`DROP TRIGGER test_sign_failure ON ${target}`));
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
function committedGate(f: Fixture) {
  const entered = deferred(), release = deferred();
  const db = new Proxy(h.db, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return async (work: (tx: Database) => Promise<unknown>) => {
      const result = await target.transaction((tx) => work(tx as unknown as Database));
      entered.resolve(); await release.promise; return result;
    };
  } }) as Database;
  // EventsRuntime is keyed by ServerContext identity; keep this fixture's awards.
  f.ctx.db = { ...h, db };
  return { entered, release, ctx: f.ctx };
}

describe("sign award claim/rewards atomicity", () => {
  it.each(["claim", "goods", "profile", "mail"] as const)("rolls back %s failure, including detached mail attachments and currencies; retry succeeds", async (table) => {
    const f = await fixture(table === "mail"), before = memory(f), beforeGoods = await goods(), beforeMail = await mails(), beforeDetail = await detail(f);
    const removeFailure = await rejectWrites(table);
    await expect(signAward(f.ctx, f.p, 3)).rejects.toBeDefined();
    expect(memory(f)).toEqual(before); expect(await goods()).toEqual(beforeGoods); expect(await mails()).toEqual(beforeMail);
    expect(await detail(f)).toEqual(beforeDetail); expect(await claim(f)).toBe(false); expect(f.sent).toEqual([]);
    await removeFailure(); expect(await signAward(f.ctx, f.p, 3)).toBe(true); expect(await claim(f)).toBe(true);
    expect(f.p.info.Gold).toBe(before.info.Gold + 31); expect(f.p.info.Money).toBe(before.info.Money + 11); expect(f.p.info.GiftToken).toBe(before.info.GiftToken + 9);
    if (table === "mail") {
      const received = (await mails()).filter((m) => m.ReceiverID === f.p.id);
      expect(received).toHaveLength(1); expect(received[0]).toMatchObject({ Type: 12, Title: "Prêmio de presença" });
      for (const annex of [received[0]!.Annex1, received[0]!.Annex2]) expect((await goods()).find((it) => it.ItemID === Number(annex))).toMatchObject({ UserID: 0, BagType: -1, Place: -1 });
      expect(f.sent.filter((pkt) => pkt.code === 117)).toHaveLength(1);
    }
  });

  it("rolls back a grant exception after detached currencies changed and leaves packet 90 awaited by the original dispatcher", async () => {
    const f = await fixture(), before = memory(f), beforeGoods = await goods(), beforeDetail = await detail(f);
    const find = f.ctx.templates.findItem;
    const failure = vi.spyOn(f.ctx.templates, "findItem").mockImplementation((id) => { if (id === 11005) throw new Error("injected grant failure"); return find(id); });
    const registry = new HandlerRegistry(); registerEvents(registry);
    const request = registry.get(90)!.handle(f.ctx, { player: f.p } as GameClient, { readInt: () => 3 } as GSPacket);
    expect(request).toBeInstanceOf(Promise); await expect(request).rejects.toThrow("injected grant failure");
    expect(memory(f)).toEqual(before); expect(await goods()).toEqual(beforeGoods); expect(await detail(f)).toEqual(beforeDetail);
    expect(await claim(f)).toBe(false); expect(f.sent).toEqual([]);
    failure.mockRestore(); expect(await signAward(f.ctx, f.p, 3)).toBe(true);
  });

  it("grants exactly once for concurrent same-player/month/tier requests, without changing sex, binding or validity", async () => {
    const f = await fixture(), before = structuredClone(f.p.info);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => signAward(f.ctx, f.p, 3)));
    expect(outcomes.filter(Boolean)).toHaveLength(1); expect(await claim(f)).toBe(true);
    expect(f.p.info.Gold).toBe(before.Gold + 31); expect(f.p.info.GiftToken).toBe(before.GiftToken + 9);
    expect(f.p.propBag.getItems().map((it) => ({ id: it.TemplateID, count: it.Count, bound: it.IsBinds, days: it.ValidDate }))).toEqual([
      { id: 11001, count: 2, bound: false, days: 7 }, { id: 11005, count: 1, bound: true, days: 7 },
    ]);
    expect(f.sent.some((pkt) => pkt.code === 90)).toBe(false); // Original success is GM_NOTICE, no new 90 reply.
  });

  it("keeps unknown/unreached tiers and wrong months unclaimed, then isolates tiers, months and another female player", async () => {
    const f = await fixture(), other = await fixture(false, false), otherBefore = memory(other);
    await h.db.update(player.DailyLogList).set({ DayLog: "True,True" }).where(eq(player.DailyLogList.UserID, f.p.id));
    expect(await signAward(f.ctx, f.p, 3)).toBe(false); expect(await signAward(f.ctx, f.p, 18)).toBe(false); expect(await claim(f)).toBe(false);
    await h.db.update(player.DailyLogList).set({ DayLog: Array(6).fill("True").join(","), LastDate: new Date("2026-09-14T01:00:00Z") }).where(eq(player.DailyLogList.UserID, f.p.id));
    expect(await signAward(f.ctx, f.p, 3)).toBe(false);
    await h.db.update(player.DailyLogList).set({ LastDate: f.ctx.now() }).where(eq(player.DailyLogList.UserID, f.p.id));
    expect(await signAward(f.ctx, f.p, 3)).toBe(true); expect(await signAward(f.ctx, f.p, 6)).toBe(true); expect(await claim(f, 6)).toBe(true);
    expect(memory(other)).toEqual(otherBefore); expect(await claim(other)).toBe(false);
    expect(await signAward(other.ctx, other.p, 3)).toBe(true); expect(other.p.propBag.getItems().map((it) => it.TemplateID)).toEqual([11001, 11009]);
    f.setNow(new Date("2026-11-14T01:00:00Z"));
    await h.db.update(player.DailyLogList).set({ LastDate: f.ctx.now() }).where(eq(player.DailyLogList.UserID, f.p.id));
    expect(await signAward(f.ctx, f.p, 3)).toBe(true); expect(await claim(f)).toBe(true);
    expect(await hasClaim(h.db, f.p.id, "signaward", "2026-10:3")).toBe(true);
  });

  it("persists pending merge/removal and payment, preserves original item identity, and cannot resurrect a source after save", async () => {
    const f = await fixture();
    const rows = await h.db.insert(G).values([0, 1].map((place) => ({ UserID: f.p.id, BagType: 1, Place: place, TemplateID: 11001, Count: place ? 3 : 4, IsBinds: false, ValidDate: 7, BeginDate: f.ctx.now() }))).returning();
    const dest = ItemInfo.fromRow(rows[0]!, items.get(11001)!), source = ItemInfo.fromRow(rows[1]!, items.get(11001)!);
    f.p.propBag.loadItems([dest, source]); f.p.propBag.moveItem(1, 0, 3); f.p.info.Money -= 10; f.sent.length = 0;
    const before = memory(f), removeFailure = await rejectWrites("profile");
    await expect(signAward(f.ctx, f.p, 3)).rejects.toBeDefined(); expect(memory(f)).toEqual(before); expect(await claim(f)).toBe(false);
    await removeFailure(); expect(await signAward(f.ctx, f.p, 3)).toBe(true);
    expect(f.p.propBag.getItemAt(0)).toBe(dest); expect(dest.Count).toBe(9); expect(dest.isDirty).toBe(false); expect(f.p.propBag.removed).toEqual([]);
    expect((await goods()).find((it) => it.ItemID === source.ItemID)).toMatchObject({ IsExist: false, BagType: -1, Place: -1 });
    await f.p.saveIntoDatabase(h.db);
    const loaded = await loadUserItems(h.db, f.p.id, (id) => items.get(id));
    expect(loaded.get(1)!.find((it) => it.TemplateID === 11001)!.Count).toBe(9); expect((await detail(f)).Money).toBe(101);
  });

  it("keeps live IDs/currencies private until COMMIT publication and queues autosave through that gap", async () => {
    const f = await fixture(), gate = committedGate(f), before = memory(f);
    const receiving = signAward(gate.ctx, f.p, 3); await gate.entered.promise;
    expect(memory(f)).toEqual(before); expect(f.sent).toEqual([]); expect((await detail(f)).Gold).toBe(before.info.Gold + 31);
    let saved = false; const saving = f.p.saveIntoDatabase(h.db).then(() => { saved = true; });
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(saved).toBe(false);
    gate.release.resolve(); expect(await receiving).toBe(true); await saving;
    expect(f.p.propBag.getItems().every((it) => it.ItemID > 0)).toBe(true); expect((await detail(f)).Gold).toBe(f.p.info.Gold);
    expect(await signAward(f.ctx, f.p, 3)).toBe(false);
  });

  it("retains committed rewards on transport failure, releases barriers and prevents a retry from duplicating them", async () => {
    const f = await fixture(), before = structuredClone(f.p.info);
    vi.spyOn(f.p.sink, "send").mockImplementationOnce(() => { throw new Error("injected transport failure"); });
    await expect(signAward(f.ctx, f.p, 3)).rejects.toThrow("injected transport failure");
    expect(await claim(f)).toBe(true); expect(f.p.info.Gold).toBe(before.Gold + 31); expect(f.p.propBag.getItems()).toHaveLength(2);
    expect(f.p.worldBossAwardPending).toBeNull(); await f.p.saveIntoDatabase(h.db);
    expect((await detail(f)).Gold).toBe(f.p.info.Gold); expect(await signAward(f.ctx, f.p, 3)).toBe(false);
  });

  it("preserves AddGP(count,false), the real grade hooks and saved grade even when the first socket notification fails", async () => {
    const f = await fixture(); f.data.dailyAward = [{ ...f.data.dailyAward[0]!, TemplateID: 11107, Count: 7 }] as never;
    f.p.gradeForGp = (gp) => gp >= 100 ? 10 : 9;
    f.p.buffs = [{ UserID: f.p.id, Type: 13, Value: 100, BeginDate: f.ctx.now(), ValidDate: 999999, TemplateID: 0, ValidCount: 0, Data: null, IsExist: true }];
    const grade = vi.fn(), refresh = vi.fn(); f.p.onGradeUp = grade; f.p.questInv = { refresh } as never;
    vi.spyOn(f.p.sink, "send").mockImplementationOnce(() => { throw new Error("injected grade notification failure"); });
    await expect(signAward(f.ctx, f.p, 3)).rejects.toThrow("injected grade notification failure");
    expect(f.p.info.GP).toBe(102); expect(f.p.info.Grade).toBe(10); expect(grade).toHaveBeenCalledTimes(1); expect(grade).toHaveBeenCalledWith(9); expect(refresh).toHaveBeenCalledTimes(1);
    expect(await claim(f)).toBe(true); expect((await detail(f)).GP).toBe(102); expect((await detail(f)).Grade).toBe(10);
    f.p.questInv = null; await f.p.saveIntoDatabase(h.db); expect((await detail(f)).GP).toBe(102);
  });

  it.each([false, true])("keeps existing room eligibility and releases the original fight lease after failure/success (failure=%s)", async (fail) => {
    const f = await fixture(), gate = new WorldBossSettlementGate();
    f.p.currentRoom = { game: { holdWorldBossSettlement: () => gate.acquire() }, sendToAll: () => {} } as never;
    let drained = 0;
    const removeFailure = fail ? await rejectWrites("profile") : null;
    const pending = signAward(f.ctx, f.p, 3);
    await Promise.resolve(); await Promise.resolve();
    expect(gate.held).toBe(true); const queued = gate.defer(() => { drained++; });
    if (fail) { await expect(pending).rejects.toBeDefined(); expect(await claim(f)).toBe(false); await removeFailure!(); }
    else expect(await pending).toBe(true);
    await queued; expect(gate.held).toBe(false); expect(drained).toBe(1); expect(f.p.worldBossAwardPending).toBeNull();
    if (fail) expect(await signAward(f.ctx, f.p, 3)).toBe(true);
  });
});
