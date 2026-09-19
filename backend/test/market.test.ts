import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { candles as candlesTable } from '../src/shared/db/schema';
import { CandleAggregator } from '../src/shared/market/aggregator';
import { BACKFILL_PLAN, backfillInstrument, reconcileRecent, type CandleProviders } from '../src/shared/market/backfill';
import { aggregate, findMissing, type Candle } from '../src/shared/market/candles';
import { TickPipeline, isSuspect, type Tick } from '../src/shared/market/ingest';
import { countRange, loadRange, upsertCandles } from '../src/shared/market/store';
import { DAY, INTERVALS, bucketStart, type Interval } from '../src/shared/time';
import { createTestContext, type TestContext } from './helpers';

const c = (t: number, o: number, h: number, l: number, cl: number, v = 1): Candle => ({ t, o: String(o), h: String(h), l: String(l), c: String(cl), v: String(v), source: 'test' });
const D = (iso: string) => Date.parse(iso);

describe('candle math', () => {
  it('buckets are UTC-aligned for 4h and 1d', () => {
    expect(bucketStart(D('2026-09-19T13:59:59Z'), '4h')).toBe(D('2026-09-19T12:00:00Z'));
    expect(bucketStart(D('2026-09-19T23:59:59Z'), '1d')).toBe(D('2026-09-19T00:00:00Z'));
    expect(bucketStart(D('2026-09-19T00:07:30Z'), '15m')).toBe(D('2026-09-19T00:00:00Z'));
  });

  it('rolls 1m up to 5m with correct OHLCV, ignoring input order', () => {
    const base = D('2026-09-19T12:00:00Z');
    const mins = [c(base + 120_000, 12, 15, 11, 14, 3), c(base, 10, 12, 9, 11, 1), c(base + 60_000, 11, 13, 10, 12, 2), c(base + 300_000, 14, 20, 14, 19, 5)];
    const out = aggregate(mins, '5m');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ t: base, o: '10', h: '15', l: '9', c: '14', v: '6' });
    expect(out[1]).toMatchObject({ t: base + 300_000, o: '14', c: '19' });
  });

  it('finds missing candle open times', () => {
    const base = D('2026-09-19T12:00:00Z');
    expect(findMissing([base, base + 120_000], base, base + 180_000, 60_000)).toEqual([base + 60_000]);
  });
});

describe('sanity check', () => {
  it('flags >1.5% disagreement only', () => {
    expect(isSuspect(new Decimal(2040), [new Decimal(2000)])).toBe(true);
    expect(isSuspect(new Decimal(2028), [new Decimal(2000)])).toBe(false);
    expect(isSuspect(new Decimal(1960), [new Decimal(2000)])).toBe(true);
  });
});

describe('tick pipeline', () => {
  let t: TestContext;
  beforeAll(async () => (t = await createTestContext()));
  afterAll(() => t.close());
  const tick = (source: string, price: number, ts = 0) => ({ instrument: 'ETH-USD', price: new Decimal(price), ts, source });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('a fresh higher-priority source suppresses lower ones; stale primary hands over; disagreement is flagged suspect', async () => {
    let now = 1_000_000;
    const accepted: Tick[] = [];
    const p = new TickPipeline(t.rt, (x) => accepted.push(x), () => now);

    expect(p.handle(tick('coinbase-ws', 2000))?.suspect).toBe(false);
    now += 2_000;
    expect(p.handle(tick('coinbase-rest', 2001))).toBeNull(); // ws is fresh: rest is only a cross-check
    now += 9_000; // ws now 11s old -> stale
    const s = p.handle(tick('coinbase-rest', 2040)); // 2% away from ws (still within cross-check age)
    expect(s?.suspect).toBe(true);
    expect(accepted.map((a) => a.price.toFixed())).toEqual(['2000']); // suspect never reaches candles/signal

    await settle();
    const good = JSON.parse((await t.redis.get('px:good:ETH-USD'))!);
    expect(good.price).toBe('2000'); // last good price untouched by the suspect tick
    expect(JSON.parse((await t.redis.get('px:ETH-USD'))!).suspect).toBe(true);
    expect(Number(await t.redis.get('suspect:count'))).toBe(1);

    const health = await t.app.inject({ url: '/health/providers' });
    expect(health.json().suspectTicks.total).toBe(1);
  });

  it('coingecko is never used as a cross-check (too stale to judge a fast market)', () => {
    let now = 5_000_000;
    const p = new TickPipeline(t.rt, () => {}, () => now);
    p.handle(tick('coingecko', 1000)); // lagging aggregator price
    now += 20_000;
    expect(p.handle(tick('coinbase-ws', 2000))?.suspect).toBe(false);
  });
});

