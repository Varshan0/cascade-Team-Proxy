# REST API

Generated from `openapi.json` (exported from the running backend) plus responses captured from `npm run demo:offline`.
Every example below is a **real response** (see `fixtures/`). Arrays are shortened to 2 items here; the fixture holds the full response.

## Conventions

- **Base URL:** `http://localhost:8080` (the backend's default port). All data endpoints are under `/api/v1`; health endpoints are at the root.
- **CORS:** allowed origin is `http://localhost:5173` by default (set by the backend's `CORS_ORIGINS`), with credentials.
- **Rate limit:** 300 requests/minute per client. Exceeding it returns HTTP 429 with the error shape below.
- **Decimals are strings** ("2917.02", never a JSON number) in every market/liquidation field. Parse with a decimal library, not `parseFloat`, for money.
  The exceptions are documented per field: signal meters (`drop`, `z`, `liq1h`, `mean`, `price`, `equity`) are JSON **numbers** (they are analytics, not balances).
- **Timestamps** are ISO-8601 UTC strings.
- **Every market-data response has `asOf`, `mode` and `source`.** `mode` is `live` | `offline` | `drill` | `replay` (replay is reserved and not implemented). `asOf` is when the server built the response.
- **Errors** always have this shape (HTTP status ≥ 400):
  ```json
  { "error": { "code": "not_found", "message": "Unknown instrument DOGE-USD" } }
  ```
  Codes: `validation_error` (400, has `details`), `bad_request` (400), `not_found` (404), `conflict` (409), `rate_limited` (429), `unavailable` (503), `internal_error` (500).
  `unavailable` means "not ready yet" (e.g. no price yet just after startup): retry after a second or two.
- **Pagination** is cursor-based: pass the previous response's `nextCursor` as `cursor`; `nextCursor: null` means the last page.
- **The offline demo has two instruments**: `ETH-USD` and `BTC-USD`. Other symbols return 404.
- **Not implemented** (do not build UI that needs them): authentication, user watchlists/orders/portfolio/alerts, order book, trades tape, movers, trending, technicals, news, wallet, backtests, replay.

## Starting a drill (the exact endpoint)

```http
POST /api/v1/demo/drill
Content-Type: application/json

{"speed": 1}
```

- Always send a JSON body (`{}` is fine); `speed` is optional, 0.5–1000, default 1. At speed 1 the whole drill takes about 40 s; `speed: 20` takes about 2 s.
- **Response 202** `{"status":"started","speed":1}`. It returns immediately; the drill runs in the background.
- **409** if a drill is already running.
- Watch it on the WebSocket (`signal`, `ticker:ETH-USD`, `candles:ETH-USD:1m`, `liquidations`; see `ws.md`) or poll `GET /api/v1/demo/drill` until `status` is `"done"`.
- A drill never touches real data or accounts. All of its WebSocket messages carry `"synthetic": true` and `"mode": "drill"`; show a banner.

## Endpoints

### `GET /api/v1/instruments`

Tradable instruments

**Responses:** `200` (plus the error shape above for any failure)

**Example**: `fixtures/instruments.json`

```json
{
  "asOf": "2026-09-19T15:31:33.694Z",
  "mode": "offline",
  "source": "db",
  "instruments": [
    {
      "symbol": "ETH-USD",
      "base": "ETH",
      "quote": "USD",
      "name": "Ethereum",
      "sortOrder": 1
    },
    {
      "symbol": "BTC-USD",
      "base": "BTC",
      "quote": "USD",
      "name": "Bitcoin",
      "sortOrder": 2
    }
  ]
}
```

### `GET /api/v1/instruments/{symbol}/quote`

Live quote with 24h stats, 52-week range, all-time high and market data

| Param | In | Type | Required |
|---|---|---|---|
| `symbol` | path | string, pattern `^[A-Z0-9]+-[A-Z]+$` | yes |

**Responses:** `200` (plus the error shape above for any failure)

**Example**: `fixtures/quote-ETH-USD.json`

```json
{
  "asOf": "2026-09-19T15:31:33.734Z",
  "mode": "offline",
  "source": "simulator",
  "quote": {
    "symbol": "ETH-USD",
    "price": "2917.76",
    "change24h": "114.2",
    "changePct24h": "4.0734",
    "open24h": "2803.56",
    "high24h": "2928.51",
    "low24h": "2724.96",
    "previousClose": "2814.84",
    "volume24h": "18647.3913",
    "marketCap": null,
    "rank": null,
    "high52w": "3640.72",
    "low52w": "2211.71",
    "allTimeHigh": "3640.72",
    "circulatingSupply": null,
    "maxSupply": null,
    "updatedAt": "2026-09-19T15:31:33.028Z",
    "sources": [
      "simulator",
      "sim"
    ]
  }
}
```

**Example** (unknown or disabled symbol → 404): `fixtures/error-404-unknown-instrument.json`

```json
{
  "error": {
    "code": "not_found",
    "message": "Unknown instrument DOGE-USD"
  }
}
```

**Example** (malformed symbol → 400): `fixtures/error-400-validation.json`

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "details": [
      {
        "keyword": "invalid_format",
        "instancePath": "/symbol",
        "schemaPath": "#/symbol/invalid_format",
        "message": "expected e.g. ETH-USD",
        "params": {
          "origin": "string",
          "format": "regex",
          "pattern": "/^[A-Z0-9]+-[A-Z]+$/"
        }
      }
    ]
  }
}
```

### `GET /api/v1/instruments/{symbol}/candles`

OHLCV candles. Use `range` (chart tabs) or `from`/`to`; interval is chosen for you if omitted.

| Param | In | Type | Required |
|---|---|---|---|
| `interval` | query | `1m` \| `5m` \| `15m` \| `1h` \| `4h` \| `1d` | no |
| `range` | query | `1D` \| `1W` \| `1M` \| `3M` \| `1Y` \| `5Y` \| `All` | no |
| `from` | query | string, date-time, ISO-8601 with offset, e.g. `2026-09-19T00:00:00Z` | no |
| `to` | query | string, date-time, ISO-8601 with offset, e.g. `2026-09-19T00:00:00Z` | no |
| `limit` | query | integer, ≥ 1, ≤ 2000, default `500` | no |
| `symbol` | path | string, pattern `^[A-Z0-9]+-[A-Z]+$` | yes |

**Responses:** `200` (plus the error shape above for any failure)

**Example** (`interval=1h&limit=30`): `fixtures/candles-1h.json` (arrays shortened)

```json
{
  "asOf": "2026-09-19T15:31:33.801Z",
  "mode": "offline",
  "source": "simulator",
  "symbol": "ETH-USD",
  "interval": "1h",
  "candles": [
    {
      "t": "2026-09-18T16:00:00.000Z",
      "o": "2833.64",
      "h": "2846.34",
      "l": "2829.83",
      "c": "2842.44",
      "v": "758.7594",
      "source": "sim"
    },
    {
      "t": "2026-09-18T17:00:00.000Z",
      "o": "2842.32",
      "h": "2867.25",
      "l": "2837.51",
      "c": "2862.87",
      "v": "758.574",
      "source": "sim"
    }
  ]
}
```

**Example** (`interval=5m&limit=30`): `fixtures/candles-5m.json` (arrays shortened)

```json
{
  "asOf": "2026-09-19T15:31:33.782Z",
  "mode": "offline",
  "source": "simulator",
  "symbol": "ETH-USD",
  "interval": "5m",
  "candles": [
    {
      "t": "2026-09-19T13:05:00.000Z",
      "o": "2915.61",
      "h": "2916.52",
      "l": "2907.01",
      "c": "2907.15",
      "v": "63.3099",
      "source": "sim"
    },
    {
      "t": "2026-09-19T13:10:00.000Z",
      "o": "2906.16",
      "h": "2912.38",
      "l": "2903.01",
      "c": "2911.69",
      "v": "63.701",
      "source": "sim"
    }
  ]
}
```

**Example** (`interval=1d&limit=30`): `fixtures/candles-1d.json`

```json
{
  "asOf": "2026-09-19T15:31:33.820Z",
  "mode": "offline",
  "source": "simulator",
  "symbol": "ETH-USD",
  "interval": "1d",
  "candles": [
    {
      "t": "2026-09-19T00:00:00.000Z",
      "o": "2816.08",
      "h": "2928.51",
      "l": "2781.83",
      "c": "2917.76",
      "v": "11793.3076",
      "source": "simulator"
    }
  ]
}
```

**Example** (`range=1D&limit=12` (interval auto-picked = 5m)): `fixtures/candles-range-1D.json` (arrays shortened)

```json
{
  "asOf": "2026-09-19T15:31:33.834Z",
  "mode": "offline",
  "source": "simulator",
  "symbol": "ETH-USD",
  "interval": "5m",
  "candles": [
    {
      "t": "2026-09-19T14:35:00.000Z",
      "o": "2914.4",
      "h": "2918.14",
      "l": "2912.1",
      "c": "2912.1",
      "v": "62.9221",
      "source": "sim"
    },
    {
      "t": "2026-09-19T14:40:00.000Z",
      "o": "2911.17",
      "h": "2923.18",
      "l": "2908.85",
      "c": "2921.27",
      "v": "63.9669",
      "source": "sim"
    }
  ]
}
```

### `GET /api/v1/liquidations`

Aave V3 liquidations, newest first, cursor-paginated

| Param | In | Type | Required |
|---|---|---|---|
| `from` | query | string, date-time, ISO-8601 with offset, e.g. `2026-09-19T00:00:00Z` | no |
| `to` | query | string, date-time, ISO-8601 with offset, e.g. `2026-09-19T00:00:00Z` | no |
| `asset` | query | string, pattern `^0x[0-9a-fA-F]{40}$` | no |
| `minUsd` | query | string, pattern `^\d+(\.\d+)?$` | no |
| `limit` | query | integer, ≥ 1, ≤ 200, default `50` | no |
| `cursor` | query | string | no |

**Responses:** `200` (plus the error shape above for any failure)

**Example**: `fixtures/liquidations.json` (arrays shortened)

```json
{
  "asOf": "2026-09-19T15:31:33.852Z",
  "mode": "offline",
  "source": "aave-v3-mainnet",
  "items": [
    {
      "id": 5204,
      "txHash": "0x5150000000000000000000000000000000000000000000000000000000000a25",
      "logIndex": 0,
      "blockNumber": 149152579,
      "ts": "2026-09-19T15:15:50.000Z",
      "collateralAsset": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "collateralSymbol": "WETH",
      "debtAsset": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "debtSymbol": "USDC",
      "user": "0x5151515151515151515151515151515151515151",
      "liquidator": "0x5252525252525252525252525252525252525252",
      "debtAmountRaw": "26677940825",
      "collateralAmountRaw": "0",
      "usdValue": "26677.940825",
      "status": "confirmed",
      "txUrl": "https://etherscan.io/tx/0x5150000000000000000000000000000000000000000000000000000000000a25"
    },
    {
      "id": 5203,
      "txHash": "0x5150000000000000000000000000000000000000000000000000000000000a24",
      "logIndex": 0,
      "blockNumber": 149152548,
      "ts": "2026-09-19T15:09:40.000Z",
      "collateralAsset": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "collateralSymbol": "WETH",
      "debtAsset": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "debtSymbol": "USDC",
      "user": "0x5151515151515151515151515151515151515151",
      "liquidator": "0x5252525252525252525252525252525252525252",
      "debtAmountRaw": "93521412368",
      "collateralAmountRaw": "0",
      "usdValue": "93521.412368",
      "status": "confirmed",
      "txUrl": "https://etherscan.io/tx/0x5150000000000000000000000000000000000000000000000000000000000a24"
    }
  ],
  "nextCursor": "MjAyNi0wOS0xOVQxMDo1Nzo0MC4wMDBafDUxOTU"
}
```

**Example** (next page via `cursor=<nextCursor>`): `fixtures/liquidations-page2.json` (arrays shortened)

```json
{
  "asOf": "2026-09-19T15:31:33.872Z",
  "mode": "offline",
  "source": "aave-v3-mainnet",
  "items": [
    {
      "id": 5194,
      "txHash": "0x5150000000000000000000000000000000000000000000000000000000000a1b",
      "logIndex": 0,
      "blockNumber": 149150868,
      "ts": "2026-09-19T09:33:40.000Z",
      "collateralAsset": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "collateralSymbol": "WETH",
      "debtAsset": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "debtSymbol": "USDC",
      "user": "0x5151515151515151515151515151515151515151",
      "liquidator": "0x5252525252525252525252525252525252525252",
      "debtAmountRaw": "47880186181",
      "collateralAmountRaw": "0",
      "usdValue": "47880.186181",
      "status": "confirmed",
      "txUrl": "https://etherscan.io/tx/0x5150000000000000000000000000000000000000000000000000000000000a1b"
    },
    {
      "id": 5193,
      "txHash": "0x5150000000000000000000000000000000000000000000000000000000000a1a",
      "logIndex": 0,
      "blockNumber": 149150514,
      "ts": "2026-09-19T08:22:50.000Z",
      "collateralAsset": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "collateralSymbol": "WETH",
      "debtAsset": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "debtSymbol": "USDC",
      "user": "0x5151515151515151515151515151515151515151",
      "liquidator": "0x5252525252525252525252525252525252525252",
      "debtAmountRaw": "56423309248",
      "collateralAmountRaw": "0",
      "usdValue": "56423.309248",
      "status": "confirmed",
      "txUrl": "https://etherscan.io/tx/0x5150000000000000000000000000000000000000000000000000000000000a1a"
    }
  ],
  "nextCursor": "MjAyNi0wOS0xOVQwNjozMTo1MC4wMDBafDUxODU"
}
```

### `GET /api/v1/liquidations/stats`

Totals, counts, top collateral assets and an hourly series

| Param | In | Type | Required |
|---|---|---|---|
| `window` | query | `1h` \| `24h` \| `7d` | no |

**Responses:** `200` (plus the error shape above for any failure)

**Example** (`window=24h`): `fixtures/liquidations-stats-24h.json` (arrays shortened)

```json
{
  "asOf": "2026-09-19T15:31:33.932Z",
  "mode": "offline",
  "source": "aave-v3-mainnet",
  "window": "24h",
  "totalUsd": "8295425.985604",
  "count": 101,
  "topAssets": [
    {
      "asset": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "symbol": "WETH",
      "usd": "8295425.985604",
      "count": 101
    }
  ],
  "hourly": [
    {
      "hour": "2026-09-18T16:00:00.000Z",
      "usd": "676304.689601",
      "count": 8
    },
    {
      "hour": "2026-09-18T17:00:00.000Z",
      "usd": "399793.354081",
      "count": 5
    }
  ]
}
```

**Example** (`window=1h`): `fixtures/liquidations-stats-1h.json`

```json
{
  "asOf": "2026-09-19T15:31:33.910Z",
  "mode": "offline",
  "source": "aave-v3-mainnet",
  "window": "1h",
  "totalUsd": "326501.260276",
  "count": 4,
  "topAssets": [
    {
      "asset": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "symbol": "WETH",
      "usd": "326501.260276",
      "count": 4
    }
  ],
  "hourly": [
    {
      "hour": "2026-09-19T14:00:00.000Z",
      "usd": "206301.907083",
      "count": 2
    },
    {
      "hour": "2026-09-19T15:00:00.000Z",
      "usd": "120199.353193",
      "count": 2
    }
  ]
}
```

**Example** (`window=7d`): `fixtures/liquidations-stats-7d.json` (arrays shortened)

```json
{
  "asOf": "2026-09-19T15:31:33.959Z",
  "mode": "offline",
  "source": "aave-v3-mainnet",
  "window": "7d",
  "totalUsd": "95297347.405595",
  "count": 601,
  "topAssets": [
    {
      "asset": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "symbol": "WETH",
      "usd": "95297347.405595",
      "count": 601
    }
  ],
  "hourly": [
    {
      "hour": "2026-09-12T15:00:00.000Z",
      "usd": "134017.067447",
      "count": 3
    },
    {
      "hour": "2026-09-12T16:00:00.000Z",
      "usd": "270155.9101",
      "count": 4
    }
  ]
}
```

### `GET /api/v1/oracle/{symbol}`

Chainlink price (what Aave liquidates on) vs the fast market price, and the gap between them

| Param | In | Type | Required |
|---|---|---|---|
| `symbol` | path | string, pattern `^[A-Z0-9]+-[A-Z]+$` | yes |

**Responses:** `200` (plus the error shape above for any failure)

**Example**: `fixtures/oracle-ETH-USD.json`

```json
{
  "asOf": "2026-09-19T15:31:33.968Z",
  "mode": "offline",
  "source": "chainlink",
  "oracle": {
    "symbol": "ETH-USD",
    "chainlinkPrice": "2916.76833254",
    "fastPrice": "2917.76",
    "gap": "0.00034",
    "pressure": false,
    "roundId": "18446744073709553062",
    "updatedAt": "2026-09-19T14:35:30.000Z",
    "ageSec": 3363,
    "heartbeatSec": 3600,
    "deviation": 0.005
  }
}
```

**Example**: `fixtures/oracle-BTC-USD.json`

```json
{
  "asOf": "2026-09-19T15:31:33.977Z",
  "mode": "offline",
  "source": "chainlink",
  "oracle": {
    "symbol": "BTC-USD",
    "chainlinkPrice": "137765.7978142",
    "fastPrice": "138077.31",
    "gap": "0.002261",
    "pressure": false,
    "roundId": "18446744073709553084",
    "updatedAt": "2026-09-19T15:13:00.000Z",
    "ageSec": 1113,
    "heartbeatSec": 3600,
    "deviation": 0.005
  }
}
```

### `GET /api/v1/signals/state`

Current Cascade Catcher state, meters and reason (the drill's synthetic state while a drill runs)

**Responses:** `200` (plus the error shape above for any failure)

**Example**: `fixtures/signal-state.json`

```json
{
  "asOf": "2026-09-19T15:31:33.983Z",
  "mode": "offline",
  "source": "cascade-engine",
  "synthetic": false,
  "drillActive": false,
  "state": {
    "state": "watching",
    "drop": -0.0035417513396835965,
    "z": -0.08534924907137079,
    "liq1h": 326501.260276,
    "mean": 566008.5626935953,
    "thresholds": {
      "dropThresh": 0.04,
      "zThresh": 3,
      "minLiqUsd": 1000000
    },
    "met": {
      "drop": false,
      "z": false,
      "liq": false
    },
    "reason": "drop -0.35% (need <= -4.00%) ✗ · z -0.09 (need >= 3) ✗ · liq 1h $326,501 (need >= $1.00M) ✗",
    "symbol": "ETH-USD",
    "price": 2917.56,
    "priceSource": "fast",
    "equity": 10000,
    "position": null,
    "pausedUntil": null,
    "ts": "2026-09-19T15:31:29.019Z"
  }
}
```

**Example** (while a drill is running: `mode:"drill"`, `synthetic:true`): `fixtures/signal-state-during-drill.json`

```json
{
  "asOf": "2026-09-19T15:33:39.999Z",
  "mode": "drill",
  "source": "cascade-engine",
  "synthetic": true,
  "drillActive": true,
  "state": {
    "state": "partial",
    "drop": -0.01658928449676933,
    "z": 205.19626690171685,
    "liq1h": 6731830.298661457,
    "mean": 123884.23901134437,
    "thresholds": {
      "dropThresh": 0.04,
      "zThresh": 3,
      "minLiqUsd": 1000000
    },
    "met": {
      "drop": false,
      "z": true,
      "liq": true
    },
    "reason": "drop -1.66% (need <= -4.00%) ✗ · z 205.20 (need >= 3) ✓ · liq 1h $6.73M (need >= $1.00M) ✓",
    "symbol": "ETH-USD",
    "price": 2870.5035190103345,
    "priceSource": "fast",
    "equity": 10000,
    "position": null,
    "pausedUntil": null,
    "ts": "2026-09-19T15:33:39.634Z",
    "drill": {
      "id": "133c7296-3476-48f8-8004-eed59cc79fac",
      "seq": 14
    }
  }
}
```

### `GET /api/v1/signals/history`

State transitions (live engine only; drills are never recorded)

| Param | In | Type | Required |
|---|---|---|---|
| `limit` | query | integer, ≥ 1, ≤ 200, default `50` | no |
| `cursor` | query | integer, ≥ -9007199254740991, ≤ 9007199254740991 | no |

**Responses:** `200` (plus the error shape above for any failure)

**Example**: `fixtures/signal-history.json`

```json
{
  "asOf": "2026-09-19T15:31:34.001Z",
  "mode": "offline",
  "source": "cascade-engine",
  "items": [
    {
      "id": 1,
      "ts": "2026-09-19T14:34:58.894Z",
      "state": "watching",
      "mode": "offline",
      "payload": {
        "events": [],
        "signal": {
          "z": -0.08535275206650539,
          "ts": "2026-09-19T14:34:58.894Z",
          "met": {
            "z": false,
            "liq": false,
            "drop": false
          },
          "drop": -0.003812136034673008,
          "mean": 566008.5626935953,
          "liq1h": 326501.260276,
          "price": 2916.76833254,
          "state": "watching",
          "equity": 10000,
          "reason": "drop -0.38% (need <= -4.00%) ✗ · z -0.09 (need >= 3) ✗ · liq 1h $326,501 (need >= $1.00M) ✗",
          "symbol": "ETH-USD",
          "position": null,
          "thresholds": {
            "zThresh": 3,
            "minLiqUsd": 1000000,
            "dropThresh": 0.04
          },
          "pausedUntil": null,
          "priceSource": "chainlink"
        }
      }
    }
  ],
  "nextCursor": null
}
```

### `GET /api/v1/signals/bot`

The strategy bot's own paper account: balances, open position and trade history (never a user's account)

**Responses:** `200` (plus the error shape above for any failure)

**Example** (from the live offline demo (the bot has not traded yet, so `trades` is empty)): `fixtures/signal-bot.json`

```json
{
  "asOf": "2026-09-19T15:31:34.030Z",
  "mode": "offline",
  "source": "cascade-engine",
  "account": {
    "id": "1e850e0f-f459-4b0e-8d8f-9bf067ff1d6d",
    "name": "cascade-bot",
    "kind": "bot"
  },
  "balances": {
    "USD": "10000"
  },
  "engine": {
    "equity": 10000,
    "position": null,
    "pausedUntil": null,
    "lastExitT": null
  },
  "trades": []
}
```

**Example** (HARNESS capture (forced cascade in a test harness, not the live demo): position open): `fixtures/signal-bot-in-position.json`

```json
{
  "asOf": "2026-09-19T15:46:51.511Z",
  "mode": "live",
  "source": "cascade-engine",
  "account": {
    "id": "3b9b2ef5-5485-4f7d-a9c8-a6cda3602e14",
    "name": "cascade-bot",
    "kind": "bot"
  },
  "balances": {
    "ETH": "1.751758327421",
    "USD": "6663.333333333333"
  },
  "engine": {
    "equity": 10000,
    "position": {
      "qty": 1.751758327421149,
      "stop": 1788.679,
      "entry": 1902.8500000000001,
      "entryT": 1789832790000,
      "target": 1951.4250000000002,
      "feeEntry": 3.3333333333333335,
      "notional": 3333.3333333333335,
      "high3hAtEntry": 2000
    },
    "pausedUntil": null,
    "lastExitT": null
  },
  "trades": [
    {
      "txId": "d5a45a8b-38a4-4aa5-8bf2-529ebba83a81",
      "ts": "2026-09-19T15:46:51.467Z",
      "side": "buy",
      "asset": "ETH",
      "qty": "1.751758327421",
      "price": "1902.85",
      "fee": "3.333333333333",
      "ref": "entry:1789832790000"
    }
  ]
}
```

**Example** (HARNESS capture: after a buy and a sell at target): `fixtures/signal-bot-with-trades.json`

```json
{
  "asOf": "2026-09-19T15:46:51.544Z",
  "mode": "live",
  "source": "cascade-engine",
  "account": {
    "id": "3b9b2ef5-5485-4f7d-a9c8-a6cda3602e14",
    "name": "cascade-bot",
    "kind": "bot"
  },
  "balances": {
    "ETH": "0",
    "USD": "10076.632399142514"
  },
  "engine": {
    "equity": 10076.632399142514,
    "position": null,
    "pausedUntil": null,
    "lastExitT": 1789833090000
  },
  "trades": [
    {
      "txId": "d5a45a8b-38a4-4aa5-8bf2-529ebba83a81",
      "ts": "2026-09-19T15:46:51.467Z",
      "side": "buy",
      "asset": "ETH",
      "qty": "1.751758327421",
      "price": "1902.85",
      "fee": "3.333333333333",
      "ref": "entry:1789832790000"
    },
    {
      "txId": "8429c393-55b7-4171-bee3-80d233a226ea",
      "ts": "2026-09-19T15:46:51.534Z",
      "side": "sell",
      "asset": "ETH",
      "qty": "1.751758327421",
      "price": "1950.449288",
      "fee": "3.416715781591",
      "ref": "exit:1789833090000"
    }
  ]
}
```

### `GET /api/v1/demo/status`

Which data mode is active

**Responses:** `200` (plus the error shape above for any failure)

**Example**: `fixtures/demo-status.json`

```json
{
  "mode": "offline",
  "offline": true,
  "drillActive": false
}
```

**Example**: `fixtures/demo-status-during-drill.json`

```json
{
  "mode": "offline",
  "offline": true,
  "drillActive": true
}
```

### `POST /api/v1/demo/drill`

Inject a synthetic 6.5% crash + ~$40M liquidation burst + rebound into an isolated copy of state

Every message is tagged `synthetic: true` and `mode: "drill"`. Real data, accounts and ledgers are never touched. Returns immediately; poll GET /demo/drill.

**JSON body**

| Field | Type | Required |
|---|---|---|
| `speed` | number, ≥ 0.5, ≤ 1000, default `1` | no |

**Responses:** `202` (plus the error shape above for any failure)

**Example** (HTTP 202): `fixtures/drill-start.json`

```json
{
  "status": "started",
  "speed": 1
}
```

**Example** (a drill is already running → 409): `fixtures/error-409-drill-running.json`

```json
{
  "error": {
    "code": "conflict",
    "message": "A drill is already running"
  }
}
```

### `GET /api/v1/demo/drill`

Status and result of the latest drill

**Responses:** `200` (plus the error shape above for any failure)

**Example** (while running): `fixtures/drill-running.json`

```json
{
  "status": "running",
  "id": "133c7296-3476-48f8-8004-eed59cc79fac",
  "startedAt": "2026-09-19T15:33:36.383Z"
}
```

**Example** (when finished): `fixtures/drill-result.json` (arrays shortened)

```json
{
  "status": "done",
  "id": "133c7296-3476-48f8-8004-eed59cc79fac",
  "startedAt": "2026-09-19T15:33:36.383Z",
  "endedAt": "2026-09-19T15:34:15.984Z",
  "crashPct": 0.065,
  "burstUsd": 40000000,
  "transitions": [
    {
      "virtualT": "2026-09-19T15:33:36.384Z",
      "state": "watching"
    },
    {
      "virtualT": "2026-09-19T15:33:36.884Z",
      "state": "partial"
    }
  ],
  "trades": [
    {
      "type": "entry",
      "t": 1789832022134,
      "price": 2805.8208941714856,
      "qty": 1.1880064548160028,
      "notional": 3333.3333333333335,
      "fee": 3.3333333333333335,
      "stop": 2637.471640521196,
      "target": 2862.373656992623
    },
    {
      "type": "exit",
      "t": 1789841936384,
      "price": 2860.942470164127,
      "qty": 1.1880064548160028,
      "reason": "target",
      "pnl": 58.752636624143314,
      "fee": 3.3988181214122224,
      "equityAfter": 10058.752636624144
    }
  ],
  "startEquity": 10000,
  "finalEquity": 10058.752636624144
}
```

### `GET /health`

Liveness

**Responses:** `200`

**Example**: `fixtures/health.json`

```json
{
  "status": "ok"
}
```

### `GET /health/ready`

Readiness: DB, Redis, and no failover chain fully down

**Responses:** `200`, `503`

**Example**: `fixtures/health-ready.json` (arrays shortened)

```json
{
  "status": "ready",
  "checks": {
    "db": "ok",
    "redis": "ok",
    "chain:realtimePrice": "ok",
    "chain:oraclePrice": "unknown",
    "chain:candles": "unknown",
    "chain:markets": "unknown",
    "chain:rpc": "unknown",
    "chain:explorer": "unknown"
  },
  "chains": {
    "realtimePrice": {
      "status": "ok",
      "providers": [
        "simulator",
        "coinbase-ws"
      ]
    },
    "oraclePrice": {
      "status": "unknown",
      "providers": [
        "chainlink-rpc"
      ]
    },
    "candles": {
      "status": "unknown",
      "providers": [
        "coinbase-rest",
        "coinbase-advanced"
      ]
    },
    "markets": {
      "status": "unknown",
      "providers": [
        "coingecko",
        "coinmarketcap"
      ]
    },
    "rpc": {
      "status": "unknown",
      "providers": [
        "rpc"
      ]
    },
    "explorer": {
      "status": "unknown",
      "providers": [
        "etherscan",
        "blockscout"
      ]
    }
  }
}
```

### `GET /health/providers`

Per-provider status table (drives the frontend "data sources" indicator)

**Responses:** `200`

**Example**: `fixtures/health-providers.json` (arrays shortened)

```json
{
  "asOf": "2026-09-19T15:31:33.673Z",
  "providers": [
    {
      "name": "simulator",
      "status": "ok",
      "circuit": "closed",
      "lastSuccess": "2026-09-19T15:31:29.004Z",
      "lastError": null,
      "lastErrorMessage": null,
      "p95LatencyMs": 0,
      "successCount": 20,
      "errorCount": 0,
      "quotaRemaining": null,
      "reportedAt": "2026-09-19T15:31:29.128Z"
    }
  ],
  "chains": {
    "realtimePrice": {
      "status": "ok",
      "providers": [
        "simulator",
        "coinbase-ws"
      ]
    },
    "oraclePrice": {
      "status": "unknown",
      "providers": [
        "chainlink-rpc"
      ]
    },
    "candles": {
      "status": "unknown",
      "providers": [
        "coinbase-rest",
        "coinbase-advanced"
      ]
    },
    "markets": {
      "status": "unknown",
      "providers": [
        "coingecko",
        "coinmarketcap"
      ]
    },
    "rpc": {
      "status": "unknown",
      "providers": [
        "rpc"
      ]
    },
    "explorer": {
      "status": "unknown",
      "providers": [
        "etherscan",
        "blockscout"
      ]
    }
  },
  "suspectTicks": {
    "total": 0,
    "recent": []
  },
  "indexer": null
}
```

## Field notes (things the schema alone doesn't say)

- **Candles** (`GET …/candles`): `t` is the bucket **open time** as an ISO string, ascending. `limit` returns the **newest** N candles in range, still ascending. The most recent candle is still forming.
  `range` picks the interval for you (1D→5m, 1W→1h, 1M/3M→4h, 1Y/5Y/All→1d); an explicit `interval` wins.
  On the **WebSocket** the same candle's `t` is **epoch milliseconds (a number)**, not an ISO string. See `ws.md`.
- **Quote:** `changePct24h` is already a percentage (`"1.2464"` means +1.2464%). Fields the backend can't compute are `null` (e.g. `rank`/`marketCap` in offline mode). `sources` lists where the price came from (`simulator` in the offline demo; `coinbase-ws` etc. live).
- **Liquidations:** amounts `debtAmountRaw`/`collateralAmountRaw` are raw integer strings in token base units (not USD). `usdValue` is the USD value at block time (can be `null` if unpriceable). `txUrl` is a ready Etherscan link. **In the offline demo the rows are simulated:** `txHash` starts with `0x5150`, addresses are fake, `collateralAmountRaw` is `"0"`, and the Etherscan links do not resolve.
  `status` is `pending` (fewer than 12 confirmations) or `confirmed`.
- **Oracle:** `gap = fast/chainlink − 1` (e.g. `"-0.002701"` = fast price is 0.27% below Chainlink). `pressure` is true when the gap is below −0.5%. `gap`/`fastPrice` are `null` when there is no fresh fast price. `ageSec` is the age of the Chainlink round.
- **Signal state** (`state` object): `state` is one of `warming | watching | partial | fired | in_position | paused`. `met` says which of the three entry conditions currently hold. `reason` is a human-readable sentence you can show verbatim. `drop` is a fraction (−0.04 = −4%). `position` is `null` unless `state` is `in_position`/`fired`.
- **Bot** (`/signals/bot`): the strategy bot's own paper account. `trades[].side` is `buy`/`sell`; `engine.equity` is in USD; `engine.position` is the open position or `null`. Timestamps inside `engine`/`position` are epoch **milliseconds** (numbers).
- **health/providers:** `providers[].status` is `ok | degraded | down | unknown`; `chains` groups providers into failover chains. Good for a small "data sources" indicator. In the offline demo the only real provider is `simulator`.
- **/health/ready** returns 503 (same shape, `status: "not_ready"`) when a critical dependency is down.
