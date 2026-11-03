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

describe('touch terminal bottom chrome', () => {
  it('App gives the bottom chrome the floating and docked classes in touch terminal view', () => {
    // Floating so it rides up with the keyboard and the terminal runs behind it (globals.css, "Touch terminal view").
    expect(app).toMatch(/currentViewMode === 'chat' \? ' bottom-float' : isTerminalTouch \? ' bottom-float bottom-docked' : ''/);
  });

  it('off Electron, the terminal grid stops above the floating bar and the settled keyboard', () => {
    const rule = css.match(/html:not\(\[data-platform="electron"\]\)\s*\{([^}]*)\}/);
    expect(rule, 'touch terminal bottom inset rule missing').toBeTruthy();
    expect(rule![1]).toMatch(/--terminal-bottom-inset:\s*calc\(var\(--bottom-chrome-height[^;]*--vvp-offset/);
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
