import { describe, it, expect } from 'vitest';
import { TIER_DWELL_MS, TIER_THRESHOLDS, type NetStats, type Tier } from '@cta/protocol';

import { TierController } from './tier-controller';
import { VirtualClock } from '../market/clock';

const ORIGIN = 1_726_800_000_000;

function setup(forced: Tier | null = null) {
  const clock = new VirtualClock(ORIGIN);
  const controller = new TierController({ clock, forced });
  return { clock, controller };
}

/** A report producing exactly the requested score, all of it latency. */
function scoreOf(score: number): NetStats {
  return { latencyMs: score, jitterMs: 0, samples: 10 };
}

/** Report, having first let any dwell period elapse. */
function reportAfterDwell(
  controller: TierController,
  clock: VirtualClock,
  score: number,
): ReturnType<TierController['onReport']> {
  clock.advance(TIER_DWELL_MS + 1);
  return controller.onReport(scoreOf(score));
}

describe('TierController — the score', () => {
  it('weights jitter at twice latency', () => {
    const { controller } = setup();
    controller.onReport({ latencyMs: 100, jitterMs: 50, samples: 5 });
    expect(controller.state().score).toBe(200);
  });

  it('starts a fresh connection optimistically at full (D-008)', () => {
    const { controller } = setup();
    expect(controller.active()).toBe('full');
  });

  it('lets the very first report act immediately, without serving a dwell period', () => {
    const { controller } = setup();
    // Dwell starts already elapsed, so a connection that is genuinely bad is
    // demoted within one report interval rather than after five extra seconds.
    const change = controller.onReport(scoreOf(TIER_THRESHOLDS.demoteFromFull + 50));
    expect(change.changed).toBe(true);
    expect(change.active).toBe('degraded');
  });
});

describe('TierController — hysteresis: the deadband', () => {
  it('does not move while the score oscillates inside the deadband', () => {
    const { controller, clock } = setup();
    // Get to degraded first so there is room to move in both directions.
    reportAfterDwell(controller, clock, TIER_THRESHOLDS.demoteFromFull + 20);
    expect(controller.active()).toBe('degraded');

    // Scores between promoteToFull (180) and demoteFromFull (250): ambiguous, and
    // the correct response to ambiguity is to stay put.
    const insideBand = [185, 240, 200, 249, 181, 230];
    for (const score of insideBand) {
      const change = reportAfterDwell(controller, clock, score);
      expect(change.changed, `score ${score} should not move the tier`).toBe(false);
      expect(controller.active()).toBe('degraded');
    }
  });

  it('demotes once the score rises decisively past the boundary', () => {
    const { controller, clock } = setup();
    const change = reportAfterDwell(controller, clock, TIER_THRESHOLDS.demoteFromFull + 1);
    expect(change.changed).toBe(true);
    expect(change.active).toBe('degraded');
  });

  it('will not promote at a score that was enough to demote', () => {
    const { controller, clock } = setup();
    reportAfterDwell(controller, clock, 260); // full -> degraded
    expect(controller.active()).toBe('degraded');

    // 260 demoted us. Symmetric logic would promote us straight back at 249 and the
    // tier would oscillate on noise. The deadband requires a real improvement.
    reportAfterDwell(controller, clock, 249);
    expect(controller.active()).toBe('degraded');

    reportAfterDwell(controller, clock, TIER_THRESHOLDS.promoteToFull - 1);
    expect(controller.active()).toBe('full');
  });

  it('holds the bottom tier until the score improves past its own promote threshold', () => {
    const { controller, clock } = setup();
    reportAfterDwell(controller, clock, 900);
    expect(controller.active()).toBe('minimal');

    reportAfterDwell(controller, clock, TIER_THRESHOLDS.promoteToDegraded + 1);
    expect(controller.active()).toBe('minimal');

    reportAfterDwell(controller, clock, TIER_THRESHOLDS.promoteToDegraded - 1);
    expect(controller.active()).toBe('degraded');
  });
});

