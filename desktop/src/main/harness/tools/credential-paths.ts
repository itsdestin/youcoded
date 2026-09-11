// Pure-credential files the native harness file tools must never read, beyond
// the .ssh/.gnupg/.aws/.azure/.kube/.netrc/.config-gh/dotenv set that
// editable-path-policy.ts already hard-denies.
//
// WHY a SEPARATE list here, not a widening of editable-path-policy's SENSITIVE_*
// (2026-09-10 security review): that set also drives the file VIEWER — an entry
// there makes the file impossible to open or edit in the pane. These are
// harness-only: the AI's Read/Grep/Glob may not touch them, but you can still
// open your own .git-credentials in the viewer.
//
// The list holds ONLY files that are pure secrets, so denying a read never costs
// a real "help me fix this config" task. Mixed config files that legitimately
// carry help-me requests (.npmrc, .pypirc, shell history) are deliberately NOT
// here.
//
// Matching is case-insensitive (Chrome's "Login Data" has a space and capitals;
// on POSIX the canonical path keeps its case) and anchored to the user's home so
// a project file that merely shares a basename is unaffected.

/** exact home-relative paths (lowercase). */
const HOME_FILES = [
  '.git-credentials',
  '.docker/config.json',
  '.gem/credentials',
  '.config/hub',
  '.claude.json',              // holds decrypted MCP env/headers
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.terraform.d/credentials.tfrc.json',
  '.pgpass',
  '.git-credentials-store',
  '.config/git/credentials',
];

/** home-relative directory prefixes (lowercase) whose whole subtree is secret. */
const HOME_DIR_PREFIXES = [
  '.config/gcloud/',
  '.local/share/keyrings/',
  '.password-store/',
  'library/keychains/',                       // macOS
  'appdata/roaming/microsoft/credentials/',   // Windows DPAPI
  'appdata/local/microsoft/credentials/',
  'appdata/roaming/microsoft/protect/',
];

/** Browser profile roots (home-relative, lowercase). A credential DB counts only
 *  inside one of these, so a project file named `cookies` is untouched. */
const BROWSER_ROOTS = [
  '.config/google-chrome/', '.config/chromium/', '.config/microsoft-edge/',
  '.config/brave-browser/', '.config/vivaldi/', '.config/opera/',
  '.mozilla/firefox/', '.thunderbird/',
  'library/application support/google/chrome/', 'library/application support/chromium/',
  'library/application support/firefox/', 'library/application support/bravesoftware/',
  'library/application support/microsoft edge/',
  'appdata/local/google/chrome/user data/', 'appdata/local/chromium/user data/',
  'appdata/local/microsoft/edge/user data/', 'appdata/roaming/mozilla/firefox/',
  'appdata/roaming/thunderbird/',
];
const BROWSER_CRED_BASENAMES = new Set([
  'login data', 'cookies', 'web data', 'logins.json', 'key3.db', 'key4.db',
  'cookies.sqlite', 'signons.sqlite',
]);

/** Distinctive basenames refused anywhere — no legitimate project file shares
 *  these names (YouCoded's own encrypted stores). */
const CREDENTIAL_BASENAMES = new Set(['native-secrets.json', 'chatgpt-account.json']);

/**
 * True when `canonical` (a canonicalize()'d absolute path — forward slashes,
 * `..` resolved) is a pure-credential file. `home` is the same-canonicalized
 * home directory.
 */
export function isCredentialPath(canonical: string, home: string): boolean {
  const c = canonical.toLowerCase();
  const h = home.toLowerCase().replace(/\/$/, '');
  const base = c.slice(c.lastIndexOf('/') + 1);

  if (CREDENTIAL_BASENAMES.has(base)) return true;
  if (!c.startsWith(h + '/')) return false;
  const rel = c.slice(h.length + 1);

  if (HOME_FILES.includes(rel)) return true;
  if (HOME_DIR_PREFIXES.some((p) => rel.startsWith(p))) return true;
  if (BROWSER_CRED_BASENAMES.has(base) && BROWSER_ROOTS.some((r) => rel.startsWith(r))) return true;
  return false;
}

/**
 * ripgrep exclusion globs so a `--hidden` search from a parent directory never
 * descends INTO these credential locations (the Grep gap: the search root passes
 * the path guard, but ripgrep would still read the secret file). Pushed AFTER any
 * caller glob so an inclusion like `**​/.aws/credentials` cannot re-add them —
 * ripgrep applies globs in order, last match wins.
 */
export const CREDENTIAL_EXCLUDE_GLOBS: readonly string[] = [
  // The editable-path-policy sensitive segments.
  '!**/.ssh/**', '!**/.gnupg/**', '!**/.aws/**', '!**/.azure/**', '!**/.kube/**',
  '!**/.netrc', '!**/_netrc', '!**/.credentials.json', '!**/.config/gh/**',
  '!**/.env', '!**/.env.*', '!**/.envrc',
  // The credential files and dirs above.
  '!**/.git-credentials', '!**/.git-credentials-store', '!**/.docker/config.json',
  '!**/.gem/credentials', '!**/.config/hub', '!**/.claude.json', '!**/.pgpass',
  '!**/.cargo/credentials', '!**/.cargo/credentials.toml',
  '!**/.terraform.d/credentials.tfrc.json', '!**/.config/git/credentials',
  '!**/.config/gcloud/**', '!**/.local/share/keyrings/**', '!**/.password-store/**',
  '!**/Keychains/**', '!**/native-secrets.json', '!**/chatgpt-account.json',
  '!**/logins.json', '!**/key4.db', '!**/key3.db', '!**/signons.sqlite',
];
