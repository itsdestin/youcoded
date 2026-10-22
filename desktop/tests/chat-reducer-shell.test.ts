// G-1 reducer half: the live run record lands on its Bash card, the
// shell-complete turn folds into the card instead of a bubble, and a resumed
// transcript's "running" card with no live record reads stopped/app-quit.
import { describe, it, expect } from 'vitest';
import { chatReducer, markOrphanedShellRuns } from '../src/renderer/state/chat-reducer';
import type { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import type { ShellRunView } from '../src/shared/types';

const S = 'sess';
function init(): ChatState { return chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S } as ChatAction); }
function d(state: ChatState, a: ChatAction) { return chatReducer(state, a); }
function bashCard(state: ChatState, toolUseId: string, input: Record<string, unknown>, response?: string): ChatState {
  let s = d(state, { type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: `u-${toolUseId}`, toolUseId, toolName: 'Bash', toolInput: input } as ChatAction);
  if (response !== undefined) s = d(s, { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: `r-${toolUseId}`, toolUseId, result: response, isError: false } as ChatAction);
  return s;
}
function run(over: Partial<ShellRunView> = {}): ShellRunView {
  return { toolUseId: 't1', shellId: 'sh-1', status: 'running', startedAt: 1_000, tail: 'a', logPath: '/log', ...over };
}
const card = (s: ChatState, id = 't1') => s.get(S)!.toolCalls.get(id)!;

describe('SHELL_RUN_CHANGED', () => {
  it('lands on the Bash card by toolUseId; an unknown card is parked, not dropped (audit D1)', () => {
    let s = bashCard(init(), 't1', { command: 'x', run_in_background: true });
    s = d(s, { type: 'SHELL_RUN_CHANGED', sessionId: S, run: run() } as ChatAction);
    expect(card(s).shellRun?.shellId).toBe('sh-1');
    const cardsBefore = s.get(S)!.toolCalls;
    s = d(s, { type: 'SHELL_RUN_CHANGED', sessionId: S, run: run({ toolUseId: 'nope', shellId: 'sh-9' }) } as ChatAction);
    // No card changed; the record waits for its card (tests/cc-background-reducer.test.ts covers the pickup).
    expect(s.get(S)!.toolCalls).toBe(cardsBefore);
    expect(s.get(S)!.parkedShellRuns?.get('nope')?.shellId).toBe('sh-9');
  });
});

describe("TRANSCRIPT_USER_MESSAGE injected 'shell-complete'", () => {
  const meta = { kind: 'shell' as const, runs: [{ shellId: 'sh-1', toolUseId: 't1', exitCode: 0, elapsedMs: 5_000, logPath: '/log' }] };
  const msg = (over: Record<string, unknown> = {}): ChatAction => ({
    type: 'TRANSCRIPT_USER_MESSAGE', sessionId: S, uuid: 'n1', text: '[Background command sh-1 finished · exit 0 · 5s]\n$ x\nout\nFull log: /log', timestamp: 10_000,
    injected: 'shell-complete', injectedMeta: meta, ...over,
  } as ChatAction);
  it('folds into the card (no bubble) and fills a missing record from the meta', () => {
    let s = bashCard(init(), 't1', { command: 'x', run_in_background: true }, 'Started in the background (shell id sh-1).');
    const timelineBefore = s.get(S)!.timeline.length;
    s = d(s, msg());
    expect(s.get(S)!.timeline.length).toBe(timelineBefore);
    expect(card(s).shellRun).toEqual({ toolUseId: 't1', shellId: 'sh-1', status: 'exited', exitCode: 0, stopReason: undefined, detached: undefined, startedAt: 5_000, endedAt: 10_000, tail: '', logPath: '/log' });
    expect(s.get(S)!.isThinking).toBe(true);   // the model still reads this turn
  });
  it('never overwrites a live exited record (it has the real tail)', () => {
    let s = bashCard(init(), 't1', { command: 'x', run_in_background: true });
    s = d(s, { type: 'SHELL_RUN_CHANGED', sessionId: S, run: run({ status: 'exited', exitCode: 0, endedAt: 6_000, tail: 'real' }) } as ChatAction);
    s = d(s, msg());
    expect(card(s).shellRun?.tail).toBe('real');
    expect(card(s).shellRun?.startedAt).toBe(1_000);
  });
  it('one turn, several runs → each card folds; a stopped-by-user run reads stopped', () => {
    let s = bashCard(bashCard(init(), 't1', { command: 'x' }), 't2', { command: 'y' });
    s = d(s, msg({ injectedMeta: { kind: 'shell', runs: [meta.runs[0], { shellId: 'sh-2', toolUseId: 't2', stopReason: 'user', elapsedMs: 100, logPath: '/l2' }] } }));
    expect(card(s, 't1').shellRun?.status).toBe('exited');
    expect(card(s, 't2').shellRun).toMatchObject({ status: 'stopped', stopReason: 'user' });
  });
  it('with no matching card the turn falls through to the timeline (older sessions)', () => {
    let s = init();
    s = d(s, msg());
    expect(s.get(S)!.timeline.some((e) => e.kind === 'user' && e.injected === 'shell-complete')).toBe(true);
  });
});

describe('resume rule (TRANSCRIPT_REPLAY_COMPLETE)', () => {
  it('a card whose result announced a shell id, with no live record, renders stopped / app-quit', () => {
    let s = bashCard(init(), 't1', { command: 'x', run_in_background: true }, 'Started in the background (shell id sh-4f2a). You\'ll be told when it finishes.');
    s = bashCard(s, 't2', { command: 'y' }, 'Still running after 2m — handed off to the background (shell id sh-9c10). You\'ll be told when it finishes.');
    s = bashCard(s, 't3', { command: 'z' }, 'plain output\n[cwd: /x · exit 0]');
    s = bashCard(s, 't4', { command: 'w', run_in_background: true }, 'Started in the background (shell id sh-live).');
    s = d(s, { type: 'SHELL_RUN_CHANGED', sessionId: S, run: run({ toolUseId: 't4', shellId: 'sh-live' }) } as ChatAction);
    s = d(s, { type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId: S, sessionIdle: false } as ChatAction);
    expect(card(s, 't1').shellRun).toEqual({ toolUseId: 't1', shellId: 'sh-4f2a', status: 'stopped', stopReason: 'app-quit', detached: false, startedAt: 0, tail: '', logPath: '' });
    expect(card(s, 't2').shellRun).toMatchObject({ shellId: 'sh-9c10', status: 'stopped', stopReason: 'app-quit', detached: true });
    expect(card(s, 't3').shellRun).toBeUndefined();
    expect(card(s, 't4').shellRun?.status).toBe('running');
  });
  it('markOrphanedShellRuns returns null when nothing changes', () => {
    const s = bashCard(init(), 't3', { command: 'z' }, 'plain');
    expect(markOrphanedShellRuns(s.get(S)!.toolCalls)).toBeNull();
  });
});
