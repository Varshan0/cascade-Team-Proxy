import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM, MarketSim, SimChainlink, rng } from '../src/shared/sim/market';
import { simulateHistory } from '../src/worker/sim-feed';

const T = Date.UTC(2026, 8, 19);
const quiet = { ...DEFAULT_SIM, seed: 1, startPrice: 2000, dropsPerDay: 0, bgLiqPerHour: 0 };
const H = 3_600_000;

describe('market simulator', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const run = (seed: number) => {
      const s = new MarketSim({ ...DEFAULT_SIM, seed, startPrice: 2000 }, T);
      return Array.from({ length: 500 }, () => s.advance(10).price);
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
    const r = rng(9);
    expect(r()).toBeGreaterThanOrEqual(0);
    expect(r()).toBeLessThan(1);
  });

  it('fair value diffuses at ~60% annualised volatility', () => {
    const s = new MarketSim({ ...quiet, seed: 3 }, T);
    const dt = 60;
    const rets: number[] = [];
    let prev = s.price;
    for (let i = 0; i < 40_000; i++) {
      const p = s.advance(dt).price;
      rets.push(Math.log(p / prev));
      prev = p;
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
    const annual = sd * Math.sqrt((365 * 24 * 3600) / dt);
    expect(annual).toBeGreaterThan(0.57);
    expect(annual).toBeLessThan(0.63);
  });

  it('forced selling is a temporary dislocation that reverts with a 12h half-life', () => {
    const s = new MarketSim({ ...quiet, annualVol: 0, seed: 1 }, T);
    const p0 = s.price;
    s.triggerDrop(0.05, 'forced');
    for (let i = 0; i < 3; i++) s.advance(10); // ramp completes over 30s
    const trough = s.price;
    expect(trough).toBeLessThan(p0 * 0.95); // size plus liquidation overshoot
    const gap0 = Math.log(p0 / trough);
    for (let i = 0; i < 12 * 360; i++) s.advance(10); // 12h
    const gap12 = Math.log(p0 / s.price);
    expect(gap12 / gap0).toBeGreaterThan(0.45);
    expect(gap12 / gap0).toBeLessThan(0.55); // ~half remains
    expect(s.fair).toBeCloseTo(p0, 6); // fair value never moved
    for (let i = 0; i < 5 * 24 * 360; i++) s.advance(10);
    expect(s.price).toBeGreaterThan(p0 * 0.999); // fully reverted
  });

  it('real news moves fair value permanently and keeps sliding for ~2h', () => {
    const s = new MarketSim({ ...quiet, annualVol: 0, seed: 1 }, T);
    const p0 = s.price;
    s.triggerDrop(0.04, 'news');
    for (let i = 0; i < 3; i++) s.advance(10);
    const afterRamp = s.fair;
    expect(afterRamp).toBeLessThan(p0 * 0.965);
    for (let i = 0; i < 2 * 360 + 10; i++) s.advance(10);
    expect(s.fair).toBeLessThan(afterRamp * 0.985); // kept sliding after the initial move
    for (let i = 0; i < 3 * 24 * 360; i++) s.advance(10);
    expect(s.fair).toBeLessThan(p0 * 0.945); // permanent: 4% + the 2% slide = exp(-0.06) = 0.9418x; the overshoot fades but fair value never returns
    expect(s.price).toBeLessThan(p0 * 0.95);
  });

  it('every drop overshoots more when more leverage has built up since the last flush, and a flush resets it', () => {
    const drop = (buildDays: number) => {
      const s = new MarketSim({ ...quiet, annualVol: 0, seed: 1 }, T);
      for (let i = 0; i < buildDays * 24 * 6; i++) s.advance(600);
      const p0 = s.price;
      s.triggerDrop(0.05, 'forced');
      for (let i = 0; i < 3; i++) s.advance(10);
      return { overshoot: Math.log(p0 / s.price) - 0.05, s };
    };
    const fresh = drop(0);
    const built = drop(3);
    expect(built.overshoot).toBeGreaterThan(fresh.overshoot * 2);

    // second drop right after a flush: leverage was reset, so much less overshoot
    const p1 = built.s.price;
    built.s.triggerDrop(0.05, 'forced');
    for (let i = 0; i < 3; i++) built.s.advance(10);
    expect(Math.log(p1 / built.s.price) - 0.05).toBeLessThan(built.overshoot / 2);
  });

  it('emits a liquidation burst that scales with leverage and drop size, then stops', () => {
    const total = (buildDays: number, size: number) => {
      const s = new MarketSim({ ...quiet, annualVol: 0, seed: 2 }, T);
      for (let i = 0; i < buildDays * 24 * 6; i++) s.advance(600);
      s.triggerDrop(size, 'forced');
      let sum = 0;
      for (let i = 0; i < 40; i++) sum += s.advance(1).liqs.reduce((a, l) => a + l.usd, 0); // 40s > 25s burst
      const after = s.advance(1).liqs.length;
      return { sum, after };
    };
    const base = total(0, 0.04);
    expect(base.sum).toBeCloseTo(6_000_000 * 1 * 1, -3); // 6M x leverage 1 x (0.04/0.04)
    expect(base.after).toBe(0);
    expect(total(3, 0.04).sum).toBeGreaterThan(base.sum * 3);
    expect(total(0, 0.08).sum).toBeCloseTo(base.sum * 2, -3);
  });

  it('has no built-in trend: news drops are offset by drift, so the market does not collapse over a month', () => {
    const days = 60;
    const rets: number[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const s = new MarketSim({ ...DEFAULT_SIM, seed, startPrice: 2000, bgLiqPerHour: 0, emitLiquidations: false }, T);
      for (let i = 0; i < days * 24 * 6; i++) s.advance(600);
      rets.push(Math.log(s.fair / 2000));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    // without the drift this averages about -1.7 (i.e. price / 5); with it, ~0 (std of the mean is ~0.05)
    expect(Math.abs(mean)).toBeLessThan(0.2);
  });

  it('background liquidations keep a small, steady baseline', () => {
    const s = new MarketSim({ ...DEFAULT_SIM, seed: 4, startPrice: 2000, dropsPerDay: 0 }, T);
    const hourly: number[] = [];
    for (let h = 0; h < 200; h++) {
      let sum = 0;
      for (let i = 0; i < 360; i++) sum += s.advance(10).liqs.reduce((a, l) => a + l.usd, 0);
      hourly.push(sum);
    }
    const mean = hourly.reduce((a, b) => a + b, 0) / hourly.length;
    expect(mean).toBeGreaterThan(50_000);
    expect(mean).toBeLessThan(400_000);
  });

  it('a simulated cascade is visible to the strategy as a large drop AND a large liquidation z-score', async () => {
    const { computeFeatures } = await import('../src/shared/strategy/cascade');
    const s = new MarketSim({ ...DEFAULT_SIM, seed: 8, startPrice: 2000, dropsPerDay: 0, annualVol: 0.3 }, T);
    const prices: { t: number; price: number }[] = [];
    const liqs: { t: number; usd: number }[] = [];
    for (let i = 0; i < 175 * 360; i++) {
      const st = s.advance(10);
      if (i % 6 === 0) prices.push({ t: st.t, price: st.price });
      liqs.push(...st.liqs.map((l) => ({ t: l.t, usd: l.usd })));
    }
    s.triggerDrop(0.06, 'forced');
    let hit = false;
    for (let i = 0; i < 60; i++) {
      const st = s.advance(1);
      liqs.push(...st.liqs.map((l) => ({ t: l.t, usd: l.usd })));
      const f = computeFeatures(st.t, st.price, prices, liqs);
      if (f.drop <= -0.04 && f.z >= 3 && f.liq1h >= 1_000_000) hit = true;
    }
    expect(hit).toBe(true);
  });
});

