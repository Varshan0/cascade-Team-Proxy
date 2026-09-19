# WebSocket protocol

Endpoint: `ws://localhost:8080/ws` (same host/port as the REST API). Plain JSON text frames, no auth, no subprotocol.
Every example below is a **real recorded message** from `ws-samples/` (one line of those files is `{"t":<ms since recording start>,"msg":<the frame>}`;
`t` lets you replay them with their original timing).

## Client → server

```json
{"op":"subscribe","channels":["ticker:ETH-USD","signal"]}
{"op":"unsubscribe","channels":["ticker:ETH-USD"]}
```

- `op` is `subscribe` or `unsubscribe`; `channels` is 1–50 channel names (see the list below). Anything else gets an `error` frame.
- Subscribing to a channel you already have is a no-op. Unsubscribing from one you don't have is ignored.
- You can send subscribe messages at any time and as often as you like; send them again after every reconnect (subscriptions do not survive a disconnect).
- There are no other client messages. Do not send pings; the server pings you (browsers answer automatically).

## Server → client: the envelope

Every data frame has the same envelope:

```ts
{
  channel: string;             // e.g. "ticker:ETH-USD"
  type: "snapshot" | "update";
  seq: number;                 // monotonic per channel; see below
  ts: string;                  // ISO time the server published this frame
  mode: "live" | "offline" | "drill" | "replay";
  synthetic?: true;            // present ONLY on drill traffic; absent otherwise
  data: <channel specific> | null;
}
```

- **Snapshot first.** Right after you subscribe to a channel you receive exactly one `snapshot` with the channel's current state, then `update` frames.
  If the channel has produced nothing yet you get `{"type":"snapshot","seq":0,"data":null}`: render an empty state, not an error.
- **`seq`** increases by 1 per published message on that channel (`0` = "nothing yet"). A snapshot carries the seq of the latest update it reflects, so drop any update with `seq ≤` your snapshot's.
  **State channels** (`ticker:*`) are coalesced by the server to at most **4 frames/second per client**, so `seq` gaps there are **normal**: just keep the newest.
  **Event channels** (`signal`, `liquidations`, `candles:*` closed candles) are not coalesced; a gap in `seq` there means you lost a frame, so unsubscribe and resubscribe to get a fresh snapshot.
- **`mode`** is on every frame. Show a global banner whenever it isn't `live`: `offline` = simulated market, `drill` = synthetic crash in progress.
- **`synthetic`**: exists (as `true`) **only** on frames produced by a drill. If you see it, the data is fake by design. Never mix synthetic frames into real history/charts you persist.
- **Errors** are frames without `channel`/`seq`:
  ```json
  [{"type":"error","error":{"code":"unknown_channel","message":"unknown channel nope"}},{"type":"error","error":{"code":"not_available","message":"orderbook:ETH-USD is not available yet"}},{"type":"error","error":{"code":"unauthorized","message":"me:orders requires authentication (arrives with M5)"}},{"type":"error","error":{"code":"bad_message","message":"expected {\"op\":\"subscribe\"|\"unsubscribe\",\"channels\":[...]}"}}]
  ```
  Codes: `bad_message` (not valid JSON or wrong shape), `unknown_channel`, `not_available` (`orderbook:*`, `trades:*`, `movers`, `chain`: planned, not built), `unauthorized` (`me:orders`, `me:portfolio`, `me:alerts`: not built). The connection stays open after an error.
- **Heartbeat:** the server sends a WebSocket ping every 20 s and closes connections that don't pong. Browsers pong automatically; you need no code for it.
- **Backpressure:** if a client falls far behind, the server drops intermediate `ticker`/`candles`/`oracle` frames (never `signal` or `liquidations`).

## Channels

Only `ETH-USD` and `BTC-USD` exist in the demo. Any other symbol is accepted syntactically but will only ever deliver `data: null`.

| Channel | Kind | What it carries |
|---|---|---|
| `ticker:{symbol}` | state, ≤4/s | latest price |
| `candles:{symbol}:{interval}` | event | the forming or just-closed candle. `interval` ∈ `1m 5m 15m 1h 4h 1d` |
| `liquidations` | event | new Aave liquidations (and reorg removals) |
| `oracle:{symbol}` | state | Chainlink vs fast price. Only `ETH-USD` and `BTC-USD` |
| `signal` | event | Cascade Catcher state, meters, reason |

### `ticker:{symbol}`

