// SessionDrawer — slide-in panel listing artifacts collected during a session.
// Layout (B2 "push sidebar"): the selected artifact's content takes the full
// panel width; a collapsible/pinnable list pushes the content narrower when
// open. A per-file top bar offers click-to-rename (the filename itself is the
// trigger), copy, download, and expand-to-fullscreen.
//
// History: Task 6.x scaffolded a fixed 180px-list + viewer split. This file
// replaced that split with the push-sidebar layout (2026-06).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArtifact } from '../state/ArtifactContext';
import { useTheme } from '../state/theme-context';
import { clampDrawerWidth, applyDrawerWidthVar } from '../state/drawer-width';
import { useEscClose } from '../hooks/use-esc-close';
import { useProjectWatch } from '../hooks/useProjectWatch';
import { useGitFileStatus } from '../hooks/useGitFileStatus';
import { useMissingArtifacts, refreshMissingArtifacts } from '../hooks/useMissingArtifacts';
import { gitFooterState } from '../utils/git-footer';
import { ActiveArtifactView, type ActiveArtifactHandle } from './artifact-views/ActiveArtifactView';
import SessionPreviewPane from './SessionPreviewPane';
// 6b: COPY was originally added ONLY for the "Referenced
// conversations" list block below (a cut candidate — see Task 6 brief 6b).
// The A1/A2/A4 preview header (Resume + tag/note sheet) now uses COPY too, so
// this import no longer goes away if that block is cut.
import { COPY } from '../../shared/chatsearch-refs';
import { useArtifactContent } from './artifact-views/useArtifactContent';
import { useUnsavedGuard } from './artifact-views/UnsavedChangesDialog';
import { ContentFindBar } from './ContentFindBar';
import { GitReviewView } from './git/GitReviewView';
import { DiscardConfirmDialog } from './git/DiscardConfirmDialog';
import { runGuardedDiscard } from './git/discard-guard';
import type { ArtifactRecord, VersionEvent } from '../../shared/artifacts/types';
import { fileTypeGroup } from '../../shared/artifacts/categorization';
import type { FileTypeGroup } from '../../shared/artifacts/categorization';
import { getPlatform, isRemoteMode } from '../platform';
import { downloadFile } from './artifact-views/download-file';
import { formatRelativeTime } from '../utils/format-time';
import { Button, CloseButton, EmptyState, ErrorState, FieldError, SearchFilterPill, Tooltip } from './ui';
import { FileFilterPopover } from './project-view/FileFilterPopover';
import { useResolvedConversations } from '../hooks/useResolvedConversations';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { usePreviewMeta } from '../hooks/usePreviewMeta';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';
import { resumeBlockedReason } from './tool-views/SessionRefActions';
import ResumeOptionsPopover from './tool-views/ResumeOptionsPopover';
import { ChatResumeIcon } from './Icons';
import { TagGlyph } from './tags/glyphs';
import { TagNoteEditor } from './tags/TagNoteEditor';

// 'type' removed 2026-07-23 — the Type FILTER supersedes sorting by type.
type SortKey = 'recent' | 'name';

// Maps the rename IPC's error codes to user-facing copy. Falls back to a
// generic message so an unexpected code still surfaces *something* rather than
// silently keeping the old name.
function renameErrorCopy(code: unknown): string {
  switch (code) {
    case 'name-taken': return 'A file with that name already exists.';
    case 'invalid-name': return 'That name has characters that aren’t allowed.';
    case 'file-missing': return 'The original file is no longer on disk.';
    case 'artifact-not-found': return 'This file is no longer tracked.';
    // Fix: the default copy below tells the user to "try a different name",
    // which cannot work here — 'no-path' means the record's saved location
    // itself is invalid, not that the new name was rejected. Renaming can't
    // fix a bad stored path, so this needs its own message (error-message
    // standards: accurate, not a guess that sends the user down a dead end).
    case 'no-path': return 'This file’s saved location is invalid, so it can’t be renamed.';
    default: return 'Couldn’t rename the file. Try a different name.';
  }
}

// How long the file list will wait for the on-disk check before giving up and
// painting anyway. Short enough that nobody perceives it as loading, long
// enough to cover a local check on a large project. See listSettling below.
const SETTLE_HOLD_MS = 500;

interface Props {
  sessionId: string;
  projectRoot: string;
  projectId: string;
  projectName: string;
  /** The session's own working folder. Distinct from `projectRoot`, which is
   *  resolved through an ASYNC projects-index lookup and is therefore '' for
   *  the first moments of every drawer open. The on-disk check keys off this
   *  one so it can answer before the drawer paints — and so it shares its
   *  answer with the header file badge, which keys off the same value. */
  cwd: string;
}

// ── Small inline icon helper (lucide-style, inherits currentColor) ──
const PATHS: Record<string, string> = {
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  // Clipboard + slash — "Copy path" (approved mockup 13; the old chain link
  // read as "hyperlink", not "copy the file path").
  copypath: 'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M10.5 16 13.5 10.5',
  // Folder — "Reveal in folder".
  folder: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  // External-link (box + arrow-out) — "Open externally" (OS default app).
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  // Tray + arrow-down — "Download" (remote access batch 3, 2026-09-10): the
  // phone's stand-in for Open externally / Reveal, which have no meaning there.
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  // Four standalone corner arrows (approved mockup 12, stems shortened) —
  // the old bare brackets did not read as expand/contract.
  expand: 'M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15M5 5l4.2 4.2M19 5l-4.2 4.2M5 19l4.2-4.2M19 19l-4.2-4.2',
  shrink: 'M9.5 5v4.5H5M14.5 5v4.5H19M9.5 19v-4.5H5M14.5 19v-4.5H19M9.1 9.1 4.9 4.9M14.9 9.1 19.1 4.9M9.1 14.9 4.9 19.1M14.9 14.9 19.1 19.1',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  // Square-pen — distinct from the filename rename pencil; this edits contents.
  editdoc: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z',
  check: 'M20 6 9 17l-5-5',
  close: 'M18 6 6 18M6 6l12 12',
  forward: 'M5 12h14M13 6l6 6-6 6',
};
function Ic({ name, size = 15 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name].split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
    </svg>
  );
}

