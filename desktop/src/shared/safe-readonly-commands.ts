// "Commands that never ask": a built-in list of read-only shell commands the native
// assistant may run without a permission card in Ask first and Auto-edit
// (Destin's decision 2026-10-31, security audit follow-up).
//
// WHY this is its own module in shared/: the engine (subject-glob.ts ruleMatches)
// decides with it, and Settings lists it in plain words — one definition, so the
// page can never promise something the engine does not do.
//
// DESIGN — an ALLOWLIST at every level, never a blocklist. Every published bypass
// of such lists (Claude Code CVE-2025-66032, Cursor CVE-2025-54131/-62354, Roo Code
// CVE-2025-65946, Gemini CLI's first-token bug, Trail of Bits' argument-injection
// findings) was a flag, a spelling or a parsing difference nobody had listed. So:
//   1. The WHOLE command must lex as plain words (lexer below). Anything the shell
//      would treat specially — $ ` \ ! * ? { } ( ) < > & # newline, tabs, control
//      characters, non-ASCII outside quotes — makes the whole line "not read-only".
//      With no expansion at all, the words we judge ARE the words the program gets;
//      there is no parsing difference left to exploit.
//   2. Each command word must be on the table below, as a bare name (no path, so
//      ./ls or /tmp/ls never qualify).
//   3. Each flag must be on that command's own list, spelled in full (no
//      abbreviations: git and GNU tools accept `--upl` for `--upload-pack`). An
//      unknown flag means "ask".
// Chaining with ; && || | is accepted only when EVERY part passes alone (read-only
// stages cannot combine into something that writes). A single & , |& , newlines and
// all redirects except to /dev/null or 2>&1 are refused.
//
// WHAT it is NOT: a sandbox. It cannot know what a file contains or what a user's
// own shell config does. The engine adds two checks it cannot do here (the secret
// path floor, and — for git — a look at the repo's own settings), see
// main/harness/tools/readonly-guard.ts.

export interface ReadOnlyVerdict {
  /** True only when the whole line is made of listed read-only commands. */
  safe: boolean;
  /** Some part is a git command: its repo settings must be checked before trusting it. */
  usesGit: boolean;
  /** Every plain word in the line (for the caller's path checks). */
  words: string[];
}

const NOT_SAFE: ReadOnlyVerdict = { safe: false, usesGit: false, words: [] };
export const MAX_READONLY_LENGTH = 2000;

// ── lexer ───────────────────────────────────────────────────────────────────

type Segment = string[];

// Characters that may appear in an UNQUOTED word. `~` only as a first character
// (checked below); `[`/`]` only as the whole word (the `test` brackets).
const PLAIN_CHAR = /[A-Za-z0-9_.\/:=,@%+^-]/;
// The only redirects accepted: throw output away, or merge errors into the output.
const SAFE_REDIRECT = /^(?:2>&1|>\/dev\/null|2>\/dev\/null|&>\/dev\/null|1>\/dev\/null)(?=[\s;|&]|$)/;

