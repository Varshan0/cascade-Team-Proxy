/**
 * Second half of the web-contract build (run after capture-web-contract.ts):
 *   npx tsx scripts/build-web-contract-docs.ts
 * Generates api.md (from openapi.json + captured fixtures), ws.md (from the recorded WS samples),
 * the bot-with-trades fixture (test harness, clearly labelled) and the README files.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import RedisMock from 'ioredis-mock';
import { buildApp } from '../src/api/app';
import { loadConfig } from '../src/shared/config';
import type { Db } from '../src/shared/db/client';
import { ensureInstruments } from '../src/shared/db/seed-base';
import * as schema from '../src/shared/db/schema';
import { createLogger } from '../src/shared/logger';
import type { Redis } from '../src/shared/redis';
import { LocalScheduler, type Runtime } from '../src/shared/runtime';
import { upsertCandles } from '../src/shared/market/store';
import { liquidations } from '../src/shared/db/schema';
import { COVERAGE_KEY, SignalEngine } from '../src/shared/strategy/engine';

const OUT = 'web-contract';
const FIX = join(OUT, 'fixtures');
const WSS = join(OUT, 'ws-samples');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const fixture = (name: string) => readJson(join(FIX, `${name}.json`));
const ndjson = (name: string): Array<{ t: number; msg: any }> => // eslint-disable-line @typescript-eslint/no-explicit-any -- recorded wire messages are opaque here
  readFileSync(join(WSS, name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Minimal in-memory harness (API + PGlite + ioredis-mock, no worker, no feeds). */
