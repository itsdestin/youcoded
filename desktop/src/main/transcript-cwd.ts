// desktop/src/main/transcript-cwd.ts
// The two transcript-ownership rules from the spec (§5.4). They answer
// DIFFERENT questions and an earlier draft conflated them — read the spec
// section before "simplifying" one into the other.
//   R2 firstCwd(file)   — "which project does this SESSION belong to?"
//                         First non-foreign cwd; 200-line cap is safe here
//                         (observed max first-cwd line: 49).
//   R1 r1CwdForDir(dir) — "which path does this slug DIRECTORY encode?"
//                         Accept only a cwd that re-slugs to the dirname;
//                         must scan WHOLE files (the motivating fork's
//                         matching cwd first appears at line 279).
import fs from 'fs';
import path from 'path';
import { ccProjectSlug } from './slug-encoding';

export const R2_SCAN_CAP = 200;
const HEAD_BYTES = 512 * 1024;

/** A cwd recorded by a PEER platform's device (materialized transcript) —
 *  must never be resolved on this one (spec risk 3: 376/648 files here). */
export function isForeignCwd(cwd: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return cwd.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(cwd);
}

function extractCwd(lineText: string): string | null {
  if (!lineText.includes('"cwd"')) return null;
  try {
    const cwd = (JSON.parse(lineText) as { cwd?: unknown }).cwd;
    return typeof cwd === 'string' && cwd ? cwd : null;
  } catch { return null; }
}

// WHY (perf/main-thread-async-reads, Task 2): every read in this file ran on
// fs.*Sync — the Resume Browser calls into firstCwd/r1CwdForDir once per
// project slug on every browse (session-browser.ts), so a large
// ~/.claude/projects tree froze the main thread for the whole scan. Bounded
// head read — R2 never needs more than the first lines, and some
// transcripts are >13MB.
async function headText(filePath: string): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch { return null; }
  finally { await fh?.close(); }
}

/** R2 — session origin.
 *  `platform` is a test seam: the foreign-cwd filter is platform-relative
 *  (see `isForeignCwd`), so callers that need to pin a specific platform
 *  (tests running fixtures on any CI OS) can override the default of
 *  `process.platform` here instead of only inside `isForeignCwd` itself —
 *  otherwise a POSIX fixture silently only tests correctly on POSIX runners
 *  (this exact gap turned 4 tests wrong on the Windows CI leg). */
export async function firstCwd(filePath: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const head = await headText(filePath);
  if (head === null) return null;
  const lines = head.split('\n').slice(0, R2_SCAN_CAP);
  for (const l of lines) {
    const cwd = extractCwd(l);
    if (cwd && !isForeignCwd(cwd, platform)) return cwd;
  }
  return null;
}

/** Every cwd in the file — full read; used by R1's exhaustive tier. */
export async function allCwds(filePath: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  let raw: string;
  try { raw = await fs.promises.readFile(filePath, 'utf8'); } catch { return []; }
  const out: string[] = [];
  for (const l of raw.split('\n')) {
    const cwd = extractCwd(l);
    if (cwd) out.push(cwd);
  }
  return out;
}

/** R1 — directory identity. Tier 1 (cheap): each file's first cwd. Tier 2
 *  (exhaustive): every cwd in every file. Lowercased compare matches
 *  buildSlugToName's Windows case-drift convention (reconciler.ts). */
export async function r1CwdForDir(dirPath: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const dirName = path.basename(dirPath).toLowerCase();
  let files: string[] = [];
  try { files = (await fs.promises.readdir(dirPath)).filter(f => f.endsWith('.jsonl')); } catch { return null; }
  for (const f of files) {
    const cwd = await firstCwd(path.join(dirPath, f), platform);
    if (cwd && ccProjectSlug(cwd).toLowerCase() === dirName) return cwd;
  }
  for (const f of files) {
    for (const cwd of await allCwds(path.join(dirPath, f), platform)) {
      if (!isForeignCwd(cwd, platform) && ccProjectSlug(cwd).toLowerCase() === dirName) return cwd;
    }
  }
  return null;
}
