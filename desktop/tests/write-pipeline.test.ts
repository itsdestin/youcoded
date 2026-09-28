// Pins the generic backup -> atomic-replace -> verify -> automatic-rollback
// pipeline T13 (docs/active/specs/2026-09-26-doc-comments-build-design.md
// §4.3, mirroring §3.3 steps 1/6) factored out for xlsx-comments.ts's own
// write path (`desktop/src/main/doc-comments/write-pipeline.ts`) — the same
// contract docx-comments.ts's own `writeDocxMutation` pins inline in
// docx-comments.test.ts, tested here once at the shared-module level since
// EVERY xlsx write op (add/reply/resolve/reopen/move) delegates its
// backup/atomic-write/verify/rollback behaviour to this one function.
import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile, mkdtemp, rm, stat } from 'fs/promises';
import { promises as fsp } from 'fs';
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

  // F1 (T17 implementation review, major/durability): the tmp file's bytes
  // are fsynced to disk BEFORE the rename that makes them visible as the
  // real target — a bare rename says nothing about whether the OS has
  // actually flushed the bytes the new name points at.
  describe('F1 — fsync before rename', () => {
    it('opens the tmp file for fsync before renaming it onto the target', async () => {
      await withScratchFile('original bytes', async (target) => {
        const openSpy = vi.spyOn(fsp, 'open');
        const renameSpy = vi.spyOn(fsp, 'rename');
        try {
          const result = await writeFileMutation<{}, { ok: false; error: string }>(
            target,
            '.xlsx.bak',
            async (bytes) => ({ ok: true, bytes }),
            async () => true
          );
          expect(result).toEqual({ ok: true });
          expect(openSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);
          expect(renameSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);
          // The FIRST fs.open call (the fsync handle on the tmp file) ran
          // strictly before the FIRST fs.rename call.
          expect(openSpy.mock.invocationCallOrder[0]).toBeLessThan(renameSpy.mock.invocationCallOrder[0]);
        } finally {
          openSpy.mockRestore();
          renameSpy.mockRestore();
        }
      });
    });

    it('a failing fsync leaves the target byte-identical and removes the backup it had already written', async () => {
      await withScratchFile('original bytes', async (target) => {
        const before = await readFile(target);
        const backupPath = backupPathFor(target, '.xlsx.bak');
        const originalOpen = fsp.open.bind(fsp);
        // Inject the fault on the FIRST fs.open call only — the tmp file's
        // fsync handle — by wrapping the real handle and making its own
        // `sync()` reject, proving the write path actually calls `sync()`
        // (not merely `open()`) before it can proceed to rename.
        const openSpy = vi.spyOn(fsp, 'open').mockImplementationOnce(async (...args: Parameters<typeof fsp.open>) => {
          const handle = await originalOpen(...args);
          handle.sync = async () => {
            throw new Error('simulated fsync failure');
          };
          return handle;
        });
        try {
          const result = await writeFileMutation<{}, { ok: false; error: string }>(
            target,
            '.xlsx.bak',
            async (bytes) => ({ ok: true, bytes: Buffer.concat([bytes, Buffer.from('!')]) }),
            async () => true
          );
          expect(result).toEqual({ ok: false, error: 'write-failed' });
          expect(await readFile(target)).toEqual(before); // rename never ran
          expect(await exists(backupPath)).toBe(false); // cleaned up — the real target was never touched either way
        } finally {
          openSpy.mockRestore();
        }
      });
    });
  });
});

// T11 follow-up (design §3.3's new step 0, design review round 3 F4): refuse
// 'file-open-elsewhere' when a real Word/Excel `~$<name>` owner file or a
// LibreOffice `.~lock.<name>#` lock file sits beside the target — BEFORE
// step 1 (backup) ever runs. Implemented once, here, so every caller (the
// renderer's direct IPC mutation, a native tool, and the MCP pending-mutation
// queue's applier) gets the identical refusal automatically.
describe('write-pipeline — step 0: refuses a file open elsewhere before backup', () => {
  it('refuses \'file-open-elsewhere\' when a Word/Excel owner file (~$<name>) sits beside the target, before touching the backup or the target', async () => {
    await withScratchFile('original bytes', async (target) => {
      const dir = target.slice(0, target.lastIndexOf('/'));
      const name = target.slice(target.lastIndexOf('/') + 1);
      const ownerFile = join(dir, `~$${name}`);
      await writeFile(ownerFile, 'winword');
      const before = await readFile(target);
      const backupPath = backupPathFor(target, '.xlsx.bak');
      let mutateCalled = false;
      const result = await writeFileMutation<{}, { ok: false; error: string }>(
        target,
        '.xlsx.bak',
        async (bytes) => { mutateCalled = true; return { ok: true, bytes }; },
        async () => true
      );
      expect(result).toEqual({ ok: false, error: 'file-open-elsewhere' });
      expect(mutateCalled).toBe(false); // never even reached mutate/backup
      expect(await exists(backupPath)).toBe(false);
      expect(await readFile(target)).toEqual(before); // the target itself is untouched
    });
  });

  it('refuses \'file-open-elsewhere\' when a LibreOffice lock file (.~lock.<name>#) sits beside the target', async () => {
    await withScratchFile('original bytes', async (target) => {
      const dir = target.slice(0, target.lastIndexOf('/'));
      const name = target.slice(target.lastIndexOf('/') + 1);
      const lockFile = join(dir, `.~lock.${name}#`);
      await writeFile(lockFile, ',destin,localhost,01-01-2026 00:00,file:///home/destin;');
      const backupPath = backupPathFor(target, '.xlsx.bak');
      const result = await writeFileMutation<{}, { ok: false; error: string }>(
        target,
        '.xlsx.bak',
        async (bytes) => ({ ok: true, bytes }),
        async () => true
      );
      expect(result).toEqual({ ok: false, error: 'file-open-elsewhere' });
      expect(await exists(backupPath)).toBe(false);
    });
  });

  it('proceeds normally once the lock file is gone (the common "since closed it" case)', async () => {
    await withScratchFile('original bytes', async (target) => {
      const dir = target.slice(0, target.lastIndexOf('/'));
      const name = target.slice(target.lastIndexOf('/') + 1);
      const ownerFile = join(dir, `~$${name}`);
      await writeFile(ownerFile, 'winword');
      const firstAttempt = await writeFileMutation<{}, { ok: false; error: string }>(
        target, '.xlsx.bak', async (bytes) => ({ ok: true, bytes }), async () => true
      );
      expect(firstAttempt).toEqual({ ok: false, error: 'file-open-elsewhere' });
      await rm(ownerFile, { force: true });
      const retry = await writeFileMutation<{}, { ok: false; error: string }>(
        target, '.xlsx.bak', async (bytes) => ({ ok: true, bytes }), async () => true
      );
      expect(retry).toEqual({ ok: true });
    });
  });

  it('a sibling file that merely SHARES a prefix (not the exact lock-file shape) does not refuse', async () => {
    await withScratchFile('original bytes', async (target) => {
      const dir = target.slice(0, target.lastIndexOf('/'));
      // "target.xlsx.bak" and "~$other.xlsx" (a DIFFERENT file's owner marker)
      // must never false-positive against "target.xlsx".
      await writeFile(join(dir, 'target.xlsx.bak'), 'unrelated');
      await writeFile(join(dir, '~$other.xlsx'), 'unrelated');
      const result = await writeFileMutation<{}, { ok: false; error: string }>(
        target, '.xlsx.bak', async (bytes) => ({ ok: true, bytes }), async () => true
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
