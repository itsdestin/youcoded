// Pins the generic backup -> atomic-replace -> verify -> automatic-rollback
// pipeline T13 (docs/active/specs/2026-09-26-doc-comments-build-design.md
// §4.3, mirroring §3.3 steps 1/6) factored out for xlsx-comments.ts's own
// write path (`desktop/src/main/doc-comments/write-pipeline.ts`) — the same
// contract docx-comments.ts's own `writeDocxMutation` pins inline in
// docx-comments.test.ts, tested here once at the shared-module level since
// EVERY xlsx write op (add/reply/resolve/reopen/move) delegates its
// backup/atomic-write/verify/rollback behaviour to this one function.
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileMutation, backupPathFor } from '../src/main/doc-comments/write-pipeline';

async function withScratchFile<T>(content: string, fn: (target: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ycd-write-pipeline-'));
  const target = join(dir, 'target.xlsx');
  await writeFile(target, content);
  try {
    return await fn(target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// T11 review (F1/F5, applied here at the shared-module level): the backup no
// longer lives next to the target file (a sibling `.bak-<timestamp>`, which a
// project's own git repo or cloud-sync folder would pick up) — it's one
// ROLLING file at a stable, hashed path under `~/.claude/youcoded-doc-
// backups/` (`backupPathFor`), kept after a successful write rather than
// deleted. These tests were rewritten against that location and lifecycle.
describe('write-pipeline — verify-after-write with automatic rollback', () => {
  it('a failed verification restores the original bytes exactly, and clears the backup it consumed', async () => {
    await withScratchFile('original bytes', async (target) => {
      const before = await readFile(target);
      const backupPath = backupPathFor(target, '.xlsx.bak');
      const result = await writeFileMutation<{}, { ok: false; error: string }>(
        target,
        '.xlsx.bak',
        async (bytes) => ({ ok: true, bytes: Buffer.concat([bytes, Buffer.from('!')]) }),
        async () => false // the injected fault: verification always fails
      );
      expect(result).toEqual({ ok: false, error: 'verify-failed' });
      expect(await readFile(target)).toEqual(before); // restored byte-for-byte
      // Rolled back means RENAMED back over the target — the backup no
      // longer exists afterward (it now IS the live file again).
      expect(await exists(backupPath)).toBe(false);
    });
  });

  it('the backup exists WHILE verify runs, and is KEPT (not deleted) after a successful write', async () => {
    await withScratchFile('original bytes', async (target) => {
      const backupPath = backupPathFor(target, '.xlsx.bak');
      const before = await readFile(target);
      let sawBackupDuringVerify = false;
      const result = await writeFileMutation<{}, { ok: false; error: string }>(
        target,
        '.xlsx.bak',
        async (bytes) => ({ ok: true, bytes }),
        async () => {
          sawBackupDuringVerify = await exists(backupPath);
          return true;
        }
      );
      expect(result).toEqual({ ok: true });
      expect(sawBackupDuringVerify).toBe(true);
      expect(await exists(backupPath)).toBe(true); // KEPT after success (F5)
      expect(await readFile(backupPath)).toEqual(before); // holds the PRE-write bytes
    });
  });

  it('one rolling backup per file — a second successful write overwrites the same backup path', async () => {
    await withScratchFile('original bytes', async (target) => {
      const backupPath = backupPathFor(target, '.xlsx.bak');
      const firstOriginal = await readFile(target);
      await writeFileMutation<{}, { ok: false; error: string }>(target, '.xlsx.bak', async (bytes) => ({ ok: true, bytes }), async () => true);
      expect(await readFile(backupPath)).toEqual(firstOriginal);

      const secondOriginal = await readFile(target);
      await writeFileMutation<{}, { ok: false; error: string }>(
        target,
        '.xlsx.bak',
        async (bytes) => ({ ok: true, bytes: Buffer.concat([bytes, Buffer.from('!')]) }),
        async () => true
      );
      // Same path both times, now holding the SECOND write's pre-write bytes
      // — overwritten in place, never accumulated as a second file.
      expect(backupPathFor(target, '.xlsx.bak')).toBe(backupPath);
      expect(await readFile(backupPath)).toEqual(secondOriginal);
    });
  });

  it('a mutate-level refusal never touches the file at all — no backup, no write', async () => {
    await withScratchFile('original bytes', async (target) => {
      const before = await readFile(target);
      const backupPath = backupPathFor(target, '.xlsx.bak');
      const result = await writeFileMutation<{}, { ok: false; error: 'refused' }>(
        target,
        '.xlsx.bak',
        async () => ({ ok: false, error: 'refused' }),
        async () => true
      );
      expect(result).toEqual({ ok: false, error: 'refused' });
      expect(await readFile(target)).toEqual(before);
      expect(await exists(backupPath)).toBe(false);
    });
  });

  // F1 (T11 review — blocker): `verify` now also receives the file's ORIGINAL
  // bytes, so a format-specific check can scope itself to what THIS operation
  // changed instead of judging the whole file (docx-comments.ts's own
  // `verifyOoxmlWiring` uses this to ignore a dangling relationship the file
  // already had before the write).
  it('passes the ORIGINAL (pre-write) bytes as verify\'s third argument', async () => {
    await withScratchFile('original bytes', async (target) => {
      const originalOnDisk = await readFile(target);
      let seenOriginal: Buffer | undefined;
      const result = await writeFileMutation<{}, { ok: false; error: string }>(
        target,
        '.xlsx.bak',
        async (bytes) => ({ ok: true, bytes: Buffer.concat([bytes, Buffer.from('!')]) }),
        async (_newBytes, _extra, originalBytes) => {
          seenOriginal = originalBytes;
          return true;
        }
      );
      expect(result).toEqual({ ok: true });
      expect(seenOriginal).toEqual(originalOnDisk);
    });
  });

  // A `verify` callback with FEWER parameters (exactly what xlsx-comments.ts
  // itself still passes, unmodified) must keep type-checking and running —
  // this is the whole reason the new third parameter is additive-only.
  it('still accepts a verify callback that ignores the extra originalBytes parameter', async () => {
    await withScratchFile('original bytes', async (target) => {
      const result = await writeFileMutation<{}, { ok: false; error: string }>(
        target,
        '.xlsx.bak',
        async (bytes) => ({ ok: true, bytes }),
        async () => true // arity 0 — never reads newBytes/extra/originalBytes
      );
      expect(result).toEqual({ ok: true });
    });
  });
});

describe('write-pipeline — concurrency', () => {
  it('two mutations on one file serialize, and neither is lost', async () => {
    await withScratchFile('0', async (target) => {
      const [a, b] = await Promise.all([
        writeFileMutation<{ tag: string }, { ok: false; error: string }>(
          target,
          '.xlsx.bak',
          async (bytes) => ({ ok: true, bytes: Buffer.from(`${bytes.toString()}+a`), tag: 'a' }),
          async () => true
        ),
        writeFileMutation<{ tag: string }, { ok: false; error: string }>(
          target,
          '.xlsx.bak',
          async (bytes) => ({ ok: true, bytes: Buffer.from(`${bytes.toString()}+b`), tag: 'b' }),
          async () => true
        ),
      ]);
      expect(a).toEqual({ ok: true, tag: 'a' });
      expect(b).toEqual({ ok: true, tag: 'b' });
      // Serialized (never interleaved/lost): the final content carries BOTH
      // mutations, one applied after seeing the other's own write, never a
      // read-original-mutate-write race that drops one side.
      const final = (await readFile(target)).toString();
      expect(final).toMatch(/^0(\+a\+b|\+b\+a)$/);
    });
  });
});
