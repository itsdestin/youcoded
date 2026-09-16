import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isAndroid, isRemoteMode } from '../platform';
import { PRESETS } from '../../shared/harness-manifest';
import { FieldError, SettingRow, Toggle } from './ui';
import { plainMessage } from '../utils/ipc-error';

// The two built-in native harness presets (personality profiles, not capability
// tiers). A native session is stamped with one at create time; it drives the
// session's starting permission posture + prompt personality.
export type PresetId = 'assistant' | 'coder';

/** Spec §3.4 heuristic: a project folder set at form-open → Coder, else Assistant.
 *  Both new-session forms seed the preset from this until the user picks one. */
function defaultPresetFor(cwd: string): PresetId { return cwd.trim() ? 'coder' : 'assistant'; }

// Preset lifecycle (spec §3.4): follow the folder heuristic (folder set → Coder,
// empty → Assistant) UNTIL the user explicitly picks a card, then latch. Lifted
// here so both new-session forms share ONE implementation (the whole reason
// RuntimeBinding exists) — a per-form copy already drifted on the re-arm bug (I2):
// the old code re-armed by resetting a `touched` ref AND setting cwd back to the
// default folder, relying on a cwd-change to re-run a `useEffect([cwd])`. But
// after the first create the folder is ALREADY the default, so `setCwd(same)`
// caused no state change → the effect didn't re-run → the user's last manual pick
// stuck even though `touched` was cleared. The fix keys the re-arm on `active`
// (form open) transitioning false→true and re-derives EXPLICITLY from the current
// cwd, so an unchanged cwd can no longer trap it.
export function usePreset({ active, cwd }: { active: boolean; cwd: string }): {
  preset: PresetId;
  setPreset: (p: PresetId) => void;   // marks touched (latches the manual pick)
} {
  const [preset, setPresetState] = useState<PresetId>(() => defaultPresetFor(cwd));
  // Has the user manually picked a card this open? While false, `preset` tracks
  // the folder heuristic; once true, the manual pick sticks even if cwd changes.
  const touched = useRef(false);
  // Previous `active`, so we can detect the false→true (fresh open) edge.
  const prevActive = useRef(active);

  // Track the folder heuristic while the user hasn't picked. Pure derivation from
  // cwd (no state writes when touched) — can't loop (dep is only cwd).
  useEffect(() => {
    if (!touched.current) setPresetState(defaultPresetFor(cwd));
  }, [cwd]);

  // Re-arm on each fresh OPEN: when the form goes closed→open, drop the latch and
  // re-derive from the CURRENT cwd DIRECTLY. Keyed on `active` (not cwd), so the
  // "cwd unchanged after create" trap that broke the per-form copies can't recur —
  // this always fires on open regardless of whether cwd moved.
  useEffect(() => {
    if (active && !prevActive.current) {
      touched.current = false;
      setPresetState(defaultPresetFor(cwd));
    }
    prevActive.current = active;
    // cwd is intentionally read but NOT a dependency: the re-arm must trigger on
    // the `active` edge alone, using whatever cwd is current at that commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const setPreset = useCallback((p: PresetId) => {
    touched.current = true;   // latch — the heuristic stops overriding this pick
    setPresetState(p);
  }, []);

  return { preset, setPreset };
}

// Shared "Runtime" selector (Claude Code vs the YouCoded native harness) + the
// native provider/model binding picker, used by BOTH new-session forms — the
// SessionStrip dropdown AND the app-open welcome screen. Extracted so the two
// forms can never drift on native-session creation logic.
//
// Split into a hook (all the state + derivation) and a presentational component
// (the Runtime toggle + provider/model selects). The parent owns `runtime` so it
// can hide ITS OWN Claude-alias model selector when the native runtime is chosen
// (that selector's styling differs per form, so it stays form-local).

export type Runtime = 'claude' | 'native';
export interface Binding { providerId: string; modelId: string }

