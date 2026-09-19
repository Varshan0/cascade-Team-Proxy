/**
 * Builds web-contract/ from a RUNNING `npm run demo:offline`:
 *   npx tsx scripts/capture-web-contract.ts [baseUrl] [wsSeconds]
 * Everything under web-contract/fixtures and web-contract/ws-samples is captured from the live process;
 * api.md is generated from the exported OpenAPI plus those captured responses.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'http://localhost:8080';
const WS_SECONDS = Number(process.argv[3] ?? 120);
const OUT = 'web-contract';
const FIX = join(OUT, 'fixtures');
const WSS = join(OUT, 'ws-samples');
for (const d of [OUT, FIX, WSS, join(WSS, 'drill')]) mkdirSync(d, { recursive: true });

const write = (path: string, data: unknown) => writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}

// ------------------------------------------------------------------ 1. openapi.json
const openapi = (await http('GET', '/docs/json')).json;
write(join(OUT, 'openapi.json'), openapi);
console.log('openapi.json:', Object.keys(openapi.paths).length, 'paths');

// ------------------------------------------------------------------ 2. REST fixtures (live offline demo)
const FIXTURES: Array<[string, string]> = [
  ['health', '/health'],
  ['health-ready', '/health/ready'],
  ['health-providers', '/health/providers'],
  ['instruments', '/api/v1/instruments'],
  ['quote-ETH-USD', '/api/v1/instruments/ETH-USD/quote'],
  ['quote-BTC-USD', '/api/v1/instruments/BTC-USD/quote'],
  ['candles-5m', '/api/v1/instruments/ETH-USD/candles?interval=5m&limit=30'],
  ['candles-1h', '/api/v1/instruments/ETH-USD/candles?interval=1h&limit=30'],
  ['candles-1d', '/api/v1/instruments/ETH-USD/candles?interval=1d&limit=30'],
  ['candles-range-1D', '/api/v1/instruments/ETH-USD/candles?range=1D&limit=12'],
  ['liquidations', '/api/v1/liquidations?limit=10'],
  ['liquidations-page2', '__page2__'],
  ['liquidations-stats-1h', '/api/v1/liquidations/stats?window=1h'],
  ['liquidations-stats-24h', '/api/v1/liquidations/stats?window=24h'],
  ['liquidations-stats-7d', '/api/v1/liquidations/stats?window=7d'],
  ['oracle-ETH-USD', '/api/v1/oracle/ETH-USD'],
  ['oracle-BTC-USD', '/api/v1/oracle/BTC-USD'],
  ['signal-state', '/api/v1/signals/state'],
  ['signal-history', '/api/v1/signals/history?limit=20'],
  ['signal-bot', '/api/v1/signals/bot'],
  ['demo-status', '/api/v1/demo/status'],
  ['error-404-unknown-instrument', '/api/v1/instruments/DOGE-USD/quote'],
  ['error-400-validation', '/api/v1/instruments/eth/quote'],
  ['error-404-no-route', '/api/v1/nope'],
];
let page1: { nextCursor?: string } = {};
for (const [name, path] of FIXTURES) {
  let p = path;
  if (path === '__page2__') {
    if (!page1.nextCursor) continue;
    p = `/api/v1/liquidations?limit=10&cursor=${page1.nextCursor}`;
  }
  const r = await http('GET', p);
  if (name === 'liquidations') page1 = r.json;
  write(join(FIX, `${name}.json`), r.json);
  console.log(`fixture ${name} -> HTTP ${r.status}`);
}

// ------------------------------------------------------------------ 3. WebSocket samples (live offline demo)
const LIVE_CHANNELS = [
  'ticker:ETH-USD', 'ticker:BTC-USD',
  'candles:ETH-USD:1m', 'candles:ETH-USD:5m', 'candles:ETH-USD:15m', 'candles:ETH-USD:1h', 'candles:ETH-USD:4h', 'candles:ETH-USD:1d',
  'candles:BTC-USD:1m',
  'liquidations', 'oracle:ETH-USD', 'oracle:BTC-USD', 'signal',
];
type Rec = { t: number; msg: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- recorded wire messages are opaque here
const fileFor = (channel: string) => channel.replace(/:/g, '_');

async function record(channels: string[], ms: number, until?: () => boolean): Promise<Rec[]> {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const recs: Rec[] = [];
  const t0 = Date.now();
  ws.on('message', (m) => recs.push({ t: Date.now() - t0, msg: JSON.parse(String(m)) }));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ op: 'subscribe', channels }));
  while (Date.now() - t0 < ms && !(until && until())) await sleep(200);
  ws.close();
  return recs;
}
const ndjson = (recs: Rec[]) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

console.log(`recording ${WS_SECONDS}s of live WS traffic on ${LIVE_CHANNELS.length} channels...`);
const live = await record(LIVE_CHANNELS, WS_SECONDS * 1000);
for (const ch of LIVE_CHANNELS) {
  const rs = live.filter((r) => r.msg.channel === ch);
  write(join(WSS, `${fileFor(ch)}.ndjson`), ndjson(rs));
  console.log(`  ${ch}: ${rs.length} msgs (${rs.filter((r) => r.msg.type === 'update').length} updates)`);
}

// error samples: every error code the gateway can return
{
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const recs: Rec[] = [];
  const t0 = Date.now();
  ws.on('message', (m) => recs.push({ t: Date.now() - t0, msg: JSON.parse(String(m)) }));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ op: 'subscribe', channels: ['nope', 'orderbook:ETH-USD', 'me:orders'] }));
  ws.send('not json');
  await sleep(600);
  ws.close();
  write(join(WSS, 'errors.ndjson'), ndjson(recs));
}

// ------------------------------------------------------------------ 4. one full drill
console.log('recording a full drill (speed 1, ~40s)...');
const DRILL_CHANNELS = ['signal', 'ticker:ETH-USD', 'candles:ETH-USD:1m', 'liquidations', 'oracle:ETH-USD'];
let drillDone = false;
const drillPromise = record(DRILL_CHANNELS, 120_000, () => drillDone);
await sleep(1500); // let the snapshots arrive first
const start = await http('POST', '/api/v1/demo/drill', { speed: 1 });
write(join(FIX, 'drill-start.json'), start.json);
console.log('  POST /api/v1/demo/drill ->', start.status, JSON.stringify(start.json));
const second = await http('POST', '/api/v1/demo/drill', { speed: 1 });
write(join(FIX, 'error-409-drill-running.json'), second.json);
const midway: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
for (let i = 0; i < 400; i++) {
  await sleep(500);
  if (i === 6) write(join(FIX, 'signal-state-during-drill.json'), (await http('GET', '/api/v1/signals/state')).json);
  if (i === 8) write(join(FIX, 'demo-status-during-drill.json'), (await http('GET', '/api/v1/demo/status')).json);
  const s = (await http('GET', '/api/v1/demo/drill')).json;
  midway.push(s.status);
  if (s.status === 'done') {
    write(join(FIX, 'drill-result.json'), s);
    break;
  }
  if (i === 2) write(join(FIX, 'drill-running.json'), s);
}
await sleep(2500); // capture the "live state restored" snapshots that follow the drill
drillDone = true;
const drill = await drillPromise;
write(join(WSS, 'drill', 'all-channels.ndjson'), ndjson(drill));
for (const ch of DRILL_CHANNELS) write(join(WSS, 'drill', `${fileFor(ch)}.ndjson`), ndjson(drill.filter((r) => r.msg.channel === ch)));
write(join(FIX, 'signal-state-after-drill.json'), (await http('GET', '/api/v1/signals/state')).json);
console.log('  drill messages:', drill.length, '| synthetic:', drill.filter((r) => r.msg.synthetic).length);

console.log('capture complete');
