import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
// Two probes that differ ONLY in import style. Kept as fixtures rather than
// inline, because the behaviour being pinned IS the module-level import.
import { homedirViaNamespaceImport } from './fixtures/homedir-namespace-import';
import { homedirViaDefaultImport } from './fixtures/homedir-default-import';

/**
 * Which import style can a test's own `vi.spyOn(os, 'homedir')` reach?
 *
 * Why this exists. `vitest.config.ts` points HOME at a per-run sandbox so no
 * test can touch the developer's real ~/.claude (see home-isolation.test.ts).
 * A test that needs its OWN fixture directory goes one step further and spies
 * on `os.homedir()` — the established pattern in ipc-handlers.test.ts.
 *
 * That spy reaches a module that imported os with a DEFAULT import and does
 * NOT reach one that used a namespace import, with either specifier. The
 * module keeps resolving to the suite-wide sandbox, so the test still cannot
 * touch production — it simply measures a directory it never wrote its fixture
 * into, and passes or fails for a reason unrelated to what it meant to check.
 * That cost a debugging cycle on 2026-09-07 (transcript-page-source.ts, whose
 * first draft used `import * as os`).
 *
 * If this test ever fails because the namespace probe DOES see the spy, the
 * trap is gone — delete the file and the comment it is referenced from.
 */
describe('vi.spyOn(os, "homedir") reaches default imports, not namespace imports', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a default import sees the spy', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/fixture-home');
    expect(homedirViaDefaultImport()).toBe('/fixture-home');
  });

  it('a namespace import does NOT — it keeps the suite sandbox', () => {
    const sandbox = os.homedir();
    vi.spyOn(os, 'homedir').mockReturnValue('/fixture-home');
    expect(homedirViaNamespaceImport()).not.toBe('/fixture-home');
    expect(homedirViaNamespaceImport()).toBe(sandbox);
  });

  it('and the sandbox is still the sandbox — this is never a route to the real home', () => {
    expect(homedirViaNamespaceImport()).toBe(process.env.YOUCODED_TEST_HOME);
  });
});
