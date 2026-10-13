// Office's start-up, called once from main.ts after the theme protocol (moved out of main.ts in the one-core merge, 2026-10-04,
// so feature bootstrap does not grow the file the budget keeps small).
import os from 'os';
import path from 'path';
import { registerOfficeProtocol, officeEditorSettings, officeThemeFonts } from './office-protocol';
import { registerOfficeIpc } from './office-ipc';
import { registerOfficeComments } from './office-comments';
import { officeAvailable, officeRoot } from './office-root';
import { getOfficeSessions, initOfficeSessionsSafely } from './office-session-registry';
import { officeIpc } from '../ipc/office';

/** The slice of Electron's `app` this needs (a fake stands in for tests). */
interface PathApp { getPath(name: 'userData' | 'documents'): string }

export async function startOffice(app: PathApp): Promise<void> {
  // Office editors (design §3a): each open document gets its own sealed office://<token>
  // origin. initOfficeSessionsSafely() makes this instance's own random-suffixed temp base
  // (office-session-registry.ts, never shared with the live app); the protocol and the IPC
  // below reach the same registry through getOfficeSessions(). WHY guarded, not awaited bare (fix round 2): a failed
  // mkdtemp (full/unwritable/policy-blocked temp dir) must degrade Office to unavailable, not
  // abort the rest of startup and leave the app with no window.
  const userData = app.getPath('userData');
  const sessions = await initOfficeSessionsSafely();
  if (sessions) registerOfficeProtocol({ root: officeRoot(), sessions, fonts: officeThemeFonts(userData, path.join(os.homedir(), '.claude')), editorSettings: officeEditorSettings(userData) });
  // office:* (Task 5). WHY even without sessions: the renderer gets "unavailable", not a missing
  // handler. WHY the getter: the registry goes away at quit, and each request must see that.
  registerOfficeIpc(officeIpc, { getSessions: getOfficeSessions, available: () => officeAvailable(), root: officeRoot(), userData, documents: app.getPath('documents'), pruneVersionsAfterMs: 30_000 });
  registerOfficeComments(officeIpc); // comments on an open document go through its editor (office-comments.ts)
}
