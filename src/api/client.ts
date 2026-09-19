import type {
  BotAccountResponse,
  Candle,
  CandleInterval,
  CandleRange,
  DrillStatus,
  HealthReadyResponse,
  Instrument,
  Liquidation,
  LiquidationStats,
  Mode,
  OracleState,
  ProvidersResponse,
  Quote,
  SignalState,
} from './types'

/** Same-origin in production (Fastify serves this app); Vite proxies to :8080 in `npm run dev`. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' }, signal })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `HTTP ${res.status}`)
  }
  return body as T
}

async function postJson<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `HTTP ${res.status}`)
  }
  return body as T
}

export const api = {
  instruments: (signal?: AbortSignal) =>
    getJson<{ asOf: string; mode: Mode; source: string; instruments: Instrument[] }>('/api/v1/instruments', signal),

  quote: (symbol: string, signal?: AbortSignal) =>
    getJson<{ asOf: string; mode: Mode; source: string; quote: Quote }>(`/api/v1/instruments/${symbol}/quote`, signal),

  candles: (
    symbol: string,
    opts: { range?: CandleRange; interval?: CandleInterval; from?: string; to?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams()
    if (opts.range) params.set('range', opts.range)
    if (opts.interval) params.set('interval', opts.interval)
    if (opts.from) params.set('from', opts.from)
    if (opts.to) params.set('to', opts.to)
    if (opts.limit) params.set('limit', String(opts.limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return getJson<{
      asOf: string
      mode: Mode
      source: string
      symbol: string
      interval: string
      candles: Candle[]
    }>(`/api/v1/instruments/${symbol}/candles${qs}`, signal)
  },

  liquidations: (limit: number, signal?: AbortSignal) =>
    getJson<{ asOf: string; mode: Mode; source: string; items: Liquidation[] }>(`/api/v1/liquidations?limit=${limit}`, signal),

  liquidationStats: (window: '1h' | '24h' | '7d', signal?: AbortSignal) =>
    getJson<{ asOf: string; mode: Mode; source: string } & LiquidationStats>(
      `/api/v1/liquidations/stats?window=${window}`,
      signal,
    ),

  oracle: (symbol: string, signal?: AbortSignal) =>
    getJson<{ asOf: string; mode: Mode; source: string; oracle: OracleState }>(`/api/v1/oracle/${symbol}`, signal),

  providers: (signal?: AbortSignal) => getJson<ProvidersResponse>('/health/providers', signal),

  signalState: (signal?: AbortSignal) =>
    getJson<{ asOf: string; mode: Mode; synthetic: boolean; drillActive: boolean; state: SignalState }>(
      '/api/v1/signals/state',
      signal,
    ),

  bot: (signal?: AbortSignal) => getJson<BotAccountResponse>('/api/v1/signals/bot', signal),

  demoStatus: (signal?: AbortSignal) =>
    getJson<{ mode: Mode; offline: boolean; drillActive: boolean }>('/api/v1/demo/status', signal),

  triggerDrill: (speed = 1, signal?: AbortSignal) =>
    postJson<{ status: 'started'; speed: number }>('/api/v1/demo/drill', { speed }, signal),

  drillStatus: (signal?: AbortSignal) => getJson<DrillStatus>('/api/v1/demo/drill', signal),

  health: (signal?: AbortSignal) => getJson<{ status: 'ok' }>('/health', signal),

  healthReady: (signal?: AbortSignal) => getJson<HealthReadyResponse>('/health/ready', signal),
}
