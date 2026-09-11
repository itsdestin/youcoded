// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useMissingArtifacts,
  refreshMissingArtifacts,
  __resetMissingArtifactsCache,
  CHANGE_RECHECK_DELAY_MS,
} from '../src/renderer/hooks/useMissingArtifacts';

// The "deleted files flash": the Session Drawer used to hold the on-disk
// verdict in component-local state that reset to EMPTY on every close, so each
// open painted the full list and then removed rows one IPC round trip later.
// These cases pin the two properties that make that impossible — knowledge
// outlives the component, and it is never cleared before its replacement
// arrives. Regressing either one brings the flash back.

const ROOT = '/proj';

function installBridge(impl: (root: string, ids: string[]) => Promise<any>) {
  (globalThis as any).window.claude = { artifacts: { checkExistence: vi.fn(impl) } };
  return (globalThis as any).window.claude.artifacts.checkExistence;
}

beforeEach(() => {
  __resetMissingArtifactsCache();
  delete (globalThis as any).window.claude;
});

describe('useMissingArtifacts', () => {
  it('reports not-known until the first check settles, then the verdict', async () => {
    installBridge(async () => ({ ok: true, missingIds: ['b'] }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    expect(result.current.known).toBe(false);       // the drawer holds its list here
    await waitFor(() => expect(result.current.known).toBe(true));
    expect([...result.current.missingIds]).toEqual(['b']);
  });

  it('a second consumer sees the cached verdict on its FIRST render', async () => {
    installBridge(async () => ({ ok: true, missingIds: ['b'] }));
    const first = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    await waitFor(() => expect(first.result.current.known).toBe(true));
    first.unmount();   // the drawer closing must not discard what was learned

    // This is the drawer opening: no effect has run yet for this consumer, and
    // the answer is already right. That is the whole fix.
    const second = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    expect(second.result.current.known).toBe(true);
    expect(second.result.current.missingIds.has('b')).toBe(true);
  });

  it('never blanks the verdict while a refresh is in flight', async () => {
    let release: (v: any) => void = () => {};
    installBridge(() => new Promise((r) => { release = r; }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    act(() => { release({ ok: true, missingIds: ['b'] }); });
    await waitFor(() => expect(result.current.known).toBe(true));

    // A slow second check must leave the previous answer standing — an
    // optimistic reset to "everything is present" IS the flash.
    installBridge(() => new Promise((r) => { release = r; }));
    act(() => { void refreshMissingArtifacts(ROOT, ['a', 'b', 'c']); });
    expect(result.current.missingIds.has('b')).toBe(true);
    await act(async () => { release({ ok: true, missingIds: ['c'] }); });
    await waitFor(() => expect(result.current.missingIds.has('c')).toBe(true));
    expect(result.current.missingIds.has('b')).toBe(false);
  });

  it('keeps verdicts for ids the latest check did not ask about', async () => {
    installBridge(async (_root, ids) => ({ ok: true, missingIds: ids.filter((i) => i === 'b') }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    await waitFor(() => expect(result.current.missingIds.has('b')).toBe(true));
    // The badge checks a narrower id set than the drawer; neither may erase
    // what the other established.
    await act(async () => { await refreshMissingArtifacts(ROOT, ['a']); });
    expect(result.current.missingIds.has('b')).toBe(true);
  });

  it('settles even when the surface cannot answer, so the list never hangs blank', async () => {
    installBridge(async () => ({ ok: false, error: 'not-implemented-on-mobile' }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a']));
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.missingIds.size).toBe(0);
  });

  it('shares one answer between two spellings of the same folder', async () => {
    // The header badge and the drawer can be handed the same directory spelled
    // differently (a trailing slash, a Windows drive letter cased either way);
    // if they keyed separately, the second one to mount would start cold and
    // flash. The IPC call still gets the caller's own spelling.
    installBridge(async () => ({ ok: true, missingIds: ['b'] }));
    const first = renderHook(() => useMissingArtifacts('/proj/', ['a', 'b']));
    await waitFor(() => expect(first.result.current.known).toBe(true));
    const second = renderHook(() => useMissingArtifacts('/proj', ['a', 'b']));
    expect(second.result.current.known).toBe(true);
    expect(second.result.current.missingIds.has('b')).toBe(true);
  });

  it('re-asks when the id set is unchanged but the files were not', async () => {
    // A rename, a status flip, or Claude re-creating a file it had deleted all
    // change what is on disk WITHOUT changing the id list. The drawer drives
    // that refresh explicitly; this pins that a second call with the same ids
    // is honoured once the first has finished, so a stale "deleted" cannot
    // survive until the drawer is closed and reopened.
    let answer: string[] = ['b'];
    const spy = installBridge(async () => ({ ok: true, missingIds: answer }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    await waitFor(() => expect(result.current.missingIds.has('b')).toBe(true));
    answer = [];
    await act(async () => { await refreshMissingArtifacts(ROOT, ['a', 'b']); });
    expect(spy.mock.calls.length).toBe(2);
    expect(result.current.missingIds.has('b')).toBe(false);
  });

  it('coalesces an identical in-flight request instead of re-asking', async () => {
    const spy = installBridge(async () => ({ ok: true, missingIds: [] }));
    await act(async () => {
      await Promise.all([
        refreshMissingArtifacts(ROOT, ['a', 'b']),
        refreshMissingArtifacts(ROOT, ['a', 'b']),
      ]);
    });
    expect(spy.mock.calls.length).toBe(1);
  });
});

// 2026-09-11: nothing re-asked while the drawer stayed open, so a file removed
// by a Bash `rm` — or one that appeared after its check — kept the wrong
// verdict until the drawer was closed and reopened.
describe('useMissingArtifacts — re-checking after files change', () => {
  function installBridgeWithChanges(impl: (root: string, ids: string[]) => Promise<any>) {
    const listeners = new Set<(e: any) => void>();
    (globalThis as any).window.claude = {
      artifacts: {
        checkExistence: vi.fn(impl),
        onChanged: vi.fn((cb: (e: any) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; }),
      },
    };
    return {
      spy: (globalThis as any).window.claude.artifacts.checkExistence,
      emit: (e: any) => { for (const l of [...listeners]) l(e); },
      listeners,
    };
  }

  it('a burst of change events for its folder becomes ONE re-check, and the verdict updates', async () => {
    let answer = ['b'];
    const { spy, emit } = installBridgeWithChanges(async () => ({ ok: true, missingIds: answer }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    await waitFor(() => expect(result.current.missingIds.has('b')).toBe(true));

    answer = [];
    vi.useFakeTimers();
    try {
      act(() => {
        emit({ projectRoot: ROOT, kind: 'add' });
        emit({ projectRoot: `${ROOT}/`, kind: 'edit' });   // same folder, other spelling
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_RECHECK_DELAY_MS + 10); });
    } finally {
      vi.useRealTimers();
    }
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.missingIds.has('b')).toBe(false);
  });

  it('ignores change events for another folder and stops listening when unmounted', async () => {
    const { spy, emit, listeners } = installBridgeWithChanges(async () => ({ ok: true, missingIds: [] }));
    const { result, unmount } = renderHook(() => useMissingArtifacts(ROOT, ['a']));
    await waitFor(() => expect(result.current.known).toBe(true));
    vi.useFakeTimers();
    try {
      act(() => { emit({ projectRoot: '/other', kind: 'remove' }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_RECHECK_DELAY_MS + 10); });
    } finally {
      vi.useRealTimers();
    }
    expect(spy).toHaveBeenCalledTimes(1);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('an older answer landing after a newer one cannot bring back a stale "missing"', async () => {
    const releases: Array<(v: any) => void> = [];
    installBridgeWithChanges(() => new Promise((r) => { releases.push(r); }));
    let older!: Promise<void>;
    let newer!: Promise<void>;
    act(() => {
      older = refreshMissingArtifacts(ROOT, ['a']);        // started before the file appeared
      newer = refreshMissingArtifacts(ROOT, ['a', 'b']);   // started after
    });
    await act(async () => { releases[1]({ ok: true, missingIds: [] }); await newer; });
    await act(async () => { releases[0]({ ok: true, missingIds: ['a'] }); await older; });

    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a'], false));
    expect(result.current.missingIds.has('a')).toBe(false);
  });

  it('a change-prompted request that meets an identical running check asks once more when it lands', async () => {
    const releases: Array<(v: any) => void> = [];
    const { spy } = installBridgeWithChanges(() => new Promise((r) => { releases.push(r); }));
    let first!: Promise<void>;
    act(() => { first = refreshMissingArtifacts(ROOT, ['a']); });
    void refreshMissingArtifacts(ROOT, ['a'], { afterChange: true });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => { releases[0]({ ok: true, missingIds: ['a'] }); await first; });
    expect(spy).toHaveBeenCalledTimes(2);
    await act(async () => { releases[1]({ ok: true, missingIds: [] }); });
  });
});
