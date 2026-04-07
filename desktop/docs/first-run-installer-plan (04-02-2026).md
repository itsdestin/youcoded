# First-Run Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the terminal-based bootstrap with a GUI-driven first-run experience in the DestinCode desktop app, so non-technical users never open a terminal.

**Architecture:** New first-run state machine (`first-run.ts`) orchestrates prerequisite detection/installation from Electron's main process. A new `FirstRunView.tsx` renders progress UI in the renderer. IPC channels bridge state updates. On completion, a Claude Code session auto-launches with the setup wizard.

**Tech Stack:** Electron (main process), React + Tailwind (renderer), `which` (PATH resolution), `child_process` (silent installs), existing `SessionManager` for wizard handoff.

**Design doc:** `desktop/docs/first-run-installer-design (04-02-2026).md`

**Security note:** This plan uses `execFile` (array args, no shell) for all commands except platform package manager invocations (`winget`, `installer`, `xcode-select`) where shell features are needed with hardcoded commands only. No user input is ever interpolated into shell strings.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/first-run.ts` | State machine: detection, orchestration, state persistence |
| `src/main/prerequisite-installer.ts` | Platform-specific detection & silent install logic |
| `src/shared/first-run-types.ts` | Shared types for first-run state (used by main + renderer) |
| `src/renderer/components/FirstRunView.tsx` | Progress UI: checklist, progress bar, auth screen, transitions |
| `src/main/main.ts` | Modified: check first-run state before creating window |
| `src/main/ipc-handlers.ts` | Modified: register first-run IPC channels |
| `src/main/preload.ts` | Modified: expose first-run IPC to renderer |
| `src/shared/types.ts` | Modified: add first-run IPC channel constants |
| `src/renderer/App.tsx` | Modified: conditionally render FirstRunView vs normal app |
| `core/skills/setup-wizard/SKILL.md` | Modified: remove Homebrew pre-installed assumption |

---

### Task 1: Shared Types for First-Run State

**Files:**
- Create: `src/shared/first-run-types.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Create the first-run types file**

```typescript
// src/shared/first-run-types.ts

export type FirstRunStep =
  | 'DETECT_PREREQUISITES'
  | 'INSTALL_PREREQUISITES'
  | 'CLONE_TOOLKIT'
  | 'ENABLE_DEVELOPER_MODE'
  | 'AUTHENTICATE'
  | 'LAUNCH_WIZARD'
  | 'COMPLETE';

export type PrerequisiteStatus = 'waiting' | 'checking' | 'installing' | 'installed' | 'failed' | 'skipped';

export interface PrerequisiteState {
  name: string;
  displayName: string;
  status: PrerequisiteStatus;
  version?: string;
  error?: string;
}

export interface FirstRunState {
  currentStep: FirstRunStep;
  prerequisites: PrerequisiteState[];
  overallProgress: number; // 0-100
  statusMessage: string;
  /** Auth mode the user is currently in */
  authMode: 'none' | 'oauth' | 'apikey';
  /** Whether auth completed successfully */
  authComplete: boolean;
  /** Error from the most recent failed step */
  lastError?: string;
  /** Whether Windows Developer Mode needs enabling */
  needsDevMode: boolean;
}

export const INITIAL_PREREQUISITES: PrerequisiteState[] = [
  { name: 'node', displayName: 'Node.js', status: 'waiting' },
  { name: 'git', displayName: 'Git', status: 'waiting' },
  { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
  { name: 'toolkit', displayName: 'DestinClaude Toolkit', status: 'waiting' },
  { name: 'auth', displayName: 'Sign in', status: 'waiting' },
];
```

- [ ] **Step 2: Add first-run IPC channels to shared types**

In `src/shared/types.ts`, add these entries to the `IPC` constant object, after the `SESSION_RESUME` line:

```typescript
  // First-run
  FIRST_RUN_STATE: 'first-run:state',
  FIRST_RUN_RETRY: 'first-run:retry',
  FIRST_RUN_START_AUTH: 'first-run:start-auth',
  FIRST_RUN_SUBMIT_API_KEY: 'first-run:submit-api-key',
  FIRST_RUN_DEV_MODE_DONE: 'first-run:dev-mode-done',
  FIRST_RUN_SKIP: 'first-run:skip',
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/first-run-types.ts src/shared/types.ts
git commit -m "feat(first-run): add shared types for first-run state machine"
```

---

### Task 2: Prerequisite Installer Module

**Files:**
- Create: `src/main/prerequisite-installer.ts`

This module handles detecting and silently installing Node.js, Git, and Claude Code CLI on both Windows and macOS. Uses `execFile` (no shell) for all detection commands. Platform install commands use hardcoded strings only — no user input is interpolated.

- [ ] **Step 1: Create the prerequisite installer**

