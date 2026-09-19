# web-contract

Everything a frontend needs to build against this backend **without seeing it**.

| File | What |
|---|---|
| `api.md` | Every REST endpoint: params, response codes, a real example each, field notes and gotchas |
| `ws.md` | The WebSocket protocol: messages, envelope, `seq`, `mode`, `synthetic`, every channel, drill behaviour |
| `openapi.json` | OpenAPI 3 export from the running app (generate typed clients from it; the WebSocket is not in OpenAPI, see `ws.md`) |
| `fixtures/` | Real captured REST responses (mock data) |
| `ws-samples/` | ~2 min of recorded WebSocket frames per channel + one full recorded drill |

## Quick facts

- REST base `http://localhost:8080`, WebSocket `ws://localhost:8080/ws`, CORS origin `http://localhost:5173`.
- Instruments: `ETH-USD`, `BTC-USD`. Decimals are strings. Times are ISO-8601 UTC.
- **Start a drill:** `POST /api/v1/demo/drill` with body `{"speed":1}` → 202. Watch `signal` on the WebSocket.
- Show a banner whenever `mode !== "live"` and treat `synthetic: true` as fake data.
- The demo the fixtures came from is **offline/simulated**: prices, liquidations and Chainlink are generated, not real market data
  (`mode: "offline"`). Live mode returns the same shapes with real data.
- Not built yet, so don't design for them: auth/login, orders, portfolio, watchlists, alerts, order book, trades tape, movers, technicals, news.

## Regenerate

With `npm run demo:offline` running on port 8080:

```bash
npx tsx scripts/capture-web-contract.ts http://localhost:8080 120
npx tsx scripts/build-web-contract-docs.ts
```
