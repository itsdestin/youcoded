import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Wheel and trackpad scrolling belong to the browser engine, everywhere.
 *
 * The chat once carried a homemade scroll engine: a wheel listener that could
 * cancel the browser's own scroll (`passive: false` + preventDefault), then
 * re-applied each delta times a "burst" multiplier and ran its own friction
 * glide. On the engine YouCoded ships (measured 2026-09-29, Electron 41 on a
 * Wayland trackpad) that fought the engine's built-in behaviour, which already
 * coasts after a flick, stops when fingers rest on the pad, and boosts repeated
 * flicks. The result was scrolling that ran up to 4× ahead of the fingers,
 * kept going after the user stopped, and stuttered while a reply streamed.
 *
 * So: a wheel listener in the renderer must be passive (read-only), except the
 * ones listed here, each with its reason. A new entry needs the same kind of
 * reason — and must leave plain (non-Ctrl) wheel scrolling to the browser.
 */
const MAY_CANCEL_WHEEL: Record<string, string> = {
  // Ctrl+wheel / trackpad pinch → app zoom. Bails out before preventDefault
  // unless ctrlKey is set, so plain scrolling is never touched.
  'src/renderer/hooks/useZoomControls.ts': 'pinch-to-zoom the app',
};

const ROOT = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('wheel scrolling stays native', () => {
  it('no renderer file registers a cancelable wheel listener outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'src/renderer'))) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      const text = readFileSync(file, 'utf8');
      // A wheel listener registered with passive:false — the only way script can
      // cancel the browser's own wheel scroll.
      const cancelable = /addEventListener\(\s*['"]wheel['"][^;]*passive:\s*false/.test(text);
      if (cancelable && !(rel in MAY_CANCEL_WHEEL)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the chat view has no wheel handler of its own', () => {
    const chat = readFileSync(join(ROOT, 'src/renderer/components/ChatView.tsx'), 'utf8');
    // The only wheel mention allowed is the passive, read-only "user took over"
    // signal in the scroll-anchor restore (a loop over event names).
    expect(chat).not.toMatch(/addEventListener\(\s*['"]wheel['"]/);
    expect(chat).not.toMatch(/onWheel\s*=/);
  });

  it('every allowlisted file still exists and still needs its exemption', () => {
    for (const rel of Object.keys(MAY_CANCEL_WHEEL)) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      expect(text, `${rel} no longer cancels wheel — drop it from the allowlist`).toMatch(
        /addEventListener\(\s*['"]wheel['"][^;]*passive:\s*false/,
      );
    }
  });
});
