import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, seedDatabase, game, player, type Database, type DbHandle } from "@ddt/db";
import { GSPacket, RollingKeyCipher, encodeFrame } from "@ddt/protocol";
import type { FightEvent } from "@ddt/fight";
import { EventScheduler, type ActiveWindow } from "../src/game/scheduler.js";
import { eventsRuntime, registerEvents, worldBossDamage, worldBossFightWindow } from "../src/handlers/events.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { GameClient } from "../src/session/client.js";
import { testConfig } from "../src/config.js";
import { GamePlayer } from "../src/game/player.js";
import { worldBossRanks } from "../src/game/world-boss.js";
import { awardWorldBoss } from "../src/game/world-boss-rewards.js";
import { WorldBossSettlementGate } from "../src/fight/world-boss-settlement.js";
import { grantRewards, hasClaim } from "../src/game/events.js";
import { ItemInfo } from "../src/game/item.js";
import { defaultMatch } from "../src/game/player-info.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { Templates } from "../src/db/templates.js";
import { World, type ServerContext } from "../src/session/context.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import { BaseRoom } from "../src/rooms/room.js";
import { RoomMgr } from "../src/rooms/room-mgr.js";
import { quitPlayer } from "../src/session/login.js";
import { HotSpringMgr, SpaRoom } from "../src/handlers/hotspring.js";
import { data, pves } from "../../../packages/fight/test/pve-data.js";

// All dates, characters and failures in this file belong to a fresh in-memory PGlite DB.
let h: DbHandle, templates: Templates, seq = 0;
const NOW = new Date("2026-10-13T12:00:00Z");
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h); await seedDatabase(h, { only: ["Shop_Goods"] });
  templates = new Templates(); templates.items = new Map((await h.db.select().from(game.Shop_Goods)).map((t) => [t.TemplateID, t]));
});
afterAll(async () => { await h.close(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of ['app."EventClaims"', 'player."Sys_Users_Goods"', 'player."Sys_Users_Detail"', 'player."User_Messages"']) {
    await h.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_boss_failure ON ${table}`));
  }
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_boss_failure()`);
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
function window(id: number, params: Record<string, unknown> = {}): ActiveWindow {
  return { key: `${id}@${NOW.toISOString()}`, start: NOW, end: new Date(+NOW + 60_000), ev: { id, kind: "worldboss", title: "test", enabled: true,
    weekdays: "0,1,2,3,4,5,6", startTime: "12:00", durationMin: 1, startDate: null, endDate: null, params: { bossHp: 1000, pveId: 1243, ...params } } };
}
async function fixture() {
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `boss_${++seq}`, NickName: `Boss ${seq}`, IsFirst: 1 }).returning();
  const info = (await loadPlayerInfo(h.db, row!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "test" }, info, defaultMatch(info.ID), 1, "test");
  let now = NOW;
  const ctx = { db: h, templates, world: new World(), now: () => now, log: { info: vi.fn(), error: vi.fn(), debug: vi.fn() }, lang: { t: (k: string) => k } } as unknown as ServerContext;
  ctx.world.add(p); const rt = eventsRuntime(ctx); return { p, ctx, rt, sent, setNow: (value: Date) => { now = value; } };
}

