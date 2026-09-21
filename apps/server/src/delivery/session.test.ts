import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TIER_DWELL_MS,
  TIER_THRESHOLDS,
  encodeFrame,
  parseClientFrame,
  type Candle,
  type ServerFrame,
  type Tier,
} from '@cta/protocol';

import { ClientSession, type SocketLike } from './session';
import { MarketEngine } from '../market/engine';
import { VirtualClock } from '../market/clock';

const ORIGIN = 1_726_800_000_000;
const TICK_MS = 50;

/**
 * A socket that records instead of transmitting.
 *
 * This is the payoff from narrowing the session's dependency to four members: the
 * delivery layer is tested with no `ws` instance, no HTTP server and no open port,
 * so assertions about *which frames left and when* are a matter of reading an array
 * rather than racing a network.
 */
class FakeSocket implements SocketLike {
  sent: ServerFrame[] = [];
  bufferedAmount = 0;
  isOpen = true;
  throwOnSend = false;

  send(data: string): void {
    if (this.throwOnSend) throw new Error('socket gone');
    this.sent.push(JSON.parse(data) as ServerFrame);
  }

  close(): void {
    this.isOpen = false;
  }

  framesOfType<T extends ServerFrame['t']>(type: T): Extract<ServerFrame, { t: T }>[] {
    return this.sent.filter((f): f is Extract<ServerFrame, { t: T }> => f.t === type);
  }

  clear(): void {
    this.sent = [];
  }
}

function setup(forcedTier: Tier | null = null) {
  const clock = new VirtualClock(ORIGIN);
  const engine = new MarketEngine({ seed: 4242, clock });
  const socket = new FakeSocket();
  const session = new ClientSession({ id: 'test', socket, engine, clock, forcedTier });
  return { clock, engine, socket, session };
}

/**
 * Advance simulated time.
 *
 * Both clocks move together: the engine's virtual clock so trades are generated,
 * and vitest's fake timers so the delivery scheduler's intervals actually fire.
 * Advancing only one would either produce no market data or never deliver it.
 */
function run(engine: MarketEngine, clock: VirtualClock, ms: number): void {
  const steps = Math.floor(ms / TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    clock.advance(TICK_MS);
    engine.advanceTo(clock.now());
    vi.advanceTimersByTime(TICK_MS);
  }
}

/** Parse the way the transport does, so tests exercise the real validation path. */
function feed(session: ClientSession, socket: FakeSocket, raw: unknown): void {
  const result = parseClientFrame(raw);
  if (!result.ok) session.rejectFrame(result.reason);
  else session.handleFrame(result.frame);
}

function subscribe(interval = '1s'): string {
  return encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval });
}

describe('ClientSession — handshake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('greets with the scales a client needs before it can render anything', () => {
    const { socket, session } = setup();
    session.greet();

    const [hello] = socket.framesOfType('hello');
    expect(hello).toBeDefined();
    expect(hello!.symbol).toBe('BTC-USD');
    // Without these, 6543210 cannot be turned into "$65,432.10".
    expect(hello!.priceScale).toBe(2);
    expect(hello!.qtyScale).toBe(8);
    expect(hello!.intervals).toContain('1s');
    // The tier indicator has something to render from the first frame.
    expect(socket.framesOfType('tier')).toHaveLength(1);
  });

  it('answers a ping inline, echoing clientTime untouched', () => {
    const { socket, session, clock } = setup();
    clock.set(ORIGIN + 5_000);
    feed(session, socket, encodeFrame({ t: 'ping', id: 9, clientTime: 12_345 }));

    const [pong] = socket.framesOfType('pong');
    expect(pong).toBeDefined();
    expect(pong!.id).toBe(9);
    // Echoed verbatim: the client computes `now - clientTime`, so only the
    // difference matters and clock skew between the two machines cancels out.
    expect(pong!.clientTime).toBe(12_345);
    expect(pong!.serverTime).toBe(ORIGIN + 5_000);
  });

  it('answers a ping immediately even at the slowest tier', () => {
    // A measurement path must never run through the thing it is measuring. If the
    // pong were queued behind a 1 Hz scheduler it would add up to a second of
    // phantom latency, and the client would report itself into an even slower tier.
    const { socket, session } = setup('minimal');
    feed(session, socket, subscribe());
    socket.clear();

    feed(session, socket, encodeFrame({ t: 'ping', id: 1, clientTime: 100 }));
    expect(socket.framesOfType('pong')).toHaveLength(1);
  });
});

