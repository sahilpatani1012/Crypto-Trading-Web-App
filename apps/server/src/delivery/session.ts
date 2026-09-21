/**
 * One connected client.
 *
 * Owns everything belonging to a single socket: its subscription, its engine
 * listeners, its delivery tier, and its coalescing scheduler. The transport layer
 * hands it already-validated frames; it never sees raw bytes and never touches the
 * `ws` library.
 *
 * The shape of the pipeline:
 *
 *     engine events ──▶ DeliveryScheduler ──(every periodMs)──▶ socket
 *                              ▲
 *                              │ setPeriod()
 *                       TierController ◀── netreport frames
 *
 * The engine emits at its own pace and knows nothing about any of this. The
 * scheduler accumulates. The tier controller decides how often the scheduler fires.
 * That separation is what makes the correctness claim checkable: the market data is
 * produced identically regardless of who is connected or how fast they are being
 * served.
 */

import {
  DEFAULT_INTERVAL,
  INTERVALS,
  PRICE_SCALE,
  QTY_SCALE,
  TICK_SIZE,
  encodeFrame,
  isIntervalId,
  type ClientFrame,
  type IntervalId,
  type ServerFrame,
  type Tier,
} from '@cta/protocol';

import type { Clock } from '../market/clock';
import type { MarketEngine } from '../market/engine';
import { DeliveryScheduler, type FlushPayload } from './scheduler';
import { TierController, type TierChange } from './tier-controller';

