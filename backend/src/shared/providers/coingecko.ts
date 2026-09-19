import { z } from 'zod';
import type { Redis } from '../redis';
import type { ProviderHealth } from './health';
import { ResilientHttp } from './resilient';

const num = z.number().nullable().optional();

const marketSchema = z.array(
  z.object({
    id: z.string(),
    symbol: z.string(),
    name: z.string(),
    current_price: z.number(),
    market_cap: num,
    market_cap_rank: num,
    total_volume: num,
    high_24h: num,
    low_24h: num,
    price_change_24h: num,
    price_change_percentage_24h: num,
    ath: num,
    circulating_supply: num,
    max_supply: num,
    last_updated: z.string().nullable().optional(),
  }),
);

export type CoinMarket = z.infer<typeof marketSchema>[number];

/**
 * CoinGecko: markets data + last-resort price. Keyless access 429'd after a handful of calls during
 * verification, so the bucket is tiny and the caller must treat failures as normal.
 */
export class CoinGecko {
  readonly name = 'coingecko';
  private http: ResilientHttp;

  constructor(opts: { apiKey?: string; redis?: Redis; fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
    this.http = new ResilientHttp({
      name: this.name,
      baseUrl: opts.baseUrl ?? 'https://api.coingecko.com/api/v3',
      headers: opts.apiKey ? { 'x-cg-demo-api-key': opts.apiKey } : undefined,
      // Demo-key limit unverified; keep well under it. Keyless is stricter still.
      bucket: opts.apiKey ? { capacity: 5, refillPerSec: 0.25 } : { capacity: 2, refillPerSec: 0.05 },
      redis: opts.redis,
      fetchImpl: opts.fetchImpl,
    });
  }

  health(): ProviderHealth {
    return this.http.health();
  }
  get tracker() {
    return this.http.tracker;
  }

  markets(ids: string[]): Promise<CoinMarket[]> {
    return this.http.getJson('/coins/markets', {
      query: { vs_currency: 'usd', ids: ids.join(','), price_change_percentage: '24h' },
      schema: marketSchema,
      ttlSec: 30,
    });
  }
}
