# fixtures

Real JSON responses, unedited, captured from the running `npm run demo:offline` process (offline simulator, so `mode` is `"offline"`).
Use them as mock API data: they are exactly what the backend returns.

Exceptions, both **clearly labelled**:
- `signal-bot-in-position.json`, `signal-bot-with-trades.json`: the offline demo's bot hadn't traded yet, so these two come from the real
  `/api/v1/signals/bot` endpoint running in a **test harness** with a forced cascade (real code path and response shape, scripted data).
  `signal-bot.json` is the real live-demo response (empty `trades`).
- Candles are `limit=30` (`candles-range-1D` is `limit=12`) to keep files small; the API allows up to 2000.

| File | Endpoint |
|---|---|
| `instruments` | GET /api/v1/instruments |
| `quote-ETH-USD`, `quote-BTC-USD` | GET /api/v1/instruments/{symbol}/quote |
| `candles-5m`, `candles-1h`, `candles-1d`, `candles-range-1D` | GET /api/v1/instruments/ETH-USD/candles |
| `liquidations`, `liquidations-page2` | GET /api/v1/liquidations (limit=10, then the cursor page) |
| `liquidations-stats-1h`, `-24h`, `-7d` | GET /api/v1/liquidations/stats |
| `oracle-ETH-USD`, `oracle-BTC-USD` | GET /api/v1/oracle/{symbol} |
| `signal-state`, `signal-state-during-drill`, `signal-state-after-drill` | GET /api/v1/signals/state |
| `signal-history` | GET /api/v1/signals/history |
| `signal-bot`, `signal-bot-in-position`, `signal-bot-with-trades` | GET /api/v1/signals/bot |
| `health`, `health-ready`, `health-providers` | GET /health, /health/ready, /health/providers |
| `demo-status`, `demo-status-during-drill` | GET /api/v1/demo/status |
| `drill-start`, `drill-running`, `drill-result`, `error-409-drill-running` | POST/GET /api/v1/demo/drill |
| `error-404-*`, `error-400-validation` | the error shape |
