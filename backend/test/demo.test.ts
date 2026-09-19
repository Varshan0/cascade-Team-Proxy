import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startDemo, type DemoHandle } from '../src/demo/start';
import { accounts, alerts, fills, ledgerEntries, orders, positions, signalEvents } from '../src/shared/db/schema';
import { ledgerViolations } from '../src/shared/ledger';

/** Everything in this file runs the REAL no-Docker runtime: PGlite + ioredis-mock + LocalScheduler, offline simulator. */
let demo: DemoHandle;
let base: string;

beforeAll(async () => {
  demo = await startDemo({
    env: { DEMO_OFFLINE: 'true', PORT: '0', LOG_LEVEL: 'silent', NODE_ENV: 'test', SIM_DROPS_PER_DAY: '0' },
    dataDir: 'memory://',
  });
  base = demo.url!;
}, 120_000);
afterAll(async () => demo?.stop());

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only untyped JSON
};
const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (!(await fn()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  if (!(await fn())) throw new Error('timed out waiting for condition');
};

describe('npm run demo (no Docker) boots and serves', () => {
  it('is wired as a package script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.demo).toContain('tsx src/demo/main.ts');
    expect(pkg.scripts.demo).toContain('scripts/build-web.mjs'); // builds web/ before serving it
    expect(pkg.scripts.dev).toContain('src/api/index.ts'); // the Docker/production path is still there
    expect(pkg.dependencies['@electric-sql/pglite']).toBeDefined();
    expect(pkg.dependencies['ioredis-mock']).toBeDefined();
  });

  it('GET /health/ready over a real socket returns 200', async () => {
    const { status, body } = await get('/health/ready');
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.checks).toMatchObject({ db: 'ok', redis: 'ok' });
  });

  it('runs migrations automatically and seeds instruments', async () => {
    const { body } = await get('/api/v1/instruments');
    expect(body.instruments.map((i: { symbol: string }) => i.symbol)).toEqual(['ETH-USD', 'BTC-USD']);
    expect(body.mode).toBe('offline');
  });

  it('offline mode serves full market data from the simulator (no internet needed)', async () => {
    // history makes the quote available immediately; wait for the first live simulator tick to be the price source
    await until(async () => (await get('/api/v1/instruments/ETH-USD/quote')).body.quote?.sources?.includes('simulator'));
    const q = (await get('/api/v1/instruments/ETH-USD/quote')).body;
    expect(q.mode).toBe('offline');
    expect(Number(q.quote.price)).toBeGreaterThan(100);
    expect(q.quote.high52w).not.toBeNull();
    expect(q.quote.sources).toContain('simulator');

    const week = (await get('/api/v1/instruments/ETH-USD/candles?range=1W')).body;
    expect(week.interval).toBe('1h');
    expect(week.candles.length).toBeGreaterThan(150);
    const month = (await get('/api/v1/instruments/ETH-USD/candles?range=1M')).body;
    expect(month.interval).toBe('4h');
    expect(month.candles.length).toBeGreaterThan(100);
    expect((await get('/api/v1/instruments/BTC-USD/quote')).status).toBe(200);
  });

  it('serves simulated liquidations and an oracle that lags the fast price', async () => {
    const stats = (await get('/api/v1/liquidations/stats?window=7d')).body;
    expect(stats.count).toBeGreaterThan(100);
    expect(stats.topAssets[0].symbol).toBe('WETH');
    await until(async () => (await get('/api/v1/oracle/ETH-USD')).status === 200);
    const o = (await get('/api/v1/oracle/ETH-USD')).body;
    expect(o.oracle.chainlinkPrice).toMatch(/^\d/);
    expect(o.mode).toBe('offline');
    // provider health is published every 5s
    // a tracker is 'unknown' until its first call is recorded, so wait for 'ok' rather than for presence
    await until(async () => (await get('/health/providers')).body.providers.some((p: { name: string; status: string }) => p.name === 'simulator' && p.status === 'ok'), 20_000);
    const providers = (await get('/health/providers')).body;
    expect(providers.providers.find((p: { name: string }) => p.name === 'simulator').status).toBe('ok');
  });

  it('the signal engine warms up immediately because the simulator provides a full liquidation baseline', async () => {
    await until(async () => (await get('/api/v1/signals/state')).status === 200);
    const s = (await get('/api/v1/signals/state')).body;
    expect(s).toMatchObject({ mode: 'offline', synthetic: false, drillActive: false });
    expect(['watching', 'partial']).toContain(s.state.state);
    expect(s.state.thresholds).toEqual({ dropThresh: 0.04, zThresh: 3, minLiqUsd: 1_000_000 });
  });
});

