// statusline-context-remaining.test.ts — the number statusline.sh writes to
// ~/.claude/.context-<sessionId> is context REMAINING, never context used.
//
// WHY this file exists: that one number feeds two user-facing surfaces — the
// status bar's "Context: n% remaining" pill and the /usage card's "Context
// remaining" row — and three of the four places that assert its direction are
// already pinned by tests (ipc-handlers' reader, StatusBar's native
// equivalent, the chips' aria-labels). statusline.sh, the place that actually
// PRODUCES the number, was pinned by nothing: no test loaded it, so changing
// `remaining_percentage` to a used-percentage — by renaming the field it reads
// or by inverting it to `100 - x` — would flip the bar and the card to the
// exact opposite meaning while the whole suite stayed green. That is the same
// defect this branch has already shipped twice (the card said "used" over a
// remaining figure, and coloured it on the utilisation scale).
//
// The script is a shell script, so the guard runs it rather than reading it:
// a regex over the source would pass just as happily on `100 - remaining`.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const STATUSLINE = path.resolve(__dirname, '..', 'hook-scripts', 'statusline.sh');
const scriptSource = fs.readFileSync(STATUSLINE, 'utf8');

// A Claude Code status-line payload, cut down to the fields this script reads.
// 73.4 is deliberately not a round number and not 50: an inversion to
// `100 - remaining` produces 27 (≠ 73), and a rename to a used-style field
// produces the script's own 100 fallback — so every mutation lands on a
// different, recognisable number.
function payload(contextWindow: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 'guard-session',
    session_name: 'Guard Fixture',
    model: { display_name: 'Test Model' },
    context_window: contextWindow,
  });
}

// Node must be on PATH: the script shells out to `node` by name, and a PATH
// without it would silently take the "node failed" branch (REMAINING=100) and
// make these tests pass for the wrong reason.
function envWithHome(home: string): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${path.dirname(process.execPath)}${sep}${process.env.PATH ?? ''}`,
  };
}

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-statusline-'));
  fs.mkdirSync(path.join(home, '.claude', 'toolkit-state'), { recursive: true });
  return home;
}

// ---------------------------------------------------------------------------
// Part 1 — the parser itself, run with plain node (no shell required, so this
// half guards on every platform including a Windows box with no bash).
// ---------------------------------------------------------------------------

// The script computes the context figure inside an inline `node -e "…"`
// program. Lifting that program out and running it IS running the shipped
// code — the text between the quotes is passed to node verbatim (it contains
// no `$`, backtick or escaped quote for the shell to rewrite).
function extractParser(): string {
  const marker = 'node -e "';
  const start = scriptSource.indexOf(marker);
  // Loud, not silent: if the script is reformatted so this no longer finds the
  // parser, the guard must fail rather than quietly stop guarding anything.
  expect(start, 'statusline.sh no longer contains an inline `node -e "` parser').toBeGreaterThan(-1);
  const rest = scriptSource.slice(start + marker.length);
  const end = rest.indexOf('\n})"');
  expect(end, 'could not find the end of the inline parser in statusline.sh').toBeGreaterThan(-1);
  return rest.slice(0, end + 3);
}

// Field order of the \x1f-separated line the parser prints, which the script
// reads back as: SESSION_NAME, MODEL, REMAINING, SESSION_ID.
const REMAINING_FIELD = 2;

function runParser(json: string): string[] {
  const home = freshHome();
  const r = spawnSync(process.execPath, ['-e', extractParser()], {
    input: json,
    env: envWithHome(home),
    encoding: 'utf8',
  });
  expect(r.status, `parser exited ${r.status}: ${r.stderr}`).toBe(0);
  return r.stdout.replace(/\r?\n$/, '').split('\x1f');
}

describe('statusline.sh parser — the context figure is what is LEFT', () => {
  it('passes remaining_percentage straight through, rounded', () => {
    const fields = runParser(payload({ remaining_percentage: 73.4 }));
    expect(fields[REMAINING_FIELD]).toBe('73');
    // Spelled out because this is the whole point: 27 is what an inversion to
    // `100 - remaining` would print, and it would look perfectly plausible.
    expect(fields[REMAINING_FIELD]).not.toBe('27');
  });

  it('does not read a used-style percentage', () => {
    // Only a used figure on the wire, no remaining figure at all. The script's
    // honest answer is its "assume a full window" fallback of 100 — NOT 27,
    // which is what reading (or being renamed to) a used field would give.
    const fields = runParser(payload({ used_percentage: 27 }));
    expect(fields[REMAINING_FIELD]).toBe('100');
  });

  it('reports a nearly-exhausted window as a small number, not a large one', () => {
    // The direction check with the colours' meaning attached: 8% left is the
    // RED end of the status bar's scale (red under 20 remaining). If the
    // number were inverted this would print 92 and paint green.
    const fields = runParser(payload({ remaining_percentage: 8 }));
    expect(Number(fields[REMAINING_FIELD])).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the whole script, end to end, writing the real file the app reads.
// Needs a shell, so it is skipped where bash is unavailable (a plain Windows
// box); Part 1 above still covers the number itself there.
// ---------------------------------------------------------------------------

const hasBash = (() => {
  try {
    return spawnSync('bash', ['-c', 'exit 0']).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBash)('statusline.sh end to end — the .context-<id> file', () => {
  function runScript(json: string) {
    const home = freshHome();
    // (No network dodge needed any more: the script used to shell out to
    // usage-fetch.js, which called the Claude usage API; that is gone —
    // see statusline-rate-limits.test.ts, which pins its absence.)
    // Run from a directory that is not a git checkout, so the script's branch
    // probe finds nothing and the run does not depend on where the tests live.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-nogit-'));
    const r = spawnSync('bash', [STATUSLINE], {
      input: json,
      cwd,
      env: envWithHome(home),
      encoding: 'utf8',
    });
    expect(r.status, `statusline.sh exited ${r.status}: ${r.stderr}`).toBe(0);
    return { stdout: r.stdout, home };
  }

  it('writes the remaining percentage, which is what the app reads back', () => {
    const { home } = runScript(payload({ remaining_percentage: 73.4 }));
    const written = fs.readFileSync(path.join(home, '.claude', '.context-guard-session'), 'utf8');
    expect(written).toBe('73');
  });

  it('prints a line that says what the number means', () => {
    // The user-visible half of the same fact. If the figure is ever changed to
    // "used", this sentence becomes a lie and this test says so.
    const { stdout } = runScript(payload({ remaining_percentage: 73.4 }));
    expect(stdout).toContain('Context Remaining: 73%');
    expect(stdout).not.toMatch(/Context Used/i);
  });

  it('writes a small number when little context is left', () => {
    const { home } = runScript(payload({ remaining_percentage: 8 }));
    expect(fs.readFileSync(path.join(home, '.claude', '.context-guard-session'), 'utf8')).toBe('8');
  });
});
