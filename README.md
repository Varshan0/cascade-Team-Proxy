
=======
<div align="center">

# 🌊 Cascade Catcher

### A systematic strategy that trades DeFi liquidation cascades — not price direction.

[![Status](https://img.shields.io/badge/status-hackathon%20demo-brightgreen?style=for-the-badge)]()
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white)]()
[![Ethereum](https://img.shields.io/badge/chain-Ethereum-3C3C3D?style=for-the-badge&logo=ethereum&logoColor=white)]()
[![Aave](https://img.shields.io/badge/protocol-Aave-B6509E?style=for-the-badge&logo=aave&logoColor=white)]()
[![Chainlink](https://img.shields.io/badge/oracle-Chainlink-375BD2?style=for-the-badge&logo=chainlink&logoColor=white)]()

[![Sharpe](https://img.shields.io/badge/Sharpe_Ratio-1.45-success?style=flat-square)]()
[![Return](https://img.shields.io/badge/Backtest_Return-%2B16%25-success?style=flat-square)]()
[![Drawdown](https://img.shields.io/badge/Max_Drawdown-−7%25-orange?style=flat-square)]()
[![Win](https://img.shields.io/badge/Profitable_Runs-98%25-success?style=flat-square)]()

<p>
  <a href="#-overview">Overview</a> •
  <a href="#️-strategy-logic">Strategy</a> •
  <a href="#-how-it-works">How It Works</a> •
  <a href="#-mathematical-model">Math</a> •
  <a href="#-backtested-performance">Results</a> •
  <a href="#️-risk--failure-conditions">Risk</a> •
  <a href="#-setup">Setup</a>
</p>

![Cascade Catcher landing hero](docs/screenshots/hero.jpeg)

</div>

---

## 🔎 Overview

> [!NOTE]
> Cascade Catcher does **not** attempt to predict market direction. It exploits a specific, observable market inefficiency: **forced selling**.

When traders borrow against collateral on lending protocols such as **Aave** and the price falls too far, the protocol automatically liquidates their position — selling collateral at *any* available price. When enough of these forced sales occur together, they trigger a **liquidation cascade**: a chain reaction that pushes price below fair value for a short window before it recovers.

Because every liquidation on Ethereum is recorded publicly on-chain, this forced selling can be **measured directly and traded on** — instead of forecasting where price will go next. The strategy sits in cash the majority of the time and acts only when its entry conditions align.

<div align="center">

| 🟢 In cash ~95% of the time | 🎯 Trades only confirmed forced-selling events | 📉 Every failure mode documented |
|:---:|:---:|:---:|

![Live proof — liquidations tracked, forced volume observed, ETH oracle gap, data sources online](docs/screenshots/live-stats.jpeg)

</div>

---

## ⚙️ Strategy Logic

<table>
<tr>
<td width="50%" valign="top">

### 🟩 Entry — all 3 required

| Condition | Threshold |
|---|---|
| 📉 Price drop | ≥ **4%** in 3 hours |
| 🔺 Liquidation spike | ≥ **3σ** above 7-day avg |
| 💰 Minimum size | ≥ **$1,000,000** in 1 hour |

</td>
<td width="50%" valign="top">

### 🟥 Exit — first trigger wins

| Trigger | Rule |
|---|---|
| 🎯 Target | +50% of crash recovered |
| 🛑 Stop-loss | −6% further drop |
| ⏱️ Time stop | 48h with no rebound |
| 🚫 Circuit breaker | 2 stops in 7 days → pause 1 week |

</td>
</tr>
</table>

<details>
<summary>🧠 <b>Why these thresholds? (click to expand)</b></summary>

<br>

The three-condition filter exists because **buying every dip loses money**. Backtesting showed:

- Buying dips with no liquidation filter → Sharpe **−0.38** ❌
- Buying dips *with* the liquidation filter → Sharpe **+1.33** ✅

The liquidation spike and minimum-size filters are what separate genuine forced-selling cascades from ordinary volatility.

</details>

<div align="center">

![Three conditions, one decision — live meters for price dislocation, liquidation spike, and forced volume](docs/screenshots/signal-conditions.jpeg)

</div>

---

## 🔄 How It Works

```mermaid
flowchart LR
    subgraph Listen["👂 LISTEN"]
        A[RPC · Alchemy]
        B[Chainlink Oracle]
        C[Aave Liquidations]
        D[Coinbase / CoinGecko]
    end

    subgraph Measure["📏 MEASURE"]
        E[3h Price Drop]
        F[Liquidation Z-Score]
        G["$ Size Filter"]
    end

    subgraph Decide["⚡ DECIDE & ACT"]
        H{All 3 Conditions Met?}
        I[Paper Buy]
        J[Manage Target / Stop / Time Exit]
    end

    subgraph Validate["✅ VALIDATE"]
        K[Backtest Engine]
        L[Live Monitor + Cascade Drill]
    end

    A --> E
    B --> F
    C --> F
    D --> E
    E --> H
    F --> H
    G --> H
    H -->|Yes| I
    I --> J
    H -->|No| M[Stay in Cash 💵]
    J --> K
    K --> L

    style Listen fill:#1a1a2e,stroke:#16c79a,color:#fff
    style Measure fill:#1a1a2e,stroke:#f9c74f,color:#fff
    style Decide fill:#1a1a2e,stroke:#f94144,color:#fff
    style Validate fill:#1a1a2e,stroke:#43aa8b,color:#fff
```

> [!TIP]
> **Oracle-gap signal:** Chainlink updates its price only after a meaningful move. When the live market price falls well below Chainlink's last reported price, liquidations are likely to fire at the next update — an early warning *before* the cascade starts.

<div align="center">

![Every cascade leaves a trace — leverage stacks up, the first position breaks, selling becomes automatic, the pressure releases](docs/screenshots/mechanic.jpeg)

</div>

---

## 🧮 Mathematical Model

<details>
<summary>📐 <b>Price drop signal</b> (click to expand)</summary>

<br>

$$
\Delta P = \frac{P_{t-3h}^{max} - P_t}{P_{t-3h}^{max}} \times 100\%
$$

Entry requires $\Delta P \geq 4\%$

</details>

<details>
<summary>📊 <b>Liquidation z-score</b></summary>

<br>

Given hourly liquidation volume $L_t$, mean $\mu_L$, and standard deviation $\sigma_L$ over the trailing 7 days:

$$
z_L = \frac{L_t - \mu_L}{\sigma_L}
$$

Entry requires $z_L \geq 3$

</details>

<details>
<summary>⚖️ <b>Position sizing</b> (fixed fractional risk)</summary>

<br>

With account equity $E$, entry price $P_{entry}$, stop price $P_{stop}$, and risk fraction $r = 2\%$:

$$
Q = \frac{r \cdot E}{P_{entry} - P_{stop}}
$$

</details>

<details>
<summary>📈 <b>Sharpe ratio & drawdown</b></summary>

<br>

**Sharpe ratio** (annualized), given strategy returns $r_i$ over $N$ periods and risk-free rate $r_f$:

$$
\text{Sharpe} = \frac{\overline{r} - r_f}{\sigma_r} \times \sqrt{N}
$$

**Maximum drawdown**, given equity curve $E_t$:

$$
\text{MDD} = \min_{t} \left( \frac{E_t - \max_{\tau \leq t} E_\tau}{\max_{\tau \leq t} E_\tau} \right)
$$

</details>

---

## 📊 Backtested Performance

<div align="center">

| Metric | Result | |
|---|---|:---:|
| Return (default run) | **+16%** while market fell 66% | 🟢 |
| Sharpe ratio | **1.45** | 🟢 |
| Max drawdown | **−7%** | 🟡 |
| Profitable across simulated markets | **98%** of 40 runs | 🟢 |

</div>

---

## ⚠️ Risk & Failure Conditions

> [!WARNING]
> Honest risk disclosure is treated as a core requirement of this project — not an afterthought. All trading is **simulated**. No real funds are used at any point.

<details open>
<summary><b>📉 Documented breaking points</b></summary>

<br>

| Condition | Breaking Point | Severity |
|---|---|:---:|
| Crash driven by real news, not forced selling | Above ~77% of cases | 🔴 |
| Trading costs | Above ~0.74% per trade | 🟠 |
| Slow recovery | Longer than ~41 hours | 🟠 |
| Competing capital compresses the edge | Overshoot shrinks toward zero | 🟡 |
| Price gaps past the stop-loss | Loss can exceed 6% | 🔴 |
| Exchange/RPC outage during a crash | Not modelled | 🔴 |

</details>

<div align="center">

![We mapped where it fails — condition, breaking point, and what happens](docs/screenshots/failure-map.jpeg)

</div>

---

## 🏗️ Architecture

<div align="center">

| Layer | Tech |
|---|---|
| 🖥️ Backend | ![Node](https://img.shields.io/badge/-Node.js-339933?style=flat-square&logo=node.js&logoColor=white) ![Fastify](https://img.shields.io/badge/-Fastify-000000?style=flat-square&logo=fastify&logoColor=white) PGlite · BullMQ · WebSocket |
| 🎨 Frontend | ![React](https://img.shields.io/badge/-React-61DAFB?style=flat-square&logo=react&logoColor=black) ![Vite](https://img.shields.io/badge/-Vite-646CFF?style=flat-square&logo=vite&logoColor=white) Candlestick charts with liquidation markers |
| 🔗 Data | Alchemy/Infura RPC · Chainlink · Aave `LiquidationCall` · Coinbase/CoinGecko · Etherscan |

![Evidence, not mystique — RPC, Aave V3, Chainlink, Coinbase, Etherscan feeding a live liquidations feed](docs/screenshots/data-sources.jpeg)

</div>

---

## 🚀 Setup

```bash
git clone <this-repo>
cd cascade-catcher
npm install
npm run demo
```

> [!IMPORTANT]
> Runs the full application — API, worker, database, and frontend — from a single process at `http://localhost:8080`. No Docker, Postgres, or Redis installation required.

<div align="center">

![Terminal preview — ETH/USD chart, watchlist, and paper order ticket](docs/screenshots/terminal-preview.jpeg)

</div>

<details>
<summary>🔑 <b>Enable live Ethereum data (click to expand)</b></summary>

<br>

Add an RPC provider key to `.env`:

```bash
RPC_URLS=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY,https://ethereum-rpc.publicnode.com
```

</details>

---

## 🧾 Limitations

- ⚠️ Staked-ETH derivatives (wstETH, weETH) are valued at the ETH price.
- ⚠️ Chainlink's update thresholds are assumed, not independently verified.
- ⚠️ Free public RPCs are rate-limited; a keyed provider is recommended for reliable history.
- ⚠️ Backtest results validate the mechanism in simulation; they do not by themselves confirm the edge holds in live markets.

---

<div align="center">

## 📄 License

**MIT** — see [`LICENSE`](LICENSE) for details.

Made with 🌊 for Multipli

</div>
>>>>>>> e64dcb5163081a95c3416a2860932d2179e2a7f8
