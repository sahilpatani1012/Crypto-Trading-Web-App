/**
 * Tuning constants for the whole system.
 *
 * Everything here is shared by both apps deliberately: the client needs the tier
 * table to render "target rate", and the server needs it to schedule. Two copies
 * would drift.
 *
 * The rationale for each number lives in docs/DECISIONS.md (D-004, D-005, D-006,
 * D-007, D-008) and is summarised inline where it affects how the code reads.
 */

// ---------------------------------------------------------------------------
// Symbol and precision (D-004)
// ---------------------------------------------------------------------------

/** The single simulated market. */
export const SYMBOL = 'BTC-USD';

/**
 * Prices are integers counting 10^-PRICE_SCALE units of quote currency.
 * PRICE_SCALE = 2 means the integer 6_543_210 is $65,432.10.
 */
export const PRICE_SCALE = 2;

/**
 * Quantities are integers counting 10^-QTY_SCALE units of base currency.
 * QTY_SCALE = 8 is the satoshi convention: 1_000_000 is 0.01 BTC.
 */
export const QTY_SCALE = 8;

/** Minimum price increment, in integer ticks. 1 tick = $0.01 at PRICE_SCALE 2. */
export const TICK_SIZE = 1;

/** Starting mid price: $65,000.00. */
export const INITIAL_PRICE = 6_500_000;

// ---------------------------------------------------------------------------
// Candle intervals
// ---------------------------------------------------------------------------

/**
 * Short intervals are a deliberate choice for demonstrability (D-012): a 1m-only
 * chart makes the "candle close flushes immediately" behaviour impossible to show
 * in a screen recording, because you would wait a full minute per bar.
 */
export const INTERVALS = {
  '1s': 1_000,
  '5s': 5_000,
  '1m': 60_000,
} as const;

export type IntervalId = keyof typeof INTERVALS;

export const INTERVAL_IDS = Object.keys(INTERVALS) as IntervalId[];

export const DEFAULT_INTERVAL: IntervalId = '1s';

export function isIntervalId(value: unknown): value is IntervalId {
  return typeof value === 'string' && value in INTERVALS;
}

/** How many candles per interval the server retains and will serve as history. */
export const HISTORY_LIMIT = 600;

/** How far back `warmup()` generates history at startup, per interval. */
export const WARMUP_BARS = 400;

// ---------------------------------------------------------------------------
// Order book
// ---------------------------------------------------------------------------

/** Levels maintained on each side of the book. The spec requires at least 10. */
export const BOOK_DEPTH = 20;

/** Levels the UI displays per side. */
export const BOOK_DISPLAY_DEPTH = 10;

// ---------------------------------------------------------------------------
// Delivery tiers (D-006)
// ---------------------------------------------------------------------------

export const TIERS = ['full', 'degraded', 'minimal'] as const;
export type Tier = (typeof TIERS)[number];

/** Rank, so the state machine can talk about "one tier worse". */
export const TIER_RANK: Record<Tier, number> = { full: 0, degraded: 1, minimal: 2 };

/**
 * Target chart-update cadence per tier.
 *
 *   full     10 Hz — the point where a price tick reads as continuous motion,
 *                    while still leaving ~90ms of a 60fps frame budget free.
 *   degraded  4 Hz — still reads as "live" to a human watching a price, but cuts
 *                    outbound frames by 60%.
 *   minimal   1 Hz — the floor at which a chart is still a live chart rather than
 *                    a static image. Also matches our fastest candle interval, so
 *                    even a minimal-tier client sees every 1s bar form.
 */
export const TIER_PERIOD_MS: Record<Tier, number> = {
  full: 100,
  degraded: 250,
  minimal: 1_000,
};

export const TIER_TARGET_HZ: Record<Tier, number> = {
  full: 10,
  degraded: 4,
  minimal: 1,
};

/**
 * Jitter counts double towards the tier score (D-006).
 *
 * A connection at a constant 200ms feels responsive — everything arrives late but
 * the chart advances smoothly. A connection at 50ms +/- 150ms feels broken, because
 * updates arrive in clumps and the chart visibly stutters. The tier system exists to
 * protect perceived smoothness, so the metric that predicts stuttering is weighted
 * above the one that predicts lag.
 */
export const JITTER_WEIGHT = 2;

export function tierScore(latencyMs: number, jitterMs: number): number {
  return latencyMs + JITTER_WEIGHT * jitterMs;
}