async function createTestContext() {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  const pg = new PGlite();
  const orm = drizzle(pg, { schema });
  await migrate(orm, { migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle') });
  const db = orm as unknown as Db;
  await ensureInstruments(db);
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  const logger = createLogger(config);
  const rt: Runtime = { config, db, redis, logger, scheduler: new LocalScheduler(logger), kind: 'demo' };
  const app = await buildApp(rt);
  await app.ready();
  return { app, db, redis, rt, close: async () => { await app.close(); await pg.close(); } };
}

// ------------------------------------------------------------------ bot fixture from a harness that forces a cascade
{
  const t = await createTestContext();
  const H = 3_600_000;
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
  await upsertCandles(t.db, 'ETH-USD', '1m', Array.from({ length: 180 }, (_, i) => ({ t: Math.floor(now / 60_000) * 60_000 - (i + 1) * 60_000, o: '2000', h: '2000', l: '2000', c: '2000', v: '1', source: 'harness' })));
  const rows = Array.from({ length: 170 }, (_, i) => ({ ts: new Date(now - H - i * H - 30 * 60_000), usd: 100_000 }));
  rows.push({ ts: new Date(now - 10 * 60_000), usd: 2_000_000 });
  await t.db.insert(liquidations).values(
    rows.map((r, i) => ({
      txHash: '0x' + (i + 1).toString(16).padStart(64, '0'), logIndex: 0, blockNumber: i + 1, blockHash: '0x' + 'f'.repeat(64), ts: r.ts,
      collateralAsset: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', debtAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      user: '0x' + '1'.repeat(40), liquidator: '0x' + '2'.repeat(40), debtAmountRaw: '1', collateralAmountRaw: '1', usdValue: String(r.usd), status: 'confirmed',
    })),
  );
  await t.redis.set(COVERAGE_KEY, String(now - 400 * H));
  const fast = (price: number) => t.redis.set('px:good:ETH-USD', JSON.stringify({ instrument: 'ETH-USD', price: String(price), ts: new Date(now).toISOString(), source: 'harness', suspect: false }));
  const engine = new SignalEngine(t.rt);
  await fast(1900);
  await engine.evaluate(now); // entry
  writeFileSync(join(FIX, 'signal-bot-in-position.json'), JSON.stringify((await t.app.inject({ url: '/api/v1/signals/bot' })).json(), null, 2) + '\n');
  await fast(1960);
  await engine.evaluate(now + 5 * 60_000); // exit at target
  writeFileSync(join(FIX, 'signal-bot-with-trades.json'), JSON.stringify((await t.app.inject({ url: '/api/v1/signals/bot' })).json(), null, 2) + '\n');
  await t.close();
}

// ------------------------------------------------------------------ api.md
const openapi = readJson(join(OUT, 'openapi.json'));

/** Which captured file is the example for each endpoint. */
const EXAMPLES: Record<string, Array<{ file: string; note?: string }>> = {
  'get /health': [{ file: 'health' }],
  'get /health/ready': [{ file: 'health-ready' }],
  'get /health/providers': [{ file: 'health-providers' }],
  'get /api/v1/instruments': [{ file: 'instruments' }],
  'get /api/v1/instruments/{symbol}/quote': [{ file: 'quote-ETH-USD' }, { file: 'error-404-unknown-instrument', note: 'unknown or disabled symbol → 404' }, { file: 'error-400-validation', note: 'malformed symbol → 400' }],
  'get /api/v1/instruments/{symbol}/candles': [
    { file: 'candles-1h', note: '`interval=1h&limit=30`' },
    { file: 'candles-5m', note: '`interval=5m&limit=30`' },
    { file: 'candles-1d', note: '`interval=1d&limit=30`' },
    { file: 'candles-range-1D', note: '`range=1D&limit=12` (interval auto-picked = 5m)' },
  ],
  'get /api/v1/liquidations': [{ file: 'liquidations' }, { file: 'liquidations-page2', note: 'next page via `cursor=<nextCursor>`' }],
  'get /api/v1/liquidations/stats': [{ file: 'liquidations-stats-24h', note: '`window=24h`' }, { file: 'liquidations-stats-1h', note: '`window=1h`' }, { file: 'liquidations-stats-7d', note: '`window=7d`' }],
  'get /api/v1/oracle/{symbol}': [{ file: 'oracle-ETH-USD' }, { file: 'oracle-BTC-USD' }],
  'get /api/v1/signals/state': [{ file: 'signal-state' }, { file: 'signal-state-during-drill', note: 'while a drill is running: `mode:"drill"`, `synthetic:true`' }],
  'get /api/v1/signals/history': [{ file: 'signal-history' }],
  'get /api/v1/signals/bot': [
    { file: 'signal-bot', note: 'from the live offline demo (the bot has not traded yet, so `trades` is empty)' },
    { file: 'signal-bot-in-position', note: 'HARNESS capture (forced cascade in a test harness, not the live demo): position open' },
    { file: 'signal-bot-with-trades', note: 'HARNESS capture: after a buy and a sell at target' },
  ],
  'get /api/v1/demo/status': [{ file: 'demo-status' }, { file: 'demo-status-during-drill' }],
  'post /api/v1/demo/drill': [{ file: 'drill-start', note: 'HTTP 202' }, { file: 'error-409-drill-running', note: 'a drill is already running → 409' }],
  'get /api/v1/demo/drill': [{ file: 'drill-running', note: 'while running' }, { file: 'drill-result', note: 'when finished' }],
};

const ORDER = ['/api/v1/instruments', '/api/v1/instruments/{symbol}/quote', '/api/v1/instruments/{symbol}/candles', '/api/v1/liquidations', '/api/v1/liquidations/stats', '/api/v1/oracle/{symbol}', '/api/v1/signals/state', '/api/v1/signals/history', '/api/v1/signals/bot', '/api/v1/demo/status', '/api/v1/demo/drill', '/health', '/health/ready', '/health/providers'];

/** Shorten long arrays for readability (the full response is in fixtures/). Returns the text and whether it shortened. */
function shorten(v: unknown, keep = 2): { v: unknown; cut: boolean } {
  let cut = false;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      if (x.length > keep) cut = true;
      return x.slice(0, keep).map(walk);
    }
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  return { v: walk(v), cut };
}

function paramType(s: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any -- OpenAPI schema is loosely typed
  if (s.enum) return s.enum.map((e: string) => `\`${e}\``).join(' \\| ');
  const bits = [s.type ?? (s.anyOf ? 'string' : 'any')];
  if (s.format) bits.push(s.format);
  if (s.minimum !== undefined) bits.push(`≥ ${s.minimum}`);
  if (s.maximum !== undefined) bits.push(`≤ ${s.maximum}`);
  if (s.pattern && s.format !== 'date-time') bits.push(`pattern \`${s.pattern}\``);
  if (s.format === 'date-time') bits.push('ISO-8601 with offset, e.g. `2026-09-19T00:00:00Z`');
  if (s.default !== undefined) bits.push(`default \`${JSON.stringify(s.default)}\``);
  return bits.join(', ');
}

let md = `# REST API

Generated from \`openapi.json\` (exported from the running backend) plus responses captured from \`npm run demo:offline\`.
Every example below is a **real response** (see \`fixtures/\`). Arrays are shortened to 2 items here; the fixture holds the full response.

## Conventions

- **Base URL:** \`http://localhost:8080\` (the backend's default port). All data endpoints are under \`/api/v1\`; health endpoints are at the root.
- **CORS:** allowed origin is \`http://localhost:5173\` by default (set by the backend's \`CORS_ORIGINS\`), with credentials.
- **Rate limit:** 300 requests/minute per client. Exceeding it returns HTTP 429 with the error shape below.
- **Decimals are strings** ("2917.02", never a JSON number) in every market/liquidation field. Parse with a decimal library, not \`parseFloat\`, for money.
  The exceptions are documented per field: signal meters (\`drop\`, \`z\`, \`liq1h\`, \`mean\`, \`price\`, \`equity\`) are JSON **numbers** (they are analytics, not balances).
- **Timestamps** are ISO-8601 UTC strings.
- **Every market-data response has \`asOf\`, \`mode\` and \`source\`.** \`mode\` is \`live\` | \`offline\` | \`drill\` | \`replay\` (replay is reserved and not implemented). \`asOf\` is when the server built the response.
- **Errors** always have this shape (HTTP status ≥ 400):
  \`\`\`json
  { "error": { "code": "not_found", "message": "Unknown instrument DOGE-USD" } }
  \`\`\`
  Codes: \`validation_error\` (400, has \`details\`), \`bad_request\` (400), \`not_found\` (404), \`conflict\` (409), \`rate_limited\` (429), \`unavailable\` (503), \`internal_error\` (500).
  \`unavailable\` means "not ready yet" (e.g. no price yet just after startup): retry after a second or two.
- **Pagination** is cursor-based: pass the previous response's \`nextCursor\` as \`cursor\`; \`nextCursor: null\` means the last page.
- **The offline demo has two instruments**: \`ETH-USD\` and \`BTC-USD\`. Other symbols return 404.
- **Not implemented** (do not build UI that needs them): authentication, user watchlists/orders/portfolio/alerts, order book, trades tape, movers, trending, technicals, news, wallet, backtests, replay.

## Starting a drill (the exact endpoint)

\`\`\`http
POST /api/v1/demo/drill
Content-Type: application/json

{"speed": 1}
\`\`\`

- Always send a JSON body (\`{}\` is fine); \`speed\` is optional, 0.5–1000, default 1. At speed 1 the whole drill takes about 40 s; \`speed: 20\` takes about 2 s.
- **Response 202** \`{"status":"started","speed":1}\`. It returns immediately; the drill runs in the background.
- **409** if a drill is already running.
- Watch it on the WebSocket (\`signal\`, \`ticker:ETH-USD\`, \`candles:ETH-USD:1m\`, \`liquidations\`; see \`ws.md\`) or poll \`GET /api/v1/demo/drill\` until \`status\` is \`"done"\`.
- A drill never touches real data or accounts. All of its WebSocket messages carry \`"synthetic": true\` and \`"mode": "drill"\`; show a banner.

## Endpoints
`;

const paths: string[] = [...ORDER.filter((p) => openapi.paths[p]), ...Object.keys(openapi.paths).filter((p) => !ORDER.includes(p))];
for (const path of paths) {
  for (const [method, op] of Object.entries<any>(openapi.paths[path])) { // eslint-disable-line @typescript-eslint/no-explicit-any
    md += `\n### \`${method.toUpperCase()} ${path}\`\n\n${op.summary ?? ''}\n`;
    if (op.description) md += `\n${op.description}\n`;
    const params: any[] = op.parameters ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (params.length) {
      md += `\n| Param | In | Type | Required |\n|---|---|---|---|\n`;
      for (const p of params) md += `| \`${p.name}\` | ${p.in} | ${paramType(p.schema ?? {})} | ${p.required ? 'yes' : 'no'} |\n`;
    }
    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body?.properties) {
      md += `\n**JSON body**\n\n| Field | Type | Required |\n|---|---|---|\n`;
      for (const [k, s] of Object.entries<any>(body.properties)) md += `| \`${k}\` | ${paramType(s)} | ${(body.required ?? []).includes(k) ? 'yes' : 'no'} |\n`; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    md += `\n**Responses:** ${Object.keys(op.responses ?? {}).map((c) => `\`${c}\``).join(', ')}${path.startsWith('/api') ? ' (plus the error shape above for any failure)' : ''}\n`;
    for (const ex of EXAMPLES[`${method} ${path}`] ?? []) {
      if (!existsSync(join(FIX, `${ex.file}.json`))) continue;
      const { v, cut } = shorten(fixture(ex.file));
      md += `\n**Example**${ex.note ? ` (${ex.note})` : ''}: \`fixtures/${ex.file}.json\`${cut ? ' (arrays shortened)' : ''}\n\n\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\`\n`;
    }
  }
}

