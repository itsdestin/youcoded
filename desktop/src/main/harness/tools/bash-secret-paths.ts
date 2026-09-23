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
import { tokenize, expandHome, commandIndex, stripHeredocBodies, type Op, type Word } from './shell-words';

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
const METADATA_ONLY = new Set(['ls', 'dir', 'test', '[', '[[', 'stat', 'wc', 'du']);
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

/** The first secret path `command` names, or null when it names none. */
export function secretPathIn(command: string, ctx: SecretPathContext): string | null {
  const win = process.platform === 'win32';
  const home = ctx.home ?? os.homedir();
  const base = ctx.shellCwd ?? ctx.cwd;

  const isSecret = (raw: string, tilde: boolean): boolean => {
    if (!raw || raw.includes('://')) return false;
    const expanded = expandHome(raw, tilde, home);
    const abs = path.resolve(base, expanded);
    if (checkPathGuard(abs, ctx.cwd).kind !== 'deny') return false;
    return !DOTENV_TEMPLATE.test(path.basename(abs));
  };

  const commandHits = (words: Word[]): string | null => {
    const w = commandIndex(words);
    // Assignments before the command (`AWS_SHARED_CREDENTIALS_FILE=~/.aws/credentials aws …`).
    for (const a of words.slice(0, w)) {
      const value = a.value.slice(a.value.indexOf('=') + 1);
      if (isSecret(value, value.startsWith('~'))) return value;
    }
    if (w >= words.length) return null;
    const name = path.basename(words[w].value).toLowerCase();
    if (METADATA_ONLY.has(name)) return null;
    const args = words.slice(w + 1);
    let lastPlain = -1;
    if (DEST_LAST.has(name)) args.forEach((a, i) => { if (!a.value.startsWith('-')) lastPlain = i; });
    let skipNext: 'text' | 'write' | null = null;
    // The command word itself counts (running a script kept in ~/.ssh).
    const candidates: Array<{ raw: string; tilde: boolean }> = [];
    const consider = (word: Word, index: number) => {
      let raw = word.value;
      if (skipNext) { skipNext = null; return; }
      if (/^\d*<<<?/.test(raw)) { if (raw.replace(/^\d*<<<?-?/, '') === '') skipNext = 'text'; return; }
      const write = raw.match(WRITE_REDIRECT);
      if (write) { if (raw === write[0]) skipNext = 'write'; return; }
      const read = raw.match(READ_REDIRECT);
      if (read) {
        raw = raw.slice(read[0].length);
        if (raw === '') return; // the next word is read — it is checked on its own
        candidates.push({ raw, tilde: raw.startsWith('~') });
        return;
      }
      if (index < 0) { candidates.push({ raw, tilde: word.tilde }); return; }
      if (TEXT_COMMANDS.has(name) || (WRITE_ALL.has(name) && !raw.startsWith('-'))) return;
      if (DEST_LAST.has(name) && index === lastPlain && index > 0) return;
      if (raw.startsWith('-')) {
        const eq = raw.indexOf('=');
        const flag = eq === -1 ? raw : raw.slice(0, eq);
        if (TEXT_VALUE_FLAGS.has(flag)) { if (eq === -1) skipNext = 'text'; return; }
        if (eq !== -1) candidates.push({ raw: raw.slice(eq + 1), tilde: raw[eq + 1] === '~' });
        return;
      }
      candidates.push({ raw, tilde: word.tilde });
    };
    consider(words[w], -1);
    args.forEach((a, i) => consider(a, i));
    for (const c of candidates) if (isSecret(c.raw, c.tilde)) return c.raw;
    return null;
  };

  const analyse = (text: string): string | null => {
    const { tokens, nested } = tokenize(stripHeredocBodies(text), !win);
    let words: Word[] = [];
    for (const tok of [...tokens, { op: 'end' } as Op]) {
      if (!(tok as Op).op) { words.push(tok as Word); continue; }
      const hit = words.length ? commandHits(words) : null;
      words = [];
      if (hit) return hit;
    }
    for (const inner of nested) {
      const hit = analyse(inner);
      if (hit) return hit;
    }
    return null;
  };

  return analyse(command);
}
