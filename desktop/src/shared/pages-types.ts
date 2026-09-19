// YouCoded Pages — shared shapes.
// Plan: youcoded-dev/docs/active/plans/2026-09-16-youcoded-pages-phasing.md
//
// A page is a small app inside YouCoded, built in chat, shown in the live theme.
// Phase 1 (the shell) pages reach nothing outside their own frame. Phase 2 adds
// connections, below — decided on two questions decks on 2026-09-19.

/** Where a page lives. Personal pages belong to the person; project pages
 *  belong to one project folder and say so on their card. Explicit, never
 *  inferred from the current session (scope §1: "explicit source bindings"). */
export type PageHome =
  | { kind: 'personal' }
  | { kind: 'project'; path: string; name: string };

/** The small named icon set a page may pick for its card and pinned button.
 *  A named glyph, not an image: the pinned button is 16px in the header bar
 *  and follows `currentColor` like the Projects folder beside it. */
export type PageIcon =
  | 'page' | 'timer' | 'notes' | 'paint' | 'chart' | 'calendar' | 'list' | 'game';

// ── Phase 2: connections (decided on two questions decks, 2026-09-19) ──────
// Everything a page reaches outside its frame is listed here and approved
// once; anything unlisted is blocked. The shapes are the UI's contract — the
// backend (manifest parsing, the approval store, fetch-on-behalf) is built
// AFTER the screens are approved, so these fields are optional on PageSummary
// until then and only the workbench fake fills them.

/** `lookup`: the app sends look-up requests only and blocks the rest, so the
 *  approval can truthfully say "Cannot send changes". Never worded as
 *  "read-only" or "safe" for an outside service (deck Q-readonly). */
type PageAccess = 'lookup' | 'full';

export type PageConnection =
  /** YouCoded's own service, as the signed-in person. */
  | { id: string; kind: 'youcoded' }
  /** A service that takes a pasted key. The key lives in the app, never the page. */
  | { id: string; kind: 'key'; service: string; address: string; access: PageAccess }
  /** Public information: an approved address, nothing secret. */
  | { id: string; kind: 'public'; address: string }
  /** The GitHub sign-in the app already holds. */
  | { id: string; kind: 'github'; access: PageAccess }
  /** The whole internet — its own blunt approval, never combined with a key
   *  or sign-in on the same page (follow-up deck Q-open, Q-open-mix). */
  | { id: string; kind: 'open' };

/** A connection as the person sees it on one page. */
export type PageConnectionStatus = PageConnection & {
  /** False for a line added since the last approval — the page pauses and the
   *  approval screen marks just this line New (deck S-change). */
  approved: boolean;
  /** `key` only: a key for this service is already saved, so the approval
   *  offers it instead of asking again (deck Q-key-reuse). */
  savedKey?: boolean;
};

/** Freshness of a connected page, owned by the app and shown in the band
 *  (deck Q-last-updated). `at` is null before the first successful update. */
interface PageRefreshState {
  at: string | null;
  failed: boolean;
}

/** A key saved once under Settings › Connected accounts, with the pages using it. */
export interface SavedPageKey {
  service: string;
  address: string;
  usedBy: { id: string; name: string }[];
}

export interface PageSummary {
  /** `personal:<slug>` or `project:<project name>:<slug>` — the same on every
   *  device, so a synced pin matches (design review F3). */
  id: string;
  name: string;
  /** One line, shown on the card under the name. */
  description: string;
  icon: PageIcon;
  home: PageHome;
  /** Pinned pages get their own icon beside Projects. Per device. */
  pinned: boolean;
  /** ISO timestamp of the last change to the page's manifest or document. */
  updatedAt: string;
  /** Changes only when `page.html` is rewritten — never on a data save — so
   *  the host reloads the frame on an edit and not on the page's own saving
   *  (design review F7). Milliseconds. */
  htmlStamp: number;
  /** What the page reaches. Absent or empty: a page that reaches nothing. */
  connections?: PageConnectionStatus[];
  /** Present only for a connected page that has been approved. */
  refresh?: PageRefreshState;
}

/** A page's working version, ready to show. `html` is a complete document;
 *  the host injects the theme, the style kit and `data` before it is framed. */
export interface PageDocument extends PageSummary {
  html: string;
  /** The page's own saved data, folded; null when it has never saved. */
  data: unknown | null;
}

/** Largest `data.json` the host will write, checked in the renderer before
 *  posting and in main before writing (design review F4). */
export const MAX_PAGE_DATA_BYTES = 1_000_000;

/** Why a page could not be shown. Specific and accurate when known
 *  (docs/error-message-standards.md); the host never invents a cause. */
export type PageLoadFailure =
  | { kind: 'missing'; message: string }
  | { kind: 'unreadable'; message: string };

export interface PagesBridge {
  list: () => Promise<PageSummary[]>;
  get: (id: string) => Promise<{ ok: true; page: PageDocument } | { ok: false; failure: PageLoadFailure }>;
  setPinned: (id: string, pinned: boolean) => Promise<PageSummary[]>;
  /** Writes the page's own data beside it (`data.json`, later save wins).
   *  Refused over MAX_PAGE_DATA_BYTES or for an unknown page. */
  setData: (id: string, data: unknown) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Fires with the fresh list whenever a page is added, rewritten, renamed,
   *  pinned or removed — on this device or arriving by sync. Returns the
   *  unsubscribe. */
  onChanged: (cb: (pages: PageSummary[]) => void) => () => void;
  // Phase 2 — workbench-only until the screens are approved (mock-only.ts).
  /** Approves every unapproved line. `keys` carries a pasted key per `key`
   *  connection id, or 'saved' to use the one already kept. */
  approve?: (id: string, keys: Record<string, string>) => Promise<PageSummary[]>;
  /** Stops future use of one connection; the page asks again next time. */
  removeConnection?: (id: string, connectionId: string) => Promise<PageSummary[]>;
  /** Fetch fresh information now (the band's refresh button). */
  refresh?: (id: string) => Promise<PageSummary[]>;
  savedKeys?: () => Promise<SavedPageKey[]>;
  deleteSavedKey?: (service: string) => Promise<SavedPageKey[]>;
}

/** How many pinned pages the header shows before the rest stay in the
 *  library. Small on purpose: the left cluster shares its width with the
 *  session strip, and packSessions() already competes for it. */
export const MAX_PINNED_PAGES = 4;
