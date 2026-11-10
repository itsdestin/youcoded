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
// The list holds files that are secrets, so denying a read rarely costs a real
// "help me fix this config" task. Shell history stays OFF this list. (.npmrc and
// .pypirc were left off until 2026-10-30; they are on it now because they routinely
// carry registry tokens — see SECRET_ANYWHERE_BASENAMES.)
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

/** YouCoded's own secret and credential files, matched by basename but only UNDER HOME — the
 *  userData dir is under home on every platform (~/.config/youcoded,
 *  ~/Library/Application Support/youcoded, ~/AppData/Roaming/youcoded), so
 *  anchoring to home keeps them covered while a project fixture that happened to
 *  share the name stays readable (2026-09-10 review, F3).
 *
 *  WHY ONE SHARED LIST (security hardening 2026-10-30): the phone door already refused
 *  github-token.json, marketplace-auth.json, page-connections.json and the remote-access
 *  password files, but the assistant's own list stopped at two of them, so a prompt-injected
 *  assistant could read them. The phone list below now spreads THIS list, so the two doors
 *  cannot drift apart again. */
export const APP_SECRET_BASENAMES: readonly string[] = [
  'native-secrets.json', 'chatgpt-account.json', '.claude.json', '.remote-tokens.json',
  'github-token.json', 'marketplace-auth.json', 'search-providers.json', 'page-connections.json',
];
const HOME_BASENAMES = new Set(APP_SECRET_BASENAMES);

/** The remote-access files: `youcoded-remote.json` (password hash) and `.remote-devices.json` (paired devices),
 *  each with an optional `.<profile>` suffix a dev instance uses (remote-paths.ts). */
const APP_SECRET_PATTERNS: readonly RegExp[] = [/^youcoded-remote(\.[^./]+)?\.json$/, /^\.remote-devices(\.[^./]+)?\.json$/];

/** Credential files refused WHEREVER they sit (security hardening 2026-10-30; before this only the
 *  home-anchored list above applied to the assistant). Mixed files like .npmrc/.pypirc are included
 *  on purpose now: they routinely hold registry tokens, and a prompt-injected assistant that can
 *  read one can send it out. */
const SECRET_ANYWHERE_BASENAMES: readonly string[] = [
  '.git-credentials', '.git-credentials-store', '.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass', '.vault-token',
];
/** Private-key names by prefix (id_rsa, id_rsa_work, id_rsa.bak…), but never the matching PUBLIC key (`.pub`). */
const KEY_NAME_PREFIXES: readonly string[] = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];
/** Key and certificate bundles. (`.key` is left to the phone list: Apple Keynote files share it.) */
const ASSISTANT_KEY_EXTENSIONS = ['.pem', '.p12', '.pfx', '.kdbx'];

/**
 * True when `canonical` (a canonicalize()'d absolute path — forward slashes,
 * `..` resolved) is a pure-credential file. `home` is the same-canonicalized
 * home directory.
 */
export function isCredentialPath(canonical: string, home: string): boolean {
  const c = canonical.toLowerCase();
  const h = home.toLowerCase().replace(/\/$/, '');
  const base = c.slice(c.lastIndexOf('/') + 1);

  // Secrets that are secret wherever they sit (before the home anchor on purpose).
  if (SECRET_ANYWHERE_BASENAMES.includes(base)) return true;
  if (!base.endsWith('.pub') && KEY_NAME_PREFIXES.some((k) => base.startsWith(k))) return true;
  if (ASSISTANT_KEY_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;

  if (!c.startsWith(h + '/')) return false;
  const rel = c.slice(h.length + 1);

  if (HOME_BASENAMES.has(base)) return true;
  if (APP_SECRET_PATTERNS.some((re) => re.test(base))) return true;
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
// It EXTENDS this file rather than forking it: it calls isCredentialPath and adds names that match
// ANYWHERE in the path. Since 2026-10-30 the app's own secret files and the any-folder secret names/keys are ONE
// shared list (APP_SECRET_*, SECRET_ANYWHERE_*, KEY_NAME_PREFIXES) used by both doors; the phone alone additionally
// refuses `.git/` folders, shell histories, `.gitconfig`, `*.key` and the like.
// `.env` is deliberately NOT here: artifacts:get serves it on purpose (the pane is the human escape hatch for
// editing a .env, editable-path-policy.ts D5), and read-binary / fs:read-head / search already refuse it.
// Everything is compared lowercase on the RESOLVED path, so symlinks, `..` and Windows/macOS case do not dodge it.

/** Directory names whose whole subtree a phone never reads, at any depth. */
const PHONE_DENY_SEGMENTS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube']);

/** File names a phone never reads, at any depth. */
const PHONE_DENY_BASENAMES = new Set([
  ...SECRET_ANYWHERE_BASENAMES, '.credentials.json',
  '.gitconfig', 'rclone.conf',
  // Shell and REPL histories (they hold typed passwords and tokens).
  '.bash_history', '.zsh_history', '.sh_history', 'fish_history', '.python_history', '.node_repl_history',
  '.psql_history', '.mysql_history', '.sqlite_history', '.irb_history',
  // The app's own secret and config files (shared with the assistant's list: APP_SECRET_BASENAMES).
  ...APP_SECRET_BASENAMES,
]);

/** Private-key names by prefix (id_rsa, id_rsa_work, id_rsa.bak…), but never the matching PUBLIC key (`.pub`). */
const PHONE_DENY_KEY_PREFIXES = KEY_NAME_PREFIXES;

/** Paths under these (any depth) are refused: tool configs that carry a login. */
const PHONE_DENY_SUBPATHS = ['/.config/gh/', '/.docker/config.json', '/.kube/config'];

/** Extensions of key and certificate bundles. */
const PHONE_DENY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.kdbx'];

const PHONE_DENY_PATTERNS = APP_SECRET_PATTERNS;

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
  // Shared with the phone door (security hardening 2026-10-30): the app's own secret files and
  // secrets that are secret wherever they sit, so Grep from a parent folder cannot print them.
  ...APP_SECRET_BASENAMES.map((b) => `!**/${b}`),
  '!**/youcoded-remote*.json', '!**/.remote-devices*.json',
  ...SECRET_ANYWHERE_BASENAMES.map((b) => `!**/${b}`),
  ...KEY_NAME_PREFIXES.map((k) => `!**/${k}*`),
  ...ASSISTANT_KEY_EXTENSIONS.map((ext) => `!**/*${ext}`),
];

// WHY (integration review 2026-11-01): the Bash look-only list lets `grep -r` / `rg` run without asking, but those
// print file contents, and unlike the Grep tool they cannot be given the exclusion list above. So the guard asks the
// question the other way round: "would the Grep tool have skipped any file under here?" — answered from the SAME
// CREDENTIAL_EXCLUDE_GLOBS list (one source of truth), by turning each glob into a pattern.
const EXCLUDE_PATTERNS: RegExp[] = CREDENTIAL_EXCLUDE_GLOBS.filter((g) => g.startsWith('!')).map((g) => {
  const body = g.slice(1);
  let rx = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '*' && body[i + 1] === '*') {
      i++;
      if (body[i + 1] === '/') { i++; rx += '(?:.*/)?'; } else rx += '.*';
    } else if (ch === '*') rx += '[^/]*';
    else rx += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(?:^|/)${rx}$`, 'i');
});

/** True when the Grep tool would refuse to search this path (a slash-separated path, relative or absolute). */
export function isSearchExcludedPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return EXCLUDE_PATTERNS.some((rx) => rx.test(norm));
}
