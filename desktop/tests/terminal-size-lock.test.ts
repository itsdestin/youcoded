// When a touch screen's terminal may give Claude Code a new size (components/terminal-size-lock.ts): only a new
// window, character size or column count — never the chrome over the terminal — and how far the grid slides instead.
import { describe, it, expect } from 'vitest';
import { keepProgramSize, gridOverflow } from '../src/renderer/components/terminal-size-lock';

const phone = { winW: 360, winH: 788, cellW: 7.2, cellH: 15, cols: 47 };

describe('terminal size lock', () => {
  it('keeps the size when only the chrome over the terminal moved', () => {
    expect(keepProgramSize(phone, { ...phone })).toBe(true);
  });
  it('decides afresh the first time, and on a new window, character size or column count', () => {
    expect(keepProgramSize(null, phone)).toBe(false);
    expect(keepProgramSize(phone, { ...phone, winW: 788, winH: 360 })).toBe(false);
    expect(keepProgramSize(phone, { ...phone, winH: 700 })).toBe(false);
    expect(keepProgramSize(phone, { ...phone, cellH: 16 })).toBe(false);
    expect(keepProgramSize(phone, { ...phone, cols: 46 })).toBe(false);
  });
  it('slides the grid up by the rows that overhang its box, and not at all when they fit', () => {
    expect(gridOverflow(35, 15, 0, 495)).toBe(30);      // two rows' worth under a taller box
    expect(gridOverflow(35, 15, 0, 530)).toBe(0);       // the rows fit
    expect(gridOverflow(35, 14.6, 4, 500)).toBe(15);    // padding counts, fractions round up
    expect(gridOverflow(35, 0, 0, 100)).toBe(0);        // character size not known yet
  });
});
