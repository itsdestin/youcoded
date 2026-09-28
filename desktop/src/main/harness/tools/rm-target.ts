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
import { tokenize, expandHome, homeVariable, commandIndex, splitHeredocs, inlineShellScript, baseName, SHELL_FEEDERS, type Op, type Word } from './shell-words';

export interface RmTargetContext {
  /** The workspace (session) root. Removing it or any folder above it is protected. */
  cwd: string;
  /** Where the next Bash call starts (the persisted shell cwd); defaults to `cwd`. */
  shellCwd?: string;
  home: string;
  /** Injected for tests; defaults to the running platform. */
  platform?: NodeJS.Platform;
}

const REMOVERS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd']);
const CHANGE_DIR = new Set(['cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl']);

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

/** POSIX rm's single-letter flags. A cluster made only of these (`-rf`,
 *  `-rfvI`, `-dfrv`, any length) is POSIX; anything else single-dash is a
 *  PowerShell word (`-Force`, `-Recurse`), where only -Recurse means it. */
const RM_SHORT_FLAGS = /^-[rRfviIdP]+$/;

function isRecursiveFlag(flag: string): boolean {
  const lower = flag.toLowerCase();
  // GNU accepts any unambiguous prefix of a long option: `--rec` is `--recursive`.
  if (lower === '/s' || (lower.length >= 3 && '--recursive'.startsWith(lower))) return true;
  if (RM_SHORT_FLAGS.test(flag)) return /r/i.test(flag);
  return lower.startsWith('-rec');
}

/** How sure the floor is — the card's one line is chosen from this so it is
 *  always true (review N11): 'removal' = the text proves it; 'removal-if-empty'
 *  = only if a variable is empty; 'removal-unknown' = the folder is a command's
 *  output or reached by a cd the text cannot follow.
 *  WHY not exported: only RmVerdict below names it; the export tipped the
 *  combined branches over the knip ratchet (combined-branch fix). */
type RmFloorKind = 'removal' | 'removal-if-empty' | 'removal-unknown';
export interface RmVerdict { reason: string; kind: RmFloorKind }

/** Why `command` would remove a protected directory, or null when it would not.
 *  The text is shown as the reason for the card, so every branch states only
 *  what the command text proves (docs/error-message-standards.md). */
export function destructiveRmReason(command: string, ctx: RmTargetContext): string | null {
  return destructiveRmVerdict(command, ctx)?.reason ?? null;
}

