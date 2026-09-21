'use client';

/**
 * The live trading panel — the single `'use client'` boundary in the app.
 *
 * Everything above this in the tree stays a Server Component and ships no
 * JavaScript (D-002). This component owns the connection by calling
 * `useMarketConnection` exactly once; every child reads from the store through
 * selectors and knows nothing about sockets.
 *
 * The chart and the order book join in S5 and S6, hanging their refetch off the
 * `onResync` callback already wired here.
 */

import { useCallback, useRef } from 'react';
import { INTERVAL_IDS, type IntervalId, type ServerFrame } from '@cta/protocol';

import { useMarketConnection } from '@/hooks/useMarketConnection';
import { useMarketStore, selectStale } from '@/store/useMarketStore';
import { CandleChart, type CandleChartHandle } from './CandleChart';
import { ConnectionBanner } from './ConnectionBanner';
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
    <div className="space-y-5">
      <ConnectionBanner />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <PriceHeader />
        <IntervalSelector />
      </div>

      <CandleChart ref={chartRef} />

      <TierPanel />

      <div className="grid gap-5 lg:grid-cols-2">
        <OrderBook />
        <TradeTape />
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
          className={`num rounded border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
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
