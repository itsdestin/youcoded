import { EDIT_MAX_BYTES, type EditTier } from '../../../shared/artifacts/editable-path-policy';
import type { ArtifactContentInfo } from './ActiveArtifactView';

/**
 * The ONE answer to "may this artifact be edited?" — used by the pencil
 * affordance, by entering edit mode, by restoring a stashed draft, and by the
 * save call itself.
 *
 * Editability is derived from the file's SIZE, not from a separate "this is only
 * a prefix" flag. Why it matters: above EDIT_MAX_BYTES the pane holds only the
 * first 2 MB of the file, so saving would write that prefix over the whole 8 MB
 * original — silent, unrecoverable data loss. A boolean flag for that condition
 * can go stale (the on-disk watcher can swap the text underneath the pane), and
 * it goes stale in the dangerous direction: a file that GREW past the cap while
 * open would still look editable. `sizeBytes` rides every artifacts:get
 * response, so this predicate cannot disagree with itself.
 *
 * Main cannot detect truncation on its own — a file legitimately shrinks when
 * you delete text — so this is honestly a renderer-side guarantee, which is why
 * it is enforced at all four call sites rather than trusted once.
 */
export function canEditArtifact(
  info: ArtifactContentInfo | null | undefined,
  content: string | null,
  tier: EditTier,
): boolean {
  // content === null is the loading transient, an orphan, or a binary file —
  // nothing valid to save in any of those cases.
  // notUtf8: the file is text in an older encoding, so what the pane holds is
  // already lossy — every byte the UTF-8 decoder could not read became U+FFFD.
  // Saving would write those replacements over the originals for good, so the
  // file is show-only (2026-09-11). Main refuses it too; this only hides Edit.
  if (content === null || tier === 'denied' || info?.binary || info?.notUtf8) return false;
  // Unknown size (legacy callers, workbench fixtures) keeps today's behaviour.
  return (info?.sizeBytes ?? 0) <= EDIT_MAX_BYTES;
}
