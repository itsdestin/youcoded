import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { SessionStatusColor, STATUS_LABEL } from './StatusDot';
import { Button, Toggle, Tooltip } from './ui';
import { isAndroid, isRemoteMode } from '../platform';
import FolderSwitcher from './FolderSwitcher';
import { SkipPermissionsInfoTooltip } from './SkipPermissionsInfoTooltip';
import { useNativeBinding, usePreset, NativeExtras, loadLastBinding, persistLastBinding, defaultRuntime, type Runtime, type Binding } from './RuntimeBinding';
import ModelPicker, { type ModelChoice } from './model/ModelPicker';
import { packSessions, PILL_GAP, type SessionMeasurement, type PackResult } from './header/pack-sessions';
import { pillLabelStyle } from './header/pill-label-style';
import { pillMetrics, NAME_FONT, type PillMetrics } from './header/pill-metrics';
import { sessionRuntimeLabel } from './header/session-runtime-label';
import { ProviderIcon } from './ProviderIcon';
import { nextSlotId, clampFloatLeft, layoutRects, reorderIndices, neighbourOffsets, mapToSettled, DRAG_TUNE, type PillRect } from './header/drag-order';
import { useOneShotWindow } from '../hooks/use-one-shot-window';
import { useScrollFade } from '../hooks/useScrollFade';
import { useArtifact } from '../state/ArtifactContext';
import { isTypingTarget } from '../utils/is-typing-target';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { useSessionMeta } from '../hooks/useSessionMeta';
import { PRIORITY_TAG } from './tags/built-in-tags';
import { NotePageGlyph } from './tags/glyphs';
import { TagChip } from './tags/TagChip';
import type { TagRecord } from '../../shared/tags';
import {
  chooseTearOffModel, dragCarriesSession, readSessionDrag, writeSessionDrag,
  beginLocalSessionDrag, endLocalSessionDrag, localSessionDrag,
} from '../session-drag-model';
import { ContextMenu } from './context-menu/ContextMenu';
import SessionRenameDialog from './SessionRenameDialog';
import { namingApi } from './assistant-settings/naming-api';
import { useRenamedSessions } from './assistant-settings/use-renamed-sessions';
import type { MenuEntry } from './context-menu/build-menu';
import { SkipPermissionsCaption } from './SkipPermissionsCaption';
import { useFirstTimeGate } from './FirstTimeWarning';
import { isSmallModel } from './first-time-warnings';

// Stable empty map for the non-dragging render, so a new Map is not allocated
// on every frame the strip re-renders.
const EMPTY_OFFSETS: ReadonlyMap<string, number> = new Map();

/** How long the pill-label transitions stay switched on after a session
 *  switch, if the stylesheet cannot be read: the name reveal, with slack. The
 *  live value is read off the strip's computed `--dur-reveal` (see
 *  motionWindowMs) — a fixed number tuned to one vocabulary closed
 *  mid-animation once another was picked, and the label popped to full size.
 *  Destin called the result "jank". */
const EXPAND_WINDOW_FALLBACK_MS = 340;
const EXPAND_WINDOW_SLACK_MS = 80;

/** The reveal time the current vocabulary needs, read off an element that
 *  inherits the tokens. `ms` or `s`; anything unreadable → the fallback. */
function motionWindowMs(el: Element | null): number {
  if (!el) return EXPAND_WINDOW_FALLBACK_MS;
  const cs = getComputedStyle(el);
  const read = (name: string) => {
    const v = cs.getPropertyValue(name).trim();
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return NaN;
    return v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : n;
  };
  const reveal = read('--dur-reveal');
  return Number.isFinite(reveal) && reveal > 0 ? Math.round(reveal + EXPAND_WINDOW_SLACK_MS) : EXPAND_WINDOW_FALLBACK_MS;
}

/** A collapsed pill (dot only): px-1.5 (12) + dot (10) + border (2) + the
 *  gap-1 (4) that sits between the dot and its zero-width label. Measured
 *  2026-09-01 at 28px; the packer had budgeted 24 since it was written, so a
 *  row of N dots was under-reserved by 4N px and the active name got squeezed. */
const COLLAPSED_PILL_PX = 28;

/** The "+N" overflow chip's room: min-w-[18px] + px-1 fits two digits at
 *  ~24px, plus its ml-1 (4). Reserved by the packer only when something
 *  overflows — it did not know about the chip until 2026-09-03, and a full row
 *  was packed a chip too wide (see PackInput.budget for what that did). */
const OVERFLOW_CHIP_PX = 28;

/** How long the cursor must rest on a dot before its name peeks open. A peek
 *  widens the row (as far as there is room — see LabelStyleInput.room) and the
 *  centred strip re-lays out around it, so a peek must be MEANT: the hand
 *  crossing dots on its way somewhere, or drifting onto the next dot after a
 *  drop, opened one for a few frames and closed it again — the whole row
 *  shifted 5px and came back inside the drop's own settle (probed 2026-09-03
 *  with a hand that keeps moving after release; Destin, R8: "jumping/glitching
 *  back and forth on release before settling"). Once a peek is open, moving
 *  to the next dot switches it at once — the intent is already shown. */
const PEEK_DWELL_MS = 150;

/** The room the strip's children have: the flex-1 wrapper's width (not the
 *  strip's own, which is whatever its pills happen to occupy — a chicken-and-
 *  egg that once kept a 2nd pill from ever appearing) minus the strip's OWN
 *  padding, which the wrapper's width includes and the children cannot use. */
function stripBudget(bar: HTMLElement): number {
  const cs = getComputedStyle(bar);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  return (bar.parentElement?.clientWidth ?? bar.clientWidth) - pad;
}

/** How close (px) a dot may be drawn to the pill in hand before it is hidden.
 *  Contact, near enough: every px here is empty space beside the pill
 *  (Destin, 2026-09-03, on 10px: "too much empty space on either side of the
 *  dragged chip"). It can be this small because the veil is decided on EVERY
 *  pointer move against where the pill is about to be drawn (handlePointerMove),
 *  not only between moves by the rAF loop — so a fast pointer cannot land the
 *  pill on a dot that is still drawn. */
const VEIL_PX = 1;

/** The row's gap between pills, in px. The dot flowing around the pill in
 *  hand keeps exactly this much clear of it on both sides. */
const FLOW_GAP_PX = PILL_GAP;


interface SessionEntry {
  id: string;
  name: string;
  cwd: string;
  permissionMode: string;
  // Which runtime backend this session runs — 'claude' (default), 'native' or
  // 'shell'. With harnessId and model, drives the "Claude Code · Sonnet" /
  // "YouCoded Coder · DeepSeek R1" / "Terminal · fish" line under the name in
  // the All Sessions menu (session-runtime-label.ts). Nothing on the pill itself.
  provider?: string;
  // Resolved native preset id ('assistant' | 'coder', post legacy-mapping).
  // Absent for Claude sessions.
  harnessId?: string;
  // Model id the session runs on — a Claude alias or a native model id.
  model?: string;
  // provider='shell' only — the shell that was spawned ('fish'), which the
  // All Sessions menu shows where a model would otherwise go.
  shellName?: string;
}

interface Props {
  sessions: SessionEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: (cwd: string, dangerous: boolean, model: string, provider?: 'claude' | 'native', launchInNewWindow?: boolean, binding?: { providerId: string; modelId: string }, preset?: string) => void;
  // WHY (2026-09-07): name is optional so the confirm prompt can show a real
  // session name for a "sessions in other windows" row — that session isn't
  // in the `sessions` array App.tsx uses to look names up by id.
  onCloseSession: (id: string, name?: string) => void;
  sessionStatuses?: Map<string, SessionStatusColor>;
  // WHY: `onResumeSession` is no longer accepted here. The strip never invoked
  // it — resuming is owned by the ResumeBrowser modal, opened via
  // `onOpenResumeBrowser` below. App/HeaderBar were still passing it through;
  // those call sites are updated in the same commit.
  onOpenResumeBrowser: () => void;
  onReorderSessions?: (fromIndex: number, toIndex: number) => void;
  defaultModel?: string;
  /** The saved default across EVERY provider (Assistant settings → Default
   *  model). `defaultModel` beside it is the Claude alias this form has always
   *  had; on its own it could not express "my default is GPT-5.6", which is why
   *  a non-Claude default was written down and then ignored (contract R5). */
  defaultStartModel?: ModelChoice;
  defaultSkipPermissions?: boolean;
  defaultProjectFolder?: string;
  /** Window directory (for switcher's "Sessions in other windows" group). */
  windowDirectory?: {
    leaderWindowId: number;
    windows: { window: { id: number; label: string; createdAt: number }; sessions: SessionEntry[] }[];
  } | null;
  /** This renderer's own window id — excluded from remote sessions group. */
  myWindowId?: number | null;
}

/* ── Status dot color maps ───────────────────────────────── */

const DOT_BG: Record<SessionStatusColor, string> = {
  green: 'bg-green-400',
  red: 'bg-red-400',
  // Amber harmonizes with the buddy AttentionStrip's #f5a623 ("needs
  // attention" convention). bg-amber-400 (#fbbf24) reads as the same status
  // across surfaces.
  amber: 'bg-amber-400',
  blue: 'bg-blue-400',
  gray: 'bg-gray-500',
};

const GLOW_SHADOW: Record<SessionStatusColor, string> = {
  green: '0 0 6px rgba(76,175,80,0.35)',
  red: '0 0 6px rgba(221,68,68,0.35)',
  amber: '0 0 6px rgba(245,166,35,0.35)',
  blue: '0 0 6px rgba(96,165,250,0.35)',
  gray: 'none',
};

// WHY: `INDICATOR_COLOR` was the pre-tailwind status-dot palette. The strip
// switched to theme-driven classes; the object was left behind. Removed in the
// 2026-08-06 unused-code sweep.

function SessionDot({ color, isActive }: { color: SessionStatusColor; isActive: boolean }) {
  const breathing = color !== 'gray';
  return (
    <span className="relative inline-flex items-center justify-center w-2.5 h-2.5 shrink-0">
      <span
        className={`relative w-2 h-2 rounded-full ${DOT_BG[color]}`}
        // Perf: steps(8) instead of ease-in-out. This dot breathes whenever the
        // session isn't gray — i.e. for every non-idle session, in the
        // always-visible header — and on a 180Hz panel a smoothly-animating
        // element costs ~29% of one CPU core (Chromium presents a frame per
        // refresh; measured 2026-07-30, cost is per-frame not per-element).
        // steps(8) = 8 opacity changes/sec: measured 3x cheaper, and visually
        // indistinguishable on an 8px dot. See the .animate-pulse comment in
        // globals.css + docs/archive/investigations/2026-07-30-idle-cpu-burn.md
        style={breathing ? { animation: 'breathe 2s steps(8) infinite' } : { opacity: isActive ? 1 : 0.5 }}
      />
    </span>
  );
}

/* ── Status pill ─────────────────────────────────────────── */

// P-8 (2026-08-28): the menu used to show the bare dot and nothing else, so the
// colour was the whole message and you had to remember what amber meant. The
// pill says it in words. Background and border are the dot's own colour at low
// strength; the WORD is the theme's text colour, because the dot palette is
// fixed (bg-green-400 and friends) and a green word on a pale theme measured
// well under a readable contrast.
const STATUS_PILL: Record<SessionStatusColor, string> = {
  green: 'bg-green-400/15 border-green-400/30',
  red: 'bg-red-400/15 border-red-400/30',
  amber: 'bg-amber-400/15 border-amber-400/30',
  blue: 'bg-blue-400/15 border-blue-400/30',
  gray: 'bg-gray-500/15 border-gray-500/30',
};