/** Split into pipeline/list segments of decoded words, or null if anything is not plain. */
function lex(command: string): Segment[] | null {
  if (command.length === 0 || command.length > MAX_READONLY_LENGTH) return null;
  const segments: Segment[] = [];
  let words: string[] = [];
  let i = 0;
  const n = command.length;
  const endSegment = (): boolean => {
    if (words.length === 0) return false; // empty command around an operator: `; ls`, `ls ;;`
    segments.push(words);
    words = [];
    return true;
  };
  while (i < n) {
    const c = command[i];
    if (c === ' ') { i++; continue; } // a plain space is the ONLY whitespace accepted
    // operators: ; && || |   (a lone & , |& and ;; are refused)
    if (c === ';') { if (!endSegment()) return null; i++; continue; }
    if (c === '|') {
      if (command[i + 1] === '&') return null;
      if (!endSegment()) return null;
      i += command[i + 1] === '|' ? 2 : 1;
      continue;
    }
    if (c === '&' && command[i + 1] === '&') {
      if (!endSegment()) return null;
      i += 2;
      continue;
    }
    // redirects, only at the start of a word, only the two harmless shapes
    if ((c === '2' || c === '>' || c === '&' || c === '1') && words.length > 0) {
      const m = SAFE_REDIRECT.exec(command.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    // a word: plain chars and quoted runs glued together, like the shell does
    let word = '';
    let started = false;
    while (i < n) {
      const ch = command[i];
      if (ch === "'") {
        const close = command.indexOf("'", i + 1);
        if (close === -1) return null;
        const body = command.slice(i + 1, close);
        if (!quotedBodyIsPlain(body, false)) return null;
        word += body; started = true; i = close + 1; continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < n && command[j] !== '"') j++;
        if (j >= n) return null;
        const body = command.slice(i + 1, j);
        // Inside double quotes the shell still expands $ ` \ and (interactively) !.
        if (!quotedBodyIsPlain(body, true)) return null;
        word += body; started = true; i = j + 1; continue;
      }
      if (ch === ' ' || ch === ';' || ch === '|' || ch === '&') break;
      if (ch === '~') {
        // At the START of a word `~` is the home folder: only `~` or `~/…` is accepted (`~user`, `~+` ask).
        // In the MIDDLE (`HEAD~3`) bash leaves it alone — except right after `:` or `=`, which it can expand.
        if (word !== '' || started) {
          const prev = word[word.length - 1];
          if (prev === ':' || prev === '=' || prev === undefined) return null;
        } else {
          const next = command[i + 1];
          if (next !== undefined && next !== '/' && next !== ' ' && next !== ';' && next !== '|' && next !== '&') return null;
        }
        word += ch; started = true; i++; continue;
      }
      if (ch === '[' || ch === ']') {
        // only as the entire word: `[ -f x ]`. Inside a word it is a glob.
        const prev = command[i - 1];
        const next = command[i + 1];
        const loneStart = !started && (next === undefined || next === ' ');
        const loneEnd = !started && (prev === ' ' || i === 0) && (next === undefined || next === ' ' || next === ';' || next === '|' || next === '&');
        if (!(loneStart || loneEnd)) return null;
        word += ch; started = true; i++; continue;
      }
      if (!PLAIN_CHAR.test(ch)) return null;
      word += ch; started = true; i++;
    }
    if (!started) return null; // a character that starts no valid word (e.g. a stray `&`, `>`)
    words.push(word);
  }
  if (words.length === 0) {
    // trailing operator (`ls &&`, `ls ;`) or empty input
    return null;
  }
  segments.push(words);
  // a line that ended right after an operator leaves `words` empty and was caught above
  return segments;
}

function quotedBodyIsPlain(body: string, double: boolean): boolean {
  for (let k = 0; k < body.length; k++) {
    const code = body.charCodeAt(k);
    if (code < 0x20 || code === 0x7f) return false; // newline, tab, NUL, escape…
    if (double && (body[k] === '$' || body[k] === '`' || body[k] === '\\' || body[k] === '!')) return false;
    // lone surrogates / bidi / zero-width controls: no legitimate reason to be in a command
    if (code >= 0x200b && code <= 0x200f) return false;
    if (code >= 0x202a && code <= 0x202e) return false;
    if (code >= 0x2066 && code <= 0x2069) return false;
    if (code === 0xfeff) return false;
  }
  return true;
}

// ── flag tables ─────────────────────────────────────────────────────────────

/** How a long option takes its value: none, required (`--x=v` or `--x v`), optional (`--x` or `--x=v`). */
type Arity = 'n' | 'r' | 'o';

interface Spec {
  /** Short letters that take no value; may be clustered (`-la`). */
  short?: string;
  /** Short letters whose value is the rest of the word or the next word (`-n5`, `-n 5`). */
  shortArg?: string;
  /** Long options, spelled in full. */
  long?: Record<string, Arity>;
  /** `-20`-style numeric option (head, tail, grep -5). */
  numeric?: boolean;
  /** Most positional (non-flag) words accepted. Default: unlimited. */
  maxPos?: number;
  /** Extra check of the positional words. */
  pos?: (words: string[]) => boolean;
}

const L = (names: string, arity: Arity = 'n'): Record<string, Arity> =>
  Object.fromEntries(names.split(' ').filter(Boolean).map((k) => [k, arity]));

/** Check one command's arguments against its table. */
function argsMatch(spec: Spec, args: string[]): boolean {
  const positional: string[] = [];
  let i = 0;
  let optionsEnded = false;
  while (i < args.length) {
    const a = args[i];
    i++;
    if (optionsEnded || a === '-' || !a.startsWith('-')) { positional.push(a); continue; }
    if (a === '--') { optionsEnded = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const arity = spec.long && Object.prototype.hasOwnProperty.call(spec.long, name) ? spec.long[name] : undefined;
      if (arity === undefined) return false;
      if (arity === 'n' && eq !== -1) return false;
      if (arity === 'r' && eq === -1) { if (i >= args.length) return false; i++; }
      continue;
    }
    // short option cluster
    if (spec.numeric && /^-\d+$/.test(a)) continue;
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const ch = letters[k];
      if (spec.short?.includes(ch)) continue;
      if (spec.shortArg?.includes(ch)) {
        if (k === letters.length - 1) { if (i >= args.length) return false; i++; }
        break; // the rest of this word is the value
      }
      return false;
    }
  }
  if (spec.maxPos !== undefined && positional.length > spec.maxPos) return false;
  return spec.pos ? spec.pos(positional) : true;
}

