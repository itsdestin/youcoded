// @vitest-environment jsdom
// What a phone's browser shows before the app: the password screen only when a password is
// actually needed (Destin, 2026-09-11: "password screen occasionally flickering before
// loading back into the thing without actually needing a password").
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteGate, type RemoteGateShim } from '../src/renderer/remote-gate';
import { queueBrowserStorage } from './helpers/queue-browser-storage';

type Listener = Parameters<RemoteGateShim['startSavedKeySignIn']>[0];

function fakeShim(opts: { savedKey: boolean }) {
  let stateCb: (s: string) => void = () => {};
  let listener: Listener = () => {};
  let refusedCb: (reason: string) => void = () => {};
  const shim: RemoteGateShim = {
    installShim: vi.fn(),
    onConnectionStateChange: vi.fn((cb) => { stateCb = cb as any; }),
    connect: vi.fn(async () => 'token'),
    retryLocalBridge: vi.fn(),
    startSavedKeySignIn: vi.fn((l: Listener) => { listener = l; return opts.savedKey; }),
    retrySavedKeyNow: vi.fn(),
    stopSavedKeySignIn: vi.fn(),
    onCredentialRefused: vi.fn((cb: (reason: string) => void) => { refusedCb = cb; }),
    connectToHost: vi.fn(async () => {}),
    disconnectFromHost: vi.fn(async () => {}),
  };
  return {
    shim,
    setState: (s: string) => act(() => stateCb(s)),
    report: (e: Parameters<Listener>[0]) => act(() => listener(e)),
    refuseCredential: (reason: string) => act(() => refusedCb(reason)),
  };
}

async function mount(f: ReturnType<typeof fakeShim>) {
  render(<RemoteGate isAndroid={false} loadShim={async () => f.shim} renderApp={() => <div>THE APP</div>} />);
  await act(async () => {});
}

const passwordBox = () => screen.queryByLabelText('Password');

