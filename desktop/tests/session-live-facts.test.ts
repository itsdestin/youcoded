// The computer's own reading of a Claude Code session's live facts (one-core R5-4a): permission mode from the terminal footer (against REAL
// Claude Code 2.1.281 captures), /model and /compact from what a screen typed, "Conversation cleared" from the SessionStart hook's own
// `source`, and the prompt cards and the "may be stuck" reading the computer's own terminal copy finds (main/session-screens.ts). Real record, real
// publish; only the two deliveries are fakes.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SessionRecords } from '../src/main/session-record';
import { createPublish } from '../src/main/publish';
import { SessionLiveFacts, COMPACT_IDLE_LIMIT_MS } from '../src/main/session-live';
import { detectPermissionMode } from '../src/shared/permission-mode-detect';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { parseTranscriptLine } from '../src/main/transcript-watcher';
import { routeSessionLive } from '../src/renderer/state/transcript-batch';
import { EventEmitter } from 'node:events';
import { subscribeClaudeControlReceipts } from '../src/main/claude-control-receipts';
import type { SessionManager } from '../src/main/session-manager';

const S = 'sess-1';
function host(opts: { claude?: boolean; now?: () => number; setTimer?: any; clearTimer?: any } = {}) {
  const records = new SessionRecords({ now: opts.now });
  records.begin(S);
  const sent: Array<{ type: string; payload: any }> = [];
  const publish = createPublish({
    records,
    toWindows: (_s, channel, args) => { sent.push({ type: channel, payload: args[0] }); },
    toSockets: () => {},
  });
  const live = new SessionLiveFacts({ publish, records, isClaude: () => opts.claude !== false, now: opts.now, setTimer: opts.setTimer, clearTimer: opts.clearTimer });
  const lives = () => sent.filter((m) => m.type === 'session:live').map((m) => m.payload);
  return { records, live, sent, lives };
}

describe('Claude Code summary correlation', () => {
  it('certifies a new live CC summary with its host operation without changing the source event', () => {
    const h = host({ now: () => 100, setTimer: vi.fn(), clearTimer: vi.fn() });
    h.live.compactStarted(S, 'cc-request', 100);
    const event = { type: 'compact-summary', sessionId: S, uuid: 'cc-summary', timestamp: 120,
      data: { summary: 'The real summary', sourceTimestamp: 120 } } as const;
    const annotated = h.live.prepareTranscript(event);
    expect(annotated).toMatchObject({ data: { operationId: 'cc-request' } });
    expect(event.data).not.toHaveProperty('operationId');
    h.records.note(S, 'transcript:event', annotated);
    h.live.noteTranscript(S, annotated);
    expect(h.records.isCompacting(S)).toBe(false);
    const actions = eventToAction(annotated, { live: true });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'COMPACTION_COMPLETE', recorded: true, operationId: 'cc-request' }));
  });

  it.each([undefined, 'not-a-date'])('does not certify a parsed summary with unknown source time (%s)', timestamp => {
    const h = host({ now: () => 100, setTimer: vi.fn(), clearTimer: vi.fn() });
    h.live.compactStarted(S, 'new', 100);
    const [event] = parseTranscriptLine(JSON.stringify({ type: 'user', uuid: 'old', timestamp,
      isCompactSummary: true, message: { role: 'user', content: 'Old summary' } }), S);
    const annotated = h.live.prepareTranscript(event);
    expect(annotated).toBe(event);
    h.records.note(S, 'transcript:event', annotated);
    h.live.noteTranscript(S, annotated);
    expect(h.records.isCompacting(S, 'new')).toBe(true);
    expect(eventToAction(annotated, { live: true, compactionPending: true })).toEqual([]);
  });

  it('does not relabel an older CC summary as the currently pending operation', () => {
    const h = host({ now: () => 100, setTimer: vi.fn(), clearTimer: vi.fn() });
    h.live.compactStarted(S, 'new', 100);
    const event = { type: 'compact-summary', sessionId: S, uuid: 'old-summary', timestamp: 99,
      data: { summary: 'Old resume summary' } } as const;
    expect(h.live.prepareTranscript(event)).toBe(event);
    expect(eventToAction(event, { live: true, compactionPending: true })).toEqual([]);
    h.records.note(S, 'transcript:event', event);
    expect(h.records.isCompacting(S)).toBe(true);
  });

  it('does not clear an identified host operation merely because a transcript file shrinks', () => {
    const h = host({ now: () => 100, setTimer: vi.fn(), clearTimer: vi.fn() });
    h.live.compactStarted(S, 'new', 100);
    h.records.note(S, 'transcript:shrink', { sessionId: S });
    expect(h.records.isCompacting(S, 'new')).toBe(true);
  });

  it('does not publish a second CC start that could replace a running operation', () => {
    const h = host({ now: () => 100, setTimer: vi.fn(), clearTimer: vi.fn() });
    h.live.compactStarted(S, 'first', 100);
    h.live.compactStarted(S, 'second', 110);
    h.live.compactEnded(S, 'failed', 'second');
    expect(h.lives().filter(e => e.kind === 'compact-start').map(e => e.id)).toEqual(['first']);
    expect(h.records.isCompacting(S, 'first')).toBe(true);
  });
});

