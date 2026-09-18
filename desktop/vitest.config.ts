import { defineConfig } from 'vitest/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import react from '@vitejs/plugin-react';

// A throwaway HOME for the whole suite.
//
// The developer's real ~/.claude is a RUNNING YouCoded's live state — the app
// reads and writes .sync-warnings.json, toolkit-state/, backup.log while it is
// open. A test that reaches it is both editing production and racing a second
// process, which is exactly how sync-warnings-lifecycle.test.ts came to fail
// intermittently for months (ROADMAP :130).
//
// Note what that bug looked like: the TEST FILE never mentioned the home
// directory at all. sync-state.ts resolved it internally at import time. So no
// amount of reviewing test files would have caught it, and a detection-based
// tripwire would have reported it as a mystery diff. Redirecting HOME instead
// makes the whole class structurally impossible: os.homedir() reads HOME on
// POSIX and USERPROFILE on Windows, so every module resolving a path from it —
// directly or three imports deep — lands in the sandbox.
//
// CREATED AND RESET by tests/global-setup.ts, not here. This module deliberately
// has NO import-time filesystem side effect: it is loaded by tools that are not
// running tests at all — measured 2026-08-28, `npm run knip` imports it to
// resolve the vite plugin config — and a mkdirSync at module scope fired for
// every one of them, leaving a stray sandbox directory behind on each
// `verify.sh` run (knip and vitest run concurrently there). Under the old fixed
// directory name that was invisible, because every tool aimed at the same path;
// with a per-run name it showed up as one empty leftover per verify run.
// Pinned by tests/home-isolation.test.ts; delete that test and this becomes
// silently load-bearing for nothing.
//
// PER-RUN, not shared. This used to be a fixed `youcoded-vitest-home`, which
// meant every checkout on the machine aimed at ONE directory: two sessions
// running suites at once (the normal case here — worktrees are the working
// convention) had globalSetup's `rmSync` in run B delete the sandbox out from
// under run A mid-flight. It surfaced as ENOTEMPTY / ENOENT temp-rename errors
// in whatever unrelated file happened to be writing at that instant, which is
// why it was mis-filed twice as a bug in the victim test (ROADMAP 2026-08-06,
// 2026-08-27). The pid suffix makes concurrent runs structurally incapable of
// sharing state — no coordination, no lockfile, no ordering assumption.
//
// The pid is the VITEST MAIN PROCESS's. Verified 2026-08-28: this config module
// is evaluated exactly ONCE per `vitest run` (in that main process), and the
// `env` block below is what propagates HOME into each worker — so every worker
// and globalSetup agree on the path without recomputing it. YOUCODED_TEST_HOME
// is exported into the real process env so tests/global-setup.ts (which runs in
// this same process, before any worker starts) wipes the SAME directory this
// config named, rather than re-deriving it and racing.
// The temp dir, spelled the way realpath() spells it. On the Windows CI runner
// os.tmpdir() is `C:\Users\RUNNER~1\AppData\Local\Temp` (an 8.3 short name) while
// every realpath() of a file under it says `C:\Users\runneradmin\…` — so a test that
// mkdtemp()s under os.tmpdir() and compares against a path the product resolved
// fails on Windows only. Three tests did, on every run from 2026-09-10 to 09-16
// (chatsearch-transcript-reader, managed-workspace-setup, native-session-host-
// continuation). Exporting the long form as TEMP/TMP/TMPDIR (what os.tmpdir()
// reads on each platform) makes the whole class impossible instead of patching
// each test: every worker's os.tmpdir() already IS the realpath spelling.
const TMP_REAL = (() => { try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); } })();
const TEST_HOME = path.join(TMP_REAL, `youcoded-vitest-home-${process.pid}`);
process.env.YOUCODED_TEST_HOME = TEST_HOME;

// Where `node_modules` REALLY is. In a worktree it is usually a hardlink farm
// (`cp -al`) and this equals the path below it; if someone symlinks it to the
// main checkout instead, this is the main checkout's path — outside this
// project root.
//
// WHY THAT MATTERS (fixed 2026-09-02): Vite resolves through the symlink to the
// real path, then its dev-server file guard denies anything outside the project
// root. The only imports that go through that guard are Vite-transformed asset
// URLs — `highlight.js/styles/github-dark.css?inline`, which theme-context.tsx
// imports — so the failure is not "cannot find module" but
// `Denied ID .../github-dark.css?inline`, thrown at MODULE LOAD. Measured in a
// symlinked worktree on this tree: 60 of 84 related test files failed to load,
// 0 test assertions failed, and the summary read "60 failed" with no hint that
// the cause was the checkout's plumbing rather than the diff. Naming the real
// directory here makes the guard allow it.
//
// This does NOT make a symlinked node_modules safe — `npm ci` and Gradle's
// bundleWebUi still follow it and empty the SHARED copy (workspace CLAUDE.md).
// `cp -al` remains the convention; scripts/verify.sh says so out loud when it
// sees a symlink. This only stops the test runner from lying about why it failed.
const NODE_MODULES = path.join(__dirname, 'node_modules');
const NODE_MODULES_REAL = fs.existsSync(NODE_MODULES)
  ? fs.realpathSync(NODE_MODULES)
  : NODE_MODULES;

