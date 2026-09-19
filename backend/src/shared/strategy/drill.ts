import type { Logger } from 'pino';
import { clearDrillSnapshots, publishChannel, readPrice } from '../bus';
import type { Config } from '../config';
import { rng } from '../sim/market';
import type { Redis } from '../redis';
import { DEFAULT_PARAMS, initialState, step, type CascadeParams, type LiqEvent, type PricePoint, type SignalStateName, type TradeEvent } from './cascade';
import { BOT_START_EQUITY, SIGNAL_SYMBOL, toSignalMessage } from './engine';

const HOUR = 3_600_000;

export interface DrillOptions {
  /** Playback speed multiplier for the real-time pauses (default 1: ~35s wall clock). */
  speed?: number;
  sleep?: (ms: number) => Promise<void>;
  seed?: number;
  crashPct?: number; // 0.065
  burstUsd?: number; // 40_000_000
  params?: CascadeParams;
}

export interface DrillResult {
  id: string;
  startedAt: string;
  endedAt: string;
  crashPct: number;
  burstUsd: number;
  transitions: Array<{ virtualT: string; state: SignalStateName }>;
  trades: TradeEvent[];
  startEquity: number;
  finalEquity: number;
}

export type DrillStatus = { status: 'idle' } | { status: 'running'; id: string; startedAt: string } | ({ status: 'done' } & DrillResult);

const KEY_ACTIVE = 'drill:active';
const KEY_LAST = 'drill:last';
const STEP_MS = 250; // real time between drill frames at speed 1

type DrillDeps = { redis: Redis; config: Pick<Config, 'DEMO_OFFLINE'>; logger: Logger };

export async function isDrillActive(redis: Redis): Promise<boolean> {
  return (await redis.get(KEY_ACTIVE)) === '1';
}

export async function drillStatus(redis: Redis): Promise<DrillStatus> {
  const running = await redis.get('drill:running');
  if (running) return { status: 'running', ...(JSON.parse(running) as { id: string; startedAt: string }) };
  const last = await redis.get(KEY_LAST);
  return last ? { status: 'done', ...(JSON.parse(last) as DrillResult) } : { status: 'idle' };
}

const smooth = (x: number) => x * x * (3 - 2 * x); // smoothstep

/**
 * Inject a synthetic 6.5% crash with ~$40M of liquidations over 20s, then a rebound, into an ISOLATED copy of
 * state. It runs its own in-memory engine + in-memory bot account, publishes only `synthetic: true` messages
 * (namespaced snapshots/sequences), and never reads or writes real candles, liquidations, ledgers or accounts.
 * On exit it clears its own snapshots and tells the gateway to restore live state.
 */