```typescript
// src/main/prerequisite-installer.ts

import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { log } from './logger';

const execFileAsync = promisify(execFile);

let whichSync: ((cmd: string) => string) | null = null;
try { const w = require('which'); whichSync = w.sync; } catch {}

export interface DetectionResult {
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}

/**
 * Re-resolve PATH from the system after an install.
 * On Windows, winget installs update the registry but not the current process PATH.
 */
function refreshPath(): void {
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      // Read User PATH from registry
      const userPath = execSync(
        'reg query "HKCU\\Environment" /v PATH',
        { encoding: 'utf8', timeout: 5000 }
      );
      const userMatch = userPath.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);

      // Read System PATH from registry
      const sysPath = execSync(
        'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v PATH',
        { encoding: 'utf8', timeout: 5000 }
      );
      const sysMatch = sysPath.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);

      if (userMatch || sysMatch) {
        const parts: string[] = [];
        if (sysMatch) parts.push(sysMatch[1].trim());
        if (userMatch) parts.push(userMatch[1].trim());
        process.env.PATH = parts.join(path.delimiter);
      }
    } catch (e) {
      log('WARN', 'PrereqInstaller', 'Failed to refresh PATH from registry', { error: String(e) });
    }
  }
  // macOS/Linux: PATH is inherited from shell profile, but Electron launched from Finder
  // may not have it. main.ts already prepends common paths at startup.
}

function resolveCommand(cmd: string): string {
  try {
    if (whichSync) return whichSync(cmd);
  } catch {}
  return cmd;
}

// --- Detection (all use execFile, no shell) ---

export async function detectNode(): Promise<DetectionResult> {
  try {
    const nodePath = resolveCommand('node');
    const { stdout } = await execFileAsync(nodePath, ['--version'], { timeout: 10000 });
    const version = stdout.trim();
    const major = parseInt(version.replace('v', '').split('.')[0], 10);
    if (major < 18) {
      return { installed: false, version, error: `Node.js ${version} is too old (need v18+)` };
    }
    return { installed: true, version, path: nodePath };
  } catch {
    return { installed: false };
  }
}

export async function detectGit(): Promise<DetectionResult> {
  try {
    const gitPath = resolveCommand('git');
    const { stdout } = await execFileAsync(gitPath, ['--version'], { timeout: 10000 });
    return { installed: true, version: stdout.trim(), path: gitPath };
  } catch {
    return { installed: false };
  }
}

export async function detectClaude(): Promise<DetectionResult> {
  try {
    const claudePath = resolveCommand('claude');
    const { stdout } = await execFileAsync(claudePath, ['--version'], { timeout: 10000 });
    return { installed: true, version: stdout.trim(), path: claudePath };
  } catch {
    return { installed: false };
  }
}

export async function detectToolkit(): Promise<DetectionResult> {
  const toolkitPath = path.join(os.homedir(), '.claude', 'plugins', 'destinclaude');
  const versionFile = path.join(toolkitPath, 'VERSION');
  try {
    const version = fs.readFileSync(versionFile, 'utf8').trim();
    return { installed: true, version, path: toolkitPath };
  } catch {
    return { installed: false };
  }
}

export async function detectAuth(): Promise<DetectionResult> {
  try {
    const claudePath = resolveCommand('claude');
    await execFileAsync(claudePath, ['auth', 'status'], { timeout: 10000 });
    return { installed: true };
  } catch {
    return { installed: false };
  }
}

// --- Installation ---
// Platform install commands use hardcoded strings — no user input interpolated.

export async function installNode(): Promise<{ success: boolean; error?: string }> {
  log('INFO', 'PrereqInstaller', 'Installing Node.js');
  try {
    if (process.platform === 'win32') {
      await execFileAsync('winget', [
        'install', 'OpenJS.NodeJS.LTS',
        '--silent', '--accept-package-agreements', '--accept-source-agreements',
      ], { timeout: 300000 });
    } else if (process.platform === 'darwin') {
      // Download and install the official Node.js .pkg
      const pkgUrl = 'https://nodejs.org/dist/v20.19.0/node-v20.19.0.pkg';
      const tmpPkg = path.join(os.tmpdir(), 'node-installer.pkg');
      await downloadFile(pkgUrl, tmpPkg);
      await execFileAsync('installer', ['-pkg', tmpPkg, '-target', 'CurrentUserHomeDirectory'], {
        timeout: 120000,
      });
      try { fs.unlinkSync(tmpPkg); } catch {}
    }
    refreshPath();
    const result = await detectNode();
    if (!result.installed) {
      return { success: false, error: 'Installation completed but node is not on PATH. You may need to restart the app.' };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

export async function installGit(): Promise<{ success: boolean; error?: string }> {
  log('INFO', 'PrereqInstaller', 'Installing Git');
  try {
    if (process.platform === 'win32') {
      await execFileAsync('winget', [
        'install', 'Git.Git',
        '--silent', '--accept-package-agreements', '--accept-source-agreements',
      ], { timeout: 300000 });
    } else if (process.platform === 'darwin') {
      // Trigger Xcode CLT install prompt
      try {
        await execFileAsync('xcode-select', ['--install'], { timeout: 600000 });
      } catch {
        // xcode-select --install returns non-zero if CLT already installed or user
        // needs to click through a GUI dialog. Both are fine.
      }
    }
    refreshPath();
    const result = await detectGit();
    if (!result.installed) {
      return { success: false, error: 'Git installation may require you to complete the system dialog. Click "Try Again" once done.' };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

export async function installClaude(): Promise<{ success: boolean; error?: string }> {
  log('INFO', 'PrereqInstaller', 'Installing Claude Code CLI');
  try {
    const npmPath = resolveCommand('npm');
    await execFileAsync(npmPath, ['install', '-g', '@anthropic-ai/claude-code'], {
      timeout: 300000,
    });
    refreshPath();
    const result = await detectClaude();
    if (!result.installed) {
      return { success: false, error: 'npm install completed but claude is not on PATH' };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

export async function cloneToolkit(): Promise<{ success: boolean; error?: string }> {
  const targetDir = path.join(os.homedir(), '.claude', 'plugins', 'destinclaude');
  if (fs.existsSync(path.join(targetDir, 'VERSION'))) {
    return { success: true };
  }
  log('INFO', 'PrereqInstaller', 'Cloning toolkit');
  try {
    const gitPath = resolveCommand('git');
    fs.mkdirSync(path.join(os.homedir(), '.claude', 'plugins'), { recursive: true });
    await execFileAsync(gitPath, [
      'clone', 'https://github.com/itsdestin/destinclaude.git', targetDir,
    ], { timeout: 300000 });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

export async function startOAuthLogin(): Promise<{ success: boolean; error?: string }> {
  try {
    const claudePath = resolveCommand('claude');
    await execFileAsync(claudePath, ['login'], { timeout: 120000 });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

export async function submitApiKey(key: string): Promise<{ success: boolean; error?: string }> {
  try {
    const claudePath = resolveCommand('claude');
    // Pass key as array arg — no shell interpolation
    await execFileAsync(claudePath, ['auth', 'set-key', key], { timeout: 15000 });
    const result = await detectAuth();
    if (!result.installed) {
      return { success: false, error: 'API key was saved but auth check failed' };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

export function checkDiskSpace(): { sufficient: boolean; availableMB: number } {
  try {
    const home = os.homedir();
    const stats = fs.statfsSync(home);
    const availableMB = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
    return { sufficient: availableMB >= 500, availableMB };
  } catch {
    return { sufficient: true, availableMB: -1 };
  }
}

export function checkWindowsDevMode(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    const { execSync } = require('child_process');
    const stdout = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense',
      { encoding: 'utf8', timeout: 5000 }
    );
    return stdout.includes('0x1');
  } catch {
    return false;
  }
}

export async function enableWindowsDevMode(): Promise<{ success: boolean; error?: string }> {
  try {
    // Elevate via PowerShell to write the registry key
    await execFileAsync('powershell', [
      '-Command',
      "Start-Process reg -ArgumentList 'add','HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock','/v','AllowDevelopmentWithoutDevLicense','/t','REG_DWORD','/d','1','/f' -Verb RunAs -Wait",
    ], { timeout: 60000 });
    return { success: checkWindowsDevMode() };
  } catch (e: any) {
    return { success: false, error: 'Developer Mode could not be enabled. Please enable it manually: Settings > System > For Developers > Developer Mode' };
  }
}

// --- Utility ---

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        downloadFile(response.headers.location!, dest).then(resolve, reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/prerequisite-installer.ts
git commit -m "feat(first-run): add prerequisite detection and silent install module"
```