describe('TierController — hysteresis: dwell time', () => {
  it('refuses a second change inside the dwell window', () => {
    const { controller, clock } = setup();

    reportAfterDwell(controller, clock, 300);
    expect(controller.active()).toBe('degraded');

    // A wildly bad score arriving one second later must not move the tier again.
    clock.advance(1_000);
    const change = controller.onReport(scoreOf(5_000));
    expect(change.changed).toBe(false);
    expect(change.reason).toContain('dwell');
    expect(controller.active()).toBe('degraded');
  });

  it('allows the change once the dwell window has passed', () => {
    const { controller, clock } = setup();
    reportAfterDwell(controller, clock, 300);

    clock.advance(TIER_DWELL_MS + 1);
    const change = controller.onReport(scoreOf(5_000));
    expect(change.changed).toBe(true);
    expect(change.active).toBe('minimal');
  });

  it('does not flap when the score parks exactly on a threshold', () => {
    // The failure mode the deadband alone cannot fix: a score sitting on the
    // boundary satisfies the transition rule every single time it is evaluated.
    const { controller, clock } = setup();
    const onBoundary = TIER_THRESHOLDS.demoteFromFull;

    let changes = 0;
    for (let i = 0; i < 40; i += 1) {
      clock.advance(1_000);
      if (controller.onReport(scoreOf(onBoundary)).changed) changes += 1;
    }

    // Exactly zero: the score is not *above* the demote threshold, so nothing fires.
    expect(changes).toBe(0);
    expect(controller.active()).toBe('full');
  });

  it('rate-limits changes when the score genuinely swings across the whole range', () => {
    const { controller, clock } = setup();

    let changes = 0;
    // 60 seconds of a score alternating between very good and very bad every second.
    for (let i = 0; i < 60; i += 1) {
      clock.advance(1_000);
      if (controller.onReport(scoreOf(i % 2 === 0 ? 900 : 10)).changed) changes += 1;
    }

    // Without dwell this would be up to 60 changes. With a 5 s dwell it cannot
    // exceed roughly one per dwell period.
    expect(changes).toBeLessThanOrEqual(60_000 / TIER_DWELL_MS + 1);
    expect(changes).toBeGreaterThan(0);
  });
});

describe('TierController — asymmetry: demote fast, promote slowly', () => {
  it('skips a tier when the score is catastrophically bad', () => {
    const { controller, clock } = setup();
    // Being slow to demote actively harms a client that is already drowning: it
    // would keep receiving 10 Hz for another dwell period.
    const change = reportAfterDwell(controller, clock, TIER_THRESHOLDS.demoteFromDegraded + 100);
    expect(change.active).toBe('minimal');
  });

  it('promotes only one tier at a time, however good the score', () => {
    const { controller, clock } = setup();
    reportAfterDwell(controller, clock, 900);
    expect(controller.active()).toBe('minimal');

    // A perfect score does not jump straight to full — recovering eagerly is how
    // flapping starts.
    reportAfterDwell(controller, clock, 1);
    expect(controller.active()).toBe('degraded');

    reportAfterDwell(controller, clock, 1);
    expect(controller.active()).toBe('full');
  });

  it('takes one dwell period to demote two tiers, but two to climb back', () => {
    const { controller, clock } = setup();

    reportAfterDwell(controller, clock, 900);
    expect(controller.active()).toBe('minimal');

    reportAfterDwell(controller, clock, 5);
    reportAfterDwell(controller, clock, 5);
    expect(controller.active()).toBe('full');
  });
});

