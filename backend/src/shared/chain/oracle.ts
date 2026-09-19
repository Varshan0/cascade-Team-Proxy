import Decimal from 'decimal.js';
import { publishChannel, readPrice } from '../bus';
import { oracleRounds } from '../db/schema';
import { modeOf, type Runtime } from '../runtime';
import { CHAINLINK_DECIMALS, CHAINLINK_FEEDS } from './abi';
import { previousRoundId, type RoundData } from './decode';
import type { ChainRpc } from './rpc';

export interface OracleFeed {
  instrument: string;
  feed: string;
  heartbeatSec: number;
  deviation: number;
}

/**
 * Deviation threshold / heartbeat: NOT verified against data.chain.link in this build (site not consulted).
 * 0.5% / 3600s is the commonly published setting for ETH/USD and BTC/USD mainnet: confirm before relying on it.
 */
export const ORACLE_FEEDS: OracleFeed[] = [
  { instrument: 'ETH-USD', feed: CHAINLINK_FEEDS['ETH-USD'], heartbeatSec: 3600, deviation: 0.005 },
  { instrument: 'BTC-USD', feed: CHAINLINK_FEEDS['BTC-USD'], heartbeatSec: 3600, deviation: 0.005 },
];

/** A fast price older than this is not compared against Chainlink (spec: fresh within 5 minutes). */
export const FAST_PRICE_MAX_AGE_MS = 5 * 60_000;

export interface OracleState {
  symbol: string;
  chainlinkPrice: string;
  fastPrice: string | null;
  /** fast / chainlink - 1, as a decimal string (e.g. "-0.0072"). */
  gap: string | null;
  pressure: boolean;
  roundId: string;
  updatedAt: string;
  ageSec: number;
  heartbeatSec: number;
  deviation: number;
}

export const oracleChannel = (instrument: string) => `oracle:${instrument}`;

export function computeGap(fast: Decimal, chainlink: Decimal): Decimal {
  return fast.div(chainlink).minus(1);
}

const toPrice = (r: RoundData) => new Decimal(r.answer.toString()).div(new Decimal(10).pow(CHAINLINK_DECIMALS));

const roundRow = (instrument: string, r: RoundData) => ({
  feed: instrument,
  roundId: r.roundId.toString(),
  answer: r.answer.toString(),
  updatedAt: new Date(r.updatedAt * 1000),
});

export class OracleWatcher {
  constructor(
    private rt: Runtime,
    private rpc: ChainRpc,
    private feeds: OracleFeed[] = ORACLE_FEEDS,
    private pressureGap = rt.config.ORACLE_PRESSURE_GAP,
  ) {}

  /** Read every feed once: store any new round, compute the oracle gap, publish on `oracle:{instrument}`. */
  async poll(now = Date.now()): Promise<OracleState[]> {
    const out: OracleState[] = [];
    for (const f of this.feeds) {
      try {
        const round = await this.rpc.latestRound(f.feed);
        await this.rt.db.insert(oracleRounds).values(roundRow(f.instrument, round)).onConflictDoNothing();
        const state = await this.stateFor(f, round, now);
        await publishChannel(this.rt.redis, oracleChannel(f.instrument), state, { mode: modeOf(this.rt.config) });
        out.push(state);
      } catch (err) {
        this.rt.logger.warn({ err: (err as Error).message, feed: f.instrument }, 'oracle poll failed');
      }
    }
    return out;
  }

  async stateFor(f: OracleFeed, round: RoundData, now: number): Promise<OracleState> {
    const chainlink = toPrice(round);
    const fast = await readPrice(this.rt.redis, f.instrument, true);
    const fresh = fast && now - Date.parse(fast.ts) <= FAST_PRICE_MAX_AGE_MS ? new Decimal(fast.price) : null;
    const gap = fresh && chainlink.gt(0) ? computeGap(fresh, chainlink) : null;
    return {
      symbol: f.instrument,
      chainlinkPrice: chainlink.toFixed(),
      fastPrice: fresh?.toFixed() ?? null,
      gap: gap?.toDecimalPlaces(6).toFixed() ?? null,
      pressure: gap !== null && gap.lt(this.pressureGap),
      roundId: round.roundId.toString(),
      updatedAt: new Date(round.updatedAt * 1000).toISOString(),
      ageSec: Math.max(0, Math.floor(now / 1000) - round.updatedAt),
      heartbeatSec: f.heartbeatSec,
      deviation: f.deviation,
    };
  }

  /**
   * Walk history backward from the latest round (decrement the aggregator part inside the current phase)
   * so liquidations can be valued at the Chainlink price of their block time. Stops at a phase boundary.
   */
  async walkHistory(f: OracleFeed, maxRounds = 200, batch = 50): Promise<number> {
    const latest = await this.rpc.latestRound(f.feed);
    let cur: bigint | null = latest.roundId;
    let stored = 0;
    while (stored < maxRounds && cur !== null) {
      const ids: bigint[] = [];
      for (let i = 0; i < batch && cur !== null; i++) {
        cur = previousRoundId(cur);
        if (cur !== null) ids.push(cur);
      }
      if (ids.length === 0) break;
      const rows = (await this.rpc.roundsBatch(f.feed, ids)).filter((r): r is RoundData => r !== null);
      if (rows.length) await this.rt.db.insert(oracleRounds).values(rows.map((r) => roundRow(f.instrument, r))).onConflictDoNothing();
      stored += rows.length;
    }
    return stored;
  }
}
