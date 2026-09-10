// @vitest-environment jsdom
//
// Pins the first-run wizard's "Log in with ChatGPT" half (design
// docs/active/specs/2026-09-05-chatgpt-signin-backend-design.md §5, §8):
//
//   - FirstRunManager.handleChatGptLogin: the waiting line, then every outcome
//     of the browser round-trip — signed-in finishes setup exactly like the
//     Claude path; timed-out / cancelled / { error } put the buttons back with
//     one accurate line; a THROW from signIn() (port 1455 held, no keychain) is
//     folded into lastError verbatim (review R3-3 — both IPC handlers swallow
//     throws, so without this the button would silently do nothing).
//   - handleOpenRouterNotBuilt: the approved card's OpenRouter button must not
//     be silent (review R1-6).
//   - FirstRunView's completion path: a ChatGPT-only install remembers 'native'
//     as its runtime default and seeds the model picker with the plan's first
//     model only when the catalog already has one (review R2-12) — and never
//     blocks the hand-off to the app on the catalog.
//   - The ChatGPT button vanishes under the kill switch (chatgpt.supported).
//   - setupIsUsable: the launch-time "can this install start a session?" test
//     that main.ts asks on every launch after setup. It used to live inline in
//     main.ts where nothing could reach it; reverting it to the Claude-only
//     question would lock a ChatGPT-only install out of its own app on EVERY
//     launch, and this branch removed the Skip link, so there is no way out.
//   - markSetupCompleted: forcing the wizard back to AUTHENTICATE must not
//     demote an established install to "brand new machine" on the next launch.
//   - The wizard's state folder honours YOUCODED_TOOLKIT_STATE_DIR, so a dev
//     instance cannot overwrite the installed app's setup state.
//   - Settings' Claude Code row does not claim a Claude account after a
//     ChatGPT-only first run.
import React from 'react';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import type { FirstRunState } from '../src/shared/first-run-types';
import { INITIAL_PREREQUISITES } from '../src/shared/first-run-types';

// FirstRunManager persists its state under ~/.claude/toolkit-state at every
// transition. Point homedir at a scratch directory so the test never reads or
// writes the real wizard state on this machine. The path is computed inside
// the factory (vi.mock is hoisted above every top-level const).
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  const pathMod = await import('path');
  const home = pathMod.join(real.tmpdir(), `first-run-chatgpt-test-home-${process.pid}`);
  return { ...real, default: { ...real, homedir: () => home }, homedir: () => home };
});
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
// prerequisite-installer imports 'electron'; nothing in it is exercised here.
vi.mock('../src/main/prerequisite-installer', () => ({
  detectNode: vi.fn(), detectGit: vi.fn(), detectClaude: vi.fn(), detectAuth: vi.fn(),
  installNode: vi.fn(), installGit: vi.fn(), installClaude: vi.fn(),
  startOAuthLogin: vi.fn(), pollAuthStatus: vi.fn(), submitApiKey: vi.fn(),
  checkDiskSpace: vi.fn(), checkWindowsDevMode: vi.fn(), enableWindowsDevMode: vi.fn(),
}));

import {
  FirstRunManager, CHATGPT_FIRST_RUN_TIMEOUT_MS, markSetupCompleted, setupIsUsable,
} from '../src/main/first-run';
import type { ChatGptSignInAuth } from '../src/main/first-run';
import FirstRunView from '../src/renderer/components/FirstRunView';
import { ClaudeCodeBlock } from '../src/renderer/components/ModelProvidersPopup';

const SCRATCH_HOME = join(tmpdir(), `first-run-chatgpt-test-home-${process.pid}`);

// The two sentences ChatGptAuth.signIn() throws (chatgpt-auth.ts), copied so
// this file need not load the account machine (it imports 'electron').
const PORT_HELD =
  'Port 1455 is already in use on this computer, so YouCoded cannot receive the sign-in. ' +
  'Close the other program using it (often the Codex CLI) and try again.';
const NO_KEYCHAIN =
  'Secure key storage is not available on this system, so YouCoded cannot save API keys. (Your OS keychain/libsecret is required.)';

type Outcome = Awaited<ReturnType<ChatGptSignInAuth['waitForSignIn']>>;