describe('ClientSession — subscription', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('confirms the subscription and seeds the live candle immediately', () => {
    const { engine, clock, socket, session } = setup();
    run(engine, clock, 3_000);
    socket.clear();

    feed(session, socket, subscribe());

    expect(socket.framesOfType('subscribed')).toHaveLength(1);
    // Seeded rather than waiting for the next trade — at the 1m interval that
    // could otherwise be most of a minute of blank chart.
    expect(socket.framesOfType('candle').length).toBeGreaterThanOrEqual(1);
    expect(socket.framesOfType('tier')).toHaveLength(1);
  });

  it('streams only the subscribed interval', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, subscribe('5s'));
    socket.clear();

    run(engine, clock, 20_000);

    const candles = socket.framesOfType('candle');
    expect(candles.length).toBeGreaterThan(5);
    expect(candles.every((c) => c.interval === '5s')).toBe(true);
  });

  it('emits book deltas with no sequence gaps', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, subscribe());
    socket.clear();

    run(engine, clock, 5_000);

    const books = socket.framesOfType('book');
    expect(books.length).toBeGreaterThan(5);
    for (let i = 1; i < books.length; i += 1) {
      expect(books[i]!.delta.fromSeq).toBe(books[i - 1]!.delta.toSeq + 1);
    }
  });
});

describe('ClientSession — coalescing is real', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends far fewer frames at minimal than at full over the same market', () => {
    const clock = new VirtualClock(ORIGIN);
    const engine = new MarketEngine({ seed: 777, clock });

    const fastSocket = new FakeSocket();
    const slowSocket = new FakeSocket();
    const fast = new ClientSession({ id: 'f', socket: fastSocket, engine, clock, forcedTier: 'full' });
    const slow = new ClientSession({ id: 's', socket: slowSocket, engine, clock, forcedTier: 'minimal' });

    feed(fast, fastSocket, subscribe());
    feed(slow, slowSocket, subscribe());
    fastSocket.clear();
    slowSocket.clear();

    run(engine, clock, 20_000);

    const fastBooks = fastSocket.framesOfType('book').length;
    const slowBooks = slowSocket.framesOfType('book').length;

    expect(fastBooks).toBeGreaterThan(slowBooks * 3);

    fast.close();
    slow.close();
  });

  it('never loses a trade, however slow the tier', () => {
    // Coalescing batches the tape; it does not sample it. Losing prints would be
    // the difference between "fewer updates" and "wrong data".
    const clock = new VirtualClock(ORIGIN);
    const engine = new MarketEngine({ seed: 555, clock });
    const socket = new FakeSocket();
    const session = new ClientSession({ id: 's', socket, engine, clock, forcedTier: 'minimal' });

    feed(session, socket, subscribe());
    const emitted: number[] = [];
    const off = engine.events.on('trade', (t) => emitted.push(t.id));
    socket.clear();

    run(engine, clock, 15_000);
    off();

    const delivered = socket.framesOfType('trades').flatMap((f) => f.trades.map((t) => t.id));
    const dropped = socket.framesOfType('trades').reduce((sum, f) => sum + f.dropped, 0);

    expect(emitted.length).toBeGreaterThan(50);
    expect(dropped).toBe(0);
    expect(delivered).toEqual(emitted);

    session.close();
  });
});

