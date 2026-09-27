// Pins the generic backup -> atomic-replace -> verify -> automatic-rollback
// pipeline T13 (docs/active/specs/2026-09-26-doc-comments-build-design.md
// §4.3, mirroring §3.3 steps 1/6) factored out for xlsx-comments.ts's own
// write path (`desktop/src/main/doc-comments/write-pipeline.ts`) — the same
// contract docx-comments.ts's own `writeDocxMutation` pins inline in
// docx-comments.test.ts, tested here once at the shared-module level since
// EVERY xlsx write op (add/reply/resolve/reopen/move) delegates its
// backup/atomic-write/verify/rollback behaviour to this one function.
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileMutation } from '../src/main/doc-comments/write-pipeline';

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

describe('write-pipeline — verify-after-write with automatic rollback', () => {
  it('a failed verification restores the original bytes exactly, and cleans up the backup', async () => {
    await withScratchFile('original bytes', async (target) => {
      const before = await readFile(target);
      const result = await writeFileMutation<{}, { ok: false; error: string }>(
        target,
        '.xlsx.bak',
        async (bytes) => ({ ok: true, bytes: Buffer.concat([bytes, Buffer.from('!')]) }),
        async () => false // the injected fault: verification always fails
      );
      expect(result).toEqual({ ok: false, error: 'verify-failed' });
      expect(await readFile(target)).toEqual(before); // restored byte-for-byte

      const dir = join(target, '..');
      const leftover = (await readdir(dir)).filter((f) => f.includes('.xlsx.bak-'));
      expect(leftover).toHaveLength(0); // renamed back over the target, nothing left behind
    });
  });

  it('the backup exists WHILE verify runs, and is cleaned up after a successful write', async () => {
    await withScratchFile('original bytes', async (target) => {
      const dir = join(target, '..');
      let sawBackupDuringVerify = false;
      const result = await writeFileMutation<{}, { ok: false; error: string }>(
        target,
        '.xlsx.bak',
        async (bytes) => ({ ok: true, bytes }),
        async () => {
          const files = await readdir(dir);
          sawBackupDuringVerify = files.some((f) => f.includes('.xlsx.bak-'));
          return true;
        }
      );
      expect(result).toEqual({ ok: true });
      expect(sawBackupDuringVerify).toBe(true);
      const filesAfter = await readdir(dir);
      expect(filesAfter.some((f) => f.includes('.xlsx.bak-'))).toBe(false);
    });
  });

  it('a mutate-level refusal never touches the file at all — no backup, no write', async () => {
    await withScratchFile('original bytes', async (target) => {
      const before = await readFile(target);
      const result = await writeFileMutation<{}, { ok: false; error: 'refused' }>(
        target,
        '.xlsx.bak',
        async () => ({ ok: false, error: 'refused' }),
        async () => true
      );
      expect(result).toEqual({ ok: false, error: 'refused' });
      expect(await readFile(target)).toEqual(before);
      const dir = join(target, '..');
      expect((await readdir(dir)).filter((f) => f.includes('.bak-'))).toHaveLength(0);
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
