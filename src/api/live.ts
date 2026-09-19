import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client'
import type {
  BotAccountResponse,
  Candle,
  CandleRange,
  DrillStatus,
  Envelope,
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

export interface LiveState {
  /** Data mode reported by the backend. `drill` while a synthetic drill is running. */
  mode: Mode | null
  /** True while any received frame is synthetic (drill traffic). */
  synthetic: boolean
  connected: boolean
  wsState: 'connected' | 'reconnecting' | 'disconnected'
  quote: Quote | null
  /** Live price: the newest ticker frame, falling back to the last quote. */
  price: string | null
  stats7d: LiquidationStats | null
  stats24h: LiquidationStats | null
  oracle: OracleState | null
  providers: ProvidersResponse | null
  providersFetchedAt: number | null
  liquidations: Liquidation[]
  signal: SignalState | null
  instruments: Instrument[]
  selectedSymbol: string
  selectedRange: CandleRange
  chartCandles: Candle[]
  chartLoading: boolean
  botAccount: BotAccountResponse | null
  drillActive: boolean
  drillStatus: DrillStatus | null
  healthReady: HealthReadyResponse | null
  lastUpdateTs: number
}

const EMPTY: LiveState = {
  mode: null,
  synthetic: false,
  connected: false,
  wsState: 'disconnected',
  quote: null,
  price: null,
  stats7d: null,
  stats24h: null,
  oracle: null,
  providers: null,
  providersFetchedAt: null,
  liquidations: [],
  signal: null,
  instruments: [
    { symbol: 'ETH-USD', base: 'ETH', quote: 'USD', name: 'Ethereum', sortOrder: 1 },
    { symbol: 'BTC-USD', base: 'BTC', quote: 'USD', name: 'Bitcoin', sortOrder: 2 },
  ],
  selectedSymbol: 'ETH-USD',
  selectedRange: '1D',
  chartCandles: [],
  chartLoading: false,
  botAccount: null,
  drillActive: false,
  drillStatus: null,
  healthReady: null,
  lastUpdateTs: Date.now(),
}

const KEEP = 20
const keyOf = (l: Liquidation) => `${l.txHash}:${l.logIndex ?? 0}`

export function useLive() {
  const [s, setS] = useState<LiveState>(EMPTY)
  const symbolRef = useRef(s.selectedSymbol)
  symbolRef.current = s.selectedSymbol

  const patch = useCallback((p: Partial<LiveState>) => {
    setS((prev) => ({ ...prev, ...p, lastUpdateTs: Date.now() }))
  }, [])

  // Load candles for the currently active instrument and range
  const loadCandles = useCallback(async (sym: string, rng: CandleRange) => {
    patch({ chartLoading: true })
    try {
      const res = await api.candles(sym, { range: rng, limit: 120 })
      patch({ chartCandles: res.candles, chartLoading: false })
    } catch {
      patch({ chartLoading: false })
    }
  }, [patch])

  const selectSymbol = useCallback((sym: string) => {
    patch({ selectedSymbol: sym, price: null, quote: null })
    loadCandles(sym, s.selectedRange)
    api.quote(sym).then((r) => patch({ quote: r.quote, mode: r.mode, price: r.quote.price })).catch(() => {})
  }, [patch, loadCandles, s.selectedRange])

  const selectRange = useCallback((rng: CandleRange) => {
    patch({ selectedRange: rng })
    loadCandles(symbolRef.current, rng)
  }, [patch, loadCandles])

  const triggerDrill = useCallback(async (speed = 20) => {
    try {
      await api.triggerDrill(speed)
      patch({ synthetic: true, drillActive: true, mode: 'drill' })
      const st = await api.drillStatus().catch(() => null)
      if (st) patch({ drillStatus: st })
    } catch (e) {
      console.error('[drill]', e)
    }
  }, [patch])

  useEffect(() => {
    const ac = new AbortController()
    const quiet = <T,>(p: Promise<T>, then: (v: T) => void) =>
      p.then(then).catch((e) => {
        if (e?.name !== 'AbortError') console.debug('[api]', e?.message ?? e)
      })

    const sym = symbolRef.current

    // Initial load
    quiet(api.instruments(ac.signal), (r) => patch({ instruments: r.instruments, mode: r.mode }))
    quiet(api.quote(sym, ac.signal), (r) => patch({ quote: r.quote, mode: r.mode, price: r.quote.price }))
    quiet(api.oracle(sym, ac.signal), (r) => patch({ oracle: r.oracle }))
    quiet(api.signalState(ac.signal), (r) => patch({ signal: r.state, synthetic: r.synthetic, drillActive: r.drillActive }))
    quiet(api.liquidationStats('7d', ac.signal), (r) => patch({ stats7d: r }))
    quiet(api.liquidationStats('24h', ac.signal), (r) => patch({ stats24h: r }))
    quiet(api.providers(ac.signal), (r) => patch({ providers: r, providersFetchedAt: Date.now() }))
    quiet(api.liquidations(KEEP, ac.signal), (r) => patch({ liquidations: r.items }))
    quiet(api.bot(ac.signal), (r) => patch({ botAccount: r }))
    quiet(api.healthReady(ac.signal), (r) => patch({ healthReady: r }))
    quiet(api.demoStatus(ac.signal), (r) => patch({ mode: r.mode, drillActive: r.drillActive }))
    loadCandles(sym, '1D')

    const fastTimer = setInterval(() => {
      quiet(api.quote(symbolRef.current), (r) => patch({ quote: r.quote }))
      quiet(api.signalState(), (r) => patch({ signal: r.state, synthetic: r.synthetic, drillActive: r.drillActive }))
      quiet(api.bot(), (r) => patch({ botAccount: r }))
      quiet(api.healthReady(), (r) => patch({ healthReady: r }))
    }, 8_000)

    const slowTimer = setInterval(() => {
      quiet(api.liquidationStats('7d'), (r) => patch({ stats7d: r }))
      quiet(api.liquidationStats('24h'), (r) => patch({ stats24h: r }))
      quiet(api.providers(), (r) => patch({ providers: r, providersFetchedAt: Date.now() }))
    }, 25_000)

    // WebSocket connection
    let ws: WebSocket | null = null
    let retry = 0
    let closed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    const getChannels = (currSym: string) => [
      `ticker:${currSym}`,
      `oracle:${currSym}`,
      `candles:${currSym}:1m`,
      'liquidations',
      'signal',
    ]

    const onFrame = (f: Envelope) => {
      if (f.synthetic) {
        setS((p) => ({ ...p, synthetic: true, mode: 'drill', drillActive: true, lastUpdateTs: Date.now() }))
      } else if (f.type === 'snapshot' && !f.synthetic) {
        setS((p) => (p.drillActive ? { ...p, synthetic: false, drillActive: false, mode: f.mode, lastUpdateTs: Date.now() } : p))
      }

      if (f.channel.startsWith('ticker:') && f.data) {
        const d = f.data as { symbol?: string; price: string }
        if (!d.symbol || d.symbol === symbolRef.current) {
          patch({ price: d.price })
        }
      } else if (f.channel.startsWith('oracle:') && f.data) {
        patch({ oracle: f.data as OracleState })
      } else if (f.channel === 'signal' && f.data) {
        const d = f.data as Partial<SignalState> & { drill?: unknown }
        // drill "done" frames carry no strategy state; merging keeps the last valid signal instead of crashing the UI
        if (typeof d.state === 'string') setS((p) => ({ ...p, signal: { ...p.signal, ...d } as SignalState }))
      } else if (f.channel.startsWith('candles:') && f.data) {
        if (f.type === 'update') {
          const c = f.data as Candle
          setS((prev) => {
            const list = [...prev.chartCandles]
            if (list.length > 0 && list[list.length - 1]?.t === c.t) {
              list[list.length - 1] = c
            } else if (list.length > 0) {
              list.push(c)
              if (list.length > 150) list.shift()
            }
            return { ...prev, chartCandles: list, lastUpdateTs: Date.now() }
          })
        }
      } else if (f.channel === 'liquidations') {
        if (f.type === 'snapshot' && Array.isArray(f.data)) {
          patch({ liquidations: (f.data as Liquidation[]).slice(0, KEEP) })
        } else if (f.data) {
          const d = f.data as { type: string; event?: Liquidation; txHash?: string; logIndex?: number }
          if (d.type === 'liquidation' && d.event) {
            setS((p) => {
              const ev = d.event as Liquidation
              const rest = p.liquidations.filter((l) => keyOf(l) !== keyOf(ev))
              return { ...p, liquidations: [ev, ...rest].slice(0, KEEP), lastUpdateTs: Date.now() }
            })
          } else if (d.type === 'removed') {
            setS((p) => ({
              ...p,
              liquidations: p.liquidations.filter(
                (l) => !(l.txHash === d.txHash && (l.logIndex ?? 0) === (d.logIndex ?? 0)),
              ),
              lastUpdateTs: Date.now(),
            }))
          }
        }
      }
    }

    const connect = () => {
      if (closed) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      patch({ wsState: 'reconnecting' })

      ws.onopen = () => {
        retry = 0
        patch({ connected: true, wsState: 'connected' })
        ws?.send(JSON.stringify({ op: 'subscribe', channels: getChannels(symbolRef.current) }))
      }

      ws.onmessage = (e) => {
        try {
          const f = JSON.parse(String(e.data)) as Envelope
          if (f.channel) onFrame(f)
        } catch {
          // ignore frame parse error
        }
      }

      ws.onclose = () => {
        patch({ connected: false, wsState: closed ? 'disconnected' : 'reconnecting' })
        if (closed) return
        reconnectTimer = setTimeout(connect, Math.min(15_000, 800 * 2 ** retry++))
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      closed = true
      ac.abort()
      clearInterval(fastTimer)
      clearInterval(slowTimer)
      clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [patch, loadCandles])

  return {
    ...s,
    selectSymbol,
    selectRange,
    triggerDrill,
    loadCandles,
  }
}
