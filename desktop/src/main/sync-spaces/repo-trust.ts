// desktop/src/main/sync-spaces/repo-trust.ts
// Decide whether an EXISTING <root>/.youcoded/sync.git is one this app made.
//
// WHY (security hardening, 2026-10-30): the hidden sync repo lives INSIDE the
// project folder. A project someone else made (downloaded, cloned, imported)
// can ship its own .youcoded/sync.git, and git runs hooks, "fsmonitor" and
// other helper programs named in that repo's config as the user — and would
// send the GitHub token wherever its remote points. The old init() trusted any
// folder that merely had a HEAD file.
//
// We cannot prove who created a folder, but we CAN check what is in it: a repo
// this app created only ever holds a handful of plain settings. Anything else
// (a helper command, a rewritten address, an include, an alternate object
// store) means "not ours" and sync refuses to touch it.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const SYNC_REPO_UNTRUSTED_ERROR_CODE = 'sync-repo-untrusted';

/** Every config key a repo made by this app (or by `git init` for it) can hold.
 *  Keys are compared lower-cased; the subsection of remote/branch keys is
 *  matched exactly (origin / main) because that is all the app ever creates. */
const ALLOWED_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  // core.worktree: `git init` writes it because we run with GIT_WORK_TREE. Harmless to accept
  // (any value, even stale after a folder move): the GIT_WORK_TREE env var always overrides it.
  'core.worktree',
  'core.symlinks', 'core.ignorecase', 'core.precomposeunicode', 'core.autocrlf', 'core.longpaths',
  'user.name', 'user.email',
  'remote.origin.url', 'remote.origin.fetch',
  'branch.main.remote', 'branch.main.merge',
]);

/** Files that redirect git to somewhere else or add object sources. */
const FORBIDDEN_FILES = ['commondir', 'gitdir', 'config.worktree', path.join('objects', 'info', 'alternates'), path.join('objects', 'info', 'http-alternates')];

/** Pure: is this remote address one the app could have set? GitHub over https,
 *  or (tests, dev setups) an absolute LOCAL path/file URL outside the project
 *  folder. Helper-program forms (`ext::`), ssh/git/http schemes, userinfo tricks
 *  and anything relative to the project folder are refused. */
export function isTrustedRemoteUrl(url: string, root: string): boolean {
  if (/^https:\/\/github\.com\/[^\s/@]+\/[^\s]+$/.test(url)) return true;
  let local = url;
  if (/^file:\/\//i.test(url)) local = url.replace(/^file:\/\//i, '').replace(/^\/(?=[A-Za-z]:)/, '');
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) || /^[A-Za-z0-9+.-]{2,}::/.test(url)) return false;
  if (!path.isAbsolute(local)) return false;
  const rel = path.relative(path.resolve(root), path.resolve(local));
  return rel.startsWith('..') || path.isAbsolute(rel);
}

/** Pure: judge parsed `key -> values` config entries. Returns the offending key
 *  (for the log; never shown to the user) or null when everything is expected. */
export function findUntrustedConfigEntry(entries: Array<[string, string]>, root: string): string | null {
  for (const [rawKey, value] of entries) {
    // git lower-cases section and variable names but keeps the subsection
    // (the middle part of remote.<name>.url) exactly as written.
    const first = rawKey.indexOf('.');
    const last = rawKey.lastIndexOf('.');
    const key = first === last
      ? rawKey.toLowerCase()
      : `${rawKey.slice(0, first).toLowerCase()}.${rawKey.slice(first + 1, last)}.${rawKey.slice(last + 1).toLowerCase()}`;
    const norm = key;
    if (!ALLOWED_KEYS.has(norm)) return rawKey;
    if (key === 'remote.origin.url' && !isTrustedRemoteUrl(value, root)) return rawKey;
    if (key === 'remote.origin.fetch' && value !== '+refs/heads/*:refs/remotes/origin/*') return rawKey;
    if (key === 'branch.main.remote' && value !== 'origin') return rawKey;
  }
  return null;
}

/** Inspect an existing sync repo folder. Returns null when it is trusted (or
 *  does not exist yet), otherwise a short internal reason for the log. */
export async function inspectSyncRepo(gd: string, root: string): Promise<string | null> {
  // Async on purpose: this runs on the app's main thread (tests/main-blocking-calls).
  const exists = (p: string) => fs.promises.lstat(p).then(() => true, () => false);
  let st: fs.Stats;
  try { st = await fs.promises.lstat(gd); } catch { return null; } // nothing there yet: init will create it
  if (st.isSymbolicLink() || !st.isDirectory()) return 'sync.git is not a plain folder';
  for (const f of FORBIDDEN_FILES) {
    if (await exists(path.join(gd, f))) return `unexpected ${f}`;
  }
  const cfg = path.join(gd, 'config');
  if (!(await exists(cfg))) return null;
  let out: string;
  try {
    // `--file` reads ONLY this file and runs nothing; -z keeps values with newlines intact.
    const r = await execFileAsync('git', ['config', '--file', cfg, '--list', '-z'], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    out = r.stdout;
  } catch {
    return 'config unreadable';
  }
  const entries: Array<[string, string]> = out.split('\0').filter(Boolean).map((rec) => {
    const i = rec.indexOf('\n');
    return i < 0 ? [rec, ''] : [rec.slice(0, i), rec.slice(i + 1)];
  });
  const bad = findUntrustedConfigEntry(entries, root);
  return bad ? `unexpected setting ${bad}` : null;
}

/** The plain-language refusal the sync panel shows (docs/error-message-standards.md). */
export function untrustedRepoError(reason: string): Error {
  const e: any = new Error(
    'This folder came with its own hidden sync data that YouCoded did not create, so sync is paused for it. ' +
    'If you trust the folder, delete or rename the ".youcoded" folder inside it and sync will start fresh. ' +
    `(${reason})`,
  );
  e.syncErrorCode = SYNC_REPO_UNTRUSTED_ERROR_CODE;
  return e;
}
