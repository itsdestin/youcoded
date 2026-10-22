// @vitest-environment jsdom
// The native-engine facts the renderer consumes (coordinator message 2026-10-22, native branch
// fee8ebef5): SpecialistRunView.{runNumber,activeToolCallId,resumedAt,reportStale,reportPending}
// and ShellRunView.{command,description,signal,restored,exitUnknown,maybeStillRunning}.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { chatReducer, markOrphanedShellRuns } from '../src/renderer/state/chat-reducer';
import type { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import { nativeCommandFromRun, putCommand } from '../src/renderer/state/background-commands';
import { shellEndKind } from '../src/renderer/state/native-run-facts';
import { toolOutcome } from '../src/renderer/utils/tool-outcome';
import { RunStatusLine } from '../src/renderer/components/specialists/RunStatusLine';
import SpecialistsChip from '../src/renderer/components/SpecialistsChip';
import { ChatProvider, useChatDispatch } from '../src/renderer/state/chat-context';
import type { ShellRunView, SpecialistRunView, ToolCallState } from '../src/shared/types';

afterEach(cleanup);
const S = 's1';
const sh = (over: Record<string, unknown> = {}): ShellRunView => ({ toolUseId: 't1', shellId: 'sh-1', status: 'running', startedAt: 1, tail: '', logPath: '/l', ...over } as ShellRunView);
const run = (over: Record<string, unknown> = {}): SpecialistRunView => ({ childId: 'c1', parentToolCallId: 'orig', agentType: 'worker', title: 'Wren', background: false, status: 'running', startedAt: 1, ...over } as SpecialistRunView);

describe('shell facts', () => {
  it('a signal kill is stopped, never failed or "Exit ?"', () => {
    expect(shellEndKind(sh({ status: 'exited', signal: 'SIGKILL' }))).toBe('stopped');
    expect(nativeCommandFromRun(sh({ status: 'exited', signal: 'SIGKILL' }))).toMatchObject({ status: 'stopped', signal: 'SIGKILL' });
  });
  it('ended while the app was away: stopped with exitUnknown, not failed', () => {
    expect(nativeCommandFromRun(sh({ status: 'exited', exitUnknown: true, restored: true }))).toMatchObject({ status: 'stopped', exitUnknown: true, restored: true });
  });
  it('may still be running: stays running, flagged', () => {
    expect(nativeCommandFromRun(sh({ status: 'exited', exitUnknown: true, maybeStillRunning: true }))).toMatchObject({ status: 'running', maybeStillRunning: true });
  });
  it('a restored record replaces the "stopped when the app quit" stand-in', () => {
    const stand = nativeCommandFromRun(sh({ status: 'stopped', stopReason: 'app-quit' }));
    const real = nativeCommandFromRun(sh({ restored: true, maybeStillRunning: true }));
    expect(putCommand({ [stand.id]: stand }, real)[stand.id].status).toBe('running');
  });
  it('the card outcome follows', () => {
    const c = (r: ShellRunView) => ({ toolUseId: 't1', toolName: 'Bash', input: {}, status: 'complete', shellRun: r }) as ToolCallState;
    expect(toolOutcome(c(sh({ status: 'exited', signal: 'SIGTERM' })))).toBe('stopped');
    expect(toolOutcome(c(sh({ status: 'exited', exitUnknown: true })))).toBe('stopped');
  });
  it('markOrphanedShellRuns leaves a card whose real record is waiting', () => {
    const card = { toolUseId: 't1', toolName: 'Bash', input: {}, status: 'complete', response: 'Started (shell id sh-1).' } as ToolCallState;
    const m = new Map([['t1', card]]);
    expect(markOrphanedShellRuns(m, new Map([['t1', sh()]]))).toBeNull();
    expect(markOrphanedShellRuns(m)).not.toBeNull();
  });
});

describe('specialist facts', () => {
  const task = (id: string): ChatAction => ({ type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: S, uuid: `u${id}`, toolUseId: id, toolName: 'Task', toolInput: {} } as ChatAction);
  const seed = (): ChatState => ['orig', 'resume'].reduce((s, id) => chatReducer(s, task(id)), chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S } as ChatAction));
  const cards = (s: ChatState) => s.get(S)!.toolCalls;
  it('the run is attached to the card that carries the LIVE run as well as the original', () => {
    const s = chatReducer(seed(), { type: 'SPECIALIST_RUN_CHANGED', sessionId: S, run: run({ runNumber: 2, activeToolCallId: 'resume', seq: 5 }) } as ChatAction);
    expect(cards(s).get('resume')!.specialistRun?.childId).toBe('c1');
    expect(cards(s).get('orig')!.specialistRun?.childId).toBe('c1');
  });
  it('an ask from the resumed child nests on the active card', () => {
    let s = chatReducer(seed(), { type: 'SPECIALIST_RUN_CHANGED', sessionId: S, run: run({ runNumber: 2, activeToolCallId: 'resume', seq: 5 }) } as ChatAction);
    s = chatReducer(s, { type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'ls' }, requestId: 'r1', specialist: { childId: 'c1', agentType: 'worker', title: 'Wren', parentToolCallId: 'resume' } } as ChatAction);
    expect(cards(s).get('resume')!.subagentSegments?.some(g => g.type === 'tool' && g.requestId === 'r1')).toBe(true);
    expect(cards(s).get('orig')!.subagentSegments?.length ?? 0).toBe(0);
  });
  it('an old failed report marked stale does not make the card read failed', () => {
    const t = { toolUseId: 'orig', toolName: 'Task', input: {}, status: 'complete', specialistRun: run({ status: 'completed', reportStale: true }), specialistReport: { text: 'x', status: 'failed', timestamp: 1 } } as ToolCallState;
    expect(toolOutcome(t)).toBe('completed');
  });
  it('the chip counts one helper for a resumed child, not two', () => {
    function H() {
      const d = useChatDispatch();
      const [ok, set] = React.useState(false);
      React.useEffect(() => {
        [{ type: 'SESSION_INIT', sessionId: S }, task('orig'), task('resume'), { type: 'SPECIALIST_RUN_CHANGED', sessionId: S, run: run({ runNumber: 2, activeToolCallId: 'resume', seq: 5 }) }].forEach(a => d(a as ChatAction));
        set(true);
      }, []);
      return ok ? <SpecialistsChip sessionId={S} /> : null;
    }
    render(<ChatProvider><H /></ChatProvider>);
    expect(screen.getByTestId('specialists-chip').textContent!.replace(/^[⠀-⣿]+/, '')).toBe('1 specialist');
  });
  it('the status line says when the finished run’s report has not reached the assistant yet', () => {
    render(<RunStatusLine run={run({ status: 'completed', startedAt: 0, endedAt: 1000, reportPending: 'waiting-for-turn' })} />);
    expect(screen.getByTestId('specialist-status-line').textContent).toContain('not read');
    cleanup();
    render(<RunStatusLine run={run({ status: 'completed', startedAt: 0, endedAt: 1000, reportPending: 'held-after-stop' })} />);
    expect(screen.getByTestId('specialist-status-line').textContent).toContain('not read');
  });
});
