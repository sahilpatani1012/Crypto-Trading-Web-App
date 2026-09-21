import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { asQty, asTick, type BookDelta, type DepthSnapshot, type Level } from '@cta/protocol';

import { OrderBookStore, type BookSyncState, type SyncReason } from './order-book-store';

function levels(pairs: [number, number][]): Level[] {
  return pairs.map(([p, q]) => [asTick(p), asQty(q)] as Level);
}

function snapshot(lastUpdateId: number, bids: [number, number][], asks: [number, number][]): DepthSnapshot {
  return { symbol: 'BTC-USD', lastUpdateId, ts: 0, bids: levels(bids), asks: levels(asks) };
}

function delta(
  fromSeq: number,
  toSeq: number,
  bids: [number, number][] = [],
  asks: [number, number][] = [],
): BookDelta {
  return { fromSeq, toSeq, bids: levels(bids), asks: levels(asks) };
}

function one(seq: number, bids: [number, number][] = [], asks: [number, number][] = []): BookDelta {
  return delta(seq, seq, bids, asks);
}

/**
 * A snapshot fetcher the test resolves by hand.
 *
 * Holding the promise open is the whole point: it is how a request is kept "in
 * flight" while deltas arrive, which is the race this class exists to solve. With a
 * real fetch that window is milliseconds of luck.
 */
function deferredFetcher() {
  const pending: Array<{ resolve: (s: DepthSnapshot) => void; reject: (e: Error) => void; signal: AbortSignal }> = [];
  const fetchSnapshot = (signal: AbortSignal) =>
    new Promise<DepthSnapshot>((resolve, reject) => pending.push({ resolve, reject, signal }));
  return { fetchSnapshot, pending };
}

function setup() {
  const { fetchSnapshot, pending } = deferredFetcher();
  const states: Array<{ state: BookSyncState; reason: SyncReason }> = [];
  let changes = 0;

  const book = new OrderBookStore({
    fetchSnapshot,
    onChange: () => {
      changes += 1;
    },
    onState: (state, reason) => states.push({ state, reason }),
    retryDelayMs: 100,
  });

  return { book, pending, states, changeCount: () => changes };
}

/** Let queued promise callbacks run. */
const settle = () => Promise.resolve().then(() => Promise.resolve());

describe('OrderBookStore — the in-flight snapshot race', () => {
  it('buffers deltas instead of applying them while the snapshot is in flight', async () => {
    const { book, pending } = setup();
    book.start();

    // These arrive before the snapshot does. Applying them now would be applying
    // them to nothing.
    book.applyDelta(one(98, [[100, 10]]));
    book.applyDelta(one(99, [[101, 20]]));
    expect(book.getState()).toBe('snapshotting');
    expect(book.top().bids).toHaveLength(0);

    pending[0]!.resolve(snapshot(99, [[100, 5]], [[110, 5]]));
    await settle();

    expect(book.getState()).toBe('synced');
    // Both buffered deltas were at or below lastUpdateId, so the snapshot wins.
    expect(book.top().bids).toEqual([[100, 5]]);
  });

  it('discards the buffered deltas the snapshot already contains, and applies the rest', async () => {
    const { book, pending } = setup();
    book.start();

    for (const seq of [98, 99, 100, 101, 102, 103]) {
      book.applyDelta(one(seq, [[100 + seq, seq]]));
    }
    book.applyDelta(one(104, [[500, 44]]));
    book.applyDelta(one(105, [[501, 55]]));

    pending[0]!.resolve(snapshot(103, [[999, 1]], []));
    await settle();

    const { bids } = book.top(20);
    const priceMap = new Map(bids.map(([p, q]) => [p as number, q as number]));

    // Everything up to 103 came from the snapshot, not from replaying the buffer.
    expect(priceMap.get(999)).toBe(1);
    expect(priceMap.has(198)).toBe(false);
    // 104 and 105 were not in the snapshot and must not be lost.
    expect(priceMap.get(500)).toBe(44);
    expect(priceMap.get(501)).toBe(55);
    expect(book.stats().lastSeq).toBe(105);
  });

  it('requires the buffer to bridge lastUpdateId + 1, and refetches when it cannot', async () => {
    const { book, pending } = setup();
    book.start();

    // Nothing between 104 and 109: the snapshot is already too old to build on.
    book.applyDelta(one(110, [[500, 1]]));
    pending[0]!.resolve(snapshot(103, [[100, 5]], []));
    await settle();

    expect(book.getState()).toBe('resyncing');
    expect(pending).toHaveLength(2);

    // A newer snapshot bridges it.
    pending[1]!.resolve(snapshot(109, [[100, 7]], []));
    await settle();
    expect(book.getState()).toBe('synced');
    expect(book.stats().lastSeq).toBe(110);
  });

  it('accepts a delta that starts exactly at the boundary', async () => {
    const { book, pending } = setup();
    book.start();
    book.applyDelta(one(104, [[100, 9]]));
    pending[0]!.resolve(snapshot(103, [[100, 5]], []));
    await settle();

    expect(book.getState()).toBe('synced');
    expect(book.top().bids).toEqual([[100, 9]]);
  });

  it('applies a coalesced delta that straddles the snapshot boundary', async () => {
    // The server merges deltas under load, so a buffered frame can span [100, 106]
    // against a snapshot at 103. Applying it whole is correct because each level it
    // carries holds its FINAL value as of 106, and anything it omits was untouched
    // in that range — which is true only because a delta means "set", not "add".
    const { book, pending } = setup();
    book.start();

    book.applyDelta(delta(100, 106, [[100, 77], [102, 88]]));
    pending[0]!.resolve(snapshot(103, [[100, 5], [101, 6], [102, 7]], []));
    await settle();

    const priceMap = new Map(book.top(20).bids.map(([p, q]) => [p as number, q as number]));
    expect(priceMap.get(100)).toBe(77); // overwritten by the delta's final value
    expect(priceMap.get(102)).toBe(88); // overwritten
    expect(priceMap.get(101)).toBe(6); // untouched by the delta, snapshot stands
    expect(book.stats().lastSeq).toBe(106);
  });

  it('ignores deltas that arrive before synchronisation is started', () => {
    const { book } = setup();
    book.applyDelta(one(1, [[100, 5]]));
    expect(book.getState()).toBe('idle');
    expect(book.top().bids).toHaveLength(0);
  });
});

