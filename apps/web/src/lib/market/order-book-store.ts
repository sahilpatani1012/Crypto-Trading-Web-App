/**
 * The locally maintained order book.
 *
 * Built from a REST snapshot reconciled against sequenced WebSocket deltas, with
 * gap detection and recovery. No React, no DOM, no sockets — it takes a snapshot
 * fetcher and deltas, and exposes a sorted top-N. That is what makes the race
 * conditions below testable at all.
 *
 * ## The race this class exists to solve
 *
 * The snapshot and the delta stream are two sources of truth that have to be merged
 * consistently, and they are not synchronised. While a snapshot request is in
 * flight, deltas keep arriving — and some of them are already included in the
 * snapshot that is on its way.
 *
 *     t=0    subscribe; server starts sending #98, #99, #100...
 *     t=5    GET /api/depth
 *     t=245  snapshot arrives, lastUpdateId = 103
 *            meanwhile #98..#105 have arrived on the socket
 *
 * Applying all of them double-counts #98–#103. Discarding all of them loses #104
 * and #105 permanently. Ignoring deltas until the snapshot lands loses them too.
 *
 * So deltas are **buffered, not applied**, and filtered once `lastUpdateId` is
 * known. This is the algorithm Binance documents for their depth stream, and it is
 * the part of an order book client that is easy to get subtly, silently wrong.
 *
 * ## Why an overlapping coalesced delta is safe
 *
 * Our server merges deltas under load, so a buffered frame can span a range that
 * straddles the snapshot — say [100, 106] against a snapshot at 103. It is applied
 * whole, and that is correct: the merged frame carries each touched level's *final*
 * quantity as of 106, and any level it does not mention was not touched between 100
 * and 106, so the snapshot's value still stands.
 *
 * This only works because a delta entry means *set this level to this quantity*
 * rather than *add this much*. The same property is what makes the server-side merge
 * legal in the first place (D-010).
 */

import {
  BOOK_DEPTH,
  asQty,
  asTick,
  type BookDelta,
  type DepthSnapshot,
  type Level,
} from '@cta/protocol';

export type BookSyncState = 'idle' | 'snapshotting' | 'synced' | 'resyncing';

/** Why a snapshot is being fetched. Surfaced for the UI and asserted in tests. */
export type SyncReason = 'initial' | 'gap' | 'reconnect' | 'stale-snapshot' | 'error' | 'recovered';

export interface OrderBookStoreOptions {
  fetchSnapshot: (signal: AbortSignal) => Promise<DepthSnapshot>;
  /** Called whenever the visible book changed. */
  onChange?: () => void;
  onState?: (state: BookSyncState, reason: SyncReason) => void;
  /** Retry delay after a failed snapshot fetch. */
  retryDelayMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Cap on buffered deltas while a snapshot is in flight.
 *
 * A hung request would otherwise grow this without limit. Dropping the oldest can
 * break the bridge to `lastUpdateId + 1`, but that is self-correcting: reconciliation
 * detects the gap and fetches again, which is the right outcome when a snapshot has
 * taken long enough to buffer a thousand updates.
 */
const MAX_BUFFER = 1_000;

export interface BookStats {
  state: BookSyncState;
  lastSeq: number;
  /** Snapshot fetches triggered by a detected gap. */
  gaps: number;
  /** Total snapshot fetches, including the initial one. */
  snapshots: number;
  /** Deltas ignored because they were already applied. */
  duplicates: number;
  bufferedNow: number;
}

export class OrderBookStore {
  private readonly opts: OrderBookStoreOptions;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;

  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private lastSeq = 0;
  private state: BookSyncState = 'idle';
  private buffer: BookDelta[] = [];

  /**
   * Guards against a superseded snapshot response.
   *
   * Two gaps in quick succession put two requests in flight. If the first response
   * lands second, applying it would drag the book *backwards* to an older
   * `lastUpdateId`. Each request captures the generation at the moment it was fired;
   * a response whose generation is no longer current is discarded.
   */
  private generation = 0;
  /** Why the in-flight snapshot was requested, so the resulting sync can say so. */
  private pendingReason: SyncReason = 'initial';
  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private gaps = 0;
  private snapshots = 0;
  private duplicates = 0;

