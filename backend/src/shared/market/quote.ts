import { and, eq, gte, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { readPrice } from '../bus';
import { candles } from '../db/schema';
import { DAY, HOUR, bucketStart } from '../time';
import { loadLatest } from './store';
import type { Db } from '../db/client';
import type { Redis } from '../redis';

export interface MarketSnapshot {
  marketCap: number | null;
  rank: number | null;
  circulatingSupply: number | null;
  maxSupply: number | null;
  ath: number | null;
  volume24h: number | null;
  updatedAt: string;
}

export const mktKey = (symbol: string) => `mkt:${symbol}`;

export interface Quote {
  symbol: string;
  price: string;
  change24h: string | null;
  changePct24h: string | null;
  open24h: string | null;
  high24h: string | null;
  low24h: string | null;
  previousClose: string | null;
  volume24h: string | null;
  marketCap: string | null;
  rank: number | null;
  high52w: string | null;
  low52w: string | null;
  allTimeHigh: string | null;
  circulatingSupply: string | null;
  maxSupply: string | null;
  updatedAt: string;
  sources: string[];
}

const opt = (n: number | null | undefined): string | null => (n === null || n === undefined ? null : new Decimal(n).toFixed());

/** Returns null when no price is known yet (fresh install before the first tick or backfill). */
export async function buildQuote(db: Db, redis: Redis, symbol: string, now = Date.now()): Promise<Quote | null> {
  const sources = new Set<string>();
  const px = (await readPrice(redis, symbol, true)) ?? (await readPrice(redis, symbol, false));

  const dayStart = bucketStart(now, '1d');
  const hourly = await loadLatest(db, symbol, '1h', bucketStart(now - DAY, '1h'), now + HOUR, 26);
  const lastMinute = (await loadLatest(db, symbol, '1m', now - 3 * HOUR, now + HOUR, 1))[0];

  const priceStr = px?.price ?? lastMinute?.c;
  if (!priceStr) return null;
  const price = new Decimal(priceStr);
  if (px) sources.add(px.source);
  if (hourly.length || lastMinute) sources.add(hourly[0]?.source ?? lastMinute!.source);

  let open24h: Decimal | null = null;
  let high: Decimal | null = null;
  let low: Decimal | null = null;
  let vol = new Decimal(0);
  if (hourly.length) {
    open24h = new Decimal(hourly[0]!.o);
    high = Decimal.max(...hourly.map((c) => c.h));
    low = Decimal.min(...hourly.map((c) => c.l));
    for (const c of hourly) vol = vol.plus(c.v);
  }
  const prev = (await loadLatest(db, symbol, '1d', dayStart - 5 * DAY, dayStart, 1))[0];

  const yearAgo = new Date(now - 365 * DAY);
  const [agg] = await db
    .select({ hi: sql<string | null>`max(${candles.high})`, lo: sql<string | null>`min(${candles.low})` })
    .from(candles)
    .where(and(eq(candles.instrument, symbol), eq(candles.interval, '1d'), gte(candles.openTime, yearAgo)));
  const [ath] = await db
    .select({ hi: sql<string | null>`max(${candles.high})` })
    .from(candles)
    .where(and(eq(candles.instrument, symbol), eq(candles.interval, '1d')));

  const rawMkt = await redis.get(mktKey(symbol));
  const mkt: MarketSnapshot | null = rawMkt ? (JSON.parse(rawMkt) as MarketSnapshot) : null;
  if (mkt) sources.add('coingecko');

  const change = open24h ? price.minus(open24h) : null;
  const athMerged = [ath?.hi, mkt?.ath].filter((x): x is string | number => x !== null && x !== undefined).map((x) => new Decimal(x));
  return {
    symbol,
    price: price.toFixed(),
    change24h: change?.toFixed() ?? null,
    changePct24h: change && open24h && !open24h.isZero() ? change.div(open24h).times(100).toDecimalPlaces(4).toFixed() : null,
    open24h: open24h?.toFixed() ?? null,
    high24h: high ? Decimal.max(high, price).toFixed() : null,
    low24h: low ? Decimal.min(low, price).toFixed() : null,
    previousClose: prev?.c ?? null,
    volume24h: hourly.length ? vol.toFixed() : null,
    marketCap: opt(mkt?.marketCap),
    rank: mkt?.rank ?? null,
    high52w: agg?.hi ? new Decimal(agg.hi).toFixed() : null,
    low52w: agg?.lo ? new Decimal(agg.lo).toFixed() : null,
    allTimeHigh: athMerged.length ? Decimal.max(...athMerged).toFixed() : null,
    circulatingSupply: opt(mkt?.circulatingSupply),
    maxSupply: opt(mkt?.maxSupply),
    updatedAt: px?.ts ?? new Date(lastMinute!.t).toISOString(),
    sources: [...sources],
  };
}
