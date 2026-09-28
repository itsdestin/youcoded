import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

export interface OfficeSession {
  token: string;
  path: string;
  temp: string;
  senderId: number;
  modified: boolean;
  lastSnapshotAt: number;
}

// WHY one origin per document (design §3a, R2-1/R2-2): a distinct, unguessable
// token and a distinct temp dir per open document keep two documents' storage
// and media apart — office-protocol.ts confines /asc/docmedia/... reads to the
// session's own temp dir, so one document can never name another's folder.
//
// WHY `drain` (fix round 1, Task 5 review): closing a document must not pull its temp folder
// out from under a save still queued for it. The registry passes office-commands'
// drainSession, which waits (capped) for the document's commands before the folder goes.
// Injected rather than imported so this module stays free of the command runner's imports;
// callers that never run commands (the protocol and session tests) leave it out.
export function createSessions(tempBase: string, opts: { drain?: (s: OfficeSession) => Promise<void> } = {}) {
  const sessions = new Map<string, OfficeSession>();
  // WHY (fix round 2): a document being closed may still be finishing its last save. A re-open
  // of the same file in that time — from any window — must wait for it, or the new session
  // would load the file as it was before that save and, on its own next save, write the
  // older content back over the edits the closed tab just saved. Keyed by (real) path.
  const closing = new Map<string, Promise<void>>();
  // Opens still waiting (for a close of the same file, or for their temp folder), by path.
  const pendingOpens = new Map<string, number>();

  async function open(filePath: string, senderId: number): Promise<OfficeSession> {
    pendingOpens.set(filePath, (pendingOpens.get(filePath) ?? 0) + 1);
    try {
      return await openNow(filePath, senderId);
    } finally {
      const n = (pendingOpens.get(filePath) ?? 1) - 1;
      if (n > 0) pendingOpens.set(filePath, n); else pendingOpens.delete(filePath);
    }
  }

  async function openNow(filePath: string, senderId: number): Promise<OfficeSession> {
    // A close that starts while this one waited is waited for too; the same promise twice is not.
    for (let c = closing.get(filePath), seen: Promise<void> | undefined; c && c !== seen; c = closing.get(filePath)) {
      seen = c;
      await c;
    }
    // WHY mkdir first: tempBase (a fresh, per-instance mkdtemp'd
    // os.tmpdir()/youcoded-office-<random> directory in production — see
    // office-session-registry.ts) may not exist yet the first time open() runs, and after
    // cleanupOfficeSessions() removes it late in shutdown; mkdtemp requires its parent to exist.
    await mkdir(tempBase, { recursive: true });
    const temp = await mkdtemp(path.join(tempBase, 'doc-'));
    const session: OfficeSession = {
      token: randomBytes(16).toString('hex'),
      path: filePath,
      temp,
      senderId,
      modified: false,
      lastSnapshotAt: 0,
    };
    sessions.set(session.token, session);
    return session;
  }

  function get(token: string): OfficeSession | undefined {
    return sessions.get(token);
  }

  async function close(token: string): Promise<void> {
    const session = sessions.get(token);
    if (!session) return;
    // Out of get() first, so no new command can join the queue while it drains.
    sessions.delete(token);
    const done = (async () => {
      if (opts.drain) await opts.drain(session).catch(() => {});
      await rm(session.temp, { recursive: true, force: true });
    })();
    // WHY chained on any close already running for this path: two documents of one file
    // (another window's, now gone) can close at once, and a re-open waits for both.
    const prior = closing.get(session.path);
    const all = (prior ? Promise.all([prior, done]).then(() => {}) : done).catch(() => {});
    closing.set(session.path, all);
    void all.then(() => { if (closing.get(session.path) === all) closing.delete(session.path); });
    await done;
  }

  async function closeAllFor(senderId: number): Promise<void> {
    const tokens = [...sessions.values()].filter((s) => s.senderId === senderId).map((s) => s.token);
    await Promise.all(tokens.map((token) => close(token)));
  }

  function byPath(filePath: string): OfficeSession | undefined {
    return [...sessions.values()].find((s) => s.path === filePath);
  }

  /** Whether Office holds `filePath` in any way: open, still draining its close (its last save
   *  may yet land), or about to open. WHY all three (fix round 5): "Save a copy…" must never
   *  write over such a file — the draining save, or the opening editor's first save, would
   *  later overwrite the copy (or the copy would pull the file from under that editor). */
  function inUse(filePath: string): boolean {
    return !!byPath(filePath) || closing.has(filePath) || pendingOpens.has(filePath);
  }

  /** Whether this window has any document open (the close/quit flush asks only those). */
  function hasFor(senderId: number): boolean {
    return [...sessions.values()].some((s) => s.senderId === senderId);
  }

  return { open, get, close, closeAllFor, byPath, inUse, hasFor };
}
