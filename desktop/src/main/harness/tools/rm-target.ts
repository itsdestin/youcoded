// The removal-target floor: a check that sits BELOW every permission rule.
//
// WHY this exists (roadmap: "Once a wide enough Bash approval is saved, a
// destructive `rm` on a workspace or system directory can run without asking").
// The permission engine lets a remembered "Always allow" beat the destructive
// deny-list — deliberately, so a user's own decision is the final word for
// ordinary commands. But nothing sat underneath that for the handful of
// removals no saved rule should ever wave through: the whole workspace, the
// home folder, the disk root, a system folder. Claude Code keeps a target check
// below its rules for exactly this; this is the native harness's equivalent.
//
// What it does: read a Bash command statically, find every `rm`-family call,
// resolve each target, and report when one would remove a protected directory
// (or everything inside one). The caller turns a report into a FORCED approval
// card — it only ever ADDS an ask, it never denies and never allows.
//
// What it is NOT: a sandbox. It reads the command text, so anything that hides
// the target from a reader (a script file, `eval`, base64) passes it by
// construction. Same posture as guards.ts — honest friction, not a boundary.
import * as path from 'path';

export interface RmTargetContext {
  /** The workspace (session) root. Removing it or any folder above it is protected. */
  cwd: string;
  /** Where the next Bash call starts (the persisted shell cwd); defaults to `cwd`. */
  shellCwd?: string;
  home: string;
  /** Injected for tests; defaults to the running platform. */
  platform?: NodeJS.Platform;
}

/** One shell word, quotes removed, remembering what the shell would do to it. */
export interface Word {
  value: string;
  /** Per character of `value`: true where an UNQUOTED glob character sits. */
  glob: boolean[];
  /** The word contains a `$…`/backtick expansion outside single quotes. */
  expands: boolean;
  /** The word STARTS with such an expansion (so an empty value lands on `/`). */
  leadingExpansion: boolean;
  /** The word starts with an unquoted `~`. */
  tilde: boolean;
  op?: undefined;
}
export interface Op { op: string }
export type Token = Word | Op;

const GLOB_CHARS = new Set(['*', '?', '[']);

/** A small POSIX-ish tokenizer: quotes, backslash escapes, and the operators
 *  (shared with bash-secret-paths.ts, so both floors read a command alike)
 *  that separate one simple command from the next. `$(` and backticks open a
 *  nested command so an `rm` inside a substitution is still seen. */
export function tokenize(command: string, backslashEscapes: boolean): Token[] {
  const out: Token[] = [];
  let cur: Word | null = null;
  const start = (): Word => (cur ??= { value: '', glob: [], expands: false, leadingExpansion: false, tilde: false });
  const push = (ch: string, isGlob = false) => { const w = start(); w.value += ch; w.glob.push(isGlob); };
  const end = () => { if (cur) out.push(cur); cur = null; };
  const markExpansion = () => { const w = start(); if (w.value.length === 0) w.leadingExpansion = true; w.expands = true; };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === ' ' || c === '\t') { end(); i++; continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '`') { end(); out.push({ op: c }); i++; continue; }
    if (c === '&' || c === '|') {
      end();
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||') { out.push({ op: two }); i += 2; } else { out.push({ op: c }); i++; }
      continue;
    }
    // Backslash escapes are POSIX; on Windows it is the path separator
    // (PowerShell and cmd do not escape with it), so it stays literal there.
    if (backslashEscapes && c === '\\' && i + 1 < command.length) { push(command[i + 1]); i += 2; continue; }
    if (c === "'") {
      start();
      const close = command.indexOf("'", i + 1);
      const body = close === -1 ? command.slice(i + 1) : command.slice(i + 1, close);
      for (const ch of body) push(ch);
      i = close === -1 ? command.length : close + 1;
      continue;
    }
    if (c === '"') {
      start();
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) { push(command[i + 1]); i += 2; continue; }
        if (command[i] === '$' || command[i] === '`') markExpansion();
        push(command[i]);
        i++;
      }
      i++;
      continue;
    }
    if (c === '$' && command[i + 1] === '(') { end(); out.push({ op: '$(' }); i += 2; continue; }
    if (c === '$') markExpansion();
    if (c === '~' && !cur) { start().tilde = true; }
    push(c, GLOB_CHARS.has(c));
    i++;
  }
  end();
  return out;
}

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env', 'xargs']);
/** Wrapper flags that take a separate value (`sudo -u bob rm …`, `nice -n 5 rm …`). */
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-C', '-h', '-p', '-U', '-n', '-D']);
const REMOVERS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd']);
const CHANGE_DIR = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);

const POSIX_SYSTEM_DIRS = [
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32', '/media', '/mnt',
  '/opt', '/proc', '/root', '/run', '/sbin', '/snap', '/srv', '/sys', '/tmp', '/usr', '/var',
  '/usr/bin', '/usr/lib', '/usr/local', '/usr/sbin', '/usr/share', '/var/lib', '/var/log',
  '/Applications', '/Library', '/System', '/Users', '/Volumes', '/private', '/cores',
];
const WINDOWS_SYSTEM_DIRS = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\Users',
];

/** Everything inside a folder: a final segment of only these globs. `*.log`
 *  is NOT here — removing the logs in a folder is not removing the folder. */
const WHOLE_CONTENTS = /^(\*+|\.\*|\*\.\*|\.\[!\.\]\*|\.\?\*)$/;

