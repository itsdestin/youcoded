// The computer's own reading of a Claude Code session's live facts (one-core R5-4a): permission mode from the terminal footer (against REAL
// Claude Code 2.1.281 captures), /model and /compact from what a screen typed, "Conversation cleared" from the SessionStart hook's own
// `source`, and prompt cards reported by a window. Real record, real publish; only the two deliveries are fakes.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SessionRecords } from '../src/main/session-record';
import { createPublish } from '../src/main/publish';
import { SessionLiveFacts, COMPACT_IDLE_LIMIT_MS } from '../src/main/session-live';
import { detectPermissionMode } from '../src/shared/permission-mode-detect';

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

const DIR = path.join(__dirname, 'fixtures', 'plan-menu');
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

describe('/model, /compact and /clear', () => {
  it('a typed /model names the model on every screen; only a CHAT-typed one also draws the divider', () => {
    const h = host();
    h.live.noteInput(S, '/model opus[1m]\r');                 // picker or Shift+Space: same bytes, no divider
    expect(h.lives()).toEqual([{ sessionId: S, kind: 'model', model: 'opus[1m]' }]);
    h.live.noteInput(S, '/model sonnet\r', 'model-switch');   // typed in the chat
    const l = h.lives();
    expect(l[1]).toEqual({ sessionId: S, kind: 'model', model: 'sonnet' });
    expect(l[2]).toMatchObject({ kind: 'model-switch', label: 'Model switched to Sonnet' });
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
    for (const t of ['/model claude-weird-9\r', 'please /model opus\r', '/mod', 'hello\r', '/modelx opus\r']) h.live.noteInput(S, t, 'model-switch');
    expect(h.sent).toEqual([]);
  });
  it('/compact (with or without instructions) starts the spinner everywhere; the summary line ends it', () => {
    const h = host();
    h.live.noteInput(S, '/compact\r');
    h.live.noteInput(S, '/compact focus on the tests\r');
    expect(h.lives().filter((l) => l.kind === 'compact-start')).toHaveLength(2);
    expect(h.records.isCompacting(S)).toBe(true);
    expect(h.records.liveFill(S).some((p: any) => p.payload.kind === 'compact-start')).toBe(true); // a phone joining mid-compaction sees it
    h.records.note(S, 'transcript:event', { type: 'compact-summary', sessionId: S, uuid: 'u', timestamp: 1, data: {} });
    expect(h.records.isCompacting(S)).toBe(false);
    expect(h.records.liveFill(S).some((p: any) => p.payload.kind === 'compact-start')).toBe(false);
  });
  it('the SessionStart hook\'s source "clear" is a divider; startup, resume and compact are not', () => {
    const h = host();
    for (const src of ['startup', 'resume', 'compact', undefined]) h.live.noteSessionStart(S, src, 'c1');
    expect(h.sent).toEqual([]);
    h.live.noteSessionStart(S, 'clear', 'c2');
    expect(h.lives()).toEqual([{ sessionId: S, kind: 'clear', id: 'clear-c2' }]);
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

describe('prompt cards a window reports', () => {
  const show = { sessionId: S, action: 'show' as const, promptId: 'p1', title: 'Usage Limit Reached', buttons: [{ label: 'Stop and wait', input: '2' }] };
  it('is published once however many windows report it, held for a later screen, and gone when dismissed', () => {
    const h = host();
    expect(h.live.reportPrompt(show)).toEqual({ ok: true });
    h.live.reportPrompt(show);
    expect(h.lives().filter((l) => l.kind === 'prompt-show')).toHaveLength(1);
    expect(h.records.liveFill(S).filter((p: any) => p.payload.kind === 'prompt-show')).toHaveLength(1);
    h.live.reportPrompt({ sessionId: S, action: 'dismiss', promptId: 'p1' });
    h.live.reportPrompt({ sessionId: S, action: 'dismiss', promptId: 'p1' });
    expect(h.lives().filter((l) => l.kind === 'prompt-dismiss')).toHaveLength(1);
    expect(h.records.liveFill(S).some((p: any) => p.payload.kind === 'prompt-show')).toBe(false);
  });
  it('refuses a malformed report', () => {
    const h = host();
    for (const bad of [null, { sessionId: S }, { sessionId: S, action: 'show', promptId: 'p' }, { sessionId: '', action: 'show', promptId: 'p', title: 't', buttons: [] }]) expect(h.live.reportPrompt(bad as any).ok).toBe(false);
    expect(h.sent).toEqual([]);
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
    expect(h.lives()).toEqual([{ sessionId: S, kind: 'clear', id: 'clear-c9' }]);
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
  // SYNTHETIC: no real capture of a refused /model exists (it would need a paid session); the wording is an assumption, listed in cc-dependencies.md.
  const typed = (h: ReturnType<typeof host>) => { h.records.note(S, 'transcript:event', { type: 'assistant-text', sessionId: S, uuid: 'a0', timestamp: 1, data: { text: 'hi', model: 'claude-opus-4-7' } }); h.sent.length = 0; h.live.noteInput(S, '/model haiku\r', 'model-switch'); };
  it('a refusal printed in the terminal retracts the divider and puts the label back', () => {
    const h = host(); typed(h);
    expect(h.lives().map((l) => l.kind)).toEqual(['model', 'model-switch']);
    h.live.noteOutput(S, "\x1b[31mModel 'haiku' not found\x1b[39m\r\n");
    const l = h.lives();
    expect(l[2]).toMatchObject({ kind: 'model-switch-retract', id: l[1].id });
    expect(l[3]).toEqual({ sessionId: S, kind: 'model', model: 'claude-opus-4-7' });
  });
  it('a reply from a different model after the next message retracts it; the turn already running does not', () => {
    const h = host(); typed(h);
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: 5, data: { model: 'claude-opus-4-7' } });   // the old turn, still streaming
    expect(h.lives().some((l) => l.kind === 'model-switch-retract')).toBe(false);
    h.live.noteTranscript(S, { type: 'user-message', timestamp: 6, data: { text: 'next' } });
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: 7, data: { model: 'claude-opus-4-7' } });
    expect(h.lives().some((l) => l.kind === 'model-switch-retract')).toBe(true);
  });
  it('a reply from the model asked for confirms it: nothing is taken back, and a later error line does not matter', () => {
    const h = host(); typed(h);
    h.live.noteTranscript(S, { type: 'user-message', timestamp: 6, data: { text: 'next' } });
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: 7, data: { model: 'claude-haiku-4-5' } });
    h.live.noteOutput(S, 'model not found');
    expect(h.lives().some((l) => l.kind === 'model-switch-retract')).toBe(false);
  });
  it('an error line long after the write is not an answer to it', () => {
    let t = 1000;
    const h = host({ now: () => t }); typed(h);
    t += 20_000;
    h.live.noteOutput(S, 'the unknown model in your notes');
    expect(h.lives().some((l) => l.kind === 'model-switch-retract')).toBe(false);
  });
});

