// Keeps the app's own document frames (the HTML preview and Pages, both <iframe srcdoc> directly under the app's page) from
// navigating THEMSELVES to a website, a file or a data page.
//
// WHY (2026-10-30 security audit F8): a sandboxed preview cannot reach the app, but `location = 'https://lookalike'` would swap
// its content for a remote page drawn inside the app's own chrome (a believable fake sign-in), or carry text out in the address.
// Content-Security-Policy cannot stop self-navigation (`navigate-to` was dropped from browsers), so main watches it, the same way
// office-frame-guard.ts does for the Office editor.
//
// What is left alone on purpose: the frame's own first load (about:srcdoc / about:blank), `office:` frames (their own guard),
// in-page #fragment moves, the dev server's own address (the dev workbench frames its fixtures), and frames NESTED inside a preview
// (an embedded video player is the page's business and is bounded by the preview's own frame-src). Links that open a NEW window
// (target=_blank) never reach this guard: they go through setWindowOpenHandler, which sends http(s) to the browser.
import type { FrameNavigation } from './office/office-frame-guard';

export interface PreviewGuardFrame {
  readonly frameTreeNodeId: number;
  readonly parent: PreviewGuardFrame | null;
}

const SCHEMES_THAT_LEAVE = /^(https?|ftp|file|data):/i;

function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

/** True when this navigation must be cancelled. `mainFrameId` is the app page's frameTreeNodeId. */
export function blocksPreviewFrameNavigation(
  nav: Pick<FrameNavigation, 'url' | 'isMainFrame'> & { isSameDocument?: boolean; frame: PreviewGuardFrame | null },
  mainFrameId: number,
  devServerUrl: string,
): boolean {
  if (nav.isMainFrame || nav.isSameDocument) return false;
  if (!SCHEMES_THAT_LEAVE.test(nav.url.trim())) return false;                    // srcdoc, blank, office:, blob: stay
  if (devServerUrl && (nav.url === devServerUrl || nav.url.startsWith(`${devServerUrl}/`) || nav.url.startsWith(`${devServerUrl}?`))) return false;
  const parentId = safe(() => nav.frame?.parent?.frameTreeNodeId ?? -1, -1);
  return parentId === mainFrameId;                                              // only the frame directly under the app page
}

/** Wires the guard to one window (createAppWindow). */
export function sealPreviewFrames(
  contents: {
    mainFrame: { frameTreeNodeId: number };
    on(event: 'will-frame-navigate', listener: (e: any) => void): unknown;
  },
  devServerUrl: string,
): void {
  contents.on('will-frame-navigate', (e) => {
    const mainId = safe(() => contents.mainFrame.frameTreeNodeId, -2);
    if (blocksPreviewFrameNavigation(e, mainId, devServerUrl)) {
      e.preventDefault();
      console.warn(`[preview] blocked a document frame from navigating away (${String(e.url).slice(0, 80)})`);
    }
  });
}
