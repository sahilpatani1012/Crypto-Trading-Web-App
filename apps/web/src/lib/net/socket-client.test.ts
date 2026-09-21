import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HEARTBEAT_TIMEOUT_MS,
  PING_INTERVAL_MS,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  REPORT_INTERVAL_MS,
  encodeFrame,
  reconnectDelay,
  type ClientFrame,
  type ServerFrame,
} from '@cta/protocol';

import { SocketClient, type ResyncReason, type WebSocketLike } from './socket-client';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * A socket that never touches the network.
 *
 * Every test here drives the connection by hand: open it, feed it frames, kill it,
 * and watch what the client does. With a real WebSocket these tests would need a
 * server, a port, and sleeps — and "does it reconnect after eight seconds" would
 * take eight seconds.
 */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = CONNECTING;
  sent: ClientFrame[] = [];
  closed = false;

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('not open');
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }

  // --- test controls ---

  accept(): void {
    this.readyState = OPEN;
    this.onopen?.({});
  }

  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: encodeFrame(frame) });
  }

  deliverRaw(data: string): void {
    this.onmessage?.({ data });
  }

  /** A clean disconnect: the peer sent a close frame. */
  serverClose(): void {
    this.readyState = CLOSED;
    this.onclose?.({});
  }

  framesOfType<T extends ClientFrame['t']>(type: T): Extract<ClientFrame, { t: T }>[] {
    return this.sent.filter((f): f is Extract<ClientFrame, { t: T }> => f.t === type);
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  static latest(): FakeSocket {
    const last = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (last === undefined) throw new Error('no socket created');
    return last;
  }
}

interface Recorded {
  statuses: string[];
  resyncs: ResyncReason[];
  frames: ServerFrame[];
  malformed: string[];
}

function makeClient(overrides: { random?: () => number } = {}) {
  const recorded: Recorded = { statuses: [], resyncs: [], frames: [], malformed: [] };
  let now = 1_000_000;

  const client = new SocketClient({
    url: 'ws://test/ws',
    symbol: 'BTC-USD',
    interval: '1s',
    createSocket: (url) => new FakeSocket(url),
    now: () => now,
    random: overrides.random ?? (() => 0.5),
    onStatus: (status) => recorded.statuses.push(status),
    onResync: (reason) => recorded.resyncs.push(reason),
    onFrame: (frame) => recorded.frames.push(frame),
    onMalformed: (reason) => recorded.malformed.push(reason),
  });

  /** Advance both the injected clock and the fake timers together. */
  const advance = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };

  return { client, recorded, advance, setNow: (v: number) => (now = v), getNow: () => now };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reconnectDelay — backoff with jitter', () => {
  it('doubles each attempt up to the cap', () => {
    // random() = 1 gives the top of each jitter window, which is the plain backoff.
    const top = (attempt: number) => reconnectDelay(attempt, () => 1);
    expect(top(0)).toBe(RECONNECT_BASE_MS);
    expect(top(1)).toBe(RECONNECT_BASE_MS * 2);
    expect(top(2)).toBe(RECONNECT_BASE_MS * 4);
    expect(top(3)).toBe(RECONNECT_BASE_MS * 8);
    expect(top(20)).toBe(RECONNECT_CAP_MS);
  });

  it('always waits at least half the backoff', () => {
    // Full jitter — random(0, base) — can produce a 5 ms retry, which for a single
    // client is indistinguishable from hammering. Half the delay stays deterministic.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const floor = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_CAP_MS) / 2;
      expect(reconnectDelay(attempt, () => 0)).toBeGreaterThanOrEqual(floor);
    }
  });

  it('spreads clients that failed at the same instant', () => {
    // The part that actually solves a thundering herd. Backoff alone just makes the
    // synchronised waves slower; the randomness is what turns a wave into a drizzle.
    const delays = new Set<number>();
    let seed = 0;
    for (let i = 0; i < 50; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      delays.add(reconnectDelay(3, () => seed / 2147483648));
    }
    expect(delays.size).toBeGreaterThan(30);
  });

  it('never exceeds the cap', () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      expect(reconnectDelay(attempt, () => 1)).toBeLessThanOrEqual(RECONNECT_CAP_MS);
    }
  });
});

describe('SocketClient — connecting', () => {
  it('subscribes as soon as the socket opens', () => {
    const { client } = makeClient();
    client.connect();
    FakeSocket.latest().accept();

    const subscribes = FakeSocket.latest().framesOfType('subscribe');
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0]).toMatchObject({ symbol: 'BTC-USD', interval: '1s' });

    client.dispose();
  });

  it('reports connecting then open', () => {
    const { client, recorded } = makeClient();
    client.connect();
    FakeSocket.latest().accept();

    expect(recorded.statuses).toEqual(['connecting', 'open']);
    client.dispose();
  });

  it('is stale until the socket is open', () => {
    const { client } = makeClient();
    expect(client.isStale()).toBe(true);

    client.connect();
    expect(client.isStale()).toBe(true);

    FakeSocket.latest().accept();
    expect(client.isStale()).toBe(false);

    client.dispose();
  });

  it('pings immediately rather than waiting a full interval', () => {
    const { client } = makeClient();
    client.connect();
    FakeSocket.latest().accept();
    expect(FakeSocket.latest().framesOfType('ping')).toHaveLength(1);
    client.dispose();
  });
});

