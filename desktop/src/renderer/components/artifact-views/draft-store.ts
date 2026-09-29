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
import { canonicalize } from '../../../shared/artifacts/canonicalize';
import { holdUnsavedEditor } from '../../state/unsaved-editors';

export interface StashedDraft {
  draft: string;
  /** The optimistic-concurrency token captured when editing began — restoring
   * it means a save after restore still conflicts if the disk moved. */
  mtimeMs: number | null;
}

const stash = new Map<string, StashedDraft>();
// WHY (Task 6 fix round 10): a stashed draft is unsaved work with no editor on screen — nothing
// vetoes the window's unload for it, so a quit dropped it without a word. While the stash holds
// anything, it holds the same "unsaved editor" mark a dirty editor does, so a quit asks first.
let release: (() => void) | null = null;
function markWhileStashed(): void {
  if (stash.size > 0 && !release) release = holdUnsavedEditor();
  else if (stash.size === 0 && release) { release(); release = null; }
}

export function draftKey(projectRoot: string, artifactId: string): string {
  return canonicalize(projectRoot, null) + '|' + artifactId;
}

export function stashDraft(key: string, entry: StashedDraft): void {
  stash.set(key, entry);
  markWhileStashed();
}

/** Read-and-remove: restoration consumes the entry (the live editor owns the
 * draft again; a second consumer must not resurrect a stale copy). */
export function takeDraft(key: string): StashedDraft | undefined {
  const entry = stash.get(key);
  stash.delete(key);
  markWhileStashed();
  return entry;
}

export function clearDraft(key: string): void {
  stash.delete(key);
  markWhileStashed();
}
