import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, toEventSelector, toFunctionSelector, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AAVE_POOL, LIQUIDATION_TOPIC, aggregatorAbi, poolAbi } from '../src/shared/chain/abi';
import { answerToDecimalString, decodeLiquidation, joinRoundId, parseRoundData, previousRoundId, splitRoundId, type RawLog, type RoundData } from '../src/shared/chain/decode';
import { LiquidationIndexer } from '../src/shared/chain/indexer';
import { OracleWatcher, computeGap } from '../src/shared/chain/oracle';
import type { BlockInfo, ChainRpc } from '../src/shared/chain/rpc';
import { UsdValuer, priceInstrumentFor } from '../src/shared/chain/valuation';
import { assets, indexerState, liquidations, oracleRounds } from '../src/shared/db/schema';
import { upsertCandles } from '../src/shared/market/store';
import { createTestContext, fixture, type TestContext } from './helpers';

interface LogFixture {
  logs: RawLog[];
  blocks: Record<string, { number: string; hash: string; timestamp: string }>;
}
const fx = fixture<LogFixture>('aave-liquidation-logs.json');
const round = fixture<{ eth: Hex; btc: Hex }>('chainlink-latest-round.json');

describe('protocol constants and decoding (real recorded mainnet data)', () => {
  it('spec constants match viem-computed selectors', () => {
    expect(toEventSelector(poolAbi[0])).toBe(LIQUIDATION_TOPIC);
    expect(toFunctionSelector(aggregatorAbi[0])).toBe('0xfeaf968c');
    expect(toFunctionSelector(aggregatorAbi[1])).toBe('0x9a6fc8f5');
    expect(AAVE_POOL).toBe('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
  });

  it('decodes every recorded LiquidationCall log', () => {
    expect(fx.logs.length).toBeGreaterThan(0);
    for (const log of fx.logs) {
      const d = decodeLiquidation(log);
      expect(log.topics[0]).toBe(LIQUIDATION_TOPIC);
      expect(d.collateralAsset).toMatch(/^0x[0-9a-f]{40}$/);
      expect(d.user).toMatch(/^0x[0-9a-f]{40}$/);
      expect(d.debtToCover).toBeGreaterThan(0n);
      expect(d.liquidatedCollateralAmount).toBeGreaterThan(0n);
      expect(typeof d.receiveAToken).toBe('boolean');
      expect(d.blockNumber).toBe(Number(BigInt(log.blockNumber)));
    }
  });

  it('decodes the first recorded log field-by-field against the raw hex', () => {
    const log = fx.logs[0]!;
    const d = decodeLiquidation(log);
    expect(d.collateralAsset).toBe('0x' + log.topics[1]!.slice(26));
    expect(d.debtAsset).toBe('0x' + log.topics[2]!.slice(26));
    expect(d.user).toBe('0x' + log.topics[3]!.slice(26));
    expect(d.debtToCover).toBe(BigInt('0x' + log.data.slice(2, 66)));
    expect(d.liquidatedCollateralAmount).toBe(BigInt('0x' + log.data.slice(66, 130)));
    expect(d.liquidator).toBe('0x' + log.data.slice(130 + 24, 194));
  });
});

describe('Chainlink round parsing', () => {
  it('parses a real ETH/USD and BTC/USD latestRoundData blob (8 decimals)', () => {
    const eth = parseRoundData(round.eth);
    const btc = parseRoundData(round.btc);
    expect(Number(answerToDecimalString(eth.answer))).toBeGreaterThan(100);
    expect(Number(answerToDecimalString(btc.answer))).toBeGreaterThan(1000);
    expect(eth.updatedAt).toBeGreaterThan(1_700_000_000);
    expect(eth.roundId >> 64n).toBeGreaterThan(0n); // phaseId present
  });

  it('decodes a NEGATIVE int256 answer as negative, not as a huge unsigned number', () => {
    const data = encodeAbiParameters(
      [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }],
      [1n, -123_456_789n, 1000n, 2000n, 1n],
    );
    const r = parseRoundData(data);
    expect(r.answer).toBe(-123_456_789n);
    expect(answerToDecimalString(r.answer)).toBe('-1.23456789');
  });

  it('roundId = (phaseId << 64) | aggregatorRound; history walks down inside the phase only', () => {
    const id = joinRoundId(7n, 33_299n);
    expect(splitRoundId(id)).toEqual({ phaseId: 7n, aggregatorRound: 33_299n });
    expect(previousRoundId(id)).toBe(joinRoundId(7n, 33_298n));
    expect(previousRoundId(joinRoundId(7n, 1n))).toBeNull(); // phase boundary
    expect(answerToDecimalString(261_234_567_890n)).toBe('2612.3456789');
  });
});

