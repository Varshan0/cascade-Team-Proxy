import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { ensureInstruments } from '../shared/db/seed-base';
import { instruments } from '../shared/db/schema';
import { CandleAggregator } from '../shared/market/aggregator';
import { backfillInstrument, reconcileRecent } from '../shared/market/backfill';
import { TickPipeline } from '../shared/market/ingest';
import { mktKey, type MarketSnapshot } from '../shared/market/quote';
import { CoinbaseAdvanced, CoinbaseRest } from '../shared/providers/coinbase';
import { CoinbaseWs } from '../shared/providers/coinbase-ws';
import { CoinGecko } from '../shared/providers/coingecko';
import { runChain } from '../shared/providers/failover';
import { HealthTracker, publishHealth } from '../shared/providers/health';
import type { Runtime } from '../shared/runtime';
import { SignalEngine } from '../shared/strategy/engine';
import { startChainFeed } from './chain-feed';

export interface WorkerHandle {
  pipeline: TickPipeline;
  aggregator: CandleAggregator;
  trackers: HealthTracker[];
  stop: () => Promise<void>;
}

/**
 * Wires every worker duty onto the runtime's scheduler. The same function serves `npm run dev`
 * (BullScheduler + real Redis) and `npm run demo` (LocalScheduler + ioredis-mock).
 */
export async function startWorker(rt: Runtime): Promise<WorkerHandle> {
  const { config, db, redis, logger, scheduler } = rt;
  await ensureInstruments(db);
  const enabled = await db.select().from(instruments).where(eq(instruments.enabled, true));

  const trackers: HealthTracker[] = [];
  const aggregator = new CandleAggregator(rt);
  const pipeline = new TickPipeline(rt, (t) => aggregator.onTick(t));
  const stoppers: Array<() => void | Promise<void>> = [];

  scheduler.every('candle-flush', 1_000, () => aggregator.flush());
  scheduler.every('health-publish', 5_000, () => publishHealth(redis, trackers), { immediate: true });
  scheduler.every('worker-heartbeat', 10_000, () => void redis.set('worker:heartbeat', new Date().toISOString(), 'EX', 30), { immediate: true });

  if (config.DEMO_OFFLINE) {
    const { startSimFeed } = await import('./sim-feed');
    stoppers.push(await startSimFeed(rt, pipeline, trackers));
  } else {
    const rest = new CoinbaseRest({ redis });
    const advanced = new CoinbaseAdvanced({ redis });
    const cg = new CoinGecko({ apiKey: config.COINGECKO_API_KEY, redis });
    const products = new Map(enabled.filter((i) => i.coinbaseProductId).map((i) => [i.coinbaseProductId!, i.symbol]));
    const ws = new CoinbaseWs(products, (t) => pipeline.handle(t), logger);
    trackers.push(ws.tracker, rest.tracker, advanced.tracker, cg.tracker);
    ws.start();
    stoppers.push(() => ws.stop());

    // Second live source + failover for the tick feed (also what the sanity check compares against).
    scheduler.every('poll-coinbase-rest', 5_000, async () => {
      await Promise.all(
        enabled.map(async (i) => {
          if (!i.coinbaseProductId) return;
          try {
            const t = await rest.ticker(i.coinbaseProductId);
            pipeline.handle({ instrument: i.symbol, price: t.price, ts: t.ts, source: rest.name, bid: t.bid, ask: t.ask });
          } catch {
            // recorded on the provider's health tracker; the next poll retries
          }
        }),
      );
    });

    scheduler.every(
      'poll-markets',
      60_000,
      async () => {
        const ids = enabled.map((i) => i.coingeckoId).filter((x): x is string => !!x);
        try {
          const { value: markets } = await runChain('markets', [{ name: 'coingecko', run: () => cg.markets(ids) }]);
          for (const m of markets) {
            const inst = enabled.find((i) => i.coingeckoId === m.id);
            if (!inst) continue;
            const snap: MarketSnapshot = {
              marketCap: m.market_cap ?? null,
              rank: m.market_cap_rank ?? null,
              circulatingSupply: m.circulating_supply ?? null,
              maxSupply: m.max_supply ?? null,
              ath: m.ath ?? null,
              volume24h: m.total_volume ?? null,
              updatedAt: new Date().toISOString(),
            };
            await redis.set(mktKey(inst.symbol), JSON.stringify(snap), 'EX', 900);
            pipeline.handle({ instrument: inst.symbol, price: new Decimal(m.current_price), ts: Date.now(), source: cg.name });
          }
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'markets poll failed');
        }
      },
      { immediate: true, durable: true },
    );

    startChainFeed(rt, trackers);

    const providers = { rest, advanced };
    scheduler.once('candle-backfill', async () => {
      for (const i of enabled) {
        if (!i.coinbaseProductId) continue;
        try {
          await backfillInstrument(db, providers, i.symbol, i.coinbaseProductId, logger);
        } catch (err) {
          logger.error({ err: (err as Error).message, instrument: i.symbol }, 'backfill failed');
        }
      }
      logger.info('candle backfill finished');
    });
    scheduler.every(
      'candle-reconcile',
      5 * 60_000,
      async () => {
        for (const i of enabled) {
          if (!i.coinbaseProductId) continue;
          try {
            await reconcileRecent(db, providers, i.symbol, i.coinbaseProductId, logger);
          } catch (err) {
            logger.warn({ err: (err as Error).message, instrument: i.symbol }, 'reconcile failed');
          }
        }
      },
      { durable: true },
    );
  }

  // Signal engine runs in every mode: it reads whatever the active feed (live or simulator) has produced.
  const engine = new SignalEngine(rt);
  await engine.init();
  scheduler.every('signal-engine', 5_000, async () => void (await engine.evaluate()), { immediate: true });

  return {
    pipeline,
    aggregator,
    trackers,
    stop: async () => {
      for (const s of stoppers) await s();
    },
  };
}
