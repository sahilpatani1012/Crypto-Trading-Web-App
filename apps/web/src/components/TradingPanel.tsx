'use client';

/**
 * The live trading panel — the single `'use client'` boundary in the app.
 *
 * Everything above this in the tree stays a Server Component and ships no
 * JavaScript (D-002). This component owns the connection by calling
 * `useMarketConnection` exactly once; every child reads from the store through
 * selectors and knows nothing about sockets.
 *
 * ## Layout
 *
 * Arranged by how often each thing is looked at. Connection status and price sit in
 * the header because they are glanced at constantly. The chart dominates. The tier
 * panel sits directly *under* the chart rather than off to one side, because the
 * whole point of that feature is watching a tier change affect the chart — the two
 * have to be in view together, especially on camera. The book and the tape are
 * narrow lists, so they share the sidebar, and everything collapses to one column
 * below `lg`.
 */

import { useCallback, useRef } from 'react';
import { INTERVAL_IDS, type IntervalId, type ServerFrame } from '@cta/protocol';

import { useMarketConnection } from '@/hooks/useMarketConnection';
import { useMarketStore, selectStale } from '@/store/useMarketStore';
import { CandleChart, type CandleChartHandle } from './CandleChart';
import { ConnectionBanner } from './ConnectionBanner';
import { ConnectionStatus } from './ConnectionStatus';
import { OrderBook } from './OrderBook';
import { PriceHeader } from './PriceHeader';
import { TierPanel } from './TierPanel';
import { TradeTape } from './TradeTape';

export function TradingPanel() {
  const chartRef = useRef<CandleChartHandle>(null);

  // The order book rebuilds itself inside the connection hook, which owns it. The
  // chart is a component, so it is reloaded through its imperative handle.
  const handleResync = useCallback((_reason: unknown, interval: IntervalId) => {
    chartRef.current?.reload(interval);
  }, []);

  // The 10 Hz path: live candles go from the socket callback straight into the
  // chart's imperative handle. Putting them in state would reconcile the tree ten
  // times a second, on the one interaction the brief says must stay smooth.
  const handleFrame = useCallback((frame: ServerFrame) => {
    if (frame.t === 'candle') chartRef.current?.applyCandle(frame);
  }, []);

  useMarketConnection({ onResync: handleResync, onFrame: handleFrame });

  return (
    <div className="space-y-4">
      <ConnectionBanner />

      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex flex-col items-start gap-2">
          <ConnectionStatus />
          <PriceHeader />
        </div>
        <IntervalSelector />
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <CandleChart ref={chartRef} />
          <TierPanel />
        </div>

        <div className="space-y-4">
          <OrderBook />
          <TradeTape />
        </div>
      </div>
    </div>
  );
}

function IntervalSelector() {
  const interval = useMarketStore((s) => s.interval);
  const client = useMarketStore((s) => s.client);
  const setInterval = useMarketStore((s) => s.setInterval);
  const stale = useMarketStore(selectStale);

  const choose = (next: IntervalId) => {
    // Store first so the control responds immediately, then the client — which
    // resubscribes and raises a resync so anything in flight for the old interval
    // is discarded rather than applied to the new one.
    setInterval(next);
    client?.setInterval(next);
  };

  return (
    <div className="flex gap-1" role="group" aria-label="Candle interval">
      {INTERVAL_IDS.map((id) => (
        <button
          key={id}
          type="button"
          disabled={stale}
          aria-pressed={interval === id}
          onClick={() => choose(id)}
          className={`num rounded border px-3 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${
            interval === id
              ? 'border-accent bg-accent/15 text-ink'
              : 'border-line bg-surface-2 text-ink-dim hover:border-accent hover:text-ink'
          }`}
        >
          {id}
        </button>
      ))}
    </div>
  );
}
