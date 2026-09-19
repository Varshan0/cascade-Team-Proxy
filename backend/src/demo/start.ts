import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import RedisMock from 'ioredis-mock';
import { buildApp, type App } from '../api/app';
import { loadConfig } from '../shared/config';
import type { Db } from '../shared/db/client';
import * as schema from '../shared/db/schema';
import { createLogger } from '../shared/logger';
import type { Redis } from '../shared/redis';
import { LocalScheduler, type Runtime } from '../shared/runtime';
import { startWorker, type WorkerHandle } from '../worker/start';

export interface DemoOptions {
  /** Env overrides layered over process.env (tests pass DEMO_OFFLINE, PORT, ...). */
  env?: Record<string, string>;
  /** PGlite data dir; `memory://` for an ephemeral DB. Default ./data/pglite (persists across restarts). */
  dataDir?: string;
  /** Listen on a socket (default true). */
  listen?: boolean;
}

export interface DemoHandle {
  app: App;
  rt: Runtime;
  worker: WorkerHandle;
  /** Base URL when listening. */
  url?: string;
  stop: () => Promise<void>;
}

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * No-Docker runtime: API and worker share ONE process, so ioredis-mock pub/sub and the in-process
 * scheduler connect them. Postgres is PGlite (file-persisted), migrated automatically at startup.
 * The Docker path (`npm run dev`, docker-compose) is untouched.
 */
export async function startDemo(opts: DemoOptions = {}): Promise<DemoHandle> {
  const config = loadConfig({ ...process.env, ...opts.env });
  const logger = createLogger(config, 'demo');

  const dataDir = opts.dataDir ?? process.env.PGLITE_DIR ?? './data/pglite';
  // PGlite creates the leaf directory only; make sure the parent exists (fresh checkouts have no ./data).
  if (!dataDir.startsWith('memory://')) mkdirSync(dirname(resolve(dataDir)), { recursive: true });
  const pg = new PGlite(dataDir);
  const orm = drizzle(pg, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS });
  const db = orm as unknown as Db;
  logger.info({ dataDir }, 'database ready (PGlite), migrations applied');

  const redis = new RedisMock() as unknown as Redis;
  const scheduler = new LocalScheduler(logger);
  const rt: Runtime = { config, db, redis, logger, scheduler, kind: 'demo' };

  const app = await buildApp(rt);
  const worker = await startWorker(rt);

  let url: string | undefined;
  if (opts.listen !== false) {
    await app.listen({ port: config.PORT, host: '127.0.0.1' });
    const addr = app.server.address();
    url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : undefined;
  } else {
    await app.ready();
  }

  return {
    app,
    rt,
    worker,
    url,
    stop: async () => {
      await scheduler.stop();
      await worker.stop();
      await app.close();
      redis.disconnect();
      await pg.close();
    },
  };
}