describe('a card that is gone must not stay', () => {
  const card = (id: string, title = 'Usage Limit Reached') => ({ sessionId: S, action: 'show' as const, promptId: id, title, buttons: [{ label: 'Stop', input: '2' }] });
  it('a window that restarted says what is on screen; cards for menus that left are dismissed, the one still there stays', () => {
    const h = host();
    h.live.reportPrompt(card('gone-menu')); h.live.reportPrompt(card('still-here', 'Trust This Folder?'));
    h.live.reportPrompt({ sessionId: S, action: 'sync', seen: ['still-here'] });
    expect(h.records.openPrompts(S).map((p) => p.promptId)).toEqual(['still-here']);
    expect(h.lives().filter((l) => l.kind === 'prompt-dismiss')).toEqual([{ sessionId: S, kind: 'prompt-dismiss', promptId: 'gone-menu' }]);
  });
  it('a re-issued "~1" card counts as its menu; an empty screen clears everything', () => {
    const h = host();
    h.live.reportPrompt(card('m1~1'));
    h.live.reportPrompt({ sessionId: S, action: 'sync', seen: ['m1'] });
    expect(h.records.openPrompts(S)).toHaveLength(1);
    h.live.reportPrompt({ sessionId: S, action: 'sync', seen: [] });
    expect(h.records.openPrompts(S)).toHaveLength(0);
  });
  it('a phone can never sync (a catching-up terminal copy must not take a card away)', () => {
    const h = host();
    h.live.reportPrompt(card('p'));
    expect(h.live.reportPrompt({ sessionId: S, action: 'sync', seen: [] }, { fromPhone: true }).ok).toBe(false);
    expect(h.records.openPrompts(S)).toHaveLength(1);
  });
  it('output from Claude Code newer than the card means it moved on: the card is dismissed; older (replayed) output does not', () => {
    const h = host();
    h.live.reportPrompt(card('p'));
    const at = h.records.openPrompts(S)[0].at;
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: at - 5000, data: { text: 'old replay' } });
    expect(h.records.openPrompts(S)).toHaveLength(1);
    h.live.noteTranscript(S, { type: 'assistant-text', timestamp: at + 1, data: { text: 'now' } });
    expect(h.records.openPrompts(S)).toHaveLength(0);
    expect(h.lives().at(-1)).toMatchObject({ kind: 'prompt-dismiss', promptId: 'p' });
  });
});

describe('a phone reporting a card (interim until the computer reads terminals itself)', () => {
  const ok = { sessionId: S, action: 'show' as const, promptId: 'p', title: 'Resume Session', buttons: [{ label: 'As is', input: '1' }, { label: 'Summary', input: '', pick: { signature: 'sig', index: 1 } }] };
  it('is published, deduped against the same card from a window (even under another id)', () => {
    const h = host();
    expect(h.live.reportPrompt(ok, { fromPhone: true }).ok).toBe(true);
    h.live.reportPrompt({ ...ok, promptId: 'other-width-id' });
    expect(h.lives().filter((l) => l.kind === 'prompt-show')).toHaveLength(1);
  });
  it.each([
    ['a button that types text', { ...ok, buttons: [{ label: 'x', input: 'rm -rf ~\r' }] }],
    ['a second write', { ...ok, buttons: [{ label: 'x', input: '1', submitInput: '\r' }] }],
    ['an escape sequence', { ...ok, buttons: [{ label: 'x', input: '\x1b[A' }] }],
    ['a button that does nothing', { ...ok, buttons: [{ label: 'x', input: '' }] }],
    ['too many buttons', { ...ok, buttons: Array.from({ length: 12 }, () => ({ label: 'x', input: '1' })) }],
    ['a huge title', { ...ok, title: 'x'.repeat(500) }],
  ])('refuses %s', (_n, bad) => {
    const h = host();
    expect(h.live.reportPrompt(bad as any, { fromPhone: true }).ok).toBe(false);
    expect(h.sent).toEqual([]);
  });
});
