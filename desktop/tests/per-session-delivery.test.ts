// Per-session delivery (one-core R5-3): a phone is sent the conversations it WATCHES and the small per-session summary of all of them;
// a second phone and the computer's own windows are unaffected by one phone's watches. A scripted host: the real registry, the real
// session records, the real publish and the real RemoteServer.broadcast, with fake sockets that count the bytes they are sent.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { WindowRegistry } from '../src/main/window-registry';
import { SessionRecords } from '../src/main/session-record';
import { AudienceFills } from '../src/main/audience-fill';
import { createPublish } from '../src/main/publish';
import { startSessionSummaryPush } from '../src/main/session-summary-push';
import { findChannel } from '../src/main/ipc/channel-table';
import { bindSessionOps } from '../src/main/ipc/session';

const IDS = Array.from({ length: 10 }, (_v, i) => `s${i}`);
const MAIN = 10, BUDDY = 11;

interface Phone { ws: any; id: number; frames: any[]; bytes: number; ofType(type: string, sid?: string): any[] }

async function scriptedHost(opts: { phones?: number } = {}) {
  const { RemoteServer } = await import('../src/main/remote-server');
  const registry = new WindowRegistry();
  registry.registerWindow(MAIN, 1);
  registry.registerWindow(BUDDY, 2, 'buddy');
  const records = new SessionRecords();
  const fills = new AudienceFills();
  const server: any = new RemoteServer(
    Object.assign(new EventEmitter(), { getAllSessions: () => [] }) as never, new EventEmitter() as never,
    { enabled: true, port: 9900, toSafeObject: () => ({}) } as never, undefined,
    { audience: registry, getNativeRuntime: () => ({ records, fills }) as never },
  );
  const phones: Phone[] = [];
  for (let i = 0; i < (opts.phones ?? 2); i++) {
    const frames: any[] = [];
    const phone: Phone = {
      id: 0, frames, bytes: 0,
      ws: Object.assign(new EventEmitter(), {
        readyState: 1, bufferedAmount: 0, close: vi.fn(),
        send(raw: string) { phone.bytes += Buffer.byteLength(raw); frames.push(JSON.parse(raw)); },
      }),
      ofType: (type, sid) => frames.filter((f) => f.type === type && (sid === undefined || f.payload?.sessionId === sid)),
    };
    server.addClient(phone.ws, `device-${i}`, '127.0.0.1');
    phone.id = [...server.clients].find((c: any) => c.ws === phone.ws).audienceId;
    phones.push(phone);
  }
  const windowSends: Array<{ id: number; sessionId: string; channel: string }> = [];
  const publish = createPublish({
    records, fills,
    // The computer's windows: what sendForSession does (owner plus subscribers).
    toWindows: (sessionId, channel) => {
      const a = registry.resolveAudience(sessionId);
      for (const id of a.windowIds) windowSends.push({ id, sessionId, channel });
    },
    toSockets: (m, ids, hold) => server.broadcast(m, ids, hold),
    socketsFor: (sid) => registry.resolveAudience(sid).socketIds,
  });
  for (const sid of IDS) { records.begin(sid); registry.assignSession(sid, MAIN); }
  registry.subscribe('s0', BUDDY);
  // A phone's watch is exactly what `session:open` does for it.
  const watch = (p: Phone, sid: string) => registry.subscribe(sid, p.id);
  const unwatch = (p: Phone, sid: string) => registry.unsubscribe(sid, p.id);
  const turn = (sid: string, text: string) => publish(sid, 'transcript:event', { type: 'assistant-text', sessionId: sid, uuid: `${sid}-${text}`, timestamp: 1, data: { text, partId: 'p' } });
  const pty = (sid: string, data: string) => server.onPtyOutput(sid, data);
  return { server, registry, records, fills, publish, phones, windowSends, watch, unwatch, turn, pty, stop: () => server.stop(true) };
}

afterEach(() => bindSessionOps(null));

