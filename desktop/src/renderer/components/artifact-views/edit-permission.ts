import { EDIT_MAX_BYTES, editTier, type EditTier } from '../../../shared/artifacts/editable-path-policy';
import { canonicalize } from '../../../shared/artifacts/canonicalize';
import type { ArtifactRecord } from '../../../shared/artifacts/types';
import { rendersFromBytesOnly } from './RendererRegistry';
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
  if (content === null || tier === 'denied' || info?.binary) return false;
  // Unknown size (legacy callers, workbench fixtures) keeps today's behaviour.
  return (info?.sizeBytes ?? 0) <= EDIT_MAX_BYTES;
}

/**
 * Whether a parked draft's file could take the draft back RIGHT NOW (Task 6 fix round 12): the
 * same rules the editor applies when it restores one — it exists, it is text (not a file drawn
 * from its bytes, not binary), it is within the size limit, and the write policy allows it.
 * "Readable" was not enough: the prompt offered "Open it" for a file the editor would then refuse
 * to put back into edit mode.
 */
export async function draftFileEditable(projectRoot: string, artifact: ArtifactRecord): Promise<boolean> {
  if (rendersFromBytesOnly(artifact.path)) return false;
  let res: any;
  try { res = await (window.claude as any)?.artifacts?.get(projectRoot, artifact.id); } catch { return false; }
  if (!res || res.ok !== true || res.orphan) return false;
  const absolutePath = typeof res.resolvedPath === 'string' ? res.resolvedPath : artifact.kind === 'internal'
    ? `${projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${artifact.path.replace(/\\/g, '/')}`
    : (artifact.absolutePath ?? artifact.path);
  const info = { binary: res.binary, truncated: res.truncated, sizeBytes: res.sizeBytes };
  return canEditArtifact(info, typeof res.content === 'string' ? res.content : null, editTier(canonicalize(absolutePath, null)));
}
