import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, it, expect } from 'vitest';

// Two shapes of wait that a busy machine outruns, found in the test files themselves.
//
// WHY (close-session friction, proposal 17): every load flake of the close-session rounds was
// one of these — a fixed sleep and then an assertion that something HAPPENED, or a loop that
// polls a fixed number of times and gives up. Under load the thing takes longer than the guess,
// and a correct change goes red (test-suite-hygiene.md: "never let a fixed sleep or a real poll
// stand in for a signal").
//
//  1. A real fixed sleep (`await new Promise(r => setTimeout(r, N))`, `await sleep(N)`, N > 0)
//     followed directly by an `expect(...)`. Wait on the thing instead: `await vi.waitFor(() =>
//     expect(...))`. A settle before a NEGATIVE assertion — proving that something did NOT happen
//     (no second call, no late event) — is the one honest use; say so with the word "settle"
//     (or "negative") in a comment on the sleep's line or the three lines above it.
//  2. A counted poll loop: `for (let i = 0; i < N && <condition>; i++)` with a sleep inside.
//     Use `vi.waitFor`, which has its own measured budget (tests/setup-waitfor.ts).
//
// Why a test and not an ast-grep rule: "followed by an assertion" and "a settle comment just
// above" are statements and comments in sequence, which a single-node pattern cannot see.
const DESKTOP = join(__dirname, '..');
const SLEEP = /await new Promise\(\(?\w+\)? => setTimeout\(\w+, [1-9][\d_]*\)\)|await (?:sleep|delay|wait)\([1-9][\d_]*\)/;
// An assertion that something is ABSENT or UNCHANGED reads as a negative on its face.
const NEGATIVE = /\.not\.|toBe\(0\)|toHaveLength\(0\)|toEqual\(\[\]\)|toBeNull\(\)|toBeUndefined\(\)|toBe\(false\)/;
const SETTLE = /settle|negative/i;
const POLL = /for \((?:let|var) \w+ = 0; \w+ < \d[\d_]*\s*&&[^;]*; \w+\+\+\)/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    // This file's own self-test holds the two shapes on purpose.
    if (name === 'node_modules' || name === 'fixtures' || name === 'test-waits.test.ts') return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** `file:line  <what>` for every wait of the two shapes in `text`. Exported shape for the self-test. */
function findWaits(file: string, text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (SLEEP.test(line)) {
      let j = i + 1;
      while (j < lines.length && /^\s*(\/\/.*)?$/.test(lines[j])) j++;
      const next = lines[j] ?? '';
      const explained = lines.slice(Math.max(0, i - 3), i + 1).some((l) => SETTLE.test(l));
      if (/^\s*expect\(/.test(next) && !NEGATIVE.test(next) && !explained) out.push(`${file}:${i + 1}  fixed sleep, then: ${next.trim().slice(0, 90)}`);
    }
    if (POLL.test(line) && lines.slice(i, i + 5).some((l) => SLEEP.test(l))) out.push(`${file}:${i + 1}  counted poll loop: ${line.trim().slice(0, 90)}`);
  });
  return out;
}

describe('tests wait on signals, not on guesses', () => {
  it('the scan finds both shapes, and lets a commented negative settle through', () => {
    const probe = [
      "  await new Promise((r) => setTimeout(r, 50));",
      "  expect(events).toHaveLength(1);",
      "  // settle: a second event would arrive within a tick",
      "  await new Promise((r) => setTimeout(r, 50));",
      "  expect(events).toHaveLength(1);",
      "  await sleep(20);",
      "  expect(spy).not.toHaveBeenCalled();",
      "  for (let i = 0; i < 40 && !ready; i++) {",
      "    await new Promise((r) => setTimeout(r, 25));",
      "  }",
    ].join('\n');
    expect(findWaits('probe.test.ts', probe)).toEqual([
      'probe.test.ts:1  fixed sleep, then: expect(events).toHaveLength(1);',
      'probe.test.ts:8  counted poll loop: for (let i = 0; i < 40 && !ready; i++) {',
    ]);
  });

  it('no test sleeps a fixed time before asserting something happened, or polls a fixed number of times', () => {
    const files = [...walk(join(DESKTOP, 'tests')), ...walk(join(DESKTOP, 'src'))];
    expect(files.length, 'non-vacuity: the suite was found').toBeGreaterThan(300);
    const found = files.flatMap((f) => findWaits(relative(DESKTOP, f).split('\\').join('/'), readFileSync(f, 'utf8')));
    expect(found, `Waits a busy machine outruns:\n  ${found.join('\n  ')}\n\n`
      + 'Replace them with `await vi.waitFor(() => expect(...))`. A fixed settle is right only before a NEGATIVE '
      + 'assertion (nothing more happened): say so with "settle" in a comment just above it.').toEqual([]);
  });
});
