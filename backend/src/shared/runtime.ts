import { Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { MODES, type Config, type Mode } from './config';
import type { Db } from './db/client';
import type { Redis } from './redis';

export interface JobOptions {
  /** Run once immediately in addition to the interval. */
  immediate?: boolean;
  /**
   * Durable jobs run through BullMQ in production (retries, single execution across worker replicas).
   * High-frequency loops (candle flush, sim ticks) are never durable: they stay in-process timers.
   */
  durable?: boolean;
}

export interface Scheduler {
  every(name: string, ms: number, fn: () => Promise<void> | void, opts?: JobOptions): void;
  /** Fire-and-forget one-off job (e.g. backfill). */
  once(name: string, fn: () => Promise<void> | void): void;
  stop(): Promise<void>;
}

/** In-process scheduler: the demo-mode replacement for BullMQ (BullMQ's Lua scripts don't run on ioredis-mock). */
export class LocalScheduler implements Scheduler {
  private timers = new Set<NodeJS.Timeout>();
  private running = new Set<string>();
  private stopped = false;

  constructor(private logger: Logger) {}

  private async run(name: string, fn: () => Promise<void> | void): Promise<void> {
    if (this.stopped || this.running.has(name)) return; // never overlap runs of the same job
    this.running.add(name);
    try {
      await fn();
    } catch (err) {
      this.logger.error({ err, job: name }, 'job failed');
    } finally {
      this.running.delete(name);
    }
  }

  every(name: string, ms: number, fn: () => Promise<void> | void, opts: JobOptions = {}): void {
    const t = setInterval(() => void this.run(name, fn), ms);
    t.unref?.();
    this.timers.add(t);
    if (opts.immediate) void this.run(name, fn);
  }

  once(name: string, fn: () => Promise<void> | void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.run(name, fn);
    }, 0);
    this.timers.add(t);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    this.timers.clear();
    // let in-flight jobs finish their current await before callers close DB handles
    for (let i = 0; i < 50 && this.running.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Production scheduler: durable jobs go through BullMQ repeatable jobs, everything else runs in-process.
 * NOTE: not exercised by the automated tests (needs a real Redis); the demo path uses LocalScheduler.
 */
export class BullScheduler implements Scheduler {
  private local: LocalScheduler;
  private handlers = new Map<string, () => Promise<void> | void>();
  private queue: Queue;
  private worker: Worker;

  constructor(redis: Redis, private logger: Logger) {
    this.local = new LocalScheduler(logger);
    this.queue = new Queue('jobs', { connection: redis });
    this.worker = new Worker(
      'jobs',
      async (job) => {
        const h = this.handlers.get(job.name);
        if (h) await h();
      },
      { connection: redis.duplicate(), concurrency: 4 },
    );
    this.worker.on('failed', (job, err) => logger.error({ err, job: job?.name }, 'bull job failed'));
  }

  every(name: string, ms: number, fn: () => Promise<void> | void, opts: JobOptions = {}): void {
    if (!opts.durable) return this.local.every(name, ms, fn, opts);
    this.handlers.set(name, fn);
    void this.queue.upsertJobScheduler(name, { every: ms }, { name, opts: { removeOnComplete: true, removeOnFail: 50, attempts: 3 } });
    if (opts.immediate) void this.queue.add(name, {}, { removeOnComplete: true });
  }

  once(name: string, fn: () => Promise<void> | void): void {
    this.handlers.set(name, fn);
    void this.queue.add(name, {}, { removeOnComplete: true, attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
  }

  async stop(): Promise<void> {
    await this.local.stop();
    await this.worker.close();
    await this.queue.close();
  }
}

export interface Runtime {
  config: Config;
  db: Db;
  redis: Redis;
  logger: Logger;
  scheduler: Scheduler;
  kind: 'demo' | 'prod';
}

export const modeOf = (config: Pick<Config, 'DEMO_OFFLINE'>): Mode => (config.DEMO_OFFLINE ? 'offline' : 'live');
export { MODES };
