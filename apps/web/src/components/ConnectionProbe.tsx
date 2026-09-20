'use client';

/**
 * A temporary end-to-end probe for S2.
 *
 * Its only job is to prove the pipe works — that the deployed frontend can reach
 * the deployed backend over both REST and WSS, and that frames parse against the
 * shared schemas. S4 replaces it with the real `SocketClient` (reconnection,
 * backoff, heartbeat, resubscribe) and the actual trading UI.
 *
 * Deliberately naive: one connection, no reconnection, no stale handling. Those are
 * their own slice precisely because doing them properly is most of the work.
 */

import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_INTERVAL,
  SYMBOL,
  encodeFrame,
  formatPrice,
  parseServerFrame,
  type ServerFrame,
} from '@cta/protocol';
import { API_URL, WS_URL, assertSecureTransport } from '@/lib/config';

type Status = 'connecting' | 'open' | 'closed' | 'error';

interface Probe {
  status: Status;
  counts: Record<string, number>;
  lastPrice: number | null;
  bookSeq: number | null;
  gaps: number;
  rttMs: number | null;
  symbolOk: boolean | null;
  note: string;
}

const INITIAL: Probe = {
  status: 'connecting',
  counts: {},
  lastPrice: null,
  bookSeq: null,
  gaps: 0,
  rttMs: null,
  symbolOk: null,
  note: '',
};

export function ConnectionProbe() {
  const [probe, setProbe] = useState<Probe>(INITIAL);
  const lastSeq = useRef<number | null>(null);

  useEffect(() => {
    assertSecureTransport();
    let cancelled = false;

    // REST reachability, separate from the socket: CORS and the WebSocket upgrade
    // fail in different ways, and knowing which one broke saves a lot of guessing.
    fetch(`${API_URL}/api/symbol`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(() => !cancelled && setProbe((p) => ({ ...p, symbolOk: true })))
      .catch((e: Error) => {
        if (!cancelled) setProbe((p) => ({ ...p, symbolOk: false, note: `REST: ${e.message}` }));
      });

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setProbe((p) => ({ ...p, status: 'open' }));
      ws.send(encodeFrame({ t: 'subscribe', symbol: SYMBOL, interval: DEFAULT_INTERVAL }));
      ws.send(encodeFrame({ t: 'ping', id: 1, clientTime: Date.now() }));
    };

    ws.onmessage = (event) => {
      const result = parseServerFrame(String(event.data));
      if (!result.ok) {
        setProbe((p) => ({ ...p, note: `unparseable frame: ${result.reason}` }));
        return;
      }
      const frame: ServerFrame = result.frame;

      setProbe((p) => {
        const next: Probe = { ...p, counts: { ...p.counts, [frame.t]: (p.counts[frame.t] ?? 0) + 1 } };

        if (frame.t === 'pong') next.rttMs = Date.now() - frame.clientTime;
        if (frame.t === 'trades' && frame.trades.length > 0) {
          next.lastPrice = frame.trades[frame.trades.length - 1]!.p;
        }
        if (frame.t === 'candle') next.lastPrice = frame.candle.c;
        if (frame.t === 'book') {
          // The same contiguity assertion the real order book will make in S5.
          if (lastSeq.current !== null && frame.delta.fromSeq !== lastSeq.current + 1) {
            next.gaps = p.gaps + 1;
          }
          lastSeq.current = frame.delta.toSeq;
          next.bookSeq = frame.delta.toSeq;
        }
        if (frame.t === 'error') next.note = `${frame.code}: ${frame.message}`;
        return next;
      });
    };

    ws.onerror = () => setProbe((p) => ({ ...p, status: 'error' }));
    ws.onclose = () => setProbe((p) => (p.status === 'error' ? p : { ...p, status: 'closed' }));

    // Disposal matters even here. Strict Mode mounts effects twice in development,
    // so without this every reload would leave an orphaned socket behind.
    return () => {
      cancelled = true;
      ws.close();
    };
  }, []);

  const statusColor =
    probe.status === 'open'
      ? 'text-up'
      : probe.status === 'connecting'
        ? 'text-warn'
        : 'text-down';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <span className="text-xs uppercase tracking-wider text-ink-faint">Socket</span>{' '}
          <span className={`num ${statusColor}`}>{probe.status}</span>
        </div>
        <div>
          <span className="text-xs uppercase tracking-wider text-ink-faint">REST</span>{' '}
          <span className={`num ${probe.symbolOk === false ? 'text-down' : 'text-up'}`}>
            {probe.symbolOk === null ? '…' : probe.symbolOk ? 'ok' : 'failed'}
          </span>
        </div>
        <div>
          <span className="text-xs uppercase tracking-wider text-ink-faint">RTT</span>{' '}
          <span className="num text-ink">{probe.rttMs === null ? '…' : `${probe.rttMs}ms`}</span>
        </div>
        <div>
          <span className="text-xs uppercase tracking-wider text-ink-faint">Seq gaps</span>{' '}
          <span className={`num ${probe.gaps > 0 ? 'text-down' : 'text-up'}`}>{probe.gaps}</span>
        </div>
      </div>

      <div className="rounded-lg border border-line-soft bg-surface-1 p-5">
        <div className="text-xs uppercase tracking-wider text-ink-faint">{SYMBOL} last</div>
        <div className="num mt-1 text-4xl font-semibold text-ink">
          {probe.lastPrice === null ? '—' : formatPrice(probe.lastPrice)}
        </div>
        <div className="num mt-1 text-xs text-ink-faint">
          book seq {probe.bookSeq ?? '—'}
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-ink-faint">Frames received</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Object.entries(probe.counts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([type, n]) => (
              <div key={type} className="rounded border border-line-soft bg-surface-1 px-3 py-2">
                <div className="text-xs text-ink-faint">{type}</div>
                <div className="num text-ink">{n}</div>
              </div>
            ))}
        </div>
      </div>

      {probe.note !== '' && <p className="num text-xs text-warn">{probe.note}</p>}
    </div>
  );
}