interface ProviderRow { id: string; type: string; label: string; ready: boolean }
interface CatalogRow { id: string; providerId: string; label: string }

// Seed the binding picker from the last-used choice so it sticks across sessions.
export function loadLastBinding(): Binding | null {
  try {
    const raw = localStorage.getItem('youcoded-last-binding');
    if (raw) {
      const b = JSON.parse(raw);
      if (b && typeof b.providerId === 'string' && typeof b.modelId === 'string') return b;
    }
  } catch { /* corrupt entry — ignore */ }
  return null;
}

// Persist the effective binding on a successful native create (both forms call this).
export function persistLastBinding(binding: Binding): void {
  try { localStorage.setItem('youcoded-last-binding', JSON.stringify(binding)); } catch { /* storage full/blocked — non-fatal */ }
}

// Native runtime is desktop-only AND gated on the capability flag — with a single
// runtime there's nothing to select, so the whole selector hides.
function isNativeSupported(): boolean {
  return !isAndroid() && !isRemoteMode() && (window as any).claude?.native?.supported === true;
}

// Which runtime a brand-new session form should open on. Plain 'claude' unless
// this install has asked for the native harness as its default.
//
// WHY THIS EXISTS. Someone who set up YouCoded by signing in with ChatGPT has no
// Claude login at all. If every new-session form still opened on "Claude Code",
// their very next session would try to start Claude Code and fail. So the
// first-run completion path stores 'native' under this key once, and both forms
// (the session-strip dropdown and the welcome screen) read it here.
//
// WHY BOTH FORMS MUST ALSO USE THIS FOR THEIR POST-CREATE RESET (review R2-3):
// after every create, each form resets its runtime back to a default so the next
// open starts clean. When that reset was the literal 'claude', the ChatGPT
// default lasted exactly ONE session -- the second New Session was Claude Code
// again, with no Claude login behind it. Resetting to defaultRuntime() instead
// makes the default hold for every session, not just the first.
//
// WHY THERE IS NO LONGER AN isNativeSupported() FALLBACK (Destin, deck
// 2026-09-07, P-3 b): "i never want to 'default' back to claude code when the
// chosen models are unavailable. all providers should be equal/neutral, no
// reason to randomly pick claude code."
//
// The old gate (review R3-6) sent an install whose non-Claude side is switched
// off back to Claude Code so its forms stayed usable. That is exactly the
// substitution the rule forbids: the user gets an engine nobody chose. What
// replaces it is honest and reaches the same place in one tap — the model menu
// says "You have not set up any model providers." and offers Add provider,
// which opens Assistant settings (ModelPicker, P-3).
export function defaultRuntime(): Runtime {
  try {
    if (localStorage.getItem('youcoded-runtime-default') === 'native') return 'native';
  } catch { /* storage blocked -- fall through to the base state */ }
  return 'claude';
}

// The ONLY writer of the runtime-default key (a source-scan test pins that). The
// first-run completion path calls it with 'native' when setup finished through
// ChatGPT; nothing else should decide the install-wide default.
export function persistRuntimeDefault(runtime: Runtime): void {
  try { localStorage.setItem('youcoded-runtime-default', runtime); } catch { /* storage full/blocked -- non-fatal */ }
}

// Create-time memory-fit verdict for a local-engine model (from main's
// models.memoryCheck). 'too-large' blocks create; 'tight' is a warning.
export interface MemVerdict { verdict: 'ok' | 'tight' | 'too-large'; headline: string; detail: string }

