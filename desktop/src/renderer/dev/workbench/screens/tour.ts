// The buddy's tour, one picture per stop worth reviewing: `tour/<stop id>`
// opens the tour on that stop (shoot-app-screens.ts → guide-state). The tour
// had no pictures before backlog row 18 (deck backup-warning-1) needed them.
// Files, and the backup warning stop Destin placed right after it.
import type { ScreenEntry } from './types';

export const TOUR: readonly ScreenEntry[] = [
  { name: 'tour/files', tags: ['tour'] },
  { name: 'tour/backups', tags: ['tour'] },
];
