import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from './ui';
import { BackIcon, ForwardIcon } from './Icons';

interface TerminalToolbarProps {
  sessionId: string;
}

/**
 * Touch-only row of special keys (Ctrl, Esc, Tab, Enter, Space, ←, →) for terminal view, in the slot the quick
 * chips use in chat view. Sends escape sequences straight to the PTY via sendInput.
 *
 * WHY the shared Button (Destin, 2026-11-04: "the arrows and other terminal-only keys feel like holdovers from an
 * earlier era of the app"): the keys were hand-made pills with a fixed 6px corner, a hand-written accent fill for
 * Ctrl and tiny "←"/"→" text glyphs. Each key is now the shared `raised` button — the theme's own control corner and
 * surface, its focus ring, press shade and 44px touch area — the arrows are the app's arrow icons, and a held Ctrl is
 * the filled button marked pressed.
 */
export default function TerminalToolbar({ sessionId }: TerminalToolbarProps) {
  const [ctrlActive, setCtrlActive] = useState(false);

  const send = useCallback((input: string) => {
    window.claude.session.sendInput(sessionId, input);
  }, [sessionId]);

  return (
    <div className="scroll-mask scroll-mask--chips flex gap-1 px-3 py-1 overflow-x-auto scrollbar-none items-center">
      <Key label="Ctrl" pressed={ctrlActive} onClick={() => setCtrlActive((prev) => !prev)} />
      <Key label="Esc" onClick={() => send('\x1b')} />
      <Key label="Tab" onClick={() => send('\t')} />
      {/* Enter and Space as their own keys (second review F2): answering a
          menu in terminal view on a phone — above all a startup dialog the chat
          cannot show — needs Enter to confirm and Space to tick a box in a
          multi-select (the several-MCP-servers list). */}
      <Key label="Enter" onClick={() => send('\r')} />
      <Key label="Space" onClick={() => send(' ')} />
      <div aria-hidden className="shrink-0 w-px h-5 bg-edge mx-0.5" />
      <Key label="Left" icon={<BackIcon className="w-4 h-4" />} onClick={() => send('\x1b[D')} />
      <Key label="Right" icon={<ForwardIcon className="w-4 h-4" />} onClick={() => send('\x1b[C')} />
    </div>
  );
}

function Key({ label, icon, pressed, onClick }: { label: string; icon?: React.ReactNode; pressed?: boolean; onClick: () => void }) {
  return (
    <Button
      variant={pressed ? 'primary' : 'raised'}
      size="sm"
      onClick={onClick}
      aria-label={icon ? label : undefined}
      aria-pressed={pressed}
      // One height for the whole row (design rule "controls on one line share one height"); h-8 rather than sm's own
      // ~22px because these are typed on, not read — the 44px touch area still comes from the primitive.
      className="shrink-0 h-8 min-w-9 px-2 select-none"
    >
      {icon ?? label}
    </Button>
  );
}

/**
 * Floating up/down arrow buttons — rendered separately above the bottom bar
 * so they overlay the terminal view without taking up space in the flex layout.
 *
 * WHY measured from the message box (Destin, 2026-11-04: "the spacing of the arrows should also adjust to keep them a
 * comfortable width from the edges in all chrome styles"): they sat a fixed 8px from the terminal's right edge, which
 * put them ON the frame's border line in the framed style and against the glass edge in the floating ones. Each style
 * insets the message box differently (and themes add their own margins), so the pair now lines up with the send
 * button inside that box, whatever put it there. Until it is measured it keeps the old 8px.
 */
export function TerminalScrollButtons({ sessionId }: TerminalToolbarProps) {
  const send = useCallback((input: string) => {
    window.claude.session.sendInput(sessionId, input);
  }, [sessionId]);
  const probe = useRef<HTMLDivElement>(null);
  const right = useMessageBoxRightFor(probe);

  return (
    // WHY above --terminal-bottom-inset: on a touch screen the input bar floats OVER the terminal (globals.css,
    // "Touch terminal view"), so the arrows sit just above it — and above the keyboard while it is up.
    <div
      ref={probe}
      data-term-lift=""
      className="absolute z-10 pointer-events-auto flex flex-col rounded-control border border-edge bg-panel overflow-hidden select-none"
      style={{ right: right ?? 8, bottom: 'calc(var(--terminal-bottom-inset, 0px) + 0.5rem)' }}
    >
      {/* Change 41 kept: a 40×40 target each — a primary touch control floating over the terminal. One card holding
          both keys (a divider between) instead of two separate squares. */}
      <Button variant="ghost" size="icon" aria-label="Scroll up" onClick={() => send('\x1b[A')} className="w-10 h-10 rounded-none text-fg-2">
        <ForwardIcon className="w-5 h-5 -rotate-90" />
      </Button>
      <div aria-hidden className="h-px bg-edge" />
      <Button variant="ghost" size="icon" aria-label="Scroll down" onClick={() => send('\x1b[B')} className="w-10 h-10 rounded-none text-fg-2">
        <ForwardIcon className="w-5 h-5 rotate-90" />
      </Button>
    </div>
  );
}

/** How far in from the right of the box it floats in the given element must sit to line up over the send button:
 *  the message box's right edge plus the box's own inner padding. Re-measured when either box changes size. */
function useMessageBoxRightFor(el: React.RefObject<HTMLDivElement | null>): number | null {
  const [right, setRight] = useState<number | null>(null);
  useEffect(() => {
    const host = el.current?.offsetParent as HTMLElement | null;
    const form = document.querySelector<HTMLElement>('.input-bar-container form');
    if (!host || !form) return;
    const measure = () => {
      const pad = parseFloat(getComputedStyle(form).paddingRight) || 0;
      const next = Math.max(0, Math.round(host.getBoundingClientRect().right - form.getBoundingClientRect().right + pad));
      setRight((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(form);
    ro.observe(host);
    return () => ro.disconnect();
  }, [el]);
  return right;
}