export interface NativeBinding {
  nativeSupported: boolean;
  readyProviders: ProviderRow[];
  modelCatalog: CatalogRow[];
  selectedProviderId: string;
  selectedProvider: ProviderRow | undefined;
  providerModels: CatalogRow[];
  needsFreeformModel: boolean;
  selectedModelId: string;
  effectiveBinding: Binding | null;
  /** True when the native runtime is chosen but no usable provider/binding exists
   *  OR the selected local model is too large to fit. */
  nativeCreateBlocked: boolean;
  // Local-engine memory guard (shared by both new-session forms).
  memVerdict: MemVerdict | null;
  memDetailOpen: boolean;
  setMemDetailOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** S-2: "don't warn me again" for the selected model (remembered in main per model +
   *  context length). Undefined when the bridge has no such channel (older main). */
  memDismissed: boolean;
  dismissMemoryWarning?: (next: boolean) => void;
  /** Why the last "don't warn me again" save did not stick — null when it did.
   *  Shown beside the checkbox; a silent failure would leave the box ticked
   *  over a preference that was never stored. */
  memDismissError: string | null;
}

// All derived binding state. Pure derivation (no state writes) apart from the one
// lazy fetch effect, so there's no update loop — the parent reads the returned
// values directly during render.
export function useNativeBinding({ active, runtime, binding, setBinding }: {
  active: boolean;              // the new-session form is open (gates the fetch)
  runtime: Runtime;
  binding: Binding | null;
  setBinding: (b: Binding) => void;
}): NativeBinding & { setBinding: (b: Binding) => void } {
  const nativeSupported = isNativeSupported();
  const [providersList, setProvidersList] = useState<ProviderRow[]>([]);
  const [modelCatalog, setModelCatalog] = useState<CatalogRow[]>([]);
  // Local-engine memory guard (#2) — moved here from SessionStrip so BOTH
  // new-session forms enforce it.
  const [memVerdict, setMemVerdict] = useState<MemVerdict | null>(null);
  const [memDetailOpen, setMemDetailOpen] = useState(false);

  // Load providers + catalog when the native runtime is selected in an open form.
  useEffect(() => {
    if (!nativeSupported || runtime !== 'native' || !active) return;
    let cancelled = false;
    Promise.all([
      window.claude.providers.list().catch(() => []),
      window.claude.providers.catalog().catch(() => []),
    ]).then(([list, cat]) => {
      if (cancelled) return;
      setProvidersList(Array.isArray(list) ? (list as ProviderRow[]) : []);
      setModelCatalog(Array.isArray(cat) ? (cat as CatalogRow[]) : []);
    });
    return () => { cancelled = true; };
  }, [nativeSupported, runtime, active]);

  const readyProviders = providersList.filter((p) => p.ready);
  // NOTHING IS SUBSTITUTED (Destin, 2026-09-07 — "nothing should be overridden.
  // if users select an openrouter/claude code/chatgpt plan model, they should
  // get that. if the provider is unavailable, the model selector should just
  // start empty", extended the same day to the last-used memory: "we should fix
  // this too").
  //
  // This used to fall to the first ready provider and its first model whenever
  // the remembered one could not be honoured, so a person whose local engine was
  // off silently started a conversation on someone else's cloud model. Now an
  // unusable binding selects nothing, Create stays gated on `effectiveBinding`
  // below, and the picker reads "Choose a model…".
  //
  // The ONE case that still picks for you is having no binding at all — a first
  // run with nothing to honour, which is a starting point, not a substitution.
  const selectedProviderId = !binding
    ? (readyProviders[0]?.id ?? '')
    : (readyProviders.some((p) => p.id === binding.providerId) ? binding.providerId : '');
  const selectedProvider = readyProviders.find((p) => p.id === selectedProviderId);
  const providerModels = modelCatalog.filter((m) => m.providerId === selectedProviderId);
  // openai-compatible endpoints (Ollama, LM Studio, custom) may expose no catalog
  // rows — let the user type the model id directly.
  const needsFreeformModel = selectedProvider?.type === 'openai-compatible' && providerModels.length === 0;
  // Validate the stored/selected modelId against the catalog (mirrors the
  // providerId guard) so a stale id on a still-ready provider whose catalog no
  // longer lists it can't create a session bound to a model the <select> can't
  // display. Freeform ids pass through as typed.
  const selectedModelId = !binding
    ? (providerModels[0]?.id ?? '')
    : ((binding.providerId === selectedProviderId && binding.modelId
        && (needsFreeformModel || providerModels.some((m) => m.id === binding.modelId)))
      ? binding.modelId
      : '');
  // Trimmed only at the boundary (never on the displayed value) — a whitespace-only
  // freeform entry is truthy but not a real model, so it must NOT pass the gate.
  const resolvedModelId = selectedModelId.trim();
  const effectiveBinding = selectedProviderId && resolvedModelId
    ? { providerId: selectedProviderId, modelId: resolvedModelId }
    : null;

  // Ask main whether this local model fits given what's already resident. Runs
  // only for the local-engine provider (cloud models don't consume our memory).
  // liveModels() falls back to a cache scan when the engine is off, so this is
  // cheap and never boots the engine. Decision (Destin): block only 'too-large'.
  const isLocalEngine = runtime === 'native' && selectedProviderId === 'local';
  useEffect(() => {
    let cancelled = false;
    setMemDetailOpen(false);
    if (!isLocalEngine || !resolvedModelId) { setMemVerdict(null); return; }
    (window.claude.models as any).memoryCheck?.(resolvedModelId)
      .then((v: any) => { if (!cancelled) setMemVerdict(v && v.verdict ? v : null); })
      .catch(() => { if (!cancelled) setMemVerdict(null); });
    return () => { cancelled = true; };
  }, [isLocalEngine, resolvedModelId]);
  const memBlocked = memVerdict?.verdict === 'too-large';
  // S-2: the checkbox state; main remembers the choice per model at the current
  // context length. Optimistic — the warning stays visible until the picker
  // re-opens, which is when the remembered answer takes effect.
  const [memDismissed, setMemDismissed] = useState(false);
  useEffect(() => { setMemDismissed(false); }, [resolvedModelId]);
  // One write for everything this model's settings own: the separate
  // `models.dismissMemoryWarning` channel is gone, and the tick is now
  // `setSettings(id, { dismissMemoryWarning })`. Main stamps the context length
  // it was dismissed at — a number the renderer cannot work out, because only
  // main knows how this model's setting and the engine-wide default combine.
  //
  // WHY still optional-chained after dropping the `as any` cast: the bridge is
  // real on every shipping surface, but SessionStrip's unit tests stub
  // `window.claude` with no `models` namespace at all, so an unguarded call
  // would throw during their render.
  const [memDismissError, setMemDismissError] = useState<string | null>(null);
  const dismissMemoryWarning = resolvedModelId
    ? (next: boolean) => {
      setMemDismissed(next);
      setMemDismissError(null);
      // NOT fire-and-forget. A rejected save here used to be invisible AND an
      // unhandled promise rejection: the box stayed ticked, nothing was
      // remembered, and the warning came back next time with no explanation.
      // On a phone this rejects every time, because there is no local engine to
      // remember anything.
      window.claude.models?.setSettings(resolvedModelId, { dismissMemoryWarning: next })
        .catch((e: unknown) => {
          // Put the tick back where it really is, then say what happened in the
          // words the failure gave us — never a guessed cause.
          setMemDismissed(!next);
          setMemDismissError(plainMessage(e, 'Could not remember your answer.'));
        });
    }
    : undefined;

  const nativeCreateBlocked = runtime === 'native' && (readyProviders.length === 0 || !effectiveBinding || memBlocked);

  return {
    nativeSupported, readyProviders, modelCatalog, selectedProviderId, selectedProvider,
    providerModels, needsFreeformModel, selectedModelId, effectiveBinding, nativeCreateBlocked,
    memVerdict, memDetailOpen, setMemDetailOpen, setBinding, memDismissed, dismissMemoryWarning,
    memDismissError,
  };
}