`data`: `{symbol, price (decimal string), bid, ask (string|null), ts (ISO), source, suspect (bool)}`. `suspect: true` means two price sources disagreed by >1.5%: show it dimmed/flagged.

Snapshot (real):
```json
{"channel":"ticker:ETH-USD","type":"snapshot","seq":15,"ts":"2026-09-19T15:31:34.066Z","mode":"offline","data":{"symbol":"ETH-USD","price":"2918.12","bid":null,"ask":null,"ts":"2026-09-19T15:31:34.066Z","source":"simulator","suspect":false}}
```
Update (real):
```json
{"channel":"ticker:ETH-USD","type":"update","seq":16,"ts":"2026-09-19T15:31:35.069Z","mode":"offline","data":{"symbol":"ETH-USD","price":"2918.09","bid":null,"ask":null,"ts":"2026-09-19T15:31:35.069Z","source":"simulator","suspect":false}}
```

### `candles:{symbol}:{interval}`

`data`: `{symbol, interval, closed (bool), candle:{t, o, h, l, c, v, source}}`.
- **`candle.t` here is epoch MILLISECONDS as a number** (REST returns an ISO string for the same field). `o h l c v` are decimal strings.
- Published about once per second while a candle is forming (`closed:false`); the last frame for a bucket has `closed:true`. Replace the candle with the same `t`, or append if `t` is new.
- The snapshot is the latest candle only. Load history from REST `/candles` first, then apply these.

Snapshot (real):
```json
{"channel":"candles:ETH-USD:1m","type":"snapshot","seq":14,"ts":"2026-09-19T15:31:33.225Z","mode":"offline","data":{"symbol":"ETH-USD","interval":"1m","candle":{"t":1789831860000,"o":"2916.31","h":"2917.76","l":"2916.31","c":"2917.76","v":"3.834","source":"simulator","trades":14},"closed":false}}
```
Update (real):
```json
{"channel":"candles:ETH-USD:1m","type":"update","seq":15,"ts":"2026-09-19T15:31:34.242Z","mode":"offline","data":{"symbol":"ETH-USD","interval":"1m","candle":{"t":1789831860000,"o":"2916.31","h":"2918.12","l":"2916.31","c":"2918.12","v":"4.2107","source":"simulator","trades":15},"closed":false}}
```

### `liquidations`

- **Snapshot** `data`: array of the 20 most recent liquidations, newest first (same objects as REST `/liquidations` items).
- **Update** `data` is one of:
  - `{"type":"liquidation","event":{…same object as a REST liquidation item…}}`: a new event.
  - `{"type":"removed","txHash":"0x…","logIndex":0}`: a chain reorg removed it; delete it from your list. (Shape taken from the backend code; a reorg has not occurred in any recording.)
  - During a **drill**: `{"type":"liquidation","event":{…}}` with a smaller `event` (below) and `status:"synthetic"`, `txUrl:null`, negative `id`.
- Real liquidations are rare: in a 2-minute offline recording there were **0 live update(s)** (about 3 background events/hour). Use the drill to see traffic.

Snapshot (real, first 2 of 20 items):
```json
{
  "channel": "liquidations",
  "type": "snapshot",
  "seq": 0,
  "ts": "2026-09-19T15:31:34.143Z",
  "mode": "offline",
  "data": [
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
  ]
}
```
Update during a drill (real, synthetic):
```json
{"channel":"liquidations","type":"update","seq":1,"ts":"2026-09-19T15:33:36.917Z","mode":"drill","synthetic":true,"data":{"type":"liquidation","event":{"id":-3,"txHash":"0xdrill3","ts":"2026-09-19T15:33:36.884Z","collateralSymbol":"WETH","debtSymbol":"USDC","usdValue":"756214.44","status":"synthetic","txUrl":null}}}
```

### `oracle:{symbol}`

`data`: `{symbol, chainlinkPrice, fastPrice|null, gap|null, pressure (bool), roundId, updatedAt (ISO), ageSec, heartbeatSec, deviation}`. Same fields as REST `/oracle/{symbol}` → `oracle`. Published about every 5–12 s.

