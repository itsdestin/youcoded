import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { usePtyOutput } from '../hooks/useIpc';
import { registerTerminal, unregisterTerminal, notifyBufferReady } from '../hooks/terminal-registry';
import { useTheme } from '../state/theme-context';

/** Ensure the font string always falls back to monospace for the terminal grid. */
function safeTerminalFont(font: string): string {
  return font.includes('monospace') ? font : `${font}, monospace`;
}

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
  const { theme, font, activeTheme, reducedEffects } = useTheme();

  // Detect if the theme has a visual background (wallpaper image, gradient, or glassmorphism)
  const bg = activeTheme?.background;
  const hasWallpaper = bg?.type === 'image' && !!bg.value;
  const hasGradient = bg?.type === 'gradient' && !!bg.value;
  const hasBlur = !!(bg?.['panels-blur'] && bg['panels-blur'] > 0 && !reducedEffects);
  // Terminal needs to be see-through when any visual background is active
  const seeThrough = hasWallpaper || hasGradient || hasBlur;

  // Sync xterm theme when app theme changes. Always keep WebGL for performance.
  useEffect(() => {
    if (!terminalRef.current) return;
    requestAnimationFrame(() => {
      if (!terminalRef.current) return;
      // Always use opaque xterm background — transparency is handled by the
      // container overlay, not by xterm itself. WebGL requires opaque backgrounds.
      terminalRef.current.options.theme = getXtermTheme(false);

      // Ensure WebGL is attached (may have been disposed by a previous version)
      if (!webglRef.current) {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          terminalRef.current.loadAddon(webgl);
          webglRef.current = webgl;
        } catch {}
      }
    });
  }, [activeTheme]);

  // Sync xterm font when app font changes — wait for the font to load before
  // applying so xterm measures character cells against the real glyphs, not a
  // fallback font that happens to be rendered while the real one downloads.
  useEffect(() => {
    if (!terminalRef.current) return;
    let cancelled = false;
    const safe = safeTerminalFont(font);

    document.fonts.ready
      .then(() => document.fonts.load(`14px ${font}`))
      .then(() => {
        if (cancelled || !terminalRef.current) return;
        terminalRef.current.options.fontFamily = safe;
        try { fitAddonRef.current?.fit(); } catch {}
      });

    return () => { cancelled = true; };
  }, [font]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'monospace', // Start with monospace; real font applied after load via effect
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
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
      webglRef.current = webgl;
    } catch {
      // Falls back to DOM renderer if WebGL unavailable
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    registerTerminal(sessionId, terminal);

    // Signal to main process that we're ready to receive PTY output.
    // This flushes any buffered output that arrived before mount.
    window.claude.session.signalReady(sessionId);

    // Fit terminal to container and sync dimensions to PTY
    const fitAndSync = () => {
      try {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        if (dims && dims.cols && dims.rows) {
          window.claude.session.resize(sessionId, dims.cols, dims.rows);
        }
      } catch {
        // Ignore fit errors during teardown
      }
    };

    // Initial fit with delay to ensure container is laid out
    const timer = setTimeout(fitAndSync, 100);

    // Send user keyboard input to PTY
    terminal.onData((data) => {
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
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      window.removeEventListener('resize', fitAndSync);
      resizeObserver.disconnect();
      unregisterTerminal(sessionId);
      terminal.dispose();
    };
  }, [sessionId]);

  // Re-fit when visible, blur when hidden (prevents xterm stealing keyboard input)
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current!.fit();
          const dims = fitAddonRef.current!.proposeDimensions();
          if (dims && dims.cols && dims.rows) {
            window.claude.session.resize(sessionId, dims.cols, dims.rows);
          }
          terminalRef.current?.focus();
        } catch {
          // Ignore
        }
      }, 50);
      return () => clearTimeout(timer);
    } else if (!visible && terminalRef.current) {
      terminalRef.current.blur();
    }
  }, [visible, sessionId]);

  // Write PTY output to terminal; notify registry when buffer is updated
  usePtyOutput(sessionId, (data) => {
    terminalRef.current?.write(data, () => notifyBufferReady(sessionId));
  });

  return (
    <div
      ref={containerRef}
      className={visible ? undefined : 'terminal-hidden'}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        // When a wallpaper/gradient is active, reduce terminal opacity so
        // the background peeks through. WebGL stays loaded (no lag), and
        // the text remains readable at 88% opacity.
        opacity: seeThrough ? 0.88 : 1,
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
    />
  );
}
