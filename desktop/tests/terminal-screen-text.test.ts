import { describe, expect, it } from 'vitest';
import { screenTextOf, type ScreenBuffer } from '../src/shared/terminal-screen-text';

function buffer(rows: Array<[string, boolean]>): ScreenBuffer {
  return {
    length: rows.length,
    getLine: (index) => rows[index] && ({
      isWrapped: rows[index][1],
      translateToString: (trim) => trim ? rows[index][0].trimEnd() : rows[index][0],
    }),
  };
}

describe('terminal screen row boundaries', () => {
  it.each(['─', '━', '▔'])('keeps full-width %s rules separate from adjacent ConPTY wrapped rows', (edge) => {
    const rule = edge.repeat(20);
    expect(screenTextOf(buffer([
      ['previous output', false], [rule, true], ['❯ draft', true], [rule, true], ['  status', true],
    ]))).toBe(`previous output\n${rule}\n❯ draft\n${rule}\n  status`);
  });

  it('still joins ordinary wrapped prose and preserves its indentation', () => {
    expect(screenTextOf(buffer([
      ['a long sentence', false], [' continues here', true], ['  another line', false],
    ]))).toBe('a long sentence continues here\n  another line');
  });

  it('does not treat indented or short reply decorations as full-width UI rules', () => {
    expect(screenTextOf(buffer([
      ['quote:', false], ['  ────────────────────', true], ['continued', true], ['────', false], ['more', true],
    ]))).toBe('quote:  ────────────────────continued\n────more');
  });

  it('preserves box boundaries when the tail begins inside a ConPTY-wrapped box', () => {
    const rule = '─'.repeat(20);
    expect(screenTextOf(buffer([
      ['discarded', false], [rule, false], ['❯ draft', true], [rule, true], ['  status', true],
    ]), 1)).toBe(`${rule}\n❯ draft\n${rule}\n  status`);
  });

  it('keeps a wrapped logical line whole when reading only the tail', () => {
    expect(screenTextOf(buffer([
      ['discarded', false], ['start', false], [' middle', true], [' end', true],
    ]), 1)).toBe('start middle end');
  });
});
