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
export function createSessions(tempBase: string) {
  const sessions = new Map<string, OfficeSession>();

  async function open(filePath: string, senderId: number): Promise<OfficeSession> {
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
    sessions.delete(token);
    await rm(session.temp, { recursive: true, force: true });
  }

  async function closeAllFor(senderId: number): Promise<void> {
    const tokens = [...sessions.values()].filter((s) => s.senderId === senderId).map((s) => s.token);
    await Promise.all(tokens.map((token) => close(token)));
  }

  function byPath(filePath: string): OfficeSession | undefined {
    return [...sessions.values()].find((s) => s.path === filePath);
  }

  return { open, get, close, closeAllFor, byPath };
}
