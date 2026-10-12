import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, seedDatabase, game, player, type Database, type DbHandle } from "@ddt/db";
import type { GSPacket } from "@ddt/protocol";
import { claimOnlineBox, startOnlineBoxTimer } from "../src/game/online-box.js";
import { EventData, hasClaim } from "../src/game/events.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { Templates, type ItemBoxRow } from "../src/db/templates.js";
import { World, type ServerContext } from "../src/session/context.js";
import { RoomMgr } from "../src/rooms/room-mgr.js";
import { StubFightEngine } from "../src/fight/stub.js";
import { takeCardDrop } from "../src/server.js";

// Isolated migrated PGlite only: no live database, socket or elapsed-time override outside this fixture.
let h: DbHandle, data: EventData, items: Map<number, ItemTemplate>, pools: Map<number, ItemBoxRow[]>;
let seq = 0;
const G = player.Sys_Users_Goods, D = player.Sys_Users_Detail;
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods", "Shop_Goods_Box", "User_Box", "LoadUserBox"] });
  data = new EventData(); await data.load(h.db);
  items = new Map((await h.db.select().from(game.Shop_Goods)).map((row) => [row.TemplateID, row]));
  pools = new Map();
  for (const row of await h.db.select().from(game.Shop_Goods_Box)) {
    const rows = pools.get(row.ID) ?? []; rows.push(row); pools.set(row.ID, rows);
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of ['app."EventClaims"', 'player."Sys_Users_Goods"', 'player."Sys_Users_Detail"', 'player."User_Messages"']) {
    await h.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_online_box_failure ON ${table}`));
  }
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_online_box_failure()`);
});
afterAll(async () => { await h.close(); });

async function fixture(full = false) {
  const [owner] = await h.db.insert(D).values({ UserName: `atomic_box_${++seq}`, NickName: `Box ${seq}`, Password: "test", IsFirst: 1, Grade: 9, Money: 100 }).returning();
  const info = (await loadPlayerInfo(h.db, owner!.UserID))!;
  const sent: GSPacket[] = [];
  const p = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "test" }, info, defaultMatch(info.ID), 1, "test");
  if (full) {
    const rows = await h.db.insert(G).values(Array.from({ length: 96 }, (_, place) => ({ UserID: p.id, BagType: 1, Place: place, TemplateID: 11001, Count: items.get(11001)!.MaxCount, IsBinds: true }))).returning();
    p.propBag.loadItems(rows.map((row) => ItemInfo.fromRow(row, items.get(row.TemplateID)!)));
  }
  const templates = new Templates(); templates.items = items; templates.itemBoxes = new Map(pools);
  let now = new Date("2026-10-13T01:00:00Z");
  const ctx = { db: h, templates, lang: { t: (key: string) => key }, world: new World(), now: () => now } as unknown as ServerContext;
  ctx.world.add(p); startOnlineBoxTimer(p, now);
  const advance = (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); };
  advance(15); sent.length = 0;
  return { p, ctx, sent, advance };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const claim = (f: Fixture, condition = 15) => hasClaim(h.db, f.p.id, "timebox", `2026-10-13:${condition}`);
