import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { log } from './logger';
import {
  FirstRunState,
  FirstRunStep,
  INITIAL_PREREQUISITES,
} from '../shared/first-run-types';
import {
  detectNode,
  detectGit,
  detectClaude,
  detectAuth,
  installNode,
  installGit,
  installClaude,
  startOAuthLogin,
  pollAuthStatus,
  submitApiKey,
  checkDiskSpace,
  checkWindowsDevMode,
  enableWindowsDevMode,
} from './prerequisite-installer';
import type { ChatGptAuth } from './providers/chatgpt-auth';
import type { CuratedModel, DownloadProgress } from '../shared/model-manager-types';
import { writeSetupDownload } from './first-run-local';

/** The key services "Use an API key" accepts (first-run local models, F-1). */
export type NativeKeyService = 'anthropic' | 'openai' | 'google' | 'openrouter';
const NATIVE_KEY_LABEL: Record<Exclude<NativeKeyService, 'openrouter'>, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/**
 * What the native ways into setup reach (first-run local models, 2026-09-14): a
 * key, a model app already running, or a local download. Narrowed so a test can
 * hand in fakes; main.ts passes the real registry, engine and model manager that
 * registerIpcHandlers builds.
 */
export interface FirstRunNativeDeps {
  providers: {
    list(): Promise<Array<{ id: string; type: string; baseUrl?: string }>>;
    upsert(input: { type: any; label: string; baseUrl?: string; enabled: boolean }): Promise<string>;
    setKey(id: string, key: string): Promise<void>;
    remove(id: string): Promise<void>;
    testConnection(id: string): Promise<{ ok: boolean; message: string }>;
  };
  engine: { installed(): boolean; install(): Promise<unknown> };
  models: {
    curatedList(): Promise<CuratedModel[]>;
    on(event: 'download-progress', cb: (p: DownloadProgress) => void): unknown;
  };
}

// The slice of ChatGptAuth the wizard drives. Narrowed on purpose: the wizard
// only starts a sign-in and waits for it, so a test can hand in a two-method
// fake instead of the whole account machine (main.ts passes the real one).
export type ChatGptSignInAuth = Pick<ChatGptAuth, 'signIn' | 'waitForSignIn'>;

// The wizard's ChatGPT sign-in window (design §9.1, review R2-11): a first
// ChatGPT sign-in on a fresh machine is an email code or 2FA away, and this
// screen has no Cancel — so 5 minutes, not Claude's 2 and not the Settings
// card's 10.
export const CHATGPT_FIRST_RUN_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// WHY the env var: this folder lives under the user's HOME, not under
// Electron's userData, so a dev instance and the real installed app share it.
// `scripts/run-dev.sh` shifts userData but cannot shift HOME — so without this
// escape hatch, walking the setup wizard in a dev window overwrites the
// installed app's setup state, and Destin's real app opens on the setup wizard
// at its next launch. The default is unchanged, so existing installs move
// nothing; only a caller that sets YOUCODED_TOOLKIT_STATE_DIR is redirected.
const STATE_DIR = process.env.YOUCODED_TOOLKIT_STATE_DIR
  || path.join(os.homedir(), '.claude', 'toolkit-state');
const STATE_FILE = path.join(STATE_DIR, 'first-run-state.json');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

/** The wizard's state folder — also where first-run-local keeps the record of
 *  the download setup finished on, so it follows the same dev-instance redirect. */
export function firstRunStateDir(): string {
  return STATE_DIR;
}

/**
 * Write `setup_completed: true` into the wizard's config file, merging into
 * whatever is already there.
 *
 * WHY it exists: `isFirstRun()` answers "show the setup wizard from scratch?"
 * and it says yes unless this flag is set OR the state file happens to sit at
 * COMPLETE. Anything that moves the state file off COMPLETE on an install that
 * already works — the launch-time "sign in again" nudge, the skip button —
 * must set this flag first, or the NEXT launch treats a months-old install as
 * a brand-new machine and re-runs the Node/Git/Claude installers.
 */
