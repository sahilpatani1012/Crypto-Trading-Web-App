/**
 * Round-trip measurement (D-005).
 *
 * The client measures; the server decides. This class turns a stream of noisy RTT
 * samples into the two numbers the tier controller runs on, and it is deliberately
 * free of React, timers and sockets — it takes numbers in and gives numbers out, so
 * it can be tested exhaustively without any of that.
 *
 * ## Why not use raw samples
 *
 * One garbage-collection pause and a single sample reads 400 ms on a connection
 * that is completely healthy. Driving a state machine off that would mean reacting
 * to noise, which is exactly the flapping hysteresis exists to prevent — we would
 * be fighting our own design.
 *
 * ## Latency: exponentially weighted moving average
 *
 *     latency = α · rtt + (1 − α) · latency          α = 0.2
 *
 * One number of state, one multiply per sample, and a smooth forgetting curve. A
 * sliding-window mean would need an array, a recomputation per sample, and has a
 * hard edge where a sample that mattered a moment ago abruptly counts for nothing —
 * plus the window length is one more arbitrary constant to defend.
 *
 * ## Jitter: the RFC 3550 estimator
 *
 *     D = |rtt_now − rtt_prev|
 *     jitter += (D − jitter) / 16
 *
 * This is the estimator from the RTP specification, which exists for precisely this
 * problem. It measures how much the latency *varies*, not how large it is, and that
 * distinction is the whole reason jitter carries double weight in the tier score:
 *
 *     steady   120 121 119 120 122    → latency 120, jitter ~1    feels fine
 *     jittery   40 250  60 230  50    → latency ~130, jitter ~180  feels broken
 *
 * The second connection has *lower* average latency and is far worse to watch,
 * because updates arrive in clumps and the chart visibly stutters.
 */

import { EWMA_ALPHA, JITTER_DIVISOR, type NetStats } from '@cta/protocol';

export class LatencyMeter {
  private latencyMs = 0;
  private jitterMs = 0;
  private samples = 0;
  private lastRtt: number | null = null;

  constructor(
    private readonly alpha: number = EWMA_ALPHA,
    private readonly jitterDivisor: number = JITTER_DIVISOR,
  ) {}

  /**
   * Fold in one round-trip measurement.
   *
   * The first sample *seeds* the average rather than being blended into zero.
   * Starting from zero would mean the reported latency climbed from 0 towards the
   * truth over roughly ten samples — twenty seconds of telling the server the
   * connection is faster than it is, which is the wrong direction to be wrong in.
   */
  addSample(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;

    if (this.samples === 0) {
      this.latencyMs = rttMs;
    } else {
      this.latencyMs = this.alpha * rttMs + (1 - this.alpha) * this.latencyMs;
      if (this.lastRtt !== null) {
        const deviation = Math.abs(rttMs - this.lastRtt);
        this.jitterMs += (deviation - this.jitterMs) / this.jitterDivisor;
      }
    }

    this.lastRtt = rttMs;
    this.samples += 1;
  }

  stats(): NetStats {
    return {
      // Rounded to one decimal: the extra precision is noise, and it keeps the
      // reported frame small and readable in devtools.
      latencyMs: round1(this.latencyMs),
      jitterMs: round1(this.jitterMs),
      samples: this.samples,
    };
  }

  /** True once there is anything worth reporting. */
  hasSample(): boolean {
    return this.samples > 0;
  }

  /**
   * Discard all history.
   *
   * Called on reconnect. The measurements describe a network path, and a reconnect
   * usually means that path changed — a different route, a different server
   * instance, or a different network entirely. Carrying the old estimate forward
   * would have the client confidently reporting a number about a connection that no
   * longer exists.
   */
  reset(): void {
    this.latencyMs = 0;
    this.jitterMs = 0;
    this.samples = 0;
    this.lastRtt = null;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Tracks how many frames actually arrived per second, over a trailing window.
 *
 * The UI shows this next to the tier's *target* rate. Showing only the target would
 * be reporting configuration back to the user; showing the measured rate is what
 * demonstrates that the coalescing scheduler is really doing what it claims. They
 * also legitimately differ — the server sends nothing when nothing happened, so a
 * quiet market reads below target, which is correct behaviour rather than a fault.
 */
export class RateMeter {
  private readonly timestamps: number[] = [];

  constructor(private readonly windowMs: number) {}

  mark(now: number): void {
    this.timestamps.push(now);
    this.prune(now);
  }

  ratePerSecond(now: number): number {
    this.prune(now);
    if (this.timestamps.length === 0) return 0;
    return round1((this.timestamps.length / this.windowMs) * 1000);
  }

  reset(): void {
    this.timestamps.length = 0;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.timestamps.length && (this.timestamps[drop] ?? 0) < cutoff) drop += 1;
    if (drop > 0) this.timestamps.splice(0, drop);
  }
}
