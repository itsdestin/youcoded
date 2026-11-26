// in-process-search.ts — a stand-in for the `rg` program on a device that cannot start programs.
//
// WHY (2026-11-25, iPhone app, card #89): the Grep tool runs the bundled ripgrep as a separate program
// (grep.ts). iOS forbids an app from starting any program, so on an iPhone there is no ripgrep to run — and an
// assistant that cannot search the files it is working on is not much of an assistant. This does the same search
// inside the backend and answers in ripgrep's own output format, behind the same "child process" shape
// (stdout / stderr / close code / kill), so everything grep.ts does with ripgrep's output — the caps, the
// truncation notes, the error wording — applies unchanged and there is one Grep tool, not two.
//
// It understands exactly the arguments grep.ts builds, nothing more. Differences from real ripgrep, on purpose:
//  - patterns are JavaScript regular expressions (ripgrep's are Rust's). Everyday patterns are the same in both;
//    a Rust-only construct is reported as a regex error, never silently mis-searched.
//  - ignore rules: `.git` and `node_modules` are skipped and the search root's own `.gitignore` is honoured for
//    simple patterns; nested `.gitignore` files are not read.
//  - binary files (a NUL byte in the first 8 KB) and files over 5 MB are skipped.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

/** The part of a child process grep.ts uses. */
export interface SearchChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(signal?: string): boolean;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALWAYS_SKIPPED = new Set(['.git', 'node_modules']);

/** ripgrep's `--type` names → the file globs they stand for (the common ones; `rg --type-list` has hundreds). */
const TYPE_GLOBS: Record<string, string[]> = {
  ts: ['*.ts', '*.tsx', '*.mts', '*.cts'], typescript: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  js: ['*.js', '*.jsx', '*.mjs', '*.cjs'], py: ['*.py', '*.pyi'], python: ['*.py', '*.pyi'],
  rust: ['*.rs'], go: ['*.go'], java: ['*.java'], kotlin: ['*.kt', '*.kts'], swift: ['*.swift'],
  c: ['*.c', '*.h'], cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.h'], cs: ['*.cs'], ruby: ['*.rb'], php: ['*.php'],
  md: ['*.md', '*.markdown', '*.mdx'], markdown: ['*.md', '*.markdown', '*.mdx'], txt: ['*.txt'],
  json: ['*.json'], yaml: ['*.yaml', '*.yml'], toml: ['*.toml'], xml: ['*.xml'], html: ['*.html', '*.htm'],
  css: ['*.css', '*.scss', '*.sass', '*.less'], sh: ['*.sh', '*.bash', '*.zsh'], sql: ['*.sql'], csv: ['*.csv'],
};

interface ParsedArgs {
  pattern: string;
  target: string | null;
  mode: 'content' | 'files' | 'count';
  maxCount: number;
  globs: string[];
  before: number;
  after: number;
  ignoreCase: boolean;
  literal: boolean;
  type: string | null;
  multiline: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { pattern: '', target: null, mode: 'content', maxCount: Infinity, globs: [], before: 0, after: 0, ignoreCase: false, literal: false, type: null, multiline: false };
  let lineNumbers = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.pattern = args[i + 1] ?? ''; out.target = args[i + 2] ?? null; break; }
    switch (a) {
      case '--max-count': out.maxCount = Number(args[++i]); break;
      case '-l': out.mode = 'files'; break;
      case '--count': out.mode = 'count'; break;
      case '-n': lineNumbers = true; break;
      case '--glob': out.globs.push(args[++i]); break;
      case '-C': out.before = out.after = Number(args[++i]); break;
      case '-A': out.after = Number(args[++i]); break;
      case '-B': out.before = Number(args[++i]); break;
      case '-i': out.ignoreCase = true; break;
      case '-F': out.literal = true; break;
      case '-U': out.multiline = true; break;
      case '--path-separator': i++; break;
      default:
        if (a.startsWith('--type=')) out.type = a.slice('--type='.length);
        // --no-config, --hidden, --multiline-dotall: nothing to do here.
    }
  }
  void lineNumbers; // content mode always prints them (grep.ts always asks)
  return out;
}

/** One ripgrep-style glob as a test over a POSIX path relative to the search root.
 *  A glob with no slash matches the file's NAME at any depth; one with a slash matches the whole relative path. */