md += `
## Field notes (things the schema alone doesn't say)

- **Candles** (\`GET …/candles\`): \`t\` is the bucket **open time** as an ISO string, ascending. \`limit\` returns the **newest** N candles in range, still ascending. The most recent candle is still forming.
  \`range\` picks the interval for you (1D→5m, 1W→1h, 1M/3M→4h, 1Y/5Y/All→1d); an explicit \`interval\` wins.
  On the **WebSocket** the same candle's \`t\` is **epoch milliseconds (a number)**, not an ISO string. See \`ws.md\`.
- **Quote:** \`changePct24h\` is already a percentage (\`"1.2464"\` means +1.2464%). Fields the backend can't compute are \`null\` (e.g. \`rank\`/\`marketCap\` in offline mode). \`sources\` lists where the price came from (\`simulator\` in the offline demo; \`coinbase-ws\` etc. live).
- **Liquidations:** amounts \`debtAmountRaw\`/\`collateralAmountRaw\` are raw integer strings in token base units (not USD). \`usdValue\` is the USD value at block time (can be \`null\` if unpriceable). \`txUrl\` is a ready Etherscan link. **In the offline demo the rows are simulated:** \`txHash\` starts with \`0x5150\`, addresses are fake, \`collateralAmountRaw\` is \`"0"\`, and the Etherscan links do not resolve.
  \`status\` is \`pending\` (fewer than 12 confirmations) or \`confirmed\`.
- **Oracle:** \`gap = fast/chainlink − 1\` (e.g. \`"-0.002701"\` = fast price is 0.27% below Chainlink). \`pressure\` is true when the gap is below −0.5%. \`gap\`/\`fastPrice\` are \`null\` when there is no fresh fast price. \`ageSec\` is the age of the Chainlink round.
- **Signal state** (\`state\` object): \`state\` is one of \`warming | watching | partial | fired | in_position | paused\`. \`met\` says which of the three entry conditions currently hold. \`reason\` is a human-readable sentence you can show verbatim. \`drop\` is a fraction (−0.04 = −4%). \`position\` is \`null\` unless \`state\` is \`in_position\`/\`fired\`.
- **Bot** (\`/signals/bot\`): the strategy bot's own paper account. \`trades[].side\` is \`buy\`/\`sell\`; \`engine.equity\` is in USD; \`engine.position\` is the open position or \`null\`. Timestamps inside \`engine\`/\`position\` are epoch **milliseconds** (numbers).
- **health/providers:** \`providers[].status\` is \`ok | degraded | down | unknown\`; \`chains\` groups providers into failover chains. Good for a small "data sources" indicator. In the offline demo the only real provider is \`simulator\`.
- **/health/ready** returns 503 (same shape, \`status: "not_ready"\`) when a critical dependency is down.
`;
writeFileSync(join(OUT, 'api.md'), md);

