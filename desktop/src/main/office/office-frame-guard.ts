// Keeps every Office editor frame on its own office://<token> origin.
//
// WHY (final review, finding 2): the editor's CSP (office-protocol.ts) stops it from FETCHING
// anything off its origin, but CSP cannot stop a script from navigating its own frame —
// `location = 'https://…?' + text` would carry a document's words out in the URL. The app's
// top-frame guard (will-navigate + isAppPageUrl in main.ts) never sees subframe navigations,
// so this guard watches them.
//
// WHY only frames that are, or were, Office frames — not every subframe: the app's other
// iframes (HTML preview, Pages, the dev workbench) have their own rules, and an HTML preview
// following one of its own links is not this guard's business. A frame is remembered once it
// navigates to office: (its frameTreeNodeId survives later navigations), so a script cannot
// step out through an in-between page (about:blank, data:) and then leave from there.

/** The parts of Electron's WebFrameMain this guard reads. */
export interface GuardFrame {
  readonly url: string;
  readonly frameTreeNodeId: number;
  readonly parent: GuardFrame | null;
}

export interface FrameNavigation {
  url: string;
  isMainFrame: boolean;
  frame: GuardFrame | null;
  initiator?: GuardFrame | null;
}

const isOfficeUrl = (url: string): boolean => url.startsWith('office:');
// WHY these stay allowed inside an Office frame: they never reach the network and inherit the
// frame's own CSP — the editor makes blank and blob-backed frames of its own for printing and
// dialogs. A blob is allowed only when it was minted by an office: origin.
const isLocalToOffice = (url: string): boolean =>
  url === 'about:blank' || url === 'about:srcdoc' || url.startsWith('blob:office:');

/** Reads a frame's fields; a frame that was destroyed mid-event throws on access. */
function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

/** True when the frame, or any frame above it, is or was an Office frame. */
function insideOffice(frame: GuardFrame | null | undefined, known: Set<number>): boolean {
  for (let f = frame ?? null, hops = 0; f && hops < 32; f = safe(() => f!.parent, null), hops++) {
    const id = safe(() => f!.frameTreeNodeId, -1);
    if (known.has(id) || isOfficeUrl(safe(() => f!.url, ''))) return true;
  }
  return false;
}

/**
 * Decides one navigation. `known` holds the frameTreeNodeIds of frames that have loaded an
 * Office page; this call adds to it when a frame is headed to office:.
 */
export function blocksOfficeFrameNavigation(nav: FrameNavigation, known: Set<number>): boolean {
  // The top frame has its own guard (will-navigate + isAppPageUrl); leave it to that.
  if (nav.isMainFrame) return false;
  if (isOfficeUrl(nav.url)) {
    const id = safe(() => nav.frame?.frameTreeNodeId ?? -1, -1);
    if (id >= 0) known.add(id);
    return false;
  }
  const fromOffice = insideOffice(nav.frame, known) || insideOffice(nav.initiator, known);
  // A frame we can no longer see, started by nothing we can see, is not an Office frame.
  if (!fromOffice) return false;
  return !isLocalToOffice(nav.url);
}

/** Wires the guard to one window's webContents (createAppWindow). */
export function sealOfficeFrames(contents: {
  on(event: 'will-frame-navigate', listener: (e: FrameNavigation & { preventDefault(): void }) => void): unknown;
}): void {
  const known = new Set<number>();
  contents.on('will-frame-navigate', (e) => {
    if (blocksOfficeFrameNavigation(e, known)) {
      e.preventDefault();
      console.warn(`[office] blocked an editor frame from leaving its document origin (${e.url.slice(0, 80)})`);
    }
  });
}
