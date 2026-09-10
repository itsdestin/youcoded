// ProjectView — full-screen overlay shell for the project browser (Task 2.1 redesign).
// Opened by the Projects button in HeaderBar (or via dispatch({ type: 'PROJECT_VIEW_OPENED' })).
// Renders nothing when state.projectViewOpen is false.
//
// z-40 — the SCREEN layer, shared with Marketplace and Library (change 26). Screens
// sit BELOW every L1-L4 overlay on purpose: a toast, context menu, or AnchorTip that
// fires while Projects is open must be visible, and at the old z-[8000] it was
// silently swallowed. Nothing relies on Projects out-stacking a drawer — every L1
// drawer (Settings, CommandDrawer, ResumeBrowser) mounts a full-screen z-40 scrim
// that eats the header click, so a drawer and this view can't be co-opened.
// ⚠ Raising this again re-hides spontaneous overlays; fix the overlay instead.
//
// This file is the composed SHELL: header + project list + segmented tab control +
// tab routing. The artifact grid lives in tabs/FilesTab; Conversations/Context
// tabs are filled by later tasks. The project-deletion modal + project list stay
// here (project-scoped). The "+ Add external file" affordance moved into
// FilesTab (artifact-scoped) since it operates on the active project's artifacts.
import React, { useEffect, useRef, useState } from 'react';
import { useArtifact } from '../../state/ArtifactContext';
import { useEscClose } from '../../hooks/use-esc-close';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { formatRelativeTime } from '../../utils/format-time';
import type { CentralIndexProject, ArtifactRecord } from '../../../shared/artifacts/types';
import type { PastSession } from '../../../shared/types';
import type { ContextFile, ContextGroup, ContextScope } from '../../../shared/project-context-types';
import type { FileTypeGroup } from '../../../shared/artifacts/categorization';
import type { FileSortKey, FileViewMode } from './tabs/FilesTab';

// Enriched session shape returned by project:list-conversations (preview only —
// see project-conversations.ts for why there's no message count).
type ConversationSummary = PastSession & { preview?: string };
import { FilesTab } from './tabs/FilesTab';
import { ConversationsTab } from './tabs/ConversationsTab';
import { ContextTab } from './tabs/ContextTab';
import { ConversationPreview } from './ConversationPreview';
import { ProjectHero, formatFileCount } from './ProjectHero';
import { ProjectsEmptyCard } from './ProjectsEmptyCard';
import { ProjectSwitcher } from './ProjectSwitcher';
import { syncDotFor, findSpaceFor, lastSyncedLabel, type SyncStatusData } from '../sync-dot-state';
import AddProjectModal from './AddProjectModal';
import ImportProjectModal from '../ImportProjectModal';
import { FileFilterPopover } from './FileFilterPopover';
import { HowContextWorksPopup } from './HowContextWorksPopup';
import { ContextEditorOverlay } from './ContextEditorOverlay';

// 2026-07-23: the Artifacts tab merged into Files. Artifacts was not a subset of
// All files, so the merge moved externals into their own section inside this tab
// rather than deleting them — see the file-merge spec.
type TabId = 'files' | 'conversations' | 'context';

// Live hero stats, computed from the project:* / artifacts:* IPC (not the stale
// stats.artifactCount). null repo means the project folder has no git remote.
// 2026-07-23: the `artifacts` count was dropped when the Artifacts tab merged
// into Files — there is no longer a separate Claude-authored count to show.
interface HeroStats {
  // null = gated root (home dir / drive root — no scan runs, no number).
  files: number | null;
  // Discovery hit a cap — render "N+" so a sample never poses as exact.
  filesTruncated?: boolean;
  conversations: number;
  contextFiles: number;
  activeLabel: string;
}
interface HeroRepo { webUrl?: string; owner?: string; name?: string }


// Shared lucide-style glyphs live in ./icons.tsx (previously each file carried
// its own copies of the same paths). GridIcon (the old Artifacts segment icon)
// and InfoIcon (the Artifacts-vs-All-files explainer) were both removed here
// 2026-07-23 when the Artifacts tab merged into Files — one tab needs neither.
// The search + sliders glyphs live in SearchFilterPill, shared with the drawer.
// CloseButton is the shared screen-exit affordance (UI tranche 4, change 27).
import { ChatIcon, FolderIcon, DocIcon } from './icons';