// `label` exists for ONE caller: the mock-up page that shows two candidate
// wordings side by side. Everywhere in the app it is omitted, so STATUS_LABEL
// stays the single source of the words.
export function StatusPill({ color, isActive, label }: { color: SessionStatusColor; isActive: boolean; label?: string }) {
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 pl-1 pr-1.5 py-[1px] rounded-full border text-4xs leading-none text-fg-2 ${STATUS_PILL[color]}`}>
      <SessionDot color={color} isActive={isActive} />
      {label ?? STATUS_LABEL[color]}
    </span>
  );
}

/* ── Project folder mark ─────────────────────────────────── */

function FolderMark({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2.5h7A1.5 1.5 0 0119 10v7a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 013 17V7.5z" />
    </svg>
  );
}

/* ── Tag marks (a named chip per tag, plus a page when there is a note) ── */

// The tags a session carries, as the same named chips the tag picker and the
// Resume Browser card use — spelled out, not colour-coded dots (Destin, P-8
// review 2, 2026-08-28: "tags should not be dots, but full chips with spelled
// names"). Priority is a reserved flag rather than a tag and leads the row, the
// way it leads the status-bar chip.
const MAX_CHIPS = 3;

function SessionTagMarks({ sessionId, byId }: { sessionId: string; byId: Map<string, TagRecord> }) {
  // One getMeta per open row. The menu holds the live sessions of ONE window,
  // so this is a handful of cheap reads while it is open, and nothing at all
  // when it is shut. A bulk read would need a new channel on all five surfaces.
  const meta = useSessionMeta(sessionId);
  const applied = [...meta.tags].map((id) => byId.get(id)).filter((t): t is TagRecord => !!t);
  const marks: { label: string; color: string }[] = [
    ...(meta.flags.priority ? [{ label: PRIORITY_TAG.label, color: PRIORITY_TAG.color as string }] : []),
    ...applied.map((t) => ({ label: t.label, color: t.color as string })),
  ];
  if (marks.length === 0 && !meta.note) return null;
  // Names cost width, so past three the rest collapse into a count that names
  // them on hover — a row must never push the status pill off its own line.
  const shown = marks.slice(0, MAX_CHIPS);
  const rest = marks.slice(MAX_CHIPS);
  return (
    <span className="shrink-0 flex items-center gap-1">
      {shown.map((m, i) => (
        <TagChip key={i} tag={{ label: m.label, color: m.color as TagRecord['color'] }} />
      ))}
      {rest.length > 0 && (
        <Tooltip text={rest.map((m) => m.label).join(', ')}>
        <span className="text-3xs text-fg-muted">
          +{rest.length}
        </span>
        </Tooltip>
      )}
      {meta.note && (
        <Tooltip text="This session has a note">
        <span className="flex items-center">
          <NotePageGlyph className="w-3 h-3 text-fg-faint" />
        </span>
        </Tooltip>
      )}
    </span>
  );
}

/* ── Drag grip icon (6-dot braille pattern) ──────────────── */

function DragGrip() {
  return (
    <svg className="w-3 h-3 text-fg-faint" viewBox="0 0 12 16" fill="currentColor">
      <circle cx="3.5" cy="2" r="1.2" />
      <circle cx="8.5" cy="2" r="1.2" />
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8.5" cy="8" r="1.2" />
      <circle cx="3.5" cy="14" r="1.2" />
      <circle cx="8.5" cy="14" r="1.2" />
    </svg>
  );
}

/* ── Adaptive session name — shrinks font / adds lines to fit ── */

// P-8 (2026-08-28): one line, cut with an ellipsis, full name on hover.
// This used to wrap to three lines and shrink to 11px to fit the whole name,
// which made six of ten rows two or three lines tall (70px against 42px) and
// left the menu's rows visibly uneven. The project folder now sits on its own
// second line under the name, so the name gets the row's full width.
function SessionName({ name }: { name: string }) {
  return (
    <Tooltip text={name}>
    <span className="block truncate leading-snug text-sm-tight">
      {name}
    </span>
    </Tooltip>
  );
}

// A 1x1 transparent canvas for setDragImage: the compositor then carries
// nothing visible and the strip draws the pill in hand itself (see
// handleDragStart). Made once; a canvas needs no place in the document.
let blankCanvas: HTMLCanvasElement | null = null;
function blankDragImage(): HTMLCanvasElement {
  if (!blankCanvas) {
    blankCanvas = document.createElement('canvas');
    blankCanvas.width = 1;
    blankCanvas.height = 1;
  }
  return blankCanvas;
}

/* ── Main component ──────────────────────────────────────── */

export default function SessionStrip({
  sessions: sourceSessions, activeSessionId, onSelectSession,
  onCreateSession, onCloseSession, sessionStatuses,
  onOpenResumeBrowser, onReorderSessions,
  defaultModel, defaultStartModel, defaultSkipPermissions, defaultProjectFolder,
  windowDirectory, myWindowId,
}: Props) {
  const sourceNames = useMemo(() => Object.fromEntries(sourceSessions.map((s) => [s.id, s.name])), [sourceSessions]);
  const previewNames = useRenamedSessions(sourceNames);
  const sessions = useMemo(() => sourceSessions.map((s) => previewNames[s.id] === undefined
    ? s : { ...s, name: previewNames[s.id] }), [sourceSessions, previewNames]);
  // One registry read for the whole menu: the rows need tag COLOURS, and a hook
  // per row would be one tags.list() per row.
  const tagsById = useTagRegistry().byId;

  // Artifact dispatch — SessionStrip renders only in the main window, inside
  // the ArtifactContext provider, so calling the hook at top level is safe.
  // Used by the FolderSwitcher "Manage projects…" footer to open Project View.
  const { dispatch: artifactDispatch } = useArtifact();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // THE DRAG VISUALS ARE STATE, NOT THE isDragging REF (2026-09-03, R10). The
  // twin, the neighbours' step-aside and the hidden in-flow box used to read
  // `isDragging.current` at render time — a ref that pointerup flips to false
  // at once, while the drop itself is committed later (after dropResolve, an
  // IPC round trip; 150ms in the workbench). Any render landing in that gap —
  // and the last pointermove's own render does, whenever the hand lifts
  // while still moving, which is how a touchpad or finger always lifts —
  // unmounted the twin and drew the pill back at its ORIGIN with the
  // neighbours still stepped aside; then the commit jumped everything to the
  // new order. Fuzzed 2026-09-03: a 116px snap back on touch, a 7px snap
  // forward-and-back on a drop in place. A still hand that pauses before
  // letting go never hit it, which is why ten rounds of probes did not
  // either. `dragActive` is set with the first real move and cleared only by
  // releaseVisuals, in the same render as the reorder.
  const [dragActive, setDragActive] = useState(false);
  const hoveredRef = useRef<string | null>(null);
  // What the last pointer was. A finger gets no hover peek: after a tap the
  // browser reports a mouse "hover" at the tap point that never leaves, so
  // 150ms later the dot under the finger opened its name and kept it open
  // through the next drag as a 56px wide neighbour the pill could overlap
  // (fuzzed 2026-09-03 with touch input; the Z13 is a touchscreen).
  const lastPointerType = useRef<string>('mouse');
  hoveredRef.current = hoveredId;
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shiftNavIdx, setShiftNavIdx] = useState<number>(-1);
  const shiftNavActive = useRef(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newCwd, setNewCwd] = useState('');
  const [dangerous, setDangerous] = useState(false);
  const [newModel, setNewModel] = useState<string>('sonnet');
  // Runtime (Claude Code vs YouCoded native harness) + native binding. The
  // whole control — Runtime toggle, provider/model picker, and all derivation —
  // now lives in the shared RuntimeBinding module so this form and the welcome/
  // app-open form can't drift on native-session creation.
  // Opens on the install's remembered default (see RuntimeBinding.defaultRuntime):
  // 'claude' normally, 'native' on an install that signed in with ChatGPT.
  const [runtime, setRuntime] = useState<Runtime>(() => defaultRuntime());
  const [binding, setBinding] = useState<Binding | null>(() => loadLastBinding());
  const nb = useNativeBinding({ active: showNewForm, runtime, binding, setBinding });

  // First-time warnings (spec §5): Skip Permissions on its toggle, small model
  // on Create. The popover at z-9000 would sit ABOVE the warning and its
  // outside-click closer would read a click in the dialog as "outside", so the
  // popover hides while the warning is up and returns after. Only `menuOpen`
  // flips — `showNewForm` and every field stay put, so Cancel lands back on the
  // form exactly as it was (see useFirstTimeGate for the why).
  const yieldToWarning = { onShow: () => setMenuOpen(false), onSettle: () => setMenuOpen(true) };
  const { gate: gateSkipPermissions, dialog: skipPermissionsDialog } = useFirstTimeGate('skip-permissions', yieldToWarning);
  const { gate: gateSmallModel, dialog: smallModelDialog } = useFirstTimeGate('small-model', yieldToWarning);
  // Native harness preset (Assistant | Coder) — shared lifecycle hook (see
  // RuntimeBinding.usePreset). Follows the folder heuristic until the user picks a
  // card, then latches; re-arms every time the form (re)opens via `showNewForm`.
  const { preset, setPreset } = usePreset({ active: showNewForm, cwd: newCwd });

  // Bridge between the unified <ModelPicker> and the create-time state the form
  // already threads through (runtime / newModel / binding). Kept as a derived
  // value + one setter so the create path below is untouched while the UI is
  // being iterated on.
  const modelChoice: ModelChoice | null = runtime === 'native'
    ? (nb.effectiveBinding
        ? { runtime: 'native', providerId: nb.effectiveBinding.providerId, modelId: nb.effectiveBinding.modelId }
        : null)
    : { runtime: 'claude', alias: newModel };

  // useCallback so the create path below can list it as a dependency: every
  // setter it touches is stable, so this identity never changes.
  const applyModelChoice = useCallback((c: ModelChoice) => {
    if (c.runtime === 'claude') {
      setRuntime('claude');
      setNewModel(c.alias);
    } else {
      setRuntime('native');
      setBinding({ providerId: c.providerId, modelId: c.modelId });
    }
  }, []);
  // Launch the new session in its own peer window instead of this one.
  // Hidden on platforms without multi-window support (Android / remote-shim).
  const [launchInNewWindow, setLaunchInNewWindow] = useState(false);
  const detachAvailable = typeof (window as any).claude?.detach?.openDetached === 'function';
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);
  const pillBarRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useScrollFade<HTMLDivElement>();

  /* ── Pointer-event drag state ──────────────────────────── */
  // Keyed by SESSION ID, not index — see header/drag-order.ts.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // The strip's pill geometry, MEASURED ONCE at pointer-down and not touched
  // again until the next one. A ref, not state: the render reads it to position
  // neighbours, but writing it must not itself schedule a render.
  //
  // WHY frozen rather than re-measured per move: getBoundingClientRect()
  // INCLUDES the translateX applied to the neighbours while a drag is in
  // flight. Re-measuring would feed this frame's answer to "which pill am I
  // over?" back in as next frame's input — the pills chatter back and forth at
  // the boundaries, and the dragged pill's travel clamp (computed from its own
  // rect) drifts.
  const pillRectsRef = useRef<PillRect[]>([]);
  // How far the pill in hand has travelled from where it was picked up, in CSS
  // px, clamped to the strip. Null when nothing is in hand. Only X: the pill
  // rides the strip line; downward motion is tear-off (below), never a Y offset.
  const [dragLeft, setDragLeft] = useState<number | null>(null);
  // Where inside the pill the cursor landed, as a FRACTION of its width. A
  // fraction, not px: on a select-on-press the pill grows from a 24px dot to
  // its full name while in hand, and a px offset would leave the cursor at its
  // far left edge; a fraction keeps it under the same part of the pill.
  // The cursor's x when the drag started. The twin is drawn at ITS IN-FLOW
  // BOX plus how far the cursor has moved since — never anchored to a fraction
  // of the pill under the cursor. WHY (2026-09-03): a drag usually starts while
  // the row is still reflowing from the select-on-press (the old name
  // collapsing, the strip re-centring, the pressed name still opening), and a
  // cursor-anchored twin then parts from its box by the rest of that reflow —
  // measured 15px, enough to sit on the dot behind it at pickup. Riding the
  // box, the pill in hand keeps doing exactly what it did before the drag
  // began (sliding with the row), and it is never anywhere the row's geometry
  // does not account for. Once the row is still, the two anchorings are the
  // same thing.
  const dragStartX = useRef(0);
  // The cursor's last x, for the rAF loop that positions the twin.
  const cursorXRef = useRef(0);
  // The twin's `left` and `width` as React first mounted it. WHY they never
  // change after that: React handles a pointermove as a CONTINUOUS event and
  // may commit its render after this frame's rAF has run, so a `left` computed
  // in the handler (against the bar as it was mid-frame, while the row is still
  // settling) lands a frame late and overwrites the rAF loop's fresh value —
  // measured 2026-09-03 as the twin alternating ±13px every other frame, and
  // once landing on a dot. So React writes both exactly once, at mount, and
  // the rAF loop is the only writer after that.
  const twinMount = useRef<{ left: number; width: number | undefined } | null>(null);
  // The pack the row is settling INTO for this drag, computed at pointer-down
  // (with the pressed session as active when the mode selects on press). Read
  // in place of the live pack for the whole drag so a resize cannot repack
  // under the cursor, and so the synthetic geometry and the rendered row agree.
  const frozenPackRef = useRef<PackResult | null>(null);
  // The bar's left edge at pointer-down. The synthetic geometry is laid out
  // from where the row's first pill sat at press — but after a select-on-press
  // the header re-centres the strip as the row reshapes (measured 2026-09-02:
  // ~40px over 260ms), so the bar, and every pill in it, slides. Positions
  // RELATIVE to the bar stay right; the drag reads the geometry shifted by
  // however far the bar has moved since press.
  const barLeftAtPress = useRef(0);
  // Mirror of overId for the move handler: the next slot depends on the
  // current one (the yield line is crossed early forward and late back), and
  // the handler must read it at event time, not the value it closed over.
  const overIdRef = useRef<string | null>(null);
  // Which way the pill is travelling, with a dead-band (DRAG_TUNE.deadband):
  // `extreme` is the furthest the cursor has gone in the current direction, and
  // the direction flips only once the cursor has come back that far from it.
  const travel = useRef<{ dir: -1 | 0 | 1; extreme: number }>({ dir: 0, extreme: 0 });
  // The settle glide after a drop (see the layout effect below). `settleRef`
  // is armed in the same batch as the reorder; `settle` is the two-phase FLIP
  // state that drives the pill's transform on the renders after it.
  // Keyed by session id: where EVERY pill was drawn at the instant of the drop
  // (the held pill via its twin), so that every pill — not only the held one —
  // glides from where it was to where the reorder puts it. The neighbours step
  // aside by a computed width during the drag; the real width differs by a few
  // px, and without them in the settle they all hop that much at the drop.
  const settleRef = useRef<{ heldId: string; lefts: Map<string, number> } | null>(null);
  const [settle, setSettle] = useState<{ heldId: string; deltas: Map<string, number>; phase: 'hold' | 'glide' } | null>(null);
  // Mirror for the rAF loop, which keeps the flow running through the settle.
  const settleStateRef = useRef(settle);
  settleStateRef.current = settle;
  // True for the one render in which the DOM order changes after a drop.
  // Neighbours' transforms drop to zero in that same render, and their DOM
  // position moves by exactly the amount the transform was — so their
  // transition must be OFF for it, or they would visibly jump and then glide
  // back to where they already were.
  const [reorderQuiet, setReorderQuiet] = useState(false);
  // Track whether pointer moved enough to distinguish drag from click
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  // Suppress the click that fires after a drag release
  const suppressClick = useRef(false);
  // Chrome-style live tear-off: once the user drags the pill far enough below
  // the header, we spawn the new window mid-drag and stream cursor positions
  // to it so it follows the mouse. Ref (not state) because we read/write it
  // from pointermove without wanting a re-render per frame. `pending` guards
  // the async spawn so we only fire the IPC once per drag.
  const liveDetachedWindowId = useRef<number | null>(null);
  const liveDetachPending = useRef(false);
  // Where inside the grabbed pill the cursor sits when pointerdown fires.
  // Reused during live tear-off to position the new window so the cursor ends
  // up over the *same spot* on the torn-off pill, not the window's corner.
  const grabOffsetInPill = useRef<{ x: number; y: number }>({ x: 40, y: 12 });
  const pointerCaptureEl = useRef<HTMLElement | null>(null);
  const pointerCaptureId = useRef<number | null>(null);
  // Cross-window re-dock: true while another window is dragging a pill and
  // the cursor is currently over this window's strip. Drives a visual drop-
  // target highlight. Cleared on any non-hover tick or when the drag ends.
  const [incomingDropActive, setIncomingDropActive] = useState(false);
  // Drop-target highlight for the "sessions in this window" list while a
  // "sessions in other windows" row (native HTML5 drag, see below) is over it.
  const [peerDropActive, setPeerDropActive] = useState(false);
  // Reordering INSIDE the All Sessions menu, by the same native drag the peer
  // rows use. WHY a second system rather than the pointer path the pill bar
  // uses: that path picks a target slot from the cursor's clientX against the
  // PILL BAR's geometry and ignores Y entirely ("Y is ignored on purpose",
  // handlePointerMove) — so in a vertical list the one gesture the list invites
  // could never land anywhere, and a sideways drag reordered against pills the
  // dropdown isn't even near. `menuDragId` is the row in hand; `menuDropIndex`
  // is the insertion slot (0…sessions.length) the line is drawn at.
  const [menuDragId, setMenuDragId] = useState<string | null>(null);
  const [menuDropIndex, setMenuDropIndex] = useState<number | null>(null);
  const endMenuDrag = useCallback(() => { setMenuDragId(null); setMenuDropIndex(null); setPeerDropActive(false); }, []);

  // Listen for cross-window cursor updates from main — fires ~30Hz while
  // a peer window is dragging a pill. We hit-test each update against our
  // own strip's bounding box to decide whether to show the drop highlight.
  useEffect(() => {
    const det = (window as any).claude?.detach;
    if (!det?.onCrossWindowCursor) return;
    const unsub = det.onCrossWindowCursor(({ screenX, screenY }: { screenX: number; screenY: number }) => {
      const bar = pillBarRef.current;
      if (!bar) { setIncomingDropActive(false); return; }
      // Ignore cursor broadcasts originating from our own drag — the source
      // window also receives these but shouldn't highlight its own strip.
      if (isDragging.current) { setIncomingDropActive(false); return; }
      const rect = bar.getBoundingClientRect();
      const localX = screenX - window.screenX;
      const localY = screenY - window.screenY;
      const inside =
        localX >= rect.left && localX <= rect.right &&
        localY >= rect.top && localY <= rect.bottom;
      setIncomingDropActive(inside);
    });
    return () => { try { unsub?.(); } catch {} setIncomingDropActive(false); };
  }, []);

  // Home path is now auto-selected by FolderSwitcher on mount

  // Close menu on outside click (check both trigger area and portal dropdown)
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = menuRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      // Fix: the FolderSwitcher's dropdown is PORTALED to document.body (to
      // escape this menu's overflow-hidden), so the contains() checks above
      // can't see it. Without this check, a mousedown on the portaled panel
      // counted as "outside", closed the menu, and unmounted the picker BEFORE
      // its click could fire — "Manage projects…" and row selection did nothing.
      const inFolderPortal = target instanceof Element && !!target.closest('[data-folder-switcher-portal]');
      // Same trap for the Provider/Model Select menus (RuntimeBinding): those
      // portal to document.body too (data-select-portal), so a click on an
      // option would otherwise close this menu and unmount the Select before
      // its onChange fires — the exact bug above, one component over.
      const inSelectPortal = target instanceof Element && !!target.closest('[data-select-portal]');
      // Third instance of the same trap: the unified <ModelPicker> portals its
      // dropdown to document.body as well. Without this, clicking a model (or
      // its favourite star, or a filter chip) closed this menu and unmounted
      // the picker before the click landed.
      const inModelPortal = target instanceof Element && !!target.closest('[data-model-picker-portal]');
      if (!inTrigger && !inDropdown && !inFolderPortal && !inSelectPortal && !inModelPortal) {
        setMenuOpen(false);
        setShowNewForm(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Shift-hold session switcher: hold Shift to open dropdown, arrow keys to
  // navigate, release Shift to switch to the highlighted session
  const shiftHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;

      // Bare Shift press — start hold timer to open dropdown
      if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey && !shiftNavActive.current) {
        shiftHoldTimer.current = setTimeout(() => {
          shiftHoldTimer.current = null;
          shiftNavActive.current = true;
          const currentIdx = sessions.findIndex(s => s.id === activeSessionId);
          setShiftNavIdx(currentIdx >= 0 ? currentIdx : 0);
          setMenuOpen(true);
        }, 350);
        return;
      }

      // Arrow keys while shift-nav is active
      if (shiftNavActive.current && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setShiftNavIdx(prev => {
          if (e.key === 'ArrowDown') return Math.min(prev + 1, sessions.length - 1);
          return Math.max(prev - 1, 0);
        });
        return;
      }

      // Any other key while Shift is held — cancel switcher (timer or already open)
      if (shiftHoldTimer.current) {
        clearTimeout(shiftHoldTimer.current);
        shiftHoldTimer.current = null;
      }
      if (shiftNavActive.current) {
        shiftNavActive.current = false;
        setShiftNavIdx(-1);
        setMenuOpen(false);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        // Cancel hold timer if Shift was released before it fired
        if (shiftHoldTimer.current) {
          clearTimeout(shiftHoldTimer.current);
          shiftHoldTimer.current = null;
        }
        if (shiftNavActive.current) {
          // Release Shift — select the highlighted session and close
          shiftNavActive.current = false;
          setShiftNavIdx(idx => {
            if (idx >= 0 && idx < sessions.length) {
              onSelectSession(sessions[idx].id);
            }
            return -1;
          });
          setMenuOpen(false);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      if (shiftHoldTimer.current) clearTimeout(shiftHoldTimer.current);
    };
  }, [sessions, activeSessionId, onSelectSession]);

  // Persistent measuring canvas — exists once per component, reused.
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (measureCanvasRef.current === null && typeof document !== 'undefined') {
    measureCanvasRef.current = document.createElement('canvas');
  }

  // One measurement per session, shared by the packer (how much room a pill
  // needs) and the label (how wide its box opens to). The arithmetic lives in
  // header/pill-metrics.ts so the two cannot drift apart.
  //
  // The font is read off the REAL rendered label, not assumed: the UI font is
  // a monospace, and a system-font canvas measured it ~15% narrow. Read after
  // every commit (one getComputedStyle), stored only when it changes, so a theme
  // that swaps the font re-measures and everything else costs a string compare.
  const [font, setFont] = useState<string>(NAME_FONT);
  useLayoutEffect(() => {
    const nameEl = pillBarRef.current?.querySelector('.session-pill__name');
    if (!nameEl) return;
    const name = getComputedStyle(nameEl).font;
    if (name && name !== font) setFont(name);
  });
  const metrics = useMemo(() => {
    const out = new Map<string, PillMetrics>();
    const ctx = measureCanvasRef.current?.getContext('2d') ?? null;
    const measure = (text: string, font: string) => {
      if (!ctx) return text.length * 7; // no canvas (tests): a rough monospace guess
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    for (const s of sessions) {
      out.set(s.id, pillMetrics(s.name, measure, font));
    }
    return out;
  }, [sessions, font]);

  // What the packer is handed — shared by the repack below and by a press,
  // which packs the row it is about to become (see handlePointerDown).
  const measurementsOf = useCallback((): SessionMeasurement[] => sessions.map(s => ({
    id: s.id,
    expandedWidth: metrics.get(s.id)?.expandedWidth ?? 120,
    collapsedWidth: COLLAPSED_PILL_PX,
  })), [sessions, metrics]);

  // No hover peek after a drop until the cursor LEAVES the strip or presses
  // again (2026-09-03): the dropped pill settles out from under the cursor,
  // which then rests on a neighbouring dot — and that dot's peek opened, the
  // row widened and re-centred, all inside the drop's own settle. Destin: "it
  // still bugs out a bit when the chip is released." It was released by 8px
  // of pointer travel; a hand keeps moving after it lets go, so the peek
  // still opened half a second after most drops (fuzzed, R10). The dwell
  // (PEEK_DWELL_MS) is the other guard; this one is the intent to leave.
  const hoverLock = useRef<{ x: number } | null>(null);
  const handleEnter = useCallback((id: string) => {
    if (hoverLock.current !== null) return;
    if (lastPointerType.current === 'touch') return;   // see lastPointerType
    // A pack-expanded pill already shows its name — there is nothing to
    // reveal, and setting hoveredId would only cost a render.
    if (packRef.current.expanded.has(id)) return;
    // Widths freeze for the duration of a drag: dragging OVER a pill must not
    // trigger its hover reveal and grow the row under the cursor.
    if (dragIdRef.current !== null) return;
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null; }
    // A peek already open follows the cursor at once; the first one waits for
    // the hand to rest (PEEK_DWELL_MS).
    if (hoveredRef.current !== null) { setHoveredId(id); return; }
    enterTimer.current = setTimeout(() => {
      enterTimer.current = null;
      if (dragIdRef.current !== null || hoverLock.current !== null) return;
      setHoveredId(id);
    }, PEEK_DWELL_MS);
  }, []);

  const handleLeave = useCallback(() => {
    // Widths freeze for the duration of a drag — and that includes the pill in
    // hand. A fast drag leaves the pill's own box (mouseleave fires), and
    // letting its peek collapse mid-drag would shrink the thing under the
    // cursor by the width its neighbours had already stepped aside for. That
    // was the ~150px void Destin photographed on 2026-09-01: the geometry was
    // frozen at peek width, the pill was not. Hover is released at drop.
    if (dragIdRef.current !== null) return;
    if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null; }
    leaveTimer.current = setTimeout(() => setHoveredId(null), 80);
  }, []);


  const handleMenuToggle = useCallback(() => {
    setMenuOpen(prev => !prev);
    setShowNewForm(false);
  }, []);

  const handleCreate = useCallback(() => {
    // Native runtime carries a provider/model binding; a missing binding is
    // already guarded by the disabled Create button, so bail defensively.
    const nativeBinding = runtime === 'native' ? nb.effectiveBinding : null;
    if (runtime === 'native' && !nativeBinding) return;
    const proceed = () => {
      // Persisted inside `proceed`, not before the gate: a cancelled create
      // should leave no trace, and "last used" is a trace.
      if (nativeBinding) persistLastBinding(nativeBinding);
      onCreateSession(
        newCwd,
        // Hidden for native (see the gate on the toggle), so a value left over
        // from an earlier Claude pick must not ride along into the create.
        runtime === 'native' ? false : dangerous,
        newModel,
        runtime,
        launchInNewWindow,
        nativeBinding ?? undefined,
        runtime === 'native' ? preset : undefined,
      );
      setMenuOpen(false);
      setShowNewForm(false);
      setDangerous(defaultSkipPermissions || false);
      setNewModel(defaultModel || 'sonnet');
      setLaunchInNewWindow(false);
      // Reset to the remembered default, NOT the literal 'claude' -- otherwise a
      // ChatGPT-only install's default would last one session (review R2-3).
      setRuntime(defaultRuntime());
      if (defaultStartModel) applyModelChoice(defaultStartModel);
    };
    // First session on a small model gets the once-only explainer (spec §5).
    // The catalog row supplies the label and, for a local model, the file size
    // that decides when the name carries no parameter count. Claude aliases
    // ('sonnet', 'haiku'…) name no size, so they never trip it.
    const row = nativeBinding
      ? nb.modelCatalog.find((m) => m.providerId === nativeBinding.providerId && m.id === nativeBinding.modelId)
      : undefined;
    const small = isSmallModel({
      modelId: nativeBinding ? nativeBinding.modelId : newModel,
      modelLabel: row?.label,
      localSizeBytes: (row as { local?: { sizeBytes?: number } } | undefined)?.local?.sizeBytes,
    });
    if (small) gateSmallModel(proceed);
    else proceed();
  }, [newCwd, dangerous, newModel, launchInNewWindow, onCreateSession, defaultSkipPermissions, defaultModel, defaultStartModel, applyModelChoice, runtime, nb.effectiveBinding, nb.modelCatalog, preset, gateSmallModel]);

  /* ── Pointer-event drag handlers ───────────────────────── */

  // ── Cross-window tear-off model ───────────────────────────────────────────
  //
  // Which mechanism carries a pill OUT of this window — and, on 'html-drag',
  // which events carry the reorder INSIDE it too. See session-drag-model.ts
  // for the measurements behind the fork. The 'html-drag' handlers live after
  // handlePointerUp, because they feed the same slot logic.
  //
  // Read once per mount: preload reports it synchronously, and a drag cannot
  // wait for a round trip.
  const tearOffModel = useMemo(
    () => chooseTearOffModel((window as any).claude?.platformFacts),
    [],
  );

  const handlePointerDown = useCallback((e: React.PointerEvent, sessionId: string, inStrip = false) => {
    // Only primary button
    if (e.button !== 0) return;
    // WHY (2026-09-07, Destin: "i cant seem to grab the drag handle for
    // same-window sessions"): the All Sessions menu's grip is a native
    // draggable (see the menu list below). Two reasons this path must not
    // engage from it. It cannot do the job — its target slot comes from
    // clientX against the pill bar and ignores Y, so a vertical list drag
    // lands nowhere. And on the live-window model it takes pointer capture,
    // which can stop Chromium ever firing dragstart (same reason the
    // html-drag branch below skips capture). Pressing anywhere ELSE on a menu
    // row still takes this path, so the tear-off-from-the-menu it supports on
    // Windows/macOS is untouched.
    if ((e.target as HTMLElement).closest?.('[data-menu-drag-grip]')) return;
    lastPointerType.current = e.pointerType || 'mouse';
    // Another pill's peek closes NOW, before the drag geometry is frozen below:
    // the packer counts that pill as a dot, but it is drawn 56px wide while its
    // peek is open, and a drag judged against the dot-sized row ran the pill
    // in hand 19px over it (fuzzed 2026-09-03). The pressed pill's own peek
    // stays, as before — it becomes the active label.
    if (hoveredRef.current !== null && hoveredRef.current !== sessionId) {
      if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null; }
      setHoveredId(null);
    }
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;
    travel.current = { dir: 0, extreme: e.clientX };

    const s = sessions.find(x => x.id === sessionId);
    if (!s) return;
    // Capture label + color eagerly so pointermove can start immediately
    setDragId(s.id);
    // Hover is deliberately NOT cleared here. Clearing it collapsed the peek
    // you had open to a dot on mouse-down, and the click then re-expanded the
    // same pill as the active one: open → shut → open, on every click of a dot
    // ("clicking is weird and jumpy", Destin 2026-09-01). The peek simply stays
    // open and becomes the active label.

    const barEl = pillBarRef.current;
    // Chrome selects a tab the instant you press it, and so does the strip
    // (Destin picked "switch on press" over press-with-name-on-drop and
    // switch-on-release, 2026-09-02). That reshapes the row — the old name
    // collapses, the pressed one opens — while a drag may be starting on it,
    // which is why the geometry below is SYNTHETIC: the row the drag is judged
    // against is the one it is settling into, not the one mid-animation under
    // the cursor. Menu rows never select on press.
    const selectsNow = inStrip && sessionId !== activeSessionId;
    const activeForDrag = selectsNow ? sessionId : activeSessionId;
    setPostDropHold(false);   // a press packs afresh — see displayPack

    if (barEl) {
      const barRect = barEl.getBoundingClientRect();
      barLeftAtPress.current = barRect.left;
      const target = packSessions({
        sessions: measurementsOf(), activeId: activeForDrag, budget: stripBudget(barEl), gap: PILL_GAP,
        triggerWidth: 24, overflowChipWidth: OVERFLOW_CHIP_PX,
      });
      frozenPackRef.current = target;
      const visible = sessions.filter(x => target.expanded.has(x.id) || target.collapsed.includes(x.id));
      // A pill's settled width: its full measured width if the packer expands
      // it (capped at the room the packer had, where CSS squeezes the active
      // pill instead — pack-sessions.ts PackResult.pillBudget), else a dot. The pill in hand keeps its open name — Destin, 2026-09-02:
      // "i want to keep the fully expanded name" — so in the row's eyes it is
      // its full width, and a neighbour steps that far to make room.
      const widthOf = (id: string) => {
        if (!target.expanded.has(id)) return COLLAPSED_PILL_PX;
        return Math.min(metrics.get(id)?.expandedWidth ?? 120, Math.max(COLLAPSED_PILL_PX, target.pillBudget));
      };
      // The row starts where the first pill starts today (the bar's padding).
      const first = barEl.querySelector<HTMLElement>('[data-session-id]');
      const originLeft = first ? first.getBoundingClientRect().left : barRect.left + 6;
      pillRectsRef.current = layoutRects(visible.map(x => ({ id: x.id, width: widthOf(x.id) })), originLeft, PILL_GAP);
    }
    if (selectsNow) onSelectSession(sessionId);

    // Measure where in the pill the cursor landed. Used when the live-detach
    // spawns a new window: we offset that window's screen position so the
    // cursor stays over the pill, not the window's top-left corner.
    const pillEl = (e.target as HTMLElement).closest('[data-session-idx]') as HTMLElement | null;
    if (pillEl) {
      const r = pillEl.getBoundingClientRect();
      grabOffsetInPill.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    // Capture on the strip container (not the pill) so capture survives when
    // the pill unmounts after ownership transfer during a live tear-off. If
    // we captured on the pill itself, unmounting would release capture and
    // the new window would stop following the cursor mid-drag.
    //
    // NOT on a mouse press under the 'html-drag' model: the browser is about
    // to start a native drag from this press (the pill is `draggable` there),
    // and a captured pointer can keep Chromium from ever firing dragstart. A
    // finger keeps capture — touch never becomes a browser drag on Linux and
    // reorders on the pointer path as before.
    if (tearOffModel === 'html-drag' && e.pointerType !== 'touch') return;
    const captureEl = (pillBarRef.current ?? (e.target as HTMLElement)) as HTMLElement;
    try { captureEl.setPointerCapture(e.pointerId); } catch { /* container not capturable */ }
    pointerCaptureEl.current = captureEl;
    pointerCaptureId.current = e.pointerId;
  }, [sessions, sessionStatuses, activeSessionId, onSelectSession, metrics, measurementsOf, tearOffModel]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType) lastPointerType.current = e.pointerType;
    // Live tear-off continuation — runs even after we've cleared dragId so the
    // detached window keeps following the cursor. Must be checked BEFORE the
    // dragId null-guard below.
    if (liveDetachedWindowId.current !== null) {
      (window as any).claude?.detach?.dragWindowMove?.({
        windowId: liveDetachedWindowId.current,
        screenX: e.screenX,
        screenY: e.screenY,
        offsetX: grabOffsetInPill.current.x,
        offsetY: grabOffsetInPill.current.y,
      });
      return;
    }

    if (dragId === null || !dragOrigin.current) return;

    // Require 5px movement to start drag (prevents accidental drags on click)
    if (!isDragging.current) {
      const dx = e.clientX - dragOrigin.current.x;
      const dy = e.clientY - dragOrigin.current.y;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      isDragging.current = true;
      setDragActive(true);   // see dragActive
      suppressClick.current = true;
      dragStartX.current = e.clientX;   // see dragStartX
      // Tell main this is a real drag — it starts the cross-window cursor
      // ticker so peer windows can highlight their strip as a drop target.
      const draggedSession = sessions.find(x => x.id === dragId);
      if (!draggedSession) return;
      // Not on 'html-drag': that ticker streams SCREEN coordinates to peer
      // windows, which are all zero there — the browser drag tells them itself.
      if (tearOffModel !== 'html-drag') (window as any).claude?.detach?.dragStarted?.({ sessionId: draggedSession.id });
    }

    // The pill in hand floats over the row, tracking the cursor 1:1 — no
    // transition, no slot snapping — clamped so it cannot leave the row of
    // pills. Its settled width comes from the synthetic geometry.
    // The geometry, shifted by however far the bar has slid since press (see
    // barLeftAtPress) — so the yield lines are where the dots ARE, not where
    // they were before the header re-centred the strip.
    cursorXRef.current = e.clientX;
    const barLeftNow = pillBarRef.current ? pillBarRef.current.getBoundingClientRect().left : barLeftAtPress.current;
    const shift = barLeftNow - barLeftAtPress.current;
    const settled = shift === 0
      ? pillRectsRef.current
      : pillRectsRef.current.map(r => ({ id: r.id, left: r.left + shift, right: r.right + shift }));
    const rects = settled;
    const held = rects.find(r => r.id === dragId);
    // The settled width of the pill in hand — a dot. The twin is still
    // shrinking towards that for the first --dur-reveal of a drag, so it is
    // placed by its CURRENT width (the cursor stays at the same fraction of
    // it) while the slot is judged by the dot it is becoming.
    const heldWidth = held ? held.right - held.left : 0;
    const heldEl = pillBarRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(dragId)}"]`);
    const widthNow = heldEl ? heldEl.getBoundingClientRect().width || heldWidth : heldWidth;
    const boxLeft = heldEl ? heldEl.getBoundingClientRect().left : e.clientX;
    const floatLeft = held
      ? clampFloatLeft(rects, boxLeft + (e.clientX - dragStartX.current), widthNow)
      : null;
    // Bar-local against the bar's left edge NOW, for the same reason.
    if (floatLeft !== null) setDragLeft(floatLeft - barLeftNow);

    // Chrome-style live tear-off. Once the pill has been dragged past the
    // header (cursor Y below the strip's bottom by >= 60px, or above or below
    // the source window), spawn the peer window NOW instead of waiting for
    // pointerup. SIDEWAYS never tears off, as in Chrome: the pill is clamped
    // to the row, and a hand reaching for the FIRST slot overshoots past the
    // window's edge — which spawned a window and snapped the pill home
    // (Destin, R6: "i still cant drag a session into the leftmost position";
    // in the review pane the strip sits 15px from the edge). Subsequent pointermove frames hit the early-return block
    // at the top of this callback and stream cursor positions to the new window.
    const bar = pillBarRef.current;
    // Don't allow tearing off the only session in a window — matches Chrome
    // (a single tab can't be torn out of its window) and avoids the broken
    // click-through state when the source window empties mid-drag.
    //
    // Never on 'html-drag': there the browser already carries the pill out
    // of the window, and a drop on a window's body (SessionDropZone) or strip
    // is what moves it. The pointer path only ever runs INSIDE the strip on
    // that model (a mouse becomes a browser drag within a few px; a finger
    // never leaves the pointer path and reorders only).
    const canLeave = sessions.length > 1 && tearOffModel !== 'html-drag';
    if (!liveDetachPending.current && bar && dragId !== null && canLeave) {
      const stripRect = bar.getBoundingClientRect();
      const outsideOwnWindow = e.clientY < 0 || e.clientY > window.innerHeight;
      // 60px past the strip's bottom ≈ "this pill is clearly not in the strip
      // anymore" without being so eager that a fumbled drag tears a window.
      const belowStrip = e.clientY > stripRect.bottom + 60;
      if (belowStrip || outsideOwnWindow) {
        liveDetachPending.current = true;
        const draggedSession = sessions.find(x => x.id === dragId);
        if (!draggedSession) return;
        const det = (window as any).claude?.detach;
        if (det?.detachLive) {
          det.detachLive({
            sessionId: draggedSession.id,
            screenX: e.screenX,
            screenY: e.screenY,
            offsetX: grabOffsetInPill.current.x,
            offsetY: grabOffsetInPill.current.y,
          }).then((res: { windowId: number }) => {
            liveDetachedWindowId.current = res?.windowId ?? null;
            // Clear the source window's drag UI immediately. The pill has moved
            // to the detached window; the floating ghost shouldn't linger.
            // Pointer capture stays on pillBarRef so the source keeps getting
            // pointermove (via Electron's mouse passthrough on the new window)
            // and fires pointerup when the user releases.
            setDragId(null);
            setOverId(null);
            overIdRef.current = null;
            setDragLeft(null);
            setDragActive(false);
          }).catch(() => {
            liveDetachPending.current = false;
          });
        }
        return;
      }
    }

    // Which slot is the pill heading for? The one its CENTRE is nearest to,
    // computed from the geometry frozen at pointer-down (drag-order.ts). Y is
    // ignored on purpose: the pickup range is the full height of the window,
    // so a slightly-low drag still reorders.
    if (!bar) return;
    // A drag from the All Sessions menu has no float (it is not in the row);
    // nextSlotId then falls back to the pill nearest the cursor.
    // The dot's centre — then mapped from the row AS DRAWN to the row as it
    // will settle (mapToSettled): for the first --dur-reveal of a drag the
    // row is still sliding under the cursor from the select-on-press, and a
    // dot must yield when the pill visibly reaches it, not when it would have
    // in the settled layout. Each pill's drawn left is its LAYOUT position
    // (offsetLeft, which follows the row's reflow but ignores transforms) —
    // never its bounding rect with the translate taken back out: a dot the
    // flow has scaled towards its far edge reports a rect that has moved up
    // to a dot's width, which mapped the pill's centre that far back and
    // fired the yield a dot late (R7, 2026-09-03: the centre rule fired at
    // the far edge — the whole drop travel it was meant to remove).
    // The pill's drawn width is the twin's CURRENT width (widthNow), which is
    // still opening for the first --dur-reveal of a drag begun on a cold press.
    // The yield rule is about the pill's LEADING EDGE reaching a dot's centre,
    // so it is the visible leading edge that is mapped, and the settled-width
    // centre is derived from it — judging by a centre placed with the settled
    // width put the pill's edge up to half its width ahead of where it was
    // drawn, and two dots yielded before the pill visibly reached them
    // (fuzzed 2026-09-03: a 60px glide on release to a slot the pill had never
    // been near).
    const tv = travel.current;
    if (tv.dir >= 0 && e.clientX > tv.extreme) { tv.dir = 1; tv.extreme = e.clientX; }
    else if (tv.dir <= 0 && e.clientX < tv.extreme) { tv.dir = -1; tv.extreme = e.clientX; }
    else if (tv.dir > 0 && e.clientX < tv.extreme - DRAG_TUNE.deadband) { tv.dir = -1; tv.extreme = e.clientX; }
    else if (tv.dir < 0 && e.clientX > tv.extreme + DRAG_TUNE.deadband) { tv.dir = 1; tv.extreme = e.clientX; }
    const leadDrawn = floatLeft !== null
      ? (tv.dir < 0 ? floatLeft : tv.dir > 0 ? floatLeft + widthNow : floatLeft + widthNow / 2)
      : e.clientX;
    const drawn: PillRect[] = [];
    bar.querySelectorAll<HTMLElement>('[data-session-id]').forEach((el) => {
      const id = el.dataset.sessionId;
      if (!id) return;
      const r = el.getBoundingClientRect();
      const left = barLeftNow + el.offsetLeft;
      drawn.push({ id, left, right: left + el.offsetWidth });
      // The veil, decided here for THIS move: a dot drawn within VEIL_PX of
      // where the pill is about to be is hidden in the same render (see
      // veiledRef). Only the rAF loop ever unveils.
      // A dot the flow is shaping (`--flow` set, or scaled to nothing) is
      // the flow's business: it cannot touch the pill, and veiling its
      // zero-width point inside the pill's footprint made it FADE in after
      // its jump instead of appearing whole (seen 2026-09-03 at pickup).
      if (floatLeft !== null && id !== dragId && dotIdsRef.current.has(id)
          && r.width >= 1 && el.offsetWidth <= COLLAPSED_PILL_PX + 1 && el.style.getPropertyValue('--flow') === ''
          && r.right > floatLeft - VEIL_PX && r.left < floatLeft + widthNow + VEIL_PX) {
        veiledRef.current.add(id);
      }
    });
    const centre = floatLeft !== null
      ? mapToSettled(drawn, rects, leadDrawn) + (tv.dir < 0 ? heldWidth / 2 : tv.dir > 0 ? -heldWidth / 2 : 0)
      : leadDrawn;
    const next = nextSlotId(rects, dragId, overIdRef.current, centre, tv.dir);
    if (next !== overIdRef.current) { overIdRef.current = next; setOverId(next); }
  }, [dragId, tearOffModel]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (isDragging.current) hoverLock.current = { x: e.clientX };   // see hoverLock
    const wasDragging = isDragging.current;
    const releasedDragId = dragId;
    const releasedOverId = overId;
    const releasedSession = releasedDragId !== null
      ? sessions.find(x => x.id === releasedDragId) ?? null
      : null;
    const wasLiveDetached = liveDetachedWindowId.current !== null;
    // Where the pill in hand is DRAWN at this instant — the settle glide after
    // the drop starts from here, not from the pill's origin.
    // Read off the DOM, not reconstructed: the twin is where the user sees the
    // pill, and the neighbours' rects INCLUDE their step-aside transforms.
    const snapshot = new Map<string, number>();
    if (wasDragging && pillBarRef.current) {
      for (const el of Array.from(pillBarRef.current.querySelectorAll<HTMLElement>('[data-session-id]'))) {
        snapshot.set(el.dataset.sessionId!, el.getBoundingClientRect().left);
      }
      const twin = pillBarRef.current.querySelector<HTMLElement>(':scope > div[aria-hidden]');
      if (twin && releasedDragId !== null) snapshot.set(releasedDragId, twin.getBoundingClientRect().left);
    }

    dragOrigin.current = null;
    isDragging.current = false;
    liveDetachedWindowId.current = null;
    liveDetachPending.current = false;
    setTimeout(() => { suppressClick.current = false; }, 0);

    // The drag VISUALS are not cleared here. They hold, frozen, until the drop
    // is resolved — the release below is batched into the same render as the
    // reorder, so the pill never springs back to its origin and then jumps to
    // its new slot (what the first version did while it waited on the
    // cross-window drop resolution).
    const releaseVisuals = () => {
      setDragId(null);
      setOverId(null);
      overIdRef.current = null;
      setDragLeft(null);
      setDragActive(false);   // see dragActive
    };

    // Always notify main that the drag ended — even when live-detach already
    // cleared dragId (so releasedSession is null). Main relies on this to
    // turn off mouse-passthrough on the detached window and focus it. Skipping
    // it leaves the new window click-through forever.
    const det = (window as any).claude?.detach;
    if (wasDragging) det?.dragEnded?.();

    // Chrome-style live tear-off already spawned the new window and handed off
    // ownership mid-drag — nothing to resolve on release.
    if (wasLiveDetached) { releaseVisuals(); return; }

    // Pointer capture is set on the strip container (not the pill button) so
    // that capture survives live tear-off ownership transfer. Side-effect: the
    // browser won't synthesize a click event on the button after pointerup
    // (click requires the same physical target for both down and up). Handle
    // session selection here for the no-drag case instead of relying on onClick.
    if (!wasDragging) {
      releaseVisuals();
      if (releasedSession) {
        suppressClick.current = true; // guard against onClick double-fire
        onSelectSession(releasedSession.id);
      }
      return;
    }

    if (!releasedSession) { releaseVisuals(); return; }

    // A local drop: the reorder, the release of the drag visuals and the
    // arming of the settle glide all land in ONE render (React batches every
    // update in a tick, inside a promise callback too). So the DOM order
    // changes in the same commit the transforms drop — the neighbours are
    // already exactly where they were drawn, and only the pill in hand has
    // anywhere left to go.
    const commitLocal = () => {
      // Both ends resolved against the FULL session list — see drag-order.ts.
      if (releasedOverId !== null && onReorderSessions && releasedDragId !== null) {
        const move = reorderIndices(sessions.map(x => x.id), releasedDragId, releasedOverId);
        if (move) onReorderSessions(move.from, move.to);
      }
      if (snapshot.size > 0) settleRef.current = { heldId: releasedSession.id, lefts: snapshot };
      setReorderQuiet(true);
      setPostDropHold(true);   // see displayPack
      // The drop selects the pill, so its name stays open as the active label;
      // the peek state that kept it open through the drag is done.
      setHoveredId(null);
      releaseVisuals();
      onSelectSession(releasedSession.id);
    };

    // If detach IPC isn't available (remote-shim / Android), fall back to
    // the legacy local-only behavior.
    if (!det?.dropResolve) { commitLocal(); return; }

    // Resolve drop across all peer windows: main hit-tests [data-session-strip]
    // in each window against the current cursor. If a hit, re-dock there;
    // if no hit and the cursor is above or below our own viewport, detach to
    // a new peer window; otherwise fall through to the local reorder path.
    // Sideways is not "outside" — same rule as the live tear-off above.
    const clientX = e.clientX;
    const clientY = e.clientY;
    const outsideOwnWindow = clientY < 0 || clientY > window.innerHeight;
    const screenX = (e as any).screenX ?? (window.screenX + clientX);
    const screenY = (e as any).screenY ?? (window.screenY + clientY);

    const resolveAndRoute = async () => {
      let resolved: { targetWindowId: number | null } = { targetWindowId: null };
      try { resolved = await det?.dropResolve?.(); } catch { /* fall through */ }

      const myId = (window as any).__youcodedWindowId;
      const target = resolved?.targetWindowId;

      if (target != null && target !== myId) {
        // Dropped on a peer window's strip → re-dock. The pill leaves this
        // window; nothing here to settle.
        releaseVisuals();
        det?.dragDropped?.({ sessionId: releasedSession.id, targetWindowId: target, insertIndex: 0 });
        return;
      }
      // Dropped outside any window's strip → spawn new peer window. Skip if
      // this would empty the source window (matches the live-tear-off rule:
      // can't tear off a window's only session).
      // Not on 'html-drag': this is a finger (a mouse became a browser drag),
      // and the window it would spawn is placed from screen coordinates that
      // are all zero there. Its route between windows is the pill's menu.
      if (outsideOwnWindow && sessions.length > 1 && tearOffModel !== 'html-drag') {
        releaseVisuals();
        det?.detachStart?.({ sessionId: releasedSession.id, screenX, screenY });
        return;
      }
      commitLocal();
    };

    resolveAndRoute();
  }, [dragId, overId, onReorderSessions, sessions, onSelectSession, tearOffModel]);

  // ── 'html-drag' model: the browser owns the gesture ───────────────────────
  //
  // On Linux/Wayland the pill is a native `draggable`, so the browser starts a
  // drag from the press itself and the compositor carries the picture to any
  // window. Reordering feeds the SAME slot logic as the pointer path, from the
  // `dragover` stream (~190/s, working clientX — measured 2026-09-04). Why not
  // the pointer path plus a mid-gesture handoff: session-drag-model.ts.
  const htmlDragActive = useRef(false);
  // The pill in hand BELOW the row — see the drag stream listener further down.
  const [carried, setCarried] = useState(false);
  const carriedEl = useRef<HTMLDivElement | null>(null);
  const carriedPos = useRef({ x: 0, y: 0 });

  // Every trace of the drag, cleared. Also the safety net below: if another
  // window adopted the pill, its ownership leaves this window and the pill
  // unmounts — and dragend, fired at a node that is no longer in the
  // document, never reaches React.
  const clearHtmlDrag = useCallback(() => {
    htmlDragActive.current = false;
    endLocalSessionDrag();
    dragOrigin.current = null;
    isDragging.current = false;
    setDragId(null);
    setOverId(null);
    overIdRef.current = null;
    setDragLeft(null);
    setDragActive(false);
    setIncomingDropActive(false);
    setCarried(false);
    setTimeout(() => { suppressClick.current = false; }, 0);
  }, []);
  useEffect(() => {
    if (htmlDragActive.current && dragId !== null && !sessions.some((x) => x.id === dragId)) clearHtmlDrag();
  }, [sessions, dragId, clearHtmlDrag]);

  const handleDragStart = useCallback((e: React.DragEvent, sessionId: string) => {
    // Only the 'html-drag' model marks pills draggable, so this fires nowhere
    // else; the guard is against a stray `draggable` ancestor.
    if (tearOffModel !== 'html-drag') { e.preventDefault(); return; }
    const dt = e.dataTransfer;
    writeSessionDrag(dt, sessionId);
    // 'move' is what a session transfer is, and the browser honours it here
    // (it was startDrag's FILE drag that could only offer copy — gone now).
    dt.effectAllowed = 'move';
    // The picture the compositor carries is INVISIBLE (a 1x1 transparent
    // canvas). The strip draws the pill in hand itself: inside the row that is
    // the twin — #404's motion, untouched — and below the row it is the
    // carried ghost, placed from the dragover stream (window-local
    // coordinates, which work on Wayland). A first cut used a snapshot of the
    // pill as the compositor's picture and switched the twin off: that
    // flattened the whole in-row animation, because the loop that flows the
    // dots around the pill keys off the twin (Destin, 2026-09-04: "completely
    // broken the old animation"). The one place nothing is drawn is the bare
    // desktop between two windows — where a release does nothing anyway.
    try {
      dt.setDragImage(blankDragImage(), 0, 0);
    } catch { /* jsdom, or a platform without setDragImage: the browser's default picture */ }
    beginLocalSessionDrag({ sessionId, lone: sessions.length <= 1 });
    htmlDragActive.current = true;
    suppressClick.current = true;
    dragStartX.current = e.clientX;   // see dragStartX
    // What the first real pointermove would have armed — there may not be one
    // (Chromium promotes a press to a drag within a few px). DEFERRED by a
    // tick, and this is load-bearing: `dragActive` re-renders the pill in its
    // slot as `visibility: hidden`, and Chromium ABORTS a drag whose source is
    // hidden synchronously inside dragstart — dragend fired 12ms after
    // dragstart with the pointer still, every time (recorded in the dev
    // window, 2026-09-04). A tick later the browser has its snapshot and no
    // longer cares.
    setTimeout(() => {
      if (!htmlDragActive.current) return;   // already ended — nothing to arm
      isDragging.current = true;
      setDragActive(true);   // see dragActive
    }, 0);
  }, [tearOffModel, sessions]);

  // dropEffect 'move': something took it — this strip reordered, another
  // window adopted, or a drop zone opened a window. 'none': released over
  // NOTHING — the bare desktop, another app, a part of a window that takes no
  // drop — which opens a new window, as it does on Windows and macOS. Escape
  // ends a drag the same way and so ALSO opens a window: the two are
  // indistinguishable (measured 2026-09-04), and Destin chose the desktop drop
  // over Escape — "if a user wants to cancel, they can just drag it back into
  // the original session switcher". A window's only session is the exception
  // (Chrome's rule): it goes back.
  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (!htmlDragActive.current) return;
    const mine = localSessionDrag();
    const effect = e.dataTransfer?.dropEffect;
    clearHtmlDrag();
    if (effect === 'none' && mine && !mine.lone) {
      // The compositor places the window: there are no coordinates to ask for.
      (window as any).claude?.detach?.openDetached?.({ sessionId: mine.sessionId });
    }
  }, [clearHtmlDrag]);

  // The pill in hand BELOW the row: a ghost drawn under the cursor, anywhere
  // in the window. Mounted by state, MOVED by a ref (one style write per
  // dragover, no React churn — the same rule the twin follows).
  const placeCarried = (x: number, y: number) => {
    carriedPos.current = { x, y };
    const el = carriedEl.current;
    if (el) el.style.transform = `translate(${x - grabOffsetInPill.current.x}px, ${y - grabOffsetInPill.current.y}px)`;
  };

  // The drag stream, for the whole window. One listener at the document,
  // not per element: Chromium's dragenter/dragleave pairs carry no usable
  // relatedTarget, so "is the cursor over the row" is a hit-test on each
  // dragover, never an enter/leave count.
  //   Our own pill, over or beside the row (the pointer path's own rule — Y
  //   is ignored for the slot, 60px below the strip is "out"): the slot logic,
  //   fed exactly as pointermove fed it. Below that: the carried ghost, and
  //   the neighbours close the gap as Chrome's tabs do.
  //   Another window's pill: the strip lights up while the cursor is over it.
  const latestMove = useRef(handlePointerMove);
  latestMove.current = handlePointerMove;
  useEffect(() => {
    if (tearOffModel !== 'html-drag') return;
    const onDragOver = (e: DragEvent) => {
      if (!dragCarriesSession(e.dataTransfer)) return;
      const bar = pillBarRef.current;
      if (!bar) return;
      const r = bar.getBoundingClientRect();
      if (!localSessionDrag()) {
        const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        setIncomingDropActive(over);
        return;
      }
      if (!htmlDragActive.current) return;
      const inRow = e.clientY <= r.bottom + 60 && e.clientY >= r.top - 60;
      if (inRow) {
        if (carriedEl.current) setCarried(false);
        latestMove.current({
          clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, pointerType: 'mouse',
        } as unknown as React.PointerEvent);
      } else {
        placeCarried(e.clientX, e.clientY);
        if (!carriedEl.current) setCarried(true);
        if (overIdRef.current !== null) { overIdRef.current = null; setOverId(null); }
      }
    };
    // Leaving the window (no relatedTarget), any drop, any end: no highlight.
    const onLeave = (e: DragEvent) => { if (!e.relatedTarget) setIncomingDropActive(false); };
    const off = () => setIncomingDropActive(false);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('drop', off);
    document.addEventListener('dragend', off);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('drop', off);
      document.removeEventListener('dragend', off);
    };
  }, [tearOffModel]);

  // The strip as a drop target — for its OWN pill (a reorder) and for another
  // window's (adopt it). Accepting is all this does; the motion is fed by the
  // document listener above. Never stopPropagation here: the drop zone over
  // the chat (SessionDropZone) disarms itself on the document's drop, and a
  // swallowed event would leave it covering the chat after a strip drop.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (tearOffModel !== 'html-drag' || !dragCarriesSession(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, [tearOffModel]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (tearOffModel !== 'html-drag') return;
    const sessionId = readSessionDrag(e.dataTransfer);
    // Anything that is not one of our session drags falls through untouched —
    // a user dropping a real file on the header must not move a session, and
    // must not have their drop swallowed either.
    if (!sessionId) return;
    e.preventDefault();
    setIncomingDropActive(false);
    if (!sessions.some((x) => x.id === sessionId)) {
      // Another window's pill. Main resolves the source window from its
      // ownership registry; this message deliberately carries no source, so it
      // cannot be used to move a session this window was never offered.
      (window as any).claude?.detach?.dragAdopt?.({ sessionId });
      return;
    }
    // Our own pill, released in our own strip: the reorder, committed exactly
    // as the pointer path commits a local drop — order change, release of the
    // visuals and the arming of the quiet render all in one batch.
    const target = overIdRef.current;
    if (target !== null && onReorderSessions) {
      const move = reorderIndices(sessions.map((x) => x.id), sessionId, target);
      if (move) onReorderSessions(move.from, move.to);
    }
    setReorderQuiet(true);
    setPostDropHold(true);   // see displayPack
    setHoveredId(null);
    clearHtmlDrag();
    onSelectSession(sessionId);
  }, [tearOffModel, sessions, onReorderSessions, onSelectSession, clearHtmlDrag]);

  // ── The pill's menu: the route that works everywhere ──────────────────────
  //
  // Right-click (or long-press) a pill → "Move to new window" / "Move to
  // window N". Cannot fail on any platform, works by keyboard, and it is the
  // ONLY way a finger moves a session between windows on Linux/Wayland (touch
  // never becomes a browser drag there — measured 2026-09-04).
  const [renameId, setRenameId] = useState<string | null>(null);
  const [pillMenu, setPillMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const handlePillContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    const det = (window as any).claude?.detach;
    // Desktop Electron only. The phone and the remote browser are one window,
    // and their shim stubs every detach call as a no-op — so the function
    // check alone would offer "Move to new window" there and do nothing.
    if (isAndroid() || isRemoteMode() || typeof det?.openDetached !== 'function') return;
    e.preventDefault();
    e.stopPropagation();
    setPillMenu({ x: e.clientX, y: e.clientY, sessionId });
  }, []);
  const pillMenuEntries = useMemo((): MenuEntry[] => {
    if (!pillMenu) return [];
    const det = (window as any).claude?.detach;
    const { sessionId } = pillMenu;
    const entries: MenuEntry[] = [{
      type: 'item', id: 'move-new-window', label: 'Move to new window', icon: 'open',
      // Chrome's rule: a window's only session cannot be torn off — that
      // would close this window and open an identical one.
      disabled: sessions.length <= 1,
      run: () => det?.openDetached?.({ sessionId }),
    }];
    const others = (windowDirectory?.windows ?? []).filter((w) => w?.window && w.window.id !== myWindowId);
    if (others.length) entries.push({ type: 'sep' });
    for (const w of others) {
      const names = (w.sessions ?? []).map((x) => x.name).filter(Boolean);
      const hint = names.length ? ` — ${names.slice(0, 2).join(', ')}${names.length > 2 ? '…' : ''}` : '';
      entries.push({
        type: 'item', id: `move-${w.window.id}`, label: `Move to ${w.window.label}${hint}`, icon: 'open',
        // The same message a cross-window drop sends: main moves ownership
        // from THIS window (the sender) to the named one.
        run: () => det?.dragDropped?.({ sessionId, targetWindowId: w.window.id, insertIndex: 0 }),
      });
    }
    if (namingApi()) entries.unshift({ type: 'item', id: 'rename-session', label: 'Rename session…', icon: 'rename', run: () => setRenameId(sessionId) });
    return entries;
  }, [pillMenu, sessions.length, windowDirectory, myWindowId]);

  const handleClick = useCallback((id: string) => {
    if (suppressClick.current) return;
    onSelectSession(id);
  }, [onSelectSession]);

  const pillElement = (id: string) =>
    pillBarRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`) ?? null;

  // The settle glide after a drop — a FLIP in two renders, all before paint.
  //
  // Render A (the drop's own render): the DOM order has changed and every
  // transform has dropped, so the released pill is drawn IN its new slot. Not
  // painted yet. This effect measures where that slot is, and the difference
  // from where the pill was released is `delta`.
  // Render B ('hold'): the pill is put back at its release position with
  // `translateX(delta)` and NO transition, and the forced layout read below
  // makes the browser compute that style.
  // Render C ('glide'): the transform goes to zero on the settle curve — the
  // browser sees delta → 0 with a transition and animates it. Chrome's
  // release: the tab is already where it is going; it just has a little way
  // left to travel.
  useLayoutEffect(() => {
    const armed = settleRef.current;
    if (armed !== null) {
      settleRef.current = null;
      const deltas = new Map<string, number>();
      for (const [id, wasLeft] of armed.lefts) {
        // A DOT never glides: its two images (box + ghost, the flow) are already
        // where the eye sees them, and after the reorder its box is simply at
        // whichever of the two spots the order put it — the flow's layout effect
        // re-sizes both in this same frame. Holding a dot at its old rect and
        // gliding it (the FLIP below) drew a dot the pill had been over at FULL
        // size under the settling pill, then slid it 128px (fuzzed 2026-09-03).
        if (dotIdsRef.current.has(id)) continue;
        const el = pillElement(id);
        if (!el) continue;
        const delta = wasLeft - el.getBoundingClientRect().left;
        if (Math.abs(delta) >= 0.5) deltas.set(id, delta);
      }
      // The reads above also forced layout of render A, so the neighbours'
      // "no transition" render has been computed and can now be restored.
      setReorderQuiet(false);
      if (deltas.size > 0) setSettle({ heldId: armed.heldId, deltas, phase: 'hold' });
      return;
    }
    if (settle?.phase === 'hold') {
      const el = pillElement(settle.heldId);
      if (el) void el.getBoundingClientRect();
      setSettle({ ...settle, phase: 'glide' });
    }
  });
  /** One frame of the flow (see the note at dragOffsetsRef): scale every dot
   *  the pill is covering, and draw each one's ghost at its spot across the
   *  pill. A covered dot has TWO images — at its box and at the mirror spot
   *  one pill-width away on the other side — each shrinking towards its own
   *  far edge as the pill covers it, so the two sizes always sum to about
   *  one. Which image is the real dot is the yield (nextSlotId): before it
   *  the box is ahead of the pill and the ghost behind, after it the box has
   *  jumped behind and the ghost is what remains ahead. Since both are drawn
   *  either way, the swap itself changes nothing on screen, and the yield
   *  can fire where Chrome's does — the dot's centre — instead of at its far
   *  edge (2026-09-03, R7: the drop travelled a whole dot, see DRAG_TUNE).
   *  Direction plays no part: which side of the pill each image is on says
   *  which way it shrinks. */
  const flow = (bar: HTMLElement, t: DOMRect, heldId: string) => {
    const barL = bar.getBoundingClientRect().left;
    const G = FLOW_GAP_PX;
    // Scale of a dot drawn at bar-local `left`: 1 when clear of the pill,
    // shrinking towards its far edge as the pill covers it, 0 under the pill.
    const scaleAt = (left: number, w: number): { k: number; origin: string } | null => {
      const dl = barL + left, dr = dl + w;
      if (!(dl < t.right + G && dr > t.left - G)) return null;   // not covered
      const onRight = dl + w / 2 > t.left + t.width / 2;
      return onRight
        ? { k: Math.min(1, Math.max(0, (dr - (t.right + G)) / w)), origin: 'right center' }
        : { k: Math.min(1, Math.max(0, ((t.left - G) - dl) / w)), origin: 'left center' };
    };
    const wanted = new Map<string, { src: HTMLElement; left: number; k: number; origin: string }>();
    bar.querySelectorAll<HTMLElement>('[data-session-id]').forEach((el) => {
      const id = el.dataset.sessionId;
      if (!id || id === heldId || !dotIdsRef.current.has(id)) return;
      // Where the dot is drawn this frame WITHOUT its scale: layout position
      // plus its step-aside offset (the transform React set).
      const off = dragOffsetsRef.current.get(id) ?? 0;
      const left = el.offsetLeft + off;
      const w = el.offsetWidth;
      // Only a dot-SIZED pill flows. The pack calls the old active pill a dot
      // the moment another is pressed, but it is still 190px wide and closing
      // for --dur-reveal; shaping it drew a 77px ghost of its NAME beside it
      // (fuzzed 2026-09-03, a cold press followed by an immediate drag).
      if (w > COLLAPSED_PILL_PX + 1) { el.style.removeProperty('--flow'); el.style.removeProperty('--flow-origin'); return; }
      const at = scaleAt(left, w);
      if (at === null || at.k >= 1) {
        el.style.removeProperty('--flow');
        el.style.removeProperty('--flow-origin');
        return;
      }
      el.style.setProperty('--flow', String(at.k));
      el.style.setProperty('--flow-origin', at.origin);
      // Its other image: the same dot one pill-width across the pill, on the
      // side the box is not. Drawn while it has any size. A mirror the pill
      // does not reach is drawn WHOLE, not dropped: the box is covered, so if
      // its mirror is clear the dot's whole mass is over there — under the
      // pill entire (k = 0) the mirror sits exactly one gap past the pill's
      // far edge, and dropping it blinked the dot out for the frame before
      // its yield (seen at the row's end, 2026-09-03).
      const mirror = at.origin === 'right center' ? left - (t.width + G) : left + (t.width + G);
      const m = scaleAt(mirror, w) ?? { k: 1, origin: at.origin === 'right center' ? 'left center' : 'right center' };
      if (m.k > 0) wanted.set(id, { src: el, left: mirror, k: m.k, origin: m.origin });
    });
    bar.querySelectorAll<HTMLElement>(':scope > [data-ghost]').forEach((g) => {
      if (!wanted.has(g.dataset.ghost ?? '')) g.remove();
    });
    wanted.forEach(({ src, left, k, origin }, id) => {
      let ghost = bar.querySelector<HTMLElement>(`:scope > [data-ghost="${CSS.escape(id)}"]`);
      if (!ghost) {
        // A copy of the dot itself (same colour, same size), stripped of
        // everything that names it: nothing that walks the row by
        // `[data-session-id]` may find it.
        ghost = src.cloneNode(true) as HTMLElement;
        ghost.removeAttribute('data-session-id');
        ghost.removeAttribute('data-session-idx');
        ghost.removeAttribute('title');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.dataset.ghost = id;
        ghost.classList.remove('session-pill--veiled');
        bar.appendChild(ghost);
      }
      ghost.style.cssText = `position:absolute; top:50%; left:${left}px; width:${src.offsetWidth}px; transform:translateY(-50%) scale(${k}); transform-origin:${origin}; pointer-events:none; opacity:1; visibility:visible; transition:none; margin:0;`;
    });
  };

  // The twin is a fresh element, so its label opens to full width the instant
  // it mounts — while the in-flow box it stands in for is still mid-reveal
  // after a select-on-press, and the dots beyond it have not been pushed yet.
  // Measured 2026-09-01: the twin's leading edge sat 14px over the next dot
  // for the first ~40ms of every drag started right after a press. So while a
  // pill is in hand the twin's WIDTH follows the in-flow box's width, frame by
  // frame, written straight to the DOM (no React churn for a 200ms settle).
  // The loop also runs THROUGH THE SETTLE after a drop (2026-09-03): a drop
  // can land while the dot ahead is mid-flow (part covered, its ghost part
  // grown). The pill then glides back to its slot, and if the flow stopped at
  // the drop that dot popped to full size under the gliding pill and the ghost
  // vanished — Destin: "it still bugs out a bit when the chip is released".
  // With the flow fed the REAL pill's rect during the glide, the dot regrows
  // and the ghost shrinks away exactly as the pill uncovers them.
  const flowActive = dragLeft !== null || settle !== null;
  useEffect(() => {
    if (!flowActive) return;
    const bar = pillBarRef.current;
    if (!bar) return;
    let raf = 0;
    const tick = () => {
      const dragId = dragIdRef.current;
      const real = dragId !== null ? pillElement(dragId) : null;
      const twin = bar.querySelector<HTMLElement>(':scope > div[aria-hidden]:not([data-ghost])');
      if (dragId !== null && real && twin) {
        const w = real.getBoundingClientRect().width;
        twin.style.width = `${w}px`;
        // Its LEFT: the in-flow box plus the cursor's travel (dragStartX),
        // clamped to the row of pills — never past the first pill's left edge
        // or the last pill's right (Destin, R5: "it should stop moving at the
        // left/right boundaries … rather than sliding past"; the handler's
        // clamp never reached the DOM once React stopped writing `left`).
        // Layout positions, so the yields' transforms do not move the ends.
        const barL = bar.getBoundingClientRect().left;
        const pills = bar.querySelectorAll<HTMLElement>('[data-session-id]');
        const first = pills[0], last = pills[pills.length - 1];
        const minLeft = first ? first.offsetLeft : 0;
        const maxLeft = last ? last.offsetLeft + last.offsetWidth - w : Infinity;
        const wanted = real.getBoundingClientRect().left + (cursorXRef.current - dragStartX.current) - barL;
        twin.style.left = `${Math.min(maxLeft, Math.max(minLeft, wanted))}px`;
        // The veil (see veiledRef): a dot within VEIL_PX of the twin, where
        // it is DRAWN this frame, is hidden; one that has come clear is shown
        // again (its inline opacity transition fades it in). Written straight
        // to the DOM — one class toggle per dot per frame at most.
        const t = twin.getBoundingClientRect();
        flow(bar, t, dragId);
        bar.querySelectorAll<HTMLElement>('[data-session-id]').forEach((el) => {
          const id = el.dataset.sessionId;
          if (!id || id === dragId || !dotIdsRef.current.has(id)) return;
          const r = el.getBoundingClientRect();
          // Same exemption as in handlePointerMove: the flow's dots are its own.
          const flowing = r.width < 1 || el.style.getPropertyValue('--flow') !== '';
          // A pill still closing to a dot is a wide neighbour, not a dot (see flow).
          const wide = el.offsetWidth > COLLAPSED_PILL_PX + 1;
          const near = !flowing && !wide && r.right > t.left - VEIL_PX && r.left < t.right + VEIL_PX;
          const veiled = veiledRef.current.has(id);
          if (near && !veiled) { veiledRef.current.add(id); el.classList.add('session-pill--veiled'); }
          else if (!near && veiled) { veiledRef.current.delete(id); el.classList.remove('session-pill--veiled'); }
        });
      } else {
        // Settling after a drop: the real pill is what moves now.
        const st = settleStateRef.current;
        const landed = st ? pillElement(st.heldId) : null;
        if (st && landed) flow(bar, landed.getBoundingClientRect(), st.heldId);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      twinMount.current = null;
      // The flow: no ghosts, every dot back at full size.
      bar.querySelectorAll(':scope > [data-ghost]').forEach((g) => g.remove());
      bar.querySelectorAll<HTMLElement>('[data-session-id]').forEach((el) => {
        el.style.removeProperty('--flow');
        el.style.removeProperty('--flow-origin');
      });
      // The drag is over: everything is drawn again.
      veiledRef.current.clear();
      bar.querySelectorAll('.session-pill--veiled').forEach((el) => el.classList.remove('session-pill--veiled'));
    };
  }, [flowActive]);

  // Belt and braces: transitionend does not fire for an element that was
  // re-rendered out of its transition, so the glide state also times out.
  useEffect(() => {
    if (settle?.phase !== 'glide') return;
    const t = setTimeout(() => setSettle(null), 400);
    return () => clearTimeout(t);
  }, [settle]);

  // --- Space-aware packing ---
  // We measure each pill's expanded width offscreen using a hidden canvas
  // (no layout thrash). Collapsed width is constant (dot + padding ≈ 24 px).
  const [pack, setPack] = useState<PackResult>({
    expanded: new Set(),
    collapsed: sessions.map(s => s.id),
    overflow: [],
    pillBudget: 0,
  });

  // Fix (active pill snapped open): packSessions always marks the active pill
  // expanded, and the label's `transition: 'none'` — which exists to stop pills
  // sliding on every repack — therefore silenced exactly the pill the user just
  // clicked. Open a short window on a change of active session id, during which
  // that `none` is overridden. Nothing else opens it, so repack churn stays as
  // still as it is today.
  // The window is as long as the vocabulary needs (the name reveal), read off
  // the stylesheet — see motionWindowMs. Also armed when a drag starts and
  // ends, so a label that opens or closes at pickup or drop is inside the
  // repack-churn kill-switch's exception.
  const [windowMs, setWindowMs] = useState(EXPAND_WINDOW_FALLBACK_MS);
  useLayoutEffect(() => {
    const ms = motionWindowMs(pillBarRef.current);
    if (ms !== windowMs) setWindowMs(ms);
  });
  const expandArmed = useOneShotWindow(`${activeSessionId}:${dragLeft !== null}`, windowMs);

  // Everything below reads the pack the drag was packed against (frozen at
  // pointer-down) while a pill is held; `pack` is the live one otherwise.
  // …and STAYS on the drag's pack after a drop, until the pointer leaves the
  // strip (2026-09-03). A drop reorders the row, and the live packer, re-run
  // on the new order, may pick a different second pill to open — measured:
  // the dot right after the dropped pill bloomed to a 151px name at the very
  // moment of the drop, and the whole row re-centred 60px under the cursor.
  // Destin: "it still bugs out a bit when the chip is released." The hold is
  // released when the cursor leaves the strip, on the next press, or when the
  // session list changes — never by a timer, so nothing moves under a hand
  // that has not moved.
  const [postDropHold, setPostDropHold] = useState(false);
  useEffect(() => { setPostDropHold(false); }, [sessions.length]);
  const displayPack = (dragId !== null || postDropHold) && frozenPackRef.current !== null ? frozenPackRef.current : pack;

  // Mirror of `displayPack` for event handlers — they must read the CURRENT
  // pack at event time, not the one captured when the callback was created. A
  // ref, so handleEnter does not need it in its dependency list and stays
  // stable across repacks.
  const packRef = useRef(displayPack);
  useEffect(() => { packRef.current = displayPack; }, [displayPack]);

  // Mirror of dragId for the same reason.
  const dragIdRef = useRef<string | null>(null);
  useEffect(() => { dragIdRef.current = dragId; }, [dragId]);


  const repack = useCallback(() => {
    const bar = pillBarRef.current;
    if (!bar) return;
    const result = packSessions({
      sessions: measurementsOf(),
      activeId: activeSessionId,
      budget: stripBudget(bar),   // see stripBudget
      gap: PILL_GAP,
      triggerWidth: 24, // ▾ button is w-5 + ml-1
      overflowChipWidth: OVERFLOW_CHIP_PX,
    });
    setPack(result);
  }, [activeSessionId, measurementsOf]);

  // Pack on mount, on session-list change, and on any container resize.
  useLayoutEffect(() => { repack(); }, [repack]);
  useEffect(() => {
    const bar = pillBarRef.current;
    if (!bar) return;
    // Observe the wrapper (parentElement), not the strip itself. The strip is
    // content-sized and never grows on its own, so observing it would never
    // fire when more space becomes available.
    const target = bar.parentElement ?? bar;
    const ro = new ResizeObserver(() => repack());
    ro.observe(target);
    return () => ro.disconnect();
  }, [repack]);

  // Android always forces single-session mode (no room for siblings on mobile chrome).
  const forceSingle = isAndroid();
  const visibleSessions = forceSingle
    ? sessions.filter(s => s.id === activeSessionId)
    : sessions.filter(s => displayPack.expanded.has(s.id) || displayPack.collapsed.includes(s.id));

  const dragging = dragId !== null && dragActive && dragLeft !== null;   // state, never the ref — see dragActive

  // Chrome's model: the pill in hand is the thing that moves — under the
  // cursor, clamped to the strip — and every pill between its origin and its
  // target steps aside by one pill-width so the gap it will land in is already
  // open. On release there is nothing to jump to: it glides the last few px
  // home.
  //
  // HOW the pill in hand is drawn (2026-09-01): its in-flow box stays in the row
  // but invisible, still holding its slot and still animating its own width
  // (so the row reshapes naturally on a select-on-press), and a TWIN of it —
  // the same markup, same styles — floats absolutely inside the bar at the
  // cursor. The twin has no data attributes: everything that walks the row by
  // `[data-session-id]` (tear-off placement in main.ts, the perf lab, the
  // settle below) must find exactly one node per session.
  const dragOffsets = dragging && dragId
    ? neighbourOffsets(pillRectsRef.current, dragId, overId)
    : EMPTY_OFFSETS;

  // NO DOT IS EVER DRAWN TOUCHING THE PILL IN HAND (2026-09-02). Destin, after
  // a slide and then a blink had both been tried: "the problem is that the
  // dragged session kept visibly overlapping dots before they appeared to
  // begin to move. it would be fine if they teleport or fade in/fade out as
  // long as they dont visually touch the dragged pill." So the rule is
  // geometric, not timed: a dot within VEIL_PX of the twin is not drawn at
  // all (`.session-pill--veiled`, instant), it moves — a plain jump — while
  // it cannot be seen, and it fades back in only once it is clear of the pill
  // again. Two writers keep the set in step: the rAF loop below (proximity,
  // read off the DOM every frame, and the only thing that ever UNVEILS) and
  // this render (a dot whose step-aside offset changes is veiled in the same
  // commit that moves it, so a fast pointer can never land the jump in view).
  // Only dots: a wide neighbour still slides, on the fast-deceleration curve;
  // blanking a 190px name would leave a hole. Cleared when the drag ends.
  const veiledRef = useRef<Set<string>>(new Set());
  if (!dragging && veiledRef.current.size > 0) veiledRef.current.clear();
  // Mirror of the offsets for the rAF loop, which reads them every frame.
  const dragOffsetsRef = useRef<ReadonlyMap<string, number>>(EMPTY_OFFSETS);
  dragOffsetsRef.current = dragOffsets;
  // THE SWAP AND THE FLOW MUST LAND IN ONE FRAME. A yield is a React commit
  // (the dot's step-aside transform moves its box one pill-width across); the
  // flow that sizes the dot's two images ran only in the rAF loop below, one
  // frame later. In between, one frame painted the box at its NEW spot with
  // the OLD spot's scale and origin, and the ghost — still where the last
  // frame left it — at that same spot: the dot doubled on one side of the pill
  // and absent on the other. A hand rocking across the swap line does that
  // several times a second (probed 2026-09-03 with WOBBLE=7: 12px flicker on
  // every crossing; Destin, R9: "stilll janky"). So the flow also runs as a
  // LAYOUT effect on every commit that moves a box or lands the pill — after
  // the DOM changes, before paint — and the rAF loop only follows the cursor.
  useLayoutEffect(() => {
    if (!flowActive) return;
    const bar = pillBarRef.current;
    const heldId = dragId ?? settle?.heldId ?? null;
    if (!bar || heldId === null) return;
    const twin = bar.querySelector<HTMLElement>(':scope > div[aria-hidden]:not([data-ghost])');
    const t = twin ? twin.getBoundingClientRect() : pillElement(heldId)?.getBoundingClientRect();
    if (t) flow(bar, t, heldId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- overId (the yield) and settle (the drop) are the commits that move boxes; flow reads refs
  }, [flowActive, dragId, overId, settle]);
  // THE DOT FLOWS AROUND THE PILL (2026-09-03). Hiding the dot the pill is
  // passing over leaves its width as a hole beside the pill — always about
  // one dot's worth, ahead or behind depending on when it jumps — and Destin
  // saw it: "too much empty space on either side of the dragged chip". So
  // a dot the pill is over SHRINKS towards its far edge as the pill covers
  // its space, keeping FLOW_GAP_PX clear of the pill's edge, while a ghost of
  // it GROWS at its spot across the pill, keeping the same gap from the other
  // edge. When the pill has crossed its centre (DRAG_TUNE.margin) the real
  // dot jumps to that spot and the ghost takes over at the old one — both
  // images are drawn before and after, at sizes that sum to one, so the swap
  // shows nothing. Mass flows through the pill; nothing touches it; the row
  // never shows a hole. All of it is written by
  // the rAF loop below from the twin's rect each frame (`--flow`, the ghost),
  // never by React, for the reason twinMount gives. The veil stays as the
  // safety net for geometry the flow does not account for (the pickup, while
  // the row is still sliding under the cursor).
  // Which pills are dots in the pack the drag is judged against — for the rAF loop.
  const dotIdsRef = useRef<Set<string>>(new Set());
  dotIdsRef.current = new Set(displayPack.collapsed);

  // What a hover peek may open into: the strip's pill room minus the packed
  // row (each visible pill at its packed width, with the gaps). See
  // LabelStyleInput.room for why the peek is capped at all.
  const peekRoom = useMemo(() => {
    const visibleIds = sessions.filter(s => displayPack.expanded.has(s.id) || displayPack.collapsed.includes(s.id));
    const row = visibleIds.reduce((sum, s) =>
      sum + (displayPack.expanded.has(s.id) ? (metrics.get(s.id)?.expandedWidth ?? 120) : COLLAPSED_PILL_PX), 0)
      + Math.max(0, visibleIds.length - 1) * PILL_GAP;
    return Math.max(0, displayPack.pillBudget - row);
  }, [sessions, displayPack, metrics]);

  // After the hooks above: an early return before them would change the hook
  // order between renders.
  if (sessions.length === 0) return null;

  return (
    <>
      <div
        ref={pillBarRef}
        data-session-strip
        // Pointer capture is set on this container during drag (see handlePointerDown).
        // React's event delegation still fires the pill's onPointerMove/onPointerUp
        // because events bubble up through the captured element, but we also listen
        // here as a safety net in case the pill unmounts mid-drag (live tear-off).
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onMouseLeave={() => { setPostDropHold(false); hoverLock.current = null; }}
        // 'html-drag' only — reorder of our own pill and adoption of another
        // window's; inert on every other model, where no browser drag exists.
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`session-strip relative flex items-center gap-0.5 bg-inset rounded-full px-1.5 py-0.5 overflow-hidden min-w-0 shrink transition-shadow ${incomingDropActive ? 'ring-2 ring-accent/70' : ''}`}
      >
        {/* ── Session pills ──────────────────────────────── */}
        {visibleSessions.map((s, idx) => {
          const color = sessionStatuses?.get(s.id) || 'gray';
          const isActive = s.id === activeSessionId;
          const isHovered = hoveredId === s.id;
          const isBeingDragged = dragId === s.id && dragActive;   // see dragActive
          const showName = forceSingle
            ? isActive
            : displayPack.expanded.has(s.id) || isHovered || isActive;
          // A HOVER PEEK: the name is showing only because the cursor is on it.
          // The packer reserved no room for this pill, so the name is capped
          // (pill-label-style.ts).
          const hoverPeek = !isActive && !displayPack.expanded.has(s.id);
          const isDot = !displayPack.expanded.has(s.id);

          const pillClass = `
                  relative flex items-center gap-1 rounded-full px-1.5 py-px
                  border select-none touch-none overflow-hidden
                  ${showName && (isActive || !displayPack.expanded.has(s.id))
                    ? 'border-edge bg-panel'
                    : 'border-transparent'
                  }`;
          const pillBody = (
            <>
                <SessionDot color={color} isActive={isActive} />
                <span
                  className={`session-pill__label text-xs font-medium text-fg-2 ${isActive ? 'min-w-0' : ''}`}
                  style={pillLabelStyle({
                    showName,
                    isActive,
                    packExpanded: displayPack.expanded.has(s.id),
                    // The repack-churn kill-switch is lifted for every pill
                    // during the switch window: the new active pill opens and
                    // the old one closes in the same motion.
                    animateExpand: expandArmed,
                    nameWidth: metrics.get(s.id)?.nameWidth ?? 0,
                    room: peekRoom,
                  })}
                >
                  {/* Laid out once at full width; the box above clips and fades
                      it. See .session-pill__name in globals.css. */}
                  <span className="session-pill__name">{s.name}</span>
                </span>
            </>
          );

          return (
            <React.Fragment key={s.id}>
              <Tooltip text={s.name}>
              <button
                data-session-idx={idx}
                data-session-id={s.id}
                onPointerDown={(e) => handlePointerDown(e, s.id, true)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onClick={() => handleClick(s.id)}
                onContextMenu={(e) => handlePillContextMenu(e, s.id)}
                // 'html-drag' only (Linux/Wayland): the browser starts a native
                // drag from the press. Everywhere else the pointer path owns
                // the whole gesture and a draggable pill would break it.
                draggable={tearOffModel === 'html-drag'}
                onDragStart={(e) => handleDragStart(e, s.id)}
                onDragEnd={handleDragEnd}
                // Fix: these used to be `undefined` for pack-expanded pills.
                // A pill the packer collapsed to a dot while the cursor was
                // already on it therefore never received a mouseenter and sat
                // as a dot until the user moved away and back. Always attach;
                // decide inside, where pack state is read at event time.
                onMouseEnter={() => handleEnter(s.id)}
                onMouseLeave={handleLeave}
                className={`${pillClass} ${isActive ? 'min-w-0 shrink' : 'shrink-0'} ${isBeingDragged ? 'cursor-grabbing' : ''}${veiledRef.current.has(s.id) ? ' session-pill--veiled' : ''}`}
                style={{
                  // Explicit property list, not `all`: `all` animates every
                  // animatable property that changes, including layout ones, and
                  // each animating property is presented at the panel's full
                  // refresh rate. Only these change on hover/active/drag.
                  // box-shadow is in the list because the active pill's glow is
                  // set right below from GLOW_SHADOW — without it the glow would
                  // snap on.
                  // The in-flow box of the pill in hand keeps its slot but is
                  // not drawn — its twin below is. Its label still animates
                  // (so the row reshapes on a select-on-press), hence the
                  // ordinary transition list, not 'none'.
                  visibility: isBeingDragged ? 'hidden' : undefined,
                  transition: (reorderQuiet || settle?.deltas.has(s.id) && settle.phase === 'hold')
                      // The render in which the DOM order changes, and the
                      // 'hold' render of the settle: nothing may animate, see
                      // the layout effect above.
                      ? 'none'
                      // `transform` gets the settle curve when a drop is gliding
                      // home. During a drag a DOT stepping aside does not animate
                      // at all — it jumps while veiled (see veiledRef) — and a
                      // wide neighbour slides on the fast-deceleration curve; a
                      // hover scales on the same curve. Never an overshoot: a
                      // release must not spring.
                      : `transform ${settle?.deltas.has(s.id) ? 'var(--dur-hover) var(--ease-settle)' : (dragging || settle !== null) && isDot ? '0s' : 'var(--dur-hover) var(--ease-out)'}, border-color var(--dur-hover) var(--ease-reveal), background-color var(--dur-hover) var(--ease-reveal), box-shadow var(--dur-hover) var(--ease-reveal), opacity var(--dur-hover) var(--ease-reveal)`,
                  // Four mutually exclusive transform states: the pill in hand
                  // (under the cursor), a dropped pill gliding home, a neighbour
                  // stepping aside, or a plain hover.
                  transform: isBeingDragged
                    ? undefined
                    : settle?.deltas.has(s.id)
                      ? `translateX(${settle.phase === 'hold' ? settle.deltas.get(s.id) : 0}px)`
                      : dragging && isDot
                        // `--flow` is the shrink of the dot flowing around the
                        // pill in hand (rAF loop); React never sets it.
                        ? `translateX(${dragOffsets.get(s.id) ?? 0}px) scale(var(--flow, 1))`
                        : dragOffsets.has(s.id)
                          ? `translateX(${dragOffsets.get(s.id)}px)`
                          : settle !== null && isDot
                            // Through the settle too: at the drop the dots kept
                            // `--flow` but lost the transform that applied it, so
                            // a half-shrunk dot popped to full size under the
                            // gliding pill while its ghost was still shrinking
                            // (probed 2026-09-03, R9: 10px of contact at release).
                            ? 'scale(var(--flow, 1))'
                            : (isHovered && !isActive) ? 'scale(1.02)' : undefined,
                  transformOrigin: (dragging || settle !== null) && isDot ? 'var(--flow-origin, center)' : undefined,
                  // The 3px focus outline (globals.css) reads as a bright ring
                  // around the thing you are dragging. Suppressed in hand.
                  zIndex: settle?.heldId === s.id ? 10 : undefined,
                  // The dropped pill keeps the twin's lift while it glides home,
                  // then the shadow eases into the active glow — no pop at the
                  // handoff from twin to real pill.
                  boxShadow: settle?.heldId === s.id
                    ? '0 8px 20px rgba(0,0,0,0.35)'
                    : (!forceSingle && isActive) ? GLOW_SHADOW[color] : undefined,
                  cursor: 'default',
                }}
                onTransitionEnd={settle?.heldId === s.id ? () => setSettle(null) : undefined}
              >
                {pillBody}
              </button>
              </Tooltip>
              {isBeingDragged && dragLeft !== null && (
                // The twin: the pill in hand, drawn at the cursor. NO transition
                // on its position — a 150ms ease there made the pill trail the
                // pointer like it was on a rubber band. pointer-events off so
                // the pointerup lands on the bar that holds capture.
                <div
                  aria-hidden
                  className={`${pillClass} shrink-0 cursor-grabbing`}
                  style={{
                    // Mount-only (see twinMount): the rAF loop owns both after.
                    width: (twinMount.current ??= { left: dragLeft, width: pillElement(s.id)?.getBoundingClientRect().width }).width,
                    position: 'absolute',
                    left: twinMount.current.left,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    zIndex: 10,
                    pointerEvents: 'none',
                    boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
                    transition: 'box-shadow var(--dur-hover) var(--ease-reveal)',
                    // Below the row ('html-drag') the carried ghost is the
                    // pill in hand; the twin waits, unseen, in the row.
                    visibility: carried ? 'hidden' : undefined,
                  }}
                >
                  {pillBody}
                </div>
              )}
              {isBeingDragged && carried && createPortal(
                // The carried ghost: the pill in hand once it has left the row
                // ('html-drag'). Positioned by placeCarried, straight to the
                // DOM, per dragover. Nothing may click through to it.
                <div
                  ref={carriedEl}
                  aria-hidden
                  className={`${pillClass} border-edge bg-panel cursor-grabbing`}
                  style={{
                    position: 'fixed',
                    left: 0,
                    top: 0,
                    transform: `translate(${carriedPos.current.x - grabOffsetInPill.current.x}px, ${carriedPos.current.y - grabOffsetInPill.current.y}px)`,
                    zIndex: 9999,
                    pointerEvents: 'none',
                    boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <SessionDot color={color} isActive={isActive} />
                  <span className="session-pill__label text-xs font-medium text-fg-2 px-0.5">{s.name}</span>
                </div>,
                document.body,
              )}
            </React.Fragment>
          );
        })}
        {renameId && <SessionRenameDialog id={renameId} name={sessions.find((s) => s.id === renameId)?.name ?? 'Untitled session'} onClose={() => setRenameId(null)} />}
        {skipPermissionsDialog}
        {smallModelDialog}
        {pillMenu && (
          <ContextMenu x={pillMenu.x} y={pillMenu.y} entries={pillMenuEntries} onClose={() => setPillMenu(null)} />
        )}
        {/* END of the per-pill map — everything below is the strip's tail. */}
        {/* Overflow count: sessions open in this window that the strip couldn't fit.
            Purely an indicator — clicking the trigger (or this badge) opens the full list. */}
        {sessions.length - visibleSessions.length > 0 && (
          <Tooltip text={`${sessions.length - visibleSessions.length} more session${sessions.length - visibleSessions.length === 1 ? '' : 's'}`}>
          <button
            onClick={handleMenuToggle}
            className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 ml-1 rounded-full bg-inset text-fg-2 text-3xs font-semibold leading-none hover:bg-well transition-colors"
            aria-label={`${sessions.length - visibleSessions.length} more sessions`}
          >
            +{sessions.length - visibleSessions.length}
          </button>
          </Tooltip>
        )}

        {/* ── Dropdown trigger ───────────────────────────── */}
        <div ref={menuRef}>
          <Tooltip text="All Sessions">
          <button
            ref={triggerBtnRef}
            onClick={handleMenuToggle}
            className="flex items-center justify-center w-5 h-5 ml-1 rounded-sm hover:bg-inset transition-colors text-fg-muted hover:text-fg-2"
          >
            <svg className={`w-3 h-3 transition-transform ${menuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          </Tooltip>
        </div>
      </div>

      {/* ── Dropdown menu (portal — escapes overflow-hidden + backdrop-filter) ── */}
      {menuOpen && createPortal(
        <div
          ref={dropdownRef}
          // P-8 (2026-08-28): w-72 (288px) was too narrow for a session name and
          // its project side by side. 24rem retains that two-line row at a more
          // compact desktop width, while the 88vw ceiling keeps it inside a phone.
          className="glass-overlay overlay-no-drag fixed flex flex-col w-[min(24rem,88vw)] bg-panel border border-edge rounded-lg shadow-lg z-[9000] overflow-hidden"
          style={(() => {
            const triggerRect = triggerBtnRef.current?.getBoundingClientRect();
            const pillRect = pillBarRef.current?.getBoundingClientRect();
            const pillCenter = pillRect
              ? pillRect.left + pillRect.width / 2
              : undefined;
            // Half the rendered width, which is min(384px, 88vw) — the clamp below
            // keeps the menu on screen, so it has to track the real width.
            const halfDropdown = Math.min(384, window.innerWidth * 0.88) / 2;
            // WHY: a fixed 432px session list let its rows plus the New Session
            // form run below short windows. Cap the complete menu at the space
            // below its trigger; the list is the flexing, scrollable portion.
            const belowTrigger = triggerRect
              ? `calc(100vh - ${triggerRect.bottom + 8}px - var(--vvp-offset, 0px))`
              : 'calc(100vh - 8px - var(--vvp-offset, 0px))';
            // Compute left-edge directly (no transform: translateX(-50%))
            // so backdrop-filter isn't broken by a persistent transform
            return {
              top: triggerRect ? triggerRect.bottom + 4 : 0,
              // Keep the menu content-sized so the form footer follows the
              // Create button. The form reads this cap and becomes its own
              // scroll region only when the available viewport is too short.
              height: undefined,
              maxHeight: `min(680px, ${belowTrigger})`,
              '--session-menu-available-height': `min(680px, ${belowTrigger})`,
              left: pillCenter != null
                ? Math.min(Math.max(0, pillCenter - halfDropdown), window.innerWidth - halfDropdown * 2)
                : `calc(50% - ${halfDropdown}px)`,
              animation: 'dropdown-in 120ms var(--ease-out) both',
            };
          })()}
        >
          {/* Android only ever has one window, so the "in this window" scoping label is meaningless there */}
          {sessions.length > 0 && !isAndroid() && (
            <>
              <div className="px-3 pt-1.5 text-3xs font-medium text-fg-muted tracking-wider uppercase">
                Sessions in this window
              </div>
            </>
          )}
          {/* WHY: This is the menu's flexible middle. With the menu capped to
              the available screen height above, it shrinks first (roughly five
              rows on short windows) and scrolls before its New Session controls
              can be pushed past the bottom edge. */}
          {sessions.length > 0 && (
            <div
              ref={sessionListRef}
              className="scroll-fade flex-1"
              // WHY (2026-09-07, Destin): lets a "sessions in other windows" row be
              // dragged straight back into this window's list — reuses the same
              // dragAdopt() main already uses for the header pill bar's cross-window
              // drop, just triggered by a plain in-page drag confined to this
              // dropdown instead of an OS-level drag. Separate from the pointer-based
              // reorder system above (session-strip-motion.md) — deliberately not
              // touching that fragile, heavily-reviewed code path. Background stays
              // inline (not a class) so this div's className keeps matching the
              // literal string menu-row-reachability.test.ts pins.
              style={{
                maxHeight: 'min(432px, 55vh)',
                background: peerDropActive ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined,
              }}
              onDragOver={(e) => {
                if (!dragCarriesSession(e.dataTransfer)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // A row from THIS list is a reorder — the rows draw their own
                // insertion line, and lighting the whole list as a drop target
                // would say "adopt", which is the wrong promise. WHY we read
                // state instead of the drag's payload: dataTransfer.getData is
                // deliberately blank during dragover (only `types` is legible),
                // so which session is in hand is knowable only from the
                // dragstart that set it — and that is always this window's.
                if (menuDragId) return;
                if (!peerDropActive) setPeerDropActive(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setPeerDropActive(false);
                  setMenuDropIndex(null);
                }
              }}
              onDrop={(e) => {
                const sessionId = readSessionDrag(e.dataTransfer);
                if (!sessionId) return;
                e.preventDefault();
                const insertAt = menuDropIndex;
                setPeerDropActive(false);
                setMenuDropIndex(null);
                setMenuDragId(null);
                // Ownership decides the route, read from the dropped payload
                // rather than the in-flight state: a session already in this
                // list is a reorder, anything else came from another window
                // and is an adoption.
                const from = sessions.findIndex((x) => x.id === sessionId);
                if (from < 0) {
                  (window as any).claude?.detach?.dragAdopt?.({ sessionId });
                  return;
                }
                if (insertAt === null || !onReorderSessions) return;
                // insertAt is a slot in the list AS SHOWN; onReorderSessions
                // splices the row out first, so a slot after the row's own
                // position shifts down by one. Both slots either side of the
                // row it came from are where it already is.
                const to = insertAt > from ? insertAt - 1 : insertAt;
                if (to !== from) onReorderSessions(from, to);
              }}
            >
              <div className="py-1">
              {sessions.map((s, idx) => {
                const color = sessionStatuses?.get(s.id) || 'gray';
                const isBeingDragged = dragId === s.id && dragActive;   // see dragActive
                return (
                  <div
                    key={s.id}
                    data-session-idx={idx}
                    data-session-id={s.id}
                    ref={shiftNavIdx === idx ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                    onPointerDown={(e) => handlePointerDown(e, s.id)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    // Half a row decides the slot: above the midline the row in
                    // hand lands before this one, below it lands after. Only
                    // while a row from THIS list is in hand — a peer window's
                    // row is an adoption, which has no position to choose.
                    onDragOver={(e) => {
                      if (!menuDragId || !dragCarriesSession(e.dataTransfer)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      const r = e.currentTarget.getBoundingClientRect();
                      setMenuDropIndex(e.clientY < r.top + r.height / 2 ? idx : idx + 1);
                    }}
                    className={`relative flex items-center pr-1 group/row select-none touch-none ${
                      menuDragId === s.id ? 'opacity-40 ' : ''
                    }${
                      shiftNavIdx === idx
                        ? 'bg-accent/20 text-fg'
                        : s.id === activeSessionId
                          ? 'bg-inset text-fg'
                          : 'text-fg-dim hover:bg-inset hover:text-fg'
                    } ${isBeingDragged ? 'opacity-30' : ''}`}
                    style={{
                      animation: `row-fade-in 100ms ease both`,
                      animationDelay: `${idx * 20}ms`,
                      // steps(4) inline, not via the .stepped-hover utility: an
                      // inline transition cannot be overridden by a stylesheet
                      // rule without !important. Users scan this list top-to-
                      // bottom to pick a session, so every row's fade fires in
                      // one sweep, inside a .glass-overlay backdrop-filter.
                      transition: 'opacity 150ms steps(4), background 150ms steps(4)',
                      cursor: 'default',
                    }}
                  >
                    {/* Where the row in hand will land. Drawn on the row above
                        the slot, or under the last row for the final slot, so
                        the line sits between rows without a spacer element of
                        its own perturbing the list's layout mid-drag. */}
                    {menuDragId && menuDropIndex === idx && (
                      <span className="absolute left-0 right-0 top-0 h-[2px] bg-accent rounded-full pointer-events-none" />
                    )}
                    {menuDragId && menuDropIndex === idx + 1 && idx === sessions.length - 1 && (
                      <span className="absolute left-0 right-0 bottom-0 h-[2px] bg-accent rounded-full pointer-events-none" />
                    )}
                    {/* Drag grip — visible on hover, and the handle itself: it
                        is the native draggable, so the browser owns the gesture
                        (handlePointerDown steps aside for it by the data
                        attribute). Hidden on Android, which has no drag. */}
                    <span
                      data-menu-drag-grip
                      draggable={!isAndroid()}
                      onDragStart={(e) => {
                        writeSessionDrag(e.dataTransfer, s.id);
                        e.dataTransfer.effectAllowed = 'move';
                        // Drag the whole row, not the ten-pixel grip: the grip
                        // alone gives the cursor nothing to aim a list slot with.
                        const row = e.currentTarget.closest('[data-session-id]') as HTMLElement | null;
                        const r = row?.getBoundingClientRect();
                        if (row && r) { try { e.dataTransfer.setDragImage(row, e.clientX - r.left, e.clientY - r.top); } catch { /* no picture, drag still works */ } }
                        setMenuDragId(s.id);
                      }}
                      onDragEnd={endMenuDrag}
                      className={`shrink-0 flex items-center pl-1.5 transition-opacity ${isAndroid() ? 'hidden' : 'opacity-0 group-hover/row:opacity-100 cursor-grab active:cursor-grabbing'}`}
                    >
                      <DragGrip />
                    </span>
                    {/* A <div role="button"> rather than a <button>, for the
                        same reason SkillCard's root is one: the rename pencil
                        below is a real <button> and must not be nested inside
                        another. Clicking the row — the name included — still
                        selects the session; only the pencil does anything else.
                        Keyboard parity is the onKeyDown, which a native button
                        gave for free. */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={s.name}
                      onClick={() => { if (!suppressClick.current) { onSelectSession(s.id); setMenuOpen(false); } }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        // Space scrolls the menu otherwise, and Enter would
                        // fall through to whatever else is listening.
                        e.preventDefault();
                        if (!suppressClick.current) { onSelectSession(s.id); setMenuOpen(false); }
                      }}
                      className="flex-1 text-left pl-1 pr-1.5 py-1.5 flex items-center min-w-0 cursor-pointer"
                    >
                      {/* P-8 (2026-08-28): name and project start at the SAME left
                          edge, one under the other; what used to be a bare dot at
                          the left is now the named status pill at the right of the
                          name, with the session's tag marks under it. */}
                      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                        <span className="flex items-center gap-2 min-w-0">
                          {/* The pencil sits with the name, not at the row's
                              right edge (deck session-switcher-rename, SR-3:
                              "pencil only"). Same icon and same meaning as the
                              saved-conversation list, minus its dotted
                              underline — here the name itself must stay a
                              switch-to-this-session target, which is the whole
                              reason the underline treatment was not chosen. */}
                          <span className="flex-1 min-w-0 flex items-center gap-1.5">
                            <span className="min-w-0 truncate"><SessionName name={s.name} /></span>
                            {namingApi() && (
                              <button
                                type="button"
                                aria-label={`Rename ${s.name}`}
                                aria-haspopup="dialog"
                                className="shrink-0 text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
                                // The row is the drag source; without this a
                                // press on the pencil starts dragging the
                                // session instead of arming the click.
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setRenameId(s.id); }}
                              >
                                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                </svg>
                              </button>
                            )}
                          </span>
                          {s.permissionMode === 'bypass' && (
                            <span className="shrink-0 text-4xs font-medium px-1 py-0.5 rounded-sm bg-[#DD4444]/20 text-[#DD4444]">
                              DANGER
                            </span>
                          )}
                          <StatusPill color={color} isActive={s.id === activeSessionId} />
                        </span>
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="flex-1 min-w-0 flex items-center gap-1 text-3xs text-fg-muted">
                            <FolderMark className="w-3 h-3 shrink-0 text-fg-faint" />
                            <span className="truncate">{s.cwd.replace(/\\/g, '/').split('/').pop()}</span>
                          </span>
                          {/* What runs this session, and on what — "Claude Code ·
                              Sonnet", "YouCoded Coder · DeepSeek R1" — with the
                              brand mark the status bar's model chip uses. This
                              replaced the pill's "YouCoded · Coder" badge on
                              2026-09-02 (Destin: it "still cause[d] a bit of
                              visual jank"); the row is read at rest and has the
                              room. The mark carries the brand colour; the text
                              stays muted like the folder beside it, so the row's
                              second line reads as one line of metadata. Capped
                              so a long local model name never pushes the folder
                              out. */}
                          {(() => {
                            const rt = sessionRuntimeLabel(s);
                            return (
                              <Tooltip text={rt.text}>
                              <span
                                className="shrink-0 min-w-0 max-w-[55%] flex items-center gap-1 text-3xs text-fg-muted"
                              >
                                {rt.icon && (
                                  <span className="shrink-0 flex items-center" style={{ color: rt.color }}>
                                    <ProviderIcon icon={rt.icon} size={10} />
                                  </span>
                                )}
                                <span className="truncate">{rt.text}</span>
                              </span>
                              </Tooltip>
                            );
                          })()}
                          <SessionTagMarks sessionId={s.id} byId={tagsById} />
                        </span>
                      </span>
                    </div>
                    <Tooltip text="Close Session">
                    <button
                      // Close the dropdown so the CloseSessionPrompt (L2 popup)
                      // isn't competing with the still-open session menu above it.
                      onClick={(e) => { e.stopPropagation(); if (!suppressClick.current) { setMenuOpen(false); onCloseSession(s.id, s.name); } }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="shrink-0 w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-[#DD4444] hover:bg-inset opacity-0 group-hover/row:opacity-100 transition-opacity"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                    </Tooltip>
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {/* Sessions in other windows — only shown when the detach subsystem
              reports peer windows owning sessions. Selecting one tells main
              to focus that window and switch its active session. */}
          {(() => {
            // Defensive: a partial windowDirectory payload (missing `sessions`
            // on a peer window entry) must not crash SessionStrip — it lives
            // in the main App tree above the Game ErrorBoundary, so a throw
            // falls through to RootErrorBoundary and wipes chat state.
            const remoteGroups = (windowDirectory?.windows ?? [])
              .filter((w) => w.window.id !== myWindowId)
              .map((w) => ({
                label: w.window.label,
                windowId: w.window.id,
                sessions: w.sessions ?? [],
              }))
              .filter((g) => g.sessions.length > 0);
            if (remoteGroups.length === 0) return null;
            // WHY (2026-09-07, Destin): rows here used to be a flat button with a
            // bare dot — visually a different UI from "sessions in this window"
            // right above it. This mirrors that section's card markup (background,
            // folder subtitle, status pill, runtime line, tags) so the two read as
            // one list. The click target and the trailing "→ window" tag still
            // differ; the drag grip and close button are real here too — drag
            // adopts the session into this window (native HTML5 drag, dropped on
            // the "this window" list above), close destroys it outright (main's
            // session:destroy already takes any session id regardless of which
            // window owns it — no new IPC needed for either).
            let remoteIdx = 0;
            return (
              <>
                <div className="border-t border-edge" />
                <div className="px-3 pt-1.5 text-3xs font-medium text-fg-muted tracking-wider uppercase">
                  Sessions in other windows
                </div>
                {/* WHY: Peer windows can hold an unbounded number of sessions.
                    Keep this group inside the same scrolling middle as local
                    sessions, so it cannot hide the New Session actions below. */}
                <div className="scroll-fade flex-1 py-1">
                  {remoteGroups.flatMap((g) =>
                    g.sessions.map((s) => {
                      const color = sessionStatuses?.get(s.id) || 'gray';
                      const idx = remoteIdx++;
                      return (
                        <div
                          key={s.id}
                          draggable
                          onDragStart={(e) => {
                            writeSessionDrag(e.dataTransfer, s.id);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          // A drag abandoned outside any drop target still has
                          // to put the list's highlight back.
                          onDragEnd={endMenuDrag}
                          className="relative flex items-center pr-1 group/row select-none touch-none text-fg-dim hover:bg-inset hover:text-fg"
                          style={{
                            animation: `row-fade-in 100ms ease both`,
                            animationDelay: `${idx * 20}ms`,
                            transition: 'opacity 150ms steps(4), background 150ms steps(4)',
                          }}
                        >
                          {/* Drag grip — visible on hover. Drag this row onto the
                              "sessions in this window" list above to claim it. */}
                          <span className="shrink-0 flex items-center pl-1.5 transition-opacity opacity-0 group-hover/row:opacity-100 cursor-grab">
                            <DragGrip />
                          </span>
                          <button
                            onClick={() => {
                              (window as any).claude?.detach?.focusAndSwitch?.({ windowId: g.windowId, sessionId: s.id });
                              setMenuOpen(false);
                            }}
                            className="flex-1 text-left pl-1 pr-1.5 py-1.5 flex items-center min-w-0"
                          >
                            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                              <span className="flex items-center gap-2 min-w-0">
                                <span className="flex-1 min-w-0"><SessionName name={s.name} /></span>
                                {s.permissionMode === 'bypass' && (
                                  <span className="shrink-0 text-4xs font-medium px-1 py-0.5 rounded-sm bg-[#DD4444]/20 text-[#DD4444]">
                                    DANGER
                                  </span>
                                )}
                                <StatusPill color={color} isActive={false} />
                              </span>
                              <span className="flex items-center gap-2 min-w-0">
                                <span className="flex-1 min-w-0 flex items-center gap-1 text-3xs text-fg-muted">
                                  <FolderMark className="w-3 h-3 shrink-0 text-fg-faint" />
                                  <span className="truncate">{s.cwd.replace(/\\/g, '/').split('/').pop()}</span>
                                </span>
                                {(() => {
                                  const rt = sessionRuntimeLabel(s);
                                  return (
                                    <Tooltip text={rt.text}>
                                    <span
                                      className="shrink-0 min-w-0 max-w-[35%] flex items-center gap-1 text-3xs text-fg-muted"
                                    >
                                      {rt.icon && (
                                        <span className="shrink-0 flex items-center" style={{ color: rt.color }}>
                                          <ProviderIcon icon={rt.icon} size={10} />
                                        </span>
                                      )}
                                      <span className="truncate">{rt.text}</span>
                                    </span>
                                    </Tooltip>
                                  );
                                })()}
                                <SessionTagMarks sessionId={s.id} byId={tagsById} />
                                <span className="ml-auto shrink-0 text-3xs text-fg-muted whitespace-nowrap flex items-center gap-1">
                                  <span>→</span>
                                  <span>{g.label}</span>
                                </span>
                              </span>
                            </span>
                          </button>
                          <Tooltip text="Close Session">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpen(false);
                              onCloseSession(s.id, s.name);
                            }}
                            className="shrink-0 w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-[#DD4444] hover:bg-inset opacity-0 group-hover/row:opacity-100 transition-opacity"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                          </Tooltip>
                        </div>
                      );
                    }),
                  )}
                </div>
              </>
            );
          })()}

          <div className="border-t border-edge" />

          {showNewForm ? (
            <div
              className="p-3 flex-1 min-h-0 flex flex-col gap-2 rounded-b-lg overflow-y-auto scroll-fade"
              style={{ maxHeight: 'var(--session-menu-available-height)' }}
            >
              {/* WHY: The creation form is another long list inside the capped
                  dropdown, so this container must shrink and scroll before its
                  Model, permissions, and Create controls reach the bottom edge. */}
              <div>
                <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Project Folder</label>
                <FolderSwitcher
                  value={newCwd}
                  onChange={setNewCwd}
                  // "Manage projects…" bridges to Project View (same action as
                  // the header button) and closes the session menu behind it.
                  onManageProjects={() => { setMenuOpen(false); artifactDispatch({ type: 'PROJECT_VIEW_OPENED' }); }}
                />
              </div>
              {/* ONE model list. Replaces the Runtime toggle + the provider and
                  model <Select> pair + this form's Claude alias row. The runtime
                  is DERIVED from the pick (see applyModelChoice), so the user
                  answers "which model?" instead of decoding "Runtime" first. */}
              <div>
                <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Model</label>
                <ModelPicker
                  value={modelChoice}
                  onSelect={applyModelChoice}
                  onManageModels={() => {
                    setMenuOpen(false);
                    window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'));
                  }}
                />
              </div>
              {/* Native-only extras that are NOT model selection. They appear
                  because a native model was picked, not because a runtime was
                  declared. */}
              {runtime === 'native' && nb.nativeSupported && (
                <NativeExtras nb={nb} preset={preset} onPreset={setPreset} />
              )}
              {/* Skip Permissions is CLAUDE-CODE ONLY. It works by starting the
                  CLI with permissions bypassed, and a native session has no PTY
                  and no CC permission flow for it to affect — so on a native
                  model the control did nothing at all. The Resume Browser
                  already gated it per row; this is the create-time half.
                  Gated on the DERIVED runtime, so it appears and disappears as
                  the model choice changes. */}
              {runtime !== 'native' && (
                <>
                  <div className="flex items-center justify-between">
                    <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase inline-flex items-center">
                      Skip Permissions
                      <SkipPermissionsInfoTooltip />
                    </label>
                    {/* Shared Toggle (change 15). The "danger" tone replaces the raw
                        #DD4444 hex, so community themes can restyle it. aria-label
                        added — the neighbouring <label> was never wired to the
                        control, so it announced as an unnamed button. */}
                    <Toggle
                      checked={dangerous}
                      // Turning ON goes through the first-time warning; Cancel
                      // there leaves it off. Turning off never asks.
                      onChange={(next) => (next ? gateSkipPermissions(() => setDangerous(true)) : setDangerous(false))}
                      tone="danger"
                      aria-label="Skip Permissions"
                    />
                  </div>
                  {/* Warning text was a raw text-[#DD4444] hex. Change 17 moves it onto
                      the same token as the toggle beside it, so a community theme
                      restyling its red doesn't leave the two out of sync. */}
                  {dangerous && (
                    <SkipPermissionsCaption />
                  )}
                </>
              )}
              {/* Launch in new window — hidden on platforms without multi-window support */}
              {detachAvailable && (
                <div className="flex items-center justify-between">
                  <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Launch in New Window</label>
                  {/* Shared Toggle (change 15) — same accent on-state as before. */}
                  <Toggle
                    checked={launchInNewWindow}
                    onChange={setLaunchInNewWindow}
                    aria-label="Launch in New Window"
                  />
                </div>
              )}
              {/* Skip-permissions sessions get the FILLED danger variant (spec §11,
                  change 62 — Destin's call). Known and accepted consequence: this now
                  looks identical to "Remove project". Filled red in this app means
                  "stop and read this", not strictly "this destroys something"; the
                  outline variant is the confirm-y tier. Don't downgrade this to
                  danger-outline for consistency — that was considered and rejected.
                  Was raw bg-[#DD4444]/[#E55555] + text-white; the token pair carries
                  an engine-derived label color so a pale community red can't go
                  white-on-pink. The non-dangerous branch also gains a real hover
                  (it was hover:bg-accent over bg-accent — inert; change 75). */}
              <Button
                variant={dangerous && runtime !== 'native' ? 'danger' : 'primary'}
                size="lg"
                onClick={handleCreate}
                disabled={nb.nativeCreateBlocked}
                className="w-full py-1.5"
              >
                {dangerous && runtime !== 'native' ? 'Create (Dangerous)' : 'Create Session'}
              </Button>
            </div>
          ) : (
            <div className="flex rounded-b-lg overflow-hidden">
              <button
                onClick={() => { setMenuOpen(false); onOpenResumeBrowser(); }}
                className="flex-1 px-3 py-2 text-sm text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>Resume</span>
              </button>
              {/* Gradient divider */}
              <div className="w-px my-0.5" style={{ background: 'linear-gradient(to bottom, transparent, var(--fg-faint), transparent)' }} />
              <button
                onClick={() => {
                  setNewCwd(defaultProjectFolder || '');
                  setDangerous(defaultSkipPermissions || false);
                  setNewModel(defaultModel || 'sonnet');
                  // The saved default, whatever provider it names — through the
                  // picker's own setter, which moves the engine with it.
                  if (defaultStartModel) applyModelChoice(defaultStartModel);
                  // usePreset re-arms the heuristic itself on the showNewForm
                  // false→true edge — no manual touched reset needed here.
                  setShowNewForm(true);
                }}
                className="flex-1 px-3 py-2 text-sm text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                <span className="text-base leading-none">+</span>
                <span>New Session</span>
              </button>
            </div>
          )}
        </div>,
        document.getElementById('root')! // Portal to #root (not body) so
        // backdrop-filter can sample the compositing tree for live content blur
      )}

    </>
  );
}
