import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { usePtyOutput } from '../hooks/useIpc';
import { registerTerminal, unregisterTerminal, notifyBufferReady } from '../hooks/terminal-registry';
import { useTheme } from '../state/theme-context';

/** Terminal always uses Cascadia Code — user font selection applies to the
 *  chat UI only. Proportional or display fonts break xterm's character grid. */
const TERMINAL_FONT = "'Cascadia Code', 'Cascadia Mono', Consolas, monospace";

/** Read the current theme CSS variables and return an xterm ITheme.
 *  @param transparent — when true, xterm background is transparent so wallpaper shows through */
function getXtermTheme(transparent: boolean): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const s = getComputedStyle(document.documentElement);
  const fg = s.getPropertyValue('--fg').trim() || '#E0E0E0';
  const accent = s.getPropertyValue('--accent').trim() || '#264f78';
  const bg = transparent ? 'transparent' : (s.getPropertyValue('--canvas').trim() || '#0A0A0A');
  return { background: bg, foreground: fg, cursor: fg, selectionBackground: accent + '4D' };
}

interface Props {
  sessionId: string;
  visible: boolean;
}

export default function TerminalView({ sessionId, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Re-attach helper exposed across effects so the theme effect can recover
  // WebGL using the same construction + onContextLoss handler shape as the
  // mount effect (with the shared retry-cap counter).
  const attachWebglRef = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const { activeTheme, reducedEffects } = useTheme();

  // Detect if the theme has a visual background (wallpaper image, gradient, or glassmorphism)
  const bg = activeTheme?.background;
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
      terminal.options.theme = getXtermTheme(false);

      // Ensure WebGL is attached (may have been disposed by a previous version
      // or by a prior context loss). Delegates to attachWebgl from the mount
      // effect so we share the same onContextLoss recovery + retry cap.
      if (!webglRef.current) {
        attachWebglRef.current?.();
      }
    });
  }, [activeTheme]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      // Hide the cursor when the terminal isn't focused. Claude's TUI redraws
      // constantly move the cursor; without this, it visibly bounces around
      // when the user is in chat view (terminal unfocused but still rendering).
      cursorInactiveStyle: 'none',
      fontSize: 14,
      fontFamily: TERMINAL_FONT,
      theme: getXtermTheme(false),
    });

    const fitAddon = new FitAddon();
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = '11';
    terminal.open(containerRef.current);

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

    // Ctrl+C copies the selection (if any) instead of sending SIGINT;
    // Ctrl+C with no selection falls through to xterm's default so users
    // can still interrupt a runaway process. Ctrl+V reads the system
    // clipboard and pastes into the PTY. Matches VS Code / Windows
    // Terminal conventions. Shift+Ctrl variants are left alone.
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.shiftKey || e.altKey) return true;
      const key = e.key.toLowerCase();
      if (key === 'c' && terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
        return false;
      }
      if (key === 'v') {
        navigator.clipboard.readText().then((text) => {
          if (text) terminal.paste(text);
        }).catch(() => {});
        return false;
      }
      return true;
    });

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
    let pendingCols = 0;
    let pendingRows = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const flushResize = () => {
      debounceTimer = null;
      if (pendingCols === lastCols && pendingRows === lastRows) return;
      lastCols = pendingCols;
      lastRows = pendingRows;
      window.claude.session.resize(sessionId, pendingCols, pendingRows);
    };
    const fitAndSync = () => {
      try {
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        fitAddon.fit();
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
    terminal.onData((data) => {
      if (!visibleRef.current) return;
      window.claude.session.sendInput(sessionId, data);
    });

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
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      window.removeEventListener('resize', fitAndSync);
      resizeObserver.disconnect();
      unregisterTerminal(sessionId);
      // Clear the cross-effect helper so the theme effect can't call into
      // the disposed terminal between unmount and remount.
      attachWebglRef.current = null;
      webglRef.current = null;
      terminal.dispose();
    };
  }, [sessionId]);

  // Visibility toggle side effects.
  // Fix: the ResizeObserver attached in the mount effect already fires a fit on
  // the next frame when the container resizes from hidden → visible, so the
  // previous double setTimeout(50ms/200ms) fit calls were redundant work inside
  // the 300ms toggle animation (a major source of visual jank). Here we just
  // manage focus; the fit happens through the observer.
  useEffect(() => {
    if (visible && terminalRef.current) {
      const raf = requestAnimationFrame(() => terminalRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    if (!visible && terminalRef.current) {
      terminalRef.current.blur();
    }
  }, [visible, sessionId]);

  // Write PTY output to terminal; notify registry when buffer is updated
  usePtyOutput(sessionId, (data) => {
    terminalRef.current?.write(data, () => notifyBufferReady(sessionId));
  });

  // xterm opacity is driven by `--terminal-xterm-opacity` (theme-engine writes
  // it from the theme's `background.terminal-opacity`, user slider overrides).
  // When no visual background is active we force a full-opacity `1` so solid
  // themes don't inherit a translucent xterm.
  const xtermOpacityStyle: React.CSSProperties['opacity'] = seeThrough
    ? 'var(--terminal-xterm-opacity)'
    : 1;

  return (
    <div
      className={visible ? undefined : 'terminal-hidden'}
      style={{
        position: 'absolute',
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
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: xtermOpacityStyle,
        }}
      />
    </div>
  );
}
