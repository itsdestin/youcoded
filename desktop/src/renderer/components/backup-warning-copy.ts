// The backup warning — Destin's own sentence (review deck 2026-09-10, Z-1),
// word for word (backup-warning-1#BW-5 "keep").
//
// WHY its own file: it was the last line of setup's sign-in step until
// 2026-10-04, when Destin moved it off ("this is a weird place for that
// warning", first-run-4#P4-2). It now lives in TWO places that must never
// disagree (backup-warning-1#BW-1 "tour" + note, #BW-4 "top of card"):
//   - the buddy's tour, as the stop right after Files (guide-stops.ts);
//   - Settings → Permissions, a notice at the top of the Permission modes card
//     (PermissionsSection.tsx), always shown.
// Neither file can import the other without a cycle, so the words sit here.
export const BACKUP_WARNING =
  'With your permission, the assistant may create, change, or delete files on your device. Create backups for anything you cannot replace.';
