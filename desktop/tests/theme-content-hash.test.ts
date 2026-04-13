import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { computeThemeContentHash } from '../src/main/theme-content-hash';

describe('computeThemeContentHash', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'theme-hash-'));
    await fs.promises.writeFile(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({ name: 'Test', tokens: { canvas: '#fff' } }),
    );
    await fs.promises.mkdir(path.join(tmp, 'assets'));
    await fs.promises.writeFile(path.join(tmp, 'assets', 'a.png'), Buffer.from([1, 2, 3]));
    await fs.promises.writeFile(path.join(tmp, 'assets', 'b.png'), Buffer.from([4, 5, 6]));
  });

  afterAll(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it('produces a sha256:<hex> hash', async () => {
    const h = await computeThemeContentHash(tmp);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across calls', async () => {
    const h1 = await computeThemeContentHash(tmp);
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).toBe(h2);
  });

  it('is order-independent for assets', async () => {
    const h1 = await computeThemeContentHash(tmp);
    // Touch mtime by rewriting in reverse — content unchanged, order on disk may shift
    await fs.promises.writeFile(path.join(tmp, 'assets', 'b.png'), Buffer.from([4, 5, 6]));
    await fs.promises.writeFile(path.join(tmp, 'assets', 'a.png'), Buffer.from([1, 2, 3]));
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).toBe(h2);
  });

  it('changes when manifest changes', async () => {
    const h1 = await computeThemeContentHash(tmp);
    await fs.promises.writeFile(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({ name: 'Test2', tokens: { canvas: '#fff' } }),
    );
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).not.toBe(h2);
  });

  it('changes when an asset changes', async () => {
    const h1 = await computeThemeContentHash(tmp);
    await fs.promises.writeFile(path.join(tmp, 'assets', 'a.png'), Buffer.from([9, 9, 9]));
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).not.toBe(h2);
  });

  it('ignores existing contentHash field in manifest', async () => {
    await fs.promises.writeFile(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({ name: 'Test2', tokens: { canvas: '#fff' } }),
    );
    const without = await computeThemeContentHash(tmp);
    await fs.promises.writeFile(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({ name: 'Test2', tokens: { canvas: '#fff' }, contentHash: 'sha256:fake' }),
    );
    const withField = await computeThemeContentHash(tmp);
    expect(without).toBe(withField);
  });

  it('ignores preview.png if present', async () => {
    const h1 = await computeThemeContentHash(tmp);
    await fs.promises.writeFile(path.join(tmp, 'preview.png'), Buffer.from([7, 7, 7]));
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).toBe(h2);
  });
});
