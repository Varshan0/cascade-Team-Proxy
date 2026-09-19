// Display formatting. Money arrives as decimal strings; these are for display only.

const MINUS = '−' // the prototype uses a real minus sign

export const dash = '—'

export function fmtInt(n: number | null | undefined): string {
  return n == null ? dash : Math.round(n).toLocaleString('en-US')
}

/** $18.4M / $824K / $950 */
export function fmtUsdCompact(v: string | number | null | undefined): string {
  if (v == null) return dash
  const n = Number(v)
  if (!Number.isFinite(n)) return dash
  const a = Math.abs(n)
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}

/** $182,400 */
export function fmtUsdFull(v: string | number | null | undefined): string {
  if (v == null) return dash
  const n = Number(v)
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-US')}` : dash
}

/** $2,917.02 */
export function fmtPrice(v: string | number | null | undefined): string {
  if (v == null) return dash
  const n = Number(v)
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : dash
}

/** Signed percentage from a percent number: 1.84 -> "+1.84%", -1.28 -> "−1.28%" */
export function fmtPct(pct: number | null | undefined, digits = 2): string {
  if (pct == null || !Number.isFinite(pct)) return dash
  return `${pct < 0 ? MINUS : '+'}${Math.abs(pct).toFixed(digits)}%`
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false })
}

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

/** "3h", "2 days" for a span in ms */
export function fmtSpan(ms: number): string {
  const h = ms / 3_600_000
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)} days`
}

const STATE_LABEL: Record<string, string> = {
  warming: 'WARMING UP',
  watching: 'WATCHING',
  partial: 'PARTIAL SIGNAL',
  fired: 'SIGNAL FIRED',
  in_position: 'IN POSITION',
  paused: 'PAUSED',
}
export const radarLabel = (state: string | undefined) => (state ? (STATE_LABEL[state] ?? state.toUpperCase()) : dash)
