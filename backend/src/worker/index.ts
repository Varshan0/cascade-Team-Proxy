import { loadConfig } from '../shared/config';
import { createDb } from '../shared/db/client';
import { createLogger } from '../shared/logger';
import { createRedis } from '../shared/redis';
import { BullScheduler, type Runtime } from '../shared/runtime';
import { startWorker } from './start';

// Production path: real Postgres + Redis, durable jobs through BullMQ.
const config = loadConfig();
const logger = createLogger(config, 'worker');
const { db, close } = createDb(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
const scheduler = new BullScheduler(redis, logger);
const rt: Runtime = { config, db, redis, logger, scheduler, kind: 'prod' };

const handle = await startWorker(rt);
logger.info(`worker started (offline=${config.DEMO_OFFLINE})`);

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await handle.stop();
  await scheduler.stop();
  redis.disconnect();
  await close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
