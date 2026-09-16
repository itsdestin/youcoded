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
    // Both list selections — on mount and on a host switch — never override a place already
    // on screen (T4 review, 7).
    const gated = /setSessionId\(\(prev\) => prev \?\? \(mayAutoSelect\(\) \? list\[0\]\.id : null\)\)/;
    assertPatternMatches(gated, 'setSessionId((prev) => prev ?? (mayAutoSelect() ? list[0].id : null))', 'the gated list select');
    expect(occurrences(gated)).toBe(2);
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


// Review of T4 (2026-09-10): the guards above let most of the wiring be deleted while green.
describe('App wiring, anchored to each line that carries it', () => {
  it('every setSessionId call site is accounted for — a new one must be looked at', () => {
    // 13 on 2026-09-10: buddy focus, created (gated), destroyed (focus rule), hydrate
    // choice, a restore with no hydrate, mount list (gated), refocus-only, fresh window,
    // ownership lost, host switch reset + list (gated), local removal, header click.
    // 14 on 2026-09-11: adoptCreatedSession — a session the person just asked for, opened from
    // the computer's answer rather than waiting for the announcement (and NOT gated, because
    // starting one is itself a decision about where to be).
    expect(occurrences(/setSessionId\(/)).toBe(14);
  });

  it('the hydrate decides the place, wakes waiting first pages, and selects the choice — remote only', () => {
    const block = /if \(isRemoteMode\(\)\) \{\s*const choice = choosePlaceOnHydrate\(\{[\s\S]*?\}\);\s*placeDecidedRef\.current = true;\s*setHydrateTick\(\(t\) => t \+ 1\);\s*if \(choice\) setSessionId\(choice\);\s*\}/;
    assertPatternMatches(block, 'if (isRemoteMode()) {\n const choice = choosePlaceOnHydrate({ a });\n placeDecidedRef.current = true;\n setHydrateTick((t) => t + 1);\n if (choice) setSessionId(choice);\n }', 'the hydrate block');
    expect(app).toMatch(block);
  });

  it('the place on screen wins over storage, in the hydrate and when a restore ends without one', () => {
    expect(occurrences(/stored: focusedSessionIdRef\.current \?\? readRemotePlace\(/)).toBe(2);
  });

  it('a restore starting resets the decision; one ending without a hydrate decides with what exists', () => {
    expect(app).toMatch(/if \(s\?\.phase === 'restoring'\) placeDecidedRef\.current = false;/);
    const ended = /if \(\(s\?\.phase === 'incomplete' \|\| s\?\.phase === 'complete'\) && isRemoteMode\(\) && !placeDecidedRef\.current\) \{\s*placeDecidedRef\.current = true;\s*setHydrateTick/;
    assertPatternMatches(ended, "if ((s?.phase === 'incomplete' || s?.phase === 'complete') && isRemoteMode() && !placeDecidedRef.current) {\n placeDecidedRef.current = true;\n setHydrateTick", 'the no-hydrate decision');
    expect(app).toMatch(ended);
  });

  it('the place is written only once decided, and first pages re-run when a hydrate lands', () => {
    expect(app).toMatch(/if \(!sessionId \|\| !isRemoteMode\(\) \|\| !placeDecidedRef\.current\) return;\s*writeRemotePlace\(/);
    expect(app).toMatch(/for \(const s of sessions\) void loadFirstPage\(s\.id\);\s*\}, \[sessions, loadFirstPage, hydrateTick\]\);/);
  });

  it('back on the device\'s own runtime the strip is cleared, and the welcome screen waits while catching up', () => {
    expect(app).toMatch(/if \(mode === 'local'\) setConversationStatus\(undefined\);/);
    expect(app).toMatch(/\{remoteCatchingUp \? \(\s*<StatusStrip tone="busy"/);
    // A start the person asked for hides them too, so a second tap cannot start a second
    // session while the first is still being answered (2026-09-11 evening).
    expect(app).toMatch(/w-64\$\{remoteCatchingUp \|\| startingSession \? ' hidden' : ''\}/);
  });
});
