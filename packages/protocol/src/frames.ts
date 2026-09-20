/**
 * WebSocket frame definitions.
 *
 * Every frame is a zod-validated discriminated union on `t`. Both ends parse
 * inbound frames through these schemas before the payload reaches any logic, which
 * is how "handle malformed messages" is satisfied exhaustively rather than by
 * hand-written guards that will miss a case.
 */

import { z } from 'zod';
import { TIERS, INTERVAL_IDS } from './config';
import { CandleSchema, TradeSchema, BookDeltaSchema } from './types';
import type { Candle, Trade, BookDelta } from './types';

const tierSchema = z.enum(TIERS);
const intervalSchema = z.enum(INTERVAL_IDS as [string, ...string[]]);

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** Sent on open and again on every reconnect and interval change. */
export const SubscribeFrameSchema = z.object({
  t: z.literal('subscribe'),
  symbol: z.string().min(1).max(32),
  interval: intervalSchema,
});

/**
 * `clientTime` is echoed back untouched so the client can compute
 * `rtt = now - clientTime` without the server and client clocks needing to agree.
 * Only the difference is used, so skew cancels.
 */
export const PingFrameSchema = z.object({
  t: z.literal('ping'),
  id: z.number().int().nonnegative(),
  clientTime: z.number().int().nonnegative(),
});

/**
 * The client's periodic quality report. The client computes these (D-005); the
 * server owns only the decision of what tier they imply (D-006).
 */
export const NetReportFrameSchema = z.object({
  t: z.literal('netreport'),
  latencyMs: z.number().nonnegative().finite(),
  jitterMs: z.number().nonnegative().finite(),
  samples: z.number().int().nonnegative(),
});

/** Debug control: a tier pins the connection; null releases it (D-013). */
export const SetTierFrameSchema = z.object({
  t: z.literal('setTier'),
  tier: tierSchema.nullable(),
});

/**
 * Debug control: `dropDelta` makes the server silently skip the next book delta
 * for THIS connection only, forcing a sequence gap so recovery can be demonstrated
 * without needing real packet loss.
 */
export const DebugFrameSchema = z.object({
  t: z.literal('debug'),
  action: z.enum(['dropDelta']),
});

export const ClientFrameSchema = z.discriminatedUnion('t', [
  SubscribeFrameSchema,
  PingFrameSchema,
  NetReportFrameSchema,
  SetTierFrameSchema,
  DebugFrameSchema,
]);

export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type SubscribeFrame = z.infer<typeof SubscribeFrameSchema>;
export type PingFrame = z.infer<typeof PingFrameSchema>;
export type NetReportFrame = z.infer<typeof NetReportFrameSchema>;
export type SetTierFrame = z.infer<typeof SetTierFrameSchema>;
export type DebugFrame = z.infer<typeof DebugFrameSchema>;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

/** First frame on every connection: symbol metadata so the client can format. */
export const HelloFrameSchema = z.object({
  t: z.literal('hello'),
  symbol: z.string(),
  priceScale: z.number().int(),
  qtyScale: z.number().int(),
  tickSize: z.number().int(),
  intervals: z.array(z.string()),
  serverTime: z.number().int(),
});

export const SubscribedFrameSchema = z.object({
  t: z.literal('subscribed'),
  symbol: z.string(),
  interval: intervalSchema,
});

export const PongFrameSchema = z.object({
  t: z.literal('pong'),
  id: z.number().int(),
  clientTime: z.number().int(),
  serverTime: z.number().int(),
});

export const BookFrameSchema = z.object({
  t: z.literal('book'),
  symbol: z.string(),
  delta: BookDeltaSchema,
});

/**
 * The candle frame carries the COMPLETE current OHLCV of the open bar, never a
 * patch against a previous one (D-009). This is the property that makes a slower
 * tier lossy in resolution but never in accuracy: a dropped intermediate frame
 * costs the client a view of a state, not the state itself.
 *
 * `closed` marks the final frame for a bucket. Those are flushed immediately,
 * bypassing the tier cadence, so every tier records the true close.
 */
