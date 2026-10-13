// session:open (main/session-open.ts): the ONE answer every screen is filled from (one-core R5-2).
import { describe, it, expect } from 'vitest';
import { SessionRecords } from '../src/main/session-record';
import { openSession, type NativeLive, type OpenDeps } from '../src/main/session-open';
import type { TranscriptPageResult } from '../src/shared/types';

const S = 's1';
const user = (n: number, text = 'hi') => ({ sessionId: S, type: 'user-message', uuid: `m${n}`, timestamp: n, data: { text } });
const delta = (n: number, text: string) => ({ sessionId: S, type: 'assistant-text', uuid: `d${n}`, timestamp: n, data: { text, partId: 'text-0' } });
const ask = (id: string, type = 'PermissionRequest') => ({ type, sessionId: S, payload: { _requestId: id, tool_name: 'Bash' }, timestamp: 1 });
const closed = (id: string, type = 'PermissionResolved', reason?: string) => ({ type, sessionId: S, payload: { _requestId: id, ...(reason ? { _reason: reason } : {}) }, timestamp: 2 });
const page = (n = 1): TranscriptPageResult => ({ events: Array.from({ length: n }, (_, i) => ({ sessionId: S, type: 'user-message', uuid: `p${i}`, timestamp: i, data: { text: `old ${i}` } })) as any, cursor: null, hasMore: false });

function deps(records: SessionRecords, over: Partial<OpenDeps> = {}): OpenDeps {
  return { records, knows: () => true, page: async () => page(), native: () => null, ...over };
}
const ok = (r: any) => { expect(r.ok).toBe(true); return r; };

describe('openSession: a session the computer does not run', () => {
  it('is "gone", and never creates a record for an id it made up', async () => {
    const r = new SessionRecords();
    const reply: any = await openSession(deps(r, { knows: () => false }), { sessionId: 'nope' });
    expect(reply).toMatchObject({ ok: false, gone: true });
    expect(r.has('nope')).toBe(false);
  });
  it('is "gone" for a session that already ended (a late ask cannot revive it)', async () => {
    const r = new SessionRecords();
    r.begin(S); r.drop(S);
    expect(await openSession(deps(r), { sessionId: S })).toMatchObject({ ok: false, gone: true });
  });
  it('refuses a request that names no conversation', async () => {
    expect(await openSession(deps(new SessionRecords()), { sessionId: '' as any })).toMatchObject({ ok: false });
  });
});

