import { loadConfig } from '../shared/config';
import { createDb } from '../shared/db/client';
import { createLogger } from '../shared/logger';
import { createRedis } from '../shared/redis';
import { buildApp } from './app';

const config = loadConfig();
const logger = createLogger(config, 'api');
const { db, close } = createDb(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);

const app = await buildApp({ config, db, redis, logger });

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  redis.disconnect();
  await close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: '0.0.0.0' });
logger.info(`API listening on :${config.PORT} (docs at /docs, offline=${config.DEMO_OFFLINE})`);
