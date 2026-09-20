import { describe, it, expect } from 'vitest';
import {
  INTERVALS,
  bucketStart,
  asQty,
  asTick,
  type Candle,
  type IntervalId,
  type Trade,
} from '@cta/protocol';

import { MarketEngine } from './engine';
import { VirtualClock } from './clock';
import { Rng } from './rng';
import { CandleAggregator, candleFromTrades } from './candles';
import { applyDelta } from './order-book';

/** A fixed wall-clock origin, so every test's buckets land on the same grid. */
const ORIGIN = 1_726_800_000_000;

/** Must match ENGINE_TICK_MS; tests step the clock in these increments. */
const TICK_MS = 50;

function makeEngine(seed = 4242, startAt = ORIGIN) {
  const clock = new VirtualClock(startAt);
  const engine = new MarketEngine({ seed, clock });
  return { engine, clock };
}

/**
 * Run the engine forward, collecting everything it emitted.
 *
 * The clock is stepped one engine tick at a time rather than jumped, because that
 * is what production does: a `setInterval` fires every ENGINE_TICK_MS and calls
 * `advance()`. Jumping the clock and calling `advanceTo` once would instead
 * exercise the catch-up path, which is capped — so the engine would deliberately
 * skip most of the elapsed time.
 */
function run(engine: MarketEngine, clock: VirtualClock, ms: number) {
  const trades: Trade[] = [];
  const deltas: { fromSeq: number; toSeq: number; bids: [number, number][]; asks: [number, number][] }[] = [];
  const candles: { interval: IntervalId; candle: Candle; closed: boolean }[] = [];

  const off = [
    engine.events.on('trade', (t) => trades.push(t)),
    engine.events.on('book', (d) =>
      deltas.push({
        fromSeq: d.fromSeq,
        toSeq: d.toSeq,
        bids: d.bids.map(([p, q]) => [p, q] as [number, number]),
        asks: d.asks.map(([p, q]) => [p, q] as [number, number]),
      }),
    ),
    engine.events.on('candle', (e) => candles.push({ ...e, candle: { ...e.candle } })),
  ];

  const steps = Math.floor(ms / TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    clock.advance(TICK_MS);
    engine.advanceTo(clock.now());
  }
  for (const unsubscribe of off) unsubscribe();

  return { trades, deltas, candles };
}

// ---------------------------------------------------------------------------

