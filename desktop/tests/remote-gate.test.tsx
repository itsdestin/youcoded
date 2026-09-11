// @vitest-environment jsdom
// What a phone's browser shows before the app: the password screen only when a password is
// actually needed (Destin, 2026-09-11: "password screen occasionally flickering before
// loading back into the thing without actually needing a password").
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteGate, type RemoteGateShim } from '../src/renderer/remote-gate';

type Listener = Parameters<RemoteGateShim['startSavedKeySignIn']>[0];

function fakeShim(opts: { savedKey: boolean }) {
  let stateCb: (s: string) => void = () => {};
  let listener: Listener = () => {};
  const shim: RemoteGateShim = {
    installShim: vi.fn(),
    onConnectionStateChange: vi.fn((cb) => { stateCb = cb as any; }),
    connect: vi.fn(async () => 'token'),
    retryLocalBridge: vi.fn(),
    startSavedKeySignIn: vi.fn((l: Listener) => { listener = l; return opts.savedKey; }),
    retrySavedKeyNow: vi.fn(),
    stopSavedKeySignIn: vi.fn(),
  };
  return {
    shim,
    setState: (s: string) => act(() => stateCb(s)),
    report: (e: Parameters<Listener>[0]) => act(() => listener(e)),
  };
}

async function mount(f: ReturnType<typeof fakeShim>) {
  render(<RemoteGate isAndroid={false} loadShim={async () => f.shim} renderApp={() => <div>THE APP</div>} />);
  await act(async () => {});
}

const passwordBox = () => screen.queryByPlaceholderText('Password');

describe('RemoteGate', () => {
  beforeEach(() => {
    // LoginScreen asks /remote-state first; an older host has none.
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('no endpoint'); });
  });

  it('with a saved key, says it is connecting and never draws the password box', async () => {
    const f = fakeShim({ savedKey: true });
    await mount(f);
    expect(screen.getByText('Connecting to your computer…')).toBeTruthy();
    expect(passwordBox()).toBeNull();
    f.setState('connecting');
    f.setState('authenticating');
    expect(passwordBox()).toBeNull();
    f.setState('connected');
    expect(screen.getByText('THE APP')).toBeTruthy();
  });

  it('a computer it cannot reach says so, keeps trying, and offers both ways forward', async () => {
    const f = fakeShim({ savedKey: true });
    await mount(f);
    f.report({ type: 'failed', kind: 'unreachable' });
    expect(screen.getByText("Can't reach your computer.")).toBeTruthy();
    expect(screen.getByText('Trying again…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(f.shim.retrySavedKeyNow).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enter password instead' }));
    expect(f.shim.stopSavedKeySignIn).toHaveBeenCalled();
    expect(passwordBox()).toBeTruthy();
  });

  it('a key the computer refused goes to the password box', async () => {
    const f = fakeShim({ savedKey: true });
    await mount(f);
    f.report({ type: 'refused', reason: 'revoked' });
    expect(passwordBox()).toBeTruthy();
  });

  it('without a saved key, the password box is the first thing', async () => {
    const f = fakeShim({ savedKey: false });
    await mount(f);
    expect(passwordBox()).toBeTruthy();
  });

  it('a password sign-in that could not reach the computer does not say the password was wrong', async () => {
    const f = fakeShim({ savedKey: false });
    (f.shim.connect as any).mockRejectedValueOnce(Object.assign(new Error('Cannot reach host'), { signInFailure: { kind: 'unreachable' } }));
    await mount(f);
    fireEvent.change(passwordBox()!, { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(screen.queryByText('Invalid password')).toBeNull();
    expect(screen.getByText("Can't reach your computer.")).toBeTruthy();
  });

  it('a wrong password still says so', async () => {
    const f = fakeShim({ savedKey: false });
    (f.shim.connect as any).mockRejectedValueOnce(Object.assign(new Error('invalid-credentials'), { signInFailure: { kind: 'refused', reason: 'invalid-credentials' } }));
    await mount(f);
    fireEvent.change(passwordBox()!, { target: { value: 'nope' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(screen.getByText('Invalid password')).toBeTruthy();
  });

  it('once connected, a later drop keeps the app on screen', async () => {
    const f = fakeShim({ savedKey: true });
    await mount(f);
    f.setState('connected');
    f.setState('disconnected');
    expect(screen.getByText('THE APP')).toBeTruthy();
  });
});
