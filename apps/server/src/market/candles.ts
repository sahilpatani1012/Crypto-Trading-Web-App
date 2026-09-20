/**
 * Folds a trade stream into OHLCV candles for one interval.
 *
 * Bucket boundaries are computed as `floor(ts / intervalMs) * intervalMs`, which
 * aligns every bucket to the Unix epoch rather than to whenever this process
 * started. That matters: epoch-aligned buckets mean a 1m candle always starts on
 * the minute, two servers agree on boundaries without coordinating, and a restart
 * does not shift the grid and break chart alignment.
 *
 * Volume is an integer sum of trade quantities (D-004). Accumulating a few hundred
 * binary fractions per candle is exactly the scale at which float error becomes
 * visible in digits a human is reading.
 */

import {
  asQty,
  asTick,
  bucketStart,
  type Candle,
  type MinorQty,
  type TickPrice,
  type Trade,
} from '@cta/protocol';

/**
 * Safety cap on how many empty buckets `rollTo` will synthesise in one call.
 *
 * With ~8 trades/second an empty 1s bucket is a roughly 0.03% event and longer
 * intervals essentially never gap. The cap exists for the pathological case — a
 * laptop resuming from sleep, or a warmup called with an absurd duration — where
 * without it we would allocate one candle per interval for the whole gap.
 */
const MAX_EMPTY_ROLL = 5_000;

export class CandleAggregator {
  private current: Candle | null = null;
  private readonly history: Candle[] = [];

  constructor(
    readonly intervalMs: number,
    private readonly historyLimit: number,
  ) {}

  /**
   * Fold a trade in, returning any candles that closed as a result.
   *
   * Trades arrive in timestamp order from the engine, so an out-of-order trade
   * would indicate a bug rather than a network reordering — but it is ignored
   * rather than trusted, because silently corrupting a sealed candle is far worse
   * than dropping one trade.
   */
  applyTrade(trade: Trade): Candle[] {
    const bucket = bucketStart(trade.ts, this.intervalMs);

    if (this.current === null) {
      this.current = openCandle(bucket, trade.p);
      this.fold(trade);
      return [];
    }

    if (bucket < this.current.t) return [];

    let closed: Candle[] = [];
    if (bucket > this.current.t) {
      closed = this.rollTo(trade.ts);
    }

    this.fold(trade);
    return closed;
  }

  /**
   * Advance the clock without a trade, sealing every bucket that is now in the
   * past and returning them.
   *
   * A bucket with no trades still gets a candle — flat at the previous close, with
   * zero volume. That is the standard representation, and the alternative would
   * leave visible holes in the chart. Note this is not inventing market activity:
   * the candle honestly reports that nothing traded.
   */
  rollTo(now: number): Candle[] {
    if (this.current === null) return [];

    const nowBucket = bucketStart(now, this.intervalMs);
    const closed: Candle[] = [];
    let guard = 0;

    while (this.current.t < nowBucket && guard < MAX_EMPTY_ROLL) {
      guard += 1;
      const sealed = this.current;
      closed.push(sealed);
      this.push(sealed);
      this.current = openCandle(sealed.t + this.intervalMs, sealed.c);
    }

    // Only reachable via the guard, and only for an absurd gap. Snapping forward
    // beats emitting thousands of synthetic bars.
    if (this.current.t < nowBucket) {
      this.current = openCandle(nowBucket, this.current.c);
    }

    return closed;
  }

  getCurrent(): Candle | null {
    return this.current === null ? null : { ...this.current };
  }

  /**
   * Closed history plus the still-forming candle, oldest first.
   *
   * The open candle is included because a chart needs it to render the rightmost
   * bar; the live WebSocket feed then keeps updating that same bucket. The client
   * merges by timestamp, so the overlap is harmless and means the chart is never
   * missing its most recent bar between the REST response and the first live frame.
   */
  getCandles(limit: number): Candle[] {
    if (limit <= 0) return [];
    if (this.current === null) return this.history.slice(-limit).map((c) => ({ ...c }));
    // Guarded because `slice(-0)` is `slice(0)`, which returns the whole array
    // rather than nothing — so asking for one candle would return all of them.
    if (limit === 1) return [{ ...this.current }];

    const out = this.history.slice(-(limit - 1)).map((c) => ({ ...c }));
    out.push({ ...this.current });
    return out;
  }

  historySize(): number {
    return this.history.length;
  }

  private fold(trade: Trade): void {
    const candle = this.current;
    if (candle === null) return;

    // A bucket that has seen no trades is flat at the previous close, so its open
    // is a placeholder. The first real trade defines the bar properly.
    if (candle.n === 0) {
      candle.o = trade.p;
      candle.h = trade.p;
      candle.l = trade.p;
    } else {
      if (trade.p > candle.h) candle.h = trade.p;
      if (trade.p < candle.l) candle.l = trade.p;
    }

    candle.c = trade.p;
    candle.v = asQty(candle.v + trade.q);
    candle.n += 1;
  }

  private push(candle: Candle): void {
    this.history.push(candle);
    // Bounded memory: this is a simulation, not an archive. A real deployment
    // would page older candles out to a time-series store instead.
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }
}

function openCandle(t: number, price: TickPrice): Candle {
  return {
    t,
    o: price,
    h: price,
    l: price,
    c: price,
    v: asQty(0) as MinorQty,
    n: 0,
  };
}

/**
 * Recompute a candle from raw trades.
 *
 * This is the independent reference the tests check the aggregator against: if the
 * incremental fold and this straightforward recomputation ever disagree, one of
 * them is wrong. It is also what proves the claim that candles are identical at
 * every delivery tier — the same trades are reduced here and compared with what a
 * throttled client actually received.
 */
export function candleFromTrades(t: number, trades: readonly Trade[]): Candle | null {
  if (trades.length === 0) return null;

  const first = trades[0];
  if (first === undefined) return null;

  let high = first.p;
  let low = first.p;
  let volume = 0;

  for (const trade of trades) {
    if (trade.p > high) high = trade.p;
    if (trade.p < low) low = trade.p;
    volume += trade.q;
  }

  const last = trades[trades.length - 1];
  return {
    t,
    o: first.p,
    h: asTick(high),
    l: asTick(low),
    c: last === undefined ? first.p : last.p,
    v: asQty(volume),
    n: trades.length,
  };
}
