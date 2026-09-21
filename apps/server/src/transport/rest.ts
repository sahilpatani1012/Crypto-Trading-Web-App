/**
 * REST routes.
 *
 * Three read-only snapshot endpoints plus a health check. Everything that changes
 * continuously lives on the WebSocket; REST exists to give a client a trustworthy
 * starting point it can then reconcile deltas against.
 *
 * `/api/depth` is the important one. Its `lastUpdateId` is the contract that makes
 * order-book reconciliation possible at all: it tells the client which sequence
 * number this snapshot already reflects, so the client knows which buffered deltas
 * to discard and exactly which sequence the next one must start at.
 */

import type { FastifyInstance } from 'fastify';
import {
  HISTORY_LIMIT,
  REST_ROUTES,
  CandlesQuerySchema,
  DepthQuerySchema,
  isIntervalId,
  type ApiError,
  type CandlesResponse,
  type DepthResponse,
  type HealthResponse,
  type SymbolResponse,
} from '@cta/protocol';

import type { MarketEngine } from '../market/engine';

export interface RestDeps {
  engine: MarketEngine;
  startedAt: number;
  connectionCount: () => number;
}

function badRequest(message: string): ApiError {
  return { error: 'bad_request', message };
}

export function registerRestRoutes(app: FastifyInstance, deps: RestDeps): void {
  const { engine, startedAt, connectionCount } = deps;

  /**
   * Render polls this to decide whether a deploy succeeded and whether the
   * instance is still alive. It also reports the seed, which makes it trivial to
   * confirm that a deployed instance is running the market you expect.
   */
  app.get(REST_ROUTES.health, async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      uptimeMs: Date.now() - startedAt,
      connections: connectionCount(),
      seed: engine.seed,
    };
  });

  /**
   * Scales and intervals. The client cannot render a price without these, since
   * every price on the wire is an integer tick count.
   */
  app.get(REST_ROUTES.symbol, async (): Promise<SymbolResponse> => {
    return engine.symbolInfo();
  });

  app.get(REST_ROUTES.depth, async (request, reply) => {
    const parsed = DepthQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(badRequest(parsed.error.issues[0]?.message ?? 'invalid query'));
    }

    const { symbol, limit } = parsed.data;
    if (symbol !== undefined && symbol !== engine.symbol) {
      return reply.code(404).send(badRequest(`unknown symbol ${symbol}`));
    }

    // Defaults to the COMPLETE book, not the display depth. The delta stream covers
    // every level, so a client reconciling against a truncated snapshot would be
    // missing levels that later deltas assume exist — and its contiguity check
    // cannot detect that, because the sequence numbers line up perfectly.
    const snapshot: DepthResponse = engine.snapshot(limit);
    return reply.send(snapshot);
  });

  app.get(REST_ROUTES.candles, async (request, reply) => {
    const parsed = CandlesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(badRequest(parsed.error.issues[0]?.message ?? 'invalid query'));
    }

    const { symbol, interval, limit } = parsed.data;
    if (symbol !== undefined && symbol !== engine.symbol) {
      return reply.code(404).send(badRequest(`unknown symbol ${symbol}`));
    }

    // Rejected rather than silently defaulted. A client asking for an interval we
    // do not serve has a bug, and quietly returning 1s candles labelled as
    // something else would hide it behind a chart that looks plausible.
    if (interval !== undefined && !isIntervalId(interval)) {
      return reply.code(400).send(badRequest(`unknown interval ${interval}`));
    }

    const resolved = interval ?? '1s';
    const response: CandlesResponse = {
      symbol: engine.symbol,
      interval: resolved,
      candles: engine.candles(resolved, limit ?? HISTORY_LIMIT),
    };
    return reply.send(response);
  });
}