describe('simulated Chainlink', () => {
  it('lags the market: updates only on >0.5% deviation or the 1h heartbeat', () => {
    const cl = new SimChainlink();
    expect(cl.update(2000, T)).toBe(true); // first round
    expect(cl.update(2004, T + 60_000)).toBe(false); // +0.2%
    expect(cl.update(1992, T + 120_000)).toBe(false); // -0.4%
    expect(cl.update(1985, T + 180_000)).toBe(true); // -0.75%
    expect(cl.answer).toBe(198_500_000_000n);
    const round = cl.roundId;
    expect(cl.update(1985.5, T + 180_000 + H - 1)).toBe(false);
    expect(cl.update(1985.5, T + 180_000 + H)).toBe(true); // heartbeat
    expect(cl.roundId).toBeGreaterThan(round);
  });
});

describe('history generation', () => {
  it('produces contiguous 1m candles, liquidations and oracle rounds in the same shapes the live feed uses', () => {
    const end = Math.floor(T / 60_000) * 60_000;
    const days = 2;
    const cl = new SimChainlink();
    const sim = new MarketSim({ ...DEFAULT_SIM, seed: 11, startPrice: 2600, dropsPerDay: 3 }, end - days * 24 * H);
    const h = simulateHistory(sim, 'ETH-USD', end, cl);
    expect(h.c1m.length).toBeGreaterThan(days * 24 * 60 - 3);
    for (let i = 1; i < h.c1m.length; i++) expect(h.c1m[i]!.t - h.c1m[i - 1]!.t).toBe(60_000);
    for (const c of h.c1m) {
      expect(Number(c.h)).toBeGreaterThanOrEqual(Number(c.l));
      expect(Number(c.h)).toBeGreaterThanOrEqual(Number(c.o));
      expect(Number(c.l)).toBeLessThanOrEqual(Number(c.c));
    }
    expect(h.liqs.length).toBeGreaterThan(50);
    expect(h.rounds.length).toBeGreaterThan(2);
    expect(h.c1m.at(-1)!.t + 60_000).toBeLessThanOrEqual(end);
  });
});
