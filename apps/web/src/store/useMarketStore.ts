/**
 * Shared application state (D-003).
 *
 * Zustand rather than Context for one concrete reason: the socket client lives
 * outside the React tree and has to push updates in. Zustand's store can be written
 * from anywhere via `getState()`, and read through selectors so only components
 * that care about a changed field re-render.
 *
 * Context would have worked for the writing but not the reading: it has no selector
 * mechanism, so every consumer re-renders whenever the value changes regardless of
 * which part changed. At the rates here that is the whole subtree many times a
 * second — not a micro-optimisation, the difference between a smooth chart and a
 * visibly janky one.
 *
 * ## What is deliberately NOT in here
 *
 * The chart's active candle. It changes up to ten times a second and exactly one
 * component consumes it, so it goes straight from the socket into the chart
 * library's imperative handle and React never learns it happened. The rule: more
 * than one reader means the store; a single reader faster than about 5 Hz means
 * bypass React entirely; everything else is `useState`.
 */

import { create } from 'zustand';
import {
  BOOK_DISPLAY_DEPTH,
  DATA_STALL_TIMEOUT_MS,
  DEFAULT_INTERVAL,
  PRICE_SCALE,
  QTY_SCALE,
  SYMBOL,
  TAPE_LENGTH,
  type IntervalId,
  type Level,
  type Tier,
  type TierFrame,
  type Trade,
} from '@cta/protocol';

import type { ConnectionStatus, SocketClient } from '@/lib/net/socket-client';
import type { BookStats, BookSyncState } from '@/lib/market/order-book-store';

export interface MarketState {
  // --- connection -----------------------------------------------------------
  status: ConnectionStatus;
  reconnectAttempt: number;
  retryInMs: number | null;
  /** Frames the server sent that failed validation. Surfaced in the debug panel. */
  malformedFrames: number;
  /**
   * The last `error` frame the server sent.
   *
   * Without surfacing this, a rejected subscribe leaves the status pill green and
   * the screen simply empty — the app looks connected and healthy while receiving
   * nothing, with no indication why.
   */
  lastError: { code: string; message: string; at: number } | null;

  // --- symbol metadata ------------------------------------------------------
  symbol: string;
  priceScale: number;
  qtyScale: number;
  intervals: string[];

  // --- market ---------------------------------------------------------------
  lastPrice: number | null;
  /** The price before the most recent change, so the UI can colour the direction. */
  previousPrice: number | null;
  /** Server timestamp of the newest data we hold. Drives "last seen" when stale. */
  lastUpdateAt: number | null;
  tape: Trade[];
  tapeDropped: number;

  // --- order book -----------------------------------------------------------
  /** Top levels only. The full book lives in OrderBookStore, outside React. */
  bids: Level[];
  asks: Level[];
  bookState: BookSyncState;
  bookSeq: number;
  bookGaps: number;
  bookResyncs: number;

  // --- delivery -------------------------------------------------------------
  tier: TierFrame | null;
  latencyMs: number;
  jitterMs: number;
  measuredHz: number;

  // --- ui -------------------------------------------------------------------
  interval: IntervalId;

  /**
   * The live client, held here so components can issue debug commands without
   * prop-drilling a ref through the tree. Never read in a selector — it is a stable
   * object reference, not reactive state.
   */
  client: SocketClient | null;
}

export interface MarketActions {
  setStatus: (status: ConnectionStatus, attempt: number, retryInMs: number | null) => void;
  setSymbolInfo: (info: { symbol: string; priceScale: number; qtyScale: number; intervals: string[] }) => void;
  setTier: (tier: TierFrame) => void;
  setNetStats: (stats: { latencyMs: number; jitterMs: number; measuredHz: number }) => void;
  pushTrades: (trades: Trade[], dropped: number, at: number) => void;
  setLastPrice: (price: number, at: number) => void;
  setBook: (bids: Level[], asks: Level[], stats: BookStats) => void;
  noteMalformed: () => void;
  noteData: (at: number) => void;
  setServerError: (code: string, message: string, at: number) => void;
  clearServerError: () => void;
  setInterval: (interval: IntervalId) => void;
  setClient: (client: SocketClient | null) => void;
  reset: () => void;
}

const initial: MarketState = {
  status: 'idle',
  reconnectAttempt: 0,
  retryInMs: null,
  malformedFrames: 0,
  lastError: null,

  symbol: SYMBOL,
  priceScale: PRICE_SCALE,
  qtyScale: QTY_SCALE,
  intervals: [],

  lastPrice: null,
  previousPrice: null,
  lastUpdateAt: null,
  tape: [],
  tapeDropped: 0,

  bids: [],
  asks: [],
  bookState: 'idle',
  bookSeq: 0,
  bookGaps: 0,
  bookResyncs: 0,

  tier: null,
  latencyMs: 0,
  jitterMs: 0,
  measuredHz: 0,

  interval: DEFAULT_INTERVAL,
  client: null,
};

