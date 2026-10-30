// The assistant's own "keys": files that decide what it is allowed to do next.
//
// WHY (security hardening 2026-10-30, audit finding F-04): in Auto-edit and Full auto a Write/Edit
// inside the project asks nothing, and if the open folder is (or contains) the home folder, the
// assistant could rewrite ~/.youcoded/permissions.json (the saved "Always allow" list, re-read on
// every decision), the mode file, YouCoded's settings, ~/.claude/settings.json (its hooks), or a
// git hook that runs on the next commit. A text injected from a web page could therefore grant
// itself everything. These paths now ALWAYS ask, in every mode, with no "Always allow" — the same
// kind of floor as the secret-path and removal floors. Friction, not a sandbox (Bash can still be
// spelled many ways); the Bash check below catches the plain spellings.
import * as os from 'os';
import * as path from 'path';
import { canonicalize, realpathNearestSync } from './guards';

/** Home-relative folders whose whole tree is protected (lowercase). The last three are YouCoded's
 *  own userData folder on Linux / macOS / Windows. */
const HOME_PROTECTED_DIRS = [
  '.youcoded',
  '.claude/hooks',
  '.config/youcoded',
  'library/application support/youcoded',
  'appdata/roaming/youcoded',
];
/** Home-relative single files (lowercase). */
const HOME_PROTECTED_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

/** True when the canonical (forward-slash, `..`-resolved) path is one of the protected files. */
export function isProtectedConfigCanonical(canonical: string, homes: string[]): boolean {
  const c = canonical.toLowerCase();
  // Anywhere: a project's git hooks and git config, and its Claude settings (which hold hooks).
  if (/\/\.git\/hooks(\/|$)/.test(c) || /\/\.git\/config$/.test(c)) return true;
  if (/\/\.claude\/settings(\.local)?\.json$/.test(c)) return true;
  for (const home of homes) {
    const h = home.toLowerCase().replace(/\/$/, '');
    if (!c.startsWith(h + '/')) continue;
    const rel = c.slice(h.length + 1);
    if (HOME_PROTECTED_FILES.includes(rel)) return true;
    if (HOME_PROTECTED_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))) return true;
  }
  return false;
}

function homeForms(cwd: string): string[] {
  const forms = new Set([canonicalize(os.homedir(), cwd)]);
  const real = realpathNearestSync(os.homedir());
  if (real) forms.add(canonicalize(real, cwd));
  return [...forms];
}

/** Would writing `rawPath` change one of the protected files? Judged on the typed path AND where
 *  it really leads (a link in the project pointing at ~/.youcoded/permissions.json counts). */
export function isProtectedConfigPath(rawPath: string, cwd: string): boolean {
  const homes = homeForms(cwd);
  const typed = canonicalize(rawPath, cwd);
  if (isProtectedConfigCanonical(typed, homes)) return true;
  const real = realpathNearestSync(path.resolve(cwd, rawPath));
  return !!real && isProtectedConfigCanonical(canonicalize(real, cwd), homes);
}

// Plain spellings only: the path literal in the command text. `~`, $HOME, ${HOME} and the
// absolute home path all end in the same tail, so the tail is what is matched.
const PROTECTED_TEXT = /(?:^|[\s"'=:\/])(?:\.youcoded(?:\/|\\|\b)|\.claude[\/\\](?:settings(?:\.local)?\.json|hooks\b)|\.git[\/\\](?:hooks\b|config\b)|\.config[\/\\]youcoded\b)/;
const READ_ONLY_START = /^\s*(?:cat|ls|head|tail|less|more|grep|rg|stat|wc|file|diff|jq|realpath|readlink|tree|du)\b/;
const CHAINING_OR_WRITING = /[>;&|`]|\$\(|\btee\b/;

/** Does this Bash command text mention a protected file in a way that could change it? A plain
 *  read-only command (`cat ~/.youcoded/config.json`) is let through; anything that redirects,
 *  chains, pipes into tee, or is not an obvious reader asks. */
export function bashTouchesProtectedConfig(command: string): boolean {
  if (!PROTECTED_TEXT.test(command)) return false;
  if (READ_ONLY_START.test(command) && !CHAINING_OR_WRITING.test(command)) return false;
  return true;
}
