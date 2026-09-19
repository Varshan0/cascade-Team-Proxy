import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import RedisMock from 'ioredis-mock';
import { buildApp, type App } from '../src/api/app';
import { loadConfig } from '../src/shared/config';
import type { Db } from '../src/shared/db/client';
import { ensureInstruments } from '../src/shared/db/seed-base';
import * as schema from '../src/shared/db/schema';
import { createLogger } from '../src/shared/logger';
import type { Redis } from '../src/shared/redis';
import { LocalScheduler, type Runtime } from '../src/shared/runtime';

export interface TestContext {
  app: App;
  db: Db;
  redis: Redis;
  rt: Runtime;
  /** Listen on an ephemeral port and return the base URL (for WebSocket tests). */
  listen: () => Promise<string>;
  close: () => Promise<void>;
}

/** In-process Postgres (PGlite) + in-memory Redis: no Docker needed for unit/API tests. */
export async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env });
  const pg = new PGlite();
  const orm = drizzle(pg, { schema });
  await migrate(orm, { migrationsFolder: resolve(__dirname, '../drizzle') });
  const db = orm as unknown as Db;
  await ensureInstruments(db);
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall(); // ioredis-mock shares one keyspace per process
  const logger = createLogger(config);
  const rt: Runtime = { config, db, redis, logger, scheduler: new LocalScheduler(logger), kind: 'demo' };
  const app = await buildApp(rt);
  await app.ready();
  return {
    app,
    db,
    redis,
    rt,
    listen: async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      return `http://127.0.0.1:${addr.port}`;
    },
    close: async () => {
      await rt.scheduler.stop();
      await app.close();
      await pg.close();
    },
  };
}

export const fixture = <T = unknown>(name: string): T =>
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')) as T;

/** Build a fetch that replays queued responses in order; records requested URLs. */
export function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string>; throws?: Error }>) {
  const calls: string[] = [];
  let i = 0;
  const impl = (async (url: URL | string) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r.throws) throw r.throws;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}
