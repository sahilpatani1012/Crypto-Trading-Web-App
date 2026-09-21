'use client';

/**
 * Top bids and asks from the locally maintained book.
 *
 * The book itself is reconstructed in `OrderBookStore` outside React; only the
 * top-N sorted levels ever reach the store, so a delta that changes a level nobody
 * can see costs nothing here.
 *
 * The sync state is displayed deliberately rather than hidden. It is what makes
 * recovery visible: pressing "force book gap" should show SYNCED → RESYNCING →
 * SYNCED, with the resync counter incrementing. A book that silently repaired
 * itself would be indistinguishable from one that never noticed.
 */

import { formatPrice, formatQty } from '@cta/protocol';
import { useMarketStore, selectSpread, selectStale } from '@/store/useMarketStore';

export function OrderBook() {
  const bids = useMarketStore((s) => s.bids);
  const asks = useMarketStore((s) => s.asks);
  const bookState = useMarketStore((s) => s.bookState);
  const bookSeq = useMarketStore((s) => s.bookSeq);
  const gaps = useMarketStore((s) => s.bookGaps);
  const resyncs = useMarketStore((s) => s.bookResyncs);
  const priceScale = useMarketStore((s) => s.priceScale);
  const qtyScale = useMarketStore((s) => s.qtyScale);
  const spread = useMarketStore(selectSpread);
  const stale = useMarketStore(selectStale);

  // Depth bars are scaled against the largest single level on either side, so the
  // two halves are visually comparable rather than each normalised to itself.
  const maxQty = Math.max(
    1,
    ...bids.map(([, q]) => q as number),
    ...asks.map(([, q]) => q as number),
  );

  const syncing = bookState === 'snapshotting' || bookState === 'resyncing';

  return (
    <section className={`rounded-lg border border-line-soft bg-surface-1 p-4 ${stale ? 'opacity-50' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs uppercase tracking-wider text-ink-faint">Order book</h2>
        <span
          className={`num text-[10px] uppercase tracking-wide ${
            bookState === 'synced' ? 'text-up' : syncing ? 'text-warn' : 'text-ink-faint'
          }`}
        >
          {bookState}
          {syncing && <span className="ml-1 animate-pulse">•</span>}
        </span>
      </div>

      {bids.length === 0 && asks.length === 0 ? (
        <p className="mt-4 text-xs text-ink-faint">
          {syncing ? 'Fetching snapshot…' : 'No book yet'}
        </p>
      ) : (
        <div className="mt-3">
          <div className="num grid grid-cols-3 gap-2 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Total</span>
          </div>

          {/* Asks render outward from the spread — cheapest seller nearest the
              middle — which is how a book is read. */}
          <BookSide
            levels={[...asks].reverse()}
            side="ask"
            maxQty={maxQty}
            priceScale={priceScale}
            qtyScale={qtyScale}
          />

          <div className="my-1.5 flex items-center justify-between border-y border-line-soft py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-ink-faint">Spread</span>
            <span className="num text-xs text-ink">
              {spread === null ? '—' : formatPrice(spread, priceScale)}
            </span>
          </div>

          <BookSide
            levels={bids}
            side="bid"
            maxQty={maxQty}
            priceScale={priceScale}
            qtyScale={qtyScale}
          />
        </div>
      )}

      <div className="num mt-3 flex flex-wrap gap-x-4 text-[10px] text-ink-faint">
        <span>seq {bookSeq}</span>
        <span className={gaps > 0 ? 'text-warn' : undefined}>gaps {gaps}</span>
        <span>resyncs {resyncs}</span>
      </div>
    </section>
  );
}

function BookSide({
  levels,
  side,
  maxQty,
  priceScale,
  qtyScale,
}: {
  levels: readonly (readonly [number, number])[];
  side: 'bid' | 'ask';
  maxQty: number;
  priceScale: number;
  qtyScale: number;
}) {
  // Cumulative size, accumulated outward from the touch. This is the "how much can
  // I fill before the price moves against me" figure — depth, not value.
  let running = 0;
  const rows = (side === 'ask' ? [...levels].reverse() : levels).map(([price, qty]) => {
    running += qty;
    return { price, qty, total: running };
  });
  const ordered = side === 'ask' ? rows.reverse() : rows;

  return (
    <ul className="num text-xs tabular-nums">
      {ordered.map(({ price, qty, total }) => (
        <li key={price} className="relative grid grid-cols-3 gap-2 py-[1px]">
          <span
            aria-hidden
            className={`absolute inset-y-0 right-0 rounded-sm ${side === 'bid' ? 'bg-up-soft' : 'bg-down-soft'}`}
            style={{ width: `${Math.min(100, (qty / maxQty) * 100)}%` }}
          />
          <span className={`relative ${side === 'bid' ? 'text-up' : 'text-down'}`}>
            {formatPrice(price, priceScale)}
          </span>
          <span className="relative text-right text-ink-dim">{formatQty(qty, qtyScale)}</span>
          <span className="relative text-right text-ink-faint">{formatQty(total, qtyScale)}</span>
        </li>
      ))}
    </ul>
  );
}
