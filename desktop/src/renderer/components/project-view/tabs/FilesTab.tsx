// FilesTab — the folder-tree file browser for one project. Renders the
// Project Files section: every real file in the project folder. The disk is the
// truth here, so a file Claude edited in-folder gets NO special treatment.
// Two sources since 2026-09-18 (Project Files at any size, Stage 1): plain
// folder browsing reads ONE folder at a time straight from disk, a page at a
// time (artifacts:list-folder — any depth, any size, no "Browse anyway" gate);
// search and the type filter still use the capped whole-project list
// (LIST_ALL_FILES) until the background index lands (roadmap, Stage 2).
// Merged from the old Artifacts/All-files tab split on 2026-07-23; the search +
// type filter + sort apply to the one grid. Badge counts stay folder TOTALS.
// An External Artifacts section (sidecar records outside the project folder)
// existed briefly (Task 5) and was removed 2026-07-23: against the owner's real
// sidecar it was ~95% incidental noise (scratchpad temps, other-device paths,
// .claude/ internals). Externals still surface per-session in the Session
// Drawer (artifacts.listSession) — that stays their home.
// Cards use .layer-surface; the deleted badge is a plain word "deleted" (the ●◐○ / ✕
// glyph language is disliked — plain words instead).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// WHY no useArtifact import: this file must not read ArtifactContext — see the
// memo comment on FilesTab below. The one value it needs arrives as props.
import type { ArtifactAction } from '../../../state/artifact-actions';
import { useChunkedReveal } from '../../../hooks/use-chunked-reveal';
import { useProjectWatch } from '../../../hooks/useProjectWatch';
import { dedupeContentHits, groupContentHits, capGroups, MAX_CONTENT_ROWS, type RankableHit } from '../../../utils/content-search-ranking';
import type { CentralIndexProject, ArtifactRecord } from '../../../../shared/artifacts/types';
import { FOLDER_PAGE_SIZE, type FolderPage, type FolderSummary } from '../../../../shared/artifacts/folder-page';
import { ActiveArtifactView } from '../../artifact-views/ActiveArtifactView';
import type { ActiveArtifactHandle } from '../../artifact-views/ActiveArtifactView';
import { useArtifactContent } from '../../artifact-views/useArtifactContent';
import { useUnsavedGuard } from '../../artifact-views/UnsavedChangesDialog';
import { ArtifactThumbnail } from '../../ArtifactThumbnail';
import { fileTypeGroup, fileTypeLabel } from '../../../../shared/artifacts/categorization';
import type { FileTypeGroup } from '../../../../shared/artifacts/categorization';
import { ProjectDetailOverlay } from '../ProjectDetailOverlay';
import {
  TOOL_BTN_ACCENT, TOOL_BTN_NEUTRAL, PencilIcon, CheckIcon, FolderIcon, LinkIcon, ExternalLinkIcon, DownloadIcon,
} from '../detail-tool-icons';

// Compact relative-time for the detail meta strip (shared util).
import { formatRelativeTime as relTime } from '../../../utils/format-time';
import { getPlatform, isRemoteMode } from '../../../platform';
import { downloadFile } from '../../artifact-views/download-file';
import { useNarrowViewport } from '../../../hooks/use-narrow-viewport';

// Absolute on-disk path for an artifact (internal = project.path + rel path).
function artifactAbsPath(projectPath: string, a: ArtifactRecord): string {
  if (a.kind !== 'internal') return a.absolutePath ?? a.path;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  return `${projectPath.replace(/[\\/]+$/, '')}${sep}${a.path.replace(/^[\\/]+/, '')}`;
}

// ProjectView keeps its own artifact selection separate from any chat session's
// drawer, keyed under this reserved sessionId in activeArtifactBySession.
// Exported so ProjectView — the one reader of ArtifactContext on this screen —
// can pick this session's open file out of the state and hand it down.
export const PV_SESSION = 'project-view';

// Human "kind" label for a card (Document / Image / Spreadsheet / Code), from the
// shared fine-grained type groups — the same groups the type filter uses, so the
// card label always agrees with which filter option surfaces it.
const kindLabel = fileTypeLabel;

// Sort order for the file cards (folders always sort by name). Shared with the
// seg-row sort <select> in ProjectView via this exported key type.
// 'type' removed 2026-07-23 — the Type FILTER supersedes sorting by type.
export type FileSortKey = 'name' | 'recent';

// How the file list is drawn: the thumbnail grid (default) or a compact row
// list. Lifted to ProjectView like `sortBy` so the toolbar toggle can own it.
// Two modes only — a third "small icons" size was considered and dropped
// (design deck 2026-09-03, Q-1): it does no job the other two don't already do.
export type FileViewMode = 'grid' | 'list';
const fileNameOf = (a: ArtifactRecord) => a.path.split('/').pop() ?? a.path;
function fileComparator(sortBy: FileSortKey) {
  return (a: ArtifactRecord, b: ArtifactRecord): number => {
    // lastModified is an ISO string — lexicographic compare IS chronological.
    if (sortBy === 'recent') return (b.lastModified || '').localeCompare(a.lastModified || '');
    return fileNameOf(a).localeCompare(fileNameOf(b));
  };
}

// One row of the folder view: a file or a subfolder, in the order the listing
// sent them (files first). Built once per page arrival (useMemo), so a row's
// wrapper keeps its identity across unrelated renders.
type FolderEntry = { kind: 'file'; file: ArtifactRecord } | { kind: 'dir'; dir: FolderSummary };

// A folder's count line: its direct entries. Blank when the folder could not
// be read — its own listing shows the real reason when opened.
function itemsLabel(f: FolderSummary): string {
  if (f.itemCount === undefined) return '';
  return `${f.itemCount.toLocaleString()} item${f.itemCount === 1 ? '' : 's'}`;
}

// What a folder that could not be listed says. Every one names the real
// reason the listing gave (docs/error-message-standards.md) — never "empty".
function folderErrorMessage(error: string, detail: string | undefined, atRoot: boolean, projectPath: string): string {
  switch (error) {
    case 'permission-denied':
      return 'Your computer won’t let YouCoded open this folder (permission denied).';
    case 'not-found':
      return atRoot
        ? `This project’s folder isn’t at ${projectPath}. If it’s on a drive that isn’t connected, connect it and try again.`
        : 'This folder isn’t there any more.';
    case 'not-a-folder':
      return 'This is a file now, not a folder.';
    case 'protected-path':
      return 'YouCoded doesn’t open this folder, because it can hold passwords or keys.';
    case 'outside-project':
      return 'This folder leads outside the project, so YouCoded doesn’t show it here.';
    case 'not-allowed':
      // The remote host's root gate (remote-server.ts refuseUnknownProject).
      return 'This computer doesn’t share this folder over remote access.';
    case 'request-failed':
      return detail ? `Couldn’t load your files: ${detail}` : 'Couldn’t load your files.';
    default:
      // 'unavailable' and anything newer: the system's own code, labelled as
      // such (ELOOP, EIO…), rather than a guess at what it means (F6).
      return detail ? `Couldn’t open this folder. The system reported: ${detail}.` : 'Couldn’t open this folder.';
  }
}

// Folder glyph for the folder cards — shared module (../icons); strokeWidth 1.5
// reads better at the card sizes than the segmented control's default 2.
// Aliased: detail-tool-icons also exports a (different) FolderIcon used by the
// Reveal button above.
import { FolderIcon as FolderCardIcon, DocIcon, ImageIcon, SheetIcon, CodeGlyphIcon, GridViewIcon, ListViewIcon } from '../icons';
import { ChevronIcon } from '../../Icons';
import { EmptyState, ErrorState } from '../../ui';
import { useScreenOpen, ScreenMark } from '../../../shoot-mode';

