// Draft stash — the SAFETY NET under the D3 unsaved-changes guards.
//
// The guards (useUnsavedGuard + dirty-editor-guard) prompt on the navigations
// that MEAN "I'm leaving this file": selecting another file, closing the
// panel, switching sessions. But the editor lives inside the drawer, and many
// layout changes unmount the drawer wholesale WITHOUT any of those meanings —
// the games panel, the chat↔terminal toggle, Project View, a filepath-pill
// click, and whatever gets added next. Enumerating them is a losing game
// (three were found in one review pass), so instead of guarding every
// trigger, an unmount-while-dirty stashes the draft here and the next mount
// of the same file restores it — edit mode, content, and concurrency token
// intact. Unknown discard paths degrade to "draft survives", never data loss.
//
// Renderer-module state, per window. Cleared on save / cancel / discard /
// use-disk-version — the stash only ever holds drafts the user has neither
// kept nor thrown away.
//
// WHY each parked draft holds an unsaved mark (Task 6 fix rounds 10–13): a parked draft is
// unsaved work with no editor on screen — nothing vetoes a quit or the window's close for it, so
// it was lost without a word. Its mark lists it in the refused-quit prompt (with Save), and
// it stays marked until the restored draft is back in an editor (settleDraft) — a restore that
// fails leaves the draft parked, never dropped.
import { canonicalize } from '../../../shared/artifacts/canonicalize';
import { holdUnsavedEditor } from '../../state/unsaved-editors';

export interface StashedDraft {
  draft: string;
  /** The optimistic-concurrency token captured when editing began — restoring
   * it means a save after restore still conflicts if the disk moved. */
  mtimeMs: number | null;
  /** The file's name (no folder), for the refused-quit prompt. */
  name?: string;
  /** Whether the file could still take the draft (the editor's own edit rules). */
  available?: () => Promise<import('../../state/unsaved-editors').DraftFileStatus>;
  /** Save the draft to its file from the refused-quit prompt. */
  save?: (o?: import('../../state/unsaved-editors').ParkedSaveOptions) => Promise<import('../../state/unsaved-editors').ParkedSaveResult>;
}

interface Parked { entry: StashedDraft; taken: boolean; release: () => void }
const stash = new Map<string, Parked>();

export function draftKey(projectRoot: string, artifactId: string): string {
  return canonicalize(projectRoot, null) + '|' + artifactId;
}

export function stashDraft(key: string, entry: StashedDraft): void {
  const had = stash.get(key);
  if (had) { had.entry = entry; had.taken = false; return; }
  const release = holdUnsavedEditor({
    name: entry.name ?? 'A file',
    parked: {
      available: () => stash.get(key)?.entry.available?.() ?? Promise.resolve('gone' as const),
      save: (o) => stash.get(key)?.entry.save?.(o) ?? Promise.resolve({ error: "YouCoded couldn't save this file." }),
    },
    discard: () => clearDraft(key),
  });
  stash.set(key, { entry, taken: false, release });
}

/** Hand the parked draft to the editor that opened its file. It stays parked (and marked)
 *  until settleDraft says whether it was applied; a second consumer meanwhile gets nothing. */
export function takeDraft(key: string): StashedDraft | undefined {
  const p = stash.get(key);
  if (!p || p.taken) return undefined;
  p.taken = true;
  return p.entry;
}

/** The editor applied the taken draft (drop it) — or could not (keep it parked). */
export function settleDraft(key: string, applied: boolean): void {
  const p = stash.get(key);
  if (!p || !p.taken) return;
  if (!applied) { p.taken = false; return; }
  stash.delete(key);
  p.release();
}

export function clearDraft(key: string): void {
  const p = stash.get(key);
  stash.delete(key);
  p?.release();
}
