// KillShell (G-1, spec §4.3): stop a background command and everything it
// launched. Its result IS the notice — the host sends no finished notice for
// a run the model stopped itself (see NativeSessionHost.onShellExit).
import { z } from 'zod';
import { defineTool } from './registry';
import { formatElapsed, stateText, restoredStateText } from '../shell-registry';

export const KillShellTool = defineTool({
  name: 'KillShell',
  description: 'Stop a background command (and every process it started) by shell id. Returns its last lines. Use it for a server you no longer need or a build that is going nowhere.',
  shortDescription: 'Stop a background command by shell id.',
  inputSchema: z.object({
    shell_id: z.string().describe('The shell id from Bash (sh-…).'),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix (ledger D-2)
  moreHint: 'the full output is in the log file named in the result — Read it',
  permissionSubject: () => undefined,
  async execute(args, ctx) {
    const reg = ctx.shells;
    const run = reg?.get(args.shell_id);
    // WHY (card #220): a command from before an app restart is not in `get()` but is a
    // real command — say its true state, and stop it if it is verifiably still alive.
    const old = !run ? reg?.getRestored(args.shell_id) : undefined;
    if (reg && old) {
      if (old.status !== 'running') return { text: `${old.shellId} is not running — ${restoredStateText(old)}.`, isError: true };
      await reg.kill(old.shellId, 'assistant');
      const after = reg.getRestored(old.shellId);
      const head = after && after.status !== 'running'
        ? `Stopped ${old.shellId} (was: ${old.command}).`
        : `Sent the stop signal to ${old.shellId} (was: ${old.command}), but it had not exited after 5 s — it should be gone shortly.`;
      return { text: `${head} It started before the app was restarted, so its output was not being captured.${old.logPath ? ` Full log: ${old.logPath}` : ''}` };
    }
    if (!reg || !run) {
      const running = [
        ...(reg?.list().filter((r) => r.status === 'running').map((r) => r.shellId) ?? []),
        ...(reg?.restoredViews().filter((r) => r.status === 'running').map((r) => r.shellId) ?? []),
      ];
      return { text: `No background command ${args.shell_id}. Running: ${running.length ? running.join(', ') : 'none'}.`, isError: true };
    }
    if (run.status !== 'running') {
      return { text: `${run.shellId} is not running — ${stateText(run)}.`, isError: true };
    }
    await reg.kill(run.shellId, 'assistant');
    const elapsed = formatElapsed((run.endedAt ?? Date.now()) - run.startedAt);
    const tail = reg.tailText(run, 20).trim() || '(no output)';
    // Never open with "Stopped" for a process that is demonstrably still
    // alive — an earlier draft said "Stopped X" and then, one sentence later,
    // that it had not stopped. Two headline verbs, one true in each case.
    const head = run.status === 'running'
      ? `Sent the stop signal to ${run.shellId} (was: ${run.command}), but it had not exited after 5 s — it should be gone shortly.`
      : `Stopped ${run.shellId} after ${elapsed} (was: ${run.command}).`;
    return { text: `${head} Last lines:\n${tail}\nFull log: ${run.logPath}` };
  },
});