describe("world boss occurrence ownership", () => {
  it("normal lobby admission does not earn a rank or reward without damage", async () => {
    const f = await fixture(), w = window(30, { rankAwards: [{ rank: 10, giftToken: 50 }] }); await f.rt.onStart(w);
    const registry = new HandlerRegistry(); registerEvents(registry);
    const pkt = new GSPacket(102); pkt.writeByte(34); pkt.writeInt(265); pkt.writeInt(1030); pkt.offset = 20;
    await registry.get(102)!.handle(f.ctx, { player: f.p } as GameClient, pkt);
    expect(f.rt.boss.players.has(f.p.id)).toBe(true); expect(f.rt.boss.rank.size).toBe(0);
    const before = f.p.info.GiftToken; await f.rt.onEnd(w); expect(f.p.info.GiftToken).toBe(before);
  });
  it("ranks only finite positive damage, with stable user-id ties", () => {
    const rank = new Map([[3, { nick: "3", damage: 20 }], [1, { nick: "1", damage: 20 }], [2, { nick: "2", damage: 0 }],
      [4, { nick: "4", damage: NaN }], [5, { nick: "5", damage: Infinity }], [6, { nick: "6", damage: -1 }]]);
    expect(worldBossRanks(rank).map((r) => r.id)).toEqual([1, 3]);
  });
  it("rejects wrong windows, duplicates, invalid damage and results after the deadline", async () => {
    const f = await fixture(), w = window(1); await f.rt.onStart(w);
    expect(worldBossFightWindow(f.ctx, 1243)).toEqual({ key: w.key, blood: 1000 });
    expect(worldBossFightWindow(f.ctx, 999)).toBeNull();
    const attempt = { windowKey: w.key, fightId: 1 };
    for (const damage of [0, -1, NaN, Infinity, 0.5]) worldBossDamage(f.ctx, f.p, damage, attempt);
    worldBossDamage(f.ctx, f.p, 200, { ...attempt, windowKey: "old" });
    expect(f.rt.boss.rank.size).toBe(0); expect(f.rt.boss.blood).toBe(1000);
    worldBossDamage(f.ctx, f.p, 200, attempt); worldBossDamage(f.ctx, f.p, 500, attempt);
    expect(f.rt.boss.blood).toBe(800); expect(f.rt.boss.rank.get(f.p.id)?.damage).toBe(200);
    f.setNow(w.end); worldBossDamage(f.ctx, f.p, 300, { ...attempt, fightId: 2 });
    expect(f.rt.boss.blood).toBe(800); expect(worldBossFightWindow(f.ctx, 1243)).toBeNull();
  });
  it("the actual DdtGame result dispatcher carries the admission window rather than the current one", async () => {
    const f = await fixture(), first = window(11); await f.rt.onStart(first);
    const seen = vi.fn((m, hurt, attempt) => worldBossDamage(f.ctx, m, hurt, attempt));
    const engine = new DdtFightEngine({ manualClock: true, seed: () => 5,
      pve: { data, pveInfo: (id) => pves.get(id), drop: () => null },
      worldBossWindow: (id) => worldBossFightWindow(f.ctx, id), onWorldBossHurt: seen });
    const game = engine.startPve({ roomId: 1, roomType: 14, gameType: 7, timeType: 3, pveId: 1243, hardLevel: 0, levelLimits: 0, currentFloor: 1, players: [f.p], onStopped: () => {} });
    expect(game).not.toBeNull(); await f.rt.onEnd(first); await f.rt.onStart(window(12));
    // This is a result-boundary unit fixture, not a claim of a naturally completed live fight.
    const event: FightEvent = { cmd: "GAME_ALL_MISSION_OVER", code: 115, livingId: 0, isWin: false, resources: [], roomType: 14, gameType: 7,
      players: [{ userId: f.p.id, totalKill: 0, totalHurt: 100, totalScore: 0, totalCure: 0, totalExp: 0, isWin: false, canTakeOut: 0, turnNum: 1 }] };
    vi.spyOn(engine.games.get(game!.id)!.game, "update").mockReturnValueOnce([event]); engine.tick(Date.now() + 1);
    expect(seen).toHaveBeenCalledWith(f.p, 100, { windowKey: first.key, fightId: game!.id });
    expect(f.rt.boss.blood).toBe(1000); expect(f.rt.boss.rank.size).toBe(0); game!.stop();
  });
  it("freezes settlement before awaits and keeps the occurrence retryable after a notification failure", async () => {
    const f = await fixture(), w = window(31); await f.rt.onStart(w);
    worldBossDamage(f.ctx, f.p, 80, { windowKey: w.key, fightId: 1 });
    const transport = vi.spyOn(f.p, "send").mockImplementationOnce(() => { throw new Error("socket failed"); });
    await expect(f.rt.onEnd(w)).rejects.toThrow("socket failed");
    expect(f.rt.boss.window?.key).toBe(w.key); expect(worldBossFightWindow(f.ctx, 1243)).toBeNull();
    worldBossDamage(f.ctx, f.p, 10, { windowKey: w.key, fightId: 2 });
    f.rt.boss.rank.get(f.p.id)!.damage = 900;
    expect(f.rt.boss.settlement?.rank).toEqual([{ id: f.p.id, nick: f.p.info.NickName, damage: 80 }]);
    await expect(f.rt.onStart(window(32))).rejects.toThrow("awaiting settlement");
    transport.mockRestore(); await f.rt.onEnd(w); expect(f.rt.boss.window).toBeNull();
    await f.rt.onStart(window(32)); expect(f.rt.boss.rank.size).toBe(0); expect(f.rt.boss.settlement).toBeNull();
  });
});

