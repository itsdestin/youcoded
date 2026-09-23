// Probes the busy-app harness (tests/helpers/busy-app.tsx) installs through
// vi.mock BEFORE the app's modules load. Kept apart from busy-app.tsx on
// purpose: a vi.mock factory that imported App.tsx would import the very
// module it is mocking (App → ChatView → factory → App) and deadlock.
//
// Two jobs:
//   1. A fake xterm. jsdom has no canvas/WebGL; the app's TerminalView only
//      needs a Terminal-shaped object to mount, write into and dispose.
//   2. Render counters around each session's heavy subtrees (ChatView and
//      TerminalView). The wrapper is a <Profiler> INSIDE a copy of the real
//      export's memo — so it bails out exactly when the real component would,
//      and it fires when that component renders OR anything under it commits
//      (a ThinkingIndicator's own timer, a context read deep in a bubble).
import React from 'react';

/** sessionId → number of commits that touched that session's subtree. */
export const subtreeRenders = {
  chat: new Map<string, number>(),
  terminal: new Map<string, number>(),
};

/** sessionId → the `visible` prop that session's ChatView last rendered with. */
export const lastVisible = new Map<string, boolean>();

export function resetSubtreeRenders(): void {
  subtreeRenders.chat.clear();
  subtreeRenders.terminal.clear();
}

type Kind = keyof typeof subtreeRenders;

function bump(kind: Kind, sessionId: string): void {
  const m = subtreeRenders[kind];
  m.set(sessionId, (m.get(sessionId) ?? 0) + 1);
}

// React's internal marker for React.memo objects. Read, not relied on for
// behaviour: a component that is NOT memoised gets a plain wrapper, so the
// probe never adds a bail-out the real app does not have.
const MEMO = Symbol.for('react.memo');

/** Wraps a component export so every render of its subtree is counted under
 *  `props.sessionId`. Keeps the real export's memo (and comparator) exactly. */
export function probe<P extends { sessionId: string }>(real: any, kind: Kind): React.ComponentType<P> {
  const isMemo = real && typeof real === 'object' && real.$$typeof === MEMO;
  const Inner: React.ComponentType<P> = isMemo ? real.type : real;
  function Probed(props: P) {
    if (kind === 'chat') lastVisible.set(props.sessionId, !!(props as any).visible);
    return (
      <React.Profiler id={`${kind}:${props.sessionId}`} onRender={() => bump(kind, props.sessionId)}>
        <Inner {...props} />
      </React.Profiler>
    );
  }
  Probed.displayName = `Probed(${kind})`;
  return (isMemo ? React.memo(Probed, real.compare ?? undefined) : Probed) as React.ComponentType<P>;
}

/** Everything written into any fake terminal, by write order. */
export const terminalWrites: string[] = [];

/** A module shaped like '@xterm/xterm'. Unknown members answer with a no-op
 *  that returns a disposable, so a new xterm call in TerminalView degrades to
 *  "does nothing" instead of failing the mount. */
export function fakeXtermModule() {
  function Terminal(this: any, opts: any) {
    const base: Record<string, unknown> = {
      options: { ...opts },
      cols: 80,
      rows: 24,
      unicode: { activeVersion: '11' },
      buffer: { active: { length: 24, viewportY: 0, ydisp: 0, baseY: 0, cursorY: 0, getLine: () => undefined } },
      write: (data: string, cb?: () => void) => { terminalWrites.push(String(data)); cb?.(); },
      hasSelection: () => false,
      getSelection: () => '',
    };
    const noop = () => ({ dispose() {} });
    return new Proxy(base, {
      get(t, k) {
        if (typeof k === 'symbol' || k === 'then') return undefined;
        if (k in t) return t[k as string];
        return noop;
      },
      set(t, k, v) { t[k as string] = v; return true; },
    });
  }
  return { Terminal };
}

export function fakeAddonModule(name: string) {
  function Addon(this: any) {
    this.dispose = () => {};
    this.onContextLoss = () => ({ dispose() {} });
    this.fit = () => {};
    this.proposeDimensions = () => ({ cols: 80, rows: 24 });
    this.activate = () => {};
  }
  return { [name]: Addon };
}
