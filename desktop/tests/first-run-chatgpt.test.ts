// @vitest-environment jsdom
//
// First-run wizard sign-ins and launch gating: FirstRunManager.handleChatGptLogin / handleOpenRouterLogin / cancelAuth /
// handleNativeApiKey outcomes, FirstRunView's completion path and kill switch, setupIsUsable (a ChatGPT-only install must not be
// locked out on every launch; the Skip link is gone), markSetupCompleted (forcing AUTHENTICATE must not demote an established
// install to "brand new machine"), YOUCODED_TOOLKIT_STATE_DIR (a dev instance must not overwrite the installed app's setup state),
// and Settings' Claude Code card reading the live sign-in.
import React from 'react';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { FirstRunState } from '../src/shared/first-run-types';
import { INITIAL_PREREQUISITES } from '../src/shared/first-run-types';

// Point homedir at a scratch directory so the test never reads or writes the real wizard state (computed inside the hoisted factory).
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
  checkDiskSpace: vi.fn(),
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
  const cancelSignIn = vi.fn(async () => true);
  return { signIn, waitForSignIn, accessToken, cancelSignIn };
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
    // Deep copy: getState() is shallow and the outcome that follows mutates the live prerequisites array.
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
    // A failed first attempt leaves a red line; the sign-in that then works must clear it.
    await m.handleOpenRouterLogin({ signIn: async () => true, waitForSignIn: async () => 'timed-out', cancelSignIn: async () => true });
    expect(m.getState().lastError).toBe('Sign-in timed out. Try again?');

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

  it.each([
    ['timed-out', 'Sign-in timed out. Try again?'],
    ['cancelled', 'Sign-in was cancelled.'],
    [{ error: 'YouCoded could not save the sign-in: the keychain vanished mid-flow' }, 'YouCoded could not save the sign-in: the keychain vanished mid-flow'],
  ] as const)("%s → authMode 'none', that line verbatim, auth failed, still on AUTHENTICATE", async (outcome, line) => {
    const m = managerAtAuth();
    await m.handleChatGptLogin(fakeAuth(outcome as Outcome));
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe(line);
    expect(s.authComplete).toBe(false);
    expect(s.currentStep).toBe('AUTHENTICATE');
    expect(authPrereq(m).status).toBe('failed');
  });

  // Both IPC handlers swallow throws, so without folding the thrown sentence into lastError the button would silently do nothing.
  it.each([['port 1455 held', PORT_HELD], ['no keychain', NO_KEYCHAIN]])('a throw from signIn() (%s) → lastError is the thrown sentence verbatim and the wait never starts', async (_n, sentence) => {
    const m = managerAtAuth();
    const auth = fakeAuth('signed-in', { throwOnSignIn: sentence });
    await expect(m.handleChatGptLogin(auth)).resolves.toBeUndefined();
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe(sentence);
    expect(s.authComplete).toBe(false);
    expect(authPrereq(m).status).toBe('failed');
    expect(auth.waitForSignIn).not.toHaveBeenCalled();
  });
});

describe('FirstRunManager.handleOpenRouterLogin', () => {
  const auth = (outcome: Awaited<ReturnType<Parameters<FirstRunManager['handleOpenRouterLogin']>[0]['waitForSignIn']>>, throwOnSignIn?: string) => ({
    signIn: vi.fn(async (_o?: { timeoutMs?: number }) => { if (throwOnSignIn) throw new Error(throwOnSignIn); return true; }),
    waitForSignIn: vi.fn(async () => outcome),
    cancelSignIn: vi.fn(async () => true),
  });

  it('signed-in finishes setup on OpenRouter, with the 5-minute window', async () => {
    const m = managerAtAuth();
    const a = auth('signed-in');
    await m.handleOpenRouterLogin(a);
    expect(a.signIn).toHaveBeenCalledWith({ timeoutMs: 300_000 });
    const s = m.getState();
    expect(s.currentStep).toBe('COMPLETE');
    expect(s.authMode).toBe('openrouter');
    expect(s.setupProvider).toBe('openrouter');
  });

  it.each([
    ['timed-out', 'Sign-in timed out. Try again?'],
    ['cancelled', 'Sign-in was cancelled.'],
    [{ error: "OpenRouter didn't accept the sign-in. Try again." }, "OpenRouter didn't accept the sign-in. Try again."],
  ] as const)('%s puts the buttons back with one line and no failed row', async (outcome, line) => {
    const m = managerAtAuth();
    await m.handleOpenRouterLogin(auth(outcome as any));
    const s = m.getState();
    expect(s.lastError).toBe(line);
    expect(s.authMode).toBe('none');
    expect(s.currentStep).toBe('AUTHENTICATE');
    expect(authPrereq(m).status).not.toBe('failed');
  });


  it("a sign-in that can't start shows its own sentence", async () => {
    const m = managerAtAuth();
    await m.handleOpenRouterLogin(auth('cancelled', "YouCoded couldn't open your browser for the sign-in."));
    expect(m.getState().lastError).toBe("YouCoded couldn't open your browser for the sign-in.");
  });
});

