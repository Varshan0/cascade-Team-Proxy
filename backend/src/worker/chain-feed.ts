import { LiquidationIndexer, seedAaveAssets } from '../shared/chain/indexer';
import { ORACLE_FEEDS, OracleWatcher } from '../shared/chain/oracle';
import { EthRpc, type ChainRpc } from '../shared/chain/rpc';
import { UsdValuer } from '../shared/chain/valuation';
import type { HealthTracker } from '../shared/providers/health';
import type { Runtime } from '../shared/runtime';

/** Live-mode chain duties: Chainlink oracle watcher + Aave liquidation indexer. `rpc` is injectable for tests. */
export function startChainFeed(rt: Runtime, trackers: HealthTracker[], rpc?: ChainRpc): { indexer: LiquidationIndexer; oracle: OracleWatcher } {
  const { config, scheduler, logger, db, redis } = rt;
  let chain = rpc;
  if (!chain) {
    const eth = new EthRpc(config.RPC_URLS);
    trackers.push(eth.tracker, eth.oracleTracker);
    chain = eth;
  }
  const valuer = new UsdValuer(db, redis);
  const oracle = new OracleWatcher(rt, chain);
  const indexer = new LiquidationIndexer(rt, chain, valuer, { backfillDays: config.LIQ_BACKFILL_DAYS, minChunk: config.LIQ_MIN_CHUNK });

  scheduler.every('oracle-poll', 12_000, async () => void (await oracle.poll()), { immediate: true, durable: true });
  scheduler.once('oracle-history', async () => {
    for (const f of ORACLE_FEEDS) {
      try {
        const n = await oracle.walkHistory(f);
        logger.info({ feed: f.instrument, rounds: n }, 'chainlink round history loaded');
      } catch (err) {
        logger.warn({ err: (err as Error).message, feed: f.instrument }, 'chainlink history walk failed');
      }
    }
  });

  let seeded = false;
  scheduler.every(
    'liq-indexer',
    12_000,
    async () => {
      if (!seeded) {
        const n = await seedAaveAssets(rt, chain);
        await valuer.reloadAssets();
        if (n) logger.info({ reserves: n }, 'seeded Aave V3 reserves');
        seeded = true;
      }
      await indexer.run();
    },
    { immediate: true, durable: true },
  );
  return { indexer, oracle };
}
