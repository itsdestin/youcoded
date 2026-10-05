import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// Chrome geometry observers extracted from AppInner (tranche 1) — logic
// unchanged. Publishes --bottom-chrome-height / --top-chrome-height /
// --top-chrome-bottom CSS vars (glassmorphism scroll-behind + drawer
// positioning).
//
// Check the current chrome DOM nodes after every commit: an active session
// switch can leave both nodes intact, while a view change can replace either.
// Must be called BEFORE AppInner's early returns so hook order stays consistent.
// WHY skip identical writes: a var on <html> is inherited by every element, so each
// write restyles the whole page and recomputes the chrome's cut-out shape. The
// observers fire on sub-pixel size changes that round (Math.ceil) to the same px.
// Reads the live inline value (not a cached copy); node replacement can reuse
// an identical size without triggering an inherited CSS invalidation.
function setRootVar(name: string, value: string): void {
  const style = document.documentElement.style;
  if (style.getPropertyValue(name) === value) return;
  style.setProperty(name, value);
}

export function useChromeMeasurements(
  headerRef: RefObject<HTMLDivElement | null>,
  bottomBarRef: RefObject<HTMLDivElement | null>,
  _sessionId: string | null,
  _currentViewMode: string,
) {
  const bottomOwner = useRef<{ node: HTMLElement; observer: ResizeObserver } | null>(null);
  const topOwner = useRef<{ node: Element; observer: ResizeObserver } | null>(null);
  // WHY: trace of a chat-to-chat switch showed removeProperty on <html>
  // invalidating thousands of live transcript nodes before scrollHeight and
  // chrome reads force style flushes. Keep the same-node observer and inherited
  // values across session changes; only a genuinely new node needs re-observe.
  // Track bottom chrome height for glassmorphism scroll-behind.
  // Sets --bottom-chrome-height CSS variable so .chat-scroll can add matching
  // padding-bottom, allowing messages to scroll behind the frosted input/status bars.
  useEffect(() => {
    const bottom = bottomBarRef.current;
    if (bottomOwner.current?.node === bottom) return;
    bottomOwner.current?.observer.disconnect();
    bottomOwner.current = null;
    if (!bottom) return;
    const update = () => {
      if (bottomOwner.current?.node !== bottom) return;
      setRootVar('--bottom-chrome-height', `${Math.ceil(bottom.getBoundingClientRect().height)}px`);
    };
    const observer = new ResizeObserver(update);
    bottomOwner.current = { node: bottom, observer };
    observer.observe(bottom);
    update();
  });

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
  // Size changes track the .header-bar ResizeObserver; the body's narrow
  // appearance attribute signal below covers position changes without resize.
  //
  // NOTE: we measure the inner .header-bar element, NOT the chrome-wrapper at
  // headerRef. The wrapper has no specified height and its only child is the
  // position: absolute .header-bar (no flow content) — measuring the wrapper
  // returns 0, which is what made the first attempt at this observer ineffective.
  useEffect(() => {
    const wrapper = headerRef.current;
    const headerBar = wrapper?.querySelector('.header-bar') ?? null;
    if (topOwner.current?.node === headerBar) return;
    topOwner.current?.observer.disconnect();
    topOwner.current = null;
    if (!headerBar) return;
    const update = () => {
      if (topOwner.current?.node !== headerBar) return;
      const rect = headerBar.getBoundingClientRect();
      setRootVar('--top-chrome-height', `${Math.ceil(rect.height)}px`);
      setRootVar('--top-chrome-bottom', `${Math.ceil(rect.bottom)}px`);
    };
    const observer = new ResizeObserver(update);
    topOwner.current = { node: headerBar, observer };
    observer.observe(headerBar);
    update();
  });

  useEffect(() => {
    // WHY: a float/framed theme can change only header position (6px margin),
    // leaving its size unchanged; ResizeObserver cannot publish that new bottom.
    // Watch the same narrow body signals as HeaderBar's own position observer,
    // never session ID or all theme mutations, and retain the node ownership gate.
    const observer = new MutationObserver(() => {
      const owner = topOwner.current;
      if (!owner?.node.isConnected) return;
      const rect = owner.node.getBoundingClientRect();
      setRootVar('--top-chrome-height', `${Math.ceil(rect.height)}px`);
      setRootVar('--top-chrome-bottom', `${Math.ceil(rect.bottom)}px`);
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-chrome-style', 'data-header-style'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    // The app owns these global vars only while its measured chrome is mounted.
    bottomOwner.current?.observer.disconnect();
    topOwner.current?.observer.disconnect();
    bottomOwner.current = null;
    topOwner.current = null;
    for (const name of ['--bottom-chrome-height', '--top-chrome-height', '--top-chrome-bottom']) {
      document.documentElement.style.removeProperty(name);
    }
  }, []);

  // The Android "layout-update" report that used to live here (header/bottom
  // heights broadcast to native for terminal-overlay sizing) was deleted on
  // 2026-09-10: its only consumer was the native Compose terminal removed in
  // Tier 2 (2026-07-22), so every ResizeObserver tick was a message into a flow
  // nobody collected.
}
