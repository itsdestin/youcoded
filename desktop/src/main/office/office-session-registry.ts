// WHY `promises as fsp`, not named imports from 'node:fs/promises': a named ESM import binds
// a non-configurable live binding that vi.spyOn cannot replace (fix round 2 — the safe-init
// test needs to make mkdtemp reject). fs.promises is a plain object property and spies cleanly.
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../logger';
import { awaitIdle, drainSession, stopOfficeCommands } from './office-commands';
import { settleAllRecovery } from './office-recovery';
import { createSessions } from './office-sessions';
import { cancelAllPruning } from './prune-schedule';
import { killRunningConverters } from './x2t';

// WHY per-instance temp base, not a fixed shared path (fix round 1, review of Task 3): a
// fixed os.tmpdir()/youcoded-office let a dev instance and Destin's live app collide on the
// same folder — two unrelated app instances confining "another session's media" checks to a
// directory that isn't even theirs alone — and on Linux, where /tmp is world-writable, another
// local user could pre-create that fixed name ahead of either instance. mkdtemp's random
// suffix (fresh from os.tmpdir() on every init, not a fixed name — fix round 2) makes the base
// unguessable and gives each instance sole ownership of its own folder.
let sessions: ReturnType<typeof createSessions> | undefined;
let tempBase: string | undefined;

/** Call once, inside app.whenReady(), before registerOfficeProtocol(). Throws on failure —
 *  use initOfficeSessionsSafely() from startup code that must not abort on that. */
export async function initOfficeSessions(): Promise<ReturnType<typeof createSessions>> {
  tempBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'youcoded-office-'));
  // drainSession: closing a document waits for its queued save first (see office-sessions.ts).
  sessions = createSessions(tempBase, { drain: (s) => drainSession(s) });
  return sessions;
}

// WHY a separate function, not main.ts try/catching initOfficeSessions() itself (fix round 2):
// an unguarded mkdtemp() rejection (temp folder full, unwritable, or blocked by policy) at
// main.ts's call site would abort the rest of app.whenReady() and launch with NO window — that
// is a far worse failure than Office simply being unavailable. Wrapping it here also keeps the
// catch logic unit-testable on its own; nothing in this codebase imports the whole of main.ts
// in a test.
export async function initOfficeSessionsSafely(): Promise<ReturnType<typeof createSessions> | null> {
  try {
    return await initOfficeSessions();
  } catch (error) {
    log('ERROR', 'OfficeSessions', 'Office editors unavailable: could not create the session temp base', {
      error: String(error),
    });
    return null;
  }
}

// WHY a getter, not exporting the instance directly: main.ts's office-protocol registration
// and Task 5's IPC handlers (office:open/save/close) must agree on the same set of open
// sessions — a token the protocol confines media reads to has to be the same token IPC
// created — and one accessor is the one place that could change how it's constructed.
//
// WHY it can return null (fix round 2): initOfficeSessions() can fail, or cleanup can already
// have run (see cleanupOfficeSessions below) — either way there is no live registry to hand
// out. A caller (Task 5's IPC) checks for null and answers "Office isn't available" instead of
// this throwing into a handler that assumed a registry always exists.
export function getOfficeSessions(): ReturnType<typeof createSessions> | null {
  return sessions ?? null;
}

// WHY best-effort and not awaited by its caller: quit must not wait on a slow or wedged
// filesystem to remove a temp directory. A leftover instance-scoped folder is harmless (a
// random-suffixed name under os.tmpdir(), eventually reclaimed by OS temp cleanup) — losing
// quit speed to guarantee its removal would not be.
//
// WHY reset state before removing (fix round 2): once this instance's base is going away,
// getOfficeSessions() must stop handing it out immediately — not just after the `rm` finishes
// — so a caller that asks for the registry mid-quit gets null and never calls .open() on a
// registry whose base is being deleted underneath it (office-sessions.ts's open() would
// otherwise silently recreate the removed directory, since it mkdir()s its base before
// mkdtemp-ing). This does not protect a reference a caller captured and held from BEFORE
// cleanup started — only fetch-per-use through getOfficeSessions() is covered.
export async function cleanupOfficeSessions(): Promise<void> {
  if (!tempBase) return;
  const base = tempBase;
  sessions = undefined;
  tempBase = undefined;
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
}

// WHY (Task 3 review carry-over): cleanupOfficeSessions() removes every session's temp folder,
// and with it the Editor.bin that a save in flight is still translating. So quit first waits
// for the editor commands to go idle, capped at `capMs` so a wedged translation cannot hang
// quit. Even when the cap is hit the user's file is safe: a save replaces it only by renaming
// a finished copy (kept beside the file, not in the temp base) over it. The removal itself is
// still started, not awaited, for the reason given on cleanupOfficeSessions above. main.ts
// starts this early in shutdown and awaits it last, so the wait overlaps the other teardown.
// A save still running at the cap is stopped and its file stays as it was; its edits stay in the
// document's recovery journal (Task 8), which the next open of that file offers back.
export async function quitOfficeSessions(capMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([awaitIdle(), new Promise<void>((r) => (timer = setTimeout(r, capMs)))]).catch(() => {});
  clearTimeout(timer);
  // WHY before the removal (fix round 1): from here on every new command is refused, and a
  // save still translating (the cap was hit) abandons its copy instead of replacing the file.
  stopOfficeCommands();
  // Nor may a tidy-up of kept versions start now (Task 7): it would read and delete while the app goes.
  cancelAllPruning();
  // WHY (fix round 2): if the cap was hit, a converter may still be running. Kill it so it
  // neither outlives the app nor keeps writing into folders being removed; its save then fails
  // and throws its private copy away, leaving the user's file as it was.
  killRunningConverters();
  // All-saved recovery journals go; one with edits its file never got stays (Task 8). Capped: a
  // wedged disk must not hold the quit — a journal left behind is only removed at its next open.
  await Promise.race([settleAllRecovery(), new Promise<void>((r) => (timer = setTimeout(r, 1_000)))]).catch(() => {});
  clearTimeout(timer);
  void cleanupOfficeSessions();
}