// The rounded box the list-view rows sit in — the same container language the
// content-search groups already use. Module scope, NOT inside the component: a
// component declared in a render body gets a fresh identity every render, which
// remounts every row inside it and drops keyboard focus mid-scroll.
// The rounded box the list-view rows sit in.
//
// `scrolls` decides WHICH element scrolls, and it is not cosmetic:
//  - true (plain folder browsing, where this box is the only thing in the
//    column): the box keeps its default flex-shrink, so it takes the height
//    available and scrolls its own rows. The scrollbar then draws INSIDE the
//    rounded border, against the rows it moves. Reported 2026-09-03: with the
//    column scrolling instead, the bar sat in the gutter outside the border and
//    read as belonging to nothing.
//  - false (search results, where headers and the content-match list stack
//    above and below it): the box takes its natural height with shrink-0 and
//    the COLUMN scrolls, so all the sections move together. Without shrink-0 it
//    would collapse to the column's height and clip its own rows with no
//    scrollbar anywhere — measured at 1440x560: 9 rows in the DOM, 3 visible.
// max-sm keeps both out of the way: below 640px the whole page scrolls, and a
// second scrolling region inside it would trap the gesture.
function ListBox({ children, scrolls, scrollRef }: {
  children: React.ReactNode;
  scrolls?: boolean;
  // The element that scrolls when `scrolls` is set — the folder view's reveal
  // watches it, because in list view it is this box, not the column, that moves.
  scrollRef?: React.Ref<HTMLDivElement>;
}) {
  if (!scrolls) return <div className="shrink-0 rounded-lg border border-edge-dim overflow-hidden">{children}</div>;
  // TWO elements, deliberately. Chromium paints a scrollbar in its own gutter,
  // which is NOT clipped by the scrolling element's own border-radius — so with
  // the border and the scrolling on one div the thumb's square end ran over the
  // rounded corners (reported 2026-09-03, "still overlaps the edge of the
  // container when scrolled all the way up/down"). An ANCESTOR's rounded
  // overflow-hidden does clip a descendant's scrollbar, so the border and the
  // radius live on the outer div and the scrolling happens inside it.
  return (
    <div className="min-h-0 flex flex-col rounded-lg border border-edge-dim overflow-hidden">
      <div ref={scrollRef} className="min-h-0 overflow-y-auto max-sm:overflow-visible">{children}</div>
    </div>
  );
}

// Tiny per-type glyph for the folder-card filename list — one icon per
// fileTypeGroup, so the list rows read like a miniature file listing.
function MiniTypeIcon({ path, size = 12 }: { path: string; size?: number }) {
  const group = fileTypeGroup(path);
  if (group === 'image') return <ImageIcon size={size} />;
  if (group === 'sheet') return <SheetIcon size={size} />;
  if (group === 'code') return <CodeGlyphIcon size={size} />;
  return <DocIcon size={size} />;
}

