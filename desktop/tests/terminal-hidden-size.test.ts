// A hidden terminal's future size (components/terminal-hidden-size.ts): worked out while it is collapsed, so a new
// session's program draws at the right width from the start and is not resized (and redrawn) when the terminal is
// first shown. It must agree with @xterm/addon-fit's proposeDimensions, which does the first real fit.
import { describe, it, expect } from 'vitest';
import { hiddenTerminalSize } from '../src/renderer/components/terminal-hidden-size';

const phone = {
  hostWidth: 360, hostHeight: 789,
  top: 40, bottom: 147, left: 0, right: 0,
  padTop: 0, padBottom: 0, padLeft: 12, padRight: 0,
  scrollbarWidth: 14,
  cellWidth: 6.95, cellHeight: 14.3,
};

/** FitAddon.proposeDimensions, restated over a container of the given computed size. */
function fitAddon(i: typeof phone) {
  const width = Math.max(0, parseInt(`${i.hostWidth - i.left - i.right}px`));
  const height = parseInt(`${i.hostHeight - i.top - i.bottom}px`);
  return {
    cols: Math.max(2, Math.floor((width - (i.padLeft + i.padRight) - i.scrollbarWidth) / i.cellWidth)),
    rows: Math.max(1, Math.floor((height - (i.padTop + i.padBottom)) / i.cellHeight)),
  };
}

describe('hidden terminal size', () => {
  it('matches what the fit will propose once the terminal is shown', () => {
    expect(hiddenTerminalSize(phone)).toEqual(fitAddon(phone));
    expect(hiddenTerminalSize(phone)).toEqual({ cols: 48, rows: 42 }); // what the Z Flip7 really fitted
  });

  it('matches at fractional sizes too (the container width is floored, like parseInt)', () => {
    expect(hiddenTerminalSize({ ...phone, hostWidth: 359.67, hostHeight: 788.7 }))
      .toEqual(fitAddon({ ...phone, hostWidth: 359, hostHeight: 788 }));
  });

  it('waits when the character size is not known yet', () => {
    expect(hiddenTerminalSize({ ...phone, cellWidth: 0 })).toBeNull();
  });

  it('waits when there is no room (the host is not laid out yet)', () => {
    expect(hiddenTerminalSize({ ...phone, hostWidth: 0 })).toBeNull();
  });
});