---

### Task 3: First-Run State Machine

**Files:**
- Create: `src/main/first-run.ts`

This is the orchestrator that drives the entire first-run flow.

- [ ] **Step 1: Create the first-run state machine**

```typescript
// src/main/first-run.ts

import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { log } from './logger';
import {
  FirstRunState,
  FirstRunStep,
  PrerequisiteState,
  INITIAL_PREREQUISITES,
} from '../shared/first-run-types';
import {
  detectNode, detectGit, detectClaude, detectToolkit, detectAuth,
  installNode, installGit, installClaude, cloneToolkit,
  startOAuthLogin, submitApiKey,
  checkDiskSpace, checkWindowsDevMode, enableWindowsDevMode,
} from './prerequisite-installer';

const STATE_DIR = path.join(os.homedir(), '.claude', 'toolkit-state');
const STATE_FILE = path.join(STATE_DIR, 'first-run-state.json');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

export class FirstRunManager extends EventEmitter {
  private state: FirstRunState;
  private running = false;

  constructor() {
    super();
    this.state = this.loadState();
  }

  /** Check if first-run is needed */
  static isFirstRun(): boolean {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return config.setup_completed !== true;
    } catch {
      return true; // No config = fresh install
    }
  }

  getState(): FirstRunState {
    return { ...this.state };
  }

  /** Start or resume the first-run flow */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log('INFO', 'FirstRun', 'Starting first-run flow', { step: this.state.currentStep });

    try {
      // Check disk space first
      const disk = checkDiskSpace();
      if (!disk.sufficient) {
        this.updateState({
          lastError: `Not enough disk space. You need at least 500 MB free (you have ${disk.availableMB} MB).`,
        });
        this.running = false;
        return;
      }

      await this.runStep(this.state.currentStep);
    } catch (e: any) {
      log('ERROR', 'FirstRun', 'Unexpected error', { error: String(e) });
      this.updateState({ lastError: e.message || String(e) });
    }

    this.running = false;
  }

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
        await this.devModeStep();
        break;
      case 'AUTHENTICATE':
        // Auth requires user interaction — stop here and wait for IPC
        this.updateState({
          currentStep: 'AUTHENTICATE',
          statusMessage: 'Sign in to continue',
        });
        this.updatePrereq('auth', { status: 'waiting' });
        break;
      case 'LAUNCH_WIZARD':
        this.updateState({
          currentStep: 'LAUNCH_WIZARD',
          overallProgress: 95,
          statusMessage: 'Starting your setup...',
        });
        this.emit('launch-wizard');
        break;
      case 'COMPLETE':
        break;
    }
  }

  private async detectAll(): Promise<void> {
    this.updateState({
      currentStep: 'DETECT_PREREQUISITES',
      statusMessage: 'Checking your system...',
      overallProgress: 5,
    });

    for (const prereq of ['node', 'git', 'claude', 'toolkit'] as const) {
      this.updatePrereq(prereq, { status: 'checking' });

      const result = prereq === 'node' ? await detectNode()
        : prereq === 'git' ? await detectGit()
        : prereq === 'claude' ? await detectClaude()
        : await detectToolkit();

      if (result.installed) {
        this.updatePrereq(prereq, { status: 'installed', version: result.version });
      } else {
        this.updatePrereq(prereq, { status: 'waiting', error: result.error });
      }
    }

    // Check auth
    const authResult = await detectAuth();
    if (authResult.installed) {
      this.updatePrereq('auth', { status: 'installed' });
      this.state.authComplete = true;
    }

    // Check Windows Developer Mode
    if (process.platform === 'win32') {
      this.state.needsDevMode = !checkWindowsDevMode();
    }

    this.advanceTo('INSTALL_PREREQUISITES');
    await this.runStep('INSTALL_PREREQUISITES');
  }

  private async installMissing(): Promise<void> {
    const prereqs = this.state.prerequisites;

    // Install Node.js if missing
    const node = prereqs.find(p => p.name === 'node')!;
    if (node.status !== 'installed') {
      this.updatePrereq('node', { status: 'installing' });
      this.updateState({ statusMessage: 'Installing Node.js...', overallProgress: 15 });

      const result = await installNode();
      if (result.success) {
        const detect = await detectNode();
        this.updatePrereq('node', { status: 'installed', version: detect.version });
      } else {
        this.updatePrereq('node', { status: 'failed', error: result.error });
        this.updateState({ lastError: `Node.js installation failed: ${result.error}` });
        return; // Can't continue without Node
      }
    }

    // Install Git if missing
    const git = prereqs.find(p => p.name === 'git')!;
    if (git.status !== 'installed') {
      this.updatePrereq('git', { status: 'installing' });
      this.updateState({ statusMessage: 'Installing Git...', overallProgress: 30 });

      const result = await installGit();
      if (result.success) {
        const detect = await detectGit();
        this.updatePrereq('git', { status: 'installed', version: detect.version });
      } else {
        this.updatePrereq('git', { status: 'failed', error: result.error });
        this.updateState({ lastError: `Git installation failed: ${result.error}` });
        return;
      }
    }

    // Install Claude Code CLI if missing
    const claude = prereqs.find(p => p.name === 'claude')!;
    if (claude.status !== 'installed') {
      this.updatePrereq('claude', { status: 'installing' });
      this.updateState({ statusMessage: 'Installing Claude Code...', overallProgress: 45 });

      const result = await installClaude();
      if (result.success) {
        const detect = await detectClaude();
        this.updatePrereq('claude', { status: 'installed', version: detect.version });
      } else {
        this.updatePrereq('claude', { status: 'failed', error: result.error });
        this.updateState({ lastError: `Claude Code installation failed: ${result.error}` });
        return;
      }
    }

    this.advanceTo('CLONE_TOOLKIT');
    await this.runStep('CLONE_TOOLKIT');
  }

  private async cloneToolkitStep(): Promise<void> {
    const toolkit = this.state.prerequisites.find(p => p.name === 'toolkit')!;
    if (toolkit.status === 'installed') {
      this.advanceAfterToolkit();
      return;
    }

    this.updatePrereq('toolkit', { status: 'installing' });
    this.updateState({ statusMessage: 'Downloading DestinClaude Toolkit...', overallProgress: 60 });

    const result = await cloneToolkit();
    if (result.success) {
      const detect = await detectToolkit();
      this.updatePrereq('toolkit', { status: 'installed', version: detect.version });
      this.advanceAfterToolkit();
    } else {
      this.updatePrereq('toolkit', { status: 'failed', error: result.error });
      this.updateState({ lastError: `Toolkit download failed: ${result.error}` });
    }
  }

  private advanceAfterToolkit(): void {
    if (this.state.needsDevMode) {
      this.advanceTo('ENABLE_DEVELOPER_MODE');
      this.runStep('ENABLE_DEVELOPER_MODE');
    } else if (!this.state.authComplete) {
      this.advanceTo('AUTHENTICATE');
      this.runStep('AUTHENTICATE');
    } else {
      this.advanceTo('LAUNCH_WIZARD');
      this.runStep('LAUNCH_WIZARD');
    }
  }

  private async devModeStep(): Promise<void> {
    this.updateState({
      currentStep: 'ENABLE_DEVELOPER_MODE',
      statusMessage: 'Windows needs a one-time permission for symlinks',
      overallProgress: 70,
    });
    // Wait for user to click the button (handled via IPC)
  }

  /** Called from IPC when user confirms Developer Mode */
  async handleDevModeDone(): Promise<void> {
    const result = await enableWindowsDevMode();
    if (result.success || checkWindowsDevMode()) {
      this.state.needsDevMode = false;
      if (!this.state.authComplete) {
        this.advanceTo('AUTHENTICATE');
        await this.runStep('AUTHENTICATE');
      } else {
        this.advanceTo('LAUNCH_WIZARD');
        await this.runStep('LAUNCH_WIZARD');
      }
    } else {
      this.updateState({
        lastError: result.error || 'Developer Mode is still disabled. Enable it in Settings > System > For Developers, then click Try Again.',
      });
    }
  }

  /** Called from IPC when user clicks "Log in with Claude" */
  async handleOAuthLogin(): Promise<void> {
    this.updateState({ authMode: 'oauth', statusMessage: 'Waiting for you to log in...' });
    this.updatePrereq('auth', { status: 'installing' });

    const result = await startOAuthLogin();
    if (result.success) {
      this.updatePrereq('auth', { status: 'installed' });
      this.state.authComplete = true;
      this.advanceTo('LAUNCH_WIZARD');
      await this.runStep('LAUNCH_WIZARD');
    } else {
      this.updatePrereq('auth', { status: 'failed', error: 'Login not completed. Try again?' });
      this.updateState({ authMode: 'none', lastError: result.error });
    }
  }

  /** Called from IPC when user submits an API key */
  async handleApiKeySubmit(key: string): Promise<void> {
    this.updateState({ authMode: 'apikey', statusMessage: 'Verifying API key...' });
    this.updatePrereq('auth', { status: 'installing' });

    const result = await submitApiKey(key);
    if (result.success) {
      this.updatePrereq('auth', { status: 'installed' });
      this.state.authComplete = true;
      this.advanceTo('LAUNCH_WIZARD');
      await this.runStep('LAUNCH_WIZARD');
    } else {
      this.updatePrereq('auth', { status: 'failed', error: result.error });
      this.updateState({ authMode: 'apikey', lastError: "That key didn't work. Double-check it and try again." });
    }
  }

  /** Called from IPC to retry from the current step */
  async retry(): Promise<void> {
    this.updateState({ lastError: undefined });
    for (const p of this.state.prerequisites) {
      if (p.status === 'failed') p.status = 'waiting';
    }
    this.emitState();
    await this.run();
  }

  /** Called from IPC to reset the entire first-run state */
  reset(): void {
    this.state = this.defaultState();
    this.saveState();
    this.emitState();
  }

  // --- State management ---

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

  private updatePrereq(name: string, updates: Partial<PrerequisiteState>): void {
    const prereq = this.state.prerequisites.find(p => p.name === name);
    if (prereq) {
      Object.assign(prereq, updates);
      const installed = this.state.prerequisites.filter(p => p.status === 'installed').length;
      this.state.overallProgress = Math.min(90, Math.floor((installed / this.state.prerequisites.length) * 90));
      this.emitState();
    }
  }

  private emitState(): void {
    this.emit('state-changed', this.getState());
  }

  private loadState(): FirstRunState {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      return this.defaultState();
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      log('ERROR', 'FirstRun', 'Failed to save state', { error: String(e) });
    }
  }

  private defaultState(): FirstRunState {
    return {
      currentStep: 'DETECT_PREREQUISITES',
      prerequisites: INITIAL_PREREQUISITES.map(p => ({ ...p })),
      overallProgress: 0,
      statusMessage: 'Preparing...',
      authMode: 'none',
      authComplete: false,
      needsDevMode: false,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/first-run.ts
git commit -m "feat(first-run): add state machine orchestrator"
```

