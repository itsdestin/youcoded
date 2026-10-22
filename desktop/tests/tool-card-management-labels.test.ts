// Cards that MANAGE a helper or a background task say what they do — never "Hiring a
// specialist" for a status check or a note, never a bare tool name (Destin, 2026-10-22:
// "checking the status of subagents or sending additional notes often still reports as
// 'hiring specialist', which makes it seem like were adding a new subagent when we arent").
// Covers the single card's label (friendlyToolDisplay) and the collapsed group's sentence
// (buildToolGroupHeadline), which must agree.
import { describe, it, expect } from 'vitest';
import { friendlyToolDisplay } from '../src/renderer/components/ToolCard';
import { buildToolGroupHeadline } from '../src/renderer/utils/tool-group-summary';

const card = (toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ toolUseId: `t-${toolName}-${Math.random()}`, toolName, input, status: 'complete', ...extra } as any);

describe('native specialist management cards', () => {
  it('a list call reads as checking on specialists, not a hire', () => {
    expect(friendlyToolDisplay(card('Task', { list: true })).label).toBe('Checked on specialists');
    expect(friendlyToolDisplay(card('Task', { list: true }, { status: 'running' })).label).toBe('Checking on specialists');
  });

  it('a note to a running specialist is named from the call\'s own result', () => {
    const note = card('Task', { task_id: 'c1', prompt: 'also check the tests' }, { response: 'Steer delivered to Wren the Whistling Worker.' });
    // The target has since finished — the card still says what THIS call did.
    const d = friendlyToolDisplay(note, { taskTargetTitle: 'Wren', taskTargetRunning: false });
    expect(d.label).toBe('Sent a note to Wren');
    expect(d.detail).toContain('also check the tests');
  });

  it('a resume reads as resuming, and a stop as stopping', () => {
    const resume = card('Task', { task_id: 'c1', prompt: 'next brief' }, { response: 'REPORT: done' });
    expect(friendlyToolDisplay(resume, { taskTargetTitle: 'Wren' }).label).toBe('Resumed Wren');
    expect(friendlyToolDisplay(card('Task', { task_id: 'c1', interrupt: true }, { status: 'running' }), { taskTargetTitle: 'Wren' }).label).toBe('Stopping Wren');
    expect(friendlyToolDisplay(card('Task', { task_id: 'c1', interrupt: true }), { taskTargetTitle: 'Wren' }).label).toBe('Stopped Wren');
  });

  it('a real hire still reads as a hire', () => {
    expect(friendlyToolDisplay(card('Task', { agent: 'worker', description: 'Fix it' }, { status: 'running' })).label).toBe('Hiring a worker');
  });
});

describe('Claude Code helper and background-task cards', () => {
  it('SendMessage names the helper, and says when it resumed a finished one', () => {
    const sm = card('SendMessage', { to: 'a1', summary: 'Owner says keep it simple', message: 'long text' }, { response: '{"success":true}' });
    expect(friendlyToolDisplay(sm, { targetLabel: 'Rewrite the plan' }).label).toBe('Sent a note to "Rewrite the plan"');
    const resumed = card('SendMessage', { to: 'a1', message: 'continue' }, { response: '{"success":true,"message":"Resuming agent a1","resumedAgentId":"a1"}' });
    expect(friendlyToolDisplay(resumed, { targetLabel: 'Rewrite the plan' }).label).toBe('Resumed "Rewrite the plan"');
    expect(friendlyToolDisplay(card('SendMessage', { to: 'zz' })).label).toBe('Sent a note to a helper');
  });

  it('TaskStop and TaskOutput name what they act on, falling back to TaskStop\'s own result', () => {
    expect(friendlyToolDisplay(card('TaskStop', { task_id: 'b1' }), { targetLabel: 'Start the dev server' }).label).toBe('Stopped "Start the dev server"');
    const fromResult = card('TaskStop', { task_id: 'b1' }, { response: '{"message":"Successfully stopped task: b1 (Fetch the ROM seed)","task_id":"b1"}' });
    expect(friendlyToolDisplay(fromResult).label).toBe('Stopped "Fetch the ROM seed"');
    expect(friendlyToolDisplay(card('TaskStop', { task_id: 'b1' }, { status: 'failed' })).label).toBe('Couldn\'t stop a background task');
    expect(friendlyToolDisplay(card('TaskOutput', { task_id: 'b1', block: true }, { status: 'running' }), { targetLabel: 'Run the tests' }).label).toBe('Checking on "Run the tests"');
  });

  it('a watcher, a check-back and a workflow read in plain words', () => {
    expect(friendlyToolDisplay(card('Monitor', { description: 'SSH probe result' }, { ccBackground: { taskId: 'm', status: 'running' } })).label).toBe('Watching');
    expect(friendlyToolDisplay(card('Monitor', { description: 'x' }, { ccBackground: { taskId: 'm', status: 'stopped' } })).label).toBe('Stopped watching');
    expect(friendlyToolDisplay(card('ScheduleWakeup', { delaySeconds: 180, reason: 'waiting on CI' })).label).toBe('Checking back in 3 min');
    expect(friendlyToolDisplay(card('ScheduleWakeup', { stop: true })).label).toBe('Cancelled its check-back');
    expect(friendlyToolDisplay(card('Workflow', { script: "export const meta = {\n  name: 'deep-research'," })).detail).toBe('· deep-research');
  });

  it('native BashOutput / KillShell name the command', () => {
    expect(friendlyToolDisplay(card('BashOutput', {})).label).toBe('Checked on background commands');
    expect(friendlyToolDisplay(card('KillShell', { shell_id: 'sh-1' }), { targetLabel: 'Start the dev server' }).label).toBe('Stopped "Start the dev server"');
  });
});

describe('the collapsed group sentence agrees', () => {
  it('a hire, a status check and a note are three different things', () => {
    const headline = buildToolGroupHeadline([
      card('Task', { list: true }),
      card('Task', { task_id: 'c1', prompt: 'p' }, { response: 'Steer delivered to Wren.' }),
    ]);
    expect(headline).toBe('Checked on its specialists and sent a note to a specialist');
    expect(headline).not.toContain('brought in');
  });

  it('background checks and stops are not "used a tool"', () => {
    expect(buildToolGroupHeadline([card('TaskOutput', { task_id: 'b' }), card('TaskStop', { task_id: 'b' })]))
      .toBe('Checked on a background task and stopped a background task');
  });
});
