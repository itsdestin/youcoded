// Saving open Office documents before their window goes (design §4: "on tab close, sleep,
// window close and app quit — the quit path waits up to 5 s").
//
// WHY main has to ask: autosave runs in the renderer, 3 s after the last change. A window that
// closes (or an app that quits) inside that window would drop the last few seconds of typing,
// because only the editor in that window holds them. So main asks the window to save every
// open document first — OFFICE_FLUSH_REQUEST with an id — and waits for OFFICE_FLUSH_DONE with
// the same id, or 5 s, whichever comes first. The renderer side is office-store.ts
// (answerFlushRequests).
//
// When a window answers that some documents could not be saved, main holds the close (or the
// quit) and asks the person through OFFICE_UNSAVED_PROMPT — one prompt, counting every window's
// failed documents — until they choose Review or Close anyway (OFFICE_PROCEED).
//
// WHY main never overrides a window's unload veto (fix round 3; updated fix round 5): an editor
// page cannot veto — the add-on neutralises every beforeunload path in its frames — and the
// renderer's own Office veto (office-store) holds only while a document has unsaved work and no
// close was approved; answering this request approves it. Every veto that remains (an unsaved
// text-file edit, typing after the approval) is legitimate and must keep the window open.
import { BrowserWindow, app, ipcMain } from 'electron';
import { getOfficeSessions, quitOfficeSessions } from './office-session-registry';

export const OFFICE_FLUSH_REQUEST = 'office:flush-request';
export const OFFICE_FLUSH_DONE = 'office:flush-done';
export const OFFICE_PROCEED = 'office:proceed';
export const OFFICE_UNSAVED_PROMPT = 'office:unsaved-prompt';
const OFFICE_FLUSH_CAP_MS = 5_000;

/** Why main asks: a window close, the quit gate, or quit's final save (which never prompts). */
type FlushReason = 'close' | 'quit' | 'final';

interface FlushTarget { id: number; send(channel: string, ...args: unknown[]): void; isDestroyed(): boolean }
interface FlushIpc {
  on(channel: string, l: (e: unknown, ...args: unknown[]) => void): unknown;
  off(channel: string, l: (e: unknown, ...args: unknown[]) => void): unknown;
}

let seq = 0;

type FlushOutcome = { how: 'flushed' | 'timeout' | 'gone' } | { how: 'failed'; count: number; firstPath: string };

/**
 * Ask one window to save its open documents. Never rejects; resolves how it ended:
 * flushed (all saved), failed (the window answered that some could not be saved), timeout (no
 * answer in 5 s — a hung renderer), gone (the window went away).
 * WHY the cap only without an answer (fix round 2): a window that ANSWERS "failed" is waiting
 * for the person to choose (Review / Close anyway); only silence may be treated as "go ahead".
 */
export function askToFlush(target: FlushTarget, ipc: FlushIpc = ipcMain, capMs = OFFICE_FLUSH_CAP_MS, reason: FlushReason = 'close'): Promise<FlushOutcome> {
  if (target.isDestroyed()) return Promise.resolve({ how: 'gone' });
  const id = `flush-${++seq}`;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (o: FlushOutcome) => {
      clearTimeout(timer);
      ipc.off(OFFICE_FLUSH_DONE, onDone);
      resolve(o);
    };
    const onDone = (e: unknown, answer: unknown, result: unknown) => {
      // Only the asked window may answer for itself — matched by id: the event.sender Electron
      // hands a listener is not always the same object as win.webContents (fix round 2).
      const sender = (e as { sender?: { id?: unknown } } | null)?.sender;
      if (answer !== id || (sender !== undefined && sender?.id !== target.id)) return;
      const r = (result ?? {}) as { failed?: unknown; firstPath?: unknown };
      if (typeof r.failed === 'number' && r.failed > 0) finish({ how: 'failed', count: r.failed, firstPath: String(r.firstPath ?? '') });
      else finish({ how: 'flushed' });
    };
    ipc.on(OFFICE_FLUSH_DONE, onDone);
    timer = setTimeout(() => finish({ how: 'timeout' }), capMs);
    try { target.send(OFFICE_FLUSH_REQUEST, id, reason); } catch { finish({ how: 'gone' }); }
  });
}

interface ClosingWindow {
  webContents: FlushTarget;
  isDestroyed(): boolean;
  close(): void;
}
interface GateDeps { hasDocuments(senderId: number): boolean; ipc?: FlushIpc; capMs?: number; quitApp?: () => void }
const realDeps = (): GateDeps => ({ hasDocuments: (id) => getOfficeSessions()?.hasFor(id) ?? false });

