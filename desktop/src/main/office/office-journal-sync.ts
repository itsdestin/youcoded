// Before a window with Office documents closes, its editors send their newest edits to the recovery
// journal (finish plan Task 8 fix round 1).
//
// WHY: the editor sends its edits about once a second (add-on streamEdits). A window closed within
// that second would leave the last word or two only in the dying page. So the close asks the window
// (OFFICE_JOURNAL_REQUEST); its editors send what they have at once and the window answers
// (OFFICE_JOURNAL_DONE). The answer travels behind the edits on the same IPC pipe, so by the time it
// arrives main has journaled them. Capped: a hung or slow page never holds a close past 1.5 s.
// This is not a save — the file is written by autosave or recovered at the next open.
import { ipcMain } from 'electron';

export const OFFICE_JOURNAL_REQUEST = 'office:journal-request';
export const OFFICE_JOURNAL_DONE = 'office:journal-done';
const JOURNAL_SYNC_CAP_MS = 1_500;

interface SyncTarget { id: number; send(channel: string, ...args: unknown[]): void; isDestroyed(): boolean }
interface SyncIpc {
  on(channel: string, l: (e: unknown, ...args: unknown[]) => void): unknown;
  off(channel: string, l: (e: unknown, ...args: unknown[]) => void): unknown;
}

let seq = 0;
/** Ask the window's editors to journal their newest edits. Never rejects; resolves on the answer,
 *  after `capMs`, or at once when the window is gone. */
export function syncJournals(target: SyncTarget, ipc: SyncIpc = ipcMain, capMs = JOURNAL_SYNC_CAP_MS): Promise<void> {
  if (target.isDestroyed()) return Promise.resolve();
  const id = `journal-${++seq}`;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (e: unknown, answer: unknown) => {
      const sender = (e as { sender?: { id?: unknown } } | null)?.sender;
      if (answer !== id || sender?.id !== target.id) return;
      finish();
    };
    const finish = () => { clearTimeout(timer); ipc.off(OFFICE_JOURNAL_DONE, done); resolve(); };
    ipc.on(OFFICE_JOURNAL_DONE, done);
    timer = setTimeout(finish, capMs);
    try { target.send(OFFICE_JOURNAL_REQUEST, id); } catch { finish(); }
  });
}
