// Per-entry render counters for the chat timeline, installed with vi.mock
// BEFORE ChatView loads (chatview-visible-stream-render-budget.test.tsx).
// Kept in its own module for the same reason busy-app-probes.tsx is: a mock
// factory that imported ChatView would import the module graph it is mocking.
//
// Each probe is a <Profiler> INSIDE a copy of the real export's memo, so it
// bails out exactly when the real component would, and it fires when that
// component renders OR anything under it commits (a context read deep in a
// bubble, a nested ToolCard). Counts are keyed "<Component>:<entry id>".
import React from 'react';

export const entryRenders = new Map<string, number>();

export function resetEntryRenders(): void {
  entryRenders.clear();
}

// React's internal marker for React.memo objects — read so the probe keeps the
// real memo (and comparator) and never adds a bail-out the app does not have.
const MEMO = Symbol.for('react.memo');

export function probeEntry<P>(real: any, name: string, keyOf: (props: P) => string): React.ComponentType<P> {
  const isMemo = real && typeof real === 'object' && real.$$typeof === MEMO;
  const Inner: React.ComponentType<P> = isMemo ? real.type : real;
  function Probed(props: P) {
    const id = `${name}:${keyOf(props)}`;
    return (
      <React.Profiler id={id} onRender={() => entryRenders.set(id, (entryRenders.get(id) ?? 0) + 1)}>
        <Inner {...(props as any)} />
      </React.Profiler>
    );
  }
  Probed.displayName = `ProbedEntry(${name})`;
  return (isMemo ? React.memo(Probed, real.compare ?? undefined) : Probed) as React.ComponentType<P>;
}