export function destructiveRmVerdict(command: string, ctx: RmTargetContext): RmVerdict | null {
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

  /** Judge one target as literally written (variables already resolved or
   *  removed by the caller). `glob` marks unquoted glob characters. */
  const judgeLiteral = (value: string, glob: boolean[], tilde: boolean, recursive: boolean, base: string | null): RmVerdict | null => {
    let raw = value;
    let contentsOnly = false;
    // `~/*/` and `dir/` name the same thing without the trailing slash.
    while (value.length > 1 && /[\\/]$/.test(value)) { value = value.slice(0, -1); glob = glob.slice(0, -1); }
    if (glob.includes(true)) {
      const segs = value.split(win ? /[\\/]/ : '/');
      const last = segs[segs.length - 1];
      const prefixHasGlob = glob.slice(0, value.length - last.length).includes(true);
      if (prefixHasGlob || !WHOLE_CONTENTS.test(last)) return null; // e.g. `*.log`, `src/*/dist`
      raw = segs.slice(0, -1).join('/') || (value.startsWith('/') ? '/' : '.');
      contentsOnly = true;
    }
    const target = expandHome(raw, tilde, ctx.home);
    // A folder without a recursive flag cannot be removed (rm refuses), so
    // only the glob-contents shape counts there.
    if (!recursive && !contentsOnly) return null;
    if (base === null && !P.isAbsolute(target)) {
      const onlyDots = target.split(/[\\/]/).every((s) => s === '.' || s === '..' || s === '');
      return onlyDots ? { reason: `removes ${value} after changing to a folder that can't be known in advance`, kind: 'removal-unknown' } : null;
    }
    const why = protectedReason(P.resolve(base ?? ctx.cwd, target));
    if (!why) return null;
    return { reason: contentsOnly ? `removes everything inside ${why}` : `removes ${why}`, kind: 'removal' };
  };

  const judgeTarget = (word: Word, recursive: boolean, base: string | null): RmVerdict | null => {
    // `$PWD` / `${PWD}` is the current folder: read it as `.`.
    const pwd = word.value.match(/^(\$PWD|\$\{PWD(?::?[-?=+][^}]*)?\})(?=$|\/)/);
    const t: Word = pwd
      ? {
          ...word,
          value: `.${word.value.slice(pwd[0].length)}`,
          glob: [false, ...word.glob.slice(pwd[0].length)],
          vars: word.vars.filter((v) => v.start !== 0).map((v) => ({ ...v, start: v.start - pwd[0].length + 1, end: v.end - pwd[0].length + 1 })),
        }
      : word;
    // A command's output (`rm -rf $(pwd)`) cannot be resolved by reading the
    // text. Ask when it LEADS the path and the removal is recursive or wipes a
    // folder's contents — `rm -f $(find …)` (plain files) stays quiet.
    if (t.subs.some((s) => s.start === 0)) {
      const last = t.value.split(/[\\/]/).pop() ?? '';
      const wipes = t.glob.includes(true) && WHOLE_CONTENTS.test(last);
      return recursive || wipes
        ? { reason: `removes a path given by a command's output (${t.value}), which can't be checked before it runs`, kind: 'removal-unknown' }
        : null;
    }
    // A leading $HOME / ${HOME} is the home folder, not an unknown.
    const hv = homeVariable(t.value);
    const unguarded = t.vars.filter((v) => !v.guarded && !(hv && v.start === 0));
    if (unguarded.length === 0) return judgeLiteral(t.value, t.glob, t.tilde, recursive, base);
    // A bare variable (`rm "$f"`, `rm -f -- "$@"`) removes NOTHING when empty,
    // so it is never asked about. What is dangerous is text AFTER an empty
    // variable: `"$DIR"/` becomes `/`, `$X*` becomes `*`. Judge that empty
    // reading and, if it lands on a protected folder, say exactly that.
    const only = unguarded.length === 1 && unguarded[0].start === 0 && unguarded[0].end === t.value.length;
    if (only) return null;
    let value = '';
    const glob: boolean[] = [];
    for (let i = 0; i < t.value.length; i++) {
      if (unguarded.some((v) => i >= v.start && i < v.end)) continue;
      value += t.value[i];
      glob.push(t.glob[i]);
    }
    if (value === '') return null;
    const why = judgeLiteral(value, glob, t.tilde, recursive, base);
    if (!why) return null;
    const names = unguarded.map((v) => t.value.slice(v.start, v.end)).join(' and ');
    return { reason: `${why.reason} if ${names} is empty (the command reads ${t.value})`, kind: why.kind === 'removal' ? 'removal-if-empty' : why.kind };
  };

  const analyse = (source: string, startBase: string | null): RmVerdict | null => {
    // Heredoc bodies are text unless a shell runs them (review N9).
    const { text, bodies } = splitHeredocs(source);
    const { tokens, nested } = tokenize(text, !win);
    // Where relative targets resolve: the shell's folder, moved by any `cd`
    // earlier in the line. null = moved somewhere a reader cannot know.
    // `( … )` is a subshell: a cd inside it does not outlive the `)`.
    let base: string | null = startBase;
    const stack: Array<string | null> = [];
    let words: Word[] = [];
    // Variables this line set to a fresh temp folder (`tmp=$(mktemp -d)`):
    // `cd "$tmp" && rm -rf *` then clears that temp folder, a known place —
    // the everyday idiom must not read as "a folder that can't be known".
    const tempVars = new Set<string>();
    const runCommand = (): RmVerdict | null => {
      const cmd = words;
      words = [];
      for (const a of cmd) {
        const m = a.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=\$\(mktemp(\s[^)]*)?\)$/);
        if (m) tempVars.add(m[1]);
      }
      const w = commandIndex(cmd);
      if (w >= cmd.length) return null;
      const name = baseName(cmd[w].value);
      const args = cmd.slice(w + 1);
      // `bash -c 'rm -rf ~'`, `sudo sh -c -- '…'`, `eval "…"`: the script is a
      // command line of its own, run from this folder (review N1).
      const script = inlineShellScript(name, args);
      if (script !== null) return analyse(script, base);
      if (CHANGE_DIR.has(name)) {
        const dest = args.find((a) => !a.value.startsWith('-') || a.value === '-');
        if (name === 'popd' || dest?.value === '-') base = null; // the previous folder is not in the text
        else if (!dest) base = ctx.home;
        else {
          const to = expandHome(dest.value, dest.tilde, ctx.home);
          const unknown = (dest.vars.length > 0 || dest.subs.length > 0) && to === dest.value;
          const tempName = dest.value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
          if (tempName && tempVars.has(tempName)) base = P.resolve(P.sep, 'tmp', `mktemp-${tempName}`);
          else if (unknown) base = null;
          else if (base !== null || P.isAbsolute(to)) base = P.resolve(base ?? ctx.cwd, to);
        }
        return null;
      }
      if (!REMOVERS.has(name)) return null;
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
        const why = judgeTarget(t, recursive, base);
        if (why) return why;
      }
      return null;
    };
    for (const tok of tokens) {
      const op = (tok as Op).op;
      if (!op) { words.push(tok as Word); continue; }
      const why = runCommand();
      if (why) return why;
      if (op === '(') stack.push(base);
      else if (op === ')' && stack.length) base = stack.pop()!;
    }
    const last = runCommand();
    if (last) return last;
    // Substitutions run as commands of their own, from the same folder.
    for (const inner of nested) {
      const why = analyse(inner, startBase);
      if (why) return why;
    }
    for (const h of bodies) {
      if (!SHELL_FEEDERS.has(h.feeder)) continue;
      const why = analyse(h.body, startBase);
      if (why) return why;
    }
    return null;
  };

  return analyse(command, ctx.shellCwd ?? ctx.cwd);
}
