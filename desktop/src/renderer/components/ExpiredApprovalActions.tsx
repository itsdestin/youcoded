import React, { useEffect, useRef, useState } from 'react';
import { Button } from './ui';
import { getVisibleScreenText } from '../hooks/terminal-registry';
import { keptCardButtons, type PromptButton } from '../parser/ink-select-parser';

// --- Kept-card actions (a hook socket died, Claude Code's menu may be live) ---
//
// Ported from PR #278 (2026-07-30 permission-ask-timeout spec §3). The card's
// own buttons answered through the hook socket, which is gone. Re-read the
// terminal: if Claude Code's menu is still up and EVERY row carries a printed
// number, offer that menu's own rows as buttons that type the number (a digit
// picks its row regardless of the cursor — ink-select-parser.menuToButtons).
// Otherwise say so and offer Dismiss. Resolution comes from the prompt
// detector's menu-gone rule (or Dismiss), never from the click itself: nothing
// here can confirm the keystroke landed.
//
// The menu must be THIS card's ask (keptCardButtons binds it to the call's
// command/file/tool) — a card whose ask was already answered must never answer
// the next one — and a click re-reads the screen and re-checks that binding
// before typing, so a 2s-old read can never pick a row (review 2026-09-23, F1).
const REBIND_POLL_MS = 2000;
const REBIND_REARM_MS = 2000;

export function ExpiredApprovalActions({ sessionId, toolName, input, onDismiss }: {
  sessionId?: string;
  toolName: string;
  input: Record<string, unknown> | undefined;
  onDismiss: () => void;
}) {
  const [buttons, setButtons] = useState<PromptButton[] | null>(null);
  const [clicked, setClicked] = useState(false);
  const [changed, setChanged] = useState(false);
  const inputRef = useRef(input);
  inputRef.current = input;
  const rearm = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const read = () => {
      const screen = getVisibleScreenText(sessionId);
      setButtons(keptCardButtons(screen, toolName, inputRef.current));
    };
    read();
    const poll = setInterval(read, REBIND_POLL_MS);
    return () => clearInterval(poll);
  }, [sessionId, toolName]);
  useEffect(() => () => { if (rearm.current) clearTimeout(rearm.current); }, []);

  const press = (b: PromptButton) => {
    if (!sessionId || clicked) return;
    // Re-read NOW: the button came from a read up to REBIND_POLL_MS old.
    const fresh = keptCardButtons(getVisibleScreenText(sessionId), toolName, inputRef.current);
    const same = fresh?.find((f) => f.label === b.label && f.input === b.input);
    setButtons(fresh);
    if (!same) { setChanged(true); return; }
    setChanged(false);
    setClicked(true);
    // A deliberate menu-driving write (pty-input-gate.ts header): a bare digit,
    // never arrows + Enter.
    window.claude.session.sendInput(sessionId, b.input);
    rearm.current = setTimeout(() => setClicked(false), REBIND_REARM_MS);
  };

  return (
    <div className="px-3 py-2 border-t border-edge bg-inset/30 space-y-2 text-xs text-fg-dim">
      <p className="leading-relaxed">
        This card&apos;s buttons stopped working, but Claude may still be waiting in terminal view.
        {buttons ? ' These options come straight from that menu:' : ' Answer it there, or dismiss this if you already did.'}
      </p>
      {buttons && (
        <div className="flex flex-wrap gap-2">
          {buttons.map((b) => (
            <Button key={b.label} variant="secondary" size="sm" disabled={clicked} onClick={() => press(b)}>
              {b.label}
            </Button>
          ))}
        </div>
      )}
      {changed && (
        <p role="alert" className="text-3xs text-fg-muted leading-relaxed">
          The terminal&apos;s menu changed before that went through, so nothing was sent.
        </p>
      )}
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss — I answered in the terminal
      </Button>
    </div>
  );
}
