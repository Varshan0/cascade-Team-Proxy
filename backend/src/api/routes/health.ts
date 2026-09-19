import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CRITICAL_CHAINS } from '../../shared/config';
import { evaluateChains, readHealth } from '../../shared/providers/health';

const providerSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'degraded', 'down', 'unknown']),
  circuit: z.enum(['closed', 'open', 'half-open']),
  lastSuccess: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  p95LatencyMs: z.number().nullable(),
  successCount: z.number(),
  errorCount: z.number(),
  quotaRemaining: z.number().nullable(),
  reportedAt: z.string().optional(),
});

const chainsSchema = z.record(
  z.string(),
  z.object({ status: z.enum(['ok', 'degraded', 'down', 'unknown']), providers: z.array(z.string()) }),
);

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, redis } = app.ctx;

  app.get(
    '/health',
    { schema: { tags: ['ops'], summary: 'Liveness', response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['ops'],
        summary: 'Readiness: DB, Redis, and no failover chain fully down',
        response: {
          200: z.object({ status: z.literal('ready'), checks: z.record(z.string(), z.string()), chains: chainsSchema }),
          503: z.object({ status: z.literal('not_ready'), checks: z.record(z.string(), z.string()), chains: chainsSchema }),
        },
      },
    },
    async (_req, reply) => {
      const checks: Record<string, string> = {};
      try {
        await db.execute(sql`select 1`);
        checks.db = 'ok';
      } catch (e) {
        checks.db = `error: ${(e as Error).message}`;
      }
      let providers: Awaited<ReturnType<typeof readHealth>> = [];
      try {
        await redis.ping();
        checks.redis = 'ok';
        providers = await readHealth(redis);
      } catch (e) {
        checks.redis = `error: ${(e as Error).message}`;
      }
      const chains = evaluateChains(providers);
      for (const [name, c] of Object.entries(chains)) checks[`chain:${name}`] = c.status;
      // Markets/explorer outages degrade features but must not take the whole service out of rotation.
      const ready =
        checks.db === 'ok' &&
        checks.redis === 'ok' &&
        CRITICAL_CHAINS.every((name) => chains[name]?.status !== 'down');
      return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks, chains } as never);
    },
  );

  app.get(
    '/health/providers',
    {
      schema: {
        tags: ['ops'],
        summary: 'Per-provider status table (drives the frontend "data sources" indicator)',
        response: {
          200: z.object({
            asOf: z.string(),
            providers: z.array(providerSchema),
            chains: chainsSchema,
            suspectTicks: z.object({ total: z.number(), recent: z.array(z.record(z.string(), z.unknown())) }),
            indexer: z.record(z.string(), z.unknown()).nullable(),
          }),
        },
      },
    },
    async () => {
      const providers = await readHealth(redis);
      const recent = (await redis.lrange('suspect:recent', 0, 19)).map((s) => JSON.parse(s) as Record<string, unknown>);
      const total = Number((await redis.get('suspect:count')) ?? 0);
      const idx = await redis.get('indexer:status');
      return { asOf: new Date().toISOString(), providers, chains: evaluateChains(providers), suspectTicks: { total, recent }, indexer: idx ? (JSON.parse(idx) as Record<string, unknown>) : null };
    },
  );
};