export function globToRegExp(glob: string): RegExp {
  let g = glob;
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` = any number of folders (including none); a trailing `**` = everything below.
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else { const body = g.slice(i + 1, end); re += '[' + (body.startsWith('!') ? '^' + body.slice(1) : body).replace(/\\/g, '\\\\') + ']'; i = end; }
    } else if (c === '{') {
      const end = g.indexOf('}', i + 1);
      if (end < 0) re += '\\{';
      else { re += '(?:' + g.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = end; }
    } else re += c.replace(/[.+^$()|\\{}\]]/g, '\\$&');
  }
  const hasSlash = g.includes('/');
  const prefix = anchored || hasSlash ? '^' : '^(?:.*/)?';
  // A match on a folder covers everything inside it.
  return new RegExp(`${prefix}${re}(?:/.*)?$`);
}

interface Filters {
  include: RegExp[];
  exclude: RegExp[];
  typeGlobs: RegExp[] | null;
  ignore: RegExp[];
}

function buildFilters(p: ParsedArgs, rootDir: string): Filters | { error: string } {
  const f: Filters = { include: [], exclude: [], typeGlobs: null, ignore: [] };
  for (const g of p.globs) {
    if (g.startsWith('!')) f.exclude.push(globToRegExp(g.slice(1)));
    else f.include.push(globToRegExp(g));
  }
  if (p.type) {
    const list = TYPE_GLOBS[p.type];
    if (!list) return { error: `unrecognized file type: ${p.type}` };
    f.typeGlobs = list.map(globToRegExp);
  }
  try {
    for (const raw of fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      // Comments, blanks and re-include rules ("!x") are left out: a simple reading that only ever skips MORE
      // than git would is not possible, so re-includes are ignored rather than mis-applied.
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      try { f.ignore.push(globToRegExp(line)); } catch { /* a pattern this reader cannot turn into a test is skipped */ }
    }
  } catch { /* no .gitignore */ }
  return f;
}

function wanted(rel: string, f: Filters): boolean {
  if (f.exclude.some((r) => r.test(rel))) return false;
  if (f.include.length > 0 && !f.include.some((r) => r.test(rel))) return false;
  if (f.typeGlobs && !f.typeGlobs.some((r) => r.test(rel))) return false;
  return true;
}

function buildRegExp(p: ParsedArgs): RegExp | { error: string } {
  const source = p.literal ? p.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : p.pattern;
  // Rust-only inline flags a JavaScript engine would misread or reject.
  const inline = /^\(\?([a-zA-Z]+)\)/.exec(source);
  let body = source;
  let flags = 'g' + (p.ignoreCase ? 'i' : '') + (p.multiline ? 'ms' : '');
  if (inline) {
    body = source.slice(inline[0].length);
    for (const ch of inline[1]) {
      if (ch === 'i' && !flags.includes('i')) flags += 'i';
      else if (ch === 's' && !flags.includes('s')) flags += 's';
      else if (ch === 'm' && !flags.includes('m')) flags += 'm';
      else if (!'ism'.includes(ch)) return { error: `regex parse error:\n    ${p.pattern}\nerror: unrecognized flag '${ch}' (this device searches with JavaScript regular expressions)` };
    }
  }
  try {
    // 'u' first (correct handling of non-Latin text); patterns that are only valid without it fall back.
    try { return new RegExp(body, flags + 'u'); } catch { return new RegExp(body, flags); }
  } catch (e) {
    return { error: `regex parse error:\n    ${p.pattern}\nerror: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The 0-based indexes of the lines that match. */
function matchingLines(content: string, lines: string[], re: RegExp, multiline: boolean): number[] {
  const hits: number[] = [];
  if (!multiline) {
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) hits.push(i);
    }
    return hits;
  }
  // A pattern allowed to span lines: every line a match touches counts.
  const starts: number[] = [0];
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const seen = new Set<number>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const first = lineOf(m.index);
    const last = lineOf(m.index + Math.max(0, m[0].length - 1));
    for (let i = first; i <= last && i < lines.length; i++) seen.add(i);
    if (m[0].length === 0) re.lastIndex++;
  }
  return [...seen].sort((a, b) => a - b);
}