describe('compaction operation correlation', () => {
  it('preserves host identity and original time through duplicate starts and late-screen fill', () => {
    let now = 100;
    const h = host({ now: () => now, setTimer: vi.fn(), clearTimer: vi.fn() });
    h.live.compactStarted(S, 'one', 42);
    now = 200;
    h.live.compactStarted(S, 'one', 99);
    h.records.note(S, 'session:live', { sessionId: S, kind: 'compact-start', id: 'one', startedAt: 99 });
    expect(h.records.liveFill(S).map(e => e.payload as any).find(e => e.kind === 'compact-start')).toMatchObject({ id: 'one', startedAt: 42 });
  });
  it('ignores stale failure, summary and legacy uncorrelated summary after a newer start', () => {
    const h = host({ setTimer: vi.fn(), clearTimer: vi.fn() });
    h.live.compactStarted(S, 'old');
    h.live.compactEnded(S, 'cancelled', 'old');
    h.live.compactStarted(S, 'new');
    h.live.compactEnded(S, 'failed', 'old');
    h.records.note(S, 'session:live', { kind: 'compact-end', id: 'old', outcome: 'cancelled' });
    for (const operationId of ['old', undefined]) h.records.note(S, 'transcript:event', { sessionId: S, type: 'compact-summary', uuid: `summary-${operationId}`, timestamp: 1, data: { operationId } });
    expect(h.records.isCompacting(S)).toBe(true);
    expect(h.records.liveFill(S).map(e => e.payload as any).find(e => e.kind === 'compact-start').id).toBe('new');
    h.records.note(S, 'transcript:event', { sessionId: S, type: 'compact-summary', uuid: 'summary-new', timestamp: 2, data: { operationId: 'new' } });
    expect(h.records.isCompacting(S)).toBe(false);
  });
  it('does not let an already queued watchdog callback expire a newer operation', () => {
    const callbacks: Array<() => void> = [];
    let now = 0;
    const h = host({ now: () => now, setTimer: (fn: () => void) => { callbacks.push(fn); return callbacks.length; }, clearTimer: vi.fn() });
    h.live.compactStarted(S, 'old');
    h.live.compactEnded(S, 'cancelled', 'old');
    h.live.compactStarted(S, 'new');
    h.sent.length = 0; // The prior operation's real cancellation already arrived.
    now = COMPACT_IDLE_LIMIT_MS * 2;
    callbacks[0]();
    expect(h.records.isCompacting(S)).toBe(true);
    expect(h.lives().filter(e => e.kind === 'compact-end')).toEqual([]);
  });
  it('correlates direct-command refusals to their own request object', () => {
    const h = host({ setTimer: vi.fn(), clearTimer: vi.fn() });
    const old = { kind: 'command', command: 'compact' } as const;
    const newer = { kind: 'command', command: 'compact' } as const;
    h.live.directCommandStarted(S, old);
    h.live.compactEnded(S, 'cancelled');
    h.live.directCommandStarted(S, newer);
    h.live.directCommandFinished(S, old, { status: 'rejected', message: 'busy' });
    expect(h.records.isCompacting(S)).toBe(true);
  });
});

const DIR = path.join(__dirname, 'fixtures', 'plan-menu');