describe("scheduler settlement retries", () => {
  it("ends a partly started occurrence even when its notification failed until after its deadline", async () => {
    const f = await fixture(), w = window(40); f.rt.scheduler.setEvents([w.ev]);
    vi.spyOn(f.p, "send").mockImplementationOnce(() => { throw new Error("start socket failed"); });
    await expect(f.rt.scheduler.tick()).rejects.toThrow("start socket failed");
    expect(f.rt.boss.window?.key).toBe(w.key);
    f.setNow(w.end); await f.rt.scheduler.tick(); expect(f.rt.boss.window).toBeNull();
    f.rt.scheduler.setEvents([{ ...window(41).ev, startTime: "12:01" }]); await f.rt.scheduler.tick();
    expect(f.rt.boss.window?.ev.id).toBe(41);
  });
  it("coalesces concurrent ticks and retries a failed end without losing the old occurrence", async () => {
    let now = NOW, fail = true; const entered = deferred(), release = deferred(), starts: string[] = [], ends: string[] = [];
    const s = new EventScheduler(() => now, { onStart: (w) => { starts.push(w.key); }, onEnd: async (w) => {
      ends.push(w.key); entered.resolve(); await release.promise; if (fail) throw new Error("SQL failed");
    } });
    const w = window(20); s.setEvents([w.ev]); await s.tick(); now = w.end;
    const a = s.tick(), b = s.tick(); expect(a).toBe(b); await entered.promise; release.resolve();
    await expect(a).rejects.toThrow("SQL failed"); expect(s.open.has(w.key)).toBe(true); expect(s.isOpen("worldboss")).toBeUndefined();
    fail = false; await s.tick(); await s.tick(); expect(ends).toEqual([w.key, w.key]); expect(starts).toEqual([w.key]); expect(s.open.size).toBe(0);
  });
  it("does not repeat successful earlier ends or start a replacement while a later end fails", async () => {
    let now = NOW, fail = true; const ended: number[] = [], started: number[] = [];
    const s = new EventScheduler(() => now, { onStart: (w) => { started.push(w.ev.id); }, onEnd: (w) => { ended.push(w.ev.id); if (w.ev.id === 22 && fail) throw new Error("retry"); } });
    s.setEvents([window(21).ev, window(22).ev]); await s.tick(); now = new Date(+NOW + 60_000);
    s.setEvents([{ ...window(23).ev, startTime: "12:01" }]); await expect(s.tick()).rejects.toThrow("retry");
    expect(ended).toEqual([21, 22]); expect(started).toEqual([21, 22]); fail = false; await s.tick();
    expect(ended).toEqual([21, 22, 22]); expect(started).toEqual([21, 22, 23]);
  });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function putMaterial(f: Fixture, count = 3) {
  const [row] = await h.db.insert(player.Sys_Users_Goods).values({ UserID: f.p.id, BagType: 1, Place: 0, TemplateID: 11001, Count: count, IsBinds: true }).returning();
  const item = ItemInfo.fromRow(row!, templates.findItem(11001)!); f.p.propBag.loadItems([item]); return item;
}
const mails = (id: number) => h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, id));
const goods = (id: number) => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, id)).orderBy(player.Sys_Users_Goods.ItemID);
const profileRow = async (id: number) => (await h.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, id)))[0]!;
async function rejectBossWrites(table: string) {
  await h.db.execute(sql`CREATE FUNCTION player.test_boss_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected boss failure'; END; $$`);
  await h.db.execute(sql.raw(`CREATE TRIGGER test_boss_failure BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION player.test_boss_failure()`));
  return () => h.db.execute(sql.raw(`DROP TRIGGER test_boss_failure ON ${table}`));
}
function commitGate(f: Fixture, beforeCommit = false) {
  const entered = deferred(), release = deferred();
  f.ctx.db = { ...h, db: new Proxy(h.db, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return async (work: (tx: Database) => Promise<unknown>) => {
      const result = await target.transaction(async (tx) => {
        const value = await work(tx as unknown as Database);
        if (beforeCommit) { entered.resolve(); await release.promise; }
        return value;
      });
      if (!beforeCommit) { entered.resolve(); await release.promise; }
      return result;
    };
  } }) as Database };
  return { entered, release };
}