// The native-only extras that are NOT model selection: the harness preset and
// the local-engine memory-fit warning. Split out so the unified <ModelPicker>
// can host them without dragging in the Runtime toggle and the provider/model
// <Select> pair it replaced. Both are now deleted — all three new-session
// surfaces (SessionStrip, the welcome form, the Resume Browser) go through
// <ModelPicker>, so this is the only place the preset/memory UI lives.
export function NativeExtras({ nb, preset, onPreset }: {
  nb: NativeBinding & { setBinding: (b: Binding) => void };
  preset: PresetId;
  onPreset: (p: PresetId) => void;
}) {
  return (
    <>
      {/* Preset picker (spec §3.4): the native harness personality —
          Assistant (asks first) vs Coder (agentic, auto-edits). Both carry
          the full tool suite; they differ in prompt + starting permission
          posture. Stamped at create; drives the resolved harnessId. */}
      <div>
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Preset</label>
        <div className="flex gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPreset(p.id as PresetId)}
              aria-pressed={preset === p.id}
              className={`flex-1 text-left rounded border px-2 py-1.5 ${preset === p.id ? 'border-accent bg-inset' : 'border-edge bg-panel hover:bg-inset'}`}
            >
              <div className="text-xs text-fg">{p.name}</div>
              <div className="text-3xs text-fg-muted leading-snug">{p.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Memory guard (#2): block only when clearly too large; otherwise a
          warning. local-engine models only.
          Round 2 (deck P-8): ONE line in a pill — "This model may not fit in
          available memory" — that unfolds on click into the two numbers behind it
          and, for a warning, the remembered "don't warn me again" (S-2). A block
          ('too-large') unfolds the same way but has no checkbox: it is not a choice. */}
      {nb.memVerdict && nb.memVerdict.verdict !== 'ok' && (
        // Round-4 (Destin, screenshot): "doesn't look like any other surface in the
        // app". So it IS another surface in the app — the expandable SettingRow every
        // Settings screen uses (G-22): the sentence is the row title, the chevron on
        // the right flips down, and what it reveals is one numbers line plus the
        // "Warn me about this model" toggle row. No status dot, no Less button.
        // Round-5 note (Destin): the toggle is a SUB-CARD inside the expanded warning card,
        // not a sibling row — so the card is one container that grows, and the toggle row's
        // own tint reads as nested inside it.
        <div className="rounded-lg bg-inset/50">
          <SettingRow
            variant="item"
            className="bg-transparent"
            title={(
              // WHY `text-warning-fg` and not a fixed amber (contract R30, 2026-09-06):
              // one hard-coded amber is crisp on a dark theme and invisible on a pale
              // one — measured 9.5:1 on Halftone Dimension and 1.05:1 on Meadow Mist,
              // where it sat on that theme's pale-green card at practically the same
              // brightness. `--warning-fg` is the same amber nudged, per theme, until
              // it is readable on that theme's own surfaces, so a theme nobody has
              // written yet comes out right too. Dark themes are unchanged.
              <span className={nb.memVerdict.verdict === 'too-large' ? 'text-destructive-fg' : 'text-warning-fg'}>
                {nb.memVerdict.verdict === 'too-large' ? 'This model is too large for this computer' : 'This model may not fit in available memory'}
              </span>
            )}
            description={nb.memDetailOpen ? nb.memVerdict.headline : undefined}
            onClick={() => nb.setMemDetailOpen((o) => !o)}
            expanded={nb.memDetailOpen}
          />
          {nb.memDetailOpen && nb.memVerdict.verdict === 'tight' && nb.dismissMemoryWarning && (
            <div className="px-1.5 pb-1.5">
              <SettingRow
                variant="item"
                className="bg-inset"
                title="Warn me about this model"
                description="Off skips this next time."
                control={(
                  <Toggle
                    checked={!nb.memDismissed}
                    aria-label="Warn me about this model"
                    onChange={(next) => nb.dismissMemoryWarning?.(!next)}
                  />
                )}
              />
              {/* A save that did not stick has to say so. Silence here leaves the
                  toggle showing a preference nothing remembered. */}
              {nb.memDismissError && <FieldError as="p" className="px-3 pb-1.5">{nb.memDismissError}</FieldError>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
