'use client';

/**
 * The candlestick chart.
 *
 * The library renders; everything else is ours. We fetch history, we handle the
 * interval switch, we merge the live bar, and we decide what to do with a response
 * that arrives after the user has moved on. `lightweight-charts` receives data and
 * draws pixels — it never touches the network (D-011).
 *
 * ## Two update paths at deliberately different speeds
 *
 * Live candles arrive up to ten times a second. Routing them through React state
 * would reconcile the component tree ten times a second, on the one interaction the
 * brief explicitly says must stay smooth. So the socket callback calls
 * `applyCandle` on this component's imperative handle, which calls
 * `series.update()` directly. React never learns a bar changed.
 *
 * The crosshair readout is the opposite case — it changes at human speed and only
 * when someone is actually pointing at the chart — so it is ordinary `useState`.
 * Both paths live in this one component, which makes the rule concrete: a single
 * consumer above about 5 Hz bypasses React; everything else does not (D-003).
 *
 * ## Responses that arrive too late
 *
 * Switching interval quickly puts several fetches in flight, and the network gives
 * no ordering guarantee. Each request captures a generation counter; a response
 * whose generation is stale is discarded. `AbortController` cancels the network
 * work, but it cannot un-resolve a promise that has already settled and is sitting
 * in the microtask queue — that is what the generation check catches. Neither
 * mechanism covers the other's case.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  CandlestickSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  HISTORY_LIMIT,
  formatPrice,
  formatQty,
  toFloatPrice,
  type Candle,
  type CandleFrame,
  type IntervalId,
} from '@cta/protocol';

import { fetchCandles } from '@/lib/net/rest';
import { useMarketStore, selectStale } from '@/store/useMarketStore';

export interface CandleChartHandle {
  /** Apply a live candle. Called straight from the socket, never via React state. */
  applyCandle: (frame: CandleFrame) => void;
  /** Discard everything and refetch history for `interval`. */
  reload: (interval: IntervalId) => void;
}

type LoadState = 'loading' | 'ready' | 'empty' | 'error';

interface Readout {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  pinned: boolean;
}

/**
 * Chart colours, mirroring the CSS tokens in globals.css.
 *
 * Hardcoded rather than read from computed style: the chart is created in an effect
 * that can run before the stylesheet has painted, and a missing variable would
 * silently render an invisible chart.
 */
const COLORS = {
  up: '#16c784',
  down: '#ea3943',
  background: '#12161f',
  text: '#99a3b5',
  grid: '#1e2532',
  border: '#2a3242',
  crosshair: '#4c8dff',
};

/**
 * Height is set in CSS, not JavaScript.
 *
 * A fixed pixel height would take most of a phone screen, and the obvious
 * alternative — a `useMediaQuery` hook — adds state, a render, and an SSR mismatch
 * risk for something the stylesheet already knows how to express. Instead the
 * container carries responsive height classes and the ResizeObserver applies
 * whatever the browser computed, for both dimensions.
 */
const CONTAINER_CLASS = 'w-full h-[240px] sm:h-[320px] lg:h-[420px]';

export interface CandleChartProps {
  /** Extra classes on the outer section, for layout by the parent. */
  className?: string;
}

