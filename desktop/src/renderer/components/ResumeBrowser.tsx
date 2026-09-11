import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel, CONTENT_Z } from './overlays/Overlay';
import { Button, Toggle, LoadingState, EmptyState, ErrorState, FilterChip, FilterMenuChip, CheckboxMark, SearchFilterPill, SettingRow } from './ui';
import SessionRenameDialog from './SessionRenameDialog';
import { namingApi } from './assistant-settings/naming-api';
import { useRenamedSessions } from './assistant-settings/use-renamed-sessions';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';
import { isAndroid } from '../platform';
import SessionPreviewPane from './SessionPreviewPane';
import type { ChatsearchProvider } from '../../shared/chatsearch-refs';
import { ResumeFilterPopover } from './ResumeFilterPopover';
import { SkipPermissionsInfoTooltip } from './SkipPermissionsInfoTooltip';
import {
  applyFilters,
  sortSessions,
  groupSessions,
  getAvailableProjects,
  pickLabel,
  type FilterState,
  type FlagName,
} from './resume-browser-filters';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { TagPicker } from './tags/TagPicker';
import { TagManagerPopup } from './tags/TagManagerPopup';
import { TagChip } from './tags/TagChip';
import { PRIORITY_TAG, PRIORITY_HINT } from './tags/built-in-tags';
import { TagGlyph } from './tags/glyphs';
import { NoteEditor } from './tags/NoteEditor';
import ModelPicker, { ModelIcon, type ModelChoice } from './model/ModelPicker';
import { resolveModelBrand } from './provider-brand';
import { ProviderIcon } from './ProviderIcon';
import { claudeAliasForModelId } from '../../shared/model-ids';
import type { ModelBinding } from '../../shared/provider-types';
import { SkipPermissionsCaption } from './SkipPermissionsCaption';
import { useFirstTimeGate } from './FirstTimeWarning';

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = Math.round(bytes / 1024);
  if (kb < 1024) return `${kb}KB`;
  return `${(kb / 1024).toFixed(1)}MB`;
}

// Claude Code model ids carry a release date — `claude-sonnet-4-5-20250929`.
// The date is noise on a card that already shows when the conversation last
// ran, and it is the difference between the chip fitting and truncating. Only a
// TRAILING 8-digit group is stripped, so a native id that happens to contain
// digits (`gpt-5.6-sol`, `qwen3-coder-30b-a3b-instruct`) is untouched. The full
// id stays in the chip's title attribute.
function formatModelId(id: string): string {
  return id.replace(/-\d{8}$/, '');
}

// ── The conversation preview panel (2026-09-10) ─────────────────────────────
// Every decision below is an answered review-deck step, not a default. Five
// rounds, in docs/archive/design/2026-09-10-resume-preview-panel/:
//   R2  the list keeps its cards; it never collapses and never hides itself;
//       the right half stays one line of text until a row is clicked.
//   R3  the sheet: heading, conversation and actions on one inset surface with
//       the window showing all round it.
//   R4  the header IS the list's card, drawn again, floating at the top of the
//       sheet; the action card sits at its foot, vertically stacked, and its
//       switches are the existing resume block rather than a restyled copy.
//   R5  the whole sheet arrives on a jump (not just the card); the action card
//       stays open while you read; no folder chip on it — the header card
//       already says which folder this is.

// Filter menu rows and footer (design guide G-21: 28px rows of mark · label ·
// right-aligned count at text-xs; actions in a footer under a hairline, where
// FolderSwitcher and ModelPicker put theirs). One recipe shared by the Projects
// and Tags menus so the two cannot drift into two looks again (2026-09-10).
const MENU_ROW = 'w-full h-7 px-3 text-xs flex items-center gap-2 text-left text-fg-2 hover:bg-inset transition-colors';
const MENU_FOOTER = 'border-t border-edge flex divide-x divide-edge';
const MENU_FOOTER_ACTION = 'flex-1 px-2.5 py-2 text-xs whitespace-nowrap text-fg-dim hover:bg-inset hover:text-fg transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-dim';

// Renders pickLabel()'s answer: the text, and a muted numeral when there is one.
function PickLabel({ text, count }: { text: string; count?: number }) {
  return count ? <>{text} <span className="opacity-70 tabular-nums">{count}</span></> : <>{text}</>;
}

