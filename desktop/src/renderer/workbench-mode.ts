// Workbench-mode detection for PRODUCTION components that need a dev-only
// branch (today: TerminalView's canned screen + backing mock-ups).
//
// WHY a separate module and not platform.ts: the existing terminal tests
// `vi.mock('../src/renderer/platform')` with a fixed factory, so a new export
// there would be `undefined` in every one of them and throw at first call.
//
// WHY the URL and not NODE_ENV or `window.__workbenchStore`: index.tsx boots
// the workbench on exactly `import.meta.env.DEV && ?mode=workbench`, and
// WorkbenchFrame stamps `mode=workbench` onto the child iframe it hosts, so the
// query param is the one signal present in every workbench document. The mock
// shim's globals are installed AFTER module evaluation and are absent in the
// unit-test environment. `import.meta.env.DEV` is statically `false` in a
// production build, so Vite folds every branch below to dead code — nothing in
// here can fire in Electron or the Android WebView.

/** True in ANY document the workbench boots — including the PRODUCTION site build.
 *
 *  WHY this exists next to `isWorkbenchMode()`, which looks almost identical:
 *  `isWorkbenchMode` short-circuits on `import.meta.env.DEV`, so Vite folds it to
 *  `false` in a production bundle. That is correct for the terminal's dev-only
 *  branches, and it is WRONG for anything used as a SAFETY gate, because the
 *  landing page's live demo is a production build of the workbench
 *  (`npm run build:site` sets VITE_WORKBENCH=1, and index.tsx boots the workbench
 *  on `DEV || VITE_WORKBENCH === '1'`). Gating the microphone on the dev-only
 *  predicate compiled the gate away in exactly the build a stranger can click:
 *  the marketing page would have asked visitors for microphone permission, and
 *  shown "No microphone was found on this computer." to anyone without one.
 *  Found reviewing T6, 2026-09-05, by reading the built site bundle.
 *
 *  Mirrors index.tsx's boot condition exactly. Use THIS one for anything that
 *  must not happen in a workbench document; use `isWorkbenchMode` only for a
 *  dev-time visual branch. */
export function isWorkbenchDocument(): boolean {
  // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
  const enabled = import.meta.env.DEV || import.meta.env.VITE_WORKBENCH === '1';
  if (!enabled) return false;
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('mode') === 'workbench';
}

/** True only inside the UI Workbench (`bash scripts/run-workbench.sh`). */
export function isWorkbenchMode(): boolean {
  // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
  if (!import.meta.env.DEV) return false;
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('mode') === 'workbench';
}

/** Terminal backing variants for ledger P-20.2 (2026-08-27 UI review): how
 *  solid should the terminal's surface be under a wallpaper theme?
 *
 *  DECIDED 2026-08-27 (Destin: "fine with 3 at 8-% instead of 90"): the
 *  panel-backed form at 0.8 ships, as a theme guarantee in theme-engine.ts
 *  (`computeTerminalSurface`) — NOT via this switch. The variants stay so the
 *  phase-d comparisons can still be re-shot side by side:
 *
 *  - `today`    — what SHIPS. No override: under a wallpaper/gradient theme
 *                 xterm paints `--panel` (opaque) and the grid sits at
 *                 `--terminal-xterm-opacity`, which the engine floors at 0.8;
 *                 flat themes keep `--canvas` at their own `terminal-opacity`
 *                 (default 0.6). Same as the app.
 *  - `legacy`   — the PRE-decision surface, for Before shots: an opaque
 *                 `--canvas` xterm with the whole grid at 0.6 over the
 *                 blurred/darkened wallpaper layer. (The engine's floor makes
 *                 this unreachable through a theme now, so it carries a literal
 *                 0.6.)
 *  - `scrim`    — the legacy mechanism, stronger: the same `--canvas` xterm at
 *                 0.85 instead of 0.6.
 *  - `solid90`  — xterm paints `--panel` (opaque) and the grid sits at 0.9, so
 *                 the wallpaper shows through 10%. (The shipping form is this
 *                 at 0.8.)
 *  - `solid100` — the same `--panel` xterm at 1: the wallpaper is hidden
 *                 behind the grid.
 *
 *  WHY the solids keep xterm OPAQUE instead of a transparent xterm over a
 *  --panel layer (which was built first, 2026-08-27): with `allowTransparency`
 *  the WebGL glyph atlas paints an opaque black cell behind every DIM glyph,
 *  so each `⎿ …` line and the shortcuts hint rendered on a black bar — an
 *  artefact of transparency, not of the backing, and real Claude Code output
 *  is full of dim text. The opaque form needs no `allowTransparency` (a
 *  measured xterm perf cost) and no override of the `.xterm-viewport` colour.
 *  The only visible difference is that `solid90` text is drawn at 0.9 rather
 *  than 1. */
export type TerminalBacking = 'today' | 'legacy' | 'scrim' | 'solid90' | 'solid100';

const TERMINAL_BACKINGS: ReadonlyArray<TerminalBacking> = ['today', 'legacy', 'scrim', 'solid90', 'solid100'];

/** Reads `?termBacking=`; anything unrecognised (or not in workbench mode) is
 *  `today`, so a typo renders the shipped terminal rather than a blank pane. */
export function workbenchTerminalBacking(): TerminalBacking {
  if (!isWorkbenchMode()) return 'today';
  const raw = new URLSearchParams(location.search).get('termBacking') ?? 'today';
  return (TERMINAL_BACKINGS as readonly string[]).includes(raw) ? (raw as TerminalBacking) : 'today';
}

/** Per-variant knobs TerminalView applies. `xtermOpacity` replaces the grid
 *  container's `--terminal-xterm-opacity`; `xtermBackground` is which theme
 *  token xterm paints as its (opaque) background. `today` has no entry: it is
 *  the theme engine's own answer. */
export const TERMINAL_BACKING_STYLE: Record<Exclude<TerminalBacking, 'today'>, {
  xtermOpacity: number;
  xtermBackground: 'canvas' | 'panel';
}> = {
  legacy: { xtermOpacity: 0.6, xtermBackground: 'canvas' },
  scrim: { xtermOpacity: 0.85, xtermBackground: 'canvas' },
  solid90: { xtermOpacity: 0.9, xtermBackground: 'panel' },
  solid100: { xtermOpacity: 1, xtermBackground: 'panel' },
};
