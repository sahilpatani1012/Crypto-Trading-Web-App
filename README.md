# Adaptive Crypto Trading Terminal

**Live:** [crypto-trading-web-app.netlify.app](https://crypto-trading-web-app.netlify.app/)
· **API:** [crypto-trading-web-app.onrender.com](https://crypto-trading-web-app.onrender.com/health)

A simulated single-symbol cryptocurrency market with **per-connection adaptive chart
delivery**. The backend generates a deterministic trade stream, maintains an order
book, and computes OHLCV candles. Every connected client measures its own latency and
jitter and reports them; the server assigns that connection a delivery tier — full,
degraded or minimal — which changes how often chart updates are *delivered* without
ever changing what they say.

The design decision that makes that guarantee true rather than aspirational: **a
candle frame is always the complete current OHLCV, never a patch**, so a dropped
intermediate frame costs a client a view of a state and not the state itself. And a
candle close bypasses the delivery cadence entirely, so every tier records the true
close. There is a test that runs one engine with two clients pinned to 10 Hz and 1 Hz
and asserts every closed candle is byte-identical.

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
npm test          # 192 tests
npm run typecheck # all three packages
npm run build     # production build of both apps
```

### Backend only

```bash
npm run dev:server                        # watch mode
npm run build:server && npm start         # production bundle
```

A browser connects to `ws://localhost:4000/ws` locally, and to
`wss://<render-host>/ws` when deployed. The frontend reads both URLs from
`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL`.

---

## Architecture

Three packages in an npm workspace:

```
packages/protocol     zod schemas + inferred types + tuning constants
   ├── apps/server    Node · Fastify · ws          → Render
   └── apps/web       Next.js App Router · React   → Netlify
```

`packages/protocol` is the single source of truth for every byte on the wire. Both
apps import it, so a message shape cannot drift between them — change it in one place
and both sides stop compiling until they agree. It ships TypeScript source rather
than a build artifact, because both consumers already compile TypeScript and a third
build step would only add a `dist/` that can go stale.

### Backend layering

```
transport  →  delivery  →  market
```

- **`market/`** — the simulation. Seeded PRNG, mean-reverting price walk, order book,
  candle aggregation. No I/O at all; it does not know clients exist.
- **`delivery/`** — per-connection concerns. `ClientSession` owns one client's
  subscription, its `TierController`, and its `DeliveryScheduler`.
- **`transport/`** — Fastify routes, the WebSocket upgrade, frame validation.

Imports only ever point rightward. If `market/` ever needed to know a client's tier,
the design would have gone wrong — and that isolation is what makes "the engine
processes every trade regardless of who is connected" structurally true rather than
a claim.

### Frontend layering

```
app/ + components/  →  store/  →  lib/
```

Nothing in `lib/` imports React, which is what makes the networking, the order book
reconciliation and the latency maths testable with no DOM and no network.

There is **one client boundary in the tree**: `page.tsx` and `layout.tsx` are Server
Components and ship no JavaScript, and `TradingPanel` is the only component they
render that is a Client Component. Everything below it is client-side too and carries
its own `'use client'` directive — nine files in total — which is how the directive
works rather than a second boundary. The point is that the static shell costs nothing
and the interactive subtree is explicit and contained.

**Next.js App Router** was chosen over the Pages Router. The honest assessment: the
benefit here is modest, because nearly everything on this screen is genuinely
interactive and client-side, and there is no data fetching to move to the server —
live market data rendered on the server is stale before it reaches the browser. What
it does buy is that the static shell costs nothing, with a single explicit client
boundary rather than the whole page hydrating. It is also the framework's default, so
choosing Pages in 2026 invites a "why?" with no strong answer.

---

## State management

**Zustand**, with one documented exception.

The socket client is a plain class living outside the React tree, so whatever holds
state has to be writable from outside it — `useMarketStore.getState().setX()` does
that. Context could manage the writing too. The deciding factor is *reading*: Context
has no selector mechanism, so every consumer re-renders whenever the value changes
regardless of which field changed. At the rates here that is the whole subtree several
times a second.

Redux Toolkit would work, and its devtools would genuinely have helped debug the tier
state machine, but it brings actions, reducers, slices and a provider for what amounts
to about a dozen fields. TanStack Query was rejected as the primary answer because
this data is push-based — there are three REST calls in the entire app and they are
all "fetch once, then listen"; adopting it for those would add a second state model to
explain for almost no gain.

**The rule for where new state goes:**

| Condition | Goes in |
|---|---|
| More than one component reads it | Zustand, read through a selector |
| Exactly one consumer **and** faster than ~5 Hz | Bypass React entirely |
| Anything else | `useState` |

The middle row exists for one thing: the chart's active candle arrives up to ten times
a second, so it goes straight from the socket callback into the chart library's
imperative handle. React never learns a bar changed. The crosshair readout in the same
component *is* React state, because it changes at human speed — which makes the rule
concrete rather than abstract.

Auditing that rule found a real problem late on: `TierPanel` subscribed to the measured
delivery rate, which the client emitted on every candle frame. A panel displaying an
*average* was re-rendering ten times a second and visibly flickering. Network stats
are now emitted at most once per second.

---

## Generated market data

The market is a simulation seeded by `MARKET_SEED` (default `1337`). The same seed
produces the same price path on every run, which is what makes the tests deterministic
and a recorded demo reproducible. Nothing external is required.

- **Price** — a mean-reverting random walk in integer ticks. Each 50 ms step is a
  normal shock plus a gentle pull toward an anchor that itself drifts slowly toward
  the price. A pure random walk has no home and wanders anywhere; the anchor is a
  leash, not a magnet.
- **Trades** — Poisson arrivals averaging 8/second. A buy executes at the best ask and
  a sell at the best bid, so consecutive prints bounce across the spread the way a
  real tape does. Sizes are log-normal: mostly small, occasionally large, never
  negative.
- **Order book** — 20 concentric price bands a side, widening as `4 × slot^1.8`
  ticks. Replenishment fills empty bands, so the book holds *at least* 20 levels a
  side and usually more, since a band may contain more than one price. Levels rest
  across ticks and are pruned when the mid crosses them or they drift past the
  outermost band. `/api/depth` therefore returns the complete book by default —
  truncating it would hand the client a snapshot the delta stream does not match. `bestBid < bestAsk` is enforced
  structurally and asserted after every tick, including under 20× volatility — a
  crossed book renders perfectly normally while describing a market where risk-free
  arbitrage exists.
- **Candles** — 1s, 5s and 1m. Short intervals are deliberate: a 1m-only chart makes
  "a candle close flushes immediately" impossible to demonstrate on camera.
- **History** — generated at startup by running the *live* tick loop over a synthetic
  past, not by a separate generator. One code path means no seam where history meets
  live data, which is exactly where two generators would visibly disagree.

### Precision

Every price is an integer count of ticks (`priceScale = 2`, so `6543210` is
`$65,432.10`) and every quantity an integer in minor units (`qtyScale = 8`). All
arithmetic is integer; floats appear only in the formatting helpers and at the chart
boundary. Branded TypeScript types mean a raw `number` cannot be passed where a
`TickPrice` is expected.

This matters concretely: a one-minute candle sums roughly five hundred quantities,
which is exactly the scale where accumulated float error becomes visible in digits a
human is reading.

There is deliberately **no quote volume** — summing `price × qty` across a candle
exceeds `Number.MAX_SAFE_INTEGER`, and nothing in the UI needs it. A missing field you
can explain beats a present field you cannot trust.

Timestamps are server-generated epoch milliseconds, UTC. Candle buckets are
`floor(ts / intervalMs) * intervalMs`, aligned to the epoch so a restart does not
shift the grid. The client never uses its own clock for bucketing — only for
round-trip *differences*, where skew cancels.

---

## Protocols

### REST

| Endpoint | Returns |
|---|---|
| `GET /health` | Status, uptime, connection count, active seed |
| `GET /api/symbol` | Scales, tick size, available intervals |
| `GET /api/depth?symbol&limit` | Order book snapshot **with `lastUpdateId`** |
| `GET /api/candles?symbol&interval&limit` | Historical candles, including the open one |

### WebSocket — `/ws`

**Client → server:** `subscribe`, `ping`, `netreport`, `setTier`, `debug`
**Server → client:** `hello`, `subscribed`, `pong`, `book`, `candle`, `trades`, `tier`, `error`

Every inbound frame on both ends is validated against a shared zod schema before any
logic sees it. A malformed frame produces an `error` reply and the connection
survives — on a public socket that is an expected condition, not an exception.

Two independent monotonic sequences, both owned by the engine: `tradeId` per trade,
and a book sequence per book update. There is deliberately no per-frame sequence
number: WebSocket frames are ordered and reliable for as long as the connection
lives, so the only way to miss updates is a disconnect — which the book sequence
already catches.

> **CORS does not protect the WebSocket.** Browsers exempt WebSocket connections from
> the same-origin policy entirely, so `@fastify/cors` covers the REST endpoints and
> does nothing for the socket. The upgrade handler reads the `Origin` header itself
> and rejects with a raw 403 before the handshake completes. A *missing* Origin is
> allowed through — that means a non-browser client, which was never subject to the
> browser's rules anyway.

---

## Chart and order-book synchronisation

### Order book

Built from a REST snapshot plus sequenced deltas. The hard part is not applying
deltas — it is the race between the two sources. A snapshot request takes a couple of
hundred milliseconds and deltas keep arriving the whole time, some of which are
already inside the snapshot that is on its way. Applying everything double-counts;
discarding everything loses the ones that came *after*; ignoring deltas until the
snapshot lands loses those too.

So deltas are **buffered, not applied**:

1. `start()` → buffer every incoming delta, fetch `/api/depth`.
2. Snapshot arrives with `lastUpdateId = U`. Adopt it wholesale.
3. Discard every buffered delta with `toSeq <= U` — already inside it.
4. Require the first survivor to reach back to `U + 1`. If it cannot, the snapshot is
   already too old: fetch again, keeping the unapplied remainder.
5. Apply the rest in order. State becomes `synced`.

Then every delta is checked: `toSeq <= lastSeq` is a duplicate and is ignored;
`fromSeq === lastSeq + 1` is applied; anything else means updates went missing, so
fetch a new snapshot and buffer again — **without closing the socket**, because the
socket is fine, only the book is stale.

A **coalesced delta that straddles the snapshot boundary** — say `[100, 106]` against
a snapshot at 103 — is applied whole, and that is correct: the merged frame holds each
touched level's *final* quantity as of 106, and any level it does not mention was not
touched in that range. This works only because a delta means *set this level to this
quantity*, never *add this much* — the same property that makes server-side merging
legal.

Verified end to end against the live server: forcing a gap with the debug control
produced `snapshotting → synced → resyncing → synced`, after which the client's book
matched a fresh server snapshot exactly, with zero sequence drift.

### Chart

History comes from `/api/candles`; the live bar is merged with `series.update()`,
which upserts by timestamp — so duplicate candles are idempotent by construction. The
check that *is* needed is the opposite direction: `update()` throws on a bar older
than the newest, which is exactly what a late frame after a reconnect looks like.

Switching interval quickly puts several fetches in flight and the network gives no
ordering guarantee. Each request captures a **generation counter**; a response whose
generation is stale is discarded. Superseded requests are also aborted — but
`AbortController` cannot un-resolve a promise that has already settled and is queued
as a microtask, which is precisely what the generation check catches. Neither
mechanism covers the other's case.

On reconnect the chart **refetches history wholesale** rather than trying to resume.
After a gap of unknown size the only trustworthy source is a fresh snapshot; stitching
would need a "since timestamp" query and would leave a window where a stale bar looks
current.

The library renders and does nothing else. Fetching, interval switching, candle
formation and late-response handling are all ours.

---

## Latency and jitter measurement

The client pings every **2 s** with its own clock reading; the server echoes
`clientTime` back untouched and the client computes `rtt = now - clientTime`. Echoing
rather than using the server's clock means only a *difference* is used, so skew
between the two machines cancels entirely.

A single sample is far too noisy to drive a state machine — one garbage-collection
pause reads as 400 ms on a healthy connection. Two estimators, both O(1):

```
latency = α · rtt + (1 − α) · latency                α = 0.2
jitter += (|rtt − rtt_previous| − jitter) / 16       RFC 3550 (RTP)
```

The first sample **seeds** the average rather than being blended into zero; starting
from zero would mean climbing towards the truth over ten samples — twenty seconds of
telling the server the connection is faster than it is, which is the wrong direction
to be wrong in.

A sliding-window mean was rejected: it needs an array, a recomputation per sample, and
has a hard edge where a sample that mattered a moment ago abruptly counts for nothing.

Both numbers are reported every **4 s** in a `netreport` frame, and only once
something has actually been measured — reporting zeros would tell the server this is
the fastest connection it has ever seen. The client never decides anything; the
server owns the tier.

The pong is answered **inline**, never through the delivery scheduler. Queueing it
behind a 1 Hz cadence would add up to a second of phantom latency to every
measurement, and the client would report itself into an even slower tier — a feedback
loop where the measurement corrupts the thing it measures.

---

## Tiers, hysteresis and the missing-report fallback

### The score

```
score = latency + 2 × jitter
```

Collapsing both measurements into one scalar makes the state machine
one-dimensional, which is what makes it explainable and exhaustively testable;
separate thresholds would mean four quadrants and a rule for each.

Jitter is weighted double because it predicts the thing the tier system exists to
protect. A steady 200 ms connection feels responsive — everything arrives late but
evenly, and the chart advances smoothly. A 50 ms connection varying by ±150 ms feels
broken, because updates arrive in clumps and the chart stutters. Averaged latency
alone would rate the second connection as *better*.

### Tiers and rates

| Tier | Period | Target | Why |
|---|---|---|---|
| `full` | 100 ms | 10 Hz | The point where a price tick reads as continuous motion, while leaving ~90 ms of a 60 fps frame budget free |
| `degraded` | 250 ms | 4 Hz | Still reads as live to someone watching a price, cuts outbound frames by 60% |
| `minimal` | 1000 ms | 1 Hz | The floor at which a chart is still a live chart. Also matches the fastest candle interval, so even a minimal client sees every 1 s bar form |

A target rate is a **ceiling on delivery, not a quota**: when nothing happened in a
period, nothing is sent. The UI therefore shows the *measured* rate alongside the
target, and a quiet market legitimately reads below it.

### Hysteresis — two mechanisms

| Transition | Threshold |
|---|---|
| full → degraded | score > 250 |
| degraded → full | score < 180 |
| degraded → minimal | score > 600 |
| minimal → degraded | score < 450 |

Plus a **5 s dwell**: after any change, no further change is permitted.

Both are needed because each closes the other's hole. A deadband alone still flaps if
the score oscillates slowly across the whole band, since every individual transition
is legitimate. A dwell timer alone still flaps if the score parks exactly on a
threshold — it merely rate-limits it. Together the score has to move decisively *and*
stay moved.

A third mechanism (requiring N consecutive reports past the boundary) was deliberately
rejected: two already close both known failure modes, and three interacting mechanisms
is materially harder to explain and test.

**These numbers were calibrated, not guessed.** The first values were 150 and 400,
chosen before anything was deployed. The first deployment measured a healthy broadband
connection from India to Oregon at 122 ms, which with normal jitter scores around 150
— it would have been demoted permanently, since promotion required falling below 100.
A steady 122 ms is not a degraded experience for a chart. Every boundary was widened
and sanity-checked against five realistic connection profiles.

### Asymmetry: demote fast, promote slowly

A demotion may **skip a tier** — a score of 900 takes a connection straight from
`full` to `minimal`. A promotion always moves one step.

The costs are not symmetric. Being slow to demote actively harms a client that is
already drowning: it keeps receiving 10 Hz for another dwell period. Being quick to
promote only risks flapping back. This is the same shape as TCP congestion control's
multiplicative decrease with additive increase.

### Missing reports

If no `netreport` arrives for **12 s** — three missed report intervals — the session
demotes one tier, and again every 12 s until it reaches `minimal`, where it stops. The
next valid report resumes normal control, subject to dwell.

Silence is ambiguous — a wedged client, a saturated uplink, a backgrounded tab — but
every reading of it argues for sending *less*, so degrading is safe under all of them.
One step at a time, because a single report lost to a GC pause should not be punished
as though the connection had collapsed.

This also means **backgrounded tabs are handled for free**: browsers throttle
background timers, so reports slow or stop, and a tab nobody is looking at naturally
falls to 1 Hz using a mechanism built for broken connections.

### Disconnect and reconnect

A disconnect destroys the session and all its timers; no tier state survives. A
reconnected client is a new session and starts at `full` with its dwell clock already
elapsed, so its first report can act immediately.

Starting optimistically is deliberate: a fresh connection carries no evidence of being
bad, and the cost of being wrong is bounded at one report interval. Persisting the old
tier was rejected because the most common reason for a reconnect is that the server
restarted or the network path changed — in which case the old measurement describes a
path that no longer exists.

---

## Reconnect, browser lifecycle and stale state

### Detecting a dead connection

`onclose` only fires for a *clean* disconnect. A router reboot, a closed laptop lid, a
phone entering a tunnel or an expired mobile NAT entry sends nothing at all:
`readyState` stays `OPEN`, `onclose` never fires, and the UI shows a frozen price
indefinitely. That is a half-open TCP connection, and the only way to detect it is to
send something and notice nothing comes back.

The ping already sent every 2 s doubles as that liveness probe. Six seconds without a
pong and the socket is torn down regardless of what it claims about itself.

Separately, the **server** sends WebSocket protocol pings every 30 s and terminates
clients that do not answer — the same problem in the other direction, releasing
sessions and engine listeners that would otherwise accumulate.

### Reconnecting

Delays back off exponentially from 500 ms to a 15 s cap, with **equal jitter**: half
the delay deterministic, half random.

The jitter is the part that matters. If a server restarts and every client sees
`onclose` in the same instant, plain backoff has them all wait 500 ms, then all wait
1 s, then all wait 2 s — the waves get slower but they are still waves, and each one
can knock the recovering server down again. Full jitter (`random(0, base)`) was
rejected because it can produce a 5 ms retry, which for a single client is
indistinguishable from hammering.

### Resync, not resume

A reconnect re-sends the subscription, but more importantly raises a **resync**: the
order book refetches its snapshot and the chart refetches its history. The market
moved by an unknown amount while we were away, and after a gap of unknown size the
only trustworthy source is a fresh snapshot. The latency estimate is discarded too,
because it described a network path that may no longer exist.

### Browser lifecycle

Nothing is done when the tab is hidden, deliberately — the server's missing-report
fallback already degrades it correctly.

Two things were wrong here initially and are worth recording:

- **Resyncing on every tab switch** was wasteful. A hidden tab still *receives*
  WebSocket frames; only timers are throttled. A brief switch misses nothing, so a
  resync now only happens if the tab was hidden past the heartbeat timeout, where the
  page may have been frozen outright.
- **The heartbeat killed healthy connections.** Browsers throttle background timers,
  often to once a minute, so when the ping tick finally ran the last pong always
  looked stale and the client tore down a working socket. It was measuring its own
  throttling and calling it a network failure. The liveness check is now skipped while
  hidden, and the clock is reset when the tab returns.

On becoming visible the client pings immediately and, if it was waiting to reconnect,
retries at once rather than serving out a backoff that grew while nobody was watching.

### Stale state

While the socket is not open, everything on screen keeps its last known values but is
**dimmed**, with a banner saying `STALE` and how many seconds old the data is.

Blanking the screen destroys the user's context. Showing stale data as though it were
live is worse than either — someone acting on a price from three minutes ago has been
lied to, not inconvenienced. A UI that cannot distinguish "current" from "last known"
is dangerous, and this one is a trading screen.

Alongside it, a compact always-on pill shows the connection state and current latency
even when everything is healthy, so a live screen is distinguishable from a frozen one
at a glance.

---

## Debug controls

All three are in the **Delivery tier** panel, and all three work on the deployed site.

| Control | Effect |
|---|---|
| `force full` / `force degraded` / `force minimal` | Pins this connection's tier |
| `automatic` | Releases the override, resuming automatic control with dwell reset |
| `force book gap` | Makes the server silently skip this connection's next book delta |

Under the hood these are WebSocket frames — `{t:'setTier', tier}` and
`{t:'debug', action:'dropDelta'}` — so they address one specific connection, which a
REST endpoint could not do without inventing a connection-ID scheme.

**While an override is active the state machine keeps running.** It still consumes
reports and still computes the tier it *would* have chosen, and the panel shows both:
`minimal (forced)` alongside `automatic would choose full`. That is the difference
between an override and an off switch.

A tier can also be pinned at connect time with `?tier=degraded` on the WebSocket URL,
for scripted demos.

`force book gap` flushes whatever is pending *before* arming. Without that, coalescing
swallows the gap: a pending range of `[104, 104]` plus a skipped 105 plus an incoming
106 merges to `[104, 106]`, which looks perfectly contiguous to the client while
silently missing 105's changes.

> These controls ship unauthenticated so a reviewer can exercise them. A real
> deployment would gate them behind a debug token.

---

## Deployment

The two services deploy separately, and **the backend cannot go on a serverless
host**: a WebSocket needs a process that outlives a request and holds per-connection
state — the subscription, the tier state machine, its timers. Netlify's and Vercel's
functions are stateless with a hard duration cap, so they fundamentally cannot hold
one.

| | Platform | Why |
|---|---|---|
| `apps/web` | Netlify | Static shell plus serverless — a good fit (Vercel works identically) |
| `apps/server` | Render | Long-lived container, which a socket server requires |

Each needs the other's URL, so deploy in this order:

**1. Backend → Render**

New → **Blueprint** → select this repo. `render.yaml` is picked up automatically.
Leave `CORS_ORIGINS` unset for now; it defaults to `*`. Verify at `/health`.

> `render.yaml` is only read for services created **from a Blueprint**. A service
> created manually as a Web Service ignores it entirely and falls back to Render's
> defaults (`npm install; npm run build` and `npm start`). If you went that route, set
> these by hand under Settings:
>
> | Field | Value |
> |---|---|
> | Build Command | `npm ci --include=dev && npm run build:server` |
> | Start Command | `node apps/server/dist/index.js` |
> | Health Check Path | `/health` |
>
> `--include=dev` and `NODE_ENV=production` have to be set together: under
> `NODE_ENV=production` npm skips devDependencies, which is where `tsup` lives, and
> the build fails with `tsup: not found` several lines after the actual cause.
>
> The repo also defines a root `start` script pointing at the built server, so
> Render's default start command works even without any of the above.

**2. Frontend → Netlify** (or Vercel — the steps are the same)

Import the repo and **set the base directory to `apps/web`** — without it the
workspace will not resolve. Then add environment variables:

```
NEXT_PUBLIC_API_URL = https://<your-render-service>.onrender.com
NEXT_PUBLIC_WS_URL  = wss://<your-render-service>.onrender.com/ws
```

Two things that are easy to get wrong here:

- It is `wss://`, not `ws://`. A browser on an HTTPS page refuses to open an insecure
  WebSocket, and the failure is quiet. `assertSecureTransport()` in
  `apps/web/src/lib/config.ts` turns that into a console error rather than a mystery.
- `NEXT_PUBLIC_*` variables are **inlined at build time**, not read at runtime. Adding
  or changing one therefore requires a fresh build — on Netlify that means *Clear
  cache and deploy site*, not a plain redeploy, which would just re-serve the previous
  artifact with the old values compiled in.

**3. Lock CORS down**

Back on Render, set `CORS_ORIGINS` to the frontend URL and redeploy. Until this is
done the backend accepts any origin, and the origin check in the WebSocket upgrade
handler is effectively disabled.

> **Render's free tier sleeps after 15 minutes of inactivity** and takes roughly 30–50
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
| `zustand` | Selector-based subscriptions and writable from outside React, which is what a socket client needs |
| `lightweight-charts` | Renders only — it fetches nothing. We own every byte it draws |
| `vitest` | One runner across the workspace, with fake timers that work for timer-driven state machines |
| `tsx` / `tsup` | TypeScript in dev, a bundled single file in production |
| `pino-pretty` | Readable dev logs; production emits structured JSON |

---

## Testing

```bash
npm test     # 192 tests
```

Three kinds, deliberately:

- **Known-answer** — four trades in, every OHLCV field asserted by hand.
- **Reference implementation** — 300 random trades folded incrementally, then compared
  against an independent recomputation. If the two disagree, one is wrong.
- **Invariant** — properties that must hold for *any* input. `bestBid < bestAsk` after
  every tick including at 20× volatility; candle `low` bounds open and close from
  below; book sequence numbers contiguous.

The two the brief specifically recommends:

- **Tier changes and hysteresis** (`tier-controller.test.ts`, 27 tests) — a score
  oscillating inside the deadband does not move the tier; a score parked exactly on a
  threshold produces zero changes across 40 evaluations; a score swinging wildly every
  second is rate-limited by dwell; demotion skips a tier while promotion does not;
  silence demotes progressively and stops at the floor; an override pins `active`
  while `auto` keeps updating.
- **Order book snapshot/delta sync and recovery** (`order-book-store.test.ts`, 24
  tests) — deltas buffered during an in-flight snapshot are filtered correctly; a
  coalesced delta straddling the boundary is applied whole; a gap triggers a resync
  without closing the socket; after recovery the client's book equals an independently
  maintained reference map; a superseded snapshot response is discarded.

And the one that proves the central claim:

- **Candles are identical at every tier** (`session.test.ts`) — one engine, two
  clients pinned to 10 Hz and 1 Hz, every closed candle byte-identical. A companion
  test asserts their *intermediate* frame counts differ by more than 3×, so the first
  is not passing trivially.

Everything time-dependent takes an injected clock, so the suite runs hours of
simulated trading in about 1.5 seconds with no sleeps and no flakiness.

---

## Known limitations

- **Single process.** The socket layer does not scale horizontally. At scale, frames
  would be serialised once per tier rather than once per client, per-connection timers
  would become three shared wheels, and fan-out would move to Redis pub/sub with tier
  state staying on the connection-owning node.
- **The client is trusted.** A malicious client could report 0 ms and pin itself to
  `full`. Acceptable here — the debug override does the same thing openly — but a real
  deployment would corroborate with server-side send timing.
- **Debug controls ship unauthenticated**, so a reviewer can exercise them. A token
  would gate them in production.
- **No matching engine.** Trades consume liquidity at the best price, but book depth
  does not respond to order flow the way a real one does — a large aggressive order
  should walk multiple levels and leave a visible dent.
- **No quote volume**, by choice. See precision above.
- **Dwell bounds reaction time.** A connection that collapses takes up to 5 s plus a
  report interval to reach `minimal`. Fine for a chart feed; not for anything
  safety-critical.
- **The chart series grows over a long session.** Bars appended by `update()` are never
  trimmed, so a multi-hour session at 1 s bars accumulates. A production chart would
  keep a rolling window.
- **A server that answers pings but sends no market data** would read as connected. The
  heartbeat covers a dead peer, not a silent one; a data-staleness timeout would catch
  it.
- **Watchlist reordering** (a stated bonus) is not built. Scoped out against a
  three-day budget in favour of finishing the graded requirements.
- **Render free tier cold starts.** Documented above. Warmup also runs before
  `listen()`, so the first ~1.5 s after a cold start refuses connections — negligible
  against the platform's own 30–50 s wake, but it would be wrong on a real host.
- **A client can flood the inline-response path.** `send` checks that the socket is
  open but not how much is already buffered; the backpressure guard lives only in the
  delivery scheduler. A client that never drains while looping `ping` or `subscribe`
  would grow its own session's buffer without bound. Rate limiting and a per-session
  byte cap are the fix.
- **A starved process replays its whole candle gap at once.** Tick catch-up is capped,
  but the aggregators then synthesise one closed candle per missed bucket in a single
  synchronous call — and each close flushes immediately by design. After a long
  suspend that is thousands of frames in one event-loop turn.
- **`force book gap` is a no-op under backpressure.** It flushes before arming so the
  pending sequence range is closed, but that flush is skipped when the socket has not
  drained, and the dropped delta is then swallowed by the still-open merge range.
- **Level-application helpers are duplicated** between `server/market/order-book.ts`
  and `web/lib/market/order-book-store.ts`. That is worse than ordinary duplication:
  the server-side round-trip test that is meant to prove "snapshot plus deltas
  reproduces the server's book" is verifying a *copy* of the client's logic rather
  than the client's logic. They belong in `packages/protocol`.
- **The client ignores `error` frames.** A rejected subscribe leaves the status pill
  green with no data arriving, rather than saying what went wrong.
