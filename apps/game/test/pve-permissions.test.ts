import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, game, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { loadPvePermission, unlockDungeonPvePermission } from "../src/game/pve-permissions.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { GamePlayer, type RoomMember } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { loginSuccess } from "../src/packets/out.js";
import { testConfig } from "../src/config.js";
import { GameServer } from "../src/server.js";
import { quitPlayer } from "../src/session/login.js";
import { createCharacter, FakeClient, testKey } from "./helpers.js";
import { eq } from "drizzle-orm";
import type { GSPacket } from "@ddt/protocol";
import { GameLogic } from "@ddt/protocol/codes";
import { PveGame, type FightEvent } from "@ddt/fight";
import { DdtFightEngine } from "../src/fight/ddt.js";
import { VirtualPlayer } from "../src/bots/bot.js";
import { data, pves } from "../../../packages/fight/test/pve-data.js";

describe("original login PVE permissions", () => {
  const ant = [{ ID: 2, LevelLimits: 8 }];
  it.each([null, ""])("keeps an unqualified original value %s, then opens Easy at Grade > 8", (old) => {
    expect(loadPvePermission(old, 8, ant)).toBe(old);
    expect(loadPvePermission(old, 9, ant)).toBe("1".repeat(50));
  });
  it("keeps the five Easy-first copies separate from initial Normal copies", () => {
    const ids = [1, 2, 7, 12, 13, 8, 14];
    const result = loadPvePermission(null, 9, ids.map((ID) => ({ ID, LevelLimits: 8 })))!;
    expect(ids.map((id) => result[id - 1])).toEqual(["1", "1", "1", "1", "1", "3", "3"]);
    expect(result.replaceAll("3", "1")).toBe("1".repeat(50));
  });
  it("retains advanced, unknown and out-of-range values without padding or broad unlocks", () => {
    const rows = [0, 1, 2, 3, 4, 5, 6, 51, 1000].map((ID) => ({ ID, LevelLimits: 0 }));
    expect(loadPvePermission("37FX0", 9, rows)).toBe("37FX0");
    expect(loadPvePermission("1", 9, ant)).toBe("1");
    expect(loadPvePermission(null, 9, [{ ID: 51, LevelLimits: 0 }])).toBeNull();
    expect(loadPvePermission(null, 9, [{ ID: 2, LevelLimits: null }])).toBeNull();
  });
  it("rechecks current grade without downgrading prior permissions on later logins", () => {
    const rows = [{ ID: 3, LevelLimits: 9 }, { ID: 8, LevelLimits: 8 }];
    const first = loadPvePermission("1".repeat(50), 9, rows)!;
    expect(first[2]).toBe("1"); expect(first[7]).toBe("3");
    const next = loadPvePermission(first, 10, rows)!;
    expect(next[2]).toBe("3"); expect(next[7]).toBe("3");
    expect(loadPvePermission(next, 1, rows)).toBe(next);
    expect(loadPvePermission(next, 10, rows)).toBe(next);
  });
});


