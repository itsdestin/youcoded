import { describe, it, expect, vi } from 'vitest';
import {
  detectPermissionMode,
  syncKeyedSubscriptions,
  clearKeyedSubscriptions,
} from '../src/renderer/state/permission-mode-scan';
import type { PermissionMode } from '../src/shared/types';

// The detector App.tsx ran per chunk before the regex prefilter — kept here as
// the reference, so the prefiltered version must agree with it on every input.
function referenceDetect(data: string): PermissionMode | null {
  const lower = data.toLowerCase();
  if (lower.includes('bypass permissions on')) return 'bypass';
  if (lower.includes('auto mode on')) return 'auto';
  if (lower.includes('accept edits on')) return 'auto-accept';
  if (lower.includes('plan mode on')) return 'plan';
  if (lower.includes('bypass permissions off') || lower.includes('auto mode off')
    || lower.includes('accept edits off') || lower.includes('plan mode off')) return 'normal';
  return null;
}

const CHUNKS = [
  '',
  'plain output with no footer',
  '\x1b[2m⏵⏵ bypass permissions on\x1b[22m (shift+tab to cycle)',
  '⏵⏵ Auto Mode On (shift+tab to cycle)',
  '⏵⏵ ACCEPT EDITS ON',
  '⏸ plan mode on',
  'plan mode off',
  'bypass permissions off',
  'auto mode off',
  'accept edits off',
  // On-list outranks off-list regardless of position, as before.
  'plan mode off ... accept edits on',
  'bypass permissions off\r\nplan mode on',
  // Near-misses the prefilter must reject and the reference also rejects.
  'plan mode',
  'plan  mode on',
  'auto mode o',
  'accept edits of',
  // "on" as a prefix still counts, exactly as the substring check did.
  'plan mode only',
  'x'.repeat(10_000) + 'auto mode on',
];

describe('detectPermissionMode', () => {
  it('agrees with the pre-prefilter detector on every sample', () => {
    for (const chunk of CHUNKS) {
      expect(detectPermissionMode(chunk), JSON.stringify(chunk.slice(0, 60))).toBe(referenceDetect(chunk));
    }
  });

  it('never lower-cases a chunk that cannot name a mode', () => {
    const spy = vi.spyOn(String.prototype, 'toLowerCase');
    try {
      detectPermissionMode('ordinary terminal output '.repeat(200));
      expect(spy).not.toHaveBeenCalled();
      detectPermissionMode('⏵⏵ Accept Edits On');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('syncKeyedSubscriptions', () => {
  function harness() {
    const live = new Map<string, number>();
    const subscribe = vi.fn((id: string) => {
      live.set(id, (live.get(id) ?? 0) + 1);
      return () => { live.set(id, live.get(id)! - 1); };
    });
    return { live, subscribe, subs: new Map<string, () => void>() };
  }

  it('subscribes only added ids and unsubscribes only removed ones', () => {
    const { live, subscribe, subs } = harness();
    syncKeyedSubscriptions(subs, ['a', 'b'], subscribe);
    expect(subscribe).toHaveBeenCalledTimes(2);

    // Same ids (e.g. a rename re-built the list): nothing is touched.
    syncKeyedSubscriptions(subs, ['a', 'b'], subscribe);
    expect(subscribe).toHaveBeenCalledTimes(2);

    // One added, one removed: exactly one subscribe, one unsubscribe.
    syncKeyedSubscriptions(subs, ['b', 'c'], subscribe);
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(subscribe).toHaveBeenLastCalledWith('c');
    expect(Object.fromEntries(live)).toEqual({ a: 0, b: 1, c: 1 });
    expect([...subs.keys()].sort()).toEqual(['b', 'c']);
  });

  it('clearKeyedSubscriptions removes every listener and tolerates a throwing unsubscribe', () => {
    const { live, subscribe, subs } = harness();
    syncKeyedSubscriptions(subs, ['a', 'b'], subscribe);
    subs.set('boom', () => { throw new Error('no-op API'); });
    clearKeyedSubscriptions(subs);
    expect(subs.size).toBe(0);
    expect(Object.fromEntries(live)).toEqual({ a: 0, b: 0 });
  });

  it('treats a subscribe that returns nothing as a no-op unsubscriber', () => {
    const subs = new Map<string, () => void>();
    syncKeyedSubscriptions(subs, ['a'], () => undefined);
    expect(() => syncKeyedSubscriptions(subs, [], () => undefined)).not.toThrow();
    expect(subs.size).toBe(0);
  });
});
