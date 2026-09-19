# ws-samples

Each `*.ndjson` line is `{"t": <ms since recording start>, "msg": <exact WebSocket frame>}`.

**Recording:** ~120 s of the live `npm run demo:offline` process, one WebSocket subscribed to all 13 channels.

| File | frames |
|---|---|
| `ticker_ETH-USD.ndjson` | 119 |
| `ticker_BTC-USD.ndjson` | 119 |
| `candles_ETH-USD_1m.ndjson` | 120 |
| `candles_ETH-USD_5m.ndjson` | 120 |
| `candles_ETH-USD_15m.ndjson` | 120 |
| `candles_ETH-USD_1h.ndjson` | 120 |
| `candles_ETH-USD_4h.ndjson` | 120 |
| `candles_ETH-USD_1d.ndjson` | 120 |
| `candles_BTC-USD_1m.ndjson` | 120 |
| `liquidations.ndjson` | 1 |
| `oracle_ETH-USD.ndjson` | 24 |
| `oracle_BTC-USD.ndjson` | 24 |
| `signal.ndjson` | 24 |
| `errors.ndjson` | 4 (one per error code the gateway can return) |

`liquidations.ndjson` is nearly empty by design: real liquidations arrive about 3/hour in the offline simulator. The **drill** recording has the busy version.

**`drill/`**: one complete drill at `speed: 1`, recorded from before the POST until 2.5 s after it finished. `all-channels.ndjson` is every frame in order;
the per-channel files are the same frames split by channel. Subscribed to: signal, ticker:ETH-USD, candles:ETH-USD:1m, liquidations, oracle:ETH-USD.
Note `oracle:ETH-USD` is **suppressed** during the drill (live frames stop, no synthetic replacement), so it goes quiet then resumes with a live snapshot.

To mock the backend, replay a file's lines with `setTimeout(send, line.t - previous.t)`.
