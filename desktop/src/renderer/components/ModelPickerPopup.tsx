import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelAlias } from './StatusBar';
import { FastIcon } from './Icons';
import { useEscClose } from '../hooks/use-esc-close';
import { Button, Dialog, TextInput, Toggle, FOCUS_RING, LoadingState, SettingRow } from './ui';
import ModelPicker, { type ModelChoice } from './model/ModelPicker';

// Model + effort + fast picker. Replaces the cycle-only status bar chip with
// a full picker. Invoked by:
//   • Clicking the model chip (future enhancement — currently still cycles)
//   • Typing /model, /fast, or /effort with no args
//   • Future: status bar fast/effort chips
//
// Effort and fast are YouCoded-local state (Claude Code doesn't transcribe
// them) — we trust the popup as source of truth and forward to PTY on change.

// Labels are model-class only (no version numbers) by design.
const MODELS: { id: ModelAlias; label: string }[] = [
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus[1m]', label: 'Opus' },
  { id: 'fable', label: 'Fable' },
];

const MODEL_INFO: Record<ModelAlias, { tagline: string; pros: string[]; cons: string[] }> = {
  haiku: {
    tagline: 'Fast & lightweight',
    pros: ['Fastest responses', 'Great for quick tasks', 'Lighter on capacity'],
    cons: ['Less capable on complex reasoning'],
  },
  sonnet: {
    tagline: 'Balanced everyday model',
    pros: ['Strong reasoning & quality', 'Fast enough for most work', 'Versatile across tasks'],
    cons: ['Not as deep as Opus for complex analysis'],
  },
  'opus[1m]': {
    tagline: 'Powerful — 1M context',
    pros: ['Deep reasoning & analysis', '1 million token context window', 'Great for complex multi-step tasks'],
    cons: ['Slower responses', 'Uses more plan capacity'],
  },
  fable: {
    tagline: 'Most capable — hardest tasks',
    pros: ['Best reasoning & long-horizon work', '1 million token context window', 'Strongest at agentic coding'],
    cons: ['Slowest responses', 'Uses the most plan capacity'],
  },
};