describe('a phone is sent only the conversations it watches', () => {
  it('chat events and terminal output of an unwatched conversation never reach it; a watched one does', async () => {
    const h = await scriptedHost();
    const [a] = h.phones;
    h.watch(a, 's3');
    for (const sid of IDS) { h.turn(sid, 'hello'); h.pty(sid, 'output of ' + sid); }
    expect(a.ofType('transcript:event').map((f) => f.payload.sessionId)).toEqual(['s3']);
    expect(a.ofType('pty:output').map((f) => f.payload.sessionId)).toEqual(['s3']);
    h.stop();
  });

  it('a second phone and the computer are unaffected by one phone\'s watches', async () => {
    const h = await scriptedHost();
    const [a, b] = h.phones;
    h.watch(a, 's1'); h.watch(b, 's2');
    h.turn('s1', 'x'); h.turn('s2', 'y');
    h.unwatch(a, 's1');
    h.turn('s1', 'z');
    expect(a.ofType('transcript:event').map((f) => f.payload.data.text)).toEqual(['x']);          // stopped after unwatch
    expect(b.ofType('transcript:event').map((f) => f.payload.data.text)).toEqual(['y']);          // b never got s1 at all, and still gets its own
    // The computer's window gets EVERY session it owns, whatever any phone watches.
    expect(h.windowSends.filter((w) => w.id === MAIN && w.channel === 'transcript:event').map((w) => w.sessionId)).toEqual(['s1', 's2', 's1']);
    // The buddy's own subscription (s0) is untouched too: it hears s0 and nothing a phone watches.
    h.watch(a, 's0'); h.turn('s0', 'q'); h.unwatch(a, 's0'); h.turn('s0', 'r');
    expect(h.windowSends.filter((w) => w.id === BUDDY).map((w) => w.sessionId)).toEqual(['s0', 's0']);
    h.stop();
  });

  it('a window\'s subscription is separate from a phone\'s: watching s0 does not subscribe a window and vice versa', async () => {
    const h = await scriptedHost({ phones: 1 });
    const [a] = h.phones;
    h.watch(a, 's0');
    expect([...h.registry.getSubscribers('s0')]).toEqual([BUDDY]);
    expect(h.registry.getSocketWatchers('s0')).toEqual([a.id]);
    h.stop();
  });

  it('a conversation-level push (a tag or note change) still reaches a phone that watches nothing', async () => {
    const h = await scriptedHost({ phones: 1 });
    h.publish('claude-id-1', 'session:meta-changed', { sessionId: 'claude-id-1', flag: 'tag:t', value: true }, { everyPhone: true });
    expect(h.phones[0].ofType('session:meta-changed')).toHaveLength(1);
    expect(h.records.has('claude-id-1')).toBe(false); // and no phantom session record was made for the Claude id
    h.stop();
  });
});

describe('a tag or note change made through the channel table reaches phones that watch nothing', () => {
  it('session:set-tag and session:set-note publish to every phone (they are keyed by the Claude id no phone watches)', async () => {
    const calls: Array<{ id: string; type: string; options: any }> = [];
    bindSessionOps({
      publish: (id: string, type: string, _payload: unknown, options: any) => { calls.push({ id, type, options }); },
      sessionIdMap: new Map([['desktop-1', 'claude-1']]),
      nativeHost: { isNativeSessionId: () => false },
      canWriteStoreRecord: () => false,   // the store write is skipped; only the announcement is under test
    } as any);
    await findChannel('session:set-tag')!.handler({ sessionId: 'desktop-1', tagId: 'tag_x', value: true }, { door: 'remote', runtime: null, broadcast: () => {} } as any);
    await findChannel('session:set-note')!.handler({ sessionId: 'desktop-1', note: 'hello' }, { door: 'remote', runtime: null, broadcast: () => {} } as any);
    expect(calls.map((c) => [c.id, c.type])).toEqual([['claude-1', 'session:meta-changed'], ['claude-1', 'session:meta-changed']]);
    expect(calls.every((c) => c.options?.everyPhone === true)).toBe(true);
  });
});

