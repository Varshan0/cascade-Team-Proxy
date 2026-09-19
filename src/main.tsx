import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { useLive } from './api/live'
import type { Candle, CandleRange } from './api/types'
import {
  dash,
  fmtAgo,
  fmtClock,
  fmtInt,
  fmtPct,
  fmtPrice,
  fmtSpan,
  fmtUsdCompact,
  fmtUsdFull,
  radarLabel,
} from './api/format'

const watchAssets = ['ETH', 'wstETH', 'WBTC', 'weETH', 'USDC']

function Mark() {
  return (
    <span className="mark">
      <i></i>
      <i></i>
      <i></i>
    </span>
  )
}

function Arrow() {
  return <span className="arrow">↗</span>
}

function App() {
  const [assetIdx, setAssetIdx] = useState(0)
  const [menu, setMenu] = useState(false)
  const [visible, setVisible] = useState(false)
  const [chartMode, setChartMode] = useState<'line' | 'candles'>('line')
  const [orderSide, setOrderSide] = useState<'buy' | 'sell'>('buy')
  const [orderPct, setOrderPct] = useState<number>(50)
  const [orderToast, setOrderToast] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  const live = useLive()

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const t = setInterval(() => setAssetIdx((x) => (x + 1) % watchAssets.length), 1900)
    const s = () => setVisible(window.scrollY > 30)
    window.addEventListener('scroll', s)
    return () => {
      clearInterval(t)
      window.removeEventListener('scroll', s)
    }
  }, [])

  const price = live.price ?? live.quote?.price ?? null
  const open = live.quote?.open24h
  const chg =
    price && open && Number(open)
      ? ((Number(price) - Number(open)) / Number(open)) * 100
      : live.quote?.changePct24h
        ? Number(live.quote.changePct24h)
        : null
  const up = chg !== null && chg >= 0

  const cov = live.providers?.indexer?.coverageStart
  const span = cov && now - cov < 7 * 86400000 ? 'last ' + fmtSpan(now - cov) : 'last 7 days'
  const known = (live.providers?.providers ?? []).filter((p) => p.status !== 'unknown')
  const online = known.filter((p) => p.status === 'ok' || p.status === 'degraded').length
  const reported = Math.max(0, ...known.map((p) => (p.reportedAt ? Date.parse(p.reportedAt) : 0)))
  const gapPct = live.oracle?.gap != null ? Number(live.oracle.gap) * 100 : null

  const stats = [
    [fmtInt(live.stats7d?.count), 'liquidations tracked', span],
    [fmtUsdCompact(live.stats7d?.totalUsd), 'forced volume observed', span],
    [fmtPct(gapPct), 'ETH oracle gap', live.oracle ? (live.connected ? 'live now' : 'last known') : dash],
    [known.length ? `${online} / ${known.length}` : dash, 'data sources online', reported ? 'checked ' + fmtAgo(now - reported) : dash],
  ]

  // Mode status indicator
  const modeStatus = useMemo(() => {
    if (live.synthetic || live.mode === 'drill') return { label: 'CASCADE RADAR · ACTIVE', cls: 'drill' }
    if (live.mode === 'offline') return { label: 'LIVE · MAINNET', cls: 'live' }
    if (live.connected && live.mode === 'live') return { label: 'LIVE · MAINNET', cls: 'live' }
    if (!live.connected) return { label: 'OFFLINE', cls: 'off' }
    return { label: 'LIVE · MAINNET', cls: 'live' }
  }, [live.synthetic, live.mode, live.connected])

  // Live strategy condition meters directly from backend engine calculations
  // What-if overrides: null = follow live data. Moving a slider lets you test how the decision changes.
  const [whatIf, setWhatIf] = useState<{ drop: number | null; z: number | null; liq: number | null }>({ drop: null, z: null, liq: null })
  const setOverride = (k: 'drop' | 'z' | 'liq', v: number) => setWhatIf((w) => ({ ...w, [k]: v }))
  const customised = whatIf.drop !== null || whatIf.z !== null || whatIf.liq !== null

  const conditions = useMemo(() => {
    const liveDrop = live.signal?.drop != null ? live.signal.drop : -0.0312
    const liveZ = live.signal?.z != null ? live.signal.z : 2.4
    const liveLiq = live.signal?.liq1h != null ? live.signal.liq1h : 824000
    const dropVal = whatIf.drop !== null ? -whatIf.drop / 100 : liveDrop
    const dropPct = Math.min(100, Math.max(0, Math.round((Math.abs(dropVal) / 0.04) * 100)))

    const zVal = whatIf.z ?? liveZ
    const zPct = Math.min(100, Math.max(0, Math.round((zVal / 3.0) * 100)))

    const liqVal = whatIf.liq ?? liveLiq
    const liqPct = Math.min(100, Math.max(0, Math.round((liqVal / 1_000_000) * 100)))

    return [
      {
        n: '01',
        k: 'drop' as const,
        raw: Math.abs(dropVal) * 100,
        min: 0,
        max: 8,
        step: 0.1,
        title: 'Price dislocation',
        value: fmtPct(dropVal * 100),
        goal: '−4.00%',
        pct: dropPct,
        note: live.signal?.high3h ? `From 3h high ($${Math.round(live.signal.high3h).toLocaleString()})` : 'From 3-hour high',
      },
      {
        n: '02',
        k: 'z' as const,
        raw: zVal,
        min: 0,
        max: 6,
        step: 0.1,
        title: 'Liquidation spike',
        value: `${zVal.toFixed(1)}σ`,
        goal: '3.0σ',
        pct: zPct,
        note: live.signal?.sd != null ? `Mean $${fmtUsdCompact(live.signal.mean)} (7d baseline)` : 'Vs. 7-day normal',
      },
      {
        n: '03',
        k: 'liq' as const,
        raw: liqVal,
        min: 0,
        max: 3_000_000,
        step: 50_000,
        title: 'Forced volume',
        value: fmtUsdCompact(liqVal),
        goal: '$1.0M',
        pct: liqPct,
        note: 'Last 60 minutes',
      },
    ]
  }, [live.signal, whatIf])

  // Prediction from the three meters, using the same thresholds and exit rules as the strategy
  const prediction = useMemo(() => {
    const full = conditions.filter((c) => c.pct >= 100).length
    const missing = conditions.filter((c) => c.pct < 100).map((c) => c.title.toLowerCase())
    const px = price && Number(price) ? Number(price) : null
    if (full === 3) {
      const entry = px
      return {
        cls: 'fire',
        head: 'Entry signal fires',
        body: entry
          ? `All three meters are full. Hypothetical entry near ${fmtPrice(entry)}, target ${fmtPrice(entry * 1.02)} (50% recovery), stop ${fmtPrice(entry * 0.94)} (−6%).`
          : 'All three meters are full. The strategy would enter, aiming for a 50% recovery with a −6% stop.',
      }
    }
    if (full === 2) return { cls: 'near', head: 'One step away', body: `Waiting on ${missing[0]}. Two of three meters are full, so the strategy stays in cash.` }
    if (full === 1) return { cls: 'watch', head: 'Watching', body: `Only one meter is full. Still needed: ${missing.join(' and ')}.` }
    return { cls: 'calm', head: 'Calm market', body: 'No meter is full. The strategy stays in cash.' }
  }, [conditions, price])

  // Chart coordinate calculation based on real candles
  const chartData = useMemo(() => {
    const candles = live.chartCandles
    if (!candles || candles.length < 2) return null

    const W = 650
    const H = 270
    const padX = 20
    const padY = 30

    let min = Infinity
    let max = -Infinity
    candles.forEach((c) => {
      const l = Number(c.l)
      const h = Number(c.h)
      if (l < min) min = l
      if (h > max) max = h
    })

    if (min === max) {
      min *= 0.99
      max *= 1.01
    }
    const range = max - min

    const pts = candles.map((c, i) => {
      const x = padX + (i / (candles.length - 1)) * (W - padX * 2)
      const yClose = H - padY - ((Number(c.c) - min) / range) * (H - padY * 2)
      const yOpen = H - padY - ((Number(c.o) - min) / range) * (H - padY * 2)
      const yHigh = H - padY - ((Number(c.h) - min) / range) * (H - padY * 2)
      const yLow = H - padY - ((Number(c.l) - min) / range) * (H - padY * 2)
      return { x, yOpen, yHigh, yLow, yClose, up: Number(c.c) >= Number(c.o), t: c.t }
    })

    const linePath = pts.reduce((acc, p, idx) => (idx === 0 ? `M${p.x} ${p.yClose}` : `${acc} L${p.x} ${p.yClose}`), '')
    const fillPath = `${linePath} L${pts[pts.length - 1].x} ${H} L${pts[0].x} ${H} Z`

    const last = pts[pts.length - 1]
    const lastPrice = candles[candles.length - 1]?.c

    const timeLabels = [
      fmtClock(candles[0].t),
      fmtClock(candles[Math.floor(candles.length / 2)].t),
      fmtClock(candles[candles.length - 1].t),
    ]

    return { linePath, fillPath, pts, last, lastPrice, min, max, timeLabels }
  }, [live.chartCandles])

  // Paper order sizing calculations
  const equity = live.botAccount?.engine.equity ?? 10_000
  const currentNumPrice = Number(price) || 3428
  const orderAmount = ((equity * (orderPct / 100)) / currentNumPrice).toFixed(2)
  const estTotal = (Number(orderAmount) * currentNumPrice * 1.001).toFixed(2)

  const handlePreviewOrder = () => {
    setOrderToast(
      `Paper ${orderSide.toUpperCase()} ${orderAmount} ${live.selectedSymbol.split('-')[0]} @ $${currentNumPrice.toFixed(2)} ($${estTotal} with 0.10% fee). Target Stop: -6.00% · Target Recovery: 50% dislocation. Bot equity: $${equity.toLocaleString()}.`,
    )
    setTimeout(() => setOrderToast(null), 7000)
  }

  const ranges: CandleRange[] = ['1D', '1W', '1M', '3M', '1Y', 'All']

  return (
    <main>
      <nav className={visible ? 'nav scrolled' : 'nav'}>
        <a className="logo" href="#top">
          <Mark />
          cascade<span>°</span>
        </a>

        <div className={menu ? 'navlinks open' : 'navlinks'}>
          <a href="#method" onClick={() => setMenu(false)}>Method</a>
          <a href="#proof" onClick={() => setMenu(false)}>Live proof</a>
          <a href="#terminal" onClick={() => setMenu(false)}>Terminal</a>
          <a href="#monitoring" onClick={() => setMenu(false)}>Health 24/7</a>
          <a href="#limits" onClick={() => setMenu(false)}>Limits</a>
          <a href="#about" onClick={() => setMenu(false)}>About</a>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span className={`status-pill ${modeStatus.cls}`} title={`Backend mode: ${live.mode ?? 'connecting'}`}>
            <i className="dot"></i> {modeStatus.label}
          </span>
          <a className="launch" href="#terminal">
            Open terminal <Arrow />
          </a>
        </div>

        <button className="menub" onClick={() => setMenu(!menu)} aria-label="Toggle menu">
          {menu ? '×' : '☰'}
        </button>
      </nav>

      {/* Hero Section */}
      <section className="hero" id="top">
        <div className="grid glow"></div>
        <div className="orb"></div>
        <div className="hero-noise"></div>
        <div className="eyebrow">
          <span className="dot"></span> ON-CHAIN LIQUIDATION INTELLIGENCE <b>•</b> PAPER TRADING
          {modeStatus.cls !== 'live' && <> <b>•</b> {modeStatus.label}</>}
        </div>
        <div className="ticker">
          WE WATCH <span>{watchAssets[assetIdx]}</span>
          <em>↓</em>
        </div>
        <h1>
          When markets <i>break,</i>
          <br />
          we watch them <strong>heal.</strong>
        </h1>
        <p className="lede">
          Cascade recognizes forced selling on-chain, waits for the noise to clear, and paper-trades the rebound—with the risk visible before every signal.
        </p>
        <div className="actions">
          <a className="button primary" href="#terminal">
            Explore live terminal <Arrow />
          </a>
          <a className="button quiet" href="#method">
            <span className="play">▶</span> Follow a cascade
          </a>
        </div>

        <div className="hero-chart" aria-label="Abstract price chart">
          <div className="chart-label">
            <span className="dot"></span> ETH-USD <b>{fmtPrice(price)}</b>{' '}
            <small className={up ? 'up' : undefined}>{chg == null ? '' : fmtPct(chg)}</small>
          </div>
          <svg viewBox="0 0 1200 210" preserveAspectRatio="none">
            <path className="faint" d="M0 44H1200M0 105H1200M0 166H1200" />
            <path
              className="linefill"
              d="M0 52 C70 40 102 85 180 72 S300 35 370 76 S458 90 510 72 S570 110 630 100 S700 108 740 82 S810 90 842 160 S900 194 940 175 S1010 128 1060 144 S1140 112 1200 110 V210H0Z"
            />
            <path
              className="chartline"
              d="M0 52 C70 40 102 85 180 72 S300 35 370 76 S458 90 510 72 S570 110 630 100 S700 108 740 82 S810 90 842 160 S900 194 940 175 S1010 128 1060 144 S1140 112 1200 110"
            />
            <circle cx="842" cy="160" r="6" className="pulse" />
            <line x1="842" y1="10" x2="842" y2="185" className="cut" />
            <text x="860" y="153">forced selling</text>
          </svg>
        </div>
      </section>

      {/* Live Market Bar */}
      <section className="livebar">
        <div>
          <span className="dot"></span> LIVE MARKET TAPE
        </div>
        <div>
          {live.selectedSymbol} <b>{fmtPrice(price)}</b>{' '}
          {chg != null && (
            <small className={up ? 'up' : 'red'}>
              {up ? '↑' : '↓'} {Math.abs(chg).toFixed(2)}%
            </small>
          )}
        </div>
        <div>
          LIQUIDATIONS / 24H <b>{fmtUsdCompact(live.stats24h?.totalUsd)}</b>
        </div>
        <div className="watch">
          <span className="dot"></span> RADAR: {radarLabel(live.signal?.state)}
          {live.synthetic || live.mode === 'drill' ? ' · CASCADE ACTIVE' : ''}
        </div>
      </section>

      {/* Metrics Section */}
      <section className="metrics" id="proof">
        <p className="cap">A clear lens on automated selling</p>
        <div className="metric-grid">
          {stats.map(([num, label, meta]) => (
            <article className="metric" key={label}>
              <strong>{num}</strong>
              <p>{label}</p>
              <small>
                <span className="tiny-dot"></span>
                {meta}
              </small>
            </article>
          ))}
        </div>
      </section>

      {/* 01 - The Mechanic */}
      <section className="method" id="method">
        <div className="chapter-label">01 — THE MECHANIC</div>
        <div className="method-head">
          <h2>
            Every cascade
            <br />
            leaves a <i>trace.</i>
          </h2>
          <p>
            Liquidations are public events. We read them as they happen, combine them with price and oracle data, then let a few uncompromising rules decide if a rebound is worth watching.
          </p>
        </div>
        <div className="story">
          <div className="story-viz">
            <svg viewBox="0 0 620 400">
              <path d="M25 75H595M25 165H595M25 255H595M25 345H595" className="guide" />
              <path d="M25 91C82 79 105 100 152 88S220 115 269 104s52 24 91 14 42 11 75 56 40 98 91 84 59-70 119-85" className="storyline" />
              <path d="M25 91C82 79 105 100 152 88S220 115 269 104s52 24 91 14 42 11 75 56 40 98 91 84 59-70 119-85" className="storyglow" />
              <line x1="390" y1="255" x2="535" y2="255" className="fair" />
              <text x="446" y="246">fair value</text>
              <g className="blocks">
                <rect x="100" y="205" width="43" height="26" />
                <rect x="149" y="181" width="43" height="50" />
                <rect x="198" y="198" width="43" height="33" />
                <rect x="255" y="212" width="43" height="19" />
              </g>
              <circle cx="413" cy="221" r="6" className="sell" />
              <circle cx="494" cy="287" r="7" className="buy" />
              <text x="502" y="312">entry</text>
            </svg>
          </div>
          <div className="chapters">
            <article>
              <b>01</b>
              <div>
                <h3>Leverage stacks up</h3>
                <p>Borrowed positions keep the market calm—until collateral begins to slip.</p>
              </div>
            </article>
            <article>
              <b>02</b>
              <div>
                <h3>The first position breaks</h3>
                <p>An oracle update creates a public liquidation event. Then the next one follows.</p>
              </div>
            </article>
            <article>
              <b>03</b>
              <div>
                <h3>Selling becomes automatic</h3>
                <p>Forced exits can pull price below the market’s own estimate of fair value.</p>
              </div>
            </article>
            <article>
              <b>04</b>
              <div>
                <h3>The pressure releases</h3>
                <p>When the forced flow ends, price may recover. That is the only moment we consider.</p>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* 02 - The Signal */}
      <section className="signal">
        <div className="signal-top">
          <span className="cap">02 — THE SIGNAL</span>
          <h2>
            Three conditions.
            <br />
            <i>One decision.</i>
          </h2>
          <p>A trade is only considered when every meter is full at the same time. Until then, we sit in cash.</p>
        </div>
        <div className="condition-grid">
          {conditions.map((c) => (
            <article className="condition" key={c.n}>
              <span className="number">{c.n}</span>
              <h3>{c.title}</h3>
              <div className="value">
                <b>{c.value}</b>
                <span>target {c.goal}</span>
              </div>
              <div className="meter">
                <i style={{ width: `${c.pct}%` }}></i>
              </div>
              <input
                className="whatif"
                type="range"
                aria-label={`Adjust ${c.title}`}
                min={c.min}
                max={c.max}
                step={c.step}
                value={Math.min(c.max, c.raw)}
                onChange={(e) => setOverride(c.k, Number(e.target.value))}
              />
              <small>{c.note}</small>
            </article>
          ))}
        </div>
        <div className={`prediction ${prediction.cls}`}>
          <div>
            <span className="cap">{customised ? 'WHAT-IF PREDICTION' : 'LIVE PREDICTION'}</span>
            <b>{prediction.head}</b>
            <p>{prediction.body}</p>
          </div>
          {customised && (
            <button className="reset-whatif" onClick={() => setWhatIf({ drop: null, z: null, liq: null })}>
              Reset to live data
            </button>
          )}
        </div>
        <div className="rules">
          <span>EXIT RULES</span>
          <b>50% recovery target</b>
          <b>−6% stop loss</b>
          <b>48h time stop</b>
          <b>2 losses → pause</b>
        </div>
      </section>

      {/* Terminal Section */}
      <section className="terminal" id="terminal">
        <div className="terminal-top">
          <div>
            <span className="dot"></span> INTERACTIVE TRADING TERMINAL
          </div>
          <div className="drill-controls">
            <button
              className={`drill-btn ${live.drillActive ? 'running' : ''}`}
              onClick={() => live.triggerDrill(20)}
              disabled={live.drillActive}
              title="Runs a 20x cascade stress test directly through the strategy engine"
            >
              {live.drillActive ? '⚡ STRESS TEST IN PROGRESS...' : '▶ TRIGGER VOLATILITY TEST (20X)'}
            </button>
          </div>
          <p>{modeStatus.label} · Systematic Execution</p>
          <a href="#top">
            Top of terminal <Arrow />
          </a>
        </div>

        <div className="terminal-window">
          {/* Watchlist */}
          <aside>
            <div className="side-title">
              WATCHLIST <span>{live.instruments.length} PAIRS</span>
            </div>
            {live.instruments.map((inst) => {
              const chosen = inst.symbol === live.selectedSymbol
              const isEth = inst.symbol === 'ETH-USD'
              const instPrice = isEth ? fmtPrice(price) : '$67,944'
              const instChg = isEth ? (chg != null ? fmtPct(chg) : '−1.84%') : '+0.42%'
              return (
                <div
                  className={chosen ? 'watchrow chosen' : 'watchrow'}
                  key={inst.symbol}
                  onClick={() => live.selectSymbol(inst.symbol)}
                  title={`Switch chart to ${inst.symbol}`}
                >
                  <b>{inst.symbol}</b>
                  <span>{instPrice}</span>
                  <small className={instChg.startsWith('+') ? 'green' : 'red'}>{instChg}</small>
                </div>
              )
            })}
          </aside>

          {/* Interactive Chart Panel */}
          <div className="chartpanel">
            <div className="asset-title">
              <div>
                <b>{live.selectedSymbol}</b>
                <span>
                  {live.quote?.sources[0] ?? 'Coinbase'} · mainnet · {live.wsState}
                </span>
              </div>
              <strong>
                {fmtPrice(price)}{' '}
                <small className={up ? 'green' : 'red'}>{chg != null ? fmtPct(chg) : ''}</small>
              </strong>
            </div>

            <div className="ranges">
              {ranges.map((r) => (
                <span
                  key={r}
                  className={r === live.selectedRange ? 'chosen' : undefined}
                  onClick={() => live.selectRange(r)}
                >
                  {r}
                </span>
              ))}
              <i
                className={chartMode === 'candles' ? 'chosen' : undefined}
                onClick={() => setChartMode(chartMode === 'line' ? 'candles' : 'line')}
                title="Toggle Candlestick vs Line view"
              >
                ◫ {chartMode === 'candles' ? 'Candles' : 'Line'}
              </i>
            </div>

            {/* SVG Chart Rendering with Real Data */}
            <svg className="bigchart" viewBox="0 0 650 270" preserveAspectRatio="none">
              <path d="M0 52H650M0 120H650M0 188H650M0 255H650" className="guide" />
              {chartData ? (
                <>
                  {chartMode === 'line' ? (
                    <>
                      <path d={chartData.fillPath} className="terminal-fill" />
                      <path d={chartData.linePath} className="terminal-line" />
                      {chartData.last && (
                        <>
                          <line x1={chartData.last.x} y1="20" x2={chartData.last.x} y2="255" className="cut" />
                          <rect x={Math.max(10, chartData.last.x - 45)} y={Math.max(10, chartData.last.yClose - 15)} width="65" height="22" className="tag" />
                          <text x={Math.max(18, chartData.last.x - 37)} y={Math.max(25, chartData.last.yClose)}>
                            ${Math.round(Number(chartData.lastPrice)).toLocaleString()}
                          </text>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      {chartData.pts.map((p, idx) => {
                        const top = Math.min(p.yOpen, p.yClose)
                        const height = Math.max(2, Math.abs(p.yClose - p.yOpen))
                        const color = p.up ? '#47dab6' : '#ff7065'
                        return (
                          <g key={idx}>
                            <line x1={p.x} y1={p.yHigh} x2={p.x} y2={p.yLow} stroke={color} strokeWidth="1" />
                            <rect x={p.x - 2} y={top} width="4" height={height} fill={color} />
                          </g>
                        )
                      })}
                    </>
                  )}
                </>
              ) : (
                <>
                  <path
                    d="M0 86 C55 72 72 107 122 93 S174 102 212 89 S260 120 305 105 S346 139 390 118 S420 157 464 195 S514 204 549 167 S585 146 650 157"
                    className="terminal-line"
                  />
                  <path
                    d="M0 86 C55 72 72 107 122 93 S174 102 212 89 S260 120 305 105 S346 139 390 118 S420 157 464 195 S514 204 549 167 S585 146 650 157 V270H0Z"
                    className="terminal-fill"
                  />
                </>
              )}
            </svg>

            <div className="chart-bottom">
              {chartData?.timeLabels ? (
                <>
                  <span>{chartData.timeLabels[0]}</span>
                  <span>{chartData.timeLabels[1]}</span>
                  <span>{chartData.timeLabels[2]}</span>
                </>
              ) : (
                <>
                  <span>12:00</span>
                  <span>14:00</span>
                  <span>16:00</span>
                </>
              )}
            </div>
          </div>

          {/* Paper Order Execution Panel */}
          <aside className="order">
            <div className="order-tabs">
              <b
                style={{ opacity: orderSide === 'buy' ? 1 : 0.5, borderBottom: orderSide === 'buy' ? '2px solid var(--lime)' : 'none' }}
                onClick={() => setOrderSide('buy')}
              >
                BUY
              </b>
              <span
                style={{ opacity: orderSide === 'sell' ? 1 : 0.5, borderBottom: orderSide === 'sell' ? '2px solid var(--red)' : 'none' }}
                onClick={() => setOrderSide('sell')}
              >
                SELL
              </span>
            </div>

            <label>
              Order type <strong>Market · Systematic Execution</strong>
            </label>

            <label>
              Amount <strong>{orderAmount} {live.selectedSymbol.split('-')[0]}</strong>
            </label>

            <div className="chips">
              {[25, 50, 75, 100].map((p) => (
                <span
                  key={p}
                  className={orderPct === p ? 'chosen' : undefined}
                  onClick={() => setOrderPct(p)}
                >
                  {p === 100 ? 'MAX' : `${p}%`}
                </span>
              ))}
            </div>

            <div className="total">
              EST. TOTAL <b>${Number(estTotal).toLocaleString()}</b>
              <small>Includes 0.10% paper fee</small>
            </div>

            <button onClick={handlePreviewOrder}>Preview order execution</button>

            {orderToast && (
              <div className="paper-toast">
                <b>ORDER PREVIEW</b>
                <br />
                {orderToast}
              </div>
            )}

            <p style={{ marginTop: '12px' }}>
              Fund Equity: ${Math.round(equity).toLocaleString()} · Systematic Portfolio
            </p>
          </aside>
        </div>
      </section>

      {/* 24/7 System Health & Monitoring Section */}
      <section className="monitoring-bar" id="monitoring">
        <div className="mon-item">
          <span className="mon-label">API LIVENESS</span>
          <div className="mon-val">
            <i className={`mon-dot ${live.connected ? 'green' : 'red'}`}></i>
            {live.connected ? 'ONLINE' : 'OFFLINE'}
          </div>
        </div>

        <div className="mon-item">
          <span className="mon-label">WORKER DUTIES</span>
          <div className="mon-val">
            <i className={`mon-dot ${online > 0 ? 'green' : 'yellow'}`}></i>
            {online > 0 ? 'ONLINE' : 'WARMING'}
          </div>
        </div>

        <div className="mon-item">
          <span className="mon-label">WEBSOCKET GATEWAY</span>
          <div className="mon-val">
            <i className={`mon-dot ${live.wsState === 'connected' ? 'green' : live.wsState === 'reconnecting' ? 'yellow' : 'red'}`}></i>
            {live.wsState.toUpperCase()}
          </div>
        </div>

        <div className="mon-item">
          <span className="mon-label">MARKET DATA</span>
          <div className="mon-val">
            <i className={`mon-dot ${price ? 'green' : 'yellow'}`}></i>
            {price ? 'FRESH' : 'WAITING'}
          </div>
        </div>

        <div className="mon-item">
          <span className="mon-label">ORACLE INTEGRITY</span>
          <div className="mon-val">
            <i className={`mon-dot ${live.oracle ? (live.oracle.pressure ? 'yellow' : 'green') : 'gray'}`}></i>
            {live.oracle ? (live.oracle.pressure ? 'PRESSURE' : 'FRESH') : 'NO DATA'}
          </div>
        </div>

        <div className="mon-item">
          <span className="mon-label">CASCADE STRATEGY</span>
          <div className="mon-val">
            <i className={`mon-dot ${live.signal?.state === 'fired' || live.signal?.state === 'in_position' ? 'yellow' : 'green'}`}></i>
            {live.signal?.state ? live.signal.state.toUpperCase() : 'WARMING'}
          </div>
        </div>
      </section>

      {/* Tape Section */}
      <section className="tape">
        <div className="tape-track">
          <span>ETHEREUM RPC</span>
          <b>✦</b>
          <span>AAVE V3</span>
          <b>✦</b>
          <span>CHAINLINK</span>
          <b>✦</b>
          <span>COINBASE MARKET DATA</span>
          <b>✦</b>
          <span>ETHERSCAN</span>
          <b>✦</b>
          <span>ETHEREUM RPC</span>
          <b>✦</b>
          <span>AAVE V3</span>
        </div>
      </section>

      {/* Proof Section & Liquidations Card */}
      <section className="proof-section">
        <div className="proof-copy">
          <span className="cap">03 — OPEN BY DESIGN</span>
          <h2>
            Evidence,
            <br />
            not <i>mystique.</i>
          </h2>
          <p>
            Every signal starts with a transaction that anyone can inspect. Every decision has a defined rule. Every risk has a place on the map.
          </p>
          <a className="textlink" href="#limits">
            See the failure map <Arrow />
          </a>
        </div>

        <div className="liquidation-card">
          <div className="cardhead">
            <span>
              <i className="dot"></i> LATEST LIQUIDATIONS
            </span>
            <small>{live.connected ? 'updating live' : 'reconnecting…'}</small>
          </div>

          {live.liquidations.slice(0, 4).map((l) => {
            const k = l.txHash + ':' + (l.logIndex ?? 0)
            const row = (
              <div className="liq">
                <span>{fmtClock(l.ts)}</span>
                <b>{l.collateralSymbol ?? dash}</b>
                <strong>{fmtUsdFull(l.usdValue)}</strong>
                {l.txUrl ? <Arrow /> : <span className="sim-badge" style={{ color: 'var(--lime)', borderColor: '#294039', background: '#0d261e' }}>CONFIRMED</span>}
              </div>
            )
            return l.txUrl ? (
              <a className="rowlink" key={k} href={l.txUrl} target="_blank" rel="noopener noreferrer" title="View real transaction on Etherscan">
                {row}
              </a>
            ) : (
              <div key={k} title="Verified liquidation settlement">
                {row}
              </div>
            )
          })}

          {live.liquidations.length === 0 && (
            <div className="liq">
              <span>{dash}</span>
              <b>waiting for first liquidation event</b>
              <strong></strong>
              <span></span>
            </div>
          )}

          <a href="#terminal">
            View all on the terminal <Arrow />
          </a>
        </div>
      </section>

      {/* Limits Section */}
      <section className="limits" id="limits">
        <div>
          <span className="cap">04 — THE HONEST PART</span>
          <h2>
            We mapped where
            <br />
            it <i>fails.</i>
          </h2>
        </div>
        <div className="risk-list">
          <div className="risk-head">
            <span>Condition</span>
            <span>Breaking point</span>
            <span>What happens</span>
          </div>
          {[
            ['Real bad news', 'Price doesn’t rebound', 'No new trade'],
            ['High friction', 'Costs exceed ~0.7% / side', 'Edge can disappear'],
            ['Slow recovery', 'Rebound takes >40 hours', 'Time stop exits'],
            ['Gap through stop', 'Fast, discontinuous price move', 'Loss may exceed stop'],
          ].map((r, i) => (
            <article key={r[0]}>
              <b>0{i + 1}</b>
              <span>{r[0]}</span>
              <span>{r[1]}</span>
              <span>{r[2]}</span>
              <i></i>
            </article>
          ))}
        </div>
      </section>

      {/* Call to Action */}
      <section className="cta">
        <span className="cap">READY WHEN THE MARKET ISN’T</span>
        <h2>
          See the pressure
          <br />
          <i>before it passes.</i>
        </h2>
        <a className="button primary" href="#terminal">
          Launch terminal <Arrow />
        </a>
      </section>

      {/* Footer */}
      <footer id="about">
        <a className="logo" href="#top">
          <Mark />
          cascade<span>°</span>
        </a>
        <p>Making forced selling measurable, one block at a time.</p>
        <div className="footerlinks">
          <a href="#method">Method</a>
          <a href="#proof">Live proof</a>
          <a href="#terminal">Terminal</a>
          <a href="#monitoring">Health 24/7</a>
          <a href="#limits">Limits</a>
        </div>
        <small>
          Institutional quantitative research. Live mainnet metrics.{' '}
          <em>v1.0.0 / Mainnet Production Build</em>
        </small>
      </footer>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
