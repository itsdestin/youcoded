// ActiveArtifactView — shared component for viewing and editing a single artifact.
// Extracted from SessionDrawer.tsx (Task 7.2) so both SessionDrawer and ProjectView
// can use it identically without duplicating the edit state + conflict-detection logic.
import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle, Suspense } from 'react';
import { getViewer, getEditViewer, rendersFromBytesOnly, isTextContentViewer } from './RendererRegistry';
import { PartialFileBanner } from './PartialFileBanner';
import { canEditArtifact } from './edit-permission';
import { ViewerErrorBoundary } from './ViewerErrorBoundary';
import type { ArtifactRecord } from '../../../shared/artifacts/types';
import { editTier, EDIT_MAX_BYTES } from '../../../shared/artifacts/editable-path-policy';
import { canonicalize } from '../../../shared/artifacts/canonicalize';
import { UnifiedDiff } from '../diff/UnifiedDiff';
import { LoadingState, ErrorState } from '../ui/states';
import { RemoteFileCard } from './RemoteFileCard';
import { isRemoteMode } from '../../platform';

/** Absolute on-disk path of an artifact — the same join SessionDrawer and
 *  FilesTab make for Copy path, so Download asks the host for the same file. */
function absoluteArtifactPath(projectRoot: string, a: ArtifactRecord): string {
  return a.kind === 'internal'
    ? `${projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${a.path.replace(/\\/g, '/')}`
    : (a.absolutePath ?? a.path);
}
import { openEditorSearch, revealLineIn } from './cm/editor-registry';
import { draftKey, stashDraft, takeDraft, clearDraft } from './draft-store';

// Confirm-tier wording (D5): name the actual consequence, per path family.
// Never a vague "are you sure" — the user should know what the file DOES.
function confirmMessage(canonPath: string): string {
  const base = canonPath.split('/').pop() ?? canonPath;
  if (base === '.envrc') {
    return 'direnv runs this file as shell commands when you enter the folder.\n\nEdit it anyway?';
  }
  if (base === '.env' || base.startsWith('.env.')) {
    return 'This file usually contains secrets like API keys and passwords.\n\nEdit it anyway?';
  }
  return 'This file configures Claude — settings and hooks here can run commands on your machine.\n\nEdit it anyway?';
}

// Surface the REAL save failure (error-message-standards): specific when we
// know the cause, the raw error string when we do not — never a guessed cause.
function saveErrorMessage(res: any): string {
  const err = res?.error;
  if (err === 'protected-path') {
    return 'This file is protected and cannot be edited in YouCoded — paths under .git, .youcoded, and credential folders can change what runs on your machine.';
  }
  if (err === 'needs-confirm') {
    return 'Editing this file needs an explicit confirmation. Leave and re-enter edit mode to confirm.';
  }
  return `Save failed: ${String(err ?? 'unknown error')}`;
}

// Imperative handle so an external chrome (the SessionDrawer header toolbar) can
// drive edit mode while ActiveArtifactView keeps owning the edit/save/conflict
// logic. Paired with onEditStateChange so the header re-renders on state change.
export interface ActiveArtifactHandle {
  isEditable: boolean;
  editing: boolean;
  /** True when edit mode holds changes not yet on disk — hosts must gate
   * selection/close behind the unsaved-changes prompt when set (D3). */
  dirty: boolean;
  startEdit(): void;
  /** Resolves true when the save landed — false means the pane is showing a
   * conflict or error and the caller should NOT proceed with navigation. */
  saveEdit(): Promise<boolean>;
  cancelEdit(): void;
  /** Route find-in-document into the CodeMirror search panel when the active
   * viewer is CM6 (its DOM is virtualized — ContentFindBar would silently
   * miss off-viewport matches). Returns true when handled. */
  openFind(): boolean;
  /** Scroll the code editor to a 1-indexed line (search jump-to-hit).
   * Retries briefly — the lazy CM6 chunk may still be mounting when a search
   * result opens a file. No-op for non-code viewers. */
  revealLine(line: number): void;
}

