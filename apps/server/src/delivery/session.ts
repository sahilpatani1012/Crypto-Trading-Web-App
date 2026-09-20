/**
 * One connected client.
 *
 * Owns everything that belongs to a single socket: its subscription, its engine
 * listeners, and — from S3 — its delivery tier and scheduler. The transport layer
 * hands it already-validated frames; it never sees raw bytes, and it never touches
 * the `ws` library.
 *
 * In this slice the session forwards every engine event immediately. S3 inserts a
 * coalescing scheduler between the engine and `send`, which is the only change
 * needed to make delivery adaptive — the subscription and lifecycle logic here
 * stays exactly as it is.
 */

import {
  DEFAULT_INTERVAL,
  INTERVALS,
  PRICE_SCALE,
  QTY_SCALE,
  TICK_SIZE,
  TIER_PERIOD_MS,
  TIER_TARGET_HZ,
  encodeFrame,
  isIntervalId,
  type ClientFrame,
  type IntervalId,
  type ServerFrame,
  type Tier,
} from '@cta/protocol';

import type { Clock } from '../market/clock';
import type { MarketEngine } from '../market/engine';

/**
 * The slice of a WebSocket this session actually needs.
 *
 * Narrowing it to four members means the session can be unit-tested with a plain
 * object that records what was sent, with no `ws` instance, no HTTP server and no
 * open port. That matters a lot in S3, where the tests have to assert exactly which
 * frames came out at which times.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  /** Bytes queued but not yet flushed to the network. Used for backpressure. */
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
}

export interface SessionOptions {
  id: string;
  socket: SocketLike;
  engine: MarketEngine;
  clock: Clock;
  /** Applied at connect time from a `?tier=` query parameter, for scripted demos. */
  forcedTier?: Tier | null;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export class ClientSession {
  readonly id: string;

  private readonly socket: SocketLike;
  private readonly engine: MarketEngine;
  private readonly clock: Clock;
  private readonly log: (message: string, detail?: Record<string, unknown>) => void;

  private interval: IntervalId = DEFAULT_INTERVAL;
  private subscribed = false;
  private closed = false;

  /**
   * Teardown callbacks for every engine listener this session registered.
   *
   * Without this a disconnected client keeps its listeners alive: the engine goes
   * on invoking them, serialising frames for a socket nobody is reading, and the
   * closure keeps the whole session object out of reach of the garbage collector.
   * It does not fail loudly — it just gets slower and fatter over hours.
   */
  private teardown: Array<() => void> = [];

  /** Counters surfaced by /health, useful when demonstrating behaviour live. */
  private framesSent = 0;
  private malformedFrames = 0;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.socket = options.socket;
    this.engine = options.engine;
    this.clock = options.clock;
    this.log = options.log ?? (() => {});
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Sent the moment the socket opens, before any subscription.
   *
   * The client cannot render a single price without knowing the scales — every
   * price on the wire is an integer tick count, and turning 6543210 into
   * "$65,432.10" needs `priceScale`. Pushing it rather than making the client
   * fetch it removes a round trip from the critical path.
   */
  greet(): void {
    this.send({
      t: 'hello',
      symbol: this.engine.symbol,
      priceScale: PRICE_SCALE,
      qtyScale: QTY_SCALE,
      tickSize: TICK_SIZE,
      intervals: Object.keys(INTERVALS),
      serverTime: this.clock.now(),
    });
  }

  handleFrame(frame: ClientFrame): void {
    if (this.closed) return;

    switch (frame.t) {
      case 'subscribe':
        this.onSubscribe(frame.symbol, frame.interval);
        break;

      case 'ping':
        // Answered inline and immediately. Anything else would measure our own
        // scheduling delay rather than the network's round trip.
        this.send({
          t: 'pong',
          id: frame.id,
          clientTime: frame.clientTime,
          serverTime: this.clock.now(),
        });
        break;

      case 'netreport':
        // S3 feeds this to the tier controller. Accepted and ignored for now so
        // the client can be built against the real protocol.
        break;

      case 'setTier':
      case 'debug':
        // S3.
        break;
    }
  }

  /** Called when the transport sees a frame that failed schema validation. */
  rejectFrame(reason: string): void {
    this.malformedFrames += 1;
    this.send({ t: 'error', code: 'bad_frame', message: reason });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const off of this.teardown) off();
    this.teardown = [];

    this.log('session closed', {
      id: this.id,
      framesSent: this.framesSent,
      malformedFrames: this.malformedFrames,
    });
  }

  stats(): { id: string; interval: IntervalId; framesSent: number; malformedFrames: number } {
    return {
      id: this.id,
      interval: this.interval,
      framesSent: this.framesSent,
      malformedFrames: this.malformedFrames,
    };
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  private onSubscribe(symbol: string, interval: string): void {
    if (symbol !== this.engine.symbol) {
      this.send({ t: 'error', code: 'unknown_symbol', message: `unknown symbol ${symbol}` });
      return;
    }
    if (!isIntervalId(interval)) {
      this.send({ t: 'error', code: 'bad_interval', message: `unknown interval ${interval}` });
      return;
    }

    this.interval = interval;

    // Re-subscribing is how the client changes interval, and how it recovers after
    // a reconnect. Tearing the old listeners down first keeps that idempotent —
    // otherwise a client that switched interval three times would receive four
    // copies of every trade.
    if (this.subscribed) {
      for (const off of this.teardown) off();
      this.teardown = [];
    }

    this.teardown = [
      this.engine.events.on('trade', (trade) => {
        this.send({ t: 'trades', symbol: this.engine.symbol, trades: [trade], dropped: 0 });
      }),
      this.engine.events.on('book', (delta) => {
        this.send({ t: 'book', symbol: this.engine.symbol, delta });
      }),
      this.engine.events.on('candle', (event) => {
        if (event.interval !== this.interval) return;
        this.send({
          t: 'candle',
          symbol: this.engine.symbol,
          interval: event.interval,
          candle: event.candle,
          closed: event.closed,
        });
      }),
    ];

    this.subscribed = true;
    this.send({ t: 'subscribed', symbol: this.engine.symbol, interval });

    // Seed the chart's live bar straight away rather than making it wait for the
    // next trade — at the 1m interval that could be most of a minute.
    const current = this.engine.currentCandle(interval);
    if (current !== null) {
      this.send({
        t: 'candle',
        symbol: this.engine.symbol,
        interval,
        candle: current,
        closed: false,
      });
    }

    // The tier frame is stubbed at `full` in this slice so the client can render
    // the indicator; S3 replaces this with real state-machine output.
    this.send({
      t: 'tier',
      active: 'full',
      auto: 'full',
      forced: false,
      targetHz: TIER_TARGET_HZ.full,
      periodMs: TIER_PERIOD_MS.full,
      score: 0,
      latencyMs: 0,
      jitterMs: 0,
      reason: 'initial',
    });
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private send(frame: ServerFrame): void {
    if (this.closed || !this.socket.isOpen) return;
    try {
      this.socket.send(encodeFrame(frame));
      this.framesSent += 1;
    } catch (error) {
      // A socket can be torn down between the isOpen check and the write. That is
      // an ordinary race on a network server, not an exceptional condition, so the
      // session is closed rather than allowed to throw into the engine's emit loop
      // — where it would abort delivery to every other client.
      this.log('send failed, closing session', {
        id: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.close();
    }
  }
}
