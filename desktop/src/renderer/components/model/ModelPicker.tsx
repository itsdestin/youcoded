import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, fieldClasses, Tooltip } from '../ui';
import { SearchFilterPill } from '../ui/SearchFilterPill';
import { POPOVER_Z } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import type { PortableModelRef } from '../../../shared/types';

// ONE model list, used everywhere a model gets chosen. Replaces four shapes for
// the same question: the alias button row in both new-session forms,
// RuntimeBinding's Provider+Model <Select> pair, the deleted NativeModelSelect's grouped
// list, and ModelPickerPopup's own native branch.
//
// The runtime is DERIVED from the pick, not chosen first. Picking a Claude Code
// row gives a `claude` session; picking a provider row gives a `native` one.
// "Runtime" was jargon the user had to decode before answering the question they
// actually had, which is "which model?".
//
// Three shape decisions, all Destin's (2026-07-30):
//   1. The panel is anchored BELOW the trigger and horizontally centred on it
//      — not viewport-centred, which detached it from the field it belongs to.
//   2. It shows ONLY favourites until the user types. The full catalogue is a
//      search result, never a wall to scroll — an OpenRouter-class provider is
//      dozens of models and nobody browses that list twice.
//   3. NO provider sections. Each row names its own source inline
//      ("GPT-5 · OpenRouter"), so one flat list works at any length.
//
// Deliberately NO capability badges. The CC/native gap is real today but the
// Native Runtime Parity Program's standing rule is "full parity is the end
// state; build real features, no interim 'not available yet' shims".

import { CLAUDE_ALIASES, type ClaudeAlias } from '../../../shared/model-ids';
import { matchesQuery } from '../../../shared/text-match';
import { resolveModelBrand, type ProviderIconKey } from '../provider-brand';
import { ProviderIcon } from '../ProviderIcon';
import { unavailableReason, useClaudeStatus, type CatalogRow, type ProviderRow } from './availability';

export type ModelChoice =
  | { runtime: 'claude'; alias: string }
  | { runtime: 'native'; providerId: string; modelId: string };

/** Labels for the shared alias list. The ALIASES are canonical in
 *  shared/model-ids.ts (StatusBar derives from the same place); only the
 *  display labels are picker-local. Labels are model-class only, by design. */
const CLAUDE_LABELS: Record<ClaudeAlias, string> = {
  haiku: 'Haiku', sonnet: 'Sonnet', 'opus[1m]': 'Opus', fable: 'Fable',
};
const CLAUDE_MODELS = CLAUDE_ALIASES.map((alias) => ({ alias, label: CLAUDE_LABELS[alias] }));

const CLAUDE_SOURCE = 'claude';

/** How much brand COLOUR the list carries. The company mark is always drawn in
 *  full colour at every level — the variable is how far the colour spreads into
 *  the text.
 *    'mark'  — marks only; every model name stays neutral.
 *    'current' — marks everywhere + the CURRENT model's name is brand-coloured
 *                on the closed button, matching the status-bar chip. (default)
 *    'all'   — marks everywhere + every row's name is brand-coloured.
 *  Review deck 2026-08-31 captures all three; the loser gets deleted. */

interface Entry {
  key: string;
  label: string;
  choice: ModelChoice;
  sourceId: string;      // 'claude' or a providerId — the filter dimension
  sourceLabel: string;   // rendered inline after the divider dot
  local: boolean;        // local-engine models, for the "runs on this device" filter
  /** Provider type ('anthropic' | 'openai' | 'local-engine' | …). Only used as
   *  the brand matcher's fallback when the model id itself names no company —
   *  e.g. a direct Anthropic key serving an id we don't recognise. */
  providerType?: string;
  /** Why this row cannot be picked right now ("Sign in to use", "Add an API
   *  key"). Set means the row is listed, greyed and inert — Destin, 2026-09-07
   *  (Q-E a): a model this install cannot run is still worth SEEING, so the
   *  list stops pretending the rest of the app does not exist. */
  unavailable?: string;
}

/** Which company mark + colour a row carries.
 *
 *  Claude Code rows are pinned to the CC mascot and Claude orange rather than
 *  going through resolveModelBrand: the alias ("Sonnet") is not a model id, and
 *  the status-bar chip already pins those four to the same mark. Keeping the two
 *  in step is the whole point — a model must not change identity between the
 *  chip and the list you picked it from.
 *
 *  Returns null for anything unrecognised; callers fall back to the neutral
 *  ModelIcon, never to a wrong company's mark. */
