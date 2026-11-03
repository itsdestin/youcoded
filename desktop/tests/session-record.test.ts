import { describe, it, expect, vi } from 'vitest';
import { SessionRecords, estimateSize, RING_MAX_EVENTS, RING_MAX_BYTES, SESSION_SCOPED_PUSHES, TAIL_MAX_ENTRIES, PTY_STREAM_UNITS } from '../src/main/session-record';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, type ChatState, type SessionChatState, type ChatAction } from '../src/renderer/state/chat-types';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import { ev } from './helpers/transcript-events';
import { type HookEvent, type TranscriptEvent, type TranscriptPageResult } from '../src/shared/types';
import { openSession, type OpenDeps, type OpenReply } from '../src/main/session-open';
import { AudienceFills } from '../src/main/audience-fill';
import { createPublish } from '../src/main/publish';
import { screenOf, SID } from './helpers/fill-scenarios';

// The session record (src/main/session-record.ts): the numbered ring, the epoch, the open asks, the resume rule.
describe("the record's ring, epoch and resume", () => {
  const S = 's1';
  const text = (n: number, size = 20) => ({ sessionId: S, type: 'assistant-text', uuid: `u${n}`, timestamp: n, data: { text: 'x'.repeat(size) } });
  const ask = (id: string) => ({ type: 'PermissionRequest', sessionId: S, payload: { _requestId: id, tool_name: 'Bash' }, timestamp: 1 });
  const hook = (type: string, id: string, extra: Record<string, unknown> = {}) => ({ type, sessionId: S, payload: { _requestId: id, ...extra }, timestamp: 1 });

  function fill(r: SessionRecords, n: number, size = 20) {
    for (let i = 1; i <= n; i++) r.note(S, 'transcript:event', text(i, size));
  }

  describe('startup facts for late screens', () => {
    it('hands a late screen the "Started with" record, which a fill would otherwise clear', () => {
      const r = new SessionRecords(); r.begin(S);
      const context = { assembledBy: 'claude-code', skills: [{ name: 'a' }], tools: [] };
      r.note(S, 'native:session-context', { sessionId: S, context });
      fill(r, RING_MAX_EVENTS + 10);
      expect(r.liveFill(S)).toContainEqual({ type: 'native:session-context', payload: { sessionId: S, context } });
    });
    it('keeps startup state outside the trimmed transcript ring', () => {
      const r = new SessionRecords(); r.begin(S);
      const state = { phase: 'connecting', attemptId: 'attempt', hostId: 'host', generation: 1, revision: 1 };
      r.note(S, 'session:live', { sessionId: S, kind: 'native-startup', state });
      fill(r, RING_MAX_EVENTS + 10);
      expect(r.liveFill(S)).toContainEqual({ type: 'session:live', payload: { sessionId: S, kind: 'native-startup', state } });
    });
    it('replaces a failed initialization with its current ready state', () => {
      const r = new SessionRecords(); r.begin(S);
      r.note(S, 'session:live', { sessionId: S, kind: 'native-startup', state: { phase: 'connecting', attemptId: 'a', hostId: 'host', generation: 1, revision: 1 } });
      const ready = { phase: 'ready', hostId: 'host', generation: 1, revision: 2 };
      r.note(S, 'session:live', { sessionId: S, kind: 'native-startup', state: ready });
      expect(r.liveFill(S).filter((p: any) => p.payload.kind === 'native-startup')).toEqual([
        { type: 'session:live', payload: { sessionId: S, kind: 'native-startup', state: ready } },
      ]);
    });
  });

  describe('the ring', () => {
    it('numbers events from 1 without gaps', () => {
      const r = new SessionRecords();
      fill(r, 5);
      expect(r.events(S).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(r.headSeq(S)).toBe(5);
    });

    it('never holds more than 2,000 events, and keeps the newest', () => {
      const r = new SessionRecords();
      fill(r, RING_MAX_EVENTS + 750);
      const ev = r.events(S);
      expect(ev).toHaveLength(RING_MAX_EVENTS);
      expect(ev[0].seq).toBe(751);
      expect(ev.at(-1)!.seq).toBe(RING_MAX_EVENTS + 750);
      expect(r.oldestSeq(S)).toBe(751);
    });

    it('never holds more than 2 MB, and keeps the newest', () => {
      const r = new SessionRecords();
      fill(r, 100, 100_000); // ~100 KB each: about 10 MB offered
      const ev = r.events(S);
      const bytes = ev.reduce((s, e) => s + e.bytes, 0);
      expect(bytes).toBeLessThanOrEqual(RING_MAX_BYTES);
      expect(ev.length).toBeLessThan(25);
      expect(ev.at(-1)!.seq).toBe(100);
      expect(r.stats().ringBytes).toBe(bytes); // the running total matches what is held
    });

    it('holds whichever bound is reached first (many tiny events: the count; a few huge ones: the bytes)', () => {
      const tiny = new SessionRecords();
      fill(tiny, 5000, 1);
      expect(tiny.events(S)).toHaveLength(RING_MAX_EVENTS);
      const huge = new SessionRecords();
      fill(huge, 10, 500_000);
      expect(huge.events(S).length).toBeLessThanOrEqual(4);
    });

    it('keeps a small custom bound too (the bounds are parameters, not literals in the loop)', () => {
      const r = new SessionRecords({ maxEvents: 3, maxBytes: 10_000 });
      fill(r, 10);
      expect(r.events(S).map((e) => e.seq)).toEqual([8, 9, 10]);
    });

    it('numbers an event too large to hold but does not hold it, so a client sees a gap and takes a fresh page', () => {
      const r = new SessionRecords();
      fill(r, 3);
      r.note(S, 'transcript:event', text(4, RING_MAX_BYTES + 10));
      r.note(S, 'transcript:event', text(5));
      expect(r.headSeq(S)).toBe(5);
      expect(r.events(S).map((e) => e.seq)).toEqual([1, 2, 3, 5]);
      // A client that had event 3 cannot be handed 4: it is not held.
      expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 3 })).toMatchObject({ resume: 'page' });
      expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 4 })).toMatchObject({ resume: 'events' });
    });
  });

  describe('direct-send uncertainty', () => {
    it('does not call a pending direct operation not-received', () => {
      const r = new SessionRecords(); r.begin(S);
      r.noteSendPending(S, 'send-pending');
      expect(r.sendOutcomes(S, ['send-pending', 'never'], r.epochOf(S)).outcomes)
        .toEqual({ 'send-pending': 'unknown', never: 'not-received' });
      r.noteSend(S, 'send-pending');
      expect(r.sendOutcomes(S, ['send-pending'], r.epochOf(S)).outcomes['send-pending']).toBe('received');
    });

    it('clears uncertainty only after definite pre-effect refusal', () => {
      const r = new SessionRecords(); r.begin(S);
      r.noteSendPending(S, 'refused'); r.noteSendRefused(S, 'refused');
      expect(r.sendOutcomes(S, ['refused'], r.epochOf(S)).outcomes.refused).toBe('not-received');
      r.noteSend(S, 'accepted'); r.noteSendPending(S, 'accepted'); r.noteSendRefused(S, 'accepted');
      expect(r.sendOutcomes(S, ['accepted'], r.epochOf(S)).outcomes.accepted).toBe('received');
    });

    it('never turns evicted uncertain IDs into definite non-receipt', () => {
      const r = new SessionRecords(); r.begin(S);
      for (let i = 0; i < 600; i++) r.noteSendPending(S, `uncertain-${i}`);
      expect(r.sendOutcomes(S, ['uncertain-0', 'uncertain-599'], r.epochOf(S)).outcomes)
        .toEqual({ 'uncertain-0': 'unknown', 'uncertain-599': 'unknown' });
    });
  });

  describe('the epoch', () => {
    it('is new for each record, and random', () => {
      const r = new SessionRecords();
      r.begin('a'); r.begin('b');
      expect(r.epochOf('a')).toMatch(/^[0-9a-f]{16}$/);
      expect(r.epochOf('a')).not.toBe(r.epochOf('b'));
    });

    it('does not change when events arrive, including a /clear or /compact', () => {
      const r = new SessionRecords();
      r.begin(S);
      const epoch = r.epochOf(S);
      fill(r, 10);
      r.note(S, 'transcript:shrink', { sessionId: S, oldSize: 100, newSize: 5 }); // /compact and /clear truncate the file
      r.note(S, 'transcript:event', { sessionId: S, type: 'context-clear', uuid: 'c', timestamp: 1, data: {} });
      r.note(S, 'transcript:event', { sessionId: S, type: 'compact-summary', uuid: 'cs', timestamp: 2, data: { summary: 's' } });
      expect(r.epochOf(S)).toBe(epoch);
      // The shrink is itself a numbered event, so a client inside the range replays it.
      expect(r.events(S).some((e) => e.type === 'transcript:shrink')).toBe(true);
    });

    it('a session created again (resumed, or the app restarted) is a new record with a new epoch, and a number restarted at 1', () => {
      const r = new SessionRecords();
      r.begin(S);
      const first = r.epochOf(S);
      fill(r, 3);
      r.drop(S);
      r.begin(S);
      expect(r.epochOf(S)).not.toBe(first);
      expect(r.headSeq(S)).toBe(0);
    });

    it('is never reused after the session ends: a late event does not bring the record back', () => {
      const r = new SessionRecords();
      fill(r, 2);
      r.drop(S);
      expect(r.note(S, 'transcript:event', text(3))).toBeNull();
      expect(r.has(S)).toBe(false);
      expect(r.facts(S)).toBeNull();
    });
  });

  describe('resume: events after N, or a fresh page', () => {
    const make = () => { const r = new SessionRecords({ maxEvents: 5 }); fill(r, 12); return r; }; // holds 8..12

    it('same epoch, next event still held: send what was missed', () => {
      const r = make();
      const d = r.resume(S, { epoch: r.epochOf(S)!, seq: 9 });
      expect(d).toMatchObject({ resume: 'events', headSeq: 12 });
      expect((d as any).events.map((e: any) => e.seq)).toEqual([10, 11, 12]);
    });

    it('exactly at the oldest edge is still a replay (the next event is the first one held)', () => {
      const r = make();
      expect((r.resume(S, { epoch: r.epochOf(S)!, seq: 7 }) as any).events.map((e: any) => e.seq)).toEqual([8, 9, 10, 11, 12]);
    });

    it('older than the ring reaches: a fresh page', () => {
      const r = make();
      expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 6 })).toMatchObject({ resume: 'page' });
    });

    it('a different epoch, nothing, or a number from the future: a fresh page', () => {
      const r = make();
      expect(r.resume(S, { epoch: 'other', seq: 10 })).toMatchObject({ resume: 'page' });
      expect(r.resume(S, null)).toMatchObject({ resume: 'page' });
      expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 99 })).toMatchObject({ resume: 'page' });
    });

    it('already at the head: nothing to send, still a replay', () => {
      const r = make();
      expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 12 })).toMatchObject({ resume: 'events', events: [] });
    });

    it('a session that does not exist answers null', () => {
      expect(new SessionRecords().resume('nope', null)).toBeNull();
    });
  });

  describe('open asks live outside the ring', () => {
    it('survive the ring trimming away the request that raised them', () => {
      const r = new SessionRecords();
      r.note(S, 'hook:event', ask('r1'));
      fill(r, RING_MAX_EVENTS * 3);
      expect(r.events(S).some((e) => (e.payload as any)?.type === 'PermissionRequest')).toBe(false); // trimmed out of the ring
      expect(r.openAsks(S)).toHaveLength(1); // still waiting
      expect(r.facts(S)!.awaitingCount).toBe(1);
    });

    it('leave when resolved, and when they expire (except a Claude Code ask whose hook closed: its own menu may still wait)', () => {
      const r = new SessionRecords();
      r.note(S, 'hook:event', ask('a'));
      r.note(S, 'hook:event', ask('b'));
      r.note(S, 'hook:event', ask('c'));
      r.note(S, 'hook:event', ask('d'));
      r.note(S, 'hook:event', hook('PermissionResolved', 'a'));
      r.note(S, 'hook:event', hook('PermissionExpired', 'b', { _reason: 'app-timeout' }));
      r.note(S, 'hook:event', hook('PermissionExpired', 'c', { _reason: 'hook-closed' }));
      expect(r.openAsks(S).map((e: any) => e.payload._requestId).sort()).toEqual(['c', 'd']);
      r.note(S, 'hook:event', hook('PermissionExpired', 'd')); // no reason: resolved
      expect(r.openAsks(S).map((e: any) => e.payload._requestId)).toEqual(['c']);
    });

    it('hold the whole event so a card can be drawn from it', () => {
      const r = new SessionRecords();
      r.note(S, 'hook:event', ask('r1'));
      expect(r.openAsks(S)[0]).toMatchObject({ type: 'PermissionRequest', payload: { tool_name: 'Bash' } });
    });

    it('are capped per session, so a runaway producer cannot grow the set without bound', () => {
      const r = new SessionRecords();
      for (let i = 0; i < 500; i++) r.note(S, 'hook:event', ask(`r${i}`));
      expect(r.openAsks(S).length).toBeLessThanOrEqual(200);
    });

    it('never keep a password ask (only that one is waiting), in the ring or among the asks', () => {
      const r = new SessionRecords();
      r.note(S, 'hook:event', { type: 'PasswordRequest', sessionId: S, payload: { _requestId: 'pw', command: 'sudo secret-thing', toolUseId: 't' }, timestamp: 1 });
      expect(r.facts(S)!.awaitingCount).toBe(1);
      expect(r.openAsks(S)).toEqual([]);
      expect(JSON.stringify(r.events(S))).not.toContain('secret-thing');
      r.note(S, 'hook:event', hook('PasswordResolved', 'pw'));
      expect(r.facts(S)!.awaitingCount).toBe(0);
    });
  });

  describe('live facts and the summary', () => {
    it('read a native session\'s queue and mode from the host, never a copy of them', () => {
      const r = new SessionRecords();
      let queue = ['q1', 'q2'];
      r.setLiveSource((id) => (id === S ? { queued: queue, permissionMode: 'auto-edit' } : null));
      r.begin(S);
      expect(r.summary(S)).toMatchObject({ queuedCount: 2 });
      // sync-fix3: no screen read the summary's mode or model, so it carries neither (the fill hands a late screen the chips).
      expect(Object.keys(r.summary(S)!).sort()).toEqual(['attention', 'awaitingCount', 'hasHistory', 'queuedCount', 'started', 'working']);
      queue = [];
      expect(r.summary(S)!.queuedCount).toBe(0);
    });

    it('take the mode and the model state from their pushes when no host answers', () => {
      const r = new SessionRecords();
      r.note(S, 'native:permission-mode', { sessionId: S, mode: 'full-auto' });
      r.note(S, 'native:model-state', { sessionId: S, modelId: 'm1', state: 'loading' });
      r.note(S, 'transcript:event', { sessionId: S, type: 'assistant-text', uuid: 'a', timestamp: 1, data: { text: 'x', model: 'claude-opus' } });
      expect(r.facts(S)).toMatchObject({ permissionMode: 'full-auto', modelState: { state: 'loading', modelId: 'm1', sizeBytes: null, loadedBytes: null }, model: 'claude-opus' });
    });

    it('prefer a relayed attention that says something is wrong, else what the events say', () => {
      const r = new SessionRecords();
      r.begin(S);
      r.noteReportedAttention(S, 'stuck');
      expect(r.summary(S)!.attention).toBe('stuck');
      r.noteReportedAttention(S, 'ok');
      expect(r.summary(S)!.attention).toBe('ok');
    });

    it('cover every live session and only those', () => {
      const r = new SessionRecords();
      r.begin('a'); r.begin('b'); r.drop('a');
      expect(Object.keys(r.summaries())).toEqual(['b']);
    });

    it('survive a host that throws (a bad read costs the host\'s facts, not the summary)', () => {
      const r = new SessionRecords();
      r.setLiveSource(() => { throw new Error('boom'); });
      r.begin(S);
      expect(r.summary(S)).toMatchObject({ queuedCount: 0 });
    });
  });

  describe('what is carried', () => {
    it('lists the eleven session-scoped pushes', () => {
      expect([...SESSION_SCOPED_PUSHES].sort()).toEqual([
        'hook:event', 'native:model-state', 'native:permission-mode', 'native:session-context', 'native:shell-event',
        'session:live', 'session:meta-changed', 'session:permission-mode', 'specialists:event', 'transcript:event', 'transcript:shrink',
      ]);
    });
  });

  describe('sizing an event without serialising it', () => {
    const bigResult = () => ({ sessionId: S, type: 'tool-result', uuid: 'big', timestamp: 1, data: { toolUseId: 't', toolResult: 'abcdefghij\n'.repeat(480_000), isError: false } }); // ~5 MB

    it('does not JSON.stringify a 5 MB tool result, and costs a tiny fraction of serialising it', () => {
      const r = new SessionRecords();
      r.begin(S);
      const ev = bigResult();
      const spy = vi.spyOn(JSON, 'stringify');
      const c0 = process.cpuUsage();
      r.note(S, 'transcript:event', ev);
      const c = process.cpuUsage(c0);
      const stringified = spy.mock.calls.length;
      spy.mockRestore();
      const s0 = process.cpuUsage();
      JSON.stringify(ev);
      const full = process.cpuUsage(s0);
      expect(stringified).toBe(0);
      // CPU time, not wall clock. Serialising 5 MB is milliseconds; the estimate reads a length.
      // WHY the Windows slack: its CPU clock moves in ~15.6 ms steps, so even a few microseconds of
      // work can read as one whole step (15000 µs failed here daily). The JSON.stringify spy above
      // still catches a serialise there; elsewhere the strict bound stands.
      const tick = process.platform === 'win32' ? 16_000 : 1000;
      expect(c.user + c.system).toBeLessThan((full.user + full.system) / 4 + tick);
    });

    it('counts a multi-MB event as oversize (numbered, not held) and keeps the ring bound', () => {
      const r = new SessionRecords();
      r.note(S, 'transcript:event', bigResult());
      expect(r.headSeq(S)).toBe(1);
      expect(r.events(S)).toHaveLength(0);
    });

    it('tracks the JSON length closely for ordinary events (within 25%)', () => {
      for (const e of [text(1, 20), text(2, 2000), ask('r1'), { type: 'tool-use', data: { toolUseId: 't', toolName: 'Bash', toolInput: { command: 'ls -la /tmp && cat x' } } }]) {
        const real = JSON.stringify(e).length;
        expect(Math.abs(estimateSize(e) - real) / real).toBeLessThan(0.25);
      }
    });

    it('gives up walking a huge object after a fixed number of nodes (bounded CPU)', () => {
      const wide = { items: Array.from({ length: 200_000 }, (_, i) => ({ i })) };
      const c0 = process.cpuUsage();
      estimateSize(wide);
      const c = process.cpuUsage(c0);
      expect(c.user + c.system).toBeLessThan(20_000); // microseconds
    });
  });

  describe('the summary change announcement (what a phone\'s dots wait for)', () => {
    const userMsg = (n: number) => ({ sessionId: S, type: 'user-message', uuid: `m${n}`, timestamp: n, data: { text: 'go' } });
    const streamed = (n: number) => ({ sessionId: S, type: 'assistant-text', uuid: `t${n}`, timestamp: n, data: { text: 'w', partId: 'p' } });

    function watched() {
      const r = new SessionRecords();
      const heard: string[] = [];
      r.onSummaryChange((sid) => heard.push(sid));
      r.begin(S);
      heard.length = 0;
      return { r, heard };
    }

    it('says a session appeared and says it ended', () => {
      const r = new SessionRecords();
      const heard: string[] = [];
      r.onSummaryChange((sid) => heard.push(sid));
      r.begin(S);
      expect(heard).toEqual([S]);
      r.drop(S);
      expect(heard).toEqual([S, S]);
      r.drop(S);                                  // dropping what is not there says nothing
      expect(heard).toHaveLength(2);
    });

    it('says it the moment a turn starts, a question is raised or answered, the attention flips, and a turn ends', () => {
      const { r, heard } = watched();
      r.note(S, 'transcript:event', userMsg(1));  expect(heard).toHaveLength(1);   // working + history
      r.note(S, 'hook:event', ask('a1'));          expect(heard).toHaveLength(2);   // a question waits
      r.note(S, 'hook:event', hook('PermissionResolved', 'a1')); expect(heard).toHaveLength(3);
      r.note(S, 'transcript:event', { sessionId: S, type: 'assistant-thinking', uuid: 'h1', timestamp: 5, data: { stalled: true } }); expect(heard).toHaveLength(4);
      r.noteReportedAttention(S, 'awaiting-input'); expect(heard).toHaveLength(5);  // a window's classifier
      r.note(S, 'transcript:event', { sessionId: S, type: 'turn-complete', uuid: 'c1', timestamp: 6, data: { stopReason: 'end_turn' } }); expect(heard).toHaveLength(6);
    });

    it('stays quiet for a streamed answer: thousands of events, no summary field moves', () => {
      const { r, heard } = watched();
      r.note(S, 'transcript:event', userMsg(1));
      heard.length = 0;
      for (let i = 0; i < 500; i++) r.note(S, 'transcript:event', streamed(i));
      expect(heard.length).toBeLessThanOrEqual(1);  // only the first answer text can change a field (nothing here sets a model)
    });

    it('a listener that throws never costs the session its event', () => {
      const r = new SessionRecords();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      r.onSummaryChange(() => { throw new Error('listener bug'); });
      r.begin(S);
      expect(() => r.note(S, 'transcript:event', userMsg(1))).not.toThrow();
      expect(r.events(S)).toHaveLength(1);
      warn.mockRestore();
    });
  });

  describe('the summary announcement also covers the queue length', () => {
    it('announces when a native session\'s queue grows though no event carried it, and stays quiet when only the mode changes (no screen reads it from the summary)', () => {
      const r = new SessionRecords();
      let queued: string[] = [];
      let mode: string | null = 'ask';
      r.setLiveSource(() => ({ queued, permissionMode: mode }));
      r.begin(S);
      const heard: string[] = [];
      r.onSummaryChange((sid) => heard.push(sid));
      r.note(S, 'transcript:event', { sessionId: S, type: 'assistant-text', uuid: 'a', timestamp: 1, data: { text: 'x', partId: 'p' } });
      heard.length = 0;
      queued = ['q1'];
      r.note(S, 'transcript:event', { sessionId: S, type: 'assistant-text', uuid: 'b', timestamp: 2, data: { text: 'y', partId: 'p' } });
      expect(heard).toHaveLength(1);
      mode = 'auto-edit';
      r.note(S, 'transcript:event', { sessionId: S, type: 'assistant-text', uuid: 'c', timestamp: 3, data: { text: 'z', partId: 'p' } });
      expect(heard).toHaveLength(1);
    });

    it('noteHistory says a resumed conversation has history, once', () => {
      const r = new SessionRecords();
      r.begin(S);
      const heard: string[] = [];
      r.onSummaryChange((sid) => heard.push(sid));
      r.noteHistory(S); r.noteHistory(S);
      expect(heard).toEqual([S]);
      expect(r.summary(S)!.hasHistory).toBe(true);
    });
  });

  describe('what the computer reads a session\'s screen for', () => {
    const user = { sessionId: S, type: 'user-message', uuid: 'um1', timestamp: 1, data: { text: 'go' } };
    const toolUse = (id: string, extra: Record<string, unknown> = {}) => ({ sessionId: S, type: 'tool-use', uuid: `tu-${id}`, timestamp: 1, data: { toolUseId: id, toolName: 'Bash', ...extra } });
    const toolResult = (id: string) => ({ sessionId: S, type: 'tool-result', uuid: `tr-${id}`, timestamp: 1, data: { toolUseId: id, toolResult: 'ok', isError: false } });
    const turnDone = { sessionId: S, type: 'turn-complete', uuid: 'td1', timestamp: 2, data: {} };

    it('working, a tool running, an ask waiting, started and cards open, as plain facts', () => {
      const r = new SessionRecords();
      r.begin(S);
      expect(r.screenNeed(S)).toEqual({ working: false, toolRunning: false, asking: false, started: false, cards: 0, permissionCard: false });
      r.note(S, 'transcript:event', user);
      r.note(S, 'transcript:event', toolUse('t1'));
      r.note(S, 'hook:event', ask('a1'));
      expect(r.screenNeed(S)).toEqual({ working: true, toolRunning: true, asking: true, started: true, cards: 0, permissionCard: true });
      r.note(S, 'hook:event', hook('PermissionResolved', 'a1'));
      r.note(S, 'transcript:event', toolResult('t1'));
      r.note(S, 'session:live', { sessionId: S, kind: 'prompt-show', promptId: 'p1', title: 'Usage Limit Reached', buttons: [] });
      expect(r.screenNeed(S)).toEqual({ working: true, toolRunning: false, asking: false, started: true, cards: 1, permissionCard: false });
      r.note(S, 'transcript:event', turnDone);
      expect(r.screenNeed(S)!.working).toBe(false);
      expect(r.screenNeed('nope')).toBeNull();
    });

    it('a tool running is a started tool-use without its result, never a helper\'s inner tool, and the turn ending clears them all', () => {
      const r = new SessionRecords();
      r.begin(S);
      r.note(S, 'transcript:event', user);
      r.note(S, 'transcript:event', toolUse('inner', { parentAgentToolUseId: 'outer' }));
      expect(r.screenNeed(S)!.toolRunning).toBe(false);
      r.note(S, 'transcript:event', toolUse('t1'));
      r.note(S, 'transcript:event', toolUse('t2'));
      r.note(S, 'transcript:event', toolResult('t1'));
      expect(r.screenNeed(S)!.toolRunning).toBe(true);                      // t2 is still going
      r.note(S, 'transcript:event', turnDone);
      expect(r.screenNeed(S)!.toolRunning).toBe(false);
    });

    it('an ask Claude Code closed its hook on (kept) is not waiting on the person, a password ask is', () => {
      const r = new SessionRecords();
      r.begin(S);
      r.note(S, 'hook:event', ask('a1'));
      r.note(S, 'hook:event', { type: 'PermissionExpired', sessionId: S, payload: { _requestId: 'a1', _reason: 'hook-closed' }, timestamp: 2 });
      expect(r.screenNeed(S)!.asking).toBe(false);
      r.note(S, 'hook:event', { type: 'PasswordRequest', sessionId: S, payload: { _requestId: 'pw1' }, timestamp: 3 });
      expect(r.screenNeed(S)!.asking).toBe(true);
    });

    it('tells its one listener only when one of those facts changes (a streamed answer of thousands of events is silent), and when the session ends', () => {
      const r = new SessionRecords();
      r.begin(S);
      const heard: string[] = [];
      r.onScreenNeedChange((id) => heard.push(id));
      r.note(S, 'transcript:event', user);                                   // working
      expect(heard).toHaveLength(1);
      for (let i = 0; i < 300; i++) r.note(S, 'transcript:event', text(i + 10));
      expect(heard).toHaveLength(1);
      r.note(S, 'hook:event', hook('PostToolUse', 'x'));                      // the first hook: started
      expect(heard).toHaveLength(2);
      r.note(S, 'transcript:event', turnDone);
      expect(heard).toHaveLength(3);
      r.drop(S);
      expect(heard).toHaveLength(4);
      expect(r.screenNeed(S)).toBeNull();
    });
  });

  describe('what a summary says about "stuck"', () => {
    it('the computer\'s reading shows when nothing else is wrong, another writer\'s state wins, and the turn ending takes it back', () => {
      const r = new SessionRecords();
      r.begin(S);
      r.note(S, 'transcript:event', { sessionId: S, type: 'user-message', uuid: 'u', timestamp: 1, data: { text: 'go' } });
      r.note(S, 'session:live', { sessionId: S, kind: 'attention', state: 'stuck' });
      expect(r.summary(S)!.attention).toBe('stuck');
      r.note(S, 'transcript:event', { sessionId: S, type: 'session-error', uuid: 'e', timestamp: 2, data: {} });
      expect(r.summary(S)!.attention).toBe('error');
      r.note(S, 'session:live', { sessionId: S, kind: 'attention', state: 'stuck' });
      r.note(S, 'transcript:event', { sessionId: S, type: 'user-message', uuid: 'u2', timestamp: 3, data: { text: 'again' } });
      r.note(S, 'session:live', { sessionId: S, kind: 'attention', state: 'stuck' });
      r.note(S, 'transcript:event', { sessionId: S, type: 'turn-complete', uuid: 't', timestamp: 4, data: {} });
      expect(r.summary(S)!.attention).toBe('ok');
      expect(r.liveFill(S).some((p: any) => p.payload.kind === 'attention')).toBe(false);
    });

    it('a dot that changes because of it is announced', () => {
      const r = new SessionRecords();
      r.begin(S);
      const heard: string[] = [];
      r.onSummaryChange((id) => heard.push(id));
      r.note(S, 'session:live', { sessionId: S, kind: 'attention', state: 'stuck' });
      expect(heard).toEqual([S]);
    });
  });
});

