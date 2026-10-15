import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { app, createDb, game, member, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { actNativeExchange, exchangeSignature, readNativeExchange, type ExchangeAction, type ExchangeReply, type ExchangeResult, type ExchangeNativeView } from "../src/game/activity-exchange-native.js";
import { GamePlayer } from "../src/game/player.js";
import { GameClient } from "../src/session/client.js";
import { World, type ServerContext } from "../src/session/context.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { Templates } from "../src/db/templates.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { defaultMatch } from "../src/game/player-info.js";
import { exchangeActivity } from "../src/game/activity-exchange.js";
import { seedExchangeTemplates } from "./native-exchange-fixture.js";

let h: DbHandle, templates: Map<number, ItemTemplate>, seq = 0;
const start = new Date("2026-10-15T02:00:00Z");
beforeAll(async () => { h = await createDb("pglite:memory"); await migrateDb(h); await seedExchangeTemplates(h);
  templates = new Map((await h.db.select().from(game.Shop_Goods)).map(t => [t.TemplateID, t])); });
afterEach(async () => { vi.restoreAllMocks(); await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS a05_receipt_failure`); });
afterAll(async () => { await h.close(); });
async function fixture(templateId = 11019, count = 40) {
  const n = ++seq, name = `exchange-native-${n}`;
  await h.db.insert(member.Accounts).values({ ID: n, UserName: name, PasswordHash: "test-only" });
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: name, NickName: `A05角色${n}`, Password: "test", IsFirst: 1, ForbidDate: new Date("2000-01-01Z") }).returning();
  const info = (await loadPlayerInfo(h.db, owner!.UserID))!, tpl = new Templates(); tpl.items = new Map(templates);
  let now = start;
  const ctx = { db: h, templates: tpl, now: () => now, world: new World(), cfg: { LOGIN_TIMEOUT_SEC: 0, PACKET_RATE_PER_SEC: 100, PACKET_RATE_BURST: 100 },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }, rooms: { waitingRemove: () => {} }, lang: { t: (s: string) => s } } as unknown as ServerContext;
  const frames: Uint8Array[] = [];
  const client = new GameClient({ kind: "fake", remoteAddress: "test", write: b => frames.push(b), close: () => {} }, ctx, new HandlerRegistry());
  const p = new GamePlayer(client, info, defaultMatch(info.ID), 1, "test"); client.player = p; ctx.world.add(p);
  const [row] = await h.db.insert(player.Sys_Users_Goods).values({ UserID: p.id, TemplateID: templateId, BagType: 1, Place: 0, Count: count }).returning();
  const material = ItemInfo.fromRow(row!, tpl.findItem(templateId)!); p.propBag.loadItems([material]); frames.length = 0;
  const input = { actor: { accountId: n, accountName: name }, characterId: p.id };
  const f = { p, client, ctx, input, material, frames, setNow: (value: Date) => { now = value; } };
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function ok<T>(r: ExchangeReply<T>): T { expect(r.ok, JSON.stringify(r)).toBe(true); if (!r.ok) throw new Error(r.message); return r.value; }
const view = async (f: Fixture, client: GameClient | undefined = f.client) => ok(await readNativeExchange(f.ctx, f.input, client));
async function command(f: Fixture, index = 0, count = 1, requestId = randomUUID()) {
  const s = await view(f); return { ...f.input, requestId, action: { type: "exchange" as const, index, count, choice: s.stateToken! } };
}
const apply = async (f: Fixture, index = 0, count = 1) => ok(await actNativeExchange(f.ctx, await command(f, index, count), f.client));
const rows = async (f: Fixture) => ({
  goods: await h.db.select().from(player.Sys_Users_Goods).where(sql`${player.Sys_Users_Goods.UserID}=${f.p.id} OR ${player.Sys_Users_Goods.UserID}=0`).orderBy(player.Sys_Users_Goods.ItemID),
  mails: await h.db.select().from(player.User_Messages).where(eq(player.User_Messages.ReceiverID, f.p.id)),
  states: await h.db.select().from(app.ActivityStates).where(eq(app.ActivityStates.UserID, f.p.id)),
  wallet: await h.db.select().from(app.ActivityWallet).where(eq(app.ActivityWallet.UserID, f.p.id)),
  receipts: await h.db.select().from(app.ActivityActions).where(eq(app.ActivityActions.UserID, f.p.id)),
});
describe("A05 authoritative original-window material exchange", () => {
  it("GET has authoritative counts/token and writes neither wallet/state nor dirty inventory", async () => {
    const f = await fixture(); f.material.Count = 41; f.material.isDirty = true;
    const before = await rows(f), s = await view(f);
    expect(s.materials[0]!.eligibleCount).toBe(41); expect(s.stateToken).toMatch(/^2026-10-15\.[A-Za-z0-9_-]{43}$/);
    expect(s.recipes[0]!.maxCount).toBe(10); expect(await rows(f)).toEqual(before); expect(f.material.isDirty).toBe(true); expect(f.frames).toEqual([]);
  });
  it.each([[0, 11019, 4, 11021, 1], [1, 11001, 4, 11002, 1], [2, 11021, 2, 11019, 3], [3, 11002, 2, 11001, 3]])("batch recipe %i consumes real materials and mails ordinary bound outputs", async (index, templateId, cost, output, count) => {
    const f = await fixture(templateId, 40), r = await apply(f, index, 3), saved = await rows(f);
    expect(f.material.Count).toBe(40 - cost * 3); expect(f.material.isDirty).toBe(false);
    expect(saved.wallet[0]).toMatchObject({ Points: 0, Earned: 0, Revision: 1 });
    expect(saved.states).toHaveLength(1); expect(saved.states[0]!.Activity).toBe("exchange-native");
    const annex = saved.goods.find(g => g.ItemID === Number(saved.mails[0]!.Annex1))!;
    expect(annex).toMatchObject({ UserID: 0, TemplateID: output, Count: count * 3, IsBinds: true, ValidDate: 0, StrengthenLevel: 0 });
    expect(r.nativeExchangeAction!.effects[0]).toMatchObject({ index, count: 3, committedRevision: 1 });
    expect(r.view.recipes[index]!.exchanged).toBe(3);
    await f.p.saveIntoDatabase(h.db); expect((await rows(f)).goods).toEqual(saved.goods);
  });
  it("joins multiple stacks and persists unsaved merge sources and prior profile payment atomically", async () => {
    const f = await fixture(11019, 5);
    const [source] = await h.db.insert(player.Sys_Users_Goods).values({ UserID: f.p.id, TemplateID: 11019, BagType: 1, Place: 1, Count: 3 }).returning();
    const removed = ItemInfo.fromRow(source!, templates.get(11019)!); f.p.propBag.addItemTo(removed, 1); f.p.propBag.removeItem(removed);
    f.material.Count = 8; f.material.isDirty = true; f.p.info.Gold = 123;
    const unsaved = ItemInfo.createFromTemplate(templates.get(11019)!, 4, 0, start); f.p.propBag.addItemTo(unsaved, 2);
    await apply(f, 0, 3);
    expect(f.material.IsExist).toBe(false); expect(unsaved.ItemID).toBeGreaterThan(0); expect(unsaved.IsExist).toBe(false); expect(f.p.propBag.removed).toEqual([]);
    const goods = (await rows(f)).goods;
    expect(goods.find(g => g.ItemID === source!.ItemID)!.IsExist).toBe(false);
    const [detail] = await h.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, f.p.id)); expect(detail!.Gold).toBe(123);
    expect(f.p.propBag.getItems()).toEqual([]); await f.p.saveIntoDatabase(h.db); expect((await rows(f)).goods).toEqual(goods);
  });
  it("same UUID replay precedes offline/token/quota checks and never emits a second effect or mail", async () => {
    const f = await fixture(), c = await command(f, 0, 10), first = ok(await actNativeExchange(f.ctx, c, f.client)), before = await rows(f);
    f.ctx.world.remove(f.p); f.client.closed = true;
    const replay = ok(await actNativeExchange(f.ctx, c));
    expect(replay.replayed).toBe(true); expect(replay.nativeExchangeAction).toBeUndefined(); expect(replay.view.authority).toBe("offline");
    expect(replay.view.stateToken).toBeNull(); expect(replay.view.materials.every(m => m.eligibleCount === null)).toBe(true);
    expect(await rows(f)).toEqual(before); expect(first.mailedCount).toBe(1);
    expect(await actNativeExchange(f.ctx, { ...c, action: { ...c.action, count: 1 } })).toMatchObject({ ok: false, status: 409 });
  });
  it("shared UUID ledger rejects collision with old activity signatures", async () => {
    const f = await fixture(), c = await command(f);
    await h.db.insert(app.ActivityWallet).values({ UserID: f.p.id });
    await h.db.insert(app.ActivityActions).values({ UserID: f.p.id, RequestID: c.requestId, Signature: "other-owner", Result: { message: "old", mailedCount: 0 } });
    const before = await rows(f); expect(await actNativeExchange(f.ctx, c, f.client)).toMatchObject({ ok: false, status: 409 }); expect(await rows(f)).toEqual(before);
    expect(exchangeSignature(c.action)).toHaveLength(64);
  });
  it.each([0, -1, 1.5, 11, 1000])("strict count %s is rejected before any write", async count => {
    const f = await fixture(), c = await command(f, 0, count), before = await rows(f);
    expect(await actNativeExchange(f.ctx, c, f.client)).toMatchObject({ ok: false, status: 400 }); expect(await rows(f)).toEqual(before);
  });
  it("stale material fingerprint and clean DB divergence reject without partial deduction", async () => {
    const f = await fixture(), c = await command(f); f.material.IsBinds = true;
    expect(await actNativeExchange(f.ctx, c, f.client)).toMatchObject({ ok: false, status: 409 });
    const fresh = await command(f); await h.db.update(player.Sys_Users_Goods).set({ Count: 39 }).where(eq(player.Sys_Users_Goods.ItemID, f.material.ItemID));
    const before = await rows(f); expect(await actNativeExchange(f.ctx, fresh, f.client)).toMatchObject({ ok: false, status: 409 }); expect(await rows(f)).toEqual(before);
  });
  it("includes actual Date values in tokens and rejects clean DB date divergence", async () => {
    const f = await fixture(), c = await command(f), beforeDate = f.material.BeginDate;
    f.material.BeginDate = new Date("2025-10-15T00:00:00Z");
    expect((await view(f)).stateToken).not.toBe(c.action.choice);
    expect(await actNativeExchange(f.ctx, c, f.client)).toMatchObject({ ok: false, status: 409 });
    f.material.BeginDate = beforeDate;
    const fresh = await command(f);
    await h.db.update(player.Sys_Users_Goods).set({ BeginDate: new Date("2024-10-15T00:00:00Z") }).where(eq(player.Sys_Users_Goods.ItemID, f.material.ItemID));
    const before = await rows(f); expect(await actNativeExchange(f.ctx, fresh, f.client)).toMatchObject({ ok: false, status: 409 });
    expect(await rows(f)).toEqual(before);
  });
  it("excludes expired/locked/upgraded/misplaced materials and offers no token when unavailable", async () => {
    const f = await fixture(); f.material.cellLocked = true;
    expect((await view(f)).materials[0]!.eligibleCount).toBe(0);
    f.material.cellLocked = false; f.material.StrengthenLevel = 1; expect((await view(f)).materials[0]!.eligibleCount).toBe(0);
    f.material.StrengthenLevel = 0; f.material.ValidDate = 1; f.material.IsUsed = true; f.material.BeginDate = new Date("2020-01-01Z");
    expect((await view(f)).materials[0]!.eligibleCount).toBe(0);
    f.material.ValidDate = 0; f.material.BagType = 0; expect((await view(f)).materials[0]!.eligibleCount).toBe(0);
    f.material.BagType = 1; f.p.info.HasBagPassword = true; f.p.info.IsLocked = true;
    const locked = await view(f); expect(locked.authority).toBe("online"); expect(locked.materials[0]!.eligibleCount).toBe(40);
    expect(locked.stateToken).toBeNull(); expect(locked.recipes.every(r => r.maxCount === 0 && !r.canExchange)).toBe(true);
  });
  it("preserves unknown A05 keys and reference save; quota resets only in a successful UTC action", async () => {
    const f = await fixture(11019, 80); await h.db.insert(app.ActivityWallet).values({ UserID: f.p.id, Points: 2, Earned: 3 });
    await h.db.insert(app.ActivityStates).values([{ UserID: f.p.id, Activity: "reference", State: { opaque: true, daily: { actions: 500 }, games: { chargeNativeV1: { grossSpent: 321 } } } },
      { UserID: f.p.id, Activity: "exchange-native", State: { version: 1, day: "2026-10-15", exchanged: [0, 0, 0, 0], future: { retained: true } } }]);
    await apply(f, 0, 10); expect((await view(f)).recipes[0]!.remaining).toBe(0); const before = await rows(f);
    f.setNow(new Date("2026-10-16T00:00:00Z")); expect((await view(f)).recipes[0]!.remaining).toBe(10); expect(await rows(f)).toEqual(before);
    await apply(f); const after = await rows(f); expect(after.wallet[0]).toMatchObject({ Points: 2, Earned: 3, Revision: 2 });
    expect(after.states.find(s => s.Activity === "reference")).toEqual(before.states.find(s => s.Activity === "reference"));
    expect(after.states.find(s => s.Activity === "exchange-native")!.State).toMatchObject({ future: { retained: true }, exchanged: [1, 0, 0, 0], day: "2026-10-16" });
  });
  it("receipt-tail failure rolls back goods/profile/mail/wallet/state and retains dirty sources for same UUID retry", async () => {
    const f = await fixture(), c = await command(f); f.material.Count = 44; f.material.isDirty = true;
    c.action.choice = (await view(f)).stateToken!; const before = await rows(f), memory = f.material.toRow(); f.frames.length = 0;
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT a05_receipt_failure CHECK ("Signature"='never-accepted') NOT VALID`);
    await expect(actNativeExchange(f.ctx, c, f.client)).rejects.toThrow(); expect(await rows(f)).toEqual(before); expect(f.material.toRow()).toEqual(memory);
    expect(f.material.isDirty).toBe(true); expect(f.frames).toEqual([]);
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT a05_receipt_failure`);
    expect(ok(await actNativeExchange(f.ctx, c, f.client)).replayed).toBe(false); expect(f.material.Count).toBe(40);
  });
  it("projects the next UTC day after COMMIT without rewriting the old receipt or carrying yesterday's quota", async () => {
    const f = await fixture(11019, 80), c = await command(f, 0, 10);
    vi.spyOn(f.ctx, "now").mockReturnValueOnce(new Date("2026-10-15T23:59:59.999Z")).mockReturnValue(new Date("2026-10-16T00:00:00Z"));
    const first = ok(await actNativeExchange(f.ctx, c, f.client)), before = await rows(f);
    expect(first.view.day).toBe("2026-10-16"); expect(first.view.recipes[0]).toMatchObject({ exchanged: 0, remaining: 10, maxCount: 10 });
    expect(first.view.stateToken).toBe((await view(f)).stateToken);
    expect(before.states.find(s => s.Activity === "exchange-native")!.State).toMatchObject({ day: "2026-10-15", exchanged: [10, 0, 0, 0] });
    expect(ok(await actNativeExchange(f.ctx, c, f.client)).replayed).toBe(true);
    expect(await rows(f)).toEqual(before); expect(before.mails).toHaveLength(1);
  });
  it("publishes every committed row before failing 64/117 transport; later save cannot resurrect materials", async () => {
    const f = await fixture(11019, 4), c = await command(f);
    vi.spyOn(f.p, "send").mockImplementation(() => { throw new Error("socket closed"); });
    const r = ok(await actNativeExchange(f.ctx, c, f.client)); expect(r.replayed).toBe(false); expect(f.material.IsExist).toBe(false); expect(f.material.isDirty).toBe(false);
    const before = await rows(f); await f.p.saveIntoDatabase(h.db); expect((await rows(f)).goods).toEqual(before.goods);
    expect(ok(await actNativeExchange(f.ctx, c, f.client)).replayed).toBe(true); expect((await rows(f)).mails).toHaveLength(1);
  });
  it("appends read/action to the socket chain and rechecks session at execution time", async () => {
    const f = await fixture(); let release!: () => void, entered = false;
    const gate = f.client.enqueueActivityExchange(() => new Promise<void>(r => { entered = true; release = r; }));
    const promise = view(f); await Promise.resolve(); expect(entered).toBe(true);
    f.material.Count = 20; f.material.isDirty = true; release(); await gate; expect((await promise).materials[0]!.eligibleCount).toBe(20);
    const c = await command(f); let release2!: () => void;
    const gate2 = f.client.enqueueActivityExchange(() => new Promise<void>(r => { release2 = r; }));
    const action = actNativeExchange(f.ctx, c, f.client); await Promise.resolve(); f.ctx.world.remove(f.p); release2(); await gate2;
    expect(await action).toMatchObject({ ok: false, status: 409 }); expect((await rows(f)).receipts).toEqual([]);
  });
  it("waits behind autosave and lets old packet31 consume the same real materials without a lost update", async () => {
    const f = await fixture(11001, 10); const activeId = 990000 + seq;
    await h.db.insert(game.Active).values({ ActiveID: activeId, Title: "old", ActiveType: 1, HasKey: 6, IsOnly: 1, IsShow: false,
      StartDate: new Date("2026-10-14Z"), EndDate: new Date("2026-10-18Z"), GoodsExchangeTypes: "11", GoodsExchangeNum: "2", limitType: "1", limitValue: "0" });
    await h.db.insert(game.Active_Convert_Item).values({ ActiveID: activeId, TemplateID: 11001, ItemType: 0, ItemCount: 2 });
    await h.db.insert(game.Active_Award).values({ ActiveID: activeId, ItemID: 11019, Count: 1 });
    const pkt = new GSPacket(31, f.p.id); [activeId, 1, 11001, 0, 1].forEach(n => pkt.writeInt(n)); pkt.offset = 20;
    const old = f.client.enqueueActivityExchange(() => exchangeActivity(f.ctx, f.p, pkt));
    const s = view(f); expect(await old).toBe(true); expect((await s).materials[1]!.eligibleCount).toBe(8);
    await apply(f, 1, 2); expect(f.material.IsExist).toBe(false);
    expect((await h.db.select().from(app.EventClaims).where(and(eq(app.EventClaims.UserID, f.p.id), eq(app.EventClaims.Kind, "exchange"))))).toHaveLength(1);
  });
  it("foreign account and unknown template fail closed without creating activity state", async () => {
    const f = await fixture(), c = await command(f), before = await rows(f);
    expect(await actNativeExchange(f.ctx, { ...c, actor: { ...c.actor, accountId: 2147483647 } }, f.client)).toMatchObject({ ok: false, status: 401 });
    f.ctx.templates.items.delete(11021); const s = await view(f); expect(s.available).toBe(false); expect(s.stateToken).toBeNull();
    expect(await actNativeExchange(f.ctx, c, f.client)).toMatchObject({ ok: false, status: 409 }); expect(await rows(f)).toEqual(before);
  });
});
