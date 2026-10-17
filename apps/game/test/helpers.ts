/**
 * Test harness: PGlite in-memory DB (migrated + template subset seeded), a GameServer on ephemeral ports, and a
 * FakeClient that speaks the real protocol (RSA LOGIN, rolling cipher) over memory, TCP or WebSocket and records
 * every packet the server sends.
 */
import net from "node:net";
import { sql } from "drizzle-orm";
import WebSocket from "ws";
import { createDb, migrateDb, seedDatabase, player, type DbHandle } from "@ddt/db";
import { ClientFrameDecoder, GSPacket, PacketOut, RollingKeyCipher, buildLoginPacket, encodeFrame, generateRsaKey, type RsaPrivateKey } from "@ddt/protocol";
import { testConfig } from "../src/config.js";
import { GameServer } from "../src/server.js";
import type { Transport } from "../src/session/client.js";

const SEED_TABLES = ["Shop_Goods", "Shop", "ShopGoodsShowList", "Game_Map", "Map_Server", "Quest", "Quest_Condiction", "Quest_Goods", "LevelInfo", "Server_List"];

let shared: Promise<DbHandle> | null = null;
export function sharedDb(): Promise<DbHandle> {
  shared ??= (async () => {
    const h = await createDb("pglite:memory");
    await migrateDb(h);
    await seedDatabase(h, { only: SEED_TABLES });
    return h;
  })();
  return shared;
}

let rsa: RsaPrivateKey | null = null;
export function testKey(): RsaPrivateKey {
  return (rsa ??= generateRsaKey(1024));
}

let charSeq = 0;
/** Creates an account character + a login ticket (app."LoginSessions" GameKey) + a main weapon in EquipBag slot 6. */
export async function createCharacter(h: DbHandle, o: { gold?: number; money?: number; weapon?: number | null; grade?: number } = {}) {
  const n = ++charSeq;
  const user = `tester${n}_${Date.now() % 100000}`;
  const nick = `Nick${n}_${Date.now() % 100000}`;
  const [row] = await h.db
    .insert(player.Sys_Users_Detail)
    // timestamp-without-time-zone defaultNow follows PGlite's host zone; Drizzle
    // decodes it as UTC. Start fixtures explicitly unbanned and academy-unfrozen in every test zone.
    .values({ UserName: user, NickName: nick, IsFirst: 1, Sex: true, Grade: o.grade ?? 10, Gold: o.gold ?? 100000, Money: o.money ?? 10000, Password: "x", ForbidDate: new Date("2000-01-01T00:00:00Z"), freezesDate: new Date("2000-01-01T00:00:00Z") })
    .returning({ UserID: player.Sys_Users_Detail.UserID });
  const userId = row!.UserID;
  if (o.weapon !== null) {
    await h.db.insert(player.Sys_Users_Goods).values({ UserID: userId, BagType: 0, TemplateID: o.weapon ?? 7001, Place: 6, Count: 1, IsBinds: true, ValidDate: 0 });
  }
  const pass = `pw${n}abc`;
  const exp = new Date(Date.now() + 3600_000);
  await h.db.execute(sql`INSERT INTO "app"."LoginSessions" ("UserName","WebKey","GameKey","ExpiresAt","GameKeyExpiresAt")
    VALUES (${user.toLowerCase()}, ${"WEB" + n}, ${pass}, ${exp}, ${exp})`);
  return { userId, user, nick, pass };
}

export async function startServer(over: Record<string, string> = {}): Promise<GameServer> {
  const db = await sharedDb();
  const cfg = testConfig({ GAME_PORT: "0", WS_PORT: "0", POLICY_PORT: "0", ADMIN_PORT: "0", BIND_HOST: "127.0.0.1", LOG_LEVEL: process.env.TEST_LOG ?? "silent", PACKET_RATE_BURST: "1000", PACKET_RATE_PER_SEC: "1000", ...over } as never);
  return new GameServer(cfg, { db, rsaKey: testKey() }).start();
}

export interface Received {
  code: number;
  clientId: number;
  p1: number;
  p2: number;
  /** Parsed packet positioned at the body. */
  pkt: GSPacket;
  /** First body byte (sub-command for 94/91/160...). */
  sub: number;
}

