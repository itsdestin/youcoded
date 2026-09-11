// The artifact READ paths, as functions both transports call.
//
// WHY this module exists (remote access batch 3, technical design 2026-09-10
// §8): these bodies lived inline in ipc-handlers.ts, so a phone talking to the
// host over the WebSocket reached only what remote-server.ts had copied — one
// channel of fourteen. Everything else fell to its `unsupported` default and
// the phone's Files screens were empty. Moving the bodies here means the
// Electron handler and the remote `case` are two callers of ONE function: same
// roots, same denylist, same answer (contract row R7 — "with the same private
// paths hidden").
//
// The one divergence is `maxBytes`: the phone's preview ceilings
// (shared/remote-file-limits.ts) are smaller than the desktop's, and only the
// remote caller passes them. Over the ceiling the answer is
// `{ ok:false, error:'too-large', sizeBytes, limitBytes }` decided from `stat`
// alone — never a prefix, never a read (§9).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { looksBinary, EDIT_MAX_BYTES, FULL_READ_MAX_BYTES, READ_BINARY_MAX_BYTES } from '../../shared/artifacts/editable-path-policy';
import { decideOverCapRead } from '../../shared/artifacts/over-cap-read';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { readSidecarShared, runSidecarMigration } from './artifact-store';
import { discoveredFileRecord } from './project-file-discovery';
import { listProjects } from './central-index';
import { countArtifacts, projectAllFiles, isGatedRoot } from './projects-index';
import { evaluateBinaryRead } from './read-binary-access';
import { authorizeArtifactRead, isAbsoluteRecorded } from './write-authorization';
import { trackedArtifacts } from './visible-artifacts';
import { invalidateSidecarIdCache } from './project-watcher';
import { searchProjectContent } from './content-search';
import { readFolders } from '../saved-folders';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

/** The phone's ceiling for one read; absent on the desktop's own transport. */
export interface ReadCeiling {
  maxBytes?: number;
}

export interface TooLarge {
  ok: false;
  error: 'too-large';
  sizeBytes: number;
  limitBytes: number;
}

function tooLarge(sizeBytes: number, limitBytes: number): TooLarge {
  return { ok: false, error: 'too-large', sizeBytes, limitBytes };
}

/**
 * Repair legacy relative-external records before listing. The Session Drawer
 * is the only surface where an unpinned external is visible, so this is where
 * the false "no longer on disk" actually renders. Memoized per project per
 * process — the listing handlers also fire after every tracked write.
 *
 * Every other sidecar writer calls invalidateSidecarIdCache after committing
 * so the watcher's path-to-id map doesn't go stale; runSidecarMigration writes
 * too (it rewrites reclassified records' path/kind), and wiring that from
 * artifact-store.ts would import project-watcher.ts, which already imports
 * artifact-store.ts's readSidecar — a cycle. So it is done here, once for all
 * three listing paths, and only when a write actually happened.
 */
async function repairSidecar(projectRoot: string): Promise<void> {
  const migration = await runSidecarMigration(projectRoot);
  if (migration.migrated) invalidateSidecarIdCache(projectRoot);
}

/** Tracked files a session touched — the Session Drawer's list. */
export async function listSessionFiles(sessionId: string, projectRoot: string) {
  await repairSidecar(projectRoot);
  const sidecar = await readSidecarShared(projectRoot);
  if (!sidecar || 'corrupted' in sidecar) return { ok: true, artifacts: [] };
  const result = sidecar.artifacts.filter((a) =>
    a.versions.some((v) => v.sessionId === sessionId)
  );
  return { ok: true, artifacts: result };
}

/**
 * The project's TRACKED artifacts (files the assistant created or edited).
 * Synth (saved-folder) projects use their canonical PATH as id and have no
 * index entry — fall back to reading the sidecar at that path so their
 * artifacts resolve too. A bogus id simply yields no sidecar.
 */
export async function listProjectFiles(projectId: string, opts?: { withCount?: boolean }) {
  const projects = await listProjects(CLAUDE_DIR);
  const p = projects.find((x) => x.id === projectId);
  const projectRoot = p ? p.path : projectId;
  await repairSidecar(projectRoot);
  const sidecar = await readSidecarShared(projectRoot);

  let tracked: any[] = [];
  if (sidecar && !('corrupted' in sidecar)) {
    // Shared predicate — see visible-artifacts.ts for the full rules.
    tracked = trackedArtifacts(sidecar.artifacts as any[], sidecar.manualIncludes, sidecar.manualExcludes, projectRoot);
  }

  const visibleCount = opts?.withCount ? await countArtifacts(projectRoot) : undefined;
  return {
    ok: true,
    artifacts: tracked,
    ...(visibleCount !== undefined ? { visibleCount } : {}),
  };
}

