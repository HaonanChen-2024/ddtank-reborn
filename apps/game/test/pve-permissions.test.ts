import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, game, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { loadPvePermission } from "../src/game/pve-permissions.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { loginSuccess } from "../src/packets/out.js";
import { testConfig } from "../src/config.js";
import { GameServer } from "../src/server.js";
import { quitPlayer } from "../src/session/login.js";
import { createCharacter, FakeClient, testKey } from "./helpers.js";

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
});