type Link = { write(b: Uint8Array): void; close(): void };

export class FakeClient {
  readonly cipher = new RollingKeyCipher(true);
  readonly received: Received[] = [];
  closed = false;
  private link!: Link;
  private waiters: (() => void)[] = [];
  private readonly decoder = new ClientFrameDecoder({
    cipher: this.cipher,
    onPacket: (pkt) => {
      const sub = pkt.length > 20 ? pkt.buffer[20]! : -1;
      this.received.push({ code: pkt.code, clientId: pkt.clientId, p1: pkt.parameter1, p2: pkt.parameter2, pkt, sub });
      this.notify();
    },
  });

  static memory(server: GameServer): FakeClient {
    const c = new FakeClient();
    const t: Transport = {
      kind: "fake",
      remoteAddress: "memory",
      write: (b) => c.onBytes(b),
      close: () => c.onClose(),
    };
    const gc = server.attach(t);
    c.link = { write: (b) => gc.receive(b), close: () => gc.disconnect("client close") };
    return c;
  }

  static async tcp(port: number): Promise<FakeClient> {
    const c = new FakeClient();
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((res, rej) => sock.once("connect", res).once("error", rej));
    sock.on("data", (d: Buffer) => c.onBytes(d));
    sock.on("close", () => c.onClose());
    c.link = { write: (b) => sock.write(b), close: () => sock.destroy() };
    return c;
  }

  static async ws(url: string, origin?: string): Promise<FakeClient> {
    const c = new FakeClient();
    const ws = new WebSocket(url, origin ? { origin } : undefined);
    await new Promise<void>((res, rej) => ws.once("open", () => res()).once("error", rej));
    ws.on("message", (d) => c.onBytes(Buffer.from(d as Buffer)));
    ws.on("close", () => c.onClose());
    c.link = { write: (b) => ws.send(b), close: () => ws.close() };
    return c;
  }

  private onBytes(b: Uint8Array): void {
    this.decoder.push(b);
  }
  private onClose(): void {
    this.closed = true;
    this.notify();
  }
  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  send(pkt: GSPacket): void {
    this.link.write(encodeFrame(pkt, this.cipher));
  }

  /** GameSocketOut.sendLogin: encrypt with K0, then switch both keys. */
  login(user: string, pass: string, key: RsaPrivateKey = testKey()): void {
    const k = Array.from({ length: 8 }, (_, i) => (i * 37 + 11) & 0xff);
    this.cipher.resetKey();
    this.send(buildLoginPacket({ publicKey: key, user, password: pass, key: k, version: 5498628 }));
    this.cipher.setKey(k);
  }

  /** Sends a packet built by `fill`. */
  out(code: number, fill: (p: PacketOut) => void = () => {}): void {
    const p = new PacketOut(code);
    fill(p);
    this.send(p);
  }

  /** Waits for the first packet (after index `from`) matching pred. */
  async waitFor(pred: (r: Received) => boolean, timeoutMs = 4000, from = 0): Promise<Received> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.received.slice(from).find(pred);
      if (hit) {
        hit.pkt.offset = 20;
        return hit;
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for packet; got codes ${this.received.map((r) => `${r.code}/${r.sub}`).join(",")}`);
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, 50);
      });
    }
  }

  code(code: number, sub?: number, from = 0): Promise<Received> {
    return this.waitFor((r) => r.code === code && (sub === undefined || r.sub === sub), 4000, from);
  }

  async waitClosed(timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("not closed");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  mark(): number {
    return this.received.length;
  }

  close(): void {
    this.link.close();
  }
}

/** Logs in and waits for the end of the login burst (95 NECKLACE_STRENGTH is the last packet). */
export async function loggedIn(server: GameServer, o: Parameters<typeof createCharacter>[1] = {}) {
  const db = await sharedDb();
  const ch = await createCharacter(db, o);
  const c = FakeClient.memory(server);
  c.login(ch.user, ch.pass);
  await c.code(95);
  return { c, ch, player: () => server.ctx.world.get(ch.userId)! };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
