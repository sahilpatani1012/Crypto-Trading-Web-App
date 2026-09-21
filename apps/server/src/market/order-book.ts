/**
 * The simulated order book.
 *
 * Two maps of price -> quantity, one per side, plus a monotonic sequence number
 * that increments once per emitted update. The client rebuilds this exact
 * structure from a REST snapshot plus the sequenced deltas this class emits.
 *
 * ## The invariant this class exists to protect
 *
 * `bestBid < bestAsk`, always. If the best bid ever rose to or above the best ask,
 * someone could buy from the ask and immediately sell to the bid for a guaranteed
 * profit — risk-free arbitrage. A real exchange makes this impossible by
 * construction: its matching engine executes any order that would cross instead of
 * resting it in the book.
 *
 * We have no matching engine — we place levels around a mid price — so nothing
 * structurally prevents a crossed book here. It is enforced explicitly instead:
 * every level strictly below the mid is a bid, every level strictly above it is an
 * ask, and `recenter` prunes anything that ends up on the wrong side when the mid
 * moves. A test asserts it after every tick, because a crossed book looks
 * completely normal on screen while being meaningless.
 *
 * ## Shape: price bands rather than random placement
 *
 * Levels are organised into concentric bands whose width grows with distance from
 * the mid — roughly ticks 1-4, then 5-14, then 15-31, and so on. Each band holds at
 * most one level, and replenishment only fills bands that are empty.
 *
 * The obvious alternative, drawing a random distance per level, was tried and
 * produces a visibly wrong book: whether anything sits near the touch is left to
 * chance, so the spread wanders into dollars when it should be cents. Bands
 * guarantee a tight touch while still thinning out with depth, which is the shape a
 * real book has. Levels that already sit inside a band are left alone, so resting
 * orders persist across ticks instead of being recreated.
 *
 * ## Delta semantics
 *
 * A delta entry is `[price, quantity]` and means **set this level to exactly this
 * quantity**, with zero meaning remove the level. It never means "add this much".
 * That replace semantic is what makes coalescing safe later (D-010): keeping only
 * the last value per price is equivalent to applying every update in order.
 *
 * One sequence number covers one tick's worth of changes rather than one per
 * individual level change. A tick's changes all happened at the same instant, so
 * splitting them would multiply the message count without adding information —
 * and it is what Binance does, batching at 100 ms or 1000 ms.
 */

import {
  BOOK_DEPTH,
  TICK_SIZE,
  asQty,
  asTick,
  type BookDelta,
  type DepthSnapshot,
  type Level,
  type MinorQty,
  type TickPrice,
  type TradeSide,
} from '@cta/protocol';
import type { Rng } from './rng';

export interface OrderBookOptions {
  depth: number;
  /** Typical resting size at the touch, in minor units. 5_000_000 = 0.05 BTC. */
  baseQty: number;
  /** Width of the innermost band, in ticks. */
  touchTicks: number;
  /** Band boundaries grow as `touchTicks * slot^bandExponent`. */
  bandExponent: number;
  /** How many levels get their size nudged per tick, simulating place/cancel. */
  churnPerTick: number;
}

export const DEFAULT_BOOK_OPTIONS: OrderBookOptions = {
  depth: BOOK_DEPTH,
  baseQty: 5_000_000,
  touchTicks: 4,
  bandExponent: 1.8,
  churnPerTick: 3,
};

type Band = readonly [lo: number, hi: number];

export class OrderBook {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();

  /** Changes accumulated since the last commit, last-write-wins per price. */
  private readonly pendingBids = new Map<number, number>();
  private readonly pendingAsks = new Map<number, number>();

  /** Band boundaries in ticks from the mid, computed once. */
  private readonly bands: Band[];
  private readonly maxSpanTicks: number;

  private seq = 0;
  private mid = 0;

