/** Real PvE physics + original room packets + isolated PGlite ledger. This is not AVM2/client acceptance. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { app, createDb, migrateDb, player, type DbHandle } from "@ddt/db";
import { GameState, PveGame, solveAim } from "@ddt/fight";
import { loadPackedAssets } from "@ddt/fight/node";
import { GSPacket } from "@ddt/protocol";
import { data, pves } from "../../../packages/fight/test/pve-data.js";
import { ChristmasLocalGame } from "../../../packages/fight/src/pve/scripts/manual/christmas.js";
import { ChristmasSnowfieldOwner, type SnowfieldAction, type SnowfieldReply } from "../src/game/activity-christmas-snowfield.js";
import * as ChristmasPve from "../src/game/christmas-pve.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import type { FightGame } from "../src/fight/types.js";
import { RoomMgr } from "../src/rooms/room-mgr.js";
import { roomRouter } from "../src/handlers/rooms.js";
import { christmasFixture, seedChristmasTemplates } from "./native-christmas-fixture.js";

const assets = loadPackedAssets(), initial = new Date("2026-10-15T02:00:00.000Z");
let db: DbHandle, f: Awaited<ReturnType<typeof christmasFixture>>, owner: ChristmasSnowfieldOwner, engine: DdtFightEngine;
let now: number;
const ok = <T>(r: SnowfieldReply<T>): T => { expect(r.ok, JSON.stringify(r)).toBe(true); if (!r.ok) throw new Error(r.message); return r.value; };
const read = async () => ok(await owner.read(f.input, f.client)).snowfield;
const stored = async () => ({ wallet: await db.db.select().from(app.ActivityWallet), states: await db.db.select().from(app.ActivityStates), receipts: await db.db.select().from(app.ActivityActions), goods: await db.db.select().from(player.Sys_Users_Goods), mail: await db.db.select().from(player.User_Messages) });
async function action(type: "enter" | "challenge" | "npc-claim") {
  const choice = (await read()).stateToken!;
  const action: SnowfieldAction = type === "challenge" ? { type, index: 0, choice } : { type, choice };
  return ok(await owner.command({ ...f.input, requestId: randomUUID(), action }, f.client));
}
function scenePacket(sub: number, fill: (p: GSPacket) => void) { const p = new GSPacket(145); p.writeByte(sub); fill(p); return owner.handle(f.p, f.client, GSPacket.parse(p.encode())); }
function roomPacket(sub: number) { const p = new GSPacket(94); p.writeInt(sub); return roomRouter().handler(f.ctx, f.p, GSPacket.parse(p.encode()), f.client); }
async function queued<T>(work: Promise<T>) {
  let done = false; void work.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 100 && !done; i++) { await new Promise<void>(r => setImmediate(r)); f.ctx.rooms.tick(); }
  expect(done).toBe(true); return work;
}
async function launch() {
  await action("enter"); await scenePacket(17, p => { p.writeByte(2); p.writeInt(500); p.writeInt(500); });
  await scenePacket(21, p => { p.writeInt(501); p.writeInt(500); p.writeString("501,500"); }); f.setNow(new Date(initial.getTime() + 100));
  await action("challenge"); await queued(scenePacket(22, p => p.writeInt(1)));
  const room = f.p.currentRoom!; expect(room.RoomType).toBe(40);
  await roomPacket(7); f.ctx.rooms.tick();
  return { room, fight: room.game, game: room.game ? engine.games.get(room.game.id)!.game as PveGame : null };
}
function gamePacket(fight: FightGame, sub: number, fill: (p: GSPacket) => void = () => {}) {
  const p = new GSPacket(91); p.writeByte(sub); fill(p); return fight.processData(f.p, GSPacket.parse(p.encode()));
}
function scenePosition(p: GSPacket) {
  expect(p.readInt()).toBe(1); for (let i = 0; i < 4; i++) p.readInt(); p.readString(); p.readByte(); p.readInt(); p.readBoolean();
  for (let i = 0; i < 3; i++) p.readString(); for (let i = 0; i < 4; i++) p.readInt();
  const point = { x: p.readInt(), y: p.readInt() }; p.readByte(); expect(p.dataLeft).toBe(0); return point;
}
function drive(fight: FightGame, game: PveGame, shoot: boolean, stopAtPlaying = false, stopAtResult = false) {
  const turns = new Set<number>();
  for (let i = 0; i < 50000 && engine.games.has(fight.id); i++) {
    engine.tick(now += 40);
    if (game.state === GameState.Loading) gamePacket(fight, 16, p => p.writeInt(100));
    if (stopAtPlaying && game.state === GameState.Playing) return;
    if (stopAtResult && game.state === GameState.ALLSessionStopped) return;
    const me = game.players[0], npc = game.livings.find(n => n.isLiving);
    if (me.isAttacking && !turns.has(game.turnIndex)) {
      turns.add(game.turnIndex);
      const aim = shoot && npc ? solveAim({ map: game.map, ball: me.currentBall, from: me, target: { x: npc.x, y: npc.y - 40 }, bodies: [{ id: npc.id, x: npc.x, y: npc.y, team: npc.team, bound: npc.bound }] }) : null;
      if (aim) {
        gamePacket(fight, 96, p => { p.writeBoolean(true); p.writeByte(2); });
        gamePacket(fight, 2, p => { p.writeInt(aim.muzzle.x); p.writeInt(aim.muzzle.y); p.writeInt(aim.force); p.writeInt(aim.angle); });
      } else gamePacket(fight, 12, p => p.writeByte(1));
    }
  }
  expect(engine.games.has(fight.id)).toBe(false);
  expect(game.scriptErrors).toEqual([]);
}
beforeAll(async () => { db = await createDb("pglite:memory"); await migrateDb(db); await seedChristmasTemplates(db); });
beforeEach(async () => {
  await db.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS snowfield_engine_tail_failure`);
  await db.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  f = await christmasFixture(db, 943, initial); now = Date.now();
  Object.assign(f.p.info, { Grade: 8, Attack: 500, Defence: 150, Agility: 200, Luck: 100, hp: 3000 });
  f.p.baseAttack = 2000; f.p.baseDefence = 100;
  vi.spyOn(f.p, "hasMainWeapon", "get").mockReturnValue(true);
  // Match the existing server-physics fixture; production readiness remains false and is asserted below.
  vi.spyOn(ChristmasPve, "assertChristmasPveReady").mockImplementation(ChristmasPve.assertChristmasPveTerrainReady);
  engine = new DdtFightEngine({ assets, manualClock: true, seed: () => 13, pve: { data, pveInfo: id => pves.get(id), drop: () => [] } });
  owner = new ChristmasSnowfieldOwner(f.ctx, { isolatedTestFixture: true, ready: true });
  f.ctx.rooms = new RoomMgr({ maxRooms: 3, fight: engine, lang: s => s, christmasSnowfield: owner });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS snowfield_engine_tail_failure`);
  for (const g of [...engine.games.values()]) g.stop();
  await owner.beforeQuit(f.p); await owner.drain();
});
afterAll(async () => { await db.close(); });

describe("snowfield actual engine, room and durable outcome", () => {
  it.each([true, false])("real projectile/turn-limit result settles once without cutting the original result UI (shoot=%s)", async shoot => {
    const { room, fight, game } = await launch(); expect(fight).not.toBeNull(); expect(game).not.toBeNull();
    const finish = vi.spyOn(owner, "fightFinished"), stopped = vi.spyOn(owner, "fightStopped"), packets = vi.spyOn(f.p, "send");
    drive(fight!, game!, shoot); await owner.drain(); f.ctx.rooms.tick();
    expect(finish).toHaveBeenCalledTimes(1); expect(finish.mock.calls[0]!.slice(1)).toEqual([fight!.id, shoot]);
    expect(stopped).toHaveBeenCalledTimes(1); expect(stopped.mock.calls[0]![1]).toBe(fight!.id);
    expect(room.game).toBeNull(); expect(room.IsPlaying).toBe(false); expect(f.p.currentRoom).toBe(room);
    expect(packets.mock.calls.map(([p]) => GSPacket.parse(p.encode())).some(p => p.code === 94 && p.readByte() === 5)).toBe(false);
    expect((await read()).scene.people).toBe(1);
    const state = await stored(); expect(state.mail).toHaveLength(shoot ? 1 : 0);
    expect(state.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ usedToday: [1, 0, 0], active: null, hasSettledWinToday: shoot, terminals: [{ outcome: shoot ? "win" : "loss", fightId: fight!.id, rewardMailed: shoot }] });
    expect(shoot ? game!.TotalKillCount : game!.TurnIndex).toBe(shoot ? 1 : 30);
    expect(ChristmasPve.CHRISTMAS_PVE_CLIENT_READINESS.ready).toBe(false);
    await roomPacket(5); expect(f.p.currentRoom).toBe(room); f.ctx.rooms.tick();
    expect(f.p.currentRoom).toBeNull(); expect((await read()).scene.people).toBe(1);
    expect(packets.mock.calls.map(([p]) => GSPacket.parse(p.encode())).some(p => p.code === 145 && p.readByte() === 19)).toBe(false);
    expect(await stored()).toEqual(state);
    const reentry = await action("enter"); expect(reentry.pair.snowfield.scene.canResume).toBe(true);
    await scenePacket(17, p => { p.writeByte(2); p.writeInt(500); p.writeInt(500); });
    const players = packets.mock.calls.map(([p]) => GSPacket.parse(p.encode())).filter(p => p.code === 145 && p.readByte() === 18).at(-1)!;
    expect(scenePosition(players)).toEqual({ x: 501, y: 500 }); expect((await read()).scene).toMatchObject({ state: "inside", people: 1 });
    if (shoot) {
      const request = { ...f.input, requestId: randomUUID(), action: { type: "npc-claim" as const, choice: (await read()).stateToken! } };
      expect(ok(await owner.command(request, f.client)).mailedCount).toBe(1);
      const claimed = await stored(); expect(claimed.mail).toHaveLength(2);
      expect(ok(await owner.command(request, f.client)).replayed).toBe(true); expect(await stored()).toEqual(claimed);
    } else expect((await read()).npc.canClaim).toBe(false);
  });
  it("an explicit original94/5 during the real fight aborts once and leaves the snowfield", async () => {
    const { fight, game } = await launch(); drive(fight!, game!, false, true);
    const finished = vi.spyOn(owner, "fightFinished"); await roomPacket(5); f.ctx.rooms.tick(); await owner.drain();
    expect(engine.games.size).toBe(0); expect(finished).not.toHaveBeenCalled(); expect(f.p.currentRoom).toBeNull();
    expect((await read()).scene.people).toBe(0);
    const state = await stored(); expect(state.mail).toEqual([]);
    expect(state.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ usedToday: [1, 0, 0], active: null, terminals: [{ outcome: "aborted", fightId: fight!.id, quotaReturned: false }] });
    await roomPacket(5); f.ctx.rooms.tick(); expect(await stored()).toEqual(state);
  });
  it.each([true, false])("original119 then early94 waits for real stop before returning with its member and position (shoot=%s)", async shoot => {
    const { room, fight, game } = await launch();
    const finish = vi.spyOn(owner, "fightFinished"), stopped = vi.spyOn(owner, "fightStopped"), packets = vi.spyOn(f.p, "send");
    drive(fight!, game!, shoot, false, true); expect(game!.state).toBe(GameState.ALLSessionStopped); expect(finish).not.toHaveBeenCalled();
    await gamePacket(fight!, 119, p => { p.writeInt(0); p.writeBoolean(true); p.writeBoolean(true); });
    expect(finish).toHaveBeenCalledTimes(1); expect(finish.mock.calls[0]!.slice(1)).toEqual([fight!.id, shoot]); expect(stopped).not.toHaveBeenCalled();
    await roomPacket(5); await roomPacket(5); await owner.drain(); f.ctx.rooms.tick();
    expect(f.p.currentRoom).toBe(room); expect(room.game).toBe(fight); expect(room.IsPlaying).toBe(true);
    expect(packets.mock.calls.map(([p]) => GSPacket.parse(p.encode())).some(p => p.code === 94 && p.readByte() === 5)).toBe(false);
    engine.tick(now += 40); await owner.drain(); f.ctx.rooms.tick();
    expect(stopped).toHaveBeenCalledTimes(1); expect(engine.games.size).toBe(0); expect(f.p.currentRoom).toBeNull();
    expect((await read()).scene).toMatchObject({ state: "inside", people: 1, canResume: false }); expect((await read()).attempt.state).toBe("none");
    const state = await stored(); expect(state.mail).toHaveLength(shoot ? 1 : 0);
    expect(state.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ active: null, usedToday: [1, 0, 0], terminals: [{ outcome: shoot ? "win" : "loss", fightId: fight!.id }] });
    const decoded = packets.mock.calls.map(([p]) => GSPacket.parse(p.encode()));
    expect(decoded.filter(p => p.code === 94 && p.readByte() === 5)).toHaveLength(1); expect(decoded.some(p => p.code === 145 && p.readByte() === 19)).toBe(false);
    const entry = await action("enter"); expect(entry.pair.snowfield.scene.canResume).toBe(true);
    await scenePacket(17, p => { p.writeByte(2); p.writeInt(500); p.writeInt(500); });
    const players = packets.mock.calls.map(([p]) => GSPacket.parse(p.encode())).filter(p => p.code === 145 && p.readByte() === 18).at(-1)!;
    expect(scenePosition(players)).toEqual({ x: 501, y: 500 }); expect(await stored()).not.toEqual(state); // Explicit enter has its own receipt, never a quota charge.
    expect((await stored()).mail).toHaveLength(shoot ? 1 : 0);
    if (shoot) { expect((await action("npc-claim")).mailedCount).toBe(1); expect((await stored()).mail).toHaveLength(2); }
  });
  it("a real first-tick technical refusal refunds once and never creates a winning outcome", async () => {
    vi.spyOn(ChristmasLocalGame.prototype, "OnPrepated").mockImplementation(() => { throw new Error("isolated real first tick refusal"); });
    const { room, fight } = await launch(); expect(fight).toBeNull(); await owner.drain();
    expect(engine.games.size).toBe(0); expect(f.p.currentRoom).toBe(room);
    const state = await stored(); expect(state.mail).toEqual([]);
    expect(state.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ usedToday: [0, 0, 0], active: null, terminals: [{ outcome: "aborted", fightId: null, quotaReturned: true }] });
    await roomPacket(5); f.ctx.rooms.tick(); expect(f.p.currentRoom).toBeNull(); expect(await stored()).toEqual(state);
  });
  it("a failed real winning settlement preserves room/member and retries on explicit94/5 without duplicating mail", async () => {
    const { room, fight, game } = await launch(), before = await stored();
    await db.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT snowfield_engine_tail_failure CHECK ("Signature"='never') NOT VALID`);
    drive(fight!, game!, true, false, true);
    await gamePacket(fight!, 119, p => { p.writeInt(0); p.writeBoolean(true); p.writeBoolean(true); }); await roomPacket(5);
    expect(f.p.currentRoom).toBe(room); engine.tick(now += 40); await expect(owner.drain()).rejects.toThrow(); f.ctx.rooms.tick();
    expect(f.p.currentRoom).toBe(room); expect(room.game).toBeNull(); expect((await read()).scene.people).toBe(1); expect(await stored()).toEqual(before);
    await expect(roomPacket(5)).rejects.toThrow(); f.ctx.rooms.tick(); expect(f.p.currentRoom).toBe(room); expect((await read()).scene.people).toBe(1); expect(await stored()).toEqual(before);
    await db.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT snowfield_engine_tail_failure`);
    await roomPacket(5); f.ctx.rooms.tick(); await owner.drain();
    const final = await stored(); expect(final.mail).toHaveLength(1); expect(f.p.currentRoom).toBeNull(); expect((await read()).scene.people).toBe(1);
    expect(final.states.find(r => r.Activity === "christmas-snowfield")!.State).toMatchObject({ active: null, hasSettledWinToday: true, terminals: [{ outcome: "win", fightId: fight!.id, rewardMailed: true }] });
    await roomPacket(5); f.ctx.rooms.tick(); expect(await stored()).toEqual(final);
    await scenePacket(17, p => p.writeByte(1)); f.ctx.rooms.tick(); expect((await read()).scene.people).toBe(0); expect(await stored()).toEqual(final);
  });
});
