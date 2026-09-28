import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessions } from './office-sessions';

// WHY per-instance temp base, not a fixed shared path (fix round 1, review of Task 3): a
// fixed os.tmpdir()/youcoded-office let a dev instance and Destin's live app collide on the
// same folder — two unrelated app instances confining "another session's media" checks to a
// directory that isn't even theirs alone — and on Linux, where /tmp is world-writable, another
// local user could pre-create that fixed name ahead of either instance. mkdtemp's random
// suffix makes the base unguessable and gives each instance sole ownership of its own folder.
let sessions: ReturnType<typeof createSessions> | undefined;
let tempBase: string | undefined;

/** Call once, inside app.whenReady(), before registerOfficeProtocol(). */
export async function initOfficeSessions(): Promise<ReturnType<typeof createSessions>> {
  tempBase = await mkdtemp(path.join(os.tmpdir(), 'youcoded-office-'));
  sessions = createSessions(tempBase);
  return sessions;
}

// WHY a getter, not exporting the instance directly: main.ts's office-protocol registration
// and Task 5's IPC handlers (office:open/save/close) must agree on the same set of open
// sessions — a token the protocol confines media reads to has to be the same token IPC
// created — and one accessor is the one place that could change how it's constructed.
export function getOfficeSessions(): ReturnType<typeof createSessions> {
  if (!sessions) throw new Error('getOfficeSessions() called before initOfficeSessions()');
  return sessions;
}

// WHY best-effort and not awaited by its caller: quit must not wait on a slow or wedged
// filesystem to remove a temp directory. A leftover instance-scoped folder is harmless (a
// random-suffixed name under os.tmpdir(), eventually reclaimed by OS temp cleanup) — losing
// quit speed to guarantee its removal would not be.
export async function cleanupOfficeSessions(): Promise<void> {
  if (!tempBase) return;
  await rm(tempBase, { recursive: true, force: true }).catch(() => {});
}
