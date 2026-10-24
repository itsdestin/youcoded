// One rule for "how did this card's work end", shared by the collapsed group
// header, the headline text and the Subagents chip (2026-10-22 audit A3/B9):
// the launch receipt (`status: 'complete'`) says nothing about whether
// background work failed or was stopped afterwards.
import { describe, it, expect } from 'vitest';
import { toolOutcome } from '../src/renderer/utils/tool-outcome';
import { buildToolGroupHeadline } from '../src/renderer/utils/tool-group-summary';
import type { ToolCallState, SpecialistRunView } from '../src/shared/types';

const card = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  toolUseId: 't', toolName: 'Agent', input: {}, status: 'complete', ...over,
} as ToolCallState);
const run = (status: SpecialistRunView['status']): SpecialistRunView => ({
  childId: 'c', parentToolCallId: 't', agentType: 'worker', title: 'W', background: false, status, startedAt: 1,
});

describe('toolOutcome', () => {
  it('a plain finished call is completed, a failed one failed, a running one running', () => {
    expect(toolOutcome(card())).toBe('completed');
    expect(toolOutcome(card({ status: 'failed' }))).toBe('failed');
    expect(toolOutcome(card({ status: 'running' }))).toBe('running');
  });
  it('a Claude Code background end overrides the launch receipt', () => {
    expect(toolOutcome(card({ ccBackground: { taskId: 'a', status: 'running' } }))).toBe('running');
    expect(toolOutcome(card({ ccBackground: { taskId: 'a', status: 'failed' } }))).toBe('failed');
    expect(toolOutcome(card({ ccBackground: { taskId: 'a', status: 'stopped' } }))).toBe('stopped');
    expect(toolOutcome(card({ ccBackground: { taskId: 'a', status: 'completed' } }))).toBe('completed');
  });
  it('a stopped native helper is stopped even while its Task card still says failed', () => {
    // B9: the interrupted tool result unwinds after the run record already says interrupted.
    expect(toolOutcome(card({ toolName: 'Task', status: 'failed', specialistRun: run('interrupted') }))).toBe('stopped');
    expect(toolOutcome(card({ toolName: 'Task', status: 'running', specialistRun: run('interrupted') }))).toBe('stopped');
  });
  it('a native run record is authoritative, and a failed report fails a completed run', () => {
    expect(toolOutcome(card({ toolName: 'Task', specialistRun: run('running') }))).toBe('running');
    expect(toolOutcome(card({ toolName: 'Task', specialistRun: run('failed') }))).toBe('failed');
    expect(toolOutcome(card({ toolName: 'Task', specialistRun: run('completed'), specialistReport: { text: 'x', status: 'failed', timestamp: 1 } }))).toBe('failed');
  });
  it('a native background shell reads from its run', () => {
    const shell = (status: 'running' | 'exited' | 'stopped', exitCode?: number) => card({
      toolName: 'Bash', shellRun: { toolUseId: 't', shellId: 'sh-1', status, exitCode, startedAt: 1, tail: '', logPath: '' },
    });
    expect(toolOutcome(shell('running'))).toBe('running');
    expect(toolOutcome(shell('exited', 0))).toBe('completed');
    expect(toolOutcome(shell('exited', 2))).toBe('failed');
    expect(toolOutcome(shell('stopped'))).toBe('stopped');
  });
});

describe('group headline counts the same outcomes', () => {
  it('a helper that failed after launch is "failed", not completed', () => {
    const tools = [
      card({ toolUseId: 'a', ccBackground: { taskId: 'a', status: 'running' } }),
      card({ toolUseId: 'b', ccBackground: { taskId: 'b', status: 'failed' } }),
      card({ toolUseId: 'c', ccBackground: { taskId: 'c', status: 'completed' } }),
    ];
    expect(buildToolGroupHeadline(tools)).toContain('1 completed, 1 failed');
  });
});
