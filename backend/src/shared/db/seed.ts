import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import type { Reserve } from '../chain/rpc';
import { deposit, ensureAccount, recordTrade } from '../ledger';
import type { Db } from './client';
import { ensureInstruments } from './seed-base';
import { assets, fills, instruments, orders, positions, settings, users, watchlistItems, watchlists } from './schema';

/**
 * Offline fallback for the Aave V3 mainnet reserve list. The real seed reads `getReservesList()` from the Pool
 * (see EthRpc.reserves); this list only covers the most common collateral assets if no RPC is reachable.
 */
export const STATIC_RESERVES: Reserve[] = [
  { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18 },
  { address: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', symbol: 'wstETH', decimals: 18 },
  { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', decimals: 8 },
  { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6 },
  { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6 },
  { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', decimals: 18 },
  { address: '0x514910771af9ca656af840dff83e8264ecf986ca', symbol: 'LINK', decimals: 18 },
  { address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', symbol: 'AAVE', decimals: 18 },
  { address: '0xbe9895146f7af43049ca1c1ae358b0541ea49704', symbol: 'cbETH', decimals: 18 },
  { address: '0xae78736cd615f374d3085123a210448e74fc6393', symbol: 'rETH', decimals: 18 },
  { address: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f', symbol: 'GHO', decimals: 18 },
  { address: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee', symbol: 'weETH', decimals: 18 },
];

/** A recognisably fake address for the demo user (no key exists for it; the SIWE flow arrives with M5). */
export const DEMO_ADDRESS = '0xde30000000000000000000000000000000000001';

const D = (n: string | number) => new Decimal(n);
const TAKER_FEE = D('0.001');

export interface SeedSummary {
  instruments: number;
  assets: number;
  demoUser: boolean;
  demoTrades: number;
}

interface DemoTrade {
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  price: string;
}

const DEMO_TRADES: DemoTrade[] = [
  { symbol: 'ETH-USD', side: 'buy', qty: '1.5', price: '2600' },
  { symbol: 'BTC-USD', side: 'buy', qty: '0.05', price: '81000' },
  { symbol: 'ETH-USD', side: 'sell', qty: '0.5', price: '2650' },
];

/** Idempotent: safe to run repeatedly, and never overwrites an operator's changes. */
export async function seedDatabase(db: Db, opts: { reserves?: Reserve[] } = {}): Promise<SeedSummary> {
  await ensureInstruments(db);

  const reserves = opts.reserves && opts.reserves.length ? opts.reserves : STATIC_RESERVES;
  await db
    .insert(assets)
    .values(reserves.map((r) => ({ chain: 1, address: r.address.toLowerCase(), symbol: r.symbol, decimals: r.decimals })))
    .onConflictDoNothing();

  // ---- demo user + settings + watchlist
  const existing = (await db.select().from(users).where(eq(users.address, DEMO_ADDRESS)))[0];
  let demoTrades = 0;
  if (!existing) {
    const [user] = await db.insert(users).values({ address: DEMO_ADDRESS }).returning();
    await db.insert(settings).values({ userId: user!.id, data: { theme: 'system', currency: 'USD' } });
    const [wl] = await db.insert(watchlists).values({ userId: user!.id, name: 'Favorites' }).returning();
    await db.insert(watchlistItems).values([
      { watchlistId: wl!.id, symbol: 'ETH-USD', position: 0 },
      { watchlistId: wl!.id, symbol: 'BTC-USD', position: 1 },
    ]);

    // ---- demo paper account: $10,000, a few trades through the double-entry ledger
    const acct = await ensureAccount(db, 'user', 'demo-paper', user!.id);
    const system = await ensureAccount(db, 'system', 'system');
    await deposit(db, acct, system, D(10_000), 'demo-seed');

    const held = new Map<string, { qty: Decimal; avg: Decimal; realized: Decimal }>();
    let n = 0;
    for (const t of DEMO_TRADES) {
      const qty = D(t.qty);
      const price = D(t.price);
      const fee = qty.times(price).times(TAKER_FEE);
      const key = `demo-seed-${++n}`;
      const [order] = await db
        .insert(orders)
        .values({ accountId: acct, idempotencyKey: key, symbol: t.symbol, side: t.side, type: 'market', tif: 'IOC', qty: qty.toFixed(), status: 'filled', filledQty: qty.toFixed(), avgPrice: price.toFixed() })
        .returning();
      await db.insert(fills).values({ orderId: order!.id, accountId: acct, symbol: t.symbol, side: t.side, qty: qty.toFixed(), price: price.toFixed(), fee: fee.toFixed(), liquidity: 'taker' });
      await recordTrade(db, { accountId: acct, systemId: system, base: t.symbol.split('-')[0]!, side: t.side, qty, price, fee, refId: key });

      const p = held.get(t.symbol) ?? { qty: D(0), avg: D(0), realized: D(0) };
      if (t.side === 'buy') {
        const cost = p.avg.times(p.qty).plus(qty.times(price));
        p.qty = p.qty.plus(qty);
        p.avg = cost.div(p.qty);
      } else {
        p.realized = p.realized.plus(price.minus(p.avg).times(qty)).minus(fee);
        p.qty = p.qty.minus(qty);
      }
      held.set(t.symbol, p);
      demoTrades++;
    }
    for (const [symbol, p] of held) {
      await db.insert(positions).values({ accountId: acct, symbol, qty: p.qty.toFixed(), avgCost: p.avg.toFixed(), realizedPnl: p.realized.toFixed() });
    }
  }

  return {
    instruments: (await db.select().from(instruments)).length,
    assets: (await db.select().from(assets)).length,
    demoUser: !existing,
    demoTrades,
  };
}

// ---------------------------------------------------------------------------------------------- CLI

async function main(): Promise<void> {
  const { loadConfig } = await import('../config');
  const config = loadConfig();
  const usePglite = process.argv.includes('--pglite');

  let db: Db;
  let close: () => Promise<void>;
  if (usePglite) {
    // Same store `npm run demo` uses. Stop the demo first: a PGlite data dir has a single writer.
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const schema = await import('./schema');
    const dir = process.env.PGLITE_DIR ?? './data/pglite';
    mkdirSync(dirname(resolve(dir)), { recursive: true });
    const pg = new PGlite(dir);
    const orm = drizzle(pg, { schema });
    await migrate(orm, { migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle') });
    db = orm as unknown as Db;
    close = () => pg.close();
  } else {
    const { createDb } = await import('./client');
    const h = createDb(config.DATABASE_URL);
    db = h.db;
    close = h.close;
  }

  let reserves: Reserve[] | undefined;
  try {
    const { EthRpc } = await import('../chain/rpc');
    reserves = await new EthRpc(config.RPC_URLS).reserves();
    console.log(`read ${reserves.length} reserves from the Aave V3 Pool on-chain`);
  } catch (err) {
    console.warn(`could not read reserves from RPC (${(err as Error).message.split('\n')[0]}); using the static fallback list`);
  }

  const summary = await seedDatabase(db, { reserves });
  console.log('seed complete:', JSON.stringify(summary));
  await close();
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  await main();
}
