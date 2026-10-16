// The auto-approve decision must refuse to auto-allow the plan approval and the question.
//
// WHY (2026-09-24): Android's copy of the auto-approve decision excluded only
// AskUserQuestion, so with "approve all" on it auto-allowed ExitPlanMode. Claude
// Code ignores a hook allow for plans, so the plan card vanished while the plan
// menu still waited in the terminal — a gap desktop had already closed. The phone now runs this same
// code (Android clean rebuild (2026-10-14): the phone runs the desktop backend), so only the desktop list remains.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { readSource } from './helpers/guard-scope';

const DESKTOP = path.join(__dirname, '..', 'src', 'main', 'permission-auto-approve.ts');

/** The quoted names inside the one `NEEDS_THE_USERS_OWN_ANSWER` declaration. */
function neverAllowList(source: string, decl: RegExp): string[] {
  const m = source.match(decl);
  expect(m, 'NEEDS_THE_USERS_OWN_ANSWER declaration not found').not.toBeNull();
  return [...m![1].matchAll(/['"]([A-Za-z]+)['"]/g)].map((x) => x[1]).sort();
}

describe('never-auto-allow list', () => {
  const desktop = neverAllowList(readSource(DESKTOP), /NEEDS_THE_USERS_OWN_ANSWER\s*=\s*new Set\(\[([^\]]*)\]\)/);

  it('the list names the plan approval and the question', () => {
    expect(desktop).toEqual(['AskUserQuestion', 'ExitPlanMode']);
  });

  it('the decision checks the list before anything else can allow', () => {
    // A check placed after approve-all or the title hook would let those win.
    const d = readSource(DESKTOP);
    const firstLine = (src: string, fn: RegExp) => {
      // The function body starts at the first `{` after the signature (the
      // signature's parameter types contain no brace).
      const sig = src.slice(src.search(fn));
      const body = sig.slice(sig.indexOf('{') + 1);
      return body.split('\n').find((l) => l.trim() && !l.trim().startsWith('//'))!.trim();
    };
    expect(firstLine(d, /export function shouldAutoApprove\(/)).toMatch(/NEEDS_THE_USERS_OWN_ANSWER\.has\(toolName\)\) return false/);
  });
});
