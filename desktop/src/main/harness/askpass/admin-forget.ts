// admin-forget.ts — design §5, §11 task 5: the ONE place a Bash call's exit
// (foreground close/error in tools/bash.ts, or a background/handed-off
// run's own exit in shell-registry.ts) turns into `<verified sudo> -K`,
// so both call sites stay one line each and can never drift on the actual
// rule ("run -K exactly once, when the LAST granted call exits — never with
// a password, and never against anything re-derived from PATH").
'use strict';

import { execFile } from 'child_process';
import { log } from '../../logger';
import type { RunningCalls } from './running-calls';

/** Cheap no-op for the overwhelming majority of calls (nothing was ever
 *  granted a password) — release() itself is what decides whether this
 *  exit was the LAST granted one; `-K` needs no password and clears every
 *  sudo timestamp for this user, so running it more than once per empty
 *  transition would be redundant, never wrong — but release() already
 *  guarantees exactly one such transition per grant lifecycle (design §5,
 *  review 2 E5). `verifiedSudoPath` is the EXACT path verify.ts's own
 *  genuine-sudo check validated on the most recent delivery — never a PATH
 *  lookup (design §5's "path from the verifier's genuine-sudo check, never
 *  PATH"). Non-blocking; a failure is logged, never thrown — forgetting
 *  must never be why a Bash call's own result is delayed or fails. */
export function forgetOnCallExit(runningCalls: RunningCalls, toolCallId: string): void {
  if (!runningCalls.release(toolCallId)) return;
  runForgetK(runningCalls);
}

/** design §5: "Also on app quit." — an unconditional final sweep, called
 *  once from the app's own shutdown (ipc-handlers.ts's `cleanup`), belt-
 *  and-suspenders alongside the per-call exits `nativeHost.destroyAll()`
 *  already triggers (each killed run's own onExit calls `forgetOnCallExit`
 *  above, which ordinarily already empties the granted Set before this
 *  ever runs). A no-op sudo `-K` when nothing was ever verified, or when
 *  the Set is already empty — never a password, never a PATH lookup. */
export function forgetOnQuit(runningCalls: RunningCalls): void {
  runForgetK(runningCalls);
}

function runForgetK(runningCalls: RunningCalls): void {
  const sudoPath = runningCalls.verifiedSudoPath;
  if (!sudoPath) return; // nothing was ever actually verified — nothing to forget
  execFile(sudoPath, ['-K'], (err) => {
    if (err) log('WARN', 'AdminPassword', 'sudo -K failed', { error: String(err) });
  });
}
