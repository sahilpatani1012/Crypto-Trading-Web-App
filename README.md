# Adaptive Crypto Trading Terminal

A simulated single-symbol cryptocurrency market with **per-connection adaptive chart
delivery**. The backend generates a deterministic trade stream, maintains an order
book, and computes OHLCV candles. Every connected client reports its own latency and
jitter, and the server assigns that connection a delivery tier — full, degraded or
minimal — which changes how often chart updates are *delivered* without ever changing
what they say.

> **Status:** in progress. The market engine and the REST + WebSocket transport are
> complete; the adaptive delivery tiers, order-book reconciliation and the trading UI
> are being built. Sections below describe what exists today.

---

## Quick start

```bash
npm install
npm run dev
```

That starts both services:

| Service | URL |
|---|---|
| Backend (REST + WebSocket) | http://localhost:4000 |
| Frontend | http://localhost:3000 |

No `.env` file is required — every value has a local default. See
`apps/server/.env.example` and `apps/web/.env.example` for what can be overridden.

```bash
npm test          # full suite
npm run typecheck # all three packages
npm run build     # production build of both apps
```

### Backend only

```bash
npm run dev:server                 # watch mode
npm run build --workspace @cta/server && node apps/server/dist/index.js
```

---

## Architecture

Three packages in an npm workspace:

```
packages/protocol     zod schemas + inferred types + tuning constants
   ├── apps/server    Node · Fastify · ws          → Render
   └── apps/web       Next.js App Router · React   → Vercel
```

`packages/protocol` is the single source of truth for every byte on the wire. Both
apps import it, so a message shape cannot drift between them — change it in one place
and both sides stop compiling until they agree.

### Backend layering

```
transport  →  delivery  →  market
```

- **`market/`** — the simulation. Seeded PRNG, mean-reverting price walk, order book,
  candle aggregation. No I/O at all; it does not know clients exist.
- **`delivery/`** — per-connection concerns. `ClientSession` owns one client's
  subscription and listeners. The tier state machine and coalescing scheduler land
  here.
- **`transport/`** — Fastify routes, the WebSocket upgrade, frame validation.

Imports only ever point rightward. If `market/` ever needed to know a client's tier,
the design would have gone wrong.

### Frontend layering

```
app/ + components/  →  store/  →  lib/
```

Nothing in `lib/` imports React, which is what makes the networking and reconciliation
logic testable with no DOM.

---

## Generated market data

The market is a simulation, seeded by `MARKET_SEED` (default `1337`). The same seed
produces the same price path on every run, which is what makes the tests deterministic
and a recorded demo reproducible.

- **Price** — a mean-reverting random walk in integer ticks. A normal shock each 50 ms
  tick, plus a gentle pull toward an anchor that itself drifts slowly toward the price.
  Pure random walk has no home and wanders anywhere; the anchor is a leash, not a magnet.
- **Trades** — Poisson arrivals averaging 8/second. A buy executes at the best ask and
  a sell at the best bid, so consecutive prints bounce across the spread the way a real
  tape does. Sizes are log-normal: mostly small, occasionally large, never negative.
- **Order book** — 20 levels a side, organised into concentric price bands widening as
  `4 × slot^1.8` ticks. Levels rest across ticks and are pruned when the mid crosses
  them or they drift past the outermost band. `bestBid < bestAsk` is enforced
  structurally and asserted in tests.
- **Candles** — 1s, 5s and 1m. Short intervals are deliberate: a 1m-only chart makes
  "a candle close flushes immediately" impossible to demonstrate on camera.
- **History** — generated at startup by running the *live* tick loop over a synthetic
  past, not by a separate generator. One code path means no seam where history meets
  live data.

### Precision

Every price is an integer count of ticks (`priceScale = 2`, so `6543210` is
`$65,432.10`) and every quantity an integer in minor units (`qtyScale = 8`). All
arithmetic is integer; floats appear only in the formatting helpers. A one-minute
candle sums roughly five hundred quantities, which is exactly the scale where
accumulated float error becomes visible in digits a human is reading.

There is deliberately no quote volume: summing `price × qty` across a candle exceeds
`Number.MAX_SAFE_INTEGER`, and nothing in the UI needs it.

---

## Protocols

### REST

| Endpoint | Returns |
|---|---|
| `GET /health` | Status, uptime, connection count, active seed |
| `GET /api/symbol` | Scales, tick size, available intervals |
| `GET /api/depth?symbol&limit` | Order book snapshot **with `lastUpdateId`** |
| `GET /api/candles?symbol&interval&limit` | Historical candles |

