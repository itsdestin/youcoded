import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';

// Hint copy keyed to spec bands: > 60 plenty, 20–60 getting tight, < 20 very low.
// Thresholds are intentionally coarser than contextColor() — the copy describes
// user intent (when to act), not the indicator color.
function hintFor(pct: number): string {
  if (pct > 60) return 'Plenty of room — no action needed.';
  if (pct >= 20) return 'Getting tight — consider compacting soon.';
  return 'Very low — compact now or Claude may start forgetting earlier context.';
}

// Match the color function in StatusBar.tsx exactly so the popup number tracks the chip.
function contextColor(pct: number): string {
  if (pct < 20) return 'text-[#DD4444]';
  if (pct < 50) return 'text-[#FF9800]';
  return 'text-[#4CAF50]';
}

// Explainer content — plain language for non-developer users.
// Uses curly apostrophes and em-dashes intentionally; do not replace with straight quotes or hyphens.
const INFO_SECTIONS: ExplainerSection[] = [
  {
    heading: 'Why it matters',
    paragraphs: [
      "The higher it is, the more Claude remembers — every file you opened, every decision you made together, the full thread of what you’re building. When it gets low, Claude may forget files you discussed earlier, lose track of decisions, or repeat questions it already asked. Running out mid-task usually means worse answers and extra back-and-forth.",
    ],
  },
  {
    heading: 'What fills it up',
    bullets: [
      { term: 'Your messages and Claude’s replies', text: 'Every turn of the conversation stays in memory.' },
      { term: 'Tool output', text: "When Claude reads files, runs commands, or lists directories, the results go into context too. This is usually the biggest contributor." },
      { term: 'Attached files and images', text: 'Anything you drag into the input bar.' },
      { term: 'Loaded skills', text: 'Installed skills contribute their instructions to every turn.' },
    ],
    paragraphs: ['Long sessions with lots of file reads fill it up fastest.'],
  },
  {
    heading: 'What to do when it gets low',
    bullets: [
      { term: 'Compact', text: 'Claude summarizes the conversation so far and keeps going in the same session. The thread stays alive. Use optional instructions to tell Claude what to prioritize keeping (e.g. code decisions vs. debugging output).' },
      { term: 'Clear', text: "Wipes the conversation and starts fresh in the same session. No summary is kept. Good when you’re switching to an unrelated task." },
      { term: 'New session', text: 'Opens a separate conversation from scratch and leaves this one intact. Good when you want to preserve this conversation’s state while working on something else. Use the + button in the session strip at the top of the window.' },
    ],
  },
];

const INFO_INTRO =
  "Context is Claude’s short-term memory for this conversation. The percentage shows how much room Claude has left before it starts forgetting the earliest messages.";

export interface ContextPopupProps {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  contextPercent: number | null;
  contextTokens: number | null;
  /** Dispatches a slash command through App.tsx's wrapper around dispatchSlashCommand. */
  onDispatch: (input: string) => void;
}

