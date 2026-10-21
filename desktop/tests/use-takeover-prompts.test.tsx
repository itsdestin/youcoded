// @vitest-environment jsdom
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTakeoverPrompts } from '../src/renderer/hooks/use-takeover-prompts';

describe('ownership confirmation queue', () => {
  it('answers each queued question independently in arrival order', async () => {
    const { result } = renderHook(() => useTakeoverPrompts());
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.ask('laptop', 'confirm');
      second = result.current.ask('desktop', 'claim-denied');
    });
    expect(result.current.prompt).toEqual({ device: 'laptop', phase: 'confirm' });
    act(() => result.current.answer(true));
    expect(await first).toBe(true);
    expect(result.current.prompt).toEqual({ device: 'desktop', phase: 'claim-denied' });
    act(() => result.current.answer(false));
    expect(await second).toBe(false);
    expect(result.current.prompt).toBeNull();
  });

  it('declines visible, queued, and late questions after unmount', async () => {
    const { result, unmount } = renderHook(() => useTakeoverPrompts());
    const ask = result.current.ask;
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = ask('laptop', 'confirm');
      second = ask('desktop', 'force');
    });
    unmount();
    expect(await Promise.all([first, second, ask('late lease reply', 'confirm')])).toEqual([false, false, false]);
  });

  it('still accepts questions after StrictMode effect reactivation', async () => {
    const { result } = renderHook(() => useTakeoverPrompts(), {
      wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.ask('laptop', 'confirm'); });
    expect(result.current.prompt?.device).toBe('laptop');
    act(() => result.current.answer(true));
    expect(await pending).toBe(true);
  });
});
