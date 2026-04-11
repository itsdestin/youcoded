/**
 * sync-setup-handlers.ts — Guided backend setup for the Sync wizard.
 *
 * Six focused IPC handlers that detect prerequisites, install tools,
 * run OAuth flows, and create repos. No generic shell exec — each handler
 * runs exactly one predetermined command with input validation and timeouts.
 *
 * These power the SyncSetupWizard UI so non-technical users can connect
 * Google Drive, GitHub, or iCloud without touching a terminal.
 *
 * Used by: ipc-handlers.ts, remote-server.ts
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

// --- Timeouts ---
const DETECT_TIMEOUT = 15_000;       // 15s for detection (which, listremotes, auth status)
const INSTALL_TIMEOUT = 300_000;     // 5m for tool installation
const AUTH_TIMEOUT = 120_000;        // 2m for OAuth (user is signing in via browser)
const REPO_TIMEOUT = 30_000;         // 30s for repo creation

// --- Helpers ---

/** Safely run a command and return { code, stdout, stderr }. Never throws. */
async function safeExec(
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string; env?: Record<string, string> }
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: opts?.timeout ?? DETECT_TIMEOUT,
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env || {}) },
    });
    return { code: 0, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' };
  } catch (e: any) {
    return {
      code: e.code ?? 1,
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || e.message || '',
    };
  }
}

/** Find a binary in PATH. Returns the full path or null. */
async function findBinary(name: string): Promise<string | null> {
  // Use 'where' on Windows, 'which' elsewhere
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = await safeExec(finder, [name]);
  if (result.code === 0 && result.stdout.trim()) {
    return result.stdout.trim().split('\n')[0].trim();
  }
  return null;
}

// --- Public API ---

/**
 * Check what's installed/configured for a given backend type.
 * Detection only — no side effects.
 */
export async function checkSyncPrereqs(backend: 'drive' | 'github' | 'icloud'): Promise<{
  rcloneInstalled: boolean;
  gdriveConfigured: boolean;
  gdriveRemoteName: string | null;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghUsername: string | null;
  icloudPath: string | null;
}> {
  const result = {
    rcloneInstalled: false,
    gdriveConfigured: false,
    gdriveRemoteName: null as string | null,
    ghInstalled: false,
    ghAuthenticated: false,
    ghUsername: null as string | null,
    icloudPath: null as string | null,
  };

  if (backend === 'drive') {
    // Check rclone is installed
    result.rcloneInstalled = (await findBinary('rclone')) !== null;

    // Check if a Google Drive remote exists in rclone config
    if (result.rcloneInstalled) {
      const listResult = await safeExec('rclone', ['listremotes']);
      if (listResult.code === 0) {
        // Parse remote names and check their types
        const remotes = listResult.stdout.split('\n').map(r => r.trim().replace(/:$/, '')).filter(Boolean);
        for (const remote of remotes) {
          const typeResult = await safeExec('rclone', ['config', 'show', remote]);
          if (typeResult.code === 0 && typeResult.stdout.includes('type = drive')) {
            result.gdriveConfigured = true;
            result.gdriveRemoteName = remote;
            break;
          }
        }
      }
    }
  }

  if (backend === 'github') {
    // Check gh is installed
    const ghPath = await findBinary('gh');
    result.ghInstalled = ghPath !== null;

    // Check if gh is authenticated
    if (result.ghInstalled) {
      const authResult = await safeExec('gh', ['auth', 'status']);
      // gh auth status exits 0 when authenticated, 1 when not
      result.ghAuthenticated = authResult.code === 0;

      if (result.ghAuthenticated) {
        const userResult = await safeExec('gh', ['api', 'user', '--jq', '.login']);
        if (userResult.code === 0 && userResult.stdout.trim()) {
          result.ghUsername = userResult.stdout.trim();
        }
      }
    }
  }

  if (backend === 'icloud') {
    // Auto-detect iCloud Drive path by scanning known locations
    const candidates = [
      path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
      path.join(os.homedir(), 'iCloudDrive'),
      path.join(os.homedir(), 'Apple', 'CloudDocs'),
    ];
    for (const candidate of candidates) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isDirectory()) {
          // Return the DestinClaude subfolder path (create if parent exists)
          result.icloudPath = path.join(candidate, 'DestinClaude');
          break;
        }
      } catch { /* not found, try next */ }
    }
  }

  return result;
}

/**
 * Install rclone via the platform's package manager.
 * Desktop only — on Android, rclone is bundled in Bootstrap.
 */
export async function installRclone(): Promise<{ success: boolean; error?: string }> {
  let cmd: string;
  let args: string[];

  switch (process.platform) {
    case 'win32':
      cmd = 'winget';
      args = ['install', '--id', 'Rclone.Rclone', '--accept-source-agreements', '--accept-package-agreements'];
      break;
    case 'darwin':
      cmd = 'brew';
      args = ['install', 'rclone'];
      break;
    default: {
      // Linux: use the official install script
      cmd = 'bash';
      args = ['-c', 'curl -fsSL https://rclone.org/install.sh | sudo bash'];
      break;
    }
  }

  const result = await safeExec(cmd, args, { timeout: INSTALL_TIMEOUT });
  if (result.code !== 0) {
    return { success: false, error: result.stderr || 'Installation failed' };
  }

  // Verify it's now available
  const found = await findBinary('rclone');
  return found ? { success: true } : { success: false, error: 'Installed but not found in PATH — try restarting the app' };
}

