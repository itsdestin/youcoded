import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { usePtyOutput } from '../hooks/useIpc';
import { usePtyRawBytes } from '../hooks/usePtyRawBytes';
import { registerTerminal, unregisterTerminal, notifyBufferReady, noteAtlasClear } from '../hooks/terminal-registry';
import { createTerminalKeyHandler } from './terminal-key-handler';
import { useTheme } from '../state/theme-context';
import { isTouchDevice } from '../platform';
import { isWorkbenchMode, workbenchTerminalBacking, TERMINAL_BACKING_STYLE } from '../workbench-mode';
import { computeTerminalSurface } from '../themes/theme-engine';

/** Terminal always uses Cascadia Code — user font selection applies to the
 *  chat UI only. Proportional or display fonts break xterm's character grid. */
const TERMINAL_FONT = "'Cascadia Code', 'Cascadia Mono', Consolas, monospace";

/** Read the current theme CSS variables and return an xterm ITheme.
 *  @param background — which theme token xterm paints as its OPAQUE background:
 *  'panel' under a wallpaper/gradient theme, 'canvas' on a flat one (the P-20.2
 *  guarantee — decided by computeTerminalSurface in theme-engine.ts, never
 *  here). xterm needs a resolved colour, which is why this reads the token by
 *  name instead of `--terminal-backing`. This used to take a `transparent`
 *  flag that returned the keyword 'transparent' — never use that: xterm's
 *  css.toColor accepts only `#…` / `rgb(…)` and THROWS on keywords, falling
 *  back to opaque black (measured 2026-08-27). */
function getXtermTheme(background: 'canvas' | 'panel'): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const s = getComputedStyle(document.documentElement);
  const fg = s.getPropertyValue('--fg').trim() || '#E0E0E0';
  const accent = s.getPropertyValue('--accent').trim() || '#264f78';
  const bg = background === 'panel'
    ? (s.getPropertyValue('--panel').trim() || '#191919')
    : (s.getPropertyValue('--canvas').trim() || '#0A0A0A');
  return { background: bg, foreground: fg, cursor: fg, selectionBackground: accent + '4D' };
}

interface Props {
  sessionId: string;
  visible: boolean;
}

