// Guards the suite-wide HOME sandbox configured in vitest.config.ts.
//
// Why this file exists: sync-warnings-lifecycle.test.ts spent months reading
// and DELETING the developer's real ~/.claude/.sync-warnings.json — a file a
// running YouCoded owns and rewrites at launch. It surfaced as an intermittent
// failure (ROADMAP :130), not as an obvious "this test edits production",
// because the test file never referenced the home directory: sync-state.ts
// resolved it internally at import time.
//
// vitest.config.ts now points HOME/USERPROFILE at a throwaway dir so that class
// of mistake cannot reach real state. That redirect is invisible — nothing else
// fails if someone deletes it during a config cleanup — so these assertions
// exist to make its removal loud and self-explaining.
import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('test-suite home isolation', () => {
  it('os.homedir() resolves to the sandbox, not the real home', () => {
    // The check that matters: every module resolving a path from os.homedir()
    // — directly or several imports deep — must land in the sandbox.
    expect(os.homedir()).toBe(process.env.YOUCODED_TEST_HOME);
    expect(path.dirname(os.homedir())).toBe(os.tmpdir());
  });

  it('the sandbox is unique to THIS run, so two concurrent runs cannot collide', () => {
    // The bug this pins: a fixed `youcoded-vitest-home` was shared by every
    // checkout on the machine, so a second session starting a suite ran
    // globalSetup's rmSync over the FIRST session's live sandbox. It showed up
    // as ENOTEMPTY / ENOENT temp-rename errors in whatever unrelated file was
    // mid-write, and was mis-filed twice as a bug in the victim test.
    //
    // Asserting the shape rather than the exact pid keeps this honest without
    // reaching for process internals: what must hold is that the directory name
    // carries a per-process discriminator at all. If someone reverts to a fixed
    // name to "simplify", this is the assertion that says why they shouldn't.
    expect(path.basename(os.homedir())).toMatch(/^youcoded-vitest-home-\d+$/);
    expect(os.homedir()).not.toBe(path.join(os.tmpdir(), 'youcoded-vitest-home'));
  });

  it('the sandbox is not the developer real home', () => {
    const real = process.env.YOUCODED_REAL_HOME;
    expect(real, 'YOUCODED_REAL_HOME missing — vitest.config.ts env block changed').toBeTruthy();
    expect(os.homedir()).not.toBe(real);
  });

  it('creates the sandbox Local AppData folder before native child processes start', () => {
    // WHY: Windows shell folder lookups can expand %USERPROFILE% and verify the
    // folder exists. Chrome refuses debugging if it cannot determine that folder.
    const local = path.join(os.homedir(), 'AppData', 'Local');
    expect(fs.existsSync(local)).toBe(true);
    expect(fs.statSync(local).isDirectory()).toBe(true);
  });

  it('writing ~/.claude state cannot escape the sandbox', () => {
    // End-to-end proof rather than a restatement of the config: resolve a path
    // the way the app's modules do, write to it, and confirm the bytes landed
    // in the sandbox and NOT in the real home.
    const claudeDir = path.join(os.homedir(), '.claude');
    const probe = path.join(claudeDir, '.home-isolation-probe');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(probe, 'probe');
    try {
      expect(fs.existsSync(probe)).toBe(true);
      const realProbe = path.join(process.env.YOUCODED_REAL_HOME!, '.claude', '.home-isolation-probe');
      expect(fs.existsSync(realProbe)).toBe(false);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  it('HOME and USERPROFILE agree, so the redirect holds on every platform', () => {
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows. Setting only
    // one would sandbox one CI leg and leave the other pointed at real state —
    // the worst outcome, because it would look green where it was tested.
    expect(process.env.HOME).toBe(os.homedir());
    expect(process.env.USERPROFILE).toBe(os.homedir());
  });

  it('globalSetup RETURNS its teardown, so a run cleans up the sandbox it made', async () => {
    // Pins the hook SHAPE, which is the part that fails silently. vitest reads a
    // named `teardown` export only when `setup` is also exported by name;
    // tests/global-setup.ts uses a default export, so the teardown must be the
    // setup function's RETURN VALUE. Getting that wrong breaks no test — every
    // suite still passes — it just leaks one sandbox directory per run into the
    // developer's tmpdir forever (15 accumulated in one afternoon before this
    // was caught by hand).
    //
    // Run against a THROWAWAY path, never the live sandbox: setup() begins by
    // deleting whatever it is pointed at, and this test is itself running out of
    // the real one.
    const scratch = path.join(os.tmpdir(), `youcoded-vitest-home-teardown-probe-${process.pid}`);
    const realSandbox = process.env.YOUCODED_TEST_HOME;
    process.env.YOUCODED_TEST_HOME = scratch;
    try {
      const { default: setup } = await import('./global-setup');
      const teardown = setup();
      expect(fs.existsSync(scratch), 'setup() did not create the sandbox it was pointed at').toBe(true);
      expect(typeof teardown, 'global-setup must RETURN its teardown, not export it').toBe('function');
      teardown!();
      expect(fs.existsSync(scratch), 'teardown() left the sandbox behind').toBe(false);
    } finally {
      process.env.YOUCODED_TEST_HOME = realSandbox;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
