import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { detectFilepaths } from './useInlineFilepathDetector';

// Pins detectFilepaths' output to what the quadratic `out.some(...)` overlap check produced
// (hash taken from the pre-fix code on these exact seeded inputs), so the linear rewrite is
// provably the same function. The inputs are built to hit every overlap case: spaced whole-line
// paths that swallow plain matches, known extensionless names, domains, punctuation endings.
function rng(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
const PIECES = [
  'see ', 'and ', '\n', '\n  ', ' ', '`', '(', ')', ',', '.', '!',
  '/home/u/My Docs/White House Posts.docx', '/home/u/proj/a.ts', 'src/a/b.tsx', '~/notes/todo.md',
  './Makefile', '/repo/Dockerfile', 'C:\\Users\\a b\\c d.xlsx', 'w3.org/intro.html', '../x/y.PNG',
  '/review the parser in src/a b.ts', 'either/or.It', 'a/b.min.js', '/tmp/LICENSE', 'docs.old/file.md',
];
export function sample(seed: number): string {
  const rand = rng(seed);
  let s = '';
  const n = 1 + Math.floor(rand() * 40);
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(rand() * PIECES.length)];
  return s;
}

describe('detectFilepaths pin', () => {
  it('returns exactly what the quadratic overlap check returned on 3,000 random texts', () => {
    const h = createHash('sha256');
    let withMatches = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const r = detectFilepaths(sample(seed));
      if (r.length) withMatches++;
      h.update(JSON.stringify(r) + '\n');
    }
    expect(withMatches).toBeGreaterThan(2500);
    expect(h.digest('hex')).toBe('aa994b3e166c6f180fd31d73c45d1aa0cc41f2595758003ddd52740d482ebd4c');
  });

  it('scales linearly: 40,000 paths (plus spaced lines) detect in well under the quadratic time', () => {
    // Old check compared every match with all earlier ones: ~800M comparisons here (many seconds).
    let text = '';
    for (let i = 0; i < 40000; i++) text += `see /home/u/proj/file${i}.ts and\n`;
    text += '/home/u/My Docs/a b.docx\n';
    const t0 = process.cpuUsage();
    const r = detectFilepaths(text);
    const used = process.cpuUsage(t0);
    expect(r.length).toBe(40001);
    expect((used.user + used.system) / 1000).toBeLessThan(3000);
  });
});
