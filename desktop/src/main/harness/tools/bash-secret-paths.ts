// The secret-path floor for Bash: a check that sits BELOW every permission rule.
//
// WHY this exists (roadmap: "The assistant refuses to open ~/.ssh or .env with
// its file tools, but `cat` through a shell command reads the same file").
// Read/Grep/Glob hard-refuse credential files (guards.ts checkPathGuard), but
// Bash never looked at the paths inside its command, so `cat ~/.ssh/id_rsa` ran
// — silently, whenever a saved "Always allow" covered the command. Destin,
// 2026-09-23 (option B): a Bash command that names a secret path ALWAYS gets an
// approval card with no "Always allow", even when a saved grant covers it. It is
// an ask, not a refusal, because real work needs these files too
// (`ssh -i ~/.ssh/key host`, `chmod 600 ~/.ssh/config`) and the person can say yes.
//
// ONE LIST. The decision is checkPathGuard's own 'deny' verdict — the exact set
// the file tools refuse (isSensitivePath + the home credential folders +
// credential-paths.ts). Never add a second list here: the two would drift, and
// a path the file tools refuse must never be one Bash can read without asking.
//
// What counts as a path reference (reviewed 2026-09-23 for noise and misses):
//  - every word that could be READ as a file: arguments, `--flag=value` values,
//    `KEY=value` assignments, the command word itself, and input redirects
//    (`cat <.env`, `$(<.env)` — substitutions are read as commands of their own);
//  - NOT a word that is only text or a pattern: `echo`/`printf` arguments, the
//    value of a message or pattern flag (`-m ".env"`, `--exclude=.env`,
//    `find -name .env`), heredoc delimiters;
//  - NOT a file that is only WRITTEN: an output redirect (`>> .gitignore`,
//    `> .env`), `tee`/`touch` targets, and the destination of `cp`/`mv`/`ln`/
//    `install`/`rsync`/`scp`. Writing a secret file exposes nothing; reading it
//    does. `cp .env backup/` still asks — there `.env` is the source;
//  - NOT a dotenv TEMPLATE (`.env.example`, `.sample`, `.template`, `.dist`):
//    those are committed on purpose and hold no secrets. This exemption is the
//    Bash check's only; the file tools' shared list is unchanged.
// The list itself matches path segments and file names, never substrings, so
// `printenv`, `env:check` and `.envrc-template` never match. URLs are skipped.
//
// NOT a sandbox: a command that builds the path at run time (variables, base64,
// a script file) passes by construction. Same posture as guards.ts.
import * as os from 'os';
import * as path from 'path';
import { checkPathGuard } from './guards';
import {
  tokenize, expandHome, commandIndex, splitHeredocs, inlineShellScript, inlineInterpreterScript, baseName,
  SHELL_FEEDERS, INTERPRETERS, type Op, type Word,
} from './shell-words';

export interface SecretPathContext {
  /** The workspace (session) root. */
  cwd: string;
  /** Where the next Bash call starts (the persisted shell cwd); defaults to `cwd`. */
  shellCwd?: string;
  /** Injected for tests; defaults to the real home folder. */
  home?: string;
}

/** Words that are text, not files. */
const TEXT_COMMANDS = new Set(['echo', 'printf']);
/** Commands that only ask whether a file exists, or show its name, size or
 *  counts — never its contents. WHY (2026-09-23): the setup idiom
 *  `[ -f .env ] || cp .env.example .env` forced a card on every run (and a
 *  stop in Full auto) while protecting nothing. An explicit ALLOWLIST: any
 *  command not named here is judged normally, so an unknown one falls toward
 *  asking. `wc` is on it deliberately — a byte, word or line count is not the
 *  secret. Judged per simple command, so `ls .env && cat .env` still asks. */
const METADATA_ONLY = new Set(['ls', 'dir', 'test', '[', '[[', 'stat', 'wc', 'du',
  // Deleting a file never shows its contents; the removal floor judges these.
  'rm', 'rmdir', 'unlink']);
