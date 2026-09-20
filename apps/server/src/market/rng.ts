/**
 * Seeded pseudo-random number generator.
 *
 * `Math.random()` gives no control over the seed, which would make the generated
 * market impossible to reproduce — no deterministic tests, no way to replay a bug,
 * no way to demonstrate a specific market condition on demand. Same idea as a
 * Minecraft world seed: the data is not stored, it is regenerated on demand from a
 * single number.
 *
 * The algorithm is mulberry32: 32-bit state, good statistical quality for
 * simulation purposes, and about five lines. We are modelling a plausible market,
 * not doing cryptography, so a small fast generator is exactly right.
 */

export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force to an unsigned 32-bit integer so the same seed behaves identically
    // whether it arrived as a float, a negative number, or a parsed env var.
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /**
   * Standard normal (mean 0, variance 1) by the Box-Muller transform.
   *
   * This is what makes a generated price path look like a market rather than like
   * noise: small moves are common, large ones are rare, and the shape of that
   * trade-off is the bell curve. A uniform distribution would make a $500 jump
   * exactly as likely as a $5 one, which no real market does.
   *
   * We deliberately discard the second value Box-Muller produces rather than
   * caching it. Caching would be free, but it makes the output depend on the call
   * pattern rather than only on the seed, which is a needless way to make
   * determinism harder to reason about.
   */
  normal(): number {
    // u must be non-zero: log(0) is -Infinity.
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Poisson draw by Knuth's method — how many events occurred in one interval,
   * given an expected count of `lambda`.
   *
   * Real trades do not arrive on a metronome; they arrive in clumps with quiet
   * gaps. Poisson is the standard model for independent arrivals, and it is what
   * makes coalescing meaningful: at 10 Hz most delivery windows hold zero or one
   * trade, while at 1 Hz each one holds a handful.
   *
   * Knuth's loop runs about `lambda` times on average, so it is only appropriate
   * for small lambda. Ours is around 0.4 per engine tick, so this costs roughly
   * one and a half iterations.
   */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }

  /**
   * Log-normal draw, used for trade sizes.
   *
   * Trade sizes are not symmetric around an average: most are small, a few are
   * very large, and none are negative. Exponentiating a normal gives exactly that
   * shape, and guarantees a positive result without needing a clamp.
   */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(this.normal() * sigma);
  }

  /** Uniformly pick an element. Returns undefined only for an empty array. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(this.next() * items.length)];
  }
}
