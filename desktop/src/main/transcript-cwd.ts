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

// WHY chunked (2026-09-26): this read a fixed 512 KB head and decoded ALL of it
// to a string, though the cwd is almost always within the first few lines. The
// launch-time slug repair calls it for every transcript (~3,300 on a big
// history): profiled at ~1.1 s of string decoding alone, part of a ~9 s repair.
// Reading 16 KB at a time and stopping at the first match scans the same lines
// in the same order — same 512 KB / 200-line bounds — without the waste.
const HEAD_CHUNK_BYTES = 16 * 1024;

/** R2 — session origin.
 *  `platform` is a test seam: the foreign-cwd filter is platform-relative
 *  (see `isForeignCwd`), so callers that need to pin a specific platform
 *  (tests running fixtures on any CI OS) can override the default of
 *  `process.platform` here instead of only inside `isForeignCwd` itself —
 *  otherwise a POSIX fixture silently only tests correctly on POSIX runners
 *  (this exact gap turned 4 tests wrong on the Windows CI leg). */
export async function firstCwd(filePath: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  return scanFirstCwd(filePath, platform).catch(() => null);
}

/** firstCwd, except an unreadable file THROWS instead of reading as "no cwd" —
 *  for callers that remember the answer and must never remember a failed read. */
export async function scanFirstCwd(filePath: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const accept = (line: string): string | null => {
    const cwd = extractCwd(line);
    return cwd && !isForeignCwd(cwd, platform) ? cwd : null;
  };
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    let pending = Buffer.alloc(0);
    let pos = 0;
    let lines = 0;
    while (pos < HEAD_BYTES && lines < R2_SCAN_CAP) {
      const want = Math.min(HEAD_CHUNK_BYTES, HEAD_BYTES - pos);
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await fh.read(chunk, 0, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      // Split on the newline BYTE: 0x0A never occurs inside a multi-byte UTF-8
      // character, so a line is only decoded once it is complete.
      let start = 0;
      let nl: number;
      while (lines < R2_SCAN_CAP && (nl = pending.indexOf(0x0a, start)) !== -1) {
        lines++;
        const cwd = accept(pending.toString('utf8', start, nl));
        if (cwd) return cwd;
        start = nl + 1;
      }
      pending = pending.subarray(start);
    }
    // The text after the last newline (end of file, or cut off at HEAD_BYTES)
    // is still a line to the old split('\n') — scan it the same way.
    if (lines < R2_SCAN_CAP && pending.length) return accept(pending.toString('utf8'));
    return null;
  }
  // WHY .catch on close: a rejection thrown inside `finally` REPLACES the
  // function's return value. An uncaught close failure would turn a successful
  // read into a throw that climbs firstCwd -> r1CwdForDir -> resolveSlugToPath,
  // which session-browser.ts awaits outside any try — so the whole Resume
  // Browser listing would reject and show nothing. A failed close must stay
  // invisible, never cost the listing.
  finally { await fh?.close().catch(() => {}); }
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
