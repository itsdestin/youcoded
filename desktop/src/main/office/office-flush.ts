// Saving open Office documents before their window goes (design §4: "on tab close, sleep,
// window close and app quit — the quit path waits up to 5 s").
//
// WHY main has to ask: autosave runs in the renderer, 3 s after the last change. A window that
// closes (or an app that quits) inside that window would drop the last few seconds of typing,
// because only the editor in that window holds them. So main asks the window to save every
// open document first — OFFICE_FLUSH_REQUEST with an id — and waits for OFFICE_FLUSH_DONE with
// the same id, or 5 s, whichever comes first. The renderer side is office-store.ts
// (answerFlushRequests).
import { BrowserWindow, ipcMain } from 'electron';
import { getOfficeSessions, quitOfficeSessions } from './office-session-registry';

export const OFFICE_FLUSH_REQUEST = 'office:flush-request';
export const OFFICE_FLUSH_DONE = 'office:flush-done';
export const OFFICE_FLUSH_CAP_MS = 5_000;

interface FlushTarget { send(channel: string, id: string): void; isDestroyed(): boolean }
interface FlushIpc {
  on(channel: string, l: (e: unknown, id: unknown) => void): unknown;
  off(channel: string, l: (e: unknown, id: unknown) => void): unknown;
}

let seq = 0;

/** Ask one window to save its open documents. Never rejects; resolves how it ended. */
export function askToFlush(target: FlushTarget, ipc: FlushIpc = ipcMain, capMs = OFFICE_FLUSH_CAP_MS): Promise<'flushed' | 'timeout' | 'gone'> {
  if (target.isDestroyed()) return Promise.resolve('gone');
  const id = `flush-${++seq}`;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (how: 'flushed' | 'timeout' | 'gone') => {
      clearTimeout(timer);
      ipc.off(OFFICE_FLUSH_DONE, onDone);
      resolve(how);
    };
    const onDone = (_e: unknown, answer: unknown) => { if (answer === id) finish('flushed'); };
    ipc.on(OFFICE_FLUSH_DONE, onDone);
    timer = setTimeout(() => finish('timeout'), capMs);
    try { target.send(OFFICE_FLUSH_REQUEST, id); } catch { finish('gone'); }
  });
}

interface ClosingWindow {
  webContents: FlushTarget & { id: number };
  isDestroyed(): boolean;
  close(): void;
}

// Windows whose documents were just saved for a close in progress: the close that follows lets
// the window go instead of asking again. WHY (the loop): the gate re-issues close() itself, and
// that second close event must pass straight through.
const flushedForClose = new WeakSet<object>();

/**
 * Call first in a window's `close` handler. Returns true when it held the close (preventDefault)
 * to save this window's Office documents; it closes the window again itself when the save is
 * done or 5 s have passed. Returns false when there is nothing to save, or on that second close.
 */
export function holdCloseForOfficeSave(
  win: ClosingWindow, ev: { preventDefault(): void },
  deps: { hasDocuments(senderId: number): boolean; ipc?: FlushIpc; capMs?: number } = { hasDocuments: (id) => getOfficeSessions()?.hasFor(id) ?? false },
): boolean {
  if (flushedForClose.has(win)) { flushedForClose.delete(win); return false; }
  if (win.isDestroyed() || !deps.hasDocuments(win.webContents.id)) return false;
  ev.preventDefault();
  void askToFlush(win.webContents, deps.ipc, deps.capMs).then(() => {
    flushedForClose.add(win);
    if (!win.isDestroyed()) win.close();
  });
  return true;
}

/** Quit: every window with open documents saves them (all at once, capped), then the office
 *  sessions are stopped and their temp folders removed (quitOfficeSessions). */
export async function flushThenQuitOfficeSessions(
  windows: ClosingWindow[] = BrowserWindow.getAllWindows() as unknown as ClosingWindow[],
  deps: { hasDocuments(senderId: number): boolean; ipc?: FlushIpc; capMs?: number } = { hasDocuments: (id) => getOfficeSessions()?.hasFor(id) ?? false },
  quit: () => Promise<void> = () => quitOfficeSessions(),
): Promise<void> {
  const asking = windows.filter((w) => !w.isDestroyed() && deps.hasDocuments(w.webContents.id));
  await Promise.all(asking.map((w) => askToFlush(w.webContents, deps.ipc, deps.capMs)));
  await quit();
}
