// `window.claude.browser` for the workbench (2026-10-13): fixture states so the
// Browser panel, the ask card and Settings → Browser can be built and
// photographed without a main process or a real browser.
//
// `?browser=<scene>` picks what the active conversation's browser is doing:
//   working (default when set) · site · final · local · handoff · no-browser ·
//   downloading · error · starting · explainer (first-run explainer showing)
// Without the switch the browser says nothing, exactly like a conversation that
// never browsed (no header button, no panel).
import type { BrowserInfo, BrowserPreferences, BrowserSessionState } from '../../../shared/browser-types';
import { BROWSER_FRAME_JPEG } from './fixtures/browser-frame';

export function createBrowserMock(sessionIds: () => string[]) {
  const scene = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('browser') : null;
  const prefs: BrowserPreferences = {
    showWindow: false, useMyChrome: false, preferredBrowser: null,
    alwaysAllowedSites: scene ? ['library.example.org', 'github.com'] : [],
    explainerSeen: scene !== 'explainer',
  };
  const stateListeners = new Set<(s: BrowserSessionState) => void>();
  const frameListeners = new Set<(f: { sessionId: string; data: string; width: number; height: number }) => void>();
  const infoListeners = new Set<() => void>();

  const tabs = [
    { index: 0, title: 'Riverside Public Library — Catalog', url: 'https://library.example.org/catalog?q=the+night+circus', active: true, loading: false, canGoBack: true, canGoForward: false },
    { index: 1, title: 'Hours and locations', url: 'https://library.example.org/hours', active: false, loading: true, canGoBack: false, canGoForward: false },
  ];

  function stateFor(sessionId: string): BrowserSessionState {
    const base: BrowserSessionState = {
      sessionId, run: 'running', windowShown: false, myChrome: false, browserLabel: 'Google Chrome',
      tabs, prompt: null, error: null, used: true, busy: scene === 'working', downloadPercent: null,
      zoom: { percent: 45, auto: true },
    };
    switch (scene) {
      case 'site': return { ...base, busy: true, prompt: { kind: 'site', id: 'p1', host: 'library.example.org', allowAlways: true, message: 'Let the assistant click and type on library.example.org?' } };
      case 'final': return { ...base, busy: true, prompt: { kind: 'final', id: 'p2', host: 'library.example.org', message: 'The assistant wants to click "Place hold" on library.example.org.' } };
      case 'local': return { ...base, busy: true, prompt: { kind: 'local', id: 'p3', host: '192.168.1.1:80', message: 'The assistant wants to open 192.168.1.1:80, an address on this computer or your home network.' } };
      case 'handoff': return { ...base, busy: true, prompt: { kind: 'handoff', id: 'p4', message: 'Please sign in to your library account, then press I\'m done.' } };
      case 'no-browser': return { ...base, run: 'stopped', tabs: [], busy: true, prompt: { kind: 'no-browser', id: 'p5', message: 'The assistant needs a browser for this. YouCoded can download one for it (about 150 MB, kept inside YouCoded).' } };
      case 'downloading': return { ...base, run: 'stopped', tabs: [], busy: false, downloadPercent: 42 };
      case 'error': return { ...base, run: 'error', tabs: [], busy: false, error: 'The browser couldn\'t start because its saved data is in use by another copy of YouCoded. Close the other copy and try again.' };
      case 'starting': return { ...base, run: 'starting', tabs: [], busy: true };
      default: return base;
    }
  }

  const info = (): BrowserInfo => ({
    running: !!scene && scene !== 'error' && scene !== 'downloading' && scene !== 'no-browser',
    browsers: scene === 'no-browser' || scene === 'downloading' ? [] : [
      { kind: 'chrome', label: 'Google Chrome', executablePath: '/usr/bin/google-chrome-stable' },
      { kind: 'edge', label: 'Microsoft Edge', executablePath: '/usr/bin/microsoft-edge' },
    ],
    chosen: scene === 'no-browser' || scene === 'downloading' ? null : { kind: 'chrome', label: 'Google Chrome', executablePath: '/usr/bin/google-chrome-stable' },
    install: scene === 'downloading' ? { phase: 'downloading', percent: 42 } : { phase: 'idle' },
    settings: { ...prefs },
    sessionsWithTabs: scene ? 2 : 0,
  });

  const emitInfo = () => { for (const l of infoListeners) l(); };

  return {
    state: async (sessionId: string) => (scene ? stateFor(sessionId) : null),
    info: async () => info(),
    watch: async (sessionId: string) => {
      if (scene) setTimeout(() => { for (const l of frameListeners) l({ sessionId, data: BROWSER_FRAME_JPEG, width: 1280, height: 800 }); }, 0);
      return true;
    },
    unwatch: async () => true,
    ackFrame: () => {},
    answer: async () => true,
    openWindowForHandoff: async () => true,
    setShowWindow: async (show: boolean) => { prefs.showWindow = show; emitInfo(); return info(); },
    updateSettings: async (patch: Partial<BrowserPreferences>) => { Object.assign(prefs, patch); emitInfo(); return info(); },
    removeSite: async (host: string) => { prefs.alwaysAllowedSites = prefs.alwaysAllowedSites.filter((h) => h !== host); emitInfo(); return info(); },
    clearSignins: async () => info(),
    stop: async () => true,
    closeSession: async () => true,
    download: async () => info(),
    cancelDownload: async () => true,
    checkMyChrome: async () => ({ ok: false, message: 'Chrome isn\'t open, or its remote-debugging switch is off.' }),
    open: async () => ({ ok: true }),
    input: () => {},
    viewSize: () => {},
    selection: async () => '',
    onState: (cb: (s: BrowserSessionState) => void) => {
      stateListeners.add(cb);
      // Tell the screen about every conversation at once, as the real app does
      // when a conversation's browser changes.
      if (scene) setTimeout(() => { for (const id of sessionIds()) cb(stateFor(id)); }, 0);
      return () => { stateListeners.delete(cb); };
    },
    onFrame: (cb: (f: { sessionId: string; data: string; width: number; height: number }) => void) => {
      frameListeners.add(cb);
      return () => { frameListeners.delete(cb); };
    },
    onInfoChanged: (cb: () => void) => { infoListeners.add(cb); return () => { infoListeners.delete(cb); }; },
  };
}
