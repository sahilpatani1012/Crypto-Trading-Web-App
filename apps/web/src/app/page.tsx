import { SYMBOL, INTERVAL_IDS, TIERS, TIER_TARGET_HZ } from '@cta/protocol';

/**
 * S0 scaffold. This page stays a Server Component; the live panel arrives in S4
 * behind a single `'use client'` boundary.
 */
export default function Page() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-4 py-16">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Scaffold</p>
        <h1 className="mt-2 text-3xl font-semibold text-ink">{SYMBOL}</h1>
        <p className="mt-2 text-sm text-ink-dim">
          Workspace resolves and the shared protocol contract imports cleanly on both sides.
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line-soft bg-surface-1 p-4">
          <dt className="text-xs uppercase tracking-wider text-ink-faint">Intervals</dt>
          <dd className="num mt-1 text-ink">{INTERVAL_IDS.join(' · ')}</dd>
        </div>
        <div className="rounded-lg border border-line-soft bg-surface-1 p-4">
          <dt className="text-xs uppercase tracking-wider text-ink-faint">Delivery tiers</dt>
          <dd className="num mt-1 text-ink">
            {TIERS.map((tier) => `${tier} ${TIER_TARGET_HZ[tier]}Hz`).join(' · ')}
          </dd>
        </div>
      </dl>
    </main>
  );
}
