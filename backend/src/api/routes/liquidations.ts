import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { readSnapshot } from '../../shared/bus';
import { decodeCursor, liquidationStats, listLiquidations } from '../../shared/chain/liq-store';
import type { OracleState } from '../../shared/chain/oracle';
import { modeOf } from '../../shared/runtime';
import { DAY, HOUR } from '../../shared/time';
import { errors } from '../errors';

const modeSchema = z.enum(['live', 'replay', 'drill', 'offline']);
const WINDOWS = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY } as const;

const dto = z.object({
  id: z.number(), txHash: z.string(), logIndex: z.number(), blockNumber: z.number(), ts: z.string(),
  collateralAsset: z.string(), collateralSymbol: z.string().nullable(), debtAsset: z.string(), debtSymbol: z.string().nullable(),
  user: z.string(), liquidator: z.string(), debtAmountRaw: z.string(), collateralAmountRaw: z.string(),
  usdValue: z.string().nullable(), status: z.string(), txUrl: z.string(),
});

export const liquidationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, redis, config } = app.ctx;
  const mode = modeOf(config);
  const source = 'aave-v3-mainnet';

  app.get(
    '/api/v1/liquidations',
    {
      schema: {
        tags: ['liquidations'],
        summary: 'Aave V3 liquidations, newest first, cursor-paginated',
        querystring: z.object({
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
          minUsd: z.string().regex(/^\d+(\.\d+)?$/).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
        response: { 200: z.object({ asOf: z.string(), mode: modeSchema, source: z.string(), items: z.array(dto), nextCursor: z.string().nullable() }) },
      },
    },
    async (req) => {
      const q = req.query;
      if (q.cursor && !decodeCursor(q.cursor)) throw errors.badRequest('Invalid cursor');
      const { items, nextCursor } = await listLiquidations(db, {
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        asset: q.asset,
        minUsd: q.minUsd,
        limit: q.limit,
        cursor: q.cursor,
      });
      return { asOf: new Date().toISOString(), mode, source, items, nextCursor };
    },
  );

  app.get(
    '/api/v1/liquidations/stats',
    {
      schema: {
        tags: ['liquidations'],
        summary: 'Totals, counts, top collateral assets and an hourly series',
        querystring: z.object({ window: z.enum(['1h', '24h', '7d']).default('24h') }),
        response: {
          200: z.object({
            asOf: z.string(), mode: modeSchema, source: z.string(), window: z.string(), totalUsd: z.string(), count: z.number(),
            topAssets: z.array(z.object({ asset: z.string(), symbol: z.string().nullable(), usd: z.string(), count: z.number() })),
            hourly: z.array(z.object({ hour: z.string(), usd: z.string(), count: z.number() })),
          }),
        },
      },
    },
    async (req) => {
      const w = req.query.window;
      const stats = await liquidationStats(db, WINDOWS[w], w);
      return { asOf: new Date().toISOString(), mode, source, ...stats };
    },
  );

  app.get(
    '/api/v1/oracle/:symbol',
    {
      schema: {
        tags: ['liquidations'],
        summary: 'Chainlink price (what Aave liquidates on) vs the fast market price, and the gap between them',
        params: z.object({ symbol: z.string().regex(/^[A-Z0-9]+-[A-Z]+$/) }),
        response: {
          200: z.object({
            asOf: z.string(), mode: modeSchema, source: z.string(),
            oracle: z.object({
              symbol: z.string(), chainlinkPrice: z.string(), fastPrice: z.string().nullable(), gap: z.string().nullable(), pressure: z.boolean(),
              roundId: z.string(), updatedAt: z.string(), ageSec: z.number(), heartbeatSec: z.number(), deviation: z.number(),
            }),
          }),
        },
      },
    },
    async (req) => {
      const snap = await readSnapshot(redis, `oracle:${req.params.symbol}`);
      if (!snap?.data) throw errors.notFound(`No oracle data for ${req.params.symbol} (only ETH-USD and BTC-USD have Chainlink feeds)`);
      return { asOf: new Date().toISOString(), mode, source: 'chainlink', oracle: snap.data as OracleState };
    },
  );
};