// The API abort may leave only partial assistant text on disk, with no interrupt marker.
describe('confirmed addressed direct Stop', () => {
  function running(initial = true) {
    const h = host();
    let state = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S });
    const transcript = (type: string, uuid: string, data: any = {}) => {
      const event = { sessionId: S, type, uuid, timestamp: 100, data } as any;
      h.records.note(S, 'transcript:event', event);
      for (const action of eventToAction(event, { live: true })) state = chatReducer(state, action);
      h.live.noteTranscript(S, event);
    };
    const drain = () => {
      for (const body of h.lives()) routeSessionLive(body, { batcher: { push: a => { state = chatReducer(state, a); } }, contextTokens: () => null });
    };
    if (initial) {
      transcript('user-message', 'user-one', { text: 'hello' });
      transcript('assistant-text', 'partial', { text: 'Partial answer' });
    }
    return { ...h, transcript, drain, dispatch: (a: any) => { state = chatReducer(state, a); }, chat: () => state.get(S)! };
  }
  it.each(['before', 'after'])('correlates an immediate Stop when the exact user row arrives %s its receipt', order => {
    const h = running(false);
    h.live.directStopTargeted(S, 'stop-one', 'user-one');
    if (order === 'before') h.transcript('user-message', 'user-one', { text: 'hello' });
    h.live.directCommandFinished(S, { kind: 'stop' }, { status: 'accepted', requestId: 'stop-one' });
    if (order === 'after') h.transcript('user-message', 'user-one', { text: 'hello' });
    h.drain();
    expect(h.records.facts(S)!.working).toBe(false);
    expect(h.chat().isThinking).toBe(false);
    expect(h.lives().filter(e => e.kind === 'stop-confirmed')).toHaveLength(1);
    h.transcript('assistant-text', 'late-partial', { text: 'Partial answer from disk' });
    expect(h.records.facts(S)!.working).toBe(false);
    expect(h.chat().isThinking).toBe(false);
    expect(JSON.stringify([...h.chat().assistantTurns.values()])).toContain('Partial answer from disk');
  });
  it('never substitutes a stale host UUID or the next observed user for the plugin target', () => {
    const h = running();
    h.live.directStopTargeted(S, 'stop-one', 'user-two');
    h.live.directCommandFinished(S, { kind: 'stop' }, { status: 'accepted', requestId: 'stop-one' });
    expect(h.records.facts(S)!.working).toBe(true);
    expect(h.lives()).toEqual([]);
    h.transcript('user-message', 'unrelated', { text: 'not the target' });
    expect(h.records.facts(S)!.working).toBe(true);
    h.transcript('user-message', 'user-two', { text: 'target' });
    expect(h.records.facts(S)!.working).toBe(false);
  });
  it('does not fall back to the host user when a targeted Stop has no exact plugin UUID', () => {
    const h = running();
    h.live.directStopTargeted(S, 'stop-one');
    h.live.directCommandFinished(S, { kind: 'stop' }, { status: 'accepted', requestId: 'stop-one' });
    expect(h.records.facts(S)!.working).toBe(true);
    expect(h.lives()).toEqual([]);
  });
  it.each(['unknown', 'rejected'])('does not retain a %s receipt to close a delayed user', status => {
    const h = running(false);
    h.live.directStopTargeted(S, 'stop-one', 'user-one');
    h.live.directCommandFinished(S, { kind: 'stop' }, { status: status as 'unknown' | 'rejected', message: 'not confirmed' });
    h.transcript('user-message', 'user-one', { text: 'hello' });
    expect(h.records.facts(S)!.working).toBe(true);
    expect(h.lives()).toEqual([]);
  });
  it('ends only the addressed turn without inventing a transcript line or losing partial text', () => {
    const h = running();
    const manager = Object.assign(new EventEmitter(), { hasSession: (id: string) => id === S });
    const unsubscribe = subscribeClaudeControlReceipts(manager as unknown as Pick<SessionManager, 'on' | 'off' | 'hasSession'>, h.records, h.live);
    manager.emit('claude-control-stop-targeted', S, 'stop-one', 'user-one');
    manager.emit('claude-control-settled', S, { kind: 'stop' }, { status: 'accepted', requestId: 'stop-one' });
    unsubscribe();
    expect(manager.listenerCount('claude-control-stop-targeted')).toBe(0);
    expect(manager.listenerCount('claude-control-settled')).toBe(0);
    expect(h.records.facts(S)!.working).toBe(false);
    h.drain();
    expect(h.chat().isThinking).toBe(false);
    expect([...h.chat().assistantTurns.values()][0]).toMatchObject({ stopReason: 'interrupted' });
    expect(JSON.stringify([...h.chat().assistantTurns.values()])).toContain('Partial answer');
    expect(h.sent.filter(e => e.type === 'transcript:event')).toEqual([]);
    expect(h.records.fillTail(S).at(-1)?.type).toBe('session:live');
  });
  it.each(['unknown', 'rejected', 'idle', 'newer', 'duplicate'])('does not end work on %s completion', mode => {
    const h = running();
    if (mode !== 'idle') h.live.directStopTargeted(S, 'stop-one', 'user-one');
    if (mode === 'duplicate') {
      h.live.directCommandFinished(S, { kind: 'stop' }, { status: 'accepted', requestId: 'stop-one' });
      h.drain();
    }
    if (mode === 'newer' || mode === 'duplicate') h.transcript('user-message', 'user-two', { text: 'next' });
    const result = mode === 'unknown' || mode === 'rejected' ? { status: mode, message: 'not confirmed' } as const : { status: 'accepted', requestId: 'stop-one' } as const;
    h.live.directCommandFinished(S, { kind: 'stop' }, result);
    h.drain();
    expect(h.records.facts(S)!.working).toBe(true);
    expect(h.chat().isThinking).toBe(true);
  });
  it.each(['recorded', 'optimistic'])('ignores a frame-delayed completion after a newer %s message', mode => {
    const h = running();
    h.live.directStopTargeted(S, 'stop-one', 'user-one');
    h.live.directCommandFinished(S, { kind: 'stop' }, { status: 'accepted', requestId: 'stop-one' });
    if (mode === 'recorded') h.transcript('user-message', 'user-two', { text: 'next' });
    else h.dispatch({ type: 'USER_PROMPT', sessionId: S, content: 'next', timestamp: 200 });
    h.drain();
    expect(h.chat().isThinking).toBe(true);
  });
  it('does not let a receipt from a destroyed record stop a recreated session', () => {
    const h = running();
    h.live.directStopTargeted(S, 'stop-one', 'user-one');
    h.records.drop(S); h.records.begin(S);
    h.transcript('user-message', 'user-one', { text: 'hello' });
    h.live.directCommandFinished(S, { kind: 'stop' }, { status: 'accepted', requestId: 'stop-one' });
    expect(h.records.facts(S)!.working).toBe(true);
    expect(h.lives()).toEqual([]);
  });
  it('keeps late partial assistant text without reopening the stopped turn', () => {
    const h = running();
    h.live.directStopTargeted(S, 'stop-one', 'user-one');
    h.live.directCommandFinished(S, { kind: 'stop' }, { status: 'accepted', requestId: 'stop-one' });
    h.drain();
    h.transcript('assistant-text', 'partial-after-stop', { text: 'Last partial words' });
    expect(h.chat().isThinking).toBe(false);
    expect(h.records.facts(S)!.working).toBe(false);
    expect(JSON.stringify([...h.chat().assistantTurns.values()])).toContain('Last partial words');
  });
  it('deduplicates a transcript interrupt before it can affect the next turn', () => {
    const h = running();
    h.transcript('user-interrupt', 'interrupt-one', { kind: 'plain' });
    h.transcript('user-message', 'user-two', { text: 'next' });
    h.transcript('user-interrupt', 'interrupt-one', { kind: 'plain' });
    expect(h.records.facts(S)!.working).toBe(true);
    expect(h.chat().isThinking).toBe(true);
  });
});
const chunksOf = (f: string): string[] => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).chunks.map((c: any) => Buffer.from(c.b64, 'base64').toString('utf8'));

