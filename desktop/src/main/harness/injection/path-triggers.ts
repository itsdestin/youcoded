// Path-triggered content: text the model should see once work touches a matching
// path. TWO sources feed one index —
//   1. nested AGENTS.md / CLAUDE.md below the session cwd (M3 item 3a), and
//   2. .claude/rules/*.md with `paths:` frontmatter (M3 item 3b).
// They are the same mechanism; only discovery differs, which is why they share
// a file rather than being two subsystems that happen to look alike.
//
// The ROOT instructions file is deliberately excluded: prompt-assembly.ts already
// puts it in the byte-stable system prompt, and injecting it again would waste
// window and repeat itself.
//
// Built ONCE per session — this is filesystem state, and re-statting the tree on
// every tool call would be a real cost on a large repo.
//
// All disk reads are fs.promises (2026-09-24 blocking-calls B8): the index is
// built on every session create/resume AND on every specialist spawn mid-turn,
// and the sync depth-4 walk froze every window for its length on a big repo.
// The walk is still sequential and depth-first, so hits come back in the same
// order the sync walk produced.
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../logger';

export interface PathTrigger {
  /** Stable identity, so a trigger is injected at most once per session. */
  id: string;
  /** Human-readable origin, shown to the model so it knows where the text is from. */
  source: string;
  body: string;
}

export interface TriggerIndex {
  /** Every trigger the touched path activates, LEAST specific first — the model
   *  should read the most specific instructions last, closest to the work. */
  match(touchedPath: string): PathTrigger[];
}

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
// Directories whose contents are not this project's instructions. node_modules is
// the one that actually bites: a dependency shipping a CLAUDE.md would otherwise
// inject its rules into your session.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'vendor', 'coverage']);
// Deep enough for a monorepo package (packages/<name>/src/<area>), shallow enough
// that the walk stays cheap on a large tree.
const MAX_DEPTH = 4;

interface NestedHit { dir: string; file: string }

/** existsSync's async twin: true for anything at `p` (file or directory). */
async function exists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

async function findNestedInstructions(root: string): Promise<NestedHit[]> {
  const found: NestedHit[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const sub = path.join(dir, e.name);
      for (const name of INSTRUCTION_FILES) {
        const p = path.join(sub, name);
        // AGENTS.md wins in a directory that has both — the same precedence
        // prompt-assembly applies, since AGENTS.md is the cross-tool standard.
        if (await exists(p)) { found.push({ dir: sub, file: p }); break; }
      }
      await walk(sub, depth + 1);
    }
  };
  // Start at depth 1 = CHILDREN of root, so the root's own instructions file is
  // never collected (it is already in the system prompt).
  await walk(root, 1);
  return found;
}

async function readTrigger(cwd: string, dir: string, file: string, kind: string): Promise<{ dir: string; trigger: PathTrigger } | null> {
  let body: string;
  try { body = (await fs.promises.readFile(file, 'utf8')).trim(); } catch { return null; }
  // An empty file is not a trigger: injecting a blank block wastes window and
  // tells the model nothing.
  if (!body) return null;
  return { dir, trigger: { id: `${kind}:${file}`, source: path.relative(cwd, file), body } };
}

/** Expand `{a,b}` alternatives (nested allowed) into plain globs. WHY: rule
 *  authors copy Claude Code/editor globs such as `src/**\/*.{ts,tsx}`; treating
 *  the braces as literal characters meant those rules silently never fired.
 *  Capped so a pathological pattern cannot explode into thousands of globs. */
const MAX_BRACE_EXPANSIONS = 64;
function expandBraces(glob: string): string[] {
  let depth = 0, open = -1;
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '{') { if (depth++ === 0) open = i; }
    else if (glob[i] === '}' && depth > 0 && --depth === 0) {
      const alts: string[] = [];
      let d = 0, start = open + 1;
      for (let k = open + 1; k < i; k++) {
        if (glob[k] === '{') d++;
        else if (glob[k] === '}') d--;
        else if (glob[k] === ',' && d === 0) { alts.push(glob.slice(start, k)); start = k + 1; }
      }
      alts.push(glob.slice(start, i));
      // A lone `{x}` is not an alternative list; keep it literal like bash does.
      if (alts.length < 2) return [glob];
      const out: string[] = [];
      for (const alt of alts) {
        for (const rest of expandBraces(glob.slice(0, open) + alt + glob.slice(i + 1))) {
          out.push(rest);
          if (out.length >= MAX_BRACE_EXPANSIONS) return out;
        }
      }
      return out;
    }
  }
  return [glob];
}