describe('OrderBookStore — steady state', () => {
  async function synced() {
    const ctx = setup();
    ctx.book.start();
    ctx.pending[0]!.resolve(snapshot(500, [[100, 10], [99, 20]], [[110, 5], [111, 8]]));
    await settle();
    return ctx;
  }

  it('applies contiguous deltas', async () => {
    const { book } = await synced();

    book.applyDelta(one(501, [[100, 15]]));
    book.applyDelta(one(502, [[98, 30]]));

    const priceMap = new Map(book.top(20).bids.map(([p, q]) => [p as number, q as number]));
    expect(priceMap.get(100)).toBe(15);
    expect(priceMap.get(98)).toBe(30);
    expect(book.stats().lastSeq).toBe(502);
  });

  it('removes a level when the quantity is zero', async () => {
    const { book } = await synced();
    book.applyDelta(one(501, [[99, 0]]));

    const prices = book.top(20).bids.map(([p]) => p as number);
    // Removed, not stored as zero — an empty row could be mistaken for real size.
    expect(prices).not.toContain(99);
    expect(book.top(20).bids.every(([, q]) => (q as number) > 0)).toBe(true);
  });

  it('ignores a duplicate delta, leaving the book untouched', async () => {
    const { book } = await synced();
    book.applyDelta(one(501, [[100, 15]]));
    const before = book.top(20);

    // A retransmit. Replaying an old level value over a newer one would quietly
    // corrupt the book, which is exactly why "already applied" must be ignored.
    book.applyDelta(one(501, [[100, 999]]));
    book.applyDelta(one(499, [[100, 888]]));

    expect(book.top(20)).toEqual(before);
    expect(book.stats().duplicates).toBe(2);
  });

  it('keeps bids sorted descending and asks ascending', async () => {
    const { book } = await synced();
    book.applyDelta(one(501, [[105, 1], [95, 2]], [[108, 1], [120, 2]]));

    const { bids, asks } = book.top(10);
    expect(bids.map(([p]) => p as number)).toEqual([105, 100, 99, 95]);
    expect(asks.map(([p]) => p as number)).toEqual([108, 110, 111, 120]);
  });

  it('exposes the touch', async () => {
    const { book } = await synced();
    expect(book.bestBid()).toBe(100);
    expect(book.bestAsk()).toBe(110);
  });
});

