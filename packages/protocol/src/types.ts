/**
 * Core domain shapes shared by both apps.
 *
 * Prices and quantities are branded integers (D-004). The brand is compile-time
 * only — it costs nothing at runtime — but it means a raw `number` cannot be passed
 * where a scaled integer is expected, which is the mistake that would otherwise be
 * silent and off by a factor of 100 or 100,000,000.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Branded scalars
// ---------------------------------------------------------------------------

declare const tickBrand: unique symbol;
declare const qtyBrand: unique symbol;

/** An integer count of price ticks. See PRICE_SCALE. */
export type TickPrice = number & { readonly [tickBrand]: true };

/** An integer count of base-currency minor units. See QTY_SCALE. */
export type MinorQty = number & { readonly [qtyBrand]: true };

/**
 * Unchecked constructors for the hot path. Input is validated at the system
 * boundary by the zod schemas below; inside the engine we are converting numbers we
 * produced ourselves, thousands of times a second, and a parse there would be pure
 * overhead.
 */
export const asTick = (n: number): TickPrice => n as TickPrice;
export const asQty = (n: number): MinorQty => n as MinorQty;

const tickSchema = z.number().int().finite();
const qtySchema = z.number().int().nonnegative().finite();
const tsSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

export const TradeSideSchema = z.enum(['buy', 'sell']);
export type TradeSide = z.infer<typeof TradeSideSchema>;

/**
 * `id` is the unambiguous ordering identifier the spec asks for: strictly
 * increasing, assigned by the engine, never reused. Timestamps alone are not
 * sufficient because several trades can land in the same millisecond.
 */
export const TradeSchema = z.object({
  id: z.number().int().positive(),
  ts: tsSchema,
  p: tickSchema,
  q: qtySchema,
  side: TradeSideSchema,
});

export type Trade = Omit<z.infer<typeof TradeSchema>, 'p' | 'q'> & {
  p: TickPrice;
  q: MinorQty;
};

// ---------------------------------------------------------------------------
// Candle
// ---------------------------------------------------------------------------

/**
 * `t` is the bucket start, not the time of the last trade. It is computed on the
 * server with `bucketStart()` and sent explicitly so the client never re-derives it
 * from a clock that may be skewed.
 *
 * `v` is base-asset volume as an integer sum of quantities. There is deliberately
 * no quote volume: summing price*qty over a candle overflows MAX_SAFE_INTEGER, and
 * nothing in the UI needs it (D-004).
 *
 * `n` is the trade count, which is what makes "the candle is identical at every
 * tier" checkable rather than merely assertable.
 */
export const CandleSchema = z.object({
  t: tsSchema,
  o: tickSchema,
  h: tickSchema,
  l: tickSchema,
  c: tickSchema,
  v: qtySchema,
  n: z.number().int().nonnegative(),
});

export type Candle = Omit<z.infer<typeof CandleSchema>, 'o' | 'h' | 'l' | 'c' | 'v'> & {
  o: TickPrice;
  h: TickPrice;
  l: TickPrice;
  c: TickPrice;
  v: MinorQty;
};

// ---------------------------------------------------------------------------
// Order book
// ---------------------------------------------------------------------------

/**
 * A single price level as `[price, quantity]`.
 *
 * The semantic is REPLACE, never ADD: this entry means "this level now holds
 * exactly this quantity", and a quantity of 0 means "remove this level". That
 * distinction is what makes coalescing deltas safe (D-010) — under a replace
 * semantic, last-write-wins per price is equivalent to applying every delta in
 * order. Under an additive semantic it would not be.
 */
export const LevelSchema = z.tuple([tickSchema, qtySchema]);
export type Level = [TickPrice, MinorQty];

export interface BookSide {
  levels: Level[];
}

/**
 * A book update covering the sequence range [fromSeq, toSeq] inclusive.
 *
 * For a single un-coalesced update fromSeq === toSeq. For a merged one it spans
 * everything that accumulated during the delivery period. Either way the client
 * asserts `fromSeq === lastSeq + 1` to detect a gap, then sets `lastSeq = toSeq`.
 */
export const BookDeltaSchema = z.object({
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
  bids: z.array(LevelSchema),
  asks: z.array(LevelSchema),
});

export type BookDelta = Omit<z.infer<typeof BookDeltaSchema>, 'bids' | 'asks'> & {
  bids: Level[];
  asks: Level[];
};

export const DepthSnapshotSchema = z.object({
  symbol: z.string(),
  /** The book sequence this snapshot reflects. Deltas at or below it are stale. */
  lastUpdateId: z.number().int().nonnegative(),
  ts: tsSchema,
  bids: z.array(LevelSchema),
  asks: z.array(LevelSchema),
});

export type DepthSnapshot = Omit<z.infer<typeof DepthSnapshotSchema>, 'bids' | 'asks'> & {
  bids: Level[];
  asks: Level[];
};

// ---------------------------------------------------------------------------
// Symbol metadata
// ---------------------------------------------------------------------------

export const SymbolInfoSchema = z.object({
  symbol: z.string(),
  priceScale: z.number().int().nonnegative(),
  qtyScale: z.number().int().nonnegative(),
  tickSize: z.number().int().positive(),
  intervals: z.array(z.string()),
  serverTime: tsSchema,
});

export type SymbolInfo = z.infer<typeof SymbolInfoSchema>;

// ---------------------------------------------------------------------------
// Network quality
// ---------------------------------------------------------------------------

export interface NetStats {
  /** EWMA of round-trip time, milliseconds. */
  latencyMs: number;
  /** RFC 3550 jitter estimate, milliseconds. */
  jitterMs: number;
  /** How many RTT samples have contributed. */
  samples: number;
}
