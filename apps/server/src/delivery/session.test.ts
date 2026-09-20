import { describe, it, expect, beforeEach } from 'vitest';
import { encodeFrame, parseClientFrame, type ServerFrame } from '@cta/protocol';

import { ClientSession, type SocketLike } from './session';
import { MarketEngine } from '../market/engine';
import { VirtualClock } from '../market/clock';

const ORIGIN = 1_726_800_000_000;
const TICK_MS = 50;

/**
 * A socket that records instead of transmitting.
 *
 * This is the payoff from narrowing the session's dependency to four members: the
 * whole delivery layer can be tested with no `ws` instance, no HTTP server and no
 * open port, which keeps these tests deterministic and instant.
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

function setup() {
  const clock = new VirtualClock(ORIGIN);
  const engine = new MarketEngine({ seed: 4242, clock });
  const socket = new FakeSocket();
  const session = new ClientSession({ id: 'test', socket, engine, clock });
  return { clock, engine, socket, session };
}

function run(engine: MarketEngine, clock: VirtualClock, ms: number) {
  const steps = Math.floor(ms / TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    clock.advance(TICK_MS);
    engine.advanceTo(clock.now());
  }
}

/** Parse the way the transport does, so tests exercise the real validation path. */
function feed(session: ClientSession, socket: FakeSocket, raw: unknown): void {
  const result = parseClientFrame(raw);
  if (!result.ok) session.rejectFrame(result.reason);
  else session.handleFrame(result.frame);
}

describe('ClientSession — handshake', () => {
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
});

describe('ClientSession — subscription', () => {
  it('confirms the subscription and seeds the live candle immediately', () => {
    const { engine, clock, socket, session } = setup();
    run(engine, clock, 3_000);
    socket.clear();

    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval: '1s' }));

    expect(socket.framesOfType('subscribed')).toHaveLength(1);
    // Seeded rather than waiting for the next trade — at the 1m interval that
    // could otherwise be most of a minute of blank chart.
    expect(socket.framesOfType('candle').length).toBeGreaterThanOrEqual(1);
    expect(socket.framesOfType('tier')).toHaveLength(1);
  });

  it('streams only the subscribed interval', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval: '5s' }));
    socket.clear();

    run(engine, clock, 12_000);

    const candles = socket.framesOfType('candle');
    expect(candles.length).toBeGreaterThan(5);
    expect(candles.every((c) => c.interval === '5s')).toBe(true);
  });

  it('emits book deltas with no sequence gaps', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval: '1s' }));
    socket.clear();

    run(engine, clock, 5_000);

    const books = socket.framesOfType('book');
    expect(books.length).toBeGreaterThan(20);
    for (let i = 1; i < books.length; i += 1) {
      expect(books[i]!.delta.fromSeq).toBe(books[i - 1]!.delta.toSeq + 1);
    }
  });
});

describe('ClientSession — the listener leak this guards against', () => {
  /**
   * Changing interval is a re-subscribe. If the previous listeners were not torn
   * down first, a client that switched interval three times would receive four
   * copies of every trade — and the duplicates would look like a busy market
   * rather than a bug.
   */
  it('does not duplicate delivery when the interval changes', () => {
    const { engine, clock, socket, session } = setup();

    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval: '1s' }));
    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval: '5s' }));
    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval: '1m' }));
    socket.clear();

    run(engine, clock, 2_000);

    // Exactly one trades frame per engine trade, not three.
    const delivered = socket.framesOfType('trades').flatMap((f) => f.trades.map((t) => t.id));
    expect(delivered.length).toBeGreaterThan(5);
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it('detaches every engine listener on close', () => {
    const { engine, clock, socket, session } = setup();
    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval: '1s' }));

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
    run(engine, clock, 2_000);
    expect(socket.sent).toHaveLength(0);
  });

  it('is safe to close twice', () => {
    const { session } = setup();
    session.close();
    expect(() => session.close()).not.toThrow();
  });
});

describe('ClientSession — bad input', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('rejects malformed frames without closing the connection', () => {
    const { socket, session } = ctx;
    const bad = ['not json', '{"t":"ping"}', '{"t":"nope"}', '[]', ''];
    for (const input of bad) feed(session, socket, input);

    expect(socket.framesOfType('error')).toHaveLength(bad.length);
    expect(socket.framesOfType('error').every((e) => e.code === 'bad_frame')).toBe(true);
    expect(socket.isOpen).toBe(true);
  });

  it('rejects an unknown symbol and an unknown interval distinctly', () => {
    const { socket, session } = ctx;

    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'DOGE-USD', interval: '1s' }));
    expect(socket.framesOfType('error')[0]?.code).toBe('unknown_symbol');

    socket.clear();
    // '9y' fails the enum at the schema, so it never reaches the handler.
    feed(session, socket, '{"t":"subscribe","symbol":"BTC-USD","interval":"9y"}');
    expect(socket.framesOfType('error')[0]?.code).toBe('bad_frame');
  });

  it('does not deliver anything after a rejected subscribe', () => {
    const { engine, clock, socket, session } = ctx;
    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'DOGE-USD', interval: '1s' }));
    socket.clear();

    run(engine, clock, 2_000);
    expect(socket.sent).toHaveLength(0);
  });

  it('closes itself if the socket throws mid-send rather than breaking the engine loop', () => {
    const { engine, clock, socket, session } = ctx;
    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval: '1s' }));

    // A socket can be torn down between the isOpen check and the write. Letting
    // that throw would abort the engine's emit loop and stop delivery to every
    // other connected client.
    socket.throwOnSend = true;
    expect(() => run(engine, clock, 1_000)).not.toThrow();
    expect(engine.events.listenerCount('trade')).toBe(0);
  });

  it('stops sending once the socket reports itself closed', () => {
    const { engine, clock, socket, session } = ctx;
    feed(session, socket, encodeFrame({ t: 'subscribe', symbol: 'BTC-USD', interval: '1s' }));

    socket.isOpen = false;
    socket.clear();
    run(engine, clock, 2_000);
    expect(socket.sent).toHaveLength(0);
  });
});
