/**
 * REST helpers.
 *
 * Three snapshot endpoints, each validated against the shared schema before it
 * reaches any logic. A backend that changes shape should fail loudly here rather
 * than producing a chart with `undefined` prices, and the cost is a few microseconds
 * on requests that happen a handful of times per session.
 *
 * Every call takes an `AbortSignal`. Callers pair it with a generation counter: the
 * signal stops the network work, and the generation check catches a response that
 * had already resolved before the abort landed. Neither covers the other's case.
 */

import {
  CandlesResponseSchema,
  DepthResponseSchema,
  HISTORY_LIMIT,
  REST_ROUTES,
  SymbolResponseSchema,
  type CandlesResponse,
  type DepthResponse,
  type IntervalId,
  type SymbolResponse,
} from '@cta/protocol';

import { API_URL } from '@/lib/config';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson(path: string, params: Record<string, string | number>, signal?: AbortSignal) {
  const url = new URL(path, API_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new ApiError(`${path} returned ${response.status}`, response.status);
  }
  return (await response.json()) as unknown;
}

export async function fetchSymbolInfo(signal?: AbortSignal): Promise<SymbolResponse> {
  const raw = await getJson(REST_ROUTES.symbol, {}, signal);
  const parsed = SymbolResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(`malformed symbol response: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/**
 * The order book snapshot.
 *
 * `lastUpdateId` is the field the whole reconciliation depends on: it states which
 * sequence number this snapshot already reflects, so the client knows which buffered
 * deltas to discard and exactly which sequence the next one must bridge.
 */
export async function fetchDepth(
  symbol: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<DepthResponse> {
  // No limit by default, deliberately. The delta stream covers every price level,
  // so reconciling against a display-sized snapshot would leave the book missing
  // levels that later deltas assume exist — and the contiguity check cannot see it,
  // because the sequence numbers line up perfectly while the book is wrong.
  // Truncation for display happens on the rendered top-N, not on the source.
  const raw = await getJson(
    REST_ROUTES.depth,
    limit === undefined ? { symbol } : { symbol, limit },
    signal,
  );
  const parsed = DepthResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(`malformed depth response: ${parsed.error.issues[0]?.message}`);
  return parsed.data as DepthResponse;
}

export async function fetchCandles(
  symbol: string,
  interval: IntervalId,
  limit = HISTORY_LIMIT,
  signal?: AbortSignal,
): Promise<CandlesResponse> {
  const raw = await getJson(REST_ROUTES.candles, { symbol, interval, limit }, signal);
  const parsed = CandlesResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(`malformed candles response: ${parsed.error.issues[0]?.message}`);
  return parsed.data as CandlesResponse;
}