describe('RemoteGate', () => {
  beforeEach(() => {
    // LoginScreen asks /remote-state first; an older host has none.
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('no endpoint'); });
  });

  it('with a saved key, a normal sign-in shows only the loading spinner, never a sign-in screen', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeShim({ savedKey: true });
      await mount(f);
      // Destin, 2026-09-11: "still flashes the password screen at me on refresh". The first moments
      // look exactly like the page's own boot spinner: no title, no words, no box.
      expect(screen.getByRole('status', { name: 'Connecting to your computer' })).toBeTruthy();
      expect(screen.queryByText('YouCoded Remote')).toBeNull();
      expect(passwordBox()).toBeNull();
      // Only a sign-in that takes a while says what it is doing.
      await act(async () => { vi.advanceTimersByTime(1500); });
      expect(screen.getByText('Connecting to your computer…')).toBeTruthy();
      f.setState('connected');
      expect(screen.getByText('THE APP')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('with a saved key, says it is connecting and never draws the password box', async () => {
    const f = fakeShim({ savedKey: true });
    await mount(f);
    // settle (negative assertion): past the grace timer the password box must still not appear.
    await act(async () => { await new Promise((r) => setTimeout(r, 1600)); });
    expect(passwordBox()).toBeNull();
    // WHY waited for (final review F55): the "Connecting…" line comes from a 1.5 s timer, so
    // seeing it after a 1.6 s sleep was a guess a busy machine could outrun.
    await waitFor(() => expect(screen.getByText('Connecting to your computer…')).toBeTruthy());
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
    expect(screen.getByText("Can't reach your computer")).toBeTruthy();
    expect(screen.getByText('It keeps trying by itself every few seconds.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
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

  it('a computer that stops accepting this device after it connected: back to the password box, saying why', async () => {
    const f = fakeShim({ savedKey: true });
    await mount(f);
    f.setState('connected');
    expect(screen.getByText('THE APP')).toBeTruthy();
    f.refuseCredential('revoked');
    expect(passwordBox()).toBeTruthy();
    expect(screen.getByText('This computer no longer accepts this device. Enter the password to connect again.')).toBeTruthy();
  });

  it('a page older than its computer says so and offers a reload, which reloads', async () => {
    const f = fakeShim({ savedKey: true });
    await mount(f);
    f.setState('connected');
    const reload = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...orig, reload } });
    try {
      f.refuseCredential('unsupported-version');
      expect(screen.getByText('This page needs a refresh')).toBeTruthy();
      // No password box: a password cannot fix an old page (review P-5).
      expect(passwordBox()).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Reload this tab' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: orig });
    }
  });

  it('"Try again" shows it is trying, and the password stays one tap away', async () => {
    const f = fakeShim({ savedKey: true });
    await mount(f);
    f.report({ type: 'failed', kind: 'unreachable' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Trying to connect…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Enter password instead' })).toBeTruthy();
    f.report({ type: 'failed', kind: 'unreachable' });
    expect(screen.getByText("Can't reach your computer")).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a refusal the page cannot explain, or an unexpected error, does not blame the password', async () => {
    const f = fakeShim({ savedKey: false });
    (f.shim.connect as any)
      .mockRejectedValueOnce(Object.assign(new Error('invalid-message'), { signInFailure: { kind: 'refused', reason: 'invalid-message' } }))
      .mockRejectedValueOnce(new Error('boom'));
    await mount(f);
    fireEvent.change(passwordBox()!, { target: { value: 'pw' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(screen.getByText('Your computer refused this sign-in.')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(screen.getByText("Couldn't sign in.")).toBeTruthy();
    expect(screen.queryByText('Invalid password')).toBeNull();
  });

  describe('the Android app going back to the computer it was last using', () => {
    const HOME_PC = { name: 'Home PC', host: '100.64.1.2', port: 9900, password: 'pw' };
    beforeEach(() => {
      // Node 26's own localStorage can mask jsdom's; give the page a plain one.
      vi.stubGlobal('localStorage', queueBrowserStorage());
      (window as any).claude = { android: { getPairedDevices: vi.fn(async () => ({ devices: [HOME_PC] })) } };
    });

    async function mountAndroid(f: ReturnType<typeof fakeShim>) {
      render(<RemoteGate isAndroid loadShim={async () => f.shim} renderApp={() => <div>THE APP</div>} />);
      await act(async () => {});
      f.setState('connected'); // the phone's own runtime answered
      await act(async () => {});
    }

    it('reconnects to it at launch without first showing the phone\'s own conversations', async () => {
      const { rememberLastComputer } = await import('../src/renderer/last-computer');
      rememberLastComputer('100.64.1.2', 9900);
      const f = fakeShim({ savedKey: false });
      let finish: () => void = () => {};
      (f.shim.connectToHost as any).mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
      await mountAndroid(f);
      expect(screen.getByText('Connecting to Home PC…')).toBeTruthy();
      expect(screen.queryByText('THE APP')).toBeNull();
      expect(f.shim.connectToHost).toHaveBeenCalledWith('100.64.1.2', 9900, 'pw');
      await act(async () => { finish(); });
      expect(screen.getByText('THE APP')).toBeTruthy();
    });

    it('an asleep computer: says so, keeps trying, and the phone alone is one tap away', async () => {
      const { rememberLastComputer, lastComputer } = await import('../src/renderer/last-computer');
      rememberLastComputer('100.64.1.2', 9900);
      const f = fakeShim({ savedKey: false });
      (f.shim.connectToHost as any).mockRejectedValue(Object.assign(new Error('timed out'), { signInFailure: { kind: 'unreachable' } }));
      await mountAndroid(f);
      await waitFor(() => expect(screen.getByText("Can't reach Home PC")).toBeTruthy());
      expect(screen.getByText('It keeps trying by itself every few seconds.')).toBeTruthy();
      expect(screen.queryByText('THE APP')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Use this phone only' }));
      await waitFor(() => expect(screen.getByText('THE APP')).toBeTruthy());
      expect(lastComputer()).toBeNull();
    });

    it('with no computer remembered, opens the phone\'s own runtime as before', async () => {
      const f = fakeShim({ savedKey: false });
      await mountAndroid(f);
      await waitFor(() => expect(screen.getByText('THE APP')).toBeTruthy());
      expect(f.shim.connectToHost).not.toHaveBeenCalled();
    });
  });

  it('once connected, a later drop keeps the app on screen', async () => {
    const f = fakeShim({ savedKey: true });
    await mount(f);
    f.setState('connected');
    f.setState('disconnected');
    expect(screen.getByText('THE APP')).toBeTruthy();
  });
});