// ── the command table ───────────────────────────────────────────────────────
// One WHY per row where a flag was left out on purpose.

const SPECS: Record<string, Spec | 'free'> = {
  // ── looking at folders and files ──
  ls: {
    short: '1aAbBcCdfFgGhHiklLmnNopqQrRsStuUvxXZ', shortArg: 'IwT',
    long: {
      ...L('all almost-all author escape directory classify file-type human-readable si inode dereference ' +
        'dereference-command-line numeric-uid-gid literal hide-control-chars quote-name reverse recursive size ' +
        'group-directories-first no-group full-time context'),
      ...L('time sort format indicator-style time-style width tabsize ignore hide block-size', 'r'),
      ...L('color colour', 'o'),
    },
  },
  cat: { short: 'AbeEnstTuv', long: L('show-all number-nonblank number squeeze-blank show-tabs show-ends show-nonprinting') },
  tac: { short: 'br', shortArg: 's', long: L('before regex') },
  rev: { short: '' },
  nl: { shortArg: 'bdfhilnpsvw' },
  // WHY no -f/-F/--follow/--pid/--retry on tail: they never finish and would hang the turn.
  head: { short: 'qvz', shortArg: 'nc', numeric: true, long: { ...L('quiet silent verbose zero-terminated'), ...L('lines bytes', 'r') } },
  tail: { short: 'qvz', shortArg: 'nc', numeric: true, long: { ...L('quiet silent verbose zero-terminated'), ...L('lines bytes', 'r') } },
  wc: { short: 'lwcmL', long: L('lines words bytes chars max-line-length') },
  stat: { short: 'Lft', shortArg: 'c', long: { ...L('dereference file-system terse'), ...L('format printf', 'r') } },
  // WHY no -m/-f/-C/-z on file: they open (or, for -C, write) other files named in the flag's value.
  file: { short: 'bikLhN', long: L('brief mime mime-type mime-encoding dereference no-dereference keep-going') },
  // WHY no --files0-from / -X / --exclude-from: they read a list from a file the flag names.
  du: {
    short: 'abchHkLmPsSx', shortArg: 'dBt',
    long: { ...L('all apparent-size bytes total dereference human-readable si summarize one-file-system count-links separate-dirs'), ...L('max-depth block-size threshold exclude', 'r'), ...L('time', 'o') },
  },
  df: { short: 'ahHiklPT', shortArg: 'tBx', long: { ...L('all human-readable si inodes local portability print-type total'), ...L('block-size type exclude-type', 'r') } },
  // WHY no -s/--seconds/-c/--count on free: they repeat forever.
  free: { short: 'bkmghlLtw', long: L('human si bytes kibi mebi gibi kilo mega giga total wide lohi') },
  // WHY no -o/--output / -R / --fromfile on tree: they write the listing to a file or read a file list.
  tree: { short: 'adfilnpqsugDFhNCAvrtxJSU', shortArg: 'LIP', long: { ...L('noreport dirsfirst gitignore du si inodes device'), ...L('charset filelimit timefmt', 'r') } },
  readlink: { short: 'femnqsvz', long: L('canonicalize canonicalize-existing canonicalize-missing no-newline quiet silent verbose zero') },
  realpath: { short: 'eEmLPqsz', long: { ...L('canonicalize-existing canonicalize-missing logical physical quiet strip no-symlinks zero'), ...L('relative-to relative-base', 'r') } },
  basename: { short: 'az', shortArg: 's', long: L('multiple zero') },
  dirname: { short: 'z', long: L('zero') },
  pwd: { short: 'LP', maxPos: 0 },

  // ── filtering text (they only print) ──
  // WHY no -o/--output, --compress-program, -T/--temporary-directory, --random-source, --files0-from on sort:
  // the first writes a file, the second RUNS a program, the rest touch other files. (Claude Code CVE-2025-66032.)
  sort: {
    short: 'bdfghiMnRrVcCsuz', shortArg: 'kt',
    long: { ...L('ignore-leading-blanks dictionary-order ignore-case general-numeric-sort human-numeric-sort ignore-nonprinting month-sort numeric-sort version-sort reverse stable unique zero-terminated'), ...L('key field-separator', 'r'), ...L('check', 'o') },
  },
  // WHY at most one file: a second file name is the OUTPUT file uniq writes to.
  uniq: { short: 'cdDiuz', shortArg: 'fsw', maxPos: 1, long: { ...L('count repeated unique ignore-case zero-terminated'), ...L('skip-fields skip-chars check-chars', 'r') } },
  cut: { short: 'sz', shortArg: 'bcfdn', long: { ...L('complement only-delimited zero-terminated'), ...L('fields bytes characters delimiter output-delimiter', 'r') } },
  paste: { short: 'sz', shortArg: 'd', long: { ...L('serial zero-terminated'), ...L('delimiters', 'r') } },
  tr: { short: 'cCdst', maxPos: 2, long: L('complement delete squeeze-repeats truncate-set1') },
  fold: { short: 'bs', shortArg: 'w', long: { ...L('bytes spaces'), ...L('width', 'r') } },
  column: { short: 'tx', shortArg: 'soc' },
  comm: { short: '123z', maxPos: 2, long: { ...L('check-order nocheck-order total zero-terminated'), ...L('output-delimiter', 'r') } },
  cmp: { short: 'bls', shortArg: 'ni', maxPos: 4 },
  // WHY no -c/--check on the checksums: it reads a list of file names from a file and opens each.
  md5sum: { short: 'btz', long: L('binary text tag zero') },
  sha1sum: { short: 'btz', long: L('binary text tag zero') },
  sha224sum: { short: 'btz', long: L('binary text tag zero') },
  sha256sum: { short: 'btz', long: L('binary text tag zero') },
  sha384sum: { short: 'btz', long: L('binary text tag zero') },
  sha512sum: { short: 'btz', long: L('binary text tag zero') },
  b2sum: { short: 'btz', long: L('binary text tag zero') },
  cksum: { short: '' },
  // WHY no -i/-o on base64: on macOS they name an input/output FILE (Codex refuses -o for the same reason).
  base64: { short: 'dD', shortArg: 'w', long: { ...L('decode ignore-garbage'), ...L('wrap', 'r') } },
  od: { short: 'abcdfilosvx', shortArg: 'AjNtw' },
  hexdump: { short: 'Cbcdovx', shortArg: 'ns' },
  strings: { short: 'afo', shortArg: 'nte' },
  // WHY diff is on the list but not -X/--exclude-from: that reads a file of patterns.
  diff: {
    short: 'uciqrswbBiyEaNlTZ', shortArg: 'UCxIF',
    long: {
      ...L('brief recursive report-identical-files ignore-all-space ignore-space-change ignore-blank-lines ignore-case side-by-side expand-tabs text new-file minimal strip-trailing-cr show-c-function speed-large-files initial-tab'),
      ...L('exclude ignore-matching-lines label width', 'r'),
      ...L('unified context color', 'o'),
    },
  },

  // ── facts about the machine ──
  whoami: { maxPos: 0 },
  id: { short: 'ugGnrz', long: L('user group groups name real zero') },
  uname: { short: 'asnrvmpio', long: L('all kernel-name nodename kernel-release kernel-version machine processor hardware-platform operating-system') },
  // WHY hostname takes no arguments: with a name it CHANGES the computer's name.
  hostname: { maxPos: 0 },
  // WHY date only takes a +FORMAT: a bare number (MMDDhhmm) or -s SETS the clock.
  date: { short: 'uR', long: L('utc universal rfc-email'), maxPos: 1, pos: (p) => p.every((w) => w.startsWith('+')) },
  nproc: { long: L('all') },
  arch: { maxPos: 0 },
  uptime: { short: 'ps', long: L('pretty since') },
  which: { short: 'a' },
  type: { short: 'atpP' },

  // ── printing (searching and git have their own tables below) ──
  echo: 'free',
  true: 'free',
  false: 'free',
  expr: 'free',
  seq: { short: 'w', shortArg: 'sf', long: { ...L('equal-width'), ...L('separator format', 'r') } },
  test: 'free',
  '[': 'free',
};

