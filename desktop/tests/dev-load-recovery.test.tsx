// @vitest-environment jsdom
/**
 * Pins the blank-mount watchdog's probe (`src/main/dev-mount-probe.ts`) against
 * the REAL `src/renderer/index.html`.
 *
 * Why this test exists (2026-07-26): the probe was
 * `!!document.getElementById("root")?.childElementCount`, written 2026-07-16
 * when `#root` was empty until React's first commit. On 2026-07-20 index.html
 * started painting its inline boot skeleton INSIDE `#root` (deliberately — a
 * `createRoot()` commit replaces the container's children, so the skeleton
 * needs no teardown code). From that day the probe answered "mounted" for a
 * document where React had never run, so the watchdog reset its retry counter
 * and healed nothing. The other two recovery paths do not cover this signature:
 * `did-fail-load` never fires (index.html itself loads 200) and
 * `render-process-gone` never fires (the renderer is alive) — only the module
 * *sub-resource* fetches were aborted. Net effect: a Vite dev window stranded
 * on the boot spinner forever, which is the shape Destin kept hitting on a
 * WiFi + Tailscale box where netlink churn makes Chromium fail every in-flight
 * and queued request with ERR_NETWORK_CHANGED.
 *
 * The two assertions below are a matched pair, and the FIRST one is the guard:
 * it runs the probe over index.html exactly as served, so ANY future pre-React
 * content added inside `#root` — a renamed skeleton, a second placeholder —
 * fails this test instead of silently disabling dev-load recovery again.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MOUNT_PROBE_JS } from '../src/main/dev-mount-probe';

const INDEX_HTML = path.resolve(__dirname, '../src/renderer/index.html');

/** Evaluate the probe the same way `executeJavaScript` does: as an expression. */
function runProbe(): boolean {
  // eslint-disable-next-line no-new-func
  return !!new Function(`return (${MOUNT_PROBE_JS});`)();
}

/**
 * Load the real index.html's <body> into the jsdom document, so the probe sees
 * the actual pre-React DOM rather than a hand-copied approximation of it.
 */
function loadRealIndexHtmlBody(): void {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (!body) throw new Error(`no <body> found in ${INDEX_HTML}`);
  // Strip the module script tag — jsdom must not try to fetch ./index.tsx.
  document.body.innerHTML = body[1].replace(/<script[\s\S]*?<\/script>/gi, '');
}

describe('dev-load-recovery blank-mount probe', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports NOT mounted for index.html as served (boot skeleton is not a mount)', () => {
    loadRealIndexHtmlBody();

    // Sanity: we really did load the pre-React document, skeleton included.
    const root = document.getElementById('root');
    expect(root, 'index.html must contain #root').not.toBeNull();
    expect(
      root!.childElementCount,
      'index.html paints pre-React content inside #root — that is the whole trap',
    ).toBeGreaterThan(0);

    expect(runProbe()).toBe(false);
  });

  it('reports mounted after React commits — even when the tree renders null', () => {
    loadRealIndexHtmlBody();
    const root = document.getElementById('root')!;

    // Renders null on purpose: buddy windows (`?mode=buddy-*`) are wired through
    // the same recovery path and can legitimately commit an empty tree. A probe
    // that keyed on "#root has children" would treat that as a stranded window
    // and reload it every ~13s forever.
    act(() => {
      createRoot(root).render(React.createElement(() => null));
    });

    expect(runProbe()).toBe(true);
  });

  // WHY no main.ts source read here any more (Plan B, 2026-09-16): "main.ts uses the
  // shared probe rather than an inlined copy" is the workspace ast-grep rule
  // main-uses-shared-mount-probe.
});
