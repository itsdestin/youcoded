import { EDIT_MAX_BYTES, editTier, type EditTier } from '../../../shared/artifacts/editable-path-policy';
import { canonicalize } from '../../../shared/artifacts/canonicalize';
import type { ArtifactRecord } from '../../../shared/artifacts/types';
import { rendersFromBytesOnly } from './RendererRegistry';
import { describeReadError } from './read-error-copy';
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
 * Whether a parked draft's file could take the draft RIGHT NOW (Task 6 fix rounds 12–14): the
 * same rules the editor applies — it exists, it is text (not a file drawn from its bytes, not
 * binary), it is within the size limit, and the write policy allows it. Only "not there" or "not
 * editable" is 'gone'; a read that failed for another reason says why (the prompt offers Retry),
 * so a passing hiccup never reads as "no longer available".
 */
/** What a parked draft's row says when checking its file failed for a reason we don't know. */
export const DRAFT_READ_FAILED = "YouCoded couldn't read this file.";

export async function draftFileStatus(projectRoot: string, artifact: ArtifactRecord): Promise<'editable' | 'gone' | 'protected' | { error: string }> {
  if (rendersFromBytesOnly(artifact.path)) return 'gone';
  let res: any;
  try { res = await (window.claude as any)?.artifacts?.get(projectRoot, artifact.id); } catch (e) {
    // WHY general (final review, finding 5): the request itself failed, so its message is an IPC
    // or bridge error — a raw string that can name folders and asserts nothing a person can act
    // on. The detail goes to the log; the row offers Retry.
    console.error('[draftFileStatus] reading the file failed', e);
    return { error: DRAFT_READ_FAILED };
  }
  if (res && res.ok === true && res.orphan) return 'gone';
  // A protected location can't take the draft whatever happens next (fix round 15).
  if (res?.error === 'protected-path') return 'protected';
  if (!res || res.ok !== true) return { error: describeReadError(res?.error, res?.code) };
  const absolutePath = typeof res.resolvedPath === 'string' ? res.resolvedPath : artifact.kind === 'internal'
    ? `${projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${artifact.path.replace(/\\/g, '/')}`
    : (artifact.absolutePath ?? artifact.path);
  const info = { binary: res.binary, truncated: res.truncated, sizeBytes: res.sizeBytes };
  return canEditArtifact(info, typeof res.content === 'string' ? res.content : null, editTier(canonicalize(absolutePath, null))) ? 'editable' : 'gone';
}
