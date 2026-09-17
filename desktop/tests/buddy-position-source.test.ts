import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Where the buddy's numbers come from.
 *
 * TWO THINGS CAN GO WRONG HERE, and both are invisible on the machine that
 * writes the code, because both only misbehave on a Wayland Linux desktop:
 *
 *  1. ASKING THE WINDOW WHERE IT IS. On Wayland the window answers with the
 *     position it was BORN at, forever, however many times it has really moved.
 *     Code that asks would animate a snap from the wrong corner, open the chat
 *     where the buddy used to be, and save the wrong position on exit. The app
 *     has to remember instead, which is what rectOf() does.
 *
 *  2. ASKING ELECTRON HOW MUCH OF THE SCREEN IS USABLE. On Wayland Electron
 *     hands back the WHOLE screen, taskbar included — measured 2026-09-04, it
 *     said 1707x1067 while the desktop had reserved 52px at the bottom. Code
 *     that trusts it puts the buddy on top of the taskbar, covering the clock,
 *     with nothing in the app able to notice.
 *
 * These are source-text checks rather than behaviour checks on purpose: the
 * failure being guarded against is a future change quietly adding a tenth read
 * on a path no test drives. A behaviour test only covers what it thought to try;
 * reading the file covers the file.
 */

const MANAGER = 'src/main/buddy-window-manager.ts';

function read(rel: string): string[] {
  // Split on \r?\n, not '\n': a Windows checkout has CRLF endings, so splitting
  // on '\n' alone leaves a trailing '\r' on every line and any exact comparison
  // below (`l === '  }'`) silently never matches. That failed only on the
  // Windows runner, and only as "expected -1 to be greater than 246".
  return readFileSync(join(__dirname, '..', rel), 'utf8').split(/\r?\n/);
}

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('where the buddy’s position comes from', () => {
  const lines = read(MANAGER);

  it('nothing asks a buddy window where it is, except rectOf', () => {
    const hits = lines
      .map((l, i) => ({ line: l, n: i + 1 }))
      .filter(({ line }) => /\.(getBounds|getPosition)\(/.test(line) && !isComment(line));

    // The two inside rectOf: one for a window that isn't one of ours, one for
    // the ordinary desktops where the window tells the truth.
    const rectOfStart = lines.findIndex((l) => l.includes('private rectOf(win: BrowserWindow)'));
    const rectOfEnd = lines.findIndex((l, i) => i > rectOfStart && l === '  }');
    expect(rectOfStart).toBeGreaterThan(-1);
    expect(rectOfEnd).toBeGreaterThan(rectOfStart);

    // ONE sanctioned exception, marked in the source. The 'move' listener reads
    // the window's REAL bounds on purpose: it only exists off the caption path,
    // where that event fires and the answer is truthful, and it is what keeps a
    // Meta+drag on KDE X11 being remembered. Marking it rather than widening the
    // rule keeps the invariant exact — anything else is still a failure.
    const sanctioned = hits.filter(({ line }) => line.includes('sanctioned-real-bounds'));
    expect(sanctioned, 'the sanctioned-real-bounds marker should appear exactly once').toHaveLength(1);

    const strays = hits.filter(
      ({ n, line }) =>
        (n <= rectOfStart || n > rectOfEnd) && !line.includes('sanctioned-real-bounds'),
    );
    expect(
      strays.map((h) => `${MANAGER}:${h.n}  ${h.line.trim()}`),
      'a buddy window may only be asked for its position inside rectOf()',
    ).toEqual([]);
    // ...and rectOf really is the thing doing the asking, so the scope above
    // cannot silently become empty and pass by accident.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('nothing reads Electron’s idea of the usable screen area, except the one marked line', () => {
    const hits = lines
      .map((l, i) => ({ line: l, n: i + 1 }))
      .filter(({ line }) => /\.workArea\b/.test(line) && !isComment(line))
      // `this.deps.workArea` is the name of the injected source itself, not a
      // read of Electron's number.
      .filter(({ line }) => !/deps\.workArea/.test(line));

    // Exactly one raw read is allowed: the fallback for every platform that has
    // no work-area source, which is every platform except Wayland Linux. It
    // carries the marker so it is a deliberate exception, not an oversight.
    expect(hits.map((h) => h.line.trim())).toEqual([
      'if (!source) return display.workArea; // sanctioned-raw-work-area',
    ]);
  });
  // Until 2026-09-16 a second buddy implementation (a one-window overlay) was
  // exempt from this scan because it was written, kept and never chosen. It has
  // been deleted, so buddy-window-manager.ts is the ONLY file that positions a
  // buddy and this scan's scope is the whole story.
});
