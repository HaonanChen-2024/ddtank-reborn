/** Isolated synthetic ledger/queue tests, NOT client AVM2 or real-fight acceptance. */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { app, createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { ChristmasSnowfieldOwner, readSnowfieldState, validateSnowfieldAction, type SnowfieldAction, type SnowfieldResult, type SnowfieldReply } from "../src/game/activity-christmas-snowfield.js";
import { readNativeChristmas, actNativeChristmas } from "../src/game/activity-christmas-native.js";
import { christmasFixture, christmasRoot, seedChristmasTemplates } from "./native-christmas-fixture.js";
import { RoomMgr } from "../src/rooms/room-mgr.js";
import { roomRouter } from "../src/handlers/rooms.js";
import type { FightGame, StartPveOptions } from "../src/fight/types.js";

const initial = new Date("2026-10-15T02:00:00.000Z");
let db: DbHandle, f: Awaited<ReturnType<typeof christmasFixture>>, owner: ChristmasSnowfieldOwner, clock: Date, launches: StartPveOptions[], nextId: number;
let start: (s: StartPveOptions) => FightGame | null;
const ok = <T>(r: SnowfieldReply<T>): T => { expect(r.ok, JSON.stringify(r)).toBe(true); if (!r.ok) throw new Error(r.message); return r.value; };
const read = async () => ok(await owner.read(f.input, f.client));
const sf = async () => (await read()).snowfield;
const setClock = (n: Date) => { clock = n; f.setNow(n); };
const advance = (ms: number) => setClock(new Date(clock.getTime() + ms));
const stored = async () => ({ wallet: await db.db.select().from(app.ActivityWallet), states: await db.db.select().from(app.ActivityStates), receipts: await db.db.select().from(app.ActivityActions), goods: await db.db.select().from(player.Sys_Users_Goods), mail: await db.db.select().from(player.User_Messages) });
async function cmd(type: "enter" | "npc-claim" | "challenge", index = 0, id = randomUUID()) {
  const choice = (await sf()).stateToken!;
  return { ...f.input, requestId: id, action: (type === "challenge" ? { type, index, choice } : { type, choice }) as SnowfieldAction };
}
async function enter() { const r = ok(await owner.command(await cmd("enter"), f.client)); await owner.enterScene(f.client, f.p, { x: 999, y: 999 }); return r; }
async function admitted() { await enter(); const r = ok(await owner.command(await cmd("challenge"), f.client)); expect(r.pair.snowfield.attempt.canResume).toBe(true); return r; }
async function tickUntil<T>(work: Promise<T>): Promise<T> { let done = false; void work.then(() => { done = true; }, () => { done = true; }); for (let i = 0; i < 100 && !done; i++) { await new Promise<void>(r => setImmediate(r)); f.ctx.rooms.tick(); } expect(done).toBe(true); return work; }
async function queuedHandoff() { const spy = vi.spyOn(f.ctx.rooms, "createSnowfieldRoom"), work = owner.handoffChallenge(f.client, f.p, 1); for (let i = 0; i < 100 && !spy.mock.calls.length; i++) await new Promise<void>(r => setImmediate(r)); expect(spy).toHaveBeenCalledOnce(); spy.mockRestore(); return { work }; }
async function room() { await admitted(); await tickUntil(owner.handoffChallenge(f.client, f.p, 1)); expect(f.p.currentRoom?.RoomType).toBe(40); return f.p.currentRoom!; }
async function launch() { const r = await room(); const permit = await owner.prepareStart(f.client, f.p, r); expect(permit.ok).toBe(true); f.ctx.rooms.startGame(r); f.ctx.rooms.tick(); expect(launches).toHaveLength(1); return r; }
const decodeScene = (sent: GSPacket[]) => sent.map(p => GSPacket.parse(p.encode())).filter(p => p.code === 145).map(packet => ({ sub: packet.readByte(), packet }));
function movePacket(path = "499,500", x = 499, y = 500) { const b = new GSPacket(145); b.writeByte(21); b.writeInt(x); b.writeInt(y); b.writeUTF(path); return b; }
function readMove(b: GSPacket) { const value = { id: b.readInt(), x: b.readInt(), y: b.readInt(), path: b.readString() }; expect(b.dataLeft).toBe(0); return value; }
function readSnapshot(b: GSPacket) {
  expect(b.readInt()).toBe(1); b.readInt(); b.readInt(); b.readInt(); const id = b.readInt(); b.readString(); b.readByte(); b.readInt(); b.readBoolean();
  b.readString(); b.readString(); b.readString(); b.readInt(); b.readInt(); b.readInt(); b.readInt(); const value = { id, x: b.readInt(), y: b.readInt(), state: b.readByte() }; expect(b.dataLeft).toBe(0); return value;
}
async function enterPeer() {
  const g = await christmasFixture(db, 932, clock); g.ctx.world = f.ctx.world; g.ctx.rooms = f.ctx.rooms; g.ctx.now = f.ctx.now; f.ctx.world.add(g.p);
  const choice = ok(await owner.read(g.input, g.client)).snowfield.stateToken!;
  ok(await owner.command({ ...g.input, requestId: randomUUID(), action: { type: "enter", choice } }, g.client)); await owner.enterScene(g.client, g.p, { x: 500, y: 500 }); return g;
}
beforeAll(async () => { db = await createDb("pglite:memory"); await migrateDb(db); await seedChristmasTemplates(db); });
beforeEach(async () => {
  await db.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS snowfield_tail_failure`);
  await db.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  f = await christmasFixture(db, 931, initial); clock = initial; launches = []; nextId = 700;
  vi.spyOn(f.p, "hasMainWeapon", "get").mockReturnValue(true);
  start = s => ({ id: ++nextId, mapId: 1201, processData() {}, removePlayer() {}, stop() { s.onStopped(); } });
  owner = new ChristmasSnowfieldOwner(f.ctx, { isolatedTestFixture: true, ready: true });
  f.ctx.rooms = new RoomMgr({ maxRooms: 3, fight: { name: "isolated-callback-fixture", startPvp: () => null, startPve(s) { launches.push(s); return start(s); } }, lang: s => s, christmasSnowfield: owner });
});
afterEach(() => vi.restoreAllMocks()); afterAll(async () => { await db.close(); });

describe("Christmas real-scene admission owner with synthetic ledger", () => {
  it("production stays closed; same-read pair keeps wallet/day/entry exact and GET zero-write", async () => {
    const closed = new ChristmasSnowfieldOwner(f.ctx), before = await stored(), pair = ok(await closed.read(f.input, f.client));
    expect(pair.snowfield).toMatchObject({ available: false, stateToken: null, points: 100, taskEarned: 200 });
    expect(pair.snowman.snowfield).toEqual(pair.snowfield.entry); expect(pair.snowman.available).toBe(true); expect(await stored()).toEqual(before);
  });
  it("never initializes wallet/reference/native on an unstarted GET", async () => {
    await db.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityWallet",app."ActivityStates"`); const before = await stored(), pair = await read();
    expect(pair.snowfield.ticket.qualifiedToday).toBe(false); expect(pair.snowfield.challenges).toHaveLength(3); expect(pair.snowman.snowfield).toEqual(pair.snowfield.entry); expect(await stored()).toEqual(before);
  });
  it("strict actions reject extras, wrong dates, raw templates or index with no write", async () => {
    const before = await stored(), c = await cmd("enter");
    for (const action of [{ ...c.action, count: 1 }, { type: "challenge", index: 3, choice: c.action.choice }, { ...c.action, templateId: 201145 }, { ...c.action, choice: "2026-02-31." + "A".repeat(43) }]) {
      expect(() => validateSnowfieldAction(action)).toThrow(); expect(await owner.command({ ...c, action }, f.client)).toMatchObject({ ok: false, status: 400 });
    } expect(await stored()).toEqual(before);
  });
  it("one free30minute ticket, no auto-entry, lost POST replays then explicit phase2 at fixed spawn", async () => {
    const c = await cmd("enter"), r = ok(await owner.command(c, f.client)), before = await stored();
    expect(r.nativeChristmasAction!.effects[0]).toMatchObject({ type: "entered", issued: true }); expect(r.pair.snowfield.scene).toMatchObject({ state: "loading", canResume: true });
    expect(ok(await owner.command(c, f.client))).toMatchObject({ replayed: true }); expect(await stored()).toEqual(before);
    await owner.enterScene(f.client, f.p, { x: 1500, y: 900 }); expect((await sf()).scene.state).toBe("inside"); expect((await sf()).challenges[1]!.canChallenge).toBe(false);
    await owner.enterScene(f.client, f.p, { x: 0, y: 0 }); expect((await sf()).scene.people).toBe(1);
    advance(1800001); expect((await sf()).entry.available).toBe(false); expect(await owner.command(await cmd("enter"), f.client)).toMatchObject({ ok: false });
    expect((await stored()).wallet[0]).toMatchObject({ Points: 100, Earned: 200, Revision: 1 });
  });
  it("same UUID replay precedes offline/token and cannot replay another action", async () => {
    const c = await cmd("enter"); ok(await owner.command(c, f.client)); f.client.closed = true; f.ctx.world.remove(f.p); const before = await stored();
    const r = ok(await owner.command(c)); expect(r).toMatchObject({ replayed: true, pair: { snowfield: { authority: "offline", stateToken: null } } }); expect(r.nativeChristmasAction).toBeUndefined();
    expect(await owner.command({ ...c, action: { ...c.action, type: "npc-claim" } })).toMatchObject({ ok: false, status: 409 }); expect(await stored()).toEqual(before);
  });
  it("raw scene/fight handoff cannot create a ticket or room; movement cannot tunnel or teleport", async () => {
    await expect(owner.enterScene(f.client, f.p, { x: 500, y: 500 })).rejects.toThrow(); await expect(owner.handoffChallenge(f.client, f.p, 1)).rejects.toThrow();
    f.ctx.rooms.createRoom(f.p, "forged", "", 40, 3); f.ctx.rooms.tick(); expect(f.p.currentRoom).toBeNull();
    await enter(); const before = await stored(); expect(() => owner.move(f.client, f.p, { x: 900, y: 1 }, "900,1")).toThrow(); expect(() => owner.move(f.client, f.p, { x: 500, y: 500 }, "NaN,500")).toThrow();
    expect((await sf()).challenges[1]!.canChallenge).toBe(false); expect(await stored()).toEqual(before);
  });
  it("accepted movement acknowledges self with only original21 and keeps the same peer route", async () => {
    await enter(); const g = await enterPeer(), self = vi.spyOn(f.p, "send"), peer = vi.spyOn(g.p, "send"), before = await stored();
    await owner.handle(f.p, f.client, GSPacket.parse(movePacket("499,500,500,500,499,500").encode()));
    for (const sent of [self, peer]) { const packets = decodeScene(sent.mock.calls.map(([p]) => p)); expect(packets.map(p => p.sub)).toEqual([21]);
      expect(readMove(packets[0]!.packet)).toEqual({ id: f.p.id, x: 499, y: 500, path: "499,500,500,500,499,500" }); }
    expect(await stored()).toEqual(before);
  });
  it("rejection snapshots one instant then resumes only the unwalked old route without changing authority or peers", async () => {
    await enter(); const g = await enterPeer(), self = vi.spyOn(f.p, "send"), peer = vi.spyOn(g.p, "send");
    owner.move(f.client, f.p, { x: 499, y: 500 }, "499,500,500,500,499,500"); self.mockClear(); peer.mockClear(); advance(10);
    const before = await stored(), state = await sf(), now = vi.spyOn(f.ctx, "now");
    await owner.handle(f.p, f.client, GSPacket.parse(movePacket("NaN,500").encode())); expect(now).toHaveBeenCalledOnce(); now.mockRestore();
    const packets = decodeScene(self.mock.calls.map(([p]) => p)); expect(packets.map(p => p.sub)).toEqual([18, 21]);
    expect(readSnapshot(packets[0]!.packet)).toEqual({ id: f.p.id, x: 500, y: 500, state: 0 });
    expect(readMove(packets[1]!.packet)).toEqual({ id: f.p.id, x: 499, y: 500, path: "500,500,499,500" });
    expect(decodeScene(peer.mock.calls.map(([p]) => p))).toEqual([]); expect(await stored()).toEqual(before);
    expect(await sf()).toMatchObject({ stateToken: state.stateToken, scene: { revision: state.scene.revision } });
    self.mockClear(); advance(10); await owner.handle(f.p, f.client, GSPacket.parse(movePacket("NaN,500").encode()));
    const ended = decodeScene(self.mock.calls.map(([p]) => p)); expect(ended.map(p => p.sub)).toEqual([18, 21]);
    expect(readSnapshot(ended[0]!.packet)).toEqual({ id: f.p.id, x: 499, y: 500, state: 0 });
    expect(readMove(ended[1]!.packet)).toEqual({ id: f.p.id, x: 499, y: 500, path: "" }); expect(decodeScene(peer.mock.calls.map(([p]) => p))).toEqual([]);
    expect(await sf()).toMatchObject({ stateToken: state.stateToken, scene: { revision: state.scene.revision } }); expect(await stored()).toEqual(before);
  });
  it("direct move rejection emits one correction and a following acceptance stays last in packet order", async () => {
    await enter(); const sent = vi.spyOn(f.p, "send"), before = await stored(), state = await sf();
    expect(() => owner.move(f.client, f.p, { x: 499, y: 500 }, "NaN,500")).toThrow();
    expect((await sf()).scene.revision).toBe(state.scene.revision);
    await owner.handle(f.p, f.client, GSPacket.parse(movePacket().encode()));
    const packets = decodeScene(sent.mock.calls.map(([p]) => p)); expect(packets.map(p => p.sub)).toEqual([18, 21, 21]);
    expect(readMove(packets[1]!.packet)).toEqual({ id: f.p.id, x: 500, y: 500, path: "" });
    expect(readMove(packets[2]!.packet)).toEqual({ id: f.p.id, x: 499, y: 500, path: "499,500" }); expect(await stored()).toEqual(before);
  });
  it("trajectory correction trims exact segment boundaries, samples the last segment and ends with an empty route", async () => {
    await enter(); const sent = vi.spyOn(f.p, "send"), path = "499,500,500,500,499,500,500,500,499,500,500,500,499,500,500,500";
    owner.move(f.client, f.p, { x: 500, y: 500 }, path); const state = await sf(), before = await stored();
    for (const [ms, x, remaining] of [[25, 500, "499,500,500,500,499,500,500,500"], [45, 499, "500,500"], [50, 500, ""]] as const) {
      setClock(new Date(initial.getTime() + ms)); sent.mockClear(); await owner.handle(f.p, f.client, GSPacket.parse(movePacket("NaN,500").encode()));
      const packets = decodeScene(sent.mock.calls.map(([p]) => p)); expect(packets.map(p => p.sub)).toEqual([18, 21]);
      expect(readSnapshot(packets[0]!.packet)).toEqual({ id: f.p.id, x, y: 500, state: 0 });
      expect(readMove(packets[1]!.packet)).toEqual({ id: f.p.id, x: 500, y: 500, path: remaining });
      expect(await sf()).toMatchObject({ stateToken: state.stateToken, scene: { revision: state.scene.revision } });
    }
    expect(await stored()).toEqual(before);
  });
  it("invalid route payloads correct once and never echo their forged target or empty inbound path", async () => {
    await enter(); const sent = vi.spyOn(f.p, "send"), before = await stored(), state = await sf();
    for (const [path, x, y] of [["", 777, 888], ["NaN,500", 777, 888], ["499,500,498", 777, 888], ["499,500", 777, 888], ["900,1", 900, 1], ["A".repeat(4097), 777, 888], ["4097,500", 4097, 500], [Array(258).fill(500).join(","), 500, 500]] as const) {
      sent.mockClear(); await owner.handle(f.p, f.client, GSPacket.parse(movePacket(path, x, y).encode()));
      const packets = decodeScene(sent.mock.calls.map(([p]) => p)); expect(packets.map(p => p.sub)).toEqual([18, 21]);
      expect(readSnapshot(packets[0]!.packet)).toEqual({ id: f.p.id, x: 500, y: 500, state: 0 });
      expect(readMove(packets[1]!.packet)).toEqual({ id: f.p.id, x: 500, y: 500, path: "" });
    }
    expect(await sf()).toMatchObject({ stateToken: state.stateToken, scene: { revision: state.scene.revision } }); expect(await stored()).toEqual(before);
  });
  it("malformed21 tails and truncated or invalid string bodies correct through the same owner", async () => {
    await enter(); const sent = vi.spyOn(f.p, "send"), before = await stored(), packets = [movePacket()]; packets[0]!.writeByte(1);
    const subOnly = new GSPacket(145); subOnly.writeByte(21); packets.push(subOnly);
    const missingPath = new GSPacket(145); missingPath.writeByte(21); missingPath.writeInt(499); missingPath.writeInt(500); packets.push(missingPath);
    for (const length of [-1, 32767]) { const b = new GSPacket(145); b.writeByte(21); b.writeInt(499); b.writeInt(500); b.writeShort(length); packets.push(b); }
    const truncated = new GSPacket(145); truncated.writeByte(21); truncated.writeInt(499); truncated.writeInt(500); truncated.writeShort(7); truncated.writeByte(49); packets.push(truncated);
    for (const packet of packets) { sent.mockClear(); await owner.handle(f.p, f.client, GSPacket.parse(packet.encode()));
      const correction = decodeScene(sent.mock.calls.map(([p]) => p)); expect(correction.map(p => p.sub)).toEqual([18, 21]);
      expect(readSnapshot(correction[0]!.packet)).toEqual({ id: f.p.id, x: 500, y: 500, state: 0 });
      expect(readMove(correction[1]!.packet)).toEqual({ id: f.p.id, x: 500, y: 500, path: "" }); }
    expect(await stored()).toEqual(before);
  });
  it.each(["outside", "left", "wrong-session", "replaced-player", "closed", "inactive", "quitting", "room", "lease", "creating"] as const)("rejected movement cannot revive or correct a %s scene", async mode => {
    let queued: { work: Promise<void> } | undefined, client = f.client, p = f.p;
    if (mode === "room" || mode === "lease") { const r = await room(); if (mode === "lease") r.removePlayer(f.p); }
    else if (mode === "creating") { await admitted(); queued = await queuedHandoff(); }
    else if (mode !== "outside") await enter();
    if (mode === "left") await owner.leaveScene(f.client, f.p);
    else if (mode === "wrong-session") { const g = await christmasFixture(db, 932, clock); client = g.client; client.player = p; }
    else if (mode === "replaced-player") { p = Object.create(f.p) as typeof f.p; client.player = p; f.ctx.world.add(p); }
    else if (mode === "closed") f.client.closed = true;
    else if (mode === "inactive") f.p.isActive = false;
    else if (mode === "quitting") f.p.quitting = Promise.resolve();
    const sent = vi.spyOn(p, "send"); await owner.handle(p, client, GSPacket.parse(movePacket("NaN,500").encode())); expect(decodeScene(sent.mock.calls.map(([b]) => b))).toEqual([]);
    if (queued) await tickUntil(queued.work);
  });
  it("unknown movement faults still reject the handler and never produce an authority packet", async () => {
    await enter(); const sent = vi.spyOn(f.p, "send"), error = new Error("isolated movement fault"); vi.spyOn(f.ctx, "now").mockImplementation(() => { throw error; });
    await expect(owner.handle(f.p, f.client, GSPacket.parse(movePacket().encode()))).rejects.toBe(error); expect(decodeScene(sent.mock.calls.map(([p]) => p))).toEqual([]);
  });
  it("shared500 never blocks dedicated admission and no task/gross/earned is fabricated", async () => {
    await db.db.update(app.ActivityStates).set({ State: christmasRoot(initial, 500) }); const before = christmasRoot(initial, 500); await admitted();
    const s = await stored(); expect(s.states.find(r => r.Activity === "reference")!.State).toEqual(before); expect(s.wallet[0]).toMatchObject({ Points: 100, Earned: 200 });
    expect((await sf()).challenges[0]).toMatchObject({ usedToday: 1, remainingToday: 2 }); expect(s.mail).toEqual([]);
  });
  it("lost challenge response exposes explicit resume; duplicate raw handoff creates only one real room", async () => {
    await enter(); const c = await cmd("challenge"); const fresh = ok(await owner.command(c, f.client)), replay = ok(await owner.command(c, f.client));
    expect(fresh.nativeChristmasAction!.effects[0].type).toBe("challenged"); expect(replay.nativeChristmasAction).toBeUndefined(); expect(replay.pair.snowfield.attempt.canResume).toBe(true);
    await tickUntil(owner.handoffChallenge(f.client, f.p, 1)); const r = f.p.currentRoom!; await owner.handoffChallenge(f.client, f.p, 1); expect(f.ctx.rooms.usingRooms()).toEqual([r]);
    f.ctx.rooms.startGame(r); f.ctx.rooms.tick(); expect(launches).toEqual([]); // no94/7 durable launch yet
    const setup = { roomType: 40, mapId: 164001, originalMissionId: 40002, timeMode: 3, hardLevel: 0, levelLimits: 0, password: "", name: "", isOpenBoss: false, isCrosszone: false };
    expect(owner.checkRoom(r, [f.p], setup).ok).toBe(false);
  });
  it("expired definitely unlaunched admission refunds once on explicit POST, not GET", async () => {
    await admitted(); advance(30001); const before = await stored(); expect((await sf()).attempt).toMatchObject({ refundPending: true, canResume: false }); expect((await sf()).challenges[0]).toMatchObject({ state: "alive", canChallenge: true }); expect(await stored()).toEqual(before);
    const r = ok(await owner.command(await cmd("challenge"), f.client)); expect(r.pair.snowfield.challenges[0]!.usedToday).toBe(1);
    const s = (await stored()).states.find(r => r.Activity === "christmas-snowfield")!.State as ReturnType<typeof readSnowfieldState>;
    expect(s.terminals).toHaveLength(1); expect(s.terminals[0]).toMatchObject({ quotaReturned: true, outcome: "aborted" });
  });
  it("handoff rechecks actual interpolated distance after walking away", async () => {
    await admitted(); owner.move(f.client, f.p, { x: 499, y: 500 }, "499,500"); advance(10);
    expect((await sf()).attempt.canResume).toBe(false); await expect(owner.handoffChallenge(f.client, f.p, 1)).rejects.toThrow(); expect(f.p.currentRoom).toBeNull();
  });
  it("RoomMgr rechecks ticket expiry after handoff queued but before create", async () => {
    await enter(); advance(1799990); ok(await owner.command(await cmd("challenge"), f.client));
    const { work } = await queuedHandoff(); advance(11); await tickUntil(work); expect(f.p.currentRoom).toBeNull();
    expect((await stored()).states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ usedToday: [0, 0, 0], terminals: [{ outcome: "aborted", quotaReturned: true }] });
  });
  it.each(["inactive", "quitting", "stopped"] as const)("queued room create resolves on %s instead of hanging handoff or shutdown", async mode => {
    await admitted(); const { work } = await queuedHandoff();
    if (mode === "inactive") f.p.isActive = false; else if (mode === "quitting") f.p.quitting = Promise.resolve(); else f.ctx.rooms.stop();
    await tickUntil(work); expect(f.p.currentRoom).toBeNull(); expect(f.ctx.rooms.usingRooms()).toEqual([]);
    const saved = (await stored()).states.find(r => r.Activity === "christmas-snowfield")!.State;
    expect(saved).toMatchObject({ active: null, usedToday: [0, 0, 0], terminals: [{ quotaReturned: true }] });
  });
  it("controlled room notification failure resolves rejected handoff and returns its unstarted quota", async () => {
    await admitted(); const { work } = await queuedHandoff(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(f.p, "send").mockImplementationOnce(() => { throw new Error("isolated closed socket"); });
    await tickUntil(work); expect(f.p.currentRoom).toBeNull(); expect(launches).toEqual([]);
    expect((await stored()).states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ active: null, usedToday: [0, 0, 0], terminals: [{ outcome: "aborted", quotaReturned: true }] });
  });
  it("old server launch intent conservatively aborts without refund then accepts an explicit new enter", async () => {
    await admitted(); const row = (await stored()).states.find(r => r.Activity === "christmas-snowfield")!, s = row.State as ReturnType<typeof readSnowfieldState>;
    s.active!.status = "launching"; s.active!.launchIntentAt = clock.toISOString(); s.active!.roomId = 7;
    await db.db.update(app.ActivityStates).set({ State: s }).where(sql`"Activity"='christmas-snowfield'`);
    owner = new ChristmasSnowfieldOwner(f.ctx, { isolatedTestFixture: true, ready: true });
    expect((await sf()).entry.available).toBe(true);
    const r = ok(await owner.command(await cmd("enter"), f.client)); expect(r.pair.snowfield.scene).toMatchObject({ state: "loading", canResume: true });
    expect((await stored()).states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ active: null, usedToday: [1, 0, 0], terminals: [{ outcome: "aborted", quotaReturned: false, rewardMailed: false }] });
  });
  it("explicit return from inside publishes loading without duplicating members or resetting position", async () => {
    await enter(); owner.move(f.client, f.p, { x: 499, y: 500 }, "499,500"); advance(10); const before = await stored();
    expect((await sf()).scene).toMatchObject({ state: "inside", canResume: false, people: 1 }); expect(await stored()).toEqual(before);
    const r = ok(await owner.command(await cmd("enter"), f.client)); expect(r.nativeChristmasAction!.effects[0].type).toBe("entered"); expect(r.pair.snowfield.scene).toMatchObject({ state: "loading", canResume: true, people: 1 }); expect(r.pair.snowfield.challenges.every(c => !c.canChallenge)).toBe(true);
    await owner.enterScene(f.client, f.p, { x: 500, y: 500 }); expect((await sf()).scene).toMatchObject({ state: "inside", canResume: false, people: 1 });
    expect(await owner.command(await cmd("challenge"), f.client)).toMatchObject({ ok: false }); // Still151px away; phase2 did not teleport back.
  });
  it("actual accepted fight ID wins once; late duplicate callbacks and ticket expiry cannot lose earned reward", async () => {
    await launch(); advance(1800001); launches[0]!.onFinished!(true); launches[0]!.onFinished!(true); launches[0]!.onStopped(); await owner.drain();
    let s = await stored(); expect(s.mail).toHaveLength(1); expect(s.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ hasSettledWinToday: true, active: null, terminals: [{ fightId: 701, outcome: "win", rewardMailed: true }] });
    f.p.currentRoom?.removePlayer(f.p); const c = await cmd("npc-claim"), r = ok(await owner.command(c, f.client)); expect(r.mailedCount).toBe(1);
    expect(ok(await owner.command(c, f.client)).replayed).toBe(true); s = await stored(); expect(s.mail).toHaveLength(2); expect(s.wallet[0]).toMatchObject({ Points: 100, Earned: 200 });
  });
  it("inline finish/stop before startPve returns still latches actual ID and one winning terminal", async () => {
    start = s => { s.onFinished!(true); s.onStopped(); return { id: 812, mapId: 1201, processData() {}, removePlayer() {}, stop() {} }; };
    await launch(); await owner.drain(); const s = await stored(); expect(s.mail).toHaveLength(1); expect(s.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ terminals: [{ fightId: 812, outcome: "win" }] });
  });
  it("stopped without a winning result never wins and consumed admission stays spent", async () => {
    await launch(); launches[0]!.onStopped(); await owner.drain(); const s = await stored(); expect(s.mail).toEqual([]); expect(s.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ usedToday: [1, 0, 0], hasSettledWinToday: false, terminals: [{ outcome: "aborted", quotaReturned: false }] });
  });
  it("technical start rejection refunds once, voluntary exit before start does not", async () => {
    start = () => null; await launch(); await owner.drain(); let s = await stored(); expect(s.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ usedToday: [0, 0, 0], terminals: [{ quotaReturned: true }] });
    f.p.currentRoom?.removePlayer(f.p); await owner.leaveScene(f.client, f.p); await admitted(); await owner.leaveScene(f.client, f.p); s = await stored(); expect(s.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ usedToday: [1, 0, 0] });
  });
  it.each([false, true])("raw scene exit releases its unseen CREATE room after settlement (accepted=%s), without refund or duplicate exit", async accepted => {
    const r = accepted ? await launch() : await room();
    const leave = () => { const packet = new GSPacket(145); packet.writeByte(17); packet.writeByte(1); return owner.handle(f.p, f.client, GSPacket.parse(packet.encode())); };
    await leave(); expect(f.p.currentRoom).toBe(r); f.ctx.rooms.tick();
    expect(f.p.currentRoom).toBeNull(); expect(r.IsUsing).toBe(false); expect((await sf()).scene).toMatchObject({ state: "outside", people: 0 });
    const settled = await stored(); expect(settled.mail).toEqual([]);
    expect(settled.states.find(row => row.Activity === "christmas-snowfield")!.State).toMatchObject({ active: null, usedToday: [1, 0, 0], terminals: [{ outcome: "aborted", fightId: accepted ? 701 : null, quotaReturned: false }] });
    await leave(); const exit = new GSPacket(94); exit.writeInt(5); await roomRouter().handler(f.ctx, f.p, GSPacket.parse(exit.encode()), f.client); f.ctx.rooms.tick();
    expect(await stored()).toEqual(settled); expect(f.p.currentRoom).toBeNull();
    const resumed = ok(await owner.command(await cmd("enter"), f.client)); expect(resumed.pair.snowfield.scene.canResume).toBe(true);
    await owner.enterScene(f.client, f.p, { x: 500, y: 500 }); expect((await sf()).scene.state).toBe("inside");
  });
  it("original94/5 and the owned scene exit share one successful room removal and one settlement", async () => {
    const r = await room(), removed = vi.spyOn(r, "removePlayer");
    const exit = () => { const packet = new GSPacket(94); packet.writeInt(5); return roomRouter().handler(f.ctx, f.p, GSPacket.parse(packet.encode()), f.client); };
    await exit(); f.ctx.rooms.tick(); expect(f.p.currentRoom).toBeNull(); expect(removed.mock.results.filter(result => result.value === true)).toHaveLength(1);
    const settled = await stored(); await exit(); f.ctx.rooms.tick(); expect(await stored()).toEqual(settled);
    expect(settled.states.find(row => row.Activity === "christmas-snowfield")!.State).toMatchObject({ usedToday: [1, 0, 0], terminals: [{ outcome: "aborted", quotaReturned: false }] });
  });
  it.each(["before-leave", "after-queue"] as const)("an owned exit cannot clear a replacement current room (%s)", async when => {
    const r = await room(), other = f.ctx.rooms.rooms.find(candidate => candidate !== r)!;
    const changeRoom = () => { r.removePlayer(f.p); other.start(); other.updateRoom("replacement", "", 1, 3, 0); other.addPlayer(f.p); };
    if (when === "before-leave") changeRoom();
    await owner.leaveScene(f.client, f.p);
    if (when === "after-queue") changeRoom();
    const removed = vi.spyOn(other, "removePlayer"); f.ctx.rooms.tick();
    expect(f.p.currentRoom).toBe(other); expect(other.getPlayers()).toEqual([f.p]); expect(removed).not.toHaveBeenCalled();
  });
  it("a stale queued exit refuses a new lease even when the same room object and single player are reused", async () => {
    const r = await room(), exits = vi.spyOn(f.ctx.rooms, "exitRoom"); await owner.leaveScene(f.client, f.p);
    const canExit = exits.mock.calls[0]![2]!; expect(canExit).toBeTypeOf("function");
    r.removePlayer(f.p); r.stop(); for (const other of f.ctx.rooms.rooms) if (other !== r) other.start();
    await admitted(); await tickUntil(owner.handoffChallenge(f.client, f.p, 1)); expect(f.p.currentRoom).toBe(r); expect(owner.checkRoom(r, [f.p]).ok).toBe(true);
    const before = await stored(); f.ctx.rooms.exitRoom(r, f.p, canExit); f.ctx.rooms.tick();
    expect(f.p.currentRoom).toBe(r); expect(r.getPlayers()).toEqual([f.p]); expect(owner.checkRoom(r, [f.p]).ok).toBe(true); expect(await stored()).toEqual(before);
  });
  it.each([false, true])("a failed exit settlement preserves room/member and the beforeQuit retry proof (accepted=%s)", async accepted => {
    const r = accepted ? await launch() : await room(), before = await stored();
    await db.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT snowfield_tail_failure CHECK ("Signature"='never') NOT VALID`);
    const exit = vi.spyOn(f.ctx.rooms, "exitRoom"); await expect(owner.leaveScene(f.client, f.p)).rejects.toThrow(); f.ctx.rooms.tick();
    expect(exit).not.toHaveBeenCalled(); expect(f.p.currentRoom).toBe(r); expect(r.getPlayers()).toEqual([f.p]); expect((await sf()).scene.people).toBe(1); expect(await stored()).toEqual(before);
    await db.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT snowfield_tail_failure`); await owner.beforeQuit(f.p); await owner.drain();
    const final = await stored(); expect(final.mail).toEqual([]); expect(final.states.find(row => row.Activity === "christmas-snowfield")!.State).toMatchObject({ active: null, usedToday: [1, 0, 0], terminals: [{ fightId: accepted ? 701 : null, outcome: "aborted", quotaReturned: false }] });
    expect((await sf()).scene.people).toBe(0);
  });
  it("receipt-tail failure rolls back mail/goods/state/wallet, pending win retries before quit", async () => {
    await launch(); const before = await stored(); await db.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT snowfield_tail_failure CHECK ("Signature"='never') NOT VALID`);
    launches[0]!.onFinished!(true); await expect(owner.drain()).rejects.toThrow(); expect(await stored()).toEqual(before);
    await db.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT snowfield_tail_failure`); vi.spyOn(f.p, "send").mockImplementation(() => { throw new Error("isolated postcommit notification"); }); await owner.beforeQuit(f.p); const final = await stored(); expect(final.mail).toHaveLength(1);
    await f.p.saveIntoDatabase(db.db); expect((await stored()).states).toEqual(final.states); expect((await stored()).mail).toEqual(final.mail);
  });
  it("synchronous winning callback registers pending before quit/stop; no client-chain self-wait", async () => {
    await launch(); let release!: () => void; const blocking = f.p.withPersistenceLock(() => new Promise<void>(r => release = r));
    await Promise.resolve(); launches[0]!.onFinished!(true); let quitDone = false; const quit = owner.beforeQuit(f.p).then(() => { quitDone = true; });
    await new Promise(r => setTimeout(r, 10)); expect(quitDone).toBe(false); release(); await blocking; await quit; owner.beginShutdown(); await owner.drain(); expect((await stored()).mail).toHaveLength(1);
  });
  it("disconnect before any outcome seals abort; later onFinished cannot fabricate a victory", async () => {
    await launch(); await owner.beforeQuit(f.p); launches[0]!.onFinished!(true); await owner.drain(); expect((await stored()).mail).toEqual([]);
  });
  it("future/corrupt private rows preserve originals and disable only snowfield", async () => {
    const c = await cmd("enter"); ok(await owner.command(c, f.client)); const bad = { version: 99, untouched: ["keep"] };
    await db.db.update(app.ActivityStates).set({ State: bad }).where(sql`"Activity"='christmas-snowfield'`); const before = await stored(), pair = await read();
    expect(pair.snowfield).toMatchObject({ available: false, authority: "unavailable", stateToken: null }); expect(pair.snowman.available).toBe(true);
    expect(ok(await owner.command(c, f.client)).replayed).toBe(true); expect(await stored()).toEqual(before);
  });
  it("UTC retains ticket expiry/permanent old grid, clears only new day's dedicated counters", async () => {
    await admitted(); advance(86400000); const before = await stored(), pair = await read();
    expect(pair.snowfield.challenges.map(r => r.usedToday)).toEqual([0, 0, 0]); expect(pair.snowfield.ticket).toMatchObject({ valid: false, qualifiedToday: false, issuedToday: false }); expect(await stored()).toEqual(before);
    expect((await readNativeChristmas(f.ctx, f.input, f.client)).ok).toBe(true);
  });
  it("old craft owner retains economics, unknown fields, old16grid and native snowfield row", async () => {
    await enter(); const before = await stored(), old = await readNativeChristmas(f.ctx, f.input, f.client); expect(old.ok).toBe(true); if (!old.ok) return;
    expect(old.value.snowfield.available).toBe(false); const r = await actNativeChristmas(f.ctx, { ...f.input, requestId: randomUUID(), action: { type: "craft", count: 2, marked: true, choice: old.value.stateToken! } }, f.client); expect(r.ok).toBe(true);
    const after = await stored(); expect(after.states.find(r => r.Activity === "christmas-snowfield")).toEqual(before.states.find(r => r.Activity === "christmas-snowfield"));
    expect(after.states.find(r => r.Activity === "reference")!.State).toMatchObject({ games: christmasRoot(initial).games, daily: { actions: 1 }, unknownRoot: { keep: true } });
  });
  it("full original94 tail is required and does not admit a forged40 setup", async () => {
    const r = await room(); const packet = new GSPacket(94); packet.writeInt(2); packet.writeInt(164001); packet.writeByte(40); packet.writeBoolean(false); packet.writeString(""); packet.writeString(""); packet.writeByte(3); packet.writeByte(0); packet.writeInt(0); packet.writeBoolean(false); packet.writeInt(40002);
    await roomRouter().handler(f.ctx, f.p, GSPacket.parse(packet.encode()), f.client); f.ctx.rooms.tick(); expect(r.MapId).toBe(164001); expect(launches).toEqual([]);
  });
  it("real queue and persistence defer GET and recheck current world object", async () => {
    let release!: () => void; const block = f.client.enqueueActivityChristmas(() => new Promise<void>(r => release = r)); let done = false;
    const reading = read().then(r => { done = true; return r; }); await new Promise(r => setTimeout(r, 10)); expect(done).toBe(false); release(); await block; await reading;
    const c = await cmd("enter"); let unlock!: () => void; const save = f.p.withPersistenceLock(() => new Promise<void>(r => unlock = r)); const write = owner.command(c, f.client); await new Promise(r => setTimeout(r, 10)); f.ctx.world.remove(f.p); unlock(); await save; expect(await write).toMatchObject({ ok: false }); expect((await stored()).receipts).toEqual([]);
  });
  it("two real role sessions synchronize original18/19 players,20 status and22 monsters without fake actors", async () => {
    await enter(); const a = vi.spyOn(f.p, "send"), g = await christmasFixture(db, 932, clock); g.ctx.world = f.ctx.world; g.ctx.rooms = f.ctx.rooms; g.ctx.now = f.ctx.now; f.ctx.world.add(g.p);
    const token = ok(await owner.read(g.input, g.client)).snowfield.stateToken!;
    expect(ok(await owner.read(g.input, f.client)).snowfield).toMatchObject({ authority: "offline", available: false });
    ok(await owner.command({ ...g.input, requestId: randomUUID(), action: { type: "enter", choice: token } }, g.client));
    const b = vi.spyOn(g.p, "send"); await owner.enterScene(g.client, g.p, { x: 1, y: 2 }); expect((await sf()).scene.people).toBe(2);
    const decode = (p: GSPacket) => GSPacket.parse(p.encode()), sent = a.mock.calls.map(([p]) => decode(p)).filter(p => p.code === 145);
    const added = sent.find(p => p.readByte() === 18)!; expect(added.readInt()).toBe(1); added.readInt(); added.readInt(); added.readInt(); expect(added.readInt()).toBe(g.p.id);
    const monsters = b.mock.calls.map(([p]) => decode(p)).find(p => p.code === 145 && p.readByte() === 22)!; expect(monsters.readByte()).toBe(0); expect(monsters.readInt()).toBe(3);
    await owner.revive(g.client, g.p); const status = a.mock.calls.map(([p]) => decode(p)).find(p => p.code === 145 && p.readByte() === 20)!; expect(status.readInt()).toBe(g.p.id);
    await owner.leaveScene(g.client, g.p); const removed = a.mock.calls.map(([p]) => decode(p)).find(p => p.code === 145 && p.readByte() === 19)!; expect(removed.readInt()).toBe(g.p.id); expect((await sf()).scene.people).toBe(1);
  });
  it("writes actual public pair fixtures only when explicitly requested by the isolated verification command", async () => {
    const fixtures: Record<string, unknown>[] = [], capture = async (label: string, r?: SnowfieldResult, action?: SnowfieldAction) => {
      const pair = r?.pair ?? await read(); expect(pair.snowman.snowfield).toEqual(pair.snowfield.entry);
      expect([pair.snowman.revision, pair.snowman.points, pair.snowman.taskEarned, pair.snowman.day]).toEqual([pair.snowfield.revision, pair.snowfield.points, pair.snowfield.taskEarned, pair.snowfield.day]);
      fixtures.push({ label, pair, ...(r ? { requestId: r.requestId, replayed: r.replayed, message: r.message, mailedCount: r.mailedCount, ...(r.nativeChristmasAction ? { nativeChristmasAction: r.nativeChristmasAction } : {}) } : {}), ...(action ? { action } : {}) });
    };
    const closed = new ChristmasSnowfieldOwner(f.ctx); fixtures.push({ label: "production-closed", pair: ok(await closed.read(f.input, f.client)) });
    await capture("initial-qualified"); f.client.closed = true; await capture("offline"); f.client.closed = false;
    f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; await capture("bag-locked"); f.p.info.HasBagPassword = false; f.p.info.IsLocked = false;
    const e = await cmd("enter"); await capture("entered-fresh", ok(await owner.command(e, f.client)), e.action); await capture("entered-replay", ok(await owner.command(e, f.client)), e.action);
    await owner.enterScene(f.client, f.p, { x: 1, y: 2 }); await capture("inside"); const again = await cmd("enter"); await capture("return-entered-fresh", ok(await owner.command(again, f.client)), again.action); await owner.enterScene(f.client, f.p, { x: 1, y: 2 });
    const challenge = await cmd("challenge"); await capture("challenged-fresh", ok(await owner.command(challenge, f.client)), challenge.action); await capture("challenged-replay", ok(await owner.command(challenge, f.client)), challenge.action);
    owner.move(f.client, f.p, { x: 499, y: 500 }, "499,500"); advance(10); await capture("walked-away-no-resume"); owner.move(f.client, f.p, { x: 500, y: 500 }, "500,500"); advance(10);
    advance(30001); await capture("unstarted-refund-pending"); const replacement = await cmd("challenge"); await capture("replacement-challenged", ok(await owner.command(replacement, f.client)), replacement.action);
    await tickUntil(owner.handoffChallenge(f.client, f.p, 1)); await capture("controlled-room"); const r = f.p.currentRoom!; expect((await owner.prepareStart(f.client, f.p, r)).ok).toBe(true); await capture("launching"); f.ctx.rooms.startGame(r); f.ctx.rooms.tick(); await capture("actual-fighting");
    launches[0]!.onFinished!(true); launches[0]!.onStopped(); await owner.drain(); f.p.currentRoom?.removePlayer(f.p); await capture("win-settled");
    const npc = await cmd("npc-claim"); await capture("npc-claimed-fresh", ok(await owner.command(npc, f.client)), npc.action); await capture("npc-claimed-replay", ok(await owner.command(npc, f.client)), npc.action);
    advance(1800001); await capture("ticket-expired"); advance(86400000); await capture("utc-next-day");
    const original = (await stored()).states.find(r => r.Activity === "christmas-snowfield")!.State;
    await db.db.update(app.ActivityStates).set({ State: { version: 99, privateSentinel: "retained" } }).where(sql`"Activity"='christmas-snowfield'`); await capture("future-save-unavailable");
    await db.db.update(app.ActivityStates).set({ State: { ...original as object, usedToday: [4, 0, 0] } }).where(sql`"Activity"='christmas-snowfield'`); await capture("corrupt-save-unavailable");
    const path = process.env.SNOWFIELD_PUBLIC_FIXTURES; if (path) writeFileSync(path, JSON.stringify({ isolatedTestFixture: true, realFightAcceptance: false, productionReady: false, fixtures }, null, 2) + "\n");
    expect(fixtures).toHaveLength(23);
  });
});
