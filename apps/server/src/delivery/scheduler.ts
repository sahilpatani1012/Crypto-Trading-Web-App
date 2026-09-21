/**
 * Per-connection coalescing scheduler.
 *
 * The engine produces events at its own pace — roughly twenty book updates and
 * eight trades a second. This class accumulates them and emits at whatever cadence
 * the connection's tier calls for: every 100 ms at `full`, 250 ms at `degraded`,
 * 1000 ms at `minimal`.
 *
 * ## Coalescing, never dropping
 *
 * Three kinds of pending state, accumulated three different ways, because they have
 * genuinely different semantics:
 *
 * - **Candle** — a single slot that is overwritten. Each update fully supersedes the
 *   previous one, so keeping a queue would be keeping garbage.
 * - **Trades** — a list. The tape needs every print; keeping only the newest would
 *   silently lose trades.
 * - **Book delta** — merged into a map keyed by price, last write wins, with the
 *   covered sequence range carried alongside.
 *
 * The book merge is only sound because a delta entry means *set this level to this
 * quantity*, never *add this much*. Under a replace semantic, keeping the last value
 * per price is exactly equivalent to applying every delta in order. Under an
 * additive one it would need to sum, and zero-quantity removals would break it
 * outright. That decision was made back in the order book, and this is where it pays
 * off (D-010).
 *
 * Carrying `fromSeq` and `toSeq` is what keeps the client's gap detection working:
 * it still asserts `fromSeq === lastSeq + 1`, it just does so across a wider range.
 *
 * ## The correctness guarantee (D-009)
 *
 * Two rules make "a slower tier delivers less often, but never wrongly" true by
 * construction rather than by care:
 *
 * 1. A candle frame is the **complete current OHLCV**, never a patch. Dropping an
 *    intermediate frame therefore costs the client a view of a state, not the state
 *    itself — the next frame carries the whole truth.
 * 2. A candle **close flushes immediately**, bypassing the cadence entirely. Without
 *    this, a minimal-tier client's last view of a closing bar could be up to a
 *    second stale at the moment it froze, permanently recording a close price that
 *    was never the close. This is the rule that stops the whole feature being a lie.
 */

import {
  BACKPRESSURE_BYTES,
  MAX_TRADES_PER_FRAME,
  type BookDelta,
  type Candle,
  type IntervalId,
  type Level,
  type MinorQty,
  type TickPrice,
  type Trade,
  asQty,
  asTick,
} from '@cta/protocol';

export interface FlushPayload {
  candle: { candle: Candle; interval: IntervalId; closed: boolean } | null;
  trades: Trade[];
  droppedTrades: number;
  book: BookDelta | null;
}

export interface SchedulerOptions {
  periodMs: number;
  /** Called once per period, before flushing. Used for missing-report checks. */
  onTick: () => void;
  /** Called with whatever accumulated. Never called with an empty payload. */
  onFlush: (payload: FlushPayload) => void;
  /** Bytes already queued on the socket. Used to skip a tick under backpressure. */
  bufferedBytes: () => number;
  maxTradesPerFrame?: number;
  backpressureBytes?: number;
}

export class DeliveryScheduler {
  private readonly opts: SchedulerOptions;
  private readonly maxTrades: number;
  private readonly backpressureLimit: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private periodMs: number;
  private stopped = false;

  private pendingCandle: { candle: Candle; interval: IntervalId; closed: boolean } | null = null;
  private pendingTrades: Trade[] = [];
  private droppedTrades = 0;
  private pendingBids = new Map<number, number>();
  private pendingAsks = new Map<number, number>();
  private bookFrom: number | null = null;
  private bookTo: number | null = null;

  private flushCount = 0;
  private skippedForBackpressure = 0;

  constructor(options: SchedulerOptions) {
    this.opts = options;
    this.periodMs = options.periodMs;
    this.maxTrades = options.maxTradesPerFrame ?? MAX_TRADES_PER_FRAME;
    this.backpressureLimit = options.backpressureBytes ?? BACKPRESSURE_BYTES;
    this.start();
  }

  // -------------------------------------------------------------------------
  // Queueing
  // -------------------------------------------------------------------------