const GREP_LONG: Record<string, Arity> = {
  ...L('extended-regexp fixed-strings basic-regexp perl-regexp ignore-case no-ignore-case invert-match word-regexp line-regexp count ' +
    'files-without-match files-with-matches only-matching quiet silent no-messages byte-offset with-filename no-filename line-number ' +
    'initial-tab null null-data text recursive dereference-recursive line-buffered binary unix-byte-offsets'),
  ...L('color colour', 'o'),
  ...L('label binary-files directories exclude exclude-dir include regexp file max-count after-context before-context context', 'r'),
};
const GREP: Spec = {
  short: 'EFGPiyvwxcLlosqbHhnTZzaIUrRuV', shortArg: 'efmABC', numeric: true, long: GREP_LONG,
};
SPECS.grep = GREP; SPECS.egrep = GREP; SPECS.fgrep = GREP;

// WHY ripgrep's --pre/--pre-glob/--hostname-bin/-z/--search-zip are absent: they RUN a program (Claude Code
// CVE-2025-66032, Trail of Bits 2025-10-22, Codex's own list); the long spelling must be exact, so --pr is refused too.
// WHY each omission: --pre/--pre-glob RUN a program on every file; --hostname-bin runs one; -z/--search-zip call
// decompressors; --no-config would be harmless but unlisted. -f/--file reads a pattern file (fine) — kept.
SPECS.rg = {
  short: 'iSswxvFnNHIcloLqauUhbPV0',
  shortArg: 'eftTgABCmjdrME',
  numeric: true,
  long: {
    ...L('ignore-case smart-case case-sensitive word-regexp line-regexp invert-match fixed-strings line-number no-line-number ' +
      'with-filename no-filename count count-matches files-with-matches files-without-match only-matching quiet hidden no-ignore ' +
      'no-ignore-vcs no-ignore-parent no-ignore-dot no-ignore-global text multiline multiline-dotall null heading no-heading pretty json ' +
      'stats files type-list sort-files follow column vimgrep trim no-messages binary pcre2 passthru crlf line-buffered block-buffered unrestricted ' +
      'no-binary one-file-system'),
    ...L('color regexp file glob iglob type type-not after-context before-context context max-count max-depth replace threads max-filesize ' +
      'max-columns encoding sort sortr ignore-file', 'r'),
  },
};