/** Metadata from the artifacts:get response that content alone cannot carry —
 * hosts thread it through so the pane can route binary files and render the
 * too-large notice instead of a blank viewer. */
export interface ArtifactContentInfo {
  binary?: boolean;
  /** The content is only the first EDIT_MAX_BYTES of a larger file — drives the
   *  partial-view banner. Does NOT gate saving; size does (Stage 2B). */
  truncated?: boolean;
  sizeBytes?: number;
}

/** Read-lifecycle state for the active artifact's content. Fix for the
 * "no longer on disk" flash: `content === null` used to be ONE signal meaning
 * both "the read hasn't resolved yet" and "the file is gone", so every open
 * flashed the alarming missing-file message for the read's duration. The
 * phases keep those apart — and keep read ERRORS (protected path, permission
 * failure) from masquerading as a deleted file, which would be a guessed
 * cause in a user-facing string (error-message-standards).
 *  - loading: artifacts:get is in flight — render a quiet placeholder
 *  - ready:   the read resolved (content may still be null for binary files)
 *  - missing: the read genuinely returned orphan:true — the file is gone
 *  - error:   the read failed — surface the REAL error, never "gone" */
export type ArtifactContentState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'missing' }
  // `code` is the handler's own error code (e.g. 'too-large') and `sizeBytes`
  // rides with it: over remote access a too-large answer carries the file's real
  // size so the phone can show "24.0 MB · PDF" with a Download button rather
  // than a bare error (RemoteFileCard).
  | { phase: 'error'; message: string; code?: string; sizeBytes?: number };

export interface ActiveArtifactViewProps {
  artifact: ArtifactRecord;
  content: string | null;
  contentInfo?: ArtifactContentInfo | null;
  /** Where the content read stands (see ArtifactContentState). Omitted =
   * legacy behavior: null content is treated as missing. Both real hosts
   * (SessionDrawer, FilesTab) pass it via useArtifactContent. */
  contentState?: ArtifactContentState;
  /** Re-runs the failed read — wired to the error state's Retry button. */
  onRetryRead?: () => void;
  /** Hand a WHOLE artifacts:get response back to the host so the text and the
   *  facts about the text (size, truncation) update together. Without this a
   *  refetch can leave metadata frozen at whatever the first read said. */
  onDiskRead?: (res: any) => void;
  projectRoot: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  onContentChange: (content: string | null) => void;
  // When true, the viewer hides its own Edit/Save/Cancel buttons — the host
  // (SessionDrawer) renders them in its header instead. ProjectView omits this.
  controlsInHeader?: boolean;
  // Fires whenever editability / edit-mode changes so the host header can update.
  onEditStateChange?: (s: { isEditable: boolean; editing: boolean }) => void;
  /** Host's Ctrl+F bar is open — forwarded so a viewer can move its own floating
   *  controls out from under it. */
  findBarOpen?: boolean;
}

