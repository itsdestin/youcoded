// @vitest-environment jsdom
// A screen whose code loads apart from the startup code (components/deferred-screen.tsx): nothing is loaded or drawn
// until it may load, then it stays; a failed load is tried again the next time it may load.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { deferredScreen } from '../src/renderer/components/deferred-screen';

function Settings({ title }: { title: string }) { return <div>{title}</div>; }

describe('a deferred screen', () => {
  it('loads nothing while closed and not yet allowed, then draws once allowed and stays drawn', async () => {
    const load = vi.fn(async () => Settings);
    const Deferred = deferredScreen(load);
    const { rerender } = render(<Deferred load={false} title="Settings" />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText('Settings')).toBeNull();
    rerender(<Deferred load title="Settings" />);
    await screen.findByText('Settings');
    rerender(<Deferred load={false} title="Settings, again" />);
    expect(screen.getByText('Settings, again')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('tries a failed load again the next time it may load, instead of remembering the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = vi.fn<() => Promise<typeof Settings>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Settings);
    const Deferred = deferredScreen(load);
    const { rerender } = render(<Deferred load title="Settings" />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    rerender(<Deferred load={false} title="Settings" />);
    rerender(<Deferred load title="Settings" />);
    await screen.findByText('Settings');
    expect(load).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('preload fetches the code ahead, so the first open draws without waiting for it', async () => {
    const load = vi.fn(async () => Settings);
    const Deferred = deferredScreen(load);
    await act(async () => { Deferred.preload(); });
    render(<Deferred load title="Settings" />);
    expect(screen.getByText('Settings')).toBeTruthy();   // already there on the first render
    expect(load).toHaveBeenCalledTimes(1);
  });
});