export function markSetupCompleted(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* no config yet */ }
    config.setup_completed = true;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    log('WARN', 'first-run', 'Failed to mark setup completed', { error: String(err) });
  }
}

/**
 * "Can this install actually start a session?" — the launch-time check that
 * decides whether an established install is dropped back onto the sign-in
 * screen (design 2026-09-05 §5, review R3-2).
 *
 * WHY it is a separate, injectable function rather than three `||`s inside
 * main.ts: this branch removed the wizard's Skip link, so answering `false`
 * locks the user out of their own app until they sign in — and the answer has
 * to be right for FOUR kinds of install, not just Claude's. Kept out here it
 * can be tested with all three inputs faked; inside main.ts it could not be
 * tested at all, and a silent revert to the Claude-only question would lock a
 * ChatGPT-only install out on every launch with nothing green on the screen.
 *
 * ORDER IS LOAD-BEARING: the two local reads first, the `claude auth status`
 * subprocess last, so a signed-in ChatGPT account never pays for a spawn.
 */
export async function setupIsUsable(io: {
  /** Signed in to a ChatGPT plan. Read straight off ChatGptAuth (not the
   *  provider registry) so the kill switch, which removes the registry row,
   *  cannot lock a ChatGPT-only install out either. */
  isSignedIn: () => boolean;
  /** Any `ready` provider row — an OpenRouter key, a local model, etc. */
  hasUsableProvider: () => Promise<boolean>;
  /** `claude auth status`. Reports not-installed on any throw. */
  detectAuth: () => Promise<{ installed: boolean }>;
}): Promise<boolean> {
  if (io.isSignedIn()) return true;
  if (await io.hasUsableProvider()) return true;
  return (await io.detectAuth()).installed;
}

// ---------------------------------------------------------------------------
// FirstRunManager
// ---------------------------------------------------------------------------

export class FirstRunManager extends EventEmitter {
  private state: FirstRunState;
  private running = false;

  /**
   * Returns true if this is the first run (setup not yet completed).
   * Reads CONFIG_FILE; returns true if `setup_completed !== true` or file
   * doesn't exist.
   */
  static isFirstRun(): boolean {
    // If the first-run state machine already reached COMPLETE, skip
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (state.currentStep === 'COMPLETE') return false;
    } catch { /* no state file = fresh */ }

