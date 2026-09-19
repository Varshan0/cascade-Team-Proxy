import type { Logger } from 'pino';
import type { Db } from '../db/client';
import { runChain } from '../providers/failover';
import type { CoinbaseAdvanced, CoinbaseRest } from '../providers/coinbase';
import { DAY, INTERVALS, bucketStart, type Interval } from '../time';
import { findMissing, type Candle } from './candles';
import { recomputeRange } from './aggregator';
import { countRange, loadRange, upsertCandles } from './store';

export interface CandleProviders {
  rest: CoinbaseRest;
  advanced: CoinbaseAdvanced;
}

/** Backfill windows from the spec: 1m x 7d, 1h x 1y, 1d x 5y. 5m/15m come from 1m and 4h from 1h. */
export const BACKFILL_PLAN: Array<{ interval: '1m' | '1h' | '1d'; spanMs: number }> = [
  { interval: '1m', spanMs: 7 * DAY },
  { interval: '1h', spanMs: 365 * DAY },
  { interval: '1d', spanMs: 5 * 365 * DAY },
];

const MAX_PER_CALL = 300;
/** Skip a window when at least this share of its expected candles is already stored. */
const COVERED = 0.98;

/** Fetch [from, to) through the candles failover chain, in provider-sized windows. */
export async function fetchCandles(p: CandleProviders, product: string, interval: Interval, from: number, to: number, onWindow?: (c: Candle[]) => Promise<void>): Promise<number> {
  const step = INTERVALS[interval];
  const windowMs = MAX_PER_CALL * step;
  let total = 0;
  for (let start = bucketStart(from, interval); start < to; start += windowMs) {
    const end = Math.min(start + windowMs, to);
    const { value } = await runChain('candles', [
      { name: 'coinbase-rest', run: () => p.rest.candles(product, interval, start, end) },
      { name: 'coinbase-advanced', run: () => p.advanced.candles(product, interval, start, end) },
    ]);
    total += value.length;
    if (onWindow) await onWindow(value);
  }
  return total;
}

export async function backfillInstrument(db: Db, p: CandleProviders, instrument: string, product: string, logger: Logger, now = Date.now()): Promise<void> {
  const end = bucketStart(now, '1m'); // never write the still-forming minute from REST
  for (const { interval, spanMs } of BACKFILL_PLAN) {
    const from = bucketStart(now - spanMs, interval);
    const expected = Math.floor((end - from) / INTERVALS[interval]);
    const have = await countRange(db, instrument, interval, from, end);
    if (have >= expected * COVERED) {
      logger.debug({ instrument, interval, have, expected }, 'backfill skipped, window already covered');
      continue;
    }
    logger.info({ instrument, interval, have, expected }, 'backfilling candles');
    const n = await fetchCandles(p, product, interval, from, end, (cs) => upsertCandles(db, instrument, interval, cs));
    logger.info({ instrument, interval, fetched: n }, 'backfill window done');
  }
  // Derived series: 5m + 15m from 1m, 4h from 1h (Coinbase has no 4h).
  await recomputeRange(db, instrument, bucketStart(now - 7 * DAY, '1m'), end, ['5m', '15m']);
  await recomputeRange(db, instrument, bucketStart(now - 365 * DAY, '1h'), end, ['4h']);
}

/**
 * Gap detection + repair (spec 5.2): find missing minutes in the recent window, refetch that window from REST
 * (which also corrects tick-built volume), then rebuild the affected rollups. Returns the number of gaps found.
 */
export async function reconcileRecent(db: Db, p: CandleProviders, instrument: string, product: string, logger: Logger, now = Date.now(), lookbackMs = 3 * 3_600_000): Promise<number> {
  const end = bucketStart(now, '1m');
  const from = bucketStart(now - lookbackMs, '1m');
  const existing = await loadRange(db, instrument, '1m', from, end);
  const gaps = findMissing(existing.map((c) => c.t), from, end, INTERVALS['1m']);
  await fetchCandles(p, product, '1m', from, end, (cs) => upsertCandles(db, instrument, '1m', cs));
  await recomputeRange(db, instrument, from, end);
  if (gaps.length) logger.warn({ instrument, gaps: gaps.length }, 'repaired missing 1m candles');
  return gaps.length;
}
