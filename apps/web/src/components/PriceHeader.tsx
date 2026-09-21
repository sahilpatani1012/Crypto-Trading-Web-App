'use client';

/**
 * Symbol, latest price, and which way it moved.
 *
 * Dims itself while stale, so the colour that normally means "the price just moved"
 * cannot be mistaken for live movement when nothing is arriving.
 */

import { formatPrice } from '@cta/protocol';
import { useMarketStore, selectPriceDirection, selectStale } from '@/store/useMarketStore';

export function PriceHeader() {
  const symbol = useMarketStore((s) => s.symbol);
  const lastPrice = useMarketStore((s) => s.lastPrice);
  const priceScale = useMarketStore((s) => s.priceScale);
  const direction = useMarketStore(selectPriceDirection);
  const stale = useMarketStore(selectStale);

  const directionClass =
    stale || direction === 'flat' ? 'text-ink' : direction === 'up' ? 'text-up' : 'text-down';

  return (
    <div className={stale ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
      <div className="text-xs uppercase tracking-[0.2em] text-ink-faint">{symbol}</div>
      <div className="mt-1 flex items-baseline gap-3">
        {/* Tabular figures: without them every digit change reflows the number and
            the whole header jitters at the update rate. */}
        <span className={`num text-4xl font-semibold tabular-nums ${directionClass}`}>
          {lastPrice === null ? '—' : formatPrice(lastPrice, priceScale)}
        </span>
        {!stale && direction !== 'flat' && (
          <span className={`text-lg ${directionClass}`} aria-hidden>
            {direction === 'up' ? '▲' : '▼'}
          </span>
        )}
      </div>
    </div>
  );
}
