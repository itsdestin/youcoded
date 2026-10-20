import type { BrowserWindow, WebContents } from 'electron';

// WHY: a WebContents survives its renderer. isDestroyed() alone still admits sends
// to a disposed frame, and a held callback must never target its replacement page.
const pages = new Map<number, { generation: number; ready: boolean }>();
export function markRendererReady(id: number): void {
  const page = pages.get(id);
  if (page) page.ready = true;
}
export function rendererGeneration(id: number): number | undefined { return pages.get(id)?.generation; }
export function canDeliverToRenderer(wc: Pick<WebContents, 'id' | 'isDestroyed'> & Partial<Pick<WebContents, 'isCrashed'>>): boolean {
  return !wc.isDestroyed() && !wc.isCrashed?.() && pages.get(wc.id)?.ready !== false;
}
export function sendToRenderer(
  wc: (Pick<WebContents, 'id' | 'isDestroyed' | 'send'> & Partial<Pick<WebContents, 'isCrashed'>>) | null | undefined,
  channel: string, args: unknown[], generation?: number,
): boolean {
  if (!wc || !canDeliverToRenderer(wc)) return false;
  if (generation !== undefined && generation !== rendererGeneration(wc.id)) return false;
  try { wc.send(channel, ...args); return true; } catch { return false; }
}

interface RecoveryDeps {
  load(): Promise<unknown>;
  offerRecovery(): Promise<boolean>;
  shuttingDown(): boolean;
}

/** One automatic retry per minute; a repeated failure asks natively, never loops. */
export function wireRendererRecovery(win: BrowserWindow, d: RecoveryDeps): void {
  const wc = win.webContents;
  const page = { generation: 0, ready: false };
  pages.set(wc.id, page);
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastAutomatic: number | undefined;
  let asking = false;
  const unavailable = () => { page.generation++; page.ready = false; };
  const failed = () => {
    if (closed || win.isDestroyed() || d.shuttingDown() || retry || asking) return;
    // WHY not reset at did-finish-load: a page can load and immediately crash again.
    if (lastAutomatic !== undefined && Date.now() - lastAutomatic < 60_000) {
      asking = true;
      void d.offerRecovery().then((again) => {
        asking = false;
        if (again) { lastAutomatic = undefined; failed(); }
      }).catch(() => { asking = false; });
      return;
    }
    lastAutomatic = Date.now();
    retry = setTimeout(() => {
      retry = undefined;
      if (!closed && !win.isDestroyed() && !d.shuttingDown()) void d.load().catch(failed);
    }, 250);
    retry.unref?.();
  };
  wc.on('did-start-navigation', (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
    if (details?.isMainFrame && !details.isSameDocument) unavailable();
  });
  wc.on('render-process-gone', (_event, details) => {
    unavailable();
    if (details.reason !== 'clean-exit') failed();
  });
  wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) { unavailable(); failed(); }
  });
  const dispose = () => {
    closed = true;
    if (retry) clearTimeout(retry);
    pages.delete(wc.id);
  };
  wc.once('destroyed', dispose);
  win.once('closed', dispose);
}
