# Multipli — Cascade Catcher

> Real-time systematic crypto trading terminal: live prices, candles, Aave V3 on-chain liquidation indexing, Chainlink oracle gap analysis, and the **Cascade Catcher** quantitative strategy, streamed over REST and WebSocket.

---

## Quickstart

Run the full platform in one command (no external Docker, Postgres, or Redis needed):

```bash
npm install
npm run demo:offline      # starts backend + worker + embeds PGlite and serves web UI at http://localhost:8080
```

To run against **live public mainnet data** (Coinbase, CoinGecko, Ethereum RPC):

```bash
npm run demo
```

* **Web UI**: [http://localhost:8080](http://localhost:8080)
* **API Documentation**: [http://localhost:8080/docs](http://localhost:8080/docs)
* **API Base**: `http://localhost:8080/api/v1`
* **WebSocket Gateway**: `ws://localhost:8080/ws`

For frontend-only live development with hot reload:
```bash
npm run dev               # Vite dev server with proxy to :8080
```

---

## Architecture

```text
Multipli
├── src/                  # React + TypeScript + Vite frontend
│   ├── api/              # Typed REST and WebSocket clients
│   ├── main.tsx          # Landing experience & interactive trading terminal
│   └── styles.css        # Visual design system
├── backend/              # Node / Fastify / TypeScript backend
│   ├── src/api/          # REST routes & WebSocket gateway
│   ├── src/worker/       # Ingestion workers & failover chain
│   ├── src/shared/       # Cascade Catcher strategy engine, PGlite & Redis runtime
│   └── test/             # Vitest test suite (132 tests)
└── web-contract/         # OpenAPI specs, contracts and recorded fixtures
```

---

## Strategy: Cascade Catcher

The platform exploits **involuntary forced-selling dislocations** caused by on-chain liquidation spirals:

```text
MARKET EVENT
    ↓
LIQUIDATION PRESSURE (Aave V3 + Chainlink Lag)
    ↓
PRICE DISLOCATION (Drop > 4.0% from 3h high)
    ↓
STRATEGY EVALUATION (Liquidation spike > 3.0σ & 1h forced volume > $1.0M)
    ↓
SIGNAL FIRED
    ↓
RISK-CONTROLLED ENTRY (50% recovery take-profit, -6% stop-loss, 48h time-stop, circuit breaker)
    ↓
OUTCOME
```

---

## Quality & Testing

Verify the entire repository:

```bash
npm test                  # 132 tests passing across 10 test suites
npm run typecheck         # TypeScript strict typecheck across frontend and backend
npm run lint              # ESLint across codebase
npm run build             # Production Vite build
```
