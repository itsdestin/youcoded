import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { readSource } from './helpers/guard-scope';

// The perf lab (youcoded-dev/scripts/perf-lab) parses these names verbatim.
// Renaming or dropping one silently blanks a column in every future report.
// The ORDER of this array is the order main.ts executes them — the rig derives
// each chore's duration as mark[n] − mark[n−1], so a mark in the wrong place
// doesn't fail loudly, it just bills the time to the wrong chore. That's what
// the source-order test below guards.
const src = readSource(join(__dirname, '..', 'src', 'main', 'main.ts'));
const REQUIRED = [
  'main:imports-done', 'main:when-ready',
  'main:chore:rotate-log:done', 'main:chore:prelude:done',
  'main:chore:install-hooks:done', 'main:chore:hook-relay:done',
  'main:chore:legacy-cleanup:done', 'main:chore:hook-reconcile:done', 'main:chore:prompt-suggestion:done',
  'main:chore:retention-default:done', 'main:chore:symlink-cleanup:done', 'main:chore:stale-downloads:done',
  'main:chore:reconcile-mcp:done', 'main:chore:announcements:done', 'main:chore:remote-server:done',
  'main:chore:ipc-prefs:done', 'main:chore:theme-protocol:done', 'main:chore:accounts:done',
  'main:create-window:start', 'main:create-window:done', 'main:post-window:done',
];

describe('main-process perf marks are all present', () => {
  for (const name of REQUIRED) {
    it(name, () => { expect(src).toContain(`perfMark('${name}')`); });
  }

  // did-finish-load is NOT in REQUIRED: it lives in createWindow(), which is
  // defined ABOVE the whenReady block, so it would break the source-order check
  // while firing (at runtime) between create-window:done and post-window:done.
  it('main:main-window:did-finish-load is marked exactly once, from createWindow', () => {
    const all = src.match(/perfMark\('main:main-window:did-finish-load'\)/g) ?? [];
    expect(all).toHaveLength(1);
    const fnStart = src.indexOf('function createWindow(');
    const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
    const body = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(body).toContain(`perfMark('main:main-window:did-finish-load')`);
  });

  it('the marks appear in source order — the rig bills mark[n] \u2212 mark[n\u22121] to chore n', () => {
    const found = REQUIRED.map((name) => ({ name, at: src.indexOf(`perfMark('${name}')`) }));
    expect(found.filter((f) => f.at === -1)).toEqual([]);
    // Comparing name ARRAYS (not a boolean per pair) means a failure diff shows
    // exactly which mark moved and where it moved to.
    const bySourcePosition = [...found].sort((a, b) => a.at - b.at).map((f) => f.name);
    expect(bySourcePosition).toEqual(REQUIRED);
  });

  it('no mark name is used twice', () => {
    const names = [...src.matchAll(/perfMark\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names).toHaveLength(new Set(names).size);
  });

  it('main:imports-done is marked before app.whenReady()', () => {
    const a = src.indexOf(`perfMark('main:imports-done')`);
    const b = src.indexOf('app.whenReady()');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
  });

  it('main:post-window:done is the LAST perfMark in the file', () => {
    const names = [...src.matchAll(/perfMark\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names[names.length - 1]).toBe('main:post-window:done');
  });

  it('create-window:start precedes the createWindow call in whenReady', () => {
    const a = src.indexOf(`perfMark('main:create-window:start')`);
    const b = src.indexOf('createWindow(isFirstRun ? firstRunManager : undefined)');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
  });

  // The prelude/ipc-prefs marks exist to stop non-chore work being billed to a
  // neighbouring chore. Pin what each one sits behind so a future edit that
  // moves the work also has to move the mark.
  it('prelude:done sits after first-run detection and before the install-hooks block', () => {
    const firstRun = src.indexOf(`log('ERROR', 'Main', 'First-run detection failed, skipping'`);
    const mark = src.indexOf(`perfMark('main:chore:prelude:done')`);
    const installHooks = src.indexOf(`if (!process.env.YOUCODED_PROFILE) {`);
    expect(firstRun).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(firstRun);
    expect(installHooks).toBeGreaterThan(mark);
  });

  it('ipc-prefs:done sits immediately before registerThemeProtocol()', () => {
    const mark = src.indexOf(`perfMark('main:chore:ipc-prefs:done')`);
    const menu = src.indexOf('Menu.setApplicationMenu(null)');
    // Newline-anchored: the WHY comment above the mark names registerThemeProtocol()
    // too, and a bare indexOf would find that instead of the call.
    const theme = src.indexOf('\n  registerThemeProtocol();');
    expect(menu).toBeGreaterThan(0);
    expect(theme).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(menu);
    expect(theme).toBeGreaterThan(mark);
  });
});
