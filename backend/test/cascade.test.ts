import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS as P, computeFeatures, initialState, step, warmupMs, type EngineState, type LiqEvent, type PricePoint, type StepInput } from '../src/shared/strategy/cascade';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 8, 19, 12, 0, 0);
const HISTORY_START = T0 - 400 * H; // comfortably past warm-up

/** A quiet week: $100k of liquidations every hour, then whatever the test adds. */
const quietBaseline = (t: number, perHour = 100_000): LiqEvent[] => Array.from({ length: 170 }, (_, i) => ({ t: t - H - i * H - 30 * 60_000, usd: perHour }));
const flat = (t: number, price = 2000): PricePoint[] => Array.from({ length: 200 }, (_, i) => ({ t: t - i * 60_000, price }));

/** A crash input: price 5% under the 3h high, $2M liquidated in the last hour on a $100k/h baseline. */
function crash(t: number, over: Partial<StepInput> = {}): StepInput {
  return { t, price: 1900, prices: flat(t, 2000), liqs: [...quietBaseline(t), { t: t - 10 * 60_000, usd: 2_000_000 }], historyStart: HISTORY_START, ...over };
}

describe('features', () => {
  it('drop = price / max(price over [t-3h, t]) - 1, including the boundary and excluding older highs', () => {
    const t = T0;
    const prices: PricePoint[] = [
      { t: t - 3 * H - 1, price: 5000 }, // just outside the window: ignored
      { t: t - 3 * H, price: 2200 }, // exactly on the boundary: counts
      { t: t - H, price: 2100 },
    ];
    const f = computeFeatures(t, 2000, prices, []);
    expect(f.high3h).toBe(2200);
    expect(f.drop).toBeCloseTo(2000 / 2200 - 1, 12);
    expect(computeFeatures(t, 2300, prices, []).drop).toBe(0); // price is its own high
  });

  it('liq_1h sums (t-1h, t]; an event exactly at t-1h belongs to the baseline, not the window', () => {
    const t = T0;
    const liqs: LiqEvent[] = [
      { t, usd: 1 }, // included
      { t: t - H + 1, usd: 10 }, // included
      { t: t - H, usd: 1000 }, // baseline hour 0
      { t: t + 1, usd: 99999 }, // future: ignored
    ];
    const f = computeFeatures(t, 2000, [], liqs);
    expect(f.liq1h).toBe(11);
    expect(f.mean).toBeCloseTo(1000 / 168, 9);
  });

  it('z uses 168 hourly baseline sums (population sd) and floors sd at $10,000', () => {
    const t = T0;
    // one baseline hour holds $168k, the other 167 hold nothing
    const liqs: LiqEvent[] = [{ t: t - 5 * H - 1, usd: 168_000 }, { t: t - 10 * 60_000, usd: 500_000 }];
    const f = computeFeatures(t, 2000, [], liqs);
    const mean = 1000;
    const sd = Math.sqrt(((168_000 - mean) ** 2 + 167 * mean ** 2) / 168);
    expect(f.mean).toBeCloseTo(mean, 9);
    expect(f.sd).toBeCloseTo(sd, 6);
    expect(f.z).toBeCloseTo((500_000 - mean) / sd, 9);

    const quiet = computeFeatures(t, 2000, [], [{ t: t - 60_000, usd: 100_000 }]);
    expect(quiet.sd).toBe(0);
    expect(quiet.z).toBeCloseTo(100_000 / 10_000, 9); // floored, not divided by zero
  });

  it('ignores liquidations older than the 168h baseline', () => {
    const f = computeFeatures(T0, 2000, [], [{ t: T0 - 169 * H - 5, usd: 1e9 }]);
    expect(f.mean).toBe(0);
  });
});

