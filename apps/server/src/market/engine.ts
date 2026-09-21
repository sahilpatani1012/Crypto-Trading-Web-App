/**
 * The market simulation.
 *
 * Owns the price path, the order book, and one candle aggregator per interval, and
 * emits domain events as they happen. It knows nothing about HTTP, WebSockets,
 * clients, or delivery tiers — the dependency direction is
 * `transport -> delivery -> market`, and this is the far end of it.
 *
 * That isolation is not tidiness for its own sake. It is what makes the whole
 * simulation testable with a virtual clock and no mocks, and it is what lets the
 * delivery layer slow a client down without any risk of affecting the data the
 * engine produces (D-009).
 */

import {
  DEFAULT_SEED,
  ENGINE_TICK_MS,
  HISTORY_LIMIT,
  INITIAL_PRICE,
  INTERVALS,
  PRICE_SCALE,
  QTY_SCALE,
  SYMBOL,
  TICK_SIZE,
  TRADES_PER_SECOND,
  asQty,
  type BookDelta,
  type Candle,
  type DepthSnapshot,
  type IntervalId,
  type SymbolInfo,
  type TickPrice,
  type Trade,
  type TradeSide,
} from '@cta/protocol';

import { CandleAggregator } from './candles';
import { SystemClock, type Clock } from './clock';
import { Emitter } from './emitter';
import { DEFAULT_BOOK_OPTIONS, OrderBook, type OrderBookOptions } from './order-book';
import { DEFAULT_PRICE_OPTIONS, PriceProcess, type PriceProcessOptions } from './price-process';
import { Rng } from './rng';

export interface CandleEvent {
  interval: IntervalId;
  candle: Candle;
  /**
   * True for the final state of a bucket that will never change again.
   *
   * The delivery layer treats these specially: a close is flushed immediately,
   * bypassing the tier cadence, so every client records the true close no matter
   * how slowly it is being served (D-009).
   */
  closed: boolean;
}

export type MarketEvents = {
  trade: Trade;
  book: BookDelta;
  candle: CandleEvent;
};

export interface MarketEngineOptions {
  symbol?: string;
  seed?: number;
  clock?: Clock;
  tickMs?: number;
  tradesPerSecond?: number;
  historyLimit?: number;
  recentTradesLimit?: number;
  /** Median trade size in minor units. 2_000_000 = 0.02 BTC. */
  medianTradeQty?: number;
  price?: Partial<PriceProcessOptions>;
  book?: Partial<OrderBookOptions>;
}

/**
 * Ceiling on ticks replayed in one `advanceTo` call, at 50 ms per tick — ten
 * seconds of catch-up.
 *
 * A laptop resuming from sleep, or a process starved for a while, would otherwise
 * try to replay every missed tick at once and block the event loop for however
 * long it was away. Past this point we jump the clock forward instead: a gap in
 * the simulation is far better than a frozen server.
 */
const MAX_CATCHUP_TICKS = 200;

export class MarketEngine {
  readonly events = new Emitter<MarketEvents>();
  readonly symbol: string;
  readonly seed: number;

  private readonly rng: Rng;
  private readonly clock: Clock;
  private readonly priceProcess: PriceProcess;
  private readonly book: OrderBook;
  private readonly aggregators = new Map<IntervalId, CandleAggregator>();
  private readonly recentTrades: Trade[] = [];

  private readonly tickMs: number;
  private readonly tradesPerSecond: number;
  private readonly recentTradesLimit: number;
  private readonly medianTradeQty: number;

  private nextTradeId = 1;
  private lastTickAt = 0;
  private started = false;
  private prevMid = 0;

  constructor(options: MarketEngineOptions = {}) {
    this.symbol = options.symbol ?? SYMBOL;
    this.seed = options.seed ?? DEFAULT_SEED;
    this.clock = options.clock ?? new SystemClock();
    this.tickMs = options.tickMs ?? ENGINE_TICK_MS;
    this.tradesPerSecond = options.tradesPerSecond ?? TRADES_PER_SECOND;
    this.recentTradesLimit = options.recentTradesLimit ?? 500;
    this.medianTradeQty = options.medianTradeQty ?? 2_000_000;

    this.rng = new Rng(this.seed);
    this.priceProcess = new PriceProcess(this.rng, {
      ...DEFAULT_PRICE_OPTIONS,
      initial: INITIAL_PRICE,
      ...options.price,
    });
    this.book = new OrderBook({ ...DEFAULT_BOOK_OPTIONS, ...options.book });
    this.prevMid = this.priceProcess.current();

    const historyLimit = options.historyLimit ?? HISTORY_LIMIT;
    for (const [id, ms] of Object.entries(INTERVALS)) {
      this.aggregators.set(id as IntervalId, new CandleAggregator(ms, historyLimit));
    }
  }

  // -------------------------------------------------------------------------
  // Driving the simulation
  // -------------------------------------------------------------------------

  /**
   * Generate history by running the live tick loop backwards from now.
   *
   * The alternative — a separate history generator — is the obvious approach and
   * the wrong one. Two code paths producing what is meant to be the same kind of
   * data will eventually disagree, and they disagree most visibly right at the
   * join, where the last historical candle meets the first live one. Running the
   * real loop means there is no join (D-012).
   *
   * Nothing is listening yet at startup, so the events emitted here are discarded
   * by the emitter's empty-listener fast path.
   */
  warmup(durationMs: number): void {
    const end = this.clock.now();
    const start = end - durationMs;
    const ticks = Math.max(0, Math.floor(durationMs / this.tickMs));

    for (let i = 1; i <= ticks; i += 1) {
      this.tick(start + i * this.tickMs);
    }

    this.lastTickAt = start + ticks * this.tickMs;
    this.started = true;
  }

