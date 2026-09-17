import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSource, readStripped } from './helpers/guard-scope';

describe('guard-scope readers', () => {
  it('readSource and readStripped never hand back a carriage return', () => {
    // WHY: a Windows checkout is CRLF; every text guard that split on '\n' then
    // saw "nsis:\r" and matched nothing (Windows CI, 2026-09-10 to 09-16).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-reader-'));
    const file = path.join(dir, 'crlf.ts');
    fs.writeFileSync(file, 'a: 1\r\n// comment\r\nb: 2\r\n');
    expect(readSource(file)).toBe('a: 1\n// comment\nb: 2\n');
    expect(readStripped(file).split('\n')).toHaveLength(4);
    expect(readStripped(file)).not.toContain('\r');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