describe('SocketClient — measuring and reporting', () => {
  it('sends a ping on the configured interval', () => {
    const { client, advance } = makeClient();
    client.connect();
    const ws = FakeSocket.latest();
    ws.accept();

    // Each ping is answered, or the heartbeat would declare the connection dead.
    for (let i = 0; i < 3; i += 1) {
      const ping = ws.framesOfType('ping').at(-1)!;
      ws.deliver({ t: 'pong', id: ping.id, clientTime: ping.clientTime, serverTime: 0 });
      advance(PING_INTERVAL_MS);
    }

    expect(ws.framesOfType('ping').length).toBeGreaterThanOrEqual(4);
    client.dispose();
  });

  it('reports latency and jitter, not raw samples', () => {
    const { client, advance, getNow } = makeClient();
    client.connect();
    const ws = FakeSocket.latest();
    ws.accept();

    for (let i = 0; i < 6; i += 1) {
      const ping = ws.framesOfType('ping').at(-1)!;
      // Answer 40ms after the ping was sent.
      ws.deliver({ t: 'pong', id: ping.id, clientTime: getNow() - 40, serverTime: 0 });
      advance(PING_INTERVAL_MS);
    }

    const report = ws.framesOfType('netreport').at(-1);
    expect(report).toBeDefined();
    expect(report!.latencyMs).toBeGreaterThan(30);
    expect(report!.latencyMs).toBeLessThan(50);
    expect(report!.samples).toBeGreaterThan(1);

    client.dispose();
  });

  it('does not report before it has measured anything', () => {
    const { client, advance } = makeClient();
    client.connect();
    const ws = FakeSocket.latest();
    ws.accept();

    // No pongs delivered, so nothing has been measured. Reporting zeros would tell
    // the server this is the fastest connection it has ever seen.
    advance(REPORT_INTERVAL_MS + 100);
    expect(ws.framesOfType('netreport')).toHaveLength(0);

    client.dispose();
  });
});

describe('SocketClient — detecting a dead connection', () => {
  it('reconnects after a clean close', () => {
    const { client, recorded, advance } = makeClient();
    client.connect();
    FakeSocket.latest().accept();

    FakeSocket.latest().serverClose();
    expect(recorded.statuses.at(-1)).toBe('reconnecting');

    advance(RECONNECT_CAP_MS);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);

    client.dispose();
  });

  it('tears down a half-open socket the browser still calls OPEN', () => {
    // The case `onclose` cannot cover: a router reboots or a lid closes and the peer
    // vanishes without a FIN. readyState stays OPEN and the UI would show a frozen
    // price forever. Only silence gives it away.
    const { client, advance } = makeClient();
    client.connect();
    const ws = FakeSocket.latest();
    ws.accept();

    expect(ws.readyState).toBe(OPEN);

    // Stop answering. Never fire onclose.
    advance(HEARTBEAT_TIMEOUT_MS + PING_INTERVAL_MS + 100);

    expect(client.getStatus()).toBe('reconnecting');
    expect(ws.closed).toBe(true);

    client.dispose();
  });

  it('stays connected while pongs keep arriving', () => {
    const { client, advance, getNow } = makeClient();
    client.connect();
    const ws = FakeSocket.latest();
    ws.accept();

    for (let i = 0; i < 20; i += 1) {
      const ping = ws.framesOfType('ping').at(-1)!;
      ws.deliver({ t: 'pong', id: ping.id, clientTime: getNow(), serverTime: 0 });
      advance(PING_INTERVAL_MS);
    }

    expect(client.getStatus()).toBe('open');
    expect(FakeSocket.instances).toHaveLength(1);

    client.dispose();
  });

  it('backs off further with each consecutive failure', () => {
    const { client, advance } = makeClient({ random: () => 1 });
    client.connect();

    const attemptsAfter = (ms: number) => {
      advance(ms);
      return FakeSocket.instances.length;
    };

    // Never accept: every attempt fails immediately.
    FakeSocket.latest().serverClose();
    const afterFirst = attemptsAfter(RECONNECT_BASE_MS + 10);
    FakeSocket.latest().serverClose();

    // The second wait is longer than the first, so the same elapsed time no longer
    // produces an attempt.
    advance(RECONNECT_BASE_MS);
    expect(FakeSocket.instances.length).toBe(afterFirst);

    advance(RECONNECT_BASE_MS * 2);
    expect(FakeSocket.instances.length).toBeGreaterThan(afterFirst);

    client.dispose();
  });
});