/** A two-method stand-in for ChatGptAuth. `signIn` resolves true unless told
 *  to throw; `waitForSignIn` answers the scripted outcome. */
function fakeAuth(outcome: Outcome, opts: { throwOnSignIn?: string } = {}) {
  const signIn = vi.fn(async (_o?: { timeoutMs?: number }) => {
    if (opts.throwOnSignIn) throw new Error(opts.throwOnSignIn);
    return true;
  });
  const waitForSignIn = vi.fn(async () => outcome);
  // A token-shaped method the wizard must never reach for.
  const accessToken = vi.fn(async () => 'sk-secret-never-read');
  return { signIn, waitForSignIn, accessToken };
}

function managerAtAuth(): FirstRunManager {
  const m = new FirstRunManager();
  m.forceStep('AUTHENTICATE');
  return m;
}

function authPrereq(m: FirstRunManager) {
  return m.getState().prerequisites.find((p) => p.name === 'auth')!;
}

beforeEach(() => { rmSync(SCRATCH_HOME, { recursive: true, force: true }); });
afterEach(() => { rmSync(SCRATCH_HOME, { recursive: true, force: true }); });

describe('FirstRunManager.handleChatGptLogin', () => {
  it('shows the waiting line and marks auth in progress before the browser opens, with the 5-minute window', async () => {
    const m = managerAtAuth();
    let seen: FirstRunState | null = null;
    const auth = fakeAuth('cancelled');
    // Deep copy: getState() is a shallow copy whose prerequisites array is the
    // live one, and the outcome that follows mutates it.
    auth.signIn.mockImplementation(async () => { seen = JSON.parse(JSON.stringify(m.getState())); return true; });

    await m.handleChatGptLogin(auth);

    expect(seen).not.toBeNull();
    expect(seen!.authMode).toBe('chatgpt');
    expect(seen!.statusMessage).toBe('Waiting for you to sign in…');
    expect(seen!.prerequisites.find((p) => p.name === 'auth')!.status).toBe('installing');
    expect(auth.signIn).toHaveBeenCalledWith({ timeoutMs: 300_000 });
    expect(CHATGPT_FIRST_RUN_TIMEOUT_MS).toBe(300_000);
    // The scratch home really is where state went — not Destin's ~/.claude.
    expect(existsSync(join(SCRATCH_HOME, '.claude', 'toolkit-state', 'first-run-state.json'))).toBe(true);
  });

  it("signed-in → auth installed, launch-wizard emitted, COMPLETE, and authMode stays 'chatgpt' for the renderer", async () => {
    const m = managerAtAuth();
    const launched = vi.fn();
    m.on('launch-wizard', launched);
    const auth = fakeAuth('signed-in');
    // A failed first attempt leaves a red line on screen; the sign-in that
    // then works must take it away with it (fix 7).
    m.handleOpenRouterNotBuilt();
    expect(m.getState().lastError).toBe('OpenRouter sign-in is coming in a later update.');

    await m.handleChatGptLogin(auth);

    const s = m.getState();
    expect(s.authComplete).toBe(true);
    expect(authPrereq(m).status).toBe('installed');
    expect(s.currentStep).toBe('COMPLETE');
    expect(s.authMode).toBe('chatgpt');
    expect(s.lastError).toBeUndefined();
    expect(launched).toHaveBeenCalledTimes(1);
    expect(auth.waitForSignIn).toHaveBeenCalledTimes(1);
    // Never a token: the wizard neither asks for one nor stores one.
    expect(auth.accessToken).not.toHaveBeenCalled();
    expect(JSON.stringify(s)).not.toContain('sk-secret');
  });

  it("timed-out → authMode 'none', 'Sign-in timed out. Try again?', auth failed, still on AUTHENTICATE", async () => {
    const m = managerAtAuth();
    await m.handleChatGptLogin(fakeAuth('timed-out'));
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe('Sign-in timed out. Try again?');
    expect(s.authComplete).toBe(false);
    expect(s.currentStep).toBe('AUTHENTICATE');
    expect(authPrereq(m).status).toBe('failed');
  });

  it("cancelled → 'Sign-in was cancelled.'", async () => {
    const m = managerAtAuth();
    await m.handleChatGptLogin(fakeAuth('cancelled'));
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe('Sign-in was cancelled.');
    expect(authPrereq(m).status).toBe('failed');
  });

  it('{ error } → that text, verbatim', async () => {
    const m = managerAtAuth();
    const text = 'YouCoded could not save the sign-in: the keychain vanished mid-flow';
    await m.handleChatGptLogin(fakeAuth({ error: text }));
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe(text);
    expect(authPrereq(m).status).toBe('failed');
    expect(authPrereq(m).error).toBe(text);
  });

  it('a throw from signIn() (port 1455 held) → lastError is the thrown sentence verbatim and the wait never starts (R3-3)', async () => {
    const m = managerAtAuth();
    const auth = fakeAuth('signed-in', { throwOnSignIn: PORT_HELD });
    await expect(m.handleChatGptLogin(auth)).resolves.toBeUndefined();
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe(PORT_HELD);
    expect(s.authComplete).toBe(false);
    expect(authPrereq(m).status).toBe('failed');
    expect(auth.waitForSignIn).not.toHaveBeenCalled();
  });

  it('a throw from signIn() (no keychain) → the store\'s own sentence, verbatim', async () => {
    const m = managerAtAuth();
    await m.handleChatGptLogin(fakeAuth('signed-in', { throwOnSignIn: NO_KEYCHAIN }));
    expect(m.getState().lastError).toBe(NO_KEYCHAIN);
    expect(m.getState().authMode).toBe('none');
  });
});