    // Check if the wizard has written setup_completed
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return config.setup_completed !== true;
    } catch {
      return true;
    }
  }

  constructor() {
    super();
    this.state = this.loadState();
  }

  /** Returns a shallow copy of the current state. */
  getState(): FirstRunState {
    return { ...this.state };
  }

  // -------------------------------------------------------------------------
  // Main entry point
  // -------------------------------------------------------------------------

  /** Start (or resume) the first-run flow. */
  async run(): Promise<void> {
    // Re-entrancy guard. run() auto-fires on launch AND is reachable from the
    // "Try Again" button (retry() → run()). Without this guard, a retry click
    // landing while the auto-run is mid-install spawns a SECOND installClaude(),
    // and the two native installers race on the same ~/.claude/downloads file →
    // "being used by another process". The `running` flag existed but was never
    // checked; this is the fix. (Root cause from a real failed install, 2026-05-30.)
    if (this.running) {
      log('INFO', 'first-run', 'run() ignored — flow already in progress');
      return;
    }
    this.running = true;
    // Clear a stale error from a prior attempt so the renderer doesn't render a
    // live (lastError-gated) "Try Again" button while this run is already
    // installing — second line of defense against the concurrent-install race.
    if (this.state.lastError) this.updateState({ lastError: undefined });
    try {
      // Check disk space first
      const disk = checkDiskSpace();
      if (!disk.sufficient) {
        this.updateState({
          lastError: `Insufficient disk space: ${disk.availableMB} MB available (need >= 500 MB)`,
        });
        this.running = false;
        return;
      }

      // If resuming at an interactive step (e.g., after app restart), re-run
      // detection to get accurate state rather than blindly replaying. Auth mode
      // is reset so the user sees the login button again instead of stale text.
      // LAUNCH_WIZARD is NOT re-detected — it means all prereqs already passed.
      // runStep('LAUNCH_WIZARD') emits the event and advances to COMPLETE.
      const step = this.state.currentStep;
      if (step === 'AUTHENTICATE' || step === 'ENABLE_DEVELOPER_MODE') {
        this.state.authMode = 'none';
        this.state.lastError = undefined;
        await this.detectAll();
      } else {
        await this.runStep(step);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('ERROR', 'first-run', 'Unexpected error in run()', { error: msg });
      this.updateState({ lastError: msg });
    } finally {
      this.running = false;
    }
  }

  // -------------------------------------------------------------------------
  // Step dispatcher
  // -------------------------------------------------------------------------

  private async runStep(step: FirstRunStep): Promise<void> {
    switch (step) {
      case 'DETECT_PREREQUISITES':
        await this.detectAll();
        break;
      case 'INSTALL_PREREQUISITES':
        await this.installMissing();
        break;
      case 'ENABLE_DEVELOPER_MODE':
        this.devModeStep();
        break;
      case 'AUTHENTICATE':
        this.updateState({ statusMessage: 'Sign in to continue' });
        this.updatePrereq('auth', { status: 'waiting' });
        break;
      case 'LAUNCH_WIZARD':
        this.updateState({ statusMessage: 'Launching setup wizard...' });
        this.emit('launch-wizard');
        // Mark first-run as complete so the next app launch skips straight to normal mode.
        // The setup wizard handles the rest (config.json setup_completed is written by the wizard).
        this.advanceTo('COMPLETE');
        break;
      case 'COMPLETE':
        // no-op
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  private async detectAll(): Promise<void> {
    // Node
    this.updatePrereq('node', { status: 'checking' });
    const nodeResult = await detectNode();
    this.updatePrereq('node', {
      status: nodeResult.installed ? 'installed' : 'waiting',
      version: nodeResult.version,
    });

    // Git
    this.updatePrereq('git', { status: 'checking' });
    const gitResult = await detectGit();
    this.updatePrereq('git', {
      status: gitResult.installed ? 'installed' : 'waiting',
      version: gitResult.version,
    });

    // Claude Code
    this.updatePrereq('claude', { status: 'checking' });
    const claudeResult = await detectClaude();
    this.updatePrereq('claude', {
      status: claudeResult.installed ? 'installed' : 'waiting',
      version: claudeResult.version,
    });

    // Auth
    const authResult = await detectAuth();
    if (authResult.installed) {
      this.updatePrereq('auth', { status: 'installed' });
      this.updateState({ authComplete: true });
    }

    // Windows Developer Mode
    const devModeEnabled = checkWindowsDevMode();
    this.updateState({ needsDevMode: !devModeEnabled });

    log('INFO', 'first-run', 'Detection complete');

    // Advance to installation step
    this.advanceTo('INSTALL_PREREQUISITES');
    await this.runStep('INSTALL_PREREQUISITES');
  }

  // -------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------

  private async installMissing(): Promise<void> {
    const installable: Array<{
      name: string;
      install: () => Promise<{ success: boolean; error?: string }>;
      detect: () => Promise<{ installed: boolean; version?: string }>;
      label: string;
    }> = [
      { name: 'node', install: installNode, detect: detectNode, label: 'Node.js' },
      { name: 'git', install: installGit, detect: detectGit, label: 'Git' },
      // WHY no Claude Code here (first-run local models, Q-5/F-4, Destin
      // 2026-09-14): it installs only when someone presses "Log in with Claude"
      // (handleOAuthLogin) or Install Claude Code in Settings. A local, ChatGPT or
      // API-key user never waits for it. Node and Git stay: Terminal view, the
      // bundled plugins, syncing and the Git panel need them for everyone.
    ];

    for (const { name, install, detect, label } of installable) {
      const prereq = this.state.prerequisites.find((p) => p.name === name);
      if (prereq?.status === 'installed') continue;

      // Re-detect before installing. The prerequisite may have appeared on
      // disk since detectAll() ran — the user installed it manually, or a
      // previous attempt partially succeeded. Without this, a retry blindly
      // re-runs install() and can fail again even though the tool is now
      // present. (This is exactly how a Linux user got permanently stuck on
      // the setup screen: installNode() had no Linux branch, so every retry
      // re-failed even after Node was installed out-of-band.)
      const preCheck = await detect();
      if (preCheck.installed) {
        this.updatePrereq(name, { status: 'installed', version: preCheck.version });
        log('INFO', 'first-run', `${label} already present — skipping install`);
        continue;
      }

      this.updatePrereq(name, { status: 'installing' });
      this.updateState({
        statusMessage: `Installing ${label}...`,
      });

      const result = await install();

      if (result.success) {
        // Re-detect to capture version
        const detection = await detect();
        this.updatePrereq(name, {
          status: 'installed',
          version: detection.version,
        });
        log('INFO', 'first-run', `${label} installed successfully`);
      } else {
        this.updatePrereq(name, {
          status: 'failed',
          error: result.error,
        });
        this.updateState({
          lastError: `Failed to install ${label}: ${result.error}`,
        });
        log('ERROR', 'first-run', `${label} installation failed`, {
          error: result.error,
        });
        return; // Stop on failure
      }
    }

    // Claude Code was not installed above; mark it so progress can reach the end
    // and the checklist does not wait on it (FirstRunView hides the row).
    const claude = this.state.prerequisites.find((p) => p.name === 'claude');
    if (claude && claude.status !== 'installed') this.updatePrereq('claude', { status: 'skipped' });

    // All installable prerequisites are now installed — advance to next step.
    // cloneToolkit() was removed: the app bundles write-guard via install-hooks.js;
    // legacy clones are cleaned up by legacy-cleanup.ts on first launch after upgrade.
    if (this.state.needsDevMode) {
      this.advanceTo('ENABLE_DEVELOPER_MODE');
      this.devModeStep();
    } else if (!this.state.authComplete) {
      this.advanceTo('AUTHENTICATE');
      this.updateState({ statusMessage: 'Sign in to continue' });
      this.updatePrereq('auth', { status: 'waiting' });
    } else {
      this.advanceTo('LAUNCH_WIZARD');
      this.updateState({ statusMessage: 'Launching setup wizard...' });
      this.emit('launch-wizard');
      this.advanceTo('COMPLETE');
    }
  }

  // -------------------------------------------------------------------------
  // Developer Mode
  // -------------------------------------------------------------------------

  private devModeStep(): void {
    this.updateState({
      statusMessage: 'Enable Windows Developer Mode to continue',
    });
    // Waits for IPC call to handleDevModeDone()
  }

  /** Called from IPC when the user triggers dev mode enablement. */
  async handleDevModeDone(): Promise<void> {
    const result = await enableWindowsDevMode();
    if (result.success) {
      this.updateState({ needsDevMode: false });
      log('INFO', 'first-run', 'Developer Mode enabled');

      if (!this.state.authComplete) {
        this.advanceTo('AUTHENTICATE');
        this.updateState({ statusMessage: 'Sign in to continue' });
        this.updatePrereq('auth', { status: 'waiting' });
      } else {
        this.advanceTo('LAUNCH_WIZARD');
        this.updateState({ statusMessage: 'Launching setup wizard...' });
        this.emit('launch-wizard');
        this.advanceTo('COMPLETE');
      }
    } else {
      this.updateState({
        lastError: `Failed to enable Developer Mode: ${result.error}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Authentication (IPC handlers)
  // -------------------------------------------------------------------------

  /** Called from IPC when the user chooses OAuth login. */
  async handleOAuthLogin(): Promise<{ url: string | null }> {
    this.updateState({ authMode: 'oauth', statusMessage: 'Waiting for you to log in...', lastError: undefined });
    this.updatePrereq('auth', { status: 'installing' });

    // First-run local models (S-1): Claude Code installs HERE, after the click,
    // not for everyone before the sign-in screen. The card shows this install
    // while the 'claude' row is installing.
    const present = await detectClaude();
    if (!present.installed) {
      this.updatePrereq('claude', { status: 'installing' });
      this.updateState({ statusMessage: 'Installing Claude Code...' });
      const installed = await installClaude();
      if (!installed.success) {
        this.updatePrereq('claude', { status: 'failed', error: installed.error });
        this.updatePrereq('auth', { status: 'waiting' });
        this.updateState({ authMode: 'none', lastError: `Failed to install Claude Code: ${installed.error}` });
        log('ERROR', 'first-run', 'Claude Code install failed', { error: installed.error });
        return { url: null };
      }
      const detection = await detectClaude();
      this.updatePrereq('claude', { status: 'installed', version: detection.version });
    }

    // Spawn the login process — it outputs the auth URL then waits for callback
    const oauth = startOAuthLogin();

    // Wait briefly for the URL to be captured from stdout
    await new Promise(r => setTimeout(r, 1500));
    const url = oauth.url;

    if (!url) {
      oauth.kill();
      this.updateState({ lastError: 'Could not get login URL from Claude Code.' });
      this.updatePrereq('auth', { status: 'failed', error: 'No login URL' });
      return { url: null };
    }

    log('INFO', 'first-run', 'OAuth URL captured, polling for auth completion');

    // Return the URL to the caller so it can open it via shell.openExternal()
    // Then poll in the background for auth completion
    void pollAuthStatus(120000, 2000).then((success) => {
      oauth.kill();
      if (success) {
        this.updateState({ authComplete: true });
        this.updatePrereq('auth', { status: 'installed' });
        log('INFO', 'first-run', 'OAuth login succeeded');
        this.advanceTo('LAUNCH_WIZARD');
        this.updateState({ statusMessage: 'Launching setup wizard...' });
        this.emit('launch-wizard');
        this.advanceTo('COMPLETE');
      } else {
        this.updateState({ authMode: 'none', lastError: 'Login timed out. Try again?' });
        this.updatePrereq('auth', { status: 'failed', error: 'Timed out' });
      }
    }).catch((err: unknown) => {
      // The poll itself failed (not "auth didn't complete"). Report the real
      // reason rather than leaving the user on a spinner — and never let it
      // escape as an unhandled rejection during first-run.
      oauth.kill();
      const detail = err instanceof Error ? err.message : String(err);
      log('ERROR', 'first-run', 'OAuth poll failed', { detail });
      this.updateState({ authMode: 'none', lastError: `Login check failed: ${detail}` });
      this.updatePrereq('auth', { status: 'failed', error: detail });
    });

    return { url };
  }

  /** Called from IPC when the user submits an API key. */
  async handleApiKeySubmit(key: string): Promise<void> {
    this.updateState({ authMode: 'apikey' });

    const result = await submitApiKey(key);
    if (result.success) {
      this.updateState({ authComplete: true });
      this.updatePrereq('auth', { status: 'installed' });
      log('INFO', 'first-run', 'API key authentication succeeded');
      this.advanceTo('LAUNCH_WIZARD');
      this.updateState({ statusMessage: 'Launching setup wizard...' });
      this.emit('launch-wizard');
      this.advanceTo('COMPLETE');
    } else {
      this.updateState({
        lastError: `API key authentication failed: ${result.error}`,
      });
      this.updatePrereq('auth', { status: 'failed', error: result.error });
    }
  }

  // -------------------------------------------------------------------------
  // Native ways in (first-run local models, 2026-09-14)
  // -------------------------------------------------------------------------

  /** The finish every native way in shares: signed in, remember the provider the
   *  renderer should make the new-session default, open the app. */
  private finishNativeSetup(fields: Partial<FirstRunState>): void {
    this.updateState({ ...fields, authComplete: true, lastError: undefined });
    this.updatePrereq('auth', { status: 'installed' });
    this.advanceTo('LAUNCH_WIZARD');
    this.updateState({ statusMessage: 'Launching setup wizard...' });
    this.emit('launch-wizard');
    this.advanceTo('COMPLETE');
  }

  /** "Use an API key" with a named service (F-1/F-2): the key goes to YouCoded's
   *  own assistant — the built-in OpenRouter row, or a direct-key provider row —
   *  and is tested before setup finishes. Claude Code is not involved.
   *  WHY no failed 'auth' row on a bad key: that would offer "Try Again", which
   *  re-runs the whole install pass; the key page stays open with the error. */
  async handleNativeApiKey(key: string, service: NativeKeyService, deps: FirstRunNativeDeps): Promise<void> {
    this.updateState({ authMode: 'apikey', lastError: undefined });
    if (!['anthropic', 'openai', 'google', 'openrouter'].includes(service)) {
      this.updateState({ lastError: 'That kind of key is not supported here.' });
      return;
    }
    try {
      let id = 'openrouter';
      if (service !== 'openrouter') {
        const existing = (await deps.providers.list()).find((p) => p.type === service);
        id = existing?.id ?? await deps.providers.upsert({ type: service, label: NATIVE_KEY_LABEL[service], enabled: true });
      }
      await deps.providers.setKey(id, key.trim());
      const check = await deps.providers.testConnection(id);
      if (!check.ok) {
        this.updateState({ lastError: `Couldn't verify the key: ${check.message}` });
        return;
      }
      log('INFO', 'first-run', 'API key setup succeeded', { service });
      this.finishNativeSetup({ setupProvider: id });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log('ERROR', 'first-run', 'API key setup failed', { service, detail });
      this.updateState({ lastError: `Couldn't save the key: ${detail}` });
    }
  }

  /** "Use an app on this computer": add the app as an OpenAI-compatible provider,
   *  check it answers, then finish. The answer goes back to the screen, which
   *  shows the failure in place — and a provider that never answered is removed
   *  again, so a typo does not leave a dead entry in Settings. */
  async handleConnectLocalApp(baseUrl: string, name: string, deps: FirstRunNativeDeps): Promise<{ ok: boolean; message?: string }> {
    const url = String(baseUrl ?? '').trim();
    const label = /^https?:\/\//i.test(name) ? 'Local endpoint' : name;
    let id: string | null = null;
    let created = false;
    try {
      const existing = (await deps.providers.list()).find((p) => p.type === 'openai-compatible' && p.baseUrl === url);
      if (existing) id = existing.id;
      else { id = await deps.providers.upsert({ type: 'openai-compatible', label, baseUrl: url, enabled: true }); created = true; }
      const check = await deps.providers.testConnection(id);
      if (!check.ok) {
        if (created) await deps.providers.remove(id).catch(() => { /* best effort */ });
        return { ok: false, message: `Couldn't connect to ${label}: ${check.message}` };
      }
      log('INFO', 'first-run', 'Connected to a local model app', { label });
      this.finishNativeSetup({ authMode: 'local', setupProvider: id });
      return { ok: true };
    } catch (err) {
      if (id && created) await deps.providers.remove(id).catch(() => { /* best effort */ });
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Couldn't connect to ${label}: ${detail}` };
    }
  }

  private setupDownloadClaimed = false;

  /** A download started from the local setup card finishes setup (Q-2/Q-4): the
   *  app opens at once and keeps downloading, the band above the message box
   *  reports it (the record written here), and the model runner installs in the
   *  background if it is not there yet. Only while the sign-in step is showing,
   *  and only the first download. */
  async handleSetupDownloadProgress(p: DownloadProgress, deps: FirstRunNativeDeps): Promise<void> {
    if (this.setupDownloadClaimed || this.state.currentStep !== 'AUTHENTICATE' || p.state !== 'downloading') return;
    this.setupDownloadClaimed = true;
    let label = p.repo.split('/').pop() ?? p.repo;
    try {
      const curated = (await deps.models.curatedList()).find((m) => m.hfRepo === p.repo);
      if (curated) label = curated.label;
    } catch { /* the repo name is a fine label */ }
    try {
      writeSetupDownload(STATE_DIR, { repo: p.repo, quant: p.quant, label, startedAt: Date.now() });
    } catch (err) {
      log('WARN', 'first-run', 'Could not record the setup download', { error: String(err) });
    }
    if (!deps.engine.installed()) {
      void deps.engine.install().catch((err) => log('WARN', 'first-run', 'Model runner install failed', { error: String(err) }));
    }
    log('INFO', 'first-run', 'Local model download started — finishing setup', { repo: p.repo, quant: p.quant });
    this.finishNativeSetup({ authMode: 'local', setupProvider: 'local' });
  }

  /** Called from IPC when the user chooses "Log in with ChatGPT" (design §5).
   *  Opens the browser through ChatGptAuth, then waits for OpenAI's callback,
   *  a timeout or an error. Never sees a token: the account machine stores it,
   *  this only learns the outcome word. */
  async handleChatGptLogin(auth: ChatGptSignInAuth): Promise<void> {
    this.updateState({ authMode: 'chatgpt', statusMessage: 'Waiting for you to sign in…' });
    this.updatePrereq('auth', { status: 'installing' });

    // signIn() THROWS for two verified causes — the keychain is unavailable, or
    // another program holds port 1455. Both first-run IPC handlers in main.ts
    // swallow throws, so without this catch the button would silently do
    // nothing (review R3-3). The thrown sentence is shown verbatim: it is the
    // account machine's own accurate text, never a guess.
    try {
      await auth.signIn({ timeoutMs: CHATGPT_FIRST_RUN_TIMEOUT_MS });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log('ERROR', 'first-run', 'ChatGPT sign-in could not start', { detail });
      this.updateState({ authMode: 'none', lastError: detail });
      this.updatePrereq('auth', { status: 'failed', error: detail });
      return;
    }

    log('INFO', 'first-run', 'ChatGPT sign-in page opened, waiting for the callback');
    const outcome = await auth.waitForSignIn();

    if (outcome === 'signed-in') {
      // Same closing moves as handleOAuthLogin's success path. authMode stays
      // 'chatgpt' on purpose: the renderer's completion path reads it to make
      // the next new session default to the ChatGPT plan (design §5).
      // lastError is cleared here: a failed first attempt (a timeout, or the
      // OpenRouter "not built yet" line) must not leave its red message on
      // screen under a sign-in that then worked.
      this.updateState({ authComplete: true, lastError: undefined });
      this.updatePrereq('auth', { status: 'installed' });
      log('INFO', 'first-run', 'ChatGPT sign-in succeeded');
      this.advanceTo('LAUNCH_WIZARD');
      this.updateState({ statusMessage: 'Launching setup wizard...' });
      this.emit('launch-wizard');
      this.advanceTo('COMPLETE');
      return;
    }

    // Every other outcome puts the three buttons back with one line under
    // them. The { error } text is the account machine's own (OpenAI's
    // error_description or the store's message) — shown as-is.
    const lastError =
      outcome === 'timed-out' ? 'Sign-in timed out. Try again?'
      : outcome === 'cancelled' ? 'Sign-in was cancelled.'
      : outcome.error;
    const reason =
      outcome === 'timed-out' ? 'Timed out'
      : outcome === 'cancelled' ? 'Cancelled'
      : outcome.error;
    log('WARN', 'first-run', 'ChatGPT sign-in did not complete', { reason });
    this.updateState({ authMode: 'none', lastError });
    this.updatePrereq('auth', { status: 'failed', error: reason });
  }

  /** Called from IPC when the user chooses "Log in with OpenRouter". The
   *  button is on the approved card but its sign-in is not built yet (spec
   *  2026-08-31-openrouter-connection-trust-design.md); a button that does
   *  nothing was review R1-6, so it answers with this one line (design §9.5). */
  handleOpenRouterNotBuilt(): void {
    this.updateState({
      authMode: 'none',
      lastError: 'OpenRouter sign-in is coming in a later update.',
    });
  }

  // -------------------------------------------------------------------------
  // Retry / Reset
  // -------------------------------------------------------------------------

  /** Clear errors, reset failed prerequisites to 'waiting', and re-run. */
  async retry(): Promise<void> {
    this.updateState({ lastError: undefined });

    for (const prereq of this.state.prerequisites) {
      if (prereq.status === 'failed') {
        this.updatePrereq(prereq.name, { status: 'waiting', error: undefined });
      }
    }

    await this.run();
  }

  /** Full reset to default state. */
  reset(): void {
    this.state = this.defaultState();
    this.saveState();
    this.emitState();
  }

  /** Mark first-run as complete (used by the "skip setup" button). */
  skip(): void {
    this.advanceTo('COMPLETE');
  }

  /** Force the state machine to a specific step (e.g., re-trigger auth from normal mode) */
  forceStep(step: FirstRunStep): void {
    this.state = this.defaultState();
    this.state.currentStep = step;
    // Mark all prereqs before this step as installed since they passed detection
    if (step === 'AUTHENTICATE' || step === 'LAUNCH_WIZARD') {
      for (const p of this.state.prerequisites) {
        if (p.name !== 'auth') p.status = 'installed';
      }
      this.state.overallProgress = 72;
      this.state.statusMessage = 'Sign in to continue';
    }
    this.saveState();
    this.emitState();
  }

  // -------------------------------------------------------------------------
  // Private — state management
  // -------------------------------------------------------------------------

  private advanceTo(step: FirstRunStep): void {
    this.state.currentStep = step;
    this.saveState();
    this.emitState();
  }

  private updateState(updates: Partial<FirstRunState>): void {
    Object.assign(this.state, updates);
    this.saveState();
    this.emitState();
  }

  private updatePrereq(
    name: string,
    updates: Partial<{ status: string; version?: string; error?: string }>,
  ): void {
    const prereq = this.state.prerequisites.find((p) => p.name === name);
    if (!prereq) return;

    Object.assign(prereq, updates);

    // Recalculate overall progress: (installed count / total) * 90, capped at 90
    const total = this.state.prerequisites.length;
    const installed = this.state.prerequisites.filter(
      (p) => p.status === 'installed',
    ).length;
    this.state.overallProgress = Math.min(
      Math.round((installed / total) * 90),
      90,
    );

    this.saveState();
    this.emitState();
  }

  private emitState(): void {
    this.emit('state-changed', this.getState());
  }

  private loadState(): FirstRunState {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(raw) as FirstRunState;
    } catch {
      return this.defaultState();
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      log('WARN', 'first-run', 'Failed to save state', {
        error: String(err),
      });
    }
  }

  private defaultState(): FirstRunState {
    return {
      currentStep: 'DETECT_PREREQUISITES',
      prerequisites: INITIAL_PREREQUISITES.map((p) => ({ ...p })),
      overallProgress: 0,
      statusMessage: 'Checking your system...',
      authMode: 'none',
      authComplete: false,
      needsDevMode: false,
    };
  }
}