export const CandleChart = forwardRef<CandleChartHandle, CandleChartProps>(
  function CandleChart({ className = '' }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

    /** Bumped on every history request; stale responses are discarded. */
    const generationRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    /** The interval the chart currently holds data for. */
    const intervalRef = useRef<IntervalId>(useMarketStore.getState().interval);
    /** Newest bar time in the series, so a late or duplicate bar cannot go backwards. */
    const lastBarRef = useRef<number>(0);
    const readyRef = useRef(false);
    /** Volumes by bar time, for the readout. The chart itself does not need them. */
    const volumesRef = useRef(new Map<number, number>());

    const [state, setState] = useState<LoadState>('loading');
    const [readout, setReadout] = useState<Readout | null>(null);
    const pinnedRef = useRef(false);

    const priceScale = useMarketStore((s) => s.priceScale);
    const qtyScale = useMarketStore((s) => s.qtyScale);
    const stale = useMarketStore(selectStale);

    // -----------------------------------------------------------------------
    // Chart instance
    // -----------------------------------------------------------------------

    useEffect(() => {
      const container = containerRef.current;
      if (container === null) return;

      const chart = createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
          background: { color: COLORS.background },
          textColor: COLORS.text,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: COLORS.grid },
          horzLines: { color: COLORS.grid },
        },
        rightPriceScale: { borderColor: COLORS.border },
        timeScale: {
          borderColor: COLORS.border,
          // Intervals here are seconds, so the default date-only labels would
          // collapse every bar in a minute onto one tick.
          timeVisible: true,
          secondsVisible: true,
        },
        crosshair: {
          mode: 0, // follow the pointer rather than snapping to the nearest bar
          vertLine: { color: COLORS.crosshair, labelBackgroundColor: COLORS.crosshair },
          horzLine: { color: COLORS.crosshair, labelBackgroundColor: COLORS.crosshair },
        },
      });

      const series = chart.addSeries(CandlestickSeries, {
        upColor: COLORS.up,
        downColor: COLORS.down,
        borderUpColor: COLORS.up,
        borderDownColor: COLORS.down,
        wickUpColor: COLORS.up,
        wickDownColor: COLORS.down,
      });

      chartRef.current = chart;
      seriesRef.current = series;

      const readBar = (param: MouseEventParams<Time>): Readout | null => {
        if (param.time === undefined) return null;
        const bar = param.seriesData.get(series) as CandlestickData<Time> | undefined;
        if (bar === undefined) return null;
        const time = param.time as number;
        return {
          time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: volumesRef.current.get(time) ?? null,
          pinned: false,
        };
      };

      // Hover and drag both come through here; on touch, dragging moves the
      // crosshair, which is what makes this work without a separate gesture path.
      const onMove = (param: MouseEventParams<Time>) => {
        if (pinnedRef.current) return;
        setReadout(readBar(param));
      };

      // Click pins the readout so it can be examined without holding the pointer
      // still — clicking again, or off a bar, releases it.
      const onClick = (param: MouseEventParams<Time>) => {
        const bar = readBar(param);
        if (bar === null || pinnedRef.current) {
          pinnedRef.current = false;
          setReadout(bar === null ? null : { ...bar, pinned: false });
          return;
        }
        pinnedRef.current = true;
        setReadout({ ...bar, pinned: true });
      };

      chart.subscribeCrosshairMove(onMove);
      chart.subscribeClick(onClick);

      // The chart does not resize itself. Without this it keeps its initial width
      // forever, which on a responsive layout means it is wrong immediately.
      const observer = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box === undefined || box.width <= 0 || box.height <= 0) return;
        chart.applyOptions({ width: box.width, height: box.height });
      });
      observer.observe(container);

      return () => {
        // Leaking a chart leaks a canvas and a ResizeObserver per mount, and Strict
        // Mode mounts twice — so getting this wrong is visible immediately.
        observer.disconnect();
        chart.unsubscribeCrosshairMove(onMove);
        chart.unsubscribeClick(onClick);
        chart.remove();
        chartRef.current = null;
        seriesRef.current = null;
      };
    }, []);

    // -----------------------------------------------------------------------
    // History
    // -----------------------------------------------------------------------

    const loadHistory = useCallback(
      (interval: IntervalId) => {
        const series = seriesRef.current;
        if (series === null) return;

        const generation = ++generationRef.current;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        intervalRef.current = interval;
        readyRef.current = false;
        lastBarRef.current = 0;
        volumesRef.current.clear();
        setState('loading');
        setReadout(null);
        pinnedRef.current = false;

        const symbol = useMarketStore.getState().symbol;

        fetchCandles(symbol, interval, HISTORY_LIMIT, controller.signal)
          .then((response) => {
            // The user may have switched interval while this was in flight, and the
            // network gives no ordering guarantee. Abort stops the request; this
            // catches a response that had already resolved.
            if (generation !== generationRef.current) return;
            if (seriesRef.current === null) return;

            if (response.candles.length === 0) {
              seriesRef.current.setData([]);
              setState('empty');
              return;
            }

            const bars = response.candles.map((candle) => toBar(candle, priceScale));
            for (const candle of response.candles) {
              volumesRef.current.set(Math.floor(candle.t / 1000), candle.v);
            }

            seriesRef.current.setData(bars);
            lastBarRef.current = bars[bars.length - 1]!.time as number;
            readyRef.current = true;
            setState('ready');
            chartRef.current?.timeScale().fitContent();
          })
          .catch((error: unknown) => {
            if (generation !== generationRef.current) return;
            if (error instanceof DOMException && error.name === 'AbortError') return;
            setState('error');
          });
      },
      [priceScale],
    );

    // -----------------------------------------------------------------------
    // Imperative handle — the 10 Hz path
    // -----------------------------------------------------------------------

    useImperativeHandle(
      ref,
      (): CandleChartHandle => ({
        applyCandle: (frame) => {
          const series = seriesRef.current;
          if (series === null) return;

          // A frame for an interval we are no longer showing. This happens
          // routinely: the server keeps sending the old interval until our
          // resubscribe lands.
          if (frame.interval !== intervalRef.current) return;

          // History has not landed yet. Ignoring is safe because the REST response
          // includes the in-progress bar, so nothing is lost by waiting for it.
          if (!readyRef.current) return;

          const bar = toBar(frame.candle, priceScale);
          const time = bar.time as number;

          // `update` throws if given a bar older than the newest one, which is
          // exactly what a late frame after a reconnect looks like. A bar at the
          // same time is an upsert, so duplicates are idempotent by construction.
          if (time < lastBarRef.current) return;

          volumesRef.current.set(time, frame.candle.v);
          series.update(bar);
          lastBarRef.current = time;

          // Bounded: at 1s bars this would otherwise grow by 3,600 entries an hour.
          if (volumesRef.current.size > HISTORY_LIMIT * 2) {
            const cutoff = time - HISTORY_LIMIT * 60;
            for (const key of volumesRef.current.keys()) {
              if (key < cutoff) volumesRef.current.delete(key);
            }
          }
        },
        reload: (interval) => loadHistory(interval),
      }),
      [loadHistory, priceScale],
    );

    // Initial load. Subsequent loads come from the resync path, which covers both
    // interval changes and reconnects.
    useEffect(() => {
      loadHistory(intervalRef.current);
      return () => abortRef.current?.abort();
    }, [loadHistory]);

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    return (
      <section className={`rounded-lg border border-line-soft bg-surface-1 p-4 ${className}`}>
        <div className="mb-2 flex min-h-[1.5rem] flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-xs uppercase tracking-wider text-ink-faint">
            Chart · {intervalRef.current}
          </h2>
          {readout !== null && (
            <div className="num flex flex-wrap gap-x-3 text-[11px] tabular-nums">
              <span className="text-ink-faint">
                {new Date(readout.time * 1000).toLocaleTimeString([], { hour12: false })}
              </span>
              <Ohlc label="O" value={readout.open} />
              <Ohlc label="H" value={readout.high} />
              <Ohlc label="L" value={readout.low} />
              <Ohlc
                label="C"
                value={readout.close}
                tone={readout.close >= readout.open ? 'up' : 'down'}
              />
              {readout.volume !== null && (
                <span className="text-ink-faint">
                  V <span className="text-ink-dim">{formatQty(readout.volume, qtyScale)}</span>
                </span>
              )}
              {readout.pinned && <span className="text-accent">pinned</span>}
            </div>
          )}
        </div>

        <div className="relative">
          <div ref={containerRef} className={CONTAINER_CLASS} />

          {state !== 'ready' && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface-1/80 text-sm text-ink-dim">
              {state === 'loading' && 'Loading history…'}
              {state === 'empty' && 'No candles for this interval yet'}
              {state === 'error' && (
                <button
                  type="button"
                  onClick={() => loadHistory(intervalRef.current)}
                  className="rounded border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink-dim hover:border-accent hover:text-ink"
                >
                  History failed to load — retry
                </button>
              )}
            </div>
          )}

          {stale && state === 'ready' && (
            <div className="pointer-events-none absolute inset-0 bg-surface-0/50" aria-hidden />
          )}
        </div>

        <p className="mt-2 text-[10px] text-ink-faint">
          Hover or drag to inspect a bar · click to pin
        </p>
      </section>
    );
  },
);

function Ohlc({ label, value, tone }: { label: string; value: number; tone?: 'up' | 'down' }) {
  return (
    <span className="text-ink-faint">
      {label}{' '}
      <span className={tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink'}>
        {value.toFixed(2)}
      </span>
    </span>
  );
}

/**
 * Convert a domain candle into the shape the chart wants.
 *
 * Two conversions happen here and nowhere else: integer ticks become floats, and
 * epoch milliseconds become epoch seconds, which is what the library's
 * `UTCTimestamp` means. Keeping both at this single boundary is what lets the rest
 * of the app stay in exact integers (D-004).
 */
function toBar(candle: Candle, priceScale: number): CandlestickData<Time> {
  return {
    time: Math.floor(candle.t / 1000) as UTCTimestamp,
    open: toFloatPrice(candle.o, priceScale),
    high: toFloatPrice(candle.h, priceScale),
    low: toFloatPrice(candle.l, priceScale),
    close: toFloatPrice(candle.c, priceScale),
  };
}

export { formatPrice };
