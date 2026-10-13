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
// WHY the delay may be a NAME as well as a number (final review F55): `setTimeout(r, SETTLE_MS)`
// and `sleep(DELAY)` are the same guess, and the guard used to see only digits.
const DELAY = String.raw`(?:[1-9][\d_]*|[A-Za-z_$][\w$.]*)`;
const SLEEP = new RegExp(String.raw`await new Promise\(\(?\w+\)? => setTimeout\(\w+, ${DELAY}\)\)|await (?:sleep|delay|wait)\(${DELAY}\)`);
// An assertion that something is ABSENT reads as a negative on its face and needs no comment.
// WHY toBe(false) left this list (F55): "still false" and "became false" look the same, so it
// needs the settle comment like any other "nothing changed" assertion.
const NEGATIVE = /\.not\.|toBe\(0\)|toHaveLength\(0\)|toEqual\(\[\]\)|toBeNull\(\)|toBeUndefined\(\)/;
// "Nothing MORE happened" assertions: honest after a settle, and only with the settle comment.
// WHY (F55): "settle" anywhere above used to excuse ANY assertion, positive ones included.
// `toBe(before)` — a count compared with the one taken before the settle — is the same job.
const UNCHANGED = new RegExp([
  String.raw`toHaveBeenCalledTimes\(\d+\)`, String.raw`toHaveLength\((?:\d+|[A-Za-z_$][\w$.]*)\)`,
  String.raw`toBe\(false\)`, String.raw`toBe\(\d+\)`, String.raw`toBe\((?!true\))[A-Za-z_$][\w$.]*\)`,
  String.raw`toBe\((['"]).*\1\)`, String.raw`toEqual\((?:[A-Za-z_$][\w$.]*|\[|\{)`,
  // An upper bound ("at most two opens") and "the element is still there" say nothing MORE happened.
  String.raw`toBeLessThan(?:OrEqual)?\(`, String.raw`toBeInTheDocument\(\)`,
].join('|'));
// The word must be in a COMMENT (F55: a constant named SETTLE_MS excused its own sleep).
const SETTLE = /\/\/.*\b(?:settle|negative)/i;
// An assertion line, awaited or not (F55: `await expect(...).resolves` was missed).
const ASSERTION = /^\s*(?:await\s+)?expect(?:\.\w+)?\(/;
// A line that waits on a real signal: whatever follows it is no longer the sleep's guess.
const SIGNAL = /waitFor|findBy|findAllBy|\.resolves|\.rejects/;
// How many code lines after the sleep the scan looks through for the assertion (F55: a
// statement between the sleep and the assertion used to hide it).
const LOOKAHEAD = 3;
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
    // `while (!started) await sleep(2)` waits on a real condition — it is a signal, not a guess.
    if (SLEEP.test(line) && !/^\s*while\s*\(/.test(line)) {
      // The settle comment sits on the sleep's line or in the comment lines right above it —
      // not anywhere in the three lines before (F55: a comment about an earlier wait excused this one).
      let explained = SETTLE.test(line);
      for (let k = i - 1; !explained && k >= 0 && /^\s*\/\//.test(lines[k]); k--) explained = SETTLE.test(lines[k]);
      for (let j = i + 1, seen = 0; j < lines.length && seen < LOOKAHEAD; j++) {
        const next = lines[j];
        if (/^\s*(\/\/.*)?$/.test(next)) continue;
        seen++;
        if (ASSERTION.test(next)) {
          const ok = NEGATIVE.test(next) || (explained && UNCHANGED.test(next));
          if (!ok) out.push(`${file}:${i + 1}  fixed sleep, then: ${next.trim().slice(0, 90)}`);
          break;
        }
        // Another wait, a real signal, an awaited action (the assertion then checks what THAT
        // did — the sleep was only spacing before it, e.g. a distinct mtime), or the end of the
        // block: the sleep guards nothing further.
        if (SLEEP.test(next) || SIGNAL.test(next) || /\bawait\b/.test(next) || /^\s*}/.test(next)) break;
      }
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
      // F55's shapes: a named delay, an awaited expect, a statement in between, a settle
      // comment excusing a POSITIVE assertion, and toBe(false) with no comment.
      "  await new Promise((r) => setTimeout(r, SETTLE_MS));",
      "  expect(rows).toHaveLength(2);",
      "  await sleep(DELAY);",
      "  await expect(load()).toEqual(1);",
      "  await sleep(30);",
      "  rerender();",
      "  expect(screen.getByText('Saved')).toBeTruthy();",
      "  // settle for the save",
      "  await sleep(30);",
      "  expect(saved).toBe(true);",
      "  await sleep(30);",
      "  expect(open).toBe(false);",
      "  await sleep(30);",
      "  await vi.waitFor(() => expect(x).toBe(1));",
    ].join('\n');
    expect(findWaits('probe.test.ts', probe)).toEqual([
      'probe.test.ts:1  fixed sleep, then: expect(events).toHaveLength(1);',
      'probe.test.ts:8  counted poll loop: for (let i = 0; i < 40 && !ready; i++) {',
      'probe.test.ts:11  fixed sleep, then: expect(rows).toHaveLength(2);',
      'probe.test.ts:13  fixed sleep, then: await expect(load()).toEqual(1);',
      'probe.test.ts:15  fixed sleep, then: expect(screen.getByText(\'Saved\')).toBeTruthy();',
      'probe.test.ts:19  fixed sleep, then: expect(saved).toBe(true);',
      'probe.test.ts:21  fixed sleep, then: expect(open).toBe(false);',
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