describe('TierController — missing reports (D-008)', () => {
  it('stays put while reports keep arriving', () => {
    const { controller, clock } = setup();
    for (let i = 0; i < 20; i += 1) {
      clock.advance(4_000);
      controller.onReport(scoreOf(10));
      expect(controller.onTick()).toBeNull();
    }
    expect(controller.active()).toBe('full');
  });

  it('demotes one tier after the silence timeout, not straight to the floor', () => {
    const { controller, clock } = setup();

    clock.advance(11_000);
    expect(controller.onTick()).toBeNull(); // not yet

    clock.advance(2_000); // now past 12s
    const change = controller.onTick();
    expect(change).not.toBeNull();
    expect(change!.active).toBe('degraded');
    expect(change!.reason).toContain('no report');
  });

  it('keeps demoting on continued silence, then stops at minimal', () => {
    const { controller, clock } = setup();

    clock.advance(13_000);
    expect(controller.onTick()!.active).toBe('degraded');

    clock.advance(13_000);
    expect(controller.onTick()!.active).toBe('minimal');

    // Already at the floor: nothing further to say, and no frame should be emitted.
    clock.advance(13_000);
    expect(controller.onTick()).toBeNull();
    expect(controller.active()).toBe('minimal');
  });

  it('resumes normal control as soon as a report arrives again', () => {
    const { controller, clock } = setup();

    clock.advance(13_000);
    controller.onTick();
    clock.advance(13_000);
    controller.onTick();
    expect(controller.active()).toBe('minimal');

    clock.advance(TIER_DWELL_MS + 1);
    controller.onReport(scoreOf(5));
    expect(controller.active()).toBe('degraded');
  });

  it('does not demote for silence when it has been receiving reports', () => {
    const { controller, clock } = setup();
    // Ten seconds of quiet is within tolerance — a single report lost to a GC
    // pause should not be punished.
    clock.advance(4_000);
    controller.onReport(scoreOf(10));
    clock.advance(10_000);
    expect(controller.onTick()).toBeNull();
    expect(controller.active()).toBe('full');
  });
});

describe('TierController — the debug override (D-013)', () => {
  it('pins the active tier', () => {
    const { controller } = setup();
    const change = controller.setForced('minimal');
    expect(change.changed).toBe(true);
    expect(change.active).toBe('minimal');
    expect(change.forced).toBe(true);
  });

  it('keeps evaluating automatically underneath, and reports both', () => {
    const { controller, clock } = setup();
    controller.setForced('minimal');

    clock.advance(TIER_DWELL_MS + 1);
    controller.onReport(scoreOf(5));

    const state = controller.state();
    // This is the proof the requirement is really asking for: the machine is not
    // switched off while pinned, it is overridden, and the UI can show both.
    expect(state.active).toBe('minimal');
    expect(state.auto).toBe('full');
    expect(state.forced).toBe(true);
  });

  it('tracks a deteriorating connection while pinned to a fast tier', () => {
    const { controller, clock } = setup();
    controller.setForced('full');

    clock.advance(TIER_DWELL_MS + 1);
    controller.onReport(scoreOf(900));

    expect(controller.state().active).toBe('full');
    expect(controller.state().auto).toBe('minimal');
  });

  it('resumes automatic control when cleared, acting on the next report immediately', () => {
    const { controller, clock } = setup();
    controller.setForced('minimal');
    clock.advance(TIER_DWELL_MS + 1);
    controller.onReport(scoreOf(5));

    const cleared = controller.setForced(null);
    expect(cleared.forced).toBe(false);
    expect(cleared.active).toBe('full');
    expect(cleared.changed).toBe(true);

    // Dwell was reset on clear, so a bad report right afterwards is acted on rather
    // than serving out a window that elapsed while the machine was not in charge.
    controller.onReport(scoreOf(900));
    expect(controller.active()).toBe('minimal');
  });

  it('applies a tier forced at connect time', () => {
    const { controller } = setup('degraded');
    expect(controller.active()).toBe('degraded');
    expect(controller.state().forced).toBe(true);
    expect(controller.state().auto).toBe('full');
  });

  it('reports the period and rate matching the active tier, not the automatic one', () => {
    const { controller } = setup();
    controller.setForced('minimal');
    const state = controller.state();
    expect(state.periodMs).toBe(1_000);
    expect(state.targetHz).toBe(1);
  });
});
