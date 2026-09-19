import type { Db } from './client';
import { instruments } from './schema';

/** Baseline instruments. ETH/BTC are P0 (enabled); the rest are P1 and flip on with `enabled = true`. */
export const INSTRUMENTS: Array<typeof instruments.$inferInsert> = [
  {
    symbol: 'ETH-USD', base: 'ETH', quote: 'USD', name: 'Ethereum', coingeckoId: 'ethereum', coinbaseProductId: 'ETH-USD',
    pythFeedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    chainlinkFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', enabled: true, sortOrder: 1,
  },
  {
    symbol: 'BTC-USD', base: 'BTC', quote: 'USD', name: 'Bitcoin', coingeckoId: 'bitcoin', coinbaseProductId: 'BTC-USD',
    pythFeedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    chainlinkFeed: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', enabled: true, sortOrder: 2,
  },
  { symbol: 'SOL-USD', base: 'SOL', quote: 'USD', name: 'Solana', coingeckoId: 'solana', coinbaseProductId: 'SOL-USD', enabled: false, sortOrder: 3 },
  { symbol: 'LINK-USD', base: 'LINK', quote: 'USD', name: 'Chainlink', coingeckoId: 'chainlink', coinbaseProductId: 'LINK-USD', enabled: false, sortOrder: 4 },
  { symbol: 'AAVE-USD', base: 'AAVE', quote: 'USD', name: 'Aave', coingeckoId: 'aave', coinbaseProductId: 'AAVE-USD', enabled: false, sortOrder: 5 },
  { symbol: 'ARB-USD', base: 'ARB', quote: 'USD', name: 'Arbitrum', coingeckoId: 'arbitrum', coinbaseProductId: 'ARB-USD', enabled: false, sortOrder: 6 },
];

/** Idempotent: existing rows (including an operator's `enabled` changes) are left untouched. */
export async function ensureInstruments(db: Db): Promise<void> {
  await db.insert(instruments).values(INSTRUMENTS).onConflictDoNothing();
}
