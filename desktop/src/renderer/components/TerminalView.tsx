import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { usePtyOutput } from '../hooks/useIpc';
import { registerTerminal, unregisterTerminal, notifyBufferReady } from '../hooks/terminal-registry';
import { useTheme } from '../state/theme-context';

/** Read the current theme CSS variables and return an xterm ITheme. */
function getXtermTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const s = getComputedStyle(document.documentElement);
  const fg = s.getPropertyValue('--fg').trim() || '#E0E0E0';
  const accent = s.getPropertyValue('--accent').trim() || '#264f78';
  // When glassmorphism is active, make xterm background transparent so the
  // wallpaper shows through the frosted container behind it
  const hasBlur = document.documentElement.hasAttribute('data-panels-blur');
  const bg = hasBlur ? 'transparent' : (s.getPropertyValue('--canvas').trim() || '#0A0A0A');
  // Selection: accent at 30% opacity
  return { background: bg, foreground: fg, cursor: fg, selectionBackground: accent + '4D' };
}

/** Check if glassmorphism is active. */
function hasGlassmorphism(): boolean {
  return document.documentElement.hasAttribute('data-panels-blur');
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
  const { theme, font, activeTheme } = useTheme();

  // Sync xterm theme when app theme changes (activeTheme changes on hot-reload too,
  // not just slug switches — so we depend on the full object, not just the slug)
  useEffect(() => {
    if (!terminalRef.current) return;
    // Microtask delay: CSS variables may not be painted yet when this effect fires
    requestAnimationFrame(() => {
      if (!terminalRef.current) return;
      terminalRef.current.options.theme = getXtermTheme();

      // WebGL addon renders on an opaque canvas that blocks body background-image
      // (wallpaper) from showing through. Dispose it when glassmorphism is active
      // so the DOM renderer is used (which handles transparent backgrounds via CSS).
      // Re-attach when glassmorphism is off for better rendering performance.
      const glass = hasGlassmorphism();
      if (glass && webglRef.current) {
        webglRef.current.dispose();
        webglRef.current = null;
      } else if (!glass && !webglRef.current) {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          terminalRef.current.loadAddon(webgl);
          webglRef.current = webgl;
        } catch {
          // Falls back to DOM renderer if WebGL unavailable
        }
      }
    });
  }, [activeTheme]);

  // Sync xterm font when app font changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontFamily = font;
      // Re-fit after font change since glyph widths may differ
      try { fitAddonRef.current?.fit(); } catch {}
    }
  }, [font]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 14,
      fontFamily: font,
      theme: getXtermTheme(),
    });

    const fitAddon = new FitAddon();
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = '11';
    terminal.open(containerRef.current);

    // WebGL renderer must be loaded after open() — eliminates grid-line
    // artifacts from the DOM renderer's sub-pixel rounding issues.
    // Skip when glassmorphism is active — the WebGL canvas is opaque
    // and blocks the wallpaper from showing through.
    if (!hasGlassmorphism()) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        terminal.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        // Falls back to DOM renderer if WebGL unavailable
      }
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

  const glass = hasGlassmorphism();

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
        background: glass ? 'transparent' : 'var(--canvas)',
        backdropFilter: glass ? 'blur(24px) saturate(1.2)' : undefined,
        WebkitBackdropFilter: glass ? 'blur(24px) saturate(1.2)' : undefined,
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
    />
  );
}
