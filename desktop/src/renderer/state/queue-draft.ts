import type { QueueDraftSnapshot } from './queued-edit-actions';
/** Synchronous local draft authority, not React's deferred render snapshot. */
export function createQueueDraft(sessionId: string) {
 let session = sessionId, revision = 0, text = '', files: string[] = [];
 return {
  session(id: string) { if (id !== session) { session = id; revision++; text = ''; files = []; } },
  text(value: string) { if (text !== value) { text = value; revision++; } },
  files(value: string[]) { if (JSON.stringify(files) !== JSON.stringify(value)) { files = [...value]; revision++; } },
  snapshot(): QueueDraftSnapshot { return { sessionId: session, revision, empty: text.trim().length === 0 && files.length === 0 }; },
  fill(before: QueueDraftSnapshot, nextText: string, nextFiles: string[]): boolean {
   if (before.sessionId !== session || before.revision !== revision || text.trim() || files.length) return false;
   text = nextText; files = [...nextFiles]; revision++; return true;
  },
 };
}