// Fix: use portal so tooltip renders above all overflow:auto scroll containers
export function ModelInfoTooltip({ model }: { model: ModelAlias }) {
  const info = MODEL_INFO[model];
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);

  const handleEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ x: rect.left + rect.width / 2, y: rect.top });
    }
    setVisible(true);
  };

  return (
    <span
      ref={ref}
      className="inline-flex items-center ml-1 cursor-default"
      onMouseEnter={handleEnter}
      onMouseLeave={() => setVisible(false)}
      // Stop click from bubbling so hovering the icon doesn't trigger the outer model button twice
      onClick={(e) => e.stopPropagation()}
    >
      {/* ⓘ icon */}
      <svg
        className="w-3 h-3 opacity-40 hover:opacity-75 transition-opacity shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v5" />
        <circle cx="12" cy="8" r="0.5" fill="currentColor" />
      </svg>

      {/* Tooltip rendered to document.body so overflow containers don't clip it */}
      {visible && createPortal(
        <div
          style={{ left: pos.x, top: pos.y - 10, transform: 'translate(-50%, -100%)' }}
          className="fixed z-[9999] w-52 pointer-events-none"
        >
          <div className="bg-panel border border-edge rounded-lg shadow-lg p-3 text-left">
            <p className="text-xs font-semibold text-fg mb-2">{info.tagline}</p>
            <div className="space-y-1">
              {info.pros.map((pro) => (
                <div key={pro} className="flex items-start gap-1.5 text-2xs text-fg-2 leading-snug">
                  <span className="text-green-500 shrink-0 font-bold mt-px">✓</span>
                  <span>{pro}</span>
                </div>
              ))}
            </div>
            {info.cons.length > 0 && (
              <div className="space-y-1 mt-2 pt-2 border-t border-edge-dim">
                {info.cons.map((con) => (
                  <div key={con} className="flex items-start gap-1.5 text-2xs text-fg-muted leading-snug">
                    <span className="shrink-0 mt-px">·</span>
                    <span>{con}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'max', 'auto'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

// `max` effort is only accepted by the top-tier models (Opus 1M + Fable);
// Claude Code rejects it elsewhere. Keep this list in sync with the disable
// gate + downgrade-on-switch logic below.
const MAX_EFFORT_MODELS: ModelAlias[] = ['opus[1m]', 'fable'];

interface Props {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  currentModel: ModelAlias | null;
  onSelectModel: (m: ModelAlias) => void;
  /** Runtime backend — native sessions get a provider-scoped model catalog
   *  (setBinding) instead of the Claude alias/effort/fast controls. */
  provider?: 'claude' | 'native';
  /** Native only — the session's current bound modelId (SessionInfo.model),
   *  which App keeps current across swaps. Used to highlight the active row
   *  reliably even when the persisted session header (sessionsList) is stale
   *  (setBinding is an in-memory swap, not a header rewrite). */
  currentModelId?: string;
  /** Native only — called after a successful setBinding so App can refresh its
   *  record of the session's model (the header pill sources SessionInfo.model). */
  onNativeModelChanged?: (modelId: string) => void;
  /** Guarded PTY sender (App.guardedPtySend). /fast and /effort are PTY writes
   *  just like /model — while a permission/plan/AskUserQuestion prompt is
   *  pending, CC's Ink select menu is live in the PTY and a raw sendInput would
   *  answer the menu instead of running the command (stray-Enter fix,
   *  youcoded#110). Returns false when the send was refused. */
  sendPtyCommand: (text: string) => boolean;
}

export default function ModelPickerPopup({ open, onClose, sessionId, currentModel, onSelectModel, provider, currentModelId, onNativeModelChanged, sendPtyCommand }: Props) {
  useEscClose(open, onClose);
  const [fast, setFast] = useState(false);
  const [effort, setEffort] = useState<EffortLevel>('auto');
  const [loaded, setLoaded] = useState(false);
  // Enabling fast mode is a paid action (API billing, not Pro/Max subscription) —
  // gate behind an explicit confirmation popup so it can't be flipped accidentally.
  const [fastConfirmOpen, setFastConfirmOpen] = useState(false);

  // Native-runtime picker state. For native sessions the popup shows a
  // provider-scoped model catalog (grouped by provider) instead of the Claude
  // alias + effort + fast controls. Hooks live here unconditionally (before any
  // early return) to keep hook order stable across provider values.
  const [catalog, setCatalog] = useState<Array<{ id: string; providerId: string; label: string }>>([]);
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
  const [nativeSearch, setNativeSearch] = useState('');
  const [nativeBinding, setNativeBinding] = useState<{ providerId: string; modelId: string } | null>(null);
  // Inline error when a model swap (setBinding) fails — the popup stays open so
  // the user knows the swap did NOT take effect (don't close as if it succeeded).
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [nativeSwapping, setNativeSwapping] = useState(false);

  // Same problem, same fix as ModelPicker.tsx (Destin, 2026-09-06): this list
  // refetched when the popup OPENED but could never catch up while it was
  // already on screen, so a model you downloaded with this popup open stayed
  // missing until you closed and reopened it. Bumping `reload` re-runs the fetch
  // below. See ModelPicker.tsx for why this is the download push and not
  // `engine.onModelsChanged` — nothing sends that channel.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const off = window.claude?.models?.onDownloadProgress?.((p: { state?: string }) => {
      if (p?.state === 'done') setReload((n) => n + 1);
    });
    return () => { off?.(); };
  }, []);

  // The transient view state resets on OPEN only. It deliberately does not sit in
  // the fetch effect below any more: that one now also re-runs when a download
  // lands, and re-running it here would erase whatever the user had typed in the
  // search box at that moment.
  useEffect(() => {
    if (!open || provider !== 'native') return;
    setNativeSearch('');
    setNativeError(null);
    setNativeSwapping(false);
  }, [open, provider]);

  useEffect(() => {
    if (!open || provider !== 'native') return;
    Promise.all([
      window.claude.providers.catalog().catch(() => []),
      window.claude.providers.list().catch(() => []),
      (window.claude.native.sessionsList?.() ?? Promise.resolve([])).catch(() => []),
    ]).then(([cat, list, sessions]) => {
      setCatalog(Array.isArray(cat) ? cat : []);
      const labels: Record<string, string> = {};
      if (Array.isArray(list)) for (const p of list) if (p?.id) labels[p.id] = p.label ?? p.id;
      setProviderLabels(labels);
      // Current binding for the highlighted row — sessionsList carries the
      // per-session header binding keyed by sessionId.
      const row = Array.isArray(sessions) ? sessions.find((s: any) => s?.sessionId === sessionId) : null;
      const b = row?.binding;
      setNativeBinding(b && b.providerId && b.modelId ? { providerId: b.providerId, modelId: b.modelId } : null);
    }).catch(() => {});
  }, [open, provider, sessionId, reload]);

  // Load persisted state when opening. We don't live-sync with external changes
  // (Claude Code doesn't broadcast these); the popup is the source of truth
  // for the local session's view.
  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    const api = (window.claude as any).modes;
    if (!api) {
      setLoaded(true);
      return;
    }
    api.get().then((m: { fast?: boolean; effort?: string }) => {
      setFast(!!m?.fast);
      if (m?.effort && (EFFORT_LEVELS as readonly string[]).includes(m.effort)) {
        setEffort(m.effort as EffortLevel);
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [open]);

  const handleModelSelect = (m: ModelAlias) => {
    onSelectModel(m);
    // If user switches to a model that doesn't support max-effort while max is
    // set, downgrade silently — Claude Code rejects max there and we'd get into
    // an inconsistent state.
    if (effort === 'max' && !MAX_EFFORT_MODELS.includes(m)) {
      updateEffort('auto');
    }
  };

  /** One entry point for both runtimes, so the chip's dialog can offer the same
   *  list everywhere. A CC pick is a PTY `/model <alias>` (via onSelectModel); a
   *  native pick is an in-memory setBinding. The list is already scoped to the
   *  session's runtime below, so the other arm is unreachable in practice — it
   *  is written out anyway because a scoping bug should mis-render, not
   *  mis-dispatch. */
  const applyChoice = async (c: ModelChoice) => {
    if (c.runtime === 'claude') {
      handleModelSelect(c.alias as ModelAlias);
      onClose();
      return;
    }
    setNativeError(null);
    setNativeSwapping(true);
    let ok = false;
    try {
      ok = await window.claude.native.setBinding(sessionId!, { providerId: c.providerId, modelId: c.modelId });
    } catch { ok = false; }
    setNativeSwapping(false);
    if (!ok) {
      // Never close on failure: closing reads as "changed", and it did not.
      setNativeError("Couldn't switch models. The session may have ended — try again.");
      return;
    }
    onNativeModelChanged?.(c.modelId);
    onClose();
  };

  const applyFast = (v: boolean) => {
    // Forward to Claude Code via PTY first, guarded (pending-prompt gate) —
    // a raw sendInput while CC shows an interactive prompt would answer the
    // live Ink menu instead of running /fast. Refusing BEFORE the optimistic
    // state writes keeps the toggle truthful when the command never reached
    // CC. Mirrors the guarded /model path in App.onSelectModel.
    if (sessionId && !sendPtyCommand(`/fast ${v ? 'on' : 'off'}\r`)) return;
    setFast(v);
    const api = (window.claude as any).modes;
    api?.set({ fast: v }).catch(() => {});
  };

  const handleFastToggle = () => {
    if (fast) {
      // Turning OFF is always safe — no confirmation needed
      applyFast(false);
    } else {
      // Turning ON triggers billing — require explicit confirmation
      setFastConfirmOpen(true);
    }
  };

  const updateEffort = (level: EffortLevel) => {
    // Guarded like applyFast above — don't let /effort answer a live Ink
    // prompt, and don't record a level CC never received.
    if (sessionId && !sendPtyCommand(`/effort ${level}\r`)) return;
    setEffort(level);
    const api = (window.claude as any).modes;
    api?.set({ effort: level }).catch(() => {});
  };

  if (!open) return null;

  // Native sessions get a provider-scoped model catalog (grouped by provider),
  // NOT the Claude alias/effort/fast controls (those are PTY /model, /fast,
  // /effort writes that a native session has no PTY for). Selecting a model
  // calls native.setBinding for a mid-session model swap.
  //
  // The same catalog+providers.list() data flow also backs the LAUNCH-time
  // picker, model/ModelPicker.tsx (SessionStrip, the welcome form, the Resume
  // Browser, the pre-resume modal). This branch was NOT rewritten to consume
  // it: this is a click-to-swap-NOW picker (each row click immediately calls
  // setBinding, awaits the ack, and either closes on success or shows an inline
  // error while staying open) highlighting the session's CURRENT live binding.
  // ModelPicker is a pick-then-let-the-caller-decide picker (onSelect
  // fires synchronously on click; the caller — Resume's/Create's confirm
  // button — decides when anything actually happens). Forcing one component to
  // cover both interaction
  // models would need a mode flag threading through selection semantics,
  // ack timing, and error display — not a clean extraction, so this branch
  // is left as its own thing.
  // The native early-return branch used to live here: a second, hand-built model
  // list with its own search box and provider sections. It is gone. The dialog
  // below now serves BOTH runtimes off the shared <ModelPicker> — the same list
  // the five other pick surfaces use — so search, favourites and source filters
  // are finally available from the status-bar chip, which is where models are
  // actually changed. Effort and Fast stay Claude-Code-only; they are CC
  // concepts the native harness does not implement, and rendering them for a
  // native session would be a control that lies.

  const isNative = provider === 'native';

  /** What the picker should show as the session's current model.
   *
   *  The live bound id (App's SessionInfo.model, updated on every swap) is the
   *  truth; the persisted header binding is only a fallback for the moment
   *  before sessionsList lands. The owning provider is looked up in the catalog
   *  rather than taken from the binding, because a session can be bound to a
   *  model the stored binding no longer names — and requiring BOTH halves is
   *  what made this read "Choose a model…" on a session that plainly had one. */
  const nativeValue: ModelChoice | null = (() => {
    const modelId = currentModelId ?? nativeBinding?.modelId;
    if (!modelId) return null;
    // Last resort is an EMPTY provider id, not null: the picker falls back to
    // printing the raw model id when it can't match a catalog row, and a
    // truthful "openai/gpt-5.6-sol" beats "Choose a model…" on a session that
    // demonstrably has one. An empty id simply highlights no row.
    const providerId = catalog.find((m) => m.id === modelId)?.providerId ?? nativeBinding?.providerId ?? '';
    return { runtime: 'native', providerId, modelId };
  })();

  // "max" effort is top-tier-only (Opus 1M + Fable); disable the button otherwise.
  const maxAllowed = currentModel != null && MAX_EFFORT_MODELS.includes(currentModel);

  return createPortal(
    // Overlay layer L2 — theme-driven scrim/surface via Scrim/OverlayPanel.
    <>
      <Dialog open onClose={onClose} title={isNative ? "Model" : "Model & Effort"} size="panel" scrollBody={false}>

        {!loaded ? (
          <LoadingState what="models" />
        ) : (
          <div className="p-5 space-y-5">
            {/* Model — the SHARED picker, scoped to this session's runtime. A
                live session cannot move between runtimes (a CC session has a PTY
                and no binding; a native one has a binding and no PTY), so the
                other runtime's models are filtered out rather than offered and
                then refused. */}
            {/* No section label here — the dialog's own title ("Model" or
                "Model & Effort") already says it, and repeating it as a
                sub-header directly under a modal titled "Model" read as
                duplicated text once the picker opens straight into view. */}
            <section>
              <ModelPicker
                value={isNative ? nativeValue : (currentModel ? { runtime: 'claude', alias: currentModel } : null)}
                onSelect={(c) => { void applyChoice(c); }}
                includeClaude={!isNative}
                includeNative={isNative}
                // This dialog's whole job is "change the model" — the picker IS
                // the surface, so open straight to the favourites+search list
                // instead of making the status-bar chip cost two clicks.
                // 'inline' because the list must push Effort/Fast down rather
                // than the shared component's default float-over-everything
                // behaviour (built for a picker that's normally closed).
                defaultOpen
                layout="inline"
                // Lead with what's actually running, not just favourites — the
                // dialog opens with no click to get here, so a model you picked
                // once but never starred should still be the first thing you see.
                pinSelectedToTop
                onManageModels={() => window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'))}
              />
              {nativeError && <p className="text-xs text-destructive-fg mt-2">{nativeError}</p>}
              {nativeSwapping && <p className="text-xs text-fg-muted mt-2">Switching…</p>}
            </section>

            {/* Effort */}
            {/* Effort and Fast are Claude Code concepts — the native harness
                implements neither, so for a native session they are not
                rendered at all rather than shown inert. A control that does
                nothing is worse than a control that isn't there. */}
            {!isNative && (<>
              <section>
                <h3 className="block text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                  Effort Level
                </h3>
                <div className="grid grid-cols-5 gap-1.5">
                  {EFFORT_LEVELS.map((level) => {
                    const disabled = level === 'max' && !maxAllowed;
                    return (
                      <button
                        key={level}
                        onClick={() => !disabled && updateEffort(level)}
                        disabled={disabled}
                        title={disabled ? 'Max effort requires Opus or Fable' : undefined}
                        className={`py-1.5 text-xs rounded transition-colors capitalize ${
                          effort === level
                            ? 'bg-accent text-on-accent font-medium'
                            : disabled
                            ? 'bg-inset/50 text-fg-faint cursor-not-allowed'
                            : 'bg-inset text-fg-2 hover:bg-well'
                        }`}
                      >
                        {level}
                      </button>
                    );
                  })}
                </div>
                <p className="text-2xs text-fg-muted mt-1.5">
                  How hard Claude thinks before responding. Higher = slower but smarter.
                </p>
              </section>

              {/* Fast mode toggle */}
              <section>
                {/* K2: the icon moves out of the title and into the icon slot,
                    which is what that slot is for — inline, it was pushing the
                    title text off the alignment every other row shares. */}
                <SettingRow
                  variant="item"
                  icon={<FastIcon className="w-3.5 h-3.5 text-yellow-500" />}
                  title="Fast mode"
                  description="Same model, faster output streaming"
                  control={
                    // Was a fifth hand-rolled toggle geometry (32x16) with a
                    // hardcoded green-600 on-state. One geometry now, and the
                    // on-state is the theme's accent (changes 15/16). It already
                    // had role="switch" but no accessible name.
                    <Toggle
                      checked={fast}
                      onChange={handleFastToggle}
                      aria-label="Fast mode"
                    />
                  }
                />
              </section>
            </>)}
          </div>
        )}
      </Dialog>

      {/* Fast mode confirmation — L3 (critical/destructive) because enabling
         Fast mode bills per-token on top of any Pro/Max subscription. */}
      {fastConfirmOpen && (
        <>
          <Dialog
            open
            onClose={() => setFastConfirmOpen(false)}
            layer={3}
            destructive
            size="prompt"
            aria-label="Enable Fast mode?"
            scrollBody={false}
          >
            <div className="p-5 space-y-4">
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-full bg-[#FF9800]/15 border border-[#FF9800]/40 flex items-center justify-center text-[#FF9800]">
                  <FastIcon className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-fg">Enable Fast mode?</h3>
                  <p className="text-xs text-fg-muted mt-0.5">This costs extra money on top of your plan.</p>
                </div>
              </div>

              <div className="rounded border border-[#FF9800]/40 bg-[#FF9800]/10 p-3 space-y-1.5">
                <div className="text-xs font-semibold text-[#FF9800] uppercase tracking-wider">⚠ Billed Per Token</div>
                <div className="text-xs text-fg">
                  Fast mode routes requests through a priority tier with per-token billing:
                </div>
                <div className="text-xs text-fg font-mono">
                  <span className="text-fg-2">Input:</span> $30 / million tokens<br />
                  <span className="text-fg-2">Output:</span> $150 / million tokens
                </div>
                <div className="text-2xs text-fg-muted pt-1 border-t border-[#FF9800]/25">
                  Your Claude Pro/Max subscription does not cover these charges. They bill directly against API credits on your Anthropic account.
                </div>
              </div>

              <div className="text-xs text-fg-muted">
                You get the same model with faster streaming output. Turn off anytime from the status bar or this menu.
              </div>

              <div className="flex justify-end gap-2 pt-1">
                {/* Spec change 60: the filled-grey family (bg-inset/hover:bg-well)
                    collapses into the outline `secondary` — it's a genuine peer of
                    the confirm beside it, which ghost would under-weight. */}
                <Button variant="secondary" onClick={() => setFastConfirmOpen(false)}>
                  Cancel
                </Button>
                {/* Spec change 66: KEEPS #FF9800 + text-black. This is a billing-
                    consent warning colour (same family as the permission triad), not
                    a theme surface, so it must NOT become `primary` — the accent
                    would erase the "you are agreeing to charges" signal. Left
                    hand-rolled because the primitive's variants would fight the
                    custom fill; only radius (rounded → rounded-lg, the one control
                    radius) and the shared focus ring are normalized. */}
                <button
                  type="button"
                  onClick={() => {
                    applyFast(true);
                    setFastConfirmOpen(false);
                  }}
                  className={`px-3 py-1.5 text-xs rounded-lg bg-[#FF9800] text-black font-medium hover:bg-[#FF9800]/90 transition-colors ${FOCUS_RING}`}
                >
                  Enable & Accept Charges
                </button>
              </div>
            </div>
          </Dialog>
        </>
      )}
    </>,
    document.body,
  );
}