describe('permission mode, read once from real Claude Code 2.1.281 terminal captures', () => {
  it.each([
    ['cc-2.1.281-answer-clear1-120x40.json', ['plan', 'auto-accept']],   // plan mode on, then "accept edits on" after the plan is accepted
    ['cc-2.1.281-old-card-tell-claude-120x40.json', ['plan', 'auto-accept']],
    ['cc-2.1.281-default-120x40.json', ['plan']],
    ['cc-2.1.281-passthrough-ask-120x40.json', []],                      // no footer ever printed: nothing is announced
  ])('%s announces %j, each change once', (file, expected) => {
    const h = host();
    for (const c of chunksOf(file)) h.live.noteOutput(S, c);
    const modes = h.sent.filter((m) => m.type === 'session:permission-mode').map((m) => m.payload.mode);
    expect(modes).toEqual(expected);
    expect(h.records.facts(S)!.permissionMode).toBe(expected.at(-1) ?? null);
  });

  it('a footer redrawn again and again is one event, and a shell or native session is never read', () => {
    const h = host();
    for (let i = 0; i < 20; i++) h.live.noteOutput(S, '\x1b[2m⏵⏵ accept edits on\x1b[22m');
    expect(h.sent).toHaveLength(1);
    const n = host({ claude: false });
    n.live.noteOutput(S, 'plan mode on');
    expect(n.sent).toEqual([]);
  });

  it('a screen that opens later is handed the mode (record.liveFill), not the launch mode', () => {
    const h = host();
    h.live.noteOutput(S, '\x1b[2m⏵⏵ bypass permissions on\x1b[22m (shift+tab to cycle)');
    expect(h.records.liveFill(S)).toContainEqual({ type: 'session:permission-mode', payload: { sessionId: S, mode: 'bypass' } });
    expect(detectPermissionMode('⏵⏵ bypass permissions on')).toBe('bypass');
  });
});

