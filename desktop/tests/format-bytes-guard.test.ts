import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { stripComments } from './helpers/guard-scope';

// Card #143 (Destin 2026-11-12): sizes are 1000-based and come from shared/format-bytes.ts.
// This fails when a new line turns bytes into KB/MB/GB words with its own 1024 arithmetic.
const SRC = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'dev' && n !== 'node_modules') walk(p, out); }
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) out.push(p);
  }
  return out;
}

// A line that does 1024-style division AND says KB/MB/GB/toFixed is a size being formatted by hand.
const BINARY_MATH = /(\/ ?\(?1024|1048576|1073741824|\/ ?\(?1_?048_?576|1024 ?\*\* ?\d)/;
const SIZE_WORDS = /\b(KB|MB|GB)\b|toFixed/;

// LIMIT SENTENCES, left on purpose: they state a byte limit written as a round number of MiB ("50 MB") and show
// the limit, not a measured file. Listed by file so a NEW hand-rolled size in the same file still has to be listed here.
const LIMIT_SENTENCE_FILES = new Set([
  'main/sync-spaces/git-transport.ts',     // "a file over the 50 MB limit"
  'main/harness/image-support.ts',         // per-image limit
  'main/harness/image-prepare.ts',         // per-image limit
  'main/harness/harness-session.ts',       // per-image / per-turn limits
  'main/image-resize-worker.ts',           // developer smoke-test line, never shown
  'main/hitch-recorder.ts',                // diagnostics numbers, not text
]);

describe('every shown file size comes from shared/format-bytes', () => {
  it('no hand-rolled 1024 size formatting outside the shared helper and the listed limit sentences', () => {
    const bad: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f).replace(/\\/g, '/');
      if (rel === 'shared/format-bytes.ts' || LIMIT_SENTENCE_FILES.has(rel)) continue;
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        if (/^\s*const \w+ = 1024 \*\* \d;/.test(line)) return; // memory-fit constants (GiB): arithmetic, never shown
        if (BINARY_MATH.test(line) && SIZE_WORDS.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
      });
    }
    expect(bad, `use formatBytes / formatGb from shared/format-bytes.ts:\n${bad.join('\n')}`).toEqual([]);
  });
});