// The wait screen's Cancel returns to the choices with no error, stops the browser round, and a late answer changes nothing.
describe('FirstRunManager.cancelAuth', () => {
  function pending() {
    let answer!: (o: Outcome) => void;
    const waitForSignIn = vi.fn(() => new Promise<Outcome>((r) => (answer = r)));
    const cancelSignIn = vi.fn(async () => { answer('cancelled'); return true; });
    return { signIn: vi.fn(async () => true), waitForSignIn, cancelSignIn, answer: (o: Outcome) => answer(o) };
  }

  it.each(['openrouter', 'chatgpt'] as const)('%s: Cancel puts the sign-in choices back with no error line', async (mode) => {
    const m = managerAtAuth();
    const a = pending();
    const run = mode === 'openrouter' ? m.handleOpenRouterLogin(a) : m.handleChatGptLogin(a);
    await vi.waitFor(() => expect(a.waitForSignIn).toHaveBeenCalled());
    expect(m.getState().authMode).toBe(mode);
    await m.cancelAuth();
    await run;
    expect(a.cancelSignIn).toHaveBeenCalledTimes(1);
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBeUndefined();
    expect(s.currentStep).toBe('AUTHENTICATE');
    expect(authPrereq(m).status).toBe('waiting');
  });

  it('a sign-in that completes after Cancel does not finish setup', async () => {
    const m = managerAtAuth();
    const a = pending();
    a.cancelSignIn.mockImplementation(async () => true); // the browser answers anyway
    const run = m.handleOpenRouterLogin(a);
    await vi.waitFor(() => expect(a.waitForSignIn).toHaveBeenCalled());
    await m.cancelAuth();
    a.answer('signed-in');
    await run;
    expect(m.getState().currentStep).toBe('AUTHENTICATE');
    expect(m.getState().authMode).toBe('none');
  });

  it('does nothing when no sign-in is waiting', async () => {
    const m = managerAtAuth();
    await m.cancelAuth();
    expect(m.getState().authMode).toBe('none');
  });
});

describe('setupIsUsable', () => {
  /** The three inputs, each defaulting to "no". */
  function io(over: Partial<{ signedIn: boolean; ready: boolean; claude: boolean }> = {}) {
    return {
      isSignedIn: vi.fn(() => over.signedIn === true),
      hasUsableProvider: vi.fn(async () => over.ready === true),
      detectAuth: vi.fn(async () => ({ installed: over.claude === true })),
    };
  }

  // [inputs, usable, subprocess spend]: a signed-in ChatGPT account must never pay for `claude auth status` on launch.
  it.each([
    ['a ChatGPT-only install (Claude CLI not logged in)', { signedIn: true }, true, { hasUsableProvider: 0, detectAuth: 0 }],
    ['an install on another provider (OpenRouter key, local model)', { ready: true }, true, { hasUsableProvider: 1, detectAuth: 0 }],
    ['a Claude install with no ChatGPT and no other provider', { claude: true }, true, { hasUsableProvider: 1, detectAuth: 1 }],
    ['nothing signed in anywhere (sends the user to sign-in)', {}, false, { hasUsableProvider: 1, detectAuth: 1 }],
  ])('%s', async (_n, over, usable, calls) => {
    const deps = io(over);
    expect(await setupIsUsable(deps)).toBe(usable);
    expect(deps.isSignedIn).toHaveBeenCalledTimes(1);
    expect(deps.hasUsableProvider).toHaveBeenCalledTimes(calls.hasUsableProvider);
    expect(deps.detectAuth).toHaveBeenCalledTimes(calls.detectAuth);
  });
});

