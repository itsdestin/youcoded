import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CloudFileSupervisor } from './supervisor';
import { CLOUD_IO_LIMITS, PATH_READ_MAX_BYTES } from './worker-protocol';
import type { CloudReadOptions, NeedsDownload } from '../../shared/cloud-path-types';

export interface PathReadOptions extends CloudReadOptions {
  /** Trusted transport/session identity, never spread from a renderer payload. */
  owner?: string;
  maxBytes?: number;
  /** Trusted text-reader policy, not a renderer-supplied byte limit. */
  prefix?: { bytes: number; fullUpTo?: number };
}
type Ready = { ok: true; bytes: Buffer; sizeBytes: number; mtimeMs: number };
type Refused = NeedsDownload | { ok: false; error: string; sizeBytes?: number; limitBytes?: number };
let supervisor: CloudFileSupervisor | undefined;
const workerOwner = Symbol('pathname-preflight');
async function io() {
  if (!supervisor) {
    // WHY: Linux keeps its existing read path and never loads Electron/Koffi.
    const { spawnCloudIoWorker } = await import('./utility-worker');
    supervisor ??= new CloudFileSupervisor(spawnCloudIoWorker);
  }
  return supervisor;
}
export async function pathAvailability(target: string, deadlineMs = 3000) {
  if (process.platform !== 'win32') return { residency: 'local' as const, sizeBytes: -1, mtimeMs: -1 };
  try {
    const result = await (await io()).submit(workerOwner, 'preview', { kind: 'path-probe', path: path.resolve(target) }, Math.max(1, Math.min(3000, deadlineMs))).done;
    if (result.kind === 'path-probe') return result;
  } catch { /* unknown is never permission to read */ }
  return { residency: 'unknown' as const, sizeBytes: -1, mtimeMs: -1 };
}
type Grant = { path: string; owner: string; size: number; mtime: number; max: number; prefix: boolean; expires: number };
const grants = new Map<string, Grant>();

/** Windows-only content path. undefined means use the unchanged non-Windows reader.
 * IMPORTANT: metadata + pathname/size/mtime binding narrows races but is NOT atomic
 * stable-file identity, and cannot guarantee a provider won't recall after probing.
 * No provider/path-name guesses, persistent grants, or noRecall claims are made. */
export async function readPath(target: string, options: PathReadOptions = {}): Promise<Ready | Refused | undefined> {
  if (process.platform !== 'win32') return undefined;
  const resolved = path.resolve(target);
  const observation = await pathAvailability(resolved);
  // WHY: normal text previews read only a bounded prefix, even for very large
  // files. Full opt-in expands the window only below the existing full-read cap.
  const prefix = !!options.prefix && !(options.prefix.fullUpTo !== undefined && observation.sizeBytes <= options.prefix.fullUpTo);
  const max = Math.min(prefix ? options.prefix!.bytes : (options.prefix?.fullUpTo ?? options.maxBytes ?? CLOUD_IO_LIMITS.readBytes), options.maxBytes ?? PATH_READ_MAX_BYTES, PATH_READ_MAX_BYTES);
  const owner = options.owner ?? 'passive';
  for (const [id, g] of grants) if (g.expires < Date.now()) grants.delete(id);
  const token = typeof options.operationToken === 'string' ? options.operationToken : '';
  const grant = grants.get(token);
  const approved = options.intent === 'explicit' && !!grant && grant.path === resolved && grant.owner === owner &&
    grant.size === observation.sizeBytes && grant.mtime === observation.mtimeMs && grant.max === max && grant.prefix === prefix;
  // WHY: consume a capability once even if the subsequent worker fails. A retry
  // requires fresh observation/consent, and cannot switch file, owner, or size cap.
  if (approved) grants.delete(token);
  if (observation.residency === 'absent') return { ok: false, error: 'orphan' };
  const sizeLimit = options.maxBytes ?? (prefix ? undefined : max);
  if (sizeLimit !== undefined && observation.sizeBytes > sizeLimit) return { ok: false, error: 'too-large', sizeBytes: observation.sizeBytes, limitBytes: sizeLimit };
  if (observation.residency !== 'local' && !approved) {
    let operationToken: string | undefined;
    if (options.intent === 'explicit' && options.owner) {
      if (grants.size >= 256) grants.delete(grants.keys().next().value!);
      operationToken = randomUUID();
      grants.set(operationToken, { path: resolved, owner, size: observation.sizeBytes, mtime: observation.mtimeMs, max, prefix, expires: Date.now() + 120_000 });
    }
    return { ok: false, error: 'needs-download', path: resolved, name: path.basename(resolved), sizeBytes: observation.sizeBytes, operationToken };
  }
  try {
    const result = await (await io()).submit(workerOwner, approved ? 'purposeful' : 'preview', {
      kind: 'path-read', path: resolved, maxBytes: max, allowDownload: approved, prefix,
      ...(approved ? { expectedSize: observation.sizeBytes, expectedMtime: observation.mtimeMs } : {}),
    }, approved ? 120_000 : 5000).done;
    if (result.kind === 'path-ready') return { ok: true, bytes: Buffer.from(result.base64, 'base64'), sizeBytes: result.sizeBytes, mtimeMs: result.mtimeMs };
    return { ok: false, error: result.kind };
  } catch { return { ok: false, error: 'file-read-unavailable' }; }
}

/** Passive metadata/instruction callers get no bytes for unavailable files. */
export async function passiveRead(target: string, maxBytes = CLOUD_IO_LIMITS.readBytes): Promise<Buffer | null> {
  const result = await readPath(target, { intent: 'preview', maxBytes });
  if (result) return result.ok ? result.bytes : null;
  try {
    const st = await fs.stat(target);
    if (!st.isFile() || st.size > maxBytes) return null;
    return await fs.readFile(target);
  } catch { return null; }
}
/** Callers must apply their existing path authorization BEFORE this seam. */
export async function requiredRead(target: string, sessionId: string, options: CloudReadOptions = {}) {
  const result = await readPath(target, { ...options, intent: 'explicit', owner: sessionId });
  if (result) return result;
  const bytes = await passiveRead(target);
  return bytes ? { ok: true as const, bytes, sizeBytes: bytes.length, mtimeMs: 0 } : { ok: false as const, error: 'file-read-unavailable' };
}
