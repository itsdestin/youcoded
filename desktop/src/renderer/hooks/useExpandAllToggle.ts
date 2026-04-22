import { useEffect } from 'react';

// Shared toggle for the Ctrl+O "expand/collapse all" shortcut. Two layers:
//
//   1. A module-level `currentMode` flag so late-mounted components (e.g. the
//      child ToolCards inside a CollapsedToolGroup that only renders its
//      children once expanded) can read the current mode at mount time via
//      `getInitialExpanded()` and start in the right state.
//   2. DOM events to reach components that are already mounted when the
//      shortcut fires, via `useExpandAllToggle()`.
//
// App.tsx's Ctrl+O handler calls `broadcastExpandAll()` / `broadcastCollapseAll()`
// which update the flag AND dispatch the event. The flag persists until the
// next shortcut press, so a tool card that mounts 5 minutes after an
// expand-all will still come up expanded.
type Mode = 'default' | 'expanded' | 'collapsed';
let currentMode: Mode = 'default';

const EXPAND_ALL_EVENT = 'ui:expand-tool-cards';
const COLLAPSE_ALL_EVENT = 'ui:collapse-tool-cards';

// Use as a `useState` initializer. When mode is 'default' (before any
// shortcut press) the caller's own default wins.
export function getInitialExpanded(defaultOpen: boolean = false): boolean {
  if (currentMode === 'expanded') return true;
  if (currentMode === 'collapsed') return false;
  return defaultOpen;
}

// True whenever the user has invoked the shortcut at least once. Used by
// AgentView to suppress its auto-collapse-on-response effect so it doesn't
// fight an explicit Ctrl+O back closed.
export function isExpandModeActive(): boolean {
  return currentMode !== 'default';
}

export function isInExpandAllMode(): boolean {
  return currentMode === 'expanded';
}

export function broadcastExpandAll(): void {
  currentMode = 'expanded';
  window.dispatchEvent(new CustomEvent(EXPAND_ALL_EVENT));
}

export function broadcastCollapseAll(): void {
  currentMode = 'collapsed';
  window.dispatchEvent(new CustomEvent(COLLAPSE_ALL_EVENT));
}

export function useExpandAllToggle(onExpand: () => void, onCollapse: () => void): void {
  useEffect(() => {
    const expand = () => onExpand();
    const collapse = () => onCollapse();
    window.addEventListener(EXPAND_ALL_EVENT, expand);
    window.addEventListener(COLLAPSE_ALL_EVENT, collapse);
    return () => {
      window.removeEventListener(EXPAND_ALL_EVENT, expand);
      window.removeEventListener(COLLAPSE_ALL_EVENT, collapse);
    };
  }, [onExpand, onCollapse]);
}