describe('OrderBookStore — gap detection and recovery', () => {
  async function synced() {
    const ctx = setup();
    ctx.book.start();
    ctx.pending[0]!.resolve(snapshot(500, [[100, 10]], [[110, 5]]));
    await settle();
    return ctx;
  }

  it('detects a missing update and refetches without closing anything', async () => {
    const { book, pending, states } = await synced();

    // 501 and 502 never arrived. A book built on a missing update is wrong from
    // then on, with nothing to signal it.
    book.applyDelta(one(503, [[100, 99]]));

    expect(book.getState()).toBe('resyncing');
    expect(book.stats().gaps).toBe(1);
    expect(pending).toHaveLength(2);
    expect(states.at(-1)).toEqual({ state: 'resyncing', reason: 'gap' });
  });

  it('does not apply the delta that revealed the gap until it is bridged', async () => {
    const { book } = await synced();
    book.applyDelta(one(503, [[100, 99]]));

    // Still showing the last known-good book rather than a corrupted one.
    expect(book.top().bids).toEqual([[100, 10]]);
  });

  it('resumes correctly, including the delta that triggered the resync', async () => {
    const { book, pending } = await synced();
    book.applyDelta(one(503, [[100, 99]]));

    pending[1]!.resolve(snapshot(502, [[100, 50], [90, 5]], [[110, 5]]));
    await settle();

    expect(book.getState()).toBe('synced');
    const priceMap = new Map(book.top(20).bids.map(([p, q]) => [p as number, q as number]));
    // 503 bridged 502+1 and was applied on top of the fresh snapshot.
    expect(priceMap.get(100)).toBe(99);
    expect(priceMap.get(90)).toBe(5);
    expect(book.stats().lastSeq).toBe(503);
  });

  it('keeps buffering while resyncing', async () => {
    const { book, pending } = await synced();
    book.applyDelta(one(503, [[100, 99]]));
    book.applyDelta(one(504, [[101, 11]]));
    book.applyDelta(one(505, [[102, 22]]));

    pending[1]!.resolve(snapshot(502, [[100, 50]], []));
    await settle();

    const priceMap = new Map(book.top(20).bids.map(([p, q]) => [p as number, q as number]));
    expect(priceMap.get(101)).toBe(11);
    expect(priceMap.get(102)).toBe(22);
    expect(book.stats().lastSeq).toBe(505);
  });

  it('ends up with exactly the book the server has after a forced gap', async () => {
    // The property that actually matters: after recovery, the client's book is not
    // merely self-consistent, it matches the source.
    const { book, pending } = await synced();

    const serverBids = new Map<number, number>([[100, 10]]);
    const applyToServer = (d: BookDelta) => {
      for (const [p, q] of d.bids) {
        if ((q as number) <= 0) serverBids.delete(p as number);
        else serverBids.set(p as number, q as number);
      }
    };

    const stream = [
      one(501, [[100, 11]]),
      one(502, [[99, 21]]),
      one(503, [[98, 31]]), // <- this one is "lost in transit"
      one(504, [[97, 41]]),
      one(505, [[99, 0]]),
    ];
    for (const d of stream) applyToServer(d);

    book.applyDelta(stream[0]!);
    book.applyDelta(stream[1]!);
    // 503 dropped.
    book.applyDelta(stream[3]!);
    expect(book.getState()).toBe('resyncing');

    // The server's snapshot reflects everything up to 503.
    const upTo503 = new Map<number, number>([[100, 11], [99, 21], [98, 31]]);
    pending[1]!.resolve(snapshot(503, [...upTo503.entries()].map(([p, q]) => [p, q]), []));
    await settle();

    book.applyDelta(stream[4]!);

    const clientBids = new Map(book.top(50).bids.map(([p, q]) => [p as number, q as number]));
    expect([...clientBids.entries()].sort()).toEqual([...serverBids.entries()].sort());
    expect(book.stats().lastSeq).toBe(505);
  });
});