describe('SocketClient — resynchronising after a gap', () => {
  it('raises a resync when the connection opens', () => {
    const { client, recorded } = makeClient();
    client.connect();
    FakeSocket.latest().accept();

    // A new socket means the market moved by an unknown amount while we were away.
    // After a gap of unknown size the only trustworthy source is a fresh snapshot.
    expect(recorded.resyncs).toEqual(['reconnect']);
    client.dispose();
  });

  it('resubscribes and resyncs again after a reconnect', () => {
    const { client, recorded, advance } = makeClient();
    client.connect();
    FakeSocket.latest().accept();
    FakeSocket.latest().serverClose();

    advance(RECONNECT_CAP_MS);
    FakeSocket.latest().accept();

    expect(FakeSocket.latest().framesOfType('subscribe')).toHaveLength(1);
    expect(recorded.resyncs).toEqual(['reconnect', 'reconnect']);

    client.dispose();
  });

  it('discards the latency estimate on reconnect', () => {
    const { client, advance, getNow } = makeClient();
    client.connect();
    let ws = FakeSocket.latest();
    ws.accept();

    // Build up an estimate of a slow connection.
    for (let i = 0; i < 8; i += 1) {
      const ping = ws.framesOfType('ping').at(-1)!;
      ws.deliver({ t: 'pong', id: ping.id, clientTime: getNow() - 400, serverTime: 0 });
      advance(PING_INTERVAL_MS);
    }
    expect(ws.framesOfType('netreport').at(-1)!.latencyMs).toBeGreaterThan(300);

    ws.serverClose();
    advance(RECONNECT_CAP_MS);
    ws = FakeSocket.latest();
    ws.accept();

    // The measurement described a network path, and a reconnect usually means that
    // path changed. Carrying it forward would report confidently about a connection
    // that no longer exists.
    for (let i = 0; i < 4; i += 1) {
      const ping = ws.framesOfType('ping').at(-1)!;
      ws.deliver({ t: 'pong', id: ping.id, clientTime: getNow() - 20, serverTime: 0 });
      advance(PING_INTERVAL_MS);
    }
    expect(ws.framesOfType('netreport').at(-1)!.latencyMs).toBeLessThan(60);

    client.dispose();
  });

  it('resubscribes and resyncs on an interval change', () => {
    const { client, recorded } = makeClient();
    client.connect();
    const ws = FakeSocket.latest();
    ws.accept();
    recorded.resyncs.length = 0;

    client.setInterval('5s');

    expect(ws.framesOfType('subscribe').at(-1)).toMatchObject({ interval: '5s' });
    expect(recorded.resyncs).toEqual(['interval-change']);

    client.dispose();
  });

  it('ignores an interval change to the interval already selected', () => {
    const { client, recorded } = makeClient();
    client.connect();
    FakeSocket.latest().accept();
    recorded.resyncs.length = 0;

    client.setInterval('1s');
    expect(recorded.resyncs).toEqual([]);

    client.dispose();
  });
});

describe('SocketClient — bad input', () => {
  it('survives a malformed frame and keeps the connection', () => {
    const { client, recorded } = makeClient();
    client.connect();
    const ws = FakeSocket.latest();
    ws.accept();

    ws.deliverRaw('not json at all');
    ws.deliverRaw('{"t":"nonsense"}');
    ws.deliverRaw('{"t":"candle"}');

    expect(recorded.malformed).toHaveLength(3);
    expect(client.getStatus()).toBe('open');
    expect(recorded.frames).toHaveLength(0);

    client.dispose();
  });

  it('does not throw when sending on a closed socket', () => {
    const { client } = makeClient();
    client.connect();
    FakeSocket.latest().accept();
    FakeSocket.latest().serverClose();

    expect(() => client.forceTier('minimal')).not.toThrow();
    client.dispose();
  });
});

describe('SocketClient — disposal', () => {
  it('closes the socket and stops every timer', () => {
    const { client, advance } = makeClient();
    client.connect();
    const ws = FakeSocket.latest();
    ws.accept();

    client.dispose();

    expect(ws.closed).toBe(true);
    const sentAtDispose = ws.sent.length;

    // Nothing should fire afterwards: no pings, no reports, and crucially no
    // reconnect — a disposed client must stay disposed.
    advance(60_000);
    expect(ws.sent).toHaveLength(sentAtDispose);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('does not reconnect when disposed while waiting to retry', () => {
    const { client, advance } = makeClient();
    client.connect();
    FakeSocket.latest().accept();
    FakeSocket.latest().serverClose();

    client.dispose();
    advance(60_000);

    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('is safe to dispose twice', () => {
    const { client } = makeClient();
    client.connect();
    FakeSocket.latest().accept();
    client.dispose();
    expect(() => client.dispose()).not.toThrow();
  });

  it('does not schedule a reconnect from the close it causes itself', () => {
    // Detaching handlers before closing matters: otherwise tearing down a socket we
    // are replacing fires our own onclose and schedules an unwanted reconnect.
    const { client, advance } = makeClient();
    client.connect();
    FakeSocket.latest().accept();

    client.dispose();
    advance(RECONNECT_CAP_MS * 2);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.getStatus()).toBe('closed');
  });
});