/**
 * Hysteresis boundaries (D-007), mechanism 1 of 2: a deadband.
 *
 * Demote when the score rises above `demoteAbove`; promote only when it falls below
 * a distinctly lower `promoteBelow`. The gap between the two is what stops a score
 * hovering near a single number from toggling the tier on every report.
 */
export const TIER_THRESHOLDS = {
  /** full -> degraded */
  demoteFromFull: 150,
  /** degraded -> full */
  promoteToFull: 100,
  /** degraded -> minimal */
  demoteFromDegraded: 400,
  /** minimal -> degraded */
  promoteToDegraded: 300,
} as const;

/**
 * Hysteresis mechanism 2 of 2: dwell time.
 *
 * After any tier change, no further change is permitted for this long. The deadband
 * alone still flaps if the score oscillates slowly across the whole 100-150 band,
 * because each individual transition is legitimate; dwell forces the score to not
 * just move decisively but stay moved.
 */
export const TIER_DWELL_MS = 5_000;

// ---------------------------------------------------------------------------
// Latency measurement (D-005)
// ---------------------------------------------------------------------------

/** How often the client sends a ping frame. */
export const PING_INTERVAL_MS = 2_000;

/** How often the client reports its measurements. Every second ping. */
export const REPORT_INTERVAL_MS = 4_000;

/**
 * Silence longer than this demotes the session one tier, and again every
 * MISSING_REPORT_TIMEOUT_MS thereafter until it reaches minimal (D-008).
 * Three missed report intervals: forgiving enough to survive a GC pause, strict
 * enough to react before a wedged client wastes much bandwidth.
 */
export const MISSING_REPORT_TIMEOUT_MS = 12_000;

/**
 * EWMA smoothing for round-trip time: latency = a*rtt + (1-a)*latency.
 * At a = 0.2 a step change is ~90% absorbed after about ten samples (20 seconds).
 */
export const EWMA_ALPHA = 0.2;

/**
 * RFC 3550 (RTP) jitter estimator divisor: J += (|D| - J) / 16.
 * Using the standard estimator rather than a hand-rolled standard deviation is both
 * cheaper (O(1), no window array) and easier to defend.
 */
export const JITTER_DIVISOR = 16;

/** Window over which the client measures its *actual* received update rate. */
export const RATE_WINDOW_MS = 3_000;

// ---------------------------------------------------------------------------
// Delivery limits
// ---------------------------------------------------------------------------

/**
 * Cap on trades carried in one coalesced frame. At minimal tier with ~8 trades/sec
 * this is never reached; it exists so a pathological burst cannot produce an
 * unbounded frame. Overflow is reported honestly as `dropped` rather than hidden.
 */
export const MAX_TRADES_PER_FRAME = 50;

/** Trade tape length retained by the client UI. */
export const TAPE_LENGTH = 30;

/**
 * If a socket's buffered bytes exceed this, skip the tick rather than pile on.
 * The client is not draining; adding more frames would only grow the backlog.
 */
export const BACKPRESSURE_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Engine tick period. Trades are drawn per tick, so this bounds trade granularity. */
export const ENGINE_TICK_MS = 50;

/** Mean trades per second (Poisson). ~8/sec makes coalescing visibly meaningful. */
export const TRADES_PER_SECOND = 8;

/** Default PRNG seed. Override with MARKET_SEED to get a different price path. */
export const DEFAULT_SEED = 1_337;

// ---------------------------------------------------------------------------
// Formatting helpers (the only place floats are allowed — D-004)
// ---------------------------------------------------------------------------

export function formatPrice(ticks: number, scale = PRICE_SCALE): string {
  return (ticks / 10 ** scale).toFixed(scale);
}

export function formatQty(minor: number, scale = QTY_SCALE, decimals = 4): string {
  return (minor / 10 ** scale).toFixed(decimals);
}

/** Integer ticks -> a float, for chart libraries that insist on one. */
export function toFloatPrice(ticks: number, scale = PRICE_SCALE): number {
  return ticks / 10 ** scale;
}

export function toFloatQty(minor: number, scale = QTY_SCALE): number {
  return minor / 10 ** scale;
}

/** Start of the candle bucket containing `ts`. Always computed server-side. */
export function bucketStart(ts: number, intervalMs: number): number {
  return Math.floor(ts / intervalMs) * intervalMs;
}