describe('ClientSession — candles are identical at every tier (D-009)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * The test the whole feature rests on.
   *
   * One engine, two clients, one pinned to 10 Hz and one to 1 Hz. The fast client
   * sees the bar form in many steps and the slow one in few — but every candle that
   * *closed* must be byte-identical, because a slower tier changes how often updates
   * are delivered, never what they say.
   *
   * It works because of two rules: a candle frame carries the complete current
   * OHLCV rather than a patch, so a dropped intermediate frame costs a view and not
   * the state; and a close bypasses the cadence entirely, so neither client can end
   * up recording a stale value as the final close.
   */
  function runTwoTiers(interval: string, durationMs: number, seed = 31_337) {
    const clock = new VirtualClock(ORIGIN);
    const engine = new MarketEngine({ seed, clock });

    const fastSocket = new FakeSocket();
    const slowSocket = new FakeSocket();
    const fast = new ClientSession({ id: 'f', socket: fastSocket, engine, clock, forcedTier: 'full' });
    const slow = new ClientSession({ id: 's', socket: slowSocket, engine, clock, forcedTier: 'minimal' });

    feed(fast, fastSocket, subscribe(interval));
    feed(slow, slowSocket, subscribe(interval));
    fastSocket.clear();
    slowSocket.clear();

    run(engine, clock, durationMs);

    const closed = (s: FakeSocket): Candle[] =>
      s.framesOfType('candle').filter((f) => f.closed).map((f) => f.candle);

    const result = { fast: closed(fastSocket), slow: closed(slowSocket), fastSocket, slowSocket };
    fast.close();
    slow.close();
    return result;
  }

  it('delivers the same closed 1s candles to a 10 Hz and a 1 Hz client', () => {
    const { fast, slow } = runTwoTiers('1s', 30_000);

    expect(fast.length).toBeGreaterThan(20);
    expect(slow.length).toBe(fast.length);
    // Every field, not just the close: open, high, low, close, volume and count.
    expect(slow).toEqual(fast);
  });

  it('holds for 5s candles too', () => {
    const { fast, slow } = runTwoTiers('5s', 60_000);
    expect(fast.length).toBeGreaterThan(8);
    expect(slow).toEqual(fast);
  });

  it('gives the slow client fewer intermediate views of the same bars', () => {
    // The thing that *should* differ. If this were equal, no coalescing happened
    // and the identical-candles test above would be proving nothing.
    const { fastSocket, slowSocket } = runTwoTiers('1s', 30_000);

    const fastUpdates = fastSocket.framesOfType('candle').filter((f) => !f.closed).length;
    const slowUpdates = slowSocket.framesOfType('candle').filter((f) => !f.closed).length;

    expect(fastUpdates).toBeGreaterThan(slowUpdates * 3);
  });

  it('agrees with the engine itself, not just with each other', () => {
    // Both clients could be consistently wrong. This anchors them to the source.
    const clock = new VirtualClock(ORIGIN);
    const engine = new MarketEngine({ seed: 909, clock });
    const socket = new FakeSocket();
    const session = new ClientSession({ id: 's', socket, engine, clock, forcedTier: 'minimal' });

    feed(session, socket, subscribe('1s'));
    const truth: Candle[] = [];
    const off = engine.events.on('candle', (e) => {
      if (e.interval === '1s' && e.closed) truth.push(e.candle);
    });
    socket.clear();

    run(engine, clock, 20_000);
    off();

    const delivered = socket.framesOfType('candle').filter((f) => f.closed).map((f) => f.candle);
    expect(truth.length).toBeGreaterThan(10);
    expect(delivered).toEqual(truth);

    session.close();
  });
});