  /**
   * Advance the simulation to `now`, running whole ticks.
   *
   * Driven by a `setInterval` in production and called directly with a virtual
   * clock in tests. Stepping in fixed increments rather than by elapsed time keeps
   * trade arrival rates stable regardless of how punctual the timer was.
   */
  advanceTo(now: number): void {
    if (!this.started) {
      this.lastTickAt = now - this.tickMs;
      this.started = true;
    }

    let ticks = 0;
    while (this.lastTickAt + this.tickMs <= now && ticks < MAX_CATCHUP_TICKS) {
      this.lastTickAt += this.tickMs;
      ticks += 1;
      this.tick(this.lastTickAt);
    }

    if (this.lastTickAt + this.tickMs <= now) {
      this.lastTickAt = now;
    }
  }

  /** Advance using the engine's own clock. This is what the server timer calls. */
  advance(): void {
    this.advanceTo(this.clock.now());
  }

  private tick(now: number): void {
    const mid = this.priceProcess.step();

    // Order matters: recenter prunes any level the new mid would have crossed, so
    // the no-cross invariant holds before any trade looks at the best prices.
    this.book.recenter(mid, this.rng);
    this.book.perturb(this.rng);

    const expected = this.tradesPerSecond * (this.tickMs / 1_000);
    const count = this.rng.poisson(expected);
    const touched = new Set<IntervalId>();

    for (let i = 0; i < count; i += 1) {
      const trade = this.makeTrade(now, mid);
      if (trade === null) continue;

      this.book.consume(trade.side, trade.p, trade.q);
      this.pushRecentTrade(trade);
      this.events.emit('trade', trade);

      for (const [interval, aggregator] of this.aggregators) {
        for (const candle of aggregator.applyTrade(trade)) {
          this.events.emit('candle', { interval, candle, closed: true });
        }
        touched.add(interval);
      }
    }

    // Seal buckets that ended without a trade. Without this a quiet period would
    // leave the previous candle marked open indefinitely, and the chart would
    // stop advancing even though time had.
    for (const [interval, aggregator] of this.aggregators) {
      for (const candle of aggregator.rollTo(now)) {
        this.events.emit('candle', { interval, candle, closed: true });
        touched.add(interval);
      }
    }

    // One live update per interval that actually changed. Emitting unconditionally
    // would manufacture chart updates during quiet periods, which the spec rules
    // out: a target rate is a ceiling, not a quota.
    for (const interval of touched) {
      const current = this.aggregators.get(interval)?.getCurrent();
      if (current) this.events.emit('candle', { interval, candle: current, closed: false });
    }

    const delta = this.book.commit();
    if (delta !== null) this.events.emit('book', delta);

    this.prevMid = mid;
  }

  /**
   * Build one trade against the resting book.
   *
   * A buy executes at the best ask and a sell at the best bid, because that is
   * what a market order does: it takes the other side's best resting price. Using
   * the mid instead would be simpler and wrong, and it would show — consecutive
   * prints would not bounce across the spread the way a real tape does.
   *
   * Side is biased toward the direction the mid just moved, so the tape is
   * coherent with the chart. Price rising because buyers are lifting offers is the
   * causality a reader expects.
   */
  private makeTrade(now: number, mid: TickPrice): Trade | null {
    const rising = mid > this.prevMid;
    const side: TradeSide = this.rng.bool(rising ? 0.62 : 0.38) ? 'buy' : 'sell';

    const price = side === 'buy' ? this.book.bestAsk() : this.book.bestBid();
    if (price === undefined) return null;

    const qty = Math.max(1, Math.round(this.rng.logNormal(this.medianTradeQty, 0.8)));

    return {
      id: this.nextTradeId++,
      ts: now,
      p: price,
      q: asQty(qty),
      side,
    };
  }

  private pushRecentTrade(trade: Trade): void {
    this.recentTrades.push(trade);
    if (this.recentTrades.length > this.recentTradesLimit) {
      this.recentTrades.splice(0, this.recentTrades.length - this.recentTradesLimit);
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Omit `limit` for a complete book; pass one only for a display-sized view. */
  snapshot(limit?: number): DepthSnapshot {
    return this.book.snapshot(this.symbol, this.clock.now(), limit);
  }

  bookSeq(): number {
    return this.book.currentSeq();
  }

  bestBid(): TickPrice | undefined {
    return this.book.bestBid();
  }

  bestAsk(): TickPrice | undefined {
    return this.book.bestAsk();
  }

  candles(interval: IntervalId, limit: number): Candle[] {
    return this.aggregators.get(interval)?.getCandles(limit) ?? [];
  }

  currentCandle(interval: IntervalId): Candle | null {
    return this.aggregators.get(interval)?.getCurrent() ?? null;
  }

  recent(limit: number): Trade[] {
    return this.recentTrades.slice(-limit).map((t) => ({ ...t }));
  }

  lastPrice(): TickPrice | null {
    const last = this.recentTrades[this.recentTrades.length - 1];
    return last?.p ?? null;
  }

  symbolInfo(): SymbolInfo {
    return {
      symbol: this.symbol,
      priceScale: PRICE_SCALE,
      qtyScale: QTY_SCALE,
      tickSize: TICK_SIZE,
      intervals: Object.keys(INTERVALS),
      serverTime: this.clock.now(),
    };
  }
}
