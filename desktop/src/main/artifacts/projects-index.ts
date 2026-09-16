// Shared project-index computation.
//
// Extracted verbatim from ipc-handlers.ts, where it lived as closures inside
// registerIpcHandlers and was therefore reachable ONLY from Electron IPC. The
// remote WebSocket server needs the identical result — remote browsers were
// showing an empty Project View because remote-server.ts had no handler for
// artifacts:list-projects-index at all, so the request was silently dropped and
// the shim's 30s timer eventually rejected it.
//
// Behaviour is unchanged; this is a move, not a rewrite. Both callers now share
// one implementation so the two transports cannot drift.

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { readSidecarShared } from './artifact-store';
import { listProjects } from './central-index';
import { buildSavedFolderProjects } from './saved-folder-projects';
import { trackedArtifacts } from './visible-artifacts';
import { isAbsoluteRecorded } from './write-authorization';
import { discoverProjectFiles, discoveredFileRecord } from './project-file-discovery';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { readFolders, type SavedFolder } from '../saved-folders';
import { getManagedRoots } from '../sync-spaces/service';
import { listPastSessions } from '../session-browser';
import { ccProjectSlug } from '../slug-encoding';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ARTIFACTS: files Claude directly created/edited (sidecar tracked, internal or
// external — see visible-artifacts.ts for the rules), non-deleted AND still on
// disk (orphans excluded). Feeds the ProjectSwitcher row hint; the Artifacts tab
// this was written for merged into Files on 2026-07-23. NO on-disk discovery is
// mixed in here.
export async function countArtifacts(projectRoot: string): Promise<number> {
  const sidecar = await readSidecarShared(projectRoot);
  if (!sidecar || 'corrupted' in sidecar) return 0;
  const visible = trackedArtifacts(sidecar.artifacts as any[], sidecar.manualIncludes, sidecar.manualExcludes, projectRoot)
    .filter((a: any) => a.status !== 'deleted');
  // Drop orphans — files marked 'active' but bash-rm'd off disk (CC has no
  // Delete tool, so this is the common case). fs.access in parallel is cheap.
  const alive = await Promise.all(visible.map(async (a: any) => {
    const full = a.kind === 'internal' ? path.join(projectRoot, a.path) : a.absolutePath;
    // Fix: a null `absolutePath` (a malformed/legacy external record) must be
    // treated as not-alive BEFORE isAbsoluteRecorded runs — that guard calls
    // path.isAbsolute(), which throws a TypeError on null/undefined rather than
    // returning false. The old `fs.access(null)` call threw INSIDE the try
    // below and was swallowed to `false`; this guard sits OUTSIDE that try, so
    // an unguarded null would throw out of countArtifacts instead of quietly
    // not counting the record. Same corrupt-record guard as
    // artifacts:check-existence otherwise — never let fs.access resolve a
    // relative record against the process cwd and count a coincidentally-named
    // file as this artifact.
    if (a.kind !== 'internal' && (full == null || !isAbsoluteRecorded(full))) return false;
    try { await fs.promises.access(full); return true; } catch { return false; }
  }));
  return alive.filter(Boolean).length;
}

// ALL FILES = on-disk discovery UNIONed with any tracked artifact that exists on
// disk but discovery didn't reach (e.g. an artifact inside a skipped nested
// sub-repo). The union GUARANTEES All files is a SUPERSET of Artifacts — it is
// nonsensical for a project to report fewer "all files" than "artifacts".
export async function projectAllFiles(projectRoot: string): Promise<{ files: any[]; truncated: boolean }> {
  let scan: { files: any[]; truncated: boolean };
  try { scan = await discoverProjectFiles(projectRoot); }
  catch { scan = { files: [], truncated: false }; }
  const seen = new Set(scan.files.map((f: any) => f.path));
  const sidecar = await readSidecarShared(projectRoot);
  const extra: any[] = [];
  if (sidecar && !('corrupted' in sidecar)) {
    const candidates = sidecar.artifacts.filter((a) => {
      if (a.kind !== 'internal' || a.status === 'deleted') return false;
      return !seen.has(canonicalize(a.path, projectRoot));
    });
    const alive = await Promise.all(candidates.map(async (a) => {
      try { await fs.promises.access(path.join(projectRoot, a.path)); return true; }
      catch { return false; }
    }));
    candidates.forEach((a, i) => {
      if (!alive[i]) return;
      const rel = canonicalize(a.path, projectRoot);
      if (seen.has(rel)) return; // two sidecar entries can canonicalize to one path
      seen.add(rel);
      // Same record the discovery walk builds — one builder, so the two cannot drift.
      extra.push(discoveredFileRecord(rel, a.lastModified ?? ''));
    });
  }
  return { files: [...scan.files, ...extra], truncated: scan.truncated };
}

// A "gated" root is the user's whole home directory or a drive/filesystem root —
// trees so large that discovery ALWAYS hits its caps, making the resulting
// list/count an arbitrary, run-to-run-varying sample.
export function isGatedRoot(projectRoot: string): boolean {
  const canon = canonicalize(projectRoot, null);
  if (canon === canonicalize(os.homedir(), null)) return true;
  return /^[a-z]:?$/.test(canon) || canon === '/' || /^[a-z]:\/$/.test(canon);
}

export async function countAllFiles(projectRoot: string): Promise<{ count: number; truncated: boolean } | null> {
  if (isGatedRoot(projectRoot)) return null; // gated — no scan, no fake number
  try {
    const r = await projectAllFiles(projectRoot);
    return { count: r.files.length, truncated: r.truncated };
  } catch { return { count: 0, truncated: false }; }
}

/** The artifacts:list-projects-index payload, shared by the Electron IPC handler
 *  and the remote WebSocket server. */
export async function listProjectsIndex(opts?: { withCounts?: boolean }): Promise<{ ok: true; projects: any[] }> {
  let saved: SavedFolder[] = readFolders();
  if (saved.length === 0) {
    // Mirror the folder picker's first-use seed so a fresh install isn't empty.
    saved = [{ path: os.homedir(), nickname: 'Home', addedAt: Date.now() }];
  }
  // Managed sync projects always appear in Project View, exactly like the
  // session picker's FOLDERS_LIST synthesizes them (2026-07-13 dogfood fix): a
  // project materialized by cross-device discovery is created in the main
  // process, is NEVER written to youcoded-folders.json, and has no central-index
  // entry until it gains a tracked artifact. Append at the END so a saved entry
  // for the same path wins (keeps the user's nickname).
  const managed = getManagedRoots()?.listProjects() ?? [];
  for (const p of managed) saved.push({ path: p.path, nickname: p.name, addedAt: 0 });
  const indexProjects = await listProjects(CLAUDE_DIR);
  const projects = buildSavedFolderProjects(saved, indexProjects);

  // Conversation counts: a single global session scan, bucketed by CC slug.
  // Only when requested — listPastSessions is heavier (global), and ChatView's
  // frequent cwd-resolution calls don't need it.
  const ccSlug = ccProjectSlug;
  let convBySlug: Map<string, number> | null = null;
  if (opts?.withCounts) {
    const sessions = await listPastSessions();
    convBySlug = new Map();
    for (const s of sessions) convBySlug.set(s.projectSlug, (convBySlug.get(s.projectSlug) ?? 0) + 1);
  }

  // The stored stats.artifactCount is seeded to 0 and almost always stale, so
  // compute it live per project.
  const computed = await Promise.all(projects.map(async (p) => {
    let artifactCount: number;
    let fileCount: number | undefined;
    let fileCountTruncated: boolean | undefined;
    let conversationCount: number | undefined;
    if (opts?.withCounts) {
      artifactCount = await countArtifacts(p.path);
      const allFiles = await countAllFiles(p.path);
      if (allFiles !== null) {
        fileCount = allFiles.count;
        fileCountTruncated = allFiles.truncated || undefined;
      }
      conversationCount = convBySlug!.get(ccSlug(p.path)) ?? 0;
    } else {
      // Fast path for ChatView's frequent cwd-resolution calls: cheap sidecar-
      // only artifact count, no on-disk scan and no existence check.
      const sidecar = await readSidecarShared(p.path);
      let trackedCount = 0;
      if (sidecar && !('corrupted' in sidecar)) {
        trackedCount = trackedArtifacts(sidecar.artifacts as any[], sidecar.manualIncludes, sidecar.manualExcludes, p.path)
          .filter((a: any) => a.status !== 'deleted').length;
      }
      artifactCount = trackedCount;
    }

    return {
      ...p,
      stats: { ...p.stats, artifactCount },
      ...(fileCount !== undefined ? { fileCount } : {}),
      ...(fileCountTruncated ? { fileCountTruncated } : {}),
      ...(conversationCount !== undefined ? { conversationCount } : {}),
    };
  }));
  return { ok: true, projects: computed };
}
