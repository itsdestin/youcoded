// The two checks "commands that never ask" needs and a pure text parser cannot do
// (shared/safe-readonly-commands.ts holds the text rules).
//
//  1. pathsAreNotSecret — a listed command may still be POINTED at a credential
//     (`cat ~/.ssh/id_rsa`, or `cat notes.txt` where notes.txt is a link into
//     ~/.ssh). Every word is run through the same path guard the file tools use,
//     which also follows symlinks. A refusal there means "ask", never "run".
//     The Bash secret-path floor (bash-secret-paths.ts) still runs afterwards for
//     everything; this is the extra symlink-aware pass the quiet path needs.
//  2. gitSettingsRunNothing — git reads a project's own .git/config, and a few
//     settings there make plain read-only commands launch programs (a file-watcher
//     helper, an external diff or text converter, a signature checker). A project
//     you downloaded can arrive with such a file. If the repo's settings name any,
//     or cannot be read, git asks as it always did. Reuses the approach of
//     sync-spaces/repo-trust.ts (`git config --file … --list -z` runs nothing).
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { checkPathGuard } from './guards';

const execFileAsync = promisify(execFile);

/** Words checked per command line; a longer line simply asks (it is not an everyday command). */
const MAX_WORDS_CHECKED = 80;

export function pathsAreNotSecret(words: string[], cwd: string): boolean {
  if (words.length > MAX_WORDS_CHECKED) return false;
  for (const raw of words) {
    // `--flag=value`: judge the value too (`--file=.env`), and the bare word itself.
    const candidates = new Set<string>([raw]);
    const eq = raw.indexOf('=');
    if (eq > 0) candidates.add(raw.slice(eq + 1));
    for (const c of candidates) {
      if (c === '' || c.startsWith('-') && !c.includes('/') && !c.includes('.')) continue;
      if (checkPathGuard(c, cwd).kind === 'deny') return false;
    }
  }
  return true;
}

// Settings that make a read-only git command launch something, or reach elsewhere.
// Keys are lower-cased section.name (git lower-cases both; a subsection keeps its case).
const RUNS_PROGRAMS = [
  /^core\.(fsmonitor|pager|sshcommand|gitproxy|hookspath|askpass|alternaterefscommand|attributesfile|editor|worktree)$/,
  /^diff\.external$/,
  /^diff\..*\.(textconv|command|binary)$/,
  /^(include|includeif)\./,
  /^filter\./,
  /^merge\..*\.driver$/,
  /^gpg\./,
  /^log\.showsignature$/,
  /^credential\./,
  /^uploadpack\./,
  /^receive\./,
  /^pager\./,
  /^alias\./,
  /^extensions\./,
  /^submodule\..*\.(update|fetchrecurse)$/,
];
const FALSE_VALUE = /^(false|0|no|off)$/i;

/** Pure: do these config entries name anything that runs a program? */
export function configRunsPrograms(entries: Array<[string, string]>): boolean {
  for (const [rawKey, value] of entries) {
    const first = rawKey.indexOf('.');
    const last = rawKey.lastIndexOf('.');
    const key = first === last ? rawKey.toLowerCase()
      : `${rawKey.slice(0, first).toLowerCase()}.${rawKey.slice(first + 1, last)}.${rawKey.slice(last + 1).toLowerCase()}`;
    // A setting turned OFF runs nothing (core.fsmonitor=false is what we ourselves pass elsewhere).
    if (/^core\.fsmonitor$/.test(key) && FALSE_VALUE.test(value.trim())) continue;
    if (RUNS_PROGRAMS.some((rx) => rx.test(key))) return true;
  }
  return false;
}

/** The git folder(s) a command run in `startDir` would read settings from, or null if none is found. */
async function findGitDirs(startDir: string): Promise<string[] | null> {
  const exists = (p: string) => fs.promises.lstat(p).then((s) => s, () => null);
  let dir = path.resolve(startDir);
  for (let hops = 0; hops < 64; hops++) {
    const dotGit = path.join(dir, '.git');
    const st = await exists(dotGit);
    if (st) {
      if (st.isDirectory()) return [dotGit];
      // A `.git` FILE points at the real folder (worktrees, submodules). Follow it, plus its shared parent.
      let text: string;
      try { text = await fs.promises.readFile(dotGit, 'utf8'); } catch { return []; }
      const m = /^gitdir:\s*(.+)\s*$/m.exec(text.slice(0, 4096));
      if (!m) return [];
      const gd = path.resolve(dir, m[1].trim());
      const dirs = [gd];
      try {
        const common = (await fs.promises.readFile(path.join(gd, 'commondir'), 'utf8')).trim();
        if (common) dirs.push(path.resolve(gd, common));
      } catch { /* no commondir: a plain gitdir */ }
      return dirs;
    }
    // A bare repository folder (HEAD + objects + refs sitting right here) is also found by git.
    if ((await exists(path.join(dir, 'HEAD'))) && (await exists(path.join(dir, 'objects'))) && (await exists(path.join(dir, 'refs')))) return [dir];
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return [];
}

/** True only when the repo found from `startDir` has settings that run nothing. No repo found → true
 *  (git itself will just say "not a git repository"). Anything unreadable → false (ask). */
export async function gitSettingsRunNothing(startDir: string): Promise<boolean> {
  const dirs = await findGitDirs(startDir);
  if (dirs === null) return true;
  if (dirs.length === 0) return false;
  for (const gd of dirs) {
    for (const name of ['config', 'config.worktree']) {
      const file = path.join(gd, name);
      if (!(await fs.promises.lstat(file).then(() => true, () => false))) continue;
      let out: string;
      try {
        // `--file` reads ONLY this file and runs nothing; -z keeps values with newlines intact.
        const r = await execFileAsync('git', ['config', '--file', file, '--list', '-z'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
        out = r.stdout;
      } catch { return false; }
      const entries: Array<[string, string]> = out.split('\0').filter(Boolean).map((rec) => {
        const i = rec.indexOf('\n');
        return i < 0 ? [rec, ''] : [rec.slice(0, i), rec.slice(i + 1)];
      });
      if (configRunsPrograms(entries)) return false;
    }
  }
  return true;
}
