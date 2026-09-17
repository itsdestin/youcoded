import { describe, expect, it } from 'vitest';

// WHY no source reads here any more (Plan B, 2026-09-16): that no failure budget is keyed by
// network address or shared between connections, and that a burst SLOWS new connections rather
// than refusing them, are the ast-grep rules no-ip-keyed-failure-bucket and
// remote-burst-slows-not-refuses. The cases below drive a socket.

describe('a single connection cannot be used as an unlimited guessing channel', () => {
  it('gives a socket ONE auth attempt and then closes it', async () => {
    // Behaviour, not a grep — and writing it is what found the gap. The source-scan
    // version asserted that `attemptsOnThisSocket` and `AUTH_ATTEMPTS_PER_SOCKET`
    // appeared in the file; they did, and the five-attempt budget they named was
    // unreachable, because the handler detaches itself on the first message and never
    // re-attaches. One attempt per connection is STRICTER than the five the code claimed,
    // so the code was corrected to say one rather than the behaviour loosened to five.
    const { EventEmitter } = await import('node:events');
    const { RemoteServer } = await import('../src/main/remote-server');
    const sessionManager: any = new EventEmitter();
    Object.assign(sessionManager, { listSessions: () => [] });
    const closes: number[] = [];
    const socket: any = new EventEmitter();
    Object.assign(socket, {
      readyState: 1,
      send: () => {},
      close: (code: number) => closes.push(code),
      off: EventEmitter.prototype.off.bind(socket),
    });

    const server: any = new RemoteServer(sessionManager, new EventEmitter() as any, {
      enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}),
    } as any);
    server.handleConnection(socket, { socket: { remoteAddress: '100.64.0.9' } });

    for (let i = 0; i < 6; i++) socket.emit('message', JSON.stringify({ type: 'auth', password: 'guess' }));
    await new Promise(r => setImmediate(r));

    // Closed once, on the first attempt, and deaf to the five that followed.
    expect(closes).toHaveLength(1);
    expect(socket.listenerCount('message')).toBe(0);
  });

  it('refuses new sockets once too many sit unauthenticated (2026-09-10 security review, #5)', async () => {
    const { EventEmitter } = await import('node:events');
    const { RemoteServer } = await import('../src/main/remote-server');
    const sessionManager: any = new EventEmitter();
    Object.assign(sessionManager, { listSessions: () => [] });
    const server: any = new RemoteServer(sessionManager, new EventEmitter() as any, {
      enabled: true, port: 9900, passwordHash: 'x', toSafeObject: () => ({}),
    } as any);

    const makeSocket = () => {
      const s: any = new EventEmitter();
      Object.assign(s, {
        readyState: 1, send: () => {}, closes: [] as number[],
        close: (code: number) => s.closes.push(code),
        off: EventEmitter.prototype.off.bind(s),
      });
      return s;
    };

    // Open 64 sockets that never authenticate — each holds a pre-auth slot.
    const held = [];
    for (let i = 0; i < 64; i++) {
      const s = makeSocket();
      server.handleConnection(s, { socket: { remoteAddress: '127.0.0.1' } });
      held.push(s);
    }
    expect(held.every((s) => s.closes.length === 0)).toBe(true);

    // The 65th is refused immediately with 4009, without consuming a slot.
    const overflow = makeSocket();
    server.handleConnection(overflow, { socket: { remoteAddress: '127.0.0.1' } });
    expect(overflow.closes).toEqual([4009]);

    // When one held socket closes, a slot frees and a new socket is accepted again.
    held[0].emit('close');
    const afterFree = makeSocket();
    server.handleConnection(afterFree, { socket: { remoteAddress: '127.0.0.1' } });
    expect(afterFree.closes).toHaveLength(0);
  });
});