// ── find ────────────────────────────────────────────────────────────────────
// WHY an allowlist of tests and nothing else: -exec/-execdir/-ok/-okdir run programs, -delete removes files,
// -fprint/-fprint0/-fprintf/-fls write files, -files0-from reads a list from a file (Claude Code and Codex
// both refuse these). Anything not listed here — including every spelling we did not think of — asks.
const FIND_FLAG0 = new Set(['-print', '-print0', '-prune', '-true', '-false', '-empty', '-depth', '-mount', '-xdev', '-readable',
  '-writable', '-executable', '-nouser', '-nogroup', '-ls', '-follow', '-noleaf', '-daystart', '-a', '-and', '-o', '-or', '-not', '!', '(', ')', ',']);
const FIND_FLAG1 = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-xtype',
  '-size', '-mtime', '-atime', '-ctime', '-mmin', '-amin', '-cmin', '-newer', '-perm', '-user', '-group', '-uid', '-gid', '-maxdepth',
  '-mindepth', '-links', '-inum', '-samefile', '-lname', '-ilname', '-printf', '-regextype']);

function findMatches(args: string[]): boolean {
  let i = 0;
  // leading symlink options
  while (i < args.length && (args[i] === '-H' || args[i] === '-L' || args[i] === '-P')) i++;
  // starting folders
  while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(' && args[i] !== ')' && args[i] !== ',') i++;
  while (i < args.length) {
    const a = args[i++];
    if (FIND_FLAG0.has(a)) continue;
    if (FIND_FLAG1.has(a)) { if (i >= args.length) return false; i++; continue; }
    return false;
  }
  return true;
}

// ── sed: only the "print these lines" idiom ─────────────────────────────────
// WHY not general sed: the `w` command writes files, `e` runs programs, -i edits in place (Claude Code CVE-2025-66032
// used the `e` flag). Codex allows exactly this idiom; so do we.
const SED_PRINT = /^(?:\d+(?:,\d+)?|\$)p$/;
function sedMatches(args: string[]): boolean {
  if (args.length < 2) return false;
  if (args[0] !== '-n' && args[0] !== '--quiet' && args[0] !== '--silent') return false;
  if (!SED_PRINT.test(args[1])) return false;
  return args.slice(2).every((a) => a === '-' || !a.startsWith('-'));
}