// The folder-tree file browser for one project — search, type filter, sort,
// folder navigation, and the detail overlay all live here (mode collapsed
// 2026-07-23; see the header comment).
function FilesTabImpl({
  project,
  search,
  types,
  sortBy,
  view,
  onViewChange,
  refreshKey,
  onMutated,
  onCurrentDirChange,
  onClearSearch,
  hidden,
  pvActiveId,
  artifactDispatch: dispatch,
}: {
  project: CentralIndexProject;
  search: string;     // lifted to ProjectView — lives on the shared seg-row now
  // Multi-select type filter; EMPTY set = all types (filter popover).
  types: ReadonlySet<FileTypeGroup>;
  sortBy: FileSortKey;               // filter popover: sort
  // Grid of thumbnails vs. compact list. Owned by ProjectView (the toolbar
  // toggle lives on the seg-row next to search) and remembered app-wide, so
  // every project opens in the view you last chose.
  view: FileViewMode;
  // Variant B: the switch is drawn HERE, on the breadcrumb line, so ProjectView
  // hands down the setter as well as the value.
  onViewChange: (v: FileViewMode) => void;
  refreshKey: number; // bumped by ProjectView after "+ Add file" to force a reload
  // VESTIGIAL as of 2026-07-23: this fired after the only in-tab sidecar mutation
  // (Exclude, on an external-artifact row) so ProjectView could refetch counts
  // without reloading the tab. Exclude was removed with the External Artifacts
  // section, so nothing invokes this now. Kept (not pruned) because untangling
  // ProjectView's countsKey from its hero-count effect is real risk for zero
  // gain — it just no longer has a trigger. Re-wire it if an in-tab mutation
  // ever returns.
  onMutated?: () => void;
  // Task 6: FilesTab owns currentDir (the breadcrumb tree), but "+ Add file"'s
  // destination lives in ProjectView (its dialog + IPC call). Reporting the
  // browsed folder up is cheaper than lifting the whole tree-navigation state,
  // and keeps this component the sole owner of currentDir's setState calls.
  onCurrentDirChange?: (relDir: string) => void;
  // Clears the shared search box (owned by ProjectView) from the no-results
  // empty state — without it that state would be a dead end.
  onClearSearch?: () => void;
  // Another tab is showing. ProjectView keeps this component MOUNTED and hides
  // it instead of unmounting, because unmounting drops the project watcher and
  // the file list, and coming back rebuilds both — the main-process watcher
  // rebuild alone froze the app for ~300 ms per switch (perf-lab 2026-09-09).
  // Staying mounted also returns you to the folder and file you were looking at.
  hidden?: boolean;
  // The file open in Project View (ArtifactContext's entry for PV_SESSION), and
  // that context's dispatch. Handed down by ProjectView instead of read here:
  // the context changes on every file any session writes, and a read here would
  // redraw the whole grid — hidden or not — each time (see the memo below).
  pvActiveId: string | null;
  artifactDispatch: React.Dispatch<ArtifactAction>;
}) {
  // Root breadcrumb label + empty-state wording — constant now that this tab
  // renders only the one on-disk section.
  const rootLabel = 'Project Files';
  const noun = 'files';
  // Searching OR an active type filter flattens the tree to matching FILES only
  // — no folder cards. When you're looking for something, folders are noise;
  // each flat card shows its parent folder for context instead. Plain browsing
  // (no search, no type filter) keeps the navigable folder tree.
  const searching = !!search.trim();
  const flat = searching || types.size > 0;

  // ── Whole-project list (search and type filter only) ─────────────────────
  // The capped whole-project walk (LIST_ALL_FILES). Fetched only once a search
  // or filter needs it: plain browsing never waits for a recursive scan any
  // more. `force` because the home-folder/drive gate is gone (Stage 1) — a
  // search there gets the walk's first batch, and the truncation note below
  // says so, until the background index (roadmap, Stage 2) replaces it.
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  // True until the list for the current project resolves — gates the flat
  // empty states so they can't flash before data arrives.
  const [allLoading, setAllLoading] = useState(false);
  // The real message when the search list's request could not be answered at
  // all (the folder view has its own, below). WHY this exists: over remote access the host refused every file channel until
  // batch 3, the refusal REJECTED, and this component had no catch — so the
  // loading line never cleared and a phone saw "Loading files…" forever (found
  // 2026-09-10). A failure is a state with a Retry, never a spinner that
  // outlives its request.
  const [allError, setAllError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // True when the whole-project walk hit a cap — surfaced as a note under
  // search results so a partial list never silently reads as complete.
  const [truncated, setTruncated] = useState(false);
  // Current folder being browsed ('' = project root).
  const [currentDir, setCurrentDir] = useState('');
  // Photo-only build: `shoot` opens a fixture folder (docs, and Locked under ?filesLocked=1).
  useScreenOpen('projects/files/folder', (dir) => { if (dir) setCurrentDir(dir); }, ['docs', 'Locked']);
  // Report the browsed folder up to ProjectView, which needs it as the "+ Add
  // file" import destination — see the prop comment above. Deliberately keyed
  // on currentDir ONLY, not on onCurrentDirChange: ProjectView passes its raw
  // setCurrentRelDir state setter, which React guarantees is referentially
  // stable, so adding it to the deps wouldn't change how often this fires —
  // it's omitted to keep the array honest about the one thing that actually
  // varies (the browsed folder), not because the callback is unstable.
  useEffect(() => {
    onCurrentDirChange?.(currentDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDir]);

  // Back to the project root — on a PROJECT SWITCH only. Deliberately its own
  // effect: the loaders below also run on refreshKey (every "+ Add file"), and
  // resetting here threw the user back to the root after every import. Worse,
  // the reset propagated up through onCurrentDirChange, so ProjectView's
  // currentRelDir went stale too and a SECOND consecutive import landed at the
  // root instead of the folder being browsed — defeating the whole point of
  // that plumbing. Clearing the active artifact belongs here for the same
  // reason: it exists so the detail pane can't carry the PREVIOUS project's
  // content, which an import never causes.
  useEffect(() => {
    setCurrentDir('');
    dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const allGen = useRef(0);
  const loadAll = () => {
    const gen = ++allGen.current;
    setAllLoading(true);
    setAllError(null);
    Promise.resolve((window.claude as any).artifacts.listAllFiles(project.id, { force: true }))
      .then((res: any) => {
        if (gen !== allGen.current) return;
        setAllLoading(false);
        if (res && res.ok) { setArtifacts(res.files ?? res.artifacts ?? []); setTruncated(!!res.truncated); }
        else { setArtifacts([]); setTruncated(false); }
      })
      .catch((err: any) => {
        if (gen !== allGen.current) return;
        setAllLoading(false);
        setArtifacts([]);
        setTruncated(false);
        // The real message when there is one; never a guess about the cause.
        setAllError(err?.message ? String(err.message) : '');
      });
  };
  // Remembers which project/refresh the list above belongs to, so turning a
  // search off and on again doesn't refetch, but a new project or an import does.
  const allFor = useRef<string | null>(null);
  useEffect(() => {
    if (!flat) return;
    const key = `${project.id}\0${refreshKey}\0${retryToken}`;
    if (allFor.current === key) return;
    allFor.current = key;
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, project.id, refreshKey, retryToken]);
  // A project switch drops the old list at once, so a search typed straight
  // after the switch never matches against the previous project's files.
  useEffect(() => { setArtifacts([]); setTruncated(false); setAllError(null); allFor.current = null; }, [project.id]);

  // ── Folder view: ONE folder, from disk, a page at a time ─────────────────
  // artifacts:list-folder (main/artifacts/folder-listing.ts). No depth limit,
  // no size gate: dot-folders, node_modules and nested repos open like any
  // folder. More pages arrive as the reader scrolls (the sentinel below).
  const [folderFiles, setFolderFiles] = useState<ArtifactRecord[]>([]);
  const [folderDirs, setFolderDirs] = useState<FolderSummary[]>([]);
  const [folderHasMore, setFolderHasMore] = useState(false);
  const [folderLoading, setFolderLoading] = useState(true);
  // Why the folder could not be listed: the listing's own { ok:false } answer,
  // or 'request-failed' when the request itself was refused (remote access
  // down…). Rendered as an ErrorState with the real reason, never as an empty
  // folder. Kept apart from allError (search) so neither clears or shows the
  // other's failure (code review 2026-09-18, F1).
  const [folderError, setFolderError] = useState<{ error: string; detail?: string } | null>(null);
  // A LATER page failed. The pages already shown stay; the end of the list
  // says why it stopped and offers Retry, so a half-read folder never reads as
  // complete (code review 2026-09-18, F2).
  const [moreError, setMoreError] = useState<{ error: string; detail?: string } | null>(null);
  const folderGen = useRef(0);
  const folderPaging = useRef(false);
  // The listing's snapshot id from page 0 — later pages pass it so they read
  // the SAME listing even when something else re-reads this folder (F3).
  const folderSnapshot = useRef<string | undefined>(undefined);
  const loadedCount = folderFiles.length + folderDirs.length;
  const loadedCountRef = useRef(0);
  loadedCountRef.current = loadedCount;

  const listFolderPage = (dir: string, offset: number, limit: number, snapshot?: string): Promise<FolderPage | { ok: false; error: 'unsupported' }> =>
    Promise.resolve((window.claude as any).artifacts.listFolder?.(project.id, dir, { sort: sortBy, offset, limit, snapshot })
      ?? { ok: false, error: 'unsupported' });
  const reasonOf = (res: any) => ({ error: String(res?.error ?? ''), detail: res?.detail });
  const rejectionOf = (err: any) => ({ error: 'request-failed', detail: err?.message ? String(err.message) : undefined });

  // Load the folder from the top. `keep` re-reads at least that many entries,
  // so a refresh (a file added while you read page 3) doesn't cut the list
  // back to one page under the reader. Refreshes ask for up to 1,000 at a time
  // (the listing's cap), so a reader deep in a folder costs one or two round
  // trips per refresh, not one per 200 (F7).
  const loadFolder = (keep = 0) => {
    const gen = ++folderGen.current;
    folderPaging.current = false;
    setMoreError(null);
    if (keep === 0) {
      // A different folder: clear the old one at once, so its files never sit
      // under the new folder's breadcrumb while the new listing arrives.
      setFolderLoading(true);
      setFolderFiles([]); setFolderDirs([]); setFolderHasMore(false); setFolderError(null);
    }
    const dir = currentDir;
    (async () => {
      const files: ArtifactRecord[] = [];
      const dirs: FolderSummary[] = [];
      let more = true;
      let snapshot: string | undefined;
      while (more && (files.length + dirs.length === 0 || files.length + dirs.length < keep)) {
        const got = files.length + dirs.length;
        const limit = Math.min(1000, Math.max(FOLDER_PAGE_SIZE, keep - got));
        const res: any = await listFolderPage(dir, got, limit, snapshot);
        if (gen !== folderGen.current) return;
        if (!res?.ok) {
          setFolderLoading(false);
          setFolderFiles([]); setFolderDirs([]); setFolderHasMore(false);
          // The phone app has no file data yet (SessionService.kt stub): keep
          // showing the same empty folder it showed before this channel existed.
          setFolderError(res?.error === 'not-implemented-on-mobile' || res?.error === 'unsupported'
            ? null : reasonOf(res));
          return;
        }
        snapshot = res.snapshot;
        files.push(...res.files);
        dirs.push(...res.folders);
        more = !!res.hasMore;
      }
      folderSnapshot.current = snapshot;
      setFolderLoading(false);
      setFolderError(null);
      setFolderFiles(files); setFolderDirs(dirs); setFolderHasMore(more);
    })().catch((err: any) => {
      if (gen !== folderGen.current) return;
      setFolderLoading(false);
      setFolderFiles([]); setFolderDirs([]); setFolderHasMore(false);
      setFolderError(rejectionOf(err));
    });
  };
  // The next page, appended. One at a time; a reload in between wins.
  const loadMoreFolder = () => {
    if (folderPaging.current || !folderHasMore) return;
    folderPaging.current = true;
    setMoreError(null);
    const gen = folderGen.current;
    listFolderPage(currentDir, loadedCountRef.current, FOLDER_PAGE_SIZE, folderSnapshot.current).then((res: any) => {
      if (gen !== folderGen.current) return;
      folderPaging.current = false;
      if (!res?.ok) { setMoreError(reasonOf(res)); return; }
      // The listing this page belonged to had expired: re-read from the top,
      // keeping as many entries, rather than splice two listings together.
      if (res.restarted) { loadFolder(loadedCountRef.current + FOLDER_PAGE_SIZE); return; }
      folderSnapshot.current = res.snapshot ?? folderSnapshot.current;
      setFolderFiles((prev) => [...prev, ...res.files]);
      setFolderDirs((prev) => [...prev, ...res.folders]);
      setFolderHasMore(!!res.hasMore);
    }).catch((err: any) => {
      if (gen !== folderGen.current) return;
      folderPaging.current = false;
      setMoreError(rejectionOf(err));
    });
  };
  // Opening a folder starts from the top with a loading line; re-reading the
  // SAME folder (a sort change, an import, Retry) replaces it in place with as
  // many entries as were loaded — no flash, and the reader keeps their place.
  const shownFolder = useRef<string | null>(null);
  useEffect(() => {
    const key = `${project.id}\0${currentDir}`;
    const same = shownFolder.current === key;
    shownFolder.current = key;
    loadFolder(same ? Math.max(loadedCountRef.current, 1) : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, currentDir, sortBy, refreshKey, retryToken]);

  // Filter the flat list (search + multi-select type). Search matches the FILE
  // NAME only — a query matching a folder name should not surface every file
  // inside that folder. An empty `types` set means all types.
  const matchesFilters = (a: ArtifactRecord) => {
    const filename = a.path.split('/').pop() ?? a.path;
    if (search && !filename.toLowerCase().includes(search.toLowerCase())) return false;
    if (types.size > 0 && !types.has(fileTypeGroup(a.path))) return false;
    return true;
  };
  const filtered = useMemo(
    () => artifacts.filter(matchesFilters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [artifacts, search, types],
  );
  // Re-read what is on screen: the folder (keeping as many entries as are
  // loaded) and, once a search has fetched it, the whole-project list.
  const refreshArtifacts = () => {
    loadFolder(Math.max(loadedCountRef.current, 1));
    if (allFor.current !== null) loadAll();
  };
  const refreshRef = useRef(refreshArtifacts);
  refreshRef.current = refreshArtifacts;

  // Live external changes (spec §8.3): watch the project root while this tab is
  // mounted, and refresh the list when files appear/disappear on disk. Debounced
  // — a git checkout emits hundreds of add/remove events in a burst, and each
  // uncoalesced refresh would re-read the folder (and, while searching, re-run
  // the cache-invalidated discovery scan).
  // Over remote access, the changes made while the phone was disconnected never
  // arrived as events — reload the list once the watch is back (batch 3, R12).
  // Known limit until Stage 2: the watcher stops 6 levels down (2 for a home
  // folder), so a folder deeper than that refreshes when you open it again,
  // not live.
  useProjectWatch(project.path, () => refreshRef.current());
  // This tab stays mounted while another tab shows, so the refresh has to know
  // that. Refreshing while hidden would re-read for a list nobody is looking
  // at, at a worse moment: a git checkout or an npm install running while you
  // read Conversations. Remember instead, and refresh once on the way back.
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const missedChangeRef = useRef(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = (window.claude as any).artifacts?.onChanged?.((evt: any) => {
      if (evt.projectRoot !== project.path || evt.by !== 'external') return;
      if (evt.kind !== 'add' && evt.kind !== 'remove') return; // edits refetch per-file
      if (hiddenRef.current) { missedChangeRef.current = true; return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; refreshRef.current(); }, 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      if (typeof unsub === 'function') unsub();
    };
  }, [project.path]);
  useEffect(() => {
    if (hidden || !missedChangeRef.current) return;
    missedChangeRef.current = false;
    refreshRef.current();
  }, [hidden]);

  // ── Project-wide CONTENT search (unified list, Destin 2026-07-22: no
  // toggle — name matches rank above these). Debounced; desktop-only (the
  // Kotlin side is a stub and remote rejects as unsupported — both settle to
  // an empty hit list and the search stays names-only there).
  const [contentHits, setContentHits] = useState<RankableHit[]>([]);
  const [contentTruncated, setContentTruncated] = useState(false);
  // True from the moment a content search is queued until it settles. Gates the
  // no-results empty state so it never flashes mid-search.
  const [contentSearching, setContentSearching] = useState(false);
  // Groups are collapsed by default (Destin, 2026-07-22) — a fresh query
  // collapses everything again so results always start as a scannable summary.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => { setExpandedGroups(new Set()); }, [search]);
  const toggleGroup = (path: string) => setExpandedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  // Search-result jump: which file+line to reveal once the overlay opens.
  const [pendingReveal, setPendingReveal] = useState<{ id: string; line: number } | null>(null);
  // A content hit on a file outside the loaded list (cap-truncated discovery)
  // still opens via the id-as-path GET contract — this synthetic record lets
  // the overlay render it.
  const [syntheticHit, setSyntheticHit] = useState<ArtifactRecord | null>(null);
  useEffect(() => {
    const q = search.trim();
    if (!q || q.length < 2 || getPlatform() !== 'electron') {
      setContentHits([]);
      setContentTruncated(false);
      setContentSearching(false);
      return;
    }
    let cancelled = false;
    // Mark in-flight IMMEDIATELY (before the 300ms debounce), so the no-results
    // empty state below can't flash during the debounce + IPC round trip on a
    // query that is about to return hits.
    setContentSearching(true);
    const t = setTimeout(() => {
      Promise.resolve((window.claude as any).artifacts.searchContent?.(project.path, q))
        .then((res: any) => {
          if (cancelled) return;
          setContentHits(res?.ok ? (res.hits ?? []) : []);
          setContentTruncated(!!res?.truncated);
          setContentSearching(false);
        })
        .catch(() => { if (!cancelled) { setContentHits([]); setContentTruncated(false); setContentSearching(false); } });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, project.path]);

  const openContentHit = (hit: RankableHit) => {
    const rec = artifacts.find((a) => a.path.replace(/\\/g, '/') === hit.path);
    const id = rec?.id ?? hit.path;
    if (!rec) {
      setSyntheticHit({ id, path: hit.path, kind: 'internal', discovered: true } as any);
    }
    setPendingReveal({ id, line: hit.line });
    dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId: PV_SESSION, artifactId: id });
  };

  // The file a card or row was last opened from. WHY: the folder view holds
  // one folder's loaded pages, not the whole project — a refresh that re-reads
  // fewer pages, or a search that flattens the view, must not drop the record
  // the open-file overlay is showing (the overlay closes when it has none).
  const [openedRecord, setOpenedRecord] = useState<ArtifactRecord | null>(null);
  const openFile = (a: ArtifactRecord) => {
    setOpenedRecord(a);
    dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId: PV_SESSION, artifactId: a.id });
  };
  const activeArtifact = pvActiveId
    ? (folderFiles.find((a) => a.id === pvActiveId)
      ?? artifacts.find((a) => a.id === pvActiveId)
      ?? (openedRecord && openedRecord.id === pvActiveId ? openedRecord : undefined)
      ?? (syntheticHit && syntheticHit.id === pvActiveId ? syntheticHit : undefined))
    : undefined;

  // Flat results honor the same sort as the folder view.
  const flatResults = useMemo(
    () => (flat ? [...filtered].sort(fileComparator(sortBy)) : filtered),
    [filtered, flat, sortBy],
  );
  // Flat results draw 50 at a time as you scroll (render-cost consolidation
  // 2026-09-18): a search or type filter over a big project is the 2,000-card
  // case, and drawing them all at once is what made typing in the box stall.
  // resetKey is the query's VALUES, so a new search starts a fresh window at
  // the top; resetScrollOnActivate is off because coming back to the Files tab
  // with the same search must leave the list where it was.
  // Below 640px the page scrolls instead of this box (max-sm:overflow-visible
  // on it), so the reveal watches the viewport there — same trade-off as
  // ConversationsTab.
  const flatScrollRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const noRoot = useRef<HTMLElement | null>(null);
  const narrowViewport = useNarrowViewport();
  const isList = view === 'list';
  const { visible: flatVisible, hasMore: flatHasMore, sentinelRef: flatSentinelRef } = useChunkedReveal(flatResults, {
    resetKey: JSON.stringify([search.trim(), [...types].sort(), sortBy, view, project.id]),
    rootRef: narrowViewport ? noRoot : flatScrollRef,
    // Only while flat: the folder view has its own reveal below, and an idle
    // one here would reset the shared scroll box on the folder view's behalf.
    active: !hidden && flat,
    resetScrollOnActivate: false,
  });

  // The folder view draws the same way (Stage 1, 2026-09-18): it used to be
  // left whole because a folder was "tens of items", and a folder read from
  // disk can now be 100,000. The listing pages 200 at a time; this reveals 50
  // at a time from what has arrived, and the second sentinel asks for the next
  // page once everything that arrived is drawn. The key is the FOLDER, never
  // the sort: re-sorting re-reads in place and must not throw the reader back
  // to the top (a regression the flat reveal once shipped).
  const folderEntries = useMemo<FolderEntry[]>(() => [
    ...folderFiles.map((file) => ({ kind: 'file' as const, file })),
    ...folderDirs.map((dir) => ({ kind: 'dir' as const, dir })),
  ], [folderFiles, folderDirs]);
  const { visible: folderVisible, hasMore: folderRevealMore, sentinelRef: folderSentinelRef } = useChunkedReveal(folderEntries, {
    resetKey: JSON.stringify(['folder', project.id, currentDir]),
    // List view scrolls INSIDE its rounded box (ListBox), not the column.
    rootRef: narrowViewport ? noRoot : (isList ? listScrollRef : flatScrollRef),
    active: !hidden && !flat,
    resetScrollOnActivate: false,
  });
  // The "fetch the next page" sentinel: shown once every arrived entry is
  // drawn and the folder has more on disk.
  const [pageSentinel, setPageSentinel] = useState<HTMLElement | null>(null);
  const pageSentinelRef = useCallback((el: HTMLElement | null) => setPageSentinel(el), []);
  const needNextPage = !flat && !hidden && !folderRevealMore && folderHasMore && moreError === null;
  const loadMoreRef = useRef(loadMoreFolder);
  loadMoreRef.current = loadMoreFolder;
  useEffect(() => {
    if (!needNextPage) return;
    // No observer (jsdom, exotic WebView): fetch rather than strand the folder.
    if (typeof IntersectionObserver === 'undefined') { loadMoreRef.current(); return; }
    if (!pageSentinel) return;
    const root = narrowViewport ? null : (isList ? listScrollRef.current : flatScrollRef.current);
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) loadMoreRef.current(); },
      { root, rootMargin: '400px 0px' },
    );
    io.observe(pageSentinel);
    return () => io.disconnect();
  }, [needNextPage, pageSentinel, narrowViewport, isList, loadedCount]);
  // Content hits minus anything already shown as a name match. Hoisted out of the
  // render below so the "no results" check and the content section agree on one
  // number instead of deduping twice.
  const contentRows = useMemo(
    () => dedupeContentHits(contentHits, new Set(flatResults.map((a) => a.path.replace(/\\/g, '/')))),
    [contentHits, flatResults],
  );
  // A search that matched nothing, anywhere — and isn't still running. Destin
  // originally ruled (2026-07-22) that the "(0)" section headers were enough,
  // then hit it live and asked for the Resume-browser treatment instead
  // (2026-07-23): a real empty state with a way out, since two "(0)" headers and
  // no content read as a dead end.
  const noSearchResults = searching && flatResults.length === 0 && contentRows.length === 0
    && !contentSearching && !allLoading;
  const segments = currentDir ? currentDir.split('/') : [];

  // One file card — reused by both the flat search results and the folder view.
  const renderFileCard = (a: ArtifactRecord) => {
    const filename = a.path.split('/').pop() ?? a.path;
    const isActive = pvActiveId === a.id;
    const isDeleted = a.status === 'deleted';
    return (
      // Fixed h-44 (PITFALL: without a fixed card height the thumbnail flex-shrinks
      // to zero in a short grid row, collapsing cards into blank pills). The
      // thumbnail is flex-1; both text lines are shrink-0 so the card stays uniform.
      <button
        key={a.id}
        type="button"
        // hover-lift replaces `transition-transform duration-200 hover:scale-[1.02]`:
        // same lift on desktop, guarded by @media (hover: hover) so a tap on the
        // Android WebView can't leave the card stuck at 1.02 (spec §9.E).
        className={`layer-surface !rounded-lg relative flex flex-col h-44 overflow-hidden text-left hover-lift ${
          isActive ? 'border-accent' : ''
        } ${isDeleted ? 'opacity-60' : ''}`}
        // No shadow: folder cards are flat, and mixed elevation in one grid read
        // as inconsistent (user feedback 2026-07-08). Same override the seg
        // control uses on its .layer-surface.
        style={{ boxShadow: 'none' }}
        onClick={() => openFile(a)}
        title={isDeleted ? `${a.path}\nDeleted (file is no longer on disk)` : a.path}
      >
        <ArtifactThumbnail
          artifact={a}
          projectPath={project.path}
          className={`flex-1 min-h-0 w-full border-b border-edge-dim ${isDeleted ? 'grayscale' : ''}`}
        />
        {isDeleted && (
          <span
            className="absolute top-2 right-2 px-1.5 py-0.5 text-3xs font-semibold bg-canvas/80 border border-edge rounded text-fg-2"
            aria-label="Deleted"
          >
            deleted
          </span>
        )}
        <span className={`px-2.5 pt-2 pb-0.5 text-xs font-mono truncate w-full text-fg-2 shrink-0 ${isDeleted ? 'line-through' : ''}`}>
          {filename}
        </span>
        {/* In flat mode (search / type filter) show the file's folder for
            context; in folder view the breadcrumb already gives location, so
            show the kind instead. */}
        <span className="px-2.5 pb-2.5 text-3xs text-fg-muted shrink-0 truncate">
          {flat && a.path.includes('/')
            ? a.path.slice(0, a.path.lastIndexOf('/'))
            : kindLabel(a.path)}
        </span>
      </button>
    );
  };

  // ── List view ──────────────────────────────────────────────────────────────
  // Same data, same click target as the cards above — only the drawing differs.
  // A row is icon + filename + kind + when-it-changed (design deck 2026-09-03,
  // Q-3a). The last two columns are max-sm:hidden: on a phone the row keeps the
  // filename, which is the part you're actually reading.
  // Full-bleed blocks (empty states, section headers, the content-hit list) span
  // every grid column in grid view; in the list's flex column they're just w-full.
  const fullW = isList ? 'w-full shrink-0' : 'col-span-full';
  // Shared row shell. `border-b … last:border-b-0` draws the hairlines INSIDE
  // the rounded box that wraps the rows, so the bottom edge stays clean.
  const ROW_CLS = 'w-full flex items-center gap-2.5 px-3 py-2 text-left min-w-0 '
    + 'border-b border-edge-dim last:border-b-0 transition-colors';

  const renderFileRow = (a: ArtifactRecord) => {
    const filename = a.path.split('/').pop() ?? a.path;
    const isActive = pvActiveId === a.id;
    const isDeleted = a.status === 'deleted';
    // In flat mode (search / type filter) the second column carries the file's
    // folder instead of its kind — the same swap the cards make, for the same
    // reason: with no breadcrumb, location is the more useful fact.
    const secondary = flat && a.path.includes('/')
      ? a.path.slice(0, a.path.lastIndexOf('/'))
      : kindLabel(a.path);
    return (
      <button
        key={a.id}
        type="button"
        className={`${ROW_CLS} ${isActive ? 'bg-inset text-fg' : 'hover:bg-well'} ${isDeleted ? 'opacity-60' : ''}`}
        onClick={() => openFile(a)}
        title={isDeleted ? `${a.path}\nDeleted (file is no longer on disk)` : a.path}
      >
        <span className={`shrink-0 ${isActive ? 'text-accent' : 'text-fg-muted'}`}>
          <MiniTypeIcon path={a.path} size={15} />
        </span>
        <span className={`flex-1 min-w-0 truncate text-xs font-mono text-fg-2 ${isDeleted ? 'line-through' : ''}`}>
          {filename}
        </span>
        {isDeleted && (
          <span className="shrink-0 px-1.5 py-0.5 text-3xs font-semibold border border-edge rounded text-fg-muted">
            deleted
          </span>
        )}
        <span className="max-sm:hidden shrink-0 w-32 truncate text-3xs text-fg-muted">{secondary}</span>
        <span className="max-sm:hidden shrink-0 w-20 text-right text-3xs text-fg-muted">
          {relTime(a.lastModified)}
        </span>
      </button>
    );
  };

  const renderFolderRow = (f: FolderSummary) => (
    <button
      key={'dir:' + f.path}
      type="button"
      className={`${ROW_CLS} hover:bg-well`}
      onClick={() => setCurrentDir(f.path)}
      title={f.path}
    >
      <span className="shrink-0 text-accent"><FolderCardIcon size={15} strokeWidth={1.5} /></span>
      <span className="flex-1 min-w-0 truncate text-xs font-mono text-fg-2">{f.name}</span>
      <span className="max-sm:hidden shrink-0 w-32 truncate text-3xs text-fg-muted">
        {itemsLabel(f)}
      </span>
      {/* A folder has no single modified time — the column stays empty rather
          than borrowing one file's date and reading as the folder's. */}
      <span className="max-sm:hidden shrink-0 w-20" />
    </button>
  );

  // A folder card. Its preview is the folder's first few files by name and its
  // count is what sits DIRECTLY inside it ("N items") — the listing reads one
  // level, never the whole subtree, which is what keeps a huge folder instant.
  // (It said "N files", counted recursively, while the view was carved out of
  // the capped whole-project walk.)
  const renderFolderCard = (f: FolderSummary) => {
    // The listing sends a card's first few files already (FOLDER_SAMPLE_FILES).
    const previewFiles = f.samples;
    return (
          // Folder cards have a distinct FOLDER SHAPE — a tab on the top-left
          // plus a body that previews the contents as a FILENAME LIST (the
          // first few files inside, tiny type icon + name — user-picked over
          // the old 2x2 thumbnail grid, which read as clutter). The name +
          // count live INSIDE the folder body (a footer below the preview),
          // so they read as part of the folder, not a caption floating
          // beneath it.
          <button
            key={'dir:' + f.path}
            type="button"
            // hover-lift: see the doc-card comment above — the scale is
            // guarded by @media (hover: hover) for the Android WebView.
            className="group relative flex flex-col h-44 text-left hover-lift"
            onClick={() => setCurrentDir(f.path)}
            title={f.path}
          >
            {/* Folder tab (nub). ml-4 clears the body's rounded top-left
                corner. The nub carries its OWN bottom border and overlaps
                the body by exactly 1px (-mb-px), so its border sits ON the
                body's top border: the separating line stays visible across
                the joint AND there's no seam gap at fractional zoom levels.
                (border-b-0 + overlap covered the line; border-b-0 without
                overlap left a subpixel gap — both were reported.) */}
            <div className="relative -mb-px ml-4 h-3 w-14 rounded-t-md bg-panel border border-edge group-hover:border-accent/60 transition-colors" />
            {/* Folder body — preview AND the name/count footer, all inside one
                bordered, rounded container so they read as the same folder.
                All four corners rounded — the old rounded-tl-none square
                corner under the tab read as a glitch, not a folder. bg-panel
                (not bg-inset) so the folder body matches the file card's
                .layer-surface background — the two card kinds previously
                used different tokens and read as mismatched (user feedback
                2026-07-19). */}
            <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-edge bg-panel overflow-hidden group-hover:border-accent/60 transition-colors">
              <div className="flex-1 min-h-0 overflow-hidden">
                {previewFiles.length > 0 ? (
                  <div className="flex flex-col gap-1.5 p-2.5">
                    {/* First few filenames only — no overflow line (the
                        footer's "N items" count already tells the rest). */}
                    {previewFiles.map((s) => (
                      <div key={s.id} className="flex items-center gap-1.5 min-w-0">
                        <span className="text-fg-muted shrink-0"><MiniTypeIcon path={s.path} /></span>
                        <span className="text-2xs text-fg-2 truncate">{fileNameOf(s)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  // No previewable files (a folder of subfolders) — folder glyph.
                  <div className="h-full w-full flex items-center justify-center bg-well text-accent">
                    <FolderCardIcon size={40} strokeWidth={1.5} />
                  </div>
                )}
              </div>
              {/* Footer inside the folder: name (with accent folder glyph) + count.
                  bg-panel + the doc-caption typography (12px mono fg-2 name,
                  10.5px fg-muted second line) — same token as the folder
                  body above, so the whole card and the doc cards share one
                  background color. */}
              <div className="shrink-0 border-t border-edge-dim px-2.5 py-1.5 bg-panel">
                <div className="text-xs font-mono text-fg-2 flex items-center gap-1.5">
                  <span className="text-accent shrink-0"><FolderCardIcon size={13} strokeWidth={1.5} /></span>
                  <span className="truncate">{f.name}</span>
                </div>
                <div className="text-3xs text-fg-muted pl-[20px]">
                  {itemsLabel(f)}
                </div>
              </div>
            </div>
          </button>
    );
  };

  // The end of a folder whose next page failed: what stopped it, and Retry.
  const renderMoreError = () => moreError && (
    <ErrorState
      mode="recoverable"
      message={`${folderErrorMessage(moreError.error, moreError.detail, false, project.path)} Some of this folder isn’t shown.`}
      onRetry={() => loadMoreRef.current()}
    />
  );
  const emptyHere = !flat && !folderLoading && folderError === null && loadedCount === 0 && !folderHasMore;
  // Which request the loading line and the load error belong to right now.
  const loading = flat ? allLoading : folderLoading;

  return (
    // `hidden` REPLACES the layout classes rather than riding alongside them —
    // `hidden` and `flex` are both display utilities, so keeping both would
    // leave which one wins up to their order in the generated stylesheet.
    <div className={hidden ? 'hidden' : 'relative flex flex-col h-full overflow-hidden px-2 sm:px-4 pt-4 pb-4 gap-3 min-w-0 max-sm:h-auto max-sm:overflow-visible'}>
      {!hidden && currentDir && <ScreenMark name={`projects/files/folder/${currentDir}`} />}
      {/* Breadcrumb line — folder path on the left, view switch on the right.
          Rendered even when search/type-filter has flattened the tree (which
          hides the path itself): the switch has to stay reachable while you
          search, and a row that disappears under you reads as a bug. */}
      <div className="flex items-center justify-between gap-3 shrink-0 min-w-0">
        {!flat ? (
        <div className="flex items-center gap-1 text-xs flex-wrap min-w-0">
          <button
            type="button"
            onClick={() => setCurrentDir('')}
            className={currentDir ? 'text-fg-muted hover:text-fg transition-colors' : 'text-fg-2 font-medium'}
          >
            {rootLabel}
          </button>
          {segments.map((seg, i) => {
            const p = segments.slice(0, i + 1).join('/');
            const last = i === segments.length - 1;
            return (
              <React.Fragment key={p}>
                <span className="text-fg-faint">/</span>
                <button
                  type="button"
                  onClick={() => setCurrentDir(p)}
                  className={`truncate max-w-[200px] ${last ? 'text-fg-2 font-medium' : 'text-fg-muted hover:text-fg transition-colors'}`}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </div>
        ) : <span />}
        {/* Minified switch: two bare icon buttons, no pill behind them — this
            line is quieter than the toolbar row and a filled pill here would
            outweigh the breadcrumb next to it. The active one is the accent
            colour rather than an accent fill. */}
        <div className="shrink-0 flex items-center gap-0.5" role="radiogroup" aria-label="File view">
          {([
            { id: 'grid' as const, label: 'Grid view', icon: <GridViewIcon size={14} /> },
            { id: 'list' as const, label: 'List view', icon: <ListViewIcon size={14} /> },
          ]).map((v) => {
            const active = view === v.id;
            return (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={v.label}
                aria-label={v.label}
                onClick={() => onViewChange(v.id)}
                className={`p-1 rounded-md inline-flex items-center justify-center transition-colors ${
                  active ? 'text-accent bg-inset' : 'text-fg-muted hover:text-fg hover:bg-inset'
                }`}
              >
                {v.icon}
              </button>
            );
          })}
        </div>
      </div>

      {loading && (
        <p className="text-sm text-fg-muted">Loading {noun}…</p>
      )}
      {flat && !allLoading && allError !== null && (
        <div className="max-w-md mt-4 mx-auto">
          <ErrorState
            mode="recoverable"
            message={allError ? `Couldn’t load your files: ${allError}` : 'Couldn’t load your files.'}
            onRetry={() => setRetryToken((t) => t + 1)}
          />
        </div>
      )}
      {/* A folder the listing could not read: the real reason and a Retry,
          never an empty folder (spec 2026-09-18 §8). The breadcrumb above
          stays, so the way back out is always one click. */}
      {!flat && !folderLoading && folderError !== null && (
        <div className="max-w-md mt-4 mx-auto">
          <ErrorState
            mode="recoverable"
            message={folderErrorMessage(folderError.error, folderError.detail, currentDir === '', project.path)}
            onRetry={() => setRetryToken((t) => t + 1)}
          />
        </div>
      )}
      {/* Search mode's empty state is the EmptyState in the grid below (it
          replaces the "(0)" headers). This line is for the type-filter flatten,
          which has no headers and no search to clear. */}
      {!loading && flat && !searching && flatResults.length === 0 && (
        <p className="text-sm text-fg-muted">Nothing matches the current filters.</p>
      )}
      {emptyHere && (
        <p className="text-sm text-fg-muted">
          {currentDir ? 'This folder is empty.' : 'No files found in this project folder.'}
        </p>
      )}

      {/* p-2 gives the hover scale-up room INSIDE the scroll clip box so edge-column
          and first-row cards don't clip; -m-2 cancels that padding's position so the
          cards still line up with the breadcrumb above (the 8px sits in the parent's
          px-4/pt-4 gutter, well inside its clip). */}
      {/* grid-cols-2 on narrow: auto-fill/minmax(180px) correctly falls back to
          ONE column at 390px, but that makes each card a ~342x176 slab — much
          wider than tall, nothing like the intended card proportion. Two ~165px
          columns read correctly on a phone. */}
      {/* List view is a plain column — no card hover-lift, so it needs none of
          the p-2/-m-2 overflow room the grid does. */}
      <div ref={flatScrollRef} className={isList
        ? `flex-1 min-h-0 flex flex-col gap-2 content-start max-sm:overflow-visible ${
            flat ? 'overflow-auto' : 'overflow-hidden'}`
        : 'flex-1 overflow-auto max-sm:overflow-visible grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 content-start p-2 -m-2'}>
        {flat
          ? (
            <>
              {/* Nothing matched anywhere: one empty state WITH a way out, instead
                  of two bare "(0)" headers over blank space (Destin, 2026-07-23).
                  Same EmptyState + action pattern as the Resume browser. */}
              {noSearchResults && (
                <div className={fullW}>
                  <EmptyState
                    message={<>No {noun} match “{search.trim()}”.</>}
                    action={onClearSearch ? { label: 'Clear search', onClick: onClearSearch } : undefined}
                  />
                </div>
              )}
              {searching && !noSearchResults && (
                <div className={`${fullW} text-3xs uppercase tracking-wider text-fg-muted mb-0.5 px-0.5`}>
                  Matches by file name ({flatResults.length})
                </div>
              )}
              {isList
                ? <div className={fullW}><ListBox>{flatVisible.map(renderFileRow)}</ListBox></div>
                : flatVisible.map(renderFileCard)}
              {/* The reveal's sentinel. Different keys per view so a grid ↔ list
                  switch REPLACES the element (the hook re-arms on the new one)
                  rather than React reusing a node that moved. col-span-full
                  keeps it from taking a grid cell. */}
              {flatHasMore && (isList
                ? <div key="list" ref={flatSentinelRef} className="h-px shrink-0" aria-hidden />
                : <div key="grid" ref={flatSentinelRef} className="col-span-full h-px" aria-hidden />)}
              {searching && !noSearchResults && (() => {
                const rows = contentRows;
                // Group + sort BEFORE capping, so the biggest groups survive the cut.
                const all = groupContentHits(rows);
                const { groups, shownRows, capped: displayCapped } = capGroups(all, MAX_CONTENT_ROWS);
                const capped = contentTruncated || displayCapped;
                return (
                  <div className={`${fullW} min-w-0`}>
                    <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase mt-2 mb-1.5 px-0.5">
                      Matches by file contents ({shownRows}{capped ? '+' : ''})
                    </div>
                    <div className="flex flex-col gap-2">
                      {groups.map((group) => {
                        const filename = group.path.split('/').pop() ?? group.path;
                        const dir = group.path.slice(0, group.path.length - filename.length);
                        const expanded = expandedGroups.has(group.path);
                        return (
                          <div key={group.path} className="rounded-md border border-edge-dim overflow-hidden">
                            {/* Group header toggles the hit list (collapsed by default). */}
                            <button
                              type="button"
                              onClick={() => toggleGroup(group.path)}
                              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left min-w-0 bg-well/60 hover:bg-well transition-colors ${expanded ? 'border-b border-edge-dim' : ''}`}
                              title={group.path}
                            >
                              <ChevronIcon className="w-3 h-3 shrink-0" expanded={expanded} />
                              <span className="text-xs font-mono font-medium text-fg-2 shrink-0">{filename}</span>
                              {dir && <span className="text-2xs font-mono text-fg-muted truncate min-w-0">{dir}</span>}
                              <span className="text-2xs text-fg-muted shrink-0 ml-auto">
                                {group.hits.length} {group.hits.length === 1 ? 'match' : 'matches'}
                              </span>
                            </button>
                            {expanded && group.hits.map((hit, i) => (
                              <button
                                key={`${hit.line}:${i}`}
                                type="button"
                                onClick={() => openContentHit(hit)}
                                className="w-full flex items-baseline gap-2 pl-7 pr-2.5 py-1 text-left min-w-0 hover:bg-well transition-colors"
                                title={`${group.path}:${hit.line}`}
                              >
                                <span className="text-2xs font-mono text-fg-muted shrink-0 w-8 text-right">{hit.line}</span>
                                <span className="text-xs font-mono text-fg-dim truncate min-w-0 flex-1">{hit.text}</span>
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </>
          )
          : isList
          ? (
            // Same order as the cards: loose files first, then subfolders.
            <ListBox scrolls scrollRef={listScrollRef}>
              {folderVisible.map((e) => (e.kind === 'file' ? renderFileRow(e.file) : renderFolderRow(e.dir)))}
              {/* The reveal's sentinel, then the next-page sentinel — inside the
                  box, because in list view the box is what scrolls. */}
              {folderRevealMore && <div ref={folderSentinelRef} className="h-px shrink-0" aria-hidden />}
              {needNextPage && <div ref={pageSentinelRef} className="h-px shrink-0" aria-hidden />}
              {moreError && <div className="p-2">{renderMoreError()}</div>}
            </ListBox>
          )
          : (
            <>
              {/* Files directly in this folder FIRST, then subfolders (per request:
                  single files sort before folders) — the listing sends that order. */}
              {folderVisible.map((e) => (e.kind === 'file' ? renderFileCard(e.file) : renderFolderCard(e.dir)))}
              {folderRevealMore && <div key="grid-folder" ref={folderSentinelRef} className="col-span-full h-px" aria-hidden />}
              {needNextPage && <div key="grid-page" ref={pageSentinelRef} className="col-span-full h-px" aria-hidden />}
              {moreError && <div className="col-span-full">{renderMoreError()}</div>}
            </>
          )}
      </div>

      {/* Truncation note — the whole-project walk behind search and the type
          filter hit a cap. Never let a partial list read as complete. Folder
          browsing has no cap, so this only shows while flat (until Stage 2's
          background index replaces the walk). */}
      {flat && truncated && (
        <p className="text-2xs text-fg-muted shrink-0">
          This folder is large — showing the first batch of files. Some documents deeper in the
          folder aren't listed.
        </p>
      )}

      {/* Selected-artifact detail — rendered in the shared centered overlay
          (Task 2.4). Same load/view/edit/exclude behavior as the prior inline
          detail; only the presentation changed (full-bleed → centered overlay). */}
      {/* `!hidden`: the open-file overlay must not survive a switch to another
          tab. It registers on the shared Escape stack (which also drives
          Android's back button), and a display:none overlay still sitting on
          that stack eats the first Escape press on the Conversations tab —
          Project View would appear not to close. The selection itself lives in
          ArtifactContext, so coming back to Files re-opens the same file,
          exactly as it did when the whole tab was unmounted. */}
      {activeArtifact && !hidden && (
        <ArtifactDetail
          artifact={activeArtifact}
          project={project}
          artifactDispatch={dispatch}
          initialLine={pendingReveal?.id === activeArtifact.id ? pendingReveal.line : undefined}
          onInitialLineConsumed={() => setPendingReveal(null)}
        />
      )}
    </div>
  );
}

// WHY memo: this tab is kept mounted while hidden for its watcher (09-09);
// without memo every Project View render — each tab click — redrew the whole
// hidden grid. And it must not read ArtifactContext itself, because memo cannot
// stop a context reader and that context changes on every file any session
// writes (render-cost consolidation 2026-09-18). Guarded by the ast-grep rules
// filestab-memoized and filestab-no-artifact-context.
export const FilesTab = React.memo(FilesTabImpl);

// ─── ArtifactDetail ───────────────────────────────────────────────────────────
// Selected-artifact detail, now hosted in the shared centered ProjectDetailOverlay
// (Task 2.4) instead of a full-bleed inline pane. Uses the shared
// ActiveArtifactView with the same props as before. The Exclude action lives in
// a small action row inside the overlay body so it stays reachable.

interface DetailProps {
  artifact: ArtifactRecord;
  project: CentralIndexProject;
  // ArtifactContext's dispatch, passed down from FilesTab rather than read with
  // useArtifact(): nothing in this file reads that context (see FilesTab's memo
  // comment, and the ast-grep rule filestab-no-artifact-context).
  artifactDispatch: React.Dispatch<ArtifactAction>;
  // WHY: `onRefreshArtifacts` removed — ArtifactDetail accepted it but never
  // called it. The parent (FilesTab) passes `onMutated` directly to the
  // ActiveArtifactView inside; refresh signaling doesn't flow through this
  // component. Found in the 2026-08-06 sweep.
  /** Search jump-to-hit: reveal this 1-indexed line once content loads.
   * Consumed exactly once (onInitialLineConsumed) so reopening the same file
   * later does not re-jump to a stale line. */
  initialLine?: number;
  onInitialLineConsumed?: () => void;
}

function ArtifactDetail({ artifact, project, artifactDispatch: dispatch, initialLine, onInitialLineConsumed }: DetailProps) {
  // Read lifecycle (fetch + loading/missing/error phases) — shared hook, same
  // as SessionDrawer, so a slow read shows a placeholder instead of flashing
  // "This file is no longer on disk."
  const { content, setContent, contentInfo, contentState, retryRead, applyDiskRead } =
    useArtifactContent(project.path, artifact.id, artifact.path);
  // Drive the viewer's edit lifecycle from the overlay header (controlsInHeader).
  // ActiveArtifactView still owns the edit/save/conflict logic; we only call into
  // it and mirror its edit state so the header can swap Edit ↔ Save/Cancel.
  const viewRef = useRef<ActiveArtifactHandle>(null);
  const [editState, setEditState] = useState({ isEditable: false, editing: false });
  const [copied, setCopied] = useState(false);

  const filename = artifact.path.split('/').pop() ?? artifact.path;
  const absPath = artifactAbsPath(project.path, artifact);

  // D3: closing the overlay with unsaved edits prompts Save/Discard/Cancel
  // instead of silently discarding the draft.
  const { guard: guardUnsaved, dialog: unsavedDialog } = useUnsavedGuard(viewRef, filename);
  const handleClose = () => guardUnsaved(() =>
    dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION }));

  // Search jump-to-hit: fire once, only after content resolved (the editor
  // mounts then; revealLine itself retries across the lazy-chunk window).
  const revealedRef = useRef(false);
  useEffect(() => { revealedRef.current = false; }, [artifact.id]);
  useEffect(() => {
    if (revealedRef.current || initialLine == null || content === null) return;
    revealedRef.current = true;
    viewRef.current?.revealLine(initialLine);
    onInitialLineConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, initialLine, artifact.id]);

  const isElectron = getPlatform() === 'electron';
  const handleReveal = () => (window.claude as any).shell?.showItemInFolder?.(absPath);
  // Open the file with the OS default app (HTML→browser, .docx→Word, etc.) —
  // the right action for formats the in-app viewer can't render (html) or only
  // renders partially (docx/xlsx). Desktop-only (shell.openPath); no-op on remote.
  const handleOpenExternal = () => (window.claude as any).shell?.openPath?.(absPath);
  // Project and record along with the path (T7 review, finding 9).
  const handleDownload = () => { void downloadFile(absPath, { projectRoot: project.path, artifactId: artifact.id }); };
  const narrowViewport = useNarrowViewport();
  const handleCopyPath = () => {
    navigator.clipboard?.writeText(absPath).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable — ignore */ });
  };

  // Header tools: Edit ↔ Save/Cancel (only for editable formats) + Reveal + Copy.
  const tools = (
    <>
      {editState.isEditable && (editState.editing ? (
        <>
          <button type="button" className={TOOL_BTN_ACCENT} onClick={() => viewRef.current?.saveEdit()}>
            <CheckIcon size={13} />
            Save
          </button>
          <button type="button" className={TOOL_BTN_NEUTRAL} onClick={() => viewRef.current?.cancelEdit()}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className={TOOL_BTN_ACCENT} onClick={() => viewRef.current?.startEdit()}>
          <PencilIcon size={13} />
          Edit
        </button>
      ))}
      {/* shell.openPath / showItemInFolder are desktop-only — remote stubs them
          as no-ops and Android has no handler. Gate on isElectron so the
          buttons can't render dead, matching SessionDrawer's toolbar. */}
      {isElectron && (
        <>
          <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleOpenExternal} title="Open with the default app">
            <ExternalLinkIcon size={13} />
            Open
          </button>
          <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleReveal}>
            <FolderIcon size={13} />
            Reveal
          </button>
        </>
      )}
      {/* Remote access batch 3 (questions deck 2026-09-10, Q-7 yes): a phone gets
          Download where the desktop has Open and Reveal — the file lands in the
          phone's own downloads folder, and the transfer does not block the chat. */}
      {isRemoteMode() && (
        <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleDownload} aria-label="Download" title="Download">
          <DownloadIcon size={13} />
          {/* Icon-only at phone width: with the label, Download and Copy path
              left the file name one syllable ("latenc…") — tester U20. */}
          {!narrowViewport && 'Download'}
        </button>
      )}
      <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleCopyPath}>
        <LinkIcon size={13} />
        {copied ? 'Copied' : 'Copy path'}
      </button>
    </>
  );

  const modifiedAt = relTime(artifact.lastModified);
  // Discovered files were found on disk (no tracked edit history) — label the
  // timestamp as the file's modified time, not a YouCoded "edited" event.
  const meta = artifact.discovered ? (
    <>
      <span>on disk</span>
      {modifiedAt && (<><span className="text-fg-faint">·</span><span>modified {modifiedAt}</span></>)}
    </>
  ) : (
    <>
      <span>edited</span>
      {modifiedAt && (<><span className="text-fg-faint">·</span><span>{modifiedAt}</span></>)}
    </>
  );

  return (
    <ProjectDetailOverlay title={filename} onClose={handleClose} tools={tools} meta={meta}>
      {unsavedDialog}
      {/* The viewer owns its own scroll; fill the overlay body height. */}
      <div className="h-full min-h-0">
        <ActiveArtifactView
          ref={viewRef}
          artifact={artifact}
          content={content}
          contentInfo={contentInfo}
          contentState={contentState}
          onRetryRead={retryRead}
          projectRoot={project.path}
          projectId={project.id}
          projectName={project.name}
          sessionId="project-view"
          onContentChange={setContent}
          onDiskRead={applyDiskRead}
          controlsInHeader
          onEditStateChange={setEditState}
        />
      </div>
    </ProjectDetailOverlay>
  );
}