describe('words in a reply are not the footer', () => {
  it.each([
    'I could switch plan mode on if you like.',
    'Press shift+tab to turn accept edits on.',
    'Auto mode on is only for some plans.\nplan mode off',
  ])('%j announces nothing', (text) => {
    const h = host();
    h.live.noteOutput(S, text);
    expect(h.sent).toEqual([]);
    expect(detectPermissionMode(text)).toBeNull();
  });
  it('the footer still counts: glyph before it, or "(shift+tab" after it', () => {
    expect(detectPermissionMode('\x1b[38;2;72;150;140m⏸ plan mode on\x1b[39m')).toBe('plan');
    expect(detectPermissionMode('accept edits on \x1b[22G(shift+tab to cycle)')).toBe('auto-accept');
  });
});

describe('confirmed direct commands', () => {
  it('publishes the observed model rather than assuming the requested alias applied, once per receipt, and draws no divider of its own', () => {
    const h = host();
    const request = { kind: 'command', command: 'model', args: 'sonnet', notice: 'model-switch' } as const;
    const result = { status: 'accepted', requestId: 'r1', model: 'claude-haiku-5-5' } as const;
    h.live.directCommandFinished(S, request, result);
    h.live.directCommandFinished(S, request, result);
    expect(h.records.facts(S)!.model).toBe('haiku');
    expect(h.lives().filter(e => e.kind === 'model')).toHaveLength(1);
    // The divider comes from the /model line Claude Code records (the transcript's model-switch event), never from the host.
    expect(h.lives().filter(e => e.kind === 'model-switch')).toHaveLength(0);
  });
  it('keeps the native cached-model confirmation and restores the observed model when it is declined', () => {
    const timers: Array<() => void> = [];
    const h = host({ setTimer: (fn: () => void) => { timers.push(fn); return fn; }, clearTimer: () => {} });
    h.records.note(S, 'session:live', { sessionId: S, kind: 'model', model: 'opus[1m]' });
    h.live.directCommandStarted(S, { kind: 'command', command: 'model', args: 'haiku' });
    expect(h.lives().filter(e => e.kind === 'model')).toEqual([]);
    h.live.inputBlock(S, { kind: 'popup', heading: 'Switch model?' });
    h.live.inputBlock(S, null);
    expect(timers).toHaveLength(1); timers[0]();
    expect(h.lives().filter(e => e.kind === 'model')).toEqual([{ sessionId: S, kind: 'model', model: 'opus[1m]' }]);
    h.live.forget(S);
  });

  it('does not duplicate a clear already reported by the classic hook', () => {
    const h = host(); h.live.noteSessionStart(S, 'clear', 'new-conversation');
    h.live.directCommandFinished(S, { kind: 'command', command: 'clear' }, { status: 'accepted', requestId: 'clear-r', claudeSessionId: 'new-conversation' });
    expect(h.lives().filter(e => e.kind === 'clear')).toHaveLength(1);
  });
  it('keeps an ambiguous compaction pending but ends a definite refusal', () => {
    const h = host(); const request = { kind: 'command', command: 'compact' } as const;
    h.live.directCommandStarted(S, request);
    expect(h.records.isCompacting(S)).toBe(true);
    h.live.directCommandFinished(S, request, { status: 'unknown', message: 'reply lost' });
    expect(h.records.isCompacting(S)).toBe(true);
    h.live.directCommandFinished(S, request, { status: 'rejected', message: 'refused before invocation' });
    expect(h.records.isCompacting(S)).toBe(false);
    h.live.forget(S);
  });
});

