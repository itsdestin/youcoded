// @vitest-environment jsdom
// SettingsPanel — the Remote Access section: the mock panel's controls, the setup banner and
// the end-of-setup check.
import { afterEach, expect, it, vi, describe } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RemoteAccessView } from '../src/renderer/components/remote/preview-types';
import {
  RemoteAccessMockPanel,
  renderPrerequisite,
  renderSetupProgress,
  type SetupCheck,
  type TailscaleInfo,
} from '../src/renderer/components/SettingsPanel';

describe('SettingsPanel — drawer edges', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const panel = read('../src/renderer/components/SettingsPanel.tsx');
  const css = read('../src/renderer/components/SettingsDrawer.css');
  const globalFade = read('../src/renderer/styles/globals.css');
  // WHY: the scoped stylesheet must ship with the drawer, not just exist on disk.
  expect(panel).toMatch(/import '\.\/SettingsDrawer\.css';/);
  expect(globalFade).toMatch(/\.scroll-fade::before,\s*\.scroll-fade::after\s*\{/);

  it('uses the selected title and a tapered divider without a full-width border', () => {
    // WHY: the component class and CSS pseudo-element must agree; a CSS-only guard
    // would pass even if the title kept its old font and border classes.
    expect(panel).toMatch(/settings-drawer-header[^"\n]*\bpx-4\b[^"\n]*\bpy-3\b"/);
    expect(panel).not.toMatch(/settings-drawer-header[^"\n]*\bborder-b\b/);
    expect(panel).toMatch(/<h2 className="text-base font-medium text-fg">Settings<\/h2>/);
    expect(css).toMatch(/\.settings-drawer-header::after\s*\{[^}]*left:\s*16px;[^}]*right:\s*16px;[^}]*linear-gradient\(to right, transparent, var\(--edge\) 8%, var\(--edge\) 92%, transparent\)/);
  });

  it('preserves the unchanged Today pane of the visual comparison', () => {
    // WHY: production now carries the selected style; without a scoped reset
    // the earlier Today/Selected deck would silently compare two Selected panes.
    const demo = read('../src/renderer/dev/workbench/mockups/SettingsTaperDemo.css');
    expect(demo).toMatch(/\[data-taper='shipping'\] \.settings-drawer-header\s*\{[^}]*border-bottom:\s*1px solid var\(--edge\)/);
    expect(demo).toMatch(/\[data-taper='shipping'\] \.settings-drawer-header::after\s*\{[^}]*display:\s*none/);
    expect(demo).toMatch(/\[data-taper='shipping'\] \.settings-drawer-header h2\s*\{[^}]*font-size:\s*0\.875rem;[^}]*font-weight:\s*700/);
    expect(demo).toMatch(/\[data-taper='shipping'\] \.settings-drawer-scroll\s*\{[^}]*mask-image:\s*none/);
    expect(demo).toMatch(/\[data-taper='shipping'\] \.settings-drawer-scroll::before,[\s\S]*?\.settings-drawer-scroll::after\s*\{[^}]*display:\s*block/);
  });

  it('fades scroll content against the real drawer background at both ends', () => {
    // WHY: the global painted fade must remain untouched for other scrolling surfaces.
    expect(panel).toMatch(/ref=\{outerScrollRef\} className="scroll-fade settings-drawer-scroll/);
    expect(css).toMatch(/\.settings-drawer-scroll\s*\{[^}]*mask-image:\s*linear-gradient\(to bottom,[^}]*mask-composite:\s*add;/);
    expect(css).toMatch(/\.settings-drawer-scroll\s*\{[^}]*transparent 0px,[^}]*#000 var\(--settings-fade-top\)/);
    expect(css).toMatch(/\.settings-drawer-scroll\s*\{[^}]*transparent 4%, transparent 96%, #000 100%/);
    expect(css).toMatch(/\.settings-drawer-scroll\[data-fade-top="true"\]\s*\{\s*--settings-fade-top:\s*42px;/);
    expect(css).toMatch(/\.settings-drawer-scroll\[data-fade-bottom="true"\]\s*\{\s*--settings-fade-bottom:\s*42px;/);
    expect(css).toMatch(/\.settings-drawer-scroll::before,\s*\.settings-drawer-scroll::after\s*\{\s*display:\s*none;/);
  });
});

describe('SettingsPanel — remote access panel', () => {
  afterEach(cleanup);
  const address = 'https://home-laptop.example-tailnet.ts.net';
  function mount(stage: RemoteAccessView['stage'], prerequisite?: RemoteAccessView['prerequisite']) {
    const onAction = vi.fn();
    const view: RemoteAccessView = {
      stage, address, prerequisite,
      devices: [{ id: 'phone', name: 'My phone', online: true }, { id: 'tablet', name: 'My tablet', online: false }],
    };
    render(<RemoteAccessMockPanel view={view} onAction={onAction} />);
    return onAction;
  }

  it('password field offers Generate, the length hint and the disconnect warning', () => {
    mount('ready');
    const password = screen.getByLabelText('Remote access password') as HTMLInputElement;
    // Generate fills a memorable passphrase over the minimum length.
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(password.value).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
    expect(password.value.replace(/-/g, '').length).toBeGreaterThanOrEqual(8);
    // The guidance and the consequence are both stated.
    expect(screen.getByText('At least 8 characters.')).toBeTruthy();
    expect(screen.getByText(/disconnects every device/)).toBeTruthy();
  });

  it('preserves the panel: enabled, password, keep awake, full-width Add Device and Info', () => {
    mount('ready');
    expect(screen.getByRole('switch', { name: 'Remote access server enabled' })).toBeTruthy();
    const password = screen.getByLabelText('Remote access password');
    fireEvent.change(password, { target: { value: 'preview-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect((password as HTMLInputElement).value).toBe('');
    for (const name of ['Off', '1h', '4h', '8h', '24h']) expect(screen.getByRole('tab', { name })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '8h' }));
    expect(screen.getByRole('tab', { name: '8h' }).getAttribute('aria-selected')).toBe('true');
    const add = screen.getByRole('button', { name: 'Add Device' });
    expect(add.className).toContain('w-full');
    fireEvent.click(add);
    // The address appears in the Tailscale section AND in the Add Device panel, and the two
    // must be the same string. A tester was shown a bare IP in one place and a tailnet
    // hostname in the other, with nothing saying they were the same machine.
    const shown = screen.getAllByText(address);
    expect(shown.length).toBeGreaterThanOrEqual(2);
  });

  it('draws every setup stage with the banner it already has, never a bespoke panel', () => {
    // WHY these three assertions: round-2 review rejected a replacement screen. A stage is a
    // status strip, a warning callout or an ErrorState — the shapes the banner already uses.
    const setup = mount('setup');
    expect(screen.getByText('Not set up yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(setup).toHaveBeenCalledWith({ type: 'consent' });
    cleanup();

    mount('checking');
    expect(screen.getByText(/Checking this computer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and continue' })).toBeNull();
  });

  it('names the missing prerequisite instead of one generic setup button', () => {
    const install = mount('setup', 'not-installed');
    fireEvent.click(screen.getByRole('button', { name: 'Install Tailscale' }));
    expect(install).toHaveBeenCalledWith({ type: 'prerequisite' });
    cleanup();
    const signIn = mount('setup', 'sign-in-required');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledWith({ type: 'prerequisite' });
  });

  it('keeps browser encryption behind its own screen, and explains it there', () => {
    // Destin, round 4: "this whole browser protection menu should be hidden behind a second
    // level popup". The main panel shows a row and its state, nothing more.
    const action = mount('ready');
    expect(screen.getByText('Advanced')).toBeTruthy();
    expect(screen.queryByText(/public list of issued certificates/)).toBeNull();

    fireEvent.click(screen.getByText('Browser encryption'));

    // The gain is named concretely, because "more secure" would be false: both levels are
    // encrypted. The cost is stated as permanent, and the website step before it is taken.
    expect(screen.getByText(/already private either way/)).toBeTruthy();
    expect(screen.getByText(/microphone, copy buttons and the font picker/)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
    expect(screen.getByText(/public list of issued certificates/)).toBeTruthy();
    expect(screen.getByText(/YouCoded cannot\s+do that part for you/)).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: 'Browser encryption' }));
    expect(action).toHaveBeenCalledWith({ type: 'advanced' });
  });

  it('keeps offline devices, marks them, and confirms unpairing before acting', () => {
    const action = mount('ready');
    expect(screen.getByText('Offline')).toBeTruthy();
    // WHY: the shipped row hardcodes a green dot for every connected client. Only the online
    // device and the panel's own ready dot may be green — never the remembered offline device.
    expect(document.querySelectorAll('.bg-green-400').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Unpair My tablet' }));
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByText(/pair again/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unpair' }));
    expect(action).toHaveBeenCalledWith({ type: 'revoke', deviceId: 'tablet' });
    expect(screen.queryByText('Skip password on Tailscale')).toBeNull();
  });

  it('reports a failed check without inventing a cause', () => {
    const action = mount('conflict');
    expect(screen.getByText(/another service/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(action).toHaveBeenCalledWith({ type: 'check' });
    cleanup();
    mount('error');
    expect(screen.getByRole('button', { name: 'Report bug' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Diagnose with the assistant' })).toBeTruthy();
  });
});

describe('SettingsPanel — remote setup flow', () => {
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
});
