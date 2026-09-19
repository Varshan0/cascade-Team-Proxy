import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { instruments } from '../../shared/db/schema';
import { buildQuote } from '../../shared/market/quote';
import { loadLatest } from '../../shared/market/store';
import { modeOf } from '../../shared/runtime';
import { DAY, INTERVAL_LIST, type Interval } from '../../shared/time';
import { errors } from '../errors';

const symbolParams = z.object({ symbol: z.string().regex(/^[A-Z0-9]+-[A-Z]+$/, 'expected e.g. ETH-USD') });
const modeSchema = z.enum(['live', 'replay', 'drill', 'offline']);

const RANGES = { '1D': DAY, '1W': 7 * DAY, '1M': 30 * DAY, '3M': 90 * DAY, '1Y': 365 * DAY, '5Y': 5 * 365 * DAY, All: Number.POSITIVE_INFINITY } as const;

/** Sensible bar size for a window: keeps every chart tab between ~100 and ~600 bars. */
export function pickInterval(spanMs: number): Interval {
  if (spanMs <= 2 * DAY) return '5m';
  if (spanMs <= 14 * DAY) return '1h';
  if (spanMs <= 100 * DAY) return '4h';
  return '1d';
}

export const marketRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, redis, config } = app.ctx;
  const mode = modeOf(config);

  app.get(
    '/api/v1/instruments',
    {
      schema: {
        tags: ['market'],
        summary: 'Tradable instruments',
        response: {
          200: z.object({
            asOf: z.string(),
            mode: modeSchema,
            source: z.string(),
            instruments: z.array(z.object({ symbol: z.string(), base: z.string(), quote: z.string(), name: z.string(), sortOrder: z.number() })),
          }),
        },
      },
    },
    async () => {
      const rows = await db.select().from(instruments).where(eq(instruments.enabled, true)).orderBy(asc(instruments.sortOrder));
      return {
        asOf: new Date().toISOString(),
        mode,
        source: 'db',
        instruments: rows.map((r) => ({ symbol: r.symbol, base: r.base, quote: r.quote, name: r.name, sortOrder: r.sortOrder })),
      };
    },
  );

  const nullableStr = z.string().nullable();
  app.get(
    '/api/v1/instruments/:symbol/quote',
    {
      schema: {
        tags: ['market'],
        summary: 'Live quote with 24h stats, 52-week range, all-time high and market data',
        params: symbolParams,
        response: {
          200: z.object({
            asOf: z.string(),
            mode: modeSchema,
            source: z.string(),
            quote: z.object({
              symbol: z.string(), price: z.string(), change24h: nullableStr, changePct24h: nullableStr, open24h: nullableStr,
              high24h: nullableStr, low24h: nullableStr, previousClose: nullableStr, volume24h: nullableStr, marketCap: nullableStr,
              rank: z.number().nullable(), high52w: nullableStr, low52w: nullableStr, allTimeHigh: nullableStr,
              circulatingSupply: nullableStr, maxSupply: nullableStr, updatedAt: z.string(), sources: z.array(z.string()),
            }),
          }),
        },
      },
    },
    async (req) => {
      const { symbol } = req.params;
      const [inst] = await db.select().from(instruments).where(eq(instruments.symbol, symbol));
      if (!inst || !inst.enabled) throw errors.notFound(`Unknown instrument ${symbol}`);
      const quote = await buildQuote(db, redis, symbol);
      if (!quote) throw errors.unavailable(`No price for ${symbol} yet; the worker is still warming up`);
      return { asOf: new Date().toISOString(), mode, source: quote.sources[0] ?? 'unknown', quote };
    },
  );

  app.get(
    '/api/v1/instruments/:symbol/candles',
    {
      schema: {
        tags: ['market'],
        summary: 'OHLCV candles. Use `range` (chart tabs) or `from`/`to`; interval is chosen for you if omitted.',
        params: symbolParams,
        querystring: z.object({
          interval: z.enum(INTERVAL_LIST as [Interval, ...Interval[]]).optional(),
          range: z.enum(['1D', '1W', '1M', '3M', '1Y', '5Y', 'All']).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          limit: z.coerce.number().int().min(1).max(2000).default(500),
        }),
        response: {
          200: z.object({
            asOf: z.string(),
            mode: modeSchema,
            source: z.string(),
            symbol: z.string(),
            interval: z.string(),
            candles: z.array(z.object({ t: z.string(), o: z.string(), h: z.string(), l: z.string(), c: z.string(), v: z.string(), source: z.string() })),
          }),
        },
      },
    },
    async (req) => {
      const { symbol } = req.params;
      const q = req.query;
      const [inst] = await db.select().from(instruments).where(eq(instruments.symbol, symbol));
      if (!inst || !inst.enabled) throw errors.notFound(`Unknown instrument ${symbol}`);

      const now = Date.now();
      const to = q.to ? Date.parse(q.to) : now + 1;
      const from = q.from ? Date.parse(q.from) : q.range ? (Number.isFinite(RANGES[q.range]) ? now - RANGES[q.range] : 0) : now - DAY;
      if (from >= to) throw errors.badRequest('`from` must be before `to`');
      const interval = q.interval ?? pickInterval(Number.isFinite(to - from) && from > 0 ? to - from : Number.POSITIVE_INFINITY);

      const rows = await loadLatest(db, symbol, interval, from, to, q.limit);
      return {
        asOf: new Date().toISOString(),
        mode,
        source: rows[rows.length - 1]?.source ?? 'none',
        symbol,
        interval,
        candles: rows.map((c) => ({ t: new Date(c.t).toISOString(), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, source: c.source })),
      };
    },
  );
};
