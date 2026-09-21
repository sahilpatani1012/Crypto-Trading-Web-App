'use client';

/**
 * The always-visible connection indicator.
 *
 * The brief asks the screen to show "the current connection status", which means
 * when it is healthy as well as when it is not. The stale banner only appears when
 * something is wrong, so on its own it leaves a connected user with nothing to look
 * at and no way to tell a live screen from a frozen one.
 *
 * Deliberately separate from `ConnectionBanner`, because the two do different jobs:
 * this is a compact always-on pill, the banner is a prominent interruption that
 * appears only when the data can no longer be trusted.
 */

import { useEffect, useState } from 'react';
import { useMarketStore, selectStale, isDataStalled } from '@/store/useMarketStore';

export function ConnectionStatus() {
  const status = useMarketStore((s) => s.status);
  const latencyMs = useMarketStore((s) => s.latencyMs);
  const attempt = useMarketStore((s) => s.reconnectAttempt);
  const stale = useMarketStore(selectStale);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const dataStalled = useMarketStore((s) => isDataStalled(s, now));

  // "Connected" and "receiving data" are different claims, and the pill should not
  // make the stronger one when only the weaker is true.
  const { label, tone } = dataStalled
    ? { label: 'no data', tone: 'warn' as const }
    : describe(status, attempt);

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
        tone === 'up'
          ? 'border-up/30 bg-up-soft text-up'
          : tone === 'warn'
            ? 'border-warn/30 bg-warn/10 text-warn'
            : 'border-down/30 bg-down-soft text-down'
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          tone === 'up' ? 'bg-up' : tone === 'warn' ? 'bg-warn animate-pulse' : 'bg-down'
        }`}
      />
      <span className="font-medium uppercase tracking-wide">{label}</span>
      {!stale && !dataStalled && (
        // Latency belongs here rather than only in the tier panel: it is the number
        // that tells you whether "live" means live.
        <span className="num text-ink-dim">{latencyMs.toFixed(0)}ms</span>
      )}
    </div>
  );
}

function describe(status: string, attempt: number): { label: string; tone: 'up' | 'warn' | 'down' } {
  switch (status) {
    case 'open':
      return { label: 'live', tone: 'up' };
    case 'connecting':
      return { label: 'connecting', tone: 'warn' };
    case 'reconnecting':
      return { label: `reconnecting ${attempt}`, tone: 'warn' };
    default:
      return { label: 'offline', tone: 'down' };
  }
}
