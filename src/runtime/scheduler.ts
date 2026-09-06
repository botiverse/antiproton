import type { StorageAdapter } from "../core/store.ts";

/**
 * Turns "a task has unconsumed events" into "a worker steps it". Polling is the
 * durable half of §7.3: a dropped notification only delays work, it never loses
 * it, because the fact lives in the events table.
 */
export class Scheduler {
  #store: StorageAdapter;
  #run: (tenantId: string, taskId: string) => Promise<unknown>;
  #timer: NodeJS.Timeout | null = null;
  #busy = new Set<string>();
  #intervalMs: number;
  ticks = 0;

  constructor(
    store: StorageAdapter,
    run: (tenantId: string, taskId: string) => Promise<unknown>,
    opts: { intervalMs?: number } = {},
  ) {
    this.#store = store;
    this.#run = run;
    this.#intervalMs = opts.intervalMs ?? 150;
  }

  async tick() {
    this.ticks++;
    const pending = await (this.#store as any).tasksWithPendingWork(25);
    await Promise.all(
      pending.map(async ({ tenantId, taskId }: { tenantId: string; taskId: string }) => {
        const key = `${tenantId}/${taskId}`;
        if (this.#busy.has(key)) return; // one decision flow per task (§3.1)
        this.#busy.add(key);
        try {
          await this.#run(tenantId, taskId);
        } catch {
          /* the lease expires and another tick retries; nothing is lost */
        } finally {
          this.#busy.delete(key);
        }
      }),
    );
  }

  start() {
    if (this.#timer) return;
    const loop = async () => {
      await this.tick().catch(() => {});
      if (this.#timer) this.#timer = setTimeout(loop, this.#intervalMs);
    };
    this.#timer = setTimeout(loop, this.#intervalMs);
  }

  stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