// ------------------------------------------------------------------ ws.md
const first = (file: string, type: 'snapshot' | 'update', pred: (m: any) => boolean = () => true) => // eslint-disable-line @typescript-eslint/no-explicit-any
  existsSync(join(WSS, file)) ? ndjson(file).find((r) => r.msg.type === type && pred(r.msg))?.msg : undefined;
const show = (m: unknown) => '```json\n' + JSON.stringify(shorten(m, 2).v, null, 2) + '\n```';
const compact = (m: unknown) => '```json\n' + JSON.stringify(m) + '\n```';

const liveFiles = { ticker: 'ticker_ETH-USD.ndjson', candle1m: 'candles_ETH-USD_1m.ndjson', oracle: 'oracle_ETH-USD.ndjson', signal: 'signal.ndjson', liq: 'liquidations.ndjson' };
const drillAll = ndjson(join('drill', 'all-channels.ndjson'));
const drillSignals = drillAll.filter((r) => r.msg.channel === 'signal' && r.msg.synthetic);
const drillStates = drillSignals.map((r) => r.msg.data?.state).filter(Boolean);
const drillFinal = drillSignals.find((r) => r.msg.data?.drill?.done)?.msg;
const drillLiq = drillAll.find((r) => r.msg.channel === 'liquidations' && r.msg.synthetic)?.msg;
const restored = drillAll.filter((r) => r.msg.type === 'snapshot' && !r.msg.synthetic && r.t > (drillSignals.at(-1)?.t ?? 0));
const drillTicks = drillAll.filter((r) => r.msg.channel === 'ticker:ETH-USD' && r.msg.synthetic);
const drillDurationS = drillAll.length ? ((drillSignals.at(-1)?.t ?? 0) - (drillSignals[0]?.t ?? 0)) / 1000 : 0;
const counts = (file: string) => (existsSync(join(WSS, file)) ? ndjson(file).length : 0);