describe('asset pricing map', () => {
  it('routes stables, LSTs, BTC wrappers and other assets', () => {
    expect(priceInstrumentFor('USDC')).toBe('USD');
    expect(priceInstrumentFor('wstETH')).toBe('ETH-USD');
    expect(priceInstrumentFor('cbBTC')).toBe('BTC-USD');
    expect(priceInstrumentFor('LINK')).toBe('LINK-USD');
  });
});

// ------------------------------------------------------------------ scripted chain

/** A fake Ethereum: blocks, logs, per-request range limit and an archive floor, plus reorg helpers. */
class FakeChain implements ChainRpc {
  head: number;
  logs: RawLog[] = [];
  blocks = new Map<number, BlockInfo>();
  maxRange = Infinity;
  archiveFloor = 0;
  rangeCalls: Array<[number, number]> = [];
  latest: RoundData = { roundId: joinRoundId(1n, 100n), answer: 260_000_000_000n, startedAt: 0, updatedAt: 0, answeredInRound: 1n };
  history = new Map<bigint, RoundData>();
  failBlocks = false;

  constructor(head: number) {
    this.head = head;
  }
  hashOf(n: number, salt = 'a') {
    return '0x' + (salt + n.toString(16)).padStart(64, '0');
  }
  block(n: number): BlockInfo {
    let b = this.blocks.get(n);
    if (!b) this.blocks.set(n, (b = { hash: this.hashOf(n), timestamp: 1_800_000_000 + n * 12 }));
    return b;
  }
  /** Add a log at block n, based on a real recorded log so it decodes. */
  addLog(n: number, txSalt: string, logIndex = 0, template = fx.logs[0]!): RawLog {
    const l: RawLog = {
      ...template,
      blockNumber: '0x' + n.toString(16),
      blockHash: this.block(n).hash,
      transactionHash: '0x' + txSalt.padStart(64, '0'),
      logIndex: '0x' + logIndex.toString(16),
      blockTimestamp: undefined,
    };
    this.logs.push(l);
    return l;
  }
  /** Re-org: the block gets a new hash; logs in it move to the new hash (or vanish when `drop`). */
  reorg(n: number, drop = false) {
    const old = this.block(n).hash;
    this.blocks.set(n, { hash: this.hashOf(n, 'b'), timestamp: this.block(n).timestamp });
    this.logs = this.logs.filter((l) => !(drop && l.blockHash === old)).map((l) => (l.blockHash === old ? { ...l, blockHash: this.block(n).hash } : l));
  }
  async getBlockNumber() {
    return this.head;
  }
  async getLogs(from: number, to: number) {
    this.rangeCalls.push([from, to]);
    if (to - from + 1 > this.maxRange) throw new Error('query exceeds max block range');
    if (from < this.archiveFloor) throw new Error('Archive requests require a personal token');
    return this.logs.filter((l) => {
      const n = Number(BigInt(l.blockNumber));
      return n >= from && n <= to;
    });
  }
  async getBlock(n: number) {
    if (this.failBlocks) throw new Error('rpc down');
    return this.block(n);
  }
  async latestRound() {
    return this.latest;
  }
  async roundsBatch(_f: string, ids: bigint[]) {
    return ids.map((id) => this.history.get(id) ?? null);
  }
  async reserves() {
    return [];
  }
}