/** One path segment's glob as a regex: `*` and `?` stay inside the segment,
 *  `[abc]`/`[a-z]`/`[!abc]` are character classes, everything else is literal.
 *  An unclosed `[` is literal, so a stray bracket can never throw. */
function segmentRegex(seg: string): RegExp {
  let rx = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') rx += '[^/]*';
    else if (c === '?') rx += '[^/]';
    else if (c === '[') {
      const close = seg.indexOf(']', i + 2);
      if (close === -1) { rx += '\\['; continue; }
      let body = seg.slice(i + 1, close);
      const negate = body[0] === '!' || body[0] === '^';
      if (negate) body = body.slice(1);
      rx += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      i = close;
    } else rx += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${rx}$`);
}

/** WHY: match path SEGMENTS, not substrings: ** consumes zero or more
 * entire folders, while * and ? never cross a slash. Bash subject globs have
 * intentionally different separator semantics and cannot be reused here.
 * A leading `/` or `./` anchors at the rule's owning folder, which is where
 * every glob is already anchored, so it is dropped rather than rejected. */
function pathMatches(relPosix: string, glob: string): boolean {
  return expandBraces(glob).some(g => pathMatchesOne(relPosix, g.replace(/^\.?\//, '')));
}

function pathMatchesOne(relPosix: string, glob: string): boolean {
  // Backslashes are Windows separators or escapes; neither has one safe
  // reading, so such a glob is rejected (and reported once by readRule).
  if (!glob || glob.includes('\\') || glob.includes('//')) return false;
  const pattern = glob.split('/');
  const parts = relPosix.split('/');
  if (pattern.some(p => !p || (p.includes('**') && p !== '**'))) return false;
  const regexes = pattern.map(p => (p === '**' ? null : segmentRegex(p)));
  const memo = new Map<string, boolean>();
  const visit = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let yes = false;
    if (i === pattern.length) yes = j === parts.length;
    else if (pattern[i] === '**') yes = visit(i + 1, j) || (j < parts.length && visit(i, j + 1));
    else if (j < parts.length) yes = regexes[i]!.test(parts[j]) && visit(i + 1, j + 1);
    memo.set(key, yes);
    return yes;
  };
  return visit(0, 0);
}

/** Read a rule's `paths:` list and body.
 *
 *  NO `paths:` means the rule is SKIPPED entirely rather than treated as global.
 *  An eager rule rides every turn — exactly the cost M3 item 5 exists to control
 *  — and this workspace's own .claude/rules/README.md already calls omitting
 *  `paths:` a mistake ("omitting it makes the rule EAGER"). Honoring that as
 *  "applies everywhere" would reward the error with the most expensive behavior.
 */
async function readRule(file: string): Promise<{ globs: string[]; body: string } | null> {
  let raw: string;
  try { raw = await fs.promises.readFile(file, 'utf8'); } catch { return null; }
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const front = raw.slice(3, end);
  const afterFence = raw.indexOf('\n', end + 1);
  const body = (afterFence === -1 ? '' : raw.slice(afterFence + 1)).trim();
  if (!body) return null;

  // WHY: parse the supported YAML paths list as scalars, not regex-captured
  // lines: quoted entries followed by comments used to include the comment in
  // the glob. No declared runtime YAML parser exists; malformed entries are
  // ignored rather than throwing during discovery or every tool call.
  const globs: string[] = [];
  const skipped: string[] = [];
  let inPaths = false;
  let itemIndent: number | undefined;
  for (const line of front.split('\n')) {
    if (/^paths:\s*(?:#.*)?$/.test(line)) { inPaths = true; itemIndent = undefined; continue; }
    if (!inPaths) continue;
    if (/^\S/.test(line)) { inPaths = false; continue; }
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = line.match(/^( +)-\s+(.+?)\s*$/);
    // WHY: paths is a FLAT list. Once a nested mapping, sequence or inconsistent
    // indent appears, later list-looking lines cannot become top-level paths.
    // Keeping already parsed flat entries is safe; unsupported children are not.
    if (!item || (itemIndent !== undefined && item[1].length !== itemIndent)) {
      inPaths = false;
      continue;
    }
    if (itemIndent === undefined) itemIndent = item[1].length;
    const rawValue = item[2].trim();
    let value: string;
    if (rawValue.startsWith('"')) {
      const quoted = rawValue.match(/^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/);
      if (!quoted) { skipped.push(rawValue); continue; }
      try { value = JSON.parse(quoted[1]); } catch { continue; }
    } else if (rawValue.startsWith("'")) {
      const quoted = rawValue.match(/^'((?:[^']|'')*)'(?:\s+#.*)?$/);
      if (!quoted) continue;
      value = quoted[1].replace(/''/g, "'");
    } else {
      value = rawValue.replace(/\s+#.*$/, '').trim();
      // WHY only a LEADING [ or { is refused: YAML reads those as a list or
      // map, but inside a plain value (`src/**/*.{ts,tsx}`, `app/[id]/*.tsx`)
      // they are ordinary characters the glob matcher understands.
      if (/^[\[{]/.test(value) || /["']/.test(value) || /:\s*$/.test(value)) { skipped.push(rawValue); continue; }
    }
    if (value.includes('\\')) { skipped.push(value); continue; }
    if (value) globs.push(value);
  }
  // A rule whose pattern can't be read never fires; say so in the log rather
  // than let the author wonder why their rule is ignored.
  if (skipped.length) log('WARN', 'PathTriggers', 'rule path pattern not understood; it will not match', { file, patterns: skipped });
  return globs.length ? { globs, body } : null;
}

interface OwnedRule { owner: string; globs: string[]; trigger: PathTrigger }

async function findRules(cwd: string): Promise<OwnedRule[]> {
  // WHY: rules, unlike B1's instruction files, belong only to the nearest Git
  // project. A narrowed child still inherits every owner up to that boundary;
  // .git can be a file in a linked worktree, not just a directory.
  const owners: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    owners.unshift(dir);
    if (await exists(path.join(dir, '.git'))) break;
    if (path.dirname(dir) === dir) {
      owners.splice(0, owners.length - 1); // no Git project: cwd's own rules only
      break;
    }
  }
  const out: OwnedRule[] = [];
  const seen = new Set<string>();
  for (const owner of owners) {
    const dir = path.join(owner, '.claude', 'rules');
    let files: string[];
    try { files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.md')); } catch { continue; }
    for (const f of files.sort()) {
      const file = path.join(dir, f);
      const parsed = await readRule(file);
      if (!parsed) continue;
      // WHY: realpath catches symlinks; dev/inode also catches hardlinked
      // names for the same physical rule without a second injected body.
      let identity: string;
      try {
        const canonical = await fs.promises.realpath(file);
        const stat = await fs.promises.stat(file);
        identity = stat.ino ? `${stat.dev}:${stat.ino}` : canonical;
      } catch { identity = file; }
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push({ owner, globs: parsed.globs,
        trigger: { id: `rule:${file}`, source: path.relative(cwd, file), body: parsed.body } });
    }
  }
  return out;
}

export async function buildTriggerIndex(cwd: string): Promise<TriggerIndex> {
  const scoped: Array<{ dir: string; trigger: PathTrigger }> = [];
  for (const { dir, file } of await findNestedInstructions(cwd)) {
    const hit = await readTrigger(cwd, dir, file, 'instructions');
    if (hit) scoped.push(hit);
  }

  const rules = await findRules(cwd);

  return {
    match(touchedPath: string): PathTrigger[] {
      const abs = path.resolve(cwd, touchedPath);
      const nested = scoped
        // The separator matters: a bare startsWith would make packages/api match
        // packages/api-client, injecting one package's rules into another's work.
        .filter((n) => abs === n.dir || abs.startsWith(n.dir + path.sep))
        // Shortest path first = least specific first (see TriggerIndex.match).
        .sort((a, b) => a.dir.length - b.dir.length)
        .map((n) => n.trigger);

      // WHY: each rule's glob is relative to the folder that OWNS it, not to
      // the child session cwd. Reject paths outside that owner before matching;
      // a ../ prefix is never a legitimate way to trigger a project rule.
      const matchedRules = rules.filter(r => {
        const rel = path.relative(r.owner, abs).split(path.sep).join('/');
        return rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel)
          && r.globs.some(g => pathMatches(rel, g));
      }).map(r => r.trigger);

      // Rules first, then nested instructions: the nested file is the more
      // specific statement about this exact directory, so it reads last.
      return [...matchedRules, ...nested];
    },
  };
}
