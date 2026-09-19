import Decimal from 'decimal.js';
import { and, eq, gt, lte, isNotNull } from 'drizzle-orm';
import { publishChannel, readPrice } from '../bus';
import { indexerState, liquidations, signalEvents } from '../db/schema';
import { balances, deposit, ensureAccount, recordTrade } from '../ledger';
import { loadRange } from '../market/store';
import { modeOf, type Runtime } from '../runtime';
import { HOUR } from '../time';
import { DEFAULT_PARAMS, initialState, step, warmupMs, type CascadeParams, type EngineState, type LiqEvent, type PricePoint, type SignalOutput, type TradeEvent } from './cascade';

export const SIGNAL_SYMBOL = 'ETH-USD';
export const BOT_START_EQUITY = 10_000;
/** A fast price older than this falls back to Chainlink (spec: fresh within 5 minutes). */
export const FAST_FRESH_MS = 5 * 60_000;
export const COVERAGE_KEY = 'liq:coverage:start';

export interface SignalMessage extends SignalOutput {
  symbol: string;
  price: number;
  priceSource: 'fast' | 'chainlink';
  equity: number;
  position: EngineState['position'];
  pausedUntil: number | null;
  ts: string;
}

export const toSignalMessage = (symbol: string, price: number, priceSource: SignalMessage['priceSource'], r: { signal: SignalOutput; state: EngineState }, t: number): SignalMessage => ({
  ...r.signal,
  symbol,
  price,
  priceSource,
  equity: r.state.equity,
  position: r.state.position,
  pausedUntil: r.state.pausedUntil,
  ts: new Date(t).toISOString(),
});

/**
 * Live signal engine: gathers inputs (price, 1m closes, liquidations), runs the pure `step`,
 * books trades on the bot's own paper account, records state transitions and publishes on `signal`.
 */
export class SignalEngine {
  private state: EngineState | null = null;
  private lastSignalState: string | null = null;
  private botId = '';
  private systemId = '';
  private stateKey: string;

  constructor(private rt: Runtime, private params: CascadeParams = DEFAULT_PARAMS, private symbol = SIGNAL_SYMBOL) {
    this.stateKey = `signal-engine:${symbol}`;
  }

  async init(): Promise<void> {
    const { db } = this.rt;
    this.botId = await ensureAccount(db, 'bot', 'cascade-bot');
    this.systemId = await ensureAccount(db, 'system', 'system');
    const bal = await balances(db, this.botId);
    if (!bal.USD) await deposit(db, this.botId, this.systemId, new Decimal(BOT_START_EQUITY), 'initial-capital');
    const [row] = await db.select().from(indexerState).where(eq(indexerState.key, this.stateKey));
    const saved = row?.meta as { state?: EngineState; lastSignalState?: string } | null | undefined;
    this.state = saved?.state ?? initialState((await balances(db, this.botId)).USD?.toNumber() ?? BOT_START_EQUITY);
    this.lastSignalState = saved?.lastSignalState ?? null;
  }

  get botAccountId(): string {
    return this.botId;
  }

  private async persist(): Promise<void> {
    const meta = { state: this.state, lastSignalState: this.lastSignalState };
    await this.rt.db
      .insert(indexerState)
      .values({ key: this.stateKey, lastBlock: 0, meta })
      .onConflictDoUpdate({ target: indexerState.key, set: { meta, updatedAt: new Date() } });
  }

  /** Signal price: the fast price if it is fresh, otherwise the Chainlink price (spec section 6). */
  private async signalPrice(now: number): Promise<{ price: number; source: SignalMessage['priceSource'] } | null> {
    const fast = await readPrice(this.rt.redis, this.symbol, true);
    if (fast && now - Date.parse(fast.ts) <= FAST_FRESH_MS) return { price: Number(fast.price), source: 'fast' };
    const raw = await this.rt.redis.get(`snap:oracle:${this.symbol}`);
    const cl = raw ? (JSON.parse(raw) as { data?: { chainlinkPrice?: string } }).data?.chainlinkPrice : undefined;
    return cl ? { price: Number(cl), source: 'chainlink' } : null;
  }

  async evaluate(now = Date.now()): Promise<SignalMessage | null> {
    if (!this.state) await this.init();
    const sp = await this.signalPrice(now);
    if (!sp) return null;
    const { db, redis } = this.rt;

    // Closed 1m candles only: a candle's close is unknown until its minute ends.
    const candles = await loadRange(db, this.symbol, '1m', now - this.params.dropWindowMs - 120_000, now);
    const prices: PricePoint[] = candles.filter((c) => c.t + 60_000 <= now).map((c) => ({ t: c.t + 60_000, price: Number(c.c) }));

    const rows = await db
      .select({ ts: liquidations.ts, usd: liquidations.usdValue })
      .from(liquidations)
      .where(and(gt(liquidations.ts, new Date(now - warmupMs(this.params))), lte(liquidations.ts, new Date(now)), isNotNull(liquidations.usdValue)));
    const liqs: LiqEvent[] = rows.map((r) => ({ t: r.ts.getTime(), usd: Number(r.usd) }));

    const cov = Number(await redis.get(COVERAGE_KEY));
    const historyStart = Number.isFinite(cov) && cov > 0 ? cov : now; // unknown coverage = still warming

    const result = step(this.state!, { t: now, price: sp.price, prices, liqs, historyStart }, this.params);
    this.state = result.state;
    for (const ev of result.events) await this.book(ev);

    const msg = toSignalMessage(this.symbol, sp.price, sp.source, result, now);
    if (result.signal.state !== this.lastSignalState) {
      this.lastSignalState = result.signal.state;
      await db.insert(signalEvents).values({
        ts: new Date(now),
        state: result.signal.state,
        mode: modeOf(this.rt.config),
        payload: { signal: msg, events: result.events },
      });
    }
    await this.persist();
    await publishChannel(redis, 'signal', msg, { mode: modeOf(this.rt.config) });
    return msg;
  }

  /** Paper-trade the bot's own account (never a user's). */
  private async book(ev: TradeEvent): Promise<void> {
    const base = this.symbol.split('-')[0]!;
    await recordTrade(this.rt.db, {
      accountId: this.botId,
      systemId: this.systemId,
      base,
      side: ev.type === 'entry' ? 'buy' : 'sell',
      qty: new Decimal(ev.qty),
      price: new Decimal(ev.price),
      fee: new Decimal(ev.fee),
      refId: `${ev.type}:${ev.t}`,
    });
    this.rt.logger.info({ ev }, `cascade bot ${ev.type}`);
  }
}

export { HOUR };
