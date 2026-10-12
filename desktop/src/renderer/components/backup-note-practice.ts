// PRACTICE SWITCH — where the backup warning lives (redesign backlog row 18,
// deck backup-warning-1). Removed once Destin picks; the losing homes go with it.
//
// WHY this exists: the one warning every new user used to see ("With your
// permission, the assistant may create, change, or delete files on your device.
// Create backups for anything you cannot replace.") was taken off the setup
// sign-in step on 2026-10-04 (first-run-4#P4-2, Destin: "this is a weird place
// for that warning"). Three candidate homes are built side by side so he can
// pick from pictures of the real screens instead of descriptions:
//
//   ?backupNote=tour          a stop in the buddy's welcome tour, after Files
//   ?backupNote=first-change  a one-time notice on the first card where the
//                             assistant creates or changes a file
//   ?backupNote=permissions   a notice inside Settings → Permissions' modes card
//
// Outside the workbench and the photo-only build this always answers 'none' —
// today's shipped behaviour, where the warning lives nowhere — so a typo or a
// stray URL in the real app can never show a draft.
import { isWorkbenchMode } from '../workbench-mode';

export type BackupNoteHome = 'none' | 'tour' | 'first-change' | 'permissions';

const HOMES: readonly BackupNoteHome[] = ['none', 'tour', 'first-change', 'permissions'];

export function backupNoteHome(): BackupNoteHome {
  if (!isWorkbenchMode()) return 'none';
  const raw = new URLSearchParams(location.search).get('backupNote') ?? 'none';
  return (HOMES as readonly string[]).includes(raw) ? (raw as BackupNoteHome) : 'none';
}

/** Destin's own wording (review deck 2026-09-10, Z-1), reused verbatim in every
 *  home: he rejected the PLACE, not the words, so no draft rewrites them. */
export const BACKUP_NOTE_TEXT =
  'With your permission, the assistant may create, change, or delete files on your device. Create backups for anything you cannot replace.';

/** The tools that create or change a file, on both runtimes (native Edit/Write
 *  share Claude Code's names; MultiEdit and NotebookEdit are Claude Code's). */
export const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// ── The one-time notice's memory and claim ───────────────────────────────────
//
// Seen once per install, like the first-time warnings (`youcoded-warned-<kind>`,
// localStorage, every access guarded — the WebView and remote browsers can
// refuse storage, and then the notice simply shows again: the safe direction).
//
// Only ONE card carries it at a time: the first file-change card to mount
// claims it, so a conversation with ten edits shows one notice, not ten. A
// tiny external store (rules: react-renderer / performance 3) — each card reads
// a boolean "is it mine", so a claim or a Got it redraws only the card involved.

const SEEN_KEY = 'youcoded-warned-file-changes';
let claimedBy: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function seen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

/** A file-change card asks to carry the notice; true when it now does. */
export function claimFileChangeNotice(id: string): boolean {
  if (claimedBy === id) return true;
  if (claimedBy !== null || seen()) return false;
  claimedBy = id;
  emit();
  return true;
}

/** The card unmounted (folded away, closed tab) — let the next one carry it. */
export function releaseFileChangeNotice(id: string): void {
  if (claimedBy !== id) return;
  claimedBy = null;
  emit();
}

/** Got it: never again on this install. */
export function acknowledgeFileChangeNotice(): void {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* shows again next time — safe */ }
  claimedBy = null;
  emit();
}

export function subscribeFileChangeNotice(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function fileChangeNoticeOwner(): string | null { return claimedBy; }

/** Tests only. */
export function resetFileChangeNotice(): void { claimedBy = null; emit(); }
