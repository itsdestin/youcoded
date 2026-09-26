// @vitest-environment jsdom
// Pins attachRenderPause (src/renderer/components/xterm-render-pause.ts) against
// the REAL installed @xterm/xterm — not a mock — because the whole fix rides on a
// private RenderService member. If an xterm bump renames it, the first test here
// fails instead of every hidden session silently going back to drawing.
//
// What must hold (perf batch 2026-09-23, item B1):
//   - a hidden terminal draws nothing, however much it is written to;
//   - its BUFFER still receives every write (the prompt detector reads hidden
//     sessions' buffers to spot permission / trust prompts);
//   - showing it repaints the whole screen, in one draw;
//   - xterm's own IntersectionObserver saying "on screen" cannot un-pause a
//     terminal we know is hidden (visibility:hidden still counts as on screen);
//   - a terminal that is never hidden is untouched.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { attachRenderPause } from '../src/renderer/components/xterm-render-pause';

// jsdom has neither; xterm's browser services need both to open. The observer
// fake keeps each callback so a test can play xterm's own "on screen" verdict.
const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
beforeAll(() => {
  (window as any).matchMedia ??= () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  });
  (window as any).IntersectionObserver = class {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(cb); }
    observe() {}
    disconnect() {}
  };
});

const opened: Terminal[] = [];
afterEach(() => {
  opened.splice(0).forEach((t) => t.dispose());
  observers.length = 0;
  document.body.innerHTML = '';
});

function openTerminal() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const terminal = new Terminal({ allowProposedApi: true, rows: 24, cols: 80 });
  terminal.open(el);
  opened.push(terminal);
  const renderer = (terminal as any)._core._renderService._renderer.value;
  const renderRows = vi.spyOn(renderer, 'renderRows');
  return { terminal, renderRows, observer: observers[observers.length - 1] };
}

const write = (t: Terminal, data: string) => new Promise<void>((r) => t.write(data, () => r()));
// xterm debounces draws onto requestAnimationFrame; wait out a couple of frames.
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const lineText = (t: Terminal, y: number) => t.buffer.active.getLine(y)?.translateToString(true);

describe('attachRenderPause (real @xterm/xterm)', () => {
  it('finds the render-service hook in the installed xterm', () => {
    const { terminal } = openTerminal();
    expect(attachRenderPause(terminal)).not.toBeNull();
  });

  it('a hidden terminal draws nothing, yet its buffer receives every write', async () => {
    const { terminal, renderRows } = openTerminal();
    const pause = attachRenderPause(terminal)!;
    pause.setHidden(true);
    await frames();
    renderRows.mockClear();

    await write(terminal, 'Do you trust the files in this folder?\r\n');
    await write(terminal, '❯ 1. Yes, proceed\r\n  2. No, exit');
    await frames();

    expect(renderRows).not.toHaveBeenCalled();
    expect(lineText(terminal, 0)).toBe('Do you trust the files in this folder?');
    expect(lineText(terminal, 1)).toBe('❯ 1. Yes, proceed');
    expect(lineText(terminal, 2)).toBe('  2. No, exit');
  });

  it('showing it repaints the whole screen, in one draw', async () => {
    const { terminal, renderRows } = openTerminal();
    const pause = attachRenderPause(terminal)!;
    pause.setHidden(true);
    await write(terminal, 'written while hidden');
    await frames();
    renderRows.mockClear();

    pause.setHidden(false);
    await frames();

    expect(renderRows).toHaveBeenCalledTimes(1);
    expect(renderRows).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  // Even with nothing written while hidden, the show still repaints once — the
  // first frame the user sees must be a freshly drawn screen.
  it('showing after a quiet hide still repaints the whole screen once', async () => {
    const { terminal, renderRows } = openTerminal();
    const pause = attachRenderPause(terminal)!;
    pause.setHidden(true);
    await frames();
    renderRows.mockClear();

    pause.setHidden(false);
    await frames();
    expect(renderRows).toHaveBeenCalledTimes(1);
    expect(renderRows).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it("xterm's own observer reporting 'on screen' does not un-pause a hidden terminal", async () => {
    const { terminal, renderRows, observer } = openTerminal();
    const pause = attachRenderPause(terminal)!;
    pause.setHidden(true);
    // visibility:hidden is still "intersecting" to an IntersectionObserver.
    observer([{ isIntersecting: true }]);
    await frames();
    renderRows.mockClear();

    await write(terminal, 'more output');
    await frames();
    expect(renderRows).not.toHaveBeenCalled();
  });

  it('a terminal that is never hidden keeps drawing as before', async () => {
    const { terminal, renderRows } = openTerminal();
    attachRenderPause(terminal);
    await frames();
    renderRows.mockClear();

    await write(terminal, 'visible output');
    await frames();
    expect(renderRows).toHaveBeenCalled();
  });

  // The visible terminal must behave exactly as before: xterm's own observer
  // verdicts reach its pause switch unchanged, in both directions.
  it("on a shown terminal, xterm's own observer verdicts pass straight through", async () => {
    const { terminal, renderRows, observer } = openTerminal();
    attachRenderPause(terminal);

    observer([{ isIntersecting: true }]);
    await frames();
    renderRows.mockClear();
    await write(terminal, 'on screen');
    await frames();
    expect(renderRows).toHaveBeenCalled();

    observer([{ isIntersecting: false }]); // e.g. scrolled off / zero-size
    await frames();
    renderRows.mockClear();
    await write(terminal, 'off screen');
    await frames();
    expect(renderRows).not.toHaveBeenCalled();
  });

  it("dispose restores xterm's own observer handling", async () => {
    const { terminal, renderRows, observer } = openTerminal();
    const pause = attachRenderPause(terminal)!;
    pause.setHidden(true);
    pause.dispose();
    // With the override gone, xterm's real verdict is in charge again.
    observer([{ isIntersecting: true }]);
    await frames();
    renderRows.mockClear();

    await write(terminal, 'after dispose');
    await frames();
    expect(renderRows).toHaveBeenCalled();
  });
});