// Files-tab view preference (thumbnail grid vs. compact list). One value for the
// whole app, on this device — see the state comment in ProjectView.
const FILE_VIEW_KEY = 'youcoded.projectView.fileView';
function readStoredFileView(): FileViewMode {
  try {
    return localStorage.getItem(FILE_VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch { return 'grid'; } // storage blocked (some Android WebView configs)
}
import { Button, Checkbox, CloseButton, SearchFilterPill } from '../ui';
import { ImportFileDialog } from './ImportFileDialog';

interface ProjectViewProps {
  // cwd of the conversation that is focused RIGHT NOW (undefined on the welcome
  // screen). Project view re-homes to this folder's project on every open — see
  // the load effect. Not used for anything else.
  activeSessionCwd?: string;
  // Threaded from App: starts a new conversation in the given cwd.
  onNewConversation: (cwd: string) => void;
  // provider threads the row's runtime so App's resume takes the native path
  // (pre-resume model picker) for a native conversation instead of the CC path.
  onResumeConversation: (sessionId: string, projectSlug: string, projectPath: string, provider?: string) => void;
}

// Basename of a picked path, for naming the file a failure is ABOUT.
const baseName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() || p;

// Task 6: human wording for the two importFile failure codes that need it —
// see artifacts/import-file.ts. Every other code falls through to
// `${error}: ${detail}` — a real code beats a friendly guess, and NEVER guess
// at a cause we haven't verified.
//   needs-confirm  → the destination is a .claude/ path or a dotenv, which
//                    main refuses without a protected-path confirm (the
//                    Move/Copy dialog only asks copy-vs-move, not "you're
//                    about to overwrite your .env").
//   MOVE_SOURCE_NOT_REMOVED → the copy SUCCEEDED and the original is still in
//                    place. Report the partial outcome truthfully — the move
//                    did not fail, only half of it did.
// `source` is the file the user picked, and every line names it. WHY: for
// needs-confirm main's `detail` is the refused DESTINATION — which for a
// destination-folder refusal is the folder, so a 3-file batch used to print the
// same "/home/d/proj/.claude was NOT imported" three times, naming a directory
// nobody tried to import. The destination is still reported (it's the real,
// verified detail), it just isn't the subject of the sentence.
export function describeImportFailure(r: { error: string; detail?: string }, source?: string): string {
  const who = source ? baseName(source) : 'That file';
  if (r.error === 'needs-confirm') {
    return `${who} was NOT imported${r.detail ? ` — ${r.detail} is a protected path` : ' — the destination is a protected path'} (inside .claude/ or a dotenv) that needs explicit confirmation this dialog doesn't ask for.`;
  }
  if (r.error === 'MOVE_SOURCE_NOT_REMOVED') {
    return `${who} was copied into the project, but the original could not be removed${r.detail ? ` (${r.detail})` : ''} — both copies exist now.`;
  }
  const code = r.detail ? `${r.error}: ${r.detail}` : r.error;
  return source ? `${who} — ${code}` : code;
}

// Title for the import-result modal. It is NOT always a failure: a move whose
// copy landed but whose original couldn't be removed is a partial success, and
// "already in place" (the file is the one you picked it from) isn't an error at
// all. Titling all three "Import failed" over those bodies was a lie.
export function importResultTitle(r: { hardFailures: number; partial: number; alreadyInPlace: number }): string {
  if (r.hardFailures > 0) return 'Import failed';
  if (r.partial > 0) return 'Import partly finished';
  if (r.alreadyInPlace > 0) return 'Nothing to import';
  return 'Import finished';
}

// Find the indexed project whose folder IS `cwd`. Match by PATH, not id: a
// synth (saved-folder) project's id is its canonical path until it gains a
// central-index entry, at which point the id changes to a real ULID — path
// matching survives that promotion. Separator + case normalization mirrors
// useActiveProject.ts, because Windows paths reach us spelled either way.
export function matchProjectByPath<T extends { path: string }>(
  projects: T[], cwd: string | undefined,
): T | null {
  if (!cwd) return null;
  const slashed = cwd.replace(/\\/g, '/');
  return projects.find(
    (p) => p.path === cwd || p.path === slashed || p.path === slashed.toLowerCase(),
  ) ?? null;
}

export function ProjectView(props: ProjectViewProps) {
  const { state, dispatch } = useArtifact();
  const [projects, setProjects] = useState<CentralIndexProject[]>([]);
  // WHY a separate flag: `projects` starts as `[]`, which is ALSO what a
  // brand-new install's index returns. Without this the first-run explainer
  // (ProjectsEmptyCard) would flash on every open for the beat before the
  // index answers. False until phase 1 of the load below resolves.
  const [indexLoaded, setIndexLoaded] = useState(false);
  const [activeProject, setActiveProject] = useState<CentralIndexProject | null>(null);
  // Latest focused-conversation cwd, held in a ref so the load effect can read
  // it WITHOUT depending on it. A dep would re-run the whole open-time load —
  // and re-home the selection — if the focused session's cwd changed while the
  // view is open, yanking the project out from under the user mid-browse.
  const activeCwdRef = useRef(props.activeSessionCwd);
  activeCwdRef.current = props.activeSessionCwd;
  const [tab, setTab] = useState<TabId>('files');
  // Artifacts search query (lifted out of FilesTab so it can sit on the
  // shared seg-row next to the segmented control, matching the design).
  const [artifactSearch, setArtifactSearch] = useState('');
  // Type filter + sort for the Files tab — lifted here (like search) so they
  // live on the seg-row next to the segmented control. These are EXPLICIT,
  // visible controls the user sets — the badge counts stay folder totals, so a
  // filtered grid never silently redefines what "N files" means.
  // Multi-select type filter; EMPTY set = all types (Destin, 2026-07-23).
  const [types, setTypes] = useState<ReadonlySet<FileTypeGroup>>(() => new Set());
  const [fileSort, setFileSort] = useState<FileSortKey>('name');
  // Grid vs. list for the Files tab. Remembered app-wide, NOT per project
  // (design deck 2026-09-03, Q-4a): one answer to "what view am I in" is
  // predictable; a view that changes as you switch projects reads as a glitch.
  // localStorage, like the other small per-device UI preferences (ModelPicker
  // favourites, the context intro banner) — reads and writes are wrapped
  // because some Android WebView configurations throw on access.
  const [fileView, setFileView] = useState<FileViewMode>(readStoredFileView);
  useEffect(() => {
    try { localStorage.setItem(FILE_VIEW_KEY, fileView); } catch { /* storage blocked */ }
  }, [fileView]);
  // Filter popover (behind the sliders icon in the search pill). Click-outside
  // is handled HERE with a wrapper ref that contains both the trigger and the
  // popover — putting it inside the popover would race the trigger's own click
  // (mousedown-close then click-reopen).
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
  // Close the popover when the active tab changes — its trigger belongs to the
  // file tabs, and leaving it open across a tab switch would strand it.
  useEffect(() => { setFilterOpen(false); }, [tab]);
  // Bumped after "Add external file" so FilesTab re-loads its list without
  // owning the add flow (the toolbar lives up here now).
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped by FilesTab after an in-tab sidecar mutation (exclude) so the hero
  // counts refetch WITHOUT forcing a FilesTab reload (which would reset the
  // breadcrumb + selection). refreshKey and countsKey both feed the hero
  // effect; only refreshKey feeds FilesTab.
  const [countsKey, setCountsKey] = useState(0);
  // Task 6: "+ Add file" Move/Copy flow. currentRelDir mirrors FilesTab's own
  // currentDir (reported up via onCurrentDirChange) so ProjectView knows WHERE
  // to import into — FilesTab is a breadcrumb tree, so landing everything at
  // the project root would be surprising once the user has navigated in.
  // FilesTab resets its currentDir to '' on every project switch, and that
  // reset flows through the same callback, so this needs no separate reset.
  const [currentRelDir, setCurrentRelDir] = useState('');
  // Files picked from the native dialog, staged for the Move/Copy confirm
  // dialog. collisions = basenames among sources that already exist in the
  // destination folder, computed BEFORE the dialog opens (see importFiles).
  const [pendingImport, setPendingImport] = useState<{ sources: string[]; collisions: string[] } | null>(null);
  // Import outcomes worth reading, surfaced as a non-transient modal (Scrim +
  // OverlayPanel, same pattern as the project-deletion modal below) rather than
  // a Toast — describeImportFailure above gives the two special-cased codes
  // human wording; everything else is the real error code + detail. A Toast
  // auto-dismisses on a timer with NO manual dismiss control (see Toast.tsx),
  // and these lines name a specific protected path that was not imported,
  // report a partial move, or say a file was already where it was headed — the
  // user needs to notice and may need to act, and a multi-file batch reads as
  // several lines, which an 8s timer doesn't give enough time to re-read.
  // `title` is computed per batch (importResultTitle) because not every one of
  // these outcomes is a failure.
  const [importResult, setImportResult] = useState<{ title: string; lines: string[] } | null>(null);

  // Hero data (recomputed when the active project changes).
  const [heroStats, setHeroStats] = useState<HeroStats>({
    files: 0, conversations: 0, contextFiles: 0, activeLabel: '—',
  });
  const [heroRepo, setHeroRepo] = useState<HeroRepo | null>(null);

  // Lifted, per-project-cached tab data. Both the hero counts and the tab bodies
  // read these, so conversations/context are fetched ONCE per project switch
  // (not once for the hero AND once for the tab) and re-selecting a project or
  // toggling tabs is instant. null = still loading for the active project.
  const convCache = useRef<Map<string, ConversationSummary[]>>(new Map());
  const ctxCache = useRef<Map<string, ContextGroup[]>>(new Map());
  // Which project the hero effect last ran for — lets a counts refresh (same
  // project) skip the reset-to-zero that a real project switch needs.
  const prevHeroProjectRef = useRef<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [context, setContext] = useState<ContextGroup[] | null>(null);

  // Project switcher palette state (rendered at the bottom of this component).
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Selected conversation for the preview overlay — the ConversationsTab
  // bubbles a click up; <ConversationPreview> renders it below.
  const [previewSession, setPreviewSession] = useState<PastSession | null>(null);

  // Project deletion modal state.
  const [deletingProject, setDeletingProject] = useState<CentralIndexProject | null>(null);
  const [alsoDeleteSidecar, setAlsoDeleteSidecar] = useState(false);

  // Per-project sync state (spec §4) — feeds the hero sync line + switcher dots.
  const [syncStatus, setSyncStatus] = useState<SyncStatusData | null>(null);
  // Unified "Add a project" modal (replaces the old direct folder-picker flow).
  const [addOpen, setAddOpen] = useState(false);
  // Turn-on-sync consent modal for the ACTIVE project (hero button).
  const [turnOnSyncFor, setTurnOnSyncFor] = useState<{ path: string; name: string } | null>(null);

  // Context tab selection state. The ContextTab bubbles a clicked file (to edit)
  // or a clicked group's (i) info button (to explain the scope) up to here;
  // ContextEditorOverlay / HowContextWorksPopup render them below.
  const [editingContext, setEditingContext] = useState<ContextFile | null>(null);
  const [infoScope, setInfoScope] = useState<ContextScope | null>(null);

  // ESC closes the browser via the shared LIFO stack — the header says
  // "Esc · Back to chat", so the key must actually work. Child overlays
  // (detail, switcher, editor, delete modal) register later → they pop first.
  useEscClose(state.projectViewOpen, () => dispatch({ type: 'PROJECT_VIEW_CLOSED' }));
  // The delete-confirm modal takes Esc priority while open (registered after
  // the browser's own handler because it mounts later — LIFO).
  useEscClose(!!deletingProject, () => { setDeletingProject(null); setAlsoDeleteSidecar(false); });
  // The import-result modal likewise needs its own Esc handler now that it's
  // a real dialog instead of a Toast (a Toast never listened for Esc at all).
  useEscClose(!!importResult, () => setImportResult(null));

  // Load the projects index whenever the view is opened. Hooks MUST run before
  // any early return — Rules of Hooks. Don't move below the projectViewOpen guard
  // or React throws "Rendered more hooks than during the previous render".
  useEffect(() => {
    if (!state.projectViewOpen) return;
    // Fresh data each time the browser is opened — the caches only de-duplicate
    // within a single open session (project switches / tab toggles), so clear
    // them on open so newly-created conversations/context show up.
    convCache.current.clear();
    ctxCache.current.clear();
    let cancelled = false;
    // Re-arm the loaded flag per open: the component never unmounts, so a
    // stale `true` from the last open would let the empty card render off the
    // previous list for a beat before this open's answer arrives.
    setIndexLoaded(false);
    // Phase 1: fast list (sidecar-only counts) so the list/switcher appears
    // instantly and a project is selected without waiting on disk scans.
    (window.claude as any).artifacts.listProjectsIndex().then((res: any) => {
      if (cancelled || !res?.ok) return;
      setProjects(res.projects);
      setIndexLoaded(true);
      // Every open re-homes to the focused conversation's project. Destin's
      // ruling: opening project view should always land on the folder you are
      // currently working in, never on whatever you happened to browse to last
      // time. Previously this kept `prev` (the last selection) across
      // close/reopen, because the component never unmounts.
      // Fallback order: focused conversation's project → first in the list.
      setActiveProject(matchProjectByPath(res.projects, activeCwdRef.current)
        ?? (res.projects.length > 0 ? res.projects[0] : null));
      // Phase 2: real file + conversation counts (on-disk discovery + a global
      // session scan) merged in when ready — progressively enhances the switcher's
      // "files · chats" hint without blocking the initial render.
      (window.claude as any).artifacts.listProjectsIndex({ withCounts: true }).then((res2: any) => {
        if (cancelled || !res2?.ok) return;
        setProjects(res2.projects);
      });
    });
    return () => { cancelled = true; };
  }, [state.projectViewOpen]);

  // Compute hero data + tab data whenever the active project changes. The four
  // IPC calls run in PARALLEL (Promise.all) so first paint waits on the slowest,
  // not the sum. Conversations + context are fetched-or-reused-from-cache once
  // and feed BOTH the hero counts AND the tab bodies (no duplicate fetch). A
  // `cancelled` flag guards against the project switching mid-flight.
  useEffect(() => {
    if (!activeProject) {
      setHeroStats({ files: 0, conversations: 0, contextFiles: 0, activeLabel: '—' });
      setHeroRepo(null);
      setConversations(null);
      setContext(null);
      return;
    }
    let cancelled = false;
    const { id, path } = activeProject;
    // Reset ONLY when the project actually changed — a refreshKey/countsKey
    // bump (Add file, exclude) refetches the counts in place without flashing
    // the hero back to zeros or re-seeding the tab data.
    const projectChanged = prevHeroProjectRef.current !== id;
    prevHeroProjectRef.current = id;
    if (projectChanged) {
      // Reset immediately so the PREVIOUS project's repo/stats don't linger while
      // the new project's data loads. Seed tab data from cache (instant) or null
      // (shows the tab's "Loading…" until the fetch resolves).
      setHeroStats({ files: 0, conversations: 0, contextFiles: 0, activeLabel: '…' });
      setHeroRepo(null);
      setConversations(convCache.current.get(id) ?? null);
      setContext(ctxCache.current.get(id) ?? null);
      // Filters describe ONE project's grid — a stale query/type from the last
      // project silently hiding the new project's files is a confusion trap.
      // Sort is a preference, not a filter, so it persists.
      setArtifactSearch('');
      setTypes(new Set());
      setFilterOpen(false);
    }

    // Cache-or-fetch helpers — the cache makes re-selecting a project / toggling
    // tabs instant; the bounded head-read in listProjectConversations keeps the
    // first fetch cheap (no full-transcript parse per session).
    const getConversations = async (): Promise<ConversationSummary[]> => {
      const cached = convCache.current.get(id);
      if (cached) return cached;
      try {
        const res = await (window.claude as any).project.listConversations(path);
        const list: ConversationSummary[] = res?.ok ? (res.conversations ?? []) : [];
        convCache.current.set(id, list);
        return list;
      } catch { return []; }
    };
    const getContext = async (): Promise<ContextGroup[]> => {
      const cached = ctxCache.current.get(id);
      if (cached) return cached;
      try {
        const res = await (window.claude as any).project.listContext(path);
        const groups: ContextGroup[] = res?.ok ? (res.groups ?? []) : [];
        ctxCache.current.set(id, groups);
        return groups;
      } catch { return []; }
    };
    // 2026-07-23: the hero's separate "N artifacts" stat was dropped when the
    // Artifacts tab merged into Files, so the getArtifactCount() helper that fed
    // it is gone too. Left alone, out of scope for this task: main's
    // countVisibleArtifacts (still feeds ProjectSwitcher's row hint) and the
    // persisted stats.artifactCount in the central index — neither is a
    // renderer concern here.
    // ALL FILES count — the project folder's on-disk files (DISTINCT from the
    // artifact count). Shares main's discovery cache with the Files tab's
    // Project Files section, so this and the tab don't double-scan. Gated roots
    // (home dir / drive root)
    // return { gated } with NO scan → null here → the stat renders "—".
    const getAllFilesCount = async (): Promise<{ count: number | null; truncated: boolean }> => {
      try {
        const res = await (window.claude as any).artifacts.listAllFiles(id);
        if (res?.gated) return { count: null, truncated: false };
        return res?.ok && Array.isArray(res.files)
          ? { count: res.files.length, truncated: !!res.truncated }
          : { count: 0, truncated: false };
      } catch { return { count: 0, truncated: false }; }
    };

    (async () => {
      const [convs, ctxGroups, fileCount, repoRes] = await Promise.all([
        getConversations(),
        getContext(),
        getAllFilesCount(),
        (window.claude as any).project.repoInfo(path).catch(() => null),
      ]);
      if (cancelled) return;

      // Feed the tab bodies.
      setConversations(convs);
      setContext(ctxGroups);

      // Hero counts (live — NOT the stale stored stats.artifactCount).
      const conversationCount = convs.length;
      const newest = convs[0]?.lastModified; // listPastSessions is newest-first
      const activeLabel = typeof newest === 'number' ? formatRelativeTime(newest) : 'never';
      const contextFiles = ctxGroups.reduce((acc, g) => acc + (g.files?.length ?? 0), 0);
      const repo: HeroRepo | null = repoRes?.hasRepo && repoRes.webUrl
        ? { webUrl: repoRes.webUrl, owner: repoRes.owner, name: repoRes.name }
        : null;

      setHeroStats({
        files: fileCount.count,
        filesTruncated: fileCount.truncated || undefined,
        conversations: conversationCount,
        contextFiles,
        activeLabel,
      });
      setHeroRepo(repo);
    })();
    return () => { cancelled = true; };
    // refreshKey (Add file) + countsKey (in-tab exclude) re-run this to keep the
    // hero/segment counts LIVE — the redesign's core promise. Conversations and
    // context come back from the per-project cache on those refreshes (instant).
  }, [activeProject?.id, activeProject?.path, refreshKey, countsKey]);

  // Per-project sync state for the hero + switcher dots. Refetched whenever the
  // view opens, the project list refreshes (add/exclude), or the active project
  // changes. catch → null (Android has no syncspaces handlers; the UI simply
  // shows no sync affordances when status is unavailable).
  useEffect(() => {
    if (!state.projectViewOpen) return;
    let cancelled = false;
    (window.claude as any).syncSpaces.status()
      .then((s: SyncStatusData) => { if (!cancelled) setSyncStatus(s); })
      .catch(() => { if (!cancelled) setSyncStatus(null); });
    return () => { cancelled = true; };
  }, [state.projectViewOpen, refreshKey, countsKey, activeProject?.path]);

  // Live refresh: "Sync now"/background syncs must update the hero line + dots
  // live; the open-gated fetch alone goes stale (the red→green flip and "Last
  // synced" would sit frozen until the next view-open). The sync engine
  // broadcasts synced/error events on the syncspaces:event push channel —
  // refetch status() on each, trailing-debounced 500ms to coalesce bursts (one
  // sync can emit several events back-to-back). Cleanup drops BOTH the
  // subscription and any pending timer so a late tick can't setState after
  // close/unmount. catch → null, same convention as the fetch above.
  useEffect(() => {
    if (!state.projectViewOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let listChanged = false; // a coalesced 'projects-changed' arrived this batch
    const unsubscribe = (window.claude as any).syncSpaces.onEvent((e: any) => {
      // 'projects-changed' means the managed-project SET changed (a project was
      // materialized/stopped by cross-device discovery) — refetch the project
      // LIST too, not just the sync-status dots (2026-07-13 dogfood fix). Without
      // this, a project synced from another device wouldn't appear in Project
      // View until it was closed and reopened.
      if (e?.type === 'projects-changed') listChanged = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        (window.claude as any).syncSpaces.status()
          .then((s: SyncStatusData) => { if (!cancelled) setSyncStatus(s); })
          .catch(() => { if (!cancelled) setSyncStatus(null); });
        if (listChanged) {
          listChanged = false;
          (window.claude as any).artifacts.listProjectsIndex({ withCounts: true })
            .then((res: any) => {
              if (cancelled || !res?.ok) return;
              setProjects(res.projects);
              // Keep the current selection stable across the refresh (match by
              // path — a synth project's id becomes a ULID once it gains an index
              // entry). Return the FRESH matching object, not the stale `prev`, so
              // the selected project's own counts/displayName/state update too.
              // Auto-select the first project only if nothing is selected yet.
              setActiveProject((prev) => {
                if (prev) {
                  return res.projects.find((p: CentralIndexProject) => p.path === prev.path) ?? prev;
                }
                return res.projects.length > 0 ? res.projects[0] : null;
              });
            })
            .catch(() => { /* next natural refresh recovers the list */ });
        }
      }, 500);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [state.projectViewOpen]);

  if (!state.projectViewOpen) return null;

  // Add a project = open the unified AddProjectModal (spec §3). It routes to
  // create-new / keep-in-place / move+sync itself — this just opens it (and
  // closes the switcher so the two overlays don't stack).
  const handleAddProject = () => {
    setSwitcherOpen(false);
    setAddOpen(true);
  };

  // Shared post-add handler for EVERY successful add path (create / keep /
  // move+sync) AND the hero's turn-on-sync flow: refresh the project list and
  // select the project at its (possibly new) path. Match by PATH — a synth
  // project's id is its path until it gains a central-index entry.
  const handleAdded = async (path: string) => {
    setAddOpen(false);
    setTurnOnSyncFor(null);
    // try/catch: the modals are already closed by the time this runs, so a
    // listProjectsIndex rejection would otherwise float as an unhandled
    // rejection with no UI to land in. Swallow it — the next natural refresh
    // (view re-open / refreshKey bump) recovers the list.
    try {
      const res = await (window.claude as any).artifacts.listProjectsIndex({ withCounts: true });
      if (res?.ok) {
        setProjects(res.projects);
        const added = res.projects.find(
          (p: CentralIndexProject) => p.path.replace(/\\/g, '/').toLowerCase() === path.replace(/\\/g, '/').toLowerCase()
        );
        if (added) setActiveProject(added);
      }
    } catch (err) {
      console.warn('post-add project list refresh failed', err);
    }
  };

  const confirmDelete = async () => {
    if (!deletingProject) return;
    // The project list IS the saved-folders store now, so "Remove" removes the
    // folder from that store (which also drops it from the new-session folder
    // picker). Optionally wipe the artifact-history sidecar + any index entry.
    await (window.claude as any).folders.remove(deletingProject.path);
    if (alsoDeleteSidecar) {
      await (window.claude as any).artifacts.deleteProject(deletingProject.id, true).catch(() => {});
    }
    // Refresh project list after removal.
    const res = await (window.claude as any).artifacts.listProjectsIndex({ withCounts: true });
    if (res && res.ok) {
      setProjects(res.projects);
      // If we removed the active project, select the first remaining one.
      setActiveProject((prev) =>
        prev?.path === deletingProject.path ? (res.projects[0] ?? null) : prev
      );
    }
    setDeletingProject(null);
    setAlsoDeleteSidecar(false);
  };

  // Join the project root with the folder FilesTab is currently showing.
  // currentRelDir is '' at the tree root, so this is just the project path there.
  const importDestDir = (): string => {
    const root = activeProject!.path.replace(/[\\/]+$/, '');
    if (!currentRelDir) return root;
    const sep = root.includes('\\') ? '\\' : '/';
    return `${root}${sep}${currentRelDir.replace(/^[\\/]+/, '')}`;
  };

  // Collisions: basenames among the picked paths that already exist directly
  // in the destination folder. Compared against the SAME on-disk listing
  // FilesTab's Project Files section reads (artifacts:list-all-files) — an
  // extra IPC round trip rather than reaching into FilesTab's internal state,
  // but that call is cache-backed (project-file-discovery.ts), so it's cheap,
  // and it keeps this component from depending on FilesTab's internals.
  //
  // This list is BEST EFFORT and deliberately treated as such downstream:
  // discovery skips noise files (package-lock.json, *.map, *.min.js,
  // .DS_Store), truncates at its caps, and this function returns [] if the call
  // fails at all. Everything it returns is NAMED in the dialog and forwarded as
  // disclosedCollisions, and main refuses to 'replace' anything absent from it —
  // so an omission here costs a keep-both rename, never an unseen overwrite.
  const computeImportCollisions = async (paths: string[]): Promise<string[]> => {
    if (!activeProject) return [];
    // force: true — collision detection must see the REAL listing even on a
    // gated root (home dir / drive root). Without it, a user who clicked
    // "Browse anyway" in FilesTab sees the true file list there while this
    // call silently gets back { files: [] } from the gate, so every collision
    // would go undetected and the Replace/Keep both/Skip choice would never
    // be offered. listAllFiles is cache-backed (project-file-discovery.ts),
    // so this doesn't add a redundant scan when FilesTab already forced one.
    const res = await (window.claude as any).artifacts.listAllFiles(activeProject.id, { force: true });
    if (!res?.ok || !Array.isArray(res.files)) return [];
    const prefix = currentRelDir ? currentRelDir.replace(/\\/g, '/') + '/' : '';
    const existing = new Set<string>();
    for (const a of res.files as ArtifactRecord[]) {
      const p = a.path.replace(/\\/g, '/');
      if (prefix && !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest || rest.includes('/')) continue; // lives in a deeper subfolder, not this one
      existing.add(rest);
    }
    return paths
      .map((p) => p.replace(/\\/g, '/').split('/').pop() ?? p)
      .filter((name) => existing.has(name));
  };

  // + Add file — was a manualIncludes pin (a "fake" tracked entry pointing at a
  // file elsewhere on disk); now it actually brings the file INTO the project.
  // Destination is the folder currently being browsed, not the project root:
  // FilesTab is a breadcrumb tree, so landing everything at the root would be
  // surprising once you have navigated in.
  const importFiles = async () => {
    if (!activeProject) return;
    const paths: string[] = await (window.claude as any).dialog.openFile();
    if (!paths || paths.length === 0) return;
    const collisions = await computeImportCollisions(paths);
    setPendingImport({ sources: paths, collisions });
  };

  const runImport = async ({ mode, onCollision }: { mode: 'move' | 'copy'; onCollision: 'replace' | 'keep-both' | 'skip' }) => {
    if (!activeProject || !pendingImport) return;
    const destDir = importDestDir();
    const sources = pendingImport.sources;
    const results = await Promise.all(sources.map((p) =>
      (window.claude as any).artifacts.importFile(activeProject.path, p, destDir, {
        mode,
        onCollision,
        // Forward the EXACT collision list the dialog named. Main applies
        // 'replace' only to these, so a collision that never made it into the
        // list (discovery skips noise files and truncates at its caps) falls
        // back to keep-both instead of silently overwriting a file the user was
        // never shown. See artifacts/import-file.ts.
        disclosedCollisions: pendingImport.collisions,
      })));
    // Surface the REAL failure (code + path) — never a guessed cause. See
    // describeImportFailure above for the two codes that need human wording.
    // Results are index-aligned with `sources` (Promise.all preserves order),
    // so each line can name the file it is about.
    const lines: string[] = [];
    let hardFailures = 0, partial = 0, alreadyInPlace = 0;
    results.forEach((r: any, i: number) => {
      if (r && r.ok === false) {
        if (r.error === 'MOVE_SOURCE_NOT_REMOVED') partial++; else hardFailures++;
        lines.push(describeImportFailure(r, sources[i]));
      } else if (r && r.ok === true && r.reason === 'already-in-place') {
        // Not a failure: the picked file IS the file already sitting in this
        // folder, so there was nothing to copy or move. Saying so is the only
        // honest outcome — the alternative used to be deleting it.
        alreadyInPlace++;
        lines.push(`${baseName(sources[i])} is already in this folder — nothing to import.`);
      }
    });
    if (lines.length > 0) {
      setImportResult({ title: importResultTitle({ hardFailures, partial, alreadyInPlace }), lines });
    }
    setPendingImport(null);
    setRefreshKey((k) => k + 1);
  };

  // Unified segmented control: icon + label + live count per tab.
  // Files renders via formatFileCount: "N", "N+" (truncated sample), or "—"
  // (gated root, no scan) — the old separate Artifacts count is gone (2026-07-23
  // merge; see the file-merge spec).
  const SEGMENTS: { id: TabId; label: string; icon: React.ReactNode; count: string }[] = [
    { id: 'files', label: 'Files', icon: <FolderIcon />, count: formatFileCount(heroStats.files, heroStats.filesTruncated) },
    { id: 'conversations', label: 'Conversations', icon: <ChatIcon />, count: String(heroStats.conversations) },
    // WHY "Instructions & Memories" (not "Context", which it was built as): the
    // tab surfaces the files that tell the assistant HOW to behave — instructions
    // (CLAUDE.md/AGENTS.md/rules) and memories — and "instructions" is the term
    // the product uses everywhere else a non-technical user meets this concept.
    { id: 'context', label: 'Instructions & Memories', icon: <DocIcon />, count: String(heroStats.contextFiles) },
  ];

  // Per-active-project sync props for the hero. `dot` is null when syncStatus is
  // unavailable (Android / status() rejected) → hero renders no sync line. The
  // error message is the latest 'error' engine event for this space (friendly-
  // error contract), surfaced only in the red state.
  const heroDot = activeProject ? syncDotFor(activeProject.path, syncStatus) : null;
  const heroSpace = activeProject ? findSpaceFor(activeProject.path, syncStatus) : null;
  const heroSync = heroDot
    ? {
        dot: heroDot,
        spaceId: heroSpace?.id ?? null,
        lastSynced: heroSpace ? lastSyncedLabel(heroSpace.id, syncStatus) : null,
        errorMessage: heroDot.color === 'red'
          ? [...(syncStatus?.recentEvents ?? [])].reverse()
              .find((e) => e.spaceId === heroSpace?.id && e.type === 'error')?.message ?? null
          : null,
        // Review #4: a stopped project must read as a permanent detach, not as
        // the global sync-off state, and must not re-offer "Stop syncing".
        stopped: (heroSpace as any)?.state === 'stopped',
      }
    : null;

  return (
    <div className="fixed inset-0 bg-canvas z-40 flex flex-col">
      {/* Header: title + global search + the shared screen exit (change 27) */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-edge shrink-0">
        <h2 className="text-base font-semibold text-fg shrink-0">Projects</h2>
        <div className="flex-1" />
        {/* One exit per surface type (change 27) — identical on all three screens.
            Wide: ghost Button, so it keeps the hover pill the old "Esc / Close"
            control had (review feedback 2026-07-23). Narrow: bordered ✕, because
            touch has no Esc key. */}
        <Button
          variant="ghost"
          onClick={() => dispatch({ type: 'PROJECT_VIEW_CLOSED' })}
          className="hidden sm:inline-flex shrink-0 text-sm px-2.5 py-1"
          aria-label="Exit projects"
        >
          Esc · Back to chat
        </Button>
        <CloseButton
          onClick={() => dispatch({ type: 'PROJECT_VIEW_CLOSED' })}
          label="Exit projects"
          className="sm:hidden shrink-0 panel-glass bg-inset rounded-md border border-edge-dim hover:border-edge"
        />
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Main column — hero + segmented control + active tab. There is no
            project rail anymore; switching projects goes through the palette
            (ProjectSwitcher) opened from the hero name, and project removal
            lives on the palette rows. */}
        {/* Narrow scrolls as ONE page: the hero scrolls away and the tab
            content keeps going, so a phone isn't stuck reading files through a
            ~200px slot under a hero that never moves. sm+ keeps the fixed-chrome
            layout (hero pinned, body scrolls independently) — there's vertical
            room for it there, and it's the design the view was built around. */}
        <main className="flex-1 flex flex-col max-sm:overflow-y-auto sm:overflow-hidden min-w-0">
          {/* No projects at all (first-run guide, spec §1 item 5): the
              explainer card replaces BOTH the hero and the seg-row + tab body —
              three tabs with "0" badges over nothing is a dashboard for nothing.
              Gated on indexLoaded so it never flashes while the index is still
              answering; the header above (title + back) is untouched. */}
          {indexLoaded && projects.length === 0 ? (
            <ProjectsEmptyCard onAdd={handleAddProject} />
          ) : (
          <>
          {/* Chrome: hero + seg-row, centered to a comfortable reading width to
              match the prototype (the tab body below shares the same max-width). */}
          {/* px-2 on narrow: stacked gutters (this px-4 plus the hero's own p-5)
              ate 18% of a 390px viewport before any content rendered. */}
          <div className="w-full max-w-[1100px] mx-auto px-2 sm:px-4 pt-4 shrink-0 flex flex-col gap-3 sm:gap-4">
            {/* `description`: the SYNCED description wins when this project
                syncs; a plain local folder falls back to the saved-folders one
                carried on the index entry. Same precedence as displayName over
                the folder name. */}
            {activeProject ? (
              <ProjectHero
                project={activeProject}
                displayName={(heroSpace as any)?.displayName ?? null}
                // WHY no `as any` here (unlike displayName above): SyncStatusData's
                // spaces now declare `description` (2026-08-05), so this read
                // type-checks directly — displayName's cast is untouched/out of
                // scope for this fix.
                description={heroSpace?.description ?? activeProject.description ?? null}
                stats={heroStats}
                repo={heroRepo}
                onOpenSwitcher={() => setSwitcherOpen(true)}
                onNewConversation={props.onNewConversation}
                sync={heroSync}
                onTurnOnSync={() => setTurnOnSyncFor({ path: activeProject.path, name: activeProject.name })}
                onSyncNow={(spaceId) => { void (window.claude as any).syncSpaces.syncNow(spaceId); }}
                onRenamed={async () => {
                  // try/catch + slash/case-normalized match — same conventions
                  // as handleAdded (exact === path compare is a latent Windows
                  // drive-case/slash footgun).
                  try {
                    const res = await (window.claude as any).artifacts.listProjectsIndex({ withCounts: true });
                    if (res?.ok) {
                      setProjects(res.projects);
                      const cur = res.projects.find(
                        (p: CentralIndexProject) => p.path.replace(/\\/g, '/').toLowerCase() === activeProject.path.replace(/\\/g, '/').toLowerCase()
                      );
                      if (cur) setActiveProject(cur);
                    }
                  } catch (err) {
                    console.warn('post-rename project list refresh failed', err);
                  }
                }}
                canRemove={!heroSpace}
                onRemove={() => setDeletingProject(activeProject)}
              />
            ) : (
              <div className="text-sm text-fg-muted">Select a project to view its artifacts.</div>
            )}

            {/* Seg-row: unified segmented control (left) + the active tab's
                search/filter controls (right), on one row — matches the design. */}
            {/* Sticky on narrow so the tab switcher survives scrolling down
                through a long file list — without it, page-scroll would carry
                the tabs off-screen and you'd have to scroll back up to switch. */}
            <div className="flex items-center justify-between gap-3 flex-wrap max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:bg-canvas max-sm:py-2">
              {/* Unified segmented control: one rounded-full pill holding all three
                  segments (icon + label + count). Accent used ONCE — the active seg. */}
              {/* All three segments at full width, no scrolling: below 640px the
                  INACTIVE segments drop to icon-only and the active one keeps
                  its label + count. Fully labelled they overflow a phone
                  ("Conversations" alone is ~168px), which used to put the last
                  segment out of reach entirely. Two ~35px icons plus one
                  labelled segment fits inside ~374px with room to spare.
                  overflow-x-auto stays as a backstop for a very long label at a
                  very small width; it should not normally engage. */}
              <div
                className="flex items-center gap-1 p-1 layer-surface !rounded-full max-sm:w-full max-w-full overflow-x-auto no-scrollbar"
                style={{ boxShadow: 'none' }}
              >
                {SEGMENTS.map((s) => {
                  const active = tab === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      // Active segment absorbs the leftover width on narrow so
                      // the pill spans the screen exactly; inactive ones stay
                      // at their icon width. title= carries the label for the
                      // icon-only state (aria-label does the same for AT).
                      className={`shrink-0 ${active ? 'max-sm:flex-1 max-sm:min-w-0' : ''} px-2.5 sm:px-3.5 py-1.5 rounded-full text-sm-tight font-medium inline-flex items-center justify-center gap-1.5 sm:gap-2 transition-colors ${
                        active
                          ? 'bg-accent text-on-accent'
                          : 'text-fg-2 hover:text-fg hover:bg-inset'
                      }`}
                      onClick={() => setTab(s.id)}
                      title={s.label}
                      aria-label={s.label}
                      // The first-run tour's Files stop rings the Files tab.
                      data-guide-anchor={s.id === 'files' ? 'files-tab' : undefined}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className="shrink-0 inline-flex">{s.icon}</span>
                      {/* Label + count collapse to nothing on an inactive
                          segment below 640px — that's what buys the room for
                          all three to fit without scrolling. */}
                      <span className={`truncate ${active ? '' : 'max-sm:hidden'}`}>{s.label}</span>
                      <span className={`text-2xs shrink-0 ${active ? 'opacity-80' : 'text-fg-muted max-sm:hidden'}`}>
                        {s.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Right controls for the Files tab. ONE rounded-full search
                  pill (same shape language as the segmented control) with the
                  sliders icon inside its right edge — ALL filter/sort options
                  (type, sort) live behind it in FileFilterPopover.
                  Only "+ Add file" (an action, not a filter) stays visible.
                  Conversations/Context have no toolbar in v1. */}
              {/* Narrow: search + Add file take their own full-width row under
                  the segments (the parent's flex-wrap does the rest). A hard
                  260px pill plus "+ Add file" was ~363px in a 358px content
                  box, so this row alone overflowed the viewport. */}
              {tab === 'files' && activeProject && (
                <div className="w-full sm:w-auto flex items-center gap-2">
                  <SearchFilterPill
                    ref={filterWrapRef}
                    className="flex-1 sm:flex-none sm:w-[260px]"
                    value={artifactSearch}
                    onChange={setArtifactSearch}
                    placeholder="Search files…"
                    inputAriaLabel="Search files"
                    /* Filters active BEYOND the default view (type only). Sort is a
                       preference, so it isn't counted — the badge only signals
                       "filters narrowed this" while the popover is shut. Show
                       deleted dropped out of this count with the tab merge; it is
                       now a session-drawer-only control. */
                    activeFilters={types.size > 0 ? 1 : 0}
                    filterOpen={filterOpen}
                    onToggleFilter={() => setFilterOpen((o) => !o)}
                  >
                    {filterOpen && (
                      <FileFilterPopover
                        types={types}
                        onTypesChange={setTypes}
                        sortBy={fileSort}
                        onSortBy={setFileSort}
                        /* Show deleted is SESSION-DRAWER-ONLY now. The drawer (this
                           popover's other consumer) passes true; project view opts
                           out, because a deleted record is a tombstone with no
                           content and there is no Artifacts tab left for it to
                           belong to. */
                        showDeletedAvailable={false}
                        onClose={() => setFilterOpen(false)}
                      />
                    )}
                  </SearchFilterPill>
                  {/* Was a pill (rounded-full). Spec decision 65 keeps pills only
                      for floating overlay affordances — this sits in a toolbar row,
                      so it takes the app's standard button radius. */}
                  {/* No tab check here: the whole block is already gated on
                      tab === 'files' above. */}
                  <Button
                    variant="secondary"
                    className="shrink-0"
                    onClick={importFiles}
                    title="Copy or move a file into this project folder"
                  >
                    + Add file
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Tab routing — shares the centered max-width with the chrome above. */}
          {/* max-sm:flex-none + overflow-visible: in the narrow page-scroll
              model this must take its NATURAL height and let the page scroll,
              not clamp itself to the viewport and scroll internally. */}
          <div className="flex-1 overflow-hidden min-h-0 w-full max-w-[1100px] mx-auto max-sm:flex-none max-sm:overflow-visible">
            {/* Files stays MOUNTED and hides when another tab is active. It is
                the only tab that holds a main-process project watcher, and
                dropping it on the way out means rebuilding it (a full tree walk
                that freezes the app) on the way back — clicking Files /
                Conversations eight times cost 7.5 s of stall before this.
                Conversations and Context hold no such resource, so they stay
                conditional. Side benefit: the folder you were browsing and the
                file you had open are still there when you come back. */}
            {activeProject && (
              <FilesTab hidden={tab !== 'files'} project={activeProject} search={artifactSearch} types={types} sortBy={fileSort} view={fileView} onViewChange={setFileView} refreshKey={refreshKey} onMutated={() => setCountsKey((k) => k + 1)} onClearSearch={() => setArtifactSearch('')} onCurrentDirChange={setCurrentRelDir} />
            )}
            {activeProject && tab === 'conversations' && (
              <ConversationsTab conversations={conversations} onOpenPreview={setPreviewSession} />
            )}
            {previewSession && activeProject && (
              <ConversationPreview
                project={activeProject}
                session={previewSession}
                onClose={() => setPreviewSession(null)}
                onResume={(s) => {
                  // WHY: resume closes Project View and launches/resumes the session
                  // (handled by the App-threaded prop), then drops the preview.
                  props.onResumeConversation(s.sessionId, s.projectSlug, s.projectPath, s.provider);
                  setPreviewSession(null);
                }}
              />
            )}
            {activeProject && tab === 'context' && (
              <ContextTab
                groups={context}
                onEditFile={setEditingContext}
                onOpenInfo={setInfoScope}
              />
            )}
            {/* How-context-works teaching popup. Map the clicked scope to an
                initial tab: memory → Memory page, project/global → Overview
                (the broad→specific stack covers both). */}
            {infoScope && (
              <HowContextWorksPopup
                initialTab={infoScope === 'memory' ? 'memory' : 'overview'}
                onClose={() => setInfoScope(null)}
              />
            )}
            {/* Context editor overlay — view/edit an agent-context file with a
                blast-radius warning (amber + save-confirm for global files,
                neutral + direct save for project files). */}
            {editingContext && activeProject && (
              <ContextEditorOverlay
                project={activeProject}
                file={editingContext}
                onClose={() => setEditingContext(null)}
              />
            )}
          </div>
          </>
          )}
        </main>
      </div>

      {/* Project switcher (command palette) — Task 2.3. */}
      {switcherOpen && (
        <ProjectSwitcher
          projects={projects}
          activeId={activeProject?.id ?? null}
          onSelect={(p) => { setActiveProject(p); setSwitcherOpen(false); }}
          onClose={() => setSwitcherOpen(false)}
          onAddProject={handleAddProject}
          onDeleteProject={(p) => setDeletingProject(p)}
          syncStatus={syncStatus}
        />
      )}

      {/* Project deletion confirmation modal — L3 (destructive confirmation)
          via the shared overlay primitives so scrim/surface/z-index come from
          theme tokens; Esc is handled by the useEscClose above. */}
      {deletingProject && (
        <>
          <Scrim layer={3} onClick={() => { setDeletingProject(null); setAlsoDeleteSidecar(false); }} />
          <OverlayPanel
            layer={3}
            destructive
            role="dialog"
            aria-modal={true}
            aria-label="Remove project"
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 p-6 max-w-md w-[calc(100%-2rem)]"
          >
            <h3 className="text-lg font-semibold mb-2 text-fg">Remove project</h3>
            <p className="mb-3 text-sm text-fg">
              Remove "<span className="font-medium">{deletingProject.name}</span>" from YouCoded?
            </p>
            <p className="text-sm text-fg-muted mb-3">
              The folder and its files are NOT deleted — this only removes it from your
              YouCoded folders, so it also disappears from the new-session folder picker.
              You can add it back anytime with "Add a project" in the project switcher.
            </p>
            {/* Change 39/§1.4: the consent Checkbox primitive (its one intended
                site). Row is a clickable div (a <label> can't associate with a
                button), so the whole row toggles like the old label did. The
                Checkbox is wrapped in a stopPropagation span so its OWN click
                fires exactly one toggle instead of double-firing via the row. */}
            <div
              className="flex items-center gap-2 mb-4 text-sm cursor-pointer text-fg"
              onClick={() => setAlsoDeleteSidecar((v) => !v)}
            >
              <span onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={alsoDeleteSidecar}
                  onChange={setAlsoDeleteSidecar}
                  aria-label="Also delete .youcoded/artifacts.json (artifact history)"
                />
              </span>
              Also delete <code className="font-mono text-xs bg-inset px-1 rounded">.youcoded/artifacts.json</code> (artifact history)
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                variant="secondary"
                size="lg"
                onClick={() => { setDeletingProject(null); setAlsoDeleteSidecar(false); }}
              >
                Cancel
              </Button>
              {/* Was a raw Tailwind bg-red-600. Spec decision 59: that stock red
                  isn't the app's destructive colour and doesn't follow themes —
                  the `danger` variant uses the theme's own destructive token. */}
              <Button variant="danger" size="lg" onClick={confirmDelete}>
                Remove
              </Button>
            </div>
          </OverlayPanel>
        </>
      )}

      {/* Unified add-project flow (spec §3). Routes create-new / keep-in-place /
          move+sync itself; handleAdded refreshes + selects on any success. */}
      {addOpen && (
        <AddProjectModal onClose={() => setAddOpen(false)} onAdded={(p) => void handleAdded(p)} />
      )}
      {/* Turn-on-sync for the ACTIVE project (hero button) — the consent+move
          modal, seeded with the project's current path + name. */}
      {turnOnSyncFor && (
        <ImportProjectModal
          sourcePath={turnOnSyncFor.path}
          defaultName={turnOnSyncFor.name}
          onClose={() => setTurnOnSyncFor(null)}
          onDone={(p) => void handleAdded(p)}
        />
      )}

      {/* Task 6: "+ Add file" Move/Copy confirm — destLabel names the folder
          being browsed (or the project name at the root) so the target is
          never a guess; collisions were computed against the current Project
          Files listing before this opened (see computeImportCollisions). */}
      {pendingImport && activeProject && (
        <ImportFileDialog
          sources={pendingImport.sources}
          destDir={importDestDir()}
          destLabel={currentRelDir ? `${currentRelDir}/` : activeProject.name}
          collisions={pendingImport.collisions}
          onConfirm={(args) => void runImport(args)}
          onCancel={() => setPendingImport(null)}
        />
      )}
      {/* Import outcomes — real code + path, never a guessed cause (see
          describeImportFailure). A non-transient modal, not a Toast: these
          lines name a protected path that was NOT imported, report a partial
          move (copy succeeded, original couldn't be removed), or say a file was
          already where it was headed — the user needs to read and may need to
          act on this, and Toast has no manual dismiss (only its own timer).
          The title comes from importResultTitle because a partial move and an
          "already there" no-op are not failures. Same Scrim + OverlayPanel +
          Button pattern as the project-deletion modal above. */}
      {importResult && (
        <>
          <Scrim layer={2} onClick={() => setImportResult(null)} />
          <OverlayPanel
            layer={2}
            role="alertdialog"
            aria-modal={true}
            aria-label={importResult.title}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 p-6 max-w-md w-[calc(100%-2rem)]"
          >
            <h3 className="text-lg font-semibold mb-2 text-fg">{importResult.title}</h3>
            {/* One line per file the user needs to know about. */}
            <div className="flex flex-col gap-1 mb-4 text-sm text-fg">
              {importResult.lines.map((line, i) => <span key={i}>{line}</span>)}
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" size="lg" onClick={() => setImportResult(null)}>
                Dismiss
              </Button>
            </div>
          </OverlayPanel>
        </>
      )}
    </div>
  );
}
