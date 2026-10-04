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
 *
 * Fix 3 (2026-10-04) widened this from "cannot cancel the scroll" to "cannot make the scroll wait": a
 * NON-passive wheel/touch listener makes the browser ask the page's main thread before it scrolls, so with the
 * page busy (a reply streaming, a terminal flood) every scroll sat ~400 ms behind a 400 ms block — measured with
 * scripts/perf-lab/scroll-deferral.mjs. So touchstart / touchmove / mousewheel are covered too, and a
 * registration must say `passive: true` in the call itself. The only call that may omit it is one on
 * `window` or `document` itself, where Chromium already forces wheel/touchstart/touchmove passive.
 */
const MAY_CANCEL: Record<string, string> = {
  // Ctrl+wheel / trackpad pinch → app zoom. Passive on the desktop app (the browser has nothing to cancel there:
  // its pinch zoom is switched off in main.ts), cancelable only on remote browsers / Android WebView, where the
  // browser's own page zoom must be stopped. Bails out before preventDefault unless ctrlKey is set, so plain
  // scrolling is never touched on either.
  'src/renderer/hooks/useZoomControls.ts': 'pinch-to-zoom the app (passive on desktop; cancelable off-desktop only)',
  // Finger-drag scrolling of the xterm terminal on a touch device: preventDefault stops xterm's own text
  // selection. Registered on the terminal's own container, and only when the device has touch.
  'src/renderer/components/TerminalView.tsx': 'touch-drag scrolling of the terminal (touch devices only)',
};

const ROOT = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const REGISTRATION = /([\w$.]+)\.addEventListener\(\s*['"](wheel|mousewheel|touchstart|touchmove)['"][^;]*;/g;

/** Every wheel/touch registration in `text` that could make a scroll wait for the page. */
export function blockingRegistrations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REGISTRATION)) {
    const stmt = m[0];
    if (/passive:\s*true/.test(stmt)) continue;
    // Chromium makes these passive by default on the window / document themselves (and only there).
    const bareOnGlobal = /^(window|document)$/.test(m[1]) && !/passive/.test(stmt);
    if (bareOnGlobal) continue;
    out.push(stmt.replace(/\s+/g, ' ').slice(0, 120));
  }
  return out;
}

describe('wheel scrolling stays native', () => {
  it('no renderer file registers a wheel/touch listener that can make a scroll wait, outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'src/renderer'))) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      const text = readFileSync(file, 'utf8');
      if (blockingRegistrations(text).length && !(rel in MAY_CANCEL)) offenders.push(rel);
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
    for (const rel of Object.keys(MAY_CANCEL)) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      expect(blockingRegistrations(text), `${rel} no longer has a blocking listener — drop it from the allowlist`).not.toEqual([]);
    }
  });

  // Seen red: this is what the scan must catch (a missing `passive: true`, an explicit `passive: false`, and a
  // bare element-level touch listener), and what it must let through.
  it('the scan itself: catches the shapes that block, lets passive and bare window/document ones through', () => {
    expect(blockingRegistrations("window.addEventListener('wheel', h, { passive: false, capture: true });")).toHaveLength(1);
    expect(blockingRegistrations("el.addEventListener('touchmove', h, { capture: true, passive: cond });")).toHaveLength(1);
    expect(blockingRegistrations("el.addEventListener('touchstart', h);")).toHaveLength(1);
    expect(blockingRegistrations("window.addEventListener('mousewheel', h, { passive: false });")).toHaveLength(1);
    expect(blockingRegistrations("window.addEventListener('wheel', h, { passive: true, capture: true });")).toEqual([]);
    expect(blockingRegistrations("document.addEventListener('touchstart', h);")).toEqual([]);
    expect(blockingRegistrations("document.addEventListener('touchstart', h, { passive: false });")).toHaveLength(1);
  });
});
