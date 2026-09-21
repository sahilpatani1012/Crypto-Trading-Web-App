'use client';

/**
 * The single bridge between the socket client and React.
 *
 * Creates one `SocketClient`, routes its callbacks into the Zustand store, and
 * tears everything down on unmount. Nothing else in the app constructs a client, so
 * there is exactly one connection and exactly one place where the lifecycle is
 * managed.
 *
 * Strict Mode mounts effects twice in development, which is deliberate: it surfaces
 * incomplete teardown immediately. The cleanup here disposes the client, which
 * closes the socket and clears every timer and listener, so the second mount starts
 * from nothing. In development you will see connect → disconnect → connect once on
 * load; in production it connects once.
 */

import { useEffect, useRef } from 'react';
import { BOOK_DISPLAY_DEPTH, type IntervalId, type ServerFrame } from '@cta/protocol';

import { assertSecureTransport, WS_URL } from '@/lib/config';
import { fetchDepth, fetchSymbolInfo } from '@/lib/net/rest';
import { SocketClient, type ResyncReason } from '@/lib/net/socket-client';
import { OrderBookStore } from '@/lib/market/order-book-store';
import { useMarketStore } from '@/store/useMarketStore';

export interface MarketConnectionHandlers {
  /**
   * Raised when local state must be rebuilt from REST rather than resumed.
   *
   * After a disconnect, an interval change, or a period with throttled timers, the
   * amount missed is unknown — and after a gap of unknown size the only trustworthy
   * source is a fresh snapshot. The order book and the chart both hang their
   * refetch off this.
   */
  onResync?: (reason: ResyncReason, interval: IntervalId) => void;
  /** Every validated inbound frame, for consumers that need the raw stream. */
  onFrame?: (frame: ServerFrame) => void;
}

export function useMarketConnection(handlers: MarketConnectionHandlers = {}): void {
  // Handlers are captured in a ref so a caller passing inline arrows does not tear
  // down and rebuild the connection on every render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    assertSecureTransport();

    const store = useMarketStore.getState();

    /**
     * The order book lives here rather than in a component, because it is part of
     * "being connected to the market": it has to receive every delta in order, and
     * it has to rebuild whenever the connection does. Only its top-N ever reaches
     * React.
     */
    const book = new OrderBookStore({
      fetchSnapshot: (signal) => fetchDepth(store.symbol, undefined, signal),
      onChange: () => publishBook(),
      onState: () => publishBook(),
    });

    const publishBook = () => {
      const { bids, asks } = book.top(BOOK_DISPLAY_DEPTH);
      useMarketStore.getState().setBook(bids, asks, book.stats());
    };

    const client = new SocketClient({
      url: WS_URL,
      symbol: store.symbol,
      interval: store.interval,

      onStatus: (status, detail) => {
        useMarketStore.getState().setStatus(status, detail.attempt, detail.retryInMs);
      },

      onNetStats: (stats) => {
        useMarketStore.getState().setNetStats(stats);
      },

      onMalformed: () => {
        useMarketStore.getState().noteMalformed();
      },

      onResync: (reason, interval) => {
        // Drop cached market values: they are about to be replaced, and showing a
        // mixture of old and new during the refetch would be its own kind of lie.
        useMarketStore.getState().reset();
        // Rebuild the book from a fresh snapshot rather than waiting for gap
        // detection to notice. We already know updates were missed; starting now
        // saves a round trip and a window of showing a knowingly stale book.
        book.start(reason === 'reconnect' ? 'reconnect' : 'initial');
        handlersRef.current.onResync?.(reason, interval);
      },

      onFrame: (frame) => {
        // Book deltas go to the reconciler, never to React. Only the derived top-N
        // is published, and only when the visible book actually changed.
        if (frame.t === 'book') {
          book.applyDelta(frame.delta);
          // Counts as market data arriving, so a stream carrying only book updates
          // is not mistaken for a stalled one.
          useMarketStore.getState().noteData(Date.now());
        }
        routeFrame(frame);
        handlersRef.current.onFrame?.(frame);
      },
    });

    useMarketStore.getState().setClient(client);
    client.connect();

    // Symbol metadata is also available over the socket's `hello` frame; fetching
    // it over REST as well means the scales are known even if the socket is slow to
    // open, and it doubles as a reachability check that fails differently from a
    // WebSocket upgrade failure — which makes a broken deployment much faster to
    // diagnose.
    const controller = new AbortController();
    fetchSymbolInfo(controller.signal)
      .then((info) => useMarketStore.getState().setSymbolInfo(info))
      .catch(() => {
        // The socket is the primary path; a failed metadata fetch is not fatal.
      });

    return () => {
      controller.abort();
      client.dispose();
      book.dispose();
      useMarketStore.getState().setClient(null);
    };
  }, []);
}

/**
 * Fold a frame into the store.
 *
 * Only frames that several components read land here. Candle frames are handled by
 * the chart directly, off the store, because at 10 Hz routing them through React
 * would re-render the tree ten times a second (D-003).
 */
function routeFrame(frame: ServerFrame): void {
  const store = useMarketStore.getState();

  switch (frame.t) {
    case 'hello':
      store.setSymbolInfo({
        symbol: frame.symbol,
        priceScale: frame.priceScale,
        qtyScale: frame.qtyScale,
        intervals: frame.intervals,
      });
      break;

    case 'tier':
      store.setTier(frame);
      break;

    case 'subscribed':
      // A successful subscribe clears any earlier rejection: whatever was wrong
      // has been resolved, and leaving the message up would be its own small lie.
      store.clearServerError();
      break;

    case 'error':
      // Surfaced rather than swallowed. A rejected subscribe otherwise leaves the
      // screen connected, green, and empty, with nothing to explain it.
      store.setServerError(frame.code, frame.message, Date.now());
      break;

    case 'trades':
      store.pushTrades(frame.trades, frame.dropped, Date.now());
      break;

    case 'candle':
      // The close price is cheap to mirror and several components want the latest
      // price even when no trade has printed since the last flush.
      store.setLastPrice(frame.candle.c, Date.now());
      break;

    default:
      break;
  }
}
