// @vitest-environment jsdom
// Card #134 round 4: the Settings panel's small saves, rendered through the REAL SettingsPanel.
//  - new-session defaults on the Android and desktop screens ("Couldn't save this setting." and the control returns to the last saved value)
//  - Android plan tier ("Couldn't change the plan tier.")
//  - Remote access password ("Couldn't set the password.", typed text kept; closing the panel clears it)
// Each failure has a no-false-alarm partner (success, and an "unsupported here" rejection).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';

// Which screen SettingsPanel draws (it asks isAndroid() once per render).
const platform = vi.hoisted(() => ({ android: false }));
vi.mock('../src/renderer/platform', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/platform')>();
  return { ...real, isAndroid: () => platform.android };
});

import SettingsPanel from '../src/renderer/components/SettingsPanel';
import { AccountProvider } from '../src/renderer/state/account-context';
import { queueBrowserStorage } from './helpers/queue-browser-storage';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';

const toasts = () => { const got: string[] = []; const on = (e: Event) => got.push((e as CustomEvent).detail.message); window.addEventListener(APP_NOTICE_EVENT, on); return { got, off: () => window.removeEventListener(APP_NOTICE_EVENT, on) }; };
let t: ReturnType<typeof toasts>;
const unsupported = Object.assign(new Error('remote-unsupported: x'), { code: 'REMOTE_UNSUPPORTED' });
// settle: for negative assertions, let any late toast arrive first.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

// A window.claude that answers every call with "nothing", so unrelated sections of the panel mount quietly.
function claude(over: Record<string, any> = {}) {
  const quiet = (): any => new Proxy(() => Promise.resolve(undefined), { get: (_t, k) => (k === 'then' ? undefined : quiet()), apply: () => Promise.resolve(undefined) });
  const base: Record<string, any> = {
    native: { supported: false },
    social: { onPresenceEvent: () => () => {} },
    account: { signedIn: async () => false, user: async () => null },
    defaults: { get: vi.fn().mockResolvedValue({ skipPermissions: true, model: 'sonnet', projectFolder: '' }), set: vi.fn().mockResolvedValue({ skipPermissions: false, model: 'sonnet', projectFolder: '' }) },
    android: { getTier: vi.fn().mockResolvedValue({ tier: 'CORE' }), getAbout: vi.fn().mockResolvedValue({ version: '1', build: '1' }), setTier: vi.fn().mockResolvedValue({ ok: true }) },
    remote: {
      getConfig: vi.fn().mockResolvedValue({ enabled: true, port: 9900, hasPassword: false, weakPassword: false, clientCount: 0, keepAwakeHours: 0 }),
      devices: { list: vi.fn().mockResolvedValue([]) }, getStatus: vi.fn().mockResolvedValue(null), detectTailscale: vi.fn().mockResolvedValue({ installed: false }),
      setPassword: vi.fn().mockResolvedValue(true), setConfig: vi.fn().mockResolvedValue({}),
    },
    providers: { list: async () => [], catalog: async () => [] },
    models: { installed: async () => [], curated: async () => [], onDownloadProgress: () => () => {} },
    on: new Proxy({}, { get: () => () => () => {} }),
    off: () => {},
    firstRun: { getState: async () => ({ authMode: 'oauth', currentStep: 'COMPLETE' }) },
    search: { list: async () => [] },
    folders: { list: async () => [] },
    shell: { openExternal: () => {} },
    syncSpaces: { onEvent: () => () => {} },
  };
  const merged = { ...base, ...over };
  (window as any).claude = new Proxy(merged, { get: (o, k) => (k in o ? o[k as string] : quiet()) });
  return merged;
}

const panel = (open = true) => (
  <AccountProvider pollIntervalMs={10}><SettingsPanel open={open} onClose={() => {}} onSendInput={() => {}} hasActiveSession={false} /></AccountProvider>
);
async function mount(open = true) {
  let r!: ReturnType<typeof render>;
  await act(async () => { r = render(panel(open)); });
  return r;
}

