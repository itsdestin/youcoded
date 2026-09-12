// Pins the content-search module: the rg --json parser contract and a REAL
// end-to-end search over a temp directory using the bundled ripgrep binary —
// the same binary ships in the app, so if this passes, the packaged feature
// has no parsing surprises left (spawn-path pitfalls are grep.ts's
// resolveRgPath, reused verbatim).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseRgJsonLine, searchProjectContent, MAX_HITS } from '../../src/main/artifacts/content-search';

describe('parseRgJsonLine', () => {
  it('parses a match event into path/line/snippet', () => {
    const line = JSON.stringify({
      type: 'match',
      data: { path: { text: 'src\\app.ts' }, line_number: 42, lines: { text: '  const port = 5223;\n' } },
    });
    expect(parseRgJsonLine(line)).toEqual({ path: 'src/app.ts', line: 42, text: 'const port = 5223;' });
  });
  it('ignores begin/end/summary events, blanks, and garbage', () => {
    expect(parseRgJsonLine(JSON.stringify({ type: 'begin', data: {} }))).toBeNull();
    expect(parseRgJsonLine(JSON.stringify({ type: 'summary', data: {} }))).toBeNull();
    expect(parseRgJsonLine('')).toBeNull();
    expect(parseRgJsonLine('not json at all')).toBeNull();
  });
  it('caps runaway snippets', () => {
    const line = JSON.stringify({
      type: 'match',
      data: { path: { text: 'a.txt' }, line_number: 1, lines: { text: 'x'.repeat(5000) } },
    });
    expect(parseRgJsonLine(line)!.text.length).toBeLessThanOrEqual(200);
  });
});

describe('searchProjectContent (real ripgrep)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-search-'));
    await fs.promises.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'src/app.ts'), 'const port = 5223;\nconst other = 1;\n');
    await fs.promises.writeFile(path.join(root, 'notes.md'), 'remember: PORT 5223 is the dev vite port\n');
    await fs.promises.mkdir(path.join(root, 'node_modules/dep'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'node_modules/dep/x.js'), 'port 5223 in a dependency\n');
    await fs.promises.mkdir(path.join(root, '.youcoded'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.youcoded/artifacts.json'), '{"note":"port 5223"}\n');
  });
  afterEach(async () => {
    // Fix: retry on Windows EBUSY race with spawned ripgrep
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // The same private paths every other read hides. `--hidden` walks
  // dot-directories, so without the sensitive globs a search for "BEGIN"
  // printed the matching lines of .ssh/id_rsa and .env — and over remote
  // access a phone can search (2026-09-10 review of batch 3 T6, finding 1).
  it('never returns a hit from a sensitive path, even inside the root', async () => {
    await fs.promises.mkdir(path.join(root, '.ssh'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ssh/id_rsa'), 'SECRET-MARKER-9\n');
    await fs.promises.writeFile(path.join(root, '.env'), 'TOKEN=SECRET-MARKER-9\n');
    await fs.promises.writeFile(path.join(root, '.env.local'), 'TOKEN=SECRET-MARKER-9\n');
    await fs.promises.writeFile(path.join(root, '.netrc'), 'password SECRET-MARKER-9\n');
    await fs.promises.mkdir(path.join(root, 'sub/.config/gh'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'sub/.config/gh/hosts.yml'), 'oauth_token: SECRET-MARKER-9\n');
    await fs.promises.writeFile(path.join(root, 'src/ok.ts'), '// SECRET-MARKER-9 in an ordinary file\n');
    const res = await searchProjectContent(root, 'SECRET-MARKER-9');
    expect(res.ok).toBe(true);
    expect(res.hits.map((h) => h.path)).toEqual(['src/ok.ts']);
  });

  it('finds matches with 1-indexed lines, case-insensitively, skipping node_modules and .youcoded', async () => {
    const res = await searchProjectContent(root, 'port 5223');
    expect(res.ok).toBe(true);
    const byPath = Object.fromEntries(res.hits.map((h) => [h.path, h]));
    expect(byPath['src/app.ts']).toBeUndefined(); // "port = 5223" is not a literal match
    expect(byPath['notes.md']).toMatchObject({ line: 1 }); // case-insensitive "PORT 5223"
    expect(res.hits.some((h) => h.path.includes('node_modules'))).toBe(false);
    expect(res.hits.some((h) => h.path.includes('.youcoded'))).toBe(false);
  });

  it('treats the query as LITERAL text, not a regex', async () => {
    await fs.promises.writeFile(path.join(root, 'regex.txt'), 'a literal a.c string\nabc should not match\n');
    const res = await searchProjectContent(root, 'a.c');
    expect(res.hits.map((h) => `${h.path}:${h.line}`)).toEqual(['regex.txt:1']);
  });

  it('empty query returns cleanly; no matches is ok:true with zero hits', async () => {
    expect(await searchProjectContent(root, '   ')).toEqual({ ok: true, hits: [], truncated: false });
    const res = await searchProjectContent(root, 'zzz-not-in-any-file-zzz');
    expect(res).toMatchObject({ ok: true, hits: [], truncated: false });
  });

  it('caps total hits and reports truncation', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `needle line ${i}`).join('\n');
    for (let f = 0; f < 20; f++) {
      await fs.promises.writeFile(path.join(root, `many-${f}.txt`), lines);
    }
    const res = await searchProjectContent(root, 'needle');
    expect(res.ok).toBe(true);
    expect(res.hits.length).toBeLessThanOrEqual(MAX_HITS);
    expect(res.truncated).toBe(true);
  }, 15000);
});
