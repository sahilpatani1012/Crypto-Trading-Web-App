/**
 * The mid-price path: a mean-reverting random walk in integer ticks.
 *
 * Three requirements pull against each other:
 *
 *   1. It must look like a market. That rules out drawing a fresh uniform price
 *      each tick, which produces noise, not a chart.
 *   2. It must not run away. A pure random walk has no home: leave it for an hour
 *      and the price is as likely to be $500 as $200,000, and the chart is useless.
 *   3. It must stay in integers, because every price in this system is a tick
 *      count (D-004).
 *
 * The answer is an Ornstein-Uhlenbeck process — a random walk with a spring
 * attached. Each step is a normal shock plus a gentle pull toward an anchor. The
 * anchor itself drifts slowly toward the current price, so the market is free to
 * trend over minutes while never diverging far over seconds.
 */

import { asTick, type TickPrice } from '@cta/protocol';
import type { Rng } from './rng';

export interface PriceProcessOptions {
  /** Starting mid, in ticks. */
  initial: number;
  /**
   * Standard deviation of one step's shock, in ticks.
   *
   * At 60 ticks ($0.60) per 50 ms step, a random walk accumulates roughly
   * 60 * sqrt(20) ~= 270 ticks ($2.70) of movement per second and about $21 per
   * minute. That is plausible for BTC, gives a one-second candle a visible body
   * rather than a flat line, and — importantly — keeps the per-step movement well
   * inside the order book's price span, so the book is not invalidated wholesale
   * on every tick.
   */
  volatilityTicks: number;
  /**
   * How hard the price is pulled back toward the anchor each step, as a fraction
   * of the distance. Small: this is a leash, not a magnet. Too large and the price
   * would visibly snap back, which no market does.
   */
  meanReversion: number;
  /**
   * How fast the anchor follows the price, as a fraction of the distance. Much
   * smaller than `meanReversion`, so the anchor behaves like a slow moving average
   * and the price is free to trend away from it for a while.
   */
  anchorDrift: number;
  /** Hard floor, so a long unlucky run cannot reach zero or go negative. */
  minTicks: number;
}

export const DEFAULT_PRICE_OPTIONS: Omit<PriceProcessOptions, 'initial'> = {
  volatilityTicks: 60,
  meanReversion: 0.004,
  anchorDrift: 0.0025,
  minTicks: 1_000_00,
};

export class PriceProcess {
  private mid: number;
  private anchor: number;
  private readonly opts: PriceProcessOptions;

  constructor(
    private readonly rng: Rng,
    options: PriceProcessOptions,
  ) {
    this.opts = options;
    this.mid = Math.round(options.initial);
    this.anchor = this.mid;
  }

  /** Advance one step and return the new mid price. */
  step(): TickPrice {
    const { volatilityTicks, meanReversion, anchorDrift, minTicks } = this.opts;

    // The anchor chases the price slowly, which is what lets the market trend.
    this.anchor += (this.mid - this.anchor) * anchorDrift;

    const pull = (this.anchor - this.mid) * meanReversion;
    const shock = this.rng.normal() * volatilityTicks;

    // Round once, at the end: the process is conceptually continuous, but every
    // price that leaves this class is an integer tick count.
    this.mid = Math.max(minTicks, Math.round(this.mid + pull + shock));
    return asTick(this.mid);
  }

  current(): TickPrice {
    return asTick(this.mid);
  }
}