// ── printf: format words only ───────────────────────────────────────────────
// WHY: `printf -v name` stores into a shell variable; the first word must be the format, not a flag.
function printfMatches(args: string[]): boolean {
  return args.length > 0 && !args[0].startsWith('-');
}

// ── `X --version` and friends ───────────────────────────────────────────────
const VERSION_TOOLS = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'python', 'python3', 'pip', 'pip3', 'cargo', 'rustc',
  'git', 'gh', 'docker', 'deno', 'ruby', 'gcc', 'make', 'cmake', 'java']);

// ── git ─────────────────────────────────────────────────────────────────────
// WHY per-subcommand tables: git has hundreds of flags and a lot of them run programs (--ext-diff, --textconv,
// --exec, --paginate, -O/--open-files-in-pager, --upload-pack, -c core.pager=…) or write files (--output).
// Codex blocks those by name; git accepts any unambiguous abbreviation of a long option, so a name-blocklist can be
// walked around (`--upload-pa`, Claude Code CVE-2025-66032). Here only the listed spellings pass.
// Not accepted at all: global options other than --no-pager/--no-optional-locks (-c, -C, --git-dir, --work-tree,
// --exec-path, --config-env), and every subcommand not named below.

const GIT_DIFF_LONG = {
  ...L('stat shortstat numstat name-only name-status patch no-patch summary no-color cached staged raw check exit-code quiet ' +
    'ignore-all-space ignore-space-change ignore-blank-lines ignore-cr-at-eol ignore-space-at-eol minimal patience histogram ' +
    'no-renames find-renames find-copies function-context compact-summary full-index binary text no-prefix indent-heuristic ' +
    'no-indent-heuristic merge-base irreversible-delete'),
  ...L('color unified word-diff color-words dirstat abbrev stat-width', 'o'),
  ...L('diff-filter diff-algorithm src-prefix dst-prefix inter-hunk-context', 'r'),
};
const GIT_LOG_LONG = {
  ...GIT_DIFF_LONG,
  ...L('oneline graph no-decorate abbrev-commit no-abbrev-commit all first-parent merges no-merges reverse follow topo-order date-order ' +
    'author-date-order relative-date left-right cherry-pick cherry-mark boundary full-history simplify-by-decoration ancestry-path ' +
    'regexp-ignore-case extended-regexp fixed-strings all-match invert-grep mailmap use-mailmap no-mailmap full-diff parents children ' +
    'show-pulls remotes tags branches'),
  ...L('decorate branches tags remotes pretty no-walk', 'o'),
  ...L('date format author committer grep since until after before max-count skip min-parents max-parents', 'r'),
};
// WHY these are absent everywhere below: output (writes a file), ext-diff and textconv (run programs), show-signature
// (runs gpg), exec, paginate, open-files-in-pager, no-index is left out of diff on purpose to keep it to repo content.
const noDash = (p: string[]) => p.every((w) => !w.startsWith('-'));

const GIT_SUB: Record<string, Spec> = {
  status: { short: 'sbvz', long: { ...L('short branch verbose null show-stash no-renames ahead-behind no-ahead-behind'), ...L('porcelain untracked-files ignored', 'o') } },
  log: { short: 'pusmwiEFa', shortArg: 'nSGLU', numeric: true, long: GIT_LOG_LONG },
  show: { short: 'pusmwiEFa', shortArg: 'nSGLU', numeric: true, long: GIT_LOG_LONG },
  diff: { short: 'pusRbwa', shortArg: 'USG', long: GIT_DIFF_LONG },
  // branch / tag are checked by a dedicated function: a bare name would CREATE one.
  'rev-parse': { long: { ...L('show-toplevel git-dir verify is-inside-work-tree is-bare-repository show-prefix show-cdup absolute-git-dir git-common-dir symbolic-full-name all branches tags remotes'), ...L('abbrev-ref short', 'o') } },
  'ls-files': { short: 'cdmoiskzvtu', long: L('cached deleted modified others ignored stage killed unmerged exclude-standard full-name deduplicate eol') },
  'ls-tree': { short: 'drtlz', long: { ...L('name-only name-status long full-name full-tree object-only'), ...L('abbrev', 'o') } },
  // WHY cat-file only -t/-s/-e/-p: --textconv and --filters run programs from the repo's settings.
  'cat-file': { short: 'tsep', maxPos: 2, long: L('allow-unknown-type') },
  describe: { long: { ...L('tags always long exact-match contains all first-parent'), ...L('abbrev dirty', 'o'), ...L('match candidates', 'r') } },
  'rev-list': { shortArg: 'n', numeric: true, long: { ...L('count all first-parent no-merges merges reverse parents left-right ancestry-path topo-order date-order boundary'), ...L('branches tags remotes', 'o'), ...L('max-count since until after before author grep skip', 'r') } },
  'merge-base': { long: L('is-ancestor fork-point octopus all independent') },
  blame: { short: 'wepslfn', shortArg: 'L', long: L('porcelain line-porcelain incremental show-name show-number show-email minimal root') },
  'name-rev': { long: { ...L('name-only tags always'), ...L('refs', 'r') } },
  'show-ref': { short: 'dsq', long: { ...L('head heads tags verify quiet dereference'), ...L('hash abbrev', 'o') } },
  'for-each-ref': { long: L('format sort count points-at merged no-merged contains', 'r') },
  'count-objects': { short: 'vH' },
  grep: {
    short: 'IEFGPiwvnlLcohHqaWpz', shortArg: 'efABCm', numeric: true,
    long: {
      ...L('extended-regexp fixed-strings basic-regexp perl-regexp ignore-case invert-match word-regexp line-number files-with-matches files-without-match count ' +
        'only-matching no-filename quiet text cached untracked no-index exclude-standard and or not all-match name-only heading break show-function function-context ' +
        'full-name null column byte-offset'),
      ...L('max-depth threads regexp file after-context before-context context max-count', 'r'),
    },
  },
};