`lastUpdateId` is the contract that makes client reconciliation possible: it states
which book sequence the snapshot already reflects, so the client knows which buffered
deltas to discard and exactly which sequence the next one must start at.

### WebSocket — `ws://localhost:4000/ws`

**Client → server:** `subscribe`, `ping`, `netreport`, `setTier`, `debug`
**Server → client:** `hello`, `subscribed`, `pong`, `book`, `candle`, `trades`, `tier`, `error`

Every inbound frame is validated against a shared zod schema before any logic sees it.
A malformed frame produces an `error` reply; the connection survives.

Book updates carry `fromSeq` and `toSeq`. A delta entry is `[price, quantity]` and
means **set this level to exactly this quantity** — zero removes the level. It never
means "add this much". That replace semantic is what makes coalescing safe.

---

## Deployment

The two services deploy separately, and **they cannot be swapped**: a WebSocket needs a
process that outlives a request and holds per-connection state, which Vercel's
stateless, duration-capped serverless functions fundamentally cannot do.

| | Platform | Why |
|---|---|---|
| `apps/web` | Vercel | Static shell plus serverless — a good fit |
| `apps/server` | Render | Long-lived container, which a socket server requires |

Each needs the other's URL, so deploy in this order:

**1. Backend → Render**
New → Blueprint → select this repo. `render.yaml` is picked up automatically. Leave
`CORS_ORIGINS` unset for now; it defaults to `*`. Verify at `/health`.

**2. Frontend → Vercel**
Add New → Project → this repo, then **set Root Directory to `apps/web`** — without it
the workspace will not resolve. Environment variables:

```
NEXT_PUBLIC_API_URL = https://<your-render-service>.onrender.com
NEXT_PUBLIC_WS_URL  = wss://<your-render-service>.onrender.com/ws
```

Note `wss://`, not `ws://`. A browser on an HTTPS page refuses to open an insecure
WebSocket, and the failure is quiet.

**3. Lock CORS down**
Back on Render, set `CORS_ORIGINS` to the Vercel URL and redeploy.

> **Render free tier sleeps after 15 minutes of inactivity** and takes roughly 30–50
> seconds to wake. The first load after a quiet period will look slow. This is the
> hosting plan, not the app.

---

## Packages used

| Package | Why |
|---|---|
| `fastify` + `@fastify/cors` | Schema-based validation and serialisation built in, meaningfully faster than Express |
| `ws` | The standard WebSocket implementation. Chosen over Socket.IO deliberately — reconnection and resubscription are what this project is about, and delegating them would hand away the interesting code |
| `zod` | One definition per message, producing both the runtime validator and the TypeScript type |
| `next` + `react` | Required by the brief |
| `zustand` | Selector-based subscriptions and mutable from outside React, which is what a socket client needs |
| `lightweight-charts` | Renders only — it fetches nothing. We own every byte it draws |
| `vitest` | One runner across the workspace, with fake timers that work for timer-driven state machines |
| `tsx` / `tsup` | TypeScript in dev, a bundled single file in production |

---

## Testing

```bash
npm test
```

Three kinds of test, deliberately:

- **Known-answer** — four trades in, every OHLCV field asserted by hand.
- **Reference implementation** — 300 random trades folded incrementally, then compared
  against an independent recomputation. If the two disagree, one is wrong.
- **Invariant** — properties that must hold for *any* input. `bestBid < bestAsk` after
  every tick, including at twenty times normal volatility. Candle `low` bounds open and
  close from below and `high` from above. Book sequence numbers are contiguous.

The invariant tests are the most valuable, because they cover scenarios nobody thought
to write down. A crossed order book renders perfectly normally while describing a
market where risk-free arbitrage exists.

---

## Known limitations

- **Single process.** The socket layer does not scale horizontally. At scale, frames
  would be serialised once per tier rather than once per client, per-connection timers
  would become three shared wheels, and fan-out would move to Redis pub/sub with the
  tier state staying on the connection-owning node.
- **Debug controls ship unauthenticated.** Correct for a reviewable assignment, wrong
  for production, where they would sit behind a token.
- **No matching engine.** Trades consume liquidity at the best price, but book depth
  does not respond to order flow the way a real one does — a large aggressive order
  should walk multiple levels and leave a visible dent.
- **No quote volume**, by choice. See precision above.
- **Render free tier cold starts.** Documented above.
