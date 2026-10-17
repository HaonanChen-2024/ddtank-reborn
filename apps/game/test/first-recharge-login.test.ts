import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { game, player } from "@ddt/db";
import { eventsRuntime } from "../src/handlers/events.js";
import type { GameServer } from "../src/server.js";
import { quitPlayer } from "../src/session/login.js";
import { FakeClient, createCharacter, sharedDb, startServer } from "./helpers.js";

let server: GameServer;
let db: Awaited<ReturnType<typeof sharedDb>>;
const clients = new Set<FakeClient>();
const infoScope = and(eq(game.Event_Reward_Info.ActivityType, 7), eq(game.Event_Reward_Info.SubActivityType, 1));
const goodsScope = and(eq(game.Event_Reward_Goods.ActivityType, 7), eq(game.Event_Reward_Goods.SubActivityType, 1));

beforeAll(async () => {
  vi.stubEnv("TZ", "UTC");
  db = await sharedDb();
  server = await startServer();
  expect(server.ctx.templates.findItem(11022)).toBeDefined();
  expect(server.ctx.templates.findItem(2147483647)).toBeUndefined();
});

afterAll(async () => {
  for (const client of clients) client.close();
  try {
    await server?.stop();
  } finally {
    await db?.close();
    vi.unstubAllEnvs();
  }
});

describe("first-recharge availability in the real login packet 259", () => {
  it.each([
    ["missing Info", false, 11022, "true", false, false, false, false],
    ["missing Goods", true, null, "true", false, false, false, false],
    ["unknown reward template", true, 2147483647, "true", false, false, false, false],
    ["valid config with default free eligibility", true, 11022, undefined, false, false, true, false],
    ["free disabled and not recharged", true, 11022, "false", false, false, false, false],
    ["free disabled and recharged", true, 11022, "false", true, false, true, false],
    ["already claimed with valid config", true, 11022, "false", true, true, true, true],
    ["already claimed with unavailable config", false, 11022, "true", false, true, false, true],
  ] as const)("%s", async (_name, hasInfo, templateId, free, recharged, claimed, available, received) => {
    vi.stubEnv("FIRST_RECHARGE_FREE", free);
    // These are explicit memory-only fixtures, independent of production seed availability.
    await db.db.delete(game.Event_Reward_Info).where(infoScope);
    await db.db.delete(game.Event_Reward_Goods).where(goodsScope);
    if (hasInfo) {
      // The existing eligibility is the recharge flag, not this original Condition value.
      await db.db.insert(game.Event_Reward_Info).values({ ActivityType: 7, SubActivityType: 1, Condition: 99999 });
    }
    if (templateId !== null) {
      await db.db.insert(game.Event_Reward_Goods).values({ ActivityType: 7, SubActivityType: 1, TemplateId: templateId, Count: 2, IsBind: true, ValidDate: 0 });
    }
    await eventsRuntime(server.ctx).data.load(db.db);
    const ch = await createCharacter(db);
    await db.db.update(player.Sys_Users_Detail).set({ IsRecharged: recharged, IsGetAward: claimed })
      .where(eq(player.Sys_Users_Detail.UserID, ch.userId));
    const client = FakeClient.memory(server);
    clients.add(client);
    try {
      client.login(ch.user, ch.pass);
      await client.code(95); // Complete the real RSA/cipher login burst, including packet 259.
      const packets = client.received.filter(packet => packet.code === 259);
      expect(packets).toHaveLength(1);
      const packet = packets[0]!.pkt;
      packet.clearOffset();
      expect([packet.readBoolean(), packet.readBoolean()]).toEqual([available, received]);
      expect(packet.dataLeft).toBe(0);
      expect(server.ctx.world.get(ch.userId)!.info.IsGetAward).toBe(claimed);
    } finally {
      client.close();
      const loggedIn = server.ctx.world.get(ch.userId);
      if (loggedIn) await quitPlayer(server.ctx, loggedIn);
      clients.delete(client);
    }
  });
});