const COLLATERAL = decodeLiquidation(fx.logs[0]!).collateralAsset; // whatever real asset the first log used

async function seedAsset(t: TestContext, symbol: string, decimals: number, address = COLLATERAL) {
  await t.db.insert(assets).values({ chain: 1, address, symbol, decimals }).onConflictDoNothing();
}

describe('liquidation indexer', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
    await seedAsset(t, 'WETH', 18);
    // nearest-candle valuation: ETH at $2,000 around every block used below
    await upsertCandles(t.db, 'ETH-USD', '1d', [{ t: 0, o: '2000', h: '2000', l: '2000', c: '2000', v: '1', source: 't' }]);
    for (let d = 0; d < 1; d++) await upsertCandles(t.db, 'ETH-USD', '1m', []);
  });
  afterAll(() => t.close());

  const mk = (chain: FakeChain, opts = {}) => new LiquidationIndexer(t.rt, chain, new UsdValuer(t.db, t.redis), { backfillDays: 1, blocksPerDay: 2000, maxChunk: 1000, minChunk: 100, confirmations: 12, ...opts });
  const clear = async () => {
    await t.db.delete(liquidations);
    await t.db.delete(indexerState);
  };
  const rows = () => t.db.select().from(liquidations);

  it('live tail: inserts once, marks pending -> confirmed after 12 confirmations, publishes only new events', async () => {
    await clear();
    const chain = new FakeChain(1_000_000);
    chain.addLog(999_998, 'aa1');
    const idx = mk(chain);
    const seen: string[] = [];
    const sub = t.redis.duplicate();
    await sub.subscribe('ch:liquidations');
    sub.on('message', (_c: string, m: string) => seen.push(m));

    await idx.run();
    let r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: 'pending', txHash: '0x' + 'aa1'.padStart(64, '0'), blockNumber: 999_998 });
    expect(r[0]!.ts.getTime()).toBe((1_800_000_000 + 999_998 * 12) * 1000);

    await idx.run(); // same head again: nothing new, nothing republished
    chain.head += 20;
    await idx.run();
    r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('confirmed');
    await new Promise((res) => setTimeout(res, 30));
    expect(seen).toHaveLength(1);
    const env = JSON.parse(seen[0]!);
    expect(env.data.type).toBe('liquidation');
    expect(env.data.event.txUrl).toContain('etherscan.io/tx/');
    sub.disconnect();
  });

  it('values the liquidation in USD from collateral amount x price at block time', async () => {
    const r = (await rows())[0]!;
    // recorded amount of the first real log, priced off the seeded $2,000 1d candle only if no 1m/1h exists -> null is acceptable;
    // seed a 1m candle at the block time and re-ingest to check the arithmetic exactly
    const d = decodeLiquidation(fx.logs[0]!);
    const ts = r.ts.getTime();
    await upsertCandles(t.db, 'ETH-USD', '1m', [{ t: Math.floor(ts / 60_000) * 60_000, o: '2000', h: '2000', l: '2000', c: '2000', v: '1', source: 't' }]);
    const usd = await new UsdValuer(t.db, t.redis).usdValue(d.collateralAsset, d.liquidatedCollateralAmount, ts);
    expect(new Decimal(usd!).toFixed(6)).toBe(new Decimal(d.liquidatedCollateralAmount.toString()).div(1e18).times(2000).toFixed(6));
  });

  it('reorg: a block whose hash changed is replaced, and a dropped log is removed and announced', async () => {
    await clear();
    const chain = new FakeChain(2_000_000);
    chain.addLog(1_999_995, 'b1');
    chain.addLog(1_999_996, 'b2');
    const idx = mk(chain);
    await idx.run();
    expect(await rows()).toHaveLength(2);

    const removed: string[] = [];
    const sub = t.redis.duplicate();
    await sub.subscribe('ch:liquidations');
    sub.on('message', (_c: string, m: string) => {
      const e = JSON.parse(m);
      if (e.data.type === 'removed') removed.push(e.data.txHash);
    });

    chain.reorg(1_999_995); // same tx, new block hash
    chain.reorg(1_999_996, true); // tx dropped entirely
    chain.head += 1;
    await idx.run();
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.txHash).toBe('0x' + 'b1'.padStart(64, '0'));
    expect(r[0]!.blockHash).toBe(chain.block(1_999_995).hash); // replaced by the canonical hash
    await new Promise((res) => setTimeout(res, 30));
    expect(removed).toContain('0x' + 'b2'.padStart(64, '0'));
    sub.disconnect();
  });

  it('unique key (tx_hash, log_index): two logs in one tx are distinct, replays never duplicate', async () => {
    await clear();
    const chain = new FakeChain(3_000_000);
    chain.addLog(2_999_999, 'c1', 0);
    chain.addLog(2_999_999, 'c1', 1);
    const idx = mk(chain);
    await idx.run();
    await idx.run();
    await idx.run();
    expect(await rows()).toHaveLength(2);
  });

  it('backfill walks backward with adaptive chunking: shrinks /4 on range errors, floors at 100, recovers', async () => {
    await clear();
    const chain = new FakeChain(4_000_000);
    chain.maxRange = 300; // 1000 -> 250 (ok)
    chain.addLog(3_999_000, 'd1');
    chain.addLog(3_998_500, 'd2');
    const idx = mk(chain, { backfillDays: 1, blocksPerDay: 2000, chunksPerRun: 200 });
    await idx.run();
    const spans = chain.rangeCalls.map(([a, b]) => b - a + 1);
    expect(spans.some((s) => s === 1000 && chain.maxRange < 1000)).toBe(true); // first attempt too big
    expect(spans).toContain(250); // divided by 4
    expect(Math.min(...spans.filter((s) => s > 12))).toBeGreaterThanOrEqual(100); // never below the floor
    const st = idx.status()!;
    expect(st.backfill).toBe('done');
    expect((await rows()).map((r) => r.txHash).sort()).toEqual(['0x' + 'd1'.padStart(64, '0'), '0x' + 'd2'.padStart(64, '0')].sort());
    expect(new Set((await rows()).map((r) => r.status))).toEqual(new Set(['confirmed']));
  });

  it('an RPC that refuses old blocks: retries with backoff, then stops gracefully (no crash), keeps the recent slice, resumes after restart', async () => {
    await clear();
    const chain = new FakeChain(5_000_000);
    chain.archiveFloor = 4_999_000; // only ~1000 recent blocks served
    chain.addLog(4_999_500, 'e1'); // servable
    chain.addLog(4_998_000, 'e2'); // beyond the floor
    let clock = 1_000_000;
    const opts = { backfillDays: 1, blocksPerDay: 2000, chunksPerRun: 100, now: () => clock };
    const idx = mk(chain, opts);
    await idx.run();
    expect(idx.status()!.backfill).toBe('running'); // first refusals only pause it
    expect(idx.status()!.pauseUntil).toBeGreaterThan(clock);
    const callsWhilePaused = chain.rangeCalls.length;
    await idx.run(); // still inside the backoff window: no backfill calls (only the live tail)
    expect(chain.rangeCalls.length - callsWhilePaused).toBeLessThanOrEqual(1);

    for (let i = 0; i < 3 && idx.status()!.backfill === 'running'; i++) {
      clock += 11 * 60_000; // past the (capped) backoff
      await idx.run();
    }
    let st = idx.status()!;
    expect(st.backfill).toBe('stopped');
    expect(st.reason).toMatch(/Archive/);
    expect((await rows()).map((r) => r.txHash)).toEqual(['0x' + 'e1'.padStart(64, '0')]);

    // "new keys": a fresh process with a capable RPC picks up from the checkpoint and finishes
    chain.archiveFloor = 0;
    const restarted = mk(chain, opts);
    await restarted.run();
    st = restarted.status()!;
    expect(st.backfill).toBe('done');
    expect(await rows()).toHaveLength(2);
    const [saved] = await t.db.select().from(indexerState).where(eq(indexerState.key, 'aave-v3-liquidations'));
    expect(saved!.lastBlock).toBe(5_000_000);
  });

  it('transient RPC failures pause backfill with backoff and never stop it: it completes once the RPC recovers', async () => {
    await clear();
    const chain = new FakeChain(7_000_000);
    chain.addLog(6_999_000, 'g1');
    let clock = 5_000_000;
    let broken = false;
    const realGetLogs = chain.getLogs.bind(chain);
    let liveCalls = 0;
    chain.getLogs = async (from: number, to: number) => {
      // backfill ranges only: the live window (last 12 blocks) keeps working
      if (broken && to < chain.head - 20) throw new Error('rpc down');
      liveCalls++;
      return realGetLogs(from, to);
    };
    const opts = { backfillDays: 1, blocksPerDay: 2000, chunksPerRun: 100, maxChunk: 1000, now: () => clock };
    const idx = mk(chain, opts);
    broken = true;
    await idx.run();
    expect(idx.status()!.backfill).toBe('running'); // transient => paused, not stopped
    const first = idx.status()!.pauseUntil!;
    expect(first - clock).toBe(60_000); // 1m first
    clock += 61_000;
    await idx.run();
    expect(idx.status()!.pauseUntil! - clock).toBe(120_000); // 2m next: backoff doubles
    expect(idx.status()!.backfill).toBe('running');

    broken = false;
    clock += 121_000;
    await idx.run();
    expect(idx.status()!.backfill).toBe('done');
    expect((await rows()).map((r) => r.txHash)).toEqual(['0x' + 'g1'.padStart(64, '0')]);
    expect(liveCalls).toBeGreaterThan(0);
  });

  it('publishes liquidation coverage so the signal engine knows how much baseline history it has', async () => {
    await clear();
    await t.redis.del('liq:coverage:start');
    const chain = new FakeChain(8_000_000);
    const idx = mk(chain, { backfillDays: 1, blocksPerDay: 2000, chunksPerRun: 100, maxChunk: 1000 });
    await idx.run();
    const start = Number(await t.redis.get('liq:coverage:start'));
    expect(start).toBeGreaterThan(0);
    expect(idx.status()!.backfill).toBe('done');
    // this fixture backfills 2000 blocks; at 12s per block that is 24,000s of coverage ending now
    expect(Date.now() - start).toBeGreaterThan(23_900_000);
    expect(Date.now() - start).toBeLessThan(24_500_000);
    const status = JSON.parse((await t.redis.get('indexer:status'))!);
    expect(status).toMatchObject({ backfill: 'done', head: 8_000_000 });
  });

  it('skips a log whose block hash changed mid-cycle instead of storing a wrong timestamp', async () => {
    await clear();
    const chain = new FakeChain(6_000_000);
    const log = chain.addLog(5_999_999, 'f1');
    chain.blocks.set(5_999_999, { hash: chain.hashOf(5_999_999, 'c'), timestamp: 1 }); // block moved after getLogs
    expect(log.blockHash).not.toBe(chain.block(5_999_999).hash);
    await mk(chain, { backfillDays: 0 }).run();
    expect(await rows()).toHaveLength(0);
  });
});

