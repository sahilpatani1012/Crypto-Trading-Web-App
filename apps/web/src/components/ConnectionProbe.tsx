'use client';

/**
 * End-to-end probe for the adaptive delivery pipeline.
 *
 * Measures round-trip time, reports latency and jitter to the server, and displays
 * the tier the server assigns along with the *measured* delivery rate. The forced
 * tier buttons exercise the debug override, and the gap button forces a book
 * sequence discontinuity so recovery can be demonstrated without real packet loss.
 *
 * Still deliberately naive about connection lifecycle: one socket, no reconnection,
 * no stale handling. S4 replaces this with the real `SocketClient` and the trading
 * UI; the measurement and reporting logic here moves across unchanged, because it
 * already lives in `lib/net/latency.ts` with no React in it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_INTERVAL,
  PING_INTERVAL_MS,
  RATE_WINDOW_MS,
  REPORT_INTERVAL_MS,
  SYMBOL,
  TIERS,
  encodeFrame,
  formatPrice,
  parseServerFrame,
  type ServerFrame,
  type Tier,
} from '@cta/protocol';
import { API_URL, WS_URL, assertSecureTransport } from '@/lib/config';
import { LatencyMeter, RateMeter } from '@/lib/net/latency';

type Status = 'connecting' | 'open' | 'closed' | 'error';

interface Probe {
  status: Status;
  counts: Record<string, number>;
  lastPrice: number | null;
  bookSeq: number | null;
  gaps: number;
  latencyMs: number;
  jitterMs: number;
  measuredHz: number;
  tier: Extract<ServerFrame, { t: 'tier' }> | null;
  symbolOk: boolean | null;
  note: string;
}

const INITIAL: Probe = {
  status: 'connecting',
  counts: {},
  lastPrice: null,
  bookSeq: null,
  gaps: 0,
  latencyMs: 0,
  jitterMs: 0,
  measuredHz: 0,
  tier: null,
  symbolOk: null,
  note: '',
};

export function ConnectionProbe() {
  const [probe, setProbe] = useState<Probe>(INITIAL);
  const socketRef = useRef<WebSocket | null>(null);
  const lastSeq = useRef<number | null>(null);

  const send = useCallback((frame: Parameters<typeof encodeFrame>[0]) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame));
  }, []);

  useEffect(() => {
    assertSecureTransport();
    let cancelled = false;

    // REST reachability is checked separately from the socket: CORS failures and
    // WebSocket upgrade failures look completely different, and knowing which one
    // broke saves a lot of guessing.
    fetch(`${API_URL}/api/symbol`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(() => !cancelled && setProbe((p) => ({ ...p, symbolOk: true })))
      .catch((e: Error) => {
        if (!cancelled) setProbe((p) => ({ ...p, symbolOk: false, note: `REST: ${e.message}` }));
      });

    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;

    const latency = new LatencyMeter();
    // Chart updates are the thing being rate-limited, so that is what the measured
    // rate counts — not every frame, which would include pongs and tier echoes.
    const rate = new RateMeter(RATE_WINDOW_MS);
    let pingId = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let reportTimer: ReturnType<typeof setInterval> | undefined;

    ws.onopen = () => {
      setProbe((p) => ({ ...p, status: 'open' }));
      ws.send(encodeFrame({ t: 'subscribe', symbol: SYMBOL, interval: DEFAULT_INTERVAL }));

      const ping = () => {
        pingId += 1;
        ws.send(encodeFrame({ t: 'ping', id: pingId, clientTime: Date.now() }));
      };
      ping();
      pingTimer = setInterval(ping, PING_INTERVAL_MS);

      // The client measures and reports; the server owns the tier decision.
      reportTimer = setInterval(() => {
        if (!latency.hasSample()) return;
        const stats = latency.stats();
        ws.send(encodeFrame({ t: 'netreport', ...stats }));
      }, REPORT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      const result = parseServerFrame(String(event.data));
      if (!result.ok) {
        setProbe((p) => ({ ...p, note: `unparseable frame: ${result.reason}` }));
        return;
      }
      const frame: ServerFrame = result.frame;
      const now = Date.now();

      if (frame.t === 'pong') latency.addSample(now - frame.clientTime);
      if (frame.t === 'candle') rate.mark(now);

      setProbe((p) => {
        const next: Probe = { ...p, counts: { ...p.counts, [frame.t]: (p.counts[frame.t] ?? 0) + 1 } };

        switch (frame.t) {
          case 'pong': {
            const stats = latency.stats();
            next.latencyMs = stats.latencyMs;
            next.jitterMs = stats.jitterMs;
            break;
          }
          case 'trades':
            if (frame.trades.length > 0) next.lastPrice = frame.trades[frame.trades.length - 1]!.p;
            break;
          case 'candle':
            next.lastPrice = frame.candle.c;
            next.measuredHz = rate.ratePerSecond(now);
            break;
          case 'book':
            // The same contiguity assertion the real order book makes in S5.
            if (lastSeq.current !== null && frame.delta.fromSeq !== lastSeq.current + 1) {
              next.gaps = p.gaps + 1;
              next.note = `gap: expected ${lastSeq.current + 1}, got ${frame.delta.fromSeq}`;
            }
            lastSeq.current = frame.delta.toSeq;
            next.bookSeq = frame.delta.toSeq;
            break;
          case 'tier':
            next.tier = frame;
            break;
          case 'error':
            next.note = `${frame.code}: ${frame.message}`;
            break;
        }
        return next;
      });
    };

    ws.onerror = () => setProbe((p) => ({ ...p, status: 'error' }));
    ws.onclose = () => setProbe((p) => (p.status === 'error' ? p : { ...p, status: 'closed' }));

    // Disposal matters even here. Strict Mode mounts effects twice in development,
    // so without this every reload would leave an orphaned socket and two live
    // timers behind.
    return () => {
      cancelled = true;
      clearInterval(pingTimer);
      clearInterval(reportTimer);
      socketRef.current = null;
      ws.close();
    };
  }, []);

  const statusColor =
    probe.status === 'open' ? 'text-up' : probe.status === 'connecting' ? 'text-warn' : 'text-down';

  const tier = probe.tier;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
        <Stat label="Socket" value={probe.status} className={statusColor} />
        <Stat
          label="REST"
          value={probe.symbolOk === null ? '…' : probe.symbolOk ? 'ok' : 'failed'}
          className={probe.symbolOk === false ? 'text-down' : 'text-up'}
        />
        <Stat label="Latency" value={`${probe.latencyMs}ms`} />
        <Stat label="Jitter" value={`${probe.jitterMs}ms`} />
        <Stat
          label="Seq gaps"
          value={String(probe.gaps)}
          className={probe.gaps > 0 ? 'text-down' : 'text-up'}
        />
      </div>

      <div className="rounded-lg border border-line-soft bg-surface-1 p-5">
        <div className="text-xs uppercase tracking-wider text-ink-faint">{SYMBOL} last</div>
        <div className="num mt-1 text-4xl font-semibold text-ink">
          {probe.lastPrice === null ? '—' : formatPrice(probe.lastPrice)}
        </div>
        <div className="num mt-1 text-xs text-ink-faint">book seq {probe.bookSeq ?? '—'}</div>
      </div>

      <div className="rounded-lg border border-line-soft bg-surface-1 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-ink-faint">Delivery tier</div>
            <div className="num mt-1 text-2xl font-semibold text-ink">
              {tier?.active ?? '—'}
              {tier?.forced === true && <span className="ml-2 text-sm text-warn">forced</span>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider text-ink-faint">Rate</div>
            {/* Measured against target: showing only the target would be echoing
                configuration back. Measured below target during a quiet market is
                correct — the server sends nothing when nothing happened. */}
            <div className="num mt-1 text-ink">
              {probe.measuredHz}
              <span className="text-ink-faint"> / {tier?.targetHz ?? '—'} Hz</span>
            </div>
          </div>
        </div>

        <div className="num mt-3 text-xs text-ink-dim">
          score {tier?.score ?? '—'} · auto {tier?.auto ?? '—'} · {tier?.reason ?? 'waiting'}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {TIERS.map((t: Tier) => (
            <button
              key={t}
              type="button"
              onClick={() => send({ t: 'setTier', tier: t })}
              className={`rounded border px-3 py-1.5 text-xs transition-colors ${
                tier?.forced === true && tier.active === t
                  ? 'border-accent bg-accent/15 text-ink'
                  : 'border-line bg-surface-2 text-ink-dim hover:border-accent hover:text-ink'
              }`}
            >
              force {t}
            </button>
          ))}
          <button
            type="button"
            onClick={() => send({ t: 'setTier', tier: null })}
            className="rounded border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink-dim transition-colors hover:border-accent hover:text-ink"
          >
            auto
          </button>
          <button
            type="button"
            onClick={() => send({ t: 'debug', action: 'dropDelta' })}
            className="rounded border border-down/40 bg-down-soft px-3 py-1.5 text-xs text-down transition-colors hover:border-down"
          >
            force gap
          </button>
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

function Stat({ label, value, className = 'text-ink' }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <span className="text-xs uppercase tracking-wider text-ink-faint">{label}</span>{' '}
      <span className={`num ${className}`}>{value}</span>
    </div>
  );
}
