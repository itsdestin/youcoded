import { describe, expect, it, vi } from 'vitest';
import { SessionStartRegistry } from '../src/main/harness/session-start-registry';

describe('session startup tickets', () => {
  it('invalidates a pending startup synchronously on close', () => {
    const dispose = vi.fn(); const starts = new SessionStartRegistry(dispose);
    const ticket = starts.begin('chat', 'first');
    starts.cancel('chat');
    expect(starts.isCurrent(ticket)).toBe(false);
    expect(() => starts.assertCurrent(ticket)).toThrow('closed');
    expect(dispose).toHaveBeenCalledWith('first');
  });
  it('a replacement cannot be removed by an older completion', () => {
    const dispose = vi.fn(); const starts = new SessionStartRegistry(dispose);
    const first = starts.begin('chat', 'first');
    const next = starts.begin('chat', 'next');
    starts.finish(first);
    expect(starts.isCurrent(next)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    starts.finish(next);
    expect(starts.has('chat')).toBe(false);
  });
  it('shutdown invalidates all pending tickets and refuses new work', () => {
    const dispose = vi.fn(); const starts = new SessionStartRegistry(dispose);
    const a = starts.begin('a', 'a'), b = starts.begin('b', 'b');
    starts.close();
    expect(starts.isCurrent(a)).toBe(false);
    expect(starts.isCurrent(b)).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(() => starts.begin('c', 'c')).toThrow('shutting down');
  });
});