describe('/model, /compact and /clear', () => {
  it('a /model written to the terminal names the model on every screen; the divider is left to the transcript\'s record', () => {
    const h = host();
    h.live.noteInput(S, '/model opus[1m]\r');
    h.live.noteInput(S, '/model sonnet\r');
    expect(h.lives()).toEqual([{ sessionId: S, kind: 'model', model: 'opus[1m]' }, { sessionId: S, kind: 'model', model: 'sonnet' }]);
    expect(h.records.facts(S)!.model).toBe('sonnet');
  });
  it('/compact pasted without Enter starts nothing; submitted, it starts the spinner', () => {
    const h = host();
    h.live.noteInput(S, '/compact');
    h.live.noteInput(S, '/compact focus on x');
    expect(h.sent).toEqual([]);
    h.live.noteInput(S, '/compact\r');
    expect(h.lives().map((l) => l.kind)).toEqual(['compact-start']);
  });
  it('an argument that names no model, plain chat text and a half-written line announce nothing', () => {
    const h = host();
    for (const t of ['/model claude-weird-9\r', 'please /model opus\r', '/mod', 'hello\r', '/modelx opus\r']) h.live.noteInput(S, t);
    expect(h.sent).toEqual([]);
  });
  it.each(['/compact\r', '/compact focus on the tests\r'])('%s starts one spinner everywhere; the certified summary ends it', (command) => {
    const h = host({ now: () => 100 });
    h.live.noteInput(S, command);
    expect(h.lives().filter((l) => l.kind === 'compact-start')).toHaveLength(1);
    expect(h.records.isCompacting(S)).toBe(true);
    expect(h.records.liveFill(S).some((p: any) => p.payload.kind === 'compact-start')).toBe(true); // a phone joining mid-compaction sees it
    const summary = h.live.prepareTranscript({ type: 'compact-summary', sessionId: S, uuid: 'u', timestamp: 101, data: { summary: 'Completed', sourceTimestamp: 101 } });
    h.records.note(S, 'transcript:event', summary);
    h.live.noteTranscript(S, summary);
    expect(h.records.isCompacting(S)).toBe(false);
    expect(h.records.liveFill(S).some((p: any) => p.payload.kind === 'compact-start')).toBe(false);
  });
  it('the SessionStart hook\'s source "clear" is a divider; startup, resume and compact are not', () => {
    const h = host();
    for (const src of ['startup', 'resume', 'compact', undefined]) h.live.noteSessionStart(S, src, 'c1');
    expect(h.sent).toEqual([]);
    h.live.noteSessionStart(S, 'clear', 'c2');
    expect(h.lives()).toEqual([{ sessionId: S, kind: 'clear', id: 'clear-c2', at: expect.any(Number) }]);
  });
  it('a compaction that goes quiet for three minutes is ended; activity keeps it alive', () => {
    let t = 1_000_000;
    const timers: Array<() => void> = [];
    const h = host({ now: () => t, setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
    h.live.compactStarted(S);
    t += 100_000; h.records.note(S, 'transcript:event', { type: 'tool-use', sessionId: S, uuid: 'x', timestamp: 1, data: {} }); // activity at t
    t += COMPACT_IDLE_LIMIT_MS - 1; timers.shift()!();           // not yet idle long enough: re-armed
    expect(h.lives().some((l) => l.kind === 'compact-end')).toBe(false);
    t += 5; timers.shift()!();
    expect(h.lives().at(-1)).toMatchObject({ kind: 'compact-end', outcome: 'failed' });
    expect(h.records.isCompacting(S)).toBe(false);
  });
});

describe('prompt cards the computer finds in a terminal', () => {
  const card = { promptId: 'p1', title: 'Usage Limit Reached', buttons: [{ label: 'Stop and wait', input: '2' }] };
  it('is published once however often it is found, held for a later screen, and gone when dismissed', () => {
    const h = host();
    h.live.showPrompt(S, card);
    h.live.showPrompt(S, card);
    expect(h.lives().filter((l) => l.kind === 'prompt-show')).toHaveLength(1);
    expect(h.records.liveFill(S).filter((p: any) => p.payload.kind === 'prompt-show')).toHaveLength(1);
    h.live.dismissPrompt(S, 'p1');
    h.live.dismissPrompt(S, 'p1');
    expect(h.lives().filter((l) => l.kind === 'prompt-dismiss')).toHaveLength(1);
    expect(h.records.liveFill(S).some((p: any) => p.payload.kind === 'prompt-show')).toBe(false);
  });
  it('a second card with the same title (another id for the same question) is not a second card', () => {
    const h = host();
    h.live.showPrompt(S, card);
    h.live.showPrompt(S, { ...card, promptId: 'other-width-id' });
    expect(h.lives().filter((l) => l.kind === 'prompt-show')).toHaveLength(1);
  });
  it('the only way to put a card in front of the person is the host itself: nothing a screen sends can', () => {
    expect((host().live as any).reportPrompt).toBeUndefined();
  });
});

describe('the "may be stuck" reading', () => {
  it('is published as a numbered event, held for a screen that opens later, and shows on the summary with no window involved', () => {
    const h = host();
    h.live.attention(S, 'stuck');
    expect(h.lives().at(-1)).toEqual({ sessionId: S, kind: 'attention', state: 'stuck' });
    expect(h.records.liveFill(S)).toContainEqual({ type: 'session:live', payload: { sessionId: S, kind: 'attention', state: 'stuck' } });
    expect(h.records.summary(S)!.attention).toBe('stuck');
    h.live.attention(S, 'ok');
    expect(h.records.summary(S)!.attention).toBe('ok');
    expect(h.records.liveFill(S).some((p: any) => p.payload.kind === 'attention')).toBe(false);
  });
});

describe('a typed /clear when the hook is slow or absent', () => {
  const rig = () => {
    let t = 1_000_000;
    const timers: Array<() => void> = [];
    const h = host({ now: () => t, setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: (n: any) => { timers[n - 1] = () => {}; } });
    return { h, timers, advance: (ms: number) => { t += ms; } };
  };
  it('no hook: the host draws the divider itself after the wait', () => {
    const { h, timers } = rig();
    h.live.noteInput(S, '/clear\r');
    expect(h.sent).toEqual([]);
    timers[0]();
    expect(h.lives().map((l) => l.kind)).toEqual(['clear']);
  });
  it('hook first: one divider, and the waiting timer draws nothing more', () => {
    const { h, timers } = rig();
    h.live.noteInput(S, '/clear\r');
    h.live.noteSessionStart(S, 'clear', 'c9');
    timers[0]();
    expect(h.lives()).toEqual([{ sessionId: S, kind: 'clear', id: 'clear-c9', at: expect.any(Number) }]);
  });
  it('hook late (after the host drew it): still one divider', () => {
    const { h, timers, advance } = rig();
    h.live.noteInput(S, '/reset\r');
    timers[0](); advance(5000);
    h.live.noteSessionStart(S, 'clear', 'c9');
    expect(h.lives().filter((l) => l.kind === 'clear')).toHaveLength(1);
  });
  it('a clear typed in the terminal view (no write seen) still comes from the hook alone', () => {
    const { h } = rig();
    h.live.noteSessionStart(S, 'clear', 'c1');
    expect(h.lives().filter((l) => l.kind === 'clear')).toHaveLength(1);
  });
});

describe('a model switch Claude Code refuses', () => {
  // The terminal's own words are NOT read for a refusal any more (2026-10-02, one-core sync-fix1). The old reader scanned the whole screen for
  // "model ... not found/unavailable", and the screen holds the conversation as well: a chat that merely said "the model was not found", or Claude Code's own
  // footer "auto mode unavailable for this model", made every /model lose its divider. Two anchored facts remain: a reply from another model, and a
  // "Switch model?" pop-up that came and went without Claude Code ever recording the command (answered "No, go back").
  const typed = (h: ReturnType<typeof host>) => { h.records.note(S, 'transcript:event', { type: 'assistant-text', sessionId: S, uuid: 'a0', timestamp: 1, data: { text: 'hi', model: 'claude-opus-4-7' } }); h.sent.length = 0; h.live.noteInput(S, '/model haiku\r'); };
  // Taken back = the label is put back on the model the session was on (there is no host divider to retract any more).
  const retracted = (h: ReturnType<typeof host>) => h.lives().filter((l) => l.kind === 'model').at(-1)?.model === 'claude-opus-4-7';
  it.each([
    ['conversation text quoting a refusal', 'the model was not found; an unknown model is invalid\r\n'],
    ["Claude Code's real footer (captured 2.1.287)", '\x1b[H\r\x1b[1B  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions\r\x1b[3B  ⏸ manual mode on · ? for shortcuts            auto mode unavailable for this model'],
    ['an error-looking line', "\x1b[31mModel 'haiku' not found\x1b[39m\r\n"],
  ])('terminal text is never read as a refusal: %s', (_n, text) => {
    const h = host(); typed(h);
    h.live.noteOutput(S, text);
    expect(retracted(h)).toBe(false);
    expect(h.lives().map((l) => l.kind)).toEqual(['model']);
  });
  describe('a "Switch model?" pop-up', () => {
    const popup = { kind: 'popup' as const, heading: 'Switch model?' };
    const rigTimers = () => {
      const timers: Array<() => void> = [];
      const h = host({ setTimer: (fn: () => void) => { timers.push(fn); return timers.length - 1; }, clearTimer: (i: any) => { timers[i] = () => {}; } });
      return { h, fire: () => timers.splice(0).forEach((f) => f()) };
    };
    it('answered No (the pop-up goes, no "Set model to" reply): the label is put back', () => {
      const { h, fire } = rigTimers(); typed(h);
      h.live.inputBlock(S, popup);
      h.live.inputBlock(S, null);
      expect(retracted(h)).toBe(false);   // not yet: Claude Code may still be writing the command's line
      fire();
      const l = h.lives();
      expect(l[l.length - 1]).toEqual({ sessionId: S, kind: 'model', model: 'claude-opus-4-7' });
    });
    it('answered Yes (Claude Code replies "Set model to"): nothing is taken back', () => {
      const { h, fire } = rigTimers(); typed(h);
      h.live.inputBlock(S, popup);
      h.live.noteTranscript(S, { type: 'model-switch', timestamp: 3, data: { model: 'haiku' } });
      h.live.inputBlock(S, null);
      fire();
      expect(retracted(h)).toBe(false);
    });
    it('a second /model typed before the first is confirmed puts back the model the session REALLY ran, not the first one announced', () => {
      const { h, fire } = rigTimers(); typed(h);
      h.live.noteInput(S, '/model sonnet\r');
      h.live.inputBlock(S, popup); h.live.inputBlock(S, null); fire();
      const l = h.lives();
      expect(l[l.length - 1]).toEqual({ sessionId: S, kind: 'model', model: 'claude-opus-4-7' });
    });
    it('a pop-up that is not about the model changes nothing', () => {
      const { h, fire } = rigTimers(); typed(h);
      h.live.inputBlock(S, { kind: 'popup', heading: 'Do you want to proceed?' });
      h.live.inputBlock(S, null);
      fire();
      expect(retracted(h)).toBe(false);
    });
  });
  it('a reply from a different model after the next message retracts it; the turn already running does not', () => {
    const h = host(); typed(h);
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: 5, data: { model: 'claude-opus-4-7' } });   // the old turn, still streaming
    expect(retracted(h)).toBe(false);
    h.live.noteTranscript(S, { type: 'user-message', timestamp: 6, data: { text: 'next' } });
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: 7, data: { model: 'claude-opus-4-7' } });
    expect(retracted(h)).toBe(true);
  });
  it('a reply from the model asked for confirms it: nothing is taken back, and a later error line does not matter', () => {
    const h = host(); typed(h);
    h.live.noteTranscript(S, { type: 'user-message', timestamp: 6, data: { text: 'next' } });
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: 7, data: { model: 'claude-haiku-4-5' } });
    h.live.noteOutput(S, 'model not found');
    expect(retracted(h)).toBe(false);
  });
});

describe('a card that is gone must not stay', () => {
  it('output from Claude Code newer than the card means it moved on: the card is dismissed; older (replayed) output does not', () => {
    const h = host();
    h.live.showPrompt(S, { promptId: 'p', title: 'Usage Limit Reached', buttons: [{ label: 'Stop', input: '2' }] });
    const at = h.records.openPrompts(S)[0].at;
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: at - 5000, data: { text: 'old replay' } });
    expect(h.records.openPrompts(S)).toHaveLength(1);
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: at + 1, data: { text: 'now' } });
    expect(h.records.openPrompts(S)).toHaveLength(0);
    expect(h.lives().at(-1)).toMatchObject({ kind: 'prompt-dismiss', promptId: 'p' });
  });
});
