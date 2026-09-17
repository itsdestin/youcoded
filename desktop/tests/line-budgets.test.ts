import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, it, expect } from 'vitest';

// Line-budget RATCHET for desktop/src (2026-09-16, simplification audit §7 G2).
//
// Twenty source files were over 1,500 lines (18 budgeted below, two dev-only
// workbench registries exempt) and nothing said so: docs and
// rule files have word budgets (scripts/audit-anchors.mjs), source had none, so
// App.tsx and ipc-handlers.ts grew by hundreds of lines a month with every
// check green. This guard freezes each oversized file at the size it had the
// day it was recorded (line-budgets.json) and holds every OTHER file to the
// default. Nothing had to be split first; the first refactor that shrinks a
// file is asked to lower its number, so the ceiling only ever moves down.
//
// Lines are counted the way `wc -l` counts them (newline characters), so the
// number a developer sees in the failure is the number they get in a shell.
const SRC = join(__dirname, '..', 'src');
const BUDGET_FILE = join(__dirname, '..', 'line-budgets.json');
const COUNTED = ['.ts', '.tsx', '.js', '.mjs', '.css'];

interface Budgets {
  default: number;
  exempt: Record<string, string>;
  budgets: Record<string, number>;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return COUNTED.some((ext) => full.endsWith(ext)) ? [full] : [];
  });
}

/** `wc -l` semantics: the number of newline characters. */
function countLines(path: string): number {
  const text = readFileSync(path, 'utf8');
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const rel = (abs: string) => relative(SRC, abs).split('\\').join('/');

const HOW_TO =
  'A LISTED file may not grow past its number in desktop/line-budgets.json; an UNLISTED file may not exceed `default`. ' +
  'To fix: split the file, or — if the growth is the reviewed shape of this change — raise its number (or add a line for a new file) and say why in the commit. ' +
  'When a refactor shrinks a listed file, lower its number in the same commit; delete the line once it is under `default`.';

describe('source files stay inside their line budgets', () => {
  const budgets = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budgets;
  const files = walk(SRC);
  const counts = new Map(files.map((f) => [rel(f), countLines(f)]));

  it('scans the real tree (non-vacuity)', () => {
    // A guard scanning nothing passes and reads as clean. 700+ files today.
    expect(files.length).toBeGreaterThanOrEqual(500);
    expect(counts.has('renderer/App.tsx')).toBe(true);
    expect(budgets.default).toBeGreaterThan(0);
  });

  it('lists only files that still exist — a deleted or moved file takes its line with it', () => {
    const stale = [...Object.keys(budgets.budgets), ...Object.keys(budgets.exempt)].filter((p) => !counts.has(p));
    expect(stale, `Entries in line-budgets.json for files that no longer exist under src/ — remove them:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('gives every exemption a reason', () => {
    for (const [file, reason] of Object.entries(budgets.exempt)) {
      expect(reason.length, `${file} is exempt with no reason`).toBeGreaterThan(10);
    }
  });

  it('holds every file to its budget', () => {
    const over: string[] = [];
    for (const [file, lines] of counts) {
      if (file in budgets.exempt) continue;
      const listed = budgets.budgets[file];
      const max = listed ?? budgets.default;
      if (lines > max) {
        over.push(
          listed === undefined
            ? `${file}: ${lines} lines, over the ${max}-line default for an unlisted file`
            : `${file}: ${lines} lines, budget ${max} (+${lines - max})`,
        );
      }
    }
    expect(over, `Over budget:\n  ${over.join('\n  ')}\n\n${HOW_TO}`).toEqual([]);
  });

  it('reports listed files that have shrunk, so the ceiling can come down', () => {
    // Passing on purpose: shrinking a file is the good direction and must never
    // fail a run. But the ratchet only clicks if someone lowers the number, so
    // say which ones can be lowered on every run.
    const lowerable = Object.entries(budgets.budgets)
      .filter(([file, max]) => (counts.get(file) ?? max) < max)
      .map(([file, max]) => `${file}: budget ${max}, now ${counts.get(file)}`);
    if (lowerable.length) {
      console.info(`line-budgets.json ceilings that can be lowered:\n  ${lowerable.join('\n  ')}`);
    }
    expect(true).toBe(true);
  });
});