// The sort chip's glyph: three bars with a down arrow, running wide-to-narrow
// for newest first and narrow-to-wide for oldest first. Destin picked it on the
// round-2 deck (C-1 "bars") over two-way arrows and words only, after rejecting
// round 1's single arrow that turned over ("still don't like the arrow").
function SortArrow({ muted, up }: { muted: boolean; up: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 shrink-0 ${muted ? 'text-fg-muted' : ''}`.trim()}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d={up ? 'm3 16 4 4 4-4M7 20V4M11 4h4M11 8h7M11 12h10' : 'm3 16 4 4 4-4M7 20V4M11 4h10M11 8h7M11 12h4'}
      />
    </svg>
  );
}

// State updater that returns the PREVIOUS position object when the new one has
// the same numbers, so React bails out instead of re-rendering — required by the
// layout effect below, which depends on one of these positions.
function samePos<T extends Record<string, number>>(next: T | null): (prev: T | null) => T | null {
  return (prev) => {
    if (!next || !prev) return next;
    for (const k of Object.keys(next)) if (next[k] !== prev[k]) return next;
    return prev;
  };
}

// Compute fixed-position coords for a portaled dropdown anchored just below a
// trigger button. Clamps the left coordinate so a wide dropdown near the right
// edge of the viewport shifts left rather than overflowing off-screen. Pure;
// callers invoke it synchronously inside the click handler so the dropdown can
// render in the same React commit as `openPill` flipping (no two-render lag).
function measureDropdown(
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  dropdownWidthPx: number,
  boundsRef?: React.RefObject<HTMLElement | null>,
): { top: number; left: number } | null {
  const el = triggerRef.current;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  // Clamp so the dropdown's right edge stays inside the row it hangs from (so
  // it never pokes past the panel — UX review U15 saw the Tags menu reach to
  // within 9px of a phone's screen edge) and at least 8px inside the viewport.
  // If the trigger sits too far right, the dropdown shifts left.
  const bounds = boundsRef?.current?.getBoundingClientRect();
  const rightLimit = Math.min(window.innerWidth - 8, bounds ? bounds.right : Infinity);
  const maxLeft = Math.max(8, rightLimit - dropdownWidthPx);
  return {
    top: rect.bottom + 4,
    left: Math.min(rect.left, maxLeft),
  };
}

// While a dropdown is open, re-measure the trigger on window resize / scroll
// so the dropdown stays anchored as the viewport changes. The initial position
// is captured synchronously in the pill's click handler — this hook only
// handles updates after open, not the open itself.
function useDropdownReposition(
  isOpen: boolean,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  dropdownWidthPx: number,
  setPosition: React.Dispatch<React.SetStateAction<{ top: number; left: number } | null>>,
  boundsRef?: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!isOpen) return;
    const remeasure = () => {
      const next = measureDropdown(triggerRef, dropdownWidthPx, boundsRef);
      if (next) setPosition(next);
    };
    window.addEventListener('resize', remeasure);
    // Capture-phase scroll listener catches scroll on any ancestor, not just
    // window — needed if a scrollable parent moves the trigger.
    window.addEventListener('scroll', remeasure, true);
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
  }, [isOpen, triggerRef, dropdownWidthPx, setPosition, boundsRef]);
}

// Right padding reserved on a card's upper rows for the absolutely-positioned
// icon cluster. Derived, not eyeballed: cluster pr-2 (8) + two px-1 buttons
// around 16px icons (24 each) = 56px = pr-14. The BOTTOM row deliberately omits
// it so the timestamp reaches the card's own right padding. If the cluster's
// padding or its button count changes, this changes with it.
const ICON_GUTTER = 'pr-14';

// How many list items the browser materializes at a time, and how many more
// each top-up adds.
//
// WHY THIS EXISTS: the list used to render EVERY row on open. Measured against
// Destin's real scale (1,642 conversations) on 2026-07-31: 37,920 DOM nodes,
// ~1,050ms to open and ~470ms per search keystroke, scaling linearly with the
// conversation count. ~23 DOM nodes per card is the multiplier. Roughly half of
// that was React building the tree and a third was the browser's style+layout
// for nodes nobody could see.
//
// 50 fills the panel (max-h-70vh ≈ 8 rows) several times over, so the first
// paint is never waiting on rows below the fold, and a top-up lands well before
// the user scrolls to the end.
//
// Deliberately NOT true virtualization: rows here are variable-height, grow when
// their resume pane or tag sheet opens, and sit in a container whose scroll-fade
// hook reads real content height. Chunked reveal needs none of that height
// bookkeeping. The trade: the scrollbar is proportional to what's revealed, not
// to the whole list, and scrolling through many hundreds of rows re-accumulates
// DOM. If deep scrolling ever becomes a real usage pattern, a windowed list is
// the upgrade — see the 2026-07-31 handoff.
const REVEAL_CHUNK = 50;

// One entry in the flattened list. Grouped mode interleaves project headers
// with rows, so both modes reduce to a single ordered array — that is what lets
// one slice() bound the whole list regardless of which mode is active.
// Rows carry no `key` here on purpose — renderSessionRow already returns an
// element keyed by sessionId, so a second copy would be dead data.
type ListItem =
  | { kind: 'header'; key: string; label: string; first: boolean }
  | { kind: 'row'; session: PastSession; showPath: boolean };

// FlagName is imported from resume-browser-filters.ts (single source of truth),
// kept in sync with SESSION_FLAG_NAMES in shared/types.ts (that module is
// CommonJS so we don't import it directly).
//
// The FLAG_ORDER / FLAG_LABEL pair that used to live here is gone: neither
// reserved flag renders as a generic "flag" any more. Priority is a built-in
// TAG (built-in-tags.ts) and Complete is the card's hide icon, so each carries
// its own label at its own call site and a shared ordered list had nothing to
// order.

interface PastSession {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectPath: string;
  lastModified: number;
  size: number;
  // Reserved flags — multiple allowed. `complete` hides unless Show Complete
  // is on; `priority` pins the session to the top of its project group.
  flags?: Partial<Record<FlagName, boolean>>;
  tags?: string[];   // applied custom-tag ids
  note?: string;
  // Which runtime owns this session: `'claude'` = a Claude Code transcript;
  // `'native'` = a YouCoded native-harness session (skips the CC-only resume
  // options — model / skip-perms). Typed `string` because Conversation-Store
  // rows (Phase 2a) populate it from a stored string. No longer SHOWN on the
  // card: the runtime badge was replaced by the model chip (2026-07-31).
  provider?: string;
  // Native runtime only: the stored harness preset id ('assistant' | 'coder' |
  // legacy 'chat'). Currently unread here — it drove the "Coder"/"Assistant"
  // badge the model chip replaced. Kept because session.browse() returns it and
  // dropping it from the shape would hide it from any future surface.
  harnessId?: string;
  // Conversation Store (Phase 2a) fields, present on store-fed rows only.
  device?: string;   // last device that ran a turn
  // True when the conversation's project folder is not on THIS device (synced
  // in from elsewhere). Resume is disabled — there's no cwd to resume into.
  missingProject?: boolean;
  // True when the folder IS here but the transcript hasn't been materialized
  // into ~/.claude/projects yet (sync in flight). Resume is disabled too —
  // distinct flag so the note can say so accurately.
  notSyncedYet?: boolean;
  // Task 6: portable reference to the model this conversation last ran a turn
  // with (Conversation Store, Task 4/5). Pre-fills the native resume selector
  // below when it matches a model available on THIS device, and drives the
  // model chip on the card.
  //
  // BOTH runtimes carry it now. Native rows get it from noteModelUsed
  // (main/conversations/service.ts) at bind time; CC rows get it from
  // session-browser's backwards scan of the transcript's own `message.model`
  // (readSessionTranscriptMeta), which is also what claudeModelForRow below
  // reads to open an expanded card's dropdown on the right model. (This
  // comment said "native only, verified 2026-07-31" long after the CC side
  // landed — it was stale, not a constraint.)
  //
  // Still absent for a conversation whose transcript records no real model —
  // CC's `<synthetic>` placeholder lines are skipped, and a session that died
  // on its first turn has nothing else. Do NOT "fix" the blank by falling back
  // to the app default: that would print a guess as history.
  lastUsedModel?: import('../../shared/types').PortableModelRef;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Returns whether a resume actually launched (App's handleResumeSession does).
  // handleConfirmResume awaits it and closes the browser ONLY on success — a create
  // that never acked keeps the browser open (App toasts the reason) so the user can
  // retry, instead of closing over a silent failure (Task 6 review ack-gap). `void`
  // return kept in the union for any non-awaiting wiring (defaults to "close").
  onResume: (sessionId: string, projectSlug: string, projectPath: string, model: string, dangerous: boolean, launchInNewWindow?: boolean, provider?: string, nativeBinding?: ModelBinding) => void | boolean | Promise<void | boolean>;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
}

export default function ResumeBrowser({ open, onClose, onResume, defaultModel, defaultSkipPermissions }: Props) {
  // Live tag registry — drives the Tag Picker, chips, and custom-tag filter.
  const registry = useTagRegistry();
  const [sourceSessions, setSessions] = useState<PastSession[]>([]);
  const sourceNames = useMemo(() => Object.fromEntries(sourceSessions.map((s) => [s.sessionId, s.name])), [sourceSessions]);
  const previewNames = useRenamedSessions(sourceNames);
  const sessions = useMemo(() => sourceSessions.map((s) => previewNames[s.sessionId] === undefined
    ? s : { ...s, name: previewNames[s.sessionId] }), [sourceSessions, previewNames]);
  // Read by the settle effect below, which must not re-run every time the list
  // re-renders — only when the row it is about to show changes.
  const sessionsRef = useRef<PastSession[]>([]);
  sessionsRef.current = sessions;
  const [renameSession, setRenameSession] = useState<PastSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  // The shared search pill forwards its wrapper, not the input, so autofocus
  // reaches the field through it (see the open-effect below).
  const searchRef = useRef<HTMLDivElement>(null);
  const listRef = useScrollFade<HTMLDivElement>();
  // Wraps the filter pill row so outside-click can close the active dropdown.
  const filterRowRef = useRef<HTMLDivElement>(null);
  // The chips row scrolls sideways at phone width; the fade says so (design guide §4.8).
  useScrollFade(filterRowRef);
  // Trigger refs for portal positioning + dropdown refs so the outside-click
  // handler can recognize clicks inside the portaled dropdown body (which is
  // no longer a child of filterRowRef).
  const projectsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const tagsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectsDropdownRef = useRef<HTMLDivElement | null>(null);
  const tagsDropdownRef = useRef<HTMLDivElement | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The row whose transcript the right panel is showing. Distinct
  // from expandedId because in variants b/c nothing expands in the list at all.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewSheetOpen, setPreviewSheetOpen] = useState(false); // the Resume options sheet
  // The header clone's own tags/note sheet (see renderSessionRow).
  const [cloneOrganizeId, setCloneOrganizeId] = useState<string | null>(null);
  // ── One arrival, not three ──────────────────────────────────────────────
  // Everything in the sheet — the header card, the conversation, the action
  // card — changes at ONE moment, and that moment is after the new transcript
  // is both read and painted. Three separate moments is what this replaced:
  // the header and action card swapped on the click (local data), the
  // transcript blanked and came back a second later (a disk read), and its
  // bubbles painted a beat after that again (forty markdown blocks take longer
  // than a frame to build, so the arrival — running on the compositor —
  // started before they were drawn). Destin, 2026-09-10: "the header/footer
  // cards switch, THEN the animation happens, THEN the messages pop in."
  //
  // So the sheet renders `shownId`, which LAGS `previewId` until the read
  // settles. The click's acknowledgement is the row lighting up in the list,
  // which is instant; the pane holds the previous conversation meanwhile
  // (holdWhileLoading) rather than blanking under a name that already changed.
  //
  // `staged` is the frame in between: the new content is committed and laid
  // out while the sheet is still transparent, so the expensive paint happens
  // invisibly. Only then does `.switch-arrival` go on. Without it the bubbles
  // paint after the animation has begun, which is the third beat above.
  const [shownId, setShownId] = useState<string | null>(null);
  const [arrival, setArrival] = useState<'staged' | 'run' | null>(null);
  const onPreviewSettled = useCallback((id: string) => {
    setShownId(id);
    setArrival('staged');
  }, []);
  useEffect(() => {
    if (arrival !== 'staged') return;
    // Two frames: the first lets React's commit lay the new bubbles out, the
    // second is the one the animation can start on with them already painted.
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setArrival('run')); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [arrival]);
  // The resume controls belong to the row the action card is about to show, so
  // they are derived here rather than on the click — otherwise the card spent
  // the read showing the OLD conversation's name over the NEW one's model.
  useEffect(() => {
    if (!shownId) return;
    const s = sessionsRef.current.find((r) => r.sessionId === shownId);
    if (!s) return;
    setResumeModel(claudeModelForRow(s));
    setResumeDangerous(defaultSkipPermissions || false);
    setResumeLaunchInNewWindow(false);
    setNativeResumeBinding(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- claudeModelForRow
    // is redefined every render; the row id is what actually changes here.
  }, [shownId, defaultSkipPermissions]);

  useEffect(() => {
    if (arrival !== 'run') return;
    // Just past --dur-switch (380ms). Dropping the class afterwards keeps a
    // stale animation off the element the next time it re-renders.
    const t = setTimeout(() => setArrival(null), 420);
    return () => clearTimeout(t);
  }, [arrival]);

  const narrowViewport = useNarrowViewport();
  // Two reasons the browser stays single-column, and they are different:
  //  · narrow — a 390px screen cannot hold a list AND a transcript. 640px is
  //    the app's one breakpoint (.claude/rules/narrow-viewport.md); do not
  //    invent a second.
  //  · Android — `chatsearch:read` answers not-implemented-on-mobile there
  //    (SessionService.kt), so the panel could only ever show an error. Phones
  //    are already excluded by the width test; this is for a tablet wide enough
  //    to pass it. The list is fully usable without the panel, which is what
  //    makes hiding it legitimate rather than a narrow "fix" that removes the
  //    only route to something.
  const previewOn = !narrowViewport && !isAndroid();
  const [resumeModel, setResumeModel] = useState<string>(defaultModel || 'sonnet');
  const [resumeDangerous, setResumeDangerous] = useState(defaultSkipPermissions || false);
  // First-time Skip Permissions warning (spec §5). This browser is an L1
  // modal, so the L2 warning simply sits on top of it — no yielding needed.
  const { gate: gateSkipPermissions, dialog: skipPermissionsDialog } = useFirstTimeGate('skip-permissions');
  // Task 6 — native resume ALWAYS offers the provider-scoped model selector
  // (Destin's ruling: never auto-launch a binding). null until the user picks
  // a row OR ModelPicker auto-selects a prefill match; the Resume button
  // stays disabled for a native row until this is set. Reset whenever a
  // (possibly different) row expands/collapses — a fresh ModelPicker
  // mount per expansion is what actually resets ITS internal state; this just
  // keeps the Resume-button gate and the value threaded through onResume in
  // sync with that same lifecycle.
  const [nativeResumeBinding, setNativeResumeBinding] = useState<ModelBinding | null>(null);
  // Launch the resumed session in a new peer window (multi-window only).
  const [resumeLaunchInNewWindow, setResumeLaunchInNewWindow] = useState(false);
  // Sesion id currently resuming — keeps its Resume button busy + the browser open
  // until the create acks (Task 6 review ack-gap). Closes only on a launched resume.
  const [resumingId, setResumingId] = useState<string | null>(null);
  const detachAvailable = typeof (window as any).claude?.detach?.openDetached === 'function';
  // Show Complete: when off, sessions marked complete are hidden (default).
  // Deliberately NOT persisted — it resets to off on every open, same as the
  // project/tag filter pills below. Destin's ruling: a browser that reopens
  // still showing completed work hides the list he actually came for.
  const [showComplete, setShowComplete] = useState(false);

  // Sessions the user flagged Complete during the current open. They stay
  // visible until the menu is closed and reopened, so the row doesn't vanish
  // mid-interaction when Show Complete is off. Reset on every open.
  const [stickyComplete, setStickyComplete] = useState<Set<string>>(new Set());
  /** Non-null when the last load FAILED. Empty string = it failed and said no reason. */
  const [loadError, setLoadError] = useState<string | null>(null);

  // New filter state — all reset on each open (no localStorage). Default values
  // (empty Sets, sortDir='desc') produce identical behaviour to the prior
  // hard-coded filter pipeline.
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Tracks which filter pill's dropdown is currently open. null = both closed.
  // Single state instead of two booleans so the dropdowns are mutually exclusive.
  const [openPill, setOpenPill] = useState<'projects' | 'tags' | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Below 640px the chips give way to the filter button docked in the search
  // pill (deck round 1, S-7): one popover holds all three controls.
  const narrow = useNarrowViewport();
  useEffect(() => { if (!narrow) setFiltersOpen(false); }, [narrow]);
  const filtersPopoverRef = useRef<HTMLDivElement | null>(null);
  const [filtersPos, setFiltersPos] = useState<{ top: number; right: number } | null>(null);
  const measureFilters = () => {
    const r = searchRef.current?.getBoundingClientRect();
    return r ? { top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) } : null;
  };

  // Which card's Organize popover is open (session id), plus its anchor position.
  //
  // WHY A POPOVER: flags, tags and the note used to sit in the expanded row,
  // below the launch controls — so one open card stacked seven form fields and
  // the Resume button ended up at the bottom of a form. They are a different
  // JOB from resuming (organizing a conversation you are NOT about to open), so
  // they moved out here. Side effect worth having: you can now tag or complete a
  // conversation WITHOUT expanding it, including rows that can't be resumed on
  // this device at all.
  const [organizeId, setOrganizeId] = useState<string | null>(null);
  const organizeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const organizePopRef = useRef<HTMLDivElement>(null);
  // The tag registry editor (rename/recolor/archive/delete). Opened from the
  // "Manage tags…" footer of the Organize popover's TagPicker; the Tags filter
  // menu's second route was removed at Destin's request (deck round 1, S-4), so
  // there is ONE destination for tag management.
  const [tagManagerOpen, setTagManagerOpen] = useState(false);

  // Fetch sessions when opened
  // WHY a failed load is not an empty list: this used to `.catch(() => setSessions([]))`,
  // so anything going wrong — a dropped connection on a phone, a request that timed out
  // after thirty seconds — produced "No previous sessions found". A confident, wrong
  // sentence about someone's own history. Destin hit it over remote access on 2026-09-10:
  // nothing appeared, then it worked on the second try, and there was no way to tell from
  // the screen that the first attempt had failed at all.
  const loadSessions = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    (window as any).claude.session.browse()
      .then((list: PastSession[]) => { setSessions(list); setLoadError(null); })
      .catch((err: any) => {
        setSessions([]);
        // The real message when there is one; never a guess about the cause.
        setLoadError(err?.message ? String(err.message) : '');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (open) {
      setSearch('');
      setExpandedId(null);
      setResumeModel(defaultModel || 'sonnet');
      setResumeDangerous(defaultSkipPermissions || false);
      setNativeResumeBinding(null);
      setOrganizeId(null);
      setTagManagerOpen(false);
      // Reset the sticky-visible set each open — previously kept rows drop out.
      setStickyComplete(new Set());
      // Show Complete resets to off each open — the component stays mounted
      // across opens, so the useState initializer alone would never re-run.
      setShowComplete(false);
      // Reset filter pills each open — current spec: no persistence.
      setSelectedProjects(new Set());
      setSelectedTagIds(new Set());
      setSortDir('desc');
      loadSessions();
      const t = setTimeout(() => searchRef.current?.querySelector('input')?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Layered ESC: close the tag manager, then an open Organize popover, then an
  // open filter dropdown, then collapse the expanded row, then close the
  // browser. Each ESC press peels one layer.
  const handleEscClose = useCallback(() => {
    if (tagManagerOpen) setTagManagerOpen(false);
    else if (organizeId) setOrganizeId(null);
    else if (openPill) setOpenPill(null);
    else if (expandedId) setExpandedId(null);
    else onClose();
  }, [tagManagerOpen, organizeId, openPill, expandedId, onClose]);
  useEscClose(open && !renameSession, handleEscClose);

  // Close the active filter dropdown on outside click. Recognizes clicks
  // inside the trigger row AND the portaled dropdowns (which live in
  // document.body, outside filterRowRef).
  // A tap that only meant "close this menu" must not travel on to the scrim
  // and close the whole browser with the filters in it (UX review 2, U2): the
  // mousedown that closes a menu arms a one-shot capture listener that swallows
  // the click that follows it.
  const swallowNextClick = useRef(false);
  useEffect(() => {
    const swallow = (e: MouseEvent) => {
      if (!swallowNextClick.current) return;
      swallowNextClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    };
    document.addEventListener('click', swallow, true);
    return () => document.removeEventListener('click', swallow, true);
  }, []);
  useEffect(() => {
    if (!openPill) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (filterRowRef.current?.contains(target)) return;
      if (projectsDropdownRef.current?.contains(target)) return;
      if (tagsDropdownRef.current?.contains(target)) return;
      // Inside the phone panel the panel itself stays; the click is still spent.
      swallowNextClick.current = true;
      setOpenPill(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [openPill]);
  // The phone popover closes on a tap outside it, its pill, and the menus that
  // open from the chips inside it (those are portaled, so not its descendants).
  useEffect(() => {
    if (!filtersOpen) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (searchRef.current?.contains(target)) return;
      if (filtersPopoverRef.current?.contains(target)) return;
      if (projectsDropdownRef.current?.contains(target)) return;
      if (tagsDropdownRef.current?.contains(target)) return;
      swallowNextClick.current = true;
      setFiltersOpen(false);
      setOpenPill(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [filtersOpen]);

  // Same outside-click close for the Organize popover. It is portaled to
  // document.body, so the card's own subtree can't see it — the popover ref is
  // checked explicitly (the portal trap that already bit the model picker and
  // the folder switcher). The trigger is checked too so a second click on the
  // "⋯" toggles rather than close-then-reopen.
  useEffect(() => {
    if (!organizeId) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (organizePopRef.current?.contains(target)) return;
      if (organizeTriggerRef.current?.contains(target)) return;
      setOrganizeId(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [organizeId]);


  const filtered = useMemo(() => {
    // Filter pipeline lives in resume-browser-filters.ts so it can be unit tested.
    // Order: Show Complete + sticky → project → tag → search.
    const state: FilterState = {
      search,
      showComplete,
      stickyComplete,
      selectedProjects,
      selectedTagIds,
      tagLabelById: Object.fromEntries(registry.tags.map((t) => [t.id, t.label])),
    };
    return applyFilters(sessions, state);
  }, [sessions, search, showComplete, stickyComplete, selectedProjects, selectedTagIds, registry.tags]);

  // Two different rows, deliberately: `selectedSession` is what the user just
  // clicked (it drives the list's highlight and the read); `previewSession` is
  // what the sheet is currently showing, which lags it until that read settles.
  const selectedSession = previewOn && previewId
    ? filtered.find((r) => r.sessionId === previewId) ?? null
    : null;
  const previewSession = previewOn && shownId
    ? filtered.find((r) => r.sessionId === shownId) ?? null
    : null;

  // PERF: the transcript pane is memoised on the three values that actually
  // address it. Without this, EVERY state change in this component — a
  // keystroke in the search box, a filter pill, a hover — re-rendered the pane
  // and with it one MarkdownContent per message. MarkdownContent is React.memo'd
  // on its own content, so each one bailed out, but React still walked the whole
  // subtree on every keypress. Nothing below the memo depends on this
  // component's state, so there is no correctness cost.
  const previewPane = useMemo(
    () => (selectedSession ? (
      <SessionPreviewPane
        provider={(selectedSession.provider === 'native' ? 'native' : 'claude') as ChatsearchProvider}
        id={selectedSession.sessionId}
        title={selectedSession.name}
        onSettled={onPreviewSettled}
        holdWhileLoading
      />
    ) : null),
    [selectedSession?.provider, selectedSession?.sessionId, selectedSession?.name, onPreviewSettled],
  );

  // Group by project path ONLY when the user has narrowed via the Projects
  // pill — the default view is pure chronological (each row carries its own
  // project label instead). Within-group sort is priority-pinned + lastModified
  // by sortDir; between-group order also follows sortDir. Search always stays
  // flat so results read as one ranked list.
  const filtersActive = selectedProjects.size > 0 || selectedTagIds.size > 0;
  // The way out of an empty list names what emptied it (design guide G-18).
  const emptyAction = search.trim() && filtersActive
    ? { label: 'Clear search and filters', onClick: () => { setSearch(''); setSelectedProjects(new Set()); setSelectedTagIds(new Set()); } }
    : search.trim() ? { label: 'Clear search', onClick: () => setSearch('') }
    : filtersActive ? { label: 'Clear filters', onClick: () => { setSelectedProjects(new Set()); setSelectedTagIds(new Set()); } }
    : undefined;
  // One project picked needs no group header — it would repeat the chip's own
  // label above the only group (UX review U17).
  const grouped = useMemo(() => {
    if (search.trim() || selectedProjects.size <= 1) return null;
    return groupSessions(filtered, sortDir);
  }, [filtered, search, selectedProjects, sortDir]);

  // Flat list (default + search modes) — priority-pinned, lastModified by sortDir.
  const flatSorted = useMemo(() => {
    return sortSessions(filtered, sortDir);
  }, [filtered, sortDir]);

  // Flatten whichever mode is active into ONE ordered list of headers + rows.
  // Both branches used to render inline in the JSX, which meant the grouped
  // branch had no single index to bound — this is what makes the reveal window
  // below mode-agnostic.
  const items = useMemo<ListItem[]>(() => {
    if (grouped) {
      const out: ListItem[] = [];
      for (const [projectPath, rows] of grouped.entries()) {
        out.push({
          kind: 'header',
          key: `header:${projectPath}`,
          label: projectPath.replace(/\\/g, '/').split('/').pop() || projectPath,
          first: out.length === 0,
        });
        // No project label on the row: the header directly above names it.
        for (const s of rows) out.push({ kind: 'row', session: s, showPath: false });
      }
      return out;
    }
    return flatSorted.map((s) => ({ kind: 'row' as const, session: s, showPath: true }));
  }, [grouped, flatSorted]);

  // How much of `items` is currently materialized. Grows as the user scrolls.
  const [revealCount, setRevealCount] = useState(REVEAL_CHUNK);

  // Reset the window to the top whenever the user changes WHAT THEY ARE LOOKING
  // FOR — a new search, filter, or sort order is a new list, and it should start
  // at the top and cost one chunk to draw.
  //
  // Keyed on the query VALUES, deliberately not on `items`' identity. `items`
  // also changes when a session mutates (tagging a row, marking one complete,
  // saving a note all rewrite `sessions`), and resetting on those would collapse
  // the list back to 50 rows under a user who had scrolled down to organize
  // something — yanking their scroll position as a side effect of tagging.
  const queryKey = useMemo(() => JSON.stringify([
    search.trim(), sortDir, showComplete,
    [...selectedProjects].sort(), [...selectedTagIds].sort(),
  ]), [search, sortDir, showComplete, selectedProjects, selectedTagIds]);
  const [lastQueryKey, setLastQueryKey] = useState(queryKey);
  if (queryKey !== lastQueryKey) {
    // Adjusting state during render (the React-documented pattern) rather than
    // in an effect. An effect would commit one render at the OLD revealCount
    // first — for a user who had scrolled deep that is exactly the 1,000-row
    // render this whole change exists to avoid, once per keystroke.
    setLastQueryKey(queryKey);
    setRevealCount(REVEAL_CHUNK);
  }

  // A new query starts at the top of its results. Load-bearing for the reveal
  // window, not just manners: resetting revealCount while the container stays
  // scrolled 250 rows down leaves the sentinel already in view, so the observer
  // below immediately cascades the window back up to cover the scroll offset —
  // measured doing exactly that (search after scrolling deep re-revealed 250
  // rows instead of 50). Scrolling to the top is what makes the reset stick.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = 0;
  }, [queryKey, open, listRef]);

  const visibleItems = revealCount >= items.length ? items : items.slice(0, revealCount);
  const hasMore = items.length > visibleItems.length;

  // Top up when the sentinel below the last revealed row comes into view.
  // Same "don't do the work until it's needed" shape as ArtifactThumbnail's
  // fetch gating. Re-arming on every revealCount change is what makes it
  // cascade: if one chunk still doesn't reach past the sentinel (short rows, a
  // tall window), observing again fires again until it does.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !hasMore) return;
    // No IntersectionObserver (jsdom under test, any exotic WebView) — reveal
    // everything rather than stranding the list at 50 rows with no way to grow.
    if (typeof IntersectionObserver === 'undefined') { setRevealCount(items.length); return; }
    const el = sentinelRef.current;
    const root = listRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setRevealCount((n) => n + REVEAL_CHUNK); },
      { root, rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [open, hasMore, revealCount, items.length, listRef]);

  // Distinct projects with counts — what the Projects pill dropdown displays.
  // Derived from the unfiltered session list so the dropdown always shows
  // every known project, even when the user has narrowed the visible list.
  // Counts and rows reflect what the list can actually show: with Show Complete
  // off, a finished conversation is not counted and a project with only finished
  // conversations is not offered (UX review U6: "youcoded 2" then showed one row).
  const countable = useMemo(
    () => (showComplete ? sessions : sessions.filter((s) => !s.flags?.complete || stickyComplete.has(s.sessionId))),
    [sessions, showComplete, stickyComplete],
  );
  const availableProjects = useMemo(() => getAvailableProjects(countable), [countable]);
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of countable) for (const id of s.tags ?? []) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [countable]);

  // Chip labels: nothing picked → the category; one picked → its name; more →
  // the category and a count (design guide G-19: label, space, numeral — never
  // parentheses). The old 2–3 → comma-joined names made one chip as wide as the
  // whole row on a phone.
  // A picked project that the menu no longer offers (all its conversations are
  // finished and Show Complete is off) still names itself from its path.
  const projectsLabel = useMemo((): React.ReactNode => {
    const picked = [...selectedProjects].map((path) => availableProjects.find((p) => p.path === path)?.label ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path);
    return <PickLabel {...pickLabel('Projects', picked)} />;
  }, [selectedProjects, availableProjects]);
  const liveTags = useMemo(() => registry.tags.filter((t) => !t.archived), [registry.tags]);
  const tagsLabel = useMemo((): React.ReactNode => {
    const picked = [...selectedTagIds].map((id) => liveTags.find((t) => t.id === id)?.label ?? id);
    return <PickLabel {...pickLabel('Tags', picked)} />;
  }, [selectedTagIds, liveTags]);

  // Portal-anchored dropdown positions. Dropdown widths match the className
  // (Projects: w-64 = 256px, Tags: w-52 = 208px). Keep these in sync if the
  // className width changes.
  // The position is captured synchronously inside each pill's onClick handler
  // (not via useLayoutEffect) so the dropdown can render in the same React
  // commit as `openPill` flipping — eliminates the two-render lag the prior
  // implementation had between pill click and dropdown appearing.
  const [projectsDropdownPos, setProjectsDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [tagsDropdownPos, setTagsDropdownPos] = useState<{ top: number; left: number } | null>(null);
  // Reposition while open (resize / scroll updates only — not the initial
  // measurement, which is sync in the click handler).
  useDropdownReposition(openPill === 'projects', projectsTriggerRef, 256, setProjectsDropdownPos, filterRowRef);
  useDropdownReposition(openPill === 'tags', tagsTriggerRef, 208, setTagsDropdownPos, filterRowRef);
  // The panel re-centres when a pick shrinks or grows the list, which moves the
  // chips without any scroll or resize event. A menu left at its old spot then
  // covers the row, and the next click ticks a row nobody chose (UX review U1/U3).
  // Every setter below keeps the previous object when nothing moved: this
  // effect lists filtersPos as a dependency (at phone width the chips live
  // inside the panel, so their menus can only be placed once the panel has
  // landed — UX review 2, U3), and a fresh object on every run re-fired it
  // forever ("Maximum update depth exceeded", caught by the grader on R12).
  useLayoutEffect(() => {
    if (openPill === 'projects') setProjectsDropdownPos(samePos(measureDropdown(projectsTriggerRef, 256, filterRowRef)));
    if (openPill === 'tags') setTagsDropdownPos(samePos(measureDropdown(tagsTriggerRef, 208, filterRowRef)));
    if (filtersOpen) setFiltersPos(samePos(measureFilters()));
  }, [openPill, filtersOpen, filtered.length, filtersPos]);
  useEffect(() => {
    if (!filtersOpen) return;
    const remeasure = () => setFiltersPos(measureFilters());
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  }, [filtersOpen]);

  // Clear stale position state when the dropdown closes via outside-click or
  // ESC (the click handlers do this themselves, but those external paths
  // don't). Saves a tiny amount of memory and prevents a stale position from
  // briefly flashing if the same pill reopens before useDropdownReposition
  // has a chance to update.
  useEffect(() => {
    if (openPill !== 'projects' && projectsDropdownPos !== null) setProjectsDropdownPos(null);
    if (openPill !== 'tags' && tagsDropdownPos !== null) setTagsDropdownPos(null);
  }, [openPill, projectsDropdownPos, tagsDropdownPos]);

  // Optimistically flip a flag in local state, then persist via IPC. On failure
  // we revert. A meta-changed push from other tabs/devices also refreshes the
  // list — see the subscription effect below.
  const toggleFlag = async (sessionId: string, flag: FlagName, next: boolean) => {
    const apply = (val: boolean) => setSessions((prev) => prev.map((s) =>
      s.sessionId === sessionId ? { ...s, flags: { ...(s.flags || {}), [flag]: val } } : s,
    ));
    apply(next);
    // Pin just-flagged-Complete rows visible for the remainder of this open.
    const pinned = flag === 'complete' && next && !showComplete;
    if (pinned) {
      setStickyComplete((prev) => {
        const ns = new Set(prev);
        ns.add(sessionId);
        return ns;
      });
    }
    // Reverting has to undo the STICKY PIN too, not just the flag — otherwise a
    // refused write leaves the row pinned as if Complete had been applied.
    const revert = () => {
      apply(!next);
      if (pinned) setStickyComplete((prev) => {
        const ns = new Set(prev);
        ns.delete(sessionId);
        return ns;
      });
    };
    try {
      const res: any = await (window as any).claude.session.setFlag(sessionId, flag, next);
      if (res && res.ok === false) revert();
    } catch {
      revert();
    }
  };

  // Apply/remove a custom tag on a past session (optimistic + persist).
  // Mirrors toggleFlag's revert-on-ok:false — without it a refused write (native
  // session) left the tag showing until the next browse, which read as "saved".
  const toggleTag = async (sessionId: string, tagId: string, next: boolean) => {
    const apply = (val: boolean) => setSessions((prev) => prev.map((s) =>
      s.sessionId === sessionId
        ? { ...s, tags: val ? [...new Set([...(s.tags ?? []), tagId])] : (s.tags ?? []).filter((t) => t !== tagId) }
        : s));
    apply(next);
    try {
      const res: any = await (window as any).claude.session.setTag(sessionId, tagId, next);
      if (res && res.ok === false) apply(!next);
    } catch (e) { apply(!next); console.error('resume: setTag failed', e); }
  };

  const saveNote = async (sessionId: string, note: string) => {
    const prev = sessions.find((s) => s.sessionId === sessionId)?.note ?? '';
    const apply = (text: string) => setSessions((list) =>
      list.map((s) => s.sessionId === sessionId ? { ...s, note: text } : s));
    apply(note);
    try {
      const res: any = await (window as any).claude.session.setNote(sessionId, note);
      if (res && res.ok === false) apply(prev);
    } catch (e) { apply(prev); console.error('resume: setNote failed', e); }
  };

  // Listen for cross-tab / cross-device meta changes while the browser is open.
  useEffect(() => {
    if (!open) return;
    const sub = (window as any).claude?.on?.sessionMetaChanged;
    if (!sub) return;
    const off = sub((sid: string, meta: { flag?: string; value?: boolean; note?: string }) => {
      setSessions((prev) => prev.map((s) => {
        if (s.sessionId !== sid) return s;
        let next = s;
        if (meta.flag && meta.flag.startsWith('tag:')) {
          const id = meta.flag.slice(4);
          const tags = meta.value ? [...new Set([...(s.tags ?? []), id])] : (s.tags ?? []).filter((t) => t !== id);
          next = { ...next, tags };
        } else if (meta.flag === 'priority' || meta.flag === 'complete') {
          next = { ...next, flags: { ...(next.flags || {}), [meta.flag]: !!meta.value } };
        }
        if (typeof meta.note === 'string') next = { ...next, note: meta.note };
        return next;
      }));
    });
    // Both preload and remote-shim return an unsubscribe fn for this channel,
    // so calling off() actually removes the listener (no per-open leak).
    return () => {
      try { if (typeof off === 'function') off(); } catch {}
    };
  }, [open]);

  // Which Claude alias a row's dropdown should OPEN on.
  //
  // Fix: every card used to open on `defaultModel` — the app-wide Settings
  // default — so resuming an Opus conversation silently offered Sonnet (or
  // whatever the global default was) unless you noticed and changed it. The
  // card already displays the real answer in its model chip; this feeds that
  // same value into the control beside it.
  //
  // Falls back to the global default when the row records no model, or records
  // one outside the four aliases the picker offers.
  //
  // Gated on the row being a Claude Code row: a native row's picker is driven
  // by nativeResumeBinding, and its recorded model can be an OpenRouter id that
  // merely CONTAINS a family word (`anthropic/claude-sonnet-4.5`). Letting that
  // set the CC alias would put a value into the argument handleConfirmResume
  // still forwards for native rows, on no evidence at all.
  const claudeModelForRow = (s: PastSession): string => {
    const recorded = s.provider !== 'native' ? s.lastUsedModel?.modelId : undefined;
    return (recorded ? claudeAliasForModelId(recorded) : null) || defaultModel || 'sonnet';
  };

  // Takes the whole row, not just its id: the expanded pane's model dropdown
  // starts on the model THIS conversation last ran on, which only the row
  // knows. See claudeModelForRow.
  const handleSelectSession = (s: PastSession) => {
    // With the panel open, clicking a row PREVIEWS it (and
    // re-clicking the same row does nothing, because collapsing the panel would
    // leave the right half empty for no reason the user asked for). The resume
    // controls live in the transcript pane, so the card itself never expands.
    if (previewOn) {
      setPreviewId(s.sessionId);
      setPreviewSheetOpen(false);
      setCloneOrganizeId(null);
      setOrganizeId(null);
      // NOT the resume state — the action card still belongs to the
      // conversation on screen until this one has loaded. It is reset in the
      // settle effect below, with the row the card is about to show.
      return;
    }
    if (expandedId === s.sessionId) {
      setExpandedId(null);
    } else {
      setExpandedId(s.sessionId);
      // Other half of the mutual exclusion (the tag button does the reverse):
      // a card shows the resume pane OR the tag sheet, never both. Clears any
      // card's open sheet, not just this one — two cards' panes open at once
      // would be the same stacking problem spread across rows.
      setOrganizeId(null);
      setResumeModel(claudeModelForRow(s));
      setResumeDangerous(defaultSkipPermissions || false);
      setResumeLaunchInNewWindow(false);
      setNativeResumeBinding(null);
    }
  };

  // Bridge the unified <ModelPicker> onto the two pieces of resume state that
  // already existed: `resumeModel` (a Claude alias) and `nativeResumeBinding`.
  // Which one a row uses is decided by its own provider, so the picker is
  // scoped and only one can ever be in play.
  const resumeChoice = (s: PastSession): ModelChoice | null => {
    if (s.provider === 'native') {
      return nativeResumeBinding
        ? { runtime: 'native', providerId: nativeResumeBinding.providerId, modelId: nativeResumeBinding.modelId }
        : null;
    }
    return resumeModel ? { runtime: 'claude', alias: resumeModel } : null;
  };

  const applyResumeChoice = (_s: PastSession, c: ModelChoice) => {
    if (c.runtime === 'native') setNativeResumeBinding({ providerId: c.providerId, modelId: c.modelId });
    else setResumeModel(c.alias);
  };

  const handleConfirmResume = async (s: PastSession) => {
    // Native sessions: the CC-only model / skip-permissions choices are
    // irrelevant (no PTY, no /model or /effort), so pass the current (default)
    // values but tag the row's provider so App takes the native path, PLUS the
    // binding the user just picked (or the prefill auto-selected) in the
    // ModelPicker below — the Resume button is disabled until this is
    // set (see the (s.provider === 'native' && !nativeResumeBinding) guard on
    // the button), so it is always present here for a native row.
    //
    // Task 6 review ack-gap: await the resume and close the browser ONLY when it
    // actually launched. A create that never acked returns false — keep the
    // browser open (App has toasted the honest reason) so the user can retry or
    // pick another row, rather than closing over a silent failure.
    setResumingId(s.sessionId);
    const result = await onResume(s.sessionId, s.projectSlug, s.projectPath, resumeModel, resumeDangerous, resumeLaunchInNewWindow, s.provider, nativeResumeBinding ?? undefined);
    setResumingId(null);
    if (result !== false) onClose(); // undefined (non-awaiting wiring) or true → close
  };

  if (!open) return null;

  // The expanded panel is now INSIDE the card (see renderSessionRow), so it
  // drops its own border/fill and separates with a rule instead. The old
  // `bg-inset/50` also had to go: the protection cascade that keeps nested
  // surfaces opaque inside an overlay is `.layer-surface .bg-inset`
  // (globals.css:951), and an opacity modifier emits `bg-inset/50` — a
  // different class the cascade does not match, so it would have gone
  // translucent on wallpaper themes.
  // Tags and note. There is no separate "Flags" section any more: Priority is
  // listed as a built-in TAG (it reads as a label you apply, because that is
  // what it is to the user — see built-in-tags.ts), and Complete moved out of
  // this popover entirely onto the card's hide icon, since marking something
  // done is a one-click action that shouldn't cost opening a menu.
  const renderOrganizeControls = (s: PastSession) => (
    <>
      {/* No "TAGS" / "NOTE" headers. A tag list and a text field do not need
          naming — the search placeholder and the note placeholder already say
          what each is, and the two labels were a third of the sheet's height.
          Matched across all three tag/note surfaces (2026-07-31).
          fieldClassName lifts the search box to `bg-well`: the sheet sits on
          the card, which IS the FIELD surface (`bg-inset`), so without it the
          field is the same colour as its background. Same override the close
          prompt and the model picker make, for the same reason. */}
      <div onClick={(e) => e.stopPropagation()}>
        <TagPicker
          appliedIds={new Set(s.tags ?? [])}
          onToggle={(tagId, next) => toggleTag(s.sessionId, tagId, next)}
          registry={registry}
          onManageTags={() => { setOrganizeId(null); setCloneOrganizeId(null); setTagManagerOpen(true); }}
          fieldClassName="bg-well border-edge"
          builtIns={[{
            tag: PRIORITY_TAG,
            hint: PRIORITY_HINT,
            applied: !!s.flags?.priority,
            // Stored as a flag, not a registry tag — the sort reads one known
            // key rather than scanning a user-editable list.
            onToggle: (next) => toggleFlag(s.sessionId, 'priority', next),
          }]}
        />
      </div>

      <div className="border-t border-edge-dim pt-2" onClick={(e) => e.stopPropagation()}>
        <NoteEditor
          value={s.note ?? ''}
          onSave={(text) => saveNote(s.sessionId, text)}
          fieldClassName="bg-well border-edge"
        />
      </div>
    </>
  );

  // The expanded panel answers ONE question: how do I relaunch this? Model,
  // the two launch toggles, Resume. Flags/tags/note used to be stacked in here
  // too, which is what made an open card a seven-field form with its primary
  // action at the bottom.
  const renderExpandedOptions = (s: PastSession, opts?: { flush?: boolean }) => {
  return (
    // `flush`: the action card at the foot of the preview draws
    // its own border, and this block's top hairline would double up against it.
    <div className={opts?.flush ? '' : 'border-t border-edge-dim'}>
      <div className="p-3 flex flex-col gap-2">
        {/* ONE model control for both runtimes. Was two: a Claude alias button
            row here and a separate native picker below, which is the duplication this
            picker exists to end. The list is SCOPED to the row's own runtime —
            a resume cannot move a conversation across runtimes, so offering the
            other side would be a pick that cannot be honoured. */}
        <div onClick={(e) => e.stopPropagation()}>
          <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Model</label>
          <ModelPicker
            value={resumeChoice(s)}
            onSelect={(c) => applyResumeChoice(s, c)}
            includeClaude={s.provider !== 'native'}
            includeNative={s.provider === 'native'}
            prefill={s.lastUsedModel}
            onManageModels={() => window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'))}
          />
        </div>

        {/* Skip Permissions is Claude-Code-only — a native session has no PTY
            permission flow. */}
        {s.provider !== 'native' && (
          <>
            {/* Skip Permissions */}
            <div className="flex items-center justify-between">
              <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase inline-flex items-center">
                Skip Permissions
                <SkipPermissionsInfoTooltip />
              </label>
              {/* Shared Toggle (change 15). Its "danger" tone replaces the raw
                  #DD4444 hex this used to hard-code, so themes can restyle it.
                  aria-label added because the adjacent <label> was never
                  associated with the control — screen readers announced nothing. */}
              <Toggle
                checked={resumeDangerous}
                // Turning ON goes through the first-time warning; Cancel there
                // leaves it off. Turning off never asks.
                onChange={(next) => (next ? gateSkipPermissions(() => setResumeDangerous(true)) : setResumeDangerous(false))}
                tone="danger"
                aria-label="Skip Permissions"
              />
            </div>
            {/* Warning text was a raw text-[#DD4444] hex. Change 17 moves it onto
                the same token as the toggle beside it, so a community theme
                restyling its red doesn't leave the two out of sync. */}
            {resumeDangerous && (
              <SkipPermissionsCaption />
            )}
          </>
        )}

        {/* Launch in new window — hidden on remote/Android (single-window) */}
        {detachAvailable && (
          <div className="flex items-center justify-between">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Launch in New Window</label>
            {/* Shared Toggle (change 15) — same accent on-state as before. */}
            <Toggle
              checked={resumeLaunchInNewWindow}
              onChange={setResumeLaunchInNewWindow}
              aria-label="Launch in New Window"
            />
          </div>
        )}

        {/* Resume button. The dangerous (skip-permissions) styling is CC-only —
            native sessions have no PTY permission flow, so it never applies. */}
        {(() => {
          const dangerous = s.provider !== 'native' && resumeDangerous;
          // Task 6 — Resume stays disabled for a native row until a model
          // binding exists (manual pick or a prefill auto-select). Never lets
          // resume proceed with no binding to launch — that would be exactly
          // the auto-launch Destin's ruling forbids.
          const nativeNeedsPick = s.provider === 'native' && !nativeResumeBinding;
          const busy = resumingId === s.sessionId; // create in flight — keep the button busy (ack-gap)
          return (
            /* Filled danger for skip-permissions — same call as SessionStrip's
               Create button (spec §11, change 62). See the longer note there. */
            <Button
              variant={dangerous ? 'danger' : 'primary'}
              size="lg"
              onClick={() => handleConfirmResume(s)}
              disabled={nativeNeedsPick || busy}
              className="w-full py-1.5"
            >
              {busy ? 'Resuming…' : dangerous ? 'Resume (Dangerous)' : 'Resume Session'}
            </Button>
          );
        })()}
      </div>
    </div>
  );
  };

  // `clone`: the preview's header is this same card drawn a
  // second time. Both copies are on screen at once, so the tag/note sheet needs
  // its own open-id per copy — sharing one made pressing Tag in the header also
  // expand the card in the list and shove the rest of the list down.
  const renderSessionRow = (s: PastSession, showPath?: boolean, clone?: boolean) => {
    const orgId = clone ? cloneOrganizeId : organizeId;
    const setOrg = clone ? setCloneOrganizeId : setOrganizeId;
    const isExpanded = expandedId === s.sessionId;
    // With the resume controls out of the card, the accent border
    // is the ONLY thing left saying which row the right panel is showing, so
    // the previewed row has to claim it whether or not anything expanded.
    const isSelected = isExpanded || (previewOn && previewId === s.sessionId);
    // Unresumable rows are inert: no card hover, no expand. See the note on the
    // click handler below for the two reasons a row lands here.
    // Resume needs the project folder AND the transcript; a PREVIEW needs only
    // the transcript. So `missingProject` (synced in from another device, folder
    // not here) is readable and is no longer inert once the panel is open —
    // reading a conversation you cannot resume on this machine is most of why
    // the panel exists. `notSyncedYet` stays inert either way: the transcript
    // itself has not arrived, so there is nothing to show.
    const canResume = !s.missingProject && !s.notSyncedYet;
    const inert = previewOn ? !!s.notSyncedYet : !canResume;
    // px-4 matches the search bar and the project group headers above, so the
    // card's outer edge lines up with the rest of the panel.
    return (
    <div key={s.sessionId} className="px-4 pb-2">
      {/* Expandable card. The surface is `bg-inset` + `border-edge-dim`, NOT
          `.layer-surface`.
          `.layer-surface` is the FLOATING surface — panel fill + border +
          `0 8px 32px` shadow + the wallpaper glass treatment — and it must
          appear exactly ONCE per stack. It is right for a card sitting directly
          on canvas (SkillCard.tsx:117, MarketplaceCard, FilesTab.tsx:393) and
          for the overlay itself. Nesting one inside another stacks all four:
          under `[data-wallpaper]` each `.layer-surface` is
          `color-mix(--panel, panels-opacity%)`, so a card inside the Resume
          OverlayPanel lays a second helping of --panel over the first and the
          cards glow brighter than the panel holding them (reported 2026-07-30).
          CommandDrawer gets away with `.layer-surface` tiles only because its
          own container is a plain `bg-panel` utility (CommandDrawer.tsx:195),
          which the wallpaper rule does not touch.
          `bg-inset` is what every other item nested in an overlay uses —
          ModelPicker rows, OpenTasksPopup, TagPicker, ContextPopup — and the
          protection cascade (`.layer-surface .bg-inset`, globals.css:951) keeps
          it opaque inside a glass panel.
          Bare `bg-inset` here rather than change 25's `bg-inset/50` in-panel ROW
          surface (EngineCard.tsx:92, LocalModelsSection, ModelProvidersPopup —
          24 files): a row is a tint inside a section, a card is an object you
          click, so it gets the full fill. Worth knowing that the /50 form falls
          outside the protection cascade above, which matches on `.bg-inset`
          exactly — so those rows do let a wallpaper through where a bare
          `bg-inset` would not. That is long-standing and deliberate-looking;
          it is NOT something to "fix" from this file.
          `card-interactive` is deliberately absent — its own comment scopes it
          to cards that ARE a `.layer-surface`, and its hover fill is
          `var(--inset)`, a no-op on an inset base. Hover moves the border
          instead, following SettingsPanel.tsx:1833's selectable cards.
          The card wraps BOTH the trigger and the expanded panel so an open row
          reads as one object instead of a row with a detached box under it. */}
      <div
        // `relative` is load-bearing: the icon cluster is positioned against
        // this card, not the panel. The icon buttons are SIBLINGS of the expand
        // trigger, never nested — a button inside a button is invalid HTML and
        // the inner one would never receive its own click.
        className={`relative rounded-lg border bg-inset overflow-hidden transition-colors ${
          isSelected ? 'border-accent' : inert ? 'border-edge-dim' : 'border-edge-dim hover:border-edge'
        }`}
      >
      {/* WHY: match SessionDrawer's filename rename classes and Ic pencil, not
          the organize icons. Keep the viewer unchanged and retain this dialog's
          separate keyboard handling. R5-1 keeps both edit cues visible even at rest. */}
      <div className={`flex items-center gap-1 px-3 pt-2 ${ICON_GUTTER}`}>
        {namingApi() ? <Button variant="ghost" size="sm"
          // -ml-2 cancels the button's own px-2 so the NAME's first letter lands
          // on the same left edge as the metadata line below it, while the hover
          // background keeps its padding. Without it the title sat 8px right of
          // everything else in the card and the row read as indented.
          className="group flex items-center justify-start gap-1.5 min-w-0 -ml-2 px-2 py-1 rounded-md cursor-text hover:bg-well transition-colors"
          aria-label={`Rename ${s.name}`} aria-haspopup="dialog"
          onKeyDown={(e) => {
            // WHY: Enter did not synthesize a click in the isolated workbench
            // keyboard check; activate it explicitly. Space stays native.
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setRenameSession(s); }
          }}
          onClick={(e) => { e.stopPropagation(); setRenameSession(s); }}>
          <span className="text-sm-tight font-semibold text-fg truncate decoration-dotted underline-offset-[3px] underline decoration-fg-muted">{s.name}</span>
          <span className="text-fg-muted shrink-0">
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </span>
        </Button> : <button type="button" className="text-sm truncate text-left min-w-0 focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => { if (!inert) handleSelectSession(s); }} aria-disabled={inert || undefined}>
          {s.name}
        </button>}
      </div>
      <button
        // Resume is disabled for conversations whose project folder isn't on
        // this device (synced in from elsewhere) OR whose transcript hasn't
        // synced here yet — either way there's nothing to resume into, so the
        // row shows a plain-words note instead of expanding.
        onClick={() => { if (!inert) handleSelectSession(s); }}
        aria-disabled={inert || undefined}
        aria-expanded={inert ? undefined : isExpanded}
        // WHY an explicit label: the session name used to be this button's only
        // text, and R12 moved it into the rename control above. Without this the
        // resume control announces nothing but its metadata line.
        aria-label={s.name}
        className={`w-full text-left px-3 pb-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          inert ? 'text-fg-dim cursor-default' : isSelected ? 'text-fg' : 'text-fg-dim'
        }`}
      >
        <div className="min-w-0">
          {/* ICON_GUTTER on the two upper rows, none on the bottom one — that
              asymmetry is the whole point. The icon buttons are absolutely
              positioned over the card's top-right corner, so the trigger can
              span the FULL card width and the timestamp on the bottom row lands
              flush with the card's right padding. Laying the icons out as flex
              siblings instead (as this did) shortened the trigger by their
              width, which left the date visibly short of the right edge. */}
          {/* Title only. The "YouCoded" + "Coder"/"Assistant" badges that used
              to lead this line are gone: they named the RUNTIME and the harness
              preset, which is internal vocabulary, and they pushed the actual
              conversation title right on every native row. The model chip on
              the line below says the same thing in the user's terms — a model
              name — and says it for Claude Code rows too. */}
          {/* Tag chips after the name. Priority is FIRST and rendered with the
              same TagChip as everything else — it is a built-in tag, not a
              separate species of label (built-in-tags.ts). Complete has no chip:
              its state is the hide icon on the right of this row. */}
          {(s.flags?.priority || (s.tags && s.tags.length > 0) || s.note) && (
            <div className={`flex items-center gap-1 mt-0.5 flex-wrap ${ICON_GUTTER}`}>
              {s.flags?.priority && <TagChip tag={PRIORITY_TAG} />}
              {(s.tags ?? []).map((id) => {
                const t = registry.byId.get(id);
                return t ? <TagChip key={id} tag={t} /> : null;
              })}
              {s.note && <span className="text-4xs text-fg-muted" title={s.note}>📝 note</span>}
            </div>
          )}
          {/* Bottom line: one dotted trail of context on the left — project,
              model, size — then the timestamp on the right.
              The model sits INSIDE that trail rather than floating right beside
              the date: it is another fact ABOUT the conversation, and pinning
              it to the right edge grouped it with the timestamp instead
              (reported 2026-07-31 with a screenshot).
              Built as segments joined by "·" rather than a template string,
              because two of the three are conditional — grouped mode drops the
              project (the group header names it) and a conversation with no
              recorded model drops that — and a literal separator would leave
              stray dots on either.
              The timestamp lives here rather than on the title line: the two
              icon buttons own the card's top-right corner, and a third item
              crowding in beside them read as part of that control cluster. */}
          <div className="flex items-center gap-1.5 text-3xs text-fg-muted">
            {s.missingProject || s.notSyncedYet ? (
              // Plain words, no glyphs (house rule). The conversation is visible
              // everywhere; resume needs the project folder AND its transcript
              // present on this device — the two notes say which one is missing.
              <span className="truncate flex-1 min-w-0">
                {s.notSyncedYet ? 'Not synced to this device yet' : 'Project folder not on this device'}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
                {[
                  // Same folder glyph as the project picker (FolderSwitcher.tsx:186)
                  // so "which project" looks the same wherever it is answered.
                  showPath ? (
                    <span key="project" className="flex items-center gap-1 min-w-0">
                      <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      <span className="truncate">{s.projectPath.replace(/\\/g, '/').split('/').pop()}</span>
                    </span>
                  ) : null,
                  // Last model this conversation actually RAN on, beside the same
                  // layers glyph the model picker uses. Rendered only when the
                  // record has one — showing the app default here would be a
                  // guess dressed as history. See PastSession.lastUsedModel for
                  // which conversations carry it.
                  s.lastUsedModel ? (
                    <span
                      key="model"
                      className="flex items-center gap-1 min-w-0"
                      title={`Last used ${s.lastUsedModel.modelId} (${s.lastUsedModel.providerLabel})`}
                    >
                      {/* Company mark instead of the generic stacked-layers
                          glyph. The mark carries the brand colour; the model
                          NAME stays muted like the rest of the meta line — this
                          is a card of five grey facts, and colouring the text
                          would promote the model above the project and the date
                          for no reason. PortableModelRef already carries
                          providerType, so the match works even for an id that
                          names no company (a bare custom-endpoint id). */}
                      {(() => {
                        const b = resolveModelBrand(s.lastUsedModel.modelId, s.lastUsedModel.providerType);
                        return b?.icon
                          ? <span className="shrink-0 inline-flex" style={{ color: b.color }}><ProviderIcon icon={b.icon} size={12} /></span>
                          : <ModelIcon className="w-3 h-3 shrink-0" />;
                      })()}
                      <span className="truncate">{formatModelId(s.lastUsedModel.modelId)}</span>
                    </span>
                  ) : null,
                  <span key="size" className="shrink-0">{formatSize(s.size)}</span>,
                ]
                  .filter(Boolean)
                  // Separators are injected between surviving segments, so a
                  // missing project or model never leaves a dangling dot.
                  .flatMap((node, i) => (i === 0
                    ? [node]
                    : [<span key={`sep-${i}`} className="shrink-0">·</span>, node]))}
              </span>
            )}
            <span className="shrink-0 ml-auto">{formatRelativeTime(s.lastModified)}</span>
          </div>
        </div>
      </button>
      {/* The two icon buttons, overlaid on the card's top-right corner rather
          than laid out beside the trigger. Order is TAG then COMPLETE, so
          Complete — the one that changes what the list shows — sits outermost
          and lands on the same vertical line as the timestamp below it.
          Padding is what sets both the outer alignment and the space between
          the pair: py-1.5/px-1 buttons put 8px between the two icons (4 + 4)
          while the cluster's pr-2 puts the last icon's right edge 12px from the
          card edge, matching the trigger's p-3. */}
      <div className="absolute top-0 right-0 pt-1.5 pl-1.5 pr-2 flex items-start">
      {/* Tags and note. Always visible rather than hover-revealed — a
          hover-only affordance is invisible on touch and undiscoverable on
          desktop, and this is the ONLY route to tagging. Rendered for inert
          rows too: the metadata is Conversation Store-backed, so a conversation
          synced in from another device can be organized here even though it
          can't be resumed on this one. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (orgId === s.sessionId) { setOrg(null); return; }
          organizeTriggerRef.current = e.currentTarget;
          // The two panes are mutually exclusive: a card shows EITHER how to
          // relaunch it or how to organize it, never both stacked. Without this
          // an open card could grow two panels deep and the Resume button would
          // slide down the screen as you tagged.
          setExpandedId(null);
          setOrg(s.sessionId);
        }}
        aria-label={`Organize ${s.name}`}
        aria-haspopup="dialog"
        aria-expanded={orgId === s.sessionId}
        className={`px-1 py-1.5 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          orgId === s.sessionId ? 'text-fg' : 'text-fg-faint hover:text-fg-2'
        }`}
      >
        {/* A tag, not a generic dots menu — it names what the sheet holds.
            Shared with the close prompt's summary (tags/glyphs.tsx) so the mark
            can't drift between the two surfaces that draw it. */}
        <TagGlyph className="w-4 h-4" />
      </button>
      {/* Complete. It sits on the card rather than inside the tag sheet because
          finishing with a conversation is a one-click action, and costing a
          menu-open for it is what made the old flag row feel buried. Hover copy
          is a question ("Mark this session complete?") so the icon reads as an
          action, not a status badge. */}
      {(() => {
        const done = !!s.flags?.complete;
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleFlag(s.sessionId, 'complete', !done); }}
            aria-pressed={done}
            title={done ? 'Marked complete — hidden unless Show Complete is on. Click to undo.' : 'Mark this session complete?'}
            aria-label={done ? `Mark ${s.name} not complete` : `Mark ${s.name} complete`}
            className={`px-1 py-1.5 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              done ? 'text-accent' : 'text-fg-faint hover:text-fg-2'
            }`}
          >
            {/* Check-in-a-circle, not the eye-with-a-slash this started as:
                the control's NAME is Complete, and "done" is what the user is
                actually saying. That its effect is to hide the row from the
                list is a consequence, and one the Show Complete toggle already
                explains. Filled when set so the state reads at a glance. */}
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="9" fill={done ? 'currentColor' : 'none'} />
              {/* Knocked out of the fill when set — var(--canvas), not a
                  hardcoded white, so it survives a dark or community theme. */}
              <path d="M8 12.5l2.5 2.5L16 9.5" stroke={done ? 'var(--canvas)' : 'currentColor'} />
            </svg>
          </button>
        );
      })()}
      </div>
      {/* 'sheet' variant: the organize controls drop INTO the card rather than
          floating. No positioning maths and nothing to clamp — the trade is
          that the card grows and pushes the rest of the list down.
          It shares organizePopRef with the floating variants: only one of the
          two is ever mounted, and the outside-click handler checks that ref to
          know "the click landed inside the open organize UI". */}
      {orgId === s.sessionId && (
        <div ref={clone ? undefined : organizePopRef} className="border-t border-edge-dim p-2.5 flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
          {renderOrganizeControls(s)}
        </div>
      )}
      {isExpanded && renderExpandedOptions(s)}
      </div>
    </div>
    );
  };


  // The action card at the FOOT of the sheet, in the place a real
  // conversation puts its message box: this is where you act on what you just
  // read. Its contents are `renderExpandedOptions` verbatim — the same block the
  // expanded card in the list and ResumeOptionsPopover already draw — because
  // Destin's ruling on the switches was "this should look like it does in our
  // other existing new/resume surfaces", and re-styling them here is exactly how
  // three surfaces drift apart. `flush` only drops the top hairline, which would
  // otherwise double up against the card's own border.
  const renderActionCard = (s: PastSession) => (
    <div className="shrink-0 p-3 pt-0">
      <div className="rounded-lg border border-edge bg-panel shadow-[0_4px_16px_rgba(0,0,0,0.18)]">
        {/* Readable but not resumable here. The row's own card carries the same
            sentence; repeating it at the foot is the answer to "so why is there
            no Resume button?", asked at the moment it is asked. */}
        {s.missingProject ? (
          <div className="px-3 py-2.5 text-2xs text-fg-muted">
            Project folder not on this device — you can read this conversation, but it has to be resumed where its folder lives.
          </div>
        ) : (<>
        {/* No folder chip here. It was above the model picker until Destin
            pointed out the header card at the top of the sheet already says
            which folder this is — the same fact twice, 300px apart. */}
        {renderExpandedOptions(s, { flush: true })}
        </>)}
      </div>
    </div>
  );

  // The filter row: three chips. Rendered under the search box at desktop width
  // and INSIDE the phone popover below 640px (deck round 1 S-7, round 2 S-9 —
  // "project/tags should be dropdowns"), so both widths share one set of controls.
  const chipsRow = (
        <div ref={filterRowRef} className={narrow ? 'flex flex-wrap items-center gap-2' : 'flex items-center gap-2 mt-2 scroll-fade-x'}>
          {/* Projects: pick-any menu over the distinct project paths in the loaded
              sessions. The menu is portaled to document.body so it escapes the
              OverlayPanel's overflow:hidden clipping (lets it overlap the panel edge). */}
          <FilterMenuChip
            buttonRef={projectsTriggerRef}
            active={selectedProjects.size > 0}
            open={openPill === 'projects'}
            className="shrink-0 max-w-[7rem]"
            onClick={(e) => {
              e.stopPropagation();
              // Measure synchronously so the dropdown renders with its final
              // position in the same commit as openPill flipping. Avoids the
              // two-render lag the prior useLayoutEffect approach had.
              if (openPill === 'projects') {
                setOpenPill(null);
                setProjectsDropdownPos(null);
              } else {
                setProjectsDropdownPos(measureDropdown(projectsTriggerRef, 256, filterRowRef));
                setOpenPill('projects');
              }
            }}
          >
            {projectsLabel}
          </FilterMenuChip>
          {openPill === 'projects' && projectsDropdownPos && createPortal(
            <div
              ref={projectsDropdownRef}
              className="layer-surface w-64 max-w-[calc(100vw-1rem)] overflow-hidden"
              style={{ position: 'fixed', top: projectsDropdownPos.top, left: projectsDropdownPos.left, zIndex: 60 }}
            >
              {/* The list scrolls; the footer stays put, so Clear never leaves
                  the screen behind a long list of projects. */}
              <div role="listbox" aria-multiselectable aria-label="Filter by project" className="max-h-56 overflow-y-auto py-1">
                {availableProjects.map((p) => {
                  const checked = selectedProjects.has(p.path);
                  return (
                    <button
                      key={p.path}
                      type="button"
                      role="option"
                      aria-selected={checked}
                      onClick={() => {
                        setSelectedProjects((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.path)) next.delete(p.path);
                          else next.add(p.path);
                          return next;
                        });
                      }}
                      className={MENU_ROW}
                    >
                      <CheckboxMark checked={checked} />
                      <span className="flex-1 truncate" title={p.path}>{p.label}</span>
                      <span className="text-2xs text-fg-muted shrink-0 tabular-nums">{p.count}</span>
                    </button>
                  );
                })}
              </div>
              {/* Clear empties the selection, which the data model treats as
                  "filter inactive". Dimmed rather than hidden when there is
                  nothing to clear, so the menu's height never jumps. */}
              <div className={MENU_FOOTER}>
                <button
                  type="button"
                  disabled={selectedProjects.size === 0}
                  onClick={() => { setSelectedProjects(new Set()); setOpenPill(null); setProjectsDropdownPos(null); }}
                  className={MENU_FOOTER_ACTION}
                >
                  Clear
                </button>
              </div>
            </div>,
            document.body,
          )}

          {/* Tags: pick-any menu over the user's tags. Portaled for the same reason. */}
          <FilterMenuChip
            buttonRef={tagsTriggerRef}
            active={selectedTagIds.size > 0}
            open={openPill === 'tags'}
            className="shrink-0 max-w-[7rem]"
            onClick={(e) => {
              e.stopPropagation();
              if (openPill === 'tags') { setOpenPill(null); setTagsDropdownPos(null); }
              else { setTagsDropdownPos(measureDropdown(tagsTriggerRef, 208, filterRowRef)); setOpenPill('tags'); }
            }}
          >
            {tagsLabel}
          </FilterMenuChip>
          {openPill === 'tags' && tagsDropdownPos && createPortal(
            <div
              ref={tagsDropdownRef}
              className="layer-surface w-52 max-w-[calc(100vw-1rem)] overflow-hidden"
              style={{ position: 'fixed', top: tagsDropdownPos.top, left: tagsDropdownPos.left, zIndex: 60 }}
            >
              {liveTags.length === 0 ? (
                <div className="px-3 py-3">
                  <EmptyState variant="inline" message="No tags yet" />
                </div>
              ) : (
                <div role="listbox" aria-multiselectable aria-label="Filter by tag" className="max-h-64 overflow-y-auto py-1">
                  {liveTags.map((t) => {
                    const checked = selectedTagIds.has(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="option"
                        aria-selected={checked}
                        onClick={() => setSelectedTagIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                          return next;
                        })}
                        className={MENU_ROW}
                      >
                        <CheckboxMark checked={checked} />
                        <TagChip tag={t} />
                        <span className="ml-auto text-2xs text-fg-muted shrink-0 tabular-nums">{tagCounts.get(t.id) ?? 0}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {/* Footer: Clear only. The route to the tag manager used to sit
                  here too; Destin removed it (deck round 1, S-4) — a
                  conversation's Organize popover keeps its "Manage tags…". */}
              <div className={MENU_FOOTER}>
                <button
                  type="button"
                  disabled={selectedTagIds.size === 0}
                  onClick={() => { setSelectedTagIds(new Set()); setOpenPill(null); setTagsDropdownPos(null); }}
                  className={MENU_FOOTER_ACTION}
                >
                  Clear
                </button>
              </div>
            </div>,
            document.body,
          )}

          {/* Sort — one tap flips the order and the arrow turns with it. Lit,
              like a narrowing filter, only when the order is not the default,
              so the row says at a glance that the list is not newest-first.
              Priority-pin still wins over the sort. */}
          <FilterChip
            kind="toggle"
            active={sortDir !== 'desc'}
            onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
            className="inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap"
          >
            <span className="grid">
              <span className="col-start-1 row-start-1">{sortDir === 'desc' ? 'Most recent' : 'Oldest first'}</span>
              {/* The other label, invisible, so the chip keeps one width when it
                  flips and the row stops nudging (UX review U19). */}
              <span className="col-start-1 row-start-1 invisible" aria-hidden="true">{sortDir === 'desc' ? 'Oldest first' : 'Most recent'}</span>
            </span>
            <SortArrow muted={sortDir === 'desc'} up={sortDir === 'asc'} />
          </FilterChip>
        </div>  );

  return (
    <>
      {renameSession && <SessionRenameDialog id={renameSession.sessionId} name={renameSession.name} onClose={() => setRenameSession(null)} />}
      {skipPermissionsDialog}
      {/* L1 drawer-style modal — theme-driven via Scrim/OverlayPanel. */}
      <Scrim layer={1} onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: CONTENT_Z[1] }}>
        <OverlayPanel
          layer={1}
          // Preview mode swaps max-h for a DEFINITE height. The
          // note on the list below explains why: with only a max-height, a
          // flex-1 child does not grow in Chromium, and the transcript column
          // needs a real height to scroll inside.
          className={`w-full pointer-events-auto flex flex-col ${previewOn
            ? 'max-w-[1000px] h-[76vh]'
            : 'max-w-md max-h-[70vh]'}`}
          style={{ position: 'relative', zIndex: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
        {/* The body row. `contents` when there is no preview so the header and
            list stay DIRECT flex children of the panel, and the single-column
            browser (narrow, or Android) renders exactly as it always has. */}
        <div className={previewOn ? 'flex-1 min-h-0 flex' : 'contents'}>
        {/* List column. */}
        <div className={previewOn
          ? 'w-[420px] shrink-0 min-w-0 flex flex-col min-h-0 border-r border-edge overflow-hidden'
          : 'contents'}>
          <div className={previewOn ? 'w-[420px] flex flex-col h-full min-h-0' : 'contents'}>
          {/* Header */}
          {/* No `border-b`: Destin, 2026-09-10, "there should be gaps
              on the left/right side of the divider line where it doesn't
              connect to the outer container but tapers off". A border cannot
              fade, so the rule is a 1px gradient row instead — the same idiom
              SessionStrip already uses for the divider between Resume and
              + New Session. */}
          <div className="px-4 pt-4 pb-3 shrink-0 relative">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-fg">Resume Session</h2>
              {/* Show Complete — same toggle pattern as Skip Permissions
                  in SessionStrip, but accent-colored to signal "on" rather than "danger". */}
              <div className="flex items-center gap-2">
                <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Show Complete</label>
                {/* Shared Toggle (change 15). role="switch" + aria-checked comes
                    from the primitive, which is strictly better than the
                    aria-pressed this used to carry. */}
                <Toggle
                  checked={showComplete}
                  onChange={setShowComplete}
                  aria-label="Show Complete"
                />
              </div>
            </div>
            {/* Phones get the shared search pill with its docked filter button, which
                opens the filter panel (deck round 1, S-7). Desktop keeps the box
                Destin chose over the pill (S-2), with the chips on the next row. */}
            {narrow ? (
              <SearchFilterPill
                ref={searchRef}
                value={search}
                onChange={setSearch}
                placeholder="Search sessions..."
                inputAriaLabel="Search sessions"
                activeFilters={selectedProjects.size + selectedTagIds.size}
                filterOpen={filtersOpen}
                onToggleFilter={() => {
                  if (filtersOpen) { setFiltersOpen(false); setOpenPill(null); setFiltersPos(null); }
                  else { setFiltersPos(measureFilters()); setFiltersOpen(true); }
                }}
                filterLabel="Filters"
              />
            ) : (
              // Destin kept this box over the shared search pill (deck round 1, S-2).
              <div ref={searchRef} className="flex items-center gap-2 bg-inset rounded-lg px-3 py-2 border border-edge-dim">
                <svg className="w-4 h-4 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search sessions..."
                  aria-label="Search sessions"
                  className="flex-1 bg-transparent text-sm text-fg placeholder-fg-muted outline-none"
                />
              </div>
            )}
            {narrow && filtersOpen && filtersPos && createPortal(
              <ResumeFilterPopover
                ref={filtersPopoverRef}
                anchor={filtersPos}
                filtersActive={filtersActive}
                onClear={() => { setSelectedProjects(new Set()); setSelectedTagIds(new Set()); }}
                onClose={() => { setFiltersOpen(false); setOpenPill(null); setFiltersPos(null); }}
              >
                {chipsRow}
              </ResumeFilterPopover>,
              document.body,
            )}
            {!narrow && chipsRow}
            {/* Inset both ends so the line stops short of the panel edge and
                fades out rather than butting into it. */}
            <div
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-px"
              style={{ background: 'linear-gradient(to right, transparent, var(--edge) 14%, var(--edge) 86%, transparent)' }}
            />
          </div>

          {/* Session list */}
          {/* No flex-1: OverlayPanel only has max-h (indefinite height), which breaks
              flex-grow in Chromium. Using default flex: 0 1 auto lets flex-shrink
              clamp this div when content exceeds max-h so overflow-y: auto engages
              and the scroll-fade hook sees a real scroll. */}
          {/* Padding lives on an inner wrapper so the scroll-fade element itself has
              no padding. Sticky fade pseudos then sit flush with the scroll-fade's
              outer edge, and the `overflow: hidden` on .layer-surface clips them to
              the OverlayPanel's rounded corners. */}
          <div ref={listRef} className={previewOn ? 'scroll-fade flex-1' : 'scroll-fade'}>
            <div className="py-2">
              {loading ? (
                <LoadingState what="sessions" />
              ) : loadError !== null ? (
                loadError ? (
                  <ErrorState mode="recoverable" message={`Couldn\u2019t load your conversations: ${loadError}`} onRetry={loadSessions} variant="inline" />
                ) : (
                  <ErrorState mode="recoverable" message="Couldn\u2019t load your conversations." onRetry={loadSessions} variant="inline" />
                )
              ) : filtered.length === 0 ? (
                <EmptyState
                  message={search.trim() || filtersActive ? 'No matching sessions' : 'No previous sessions found'}
                  action={emptyAction}
                />
              ) : (
                // ONE list for both modes — grouped (project header + its rows,
                // only when the Projects filter is active) and flat chronological
                // (default view + search results, each row showing its own
                // project label). Bounded to `revealCount`; the sentinel below
                // extends it as the user scrolls.
                //
                // The per-group wrapper this replaced carried `mb-2` for the gap
                // between groups; a flat list has no wrapper to hang that on, so
                // the spacing moves to a top margin on every header after the
                // first — same 8px between groups.
                <>
                  {visibleItems.map((item) => (
                    item.kind === 'header' ? (
                      <div key={item.key} className={`px-4 py-1 ${item.first ? '' : 'mt-2'}`}>
                        <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">
                          {item.label}
                        </span>
                      </div>
                    ) : renderSessionRow(item.session, item.showPath)
                  ))}
                  {/* Top-up trigger. Rendered only while rows remain, so the
                      observer effect above tears down once the list is whole. */}
                  {hasMore && <div ref={sentinelRef} aria-hidden className="h-px" />}
                </>
              )}
            </div>
          </div>
          </div>
        </div>
        {/* The transcript column. */}
        {previewOn && (() => {
          if (!selectedSession && !previewSession) {
            return (
              <div className="flex-1 min-w-0 flex items-center justify-center px-8">
                {/* Plain words, no invented benefit: the panel is empty because
                    nothing is picked, and that is the whole message. */}
                <EmptyState message="Pick a conversation to read it here before you resume." />
              </div>
            );
          }
          // `s` is what the sheet SHOWS; null while the first conversation of
          // the session is still being read. The sheet is mounted either way —
          // the pane inside it is what does the reading, so it cannot be
          // withheld until the read finishes. It just stays invisible, with the
          // empty state over it, until there is something to show.
          const s = previewSession;
          return (
            <div className="relative flex-1 min-w-0 flex flex-col min-h-0 p-3">
              {!s && (
                <div className="absolute inset-0 flex items-center justify-center px-8">
                  <EmptyState message="Pick a conversation to read it here before you resume." />
                </div>
              )}
              <div className={`relative flex-1 min-h-0 flex flex-col overflow-hidden rounded-lg border border-edge-dim bg-canvas${
                !s || arrival === 'staged' ? ' opacity-0' : arrival === 'run' ? ' switch-arrival' : ''
              }`}>
                {s && (
                  <>
                    {/* The header IS the list's card, drawn again — Destin, round
                        four: "a clone of the card on the lefthand side ... floats at
                        the top of the window inside the container". Floating, not
                        welded: older messages pass under it as you scroll back.
                        pointer-events-none on the strip, auto on the card, so the
                        gutter beside it does not swallow scroll wheels. */}
                    <div className="absolute inset-x-0 top-0 z-10 pt-2 pointer-events-none">
                      {/* PERF: box-shadow, not `drop-shadow-[…]`. drop-shadow is a CSS
                          FILTER — it traces the alpha of the whole subtree and re-runs
                          on every paint, and this card floats over a scrolling
                          transcript, so it repaints constantly. */}
                      <div className="pointer-events-auto [&>div>div]:shadow-[0_6px_16px_rgba(0,0,0,0.35)]">
                        {renderSessionRow(s, true, true)}
                      </div>
                    </div>
                  </>
                )}
                <div className="flex-1 min-h-0 flex flex-col">{previewPane}</div>
                {s && renderActionCard(s)}
              </div>
            </div>
          );
        })()}
        </div>
        </OverlayPanel>
      </div>

      <TagManagerPopup open={tagManagerOpen} onClose={() => setTagManagerOpen(false)} registry={registry} />
    </>
  );
}