describe('Rng — determinism is the whole point (D-012)', () => {
  it('produces an identical sequence for the same seed', () => {
    const a = new Rng(1337);
    const b = new Rng(1337);
    const left = Array.from({ length: 200 }, () => a.next());
    const right = Array.from({ length: 200 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('produces a different sequence for a different seed', () => {
    const a = new Rng(1337);
    const b = new Rng(1338);
    expect(Array.from({ length: 50 }, () => a.next())).not.toEqual(
      Array.from({ length: 50 }, () => b.next()),
    );
  });

  it('stays inside [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 5_000; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('draws a normal distribution centred near zero with unit spread', () => {
    const rng = new Rng(99);
    const samples = Array.from({ length: 20_000 }, () => rng.normal());
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(variance).toBeGreaterThan(0.9);
    expect(variance).toBeLessThan(1.1);
  });

  it('draws a Poisson count averaging lambda', () => {
    const rng = new Rng(11);
    const lambda = 0.4;
    const samples = Array.from({ length: 20_000 }, () => rng.poisson(lambda));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(lambda * 0.9);
    expect(mean).toBeLessThan(lambda * 1.1);
    expect(samples.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });
});

describe('MarketEngine — determinism', () => {
  it('two engines with the same seed produce byte-identical trades', () => {
    const a = makeEngine(777);
    const b = makeEngine(777);
    const left = run(a.engine, a.clock, 5_000).trades;
    const right = run(b.engine, b.clock, 5_000).trades;

    expect(left.length).toBeGreaterThan(20);
    expect(left).toEqual(right);
  });

  it('a different seed produces a different price path', () => {
    const a = makeEngine(777);
    const b = makeEngine(778);
    const left = run(a.engine, a.clock, 5_000).trades.map((t) => t.p);
    const right = run(b.engine, b.clock, 5_000).trades.map((t) => t.p);
    expect(left).not.toEqual(right);
  });

  it('assigns strictly increasing trade ids with no gaps', () => {
    const { engine, clock } = makeEngine();
    const { trades } = run(engine, clock, 10_000);

    expect(trades.length).toBeGreaterThan(50);
    trades.forEach((trade, i) => {
      expect(trade.id).toBe(i + 1);
    });
  });

  it('never emits a trade timestamp that goes backwards', () => {
    const { engine, clock } = makeEngine();
    const { trades } = run(engine, clock, 10_000);
    for (let i = 1; i < trades.length; i += 1) {
      expect(trades[i]!.ts).toBeGreaterThanOrEqual(trades[i - 1]!.ts);
    }
  });
});

describe('OrderBook — the no-cross invariant', () => {
  /**
   * The bug this catches is invisible on screen: a crossed book renders perfectly
   * normally while describing a market where you could buy from the best ask and
   * immediately sell to the best bid for guaranteed profit. A real matching engine
   * makes that impossible; ours places levels artificially, so it has to be
   * asserted.
   */
  it('keeps best bid strictly below best ask on every single tick', () => {
    const { engine, clock } = makeEngine(31337);

    for (let i = 0; i < 2_000; i += 1) {
      clock.advance(50);
      engine.advanceTo(clock.now());

      const bid = engine.bestBid();
      const ask = engine.bestAsk();
      expect(bid).toBeDefined();
      expect(ask).toBeDefined();
      expect(bid!).toBeLessThan(ask!);
    }
  });

  it('holds the invariant through a violently volatile price path', () => {
    // 20x normal volatility, which forces the mid to jump across many resting
    // levels at once — exactly the condition where a naive recenter would leave
    // stale levels on the wrong side of the book.
    const clock = new VirtualClock(ORIGIN);
    const engine = new MarketEngine({ seed: 5, clock, price: { volatilityTicks: 3_000 } });

    for (let i = 0; i < 1_000; i += 1) {
      clock.advance(50);
      engine.advanceTo(clock.now());
      expect(engine.bestBid()!).toBeLessThan(engine.bestAsk()!);
    }
  });

  it('maintains at least the display depth on both sides', () => {
    const { engine, clock } = makeEngine();
    run(engine, clock, 3_000);

    const snapshot = engine.snapshot();
    expect(snapshot.bids.length).toBeGreaterThanOrEqual(10);
    expect(snapshot.asks.length).toBeGreaterThanOrEqual(10);
  });

  it('sorts bids descending and asks ascending', () => {
    const { engine, clock } = makeEngine();
    run(engine, clock, 3_000);
    const { bids, asks } = engine.snapshot();

    for (let i = 1; i < bids.length; i += 1) expect(bids[i]![0]).toBeLessThan(bids[i - 1]![0]);
    for (let i = 1; i < asks.length; i += 1) expect(asks[i]![0]).toBeGreaterThan(asks[i - 1]![0]);
  });

  it('never publishes a level with a non-positive quantity in a snapshot', () => {
    const { engine, clock } = makeEngine();
    run(engine, clock, 3_000);
    const { bids, asks } = engine.snapshot();
    for (const [, qty] of [...bids, ...asks]) expect(qty).toBeGreaterThan(0);
  });
});

describe('OrderBook — snapshot plus deltas reproduces the server book', () => {
  /**
   * This is the property the client depends on. If it did not hold, no amount of
   * careful reconciliation on the client would produce a correct book.
   */
  it('replays every delta onto an initial snapshot and lands on the same book', () => {
    const { engine, clock } = makeEngine(2024);

    // Warm the book up, then take the snapshot the "client" starts from.
    run(engine, clock, 2_000);
    const initial = engine.snapshot(1_000);

    const bids = new Map<number, number>(initial.bids.map(([p, q]) => [p, q]));
    const asks = new Map<number, number>(initial.asks.map(([p, q]) => [p, q]));

    const { deltas } = run(engine, clock, 5_000);
    expect(deltas.length).toBeGreaterThan(20);

    let lastSeq = initial.lastUpdateId;
    for (const delta of deltas) {
      // Contiguity: exactly what the real client asserts before applying.
      expect(delta.fromSeq).toBe(lastSeq + 1);
      applyDelta(bids, delta.bids.map(([p, q]) => [asTick(p), asQty(q)]));
      applyDelta(asks, delta.asks.map(([p, q]) => [asTick(p), asQty(q)]));
      lastSeq = delta.toSeq;
    }

    const final = engine.snapshot(1_000);
    expect(lastSeq).toBe(final.lastUpdateId);

    const rebuiltBids = [...bids.entries()].sort((a, b) => b[0] - a[0]);
    const rebuiltAsks = [...asks.entries()].sort((a, b) => a[0] - b[0]);

    expect(rebuiltBids).toEqual(final.bids.map(([p, q]) => [p, q]));
    expect(rebuiltAsks).toEqual(final.asks.map(([p, q]) => [p, q]));
  });

  it('emits sequence numbers that only ever increase by one', () => {
    const { engine, clock } = makeEngine();
    const { deltas } = run(engine, clock, 5_000);

    for (let i = 1; i < deltas.length; i += 1) {
      expect(deltas[i]!.fromSeq).toBe(deltas[i - 1]!.toSeq + 1);
      expect(deltas[i]!.fromSeq).toBe(deltas[i]!.toSeq);
    }
  });
});

describe('CandleAggregator — OHLCV correctness', () => {
  function trade(id: number, ts: number, price: number, qty: number): Trade {
    return { id, ts, p: asTick(price), q: asQty(qty), side: 'buy' };
  }

  it('computes open, high, low, close and volume from a known trade set', () => {
    const agg = new CandleAggregator(1_000, 100);
    // All inside the bucket starting at ORIGIN.
    agg.applyTrade(trade(1, ORIGIN + 10, 100, 5));
    agg.applyTrade(trade(2, ORIGIN + 200, 130, 3));
    agg.applyTrade(trade(3, ORIGIN + 400, 80, 7));
    agg.applyTrade(trade(4, ORIGIN + 900, 110, 2));

    const candle = agg.getCurrent()!;
    expect(candle.t).toBe(ORIGIN);
    expect(candle.o).toBe(100); // first
    expect(candle.h).toBe(130); // highest
    expect(candle.l).toBe(80); // lowest
    expect(candle.c).toBe(110); // last
    expect(candle.v).toBe(17); // 5+3+7+2, exactly
    expect(candle.n).toBe(4);
  });

  it('agrees with an independent recomputation from the raw trades', () => {
    const agg = new CandleAggregator(1_000, 100);
    const rng = new Rng(123);
    const trades: Trade[] = [];

    for (let i = 0; i < 300; i += 1) {
      const t = trade(i + 1, ORIGIN + rng.int(0, 999), rng.int(90, 140), rng.int(1, 50));
      trades.push(t);
      agg.applyTrade(t);
    }

    // Recomputed in trade order, which is the order the aggregator saw them.
    const expected = candleFromTrades(ORIGIN, trades)!;
    const actual = agg.getCurrent()!;
    expect(actual).toEqual(expected);
  });

  it('seals a candle when the bucket rolls over, and the sealed one never changes', () => {
    const agg = new CandleAggregator(1_000, 100);
    agg.applyTrade(trade(1, ORIGIN + 500, 100, 1));
    agg.applyTrade(trade(2, ORIGIN + 900, 150, 1));

    const closed = agg.applyTrade(trade(3, ORIGIN + 1_100, 200, 1));
    expect(closed).toHaveLength(1);

    const sealed = closed[0]!;
    expect(sealed.t).toBe(ORIGIN);
    expect(sealed.o).toBe(100);
    expect(sealed.h).toBe(150);
    expect(sealed.c).toBe(150);

    // The new bucket started cleanly rather than inheriting the old one's extremes.
    const current = agg.getCurrent()!;
    expect(current.t).toBe(ORIGIN + 1_000);
    expect(current.o).toBe(200);
    expect(current.h).toBe(200);
    expect(current.l).toBe(200);
  });

  it('fills a quiet gap with flat zero-volume candles rather than leaving a hole', () => {
    const agg = new CandleAggregator(1_000, 100);
    agg.applyTrade(trade(1, ORIGIN + 100, 500, 4));

    // Nothing trades for three seconds.
    const closed = agg.rollTo(ORIGIN + 3_500);
    expect(closed).toHaveLength(3);

    // The first is the real candle; the rest report honestly that nothing traded.
    expect(closed[0]!.c).toBe(500);
    for (const candle of closed.slice(1)) {
      expect(candle.o).toBe(500);
      expect(candle.h).toBe(500);
      expect(candle.l).toBe(500);
      expect(candle.c).toBe(500);
      expect(candle.v).toBe(0);
      expect(candle.n).toBe(0);
    }
  });

  it('ignores an out-of-order trade rather than corrupting a sealed candle', () => {
    const agg = new CandleAggregator(1_000, 100);
    agg.applyTrade(trade(1, ORIGIN + 100, 100, 1));
    agg.applyTrade(trade(2, ORIGIN + 1_100, 200, 1));

    const before = agg.getCurrent()!;
    agg.applyTrade(trade(3, ORIGIN + 500, 999, 99)); // belongs to the sealed bucket
    expect(agg.getCurrent()).toEqual(before);
  });

  it('returns exactly one candle when asked for one', () => {
    const agg = new CandleAggregator(1_000, 100);
    for (let i = 0; i < 20; i += 1) agg.applyTrade(trade(i + 1, ORIGIN + i * 1_000, 100 + i, 1));
    expect(agg.getCandles(1)).toHaveLength(1);
    expect(agg.getCandles(5)).toHaveLength(5);
  });
});

describe('Candles produced by the engine', () => {
  it('aligns every bucket to the epoch, for every interval', () => {
    const { engine, clock } = makeEngine();
    run(engine, clock, 20_000);

    for (const [id, ms] of Object.entries(INTERVALS)) {
      for (const candle of engine.candles(id as IntervalId, 50)) {
        expect(candle.t % ms).toBe(0);
        expect(bucketStart(candle.t, ms)).toBe(candle.t);
      }
    }
  });

  it('holds the OHLC ordering invariant on every candle', () => {
    const { engine, clock } = makeEngine();
    run(engine, clock, 30_000);

    for (const id of Object.keys(INTERVALS) as IntervalId[]) {
      for (const candle of engine.candles(id, 100)) {
        expect(candle.l).toBeLessThanOrEqual(candle.o);
        expect(candle.l).toBeLessThanOrEqual(candle.c);
        expect(candle.h).toBeGreaterThanOrEqual(candle.o);
        expect(candle.h).toBeGreaterThanOrEqual(candle.c);
        expect(candle.l).toBeLessThanOrEqual(candle.h);
        expect(candle.v).toBeGreaterThanOrEqual(0);
        expect(candle.n).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(candle.v)).toBe(true);
      }
    }
  });

  it('emits candles in contiguous buckets with no missing bars', () => {
    const { engine, clock } = makeEngine();
    run(engine, clock, 30_000);

    for (const [id, ms] of Object.entries(INTERVALS)) {
      const candles = engine.candles(id as IntervalId, 100);
      for (let i = 1; i < candles.length; i += 1) {
        expect(candles[i]!.t).toBe(candles[i - 1]!.t + ms);
      }
    }
  });

  it('reconciles a 1s candle against the raw trades that fell inside it', () => {
    const { engine, clock } = makeEngine(8080);
    const { trades, candles } = run(engine, clock, 12_000);

    const sealed = candles.filter((c) => c.interval === '1s' && c.closed && c.candle.n > 0);
    expect(sealed.length).toBeGreaterThan(5);

    // Check a few sealed candles against a recomputation from the trade tape.
    for (const { candle } of sealed.slice(1, 6)) {
      const inBucket = trades.filter((t) => bucketStart(t.ts, 1_000) === candle.t);
      const expected = candleFromTrades(candle.t, inBucket);
      expect(expected).not.toBeNull();
      expect(candle.o).toBe(expected!.o);
      expect(candle.h).toBe(expected!.h);
      expect(candle.l).toBe(expected!.l);
      expect(candle.c).toBe(expected!.c);
      expect(candle.v).toBe(expected!.v);
      expect(candle.n).toBe(expected!.n);
    }
  });

  it('marks a closed candle exactly once per bucket', () => {
    const { engine, clock } = makeEngine();
    const { candles } = run(engine, clock, 20_000);

    const closedTimes = candles.filter((c) => c.interval === '1s' && c.closed).map((c) => c.candle.t);
    expect(closedTimes.length).toBeGreaterThan(10);
    expect(new Set(closedTimes).size).toBe(closedTimes.length);
  });
});

describe('Warmup produces history through the live code path (D-012)', () => {
  it('fills history for every interval before anyone connects', () => {
    const clock = new VirtualClock(ORIGIN);
    const engine = new MarketEngine({ seed: 4242, clock });
    engine.warmup(120_000);

    expect(engine.candles('1s', 200).length).toBeGreaterThan(100);
    expect(engine.candles('5s', 50).length).toBeGreaterThan(20);
    expect(engine.recent(50).length).toBeGreaterThan(20);
    expect(engine.lastPrice()).not.toBeNull();
  });

  it('joins history to live data with no discontinuity in the bucket grid', () => {
    const clock = new VirtualClock(ORIGIN);
    const engine = new MarketEngine({ seed: 4242, clock });
    engine.warmup(60_000);

    const beforeLast = engine.candles('1s', 5).at(-1)!;
    clock.advance(3_000);
    engine.advanceTo(clock.now());

    const after = engine.candles('1s', 10);
    for (let i = 1; i < after.length; i += 1) {
      expect(after[i]!.t).toBe(after[i - 1]!.t + 1_000);
    }
    expect(after.some((c) => c.t >= beforeLast.t)).toBe(true);
  });

  it('is reproducible: same seed and same warmup gives the same history', () => {
    const a = new MarketEngine({ seed: 999, clock: new VirtualClock(ORIGIN) });
    const b = new MarketEngine({ seed: 999, clock: new VirtualClock(ORIGIN) });
    a.warmup(30_000);
    b.warmup(30_000);
    expect(a.candles('1s', 100)).toEqual(b.candles('1s', 100));
  });
});

describe('Engine resilience', () => {
  it('does not replay an unbounded backlog after a long stall', () => {
    const { engine, clock } = makeEngine();
    run(engine, clock, 1_000);

    let tradesDuringCatchup = 0;
    const off = engine.events.on('trade', () => {
      tradesDuringCatchup += 1;
    });

    // A laptop waking from an hour of sleep. Replaying that honestly would be
    // 72,000 ticks and would block the event loop; the engine caps it instead.
    clock.advance(3_600_000);
    const started = Date.now();
    engine.advanceTo(clock.now());
    const elapsed = Date.now() - started;
    off();

    expect(elapsed).toBeLessThan(500);
    // 200 capped ticks at ~0.4 trades each, nowhere near an hour's worth.
    expect(tradesDuringCatchup).toBeLessThan(200);
  });

  it('keeps ticking normally after the stall', () => {
    const { engine, clock } = makeEngine();
    run(engine, clock, 1_000);
    clock.advance(3_600_000);
    engine.advanceTo(clock.now());

    const { trades } = run(engine, clock, 3_000);
    expect(trades.length).toBeGreaterThan(10);
    expect(engine.bestBid()!).toBeLessThan(engine.bestAsk()!);
  });
});