// The parts of the session record a screen is FILLED from (one-core R5-2): the merged tail, the terminal stream, and the
// asks as replayable events.
describe('the fill tail, terminal stream and asks', () => {
  const S = 's1';
  const delta = (n: number, text: string, partId = 'text-0', type = 'assistant-text') => ({ sessionId: S, type, uuid: `d${n}`, timestamp: n, data: { text, partId } });
  const user = (n: number, text = 'hi') => ({ sessionId: S, type: 'user-message', uuid: `m${n}`, timestamp: n, data: { text } });
  const tail = (r: SessionRecords) => r.fillTail(S).map((t) => t.payload as any);

  describe('the fill tail', () => {
    it('merges a streaming part\'s deltas into one entry that keeps the FIRST delta\'s uuid', () => {
      const r = new SessionRecords();
      r.note(S, 'transcript:event', user(1));
      for (let i = 0; i < 500; i++) r.note(S, 'transcript:event', delta(i, 'ab '));
      const t = tail(r);
      expect(t).toHaveLength(2);
      expect(t[1].uuid).toBe('d0');
      expect(t[1].data.text).toBe('ab '.repeat(500));
      // the ring still holds every event, numbered, for a client that resumes
      expect(r.events(S)).toHaveLength(501);
    });

    it('never changes the event object the windows and phones were handed (it clones before it grows)', () => {
      const r = new SessionRecords();
      const first = delta(1, 'one ');
      r.note(S, 'transcript:event', first);
      r.note(S, 'transcript:event', delta(2, 'two'));
      expect(first.data.text).toBe('one ');
      expect(tail(r)[0].data.text).toBe('one two');
      expect(r.events(S)[0].payload).toBe(first);
    });

    it('does not merge across a different part, a different type, a stamped helper event, or an event in between', () => {
      const r = new SessionRecords();
      r.note(S, 'transcript:event', delta(1, 'a', 'text-0'));
      r.note(S, 'transcript:event', delta(2, 'b', 'text-1'));
      r.note(S, 'transcript:event', delta(3, 'r', 'reasoning-0', 'assistant-thinking'));
      r.note(S, 'transcript:event', { ...delta(4, 'h', 'text-1'), data: { text: 'h', partId: 'text-1', parentAgentToolUseId: 'x' } });
      r.note(S, 'transcript:event', { sessionId: S, type: 'tool-use', uuid: 't', timestamp: 5, data: { toolUseId: 'k', toolName: 'Bash' } });
      r.note(S, 'transcript:event', delta(6, 'c', 'text-1'));
      expect(tail(r).map((e) => e.uuid)).toEqual(['d1', 'd2', 'd3', 'd4', 't', 'd6']);
    });

    it('a retry (dropPart) between two deltas of one part keeps them apart, so the screen drops the half answer', () => {
      const r = new SessionRecords();
      r.note(S, 'transcript:event', delta(1, 'HALF', 'text-0'));
      r.note(S, 'transcript:event', { sessionId: S, type: 'assistant-thinking', uuid: 'dp', timestamp: 2, data: { dropPart: { partIds: ['text-0'] } } });
      r.note(S, 'transcript:event', delta(3, 'REPLACEMENT', 'text-0'));
      expect(tail(r).map((e) => e.uuid)).toEqual(['d1', 'dp', 'd3']);
    });

    it('holds only transcript pushes (a hook, a mode change or a model state are not part of the tail)', () => {
      const r = new SessionRecords();
      r.note(S, 'transcript:event', user(1));
      r.note(S, 'hook:event', { type: 'PermissionRequest', sessionId: S, payload: { _requestId: 'a' }, timestamp: 1 });
      r.note(S, 'native:permission-mode', { sessionId: S, mode: 'ask' });
      r.note(S, 'transcript:shrink', { sessionId: S });
      expect(r.fillTail(S).map((t) => t.type)).toEqual(['transcript:event', 'transcript:shrink']);
    });

    it('stays inside its bounds and, when it trims, starts again at a user message', () => {
      const r = new SessionRecords();
      for (let t = 0; t < 3000; t++) {
        r.note(S, 'transcript:event', user(t * 10));
        r.note(S, 'transcript:event', { sessionId: S, type: 'tool-use', uuid: `t${t}`, timestamp: t, data: { toolUseId: `k${t}`, toolName: 'Bash' } });
      }
      const t = tail(r);
      expect(t.length).toBeLessThanOrEqual(TAIL_MAX_ENTRIES);
      expect(t[0].type).toBe('user-message');
      expect(r.stats().tailEntries).toBe(t.length);
    });

    it('a single turn too long for the bound keeps its newest entries rather than nothing', () => {
      const r = new SessionRecords();
      r.note(S, 'transcript:event', user(1));
      for (let i = 0; i < TAIL_MAX_ENTRIES + 500; i++) r.note(S, 'transcript:event', { sessionId: S, type: 'tool-use', uuid: `t${i}`, timestamp: i, data: { toolUseId: `k${i}`, toolName: 'Bash' } });
      const t = tail(r);
      expect(t.length).toBe(TAIL_MAX_ENTRIES);
      expect(t.at(-1).uuid).toBe(`t${TAIL_MAX_ENTRIES + 499}`);
    });

    it('a long answer is one entry however many words it has (the ring would have lost its start)', () => {
      const r = new SessionRecords();
      r.note(S, 'transcript:event', user(1));
      for (let i = 0; i < 6000; i++) r.note(S, 'transcript:event', delta(i, 'w '));
      expect(r.events(S).length).toBeLessThanOrEqual(2000); // the ring is bounded
      expect(tail(r)[1].data.text.length).toBe(12000);        // the tail holds the whole answer
    });
  });

  describe('the terminal stream', () => {
    it('numbers each chunk by its position and keeps the stream\'s epoch', () => {
      const r = new SessionRecords();
      r.begin(S);
      const a = r.notePty(S, 'hello ')!;
      const b = r.notePty(S, 'world')!;
      expect(a.offset).toBe(0);
      expect(b.offset).toBe(6);
      expect(a.epoch).toBe(b.epoch);
      expect(a.epoch).toBe(r.epochOf(S));
    });

    it('a first connect gets the whole window with no reset', () => {
      const r = new SessionRecords();
      r.notePty(S, 'one'); r.notePty(S, 'two');
      expect(r.ptyFrom(S)).toEqual({ epoch: r.epochOf(S), offset: 0, data: 'onetwo', reset: false });
    });

    it('a phone that says where it got to gets only the bytes past that point', () => {
      const r = new SessionRecords();
      r.notePty(S, 'x'.repeat(10_000)); r.notePty(S, 'y'.repeat(10_000));
      const got = r.ptyFrom(S, { epoch: r.epochOf(S)!, units: 15_000 })!;
      expect(got.reset).toBe(false);
      expect(got.offset).toBe(15_000);
      expect(got.data.length).toBe(5_000);
      expect(got.data[0]).toBe('y');
    });

    it('a different epoch (a restart) or a position trimmed away resets the phone and sends the whole window', () => {
      const r = new SessionRecords();
      r.notePty(S, 'abc');
      expect(r.ptyFrom(S, { epoch: 'someone-elses', units: 3 })).toMatchObject({ reset: true, offset: 0, data: 'abc' });
      expect(r.ptyFrom(S, { epoch: r.epochOf(S)!, units: 999 })).toMatchObject({ reset: true, data: 'abc' });
    });

    it('holds about 4M units and moves its start forward as it trims, so an old position resets', () => {
      const r = new SessionRecords();
      const chunk = 'z'.repeat(100_000);
      for (let i = 0; i < 60; i++) r.notePty(S, chunk);   // 6M units offered
      const got = r.ptyFrom(S)!;
      expect(got.data.length).toBeLessThanOrEqual(PTY_STREAM_UNITS);
      expect(got.offset).toBeGreaterThan(0);
      expect(r.ptyFrom(S, { epoch: r.epochOf(S)!, units: 10 })!.reset).toBe(true);
      expect(r.stats().ptyUnits).toBe(got.data.length);
    });

    it('merges a stream of one-keystroke chunks instead of keeping millions of entries', () => {
      const r = new SessionRecords();
      for (let i = 0; i < 20_000; i++) r.notePty(S, 'k');
      expect(r.ptyFrom(S)!.data.length).toBe(20_000);
    });

    it('an empty chunk adds nothing but still answers its position', () => {
      const r = new SessionRecords();
      r.notePty(S, 'ab');
      expect(r.notePty(S, '')).toMatchObject({ offset: 2 });
      expect(r.ptyFrom(S)!.data).toBe('ab');
    });

    it('a session that ended has no stream and cannot be revived by a late chunk', () => {
      const r = new SessionRecords();
      r.notePty(S, 'abc');
      r.drop(S);
      expect(r.ptyFrom(S)).toBeNull();
      expect(r.notePty(S, 'late')).toBeNull();
    });
  });

  describe('the asks, as events to replay', () => {
    const ask = (id: string) => ({ type: 'PermissionRequest', sessionId: S, payload: { _requestId: id, tool_name: 'Bash' }, timestamp: 1 });
    it('lists every open ask and nothing closed', () => {
      const r = new SessionRecords();
      r.note(S, 'hook:event', ask('a')); r.note(S, 'hook:event', ask('b'));
      r.note(S, 'hook:event', { type: 'PermissionResolved', sessionId: S, payload: { _requestId: 'a' }, timestamp: 2 });
      expect((r.asksForFill(S) as any[]).map((e) => e.payload._requestId)).toEqual(['b']);
    });

    it('a Claude Code ask whose hook closed comes with the same expiry the screen heard, so the card is kept, not live', () => {
      const r = new SessionRecords();
      r.note(S, 'hook:event', ask('a'));
      r.note(S, 'hook:event', { type: 'PermissionExpired', sessionId: S, payload: { _requestId: 'a', _reason: 'hook-closed' }, timestamp: 2 });
      const out = r.asksForFill(S) as any[];
      expect(out.map((e) => e.type)).toEqual(['PermissionRequest', 'PermissionExpired']);
      expect(out[1].payload._reason).toBe('hook-closed');
    });
  });
});

