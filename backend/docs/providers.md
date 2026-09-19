# Provider notes

Status legend: **Verified live** = I called the endpoint and inspected the real response. **Docs only** = read from
docs, not exercised. **Unverified** = could not confirm; the client stays disabled behind `PROVIDER_FLAGS`.

Last verification pass: **2026-09-19** (M1 docs pass, then M2-M4 live probing from the build machine).

## Coinbase Exchange (primary real-time + candles)

| Item | Value | Status |
|---|---|---|
| REST base | `https://api.exchange.coinbase.com` | Verified live |
| Ticker | `GET /products/{id}/ticker` → `{ask,bid,volume,trade_id,price,size,time,rfq_volume}` (strings) | Verified live, **no auth** |
| Candles | `GET /products/{id}/candles?granularity=60\|300\|900\|3600\|21600\|86400` → `[[time,low,high,open,close,volume],…]`, newest first, max 300 per call | Verified live, **no auth** |
| Book | `GET /products/{id}/book?level=2` → `{bids:[[price,size,num_orders]],asks:…}` | Verified live, **no auth** |
| WS | `wss://ws-feed.exchange.coinbase.com`, channel `ticker`; frames carry `price, best_bid, best_ask, side, time, last_size, open_24h, high_24h, low_24h, volume_24h`. Public channels also include `ticker_batch`, `level2_batch`, `matches`, `heartbeat`; `level2` (non-batch) needs auth. | Verified live (`ticker`); others docs only |
| Rate limit | Not stated on the pages fetched; the client uses a conservative 5 req/s bucket. Sustained backfill ran ~1.2 s p95 per call with no 429s. | Unverified |

**Discrepancy:** the docs page for `getproductcandles` says auth headers are required, but unauthenticated calls
returned data. Treat as "works today, may be tightened", which is why Coinbase Advanced Trade is the REST fallback.

Coinbase has no 4h candle: 4h is built from 1h. Granularity 21600 is 6h, not 4h.

## Coinbase Advanced Trade public market data (candles fallback)

`GET https://api.coinbase.com/api/v3/brokerage/market/products/{id}/candles?start=&end=&granularity=…`
→ `{candles:[{start,low,high,open,close,volume}]}` (strings, `start` in unix seconds).
`ONE_MINUTE`, `ONE_HOUR` and `ONE_DAY` **verified live**, no auth. Other granularities are assumed from naming and unused.

## Pyth Hermes (disabled)

- Unauthenticated `hermes.pyth.network` returns **401** (verified live). Keys required since 26 Aug 2026.
- Would use `PYTH_BASE_URL=https://pyth.dourolabs.app/hermes` with `Authorization: Bearer <PYTH_API_KEY>`.
- Response shape of `/v2/updates/price/latest`: **not verified** (no key available). `PROVIDER_FLAGS.pyth = false`.

## CoinGecko

- `GET https://api.coingecko.com/api/v3/ping`, `/coins/markets` and `/search/trending` return data **without a key**
  (verified live), but **keyless calls started returning HTTP 429 after roughly ten requests within a few minutes**
  (also seen on `/coins/{id}/ohlc` and `/simple/price`). The client uses a tiny token bucket and never gates readiness on it.
- `/coins/markets` items include `id, symbol, name, current_price, market_cap, market_cap_rank, total_volume,
  high_24h, low_24h, price_change_24h, price_change_percentage_24h, ath, circulating_supply, max_supply`.
- Demo-key header `x-cg-demo-api-key` and per-minute limits: **not verified** (docs fetch returned only an overview).
- `/coins/{id}/ohlc`: **unverified** (429 during probing); not in the candles chain (`PROVIDER_FLAGS.coingeckoOhlc = false`).

## Chainlink via Ethereum RPC

- `latestRoundData()` (`0xfeaf968c`) on the ETH/USD proxy `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` and BTC/USD proxy
  `0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c` **verified live**: five 32-byte words
  `(roundId, answer, startedAt, updatedAt, answeredInRound)`, `answer` is `int256` with 8 decimals (decoded as signed).
- `getRoundData` batched through multicall3 works on the keyless RPCs (200 rounds walked back inside the current phase).
- Deviation thresholds / heartbeats (assumed 0.5% / 1h): **unverified**; confirm on data.chain.link.

## Ethereum RPC

Probed live 2026-09-19, all keyless:

| RPC | Result |
|---|---|
| `ethereum-rpc.publicnode.com` | Fine with **curl**, but Node's `fetch`/viem gets `ECONNRESET` on the build machine (TLS-level; not IPv6, not the user-agent). `eth_getLogs` served a **10,000-block** range near the head; **50,000+ returned "Archive requests require a personal token"**. |
| `1rpc.io/eth` | Works from Node. `eth_getLogs` **limited to 50 blocks**. Rate-limits under sustained load. |
| `cloudflare-eth.com` | Works, but rejects large `eth_getLogs` ranges; intermittent "internal error". |
| `rpc.ankr.com/eth` | Needs an API key. |
| `eth.drpc.org`, `eth-mainnet.public.blastapi.io` | `ECONNRESET` from Node. |

Consequences built into the code: `RPC_URLS` is an ordered viem fallback list. The Aave indexer starts its live tail at
the head and backfills **backwards** with adaptive chunks (10,000 → ÷4 → floor `LIQ_MIN_CHUNK`), backs off on transient
errors and stops on repeated archive rejections. Keyless it reaches back hours, not 30 days: put an Alchemy/Infura URL
first in `RPC_URLS`. `eth_subscribe` and Alchemy/Infura/QuickNode per-plan limits: **unverified** (no keys).

`getReservesList()` on the Aave Pool returned **67 reserves** through the fallback RPCs on one run and a spurious revert
on another (RPC flakiness). The seed script falls back to a static list of the 12 most common reserves.

## Explorer data

- Blockscout `GET https://eth.blockscout.com/api/v2/stats` → `gas_prices:{slow,average,fast}`, `coin_price`,
  `average_block_time` (ms). **Verified live, no key.** Not consumed yet (gas/chain status is P1, not built).
- Etherscan V2: single key works across chains with the `chainid` param (docs). Gas-oracle path and free-tier limit: **unverified**.

## CoinMarketCap, CryptoCompare / CoinDesk data API (disabled)

Docs hosts were unreachable or empty during verification. **Unverified**; `PROVIDER_FLAGS.coinmarketcap = false` and
`.cryptocompare = false`. The failover chains work without them.
