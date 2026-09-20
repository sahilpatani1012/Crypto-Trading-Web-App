import { describe, it, expect } from 'vitest';
import {
  bucketStart,
  formatPrice,
  formatQty,
  tierScore,
  TIER_THRESHOLDS,
  TIER_PERIOD_MS,
  TIER_TARGET_HZ,
  TIERS,
  INTERVALS,
  parseClientFrame,
  parseServerFrame,
  encodeFrame,
} from './index';

describe('bucket alignment', () => {
  it('floors a timestamp to the start of its interval', () => {
    // 1s buckets: anything in [1000, 2000) belongs to 1000.
    expect(bucketStart(1_000, 1_000)).toBe(1_000);
    expect(bucketStart(1_001, 1_000)).toBe(1_000);
    expect(bucketStart(1_999, 1_000)).toBe(1_000);
    expect(bucketStart(2_000, 1_000)).toBe(2_000);
  });

  it('aligns every interval to the epoch, so buckets never drift', () => {
    const ts = 1_726_800_123_456;
    for (const ms of Object.values(INTERVALS)) {
      expect(bucketStart(ts, ms) % ms).toBe(0);
      expect(bucketStart(ts, ms)).toBeLessThanOrEqual(ts);
      expect(bucketStart(ts, ms) + ms).toBeGreaterThan(ts);
    }
  });
});

describe('scaled integer formatting (D-004)', () => {
  it('renders integer ticks as a decimal price', () => {
    expect(formatPrice(6_543_210)).toBe('65432.10');
    expect(formatPrice(1)).toBe('0.01');
    expect(formatPrice(0)).toBe('0.00');
  });

  it('renders integer minor units as a decimal quantity', () => {
    expect(formatQty(100_000_000)).toBe('1.0000');
    expect(formatQty(12_345_678)).toBe('0.1235');
  });

  it('sums quantities exactly, which is the whole point of integers', () => {
    // 500 trades of 0.001 BTC. In floats this accumulates visible error;
    // in integers it is exact.
    const one = 100_000; // 0.001 BTC at QTY_SCALE 8
    let total = 0;
    for (let i = 0; i < 500; i++) total += one;
    expect(total).toBe(50_000_000);
    expect(formatQty(total)).toBe('0.5000');

    // The float version this design exists to avoid:
    let float = 0;
    for (let i = 0; i < 500; i++) float += 0.001;
    expect(float).not.toBe(0.5);
  });
});

describe('tier configuration (D-006, D-007)', () => {
  it('weights jitter above latency in the score', () => {
    // Same total "badness", but the jittery link scores worse.
    expect(tierScore(200, 0)).toBe(200);
    expect(tierScore(50, 150)).toBe(350);
    expect(tierScore(50, 150)).toBeGreaterThan(tierScore(200, 0));
  });

  it('leaves a real deadband between every demote and promote boundary', () => {
    // Hysteresis is only hysteresis if the promote threshold sits strictly below
    // the demote one. If these ever met, the tier would toggle on noise.
    expect(TIER_THRESHOLDS.promoteToFull).toBeLessThan(TIER_THRESHOLDS.demoteFromFull);
    expect(TIER_THRESHOLDS.promoteToDegraded).toBeLessThan(TIER_THRESHOLDS.demoteFromDegraded);
  });

  it('orders tiers from fastest to slowest without ties', () => {
    const periods = TIERS.map((t) => TIER_PERIOD_MS[t]);
    expect(periods).toEqual([...periods].sort((a, b) => a - b));
    expect(new Set(periods).size).toBe(TIERS.length);
  });

  it('keeps the advertised Hz consistent with the scheduling period', () => {
    for (const tier of TIERS) {
      expect(TIER_TARGET_HZ[tier]).toBeCloseTo(1_000 / TIER_PERIOD_MS[tier], 6);
    }
  });
});

describe('frame validation', () => {
  it('round-trips a well-formed client frame', () => {
    const encoded = encodeFrame({ t: 'ping', id: 7, clientTime: 1_726_800_000_000 });
    const result = parseClientFrame(encoded);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame).toEqual({ t: 'ping', id: 7, clientTime: 1_726_800_000_000 });
  });

  it('round-trips a well-formed server frame', () => {
    const encoded = encodeFrame({
      t: 'candle',
      symbol: 'BTC-USD',
      interval: '1s',
      candle: { t: 1_000, o: 100, h: 110, l: 90, c: 105, v: 500, n: 3 } as never,
      closed: true,
    } as never);
    const result = parseServerFrame(encoded);
    expect(result.ok).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    // A public socket receives all of these eventually; none may crash a handler.
    const bad: unknown[] = [
      'not json at all',
      '{"t":"ping"}', // missing required fields
      '{"t":"nonsense"}', // unknown discriminant
      '{"t":"netreport","latencyMs":"fast","jitterMs":1,"samples":1}', // wrong type
      '{"t":"subscribe","symbol":"BTC-USD","interval":"7h"}', // interval not in the enum
      '[]',
      'null',
      '',
    ];
    for (const input of bad) {
      const result = parseClientFrame(input);
      expect(result.ok, `expected rejection for ${JSON.stringify(input)}`).toBe(false);
    }
  });

  it('rejects a tier override naming a tier that does not exist', () => {
    expect(parseClientFrame('{"t":"setTier","tier":"turbo"}').ok).toBe(false);
    // ...but null is valid: it is how the override is released.
    expect(parseClientFrame('{"t":"setTier","tier":null}').ok).toBe(true);
  });
});
