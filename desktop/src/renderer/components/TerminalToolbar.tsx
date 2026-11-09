import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from './ui';
import { BackIcon, ForwardIcon } from './Icons';

interface TerminalToolbarProps {
  sessionId: string;
}

// ── A one-shot Ctrl, per session ─────────────────────────────────────────────────────────────────────────────────
// WHY (Destin, 2026-11-05, picked "make Ctrl work for the next letter"): the Ctrl key used to light up and do nothing
// at all. On a phone the minimal message box is the only thing you type into in terminal view (TerminalView skips
// xterm's own input on touch), so a held Ctrl turns the NEXT letter typed into that box into Ctrl+letter, sent
// straight to the program, and then switches itself off. Anything other than one typed letter switches it off too.
const ctrlHeld = new Set<string>();
const ctrlListeners = new Set<() => void>();
function setCtrlHeld(sessionId: string, held: boolean) {
  if (held === ctrlHeld.has(sessionId)) return;
  if (held) ctrlHeld.add(sessionId); else ctrlHeld.delete(sessionId);
  for (const l of ctrlListeners) l();
}
function useCtrlHeld(sessionId: string): boolean {
  return useSyncExternalStore(
    (l) => { ctrlListeners.add(l); return () => { ctrlListeners.delete(l); }; },
    () => ctrlHeld.has(sessionId),
  );
}
/** InputBar (terminal view on touch): called with the box's text before and after a change. True when the change was
 *  one letter typed while Ctrl is held: it went to the program as Ctrl+letter, so the box must keep `prev`. */
export function consumeCtrlLetter(sessionId: string, prev: string, next: string): boolean {
  if (!ctrlHeld.has(sessionId)) return false;
  setCtrlHeld(sessionId, false);
  if (next.length !== prev.length + 1) return false;
  let i = 0;
  while (i < prev.length && prev[i] === next[i]) i++;
  if (next.slice(i + 1) !== prev.slice(i)) return false;
  const ch = next[i].toUpperCase();
  if (!/^[A-Z@[\\\]^_]$/.test(ch)) return false;
  window.claude.session.sendInput(sessionId, String.fromCharCode(ch.charCodeAt(0) & 0x1f));
  return true;
}

/**
 * Touch-only row of special keys (Ctrl, Esc, Tab, Enter, Space, ← →) for terminal view, in the slot the quick chips use in
 * chat view. Sends escape sequences straight to the PTY via sendInput.
 *
 * WHY the shared Button (Destin, 2026-11-04: "the arrows and other terminal-only keys feel like holdovers from an
 * earlier era of the app"): the keys were hand-made pills with a hand-written accent fill for Ctrl. Each key is now the
 * shared button — the theme's colours, its focus ring, press shade and 44px touch area — and a held Ctrl is the filled
 * button marked pressed. The size and corner are the quick chips' (see Key), so the row matches chat view's. WHY an
 * even share of the width (Destin, 2026-11-05): a row of keys sized to their labels left "extra space/gap" at its end;
 * the keys now share the row edge to edge, and scroll sideways only if they ever outgrow it. WHY ← → back
 * (Destin, 2026-11-05: "i think we should just go back to left/right arrows instead of space", then kept Space too): they move between
 * choices in Claude Code's side-by-side menus and along its typing line. No divider lines: Destin dislikes "horizontal
 * lines that bisect a container".
 */
export default function TerminalToolbar({ sessionId }: TerminalToolbarProps) {
  const ctrl = useCtrlHeld(sessionId);
  const send = useCallback((input: string) => {
    setCtrlHeld(sessionId, false);
    window.claude.session.sendInput(sessionId, input);
  }, [sessionId]);

  return (
    <div className="scroll-mask scroll-mask--chips flex px-3 py-1 overflow-x-auto scrollbar-none">
      <div className="flex flex-1 items-center gap-1">
        <Key label="Ctrl" pressed={ctrl} onClick={() => setCtrlHeld(sessionId, !ctrl)} />
        <Key label="Esc" onClick={() => send('\x1b')} />
        <Key label="Tab" onClick={() => send('\t')} />
        {/* Enter as its own key (second review F2): answering a menu in terminal view on a phone — above all a
            startup dialog the chat cannot show — needs Enter to confirm. */}
        <Key label="Enter" onClick={() => send('\r')} />
        {/* Space kept as a seventh key (Destin, 2026-11-05, picked "keep Space as a seventh key"): it ticks a box in a
            tick-several menu, above all the startup question about which add-on servers to allow, which only terminal
            view shows. */}
        <Key label="Space" onClick={() => send(' ')} />
        <Key label="Left" icon={<BackIcon className="w-4 h-4" />} onClick={() => send('\x1b[D')} />
        <Key label="Right" icon={<ForwardIcon className="w-4 h-4" />} onClick={() => send('\x1b[C')} />
      </div>
    </div>
  );
}

function Key({ label, icon, pressed, onClick }: { label: string; icon?: React.ReactNode; pressed?: boolean; onClick: () => void }) {
  return (
    <Button
      variant={pressed ? 'primary' : 'raised'}
      size="sm"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={icon ? label : undefined}
      // The quick chip's size and corner (QuickChips.tsx on a phone: h-8, text-2xs, rounded-md). flex-1:
      // the keys share the row's width; min-w-10 makes the row scroll rather than squeeze when they no longer fit. The
      // 44px touch area still comes from the primitive.
      className="flex-1 min-w-10 h-8 px-1.5 text-2xs rounded-md select-none"
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
      className="absolute z-10 pointer-events-auto flex flex-col gap-1.5 select-none"
      style={{ right: right ?? 8, bottom: 'calc(var(--terminal-bottom-inset, 0px) + 0.5rem)' }}
    >
      {/* Change 41 kept: a 40×40 target each — a primary touch control floating over the terminal. Two keys with a
          gap, never a line between them (Destin, 2026-11-05: "the line between the arrows is grodi"). */}
      <Button variant="raised" size="icon" aria-label="Scroll up" onClick={() => send('\x1b[A')} className="w-10 h-10 text-fg-2 rounded-md">
        <ForwardIcon className="w-5 h-5 -rotate-90" />
      </Button>
      <Button variant="raised" size="icon" aria-label="Scroll down" onClick={() => send('\x1b[B')} className="w-10 h-10 text-fg-2 rounded-md">
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
