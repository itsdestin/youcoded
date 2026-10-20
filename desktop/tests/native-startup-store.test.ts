import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetNativeStartup, getNativeStartup, resetNativeStartups, setNativeStartup, subscribeNativeStartup } from '../src/renderer/state/native-startup-store';
import type { NativeStartupState } from '../src/shared/native-startup';
const state = (phase: 'ready' | 'connecting', generation = 1, revision = 1): NativeStartupState => phase === 'ready'
  ? { phase, hostId: 'host', generation, revision } : { phase, hostId: 'host', generation, revision, attemptId: 'attempt' };

beforeEach(() => resetNativeStartups());
describe('native startup live facts', () => {
  it('does not replace a live ready push with an older page-fill snapshot', () => {
    setNativeStartup('a', state('ready', 1, 3));
    setNativeStartup('a', state('connecting', 1, 2));
    expect(getNativeStartup('a')?.phase).toBe('ready');
  });
  it('does not apply an old generation to a reopened chat', () => {
    setNativeStartup('a', state('ready', 2, 1));
    setNativeStartup('a', state('connecting', 1, 99));
    expect(getNativeStartup('a')?.phase).toBe('ready');
  });
  it('forgets closed chats without letting a late snapshot resurrect their gate', () => {
    setNativeStartup('a', state('connecting'));
    forgetNativeStartup('a');
    setNativeStartup('a', state('ready', 1, 5));
    expect(getNativeStartup('a')).toBeUndefined();
    setNativeStartup('a', state('connecting', 2));
    expect(getNativeStartup('a')?.phase).toBe('connecting');
  });
  it('notifies only the changed session and ignores repeated versions', () => {
    const a = vi.fn(), b = vi.fn();
    const offA = subscribeNativeStartup('a', a), offB = subscribeNativeStartup('b', b);
    setNativeStartup('a', state('connecting'));
    setNativeStartup('a', state('connecting'));
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    offA(); offB();
  });
  it('ignores malformed facts instead of silently changing readiness', () => {
    setNativeStartup('a', state('connecting'));
    setNativeStartup('a', { phase: 'ready' } as NativeStartupState);
    expect(getNativeStartup('a')?.phase).toBe('connecting');
  });
});
