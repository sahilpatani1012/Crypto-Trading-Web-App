import { SYMBOL } from '@cta/protocol';
import { ConnectionProbe } from '@/components/ConnectionProbe';

/**
 * S2 scaffold.
 *
 * This page is a Server Component and stays one (D-002): the heading and chrome
 * ship no JavaScript, and the `'use client'` boundary sits on `ConnectionProbe`
 * alone. The real trading screen replaces the probe in S4 through S7 while keeping
 * that same shape.
 */
export default function Page() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-4 py-16">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Transport check</p>
        <h1 className="mt-2 text-3xl font-semibold text-ink">{SYMBOL}</h1>
        <p className="mt-2 text-sm text-ink-dim">
          REST snapshots and a live WebSocket feed, served from one process. The trading UI
          arrives in later slices.
        </p>
      </header>

      <ConnectionProbe />
    </main>
  );
}