// WHY: a phone's session dots are drawn from the record's summary, which is only safe if the record folds to the reducer's answer. Each script
// feeds one event at a time to BOTH (record via `note`, reducer via the screens' translators) and compares after EVERY step: working,
// attention, asks waiting (nested helper asks included), hasHistory. Deliberately NOT mirrored (renderer-only inputs): USER_PROMPT, the
// window-sourced 'session-died' and stuck check (the record holds `reportedAttention`), COMPACTION_PENDING, and a kept ask settled by Dismiss.
describe('record vs chat reducer shadow compare', () => {
  const S = 's1';

  type Step =
    | { label: string; t: TranscriptEvent }
    | { label: string; hook: HookEvent }
    | { label: string; local: ChatAction }; // a renderer-only action the record never sees

  const hook = (type: string, id: string, extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}): HookEvent =>
    ({ type, sessionId: S, payload: { _requestId: id, ...extra }, timestamp: 1, ...over } as unknown as HookEvent);

  function awaitingCards(c: SessionChatState): number {
    let n = 0;
    for (const tool of c.toolCalls.values()) {
      if (tool.status === 'awaiting-approval') n++;
      for (const seg of tool.subagentSegments ?? []) if (seg.type === 'tool' && seg.status === 'awaiting-approval') n++;
    }
    return n;
  }

  function runBoth(script: Step[]) {
    let state: ChatState = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S });
    const records = new SessionRecords();
    records.begin(S);
    const rows: string[] = [];
    for (const step of script) {
      if ('t' in step) {
        records.note(S, 'transcript:event', step.t);
        for (const a of eventToAction(step.t, { live: true })) state = chatReducer(state, a);
      } else if ('hook' in step) {
        records.note(S, 'hook:event', step.hook);
        const a = hookEventToAction(step.hook);
        if (a) state = chatReducer(state, a);
      } else {
        state = chatReducer(state, step.local);
      }
      const c = state.get(S)!;
      const f = records.facts(S)!;
      const renderer = { working: c.isThinking, attention: c.attentionState, awaiting: awaitingCards(c), hasHistory: c.timeline.length > 0 };
      const record = { working: f.working, attention: f.attention, awaiting: f.awaitingCount, hasHistory: f.hasHistory };
      rows.push(`${step.label}: renderer=${JSON.stringify(renderer)} record=${JSON.stringify(record)}`);
      expect(record, `after "${step.label}"`).toEqual(renderer);
    }
    return { rows, records, state };
  }

  let n = 0;
  const u = () => `u${++n}`;
  const at = (ts: number) => ({ timestamp: ts, uuid: u(), sessionId: S });

  const nativeScript = (): Step[] => [
    { label: 'user sends', t: ev('user-message', { text: 'fix the bug' }, at(1000)) },
    { label: 'text streams (part 1)', t: ev('assistant-text', { text: 'Let me ', partId: 'text-0', model: 'm1' }, at(1001)) },
    { label: 'text streams (part 2)', t: ev('assistant-text', { text: 'look', partId: 'text-0' }, at(1002)) },
    { label: 'plain heartbeat', t: ev('assistant-thinking', {}, at(1003)) },
    { label: 'stall warning', t: ev('assistant-thinking', { stallWarning: { retryInMs: 5000, willRetry: true } }, at(1004)) },
    { label: 'stalled', t: ev('assistant-thinking', { stalled: true }, at(1005)) },
    // The retry: the abandoned half-answer is dropped, then the answer is written again.
    { label: 'dropPart (retry)', t: ev('assistant-thinking', { dropPart: { partIds: ['text-0'] } }, at(1006)) },
    { label: 'replacement text', t: ev('assistant-text', { text: 'Looking now', partId: 'text-0' }, at(1007)) },
    { label: 'usage progress', t: ev('assistant-thinking', { usageProgress: { inputTokens: 5, outputTokens: 1, contextUsedTokens: 10 } as never }, at(1008)) },
    { label: 'tool starts', t: ev('tool-use', { toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'ls' } }, at(1009)) },
    { label: 'ask raised', hook: hook('PermissionRequest', 'native-r1', { tool_name: 'Bash', tool_input: { command: 'ls' } }) },
    { label: 'ask answered', hook: hook('PermissionResolved', 'native-r1') },
    { label: 'tool result', t: ev('tool-result', { toolUseId: 'tool-1', toolResult: 'ok', isError: false }, at(1010)) },
    { label: 'second ask raised', hook: hook('PermissionRequest', 'native-r2', { tool_name: 'Bash', tool_input: { command: 'rm x' } }) },
    { label: 'second ask times out', hook: hook('PermissionExpired', 'native-r2', { _reason: 'app-timeout' }) },
    { label: 'third ask raised', hook: hook('PermissionRequest', 'native-r3', { tool_name: 'Write', tool_input: { path: 'a' } }) },
    { label: 'third ask cancelled (no reason)', hook: hook('PermissionExpired', 'native-r3') },
    { label: 'a helper tool (stamped) changes nothing', t: ev('tool-use', { toolUseId: 'sub-1', toolName: 'Read', toolInput: {}, parentAgentToolUseId: 'tool-1' }, at(1011)) },
    { label: 'turn completes', t: ev('turn-complete', { stopReason: 'end_turn', model: 'm1' }, at(1012)) },
    // Compaction: the screen that typed /compact sets a flag; the summary event then lands everywhere.
    { label: 'next user message', t: ev('user-message', { text: 'compact please' }, at(1013)) },
    { label: '/compact typed on this screen only', local: { type: 'COMPACTION_PENDING', sessionId: S, cardId: 'c1', beforeContextTokens: 100 } as ChatAction },
    { label: 'compaction summary lands', t: ev('compact-summary', { summary: 's', contextUsedBefore: 100, contextUsedAfter: 10, autoCompaction: true }, at(1014)) },
    { label: 'turn completes after compaction', t: ev('turn-complete', { stopReason: 'end_turn' }, at(1015)) },
    { label: 'a failing turn', t: ev('user-message', { text: 'again' }, at(1016)) },
    { label: 'provider error', t: ev('session-error', { text: 'boom' }, at(1017)) },
    { label: 'user retries (new message clears the error)', t: ev('user-message', { text: 'retry' }, at(1018)) },
    { label: 'user presses stop', t: ev('user-interrupt', {}, at(1019)) },
    { label: 'a clear barrier', t: ev('context-clear', {}, at(1020)) },
  ];

  const claudeCodeScript = (): Step[] => [
    { label: 'user sends', t: ev('user-message', { text: 'hello' }, at(2000)) },
    { label: 'text', t: ev('assistant-text', { text: 'hi there' }, at(2001)) },
    { label: 'a slash command starts no turn', t: ev('user-message', { text: '/model sonnet', slashCommand: true }, at(2002)) },
    { label: 'tool starts', t: ev('tool-use', { toolUseId: 't1', toolName: 'Bash', toolInput: { command: 'ls' } }, at(2003)) },
    { label: 'ask raised (before the tool line? no: after)', hook: hook('PermissionRequest', 'cc-r1', { tool_name: 'Bash', tool_input: { command: 'ls' } }) },
    { label: 'hook closes first: Claude Code\'s own menu may still wait, so the ask stays', hook: hook('PermissionExpired', 'cc-r1', { _reason: 'hook-closed' }) },
    { label: 'turn completes and the kept ask fails with it', t: ev('turn-complete', { stopReason: 'end_turn' }, at(2004)) },
    { label: 'a skill starts a turn', t: ev('skill-invoked', { skillId: 'brainstorm', body: 'x' } as never, at(2005)) },
    { label: 'a replayed copy of the same skill line changes nothing', t: ev('skill-invoked', { skillId: 'brainstorm', body: 'x' } as never, { timestamp: 2005, uuid: 'dup-skill', sessionId: S }) },
    { label: 'interrupt', t: ev('user-interrupt', { kind: 'esc' } as never, at(2006)) },
    { label: 'password ask counts as waiting', hook: hook('PasswordRequest', 'pw1', { toolUseId: 't1', command: 'sudo ls' }) },
    { label: 'password resolved', hook: hook('PasswordResolved', 'pw1') },
  ];

  describe('the session record and the chat reducer agree after every event', () => {
    it('a native session: streaming, stall, retry (dropPart), asks, compaction, errors, stop and clear', () => {
      const { rows } = runBoth(nativeScript());
      expect(rows.length).toBe(nativeScript().length); // every step compared
    });

    it('a Claude Code session: slash command, hook-closed ask, replayed skill line, password ask', () => {
      runBoth(claudeCodeScript());
    });

    it('the compared facts really move (the agreement is not two constants)', () => {
      const { rows } = runBoth(nativeScript());
      const seen = (key: string) => new Set(rows.map((r) => /record=(\{.*\})/.exec(r)![1]).map((j) => JSON.parse(j)[key]));
      expect(seen('working')).toEqual(new Set([true, false]));
      expect(seen('attention')).toEqual(new Set(['ok', 'stuck', 'stalled', 'error']));
      expect(seen('awaiting')).toEqual(new Set([0, 1]));
    });
  });

  describe('what the record keeps beyond the facts', () => {
    it('an ask raised and not yet answered is among the open asks, and leaves when answered', () => {
      const records = new SessionRecords();
      records.begin(S);
      records.note(S, 'hook:event', hook('PermissionRequest', 'r1', { tool_name: 'Bash' }));
      expect(records.openAsks(S)).toHaveLength(1);
      records.note(S, 'hook:event', hook('PermissionResolved', 'r1'));
      expect(records.openAsks(S)).toHaveLength(0);
      expect(records.facts(S)!.awaitingCount).toBe(0);
    });
  });
});