describe('oracle watcher', () => {
  let t: TestContext;
  beforeAll(async () => (t = await createTestContext()));
  afterAll(() => t.close());

  const setFast = (price: string, ageMs = 0) =>
    t.redis.set('px:good:ETH-USD', JSON.stringify({ instrument: 'ETH-USD', price, ts: new Date(Date.now() - ageMs).toISOString(), source: 'coinbase-ws', suspect: false }));
  const feed = { instrument: 'ETH-USD', feed: '0xfeed', heartbeatSec: 3600, deviation: 0.005 };

  it('gap = fast / chainlink - 1', () => {
    expect(computeGap(new Decimal(1980), new Decimal(2000)).toFixed(4)).toBe('-0.0100');
  });

  it('flags liquidation pressure only when the gap is below -0.5% (configurable)', async () => {
    const chain = new FakeChain(1);
    chain.latest = { roundId: joinRoundId(1n, 5n), answer: 200_000_000_000n, startedAt: 0, updatedAt: Math.floor(Date.now() / 1000) - 60, answeredInRound: 1n };
    const w = new OracleWatcher(t.rt, chain, [feed]);

    await setFast('1985'); // -0.75%
    let [s] = await w.poll();
    expect(s).toMatchObject({ chainlinkPrice: '2000', fastPrice: '1985', gap: '-0.0075', pressure: true });

    await setFast('1995'); // -0.25%
    [s] = await w.poll();
    expect(s!.pressure).toBe(false);

    await setFast('2010'); // fast above oracle: no pressure
    [s] = await w.poll();
    expect(s).toMatchObject({ gap: '0.005', pressure: false });

    const strict = new OracleWatcher(t.rt, chain, [feed], -0.002);
    await setFast('1995');
    [s] = await strict.poll();
    expect(s!.pressure).toBe(true); // -0.25% < -0.2%
  });

  it('ignores a stale fast price (older than 5 minutes) instead of reporting a bogus gap', async () => {
    const chain = new FakeChain(1);
    chain.latest = { roundId: joinRoundId(1n, 6n), answer: 200_000_000_000n, startedAt: 0, updatedAt: Math.floor(Date.now() / 1000), answeredInRound: 1n };
    await setFast('1500', 6 * 60_000);
    const [s] = await new OracleWatcher(t.rt, chain, [feed]).poll();
    expect(s).toMatchObject({ fastPrice: null, gap: null, pressure: false });
  });

  it('stores each new round once, publishes the state, and walks history inside the phase', async () => {
    const chain = new FakeChain(1);
    const latestId = joinRoundId(2n, 10n);
    chain.latest = { roundId: latestId, answer: 200_000_000_000n, startedAt: 0, updatedAt: 1_800_000_000, answeredInRound: 2n };
    for (let n = 1n; n < 10n; n++) chain.history.set(joinRoundId(2n, n), { roundId: joinRoundId(2n, n), answer: 190_000_000_000n + n, startedAt: 0, updatedAt: 1_799_000_000 + Number(n), answeredInRound: 2n });
    const w = new OracleWatcher(t.rt, chain, [feed]);
    await w.poll();
    await w.poll();
    const stored = await t.db.select().from(oracleRounds).where(eq(oracleRounds.feed, 'ETH-USD'));
    expect(stored.filter((r) => r.roundId === latestId.toString())).toHaveLength(1);
    expect(await w.walkHistory(feed, 200)).toBe(9); // rounds 9..1 then stops at the phase boundary
    expect((await t.db.select().from(oracleRounds)).length).toBeGreaterThanOrEqual(10);

    const snap = JSON.parse((await t.redis.get('snap:oracle:ETH-USD'))!);
    expect(snap.data.roundId).toBe(latestId.toString());
  });

  it('valuation prefers the Chainlink round at block time over candles', async () => {
    await seedAsset(t, 'WETH', 18, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    const v = new UsdValuer(t.db, t.redis);
    // rounds from the previous test: answer 190_000_000_000 + n => ~$1900.00000001..09 at ~1_799_000_000
    const price = await v.priceAt('ETH-USD', (1_799_000_005 + 30) * 1000);
    expect(price!.toFixed(0)).toBe('1900');
    const usd = await v.usdValue('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 2n * 10n ** 18n, (1_799_000_005 + 30) * 1000);
    expect(new Decimal(usd!).toFixed(0)).toBe('3800');
  });
});

describe('liquidation + oracle REST API', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
    await t.db.insert(assets).values([
      { chain: 1, address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18 },
      { chain: 1, address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', decimals: 8 },
    ]);
    const now = Date.now();
    const rowsIn = Array.from({ length: 5 }, (_, i) => ({
      txHash: '0x' + String(i + 1).padStart(64, '0'), logIndex: 0, blockNumber: 100 + i, blockHash: '0x' + String(i + 1).padStart(64, 'f'),
      ts: new Date(now - i * 20 * 60_000), collateralAsset: i % 2 ? '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' : '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      debtAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', user: '0x' + '1'.repeat(40), liquidator: '0x' + '2'.repeat(40),
      debtAmountRaw: '1000000', collateralAmountRaw: '1000000000000000000', usdValue: String((i + 1) * 100_000), status: 'confirmed',
    }));
    await t.db.insert(liquidations).values(rowsIn);
  });
  afterAll(() => t.close());

  it('lists newest first with cursor pagination and symbol enrichment', async () => {
    const p1 = (await t.app.inject({ url: '/api/v1/liquidations?limit=2' })).json();
    expect(p1.items.map((i: { blockNumber: number }) => i.blockNumber)).toEqual([100, 101]);
    expect(p1.items[0]).toMatchObject({ collateralSymbol: 'WETH', usdValue: '100000' });
    expect(p1).toMatchObject({ mode: 'live', source: 'aave-v3-mainnet' });
    const p2 = (await t.app.inject({ url: `/api/v1/liquidations?limit=2&cursor=${p1.nextCursor}` })).json();
    expect(p2.items.map((i: { blockNumber: number }) => i.blockNumber)).toEqual([102, 103]);
    const p3 = (await t.app.inject({ url: `/api/v1/liquidations?limit=2&cursor=${p2.nextCursor}` })).json();
    expect(p3.items.map((i: { blockNumber: number }) => i.blockNumber)).toEqual([104]);
    expect(p3.nextCursor).toBeNull();
  });

  it('filters by asset and minUsd; rejects a bad cursor', async () => {
    const wbtc = (await t.app.inject({ url: '/api/v1/liquidations?asset=0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' })).json();
    expect(wbtc.items.every((i: { collateralSymbol: string }) => i.collateralSymbol === 'WBTC')).toBe(true);
    const big = (await t.app.inject({ url: '/api/v1/liquidations?minUsd=300000' })).json();
    expect(big.items.map((i: { usdValue: string }) => i.usdValue).sort()).toEqual(['300000', '400000', '500000']);
    expect((await t.app.inject({ url: '/api/v1/liquidations?cursor=garbage' })).statusCode).toBe(400);
  });

  it('stats: totals, counts, top assets and an hourly series per window', async () => {
    const s = (await t.app.inject({ url: '/api/v1/liquidations/stats?window=24h' })).json();
    expect(s).toMatchObject({ window: '24h', totalUsd: '1500000', count: 5 });
    expect(s.topAssets[0].usd).toBe('900000'); // WBTC rows: 200k + 400k? -> check ordering below
    expect(s.hourly.length).toBeGreaterThan(0);
    const oneHour = (await t.app.inject({ url: '/api/v1/liquidations/stats?window=1h' })).json();
    expect(oneHour.count).toBeLessThanOrEqual(5);
  });

  it('oracle endpoint returns the published state, 404 when no feed data', async () => {
    expect((await t.app.inject({ url: '/api/v1/oracle/ETH-USD' })).statusCode).toBe(404);
    const chain = new FakeChain(1);
    chain.latest = { roundId: joinRoundId(1n, 5n), answer: 200_000_000_000n, startedAt: 0, updatedAt: Math.floor(Date.now() / 1000), answeredInRound: 1n };
    await t.redis.set('px:good:ETH-USD', JSON.stringify({ instrument: 'ETH-USD', price: '1980', ts: new Date().toISOString(), source: 'coinbase-ws', suspect: false }));
    await new OracleWatcher(t.rt, chain, [{ instrument: 'ETH-USD', feed: '0xfeed', heartbeatSec: 3600, deviation: 0.005 }]).poll();
    const r = (await t.app.inject({ url: '/api/v1/oracle/ETH-USD' })).json();
    expect(r.oracle).toMatchObject({ chainlinkPrice: '2000', fastPrice: '1980', gap: '-0.01', pressure: true });
    expect(r).toMatchObject({ source: 'chainlink', mode: 'live' });
  });
});
