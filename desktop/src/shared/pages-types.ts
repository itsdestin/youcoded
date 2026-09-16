// YouCoded Pages — shared shapes (Phase 1, the shell).
// Plan: youcoded-dev/docs/active/plans/2026-09-16-youcoded-pages-phasing.md
//
// A page is a small app inside YouCoded, built in chat, shown in the live theme.
// Phase 1 pages reach nothing outside their own frame, so this shape carries no
// permissions yet — that model is an open question answered in Phase 2, and
// adding a field here before it is decided would pre-empt the deck.

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

export interface PageSummary {
  id: string;
  name: string;
  /** One line, shown on the card under the name. */
  description: string;
  icon: PageIcon;
  home: PageHome;
  /** Pinned pages get their own icon beside Projects. Per device. */
  pinned: boolean;
  /** ISO timestamp of the last applied version. */
  updatedAt: string;
}

/** A page's working version, ready to show. `html` is a complete document;
 *  the host injects the theme and the style kit before it is framed. */
export interface PageDocument extends PageSummary {
  html: string;
}

/** Why a page could not be shown. Specific and accurate when known
 *  (docs/error-message-standards.md); the host never invents a cause. */
export type PageLoadFailure =
  | { kind: 'missing'; message: string }
  | { kind: 'unreadable'; message: string };

export interface PagesBridge {
  list: () => Promise<PageSummary[]>;
  get: (id: string) => Promise<{ ok: true; page: PageDocument } | { ok: false; failure: PageLoadFailure }>;
  setPinned: (id: string, pinned: boolean) => Promise<PageSummary[]>;
  /** Fires with the fresh list whenever a page is added, applied, renamed,
   *  pinned or removed. Returns the unsubscribe. */
  onChanged: (cb: (pages: PageSummary[]) => void) => () => void;
}

/** How many pinned pages the header shows before the rest stay in the
 *  library. Small on purpose: the left cluster shares its width with the
 *  session strip, and packSessions() already competes for it. */
export const MAX_PINNED_PAGES = 4;