/**
 * Check if any rclone remote of type "drive" exists.
 * Lighter than full check-prereqs — use after auth to confirm it worked.
 */
export async function checkGdriveRemote(): Promise<{
  configured: boolean;
  remoteName: string | null;
}> {
  const listResult = await safeExec('rclone', ['listremotes']);
  if (listResult.code !== 0) return { configured: false, remoteName: null };

  const remotes = listResult.stdout.split('\n').map(r => r.trim().replace(/:$/, '')).filter(Boolean);
  for (const remote of remotes) {
    const typeResult = await safeExec('rclone', ['config', 'show', remote]);
    if (typeResult.code === 0 && typeResult.stdout.includes('type = drive')) {
      return { configured: true, remoteName: remote };
    }
  }
  return { configured: false, remoteName: null };
}

/**
 * Run rclone's interactive Google Drive OAuth flow.
 * This opens the default browser for the user to sign in to Google.
 * rclone starts a temporary localhost server to capture the OAuth token.
 * The promise resolves when the user completes sign-in (or times out).
 */
export async function authGdrive(): Promise<{
  success: boolean;
  remoteName: string;
  error?: string;
}> {
  // Pick a remote name that doesn't conflict with existing ones
  const listResult = await safeExec('rclone', ['listremotes']);
  const existingRemotes = listResult.code === 0
    ? listResult.stdout.split('\n').map(r => r.trim().replace(/:$/, '')).filter(Boolean)
    : [];

  let remoteName = 'gdrive';
  let counter = 2;
  while (existingRemotes.includes(remoteName)) {
    remoteName = `gdrive${counter}`;
    counter++;
  }

  // Create the rclone remote — this opens the browser for OAuth
  const result = await safeExec('rclone', ['config', 'create', remoteName, 'drive'], {
    timeout: AUTH_TIMEOUT,
  });

  if (result.code !== 0) {
    return { success: false, remoteName, error: result.stderr || 'Google sign-in failed or timed out' };
  }

  // Verify the remote was actually created
  const check = await checkGdriveRemote();
  if (!check.configured) {
    return { success: false, remoteName, error: 'Sign-in seemed to work but the connection was not saved' };
  }

  return { success: true, remoteName: check.remoteName || remoteName };
}

/**
 * Run GitHub's interactive OAuth flow via gh CLI.
 * Opens the default browser for the user to sign in and authorize.
 */
export async function authGithub(): Promise<{
  success: boolean;
  username: string | null;
  error?: string;
}> {
  // gh auth login --web opens the browser for device auth
  const result = await safeExec('gh', [
    'auth', 'login',
    '--hostname', 'github.com',
    '--git-protocol', 'https',
    '--web',
  ], { timeout: AUTH_TIMEOUT });

  if (result.code !== 0) {
    return { success: false, username: null, error: result.stderr || 'GitHub sign-in failed or timed out' };
  }

  // Get the username
  const userResult = await safeExec('gh', ['api', 'user', '--jq', '.login']);
  const username = userResult.code === 0 ? userResult.stdout.trim() || null : null;

  return { success: true, username };
}

/**
 * Create a private GitHub repo for sync via gh CLI.
 * Validates the repo name before executing.
 */
export async function createGithubRepo(repoName: string): Promise<{
  success: boolean;
  repoUrl: string | null;
  error?: string;
}> {
  // Validate repo name — only alphanumeric, dots, dashes, underscores
  if (!/^[a-zA-Z0-9._-]+$/.test(repoName) || repoName.length > 100) {
    return { success: false, repoUrl: null, error: 'Invalid repository name' };
  }

  // Get the authenticated username first
  const userResult = await safeExec('gh', ['api', 'user', '--jq', '.login']);
  if (userResult.code !== 0 || !userResult.stdout.trim()) {
    return { success: false, repoUrl: null, error: 'Not signed in to GitHub' };
  }
  const username = userResult.stdout.trim();

  // Create the repo (private, no local clone)
  const result = await safeExec('gh', [
    'repo', 'create',
    `${username}/${repoName}`,
    '--private',
    '--description', 'Personal Claude data backup (managed by DestinCode)',
  ], { timeout: REPO_TIMEOUT });

  if (result.code !== 0) {
    // Check for "already exists" error — that's OK, use it
    if (result.stderr.includes('already exists')) {
      return { success: true, repoUrl: `https://github.com/${username}/${repoName}` };
    }
    return { success: false, repoUrl: null, error: result.stderr || 'Failed to create repository' };
  }

  return { success: true, repoUrl: `https://github.com/${username}/${repoName}` };
}
