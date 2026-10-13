// platform.ts — the ONE place the renderer learns what kind of screen it is and what that screen can do.
//
// WHY one module (one-core R4-1, seam S8): this used to be three — platform.ts (touch/android/remote), state/platform.ts
// (the OS name from IPC) and platform-bootstrap.ts (a synchronous patch for a startup race) — plus an ad-hoc `isDesktop`
// in build-menu.ts. Four answers to "where am I?" that could disagree.
//
// TWO KINDS OF QUESTION live here, and they are kept apart on purpose:
//   · "Can this screen DO x?" (open a file in the computer's own apps, tear a window out, read the terminal text...) is a
//     CAPABILITY. Ask `getCapabilities().x`. The host decides the answer and sends it in the handshake (seam S7,
//     shared/capabilities.ts); nothing here guesses it from the platform.
//   · "Does this screen LOOK or FEEL different?" (touch-sized buttons, a soft keyboard, a narrower layout) is a property of
//     the device. Ask `isAndroid()` / `isTouchDevice()` / `getPlatform()`. These are genuine look-and-feel differences, not
//     capability gaps. `isRemoteMode()` is the connection mode: the conversation lives on a computer this screen is
//     watching, which changes WHEN state is available (catching up after a drop), not what the screen can do.
import { useEffect, useState } from 'react';
import { useOnRemoteReconnect } from './hooks/useOnRemoteReconnect';
import { REMOTE_SCREEN_CAPABILITIES, normalizeCapabilities, type Capabilities } from '../shared/capabilities';

// ─── Startup: decide the platform before any component module evaluates ──────
//
// Why this runs at import: on Android, remote-shim's auth:ok (which normally sets __PLATFORM__) arrives asynchronously
// over WebSocket, long after React modules have finished their import-time evaluation. Any `const x = isAndroid()` at
// module scope therefore captures the 'electron' fallback below and stays wrong for the lifetime of the renderer.
// HeaderBar's toggleOnLeft const hit exactly this: the toggle rendered on the left on Android.
//
// Fix: decide the platform from synchronously-available signals (location.protocol, window.claude) and write
// __PLATFORM__ before any component module is imported. index.tsx imports this file FIRST, and ES modules evaluate in
// source order, so this runs before App.tsx (and everything App imports) evaluates its top level.
//
// Browser / remote-access case is intentionally left undefined here: remote-shim's auth:ok handler fills it in with the
// server's reported platform. No module-level code assumes a specific 'browser' value at import time.
if (typeof window !== 'undefined' && !(window as any).__PLATFORM__) {
  // Check window.claude BEFORE location.protocol. Packaged Electron on Windows loads the renderer via win.loadFile()
  // (main.ts), so location.protocol === 'file:' is true on desktop too, same as Android's WebView. Ordering the file
  // check first mis-tagged packaged desktop as 'android', which leaked the Android settings UI, tier picker and
  // html[data-platform="android"] CSS onto Windows in v1.1.x. The Electron preload populates window.claude
  // synchronously before any renderer JS runs, so it is the reliable signal. Android's WebView has no preload
  // (window.claude is installed later by remote-shim.ts), so it falls through to the file: branch.
  if ((window as any).claude) {
    (window as any).__PLATFORM__ = 'electron';
  } else if (typeof location !== 'undefined' && location.protocol === 'file:') {
    (window as any).__PLATFORM__ = 'android';
  }
}
// Mirror __PLATFORM__ onto <html data-platform="..."> so platform-conditional CSS (e.g. hiding #theme-bg over the Android
// native terminal) keys off it without a re-render. Written here so it lands before any style evaluates.
// `documentElement?.dataset` guard: platform.ts is imported by modules that run under a partly-faked `document` in tests
if (typeof document !== 'undefined' && document.documentElement?.dataset && typeof window !== 'undefined' && (window as any).__PLATFORM__) {
  document.documentElement.dataset.platform = (window as any).__PLATFORM__;
}

// ─── What kind of device this is (look and feel) ─────────────────────────────

export type Platform = 'electron' | 'android' | 'browser'

