// The buddy's tour, one picture per stop worth reviewing: `tour/<stop id>`
// opens the tour on that stop (shoot-app-screens.ts → guide-state). The tour
// had no pictures before backlog row 18 (deck backup-warning-1) needed them.
// Files, and the backup warning stop Destin placed right after it.
import type { ScreenEntry } from './types';

export const TOUR: readonly ScreenEntry[] = [
  // The first four stops (guide-stops.ts), so a
  // "what changed since the last release" comparison covers the tour.
  ...(['buddy', 'sessions', 'tags', 'projects'] as const).map((id) => ({ name: `tour/${id}`, tags: ['tour'] })),
  // NOT listed: tour/models, tour/themes, tour/help. Their Settings dialog opens ~350ms after the bubble and takes the
  // first Escape (documented in GuideTour.tsx TourEscape), so `shoot --check`'s "Escape closes only the top layer" fails.
  // Listing them needs that app behaviour fixed first (Escape should close the bubble), a user-visible change.
  { name: 'tour/files', tags: ['tour'] },
  { name: 'tour/backups', tags: ['tour'] },
];
