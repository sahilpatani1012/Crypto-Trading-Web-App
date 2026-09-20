/**
 * Server runtime configuration, read from the environment exactly once.
 *
 * Everything the deployment needs to vary lives here; everything that is a design
 * constant lives in @cta/protocol. The split matters: a reviewer changing PORT
 * should not have to wonder whether they are also changing a tier threshold.
 */

import { DEFAULT_SEED } from '@cta/protocol';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const serverConfig = {
  /** Render injects PORT; locally we default to 4000. */
  port: int('PORT', 4000),

  /** Bind to all interfaces so the container is reachable. */
  host: process.env.HOST ?? '0.0.0.0',

  /**
   * Seed for the market simulation. Fixing this makes the generated price path
   * reproducible across runs, which is what "repeatable enough to demonstrate and
   * test important cases" asks for (D-012).
   */
  seed: int('MARKET_SEED', DEFAULT_SEED),

  /**
   * Allowed browser origins. The deployed frontend lives on a different host from
   * the backend, so this cannot be left at its default.
   * `*` is accepted for local convenience and echoed back explicitly.
   */
  corsOrigins: list('CORS_ORIGINS', ['*']),

  /** Set to 'production' by Render. Only affects log verbosity. */
  env: process.env.NODE_ENV ?? 'development',
} as const;

export type ServerConfig = typeof serverConfig;