export const ActiveArtifactView = forwardRef<ActiveArtifactHandle, ActiveArtifactViewProps>(function ActiveArtifactView({
  artifact, content, contentInfo, contentState, onRetryRead, projectRoot, projectId, projectName, sessionId, onContentChange, onDiskRead,
  controlsInHeader = false, onEditStateChange, findBarOpen = false,
}, ref) {
  // Legacy default: a caller that doesn't thread contentState keeps the OLD
  // semantics (null content = missing) rather than silently losing the
  // missing-file notice. Both shipped hosts pass the real state.
  const readState: ArtifactContentState = contentState
    ?? (content === null ? { phase: 'missing' } : { phase: 'ready' });
  // Resolve the absolute path depending on artifact kind. Forward slashes
  // throughout — a backslash projectRoot + '/' + relative path yields a mixed-
  // separator string that looks broken in copy-path/reveal on Windows.
  const absolutePath = artifact.kind === 'internal'
    ? `${projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${artifact.path.replace(/\\/g, '/')}`
    : (artifact.absolutePath ?? artifact.path);

  // Renderer MIRROR of the D5 write policy — main enforces the real boundary
  // in artifacts:save; this only hides the Edit affordance so the UI never
  // offers an action main would refuse. (Main resolves symlinks first, so a
  // mirror miss here fails safe: the save is still rejected.)
  const tier = editTier(canonicalize(absolutePath, null));
  // D4: ANY text file is editable — the old md/markdown/txt allowlist is gone.
  // The four conditions (resolved content, policy, binary sniff, SIZE) live in
  // one predicate so the affordance, entering edit mode, restoring a stashed
  // draft, and the save call cannot disagree — see edit-permission.ts.
  const isEditable = canEditArtifact(contentInfo, content, tier);

  // ── Task 6.4: controlled edit state (lifted from MarkdownView) ──
  // Owning edit state here lets the conflict banner read/reset it without
  // requiring a refactor of each individual viewer component.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content ?? '');
  // conflict.disk holds the on-disk version when a concurrent write is detected
  const [conflict, setConflict] = useState<{ disk: string } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  // Surfaced save failures — replaces the old console-only error path (§2.4).
  const [saveError, setSaveError] = useState<string | null>(null);
  // Optimistic-concurrency token from artifacts:get, round-tripped into save as
  // baseMtimeMs so a save over a changed file is rejected instead of silently
  // clobbering it (spec §12.9). null = no token yet → save runs unguarded.
  const mtimeRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Mirrors for the unmount stash below — cleanup closures must read the
  // CURRENT values, not the ones captured when the effect last ran.
  // contentInfo rides along so the first-mount draft restore can ask the same
  // editability question as every other entry point (edit-permission.ts).
  const stateRef = useRef({ editing: false, draft: '', content: null as string | null,
                            contentInfo: null as ArtifactContentInfo | null | undefined });
  stateRef.current = { editing, draft, content, contentInfo };
  // A stashed draft waiting for content to resolve before it re-enters edit
  // mode (restoring before the fetch lands would fight the draft-reset effect).
  const pendingRestoreRef = useRef<ReturnType<typeof takeDraft>>(undefined);
  const firstRunRef = useRef(true);

  // Reset draft when content reloads from disk (e.g. artifact selection changes)
  useEffect(() => {
    setDraft(content ?? '');
    setConflict(null);
    setShowDiff(false);
    // Draft-stash restoration (draft-store.ts): an unguarded unmount (games
    // panel, view toggle, Project View, pill click, …) stashed the dirty
    // draft; the file is open again, so hand it back — edit mode, draft, and
    // concurrency token — once real content has resolved.
    const pending = pendingRestoreRef.current;
    // A stashed draft must not re-enter edit mode on a file we could not save
    // (over the size cap, binary, policy-denied). Without this the unmount
    // stash is a way around the hidden Edit button.
    if (pending && content !== null && canEditArtifact(contentInfo, content, tier)) {
      pendingRestoreRef.current = undefined;
      setDraft(pending.draft);
      mtimeRef.current = pending.mtimeMs;
      setEditing(true);
    }
  }, [content, artifact.id]);

  // Fix: leave edit mode when the user switches to a DIFFERENT file. Edit mode
  // used to survive the switch (only the draft reset), so file B opened in the
  // editor holding whatever draft state file A left behind. Now that the host
  // nulls content before re-reading, a save clicked during that gap would write
  // an empty draft over the file — exiting edit mode closes that window.
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
    mtimeRef.current = null; // token belongs to the previous file
    const key = draftKey(projectRoot, artifact.id);
    pendingRestoreRef.current = takeDraft(key);
    // On the FIRST mount content may already be resolved (host kept it warm),
    // in which case the content effect above has already run this commit and
    // will not run again — restore immediately. On artifact SWITCHES content
    // is about to be nulled + refetched by the host, so restoring now would
    // apply the draft against the previous file's stale content; the content
    // effect picks the pending entry up when the right bytes land.
    if (firstRunRef.current) {
      firstRunRef.current = false;
      const pending = pendingRestoreRef.current;
      if (pending && stateRef.current.content !== null
          && canEditArtifact(stateRef.current.contentInfo, stateRef.current.content, tier)) {
        pendingRestoreRef.current = undefined;
        setDraft(pending.draft);
        mtimeRef.current = pending.mtimeMs;
        setEditing(true);
      }
    }
    return () => {
      // THE SAFETY NET: unmounting (or switching away) while dirty stashes
      // the draft instead of discarding it. Guarded paths never reach here
      // dirty — Discard runs cancelEdit first; unguarded paths (any layout
      // change that unmounts the drawer) degrade to draft-survives.
      const cur = stateRef.current;
      if (cur.editing && cur.content !== null && cur.draft !== cur.content) {
        stashDraft(key, { draft: cur.draft, mtimeMs: mtimeRef.current });
      }
    };
  }, [artifact.id, projectRoot]);

  // ── React to on-disk changes (external writes, saves from other windows) ──
  // Runs regardless of edit mode — the old version gated on `editing` AND
  // filtered on by === 'agent', which nothing ever emitted, so the banner was
  // unreachable dead code and read mode always showed stale content (spec §2.1).
  // Now: clean viewer → silently refetch; dirty editor → raise the conflict
  // banner with the disk version. `by` is deliberately ignored: a 'user' save
  // from another window needs exactly the same handling as an 'external' write.
  const dirty = editing && content !== null && draft !== content;
  useEffect(() => {
    // artifacts.onChanged is optional — gracefully skip if IPC not wired yet
    const unsubFn = (window.claude as any).artifacts?.onChanged?.((evt: any) => {
      if (evt.projectRoot !== projectRoot || evt.artifactId !== artifact.id) return;
      if (evt.kind === 'remove') return; // orphan handling is the host's concern
      // These files render from their own bytes, never from `content`. Asking
      // artifacts:get here would re-open the text path we just closed -- and its
      // `res.content ?? ''` would set an IMAGE's content to the empty string,
      // which downstream reads as an ordinary editable text file (spec §4.1).
      if (rendersFromBytesOnly(artifact.path)) return;
      (window.claude as any).artifacts.get(projectRoot, artifact.id).then((res: any) => {
        if (!res || !res.ok || res.orphan) return;
        if (typeof res.mtimeMs === 'number') mtimeRef.current = res.mtimeMs;
        // Metadata ALWAYS travels with the read, even when the visible text is
        // unchanged and even mid-conflict — an append past the cap leaves the
        // prefix byte-identical while the file's size, and therefore whether it
        // may be saved at all, has changed underneath the pane.
        if (onDiskRead) onDiskRead(res);
        const disk = res.content ?? '';
        if (dirty) {
          if (disk !== draft) setConflict({ disk });
        } else if (!onDiskRead && disk !== content) {
          // Legacy host with no onDiskRead: text only, metadata stays stale.
          onContentChange(disk);
        }
      });
    });
    return typeof unsubFn === 'function' ? unsubFn : undefined;
  }, [artifact.id, projectRoot, artifact.path, dirty, draft, content, onContentChange, onDiskRead]);

  // ── Edit lifecycle callbacks (passed down to MarkdownView as controlled props) ──
  const handleStartEdit = useCallback(() => {
    // Confirm-tier paths get one deliberate click BEFORE editing starts, not a
    // surprise refusal at save time (D5 — mistake-prevention, not security; the
    // hard boundary is main's).
    // Belt and braces: the Edit button is already hidden for these, but a
    // keyboard path or a host ref must not open an editor on a file whose save
    // we would have to refuse.
    if (!canEditArtifact(contentInfo, content, tier)) return;
    if (tier === 'needs-confirm' && !window.confirm(confirmMessage(canonicalize(absolutePath, null)))) {
      return;
    }
    // Refresh from disk on entering edit mode: picks up staleness the watcher
    // may have missed AND captures the concurrency token the save round-trips.
    (window.claude as any).artifacts.get(projectRoot, artifact.id).then((res: any) => {
      if (!res || !res.ok || res.orphan) return;
      if (typeof res.mtimeMs === 'number') mtimeRef.current = res.mtimeMs;
      if (onDiskRead) onDiskRead(res);
      else if (typeof res.content === 'string' && res.content !== content) onContentChange(res.content);
      // The affordance was decided on the size we knew a moment ago. If THIS
      // read says the file is now only partly loaded, back straight out — the
      // editor would be holding a prefix and the save would truncate.
      if (res.truncated) setEditing(false);
    }).catch(() => { /* stale content + no token — save falls back to unguarded */ });
    setEditing(true);
    setConflict(null);
    setSaveError(null);
  }, [tier, absolutePath, projectRoot, artifact.id, content, contentInfo, onContentChange, onDiskRead]);

  // opts.force: skip the concurrency token — the deliberate "Keep mine"
  // overwrite. Shaped as an options object so accidental event-object args
  // (onClick={handleSave}) can never read as force=true.
  const handleSave = useCallback(async (opts?: { force?: boolean }): Promise<boolean> => {
    // The §2.2 empty-file guarantee: while content is null (the fetch
    // transient, an orphan, a binary file) there is NOTHING valid to save — a
    // write here would truncate the file to the placeholder draft. This is the
    // single highest-risk regression in the workstream; keep it hard-blocked.
    if (content === null) return false;
    // Saving a PREFIX would write 2 MB over the whole 8 MB file. Hard-blocked
    // here as well as at the affordance — main cannot detect truncation itself
    // (a shrinking file is legitimate), so this is a renderer-side guarantee.
    if (!canEditArtifact(contentInfo, content, tier)) {
      // Never a silent no-op: the button would otherwise do nothing at all.
      // Specific and accurate — this is the ONE reason this branch fires.
      setSaveError(`YouCoded is only showing part of this file (it is over ${(EDIT_MAX_BYTES / (1024 * 1024)).toFixed(1)} MB), so saving would overwrite the rest. Copy your changes out before closing.`);
      return false;
    }
    // WHY a save never goes out without a token (error inventory 2026-09-10, false
    // message 11): the token normally comes from startEdit's read, and if that read
    // failed or had not landed, the save sent no baseMtimeMs — and main's
    // write-authorization skips the "changed on disk" check when none arrives. Another
    // writer's newer version was silently overwritten behind a normal, successful save.
    // So with no token, read the file NOW and let what is on disk decide:
    //   · same text the editor loaded → nobody changed it; save guarded by THIS read's token.
    //   · different text              → it did change; raise the conflict banner, write nothing.
    //   · no longer there (orphan)    → there is no newer version to lose; save as before.
    //   · unreadable                  → the check cannot be made; refuse, and say so.
    // "Keep mine" (opts.force) skips all of this on purpose: it means overwrite.
    if (!opts?.force && mtimeRef.current === null) {
      let disk: any = null;
      try { disk = await (window.claude as any).artifacts.get(projectRoot, artifact.id); } catch { disk = null; }
      if (!(disk && disk.ok && disk.orphan)) {
        if (!disk || !disk.ok || typeof disk.mtimeMs !== 'number') {
          setSaveError("YouCoded couldn't check whether this file changed since you opened it, so nothing was saved. Try saving again.");
          return false;
        }
        mtimeRef.current = disk.mtimeMs;
        if ((disk.content ?? '') !== content) {
          setConflict({ disk: disk.content ?? '' });
          return false;
        }
      }
    }
    const saveOpts: { baseMtimeMs?: number; confirmed?: boolean } = {};
    if (!opts?.force && mtimeRef.current !== null) saveOpts.baseMtimeMs = mtimeRef.current;
    if (tier === 'needs-confirm') saveOpts.confirmed = true; // dialog shown at startEdit
    const res = await (window.claude as any).artifacts.save(
      projectRoot, projectId, projectName, artifact.id, draft, sessionId, saveOpts
    );
    if (res && res.ok) {
      if (typeof res.mtimeMs === 'number') mtimeRef.current = res.mtimeMs;
      clearDraft(draftKey(projectRoot, artifact.id));
      // After a successful save the file IS the draft: definitively whole, not
      // a prefix, and exactly this many bytes. Hand back the facts, not just
      // the text, so the next editability check is right.
      if (onDiskRead) {
        onDiskRead({ ok: true, content: draft, binary: false, truncated: false,
                     sizeBytes: new TextEncoder().encode(draft).length, mtimeMs: res.mtimeMs });
      } else {
        onContentChange(draft);
      }
      setEditing(false);
      setConflict(null);
      setSaveError(null);
      return true;
    }
    if (res && res.error === 'conflict') {
      // Disk moved under the token — surface the conflict UI instead of
      // silently clobbering whatever was written (spec §12.9).
      const disk = await (window.claude as any).artifacts.get(projectRoot, artifact.id);
      if (disk && disk.ok && !disk.orphan) {
        if (typeof disk.mtimeMs === 'number') mtimeRef.current = disk.mtimeMs;
        setConflict({ disk: disk.content ?? '' });
      } else {
        setSaveError('Save failed: the file changed on disk and could not be re-read.');
      }
      return false;
    }
    setSaveError(saveErrorMessage(res));
    return false;
  }, [projectRoot, projectId, projectName, artifact.id, draft, sessionId, onContentChange, onDiskRead, tier, content, contentInfo]);

  const handleCancel = useCallback(() => {
    clearDraft(draftKey(projectRoot, artifact.id));
    setDraft(content ?? '');
    setEditing(false);
    setConflict(null);
    setSaveError(null);
  }, [content, projectRoot, artifact.id]);

  // ── Conflict resolution actions ──
  const resolveKeepMine = useCallback(() => {
    // Deliberate force-overwrite: "Keep mine" MEANS clobber what is on disk,
    // so the concurrency token is skipped by design.
    handleSave({ force: true });
  }, [handleSave]);

  const resolveUseDisk = useCallback(() => {
    if (!conflict) return;
    // Accept whatever is on disk: update UI content and exit edit mode. The
    // action says "disk", not "Claude" — a watcher cannot know WHO wrote the
    // file (git checkout, formatter, another editor), and naming Claude would
    // be a guessed cause in a user-facing string (spec §8.2).
    clearDraft(draftKey(projectRoot, artifact.id));
    setDraft(conflict.disk);
    setEditing(false);
    setConflict(null);
    // The conflict's `disk` string came from an artifacts:get and may ITSELF be
    // a prefix. Re-read so the pane ends up holding content and metadata that
    // agree — accepting a conflict must not be a way to end up with a prefix
    // that still looks whole.
    if (onDiskRead) {
      (window.claude as any).artifacts.get(projectRoot, artifact.id)
        .then((res: any) => onDiskRead(res))
        .catch(() => { /* keep the disk string already in hand */ });
    } else {
      onContentChange(conflict.disk);
    }
  }, [conflict, onContentChange, onDiskRead, projectRoot, artifact.id]);

  // "Load the whole file" on the partial-view banner. Re-asks WITHOUT the cap;
  // main still refuses above FULL_READ_MAX_BYTES, so this can never become an
  // unbounded read. Declared HERE with the other hooks — putting it lower would
  // place it after the loading/missing/error early returns, making it a
  // conditionally-called hook (React error + a lint failure).
  const loadFull = useCallback(() => {
    (window.claude as any).artifacts.get(projectRoot, artifact.id, { full: true })
      .then((res: any) => { if (onDiskRead) onDiskRead(res); });
  }, [projectRoot, artifact.id, onDiskRead]);

  // Expose edit control to the host header (SessionDrawer).
  useImperativeHandle(ref, () => ({
    isEditable,
    editing,
    dirty,
    startEdit: handleStartEdit,
    saveEdit: () => handleSave(),
    cancelEdit: handleCancel,
    openFind: () => openEditorSearch(rootRef.current),
    revealLine: (line: number) => {
      // Retry across a few frames: the editor is a lazy chunk and mounts in an
      // effect, so it may not be registered yet when the host calls this right
      // after opening the file.
      let attempts = 0;
      const tryReveal = () => {
        if (revealLineIn(rootRef.current, line)) return;
        if (attempts++ < 20) setTimeout(tryReveal, 50);
      };
      tryReveal();
    },
  }), [isEditable, editing, dirty, handleStartEdit, handleSave, handleCancel]);

  // Desktop app-quit / window-close guard while dirty (D3). Android never
  // fires beforeunload usefully — its back navigation goes through the
  // useEscClose stack in the hosts instead.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Notify the host whenever editability / edit-mode changes so its header
  // can swap the pencil ↔ save/cancel icons.
  useEffect(() => {
    onEditStateChange?.({ isEditable, editing });
  }, [isEditable, editing, onEditStateChange]);

  // The Registry returns a real component for every type (heavy viewers —
  // pdf/docx/xlsx — are React.lazy, so they're code-split but still rendered
  // here). The <Suspense> boundary below resolves the lazy chunk transparently.
  // Read mode routes by file type; EDIT mode always routes to an actual
  // editor component — most read viewers (HtmlView iframe, CsvView grid) have
  // no edit UI, so "Edit" on those files used to render nothing.
  const ViewerComponent = editing
    ? getEditViewer(artifact.path)
    : getViewer(artifact.path, {
        // Only assert text when a get response actually sniffed the bytes —
        // absent info keeps the registry's conservative extension routing.
        textHint: contentInfo ? contentInfo.binary === false : undefined,
        // Fix: a text extension whose bytes sniffed binary (.md with NUL
        // bytes) has content:null — its text viewer would render a blank
        // pane, so the registry reroutes it to BinaryFallback.
        binaryHint: contentInfo?.binary === true,
      });

  // Only text viewers render from `content`, so only they can be showing a
  // PREFIX. An over-cap .svg or .html takes the text path (SVG stays editable,
  // D5) but renders from its own bytes / a srcDoc — a banner there would
  // announce a partial view of something that is complete on screen.
  // A text-EXTENSION file whose bytes sniffed binary: the format is supported,
  // this file just isn't text. Told apart here (where the routing decision
  // lives) so the handoff can say which of the two it is.
  const sniffedBinaryTextFile = contentInfo?.binary === true
    && isTextContentViewer(getViewer(artifact.path));

  const showPartialBanner = !editing
    && contentInfo?.truncated === true
    && typeof contentInfo.sizeBytes === 'number'
    && isTextContentViewer(ViewerComponent);

  // ── Read-lifecycle gate (the "no longer on disk" flash fix) ──
  // Rendered HERE, once, instead of per-viewer null-content branches, so every
  // viewer (code, markdown, html, csv, …) gets the same honest treatment.
  // `!editing` keeps a live editor (and its draft) on screen no matter what —
  // in practice editing is exited on every artifact switch, so these states
  // only ever show read-mode. Mounting the viewer only after the read resolves
  // is safe: ViewerErrorBoundary is keyed by artifact.id, so a switch remounts
  // the viewer tree anyway.
  if (!editing && readState.phase === 'loading') {
    // Quiet placeholder, house LoadingState primitive (braille spinner) —
    // local reads resolve in milliseconds, so this is usually a single frame.
    return (
      <div className="h-full flex items-center justify-center">
        <LoadingState what="file" />
      </div>
    );
  }
  if (!editing && readState.phase === 'missing') {
    // ONLY shown when artifacts:get genuinely returned orphan:true.
    return <div className="text-fg-muted text-sm p-4">This file is no longer on disk.</div>;
  }
  if (!editing && readState.phase === 'error' && readState.code === 'too-large' && isRemoteMode()) {
    // A phone asked for a file over its preview ceiling. Not an error to retry —
    // the host answered honestly with the size — so the card offers Download
    // (questions deck 2026-09-10, Q-6/Q-8).
    return <RemoteFileCard path={absoluteArtifactPath(projectRoot, artifact)} sizeBytes={readState.sizeBytes} reason="too-large" projectRoot={projectRoot} artifactId={artifact.id} />;
  }
  if (!editing && readState.phase === 'error') {
    // The REAL failure with a Retry — never mapped to "no longer on disk"
    // (a permissions error is not a deleted file).
    return (
      <div className="p-4">
        <ErrorState message={readState.message} onRetry={onRetryRead ?? (() => {})} />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="h-full flex flex-col relative">
      {/* Conflict banner — shown when the file changes on disk while the user
          has UNSAVED edits. Three actions: keep draft, accept the disk version,
          or view a real unified diff (shared UnifiedDiff renderer). */}
      {conflict && (
        // Theme-independent amber (matches ContextEditorOverlay's blast-radius
        // banner — the house pattern for warnings). The previous `dark:` variants
        // followed the OS color scheme, NOT the active YouCoded theme (the app
        // themes via data-theme, not a .dark class), so the banner could render
        // light-mode colors under a dark theme.
        <div
          className="p-3 text-sm flex flex-wrap gap-x-3 gap-y-1 items-center border-b shrink-0"
          style={{ color: '#9a6a00', background: '#FFF6E5', borderColor: '#E8C170' }}
        >
          <span className="flex-1 min-w-0 font-medium">This file changed on disk while you were editing.</span>
          <button className="underline hover:no-underline whitespace-nowrap" onClick={resolveKeepMine}>
            Keep mine
          </button>
          <button className="underline hover:no-underline whitespace-nowrap" onClick={resolveUseDisk}>
            Use disk version
          </button>
          <button
            className="underline hover:no-underline whitespace-nowrap"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? 'Hide diff' : 'View diff'}
          </button>
        </div>
      )}
      {/* Save-failure banner — the real error, inline, dismissible. Replaces
          the old console-only failure path where a failed save looked identical
          to a successful one (§2.4). Theme-independent like the conflict banner. */}
      {saveError && (
        <div
          className="p-3 text-sm flex flex-wrap gap-x-3 gap-y-1 items-center border-b shrink-0"
          style={{ color: '#8a1f1f', background: '#FDECEC', borderColor: '#E5A0A0' }}
        >
          <span className="flex-1 min-w-0">{saveError}</span>
          <button className="underline hover:no-underline whitespace-nowrap" onClick={() => setSaveError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {/* Real unified diff (jsdiff via the shared UnifiedDiff — same renderer as
          the tool cards). Direction: disk → draft, i.e. what "Keep mine" would
          change on disk. Replaces the old two-<pre> columns, which were not a
          diff at all (spec §6.2). */}
      {showDiff && conflict && (
        <div className="border-b border-edge shrink-0 overflow-auto max-h-[40%] p-2">
          <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1">
            What keeping yours changes (disk → your draft)
          </div>
          <UnifiedDiff oldStr={conflict.disk} newStr={draft} />
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {/* Boundary catches lazy chunk-load failures + viewer render crashes
            (Suspense alone can't — lazy() THROWS its rejection). Keyed by
            artifact so switching files retries with a clean slate. */}
        <ViewerErrorBoundary key={artifact.id} path={artifact.path}>
        <Suspense fallback={<div className="flex items-center justify-center h-full text-fg-muted text-sm">Loading viewer…</div>}>
          <ViewerComponent
            path={artifact.path}
            content={content}
            contentInfo={contentInfo}
            sniffedBinaryTextFile={sniffedBinaryTextFile}
            absolutePath={absolutePath}
            isEditable={isEditable}
            editing={editing}
            draft={draft}
            onDraftChange={setDraft}
            onStartEdit={handleStartEdit}
            onSaveEdit={handleSave}
            onCancelEdit={handleCancel}
            hideControls={controlsInHeader}
            findBarOpen={findBarOpen}
          />
        </Suspense>
        </ViewerErrorBoundary>
      </div>
      {/* Partial-view notice — floats over the BOTTOM of the doc pane, in the
          spot the Edit pill would occupy (a file this large is read-only, so
          that pill is gone). Outside the viewer's scroll container, so it
          cannot scroll away and leave a partial view looking complete. */}
      {showPartialBanner && (
        <PartialFileBanner
          sizeBytes={contentInfo!.sizeBytes!}
          onLoadFull={loadFull}
          onOpenExternally={() => (window.claude as any).shell?.openPath?.(absolutePath)}
        />
      )}
    </div>
  );
});
