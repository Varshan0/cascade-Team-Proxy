import Decimal from 'decimal.js';
import { publishChannel } from '../bus';
import type { Db } from '../db/client';
import { modeOf, type Runtime } from '../runtime';
import { INTERVALS, bucketStart, type Interval } from '../time';
import { ROLLUP_ORDER, ROLLUP_SOURCE, aggregate, type Candle } from './candles';
import type { Tick } from './ingest';
import { loadRange, upsertCandles } from './store';

interface Forming {
  t: number;
  o: Decimal;
  h: Decimal;
  l: Decimal;
  c: Decimal;
  v: Decimal;
  trades: number;
  firstTs: number;
  lastTs: number;
  source: string;
  dirty: boolean;
}

const toCandle = (f: Forming): Candle => ({ t: f.t, o: f.o.toFixed(), h: f.h.toFixed(), l: f.l.toFixed(), c: f.c.toFixed(), v: f.v.toFixed(), source: f.source, trades: f.trades });

/**
 * Recompute rollup buckets covering [from, to] (ms) for the given targets, in order, so that
 * 4h/1d (built from 1h) see freshly rebuilt 1h candles. Returns what was written, by interval.
 */
export async function recomputeRange(db: Db, instrument: string, from: number, to: number, targets: Array<Exclude<Interval, '1m'>> = ROLLUP_ORDER): Promise<Partial<Record<Interval, Candle[]>>> {
  const out: Partial<Record<Interval, Candle[]>> = {};
  for (const target of ROLLUP_ORDER.filter((t) => targets.includes(t))) {
    const src = ROLLUP_SOURCE[target];
    const lo = bucketStart(from, target);
    const hi = bucketStart(to, target) + INTERVALS[target];
    const rows = await loadRange(db, instrument, src, lo, hi);
    if (rows.length === 0) continue;
    const agg = aggregate(rows, target);
    await upsertCandles(db, instrument, target, agg);
    out[target] = agg;
  }
  return out;
}

/** Builds 1m candles from accepted (non-suspect) ticks and keeps every rollup interval current. */
export class CandleAggregator {
  private forming = new Map<string, Map<number, Forming>>();

  constructor(private rt: Runtime, private now: () => number = Date.now) {}

  onTick(t: Tick): void {
    const minute = bucketStart(t.ts, '1m');
    let byMinute = this.forming.get(t.instrument);
    if (!byMinute) this.forming.set(t.instrument, (byMinute = new Map()));
    const size = t.size ?? new Decimal(0);
    const f = byMinute.get(minute);
    if (!f) {
      byMinute.set(minute, { t: minute, o: t.price, h: t.price, l: t.price, c: t.price, v: size, trades: 1, firstTs: t.ts, lastTs: t.ts, source: t.source, dirty: true });
      return;
    }
    f.h = Decimal.max(f.h, t.price);
    f.l = Decimal.min(f.l, t.price);
    if (t.ts < f.firstTs) {
      // out-of-order tick that is actually the earliest of the minute
      f.o = t.price;
      f.firstTs = t.ts;
    }
    if (t.ts >= f.lastTs) {
      f.c = t.price;
      f.lastTs = t.ts;
    }
    f.v = f.v.plus(size);
    f.trades++;
    f.dirty = true;
  }

  /** Write dirty 1m candles, refresh rollups, publish the forming/closed candle of each interval. */
  async flush(): Promise<void> {
    const nowMs = this.now();
    const currentMinute = bucketStart(nowMs, '1m');
    for (const [instrument, byMinute] of this.forming) {
      const dirty = [...byMinute.values()].filter((f) => f.dirty).sort((a, b) => a.t - b.t);
      if (dirty.length > 0) {
        await upsertCandles(this.rt.db, instrument, '1m', dirty.map(toCandle));
        const written = await recomputeRange(this.rt.db, instrument, dirty[0]!.t, dirty[dirty.length - 1]!.t);
        for (const f of dirty) f.dirty = false;
        const latest = dirty[dirty.length - 1]!;
        const all: Partial<Record<Interval, Candle[]>> = { ...written, '1m': [toCandle(latest)] };
        for (const [interval, cs] of Object.entries(all) as Array<[Interval, Candle[]]>) {
          const c = cs[cs.length - 1];
          if (!c) continue;
          await publishChannel(
            this.rt.redis,
            `candles:${instrument}:${interval}`,
            { symbol: instrument, interval, candle: c, closed: c.t + INTERVALS[interval] <= nowMs },
            { mode: modeOf(this.rt.config) },
          );
        }
      }
      for (const t of byMinute.keys()) if (t < currentMinute - 2 * INTERVALS['1m']) byMinute.delete(t);
    }
  }
}
