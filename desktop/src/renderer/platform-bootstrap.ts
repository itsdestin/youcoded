// Synchronously sets window.__PLATFORM__ at module-graph head.
//
// Why this exists: on Android, remote-shim's auth:ok (which normally sets
// __PLATFORM__) arrives asynchronously over WebSocket, long after React
// modules have finished their import-time evaluation. Any `const x = isAndroid()`
// at module scope therefore captures the 'electron' fallback from platform.ts
// and stays wrong for the lifetime of the renderer — even after __PLATFORM__
// is eventually set, the constant is frozen. HeaderBar's toggleOnLeft const
// hit exactly this: the toggle rendered on the left on Android because
// isAndroid() returned false at import time.
//
// Fix: decide the platform from synchronously-available signals
// (location.protocol, window.claude) and write __PLATFORM__ before any
// component module is imported. ES modules guarantee source-order execution,
// so importing this file as the first statement in index.tsx runs it before
// App.tsx (and everything App transitively imports) evaluates its top level.
//
// Browser / remote-access case is intentionally left undefined here — the
// remote-shim auth:ok handler fills it in with the server's reported platform.
// No module-level code in the codebase assumes a specific 'browser' value at
// import time, so the pre-auth window is safe.

if (typeof window !== 'undefined' && !(window as any).__PLATFORM__) {
  // Fix: check window.claude BEFORE location.protocol. Packaged Electron on
  // Windows loads the renderer via win.loadFile() (main.ts), so
  // location.protocol === 'file:' is true on desktop too — same as Android's
  // WebView. Ordering the file-check first caused packaged desktop to be
  // mis-tagged as 'android', which leaked the Android settings UI, tier
  // picker, and html[data-platform="android"] CSS onto Windows in v1.1.x.
  // The Electron preload populates window.claude synchronously before any
  // renderer JS runs, so it's the reliable signal. Android WebView has no
  // preload — window.claude is installed later by remote-shim.ts — so it
  // correctly falls through to the file: branch here.
  if ((window as any).claude) {
    (window as any).__PLATFORM__ = 'electron';
  } else if (typeof location !== 'undefined' && location.protocol === 'file:') {
    (window as any).__PLATFORM__ = 'android';
  }
}

// Mirror __PLATFORM__ onto <html data-platform="..."> so platform-conditional
// CSS (e.g. hiding #theme-bg over the Android native terminal) can key off
// it without a re-render. Written here so it lands before any style evaluates.
if (typeof document !== 'undefined' && (window as any).__PLATFORM__) {
  document.documentElement.dataset.platform = (window as any).__PLATFORM__;
}

export {};
