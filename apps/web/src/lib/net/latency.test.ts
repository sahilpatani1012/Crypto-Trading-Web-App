import { describe, it, expect } from 'vitest';
import { LatencyMeter, RateMeter } from './latency';

describe('LatencyMeter — EWMA latency (D-005)', () => {
  it('seeds from the first sample rather than blending into zero', () => {
    const meter = new LatencyMeter();
    meter.addSample(120);
    // Starting at zero would mean climbing towards the truth over ~10 samples —
    // twenty seconds of telling the server the connection is faster than it is,
    // which is the wrong direction to be wrong in.
    expect(meter.stats().latencyMs).toBe(120);
  });

  it('converges towards a steady value', () => {
    const meter = new LatencyMeter();
    for (let i = 0; i < 50; i += 1) meter.addSample(200);
    expect(meter.stats().latencyMs).toBeCloseTo(200, 0);
  });

  it('absorbs a single outlier instead of reacting to it', () => {
    const meter = new LatencyMeter();
    for (let i = 0; i < 20; i += 1) meter.addSample(120);

    // One GC pause. A raw sample would report 400 and demote a healthy connection.
    meter.addSample(400);

    const after = meter.stats().latencyMs;
    expect(after).toBeGreaterThan(120);
    expect(after).toBeLessThan(180);

    // And it forgets it again. Exponential memory means a trace always remains,
    // which is the point — it decays rather than falling off a window's edge.
    for (let i = 0; i < 20; i += 1) meter.addSample(120);
    expect(meter.stats().latencyMs).toBeGreaterThanOrEqual(120);
    expect(meter.stats().latencyMs).toBeLessThan(122);
  });

  it('tracks a genuine step change, just not instantly', () => {
    const meter = new LatencyMeter();
    for (let i = 0; i < 30; i += 1) meter.addSample(50);
    expect(meter.stats().latencyMs).toBeCloseTo(50, 0);

    for (let i = 0; i < 30; i += 1) meter.addSample(300);
    expect(meter.stats().latencyMs).toBeGreaterThan(290);
  });
});

describe('LatencyMeter — RFC 3550 jitter', () => {
  it('stays near zero on a perfectly steady connection', () => {
    const meter = new LatencyMeter();
    for (let i = 0; i < 40; i += 1) meter.addSample(120);
    expect(meter.stats().jitterMs).toBeLessThan(1);
  });

  it('rises sharply when arrival times vary, even at lower average latency', () => {
    // The distinction the tier score exists to capture. The jittery connection has
    // the *lower* mean latency and is far worse to watch: updates arrive in clumps,
    // and the chart visibly stutters.
    const steady = new LatencyMeter();
    const jittery = new LatencyMeter();

    const steadySamples = [120, 121, 119, 120, 122, 118, 121, 120];
    const jitterySamples = [40, 250, 60, 230, 50, 240, 45, 235];

    for (let round = 0; round < 6; round += 1) {
      for (const s of steadySamples) steady.addSample(s);
      for (const s of jitterySamples) jittery.addSample(s);
    }

    expect(jittery.stats().latencyMs).toBeLessThan(steady.stats().latencyMs + 40);
    expect(jittery.stats().jitterMs).toBeGreaterThan(steady.stats().jitterMs * 20);
  });

  it('measures variation, not magnitude', () => {
    // A connection ten times slower but equally consistent has the same jitter.
    const fast = new LatencyMeter();
    const slow = new LatencyMeter();
    for (let i = 0; i < 40; i += 1) {
      fast.addSample(20);
      slow.addSample(200);
    }
    expect(slow.stats().jitterMs).toBeCloseTo(fast.stats().jitterMs, 1);
  });

  it('decays once a connection settles down', () => {
    const meter = new LatencyMeter();
    for (let i = 0; i < 20; i += 1) meter.addSample(i % 2 === 0 ? 50 : 400);
    const turbulent = meter.stats().jitterMs;
    expect(turbulent).toBeGreaterThan(50);

    for (let i = 0; i < 80; i += 1) meter.addSample(100);
    expect(meter.stats().jitterMs).toBeLessThan(turbulent / 5);
  });
});

describe('LatencyMeter — housekeeping', () => {
  it('ignores impossible samples instead of poisoning the estimate', () => {
    const meter = new LatencyMeter();
    meter.addSample(100);
    meter.addSample(-5);
    meter.addSample(Number.NaN);
    meter.addSample(Number.POSITIVE_INFINITY);
    expect(meter.stats().latencyMs).toBe(100);
    expect(meter.stats().samples).toBe(1);
  });

  it('reports nothing before the first sample', () => {
    const meter = new LatencyMeter();
    expect(meter.hasSample()).toBe(false);
    expect(meter.stats()).toEqual({ latencyMs: 0, jitterMs: 0, samples: 0 });
  });

  it('discards history on reset, because a reconnect means a new path', () => {
    const meter = new LatencyMeter();
    for (let i = 0; i < 20; i += 1) meter.addSample(300);

    // Carrying the old estimate forward would have the client confidently
    // reporting a number about a connection that no longer exists.
    meter.reset();
    expect(meter.hasSample()).toBe(false);

    meter.addSample(20);
    expect(meter.stats().latencyMs).toBe(20);
  });
});

describe('RateMeter', () => {
  it('measures arrivals inside the trailing window', () => {
    const meter = new RateMeter(1_000);
    for (let i = 0; i < 10; i += 1) meter.mark(1_000 + i * 100);
    expect(meter.ratePerSecond(1_900)).toBeCloseTo(10, 0);
  });

  it('forgets arrivals older than the window', () => {
    const meter = new RateMeter(1_000);
    for (let i = 0; i < 10; i += 1) meter.mark(1_000 + i * 100);
    // Ten seconds later, nothing recent.
    expect(meter.ratePerSecond(12_000)).toBe(0);
  });

  it('reads below the target rate during a quiet market, which is correct', () => {
    // The server sends nothing when nothing happened, so measured rate legitimately
    // falls below the tier's target. Showing the measured value is what proves the
    // coalescer is real; showing only the target would just echo configuration.
    const meter = new RateMeter(3_000);
    meter.mark(1_000);
    meter.mark(2_000);
    expect(meter.ratePerSecond(3_500)).toBeLessThan(10);
  });
});
