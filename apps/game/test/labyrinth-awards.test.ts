import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, seedDatabase, game, player, type DbHandle } from "@ddt/db";
import type { GSPacket } from "@ddt/protocol";
import { loadMatchInfo, loadPlayerInfo } from "../src/db/characters.js";
import { Templates } from "../src/db/templates.js";
import { ItemInfo } from "../src/game/item.js";
import { grantRewards } from "../src/game/events.js";
import { awardLabyrinthFloor, type LabyrinthRow } from "../src/game/labyrinth.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { commitPlayerMutation, PlayerMutationCommittedError } from "../src/game/player-transaction.js";
import { World, type ServerContext } from "../src/session/context.js";

// Award persistence tests use an isolated in-memory DB, never the running local game.
let h: DbHandle, templates: Templates, seq = 0;
const NOW = new Date("2026-10-16T12:00:00Z");
const TABLES = ['player."Sys_Users_Labyrinth"', 'player."Sys_Users_Goods"', 'player."Sys_Users_Detail"', 'player."User_Messages"'];
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h); await seedDatabase(h, { only: ["Shop_Goods"] });
  templates = new Templates();
  templates.items = new Map((await h.db.select().from(game.Shop_Goods)).map(t => [t.TemplateID, t]));
});
afterAll(async () => { await h.close(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of TABLES) await h.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_labyrinth_failure ON ${table}`));
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.test_labyrinth_failure()`);
});

async function fixture(floor = 1, over: Partial<LabyrinthRow> = {}) {
  const [row] = await h.db.insert(player.Sys_Users_Detail)
    .values({ UserName: `lab_award_${++seq}`, NickName: `Lab award ${seq}`, IsFirst: 1 }).returning();
  const info = (await loadPlayerInfo(h.db, row!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: pkt => sent.push(pkt), disconnect: () => {}, remoteAddress: "labyrinth-test" },
    info, defaultMatch(info.ID), 1, "test");
  const ctx = { db: h, templates, world: new World(), now: () => NOW,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, lang: { t: (key: string) => key } } as unknown as ServerContext;
  ctx.world.add(p);
  const progress: LabyrinthRow = {
    UserID: p.id, myProgress: floor, myRanking: 7, completeChallenge: true, isDoubleAward: false,
    currentFloor: floor, accumulateExp: 0, remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0,
    cleanOutGold: 50, tryAgainComplete: true, isInGame: true, isCleanOut: false,
    serverMultiplyingPower: false, LastDate: NOW,
    ProcessAward: Array.from({ length: 99 }, (_, i) => floor > 1 && i < floor ? "i" : String(i)).join("-"), ...over,
  };
  await h.db.insert(player.Sys_Users_Labyrinth).values(progress);
  const award = (bigAward = floor % 2 === 0) => awardLabyrinthFloor(ctx, p, { floor, missionId: 40000 + floor, bigAward });
  return { p, ctx, sent, award };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const rowFor = async (p: GamePlayer) => (await h.db.select().from(player.Sys_Users_Labyrinth).where(eq(player.Sys_Users_Labyrinth.UserID, p.id)))[0]!;
const profileFor = async (p: GamePlayer) => (await h.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, p.id)))[0]!;
const goodsFor = (p: GamePlayer) => h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.UserID, p.id)).orderBy(player.Sys_Users_Goods.ItemID);
const mailsFor = (p: GamePlayer) => h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, p.id));
const wallet = (p: GamePlayer) => ({ gp: p.info.GP, hardCurrency: p.info.hardCurrency, gold: p.info.Gold, giftToken: p.info.GiftToken, money: p.info.Money });
function memory(p: GamePlayer) {
  return { info: structuredClone(p.info), match: structuredClone(p.match),
    bags: p.allBags().map(b => ({ type: b.bagType, capacity: b.capacity,
      items: b.getItems().map(i => ({ row: i.toRow(), dirty: i.isDirty })),
      removed: b.removed.map(i => ({ row: i.toRow(), dirty: i.isDirty })) })) };
}
async function putItem(f: Fixture, templateId: number, count = 1, place = 0) {
  const [row] = await h.db.insert(player.Sys_Users_Goods).values({ UserID: f.p.id, BagType: 1, Place: place,
    TemplateID: templateId, Count: count, IsBinds: true }).returning();
  const item = ItemInfo.fromRow(row!, templates.findItem(templateId)!);
  expect(item.template).toBeDefined();
  f.p.propBag.loadItems([...f.p.propBag.getItems(), item]);
  f.sent.length = 0;
  return item;
}
function fixedDrop() {
  return vi.spyOn(templates, "pveDrop").mockReturnValue([{ templateId: 11005, count: 91, isBind: false, validDate: 0 }]);
}
async function failWrites(table: string) {
  await h.db.execute(sql`CREATE FUNCTION player.test_labyrinth_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected labyrinth failure'; END; $$`);
  await h.db.execute(sql.raw(`CREATE TRIGGER test_labyrinth_failure BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION player.test_labyrinth_failure()`));
  return () => h.db.execute(sql.raw(`DROP TRIGGER test_labyrinth_failure ON ${table}`));
}

