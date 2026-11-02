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
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { checkPathGuard, canonicalize, realpathNearestSync } from './guards';
import { isPhoneDeniedPath, isSearchExcludedPath } from './credential-paths';
import { readOnlyVerdict } from '../../../shared/safe-readonly-commands';

const execFileAsync = promisify(execFile);

/** Words checked per command line; a longer line simply asks (it is not an everyday command). */
const MAX_WORDS_CHECKED = 80;

/** A folder that CONTAINS the home credential folders (home itself, its parents, `/`). A command that reads whole
 *  folders (grep -r, rg…) pointed at one would read them without ever naming a secret file. */
function containsCredentialFolders(dirWord: string, cwd: string): boolean {
  const home = os.homedir();
  const expanded = dirWord === '~' ? home : dirWord.startsWith('~/') ? path.join(home, dirWord.slice(2)) : dirWord;
  const abs = path.resolve(cwd, expanded);
  // realpathNearestSync is the guards' own (already allowlisted) link-following helper.
  const real = realpathNearestSync(abs) ?? abs;
  const homeReal = realpathNearestSync(home);
  const homes = homeReal && homeReal !== home ? [home, homeReal] : [home];
  for (const h of homes) {
    for (const sub of ['.ssh', '.aws', '.gnupg', '.claude', '.youcoded']) {
      const target = path.join(h, sub);
      for (const c of new Set([abs, real])) {
        if (target === c || target.startsWith(c.endsWith(path.sep) ? c : c + path.sep)) return true;
      }
    }
  }
  return false;
}

/** Places no look-only command should read silently, beyond what the file tools' guard already refuses:
 *  the phone's wider list (shell histories, .git folders, key bundles, saved logins), the app's own settings and
 *  saved approvals, and the computer's live process/device files (a process's environment holds keys; /dev can
 *  stream forever). Judged on the typed AND the real location. */
function isExtraDenied(word: string, cwd: string): boolean {
  const home = os.homedir();
  const expanded = word === '~' ? home : word.startsWith('~/') ? path.join(home, word.slice(2)) : word;
  const typed = canonicalize(expanded, cwd);
  const realAbs = realpathNearestSync(path.resolve(cwd, expanded));
  for (const c of new Set([typed, realAbs ? canonicalize(realAbs, cwd) : typed])) {
    const lower = c.toLowerCase();
    if (lower.startsWith('/proc/') || lower === '/proc') return true;
    if ((lower.startsWith('/dev/') || lower === '/dev') && lower !== '/dev/null') return true;
    if (/\/\.(youcoded|claude)(\/|$)/.test(lower) || /\/\.claude\.json$/.test(lower) || /\/\.config\/(youcoded|claude)(\/|$)/.test(lower)) return true;
    if (isPhoneDeniedPath(c, canonicalize(home, cwd))) return true;
  }
  return false;
}

/** Most files a recursive search is checked over before it simply asks (a huge tree is not an everyday quiet search). */
const MAX_SEARCH_ENTRIES = 60_000;

/**
 * A recursive content search (`grep -r`, `rg`) prints file contents, so it must not run quietly over a folder that
 * holds a file the Grep tool refuses (.env, key bundles, saved logins, a git config with web addresses…). Looks at
 * every file under the folders the command names (or the shell's folder if none), without following links, and says
 * false — meaning "ask" — if it finds one, finds more than it is willing to look through, or cannot read a folder.
 * The list of refused files is credential-paths.ts' own (isSearchExcludedPath), not a second copy.
 */
