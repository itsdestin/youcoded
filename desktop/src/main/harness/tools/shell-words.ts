// A small, honest reader of shell command text, shared by the two permission
// floors that sit below every rule: the removal-target floor (rm-target.ts) and
// the secret-path floor (bash-secret-paths.ts). Both need the SAME answer to
// "which words does this command have, and what will the shell do to them?",
// so they read it through one tokenizer rather than two that drift.
//
// It is not a shell. It knows quotes, backslash escapes, the operators that end
// one simple command, `$VAR` / `${VAR}` / `${VAR:?}`, and `$(…)` / backticks —
// enough to resolve the targets these checks care about. When it cannot know
// something (a variable's value, a command's output) it RECORDS that, so each
// floor can decide to fail toward asking with a reason that is true.

/** One `$NAME` / `${…}` expansion inside a word's value. */
interface VarSpan {
  /** Offsets into Word.value (end exclusive). The value keeps the raw text. */
  start: number;
  end: number;
  /** `${X:?}` / `${X?}`: the shell aborts when X is unset or empty, so it can
   *  never expand to nothing — a guarded variable is never "empty". */
  guarded: boolean;
}

/** One shell word, quotes removed, remembering what the shell would do to it. */
export interface Word {
  value: string;
  /** Per character of `value`: true where an UNQUOTED glob character sits. */
  glob: boolean[];
  /** Variable expansions, in order. Their raw text stays in `value`. */
  vars: VarSpan[];
  /** Command substitutions (`$(…)`, backticks). Their raw text stays in
   *  `value`; the inner command is also returned in Tokenized.nested. */
  subs: Array<{ start: number; end: number }>;
  /** The word starts with an unquoted `~`. */
  tilde: boolean;
  op?: undefined;
}
export interface Op { op: string }
type Token = Word | Op;

export interface Tokenized {
  tokens: Token[];
  /** The text of every `$(…)` and backtick substitution, to be read as a
   *  command of its own (so `x=$(rm -rf ~)` and `$(<.env)` are still seen). */
  nested: string[];
}

const GLOB_CHARS = new Set(['*', '?', '[']);
const SPECIAL_VAR = /[@*#?$!0-9-]/;

/** Index just past the `)` that closes a `$(` opened at `open` (the index of
 *  `(`). Quotes inside are skipped. Unbalanced → end of string. */
function closeParen(s: string, open: number): number {
  let depth = 1;
  let j = open + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === "'") { const k = s.indexOf("'", j + 1); j = k === -1 ? s.length : k + 1; continue; }
    if (ch === '"') {
      j++;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      j++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return j + 1;
    j++;
  }
  return s.length;
}

export function tokenize(command: string, backslashEscapes: boolean): Tokenized {
  const out: Token[] = [];
  const nested: string[] = [];
  let cur: Word | null = null;
  const start = (): Word => (cur ??= { value: '', glob: [], vars: [], subs: [], tilde: false });
  const push = (ch: string, isGlob = false) => { const w = start(); w.value += ch; w.glob.push(isGlob); };
  const pushRaw = (text: string) => { for (const ch of text) push(ch); };
  const end = () => { if (cur) out.push(cur); cur = null; };

  /** Read an expansion starting at `$` or a backtick at index i; append its
   *  raw text to the current word and record it. Returns the index after it,
   *  or -1 when the `$` is a literal dollar sign. */
  const expansion = (i: number): number => {
    const c = command[i];
    if (c === '`') {
      const close = command.indexOf('`', i + 1);
      const stop = close === -1 ? command.length : close + 1;
      nested.push(command.slice(i + 1, close === -1 ? command.length : close));
      const w = start(); const s = w.value.length; pushRaw(command.slice(i, stop)); w.subs.push({ start: s, end: w.value.length });
      return stop;
    }
    const next = command[i + 1];
    if (next === '(') {
      const stop = closeParen(command, i + 1);
      nested.push(command.slice(i + 2, Math.max(i + 2, stop - 1)));
      const w = start(); const s = w.value.length; pushRaw(command.slice(i, stop)); w.subs.push({ start: s, end: w.value.length });
      return stop;
    }
    let stop = -1;
    let guarded = false;
    if (next === '{') {
      const close = command.indexOf('}', i + 2);
      stop = close === -1 ? command.length : close + 1;
      guarded = /^\$\{[A-Za-z_0-9]+:?\?/.test(command.slice(i, stop));
    } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
      stop = i + 1;
      while (stop < command.length && /[A-Za-z0-9_]/.test(command[stop])) stop++;
      // PowerShell's `$env:NAME`.
      if (command.slice(i + 1, stop).toLowerCase() === 'env' && command[stop] === ':') {
        stop++;
        while (stop < command.length && /[A-Za-z0-9_]/.test(command[stop])) stop++;
      }
    } else if (next !== undefined && SPECIAL_VAR.test(next)) {
      stop = i + 2;
    }
    if (stop === -1) return -1;
    const w = start(); const s = w.value.length; pushRaw(command.slice(i, stop));
    w.vars.push({ start: s, end: w.value.length, guarded });
    return stop;
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === ' ' || c === '\t') { end(); i++; continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')') { end(); out.push({ op: c }); i++; continue; }
    if (c === '&' || c === '|') {
      // `2>&1` / `&>file` keep their `&` inside the word; only a separator splits.
      const prev = command[i - 1];
      if (c === '&' && (prev === '>' || prev === '<' || command[i + 1] === '>')) { push(c); i++; continue; }
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
      pushRaw(close === -1 ? command.slice(i + 1) : command.slice(i + 1, close));
      i = close === -1 ? command.length : close + 1;
      continue;
    }
    if (c === '"') {
      start();
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) { push(command[i + 1]); i += 2; continue; }
        if (command[i] === '$' || command[i] === '`') {
          const next = expansion(i);
          if (next !== -1) { i = next; continue; }
        }
        push(command[i]);
        i++;
      }
      i++;
      continue;
    }
    if (c === '$' || c === '`') {
      const next = expansion(i);
      if (next !== -1) { i = next; continue; }
    }
    // An unquoted `#` starting a word begins a comment: the rest of the line is
    // not part of the command. WHY (review N8): `rm -rf build # clean ~` was
    // read as removing the home folder, and `npm test # needs .env` as naming
    // a secret file.
    if (c === '#' && !cur) {
      const nl = command.indexOf('\n', i);
      i = nl === -1 ? command.length : nl;
      continue;
    }
    if (c === '~' && !cur) start().tilde = true;
    push(c, GLOB_CHARS.has(c));
    i++;
  }
  end();
  return { tokens: out, nested };
}

