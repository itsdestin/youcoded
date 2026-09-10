import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel, CONTENT_Z } from './overlays/Overlay';
import { Button, Toggle, LoadingState, EmptyState, CloseButton, SettingRow } from './ui';
import SessionRenameDialog from './SessionRenameDialog';
import { namingApi } from './assistant-settings/naming-api';
import { useRenamedSessions } from './assistant-settings/use-renamed-sessions';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';
import SessionPreviewPane from './SessionPreviewPane';
import type { ChatsearchProvider } from '../../shared/chatsearch-refs';
import { SkipPermissionsInfoTooltip } from './SkipPermissionsInfoTooltip';
import {
  applyFilters,
  sortSessions,
  groupSessions,
  getAvailableProjects,
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

// ── MOCKUP ONLY (2026-09-10) ────────────────────────────────────────────────
// Candidate SHELLS for a two-pane Resume browser, switched by
// `?rbpreview=<name>` so one workbench boot can show all of them. WHY a switch
// rather than four copies of the component: the pieces inside (the list, the
// transcript pane, the resume controls) are identical in every candidate — only
// the chrome around them is under review, and four copies would have drifted.
// Delete this block, PREVIEW_VARIANT, SHELL and every branch that reads them
// once a shell is chosen; the shipped browser has exactly one.
//
// ROUND 3 (2026-09-10). Round two's answers narrowed this hard, and the shells
// below all obey those answers — they are variations WITHIN the direction he
// picked, not a fresh spread:
//   · "i really dislike all of a-c" — the Session Files top bar, the full-screen
//     page and the full-width search header are gone, and with them the flat
//     list: every shell here keeps today's CARDS.
//   · D-1 "never" — the list never collapses. There is no ≡ button anywhere.
//   · D-2 "blank" — the right half stays one line of text until he clicks; it
//     never opens the most recent conversation by itself.
// ROUND 4 (2026-09-10). Round three settled the frame and opened one question.
// His words: "i like the frameing of the preview used in 'sheet'. i want to try
// to make the header a bit more useful/interesting, with the model
// select/project/resume dropdown buttons in a new card at the bottom floating
// under the last message of the preview in the same framed container. want a
// few different styling for the header of the preview, with different actions
// like the tag/name/complete stuff".
//
// So two things are now FIXED in every variant below and are not up for review:
//   · the sheet — heading, conversation and action card on one inset surface,
//     with the window showing all round it;
//   · the action card — model, project and Resume at the FOOT of that sheet,
//     below the last message, where the message box sits in a real conversation.
//     Resume has therefore left the header entirely, which is what frees the
//     header to carry the organise actions instead.
// What varies is only the header, and which of tag / rename / mark-complete it
// puts in reach. Everything earlier — cards in the list, no collapse, the right
// half blank until a row is clicked — still holds.
//
//   off      today's browser, unchanged — the "before" picture
//   icons    name and facts, with the card's own tag and complete icons at the
//            right; the name itself is the rename control
//   chips    every action is a pill on one wrapping row under the name: the
//            applied tags, an add-tag pill, Complete, Rename
//   toolbar  name and facts, then a labelled strip beneath them — Rename · Tag ·
//            Mark complete — spelled out in words rather than glyphs
//   menu     name and facts only, with one ⋯ button holding all three
type PreviewVariant = 'off' | 'icons' | 'chips' | 'toolbar' | 'menu';
const VARIANTS: PreviewVariant[] = ['off', 'icons', 'chips', 'toolbar', 'menu'];
const PREVIEW_VARIANT: PreviewVariant = (() => {
  try {
    const v = new URLSearchParams(location.search).get('rbpreview') as PreviewVariant;
    return VARIANTS.includes(v) ? v : 'off';
  } catch { return 'off'; }
})();

// Shared trigger-button shape for the filter row beneath the search bar.
// Inactive pills look like the search input frame; active pills tint with the
// accent so the user can see at a glance which pills have departed from
// default state — narrowing filters (Projects, Tags) AND a non-default sort
// direction (Sort). Don't "tighten" the predicate to only narrowing — Sort
// would lose its visual cue.
function FilterPill({
  active,
  onClick,
  children,
  hasPopup,
  expanded,
  buttonRef,
}: {
  active: boolean;
  // Receives the MouseEvent so dropdown-owning callers can stopPropagation()
  // — the Projects + Tags pills (Tasks 4 + 5) rely on this to keep their
  // outside-click handler from immediately re-closing the dropdown.
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  // Optional: when the pill opens a dropdown, callers pass these so screen
  // readers announce both "active filter" (aria-pressed) AND dropdown state.
  // expanded is only read when hasPopup is true; React strips both attrs
  // entirely when hasPopup is falsy (Sort pill).
  hasPopup?: boolean;
  expanded?: boolean;
  // Optional: dropdown-owning callers pass a ref so they can measure the
  // trigger's bounding rect for portal positioning. Sort doesn't need it.
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      // aria-pressed conveys the toggle state to assistive tech. Mirrors the
      // Show Complete toggle's pattern further down in this file.
      aria-pressed={active}
      aria-haspopup={hasPopup ? 'listbox' : undefined}
      aria-expanded={hasPopup ? !!expanded : undefined}
      // MOCKUP ONLY (shrink-0 whitespace-nowrap): in a 340px list column a
      // fourth pill made every pill shrink and wrap its own label onto two
      // lines, so the row grew to 50px of stacked word-halves. Pills keep their
      // width and the ROW wraps instead.
      className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full text-2xs flex items-center gap-1.5 transition-colors duration-75 ${
        active
          ? 'bg-accent/10 border border-accent/40 text-fg'
          : 'bg-inset border border-edge-dim text-fg-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

// Compute fixed-position coords for a portaled dropdown anchored just below a
// trigger button. Clamps the left coordinate so a wide dropdown near the right
// edge of the viewport shifts left rather than overflowing off-screen. Pure;
// callers invoke it synchronously inside the click handler so the dropdown can
// render in the same React commit as `openPill` flipping (no two-render lag).
function measureDropdown(
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  dropdownWidthPx: number,
): { top: number; left: number } | null {
  const el = triggerRef.current;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  // Clamp so the dropdown's right edge stays at least 8px inside the viewport.
  // If the trigger sits too far right, the dropdown shifts left.
  const maxLeft = Math.max(8, window.innerWidth - dropdownWidthPx - 8);
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
): void {
  useEffect(() => {
    if (!isOpen) return;
    const remeasure = () => {
      const next = measureDropdown(triggerRef, dropdownWidthPx);
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
  }, [isOpen, triggerRef, dropdownWidthPx, setPosition]);
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
  const [renameSession, setRenameSession] = useState<PastSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useScrollFade<HTMLDivElement>();
  // Wraps the filter pill row so outside-click can close the active dropdown.
  const filterRowRef = useRef<HTMLDivElement>(null);
  // Trigger refs for portal positioning + dropdown refs so the outside-click
  // handler can recognize clicks inside the portaled dropdown body (which is
  // no longer a child of filterRowRef).
  const projectsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const tagsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectsDropdownRef = useRef<HTMLDivElement | null>(null);
  const tagsDropdownRef = useRef<HTMLDivElement | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // MOCKUP ONLY — the row whose transcript the right panel is showing. Distinct
  // from expandedId because in variants b/c nothing expands in the list at all.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewSheetOpen, setPreviewSheetOpen] = useState(false); // the Resume options sheet
  // MOCKUP ONLY — the tags/note sheet under the preview's header.
  const [previewOrganize, setPreviewOrganize] = useState(false);
  const narrowViewport = useNarrowViewport();
  // The panel is single-column on a phone: a 390px screen cannot hold a list
  // AND a transcript, and the narrow-viewport rule forbids inventing a second
  // breakpoint for it.
  const previewOn = PREVIEW_VARIANT !== 'off' && !narrowViewport;
  const [resumeModel, setResumeModel] = useState<string>(defaultModel || 'sonnet');
  const [resumeDangerous, setResumeDangerous] = useState(defaultSkipPermissions || false);
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

  // New filter state — all reset on each open (no localStorage). Default values
  // (empty Sets, sortDir='desc') produce identical behaviour to the prior
  // hard-coded filter pipeline.
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Tracks which filter pill's dropdown is currently open. null = both closed.
  // Single state instead of two booleans so the dropdowns are mutually exclusive.
  const [openPill, setOpenPill] = useState<'projects' | 'tags' | null>(null);

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
  // "Manage tags…" footer in either the Organize popover's TagPicker or the
  // Tags filter dropdown, so there is ONE destination for tag management.
  const [tagManagerOpen, setTagManagerOpen] = useState(false);

  // Fetch sessions when opened
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
      setLoading(true);
      (window as any).claude.session.browse()
        .then((list: PastSession[]) => setSessions(list))
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
      const t = setTimeout(() => searchRef.current?.focus(), 50);
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
  useEffect(() => {
    if (!openPill) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (filterRowRef.current?.contains(target)) return;
      if (projectsDropdownRef.current?.contains(target)) return;
      if (tagsDropdownRef.current?.contains(target)) return;
      setOpenPill(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [openPill]);

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

  // Group by project path ONLY when the user has narrowed via the Projects
  // pill — the default view is pure chronological (each row carries its own
  // project label instead). Within-group sort is priority-pinned + lastModified
  // by sortDir; between-group order also follows sortDir. Search always stays
  // flat so results read as one ranked list.
  const grouped = useMemo(() => {
    if (search.trim() || selectedProjects.size === 0) return null;
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
  const availableProjects = useMemo(() => getAvailableProjects(sessions), [sessions]);

  // Trigger label for the Projects pill: 0 selected → "Projects",
  // 1 → label, 2-3 → comma-joined labels, 4+ → "Projects (N)".
  const projectsLabel = useMemo(() => {
    if (selectedProjects.size === 0) return 'Projects';
    const selectedList = availableProjects.filter((p) => selectedProjects.has(p.path));
    if (selectedList.length === 1) return selectedList[0].label;
    if (selectedList.length <= 3) return selectedList.map((p) => p.label).join(', ');
    return `Projects (${selectedList.length})`;
  }, [selectedProjects, availableProjects]);

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
  useDropdownReposition(openPill === 'projects', projectsTriggerRef, 256, setProjectsDropdownPos);
  useDropdownReposition(openPill === 'tags', tagsTriggerRef, 208, setTagsDropdownPos);

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
    // MOCKUP ONLY — in every preview shell, clicking a row PREVIEWS it (and
    // re-clicking the same row does nothing, because collapsing the panel would
    // leave the right half empty for no reason the user asked for). The resume
    // controls live in the transcript pane, so the card itself never expands.
    if (previewOn) {
      setPreviewId(s.sessionId);
      setPreviewSheetOpen(false);
      setPreviewOrganize(false);
      setOrganizeId(null);
      setResumeModel(claudeModelForRow(s));
      setResumeDangerous(defaultSkipPermissions || false);
      setResumeLaunchInNewWindow(false);
      setNativeResumeBinding(null);
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
          onManageTags={() => { setOrganizeId(null); setTagManagerOpen(true); }}
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
  const renderExpandedOptions = (s: PastSession) => {
  return (
    <div className="border-t border-edge-dim">
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
                onChange={setResumeDangerous}
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

  const renderSessionRow = (s: PastSession, showPath?: boolean) => {
    const isExpanded = expandedId === s.sessionId;
    // MOCKUP ONLY — with the resume controls out of the card, the accent border
    // is the ONLY thing left saying which row the right panel is showing, so
    // the previewed row has to claim it whether or not anything expanded.
    const isSelected = isExpanded || (previewOn && previewId === s.sessionId);
    // Unresumable rows are inert: no card hover, no expand. See the note on the
    // click handler below for the two reasons a row lands here.
    const inert = !!(s.missingProject || s.notSyncedYet);
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
          if (organizeId === s.sessionId) { setOrganizeId(null); return; }
          organizeTriggerRef.current = e.currentTarget;
          // The two panes are mutually exclusive: a card shows EITHER how to
          // relaunch it or how to organize it, never both stacked. Without this
          // an open card could grow two panels deep and the Resume button would
          // slide down the screen as you tagged.
          setExpandedId(null);
          setOrganizeId(s.sessionId);
        }}
        aria-label={`Organize ${s.name}`}
        aria-haspopup="dialog"
        aria-expanded={organizeId === s.sessionId}
        className={`px-1 py-1.5 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          organizeId === s.sessionId ? 'text-fg' : 'text-fg-faint hover:text-fg-2'
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
      {organizeId === s.sessionId && (
        <div ref={organizePopRef} className="border-t border-edge-dim p-2.5 flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
          {renderOrganizeControls(s)}
        </div>
      )}
      {isExpanded && renderExpandedOptions(s)}
      </div>
    </div>
    );
  };

  // MOCKUP ONLY — pulled out of the header block so the `searchbar` shell can
  // put it across the top of the whole window instead. Identical markup either
  // way; only its parent changes.
  const searchBox = (
    <div className="flex items-center gap-2 bg-inset rounded-lg px-3 py-2 border border-edge-dim">
      <svg className="w-4 h-4 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
      </svg>
      <input
        ref={searchRef}
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search sessions..."
        className="flex-1 bg-transparent text-sm text-fg placeholder-fg-muted outline-none"
      />
    </div>
  );

  // MOCKUP ONLY — the previewed row, resolved once for every shell below.
  const previewSession = previewOn && previewId
    ? filtered.find((r) => r.sessionId === previewId) ?? null
    : null;

  // MOCKUP ONLY — the check-in-a-circle the card already uses for Complete,
  // repeated here rather than shared because the card's copy is welded into
  // renderSessionRow's absolutely-positioned icon cluster.
  const CompleteGlyph = ({ done, className = 'w-4 h-4' }: { done: boolean; className?: string }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" fill={done ? 'currentColor' : 'none'} />
      <path d="M8 12.5l2.5 2.5L16 9.5" stroke={done ? 'var(--canvas)' : 'currentColor'} />
    </svg>
  );

  const PencilGlyph = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );

  // MOCKUP ONLY — the four header treatments under review. Every one of them
  // shows the same three facts and offers the same three actions; what differs
  // is how much of that is a word, a glyph, or hidden behind a press.
  const renderPreviewHeader = (s: PastSession) => {
    const project = s.projectPath.replace(/\\/g, '/').split('/').pop();
    const tags = (s.tags ?? []).map((id) => registry.tags.find((t) => t.id === id)).filter(Boolean);
    const done = !!s.flags?.complete;
    const rename = () => setRenameSession(s);
    const organize = () => setPreviewOrganize((v) => !v);
    const complete = () => toggleFlag(s.sessionId, 'complete', !done);
    const facts = (
      <div className="mt-1.5 flex items-center gap-1.5 text-3xs text-fg-muted">
        <span className="truncate">{project}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{formatRelativeTime(s.lastModified)}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{formatSize(s.size)}</span>
      </div>
    );
    // The name is the rename control in three of the four, exactly as it is on
    // the card in the list: a dotted underline and a pencil, never a
    // hover-only cue (there is no hover on a touch screen).
    const nameButton = (
      <button
        type="button"
        onClick={rename}
        aria-label={`Rename ${s.name}`}
        aria-haspopup="dialog"
        className="group flex items-center gap-1.5 min-w-0 -ml-1 px-1 py-0.5 rounded-md cursor-text hover:bg-well transition-colors"
      >
        <span className="text-base font-semibold text-fg truncate decoration-dotted underline-offset-[3px] underline decoration-fg-muted">
          {s.name}
        </span>
        <span className="text-fg-muted shrink-0"><PencilGlyph /></span>
      </button>
    );

    if (PREVIEW_VARIANT === 'chips') {
      return (
        <div className="px-5 pt-4 pb-3">
          <h3 className="text-base font-semibold text-fg truncate" title={s.name}>{s.name}</h3>
          {facts}
          {/* One wrapping row: what is applied and what you can do, side by
              side, because "add a tag" and "the tags it has" are the same
              thought. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1">
            {tags.map((t) => <TagChip key={t!.id} tag={t!} />)}
            <FilterPill active={previewOrganize} onClick={organize}><TagGlyph className="w-3 h-3" />Tag</FilterPill>
            <FilterPill active={done} onClick={complete}><CompleteGlyph done={done} className="w-3 h-3" />Complete</FilterPill>
            <FilterPill active={false} onClick={rename}><PencilGlyph className="w-3 h-3" />Rename</FilterPill>
          </div>
        </div>
      );
    }

    if (PREVIEW_VARIANT === 'toolbar') {
      return (
        <div>
          <div className="px-5 pt-4 pb-3">
            {nameButton}
            {facts}
            {tags.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {tags.map((t) => <TagChip key={t!.id} tag={t!} />)}
              </div>
            )}
          </div>
          {/* Words, not glyphs. The cost is a whole strip of height; the gain is
              that nobody has to guess what a tag-shaped outline does. */}
          <div className="flex items-center gap-1 px-3 py-1.5 border-t border-edge-dim bg-inset">
            <Button variant="ghost" size="sm" onClick={rename}>Rename</Button>
            <Button variant="ghost" size="sm" onClick={organize}>Tags &amp; note</Button>
            <Button variant="ghost" size="sm" onClick={complete}>{done ? 'Mark not complete' : 'Mark complete'}</Button>
          </div>
        </div>
      );
    }

    if (PREVIEW_VARIANT === 'menu') {
      return (
        <div className="px-5 pt-4 pb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-fg truncate" title={s.name}>{s.name}</h3>
            {facts}
            {tags.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {tags.map((t) => <TagChip key={t!.id} tag={t!} />)}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={organize}
            aria-haspopup="menu"
            aria-expanded={previewOrganize}
            aria-label="More actions"
            className={`shrink-0 rounded-md border p-1.5 transition-colors ${
              previewOrganize ? 'text-fg bg-well border-edge' : 'text-fg-dim border-transparent hover:text-fg hover:bg-well hover:border-edge'
            }`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>
        </div>
      );
    }

    // 'icons' — the card's own two glyphs, at the size of a header.
    return (
      <div className="px-5 pt-4 pb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {nameButton}
          {facts}
          {tags.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {tags.map((t) => <TagChip key={t!.id} tag={t!} />)}
            </div>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-0.5">
          <button
            type="button"
            onClick={organize}
            aria-label={`Organize ${s.name}`}
            aria-haspopup="dialog"
            aria-expanded={previewOrganize}
            className={`p-1.5 rounded-md transition-colors ${previewOrganize ? 'text-fg bg-well' : 'text-fg-faint hover:text-fg-2 hover:bg-well'}`}
          >
            <TagGlyph className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={complete}
            aria-pressed={done}
            title={done ? 'Marked complete — click to undo.' : 'Mark this conversation complete?'}
            aria-label={done ? `Mark ${s.name} not complete` : `Mark ${s.name} complete`}
            className={`p-1.5 rounded-md transition-colors ${done ? 'text-accent hover:bg-well' : 'text-fg-faint hover:text-fg-2 hover:bg-well'}`}
          >
            <CompleteGlyph done={done} />
          </button>
        </div>
      </div>
    );
  };

  // MOCKUP ONLY — the action card at the FOOT of the sheet, in the place a real
  // conversation puts its message box: this is where you act on what you just
  // read. Model and project sit beside Resume because both are choices about
  // the relaunch, and the ▾ holds the two switches that only sometimes apply.
  const renderActionCard = (s: PastSession) => {
    const project = s.projectPath.replace(/\\/g, '/').split('/').pop();
    const dangerous = s.provider !== 'native' && resumeDangerous;
    const nativeNeedsPick = s.provider === 'native' && !nativeResumeBinding;
    const busy = resumingId === s.sessionId;
    return (
      <div className="shrink-0 p-3 pt-0">
        <div className="rounded-lg border border-edge bg-panel p-2 shadow-[0_4px_16px_rgba(0,0,0,0.18)]">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <ModelPicker
                value={resumeChoice(s)}
                onSelect={(c) => applyResumeChoice(s, c)}
                includeClaude={s.provider !== 'native'}
                includeNative={s.provider === 'native'}
                prefill={s.lastUsedModel}
                onManageModels={() => window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'))}
              />
            </div>
            {/* Read-only: a resume cannot move a conversation to another folder,
                so this states where it will land rather than offering a pick. */}
            <span className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-inset border border-edge-dim text-3xs text-fg-muted max-w-[140px]">
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span className="truncate" title={s.projectPath}>{project}</span>
            </span>
            <div className="shrink-0 flex items-center gap-1">
              <Button
                variant={dangerous ? 'danger' : 'primary'}
                size="sm"
                disabled={nativeNeedsPick || busy}
                onClick={() => handleConfirmResume(s)}
              >
                {busy ? 'Resuming…' : dangerous ? 'Resume (Dangerous)' : 'Resume'}
              </Button>
              <button
                type="button"
                onClick={() => setPreviewSheetOpen((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={previewSheetOpen}
                aria-label="Resume options"
                className={`rounded-md border p-1.5 transition-colors ${
                  previewSheetOpen ? 'text-fg bg-well border-edge' : 'text-fg-dim border-transparent hover:text-fg hover:bg-well hover:border-edge'
                }`}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
                  <path d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          </div>
          {/* The two switches the ▾ holds. They drop INTO the card rather than
              floating over the conversation — a floating popover here would be a
              second `.layer-surface` inside the overlay, the stacked-glass bug
              the card comment in the list warns about. */}
          {previewSheetOpen && (
            <div className="mt-2 pt-2 border-t border-edge-dim flex flex-col gap-2">
              {s.provider !== 'native' && (
                <>
                  <SettingRow
                    variant="item"
                    title={<span className="inline-flex items-center">Skip Permissions<SkipPermissionsInfoTooltip /></span>}
                    control={<Toggle checked={resumeDangerous} onChange={setResumeDangerous} tone="danger" aria-label="Skip Permissions" />}
                  />
                  {resumeDangerous && <SkipPermissionsCaption />}
                </>
              )}
              {detachAvailable && (
                <SettingRow
                  variant="item"
                  title="Launch in New Window"
                  control={<Toggle checked={resumeLaunchInNewWindow} onChange={setResumeLaunchInNewWindow} aria-label="Launch in New Window" />}
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {renameSession && <SessionRenameDialog id={renameSession.sessionId} name={renameSession.name} onClose={() => setRenameSession(null)} />}
      {/* L1 drawer-style modal — theme-driven via Scrim/OverlayPanel. */}
      <Scrim layer={1} onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: CONTENT_Z[1] }}>
        <OverlayPanel
          layer={1}
          // MOCKUP ONLY — preview mode swaps max-h for a DEFINITE height. The
          // note on the list below explains why: with only a max-height, a
          // flex-1 child does not grow in Chromium, and the transcript column
          // needs a real height to scroll inside.
          className={`w-full pointer-events-auto flex flex-col ${previewOn
            ? 'max-w-[1000px] h-[76vh]'
            : 'max-w-md max-h-[70vh]'}`}
          style={{ position: 'relative', zIndex: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
        {/* MOCKUP ONLY — the body row. `contents` when there is no preview so the
            header and list stay DIRECT flex children of the panel and the
            unchanged browser renders byte-for-byte as it does on master. */}
        <div className={previewOn ? 'flex-1 min-h-0 flex' : 'contents'}>
        {/* MOCKUP ONLY — list column. */}
        <div className={previewOn
          ? 'w-[420px] shrink-0 min-w-0 flex flex-col min-h-0 border-r border-edge overflow-hidden'
          : 'contents'}>
          <div className={previewOn ? 'w-[420px] flex flex-col h-full min-h-0' : 'contents'}>
          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-edge shrink-0">
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
            {searchBox}
            <div ref={filterRowRef} className="flex flex-wrap items-center gap-1.5 relative mt-2">
              {/* Projects: multi-select dropdown over distinct projectPaths in the loaded sessions.
                  Dropdown is portaled to document.body so it escapes the OverlayPanel's
                  overflow:hidden clipping (lets it overlap the panel edge). */}
              <FilterPill
                buttonRef={projectsTriggerRef}
                active={selectedProjects.size > 0}
                hasPopup
                expanded={openPill === 'projects'}
                onClick={(e) => {
                  e.stopPropagation();
                  // Measure synchronously so the dropdown renders with its final
                  // position in the same commit as openPill flipping. Avoids the
                  // two-render lag the prior useLayoutEffect approach had.
                  if (openPill === 'projects') {
                    setOpenPill(null);
                    setProjectsDropdownPos(null);
                  } else {
                    setProjectsDropdownPos(measureDropdown(projectsTriggerRef, 256));
                    setOpenPill('projects');
                  }
                }}
              >
                <span>{projectsLabel}</span>
                <span className="text-fg-faint text-4xs">▾</span>
              </FilterPill>
              {openPill === 'projects' && projectsDropdownPos && createPortal(
                <div
                  ref={projectsDropdownRef}
                  className="layer-surface w-64 max-w-[calc(100vw-1rem)] overflow-hidden"
                  style={{
                    position: 'fixed',
                    top: projectsDropdownPos.top,
                    left: projectsDropdownPos.left,
                    zIndex: 60,
                  }}
                >
                  {/* "Clear" — text-only affordance that empties selectedProjects (which the data
                      model treats as "filter inactive"). No checkbox visual so it doesn't read as
                      a master "select every project" toggle. Muted small-caps style separates it
                      from the checkbox rows below. Always visible; clicks no-op when already cleared. */}
                  <button
                    type="button"
                    onClick={() => setSelectedProjects(new Set())}
                    className="w-full text-left px-2.5 py-1.5 text-2xs text-fg-muted tracking-wider uppercase hover:text-fg hover:bg-inset transition-colors"
                  >
                    Clear
                  </button>
                  <div className="max-h-56 overflow-y-auto border-t border-edge-dim">
                    {availableProjects.map((p) => {
                      const checked = selectedProjects.has(p.path);
                      return (
                        <button
                          key={p.path}
                          type="button"
                          onClick={() => {
                            setSelectedProjects((prev) => {
                              const next = new Set(prev);
                              if (next.has(p.path)) next.delete(p.path);
                              else next.add(p.path);
                              return next;
                            });
                          }}
                          className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 hover:bg-inset transition-colors text-fg-2"
                        >
                          <span className={`w-3 h-3 shrink-0 rounded-sm border ${checked ? 'bg-accent border-accent' : 'border-edge'}`} />
                          <span className="flex-1 truncate" title={p.path}>{p.label}</span>
                          <span className="text-3xs text-fg-muted shrink-0">{p.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>,
                document.body,
              )}

              {/* Tags: multi-select dropdown over the user's custom tags. Portaled
                  to escape the OverlayPanel's overflow:hidden clipping. */}
              <FilterPill
                buttonRef={tagsTriggerRef}
                active={selectedTagIds.size > 0}
                hasPopup
                expanded={openPill === 'tags'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (openPill === 'tags') { setOpenPill(null); setTagsDropdownPos(null); }
                  else { setTagsDropdownPos(measureDropdown(tagsTriggerRef, 208)); setOpenPill('tags'); }
                }}
              >
                <span>{selectedTagIds.size === 0 ? 'Tags' : `${selectedTagIds.size} tag${selectedTagIds.size > 1 ? 's' : ''}`}</span>
                <span className="text-fg-faint text-4xs">▾</span>
              </FilterPill>
              {openPill === 'tags' && tagsDropdownPos && createPortal(
                <div
                  ref={tagsDropdownRef}
                  className="layer-surface w-52 max-w-[calc(100vw-1rem)] max-h-64 overflow-y-auto"
                  style={{ position: 'fixed', top: tagsDropdownPos.top, left: tagsDropdownPos.left, zIndex: 60 }}
                >
                  {registry.tags.filter((t) => !t.archived).length === 0 && (
                    <div className="px-2.5 py-1.5 text-xs text-fg-muted">No tags yet.</div>
                  )}
                  {/* Second route to the tag manager, so "where do I rename a
                      tag?" is answerable from the filter too — not only from a
                      conversation's Organize popover. */}
                  <button
                    type="button"
                    onClick={() => { setOpenPill(null); setTagManagerOpen(true); }}
                    className="w-full text-left px-2.5 py-1.5 text-2xs text-fg-muted tracking-wider uppercase hover:text-fg hover:bg-inset transition-colors border-b border-edge-dim"
                  >
                    Manage tags…
                  </button>
                  {registry.tags.filter((t) => !t.archived).map((t) => {
                    const checked = selectedTagIds.has(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSelectedTagIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                          return next;
                        })}
                        className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 hover:bg-inset transition-colors text-fg-2"
                      >
                        <span className={`w-3 h-3 shrink-0 rounded-sm border ${checked ? 'bg-accent border-accent' : 'border-edge'}`} />
                        <TagChip tag={t} />
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}

              {/* Sort toggle — flips lastModified direction. Priority-pin still wins. */}
              <FilterPill active={sortDir !== 'desc'} onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
                {sortDir === 'desc' ? 'Most recent ↓' : 'Oldest first ↑'}
              </FilterPill>
            </div>
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
              ) : filtered.length === 0 ? (
                <EmptyState
                  message={search.trim() ? 'No matching sessions' : 'No previous sessions found'}
                  action={search.trim() ? { label: 'Clear search', onClick: () => setSearch('') } : undefined}
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
        {/* MOCKUP ONLY — the transcript column. */}
        {previewOn && (() => {
          const s = previewSession;
          if (!s) {
            return (
              <div className="flex-1 min-w-0 flex items-center justify-center px-8">
                {/* Plain words, no invented benefit: the panel is empty because
                    nothing is picked, and that is the whole message. */}
                <EmptyState message="Pick a conversation to read it here before you resume." />
              </div>
            );
          }
          // FIXED for round four: the sheet. Heading, conversation and action
          // card ride one inset surface with the window showing all round it —
          // `bg-canvas` + a border, never `.layer-surface`, because a second one
          // of those inside the overlay is the stacked-glass bug the card
          // comment in the list warns about.
          return (
            <div className="flex-1 min-w-0 flex flex-col min-h-0 p-3">
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-lg border border-edge-dim bg-canvas">
                <div className="shrink-0 border-b border-edge-dim">
                  {renderPreviewHeader(s)}
                </div>
                {/* Tags and note drop IN under the header for every treatment —
                    the same in-flow sheet the card in the list uses, rather than
                    a popover that would have to be positioned inside a scrolling
                    frame. */}
                {previewOrganize && (
                  <div className="shrink-0 border-b border-edge-dim px-4 py-2.5 flex flex-col gap-2 bg-inset">
                    {renderOrganizeControls(s)}
                  </div>
                )}
                <div className="flex-1 min-h-0 flex flex-col">
                  <SessionPreviewPane
                    provider={(s.provider === 'native' ? 'native' : 'claude') as ChatsearchProvider}
                    id={s.sessionId}
                    title={s.name}
                  />
                </div>
                {renderActionCard(s)}
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
