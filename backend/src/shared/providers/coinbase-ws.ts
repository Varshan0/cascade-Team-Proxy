import Decimal from 'decimal.js';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import { z } from 'zod';
import { HealthTracker } from './health';
import type { RawTick } from '../market/ingest';

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';

// Verified live 2026-09-19: ticker carries price, best_bid, best_ask, side, time.
const tickerMsg = z.object({
  type: z.literal('ticker'),
  product_id: z.string(),
  price: z.string(),
  time: z.string().optional(),
  last_size: z.string().optional(),
  side: z.enum(['buy', 'sell']).optional(),
  best_bid: z.string().optional(),
  best_ask: z.string().optional(),
});

/** Public `ticker` channel, auto-reconnecting; a silent socket (no frames for 30s) is treated as dead. */
export class CoinbaseWs {
  readonly name = 'coinbase-ws';
  readonly tracker = new HealthTracker(this.name);
  private ws?: WebSocket;
  private stopped = false;
  private attempt = 0;
  private watchdog?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private products: Map<string, string>, // coinbase product id -> our instrument symbol
    private onTick: (t: RawTick) => void,
    private logger: Logger,
    private url = WS_URL,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    const opened = Date.now();
    ws.on('open', () => {
      this.logger.info('coinbase ws connected');
      ws.send(JSON.stringify({ type: 'subscribe', channels: [{ name: 'ticker', product_ids: [...this.products.keys()] }] }));
      this.armWatchdog();
    });
    ws.on('message', (raw) => {
      this.armWatchdog();
      this.handle(String(raw), opened);
    });
    ws.on('error', (err) => {
      this.tracker.recordError(err);
    });
    ws.on('close', () => {
      clearTimeout(this.watchdog);
      if (this.stopped) return;
      // exponential backoff with full jitter, capped at 30s
      const delay = Math.random() * Math.min(30_000, 500 * 2 ** this.attempt++);
      this.logger.warn({ delay: Math.round(delay) }, 'coinbase ws closed, reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private armWatchdog(): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.tracker.recordError(new Error('no frames for 30s'));
      this.ws?.terminate();
    }, 30_000);
  }

  private handle(raw: string, _opened: number): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      this.tracker.recordError(e);
      return;
    }
    if ((json as { type?: string }).type !== 'ticker') return; // subscriptions / heartbeats
    const parsed = tickerMsg.safeParse(json);
    if (!parsed.success) {
      this.tracker.recordError(new Error(`ticker validation: ${parsed.error.issues[0]?.message}`));
      return;
    }
    const m = parsed.data;
    const instrument = this.products.get(m.product_id);
    if (!instrument) return;
    this.attempt = 0;
    const ts = m.time ? Date.parse(m.time) : Date.now();
    this.tracker.recordSuccess(Math.max(0, Date.now() - ts));
    this.onTick({
      instrument,
      price: new Decimal(m.price),
      size: m.last_size ? new Decimal(m.last_size) : undefined,
      side: m.side,
      ts,
      source: this.name,
      bid: m.best_bid,
      ask: m.best_ask,
    });
  }
}
