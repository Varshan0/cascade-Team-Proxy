import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CoinbaseAdvanced, CoinbaseRest } from '../src/shared/providers/coinbase';
import { CoinGecko } from '../src/shared/providers/coingecko';
import { ChainExhaustedError, runChain } from '../src/shared/providers/failover';
import { CircuitBreaker, CircuitOpenError, ResilientHttp, TokenBucket, type ProviderError } from '../src/shared/providers/resilient';
import type { Redis } from '../src/shared/redis';
import { fakeFetch, fixture } from './helpers';

const okSchema = z.object({ ok: z.literal(true) });
const noSleep = async () => {};
const http = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof ResilientHttp>[0]> = {}) =>
  new ResilientHttp({ name: 't', baseUrl: 'https://x.test', bucket: { capacity: 100, refillPerSec: 100 }, fetchImpl: f, sleep: noSleep, random: () => 0.5, ...extra });

describe('ResilientHttp', () => {
  it('retries 429 and 5xx then succeeds, honouring Retry-After', async () => {
    const f = fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 503 }, { body: { ok: true } }]);
    const sleeps: number[] = [];
    const c = http(f.fetch, { sleep: async (ms) => void sleeps.push(ms) });
    await expect(c.getJson('/a', { schema: okSchema })).resolves.toEqual({ ok: true });
    expect(f.calls).toHaveLength(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000); // Retry-After wins over jitter
    expect(c.health().status).toBe('ok');
  });

  it('gives up after 3 retries and records the failure', async () => {
    const f = fakeFetch([{ status: 500 }]);
    const c = http(f.fetch);
    await expect(c.getJson('/a', { schema: okSchema })).rejects.toThrow(/HTTP 500/);
    expect(f.calls).toHaveLength(4); // 1 try + 3 retries
    expect(c.health().errorCount).toBe(1);
  });

  it('does not retry non-retryable 4xx', async () => {
    const f = fakeFetch([{ status: 404 }]);
    await expect(http(f.fetch).getJson('/a', { schema: okSchema })).rejects.toMatchObject({ retryable: false, status: 404 } satisfies Partial<ProviderError>);
    expect(f.calls).toHaveLength(1);
  });

  it('retries network errors', async () => {
    const f = fakeFetch([{ throws: new Error('ECONNRESET') }, { body: { ok: true } }]);
    await expect(http(f.fetch).getJson('/a', { schema: okSchema })).resolves.toEqual({ ok: true });
  });

  it('treats a response that fails Zod validation as a provider failure', async () => {
    const f = fakeFetch([{ body: { ok: false } }]);
    const c = http(f.fetch);
    await expect(c.getJson('/a', { schema: okSchema })).rejects.toThrow(/validation failed/);
    expect(c.health().errorCount).toBe(1);
  });

  it('serves from the Redis cache within TTL without calling the provider', async () => {
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const f = fakeFetch([{ body: { ok: true } }]);
    const c = http(f.fetch, { redis });
    await c.getJson('/a', { schema: okSchema, ttlSec: 30 });
    await c.getJson('/a', { schema: okSchema, ttlSec: 30 });
    expect(f.calls).toHaveLength(1);
  });

  it('opens the circuit after 5 consecutive failures and fails fast, then recovers half-open', async () => {
    let t = 0;
    const f = fakeFetch([{ status: 400 }, { status: 400 }, { status: 400 }, { status: 400 }, { status: 400 }, { body: { ok: true } }]);
    const c = http(f.fetch, { now: () => t });
    for (let i = 0; i < 5; i++) await c.getJson('/a', { schema: okSchema }).catch(() => {});
    expect(c.health().circuit).toBe('open');
    expect(c.health().status).toBe('down');
    const before = f.calls.length;
    await expect(c.getJson('/a', { schema: okSchema })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(f.calls.length).toBe(before); // failed fast, no network
    t = 30_001;
    await expect(c.getJson('/a', { schema: okSchema })).resolves.toEqual({ ok: true });
    expect(c.health().circuit).toBe('closed');
  });
});

describe('CircuitBreaker / TokenBucket', () => {
  it('half-open allows exactly one probe', () => {
    let t = 0;
    const b = new CircuitBreaker(2, 1000, () => t);
    b.failure();
    b.failure();
    expect(b.allow()).toBe(false);
    t = 1000;
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false);
    b.failure(); // failed probe re-opens
    expect(b.state).toBe('open');
  });

  it('token bucket delays instead of rejecting when empty', async () => {
    const b = new TokenBucket(1, 50);
    const t0 = Date.now();
    await b.take();
    await b.take();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });
});

