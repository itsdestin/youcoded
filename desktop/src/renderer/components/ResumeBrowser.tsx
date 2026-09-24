import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel, CONTENT_Z } from './overlays/Overlay';
import { Button, Toggle, LoadingState, EmptyState, ErrorState, FilterChip, FilterMenuChip, Checkbox, CheckboxMark, SearchFilterPill, SettingRow } from './ui';
import SessionRenameDialog from './SessionRenameDialog';
import { namingApi } from './assistant-settings/naming-api';
import { useRenamedSessions } from './assistant-settings/use-renamed-sessions';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';
import { useChunkedReveal } from '../hooks/use-chunked-reveal';
import { isAndroid } from '../platform';
import SessionPreviewPane from './SessionPreviewPane';
import type { ChatsearchProvider } from '../../shared/chatsearch-refs';
import { ResumeFilterPopover } from './ResumeFilterPopover';
import {
  applyFilters,
  sortSessions,
  groupSessions,
  getAvailableProjects,
  pickLabel,
  type FilterState,
  type FlagName,
} from './resume-browser-filters';
import { useTagRegistry, refreshTagRegistry } from '../hooks/useTagRegistry';
import { TagPicker } from './tags/TagPicker';
import { TagManagerPopup } from './tags/TagManagerPopup';
import { TagChip } from './tags/TagChip';
import { SessionCardTags, SessionCardMeta, CompleteToggle, SESSION_CARD_SURFACE_BASE } from './SessionCardDetails';
import { PRIORITY_TAG, PRIORITY_HINT } from './tags/built-in-tags';
import { TagGlyph } from './tags/glyphs';
import { NoteEditor } from './tags/NoteEditor';
import { useResumeOptions, ResumeOptionsForm, type ResumeHandler } from './ResumeOptions';

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
// the upgrade — see docs/archive/handoffs/2026-07-31-resume-browser-load-time-handoff.md.
//
// WHY: the reveal window now lives in hooks/use-chunked-reveal.ts (as
// `useChunkedReveal`, chunk size `REVEAL_CHUNK`) so every long list shares one
// implementation (render-cost consolidation 2026-09-18). The mechanics below
// — reveal count, reset-on-query, scroll-to-top, sentinel observer — are
// imported from there, not defined locally.

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
  onResume: ResumeHandler;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
  /** Present = the Welcome back screen: the same browser, limited to the
   *  conversations that were open when the app last closed. */
  welcomeBack?: WelcomeBackMode;
}

/** The Welcome back screen (questions deck 2026-09-24, welcome-back-questions).
 *  WHY the Resume browser and not a new screen: Destin, Q-actions — "this surface
 *  should basically be the full resume browser for the given sessions.
 *  tags/notes/renames/preview/etc." So it is this component with a tick box on
 *  each row, a Resume/Start fresh footer, and no way to dismiss it by accident
 *  (Q-where: it replaces the start screen until you choose). */
export interface WelcomeBackMode {
  /** Conversation ids that were open in the strip at the last shutdown. */
  ids: readonly string[];
  /** Resume these rows in one go; resolves to the ids that actually launched.
   *  A row left out (e.g. its model is not on this device) stays on the list. */
  onResumeMany: (rows: PastSession[]) => Promise<string[]>;
  /** Leave the screen: forget whatever is left (Q-leftover: "forget them"). */
  onDone: () => void;
}

// How many previewed conversations stay built (the one on screen, recent ones,
// and one being warmed), and how long the pointer must rest on a row before
// its conversation starts building — long enough that sweeping across the list
// warms nothing, short enough to finish before a deliberate click.
const PANES_KEPT = 4;
const WARM_AFTER_MS = 150;
// How far the previewed conversation must scroll one way before the header card
// tucks away or comes back. Small enough that a short flick counts, big enough
// that touchpad jitter at rest moves nothing.
const TUCK_MIN_PX = 6;

type RowActions = {
  select: (s: PastSession) => void;
  toggleFlag: (sessionId: string, flag: FlagName, next: boolean) => unknown;
  warmSoon: (s: PastSession, e: React.PointerEvent) => void;
  warmNow: (s: PastSession) => void;
  cancelWarm: () => void;
};