  /**
   * A candle changed.
   *
   * `closed` is the important flag: it marks the final state of a bucket that will
   * never change again, and it bypasses the cadence. Everything else waits for the
   * timer.
   */
  queueCandle(candle: Candle, interval: IntervalId, closed: boolean): void {
    if (this.stopped) return;
    this.pendingCandle = { candle, interval, closed };
    if (closed) this.flush();
  }

  queueTrade(trade: Trade): void {
    if (this.stopped) return;
    this.pendingTrades.push(trade);

    // Bound the frame. Dropping the *oldest* rather than refusing the newest keeps
    // the tape continuous at its recent end, which is the end anyone is looking at.
    // The count is surfaced to the client rather than hidden, so the UI can say the
    // tape is incomplete instead of quietly pretending otherwise.
    if (this.pendingTrades.length > this.maxTrades) {
      const overflow = this.pendingTrades.length - this.maxTrades;
      this.pendingTrades.splice(0, overflow);
      this.droppedTrades += overflow;
    }
  }

  queueBookDelta(delta: BookDelta): void {
    if (this.stopped) return;
    if (this.bookFrom === null) this.bookFrom = delta.fromSeq;
    this.bookTo = delta.toSeq;

    for (const [price, qty] of delta.bids) this.pendingBids.set(price, qty);
    for (const [price, qty] of delta.asks) this.pendingAsks.set(price, qty);
  }

  // -------------------------------------------------------------------------
  // Timing
  // -------------------------------------------------------------------------

  /**
   * Change cadence, which happens whenever the tier changes.
   *
   * The pending accumulators are deliberately left alone. They hold market state
   * that has not been delivered yet, and a tier change is a statement about
   * bandwidth, not a reason to discard data.
   */
  setPeriod(periodMs: number): void {
    if (this.stopped || periodMs === this.periodMs) return;
    this.periodMs = periodMs;
    this.start();
  }

  currentPeriodMs(): number {
    return this.periodMs;
  }

  stats(): { flushes: number; backpressureSkips: number } {
    return { flushes: this.flushCount, backpressureSkips: this.skippedForBackpressure };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pendingCandle = null;
    this.pendingTrades = [];
    this.pendingBids.clear();
    this.pendingAsks.clear();
  }

  private start(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.periodMs);
    // A pending delivery timer should never be the reason a process stays alive.
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.stopped) return;
    this.opts.onTick();
    this.flush();
  }

  /**
   * Emit whatever accumulated, then clear it.
   *
   * Sends nothing when nothing accumulated. A target rate is a ceiling on delivery,
   * not a quota to fill — the spec is explicit that a tier must not cause market
   * events to be invented when none occurred.
   */
  flush(): void {
    if (this.stopped) return;
    if (!this.hasPending()) return;

    // If the socket has not drained, adding more frames only grows the backlog and
    // the client falls further behind. Skipping is the correct response; the pending
    // state stays accumulated and goes out on the next tick, coalesced further.
    if (this.opts.bufferedBytes() > this.backpressureLimit) {
      this.skippedForBackpressure += 1;
      return;
    }

    const payload: FlushPayload = {
      candle: this.pendingCandle,
      trades: this.pendingTrades,
      droppedTrades: this.droppedTrades,
      book: this.takeBookDelta(),
    };

    this.pendingCandle = null;
    this.pendingTrades = [];
    this.droppedTrades = 0;
    this.flushCount += 1;

    this.opts.onFlush(payload);
  }

  private hasPending(): boolean {
    return (
      this.pendingCandle !== null ||
      this.pendingTrades.length > 0 ||
      this.pendingBids.size > 0 ||
      this.pendingAsks.size > 0
    );
  }

  private takeBookDelta(): BookDelta | null {
    if (this.bookFrom === null || this.bookTo === null) return null;

    const delta: BookDelta = {
      fromSeq: this.bookFrom,
      toSeq: this.bookTo,
      bids: toLevels(this.pendingBids),
      asks: toLevels(this.pendingAsks),
    };

    this.pendingBids = new Map();
    this.pendingAsks = new Map();
    this.bookFrom = null;
    this.bookTo = null;

    return delta;
  }
}

function toLevels(map: ReadonlyMap<number, number>): Level[] {
  return [...map.entries()].map(([price, qty]) => [asTick(price), asQty(qty)] as [TickPrice, MinorQty]);
}