---

### Task 4: Wire First-Run into Main Process

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Add first-run check to main.ts**

At the top of `src/main/main.ts`, add the import after the existing imports (after line 14):

```typescript
import { FirstRunManager } from './first-run';
```

Inside `app.whenReady().then(async () => {`, after `await rotateLog();` (line 113) and before the hook relay install block (line 115), add:

```typescript
  // --- First-run detection ---
  const firstRunManager = new FirstRunManager();
  const isFirstRun = FirstRunManager.isFirstRun();
```

Then modify the `createWindow()` call at line 184 to pass the first-run manager. Replace:

```typescript
  createWindow();
```

With:

```typescript
  createWindow(isFirstRun ? firstRunManager : undefined);
```

Update the `createWindow` function signature at line 56 to accept the optional parameter:

```typescript
function createWindow(firstRunManager?: FirstRunManager) {
```

After the `cleanupIpcHandlers = registerIpcHandlers(...)` line (line 77), add:

```typescript
  // Register first-run IPC handlers if in first-run mode
  if (firstRunManager) {
    registerFirstRunIpc(ipcMain, mainWindow, firstRunManager, sessionManager);
  }
```

Add the `registerFirstRunIpc` function before `createWindow`:

```typescript
function registerFirstRunIpc(
  ipcMain: Electron.IpcMain,
  mainWindow: BrowserWindow,
  firstRunManager: FirstRunManager,
  sessionManager: SessionManager,
) {
  // Push state updates to renderer
  firstRunManager.on('state-changed', (state) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.FIRST_RUN_STATE, state);
    }
  });

  // Handle wizard launch
  firstRunManager.on('launch-wizard', () => {
    const info = sessionManager.createSession({
      name: 'Setup Wizard',
      cwd: os.homedir(),
      skipPermissions: false,
    });
    // Send the initial prompt after a short delay to let the session initialize
    setTimeout(() => {
      sessionManager.sendInput(info.id, 'I just installed DestinCode. Help me set up.\r');
    }, 3000);
  });

  ipcMain.handle(IPC.FIRST_RUN_STATE, async () => firstRunManager.getState());

  ipcMain.handle(IPC.FIRST_RUN_RETRY, async () => {
    await firstRunManager.retry();
  });

  ipcMain.handle(IPC.FIRST_RUN_START_AUTH, async (_event, mode: 'oauth' | 'apikey') => {
    if (mode === 'oauth') {
      await firstRunManager.handleOAuthLogin();
    }
  });

  ipcMain.handle(IPC.FIRST_RUN_SUBMIT_API_KEY, async (_event, key: string) => {
    await firstRunManager.handleApiKeySubmit(key);
  });

  ipcMain.handle(IPC.FIRST_RUN_DEV_MODE_DONE, async () => {
    await firstRunManager.handleDevModeDone();
  });

  ipcMain.handle(IPC.FIRST_RUN_SKIP, async () => {
    const stateDir = path.join(os.homedir(), '.claude', 'toolkit-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, 'config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.setup_completed = true;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch {
      fs.writeFileSync(configPath, JSON.stringify({ setup_completed: true }, null, 2));
    }
  });

  // Start the first-run flow
  firstRunManager.run();
}
```

