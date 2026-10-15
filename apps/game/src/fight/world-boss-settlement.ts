/** A short write barrier for an already-running fight while a ranked award is
 * committed. It keeps wall-clock time: no timer, turn or physics rule is reset.
 * Client command promises apply backpressure through the existing client chain;
 * adjacent timer ticks coalesce, remove/stop are idempotent. No packet is copied
 * or re-read until its original operation reaches the front of the queue. */
export class WorldBossSettlementGate {
  held = false;
  private leases: ((release: () => void) => void)[] = [];
  private queue: { key?: string; tick?: number; work: (now?: number) => unknown; resolve: () => void; reject: (error: unknown) => void }[] = [];
  private draining = false;
  private idle: (() => void)[] = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (this.held) this.leases.push(resolve);
      else { this.held = true; resolve(this.release()); }
    });
  }

  defer(work: () => unknown, key?: string): Promise<void> {
    if (key && this.queue.some((entry) => entry.key === key)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.queue.push({ key, work, resolve, reject }); this.drain();
    });
  }

  tick(now: number, work: (now: number) => unknown, error: (error: unknown) => void): void {
    const last = this.queue.at(-1);
    if (last?.tick !== undefined) { last.tick = now; return; }
    this.queue.push({ tick: now, work: (value) => work(value!), resolve: () => {}, reject: error });
    this.drain();
  }

  /** Includes work queued by an operation that acquires the gate again. A
   * sentinel queued behind one lease is not sufficient to observe this. */
  waitIdle(): Promise<void> {
    if (!this.held && !this.draining && !this.queue.length && !this.leases.length) return Promise.resolve();
    return new Promise((resolve) => { this.idle.push(resolve); });
  }

  private drain(): void {
    if (this.held || this.draining) return;
    this.draining = true;
    while (!this.held && this.queue.length) {
      const entry = this.queue.shift()!;
      try {
        const work = entry.work(entry.tick);
        if (work && typeof (work as PromiseLike<unknown>).then === "function") {
          // Preserve the original synchronous drain when possible. Inbound
          // commands can also return a promise and must finish before stop.
          void Promise.resolve(work).then(entry.resolve, entry.reject).finally(() => {
            this.draining = false; this.drain();
          });
          return;
        }
        entry.resolve();
      } catch (error) { entry.reject(error); }
      // A queued tick/command may synchronously acquire a new award lease.
      // Leave its remaining work queued until that lease has been released.
    }
    this.draining = false;
    if (!this.held) {
      const next = this.leases.shift();
      if (next) { this.held = true; next(this.release()); }
      else if (!this.queue.length) {
        const idle = this.idle; this.idle = [];
        for (const resolve of idle) resolve();
      }
    }
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A dispatch continuation may accept the next award before releasing
      // this one. Transfer its lease without opening a tick/packet gap.
      const next = this.leases.shift();
      if (next) { this.held = true; next(this.release()); return; }
      this.held = false;
      // Drain synchronously before this award releases its player's save lock.
      // One failed transport must not swallow a later remove/stop operation.
      this.drain();
    };
  }
}
