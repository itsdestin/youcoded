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

/** YouCoded's own encrypted stores, matched by basename but only UNDER HOME — the
 *  userData dir is under home on every platform (~/.config/youcoded,
 *  ~/Library/Application Support/youcoded, ~/AppData/Roaming/youcoded), so
 *  anchoring to home keeps them covered while a project fixture that happened to
 *  share the name stays readable (2026-09-10 review, F3). */
const HOME_BASENAMES = new Set(['native-secrets.json', 'chatgpt-account.json']);

/**
 * True when `canonical` (a canonicalize()'d absolute path — forward slashes,
 * `..` resolved) is a pure-credential file. `home` is the same-canonicalized
 * home directory.
 */
export function isCredentialPath(canonical: string, home: string): boolean {
  const c = canonical.toLowerCase();
  const h = home.toLowerCase().replace(/\/$/, '');
  const base = c.slice(c.lastIndexOf('/') + 1);

  if (!c.startsWith(h + '/')) return false;
  const rel = c.slice(h.length + 1);

  if (HOME_BASENAMES.has(base)) return true;
  if (HOME_FILES.includes(rel)) return true;
  if (HOME_DIR_PREFIXES.some((p) => rel.startsWith(p))) return true;
  if (BROWSER_CRED_BASENAMES.has(base) && BROWSER_ROOTS.some((r) => rel.startsWith(r))) return true;
  return false;
}

// ── PHONE read deny list ─────────────────────────────────────────────────────────────────────────────
// WHY (2026-10-01 one-core R3-SEC): a paired phone could read a project's `.git/config` (a remote address can
// carry a token), `.git-credentials`, `id_rsa`, `*.pem`, and through fs:read-head ANY file on the computer, e.g.
// the remote password hash. This is the ONE list every phone file read consults (main/phone-read-deny.ts).
//
// It EXTENDS this file rather than forking it: it calls isCredentialPath unchanged and adds names that match
// ANYWHERE in the path (a project's own `.git-credentials` / `id_rsa`), which the home-anchored list above
// deliberately did not cover. isCredentialPath itself is NOT changed, so the native assistant's file tools
// (harness/tools/guards.ts) refuse exactly what they refused before; only the phone door calls the function below.
// `.env` is deliberately NOT here: artifacts:get serves it on purpose (the pane is the human escape hatch for
// editing a .env, editable-path-policy.ts D5), and read-binary / fs:read-head / search already refuse it.
// Everything is compared lowercase on the RESOLVED path, so symlinks, `..` and Windows/macOS case do not dodge it.

/** Directory names whose whole subtree a phone never reads, at any depth. */
const PHONE_DENY_SEGMENTS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube']);

/** File names a phone never reads, at any depth. */
const PHONE_DENY_BASENAMES = new Set([
  '.git-credentials', '.git-credentials-store', '.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass', '.credentials.json',
  '.gitconfig', 'rclone.conf', '.vault-token',
  // Shell and REPL histories (they hold typed passwords and tokens).
  '.bash_history', '.zsh_history', '.sh_history', 'fish_history', '.python_history', '.node_repl_history',
  '.psql_history', '.mysql_history', '.sqlite_history', '.irb_history',
  // The app's own secret and config files (remote-paths.ts, providers/secrets-store.ts, chatgpt-auth.ts,
  // github-client.ts, marketplace-auth-store.ts, harness/search/search-key-store.ts, pages/connections-store.ts).
  'native-secrets.json', 'chatgpt-account.json', '.claude.json', '.remote-tokens.json',
  'github-token.json', 'marketplace-auth.json', 'search-providers.json', 'page-connections.json',
]);

/** Private-key names by prefix (id_rsa, id_rsa_work, id_rsa.bak…), but never the matching PUBLIC key (`.pub`). */
const PHONE_DENY_KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];

/** Paths under these (any depth) are refused: tool configs that carry a login. */
const PHONE_DENY_SUBPATHS = ['/.config/gh/', '/.docker/config.json', '/.kube/config'];

/** Extensions of key and certificate bundles. */
const PHONE_DENY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.kdbx'];

/** The remote-access files: `youcoded-remote.json` (password hash) and `.remote-devices.json` (paired devices),
 *  each with an optional `.<profile>` suffix a dev instance uses (remote-paths.ts). */
const PHONE_DENY_PATTERNS = [/^youcoded-remote(\.[^./]+)?\.json$/, /^\.remote-devices(\.[^./]+)?\.json$/];

/** True when a phone must be refused this file. `canonical` is a canonicalize()'d absolute path (forward slashes,
 *  `..` resolved), `home` the same-canonicalized home directory. */
export function isPhoneDeniedPath(canonical: string, home: string): boolean {
  if (isCredentialPath(canonical, home)) return true;
  const c = canonical.toLowerCase();
  const parts = c.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (parts.some((seg) => PHONE_DENY_SEGMENTS.has(seg))) return true;
  if (PHONE_DENY_BASENAMES.has(base)) return true;
  if (!base.endsWith('.pub') && PHONE_DENY_KEY_PREFIXES.some((k) => base.startsWith(k))) return true;
  if (PHONE_DENY_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  if (PHONE_DENY_PATTERNS.some((re) => re.test(base))) return true;
  return PHONE_DENY_SUBPATHS.some((sub) => c.includes(sub));
}

/** ripgrep exclusions for the same list, so a phone's content search never prints a line of a refused file. */
export const PHONE_DENY_SEARCH_GLOBS: readonly string[] = [
  ...[...PHONE_DENY_SEGMENTS].map((seg) => `!${seg}`),
  ...[...PHONE_DENY_BASENAMES].map((b) => `!${b}`),
  ...PHONE_DENY_EXTENSIONS.map((ext) => `!*${ext}`),
  // Key-name prefixes: the public .pub keys are skipped by search too (nothing worth finding in them).
  ...PHONE_DENY_KEY_PREFIXES.map((k) => `!${k}*`),
  ...PHONE_DENY_SUBPATHS.map((sub) => `!**${sub}${sub.endsWith('/') ? '**' : ''}`),
  '!youcoded-remote*.json', '!.remote-devices*.json',
];

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