- [ ] **Step 2: Add first-run IPC to preload.ts**

In `src/main/preload.ts`, add the first-run IPC channels to the `IPC` constant (after the `SESSION_HISTORY` line):

```typescript
  FIRST_RUN_STATE: 'first-run:state',
  FIRST_RUN_RETRY: 'first-run:retry',
  FIRST_RUN_START_AUTH: 'first-run:start-auth',
  FIRST_RUN_SUBMIT_API_KEY: 'first-run:submit-api-key',
  FIRST_RUN_DEV_MODE_DONE: 'first-run:dev-mode-done',
  FIRST_RUN_SKIP: 'first-run:skip',
```

Then add the `firstRun` namespace to the `contextBridge.exposeInMainWorld('claude', { ... })` object, after the `getHomePath` line at the bottom:

```typescript
  firstRun: {
    getState: (): Promise<any> => ipcRenderer.invoke(IPC.FIRST_RUN_STATE),
    retry: (): Promise<void> => ipcRenderer.invoke(IPC.FIRST_RUN_RETRY),
    startAuth: (mode: 'oauth' | 'apikey'): Promise<void> =>
      ipcRenderer.invoke(IPC.FIRST_RUN_START_AUTH, mode),
    submitApiKey: (key: string): Promise<void> =>
      ipcRenderer.invoke(IPC.FIRST_RUN_SUBMIT_API_KEY, key),
    devModeDone: (): Promise<void> => ipcRenderer.invoke(IPC.FIRST_RUN_DEV_MODE_DONE),
    skip: (): Promise<void> => ipcRenderer.invoke(IPC.FIRST_RUN_SKIP),
    onStateChanged: (cb: (state: any) => void) => {
      const handler = (_e: IpcRendererEvent, state: any) => cb(state);
      ipcRenderer.on(IPC.FIRST_RUN_STATE, handler);
      return handler;
    },
  },
```

