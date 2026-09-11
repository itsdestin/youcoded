// useArtifactContent — the single owner of the artifacts:get read lifecycle.
// Extracted from SessionDrawer + FilesTab's ArtifactDetail, which carried two
// near-identical copies of this effect and BOTH threw away the response's
// `orphan` flag and error branch — so "still loading", "file deleted", and
// "read failed" all collapsed into content === null, and every artifact open
// flashed "This file is no longer on disk." for the read's duration.
// This hook keeps them apart via ArtifactContentState (see ActiveArtifactView).
import { useCallback, useEffect, useState } from 'react';
import type { ArtifactContentInfo, ArtifactContentState } from './ActiveArtifactView';
import { rendersFromBytesOnly } from './RendererRegistry';

// Turn the handler's error codes into specific, accurate user-facing strings —
// unknown codes surface verbatim rather than being replaced with a guessed
// cause (error-message-standards).
function describeReadError(error: unknown): string {
  if (error === 'protected-path') {
    return 'This file is in a protected location (credential and system folders), so YouCoded won’t open it.';
  }
  if (error === 'artifact-not-found') {
    return 'This file could not be resolved inside the project.';
  }
  return `Couldn’t read this file: ${String(error ?? 'unknown error')}`;
}

export interface UseArtifactContentResult {
  content: string | null;
  /** Hosts pass this straight through as onContentChange — saves and
   * external-change refetches update content without re-running the read.
   * Delivering real content also reconciles the phase (missing/error →
   * ready), so a file that reappears on disk recovers without a reselect. */
  setContent: (content: string | null) => void;
  contentInfo: ArtifactContentInfo | null;
  contentState: ArtifactContentState;
  /** Re-runs the read after an error — wired to ErrorState's Retry. */
  retryRead: () => void;
  /** Deliver a WHOLE artifacts:get response — text AND the facts about the text
   * in one call. Prefer this over setContent for anything that came off disk. */
  applyDiskRead: (res: any) => void;
}

export function useArtifactContent(
  projectRoot: string,
  artifactId: string | null | undefined,
  // The file's path — needed to answer "does this file's viewer read its own
  // bytes?" BEFORE we ask for text. Optional so older callers keep working.
  artifactPath?: string | null,
): UseArtifactContentResult {
  const [content, setContent] = useState<string | null>(null);
  // get() metadata the content string cannot carry: binary sniff (routes
  // unknown extensions to the code view), truncated (renders the partial-view
  // banner), sizeBytes (the file's REAL size, which `content` cannot report once
  // it is only a prefix).
  const [contentInfo, setContentInfo] = useState<ArtifactContentInfo | null>(null);
  const [contentState, setContentState] = useState<ArtifactContentState>({ phase: 'loading' });
  // Bumping the token re-runs the effect below — the Retry action.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    // No selection: park in loading (nothing renders the pane in this state).
    if (!artifactId) {
      setContent(null);
      setContentInfo(null);
      setContentState({ phase: 'loading' });
      return;
    }
    // Images/PDFs/Office docs render through BinaryContent -> artifacts:read-binary,
    // which has its OWN 50 MB ceiling. Asking artifacts:get for their text was
    // pure waste AND applied the text editor's 2 MB cap to them -- the reported
    // bug (spec 2026-08-25 §4.1). Settle straight into the exact shape an
    // under-cap binary read already produces, so every consumer downstream is
    // unchanged: no new content phase, and binary:true still holds the edit
    // affordance shut.
    if (artifactPath && rendersFromBytesOnly(artifactPath)) {
      setContent(null);
      setContentInfo({ binary: true });
      setContentState({ phase: 'ready' });
      return;
    }
    let cancelled = false;
    // Clear the PREVIOUS file's content before the read resolves. Without
    // this, switching artifacts remounts the viewer (ViewerErrorBoundary is
    // keyed by artifact.id) with stale content, so HtmlView's sandboxed iframe
    // gets a srcDoc write for the old file and a second one milliseconds later
    // for the new one — the aborted-then-restarted navigation leaves the frame
    // permanently blank.
    setContent(null);
    setContentInfo(null);
    setContentState({ phase: 'loading' });
    (window.claude as any).artifacts.get(projectRoot, artifactId).then((res: any) => {
      if (cancelled) return;
      if (res && res.ok) {
        setContent(res.content ?? null);
        setContentInfo({ binary: res.binary, truncated: res.truncated, sizeBytes: res.sizeBytes, notUtf8: res.notUtf8 });
        // orphan:true is the handler's genuine not-found signal (ENOENT /
        // orphaned record) — the ONLY thing allowed to render "no longer on
        // disk". Everything else that resolved ok is ready.
        setContentState(res.orphan ? { phase: 'missing' } : { phase: 'ready' });
      } else {
        setContentState({ phase: 'error', message: describeReadError(res?.error) });
      }
    }).catch((e: any) => {
      // A rejected invoke (e.g. EACCES thrown in the handler) is a read
      // FAILURE, not a deleted file — surface the real error.
      if (!cancelled) {
        setContentState({ phase: 'error', message: describeReadError(e?.message ?? e) });
      }
    });
    return () => { cancelled = true; };
  }, [projectRoot, artifactId, artifactPath, retryToken]);

  const retryRead = useCallback(() => setRetryToken((t) => t + 1), []);

  // Reconcile phase with out-of-band content deliveries (PR #303 review fix):
  // ActiveArtifactView's onChanged watcher effect refetches on external writes
  // and hands the bytes back via onContentChange WITHOUT re-running this
  // hook's read — so a file that was 'missing' and then reappears on disk
  // (agent recreates it → watcher 'add' → refetch) would keep showing "no
  // longer on disk" until reselect. Real content arriving through any path
  // means the file is readable NOW: flip missing/error to ready.
  // A null delivery deliberately flips NOTHING: no caller signals "file is
  // gone" via onContentChange (deletion is only ever detected by the get()
  // orphan response), so treating null as missing here would guess a cause.
  const reconciledSetContent = useCallback((next: string | null) => {
    setContent(next);
    if (next !== null) {
      setContentState((prev) =>
        prev.phase === 'missing' || prev.phase === 'error' ? { phase: 'ready' } : prev);
    }
  }, []);

  // Content and its metadata, always together. Callers used to hand back only
  // `res.content`, leaving contentInfo frozen at whatever the FIRST read said —
  // so a file that grew past the cap while open kept its Edit button, and saving
  // would have written the prefix over the whole file (spec §4.4). Editability
  // is derived from sizeBytes, so a stale size is a data-loss bug, not cosmetics.
  const applyDiskRead = useCallback((res: any) => {
    if (!res || !res.ok || res.orphan) return;
    setContent(res.content ?? null);
    setContentInfo({ binary: res.binary, truncated: res.truncated, sizeBytes: res.sizeBytes, notUtf8: res.notUtf8 });
    setContentState({ phase: 'ready' });
  }, []);

  return { content, setContent: reconciledSetContent, contentInfo, contentState, retryRead, applyDiskRead };
}
