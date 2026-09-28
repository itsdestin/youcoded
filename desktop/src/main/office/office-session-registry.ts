import os from 'node:os';
import path from 'node:path';
import { createSessions } from './office-sessions';

// WHY a module-level singleton: main.ts's office-protocol registration and Task 5's IPC
// handlers (office:open/save/close) must agree on the same set of open sessions — a token
// the protocol confines media reads to has to be the same token IPC created. createSessions()
// does no I/O itself (temp dirs are made per-open, not here), so building it at import time
// is safe; a getter still keeps every caller going through one accessor instead of importing
// the instance directly, so this stays the one place that could change how it's constructed.
const sessions = createSessions(path.join(os.tmpdir(), 'youcoded-office'));

export function getOfficeSessions(): ReturnType<typeof createSessions> {
  return sessions;
}
