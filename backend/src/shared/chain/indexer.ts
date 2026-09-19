import { and, between, eq, inArray, lte, sql } from 'drizzle-orm';
import { publishChannel } from '../bus';
import { assets, indexerState, liquidations } from '../db/schema';
import { modeOf, type Runtime } from '../runtime';
import { assetSymbols, toDTO } from './liq-store';
import { decodeLiquidation, type DecodedLiquidation, type RawLog } from './decode';
import { isRangeRejection, type BlockInfo, type ChainRpc } from './rpc';
import type { UsdValuer } from './valuation';

export interface IndexerOpts {
  backfillDays: number;
  /** Spec: start at 10,000 blocks, divide by 4 on range errors, minimum 100. */
  maxChunk: number;
  minChunk: number;
  confirmations: number;
  blocksPerDay: number;
  /** Backfill chunks processed per scheduler run, so the live tail never starves. */
  chunksPerRun: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export const INDEXER_DEFAULTS: IndexerOpts = { backfillDays: 30, maxChunk: 10_000, minChunk: 100, confirmations: 12, blocksPerDay: 7_200, chunksPerRun: 25 };

const STATE_KEY = 'aave-v3-liquidations';
/** Approximate mainnet block time, used to translate "blocks covered" into "how far back does history reach". */
const BLOCK_MS = 12_000;

interface State {
  /** Highest block the live tail has scanned. */
  lastBlock: number;
  /** Backfill has covered [lowBlock, ...); it walks downward toward targetLow. */
  lowBlock: number;
  targetLow: number;
  chunk: number;
  backfill: 'running' | 'done' | 'stopped';
  reason?: string;
  /** Transient failures pause backfill (with growing backoff) instead of ending it. */
  pauseUntil?: number;
}

export interface RemovedEvent {
  type: 'removed';
  txHash: string;
  logIndex: number;
}

/**
 * Aave V3 LiquidationCall indexer.
 * - Live tail starts at the head immediately; history is then filled BACKWARD (newest first) so an RPC that
 *   only serves recent blocks still yields as much history as it allows, and the tail is never blocked by it.
 * - Every run re-reads the last `confirmations` blocks and reconciles them with what we stored (reorg safety).
 * - Checkpointed in `indexer_state` so a crash resumes where it stopped.
 * - Backfill failures: range/size errors shrink the chunk (/4); repeated transient errors back off and retry;
 *   repeated range/archive rejections stop backfill (and it is retried once per process start).
 */
export class LiquidationIndexer {
  private o: IndexerOpts;
  private blocks = new Map<number, BlockInfo>();
  private head = 0;
  private state: State | null = null;
  private resumedStopped = false;
  private consecutiveFails = 0;
  private pauses = 0;
  /** Largest chunk not yet seen to fail. Prevents grow-then-fail oscillation on RPCs with a hard block cap. */
  private ceiling = Infinity;

