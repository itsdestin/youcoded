// PRACTICE screens — where the backup warning lives (backlog row 18, deck
// backup-warning-1). Each candidate home photographed under its
// `?backupNote=` switch (components/backup-note-practice.ts), beside today's
// screen in the same spot. Delete this file, its import in index.ts and the
// switch once Destin picks; keep only what the pick ships.
import type { ScreenEntry } from './types';

export const BACKUP_NOTE: readonly ScreenEntry[] = [
  // The buddy's tour, which had no picture at all before this round: the Files
  // stop as it ships, and the backup stop that would follow it.
  { name: 'tour/files', tags: ['tour'] },
  { name: 'tour/backups', tags: ['tour'], params: { backupNote: 'tour' } },
  // The first card where the assistant changes a file: an edit waiting for a Yes,
  // as it is today and with the one-time notice.
  { name: 'chat#bubbles-edit-approval', tags: ['chat', 'view', 'conversation'], session: 'wb-2', params: { seed: 'bubbles-edit-approval' } },
  { name: 'chat#backup-first-change', tags: ['chat', 'view', 'conversation'], session: 'wb-2', params: { seed: 'bubbles-edit-approval', backupNote: 'first-change' } },
  // Settings → Permissions with the notice in its modes card.
  { name: 'settings/assistant/permissions#backup-note', tags: ['settings', 'dialog'], params: { backupNote: 'permissions' } },
];