describe("completed Dungeon permission rules", () => {
  const ant = { ID: 2, Type: 4 };
  const final = { roomType: 4, isWin: true, hasNextMission: false, hardLevel: 0 };
  it("advances one adjacent tier, preserves other copies and is idempotent", () => {
    expect(unlockDungeonPvePermission("X1F0", ant, final)).toBe("X3F0");
    expect(unlockDungeonPvePermission("X3F0", ant, final)).toBe("X3F0");
    expect(unlockDungeonPvePermission("X3F0", ant, { ...final, hardLevel: 1 })).toBe("X7F0");
    expect(unlockDungeonPvePermission("X7F0", ant, { ...final, hardLevel: 2 })).toBe("XFF0");
    expect(unlockDungeonPvePermission("X1F0", ant, { ...final, hardLevel: 1 })).toBe("X1F0");
  });
  it("retains empty, short, advanced and unknown target permissions exactly", () => {
    for (const value of [null, "", "1", "13", "17", "1F", "1X", "10", "1f"]) expect(unlockDungeonPvePermission(value, ant, final)).toBe(value);
  });
  it("rejects illegal IDs and completed difficulties whose next tier is unavailable", () => {
    for (const ID of [-1, 0, 3, 50, 100000, 1.5, NaN, Infinity]) expect(unlockDungeonPvePermission("11", { ...ant, ID }, final)).toBe("11");
    for (const hardLevel of [-1, 3, 4, 5, 0.5, NaN, Infinity]) expect(unlockDungeonPvePermission("1F", ant, { ...final, hardLevel })).toBe("1F");
  });
  it("keeps defeats, intermediate results and non-Dungeon identities unchanged", () => {
    for (const result of [{ ...final, isWin: false }, { ...final, hasNextMission: true }, ...[0, 5, 10, 11, 14, 21, 23].map((roomType) => ({ ...final, roomType }))]) {
      expect(unlockDungeonPvePermission("11", ant, result)).toBe("11");
    }
    for (const Type of [5, 10, 11, 14, 21, 23]) expect(unlockDungeonPvePermission("11", { ...ant, Type }, final)).toBe("11");
  });
});

/** Decode the actual 67 payload at its original wire position (out.ts:90-95), not an expected packet. */
function publicPermissions(packet: GSPacket) {
  expect(packet.code).toBe(67);
  const offset = packet.offset;
  try {
    packet.offset = 20;
    for (let i = 0; i < 13; i++) packet.readInt();
    packet.readString(); packet.readString(); packet.readString(); // Style, Colors, Skin
    packet.readBoolean(); packet.readInt(); packet.readString(); // IsShowConsortia, ID, name
    for (let i = 0; i < 4; i++) packet.readInt(); // badgeID, reserved, reserved, Nimbus
    return { permission: packet.readString(), fightLab: packet.readString(), fightPower: packet.readInt() };
  } finally { packet.offset = offset; }
}