/** Run a search described by ripgrep arguments, in this process. `cwd` is what ripgrep's own cwd would be. */
export function inProcessSearch(args: string[], cwd: string): SearchChild {
  const child = new EventEmitter() as SearchChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; return true; };

  const finish = (code: number | null) => { child.emit('close', code); };
  const fail = (message: string) => { child.stderr.emit('data', message + '\n'); finish(2); };

  void (async () => {
    // Let the caller attach its listeners first, as it would for a real child.
    await new Promise<void>((r) => setImmediate(r));
    const p = parseArgs(args);
    const re = buildRegExp(p);
    if (!(re instanceof RegExp)) { fail(re.error); return; }

    const targetAbs = p.target === null ? cwd : path.resolve(cwd, p.target);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(targetAbs); } catch {
      fail(`${p.target ?? '.'}: IO error for operation on ${p.target ?? '.'}: No such file or directory (os error 2)`);
      return;
    }
    const singleFile = stat.isFile();
    const rootDir = singleFile ? path.dirname(targetAbs) : targetAbs;
    const filters = buildFilters(p, rootDir);
    if ('error' in filters) { fail(filters.error); return; }

    /** How ripgrep would print this file: bare for a whole-folder search from cwd, else under the target as given. */
    const label = (rel: string): string => (p.target === null ? rel : `${p.target.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel}`);
    let anyMatch = false;

    const searchFile = async (abs: string, shown: string | null): Promise<void> => {
      let content: string;
      try {
        const info = await fs.promises.stat(abs);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
        const buf = await fs.promises.readFile(abs);
        if (buf.subarray(0, 8192).includes(0)) return; // binary
        content = buf.toString('utf8');
      } catch { return; }
      const lines = content.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      for (let i = 0; i < lines.length; i++) if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
      let hits = matchingLines(content, lines, re, p.multiline);
      if (hits.length === 0) return;
      anyMatch = true;
      const prefix = shown === null ? '' : shown;
      if (p.mode === 'files') { child.stdout.emit('data', `${shown ?? path.basename(abs)}\n`); return; }
      if (p.mode === 'count') { child.stdout.emit('data', shown === null ? `${hits.length}\n` : `${prefix}:${hits.length}\n`); return; }
      if (hits.length > p.maxCount) hits = hits.slice(0, p.maxCount);
      const hitSet = new Set(hits);
      let out = '';
      let lastPrinted = -1;
      for (const h of hits) {
        const from = Math.max(0, h - p.before, lastPrinted + 1);
        const to = Math.min(lines.length - 1, h + p.after);
        if ((p.before > 0 || p.after > 0) && lastPrinted >= 0 && from > lastPrinted + 1) out += '--\n';
        for (let i = from; i <= to; i++) {
          const sep = hitSet.has(i) ? ':' : '-';
          out += shown === null ? `${i + 1}${sep}${lines[i]}\n` : `${prefix}${sep}${i + 1}${sep}${lines[i]}\n`;
        }
        lastPrinted = Math.max(lastPrinted, to);
      }
      child.stdout.emit('data', out);
    };

    if (singleFile) {
      await searchFile(targetAbs, null);
      finish(killed ? null : anyMatch ? 0 : 1);
      return;
    }

    let visited = 0;
    const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
      if (killed) return;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (killed) return;
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (ALWAYS_SKIPPED.has(entry.name)) continue;
        if (filters.ignore.some((r) => r.test(rel))) continue;
        if (entry.isDirectory()) {
          // An excluded folder is not entered at all (what keeps credential folders unread).
          if (filters.exclude.some((r) => r.test(rel))) continue;
          await walk(path.join(dirAbs, entry.name), rel);
        } else if (entry.isFile()) {
          if (!wanted(rel, filters)) continue;
          await searchFile(path.join(dirAbs, entry.name), label(rel));
          // Give the rest of the backend a turn: this runs on the one thread that also serves the screen.
          if (++visited % 20 === 0) await new Promise<void>((r) => setImmediate(r));
        }
      }
    };
    await walk(rootDir, '');
    finish(killed ? null : anyMatch ? 0 : 1);
  })().catch((e) => fail(e instanceof Error ? e.message : String(e)));

  return child;
}