export default function ContextPopup({
  open,
  onClose,
  sessionId,
  contextPercent,
  contextTokens,
  onDispatch,
}: ContextPopupProps) {
  // Wire ESC key dismissal through the shared LIFO stack (EscCloseProvider).
  // Must be called unconditionally (React hooks rules) — soft-fails without a provider.
  useEscClose(open, onClose);

  // Reset transient view state when the popup closes so reopening always lands on the main view.
  useEffect(() => {
    if (!open) {
      setShowInfo(false);
      setCustomizing(false);
      setInstructions('');
    }
  }, [open]);

  // Track whether the user has opened the (i) explainer view.
  const [showInfo, setShowInfo] = useState(false);

  // customizing / instructions — not consumed until Task 6 where the chevron opens
  // an inline editor for custom compact instructions. Declared here to minimize churn.
  const [customizing, setCustomizing] = useState(false);
  const [instructions, setInstructions] = useState('');

  if (!open) return null;

  const pct = contextPercent ?? 0;

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-labelledby={showInfo ? undefined : 'context-popup-title'}
        aria-label={showInfo ? 'About Context' : undefined}
        className={`fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[320px] flex flex-col overflow-hidden ${showInfo ? 'h-[85vh]' : 'max-h-[85vh]'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {showInfo ? (
          // Explainer takes over the full panel frame; has its own header with Back + Close.
          <SettingsExplainer
            title="Context"
            intro={INFO_INTRO}
            sections={INFO_SECTIONS}
            onBack={() => setShowInfo(false)}
            onClose={onClose}
          />
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
              <h3 id="context-popup-title" className="text-sm font-semibold text-fg">Context</h3>
              <div className="flex items-center gap-1">
                {/* (i) button — opens the explainer view explaining what context percentage means */}
                <InfoIconButton onClick={() => setShowInfo(true)} />
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="text-fg-muted hover:text-fg leading-none w-6 h-6 flex items-center justify-center rounded-sm hover:bg-inset"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Current state */}
            <div className="px-4 py-4 space-y-3">
              <div className="text-center">
                <div className={`text-3xl font-bold ${contextColor(pct)}`}>
                  {contextPercent != null ? `${contextPercent}%` : '--'}
                </div>
                {contextTokens != null && (
                  <div className="text-xs text-fg-muted mt-1">
                    {contextTokens.toLocaleString()} tokens remaining
                  </div>
                )}
                {contextPercent != null && (
                  <p className="text-xs text-fg-2 mt-2">{hintFor(contextPercent)}</p>
                )}
              </div>
            </div>

            {/* Actions: default view shows split Compact + Clear; customizing shows the editor. */}
            <div className="px-4 pb-4 pt-2 space-y-3 border-t border-edge">
              {customizing ? (
                <div className="space-y-2">
                  <label htmlFor="compact-instructions" className="block text-xs font-medium text-fg-muted tracking-wider uppercase">
                    Keep these priorities (optional)
                  </label>
                  <textarea
                    id="compact-instructions"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="e.g. keep code decisions and architecture; drop debugging output"
                    rows={3}
                    className="w-full px-2 py-1.5 text-xs bg-inset border border-edge rounded-sm text-fg focus:outline-none focus:ring-1 focus:ring-accent resize-none"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        // Back resets draft so it doesn't leak if the user cancels then reopens.
                        setCustomizing(false);
                        setInstructions('');
                      }}
                      className="flex-1 py-2 px-3 text-sm rounded-sm border border-edge bg-panel text-fg-2 hover:bg-inset transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => {
                        const trimmed = instructions.trim();
                        if (!trimmed || !sessionId) return;
                        onDispatch(`/compact ${trimmed}`);
                        onClose();
                      }}
                      disabled={!sessionId || instructions.trim().length === 0}
                      className="flex-1 py-2 px-3 text-sm font-medium rounded-sm bg-accent text-on-accent hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Compact with instructions
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Split-button: main = /compact, chevron = open inline editor. */}
                  <div>
                    <div className="flex w-full rounded-sm overflow-hidden border border-accent">
                      <button
                        onClick={() => {
                          onDispatch('/compact');
                          onClose();
                        }}
                        disabled={!sessionId}
                        className="flex-1 py-2 px-3 text-sm font-medium bg-accent text-on-accent hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Compact conversation
                      </button>
                      <button
                        onClick={() => setCustomizing(true)}
                        disabled={!sessionId}
                        aria-label="Customize compact instructions"
                        className="px-2 bg-accent text-on-accent border-l border-on-accent/30 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Clear secondary action. */}
                  <div>
                    <button
                      onClick={() => {
                        onDispatch('/clear');
                        onClose();
                      }}
                      disabled={!sessionId}
                      className="w-full py-2 px-3 text-sm rounded-sm border border-edge bg-panel text-fg-2 hover:bg-inset transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Clear and start over
                    </button>
                    <p className="text-[11px] text-fg-muted mt-1 leading-snug">
                      Erases the visible timeline and resets Claude's memory for this session. No summary is kept.
                    </p>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </OverlayPanel>
    </>,
    document.body,
  );
}
