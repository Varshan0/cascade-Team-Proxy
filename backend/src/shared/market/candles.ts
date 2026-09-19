import Decimal from 'decimal.js';
import { INTERVALS, bucketStart, type Interval } from '../time';

/** Wire/domain candle. Prices and volume are decimal strings; `t` is the bucket open time in ms. */
export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  source: string;
  trades?: number | null;
}

/** Roll finer candles up into `target` buckets. Input need not be sorted; partial buckets are returned as-is. */
export function aggregate(src: Candle[], target: Interval): Candle[] {
  const sorted = [...src].sort((a, b) => a.t - b.t);
  const groups = new Map<number, Candle[]>();
  for (const c of sorted) {
    const b = bucketStart(c.t, target);
    const g = groups.get(b);
    if (g) g.push(c);
    else groups.set(b, [c]);
  }
  const out: Candle[] = [];
  for (const [t, g] of groups) {
    const first = g[0]!;
    const last = g[g.length - 1]!;
    let hi = new Decimal(first.h);
    let lo = new Decimal(first.l);
    let vol = new Decimal(0);
    let trades: number | null = 0;
    for (const c of g) {
      hi = Decimal.max(hi, c.h);
      lo = Decimal.min(lo, c.l);
      vol = vol.plus(c.v);
      trades = trades !== null && c.trades != null ? trades + c.trades : null;
    }
    out.push({ t, o: first.o, h: hi.toFixed(), l: lo.toFixed(), c: last.c, v: vol.toFixed(), source: last.source, trades });
  }
  return out;
}

/** Open times missing from `[from, to)` at the given step. `times` may be unsorted / contain out-of-range values. */
export function findMissing(times: Iterable<number>, from: number, to: number, step: number): number[] {
  const have = new Set(times);
  const missing: number[] = [];
  for (let t = Math.ceil(from / step) * step; t < to; t += step) if (!have.has(t)) missing.push(t);
  return missing;
}

/** The interval a candle series should be built from (4h and 1d roll up from 1h, the rest from 1m). */
export const ROLLUP_SOURCE: Record<Exclude<Interval, '1m'>, Interval> = {
  '5m': '1m',
  '15m': '1m',
  '1h': '1m',
  '4h': '1h',
  '1d': '1h',
};

export const ROLLUP_ORDER: Array<Exclude<Interval, '1m'>> = ['5m', '15m', '1h', '4h', '1d'];

export function bucketEnd(t: number, i: Interval): number {
  return bucketStart(t, i) + INTERVALS[i];
}
