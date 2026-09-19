// Shapes of the backend responses this UI uses (see web-contract/api.md and ws.md in the backend repo).
// Decimals arrive as strings; the signal meters are JSON numbers.

export type Mode = 'live' | 'offline' | 'drill' | 'replay'

export interface Envelope<T = unknown> {
  channel: string
  type: 'snapshot' | 'update'
  seq: number
  ts: string
  mode: Mode
  synthetic?: true
  data: T | null
}

export interface Quote {
  symbol: string
  price: string
  change24h: string | null
  changePct24h: string | null
  open24h: string | null
  high24h: string | null
  low24h: string | null
  previousClose?: string | null
  volume24h?: string | null
  marketCap?: string | null
  rank?: number | null
  updatedAt: string
  sources: string[]
}

export interface Candle {
  t: string
  o: string
  h: string
  l: string
  c: string
  v: string
  source: string
}

export type CandleRange = '1D' | '1W' | '1M' | '3M' | '1Y' | 'All'
export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export interface Instrument {
  symbol: string
  base: string
  quote: string
  name: string
  sortOrder: number
}

export interface Liquidation {
  id: number
  txHash: string
  logIndex?: number
  ts: string
  collateralSymbol: string | null
  debtSymbol: string | null
  usdValue: string | null
  status: string
  /** null on synthetic (drill) events */
  txUrl: string | null
}

export interface LiquidationStats {
  window: string
  totalUsd: string
  count: number
  topAssets?: Array<{ asset: string; symbol: string | null; usd: string; count: number }>
  hourly?: Array<{ hour: string; usd: string; count: number }>
}

export interface OracleState {
  symbol: string
  chainlinkPrice: string
  fastPrice: string | null
  gap: string | null
  pressure: boolean
  updatedAt: string
  ageSec: number
  heartbeatSec?: number
  deviation?: number
}

export interface ProviderHealth {
  name: string
  status: 'ok' | 'degraded' | 'down' | 'unknown'
  reportedAt?: string
  circuit?: 'closed' | 'open' | 'half-open'
  p95LatencyMs?: number | null
  successCount?: number
  errorCount?: number
}

export interface ProvidersResponse {
  asOf: string
  providers: ProviderHealth[]
  chains?: Record<string, { status: 'ok' | 'degraded' | 'down' | 'unknown'; providers: string[] }>
  suspectTicks?: { total: number; recent: unknown[] }
  indexer: { coverageStart?: number; backfill?: string } | null
}

export type SignalStateName = 'warming' | 'watching' | 'partial' | 'fired' | 'in_position' | 'paused'

export interface SignalState {
  state: SignalStateName
  reason: string
  symbol?: string
  price?: number
  priceSource?: 'fast' | 'chainlink'
  equity?: number
  position?: {
    entryPrice: number
    qty: number
    stopPrice: number
    tpPrice: number
    entryT: number
    highSince: number
  } | null
  pausedUntil?: number | null
  ts?: string
  drop?: number
  z?: number
  liq1h?: number
  high3h?: number
  mean?: number
  sd?: number
  ready?: boolean
}

export interface BotTrade {
  txId: string
  ts: string
  side: 'buy' | 'sell'
  asset: string
  qty: string
  price: string
  fee: string
  ref: string | null
}

export interface BotAccountResponse {
  asOf: string
  mode: Mode
  source: string
  account: { id: string; name: string; kind: string }
  balances: Record<string, string>
  engine: {
    equity: number
    position: {
      entryPrice: number
      qty: number
      stopPrice: number
      tpPrice: number
      entryT: number
      highSince: number
    } | null
    pausedUntil: number | null
    lastExitT: number | null
  }
  trades: BotTrade[]
}

export interface DrillStatus {
  active: boolean
  speed?: number
  phase?: string
  startedAt?: string
  elapsedSec?: number
}

export interface HealthReadyResponse {
  status: 'ready' | 'not_ready'
  checks: Record<string, string>
  chains: Record<string, { status: 'ok' | 'degraded' | 'down' | 'unknown'; providers: string[] }>
}