/** A heredoc body and the command it is fed to. */
export interface HeredocBody { body: string; feeder: string }

/** Commands that RUN a heredoc body as shell commands (`bash <<EOF`,
 *  `sudo sh <<EOF`, `ssh host <<EOF`). Any other feeder (`cat > notes.md`,
 *  `git commit -m "$(cat <<EOF …)"`) receives the body as TEXT. */
export const SHELL_FEEDERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ssh']);
/** Interpreters whose inline script can open files (`python3 - <<EOF`, `-c`). */
export const INTERPRETERS = new Set(['python', 'python3', 'python2', 'node', 'ruby', 'perl', 'deno', 'bun', 'php']);

/** Split heredoc BODIES (the lines after `<<EOF` up to the `EOF` line) out of
 *  the text, each with the command it feeds. WHY (review N9): a body is text
 *  fed to a command, not a command — `cat > notes.md <<EOF … rm -rf ~ … EOF`
 *  was read as removing the home folder — UNLESS the feeder runs it as a
 *  script, which the caller decides from `feeder`. Works on raw lines, so a
 *  heredoc inside `$(…)` is removed before the tokenizer ever sees it. */
export function splitHeredocs(text: string): { text: string; bodies: HeredocBody[] } {
  const lines = text.split('\n');
  const out: string[] = [];
  const bodies: HeredocBody[] = [];
  let open: { delimiter: string; feeder: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (open) {
      if (line.trim() === open.delimiter) { bodies.push({ body: open.lines.join('\n'), feeder: open.feeder }); open = null; }
      else open.lines.push(line);
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m && m.index !== undefined && !line.includes('<<<')) {
      // The feeder is the last simple command before `<<` on this line.
      const before = line.slice(0, m.index).split(/[;&|(`]|\$\(/).pop() ?? '';
      const words = tokenize(before, true).tokens.filter((t): t is Word => !(t as Op).op);
      const w = commandIndex(words);
      open = { delimiter: m[2], feeder: w < words.length ? baseName(words[w].value) : '', lines: [] };
    }
  }
  if (open) bodies.push({ body: open.lines.join('\n'), feeder: open.feeder });
  return { text: out.join('\n'), bodies };
}

/** The command's own name, as the shell finds it: `/usr/bin/sudo` → `sudo`. */
export function baseName(value: string): string {
  return (value.split(/[\\/]/).pop() ?? value).toLowerCase().replace(/\.exe$/, '');
}

/** The script a command runs as SHELL commands: `sh -c 'cmd'`, `bash -lc …`,
 *  `sh -c -- 'cmd'`, `eval "cmd"`. null when it runs none. Shared by both
 *  floors (review N1): `bash -c 'rm -rf ~'` must be read like `rm -rf ~`. */
export function inlineShellScript(name: string, args: Word[]): string | null {
  if (name === 'eval') return args.length ? args.map((a) => a.value).join(' ') : null;
  if (!SHELL_FEEDERS.has(name) || name === 'ssh') return null;
  const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.value));
  if (c === -1) return null;
  const script = args[c + 1]?.value === '--' ? args[c + 2] : args[c + 1];
  return script ? script.value : null;
}

/** The inline script an interpreter runs (`python -c`, `node -e/-p/--eval`,
 *  `ruby -e`, `perl -e/-E`, `deno eval`), or null. */
export function inlineInterpreterScript(name: string, args: Word[]): string | null {
  if (!INTERPRETERS.has(name)) return null;
  if (name === 'deno' && args[0]?.value === 'eval') return args[1]?.value ?? null;
  const flag = args.findIndex((a) => ['-c', '-e', '-E', '-p', '--eval', '--print', '-r'].includes(a.value));
  return flag !== -1 && args[flag + 1] ? args[flag + 1].value : null;
}

/** `$HOME`, `${HOME}`, `${HOME:?}` (and the other `${HOME:-…}` forms),
 *  `$env:USERPROFILE`, `%USERPROFILE%` at the start of a word. The guarded
 *  forms still expand to the home folder — `rm -rf "${HOME:?}"/` removes it. */
export function homeVariable(value: string): RegExpMatchArray | null {
  return value.match(/^(\$HOME|\$\{HOME(?::?[-?=+][^}]*)?\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i);
}

/** Replace a leading `~` (when the shell would expand it) or home variable
 *  with the home folder. Anything else is returned unchanged. */
export function expandHome(value: string, tilde: boolean, home: string): string {
  if (tilde && (value === '~' || value.startsWith('~/') || value.startsWith('~\\'))) return home + value.slice(1);
  const m = homeVariable(value);
  if (m) return home + value.slice(m[0].length);
  return value;
}

/** Leading shell keywords and grouping words that are not the command itself:
 *  `if x; then rm …`, `for …; do rm …`, `{ rm …; }`, `! rm …`.
 *  WHY not exported: only commandIndex below reads it; the export tipped the
 *  combined branches over the knip ratchet (combined-branch fix). */
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '!', 'time']);

/** Commands that run another command given as their arguments, with the flags
 *  of each that take a separate value, and how many plain arguments come
 *  before the wrapped command (`timeout 5 rm …` → 1). Exported (admin-command.ts
 *  review): the admin floor needs sudo's OWN value flags to strip them back out
 *  of `visibleSudoLines` — long forms added (review, admin-password design §4)
 *  because only the short letters were here before, so `sudo --user root cmd`
 *  read `root` as the command sudo runs, not `cmd`. */
export const WRAPPERS: Record<string, { valueFlags: string[]; positionals?: number }> = {
  sudo: {
    // `-R`/`--chroot` and `-T`/`--command-timeout` (review T1-3): confirmed
    // against `sudo --help`/`man sudo` (1.9.x) as two more real options that
    // take a separate value, missed in the first pass at this fix.
    valueFlags: [
      '-u', '-g', '-C', '-h', '-p', '-U', '-D', '-r', '-t', '-R', '-T',
      '--user', '--group', '--close-from', '--host', '--prompt', '--role', '--type', '--other-user',
      '--chdir', '--chroot', '--command-timeout',
    ],
  },
  doas: { valueFlags: ['-u', '-C'] },
  command: { valueFlags: [] },
  builtin: { valueFlags: [] },
  exec: { valueFlags: ['-a'] },
  nohup: { valueFlags: [] },
  time: { valueFlags: ['-f', '-o'] },
  nice: { valueFlags: ['-n'] },
  ionice: { valueFlags: ['-c', '-n', '-p'] },
  stdbuf: { valueFlags: ['-i', '-o', '-e'] },
  env: { valueFlags: ['-u', '-C', '-S'] },
  timeout: { valueFlags: ['-s', '-k'], positionals: 1 },
  xargs: { valueFlags: ['-I', '-n', '-P', '-L', '-s', '-d', '-a', '-E', '-e'] },
  parallel: { valueFlags: ['-j', '-S', '-a', '-I', '-d', '-N', '-n', '--jobs', '--sshlogin', '--arg-file', '--colsep'] },
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Index of the word that is the actual command, skipping `FOO=bar`
 *  assignments, shell keywords and wrappers (with their own arguments).
 *  `stopBefore` (admin-command.ts): a set of command words to STOP at rather
 *  than walk past, even though WRAPPERS lists them (WRAPPERS treats `sudo` as
 *  transparent so rm-target/bash-secret-paths can see what it runs — the admin
 *  floor needs the opposite: to see `sudo` itself as the command). */
export function commandIndex(words: Word[], stopBefore?: Set<string>): number {
  let w = 0;
  for (;;) {
    const before = w;
    while (w < words.length && ASSIGNMENT.test(words[w].value)) w++;
    while (w < words.length && SHELL_KEYWORDS.has(words[w].value)) w++;
    const key = w < words.length ? baseName(words[w].value) : '';
    if (stopBefore?.has(key)) return w;
    // Own-property lookup: a command named `constructor` must not find Object's.
    const wrapper = Object.hasOwn(WRAPPERS, key) ? WRAPPERS[key] : undefined;
    if (wrapper) {
      w++;
      while (w < words.length && (words[w].value.startsWith('-') || ASSIGNMENT.test(words[w].value))) {
        w += wrapper.valueFlags.includes(words[w].value) ? 2 : 1;
      }
      w += wrapper.positionals ?? 0;
    }
    if (w === before) return w;
  }
}
