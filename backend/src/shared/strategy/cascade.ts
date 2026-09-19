/**
 * Cascade Catcher: buy the forced-selling overshoot after a liquidation cascade.
 *
 * Pure and deterministic: identical code runs in live mode, drill mode and (later) backtests.
 * `step()` never reads the clock or any data newer than `input.t` (see the no-look-ahead test).
 * Floats are used here on purpose (spec: fine for derived analytics); the bot's ledger uses decimals.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface CascadeParams {
  dropThresh: number; // 0.04 = 4%
  zThresh: number;
  minLiqUsd: number;
  riskPerTrade: number;
  stopPct: number;
  tpFrac: number;
  timeStopMs: number;
  feePct: number; // per side
  slipPct: number; // normal
  slipCascadePct: number; // on cascade entries
  cooldownMs: number;
  breakerStops: number;
  breakerWindowMs: number;
  breakerPauseMs: number;
  /** Look-back for the high the drop is measured from. */
  dropWindowMs: number;
  /** Hourly liquidation sums forming the baseline. */
  baselineHours: number;
  /** Floor on the baseline std-dev (USD) so quiet markets don't make z explode. */
  sdFloor: number;
}

export const DEFAULT_PARAMS: CascadeParams = {
  dropThresh: 0.04,
  zThresh: 3,
  minLiqUsd: 1_000_000,
  riskPerTrade: 0.02,
  stopPct: 0.06,
  tpFrac: 0.5,
  timeStopMs: 48 * HOUR,
  feePct: 0.001,
  slipPct: 0.0005,
  slipCascadePct: 0.0015,
  cooldownMs: 30 * 60_000,
  breakerStops: 2,
  breakerWindowMs: 7 * DAY,
  breakerPauseMs: 7 * DAY,
  dropWindowMs: 3 * HOUR,
  baselineHours: 168,
  sdFloor: 10_000,
};

export interface PricePoint {
  t: number; // ms
  price: number;
}
export interface LiqEvent {
  t: number; // ms
  usd: number;
}

export interface Features {
  price: number;
  high3h: number;
  drop: number; // price / high3h - 1 (<= 0)
  liq1h: number;
  mean: number;
  sd: number;
  z: number;
}

/** Warm-up needed before a signal is meaningful: the baseline plus the 1h window under test. */
export const warmupMs = (p: CascadeParams): number => (p.baselineHours + 1) * HOUR;

/**
 * Features at time `t` from the signal price, price history and liquidations.
 * Only data with timestamp <= t is read, so callers may safely pass a longer series.
 */
export function computeFeatures(t: number, price: number, prices: PricePoint[], liqs: LiqEvent[], p: CascadeParams = DEFAULT_PARAMS): Features {
  let high = price;
  for (const pt of prices) if (pt.t <= t && pt.t >= t - p.dropWindowMs && pt.price > high) high = pt.price;

  let liq1h = 0;
  const hourly = new Array<number>(p.baselineHours).fill(0);
  for (const e of liqs) {
    if (e.t > t) continue; // no look-ahead
    if (e.t > t - HOUR) liq1h += e.usd; // (t-1h, t]
    else {
      // hour k covers (t-(k+2)h, t-(k+1)h]; k = 0 is the hour just before the window under test
      const k = Math.floor((t - HOUR - e.t) / HOUR);
      if (k >= 0 && k < p.baselineHours) hourly[k]! += e.usd;
    }
  }
  const mean = hourly.reduce((a, b) => a + b, 0) / p.baselineHours;
  const variance = hourly.reduce((a, b) => a + (b - mean) ** 2, 0) / p.baselineHours; // population variance
  const sd = Math.sqrt(variance);
  return { price, high3h: high, drop: price / high - 1, liq1h, mean, sd, z: (liq1h - mean) / Math.max(sd, p.sdFloor) };
}

export type SignalStateName = 'warming' | 'watching' | 'partial' | 'fired' | 'in_position' | 'paused';

export interface Position {
  entryT: number;
  /** Fill price including entry slippage. */
  entry: number;
  qty: number;
  notional: number;
  feeEntry: number;
  stop: number;
  target: number;
  high3hAtEntry: number;
}

export interface EngineState {
  /** Account equity while flat (the position is sized off this). */
  equity: number;
  position: Position | null;
  lastExitT: number | null;
  stopOuts: number[];
  pausedUntil: number | null;
}

export const initialState = (equity: number): EngineState => ({ equity, position: null, lastExitT: null, stopOuts: [], pausedUntil: null });

export interface StepInput {
  t: number;
  /** Signal price at t: fast price if fresh (<5 min), otherwise Chainlink; chosen by the caller. */
  price: number;
  prices: PricePoint[];
  liqs: LiqEvent[];
  /** Earliest time for which liquidation history is trustworthy. */
  historyStart: number;
}

export interface SignalOutput {
  state: SignalStateName;
  drop: number;
  z: number;
  liq1h: number;
  mean: number;
  thresholds: { dropThresh: number; zThresh: number; minLiqUsd: number };
  met: { drop: boolean; z: boolean; liq: boolean };
  reason: string;
}