describe('entry rules', () => {
  it('fires only when drop, z and liq all hold, and sizes off equity', () => {
    const r = step(initialState(10_000), crash(T0));
    expect(r.signal.state).toBe('fired');
    expect(r.signal.met).toEqual({ drop: true, z: true, liq: true });
    const e = r.events[0]!;
    expect(e.type).toBe('entry');
    if (e.type !== 'entry') return;
    // notional = equity * min(1, 2%/6%) = 3,333.33; cascade slippage 0.15%; fee 0.10% of notional
    expect(e.notional).toBeCloseTo(10_000 / 3, 6);
    expect(e.price).toBeCloseTo(1900 * 1.0015, 9);
    expect(e.fee).toBeCloseTo((10_000 / 3) * 0.001, 9);
    expect(e.stop).toBeCloseTo(e.price * 0.94, 9);
    expect(e.target).toBeCloseTo(e.price + 0.5 * (2000 - e.price), 9); // halfway back to the 3h high
    expect(r.state.position).not.toBeNull();
  });

  it.each([
    ['price drop too small (-3%)', { price: 1940 }],
    ['liquidations too small (< $1M) even though z is high', { liqs: [...quietBaseline(T0, 1_000), { t: T0 - 60_000, usd: 900_000 }] }],
    ['z too low (a busy baseline) even though liq >= $1M', { liqs: quietBaseline(T0, 1_500_000).concat([{ t: T0 - 60_000, usd: 1_600_000 }]).map((e, i) => (i % 2 ? { ...e, usd: e.usd * 2 } : e)) }],
  ])('does not enter when %s', (_name, over) => {
    const r = step(initialState(10_000), crash(T0, over as Partial<StepInput>));
    expect(r.signal.state).not.toBe('fired');
    expect(r.events).toHaveLength(0);
    expect(['partial', 'watching']).toContain(r.signal.state);
  });

  it('reports partial when some but not all conditions hold, and watching when none do', () => {
    const partial = step(initialState(10_000), crash(T0, { price: 1940 })); // liq+z ok, drop not
    expect(partial.signal.state).toBe('partial');
    expect(partial.signal.met).toEqual({ drop: false, z: true, liq: true });
    const none = step(initialState(10_000), { t: T0, price: 2000, prices: flat(T0), liqs: quietBaseline(T0), historyStart: HISTORY_START });
    expect(none.signal.state).toBe('watching');
  });

  it('never opens a second position while one is open', () => {
    const first = step(initialState(10_000), crash(T0));
    const second = step(first.state, crash(T0 + 60_000));
    expect(second.signal.state).toBe('in_position');
    expect(second.events).toHaveLength(0);
  });

  it('warms up until 169h of liquidation history exist', () => {
    const r = step(initialState(10_000), crash(T0, { historyStart: T0 - 40 * H }));
    expect(r.signal.state).toBe('warming');
    expect(r.signal.reason).toMatch(/40h of 169h/);
    expect(r.events).toHaveLength(0);
    expect(warmupMs(P)).toBe(169 * H);
  });
});

describe('exits, costs and equity', () => {
  const enter = () => step(initialState(10_000), crash(T0)).state;
  const at = (t: number, price: number, s: EngineState) => step(s, { t, price, prices: flat(t, price), liqs: quietBaseline(t), historyStart: HISTORY_START });

  it('stop-loss at entry x 0.94 realises a loss with fees and slippage on both sides', () => {
    const s = enter();
    const pos = s.position!;
    const r = at(T0 + 10 * 60_000, pos.stop - 5, s);
    const x = r.events[0]!;
    expect(x.type === 'exit' && x.reason).toBe('stop');
    if (x.type !== 'exit') return;
    const exit = (pos.stop - 5) * (1 - P.slipPct); // gapped through the stop: fills at market
    const proceeds = pos.qty * exit;
    expect(x.pnl).toBeCloseTo(proceeds - pos.notional - pos.feeEntry - proceeds * P.feePct, 6);
    expect(x.pnl).toBeLessThan(0);
    expect(r.state.equity).toBeCloseTo(10_000 + x.pnl, 6);
    expect(r.state.position).toBeNull();
  });

  it('a loss no worse than ~2% of equity plus costs (that is what 2%-risk / 6%-stop sizing means)', () => {
    const s = enter();
    const r = at(T0 + 60_000, s.position!.stop, s); // exactly at the stop
    const x = r.events[0]!;
    if (x.type !== 'exit') throw new Error('expected exit');
    expect(-x.pnl / 10_000).toBeGreaterThan(0.02);
    expect(-x.pnl / 10_000).toBeLessThan(0.025);
  });

  it('take-profit fills at the target level (no price improvement) and books a gain', () => {
    const s = enter();
    const pos = s.position!;
    const r = at(T0 + 3 * H, pos.target + 20, s);
    const x = r.events[0]!;
    if (x.type !== 'exit') throw new Error('expected exit');
    expect(x.reason).toBe('target');
    expect(x.price).toBeCloseTo(pos.target * (1 - P.slipPct), 9);
    expect(x.pnl).toBeGreaterThan(0);
  });

  it('time stop after 48h', () => {
    const s = enter();
    const before = at(T0 + 47 * H, s.position!.entry, s);
    expect(before.signal.state).toBe('in_position');
    const r = at(T0 + 48 * H, s.position!.entry, s);
    const x = r.events[0]!;
    expect(x.type === 'exit' && x.reason).toBe('time');
  });

  it('30-minute cooldown after an exit blocks re-entry even on a fresh cascade', () => {
    const s = enter();
    const exit = at(T0 + 3 * H, s.position!.target + 20, s);
    const t1 = T0 + 3 * H + 10 * 60_000;
    const blocked = step(exit.state, crash(t1));
    expect(blocked.signal.state).toBe('watching');
    expect(blocked.signal.reason).toMatch(/cooldown/);
    const t2 = T0 + 3 * H + 31 * 60_000;
    expect(step(exit.state, crash(t2)).signal.state).toBe('fired');
  });
});