describe('openSession: a first open (page)', () => {
  it('answers with the record\'s recent past first, the page, then what only memory holds', async () => {
    const r = new SessionRecords();
    r.begin(S);
    r.note(S, 'transcript:event', user(1));
    for (let i = 0; i < 50; i++) r.note(S, 'transcript:event', delta(i, 'w '));
    r.note(S, 'hook:event', ask('a1'));
    const reply = ok(await openSession(deps(r), { sessionId: S }));
    expect(reply.resume).toBe('page');
    expect(reply.epoch).toBe(r.epochOf(S));
    expect(reply.headSeq).toBe(52);
    expect(reply.before.map((p: any) => p.payload.uuid)).toEqual(['m1', 'd0']);       // the 50 deltas are ONE entry
    expect((reply.before[1].payload as any).data.text).toBe('w '.repeat(50));
    expect(reply.page.events).toHaveLength(1);
    expect(reply.after.map((p: any) => p.type)).toEqual(['hook:event', 'transcript:event', 'hook:replay-complete']);
    expect(reply.after[2].payload).toEqual({ sessionId: S, pendingRequestIds: ['a1'] });
    expect(reply.facts).toEqual({ working: true });   // sync-fix3: attention was sent and never applied, so it is no longer sent
  });

  it('samples the head BEFORE the page is read, so anything that happens during the read is above it', async () => {
    const r = new SessionRecords();
    r.begin(S);
    r.note(S, 'transcript:event', user(1));
    let release!: () => void;
    const slow = new Promise<void>((res) => { release = res; });
    const pending = openSession(deps(r, { page: async () => { await slow; return page(); } }), { sessionId: S });
    r.note(S, 'transcript:event', delta(2, 'during the read'));     // arrives while the page is being read
    release();
    const reply = ok(await pending);
    expect(reply.headSeq).toBe(1);                                  // the event during the read is NOT counted as included
    expect(reply.before.map((p: any) => p.payload.uuid)).toEqual(['m1']);
  });

  it('an idle Claude Code session reports false for idleness (it can never be affirmed), a native one reports what its host says', async () => {
    const r = new SessionRecords();
    r.begin(S);
    const cc = ok(await openSession(deps(r), { sessionId: S }));
    expect(cc.after.at(-2).payload.data.sessionIdle).toBe(false);
    const live: NativeLive = { askEvents: () => [], specialistRuns: () => [], shellRuns: () => [], usageProgress: () => null, sessionContext: () => null, idle: () => true , queue: () => [], permissionMode: () => null};
    const nat = ok(await openSession(deps(r, { native: () => live }), { sessionId: S }));
    expect(nat.after.find((p: any) => p.type === 'transcript:event').payload.data.sessionIdle).toBe(true);
  });

  it('a native session\'s asks, helper runs, shell runs, progress and starting context come from its host', async () => {
    const r = new SessionRecords();
    r.begin(S);
    const progress = { sessionId: S, type: 'assistant-thinking', uuid: 'prog', timestamp: 5, data: { usageProgress: {} } };
    const live: NativeLive = {
      askEvents: () => [ask('native-r1') as any], specialistRuns: () => [{ childId: 'c1' } as any], shellRuns: () => [{ shellId: 'sh1' } as any],
      usageProgress: () => progress as any, sessionContext: () => ({ k: 1 }), idle: () => false, queue: () => [], permissionMode: () => null,
    };
    const reply = ok(await openSession(deps(r, { native: () => live }), { sessionId: S }));
    expect(reply.after.map((p: any) => p.type)).toEqual(['hook:event', 'specialists:event', 'native:shell-event', 'transcript:event', 'native:session-context', 'session:live', 'transcript:event', 'hook:replay-complete']);
    expect(reply.after[1].payload).toEqual({ kind: 'run', sessionId: S, run: { childId: 'c1' } });
    expect(reply.after.at(-1).payload.pendingRequestIds).toEqual(['native-r1']);
  });

  it('never replays a password ask to a phone (its command line); a window gets it', async () => {
    const r = new SessionRecords();
    r.begin(S);
    const live: NativeLive = { askEvents: () => [ask('p1', 'PasswordRequest') as any, ask('a1') as any], specialistRuns: () => [], shellRuns: () => [], usageProgress: () => null, sessionContext: () => null, idle: () => false , queue: () => [], permissionMode: () => null};
    const phone = ok(await openSession(deps(r, { native: () => live }), { sessionId: S }, { remote: true }));
    expect(phone.after.filter((p: any) => p.type === 'hook:event').map((p: any) => p.payload.type)).toEqual(['PermissionRequest']);
    const win = ok(await openSession(deps(r, { native: () => live }), { sessionId: S }));
    expect(win.after.filter((p: any) => p.type === 'hook:event').map((p: any) => p.payload.type)).toEqual(['PasswordRequest', 'PermissionRequest']);
  });

  it('a Claude Code ask raised before anyone connected is replayed from the record (the torn-off window used to lose it)', async () => {
    const r = new SessionRecords();
    r.begin(S);
    r.note(S, 'hook:event', ask('cc-1'));
    const reply = ok(await openSession(deps(r), { sessionId: S }));
    expect(reply.after[0]).toMatchObject({ type: 'hook:event', payload: { type: 'PermissionRequest' } });
  });

  it('carries the terminal when asked, cut from the same record', async () => {
    const r = new SessionRecords();
    r.begin(S); r.notePty(S, 'hello');
    const reply = ok(await openSession(deps(r), { sessionId: S, pty: {} }));
    expect(reply.pty).toEqual({ epoch: r.epochOf(S), offset: 0, data: 'hello', reset: false });
    expect(ok(await openSession(deps(r), { sessionId: S })).pty).toBeUndefined();
  });
});

