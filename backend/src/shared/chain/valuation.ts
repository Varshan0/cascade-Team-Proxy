import Decimal from 'decimal.js';
import { and, desc, eq, lte } from 'drizzle-orm';
import { pxGoodKey, type PriceSnapshot } from '../bus';
import type { Db } from '../db/client';
import { assets, oracleRounds } from '../db/schema';
import { loadLatest } from '../market/store';
import type { Redis } from '../redis';
import { HOUR } from '../time';
import { CHAINLINK_DECIMALS } from './abi';

/**
 * How each collateral asset is priced. Stablecoins are taken at $1. LSTs/LRTs (wstETH, weETH, ...) are
 * priced off ETH-USD and BTC wrappers off BTC-USD; this UNDERSTATES LSTs that trade above ETH (wstETH ~ +15%).
 * Everything else uses its own `<SYMBOL>-USD` instrument when that instrument has candles.
 */
const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDS', 'GHO', 'LUSD', 'FRAX', 'PYUSD', 'RLUSD', 'USDE', 'CRVUSD', 'USD0', 'FDUSD', 'USDTB']);
const ETH_LIKE = new Set(['WETH', 'WSTETH', 'WEETH', 'RETH', 'CBETH', 'OSETH', 'ETHX', 'EZETH', 'RSETH', 'SFRXETH', 'LSETH', 'TETH']);
const BTC_LIKE = new Set(['WBTC', 'CBBTC', 'TBTC', 'LBTC', 'EBTC']);

export function priceInstrumentFor(symbol: string): 'USD' | string {
  const s = symbol.toUpperCase();
  if (STABLES.has(s)) return 'USD';
  if (ETH_LIKE.has(s)) return 'ETH-USD';
  if (BTC_LIKE.has(s)) return 'BTC-USD';
  return `${s}-USD`;
}

const ORACLE_MAX_AGE_MS = 2 * HOUR;
const CANDLE_1M_MAX_AGE_MS = 5 * 60_000;
const CANDLE_1H_MAX_AGE_MS = 3 * HOUR;

export class UsdValuer {
  private info = new Map<string, { symbol: string; decimals: number }>();

  constructor(private db: Db, private redis: Redis) {}

  async reloadAssets(): Promise<void> {
    const rows = await this.db.select().from(assets);
    this.info = new Map(rows.map((r) => [r.address.toLowerCase(), { symbol: r.symbol, decimals: r.decimals }]));
  }

  /**
   * Price of `instrument` at `tsMs`: Chainlink round at that time (what Aave used) -> 1m candle -> 1h candle
   * -> live price if the moment is "now". Null when nothing is known (the row is revalued later).
   */
  async priceAt(instrument: string, tsMs: number, now = Date.now()): Promise<Decimal | null> {
    const [round] = await this.db
      .select()
      .from(oracleRounds)
      .where(and(eq(oracleRounds.feed, instrument), lte(oracleRounds.updatedAt, new Date(tsMs))))
      .orderBy(desc(oracleRounds.updatedAt))
      .limit(1);
    if (round && tsMs - round.updatedAt.getTime() <= ORACLE_MAX_AGE_MS) {
      return new Decimal(round.answer).div(new Decimal(10).pow(CHAINLINK_DECIMALS));
    }
    const m1 = (await loadLatest(this.db, instrument, '1m', tsMs - CANDLE_1M_MAX_AGE_MS, tsMs + 60_000, 1))[0];
    if (m1) return new Decimal(m1.c);
    const h1 = (await loadLatest(this.db, instrument, '1h', tsMs - CANDLE_1H_MAX_AGE_MS, tsMs + HOUR, 1))[0];
    if (h1) return new Decimal(h1.c);
    if (Math.abs(now - tsMs) < 2 * 60_000) {
      const raw = await this.redis.get(pxGoodKey(instrument));
      if (raw) return new Decimal((JSON.parse(raw) as PriceSnapshot).price);
    }
    return null;
  }

  /** USD value of `raw` units of `assetAddress` at `tsMs`, as a decimal string, or null if unpriceable. */
  async usdValue(assetAddress: string, raw: bigint, tsMs: number): Promise<string | null> {
    let a = this.info.get(assetAddress.toLowerCase());
    if (!a) {
      await this.reloadAssets();
      a = this.info.get(assetAddress.toLowerCase());
    }
    if (!a) return null;
    const units = new Decimal(raw.toString()).div(new Decimal(10).pow(a.decimals));
    const inst = priceInstrumentFor(a.symbol);
    if (inst === 'USD') return units.toFixed();
    const p = await this.priceAt(inst, tsMs);
    return p ? units.times(p).toDecimalPlaces(6).toFixed() : null;
  }
}
