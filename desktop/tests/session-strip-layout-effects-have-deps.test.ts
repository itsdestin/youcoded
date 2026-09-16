// The session strip must not force a style flush on every render.
//
// Two of its layout effects read getComputedStyle — one for the pill label's
// real font, one for the reveal duration off the stylesheet — and ran with NO
// dependency list, i.e. after every commit. Each such read in the layout phase
// is a forced style recalculation; with the shell re-rendering per streamed
// word (see root-selectors-skip-token-rerenders.test.tsx) that was ~120
// forced flushes a second for the length of a reply. Both values change only
// with the theme, so they now carry theme-keyed dependency lists.
//
// Guard: at most ONE useLayoutEffect in SessionStrip.tsx runs without a
// dependency list — the drag-settle effect, which early-returns unless a drop
// just happened and reads nothing from the DOM otherwise.
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { readStripped, RENDERER } from './helpers/guard-scope';

const FILE = join(RENDERER, 'components', 'SessionStrip.tsx');

/** Every `useLayoutEffect(` call, with whether its closing line carries deps.
 *  The strip's effects are top-level statements of the component (one fixed
 *  indent), so an effect ends at the first line of the same indent that is
 *  `});` (no deps) or `}, [` (deps). Nested effects would have a deeper indent
 *  and are not something this file has today. */
function layoutEffects(src: string): Array<{ line: number; hasDeps: boolean }> {
  const out: Array<{ line: number; hasDeps: boolean }> = [];
  const re = /^([ \t]*)useLayoutEffect\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const indent = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    // One-liner: `useLayoutEffect(() => { ... }, [deps]);` on the same line.
    const eol = src.indexOf('\n', m.index);
    const firstLine = src.slice(m.index, eol === -1 ? undefined : eol);
    if (/\}\s*,\s*\[[^\]]*\]\s*\)\s*;?\s*$/.test(firstLine)) { out.push({ line, hasDeps: true }); continue; }
    if (/\}\s*\)\s*;?\s*$/.test(firstLine)) { out.push({ line, hasDeps: false }); continue; }
    const closer = new RegExp(`^${indent}\\}(\\)|, \\[)`, 'm');
    const rest = src.slice(eol + 1);
    const c = closer.exec(rest);
    if (!c) throw new Error(`could not find the end of the useLayoutEffect at line ${line}`);
    out.push({ line, hasDeps: c[1] === ', [' });
  }
  return out;
}

describe('SessionStrip layout effects', () => {
  it('at most one runs without a dependency list (the drag-settle effect)', () => {
    const effects = layoutEffects(readStripped(FILE));
    expect(effects.length).toBeGreaterThanOrEqual(4); // the file has several; a miscount means the parser broke
    const bare = effects.filter((e) => !e.hasDeps);
    expect(bare.map((e) => e.line), `dependency-less useLayoutEffect at lines ${bare.map((e) => e.line).join(', ')}`).toHaveLength(1);
  });
});
