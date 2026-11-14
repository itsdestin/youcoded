// Shared helpers for the device-layer tests.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach } from 'vitest';

const made: string[] = [];
/** A throwaway folder, removed after each test. (vitest already points HOME and TMPDIR at a sandbox.) */
export function tmp(prefix = 'mesh-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
afterEach(() => {
  while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

/** All files below a folder, relative, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(path.relative(dir, f));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/** A fake of Electron's safeStorage that really transforms the bytes (so "plaintext not on disk" is checkable). */
export function fakeSafeStorage(backend: string | undefined, available = true) {
  const key = Buffer.alloc(32, 0x5a);
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(Buffer.from(s, 'utf8').map((b, i) => b ^ key[i % 32])),
    decryptString: (b: Buffer) => Buffer.from(b.map((x, i) => x ^ key[i % 32])).toString('utf8'),
    ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
  };
}
