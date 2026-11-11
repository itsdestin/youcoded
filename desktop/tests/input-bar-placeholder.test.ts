// The empty message box's hint stays on one line and ends in "…" (styles/input-bar.css): when the stop button
// appears beside the box, a wrapping hint made the empty box a line taller (measured in Chrome: 19px one line, 39px
// wrapped). WHY a source-text guard: a stylesheet rule — CSS is not an ast-grep language in this rule set, and jsdom
// does no layout to measure it.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { readSource } from './helpers/guard-scope';

const css = readSource(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'input-bar.css'));
const globals = readSource(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'globals.css'));

describe('message box hint', () => {
  it('does not wrap while the box is empty', () => {
    const rule = css.match(/\.input-bar-textarea:placeholder-shown\s*\{([^}]*)\}/);
    expect(rule, 'placeholder-shown rule missing').toBeTruthy();
    expect(rule![1]).toMatch(/white-space:\s*nowrap/);
    expect(rule![1]).toMatch(/text-overflow:\s*ellipsis/);
  });
  it('is loaded by the app stylesheet', () => {
    expect(globals).toMatch(/@import "\.\/input-bar\.css"/);
  });
});
