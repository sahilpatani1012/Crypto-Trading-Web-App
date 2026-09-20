/**
 * REST contract.
 *
 * Three endpoints, all read-only snapshots. Everything that changes continuously
 * arrives on the WebSocket; REST exists to give the client a trustworthy starting
 * point it can reconcile deltas against.
 */

import { z } from 'zod';
import { CandleSchema, DepthSnapshotSchema, SymbolInfoSchema } from './types';
import type { Candle, DepthSnapshot, SymbolInfo } from './types';

export const REST_ROUTES = {
  symbol: '/api/symbol',
  depth: '/api/depth',
  candles: '/api/candles',
  health: '/health',
} as const;

/** GET /api/symbol */
export const SymbolResponseSchema = SymbolInfoSchema;
export type SymbolResponse = SymbolInfo;

/**
 * GET /api/depth?symbol=BTC-USD&limit=20
 *
 * `lastUpdateId` is the contract that makes reconciliation possible: it is the book
 * sequence number this snapshot reflects. The client discards every buffered delta
 * whose `toSeq <= lastUpdateId`, then requires the next one to start at
 * `lastUpdateId + 1`.
 */
export const DepthResponseSchema = DepthSnapshotSchema;
export type DepthResponse = DepthSnapshot;

export const DepthQuerySchema = z.object({
  symbol: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/** GET /api/candles?symbol=BTC-USD&interval=1s&limit=600 */
export const CandlesResponseSchema = z.object({
  symbol: z.string(),
  interval: z.string(),
  candles: z.array(CandleSchema),
});

export type CandlesResponse = {
  symbol: string;
  interval: string;
  candles: Candle[];
};

export const CandlesQuerySchema = z.object({
  symbol: z.string().optional(),
  interval: z.string().optional(),
  limit: z.coerce.number().int().positive().max(2000).optional(),
});

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeMs: z.number().int(),
  connections: z.number().int(),
  seed: z.number().int(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
