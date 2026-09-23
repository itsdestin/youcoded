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
    if (c === '~' && !cur) start().tilde = true;
    push(c, GLOB_CHARS.has(c));
    i++;
  }
  end();
  return { tokens: out, nested };
}

/** Drop heredoc BODIES (the lines after `<<EOF` up to the `EOF` line), which
 *  are text fed to a command, not commands. Used by the secret-path floor so
 *  a body line like `.env` is not read as a command naming a file. The
 *  removal floor keeps them: `bash <<EOF` runs its body, and asking about a
 *  removal found there is the safe direction. */
export function stripHeredocBodies(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let delimiter: string | null = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m && !line.includes('<<<')) delimiter = m[2];
  }
  return out.join('\n');
}

/** `$HOME`, `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%` at the start of a word. */
export function homeVariable(value: string): RegExpMatchArray | null {
  return value.match(/^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i);
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
 *  before the wrapped command (`timeout 5 rm …` → 1). */
const WRAPPERS: Record<string, { valueFlags: string[]; positionals?: number }> = {
  sudo: { valueFlags: ['-u', '-g', '-C', '-h', '-p', '-U', '-D', '-r', '-t'] },
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
 *  assignments, shell keywords and wrappers (with their own arguments). */
export function commandIndex(words: Word[]): number {
  let w = 0;
  for (;;) {
    const before = w;
    while (w < words.length && ASSIGNMENT.test(words[w].value)) w++;
    while (w < words.length && SHELL_KEYWORDS.has(words[w].value)) w++;
    const wrapper = w < words.length ? WRAPPERS[words[w].value] : undefined;
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
