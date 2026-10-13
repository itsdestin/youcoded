// A fake `window.claude.browser` + capabilities for the Browser's screen tests:
// records every call, lets a test push state and pictures the way main does.
import { vi } from 'vitest';
import type { BrowserInfo, BrowserSessionState } from '../../src/shared/browser-types';
import { resetBrowserStoreForTests } from '../../src/renderer/state/browser-store';

export function browserState(over: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return {
    sessionId: 's1', run: 'running', windowShown: false, myChrome: false, browserLabel: 'Google Chrome',
    tabs: [{ index: 0, title: 'Catalog', url: 'https://library.example.org/catalog', active: true }],
    prompt: null, error: null, used: true, busy: false, downloadPercent: null, ...over,
  };
}

export function browserInfo(over: Partial<BrowserInfo> = {}): BrowserInfo {
  return {
    running: true,
    browsers: [{ kind: 'chrome', label: 'Google Chrome', executablePath: '/usr/bin/google-chrome' }],
    chosen: { kind: 'chrome', label: 'Google Chrome', executablePath: '/usr/bin/google-chrome' },
    install: { phase: 'idle' },
    settings: { showWindow: false, useMyChrome: false, preferredBrowser: null, alwaysAllowedSites: [], explainerSeen: true },
    sessionsWithTabs: 0,
    ...over,
  };
}

/** Install the fake on window.claude (desktop capabilities) and reset the store. */
export function installBrowserBridge(info: BrowserInfo = browserInfo()) {
  resetBrowserStoreForTests();
  const stateCbs = new Set<(s: BrowserSessionState) => void>();
  const frameCbs = new Set<(f: { sessionId: string; data: string; width: number; height: number }) => void>();
  const infoCbs = new Set<() => void>();
  let current = info;
  const bridge = {
    state: vi.fn(async () => null),
    info: vi.fn(async () => current),
    watch: vi.fn(async () => true),
    unwatch: vi.fn(async () => true),
    ackFrame: vi.fn(),
    answer: vi.fn(async () => true),
    openWindowForHandoff: vi.fn(async () => true),
    setShowWindow: vi.fn(async (show: boolean) => (current = { ...current, settings: { ...current.settings, showWindow: show } })),
    updateSettings: vi.fn(async (patch: object) => (current = { ...current, settings: { ...current.settings, ...patch } })),
    removeSite: vi.fn(async (host: string) => (current = { ...current, settings: { ...current.settings, alwaysAllowedSites: current.settings.alwaysAllowedSites.filter((h) => h !== host) } })),
    clearSignins: vi.fn(async () => current),
    stop: vi.fn(async () => true),
    closeSession: vi.fn(async () => true),
    download: vi.fn(async () => current),
    cancelDownload: vi.fn(async () => true),
    checkMyChrome: vi.fn(async () => ({ ok: true, message: 'Chrome is ready.' })),
    onState: vi.fn((cb: (s: BrowserSessionState) => void) => { stateCbs.add(cb); return () => stateCbs.delete(cb); }),
    onFrame: vi.fn((cb: (f: any) => void) => { frameCbs.add(cb); return () => frameCbs.delete(cb); }),
    onInfoChanged: vi.fn((cb: () => void) => { infoCbs.add(cb); return () => infoCbs.delete(cb); }),
  };
  (window as any).claude = {
    ...(window as any).claude,
    capabilities: { assistantBrowser: true, openExternal: true, nativeWindows: true },
    browser: bridge,
  };
  return {
    bridge,
    pushState: (s: BrowserSessionState) => { for (const cb of stateCbs) cb(s); },
    pushFrame: (sessionId = 's1') => { for (const cb of frameCbs) cb({ sessionId, data: '/9j/', width: 1280, height: 800 }); },
    frameListeners: () => frameCbs.size,
  };
}