describe('markSetupCompleted and isFirstRun', () => {
  it('forceStep alone demotes a finished install back to first-run on the next launch', () => {
    const m = new FirstRunManager();
    m.skip(); // reaches COMPLETE, which is what a finished setup looks like
    expect(FirstRunManager.isFirstRun()).toBe(false);

    m.forceStep('AUTHENTICATE'); // the launch-time "sign in again" nudge
    // The bug the flag stops: the wizard would re-run the Node/Git/Claude installers against a working install.
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

// run-dev.sh shifts userData but not HOME, so without this override a dev wizard overwrites the INSTALLED app's setup state.
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
    startAuth: vi.fn(), submitApiKey: vi.fn(), retry: vi.fn(), cancelAuth: vi.fn(),
  };
  const catalog = vi.fn(opts.catalog ?? (async () => []));
  (window as any).claude = {
    capabilities: { openExternal: true },
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

    await waitFor(() => expect(screen.getByText("You're all set")).toBeTruthy());
    await act(async () => { await Promise.resolve(); });
    expect(localStorage.getItem('youcoded-runtime-default')).toBeNull();
    expect(localStorage.getItem('youcoded-last-binding')).toBeNull();
    expect(catalog).not.toHaveBeenCalled();
  });

  it('the wait screen offers Cancel, which asks main to stop the sign-in', async () => {
    const { firstRun } = stubClaude({ state: viewState({ currentStep: 'AUTHENTICATE', authMode: 'openrouter' }) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));
    await waitFor(() => expect(screen.getByText(/Finish signing in to OpenRouter/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(firstRun.cancelAuth).toHaveBeenCalledTimes(1);
  });
});

describe('FirstRunView — the ChatGPT button and the kill switch', () => {
  afterEach(() => {
    cleanup();
    delete (window as any).claude;
  });

  // Sign-in asks for a kind first (deck first-run-2 P2-3): the plan buttons live behind
  // the "A plan you already pay for" row, the OpenRouter one behind "Pay as you go".
  async function openKind(title: string) {
    fireEvent.click(await screen.findByText(title));
  }

  it('hides "Log in with ChatGPT" when chatgpt.supported is false; Claude and OpenRouter stay', async () => {
    stubClaude({ state: viewState({}), chatgptSupported: false });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await openKind('A plan you already pay for');
    expect(screen.getByText('Log in with Claude')).toBeTruthy();
    expect(screen.queryByText('Log in with ChatGPT')).toBeNull();
    fireEvent.click(screen.getByText(/All options/));
    await openKind('Pay as you go');
    expect(screen.getByText('Log in with OpenRouter')).toBeTruthy();
  });

  it.each([
    ['the chatgpt namespace is missing (old preload, remote shim)', undefined, true],
    ['the client is a visiting remote one (no openExternal)', true, false],
  ])('hides it when %s', async (_n, supported, openExternal) => {
    stubClaude({ state: viewState({}), chatgptSupported: supported });
    (window as any).claude.capabilities.openExternal = openExternal;
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));
    await openKind('A plan you already pay for');
    expect(screen.queryByText('Log in with ChatGPT')).toBeNull();
    if (openExternal) expect(screen.getByText('Log in with Claude')).toBeTruthy();
  });

  it('shows it when chatgpt.supported is true, and the click starts the chatgpt auth mode', async () => {
    const { firstRun } = stubClaude({ state: viewState({}), chatgptSupported: true });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await openKind('A plan you already pay for');
    fireEvent.click(screen.getByText('Log in with ChatGPT'));
    expect(firstRun.startAuth).toHaveBeenCalledWith('chatgpt');
  });
});

describe('FirstRunView — Retry is offered only when something actually failed', () => {
  afterEach(() => { cleanup(); delete (window as any).claude; });

  // The raw message sits behind "Show details" on the stopped card (deck first-run-1 E-2).
  function showDetails() {
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
  }

  it('a refused OpenRouter key shows the message with no Retry and no stopped card', async () => {
    // One click reaches this state and nothing broke. Retry here would re-run the
    // whole install pass against a working machine.
    stubClaude({ state: viewState({
      currentStep: 'AUTHENTICATE',
      lastError: "OpenRouter didn't accept this key. Check that you copied all of it.",
    }) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText("OpenRouter didn't accept this key. Check that you copied all of it.")).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Setup stopped')).toBeNull();
    expect(screen.getByText('Choose how your assistant runs')).toBeTruthy();
  });

  it('a ChatGPT sign-in that timed out stops with Retry', async () => {
    // handleChatGptLogin marks the 'auth' prerequisite failed, which is the
    // signal the card reads.
    const prerequisites = INITIAL_PREREQUISITES.map((p) => (
      p.name === 'auth' ? { ...p, status: 'failed' as const, error: 'Timed out' } : { ...p, status: 'installed' as const }
    ));
    stubClaude({ state: viewState({
      currentStep: 'AUTHENTICATE',
      prerequisites,
      lastError: 'Sign-in timed out. Try again?',
    }) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText('Setup stopped')).toBeTruthy());
    expect(screen.getByText("Signing in didn't finish.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    showDetails();
    expect(screen.getByText('Sign-in timed out. Try again?')).toBeTruthy();
  });

  it('an error with no failed prerequisite and no other control (no disk space) keeps Retry', async () => {
    // On the install step there are no sign-in buttons — Retry is the only way
    // forward, so removing it would strand the user.
    stubClaude({ state: viewState({
      currentStep: 'INSTALL_PREREQUISITES',
      lastError: 'Insufficient disk space: 210 MB available (need >= 500 MB)',
    }) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText("This step didn't finish.")).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    showDetails();
    expect(screen.getByText(/Insufficient disk space/)).toBeTruthy();
  });

  it('a failed prerequisite install names the tool and keeps Retry', async () => {
    const prerequisites = INITIAL_PREREQUISITES.map((p) => (
      p.name === 'node' ? { ...p, status: 'failed' as const, error: 'network' } : { ...p }
    ));
    stubClaude({ state: viewState({
      currentStep: 'INSTALL_PREREQUISITES',
      prerequisites,
      lastError: 'Could not download Node.js',
    }) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText("Node.js couldn't be installed.")).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The bar steps aside while stopped (deck L-2).
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('FirstRunView — a ChatGPT sign-in still in progress seeds nothing', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); localStorage.clear(); delete (window as any).claude; });

  it("authMode 'chatgpt' at AUTHENTICATE writes neither key and never asks for the catalog", async () => {
    // authMode flips to 'chatgpt' minutes before the outcome is known; seeding now would put someone who then signs in with Claude on the wrong engine.
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

// WHY: the card once read the wizard's saved notes, which main answers with a bare {currentStep:'COMPLETE'} after the first launch, so a
// signed-in install said "Not set up yet". It now asks Claude Code itself (`claude-code:status`).
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
    expect(await screen.findByText(/API key/i)).toBeTruthy();
    expect(screen.getByText(/per token/i)).toBeTruthy();
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

// "Use an API key" checks an OpenRouter key BEFORE saving it (the old check asked the public model list, which answers any key).
describe('FirstRunManager.handleNativeApiKey — OpenRouter', () => {
  function deps(verdict: 'verified' | 'rejected' | 'unchecked') {
    const setKey = vi.fn(async () => {});
    const testConnection = vi.fn(async (_id: string, _candidate?: string) => ({
      ok: verdict === 'verified', verdict,
      message: verdict === 'rejected' ? "OpenRouter didn't accept this key. Check that you copied all of it." : 'x',
    }));
    return {
      setKey, testConnection,
      d: {
        providers: { list: vi.fn(async () => []), upsert: vi.fn(), setKey, remove: vi.fn(), testConnection },
        engine: { installed: () => false, install: vi.fn() },
        models: { curatedList: vi.fn(async () => []), on: vi.fn() },
      } as any,
    };
  }

  it('a refused key stays on the key page, says why, and is never saved', async () => {
    const m = managerAtAuth();
    const { d, setKey, testConnection } = deps('rejected');
    await m.handleNativeApiKey('sk-or-v1-fake', 'openrouter', d);
    expect(testConnection).toHaveBeenCalledWith('openrouter', 'sk-or-v1-fake');
    expect(setKey).not.toHaveBeenCalled();
    expect(m.getState().lastError).toMatch(/didn't accept this key/);
    expect(m.getState().currentStep).not.toBe('COMPLETE');
  });

  it.each([['verified', 'sk-or-v1-good'], ['unchecked', 'sk-or-v1-maybe']] as const)('a %s key is saved and setup finishes (offline first run is not stranded)', async (verdict, key) => {
    const m = managerAtAuth();
    const { d, setKey } = deps(verdict);
    await m.handleNativeApiKey(key, 'openrouter', d);
    expect(setKey).toHaveBeenCalledWith('openrouter', key);
    expect(m.getState().currentStep).toBe('COMPLETE');
  });
});
