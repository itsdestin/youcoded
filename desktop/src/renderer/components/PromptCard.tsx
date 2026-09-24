import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InteractivePrompt } from '../state/chat-types';
import { TRUST_PROMPT_TITLE } from '../parser/ink-select-parser';
import { CheckIcon } from './Icons';
import { Button, ButtonVariant } from './ui/Button';
import { isAndroid } from '../platform';
import { isTypingTarget } from '../utils/is-typing-target';
import { useCardKeysLive } from '../state/card-keys-context';
import { PROMPT_FAILURE_COPY, type PromptAnswerResult } from '../state/prompt-input';

export type PromptCardButton = InteractivePrompt['buttons'][number];

interface Props {
  prompt: InteractivePrompt;
  sessionId: string;
  /** Receives the whole button, not just its `input` — a button may carry a
   *  second `submitInput` write (see state/prompt-input.ts). May return the
   *  answer's outcome: a menu with no printed numbers is answered by verified
   *  navigation, which can refuse (the menu changed) — the card then says so
   *  instead of pretending it was answered. */
  onSelect: (button: PromptCardButton, label: string) => void | Promise<PromptAnswerResult>;
  /** Window-level Arrow/Enter/1–9 handling. Off for feeds that mount several
   *  cards at once (the buddy overlay), where a global listener per card would
   *  race. */
  keyboardShortcuts?: boolean;
}

/** A sticky choice: it writes a preference into Claude Code's global config
 *  rather than just answering this prompt, so a mis-click follows the user
 *  forever. "Don't ask me again" on the Resume Session menu sets
 *  `resumeReturnDismissed: true` in ~/.claude.json and the prompt then never
 *  appears again on ANY session (read out of CC 2.1.220's bundle, 2026-07-26).
 *  These get a confirm step — the same treatment ToolCard gives a deny-listed
 *  "Always allow". */
function isSticky(label: string): boolean {
  // "Use this and all future MCP servers in this project" (CC 2.1.281) is the
  // same kind of choice: it turns on every MCP server the folder ever adds.
  return /don'?t ask (me )?again|never ask|stop asking|all future/i.test(label);
}

