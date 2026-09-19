import Decimal from 'decimal.js';
import { z } from 'zod';
import type { Candle } from '../market/candles';
import type { Redis } from '../redis';
import { INTERVALS, type Interval } from '../time';
import type { ProviderHealth } from './health';
import { ResilientHttp, type ProviderClient } from './resilient';

/** Granularities Coinbase Exchange serves natively. There is no 4h: it is built from 1h. */
export const EXCHANGE_GRANULARITY: Partial<Record<Interval, number>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};

const MAX_CANDLES = 300;

const tickerSchema = z.object({
  price: z.string(),
  time: z.string(),
  size: z.string().optional(),
  bid: z.string().optional(),
  ask: z.string().optional(),
});

// [time(s), low, high, open, close, volume], newest first (verified live 2026-09-19).
const candlesSchema = z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]));

export interface RestTick {
  price: Decimal;
  ts: number;
  bid?: string;
  ask?: string;
}

export type CoinbaseReq =
  | { kind: 'ticker'; product: string }
  | { kind: 'candles'; product: string; interval: Interval; from: number; to: number };

export type CoinbaseRes = RestTick | Candle[];

/** Coinbase Exchange public REST. Works without auth today even though the docs page says otherwise. */
export class CoinbaseRest implements ProviderClient<CoinbaseReq, CoinbaseRes> {
  readonly name = 'coinbase-rest';
  private http: ResilientHttp;

  constructor(opts: { redis?: Redis; fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
    this.http = new ResilientHttp({
      name: this.name,
      baseUrl: opts.baseUrl ?? 'https://api.exchange.coinbase.com',
      // Public limit not documented on the pages fetched: stay conservative.
      bucket: { capacity: 8, refillPerSec: 5 },
      redis: opts.redis,
      fetchImpl: opts.fetchImpl,
    });
  }

  health(): ProviderHealth {
    return this.http.health();
  }
  get tracker() {
    return this.http.tracker;
  }

  call(req: CoinbaseReq): Promise<CoinbaseRes> {
    return req.kind === 'ticker' ? this.ticker(req.product) : this.candles(req.product, req.interval, req.from, req.to);
  }

  async ticker(product: string): Promise<RestTick> {
    const r = await this.http.getJson(`/products/${product}/ticker`, { schema: tickerSchema, ttlSec: 2 });
    return { price: new Decimal(r.price), ts: Date.parse(r.time), bid: r.bid, ask: r.ask };
  }

  /** Candles with open time in [from, to) (ms). Caller keeps `to - from <= 300 * granularity`. */
  async candles(product: string, interval: Interval, from: number, to: number): Promise<Candle[]> {
    const g = EXCHANGE_GRANULARITY[interval];
    if (!g) throw new Error(`coinbase-rest has no ${interval} granularity`);
    if ((to - from) / 1000 / g > MAX_CANDLES) throw new Error('range exceeds 300 candles');
    const rows = await this.http.getJson(`/products/${product}/candles`, {
      query: { granularity: g, start: new Date(from).toISOString(), end: new Date(to).toISOString() },
      schema: candlesSchema,
      ttlSec: interval === '1m' ? 5 : 300,
      timeoutMs: 20_000,
    });
    return rows
      .map(([t, low, high, open, close, volume]) => ({
        t: t * 1000,
        o: String(open),
        h: String(high),
        l: String(low),
        c: String(close),
        v: String(volume),
        source: this.name,
      }))
      .filter((c) => c.t >= from && c.t < to)
      .sort((a, b) => a.t - b.t);
  }
}

const advancedSchema = z.object({
  candles: z.array(z.object({ start: z.string(), low: z.string(), high: z.string(), open: z.string(), close: z.string(), volume: z.string() })),
});

const ADVANCED_GRANULARITY: Partial<Record<Interval, string>> = { '1m': 'ONE_MINUTE', '1h': 'ONE_HOUR', '1d': 'ONE_DAY' };

/** Coinbase Advanced Trade public market data: second candle source (verified live for 1m/1h/1d, 2026-09-19). */
export class CoinbaseAdvanced {
  readonly name = 'coinbase-advanced';
  private http: ResilientHttp;

  constructor(opts: { redis?: Redis; fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
    this.http = new ResilientHttp({
      name: this.name,
      baseUrl: opts.baseUrl ?? 'https://api.coinbase.com',
      bucket: { capacity: 5, refillPerSec: 3 },
      redis: opts.redis,
      fetchImpl: opts.fetchImpl,
    });
  }

  health(): ProviderHealth {
    return this.http.health();
  }
  get tracker() {
    return this.http.tracker;
  }

  async candles(product: string, interval: Interval, from: number, to: number): Promise<Candle[]> {
    const g = ADVANCED_GRANULARITY[interval];
    if (!g) throw new Error(`coinbase-advanced has no ${interval} granularity`);
    if ((to - from) / INTERVALS[interval] > 300) throw new Error('range exceeds 300 candles');
    const r = await this.http.getJson(`/api/v3/brokerage/market/products/${product}/candles`, {
      query: { start: Math.floor(from / 1000), end: Math.floor(to / 1000), granularity: g },
      schema: advancedSchema,
      ttlSec: interval === '1m' ? 5 : 300,
      timeoutMs: 20_000,
    });
    return r.candles
      .map((c) => ({ t: Number(c.start) * 1000, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, source: this.name }))
      .filter((c) => c.t >= from && c.t < to)
      .sort((a, b) => a.t - b.t);
  }
}
