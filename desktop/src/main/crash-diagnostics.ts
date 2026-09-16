// crash-diagnostics.ts — makes the ways YouCoded can die visible in the log.
//
// WHY this file exists: on 2026-09-03 a tester's Mac build wedged and was force
// quit, and the incident was unrecoverable. macOS filed no crash report because
// the app never started Electron's crash reporter, and nothing in our own log
// recorded that anything was wrong — the app had simply stopped answering.
//
// The log at ~/.claude/desktop.log is NOT a dead end: `dev-tools.ts` reads its
// tail (redacted) into the Report-a-bug flow, so anything logged here reaches us
// when a user reports a problem. That is the whole design of this module — it
// does not build a new surface, it makes four silent failures land in the log
// that already ships:
//
//   1. native crashes            -> a minidump on disk, announced in the log
//   2. renderer death            -> reason + exit code (production; the handler
//                                   in main.ts's wireDevLoadRecovery is dev-only)
//   3. GPU / utility death       -> type, reason, exit code
//   4. the window going HUNG     -> 'unresponsive'/'responsive' with a duration
//
// (4) is the one that would have answered the 2026-09-03 incident: nobody force
// quits a healthy app, and a hang leaves no other trace anywhere.
//
// Crash dumps NEVER leave the machine: uploadToServer is false and no submitURL
// is set, so Crashpad writes to app.getPath('crashDumps') and stops there.

import { app, crashReporter, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { log } from './logger';

/**
 * Start crash capture and wire the process-death listeners.
 *
 * MUST be called before app.whenReady(): Crashpad has to be running before the
 * child processes it monitors are spawned, or their crashes go unrecorded.
 */
export function installCrashDiagnostics(): void {
  try {
    crashReporter.start({
      // No submitURL on purpose — with uploadToServer false, Electron's typings
      // make submitURL optional and Crashpad keeps every dump local.
      uploadToServer: false,
      // Keep the OS handler too: on macOS this preserves the system .ips report
      // alongside our minidump, which is what a platform-savvy reporter reads.
      ignoreSystemCrashHandler: false,
    });
  } catch (err) {
    // Never let diagnostics stop the app from starting.
    log('WARN', 'crash', 'crashReporter failed to start', { error: String(err) });
  }

  // Renderer death in PRODUCTION. wireDevLoadRecovery has its own
  // render-process-gone handler, but it is gated on !app.isPackaged and exists
  // to retry a dev load, not to record anything.
  app.on('render-process-gone', (_event, _webContents, details) => {
    const level = details.reason === 'clean-exit' ? 'INFO' : 'ERROR';
    log(level, 'crash', 'renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  // GPU, utility and helper processes. A GPU crash is invisible to the user
  // beyond "the app went weird", and an 'oom' here is the signature we would
  // otherwise spend a session guessing at.
  app.on('child-process-gone', (_event, details) => {
    const level = details.reason === 'clean-exit' ? 'INFO' : 'ERROR';
    log(level, 'crash', 'child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name ?? details.serviceName ?? null,
    });
  });
}

/**
 * Log whether the previous run left a crash dump behind.
 *
 * Call once after the app is ready. This is what turns a silent crash into a
 * line the user's next bug report carries: the dump itself is a binary we
 * cannot read from a log, but its existence and age tell us the last exit was
 * not clean, which is exactly what was unknowable on 2026-09-03.
 */
export function reportPreviousCrashes(): void {
  let dir: string;
  try {
    dir = app.getPath('crashDumps');
  } catch {
    return;
  }
  let newest: { file: string; mtimeMs: number } | null = null;
  let count = 0;
  try {
    // Crashpad nests completed reports; walk one level rather than assuming a
    // layout, since it differs across platforms (pending/ vs completed/).
    const stack: string[] = [dir];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name.endsWith('.dmp')) {
          count += 1;
          const { mtimeMs } = fs.statSync(full);
          if (!newest || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs };
        }
      }
    }
  } catch {
    // No crashDumps directory yet is the normal, healthy case.
    return;
  }
  if (!newest) return;
  log('WARN', 'crash', 'crash dumps present from a previous run', {
    count,
    newest: newest.file,
    newestAt: new Date(newest.mtimeMs).toISOString(),
  });
}

/**
 * Record that a window stopped responding, and for how long.
 *
 * Electron fires 'unresponsive' when the window stops pumping its message loop
 * — a beachball. Nothing else in the app or the OS records this, which is why
 * the 2026-09-03 force quit could not be explained: the app was still servicing
 * background work right up to the moment the user killed it, so every other
 * signal looked healthy.
 */
export function wireWindowHangDiagnostics(win: BrowserWindow, label: string): void {
  let hungSince: number | null = null;

  win.on('unresponsive', () => {
    hungSince = Date.now();
    log('ERROR', 'crash', 'window stopped responding', { window: label });
  });

  win.on('responsive', () => {
    const ms = hungSince === null ? null : Date.now() - hungSince;
    hungSince = null;
    log('WARN', 'crash', 'window responded again', { window: label, hungForMs: ms });
  });

  // A window closed while still hung never fires 'responsive', so the log would
  // otherwise end mid-hang with no duration — which is exactly the shape of a
  // force quit, and worth stating rather than inferring.
  win.on('closed', () => {
    if (hungSince === null) return;
    log('ERROR', 'crash', 'window closed while still unresponsive', {
      window: label,
      hungForMs: Date.now() - hungSince,
    });
  });
}