beforeEach(() => {
  t = toasts();
  platform.android = false;
  Object.defineProperty(window, 'localStorage', { value: queueBrowserStorage(), configurable: true });
  (window as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { t.off(); cleanup(); vi.unstubAllGlobals(); delete (window as any).claude; vi.restoreAllMocks(); });


const click = (el: HTMLElement) => act(async () => { fireEvent.click(el); });

// ── new-session defaults, on both screens ───────────────────────────────────
// The skip-permissions switch is the one default that saves on a single click when turning OFF; it starts ON (saved value).
describe.each([['desktop', false], ['Android', true]])('new-session defaults on the %s screen', (_name, android) => {
  beforeEach(() => { platform.android = android; });
  const skipSwitch = () => screen.getByRole('switch', { name: 'Enable skip permissions mode?' });
  async function toPermissions() {
    await click(screen.getByRole('button', { name: /Assistant settings/ }));
    await click(await screen.findByRole('button', { name: /Permissions/ }));
    // The saved value arrives after the panel's own read (desktop defers it ~350 ms): wait for the switch to show it.
    await vi.waitFor(() => expect(skipSwitch()).toBeChecked());
  }

  it('a rejected save puts the switch back to the last saved value and says "Couldn\'t save this setting."', async () => {
    const set = vi.fn().mockRejectedValue(new Error('disk full'));
    claude({ defaults: { get: vi.fn().mockResolvedValue({ skipPermissions: true, model: 'sonnet', projectFolder: '' }), set } });
    await mount(); await toPermissions();
    await click(skipSwitch());
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't save this setting."]));
    expect(set).toHaveBeenCalledWith({ skipPermissions: false });
    await vi.waitFor(() => expect(skipSwitch()).toBeChecked());
  });
  it('a save that works keeps the new value and says nothing', async () => {
    const set = vi.fn().mockResolvedValue({ skipPermissions: false, model: 'sonnet', projectFolder: '' });
    claude({ defaults: { get: vi.fn().mockResolvedValue({ skipPermissions: true, model: 'sonnet', projectFolder: '' }), set } });
    await mount(); await toPermissions();
    await click(skipSwitch());
    await vi.waitFor(() => expect(set).toHaveBeenCalled());
    await settle();
    expect(skipSwitch()).not.toBeChecked();
    expect(t.got).toEqual([]);
  });
  it('an "unsupported here" rejection shows no notice', async () => {
    const set = vi.fn().mockRejectedValue(unsupported);
    claude({ defaults: { get: vi.fn().mockResolvedValue({ skipPermissions: true, model: 'sonnet', projectFolder: '' }), set } });
    await mount(); await toPermissions();
    await click(skipSwitch());
    await vi.waitFor(() => expect(set).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
});

// ── Android plan tier ────────────────────────────────────────────────────────
describe('Android plan tier', () => {
  beforeEach(() => { platform.android = true; });
  async function pickDeveloper() {
    await click(await screen.findByText('Package tier'));
    await click(await screen.findByText('Developer essentials'));
  }
  it('a rejected change says "Couldn\'t change the plan tier." and keeps the old tier shown', async () => {
    const setTier = vi.fn().mockRejectedValue(new Error('bridge down'));
    claude({ android: { getTier: vi.fn().mockResolvedValue({ tier: 'CORE' }), getAbout: vi.fn().mockResolvedValue({ version: '1', build: '1' }), setTier } });
    await mount();
    await pickDeveloper();
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't change the plan tier."]));
    expect(setTier).toHaveBeenCalledWith('DEVELOPER');
    expect(screen.getByText('Core')).toBeInTheDocument();
  });
  it('an { ok:false } answer says the same', async () => {
    claude({ android: { getTier: vi.fn().mockResolvedValue({ tier: 'CORE' }), getAbout: vi.fn().mockResolvedValue({ version: '1', build: '1' }), setTier: vi.fn().mockResolvedValue({ ok: false }) } });
    await mount();
    await pickDeveloper();
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't change the plan tier."]));
  });
  it('a change that works shows the new tier and says nothing', async () => {
    const setTier = vi.fn().mockResolvedValue({ ok: true });
    claude({ android: { getTier: vi.fn().mockResolvedValue({ tier: 'CORE' }), getAbout: vi.fn().mockResolvedValue({ version: '1', build: '1' }), setTier } });
    await mount();
    await pickDeveloper();
    await vi.waitFor(() => expect(screen.getByText('Developer essentials')).toBeInTheDocument());
    await vi.waitFor(() => expect(setTier).toHaveBeenCalledWith('DEVELOPER'));
    await settle();
    expect(t.got).toEqual([]);
  });
  it('an "unsupported here" rejection says nothing', async () => {
    const setTier = vi.fn().mockRejectedValue(unsupported);
    claude({ android: { getTier: vi.fn().mockResolvedValue({ tier: 'CORE' }), getAbout: vi.fn().mockResolvedValue({ version: '1', build: '1' }), setTier } });
    await mount();
    await pickDeveloper();
    await vi.waitFor(() => expect(setTier).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
});

// ── Remote access password ──────────────────────────────────────────────────
describe('Remote access password (desktop)', () => {
  const field = () => screen.getByLabelText('Remote access password') as HTMLInputElement;
  // The panel's reads are deferred ~350 ms after it opens; the password box is usable once they have answered.
  const opened = async () => { await click(screen.getByText('Remote access')); await screen.findByLabelText('Remote access password'); await vi.waitFor(() => expect(field()).not.toBeDisabled()); };
  async function typeAndSet(setPassword: any) {
    claude({ remote: { getConfig: vi.fn().mockResolvedValue({ enabled: true, port: 9900, hasPassword: false, weakPassword: false, clientCount: 0, keepAwakeHours: 0 }), devices: { list: vi.fn().mockResolvedValue([]) }, getStatus: vi.fn().mockResolvedValue(null), detectTailscale: vi.fn().mockResolvedValue({ installed: false }), setConfig: vi.fn().mockResolvedValue({}), setPassword } });
    await mount();
    await opened();
    await act(async () => { fireEvent.change(field(), { target: { value: 'correct-horse-9' } }); });
    await click(screen.getByRole('button', { name: 'Set' }));
  }
  it('a failed Set says "Couldn\'t set the password." and keeps the typed text', async () => {
    await typeAndSet(vi.fn().mockRejectedValue(new Error('keychain locked')));
    expect(await screen.findByText("Couldn't set the password.")).toBeInTheDocument();
    expect(field().value).toBe('correct-horse-9');
  });
  it('an "unsupported here" rejection of Set shows no "Couldn\'t set the password."', async () => {
    const setPassword = vi.fn().mockRejectedValue(unsupported);
    await typeAndSet(setPassword);
    await vi.waitFor(() => expect(setPassword).toHaveBeenCalled());
    await settle();
    expect(screen.queryByText("Couldn't set the password.")).toBeNull();
  });
  it('a Set that works shows no failure and clears the box', async () => {
    const setPassword = vi.fn().mockResolvedValue(true);
    await typeAndSet(setPassword);
    await vi.waitFor(() => expect(setPassword).toHaveBeenCalledWith('correct-horse-9'));
    await vi.waitFor(() => expect(field().value).toBe(''));
    expect(screen.queryByText("Couldn't set the password.")).toBeNull();
  });
  it('closing the panel clears a typed password', async () => {
    claude();
    const r = await mount();
    await opened();
    await act(async () => { fireEvent.change(field(), { target: { value: 'half-typed-pw' } }); });
    expect(field().value).toBe('half-typed-pw');
    await act(async () => { r.rerender(panel(false)); });
    await act(async () => { r.rerender(panel(true)); });
    // Reopened: the Remote access page is still open inside it; wait for its reads, then look at the box.
    await screen.findByLabelText('Remote access password');
    await vi.waitFor(() => expect(field()).not.toBeDisabled());
    expect(field().value).toBe('');
  });
});