describe('openSession: a reconnect (events)', () => {
  const have = (r: SessionRecords) => ({ epoch: r.epochOf(S)!, seq: r.headSeq(S) });

  it('sends exactly the events missed, in order, and no page', async () => {
    const r = new SessionRecords();
    r.begin(S);
    r.note(S, 'transcript:event', user(1));
    const h = have(r);
    r.note(S, 'transcript:event', delta(2, 'a')); r.note(S, 'transcript:event', delta(3, 'b'));
    let pageRead = false;
    const reply = ok(await openSession(deps(r, { page: async () => { pageRead = true; return page(); } }), { sessionId: S, have: h }));
    expect(reply.resume).toBe('events');
    expect(pageRead).toBe(false);
    expect(reply.page).toBeNull();
    expect(reply.after.filter((p: any) => p.type === 'transcript:event').map((p: any) => p.payload.uuid)).toEqual(['d2', 'd3']);   // raw, not merged: it continues what the screen holds
  });

  it('sends nothing but the consent list when nothing was missed', async () => {
    const r = new SessionRecords();
    r.begin(S); r.note(S, 'transcript:event', user(1));
    const reply = ok(await openSession(deps(r), { sessionId: S, have: have(r) }));
    expect(reply.after.map((p: any) => p.type)).toEqual(['hook:replay-complete']);
  });

  it('an ask answered while the screen was away is not in the open list, so its card is cleared with a neutral note', async () => {
    const r = new SessionRecords();
    r.begin(S);
    r.note(S, 'hook:event', ask('a1'));
    const h = have(r);
    r.note(S, 'hook:event', closed('a1'));
    const reply = ok(await openSession(deps(r), { sessionId: S, have: h }));
    expect(reply.after.at(-1)).toEqual({ type: 'hook:replay-complete', payload: { sessionId: S, pendingRequestIds: [] } });
  });

  it('an ask raised AND answered during the gap is not drawn at all (no card flashed for a dead question)', async () => {
    const r = new SessionRecords();
    r.begin(S);
    const h = have(r);
    r.note(S, 'hook:event', ask('a2')); r.note(S, 'hook:event', closed('a2'));
    const reply = ok(await openSession(deps(r), { sessionId: S, have: h }));
    expect(reply.after.filter((p: any) => p.payload?.type === 'PermissionRequest')).toEqual([]);
  });

  it('a Claude Code ask whose hook closed (its own menu may still wait) is kept: its request is still replayed', async () => {
    const r = new SessionRecords();
    r.begin(S);
    const h = have(r);
    r.note(S, 'hook:event', ask('a3')); r.note(S, 'hook:event', closed('a3', 'PermissionExpired', 'hook-closed'));
    const reply = ok(await openSession(deps(r), { sessionId: S, have: h }));
    expect(reply.after.filter((p: any) => p.payload?.type === 'PermissionRequest')).toHaveLength(1);
  });

  it('falls back to a fresh page when the epoch changed, the gap is older than the ring, or the screen is ahead; Refresh always does', async () => {
    const r = new SessionRecords({ maxEvents: 5 });
    r.begin(S);
    for (let i = 0; i < 3; i++) r.note(S, 'transcript:event', user(i));
    const old = have(r);
    expect(ok(await openSession(deps(r), { sessionId: S, have: { epoch: 'another', seq: 1 } })).resume).toBe('page');          // epoch changed
    expect(ok(await openSession(deps(r), { sessionId: S, have: { epoch: old.epoch, seq: 99 } })).resume).toBe('page');         // ahead of the record
    for (let i = 0; i < 20; i++) r.note(S, 'transcript:event', user(10 + i));
    expect(ok(await openSession(deps(r), { sessionId: S, have: old })).resume).toBe('page');                                    // ring overflowed
    expect(ok(await openSession(deps(r), { sessionId: S, have: have(r), fresh: true })).resume).toBe('page');                   // Refresh
  });
});