export function getPlatform(): Platform {
  // WHY the guard: HeaderBar reads this at module load (toggleOnLeft), and a
  // node-environment test that imports a screen which imports the band
  // (ProjectView → ScreenBand → HeaderBar) has no window at all.
  if (typeof window === 'undefined') return 'electron'
  return (window as any).__PLATFORM__ || 'electron'
}

export function isAndroid(): boolean {
  return getPlatform() === 'android'
}

export function isTouchDevice(): boolean {
  return getPlatform() === 'android' || getPlatform() === 'browser'
}

// ─── What this screen can do (capabilities) ──────────────────────────────────

/** What this screen can do, as the host said it. Read on every call (never cache it at import): the Android app's answer
 *  changes when it switches between its own runtime and a paired computer, and a screen that has heard nothing yet (or an
 *  older computer that never says) gets the conservative set. */
export function getCapabilities(): Capabilities {
  if (typeof window === 'undefined') return REMOTE_SCREEN_CAPABILITIES;
  const raw = (window as any).claude?.capabilities;
  // normalize on every read keeps a half-filled object (a test stub, a newer host with a key we lack) safe to index.
  return raw ? normalizeCapabilities(raw) : REMOTE_SCREEN_CAPABILITIES;
}

// ─── Connection mode (local native vs remote desktop) ───────────────────────

export type ConnectionMode = 'local' | 'remote'

let _connectionMode: ConnectionMode = 'local';
let _connectionModeListeners: ((mode: ConnectionMode) => void)[] = [];

export function isRemoteMode(): boolean {
  return _connectionMode === 'remote';
}

export function setConnectionMode(mode: ConnectionMode): void {
  if (_connectionMode === mode) return;
  _connectionMode = mode;
  _connectionModeListeners.forEach(cb => cb(mode));
}

export function onConnectionModeChange(cb: (mode: ConnectionMode) => void): () => void {
  _connectionModeListeners.push(cb);
  return () => {
    _connectionModeListeners = _connectionModeListeners.filter(l => l !== cb);
  };
}

// ─── The operating system (for OS-specific help text and settings) ───────────
//
// Wraps window.claude.getPlatform() and caches the result in module scope since the OS never changes over a session.
// Components call useCurrentPlatform(); the first render returns null, the effect resolves and re-renders with the real
// value on the next tick.

export type OsPlatform = 'darwin' | 'win32' | 'linux' | 'android';

let cachedOs: OsPlatform | null = null;
let inflightOs: Promise<OsPlatform> | null = null;

async function fetchOsPlatform(): Promise<OsPlatform> {
  if (cachedOs) return cachedOs;
  if (inflightOs) return inflightOs;
  const w = window as any;
  if (!w.claude?.getPlatform) {
    // Defensive fallback for older shims — detect Android via file: protocol.
    const fallback: OsPlatform = location.protocol === 'file:' ? 'android' : 'linux';
    cachedOs = fallback;
    return fallback;
  }
  const promise: Promise<OsPlatform> = w.claude.getPlatform().then((p: OsPlatform) => {
    cachedOs = p;
    inflightOs = null;
    return p;
  }, (err: unknown) => {
    // A failed read must not be the answer for the page's life: the rejected promise used to
    // stay in `inflight`, so every later call got the same failure (2026-09-11 phone pass sweep).
    inflightOs = null;
    throw err;
  });
  inflightOs = promise;
  return promise;
}

export function useCurrentPlatform(): OsPlatform | null {
  const [platform, setPlatform] = useState<OsPlatform | null>(cachedOs);
  useEffect(() => {
    if (cachedOs) { setPlatform(cachedOs); return; }
    let active = true;
    fetchOsPlatform().then((p) => { if (active) setPlatform(p); }).catch(() => { /* unknown until a retry */ });
    return () => { active = false; };
  }, []);
  // Still unknown after a remote reconnect: ask again. Unmounting removes the listener.
  useOnRemoteReconnect(() => {
    if (cachedOs) return;
    fetchOsPlatform().then(setPlatform).catch(() => { /* still unknown */ });
  });
  return platform;
}
