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

// What one new IPC channel normally costs, file by file (measured on syncspaces:remove-project,
// 2026-10-05: handler, preload bridge, remote-server route, remote-shim bridge, shared type).
// WHY (project-switcher friction, proposal 11): that change failed this guard on five files at
// once, and the author had to work out by hand that the overrun was simply one channel's cost.
const IPC_CHANNEL_COST: Record<string, number> = {
  'main/ipc-handlers.ts': 3, 'main/preload.ts': 4, 'main/remote-server.ts': 5,
  'renderer/remote-shim.ts': 1, 'shared/types.ts': 2,
};
/** When every overrun is a small one in a file a channel touches, the usual raise for each. */
function ipcChannelHint(over: { file: string; excess: number }[]): string {
  if (!over.length || !over.every((o) => o.file in IPC_CHANNEL_COST && o.excess <= 3 * IPC_CHANNEL_COST[o.file])) return '';
  const usual = Object.entries(IPC_CHANNEL_COST).map(([f, n]) => `${f} +${n}`).join(', ');
  return `\n\nThis looks like a new IPC channel. One channel usually adds about: ${usual}. ` +
    'Raise those numbers by what this change actually needs and name the channel in the commit message.';
}

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
    const excess: { file: string; excess: number }[] = [];
    for (const [file, lines] of counts) {
      if (file in budgets.exempt) continue;
      const listed = budgets.budgets[file];
      const max = listed ?? budgets.default;
      if (lines > max) {
        excess.push({ file, excess: lines - max });
        over.push(
          listed === undefined
            ? `${file}: ${lines} lines, over the ${max}-line default for an unlisted file`
            : `${file}: ${lines} lines, budget ${max} (+${lines - max})`,
        );
      }
    }
    expect(over, `Over budget:\n  ${over.join('\n  ')}\n\n${HOW_TO}${ipcChannelHint(excess)}`).toEqual([]);
  });

  it('names the usual raise when the overrun is a new IPC channel', () => {
    // WHY (project-switcher friction, proposal 11): a new channel failed this guard on five
    // files at once (+1…+5 each) and the author had to work out, file by file, that this is
    // simply what one channel costs. The failure now says so.
    const hint = ipcChannelHint([
      { file: 'main/ipc-handlers.ts', excess: 3 }, { file: 'main/preload.ts', excess: 4 },
    ]);
    expect(hint).toMatch(/new IPC channel/);
    expect(hint).toMatch(/main\/remote-server\.ts \+5/);
    // Not a channel: an unrelated file over budget, or a big jump in a channel file.
    expect(ipcChannelHint([{ file: 'renderer/App.tsx', excess: 2 }])).toBe('');
    expect(ipcChannelHint([{ file: 'main/ipc-handlers.ts', excess: 80 }])).toBe('');
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