// Reveal-in-folder glyph — folder + eye at the corner (approved mockup 2-prime).
// Lives outside PATHS: the eye uses a thinner stroke (1.5) and a FILLED pupil,
// which the uniform-stroke Ic helper cannot express.
function RevealFolderIc({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.5 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.67.9l.81 1.2a2 2 0 0 0 1.69.9H20a2 2 0 0 1 2 2v3.5" />
      <path strokeWidth={1.5} d="M12.5 18.3s1.9-3.3 5.25-3.3S23 18.3 23 18.3s-1.9 3.3-5.25 3.3-5.25-3.3-5.25-3.3Z" />
      <circle cx="17.75" cy="18.3" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconBtn({ name, title, onClick, active, glyph }: { name?: string; title: string; onClick: () => void; active?: boolean; glyph?: React.ReactNode }) {
  return (
    <Tooltip text={title}>
    <button
      type="button"
      onClick={onClick}
      className={`w-7 h-7 rounded-md inline-flex items-center justify-center shrink-0 border transition-colors ${
        active ? 'text-fg bg-well border-edge' : 'text-fg-dim border-transparent hover:text-fg hover:bg-well hover:border-edge'
      }`}
    >
      {glyph ?? <Ic name={name!} />}
    </button>
    </Tooltip>
  );
}

// React.memo, and the reason it is worth the wrapper: this component lives
// inside ChatView, which re-renders on EVERY streamed token. Its five props are
// all plain strings that only change when you switch conversation or project, so
// a shallow compare skips the whole drawer — the file list, the open file's
// viewer, the git footer — for the entire length of a reply. It has no chat
// subscription of its own; the one thing it does watch, ArtifactContext, is
// memoized at the provider (App.tsx), so a context change still redraws it.
export const SessionDrawer = React.memo(function SessionDrawer({ sessionId, projectRoot, projectId, projectName, cwd }: Props) {
  const { state, dispatch } = useArtifact();
  const { showDeletedArtifacts, setShowDeletedArtifacts, drawerWidth, setDrawerWidth, resetDrawerWidth } = useTheme();
  const allArtifacts = state.sessionArtifacts[sessionId] ?? [];
  // Drawer open/closed AND the selected artifact are per-session (remembered
  // across switches). This drawer instance belongs to `sessionId`.
  const drawerOpen = state.drawerOpenBySession[sessionId] ?? false;
  const activeArtifactId = state.activeArtifactBySession[sessionId] ?? null;
  // A previewed past conversation occupies the content pane INSTEAD of an
  // artifact — mutually exclusive with activeArtifactId (see artifact-tracker.ts).
  const activePreview = state.activeSessionPreviewBySession[sessionId] ?? null;
  // "Referenced conversations" list (6b, cut candidate — see Task 6 brief).
  const referenced = state.referencedSessionsBySession[sessionId] ?? [];

  // ── Preview header: Resume + tag/note sheet (spec A1/A2/A4, 2026-08-26) ──
  // Called HERE, unconditionally, rather than inside the `activePreview ?`
  // branch below — this component has an early return further down (`if
  // (!active && !activePreview) return <aside>…`), and rules of hooks means
  // every hook this component calls must run on every render regardless of
  // which branch is about to be taken. useResolvedConversations is a no-op
  // (no chatsearch:resolve call) when passed `[]`, so an idle drawer viewing
  // a real file — or with nothing open at all — costs nothing extra.
  const previewResolved = useResolvedConversations(activePreview ? [activePreview.id] : []);
  const previewRow = activePreview
    ? previewResolved.results.find((r) => (r.status === 'ok' ? r.id === activePreview.id : r.query === activePreview.id)) ?? null
    : null;
  // The Resume Browser's own registry — same tags, same colors, one source.
  const previewTagRegistry = useTagRegistry();
  // Tags/note come from the meta store, NOT the search index (A1): the index
  // only refreshes at launch/session-end, so it would show a tag as applied
  // (or missing) that the store already disagrees with. `usePreviewMeta`
  // returns a no-op api when `activePreview` is null.
  const previewMeta = usePreviewMeta(activePreview ? activePreview.id : null);
  const narrowViewport = useNarrowViewport();
  const [previewSheetOpen, setPreviewSheetOpen] = useState(false);
  const previewSheetWrapRef = useRef<HTMLDivElement>(null);
  // The Resume options popover (M-header). Its own click-away/Escape live in
  // ResumeOptionsPopover; this side only owns open/closed and the anchor.
  const [resumeSheetOpen, setResumeSheetOpen] = useState(false);
  const resumeSheetWrapRef = useRef<HTMLDivElement>(null);
  // The same two session defaults the Resume Browser is handed by App. Read
  // here rather than threaded through the drawer's props: the drawer is
  // rendered from three places (chat, terminal, expanded) and none of them
  // carries them today.
  const [sessionDefaults, setSessionDefaults] = useState({ model: 'sonnet', skipPermissions: false });
  useEffect(() => {
    (window as unknown as { claude?: { defaults?: { get?: () => Promise<{ model?: string; skipPermissions?: boolean }> } } })
      .claude?.defaults?.get?.()
      .then((d) => { if (d) setSessionDefaults({ model: d.model ?? 'sonnet', skipPermissions: !!d.skipPermissions }); })
      .catch(() => {});
  }, []);
  useEscClose(previewSheetOpen, () => setPreviewSheetOpen(false));
  useEffect(() => {
    if (!previewSheetOpen) return;
    const onDown = (e: MouseEvent) => {
      if (previewSheetWrapRef.current && !previewSheetWrapRef.current.contains(e.target as Node)) {
        setPreviewSheetOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [previewSheetOpen]);
  useEffect(() => { setResumeSheetOpen(false); }, [activePreview?.id]);
  // Sheet must not survive a preview swap/close — reopening on a DIFFERENT
  // conversation's Preview click must not silently show the outgoing one's
  // still-open tag sheet.
  useEffect(() => { setPreviewSheetOpen(false); }, [activePreview?.id]);

  // Resume's enabled/disabled state and tooltip (spec A2). `previewRow` is
  // only a resumable `Ok` conversation once `chatsearch:resolve` answers
  // 'ok' — every other status (still loading, unknown, ambiguous) disables
  // Resume with a copy-book reason rather than a raw id or a blank button.
  const previewNative = activePreview?.provider === 'native';
  const previewOk = previewRow && previewRow.status === 'ok' ? previewRow : null;
  const previewBlockedReason = previewOk ? resumeBlockedReason(previewOk) : null;
  const previewResumeDisabled = !previewOk || !!previewBlockedReason;
  const previewResumeTitle = previewOk
    ? (previewBlockedReason ?? (previewNative ? COPY.resumeNativeHint : COPY.resumeHint))
    : previewRow?.status === 'ambiguous'
      ? COPY.ambiguousId(previewRow.candidates.length)
      : previewRow?.status === 'unknown'
        ? COPY.unknownId
        : previewResolved.loading ? COPY.lookingUp(1) : COPY.unknownId;
  const previewResumeLabel = previewNative ? COPY.resumeNative : COPY.resume;
  // Live external-change events while the drawer is actually visible — the
  // watcher in main is refcounted, so open drawers on the same project share one.
  // (Subscribed below, after listRetry exists: a reconnect re-lists through it.)
  // Set when a pill click couldn't resolve; cleared on next click/selection/close.
  const pillError = state.pillError?.[sessionId] ?? null;

  // Re-list this session's files whenever the drawer opens against a resolved
  // project root.
  //
  // WHY this exists (perf cycle 2): the list used to be loaded once by ChatView
  // at session mount, keyed on the session's `cwd`, and then refreshed as a SIDE
  // EFFECT of transcript replay — the artifact tool-use tracker listens to
  // transcript events, so re-streaming a whole conversation's history happened to
  // re-list its files. Paged history no longer streams history through that
  // channel, which left the drawer showing whatever ChatView saw at mount.
  // Opening the Files drawer should show what is on disk NOW, and it should key
  // off the RESOLVED projectRoot (useActiveProject), which is not always the raw
  // cwd ChatView used.
  // The real message when the list could not be fetched. WHY: over remote access
  // the host refused this channel until batch 3, the refusal rejected, and the
  // catch below swallowed it — so a phone read "Nothing here yet" for a session
  // with thirteen files (found 2026-09-10). A failure is a state with a Retry,
  // never an empty state that claims to know.
  const [listError, setListError] = useState<string | null>(null);
  const [listRetry, setListRetry] = useState(0);
  // Over remote access the files the assistant touched while the phone was
  // disconnected never arrived as events — re-list once the watch is back
  // (batch 3, R12). The desktop never fires the reconnect.
  useProjectWatch(drawerOpen && projectRoot ? projectRoot : null, () => setListRetry((n) => n + 1));
  useEffect(() => {
    if (!drawerOpen || !projectRoot || !sessionId) return;
    let cancelled = false;
    setListError(null);
    (window.claude as any).artifacts?.listSession?.(sessionId, projectRoot)
      .then((r: any) => {
        if (cancelled || !r?.ok || !Array.isArray(r.artifacts)) return;
        dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: r.artifacts });
      })
      .catch((err: any) => {
        // The drawer keeps whatever rows it already had, and says why it could
        // not refresh them — never a guess about the cause.
        if (!cancelled) setListError(err?.message ? String(err.message) : '');
      });
    return () => { cancelled = true; };
  }, [drawerOpen, projectRoot, sessionId, dispatch, listRetry]);

  // Multi-select type filter; EMPTY set = all types. Matches Project View
  // (Destin, 2026-07-23 — the drawer gained the Type group).
  const [types, setTypes] = useState<ReadonlySet<FileTypeGroup>>(() => new Set());
  // Orphans — artifacts whose file is gone from disk, folded into the same
  // "deleted" UI state as explicit delete versions.
  //
  // Fix (2026-08-30, the deleted-rows flash): this used to be component-local
  // state that reset to EMPTY on every close, so each open rendered the whole
  // list and then removed rows an IPC round trip later. The verdict now lives
  // in a project-scoped shared cache the header badge has already warmed, and
  // it is never cleared before its replacement arrives — so the list is
  // settled on the first painted frame. See hooks/useMissingArtifacts.ts.
  //
  // Exclude DISCOVERED (on-disk) records: their id is a relative path, not a
  // sidecar id, so checkExistence would treat them as "missing" and wrongly
  // mark a file that is literally on disk as deleted. They exist by definition
  // (discovery only lists real files), so they are never asked about.
  const checkableIds = useMemo(
    () => allArtifacts.filter((a) => !(a as any).discovered).map((a) => a.id),
    [allArtifacts]
  );
  const { missingIds: orphanIds, known: orphansKnown } =
    useMissingArtifacts(cwd || null, checkableIds);
  // Opening the drawer re-verifies disk state even when the id set has not
  // changed — the moment the list is about to be READ is the moment it most
  // needs to be right. It refreshes IN PLACE, so nothing blanks meanwhile.
  useEffect(() => {
    if (!drawerOpen || !cwd || checkableIds.length === 0) return;
    void refreshMissingArtifacts(cwd, checkableIds);
    // Dep is the whole ARRAY (plus the drawer-open edge), not just the id set
    // the hook itself watches: a rename, a status flip, or Claude re-creating a
    // file it had deleted all change what is on disk WITHOUT changing the id
    // list, and a stale "deleted" that only clears on close/reopen is exactly
    // the kind of wrong-looking list this change exists to prevent. Same dep
    // the pre-2026-08-30 effect used. Identical back-to-back requests coalesce
    // inside refreshMissingArtifacts, so this and the hook's own refresh never
    // produce two round trips.
  }, [drawerOpen, cwd, allArtifacts, checkableIds]);

  const artifacts = useMemo(() => {
    return allArtifacts.filter((a) => {
      if (types.size > 0 && !types.has(fileTypeGroup(a.path))) return false;
      const isDeleted = a.status === 'deleted' || orphanIds.has(a.id);
      if (isDeleted && !showDeletedArtifacts) return false;
      return true;
    });
  }, [allArtifacts, showDeletedArtifacts, orphanIds, types]);
  const hiddenCount = allArtifacts.length - artifacts.length;
  // Look up the open document in the UNFILTERED list — toggling "Hide code" /
  // "Show deleted" while viewing a now-filtered-out file must not blank the
  // content pane (the file is still open; only the LIST hides it).
  const active = allArtifacts.find((a) => a.id === activeArtifactId);
  // Read lifecycle (fetch + null-gate on switch + loading/missing/error
  // phases) lives in the shared useArtifactContent hook — this drawer and
  // FilesTab used to carry duplicate effects that conflated "loading" with
  // "no longer on disk" (the flash bug).
  const { content, setContent, contentInfo, contentState, retryRead, applyDiskRead } =
    useArtifactContent(projectRoot, active?.id ?? null, active?.path ?? null);

  // ── B2 panel UI state ──
  // The list stays open once toggled; it closes on the ☰ toggle, on selecting an
  // artifact, or on entering edit mode. (No pin — that was removed by request.)
  const [listOpen, setListOpen] = useState(false);  // push list shown
  const expanded = state.drawerExpanded;             // fill-the-region (shared, drives ChatView)
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  // Inline rename failure message (e.g. name taken). Null = no error.
  const [renameError, setRenameError] = useState<string | null>(null);
  // Guards against the Enter-then-blur double-commit (both fire on the input).
  const renameActiveRef = useRef(false);
  // Lets us re-focus the rename input after a failed commit (autoFocus only
  // fires on first mount; the field stays mounted across a failed attempt).
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Edit control is owned by ActiveArtifactView; the header drives it through
  // this ref + mirrors its state so the toolbar can swap pencil ↔ save/cancel.
  const editRef = useRef<ActiveArtifactHandle>(null);
  const [editState, setEditState] = useState<{ isEditable: boolean; editing: boolean }>({ isEditable: false, editing: false });
  // D3: every navigation away from a dirty editor goes through this guard
  // (Save / Discard / Cancel dialog) instead of silently discarding the draft.
  const { guard: guardUnsaved, dialog: unsavedDialog } = useUnsavedGuard(
    editRef, active ? (active.path.split('/').pop() ?? active.path) : 'This file');
  // Content pane node — the list collapses when the user engages the artifact
  // here (clicks into it or scrolls it), not when they merely preview by
  // clicking list rows.
  const contentRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);     // Ctrl+F find-in-document
  const [searchQuery, setSearchQuery] = useState('');  // filter the artifact list
  const [sortBy, setSortBy] = useState<SortKey>('recent');

  // Change 38: sort + the two visibility toggles moved behind ONE sliders
  // trigger into the shared FileFilterPopover (Destin: "a filter toggle menu
  // thing like project view"). Click-outside is owned HERE — the popover's
  // contract (FileFilterPopover.tsx:9-11) is that the parent wraps the trigger
  // AND the popover in one ref and closes on mousedown outside it.
  const [filterOpen, setFilterOpen] = useState(false);
  const filterWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [filterOpen]);
  const isElectron = getPlatform() === 'electron';
  const gitReviewOpen = state.gitReviewBySession?.[sessionId] ?? false;
  // Footer git status only for the open file, only while the drawer is visible.
  const gitStatus = useGitFileStatus(projectRoot, active && isElectron ? active.path : null, drawerOpen, active?.id ?? null);
  const gitFooter = gitFooterState(gitStatus);
  // L3 discard confirm (Task 9). discardError is the ONE error surface for the
  // review view — rendered via GitReviewView's externalError prop, cleared (a)
  // whenever a new git op runs inside the view and (b) whenever review closes,
  // so a stale discard failure can never linger into a reopened review.
  const [discardAsk, setDiscardAsk] = useState<{ willTrash: boolean } | null>(null);
  const [discardError, setDiscardError] = useState<string | null>(null);
  // Monotonic token for in-flight discards (see runGuardedDiscard): bumped on
  // close so a discard still in flight when the review closes is SUPERSEDED —
  // its late error must not surface in a reopened review (2026-07-22 bug).
  const discardRunRef = useRef(0);
  const closeGitReview = useCallback(() => {
    discardRunRef.current += 1;
    setDiscardError(null);
    dispatch({ type: 'GIT_REVIEW_CLOSED', sessionId });
  }, [dispatch, sessionId]);

  // No selection AND no preview → force the list visible so the user can
  // pick something. A live preview counts as a selection, same as an artifact.
  const showList = !active && !activePreview ? true : listOpen;

  // ── Rename: the filename itself is the trigger ──
  const startRename = useCallback(() => {
    if (!active) return;
    setRenameDraft(baseName(active.path));
    setRenameError(null);
    renameActiveRef.current = true;
    setRenaming(true);
  }, [active]);

  const cancelRename = useCallback(() => {
    renameActiveRef.current = false;
    setRenaming(false);
    setRenameError(null);
  }, []);

  // `viaEnter` distinguishes an explicit Enter commit from a blur commit. On a
  // failed Enter we re-focus the field so the user can immediately retry; on a
  // failed blur we keep the field open with the error but DON'T steal focus
  // back (that would trap the cursor — you could never click away from a bad
  // name). Either way the error is shown rather than silently swallowed.
  const commitRename = useCallback(async (viaEnter = false) => {
    if (!renameActiveRef.current || !active) return;
    renameActiveRef.current = false;
    const next = renameDraft.trim();
    if (!next || next === baseName(active.path)) { // unchanged / empty → no-op
      setRenaming(false);
      setRenameError(null);
      return;
    }
    const res = await (window.claude as any).artifacts.rename(projectRoot, active.id, next);
    if (res?.ok) {
      setRenaming(false);
      setRenameError(null);
      // Re-list from the (now-updated) sidecar so the header + list show the new name.
      const r = await (window.claude as any).artifacts.listSession(sessionId, projectRoot);
      if (r?.ok && Array.isArray(r.artifacts)) {
        dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: r.artifacts });
      }
    } else {
      // Failure (name-taken / invalid / etc.) — keep the field open with the old
      // name and surface WHY, so the rename doesn't silently appear to do nothing.
      setRenameError(renameErrorCopy(res?.error));
      renameActiveRef.current = true; // re-arm so the next Enter/blur commits again
      setRenaming(true);
      if (viaEnter) requestAnimationFrame(() => renameInputRef.current?.focus());
    }
  }, [active, renameDraft, projectRoot, sessionId, dispatch]);

  // Absolute on-disk path of the active artifact (for copy-path + reveal).
  // Forward slashes throughout — mixing a backslash projectRoot with '/' joins
  // reads broken in the clipboard on Windows.
  const absolutePath = active
    ? (active.kind === 'internal'
        ? `${projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${active.path.replace(/\\/g, '/')}`
        : (active.absolutePath ?? active.path))
    : '';

  // ── Toolbar actions ──
  // A tick for a moment after Copy path, because on a phone the hover hint that
  // used to be the only acknowledgement never shows (tester U5, 2026-09-10).
  const [copiedPath, setCopiedPath] = useState(false);
  const handleCopyPath = useCallback(() => {
    if (!absolutePath) return;
    navigator.clipboard?.writeText(absolutePath).then(() => {
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1500);
    }).catch(() => {});
  }, [absolutePath]);

  const handleReveal = useCallback(() => {
    if (absolutePath) (window.claude as any).shell?.showItemInFolder?.(absolutePath);
  }, [absolutePath]);

  // Open the file with the OS default app (HTML→browser, .docx→Word, etc.) —
  // the right action for formats the in-app viewer can't fully render. Desktop
  // only (shell.openPath); the button is gated on isElectron like Reveal.
  const handleOpenExternal = useCallback(() => {
    if (absolutePath) (window.claude as any).shell?.openPath?.(absolutePath);
  }, [absolutePath]);

  // Remote access batch 3 (questions deck 2026-09-10, Q-7 yes): a phone cannot
  // reveal or open a file that lives on another computer, so it gets Download —
  // the file lands in the phone's own downloads folder without blocking the chat.
  // The project and record go along so the host can authorize a tracked file
  // through its record (T7 review, finding 9).
  const handleDownload = useCallback(() => {
    if (absolutePath) void downloadFile(absolutePath, active ? { projectRoot, artifactId: active.id } : undefined);
  }, [absolutePath, active, projectRoot]);

  // Rows to render: the filtered set, narrowed by the search box and sorted.
  // Search/sort affect ONLY the rendered list — not `artifacts`, which still
  // backs the active-artifact lookup (so searching never hides the open file).
  const listedArtifacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const arr = q
      ? artifacts.filter((a) => (a.path.split('/').pop() ?? a.path).toLowerCase().includes(q))
      : artifacts.slice();
    arr.sort((a, b) => {
      if (sortBy === 'name') return fileNameOf(a).localeCompare(fileNameOf(b));
      // "Recent first" must agree with what the rows actually display — the
      // row shows THIS session's latest version, so sort on that same value
      // (not the record-global lastModified) or the order and the dates
      // shown can visibly disagree.
      return (
        (lastModifiedInSession(b, sessionId) || '').localeCompare(lastModifiedInSession(a, sessionId) || '')
      ); // recent first
    });
    return arr;
  }, [artifacts, searchQuery, sortBy, sessionId]);

  // True only until the FIRST on-disk check for this folder has settled. That
  // is normally already done before this drawer even mounts: the header's file
  // badge (useArtifactCount) runs the same check against the same cwd from the
  // moment a session exists, and shares its answer through the same cache. The
  // flag covers the cold case — a session whose files were never counted — where
  // painting rows now would mean removing some of them a round trip later.
  // Nothing renders in that window: not the rows, and not the empty state
  // either, since "Nothing here yet" would be its own wrong-then-corrected
  // flash.
  //
  // Two escape hatches, because a permanently blank file list is a far worse
  // failure than the flash this replaces: the hold never engages without a cwd
  // to check against (`cwd` is optional on both call sites), and it releases
  // after SETTLE_HOLD_MS regardless, so a slow or wedged check degrades to the
  // old behaviour instead of a dead-end empty pane.
  const [holdExpired, setHoldExpired] = useState(false);
  useEffect(() => {
    if (orphansKnown) return;
    const t = setTimeout(() => setHoldExpired(true), SETTLE_HOLD_MS);
    return () => clearTimeout(t);
  }, [orphansKnown]);
  const listSettling = !!cwd && !orphansKnown && !holdExpired && checkableIds.length > 0;

  // Collapse the list once the user actually engages the previewed artifact:
  // a click into the content pane or a scroll within it. Scroll is captured
  // (third arg true) because the real scroll happens on an inner overflow
  // container, and scroll events don't bubble. Wheel covers the case where the
  // user spins the wheel before the scroll position moves.
  useEffect(() => {
    if (!listOpen) return;
    const node = contentRef.current;
    if (!node) return;
    const close = () => setListOpen(false);
    node.addEventListener('mousedown', close);
    node.addEventListener('wheel', close, { passive: true });
    node.addEventListener('scroll', close, true);
    return () => {
      node.removeEventListener('mousedown', close);
      node.removeEventListener('wheel', close);
      node.removeEventListener('scroll', close, true);
    };
  }, [listOpen]);

  // Ctrl/Cmd+F opens find-in-document — but only when the pointer is over the
  // drawer, so it doesn't hijack Ctrl+F while the user is working in the chat.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        if (active && asideRef.current?.matches(':hover')) {
          e.preventDefault();
          // CodeMirror viewers get CM6's own search panel — ContentFindBar
          // walks rendered DOM text and CM6 virtualizes, so it would silently
          // find only the viewport's matches.
          if (editRef.current?.openFind?.()) return;
          setFindOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drawerOpen, active]);

  // Remove a tracking RECORD (never the file on disk). If the removal fails
  // (Android stub, write conflict) it quietly no-ops — same graceful-degrade
  // contract as rename on mobile.
  const handleRemoveRecord = useCallback(async (artifactId: string) => {
    const res = await (window.claude as any).artifacts.removeRecord?.(projectRoot, artifactId);
    if (!res?.ok) return;
    if (activeArtifactId === artifactId) dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId });
    const refreshed = await (window.claude as any).artifacts.listSession(sessionId, projectRoot);
    if (refreshed?.ok && Array.isArray(refreshed.artifacts)) {
      dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: refreshed.artifacts });
    }
  }, [projectRoot, sessionId, activeArtifactId, dispatch]);

  // ── ESC / back: rename → find → edit → expand → gitReview → list → active → drawer ──
  const handleBack = useCallback(() => {
    if (renameActiveRef.current) { cancelRename(); return; }
    if (findOpen) { setFindOpen(false); return; }
    if (editState.editing) { guardUnsaved(() => editRef.current?.cancelEdit()); return; }
    if (expanded) { dispatch({ type: 'DRAWER_EXPAND_TOGGLED' }); return; }
    if (gitReviewOpen) { closeGitReview(); return; }
    if (listOpen) { setListOpen(false); return; }
    // A live preview backs out to the list before the drawer closes, same
    // step as an open artifact — Esc/back must not jump straight past it.
    if (activePreview) { dispatch({ type: 'SESSION_PREVIEW_CLEARED', sessionId }); return; }
    if (activeArtifactId) { dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId }); return; }
    dispatch({ type: 'DRAWER_CLOSED', sessionId });
  }, [findOpen, editState.editing, expanded, gitReviewOpen, listOpen, activePreview, activeArtifactId, dispatch, cancelRename, sessionId, guardUnsaved, closeGitReview]);

  useEscClose(drawerOpen, handleBack);

  // Drag-to-resize state (youcoded#105). These three hooks MUST stay above the
  // `!drawerOpen` early return below — they used to sit next to the pointer
  // handlers ~130 lines down, which made them conditional. Every mount site
  // currently gates on the same drawerOpenBySession value, so the early return
  // never actually fired and the bug stayed dormant; the moment anyone renders
  // SessionDrawer unconditionally (which that guard invites) React throws
  // "Rendered more hooks than during the previous render". Found by
  // react-hooks/rules-of-hooks.
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const dragRaf = useRef(0);
  const [dragging, setDragging] = useState(false);

  if (!drawerOpen) return null;

  // ── List column (shared by the no-selection and push-sidebar layouts) ──
  const listInner = (
    <>
      <div className="flex items-center justify-between px-3 py-2 border-b border-edge shrink-0">
        {/* "Session Files" (Destin, 2026-07-23) — was "Session artifacts"
            (2026-07-20, which itself superseded reserving "Artifacts" for the
            Project View tab). "Files" is the plain word for what this actually
            lists; the "Session" qualifier still carries the distinction: this
            drawer is one session's activity log (created/edited/viewed all
            appear), vs the project-wide set in Project View. */}
        <span className="font-semibold text-sm">Session Files{listSettling ? '' : ` (${listedArtifacts.length})`}</span>
        {/* Only in the list-only shape (no artifact, no preview) — once
            either is showing, the top bar's own Close icon covers this, and
            showing both would be a redundant second close button. */}
        {!active && !activePreview && (
          <Tooltip text="Close drawer">
            <CloseButton
              onClick={() => guardUnsaved(() => dispatch({ type: 'DRAWER_CLOSED', sessionId }))}
              label="Close drawer"
            />
          </Tooltip>
        )}
      </div>
      {/* Search + filter. Uses the SHARED SearchFilterPill so this row and the
          Project View files toolbar are the same control (Destin, 2026-07-23:
          "if the goal is consistency, we should try to better match"). The
          click-outside listener stays here — the popover requires one ref around
          both trigger and popover, which the pill forwards. */}
      <div className="px-2 py-1.5 border-b border-edge-dim shrink-0">
        <SearchFilterPill
          ref={filterWrapRef}
          className="w-full"
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search files…"
          inputAriaLabel="Search files"
          /* Only "Show deleted" alters the default view here; hide-code is
             default-ON and turning it OFF reveals more, so neither is counted —
             same convention as Project View. */
          activeFilters={(types.size > 0 ? 1 : 0) + (showDeletedArtifacts ? 1 : 0)}
          filterOpen={filterOpen}
          onToggleFilter={() => setFilterOpen((o) => !o)}
        >
          {filterOpen && (
            <FileFilterPopover
              types={types}
              onTypesChange={setTypes}
              sortBy={sortBy}
              onSortBy={setSortBy}
              showDeleted={showDeletedArtifacts}
              onShowDeleted={setShowDeletedArtifacts}
              showDeletedAvailable={true}
              onClose={() => setFilterOpen(false)}
            />
          )}
        </SearchFilterPill>
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* A pill click that couldn't resolve — shown INSTEAD of letting the
            generic empty state contradict the file the user just clicked. */}
        {pillError && (
          <div className="mx-2 mt-2 px-2.5 py-2 text-2xs text-fg rounded-md border border-edge bg-well">
            {pillError}
          </div>
        )}
        {listSettling ? null : listError !== null && listedArtifacts.length === 0 ? (
          <div className="px-3 pt-2">
            <ErrorState
              mode="recoverable"
              message={listError ? `Couldn’t load this chat’s files: ${listError}` : 'Couldn’t load this chat’s files.'}
              onRetry={() => setListRetry((t) => t + 1)}
            />
          </div>
        ) : listedArtifacts.length === 0 ? (
          pillError ? null /* the note above already explains the state */ : (
            /* Same EmptyState + way-out pattern as the Project View files tab and
               the Resume browser (change 32). A search that matched nothing gets a
               Clear search button; the filtered-empty case points at the filter
               popover — NOT "toggle off above", which went stale when change 38
               moved those toggles off the drawer body and behind the sliders icon. */
            <EmptyState
              /* BLOCK, not inline: centered + stacked, matching the Resume
                 browser (Destin, 2026-07-23). Inline laid the message and button
                 out in a left-aligned row, which also clipped in a narrow drawer.
                 px-3 keeps the text off the edges at small drawer widths. */
              className="px-3"
              message={
                searchQuery.trim()
                  ? <>No files match “{searchQuery.trim()}”.</>
                  : types.size > 0 && hiddenCount > 0
                    ? <>No files of the selected type{types.size === 1 ? '' : 's'} — {hiddenCount} hidden by the filter.</>
                    : <>Nothing here yet. Files Claude writes or edits in this chat will appear here.</>
              }
              action={
                searchQuery.trim()
                  ? { label: 'Clear search', onClick: () => setSearchQuery('') }
                  : types.size > 0 && hiddenCount > 0
                    ? { label: 'Show all types', onClick: () => setTypes(new Set()) }
                    : undefined
              }
            />
          )
        ) : (
          listedArtifacts.map((a) => (
            <ArtifactListItem
              key={a.id}
              artifact={a}
              isActive={activeArtifactId === a.id}
              isDeleted={a.status === 'deleted' || orphanIds.has(a.id)}
              sessionId={sessionId}
              onSelect={() => {
                // Preview-on-click: set the active artifact but KEEP the list open
                // so the user can click across artifacts to preview them. The list
                // collapses only when they engage the content pane (see the
                // contentRef effect: click into it or scroll it).
                // Cancel any in-progress rename first so its open field doesn't
                // bleed onto the newly-selected artifact.
                if (renameActiveRef.current || renaming) cancelRename();
                // On a phone the list and the file take turns (stack navigation,
                // see drawer-body below), so a tap must SHOW the file — the first
                // phone tester (2026-09-10, U3) tapped a row, saw only a title
                // bar appear above the same list, and assumed the tap had failed.
                const keepListOpen = !narrowViewport;
                // Re-selecting the open file never discards anything — skip the guard.
                if (a.id === activeArtifactId) { setListOpen(keepListOpen); return; }
                guardUnsaved(() => {
                  dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: a.id });
                  setListOpen(keepListOpen);
                });
              }}
              // Discovered records have no sidecar entry to remove.
              onRemove={(a as any).discovered ? undefined : () => handleRemoveRecord(a.id)}
            />
          ))
        )}
      </div>
      {/* "Referenced conversations" — KEPT. Destin, 2026-08-27 gate (D1):
          picked "keep it", with "just show title in this list, not assistant
          or whateva", so the lane label that used to trail each row is gone.
          The row is deliberately title-only: at the list's width anything
          after the title truncates the title itself. */}
      {referenced.length > 0 && (
        <div className="mt-3 border-t border-edge pt-2">
          <div className="px-3 pb-1 text-2xs uppercase tracking-wider text-fg-muted">{COPY.referencedHeading}</div>
          {referenced.map((r) => (
            <button
              key={`${r.provider}:${r.id}`}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-well ${
                activePreview?.id === r.id ? 'bg-well text-fg' : 'text-fg-dim'
              }`}
              onClick={() => guardUnsaved(() => dispatch({ type: 'SESSION_PREVIEW_SET', sessionId, provider: r.provider, id: r.id, title: r.title }))}
            >
              <span className="truncate flex-1">{r.title || COPY.untitled}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );

  // Drag-to-resize (youcoded#105). The drawer sits on the RIGHT, so dragging
  // the LEFT edge left grows it: width = startWidth + (startX - clientX).
  // Live preview writes the <html> --drawer-width var once per frame (no
  // React re-render per mousemove); pointer-up commits via setDrawerWidth
  // (clamp + localStorage). Double-click resets to the 480px default.
  // (dragState/dragRaf/dragging are declared above the early return — see there.)
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragState.current = { startX: e.clientX, startWidth: drawerWidth };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (!s) return;
    const next = clampDrawerWidth(s.startWidth + (s.startX - e.clientX), window.innerWidth);
    cancelAnimationFrame(dragRaf.current);
    dragRaf.current = requestAnimationFrame(() => applyDrawerWidthVar(next));
  };
  const onHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (!s) return;
    dragState.current = null;
    setDragging(false);
    cancelAnimationFrame(dragRaf.current);
    setDrawerWidth(s.startWidth + (s.startX - e.clientX)); // setter clamps + persists
  };

  // Hidden while expanded — there's no width to drag in fill mode. w-1.5 is a
  // 6px hit area hugging the drawer's left edge; the visible affordance is the
  // hover/drag accent tint. No new backdrop-filter (react-renderer rule).
  const resizeHandle = expanded ? null : (
    <Tooltip text="Drag to resize · double-click to reset">
    <div
      className={`absolute left-0 inset-y-0 w-1.5 cursor-col-resize z-10 transition-colors ${dragging ? 'bg-accent/50' : 'hover:bg-accent/30'}`}
      onPointerDown={onHandlePointerDown}
      onPointerMove={onHandlePointerMove}
      onPointerUp={onHandlePointerUp}
      onPointerCancel={onHandlePointerUp}
      onDoubleClick={resetDrawerWidth}
    />
    </Tooltip>
  );

  // Expanded just fills the framed-shell content region (ChatView hides the chat
  // pane via the .drawer-expanded class) — the header/input chrome stay put.
  // relative: positioning context for the resize handle. Width follows the
  // same var as the parent .drawer-pane so the two can't drift (youcoded#105).
  const asideClass = expanded
    ? 'relative flex-1 min-w-0 h-full flex flex-col bg-inset'
    // drawer-aside: hook for the <=700px override in globals.css. Without it
    // this stayed a hard 480px child inside a `.drawer-pane` that the media
    // query had already collapsed to 100% — on a 390px phone the right ~90px
    // of the drawer, including its toolbar, was clipped away by the pane's
    // overflow:hidden and simply unreachable.
    : 'drawer-aside relative w-[var(--right-pane-width,480px)] h-full flex flex-col bg-inset shrink-0';

  // No selection AND no preview → the whole drawer is the list (nothing to
  // view yet). A preview clears `active` (exclusivity rule), so this guard
  // must let a live preview through too, or the pane branch below is
  // unreachable — the very first Preview click would open the drawer and
  // then immediately show nothing.
  if (!active && !activePreview) {
    return <aside ref={asideRef} className={asideClass}>{resizeHandle}{listInner}</aside>;
  }

  // Same session-scoped fix as ArtifactListItem: the footer describes what
  // THIS session did with the open file, not its whole history.
  // Both are `active &&` guarded (rather than assuming active is set) because
  // this line also runs while `activePreview` is showing and `active` is null.
  const statusWord = active ? statusInfo(active, active.status === 'deleted' || orphanIds.has(active.id), sessionId) : '';
  const fileName = active ? (active.path.split('/').pop() ?? active.path) : '';

  return (
    <aside ref={asideRef} className={asideClass}>
      {resizeHandle}
      {unsavedDialog}
      {discardAsk && active && (
        <DiscardConfirmDialog
          fileName={fileName}
          willTrash={discardAsk.willTrash}
          onConfirm={() => {
            setDiscardAsk(null);
            // Real stderr or nothing — the review view refreshes itself via
            // git:changed. Guarded by discardRunRef so a close mid-flight
            // drops this attempt's late result (see discard-guard.ts).
            void runGuardedDiscard(
              () => (window as any).claude?.git?.discard?.(projectRoot, active.path),
              discardRunRef,
              setDiscardError,
            );
          }}
          onCancel={() => setDiscardAsk(null)}
        />
      )}
      {/* top bar. The filename/rename cluster and the file-scoped actions
          (open-external, copy-path, reveal) only make sense for a real
          artifact — while a preview is showing, `active` is null (exclusivity
          rule), so those collapse away. The conversation title takes the same
          slot the filename does (below), and this is now the ONLY close
          button for either case — SessionPreviewPane used to draw its own
          second title/close row in its body; that was the "two X's" bug
          Destin flagged, so it no longer renders one. Don't add one back. */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-edge shrink-0">
        {narrowViewport && active && !listOpen ? (
          // A phone has no hover hint to explain a bare list glyph, and a file
          // that has replaced the list needs a way BACK that reads as one
          // (tester U3, 2026-09-10): a labelled button, like every phone app.
          <Button variant="ghost" size="sm" className="shrink-0 px-1.5" onClick={() => setListOpen(true)} aria-label="Back to the file list">
            ‹ Files
          </Button>
        ) : (
          <IconBtn name="list" title={listOpen ? 'Hide list' : 'Show list'} active={listOpen} onClick={() => setListOpen((v) => !v)} />
        )}
        {active ? (renaming ? (
          <div className="flex items-center gap-2 min-w-0 px-1 relative">
            <span className={`inline-flex items-center border rounded-md overflow-hidden ${renameError ? 'border-red-500' : 'border-accent'}`}>
              <input
                ref={renameInputRef}
                autoFocus
                value={renameDraft}
                onChange={(e) => { setRenameDraft(e.target.value); if (renameError) setRenameError(null); }}
                onBlur={() => commitRename(false)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(true); } }}
                className="bg-canvas text-fg text-sm-tight font-semibold px-2 py-1 w-[150px] outline-none"
              />
              <span className="text-xs text-fg-muted font-mono px-2">{extOf(fileName)}</span>
            </span>
            {/* Inline failure note — keeps the field open so the user can correct it. */}
            {renameError && (
              <FieldError size="2xs" className="absolute left-1 top-full mt-1 whitespace-nowrap z-10">
                {renameError}
              </FieldError>
            )}
          </div>
        ) : (
          <Tooltip text="Click to rename">
          <button
            type="button"
            onClick={startRename}
            className="group flex items-center gap-1.5 min-w-0 px-2 py-1 rounded-md cursor-text hover:bg-well transition-colors"
          >
            <span className="text-sm-tight font-semibold text-fg truncate decoration-dotted underline-offset-[3px] group-hover:underline group-hover:decoration-fg-muted">
              {fileName}
            </span>
            <span className="text-fg-muted opacity-0 group-hover:opacity-100 shrink-0"><Ic name="pencil" size={12} /></span>
          </button>
          </Tooltip>
        )) : activePreview ? (
          // Same slot the filename occupies above, plain (not a button) — a
          // past conversation can't be renamed, so this carries none of the
          // click-to-rename affordance.
          <div className="min-w-0 px-2 py-1">
            <span className="block text-sm-tight font-semibold text-fg truncate">
              {activePreview.title || COPY.untitled}
            </span>
          </div>
        ) : null}
        <div className="flex-1" />
        {/* Resume + tag/note sheet (spec A4): `☰ list · title · (spacer) ·
            Resume · 🏷 tag · ⛶ expand · ✕ close`. Both are `activePreview`-
            only — a real artifact never shows them, and the file-only icons
            below stay `active &&`-gated exactly as before. */}
        {activePreview && (
          <>
            <div ref={previewSheetWrapRef} className="relative">
              <button
                type="button"
                onClick={() => setPreviewSheetOpen((v) => !v)}
                aria-label={`Organize ${activePreview.title || COPY.untitled}`}
                aria-haspopup="dialog"
                aria-expanded={previewSheetOpen}
                className={`w-7 h-7 rounded-md inline-flex items-center justify-center shrink-0 border transition-colors ${
                  previewSheetOpen ? 'text-fg bg-well border-edge' : 'text-fg-dim border-transparent hover:text-fg hover:bg-well hover:border-edge'
                }`}
              >
                {/* Same mark as the Resume Browser's tag button (glyphs.tsx) —
                    shared so it can't drift between the two surfaces. */}
                <TagGlyph className="w-4 h-4" />
              </button>
              {previewSheetOpen && (
                // layer-surface (panel) hosting TagNoteEditor's own bg-inset
                // card — the same nesting CloseSessionPrompt's OverlayPanel
                // uses, and TagNoteEditor already lifts its OWN fields to
                // bg-well against that bg-inset card, so no fieldClassName
                // override is needed here (unlike the Resume Browser, whose
                // sheet drops the TagPicker/NoteEditor straight onto its
                // bg-inset card with no layer-surface between it and the
                // panel below).
                <div
                  className="layer-surface absolute right-0 top-full mt-2 w-[280px] p-2 z-30"
                  role="dialog"
                  aria-label={COPY.tagsAndNoteLabel}
                >
                  <TagNoteEditor
                    appliedIds={new Set(previewMeta.tags)}
                    onToggleTag={previewMeta.toggleTag}
                    registry={previewTagRegistry}
                    note={previewMeta.note}
                    onNote={previewMeta.saveNote}
                  />
                </div>
              )}
            </div>
          </>
        )}
        {/* Edit/Save moved to the floating button at the bottom-right of the
            doc pane (Destin, 2026-07-22) — see the cluster below the content div. */}
        {active && isElectron && <IconBtn name="external" title="Open with the default app" onClick={handleOpenExternal} />}
        {active && isRemoteMode() && <IconBtn name="download" title="Download" onClick={handleDownload} />}
        {active && <IconBtn name={copiedPath ? 'check' : 'copypath'} title={copiedPath ? 'Copied' : 'Copy path'} onClick={handleCopyPath} />}
        {active && isElectron && <IconBtn title="Reveal in folder" glyph={<RevealFolderIc />} onClick={handleReveal} />}
        {/* Expand is a no-op at phone width — the drawer is already the whole
            screen — so it is not offered there (tester U6, 2026-09-10). */}
        {!narrowViewport && (
          <IconBtn name={expanded ? 'shrink' : 'expand'} title={expanded ? 'Shrink panel' : 'Expand panel'} active={expanded} onClick={() => dispatch({ type: 'DRAWER_EXPAND_TOGGLED' })} />
        )}
        {/* Resume sits between expand and close — Destin, 2026-08-27 gate
            (M-header): "i want resume to be between expand and X button."
            It no longer resumes on click; it opens the options popover below,
            which is where the model / skip-permissions choice and the final
            confirm live. */}
        {activePreview && (
          <div ref={resumeSheetWrapRef} className="relative">
            <Tooltip text={previewResumeTitle}>
            <Button
              variant="primary"
              size="sm"
              disabled={previewResumeDisabled}
              // Narrow (<640px, checked at 390px): the label collapses to a
              // chat bubble with a play triangle — Destin (M-narrow) on the
              // plain forward arrow that used to sit here. Icon-only means the
              // accessible name moves to aria-label.
              aria-label={narrowViewport ? previewResumeLabel : undefined}
              aria-haspopup="dialog"
              aria-expanded={resumeSheetOpen}
              onClick={previewOk && !previewBlockedReason ? () => setResumeSheetOpen((v) => !v) : undefined}
            >
              {narrowViewport ? <ChatResumeIcon className="w-3.5 h-3.5" /> : previewResumeLabel}
            </Button>
            </Tooltip>
            {resumeSheetOpen && previewOk && (
              <ResumeOptionsPopover
                conversation={previewOk}
                defaultModel={sessionDefaults.model}
                defaultSkipPermissions={sessionDefaults.skipPermissions}
                onClose={() => setResumeSheetOpen(false)}
              />
            )}
          </div>
        )}
        <IconBtn name="close" title="Close" onClick={() => guardUnsaved(() => dispatch({ type: 'DRAWER_CLOSED', sessionId }))} />
      </div>


      {/* body: push list + content.
          data-list-open drives the <=700px rules in globals.css, where the
          list and the content view stop sharing the row and become stack
          navigation instead — a 210px list beside the content left only
          ~150px for the file itself on a phone, so the half you were actually
          looking at was the one that got crushed. */}
      <div className="drawer-body flex-1 flex min-h-0" data-list-open={showList ? 'true' : undefined}>
        <div
          className={`drawer-list shrink-0 overflow-hidden bg-well transition-[width] duration-200 flex flex-col ${
            showList ? 'w-[210px] border-r border-edge' : 'w-0'
          }`}
        >
          {/* keep the list mounted (width-collapsed) so toggling is instant */}
          <div className="drawer-list-inner w-[210px] flex flex-col h-full">{listInner}</div>
        </div>
        {/* Positioning parent for the find bar. contentRef is the INNER div so
            the find bar (a sibling) isn't itself walked by the search. */}
        <div className="drawer-content flex-1 min-w-0 overflow-hidden relative flex flex-col">
          {activePreview ? (
            // Preview replaces the whole content column — find bar, metadata
            // strip, and git review don't apply to a read-only transcript.
            // Title + close now live in the top bar above (same slot a file
            // uses), so the pane itself no longer takes title/onClose props.
            <SessionPreviewPane
              provider={activePreview.provider}
              id={activePreview.id}
              // Fix: this drawer already has the title (activePreview.title,
              // set when the preview was opened — same value the top bar and
              // the Organize aria-label above use) — thread it down instead
              // of making the pane re-resolve the same id a second time just
              // to get the same string back.
              title={activePreview.title}
            />
          ) : gitReviewOpen && active ? (
            // Standard top bar (above) stays; find bar, content, edit cluster, and
            // the metadata strip below are all swapped out while review is open
            // (locked decision, ledger 10).
            <GitReviewView
              projectRoot={projectRoot}
              relPath={active.path}
              fileName={fileName}
              onBack={closeGitReview}
              onRequestDiscard={(willTrash) => setDiscardAsk({ willTrash })}
              externalError={discardError}
              onExternalErrorClear={() => setDiscardError(null)}
            />
          ) : active ? (
            // `active` is guaranteed non-null here: past the early return,
            // exactly one of activePreview/gitReviewOpen&&active/active is
            // true (the reducer's exclusivity rule), and the two branches
            // above already claimed the other cases. Narrowed explicitly
            // (rather than relying on that invariant) so TS doesn't need to
            // trust it either.
            <>
              {findOpen && (
                <ContentFindBar
                  containerRef={contentRef}
                  resetKey={active.id}
                  onClose={() => setFindOpen(false)}
                />
              )}
              <div ref={contentRef} className="flex-1 min-h-0 overflow-hidden artifact-content-pane">
                <ActiveArtifactView
                  ref={editRef}
                  findBarOpen={findOpen}
                  artifact={active}
                  content={content}
                  contentInfo={contentInfo}
                  contentState={contentState}
                  onRetryRead={retryRead}
                  projectRoot={projectRoot}
                  projectId={projectId}
                  projectName={projectName}
                  sessionId={sessionId}
                  onContentChange={setContent}
                  onDiskRead={applyDiskRead}
                  controlsInHeader
                  onEditStateChange={setEditState}
                />
              </div>
              {/* Floating Edit ↔ Save cluster, bottom-right of the doc pane.
                  Pops IN when the artifact list collapses (doc goes full-width)
                  and back OUT when the list reopens — kept mounted so both
                  directions animate. While EDITING it stays visible regardless,
                  so Save can never be hidden by opening the list. */}
              {active && (editState.editing || editState.isEditable) && (
                <div
                  className={`absolute bottom-9 right-4 z-20 flex items-center gap-2 transition-all duration-200 ${
                    editState.editing || !showList
                      ? 'opacity-100 scale-100'
                      : 'opacity-0 scale-90 pointer-events-none'
                  }`}
                >
                  {editState.editing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => editRef.current?.cancelEdit()}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold bg-panel text-fg-2 border border-edge shadow-lg hover:text-fg hover:bg-well transition-colors"
                      >
                        <Ic name="close" size={15} />
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => editRef.current?.saveEdit()}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold bg-accent text-on-accent shadow-lg hover:opacity-90 transition-opacity"
                      >
                        <Ic name="check" size={15} />
                        Save
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { editRef.current?.startEdit(); setListOpen(false); }}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold bg-accent text-on-accent shadow-lg hover:opacity-90 transition-opacity"
                    >
                      <Ic name="editdoc" size={15} />
                      Edit
                    </button>
                  )}
                </div>
              )}
              {/* metadata strip — bottom of the DOC column (not a full-width row up
                  top), so it shares the document's width and expands/shrinks with
                  the artifact list (Destin, 2026-07-22). */}
              <div className="flex items-center gap-2 px-3.5 py-1 text-2xs text-fg-muted border-t border-edge-dim bg-well shrink-0">
                {/* WHY: status shown as a word, not a ●◐○ glyph (user-disliked — see dislikes-status-glyphs memory). */}
                <span>{statusWord}</span>
                <span className="text-fg-faint">·</span>
                <span>{formatRelativeTime(lastModifiedInSession(active, sessionId))}</span>
                {content !== null && <><span className="text-fg-faint">·</span><span>{formatSize(content, contentInfo?.sizeBytes)}</span></>}
                <div className="flex-1" />
                <GitFooterEntry
                  counts={gitFooter.counts}
                  show={gitFooter.show}
                  conflicted={gitFooter.conflicted}
                  onOpenReview={() => dispatch({ type: 'GIT_REVIEW_OPENED', sessionId })}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
});

// Footer entry for the git surface (mockup ledger 9). Rendered inside the
// metadata strip; absent entirely when show=false so the strip reads exactly
// as it did before the git surface existed.
export function GitFooterEntry({
  counts, show, conflicted, onOpenReview,
}: {
  counts: { added: number; removed: number } | null;
  show: boolean;
  /** mid-merge unmerged file — renders an amber "Conflict" word before the
   *  counts (2026-07-22 bug: these files used to vanish from the footer).
   *  Plain word, not a chip: the metadata strip speaks in words (statusWord). */
  conflicted?: boolean;
  onOpenReview: () => void;
}) {
  if (!show) return null;
  return (
    <>
      {conflicted && (
        <Tooltip text="This file has merge conflicts">
        <span className="font-medium text-amber-400">
          Conflict
        </span>
        </Tooltip>
      )}
      {counts && (
        <>
          <span className="font-mono text-green-400">+{counts.added}</span>
          <span className="font-mono text-red-400">−{counts.removed}</span>
        </>
      )}
      <Tooltip text="Review this file's changes">
      <button
        type="button"
        onClick={onOpenReview}
        className="flex items-center gap-1 px-2 py-0.5 rounded-md text-2xs text-fg-dim hover:text-fg hover:bg-inset transition-colors"
      >
        Review Changes <Ic name="forward" size={11} />
      </button>
      </Tooltip>
    </>
  );
}

// ─── Filter toggles (extracted so both layouts share them) ───────────────────

// ─── ArtifactListItem ────────────────────────────────────────────────────────

interface ListItemProps {
  artifact: ArtifactRecord;
  isActive: boolean;
  isDeleted: boolean;
  // WHY: the row's word/timestamp describe what THIS session did to the file,
  // not the record's whole history — see statusInfo/lastModifiedInSession.
  sessionId: string;
  onSelect: () => void;
  // Remove the tracking RECORD (never the file). Clears accidental pill-click
  // tracks and dead deleted rows; Claude editing the file again re-adds it.
  onRemove?: () => void;
}

function ArtifactListItem({ artifact, isActive, isDeleted, sessionId, onSelect, onRemove }: ListItemProps) {
  const statusWord = statusInfo(artifact, isDeleted, sessionId);
  const relTime = formatRelativeTime(lastModifiedInSession(artifact, sessionId));
  const fileName = artifact.path.split('/').pop() ?? artifact.path;

  return (
    // group/relative wrapper hosts the hover-revealed remove × (a button can't
    // nest inside the select button) — same pattern as ProjectSwitcher rows.
    <div className="group relative">
      <Tooltip text={isDeleted ? 'Deleted (file is no longer on disk)' : ''}>
      <button
        className={`w-full text-left px-2 py-2 ${onRemove ? 'pr-8' : ''} hover:bg-inset border-b border-edge-dim transition-colors ${
          isActive ? 'bg-inset' : ''
        } ${isDeleted ? 'opacity-50' : ''}`}
        onClick={onSelect}
      >
        <div className="flex items-center gap-1 min-w-0">
          <span className={`font-mono text-xs truncate flex-1 ${isDeleted ? 'line-through' : ''}`}>{fileName}</span>
        </div>
        {/* WHY: status shown as a word, not a ●◐○ glyph (user-disliked — see dislikes-status-glyphs memory). */}
        <div className="text-3xs text-fg-muted ml-0.5">{statusWord} · {relTime}</div>
      </button>
      </Tooltip>
      {onRemove && (
        <Tooltip text={`Remove ${fileName} from this list (the file itself is not deleted)`}>
          <CloseButton
            // w-6 h-6 survives as a className override: hover-revealed row affordance,
            // sized to the row rather than the standard 28px panel-header closer.
            className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity w-6 h-6 rounded-md"
            label={`Remove ${fileName} from this list`}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
          />
        </Tooltip>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// WHY: the drawer is a per-session activity log, but every row/footer label
// used RECORD-GLOBAL data (all versions across every session that ever
// touched the file). A file edited weeks ago in another session and merely
// read in THIS session showed "edited · <that other session's old date>" —
// neither the word nor the date described what this session actually did.
// This helper scopes version lookups to `sessionId` so callers can compute
// both the status word and the timestamp from only this session's events.
function versionsInSession(artifact: ArtifactRecord, sessionId: string): VersionEvent[] {
  return artifact.versions.filter((v) => v.sessionId === sessionId);
}

// Session-scoped status word: deleted (unchanged short-circuit), viewed (this
// session's versions are all 'read'), delivered (this session's versions are
// all 'read'/'delivered' with at least one 'delivered'), edited (>1 modifying
// version THIS session), created (exactly one). Falls back to the
// record-global count only if this session somehow has zero version events
// for the artifact — that shouldn't happen (the artifact wouldn't be in this
// session's list at all), but an empty label would be worse than the old
// (still-wrong) global word.
function statusInfo(artifact: ArtifactRecord, isDeleted: boolean, sessionId: string): string {
  if (isDeleted) return 'deleted';
  const sessionVersions = versionsInSession(artifact, sessionId);
  const versions = sessionVersions.length > 0 ? sessionVersions : artifact.versions;
  // 'read' and 'delivered' are not modifications. A delivered-only file says
  // "delivered" (more than a view, less than an edit) — spec 2026-08-25 §4.2.
  const modifying = versions.filter((v) => v.type !== 'read' && v.type !== 'delivered').length;
  if (modifying === 0) return versions.some((v) => v.type === 'delivered') ? 'delivered' : 'viewed';
  if (modifying > 1) return 'edited';
  return 'created';
}

// Session-scoped row timestamp: the latest version THIS session logged for
// the artifact, not the record's global lastModified cache (which can be
// weeks stale relative to what this session did). Falls back to the global
// cache for the same no-events-this-session edge case as statusInfo above.
function lastModifiedInSession(artifact: ArtifactRecord, sessionId: string): string {
  const sessionVersions = versionsInSession(artifact, sessionId);
  if (sessionVersions.length === 0) return artifact.lastModified;
  return sessionVersions.reduce((latest, v) => (v.ts > latest ? v.ts : latest), sessionVersions[0].ts);
}

function fileNameOf(a: ArtifactRecord): string {
  return a.path.split('/').pop() ?? a.path;
}

function baseName(p: string): string {
  const fn = p.split('/').pop() ?? p;
  const dot = fn.lastIndexOf('.');
  return dot > 0 ? fn.slice(0, dot) : fn;
}

function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot) : '';
}

// sizeBytes (from artifacts:get) wins over measuring the string: once a big
// file is served as a PREFIX, the string in memory is 400 bytes and the file is
// 8.4 MB. Measuring the string would state the wrong size with total confidence.
function formatSize(content: string, sizeBytes?: number): string {
  const bytes = sizeBytes ?? new Blob([content]).size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

