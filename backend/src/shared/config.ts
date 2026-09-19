import 'dotenv/config';
import { z } from 'zod';

/** Empty strings in .env (e.g. `PYTH_API_KEY=`) mean "not configured". */
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).default(8080), // 0 = ephemeral (tests)
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/multipli'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Keyless defaults verified 2026-09-19. Their eth_getLogs limits are tiny (see docs/providers.md):
  // add an Alchemy/Infura URL at the front for deep backfills.
  RPC_URLS: csv('https://ethereum-rpc.publicnode.com,https://1rpc.io/eth,https://cloudflare-eth.com'),
  LIQ_BACKFILL_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  /** Adaptive chunking floor for eth_getLogs (spec: 100). Lower it for RPCs capped below 100 blocks. */
  LIQ_MIN_CHUNK: z.coerce.number().int().min(1).default(100),
  /** Oracle gap (fast price / Chainlink - 1) below which liquidation pressure is flagged. */
  ORACLE_PRESSURE_GAP: z.coerce.number().default(-0.005),
  RPC_WS_URL: optional,
  PYTH_API_KEY: optional,
  PYTH_BASE_URL: z.string().default('https://pyth.dourolabs.app/hermes'),
  COINGECKO_API_KEY: optional,
  CMC_API_KEY: optional,
  CRYPTOCOMPARE_API_KEY: optional,
  ETHERSCAN_API_KEY: optional,
  JWT_SECRET: z.string().min(16).default('dev-only-change-me-please'),
  SIWE_DOMAIN: z.string().default('localhost:5173'),
  CORS_ORIGINS: csv('http://localhost:5173'),
  DEMO_OFFLINE: bool,
  /** Built web UI directory to serve (default: ./web/dist, if it exists). */
  WEB_DIST: optional,
  /** Offline simulator: RNG seed and how many sudden drops (cascade candidates) arrive per day. */
  SIM_SEED: z.coerce.number().int().default(42),
  SIM_DROPS_PER_DAY: z.coerce.number().min(0).default(1.2),
  SEPOLIA_RPC_URL: optional,
  SEPOLIA_DEPLOYER_KEY: optional,
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.JWT_SECRET === 'dev-only-change-me-please') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return cfg;
}

/**
 * Failover chains are config, not business logic (spec section 4).
 * Provider names must match `ProviderClient.name`. Providers whose API key is
 * missing are dropped at runtime by `activeChain`.
 */
export const FAILOVER_CHAINS = {
  realtimePrice: ['simulator', 'coinbase-ws', 'pyth', 'coinbase-rest', 'coingecko'],
  oraclePrice: ['chainlink-rpc'],
  // coinbase-advanced: public Advanced Trade market endpoint, verified 2026-09-19.
  // cryptocompare / coingecko OHLC are unverified and stay disabled (see PROVIDER_FLAGS).
  candles: ['coinbase-rest', 'coinbase-advanced', 'cryptocompare', 'coingecko'],
  markets: ['coingecko', 'coinmarketcap'],
  rpc: ['rpc'],
  explorer: ['etherscan', 'blockscout'],
} as const;

export type ChainName = keyof typeof FAILOVER_CHAINS;

/** Chains whose total outage makes the service not-ready. Markets/explorer data degrade gracefully. */
export const CRITICAL_CHAINS: readonly ChainName[] = ['realtimePrice', 'oraclePrice', 'candles', 'rpc'];

/**
 * Providers whose endpoints/response shapes are NOT verified stay disabled regardless of API keys.
 * Flip a flag only after checking the provider against its live API and recording it in docs/providers.md.
 */
export const PROVIDER_FLAGS = {
  pyth: false, // needs a key; response shape unverified
  coinmarketcap: false, // docs unreachable during verification
  cryptocompare: false, // docs unreachable during verification
  coingeckoOhlc: false, // keyless calls 429'd during verification
} as const;

export const MODES = ['live', 'replay', 'drill', 'offline'] as const;
export type Mode = (typeof MODES)[number];
