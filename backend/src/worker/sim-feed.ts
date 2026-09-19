import Decimal from 'decimal.js';
import { eq, like } from 'drizzle-orm';
import { publishChannel } from '../shared/bus';
import { CHAINLINK_FEEDS } from '../shared/chain/abi';
import { toDTO, assetSymbols } from '../shared/chain/liq-store';
import { OracleWatcher } from '../shared/chain/oracle';
import type { ChainRpc } from '../shared/chain/rpc';
import { assets, candles as candlesTable, indexerState, instruments, liquidations, oracleRounds } from '../shared/db/schema';
import { aggregate, type Candle } from '../shared/market/candles';
import type { TickPipeline } from '../shared/market/ingest';
import { upsertCandles, loadLatest } from '../shared/market/store';
import { HealthTracker } from '../shared/providers/health';
import { modeOf, type Runtime } from '../shared/runtime';
import { DAY, HOUR, bucketStart } from '../shared/time';
import { DEFAULT_SIM, MarketSim, SimChainlink, rng, type SimLiq } from '../shared/sim/market';
import { COVERAGE_KEY } from '../shared/strategy/engine';

/** Marks simulator-generated rows so they can be cleared and can never be mistaken for chain data. */
const SIM_TX_PREFIX = '0x5150';
const SIM_SOURCE = 'sim';
const HISTORY_DAYS = 30;
const HISTORY_KEY = 'sim-history';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const DEFAULT_PRICE: Record<string, number> = { 'ETH-USD': 2600, 'BTC-USD': 81_000 };

let txCounter = 0;
const simTx = () => SIM_TX_PREFIX + (++txCounter).toString(16).padStart(60, '0');

function liqRow(l: SimLiq, blockHint: number): typeof liquidations.$inferInsert {
  const usd = l.usd;
  return {
    txHash: simTx(),
    logIndex: 0,
    blockNumber: Math.floor(l.t / 12_000) + blockHint,
    blockHash: '0x' + Math.floor(l.t / 12_000).toString(16).padStart(64, '0'),
    ts: new Date(l.t),
    collateralAsset: WETH,
    debtAsset: USDC,
    user: '0x' + '51'.repeat(20),
    liquidator: '0x' + '52'.repeat(20),
    debtAmountRaw: BigInt(Math.round(usd * 1e6)).toString(),
    collateralAmountRaw: '0', // simulated: USD value is authoritative
    usdValue: usd.toFixed(6),
    status: 'confirmed',
  };
}

/** The chain as the oracle watcher sees it, backed by the simulated Chainlink feeds. */
class SimChainRpc implements ChainRpc {
  constructor(private feeds: Map<string, SimChainlink>) {}
  async getBlockNumber() {
    return Math.floor(Date.now() / 12_000);
  }
  async getLogs() {
    return [];
  }
  async getBlock(n: number) {
    return { hash: '0x' + n.toString(16).padStart(64, '0'), timestamp: n * 12 };
  }
  async latestRound(feed: string) {
    const c = this.feeds.get(feed.toLowerCase());
    if (!c || c.answer === 0n) throw new Error('sim oracle has no round yet');
    return { roundId: c.roundId, answer: c.answer, startedAt: c.updatedAt, updatedAt: c.updatedAt, answeredInRound: c.roundId };
  }
  async roundsBatch() {
    return [];
  }
  async reserves() {
    return [];
  }
}

interface History {
  c1m: Candle[];
  liqs: SimLiq[];
  rounds: Array<{ feed: string; roundId: bigint; answer: bigint; updatedAt: number }>;
}

