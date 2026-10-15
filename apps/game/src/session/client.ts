/**
 * GameClient (Game.Server/GameClient.cs): one per connection (TCP or WebSocket). Owns the frame decoder + rolling
 * cipher, serialises handler execution per client (C#: one receive callback per socket), applies the packet-rate
 * limit, and quits the player on disconnect.
 */
import { GSPacket, RollingKeyCipher, ServerFrameDecoder, encodeFrame, parseLoginPacket, POLICY_RESPONSE, type LoginPacket } from "@ddt/protocol";
import type { GamePlayer, PacketSink } from "../game/player.js";
import type { HandlerRegistry } from "../handlers/registry.js";
import type { ServerContext } from "./context.js";

export interface Transport {
  readonly kind: "tcp" | "ws" | "fake";
  readonly remoteAddress: string;
  write(bytes: Uint8Array): void;
  close(): void;
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rate: number, private readonly burst: number) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

let clientSeq = 0;

export class GameClient implements PacketSink {
  readonly id = ++clientSeq;
  readonly cipher = new RollingKeyCipher(true);
  readonly decoder: ServerFrameDecoder;
  player: GamePlayer | null = null;
  loginStarted = false;
  closed = false;
  /** Raw LOGIN parse result, handed to the login handler. */
  pendingLogin: LoginPacket | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly combatSettlements: (() => Promise<void>)[] = [];
  private readonly bucket: TokenBucket;
  private readonly loginTimer: NodeJS.Timeout | null;
  onClosed?: (c: GameClient) => void;

  constructor(readonly transport: Transport, private readonly ctx: ServerContext, private readonly handlers: HandlerRegistry) {
    this.bucket = new TokenBucket(ctx.cfg.PACKET_RATE_PER_SEC, ctx.cfg.PACKET_RATE_BURST);
    this.decoder = new ServerFrameDecoder({
      cipher: this.cipher,
      // In-band policy answer (GameClient.cs:141) on TCP; Ruffle over WS never asks.
      policy: transport.kind !== "ws",
      onPolicyRequest: () => this.transport.write(POLICY_RESPONSE),
      onPacket: (pkt) => this.onPacket(pkt),
      onDisconnect: (reason) => this.disconnect(`framing: ${reason}`),
      onHandlerError: (err) => ctx.log.error(`client ${this.id} packet error`, err),
    });
    const t = ctx.cfg.LOGIN_TIMEOUT_SEC;
    this.loginTimer = t > 0 ? setTimeout(() => !this.player && this.disconnect("login timeout"), t * 1000) : null;
    this.loginTimer?.unref?.();
  }

  get remoteAddress(): string {
    return this.transport.remoteAddress;
  }

  /** Raw bytes from the transport (any split). */
  receive(chunk: Uint8Array): void {
    if (!this.closed) this.decoder.push(chunk);
  }

  private onPacket(pkt: GSPacket): void {
    if (this.closed) return;
    if (!this.bucket.take()) {
      this.disconnect("packet rate exceeded");
      return;
    }
    const code = pkt.code;
    if (code < 0 || code >= 512) return; // PacketProcessor drops codes >= 512
    if (code === 1) {
      if (this.player || this.loginStarted) return;
      // RSA + setKey must happen synchronously: the next frame in this read already uses the new key.
      let login: LoginPacket;
      try {
        login = parseLoginPacket(pkt, this.ctx.rsaKey);
      } catch {
        this.send(kitoffPacket(this.ctx.lang.t("UserLoginHandler.RsaCryptorError")));
        this.disconnect("rsa error");
        return;
      }
      if (login.payload === null) return; // clientType 69 is ignored
      this.cipher.setKey(login.payload.key);
      this.loginStarted = true;
      this.pendingLogin = login;
    } else if (!this.player) {
      const def = this.handlers.get(code);
      if (!def?.preLogin) return;
    }
    if (this.player) pkt.clientId = this.player.id; // GameClient.OnRecvPacket overwrites ClientID
    const def = this.handlers.get(code);
    if (!def) return;
    this.enqueueSerialized(async () => {
      if (this.closed && code !== 1) return;
      try {
        await def.handle(this.ctx, this, pkt);
      } catch (err) {
        this.ctx.log.error(`handler ${code} (${def.name}) failed for client ${this.id}`, err);
      }
    });
  }

  /** Waits for queued packets and any settlements they accepted to finish. */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      await chain;
      if (chain === this.chain && this.combatSettlements.length === 0) return;
    }
  }

  /**
   * Combat callbacks register synchronously, then run at the next packet boundary, ahead of already queued
   * packets that may wait on their fight gate. A running handler/queued work must not await a settlement it
   * just enqueued: it has to return before that settlement can run. Accepted work survives disconnect.
   */
  enqueueCombatSettlement<T>(work: () => Promise<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.combatSettlements.push(async () => {
        try { resolve(await work()); } catch (err) { reject(err); }
      });
    });
    // Observe failures even when the combat owner attaches its handler after this checkpoint starts.
    void result.catch(() => {});
    // Also schedules a drain when no packet is running. Existing work drains this queue before it runs.
    this.enqueueSerialized(async () => {});
    return result;
  }

  private async drainCombatSettlements(): Promise<void> {
    while (this.combatSettlements.length) await this.combatSettlements.shift()!();
  }

  private enqueueSerialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      if (this.combatSettlements.length) await this.drainCombatSettlements();
      try { return await work(); } finally {
        if (this.combatSettlements.length) await this.drainCombatSettlements();
      }
    });
    // Only the caller observes business failure; later work must still run.
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  enqueueWorldBossAward<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueueSerialized(work);
  }

  /** A05 internal commands must share ordering with inventory packets and login. */
  enqueueActivityExchange<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueueSerialized(work);
  }

  /** Christmas commands share the real socket packet chain. */
  enqueueActivityChristmas<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueueSerialized(work);
  }

  send(pkt: GSPacket): void {
    if (this.closed) return;
    this.transport.write(encodeFrame(pkt, this.cipher));
  }

  disconnect(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.ctx.log.debug(`client ${this.id} disconnect: ${reason}`);
    try {
      this.transport.close();
    } catch {
      /* already closed */
    }
    this.onClosed?.(this);
  }
}

function kitoffPacket(msg: string): GSPacket {
  const p = new GSPacket(2);
  p.writeString(msg);
  return p;
}
