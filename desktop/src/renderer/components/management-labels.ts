import type { ToolCallState } from '../../shared/types';
import { asString } from '../utils/tool-input';

/**
 * Card wording for calls that MANAGE a helper or a background task rather than doing work
 * themselves (Destin, 2026-10-22: "checking the status of subagents or sending additional notes
 * often still reports as 'hiring specialist', which makes it seem like were adding a new subagent
 * when we arent"). Claude Code's SendMessage, TaskOutput, TaskStop, Monitor, ScheduleWakeup and
 * Workflow, and the native BashOutput / KillShell. Each names what it acts on — the helper's or
 * command's own description (hooks/useBackgroundTarget.ts) — never a bare tool name or id.
 * Split out of ToolCard.tsx's friendlyToolDisplay, which calls it, to keep that file in budget.
 */

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function managementDisplay(
  tool: Pick<ToolCallState, 'toolName' | 'input' | 'status' | 'response' | 'ccBackground'>,
  active: boolean,
  targetLabel: string | undefined,
): { label: string; detail: string } {
  const { toolName, input } = tool;
  switch (toolName) {
    case 'SendMessage': {
      const who = targetLabel ? `"${truncate(targetLabel, 50)}"` : 'a helper';
      const note = asString(input.summary) || asString(input.message);
      // A message to a FINISHED helper starts it again: Claude Code says so in the result.
      const resumed = (tool.response ?? '').includes('"resumedAgentId"');
      const label = active ? `Messaging ${who}`
        : resumed ? `Resumed ${who}`
        : `Sent a note to ${who}`;
      return { label, detail: note ? `· ${truncate(note.replace(/\n/g, ' '), 80)}` : '' };
    }

    case 'TaskOutput':
    case 'TaskStop':
    case 'BashOutput':
    case 'KillShell': {
      const id = asString(input.task_id) || asString(input.taskId) || asString(input.shell_id);
      // TaskStop's result names what it stopped: "Successfully stopped task: <id> (<description>)".
      const fromResult = /stopped task: \S+ \(([^)]+)\)/.exec(tool.response ?? '')?.[1];
      const name = targetLabel || fromResult;
      const what = name ? `"${truncate(name, 50)}"` : 'a background task';
      // BashOutput with no shell id lists every background command.
      if (toolName === 'BashOutput' && !id) {
        return { label: active ? 'Checking on background commands' : 'Checked on background commands', detail: '' };
      }
      if (toolName === 'TaskStop' || toolName === 'KillShell') {
        const label = active ? `Stopping ${what}` : tool.status === 'failed' ? `Couldn't stop ${what}` : `Stopped ${what}`;
        return { label, detail: '' };
      }
      return { label: active ? `Checking on ${what}` : `Checked on ${what}`, detail: '' };
    }

    case 'Monitor': {
      // A watcher: it keeps reporting until it ends or is stopped (ccBackground).
      const desc = asString(input.description);
      const label = active ? 'Watching'
        : tool.ccBackground?.status === 'stopped' ? 'Stopped watching'
        : 'Finished watching';
      return { label, detail: desc ? `· "${truncate(desc, 60)}"` : '' };
    }

    case 'ScheduleWakeup': {
      if (input.stop === true) return { label: 'Cancelled its check-back', detail: '' };
      const secs = Number(input.delaySeconds) || 0;
      const when = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs} s`;
      const reason = asString(input.reason);
      return { label: `Checking back in ${when}`, detail: reason ? `· ${truncate(reason, 70)}` : '' };
    }

    case 'Workflow': {
      // The workflow's own name: `name`, or the `name:` in its script's meta block.
      const name = asString(input.name) || /name:\s*['"]([^'"]+)['"]/.exec(asString(input.script))?.[1] || '';
      return { label: active ? 'Running a workflow' : 'Ran a workflow', detail: name ? `· ${name}` : '' };
    }
    default:
      return { label: toolName, detail: '' };
  }
}
