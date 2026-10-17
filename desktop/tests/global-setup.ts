import fs from 'fs';
import path from 'path';
import os from 'os';

// Resets the suite-wide HOME sandbox (see vitest.config.ts) exactly ONCE per
// run, before any worker starts.
//
// The wipe deliberately does NOT live in vitest.config.ts. That module is
// imported by tools that are not running tests — `npm run knip` does, measured
// 2026-08-28 — and a wipe at import time would delete a sandbox out from under
// whatever is using it, which is how "ENOENT: rename
// '<sandbox>/.claude/youcoded-skills.json.tmp'" was seen mid-run. globalSetup
// is the hook that runs once per RUN, before any worker and after nothing else.
// Named by vitest.config.ts (pid-suffixed, one per run) and handed over in the
// real process env rather than re-derived here — this hook runs in the SAME
// process that evaluated the config, so it can simply read what that decided.
// The fallback only fires if someone runs this hook outside vitest.
function sandboxPath(): string {
  return process.env.YOUCODED_TEST_HOME || path.join(os.tmpdir(), `youcoded-vitest-home-${process.pid}`);
}

export default function setup() {
  const testHome = sandboxPath();
  // Sweep sandboxes abandoned by earlier runs (a killed vitest never reaches
  // teardown). Anything older than a day cannot belong to a live run, and a
  // pid-suffixed directory is unambiguously ours. Best-effort: a sandbox
  // another user owns, or one that vanishes mid-sweep, is skipped rather than
  // failing the run before a single test has executed.
  const DAY_MS = 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^youcoded-vitest-home-\d+$/.test(name)) continue;
      const full = path.join(os.tmpdir(), name);
      if (full === testHome) continue;
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > DAY_MS) fs.rmSync(full, { recursive: true, force: true });
      } catch { /* raced or not ours — leave it */ }
    }
  } catch { /* no tmpdir listing — nothing to sweep */ }
  // Fresh each run: a sandbox carrying state from a previous run would make
  // tests pass or fail based on what ran before, which is the failure mode this
  // whole sandbox exists to remove.
  fs.rmSync(testHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(testHome, '.claude'), { recursive: true });
  // WHY: native Windows shell APIs may expand the redirected USERPROFILE and
  // reject a missing known-folder target. Keep that target inside the sandbox,
  // rather than restoring the developer's real profile for browser subprocesses.
  fs.mkdirSync(path.join(testHome, 'AppData', 'Local'), { recursive: true });
  // git-service.ts's gitCommit shells out to real `git commit` with no author
  // env vars (that's the production code path) — it needs SOME identity to
  // resolve, and the redirected HOME above means it can no longer see the
  // developer's real ~/.gitconfig. A throwaway identity here (never the real
  // one) keeps git-service integration tests hermetic. See tests/git/git-service.test.ts.
  fs.writeFileSync(
    path.join(testHome, '.gitconfig'),
    '[user]\n\tname = YouCoded Test\n\temail = test@youcoded.test\n',
  );

  // Remove this run's sandbox once every worker has finished. Without it the
  // pid-suffixed directories (which, unlike the old fixed name, are never
  // reused) accumulate one per test run in the developer's tmpdir forever —
  // measured: 15 of them after a single afternoon's runs.
  //
  // Returned from setup() rather than exported as `teardown`: vitest reads a
  // named `teardown` export only when `setup` is exported by name too. This
  // file uses a DEFAULT export, so the returned-function form is the one that
  // actually runs — the first attempt used `export function teardown` and
  // silently never fired (every test still passes; the tmpdir just fills up),
  // which is why the day-old sweep in setup() above exists as a backstop.
  return () => {
    fs.rmSync(testHome, { recursive: true, force: true });
  };
}
