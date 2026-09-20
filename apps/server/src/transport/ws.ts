/**
 * The WebSocket server.
 *
 * Shares the same HTTP server as the REST routes. A WebSocket connection does not
 * begin life as a WebSocket — it begins as an ordinary HTTP GET carrying
 * `Upgrade: websocket`. The server answers `101 Switching Protocols`, and from
 * that point the same TCP connection stops speaking HTTP and starts carrying
 * WebSocket frames. Hooking the server's `upgrade` event is what lets one port and
 * one process serve both, which is what makes this deployable as a single Render
 * service.
 *
 * ## Origin checking, because CORS does not apply here
 *
 * This is the part people get wrong. Browsers do not enforce the same-origin
 * policy on WebSocket connections: `new WebSocket('wss://anything')` succeeds from
 * any page, and no preflight happens. CORS headers on the HTTP side do nothing for
 * the socket. So the server has to read the `Origin` header and decide for itself,
 * or any website on the internet can open a socket to this backend.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { TIERS, parseClientFrame, type Tier } from '@cta/protocol';
import { ClientSession, type SocketLike } from '../delivery/session';
import type { Clock } from '../market/clock';
import type { MarketEngine } from '../market/engine';

export interface WsServerOptions {
  server: HttpServer;
  engine: MarketEngine;
  clock: Clock;
  path: string;
  /** `['*']` allows any origin, which is the local-development default. */
  allowedOrigins: string[];
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * How often to send a protocol-level ping, and the window a client has to answer.
 *
 * This is a different mechanism from the application `ping` frame the client sends
 * to measure round-trip time. That one exists to produce a latency number; this one
 * exists to notice that a connection is dead.
 *
 * It is needed because a TCP connection can be half-open: the peer vanished — a
 * laptop lid closed, a phone lost signal — without ever sending a FIN. The socket
 * still reports itself as open and will sit there forever. The only way to find out
 * is to send something and see whether anything comes back.
 */
const HEARTBEAT_MS = 30_000;

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
  sessionId?: string;
}

export interface WsServer {
  connectionCount(): number;
  sessions(): ReturnType<ClientSession['stats']>[];
  close(): Promise<void>;
}

export function createWebSocketServer(options: WsServerOptions): WsServer {
  const { server, engine, clock, path, allowedOrigins } = options;
  const log = options.log ?? (() => {});

  // `noServer` because we drive the upgrade ourselves: the origin check has to
  // happen before the handshake completes, and rejecting afterwards would mean
  // accepting a connection we intended to refuse.
  const wss = new WebSocketServer({ noServer: true, clientTracking: true });
  const sessions = new Map<string, ClientSession>();

  function originAllowed(origin: string | undefined): boolean {
    if (allowedOrigins.includes('*')) return true;
    // A missing Origin means a non-browser client — curl, a test, another server.
    // Those are not subject to the browser's rules anyway, and rejecting them
    // would break the health checks and local tooling.
    if (origin === undefined) return true;
    return allowedOrigins.includes(origin);
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!originAllowed(request.headers.origin)) {
      log('rejected upgrade: origin not allowed', { origin: request.headers.origin });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // `?tier=degraded` pins a tier from the moment the socket opens, so a demo can
    // be scripted without clicking anything (D-013). S3 consumes it.
    const requested = url.searchParams.get('tier');
    const forcedTier: Tier | null =
      requested !== null && (TIERS as readonly string[]).includes(requested)
        ? (requested as Tier)
        : null;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, forcedTier);
    });
  }

  server.on('upgrade', handleUpgrade);

  wss.on('connection', (ws: TrackedSocket, _request: IncomingMessage, forcedTier: Tier | null) => {
    const id = randomUUID().slice(0, 8);
    ws.isAlive = true;
    ws.sessionId = id;

    const session = new ClientSession({
      id,
      socket: toSocketLike(ws),
      engine,
      clock,
      forcedTier,
      log,
    });
    sessions.set(id, session);
    log('session opened', { id, connections: sessions.size, forcedTier });

    session.greet();

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      // Every inbound frame goes through the shared zod schema before any logic
      // sees it. A malformed frame on a public socket is an expected condition,
      // not an exception — the client is told and the connection survives.
      const result = parseClientFrame(raw.toString());
      if (!result.ok) {
        session.rejectFrame(result.reason);
        return;
      }

      try {
        session.handleFrame(result.frame);
      } catch (error) {
        log('frame handler threw', {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
        session.rejectFrame('internal error handling frame');
      }
    });

    const dispose = () => {
      session.close();
      sessions.delete(id);
      log('session removed', { id, connections: sessions.size });
    };

    ws.on('close', dispose);
    ws.on('error', (error) => {
      log('socket error', { id, error: error.message });
      dispose();
    });
  });

  /**
   * Liveness sweep. Any client that did not answer the previous ping is presumed
   * gone and terminated, which releases its session and its engine listeners.
   * `terminate` rather than `close` because a peer that is not responding will not
   * complete a closing handshake either.
   */
  const heartbeat = setInterval(() => {
    for (const client of wss.clients as Set<TrackedSocket>) {
      if (client.isAlive === false) {
        log('terminating unresponsive socket', { id: client.sessionId });
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);

  // Keeping the process alive purely to run a heartbeat would stop it exiting
  // cleanly when nothing else is pending.
  heartbeat.unref();

  return {
    connectionCount: () => sessions.size,
    sessions: () => [...sessions.values()].map((s) => s.stats()),
    async close() {
      clearInterval(heartbeat);
      server.off('upgrade', handleUpgrade);
      for (const session of sessions.values()) session.close();
      sessions.clear();
      for (const client of wss.clients) client.close(1001, 'server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * Adapt a `ws` socket to the narrow interface the session depends on.
 *
 * The session only needs four members, and keeping it to those means it can be
 * unit-tested against a plain object that records sends — no real socket, no HTTP
 * server, no open port. That pays off in S3, where the tests assert precisely which
 * frames left at which times.
 */
function toSocketLike(ws: WebSocket): SocketLike {
  return {
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    get isOpen() {
      return ws.readyState === ws.OPEN;
    },
  };
}
