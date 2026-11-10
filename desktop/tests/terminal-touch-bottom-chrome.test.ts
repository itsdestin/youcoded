// Terminal view on a touch device: the input bar and its key row (Esc, Tab,
// Enter, Space…) must paint ABOVE the frame glass. As a plain static block it
// sat under .chrome-glass (z-10) in framed themes — present, clickable in
// theory, invisible in practice — so a startup dialog sent to terminal view
// could not be answered on a phone (found in the dev instance, 2026-09-24).
// WHY a source-text guard: it couples a CSS rule to a JSX class (a CSS↔TSX
// pairing an ast-grep rule cannot express), and no test can mount App.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { readSource } from './helpers/guard-scope';

const app = readSource(path.join(__dirname, '..', 'src', 'renderer', 'App.tsx'));
const css = readSource(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'globals.css'));
// The keyboard lift rule lives with the other keyboard rules.
const keyboardCss = readSource(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'keyboard.css'));

describe('touch terminal bottom chrome', () => {
  it('App gives the bottom chrome the floating and docked classes in touch terminal view', () => {
    // Floating so it rides up with the keyboard and the terminal runs behind it (globals.css, "Touch terminal view").
    expect(app).toMatch(/currentViewMode === 'chat' \? ' bottom-float' : isTerminalTouch \? ' bottom-float bottom-docked' : ''/);
  });

  it('under the phone terminal layout, the terminal grid stops above the floating bar and SLIDES with the keyboard, never shrinks', () => {
    const rule = css.match(/html\[data-term-layout="phone"\]\s*\{([^}]*)\}/);
    expect(rule, 'touch terminal bottom inset rule missing').toBeTruthy();
    expect(rule![1]).toMatch(/--terminal-bottom-inset:\s*calc\(var\(--bottom-chrome-height/);
    // A keyboard height in the inset resized the terminal on every open, and Claude Code printed its screen again.
    expect(rule![1]).not.toMatch(/--vvp-offset/);
    const lift = keyboardCss.match(/html\[data-term-layout="phone"\] \[data-term-lift\]\s*\{([^}]*)\}/);
    expect(lift, 'terminal keyboard lift rule missing').toBeTruthy();
    // The grid also slides by --term-grid-lift (TerminalView: rows overhanging a taller message box), so a taller box
    // never shrinks the terminal either (terminal-size-lock.ts).
    expect(lift![1]).toMatch(/transform:\s*translateY\(calc\(-1 \* \(var\(--vvp-offset, 0px\) \+ var\(--term-grid-lift, 0px\)\)\)\)/);
  });

  it('the only scroll bar in the terminal is ours: the library\'s own grey one is hidden, and ours stays inside the frame on a phone', () => {
    const css = readSource(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'terminal-scrollbar.css'));
    expect(css).toMatch(/\.terminal-overlay-scroll \.xterm \.xterm-scrollable-element > \.scrollbar\s*\{\s*display:\s*none !important;/);
    expect(css).toMatch(/html\[data-term-layout="phone"\] body[^{]*\.terminal-scrollbar-thumb\s*\{\s*right:\s*calc\(2px \+ var\(--frame-edge, 0px\)\);/);
  });

  it('the docked class sits on the same layer as the floating one, above the glass', () => {
    const rule = css.match(/\.bottom-docked\s*\{([^}]*)\}/);
    expect(rule, '.bottom-docked rule missing').toBeTruthy();
    expect(rule![1]).toMatch(/position:\s*absolute/);
    const z = Number(/z-index:\s*(\d+)/.exec(rule![1])?.[1]);
    const glassZ = 10; // .chrome-glass
    expect(z).toBeGreaterThan(glassZ);
  });
});
