import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
// Prices/quantities are stored as NUMERIC and surfaced as strings, then wrapped in decimal.js.
const dec = (name: string) => numeric(name, { precision: 38, scale: 12 });

export const instruments = pgTable('instruments', {
  symbol: text('symbol').primaryKey(), // ETH-USD
  base: text('base').notNull(),
  quote: text('quote').notNull(),
  name: text('name').notNull(),
  coingeckoId: text('coingecko_id'),
  coinbaseProductId: text('coinbase_product_id'),
  pythFeedId: text('pyth_feed_id'),
  chainlinkFeed: text('chainlink_feed'),
  enabled: boolean('enabled').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(100),
});

export const assets = pgTable(
  'assets',
  {
    id: serial('id').primaryKey(),
    chain: integer('chain').notNull().default(1),
    address: text('address').notNull(), // lowercase 0x…
    symbol: text('symbol').notNull(),
    decimals: integer('decimals').notNull(),
    priceFeed: text('price_feed'), // chainlink proxy address, if any
    priceSymbol: text('price_symbol'), // instrument used as fallback (candle price)
  },
  (t) => [uniqueIndex('assets_chain_address_uq').on(t.chain, t.address)],
);

export const ticks = pgTable(
  'ticks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    instrument: text('instrument').notNull(),
    price: dec('price').notNull(),
    size: dec('size'),
    side: text('side'),
    ts: ts('ts').notNull(),
    source: text('source').notNull(),
    suspect: boolean('suspect').notNull().default(false),
  },
  (t) => [index('ticks_instrument_ts_idx').on(t.instrument, t.ts)],
);

export const candles = pgTable(
  'candles',
  {
    instrument: text('instrument').notNull(),
    interval: text('interval').notNull(), // 1m 5m 15m 1h 4h 1d
    openTime: ts('open_time').notNull(),
    open: dec('open').notNull(),
    high: dec('high').notNull(),
    low: dec('low').notNull(),
    close: dec('close').notNull(),
    volume: dec('volume').notNull().default('0'),
    trades: integer('trades'),
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.instrument, t.interval, t.openTime] })],
);

export const oracleRounds = pgTable(
  'oracle_rounds',
  {
    feed: text('feed').notNull(),
    roundId: numeric('round_id', { precision: 40, scale: 0 }).notNull(),
    answer: numeric('answer', { precision: 40, scale: 0 }).notNull(), // raw int256, 8 decimals
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.feed, t.roundId] }), index('oracle_rounds_feed_ts_idx').on(t.feed, t.updatedAt)],
);

export const liquidations = pgTable(
  'liquidations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockHash: text('block_hash').notNull(),
    ts: ts('ts').notNull(),
    collateralAsset: text('collateral_asset').notNull(),
    debtAsset: text('debt_asset').notNull(),
    user: text('user').notNull(),
    liquidator: text('liquidator').notNull(),
    debtAmountRaw: numeric('debt_amount_raw', { precision: 80, scale: 0 }).notNull(),
    collateralAmountRaw: numeric('collateral_amount_raw', { precision: 80, scale: 0 }).notNull(),
    usdValue: dec('usd_value'),
    status: text('status').notNull().default('pending'), // pending | confirmed
  },
  (t) => [
    uniqueIndex('liquidations_tx_log_uq').on(t.txHash, t.logIndex),
    index('liquidations_ts_idx').on(t.ts),
    index('liquidations_collateral_ts_idx').on(t.collateralAsset, t.ts),
    index('liquidations_block_idx').on(t.blockNumber),
  ],
);