describe('recorded provider fixtures', () => {
  it('coinbase-rest parses real candles (newest-first, [t,low,high,open,close,vol])', async () => {
    const rows = fixture<number[][]>('coinbase-candles-1h.json');
    const f = fakeFetch([{ body: rows }]);
    const p = new CoinbaseRest({ fetchImpl: f.fetch });
    const from = rows[rows.length - 1]![0]! * 1000;
    const to = rows[0]![0]! * 1000 + 3_600_000;
    const cs = await p.candles('ETH-USD', '1h', from, to);
    expect(cs).toHaveLength(rows.length);
    expect(cs[0]!.t).toBeLessThan(cs[1]!.t); // returned ascending
    const oldest = rows[rows.length - 1]!;
    expect(cs[0]).toMatchObject({ o: String(oldest[3]), h: String(oldest[2]), l: String(oldest[1]), c: String(oldest[4]) });
  });

  it('coinbase-rest parses the ticker', async () => {
    const p = new CoinbaseRest({ fetchImpl: fakeFetch([{ body: fixture('coinbase-ticker.json') }]).fetch });
    const t = await p.ticker('ETH-USD');
    expect(t.price.toNumber()).toBeGreaterThan(0);
    expect(Number.isFinite(t.ts)).toBe(true);
  });

  it('coinbase-advanced parses the public candle shape', async () => {
    const body = fixture<{ candles: Array<{ start: string }> }>('coinbase-advanced-1h.json');
    const p = new CoinbaseAdvanced({ fetchImpl: fakeFetch([{ body }]).fetch });
    const starts = body.candles.map((c) => Number(c.start) * 1000);
    const cs = await p.candles('ETH-USD', '1h', Math.min(...starts), Math.max(...starts) + 3_600_000);
    expect(cs).toHaveLength(body.candles.length);
  });

  it('coingecko parses markets', async () => {
    const p = new CoinGecko({ fetchImpl: fakeFetch([{ body: fixture('coingecko-markets.json') }]).fetch });
    const [m] = await p.markets(['ethereum']);
    expect(m!.id).toBe('ethereum');
    expect(m!.current_price).toBeGreaterThan(0);
  });

  it('a changed candle shape fails loudly instead of leaking bad data', async () => {
    const p = new CoinbaseRest({ fetchImpl: fakeFetch([{ body: { candles: 'nope' } }]).fetch });
    await expect(p.candles('ETH-USD', '1h', 0, 3_600_000)).rejects.toThrow(/validation failed/);
    expect(p.health().errorCount).toBe(1);
  });
});

describe('failover chains', () => {
  it('primary throws -> fallback answers, and health shows the primary degraded', async () => {
    const good = fixture<number[][]>('coinbase-candles-1h.json');
    // primary: one success then failures; advanced always ok
    const primaryFetch = fakeFetch([{ body: good }, { status: 500 }]);
    const primary = new CoinbaseRest({ fetchImpl: primaryFetch.fetch });
    const advancedBody = fixture('coinbase-advanced-1h.json');
    const fallback = new CoinbaseAdvanced({ fetchImpl: fakeFetch([{ body: advancedBody }]).fetch });
    const from = good[good.length - 1]![0]! * 1000;
    const to = good[0]![0]! * 1000 + 3_600_000;
    const advStarts = (advancedBody as { candles: Array<{ start: string }> }).candles.map((c) => Number(c.start) * 1000);

    await primary.candles('ETH-USD', '1h', from, to); // success first
    const res = await runChain('candles', [
      { name: 'coinbase-rest', run: () => primary.candles('ETH-USD', '1h', from, to) },
      { name: 'coinbase-advanced', run: () => fallback.candles('ETH-USD', '1h', Math.min(...advStarts), Math.max(...advStarts) + 1) },
    ]);
    expect(res.source).toBe('coinbase-advanced');
    expect(primary.health().status).toBe('degraded');
    expect(fallback.health().status).toBe('ok');
  });

  it('chain order comes from config, not caller order; disabled providers are skipped', async () => {
    const order: string[] = [];
    const res = await runChain('candles', [
      { name: 'coinbase-advanced', run: async () => (order.push('advanced'), 'A') },
      { name: 'coinbase-rest', run: async () => (order.push('rest'), Promise.reject(new Error('down'))) },
    ]);
    expect(order).toEqual(['rest', 'advanced']);
    expect(res).toEqual({ value: 'A', source: 'coinbase-advanced' });
  });

  it('throws a descriptive error when every provider fails', async () => {
    await expect(runChain('candles', [{ name: 'coinbase-rest', run: () => Promise.reject(new Error('x')) }])).rejects.toBeInstanceOf(ChainExhaustedError);
  });
});
