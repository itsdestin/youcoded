import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from './ui';
import { AttachIcon, BackIcon, ForwardIcon } from './Icons';
import { pasteIntoTerminal } from '../hooks/terminal-registry';

interface TerminalToolbarProps {
  sessionId: string;
  /** The phone app types straight into the terminal (no message box): the row trades Enter and the arrows (now on
   *  the D-pad) for Attach and Paste. */
  direct?: boolean;
  /** Short notices (an empty clipboard, a failed paste). */
  onToast?: (msg: string) => void;
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

/** Phone app (typing straight into the terminal): the letter typed while Ctrl is held becomes Ctrl+letter, and Ctrl
 *  switches itself off after any key. Returns what to send to the program. */
export function applyHeldCtrl(sessionId: string, data: string): string {
  if (!ctrlHeld.has(sessionId)) return data;
  setCtrlHeld(sessionId, false);
  if (data.length !== 1) return data;
  const ch = data.toUpperCase();
  if (!/^[A-Z@[\\\]^_]$/.test(ch)) return data;
  return String.fromCharCode(ch.charCodeAt(0) & 0x1f);
}

/** WHY on every key (2026-11-08): in the phone app the keyboard types into the terminal, and a tap that moved focus
 *  to the key would close the keyboard after every Esc or arrow. Stopping the press's default keeps focus (and the
 *  keyboard) where it was; the click still fires. */
function keepTyping(e: React.MouseEvent) {
  e.preventDefault();
}

/** A file path as Claude Code reads it from typed text: quoted when it holds a space. */
function pathForTerminal(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
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
export default function TerminalToolbar({ sessionId, direct, onToast }: TerminalToolbarProps) {
  const ctrl = useCtrlHeld(sessionId);
  const send = useCallback((input: string) => {
    setCtrlHeld(sessionId, false);
    window.claude.session.sendInput(sessionId, input);
  }, [sessionId]);

  // WHY Attach and Paste here (Destin, 2026-11-08: "add an attachment button … since it won't be in the input bar
  // anymore. Might also want like a paste button"): in the phone app terminal view has no message box, so its
  // paperclip and a long-press paste are gone. Both go in as a terminal paste, exactly as if typed: a picked file's
  // path (Claude Code reads a pasted path as that file), or the clipboard's text.
  const attach = useCallback(async () => {
    setCtrlHeld(sessionId, false);
    try {
      const paths = await window.claude.dialog.openFile();
      if (paths.length > 0) pasteIntoTerminal(sessionId, paths.map(pathForTerminal).join(' ') + ' ');
    } catch {
      onToast?.('Couldn\'t attach that file. Try again.');
    }
  }, [sessionId, onToast]);
  const paste = useCallback(async () => {
    setCtrlHeld(sessionId, false);
    try {
      const r = await (window.claude as unknown as { android?: { readClipboard?: () => Promise<{ text?: string } | null> } }).android?.readClipboard?.();
      if (r?.text) pasteIntoTerminal(sessionId, r.text);
      else onToast?.('Nothing to paste. Copy some text first.');
    } catch {
      onToast?.('Couldn\'t read the clipboard. Try again.');
    }
  }, [sessionId, onToast]);

  if (direct) {
    return (
      <div className="scroll-mask scroll-mask--chips flex px-3 py-1 overflow-x-auto scrollbar-none">
        <div className="flex flex-1 items-center gap-1">
          {/* Attach and Paste first (Destin, 2026-11-08 review: "put paperclip and paste on the lefthand side"). */}
          <Key label="Attach file" icon={<AttachIcon className="w-4 h-4" />} onClick={() => { void attach(); }} />
          <Key label="Paste" onClick={() => { void paste(); }} />
          <Key label="Ctrl" pressed={ctrl} onClick={() => setCtrlHeld(sessionId, !ctrl)} />
          <Key label="Esc" onClick={() => send('\x1b')} />
          <Key label="Tab" onClick={() => send('\t')} />
          <Key label="Space" onClick={() => send(' ')} />
        </div>
      </div>
    );
  }

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
      onMouseDown={keepTyping}
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
export function TerminalScrollButtons({ sessionId, direct }: TerminalToolbarProps) {
  const send = useCallback((input: string) => {
    window.claude.session.sendInput(sessionId, input);
  }, [sessionId]);
  const probe = useRef<HTMLDivElement>(null);
  const measured = useMessageBoxRightFor(probe);
  // The phone app's terminal view has no message box to line up with (its box is hidden): the key row's own inset.
  const right = direct ? DPAD_RIGHT_PX : measured;

  return (
    // WHY above --terminal-bottom-inset: on a touch screen the input bar floats OVER the terminal (globals.css,
    // "Touch terminal view"), so the arrows sit just above it — and above the keyboard while it is up.
    <div
      ref={probe}
      data-term-lift=""
      className="absolute z-10 pointer-events-auto flex flex-col gap-1.5 select-none"
      style={{ right: right ?? 8, bottom: 'calc(var(--terminal-bottom-inset, 0px) + 0.5rem)' }}
    >
      {direct ? <DPad send={send} /> : <>
      {/* Change 41 kept: a 40×40 target each — a primary touch control floating over the terminal. Two keys with a
          gap, never a line between them (Destin, 2026-11-05: "the line between the arrows is grodi"). */}
      <Button onMouseDown={keepTyping} variant="raised" size="icon" aria-label="Scroll up" onClick={() => send('\x1b[A')} className="w-10 h-10 text-fg-2 rounded-md">
        <ForwardIcon className="w-5 h-5 -rotate-90" />
      </Button>
      <Button onMouseDown={keepTyping} variant="raised" size="icon" aria-label="Scroll down" onClick={() => send('\x1b[B')} className="w-10 h-10 text-fg-2 rounded-md">
        <ForwardIcon className="w-5 h-5 rotate-90" />
      </Button>
      </>}
    </div>
  );
}

/** The D-pad's gap from the right edge: the key row's own side padding (px-3). */
const DPAD_RIGHT_PX = 12;

/** Phone app: the D-pad where the up/down pair floats. WHY (Destin, 2026-11-08): "get rid of enter altogether. And
 *  put the current like send button in between the up and down arrows. And then maybe put the left right arrows …
 *  to the side of that, like a little … D pad". Send is Enter: it sends what was typed and confirms a menu choice. */
function DPad({ send }: { send: (input: string) => void }) {
  const pad = 'w-10 h-10 text-fg-2 rounded-md';
  return (
    <div className="grid grid-cols-3 gap-1">
      <span />
      <Button onMouseDown={keepTyping} variant="raised" size="icon" aria-label="Up" onClick={() => send('\x1b[A')} className={pad}>
        <ForwardIcon className="w-5 h-5 -rotate-90" />
      </Button>
      <span />
      <Button onMouseDown={keepTyping} variant="raised" size="icon" aria-label="Left" onClick={() => send('\x1b[D')} className={pad}>
        <BackIcon className="w-5 h-5" />
      </Button>
      {/* An Enter-key symbol (↵), not the chat's send arrow (Destin, 2026-11-08 review: "make this look like an enter
          key symbol … the send button in this view look odd sitting next to the right arrow"). */}
      <Button onMouseDown={keepTyping} size="icon" aria-label="Send" onClick={() => send('\r')} className="w-10 h-10 rounded-md">
        <svg className="w-5 h-5 text-on-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 5v6a3 3 0 01-3 3H5m0 0l4-4m-4 4l4 4" />
        </svg>
      </Button>
      <Button onMouseDown={keepTyping} variant="raised" size="icon" aria-label="Right" onClick={() => send('\x1b[C')} className={pad}>
        <ForwardIcon className="w-5 h-5" />
      </Button>
      <span />
      <Button onMouseDown={keepTyping} variant="raised" size="icon" aria-label="Down" onClick={() => send('\x1b[B')} className={pad}>
        <ForwardIcon className="w-5 h-5 rotate-90" />
      </Button>
      <span />
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