/**
 * The project folder as it exists on disk: bounded, deterministic discovery
 * (stops at nested git repos), cached. NOT pure discovery — projectAllFiles()
 * UNIONS in any tracked INTERNAL artifact that exists on disk but discovery
 * did not reach. Gated roots (home dir / drive root) return { gated: true }
 * with no scan unless opts.force — the tab renders a "Browse anyway?" gate.
 */
export async function listAllFiles(projectId: string, opts?: { force?: boolean }) {
  const projects = await listProjects(CLAUDE_DIR);
  const p = projects.find((x) => x.id === projectId);
  const projectRoot = p ? p.path : projectId;
  if (isGatedRoot(projectRoot) && !opts?.force) {
    return { ok: true, files: [], truncated: false, gated: true };
  }
  // The repair runs AFTER the gated-root check so a gated root's sidecar is
  // never read and rewritten on a listing the user never confirmed.
  await repairSidecar(projectRoot);
  const r = await projectAllFiles(projectRoot);
  return { ok: true, files: r.files, truncated: r.truncated };
}

export type ResolvePathError =
  | 'bad-request'      // the call itself was malformed
  | 'not-found'        // inside the folder, nothing exists at that path
  | 'not-a-file'       // inside the folder, but a folder (or other non-file)
  | 'protected-path'   // a credential location refused for reads (editable-path-policy.ts)
  | 'outside-project'  // not inside the folder and not a tracked file
  | 'not-allowed';     // trackedOnly: not a file this folder's records name

export type ResolvePathResult =
  | { ok: true; artifact: ArtifactRecord }
  | { ok: false; error: ResolvePathError };

/** A tracked record's comparable absolute form, or null when it has none. */
function trackedAbsoluteForm(a: ArtifactRecord, projectRoot: string): string | null {
  if (a.kind === 'internal') return a.path ? canonicalize(path.join(projectRoot, a.path), null) : null;
  // A legacy relative absolutePath would resolve against the process cwd —
  // never let it match anything (write-authorization.ts, isAbsoluteRecorded).
  return a.absolutePath && isAbsoluteRecorded(a.absolutePath) ? canonicalize(a.absolutePath, null) : null;
}

/**
 * Which file does a path tapped in chat name? (artifacts:resolve-path)
 *
 * WHY this exists (2026-09-11, found on the owner's phone): the renderer used
 * to answer this by downloading the whole project list — 3,090 records, about
 * 1 MB, to a phone over Tailscale — and searching it; and a file discovery
 * never lists (inside a nested git repo) fell through to recording it with a
 * WRITE the phone is not allowed to make, so the phone said the file was not
 * found. One targeted question answers both.
 *
 * Order, and why:
 *  1. The tracked records (READ-ONLY sidecar copy): a tracked file keeps its
 *     id and history, and resolves even when the file is gone — the viewer
 *     already shows "no longer on disk" for those.
 *  2. `trackedOnly` stops here. The remote host passes it for a folder known
 *     only because a chat runs there: such a folder may hand out only what
 *     its chat recorded, and must not reveal whether other paths exist.
 *  3. Outside the folder → `outside-project`, decided from the strings ALONE.
 *     Looking at the file first would make this a way to ask whether any path
 *     on the computer exists.
 *  4. Inside the folder → the same symlink-resolving, in-folder, protected-path
 *     check artifacts:get applies (authorizeArtifactRead), then a stat. A file
 *     answers the exact record discovery would build for it.
 */
