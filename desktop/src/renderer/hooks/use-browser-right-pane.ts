// The Browser panel's place in the chat's ONE right-side slot (2026-10-13; spec
// docs/active/specs/2026-10-13-assistant-browser-design.md §1). Lifted out of App.
//
// Same rule as Session Files and Games: opening one pane closes the others.
// And the first time a conversation's hidden browser shows pages this run, its
// panel opens by itself — unless another right pane is in use (never replace
// what the person had open; the header button's dot says it instead).
//
// Reads two BOOLEAN slices of state/browser-store.ts, so a busy browser's state
// pushes never redraw App (performance rule 3).
import { useEffect, useRef } from 'react';
import { browserSupported, closeBrowserPane, openBrowserPane, useBrowserPaneOpen, useBrowserWantsPane } from '../state/browser-store';

export function useBrowserRightPane(
  sessionId: string | null,
  drawerOpen: boolean,
  gamePanelOpen: boolean,
  closeDrawer: () => void,
  toggleGamePanel: () => void,
): boolean {
  const open = useBrowserPaneOpen(sessionId) && browserSupported();
  // Transition-gated like App's drawer/games pair: each effect keys on the
  // OTHER side only, so closing one pane never re-opens another.
  useEffect(() => {
    if (!open || !sessionId) return;
    if (drawerOpen) closeDrawer();
    if (gamePanelOpen) toggleGamePanel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if ((drawerOpen || gamePanelOpen) && sessionId) closeBrowserPane(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen, gamePanelOpen]);
  const wants = useBrowserWantsPane(sessionId);
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (!wants || !sessionId || autoOpened.current.has(sessionId)) return;
    autoOpened.current.add(sessionId);
    if (!drawerOpen && !gamePanelOpen) openBrowserPane(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wants, sessionId]);
  return open;
}
