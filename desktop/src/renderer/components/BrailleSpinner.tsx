import { useSyncExternalStore } from 'react';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function getThemeColors(): string[] {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim() || '#85C1E9';
  const fg2 = style.getPropertyValue('--fg-2').trim() || '#D0D0D0';
  const fgDim = style.getPropertyValue('--fg-dim').trim() || '#B0B0B0';
  const fgMuted = style.getPropertyValue('--fg-muted').trim() || '#A8D8A8';
  // fg-faint is decorative-only (2:1 — dividers, disabled glyphs); a spinner is
  // a signal the user is meant to see, so the cycle stops at fg-muted (P-11).
  return [fgDim, fg2, accent, fgMuted];
}

// Shared animation driver — ONE timer for all mounted spinners.
// History: per-instance setIntervals (2 timers × N spinners) → a single rAF
// loop → this. The rAF version woke the renderer at the display's refresh rate
// (180 wakeups/sec on a 180Hz panel) to do work that only changes every 80ms —
// the 2026-07-30 idle-CPU investigation found the per-frame wakeup chain is the
// dominant animation cost, so the driver now ticks on a 40ms interval instead:
// same 80ms glyph / 600ms color cadence (checked against performance.now(), so
// timer jitter can't accumulate drift), ~4.5x fewer wakeups, no visual change.
// Renders (and therefore presented frames) were always gated on `changed`.
let frameIndex = 0;
let colorIndex = 0;
let version = 0;
let lastFrameTick = 0;
let lastColorTick = 0;
let timerId: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick() {
  const now = performance.now();
  let changed = false;
  if (now - lastFrameTick >= 80) {
    frameIndex = (frameIndex + 1) % FRAMES.length;
    lastFrameTick = now;
    changed = true;
  }
  if (now - lastColorTick >= 600) {
    colorIndex = (colorIndex + 1) % 5;
    lastColorTick = now;
    changed = true;
  }
  if (changed) {
    version++;
    listeners.forEach((cb) => cb());
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (timerId === null) {
    const now = performance.now();
    lastFrameTick = now;
    lastColorTick = now;
    timerId = setInterval(tick, 40);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  };
}

const getVersion = () => version;

interface Props {
  /** Size class — maps to text-xs, text-sm, text-base, text-lg */
  size?: 'xs' | 'sm' | 'base' | 'lg';
  /** Whether to cycle through colors (default true) */
  colorCycle?: boolean;
  /** Extra classes on the glyph. WHY (audit W20): a caller that needs a colour
   *  the theme cycle does not offer (the marketplace install corner is
   *  text-accent) passes it here — and because the default colour is an INLINE
   *  style, which would beat any class, giving a className also switches the
   *  inline colour off so the class decides. Omitted = the look every other
   *  caller has always had; colorCycle is ignored while a className is set. */
  className?: string;
}

const sizeClass: Record<string, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
};

export default function BrailleSpinner({ size = 'sm', colorCycle = true, className }: Props) {
  useSyncExternalStore(subscribe, getVersion);

  return (
    <span
      className={`${sizeClass[size]} leading-none shrink-0 inline-block text-center${className ? ` ${className}` : ''}`}
      style={{
        // See Props.className: a class-driven colour only works if this inline one steps aside.
        ...(className ? {} : { color: colorCycle ? getThemeColors()[colorIndex] : getThemeColors()[0] }),
        width: '1em',  // Fixed width prevents layout reflow from variable-width braille glyphs
      }}
    >
      {FRAMES[frameIndex]}
    </span>
  );
}