export async function resolveArtifactPath(
  projectRoot: unknown,
  clickedPath: unknown,
  opts?: { trackedOnly?: boolean },
): Promise<ResolvePathResult> {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0
      || typeof clickedPath !== 'string' || clickedPath.length === 0) {
    return { ok: false, error: 'bad-request' };
  }
  // `~` means the home folder of the computer that holds the files — this
  // one. The renderer cannot expand it (and on a phone its home is not ours).
  const expanded = clickedPath === '~' || /^~[\\/]/.test(clickedPath)
    ? path.join(os.homedir(), clickedPath.slice(1))
    : clickedPath;
  const absolute = path.resolve(projectRoot, expanded);
  const target = canonicalize(absolute, null);

  const sidecar = await readSidecarShared(projectRoot);
  if (sidecar && !('corrupted' in sidecar)) {
    const matches = sidecar.artifacts.filter((a) => trackedAbsoluteForm(a, projectRoot) === target);
    // Two records can name one path (a deleted one and a re-created one): the live one wins.
    const hit = matches.find((a) => a.status !== 'deleted') ?? matches[0];
    if (hit) return { ok: true, artifact: hit };
  }
  if (opts?.trackedOnly) return { ok: false, error: 'not-allowed' };

  const root = canonicalize(path.resolve(projectRoot), null);
  const inside = target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`);
  if (!inside) return { ok: false, error: 'outside-project' };

  let auth: Awaited<ReturnType<typeof authorizeArtifactRead>>;
  try {
    auth = await authorizeArtifactRead(projectRoot, absolute, true);
  } catch (e: any) {
    // A path THROUGH a file (notes.md/x) — there is nothing at that path.
    if (e?.code === 'ENOTDIR') return { ok: false, error: 'not-found' };
    throw e;
  }
  if (!auth.ok) {
    if ('orphan' in auth) return { ok: false, error: 'not-found' };
    // artifact-not-found here means the RESOLVED path left the folder: a link
    // inside it pointing somewhere else.
    return { ok: false, error: auth.error === 'protected-path' ? 'protected-path' : 'outside-project' };
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(auth.realPath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, error: 'not-found' };
    throw e;
  }
  if (!st.isFile()) return { ok: false, error: 'not-a-file' };
  return { ok: true, artifact: discoveredFileRecord(canonicalize(absolute, projectRoot), st.mtime.toISOString()) };
}

/**
 * Read a text artifact. `full` opts into a BIGGER read (up to
 * FULL_READ_MAX_BYTES) for a file the pane is showing as a prefix — never an
 * unbounded one. With `maxBytes` (the phone), a file over the ceiling answers
 * too-large from `stat`, before any of the prefix logic below runs.
 */
export async function readArtifactText(
  projectRoot: string,
  artifactId: string,
  opts?: { full?: boolean } & ReadCeiling,
) {
  const sidecar = await readSidecarShared(projectRoot);
  const artifact = (sidecar && !('corrupted' in sidecar))
    ? sidecar.artifacts.find((a) => a.id === artifactId)
    : undefined;

  let fullPath: string;
  if (artifact) {
    fullPath = artifact.kind === 'internal'
      ? path.join(projectRoot, artifact.path)
      : artifact.absolutePath!;
  } else {
    // Discovered (on-disk) file: the id IS a canonical relative path. Resolve
    // it inside the project root and refuse anything that escapes (traversal
    // guard) so this can't be used to read arbitrary files.
    const resolved = path.resolve(projectRoot, artifactId);
    const root = path.resolve(projectRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, error: 'artifact-not-found' };
    }
    fullPath = resolved;
  }

  // Symlink-resolve + in-root + sensitive-read policy, all on the RESOLVED
  // path (write-authorization.ts owns the logic + its tests).
  const readAuth = await authorizeArtifactRead(projectRoot, fullPath, !artifact || artifact.kind === 'internal');
  if (!readAuth.ok) {
    if ('orphan' in readAuth) return { ok: true, artifact: artifact ?? null, content: null, orphan: true };
    return { ok: false, error: readAuth.error };
  }
  const realPath = readAuth.realPath;

  // Size gate BEFORE reading: a multi-MB readFile blocks the main thread,
  // ships whole over IPC/WS, then blocks the renderer rendering it.
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(realPath);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    return { ok: true, artifact: artifact ?? null, content: null, orphan: true };
  }
  if (opts?.maxBytes !== undefined && st.size > opts.maxBytes) return tooLarge(st.size, opts.maxBytes);

  // Over the cap we do not refuse blind. Sniff the head first: an over-cap
  // IMAGE used to get the TEXT editor's error message. Text comes back as a
  // readable prefix.
  const wantsFull = opts?.full === true && st.size <= FULL_READ_MAX_BYTES;
  if (st.size > EDIT_MAX_BYTES && !wantsFull) {
    const fh = await fs.promises.open(realPath, 'r');
    try {
      // fs.read is only contractually required to return SOME bytes, not to
      // fill the buffer — so loop until the window is full or the file ends.
      const readFully = async (len: number) => {
        const buf = Buffer.allocUnsafe(len);
        let off = 0;
        while (off < len) {
          const { bytesRead } = await fh.read(buf, off, len - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        return buf.subarray(0, off);
      };
      // Head first, so a file that turns out to be binary is decided on 8 KB.
      const head = await readFully(8192);
      const win = await readFully(EDIT_MAX_BYTES);
      const d = decideOverCapRead(head, win);
      return {
        ok: true, artifact: artifact ?? null, orphan: false,
        content: d.content, binary: d.binary, truncated: d.truncated,
        sizeBytes: st.size, mtimeMs: st.mtimeMs,
      };
    } finally {
      await fh.close();
    }
  }

  let content: string | null = null;
  let binary = false;
  try {
    const buf = await fs.promises.readFile(realPath);
    // Head-slice NUL sniff: binary bytes decoded as utf8 turn into U+FFFD
    // soup — return binary:true + null content so the renderer routes to the
    // binary fallback instead of a garbage text view.
    binary = looksBinary(buf.subarray(0, 8192));
    if (!binary) content = buf.toString('utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    return { ok: true, artifact: artifact ?? null, content: null, orphan: true };
  }
  // mtimeMs is the optimistic-concurrency token: round-trip it into
  // artifacts:save as baseMtimeMs and the save is rejected when the file
  // changed underneath. sizeBytes and truncated ride EVERY response: the
  // renderer derives editability from the size, and a `full` read must clear
  // the partial bar.
  return { ok: true, artifact: artifact ?? null, content, orphan: false, binary,
           truncated: false, sizeBytes: st.size, mtimeMs: st.mtimeMs };
}

/**
 * Each path in BOTH its recorded canonical form and its resolved (realpath)
 * canonical form. WHY both: the reads compare a file's REAL path against these
 * roots, and a root recorded through a symlink — macOS's /tmp → /private/tmp,
 * a home directory on another volume — would otherwise never match its own
 * files, which is exactly what turned every image and PDF refused in such a
 * project the first time realpath was applied (2026-09-10 review of T6,
 * finding 4). Unresolvable entries (a folder that is gone) keep their
 * recorded form only.
 */
async function withRealForms(paths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(paths.map(async (p) => {
    if (!p) return;
    out.add(canonicalize(p, null));
    const real = await fs.promises.realpath(p).catch(() => null);
    if (real) out.add(canonicalize(real, null));
  }));
  return out;
}

/**
 * The user's known project roots (saved folders + central-index projects),
 * canonicalized in both forms, plus — on request — every tracked EXTERNAL
 * artifact path and manual include from each root's sidecar (a temp-dir xlsx
 * the session drawer legitimately shows lives outside every root).
 */
async function knownRoots(): Promise<string[]> {
  return [...await withRealForms([
    ...readFolders().map((f) => f.path),
    ...(await listProjects(CLAUDE_DIR)).map((p) => p.path),
  ])];
}

async function trackedExternalPaths(roots: string[]): Promise<Set<string>> {
  const recorded: string[] = [];
  for (const root of roots) {
    const sidecar = await readSidecarShared(root).catch(() => null);
    if (!sidecar || 'corrupted' in sidecar) continue;
    for (const a of sidecar.artifacts) {
      if (a.kind === 'external' && a.absolutePath) recorded.push(a.absolutePath);
    }
    for (const inc of sidecar.manualIncludes) recorded.push(inc.path);
  }
  return withRealForms(recorded);
}

/**
 * Is `root` one the desktop itself shows — a saved folder, an indexed project,
 * or (the caller's `extraRoots`) a live session's working folder — in either
 * its recorded or resolved form? The remote host gates every root a phone
 * names on this (technical design §8 "same roots"): the desktop's renderer only
 * ever asks about roots it was given, but a phone's payload is the phone's.
 */
export async function isKnownRoot(root: unknown, extraRoots: readonly string[] = []): Promise<boolean> {
  if (typeof root !== 'string' || root.length === 0) return false;
  const known = new Set([...await knownRoots(), ...await withRealForms(extraRoots)]);
  for (const form of await withRealForms([root])) if (known.has(form)) return true;
  return false;
}

/** A `projectId` is known when it names an indexed project, or is itself a known root (the synth-project convention). */
export async function isKnownProjectRef(projectId: unknown, extraRoots: readonly string[] = []): Promise<boolean> {
  if (typeof projectId !== 'string' || projectId.length === 0) return false;
  if ((await listProjects(CLAUDE_DIR)).some((p) => p.id === projectId)) return true;
  return isKnownRoot(projectId, extraRoots);
}

export type BytesAuthorization =
  | { ok: true; realPath: string }
  // 'no path' | 'not-allowed' | 'orphan', or the I/O error's own text.
  | { ok: false; error: string };

/**
 * May `absolutePath` be handed out as raw bytes? Resolves the path FIRST —
 * `fs.promises.realpath`, then `canonicalize`, then `evaluateBinaryRead` on
 * the result. WHY realpath (design review R2-1): canonicalize() is string
 * work and readFile follows symlinks, so a link under a project root pointing
 * at ~/.ssh/id_rsa used to pass both the denylist and the root check by its
 * own innocent name. Reads are limited to the user's project folders and
 * tracked artifacts, and well-known secret locations are refused even inside
 * those roots. Shared by read-binary on both transports and by Download.
 */
export async function authorizeBytesRead(absolutePath: unknown): Promise<BytesAuthorization> {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
    return { ok: false, error: 'no path' };
  }
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(absolutePath);
  } catch (e: any) {
    return { ok: false, error: e?.code === 'ENOENT' ? 'orphan' : String(e?.message ?? e) };
  }
  const canon = canonicalize(realPath, null);
  // Saved folders and indexed projects only — never a folder known just because
  // a session runs there. A phone can start a session in any folder, and a
  // by-path read there handed out every file in it (T7 re-review, finding 1).
  const roots = await knownRoots();
  let verdict = evaluateBinaryRead(canon, roots, new Set());
  if (verdict === 'outside-roots') {
    // Second pass (rare): the tracked externals and manual includes.
    verdict = evaluateBinaryRead(canon, roots, await trackedExternalPaths(roots));
  }
  if (verdict !== 'allowed') return { ok: false, error: 'not-allowed' };
  return { ok: true, realPath };
}

/**
 * Read a file as base64 for the binary viewers (xlsx/docx/pdf/image). The
 * renderer can't fetch a file:// URL from the http(dev)/app(prod) origin, so
 * bytes come through the bridge — which on remote-access setups is reachable
 * from a phone, hence the authorization above.
 */
export async function readArtifactBytes(absolutePath: unknown, opts?: ReadCeiling) {
  try {
    const auth = await authorizeBytesRead(absolutePath);
    if (!auth.ok) return auth;
    // Size gate before reading — a huge file would freeze the renderer (and
    // the WS transport) long before the viewer could reject it. The phone's
    // ceiling, when given, is the smaller number.
    const limit = Math.min(opts?.maxBytes ?? READ_BINARY_MAX_BYTES, READ_BINARY_MAX_BYTES);
    const st = await fs.promises.stat(auth.realPath);
    if (st.size > limit) return tooLarge(st.size, limit);
    const buf = await fs.promises.readFile(auth.realPath);
    return { ok: true, base64: buf.toString('base64') };
  } catch (e: any) {
    return { ok: false, error: e?.code === 'ENOENT' ? 'orphan' : String(e?.message ?? e) };
  }
}

/** Project-wide content search (ripgrep in main). */
export function searchArtifactContent(projectRoot: unknown, query: unknown) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0 || typeof query !== 'string') {
    return Promise.resolve({ ok: false, hits: [], truncated: false, error: 'projectRoot and query are required' });
  }
  return searchProjectContent(projectRoot, query);
}

/**
 * Batch-check whether each requested artifact's resolved path still exists on
 * disk, so the renderer can mark "file not on disk" artifacts as deleted
 * without mutating the sidecar. Internal artifacts resolve to projectRoot/path;
 * external artifacts to absolutePath.
 */
export async function checkArtifactExistence(projectRoot: string, artifactIds: string[]) {
  if (!projectRoot || !Array.isArray(artifactIds) || artifactIds.length === 0) {
    return { ok: true, missingIds: [] as string[] };
  }
  const sidecar = await readSidecarShared(projectRoot);
  if (!sidecar || 'corrupted' in sidecar) return { ok: true, missingIds: [] as string[] };
  const byId = new Map(sidecar.artifacts.map((a) => [a.id, a]));
  const results = await Promise.all(
    artifactIds.map(async (id) => {
      const a = byId.get(id);
      if (!a) return id; // unknown id treated as missing
      // A corrupt record (relative absolutePath) resolves against the PROCESS
      // cwd here, which cuts both ways: it reports an in-project file as
      // missing AND would report an artifact as present if a same-named file
      // happens to sit in the process cwd — so a relative external is missing.
      const fullPath = a.kind === 'internal'
        ? path.join(projectRoot, a.path)
        : a.absolutePath;
      if (!fullPath) return id;
      if (a.kind !== 'internal' && !isAbsoluteRecorded(fullPath)) return id;
      try {
        await fs.promises.access(fullPath);
        return null;
      } catch {
        return id;
      }
    })
  );
  return { ok: true, missingIds: results.filter((x): x is string => x !== null) };
}
