// "A file has unsaved changes" — the one quit prompt (renderer UnsavedBeforeQuit.tsx). A quit, or
// the last window's close, is refused while a responding window holds unsaved edits: a text file
// open for editing, a draft parked after its editor went away, or an Office document with changes
// not saved to its file yet (the editor's own "modified" flag; renderer state/unsaved-editors.ts).
//
// WHY main has to know up front (Task 6 fix rounds 9–11): a text editor vetoes its window's unload
// — rightly — but a quit only meets that veto AFTER teardown, with every chat session already
// stopped; and a parked draft has no editor to veto anything. So each window tells main the names
// of its unsaved files whenever they change, and the quit gate refuses to begin while any has one.
//
// WHY no Office save handshake any more (finish plan Task 8): main used to ask every window to save
// its Office documents before a close or quit, wait for the answer, and hold the close with a
// second prompt when a save failed (office-flush.ts). Every edit now also reaches the document's
// recovery journal as it is made (office/office-recovery.ts), so a window that closes, crashes or
// hangs before its next save loses nothing — the next open of the file offers the edits back. An
// unsaved Office document still counts here, so a normal quit asks first, like any unsaved file.
//
// The channel names keep their Office prefix from when this lived beside the Office handshake.
import path from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';
import { isUnresponsive } from './crash-diagnostics';

export const OFFICE_UNSAVED_PROMPT = 'office:unsaved-prompt';
export const OFFICE_OTHER_UNSAVED = 'office:other-unsaved';
export const OFFICE_PROCEED = 'office:proceed';
export const OFFICE_DISMISS = 'office:dismiss';

interface UnsavedIpc {
  on(channel: string, l: (e: unknown, ...args: unknown[]) => void): unknown;
}
interface PromptWindow {
  webContents: { id: number; send(channel: string, ...args: unknown[]): void; isDestroyed(): boolean };
  isDestroyed(): boolean;
  close(): void;
  focus?(): void;
}

const unsaved = new Map<number, string[]>(); // window → file names (never folders)
interface ReportingSender {
  id: number;
  once?(event: 'destroyed', l: () => void): unknown;
  on?(event: 'did-start-navigation', l: (d: { isMainFrame?: boolean; isSameDocument?: boolean }) => void): unknown;
  on?(event: 'render-process-gone', l: () => void): unknown;
}
const watchedSenders = new Set<number>();
/** Call once at startup: records each window's "unsaved edits" state. */
export function watchUnsavedEdits(ipc: UnsavedIpc = ipcMain): void {
  ipc.on(OFFICE_OTHER_UNSAVED, (e: unknown, names: unknown) => {
    const s = (e as { sender?: ReportingSender } | null)?.sender;
    if (!s || typeof s.id !== 'number') return;
    const id = s.id;
    // Names only, whatever arrives: a path's folders are cut off (they are logged, never shown).
    const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string').map((n) => path.basename(n)) : names === true ? ['a file'] : [];
    if (list.length > 0) unsaved.set(id, list); else unsaved.delete(id);
    if (watchedSenders.has(id)) return;
    watchedSenders.add(id);
    s.once?.('destroyed', () => { unsaved.delete(id); watchedSenders.delete(id); });
    s.on?.('did-start-navigation', (d) => { if (d?.isMainFrame && !d.isSameDocument) unsaved.delete(id); });
    // A crashed page has lost its editor (and its edits) already: it cannot hold a quit (fix round 10).
    s.on?.('render-process-gone', () => { unsaved.delete(id); });
  });
}

/**
 * If a window that is still responding has unsaved edits, refuse the quit in it: focus it and show
 * its list, where the person can save each one, or discard them all and go on (office:proceed →
 * `act`). Returns whether it refused. The quit gate (before teardown), a quit repeated after
 * teardown, and the quit watchdog all ask this; `afterTeardown`/`restartDropped` make the prompt
 * say the chats have stopped and that a restart became a quit (fix round 11).
 * WHY a hung window is skipped (fix round 10): it can neither save nor answer, so it could only
 * block the quit forever — after teardown the quit watchdog lets a hung window go.
 */
export function refuseQuitForUnsaved(
  windows: PromptWindow[] = BrowserWindow.getAllWindows() as unknown as PromptWindow[],
  hung: (w: PromptWindow) => boolean = (w) => isUnresponsive(w as unknown as BrowserWindow),
  opts: { afterTeardown?: boolean; restartDropped?: boolean; ipc?: UnsavedIpc; act?: () => void } = {},
): boolean {
  const editing = windows.find((w) => !w.isDestroyed() && unsaved.has(w.webContents.id) && !hung(w));
  if (!editing) return false;
  return refuseIn(editing, 'quit', opts.act ?? (() => app.quit()), opts);
}

/**
 * The last window closing while it has unsaved edits (fix round 11): the same list, before it
 * closes; discarding closes it (and so quits). `isFloater` names windows that don't count against
 * "the last" — the buddy floaters. Returns whether it refused.
 */
export function refuseCloseForUnsaved(
  win: PromptWindow, isFloater: (w: PromptWindow) => boolean,
  opts: { ipc?: UnsavedIpc; windows?: PromptWindow[]; hung?: (w: PromptWindow) => boolean } = {},
): boolean {
  if (win.isDestroyed() || !unsaved.has(win.webContents.id)) return false;
  // A hung window is not asked (fix round 12): it could not show the list, and a refusal would only
  // hold its close — the close gate's "not responding, close it anyway?" question must be reachable.
  if ((opts.hung ?? ((w: PromptWindow) => isUnresponsive(w as unknown as BrowserWindow)))(win)) return false;
  const all = opts.windows ?? (BrowserWindow.getAllWindows() as unknown as PromptWindow[]);
  if (all.some((w) => w !== win && !w.isDestroyed() && !isFloater(w))) return false;
  return refuseIn(win, 'close', () => { if (!win.isDestroyed()) win.close(); }, { ipc: opts.ipc });
}

// What "Discard and quit/close" goes ahead with, by the webContents id of the window showing it.
const held = new Map<number, () => void>();
const proceedListening = new WeakSet<object>();
function listenForProceed(ipc: UnsavedIpc): void {
  if (proceedListening.has(ipc)) return;
  proceedListening.add(ipc);
  // The prompt was dismissed: its held quit/close must not fire on a later proceed (fix round 12).
  ipc.on(OFFICE_DISMISS, (e: unknown) => {
    const id = (e as { sender?: { id?: unknown } } | null)?.sender?.id;
    if (typeof id === 'number') held.delete(id);
  });
  ipc.on(OFFICE_PROCEED, (e: unknown) => {
    const id = (e as { sender?: { id?: unknown } } | null)?.sender?.id;
    const act = typeof id === 'number' ? held.get(id) : undefined;
    if (!act || typeof id !== 'number') return;
    held.delete(id);
    act();
  });
}

function refuseIn(w: PromptWindow, mode: 'quit' | 'close', act: () => void, opts: { afterTeardown?: boolean; restartDropped?: boolean; ipc?: UnsavedIpc }): boolean {
  listenForProceed(opts.ipc ?? ipcMain);
  held.set(w.webContents.id, act);
  w.focus?.();
  if (!w.webContents.isDestroyed()) {
    w.webContents.send(OFFICE_UNSAVED_PROMPT, { mode, afterTeardown: opts.afterTeardown === true, restartDropped: opts.restartDropped === true });
  }
  return true;
}