describe('OrderBookStore — superseded responses', () => {
  /**
   * Only one snapshot request is ever current: a gap moves the book into
   * `resyncing`, where further deltas simply buffer rather than triggering more
   * fetches. A second request therefore comes from something *else* happening
   * mid-resync — most realistically a reconnect.
   */
  it('discards a snapshot response that a later request has overtaken', async () => {
    const { book, pending } = setup();
    book.start();
    pending[0]!.resolve(snapshot(500, [[100, 10]], []));
    await settle();

    // A gap starts a resync...
    book.applyDelta(one(600));
    expect(pending).toHaveLength(2);

    // ...and the socket reconnects before that snapshot comes back.
    book.start('reconnect');
    expect(pending).toHaveLength(3);

    // The newer request answers first.
    pending[2]!.resolve(snapshot(699, [[100, 70]], []));
    await settle();
    expect(book.stats().lastSeq).toBe(699);

    // The superseded one arrives late. Applying it would drag the book backwards
    // to an older sequence, silently losing everything in between.
    pending[1]!.resolve(snapshot(560, [[100, 56]], []));
    await settle();

    expect(book.stats().lastSeq).toBe(699);
    expect(book.top().bids).toEqual([[100, 70]]);
  });

  it('aborts the in-flight request when a newer one starts', async () => {
    const { book, pending } = setup();
    book.start();
    pending[0]!.resolve(snapshot(500, [], []));
    await settle();

    book.applyDelta(one(600));
    const superseded = pending[1]!;
    book.start('reconnect');

    // The signal stops the network work; the generation check catches a response
    // that had already resolved before the abort landed. Neither covers the other.
    expect(superseded.signal.aborted).toBe(true);
  });

  it('treats consecutive gaps as one resync rather than a burst of fetches', async () => {
    const { book, pending } = setup();
    book.start();
    pending[0]!.resolve(snapshot(500, [[100, 10]], []));
    await settle();

    book.applyDelta(one(600));
    book.applyDelta(one(700));
    book.applyDelta(one(800));

    // Already rebuilding: there is nothing more to discover by checking again, and
    // a fetch per delta would hammer the snapshot endpoint exactly when the client
    // is already struggling.
    expect(pending).toHaveLength(2);
    expect(book.stats().gaps).toBe(1);
  });
});

describe('OrderBookStore — failures and lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries after a failed snapshot fetch instead of stalling forever', async () => {
    const { book, pending } = setup();
    book.start();

    pending[0]!.reject(new Error('network down'));
    await settle();

    expect(book.getState()).toBe('snapshotting');
    vi.advanceTimersByTime(200);
    expect(pending).toHaveLength(2);

    pending[1]!.resolve(snapshot(10, [[100, 1]], []));
    await settle();
    expect(book.getState()).toBe('synced');
  });

  it('rebuilds from scratch on reconnect rather than trusting the old sequence', async () => {
    const { book, pending } = setup();
    book.start();
    pending[0]!.resolve(snapshot(500, [[100, 10]], []));
    await settle();

    // A reconnect does not wait for gap detection: we already know an unknown
    // number of updates were missed, so rebuilding immediately saves a round trip.
    book.start('reconnect');
    expect(book.getState()).toBe('snapshotting');

    pending[1]!.resolve(snapshot(9_000, [[200, 3]], []));
    await settle();

    expect(book.stats().lastSeq).toBe(9_000);
    expect(book.top().bids).toEqual([[200, 3]]);
  });

  it('clears the held book on reconnect, but keeps it through a gap resync', async () => {
    const { book, pending } = setup();
    book.start();
    pending[0]!.resolve(snapshot(500, [[100, 10]], [[110, 5]]));
    await settle();
    expect(book.top().bids).toHaveLength(1);

    // A gap means one missed update: the book is very nearly right, and blanking it
    // would be a worse lie than a brief near-miss.
    book.applyDelta(one(600));
    expect(book.top().bids).toHaveLength(1);

    // A reconnect means the book describes a market from before the outage — and by
    // the time this runs the UI is already back to 'open', so republishing it would
    // show pre-disconnect levels at full opacity with a live-looking spread.
    book.start('reconnect');
    expect(book.top().bids).toHaveLength(0);
    expect(book.top().asks).toHaveLength(0);
    expect(book.stats().lastSeq).toBe(0);
  });

  it('stops everything on dispose', async () => {
    const { book, pending } = setup();
    book.start();
    book.dispose();

    expect(pending[0]!.signal.aborted).toBe(true);

    // A response arriving after disposal must not touch anything.
    pending[0]!.resolve(snapshot(500, [[100, 10]], []));
    await settle();
    expect(book.top().bids).toHaveLength(0);

    book.applyDelta(one(501, [[100, 5]]));
    expect(book.top().bids).toHaveLength(0);
  });

  it('is safe to dispose twice', () => {
    const { book } = setup();
    book.start();
    book.dispose();
    expect(() => book.dispose()).not.toThrow();
  });
});