// The plan's gate for the one fill path (one-core R5-2): a phone that drops mid-turn and reconnects is sent what it MISSED, not its whole
// history; and the cases that cannot be continued (a new epoch, an overflowed ring, a ring too small for the gap) fall back to a fresh page.
// Bytes are measured as the JSON the host would put on the socket, and printed.
describe('reconnect and fill ordering', () => {
  const S = 's1';
  const bytes = (v: unknown) => JSON.stringify(v).length;
  const turnText = 'x'.repeat(2000);
  const user = (n: number) => ({ sessionId: S, type: 'user-message', uuid: `m${n}`, timestamp: n, data: { text: `question ${n}` } });
  const tool = (n: number) => ({ sessionId: S, type: 'tool-result', uuid: `t${n}`, timestamp: n, data: { toolUseId: `k${n}`, toolResult: turnText, isError: false } });
  const delta = (n: number) => ({ sessionId: S, type: 'assistant-text', uuid: `d${n}`, timestamp: n, data: { text: 'word ', partId: 'text-0' } });

  /** A page as big as the real thing: 30 turns of 2 KB answers (what a first open really carries). */
  const bigPage = (): TranscriptPageResult => ({
    events: Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? user(i) : { ...tool(i), type: 'assistant-text', data: { text: turnText } })) as any, cursor: null, hasMore: true,
  });

  const deps = (records: SessionRecords): OpenDeps => ({ records, knows: () => true, page: async () => bigPage(), native: () => null });
  const ok = (r: OpenReply) => { if (!r.ok) throw new Error('not ok'); return r; };

  /** A long-running session: 400 turns of history already in the ring. */
  function longSession(opts: ConstructorParameters<typeof SessionRecords>[0] = {}) {
    const records = new SessionRecords(opts);
    records.begin(S);
    for (let i = 0; i < 400; i++) { records.note(S, 'transcript:event', user(i)); records.note(S, 'transcript:event', tool(i)); }
    return records;
  }

  describe('reconnect: bytes sent are proportional to what was missed, not to history', () => {
    it('drop mid-turn, reconnect: only the missed events travel (measured against a first open of the same session)', async () => {
      const records = longSession();
      // the phone's first open
      const first = ok(await openSession(deps(records), { sessionId: S, fresh: true }, { remote: true }));
      const A = bytes(first);
      // the phone is mid-turn: it has everything up to here
      records.note(S, 'transcript:event', user(1000));
      for (let i = 0; i < 20; i++) records.note(S, 'transcript:event', delta(i));
      const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
      // ...the connection drops. During the gap the turn goes on.
      const missedFew = [];
      for (let i = 20; i < 30; i++) { const e = delta(i); records.note(S, 'transcript:event', e); missedFew.push(e); }
      const B10 = bytes(ok(await openSession(deps(records), { sessionId: S, have }, { remote: true })));
      const missedMore = [];
      for (let i = 30; i < 130; i++) { const e = delta(i); records.note(S, 'transcript:event', e); missedMore.push(e); }
      const B110 = bytes(ok(await openSession(deps(records), { sessionId: S, have }, { remote: true })));
      const wire10 = bytes(missedFew), wire110 = bytes([...missedFew, ...missedMore]);
      // eslint-disable-next-line no-console
      console.log(`[reconnect gate] first open ${A} bytes (history); reconnect after 10 missed events ${B10} bytes (the events themselves: ${wire10}); after 110 missed ${B110} bytes (events: ${wire110})`);
      expect(A).toBeGreaterThan(100_000);                       // history is big
      expect(B10).toBeLessThan(A / 100);                        // a tiny fraction of history
      expect(B110).toBeLessThan(A / 10);
      expect(B10).toBeLessThan(wire10 * 3);                     // about the size of what was missed (plus the small envelope)
      expect(B110 / B10).toBeGreaterThan(6);                    // it grows with the gap...
      expect(B110 / B10).toBeLessThan(14);                      // ...and only with the gap
    });

    it('a reconnect with nothing missed sends only the envelope', async () => {
      const records = longSession();
      const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
      const B = bytes(ok(await openSession(deps(records), { sessionId: S, have }, { remote: true })));
      expect(B).toBeLessThan(400);
    });

    it('a changed epoch (the session was recreated, or the computer restarted) falls back to a fresh page', async () => {
      const records = longSession();
      const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
      const restarted = longSession();                          // a new record: a new epoch
      const reply = ok(await openSession(deps(restarted), { sessionId: S, have }));
      expect(reply.resume).toBe('page');
      expect(reply.page!.events.length).toBe(60);
    });

    it('a ring overflow (the gap is older than the ring keeps) falls back to a fresh page', async () => {
      const records = new SessionRecords({ maxEvents: 50 });
      records.begin(S);
      for (let i = 0; i < 10; i++) records.note(S, 'transcript:event', user(i));
      const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
      for (let i = 0; i < 200; i++) records.note(S, 'transcript:event', delta(i));
      const reply = ok(await openSession(deps(records), { sessionId: S, have }));
      expect(reply.resume).toBe('page');
    });

    it('a ring too small for the gap by ONE event still falls back (never a silent hole)', async () => {
      const records = new SessionRecords({ maxEvents: 10 });
      records.begin(S);
      const have = { epoch: records.epochOf(S)!, seq: 0 };
      for (let i = 0; i < 10; i++) records.note(S, 'transcript:event', delta(i));
      expect(ok(await openSession(deps(records), { sessionId: S, have })).resume).toBe('events');   // exactly fits
      records.note(S, 'transcript:event', delta(99));
      expect(ok(await openSession(deps(records), { sessionId: S, have })).resume).toBe('page');      // one too many
    });

    it('an event too large to hold leaves a visible gap, so a screen that missed it takes a page', async () => {
      const records = new SessionRecords();
      records.begin(S);
      const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
      records.note(S, 'transcript:event', delta(1));
      records.note(S, 'transcript:event', { ...tool(2), data: { toolUseId: 'k', toolResult: 'z'.repeat(3 * 1024 * 1024), isError: false } });
      records.note(S, 'transcript:event', delta(3));
      expect(ok(await openSession(deps(records), { sessionId: S, have })).resume).toBe('page');
    });
  });

  describe('the answer and the live stream never overlap or leave a gap', () => {
    /** A phone's socket as publish sees it: what it was sent, in order, with the reply marked. */
    function wire() {
      const sent: Array<{ kind: 'push' | 'reply'; seq?: number; type?: string }> = [];
      const fills = new AudienceFills();
      const records = longSession();
      const publish = createPublish({
        records, fills,
        toWindows: () => {},
        toSockets: (message, _ids, hold) => {
          const deliver = () => sent.push({ kind: 'push', seq: message.seq, type: message.type });
          if (hold?.(7, deliver)) return;
          deliver();
        },
      });
      return { sent, fills, records, publish };
    }

    it('pushes that happen while a fill is in flight are held, then follow the answer in order, each above the answer\'s head', async () => {
      const { sent, fills, records, publish } = wire();
      fills.begin('s7', S);
      let release!: () => void;
      const slow = new Promise<void>((r) => { release = r; });
      const pending = openSession({ ...deps(records), page: async () => { await slow; return bigPage(); } }, { sessionId: S, fresh: true });
      publish(S, 'transcript:event', delta(1)); publish(S, 'transcript:event', delta(2));       // during the page read
      expect(sent).toEqual([]);                                                                    // held
      release();
      const reply = ok(await pending);
      sent.push({ kind: 'reply' });                                                                // the door sends the answer...
      fills.release('s7', S);                                                                      // ...then lets the held pushes through
      publish(S, 'transcript:event', delta(3));                                                    // and live flow resumes
      expect(sent.map((s) => s.kind)).toEqual(['reply', 'push', 'push', 'push']);
      const seqs = sent.filter((s) => s.kind === 'push').map((s) => s.seq!);
      expect(seqs).toEqual([reply.headSeq + 1, reply.headSeq + 2, reply.headSeq + 3]);             // no gap, nothing at or below the head
    });

    it('a screen that is not being filled is delivered to at once (a window that already holds the session pays nothing)', () => {
      const { sent, publish } = wire();
      publish(S, 'transcript:event', delta(1));
      expect(sent).toHaveLength(1);
    });

    it('a screen that never gets its answer is not held forever: its held pushes are DROPPED (never delivered ahead of the answer) and it is told to fill again', async () => {
      const fills = new AudienceFills();
      const delivered: number[] = [];
      const expired: string[] = [];
      fills.setExpireHandler((key, sid) => expired.push(`${key}/${sid}`));
      fills.begin('w1', S, { timeoutMs: 20 });
      fills.hold('w1', S, () => delivered.push(1));
      await new Promise((r) => setTimeout(r, 60));
      expect(delivered).toEqual([]);
      expect(expired).toEqual(['w1/s1']);
      expect(fills.filling('w1', S)).toBe(false);
    });

    it('a queue that grows past its bound expires the hold the same way', () => {
      const fills = new AudienceFills();
      const expired: string[] = [];
      fills.setExpireHandler((key) => expired.push(key));
      fills.begin('s7', S);
      for (let i = 0; i < 5_001; i++) fills.hold('s7', S, () => {});
      expect(expired).toEqual(['s7']);
      expect(fills.pending()).toBe(0);
    });

    it('a tear-off holds from the transfer; the ask resets the queue, so what the answer already contains is not delivered again', async () => {
      const { sent, fills, records, publish } = wire();
      fills.begin('s7', S);                                   // transfer-time hold
      publish(S, 'transcript:event', delta(1));              // published after the transfer, before the ask
      fills.begin('s7', S, { reset: true });                 // the ask
      const reply = ok(await openSession(deps(records), { sessionId: S, fresh: true }));
      sent.push({ kind: 'reply' });
      fills.release('s7', S);
      expect(sent.map((s) => s.kind)).toEqual(['reply']);    // the early push is in the answer, not delivered twice
      expect(reply.before.some((p: any) => p.payload.uuid === 'd1')).toBe(true);
    });

    it('a screen that goes away mid-fill is owed nothing', () => {
      const fills = new AudienceFills();
      const delivered: number[] = [];
      fills.begin('s7', S);
      fills.hold('s7', S, () => delivered.push(1));
      fills.forget('s7');
      fills.release('s7', S);
      expect(delivered).toEqual([]);
      expect(fills.pending()).toBe(0);
    });
  });

  describe('the terminal has no hole between the ask and the answer', () => {
    it('a chunk printed while the page is being read is inside the answer (the phone drops live frames until the answer arrives)', async () => {
      const records = new SessionRecords();
      records.begin(S);
      records.notePty(S, 'AAAA');
      let release!: () => void;
      const slow = new Promise<void>((r) => { release = r; });
      const pending = openSession({ ...deps(records), page: async () => { await slow; return bigPage(); } }, { sessionId: S, fresh: true, pty: {} });
      records.notePty(S, 'BBBB');                      // printed during the page read
      release();
      const reply = ok(await pending);
      expect(reply.pty).toEqual({ epoch: records.epochOf(S), offset: 0, data: 'AAAABBBB', reset: false });
    });

    it('a chunk printed right after the answer is cut continues exactly where the answer ends (no hole, no overlap)', async () => {
      const records = new SessionRecords();
      records.begin(S);
      records.notePty(S, 'AAAA');
      const reply = ok(await openSession(deps(records), { sessionId: S, fresh: true, pty: {} }));
      const next = records.notePty(S, 'CC')!;
      expect(next.offset).toBe(reply.pty!.offset + reply.pty!.data.length);
    });

    it('a reconnect (events) cuts the terminal at the same instant as the events', async () => {
      const records = new SessionRecords();
      records.begin(S);
      records.notePty(S, 'AAAA');
      const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
      records.notePty(S, 'BB');
      const reply = ok(await openSession(deps(records), { sessionId: S, have, pty: { epoch: records.epochOf(S)!, units: 4 } }));
      expect(reply.resume).toBe('events');
      expect(reply.pty).toMatchObject({ offset: 4, data: 'BB', reset: false });
    });
  });
});

