// adapter.ts — turns "run this command in the built-in shell" into a handle shaped like a started program.
//
// WHY (iPhone app, card #89): an iPhone may not start any program, so the Bash tool runs commands in a small shell
// written in JavaScript (just-bash) instead. The Bash tool, the background-run list and the Stop button all expect
// what Node's `spawn` returns, so this hands them the same shape — the same trick tools/in-process-search.ts plays for
// Grep. Each command runs on its OWN worker thread (worker.ts): ending a thread is the one thing that reliably stops
// a command stuck in an endless loop, and the app stays responsive while it runs.
//
// This file imports nothing from just-bash, so the desktop's tests can run it against a stand-in worker.
import { EventEmitter } from 'events';
import * as os from 'os';
import { PassThrough } from 'stream';
import { Worker } from 'worker_threads';
import type { ChildProcess, SpawnOptions } from 'child_process';

/** What the worker is told (worker.ts reads it as `workerData`). */
export interface ShellJob {
  /** The whole command text (the Bash tool's working-directory probe included). */
  script: string;
  cwd: string;
  /** The app's Documents folder: HOME, and what the Files app shows. */
  home: string;
  tmp: string;
  /** host name -> sign-in token. Reaches only git's own password answer in the worker, never the shell's environment. */
  tokens: Record<string, string>;
}

export interface InAppSpawnerConfig {
  /** Where the built worker file is (the iPhone build knows; a test points it at a stand-in). */
  workerPath: string;
  home?: () => string;
  tmp?: () => string;
  /** Saved sign-ins to hand the worker, looked up per command. Failure means "none". */
  getTokens?: () => Promise<Record<string, string>>;
}

type Reply = { stdout: string; stderr: string; exitCode: number };

export function createInAppSpawner(cfg: InAppSpawnerConfig): (command: string, opts: SpawnOptions) => ChildProcess {
  return (command, opts) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: string | null; killed: boolean;
      pid?: number; kill(signal?: string): boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    let worker: Worker | null = null;

    // The first answer wins: a reply, a crash, or a Stop that arrives while the worker is still being set up.
    const finish = (code: number | null, signal: string | null, out = '', err = '') => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code;
      child.signalCode = signal;
      child.stdout.end(out);
      child.stderr.end(err);
      // WHY 'exit' now and 'close' a tick later: that is the order a real program gives, and the Bash tool waits for
      // 'close' (all output delivered) while the background list reacts to 'exit'.
      child.emit('exit', code, signal);
      setImmediate(() => child.emit('close', code, signal));
      void worker?.terminate();
    };
    // Stop / time limit / KillShell. There are no signals here: the thread is simply ended.
    child.kill = (signal) => {
      child.killed = true;
      finish(null, signal ?? 'SIGTERM');
      return true;
    };

    void (async () => {
      let tokens: Record<string, string> = {};
      try { tokens = (await cfg.getTokens?.()) ?? {}; } catch { /* no saved sign-in: git simply asks nobody */ }
      if (child.exitCode !== null || child.signalCode !== null) return; // stopped while we looked
      const home = cfg.home?.() ?? process.env.HOME ?? os.homedir();
      const job: ShellJob = { script: command, cwd: String(opts.cwd ?? home), home, tmp: cfg.tmp?.() ?? os.tmpdir(), tokens };
      try {
        worker = new Worker(cfg.workerPath, { workerData: job });
      } catch (e) {
        finish(1, null, '', `the built-in shell could not start: ${(e as Error)?.message ?? e}\n`);
        return;
      }
      worker.once('message', (m: Reply) => finish(m.exitCode, null, m.stdout, m.stderr));
      worker.once('error', (e) => finish(1, null, '', `the built-in shell failed: ${e?.message ?? e}\n`));
      // No reason is guessed here: the thread ended without answering, and that is all that is known.
      worker.once('exit', () => finish(1, null, '', 'the command stopped without finishing.\n'));
    })();
    return child as unknown as ChildProcess;
  };
}
