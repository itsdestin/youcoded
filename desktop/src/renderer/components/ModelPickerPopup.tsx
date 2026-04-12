import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelAlias } from './StatusBar';
import { Scrim, OverlayPanel } from './overlays/Overlay';

// Model + effort + fast picker. Replaces the cycle-only status bar chip with
// a full picker. Invoked by:
//   • Clicking the model chip (future enhancement — currently still cycles)
//   • Typing /model, /fast, or /effort with no args
//   • Future: status bar fast/effort chips
//
// Effort and fast are DestinCode-local state (Claude Code doesn't transcribe
// them) — we trust the popup as source of truth and forward to PTY on change.

const MODELS: { id: ModelAlias; label: string }[] = [
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus[1m]', label: 'Opus 1M' },
];

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

  const updateFast = (v: boolean) => {
    setFast(v);
    const api = (window.claude as any).modes;
    api?.set({ fast: v }).catch(() => {});
    // Forward to Claude Code via PTY — command affects the running session
    if (sessionId) {
      window.claude.session.sendInput(sessionId, `/fast ${v ? 'on' : 'off'}\r`);
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
                    className={`flex-1 py-2 px-3 text-sm rounded transition-colors ${
                      currentModel === m.id
                        ? 'bg-accent text-on-accent font-medium'
                        : 'bg-inset text-fg-2 hover:bg-well'
                    }`}
                  >
                    {m.label}
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
                    <span>⚡</span> Fast mode
                  </div>
                  <div className="text-xs text-fg-muted">Same model, faster output streaming</div>
                </div>
                <button
                  onClick={() => updateFast(!fast)}
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
    </>,
    document.body,
  );
}
