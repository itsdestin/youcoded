import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelAlias } from './StatusBar';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { FastIcon } from './Icons';

// Model + effort + fast picker. Replaces the cycle-only status bar chip with
// a full picker. Invoked by:
//   • Clicking the model chip (future enhancement — currently still cycles)
//   • Typing /model, /fast, or /effort with no args
//   • Future: status bar fast/effort chips
//
// Effort and fast are YouCoded-local state (Claude Code doesn't transcribe
// them) — we trust the popup as source of truth and forward to PTY on change.

const MODELS: { id: ModelAlias; label: string }[] = [
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus[1m]', label: 'Opus 1M' },
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
    tagline: 'Most powerful — 1M context',
    pros: ['Deepest reasoning & analysis', '1 million token context window', 'Best for complex multi-step tasks'],
    cons: ['Slowest responses', 'Uses more plan capacity'],
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
                <div key={pro} className="flex items-start gap-1.5 text-[11px] text-fg-2 leading-snug">
                  <span className="text-green-500 shrink-0 font-bold mt-px">✓</span>
                  <span>{pro}</span>
                </div>
              ))}
            </div>
            {info.cons.length > 0 && (
              <div className="space-y-1 mt-2 pt-2 border-t border-edge-dim">
                {info.cons.map((con) => (
                  <div key={con} className="flex items-start gap-1.5 text-[11px] text-fg-muted leading-snug">
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

interface Props {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  currentModel: ModelAlias | null;
  onSelectModel: (m: ModelAlias) => void;
}

export default function ModelPickerPopup({ open, onClose, sessionId, currentModel, onSelectModel }: Props) {
  const [fast, setFast] = useState(false);
  const [effort, setEffort] = useState<EffortLevel>('auto');
  const [loaded, setLoaded] = useState(false);
  // Enabling fast mode is a paid action (API billing, not Pro/Max subscription) —
  // gate behind an explicit confirmation popup so it can't be flipped accidentally.
  const [fastConfirmOpen, setFastConfirmOpen] = useState(false);

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
    // If user switches off Opus while max-effort is set, downgrade silently —
    // Claude Code rejects max on non-opus and we'd get into an inconsistent state.
    if (effort === 'max' && m !== 'opus[1m]') {
      updateEffort('auto');
    }
  };

  const applyFast = (v: boolean) => {
    setFast(v);
    const api = (window.claude as any).modes;
    api?.set({ fast: v }).catch(() => {});
    // Forward to Claude Code via PTY — command affects the running session
    if (sessionId) {
      window.claude.session.sendInput(sessionId, `/fast ${v ? 'on' : 'off'}\r`);
    }
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
    setEffort(level);
    const api = (window.claude as any).modes;
    api?.set({ effort: level }).catch(() => {});
    if (sessionId) {
      window.claude.session.sendInput(sessionId, `/effort ${level}\r`);
    }
  };

  if (!open) return null;

  // "max" effort is opus-only; disable the button otherwise.
  const maxAllowed = currentModel === 'opus[1m]';

  return createPortal(
    // Overlay layer L2 — theme-driven scrim/surface via Scrim/OverlayPanel.
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-md w-[calc(100%-2rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <h3 className="text-sm font-semibold text-fg">Model &amp; Effort</h3>
          <button onClick={onClose} className="text-fg-muted hover:text-fg transition-colors w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {!loaded ? (
          <div className="p-8 text-center text-sm text-fg-muted">Loading…</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* Model */}
            <section>
              <label className="block text-xs font-medium text-fg-muted tracking-wider uppercase mb-2">Model</label>
              <div className="flex gap-2">
                {MODELS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => handleModelSelect(m.id)}
                    className={`flex-1 py-2 px-3 text-sm rounded transition-colors flex items-center justify-center ${
                      currentModel === m.id
                        ? 'bg-accent text-on-accent font-medium'
                        : 'bg-inset text-fg-2 hover:bg-well'
                    }`}
                  >
                    {m.label}
                    <ModelInfoTooltip model={m.id} />
                  </button>
                ))}
              </div>
            </section>

            {/* Effort */}
            <section>
              <label className="block text-xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                Effort Level
              </label>
              <div className="grid grid-cols-5 gap-1.5">
                {EFFORT_LEVELS.map((level) => {
                  const disabled = level === 'max' && !maxAllowed;
                  return (
                    <button
                      key={level}
                      onClick={() => !disabled && updateEffort(level)}
                      disabled={disabled}
                      title={disabled ? 'Max effort requires Opus' : undefined}
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
              <p className="text-[11px] text-fg-muted mt-1.5">
                How hard Claude thinks before responding. Higher = slower but smarter.
              </p>
            </section>

            {/* Fast mode toggle */}
            <section>
              <div className="flex items-start justify-between gap-3 p-2 rounded hover:bg-inset">
                <div className="flex-1">
                  <div className="text-sm text-fg flex items-center gap-1.5">
                    <FastIcon className="w-3.5 h-3.5 text-yellow-500" /> Fast mode
                  </div>
                  <div className="text-xs text-fg-muted">Same model, faster output streaming</div>
                </div>
                <button
                  onClick={handleFastToggle}
                  className={`shrink-0 w-8 h-4 rounded-full transition-colors relative ${fast ? 'bg-green-600' : 'bg-inset border border-edge-dim'}`}
                  role="switch"
                  aria-checked={fast}
                >
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${fast ? 'left-4' : 'left-0.5'}`} />
                </button>
              </div>
            </section>
          </div>
        )}
      </OverlayPanel>

      {/* Fast mode confirmation — L3 (critical/destructive) because enabling
         Fast mode bills per-token on top of any Pro/Max subscription. */}
      {fastConfirmOpen && (
        <>
          <Scrim layer={3} onClick={() => setFastConfirmOpen(false)} />
          <OverlayPanel
            layer={3}
            destructive
            role="alertdialog"
            aria-modal={true}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-sm w-[calc(100%-2rem)]"
            onClick={(e) => e.stopPropagation()}
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
                <div className="text-[11px] text-fg-muted pt-1 border-t border-[#FF9800]/25">
                  Your Claude Pro/Max subscription does not cover these charges. They bill directly against API credits on your Anthropic account.
                </div>
              </div>

              <div className="text-xs text-fg-muted">
                You get the same model with faster streaming output. Turn off anytime from the status bar or this menu.
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setFastConfirmOpen(false)}
                  className="px-3 py-1.5 text-xs rounded bg-inset text-fg-2 hover:bg-well transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    applyFast(true);
                    setFastConfirmOpen(false);
                  }}
                  className="px-3 py-1.5 text-xs rounded bg-[#FF9800] text-black font-medium hover:brightness-110 transition-all"
                >
                  Enable & Accept Charges
                </button>
              </div>
            </div>
          </OverlayPanel>
        </>
      )}
    </>,
    document.body,
  );
}
