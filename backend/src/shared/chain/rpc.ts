import { createPublicClient, fallback, http, numberToHex, type Hex, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { HealthTracker } from '../providers/health';
import { AAVE_POOL, LIQUIDATION_TOPIC, aggregatorAbi, erc20Abi, erc20Bytes32Abi, poolAbi } from './abi';
import { parseRoundData, type RawLog, type RoundData } from './decode';

export interface BlockInfo {
  hash: string;
  timestamp: number; // unix seconds
}

export interface Reserve {
  address: string;
  symbol: string;
  decimals: number;
}

/** Everything the indexer and oracle watcher need from Ethereum. Tests substitute a scripted fake. */
export interface ChainRpc {
  getBlockNumber(): Promise<number>;
  /** LiquidationCall logs from the Aave V3 Pool in [fromBlock, toBlock]. */
  getLogs(fromBlock: number, toBlock: number): Promise<RawLog[]>;
  getBlock(n: number): Promise<BlockInfo>;
  latestRound(feed: string): Promise<RoundData>;
  roundsBatch(feed: string, ids: bigint[]): Promise<Array<RoundData | null>>;
  reserves(): Promise<Reserve[]>;
}

/** Provider messages that mean "your range/response is too big or too old", not "the node is down". */
export const isRangeRejection = (e: unknown): boolean =>
  /range|limit|exceed|too many|too large|archive|response size|more than|max/i.test(e instanceof Error ? e.message : String(e));

const LATEST_ROUND_DATA: Hex = '0xfeaf968c';

/** viem-backed RPC with an ordered fallback transport across RPC_URLS. */
export class EthRpc implements ChainRpc {
  /** Health of general RPC access, and of Chainlink reads specifically (the price Aave liquidates on). */
  readonly tracker = new HealthTracker('rpc');
  readonly oracleTracker = new HealthTracker('chainlink-rpc');
  private client: PublicClient;

  constructor(urls: string[]) {
    this.client = createPublicClient({
      chain: mainnet,
      transport: fallback(urls.map((u) => http(u, { timeout: 10_000, retryCount: 1 })), { retryCount: 1, rank: false }),
    });
  }

  private async track<T>(tracker: HealthTracker, fn: () => Promise<T>, expected: (e: unknown) => boolean = () => false): Promise<T> {
    const t0 = Date.now();
    try {
      const v = await fn();
      tracker.recordSuccess(Date.now() - t0);
      return v;
    } catch (err) {
      // e.g. eth_getLogs range rejections: the indexer probes limits on purpose, so they must not read as an outage
      if (!expected(err)) tracker.recordError(err, Date.now() - t0);
      throw err;
    }
  }

  getBlockNumber(): Promise<number> {
    return this.track(this.tracker, async () => Number(await this.client.getBlockNumber()));
  }

  getLogs(fromBlock: number, toBlock: number): Promise<RawLog[]> {
    return this.track(
      this.tracker,
      async () => {
      const logs = await this.client.request({
        method: 'eth_getLogs',
        params: [{ address: AAVE_POOL, topics: [LIQUIDATION_TOPIC], fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }],
      });
      return logs
        .filter((l) => l.blockNumber !== null && l.blockHash !== null && l.transactionHash !== null && l.logIndex !== null)
        .map((l) => ({
          address: l.address,
          topics: [...l.topics],
          data: l.data,
          blockNumber: l.blockNumber!,
          blockHash: l.blockHash!,
          transactionHash: l.transactionHash!,
          logIndex: l.logIndex!,
          removed: l.removed,
          blockTimestamp: (l as { blockTimestamp?: string }).blockTimestamp,
        }));
      },
      isRangeRejection,
    );
  }

  getBlock(n: number): Promise<BlockInfo> {
    return this.track(this.tracker, async () => {
      const b = await this.client.getBlock({ blockNumber: BigInt(n) });
      return { hash: b.hash, timestamp: Number(b.timestamp) };
    });
  }

  latestRound(feed: string): Promise<RoundData> {
    return this.track(this.oracleTracker, async () => {
      const r = await this.client.call({ to: feed as Hex, data: LATEST_ROUND_DATA });
      if (!r.data) throw new Error('empty latestRoundData result');
      return parseRoundData(r.data);
    });
  }

  roundsBatch(feed: string, ids: bigint[]): Promise<Array<RoundData | null>> {
    return this.track(this.oracleTracker, async () => {
      const res = await this.client.multicall({
        contracts: ids.map((id) => ({ address: feed as Hex, abi: aggregatorAbi, functionName: 'getRoundData' as const, args: [id] as const })),
        allowFailure: true,
      });
      return res.map((r) => {
        if (r.status !== 'success') return null;
        const [roundId, answer, startedAt, updatedAt, answeredInRound] = r.result;
        return { roundId, answer, startedAt: Number(startedAt), updatedAt: Number(updatedAt), answeredInRound };
      });
    });
  }

  reserves(): Promise<Reserve[]> {
    return this.track(this.tracker, async () => {
      const list = await this.client.readContract({ address: AAVE_POOL, abi: poolAbi, functionName: 'getReservesList' });
      const symbols = await this.client.multicall({ contracts: list.map((a) => ({ address: a, abi: erc20Abi, functionName: 'symbol' as const })), allowFailure: true });
      const decimals = await this.client.multicall({ contracts: list.map((a) => ({ address: a, abi: erc20Abi, functionName: 'decimals' as const })), allowFailure: true });
      const out: Reserve[] = [];
      for (let i = 0; i < list.length; i++) {
        const address = list[i]!.toLowerCase();
        let symbol: string | undefined = symbols[i]!.status === 'success' ? (symbols[i]!.result as string) : undefined;
        if (!symbol) {
          try {
            const raw = await this.client.readContract({ address: list[i]!, abi: erc20Bytes32Abi, functionName: 'symbol' });
            symbol = Buffer.from(raw.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
          } catch {
            symbol = address.slice(0, 8);
          }
        }
        const d = decimals[i]!;
        out.push({ address, symbol, decimals: d.status === 'success' ? Number(d.result) : 18 });
      }
      return out;
    });
  }
}
