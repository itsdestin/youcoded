// Fetches Claude Code usage limits from the OAuth API and caches the result.
// Desktop-bundled version — deployed by DestinCode to keep .usage-cache.json fresh
// even when the DestinClaude toolkit's statusline isn't running.
const fs = require('fs');
const path = require('path');

const home = require('os').homedir();
const credsPath = path.join(home, '.claude', '.credentials.json');
const cachePath = path.join(home, '.claude', '.usage-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Check cache freshness
try {
  const stat = fs.statSync(cachePath);
  if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
    process.stdout.write(fs.readFileSync(cachePath, 'utf8'));
    process.exit(0);
  }
} catch {}

// Read OAuth token — try file first, then macOS Keychain
let token;
try {
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  token = creds.claudeAiOauth.accessToken;
  if (!token) throw new Error('no token');
} catch {
  // macOS: credentials may live in the system Keychain
  try {
    if (process.platform !== 'darwin') throw new Error('not macOS');
    const { execFileSync } = require('child_process');
    const user = process.env.USER || process.env.USERNAME || require('os').userInfo().username;
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', user, '-w'],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    token = JSON.parse(raw).claudeAiOauth.accessToken;
    if (!token) throw new Error('no token');
  } catch {
    process.exit(1);
  }
}

// Fetch usage limits
fetch('https://api.anthropic.com/api/oauth/usage', {
  headers: {
    'Authorization': 'Bearer ' + token,
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
}).then(r => {
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}).then(data => {
  const out = JSON.stringify(data);
  fs.writeFileSync(cachePath, out);
  process.stdout.write(out);
}).catch(() => {
  // On failure, serve stale cache if available
  try { process.stdout.write(fs.readFileSync(cachePath, 'utf8')); } catch {}
});