// A fill starts the conversation over (SESSION_FILL_RESET) but keeps what only this screen knows: its queued rows and its own sends the
// transcript has not echoed yet (R5-2 review fix).
describe("a fill keeps this screen's own un-echoed send", () => {
  const fresh = (): ChatState => chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });
  const apply = (st: ChatState, e: any): ChatState => { for (const a of eventToAction(e, { live: true })) st = chatReducer(st, a); return st; };

  describe('a fill keeps this screen\'s own un-echoed send', () => {
    it('survives the reset as a pending bubble', () => {
      let st = fresh();
      st = chatReducer(st, { type: 'USER_PROMPT', sessionId: SID, content: 'hello there', timestamp: 1 } as any);
      st = chatReducer(st, { type: 'SESSION_FILL_RESET', sessionId: SID });
      expect(screenOf(st)!.timeline).toEqual(['user(pending): hello there']);
    });

    it('is confirmed (not duplicated) when the fill\'s recent past carries its echo', () => {
      let st = fresh();
      st = chatReducer(st, { type: 'USER_PROMPT', sessionId: SID, content: 'hello there', timestamp: 1 } as any);
      st = chatReducer(st, { type: 'SESSION_FILL_RESET', sessionId: SID });
      st = apply(st, ev('user-message', { text: 'hello there' }, { uuid: 'echo1', sessionId: SID, timestamp: 2 }));
      expect(screenOf(st)!.timeline).toEqual(['user: hello there']);
    });

    it('still starts everything else over', () => {
      let st = fresh();
      st = apply(st, ev('user-message', { text: 'old' }, { uuid: 'o1', sessionId: SID, timestamp: 1 }));
      st = chatReducer(st, { type: 'SESSION_FILL_RESET', sessionId: SID });
      expect(screenOf(st)!.timeline).toEqual([]);
    });
  });
});
