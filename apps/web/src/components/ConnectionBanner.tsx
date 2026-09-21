'use client';

/**
 * The banner that appears when what is on screen cannot be trusted.
 *
 * Three distinct conditions, deliberately kept apart because they mean different
 * things and have different fixes:
 *
 * - **Disconnected** — the socket is not open. Cached values stay visible but dimmed,
 *   with their age, because losing the chart and the book entirely would destroy the
 *   user's context. Showing them as live would be worse than either: a stale price
 *   presented as current is a lie someone might act on.
 * - **No data** — the socket *is* open and pings are being answered, but no market
 *   data has arrived. The heartbeat cannot see this: it detects a dead peer, not a
 *   live peer that has gone silent. Without announcing it the screen simply freezes,
 *   which reads as a broken app rather than a detected condition.
 * - **Server error** — the connection is healthy and the server refused something.
 *   Being connected but rejected is precisely the case that otherwise looks like
 *   success.
 *
 * Paired with `ConnectionStatus`, the always-on compact pill. This one is the
 * interruption.
 */

import { useEffect, useState } from 'react';
import { useMarketStore, selectStale, isDataStalled } from '@/store/useMarketStore';

export function ConnectionBanner() {
  const status = useMarketStore((s) => s.status);
  const attempt = useMarketStore((s) => s.reconnectAttempt);
  const lastUpdateAt = useMarketStore((s) => s.lastUpdateAt);
  const lastError = useMarketStore((s) => s.lastError);
  const stale = useMarketStore(selectStale);

  // One re-render a second, always. The age counters are the whole point of this
  // component, and a frozen "0s ago" would be its own small lie. It is four selector
  // reads and a handful of nodes, so the cost is nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const dataStalled = useMarketStore((s) => isDataStalled(s, now));
  const ageSeconds = lastUpdateAt === null ? null : Math.floor((now - lastUpdateAt) / 1000);

  if (stale) {
    const message =
      status === 'connecting'
        ? 'Connecting…'
        : status === 'reconnecting'
          ? `Reconnecting (attempt ${attempt})`
          : status === 'closed'
            ? 'Disconnected'
            : 'Not connected';

    return (
      <Banner tone="warn" label="STALE" role="status">
        <span className="text-ink-dim">{message}</span>
        {ageSeconds !== null && (
          <span className="num text-xs text-ink-faint">last update {ageSeconds}s ago</span>
        )}
      </Banner>
    );
  }

  if (lastError !== null) {
    return (
      <Banner tone="down" label="SERVER ERROR" role="alert">
        <span className="num text-xs text-ink-faint">{lastError.code}</span>
        <span className="text-ink-dim">{lastError.message}</span>
      </Banner>
    );
  }

  if (dataStalled) {
    return (
      <Banner tone="warn" label="NO DATA" role="status">
        <span className="text-ink-dim">
          Connected, but nothing has arrived for {ageSeconds}s
        </span>
        <span className="num text-xs text-ink-faint">
          the heartbeat will drop the connection if this continues
        </span>
      </Banner>
    );
  }

  return null;
}

function Banner({
  tone,
  label,
  role,
  children,
}: {
  tone: 'warn' | 'down';
  label: string;
  role: 'status' | 'alert';
  children: React.ReactNode;
}) {
  return (
    <div
      role={role}
      aria-live="polite"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2.5 text-sm ${
        tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-down/40 bg-down-soft'
      }`}
    >
      <span
        aria-hidden
        className={`inline-flex h-2 w-2 shrink-0 animate-pulse rounded-full ${
          tone === 'warn' ? 'bg-warn' : 'bg-down'
        }`}
      />
      <span className={`font-medium ${tone === 'warn' ? 'text-warn' : 'text-down'}`}>{label}</span>
      {children}
    </div>
  );
}
