/**
 * The per-connection delivery tier state machine.
 *
 * The client measures its own latency and jitter and reports them; this class owns
 * the decision of what those numbers mean. The spec is explicit that the backend
 * owns the tier, and this is where that lives.
 *
 * Everything here is driven by an injected clock, so the tests advance time
 * instantly instead of sleeping through five-second dwell periods.
 *
 * ## One score, not two thresholds
 *
 *     score = latency + 2 × jitter
 *
 * Collapsing both measurements into one scalar makes the machine one-dimensional,
 * which is what makes it explainable and exhaustively testable. Separate latency and
 * jitter thresholds would mean four quadrants and a rule for each.
 *
 * Jitter is doubled because it predicts the thing the tier system exists to protect.
 * A steady 200 ms connection feels responsive — everything arrives late but evenly,
 * and the chart advances smoothly. A 50 ms connection varying by ±150 ms feels
 * broken, because updates arrive in clumps and the chart stutters.
 *
 * ## Hysteresis, two mechanisms (D-007)
 *
 * **Deadband** — demote above one threshold, promote only below a distinctly lower
 * one. **Dwell** — no further change for 5 s after any change. Each covers the
 * other's hole: a deadband alone still flaps if the score oscillates slowly across
 * the whole band, since every individual transition is legitimate; dwell alone still
 * flaps if the score parks exactly on a threshold, merely rate-limiting it.
 *
 * ## Asymmetry: demote fast, promote slowly
 *
 * Demotion may skip a tier — a score of 900 takes a connection straight from `full`
 * to `minimal`. Promotion is always one step.
 *
 * Being slow to demote actively harms a struggling client: it keeps receiving 10 Hz
 * for another dwell period while it is already drowning. Being quick to promote only
 * risks flapping back. The costs are not symmetric, so the responses should not be
 * either. This is the same shape as TCP congestion control's multiplicative decrease
 * with additive increase.
 */

import {
  MISSING_REPORT_TIMEOUT_MS,
  TIER_DWELL_MS,
  TIER_PERIOD_MS,
  TIER_TARGET_HZ,
  TIER_THRESHOLDS,
  tierScore,
  type NetStats,
  type Tier,
} from '@cta/protocol';

import type { Clock } from '../market/clock';

export interface TierState {
  /** What the connection is actually being served at. */
  active: Tier;
  /** What the state machine would choose right now, ignoring any override. */
  auto: Tier;
  forced: boolean;
  targetHz: number;
  periodMs: number;
  score: number;
  latencyMs: number;
  jitterMs: number;
  /** Short human-readable explanation of the last evaluation. */
  reason: string;
}

export interface TierChange extends TierState {
  /** True when `active` differs from what it was before this evaluation. */
  changed: boolean;
}

export interface TierControllerOptions {
  clock: Clock;
  /** Applied at connect time from `?tier=`, for scripted demos (D-013). */
  forced?: Tier | null;
  dwellMs?: number;
  missingReportTimeoutMs?: number;
}

export class TierController {
  private readonly clock: Clock;
  private readonly dwellMs: number;
  private readonly missingReportTimeoutMs: number;

  private auto: Tier = 'full';
  private forced: Tier | null;

  private latencyMs = 0;
  private jitterMs = 0;
  private score = 0;
  private reason = 'initial';

  private lastChangeAt: number;
  private lastReportAt: number;
  private reportCount = 0;