describe('candle aggregator', () => {
  let t: TestContext;
  beforeAll(async () => (t = await createTestContext()));
  afterAll(() => t.close());

  it('builds 1m candles from ticks and keeps every rollup interval current, idempotently', async () => {
    const t0 = D('2026-09-19T12:00:10Z');
    const agg = new CandleAggregator(t.rt, () => t0 + 130_000);
    const mk = (offset: number, price: number, size = 1): Tick => ({ instrument: 'ETH-USD', price: new Decimal(price), size: new Decimal(size), ts: t0 + offset, source: 'coinbase-ws', suspect: false });
    // minute 12:00 gets :10 :20 :40 :50; minute 12:01 gets 12:01:05 and 12:01:40
    for (const x of [mk(0, 100), mk(10_000, 105), mk(30_000, 98), mk(40_000, 101), mk(55_000, 102), mk(90_000, 110, 2)]) agg.onTick(x);
    await agg.flush();
    await agg.flush(); // second flush with nothing dirty must not duplicate or change anything

    const m1 = await loadRange(t.db, 'ETH-USD', '1m', D('2026-09-19T12:00:00Z'), D('2026-09-19T12:03:00Z'));
    expect(m1).toHaveLength(2);
    expect(m1[0]).toMatchObject({ o: '100', h: '105', l: '98', c: '101', v: '4' });
    expect(m1[1]).toMatchObject({ o: '102', h: '110', l: '102', c: '110', v: '3' });

    for (const [interval, start] of [['5m', '12:00'], ['15m', '12:00'], ['1h', '12:00'], ['4h', '12:00'], ['1d', '00:00']] as Array<[Interval, string]>) {
      const rows = await loadRange(t.db, 'ETH-USD', interval, D(`2026-09-19T${start}:00Z`), D(`2026-09-19T${start}:00Z`) + INTERVALS[interval]);
      expect(rows, interval).toHaveLength(1);
      expect(rows[0], interval).toMatchObject({ o: '100', h: '110', l: '98', c: '110', v: '7' });
    }
    expect(await countRange(t.db, 'ETH-USD', '1m', 0, Date.now())).toBe(2);
  });

  it('publishes forming candles on the candles channel', async () => {
    const seen: string[] = [];
    const sub = t.redis.duplicate();
    await sub.subscribe('ch:candles:BTC-USD:1m');
    sub.on('message', (_ch: string, m: string) => seen.push(m));
    const now = Date.now();
    const agg = new CandleAggregator(t.rt, () => now);
    agg.onTick({ instrument: 'BTC-USD', price: new Decimal(80000), ts: now, source: 'coinbase-ws', suspect: false });
    await agg.flush();
    await new Promise((r) => setTimeout(r, 30));
    const env = JSON.parse(seen[0]!);
    expect(env.data).toMatchObject({ symbol: 'BTC-USD', interval: '1m', closed: false });
    expect(env.data.candle.c).toBe('80000');
    sub.disconnect();
  });
});

/** Fake providers that synthesise one candle per bucket, recording calls. */
function fakeProviders(now: number) {
  const calls: string[] = [];
  const gen = (interval: Interval, from: number, to: number): Candle[] => {
    const step = INTERVALS[interval];
    const out: Candle[] = [];
    for (let ts = Math.ceil(from / step) * step; ts < to; ts += step) out.push({ t: ts, o: '10', h: '12', l: '9', c: '11', v: '1', source: 'fake' });
    return out;
  };
  const p = {
    rest: { candles: async (_p: string, i: Interval, f: number, to: number) => (calls.push(`rest:${i}`), gen(i, f, Math.min(to, bucketStart(now, '1m')))) },
    advanced: { candles: async () => Promise.reject(new Error('unused')) },
  } as unknown as CandleProviders;
  return { p, calls };
}

