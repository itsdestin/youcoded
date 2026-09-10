import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, Textarea } from './ui';
import { useEscClose } from '../hooks/use-esc-close';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';
import { useTheme } from '../state/theme-context';

// Hint copy keyed to spec bands: > 60 plenty, 20–60 getting tight, < 20 very low.
// Thresholds are intentionally coarser than contextColor() — the copy describes
// user intent (when to act), not the indicator color.
function hintFor(pct: number): string {
  if (pct > 60) return 'Plenty of room — no action needed.';
  if (pct >= 20) return 'Getting tight — consider compacting soon.';
  return 'Very low — compact now or your assistant may start forgetting earlier context.';
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
      "The higher it is, the more your assistant remembers — every file you opened, every decision you made together, the full thread of what you’re building. When it gets low, your assistant may forget files you discussed earlier, lose track of decisions, or repeat questions it already asked. Running out mid-task usually means worse answers and extra back-and-forth.",
    ],
  },
  {
    heading: 'What fills it up',
    bullets: [
      { term: 'Your messages and your assistant’s replies', text: 'Every turn of the conversation stays in memory.' },
      { term: 'Tool output', text: "When your assistant reads files, runs commands, or lists directories, the results go into context too. This is usually the biggest contributor." },
      { term: 'Attached files and images', text: 'Anything you drag into the input bar.' },
      { term: 'Loaded skills', text: 'Installed skills contribute their instructions to every turn.' },
    ],
    paragraphs: ['Long sessions with lots of file reads fill it up fastest.'],
  },
  {
    heading: 'What to do when it gets low',
    bullets: [
      { term: 'Compact', text: 'Your assistant summarizes the conversation so far and keeps going in the same session. The thread stays alive. Use optional instructions to tell it what to prioritize keeping (e.g. code decisions vs. debugging output).' },
      { term: 'Clear', text: "Wipes the conversation and starts fresh in the same session. No summary is kept. Good when you’re switching to an unrelated task." },
      { term: 'New session', text: 'Opens a separate conversation from scratch and leaves this one intact. Good when you want to preserve this conversation’s state while working on something else. Use the + button in the session strip at the top of the window.' },
    ],
  },
];

