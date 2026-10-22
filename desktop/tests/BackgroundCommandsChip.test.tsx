// @vitest-environment jsdom
// The Background chip and popup: every background command or watcher the conversation left
// running, with the same state its card shows, Stop only where the app can really stop it,
// and a long finished list drawn a chunk at a time.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { ChatProvider, useChatDispatch } from '../src/renderer/state/chat-context';
import BackgroundCommandsChip from '../src/renderer/components/BackgroundCommandsChip';
import type { ChatAction } from '../src/renderer/state/chat-types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const S = 's1';

function setup() {
  let dispatch!: (a: ChatAction) => void;
  function Grab() { dispatch = useChatDispatch(); return null; }
  render(<ChatProvider><Grab /><BackgroundCommandsChip sessionId={S} /></ChatProvider>);
  act(() => dispatch({ type: 'SESSION_INIT', sessionId: S } as ChatAction));
  return (...actions: ChatAction[]) => act(() => { for (const a of actions) dispatch(a); });
}

const ccLaunch = (id: string, task: string, input: Record<string, unknown>, toolName = 'Bash'): ChatAction[] => [
  { type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: S, uuid: `u${id}`, toolUseId: id, toolName, toolInput: input } as ChatAction,
  { type: 'TRANSCRIPT_TOOL_RESULT', timestamp: 2, sessionId: S, uuid: `r${id}`, toolUseId: id, result: 'started', isError: false, backgroundTaskId: task } as ChatAction,
];
const ccEnd = (id: string, task: string, status: 'completed' | 'failed' | 'stopped', exitCode?: number): ChatAction =>
  ({ type: 'TRANSCRIPT_BACKGROUND_TASK', timestamp: 3, sessionId: S, uuid: `n${id}`, toolUseId: id, taskIds: [task], status, exitCode } as ChatAction);
const nativeRun = (id: string, shellId: string, status: 'running' | 'exited' | 'stopped', exitCode?: number): ChatAction[] => [
  { type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: S, uuid: `u${id}`, toolUseId: id, toolName: 'Bash', toolInput: { command: 'npm run dev', description: 'Start the dev server', run_in_background: true } } as ChatAction,
  { type: 'SHELL_RUN_CHANGED', sessionId: S, run: { toolUseId: id, shellId, status, exitCode, startedAt: Date.now() - 5000, tail: '', logPath: '/tmp/x' } } as ChatAction,
];

describe('the Background chip', () => {
  it('draws nothing until something runs in the background', () => {
    setup();
    expect(screen.queryByTestId('background-chip')).toBeNull();
  });

  it('counts running, failed and finished — a stop counts as finished, not failed', () => {
    const dispatch = setup();
    dispatch(
      ...ccLaunch('a', 'b1', { command: 'sleep 99', run_in_background: true }),
      ...ccLaunch('b', 'b2', { command: 'npm test', description: 'Run the tests', run_in_background: true }),
      ...ccLaunch('c', 'b3', { command: 'tail -f log', run_in_background: true }),
      ccEnd('b', 'b2', 'failed', 1),
      ccEnd('c', 'b3', 'stopped'),
    );
    const chip = screen.getByTestId('background-chip');
    expect(chip.getAttribute('aria-label')).toBe('Background commands: 1 running, 1 failed, 1 finished — click to see them');
  });

  it('the popup groups running and finished and says how each ended', () => {
    const dispatch = setup();
    dispatch(
      ...ccLaunch('a', 'b1', { command: 'until gh pr checks', description: 'Wait for CI' }, 'Monitor'),
      ...ccLaunch('b', 'b2', { command: 'npm test', description: 'Run the tests', run_in_background: true }),
      ccEnd('b', 'b2', 'failed', 1),
    );
    fireEvent.click(screen.getByTestId('background-chip'));
    const running = screen.getByRole('list', { name: 'Running commands' });
    expect(within(running).getByText('Wait for CI')).toBeTruthy();
    expect(within(running).getByText('Watching')).toBeTruthy();
    const finished = screen.getByRole('list', { name: 'Finished commands' });
    expect(within(finished).getByText('Run the tests')).toBeTruthy();
    expect(within(finished).getByText(/Exit code 1/)).toBeTruthy();
    expect(within(finished).getByText('Failed')).toBeTruthy();
    // Claude Code runs its own commands: no Stop button that would do nothing.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('offers Stop on a native command the app owns, and calls the real stop', async () => {
    const killShell = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('claude', { native: { killShell } });
    (window as any).claude = { native: { killShell } };
    const dispatch = setup();
    dispatch(...nativeRun('n1', 'sh-1', 'running'));
    fireEvent.click(screen.getByTestId('background-chip'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop' })); });
    expect(killShell).toHaveBeenCalledWith(S, 'sh-1');
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeTruthy();
  });

  it('draws only the first chunk of a very long finished list', () => {
    // A real IntersectionObserver-shaped stub that never fires: the list must stay at one chunk.
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
    const dispatch = setup();
    const actions: ChatAction[] = [];
    for (let i = 0; i < 1000; i++) actions.push(...ccLaunch(`t${i}`, `b${i}`, { command: `job ${i}`, run_in_background: true }), ccEnd(`t${i}`, `b${i}`, 'completed', 0));
    dispatch(...actions);
    fireEvent.click(screen.getByTestId('background-chip'));
    const rows = within(screen.getByRole('list', { name: 'Finished commands' })).getAllByRole('listitem');
    expect(rows.length).toBeLessThanOrEqual(50);
    // Newest first: what just ended is what you came to check.
    expect(within(rows[0]).getByText('job 999')).toBeTruthy();
  });
});
