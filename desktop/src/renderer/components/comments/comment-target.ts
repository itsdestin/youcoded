import type { ArtifactRecord } from '../../../shared/artifacts/types';

/** Where a file's comments are kept: `path` + `projectRoot` for the comments
 *  store (doc-comments-store.ts `useDocComments`, and the `data-doc-path`
 *  a comment sent to chat names).
 *
 *  WHY (card #207): a file outside the chat's project is an `external` record
 *  whose `path` is only its file name (filepath-match.ts `buildArtifactifyArgs`).
 *  Passing that name with the chat's project filed its comments under the
 *  project as if the file sat at its top — two outside files with the same name
 *  shared one set of comments, and the assistant, told only the name, could not
 *  find them. An outside file's comments now go by its real location with no
 *  project (the per-machine store main keeps by file location), which is also
 *  where the assistant's comment tools look once the person allows it. */
export function commentTargetFor(
  artifact: Pick<ArtifactRecord, 'kind' | 'path' | 'absolutePath'>,
  projectRoot: string | undefined,
): { path: string; projectRoot: string | undefined } {
  return artifact.kind === 'external' && artifact.absolutePath
    ? { path: artifact.absolutePath, projectRoot: undefined }
    : { path: artifact.path, projectRoot };
}
