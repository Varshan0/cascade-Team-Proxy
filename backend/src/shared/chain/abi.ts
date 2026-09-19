import { parseAbi } from 'viem';

/** Aave V3 Pool, Ethereum mainnet (spec section 3). */
export const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as const;
/** keccak256 of the LiquidationCall signature; asserted against viem's own hash in tests. */
export const LIQUIDATION_TOPIC = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286' as const;

export const poolAbi = parseAbi([
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
  'function getReservesList() view returns (address[])',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
]);

export const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

export const erc20Abi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
/** A few old tokens (MKR, SNX-style) return bytes32 from symbol(). */
export const erc20Bytes32Abi = parseAbi(['function symbol() view returns (bytes32)']);

/** Chainlink proxies (spec section 3). Both use 8 decimals. */
export const CHAINLINK_FEEDS = {
  'ETH-USD': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  'BTC-USD': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
} as const;
export const CHAINLINK_DECIMALS = 8;