/** A choice that backs out of or ends the session rather than continuing. */
function isExit(label: string): boolean {
  return /^(no|don'?t|exit|quit|cancel|abort|decline|reject)\b/i.test(label.trim())
    || /\bexit\b/i.test(label);
}

/**
 * The option Claude Code itself highlights: the one it marks "(recommended)",
 * else the first. Exactly one button wears the accent so the card reads the way
 * the CLI menu does — three identically-blue buttons was a big part of why this
 * card felt unparsed next to the permission prompt.
 */
function defaultIndex(buttons: PromptCardButton[], cliDefault?: number): number {
  // A dialog read with its cursor (CC 2.1.281's startup dialogs) starts where
  // Claude Code's own cursor is — "No, exit" / "Continue without using this MCP
  // server" — so an Enter on the card can never do more than an Enter in the
  // terminal would.
  if (cliDefault !== undefined && cliDefault >= 0 && cliDefault < buttons.length) return cliDefault;
  const recommended = buttons.findIndex((b) => /\brecommended\b/i.test(b.label));
  return recommended >= 0 ? recommended : 0;
}

function variantFor(label: string, index: number, defIdx: number): ButtonVariant {
  if (isSticky(label) || isExit(label)) return 'danger-outline';
  return index === defIdx ? 'primary' : 'secondary';
}

/**
 * The digit this button will actually type. `menuToButtons` sends a bare option
 * number for CC's numbered menus, so showing it isn't decoration — it IS the
 * keystroke, which is what makes the 1–9 shortcuts below honest rather than a
 * second, parallel mapping that could drift. null for the arrow-navigation
 * fallback (a menu whose options carried no number).
 */
function shortcutOf(button: PromptCardButton): string | null {
  return /^[1-9]$/.test(button.input) ? button.input : null;
}

/**
 * Parser-detected prompt card — Claude Code's own Ink select menus (folder
 * trust, Resume Session, theme/login pickers, usage-limit menu) surfaced as
 * chat UI.
 *
 * Affordances deliberately mirror the permission prompt in ToolCard, the app's
 * other "answer this now" control: roving Arrow Left/Right selection that moves
 * real DOM focus, Enter to activate, and a consequence-confirm on the one choice
 * that can't be taken back. Plus the CLI's own 1–9 number keys.
 */
export default React.memo(function PromptCard({ prompt, onSelect, keyboardShortcuts = true }: Props) {
  const buttons = prompt.buttons;
  const defIdx = useMemo(() => defaultIndex(buttons, prompt.defaultIndex), [buttons, prompt.defaultIndex]);
  const [focusIdx, setFocusIdx] = useState(defIdx);
  // Index of a sticky button awaiting its second click, or -1.
  const [confirmIdx, setConfirmIdx] = useState(-1);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  // A verified answer in flight (keys are being typed one at a time) and, if it
  // was refused, why. While sending, every button is disabled: a second click
  // would start a second, interleaved cursor walk.
  const [sending, setSending] = useState(false);
  // The guard itself is a ref, not the state: two activations in one frame
  // (a click and an Enter, or a double click) both run before React re-renders
  // with `sending` true, and each would start its own cursor walk.
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const activate = useCallback(
    (index: number) => {
      const button = buttons[index];
      if (!button) return;
      if (isSticky(button.label) && confirmIdx !== index) {
        setConfirmIdx(index);
        return;
      }
      setConfirmIdx(-1);
      if (sendingRef.current) return;
      const outcome = onSelect(button, button.label);
      if (outcome && typeof (outcome as Promise<PromptAnswerResult>).then === 'function') {
        sendingRef.current = true;
        setSending(true);
        setError(null);
        void (outcome as Promise<PromptAnswerResult>).then((r) => {
          sendingRef.current = false;
          if (!mounted.current) return;
          setSending(false);
          if (!r.ok) setError(PROMPT_FAILURE_COPY[r.reason]);
        });
      }
    },
    [buttons, confirmIdx, onSelect],
  );

  // Keyboard: arrows rove, Enter activates, 1–9 pick directly. Window-level and
  // suspended once answered, matching ToolCard's permission row so the two
  // controls behave identically.
  const completed = prompt.completed;
  // The folder-trust dialog is owned by TrustGate's full-screen takeover, which
  // renders this same prompt's options as its own buttons. This card is mounted
  // BEHIND that overlay, so leaving the shortcuts live would let a stray "1"
  // trust a folder without the user ever seeing what they answered.
  // A card in a hidden chat (every session's ChatView stays mounted) must not
  // answer keys meant for the chat on screen — see state/card-keys-context.ts.
  const keysLive = useCardKeysLive();
  const shortcutsOn = keyboardShortcuts && keysLive && prompt.title !== TRUST_PROMPT_TITLE;
  useEffect(() => {
    if (completed || !shortcutsOn) return;
    const handler = (e: KeyboardEvent) => {
      // A key InputBar already acted on (it sends on a body-level Enter) is not
      // an answer to this card.
      if (e.defaultPrevented) return;
      if (isTypingTarget(e.target as Element)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setConfirmIdx(-1);
        setFocusIdx((prev) => {
          const count = buttons.length;
          const next = e.key === 'ArrowRight' ? (prev + 1) % count : (prev - 1 + count) % count;
          buttonsRef.current[next]?.focus();
          return next;
        });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        activate(focusIdx);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const index = buttons.findIndex((b) => shortcutOf(b) === e.key);
        if (index < 0) return;
        e.preventDefault();
        setFocusIdx(index);
        activate(index);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [completed, shortcutsOn, buttons, focusIdx, activate]);

  if (completed) {
    return (
      <div className="flex justify-start px-4 py-0.5">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-inset px-2 py-1">
          <div className="border border-edge rounded-lg px-3 py-2 flex items-center gap-1.5">
            <CheckIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
            <span className="text-fg-faint text-xs select-none">|</span>
            <span className="text-xs font-medium text-fg-2">{prompt.title}:</span>
            <span className="text-xs text-fg font-medium">{completed}</span>
          </div>
        </div>
      </div>
    );
  }

  // Tracks focusIdx (the roving selection), NOT :focus-visible — same reasoning
  // as ToolCard's permission row: the arrow keys move real DOM focus, so leaving
  // ui/Button's focus ring on as well would stack two rings on one button.
  const ring = 'ring-2 ring-accent/50';

  return (
    <div className="flex justify-start px-4 py-1">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-inset px-2 py-1">
        <div className="border border-edge rounded-lg overflow-hidden">
          {/* Header — the prompt's title, as the parser resolved it */}
          <div className="flex items-center gap-1.5 px-3 py-2">
            <span className="text-fg-faint text-xs select-none">|</span>
            <span className="text-xs font-medium text-fg-2">{prompt.title}</span>
          </div>
          {/* Description — the prompt's OWN body text. The parser bounds it to
              CC's prompt box, so replayed transcript output can't leak in here */}
          {prompt.description && (
            <div className="px-3 py-1.5 text-xs text-fg-dim leading-relaxed border-t border-edge">
              {prompt.description}
            </div>
          )}
          {/* Options wrap rather than overflow: these labels are CC's own
              sentences ("Resume full session as-is"), not Yes/No, and three of
              them don't fit one row on a phone. */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-edge bg-inset/30">
            {buttons.map((btn, index) => {
              const shortcut = shortcutOf(btn);
              const confirming = confirmIdx === index;
              const selected = focusIdx === index ? ring : '';
              return (
                <Button
                  key={btn.label}
                  ref={(el) => { buttonsRef.current[index] = el; }}
                  size="sm"
                  variant={confirming ? 'danger' : variantFor(btn.label, index, defIdx)}
                  // py-2 on Android for a touch-sized target, same as ToolCard's
                  // permission buttons (`pad`).
                  className={[isAndroid() ? 'py-2' : '', selected].filter(Boolean).join(' ')}
                  disabled={sending}
                  onClick={() => activate(index)}
                  onMouseEnter={() => setFocusIdx(index)}
                  title={confirming ? 'Sets a Claude Code preference for every future session' : undefined}
                >
                  {shortcut && (
                    <span className="text-3xs opacity-60 tabular-nums" aria-hidden>
                      {shortcut}
                    </span>
                  )}
                  {confirming ? 'Click again to confirm' : btn.label}
                </Button>
              );
            })}
          </div>
          {error && (
            <div role="alert" className="px-3 py-1.5 text-xs text-fg-dim leading-relaxed border-t border-edge">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