describe('the watch survives a window letting go, and ends with the session', () => {
  it('releaseSession drops the window\'s ownership and subscribers but keeps every phone\'s watch', async () => {
    const h = await scriptedHost({ phones: 2 });
    const [a, b] = h.phones;
    h.watch(a, 's0'); h.watch(b, 's0');
    h.registry.releaseSession('s0');
    expect(h.registry.getOwner('s0')).toBeUndefined();
    expect(h.registry.getSubscribers('s0').size).toBe(0);
    expect(h.registry.getSocketWatchers('s0').sort()).toEqual([a.id, b.id].sort());
    h.turn('s0', 'still here');
    expect(a.ofType('transcript:event')).toHaveLength(1);
    expect(b.ofType('transcript:event')).toHaveLength(1);
    h.stop();
  });

  it('endSession (the session is over) drops everyone\'s interest, so a session id that comes back starts clean', async () => {
    const h = await scriptedHost({ phones: 1 });
    const [a] = h.phones;
    h.watch(a, 's0');
    h.registry.endSession('s0');
    expect(h.registry.getSocketWatchers('s0')).toEqual([]);
    expect([...h.registry.getSubscribers('s0')]).toEqual([]);
    h.stop();
  });

  it('a phone that leaves forgets all its watches and nobody else loses theirs', async () => {
    const h = await scriptedHost({ phones: 2 });
    const [a, b] = h.phones;
    h.watch(a, 's1'); h.watch(b, 's1');
    a.ws.emit('close', 1000, Buffer.from(''));
    expect(h.registry.getSocketWatchers('s1')).toEqual([b.id]);
    h.stop();
  });
});

describe('session:unwatch', () => {
  function world() {
    const registry = new WindowRegistry();
    registry.registerWindow(4, 1);
    registry.registerSocket(-1000); registry.registerSocket(-1001);
    const fills = new AudienceFills();
    bindSessionOps({ windowRegistry: registry } as any);
    const def = findChannel('session:unwatch')!;
    return { registry, fills, def, runtime: { fills } as any };
  }

  it('ends only the asking phone\'s watch', async () => {
    const w = world();
    w.registry.subscribe('s1', -1000); w.registry.subscribe('s1', -1001);
    const reply = await w.def.handler({ sessionId: 's1' }, { door: 'remote', runtime: w.runtime, audienceId: -1000, broadcast: () => {} } as any);
    expect(reply).toEqual({ ok: true });
    expect(w.registry.getSocketWatchers('s1')).toEqual([-1001]);
  });

  it('drops what an open still in flight was holding, without delivering it', async () => {
    const w = world();
    w.registry.subscribe('s1', -1000);
    w.fills.begin('s-1000', 's1');
    const delivered = vi.fn();
    w.fills.hold('s-1000', 's1', delivered);
    await w.def.handler({ sessionId: 's1' }, { door: 'remote', runtime: w.runtime, audienceId: -1000, broadcast: () => {} } as any);
    expect(w.fills.filling('s-1000', 's1')).toBe(false);
    w.fills.release('s-1000', 's1'); // the open's own release finding nothing to do
    expect(delivered).not.toHaveBeenCalled();
  });

  it('is answered "ok" and changes nothing for a computer window, and for a session nobody watched', async () => {
    const w = world();
    w.registry.subscribe('s1', -1000);
    expect(await w.def.handler({ sessionId: 's1' }, { door: 'desktop', runtime: w.runtime, windowId: 4, broadcast: () => {} } as any)).toEqual({ ok: true });
    expect(await w.def.handler({ sessionId: 'never' }, { door: 'remote', runtime: w.runtime, audienceId: -1001, broadcast: () => {} } as any)).toEqual({ ok: true });
    expect(w.registry.getSocketWatchers('s1')).toEqual([-1000]);
  });

  it('is served to both doors', () => {
    const def = findChannel('session:unwatch')!;
    expect(def.desktopOnly).toBeFalsy();
    expect(def.remoteAllowed).not.toBe(false);
  });
});