describe('backfill + gap repair', () => {
  let t: TestContext;
  beforeAll(async () => (t = await createTestContext()));
  afterAll(() => t.close());
  const now = D('2026-09-19T13:30:30Z');

  it('backfills 1m/1h/1d windows, derives 5m/15m/4h, and skips windows already covered', async () => {
    const { p, calls } = fakeProviders(now);
    await backfillInstrument(t.db, p, 'ETH-USD', 'ETH-USD', t.rt.logger, now);
    const end = bucketStart(now, '1m');
    for (const { interval, spanMs } of BACKFILL_PLAN) {
      const n = await countRange(t.db, 'ETH-USD', interval, bucketStart(now - spanMs, interval), end);
      expect(n, interval).toBeGreaterThan(spanMs / INTERVALS[interval] * 0.98);
    }
    expect(await countRange(t.db, 'ETH-USD', '5m', now - 7 * DAY, end)).toBeGreaterThan(2000);
    expect(await countRange(t.db, 'ETH-USD', '4h', now - 300 * DAY, end)).toBeGreaterThan(1700); // built from 1h, not fetched
    expect(calls.some((x) => x === 'rest:4h')).toBe(false);

    const before = calls.length;
    await backfillInstrument(t.db, p, 'ETH-USD', 'ETH-USD', t.rt.logger, now);
    expect(calls.length).toBe(before); // idempotent second run: nothing refetched
  }, 120_000);

  it('detects a missing minute and repairs it from REST', async () => {
    const hole = bucketStart(now - 10 * 60_000, '1m');
    await t.db.delete(candlesTable).where(eq(candlesTable.openTime, new Date(hole)));
    expect(await countRange(t.db, 'ETH-USD', '1m', hole, hole + 60_000)).toBe(0);
    const { p } = fakeProviders(now);
    expect(await reconcileRecent(t.db, p, 'ETH-USD', 'ETH-USD', t.rt.logger, now)).toBe(1);
    expect(await countRange(t.db, 'ETH-USD', '1m', hole, hole + 60_000)).toBe(1);
  }, 60_000);

  it('upserts are idempotent (unique key instrument+interval+open_time)', async () => {
    const row = c(D('2020-01-01T00:00:00Z'), 1, 2, 0.5, 1.5);
    await upsertCandles(t.db, 'SOL-USD', '1d', [row]);
    await upsertCandles(t.db, 'SOL-USD', '1d', [{ ...row, c: '1.9' }]);
    const rows = await loadRange(t.db, 'SOL-USD', '1d', 0, Date.now());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.c).toBe('1.9');
  });
});

