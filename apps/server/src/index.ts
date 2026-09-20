/**
 * Server entry point.
 *
 * Boots the simulation, warms it up so history exists before anyone connects,
 * starts one HTTP server that serves both REST and WebSocket, and drives the
 * engine on a timer. Shuts all of it down cleanly on a signal.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';

import { ENGINE_TICK_MS, WARMUP_MS } from '@cta/protocol';
import { serverConfig } from './config';
import { MarketEngine } from './market/engine';
import { SystemClock } from './market/clock';
import { registerRestRoutes } from './transport/rest';
import { createWebSocketServer } from './transport/ws';

const WS_PATH = '/ws';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const clock = new SystemClock();

  const app = Fastify({
    logger: {
      level: serverConfig.env === 'production' ? 'info' : 'debug',
      transport:
        serverConfig.env === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
  });

  const log = (message: string, detail?: Record<string, unknown>) => {
    app.log.debug({ ...detail }, message);
  };

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  const engine = new MarketEngine({ seed: serverConfig.seed, clock });

  const warmupStart = Date.now();
  engine.warmup(WARMUP_MS);
  app.log.info(
    {
      seed: engine.seed,
      warmupMs: WARMUP_MS,
      tookMs: Date.now() - warmupStart,
      bars1s: engine.candles('1s', 10_000).length,
      bars1m: engine.candles('1m', 10_000).length,
    },
    'market warmed up',
  );

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  // CORS covers the REST endpoints only. It does nothing for the WebSocket
  // handshake, which browsers exempt from the same-origin policy entirely — that
  // is checked separately, by hand, in the upgrade handler.
  await app.register(cors, {
    origin: serverConfig.corsOrigins.includes('*') ? true : serverConfig.corsOrigins,
    methods: ['GET'],
  });

  const wsServer = createWebSocketServer({
    server: app.server,
    engine,
    clock,
    path: WS_PATH,
    allowedOrigins: [...serverConfig.corsOrigins],
    log,
  });

  registerRestRoutes(app, {
    engine,
    startedAt,
    connectionCount: () => wsServer.connectionCount(),
  });

  await app.listen({ port: serverConfig.port, host: serverConfig.host });
  app.log.info(
    { port: serverConfig.port, host: serverConfig.host, wsPath: WS_PATH },
    'listening (REST + WebSocket on one port)',
  );

  // -------------------------------------------------------------------------
  // The clock that drives everything
  // -------------------------------------------------------------------------

  // `advance` reads the wall clock and runs whole ticks up to it, so a late or
  // coalesced timer callback does not change how many trades get generated — it
  // only changes when they arrive. Timer drift therefore cannot skew the feed.
  const engineTimer = setInterval(() => {
    try {
      engine.advance();
    } catch (error) {
      app.log.error({ err: error }, 'engine tick failed');
    }
  }, ENGINE_TICK_MS);

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    // Render sends SIGTERM and then SIGKILL shortly after. A second signal while
    // the first is still unwinding must not start a second teardown.
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    clearInterval(engineTimer);
    // Sockets first: closing the HTTP server while connections are still open
    // would leave clients hanging until their own timeouts fire, which reads as a
    // crash rather than a deploy.
    await wsServer.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Logging and
  // continuing is worse than restarting: the platform knows how to restart.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });
}

main().catch((error) => {
  console.error('[fatal] failed to start', error);
  process.exit(1);
});
