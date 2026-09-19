/**
 * Offline market simulator (spec section 11).
 *
 * A hidden fair value follows a random walk (60% annualised vol). Sudden drops arrive at random. A share are
 * "real news" (fair value falls and keeps sliding); the rest are "forced selling" (a temporary dislocation that
 * reverts with a 12h half-life). EVERY drop adds a liquidation-driven overshoot that scales with the leverage
 * built up since the last flush, and emits a burst of liquidation events.
 *
 * Deterministic for a given seed, so it is unit-testable and history is reproducible.
 */

export interface SimParams {
  seed: number;
  startPrice: number;
  annualVol: number;
  dropsPerDay: number;
  /** Share of drops that are real news (permanent) rather than forced selling (reverting). */
  pNews: number;
  /** Half-life of the forced-selling dislocation. */
  halfLifeMs: number;
  emitLiquidations: boolean;
  /** Background (non-cascade) liquidations per hour. Default 3. */
  bgLiqPerHour?: number;
}

export const DEFAULT_SIM: Omit<SimParams, 'seed' | 'startPrice'> = {
  annualVol: 0.6,
  dropsPerDay: 1.2,
  pNews: 0.35,
  halfLifeMs: 12 * 3_600_000,
  emitLiquidations: true,
};

export interface SimLiq {
  t: number;
  usd: number;
}

export interface SimStep {
  t: number;
  price: number;
  fair: number;
  liqs: SimLiq[];
  drop?: { kind: 'news' | 'forced'; size: number; leverage: number };
}

const YEAR_S = 365 * 24 * 3600;

/** mulberry32: small, fast, seedable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Impact {
  dFair: number;
  dDisloc: number;
  durMs: number;
  leftMs: number;
}
interface Burst {
  totalUsd: number;
  durMs: number;
  leftMs: number;
}

export class MarketSim {
  t: number;
  private rand: () => number;
  private lnFair: number;
  private disloc = 0; // log-price dislocation from fair value (negative after a drop), decays with the half-life
  private leverage = 1; // builds with time, resets on a flush
  private impacts: Impact[] = [];
  private bursts: Burst[] = [];
  private spare: number | null = null;
  private scale: number;
  /**
   * Continuous upward drift (log, per second) that offsets the EXPECTED permanent loss from news drops, so the
   * market has no built-in trend: E[size] = 0.02 + 0.06 * E[u^1.5] = 0.044, and a news drop costs 1.5x its size
   * (the move plus the 0.5x slide). Without this the sim loses ~2.8%/day and halves within a month.
   */
  private drift: number;

  constructor(private p: SimParams, startT: number) {
    this.t = startT;
    this.rand = rng(p.seed);
    this.scale = p.startPrice;
    this.lnFair = 0;
    this.drift = (p.dropsPerDay * p.pNews * 0.044 * 1.5) / 86_400;
  }

  get price(): number {
    return this.scale * Math.exp(this.lnFair + this.disloc);
  }
  get fair(): number {
    return this.scale * Math.exp(this.lnFair);
  }

  private gauss(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    const u = Math.max(this.rand(), 1e-12);
    const v = this.rand();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Force a drop now (used by tests and the drill's optional live-sim trigger). */
  triggerDrop(size: number, kind: 'news' | 'forced'): SimStep['drop'] {
    const lev = this.leverage;
    const overshoot = 0.4 * size * Math.min(lev, 3); // liquidation-driven, scales with built-up leverage
    if (kind === 'news') {
      this.impacts.push({ dFair: -size, dDisloc: -overshoot, durMs: 30_000, leftMs: 30_000 });
      this.impacts.push({ dFair: -0.5 * size, dDisloc: 0, durMs: 2 * 3_600_000, leftMs: 2 * 3_600_000 }); // keeps sliding
    } else {
      this.impacts.push({ dFair: 0, dDisloc: -(size + overshoot), durMs: 30_000, leftMs: 30_000 });
    }
    if (this.p.emitLiquidations) {
      this.bursts.push({ totalUsd: 6_000_000 * Math.max(0.4, lev) * (size / 0.04), durMs: 25_000, leftMs: 25_000 });
    }
    this.leverage = 0.2; // the flush
    return { kind, size, leverage: lev };
  }

  advance(dtSec: number): SimStep {
    const dtMs = dtSec * 1000;
    this.t += dtMs;
    this.lnFair += this.drift * dtSec + this.p.annualVol * Math.sqrt(dtSec / YEAR_S) * this.gauss();
    this.disloc *= Math.pow(0.5, dtMs / this.p.halfLifeMs);
    this.leverage = Math.min(4, this.leverage + dtMs / (24 * 3_600_000));

    let drop: SimStep['drop'];
    const lambda = this.p.dropsPerDay / 86_400;
    if (this.rand() < 1 - Math.exp(-lambda * dtSec)) {
      const size = 0.02 + 0.06 * Math.pow(this.rand(), 1.5); // 2% .. 8%
      drop = this.triggerDrop(size, this.rand() < this.p.pNews ? 'news' : 'forced');
    }

    // ramp queued impacts in over their duration
    for (const im of this.impacts) {
      const used = Math.min(dtMs, im.leftMs);
      const f = used / im.durMs;
      this.lnFair += im.dFair * f;
      this.disloc += im.dDisloc * f;
      im.leftMs -= used;
    }
    this.impacts = this.impacts.filter((i) => i.leftMs > 0);

    const liqs: SimLiq[] = [];
    if (this.p.emitLiquidations) {
      for (const b of this.bursts) {
        const used = Math.min(dtMs, b.leftMs);
        const usd = (b.totalUsd * used) / b.durMs;
        const k = Math.max(1, Math.round(used / 2000));
        let weights = Array.from({ length: k }, () => 0.5 + this.rand());
        const sum = weights.reduce((a, c) => a + c, 0);
        weights = weights.map((w) => w / sum);
        weights.forEach((w) => liqs.push({ t: this.t, usd: usd * w }));
        b.leftMs -= used;
      }
      this.bursts = this.bursts.filter((b) => b.leftMs > 0);
      // background liquidations: ~3/hour, lognormal around $40k
      let n = 0;
      for (let L = Math.exp(-((this.p.bgLiqPerHour ?? 3) / 3600) * dtSec), pp = 1; ; n++) {
        pp *= this.rand();
        if (pp <= L) break;
      }
      for (let i = 0; i < n; i++) liqs.push({ t: this.t, usd: 40_000 * Math.exp(this.gauss()) });
    }
    return { t: this.t, price: this.price, fair: this.fair, liqs, drop };
  }
}

/** Chainlink emulation: updates only on a >0.5% deviation or the 1h heartbeat, so it lags the fast price. */
export class SimChainlink {
  private last = 0;
  private lastT = 0;
  private round = 0;
  answer = 0n;
  updatedAt = 0; // unix seconds
  roundId = 0n;

  constructor(private deviation = 0.005, private heartbeatMs = 3_600_000) {}

  /** Returns true if a new round was produced. */
  update(price: number, t: number): boolean {
    if (this.round > 0 && Math.abs(price / this.last - 1) <= this.deviation && t - this.lastT < this.heartbeatMs) return false;
    this.round++;
    this.last = price;
    this.lastT = t;
    this.answer = BigInt(Math.round(price * 1e8));
    this.updatedAt = Math.floor(t / 1000);
    this.roundId = (1n << 64n) | BigInt(this.round);
    return true;
  }
}