  constructor(private rt: Runtime, private rpc: ChainRpc, private valuer: UsdValuer, opts: Partial<IndexerOpts> = {}) {
    this.o = { ...INDEXER_DEFAULTS, ...opts };
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** One scheduler cycle: live tail first, then a bounded slice of backfill. */
  async run(): Promise<void> {
    await this.init();
    await this.liveTick();
    await this.backfillSlice();
  }

  private async init(): Promise<void> {
    if (!this.state) {
      const [row] = await this.rt.db.select().from(indexerState).where(eq(indexerState.key, STATE_KEY));
      if (row) {
        const meta = (row.meta ?? {}) as Partial<State>;
        this.state = {
          lastBlock: row.lastBlock,
          lowBlock: meta.lowBlock ?? row.lastBlock + 1,
          targetLow: meta.targetLow ?? row.lastBlock,
          chunk: meta.chunk ?? this.o.maxChunk,
          backfill: meta.backfill ?? 'running',
          reason: meta.reason,
          pauseUntil: meta.pauseUntil,
        };
      }
    }
    if (!this.state) {
      const head = await this.rpc.getBlockNumber();
      this.state = { lastBlock: head, lowBlock: head + 1, targetLow: head - this.o.backfillDays * this.o.blocksPerDay, chunk: this.o.maxChunk, backfill: this.o.backfillDays > 0 ? 'running' : 'done' };
      await this.save();
    }
    // A previous run may have stopped because the RPC was too restrictive; retry once per process (new RPC/keys).
    if (this.state.backfill === 'stopped' && !this.resumedStopped) {
      this.resumedStopped = true;
      this.state.backfill = 'running';
      this.state.pauseUntil = undefined;
    }
  }

  private async save(): Promise<void> {
    const s = this.state!;
    const meta = { lowBlock: s.lowBlock, targetLow: s.targetLow, chunk: s.chunk, backfill: s.backfill, reason: s.reason, pauseUntil: s.pauseUntil };
    await this.rt.db
      .insert(indexerState)
      .values({ key: STATE_KEY, lastBlock: s.lastBlock, meta })
      .onConflictDoUpdate({ target: indexerState.key, set: { lastBlock: s.lastBlock, meta, updatedAt: new Date() } });
    // Visible on /health/providers, and the signal engine's warm-up reads the liquidation coverage start.
    const coverageStart = this.now() - Math.max(0, (this.head || s.lastBlock) - s.lowBlock) * BLOCK_MS;
    await this.rt.redis.set('indexer:status', JSON.stringify({ ...meta, lastBlock: s.lastBlock, head: this.head, coverageStart, updatedAt: new Date().toISOString() }));
    if (s.lowBlock <= s.lastBlock) await this.rt.redis.set('liq:coverage:start', String(Math.round(coverageStart)));
  }

  /** Progress snapshot for logs/health. */
  status(): State | null {
    return this.state;
  }

  // ---------------------------------------------------------------- live tail + reorg reconciliation

  async liveTick(): Promise<{ inserted: number; removed: number }> {
    const s = this.state!;
    const head = await this.rpc.getBlockNumber();
    this.head = head;
    const from = Math.max(1, Math.min(head, s.lastBlock - this.o.confirmations + 1));
    const logs = await this.fetchRange(from, head);
    const removed = await this.reconcile(from, head, logs);
    const inserted = await this.ingest(logs, head, true);
    await this.rt.db
      .update(liquidations)
      .set({ status: 'confirmed' })
      .where(and(eq(liquidations.status, 'pending'), lte(liquidations.blockNumber, head - this.o.confirmations)));
    s.lastBlock = Math.max(s.lastBlock, head);
    await this.save();
    return { inserted, removed };
  }

  /** Delete stored logs in [from, to] that the canonical chain no longer contains (or contains in another block). */
  private async reconcile(from: number, to: number, canonical: RawLog[]): Promise<number> {
    const keep = new Set(canonical.map((l) => `${l.transactionHash.toLowerCase()}:${Number(BigInt(l.logIndex))}:${l.blockHash.toLowerCase()}`));
    const stored = await this.rt.db
      .select({ id: liquidations.id, txHash: liquidations.txHash, logIndex: liquidations.logIndex, blockHash: liquidations.blockHash })
      .from(liquidations)
      .where(between(liquidations.blockNumber, from, to));
    const stale = stored.filter((r) => !keep.has(`${r.txHash}:${r.logIndex}:${r.blockHash}`));
    if (stale.length === 0) return 0;
    await this.rt.db.delete(liquidations).where(inArray(liquidations.id, stale.map((r) => r.id)));
    this.rt.logger.warn({ removed: stale.length, from, to }, 'reorg: removed liquidations no longer on the canonical chain');
    for (const r of stale) {
      const ev: RemovedEvent = { type: 'removed', txHash: r.txHash, logIndex: r.logIndex };
      await publishChannel(this.rt.redis, 'liquidations', ev, { mode: modeOf(this.rt.config), snapshot: false });
    }
    return stale.length;
  }

  // ---------------------------------------------------------------- backfill (newest -> oldest)

  private async backfillSlice(): Promise<void> {
    const s = this.state!;
    const now = this.now();
    if (s.pauseUntil && now < s.pauseUntil) return; // backing off after repeated failures
    if (s.pauseUntil) s.pauseUntil = undefined;
    for (let i = 0; i < this.o.chunksPerRun && s.backfill === 'running'; i++) {
      const hi = s.lowBlock - 1;
      if (hi < s.targetLow) {
        s.backfill = 'done';
        this.rt.logger.info({ lowBlock: s.lowBlock }, 'liquidation backfill complete');
        break;
      }
      const lo = Math.max(s.targetLow, hi - s.chunk + 1);
      try {
        const logs = await this.rpc.getLogs(lo, hi);
        await this.ingest(logs, this.head || hi, false);
        s.lowBlock = lo;
        this.consecutiveFails = 0;
        this.pauses = 0;
        s.chunk = Math.min(this.o.maxChunk, this.ceiling, s.chunk * 2); // recover after a shrink, never past a size that failed
      } catch (err) {
        if (s.chunk > this.o.minChunk) {
          this.ceiling = Math.min(this.ceiling, s.chunk - 1);
          s.chunk = Math.max(this.o.minChunk, Math.floor(s.chunk / 4)); // range/size error: divide by 4
        } else if (++this.consecutiveFails >= 3) {
          this.consecutiveFails = 0;
          this.pauses++;
          s.reason = (err as Error).message.slice(0, 200);
          if (isRangeRejection(err) && this.pauses >= 3) {
            // the RPC keeps refusing this range/depth: it does not serve that history (no archive access)
            s.backfill = 'stopped';
            this.rt.logger.warn(
              { reason: s.reason, coveredFrom: s.lowBlock },
              'liquidation backfill stopped: the RPC refuses further history. Add an archive-capable RPC (Alchemy/Infura) to RPC_URLS to continue.',
            );
          } else {
            // transient (flaky public RPC): back off 1m, 2m, 4m ... capped at 10m, then try again
            s.pauseUntil = now + Math.min(10 * 60_000, 60_000 * 2 ** (this.pauses - 1));
            this.rt.logger.warn({ reason: s.reason, retryInMs: s.pauseUntil - now }, 'liquidation backfill paused after repeated RPC failures');
          }
          await this.save();
          break;
        }
      }
      await this.save();
    }
    await this.save(); // also persists terminal states (done/stopped) reached via break
  }

  // ---------------------------------------------------------------- shared

  /** getLogs over [from, to] with the same adaptive chunking (used for the live window, which is tiny). */
  private async fetchRange(from: number, to: number): Promise<RawLog[]> {
    const out: RawLog[] = [];
    let chunk = this.state!.chunk;
    for (let lo = from; lo <= to; ) {
      const hi = Math.min(to, lo + chunk - 1);
      try {
        out.push(...(await this.rpc.getLogs(lo, hi)));
        lo = hi + 1;
      } catch (err) {
        if (chunk <= this.o.minChunk) throw err;
        chunk = Math.max(this.o.minChunk, Math.floor(chunk / 4));
      }
    }
    return out.filter((l) => !l.removed);
  }

  /** Cached per block number, but a cached hash that disagrees with the log's block is stale (reorg): refetch. */
  private async blockInfo(n: number, expectedHash: string): Promise<BlockInfo> {
    let b = this.blocks.get(n);
    if (!b || b.hash.toLowerCase() !== expectedHash) {
      b = await this.rpc.getBlock(n);
      this.blocks.set(n, b);
      if (this.blocks.size > 5_000) this.blocks.delete(this.blocks.keys().next().value!);
    }
    return b;
  }

  /** Decode, value, upsert. Returns how many rows were new. Publishes only new rows when `publish` is set. */
  private async ingest(logs: RawLog[], head: number, publish: boolean): Promise<number> {
    if (logs.length === 0) return 0;
    const decoded: DecodedLiquidation[] = [];
    for (const l of logs) {
      try {
        decoded.push(decodeLiquidation(l));
      } catch (err) {
        this.rt.logger.warn({ err: (err as Error).message, tx: l.transactionHash }, 'skipping undecodable log');
      }
    }
    const existing = new Set(
      (await this.rt.db.select({ tx: liquidations.txHash, i: liquidations.logIndex }).from(liquidations).where(inArray(liquidations.txHash, [...new Set(decoded.map((d) => d.txHash))]))).map((r) => `${r.tx}:${r.i}`),
    );

    const fresh: Array<typeof liquidations.$inferInsert> = [];
    for (const d of decoded) {
      let ts = d.blockTimestamp;
      if (ts === undefined) {
        const b = await this.blockInfo(d.blockNumber, d.blockHash);
        // The block moved under us (reorg mid-cycle): skip; the next run re-reads this window.
        if (b.hash.toLowerCase() !== d.blockHash) continue;
        ts = b.timestamp;
      }
      const usd = await this.valuer.usdValue(d.collateralAsset, d.liquidatedCollateralAmount, ts * 1000);
      fresh.push({
        txHash: d.txHash,
        logIndex: d.logIndex,
        blockNumber: d.blockNumber,
        blockHash: d.blockHash,
        ts: new Date(ts * 1000),
        collateralAsset: d.collateralAsset,
        debtAsset: d.debtAsset,
        user: d.user,
        liquidator: d.liquidator,
        debtAmountRaw: d.debtToCover.toString(),
        collateralAmountRaw: d.liquidatedCollateralAmount.toString(),
        usdValue: usd,
        status: head - d.blockNumber >= this.o.confirmations ? 'confirmed' : 'pending',
      });
    }
    if (fresh.length === 0) return 0;
    for (let i = 0; i < fresh.length; i += 200) {
      await this.rt.db
        .insert(liquidations)
        .values(fresh.slice(i, i + 200))
        .onConflictDoUpdate({
          target: [liquidations.txHash, liquidations.logIndex],
          set: {
            blockNumber: sql`excluded.block_number`,
            blockHash: sql`excluded.block_hash`,
            ts: sql`excluded.ts`,
            usdValue: sql`coalesce(excluded.usd_value, ${liquidations.usdValue})`,
            status: sql`excluded.status`,
          },
        });
    }
    const isNew = fresh.filter((r) => !existing.has(`${r.txHash}:${r.logIndex}`));
    if (publish && isNew.length) {
      const symbols = await assetSymbols(this.rt.db);
      const rows = await this.rt.db.select().from(liquidations).where(inArray(liquidations.txHash, [...new Set(isNew.map((r) => r.txHash))]));
      const wanted = new Set(isNew.map((r) => `${r.txHash}:${r.logIndex}`));
      for (const row of rows.filter((r) => wanted.has(`${r.txHash}:${r.logIndex}`))) {
        await publishChannel(this.rt.redis, 'liquidations', { type: 'liquidation', event: toDTO(row, symbols) }, { mode: modeOf(this.rt.config), snapshot: false });
      }
    }
    return isNew.length;
  }
}

/** Seed `assets` from the Aave V3 reserve list (symbol/decimals read on-chain). No-op when already populated. */
export async function seedAaveAssets(rt: Runtime, rpc: ChainRpc): Promise<number> {
  const existing = await rt.db.select({ id: assets.id }).from(assets).limit(1);
  if (existing.length > 0) return 0;
  const reserves = await rpc.reserves();
  if (reserves.length === 0) return 0;
  await rt.db
    .insert(assets)
    .values(reserves.map((r) => ({ chain: 1, address: r.address.toLowerCase(), symbol: r.symbol, decimals: r.decimals })))
    .onConflictDoNothing();
  return reserves.length;
}
