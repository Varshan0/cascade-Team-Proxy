import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthTracker, evaluateChains, publishHealth } from '../src/shared/providers/health';
import { loadConfig } from '../src/shared/config';
import { createTestContext, type TestContext } from './helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());

describe('health routes', () => {
  it('GET /health is live and echoes a request id', async () => {
    const res = await t.app.inject({ url: '/health', headers: { 'x-request-id': 'abc-123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('GET /health/ready is ready when DB and Redis are up and no chain is down', async () => {
    const res = await t.app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.db).toBe('ok');
    expect(res.json().checks.redis).toBe('ok');
  });

  it('GET /health/ready is 503 when a whole failover chain is down', async () => {
    const dead = new HealthTracker('chainlink-rpc');
    for (let i = 0; i < 5; i++) dead.recordError(new Error('boom'));
    await publishHealth(t.redis, [dead]);
    const res = await t.app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().chains.oraclePrice.status).toBe('down');
    await t.redis.del('health:providers');
  });

  it('GET /health/providers lists published provider status', async () => {
    const ok = new HealthTracker('coinbase-rest');
    ok.recordSuccess(120);
    ok.recordSuccess(80);
    await publishHealth(t.redis, [ok]);
    const body = (await t.app.inject({ url: '/health/providers' })).json();
    const p = body.providers.find((x: { name: string }) => x.name === 'coinbase-rest');
    expect(p.status).toBe('ok');
    expect(p.p95LatencyMs).toBe(120);
    expect(body.chains.candles.status).toBe('ok');
  });

  it('unknown routes use the consistent error shape', async () => {
    const res = await t.app.inject({ url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('serves OpenAPI docs', async () => {
    const res = await t.app.inject({ url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/health/providers');
  });
});

describe('health tracker', () => {
  it('degraded while failures are intermittent, down only when the latest calls all fail; open circuit forces down', () => {
    const h = new HealthTracker('x');
    expect(h.snapshot().status).toBe('unknown');
    for (let i = 0; i < 9; i++) h.recordSuccess(10);
    h.recordError(new Error('e'));
    expect(h.snapshot().status).toBe('degraded');
    // a flaky endpoint failing half the time is still serving traffic: degraded, not down
    for (let i = 0; i < 10; i++) {
      if (i % 2) h.recordSuccess(10);
      else h.recordError(new Error('e'));
    }
    expect(h.snapshot().status).toBe('degraded');
    for (let i = 0; i < 3; i++) h.recordError(new Error('e'));
    expect(h.snapshot().status).toBe('down'); // the latest 3 calls all failed
    h.recordSuccess(10);
    expect(h.snapshot().status).toBe('degraded'); // recovers as soon as it answers
    h.circuit = 'open';
    expect(h.snapshot().status).toBe('down');
  });

  it('chain evaluation: any ok provider keeps the chain ok', () => {
    const chains = evaluateChains(
      [
        { name: 'a', status: 'down' },
        { name: 'b', status: 'ok' },
      ].map((p) => ({ ...p, circuit: 'closed', lastSuccess: null, lastError: null, lastErrorMessage: null, p95LatencyMs: null, successCount: 0, errorCount: 0, quotaRemaining: null })) as never,
      { test: ['a', 'b'] },
    );
    expect(chains.test?.status).toBe('ok');
  });
});

describe('config', () => {
  it('treats empty optional keys as unset and parses csv lists', () => {
    const cfg = loadConfig({ PYTH_API_KEY: '', RPC_URLS: 'https://a, https://b', DEMO_OFFLINE: 'true' });
    expect(cfg.PYTH_API_KEY).toBeUndefined();
    expect(cfg.RPC_URLS).toEqual(['https://a', 'https://b']);
    expect(cfg.DEMO_OFFLINE).toBe(true);
  });

  it('fails loudly on invalid env', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });
});
