import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import * as ConsortiaDb from "../src/db/consortia.js";
import { consortiaMgr, stopConsortiaMgr } from "../src/game/consortia-mgr.js";
import type { GameServer } from "../src/server.js";
import { loggedIn, sharedDb, startServer } from "./helpers.js";

let h: Awaited<ReturnType<typeof sharedDb>>;
let server: GameServer | undefined;
beforeAll(async () => { h = await sharedDb(); });
afterEach(async () => { await server?.stop(); server = undefined; vi.restoreAllMocks(); });
afterAll(async () => { await h.close(); });

describe("GameServer shutdown ownership", () => {
  it("does not create a guild manager or close an injected database during shutdown", async () => {
    server = await startServer();
    const load = vi.spyOn(ConsortiaDb, "loadLevels");
    const close = vi.spyOn(h, "close");
    await server.stop();
    expect(load).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await expect(h.db.execute(sql`SELECT 1`)).resolves.toBeDefined();
  });

  it("clears the guild scan interval created by a real login and stops idempotently", async () => {
    server = await startServer();
    const interval = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const f = await loggedIn(server);
    expect(f.c.received.some(packet => packet.code === 95)).toBe(true);
    const calls = interval.mock.calls.flatMap((args, index) => args[1] === 60_000 ? [interval.mock.results[index]!.value as NodeJS.Timeout] : []);
    expect(calls).toHaveLength(1);
    await server.stop();
    expect(clear).toHaveBeenCalledWith(calls[0]);
    const count = clear.mock.calls.filter(args => args[0] === calls[0]).length;
    await server.stop();
    expect(clear.mock.calls.filter(args => args[0] === calls[0])).toHaveLength(count);
    expect(server.clients.size).toBe(0); expect(server.ctx.world.size).toBe(0);
    expect(server.tcp?.listening).toBe(false); expect(server.admin?.listening).toBe(false);
    await expect(h.db.execute(sql`SELECT 1`)).resolves.toBeDefined();
  });

  it("waits for an existing manager still loading before clearing its newly-created timer", async () => {
    server = await startServer();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = ConsortiaDb.loadLevels;
    vi.spyOn(ConsortiaDb, "loadLevels").mockImplementationOnce(async db => { await gate; return original(db); });
    const interval = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const loading = consortiaMgr(server.ctx);
    const stopping = stopConsortiaMgr(server.ctx);
    release();
    await loading; await stopping;
    const calls = interval.mock.calls.flatMap((args, index) => args[1] === 60_000 ? [interval.mock.results[index]!.value as NodeJS.Timeout] : []);
    expect(calls).toHaveLength(1);
    expect(clear).toHaveBeenCalledWith(calls[0]);
    await expect(h.db.execute(sql`SELECT 1`)).resolves.toBeDefined();
  });
});