Snapshot (real):
```json
{"channel":"oracle:ETH-USD","type":"snapshot","seq":4,"ts":"2026-09-19T15:31:33.963Z","mode":"offline","data":{"symbol":"ETH-USD","chainlinkPrice":"2916.76833254","fastPrice":"2917.76","gap":"0.00034","pressure":false,"roundId":"18446744073709553062","updatedAt":"2026-09-19T14:35:30.000Z","ageSec":3363,"heartbeatSec":3600,"deviation":0.005}}
```
Update (real):
```json
{"channel":"oracle:ETH-USD","type":"update","seq":5,"ts":"2026-09-19T15:31:38.974Z","mode":"offline","data":{"symbol":"ETH-USD","chainlinkPrice":"2916.76833254","fastPrice":"2919.04","gap":"0.000779","pressure":false,"roundId":"18446744073709553062","updatedAt":"2026-09-19T14:35:30.000Z","ageSec":3368,"heartbeatSec":3600,"deviation":0.005}}
```

### `signal`

`data` (numbers, not strings): `{symbol, state, drop, z, liq1h, mean, thresholds:{dropThresh,zThresh,minLiqUsd}, met:{drop,z,liq}, reason, price, priceSource:"fast"|"chainlink", equity, position|null, pausedUntil|null, ts}`.
`state` ∈ `warming | watching | partial | fired | in_position | paused`. Published about every 5 s (and immediately on drill frames).

Snapshot (real):
```json
{"channel":"signal","type":"snapshot","seq":4,"ts":"2026-09-19T15:31:34.065Z","mode":"offline","data":{"state":"watching","drop":-0.0034734436957166714,"z":-0.08535146254610076,"liq1h":326501.260276,"mean":566008.5626935953,"thresholds":{"dropThresh":0.04,"zThresh":3,"minLiqUsd":1000000},"met":{"drop":false,"z":false,"liq":false},"reason":"drop -0.35% (need <= -4.00%) ✗ · z -0.09 (need >= 3) ✗ · liq 1h $326,501 (need >= $1.00M) ✗","symbol":"ETH-USD","price":2917.76,"priceSource":"fast","equity":10000,"position":null,"pausedUntil":null,"ts":"2026-09-19T15:31:34.035Z"}}
```

## Drills on the WebSocket

Start one with `POST /api/v1/demo/drill` (see `api.md`). Subscribe to `signal`, `ticker:ETH-USD`, `candles:ETH-USD:1m`, `liquidations` beforehand. The recorded sequence is in `ws-samples/drill/`
(`all-channels.ndjson` is every frame in arrival order).

What the backend does to your subscriptions:

1. **The instant the drill starts, live frames stop** on `ticker:ETH-USD`, `candles:ETH-USD:*`, `oracle:ETH-USD`, `liquidations` and `signal`, and are replaced by frames with `"synthetic":true,"mode":"drill"`. You don't need to resubscribe. (`ticker:BTC-USD` and other channels are unaffected.)
2. **Synthetic frames use the same shapes and channel names as live ones.** `seq` for synthetic frames counts on a separate counter starting again at 1.
3. **The `signal` frames inside a drill have one extra field**, `data.drill: {id, seq}`, and the **last** `signal` frame is different: it has **no meters**, only
   ```json
{"channel":"signal","type":"update","seq":153,"ts":"2026-09-19T15:34:15.984Z","mode":"drill","synthetic":true,"data":{"drill":{"id":"133c7296-3476-48f8-8004-eed59cc79fac","done":true,"summary":"…see fixtures/drill-result.json…"},"symbol":"ETH-USD"}}
```
   Treat `data.drill.done === true` as "the drill is over" and don't try to read `state` from that frame.
4. **Timestamps inside drill frames are virtual time.** The crash lasts 20 real seconds, but the rebound phase fast-forwards the clock (each frame is +5 minutes), so
   `data.ts` and `candle.t` in drill frames run **hours into the future** by the end. The envelope's `ts` is the true wall-clock time. Chart drill data by frame order, or by `data.ts`, but do not compare it to real history.
5. **When the drill ends**, the server sends a fresh **live `snapshot`** (no `synthetic`, real `mode`) on every channel you're subscribed to (5 in the recording), and live updates resume.
   That snapshot is your cue to switch the banner off.

Recorded drill (speed 1): 555 frames in total, 153 `signal`, 152 `ticker` frames, spanning ~40 s.
`signal.state` sequence: **watching → partial → fired → in_position → watching**.
The final result (states, trades, equity) is `fixtures/drill-result.json`.

## Reconnecting

Reconnect with exponential backoff (e.g. 0.5 s → 30 s, jittered), then send your subscribe message again. You get fresh snapshots, so no replay logic is needed.
If the socket drops during a drill, the drill keeps running on the server; after reconnecting you will be receiving synthetic frames mid-stream (the snapshot you get is the drill's current state, marked `synthetic`).
