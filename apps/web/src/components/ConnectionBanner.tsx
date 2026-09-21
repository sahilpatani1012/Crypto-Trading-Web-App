'use client';

/**
 * The stale-state banner.
 *
 * Appears whenever the socket is not open. Everything else on screen keeps its last
 * known values — losing the chart and the book entirely would destroy the user's
 * context — but they are dimmed and this banner says plainly that they are not
 * live, and how old they are.
 *
 * Showing cached values as though they were current is the one option that is worse
 * than showing nothing. A blank screen is unhelpful; a stale price presented as live
 * is a lie someone might act on.
 */

import { useEffect, useState } from 'react';
import { useMarketStore, selectStale } from '@/store/useMarketStore';

export function ConnectionBanner() {
  const status = useMarketStore((s) => s.status);
  const attempt = useMarketStore((s) => s.reconnectAttempt);
  const lastUpdateAt = useMarketStore((s) => s.lastUpdateAt);
  const stale = useMarketStore(selectStale);

  // A ticking "last seen" is worth a re-render a second: the number is the whole
  // point of the banner, and a frozen "0s ago" would be its own small lie.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!stale) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [stale]);

  if (!stale) return null;

  const ageSeconds = lastUpdateAt === null ? null : Math.floor((Date.now() - lastUpdateAt) / 1000);

  const message =
    status === 'connecting'
      ? 'Connecting…'
      : status === 'reconnecting'
        ? `Reconnecting (attempt ${attempt})`
        : status === 'closed'
          ? 'Disconnected'
          : 'Not connected';

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm"
    >
      <span className="inline-flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn" />
      <span className="font-medium text-warn">STALE</span>
      <span className="text-ink-dim">{message}</span>
      {ageSeconds !== null && (
        <span className="num text-xs text-ink-faint">
          last update {ageSeconds}s ago
        </span>
      )}
    </div>
  );
}