export async function searchTreeHasNoSecrets(words: string[], cwd: string): Promise<boolean> {
  const roots: string[] = [];
  for (const w of words.slice(1)) {
    if (w.startsWith('-')) continue;
    const expanded = w === '~' ? os.homedir() : w.startsWith('~/') ? path.join(os.homedir(), w.slice(2)) : w;
    const abs = path.resolve(cwd, expanded);
    if (await fs.promises.lstat(abs).then(() => true, () => false)) roots.push(abs);
  }
  // A word like the search text is not a path and is skipped above; with no real path named, the shell's folder is searched.
  if (roots.length === 0) roots.push(path.resolve(cwd));
  let seen = 0;
  // ripgrep on its own skips dot-files and folders (so a project's .env is never read by a plain `rg x`); the
  // widening flags (-u, --hidden, --no-ignore…) and grep's -r do read them.
  const rgOnly = words[0] === 'rg' && !words.some((w) => /^(grep|egrep|fgrep)$/.test(w));
  const widened = words.some((w) => /^--(hidden|unrestricted|no-ignore.*)$/.test(w) || /^-[A-Za-z]*u[A-Za-z]*$/.test(w));
  const skipsHidden = rgOnly && !widened;
  const looksSecret = async (p: string): Promise<boolean> => {
    const norm = p.replace(/\\/g, '/');
    if (/(^|\/)\.git\/config$/.test(norm)) {
      // A repo's own settings are only a secret when a saved web address carries a login (https://user:token@host).
      const text = await fs.promises.readFile(p, 'utf8').catch(() => null);
      return text === null || /:\/\/[^/\s@]+@/.test(text.slice(0, 65536));
    }
    return isSearchExcludedPath(norm);
  };
  const walk = async (p: string): Promise<boolean> => {
    if (++seen > MAX_SEARCH_ENTRIES) return false;
    if (skipsHidden && path.basename(p).startsWith('.') && !roots.includes(p)) return true;
    if (await looksSecret(p)) return false;
    let st: fs.Stats;
    try { st = await fs.promises.lstat(p); } catch { return false; }
    if (!st.isDirectory()) return true;
    let names: string[];
    try { names = await fs.promises.readdir(p); } catch { return false; }
    for (const n of names) if (!(await walk(path.join(p, n)))) return false;
    return true;
  };
  for (const r of roots) if (!(await walk(r))) return false;
  return true;
}

/** A PATH with an empty or `.` entry would let a file in the project stand in for `ls`. */
function pathIsClean(pathVar: string | undefined = process.env.PATH): boolean {
  if (!pathVar) return false;
  return pathVar.split(path.delimiter).every((e) => e !== '' && e !== '.' && path.isAbsolute(e));
}

export function pathsAreNotSecret(words: string[], cwd: string, readsFolders = false, readsFromCwd = false): boolean {
  if (words.length > MAX_WORDS_CHECKED) return false;
  // WHY: `grep -r x ~` never names a secret file, yet reads every one below home. Judged for folder-reading
  // commands only, so `ls ~` and `du -sh /` stay quiet. Every word is tried, so `rg x -- /` is caught too.
  if (readsFolders) {
    for (const w of words) if (containsCredentialFolders(w, cwd)) return false;
    // No folder named at all means the shell's own folder, which holds them only if it is home or above.
    if (readsFromCwd && containsCredentialFolders('.', cwd)) return false;
  }
  for (const raw of words) {
    // `--flag=value`: judge the value too (`--file=.env`), and the bare word itself.
    const candidates = new Set<string>([raw]);
    const eq = raw.indexOf('=');
    if (eq > 0) candidates.add(raw.slice(eq + 1));
    for (const c of candidates) {
      if (c === '' || c.startsWith('-') && !c.includes('/') && !c.includes('.')) continue;
      // WHY not just 'deny': the file tools ask before touching anything OUTSIDE the project ('external'); a look-only
      // command must not be quieter than they are, or `cat ~/Documents/taxes.txt` would run with no card.
      if (c === '/dev/null') continue; // reading nothing is harmless
      const home = os.homedir();
      // The shell expands a leading ~ before any program sees it; the path guard does not.
      const real = c === '~' ? home : c.startsWith('~/') ? path.join(home, c.slice(2)) : c;
      if (checkPathGuard(real, cwd).kind !== 'ok') return false;
      if (isExtraDenied(c, cwd)) return false;
    }
  }
  return true;
}