// Windows whose documents were just saved for a close in progress: the close that follows lets
// the window go instead of asking again. WHY (the loop): the gate re-issues close() itself, and
// that second close event must pass straight through.
const flushedForClose = new WeakSet<object>();
// What "Close anyway" goes ahead with, keyed by the webContents id of the window that shows the
// prompt (ids, not objects — see askToFlush).
const held = new Map<number, { kind: 'close'; win: ClosingWindow } | { kind: 'quit'; quitApp: () => void }>();
let skipQuitGate = false;

// "Close anyway" (the renderer's office:proceed) — registered once, on first use.
const proceedListening = new WeakSet<object>();
function listenForProceed(ipc: FlushIpc): void {
  if (proceedListening.has(ipc)) return;
  proceedListening.add(ipc);
  ipc.on(OFFICE_PROCEED, (e: unknown) => {
    const id = (e as { sender?: { id?: unknown } } | null)?.sender?.id;
    const h = typeof id === 'number' ? held.get(id) : undefined;
    if (!h || typeof id !== 'number') return;
    held.delete(id);
    if (h.kind === 'close') {
      flushedForClose.add(h.win);
      if (!h.win.isDestroyed()) h.win.close();
    } else {
      // One choice covers every window's documents (fix round 3).
      held.forEach((other, key) => { if (other.kind === 'quit') held.delete(key); });
      skipQuitGate = true;
      h.quitApp();
    }
  });
}

/**
 * Call first in a window's `close` handler. Returns true when it held the close (preventDefault)
 * to save this window's Office documents. It closes the window itself once they are saved (or
 * after 5 s with no answer); when the window answers that some could not be saved, it leaves
 * the window open and asks the person (OFFICE_UNSAVED_PROMPT); "Close anyway" closes it.
 * Returns false when there is nothing to save, or on the close it re-issued.
 */
export function holdCloseForOfficeSave(win: ClosingWindow, ev: { preventDefault(): void }, deps: GateDeps = realDeps()): boolean {
  if (flushedForClose.has(win)) { flushedForClose.delete(win); return false; }
  if (win.isDestroyed() || !deps.hasDocuments(win.webContents.id)) return false;
  ev.preventDefault();
  const ipc = deps.ipc ?? ipcMain;
  listenForProceed(ipc);
  void askToFlush(win.webContents, ipc, deps.capMs, 'close').then((o) => {
    if (o.how === 'failed') {
      held.set(win.webContents.id, { kind: 'close', win });
      if (!win.webContents.isDestroyed()) win.webContents.send(OFFICE_UNSAVED_PROMPT, { count: o.count, firstPath: o.firstPath });
      return;
    }
    flushedForClose.add(win);
    if (!win.isDestroyed()) win.close();
  });
  return true;
}

/**
 * Quit, before anything is torn down: every window with open documents saves them. Resolves
 * true to go ahead; false when some could not be saved — the quit is then held and ONE prompt
 * (in the first such window) counts them all; "Close anyway" quits again past this gate.
 */
export async function officeQuitGate(
  windows: ClosingWindow[] = BrowserWindow.getAllWindows() as unknown as ClosingWindow[],
  deps: GateDeps = realDeps(),
): Promise<boolean> {
  if (skipQuitGate) { skipQuitGate = false; return true; }
  const ipc = deps.ipc ?? ipcMain;
  listenForProceed(ipc);
  const asking = windows.filter((w) => !w.isDestroyed() && deps.hasDocuments(w.webContents.id));
  const outcomes = await Promise.all(asking.map((w) => askToFlush(w.webContents, ipc, deps.capMs, 'quit')));
  let count = 0;
  let prompter: ClosingWindow | null = null;
  let firstPath = '';
  outcomes.forEach((o, i) => {
    if (o.how !== 'failed') return;
    count += o.count;
    if (!prompter) { prompter = asking[i]; firstPath = o.firstPath; }
  });
  if (!prompter) return true;
  const w = prompter as ClosingWindow;
  held.set(w.webContents.id, { kind: 'quit', quitApp: deps.quitApp ?? (() => app.quit()) });
  if (!w.webContents.isDestroyed()) w.webContents.send(OFFICE_UNSAVED_PROMPT, { count, firstPath });
  return false;
}

/** Quit's teardown: every window saves once more (all at once, capped; 'final' never prompts —
 *  the person already chose — and lets the window unload), then the office sessions are
 *  stopped and their temp folders removed (quitOfficeSessions). */
export async function flushThenQuitOfficeSessions(
  windows: ClosingWindow[] = BrowserWindow.getAllWindows() as unknown as ClosingWindow[],
  deps: GateDeps = realDeps(),
  quit: () => Promise<void> = () => quitOfficeSessions(),
): Promise<void> {
  const asking = windows.filter((w) => !w.isDestroyed() && deps.hasDocuments(w.webContents.id));
  await Promise.all(asking.map((w) => askToFlush(w.webContents, deps.ipc, deps.capMs, 'final')));
  await quit();
}
