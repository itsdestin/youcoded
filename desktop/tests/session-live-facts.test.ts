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
    h.live.noteOutput(S, 'bypass permissions on');
    expect(h.records.liveFill(S)).toContainEqual({ type: 'session:permission-mode', payload: { sessionId: S, mode: 'bypass' } });
    expect(detectPermissionMode('bypass permissions on')).toBe('bypass');
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
