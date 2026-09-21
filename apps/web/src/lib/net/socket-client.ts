/**
 * The WebSocket client.
 *
 * Owns the connection lifecycle: connecting, measuring, reporting, detecting death,
 * reconnecting with backoff, and resubscribing. It is a plain class with no React
 * in it — it reports what happened through callbacks, and the React layer decides
 * what to do with that.
 *
 * ## Detecting a dead connection
 *
 * `onclose` only fires for a *clean* disconnect, where the peer sent a close frame.
 * It does not fire when a router reboots, a laptop lid closes, or a phone enters a
 * tunnel: the peer simply stops existing, no FIN is ever sent, `readyState` stays
 * OPEN, and the UI shows a frozen price indefinitely. That is a half-open TCP
 * connection, and the only way to detect it is to send something and notice that
 * nothing comes back.
 *
 * The ping we already send every two seconds to measure latency doubles as that
 * liveness probe. If no pong has arrived for `HEARTBEAT_TIMEOUT_MS`, the connection
 * is presumed dead however healthy the socket claims to be, and is torn down
 * deliberately so the reconnect path runs.
 *
 * ## Reconnecting without a thundering herd
 *
 * Delays back off exponentially and carry equal jitter. See `reconnectDelay` — the
 * jitter is the part that actually matters, because backoff alone just makes the
 * synchronised waves slower.
 *
 * ## Resynchronising, not resuming
 *
 * A new socket is a new connection with no server-side memory, so the subscription
 * is re-sent. More importantly the market moved while we were away, by an unknown
 * amount, so a reconnect raises a **resync** rather than simply resuming: the order
 * book refetches its snapshot and the chart refetches its history. After a gap of
 * unknown size the only trustworthy source is a fresh snapshot (D-014).
 *
 * The latency estimate is also discarded, because it describes a network path and a
 * reconnect usually means that path changed.
 */

import {
  HEARTBEAT_TIMEOUT_MS,
  PING_INTERVAL_MS,
  RATE_WINDOW_MS,
  REPORT_INTERVAL_MS,
  encodeFrame,
  parseServerFrame,
  reconnectDelay,
  type ClientFrame,
  type IntervalId,
  type NetStats,
  type ServerFrame,
  type Tier,
} from '@cta/protocol';

import { LatencyMeter, RateMeter } from './latency';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Why the client is asking its consumers to rebuild from scratch.
 *
 * All three mean the same thing operationally — "you may have missed an unknown
 * amount, refetch" — but they are distinguished so the UI can explain itself and so
 * tests can assert the right trigger fired.
 */
export type ResyncReason = 'reconnect' | 'visible' | 'interval-change';

/** The slice of a browser WebSocket this client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SocketClientEvents {
  onFrame?: (frame: ServerFrame) => void;
  onStatus?: (status: ConnectionStatus, detail: StatusDetail) => void;
  /** Consumers must discard local state and refetch from REST. */
  onResync?: (reason: ResyncReason, interval: IntervalId) => void;
  onNetStats?: (stats: NetStats & { measuredHz: number }) => void;
  /** A frame that failed schema validation. Counted, not fatal. */
  onMalformed?: (reason: string) => void;
}

export interface StatusDetail {
  attempt: number;
  /** Milliseconds until the next reconnect attempt, when reconnecting. */
  retryInMs: number | null;
}

export interface SocketClientOptions extends SocketClientEvents {
  url: string;
  symbol: string;
  interval: IntervalId;
  /** Injected so tests can drive a fake socket with no network. */
  createSocket?: (url: string) => WebSocketLike;
  now?: () => number;
  random?: () => number;
}

const OPEN = 1;

/**
 * Floor on how often network stats are pushed out.
 *
 * They were previously emitted on every candle frame, which at `full` tier is ten
 * times a second — so the tier panel re-rendered ten times a second to display a
 * *rate*, a number that is an average and cannot be read at that speed anyway. The
 * chart already bypasses React; this was the one place a machine-rate value was
 * still driving a React subtree.
 */
const STATS_EMIT_INTERVAL_MS = 1_000;

/**
 * Round-trip times above this are not measurements.
 *
 * A frozen background tab delivers its queued pong on resume, which measures the
 * freeze rather than the network. So does a forward clock step.
 */
const MAX_PLAUSIBLE_RTT_MS = 30_000;