export default defineConfig({
  // Fix: include the React plugin so TSX test files (JSX transform) compile correctly
  plugins: [react()],
  server: { fs: { allow: [__dirname, NODE_MODULES_REAL] } },
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    globalSetup: ['tests/global-setup.ts'],
    // Per-file DOM shims (ResizeObserver). Inert under the 'node' environment —
    // the file checks for `window` before touching anything.
    // setup-waitfor.ts supplies the vi.waitFor/waitUntil default timeout that
    // vitest has no config option for (its own default is 1s, which the 30s
    // testTimeout below does NOT cover). See that file for the failure it fixes.
    setupFiles: ['tests/setup-dom.ts', 'tests/setup-waitfor.ts'],
    // Node is the default; a test that needs DOM APIs opts in PER FILE with a
    // `// @vitest-environment jsdom` docblock on line 1.
    //
    // This used to also carry `environmentMatchGlobs: [['tests/**/*.tsx','jsdom']]`
    // with a comment promising .tsx files got jsdom automatically. Vitest 4
    // REMOVED that option — it is absent from the shipped type defs and is
    // silently ignored, with no deprecation warning — so the promise had been
    // false since the v4 bump while reading as true. Verified 2026-07-26: a new
    // tests/*.tsx file died on `document is not defined` until the docblock was
    // added, and the two .tsx files that lacked one then (Button.test.tsx, and a
    // source-text check since merged into SessionDrawer.test.tsx) passed in the
    // node environment.
    // Don't reinstate it; use `test.projects` if per-glob environments are ever
    // wanted again.
    environment: 'node',
    // WHY 30s and not vitest's 5s default: this suite is not all unit tests.
    // A dozen files import 4,000-line main-process modules, spawn child
    // processes, or drive a real HarnessSession through hundreds of scripted
    // steps. Measured in isolation on a 32-core box (2026-08-28):
    // remote-server 4.9s, engine-supervisor 4.5s, mcp-startup-wiring 2.7s for
    // the whole FILE — so a single heavy test in one of them sits within a
    // rounding error of the 5s per-test budget before any contention. Under a
    // parallel run they crossed it constantly, always at exactly 5000ms, and
    // always in a DIFFERENT file, which is the tell. The cost of this being
    // generous is that a genuinely hung test takes 30s to report instead of
    // 5s; the cost of it being tight was four agents in one afternoon
    // re-running suites to tell a real regression from noise, and one nearly
    // dismissing another agent's genuine breakage as flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // test-engine/*.mjs are plain-Node CLIs (harness-eval, its worker, the
    // review runner) that tests import in-process. WHY they must load NATIVELY
    // instead of through vite's module runner: they `import()` compiled dist/
    // modules by absolute path, and vite intercepts every dynamic import inside
    // a module it serves. On Linux that interception happened to work; on
    // Windows CI the file:// URL form Node itself requires (pathToFileURL, the
    // 2026-08-16 fix for ERR_UNSUPPORTED_ESM_URL_SCHEME) came back out of the
    // runner as "SyntaxError: Invalid or unexpected token" for all 60 tests
    // touching the CLI. Externalizing hands the file to Node's own loader —
    // the same path production takes — so the CLI's imports behave identically
    // in tests and at the terminal. (harness-eval-orchestrator.test.ts already
    // notes that the runner made require()/import() module identity diverge;
    // this removes that divergence too.)
    server: {
      deps: {
        external: [/[\\/]test-engine[\\/][^\\/]+\.mjs$/],
      },
    },
    alias: {
      // Stub Electron APIs so main-process imports don't crash in Node.js
      electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
    },
    // Both vars: os.homedir() consults HOME on POSIX and USERPROFILE on Windows.
    // YOUCODED_REAL_HOME lets the isolation guard prove the redirect actually
    // moved (it cannot read the original HOME once overridden).
    env: {
      HOME: TEST_HOME,
      USERPROFILE: TEST_HOME,
      // See TMP_REAL above: the realpath spelling of the temp dir, on every platform.
      TMPDIR: TMP_REAL,
      TEMP: TMP_REAL,
      TMP: TMP_REAL,
      YOUCODED_REAL_HOME: os.homedir(),
      // Lets tests and globalSetup name the sandbox without re-deriving it
      // (the pid suffix means re-deriving in a worker would get it wrong).
      YOUCODED_TEST_HOME: TEST_HOME,
    },
  },
});
