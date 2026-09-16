// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  renderPrerequisite,
  renderSetupProgress,
  type SetupCheck,
  type TailscaleInfo,
} from '../src/renderer/components/SettingsPanel';

afterEach(cleanup);

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const panel = read('../src/renderer/components/SettingsPanel.tsx');

const noop = () => {};
const ts = (over: Partial<TailscaleInfo> = {}): TailscaleInfo =>
  ({ installed: true, connected: true, state: 'running', ip: '100.82.14.7', hostname: 'home-laptop', url: 'http://100.82.14.7:9900', ...over });

/**
 * Contract row R5: the panel opens saying what is missing, with one button that moves you
 * forward. Contract row R1: setup checks at the end, and the check is a real one.
 */
describe('the setup banner says which prerequisite is missing', () => {
  it('offers Set up when Tailscale is not installed', () => {
    const run = vi.fn();
    render(<>{renderPrerequisite({ ...ts(), installed: false, state: 'not-installed' }, false, run, noop)}</>);
    expect(screen.getByText('Not set up yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(run).toHaveBeenCalled();
  });

  it('offers Sign in when it is installed but signed out', () => {
    const connect = vi.fn();
    render(<>{renderPrerequisite(ts({ connected: false, state: 'signed-out', url: null }), false, noop, connect)}</>);
    expect(screen.getByText(/not signed in yet/)).toBeTruthy();
    // WHY this button must NOT be the install button: pressing Set up opens the "this will
    // download 50MB" confirmation for software that is already on the machine.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(connect).toHaveBeenCalled();
  });

  it('offers Turn on when it is installed but switched off', () => {
    const connect = vi.fn();
    render(<>{renderPrerequisite(ts({ connected: false, state: 'stopped', url: null }), false, noop, connect)}</>);
    expect(screen.getByText(/switched off/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(connect).toHaveBeenCalled();
  });

  it('does not name a cause when Tailscale did not give one', () => {
    // The old copy asserted the VPN was off and sent the user to the Tailscale app. That
    // is a guess: not-connected has several causes and this branch is the one where we
    // could not tell them apart.
    render(<>{renderPrerequisite(ts({ connected: false, state: 'unknown', url: null }), false, noop, noop)}</>);
    expect(screen.getByText(/isn.t connected/)).toBeTruthy();
    expect(screen.queryByText(/VPN isn.t active/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  it('points at the password field once the transport is ready', () => {
    render(<>{renderPrerequisite(ts(), false, noop, noop)}</>);
    expect(screen.getByText(/Set a password below/)).toBeTruthy();
  });

  it('does not send a fully configured computer back to the installer', () => {
    // Installed, connected, password set, and no address: Tailscale's status gave no IP and
    // the fallback lookup failed too. This ran off the end of the function to "Not set up
    // yet." with a Set up button — the installer, for a machine that has everything but the
    // one thing the message did not mention.
    const connect = vi.fn();
    render(<>{renderPrerequisite(ts({ url: null, ip: null }), true, noop, connect)}</>);
    expect(screen.queryByText('Not set up yet.')).toBeNull();
    expect(screen.getByText(/hasn.t given this computer an address yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(connect).toHaveBeenCalled();
  });
});

describe('the end of setup is a check, not a claim', () => {
  const checked = (over: Partial<SetupCheck>) =>
    render(<>{renderSetupProgress('checked', '', { listening: false, address: null, reason: null, ...over }, noop, noop, noop, noop)}</>);

  it('reports the listener and says no device has been tried', () => {
    checked({ listening: true, address: 'http://100.82.14.7:9900' });
    expect(screen.getByText(/listening at http:\/\/100\.82\.14\.7:9900/)).toBeTruthy();
    // Contract row R1: a device is not pretended to be tested. Nothing in this flow has
    // contacted the phone, so nothing here may imply the phone works.
    expect(screen.getByText(/No device has connected yet/)).toBeTruthy();
  });

  it('repeats the reason the server gave, with a retry', () => {
    checked({ listening: false, reason: 'listen EADDRINUSE: address already in use 100.82.14.7:9900' });
    expect(screen.getByText(/EADDRINUSE/)).toBeTruthy();
  });

  it('invents nothing when the server gave no reason', () => {
    checked({ listening: false, reason: null });
    expect(screen.getByText(/isn.t listening yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Report/i })).toBeTruthy();
  });

  it('shows the check running rather than jumping to a result', () => {
    render(<>{renderSetupProgress('checking', '', null, noop, noop, noop, noop)}</>);
    expect(screen.getByText(/Checking this computer/)).toBeTruthy();
  });
});

describe('the flow behind those screens', () => {
  it('asks the host what it is doing instead of declaring success', () => {
    // The whole defect: setup set 'done' the moment `tailscale up` resolved, which is a
    // fact about a command, not about the server. There is no 'done' state any more.
    expect(panel).toContain("setSetupStatus('checking')");
    expect(panel).toContain('const st: RemoteStatus | null = await remote?.getStatus?.()');
    expect(panel).toContain("listening: st?.state === 'listening'");
    expect(panel).not.toContain("setSetupStatus('done')");
    // Both success paths — already installed, and freshly installed — END in the check.
    // Asserting only that the check EXISTS let an inverted version pass: the function was
    // still in the file while the success path skipped it and fabricated a result.
    expect([...panel.matchAll(/await runSetupCheck\(\);/g)]).toHaveLength(2);
    // ...and nothing anywhere may assert the listener is up without having asked.
    expect(panel).not.toMatch(/listening: true/);
  });

  it('surfaces a failed sign-in instead of walking past it', () => {
    // `authTailscale()` was awaited and its result thrown away, so a refused login still
    // ended in a success message.
    expect(panel).toMatch(/const auth = await \(window as any\)\.claude\.remote\.authTailscale\(\);\s*\n\s*if \(auth\?\.error\)/);
  });

  it('keeps the check visible instead of clearing it on a timer', () => {
    expect(panel).not.toMatch(/setTimeout\(\(\) => setSetupStatus\('idle'\), 3000\)/);
  });

  it('draws setup-in-motion before the ready branch can hide it', () => {
    // Ordering is load-bearing: the moment Tailscale comes up, the QR branch matches, and
    // it would paint over the answer the user just asked for.
    expect(panel).toMatch(/setupStatus !== 'idle' \? renderSetupProgress[\s\S]{0,200}tailscale\?\.installed && tailscale\.url/);
  });
});

// Where the `state` above comes from — signed-out vs switched off vs unknown — is pinned
// by behaviour in `remote-config.test.ts` → detectTailscale, against real BackendState
// values, rather than by scanning the mapping table here.
