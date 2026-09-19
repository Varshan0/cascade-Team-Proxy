import Decimal from 'decimal.js';
import { FAILOVER_CHAINS } from '../config';
import { pxGoodKey, pxKey, publishChannel, type PriceSnapshot } from '../bus';
import { modeOf, type Runtime } from '../runtime';

export interface RawTick {
  instrument: string;
  price: Decimal;
  size?: Decimal;
  side?: 'buy' | 'sell';
  ts: number;
  source: string;
  bid?: string;
  ask?: string;
}

export interface Tick extends RawTick {
  suspect: boolean;
}

/** A higher-priority source that produced a tick this recently keeps lower-priority sources out of the feed. */
export const FRESH_MS = 10_000;
/** Sources allowed to vouch for (or against) a price, and how recent their last tick must be. */
export const CROSSCHECK_SOURCES: ReadonlySet<string> = new Set(['coinbase-ws', 'coinbase-rest', 'pyth']);
export const CROSSCHECK_MAX_AGE_MS = 15_000;
/** Sources disagreeing by more than this flag the tick `suspect` (spec: 1.5%). */
export const SUSPECT_PCT = 0.015;

export function isSuspect(price: Decimal, others: Decimal[], pct = SUSPECT_PCT): boolean {
  return others.some((o) => !o.isZero() && price.minus(o).abs().div(o).greaterThan(pct));
}

export class TickPipeline {
  private seen = new Map<string, Map<string, { price: Decimal; at: number }>>();
  private priority = new Map<string, number>(FAILOVER_CHAINS.realtimePrice.map((n, i) => [n, i]));

  constructor(
    private rt: Runtime,
    private sink: (t: Tick) => void,
    private now: () => number = Date.now,
  ) {}

  /**
   * Accept a tick from any source. Every tick is remembered for cross-checking, but only the
   * highest-priority fresh source drives the published feed (Coinbase WS -> Pyth -> Coinbase REST -> CoinGecko).
   */
  handle(raw: RawTick): Tick | null {
    const at = this.now();
    let bySource = this.seen.get(raw.instrument);
    if (!bySource) this.seen.set(raw.instrument, (bySource = new Map()));
    bySource.set(raw.source, { price: raw.price, at });

    const myPrio = this.priority.get(raw.source) ?? Number.MAX_SAFE_INTEGER;
    for (const [src, v] of bySource) {
      if (src !== raw.source && (this.priority.get(src) ?? Infinity) < myPrio && at - v.at < FRESH_MS) return null;
    }

    const others: Decimal[] = [];
    for (const [src, v] of bySource) {
      if (src !== raw.source && CROSSCHECK_SOURCES.has(src) && at - v.at < CROSSCHECK_MAX_AGE_MS) others.push(v.price);
    }
    const tick: Tick = { ...raw, suspect: CROSSCHECK_SOURCES.has(raw.source) && isSuspect(raw.price, others) };

    void this.publish(tick).catch((err) => this.rt.logger.error({ err }, 'tick publish failed'));
    if (tick.suspect) {
      this.rt.logger.warn({ instrument: tick.instrument, price: tick.price.toFixed(), source: tick.source }, 'suspect tick (sources disagree >1.5%)');
    } else {
      this.sink(tick);
    }
    return tick;
  }

  private async publish(t: Tick): Promise<void> {
    const { redis, config } = this.rt;
    const snap: PriceSnapshot = {
      instrument: t.instrument,
      price: t.price.toFixed(),
      ts: new Date(t.ts).toISOString(),
      source: t.source,
      suspect: t.suspect,
      bid: t.bid,
      ask: t.ask,
    };
    const json = JSON.stringify(snap);
    const ops: Promise<unknown>[] = [
      redis.set(pxKey(t.instrument), json),
      publishChannel(redis, `ticker:${t.instrument}`, { symbol: t.instrument, price: snap.price, bid: t.bid ?? null, ask: t.ask ?? null, ts: snap.ts, source: t.source, suspect: t.suspect }, { mode: modeOf(config) }),
    ];
    if (t.suspect) {
      ops.push(redis.lpush('suspect:recent', JSON.stringify(snap)).then(() => redis.ltrim('suspect:recent', 0, 19)));
      ops.push(redis.incr('suspect:count'));
    } else {
      ops.push(redis.set(pxGoodKey(t.instrument), json));
    }
    await Promise.all(ops);
  }
}