/** Every argument is a file that is only written. */
const WRITE_ALL = new Set(['tee', 'touch']);
/** The LAST argument is a destination that is only written. */
const DEST_LAST = new Set(['cp', 'mv', 'ln', 'install', 'rsync', 'scp']);
/** Flags whose value is a message or a pattern, never a file to read. */
const TEXT_VALUE_FLAGS = new Set([
  '-m', '--message', '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex',
  '--exclude', '--include', '--exclude-dir', '--include-dir', '--exclude-from', '--ignore', '--glob', '--iglob', '-g',
]);
const DOTENV_TEMPLATE = /^\.env(rc)?(\..+)?\.(example|sample|template|dist|tpl)$/i;
/** `>`, `>>`, `2>`, `&>`, `>|` — what follows is written. */
const WRITE_REDIRECT = /^(\d*|&)(>>?|>\|)&?/;
/** `<` — what follows is read. (`<<`/`<<<` are heredoc text, handled apart.) */
const READ_REDIRECT = /^\d*<(?![<&])/;

/** Commands that run another command on names they read from their input. */
const INPUT_RUNNERS = new Set(['xargs', 'parallel']);
/** find actions that run a command, ended by `;` or `+`. */
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** find actions that WRITE the listing to a file (the value is written, not read). */
const FIND_WRITE = new Set(['-fprint', '-fprint0', '-fprintf', '-fls']);
const FIND_NAME = new Set(['-name', '-iname']);
const FIND_PATH = new Set(['-path', '-ipath', '-wholename', '-iwholename']);
/** grep-family commands: the first plain argument is the PATTERN, not a file,
 *  unless the pattern came from -e/-f (review N10). */
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
/** grep flags that take a separate value which is not a file to read. */
const GREP_VALUE_FLAGS = new Set(['-e', '--regexp', '-m', '--max-count', '-A', '-B', '-C', '--context', '-t', '--type', '-T', '--type-not']);
/** git subcommands that only NAME a file (stage it, untrack it, ask whether
 *  it is ignored) — they never print its contents (review N10). */
const GIT_NAME_ONLY = new Set(['add', 'rm', 'mv', 'check-ignore', 'check-attr', 'ls-files', 'update-index', 'restore', 'reset']);
/** git subcommands that print a blob named `rev:path` (review N3). */
const GIT_SHOWS_BLOB = new Set(['show', 'cat-file', 'archive', 'grep']);
/** Secret file names and paths a find pattern is tested against, to tell
 *  `-name '*.ts'` (can never match one) from `-name '.env*'` (can). */
const SECRET_NAME_SAMPLES = ['.env', '.env.local', '.env.production', '.envrc', '.netrc', '_netrc', '.credentials.json', '.git-credentials', '.pgpass'];
const SECRET_PATH_SAMPLES = [...SECRET_NAME_SAMPLES, '.ssh/id_rsa', '.ssh/config', '.aws/credentials', '.gnupg/secring.gpg', '.config/gh/hosts.yml'];

/** fnmatch-style glob → regex source (`*`, `?`, `[…]`). `isGlob(i)` says
 *  which characters are unquoted globs; `slashSafe` keeps `*`/`?` inside one
 *  path segment (shell globbing), otherwise they cross `/` (find -path). */
