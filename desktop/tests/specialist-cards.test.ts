// Pins how a helper's waiting request is found for the bottom-of-chat cards,
// the floater strip and the red session dot. Before 2026-09-16 those only
// looked at the main assistant's own tools in the active turn, so a helper's
// request — often in a background hire's card several turns up — told the user
// nothing (the "still pending on their screen" phantom approval).
import { describe, it, expect } from 'vitest';
import { helperAsksOf, hasHelperAsk } from '../src/renderer/utils/specialist-cards';
import type { ToolCallState } from '../src/shared/types';

const task = (id: string, segs: ToolCallState['subagentSegments'], title = 'Wren the Whistling Worker'): ToolCallState => ({
  toolUseId: id,
  toolName: 'Task',
  input: {},
  status: 'complete',
  subagentSegments: segs,
  specialistRun: { childId: `child-${id}`, parentToolCallId: id, agentType: 'worker', title } as any,
});

const seg = (toolUseId: string, status: 'running' | 'awaiting-approval', requestId?: string) => ({
  type: 'tool' as const, id: `sa-tool-${toolUseId}`, toolUseId, toolName: 'Bash',
  input: { command: 'rm -rf dist' }, status, requestId, denyListed: true,
});

describe('helperAsksOf', () => {
  it('lifts a waiting helper request from a finished Task card, named after the helper', () => {
    const calls = new Map([['t1', task('t1', [seg('c1', 'running'), seg('c2', 'awaiting-approval', 'req-1')])]]);
    const asks = helperAsksOf(calls);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      toolUseId: 'c2', toolName: 'Bash', status: 'awaiting-approval', requestId: 'req-1', denyListed: true,
      specialist: { childId: 'child-t1', agentType: 'worker', title: 'Wren the Whistling Worker' },
    });
    expect(hasHelperAsk(calls)).toBe(true);
  });

  it('ignores answered rows, rows with no request, and non-Task cards', () => {
    const plain: ToolCallState = { toolUseId: 'b1', toolName: 'Bash', input: {}, status: 'awaiting-approval', requestId: 'main-1' };
    const calls = new Map<string, ToolCallState>([
      ['t1', task('t1', [seg('c1', 'running', undefined), seg('c3', 'awaiting-approval', undefined)])],
      ['b1', plain],
    ]);
    expect(helperAsksOf(calls)).toEqual([]);
    expect(hasHelperAsk(calls)).toBe(false);
  });

  it('collects requests across several helpers', () => {
    const calls = new Map([
      ['t1', task('t1', [seg('c1', 'awaiting-approval', 'r1')])],
      ['t2', task('t2', [seg('c2', 'awaiting-approval', 'r2')], 'Nadia the Rambling Researcher')],
    ]);
    expect(helperAsksOf(calls).map((a) => [a.requestId, a.specialist?.title])).toEqual([
      ['r1', 'Wren the Whistling Worker'],
      ['r2', 'Nadia the Rambling Researcher'],
    ]);
  });
});
