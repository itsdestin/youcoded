// cc-capture-lib.mjs — the pieces every "record Claude Code's real screen" probe
// shares: find the CLI, strip the parent session's identity from the
// environment, build an isolated HOME, and (only when a probe truly needs to be
// signed in) copy the minimum credential into it.
//
// WHY one module: capture-plan-menu.mjs grew these first; the startup-dialog
// capture (capture-startup-dialogs.mjs) and its drift check need exactly the
// same isolation guarantees. Two copies of "never touch the real ~/.claude"
// is how one of them eventually stops holding.
//
// ISOLATION CONTRACT (never Destin's real ~/.claude):
//   • every run gets a fresh temp HOME and CLAUDE_CONFIG_DIR under os.tmpdir();
//   • every CLAUDE* variable and ANTHROPIC_API_KEY is stripped, so a probe
//     launched from inside a Claude Code session can never reach that
//     session's hook pipe or believe it is nested;
//   • signing in copies the ACCESS token only — never the refresh token, so a
//     probe can never rotate it and sign the real install out. The real
//     credentials file is only ever READ.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '');
}

/** The `claude` on PATH (or `explicit`, e.g. a freshly npm-installed latest). */
export function resolveClaude(explicit) {
  if (typeof explicit === 'string' && explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`claude not found at ${explicit}`);
    return explicit;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const full = path.join(dir, 'claude');
    if (fs.existsSync(full)) return full;
  }
  throw new Error('claude not found on PATH');
}

/** The environment with every CLAUDE* / CLAUDECODE variable and the API key removed. */
export function cleanEnv(src = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(src)) {
    if (/^CLAUDE/.test(k) || k === 'ANTHROPIC_API_KEY') continue;
    env[k] = v;
  }
  return env;
}

/** "2.1.281" — the version the given binary reports. */
export function ccVersionOf(claudeBin) {
  return execFileSync(claudeBin, ['--version'], { encoding: 'utf8', env: cleanEnv(process.env) })
    .trim().split(/\s+/)[0];
}

/** A fresh temp root with `home/.claude` and `project` directories. */
export function makeIsolatedRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const home = path.join(root, 'home');
  const configDir = path.join(home, '.claude');
  const project = path.join(root, 'project');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { root, home, configDir, project };
}

/** The env a probe spawns claude with: cleaned, and pointed at the temp home. */
export function isolatedEnv({ home, configDir }) {
  return { ...cleanEnv(process.env), HOME: home, CLAUDE_CONFIG_DIR: configDir, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

/**
 * Copy the real sign-in's ACCESS token (only) into `configDir`. Refuses — exits
 * the process with code 3 — when the token has 20 minutes or less left, so a
 * probe never runs into an expiry mid-capture and never needs the refresh flow.
 */
export function copyAccessTokenOnly(configDir) {
  const realCreds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
  const oauth = realCreds.claudeAiOauth || {};
  const minutesLeft = (oauth.expiresAt - Date.now()) / 60000;
  if (!oauth.accessToken || !(minutesLeft > 20)) {
    console.error(`refusing: copied access token has ${Number.isFinite(minutesLeft) ? minutesLeft.toFixed(0) : '?'} min left (need > 20)`);
    process.exit(3);
  }
  // Access token only — no refreshToken, so this copy can never rotate it.
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
    },
  }), { mode: 0o600 });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// WHY: Claude Code starts background work at launch (it clones its plugin
// marketplace catalogue into <HOME>/.claude/plugins/marketplaces/) that can
// outlive the killed main process. Removing the isolated HOME while that
// grandchild is still writing threw ENOTEMPTY and crashed the whole drift
// check on its first CI run (2026-09-24, run 35975340826) — AFTER the capture
// itself had succeeded. Retry for a few seconds while the writer finishes; if
// the folder still won't go, warn and move on: it is a throwaway temp dir, and
// a leftover one must never turn a clean capture into a red drift report.
export async function removeTempTree(dir, { attempts = 10, delayMs = 500 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      return true;
    } catch (err) {
      if (i === attempts) {
        console.warn(`warning: could not remove temp folder ${dir} (${err.code || err.message}); leaving it`);
        return false;
      }
      await sleep(delayMs);
    }
  }
  return false;
}