function gitBranchOk(args: string[]): boolean {
  const spec: Spec = {
    short: 'arv',
    long: { ...L('list show-current all remotes verbose no-color column no-column'), ...L('contains no-contains sort format points-at abbrev', 'r'), ...L('merged no-merged color', 'o') },
  };
  if (!argsMatch(spec, args)) return false;
  const positional = positionalWords(spec, args);
  // WHY a bare name asks: `git branch NAME` creates a branch. A pattern is only a pattern after --list.
  return positional.length === 0 || args.includes('--list');
}
function gitTagOk(args: string[]): boolean {
  const spec: Spec = {
    short: 'l',
    long: { ...L('list column no-column'), ...L('sort format points-at contains no-contains', 'r'), ...L('merged no-merged', 'o') },
  };
  if (!argsMatch(spec, args)) return false;
  // WHY: `git tag NAME` creates a tag; with no -l/--list a bare word is a name.
  return positionalWords(spec, args).length === 0 || args.includes('--list') || args.includes('-l');
}

/** The positional words argsMatch would collect (a second pass, only used after argsMatch passed). */
function positionalWords(spec: Spec, args: string[]): string[] {
  const out: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (ended || a === '-' || !a.startsWith('-')) { out.push(a); continue; }
    if (a === '--') { ended = true; continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      if (spec.long?.[name] === 'r' && !a.includes('=')) i++;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(a)) continue;
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      if (spec.shortArg?.includes(letters[k])) { if (k === letters.length - 1) i++; break; }
    }
  }
  return out;
}

function gitMatches(args: string[]): boolean {
  let i = 0;
  // WHY only these two global options: both are harmless; every other one can change config, folder or helper programs.
  while (i < args.length && (args[i] === '--no-pager' || args[i] === '--no-optional-locks')) i++;
  const sub = args[i];
  if (sub === undefined) return false;
  const rest = args.slice(i + 1);
  if (sub === 'branch') return gitBranchOk(rest);
  if (sub === 'tag') return gitTagOk(rest);
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose')) ||
    (rest[0] === 'get-url' && argsMatch({ long: L('push all') }, rest.slice(1)) && noDash(rest.slice(1).filter((w) => !w.startsWith('--'))));
  if (sub === 'worktree') return rest[0] === 'list' && argsMatch({ short: 'v', long: L('porcelain verbose') }, rest.slice(1));
  if (sub === 'stash') return (rest[0] === 'list' || rest[0] === 'show') && argsMatch(GIT_SUB.log, rest.slice(1));
  if (sub === 'reflog') return rest.length === 0 || (rest[0] === 'show' && argsMatch(GIT_SUB.log, rest.slice(1)));
  if (sub === 'version') return rest.length === 0;
  const spec = GIT_SUB[sub];
  if (!spec) return false;
  return argsMatch(spec, rest);
}

// ── the public check ────────────────────────────────────────────────────────

