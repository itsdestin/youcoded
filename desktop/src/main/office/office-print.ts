// Print (finish plan Task 3): the operating system's print dialog for a PDF of the document, and
// the "Save as PDF" offer when that dialog can't be shown. Kept out of office-ipc.ts (as
// office-dialogs.ts is) so that file stays free of electron and its tests drive it with fakes.
import { BrowserWindow, dialog, type WebContents } from 'electron';

/** How a print ended: printed (sent to a printer), cancelled by the person, or failed — with
 *  'no-printer' when the system reported no printing service or printer at all. */
export type PrintOutcome = 'printed' | 'cancelled' | { failed: 'no-printer' | 'not-loaded' | 'other' };

/** Reads webContents.print's answer. WHY by its text: Electron reports every failure as a string —
 *  measured on Linux 2026-09-29: a closed dialog is "Print job canceled"; a machine with no printing
 *  service (no CUPS) is "Failed to enumerate printers", before any dialog is shown. */
export function classifyPrintResult(ok: boolean, reason: string): PrintOutcome {
  if (ok) return 'printed';
  if (/cancel/i.test(reason)) return 'cancelled';
  if (/enumerate printers|default printer/i.test(reason)) return { failed: 'no-printer' };
  return { failed: 'other' };
}

/** How long the PDF may take to appear in the print window before Office gives up. */
const LOAD_LIMIT_MS = 20_000;

/** Chromium's PDF viewer says when the document is drawn: its `viewer.loadState_` leaves
 *  'loading'. WHY wait for it: printing before then printed one blank page (measured). It is the
 *  viewer's own field, not a promised API — if a later Electron renames it, printing ends in
 *  'not-loaded' and the person is offered a PDF instead, never a blank page. */
async function viewerState(win: BrowserWindow): Promise<'success' | 'failed' | null> {
  const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith('chrome-extension://'));
  if (!frame) return null;
  const state = await frame
    .executeJavaScript("(() => { const v = window.viewer; return v && typeof v.loadState_ === 'string' ? v.loadState_ : null; })()")
    .catch(() => null);
  return state === 'success' || state === 'failed' ? state : null;
}

/** Show the system print dialog for `file` (a PDF Office made in its own temp folder). Resolves
 *  when the dialog is closed, the job is sent, or printing turned out to be impossible. */
export async function printPdf(file: string): Promise<PrintOutcome> {
  // WHY a hidden window of its own: the print dialog prints a page, and the PDF viewer is the page
  // that lays a PDF out exactly. WHY its own session and no preload: it shows only the PDF Office
  // just made, and needs nothing of the app's. WHY a "persist:" session (measured in the dev app
  // 2026-09-29): in an in-memory one Chromium's PDF viewer never starts (its page stays empty), so
  // every print ended in 'not-loaded'. Its folder keeps nothing but the viewer's own settings.
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:office-print', spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await win.loadFile(file);
    const until = Date.now() + LOAD_LIMIT_MS;
    let state = await viewerState(win);
    while (state === null && Date.now() < until && !win.isDestroyed()) {
      await new Promise((r) => setTimeout(r, 100));
      state = await viewerState(win);
    }
    if (state !== 'success') return { failed: 'not-loaded' };
    return await new Promise<PrintOutcome>((resolve) => {
      win.webContents.print({ silent: false, printBackground: true }, (ok, reason) => resolve(classifyPrintResult(ok, String(reason ?? ''))));
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Printing could not be shown: say why (worded by the caller) and offer a PDF instead. True when
 *  the person chose "Save as PDF…". Parented to the asking window. */
export async function offerPdf(sender: unknown, message: string): Promise<boolean> {
  const win = BrowserWindow.fromWebContents(sender as WebContents);
  const opts = {
    type: 'info' as const,
    message,
    detail: 'You can save it as a PDF instead, and print that from another app or computer.',
    buttons: ['Save as PDF…', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 0;
}