export const CandleFrameSchema = z.object({
  t: z.literal('candle'),
  symbol: z.string(),
  interval: intervalSchema,
  candle: CandleSchema,
  closed: z.boolean(),
});

/**
 * `dropped` is the count of trades that exceeded MAX_TRADES_PER_FRAME. It is
 * surfaced rather than hidden so the tape can say so instead of silently lying
 * about being complete.
 */
export const TradesFrameSchema = z.object({
  t: z.literal('trades'),
  symbol: z.string(),
  trades: z.array(TradeSchema),
  dropped: z.number().int().nonnegative(),
});

/**
 * Tier state, pushed whenever it changes and on every report.
 *
 * `auto` is what the state machine would choose right now from the reports. When
 * `forced` is true, `active` is pinned by the debug override but `auto` keeps
 * updating — which is how we show that the automatic machinery is still running
 * underneath rather than switched off (D-013).
 */
export const TierFrameSchema = z.object({
  t: z.literal('tier'),
  active: tierSchema,
  auto: tierSchema,
  forced: z.boolean(),
  targetHz: z.number(),
  periodMs: z.number().int(),
  score: z.number(),
  latencyMs: z.number(),
  jitterMs: z.number(),
  reason: z.string(),
});

export const ErrorFrameSchema = z.object({
  t: z.literal('error'),
  code: z.enum(['bad_frame', 'unknown_symbol', 'bad_interval', 'internal']),
  message: z.string(),
});

export const ServerFrameSchema = z.discriminatedUnion('t', [
  HelloFrameSchema,
  SubscribedFrameSchema,
  PongFrameSchema,
  BookFrameSchema,
  CandleFrameSchema,
  TradesFrameSchema,
  TierFrameSchema,
  ErrorFrameSchema,
]);

type RawServerFrame = z.infer<typeof ServerFrameSchema>;

/**
 * The inferred types carry plain `number` for prices and quantities because zod
 * cannot see through the brand. Re-stating the branded members here keeps the rest
 * of the codebase honest about which numbers are scaled integers.
 */
export type ServerFrame =
  | Extract<RawServerFrame, { t: 'hello' | 'subscribed' | 'pong' | 'tier' | 'error' }>
  | { t: 'book'; symbol: string; delta: BookDelta }
  | { t: 'candle'; symbol: string; interval: string; candle: Candle; closed: boolean }
  | { t: 'trades'; symbol: string; trades: Trade[]; dropped: number };

export type HelloFrame = Extract<ServerFrame, { t: 'hello' }>;
export type SubscribedFrame = Extract<ServerFrame, { t: 'subscribed' }>;
export type PongFrame = Extract<ServerFrame, { t: 'pong' }>;
export type BookFrame = Extract<ServerFrame, { t: 'book' }>;
export type CandleFrame = Extract<ServerFrame, { t: 'candle' }>;
export type TradesFrame = Extract<ServerFrame, { t: 'trades' }>;
export type TierFrame = Extract<ServerFrame, { t: 'tier' }>;
export type ErrorFrame = Extract<ServerFrame, { t: 'error' }>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; frame: T } | { ok: false; reason: string };

/**
 * Parse an inbound WebSocket payload.
 *
 * Returns a result rather than throwing, because a malformed frame is an expected
 * condition on a public socket, not an exception. The caller decides whether to
 * reply with an error frame (server) or simply count and ignore it (client).
 */
function parseFrame<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  let data: unknown = raw;

  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'not valid JSON' };
    }
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    return { ok: false, reason: result.error.issues[0]?.message ?? 'schema mismatch' };
  }
  return { ok: true, frame: result.data };
}

export function parseClientFrame(raw: unknown): ParseResult<ClientFrame> {
  return parseFrame(ClientFrameSchema, raw);
}

export function parseServerFrame(raw: unknown): ParseResult<ServerFrame> {
  return parseFrame(ServerFrameSchema, raw) as ParseResult<ServerFrame>;
}

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame);
}
