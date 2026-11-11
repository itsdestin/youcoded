// BashOutput (G-1, spec §4.2): what a background command printed since the
// last BashOutput for it — or, with no id, the list of this conversation's
// background commands. Never asks (permissionSubject undefined + always-allowed
// in permission-types.ts); the per-turn cap and the doom-loop exemption live
// in harness-session.ts, since polling is the one call that is SUPPOSED to repeat.
import { z } from 'zod';
import { defineTool } from './registry';
import { stateText, restoredStateText, shellListLines } from '../shell-registry';

/** Lines returned per read; earlier ones stay in the log the moreHint names. */
export const BASH_OUTPUT_MAX_LINES = 200;

function unknownId(id: string, running: string[]): string {
  return `No background command ${id}. Running: ${running.length ? running.join(', ') : 'none'}.`;
}

export const BashOutputTool = defineTool({
  name: 'BashOutput',
  description:
    'Read NEW output from a background command since your last BashOutput for it (first call: everything so far). ' +
    'Without shell_id: list every background command in this conversation with its state. ' +
    'You are told when a command finishes without calling this. Do NOT use to continuously poll — ' +
    'read it a few times per turn at most, only when you genuinely need new output right now.',
  shortDescription: 'Read new output from a background command, or list them.',
  inputSchema: z.object({
    shell_id: z.string().optional().describe('A shell id from Bash (sh-…). Omit to list every background command in this conversation.'),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix (ledger D-2)
  moreHint: 'the earlier lines are in the log file named in the result — Read it',
  permissionSubject: () => undefined,
  async execute(args, ctx) {
    const reg = ctx.shells;
    if (!args.shell_id) {
      // WHY restored ones too (card #220): commands from before an app restart are
      // still this conversation's commands; leaving them out told the model "none".
      const lines = shellListLines(reg);
      if (lines.length === 0) return { text: 'No background commands in this conversation.' };
      return { text: lines.join('\n') };
    }
    const running = [
      ...(reg?.list().filter((r) => r.status === 'running').map((r) => r.shellId) ?? []),
      ...(reg?.restoredViews().filter((r) => r.status === 'running').map((r) => r.shellId) ?? []),
    ];
    const read = reg ? await reg.read(args.shell_id) : undefined;
    const old = !read ? reg?.getRestored(args.shell_id) : undefined;
    if (old) {
      // From before an app restart: its output no longer streams, so give what was
      // saved (last lines) and the log file, and say plainly that this is a record.
      const tail = old.tail?.trim() || '(no output was saved)';
      return {
        text: `${old.shellId} · ${restoredStateText(old)}\nThis command started before the app was restarted, so new output no longer reaches you. Last saved lines:\n${tail}${old.logPath ? `\nFull log: ${old.logPath}` : ''}`,
      };
    }
    if (!read) return { text: unknownId(args.shell_id, running), isError: true };
    const { run, text, truncated } = read;
    const state = stateText(run);
    if (!text.trim()) {
      return {
        text: run.status === 'running'
          ? `No new output from ${run.shellId} since your last look (still ${state}). You'll be told when it finishes — do NOT poll for it.`
          : `No new output from ${run.shellId} since your last look (${state}).`,
      };
    }
    const all = text.replace(/\n$/, '').split('\n');
    const shown = all.slice(-BASH_OUTPUT_MAX_LINES);
    const body = `${run.shellId} · ${state}\n${shown.join('\n')}`;
    // `truncated` means the registry itself capped the read (the log grew by
    // more than READ_MAX_BYTES since the last look), so `all.length` is NOT the
    // true total — report it as unknown ("at least N"), never as a count we did
    // not measure. The hint names the log, which holds everything, either way.
    if (truncated) {
      return { text: body, bounds: { shown: shown.length, total: null, unit: 'lines' as const, moreHint: `more than this arrived since your last look — the full output is in the log: ${run.logPath}` } };
    }
    return all.length > BASH_OUTPUT_MAX_LINES
      ? { text: body, bounds: { shown: shown.length, total: all.length, unit: 'lines' as const, moreHint: `the earlier lines are in the log: ${run.logPath}` } }
      : { text: body };
  },
});