export const useMarketStore = create<MarketState & MarketActions>((set) => ({
  ...initial,

  setStatus: (status, attempt, retryInMs) => set({ status, reconnectAttempt: attempt, retryInMs }),

  setSymbolInfo: (info) => set(info),

  setTier: (tier) =>
    set({
      tier,
      // The tier frame carries the server's view of our reported numbers. Trusting
      // it over the local meter would be circular; these are only used for display
      // when no pong has landed yet.
      latencyMs: tier.latencyMs,
      jitterMs: tier.jitterMs,
    }),

  setNetStats: ({ latencyMs, jitterMs, measuredHz }) => set({ latencyMs, jitterMs, measuredHz }),

  pushTrades: (trades, dropped, at) =>
    set((state) => {
      if (trades.length === 0) {
        return dropped > 0 ? { tapeDropped: state.tapeDropped + dropped } : {};
      }
      const last = trades[trades.length - 1]!;
      // Only move `previousPrice` when the price actually moved.
      //
      // The candle frame of the same flush is sent first and already applied
      // `setLastPrice(candle.c)` — and a candle's close IS the last trade's price.
      // So unconditionally copying `lastPrice` into `previousPrice` here made the
      // two equal on essentially every flush, and the up/down arrow was dead 93% of
      // the time on a screen whose spec requires showing "the latest price and its
      // movement".
      const moved = last.p !== state.lastPrice;
      return {
        // Newest first, bounded. An unbounded tape is a slow memory leak that only
        // shows up after the demo is over.
        tape: [...trades].reverse().concat(state.tape).slice(0, TAPE_LENGTH),
        tapeDropped: state.tapeDropped + dropped,
        previousPrice: moved ? state.lastPrice : state.previousPrice,
        lastPrice: last.p,
        lastUpdateAt: at,
      };
    }),

  setLastPrice: (price, at) =>
    set((state) =>
      state.lastPrice === price
        ? { lastUpdateAt: at }
        : { previousPrice: state.lastPrice, lastPrice: price, lastUpdateAt: at },
    ),

  setBook: (bids, asks, stats) =>
    set({
      bids,
      asks,
      bookState: stats.state,
      bookSeq: stats.lastSeq,
      bookGaps: stats.gaps,
      // The initial fetch is not a resync, so it is not counted as one.
      bookResyncs: Math.max(0, stats.snapshots - 1),
    }),

  noteMalformed: () => set((state) => ({ malformedFrames: state.malformedFrames + 1 })),

  noteData: (at) => set({ lastUpdateAt: at }),

  setServerError: (code, message, at) => set({ lastError: { code, message, at } }),

  clearServerError: () => set({ lastError: null }),

  setInterval: (interval) => set({ interval }),

  setClient: (client) => set({ client }),

  /**
   * Clear market data but keep connection state.
   *
   * Used on resync. The cached values are about to be replaced by a fresh snapshot,
   * and leaving them visible in the meantime would show a mixture of old and new.
   */
  reset: () =>
    set({
      lastPrice: null,
      previousPrice: null,
      lastUpdateAt: null,
      tape: [],
      tapeDropped: 0,
      bids: [],
      asks: [],
    }),
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Whether what is on screen is being kept current.
 *
 * Derived rather than stored, so it cannot drift out of step with the status it is
 * computed from. Everything the UI shows while this is true must be visibly marked
 * as last-known rather than live — a display that cannot distinguish the two is
 * worse than a blank one, because a blank screen does not mislead anyone.
 */
export const selectStale = (s: MarketState): boolean => s.status !== 'open';

export const selectPriceDirection = (s: MarketState): 'up' | 'down' | 'flat' => {
  if (s.lastPrice === null || s.previousPrice === null) return 'flat';
  if (s.lastPrice > s.previousPrice) return 'up';
  if (s.lastPrice < s.previousPrice) return 'down';
  return 'flat';
};

export const selectActiveTier = (s: MarketState): Tier | null => s.tier?.active ?? null;

/**
 * Whether market data has stopped arriving, on a socket that still claims to be up.
 *
 * This is deliberately separate from `selectStale`. The heartbeat detects a dead
 * *peer*; it cannot detect a live peer that has gone silent, because pings would
 * still be answered. Without this the screen just freezes, which reads as a broken
 * app rather than a detected condition — and it is a real production failure mode,
 * not only something the `force stall` debug control produces.
 *
 * Takes `now` explicitly so the caller controls when it is evaluated.
 */
export const isDataStalled = (s: MarketState, now: number): boolean =>
  s.status === 'open' && s.lastUpdateAt !== null && now - s.lastUpdateAt > DATA_STALL_TIMEOUT_MS;

export const selectSpread = (s: MarketState): number | null => {
  const bestBid = s.bids[0]?.[0];
  const bestAsk = s.asks[0]?.[0];
  if (bestBid === undefined || bestAsk === undefined) return null;
  return bestAsk - bestBid;
};

export const BOOK_ROWS = BOOK_DISPLAY_DEPTH;
