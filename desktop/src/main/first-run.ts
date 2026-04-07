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
  detectToolkit,
  detectAuth,
  installNode,
  installGit,
  installClaude,
  cloneToolkit,
  startOAuthLogin,
  pollAuthStatus,
  submitApiKey,
  checkDiskSpace,
  checkWindowsDevMode,
  enableWindowsDevMode,
} from './prerequisite-installer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = path.join(os.homedir(), '.claude', 'toolkit-state');
const STATE_FILE = path.join(STATE_DIR, 'first-run-state.json');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

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
    this.running = true;
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
      case 'CLONE_TOOLKIT':
        await this.cloneToolkitStep();
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

    // Toolkit
    this.updatePrereq('toolkit', { status: 'checking' });
    const toolkitResult = await detectToolkit();
    this.updatePrereq('toolkit', {
      status: toolkitResult.installed ? 'installed' : 'waiting',
      version: toolkitResult.version,
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
      { name: 'claude', install: installClaude, detect: detectClaude, label: 'Claude Code' },
    ];

    for (const { name, install, detect, label } of installable) {
      const prereq = this.state.prerequisites.find((p) => p.name === name);
      if (prereq?.status === 'installed') continue;

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

    // All installable prerequisites are now installed — advance to toolkit
    this.advanceTo('CLONE_TOOLKIT');
    await this.runStep('CLONE_TOOLKIT');
  }

  // -------------------------------------------------------------------------
  // Toolkit
  // -------------------------------------------------------------------------

  private async cloneToolkitStep(): Promise<void> {
    const toolkitPrereq = this.state.prerequisites.find((p) => p.name === 'toolkit');
    if (toolkitPrereq?.status === 'installed') {
      this.advanceAfterToolkit();
      return;
    }

    this.updatePrereq('toolkit', { status: 'installing' });
    this.updateState({ statusMessage: 'Cloning DestinClaude toolkit...' });

    const result = await cloneToolkit();

    if (result.success) {
      // Verify by re-detecting
      const detection = await detectToolkit();
      this.updatePrereq('toolkit', {
        status: detection.installed ? 'installed' : 'failed',
        version: detection.version,
        error: detection.installed ? undefined : 'Toolkit not found after clone',
      });

      if (detection.installed) {
        log('INFO', 'first-run', 'Toolkit cloned and verified');
        this.advanceAfterToolkit();
      } else {
        this.updateState({ lastError: 'Toolkit not found after clone' });
      }
    } else {
      this.updatePrereq('toolkit', { status: 'failed', error: result.error });
      this.updateState({ lastError: `Failed to clone toolkit: ${result.error}` });
    }
  }

  private advanceAfterToolkit(): void {
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
    this.updateState({ authMode: 'oauth', statusMessage: 'Waiting for you to log in...' });
    this.updatePrereq('auth', { status: 'installing' });

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
    pollAuthStatus(120000, 2000).then((success) => {
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
