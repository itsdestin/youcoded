import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * The buddy window's NAME is load-bearing, and two things could clobber it.
 *
 * On a Wayland Linux desktop the app cannot move its own windows. What it does
 * instead is rename the window — "YC:mascot@480,900" — and a helper running
 * inside the desktop reads the name and moves the window there. That makes the
 * window's name a live control channel rather than decoration, and two ordinary,
 * innocent-looking things would break it:
 *
 *  1. THE PAGE SETTING ITS OWN TITLE. A web page's <title> becomes the window's
 *     name when the page loads. index.html says "YouCoded", so a fraction of a
 *     second after the buddy appears his coordinates would be overwritten with
 *     the word "YouCoded" — and he would sit there, unmovable, for the rest of
 *     the session. This repo has already shipped that exact bug once
 *     (buddy-overlay-manager.ts, found live on 2026-07-23).
 *
 *  2. BLOCKING THE PAGE'S TITLE *AFTER* SETTING OUR OWN. The order matters:
 *     register the block first and our name can never be clobbered; do it the
 *     other way round and the page's title lands in the gap.
 */

const MAIN = 'src/main/main.ts';
const RENDERER = 'src/renderer';

function src(rel: string): string {
  // Normalised to '\n': a Windows checkout has CRLF endings, and any line split or
  // multi-line comparison below silently stops matching without this.
  return readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('the buddy window’s name', () => {
  describe('nothing in the app renames a window from the page side', () => {
    const files = walk(join(__dirname, '..', RENDERER));

    it('scans a populated set of renderer files', () => {
      // A scan over an empty list passes silently and proves nothing.
      expect(files.length).toBeGreaterThan(100);
    });

    it('no screen anywhere sets document.title', () => {
      const offenders = files.flatMap((file) =>
        readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
          .split('\n')
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => /\bdocument\.title\s*=/.test(line))
          .map(({ line, n }) => `${file.split('/desktop/')[1]}:${n}  ${line.trim()}`),
      );
      expect(
        offenders,
        'setting document.title in a buddy window would overwrite the coordinates that move it',
      ).toEqual([]);
    });
  });

  describe('every buddy window blocks the page from renaming it', () => {
    const text = src(MAIN);
    const lines = text.split('\n');

    it('the guard covers buddy windows, and no longer excludes them', () => {
      // The shape this replaced was `if (DEV_WINDOW_TITLE && !opts?.buddy)` —
      // dev-only, and explicitly NOT for the buddy, which is exactly backwards
      // for a window whose name is how it moves.
      expect(text).not.toContain('DEV_WINDOW_TITLE && !opts?.buddy');
      expect(text).toContain("if (opts?.buddy) {\n    win.on('page-title-updated', (e) => e.preventDefault());");
    });

    it('blocks the page BEFORE setting the name, in every branch', () => {
      const blocks = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => line.includes("win.on('page-title-updated'"));
      const sets = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /^\s*win\.setTitle\(/.test(line));
      // One of each per branch: the buddy branch and the dev-window branch.
      expect(blocks).toHaveLength(2);
      expect(sets).toHaveLength(2);
      for (let k = 0; k < blocks.length; k++) {
        expect(sets[k].i, 'preventDefault must be registered before setTitle').toBeGreaterThan(blocks[k].i);
      }
    });

    it('a buddy window is born with its name, not given one later', () => {
      // The helper decides whether to watch a window the instant it appears. A
      // window born nameless is never watched — the buddy would show up and
      // then refuse to move, which is the whole bug this feature removes.
      expect(text).toContain('title: opts?.buddy ? (opts.buddyTitle ?? BUDDY_WINDOW_TITLE) : DEV_WINDOW_TITLE,');
    });

    it('the caption reaches the constructor from the window manager', () => {
      expect(text).toContain(
        'createBuddyWindow: (variant, { x, y, title }) => createAppWindow({ x, y, buddy: variant, buddyTitle: title }),',
      );
    });

    it('off Wayland the pinned name is exactly what the page would have set', () => {
      // So freezing it changes nothing anybody can see on Windows, macOS or X11.
      expect(text).toContain("const BUDDY_WINDOW_TITLE = 'YouCoded';");
      expect(src('src/renderer/index.html')).toContain('<title>YouCoded</title>');
    });
  });
});