export const indexerState = pgTable('indexer_state', {
  key: text('key').primaryKey(),
  lastBlock: bigint('last_block', { mode: 'number' }).notNull(),
  meta: jsonb('meta'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const signalEvents = pgTable(
  'signal_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: ts('ts').notNull(),
    state: text('state').notNull(),
    mode: text('mode').notNull().default('live'),
    payload: jsonb('payload').notNull(),
  },
  (t) => [index('signal_events_ts_idx').on(t.ts)],
);

export const backtests = pgTable('backtests', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: text('status').notNull().default('queued'), // queued | running | done | failed
  request: jsonb('request').notNull(),
  result: jsonb('result'),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  address: text('address').notNull().unique(), // lowercase
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  refreshHash: text('refresh_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const settings = pgTable('settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  data: jsonb('data').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const watchlists = pgTable(
  'watchlists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('watchlists_user_idx').on(t.userId)],
);

export const watchlistItems = pgTable(
  'watchlist_items',
  {
    watchlistId: uuid('watchlist_id').notNull().references(() => watchlists.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.watchlistId, t.symbol] })],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id), // null for bot/system accounts
    name: text('name').notNull(),
    kind: text('kind').notNull().default('user'), // user | bot | system
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('accounts_user_idx').on(t.userId)],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    idempotencyKey: text('idempotency_key').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(), // buy | sell
    type: text('type').notNull(), // market | limit | stop_market | stop_limit
    tif: text('tif').notNull().default('GTC'),
    qty: dec('qty').notNull(),
    limitPrice: dec('limit_price'),
    stopPrice: dec('stop_price'),
    status: text('status').notNull().default('open'), // open | filled | cancelled | rejected
    filledQty: dec('filled_qty').notNull().default('0'),
    avgPrice: dec('avg_price'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_account_idem_uq').on(t.accountId, t.idempotencyKey),
    index('orders_account_created_idx').on(t.accountId, t.createdAt),
    index('orders_open_idx').on(t.status, t.symbol),
  ],
);

export const fills = pgTable(
  'fills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    qty: dec('qty').notNull(),
    price: dec('price').notNull(),
    fee: dec('fee').notNull(),
    liquidity: text('liquidity').notNull(), // maker | taker
    ts: ts('ts').notNull().defaultNow(),
  },
  (t) => [index('fills_account_ts_idx').on(t.accountId, t.ts)],
);

export const positions = pgTable(
  'positions',
  {
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    symbol: text('symbol').notNull(),
    qty: dec('qty').notNull(),
    avgCost: dec('avg_cost').notNull(),
    realizedPnl: dec('realized_pnl').notNull().default('0'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.symbol] })],
);

/** Double-entry: every movement writes >= 2 rows sharing a txId whose amounts per asset sum to zero. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    txId: uuid('tx_id').notNull(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    asset: text('asset').notNull(), // USD, ETH, BTC…
    amount: dec('amount').notNull(), // signed
    kind: text('kind').notNull(), // deposit | trade | fee
    refId: text('ref_id'),
    ts: ts('ts').notNull().defaultNow(),
  },
  (t) => [index('ledger_account_asset_idx').on(t.accountId, t.asset), index('ledger_tx_idx').on(t.txId)],
);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    kind: text('kind').notNull(), // price_above | price_below | pct_move | liq_spike | oracle_gap | signal_fired
    symbol: text('symbol'),
    params: jsonb('params').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('alerts_user_idx').on(t.userId), index('alerts_active_idx').on(t.active, t.kind)],
);

export const alertEvents = pgTable(
  'alert_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    alertId: uuid('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
    ts: ts('ts').notNull().defaultNow(),
    payload: jsonb('payload').notNull(),
  },
  (t) => [index('alert_events_alert_idx').on(t.alertId, t.ts)],
);

export const providerHealthSnapshots = pgTable(
  'provider_health_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    ts: ts('ts').notNull().defaultNow(),
    detail: jsonb('detail').notNull(),
  },
  (t) => [index('provider_health_provider_ts_idx').on(t.provider, t.ts)],
);

export const onchainProofs = pgTable('onchain_proofs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  signalHash: text('signal_hash').notNull().unique(),
  txHash: text('tx_hash'),
  chainId: integer('chain_id').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