describe('drill: synthetic crash on isolated state', () => {
  it('goes fired -> in_position -> watching, tags everything synthetic, never touches real accounts, then restores live state', async () => {
    const counts = async () => ({
      accounts: (await demo.rt.db.select({ n: sql<number>`count(*)::int` }).from(accounts))[0]!.n,
      ledger: (await demo.rt.db.select({ n: sql<number>`count(*)::int` }).from(ledgerEntries))[0]!.n,
      orders: (await demo.rt.db.select({ n: sql<number>`count(*)::int` }).from(orders))[0]!.n,
      fills: (await demo.rt.db.select({ n: sql<number>`count(*)::int` }).from(fills))[0]!.n,
      positions: (await demo.rt.db.select({ n: sql<number>`count(*)::int` }).from(positions))[0]!.n,
      alerts: (await demo.rt.db.select({ n: sql<number>`count(*)::int` }).from(alerts))[0]!.n,
      signalEvents: (await demo.rt.db.select({ n: sql<number>`count(*)::int` }).from(signalEvents))[0]!.n,
    });
    const before = await counts();
    const liveBefore = (await get('/api/v1/signals/state')).body.state;

    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const msgs: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only untyped wire messages
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ op: 'subscribe', channels: ['signal', 'ticker:ETH-USD', 'liquidations', 'candles:ETH-USD:1m'] }));
    await until(() => msgs.filter((m) => m.type === 'snapshot').length >= 4);
    expect(msgs.filter((m) => m.type === 'snapshot').every((m) => !m.synthetic)).toBe(true);

    const start = msgs.length;
    const res = await fetch(base + '/api/v1/demo/drill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speed: 20 }) });
    expect(res.status).toBe(202);
    const second = await fetch(base + '/api/v1/demo/drill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(second.status).toBe(409); // one drill at a time

    // while it runs, REST reports the synthetic state under mode "drill", and the service stays ready
    await until(async () => (await get('/api/v1/signals/state')).body.drillActive === true);
    const during = (await get('/api/v1/signals/state')).body;
    expect(during).toMatchObject({ mode: 'drill', synthetic: true, drillActive: true });
    expect((await get('/health/ready')).status).toBe(200);
    expect((await get('/api/v1/demo/status')).body.drillActive).toBe(true);

    await until(async () => (await get('/api/v1/demo/drill')).body.status === 'done', 30_000);
    const result = (await get('/api/v1/demo/drill')).body;

    // --- the strategy behaved: fired -> in_position -> watching
    const states: string[] = result.transitions.map((t: { state: string }) => t.state);
    const idx = (s: string, from = 0) => states.indexOf(s, from);
    const fired = idx('fired');
    expect(fired).toBeGreaterThanOrEqual(0);
    const inPos = idx('in_position', fired);
    expect(inPos).toBeGreaterThan(fired);
    expect(idx('watching', inPos)).toBeGreaterThan(inPos);
    expect(states[0]).toBe('watching'); // warm baseline from the first frame
    expect(result.trades.map((t: { type: string }) => t.type)).toEqual(['entry', 'exit']);
    expect(result.trades[1].reason).toBe('target'); // the rebound is what the strategy is built to catch
    expect(result.finalEquity).toBeGreaterThan(result.startEquity);

    // --- every drill message is synthetic and tagged; no live message leaked into the drill window
    await new Promise((r) => setTimeout(r, 150));
    const after = msgs.slice(start);
    const synthetic = after.filter((m) => m.synthetic);
    expect(synthetic.length).toBeGreaterThan(100);
    expect(synthetic.every((m) => m.mode === 'drill' && m.synthetic === true)).toBe(true);
    const first = after.findIndex((m) => m.synthetic);
    const last = after.length - 1 - [...after].reverse().findIndex((m) => m.synthetic);
    const leaked = after.slice(first, last + 1).filter((m) => !m.synthetic && ['ticker:ETH-USD', 'signal', 'liquidations', 'candles:ETH-USD:1m'].includes(m.channel) && m.type === 'update');
    expect(leaked).toEqual([]);
    const seen = new Set(after.filter((m) => m.synthetic).map((m) => m.channel));
    expect(seen).toEqual(new Set(['signal', 'ticker:ETH-USD', 'liquidations', 'candles:ETH-USD:1m']));
    const liqUsd = after.filter((m) => m.synthetic && m.channel === 'liquidations').reduce((a, m) => a + Number(m.data.event.usdValue), 0);
    expect(liqUsd).toBeCloseTo(40_000_000, -3); // ~$40M burst
    const crash = after.filter((m) => m.synthetic && m.channel === 'ticker:ETH-USD').map((m) => Number(m.data.price));
    expect(Math.min(...crash) / crash[0]!).toBeLessThan(0.94); // ~6.5% crash

    // --- live state is restored: fresh non-synthetic snapshots arrive when the drill ends
    await until(() => after.length !== msgs.length - start || msgs.slice(start).some((m) => m.type === 'snapshot' && !m.synthetic));
    const restored = msgs.slice(start).filter((m) => m.type === 'snapshot' && !m.synthetic);
    expect(restored.map((m) => m.channel)).toEqual(expect.arrayContaining(['signal', 'ticker:ETH-USD', 'liquidations']));
    expect(restored.every((m) => m.mode === 'offline')).toBe(true);
    const liveAfter = (await get('/api/v1/signals/state')).body;
    expect(liveAfter).toMatchObject({ mode: 'offline', synthetic: false, drillActive: false });
    expect(liveAfter.state.state).toBe(liveBefore.state); // live engine never left its state

    // --- isolation: no real account, ledger, order or signal history was written
    expect(await counts()).toEqual(before);
    expect(await ledgerViolations(demo.rt.db)).toEqual([]);
    expect(await demo.rt.redis.keys('snapdrill:*')).toEqual([]); // drill snapshots cleaned up
    expect(await demo.rt.redis.get('drill:active')).toBeNull();
    ws.close();
  }, 90_000);

  it('the drill is repeatable', async () => {
    const res = await fetch(base + '/api/v1/demo/drill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speed: 200 }) });
    expect(res.status).toBe(202);
    await until(async () => {
      const s = (await get('/api/v1/demo/drill')).body;
      return s.status === 'done' && s.id !== undefined;
    }, 30_000);
    const r = (await get('/api/v1/demo/drill')).body;
    expect(r.trades).toHaveLength(2);
  }, 60_000);
});
