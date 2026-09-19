# Cascade Catcher: strategy notes

**Paper trading only.** No real orders, custody or keys exist anywhere in this codebase. The strategy trades its own
simulated account.

The implementation is one pure function, `step()` in `src/shared/strategy/cascade.ts`. The live engine
(`strategy/engine.ts`) and the drill (`strategy/drill.ts`) both call it, so what you see in a demo is the same logic
that runs on live data. Everything below describes that code.

## The idea

Aave V3 liquidates borrowers when their collateral value, measured by the **Chainlink oracle**, falls too far. A wave of
liquidations forces the liquidator to sell collateral into the market. If that selling is larger than the market can
absorb, price briefly **overshoots** below where it would otherwise settle. The strategy buys that overshoot and sells
when price has recovered part of the way back to where it was.

It does **not** predict crashes. It reacts after a cascade has already happened, and only when three independent
conditions agree.

## Rules

**Inputs at time *t*:** a signal price, the price history, and Aave liquidation events valued in USD.

**Features**

| Feature | Definition |
|---|---|
| `drop` | `price_t / max(price over [t−3h, t]) − 1` |
| `liq_1h` | sum of liquidation USD in `(t−1h, t]` |
| baseline | 168 hourly liquidation sums for the hours before that window |
| `z` | `(liq_1h − mean) / max(sd, $10,000)` |

**Entry:** all three at once, plus three guards.

- `drop ≤ −4%`
- `z ≥ 3`
- `liq_1h ≥ $1,000,000`
- no open position
- not paused by the circuit breaker
- more than 30 minutes since the last exit

**Sizing:** `notional = equity × min(1, 2% / 6%)`, i.e. one third of equity. The stop is 6% away, so a stop-out loses about
2% of equity before costs.

**Exits:** whichever comes first.

- **Stop:** price ≤ `entry × (1 − 6%)`
- **Target:** price ≥ `entry + 0.5 × (high3h − entry)`, i.e. half the way back to the 3-hour high
- **Time stop:** 48 hours

**Costs:** fee 0.10% per side. Slippage 0.05% normally and **0.15% on cascade entries** (the book is thin exactly when
this fires).

**Circuit breaker:** two stop-outs within 7 days pause the strategy for 7 days. Only stop-outs count, not target or
time exits. When the pause ends, the stop-outs that caused it are forgiven.

**States published on `signal`:** `warming | watching | partial | fired | in_position | paused`, with the meters
(`drop`, `z`, `liq1h`, `mean`), the thresholds, which conditions are met, and a plain-English `reason`. Every transition
is stored in `signal_events` (live engine only; drills never write there).

All thresholds are parameters (`DEFAULT_PARAMS`). Per-user settings arrive with M5; today only the defaults are used.

## Assumptions and interpretations

Where the rules above leave room, this is what the code does. Each is a choice, not a fact about the market.

1. **Standard deviation is the population sd** over the 168 baseline hours, floored at $10,000 so a quiet baseline
   cannot make `z` explode.
2. **Price history uses 1-minute closes.** A candle's close counts only once its minute has ended, and the current
   signal price is added on top. Using highs would make `drop` look larger than what was tradable.
3. **The high is measured inclusively** over `[t−3h, t]`, and the current price counts, so `drop` is never positive.
4. **Signal price:** the fast (Coinbase) price if it is fresh within 5 minutes, otherwise Chainlink. Prices flagged
   `suspect` (two live sources disagreeing by more than 1.5%) are never used.
5. **Liquidations still awaiting 12 confirmations are counted**, for speed. A reorg can remove one; the indexer then deletes
   it and the next evaluation no longer sees it.
6. **Exit fills.** A stop fills at the market price when it triggers, so a gap through the stop is taken in full. A
   target fills at the target level with no price improvement. Both then pay 0.05% slippage and 0.10% fee.
7. **After an exit** the state is `watching` (with a cooldown reason) for 30 minutes, then normal evaluation resumes.
8. **Equity accounting.** The position is sized off equity while flat. Realised PnL is added on exit. The bot's
   double-entry ledger matches this to the cent (asserted in `test/engine.test.ts`).
