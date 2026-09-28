// Saving open Office documents before their window goes (design §4: "on tab close, sleep,
// window close and app quit — the quit path waits up to 5 s").
//
// WHY main has to ask: autosave runs in the renderer, 3 s after the last change. A window that
// closes (or an app that quits) inside that window would drop the last few seconds of typing,
// because only the editor in that window holds them. So main asks the window to save every
// open document first — OFFICE_FLUSH_REQUEST with an id — and waits for OFFICE_FLUSH_DONE with
// the same id, or 5 s, whichever comes first. The renderer side is office-store.ts
// (answerFlushRequests).
import { BrowserWindow, app, ipcMain } from 'electron';
import { getOfficeSessions, quitOfficeSessions } from './office-session-registry';

export const OFFICE_FLUSH_REQUEST = 'office:flush-request';
export const OFFICE_FLUSH_DONE = 'office:flush-done';
const OFFICE_FLUSH_CAP_MS = 5_000;

interface FlushTarget { send(channel: string, id: string): void; isDestroyed(): boolean }
interface FlushIpc {
  on(channel: string, l: (e: unknown, ...args: unknown[]) => void): unknown;
  off(channel: string, l: (e: unknown, ...args: unknown[]) => void): unknown;
}
export const OFFICE_PROCEED = 'office:proceed';

let seq = 0;

type FlushOutcome = 'flushed' | 'failed' | 'timeout' | 'gone';

/**
 * Ask one window to save its open documents. Never rejects; resolves how it ended:
 * flushed (all saved), failed (the window answered that some could not be saved), timeout (no
 * answer in 5 s — a hung renderer), gone (the window went away).
 * WHY the cap only without an answer (fix round 2): a window that ANSWERS "failed" is waiting
 * for the person to choose (Review / Close anyway); only silence may be treated as "go ahead".
 */
export function askToFlush(target: FlushTarget, ipc: FlushIpc = ipcMain, capMs = OFFICE_FLUSH_CAP_MS): Promise<FlushOutcome> {
  if (target.isDestroyed()) return Promise.resolve('gone');
  const id = `flush-${++seq}`;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (how: FlushOutcome) => {
      clearTimeout(timer);
      ipc.off(OFFICE_FLUSH_DONE, onDone);
      resolve(how);
    };
    const onDone = (e: unknown, answer: unknown, result: unknown) => {
      // Only the asked window may answer for itself (fix round 2).
      const sender = (e as { sender?: unknown } | null)?.sender;
      if (answer !== id || (sender !== undefined && sender !== target)) return;
      const failed = (result as { failed?: unknown } | null)?.failed;
      finish(typeof failed === 'number' && failed > 0 ? 'failed' : 'flushed');
    };
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
interface GateDeps { hasDocuments(senderId: number): boolean; ipc?: FlushIpc; capMs?: number; quitApp?: () => void }
const realDeps = (): GateDeps => ({ hasDocuments: (id) => getOfficeSessions()?.hasFor(id) ?? false });

// Windows whose documents were just saved for a close in progress: the close that follows lets
// the window go instead of asking again. WHY (the loop): the gate re-issues close() itself, and
// that second close event must pass straight through.
const flushedForClose = new WeakSet<object>();
// A close or quit held because a window answered "failed": what "Close anyway" goes ahead with.
const held = new Map<object, { kind: 'close'; win: ClosingWindow } | { kind: 'quit'; quitApp: () => void }>();
let skipQuitGate = false;

// "Close anyway" (the renderer's office:proceed) — registered once, on first use.
const proceedListening = new WeakSet<object>();
function listenForProceed(ipc: FlushIpc): void {
  if (proceedListening.has(ipc)) return;
  proceedListening.add(ipc);
  ipc.on(OFFICE_PROCEED, (e: unknown) => {
    const sender = (e as { sender?: object } | null)?.sender;
    const h = sender ? held.get(sender) : undefined;
    if (!h || !sender) return;
    held.delete(sender);
    if (h.kind === 'close') {
      flushedForClose.add(h.win);
      if (!h.win.isDestroyed()) h.win.close();
    } else {
      skipQuitGate = true;
      h.quitApp();
    }
  });
}

/**
 * Call first in a window's `close` handler. Returns true when it held the close (preventDefault)
 * to save this window's Office documents. It closes the window itself once they are saved (or
 * after 5 s with no answer); when the window answers that some could not be saved, it leaves
 * the window open — the renderer asks the person, and "Close anyway" closes it (office:proceed).
 * Returns false when there is nothing to save, or on the close it re-issued.
 */
export function holdCloseForOfficeSave(win: ClosingWindow, ev: { preventDefault(): void }, deps: GateDeps = realDeps()): boolean {
  if (flushedForClose.has(win)) { flushedForClose.delete(win); return false; }
  if (win.isDestroyed() || !deps.hasDocuments(win.webContents.id)) return false;
  ev.preventDefault();
  const ipc = deps.ipc ?? ipcMain;
  listenForProceed(ipc);
  void askToFlush(win.webContents, ipc, deps.capMs).then((how) => {
    if (how === 'failed') { held.set(win.webContents, { kind: 'close', win }); return; }
    flushedForClose.add(win);
    if (!win.isDestroyed()) win.close();
  });
  return true;
}

/**
 * Quit, before anything is torn down: every window with open documents saves them. Resolves
 * true to go ahead; false when a window answered that some could not be saved — the quit is
 * then held for the person's choice, and "Close anyway" quits again (this gate then lets it by).
 */
export async function officeQuitGate(
  windows: ClosingWindow[] = BrowserWindow.getAllWindows() as unknown as ClosingWindow[],
  deps: GateDeps = realDeps(),
): Promise<boolean> {
  if (skipQuitGate) { skipQuitGate = false; return true; }
  const ipc = deps.ipc ?? ipcMain;
  listenForProceed(ipc);
  const asking = windows.filter((w) => !w.isDestroyed() && deps.hasDocuments(w.webContents.id));
  const outcomes = await Promise.all(asking.map((w) => askToFlush(w.webContents, ipc, deps.capMs)));
  const quitApp = deps.quitApp ?? (() => app.quit());
  let go = true;
  outcomes.forEach((how, i) => { if (how === 'failed') { go = false; held.set(asking[i].webContents, { kind: 'quit', quitApp }); } });
  return go;
}

/** Quit's teardown: every window saves once more (all at once, capped), then the office
 *  sessions are stopped and their temp folders removed (quitOfficeSessions). */
export async function flushThenQuitOfficeSessions(
  windows: ClosingWindow[] = BrowserWindow.getAllWindows() as unknown as ClosingWindow[],
  deps: GateDeps = realDeps(),
  quit: () => Promise<void> = () => quitOfficeSessions(),
): Promise<void> {
  const asking = windows.filter((w) => !w.isDestroyed() && deps.hasDocuments(w.webContents.id));
  await Promise.all(asking.map((w) => askToFlush(w.webContents, deps.ipc, deps.capMs)));
  await quit();
}
