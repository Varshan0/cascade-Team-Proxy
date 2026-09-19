import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { readSnapshot, type Envelope } from '../shared/bus';
import { recentLiquidations } from '../shared/chain/liq-store';
import { modeOf } from '../shared/runtime';

const SYM = '[A-Z0-9]+-[A-Z]+';
const CHANNEL_PATTERNS = [
  new RegExp(`^ticker:${SYM}$`),
  new RegExp(`^candles:${SYM}:(1m|5m|15m|1h|4h|1d)$`),
  /^liquidations$/,
  new RegExp(`^oracle:${SYM}$`),
  /^signal$/,
];
// Documented but not built yet: rejected with a clear message rather than silently ignored.
const PLANNED = /^(movers|chain|orderbook:.+|trades:.+)$/;
const PRIVATE = /^me:(orders|portfolio|alerts)$/;

/** ticker/orderbook are *state* channels: coalesced per client, so `seq` gaps there are expected. */
const THROTTLE_MS: Array<[RegExp, number]> = [
  [/^ticker:/, 250], // 4 updates/s
  [/^orderbook:/, 500], // 2 updates/s
];
/** Above this many buffered bytes we shed intermediate market-data updates (never order/private data). */
const BACKPRESSURE_BYTES = 1_000_000;
const SHEDDABLE = /^(ticker|candles|oracle|orderbook):/;
/** During a drill the drilled instrument's live traffic is replaced by synthetic traffic. */
const DRILL_SUPPRESSED = /^(ticker:ETH-USD|candles:ETH-USD:.+|oracle:ETH-USD|liquidations|signal)$/;

const clientMsg = z.object({ op: z.enum(['subscribe', 'unsubscribe']), channels: z.array(z.string()).min(1).max(50) });

interface Client {
  socket: WebSocket;
  subs: Set<string>;
  alive: boolean;
  lastSent: Map<string, number>;
  pending: Map<string, Envelope>;
  timers: Map<string, NodeJS.Timeout>;
}

export function registerGateway(app: FastifyInstance): void {
  const { redis, db, config } = app.ctx;
  const sub = redis.duplicate();
  const clients = new Set<Client>();
  const refs = new Map<string, number>();
  let drillActive = false;

  const send = (c: Client, env: Envelope | Record<string, unknown>): void => {
    if (c.socket.readyState === 1) c.socket.send(JSON.stringify(env));
  };
  const throttleOf = (channel: string) => THROTTLE_MS.find(([re]) => re.test(channel))?.[1];

  /** During a drill, live traffic on the drilled channels is dropped; outside one, synthetic traffic is. */
  const suppressed = (env: Envelope): boolean => (drillActive ? !env.synthetic && DRILL_SUPPRESSED.test(env.channel) : !!env.synthetic);

  const deliver = (c: Client, env: Envelope): void => {
    if (SHEDDABLE.test(env.channel) && c.socket.bufferedAmount > BACKPRESSURE_BYTES) return;
    const gap = throttleOf(env.channel);
    if (!gap) return send(c, env);
    const now = Date.now();
    const last = c.lastSent.get(env.channel) ?? 0;
    if (now - last >= gap) {
      c.lastSent.set(env.channel, now);
      c.pending.delete(env.channel);
      return send(c, env);
    }
    c.pending.set(env.channel, env); // coalesce: only the newest state survives
    if (!c.timers.has(env.channel)) {
      c.timers.set(
        env.channel,
        setTimeout(() => {
          c.timers.delete(env.channel);
          const p = c.pending.get(env.channel);
          // a live update coalesced before a drill began must not leak out after it started
          if (p && !suppressed(p)) {
            c.pending.delete(env.channel);
            c.lastSent.set(env.channel, Date.now());
            send(c, p);
          }
        }, gap - (now - last)),
      );
    }
  };

  const snapshotFor = async (channel: string): Promise<Envelope> => {
    if (channel === 'liquidations') {
      const data = await recentLiquidations(db, 20);
      return { channel, type: 'snapshot', seq: 0, ts: new Date().toISOString(), mode: modeOf(config), data };
    }
    const snap = (drillActive ? await readSnapshot(redis, channel, true) : null) ?? (await readSnapshot(redis, channel));
    return snap ?? { channel, type: 'snapshot', seq: 0, ts: new Date().toISOString(), mode: modeOf(config), data: null };
  };

  sub.on('message', (redisChannel: string, raw: string) => {
    if (redisChannel === 'ch:drill:events') {
      const { active } = JSON.parse(raw) as { active: boolean };
      drillActive = active;
      if (!active) {
        // Drill over: restore live state for everyone by re-sending live snapshots.
        for (const ch of refs.keys()) {
          void snapshotFor(ch).then((s) => {
            for (const c of clients) if (c.subs.has(ch)) send(c, s);
          });
        }
      }
      return;
    }
    const env = JSON.parse(raw) as Envelope;
    if (suppressed(env)) return;
    for (const c of clients) if (c.subs.has(env.channel)) deliver(c, env);
  });
  void sub.subscribe('ch:drill:events');
  void redis.get('drill:active').then((v) => {
    drillActive = v === '1';
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }, 20_000);

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const c of clients) {
      for (const t of c.timers.values()) clearTimeout(t);
      c.socket.terminate();
    }
    sub.disconnect();
  });

  app.get('/ws', { websocket: true }, (socket) => {
    const client: Client = { socket, subs: new Set(), alive: true, lastSent: new Map(), pending: new Map(), timers: new Map() };
    clients.add(client);
    socket.on('pong', () => (client.alive = true));

    const error = (code: string, message: string) => send(client, { type: 'error', error: { code, message } });

    const unsubscribe = (channel: string) => {
      if (!client.subs.delete(channel)) return;
      clearTimeout(client.timers.get(channel));
      client.timers.delete(channel);
      client.pending.delete(channel);
      const n = (refs.get(channel) ?? 1) - 1;
      if (n <= 0) {
        refs.delete(channel);
        void sub.unsubscribe(`ch:${channel}`);
      } else refs.set(channel, n);
    };

    socket.on('message', async (raw) => {
      client.alive = true;
      let msg: z.infer<typeof clientMsg>;
      try {
        msg = clientMsg.parse(JSON.parse(String(raw)));
      } catch {
        return error('bad_message', 'expected {"op":"subscribe"|"unsubscribe","channels":[...]}');
      }
      for (const channel of msg.channels) {
        if (msg.op === 'unsubscribe') {
          unsubscribe(channel);
          continue;
        }
        if (PRIVATE.test(channel)) {
          error('unauthorized', `${channel} requires authentication (arrives with M5)`);
          continue;
        }
        if (PLANNED.test(channel)) {
          error('not_available', `${channel} is not available yet`);
          continue;
        }
        if (!CHANNEL_PATTERNS.some((re) => re.test(channel))) {
          error('unknown_channel', `unknown channel ${channel}`);
          continue;
        }
        if (client.subs.has(channel)) continue;
        client.subs.add(channel);
        refs.set(channel, (refs.get(channel) ?? 0) + 1);
        if (refs.get(channel) === 1) await sub.subscribe(`ch:${channel}`);
        // Always a snapshot first; updates that raced in before it are ordered by `seq` on the client.
        send(client, await snapshotFor(channel));
      }
    });

    socket.on('close', () => {
      for (const ch of [...client.subs]) unsubscribe(ch);
      clients.delete(client);
    });
  });
}
