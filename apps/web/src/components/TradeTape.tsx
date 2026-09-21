'use client';

/**
 * Recent trades, newest first.
 *
 * The tape is bounded in the store rather than here — an unbounded list is a slow
 * memory leak that only shows up long after a demo is over.
 *
 * If the server had to drop prints to cap a frame, the count is shown rather than
 * hidden. A tape that silently omits trades looks exactly like a quiet market, and
 * saying so is the difference between incomplete and wrong.
 */

import { formatPrice, formatQty } from '@cta/protocol';
import { useMarketStore, selectStale } from '@/store/useMarketStore';

export function TradeTape() {
  const tape = useMarketStore((s) => s.tape);
  const dropped = useMarketStore((s) => s.tapeDropped);
  const priceScale = useMarketStore((s) => s.priceScale);
  const qtyScale = useMarketStore((s) => s.qtyScale);
  const stale = useMarketStore(selectStale);

  return (
    <section className={`rounded-lg border border-line-soft bg-surface-1 p-4 ${stale ? 'opacity-50' : ''}`}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs uppercase tracking-wider text-ink-faint">Recent trades</h2>
        {dropped > 0 && (
          <span className="num text-[10px] text-warn" title="Trades the server dropped to cap a frame">
            {dropped} dropped
          </span>
        )}
      </div>

      {tape.length === 0 ? (
        <p className="mt-3 text-xs text-ink-faint">No trades yet</p>
      ) : (
        <div className="mt-3">
          <div className="num grid grid-cols-3 gap-2 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Time</span>
          </div>
          {/* Fixed height with its own scroll: a list that grows the page would make
              the whole layout jump every time a trade printed. */}
          <ul className="num max-h-64 space-y-0.5 overflow-y-auto text-xs tabular-nums">
            {tape.map((trade) => (
              <li key={trade.id} className="grid grid-cols-3 gap-2">
                <span className={trade.side === 'buy' ? 'text-up' : 'text-down'}>
                  {formatPrice(trade.p, priceScale)}
                </span>
                <span className="text-right text-ink-dim">{formatQty(trade.q, qtyScale)}</span>
                <span className="text-right text-ink-faint">
                  {new Date(trade.ts).toLocaleTimeString([], { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
