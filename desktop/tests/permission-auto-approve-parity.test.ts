// Desktop and Android must refuse to auto-allow the SAME tools.
//
// WHY (2026-09-24): Android's copy of the auto-approve decision excluded only
// AskUserQuestion, so with "approve all" on it auto-allowed ExitPlanMode. Claude
// Code ignores a hook allow for plans, so the plan card vanished while the plan
// menu still waited in the terminal — a gap desktop had already closed. The two
// lists live in two languages and cannot import each other; this test reads both.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { readSource } from './helpers/guard-scope';

const DESKTOP = path.join(__dirname, '..', 'src', 'main', 'permission-auto-approve.ts');
const ANDROID = path.join(
  __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
  'com', 'youcoded', 'app', 'runtime', 'PermissionAutoApprove.kt',
);

/** The quoted names inside the one `NEEDS_THE_USERS_OWN_ANSWER` declaration. */
function neverAllowList(source: string, decl: RegExp): string[] {
  const m = source.match(decl);
  expect(m, 'NEEDS_THE_USERS_OWN_ANSWER declaration not found').not.toBeNull();
  return [...m![1].matchAll(/['"]([A-Za-z]+)['"]/g)].map((x) => x[1]).sort();
}

describe('never-auto-allow parity (desktop ↔ Android)', () => {
  const desktop = neverAllowList(readSource(DESKTOP), /NEEDS_THE_USERS_OWN_ANSWER\s*=\s*new Set\(\[([^\]]*)\]\)/);
  const android = neverAllowList(readSource(ANDROID), /NEEDS_THE_USERS_OWN_ANSWER[^=]*=\s*setOf\(([^)]*)\)/);

  it('both lists name the plan approval and the question', () => {
    expect(desktop).toEqual(['AskUserQuestion', 'ExitPlanMode']);
  });

  it('Android names exactly the tools desktop does', () => {
    expect(android).toEqual(desktop);
  });

  it('both decisions check the list before anything else can allow', () => {
    // A check placed after approve-all or the title hook would let those win.
    const d = readSource(DESKTOP);
    const a = readSource(ANDROID);
    const firstLine = (src: string, fn: RegExp) => {
      // The function body starts at the first `{` after the signature (neither
      // signature's parameter types contain a brace).
      const sig = src.slice(src.search(fn));
      const body = sig.slice(sig.indexOf('{') + 1);
      return body.split('\n').find((l) => l.trim() && !l.trim().startsWith('//'))!.trim();
    };
    expect(firstLine(d, /export function shouldAutoApprove\(/)).toMatch(/NEEDS_THE_USERS_OWN_ANSWER\.has\(toolName\)\) return false/);
    expect(firstLine(a, /fun shouldAutoApprove\(/)).toMatch(/toolName in NEEDS_THE_USERS_OWN_ANSWER\) return false/);
  });
});
