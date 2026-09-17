// The small named glyph set a page may pick (shared/pages-types.ts PageIcon).
// Stroke icons in the same style as the Projects folder in HeaderBar.tsx, so a
// pinned page's button sits beside it without looking imported from elsewhere.
import React from 'react';
import type { PageIcon } from '../../../shared/pages-types';

const PATHS: Record<PageIcon, React.ReactNode> = {
  page: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zM13 3v5h5M8 13h8M8 17h5" />,
  timer: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 2M12 21a8 8 0 100-16 8 8 0 000 16zM9 2h6" />,
  notes: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM8 9h8M8 13h8M8 17h5" />,
  paint: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3c-4.97 0-9 3.58-9 8 0 2.5 1.5 3 3 3h1.5a1.5 1.5 0 011.5 1.5V17a3 3 0 003 3c4.97 0 9-3.58 9-8s-4.03-9-9-9zM8 9h.01M12 7h.01M16 9h.01" />,
  chart: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 20V10M10 20V4M16 20v-8M22 20H2" />,
  calendar: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7zM4 10h16M8 3v4M16 3v4" />,
  list: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />,
  game: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 8h12a4 4 0 014 4v2a4 4 0 01-4 4h-1l-2-2H9l-2 2H6a4 4 0 01-4-4v-2a4 4 0 014-4zM8 11v4M6 13h4M15 12h.01M18 14h.01" />,
};

export function PageGlyph({ icon, className = 'w-4 h-4' }: { icon: PageIcon; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[icon] ?? PATHS.page}
    </svg>
  );
}

/** The Pages destination's own icon — a stack of pages, distinct from the
 *  single-page glyph above so the library button never reads as one page. */
export function PagesIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M8 4h9a2 2 0 012 2v9M5 8h9a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2v-9a2 2 0 012-2zM7 13h6M7 17h4" />
    </svg>
  );
}

/** A push-pin, upright. Round 1 of the shell deck (2026-09-16): the first
 *  glyph, a tilted pin, read as "a little odd" — this one is the familiar
 *  upright shape, filled when the page is pinned. */
export function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 17v5M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16a1 1 0 001 1h12a1 1 0 001-1v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V7a1 1 0 011-1 2 2 0 000-4H8a2 2 0 000 4 1 1 0 011 1z" />
    </svg>
  );
}

/** A pencil, for "Edit in chat" on a library card (round 5: editing lives only
 *  in the Manage pages screen). */
export function EditGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4L16.5 3.5zM14 6l4 4" />
    </svg>
  );
}