  constructor(options: OrderBookStoreOptions) {
    this.opts = options;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /**
   * Begin, or restart, synchronisation.
   *
   * Called once when the subscription opens and again on every reconnect. A
   * reconnect does not wait for gap detection to notice: we already know an unknown
   * number of updates were missed, so rebuilding immediately saves a round trip.
   */
  start(reason: SyncReason = 'initial'): void {
    if (this.disposed) return;

    // On a reconnect the held book describes a market from before the outage, and
    // the UI is already back to `open` by the time this runs — so republishing it
    // would render pre-disconnect levels at full opacity, with a live-looking
    // spread, for the whole snapshot round trip. That is exactly the "mixture of old
    // and new" the resync is supposed to prevent.
    //
    // A gap-triggered resync deliberately keeps its levels: only one update was
    // missed, so the book is very nearly right, and blanking it would be a worse lie
    // than a brief near-miss.
    if (reason === 'reconnect') {
      this.bids.clear();
      this.asks.clear();
      this.lastSeq = 0;
      this.buffer = [];
    }

    this.requestSnapshot(reason, reason === 'gap' ? 'resyncing' : 'snapshotting');
  }

  applyDelta(delta: BookDelta): void {
    if (this.disposed) return;

    switch (this.state) {
      case 'idle':
        // Nothing to reconcile against yet. Deltas before `start()` are not ours.
        return;

      case 'snapshotting':
      case 'resyncing':
        this.bufferDelta(delta);
        return;

      case 'synced':
        this.applyWhenSynced(delta);
        return;
    }
  }

  /** Top N levels, sorted the way a book is read. */
  top(n = 10): { bids: Level[]; asks: Level[] } {
    return {
      bids: sortLevels(this.bids, 'desc').slice(0, n),
      asks: sortLevels(this.asks, 'asc').slice(0, n),
    };
  }

  bestBid(): number | null {
    let best: number | null = null;
    for (const price of this.bids.keys()) if (best === null || price > best) best = price;
    return best;
  }

  bestAsk(): number | null {
    let best: number | null = null;
    for (const price of this.asks.keys()) if (best === null || price < best) best = price;
    return best;
  }

  getState(): BookSyncState {
    return this.state;
  }

  stats(): BookStats {
    return {
      state: this.state,
      lastSeq: this.lastSeq,
      gaps: this.gaps,
      snapshots: this.snapshots,
      duplicates: this.duplicates,
      bufferedNow: this.buffer.length,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer !== null) {
      this.clearTimeoutFn(this.retryTimer);
      this.retryTimer = null;
    }
    this.buffer = [];
  }

  // -------------------------------------------------------------------------
  // Delta handling
  // -------------------------------------------------------------------------

  private bufferDelta(delta: BookDelta): void {
    this.buffer.push(delta);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
  }

  private applyWhenSynced(delta: BookDelta): void {
    // Entirely in the past: a duplicate or a late retransmit. Ignoring it is safe
    // precisely because applying it would not be — replaying an old level value over
    // a newer one would quietly corrupt the book.
    if (delta.toSeq <= this.lastSeq) {
      this.duplicates += 1;
      return;
    }

    // The contiguity check. Anything other than "starts exactly where we left off"
    // means updates went missing, and a book built on a missing update is wrong from
    // then on with nothing to signal it.
    if (delta.fromSeq > this.lastSeq + 1) {
      this.gaps += 1;
      this.requestSnapshot('gap', 'resyncing');
      // Keep it: after the new snapshot lands it may well be the delta that bridges.
      this.bufferDelta(delta);
      return;
    }

    this.apply(delta);
    this.opts.onChange?.();
  }

  private apply(delta: BookDelta): void {
    applyLevels(this.bids, delta.bids);
    applyLevels(this.asks, delta.asks);
    this.lastSeq = delta.toSeq;
  }

  // -------------------------------------------------------------------------
  // Snapshot and reconciliation
  // -------------------------------------------------------------------------

  private requestSnapshot(reason: SyncReason, nextState: BookSyncState): void {
    if (this.disposed) return;

    // Cancel anything already in flight. Its response is now superseded, and the
    // generation bump below means it would be discarded even if it arrives first.
    this.abort?.abort();
    if (this.retryTimer !== null) {
      this.clearTimeoutFn(this.retryTimer);
      this.retryTimer = null;
    }

    const generation = ++this.generation;
    this.pendingReason = reason;
    const controller = new AbortController();
    this.abort = controller;
    this.snapshots += 1;
    this.setState(nextState, reason);

    this.opts
      .fetchSnapshot(controller.signal)
      .then((snapshot) => {
        if (this.disposed || generation !== this.generation) return;
        this.reconcile(snapshot, generation);
      })
      .catch(() => {
        if (this.disposed || generation !== this.generation) return;
        // A failed fetch is not fatal — deltas keep buffering and we try again.
        // Without a retry the book would stay stuck in `snapshotting` forever.
        this.retryTimer = this.setTimeoutFn(() => {
          this.retryTimer = null;
          this.requestSnapshot('error', this.state === 'synced' ? 'resyncing' : 'snapshotting');
        }, this.opts.retryDelayMs ?? 1_000);
      });
  }

  /**
   * Merge the snapshot with everything buffered while it was in flight.
   *
   * The whole race resolves here, in four steps: adopt the snapshot, drop the
   * buffered deltas it already contains, verify the remainder bridges to it, and
   * apply them in order.
   */
  private reconcile(snapshot: DepthSnapshot, generation: number): void {
    this.bids = new Map(snapshot.bids.map(([price, qty]) => [price as number, qty as number]));
    this.asks = new Map(snapshot.asks.map(([price, qty]) => [price as number, qty as number]));
    this.lastSeq = snapshot.lastUpdateId;

    const buffered = this.buffer;
    this.buffer = [];

    for (let i = 0; i < buffered.length; i += 1) {
      const delta = buffered[i]!;

      // Already reflected in the snapshot.
      if (delta.toSeq <= this.lastSeq) {
        this.duplicates += 1;
        continue;
      }

      // The first surviving delta must reach back to `lastSeq + 1`. A coalesced
      // frame legitimately straddles the boundary — [100, 106] over a snapshot at
      // 103 — and is applied whole, because each level it carries holds its final
      // value and anything it omits was not touched in that range.
      if (delta.fromSeq > this.lastSeq + 1) {
        // The snapshot is older than the deltas we are holding: the updates in
        // between are gone, so fetch a newer one.
        //
        // This one and everything after it go back in the buffer rather than being
        // dropped. They are still ahead of the snapshot we just rejected, and a
        // newer snapshot will very likely bridge them — discarding them here would
        // throw away updates we successfully received and force yet another round
        // trip to recover them.
        this.buffer = buffered.slice(i);
        this.gaps += 1;
        if (generation === this.generation) this.requestSnapshot('stale-snapshot', 'resyncing');
        return;
      }

      this.apply(delta);
    }

    this.setState('synced', this.pendingReason === 'initial' ? 'initial' : 'recovered');
    this.opts.onChange?.();
  }

  private setState(state: BookSyncState, reason: SyncReason): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state, reason);
  }
}

/**
 * Apply level updates in place.
 *
 * A quantity of zero removes the level rather than storing a zero, which would leave
 * an empty row in the display and could be mistaken for available size.
 */
function applyLevels(target: Map<number, number>, levels: readonly Level[]): void {
  for (const [price, qty] of levels) {
    if (qty <= 0) target.delete(price);
    else target.set(price, qty);
  }
}

/**
 * Sorting on read rather than maintaining a sorted structure.
 *
 * Twenty levels a side is about forty comparisons, ten times a second — a few
 * hundred operations per second, which is nothing. A sorted tree would be the right
 * call at thousands of levels and is premature complexity at twenty.
 */
function sortLevels(map: ReadonlyMap<number, number>, order: 'asc' | 'desc'): Level[] {
  const entries = [...map.entries()];
  entries.sort((a, b) => (order === 'asc' ? a[0] - b[0] : b[0] - a[0]));
  return entries.map(([price, qty]) => [asTick(price), asQty(qty)] as Level);
}

export const DEFAULT_BOOK_LIMIT = BOOK_DEPTH;