export type ExitReason = 'stop' | 'target' | 'time';
export type TradeEvent =
  | { type: 'entry'; t: number; price: number; qty: number; notional: number; fee: number; stop: number; target: number }
  | { type: 'exit'; t: number; price: number; qty: number; reason: ExitReason; pnl: number; fee: number; equityAfter: number };

const usd = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n).toLocaleString('en-US')}`);
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function step(prev: EngineState, input: StepInput, p: CascadeParams = DEFAULT_PARAMS): { state: EngineState; signal: SignalOutput; events: TradeEvent[] } {
  const { t } = input;
  const f = computeFeatures(t, input.price, input.prices, input.liqs, p);
  const state: EngineState = { ...prev, stopOuts: [...prev.stopOuts] };
  const events: TradeEvent[] = [];

  const met = { drop: f.drop <= -p.dropThresh, z: f.z >= p.zThresh, liq: f.liq1h >= p.minLiqUsd };
  const meters = `drop ${pct(f.drop)} (need <= -${pct(p.dropThresh)}) ${met.drop ? '✓' : '✗'} · z ${f.z.toFixed(2)} (need >= ${p.zThresh}) ${met.z ? '✓' : '✗'} · liq 1h ${usd(f.liq1h)} (need >= ${usd(p.minLiqUsd)}) ${met.liq ? '✓' : '✗'}`;
  const out = (name: SignalStateName, reason: string): SignalOutput => ({
    state: name,
    drop: f.drop,
    z: f.z,
    liq1h: f.liq1h,
    mean: f.mean,
    thresholds: { dropThresh: p.dropThresh, zThresh: p.zThresh, minLiqUsd: p.minLiqUsd },
    met,
    reason,
  });

  // A pause that has run its course also forgives the stop-outs that caused it.
  if (state.pausedUntil !== null && t >= state.pausedUntil) {
    state.pausedUntil = null;
    state.stopOuts = [];
  }

  // ---- exits (whichever comes first: stop, target, time stop)
  let exitedThisStep: ExitReason | null = null;
  const pos = state.position;
  if (pos) {
    let reason: ExitReason | null = null;
    let ref = input.price;
    if (input.price <= pos.stop) {
      reason = 'stop'; // fill at the market: if price gapped through the stop we take the gap
    } else if (input.price >= pos.target) {
      reason = 'target';
      ref = pos.target; // resting limit: conservatively no price improvement
    } else if (t - pos.entryT >= p.timeStopMs) {
      reason = 'time';
    }
    if (reason) {
      const exit = ref * (1 - p.slipPct);
      const proceeds = pos.qty * exit;
      const fee = proceeds * p.feePct;
      const pnl = proceeds - pos.notional - pos.feeEntry - fee;
      state.equity += pnl;
      state.position = null;
      state.lastExitT = t;
      exitedThisStep = reason;
      events.push({ type: 'exit', t, price: exit, qty: pos.qty, reason, pnl, fee, equityAfter: state.equity });
      if (reason === 'stop') {
        state.stopOuts = state.stopOuts.filter((s) => t - s < p.breakerWindowMs);
        state.stopOuts.push(t);
        if (state.stopOuts.length >= p.breakerStops) state.pausedUntil = t + p.breakerPauseMs;
      }
    }
  }

  // ---- state resolution
  if (state.pausedUntil !== null && t < state.pausedUntil) {
    return { state, signal: out('paused', `circuit breaker: ${p.breakerStops} stop-outs within ${p.breakerWindowMs / DAY}d, paused until ${new Date(state.pausedUntil).toISOString()}`), events };
  }
  if (state.position) {
    const q = state.position;
    return { state, signal: out('in_position', `holding since ${new Date(q.entryT).toISOString()} · stop ${q.stop.toFixed(2)} · target ${q.target.toFixed(2)}`), events };
  }
  if (t - input.historyStart < warmupMs(p)) {
    const have = Math.max(0, Math.floor((t - input.historyStart) / HOUR));
    return { state, signal: out('warming', `warming up: liquidation history covers ${have}h of ${p.baselineHours + 1}h needed`), events };
  }
  if (state.lastExitT !== null && t - state.lastExitT <= p.cooldownMs) {
    const why = exitedThisStep ? `exited via ${exitedThisStep}; ` : '';
    return { state, signal: out('watching', `cooldown: ${why}${Math.ceil((p.cooldownMs - (t - state.lastExitT)) / 60_000)} min until re-entry allowed`), events };
  }

  const n = Number(met.drop) + Number(met.z) + Number(met.liq);
  if (n === 3) {
    const notional = state.equity * Math.min(1, p.riskPerTrade / p.stopPct);
    const entry = input.price * (1 + p.slipCascadePct);
    const fee = notional * p.feePct;
    const position: Position = {
      entryT: t,
      entry,
      qty: notional / entry,
      notional,
      feeEntry: fee,
      stop: entry * (1 - p.stopPct),
      target: entry + p.tpFrac * (f.high3h - entry),
      high3hAtEntry: f.high3h,
    };
    state.position = position;
    events.push({ type: 'entry', t, price: entry, qty: position.qty, notional, fee, stop: position.stop, target: position.target });
    return { state, signal: out('fired', `ENTRY: ${meters}`), events };
  }
  return { state, signal: out(n === 0 ? 'watching' : 'partial', meters), events };
}