function programName(word: string): string | null {
  // Bare names only. `/bin/ls`, `./ls`, `~/bin/ls` could be any program; they ask.
  return /^[A-Za-z0-9_\[.-]+$/.test(word) && !word.includes('/') ? word : null;
}

function segmentIsReadOnly(words: string[]): { ok: boolean; git: boolean } {
  const name = programName(words[0]);
  if (name === null) return { ok: false, git: false };
  const args = words.slice(1);
  if (name === 'git') return { ok: gitMatches(args) || (args.length === 1 && args[0] === '--version'), git: true };
  if (VERSION_TOOLS.has(name) && args.length === 1 && args[0] === '--version') return { ok: true, git: false };
  if (name === 'go') return { ok: args.length === 1 && args[0] === 'version', git: false };
  if (name === 'find') return { ok: findMatches(args), git: false };
  if (name === 'sed') return { ok: sedMatches(args), git: false };
  if (name === 'printf') return { ok: printfMatches(args), git: false };
  if (name === '[') {
    // `[ … ]` must end with its closing bracket
    return { ok: args.length >= 1 && args[args.length - 1] === ']', git: false };
  }
  if (!Object.prototype.hasOwnProperty.call(SPECS, name)) return { ok: false, git: false };
  const spec = SPECS[name];
  if (spec === 'free') return { ok: true, git: false };
  return { ok: argsMatch(spec, args), git: false };
}

/** Is this whole command line made only of listed read-only commands? Pure; no file access. */
export function readOnlyVerdict(command: string, opts?: { powershell?: boolean }): ReadOnlyVerdict {
  // PowerShell reads the same characters differently (backtick escapes, $(…), aliases): never trusted.
  if (opts?.powershell) return NOT_SAFE;
  const segments = lex(command);
  if (!segments) return NOT_SAFE;
  let usesGit = false;
  const words: string[] = [];
  for (const seg of segments) {
    const r = segmentIsReadOnly(seg);
    if (!r.ok) return NOT_SAFE;
    if (r.git) usesGit = true;
    words.push(...seg);
  }
  return { safe: true, usesGit, words };
}

// ── what Settings tells the person ──────────────────────────────────────────

/** Plain-words groups for the Permissions page. Keep in step with the table above
 *  (a test compares the names, so a command cannot be listed here and not allowed, or the reverse). */
export const READONLY_COMMAND_GROUPS: ReadonlyArray<{ title: string; commands: string[]; note?: string }> = [
  { title: 'Looking at files and folders', commands: ['ls', 'cat', 'tac', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'tree', 'find', 'readlink', 'realpath', 'basename', 'dirname', 'pwd', 'test', '['],
    note: 'find only searches. It never deletes, writes or runs anything.' },
  { title: 'Searching inside files', commands: ['grep', 'egrep', 'fgrep', 'rg', 'sed'], note: 'sed only prints chosen lines (sed -n 5,10p).' },
  { title: 'Sorting and shaping text', commands: ['sort', 'uniq', 'cut', 'paste', 'tr', 'fold', 'column', 'nl', 'rev', 'comm', 'cmp', 'diff', 'echo', 'printf', 'seq', 'expr', 'true', 'false'] },
  { title: 'Checking and decoding', commands: ['md5sum', 'sha1sum', 'sha224sum', 'sha256sum', 'sha384sum', 'sha512sum', 'b2sum', 'cksum', 'base64', 'od', 'hexdump', 'strings'] },
  { title: 'Facts about this computer', commands: ['whoami', 'id', 'uname', 'hostname', 'date', 'nproc', 'arch', 'uptime', 'free', 'which', 'type'], note: 'date only shows the time. It never sets it.' },
  { title: 'Reading git history', commands: ['git status', 'git log', 'git show', 'git diff', 'git branch', 'git tag', 'git rev-parse', 'git ls-files', 'git ls-tree', 'git cat-file', 'git describe', 'git rev-list', 'git merge-base', 'git blame', 'git name-rev', 'git show-ref', 'git for-each-ref', 'git count-objects', 'git grep', 'git remote', 'git worktree list', 'git stash list', 'git reflog'],
    note: 'Only the looking forms. Anything that changes the project, or sends it somewhere, still asks. In a project whose git settings run programs, git asks every time.' },
  { title: 'Version checks', commands: ['node --version', 'python --version', 'npm --version', 'git --version', '…and similar'] },
];

/** Names of every program that can run with no flags beyond its table — for the parity test. */
export function readOnlyProgramNames(): string[] {
  return [...Object.keys(SPECS), 'find', 'sed', 'printf', 'git', 'go', ...VERSION_TOOLS];
}