const stored = (f: Fixture) => h.db.select().from(G).where(eq(G.UserID, f.p.id)).orderBy(G.ItemID);
const detail = async (f: Fixture) => (await h.db.select().from(D).where(eq(D.UserID, f.p.id)))[0]!;
const mails = (f: Fixture) => h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, f.p.id));
const memory = (f: Fixture) => ({ info: structuredClone(f.p.info), bags: f.p.allBags().map((b) => ({
  items: b.getItems().map((it) => ({ row: it.toRow(), dirty: it.isDirty })), removed: b.removed.map((it) => ({ row: it.toRow(), dirty: it.isDirty })),
})) });
async function rejectWrites(table: "claim" | "goods" | "profile" | "mail") {
  await h.db.execute(sql`CREATE FUNCTION player.test_online_box_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected online box failure'; END; $$`);
  const target = { claim: 'app."EventClaims"', goods: 'player."Sys_Users_Goods"', profile: 'player."Sys_Users_Detail"', mail: 'player."User_Messages"' }[table];
  await h.db.execute(sql.raw(`CREATE TRIGGER test_online_box_failure BEFORE INSERT OR UPDATE ON ${target} FOR EACH ROW EXECUTE FUNCTION player.test_online_box_failure()`));
  return () => h.db.execute(sql.raw(`DROP TRIGGER test_online_box_failure ON ${target}`));
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
function committedClaimGate(f: Fixture) {
  const entered = deferred(), release = deferred();
  const gated = new Proxy(h.db, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return async (work: (tx: Database) => Promise<unknown>) => {
      const result = await target.transaction((tx) => work(tx as unknown as Database));
      entered.resolve(); await release.promise; return result;
    };
  } }) as Database;
  return { entered, release, ctx: { ...f.ctx, db: { ...h, db: gated } } };
}
function roomFixture(f: Fixture) {
  f.p.equipBag.addItemTo(ItemInfo.createFromTemplate(items.get(7001)!, 1, 101), 6);
  return new RoomMgr({ maxRooms: 2, fight: new StubFightEngine(() => 1001), lang: (key) => key, random: () => 0 });
}

