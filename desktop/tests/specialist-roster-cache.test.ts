// @vitest-environment jsdom
/**
 * Task 10 — the per-cwd roster cache's four states (loading/ready/failed/
 * unavailable), and the exact 'not-implemented-on-mobile' string that flips a
 * response into 'unavailable' rather than the retryable 'failed'. Pinned
 * separately from specialist-envelope.test.tsx because these are cache-shape
 * facts, not component-rendering ones — see NOT_IMPLEMENTED_ON_MOBILE's own
 * WHY in hooks/useSpecialists.ts for why the distinction matters (a 'failed'
 * roster shows a Retry button that would never work against a host that
 * genuinely does not have this feature yet).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useSpecialistRoster,
  refreshSpecialistRoster,
  NOT_IMPLEMENTED_ON_MOBILE,
} from '../src/renderer/hooks/useSpecialists';
import type { SpecialistsListResult } from '../src/shared/types';

afterEach(() => { delete (window as any).claude; });

function mockList(impl: (opts?: { cwd?: string; ensurePersonalFolder?: boolean }) => Promise<unknown>) {
  (window as any).claude = { specialists: { list: vi.fn(impl) } };
}

const READY: SpecialistsListResult = {
  definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' },
};

describe('roster cache states', () => {
  it('starts loading, then lands on ready for a real backend response', async () => {
    mockList(async () => READY);
    const { result } = renderHook(() => useSpecialistRoster('cwd-ready'));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', result: READY });
  });

  // The exact shape SessionService.kt (Android) and an un-upgraded remote
  // peer answer with — RESOLVES (never rejects), `ok: false`, and this exact
  // error string. tests/ipc-channels.test.ts pins the Kotlin side; this pins
  // that the renderer reads it as 'unavailable', not 'failed'.
  it('reads the not-implemented-on-mobile shape as unavailable, not failed', async () => {
    mockList(async () => ({ ok: false, error: NOT_IMPLEMENTED_ON_MOBILE }));
    const { result } = renderHook(() => useSpecialistRoster('cwd-mobile'));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
  });

  it('reads any OTHER ok:false response as failed (retryable)', async () => {
    mockList(async () => ({ ok: false, error: 'disk read error: EACCES' }));
    const { result } = renderHook(() => useSpecialistRoster('cwd-failed'));
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current).toMatchObject({ status: 'failed', error: 'disk read error: EACCES' });
  });

  it('reads a thrown error as failed, using the real message', async () => {
    mockList(async () => { throw new Error('bridge exploded'); });
    const { result } = renderHook(() => useSpecialistRoster('cwd-thrown'));
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current).toMatchObject({ status: 'failed', error: 'bridge exploded' });
  });

  it('refreshSpecialistRoster forces a fresh read and re-notifies subscribers', async () => {
    let n = 0;
    mockList(async () => { n += 1; return { ...READY, skipped: n === 1 ? [] : [{ path: '/x.md', source: 'personal' as const, error: 'bad frontmatter' }] }; });
    const { result } = renderHook(() => useSpecialistRoster('cwd-refresh'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.status === 'ready' && result.current.result.skipped).toEqual([]);

    await act(async () => { await refreshSpecialistRoster('cwd-refresh'); });
    await waitFor(() => expect(result.current.status === 'ready' && result.current.result.skipped.length).toBe(1));
  });
});

// A roster whose read failed (a phone's connection dropping mid-read) used to stay failed
// until Settings forced a refresh.
describe('a failed roster is asked again', () => {
  it('by the next screen that needs it', async () => {
    mockList(vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue(READY) as any);
    const first = renderHook(() => useSpecialistRoster('cwd-failed-remount'));
    await waitFor(() => expect(first.result.current.status).toBe('failed'));
    first.unmount();
    const second = renderHook(() => useSpecialistRoster('cwd-failed-remount'));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
  });

  it('after a remote reconnect, once for every screen sharing the folder', async () => {
    const { REMOTE_RECONNECTED_EVENT } = await import('../src/renderer/remote-events');
    const list = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue(READY);
    mockList(list as any);
    const a = renderHook(() => useSpecialistRoster('cwd-failed-reconnect'));
    const b = renderHook(() => useSpecialistRoster('cwd-failed-reconnect'));
    await waitFor(() => expect(a.result.current.status).toBe('failed'));
    const before = list.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); });
    await waitFor(() => expect(b.result.current.status).toBe('ready'));
    expect(list.mock.calls.length).toBe(before + 1);
  });
});