describe("ranked world boss award transactions", () => {
  it.each(['app."EventClaims"', 'player."Sys_Users_Goods"', 'player."Sys_Users_Detail"', 'player."User_Messages"'])("rolls back a real %s SQL failure, then retries the same frozen award", async (table) => {
    const f = await fixture(), item = await putMaterial(f);
    if (table.includes("User_Messages")) f.p.propBag.capacity = 1;
    f.p.info.Gold = 90; item.Count = 5; item.isDirty = true;
    const before = { info: structuredClone(f.p.info), row: item.toRow(), dirty: item.isDirty }, stored = await goods(f.p.id), oldProfile = await profileRow(f.p.id);
    const w = window(50 + seq, { rankAwards: [{ rank: 1, giftToken: 7, gold: 2, items: [{ templateId: 11005, count: 1 }] }] });
    await f.rt.onStart(w); worldBossDamage(f.ctx, f.p, 70, { windowKey: w.key, fightId: 1 }); f.sent.length = 0;
    const remove = await rejectBossWrites(table);
    await expect(f.rt.onEnd(w)).rejects.toThrow();
    expect({ info: structuredClone(f.p.info), row: item.toRow(), dirty: item.isDirty }).toEqual(before);
    expect(await goods(f.p.id)).toEqual(stored); expect(await profileRow(f.p.id)).toEqual(oldProfile);
    expect(await hasClaim(h.db, f.p.id, "worldboss", w.key)).toBe(false); expect(await mails(f.p.id)).toHaveLength(0); expect(f.sent).toHaveLength(0);
    // Mutating the live configuration and rank cannot change this retry.
    w.ev.params.rankAwards = [{ rank: 1, giftToken: 999 }]; f.rt.boss.rank.get(f.p.id)!.damage = 1;
    await remove(); await f.rt.onEnd(w); await f.rt.onEnd(w);
    expect(f.p.info.GiftToken).toBe(before.info.GiftToken + 7); expect(f.p.info.Gold).toBe(92);
    expect(item.Count).toBe(5); expect(item.isDirty).toBe(false);
    expect((await profileRow(f.p.id)).Gold).toBe(92); expect(await hasClaim(h.db, f.p.id, "worldboss", w.key)).toBe(true);
    expect(await mails(f.p.id)).toHaveLength(table.includes("User_Messages") ? 1 : 0);
  });
  it("keeps offline currency delivery and atomically mails all item stacks at most five per mail", async () => {
    const f = await fixture(), old = await profileRow(f.p.id); f.ctx.world.remove(f.p);
    const max = templates.findItem(11001)!.MaxCount, rewards = [{ templateId: -1100, count: 8 }, { templateId: -100, count: 3 }, { templateId: 11001, count: max * 5 + 1 }];
    const key = `offline-${f.p.id}`, remove = await rejectBossWrites('player."User_Messages"');
    await expect(awardWorldBoss(f.ctx, f.p.id, key, rewards, "test")).rejects.toThrow();
    expect(await hasClaim(h.db, f.p.id, "worldboss", key)).toBe(false); expect(await profileRow(f.p.id)).toEqual(old); expect(await mails(f.p.id)).toHaveLength(0);
    await remove(); await awardWorldBoss(f.ctx, f.p.id, key, rewards, "test"); await awardWorldBoss(f.ctx, f.p.id, key, rewards, "test");
    const letters = await mails(f.p.id); expect(letters).toHaveLength(2);
    expect((await profileRow(f.p.id)).GiftToken).toBe(old.GiftToken + 8); expect((await profileRow(f.p.id)).Gold).toBe(old.Gold + 3);
    const ids = letters.flatMap((m) => [m.Annex1, m.Annex2, m.Annex3, m.Annex4, m.Annex5].filter(Boolean).map(Number)); expect(new Set(ids).size).toBe(6);
    const all = await h.db.select().from(player.Sys_Users_Goods); const attached = all.filter((g) => ids.includes(g.ItemID));
    expect(attached.reduce((sum, g) => sum + g.Count, 0)).toBe(max * 5 + 1);
    expect(attached.every((g) => g.UserID === 0 && g.TemplateID === 11001 && g.IsBinds && g.ValidDate === 0 && g.Count <= max)).toBe(true);
  });
  it("does not consume claims for unsupported reward definitions or truncated keys", async () => {
    const f = await fixture();
    for (const rewards of [[{ templateId: 987654321, count: 1 }], [{ templateId: -200, count: 1 }], [{ templateId: 11001, count: NaN }]]) {
      await expect(awardWorldBoss(f.ctx, f.p.id, "invalid", rewards, "test")).rejects.toThrow();
    }
    await expect(awardWorldBoss(f.ctx, f.p.id, "x".repeat(65), [], "test")).rejects.toThrow();
    expect(await hasClaim(h.db, f.p.id, "worldboss", "invalid")).toBe(false);
  });
  it("retries a failed second recipient without paying the committed first rank twice", async () => {
    const a = await fixture(), b = await fixture(); a.ctx.world.add(b.p);
    const w = window(90, { rankAwards: [{ rank: 2, giftToken: 7 }] }); await a.rt.onStart(w);
    worldBossDamage(a.ctx, a.p, 100, { windowKey: w.key, fightId: 1 }); worldBossDamage(a.ctx, b.p, 50, { windowKey: w.key, fightId: 1 });
    const beforeA = a.p.info.GiftToken, beforeB = b.p.info.GiftToken;
    await h.db.execute(sql.raw(`CREATE FUNCTION player.test_boss_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."UserID" = ${b.p.id} THEN RAISE EXCEPTION 'second recipient'; END IF; RETURN NEW; END; $$`));
    await h.db.execute(sql`CREATE TRIGGER test_boss_failure BEFORE INSERT ON app."EventClaims" FOR EACH ROW EXECUTE FUNCTION player.test_boss_failure()`);
    await expect(a.rt.onEnd(w)).rejects.toThrow(); expect(a.p.info.GiftToken).toBe(beforeA + 7); expect(b.p.info.GiftToken).toBe(beforeB);
    await h.db.execute(sql`DROP TRIGGER test_boss_failure ON app."EventClaims"`);
    await a.rt.onEnd(w); expect(a.p.info.GiftToken).toBe(beforeA + 7); expect(b.p.info.GiftToken).toBe(beforeB + 7); expect(a.rt.boss.window).toBeNull();
  });
  it.each([false, true])("queues real DdtGame reward dispatch across the SQL boundary (beforeCommit=%s)", async (beforeCommit) => {
    const f = await fixture(), item = await putMaterial(f), gate = commitGate(f, beforeCommit);
    const engine = new DdtFightEngine({ manualClock: true, seed: () => 5, pve: { data, pveInfo: (id) => pves.get(id), drop: () => null },
      giveItems: (member, items) => { grantRewards(member as GamePlayer, items, templates.findItem, NOW); } });
    const battle = engine.startPve({ roomId: 1, roomType: 4, gameType: 7, timeType: 3, pveId: 1243, hardLevel: 0, levelLimits: 0, currentFloor: 1, players: [f.p], onStopped: () => {} })!;
    expect(battle).not.toBeNull();
    const room = new BaseRoom(1, { onRoomChanged: () => {}, lang: (key) => key }); room.start(); room.addPlayer(f.p); room.startGame(battle);
    const awarding = awardWorldBoss(f.ctx, f.p.id, `commit-${f.p.id}`, [{ templateId: 11001, count: 1 }], "test"); await gate.entered.promise;
    const event: FightEvent = { cmd: "PVE_AWARD", code: 0, livingId: 1, userId: f.p.id, bag: "temp", items: [{ templateId: 11001, count: 2 }] };
    vi.spyOn(engine.games.get(battle.id)!.game, "update").mockReturnValueOnce([event]); engine.tick(Date.now() + 2);
    expect(item.Count).toBe(3); const saving = f.p.saveIntoDatabase(h.db);
    gate.release.resolve(); await Promise.all([awarding, saving]);
    expect(f.p.propBag.getItemAt(0)).toBe(item); expect(item.Count).toBe(6); expect((await goods(f.p.id))[0]!.Count).toBe(6);
    battle.stop();
  });
  it.each([false, true])("publishes reserved slots before queued fight rewards (fills existing stack=%s)", async (fullStack) => {
    const f = await fixture(), max = templates.findItem(11001)!.MaxCount;
    const item = await putMaterial(f, fullStack ? max - 1 : 3), gate = commitGate(f);
    const engine = new DdtFightEngine({ manualClock: true, seed: () => 5, pve: { data, pveInfo: (id) => pves.get(id), drop: () => null },
      giveItems: (member, items) => { grantRewards(member as GamePlayer, items, templates.findItem, NOW); } });
    const battle = engine.startPve({ roomId: 1, roomType: 4, gameType: 7, timeType: 3, pveId: 1243, hardLevel: 0, levelLimits: 0, currentFloor: 1, players: [f.p], onStopped: () => {} })!;
    const room = new BaseRoom(1, { onRoomChanged: () => {}, lang: (key) => key }); room.start(); room.addPlayer(f.p); room.startGame(battle);
    const awardTemplate = fullStack ? 11001 : 11005, fightTemplate = fullStack ? 11001 : 11002;
    const awarding = awardWorldBoss(f.ctx, f.p.id, `slots-${f.p.id}`, [{ templateId: awardTemplate, count: 1 }], "test"); await gate.entered.promise;
    const event: FightEvent = { cmd: "PVE_AWARD", code: 0, livingId: 1, userId: f.p.id, bag: "temp", items: [{ templateId: fightTemplate, count: 1 }] };
    vi.spyOn(engine.games.get(battle.id)!.game, "update").mockReturnValueOnce([event]); engine.tick(Date.now() + 2);
    expect(f.p.propBag.getItemAt(1)).toBeNull(); const saving = f.p.saveIntoDatabase(h.db);
    gate.release.resolve(); await Promise.all([awarding, saving]);
    expect(f.p.propBag.getItemAt(0)).toBe(item); expect(item.Count).toBe(fullStack ? max : 3);
    const inventory = f.p.propBag.getItems();
    expect(inventory.map((i) => [i.Place, i.TemplateID, i.Count])).toEqual(fullStack
      ? [[0, 11001, max], [1, 11001, 1]] : [[0, 11001, 3], [1, 11005, 1], [2, 11002, 1]]);
    expect(inventory.every((i) => i.ItemID > 0 && !i.isDirty)).toBe(true);
    expect(new Set(inventory.map((i) => i.ItemID)).size).toBe(inventory.length);
    expect((await goods(f.p.id)).map((i) => [i.ItemID, i.Place, i.TemplateID, i.Count])).toEqual(inventory.map((i) => [i.ItemID, i.Place, i.TemplateID, i.Count]));
    battle.stop();
  });
  it.each([false, true])("serializes the production spa timer at commit return and cancels departed ticks (leave=%s)", async (leave) => {
    const f = await fixture(), spa = new HotSpringMgr(f.ctx), timer = vi.spyOn(globalThis, "setInterval");
    spa.expTable = Array.from({ length: 60 }, () => 100);
    const room = new SpaRoom({ roomID: 1, roomNumber: 1, roomName: "test", roomPassword: null, effectiveTime: 0, playerID: 0,
      playerName: "", startTime: NOW, roomIntroduction: "", roomType: 2, maxCount: 10 });
    expect(spa.add(f.p, room)).toBe(true); await spa.saveExtra(f.p);
    const callback = timer.mock.calls.at(-1)![0] as () => void, before = structuredClone(f.p.info), minutes = spa.st(f.p).min;
    const tick = vi.spyOn(spa, "tick"), gate = commitGate(f);
    const awarding = awardWorldBoss(f.ctx, f.p.id, `spa-${f.p.id}`, [{ templateId: -1100, count: 7 }], "test"); await gate.entered.promise;
    callback(); await Promise.resolve(); expect(tick).not.toHaveBeenCalled(); expect(spa.st(f.p).min).toBe(minutes);
    if (leave) spa.remove(f.p);
    gate.release.resolve(); await awarding; await f.p.withPersistenceLock(async () => {});
    expect(tick).toHaveBeenCalledTimes(leave ? 0 : 1); expect(spa.st(f.p).min).toBe(minutes - (leave ? 0 : 1));
    expect(f.p.info.GiftToken).toBe(before.GiftToken + 7 + (leave ? 0 : 10));
    expect(f.p.info.Gold).toBe(before.Gold + (leave ? 0 : 50)); expect(f.p.info.GP).toBe(before.GP + (leave ? 0 : 10));
    expect(f.p.info.myHonor).toBe(before.myHonor + (leave ? 0 : 50));
    await f.p.saveIntoDatabase(h.db); const stored = await profileRow(f.p.id);
    expect([stored.GiftToken, stored.Gold, stored.GP, stored.myHonor]).toEqual([f.p.info.GiftToken, f.p.info.Gold, f.p.info.GP, f.p.info.myHonor]);
    spa.remove(f.p); await spa.saveExtra(f.p);
  });
  it.each([false, true])("drains an actual same-fight quit before its final save (second recipient=%s)", async (secondRecipient) => {
    const a = await fixture(), b = await fixture(), ai = await putMaterial(a), bi = await putMaterial(b);
    a.ctx.world.add(b.p); const gate = commitGate(a);
    const engine = new DdtFightEngine({ manualClock: true, seed: () => 5, pve: { data, pveInfo: (id) => pves.get(id), drop: () => null },
      giveItems: (member, items) => { grantRewards(member as GamePlayer, items, templates.findItem, NOW); } });
    a.ctx.rooms = new RoomMgr({ maxRooms: 1, fight: engine, lang: (key) => key });
    const room = a.ctx.rooms.rooms[0]!; room.start(); room.addPlayer(a.p); room.addPlayer(b.p);
    const battle = engine.startPve({ roomId: 1, roomType: 4, gameType: 7, timeType: 3, pveId: 1243, hardLevel: 0, levelLimits: 0, currentFloor: 1, players: [a.p, b.p], onStopped: () => room.onGameStopped() })!;
    room.startGame(battle);
    const awardA = awardWorldBoss(a.ctx, a.p.id, `quit-${a.p.id}`, [{ templateId: 11001, count: 1 }], "test"); await gate.entered.promise;
    const awardB = secondRecipient ? awardWorldBoss(a.ctx, b.p.id, `quit-${b.p.id}`, [{ templateId: 11001, count: 1 }], "test") : Promise.resolve();
    const quitting = secondRecipient ? a.p : b.p;
    const event: FightEvent = { cmd: "PVE_AWARD", code: 0, livingId: 1, userId: quitting.id, bag: "temp", items: [{ templateId: 11001, count: 2 }] };
    vi.spyOn(engine.games.get(battle.id)!.game, "update").mockReturnValueOnce([event]); engine.tick(Date.now() + 2);
    let quitDone = false; const leaving = quitPlayer(a.ctx, quitting).then(() => { quitDone = true; });
    await Promise.resolve(); expect(quitDone).toBe(false); gate.release.resolve();
    await Promise.all([awardA, awardB, leaving]);
    expect(a.ctx.world.get(quitting.id)).toBeUndefined(); expect(a.ctx.log.error).not.toHaveBeenCalled();
    const item = secondRecipient ? ai : bi; expect(item.Count).toBe(secondRecipient ? 6 : 5);
    expect((await goods(quitting.id))[0]!.Count).toBe(item.Count); expect((await profileRow(quitting.id)).State).toBe(0);
    battle.stop();
  });
  it("serializes actual inbound packets before/after a timed award on GameClient.chain", async () => {
    const f = await fixture(), item = await putMaterial(f), gate = commitGate(f), registry = new HandlerRegistry();
    registry.player(44, "test purchase", () => { f.p.info.Gold -= 10; f.p.propBag.addCountToStack(item, 2); });
    const client = new GameClient({ kind: "fake", remoteAddress: "test", write: () => {}, close: () => {} },
      { ...f.ctx, cfg: testConfig({ LOGIN_TIMEOUT_SEC: "0" } as never) }, registry);
    client.player = f.p; f.p.sink.enqueueWorldBossAward = (work) => client.enqueueWorldBossAward(work);
    const cipher = new RollingKeyCipher(true); client.receive(encodeFrame(new GSPacket(44), cipher));
    const award = awardWorldBoss(f.ctx, f.p.id, `packets-${f.p.id}`, [{ templateId: 11001, count: 1 }], "test");
    await gate.entered.promise; expect(item.Count).toBe(5);
    client.receive(encodeFrame(new GSPacket(44), cipher)); await Promise.resolve(); expect(item.Count).toBe(5);
    gate.release.resolve(); await award; await client.idle(); expect(item.Count).toBe(8); expect(item.isDirty).toBe(true);
    await f.p.saveIntoDatabase(h.db); expect((await goods(f.p.id))[0]!.Count).toBe(8); expect((await profileRow(f.p.id)).Gold).toBe(f.p.info.Gold);
    client.disconnect("test complete");
  });
  it("defers an already-queued room start until award publication and rechecks the room", async () => {
    const f = await fixture(), gate = commitGate(f), engine = new DdtFightEngine({ manualClock: true, seed: () => 5,
      pve: { data, pveInfo: (id) => pves.get(id), drop: () => null } });
    const rooms = new RoomMgr({ maxRooms: 1, fight: engine, lang: (key) => key }); f.ctx.rooms = rooms;
    const room = rooms.rooms[0]!; room.start(); room.updateRoom("test", "", 4, 3, 1243); room.addPlayer(f.p);
    const award = awardWorldBoss(f.ctx, f.p.id, `start-${f.p.id}`, [{ templateId: -1100, count: 1 }], "test"); await gate.entered.promise;
    rooms.startGame(room); rooms.tick(); expect(room.game).toBeNull(); gate.release.resolve(); await award;
    await Promise.resolve(); rooms.tick(); expect(room.game).not.toBeNull(); room.game?.stop();
  });
  it("cancels the deferred start after the original participant quits", async () => {
    const f = await fixture(), gate = commitGate(f), engine = new DdtFightEngine({ manualClock: true,
      pve: { data, pveInfo: (id) => pves.get(id), drop: () => null } });
    const rooms = new RoomMgr({ maxRooms: 1, fight: engine, lang: (key) => key }); f.ctx.rooms = rooms;
    const room = rooms.rooms[0]!; room.start(); room.updateRoom("test", "", 4, 3, 1243); room.addPlayer(f.p);
    const award = awardWorldBoss(f.ctx, f.p.id, `no-start-${f.p.id}`, [{ templateId: -1100, count: 1 }], "test"); await gate.entered.promise;
    rooms.startGame(room); rooms.tick(); const leaving = quitPlayer(f.ctx, f.p); gate.release.resolve(); await Promise.all([award, leaving]);
    await Promise.resolve(); rooms.tick(); expect(engine.games.size).toBe(0); expect(f.ctx.world.get(f.p.id)).toBeUndefined();
  });
});

describe("world boss fight write barrier", () => {
  it("uses one lease, keeps FIFO command/stop order, coalesces adjacent ticks and releases after failures", async () => {
    const gate = new WorldBossSettlementGate(), out: string[] = [], release = await gate.acquire();
    let second = false; const next = gate.acquire().then((done) => { second = true; out.push("next"); done(); });
    gate.tick(10, (n) => out.push(`tick:${n}`), () => {}); gate.tick(20, (n) => out.push(`tick:${n}`), () => {});
    const command = gate.defer(() => { out.push("packet"); throw new Error("transport"); });
    const rejected = expect(command).rejects.toThrow("transport");
    gate.tick(30, (n) => out.push(`tick:${n}`), () => {});
    const stop = gate.defer(() => { out.push("stop"); }, "stop");
    expect(second).toBe(false); release(); release(); await Promise.all([next, rejected, stop]);
    // An already-requested next award retains the barrier before ordinary queued work.
    expect(out).toEqual(["next", "tick:20", "packet", "tick:30", "stop"]); expect(gate.held).toBe(false);
  });
});
