import { useEffect } from 'react';
import type { RefObject } from 'react';

// Chrome geometry observers extracted from AppInner (tranche 1) — logic
// unchanged. Publishes --bottom-chrome-height / --top-chrome-height /
// --top-chrome-bottom CSS vars (glassmorphism scroll-behind + drawer
// positioning).
//
// The [sessionId, currentViewMode] deps are re-run TRIGGERS (the chrome
// remounts on view/session changes so the observers must re-attach), not
// values read inside — preserved exactly. Must be called BEFORE AppInner's
// early returns so hook order stays consistent across renders.
export function useChromeMeasurements(
  headerRef: RefObject<HTMLDivElement | null>,
  bottomBarRef: RefObject<HTMLDivElement | null>,
  sessionId: string | null,
  currentViewMode: string,
) {
  // Track bottom chrome height for glassmorphism scroll-behind.
  // Sets --bottom-chrome-height CSS variable so .chat-scroll can add matching
  // padding-bottom, allowing messages to scroll behind the frosted input/status bars.
  useEffect(() => {
    const bottom = bottomBarRef.current;
    if (!bottom) return;
    const update = () => {
      const h = Math.ceil(bottom.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--bottom-chrome-height', `${h}px`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(bottom);
    update();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--bottom-chrome-height');
    };
  }, [sessionId, currentViewMode]);

  // Track top chrome (HeaderBar) bottom edge for the artifact drawer.
  // The drawer-pane sits inside .framed-shell beneath the absolute HeaderBar,
  // so its content needs to clear the rendered bottom of the header. Two vars
  // are published:
  //   --top-chrome-height — the header element's own height. Used by
  //     .chat-scroll padding-top so chat content scrolls behind the chrome.
  //   --top-chrome-bottom — the y-coordinate of the header's BOTTOM in the
  //     window. Used by .drawer-pane to position itself just below the
  //     header. The distinction matters for floating-chrome themes where
  //     the header pill carries its own margin-top — the header's
  //     bottom is then at `margin + height`, not just `height`, so
  //     drawer.margin-top must use the rect's bottom value or the drawer
  //     ends up flush against the floating header with no gap.
  // Both vars track ResizeObserver updates on the .header-bar element.
  //
  // NOTE: we measure the inner .header-bar element, NOT the chrome-wrapper at
  // headerRef. The wrapper has no specified height and its only child is the
  // position: absolute .header-bar (no flow content) — measuring the wrapper
  // returns 0, which is what made the first attempt at this observer ineffective.
  useEffect(() => {
    const wrapper = headerRef.current;
    if (!wrapper) return;
    const headerBar = wrapper.querySelector('.header-bar');
    if (!headerBar) return;
    const update = () => {
      const rect = (headerBar as HTMLElement).getBoundingClientRect();
      document.documentElement.style.setProperty('--top-chrome-height', `${Math.ceil(rect.height)}px`);
      document.documentElement.style.setProperty('--top-chrome-bottom', `${Math.ceil(rect.bottom)}px`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(headerBar);
    update();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--top-chrome-height');
      document.documentElement.style.removeProperty('--top-chrome-bottom');
    };
  }, [sessionId, currentViewMode]);

  // The Android "layout-update" report that used to live here (header/bottom
  // heights broadcast to native for terminal-overlay sizing) was deleted on
  // 2026-09-10: its only consumer was the native Compose terminal removed in
  // Tier 2 (2026-07-22), so every ResizeObserver tick was a message into a flow
  // nobody collected.
}