// Isolated PGlite; the final test starts its own ephemeral loopback server and
// logs in only a freshly created fixture through FakeClient's memory transport.
describe("seeded permission serialization and normal persistence", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createDb("pglite:memory");
    await migrateDb(h);
    await seedDatabase(h, { only: ["Pve_Info"] });
  });
  afterAll(async () => { await h.close(); });
  it("puts the real Grade9 template permissions on the login wire and saves them through GamePlayer", async () => {
    const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: "pve-fixture", NickName: "pve-fixture", Grade: 9, GP: 19634, Gold: 321, IsFirst: 1 }).returning();
    const info = (await loadPlayerInfo(h.db, row!.UserID))!;
    const p = new GamePlayer({ send: () => {}, disconnect: () => {}, remoteAddress: "test" }, info, defaultMatch(info.ID), 1, "test");
    const dungeons = await h.db.select().from(game.Pve_Info);
    expect(info.PvePermission).toBeNull();
    info.PvePermission = loadPvePermission(info.PvePermission, info.Grade, dungeons);
    expect(info.PvePermission!.split("").flatMap((v, i) => v === "3" ? [i + 1] : [])).toEqual([8, 14]);
    expect(info.PvePermission![1]).toBe("1");
    const packet = loginSuccess(p.view(), null);
    const field = Buffer.from(info.PvePermission!, "utf8");
    const marker = Buffer.alloc(3 + field.length); marker.writeUInt16BE(field.length + 1); field.copy(marker, 2);
    expect(Buffer.from(packet.buffer.subarray(20, packet.length)).includes(marker)).toBe(true);
    await p.saveIntoDatabase(h.db);
    const saved = (await loadPlayerInfo(h.db, p.id))!;
    expect(saved).toMatchObject({ PvePermission: info.PvePermission, Grade: 9, GP: 19634, Gold: 321 });
  });
  it("initializes permissions through handleLogin before the real burst, then persists on quit", async () => {
    const server = new GameServer(testConfig({ GAME_PORT: "0", BIND_HOST: "127.0.0.1", WS_ENABLED: "false", POLICY_ENABLED: "false", ADMIN_ENABLED: "false", SERVER_HEARTBEAT: "false", BOT_FALLBACK_SEC: "0", LANGUAGE_FILE: "" }), { db: h, rsaKey: testKey() });
    let c: FakeClient | undefined;
    try {
      await server.start();
      const ch = await createCharacter(h, { grade: 9, weapon: null });
      expect((await loadPlayerInfo(h.db, ch.userId))!.PvePermission).toBeNull();
      c = FakeClient.memory(server); c.login(ch.user, ch.pass);
      await c.code(95); // Actual handleLogin/loadPlayer and the complete login burst.
      const p = server.ctx.world.get(ch.userId)!;
      const expected = Array.from({ length: 50 }, (_, i) => i === 7 || i === 13 ? "3" : "1").join("");
      expect(p.info.PvePermission).toBe(expected);
      const received = c.received.find((packet) => packet.code === 1)!.pkt;
      const marker = Buffer.alloc(53); marker.writeUInt16BE(51); marker.write(expected, 2, "utf8");
      expect(Buffer.from(received.buffer.subarray(20, received.length)).includes(marker)).toBe(true);
      c.close();
      await quitPlayer(server.ctx, p); // Joins the normal, idempotent transport-close save.
      expect(server.ctx.world.get(ch.userId)).toBeUndefined();
      expect((await loadPlayerInfo(h.db, ch.userId))!).toMatchObject({ PvePermission: expected, Grade: 9, State: 0 });
    } finally {
      c?.close();
      await server.stop();
    }
  });
  describe("whole Dungeon completion dispatcher", () => {
    // Reuses this file's PGlite handle and world-boss.test.ts:84's real DdtGame result-boundary fixture.
    // These events exercise the real dispatcher; they do not claim natural combat or mission completion.
    const before = "1137FX" + "1".repeat(44), after = "1337FX" + "1".repeat(44);
    const activeGames: ReturnType<DdtFightEngine["startPve"]>[] = [];
    let seq = 0;
    afterEach(() => { for (const g of activeGames.splice(0)) g?.stop(); vi.restoreAllMocks(); });
    async function actor(permission = before) {
      const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `unlock-${++seq}`, NickName: `Unlock ${seq}`,
        IsFirst: 1, Grade: 9, GP: 19634, Gold: 321, Money: 123, GiftToken: 19, Offer: 17, PvePermission: permission, FightLabPermission: "F7" }).returning();
      const info = (await loadPlayerInfo(h.db, row!.UserID))!, sent: GSPacket[] = [];
      const p = new GamePlayer({ send: (packet) => sent.push(packet), disconnect: () => {}, remoteAddress: "test" }, info, defaultMatch(info.ID), 1, "test");
      return { p, sent };
    }
    function start(members: RoomMember[], options: { roomType?: number; tableType?: number; requestId?: number; hardLevel?: number; onFinished?: (win: boolean) => void } = {}) {
      const roomType = options.roomType ?? 4;
      const resolved = { ...pves.get(2)!, Type: options.tableType ?? 4 };
      const onFinished = vi.fn(options.onFinished ?? (() => {}));
      const engine = new DdtFightEngine({ manualClock: true, seed: () => 7, pve: { data, pveInfo: () => resolved, drop: () => null } });
      const battle = engine.startPve({ roomId: 1, roomType, gameType: roomType === 5 ? 8 : 7, timeType: 3, pveId: options.requestId ?? 2,
        hardLevel: options.hardLevel ?? 0, levelLimits: 0, currentFloor: 0, players: members, onStopped: () => {}, onFinished });
      expect(battle).not.toBeNull(); activeGames.push(battle);
      const adapter = engine.games.get(battle!.id)!;
      expect(adapter.game).toBeInstanceOf(PveGame);
      const update = vi.spyOn(adapter.game, "update");
      let now = Date.now();
      return { battle: battle!, adapter, onFinished, send(event: FightEvent) { update.mockReturnValueOnce([event]); engine.tick(++now); } };
    }
    function stopped(isWin = true, hasNextMission = false): FightEvent {
      return { cmd: "PVE_STOPPED", code: 0, livingId: 0, isWin, hasNextMission };
    }
    function publics(sent: GSPacket[], id: number) { return sent.filter((p) => p.code === 67 && p.clientId === id); }

    it("unlocks only at the final stop, sends 67 before room reset and saves through the original player", async () => {
      const a = await actor();
      const [nativeBefore] = await h.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, a.p.id));
      const finishSeen: string[] = [];
      const f = start([a.p], { onFinished: () => {
        finishSeen.push(a.p.info.PvePermission!);
        expect(publicPermissions(publics(a.sent, a.p.id)[0]!)).toEqual({ permission: after, fightLab: "F7", fightPower: a.p.info.FightPower });
      } });
      a.sent.length = 0;
      const notify = vi.spyOn(a.p, "updateProperties"), save = vi.spyOn(a.p, "saveIntoDatabase");
      f.send(stopped());
      expect(a.p.info.PvePermission).toBe(after); expect(notify).toHaveBeenCalledTimes(1);
      expect(publics(a.sent, a.p.id)).toHaveLength(1); expect(finishSeen).toEqual([after]);
      expect(save).not.toHaveBeenCalled();
      expect((await loadPlayerInfo(h.db, a.p.id))!.PvePermission).toBe(before);
      f.send(stopped());
      expect(notify).toHaveBeenCalledTimes(1); expect(publics(a.sent, a.p.id)).toHaveLength(1);
      await a.p.saveIntoDatabase(h.db);
      expect(save).toHaveBeenCalledTimes(1);
      const [nativeAfter] = await h.db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, a.p.id));
      expect(nativeAfter).toEqual({ ...nativeBefore, PvePermission: after });
      expect((await loadPlayerInfo(h.db, a.p.id))!).toMatchObject({ PvePermission: after, Grade: 9, GP: 19634, Gold: 321, Money: 123, GiftToken: 19, Offer: 17, FightLabPermission: "F7" });
    });
    it.each([[true, true], [false, false], [false, true]])("does not unlock stop win=%s / next=%s", async (win, next) => {
      const a = await actor(), f = start([a.p]); a.sent.length = 0;
      f.send(stopped(win, next));
      expect(a.p.info.PvePermission).toBe(before); expect(publics(a.sent, a.p.id)).toHaveLength(0);
    });
    it.each([[5, 5], [11, 11], [14, 14], [4, 5]])("does not unlock room=%s / resolved type=%s", async (roomType, tableType) => {
      const a = await actor(), f = start([a.p], { roomType, tableType }); a.sent.length = 0;
      f.send(stopped());
      expect(a.p.info.PvePermission).toBe(before); expect(publics(a.sent, a.p.id)).toHaveLength(0);
    });
    it.each([0, 100000])("uses the resolved Dungeon ID for request sentinel %s", async (requestId) => {
      const a = await actor(), f = start([a.p], { requestId });
      f.send(stopped()); expect(a.p.info.PvePermission).toBe(after);
    });
    it("intersects active engine players and remaining members, while retaining dead teammates", async () => {
      const leader = await actor(), timedOut = await actor(), leaver = await actor(), dead = await actor();
      const f = start([leader.p, timedOut.p, leaver.p, dead.p]);
      const living = (p: GamePlayer) => f.adapter.game.players.find((x) => x.spec.userId === p.id)!;
      f.adapter.game.removePlayer(timedOut.p.id); // Engine-only timeout path leaves adapter membership present.
      f.battle.removePlayer(leaver.p); // Public adapter exit also removes membership; other humans remain.
      living(dead.p).die();
      expect(living(timedOut.p).isActive).toBe(false); expect(living(leaver.p).isActive).toBe(false);
      expect(living(dead.p).isLiving).toBe(false); expect(living(dead.p).isActive).toBe(true);
      for (const a of [leader, timedOut, leaver, dead]) a.sent.length = 0;
      f.send(stopped());
      for (const a of [leader, dead]) { expect(a.p.info.PvePermission).toBe(after); expect(publics(a.sent, a.p.id)).toHaveLength(1); }
      for (const a of [timedOut, leaver]) { expect(a.p.info.PvePermission).toBe(before); expect(publics(a.sent, a.p.id)).toHaveLength(0); }
    });
    it("skips a real VirtualPlayer even when its permission is eligible", async () => {
      const a = await actor();
      const bot = new VirtualPlayer({ id: 98765, nickname: "Unlock bot", sex: true, level: 9, weaponTemplateId: 7001 });
      bot.info.PvePermission = before;
      const f = start([a.p, bot]); f.send(stopped());
      expect(a.p.info.PvePermission).toBe(after); expect(bot.info.PvePermission).toBe(before);
    });
    it("neither a per-mission result nor an ordinary adapter stop unlocks", async () => {
      const a = await actor(), f = start([a.p]);
      const living = f.adapter.game.players.find((x) => x.spec.userId === a.p.id)!;
      f.send({ cmd: "GAME_MISSION_OVER", code: GameLogic.eTankCmdType.GAME_MISSION_OVER, livingId: 0, bossCardCount: 1, showLarge: true,
        pic: "show1.jpg", missionId: 2001, isWin: true, resources: [],
        players: [{ userId: a.p.id, livingId: living.id, grade: 9, gainGP: 0, isWin: true, bossCardCount: 1, turnNum: 1 }] });
      expect(a.p.info.PvePermission).toBe(before); expect(f.onFinished).not.toHaveBeenCalled();
      f.battle.stop(); expect(a.p.info.PvePermission).toBe(before);
    });
    it.each(["13", "17", "1F", "1X"])("does not notify when target permission %s is already higher or unknown", async (permission) => {
      const a = await actor(permission), f = start([a.p]); a.sent.length = 0;
      f.send(stopped()); expect(a.p.info.PvePermission).toBe(permission); expect(publics(a.sent, a.p.id)).toHaveLength(0);
    });
    it("persists the dispatcher unlock on normal quit and keeps it through real handleLogin relogin", async () => {
      const server = new GameServer(testConfig({ GAME_PORT: "0", BIND_HOST: "127.0.0.1", WS_ENABLED: "false", POLICY_ENABLED: "false", ADMIN_ENABLED: "false", SERVER_HEARTBEAT: "false", BOT_FALLBACK_SEC: "0", LANGUAGE_FILE: "" }), { db: h, rsaKey: testKey() });
      let first: FakeClient | undefined, second: FakeClient | undefined;
      try {
        await server.start();
        const ch = await createCharacter(h, { grade: 9, weapon: null });
        first = FakeClient.memory(server); first.login(ch.user, ch.pass); await first.code(95);
        const p = server.ctx.world.get(ch.userId)!;
        const old = p.info.PvePermission!, expected = old.slice(0, 1) + "3" + old.slice(2);
        expect(old[1]).toBe("1");
        const f = start([p]); const seen = first.received.length;
        f.send(stopped());
        const packet = first.received.slice(seen).find((x) => x.code === 67 && x.clientId === p.id)!.pkt;
        expect(publicPermissions(packet).permission).toBe(expected);
        f.battle.stop(); first.close(); await quitPlayer(server.ctx, p);
        expect(server.ctx.world.get(ch.userId)).toBeUndefined();
        expect((await loadPlayerInfo(h.db, ch.userId))!.PvePermission).toBe(expected);
        second = FakeClient.memory(server); second.login(ch.user, ch.pass); await second.code(95);
        const reloaded = server.ctx.world.get(ch.userId)!;
        expect(reloaded).not.toBe(p); expect(reloaded.info.PvePermission).toBe(expected);
        const relogSeen = second.received.length;
        reloaded.updateProperties();
        const relogPacket = second.received.slice(relogSeen).find((x) => x.code === 67 && x.clientId === reloaded.id)!.pkt;
        expect(publicPermissions(relogPacket).permission).toBe(expected);
        second.close(); await quitPlayer(server.ctx, reloaded);
      } finally { first?.close(); second?.close(); await server.stop(); }
    });
  });

});
