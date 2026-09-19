import type { Mode } from './config';
import type { Redis } from './redis';

/**
 * Channel envelope shared by the worker (publisher) and the WS gateway.
 * Redis layout: pub/sub on `ch:<channel>`, latest snapshot at `snap:<channel>`.
 * Drill (synthetic) traffic uses `snapdrill:` / `seq:drill:` so it can never overwrite live state.
 */
export interface Envelope<T = unknown> {
  channel: string;
  type: 'snapshot' | 'update';
  seq: number;
  ts: string;
  mode: Mode;
  synthetic?: true;
  data: T;
}

export interface PublishOpts {
  mode: Mode;
  synthetic?: boolean;
  /** Event channels (liquidations) have no state snapshot; the gateway builds theirs from the DB. */
  snapshot?: boolean;
}

const snapKey = (channel: string, synthetic?: boolean) => `${synthetic ? 'snapdrill' : 'snap'}:${channel}`;

export async function publishChannel<T>(redis: Redis, channel: string, data: T, opts: PublishOpts): Promise<void> {
  const seq = await redis.incr(`${opts.synthetic ? 'seq:drill' : 'seq'}:${channel}`);
  const env: Envelope<T> = {
    channel,
    type: 'update',
    seq,
    ts: new Date().toISOString(),
    mode: opts.mode,
    ...(opts.synthetic ? { synthetic: true as const } : {}),
    data,
  };
  const ops: Promise<unknown>[] = [redis.publish(`ch:${channel}`, JSON.stringify(env))];
  if (opts.snapshot !== false) {
    ops.push(redis.set(snapKey(channel, opts.synthetic), JSON.stringify({ ...env, type: 'snapshot' })));
  }
  await Promise.all(ops);
}

export async function readSnapshot(redis: Redis, channel: string, synthetic = false): Promise<Envelope | null> {
  const raw = await redis.get(snapKey(channel, synthetic));
  return raw ? (JSON.parse(raw) as Envelope) : null;
}

export async function clearDrillSnapshots(redis: Redis): Promise<void> {
  const keys = await redis.keys('snapdrill:*');
  const seqs = await redis.keys('seq:drill:*');
  const all = [...keys, ...seqs];
  if (all.length) await redis.del(...all);
}

/** Latest normalised price, kept outside the envelope so engines don't parse channel messages. */
export interface PriceSnapshot {
  instrument: string;
  price: string;
  ts: string;
  source: string;
  suspect: boolean;
  bid?: string;
  ask?: string;
}

export const pxKey = (instrument: string) => `px:${instrument}`;
/** Latest price that passed the multi-source sanity check. The signal engine reads only this. */
export const pxGoodKey = (instrument: string) => `px:good:${instrument}`;

export async function readPrice(redis: Redis, instrument: string, good = false): Promise<PriceSnapshot | null> {
  const raw = await redis.get(good ? pxGoodKey(instrument) : pxKey(instrument));
  return raw ? (JSON.parse(raw) as PriceSnapshot) : null;
}