  constructor(private readonly opts: OrderBookOptions = DEFAULT_BOOK_OPTIONS) {
    this.bands = [];
    let previous = 0;
    for (let slot = 1; slot <= opts.depth; slot += 1) {
      const hi = Math.max(previous + 1, Math.round(opts.touchTicks * Math.pow(slot, opts.bandExponent)));
      this.bands.push([previous + 1, hi]);
      previous = hi;
    }
    this.maxSpanTicks = previous;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Highest price anyone is willing to buy at. Undefined only before the first tick. */
  bestBid(): TickPrice | undefined {
    let best: number | undefined;
    for (const price of this.bids.keys()) {
      if (best === undefined || price > best) best = price;
    }
    return best === undefined ? undefined : asTick(best);
  }

  /** Lowest price anyone is willing to sell at. */
  bestAsk(): TickPrice | undefined {
    let best: number | undefined;
    for (const price of this.asks.keys()) {
      if (best === undefined || price < best) best = price;
    }
    return best === undefined ? undefined : asTick(best);
  }

  currentSeq(): number {
    return this.seq;
  }

  /**
   * A point-in-time view, sorted the way a book is read: bids descending (most
   * generous buyer first), asks ascending (cheapest seller first).
   *
   * `lastUpdateId` is the contract that makes client reconciliation possible — it
   * says which sequence number this snapshot already includes, so the client knows
   * to discard buffered deltas at or below it and to require the next one at
   * exactly `lastUpdateId + 1`.
   *
   * `limit` truncates for display. Leave it undefined for reconciliation.
   *
   * A truncated snapshot is not a smaller correct book — it is a wrong one. The
   * delta stream covers every level, so a client that started from the top 20 would
   * be missing levels that later deltas assume exist, and its contiguity check
   * cannot see that: the sequence numbers line up perfectly while the book is wrong.
   * Note the book holds more levels than `depth`, because a band may contain more
   * than one price.
   */
  snapshot(symbol: string, ts: number, limit?: number): DepthSnapshot {
    const take = limit ?? Number.MAX_SAFE_INTEGER;
    return {
      symbol,
      lastUpdateId: this.seq,
      ts,
      bids: sortLevels(this.bids, 'desc').slice(0, take),
      asks: sortLevels(this.asks, 'asc').slice(0, take),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Move the book to a new mid price, then refill any band left empty.
   *
   * Pruning comes first and is what enforces the no-cross invariant: any bid now
   * at or above the mid, and any ask at or below it, is removed. Whatever survives
   * satisfies `every bid < mid < every ask`, so the best bid is strictly below the
   * best ask no matter how far the mid jumped.
   *
   * Levels that drift past the outermost band are also dropped. Without that,
   * pruning only ever happens on the side the price moved toward, and the book
   * grows lopsided — one side packed tight, the other trailing stale orders from
   * minutes ago.
   */
  recenter(mid: TickPrice, rng: Rng): void {
    this.mid = mid;
    const maxDistance = this.maxSpanTicks * TICK_SIZE;

    for (const price of [...this.bids.keys()]) {
      if (price >= mid || mid - price > maxDistance) this.setLevel('bid', price, 0);
    }
    for (const price of [...this.asks.keys()]) {
      if (price <= mid || price - mid > maxDistance) this.setLevel('ask', price, 0);
    }

    this.replenish('bid', rng);
    this.replenish('ask', rng);
  }

  /**
   * Nudge a few resting sizes, and occasionally cancel a level outright.
   *
   * Without this the book would only change when the mid moved or a trade landed,
   * and the depth display would look frozen. Real books churn constantly as
   * participants place and cancel.
   */
  perturb(rng: Rng): void {
    for (let i = 0; i < this.opts.churnPerTick; i += 1) {
      const isBid = rng.bool();
      const map = isBid ? this.bids : this.asks;
      const price = rng.pick([...map.keys()]);
      if (price === undefined) continue;

      const side = isBid ? 'bid' : 'ask';
      if (rng.bool(0.15)) {
        // A full cancel. The next recenter refills the band it left empty.
        this.setLevel(side, price, 0);
      } else {
        this.setLevel(side, price, this.sizeFor(this.slotOf(price, isBid ? -1 : 1), rng));
      }
    }
  }

  /**
   * A trade consumes resting liquidity at the price it executed against.
   *
   * A buy lifts the ask side, a sell hits the bid side. If the trade takes the
   * whole level, the level disappears — which is exactly the behaviour that makes
   * the best price move on its own, without the mid having to drag it.
   */
  consume(side: TradeSide, price: TickPrice, qty: MinorQty): void {
    const bookSide = side === 'buy' ? 'ask' : 'bid';
    const map = bookSide === 'bid' ? this.bids : this.asks;
    const resting = map.get(price);
    if (resting === undefined) return;

    const remaining = resting - qty;
    this.setLevel(bookSide, price, remaining > 0 ? remaining : 0);
  }

  /**
   * Seal everything changed since the last commit into one delta and advance the
   * sequence number. Returns null when nothing changed, because a tier must never
   * be fed manufactured updates just to hit a rate.
   */
  commit(): BookDelta | null {
    if (this.pendingBids.size === 0 && this.pendingAsks.size === 0) return null;

    this.seq += 1;
    const delta: BookDelta = {
      fromSeq: this.seq,
      toSeq: this.seq,
      bids: toLevels(this.pendingBids),
      asks: toLevels(this.pendingAsks),
    };

    this.pendingBids.clear();
    this.pendingAsks.clear();
    return delta;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The single write path. Everything that mutates the book goes through here, so
   * there is exactly one place that can forget to record a change into the pending
   * delta — a silent desync between what the server holds and what it told the
   * client.
   */
  private setLevel(side: 'bid' | 'ask', price: number, qty: number): void {
    const map = side === 'bid' ? this.bids : this.asks;
    const pending = side === 'bid' ? this.pendingBids : this.pendingAsks;

    if (qty <= 0) {
      // Only record a removal for a level that actually existed, or the delta
      // would carry no-op entries after every failed perturbation.
      if (!map.has(price)) return;
      map.delete(price);
      pending.set(price, 0);
      return;
    }

    const rounded = Math.round(qty);
    if (map.get(price) === rounded) return;
    map.set(price, rounded);
    pending.set(price, rounded);
  }

  /** Fill every band that currently holds no level. */
  private replenish(side: 'bid' | 'ask', rng: Rng): void {
    const map = side === 'bid' ? this.bids : this.asks;
    const direction = side === 'bid' ? -1 : 1;
    const occupied = this.occupiedBands(map, direction);

    for (let slot = 0; slot < this.bands.length; slot += 1) {
      if (occupied.has(slot)) continue;

      const band = this.bands[slot];
      if (band === undefined) continue;

      const distance = rng.int(band[0], band[1]);
      const price = this.mid + direction * distance * TICK_SIZE;
      if (price <= 0 || map.has(price)) continue;

      this.setLevel(side, price, this.sizeFor(slot, rng));
    }
  }

  private occupiedBands(map: ReadonlyMap<number, number>, direction: number): Set<number> {
    const occupied = new Set<number>();
    for (const price of map.keys()) {
      const slot = this.slotOf(price, direction);
      if (slot >= 0) occupied.add(slot);
    }
    return occupied;
  }

  /** Which band a price falls into, or -1 if it is outside every band. */
  private slotOf(price: number, direction: number): number {
    const distance = ((price - this.mid) * direction) / TICK_SIZE;
    if (distance < 1) return -1;
    for (let slot = 0; slot < this.bands.length; slot += 1) {
      const band = this.bands[slot];
      if (band !== undefined && distance >= band[0] && distance <= band[1]) return slot;
    }
    return -1;
  }

  /**
   * Resting size for a level in the given band.
   *
   * Size grows with depth because the levels nearest the mid are constantly being
   * consumed and re-posted, while participants further out are content to leave
   * larger orders sitting. Scaling by the band index rather than by raw tick
   * distance keeps the ratio sane: the outermost level is a few times the size of
   * the touch, not two hundred times, which would be a wall rather than depth.
   *
   * The log-normal factor keeps sizes positive and right-skewed — many ordinary
   * orders, a few large ones.
   */
  private sizeFor(slot: number, rng: Rng): number {
    const depthFactor = 1 + Math.max(0, slot) * 0.2;
    return Math.max(1, Math.round(this.opts.baseQty * depthFactor * rng.logNormal(1, 0.45)));
  }
}

function sortLevels(map: ReadonlyMap<number, number>, order: 'asc' | 'desc'): Level[] {
  const entries = [...map.entries()];
  entries.sort((a, b) => (order === 'asc' ? a[0] - b[0] : b[0] - a[0]));
  return entries.map(([price, qty]) => [asTick(price), asQty(qty)] as Level);
}

function toLevels(map: ReadonlyMap<number, number>): Level[] {
  return [...map.entries()].map(([price, qty]) => [asTick(price), asQty(qty)] as Level);
}

/**
 * Apply a delta to a plain map, mirroring what the client does.
 *
 * Exported because the round-trip test needs to prove that a snapshot plus every
 * delta reproduces the server's book exactly. Keeping the reference
 * implementation here, next to the semantics it depends on, is what stops the
 * test from quietly drifting away from the thing it is meant to verify.
 */
export function applyDelta(target: Map<number, number>, levels: readonly Level[]): void {
  for (const [price, qty] of levels) {
    if (qty <= 0) target.delete(price);
    else target.set(price, qty);
  }
}