describe('ClientSession — tier control end to end', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retimes delivery when a report demotes the connection', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, subscribe());

    run(engine, clock, 5_000);
    const fullFrames = socket.framesOfType('book').length;
    socket.clear();

    // A genuinely bad connection reports in.
    feed(
      session,
      socket,
      encodeFrame({
        t: 'netreport',
        latencyMs: TIER_THRESHOLDS.demoteFromDegraded + 100,
        jitterMs: 0,
        samples: 10,
      }),
    );

    const tier = socket.framesOfType('tier').at(-1)!;
    expect(tier.active).toBe('minimal');
    expect(tier.targetHz).toBe(1);

    socket.clear();
    run(engine, clock, 5_000);
    expect(socket.framesOfType('book').length).toBeLessThan(fullFrames / 2);
  });

  it('echoes live latency and jitter on every report, even when the tier holds', () => {
    const { socket, session } = setup();
    feed(session, socket, subscribe());
    socket.clear();

    feed(session, socket, encodeFrame({ t: 'netreport', latencyMs: 42, jitterMs: 7, samples: 3 }));

    const tier = socket.framesOfType('tier').at(-1)!;
    expect(tier.latencyMs).toBe(42);
    expect(tier.jitterMs).toBe(7);
    expect(tier.score).toBe(56); // 42 + 2*7
    expect(tier.active).toBe('full');
  });

  it('keeps reporting the automatic tier while pinned by the override', () => {
    const { clock, socket, session } = setup();
    feed(session, socket, subscribe());
    feed(session, socket, encodeFrame({ t: 'setTier', tier: 'minimal' }));
    socket.clear();

    clock.advance(TIER_DWELL_MS + 1);
    feed(session, socket, encodeFrame({ t: 'netreport', latencyMs: 5, jitterMs: 1, samples: 9 }));

    const tier = socket.framesOfType('tier').at(-1)!;
    // Proof the machinery is still running underneath rather than switched off.
    expect(tier.active).toBe('minimal');
    expect(tier.auto).toBe('full');
    expect(tier.forced).toBe(true);
  });

  it('returns to automatic control when the override is cleared', () => {
    const { socket, session } = setup();
    feed(session, socket, subscribe());
    feed(session, socket, encodeFrame({ t: 'setTier', tier: 'minimal' }));
    feed(session, socket, encodeFrame({ t: 'setTier', tier: null }));

    const tier = socket.framesOfType('tier').at(-1)!;
    expect(tier.forced).toBe(false);
    expect(tier.active).toBe('full');
  });

  it('demotes a client that stops reporting', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, subscribe());
    socket.clear();

    // Thirteen seconds of silence, past the twelve-second tolerance.
    run(engine, clock, 13_500);

    const tier = socket.framesOfType('tier').at(-1);
    expect(tier).toBeDefined();
    expect(tier!.active).toBe('degraded');
    expect(tier!.reason).toContain('no report');
  });
});

describe('ClientSession — the forced-gap debug control (D-013)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates a sequence gap the client can actually detect', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, subscribe());
    socket.clear();

    // Collect some contiguous frames first. Arming immediately after clearing
    // would put the discontinuity between a discarded frame and the first kept
    // one, where no assertion can see it.
    run(engine, clock, 1_000);
    feed(session, socket, encodeFrame({ t: 'debug', action: 'dropDelta' }));
    run(engine, clock, 3_000);

    const books = socket.framesOfType('book');
    expect(books.length).toBeGreaterThan(2);

    // Exactly one discontinuity, and it is the one we asked for.
    let gaps = 0;
    for (let i = 1; i < books.length; i += 1) {
      if (books[i]!.delta.fromSeq !== books[i - 1]!.delta.toSeq + 1) gaps += 1;
    }
    expect(gaps).toBe(1);

    session.close();
  });

  it('flushes before arming, so coalescing cannot swallow the gap', () => {
    // Without the pre-flush, a pending range of [104,104] plus a skipped 105 plus
    // an incoming 106 merges to [104,106] — perfectly contiguous to the client,
    // while silently missing 105's changes. The bug would hide the demo.
    const { engine, clock, socket, session } = setup('minimal');
    feed(session, socket, subscribe());
    run(engine, clock, 2_000);
    socket.clear();

    // Let deltas accumulate inside the 1 Hz window, then arm mid-window.
    run(engine, clock, 300);
    feed(session, socket, encodeFrame({ t: 'debug', action: 'dropDelta' }));
    run(engine, clock, 4_000);

    const books = socket.framesOfType('book');
    let gaps = 0;
    for (let i = 1; i < books.length; i += 1) {
      if (books[i]!.delta.fromSeq !== books[i - 1]!.delta.toSeq + 1) gaps += 1;
    }
    expect(gaps).toBe(1);

    session.close();
  });
});