function brandForEntry(e: Entry): { icon?: ProviderIconKey; color: string } | null {
  if (e.choice.runtime === 'claude') {
    return { icon: 'claudecode', color: 'var(--brand-claude)' };
  }
  const brand = resolveModelBrand(e.choice.modelId, e.providerType);
  return brand ? { icon: brand.icon, color: brand.color } : null;
}

function choiceKey(c: ModelChoice): string {
  return c.runtime === 'claude' ? `claude:${c.alias}` : `${c.providerId}:${c.modelId}`;
}

// ── Favourites ───────────────────────────────────────────────────────────────
// UI-first: there is no favourites backend for models yet. Skills have one
// (SkillConfigStore) and games have `favorites:get`/`favorites:set`, but neither
// covers models, so this persists locally until a real channel exists. That
// channel is the backend to-do this UI generates — and it matters more now that
// favourites are the DEFAULT view: on a fresh device the picker opens empty
// until the user re-stars everything, which is exactly what syncing would fix.
const FAV_KEY = 'youcoded-model-favorites';

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
}

function saveFavorites(next: Set<string>): void {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...next])); } catch { /* storage blocked */ }
}

function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.05 1.1-6.5-4.7-4.6 6.5-.95z" />
    </svg>
  );
}

// The trigger glyph. Deliberately the SAME stacked-layers shape the app uses
// for Settings → Model Providers (ModelProvidersPopup.tsx:60-63) — which is
// exactly where this picker's "Manage models…" footer sends you, so the icon
// and the destination agree. Chosen from five drafts, 2026-07-30.
// Matches the project picker's folder glyph spec (FolderSwitcher.tsx:186):
// 24 viewBox, fill none, strokeWidth 2, rendered w-3 h-3 in the trigger.
export function ModelIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  );
}

// ── Filter popover (FileFilterPopover's chip idiom) ──────────────────────────