describe('the summary reaches every phone, whatever it watches, and promptly', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a session that needs an answer shows up in the next summary within milliseconds, not on the 10 second tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const h = await scriptedHost();
    const [a, b] = h.phones;
    h.watch(a, 's0');
    const push = startSessionSummaryPush({
      records: h.records, hasAudience: () => true, hasPhone: () => true,
      deliver: (payload) => h.server.broadcast({ type: 'session:summary', payload }),
    });
    h.records.onSummaryChange(() => push.notify());
    // an ask raised on s7, which NO phone watches
    h.publish('s7', 'hook:event', { type: 'PermissionRequest', sessionId: 's7', payload: { _requestId: 'r1' }, timestamp: 1 });
    expect(a.ofType('session:summary')).toHaveLength(0);                     // debounced, not instant ...
    await vi.advanceTimersByTimeAsync(60);                                    // ... but well inside the 10 s tick
    for (const p of [a, b]) {
      const last = p.ofType('session:summary').at(-1);
      expect(last.payload.summaries.s7).toMatchObject({ awaitingCount: 1 });
    }
    // and the unwatched session's EVENTS did not go to phone b, nor the watched-by-nobody ask itself
    expect(b.ofType('hook:event')).toHaveLength(0);
    push.stop(); h.stop();
  });

  it('a burst of changes leaves as one message, and an identical summary is never sent twice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const h = await scriptedHost({ phones: 1 });
    const deliver = vi.fn();
    const push = startSessionSummaryPush({ records: h.records, hasAudience: () => true, hasPhone: () => true, deliver });
    h.records.onSummaryChange(() => push.notify());
    deliver.mockClear();
    h.turn('s1', 'a'); // assistant text: hasHistory flips
    h.publish('s1', 'transcript:event', { type: 'user-message', sessionId: 's1', uuid: 'u1', timestamp: 2, data: { text: 'go' } });
    h.publish('s2', 'transcript:event', { type: 'user-message', sessionId: 's2', uuid: 'u2', timestamp: 2, data: { text: 'go' } });
    await vi.advanceTimersByTimeAsync(60);
    expect(deliver).toHaveBeenCalledTimes(1);
    push.push(); // nothing changed since: stays quiet
    expect(deliver).toHaveBeenCalledTimes(1);
    // a streamed answer is thousands of events and changes no summary field: no push at all
    for (let i = 0; i < 200; i++) h.publish('s2', 'transcript:event', { type: 'assistant-text', sessionId: 's2', uuid: `t${i}`, timestamp: 3 + i, data: { text: 'w', partId: 'p', model: 'm' } });
    await vi.advanceTimersByTimeAsync(60);
    expect(deliver.mock.calls.length).toBeLessThanOrEqual(2); // only the model name appearing once may differ
    push.stop(); h.stop();
  });

  it('nothing is built when no phone is connected (the windows get the 10 second push as before)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const h = await scriptedHost({ phones: 0 });
    const deliver = vi.fn();
    const push = startSessionSummaryPush({ records: h.records, hasAudience: () => true, hasPhone: () => false, deliver });
    h.records.onSummaryChange(() => push.notify());
    h.turn('s1', 'a');
    await vi.advanceTimersByTimeAsync(60);
    expect(deliver).not.toHaveBeenCalled();
    push.stop(); h.stop();
  });
});

describe('bytes to a phone with ten busy conversations', () => {
  // 10 conversations each print 200 turns of 400 characters and 200 terminal chunks of 300 characters. The phone looks at ONE.
  async function run(watched: string[]) {
    const h = await scriptedHost({ phones: 1 });
    const [a] = h.phones;
    for (const sid of watched) h.watch(a, sid);
    const push = startSessionSummaryPush({
      records: h.records, hasAudience: () => true, hasPhone: () => true,
      deliver: (payload) => h.server.broadcast({ type: 'session:summary', payload }),
    });
    h.records.onSummaryChange(() => push.notify());
    const before = a.bytes;
    for (let i = 0; i < 200; i++) {
      for (const sid of IDS) {
        h.publish(sid, 'transcript:event', { type: 'assistant-text', sessionId: sid, uuid: `${sid}-${i}`, timestamp: i, data: { text: 'x'.repeat(400), partId: `p${i}` } });
        h.pty(sid, 'y'.repeat(300));
      }
    }
    push.push();
    const total = a.bytes - before;
    const summaryBytes = a.frames.filter((f) => f.type === 'session:summary').reduce((n, f) => n + Buffer.byteLength(JSON.stringify(f)), 0);
    push.stop(); h.stop();
    return { total, summaryBytes };
  }

  it('falls to about a tenth, plus the summary', async () => {
    const all = await run(IDS);            // how a phone behaved before: every conversation
    const one = await run(['s3']);         // now: the one on screen
    const ratio = (one.total - one.summaryBytes) / (all.total - all.summaryBytes);
    // eslint-disable-next-line no-console
    console.log(`[R5-3 bytes] 10 sessions, phone watches all: ${all.total} B | watches one: ${one.total} B (of which summary ${one.summaryBytes} B) | per-session share ${(ratio * 100).toFixed(1)}%`);
    expect(ratio).toBeGreaterThan(0.08);
    expect(ratio).toBeLessThan(0.12);
    expect(one.total).toBeLessThan(all.total * 0.12);
  });
});
