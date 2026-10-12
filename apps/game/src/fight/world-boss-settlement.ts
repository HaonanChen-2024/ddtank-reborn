/** A short write barrier for an already-running fight while a ranked award is
 * committed. It keeps wall-clock time: no timer, turn or physics rule is reset.
 * Client command promises apply backpressure through the existing client chain;
 * adjacent timer ticks coalesce, remove/stop are idempotent. No packet is copied
 * or re-read until its original operation reaches the front of the queue. */
export class WorldBossSettlementGate {
  held = false;
  private leases: ((release: () => void) => void)[] = [];
  private queue: { key?: string; tick?: number; work: (now?: number) => void; resolve: () => void; reject: (error: unknown) => void }[] = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (this.held) this.leases.push(resolve);
      else { this.held = true; resolve(this.release()); }
    });
  }

  defer(work: () => void, key?: string): Promise<void> {
    if (key && this.queue.some((entry) => entry.key === key)) return Promise.resolve();
    return new Promise((resolve, reject) => { this.queue.push({ key, work, resolve, reject }); });
  }

  tick(now: number, work: (now: number) => void, error: (error: unknown) => void): void {
    const last = this.queue.at(-1);
    if (last?.tick !== undefined) { last.tick = now; return; }
    this.queue.push({ tick: now, work: (value) => work(value!), resolve: () => {}, reject: error });
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true; this.held = false;
      // Drain synchronously before this award releases its player's save lock.
      // One failed transport must not swallow a later remove/stop operation.
      const queue = this.queue; this.queue = [];
      for (const entry of queue) {
        try { entry.work(entry.tick); entry.resolve(); } catch (error) { entry.reject(error); }
      }
      const next = this.leases.shift();
      if (next) { this.held = true; next(this.release()); }
    };
  }
}
