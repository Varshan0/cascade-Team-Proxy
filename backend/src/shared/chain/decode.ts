import { decodeEventLog, decodeFunctionResult, type Hex } from 'viem';
import { aggregatorAbi, poolAbi } from './abi';

/** JSON-RPC log shape (hex strings), exactly as returned by eth_getLogs. */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  blockTimestamp?: string;
  removed?: boolean;
}

export interface DecodedLiquidation {
  collateralAsset: string; // lowercase 0x…
  debtAsset: string;
  user: string;
  liquidator: string;
  debtToCover: bigint;
  liquidatedCollateralAmount: bigint;
  receiveAToken: boolean;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  blockTimestamp?: number;
}

export function decodeLiquidation(log: RawLog): DecodedLiquidation {
  const { eventName, args } = decodeEventLog({
    abi: poolAbi,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data as Hex,
  });
  if (eventName !== 'LiquidationCall') throw new Error(`unexpected event ${eventName}`);
  return {
    collateralAsset: args.collateralAsset.toLowerCase(),
    debtAsset: args.debtAsset.toLowerCase(),
    user: args.user.toLowerCase(),
    liquidator: args.liquidator.toLowerCase(),
    debtToCover: args.debtToCover,
    liquidatedCollateralAmount: args.liquidatedCollateralAmount,
    receiveAToken: args.receiveAToken,
    blockNumber: Number(BigInt(log.blockNumber)),
    blockHash: log.blockHash.toLowerCase(),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex)),
    blockTimestamp: log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) : undefined,
  };
}

export interface RoundData {
  roundId: bigint;
  /** Raw int256 answer (8 decimals for USD feeds). Can in principle be negative. */
  answer: bigint;
  startedAt: number; // unix seconds
  updatedAt: number; // unix seconds
  answeredInRound: bigint;
}

/** Decode a `latestRoundData()` / `getRoundData()` return blob. viem decodes int256 as signed. */
export function parseRoundData(result: Hex): RoundData {
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = decodeFunctionResult({
    abi: aggregatorAbi,
    functionName: 'latestRoundData',
    data: result,
  });
  return { roundId, answer, startedAt: Number(startedAt), updatedAt: Number(updatedAt), answeredInRound };
}

const MASK_64 = (1n << 64n) - 1n;

/** roundId = (phaseId << 64) | aggregatorRoundId (spec section 3). */
export const splitRoundId = (roundId: bigint) => ({ phaseId: roundId >> 64n, aggregatorRound: roundId & MASK_64 });
export const joinRoundId = (phaseId: bigint, aggregatorRound: bigint) => (phaseId << 64n) | aggregatorRound;

/**
 * Previous round inside the same phase, or null at the phase boundary (aggregator rounds start at 1;
 * crossing into the earlier phase needs that phase's last round, which we can't know offline).
 */
export function previousRoundId(roundId: bigint): bigint | null {
  const { phaseId, aggregatorRound } = splitRoundId(roundId);
  return aggregatorRound > 1n ? joinRoundId(phaseId, aggregatorRound - 1n) : null;
}

export const answerToDecimalString = (answer: bigint, decimals = 8): string => {
  const neg = answer < 0n;
  const s = (neg ? -answer : answer).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
};