/** Step a sim through `days` of history at 10s resolution, collecting 1m candles, liquidations and oracle rounds. */
export function simulateHistory(sim: MarketSim, instrument: string, endT: number, chainlink: SimChainlink): History {
  const c1m: Candle[] = [];
  const liqs: SimLiq[] = [];
  const rounds: History['rounds'] = [];
  let cur: { t: number; o: number; h: number; l: number; c: number; v: number } | null = null;
  const flush = () => {
    if (cur) c1m.push({ t: cur.t, o: String(cur.o.toFixed(2)), h: cur.h.toFixed(2), l: cur.l.toFixed(2), c: cur.c.toFixed(2), v: cur.v.toFixed(4), source: SIM_SOURCE });
  };
  let prev = sim.price;
  while (sim.t < endT) {
    const s = sim.advance(10);
    const m = bucketStart(s.t, '1m');
    const vol = 2 + 400 * Math.abs(Math.log(s.price / prev));
    prev = s.price;
    if (!cur || cur.t !== m) {
      flush();
      cur = { t: m, o: s.price, h: s.price, l: s.price, c: s.price, v: 0 };
    }
    cur.h = Math.max(cur.h, s.price);
    cur.l = Math.min(cur.l, s.price);
    cur.c = s.price;
    cur.v += vol;
    liqs.push(...s.liqs);
    if (chainlink.update(s.price, s.t)) rounds.push({ feed: instrument, roundId: chainlink.roundId, answer: chainlink.answer, updatedAt: chainlink.updatedAt });
  }
  flush();
  // the final (possibly partial) minute is left to the live feed
  if (c1m.length && c1m[c1m.length - 1]!.t + 60_000 > endT) c1m.pop();
  return { c1m, liqs, rounds };
}

async function seedSimAssets(rt: Runtime): Promise<void> {
  await rt.db
    .insert(assets)
    .values([
      { chain: 1, address: WETH, symbol: 'WETH', decimals: 18 },
      { chain: 1, address: WBTC, symbol: 'WBTC', decimals: 8 },
      { chain: 1, address: USDC, symbol: 'USDC', decimals: 6 },
    ])
    .onConflictDoNothing();
}

async function persistHistory(rt: Runtime, instrument: string, h: History): Promise<void> {
  const { db } = rt;
  const last7d = h.c1m.filter((c) => c.t >= h.c1m[h.c1m.length - 1]!.t - 7 * DAY);
  await upsertCandles(db, instrument, '1m', last7d);
  await upsertCandles(db, instrument, '5m', aggregate(last7d, '5m'));
  await upsertCandles(db, instrument, '15m', aggregate(last7d, '15m'));
  const h1 = aggregate(h.c1m, '1h');
  await upsertCandles(db, instrument, '1h', h1);
  await upsertCandles(db, instrument, '4h', aggregate(h1, '4h'));
  await upsertCandles(db, instrument, '1d', aggregate(h1, '1d'));
  for (let i = 0; i < h.rounds.length; i += 200) {
    await db
      .insert(oracleRounds)
      .values(h.rounds.slice(i, i + 200).map((r) => ({ feed: r.feed, roundId: r.roundId.toString(), answer: r.answer.toString(), updatedAt: new Date(r.updatedAt * 1000) })))
      .onConflictDoNothing();
  }
}

