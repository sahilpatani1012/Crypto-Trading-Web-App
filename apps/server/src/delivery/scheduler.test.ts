import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TIER_PERIOD_MS,
  asQty,
  asTick,
  type BookDelta,
  type Candle,
  type Level,
  type Trade,
} from '@cta/protocol';

import { DeliveryScheduler, type FlushPayload } from './scheduler';
import { applyDelta } from '../market/order-book';

function candle(t: number, close: number, n: number): Candle {
  return {
    t,
    o: asTick(100),
    h: asTick(Math.max(100, close)),
    l: asTick(Math.min(100, close)),
    c: asTick(close),
    v: asQty(n * 10),
    n,
  };
}

function trade(id: number, price: number): Trade {
  return { id, ts: 1_000 + id, p: asTick(price), q: asQty(100), side: 'buy' };
}

function delta(seq: number, bids: [number, number][] = [], asks: [number, number][] = []): BookDelta {
  return {
    fromSeq: seq,
    toSeq: seq,
    bids: bids.map(([p, q]) => [asTick(p), asQty(q)] as Level),
    asks: asks.map(([p, q]) => [asTick(p), asQty(q)] as Level),
  };
}

function makeScheduler(periodMs: number, buffered = () => 0) {
  const flushes: FlushPayload[] = [];
  let ticks = 0;
  const scheduler = new DeliveryScheduler({
    periodMs,
    onTick: () => {
      ticks += 1;
    },
    onFlush: (payload) => flushes.push(payload),
    bufferedBytes: buffered,
  });
  return { scheduler, flushes, tickCount: () => ticks };
}

describe('DeliveryScheduler — cadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits at the configured period, not on every queued event', () => {
    const { scheduler, flushes } = makeScheduler(100);

    // Ten trades arrive during one delivery window.
    for (let i = 1; i <= 10; i += 1) scheduler.queueTrade(trade(i, 100 + i));
    expect(flushes).toHaveLength(0);

    vi.advanceTimersByTime(100);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.trades).toHaveLength(10);

    scheduler.stop();
  });

  it('sends nothing at all when nothing happened', () => {
    // A target rate is a ceiling on delivery, not a quota. The spec is explicit
    // that a tier must not cause market events to be invented.
    const { scheduler, flushes, tickCount } = makeScheduler(100);

    vi.advanceTimersByTime(1_000);
    expect(tickCount()).toBe(10); // the timer ran
    expect(flushes).toHaveLength(0); // and sent nothing

    scheduler.stop();
  });

  it('delivers roughly ten times more often at full than at minimal', () => {
    const fast = makeScheduler(TIER_PERIOD_MS.full);
    const slow = makeScheduler(TIER_PERIOD_MS.minimal);

    for (let i = 1; i <= 100; i += 1) {
      fast.scheduler.queueTrade(trade(i, 100));
      slow.scheduler.queueTrade(trade(i, 100));
      vi.advanceTimersByTime(50);
    }

    expect(fast.flushes.length).toBeGreaterThan(slow.flushes.length * 5);
    fast.scheduler.stop();
    slow.scheduler.stop();
  });

  it('retimes without losing what is already pending', () => {
    const { scheduler, flushes } = makeScheduler(1_000);
    scheduler.queueTrade(trade(1, 100));

    // A tier change is a statement about bandwidth, not a reason to discard market
    // data that has not been delivered yet.
    scheduler.setPeriod(100);
    vi.advanceTimersByTime(100);

    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.trades[0]!.id).toBe(1);
    scheduler.stop();
  });

  it('stops delivering once stopped', () => {
    const { scheduler, flushes } = makeScheduler(100);
    scheduler.stop();

    scheduler.queueTrade(trade(1, 100));
    vi.advanceTimersByTime(1_000);
    expect(flushes).toHaveLength(0);
  });
});

describe('DeliveryScheduler — candles are snapshots, not patches (D-009)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps only the latest candle state, because each fully supersedes the last', () => {
    const { scheduler, flushes } = makeScheduler(1_000);

    scheduler.queueCandle(candle(1_000, 101, 1), '1s', false);
    scheduler.queueCandle(candle(1_000, 105, 2), '1s', false);
    scheduler.queueCandle(candle(1_000, 103, 3), '1s', false);

    vi.advanceTimersByTime(1_000);

    // One frame, carrying the whole truth. A queue would be keeping garbage.
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.candle!.candle.c).toBe(103);
    expect(flushes[0]!.candle!.candle.n).toBe(3);

    scheduler.stop();
  });

  it('flushes a closed candle immediately, bypassing the cadence', () => {
    // This is the rule that stops the whole feature being a lie. Without it, a
    // minimal-tier client's last view of a closing bar could be up to a second
    // stale at the moment it froze, permanently recording a close that never was.
    const { scheduler, flushes } = makeScheduler(1_000);

    scheduler.queueCandle(candle(1_000, 101, 5), '1s', false);
    expect(flushes).toHaveLength(0);

    scheduler.queueCandle(candle(1_000, 107, 9), '1s', true);

    // No timer advance at all.
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.candle!.closed).toBe(true);
    expect(flushes[0]!.candle!.candle.c).toBe(107);

    scheduler.stop();
  });

  it('carries whatever else was pending along with an immediate close flush', () => {
    const { scheduler, flushes } = makeScheduler(1_000);

    scheduler.queueTrade(trade(1, 100));
    scheduler.queueBookDelta(delta(50, [[99, 5]]));
    scheduler.queueCandle(candle(1_000, 107, 9), '1s', true);

    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.trades).toHaveLength(1);
    expect(flushes[0]!.book).not.toBeNull();

    scheduler.stop();
  });
});