  constructor(options: TierControllerOptions) {
    this.clock = options.clock;
    this.dwellMs = options.dwellMs ?? TIER_DWELL_MS;
    this.missingReportTimeoutMs = options.missingReportTimeoutMs ?? MISSING_REPORT_TIMEOUT_MS;
    this.forced = options.forced ?? null;

    const now = this.clock.now();
    // Dwell starts elapsed, deliberately. A fresh connection begins at `full`
    // optimistically — it carries no evidence of being bad — and the cost of that
    // optimism is bounded because the first report arrives within one report
    // interval and can act on it immediately (D-008).
    this.lastChangeAt = now - this.dwellMs;
    this.lastReportAt = now;
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /** A `netreport` frame arrived. */
  onReport(report: NetStats): TierChange {
    const now = this.clock.now();
    this.latencyMs = report.latencyMs;
    this.jitterMs = report.jitterMs;
    this.score = tierScore(report.latencyMs, report.jitterMs);
    this.lastReportAt = now;
    this.reportCount += 1;

    return this.evaluate(now);
  }

  /**
   * Called on every scheduler tick. Handles the case where reports stop arriving.
   *
   * Silence is ambiguous — a wedged client, a saturated uplink, a backgrounded tab —
   * but every reading of it argues for sending less, so degrading is the safe
   * response under all of them. One step at a time rather than straight to minimal,
   * because a single report lost to a GC pause should not be punished as though the
   * connection had collapsed.
   *
   * Returns null when nothing changed, so the caller can avoid emitting a frame.
   */
  onTick(): TierChange | null {
    const now = this.clock.now();
    if (now - this.lastReportAt < this.missingReportTimeoutMs) return null;

    // Restart the silence clock so the next demotion is another full timeout away
    // rather than firing on every subsequent tick.
    this.lastReportAt = now;

    const next = oneWorse(this.auto);
    if (next === this.auto && this.forced === null) {
      // Already at the floor; nothing to report.
      return null;
    }

    const before = this.active();
    this.auto = next;
    this.lastChangeAt = now;
    this.reason = `no report for ${Math.round(this.missingReportTimeoutMs / 1000)}s`;

    return this.change(before);
  }

  /**
   * Debug override (D-013). A tier pins the connection; null releases it.
   *
   * The controller keeps consuming reports and keeps computing `auto` while pinned,
   * and the UI shows both. That is what demonstrates the automatic machinery is
   * still running underneath rather than switched off, which is precisely what the
   * requirement is guarding against.
   */
  setForced(tier: Tier | null): TierChange {
    const before = this.active();
    this.forced = tier;

    if (tier === null) {
      // Resume automatic control with dwell already elapsed, so the next report
      // acts immediately rather than serving out a dwell period that passed while
      // the tier was pinned and the machine was not in charge.
      this.lastChangeAt = this.clock.now() - this.dwellMs;
      this.reason = 'override cleared';
    } else {
      this.reason = `forced to ${tier}`;
    }

    return this.change(before);
  }

  // -------------------------------------------------------------------------
  // Outputs
  // -------------------------------------------------------------------------

  active(): Tier {
    return this.forced ?? this.auto;
  }

  periodMs(): number {
    return TIER_PERIOD_MS[this.active()];
  }

  state(): TierState {
    const active = this.active();
    return {
      active,
      auto: this.auto,
      forced: this.forced !== null,
      targetHz: TIER_TARGET_HZ[active],
      periodMs: TIER_PERIOD_MS[active],
      score: round1(this.score),
      latencyMs: round1(this.latencyMs),
      jitterMs: round1(this.jitterMs),
      reason: this.reason,
    };
  }

  reportsReceived(): number {
    return this.reportCount;
  }

  // -------------------------------------------------------------------------
  // The decision
  // -------------------------------------------------------------------------

  private evaluate(now: number): TierChange {
    const before = this.active();

    // Dwell is checked before the thresholds, not after. A change is forbidden
    // during the dwell window regardless of how the score looks, which is what
    // stops a score sitting exactly on a boundary from toggling every report.
    if (now - this.lastChangeAt < this.dwellMs) {
      this.reason = 'holding (dwell)';
      return this.change(before);
    }

    const target = targetFor(this.auto, this.score);
    if (target === this.auto) {
      this.reason = `stable (score ${round1(this.score)})`;
      return this.change(before);
    }

    this.reason =
      rank(target) > rank(this.auto)
        ? `demoted (score ${round1(this.score)})`
        : `promoted (score ${round1(this.score)})`;
    this.auto = target;
    this.lastChangeAt = now;

    return this.change(before);
  }

  private change(before: Tier): TierChange {
    return { ...this.state(), changed: this.active() !== before };
  }
}

const ORDER: Tier[] = ['full', 'degraded', 'minimal'];

function rank(tier: Tier): number {
  return ORDER.indexOf(tier);
}

function oneWorse(tier: Tier): Tier {
  return ORDER[Math.min(rank(tier) + 1, ORDER.length - 1)] ?? tier;
}

/**
 * Where the score says this connection belongs, given where it currently is.
 *
 * This is deliberately *not* a pure function of the score — it cannot be, because
 * the deadband means the answer depends on which side we approached from. A score of
 * 200 keeps a `full` connection at full and keeps a `degraded` one degraded; that
 * ambiguity zone is the hysteresis.
 *
 * Demotions may skip a tier; promotions move one step. See the class comment.
 */
function targetFor(current: Tier, score: number): Tier {
  switch (current) {
    case 'full':
      // Demotion may skip a tier: a catastrophic score goes straight to minimal
      // rather than spending a dwell period at degraded while the client drowns.
      if (score > TIER_THRESHOLDS.demoteFromDegraded) return 'minimal';
      if (score > TIER_THRESHOLDS.demoteFromFull) return 'degraded';
      return 'full';

    case 'degraded':
      if (score > TIER_THRESHOLDS.demoteFromDegraded) return 'minimal';
      // Promotion requires clearing a distinctly lower bar than the one that
      // demoted us. Anything between the two is the deadband: ambiguous, and the
      // right answer to ambiguity is to stay put.
      if (score < TIER_THRESHOLDS.promoteToFull) return 'full';
      return 'degraded';

    case 'minimal':
      // One step at a time, however good the score. Recovering eagerly is how
      // flapping starts, and the cost of being slow to promote is small.
      return score < TIER_THRESHOLDS.promoteToDegraded ? 'degraded' : 'minimal';
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
