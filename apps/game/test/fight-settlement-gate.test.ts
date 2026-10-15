import { describe, expect, it } from "vitest";
import { WorldBossSettlementGate } from "../src/fight/world-boss-settlement.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("fight settlement gate", () => {
  it("pauses the remaining remove/stop queue when a tick acquires another lease", async () => {
    const gate = new WorldBossSettlementGate(), out: string[] = [], first = await gate.acquire();
    let second!: Promise<() => void>;
    gate.tick(1, () => { out.push("tick"); second = gate.acquire(); }, () => {});
    const remove = gate.defer(() => { out.push("remove"); }, "remove:1");
    const stop = gate.defer(() => { out.push("stop"); }, "stop");
    first();
    expect(out).toEqual(["tick"]);
    expect(gate.held).toBe(true);
    (await second)();
    await Promise.all([remove, stop, gate.waitIdle()]);
    expect(out).toEqual(["tick", "remove", "stop"]);
  });

  it("grants an older waiting lease before queued work, then pauses for that work's new lease", async () => {
    const gate = new WorldBossSettlementGate(), first = await gate.acquire(), out: string[] = [];
    let waitingGranted = false, second!: Promise<() => void>;
    const waiting = gate.acquire().then((release) => { waitingGranted = true; return release; });
    gate.tick(1, () => { out.push("tick"); second = gate.acquire(); }, () => {});
    const stop = gate.defer(() => { out.push("stop"); });
    first();
    await Promise.resolve();
    expect(waitingGranted).toBe(true);
    expect(out).toEqual([]);
    const releaseWaiting = await waiting;
    expect(gate.held).toBe(true);
    releaseWaiting(); releaseWaiting();
    expect(out).toEqual(["tick"]);
    expect(gate.held).toBe(true);
    (await second)();
    await Promise.all([stop, gate.waitIdle()]);
    expect(out).toEqual(["tick", "stop"]);
    expect(gate.held).toBe(false);
  });

  it("transfers two consecutive award leases without running a queued tick or packet between them", async () => {
    const gate = new WorldBossSettlementGate(), first = await gate.acquire(), out: string[] = [];
    gate.tick(1, () => { out.push("tick"); }, () => {});
    const packet = gate.defer(() => { out.push("packet"); });
    let idle = false;
    const settled = gate.waitIdle().then(() => { idle = true; });
    // The first committed award resumes its event batch and accepts award 2
    // synchronously, before its finally releases award 1's lease.
    const second = gate.acquire();
    first();
    await Promise.resolve();
    expect(gate.held).toBe(true);
    expect(idle).toBe(false);
    expect(out).toEqual([]);
    (await second)();
    await Promise.all([packet, settled]);
    expect(out).toEqual(["tick", "packet"]);
    expect(idle).toBe(true);
  });

  it("waits for a promise returned by deferred work before applying later operations", async () => {
    const gate = new WorldBossSettlementGate(), finish = deferred(), out: string[] = [], release = await gate.acquire();
    const work = gate.defer(async () => { out.push("start"); await finish.promise; out.push("done"); });
    const stop = gate.defer(() => { out.push("stop"); });
    let idle = false;
    const settled = gate.waitIdle().then(() => { idle = true; });
    release();
    expect(out).toEqual(["start"]);
    await Promise.resolve();
    expect(idle).toBe(false);
    finish.resolve();
    await Promise.all([work, stop, settled]);
    expect(out).toEqual(["start", "done", "stop"]);
    expect(idle).toBe(true);
  });

  it("does not let an idle sentinel finish ahead of a second award created by earlier work", async () => {
    const gate = new WorldBossSettlementGate(), release = await gate.acquire();
    let next!: Promise<() => void>, idle = false;
    gate.tick(1, () => { next = gate.acquire(); }, () => {});
    const settled = gate.waitIdle().then(() => { idle = true; });
    release();
    await Promise.resolve();
    expect(idle).toBe(false);
    (await next)();
    await settled;
    expect(idle).toBe(true);
  });

  it("continues after synchronous and asynchronous operation rejection", async () => {
    const gate = new WorldBossSettlementGate(), out: string[] = [], release = await gate.acquire();
    const sync = gate.defer(() => { throw new Error("sync"); });
    const syncError = expect(sync).rejects.toThrow("sync");
    const async = gate.defer(async () => { throw new Error("async"); });
    const asyncError = expect(async).rejects.toThrow("async");
    const stop = gate.defer(() => { out.push("stop"); });
    release();
    await Promise.all([syncError, asyncError, stop, gate.waitIdle()]);
    expect(out).toEqual(["stop"]);
  });

  it("runs defer without a current lease and reports rejected tick promises", async () => {
    const gate = new WorldBossSettlementGate(), out: string[] = [];
    await gate.defer(() => { out.push("unlocked"); });
    gate.tick(1, async () => { throw new Error("tick"); }, (error) => { out.push((error as Error).message); });
    await gate.waitIdle();
    expect(out).toEqual(["unlocked", "tick"]);
  });

  it("coalesces only adjacent ticks and preserves commands between them", async () => {
    const gate = new WorldBossSettlementGate(), out: (string | number)[] = [], release = await gate.acquire();
    const tick = (now: number) => { out.push(now); };
    gate.tick(1, tick, () => {}); gate.tick(2, tick, () => {});
    const packet = gate.defer(() => { out.push("packet"); });
    gate.tick(3, tick, () => {}); gate.tick(4, tick, () => {});
    release();
    await Promise.all([packet, gate.waitIdle()]);
    expect(out).toEqual([2, "packet", 4]);
  });

  it("keeps non-promise return values synchronous, as the original void callbacks allowed", async () => {
    const gate = new WorldBossSettlementGate(), out: number[] = [], release = await gate.acquire();
    gate.tick(1, (now) => out.push(now), () => {});
    const packet = gate.defer(() => out.push(2));
    release();
    expect(out).toEqual([1, 2]);
    await Promise.all([packet, gate.waitIdle()]);
  });

  it("waits for queued asynchronous work that acquires and releases a lease itself", async () => {
    const gate = new WorldBossSettlementGate(), release = await gate.acquire(), finish = deferred(), out: string[] = [];
    const work = gate.defer(async () => {
      const ownRelease = await gate.acquire();
      out.push("award"); await finish.promise; ownRelease(); out.push("committed");
    });
    const stop = gate.defer(() => { out.push("stop"); });
    release(); await Promise.resolve();
    expect(out).toEqual(["award"]);
    finish.resolve();
    await Promise.all([work, stop, gate.waitIdle()]);
    expect(out).toEqual(["award", "committed", "stop"]);
  });
});