function Chip({ active, onClick, children }: {
  active: boolean; onClick(): void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
        active
          ? 'bg-accent text-on-accent'
          : 'bg-inset text-fg-2 hover:text-fg border border-edge hover:border-edge-dim'
      }`}
    >
      {children}
    </button>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">{label}</span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>{children}</div>
    </div>
  );
}

export default function ModelPicker({
  value,
  onSelect,
  includeClaude = true,
  includeNative = true,
  onManageModels,
  prefill,
  defaultOpen = false,
  layout = 'floating',
  pinSelectedToTop = false,
  emptyLabel = 'Choose a model…',
}: {
  value: ModelChoice | null;
  /** What the CLOSED button reads when nothing is picked. Defaults to the
   *  create-time wording. A host where "nothing picked" is itself a meaningful
   *  setting — session naming, where it means the conversation's own model —
   *  says so here rather than printing a prompt for a choice already made. */
  emptyLabel?: string;
  /** The second argument is the label this picker DISPLAYED for the choice —
   *  provider and model as the user just read them. Optional, and every caller
   *  that does not need it simply ignores it. Design review 2 (R2-3): the
   *  Settings row had no way to name a native model and rendered its raw id,
   *  which reads as a filename. The picker is the one place that already knows
   *  the right words. */
  onSelect: (choice: ModelChoice, label?: { provider: string; model: string }) => void;
  /** Scope the list to one runtime. A resume cannot move a conversation across
   *  runtimes — a Claude Code transcript has no native binding to resume into,
   *  and a native conversation has no CC transcript — so that host narrows the
   *  list rather than offering a pick it cannot honour. Both default true,
   *  which is the create-time case. */
  includeClaude?: boolean;
  includeNative?: boolean;
  /** Opens Settings -> Model Providers. Mirrors the project picker's
   *  "Manage projects..." footer (FolderSwitcher.tsx:295); the footer is
   *  omitted entirely on surfaces with nowhere to send the user. */
  onManageModels?: () => void;
  /** Resume-time pre-fill (PastSession.lastUsedModel). Matched against the
   *  LOCAL catalog by modelId + the owning provider's TYPE — a CatalogModel's
   *  providerId is a per-device ULID and cannot be compared across synced
   *  devices. No match leaves the picker un-prefilled: never an error, never a
   *  substitute for the saved model. Carried over verbatim from
   *  NativeModelSelect (now deleted), whose behaviour this replaces in the Resume Browser
   *  (Destin's Task 6 ruling — native resume ALWAYS offers the picker,
   *  pre-filled when the model is available here). */
  prefill?: PortableModelRef;
  /** Starts the panel already expanded — for a host where the picker IS the
   *  surface (ModelPickerPopup's status-bar dialog) rather than one field
   *  among several (SessionStrip, the welcome form, Resume Browser). Defaults
   *  false everywhere else so this doesn't change the six other call sites. */
  defaultOpen?: boolean;
  /** 'floating' (default) portals the open panel to document.body and pins it
   *  to the trigger with fixed positioning — built for a picker sitting among
   *  other fields, where the panel must escape an ancestor's clipping and
   *  overlay whatever is below it. 'inline' instead renders the panel as a
   *  normal child, in flow, so surrounding content is pushed down rather than
   *  covered, and OMITS the collapsed trigger row entirely — there is nothing
   *  to collapse back to, since the panel has no closed state to return to.
   *  Only ModelPickerPopup uses 'inline', always paired with `defaultOpen`:
   *  without a trigger, `defaultOpen` is the only way the panel ever opens. */
  layout?: 'floating' | 'inline';
  /** Pins the current `value` to the TOP of the favourites view, even when it
   *  isn't favourited — so a menu that opens straight to the list (`layout:
   *  'inline'`) shows what's active first, rather than only ever showing
   *  favourites and leaving the current pick to `search` for. No effect while
   *  searching (the whole catalogue is already the result, unordered). */
  pinSelectedToTop?: boolean;
}) {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  // Claude Code's LIVE sign-in (2026-09-09). Unknown and not-yet-answered both
  // count as yes (see useClaudeStatus) — the list must never invent a problem.
  const { status: claudeStatus } = useClaudeStatus();
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const [search, setSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [localOnly, setLocalOnly] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);
  const [freeformFor, setFreeformFor] = useState<string | null>(null);
  const [freeformText, setFreeformText] = useState('');

  // Guards the prefill auto-select so it runs at most once per mount, even if
  // the catalog effect were ever to re-run.
  const prefillAppliedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const filterPopRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  const [filterPos, setFilterPos] = useState<{ top: number; left: number } | null>(null);

  const FILTER_W = 264;

  // Anchor the panel beside its trigger (below where there is room, otherwise
  // above), horizontally centred on it, and clamp into the viewport. It must
  // stay tied to its field rather than appearing as a viewport-centred modal.
  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 320);
    const centred = r.left + r.width / 2 - width / 2;
    const gap = 4;
    const edge = 8;
    const spaceBelow = window.innerHeight - r.bottom - edge;
    const spaceAbove = r.top - edge;
    const opensUpward = spaceBelow < 180 && spaceAbove > spaceBelow;
    setPanelPos({
      // WHY: A New Session menu can put this field near the bottom of a short
      // window. Choose the side with usable room instead of forcing a panel
      // below the field where the viewport clips its search and model rows.
      ...(opensUpward ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap }),
      left: Math.max(edge, Math.min(centred, window.innerWidth - width - edge)),
      width,
      maxHeight: Math.max(180, (opensUpward ? spaceAbove : spaceBelow) - gap),
    });
    // The filter popover is PORTALED too. `.layer-surface` sets
    // `overflow: hidden` (unlayered, globals.css:886) to clip scroll-fades to
    // its rounded corners, so a popover rendered inside the panel gets cut off
    // at the panel edge — which is exactly what happened. Positioning it from
    // the pill's own rect keeps it under the sliders button without depending
    // on the panel's clipping.
    const pill = pillRef.current?.getBoundingClientRect();
    if (pill) {
      setFilterPos({
        top: pill.bottom + 8,
        left: Math.max(8, Math.min(pill.right - FILTER_W, window.innerWidth - FILTER_W - 8)),
      });
    }
  }, []);

  /**
   * Why this list is fetched more than once (Destin, 2026-09-06).
   *
   * He opened this menu, went off and set up a local model, came back to the
   * STILL-OPEN menu, searched for it — and it wasn't there. Closing the menu and
   * opening it again fixed it. The fetch below used to run once, when the picker
   * mounted, and never again, so the list was a snapshot of whatever existed the
   * moment the screen was built.
   *
   * Two things make it catch up now:
   *   · it re-runs when the panel OPENS, for "went away and came back";
   *   · `reload` is bumped when a local model finishes DOWNLOADING, for the case
   *     Destin actually hit, where the panel never closed.
   *
   * The download signal is the app's existing progress push — the one the Local
   * Models screen already listens to. It is deliberately NOT `engine.onModelsChanged`:
   * that channel is declared in the preload and in shared/types.ts but NOTHING in
   * the main process ever sends it (`rg -n "ENGINE_MODELS_CHANGED" src/` finds the
   * declaration and the listener, no sender), and even wired up it only fires while
   * the engine PROCESS is running — which it is not while you are downloading a
   * model, since the engine starts on your first message.
   */
  const [reload, setReload] = useState(0);
  const everLoadedRef = useRef(false);

  useEffect(() => {
    const off = window.claude?.models?.onDownloadProgress?.((p: { state?: string }) => {
      if (p?.state === 'done') setReload((n) => n + 1);
    });
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    // The very first fetch happens while the panel is still closed (the pill has
    // to show the model's name, and a prefill has to resolve). After that, only
    // an open or a finished download is worth re-asking for — closing the panel
    // is not.
    if (everLoadedRef.current && !open) return;
    everLoadedRef.current = true;
    let cancelled = false;
    Promise.all([
      window.claude.providers.list().catch(() => []),
      window.claude.providers.catalog().catch(() => []),
    ]).then(([list, cat]: [any, any]) => {
      if (cancelled) return;
      const providerRows: ProviderRow[] = Array.isArray(list) ? list : [];
      const catalogRows: CatalogRow[] = Array.isArray(cat) ? cat : [];
      setProviders(providerRows);
      setCatalog(catalogRows);
      setLoaded(true);

      if (prefill && !prefillAppliedRef.current && !value) {
        const match = catalogRows.find((m) => {
          const p = providerRows.find((row) => row.id === m.providerId);
          return !!p && p.type === prefill.providerType && m.id === prefill.modelId;
        });
        if (match) {
          prefillAppliedRef.current = true;
          const prov = providerRows.find((row) => row.id === match.providerId);
          onSelect(
            { runtime: 'native', providerId: match.providerId, modelId: match.id },
            { provider: prov?.label ?? match.providerId, model: match.label ?? match.id },
          );
        }
      }
    }).catch(() => setLoaded(true));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reload]);

  // Reset the transient view state on each open so the panel always starts on
  // the favourites view rather than resuming a stale search.
  useEffect(() => {
    if (open) { setSearch(''); setFilterOpen(false); setFreeformFor(null); }
  }, [open]);

  // Layered ESC: close the filter popover first, then the panel.
  useEscClose(open, useCallback(() => {
    if (filterOpen) setFilterOpen(false); else setOpen(false);
  }, [filterOpen]));

  // Keep both portals anchored while open.
  useLayoutEffect(() => { if (open) measure(); }, [open, measure]);
  useLayoutEffect(() => { if (open && filterOpen) measure(); }, [open, filterOpen, measure]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      // The filter popover portals OUT of the panel, so panelRef can't see it —
      // without this check a click on a filter chip closed the whole picker.
      if (filterPopRef.current?.contains(t)) return;
      setOpen(false);
      setFilterOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  const entries: Entry[] = useMemo(() => {
    const out: Entry[] = [];
    const data = { providers, catalog, claudeStatus };
    if (includeClaude) {
      for (const m of CLAUDE_MODELS) {
        const choice: ModelChoice = { runtime: 'claude', alias: m.alias };
        out.push({
          key: choiceKey(choice), label: m.label, choice,
          sourceId: CLAUDE_SOURCE, sourceLabel: 'Claude Code', local: false,
          unavailable: unavailableReason(choice, data) ?? undefined,
        });
      }
    }
    // WHY every provider, not just the ready ones (Destin, 2026-09-07, Q-E a):
    // dropping an unready provider's models hid the app from the person most
    // likely to need it — someone who set up with ChatGPT never learned the
    // other models existed. They are listed, greyed and unpickable, each row
    // carrying the one thing that would unlock it.
    for (const p of includeNative ? providers : []) {
      for (const m of catalog.filter((c) => c.providerId === p.id)) {
        const choice: ModelChoice = { runtime: 'native', providerId: p.id, modelId: m.id };
        out.push({
          key: choiceKey(choice), label: m.label, choice,
          sourceId: p.id, sourceLabel: p.label, local: p.type === 'local-engine',
          providerType: p.type,
          unavailable: unavailableReason(choice, data) ?? undefined,
        });
      }
    }
    return out;
  }, [providers, catalog, includeClaude, includeNative, claudeStatus]);

  /** Nothing on this install can actually start a conversation. Drives the
   *  "You have not set up any model providers." block (P-3). */
  const anyPickable = useMemo(() => entries.some((e) => !e.unavailable), [entries]);

  /** Every provider with rows in the list, ready or not — the filter chips must
   *  be able to reach a greyed source too. */
  const listedProviders = useMemo(
    () => (includeNative ? providers.filter((p) => catalog.some((c) => c.providerId === p.id)) : []),
    [providers, catalog, includeNative],
  );

  const readyProviders = useMemo(
    () => (includeNative ? providers.filter((p) => p.ready) : []),
    [providers, includeNative],
  );

  /** Providers whose catalog is empty and which accept a typed model id
   *  (Ollama, LM Studio, custom endpoints). Dropping them would silently hide a
   *  configured provider, so they get a "type a name" row while searching. */
  const freeformProviders = useMemo(
    () => readyProviders.filter((p) => p.type === 'openai-compatible'
      && !catalog.some((c) => c.providerId === p.id)),
    [readyProviders, catalog],
  );

  const q = search.trim().toLowerCase();
  const searching = q.length > 0;

  // THE view rule: favourites until you type, then the whole catalogue.
  const rows = useMemo(() => {
    const pool = searching ? entries : entries.filter((e) => favorites.has(e.key));
    const filtered = pool.filter((e) => {
      if (localOnly && !e.local) return false;
      if (sources.size && !sources.has(e.sourceId)) return false;
      // Word-by-word, punctuation-insensitive: "gpt 5.6" has to find "GPT-5.6".
      if (!matchesQuery(q, e.label, e.sourceLabel)) return false;
      return true;
    });
    // Pin the active model to the top of the favourites view, even when it
    // isn't favourited — a menu that opens straight to this list (no click to
    // get here first) should lead with what's actually selected, not require
    // typing to find it. Skipped while searching: the whole catalogue is
    // already the result there, and reordering a search result is surprising.
    if (!pinSelectedToTop || searching || !value) return filtered;
    const currentKey = choiceKey(value);
    const idx = filtered.findIndex((e) => e.key === currentKey);
    if (idx > 0) {
      const reordered = filtered.slice();
      const [current] = reordered.splice(idx, 1);
      reordered.unshift(current);
      return reordered;
    }
    if (idx === -1) {
      const hit = entries.find((e) => e.key === currentKey);
      const passesFilters = hit
        && (!localOnly || hit.local)
        && (!sources.size || sources.has(hit.sourceId));
      if (passesFilters) return [hit, ...filtered];
    }
    return filtered;
  }, [entries, favorites, searching, localOnly, sources, q, pinSelectedToTop, value]);

  const toggleFavorite = (key: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      saveFavorites(next);
      return next;
    });
  };

  const activeFilters = (sources.size ? 1 : 0) + (localOnly ? 1 : 0);

  const currentLabel = useMemo(() => {
    if (!value) return emptyLabel;
    const hit = entries.find((e) => e.key === choiceKey(value));
    if (hit) return `${hit.label} · ${hit.sourceLabel}`;
    // A binding whose catalog row hasn't loaded (or a typed freeform id) still
    // needs a truthful label rather than falling back to "Choose a model…".
    return value.runtime === 'claude' ? value.alias : value.modelId;
  }, [value, entries, emptyLabel]);

  const pick = (c: ModelChoice, label?: { provider: string; model: string }) => { onSelect(c, label); setOpen(false); setFilterOpen(false); };

  /** Brand for the CLOSED button. Derived from `value` directly rather than by
   *  looking the row up in `entries`, because the button must stay correct in
   *  the two cases where there is no row: the catalog hasn't loaded yet, and a
   *  freeform id the user typed for a custom endpoint. */
  const currentBrand = useMemo(() => {
    if (!value) return null;
    if (value.runtime === 'claude') return { icon: 'claudecode' as ProviderIconKey, color: 'var(--brand-claude)' };
    const providerType = providers.find((p) => p.id === value.providerId)?.type;
    const b = resolveModelBrand(value.modelId, providerType);
    return b ? { icon: b.icon, color: b.color } : null;
  }, [value, providers]);

  const row = (e: Entry) => {
    const selected = !!value && choiceKey(value) === e.key && !e.unavailable;
    const fav = favorites.has(e.key);
    const brand = brandForEntry(e);
    // On the selected row the accent fill owns the foreground: painting a brand
    // colour on top of it is the one place the mark can genuinely fail contrast,
    // because the accent is theme-authored and unknown to us. `currentColor`
    // inherits text-on-accent, which the theme guarantees against its own accent.
    // Only the MARK carries brand colour; every model name stays in the list's
    // own text colour. Destin, review deck 2026-08-31 (MB-2), choosing between
    // marks-only, marks-plus-current, and every-row-coloured: a list of tinted
    // names reads as decoration rather than meaning.
    const markColor = selected ? undefined : brand?.color;
    return (
      // Two levels now: the OUTER div keeps the row's original left/right
      // margin (px-2, unhighlighted, same on every row) — the accent fill on
      // the whole outer box read as "too far across" once it ate that margin
      // (2026-09-07 feedback). The INNER div is what actually carries the
      // fill, sized to the space between those margins, so it covers the
      // favourite star's column too instead of stopping at the name button.
      <div key={e.key} className="group/model flex items-center px-2">
        <div className={`flex-1 min-w-0 flex items-center gap-1 rounded ${selected ? 'bg-accent' : ''}`}>
          <Tooltip text={e.unavailable ? `${e.label} · ${e.sourceLabel} — ${e.unavailable}` : ''}>
          <button
            type="button"
            // A row this install cannot run is inert, not hidden: nothing is
            // picked on the user's behalf, and nothing fails later because the
            // list offered something that could not start (Q-E a).
            disabled={!!e.unavailable}
            onClick={() => pick(e.choice, { provider: e.sourceLabel, model: e.label })}
            aria-pressed={selected}
            className={`flex-1 min-w-0 text-left text-xs rounded px-2 py-2 transition-colors flex items-center gap-2 ${
              e.unavailable
                ? 'text-fg-faint cursor-default'
                : selected ? 'text-on-accent font-medium' : 'text-fg-2 hover:bg-inset'
            }`}
          >
            {/* The company mark. A fixed-width box whether or not a mark resolves,
                so an unrecognised model's name still lines up with its neighbours'
                instead of hanging one glyph-width to the left. */}
            <span
              className={`w-[13px] shrink-0 inline-flex items-center justify-center ${e.unavailable ? 'opacity-45' : ''}`}
              style={markColor ? { color: markColor } : undefined}
            >
              {brand?.icon
                ? <ProviderIcon icon={brand.icon} size={13} />
                : <ModelIcon className="w-3 h-3 opacity-40" />}
            </span>
            <span className="truncate block min-w-0">
              {e.label}
              {/* Divider dot + source, inline per row — this is what replaced the
                  per-provider sections. One flat list reads the same at 4 models
                  or 400. */}
              <span className={selected ? 'opacity-70' : 'text-fg-muted'}> · {e.sourceLabel}</span>
            </span>
            {/* The one thing that would unlock this row, in its own words. */}
            {e.unavailable && (
              <span className="ml-auto shrink-0 pl-2 text-3xs text-fg-faint">{e.unavailable}</span>
            )}
          </button>
          </Tooltip>
          {/* touch-reveal + coarse-hit: hover-only affordances never resolve on
              the Android WebView (narrow-viewport rule). Selected uses the same
              on-accent colour as the mark/name above, for the same reason:
              painting the ordinary favourite-gold onto the accent fill is the
              one place it can fail contrast, since the accent is theme-authored
              and unknown to us. mr-1 keeps it off the fill's rounded corner,
              mirroring the name button's own left inset (px-2) on the other end. */}
          <Tooltip text={fav ? 'Remove from favourites' : 'Add to favourites'}>
          <button
            type="button"
            onClick={() => toggleFavorite(e.key)}
            aria-pressed={fav}
            aria-label={fav ? `Unfavourite ${e.label}` : `Favourite ${e.label}`}
            className={`shrink-0 w-6 h-6 mr-1 rounded inline-flex items-center justify-center transition-opacity coarse-hit touch-reveal ${
              selected
                ? 'text-on-accent opacity-100'
                : fav
                  ? 'text-accent opacity-100'
                  : 'text-fg-faint opacity-0 group-hover/model:opacity-100 hover:text-fg-2'
            }`}
          >
            <StarGlyph filled={fav} />
          </button>
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <div className="relative">
      {/* Trigger — the project picker's field shape (FolderSwitcher.tsx:181).
          Omitted in 'inline' layout: that panel has no closed state to
          collapse back to, so a row that only echoes `value` and toggles
          `open` (to no visible effect worth keeping) is redundant with the
          selected row already highlighted in the list below. */}
      {layout !== 'inline' && (
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        // The <label> hosts render above this trigger is not associated with it
        // (no htmlFor), so without this the control announced only its current
        // value and never its purpose — the same defect the Provider/Model
        // Selects carried before change 21.
        aria-label="Model"
        // `bg-well border-edge` overrides the shared FIELD surface (`bg-inset`
        // + `border-edge-dim`) at this ONE call site. field.ts calls the
        // collision out by name: "inputs on bg-inset cards now sit closer to
        // their background than before… the alternative (bg-well inside inset
        // cards) was offered during review and not taken." Every host of this
        // picker is exactly that case — the Resume Browser's expanded pane sits
        // on a `bg-inset` card, so the trigger was the same fill as the surface
        // behind it and read as a label rather than a control (reported
        // 2026-07-31 with a screenshot). One step deeper on the surface ladder
        // fixes it without disturbing the other ~25 fields.
        className={fieldClasses('sm', 'w-full text-left truncate flex items-center gap-1.5 justify-between bg-well border-edge')}
      >
        {/* The current model's company mark, in its brand colour — the same
            pairing the status-bar chip shows, so the control you set it from and
            the chip that reports it read as the same thing. Falls back to the
            neutral stacked-layers glyph when nothing is picked or the company
            isn't recognised. */}
        <span className="w-3 h-3 shrink-0 inline-flex items-center justify-center" style={currentBrand ? { color: currentBrand.color } : undefined}>
          {currentBrand?.icon
            ? <ProviderIcon icon={currentBrand.icon} size={12} />
            : <ModelIcon className="w-3 h-3 text-fg-muted" />}
        </span>
        <span className={`flex-1 truncate ${value ? '' : 'text-fg-muted'}`}>{currentLabel}</span>
        <svg className={`w-3 h-3 shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      )}

      {open && (() => {
        // Shared between both layouts — see the `layout` prop doc above for
        // why there are two hosts for the identical content.
        const panelBody = (
          <>
            <div className="p-2 border-b border-edge-dim">
              <SearchFilterPill
                ref={pillRef}
                value={search}
                onChange={setSearch}
                placeholder="Search all models…"
                inputAriaLabel="Search all models"
                activeFilters={activeFilters}
                filterOpen={filterOpen}
                onToggleFilter={() => setFilterOpen((f) => !f)}
              />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
              {!loaded ? (
                <p className="text-xs text-fg-muted text-center py-4">Loading…</p>
              ) : (
                <>
                  {/* NOTHING here can run yet. Destin, 2026-09-07 (P-3): this is
                      the app's answer instead of an empty list or a fallback to
                      a provider nobody chose — his words, and a way out that
                      lands in Assistant settings. Sits between the search field
                      and "Manage models…", where he asked for it. */}
                  {!anyPickable && (
                    <div className="px-4 py-4 text-center space-y-2.5">
                      <p className="text-xs text-fg-muted leading-relaxed">You have not set up any model providers.</p>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          setOpen(false);
                          if (onManageModels) onManageModels();
                          else window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'));
                        }}
                      >
                        Add provider
                      </Button>
                    </div>
                  )}
                  {rows.map(row)}

                  {/* Freeform providers only surface while searching — they are
                      not favouritable (there is no model id to star yet). */}
                  {searching && freeformProviders
                    .filter((p) => !sources.size || sources.has(p.id))
                    .filter((p) => matchesQuery(q, p.label) || !rows.length)
                    .map((p) => (
                      <div key={p.id} className="px-4 py-1.5">
                        {freeformFor === p.id ? (
                          <input
                            autoFocus
                            value={freeformText}
                            placeholder={`Model name for ${p.label}`}
                            aria-label={`Model name for ${p.label}`}
                            onChange={(e) => setFreeformText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const id2 = freeformText.trim();
                                if (id2) pick({ runtime: 'native', providerId: p.id, modelId: id2 }, { provider: p.label, model: id2 });
                                setFreeformFor(null);
                              }
                              if (e.key === 'Escape') { setFreeformFor(null); setFreeformText(''); }
                            }}
                            className="w-full bg-inset border border-edge rounded px-2 py-1.5 text-xs text-fg outline-none focus:border-accent"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setFreeformFor(p.id); setFreeformText(''); }}
                            className="w-full text-left text-xs rounded px-2 py-1.5 border border-dashed border-edge-dim text-fg-muted hover:text-fg hover:border-edge transition-colors"
                          >
                            Type a model name… · {p.label}
                          </button>
                        )}
                      </div>
                    ))}

                  {rows.length === 0 && anyPickable && (
                    <p className="text-xs text-fg-muted text-center py-4 px-4 leading-relaxed">
                      {searching
                        ? 'No models match.'
                        : 'No favorites yet. Search for a model, then star it to keep it here.'}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* "Manage models…" — the project picker's footer, one surface over
                (FolderSwitcher.tsx:294). Same job: the picker itself has no
                add/configure actions, so this is the escape hatch to the place
                that does. A flex sibling of the scroll area (not inside it) so
                it stays pinned as the list scrolls. Omitted when the host has
                nowhere to send the user. */}
            {onManageModels && (
              <div className="border-t border-edge shrink-0">
                <button
                  type="button"
                  onClick={() => { setOpen(false); onManageModels(); }}
                  className="w-full px-2.5 py-2 text-xs text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
                >
                  Manage models…
                </button>
              </div>
            )}
          </>
        );

        return layout === 'inline' ? (
          // In flow, right under the trigger — pushes whatever the host draws
          // below it (ModelPickerPopup's Effort/Fast sections) down instead of
          // covering it. No portal, no fixed positioning: this panel is meant
          // to stay open, so there is nothing transient to escape an ancestor
          // clip for.
          // No data-model-picker-portal marker here: that marker exists solely
          // so a HOST's outside-click check (which can't see document.body via
          // its own contains()) still recognises the portaled panel as part of
          // the picker. Rendered in flow, this div already IS a normal
          // descendant, so no host needs the marker to find it.
          <div
            ref={panelRef}
            className="layer-surface mt-1.5 flex flex-col overflow-hidden rounded-md"
            style={{ maxHeight: 320 }}
          >
            {panelBody}
          </div>
        ) : panelPos && createPortal(
          <div
            ref={panelRef}
            // Marker for HOST menus' outside-click handlers — the portal lives on
            // document.body, so SessionStrip's contains() check can't see it and
            // would otherwise unmount us on mousedown before our click fires.
            // Same contract as FolderSwitcher's data-folder-switcher-portal.
            data-model-picker-portal=""
            className="layer-surface fixed flex flex-col overflow-hidden"
            style={{
              top: panelPos.top, bottom: panelPos.bottom, left: panelPos.left, width: panelPos.width,
              maxHeight: panelPos.maxHeight, zIndex: POPOVER_Z,
              animation: 'dropdown-in 120ms cubic-bezier(0.16, 1, 0.3, 1) both',
            }}
          >
            {panelBody}
          </div>,
          document.body,
        );
      })()}
      {open && filterOpen && filterPos && createPortal(
        <div
          ref={filterPopRef}
          // WHY: This second portal is outside the panel marker. Hosts such
          // as SessionStrip use the shared marker to recognise every part of
          // this picker as an inside click before their own menu can close.
          data-model-picker-portal=""
          // Portaled OUT of the panel: `.layer-surface` sets
          // `overflow: hidden` unlayered (globals.css:886) so it can clip
          // scroll-fades to its rounded corners, which also chopped this
          // popover off at the panel edge. Anchored to the pill's own rect
          // instead, at POPOVER_Z + 1 so it sits above the panel — and, in
          // 'inline' layout, above the dialog content the panel now pushes
          // down too, since it is fixed-positioned regardless of `layout`.
          className="layer-surface fixed p-3 flex flex-col gap-3"
          style={{ top: filterPos.top, left: filterPos.left, width: FILTER_W, zIndex: POPOVER_Z + 1 }}
        >
          <Group label="Source">
            {includeClaude && (
              <Chip
                active={sources.has(CLAUDE_SOURCE)}
                onClick={() => setSources((prev) => {
                  const n = new Set(prev);
                  if (n.has(CLAUDE_SOURCE)) n.delete(CLAUDE_SOURCE); else n.add(CLAUDE_SOURCE);
                  return n;
                })}
              >Claude Code</Chip>
            )}
            {listedProviders.map((p) => (
              <Chip
                key={p.id}
                active={sources.has(p.id)}
                onClick={() => setSources((prev) => {
                  const n = new Set(prev);
                  if (n.has(p.id)) n.delete(p.id); else n.add(p.id);
                  return n;
                })}
              >{p.label}</Chip>
            ))}
          </Group>
          <Group label="Show">
            <Chip active={localOnly} onClick={() => setLocalOnly((v) => !v)}>
              Runs on this device
            </Chip>
          </Group>
          {activeFilters > 0 && (
            <button
              type="button"
              onClick={() => { setSources(new Set()); setLocalOnly(false); }}
              className="self-start text-3xs text-fg-muted hover:text-fg"
            >Clear filters</button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