describe("online box claim/rewards/progress atomicity", () => {
  it.each(["claim", "goods", "profile", "mail"] as const)("rolls back %s failure without packets, progress, timer reset or consumed claim; retry succeeds", async (table) => {
    const f = await fixture(table === "mail"), before = memory(f), rows = await stored(f), beforeDetail = await detail(f);
    const removeFailure = await rejectWrites(table);
    await expect(claimOnlineBox(f.ctx, f.p, data)).rejects.toMatchObject({ cause: { message: "injected online box failure" } });
    expect(memory(f)).toEqual(before); expect(await stored(f)).toEqual(rows); expect(await detail(f)).toEqual(beforeDetail);
    expect(await claim(f)).toBe(false); expect(await mails(f)).toEqual([]); expect(f.sent).toEqual([]);
    await removeFailure();
    expect((await claimOnlineBox(f.ctx, f.p, data)).ok).toBe(true);
    expect(await claim(f)).toBe(true); expect(f.p.info.BoxProgression).toBe(15); expect((await detail(f)).BoxProgression).toBe(15);
    if (table === "mail") {
      const [mail] = await mails(f); expect(mail).toMatchObject({ Type: 12, ReceiverID: f.p.id });
      const ids = [mail!.Annex1, mail!.Annex2, mail!.Annex3, mail!.Annex4].map(Number);
      expect(ids.every((id) => id > 0)).toBe(true); expect(new Set(ids).size).toBe(4);
      for (const id of ids) expect((await h.db.select().from(G).where(eq(G.ItemID, id)))[0]).toMatchObject({ UserID: 0, BagType: -1, Place: -1, Count: 1, IsBinds: true });
      expect(f.sent.filter((pkt) => pkt.code === 117)).toHaveLength(1);
    } else expect(f.p.propBag.getItems().map((it) => it.TemplateID).sort((a, b) => a - b)).toEqual([11001, 11005, 11009, 11013]);
  });

  it("serializes duplicate claims and retains the original 40-minute interval after the first committed box", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => claimOnlineBox(f.ctx, f.p, data)));
    expect(results.filter((r) => r.ok)).toHaveLength(1); expect(await claim(f)).toBe(true);
    expect((await stored(f)).filter((row) => row.IsExist)).toHaveLength(4);
    f.advance(39); expect((await claimOnlineBox(f.ctx, f.p, data)).ok).toBe(false);
    f.advance(1); expect((await claimOnlineBox(f.ctx, f.p, data)).ok).toBe(true);
    expect(await claim(f, 40)).toBe(true); expect(f.p.info.BoxProgression).toBe(40);
    expect((await stored(f)).filter((row) => row.IsExist)).toHaveLength(8);
  });

  it("persists pending merge/removal and its payment with the reward; later save/reload cannot resurrect a source stack", async () => {
    const f = await fixture();
    const rows = await h.db.insert(G).values([0, 1].map((place) => ({ UserID: f.p.id, BagType: 1, Place: place, TemplateID: 11001, Count: place ? 3 : 4, IsBinds: true }))).returning();
    const dest = ItemInfo.fromRow(rows[0]!, items.get(11001)!), source = ItemInfo.fromRow(rows[1]!, items.get(11001)!);
    f.p.propBag.loadItems([dest, source]); f.p.propBag.moveItem(1, 0, 3); f.p.info.Money -= 10;
    const before = memory(f), removeFailure = await rejectWrites("profile"); f.sent.length = 0;
    await expect(claimOnlineBox(f.ctx, f.p, data)).rejects.toBeDefined();
    expect(memory(f)).toEqual(before); expect(dest.Count).toBe(7); expect((await detail(f)).Money).toBe(100); expect(await claim(f)).toBe(false);
    await removeFailure(); expect((await claimOnlineBox(f.ctx, f.p, data)).ok).toBe(true);
    expect(dest.Count).toBe(8); expect(dest.isDirty).toBe(false); expect(f.p.propBag.removed).toEqual([]);
    expect((await detail(f)).Money).toBe(90);
    expect((await stored(f)).find((it) => it.ItemID === source.ItemID)).toMatchObject({ IsExist: false, BagType: -1, Place: -1 });
    await f.p.saveIntoDatabase(h.db);
    const loaded = await loadUserItems(h.db, f.p.id, (id) => items.get(id));
    expect(loaded.get(1)!.find((it) => it.TemplateID === 11001)!.Count).toBe(8);
    expect(loaded.get(1)!).toHaveLength(4); expect((await detail(f)).BoxProgression).toBe(15);
  });

  it("does not expose new ItemIDs/currencies before commit and makes an autosave wait through commit-to-memory apply", async () => {
    const f = await fixture(), gate = committedClaimGate(f);
    const fresh = ItemInfo.createFromTemplate(items.get(11001)!, 2, 0, f.ctx.now()); fresh.IsBinds = true;
    f.p.propBag.addItemTo(fresh, 0); f.p.info.Money = 90; f.sent.length = 0;
    const receiving = claimOnlineBox(gate.ctx, f.p, data);
    await gate.entered.promise;
    expect(fresh.ItemID).toBe(0); expect(fresh.Count).toBe(2); expect(f.p.info.BoxProgression).toBe(0); expect(f.sent).toEqual([]);
    expect((await detail(f)).BoxProgression).toBe(15);
    let saved = false; const saving = f.p.saveIntoDatabase(h.db).then(() => { saved = true; });
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(saved).toBe(false);
    gate.release.resolve(); expect((await receiving).ok).toBe(true); await saving;
    expect(fresh.ItemID).toBeGreaterThan(0); expect(fresh.Count).toBe(3); expect(fresh.isDirty).toBe(false);
    expect((await stored(f)).filter((it) => it.IsExist)).toHaveLength(4);
    expect((await detail(f)).BoxProgression).toBe(15); expect((await detail(f)).Money).toBe(90);
  });

  it("retains currency/experience mapping and isolates another character", async () => {
    const f = await fixture(), other = await fixture(), before = memory(other);
    const row = pools.get(1120090)![0]!;
    f.ctx.templates.itemBoxes.set(1120090, [-100, -200, -1100, -800, 11107].map((TemplateId) => ({ ...row, TemplateId, IsSelect: true, ItemCount: 7 })));
    const old = structuredClone(f.p.info), removeFailure = await rejectWrites("profile");
    // PostgreSQL bytea is Buffer; structuredClone normalizes it to Uint8Array.
    // Compare both snapshots equally while still checking every byte.
    await expect(claimOnlineBox(f.ctx, f.p, data)).rejects.toBeDefined(); expect(structuredClone(f.p.info)).toEqual(old); expect(f.sent).toEqual([]);
    await removeFailure(); expect((await claimOnlineBox(f.ctx, f.p, data)).ok).toBe(true);
    for (const key of ["Gold", "Money", "GiftToken", "myHonor", "GP"] as const) expect(f.p.info[key]).toBe(old[key] + 7);
    expect((await detail(f)).Money).toBe(old.Money + 7); expect(memory(other)).toEqual(before); expect(await claim(other)).toBe(false);
  });

  it("rejects an actual in-room claim without consuming eligibility or resetting elapsed time", async () => {
    const f = await fixture(), rooms = roomFixture(f);
    rooms.createRoom(f.p, "online-box-room", "", 0, 2); rooms.tick();
    expect(f.p.currentRoom).not.toBeNull();
    const before = memory(f); f.sent.length = 0;
    expect((await claimOnlineBox(f.ctx, f.p, data)).ok).toBe(false);
    expect(memory(f)).toEqual(before); expect(await claim(f)).toBe(false); expect(f.sent).toEqual([]);
    f.p.currentRoom!.removePlayer(f.p);
    expect((await claimOnlineBox(f.ctx, f.p, data)).ok).toBe(true); // Same clock; all 15 minutes remain earned.
    expect(await claim(f)).toBe(true);
  });

  it.each(["create", "enter"])("queues real room %s across COMMIT-to-memory apply and preserves the following card drop", async (kind) => {
    const f = await fixture(), rooms = roomFixture(f), gate = committedClaimGate(f);
    if (kind === "enter") {
      const host = await fixture(); roomFixture(host);
      rooms.createRoom(host.p, "host", "", 0, 2); rooms.tick();
      rooms.enterRoom(f.p, host.p.currentRoom!.RoomId, "", 0);
    } else rooms.createRoom(f.p, "queued", "", 0, 2);
    const receiving = claimOnlineBox(gate.ctx, f.p, data);
    await gate.entered.promise;
    try {
      expect((await detail(f)).BoxProgression).toBe(15); // Real DB COMMIT; live apply remains held.
      expect(f.p.info.BoxProgression).toBe(0); rooms.tick(); expect(f.p.currentRoom).toBeNull();
    } finally { gate.release.resolve(); await receiving; }
    await f.p.withPersistenceLock(async () => {});
    expect(f.p.currentRoom).not.toBeNull(); expect(f.p.info.BoxProgression).toBe(15);
    f.ctx.templates.dropConditions.push({ CondictionType: 1, Para1: ",0,", Para2: ",0,", DropID: 900 } as never);
    f.ctx.templates.dropItems.set(900, [{ ItemId: 11001, Random: 100, BeginData: 1, EndData: 1, IsBind: true, ValueDate: 0 } as never]);
    expect(takeCardDrop(f.ctx.templates, f.p, 0)).toEqual({ templateId: 11001, count: 1 });
    const material = f.p.propBag.getItemByTemplateID(0, 11001)!;
    expect(material.Count).toBe(2);
    expect((await claimOnlineBox(f.ctx, f.p, data)).ok).toBe(false);
    f.p.currentRoom!.removePlayer(f.p); await f.p.saveIntoDatabase(h.db);
    expect((await stored(f)).find((item) => item.ItemID === material.ItemID)?.Count).toBe(2);
    expect((await detail(f)).BoxProgression).toBe(15); expect(await claim(f)).toBe(true);
  });

  it("keeps committed rewards and progress in memory when a notification fails, so the next save cannot undo them", async () => {
    const f = await fixture();
    vi.spyOn(f.p.sink, "send").mockImplementationOnce(() => { throw new Error("injected transport failure"); });
    await expect(claimOnlineBox(f.ctx, f.p, data)).rejects.toThrow("injected transport failure");
    expect(await claim(f)).toBe(true); expect(f.p.info.BoxProgression).toBe(15);
    expect(f.p.propBag.getItems()).toHaveLength(4);
    await f.p.saveIntoDatabase(h.db);
    expect((await detail(f)).BoxProgression).toBe(15); expect((await stored(f)).filter((row) => row.IsExist)).toHaveLength(4);
    expect((await claimOnlineBox(f.ctx, f.p, data)).ok).toBe(false);
  });
});