function globSource(pattern: string, isGlob: (i: number) => boolean = () => true, slashSafe = false): string {
  let rx = '';
  const any = slashSafe ? '[^/]' : '.';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (!isGlob(i) && '*?['.includes(c)) { rx += `\\${c}`; continue; }
    // Shell globbing never matches a leading dot with `*`, `?` or `[…]`:
    // `rm *` does not reach `.env`, only `.*` / `.e*` do.
    if (slashSafe && '*?['.includes(c) && (i === 0 || pattern[i - 1] === '/')) rx += '(?!\\.)';
    if (c === '*') rx += `${any}*`;
    else if (c === '?') rx += any;
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) { rx += '\\['; continue; }
      rx += `[${pattern.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = close;
    } else rx += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return rx;
}
function globRegex(pattern: string, caseless: boolean): RegExp {
  return new RegExp(`^${globSource(pattern)}$`, caseless ? 'i' : '');
}

const plainWord = (value: string): Word => ({ value, glob: [...value].map(() => false), vars: [], subs: [], tilde: value.startsWith('~') });

/** A secret the command reads, and how sure the check is: 'secret-path' when
 *  the command names the file; 'secret-maybe' when it could match one (a glob,
 *  a find with no usable filter, names piped from such a find). The card's
 *  wording is chosen from this so it is always true (review N11). */
export interface SecretHit { path: string; kind: 'secret-path' | 'secret-maybe' }

/** The first secret path `command` names, or null when it names none. */
export function secretPathIn(command: string, ctx: SecretPathContext): string | null {
  return secretPathVerdict(command, ctx)?.path ?? null;
}

export function secretPathVerdict(command: string, ctx: SecretPathContext): SecretHit | null {
  const win = process.platform === 'win32';
  const home = ctx.home ?? os.homedir();
  const base = ctx.shellCwd ?? ctx.cwd;
  const sure = (p: string): SecretHit => ({ path: p, kind: 'secret-path' });
  const maybe = (p: string): SecretHit => ({ path: p, kind: 'secret-maybe' });

  const isSecret = (raw: string, tilde: boolean): boolean => {
    if (!raw || raw.includes('://')) return false;
    const expanded = expandHome(raw, tilde, home);
    const abs = path.resolve(base, expanded);
    if (checkPathGuard(abs, ctx.cwd).kind !== 'deny') return false;
    return !DOTENV_TEMPLATE.test(path.basename(abs));
  };

  /** A word with unquoted glob characters (`.env*`, `~/.ss?/id_rsa`): could
   *  the shell expand it to a secret file? Tested against sample secret paths
   *  under the current folder and the home folder (review N5). */
  const globCouldMatch = (word: Word): boolean => {
    if (!word.glob.includes(true)) return false;
    const v = word.value;
    const tildeHome = word.tilde && (v === '~' || v.startsWith('~/'));
    const rel = tildeHome ? v.slice(2) : v;
    const offset = tildeHome ? 2 : 0;
    const prefix = tildeHome ? `${home}/` : v.startsWith('/') ? '' : `${base}/`;
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`^${esc(prefix)}${globSource(rel, (i) => word.glob[i + offset], true)}$`);
    for (const root of [base, home]) {
      for (const sample of SECRET_PATH_SAMPLES) {
        const candidate = path.join(root, sample);
        if (rx.test(candidate) && isSecret(candidate, false)) return true;
      }
    }
    return false;
  };

  /** For a find command: a secret its `{}` could stand for, or null when its
   *  filters provably match none. Filters it cannot judge (no name filter,
   *  `-regex`) count as "could be a secret" — falling toward asking. */
  const findSecretMatch = (args: Word[]): SecretHit | null => {
    const starts: string[] = [];
    let i = 0;
    for (; i < args.length && !/^[-(!]/.test(args[i].value); i++) starts.push(args[i].value);
    if (starts.length === 0) starts.push('.');
    for (const s of starts) if (isSecret(s, s.startsWith('~'))) return sure(s);
    let filtered = false;
    let unjudgeable = false;
    for (; i < args.length; i++) {
      const flag = args[i].value;
      const value = args[i + 1]?.value;
      if (/^-i?regex$/.test(flag)) { unjudgeable = true; continue; }
      if (value === undefined || !(FIND_NAME.has(flag) || FIND_PATH.has(flag))) continue;
      filtered = true;
      const rx = globRegex(value, flag.startsWith('-i'));
      const samples = FIND_NAME.has(flag) ? SECRET_NAME_SAMPLES : SECRET_PATH_SAMPLES;
      for (const sample of samples) {
        const subject = FIND_NAME.has(flag) ? sample : `./${sample}`;
        if (!rx.test(subject)) continue;
        const candidate = path.join(starts[0], sample);
        if (isSecret(candidate, candidate.startsWith('~'))) return value === sample ? sure(candidate) : maybe(candidate);
      }
    }
    if (!filtered || unjudgeable) return maybe(path.join(starts[0], '.env'));
    return null;
  };

  /** Does a command's OUTPUT name a secret file? For the left side of a pipe
   *  feeding xargs/parallel: `find . -name .env | xargs cat`, `ls ~/.ssh |
   *  xargs …`, and — like `-exec` — `find . -type f | xargs cat` (review N6). */
  const namesSecret = (words: Word[]): SecretHit | null => {
    const w = commandIndex(words);
    if (w >= words.length) return null;
    const name = baseName(words[w].value);
    const args = words.slice(w + 1);
    if (name === 'find') return findSecretMatch(args);
    for (const a of args) if (!a.value.startsWith('-') && isSecret(a.value, a.tilde)) return sure(a.value);
    return null;
  };

  /** Secret path literals inside an interpreter's inline script (review N4):
   *  `python -c "open('.env')"`, `node -e "fs.readFileSync('.env')"`. */
  const scriptNamesSecret = (script: string): SecretHit | null => {
    for (const token of script.split(/[\s'"`(),;+[\]{}<>]+/)) {
      if (token && isSecret(token, token.startsWith('~'))) return sure(token);
    }
    return null;
  };

  const commandHits = (words: Word[], piped: SecretHit | null = null): SecretHit | null => {
    const w = commandIndex(words);
    // Assignments before the command (`AWS_SHARED_CREDENTIALS_FILE=~/.aws/credentials aws …`).
    for (const a of words.slice(0, w)) {
      const value = a.value.slice(a.value.indexOf('=') + 1);
      if (isSecret(value, value.startsWith('~'))) return sure(value);
    }
    if (w >= words.length) return null;
    const name = baseName(words[w].value);
    const args = words.slice(w + 1);
    // WHY (2026-09-23): `find -exec`, `xargs`, `sh -c`/`eval` and interpreter
    // one-liners run a command the plain word scan never looked inside — an
    // easy route around this check. Each is judged like a top-level command.
    //
    // xargs/parallel reading secret names from a pipe: the wrapped command
    // receives them as arguments, so a reading command there reads secrets.
    const runner = words.slice(0, w).some((x) => INPUT_RUNNERS.has(baseName(x.value)));
    if (runner && piped && !METADATA_ONLY.has(name) && !TEXT_COMMANDS.has(name)) return piped;
    if (METADATA_ONLY.has(name)) return null;
    const shellScript = inlineShellScript(name, args);
    if (shellScript !== null) return analyse(shellScript);
    const interpreterScript = inlineInterpreterScript(name, args);
    if (interpreterScript !== null) {
      const hit = scriptNamesSecret(interpreterScript);
      if (hit) return hit;
    }
    if (name === 'find') {
      // A find that runs nothing only lists names — metadata, like ls. Each
      // -exec/-execdir/-ok/-okdir command is judged with `{}` standing for a
      // secret the filters could match (none when they provably match none).
      const match = findSecretMatch(args);
      for (let i = 0; i < args.length; i++) {
        if (FIND_WRITE.has(args[i].value)) { i++; continue; } // writes the listing to a file
        if (!FIND_EXEC.has(args[i].value)) continue;
        const sub: Word[] = [];
        for (i++; i < args.length && args[i].value !== ';' && args[i].value !== '+'; i++) {
          const v = args[i].value;
          sub.push(v.includes('{}') ? plainWord(v.split('{}').join(match ? match.path : 'found-file')) : args[i]);
        }
        const hit = sub.length ? commandHits(sub) : null;
        if (hit) return match && match.kind === 'secret-maybe' && hit.path === match.path ? match : hit;
      }
      return null;
    }
    // git: some subcommands only name a file; `git show rev:path` prints one.
    let gitBlob = false;
    if (name === 'git') {
      const sub = args.find((a) => !a.value.startsWith('-'))?.value ?? '';
      if (GIT_NAME_ONLY.has(sub)) return null;
      gitBlob = GIT_SHOWS_BLOB.has(sub);
    }
    let lastPlain = -1;
    // `cp -t DIR src…` names the destination by flag, so no LAST argument is one.
    const targetFlag = args.some((a) => a.value === '-t' || a.value.startsWith('--target-directory'));
    if (DEST_LAST.has(name) && !targetFlag) args.forEach((a, i) => { if (!a.value.startsWith('-')) lastPlain = i; });
    // grep's first plain argument is its pattern — unless -e/-f supplied one.
    const grep = GREPS.has(name);
    let grepPatternPending = grep && !args.some((a) => /^(-e|--regexp|-f|--file)(=|$)/.test(a.value) || /^-[a-zA-Z]*[ef]$/.test(a.value));
    let skipNext: 'text' | 'write' | 'read' | null = null;
    const candidates: Array<{ raw: string; tilde: boolean; word?: Word }> = [];
    const push = (raw: string, tilde: boolean, word?: Word) => {
      candidates.push({ raw, tilde, word });
      // `@file` forms (curl -d @.env, -F f=@.env) read the named file (N2);
      // `key=value` operands (dd if=.env) name a file after the `=` (N7);
      // `rev:path` names a file inside git history (N3).
      if (raw.startsWith('@')) candidates.push({ raw: raw.slice(1), tilde: raw[1] === '~' });
      const at = raw.indexOf('=@');
      if (at !== -1) candidates.push({ raw: raw.slice(at + 2), tilde: raw[at + 2] === '~' });
      const eq = raw.indexOf('=');
      if (eq > 0 && !raw.startsWith('-')) candidates.push({ raw: raw.slice(eq + 1), tilde: raw[eq + 1] === '~' });
      const colon = raw.indexOf(':');
      if (gitBlob && colon !== -1) candidates.push({ raw: raw.slice(colon + 1), tilde: false });
    };
    const consider = (word: Word, index: number) => {
      let raw = word.value;
      if (skipNext === 'read') { skipNext = null; push(raw, word.tilde, word); return; }
      if (skipNext) { skipNext = null; return; }
      if (/^\d*<<<?/.test(raw)) { if (raw.replace(/^\d*<<<?-?/, '') === '') skipNext = 'text'; return; }
      const write = raw.match(WRITE_REDIRECT);
      if (write) { if (raw === write[0]) skipNext = 'write'; return; }
      const read = raw.match(READ_REDIRECT);
      if (read) {
        raw = raw.slice(read[0].length);
        if (raw === '') { skipNext = 'read'; return; } // the next word is read, whatever the command
        push(raw, raw.startsWith('~'));
        return;
      }
      // `cat<.env` with no spaces: what follows the `<` is read.
      const lt = raw.indexOf('<');
      if (lt > 0 && raw[lt + 1] !== '<') push(raw.slice(lt + 1), raw[lt + 1] === '~');
      if (index < 0) { push(raw, word.tilde, word); return; }
      if (TEXT_COMMANDS.has(name) || (WRITE_ALL.has(name) && !raw.startsWith('-'))) return;
      if (DEST_LAST.has(name) && index === lastPlain && index > 0) return;
      if (raw.startsWith('-')) {
        const eq = raw.indexOf('=');
        const flag = eq === -1 ? raw : raw.slice(0, eq);
        if (TEXT_VALUE_FLAGS.has(flag) || (grep && GREP_VALUE_FLAGS.has(flag))) { if (eq === -1) skipNext = 'text'; return; }
        if (eq !== -1) push(raw.slice(eq + 1), raw[eq + 1] === '~');
        return;
      }
      if (grepPatternPending) { grepPatternPending = false; return; }
      push(raw, word.tilde, word);
    };
    consider(words[w], -1);
    args.forEach((a, i) => consider(a, i));
    for (const c of candidates) if (isSecret(c.raw, c.tilde)) return sure(c.raw);
    for (const c of candidates) if (c.word && globCouldMatch(c.word)) return maybe(c.raw);
    return null;
  };

  function analyse(source: string): SecretHit | null {
    // Heredoc bodies are text, unless a shell runs them or an interpreter
    // reads them as its script.
    const { text, bodies } = splitHeredocs(source);
    const { tokens, nested } = tokenize(text, !win);
    let words: Word[] = [];
    // What the command on the left of a `|` names, for the one on its right.
    let piped: SecretHit | null = null;
    for (const tok of [...tokens, { op: 'end' } as Op]) {
      const op = (tok as Op).op;
      if (!op) { words.push(tok as Word); continue; }
      const hit = words.length ? commandHits(words, piped) : null;
      if (hit) return hit;
      piped = op === '|' && words.length ? namesSecret(words) : null;
      words = [];
    }
    for (const inner of nested) {
      const hit = analyse(inner);
      if (hit) return hit;
    }
    for (const h of bodies) {
      const hit = SHELL_FEEDERS.has(h.feeder) ? analyse(h.body)
        : INTERPRETERS.has(h.feeder) ? scriptNamesSecret(h.body) : null;
      if (hit) return hit;
    }
    return null;
  }

  return analyse(command);
}