// A list card that re-renders only when something it draws changes. A click
// here used to re-render every revealed card (~50) five or six times — 13–90 ms
// a commit (measured 2026-09-11) to move one highlight. `deps` is the complete
// list of what a CLOSED card reads from the browser's state (see rowDeps); its
// handlers go through a ref (rowActions), so skipping a render can never leave
// a card calling an old render's function. The same idea as SkillCard's memo.
const RowMemo = React.memo(
  function RowMemo({ render }: { render: () => React.ReactNode; deps: readonly unknown[] }) {
    return <>{render()}</>;
  },
  (a, b) => a.deps.length === b.deps.length && a.deps.every((d, i) => Object.is(d, b.deps[i])),
);

// One previewed conversation, kept built. A hidden layer uses `visibility`, not
// unmounting or display:none — the choice ChatView makes for background
// sessions (ChatView.tsx): its bubbles stay formatted and laid out, so bringing
// it on screen is a paint, and hidden text is out of tab order and
// find-in-page. Addressed by primitives so a keystroke in the search box
// re-renders no layer — and so re-reads nothing.
const PreviewLayer = React.memo(function PreviewLayer({ id, provider, title, projectSlug, visible, onSettled, onGone }: {
  id: string;
  provider: ChatsearchProvider;
  title: string;
  projectSlug?: string;
  visible: boolean;
  onSettled: (id: string) => void;
  onGone: (id: string) => void;
}) {
  useEffect(() => () => onGone(id), [id, onGone]);
  return (
    // data-preview-id: lets the header card's scroll handler tell the layer on
    // screen from the hidden ones (see onPreviewScroll).
    <div className="absolute inset-0 flex flex-col" data-preview-id={id} style={{ visibility: visible ? 'visible' : 'hidden' }}>
      <SessionPreviewPane provider={provider} id={id} title={title} projectSlug={projectSlug} onSettled={onSettled} backdrop={false} />
    </div>
  );
});

