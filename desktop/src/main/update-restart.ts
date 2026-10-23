// update-restart.ts — "Restart to update" (`update:restart-to-update`): ask about open chats, do the one
// password step where the platform needs it, then quit through the ordinary quit path so the unsaved-files
// gate still runs and the install happens at exit (#183 T3, design §4 "Restart to update", rev 4 F1/F6/F7).
//
// WHY a module with injected effects: the real ones (the close-request queue, the window registry, app.quit)
// live in main.ts closures; this order of steps is the thing worth pinning with tests.
import type { UpdateLaunchResult, UpdateRestartResult } from '../shared/update-install-types';
import { UpdateInstallError } from './update-installer';
import type { UpdateService } from './update-service';

export type RestartResult = UpdateRestartResult;

export interface RestartDeps {
  service: () => Pick<UpdateService, 'planRestart' | 'launchInteractive' | 'startMacRootHelper' | 'openDiskImage' | 'confirmInstallReady' | 'releaseLaunch'>;
  /** Every session in every window (the prompt counts them all). */
  allSessionIds: () => string[];
  /** Ask the MAIN window, under the update's OWN request key (not any window's close slot). */
  ask: (sessions: number) => Promise<{ close: boolean; reopen?: boolean }>;
  /** A whole-app shutdown has begun (runShutdown). */
  shuttingDown: () => boolean;
  /** Quit through the normal path; untracks after the gate; `installsAtExit` false = already installed. */
  quitForUpdate: (untrack: string[], installsAtExit: boolean) => void;
}

export function createRestartToUpdate(deps: RestartDeps): () => Promise<RestartResult> {
  let running: Promise<RestartResult> | null = null;

  async function finishInteractive(result: UpdateLaunchResult, untrack: () => string[]): Promise<RestartResult> {
    if (!result.success) throw new UpdateInstallError(result.error, result.output);
    if ('fallback' in result && result.fallback === 'manual') return { restarting: false, fallback: { kind: 'manual', command: result.command, filePath: result.filePath } };
    if ('fallback' in result && result.fallback === 'browser') return { restarting: false, fallback: { kind: 'browser' } };
    // A shutdown began after the installer ran: nothing will quit for us, so free the launch lock (review F11).
    if (deps.shuttingDown()) { deps.service().releaseLaunch(); return { restarting: false }; }
    // The installer already ran (and, on Linux, already armed the relaunch): nothing to install at exit.
    deps.quitForUpdate(untrack(), false);
    return { restarting: true };
  }

  async function run(): Promise<RestartResult> {
    if (deps.shuttingDown()) return { restarting: false };
    const svc = deps.service();
    // Brake, fresh check and re-hash come BEFORE any question: a pulled release must not cost a prompt.
    const plan = await svc.planRestart();
    if (plan.kind === 'none') return { restarting: false };

    const count = deps.allSessionIds().length;
    let reopen = true;
    if (count > 0) {
      const answer = await deps.ask(count);
      if (!answer.close) return { restarting: false };
      reopen = !!answer.reopen;
    }
    // WHY (review F1): a quit that began while the prompt was open settles it as Cancel, but a quit can
    // also begin just after the answer; either way the other quit proceeds as it would have, with no update.
    if (deps.shuttingDown()) return { restarting: false };
    // Fresh read AFTER the answer: a chat dragged away or started meanwhile is judged by where it is now.
    const untrack = () => (reopen ? [] : deps.allSessionIds());

    if (plan.kind === 'interactive' || plan.kind === 'linux-package') {
      // Linux packages ask for the password here (pkexec, the existing path); Windows per-machine runs
      // its own installer with Windows' own prompt.
      return finishInteractive(await svc.launchInteractive(), untrack);
    }
    if (plan.macPassword) {
      const started = await svc.startMacRootHelper();
      if (started !== 'started') {
        await svc.openDiskImage(); // password cancelled or failed: the disk image, as today; the app keeps running
        return { restarting: false };
      }
      if (deps.shuttingDown()) return { restarting: false }; // the root helper waits for the go file that never comes
    }
    // WHY here (code review F6): tell the person now if the install cannot be prepared, instead of quitting and
    // reopening the old version with no word. Throws; the popup shows it.
    await svc.confirmInstallReady();
    if (deps.shuttingDown()) return { restarting: false };
    deps.quitForUpdate(untrack(), true);
    return { restarting: true };
  }

  return () => {
    // One Restart at a time: a second press joins the first instead of asking and quitting twice.
    if (!running) running = run().finally(() => { running = null; });
    return running;
  };
}
