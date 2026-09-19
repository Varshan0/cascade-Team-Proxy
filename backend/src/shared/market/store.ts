import Decimal from 'decimal.js';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { candles } from '../db/schema';
import type { Interval } from '../time';
import type { Candle } from './candles';

type Row = typeof candles.$inferSelect;

/** NUMERIC(38,12) comes back zero-padded ("1.900000000000"); API decimals are shortest-form strings. */
export const trimDecimal = (s: string): string => new Decimal(s).toFixed();

export const rowToCandle = (r: Row): Candle => ({
  t: r.openTime.getTime(),
  o: trimDecimal(r.open),
  h: trimDecimal(r.high),
  l: trimDecimal(r.low),
  c: trimDecimal(r.close),
  v: trimDecimal(r.volume),
  source: r.source,
  trades: r.trades,
});

/** Idempotent upsert on (instrument, interval, open_time). Later writes win. */
export async function upsertCandles(db: Db, instrument: string, interval: Interval, rows: Candle[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    if (chunk.length === 0) continue;
    await db
      .insert(candles)
      .values(
        chunk.map((c) => ({
          instrument,
          interval,
          openTime: new Date(c.t),
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v,
          trades: c.trades ?? null,
          source: c.source,
        })),
      )
      .onConflictDoUpdate({
        target: [candles.instrument, candles.interval, candles.openTime],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          trades: sql`excluded.trades`,
          source: sql`excluded.source`,
        },
      });
  }
}

/** Candles with open_time in [from, to), ascending. */
export async function loadRange(db: Db, instrument: string, interval: Interval, from: number, to: number): Promise<Candle[]> {
  const rows = await db
    .select()
    .from(candles)
    .where(
      and(
        eq(candles.instrument, instrument),
        eq(candles.interval, interval),
        gte(candles.openTime, new Date(from)),
        lt(candles.openTime, new Date(to)),
      ),
    )
    .orderBy(asc(candles.openTime));
  return rows.map(rowToCandle);
}

/** Newest `limit` candles in [from, to), returned ascending. */
export async function loadLatest(db: Db, instrument: string, interval: Interval, from: number, to: number, limit: number): Promise<Candle[]> {
  const rows = await db
    .select()
    .from(candles)
    .where(
      and(
        eq(candles.instrument, instrument),
        eq(candles.interval, interval),
        gte(candles.openTime, new Date(from)),
        lt(candles.openTime, new Date(to)),
      ),
    )
    .orderBy(desc(candles.openTime))
    .limit(limit);
  return rows.map(rowToCandle).reverse();
}

export async function countRange(db: Db, instrument: string, interval: Interval, from: number, to: number): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(candles)
    .where(
      and(
        eq(candles.instrument, instrument),
        eq(candles.interval, interval),
        gte(candles.openTime, new Date(from)),
        lt(candles.openTime, new Date(to)),
      ),
    );
  return r?.n ?? 0;
}