describe('circuit breaker', () => {
  const stopOutAt = (s: EngineState, t: number): EngineState => {
    const entered = step(s, crash(t)).state; // enter
    const pos = entered.position!;
    return step(entered, { t: t + 60_000, price: pos.stop - 1, prices: flat(t, pos.stop), liqs: quietBaseline(t), historyStart: HISTORY_START }).state;
  };

  it('two stop-outs within 7 days pause the strategy for 7 days, then it resumes', () => {
    let s = stopOutAt(initialState(10_000), T0);
    expect(s.pausedUntil).toBeNull(); // one stop is fine
    s = stopOutAt(s, T0 + 2 * D);
    expect(s.pausedUntil).toBe(T0 + 2 * D + 60_000 + 7 * D);

    const during = step(s, crash(T0 + 5 * D));
    expect(during.signal.state).toBe('paused');
    expect(during.events).toHaveLength(0);

    const after = step(s, crash(s.pausedUntil! + 60_000));
    expect(after.signal.state).toBe('fired');
    expect(after.state.pausedUntil).toBeNull();
  });

  it('two stop-outs more than 7 days apart do not trip it', () => {
    let s = stopOutAt(initialState(10_000), T0);
    s = stopOutAt(s, T0 + 8 * D);
    expect(s.pausedUntil).toBeNull();
  });

  it('only stop-outs count: a target exit does not', () => {
    const entered = step(initialState(10_000), crash(T0)).state;
    const won = step(entered, { t: T0 + 2 * H, price: entered.position!.target + 10, prices: flat(T0), liqs: quietBaseline(T0), historyStart: HISTORY_START }).state;
    expect(won.stopOuts).toHaveLength(0);
  });
});

describe('no look-ahead', () => {
  it('the signal at t is identical whether or not data after t exists', () => {
    const t = T0;
    const base = crash(t);
    const clean = step(initialState(10_000), base);

    const futurePrices: PricePoint[] = [{ t: t + 60_000, price: 9999 }, { t: t + 5 * H, price: 1 }];
    const futureLiqs: LiqEvent[] = [{ t: t + 1, usd: 5e9 }, { t: t + 2 * H, usd: 5e9 }];
    const polluted = step(initialState(10_000), { ...base, prices: [...base.prices, ...futurePrices], liqs: [...base.liqs, ...futureLiqs] });

    expect(polluted.signal).toEqual(clean.signal);
    expect(polluted.events).toEqual(clean.events);
    expect(polluted.state).toEqual(clean.state);
  });

  it('features at t ignore anything timestamped after t, however extreme', () => {
    const t = T0;
    const a = computeFeatures(t, 2000, flat(t), quietBaseline(t));
    const b = computeFeatures(t, 2000, [...flat(t), { t: t + 1, price: 1e9 }], [...quietBaseline(t), { t: t + 1, usd: 1e12 }]);
    expect(b).toEqual(a);
  });

  it('step is pure: the input state is never mutated', () => {
    const s = initialState(10_000);
    const snapshot = JSON.stringify(s);
    step(s, crash(T0));
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});
