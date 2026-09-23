import React, { useEffect, useRef, useState } from 'react';
import { Button } from './ui';
import { getVisibleScreenText } from '../hooks/terminal-registry';
import { parseInkSelect, rebindButtons, type PromptButton } from '../parser/ink-select-parser';

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
const REBIND_POLL_MS = 2000;
const REBIND_REARM_MS = 2000;

export function ExpiredApprovalActions({ sessionId, toolName, onDismiss }: {
  sessionId?: string;
  toolName: string;
  onDismiss: () => void;
}) {
  const [buttons, setButtons] = useState<PromptButton[] | null>(null);
  const [clicked, setClicked] = useState(false);
  const rearm = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const read = () => {
      const screen = getVisibleScreenText(sessionId);
      setButtons(rebindButtons(screen ? parseInkSelect(screen) : null, toolName));
    };
    read();
    const poll = setInterval(read, REBIND_POLL_MS);
    return () => clearInterval(poll);
  }, [sessionId, toolName]);
  useEffect(() => () => { if (rearm.current) clearTimeout(rearm.current); }, []);

  const press = (b: PromptButton) => {
    if (!sessionId || clicked) return;
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
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss — I answered in the terminal
      </Button>
    </div>
  );
}