describe('market REST API', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
    const now = Date.now();
    const hourly: Candle[] = [];
    for (let i = 30; i >= 0; i--) hourly.push(c(bucketStart(now, '1h') - i * 3_600_000, 2500 + i, 2520 + i, 2490 + i, 2505 + i, 10));
    await upsertCandles(t.db, 'ETH-USD', '1h', hourly);
    const daily: Candle[] = [];
    for (let i = 400; i >= 0; i--) daily.push(c(bucketStart(now, '1d') - i * DAY, 2000, 2000 + (i === 200 ? 2000 : 100), 1500 - (i === 100 ? 500 : 0), 2000, 100));
    await upsertCandles(t.db, 'ETH-USD', '1d', daily);
    await upsertCandles(t.db, 'ETH-USD', '5m', [c(bucketStart(now, '5m') - 300_000, 1, 2, 1, 2)]);
    await t.redis.set('px:good:ETH-USD', JSON.stringify({ instrument: 'ETH-USD', price: '2530.5', ts: new Date().toISOString(), source: 'coinbase-ws', suspect: false }));
    await t.redis.set('mkt:ETH-USD', JSON.stringify({ marketCap: 3e11, rank: 2, circulatingSupply: 1.2e8, maxSupply: null, ath: 4956, volume24h: 1e10, updatedAt: new Date().toISOString() }));
  });
  afterAll(() => t.close());

  it('lists enabled instruments with asOf/mode/source', async () => {
    const r = (await t.app.inject({ url: '/api/v1/instruments' })).json();
    expect(r.instruments.map((i: { symbol: string }) => i.symbol)).toEqual(['ETH-USD', 'BTC-USD']);
    expect(r).toMatchObject({ mode: 'live', source: 'db' });
    expect(typeof r.asOf).toBe('string');
  });

  it('builds a full quote', async () => {
    const res = await t.app.inject({ url: '/api/v1/instruments/ETH-USD/quote' });
    expect(res.statusCode).toBe(200);
    const q = res.json().quote;
    expect(q.price).toBe('2530.5');
    expect(q.rank).toBe(2);
    expect(q.marketCap).toBe('300000000000');
    expect(q.allTimeHigh).toBe('4956'); // max(candle ATH 4000, coingecko ATH 4956)
    expect(q.high52w).toBe('4000'); // the i=200 spike is inside the 52w window
    expect(q.low52w).toBe('1000'); // i=100 dip
    expect(new Decimal(q.changePct24h).isFinite()).toBe(true);
    expect(q.previousClose).toBe('2000');
    expect(q.sources).toContain('coinbase-ws');
    expect(q.sources).toContain('coingecko');
  });

  it('404 for unknown/disabled instruments, 503 when no price yet, 400 for bad symbols', async () => {
    expect((await t.app.inject({ url: '/api/v1/instruments/DOGE-USD/quote' })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/v1/instruments/SOL-USD/quote' })).statusCode).toBe(404); // seeded but disabled
    const noData = await t.app.inject({ url: '/api/v1/instruments/BTC-USD/quote' });
    expect(noData.statusCode).toBe(503);
    expect(noData.json().error.code).toBe('unavailable');
    const bad = await t.app.inject({ url: '/api/v1/instruments/eth/quote' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_error');
  });

  it('candles: range tabs pick a sensible interval; explicit interval and limit are honoured', async () => {
    const byRange = async (range: string) => (await t.app.inject({ url: `/api/v1/instruments/ETH-USD/candles?range=${range}` })).json();
    expect((await byRange('1D')).interval).toBe('5m');
    expect((await byRange('1W')).interval).toBe('1h');
    expect((await byRange('3M')).interval).toBe('4h');
    expect((await byRange('1Y')).interval).toBe('1d');
    expect((await byRange('All')).interval).toBe('1d');

    const r = (await t.app.inject({ url: '/api/v1/instruments/ETH-USD/candles?interval=1h&limit=5' })).json();
    expect(r.candles).toHaveLength(5);
    expect(new Date(r.candles[0].t).getTime()).toBeLessThan(new Date(r.candles[4].t).getTime()); // ascending
    expect(r).toMatchObject({ mode: 'live', symbol: 'ETH-USD', interval: '1h' });
    expect(typeof r.candles[0].o).toBe('string'); // decimals as strings
  });
});

describe('WebSocket gateway', () => {
  let t: TestContext;
  let base: string;
  beforeAll(async () => {
    t = await createTestContext();
    base = (await t.listen()).replace('http', 'ws');
  });
  afterAll(() => t.close());

  const connect = async () => {
    const ws = new WebSocket(`${base}/ws`);
    const msgs: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only untyped wire messages
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once('open', r));
    return { ws, msgs };
  };
  const until = async (fn: () => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    if (!fn()) throw new Error('timeout waiting for condition');
  };

  it('sends a snapshot first, then updates with monotonic seq and mode', async () => {
    const { ws, msgs } = await connect();
    ws.send(JSON.stringify({ op: 'subscribe', channels: ['ticker:ETH-USD'] }));
    await until(() => msgs.length >= 1);
    expect(msgs[0]).toMatchObject({ channel: 'ticker:ETH-USD', type: 'snapshot', seq: 0, mode: 'live', data: null });

    const p = new TickPipeline(t.rt, () => {});
    p.handle({ instrument: 'ETH-USD', price: new Decimal(2600), ts: Date.now(), source: 'coinbase-ws' });
    await until(() => msgs.length >= 2);
    expect(msgs[1]).toMatchObject({ type: 'update', data: { symbol: 'ETH-USD', price: '2600' } });
    const seq1 = msgs[1].seq;

    // a late subscriber gets the latest state as its snapshot
    const late = await connect();
    late.ws.send(JSON.stringify({ op: 'subscribe', channels: ['ticker:ETH-USD'] }));
    await until(() => late.msgs.length >= 1);
    expect(late.msgs[0]).toMatchObject({ type: 'snapshot', seq: seq1, data: { price: '2600' } });
    ws.close();
    late.ws.close();
  });

  it('coalesces ticker bursts to ~4/s per client but always delivers the newest price', async () => {
    const { ws, msgs } = await connect();
    ws.send(JSON.stringify({ op: 'subscribe', channels: ['ticker:BTC-USD'] }));
    await until(() => msgs.length >= 1);
    const p = new TickPipeline(t.rt, () => {});
    for (let i = 1; i <= 30; i++) p.handle({ instrument: 'BTC-USD', price: new Decimal(80000 + i), ts: Date.now(), source: 'coinbase-ws' });
    await until(() => msgs.some((m) => m.data?.price === '80030'), 3000);
    const updates = msgs.filter((m) => m.type === 'update');
    expect(updates.length).toBeLessThan(10);
    ws.close();
  });

  it('rejects unknown, planned and private channels with typed errors; unsubscribe stops delivery', async () => {
    const { ws, msgs } = await connect();
    ws.send(JSON.stringify({ op: 'subscribe', channels: ['nope', 'orderbook:ETH-USD', 'me:orders'] }));
    await until(() => msgs.length >= 3);
    expect(msgs.map((m) => m.error.code)).toEqual(['unknown_channel', 'not_available', 'unauthorized']);

    ws.send('not json');
    await until(() => msgs.length >= 4);
    expect(msgs[3].error.code).toBe('bad_message');

    ws.send(JSON.stringify({ op: 'subscribe', channels: ['ticker:ETH-USD'] }));
    await until(() => msgs.length >= 5);
    ws.send(JSON.stringify({ op: 'unsubscribe', channels: ['ticker:ETH-USD'] }));
    await new Promise((r) => setTimeout(r, 30));
    const n = msgs.length;
    new TickPipeline(t.rt, () => {}).handle({ instrument: 'ETH-USD', price: new Decimal(1), ts: Date.now(), source: 'coinbase-ws' });
    await new Promise((r) => setTimeout(r, 300));
    expect(msgs.length).toBe(n);
    ws.close();
  });
});