const INFO_INTRO =
  "Context is your assistant’s short-term memory for this conversation. The percentage shows how much room it has left before it starts forgetting the earliest messages.";

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

  // Status-bar pill display mode (percentage vs token counts). Read from the
  // theme context so the choice persists and syncs to peer windows like the
  // other appearance preferences.
  const { contextDisplay, setContextDisplay } = useTheme();

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
      {/* The explainer used to swap max-h-[85vh] for a hard h-[85vh], so opening
          it made the panel JUMP to full height and closing it snapped back.
          Dialog cannot express a fixed height, so both views now hug their
          content up to the same ceiling. */}
      <Dialog
        open
        onClose={onClose}
        size="prompt"
        // K12: the explainer no longer paints a header — Dialog does, and the
        // back chevron is Dialog's `onBack`, which tranche 2 added for exactly
        // this and which nothing had used until now.
        title={showInfo ? 'About Context' : 'Context'}
        onBack={showInfo ? () => setShowInfo(false) : undefined}
        headerActions={showInfo ? undefined : <InfoIconButton onClick={() => setShowInfo(true)} />}
        // The explainer takes the shell's scroll body (and its edge fades); the
        // main view still owns its own surface.
        scrollBody={showInfo}
      >
        {showInfo ? (
          <SettingsExplainer intro={INFO_INTRO} sections={INFO_SECTIONS} />
        ) : (
          <>
            {/* Current state */}
            <div className="px-4 py-4 space-y-3">
              <div className="text-center">
                <div className={`text-3xl font-bold ${contextColor(pct)}`}>
                  {contextPercent != null ? `${contextPercent}%` : '--'}
                </div>
                {contextTokens != null && (
                  <div className="text-xs text-fg-muted mt-1">
                    {/* `contextTokens` is the context WINDOW SIZE, not the remainder:
                        hook-scripts/statusline.sh sets it from `context_window_size`.
                        This line previously read "N tokens remaining", which reported
                        a full window on a nearly-exhausted session — the exact
                        misleading-number failure docs/error-message-standards.md
                        forbids. Both figures are shown, and the remaining count is
                        marked approximate because it is derived from an
                        already-rounded percentage. */}
                    {contextPercent != null && (
                      <>~{Math.round(contextTokens * (contextPercent / 100)).toLocaleString()} of </>
                    )}
                    {contextTokens.toLocaleString()} tokens remaining
                  </div>
                )}
                {contextPercent != null && (
                  <p className="text-xs text-fg-2 mt-2">{hintFor(contextPercent)}</p>
                )}
              </div>

              {/* Status-bar pill display mode. Lives here rather than in the
                  Preferences popup because this is where the user is already
                  thinking about the number the pill shows. Presentation only —
                  the color band is driven by the percentage in BOTH modes. */}
              <div className="pt-1">
                <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase mb-1.5">
                  Status bar shows
                </div>
                <div role="radiogroup" aria-label="Context pill display" className="flex w-full rounded-lg overflow-hidden border border-edge-dim">
                  {(['percent', 'tokens'] as const).map((mode, i) => (
                    <button
                      key={mode}
                      role="radio"
                      aria-checked={contextDisplay === mode}
                      onClick={() => setContextDisplay(mode)}
                      className={`flex-1 py-1.5 px-2 text-xs transition-colors ${i === 1 ? 'border-l border-edge-dim' : ''} ${
                        contextDisplay === mode
                          ? 'bg-accent text-on-accent font-medium'
                          : 'bg-panel text-fg-2 hover:bg-inset'
                      }`}
                    >
                      {mode === 'percent' ? 'Percentage' : 'Token counts'}
                    </button>
                  ))}
                </div>
                <p className="text-2xs text-fg-muted mt-1 leading-snug">
                  {contextDisplay === 'percent'
                    ? 'Pill reads “Context: 45% Remaining”.'
                    : 'Pill reads “Context: 35.2k / 64k” — tokens used out of the window.'}
                </p>
              </div>
            </div>

            {/* Actions: default view shows split Compact + Clear; customizing shows the editor. */}
            <div className="px-4 pb-4 pt-2 space-y-3 border-t border-edge">
              {customizing ? (
                <div className="space-y-2">
                  <label htmlFor="compact-instructions" className="block text-3xs font-medium text-fg-muted tracking-wider uppercase">
                    Keep these priorities (optional)
                  </label>
                  {/* Change 42: this was the `border-edge rounded-sm focus:ring-1`
                      recipe — the losing one of the two. It becomes FIELD:
                      border-edge-dim, rounded-lg, and focus by border rather than
                      ring. resize-none is the primitive's default. The Back /
                      Compact buttons stay in the row BELOW, so no InputGroup. */}
                  <Textarea
                    id="compact-instructions"
                    size="md"
                    className="w-full"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="e.g. keep code decisions and architecture; drop debugging output"
                    rows={3}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="lg"
                      onClick={() => {
                        // Back resets draft so it doesn't leak if the user cancels then reopens.
                        setCustomizing(false);
                        setInstructions('');
                      }}
                      className="flex-1"
                    >
                      Back
                    </Button>
                    <Button
                      size="lg"
                      onClick={() => {
                        const trimmed = instructions.trim();
                        if (!trimmed || !sessionId) return;
                        onDispatch(`/compact ${trimmed}`);
                        onClose();
                      }}
                      disabled={!sessionId || instructions.trim().length === 0}
                      className="flex-1"
                    >
                      Compact with instructions
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Split-button: main = /compact, chevron = open inline editor. */}
                  <div>
                    {/* SPLIT BUTTON — a documented exception to "every button is a
                        <Button>" (spec §11.8 C, Destin's call). The two halves share
                        one clipped wrapper so the chevron reads as "options for THAT
                        action"; giving either half its own rounded-lg corner would put
                        a rounded edge inside the clip and break the seam. Kept
                        hand-rolled, but adopting the app's radius and the real
                        background-fade hover (was hover:opacity-90, which fades the
                        label too — spec change 53). Don't "finish" this by splitting
                        it into two Buttons; that was considered and rejected. */}
                    <div className="flex w-full rounded-lg overflow-hidden border border-accent">
                      <button
                        onClick={() => {
                          onDispatch('/compact');
                          onClose();
                        }}
                        disabled={!sessionId}
                        className="flex-1 py-2 px-3 text-sm font-medium bg-accent text-on-accent hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Compact conversation
                      </button>
                      <button
                        onClick={() => setCustomizing(true)}
                        disabled={!sessionId}
                        aria-label="Customize compact instructions"
                        className="px-2 bg-accent text-on-accent border-l border-on-accent/30 hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Clear secondary action.
                      danger-outline per spec change 73: /clear throws the whole
                      conversation away with no summary kept, but it used to look
                      like a plain neutral button sitting right under the harmless
                      Compact. The red outline is a deliberate escalation so the
                      consequence is visible before the click, not after. */}
                  <div>
                    <Button
                      variant="danger-outline"
                      size="lg"
                      onClick={() => {
                        onDispatch('/clear');
                        onClose();
                      }}
                      disabled={!sessionId}
                      className="w-full"
                    >
                      Clear and start over
                    </Button>
                    <p className="text-2xs text-fg-muted mt-1 leading-snug">
                      Erases the visible timeline and resets your assistant's memory for this session. No summary is kept.
                    </p>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </Dialog>
    </>,
    document.body,
  );
}
