// git-snapshot.ts — the handful of `git` commands the plugin installer runs, without the git program.
//
// WHY (2026-11-25, iPhone app, card #89): every marketplace install — the built-in plugins (Themes, Pages, the
// publisher, chat search) and anything a person adds — is fetched with `git` (plugin-installer.ts). iOS forbids an
// app from starting any program, so on an iPhone there is no git, and without this nothing from the marketplace
// could ever be installed there. GitHub serves any commit or branch of a public repository as one archive
// (codeload.github.com/<owner>/<repo>/tar.gz/<ref>), and that is all the installer ever needs from git: "the files
// of this repository at this commit". This answers the installer's exact command lines from such archives, so
// plugin-installer.ts keeps ONE code path (it calls `runGit`, which comes here where no program can run).
//
// It is NOT git: no history, no objects, no local changes. A folder it fills holds a snapshot of one commit and a
// small record of which commit that is (`.youcoded-snapshot.json`), which is what answers `rev-parse`.
//
// What stands in for git's own integrity check: the archive is requested BY COMMIT ID over TLS from GitHub, and the
// commit id GitHub writes into the archive itself is compared with the one asked for. That trusts GitHub's servers
// to hand out the right commit where git verifies every object's hash itself — acceptable for the same public
// repositories the app already fetches its catalog from, and stated here so nobody assumes more.
//
// Symbolic links in an archive are never created (the installer's own rule, security audit SC-10, and an iPhone
// has nowhere for them to usefully point).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

export interface GitResult { ok: boolean; output: string }

/** Fetch an archive's bytes. Injected so tests serve one from memory. */
export type ArchiveFetcher = (url: string) => Promise<Buffer>;

const RECORD = '.youcoded-snapshot.json';
const STAGE = '.youcoded-fetched';
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

interface SnapshotRecord { url: string; commit: string; ref: string }

const defaultFetcher: ArchiveFetcher = async (url) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ARCHIVE_BYTES) throw new Error('The download is larger than this app accepts.');
  return buf;
};

/** https://github.com/<owner>/<repo>(.git) → the archive address for one ref. Only github.com over https. */
export function archiveUrl(repoUrl: string, ref: string): string | null {
  let u: URL;
  try { u = new URL(repoUrl); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') return null;
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p))) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) return null;
  return `https://codeload.github.com/${parts[0]}/${parts[1]}/tar.gz/${ref}`;
}

interface TarEntry { path: string; type: 'file' | 'dir' | 'other'; data: Buffer; mode: number }

/** Read a .tar.gz into its entries, plus the commit id `git archive` records in the archive's global header. */
export function readTarGz(archive: Buffer): { commit: string | null; entries: TarEntry[] } {
  const tar = zlib.gunzipSync(archive, { maxOutputLength: 4 * MAX_ARCHIVE_BYTES });
  const entries: TarEntry[] = [];
  let commit: string | null = null;
  let longPath: string | null = null;
  const text = (b: Buffer) => { const end = b.indexOf(0); return b.subarray(0, end < 0 ? b.length : end).toString('utf8'); };
  /** pax records are "<length> <key>=<value>\n". */
  const pax = (b: Buffer): Record<string, string> => {
    const out: Record<string, string> = {};
    let i = 0;
    while (i < b.length) {
      const space = b.indexOf(0x20, i);
      if (space < 0) break;
      const len = Number(b.subarray(i, space).toString('ascii'));
      if (!Number.isFinite(len) || len <= 0) break;
      const record = b.subarray(space + 1, i + len - 1).toString('utf8');
      const eq = record.indexOf('=');
      if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
      i += len;
    }
    return out;
  };
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    if (header.every((x) => x === 0)) break;
    const size = parseInt(text(header.subarray(124, 136)).trim() || '0', 8) || 0;
    const flag = String.fromCharCode(header[156] || 0x30);
    const prefix = text(header.subarray(345, 500));
    const name = text(header.subarray(0, 100));
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (flag === 'g') { const c = pax(body).comment; if (c && /^[0-9a-f]{40}$/.test(c)) commit = c; continue; }
    if (flag === 'x') { const p = pax(body).path; if (p) longPath = p; continue; }
    if (flag === 'L') { longPath = text(body); continue; }
    const full = longPath ?? (prefix ? `${prefix}/${name}` : name);
    longPath = null;
    const type = flag === '0' || flag === '\0' ? 'file' : flag === '5' ? 'dir' : 'other';
    entries.push({ path: full, type, data: type === 'file' ? Buffer.from(body) : Buffer.alloc(0), mode: parseInt(text(header.subarray(100, 108)).trim() || '644', 8) || 0o644 });
  }
  return { commit, entries };
}

/** Write an archive's files under `dest`, dropping the single top folder GitHub wraps everything in. Never writes
 *  outside `dest`, and never creates a link. */
async function extract(entries: TarEntry[], dest: string): Promise<void> {
  const root = path.resolve(dest);
  await fs.promises.mkdir(root, { recursive: true });
  for (const e of entries) {
    const parts = e.path.split('/').filter(Boolean).slice(1); // drop "<repo>-<commit>/"
    if (parts.length === 0 || parts.some((p) => p === '..' || p === '.')) continue;
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    if (e.type === 'dir') await fs.promises.mkdir(target, { recursive: true });
    else if (e.type === 'file') {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, e.data, { mode: (e.mode & 0o111) ? 0o755 : 0o644 });
    }
  }
}