function isRecursiveFlag(flag: string): boolean {
  const lower = flag.toLowerCase();
  if (lower === '--recursive' || lower === '/s') return true;
  // A short cluster (-r, -rf, -fR, -rfv): POSIX rm. A longer single-dash word
  // is PowerShell's (-Recurse, -Force), where only -Recurse (or -r) means it.
  if (/^-[a-z]{1,3}$/i.test(flag)) return /r/i.test(flag);
  return lower.startsWith('-rec');
}

/** Why `command` would remove a protected directory, or null when it would not. */
export function destructiveRmReason(command: string, ctx: RmTargetContext): string | null {
  const win = (ctx.platform ?? process.platform) === 'win32';
  const P = win ? path.win32 : path.posix;
  const norm = (p: string) => { const r = P.resolve(p); return win ? r.toLowerCase() : r; };
  const home = norm(ctx.home);
  const workspace = norm(ctx.cwd);
  const system = new Set((win ? WINDOWS_SYSTEM_DIRS : POSIX_SYSTEM_DIRS).map(norm));
  const isAncestorOrSelf = (a: string, b: string) => {
    if (a === b) return true;
    const rel = P.relative(a, b);
    return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel);
  };
  const protectedReason = (abs: string): string | null => {
    const p = norm(abs);
    if (P.parse(p).root === p) return 'the root of the disk';
    if (isAncestorOrSelf(p, home)) return 'your home folder';
    if (isAncestorOrSelf(p, workspace)) return 'the whole workspace';
    if (system.has(p)) return `the system folder ${abs}`;
    return null;
  };

  // Where relative targets resolve: the shell's cwd, moved by any `cd` earlier
  // in the same command line. null = moved somewhere a reader cannot know.
  let base: string | null = ctx.shellCwd ?? ctx.cwd;
  const tokens = tokenize(command, !win);
  let i = 0;
  while (i < tokens.length) {
    // Collect one simple command.
    const words: Word[] = [];
    while (i < tokens.length && !(tokens[i] as Op).op) { words.push(tokens[i] as Word); i++; }
    i++; // skip the operator
    let w = 0;
    while (w < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[w].value)) w++; // FOO=bar rm …
    while (w < words.length && WRAPPERS.has(words[w].value)) {
      w++;
      while (w < words.length && (words[w].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[w].value))) {
        w += WRAPPER_VALUE_FLAGS.has(words[w].value) ? 2 : 1;
      }
    }
    if (w >= words.length) continue;
    const name = P.basename(words[w].value).toLowerCase().replace(/\.exe$/, '');
    const args = words.slice(w + 1);

    if (CHANGE_DIR.has(name)) {
      const dest = args.find((a) => !a.value.startsWith('-'));
      if (!dest) base = ctx.home;
      else {
        const to = expandHome(dest.value, dest.tilde, ctx.home);
        if (dest.expands && to === dest.value) base = null;
        else if (base !== null || P.isAbsolute(to)) base = P.resolve(base ?? ctx.cwd, to);
      }
      continue;
    }
    if (!REMOVERS.has(name)) continue;

    let recursive = false;
    let endOfFlags = false;
    const targets: Word[] = [];
    for (const a of args) {
      if (!endOfFlags && a.value === '--') { endOfFlags = true; continue; }
      if (!endOfFlags && (a.value.startsWith('-') || (win && /^\/[a-z]$/i.test(a.value)))) {
        if (isRecursiveFlag(a.value)) recursive = true;
        continue;
      }
      targets.push(a);
    }

    for (const t of targets) {
      const substitutesHome = expandHome(t.value, t.tilde, ctx.home) !== t.value;
      if (t.leadingExpansion && !substitutesHome) {
        return `removes a path that starts with a variable (${t.value}); if it is empty the removal starts at the root of the disk`;
      }
      // Glob: judge the folder whose contents the pattern would match.
      let raw = t.value;
      let contentsOnly = false;
      if (t.glob.includes(true)) {
        const segs = t.value.split(win ? /[\\/]/ : '/');
        const last = segs[segs.length - 1];
        const prefixHasGlob = t.glob.slice(0, t.value.length - last.length).includes(true);
        if (prefixHasGlob || !WHOLE_CONTENTS.test(last)) continue; // e.g. `*.log`, `src/*/dist`
        raw = segs.slice(0, -1).join('/') || (t.value.startsWith('/') ? '/' : '.');
        contentsOnly = true;
      }
      const target = expandHome(raw, t.tilde, ctx.home);
      // A folder without a recursive flag cannot be removed (rm refuses), so
      // only the glob-contents shape counts there.
      if (!recursive && !contentsOnly) continue;
      if (base === null && !P.isAbsolute(target)) {
        const onlyDots = target.split(/[\\/]/).every((s) => s === '.' || s === '..' || s === '');
        if (onlyDots) return `removes ${t.value} after changing to a folder that cannot be known in advance`;
        continue;
      }
      const abs = P.resolve(base ?? ctx.cwd, target);
      const why = protectedReason(abs);
      if (why) return contentsOnly ? `removes everything inside ${why}` : `removes ${why}`;
    }
  }
  return null;
}

/** `$HOME`, `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%` at the start of a word. */
function homeVariable(value: string): RegExpMatchArray | null {
  return value.match(/^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i);
}

export function expandHome(value: string, tilde: boolean, home: string): string {
  if (tilde && (value === '~' || value.startsWith('~/') || value.startsWith('~\\'))) return home + value.slice(1);
  const m = homeVariable(value);
  if (m) return home + value.slice(m[0].length);
  return value;
}