// Settings that make a read-only git command launch something, or reach elsewhere.
// Keys are lower-cased section.name (git lower-cases both; a subsection keeps its case).
const RUNS_PROGRAMS = [
  /^core\.(fsmonitor|pager|sshcommand|gitproxy|hookspath|askpass|alternaterefscommand|attributesfile|editor)$/,
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
  // A saved log format that includes the signature placeholders makes git run gpg on every signed commit.
  /^pretty\./,
  /^format\.pretty$/,
  // A partial clone fetches missing files from its remote the moment a read command needs one: network, plus the
  // remote's helper programs.
  /^remote\..*\.(promisor|partialclonefilter|uploadpack|receivepack|vcs|proxy)$/,
  /^(protocol|http)\./,
  /^url\..*\.(insteadof|pushinsteadof)$/,
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
async function findGitDirs(startDir: string, rootOut?: { root?: string }): Promise<string[] | null> {
  const exists = (p: string) => fs.promises.lstat(p).then((s) => s, () => null);
  let dir = path.resolve(startDir);
  for (let hops = 0; hops < 64; hops++) {
    const dotGit = path.join(dir, '.git');
    const st = await exists(dotGit);
    if (st) {
      if (rootOut) rootOut.root = dir;
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

/** Hooks that git runs on its own from plain read commands (the index rewrite after `git status`/`git diff`, ref
 *  updates, automatic cleanup). A repo that ships any of them is not safe to read quietly. Other hooks (pre-commit…)
 *  only fire on commands that are not on the list. Red team 2026-10-31 confirmed post-index-change fires. */
const READ_TRIGGERED_HOOKS = ['post-index-change', 'reference-transaction', 'fsmonitor-watchman', 'pre-auto-gc', 'post-rewrite'];

/** True only when the repo found from `startDir` has settings that run nothing. No repo found → true
 *  (git itself will just say "not a git repository"). Anything unreadable → false (ask). */
export async function gitSettingsRunNothing(startDir: string): Promise<boolean> {
  const rootOut: { root?: string } = {};
  const dirs = await findGitDirs(startDir, rootOut);
  if (dirs === null) return true;
  if (dirs.length === 0) return false;
  if (!(await gitDirsRunNothing(dirs))) return false;
  // Nested repositories (git "submodule" links) have their OWN settings, and `git status` runs inside them. A zip or
  // tar download can carry one with a helper program in it (red team 2026-10-31). Find them from the index.
  if (rootOut.root) {
    let out: string;
    try {
      // The overrides keep git itself from running anything while we merely ask it to list files.
      const r = await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/nonexistent', '--no-optional-locks', 'ls-files', '-s', '-z'],
        { cwd: rootOut.root, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
      out = r.stdout;
    } catch { return false; }
    const links = out.split('\0').filter((r) => r.startsWith('160000 ')).map((r) => r.slice(r.indexOf('\t') + 1));
    if (links.length > 50) return false;
    for (const rel of links) {
      const nested = await findGitDirs(path.join(rootOut.root, rel));
      if (nested === null) continue; // not checked out: nothing to run
      if (nested.length === 0 || !(await gitDirsRunNothing(nested))) return false;
    }
  }
  return true;
}

async function gitDirsRunNothing(dirs: string[]): Promise<boolean> {
  for (const gd of dirs) {
    for (const hook of READ_TRIGGERED_HOOKS) {
      if (await fs.promises.lstat(path.join(gd, 'hooks', hook)).then(() => true, () => false)) return false;
    }
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

/** The checks the engine's built-in read-only rule needs for one command, or undefined when the line is not on the
 *  list at all (then nothing is worth reading from disk). Full auto never calls this: it already allows everything. */
export async function readOnlyChecksFor(subject: string, here: string, powershell: boolean): Promise<{ pathsOk: boolean; gitOk: boolean } | undefined> {
  const v = readOnlyVerdict(subject, { powershell });
  if (!v.safe) return undefined;
  return {
    pathsOk: pathIsClean() && pathsAreNotSecret(v.words, here, v.readsFolders, v.readsFromCwd)
      && (!v.readsFromCwd || await searchTreeHasNoSecrets(v.words, here)),
    gitOk: v.usesGit ? await gitSettingsRunNothing(here) : true,
  };
}