async function readRecord(dir: string): Promise<SnapshotRecord | null> {
  try { return JSON.parse(await fs.promises.readFile(path.join(dir, RECORD), 'utf8')) as SnapshotRecord; } catch { return null; }
}

async function download(url: string, ref: string, into: string, fetcher: ArchiveFetcher): Promise<SnapshotRecord> {
  const address = archiveUrl(url, ref);
  if (!address) throw new Error('Only public GitHub repositories can be downloaded on this device.');
  const { commit, entries } = readTarGz(await fetcher(address));
  if (!commit) throw new Error('The download did not say which version it is, so it was not used.');
  // Asked for an exact commit: the archive must be that commit, or it is not used.
  if (/^[0-9a-f]{40}$/.test(ref) && commit !== ref) throw new Error('The downloaded version is not the one that was asked for, so it was not used.');
  await fs.promises.rm(into, { recursive: true, force: true });
  await extract(entries, into);
  const record: SnapshotRecord = { url, commit, ref };
  await fs.promises.writeFile(path.join(into, RECORD), JSON.stringify(record));
  return record;
}

/** Move a fetched snapshot's files over a folder's own (everything except the staging area). */
async function replaceContents(dir: string, from: string): Promise<void> {
  for (const name of await fs.promises.readdir(dir)) {
    if (name === STAGE) continue;
    await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
  }
  for (const name of await fs.promises.readdir(from)) {
    await fs.promises.cp(path.join(from, name), path.join(dir, name), { recursive: true });
  }
}

/**
 * Answer one `git …` command line the way the installer expects, from GitHub archives.
 * Understands exactly the forms plugin-installer.ts uses; anything else is refused by name (never guessed at).
 */
export async function gitFromSnapshots(args: string[], fetcher: ArchiveFetcher = defaultFetcher): Promise<GitResult> {
  try {
    if (args[0] === 'clone') {
      const rest = args.slice(1);
      let branch: string | null = null;
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--branch') branch = rest[++i];
        else if (rest[i] === '--depth') i++;
        else if (!rest[i].startsWith('--')) positional.push(rest[i]);
      }
      const [url, dir] = positional;
      if (!url || !dir) return { ok: false, output: 'clone needs a repository and a folder' };
      await download(url, branch ?? 'HEAD', dir, fetcher);
      return { ok: true, output: '' };
    }
    if (args[0] !== '-C' || !args[1]) return { ok: false, output: `this device cannot run: git ${args.join(' ')}` };
    const dir = args[1];
    const cmd = args.slice(2);
    const record = await readRecord(dir);
    if (!record) return { ok: false, output: 'not a downloaded repository' };
    const staged = (commit: string) => path.join(dir, STAGE, commit);
    const has = async (commit: string) => record.commit === commit || (await readRecord(staged(commit)))?.commit === commit;

    if (cmd[0] === 'rev-parse') {
      const wanted = cmd[cmd.length - 1];
      if (wanted === 'HEAD') return { ok: true, output: `${record.commit}\n` };
      const commit = wanted.replace(/\^\{commit\}$/, '');
      return (await has(commit)) ? { ok: true, output: `${commit}\n` } : { ok: false, output: '' };
    }
    if (cmd[0] === 'fetch') {
      const target = cmd[cmd.length - 1];
      if (/^[0-9a-f]{40}$/.test(target)) {
        if (!(await has(target))) await download(record.url, target, staged(target), fetcher);
        return { ok: true, output: '' };
      }
      // `fetch origin`: the branch's newest files, kept aside until `reset --hard` takes them.
      await download(record.url, record.ref, staged('latest'), fetcher);
      return { ok: true, output: '' };
    }
    if (cmd[0] === 'reset' && cmd[1] === '--hard') {
      const latest = await readRecord(staged('latest'));
      if (!latest) return { ok: false, output: 'nothing was fetched' };
      await replaceContents(dir, staged('latest'));
      await fs.promises.rm(staged('latest'), { recursive: true, force: true });
      return { ok: true, output: '' };
    }
    if (cmd[0] === 'checkout') {
      const sep = cmd.indexOf('--');
      const commit = cmd.find((a) => /^[0-9a-f]{40}$/.test(a));
      if (!commit || !(await has(commit))) return { ok: false, output: 'that version has not been downloaded' };
      const source = record.commit === commit ? dir : staged(commit);
      if (sep >= 0) {
        // `checkout --force <commit> -- <path>`: just that folder, as it is in that commit.
        const rel = cmd[sep + 1];
        const from = path.resolve(source, rel);
        const to = path.resolve(dir, rel);
        if (!from.startsWith(path.resolve(source) + path.sep) || !to.startsWith(path.resolve(dir) + path.sep)) return { ok: false, output: 'invalid path' };
        if (!(await fs.promises.stat(from).then(() => true, () => false))) return { ok: false, output: `pathspec '${rel}' did not match any files` };
        if (from !== to) {
          await fs.promises.rm(to, { recursive: true, force: true });
          await fs.promises.mkdir(path.dirname(to), { recursive: true });
          await fs.promises.cp(from, to, { recursive: true });
        }
        return { ok: true, output: '' };
      }
      // `checkout --detach <commit>`: the whole folder becomes that commit.
      if (source !== dir) {
        await replaceContents(dir, source);
        await fs.promises.rm(staged(commit), { recursive: true, force: true });
      }
      return { ok: true, output: '' };
    }
    // The whole snapshot is already on disk, so narrowing it to one folder has nothing to do.
    if (cmd[0] === 'sparse-checkout') return { ok: true, output: '' };
    return { ok: false, output: `this device cannot run: git ${cmd.join(' ')}` };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}
