import { SYMBOL } from '@cta/protocol';
import { TradingPanel } from '@/components/TradingPanel';

/**
 * The trading screen.
 *
 * A Server Component, and it stays one (D-002): the heading and chrome ship no
 * JavaScript, and the `'use client'` boundary sits on `TradingPanel` alone. Nothing
 * is fetched here — live market data rendered on the server would be stale before
 * it reached the browser.
 */
export default function Page() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-6">
        <h1 className="sr-only">{SYMBOL} adaptive trading terminal</h1>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">
          Adaptive delivery · simulated market
        </p>
      </header>

      <TradingPanel />
    </main>
  );
}