describe('ClientSession — the listener leak this guards against', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not duplicate delivery when the interval changes', () => {
    const { engine, clock, socket, session } = setup();

    feed(session, socket, subscribe('1s'));
    feed(session, socket, subscribe('5s'));
    feed(session, socket, subscribe('1m'));
    socket.clear();

    run(engine, clock, 3_000);

    // Exactly one delivery per engine trade, not three.
    const delivered = socket.framesOfType('trades').flatMap((f) => f.trades.map((t) => t.id));
    expect(delivered.length).toBeGreaterThan(5);
    expect(new Set(delivered).size).toBe(delivered.length);

    session.close();
  });

  it('detaches every engine listener and stops its timer on close', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, subscribe());

    expect(engine.events.listenerCount('trade')).toBe(1);
    expect(engine.events.listenerCount('book')).toBe(1);
    expect(engine.events.listenerCount('candle')).toBe(1);

    session.close();

    // The real symptom of getting this wrong is not a crash. It is a server that
    // keeps serialising frames for sockets nobody is reading, and holds every
    // disconnected session alive through the listener closure.
    expect(engine.events.listenerCount('trade')).toBe(0);
    expect(engine.events.listenerCount('book')).toBe(0);
    expect(engine.events.listenerCount('candle')).toBe(0);

    socket.clear();
    run(engine, clock, 3_000);
    expect(socket.sent).toHaveLength(0);
  });

  it('is safe to close twice', () => {
    const { session } = setup();
    session.close();
    expect(() => session.close()).not.toThrow();
  });
});

describe('ClientSession — bad input', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects malformed frames without closing the connection', () => {
    const { socket, session } = setup();
    const bad = ['not json', '{"t":"ping"}', '{"t":"nope"}', '[]', ''];
    for (const input of bad) feed(session, socket, input);

    expect(socket.framesOfType('error')).toHaveLength(bad.length);
    expect(socket.framesOfType('error').every((e) => e.code === 'bad_frame')).toBe(true);
    expect(socket.isOpen).toBe(true);
  });

  it('rejects an unknown symbol and an unknown interval distinctly', () => {
    const { socket, session } = setup();

    feed(session, socket, subscribe().replace('BTC-USD', 'DOGE-USD'));
    expect(socket.framesOfType('error')[0]?.code).toBe('unknown_symbol');

    socket.clear();
    // '9y' fails the enum at the schema, so it never reaches the handler.
    feed(session, socket, '{"t":"subscribe","symbol":"BTC-USD","interval":"9y"}');
    expect(socket.framesOfType('error')[0]?.code).toBe('bad_frame');
  });

  it('does not deliver anything after a rejected subscribe', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, subscribe().replace('BTC-USD', 'DOGE-USD'));
    socket.clear();

    run(engine, clock, 3_000);
    expect(socket.sent).toHaveLength(0);
  });

  it('rejects a tier override naming a tier that does not exist', () => {
    const { socket, session } = setup();
    feed(session, socket, '{"t":"setTier","tier":"turbo"}');
    expect(socket.framesOfType('error')[0]?.code).toBe('bad_frame');
  });

  it('closes itself if the socket throws mid-send rather than breaking the engine loop', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, subscribe());

    // A socket can be torn down between the isOpen check and the write. Letting
    // that throw would abort the engine's emit loop and stop delivery to every
    // other connected client.
    socket.throwOnSend = true;
    expect(() => run(engine, clock, 2_000)).not.toThrow();
    expect(engine.events.listenerCount('trade')).toBe(0);
  });

  it('stops sending once the socket reports itself closed', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, subscribe());

    socket.isOpen = false;
    socket.clear();
    run(engine, clock, 3_000);
    expect(socket.sent).toHaveLength(0);

    session.close();
  });
});
