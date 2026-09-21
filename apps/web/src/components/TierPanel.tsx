'use client';

/**
 * The delivery tier readout and its debug controls.
 *
 * Shows four things the spec asks to be exposed: the active tier, the effective
 * update rate, the measurements driving the decision, and — while an override is
 * active — what the state machine *would* have chosen. That last one is what
 * demonstrates the automatic behaviour is still running underneath rather than
 * switched off.
 *
 * The rate is displayed as measured against target. Showing only the target would
 * be echoing configuration back at the user; the measured figure is what proves the
 * coalescing scheduler is real. The two legitimately differ — the server sends
 * nothing when nothing happened, so a quiet market reads below target.
 */

import { TIERS, type Tier } from '@cta/protocol';
import { useMarketStore, selectStale } from '@/store/useMarketStore';

export function TierPanel() {
  const tier = useMarketStore((s) => s.tier);
  const latencyMs = useMarketStore((s) => s.latencyMs);
  const jitterMs = useMarketStore((s) => s.jitterMs);
  const measuredHz = useMarketStore((s) => s.measuredHz);
  const malformed = useMarketStore((s) => s.malformedFrames);
  const client = useMarketStore((s) => s.client);
  const stale = useMarketStore(selectStale);

  const forced = tier?.forced === true;

  return (
    <section className="rounded-lg border border-line-soft bg-surface-1 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-ink-faint">Delivery tier</h2>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num text-2xl font-semibold text-ink">{tier?.active ?? '—'}</span>
            {forced && (
              <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warn">
                forced
              </span>
            )}
          </div>
          {forced && (
            <div className="num mt-1 text-xs text-ink-dim">
              automatic would choose <span className="text-ink">{tier?.auto}</span>
            </div>
          )}
        </div>

        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-ink-faint">Effective rate</div>
          <div className="num mt-1 text-2xl font-semibold text-ink tabular-nums">
            {measuredHz.toFixed(1)}
            <span className="text-base font-normal text-ink-faint"> / {tier?.targetHz ?? '—'} Hz</span>
          </div>
        </div>
      </div>

      <dl className="num mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <Metric label="Latency" value={`${latencyMs.toFixed(1)}ms`} />
        <Metric label="Jitter" value={`${jitterMs.toFixed(1)}ms`} />
        <Metric label="Score" value={tier === null ? '—' : tier.score.toFixed(0)} />
        <Metric label="Bad frames" value={String(malformed)} tone={malformed > 0 ? 'warn' : 'dim'} />
      </dl>

      <p className="num mt-2 text-xs text-ink-faint">{tier?.reason ?? 'waiting for first report'}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {TIERS.map((t: Tier) => (
          <button
            key={t}
            type="button"
            disabled={stale}
            onClick={() => client?.forceTier(t)}
            className={`rounded border px-3 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${
              forced && tier?.active === t
                ? 'border-accent bg-accent/15 text-ink'
                : 'border-line bg-surface-2 text-ink-dim hover:border-accent hover:text-ink'
            }`}
          >
            force {t}
          </button>
        ))}
        <button
          type="button"
          disabled={stale}
          onClick={() => client?.forceTier(null)}
          className={`rounded border px-3 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${
            tier !== null && !forced
              ? 'border-accent bg-accent/15 text-ink'
              : 'border-line bg-surface-2 text-ink-dim hover:border-accent hover:text-ink'
          }`}
        >
          automatic
        </button>
        <button
          type="button"
          disabled={stale}
          onClick={() => client?.forceGap()}
          title="Server skips this connection's next book delta, forcing a sequence gap"
          className="rounded border border-down/40 bg-down-soft px-3 py-1.5 text-xs text-down transition-colors hover:border-down focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          force book gap
        </button>
        <button
          type="button"
          disabled={stale}
          onClick={() => client?.forceDisconnect()}
          title="Server closes this connection. DevTools' offline mode cannot do this — it blocks new requests but leaves an established WebSocket flowing"
          className="rounded border border-down/40 bg-down-soft px-3 py-1.5 text-xs text-down transition-colors hover:border-down focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          force disconnect
        </button>
        <button
          type="button"
          disabled={stale}
          onClick={() => client?.forceStall()}
          title="Server goes silent without closing — a half-open connection. Only the client heartbeat can detect it, after 6s"
          className="rounded border border-warn/40 bg-warn/10 px-3 py-1.5 text-xs text-warn transition-colors hover:border-warn focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          force stall
        </button>
      </div>
    </section>
  );
}

function Metric({ label, value, tone = 'dim' }: { label: string; value: string; tone?: 'dim' | 'warn' }) {
  return (
    <div>
      <dt className="text-ink-faint">{label}</dt>
      <dd className={tone === 'warn' ? 'text-warn' : 'text-ink'}>{value}</dd>
    </div>
  );
}
