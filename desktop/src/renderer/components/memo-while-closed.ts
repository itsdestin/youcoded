import React from 'react';

/**
 * React.memo for a surface that is mounted all the time but only visible while
 * `open`: while it is closed (before AND after the update) every other prop
 * change is ignored, so the app shell re-rendering — which it does on every
 * session switch — does not rebuild a Settings tree, a drawer of skill cards or
 * a dialog nobody can see.
 *
 * WHY not plain React.memo: these surfaces get fresh inline callbacks from the
 * shell on every render, so a plain memo never bails out. WHY ignoring them is
 * safe: a closed surface draws nothing from its props, and the moment `open`
 * flips (either way) the comparison fails and it renders with the CURRENT
 * props — including the closing frame, so a slide-out animation still runs.
 * While open it compares shallowly like React.memo, so behaviour there is the
 * same as before (inline callbacks re-render it, as they always did).
 *
 * Its own state, context reads and store subscriptions are unaffected: memo only
 * stops renders that come from the parent. performance.md rule 2 ("hidden means
 * idle"); pinned by tests/busy-app-render-budget.test.tsx (switching budget).
 */
export function memoWhileClosed<P extends { open: boolean }>(Component: React.ComponentType<P>): React.MemoExoticComponent<React.ComponentType<P>> {
  return React.memo(Component, (prev, next) => {
    if (!prev.open && !next.open) return true;
    const a = prev as Record<string, unknown>;
    const b = next as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.is(a[k], b[k]));
  });
}