export default function TerminalView({ sessionId, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Custom overlay scrollbar thumb — painted on top of xterm so the native
  // scrollbar gutter doesn't eat the rightmost terminal column.
  const thumbRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Re-attach helper exposed across effects so the theme effect can recover
  // WebGL using the same construction + onContextLoss handler shape as the
  // mount effect (with the shared retry-cap counter).
  const attachWebglRef = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Previous `visible`, updated only inside the visibility effect (NOT on every
  // render like visibleRef). Lets the glyph-atlas heal below fire on a genuine
  // hidden → shown transition and skip the initial mount — see the blast-radius
  // note there for why healing on mount is expensive.
  const wasVisibleRef = useRef<boolean | null>(null);
  const { activeTheme, reducedEffects } = useTheme();
  // UI Workbench ONLY (`?mode=workbench&termBacking=`): which terminal surface
  // mock-up to render — see workbench-mode.ts for the four variants and WHY the
  // shipping version is a theme guarantee, not a query param. Read once per
  // mount; in Electron / Android this is always 'today' and every branch on it
  // below is a no-op, so the real PTY terminal is untouched.
  const [workbenchBacking] = React.useState(workbenchTerminalBacking);
  const backingStyle = workbenchBacking === 'today' ? null : TERMINAL_BACKING_STYLE[workbenchBacking];

  // Detect if the theme has a visual background (wallpaper image, gradient, or glassmorphism)
  const bg = activeTheme?.background;
  // Which theme token xterm paints as its opaque background. The shipped answer
  // is the theme engine's (P-20.2: 'panel' under a wallpaper/gradient — the
  // same predicate that stamps [data-wallpaper] on <html> — 'canvas' on a flat
  // theme); the workbench mock-ups override it for side-by-side shots only.
  const shippedBacking = computeTerminalSurface(bg).backing;
  const xtermBackground = backingStyle?.xtermBackground ?? shippedBacking;
  const hasWallpaper = bg?.type === 'image' && !!bg.value;
  const hasGradient = bg?.type === 'gradient' && !!bg.value;
  const hasBlur = !!(bg?.['panels-blur'] && bg['panels-blur'] > 0 && !reducedEffects);
  // Terminal needs to be see-through when any visual background is active
  const seeThrough = hasWallpaper || hasGradient || hasBlur;
  // Dedicated background layer for terminal readability (image themes only).
  // Preferred source: theme author supplies a pre-blurred+darkened
  // `terminal-value` asset (zero runtime cost). Fallback: use the sharp
  // wallpaper with a runtime CSS filter — applied once on a static image,
  // not per-frame like backdrop-filter, so it's cheap. Reduced-effects
  // skips the runtime fallback entirely.
  const terminalBgAsset = hasWallpaper ? bg?.['terminal-value'] : undefined;
  const terminalBgFallback = hasWallpaper && !terminalBgAsset && !reducedEffects ? bg?.value : undefined;
  const terminalBg = terminalBgAsset ?? terminalBgFallback;
  const needsRuntimeBlur = !!terminalBgFallback;

  // Sync xterm theme when app theme changes. Always keep WebGL for performance.
  useEffect(() => {
    if (!terminalRef.current) return;
    requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      // Always use opaque xterm background — transparency is handled by the
      // container overlay, not by xterm itself. WebGL requires opaque backgrounds.
      terminal.options.theme = getXtermTheme(xtermBackground);

      // Ensure WebGL is attached (may have been disposed by a previous version
      // or by a prior context loss). Delegates to attachWebgl from the mount
      // effect so we share the same onContextLoss recovery + retry cap.
      if (!webglRef.current) {
        attachWebglRef.current?.();
      }
    });
  }, [activeTheme, xtermBackground]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Touch platforms (Android, remote browser) render xterm display-only:
    // typing flows through the InputBar minimal-mode <textarea> instead of
    // xterm's hidden textarea (which would summon the soft keyboard and
    // expose the historical xterm.js mobile IME issues). disableStdin
    // suppresses xterm's input handling entirely.
    const touch = isTouchDevice();
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      // Hide the cursor when the terminal isn't focused. Claude's TUI redraws
      // constantly move the cursor; without this, it visibly bounces around
      // when the user is in chat view (terminal unfocused but still rendering).
      cursorInactiveStyle: 'none',
      fontSize: touch ? 12 : 14,
      fontFamily: TERMINAL_FONT,
      theme: getXtermTheme(xtermBackground),
      disableStdin: touch,
    });

    const fitAddon = new FitAddon();
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = '11';
    terminal.open(containerRef.current);

    // Overlay scrollbar — sized/positioned from the active xterm buffer.
    // Native scrollbar is hidden by `.terminal-overlay-scroll` CSS so xterm
    // can use the full container width; this thumb sits absolutely on top of
    // the rightmost column. Read-only (display only — not draggable) for the
    // prototype. Mouse-wheel scrolling still goes through xterm's own handler.
    const updateThumb = () => {
      const thumb = thumbRef.current;
      const term = terminalRef.current ?? terminal;
      if (!thumb || !term) return;
      const buf = term.buffer.active;
      const rows = term.rows;
      const total = buf.length;
      // Hide thumb when there's nothing to scroll (buffer fits in viewport).
      if (total <= rows) {
        thumb.style.opacity = '0';
        return;
      }
      // Track height excludes a 4px top/bottom inset for visual breathing room.
      const containerH = containerRef.current?.clientHeight ?? 0;
      const trackH = Math.max(0, containerH - 8);
      const thumbH = Math.max(24, (rows / total) * trackH);
      const maxTop = trackH - thumbH;
      const scrollFraction = buf.viewportY / (total - rows);
      // The thumb lives in the wrapper but must track the xterm content, which
      // is inset below the header (--terminal-top-inset). offsetTop is that
      // inset in px, so the thumb starts at the content's top, not the wrapper's.
      const contentTop = containerRef.current?.offsetTop ?? 0;
      const top = contentTop + 4 + scrollFraction * maxTop;
      thumb.style.height = `${thumbH}px`;
      thumb.style.top = `${top}px`;
      thumb.style.opacity = '0.55';
    };
    terminal.onScroll(updateThumb);
    // Initial paint after layout settles (matches the existing fit timer).
    const thumbInitTimer = setTimeout(updateThumb, 120);

    // WebGL renderer — always load for performance. Wallpaper visibility is
    // handled by the container's opacity, not by xterm transparency.
    //
    // WebGL context loss happens when the GPU resets, the browser reclaims
    // GPU memory, or a driver crashes. Without a recovery handler, xterm
    // keeps showing the disposed atlas's stale glyphs even though the
    // underlying buffer is intact (text selection still reveals real text).
    // A window resize forces xterm to repaint every cell — that's why
    // resizing "fixes" it. Here we proactively dispose, re-attach a fresh
    // WebglAddon, and refresh visible rows so the grid recovers immediately.
    // Cap retries at 3 in a row so a persistently broken GPU context can't
    // loop forever — after that, fall back to the DOM renderer permanently.
    // The retry counter resets if 30+ minutes pass between losses, so a
    // long-running session that occasionally drifts (sleep/wake, monitor
    // hot-plug spread across hours) doesn't burn through its 3 strikes.
    const RETRY_RESET_MS = 30 * 60 * 1000;
    let webglContextLossRetries = 0;
    let lastContextLossAt = 0;
    const attachWebgl = () => {
      const term = terminalRef.current ?? terminal;
      if (!term) return;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          webglRef.current = null;
          const now = Date.now();
          if (now - lastContextLossAt > RETRY_RESET_MS) {
            webglContextLossRetries = 0;
          }
          lastContextLossAt = now;
          if (webglContextLossRetries >= 3) {
            // Give up — DOM renderer takes over for the rest of this session.
            term.refresh(0, term.rows - 1);
            return;
          }
          webglContextLossRetries += 1;
          attachWebgl();
          // Repaint visible cells from the buffer so corrupted glyphs from
          // the disposed atlas are replaced immediately (don't wait for the
          // next resize/scroll).
          term.refresh(0, term.rows - 1);
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        // Falls back to DOM renderer if WebGL unavailable
      }
    };
    attachWebgl();
    attachWebglRef.current = attachWebgl;

    // Clipboard keys (Ctrl+C copy / Ctrl+V paste) — extracted to
    // terminal-key-handler.ts. The Ctrl+V branch preventDefaults the keydown
    // so the browser's native paste event can't ALSO deliver the clipboard to
    // xterm's paste listener (which made every Ctrl+V paste twice).
    terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal));

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    registerTerminal(sessionId, terminal);

    // Signal to main process that we're ready to receive PTY output.
    // This flushes any buffered output that arrived before mount.
    window.claude.session.signalReady(sessionId);

    // Fit terminal to container and sync dimensions to PTY.
    // Skip when container is collapsed to 0x0 (hidden terminals) to avoid
    // setting a 1-column width on the PTY that causes text bunching.
    //
    // Two-part guard against Windows-ConPTY reflow duplication: every PTY
    // resize causes ConPTY to re-emit its visible buffer contents, which
    // xterm then scrolls into scrollback. Each spurious resize leaves
    // behind a duplicate copy of Claude's current Ink UI (banner, input
    // bar, recent output) in history.
    //   (1) Dedup — skip the IPC if proposed cols/rows match last sent.
    //       Covers ResizeObserver ticks from font load, sibling resize,
    //       1-pixel container jitter where fit() returns the same grid.
    //   (2) Debounce — when cols/rows genuinely change, coalesce rapid
    //       updates (window-drag, maximize animation) into a single
    //       trailing IPC call 120ms after things settle. xterm still
    //       fit()s immediately so the visible display tracks the drag;
    //       only the PTY resize is delayed.
    let lastCols = 0;
    let lastRows = 0;
    // UI Workbench ONLY: there is no PTY, so the pane would stay blank. Write a
    // frozen Claude Code screen once, right after the first fit that actually
    // ran, so the fixture's rules and prompt box are built for the real column
    // count. NOT on the 100ms mount timer: the app boots in chat view with this
    // container collapsed to 0×0 (measured 2026-08-27), so that timer's fit is
    // skipped and a write there lands at xterm's default 80 columns — a prompt
    // box half the pane wide, the same shape as ledger P-20.1. The dynamic
    // import behind `import.meta.env.DEV` keeps the fixture out of the
    // production bundle entirely (same pattern as index.tsx's workbench boot).
    let wroteWorkbenchScreen = false;
    let disposed = false;
    const writeWorkbenchScreenOnce = () => {
      // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
      if (wroteWorkbenchScreen || !(import.meta.env.DEV && isWorkbenchMode())) return;
      wroteWorkbenchScreen = true;
      import('../dev/workbench/fixtures/terminal-screen').then(({ renderTerminalScreen }) => {
        // The import resolves asynchronously — bail if this terminal was
        // disposed (session closed / remount) while it was loading.
        if (disposed) return;
        terminal.write(renderTerminalScreen(terminal.cols, terminal.rows));
      }).catch((err) => console.warn('[workbench] terminal fixture failed to load', err));
    };
    let pendingCols = 0;
    let pendingRows = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    // The first flush is this terminal's initial fit, not a user resize — see
    // the skip below.
    let hasFlushedResize = false;
    const flushResize = () => {
      debounceTimer = null;
      if (pendingCols === lastCols && pendingRows === lastRows) return;
      lastCols = pendingCols;
      lastRows = pendingRows;
      window.claude.session.resize(sessionId, pendingCols, pendingRows);
      // Fix: make resizing actually clear a corrupt glyph atlas. Resizing is
      // the first thing a user tries when text looks wrong, and until now it
      // did nothing for this failure mode (the repaint re-samples the same
      // bad GPU texture — see the clearTextureAtlas note in the visibility
      // effect below). Placed in the DEBOUNCED trailing call, not fitAndSync,
      // so a window drag re-rasterizes glyphs once after it settles instead
      // of on every observer tick.
      //
      // Skipped on the FIRST flush: that one is the mount-time fit, and this
      // terminal has just joined the atlas shared with every already-open
      // terminal — clearing there would make opening a session re-rasterize
      // all of them. Becoming visible is covered by the visibility effect.
      if (hasFlushedResize) {
        (terminalRef.current ?? terminal).clearTextureAtlas();
        // WHY: rig instrument; the heal costs every open terminal a
        // re-rasterize, so the rig counts clears per switch (terminal-registry).
        noteAtlasClear();
      }
      hasFlushedResize = true;
    };
    const fitAndSync = () => {
      try {
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        fitAddon.fit();
        writeWorkbenchScreenOnce();
        // Container height changed → thumb proportions need to recompute.
        updateThumb();
        const dims = fitAddon.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        // Dedup target: if a resize is already queued, compare against the
        // queued value (so re-proposing the same queued size is a no-op).
        // Otherwise compare against the last value actually sent to the PTY.
        // Without this, a drag that bounces A→B→A before the debounce fires
        // would skip the A update and let the stale B get flushed.
        const targetCols = debounceTimer !== null ? pendingCols : lastCols;
        const targetRows = debounceTimer !== null ? pendingRows : lastRows;
        if (dims.cols === targetCols && dims.rows === targetRows) return;
        pendingCols = dims.cols;
        pendingRows = dims.rows;
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flushResize, 120);
      } catch {
        // Ignore fit errors during teardown
      }
    };

    // Initial fit with delay to ensure container is laid out
    const timer = setTimeout(fitAndSync, 100);

    // Send user keyboard input to PTY — only when terminal is the active view.
    // xterm.js registers a paste listener on its container element that fires
    // even when the terminal is hidden/collapsed. Without this gate, pasting
    // into the chat InputBar can also trigger xterm's bracketed paste handler,
    // sending the raw multi-line text (wrapped in ESC[200~/ESC[201~) to the
    // PTY alongside the chat InputBar's sanitized single-line send.
    //
    // Skipped on touch platforms — disableStdin already silences xterm's
    // keyboard input, but the paste listener is registered separately, so we
    // also skip onData wiring to make sure no path can deliver text from
    // xterm's hidden textarea to the PTY (the InputBar minimal-mode textarea
    // is the canonical input on touch).
    if (!touch) {
      terminal.onData((data) => {
        if (!visibleRef.current) return;
        window.claude.session.sendInput(sessionId, data);
      });
    }

    // Touch platforms: one-finger drag scrolls scrollback, matching the
    // chat-view scroll feel. xterm.js's default mouse logic interprets
    // touch-drag as text selection (carried over from desktop where the
    // mouse wheel is used for scroll); on mobile that means selection works
    // but scrolling doesn't, which is the inverse of what users expect.
    // We override at capture phase so xterm never starts a selection.
    // Selection-on-touch is the trade-off; chat view doesn't have it
    // either, so the two views feel consistent.
    let touchScrollCleanup: (() => void) | null = null;
    if (touch) {
      const container = containerRef.current;
      let lastY = 0;
      let active = false;
      // Pixels of finger travel per scrolled line. Tuned empirically against
      // a 12px font (cell height ≈ 16px) so finger-distance ≈ scrolled pixels.
      const PX_PER_LINE = 16;
      // Carry remainder pixel-deltas across touchmove events so slow drags
      // accumulate into eventual single-line scrolls instead of being lost.
      let remainder = 0;

      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length !== 1) {
          active = false;
          return;
        }
        active = true;
        lastY = e.touches[0].clientY;
        remainder = 0;
      };
      const onTouchMove = (e: TouchEvent) => {
        if (!active || e.touches.length !== 1) return;
        // preventDefault stops xterm's selection AND any browser-level
        // text selection / pull-to-refresh interference.
        e.preventDefault();
        e.stopPropagation();
        const currentY = e.touches[0].clientY;
        // delta > 0 → finger moved up → show newer (scroll down: positive)
        // delta < 0 → finger moved down → show older (scroll up: negative)
        const deltaPx = lastY - currentY + remainder;
        const lines = (deltaPx / PX_PER_LINE) | 0; // truncate toward zero
        if (lines !== 0) {
          terminal.scrollLines(lines);
          remainder = deltaPx - lines * PX_PER_LINE;
        } else {
          remainder = deltaPx;
        }
        lastY = currentY;
      };
      const onTouchEnd = () => {
        active = false;
        remainder = 0;
      };

      // Capture phase so we run before xterm's own touch-as-mouse handlers.
      // passive:false on touchmove because we call preventDefault.
      container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
      container.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
      container.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });

      touchScrollCleanup = () => {
        container.removeEventListener('touchstart', onTouchStart, { capture: true } as any);
        container.removeEventListener('touchmove', onTouchMove, { capture: true } as any);
        container.removeEventListener('touchend', onTouchEnd, { capture: true } as any);
        container.removeEventListener('touchcancel', onTouchEnd, { capture: true } as any);
      };
    }

    // Resize handler
    window.addEventListener('resize', fitAndSync);

    // Observe container size changes — throttled to one fitAndSync per frame
    let resizeRafId: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRafId !== null) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        fitAndSync();
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(timer);
      clearTimeout(thumbInitTimer);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      window.removeEventListener('resize', fitAndSync);
      resizeObserver.disconnect();
      touchScrollCleanup?.();
      unregisterTerminal(sessionId);
      // Clear the cross-effect helper so the theme effect can't call into
      // the disposed terminal between unmount and remount.
      attachWebglRef.current = null;
      webglRef.current = null;
      disposed = true;
      terminal.dispose();
    };
  }, [sessionId, xtermBackground]);

  // Visibility toggle side effects.
  // Fix: the ResizeObserver attached in the mount effect already fires a fit on
  // the next frame when the container resizes from hidden → visible, so the
  // previous double setTimeout(50ms/200ms) fit calls were redundant work inside
  // the 300ms toggle animation (a major source of visual jank). Here we just
  // manage focus; the fit happens through the observer.
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (visible && terminalRef.current) {
      // Fix: heal a corrupt WebGL glyph atlas on every hide → show.
      //
      // The webgl addon shares ONE rasterized atlas across all terminals
      // (acquireTextureAtlas) but uploads it into each WebGL context's own
      // GPU texture (_atlasTextures). When a single context's texture goes
      // bad — GPU reset, driver fault, the OS reclaiming VRAM, resume from
      // sleep — that session renders every glyph as a solid black box the
      // exact size of the glyph's ink bounding box, while other sessions
      // sharing the same atlas stay correct. xterm cannot detect this: no
      // context-loss event fires, so the onContextLoss recovery above never
      // runs and the corruption persists for the terminal's whole lifetime
      // (a resize repaints from the buffer but re-samples the same bad
      // texture, so it does NOT clear it).
      //
      // clearTextureAtlas() is xterm's documented remedy for exactly this
      // (see the Terminal.clearTextureAtlas docs in @xterm/xterm). It lives
      // on the CORE Terminal, not the addon, so it needs no renderer guard:
      // core does `_renderer.value && (_renderer.value.clearTextureAtlas?.(),
      // _fullRefresh())`, so on the DOM renderer the atlas call optional-
      // chains away and only a full repaint runs. Cheap, but NOT a no-op.
      //
      // Blast radius: acquireTextureAtlas shares ONE atlas between every
      // terminal whose config matches, and clearing bumps each page's
      // `version`, which every other terminal's GlyphRenderer compares
      // against to decide whether to re-upload. So this is safe across
      // sessions (no stale glyph coordinates) but costs every open terminal
      // a re-rasterize on its next frame, not just this one. The flip side
      // is that healing here heals all of them at once.
      //
      // Bound to `visible` rather than the chat/terminal toggle handler:
      // App.tsx drives this prop from `active session && terminal view`, so
      // this also heals on session switches, and it can't be silently
      // disconnected by a future refactor of the toggle.
      //
      // `wasVisible === false` (not just `visible`) skips the initial mount.
      // A newly-opened session JOINS the shared warm atlas, so healing on
      // mount would wipe it for every already-open terminal — turning "open a
      // new session" into a re-rasterize for all of them. A brand-new
      // terminal has nothing to heal anyway.
      if (wasVisible === false) {
        terminalRef.current.clearTextureAtlas();
        // WHY: rig instrument; the heal costs every open terminal a
        // re-rasterize, so the rig counts clears per switch (terminal-registry).
        noteAtlasClear();
      }
      const raf = requestAnimationFrame(() => terminalRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    if (!visible && terminalRef.current) {
      terminalRef.current.blur();
    }
  }, [visible, sessionId]);

  // Write PTY output to terminal; notify registry when buffer is updated.
  // Touch platforms (Android, remote browser) consume pty:raw-bytes (Uint8Array)
  // from the WebSocket bridge — Tier 2 of android-terminal-data-parity. Desktop
  // continues to consume pty:output (string) from node-pty's UTF-8-decoded stream.
  // isTouchDevice() is a stable platform constant, so calling different hooks
  // based on it does not violate React's rules-of-hooks (the hook order is
  // stable for the lifetime of the renderer).
  const useRawBytes = isTouchDevice();
  usePtyOutput(useRawBytes ? null : sessionId, (data) => {
    terminalRef.current?.write(data, () => notifyBufferReady(sessionId));
  });
  usePtyRawBytes(useRawBytes ? sessionId : null, (data) => {
    terminalRef.current?.write(data, () => notifyBufferReady(sessionId));
  });

  // xterm opacity is driven by `--terminal-xterm-opacity` (theme-engine writes
  // it from the theme's `background.terminal-opacity`, user slider overrides —
  // and floors it at 0.8 under a wallpaper/gradient, see computeTerminalSurface).
  // When no visual background is active we force a full-opacity `1` so solid
  // themes don't inherit a translucent xterm.
  const xtermOpacityStyle: React.CSSProperties['opacity'] = seeThrough
    ? 'var(--terminal-xterm-opacity)'
    : 1;
  // The colour the grid container (and the header-gap backdrop) fill with,
  // as a var() so the theme's live token edits repaint it. Under a
  // wallpaper the container is FILLED (panel), so the few-pixel strip below
  // xterm's last cell row and the 20% show-through both read as one panel
  // sheet; a flat theme fills with --canvas as it always did; a flat theme
  // with only panels-blur stays unfilled so the blur can be seen (today's
  // behaviour). The workbench mock-ups follow their own token.
  const fillContainer = xtermBackground === 'panel' || !seeThrough;
  const backingColor = `var(--${xtermBackground})`;

  // `terminal-overlay-scroll` hides xterm's native scrollbar (see globals.css)
  // so the floating thumb below paints in front of the rightmost column.
  const wrapperClass = [
    'terminal-overlay-scroll',
    visible ? undefined : 'terminal-hidden',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={wrapperClass}
      style={{
        position: 'absolute',
        // Wrapper stays full-bleed (top: 0). Only the xterm CONTENT is inset
        // below the header (see the container's --terminal-top-inset top). This
        // keeps the terminal's background layer (terminalBg / --canvas) running
        // continuously up behind the header, so there's no boundary or exposed
        // rounded-corner box between the terminal and the region above it — the
        // header just floats over one continuous surface, as it did before the
        // content was inset.
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        // Use visibility:hidden instead of display:none so xterm.js can
        // measure fonts and maintain its screen buffer while the terminal
        // tab is not active. display:none causes a 0x0 container, which
        // prevents xterm from initializing properly — the prompt detector
        // then reads an empty buffer and can't detect Ink select menus.
        visibility: visible ? 'visible' : 'hidden',
        // Prevent the hidden terminal from capturing pointer events —
        // xterm.js registers mousedown/mousemove handlers that block
        // text selection in the ChatView sitting underneath.
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      {terminalBg && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url("${terminalBg}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            // Runtime `filter` on a static image paints once — unlike
            // backdrop-filter which recomposites every frame. Values come from
            // `--terminal-bg-blur` / `--terminal-bg-brightness` so Appearance
            // sliders update the preview live. Only applied when the theme
            // didn't ship a pre-baked terminal asset (in which case blur is
            // already baked in).
            filter: needsRuntimeBlur ? 'blur(var(--terminal-bg-blur)) brightness(var(--terminal-bg-brightness))' : undefined,
            // Blur expands beyond the element's bounds; scale up so the soft
            // edges don't reveal clipped pixels even at the max slider blur.
            transform: needsRuntimeBlur ? 'scale(1.06)' : undefined,
          }}
        />
      )}
      {/* Header-gap backdrop for gradient/glass themes (seeThrough but no
          terminalBg image to fill the gap). The xterm content is inset below
          the header and dims its backdrop via the container's opacity; without
          this, the strip above the content would show the theme background at
          FULL brightness, leaving a visible brightness step at the header edge.
          Replicate the terminal's dimmed surface — the same backing token
          (--panel under a gradient, --canvas on a blur-only flat theme) at the
          same --terminal-xterm-opacity — over just the gap so it reads as one
          continuous surface. Solid themes need nothing (the strip already shows
          --canvas); wallpaper themes are covered by the full-bleed terminalBg.
          Workbench mock-ups pin the variant's own opacity so the gap matches. */}
      {seeThrough && !terminalBg && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 'var(--terminal-top-inset, 0px)',
            backgroundColor: backingColor,
            opacity: backingStyle ? backingStyle.xtermOpacity : 'var(--terminal-xterm-opacity, 0.6)',
          }}
        />
      )}
      <div
        ref={thumbRef}
        className="terminal-scrollbar-thumb"
        aria-hidden
      />
      <div
        ref={containerRef}
        data-term-backing={workbenchBacking}
        style={{
          position: 'absolute',
          // Content (the xterm grid) starts BELOW the header. Claude Code wipes
          // the screen (\e[2J) and repaints from row 1 with absolute cursor
          // positioning every render, so a new session's banner always lands at
          // the top of the viewport — which sat behind the overlaid header.
          // Insetting the grid is the only way to bring it into view (seeded
          // blank lines can't survive the \e[2J). Only the grid moves; the
          // background layers above stay full-bleed for a seamless surface.
          // --terminal-top-inset (globals.css) = header height on desktop
          // electron, set in BOTH views so the terminal is one stable size —
          // a view-gated inset would resize the PTY per toggle and ConPTY would
          // re-emit its buffer (duplicated chrome).
          top: 'var(--terminal-top-inset, 0px)',
          // Left/right inset so the framed themes' side frame edges (--frame-edge
          // wide, painted by chrome-glass) don't clip the TUI's edge columns —
          // the chat pane is inset by those edges via the framed-shell flex, but
          // the terminal is a separate full-width layer, so it needs a matching
          // inset. --terminal-side-inset is theme-driven (= --frame-edge on
          // framed, 0 on floating), the same in both views → no toggle reflow.
          left: 'var(--terminal-side-inset, 0px)',
          right: 'var(--terminal-side-inset, 0px)',
          // Bottom inset lifts the xterm grid above the bottom frame strip on
          // framed themes (--terminal-bottom-inset = --frame-edge, set on
          // terminal view in globals.css; 0 on floating/chat). Read directly
          // here like the top/side insets — NOT via .app-content margin, which
          // can't move this absolutely-positioned container (see globals.css).
          bottom: 'var(--terminal-bottom-inset, 0px)',
          // Workbench backing mock-ups override the shipped opacity (`legacy`
          // 0.6, `scrim` 0.85, `solid90` 0.9, `solid100` 1 — workbench-mode.ts).
          opacity: backingStyle ? backingStyle.xtermOpacity : xtermOpacityStyle,
          // xterm renders cell rows to a canvas; if container height isn't a
          // whole multiple of cell height (typical — fonts round irregularly),
          // there's a few-pixel uncovered strip at the bottom that reveals
          // whatever's behind the WebView. On Android that's the Compose Box's
          // dark color, producing a visible black bar between xterm and the
          // input bar. Match the xterm theme background here so the strip is
          // indistinguishable from a rendered cell. Under a wallpaper the fill
          // is the panel sheet itself (P-20.2); only a blur-only flat theme is
          // left unfilled so the blur stays visible — see fillContainer.
          backgroundColor: fillContainer ? backingColor : undefined,
          // Workbench mock-ups only: `.xterm-viewport` (globals.css) fills with
          // --terminal-backing, which the theme engine set for the SHIPPED
          // surface. Re-point it at the variant's token so a `scrim` shot on a
          // wallpaper theme doesn't show a panel-coloured strip under a canvas
          // grid. Never set in the app (backingStyle is null there).
          ...(backingStyle ? { '--terminal-backing': backingColor } as React.CSSProperties : null),
        }}
      />
    </div>
  );
}