const ws = `# WebSocket protocol

Endpoint: \`ws://localhost:8080/ws\` (same host/port as the REST API). Plain JSON text frames, no auth, no subprotocol.
Every example below is a **real recorded message** from \`ws-samples/\` (one line of those files is \`{"t":<ms since recording start>,"msg":<the frame>}\`;
\`t\` lets you replay them with their original timing).

## Client → server

\`\`\`json
{"op":"subscribe","channels":["ticker:ETH-USD","signal"]}
{"op":"unsubscribe","channels":["ticker:ETH-USD"]}
\`\`\`

- \`op\` is \`subscribe\` or \`unsubscribe\`; \`channels\` is 1–50 channel names (see the list below). Anything else gets an \`error\` frame.
- Subscribing to a channel you already have is a no-op. Unsubscribing from one you don't have is ignored.
- You can send subscribe messages at any time and as often as you like; send them again after every reconnect (subscriptions do not survive a disconnect).
- There are no other client messages. Do not send pings; the server pings you (browsers answer automatically).

## Server → client: the envelope

Every data frame has the same envelope:

\`\`\`ts
{
  channel: string;             // e.g. "ticker:ETH-USD"
  type: "snapshot" | "update";
  seq: number;                 // monotonic per channel; see below
  ts: string;                  // ISO time the server published this frame
  mode: "live" | "offline" | "drill" | "replay";
  synthetic?: true;            // present ONLY on drill traffic; absent otherwise
  data: <channel specific> | null;
}
\`\`\`

- **Snapshot first.** Right after you subscribe to a channel you receive exactly one \`snapshot\` with the channel's current state, then \`update\` frames.
  If the channel has produced nothing yet you get \`{"type":"snapshot","seq":0,"data":null}\`: render an empty state, not an error.
- **\`seq\`** increases by 1 per published message on that channel (\`0\` = "nothing yet"). A snapshot carries the seq of the latest update it reflects, so drop any update with \`seq ≤\` your snapshot's.
  **State channels** (\`ticker:*\`) are coalesced by the server to at most **4 frames/second per client**, so \`seq\` gaps there are **normal**: just keep the newest.
  **Event channels** (\`signal\`, \`liquidations\`, \`candles:*\` closed candles) are not coalesced; a gap in \`seq\` there means you lost a frame, so unsubscribe and resubscribe to get a fresh snapshot.
- **\`mode\`** is on every frame. Show a global banner whenever it isn't \`live\`: \`offline\` = simulated market, \`drill\` = synthetic crash in progress.
- **\`synthetic\`**: exists (as \`true\`) **only** on frames produced by a drill. If you see it, the data is fake by design. Never mix synthetic frames into real history/charts you persist.
- **Errors** are frames without \`channel\`/\`seq\`:
  \`\`\`json
  ${JSON.stringify(ndjson('errors.ndjson').map((r) => r.msg))}
  \`\`\`
  Codes: \`bad_message\` (not valid JSON or wrong shape), \`unknown_channel\`, \`not_available\` (\`orderbook:*\`, \`trades:*\`, \`movers\`, \`chain\`: planned, not built), \`unauthorized\` (\`me:orders\`, \`me:portfolio\`, \`me:alerts\`: not built). The connection stays open after an error.
- **Heartbeat:** the server sends a WebSocket ping every 20 s and closes connections that don't pong. Browsers pong automatically; you need no code for it.
- **Backpressure:** if a client falls far behind, the server drops intermediate \`ticker\`/\`candles\`/\`oracle\` frames (never \`signal\` or \`liquidations\`).

## Channels

Only \`ETH-USD\` and \`BTC-USD\` exist in the demo. Any other symbol is accepted syntactically but will only ever deliver \`data: null\`.

| Channel | Kind | What it carries |
|---|---|---|
| \`ticker:{symbol}\` | state, ≤4/s | latest price |
| \`candles:{symbol}:{interval}\` | event | the forming or just-closed candle. \`interval\` ∈ \`1m 5m 15m 1h 4h 1d\` |
| \`liquidations\` | event | new Aave liquidations (and reorg removals) |
| \`oracle:{symbol}\` | state | Chainlink vs fast price. Only \`ETH-USD\` and \`BTC-USD\` |
| \`signal\` | event | Cascade Catcher state, meters, reason |

### \`ticker:{symbol}\`

\`data\`: \`{symbol, price (decimal string), bid, ask (string|null), ts (ISO), source, suspect (bool)}\`. \`suspect: true\` means two price sources disagreed by >1.5%: show it dimmed/flagged.

Snapshot (real):
${compact(first(liveFiles.ticker, 'snapshot'))}
Update (real):
${compact(first(liveFiles.ticker, 'update'))}

### \`candles:{symbol}:{interval}\`

\`data\`: \`{symbol, interval, closed (bool), candle:{t, o, h, l, c, v, source}}\`.
- **\`candle.t\` here is epoch MILLISECONDS as a number** (REST returns an ISO string for the same field). \`o h l c v\` are decimal strings.
- Published about once per second while a candle is forming (\`closed:false\`); the last frame for a bucket has \`closed:true\`. Replace the candle with the same \`t\`, or append if \`t\` is new.
- The snapshot is the latest candle only. Load history from REST \`/candles\` first, then apply these.

Snapshot (real):
${compact(first(liveFiles.candle1m, 'snapshot'))}
Update (real):
${compact(first(liveFiles.candle1m, 'update'))}

### \`liquidations\`

- **Snapshot** \`data\`: array of the 20 most recent liquidations, newest first (same objects as REST \`/liquidations\` items).
- **Update** \`data\` is one of:
  - \`{"type":"liquidation","event":{…same object as a REST liquidation item…}}\`: a new event.
  - \`{"type":"removed","txHash":"0x…","logIndex":0}\`: a chain reorg removed it; delete it from your list. (Shape taken from the backend code; a reorg has not occurred in any recording.)
  - During a **drill**: \`{"type":"liquidation","event":{…}}\` with a smaller \`event\` (below) and \`status:"synthetic"\`, \`txUrl:null\`, negative \`id\`.
- Real liquidations are rare: in a 2-minute offline recording there were **${counts(liveFiles.liq) - 1} live update(s)** (about 3 background events/hour). Use the drill to see traffic.

Snapshot (real, first 2 of 20 items):
${show(first(liveFiles.liq, 'snapshot'))}
${drillLiq ? `Update during a drill (real, synthetic):\n${compact(drillLiq)}` : ''}

### \`oracle:{symbol}\`

\`data\`: \`{symbol, chainlinkPrice, fastPrice|null, gap|null, pressure (bool), roundId, updatedAt (ISO), ageSec, heartbeatSec, deviation}\`. Same fields as REST \`/oracle/{symbol}\` → \`oracle\`. Published about every 5–12 s.

Snapshot (real):
${compact(first(liveFiles.oracle, 'snapshot'))}
Update (real):
${compact(first(liveFiles.oracle, 'update'))}

### \`signal\`

\`data\` (numbers, not strings): \`{symbol, state, drop, z, liq1h, mean, thresholds:{dropThresh,zThresh,minLiqUsd}, met:{drop,z,liq}, reason, price, priceSource:"fast"|"chainlink", equity, position|null, pausedUntil|null, ts}\`.
\`state\` ∈ \`warming | watching | partial | fired | in_position | paused\`. Published about every 5 s (and immediately on drill frames).

Snapshot (real):
${compact(first(liveFiles.signal, 'snapshot'))}

## Drills on the WebSocket

Start one with \`POST /api/v1/demo/drill\` (see \`api.md\`). Subscribe to \`signal\`, \`ticker:ETH-USD\`, \`candles:ETH-USD:1m\`, \`liquidations\` beforehand. The recorded sequence is in \`ws-samples/drill/\`
(\`all-channels.ndjson\` is every frame in arrival order).

What the backend does to your subscriptions:

1. **The instant the drill starts, live frames stop** on \`ticker:ETH-USD\`, \`candles:ETH-USD:*\`, \`oracle:ETH-USD\`, \`liquidations\` and \`signal\`, and are replaced by frames with \`"synthetic":true,"mode":"drill"\`. You don't need to resubscribe. (\`ticker:BTC-USD\` and other channels are unaffected.)
2. **Synthetic frames use the same shapes and channel names as live ones.** \`seq\` for synthetic frames counts on a separate counter starting again at 1.
3. **The \`signal\` frames inside a drill have one extra field**, \`data.drill: {id, seq}\`, and the **last** \`signal\` frame is different: it has **no meters**, only
   ${compact(drillFinal ? { ...drillFinal, data: { ...drillFinal.data, drill: { ...drillFinal.data.drill, summary: '…see fixtures/drill-result.json…' } } } : null)}
   Treat \`data.drill.done === true\` as "the drill is over" and don't try to read \`state\` from that frame.
4. **Timestamps inside drill frames are virtual time.** The crash lasts 20 real seconds, but the rebound phase fast-forwards the clock (each frame is +5 minutes), so
   \`data.ts\` and \`candle.t\` in drill frames run **hours into the future** by the end. The envelope's \`ts\` is the true wall-clock time. Chart drill data by frame order, or by \`data.ts\`, but do not compare it to real history.
5. **When the drill ends**, the server sends a fresh **live \`snapshot\`** (no \`synthetic\`, real \`mode\`) on every channel you're subscribed to (${restored.length} in the recording), and live updates resume.
   That snapshot is your cue to switch the banner off.

Recorded drill (speed 1): ${drillAll.length} frames in total, ${drillSignals.length} \`signal\`, ${drillTicks.length} \`ticker\` frames, spanning ~${drillDurationS.toFixed(0)} s.
\`signal.state\` sequence: **${drillStates.filter((s: string, i: number, a: string[]) => i === 0 || s !== a[i - 1]).join(' → ')}**.
The final result (states, trades, equity) is \`fixtures/drill-result.json\`.

## Reconnecting

Reconnect with exponential backoff (e.g. 0.5 s → 30 s, jittered), then send your subscribe message again. You get fresh snapshots, so no replay logic is needed.
If the socket drops during a drill, the drill keeps running on the server; after reconnecting you will be receiving synthetic frames mid-stream (the snapshot you get is the drill's current state, marked \`synthetic\`).
`;
writeFileSync(join(OUT, 'ws.md'), ws);