9. **Liquidation USD values** are computed at the block time: Chainlink round first, then the nearest 1-minute candle,
   then the nearest 1-hour candle. Stablecoins are $1. **Liquid-staking tokens (wstETH, weETH, rETH…) are priced at the
   ETH price, which understates them** (wstETH trades roughly 15% above ETH). Assets with no price are stored with a null
   value and excluded from `liq_1h`.
10. **Chainlink deviation threshold and heartbeat (0.5% / 1 h)** are assumed, not verified against data.chain.link. They
    are used only for display and by the simulator, never by the entry rule.

## Warm-up

The baseline needs 169 hours of liquidation history. Until the indexer (or the simulator) has covered that much, the
state is `warming` and **no trade can fire**, even during a real cascade. This is deliberate: with a thin baseline the
mean and sd are near zero, so ordinary activity would score a huge `z`.

In live mode coverage comes from how far back the Aave indexer has read. A free public RPC serves only recent blocks, so
without a keyed (archive-capable) RPC the strategy may stay in `warming`; see the README.

## When it fails

Where a number is given it is the design brief's threshold, **not something this repository has measured**. The
backtest service (which would measure them) is not built yet.

| Failure condition | Why it hurts | Where it shows up |
|---|---|---|
| **Real-news crashes** | The price falls because fair value fell, not because of forced selling, and it keeps sliding. There is no overshoot to recover, so the trade runs to its stop. | Stop-outs; the circuit breaker exists for clusters of these. |
| **Costs above roughly 0.7% per side** | The target is typically only a couple of percent away. Fees plus slippage that large consume the edge. | Real spreads on a thin book during a cascade can exceed the 0.15% entry slippage assumed here. |
| **Slow rebounds (over roughly 40 h)** | The overshoot fades with a half-life of hours, not days. If recovery is slower, the 48-hour time stop exits at a poor price. | Time-stop exits. |
| **Shrinking overshoot as others compete** | If more capital buys these dips, the mispricing gets smaller and shorter. The edge decays with popularity. | Not visible in a single-strategy test. |
| **Gap risk through stops** | Price can jump past the stop, so the loss exceeds 6%. This code takes the gap in full rather than pretending to fill at the stop price. | `exit` events whose fill is below the stop. |
| **Exchange outages** | A venue going down mid-cascade can freeze prices or widen spreads. **This is not modelled.** | Not covered. |
| **Oracle staleness or manipulation** | Chainlink only updates on a deviation or heartbeat, so during a fast move the price Aave uses lags the market. That lag is what triggers liquidations, but it also makes valuations at block time approximate. | The `oracle` channel (`gap`, `pressure`). |
| **Thin baseline** | Fewer than 169 h of history gives misleading `z`. | `warming`. |
| **Data-source disagreement** | If the only live sources disagree, prices are flagged `suspect` and withheld from the strategy. With one source down the signal can go quiet rather than wrong. | `/health/providers` → `suspectTicks`. |

## What guards against look-ahead and overfitting

What exists today:

- **No look-ahead by construction and by test.** `computeFeatures` reads only points with timestamp ≤ *t*
  (liquidations in `(t−1h, t]`, prices in `[t−3h, t]`). `test/cascade.test.ts` proves the signal at *t* is identical
  whether or not arbitrary future data is present, and that `step` never mutates its input.
- **Closed candles only** for price history (assumption 2).
- **Fixed, published parameters.** The defaults come from the design brief. Nothing in this repo tunes them on data.
- **One code path.** Live, drill and any future backtest use the same function, so a backtest cannot quietly use
  different logic from production.

What is **not** built (planned for M6): the backtest service, the random-entry baseline (to show the signal beats
chance), the first-half versus second-half split (to show it is not fitted to one period), and metrics such as drawdown,
Sharpe and profit factor. Until then there is **no evidence in this repository that the strategy is profitable**; the
drill demonstrates the mechanics on a scripted crash, not the edge.

## What the demo shows

- **Live mode:** real prices, real Aave liquidations and real Chainlink. The strategy only fires if a genuine cascade
  happens.
- **Offline mode:** a seeded simulator whose crashes are built to match the strategy's premise (forced selling reverts
  with a 12-hour half-life; news drops do not). Results there show the plumbing works, not that the premise is true.
- **Drill:** a scripted 6.5% crash with about $40M of liquidations over 20 seconds, then a rebound, on an isolated copy
  of state. The outcome (entry, then exit at target) is a property of the script.
