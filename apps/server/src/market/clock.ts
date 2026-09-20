/**
 * Time as an injected dependency rather than an ambient fact.
 *
 * Any module that calls `Date.now()` directly is untestable in practice: to test
 * what happens after five seconds you would have to actually wait five seconds,
 * and the test would be both slow and flaky. Passing a clock in means a test can
 * advance time instantly and deterministically.
 *
 * This is the single most reusable idea in this slice. Every time-dependent piece
 * of this project — the market engine, the tier state machine, the delivery
 * scheduler — takes a Clock.
 */

export interface Clock {
  now(): number;
}

/** Production. Wall-clock milliseconds since the epoch, UTC. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Tests, and the engine's startup warmup.
 *
 * Warmup is the interesting use: to produce candle history we point a virtual
 * clock at ten minutes ago and run the *real* tick loop forward at full speed.
 * History and live data therefore come out of the same code path, so there is no
 * seam between them where the two could disagree (D-012).
 */
export class VirtualClock implements Clock {
  private t: number;

  constructor(startMs = 0) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }

  set(ms: number): void {
    this.t = ms;
  }
}