// ------------------------------------------------------------------ READMEs
const wsFiles = ['ticker_ETH-USD', 'ticker_BTC-USD', 'candles_ETH-USD_1m', 'candles_ETH-USD_5m', 'candles_ETH-USD_15m', 'candles_ETH-USD_1h', 'candles_ETH-USD_4h', 'candles_ETH-USD_1d', 'candles_BTC-USD_1m', 'liquidations', 'oracle_ETH-USD', 'oracle_BTC-USD', 'signal'];
writeFileSync(
  join(WSS, 'README.md'),
  `# ws-samples

Each \`*.ndjson\` line is \`{"t": <ms since recording start>, "msg": <exact WebSocket frame>}\`.

**Recording:** ~120 s of the live \`npm run demo:offline\` process, one WebSocket subscribed to all 13 channels.

| File | frames |
|---|---|
${wsFiles.map((f) => `| \`${f}.ndjson\` | ${counts(f + '.ndjson')} |`).join('\n')}
| \`errors.ndjson\` | ${counts('errors.ndjson')} (one per error code the gateway can return) |

\`liquidations.ndjson\` is nearly empty by design: real liquidations arrive about 3/hour in the offline simulator. The **drill** recording has the busy version.

**\`drill/\`**: one complete drill at \`speed: 1\`, recorded from before the POST until 2.5 s after it finished. \`all-channels.ndjson\` is every frame in order;
the per-channel files are the same frames split by channel. Subscribed to: ${['signal', 'ticker:ETH-USD', 'candles:ETH-USD:1m', 'liquidations', 'oracle:ETH-USD'].join(', ')}.
Note \`oracle:ETH-USD\` is **suppressed** during the drill (live frames stop, no synthetic replacement), so it goes quiet then resumes with a live snapshot.

To mock the backend, replay a file's lines with \`setTimeout(send, line.t - previous.t)\`.
`,
);
writeFileSync(
  join(FIX, 'README.md'),
  `# fixtures

Real JSON responses, unedited, captured from the running \`npm run demo:offline\` process (offline simulator, so \`mode\` is \`"offline"\`).
Use them as mock API data: they are exactly what the backend returns.

Exceptions, both **clearly labelled**:
- \`signal-bot-in-position.json\`, \`signal-bot-with-trades.json\`: the offline demo's bot hadn't traded yet, so these two come from the real
  \`/api/v1/signals/bot\` endpoint running in a **test harness** with a forced cascade (real code path and response shape, scripted data).
  \`signal-bot.json\` is the real live-demo response (empty \`trades\`).
- Candles are \`limit=30\` (\`candles-range-1D\` is \`limit=12\`) to keep files small; the API allows up to 2000.

| File | Endpoint |
|---|---|
| \`instruments\` | GET /api/v1/instruments |
| \`quote-ETH-USD\`, \`quote-BTC-USD\` | GET /api/v1/instruments/{symbol}/quote |
| \`candles-5m\`, \`candles-1h\`, \`candles-1d\`, \`candles-range-1D\` | GET /api/v1/instruments/ETH-USD/candles |
| \`liquidations\`, \`liquidations-page2\` | GET /api/v1/liquidations (limit=10, then the cursor page) |
| \`liquidations-stats-1h\`, \`-24h\`, \`-7d\` | GET /api/v1/liquidations/stats |
| \`oracle-ETH-USD\`, \`oracle-BTC-USD\` | GET /api/v1/oracle/{symbol} |
| \`signal-state\`, \`signal-state-during-drill\`, \`signal-state-after-drill\` | GET /api/v1/signals/state |
| \`signal-history\` | GET /api/v1/signals/history |
| \`signal-bot\`, \`signal-bot-in-position\`, \`signal-bot-with-trades\` | GET /api/v1/signals/bot |
| \`health\`, \`health-ready\`, \`health-providers\` | GET /health, /health/ready, /health/providers |
| \`demo-status\`, \`demo-status-during-drill\` | GET /api/v1/demo/status |
| \`drill-start\`, \`drill-running\`, \`drill-result\`, \`error-409-drill-running\` | POST/GET /api/v1/demo/drill |
| \`error-404-*\`, \`error-400-validation\` | the error shape |
`,
);
writeFileSync(
  join(OUT, 'README.md'),
  `# web-contract

Everything a frontend needs to build against this backend **without seeing it**.

| File | What |
|---|---|
| \`api.md\` | Every REST endpoint: params, response codes, a real example each, field notes and gotchas |
| \`ws.md\` | The WebSocket protocol: messages, envelope, \`seq\`, \`mode\`, \`synthetic\`, every channel, drill behaviour |
| \`openapi.json\` | OpenAPI 3 export from the running app (generate typed clients from it; the WebSocket is not in OpenAPI, see \`ws.md\`) |
| \`fixtures/\` | Real captured REST responses (mock data) |
| \`ws-samples/\` | ~2 min of recorded WebSocket frames per channel + one full recorded drill |

## Quick facts

- REST base \`http://localhost:8080\`, WebSocket \`ws://localhost:8080/ws\`, CORS origin \`http://localhost:5173\`.
- Instruments: \`ETH-USD\`, \`BTC-USD\`. Decimals are strings. Times are ISO-8601 UTC.
- **Start a drill:** \`POST /api/v1/demo/drill\` with body \`{"speed":1}\` → 202. Watch \`signal\` on the WebSocket.
- Show a banner whenever \`mode !== "live"\` and treat \`synthetic: true\` as fake data.
- The demo the fixtures came from is **offline/simulated**: prices, liquidations and Chainlink are generated, not real market data
  (\`mode: "offline"\`). Live mode returns the same shapes with real data.
- Not built yet, so don't design for them: auth/login, orders, portfolio, watchlists, alerts, order book, trades tape, movers, technicals, news.

## Regenerate

With \`npm run demo:offline\` running on port 8080:

\`\`\`bash
npx tsx scripts/capture-web-contract.ts http://localhost:8080 120
npx tsx scripts/build-web-contract-docs.ts
\`\`\`
`,
);
console.log('docs built');
