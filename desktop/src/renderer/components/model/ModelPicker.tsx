import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fieldClasses } from '../ui';
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

/** Context occupancy (in input tokens) above which switching the bound model
 *  shows the re-prefill footnote: the cache is keyed per model, so the next
 *  turn re-sends the whole history to the new model — a full cache-write on
 *  OpenRouter, a minutes-long full prefill on a local model. The number is the
 *  native session-turn threshold at which compaction becomes worthwhile
 *  (harness compaction triggers near 70% of the window; the biggest small
 *  model window here is 32k), i.e. the point where the footnote stops being a
 *  curiosity and starts being actionable. Not a "free" hint: the host must
 *  actively pass currentContextTokens, or the message never appears. */
const CONTEXT_SWITCH_WARNING_TOKENS = 16_000;

/** How much brand COLOUR the list carries. The company mark is always drawn in
 *  full colour at every level — the variable is how far the colour spreads into
 *  the text.
 *    'mark'  — marks only; every model name stays neutral.
 *    'current' — marks everywhere + the CURRENT model's name is brand-coloured
 *                on the closed button, matching the status-bar chip. (default)
 *    'all'   — marks everywhere + every row's name is brand-coloured.
 *  Review deck 2026-08-31 captures all three; the loser gets deleted. */

interface ProviderRow { id: string; type: string; label: string; ready: boolean }
interface CatalogRow { id: string; providerId: string; label: string }

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
  /** Turning this on makes the picker report the session's current context
   *  occupancy so the host can warn when a switch re-prefills a long history.
   *  Shared components stay stateless — the picker only forwards the number. */
  currentContextTokens,
  currentModelId,
}: {
  value: ModelChoice | null;
  onSelect: (choice: ModelChoice) => void;
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
  currentContextTokens?: number;
  currentModelId?: string | null;
}) {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
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
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [filterPos, setFilterPos] = useState<{ top: number; left: number } | null>(null);

  const FILTER_W = 264;

  // Anchor the panel DIRECTLY BELOW the trigger, horizontally centred on it,
  // and clamp into the viewport. Not viewport-centred — a picker that opens in
  // the middle of the screen reads as a modal and loses its tie to the field.
  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 320);
    const centred = r.left + r.width / 2 - width / 2;
    setPanelPos({
      top: r.bottom + 4,
      left: Math.max(8, Math.min(centred, window.innerWidth - width - 8)),
      width,
      maxHeight: Math.max(180, window.innerHeight - r.bottom - 16),
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

  useEffect(() => {
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
          onSelect({ runtime: 'native', providerId: match.providerId, modelId: match.id });
        }
      }
    }).catch(() => setLoaded(true));
    return () => { cancelled = true; };
  }, []);

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
    if (includeClaude) {
      for (const m of CLAUDE_MODELS) {
        const choice: ModelChoice = { runtime: 'claude', alias: m.alias };
        out.push({
          key: choiceKey(choice), label: m.label, choice,
          sourceId: CLAUDE_SOURCE, sourceLabel: 'Claude Code', local: false,
        });
      }
    }
    for (const p of includeNative ? providers.filter((x) => x.ready) : []) {
      for (const m of catalog.filter((c) => c.providerId === p.id)) {
        const choice: ModelChoice = { runtime: 'native', providerId: p.id, modelId: m.id };
        out.push({
          key: choiceKey(choice), label: m.label, choice,
          sourceId: p.id, sourceLabel: p.label, local: p.type === 'local-engine',
          providerType: p.type,
        });
      }
    }
    return out;
  }, [providers, catalog, includeClaude, includeNative]);

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
    return pool.filter((e) => {
      if (localOnly && !e.local) return false;
      if (sources.size && !sources.has(e.sourceId)) return false;
      // Word-by-word, punctuation-insensitive: "gpt 5.6" has to find "GPT-5.6".
      if (!matchesQuery(q, e.label, e.sourceLabel)) return false;
      return true;
    });
  }, [entries, favorites, searching, localOnly, sources, q]);

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
    if (!value) return 'Choose a model…';
    const hit = entries.find((e) => e.key === choiceKey(value));
    if (hit) return `${hit.label} · ${hit.sourceLabel}`;
    // A binding whose catalog row hasn't loaded (or a typed freeform id) still
    // needs a truthful label rather than falling back to "Choose a model…".
    return value.runtime === 'claude' ? value.alias : value.modelId;
  }, [value, entries]);

  const pick = (c: ModelChoice) => { onSelect(c); setOpen(false); setFilterOpen(false); };

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

  // The ONE way today's model can be identified. Why currentModelId instead of
  // `value`: `value` is the CURRENT pick — it IS the pre-answer state, so it
  // would never differ and the message could never appear. currentModelId comes
  // from the host (the live SessionInfo.model), a prop deliberately kept on the
  // other side of the pick state so an open panel can still see "what is
  // running now". Same shape as the Session footnote in that file's sibling
  // popover.
  const swapAwayFromCurrent = useMemo(() => {
    if (!currentModelId || currentModelId === 'unknown') return false;
    if (!value) return false;
    if (value.runtime !== 'native') return false;
    return value.modelId !== currentModelId;
  }, [currentModelId, value]);

  // Cross-runtime / cross-provider switches are machine-honest "no" — the
  // cached-prefix guarantee only holds within one provider (same account, same
  // id), so moving providers is unambiguously a cache-miss either way and the
  // message would be a redundant guess. The model-class estimate for Claude
  // sessions is withheld for the same reason below.
  const sameProvider = useMemo(() => {
    if (!value || value.runtime !== 'native') return false;
    const p = providers.find((x) => x.id === value.providerId);
    return p?.type === 'local-engine' || p?.type === 'openrouter' || p?.type === 'anthropic';
  }, [value, providers]);

  const showReprefillWarning = swapAwayFromCurrent && sameProvider && (currentContextTokens ?? 0) >= CONTEXT_SWITCH_WARNING_TOKENS;

  const row = (e: Entry) => {
    const selected = !!value && choiceKey(value) === e.key;
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
      <div key={e.key} className="group/model flex items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => pick(e.choice)}
          aria-pressed={selected}
          className={`flex-1 min-w-0 text-left text-xs rounded px-2 py-2 transition-colors flex items-center gap-2 ${
            selected ? 'bg-accent text-on-accent font-medium' : 'text-fg-2 hover:bg-inset'
          }`}
        >
          {/* The company mark. A fixed-width box whether or not a mark resolves,
              so an unrecognised model's name still lines up with its neighbours'
              instead of hanging one glyph-width to the left. */}
          <span className="w-[13px] shrink-0 inline-flex items-center justify-center" style={markColor ? { color: markColor } : undefined}>
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
        </button>
        {/* touch-reveal + coarse-hit: hover-only affordances never resolve on
            the Android WebView (narrow-viewport rule). */}
        <button
          type="button"
          onClick={() => toggleFavorite(e.key)}
          aria-pressed={fav}
          aria-label={fav ? `Unfavourite ${e.label}` : `Favourite ${e.label}`}
          title={fav ? 'Remove from favourites' : 'Add to favourites'}
          className={`shrink-0 w-6 h-6 rounded inline-flex items-center justify-center transition-opacity coarse-hit touch-reveal ${
            fav ? 'text-accent opacity-100' : 'text-fg-faint opacity-0 group-hover/model:opacity-100 hover:text-fg-2'
          }`}
        >
          <StarGlyph filled={fav} />
        </button>
      </div>
    );
  };

  return (
    <div className="relative">
      {/* Trigger — the project picker's field shape (FolderSwitcher.tsx:181). */}
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

      {open && panelPos && createPortal(
        <>
          <div
            ref={panelRef}
            // Marker for HOST menus' outside-click handlers — the portal lives on
            // document.body, so SessionStrip's contains() check can't see it and
            // would otherwise unmount us on mousedown before our click fires.
            // Same contract as FolderSwitcher's data-folder-switcher-portal.
            data-model-picker-portal=""
            className="layer-surface fixed flex flex-col overflow-hidden"
            style={{
              top: panelPos.top, left: panelPos.left, width: panelPos.width,
              maxHeight: panelPos.maxHeight, zIndex: POPOVER_Z,
              animation: 'dropdown-in 120ms cubic-bezier(0.16, 1, 0.3, 1) both',
            }}
          >
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
              ) : entries.length === 0 ? (
                <p className="text-xs text-fg-muted text-center py-4 px-3">
                  No models available. Add a provider in Settings → Model Providers.
                </p>
              ) : (
                <>
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
                                if (id2) pick({ runtime: 'native', providerId: p.id, modelId: id2 });
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

                  {rows.length === 0 && (
                    <p className="text-xs text-fg-muted text-center py-4 px-4 leading-relaxed">
                      {searching
                        ? 'No models match.'
                        : 'No favourites yet. Search for a model, then star it to keep it here.'}
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
            {showReprefillWarning && (
              <div className="border-t border-edge shrink-0 px-3 py-2 bg-inset/60">
                <p className="text-3xs leading-relaxed text-fg-muted">
                  Switching models re-sends this whole conversation
                  ({Math.round(currentContextTokens! / 1000)}k tokens) to the
                  new model — the prompt cache is per model, so your next
                  message starts a full re-prefill. If the chat is getting
                  long, compact first.
                </p>
              </div>
            )}
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
          </div>
          {filterOpen && filterPos && (
            <div
              ref={filterPopRef}
              // Portaled OUT of the panel: `.layer-surface` sets
              // `overflow: hidden` unlayered (globals.css:886) so it can clip
              // scroll-fades to its rounded corners, which also chopped this
              // popover off at the panel edge. Anchored to the pill's own rect
              // instead, at POPOVER_Z + 1 so it sits above the panel.
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
                {readyProviders.map((p) => (
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
            </div>
          )}
        </>,
        document.body,
      )}
    </div>
  );
}
