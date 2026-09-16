// Registers window.__terminalRegistry so the main process can call
// getScreenText on the correct session's xterm via executeJavaScript.
//
// Why this indirection exists: contextBridge deep-freezes the exposed
// window.claude object, so the renderer cannot add new properties to it
// after preload.ts runs. Instead, main-side executeJavaScript reaches
// this registry directly to read the live xterm buffer.
//
// This file runs once at renderer load (imported from App.tsx) — well
// before any TerminalView mounts and calls registerTerminal(), so the
// registry object is in place when the first getScreenText round-trip
// arrives.
import { getAtlasClears, getScreenText } from '../hooks/terminal-registry';

(window as unknown as {
  __terminalRegistry?: {
    getScreenText: (id: string, tailRows?: number) => string | null;
    readonly atlasClears: number;
  };
})
  .__terminalRegistry = {
    getScreenText,
    // WHY a getter (2026-09-10): rig instrument — the perf rig reads
    // `window.__terminalRegistry.atlasClears` over CDP before and after each
    // session switch to count glyph-atlas clears per switch. A getter reads the
    // live module counter; a plain property would freeze at 0 here.
    get atlasClears() {
      return getAtlasClears();
    },
  };