/**
 * Samples required before the client is willing to report.
 *
 * The jitter estimator needs several samples to mean anything, and `latency.reset()`
 * runs on every reconnect — so a one- or two-sample report systematically understates
 * a bad connection, which is precisely the connection that reconnects most often.
 */
const MIN_SAMPLES_TO_REPORT = 3;

export class SocketClient {
  private readonly opts: SocketClientOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly createSocket: (url: string) => WebSocketLike;

  private ws: WebSocketLike | null = null;
  private status: ConnectionStatus = 'idle';
  private interval: IntervalId;

  private attempt = 0;
  private retryAt: number | null = null;
  private pingId = 0;
  private lastPongAt = 0;
  private lastStatsEmitAt = 0;
  /** When the tab was hidden, so a brief switch does not trigger a full resync. */
  private hiddenAt: number | null = null;

  private readonly latency = new LatencyMeter();
  private readonly rate = new RateMeter(RATE_WINDOW_MS);

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;

  private disposed = false;

  constructor(options: SocketClientOptions) {
    this.opts = options;
    this.interval = options.interval;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.createSocket =
      options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  connect(): void {
    if (this.disposed) return;
    this.installVisibilityHandler();
    this.open();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * True whenever what the UI is displaying is not being kept current.
   *
   * Derived rather than stored, because there is exactly one condition and keeping
   * a second copy of it invites the two disagreeing. A UI that cannot distinguish
   * "current" from "last known" is actively dangerous — someone acting on a price
   * from three minutes ago has been lied to, not merely inconvenienced.
   */
  isStale(): boolean {
    return this.status !== 'open';
  }

  /**
   * Change the subscribed interval.
   *
   * Raises a resync: history for the new interval has to be fetched, and anything
   * still in flight for the old one must not be applied.
   */
  setInterval(interval: IntervalId): void {
    if (this.disposed || interval === this.interval) return;
    this.interval = interval;
    if (this.status === 'open') {
      this.send({ t: 'subscribe', symbol: this.opts.symbol, interval });
    }
    this.opts.onResync?.('interval-change', interval);
  }

  getInterval(): IntervalId {
    return this.interval;
  }

  send(frame: ClientFrame): void {
    if (this.disposed) return;
    const ws = this.ws;
    if (ws === null || ws.readyState !== OPEN) return;
    try {
      ws.send(encodeFrame(frame));
    } catch {
      // A socket can die between the readyState check and the write. The heartbeat
      // will notice; there is nothing useful to do here.
    }
  }

  /** Debug control: pin a tier, or pass null to resume automatic control. */
  forceTier(tier: Tier | null): void {
    this.send({ t: 'setTier', tier });
  }

  /** Debug control: make the server skip our next book delta, forcing a gap. */
  forceGap(): void {
    this.send({ t: 'debug', action: 'dropDelta' });
  }

  /**
   * Debug control: ask the server to close this connection.
   *
   * There is no browser-side equivalent. DevTools' offline emulation blocks new
   * requests but leaves an established WebSocket flowing, so it cannot be used to
   * exercise the reconnect path.
   */
  forceDisconnect(): void {
    this.send({ t: 'debug', action: 'disconnect' });
  }

  /**
   * Debug control: ask the server to go silent without closing.
   *
   * Reproduces a half-open connection — healthy to both operating systems, dead in
   * practice. Only the heartbeat can detect it, after HEARTBEAT_TIMEOUT_MS.
   */
  forceStall(): void {
    this.send({ t: 'debug', action: 'stall' });
  }

  /**
   * Tear everything down.
   *
   * Every timer, the visibility listener and the socket. React Strict Mode mounts
   * effects twice in development specifically to surface incomplete teardown, so
   * anything missed here shows up immediately as a duplicate connection.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();

    if (this.visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    this.detach();
    this.setStatus('closed');
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private open(): void {
    if (this.disposed) return;
    this.detach();
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let ws: WebSocketLike;
    try {
      ws = this.createSocket(this.opts.url);
    } catch {
      // A malformed URL throws synchronously. Treat it as a failed attempt rather
      // than letting it escape — otherwise the very first connect kills the caller.
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;
    ws.onopen = () => this.onOpen();
    ws.onmessage = (event) => this.onMessage(event.data);
    ws.onclose = () => this.onClose();
    ws.onerror = () => {
      // `onerror` is always followed by `onclose`, so reconnection is handled there.
      // Acting on both would double-schedule.
    };
  }

  private onOpen(): void {
    if (this.disposed) return;

    this.attempt = 0;
    this.retryAt = null;
    this.lastPongAt = this.now();
    // The measurements described the previous path. A reconnect usually means that
    // path changed — a different route, a different instance, a different network —
    // so carrying them forward would report confidently about a connection that no
    // longer exists.
    this.latency.reset();
    this.rate.reset();
    this.lastStatsEmitAt = 0;

    this.setStatus('open');
    this.send({ t: 'subscribe', symbol: this.opts.symbol, interval: this.interval });
    this.startTimers();
    this.ping();

    this.opts.onResync?.('reconnect', this.interval);
  }

  private onMessage(raw: unknown): void {
    if (this.disposed) return;

    const result = parseServerFrame(typeof raw === 'string' ? raw : String(raw));
    if (!result.ok) {
      // A malformed frame is an expected condition on a public socket, not an
      // exception. Count it and carry on rather than tearing down a working
      // connection over one bad message.
      this.opts.onMalformed?.(result.reason);
      return;
    }

    const frame = result.frame;
    const now = this.now();

    if (frame.t === 'pong') {
      this.lastPongAt = now;

      // A pong that was queued while the page was frozen is delivered on resume and
      // measures the freeze, not the network — minutes, not milliseconds. Folding
      // that into an EWMA drags the reported latency into the tens of seconds and
      // dumps the connection to `minimal` for a minute afterwards. Above this bound
      // it is not a measurement. The same guard covers a forward clock step, which
      // `LatencyMeter`'s negative check cannot see.
      const rtt = now - frame.clientTime;
      if (rtt <= MAX_PLAUSIBLE_RTT_MS) this.latency.addSample(rtt);

      this.emitNetStats(now);
    }

    // Chart updates are what the tier system rate-limits, so they are what the
    // measured rate counts — but only the *scheduled* ones.
    //
    // A closed candle is flushed immediately, bypassing the cadence by design, so
    // counting it would mix two different things and push the measured rate above
    // its own ceiling. At minimal tier that read "2.0 / 1 Hz": the one number meant
    // to prove the coalescer works was reporting double its target.
    if (frame.t === 'candle') {
      if (!frame.closed) this.rate.mark(now);
      this.emitNetStats(now);
    }

    this.opts.onFrame?.(frame);
  }

  private onClose(): void {
    if (this.disposed) return;
    this.detach();
    this.clearIntervalTimers();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;

    const delay = reconnectDelay(this.attempt, this.random);
    this.attempt += 1;
    this.retryAt = this.now() + delay;
    this.setStatus('reconnecting');

    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  /**
   * Detach handlers before closing.
   *
   * Without this, closing a socket we are replacing fires our own `onclose`, which
   * schedules a reconnect we did not ask for — and during disposal that would
   * resurrect a client the caller just destroyed.
   */
  private detach(): void {
    const ws = this.ws;
    if (ws === null) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    this.ws = null;
    try {
      ws.close();
    } catch {
      // Already closing or closed.
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private startTimers(): void {
    this.clearIntervalTimers();
    this.pingTimer = setInterval(() => this.onPingTick(), PING_INTERVAL_MS);
    this.reportTimer = setInterval(() => this.onReportTick(), REPORT_INTERVAL_MS);
  }

  /**
   * Liveness check first, then the ping.
   *
   * Checking before sending means a connection that stopped answering is torn down
   * on this tick rather than after one more wasted probe.
   *
   * The check is skipped entirely while the tab is hidden. Browsers throttle
   * background timers — often to once a minute — so by the time this runs, the last
   * pong looks far older than the timeout regardless of whether anything is wrong.
   * Acting on that would mean tearing down a perfectly healthy connection because
   * our own timer was late: measuring our throttling and calling it a network
   * failure. Pings still go out, and the clock is reset when the tab returns.
   */
  private onPingTick(): void {
    if (this.disposed || this.status !== 'open') return;

    const hidden = this.hiddenAt !== null;
    if (!hidden && this.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
      // The socket may still claim to be OPEN. It is not.
      this.detach();
      this.clearIntervalTimers();
      this.scheduleReconnect();
      return;
    }

    this.ping();
  }

  private ping(): void {
    this.pingId += 1;
    this.send({ t: 'ping', id: this.pingId, clientTime: this.now() });
  }

  private onReportTick(): void {
    if (this.disposed || this.status !== 'open') return;
    const stats = this.latency.stats();
    if (stats.samples < MIN_SAMPLES_TO_REPORT) return;
    // The client measures and reports; the server owns the tier decision.
    this.send({ t: 'netreport', ...stats });
  }

  private clearIntervalTimers(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.reportTimer !== null) clearInterval(this.reportTimer);
    this.pingTimer = null;
    this.reportTimer = null;
  }

  private clearTimers(): void {
    this.clearIntervalTimers();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // -------------------------------------------------------------------------
  // Browser lifecycle
  // -------------------------------------------------------------------------

  /**
   * Handle the tab being backgrounded and brought back.
   *
   * Nothing is done on hide, deliberately. Browsers throttle background timers, so
   * our pings and reports slow down or stop — and the server's missing-report
   * fallback already interprets that correctly, demoting the connection step by step
   * until it reaches 1 Hz. A tab nobody is looking at ends up costing almost nothing,
   * using a mechanism built for broken connections rather than a special case.
   *
   * On becoming visible we ping immediately, and resync **only if the tab was hidden
   * long enough to matter**. Message delivery is not throttled the way timers are —
   * a hidden tab still receives WebSocket frames — so a quick alt-tab misses
   * nothing, and resyncing on every one would mean a snapshot and a history refetch
   * per tab switch. Past the heartbeat timeout the page may have been frozen
   * outright, at which point we genuinely cannot know what we missed.
   */
  private installVisibilityHandler(): void {
    if (typeof document === 'undefined' || this.visibilityHandler !== null) return;

    // Seed from the current state, not only from future events. A page opened
    // directly into a background tab — a ctrl-click, or a remount while hidden —
    // never fires `visibilitychange`, so `hiddenAt` stayed null and the heartbeat's
    // throttle guard was disabled. Chrome then throttles timers to ~1/min, the last
    // pong always looks older than the six-second timeout, and the client tears down
    // a healthy socket roughly once a minute — each time refetching the book and the
    // whole candle history, forever, because onOpen resets the backoff.
    if (document.visibilityState !== 'visible') this.hiddenAt = this.now();

    this.visibilityHandler = () => {
      if (this.disposed) return;

      if (document.visibilityState !== 'visible') {
        this.hiddenAt = this.now();
        return;
      }

      const hiddenFor = this.hiddenAt === null ? 0 : this.now() - this.hiddenAt;
      this.hiddenAt = null;

      if (this.status === 'open') {
        // Reset the liveness clock before pinging: timers were throttled while
        // hidden, so the last pong may look older than it really is.
        this.lastPongAt = this.now();
        this.ping();
        if (hiddenFor > HEARTBEAT_TIMEOUT_MS) {
          this.opts.onResync?.('visible', this.interval);
        }
      } else if (this.reconnectTimer !== null) {
        // Do not make a returning user sit out a backoff that grew while they were
        // away. Retry now and reset the sequence.
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.attempt = 0;
        this.open();
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  // -------------------------------------------------------------------------
  // Reporting out
  // -------------------------------------------------------------------------

  private lastReportedAttempt = -1;

  /**
   * Report status, and also report a changed attempt count at the same status.
   *
   * Suppressing on the status string alone was a real defect: from the second
   * reconnect attempt onward the string stays `'reconnecting'`, so the store never
   * learned the growing attempt number or the new retry delay. After a ten-minute
   * outage the banner still read "attempt 1" with a 500 ms retry while the real
   * wait was fifteen seconds.
   */
  private setStatus(status: ConnectionStatus): void {
    if (this.status === status && this.attempt === this.lastReportedAttempt) return;
    this.status = status;
    this.lastReportedAttempt = this.attempt;
    this.opts.onStatus?.(status, {
      attempt: this.attempt,
      retryInMs: this.retryAt === null ? null : Math.max(0, this.retryAt - this.now()),
    });
  }

  private emitNetStats(now: number): void {
    if (now - this.lastStatsEmitAt < STATS_EMIT_INTERVAL_MS) return;
    this.lastStatsEmitAt = now;
    this.opts.onNetStats?.({ ...this.latency.stats(), measuredHz: this.rate.ratePerSecond(now) });
  }
}