/** Offline mode: history first (so the signal is warm immediately), then a real-time tick loop. */
export async function startSimFeed(rt: Runtime, pipeline: TickPipeline, trackers: HealthTracker[]): Promise<() => void> {
  const { db, redis, logger, scheduler, config } = rt;
  const tracker = new HealthTracker('simulator');
  trackers.push(tracker);
  await seedSimAssets(rt);

  const enabled = await db.select().from(instruments).where(eq(instruments.enabled, true));
  const now = bucketStart(Date.now(), '1m');
  const chainlinks = new Map<string, SimChainlink>(); // by feed address (lowercase)
  const sims = new Map<string, MarketSim>();
  const seedBase = config.SIM_SEED;

  const [hist] = await db.select().from(indexerState).where(eq(indexerState.key, HISTORY_KEY));
  const meta = hist?.meta as { startT?: number; endT?: number } | null | undefined;
  const reuse = !!meta?.endT && now - meta.endT < 30 * 60_000 && !!meta.startT;

  if (!reuse) {
    // Regenerate cleanly: drop earlier simulator rows so overlapping eras never double-count.
    await db.delete(liquidations).where(like(liquidations.txHash, `${SIM_TX_PREFIX}%`));
    await db.delete(candlesTable).where(eq(candlesTable.source, SIM_SOURCE));
    logger.info({ days: HISTORY_DAYS }, 'offline mode: generating simulated market history');
  }

  let i = 0;
  for (const inst of enabled) {
    const feedAddr = (CHAINLINK_FEEDS as Record<string, string>)[inst.symbol];
    const cl = new SimChainlink();
    if (feedAddr) chainlinks.set(feedAddr.toLowerCase(), cl);
    const isEth = inst.symbol === 'ETH-USD';
    const params = { ...DEFAULT_SIM, seed: seedBase + i++, startPrice: DEFAULT_PRICE[inst.symbol] ?? 100, dropsPerDay: config.SIM_DROPS_PER_DAY, emitLiquidations: isEth };

    if (!reuse) {
      const sim = new MarketSim(params, now - HISTORY_DAYS * DAY);
      const h = simulateHistory(sim, inst.symbol, now, cl);
      await persistHistory(rt, inst.symbol, h);
      if (isEth) {
        const rows = h.liqs.map((l) => liqRow(l, 0));
        for (let k = 0; k < rows.length; k += 200) await db.insert(liquidations).values(rows.slice(k, k + 200)).onConflictDoNothing();
      }
      // continue the live sim from where history ended (same RNG stream, so drops keep arriving)
      sims.set(inst.symbol, sim);
    } else {
      const last = (await loadLatest(db, inst.symbol, '1m', now - 2 * HOUR, now + 1, 1))[0];
      const sim = new MarketSim({ ...params, startPrice: last ? Number(last.c) : params.startPrice, seed: params.seed + Math.floor(now / 1000) }, now);
      cl.update(sim.price, now);
      sims.set(inst.symbol, sim);
    }
    logger.info({ instrument: inst.symbol, price: sims.get(inst.symbol)!.price.toFixed(2) }, 'simulator ready');
  }

  const startT = reuse ? meta!.startT! : now - HISTORY_DAYS * DAY;
  if (!reuse) {
    await db
      .insert(indexerState)
      .values({ key: HISTORY_KEY, lastBlock: 0, meta: { startT, endT: now } })
      .onConflictDoUpdate({ target: indexerState.key, set: { meta: { startT, endT: now }, updatedAt: new Date() } });
  }
  // Liquidation coverage: the simulator produced every liquidation since startT, so the baseline is complete.
  await redis.set(COVERAGE_KEY, String(startT));

  // ---- Chainlink emulation feeds the same OracleWatcher the live path uses
  const oracle = new OracleWatcher(rt, new SimChainRpc(chainlinks));
  scheduler.every('oracle-poll', 5_000, async () => void (await oracle.poll()), { immediate: true });

  // ---- live loop, 1 simulated second per real second, through the same tick pipeline as real sources
  const rand = rng(seedBase + 999);
  const mode = modeOf(config);
  scheduler.every('sim-tick', 1_000, async () => {
    const wall = Date.now();
    for (const [symbol, sim] of sims) {
      const s = sim.advance(1);
      pipeline.handle({ instrument: symbol, price: new Decimal(s.price.toFixed(2)), size: new Decimal((0.05 + rand() * 0.6).toFixed(4)), side: rand() > 0.5 ? 'buy' : 'sell', ts: wall, source: 'simulator' });
      tracker.recordSuccess(0);

      const feedAddr = (CHAINLINK_FEEDS as Record<string, string>)[symbol];
      const cl = feedAddr ? chainlinks.get(feedAddr.toLowerCase()) : undefined;
      if (cl?.update(s.price, wall)) {
        await db.insert(oracleRounds).values({ feed: symbol, roundId: cl.roundId.toString(), answer: cl.answer.toString(), updatedAt: new Date(cl.updatedAt * 1000) }).onConflictDoNothing();
      }
      if (s.liqs.length) {
        const rowsIn = s.liqs.map((l) => liqRow({ t: wall, usd: l.usd }, 0));
        const inserted = await db.insert(liquidations).values(rowsIn).onConflictDoNothing().returning();
        const symbols = await assetSymbols(db);
        for (const row of inserted) {
          await publishChannel(redis, 'liquidations', { type: 'liquidation', event: toDTO(row, symbols) }, { mode, snapshot: false });
        }
      }
    }
  });
  return () => {};
}