describe('FirstRunManager.handleOpenRouterNotBuilt', () => {
  it("answers the approved card's OpenRouter button with its one line (R1-6)", () => {
    const m = managerAtAuth();
    m.handleOpenRouterNotBuilt();
    const s = m.getState();
    expect(s.lastError).toBe('OpenRouter sign-in is coming in a later update.');
    expect(s.authMode).toBe('none');
    expect(s.currentStep).toBe('AUTHENTICATE');
  });
});

// ---------------------------------------------------------------------------
// setupIsUsable — the launch-time lock-out test (main.ts calls this on every
// launch after setup). Answering `false` puts the user back on the sign-in
// screen, and this branch removed the Skip link, so `false` means locked out.
// ---------------------------------------------------------------------------

describe('setupIsUsable', () => {
  /** The three inputs, each defaulting to "no". */
  function io(over: Partial<{ signedIn: boolean; ready: boolean; claude: boolean }> = {}) {
    return {
      isSignedIn: vi.fn(() => over.signedIn === true),
      hasUsableProvider: vi.fn(async () => over.ready === true),
      detectAuth: vi.fn(async () => ({ installed: over.claude === true })),
    };
  }

  it('a ChatGPT-only install is usable — even with the Claude CLI not logged in, and without spawning it', async () => {
    const deps = io({ signedIn: true });
    expect(await setupIsUsable(deps)).toBe(true);
    // The `claude auth status` subprocess is the expensive one; a signed-in
    // ChatGPT account must never pay for it on launch.
    expect(deps.hasUsableProvider).not.toHaveBeenCalled();
    expect(deps.detectAuth).not.toHaveBeenCalled();
  });

  it('an install running on another provider (an OpenRouter key, a local model) is usable', async () => {
    const deps = io({ ready: true });
    expect(await setupIsUsable(deps)).toBe(true);
    expect(deps.detectAuth).not.toHaveBeenCalled();
  });

  it('a Claude install with no ChatGPT and no other provider is usable', async () => {
    const deps = io({ claude: true });
    expect(await setupIsUsable(deps)).toBe(true);
    expect(deps.detectAuth).toHaveBeenCalledTimes(1);
  });

  it('nothing signed in anywhere → not usable, which is what sends the user to the sign-in screen', async () => {
    const deps = io();
    expect(await setupIsUsable(deps)).toBe(false);
    expect(deps.isSignedIn).toHaveBeenCalledTimes(1);
    expect(deps.hasUsableProvider).toHaveBeenCalledTimes(1);
    expect(deps.detectAuth).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// markSetupCompleted — forcing the wizard back to AUTHENTICATE must not turn
// an install that has worked for months into a "brand new machine".
// ---------------------------------------------------------------------------

describe('markSetupCompleted and isFirstRun', () => {
  it('forceStep alone demotes a finished install back to first-run on the next launch', () => {
    const m = new FirstRunManager();
    m.skip(); // reaches COMPLETE, which is what a finished setup looks like
    expect(FirstRunManager.isFirstRun()).toBe(false);

    m.forceStep('AUTHENTICATE'); // the launch-time "sign in again" nudge
    // This is the bug the flag exists to stop: the wizard would re-run the
    // Node/Git/Claude installers against a working install.
    expect(FirstRunManager.isFirstRun()).toBe(true);
  });

  it('marking setup completed first keeps the next launch out of the wizard', () => {
    const m = new FirstRunManager();
    m.skip();
    markSetupCompleted();
    m.forceStep('AUTHENTICATE');
    expect(FirstRunManager.isFirstRun()).toBe(false);
  });

  it('merges into an existing config rather than replacing it', () => {
    const configPath = join(SCRATCH_HOME, '.claude', 'toolkit-state', 'config.json');
    mkdirSync(join(SCRATCH_HOME, '.claude', 'toolkit-state'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ something_else: 'kept' }));
    markSetupCompleted();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      something_else: 'kept', setup_completed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Where the wizard's state file lives. `scripts/run-dev.sh` shifts Electron's
// userData but cannot shift HOME, so without this override a dev instance
// walking the setup wizard overwrites the INSTALLED app's setup state — and
// Destin's real app opens on the setup wizard at its next launch.
// ---------------------------------------------------------------------------

describe('YOUCODED_TOOLKIT_STATE_DIR', () => {
  const ENV_DIR = join(tmpdir(), `first-run-state-dir-${process.pid}`);
  afterEach(() => {
    delete process.env.YOUCODED_TOOLKIT_STATE_DIR;
    rmSync(ENV_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('writes to the folder the env var names, and nothing under ~/.claude', async () => {
    process.env.YOUCODED_TOOLKIT_STATE_DIR = ENV_DIR;
    vi.resetModules();
    const mod = await import('../src/main/first-run');
    const m = new mod.FirstRunManager();
    m.forceStep('AUTHENTICATE');
    mod.markSetupCompleted();

    expect(existsSync(join(ENV_DIR, 'first-run-state.json'))).toBe(true);
    expect(existsSync(join(ENV_DIR, 'config.json'))).toBe(true);
    expect(existsSync(join(SCRATCH_HOME, '.claude', 'toolkit-state'))).toBe(false);
  });

  it('defaults to ~/.claude/toolkit-state when the env var is unset — existing installs move nothing', async () => {
    delete process.env.YOUCODED_TOOLKIT_STATE_DIR;
    vi.resetModules();
    const mod = await import('../src/main/first-run');
    const m = new mod.FirstRunManager();
    m.forceStep('AUTHENTICATE');

    expect(existsSync(join(SCRATCH_HOME, '.claude', 'toolkit-state', 'first-run-state.json'))).toBe(true);
    expect(existsSync(join(ENV_DIR, 'first-run-state.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FirstRunView — completion path and the kill-switch gate
// ---------------------------------------------------------------------------

// jsdom exposes no usable `localStorage` here (same as runtime-default.test.tsx),
// and RuntimeBinding writes the bare global, so stand up a Map-backed one.
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    },
  });
});

function viewState(overrides: Partial<FirstRunState>): FirstRunState {
  return {
    currentStep: 'AUTHENTICATE',
    prerequisites: INITIAL_PREREQUISITES.map((p) => ({ ...p })),
    overallProgress: 72,
    statusMessage: 'Sign in to continue',
    authMode: 'none',
    authComplete: false,
    needsDevMode: false,
    ...overrides,
  };
}

/** Installs a window.claude with just what FirstRunView touches. */
function stubClaude(opts: {
  state: FirstRunState;
  catalog?: () => Promise<unknown>;
  chatgptSupported?: boolean;
}) {
  const firstRun = {
    getState: vi.fn(async () => opts.state),
    onStateChanged: vi.fn(() => () => {}),
    startAuth: vi.fn(), submitApiKey: vi.fn(), retry: vi.fn(), devModeDone: vi.fn(),
  };
  const catalog = vi.fn(opts.catalog ?? (async () => []));
  (window as any).claude = {
    firstRun,
    off: vi.fn(),
    providers: { catalog },
    ...(opts.chatgptSupported === undefined ? {} : { chatgpt: { supported: opts.chatgptSupported } }),
  };
  return { firstRun, catalog };
}

describe('FirstRunView completion path (authMode chatgpt)', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as any).claude;
  });

  it("writes youcoded-runtime-default='native' and the chatgpt binding when the catalog has a chatgpt row", async () => {
    const { catalog } = stubClaude({
      state: viewState({ currentStep: 'COMPLETE', authMode: 'chatgpt', authComplete: true }),
      catalog: async () => [
        { id: 'claude-x', providerId: 'anthropic', label: 'Claude' },
        { id: 'gpt-5-codex', providerId: 'chatgpt', label: 'GPT-5 Codex' },
        { id: 'gpt-5-mini', providerId: 'chatgpt', label: 'GPT-5 mini' },
      ],
    });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(localStorage.getItem('youcoded-last-binding')).not.toBeNull());
    expect(localStorage.getItem('youcoded-runtime-default')).toBe('native');
    // The FIRST chatgpt row, not the first row of any provider.
    expect(JSON.parse(localStorage.getItem('youcoded-last-binding')!)).toEqual({ providerId: 'chatgpt', modelId: 'gpt-5-codex' });
    expect(catalog).toHaveBeenCalledTimes(1);
  });

  it('writes only the runtime key when the catalog has no chatgpt row yet (the refresh may still be in flight)', async () => {
    const { catalog } = stubClaude({
      state: viewState({ currentStep: 'COMPLETE', authMode: 'chatgpt', authComplete: true }),
      catalog: async () => [{ id: 'claude-x', providerId: 'anthropic', label: 'Claude' }],
    });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(localStorage.getItem('youcoded-runtime-default')).toBe('native');
    expect(localStorage.getItem('youcoded-last-binding')).toBeNull();
  });

  it('still hands off to the app when the catalog rejects — the runtime key is written, nothing throws', async () => {
    const onComplete = vi.fn();
    stubClaude({
      state: viewState({ currentStep: 'COMPLETE', authMode: 'chatgpt', authComplete: true }),
      catalog: async () => { throw new Error('provider registry not ready'); },
    });
    render(React.createElement(FirstRunView, { onComplete }));

    await waitFor(() => expect(localStorage.getItem('youcoded-runtime-default')).toBe('native'));
    expect(localStorage.getItem('youcoded-last-binding')).toBeNull();
    // The existing 1.5 s hand-off timer is untouched by the catalog failure.
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 4000 });
  });

  it('writes neither key for a completion through Claude (authMode oauth) — existing users see no change', async () => {
    const { catalog } = stubClaude({
      state: viewState({ currentStep: 'COMPLETE', authMode: 'oauth', authComplete: true }),
      catalog: async () => [{ id: 'gpt-5-codex', providerId: 'chatgpt', label: 'GPT-5 Codex' }],
    });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText("You're all set.")).toBeTruthy());
    await act(async () => { await Promise.resolve(); });
    expect(localStorage.getItem('youcoded-runtime-default')).toBeNull();
    expect(localStorage.getItem('youcoded-last-binding')).toBeNull();
    expect(catalog).not.toHaveBeenCalled();
  });
});

describe('FirstRunView — the ChatGPT button and the kill switch', () => {
  afterEach(() => {
    cleanup();
    delete (window as any).claude;
  });

  it('hides "Log in with ChatGPT" when chatgpt.supported is false; the other two plans stay', async () => {
    stubClaude({ state: viewState({}), chatgptSupported: false });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText('Log in with Claude')).toBeTruthy());
    expect(screen.queryByText('Log in with ChatGPT')).toBeNull();
    expect(screen.getByText('Log in with OpenRouter')).toBeTruthy();
  });

  it('hides it when the chatgpt namespace is missing entirely (old preload, remote shim)', async () => {
    stubClaude({ state: viewState({}) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText('Log in with Claude')).toBeTruthy());
    expect(screen.queryByText('Log in with ChatGPT')).toBeNull();
  });

  it('shows it when chatgpt.supported is true, and the click starts the chatgpt auth mode', async () => {
    const { firstRun } = stubClaude({ state: viewState({}), chatgptSupported: true });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    const button = await screen.findByText('Log in with ChatGPT');
    button.click();
    expect(firstRun.startAuth).toHaveBeenCalledWith('chatgpt');
  });
});

// ---------------------------------------------------------------------------
// The wizard's error line and its Try Again button
// ---------------------------------------------------------------------------

describe('FirstRunView — Try Again is offered only when something actually failed', () => {
  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('the OpenRouter "not built yet" line shows the message with no Try Again button', async () => {
    // One click reaches this state and nothing broke. "Try Again" here would
    // re-run the whole Node/Git/Claude install pass against a working machine.
    stubClaude({ state: viewState({
      currentStep: 'AUTHENTICATE',
      lastError: 'OpenRouter sign-in is coming in a later update.',
    }) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText('OpenRouter sign-in is coming in a later update.')).toBeTruthy());
    expect(screen.queryByText('Try Again')).toBeNull();
    // …and the headline stays the step's own line, not "Something went wrong".
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(screen.getByText('Sign in with your Claude, ChatGPT or OpenRouter account to finish setup.')).toBeTruthy();
  });

  it('a ChatGPT sign-in that timed out keeps its Try Again button', async () => {
    // handleChatGptLogin marks the 'auth' prerequisite failed, which is the
    // signal the button reads.
    const prerequisites = INITIAL_PREREQUISITES.map((p) => (
      p.name === 'auth' ? { ...p, status: 'failed' as const, error: 'Timed out' } : { ...p, status: 'installed' as const }
    ));
    stubClaude({ state: viewState({
      currentStep: 'AUTHENTICATE',
      prerequisites,
      lastError: 'Sign-in timed out. Try again?',
    }) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText('Sign-in timed out. Try again?')).toBeTruthy());
    expect(screen.getByText('Try Again')).toBeTruthy();
    expect(screen.getByText('Something went wrong. You can retry the last step.')).toBeTruthy();
  });

  it('an error with no failed prerequisite and no other control (no disk space) keeps its Try Again button', async () => {
    // On the install step there are no sign-in buttons — Try Again is the only
    // way forward, so removing it would strand the user.
    stubClaude({ state: viewState({
      currentStep: 'INSTALL_PREREQUISITES',
      lastError: 'Insufficient disk space: 210 MB available (need >= 500 MB)',
    }) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText(/Insufficient disk space/)).toBeTruthy());
    expect(screen.getByText('Try Again')).toBeTruthy();
  });

  it('a failed prerequisite install keeps its Try Again button', async () => {
    const prerequisites = INITIAL_PREREQUISITES.map((p) => (
      p.name === 'node' ? { ...p, status: 'failed' as const, error: 'network' } : { ...p }
    ));
    stubClaude({ state: viewState({
      currentStep: 'INSTALL_PREREQUISITES',
      prerequisites,
      lastError: 'Could not download Node.js',
    }) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText('Could not download Node.js')).toBeTruthy());
    expect(screen.getByText('Try Again')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The runtime seeding must wait for the sign-in to FINISH
// ---------------------------------------------------------------------------

describe('FirstRunView — a ChatGPT sign-in still in progress seeds nothing', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); localStorage.clear(); delete (window as any).claude; });

  it("authMode 'chatgpt' at AUTHENTICATE writes neither key and never asks for the catalog", async () => {
    // authMode flips to 'chatgpt' the instant the browser opens, minutes before
    // the outcome is known. Seeding here would switch someone who then gives up
    // and signs in with Claude onto the wrong engine for their first session.
    const { catalog } = stubClaude({
      state: viewState({ currentStep: 'AUTHENTICATE', authMode: 'chatgpt' }),
      catalog: async () => [{ id: 'gpt-5-codex', providerId: 'chatgpt', label: 'GPT-5 Codex' }],
      chatgptSupported: true,
    });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    // The screen is mid-sign-in: the spinner line, not the three buttons.
    await waitFor(() => expect(screen.getByText(/A browser window should have opened/)).toBeTruthy());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(localStorage.getItem('youcoded-runtime-default')).toBeNull();
    expect(localStorage.getItem('youcoded-last-binding')).toBeNull();
    expect(catalog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Settings → Cloud providers: the Claude Code card reads the LIVE sign-in
// ---------------------------------------------------------------------------
//
// This block used to drive the card through `firstRun.getState()` — the setup
// wizard's saved notes. That was the bug found on 2026-09-09: on every launch
// after the first, main answers that call with a bare `{currentStep:'COMPLETE'}`
// carrying no auth fields at all, so a signed-in install read as signed-out and
// the card said "Not set up yet" while every Claude model in the picker was
// greyed out with "Sign in to use". The card now asks Claude Code itself
// (`claude-code:status`), so these tests drive that channel instead.

describe('ModelProvidersPopup — the Claude Code card reads the live sign-in', () => {
  afterEach(() => { cleanup(); delete (window as any).claude; });

  /** Just enough window.claude for the card to mount. `claudeCode.status` is
   *  the only input its status line reads now. */
  function stubSettings(status: unknown) {
    (window as any).claude = {
      native: { supported: true },
      chatgpt: { supported: false }, // keeps the ChatGPT card (and its IPC) out of this test
      providers: { list: async () => [], catalog: async () => [], test: async () => ({ ok: true, message: '' }) },
      models: { installed: async () => [], curated: async () => [], onDownloadProgress: () => () => {} },
      engine: { status: async () => null, onInstallProgress: () => () => {}, onStatusChanged: () => () => {} },
      on: { statusData: () => () => {} },
      off: () => {},
      claudeCode: { status: async () => status },
      search: { list: async () => [] },
      shell: { openExternal: () => {} },
    };
  }

  it('names the account and its plan, the way the ChatGPT card does', async () => {
    stubSettings({ state: 'signed-in', email: 'destin@example.com', plan: 'max', apiKey: false });
    render(React.createElement(ClaudeCodeBlock, { onCloseParent: vi.fn() }));
    expect(await screen.findByText('Signed in as destin@example.com')).toBeTruthy();
    expect(screen.getByText('Max plan')).toBeTruthy();
  });

  it('does not claim a Claude account when Claude Code is signed out', async () => {
    // The case the old ChatGPT-only test covered, asked of the right source:
    // finishing setup through ChatGPT leaves Claude Code itself signed out.
    stubSettings({ state: 'signed-out' });
    render(React.createElement(ClaudeCodeBlock, { onCloseParent: vi.fn() }));
    expect(await screen.findByText('Not signed in')).toBeTruthy();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('says connected, and promises no plan limits, for an Anthropic API key', async () => {
    stubSettings({ state: 'signed-in', apiKey: true });
    render(React.createElement(ClaudeCodeBlock, { onCloseParent: vi.fn() }));
    expect(await screen.findByText('Connected with an Anthropic API key')).toBeTruthy();
    expect(screen.getByText('Billed per token — no plan limits.')).toBeTruthy();
  });

  it('reports a missing binary as missing, never as signed out', async () => {
    // Signing in is not the fix for this one, so the words must not suggest it.
    stubSettings({ state: 'not-installed' });
    render(React.createElement(ClaudeCodeBlock, { onCloseParent: vi.fn() }));
    expect(await screen.findByText('Claude Code is not installed')).toBeTruthy();
    expect(screen.queryByText('Not signed in')).toBeNull();
  });

  it('admits it could not read the state rather than inventing one', async () => {
    stubSettings({ state: 'unknown' });
    render(React.createElement(ClaudeCodeBlock, { onCloseParent: vi.fn() }));
    expect(await screen.findByText("Signed-in state couldn't be read")).toBeTruthy();
    expect(screen.queryByText('Not signed in')).toBeNull();
  });

  it('treats a surface that cannot answer the channel as unknown, not signed out', async () => {
    // Android before its arm existed, or a remote server with no runtime wired,
    // answers {ok:false}. Reading that as "signed out" would grey out every
    // Claude model on a working install.
    stubSettings({ ok: false });
    render(React.createElement(ClaudeCodeBlock, { onCloseParent: vi.fn() }));
    expect(await screen.findByText("Signed-in state couldn't be read")).toBeTruthy();
  });
});