describe("original Labyrinth layer awards persist as one transaction", () => {
  it("pays a small award once, advances the next-floor cursor, and preserves the original 99-slot ProcessAward", async () => {
    const f = await fixture(), before = wallet(f.p), drop = fixedDrop();
    const awarded = await f.award(false);
    expect(awarded).toMatchObject({ exp: 660, hardCurrency: 0, materials: [] });
    expect(wallet(f.p)).toEqual({ ...before, gp: before.gp + 660 });
    const saved = await rowFor(f.p);
    expect(saved).toMatchObject({ currentFloor: 2, myProgress: 2, accumulateExp: 660, isDoubleAward: false });
    expect(saved.ProcessAward.split("-")).toEqual(Array.from({ length: 99 }, (_, i) => i <= 1 ? "i" : String(i)));
    expect((await profileFor(f.p)).GP).toBe(f.p.info.GP);
    expect(drop).not.toHaveBeenCalled();
    const committed = memory(f.p);
    expect(await f.award(false)).toBeNull(); expect(memory(f.p)).toEqual(committed); expect(await rowFor(f.p)).toEqual(saved);
  });

  it.each([{ floor: 2, exp: 1350, material: 2, hc: 2 }, { floor: 30, exp: 20670, material: 6, hc: 10 }])
  ("uses the exact original GP/material/HC table at floor $floor and the fixed business drop", async ({ floor, exp, material, hc }) => {
    const f = await fixture(floor), before = wallet(f.p), drop = fixedDrop();
    const awarded = await f.award();
    expect(awarded).toMatchObject({ exp, hardCurrency: hc, materials: [{ templateId: 11005, count: material, isBind: true }] });
    expect(drop).toHaveBeenCalledExactlyOnceWith("copy", 2, 40002);
    expect(wallet(f.p)).toEqual({ ...before, gp: before.gp + exp, hardCurrency: before.hardCurrency + hc });
    const awardedGoods = (await goodsFor(f.p)).filter(i => i.TemplateID === 11005 && i.IsExist);
    expect(awardedGoods.reduce((sum, i) => sum + i.Count, 0)).toBe(material);
    expect(awardedGoods.every(i => i.IsBinds)).toBe(true);
    expect(await rowFor(f.p)).toMatchObject({ currentFloor: floor + 1, myProgress: floor + 1, accumulateExp: exp });
    expect(await f.award()).toBeNull(); expect(drop).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("consumes exactly one 11916 while double-award enabled=%s, publishing deletion of its last unit", async enabled => {
    const f = await fixture(2, { isDoubleAward: enabled }), item = await putItem(f, 11916), before = wallet(f.p);
    fixedDrop();
    const awarded = await f.award(), multiplier = enabled ? 2 : 1;
    expect(awarded).toMatchObject({ exp: 1350 * multiplier, hardCurrency: 2 * multiplier });
    expect(f.p.propBag.getItemAt(0)?.ItemID).not.toBe(item.ItemID);
    expect(f.p.propBag.getItemAt(0)).toMatchObject({ TemplateID: 11005, Count: 2 * multiplier });
    expect(f.p.propBag.getItemCount(11916)).toBe(0);
    expect((await goodsFor(f.p)).find(i => i.ItemID === item.ItemID)).toMatchObject({ IsExist: false, Count: 1 });
    expect(wallet(f.p)).toEqual({ ...before, gp: before.gp + 1350 * multiplier, hardCurrency: before.hardCurrency + 2 * multiplier });
    expect((await rowFor(f.p)).isDoubleAward).toBe(enabled);
  });

  it("keeps the same live 11916 stack after partial consumption and persists the remaining count", async () => {
    const f = await fixture(1, { isDoubleAward: true }), item = await putItem(f, 11916, 3);
    expect(await f.award(false)).toMatchObject({ exp: 1320 });
    expect(f.p.propBag.getItemAt(0)).toBe(item); expect(item.Count).toBe(2); expect(item.isDirty).toBe(false);
    expect((await goodsFor(f.p)).find(i => i.ItemID === item.ItemID)).toMatchObject({ Count: 2, IsExist: true });
  });

  it("turns double-award off when 11916 is absent, with an undoubled persisted award", async () => {
    const f = await fixture(2, { isDoubleAward: true }); fixedDrop();
    expect(await f.award()).toMatchObject({ exp: 1350, hardCurrency: 2 });
    expect(await rowFor(f.p)).toMatchObject({ isDoubleAward: false, accumulateExp: 1350 });
    expect((await profileFor(f.p)).GP).toBe(f.p.info.GP);
  });

  it.each([true, false])("shares one persistent claim between big and small candidates (first big=%s)", async big => {
    const f = await fixture(2), drop = fixedDrop();
    expect(await f.award(big)).not.toBeNull();
    const before = memory(f.p), row = await rowFor(f.p), stored = await goodsFor(f.p);
    expect(await f.award(!big)).toBeNull();
    expect(memory(f.p)).toEqual(before); expect(await rowFor(f.p)).toEqual(row); expect(await goodsFor(f.p)).toEqual(stored);
    expect(drop).toHaveBeenCalledTimes(big ? 1 : 0);
  });

  it("does not confuse floor 2 with unclaimed ProcessAward tokens 12/20/21/22", async () => {
    const f = await fixture(2); fixedDrop(); await f.award();
    const saved = await rowFor(f.p), before = memory(f.p);
    expect(saved.ProcessAward.split("-")).toContain("12"); expect(saved.ProcessAward.split("-")).toContain("22");
    expect(saved.ProcessAward.split("-")[2]).toBe("i");
    expect(await f.award()).toBeNull(); expect(memory(f.p)).toEqual(before); expect(await rowFor(f.p)).toEqual(saved);
  });

  it("serializes concurrent big/small candidates into one persisted floor award", async () => {
    const f = await fixture(2), before = wallet(f.p), drop = fixedDrop();
    const results = await Promise.all([f.award(true), f.award(false), f.award(true)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(wallet(f.p)).toEqual({ ...before, gp: before.gp + 1350, hardCurrency: before.hardCurrency + 2 });
    expect(drop).toHaveBeenCalledTimes(1); expect(await rowFor(f.p)).toMatchObject({ currentFloor: 3, accumulateExp: 1350 });
  });

  it.each([
    { floor: 0, missionId: 40000, bigAward: false },
    { floor: 31, missionId: 40031, bigAward: false },
    { floor: 2.5, missionId: 40002.5, bigAward: false },
    { floor: 2, missionId: 40004, bigAward: true },
    { floor: 1, missionId: 40001, bigAward: true },
  ])("does not create rewards from an invalid mission/floor candidate %j", async candidate => {
    const f = await fixture(2), before = memory(f.p), saved = await rowFor(f.p), drop = fixedDrop();
    await expect(awardLabyrinthFloor(f.ctx, f.p, candidate)).rejects.toThrow("Invalid Labyrinth floor award");
    expect(memory(f.p)).toEqual(before); expect(await rowFor(f.p)).toEqual(saved); expect(drop).not.toHaveBeenCalled();
  });

  it.each([
    { completeChallenge: false }, { isInGame: false }, { isCleanOut: true }, { currentFloor: 3 },
    { LastDate: new Date(+NOW - 86400_000) },
  ])("cannot pay an unavailable or stale current-floor run %j", async over => {
    const f = await fixture(2, over), before = memory(f.p), saved = await rowFor(f.p), drop = fixedDrop();
    await expect(f.award()).rejects.toThrow("active current-floor run");
    expect(memory(f.p)).toEqual(before); expect(await rowFor(f.p)).toEqual(saved); expect(drop).not.toHaveBeenCalled();
  });

  it.each(["-1", Array.from({ length: 99 }, (_, i) => i === 2 ? "i" : String(i)).join("-")])
  ("does not reopen a malformed or legacy ProcessAward merely because a candidate arrives", async ProcessAward => {
    const f = await fixture(2, { ProcessAward }), before = memory(f.p), saved = await rowFor(f.p);
    await expect(f.award()).rejects.toThrow("explicit reset is required");
    expect(memory(f.p)).toEqual(before); expect(await rowFor(f.p)).toEqual(saved);
  });

  it.each(TABLES)("rolls back live state, consumed 11916, progress, and rewards on a real %s SQL failure", async table => {
    const f = await fixture(2, { isDoubleAward: true }), item = await putItem(f, 11916, 2);
    f.p.propBag.capacity = 1; // The still-occupied booster slot forces the big-award material into mail.
    f.p.info.Gold = 73; item.Count = 3; item.isDirty = true; fixedDrop();
    const before = memory(f.p), stored = await goodsFor(f.p), profile = await profileFor(f.p), row = await rowFor(f.p);
    const remove = await failWrites(table); f.sent.length = 0;
    await expect(f.award()).rejects.toThrow();
    expect(memory(f.p)).toEqual(before); expect(f.p.propBag.getItemAt(0)).toBe(item);
    expect(await goodsFor(f.p)).toEqual(stored); expect(await profileFor(f.p)).toEqual(profile); expect(await rowFor(f.p)).toEqual(row);
    expect(await mailsFor(f.p)).toHaveLength(0); expect(f.sent).toHaveLength(0);
    await remove(); expect(await f.award()).toMatchObject({ exp: 2700, hardCurrency: 4 });
    expect(item.Count).toBe(2); expect(item.isDirty).toBe(false); expect((await profileFor(f.p)).Gold).toBe(73);
    expect(await mailsFor(f.p)).toHaveLength(1);
    const committed = memory(f.p); expect(await f.award()).toBeNull(); expect(memory(f.p)).toEqual(committed);
  });

  it("mails bound material overflow atomically and keeps a repeated candidate from creating a second attachment", async () => {
    const f = await fixture(2), held = await putItem(f, 11001); f.p.propBag.capacity = 1; fixedDrop();
    expect(await f.award()).toMatchObject({ exp: 1350, hardCurrency: 2 });
    expect(f.p.propBag.getItemAt(0)).toBe(held); expect(held.Count).toBe(1);
    const mails = await mailsFor(f.p); expect(mails).toHaveLength(1);
    const ids = mails.flatMap(m => [m.Annex1, m.Annex2, m.Annex3, m.Annex4, m.Annex5].filter(Boolean).map(Number));
    expect(ids).toHaveLength(1);
    const [attached] = await h.db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, ids[0]!));
    expect(attached).toMatchObject({ UserID: 0, TemplateID: 11005, Count: 2, IsBinds: true, IsExist: true });
    expect(await f.award()).toBeNull(); expect(await mailsFor(f.p)).toEqual(mails);
  });

  it("treats a post-commit socket failure as a committed award, so retry cannot repay or consume another booster", async () => {
    const f = await fixture(2, { isDoubleAward: true }), item = await putItem(f, 11916, 2), before = wallet(f.p), drop = fixedDrop();
    vi.spyOn(f.p, "send").mockImplementationOnce(() => { throw new Error("test award socket closed"); });
    await expect(f.award()).resolves.toMatchObject({ exp: 2700, hardCurrency: 4 });
    expect(wallet(f.p)).toEqual({ ...before, gp: before.gp + 2700, hardCurrency: before.hardCurrency + 4 });
    expect(item.Count).toBe(1); expect((await goodsFor(f.p)).find(i => i.ItemID === item.ItemID)?.Count).toBe(1);
    expect((await profileFor(f.p)).GP).toBe(f.p.info.GP); expect(await rowFor(f.p)).toMatchObject({ currentFloor: 3, accumulateExp: 2700 });
    expect(f.ctx.log.warn).toHaveBeenCalled(); expect(await f.award()).toBeNull(); expect(item.Count).toBe(1); expect(drop).toHaveBeenCalledTimes(1);
  });

  it.each([{ count: 1, dirty: false }, { count: 1, dirty: true }, { count: 2, dirty: false }, { count: 2, dirty: true }])
  ("cannot turn a previously-deleted booster into a doubled floor award (count=$count, dirty=$dirty)", async ({ count, dirty }) => {
    const f = await fixture(2, { isDoubleAward: true }), item = await putItem(f, 11916, count); fixedDrop();
    item.isDirty = dirty;
    await h.db.update(player.Sys_Users_Goods).set({ IsExist: false }).where(eq(player.Sys_Users_Goods.ItemID, item.ItemID));
    const before = memory(f.p), stored = await goodsFor(f.p), row = await rowFor(f.p), profile = await profileFor(f.p);
    await expect(f.award()).rejects.toThrow();
    expect(memory(f.p)).toEqual(before); expect(await goodsFor(f.p)).toEqual(stored); expect(await rowFor(f.p)).toEqual(row); expect(await profileFor(f.p)).toEqual(profile);
  });
});

describe("Labyrinth's shared player transaction publication", () => {
  it("persists a consumed formerly-saved item in FightBag and does not resurrect it during the later player save", async () => {
    const f = await fixture(), item = await putItem(f, 11916);
    expect(f.p.propBag.takeOutItem(item)).toBe(true); expect(f.p.fightBag.addItemTo(item, 0)).toBe(true);
    expect(f.p.propBag.removed).toContain(item);
    await f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (_db, staged) => {
      expect(staged.fightBag.removeTemplate(11916, 1)).toBe(true); return { value: "consumed" };
    }));
    expect(f.p.fightBag.getItemAt(0)).toBeNull(); expect(item.IsExist).toBe(false); expect(item.isDirty).toBe(false);
    expect(f.p.allBags().every(b => !b.removed.includes(item))).toBe(true);
    expect((await goodsFor(f.p)).find(g => g.ItemID === item.ItemID)).toMatchObject({ IsExist: false });
    await f.p.saveIntoDatabase(h.db);
    expect((await goodsFor(f.p)).find(g => g.ItemID === item.ItemID)).toMatchObject({ IsExist: false });
  });

  it("keeps mutable Item dates detached if a real SQL failure follows an in-place staged Date edit", async () => {
    const f = await fixture(), item = await putItem(f, 11916), before = memory(f.p), stored = await goodsFor(f.p);
    const beforeDate = item.BeginDate.getTime(); await failWrites('player."Sys_Users_Detail"');
    await expect(f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (_db, staged) => {
      const copy = staged.propBag.getItemAt(0)!;
      copy.BeginDate.setTime(beforeDate + 86400_000); copy.isDirty = true;
      return { value: "changed" };
    }))).rejects.toThrow();
    expect(item.BeginDate.getTime()).toBe(beforeDate); expect(memory(f.p)).toEqual(before); expect(await goodsFor(f.p)).toEqual(stored);
  });

  it("rolls back a callback's SQL writes when it returns null, and publishes none of its staged changes", async () => {
    const f = await fixture(), before = memory(f.p), row = await rowFor(f.p), profile = await profileFor(f.p);
    const result = await f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (db, staged) => {
      await db.update(player.Sys_Users_Labyrinth).set({ accumulateExp: 123456 }).where(eq(player.Sys_Users_Labyrinth.UserID, f.p.id));
      staged.addGold(77); return null;
    }));
    expect(result).toBeNull(); expect(memory(f.p)).toEqual(before); expect(await rowFor(f.p)).toEqual(row); expect(await profileFor(f.p)).toEqual(profile);
  });

  it("publishes the committed match state to both the original live object and the database", async () => {
    const f = await fixture(), match = f.p.match;
    const result = await f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (_db, staged) => {
      staged.match.DailyLeagueLastScore = 17; staged.match.DailyLeagueFirst = true;
      return { value: "match saved" };
    }));
    expect(result).toBe("match saved"); expect(f.p.match).toBe(match);
    expect(f.p.match).toMatchObject({ DailyLeagueLastScore: 17, DailyLeagueFirst: true });
    expect(await loadMatchInfo(h.db, f.p.id)).toMatchObject({ DailyLeagueLastScore: 17, DailyLeagueFirst: true });
  });

  it("finishes grade hooks and mail notification after a bag packet failure, carrying the already-committed value", async () => {
    const f = await fixture(), item = await putItem(f, 11916, 2), grade = f.p.info.Grade, delivered: number[] = [];
    f.p.propBag.capacity = 1; f.p.gradeForGp = () => grade + 1; f.p.onGradeUp = vi.fn();
    vi.spyOn(f.p, "send").mockImplementation(pkt => {
      delivered.push(pkt.code); if (pkt.code === 64) throw new Error("test bag transport failed");
    });
    const result = await f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (_db, staged, now) => {
      expect(staged.propBag.removeTemplate(11916, 1)).toBe(true);
      const rewards = grantRewards(staged, [{ templateId: 11005, count: 1 }], templates.findItem, now);
      staged.addGP(660, false); return { value: { floor: 1 }, overflow: rewards.overflow };
    })).then(() => null, error => error);
    expect(result).toBeInstanceOf(PlayerMutationCommittedError); expect(result.value).toEqual({ floor: 1 });
    expect(f.p.onGradeUp).toHaveBeenCalledExactlyOnceWith(grade); expect(f.p.info.Grade).toBe(grade + 1);
    expect((await profileFor(f.p)).Grade).toBe(grade + 1); expect(item.Count).toBe(1); expect(item.isDirty).toBe(false);
    expect(await mailsFor(f.p)).toHaveLength(1); expect(delivered).toContain(64); expect(delivered).toContain(117);
  });
});
