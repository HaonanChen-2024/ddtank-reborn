import { describe, expect, it, vi } from "vitest";
import { GSPacket, RollingKeyCipher, encodeFrame } from "@ddt/protocol";
import { testConfig } from "../src/config.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const handlers = new HandlerRegistry();
  const close = vi.fn(), error = vi.fn(), debug = vi.fn();
  const ctx = { cfg: testConfig({ LOGIN_TIMEOUT_SEC: "0", PACKET_RATE_BURST: "100" } as never), log: { error, debug } } as unknown as ServerContext;
  const client = new GameClient({ kind: "fake", remoteAddress: "combat-queue-test", write: () => {}, close }, ctx, handlers);
  const cipher = new RollingKeyCipher(true);
  const send = (code: number) => client.receive(encodeFrame(new GSPacket(code), cipher));
  const handler = (code: number, work: () => void | Promise<void>) => handlers.register({ code, name: `queue-test-${code}`, status: "implemented", preLogin: true, handle: work });
  return { client, send, handler, error, close };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("GameClient combat settlement checkpoints", () => {
  it("drains a handler's candidate before an already queued packet can wait on its fight gate", async () => {
    const f = fixture(), entered = deferred(), resume = deferred(), awardEntered = deferred(), awardDone = deferred();
    const trace: string[] = [];
    let award!: Promise<number>;
    f.handler(50, async () => {
      trace.push("handler:start"); entered.resolve(); await resume.promise;
      award = f.client.enqueueCombatSettlement(async () => {
        trace.push("award:start"); awardEntered.resolve(); await awardDone.promise; trace.push("award:end"); return 17;
      });
      trace.push("handler:end");
    });
    f.handler(51, async () => { await award; trace.push("next:gate-released"); });
    f.send(50); f.send(51);
    await entered.promise; resume.resolve(); await awardEntered.promise;
    expect(trace).toEqual(["handler:start", "handler:end", "award:start"]);
    awardDone.resolve(); await f.client.idle();
    expect(await award).toBe(17);
    expect(trace).toEqual(["handler:start", "handler:end", "award:start", "award:end", "next:gate-released"]);
  });

  it("schedules an external timer candidate without waiting for another inbound packet", async () => {
    const f = fixture(), fired = deferred<number>();
    setTimeout(() => { void f.client.enqueueCombatSettlement(async () => 42).then(fired.resolve, fired.reject); }, 0);
    expect(await fired.promise).toBe(42);
    await f.client.idle();
    expect(f.error).not.toHaveBeenCalled();
  });

  it("keeps priority work FIFO, including candidates accepted while a settlement is running", async () => {
    const f = fixture(), started = deferred(), release = deferred(), trace: string[] = [];
    const first = f.client.enqueueCombatSettlement(async () => { trace.push("first:start"); started.resolve(); await release.promise; trace.push("first:end"); });
    await started.promise;
    const second = f.client.enqueueCombatSettlement(async () => { trace.push("second"); });
    const third = f.client.enqueueCombatSettlement(async () => { trace.push("third"); });
    f.handler(50, () => { trace.push("packet"); }); f.send(50);
    await flush(); expect(trace).toEqual(["first:start"]);
    release.resolve(); await Promise.all([first, second, third, f.client.idle()]);
    expect(trace).toEqual(["first:start", "first:end", "second", "third", "packet"]);
  });

  it("idle follows new checkpoints registered by work already running", async () => {
    const f = fixture(), entered = deferred(), resume = deferred(), settled = deferred();
    f.handler(50, async () => { entered.resolve(); await resume.promise; void f.client.enqueueCombatSettlement(() => settled.promise); });
    f.send(50); await entered.promise;
    let quiet = false; const idle = f.client.idle().then(() => { quiet = true; });
    resume.resolve(); await flush(); expect(quiet).toBe(false);
    settled.resolve(); await idle; expect(quiet).toBe(true);
  });

  it("finishes accepted settlement after disconnect while dropping queued inbound packets", async () => {
    const f = fixture(), entered = deferred(), resume = deferred(), release = deferred(), trace: string[] = [];
    let award!: Promise<void>;
    f.handler(50, async () => {
      entered.resolve(); await resume.promise;
      award = f.client.enqueueCombatSettlement(async () => { trace.push("award:start"); await release.promise; trace.push("award:end"); });
    });
    f.handler(51, () => { trace.push("queued-packet"); });
    f.send(50); f.send(51); await entered.promise; resume.resolve(); await flush();
    f.client.disconnect("test disconnect");
    let quiet = false; const idle = f.client.idle().then(() => { quiet = true; });
    await flush(); expect(quiet).toBe(false); expect(f.close).toHaveBeenCalledOnce();
    release.resolve(); await Promise.all([idle, award]);
    expect(trace).toEqual(["award:start", "award:end"]);
  });

  it("isolates rejected and synchronously thrown settlements without poisoning later work", async () => {
    const f = fixture(), trace: string[] = [], failure = new Error("settlement failed");
    const failed = f.client.enqueueCombatSettlement(async () => { trace.push("reject"); throw failure; });
    const thrown = f.client.enqueueCombatSettlement(() => { trace.push("throw"); throw failure; });
    const succeeded = f.client.enqueueCombatSettlement(async () => { trace.push("success"); return 8; });
    f.handler(50, () => { trace.push("packet"); }); f.send(50);
    await expect(failed).rejects.toBe(failure); await expect(thrown).rejects.toBe(failure);
    expect(await succeeded).toBe(8); await f.client.idle();
    expect(trace).toEqual(["reject", "throw", "success", "packet"]);
    expect(f.error).not.toHaveBeenCalled();
  });

  it("settles before world-boss and activity commands already behind the originating handler", async () => {
    const f = fixture(), entered = deferred(), resume = deferred(), trace: string[] = [];
    let award!: Promise<void>;
    f.handler(50, async () => {
      entered.resolve(); await resume.promise;
      award = f.client.enqueueCombatSettlement(async () => { trace.push("combat"); });
    });
    f.handler(51, () => { trace.push("packet"); });
    f.send(50); await entered.promise;
    const boss = f.client.enqueueWorldBossAward(async () => { await award; trace.push("boss"); });
    const exchange = f.client.enqueueActivityExchange(async () => { await award; trace.push("exchange"); });
    const christmas = f.client.enqueueActivityChristmas(async () => { await award; trace.push("christmas"); });
    f.send(51); resume.resolve();
    await Promise.all([boss, exchange, christmas, f.client.idle()]);
    expect(trace).toEqual(["combat", "boss", "exchange", "christmas", "packet"]);
  });

  it.each(["enqueueWorldBossAward", "enqueueActivityExchange", "enqueueActivityChristmas"] as const)("drains candidates accepted inside %s before its next ordinary work", async method => {
    const f = fixture(), entered = deferred(), resume = deferred(), trace: string[] = [];
    let award!: Promise<void>;
    const origin = f.client[method](async () => {
      trace.push("origin:start"); entered.resolve(); await resume.promise;
      award = f.client.enqueueCombatSettlement(async () => { trace.push("combat"); });
      trace.push("origin:end");
    });
    await entered.promise;
    const next = f.client.enqueueActivityExchange(async () => { await award; trace.push("next"); });
    resume.resolve(); await Promise.all([origin, next, f.client.idle()]);
    expect(trace).toEqual(["origin:start", "origin:end", "combat", "next"]);
  });

  it.each(["enqueueWorldBossAward", "enqueueActivityExchange", "enqueueActivityChristmas"] as const)("preserves the existing first-microtask start of %s when no combat is pending", async method => {
    const f = fixture(); let entered = false;
    const work = f.client[method](async () => { entered = true; });
    await Promise.resolve(); expect(entered).toBe(true);
    await work; await f.client.idle();
  });

  it("retains packet error logging and continues through a failed ordinary command", async () => {
    const f = fixture(), failure = new Error("packet failed"), trace: string[] = [];
    f.handler(50, () => { throw failure; }); f.handler(51, () => { trace.push("packet"); });
    f.send(50);
    const ordinary = f.client.enqueueActivityExchange(async () => { throw failure; });
    f.send(51);
    await expect(ordinary).rejects.toBe(failure); await f.client.idle();
    expect(f.error).toHaveBeenCalledWith(expect.stringContaining("handler 50 (queue-test-50) failed"), failure);
    expect(trace).toEqual(["packet"]);
  });
});