export async function runDrill(deps: DrillDeps, opts: DrillOptions = {}): Promise<DrillResult> {
  const { redis, logger } = deps;
  if ((await redis.set(KEY_ACTIVE, '1', 'EX', 600, 'NX')) === null) throw new Error('a drill is already running');

  const params = opts.params ?? DEFAULT_PARAMS;
  const speed = Math.max(0.1, opts.speed ?? 1);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const crashPct = opts.crashPct ?? 0.065;
  const burstUsd = opts.burstUsd ?? 40_000_000;
  const rand = rng(opts.seed ?? 7);
  const id = crypto.randomUUID();
  const startedAt = new Date();
  const pub = { mode: 'drill' as const, synthetic: true };
  const symbol = SIGNAL_SYMBOL;

  await redis.set('drill:running', JSON.stringify({ id, startedAt: startedAt.toISOString() }), 'EX', 600);
  await redis.publish('ch:drill:events', JSON.stringify({ active: true, id }));
  logger.info({ id, crashPct, burstUsd }, 'drill started (synthetic, isolated)');

  try {
    const live = await readPrice(redis, symbol, true);
    const p0 = live ? Number(live.price) : 2600;
    const t0 = Date.now();

    // ---- isolated inputs: a quiet 169h baseline and a flat 3h price history
    const prices: PricePoint[] = Array.from({ length: 200 }, (_, i) => ({ t: t0 - i * 60_000, price: p0 * (1 + (rand() - 0.5) * 0.0006) })).reverse();
    const liqs: LiqEvent[] = Array.from({ length: 170 }, (_, i) => ({ t: t0 - HOUR - i * HOUR - Math.floor(rand() * HOUR * 0.9), usd: 60_000 + rand() * 120_000 }));
    let state = initialState(BOT_START_EQUITY);
    const historyStart = t0 - 200 * HOUR;

    const transitions: DrillResult['transitions'] = [];
    const trades: TradeEvent[] = [];
    let last: SignalStateName | null = null;
    let seq = 0;
    let forming: { t: number; o: number; h: number; l: number; c: number; v: number } | null = null;

    const frame = async (vt: number, price: number, newLiqs: number[]) => {
      for (const usd of newLiqs) liqs.push({ t: vt, usd });
      prices.push({ t: vt, price });
      const r = step(state, { t: vt, price, prices: prices.filter((p) => p.t <= vt), liqs, historyStart }, params);
      state = r.state;
      trades.push(...r.events);
      if (r.signal.state !== last) {
        last = r.signal.state;
        transitions.push({ virtualT: new Date(vt).toISOString(), state: r.signal.state });
      }
      const minute = Math.floor(vt / 60_000) * 60_000;
      if (!forming || forming.t !== minute) forming = { t: minute, o: price, h: price, l: price, c: price, v: 0 };
      forming.h = Math.max(forming.h, price);
      forming.l = Math.min(forming.l, price);
      forming.c = price;
      forming.v += 1 + rand();
      seq++;

      const iso = new Date(vt).toISOString();
      await publishChannel(redis, 'signal', { ...toSignalMessage(symbol, price, 'fast', r, vt), drill: { id, seq } }, pub);
      await publishChannel(redis, `ticker:${symbol}`, { symbol, price: price.toFixed(2), bid: null, ask: null, ts: iso, source: 'drill', suspect: false }, pub);
      await publishChannel(redis, `candles:${symbol}:1m`, { symbol, interval: '1m', closed: false, candle: { t: forming.t, o: String(forming.o), h: String(forming.h), l: String(forming.l), c: String(forming.c), v: forming.v.toFixed(4), source: 'drill' } }, pub);
      for (const usd of newLiqs) {
        await publishChannel(redis, 'liquidations', { type: 'liquidation', event: { id: -seq, txHash: `0xdrill${seq}`, ts: iso, collateralSymbol: 'WETH', debtSymbol: 'USDC', usdValue: usd.toFixed(2), status: 'synthetic', txUrl: null } }, { ...pub, snapshot: false });
      }
      await sleep(STEP_MS / speed);
    };

    // ---- phase 1: crash. 80 frames x 250ms = 20s of virtual time; price falls over the first 10s, $40M in bursts.
    const crashFrames = 80;
    const weights = Array.from({ length: crashFrames }, (_, i) => (i < 2 ? 0 : 0.4 + rand()));
    const wsum = weights.reduce((a, b) => a + b, 0);
    let trough = p0;
    for (let i = 0; i < crashFrames; i++) {
      const price = p0 * (1 - crashPct * smooth(Math.min(1, i / 40)) + (rand() - 0.5) * 0.0004);
      trough = Math.min(trough, price);
      await frame(t0 + i * STEP_MS, price, weights[i]! > 0 ? [(burstUsd * weights[i]!) / wsum] : []);
    }

    // ---- phase 2: rebound. Each frame advances 5 virtual minutes; price recovers to ~1.5% under the pre-crash level.
    let vt = t0 + crashFrames * STEP_MS;
    const reboundTo = p0 * 0.985;
    for (let j = 1; j <= 60; j++) {
      vt += 5 * 60_000;
      await frame(vt, trough + (reboundTo - trough) * smooth(Math.min(1, j / 40)) + (rand() - 0.5) * 0.0004 * p0, []);
    }
    // ---- phase 3: tail. One more virtual hour so the cooldown clears and the state settles.
    for (let j = 0; j < 12; j++) {
      vt += 5 * 60_000;
      await frame(vt, reboundTo * (1 + (rand() - 0.5) * 0.0004), []);
    }

    const result: DrillResult = {
      id,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      crashPct,
      burstUsd,
      transitions,
      trades,
      startEquity: BOT_START_EQUITY,
      finalEquity: state.equity,
    };
    await publishChannel(redis, 'signal', { drill: { id, done: true, summary: result }, symbol }, pub);
    await redis.set(KEY_LAST, JSON.stringify(result));
    logger.info({ id, finalEquity: result.finalEquity, states: transitions.map((t) => t.state) }, 'drill finished; live state restored');
    return result;
  } finally {
    // Always restore live state, even if the drill threw.
    await clearDrillSnapshots(redis);
    await redis.del(KEY_ACTIVE, 'drill:running');
    await redis.publish('ch:drill:events', JSON.stringify({ active: false, id }));
  }
}
