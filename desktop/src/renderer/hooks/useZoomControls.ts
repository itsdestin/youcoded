import { useState, useRef, useEffect, useCallback } from 'react';
import { getPlatform } from '../platform';

// Zoom subsystem (Ctrl+/-/0, trackpad pinch, transient overlay state).
// Extracted from AppInner (tranche 1) — logic unchanged. The handler refs are
// assigned every render on purpose so the once-registered window listeners
// always see the latest callbacks without re-registering (App.tsx R8 pattern).
export function useZoomControls() {
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomVisible, setZoomVisible] = useState(false);
  const zoomHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch actual zoom level on mount — Electron may have persisted a non-100% zoom
  useEffect(() => {
    (window as any).claude?.zoom?.get?.().then((p: number) => {
      if (p && p !== 100) setZoomPercent(p);
    }).catch(() => {});
  }, []);

  // --- Zoom controls (Ctrl+/-, Ctrl+0, trackpad pinch) ---
  const showZoom = useCallback((percent: number) => {
    setZoomPercent(percent);
    setZoomVisible(true);
    if (zoomHideTimer.current) clearTimeout(zoomHideTimer.current);
    zoomHideTimer.current = setTimeout(() => setZoomVisible(false), 1500);
  }, []);

  const handleZoomIn = useCallback(async () => {
    const percent = await (window as any).claude.zoom.zoomIn();
    showZoom(percent);
  }, [showZoom]);

  const handleZoomOut = useCallback(async () => {
    const percent = await (window as any).claude.zoom.zoomOut();
    showZoom(percent);
  }, [showZoom]);

  const handleZoomReset = useCallback(async () => {
    const percent = await (window as any).claude.zoom.reset();
    showZoom(percent);
  }, [showZoom]);

  // Refs so the event listeners always see the latest callbacks without re-registering
  const zoomInRef = useRef(handleZoomIn);
  const zoomOutRef = useRef(handleZoomOut);
  const zoomResetRef = useRef(handleZoomReset);
  zoomInRef.current = handleZoomIn;
  zoomOutRef.current = handleZoomOut;
  zoomResetRef.current = handleZoomReset;

  // Keyboard: Ctrl+Plus, Ctrl+Minus, Ctrl+0
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // '+' comes as '=' on US keyboards (Shift not required), or '+' with Shift,
      // or via numpad ('+'). Ctrl+= is the standard "zoom in" shortcut.
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomInRef.current();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOutRef.current();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomResetRef.current();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Trackpad pinch-to-zoom — Chromium/Electron fires wheel events with ctrlKey
  // set to true for pinch gestures. Debounce to avoid spamming IPC.
  const pinchAccumulator = useRef(0);
  const pinchFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // True only in the desktop (Electron) app — see the long WHY where the wheel listener is registered.
    // Read here, not at import, so a test can set the platform first.
    const SCROLL_NEVER_WAITS = getPlatform() === 'electron';
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // Only intercept pinch (ctrlKey) wheel events
      // The artifact viewer owns pinch/ctrl+wheel over a picture. This listener
      // is capture-phase on window and does NOT stopPropagation, so without this
      // bail BOTH handlers run and a single pinch resizes the app and the image
      // together — two zoom readouts moving at once in opposite corners.
      if ((e.target as Element | null)?.closest?.('[data-zoomable]')) return;
      // Only a cancelable listener may cancel. On the desktop app the listener is passive (see below), where
      // the call would do nothing but log a console warning on every pinch tick.
      if (!SCROLL_NEVER_WAITS) e.preventDefault();

      // Accumulate delta and flush after a short pause — prevents one pinch
      // gesture from firing dozens of IPC calls
      pinchAccumulator.current += e.deltaY;

      if (pinchFlushTimer.current) clearTimeout(pinchFlushTimer.current);
      pinchFlushTimer.current = setTimeout(async () => {
        const delta = pinchAccumulator.current;
        pinchAccumulator.current = 0;
        if (Math.abs(delta) < 5) return; // Ignore tiny jitter
        if (delta < 0) {
          zoomInRef.current();
        } else {
          zoomOutRef.current();
        }
      }, 50);
    };
    // WHY the platform split (measured 2026-10-04, docs/active/investigations/2026-10-04-performance-gap-review.md 4d):
    // a NON-passive wheel listener on window makes the browser ask the page's main thread before it scrolls
    // ANYTHING, so whenever the page is busy (a reply streaming, a terminal flood) every scroll waits. On the
    // desktop app that wait was ~400 ms of a 400 ms main-thread block, in all 24 of 24 trials. A passive listener
    // lets the compositor scroll on its own; this listener still sees every ctrl+wheel and still does the zoom,
    // it just cannot cancel the browser's own reaction. Desktop does not need to: the app turns the browser's
    // pinch zoom off (main.ts setVisualZoomLevelLimits(1, 1)) and Electron's own ctrl+wheel reaction is only a
    // 'zoom-changed' event nobody listens to, so there is nothing to cancel (measured: a ctrl+wheel over a
    // scroller zooms the app and moves nothing). Remote browsers and Android WebView keep the cancelable
    // listener: there the browser's OWN page zoom is what preventDefault stops, so removing it would zoom the
    // page twice. Those surfaces are unchanged from before.
    window.addEventListener('wheel', handler, { passive: SCROLL_NEVER_WAITS, capture: true });
    return () => window.removeEventListener('wheel', handler, true);
  }, []);

  return { zoomPercent, zoomVisible, handleZoomIn, handleZoomOut, handleZoomReset };
}