- [ ] **Step 3: Commit**

```bash
git add src/main/main.ts src/main/preload.ts
git commit -m "feat(first-run): wire state machine into main process and preload"
```

---

### Task 5: First-Run UI Component

**Files:**
- Create: `src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Create the FirstRunView component**

```tsx
// src/renderer/components/FirstRunView.tsx

import React, { useState, useEffect, useCallback } from 'react';
import type { FirstRunState, PrerequisiteState } from '../../shared/first-run-types';

function StatusIcon({ status }: { status: PrerequisiteState['status'] }) {
  switch (status) {
    case 'installed':
      return <span className="text-green-400 text-lg">&#10003;</span>;
    case 'installing':
    case 'checking':
      return <span className="text-blue-400 text-lg animate-spin inline-block">&#9696;</span>;
    case 'failed':
      return <span className="text-red-400 text-lg">&#10007;</span>;
    case 'skipped':
      return <span className="text-gray-500 text-lg">&#8212;</span>;
    default:
      return <span className="text-gray-600 text-lg">&#9675;</span>;
  }
}

function statusLabel(status: PrerequisiteState['status'], version?: string): string {
  switch (status) {
    case 'installed': return version ? `installed (${version})` : 'installed';
    case 'installing': return 'installing...';
    case 'checking': return 'checking...';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    default: return 'waiting';
  }
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="w-full max-w-sm bg-gray-800 rounded-full h-2.5">
      <div
        className="bg-blue-500 h-2.5 rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

function AuthScreen({ state, onOAuth, onApiKeySubmit }: {
  state: FirstRunState;
  onOAuth: () => void;
  onApiKeySubmit: (key: string) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  return (
    <div className="flex flex-col items-center gap-6 mt-4">
      {state.authMode === 'oauth' ? (
        <div className="text-center">
          <p className="text-gray-300 text-sm">
            A browser window should have opened. Sign in with your Claude account.
          </p>
          <p className="text-gray-500 text-xs mt-2">
            Waiting for login to complete...
          </p>
        </div>
      ) : (
        <>
          <button
            onClick={onOAuth}
            className="px-8 py-3 text-base font-semibold rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors"
          >
            Log in with Claude
          </button>
          <div className="text-gray-500 text-xs">or</div>
          {showApiKey ? (
            <div className="flex flex-col items-center gap-3 w-full max-w-sm">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-blue-500"
              />
              <p className="text-gray-500 text-xs text-center leading-snug">
                Your key is passed directly to Claude Code and stored in its secure config.
                DestinCode never stores, logs, or backs up your key.
              </p>
              <button
                onClick={() => { if (apiKey.trim()) onApiKeySubmit(apiKey.trim()); }}
                disabled={!apiKey.trim()}
                className="px-6 py-2 text-sm rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors disabled:opacity-40"
              >
                Verify &amp; Continue
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowApiKey(true)}
              className="text-gray-500 text-xs hover:text-gray-300 underline"
            >
              I have an API key
            </button>
          )}
        </>
      )}
    </div>
  );
}

function DevModeScreen({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 mt-4 max-w-md text-center">
      <p className="text-gray-300 text-sm leading-relaxed">
        Windows needs <strong>Developer Mode</strong> enabled so the toolkit can link its
        files correctly. A system permission dialog will appear &mdash; click <strong>Yes</strong> to allow it.
      </p>
      <button
        onClick={onDone}
        className="px-6 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
      >
        Enable Developer Mode
      </button>
      <p className="text-gray-600 text-xs leading-snug">
        Or enable it manually: Settings &gt; System &gt; For Developers &gt; Developer Mode
      </p>
    </div>
  );
}

export default function FirstRunView({ onComplete }: { onComplete: () => void }) {
  const [state, setState] = useState<FirstRunState | null>(null);

  useEffect(() => {
    (window as any).claude.firstRun.getState().then(setState);
    const handler = (window as any).claude.firstRun.onStateChanged(setState);
    return () => {
      (window as any).claude.off('first-run:state', handler);
    };
  }, []);

  const handleRetry = useCallback(() => {
    (window as any).claude.firstRun.retry();
  }, []);

  const handleOAuth = useCallback(() => {
    (window as any).claude.firstRun.startAuth('oauth');
  }, []);

  const handleApiKey = useCallback((key: string) => {
    (window as any).claude.firstRun.submitApiKey(key);
  }, []);

  const handleDevMode = useCallback(() => {
    (window as any).claude.firstRun.devModeDone();
  }, []);

  useEffect(() => {
    if (state?.currentStep === 'LAUNCH_WIZARD' || state?.currentStep === 'COMPLETE') {
      const timer = setTimeout(onComplete, 1500);
      return () => clearTimeout(timer);
    }
  }, [state?.currentStep, onComplete]);

  if (!state) return null;

  const isAuthStep = state.currentStep === 'AUTHENTICATE';
  const isDevModeStep = state.currentStep === 'ENABLE_DEVELOPER_MODE';
  const isLaunching = state.currentStep === 'LAUNCH_WIZARD' || state.currentStep === 'COMPLETE';

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 bg-gray-950 text-gray-100 p-8 select-none">
      <div className="text-4xl font-bold tracking-tight">DestinCode</div>

      {isLaunching ? (
        <p className="text-gray-400 text-sm animate-pulse">Starting your setup...</p>
      ) : (
        <>
          <p className="text-gray-500 text-sm">This usually takes 2-3 minutes</p>

          <div className="flex flex-col gap-3 w-full max-w-sm">
            {state.prerequisites.map((p) => (
              <div key={p.name} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <StatusIcon status={p.status} />
                  <span className={p.status === 'waiting' ? 'text-gray-600' : 'text-gray-200'}>
                    {p.displayName}
                  </span>
                </div>
                <span className="text-xs text-gray-500">
                  {statusLabel(p.status, p.version)}
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 w-full max-w-sm">
            <ProgressBar percent={state.overallProgress} />
            <span className="text-xs text-gray-500 w-10 text-right">{state.overallProgress}%</span>
          </div>

          <p className="text-gray-400 text-sm">{state.statusMessage}</p>

          {isAuthStep && (
            <AuthScreen state={state} onOAuth={handleOAuth} onApiKeySubmit={handleApiKey} />
          )}

          {isDevModeStep && <DevModeScreen onDone={handleDevMode} />}

          {state.lastError && (
            <div className="flex flex-col items-center gap-2 mt-2">
              <p className="text-red-400 text-sm text-center max-w-md">{state.lastError}</p>
              <button
                onClick={handleRetry}
                className="px-4 py-1.5 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </>
      )}

      {!isLaunching && (
        <button
          onClick={() => {
            (window as any).claude.firstRun.skip().then(onComplete);
          }}
          className="text-gray-700 text-xs hover:text-gray-500 mt-4"
        >
          Skip setup (I installed via terminal)
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): add FirstRunView React component"
```

---

### Task 6: Integrate FirstRunView into App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add first-run state and conditional rendering**

At the top of `App.tsx`, add the import (after the existing component imports, around line 19):

```typescript
import FirstRunView from './components/FirstRunView';
```

Inside `AppInner()`, after the existing `useState` declarations (around line 58), add:

```typescript
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null); // null = loading

  useEffect(() => {
    (window as any).claude?.firstRun?.getState?.().then((state: any) => {
      if (state && state.currentStep !== 'COMPLETE') {
        setIsFirstRun(true);
      } else {
        setIsFirstRun(false);
      }
    }).catch(() => {
      setIsFirstRun(false);
    });
  }, []);
```

Then wrap the main return JSX. Find the opening of the return statement inside `AppInner` (around line 564). Insert before the existing `return (`:

```tsx
  if (isFirstRun === null) {
    return <div className="flex-1 flex items-center justify-center bg-gray-950" />;
  }

  if (isFirstRun) {
    return (
      <div className="h-screen flex flex-col bg-gray-950">
        <FirstRunView onComplete={() => setIsFirstRun(false)} />
      </div>
    );
  }
```

The existing `return (` with the normal app JSX follows unchanged.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(first-run): integrate FirstRunView into App.tsx"
```

---

### Task 7: Update Setup Wizard — Remove Homebrew Assumption

**Files:**
- Modify: `core/skills/setup-wizard/SKILL.md`

- [ ] **Step 1: Update the Phase 4 Homebrew note**

In `core/skills/setup-wizard/SKILL.md`, find line 626:

```markdown
**Note:** On macOS, the bootstrap installer already installs Homebrew before launching the setup wizard. All `brew install` commands below can be run directly without checking for Homebrew first.
```

Replace it with:

```markdown
**Note:** Homebrew may or may not be installed at this point. Before running any `brew install` command on macOS, first check if Homebrew is available. If missing, install it:

1. Tell the user: "Several tools we need are installed through Homebrew — a package manager for Mac. I'll install it now. Your computer will ask for your password — nothing will appear as you type, which is normal. Just type it and press Enter."
2. Run: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
3. After install, ensure Homebrew is on PATH:
   ```bash
   if [[ -f /opt/homebrew/bin/brew ]]; then
       eval "$(/opt/homebrew/bin/brew shellenv)"
   elif [[ -f /usr/local/bin/brew ]]; then
       eval "$(/usr/local/bin/brew shellenv)"
   fi
   ```
4. Verify: `brew --version`
5. If it fails, tell the user: "Homebrew installation needs a terminal restart. Close and reopen this session, then run `/setup-wizard` again."

Only run this check once — after Homebrew is confirmed, all subsequent `brew install` commands can proceed directly.
```

- [ ] **Step 2: Commit**

```bash
git add core/skills/setup-wizard/SKILL.md
git commit -m "fix(wizard): remove Homebrew pre-installed assumption for app-based installs"
```

---

### Task 8: Manual Integration Testing

This task has no code to write — it's a verification checklist for the implementer.

- [ ] **Step 1: Test first-run detection (fresh state)**

Delete or rename `~/.claude/toolkit-state/config.json` (back it up first), then launch DestinCode.

Run: `mv ~/.claude/toolkit-state/config.json ~/.claude/toolkit-state/config.json.bak`

Expected: App shows FirstRunView instead of normal session UI.

- [ ] **Step 2: Test first-run detection (completed state)**

Restore the config:

Run: `mv ~/.claude/toolkit-state/config.json.bak ~/.claude/toolkit-state/config.json`

Launch DestinCode.

Expected: App shows normal session UI (no FirstRunView).

- [ ] **Step 3: Test prerequisite detection**

With first-run active, verify the checklist shows correct status for each prerequisite that's already installed on the test machine (Node, Git, Claude Code should show as "installed" immediately).

- [ ] **Step 4: Test skip link**

Click "Skip setup (I installed via terminal)" at the bottom of FirstRunView.

Expected: App transitions to normal session UI. `config.json` now has `setup_completed: true`.

- [ ] **Step 5: Test wizard handoff**

Allow first-run to complete through all prerequisites and auth. Verify that:
- A Claude Code session is created automatically
- The initial prompt "I just installed DestinCode. Help me set up." is sent
- Claude responds by launching the setup wizard

- [ ] **Step 6: Test crash recovery**

During prerequisite installation (e.g., while "Installing Git..." is shown), close the app. Reopen it.

Expected: First-run resumes from the last completed state, not from the beginning.

- [ ] **Step 7: Restore test environment**

```bash
# Restore original config if needed
mv ~/.claude/toolkit-state/config.json.bak ~/.claude/toolkit-state/config.json 2>/dev/null
# Clean up first-run state file
rm ~/.claude/toolkit-state/first-run-state.json 2>/dev/null
```

- [ ] **Step 8: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix(first-run): fixes from integration testing"
```

---

## Summary

| Task | What it does | Files |
|------|-------------|-------|
| 1 | Shared types (state machine states, IPC channels) | `first-run-types.ts`, `types.ts` |
| 2 | Prerequisite detection & silent install logic | `prerequisite-installer.ts` |
| 3 | State machine orchestrator | `first-run.ts` |
| 4 | Wire into main process + preload IPC | `main.ts`, `preload.ts` |
| 5 | First-run React UI (progress, auth, dev mode) | `FirstRunView.tsx` |
| 6 | Integrate into App.tsx | `App.tsx` |
| 7 | Fix setup wizard Homebrew assumption | `SKILL.md` |
| 8 | Manual integration testing | No code changes |

Tasks 1-3 are backend foundation. Task 4 connects them. Tasks 5-6 are frontend. Task 7 is a toolkit fix. Task 8 verifies everything works end-to-end.