export default function ResumeBrowser({ open, onClose, onResume, defaultModel, defaultSkipPermissions, welcomeBack }: Props) {
  const wb = welcomeBack;
  // Welcome back: which rows are ticked, and which already launched from this
  // screen (they leave the list — they are open tabs now).
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [launched, setLaunched] = useState<Set<string>>(new Set());
  const [resumingMany, setResumingMany] = useState(false);
  // How many ticked rows a Resume press could not open by itself (a native row
  // whose last model is not set up here). Said in the footer, never silently.
  const [leftBehind, setLeftBehind] = useState(0);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const tickSeeded = useRef(false);
  // Live tag registry — drives the Tag Picker, chips, and custom-tag filter.
  const registry = useTagRegistry();
  // WHY on open, not mount: this browser stays mounted while closed, so the
  // shared store's one first read would be the only read. Each open re-reads in
  // the background (tags made or renamed on another device arrive by sync pull,
  // which sends no push); the cached tags draw first and an unchanged answer
  // redraws nothing.
  useEffect(() => { if (open) refreshTagRegistry(); }, [open]);
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
  // which is instant; the previous conversation stays on screen meanwhile,
  // because the new one is built in its own hidden layer (paneIds, below)
  // rather than in place of it.
  //
  // `staged` is the frame in between: the new content is committed and laid
  // out while the sheet is still transparent, so the expensive paint happens
  // invisibly. Only then does `.switch-arrival` go on. Without it the bubbles
  // paint after the animation has begun, which is the third beat above.
  const [shownId, setShownId] = useState<string | null>(null);
  const [arrival, setArrival] = useState<'staged' | 'run' | null>(null);
  // ── The header card tucks away while you read back (Destin, 2026-09-11) ──
  // A preview opens on the NEWEST message, so reading it means scrolling UP,
  // and the floating card covered the top of what you were reading. Scrolling
  // up slides it out through the top of the sheet; scrolling down brings it
  // back. `tuckMark` is the position the last decision was made from, so slow
  // moves add up against it instead of each being judged alone.
  const [headerTucked, setHeaderTucked] = useState(false);
  const tuckMark = useRef<{ el: EventTarget | null; top: number; height: number }>({ el: null, top: 0, height: 0 });
  // ── Conversations kept built ────────────────────────────────────────────
  // A click used to read and format its conversation from scratch every time,
  // even one previewed a moment ago: 0.6–1 s from click to settled on large
  // conversations (measured 2026-09-11). The main chat switches in half a
  // millisecond because every open conversation stays built and merely hidden;
  // this keeps the last few previewed the same way, plus the one the pointer is
  // resting on or pressing (warmPane), so most clicks only reveal a layer that
  // is already there.
  //
  // `paneIds` is in INSERTION order and never reordered — React moving a
  // layer's DOM node would reset its scroll position. Recency is paneUsedAt.
  const [paneIds, setPaneIds] = useState<string[]>([]);
  const paneUsedAt = useRef(new Map<string, number>());
  // Mounted layers whose first read has finished. A layer that unmounts drops
  // out (onPreviewGone), so a remounted one is waited on again, not revealed
  // over its loading line.
  const settledRef = useRef(new Set<string>());
  const previewIdRef = useRef<string | null>(null);
  previewIdRef.current = previewId;
  const shownIdRef = useRef<string | null>(null);
  shownIdRef.current = shownId;
  const reveal = useCallback((id: string) => {
    setShownId(id);
    setArrival('staged');
    // A newly picked conversation always arrives with its card showing — it
    // is the only thing that says which conversation this is.
    setHeaderTucked(false);
    tuckMark.current.el = null;
  }, []);
  const warmPane = useCallback((id: string) => {
    paneUsedAt.current.set(id, performance.now());
    setPaneIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      // Least recently used goes first — never the conversation on screen,
      // the one just picked, or the one being warmed.
      const pinned = new Set([id, previewIdRef.current, shownIdRef.current]);
      while (next.length > PANES_KEPT) {
        const victims = next.filter((p) => !pinned.has(p));
        if (!victims.length) break;
        const oldest = victims.reduce((a, b) => ((paneUsedAt.current.get(a) ?? 0) <= (paneUsedAt.current.get(b) ?? 0) ? a : b));
        next.splice(next.indexOf(oldest), 1);
      }
      return next;
    });
  }, []);
  const onPreviewSettled = useCallback((id: string) => {
    settledRef.current.add(id);
    // A layer warmed by a resting pointer settles silently; only the
    // conversation the user actually picked is brought on screen.
    if (id === previewIdRef.current && id !== shownIdRef.current) reveal(id);
  }, [reveal]);
  const onPreviewGone = useCallback((id: string) => {
    settledRef.current.delete(id);
  }, []);
  // Moves the header card (headerTucked, above). Caught on the layers' wrapper
  // in the CAPTURE phase: scroll does not bubble, and the element that scrolls
  // is inside SessionPreviewPane.
  const onPreviewScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    // Only the conversation on screen counts. A hidden layer jumps itself to
    // its newest message when its read lands, and that is not the reader moving.
    if (el.closest('[data-preview-id]')?.getAttribute('data-preview-id') !== shownIdRef.current) return;
    const mark = tuckMark.current;
    // The content changed height under the reader: Load older adds messages
    // ABOVE, and the browser pushes the position down to keep the same message
    // in view. Nobody scrolled, so take a new bearing and decide nothing —
    // otherwise pressing Load older would drop the card back over the top.
    if (mark.el !== el || mark.height !== el.scrollHeight) {
      tuckMark.current = { el, top: el.scrollTop, height: el.scrollHeight };
      return;
    }
    const moved = el.scrollTop - mark.top;
    if (Math.abs(moved) < TUCK_MIN_PX) return;
    mark.top = el.scrollTop;
    // Its tags/note sheet is open: leave it where it is rather than slide the
    // thing being edited away.
    if (cloneOrganizeId) return;
    setHeaderTucked(moved < 0);
  };
  // Closing the browser unmounts every layer. Keep only the one that was on
  // screen, so reopening re-reads one conversation rather than four. The card
  // comes back with it rather than reopening tucked away.
  useEffect(() => {
    if (!open) {
      setPaneIds((prev) => prev.filter((id) => id === shownIdRef.current));
      setHeaderTucked(false);
      tuckMark.current.el = null;
    }
  }, [open]);
  // Cards are memoised (RowMemo), so they reach this render's handlers through
  // a ref that is reassigned every render, never through a captured closure.
  const rowActions = useRef<RowActions | null>(null);
  const warmTimer = useRef<number | null>(null);
  useEffect(() => () => { if (warmTimer.current !== null) clearTimeout(warmTimer.current); }, []);
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
    resumeOptions.resetFor(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetFor is
    // redefined every render; the row id is what actually changes here.
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
  // Model, Skip Permissions, new window and the in-flight resume — shared with
  // the Projects page's preview (ResumeOptions.tsx).
  const resumeOptions = useResumeOptions(defaultModel, defaultSkipPermissions);
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
      .then((list: PastSession[]) => { setSessions(list); setLoadError(null); setLoadedOnce(true); })
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
      resumeOptions.resetFor(null);
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
    // Welcome back is left only through its own buttons (Q-where).
    else if (!wb) onClose();
  }, [tagManagerOpen, organizeId, openPill, expandedId, onClose, wb]);
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
    // Welcome back shows exactly the conversations that were open — completed
    // ones included, since marking one complete here must not make it vanish
    // mid-choice — minus any already resumed from this screen.
    if (wb) return sessions.filter((s) => wb.ids.includes(s.sessionId) && !launched.has(s.sessionId));
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
  }, [wb, launched, sessions, search, showComplete, stickyComplete, selectedProjects, selectedTagIds, registry.tags]);

  // Every resumable row starts ticked (Q-ticks: "All ticked"), once, when the
  // list first arrives. A row that cannot be resumed here (folder not on this
  // device, transcript still syncing) starts unticked and cannot be ticked.
  useEffect(() => {
    if (!wb || tickSeeded.current || loading || !loadedOnce) return;
    tickSeeded.current = true;
    setTicked(new Set(filtered.filter((s) => !s.missingProject && !s.notSyncedYet && !s.flags?.complete).map((s) => s.sessionId)));
  }, [wb, loading, loadedOnce, filtered]);
  const tickedRows = wb ? filtered.filter((s) => ticked.has(s.sessionId)) : [];
  // Nothing left to choose from: the screen has done its job.
  useEffect(() => {
    if (wb && tickSeeded.current && !loading && filtered.length === 0) wb.onDone();
  }, [wb, loading, filtered.length]);
  const setTick = (id: string, next: boolean) => setTicked((prev) => {
    const ns = new Set(prev);
    if (next) ns.add(id); else ns.delete(id);
    return ns;
  });
  const resumeTicked = async () => {
    if (!wb || tickedRows.length === 0) return;
    setResumingMany(true);
    try {
      const done = await wb.onResumeMany(tickedRows);
      setLeftBehind(tickedRows.length - done.length);
      setLaunched((prev) => new Set([...prev, ...done]));
      // Open the first row that could not go by itself, so its model picker is
      // on screen — the footer line says why — instead of a button that
      // silently does nothing when pressed again.
      const first = tickedRows.find((r) => !done.includes(r.sessionId));
      if (first) rowActions.current?.select(first);
      setTicked((prev) => new Set([...prev].filter((id) => !done.includes(id))));
    } finally {
      setResumingMany(false);
    }
  };

  // What the sheet is currently showing — it lags the clicked row (previewId,
  // which drives the list's highlight) until that conversation has been read.
  // Looked up in `filtered`, so a search that hides it empties the sheet.
  const previewSession = previewOn && shownId
    ? filtered.find((r) => r.sessionId === shownId) ?? null
    : null;
  // The layers look their rows up in ALL sessions, not `filtered`: a search
  // that hides a row must not throw away its built conversation.
  const sessionsById = useMemo(() => new Map(sessions.map((r) => [r.sessionId, r])), [sessions]);

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

  // WHY: the reveal window now lives in hooks/use-chunked-reveal.ts so every
  // long list shares one implementation (render-cost consolidation 2026-09-18).
  const { visible: visibleItems, hasMore, sentinelRef } =
    useChunkedReveal(items, { resetKey: queryKey, rootRef: listRef, active: open });

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
    // Welcome back: finished work is not work to reopen, so Complete unticks it.
    if (wb && flag === 'complete' && next) setTick(sessionId, false);
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
  // Takes the whole row, not just its id: the expanded pane's model dropdown
  // starts on the model THIS conversation last ran on, which only the row
  // knows. See useResumeOptions' modelForRow.
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
      warmPane(s.sessionId);
      // Already built — warmed by a resting pointer, or previewed recently:
      // there is nothing to wait for, so it arrives on this click. Otherwise
      // onPreviewSettled brings it on screen when its read finishes.
      if (settledRef.current.has(s.sessionId) && shownIdRef.current !== s.sessionId) reveal(s.sessionId);
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
      resumeOptions.resetFor(s);
    }
  };

  const clearWarmTimer = () => {
    if (warmTimer.current !== null) { clearTimeout(warmTimer.current); warmTimer.current = null; }
  };
  rowActions.current = {
    select: handleSelectSession,
    toggleFlag,
    // Resting the pointer on a row starts building its conversation, so the
    // click that follows finds it ready. Touch has no hover — a finger warms on
    // press instead (warmNow), which still starts the read before the click.
    warmSoon: (s, e) => {
      if (!previewOn || s.notSyncedYet || e.pointerType === 'touch') return;
      clearWarmTimer();
      warmTimer.current = window.setTimeout(() => { warmTimer.current = null; warmPane(s.sessionId); }, WARM_AFTER_MS);
    },
    warmNow: (s) => {
      if (!previewOn || s.notSyncedYet) return;
      clearWarmTimer();
      warmPane(s.sessionId);
    },
    cancelWarm: clearWarmTimer,
  };
  // Everything a CLOSED list card reads from this component, for RowMemo.
  // An OPEN card — its tag sheet or resume options showing — reads a great deal
  // more, so it gets a value that differs every render and is never skipped.
  // Adding a read of component state to renderSessionRow means adding it here.
  const renderStamp = {};
  const rowDeps = (s: PastSession, showPath: boolean): readonly unknown[] => {
    const opened = organizeId === s.sessionId || expandedId === s.sessionId;
    return [s, showPath, previewOn, previewOn && previewId === s.sessionId, registry.byId, !!namingApi(), opened ? renderStamp : null, ticked.has(s.sessionId)];
  };

  const handleConfirmResume = async (s: PastSession) => {
    // Close ONLY when it actually launched. A create that never acked returns
    // false — keep the browser open (App has toasted the honest reason) so the
    // user can retry or pick another row (Task 6 review ack-gap).
    // Welcome back stays up for the rest of the list; the resumed row leaves it.
    if (await resumeOptions.resume(s, onResume)) {
      if (wb) setLaunched((prev) => new Set(prev).add(s.sessionId));
      else onClose();
    }
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
  const renderExpandedOptions = (s: PastSession, opts?: { flush?: boolean }) => (
    <ResumeOptionsForm session={s} options={resumeOptions} onResume={() => handleConfirmResume(s)} flush={opts?.flush} />
  );

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
        // Start building this conversation before the click lands (warmSoon /
        // warmNow). Not on the header clone: its conversation is already shown.
        {...(clone ? {} : {
          onPointerEnter: (e: React.PointerEvent) => rowActions.current?.warmSoon(s, e),
          onPointerLeave: () => rowActions.current?.cancelWarm(),
          onPointerDown: () => rowActions.current?.warmNow(s),
        })}
        // `relative` is load-bearing: the icon cluster is positioned against
        // this card, not the panel. The icon buttons are SIBLINGS of the expand
        // trigger, never nested — a button inside a button is invalid HTML and
        // the inner one would never receive its own click.
        // Surface shared with the Projects → Conversations card
        // (SessionCardDetails.tsx); only the border colour is this card's own.
        className={`relative overflow-hidden ${SESSION_CARD_SURFACE_BASE} ${
          isSelected ? 'border-accent' : inert ? 'border-edge-dim' : 'border-edge-dim hover:border-edge'
        }`}
      >
      {/* WHY: match SessionDrawer's filename rename classes and Ic pencil, not
          the organize icons. Keep the viewer unchanged and retain this dialog's
          separate keyboard handling. R5-1 keeps both edit cues visible even at rest. */}
      <div
        className={`flex items-center gap-1 px-3 pt-2 ${ICON_GUTTER}`}
        // The empty space between the name and the tag/complete icons was a
        // dead zone: the name opens Rename, the icons float over the corner, and
        // only the lower half of the card was the select button. Clicking there
        // did nothing (Destin, 2026-09-11). Clicks INSIDE a button are left to
        // that button — without the check the no-rename fallback button would
        // select twice, which on a narrow screen expands the card and
        // immediately collapses it again.
        onClick={(e) => {
          if (inert || (e.target as HTMLElement).closest('button')) return;
          rowActions.current?.select(s);
        }}
      >
        {/* Welcome back: the tick that says "reopen this one". Not on the
            preview's header copy — one tick per conversation, in the list. */}
        {wb && !clone && (
          <Checkbox
            checked={ticked.has(s.sessionId)}
            disabled={!canResume}
            onChange={(next) => setTick(s.sessionId, next)}
            aria-label={`Reopen ${s.name}`}
            className="mr-2"
          />
        )}
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
          onClick={() => { if (!inert) rowActions.current?.select(s); }} aria-disabled={inert || undefined}>
          {s.name}
        </button>}
      </div>
      <button
        // Resume is disabled for conversations whose project folder isn't on
        // this device (synced in from elsewhere) OR whose transcript hasn't
        // synced here yet — either way there's nothing to resume into, so the
        // row shows a plain-words note instead of expanding.
        onClick={() => { if (!inert) rowActions.current?.select(s); }}
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
          <SessionCardTags session={s} tagsById={registry.byId} className={ICON_GUTTER} />
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
          <SessionCardMeta session={s} showProject={!!showPath} />
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
      <CompleteToggle
        done={!!s.flags?.complete}
        name={s.name}
        onToggle={(next) => rowActions.current?.toggleFlag(s.sessionId, 'complete', next)}
        className="px-1 py-1.5"
      />
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
  // read. Its contents are `renderExpandedOptions` verbatim — ResumeOptionsForm,
  // the same block the expanded card in the list, the Projects preview and the
  // side panel's preview draw — because
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
              {/* A failed tag read is not "No tags yet" (code review 2026-09-11, F5). */}
              {registry.error && registry.tags.length === 0 ? (
                <div className="px-3 py-3">
                  <ErrorState variant="inline" message={`Couldn't load your tags: ${registry.error}`} onRetry={registry.reload} />
                </div>
              ) : liveTags.length === 0 ? (
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
      {resumeOptions.dialog}
      {/* L1 drawer-style modal — theme-driven via Scrim/OverlayPanel. */}
      <Scrim layer={1} onClick={wb ? undefined : onClose} />
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
            {wb ? (
              // Welcome back: a heading that says why this appeared, and none of
              // the search/filter row — the list is only what was open, a handful
              // of rows, and there is nothing to narrow.
              <div className="select-none">
                <h2 className="text-sm font-bold text-fg">Welcome back</h2>
                <p className="text-xs text-fg-muted mt-1">
                  {filtered.length === 1
                    ? 'This session was open when YouCoded closed.'
                    : 'These sessions were open when YouCoded closed. Pick the ones to reopen.'}
                </p>
              </div>
            ) : (<>
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
            </>)}
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
                // project label). Bounded by useChunkedReveal's window; the
                // sentinel below extends it as the user scrolls.
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
                    ) : (
                      <RowMemo
                        key={item.session.sessionId}
                        render={() => renderSessionRow(item.session, item.showPath)}
                        deps={rowDeps(item.session, item.showPath)}
                      />
                    )
                  ))}
                  {/* Top-up trigger. Rendered only while rows remain, so the
                      observer effect above tears down once the list is whole. */}
                  {hasMore && <div ref={sentinelRef} aria-hidden className="h-px" />}
                </>
              )}
            </div>
          </div>
          {/* Welcome back's two ways out. Start fresh forgets the list (the
              sessions stay in Resume Session as always); Resume opens every
              ticked row. The count is in the button so it says exactly what
              one press will do. */}
          {wb && (
            <div className="shrink-0 relative px-4 py-3 flex flex-wrap items-center justify-end gap-2">
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-px"
                style={{ background: 'linear-gradient(to right, transparent, var(--edge) 14%, var(--edge) 86%, transparent)' }}
              />
              {leftBehind > 0 && filtered.length > 0 && (
                <p className="w-full text-xs text-fg-muted" role="status">
                  {leftBehind === 1 ? '1 session needs' : `${leftBehind} sessions need`} a model picked first. Choose one to resume it.
                </p>
              )}
              <Button variant="ghost" size="md" onClick={wb.onDone} disabled={resumingMany}>Start fresh</Button>
              <Button variant="primary" size="md" onClick={resumeTicked} disabled={tickedRows.length === 0 || resumingMany}>
                {resumingMany ? 'Reopening…' : tickedRows.length === 0 ? 'Resume' : `Resume ${tickedRows.length === filtered.length && filtered.length > 1 ? 'all ' : ''}${tickedRows.length}`}
              </Button>
            </div>
          )}
          </div>
        </div>
        {/* The transcript column. */}
        {previewOn && (() => {
          // `s` is what the sheet SHOWS; null until a picked conversation has
          // been read, and null again if a search hides it. The sheet is
          // mounted either way — its layers do the reading, including warming
          // a row before anything is picked, so they cannot wait for a pick.
          // It just stays invisible, with the empty state over it, until there
          // is something to show. Plain words, no invented benefit: the panel
          // is empty because nothing is picked, and that is the whole message.
          const s = previewSession;
          return (
            <div className="relative flex-1 min-w-0 flex flex-col min-h-0 p-3">
              {!s && (
                <div className="absolute inset-0 flex items-center justify-center px-8">
                  <EmptyState message="Pick a conversation to read it here before you resume." />
                </div>
              )}
              {/* preview-backdrop on the WHOLE sheet, not per pane: the action
                  card sits below the conversation, and a pane-only surface left
                  the plain sheet showing around it (Destin, 2026-09-16). The
                  panes are told not to paint their own (backdrop={false}). */}
              <div className={`relative flex-1 min-h-0 flex flex-col overflow-hidden rounded-lg border border-edge-dim preview-backdrop${
                !s || arrival === 'staged' ? ' opacity-0' : arrival === 'run' ? ' switch-arrival' : ''
              }`}>
                {s && (
                  <>
                    {/* The header IS the list's card, drawn again — Destin, round
                        four: "a clone of the card on the lefthand side ... floats at
                        the top of the window inside the container". Floating, not
                        welded: older messages pass under it as you scroll back.
                        pointer-events-none on the strip, auto on the card, so the
                        gutter beside it does not swallow scroll wheels.
                        preview-header-slide / data-tucked: it slides up out of the
                        sheet while you scroll back, and down again when you scroll
                        toward the newest message (onPreviewScroll). data-still on
                        the staged frame, so a card coming back for a newly picked
                        conversation is simply there, not sliding in under the
                        arrival. The open tags/note sheet holds it on screen. */}
                    <div
                      className="preview-header-slide absolute inset-x-0 top-0 z-10 pt-2 pointer-events-none"
                      data-tucked={headerTucked && !cloneOrganizeId ? '' : undefined}
                      data-still={arrival === 'staged' ? '' : undefined}
                    >
                      {/* PERF: box-shadow, not `drop-shadow-[…]`. drop-shadow is a CSS
                          FILTER — it traces the alpha of the whole subtree and re-runs
                          on every paint, and this card floats over a scrolling
                          transcript, so it repaints constantly.
                          onFocusCapture: Tab can still land on a tucked card's
                          buttons, so focus brings it back into view. */}
                      <div className="pointer-events-auto [&>div>div]:shadow-[0_6px_16px_rgba(0,0,0,0.35)]" onFocusCapture={() => setHeaderTucked(false)}>
                        {renderSessionRow(s, true, true)}
                      </div>
                    </div>
                  </>
                )}
                <div className="relative flex-1 min-h-0" onScrollCapture={onPreviewScroll}>
                  {paneIds.map((id) => {
                    const r = sessionsById.get(id);
                    return r ? (
                      <PreviewLayer
                        key={id}
                        id={id}
                        provider={r.provider === 'native' ? 'native' : 'claude'}
                        title={r.name}
                        projectSlug={r.projectSlug || undefined}
                        visible={id === shownId}
                        onSettled={onPreviewSettled}
                        onGone={onPreviewGone}
                      />
                    ) : null;
                  })}
                </div>
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