/**
 * The slice of a WebSocket this session actually needs.
 *
 * Narrowing it to four members means the session can be unit-tested with a plain
 * object that records what was sent — no `ws` instance, no HTTP server, no open
 * port, no sleeps. That matters most here, where the tests have to assert exactly
 * which frames left and when.
 *
 * `bufferedAmount` is in the interface for production, not for tests: the scheduler
 * reads it to detect a client that has stopped draining.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
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
  private readonly tiers: TierController;

  private scheduler: DeliveryScheduler | null = null;
  private interval: IntervalId = DEFAULT_INTERVAL;
  private subscribed = false;
  private closed = false;

  /** Teardown callbacks for every engine listener this session registered. */
  private teardown: Array<() => void> = [];

  /**
   * Debug: skip the next book delta for this connection only, forcing a sequence
   * gap so recovery can be demonstrated without needing real packet loss (D-013).
   */
  private dropNextDelta = false;

  /**
   * Debug: suppress every outbound frame while leaving the socket open.
   *
   * This is the half-open connection, reproduced deliberately. Nothing at the TCP
   * or WebSocket layer indicates anything is wrong — only the client's application
   * heartbeat, which notices that no pong has come back, can detect it.
   */
  private stalled = false;

  private framesSent = 0;
  private malformedFrames = 0;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.socket = options.socket;
    this.engine = options.engine;
    this.clock = options.clock;
    this.log = options.log ?? (() => {});
    this.tiers = new TierController({
      clock: options.clock,
      forced: options.forcedTier ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Sent the moment the socket opens, before any subscription.
   *
   * The client cannot render a single price without the scales — every price on the
   * wire is an integer tick count. Pushing them rather than making the client fetch
   * them removes a round trip from the critical path.
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
    this.sendTier(this.tiers.state());
  }

  handleFrame(frame: ClientFrame): void {
    if (this.closed) return;

    switch (frame.t) {
      case 'subscribe':
        this.onSubscribe(frame.symbol, frame.interval);
        break;

      case 'ping':
        // Answered inline and immediately. Queueing it behind the scheduler would
        // measure our own delivery cadence rather than the network's round trip —
        // at minimal tier that would add up to a second of phantom latency and the
        // client would report itself into an even slower tier. A measurement path
        // must never run through the thing it is measuring.
        this.send({
          t: 'pong',
          id: frame.id,
          clientTime: frame.clientTime,
          serverTime: this.clock.now(),
        });
        break;

      case 'netreport':
        this.applyTierChange(
          this.tiers.onReport({
            latencyMs: frame.latencyMs,
            jitterMs: frame.jitterMs,
            samples: frame.samples,
          }),
          // Always echo on a report, even when the tier held: the UI shows live
          // latency, jitter and score, and those move on every report.
          true,
        );
        break;

      case 'setTier':
        this.applyTierChange(this.tiers.setForced(frame.tier), true);
        this.log('tier override', { id: this.id, tier: frame.tier });
        break;

      case 'debug':
        if (frame.action === 'dropDelta') this.armDeltaDrop();
        else if (frame.action === 'disconnect') this.debugDisconnect();
        else if (frame.action === 'stall') this.debugStall();
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
    this.scheduler?.stop();
    this.scheduler = null;

    // Close the socket too. When the session closes itself — a failed send — the
    // transport's 'close' handler is what removes it from the connection registry,
    // and that only fires if the socket actually closes. Without this the entry
    // leaks and /health over-reports connections.
    try {
      this.socket.close();
    } catch {
      /* Already closing. */
    }

    this.log('session closed', {
      id: this.id,
      framesSent: this.framesSent,
      malformedFrames: this.malformedFrames,
    });
  }

  stats() {
    return {
      id: this.id,
      interval: this.interval,
      framesSent: this.framesSent,
      malformedFrames: this.malformedFrames,
      tier: this.tiers.state(),
      scheduler: this.scheduler?.stats() ?? { flushes: 0, backpressureSkips: 0 },
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

    // Re-subscribing is how a client changes interval and how it recovers after a
    // reconnect. Tearing the old listeners down first keeps that idempotent —
    // otherwise a client that switched interval three times would receive four
    // copies of every trade.
    for (const off of this.teardown) off();
    this.teardown = [];

    if (this.scheduler === null) {
      this.scheduler = new DeliveryScheduler({
        periodMs: this.tiers.periodMs(),
        onTick: () => this.onSchedulerTick(),
        onFlush: (payload) => this.onFlush(payload),
        bufferedBytes: () => this.socket.bufferedAmount,
      });
    }

    this.teardown = [
      this.engine.events.on('trade', (trade) => this.scheduler?.queueTrade(trade)),
      this.engine.events.on('book', (delta) => {
        if (this.dropNextDelta) {
          this.dropNextDelta = false;
          this.log('debug: dropped book delta', { id: this.id, seq: delta.fromSeq });
          return;
        }
        this.scheduler?.queueBookDelta(delta);
      }),
      this.engine.events.on('candle', (event) => {
        if (event.interval !== this.interval) return;
        this.scheduler?.queueCandle(event.candle, event.interval, event.closed);
      }),
    ];

    this.subscribed = true;
    this.send({ t: 'subscribed', symbol: this.engine.symbol, interval });

    // Seed the chart's live bar immediately rather than making it wait for the next
    // trade — at the 1m interval that could be most of a minute of blank chart.
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

    this.sendTier(this.tiers.state());
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /**
   * Runs once per scheduler period, before the flush.
   *
   * Piggybacking the missing-report check on the delivery timer avoids a second
   * timer per connection. It is checked at least once a second even at minimal
   * tier, which is far more often than the twelve-second timeout needs.
   */
  private onSchedulerTick(): void {
    const change = this.tiers.onTick();
    if (change !== null) this.applyTierChange(change, false);
  }

  private onFlush(payload: FlushPayload): void {
    const symbol = this.engine.symbol;

    for (const pending of payload.candles) {
      this.send({
        t: 'candle',
        symbol,
        interval: pending.interval,
        candle: pending.candle,
        closed: pending.closed,
      });
    }

    if (payload.trades.length > 0 || payload.droppedTrades > 0) {
      this.send({
        t: 'trades',
        symbol,
        trades: payload.trades,
        dropped: payload.droppedTrades,
      });
    }

    if (payload.book !== null) {
      this.send({ t: 'book', symbol, delta: payload.book });
    }
  }

  /**
   * Apply a tier decision: retime the scheduler if the tier moved, and tell the
   * client either way when asked to.
   */
  private applyTierChange(change: TierChange, alwaysEcho: boolean): void {
    if (change.changed) {
      this.scheduler?.setPeriod(change.periodMs);
      this.log('tier changed', {
        id: this.id,
        active: change.active,
        auto: change.auto,
        forced: change.forced,
        score: change.score,
        reason: change.reason,
      });
    }
    if (change.changed || alwaysEcho) this.sendTier(change);
  }

  /**
   * Force a sequence gap on this connection only.
   *
   * The pending accumulation is flushed *first*. Without that, the dropped delta
   * would be swallowed by coalescing: a pending range of [104, 104] plus a skipped
   * 105 plus an incoming 106 merges to [104, 106], which looks perfectly contiguous
   * to the client while silently missing 105's changes. Flushing first closes the
   * range at 104, so the next frame starts at 106 and the client's contiguity check
   * fires exactly as it should.
   */
  private armDeltaDrop(): void {
    this.scheduler?.flush();
    this.dropNextDelta = true;
    this.log('debug: armed delta drop', { id: this.id });
  }

  /**
   * Debug: close this connection cleanly (D-013).
   *
   * Needed because there is no browser-side way to do it. Chrome DevTools' offline
   * emulation blocks new requests but leaves an established WebSocket flowing, so
   * "go offline" in DevTools does not exercise the reconnect path at all.
   */
  private debugDisconnect(): void {
    this.log('debug: closing connection on request', { id: this.id });
    this.close();
  }

  /** Debug: go silent without closing, so the client's heartbeat has to notice. */
  private debugStall(): void {
    this.log('debug: stalling connection on request', { id: this.id });
    this.stalled = true;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private sendTier(state: TierChange | ReturnType<TierController['state']>): void {
    this.send({
      t: 'tier',
      active: state.active,
      auto: state.auto,
      forced: state.forced,
      targetHz: state.targetHz,
      periodMs: state.periodMs,
      score: state.score,
      latencyMs: state.latencyMs,
      jitterMs: state.jitterMs,
      reason: state.reason,
    });
  }

  private send(frame: ServerFrame): void {
    if (this.closed || this.stalled || !this.socket.isOpen) return;
    try {
      this.socket.send(encodeFrame(frame));
      this.framesSent += 1;
    } catch (error) {
      // A socket can be torn down between the isOpen check and the write. That is
      // an ordinary race on a network server, not an exceptional condition, so the
      // session closes itself rather than letting the throw escape into the
      // engine's emit loop — where it would abort delivery to every other client.
      this.log('send failed, closing session', {
        id: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.close();
    }
  }
}