describe('openSession: a resumed conversation', () => {
  it('tells the summary it has history when the page it read is not empty (so a phone draws it blue, like the computer)', async () => {
    const r = new SessionRecords();
    r.begin(S);
    expect(r.summary(S)!.hasHistory).toBe(false);
    ok(await openSession(deps(r, { page: async () => page(2) }), { sessionId: S }));
    expect(r.summary(S)!.hasHistory).toBe(true);
  });
  it('leaves an empty conversation empty', async () => {
    const r = new SessionRecords();
    r.begin(S);
    ok(await openSession(deps(r, { page: async () => page(0) }), { sessionId: S }));
    expect(r.summary(S)!.hasHistory).toBe(false);
  });
});

// One-core sync-fix3: state that was only ever PUSHED once must also be in the answer a late screen is filled from.
describe('openSession: a screen that opens late is handed one-shot state (sync-fix3)', () => {
  const kinds = (r: any) => [...r.before, ...r.after].map((p: any) => p.type + (p.payload?.kind ? `:${p.payload.kind}` : ''));

  it('hands over a native local model that is asleep or loading, with its size and progress, so the Reload / loading bar shows', async () => {
    const r = new SessionRecords();
    r.begin(S);
    r.note(S, 'native:model-state', { sessionId: S, modelId: 'm1', state: 'loading', sizeBytes: 900, loadedBytes: 300 });
    const reply = ok(await openSession(deps(r), { sessionId: S, fresh: true }));
    const p = [...reply.before, ...reply.after].find((x: any) => x.type === 'native:model-state') as any;
    expect(p?.payload).toEqual({ sessionId: S, state: 'loading', modelId: 'm1', sizeBytes: 900, loadedBytes: 300 });
  });
  it('sends no model state for a session that never had one', async () => {
    const r = new SessionRecords();
    r.begin(S);
    expect(kinds(ok(await openSession(deps(r), { sessionId: S, fresh: true })))).not.toContain('native:model-state');
  });

  it('keeps the "Model switched" and "Conversation cleared" dividers in a page fill, in order with the messages around them', async () => {
    const r = new SessionRecords();
    r.begin(S);
    r.note(S, 'transcript:event', user(1));
    r.note(S, 'session:live', { sessionId: S, kind: 'model-switch', id: 'ms1', label: 'Model switched to Opus' });
    r.note(S, 'session:live', { sessionId: S, kind: 'model-switch', id: 'ms2', label: 'Model switched to Sonnet' });
    r.note(S, 'session:live', { sessionId: S, kind: 'model-switch-retract', id: 'ms2' });
    r.note(S, 'transcript:event', user(2));
    r.note(S, 'session:live', { sessionId: S, kind: 'clear', id: 'c1' });
    const reply = ok(await openSession(deps(r), { sessionId: S, fresh: true }));
    expect(reply.before.map((p: any) => p.payload.uuid ?? p.payload.id)).toEqual(['m1', 'ms1', 'ms2', 'ms2', 'm2', 'c1']);
  });
  it('does not put other live kinds (a card, a queue) in the tail: those have their own place in the answer', async () => {
    const r = new SessionRecords();
    r.begin(S);
    r.note(S, 'session:live', { sessionId: S, kind: 'queue', queue: [] });
    r.note(S, 'session:live', { sessionId: S, kind: 'compact-start', id: 'k' });
    expect(r.fillTail(S)).toEqual([]);
  });
  it('a divider drawn the moment the transcript file rotates (a Claude Code /clear) survives, in either order, but older ones do not', async () => {
    const a = new SessionRecords();
    a.begin(S);
    a.note(S, 'transcript:event', user(1));
    a.note(S, 'session:live', { sessionId: S, kind: 'model-switch', id: 'old', label: 'x' });
    a.note(S, 'session:live', { sessionId: S, kind: 'clear', id: 'c1' });
    a.startNewTranscript(S);                       // the hook's divider came first, then the file rotated
    expect(a.fillTail(S).map((t: any) => t.payload.id)).toEqual(['c1']);
    const b = new SessionRecords();
    b.begin(S);
    b.note(S, 'transcript:event', user(1));
    b.startNewTranscript(S);                       // the file rotated first, then the divider
    b.note(S, 'session:live', { sessionId: S, kind: 'clear', id: 'c2' });
    expect(b.fillTail(S).map((t: any) => t.payload.id)).toEqual(['c2']);
  });
});
