// Remote access batch 2, design §3/§4/§6 (T4): App's use of the place rules.
// App cannot be mounted in a unit test, so each wiring point is pinned to the
// one line that carries it; the rules themselves are behaviour-tested in
// remote-place.test.ts, and the reducer's apply in hydrate-per-session.test.ts.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

const app = readStripped(join(__dirname, '..', 'src', 'renderer', 'App.tsx'));

function occurrences(re: RegExp): number {
  return (app.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length;
}

describe('App defers every automatic selection to the hydrate in remote mode', () => {
  it('the session list on mount selects only when allowed', () => {
    const gated = /setSessionId\(\(prev\) => prev \?\? \(mayAutoSelect\(\) \? list\[0\]\.id : null\)\)/;
    assertPatternMatches(gated, 'setSessionId((prev) => prev ?? (mayAutoSelect() ? list[0].id : null))', 'the gated mount select');
    expect(app).toMatch(gated);
  });

  it('a newly created session is focused only when allowed', () => {
    const gated = /if \(mayAutoSelect\(\)\) setSessionId\(info\.id\);/;
    assertPatternMatches(gated, 'if (mayAutoSelect()) setSessionId(info.id);', 'the gated created select');
    expect(app).toMatch(gated);
  });

  it('switching to a remote host selects only when allowed', () => {
    const gated = /if \(mayAutoSelect\(\)\) setSessionId\(list\[0\]\.id\);/;
    assertPatternMatches(gated, 'if (mayAutoSelect()) setSessionId(list[0].id);', 'the gated mode-change select');
    expect(app).toMatch(gated);
  });

  it('no ungated "first session" select is left behind', () => {
    // The two sites above are the only `list[0]` selections; a new raw one fails here.
    expect(occurrences(/setSessionId\([^;\n]*list\[0\]/)).toBe(2);
  });
});

describe('App applies the hydrate as the design says', () => {
  it('the hydrate handler chooses the place, marks it decided and reports what was kept', () => {
    const choose = /choosePlaceOnHydrate\(\{/;
    assertPatternMatches(choose, 'choosePlaceOnHydrate({', 'the place choice');
    expect(app).toMatch(choose);
    const decided = /placeDecidedRef\.current = true;/;
    expect(occurrences(decided)).toBeGreaterThanOrEqual(1);
    const report = /remote\?\.reportHydrate\?\.\(\{ seq: payload\?\.seq, kept \}\)/;
    assertPatternMatches(report, '(window.claude as any).remote?.reportHydrate?.({ seq: payload?.seq, kept })', 'the report');
    expect(app).toMatch(report);
  });

  it('the destroyed handler uses the desktop\'s focus in remote mode', () => {
    const rule = /chooseAfterDestroyed\(\{ destroyedId: id,/;
    assertPatternMatches(rule, 'chooseAfterDestroyed({ destroyedId: id, currentId: curr,', 'the destroyed rule');
    expect(app).toMatch(rule);
  });

  it('the first page asks only when the rule allows it', () => {
    const rule = /if \(!shouldLoadFirstPage\(\{/;
    assertPatternMatches(rule, 'if (!shouldLoadFirstPage({ remote: isRemoteMode(),', 'the first-page rule');
    expect(app).toMatch(rule);
  });

  it('the place is remembered on every selection change once decided', () => {
    const write = /writeRemotePlace\(/;
    assertPatternMatches(write, 'writeRemotePlace(remotePlaceStorages(), remotePlaceHost(), sessionId)', 'the write');
    expect(app).toMatch(write);
  });
});