describe('DeliveryScheduler — book deltas are merged, never dropped (D-010)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('preserves the sequence range so the client can still detect a gap', () => {
    const { scheduler, flushes } = makeScheduler(1_000);

    scheduler.queueBookDelta(delta(101, [[65_005, 230]]));
    scheduler.queueBookDelta(delta(102, [[65_008, 80]]));
    scheduler.queueBookDelta(delta(103, [[65_005, 110]]));

    vi.advanceTimersByTime(1_000);

    const merged = flushes[0]!.book!;
    // The client asserts fromSeq === lastSeq + 1 and then sets lastSeq = toSeq, so
    // coalescing widens the range without breaking contiguity.
    expect(merged.fromSeq).toBe(101);
    expect(merged.toSeq).toBe(103);

    scheduler.stop();
  });

  it('keeps the last quantity per price level', () => {
    const { scheduler, flushes } = makeScheduler(1_000);

    scheduler.queueBookDelta(delta(1, [[65_005, 230]]));
    scheduler.queueBookDelta(delta(2, [[65_005, 110]]));

    vi.advanceTimersByTime(1_000);

    const bids = flushes[0]!.book!.bids;
    expect(bids).toHaveLength(1);
    expect(bids[0]).toEqual([65_005, 110]);

    scheduler.stop();
  });

  it('produces the same book as applying every delta in order', () => {
    // The property the whole merge rests on. It holds only because a delta entry
    // means "set this level to this quantity" rather than "add this much": under a
    // replace semantic, last-write-wins is equivalent to sequential application.
    const deltas: BookDelta[] = [
      delta(1, [[100, 10], [101, 20]], [[110, 5]]),
      delta(2, [[100, 0]], [[110, 7], [111, 3]]),
      delta(3, [[101, 25], [102, 40]], [[110, 0]]),
      delta(4, [[102, 0]], [[112, 9]]),
    ];

    const sequentialBids = new Map<number, number>();
    const sequentialAsks = new Map<number, number>();
    for (const d of deltas) {
      applyDelta(sequentialBids, d.bids);
      applyDelta(sequentialAsks, d.asks);
    }

    const { scheduler, flushes } = makeScheduler(1_000);
    for (const d of deltas) scheduler.queueBookDelta(d);
    vi.advanceTimersByTime(1_000);

    const mergedBids = new Map<number, number>();
    const mergedAsks = new Map<number, number>();
    applyDelta(mergedBids, flushes[0]!.book!.bids);
    applyDelta(mergedAsks, flushes[0]!.book!.asks);

    expect([...mergedBids.entries()].sort()).toEqual([...sequentialBids.entries()].sort());
    expect([...mergedAsks.entries()].sort()).toEqual([...sequentialAsks.entries()].sort());

    scheduler.stop();
  });

  it('starts a fresh range after each flush', () => {
    const { scheduler, flushes } = makeScheduler(100);

    scheduler.queueBookDelta(delta(10, [[1, 1]]));
    vi.advanceTimersByTime(100);
    scheduler.queueBookDelta(delta(11, [[2, 2]]));
    vi.advanceTimersByTime(100);

    expect(flushes[0]!.book).toMatchObject({ fromSeq: 10, toSeq: 10 });
    expect(flushes[1]!.book).toMatchObject({ fromSeq: 11, toSeq: 11 });

    scheduler.stop();
  });
});

describe('DeliveryScheduler — trade tape', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps every trade, because the tape needs every print', () => {
    const { scheduler, flushes } = makeScheduler(1_000);
    for (let i = 1; i <= 25; i += 1) scheduler.queueTrade(trade(i, 100 + i));
    vi.advanceTimersByTime(1_000);

    expect(flushes[0]!.trades.map((t) => t.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    scheduler.stop();
  });

  it('caps a pathological burst, dropping the oldest and reporting the count honestly', () => {
    const flushes: FlushPayload[] = [];
    const scheduler = new DeliveryScheduler({
      periodMs: 1_000,
      onTick: () => {},
      onFlush: (p) => flushes.push(p),
      bufferedBytes: () => 0,
      maxTradesPerFrame: 10,
    });

    for (let i = 1; i <= 30; i += 1) scheduler.queueTrade(trade(i, 100));
    vi.advanceTimersByTime(1_000);

    const payload = flushes[0]!;
    expect(payload.trades).toHaveLength(10);
    // The newest survive: the recent end of the tape is the end anyone is reading.
    expect(payload.trades[0]!.id).toBe(21);
    expect(payload.trades[9]!.id).toBe(30);
    // Surfaced rather than hidden, so the UI can say the tape is incomplete.
    expect(payload.droppedTrades).toBe(20);

    scheduler.stop();
  });
});

describe('DeliveryScheduler — backpressure', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('skips a tick when the socket has not drained, and keeps the data', () => {
    let buffered = 0;
    const { scheduler, flushes } = makeScheduler(100, () => buffered);

    // A client that has stopped reading: piling on more frames only grows its
    // backlog and pushes it further behind.
    buffered = 10_000_000;
    scheduler.queueTrade(trade(1, 100));
    vi.advanceTimersByTime(100);
    expect(flushes).toHaveLength(0);

    // Nothing was thrown away — it goes out, coalesced further, once it drains.
    buffered = 0;
    scheduler.queueTrade(trade(2, 100));
    vi.advanceTimersByTime(100);

    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.trades.map((t) => t.id)).toEqual([1, 2]);
    expect(scheduler.stats().backpressureSkips).toBe(1);

    scheduler.stop();
  });
});
