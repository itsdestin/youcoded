import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { graderRoot as srcGraderRoot, harnessRoot as srcHarnessRoot } from '../src/main/harness/eval/paths';
// Task 8c: the instructions axis is only real if the text reaches the SESSION,
// so this suite drives the same runCase + capturing model factory the runner
// suite uses to read back the system prompt a model was actually handed.
import { runCase } from '../src/main/harness/eval/run-case';
import { capturingFactory } from './helpers/harness-fakes';

const DESKTOP = path.resolve(__dirname, '..');
const COMPILED_PATHS = path.join(DESKTOP, 'dist/main/harness/eval/paths.js');
const CLI = path.join(DESKTOP, 'test-engine/harness-eval.mjs');
const requireCjs = createRequire(import.meta.url);

// EVERY assertion in this file that is not pure parsing SPAWNS A REAL NODE
// PROCESS — `runCliStubbed` and the bare `execFileSync` calls run
// test-engine/harness-eval.mjs for real, and several tests spawn two. Process
// startup and module loading scale with how busy the machine is, not with the
// code under test, so a wall-clock per-test budget here is a machine-load
// detector wearing a correctness test's clothes.
//
// Measured 2026-09-02 on this tree: the suite passed 11/11 runs alone, 6-way
// concurrent, and 4-way pinned to 4 cores. With EIGHT full suites at once, this
// file took 138s (vs ~17s alone) and `does not advertise models a --only run
// will not touch` — which spawns two CLIs and has no explicit budget — timed out
// at exactly 30,000ms in 3 of 8 runs. Most tests here already pass an explicit
// `}, 60_000)`; that one did not, which is the whole bug. Setting the budget for
// the file removes the requirement to remember.
//
// 120s is a HANG detector, not a performance assertion. Nothing in this file has
// ever been caught by a timeout that was not simply a busy machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Every grader-side module the orchestrator loads from its OWN dist. If any is
 * missing the CLI cannot even print a grid, so the whole suite depends on them.
 */
const REQUIRED_DIST_MODULES = [
  COMPILED_PATHS,
  path.join(DESKTOP, 'dist/main/harness/eval/matrix.js'),
  path.join(DESKTOP, 'dist/main/harness/eval/cases/index.js'),
  path.join(DESKTOP, 'dist/main/harness/eval/battery.js'),
];

/**
 * Build dist/ when the tree has not been built.
 *
 * BUILD DEPENDENCY — and why this BUILDS instead of skipping.
 * Fix (review round 2, IMPORTANT 1): the grader-isolation assertions need the
 * COMPILED module (see that describe), and .github/workflows/desktop-ci.yml
 * runs `npm ci` (line 48) -> `npm test` (51) -> knip -> lint -> `npm run build`
 * (92, Linux only). `npm test` is bare `vitest` with no pretest hook and dist/
 * is gitignored, so dist/ NEVER exists when CI runs this file, and Windows
 * never builds at all. Skipping would mean the invariant that stops a
 * branch-vs-master eval from silently comparing two GRADERS as well as two
 * harnesses is checked on no platform, ever.
 *
 * Fix (Task 8 Step 0, 2026-08-12): this used to compile paths.ts ALONE, which
 * was faithful only while paths.ts was the orchestrator's single dist import.
 * The integration made it load matrix.js, cases/index.js and battery.js from
 * the same dist, and cases/index.js transitively pulls in run-case.ts and the
 * whole harness — not a single-file compile any more. So run the project's own
 * build instead of a hand-rolled tsc invocation, which also removes the risk of
 * this helper's flags drifting from what `npm run build:main` produces.
 * Measured at ~11s on a cold tree; an already-built tree pays nothing.
 */
function ensureBuiltGraders(): void {
  const missing = REQUIRED_DIST_MODULES.filter((file) => !fs.existsSync(file));
  if (missing.length === 0) return;
  try {
    execFileSync(process.execPath, [requireCjs.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], {
      cwd: DESKTOP,
      stdio: 'pipe',
    });
  } catch (err) {
    // Fix (review round 3, MINOR 4): stdio 'pipe' means tsc's diagnostics land
    // on err.stdout and execFileSync's own message is only
    // "Command failed: .../tsc ...". Re-thrown WITH the real output attached —
    // the workspace rule against replacing a real error with a summary of it
    // applies to test harnesses too, and this is a hook a non-developer will
    // hit on a fresh checkout.
    const e = err as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
    throw new Error([
      `Could not build dist/ for the harness-eval tests (they need ${missing.join(', ')}).`,
      e.message,
      String(e.stdout ?? '').trim(),
      String(e.stderr ?? '').trim(),
    ].filter(Boolean).join('\n'));
  }
  const stillMissing = REQUIRED_DIST_MODULES.filter((file) => !fs.existsSync(file));
  if (stillMissing.length) {
    throw new Error(`tsc reported success but these are still missing: ${stillMissing.join(', ')}`);
  }
}

// The build is a whole-project tsc, so give the hook room; the default 10s
// hook timeout would fail on a cold tree for no reason but the clock.
const BUILD_TIMEOUT_MS = 300_000;

/** Run a one-off ES-module script under plain node (no vitest transform). */
function runNode(source: string): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: DESKTOP,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const q = (p: string) => JSON.stringify(p);

/**
 * Asserts MODULE IDENTITY for every grader the orchestrator loads: the exact
 * function object `loadGraders()` hands back must be the one `require()`
 * produces from `<desktop>/dist`. Prints "grader identity OK" and exits 0, or
 * names every mismatched module and exits 1.
 *
 * WHY identity and not content (fix pass 1, 2026-08-12 review, IMPORTANT 1):
 * a cell's `dist` is ANOTHER CHECKOUT OF THIS SAME REPO. It has the same case
 * ids, the same matrix, the same roster file — so "the registry contains
 * harness-battery" and "the roster contains Claude Opus 5", which is what this
 * test used to assert, pass identically whichever root the graders came from.
 * The one thing that differs between two roots is the module OBJECT.
 */
const GRADER_IDENTITY_PROBE = `
import { createRequire } from 'module';
import * as path from 'path';
const require_ = createRequire(${q(path.join(DESKTOP, 'package.json'))});
const matrixJs  = ${q(path.join(DESKTOP, 'dist/main/harness/eval/matrix.js'))};
const casesJs   = ${q(path.join(DESKTOP, 'dist/main/harness/eval/cases/index.js'))};
const batteryJs = ${q(path.join(DESKTOP, 'dist/main/harness/eval/battery.js'))};
const pathsJs   = ${q(COMPILED_PATHS)};

// WHY the file URL: Node's ESM loader rejects a bare absolute path on Windows
// (a D: drive path parses as protocol 'd:' → ERR_UNSUPPORTED_ESM_URL_SCHEME). It is
// still the same file through the same loader, so the require()-vs-import()
// module-cache identity this probe measures is unaffected.
const { loadGraders } = await import(${q(pathToFileURL(CLI).href)});
const g = await loadGraders();

const problems = [];
const same = (name, actual, expected) => { if (actual !== expected) problems.push(name); };
same('matrix.validatePlan', g.validatePlan, require_(matrixJs).validatePlan);
same('matrix.expandPlan',   g.expandPlan,   require_(matrixJs).expandPlan);
same('matrix.cellFilename', g.cellFilename, require_(matrixJs).cellFilename);
same('cases.allCaseIds',    g.allCaseIds,   require_(casesJs).allCaseIds);
same('cases.getCase',       g.getCase,      require_(casesJs).getCase);
same('paths.graderRoot',    g.graderRoot,   require_(pathsJs).graderRoot);
same('paths.harnessRoot',   g.harnessRoot,  require_(pathsJs).harnessRoot);

// battery.js is the one grader whose export is CALLED rather than handed back
// ("roster: battery.loadRoster(ROSTER_FILE)"), so there is no function
// reference to compare. Its equivalent evidence is the module cache: after
// loadGraders() exactly ONE battery.js may be loaded, and it must be this
// checkout's. A second root shows up here as a second cache entry.
const batteries = Object.keys(require_.cache)
  .filter((k) => k.endsWith(path.join('harness', 'eval', 'battery.js')));
if (batteries.length !== 1 || batteries[0] !== batteryJs) {
  problems.push('battery.js loaded from [' + batteries.join(', ') + '] instead of ' + batteryJs);
}

if (problems.length) {
  console.error('GRADER IDENTITY MISMATCH — these did not come from ' + ${q(path.join(DESKTOP, 'dist'))} + ':');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('grader identity OK');
`;

describe('grader isolation', () => {
  // WHY the COMPILED module and not just the TypeScript source: paths.ts
  // resolves its answer from `__dirname`, so the source answers
  // `<desktop>/src/...` under vitest and the compiled copy answers
  // `<desktop>/dist` — only the latter is what production actually produces. A
  // test that only imports the source cannot observe the value the orchestrator
  // will use. The build-on-demand rationale lives on ensureBuiltGraders().
  let compiled: { graderRoot: (c: { dist: string }) => string; harnessRoot: (c: { dist: string }) => string };

  beforeAll(() => {
    ensureBuiltGraders();
    // createRequire, not import(): dist/ is CommonJS (package.json is
    // "type": "commonjs") and this loads it exactly the way Node does for the
    // .mjs entry points, with no vite transform in between.
    compiled = requireCjs(COMPILED_PATHS);
  }, BUILD_TIMEOUT_MS);

  it('resolves graders against its own checkout, never the dist under test', () => {
    // Exact value, not a not-toContain: `return "/"` would have passed the
    // original assertion while breaking every grader load.
    expect(compiled.graderRoot({ dist: '/somewhere/else/dist' })).toBe(path.join(DESKTOP, 'dist'));
  });

  it('resolves the harness under test against the given dist', () => {
    expect(compiled.harnessRoot({ dist: '/somewhere/else/dist' })).toBe('/somewhere/else/dist');
  });

  it('ignores its argument entirely (two different dists, one answer)', () => {
    expect(compiled.graderRoot({ dist: '/a/dist' })).toBe(compiled.graderRoot({ dist: '/b/dist' }));
    // The source module is held to the same invariant, so that a future edit to
    // paths.ts fails here even before anything is rebuilt. (Its exact value
    // differs from the compiled copy's — src/ vs dist/ — which is precisely why
    // the assertions above have to run against the compiled module.)
    expect(srcGraderRoot({ dist: '/a/dist' })).toBe(srcGraderRoot({ dist: '/b/dist' }));
    expect(srcHarnessRoot({ dist: '/a/dist' })).toBe('/a/dist');
  });

  it('loads the case registry and the matrix from its own dist, not a cell dist', async () => {
    // Regression pin (Task 8 Step 0): the orchestrator imports matrix.js,
    // cases/index.js and battery.js at run time. Every one of them must come
    // from graderRoot() — a grader loaded from the cell's dist would make a
    // branch-vs-master run compare two graders as well as two harnesses, which
    // is a silently uninterpretable diff rather than a crash.
    //
    // Fix pass 1 (2026-08-12 review, IMPORTANT 1): this test used to assert
    // CONTENT — that the registry answers "harness-battery" and the roster
    // answers "Claude Opus 5". Those assertions could not fail for the reason
    // they claimed: a cell's `dist` is ANOTHER CHECKOUT OF THIS SAME REPO, so
    // it holds the same case ids, the same matrix and the same roster file, and
    // every content-shaped assertion passes identically whichever root was
    // used. What differs between the two roots is the module OBJECT, so that is
    // what is asserted now. Node keys its module cache by resolved path and
    // shares it between `require()` and `import()` of a CommonJS file, so a
    // function loaded from any other root can never be `===` to this one.
    // WHY the identity check runs in a SPAWNED plain-node process instead of
    // here: vitest USED TO serve `harness-eval.mjs` through vite's module
    // runner, so the dynamic `import()` inside it was intercepted and returned
    // a DIFFERENT module instance than `createRequire()` does — measured, the
    // in-process version of this assertion failed with "expected [Function
    // validatePlan] to be [Function validatePlan] // Object.is equality" on a
    // correct tree. Since 2026-08-16 vitest.config.ts externalizes
    // test-engine/*.mjs (native Node load — the fix for the Windows file://
    // import failure), which also makes the identities agree in-process; the
    // spawned probe stays because it measures the CLI exactly as it ships.
    // The CLI runs under plain node, where Node's module cache is keyed by
    // resolved path and shared between require() and import() of a CommonJS
    // file, so identity is exactly the right instrument — it just has to be
    // measured in the environment the invariant lives in.
    const { status, stdout, stderr } = runNode(GRADER_IDENTITY_PROBE);
    expect(`${stdout}${stderr}`.trim()).toContain('grader identity OK');
    expect(status).toBe(0);

    // ...and, in-process, that the graders genuinely answer. (These two do NOT
    // discriminate the root — see above — they only prove the modules loaded.)
    const { loadGraders } = await import('../test-engine/harness-eval.mjs');
    const graders = await loadGraders();
    expect(graders.allCaseIds()).toContain('harness-battery');
    expect(graders.roster.map((r: { label: string }) => r.label)).toContain('Claude Opus 5');
  }, BUILD_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------

function writePlan(plan: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-plan-'));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  return file;
}

/** Same as writePlan, but also seeds sibling files NEXT TO the plan (Task 8c).
 *  Instruction arm paths are resolved against the plan file's own directory, so
 *  a fixture that needs a real `instructions/*.md` has to put it there and
 *  nowhere else — which is also what makes the resolution testable: a loader
 *  that resolved against the cwd would find nothing at all. */
function writePlanWithFiles(plan: unknown, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-plan-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  return file;
}

// Fix (Task 8 Step 0): REAL ids. `validatePlan` cross-checks `cases` against
// the case registry and `models` against the roster's labels, which is the
// entire reason the orchestrator's own throwaway validator was deleted — so a
// fixture plan full of invented ids ("case-a", "vendor/model-1") would now be
// rejected before reaching the rule each test is actually about.
const BASE_PLAN = {
  name: 'unit-test-plan',
  cases: ['harness-battery'],
  instructions: [{ id: 'baseline', file: null }],
  models: ['Claude Opus 5'],
};

// Defect 1 fix: report.md/run-summary.json are now named after the plan (see
// matrix.ts's planFilenameSlug), so the real CLI writes `report-<slug>.md` and
// `run-summary-<slug>.json` instead of the bare names. Every real-CLI test
// below builds its plan from BASE_PLAN and none of them overrides `name`, so
// the slug is this one constant string throughout the whole file.
const REPORT_FILENAME = 'report-unit-test-plan.md';
const SUMMARY_FILENAME = 'run-summary-unit-test-plan.json';

describe('plan validation goes through matrix.ts validatePlan', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  it('rejects a case id that is not in the registry — which the deleted local validator never did', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // The reason Step 0 exists at all: two validators had merged cleanly and the
    // orchestrator's own one never looked at case ids or roster labels, so a
    // plan naming a case that does not exist expanded happily and would have
    // been billed as a real matrix.
    // The known-ids list is alphabetical, so this matches harness-battery
    // ANYWHERE in it rather than pinning it to first place — the assertion is
    // "the bad id is named and the valid set is printed", which is what the
    // deleted local validator failed to do. Pinning the position instead made
    // this test fail the moment a case sorting before "harness-battery" was
    // registered, which is a fact about the alphabet, not about validation.
    // Same shape the roster-label assertion below already used (`.*Claude Opus 5`).
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, cases: ['confgi-investigation'] })))
      .rejects.toThrow(/Unknown case id "confgi-investigation"\. Known case ids: .*harness-battery/);
  });

  it('rejects a model that is not a roster label', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, models: ['anthropic/claude-opus-5'] })))
      .rejects.toThrow(/Unknown model "anthropic\/claude-opus-5"\. Known models: .*Claude Opus 5/);
  });

  it('names the plan file, which validatePlan itself cannot know', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({ ...BASE_PLAN, cases: ['nope'] });
    await expect(readPlanFile(file)).rejects.toThrow(new RegExp(`plan "${file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}" is invalid`));
  });

  it('rejects a build arm with no dist, naming the arm', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({
      ...BASE_PLAN,
      builds: [{ id: 'current', dist: '/a/dist' }, { id: 'master' }],
    });
    // Regression pin: this plan used to expand and exit 0, with the "master"
    // arm silently running this checkout's own build.
    await expect(readPlanFile(file)).rejects.toThrow(/Build arm "master" has an invalid "dist"/);
  });

  it('accepts build arms that all name a dist', async () => {
    const { readPlanFile, expandPlanFile } = await import('../test-engine/harness-eval.mjs');
    // path.resolve, not the literal '/a/dist': the invariant is "a fully
    // absolute dist passes through untouched", and on Windows '/a/dist' is
    // only drive-RELATIVE, so the orchestrator (correctly) fills in the plan
    // file's drive and the literal came back as 'C:\a\dist' — the one red
    // test left on Windows CI (2026-08-16). resolve() yields '/a/dist' on
    // POSIX and 'D:\a\dist' on Windows: absolute on both, unchanged on both.
    const A = path.resolve('/a/dist');
    const B = path.resolve('/b/dist');
    const file = writePlan({
      ...BASE_PLAN,
      builds: [{ id: 'current', dist: A }, { id: 'master', dist: B }],
    });
    const cells = await expandPlanFile(await readPlanFile(file));
    expect(cells.map((c: { dist: string }) => c.dist)).toEqual([A, B]);
  });

  it('resolves a relative build dist against the plan file, not the cwd', async () => {
    // Fix (Task 8 Step 0): matrix.ts is a pure module, so its default build arm
    // is the RELATIVE `dist: '.'`. A relative dist reaching the worker resolves
    // against whatever cwd that worker inherits, i.e. "which harness am I
    // testing" would depend on where you were standing when you typed the
    // command. Resolution happens once, in the orchestrator, against the plan.
    const { readPlanFile, expandPlanFile } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({ ...BASE_PLAN, builds: [{ id: 'master', dist: 'sibling/dist' }] });
    const cells = await expandPlanFile(await readPlanFile(file));
    expect(cells[0].dist).toBe(path.join(path.dirname(file), 'sibling/dist'));
  });

  it('defaults to an ABSOLUTE current build when the plan names none', async () => {
    const { readPlanFile, expandPlanFile } = await import('../test-engine/harness-eval.mjs');
    const cells = await expandPlanFile(await readPlanFile(writePlan(BASE_PLAN)));
    expect(cells[0].buildId).toBe('current');
    expect(cells[0].dist).toBe(path.join(DESKTOP, 'dist'));
  });

  it('rejects a non-positive-integer repeats in the plan file', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, repeats: 0 })))
      .rejects.toThrow(/"repeats" must be a positive integer/);
  });

  it('rejects an instruction arm that omits "file", naming the arm', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 3, IMPORTANT 2): `[{id:'baseline'},{id:'terse'}]`
    // — one forgotten key — used to expand into two arms that were byte-identical
    // to a legitimate baseline. Both downstream guards stay silent for it (there
    // is no unresolved file to complain about), so N paid runs of ONE task got
    // reported as an instructions comparison.
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'terse' }],
    });
    await expect(readPlanFile(file)).rejects.toThrow(/Instruction arm "terse" has no "file" key/);
    // Fix pass 1 (2026-08-12 review, MINOR 1): the REASON is the part a
    // non-developer needs, and it was lost when this rule moved into matrix.ts.
    // Pinned so a future message rewrite cannot quietly drop it again.
    await expect(readPlanFile(file)).rejects.toThrow(/cannot be told apart from a deliberate null baseline/);
  });

  it('rejects a plan where EVERY arm forgot "file", not just one of them', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // Fix pass 1 (2026-08-12 review, MINOR 1): the original scenario. When the
    // test above was repointed at matrix.ts's validator its fixture gained an
    // explicit `file: null` on the first arm, so "the author never learned the
    // key exists" — the case where NO arm has it, and the whole instructions
    // axis is therefore one task repeated — stopped being exercised at all.
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline' }, { id: 'terse' }],
    });
    await expect(readPlanFile(file)).rejects.toThrow(/Instruction arm "baseline" has no "file" key/);
  });

  it('rejects an instruction arm whose "file" is neither a path nor null', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // '' would be carried as a falsy instructionsFile, i.e. treated downstream
    // as "baseline, nothing to resolve" — the same silent collapse by another
    // route. matrix.ts's validator accepted '' until Step 0 carried this rule
    // over from the deleted local one (`typeof '' === 'string'` passed).
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'terse', file: '' }],
    });
    await expect(readPlanFile(file)).rejects.toThrow(/Instruction arm "terse" has an invalid "file": ""/);
  });

  it('rejects two baseline arms, which are not a comparison', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // Also carried over from the deleted local validator — matrix.ts had no
    // equivalent rule, so two `"file": null` arms validated cleanly and would
    // have run one task twice, billed as an instructions comparison.
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'control', file: null }],
    });
    await expect(readPlanFile(file)).rejects.toThrow(/all set "file": null/);
  });

  it('rejects a non-string entry in cases or models', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 3, MINOR 5): only array-non-emptiness was
    // checked, so `cases: [null]` produced a cell id reading "null|baseline|...".
    // validatePlan catches the same class through membership: a non-string can
    // never be a known case id or roster label.
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, cases: [null] })))
      .rejects.toThrow(/Unknown case id null/);
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, models: ['Claude Opus 5', 7] })))
      .rejects.toThrow(/Unknown model 7/);
  });
});

describe('CLI flag parsing', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  // Spawned rather than imported: the flag is parsed in main(), and the point
  // of the fix is the process's exit code, which only a real process has.
  function run(args: string[]): { status: number | null; stderr: string } {
    try {
      execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, stderr: '' };
    } catch (err) {
      const e = err as { status: number | null; stderr: string };
      return { status: e.status, stderr: e.stderr };
    }
  }

  it('rejects a non-numeric value instead of printing "Repeats: NaN" and exiting 0', () => {
    const file = writePlan(BASE_PLAN);
    const { status, stderr } = run(['--plan', file, '--repeats', 'abc']);
    expect(status).toBe(2);
    expect(stderr).toContain('--repeats must be a positive integer (got "abc")');
  });

  it('rejects zero', () => {
    const file = writePlan(BASE_PLAN);
    expect(run(['--plan', file, '--repeats', '0']).status).toBe(2);
  });

  it('rejects a flag given no value instead of eating the next flag', () => {
    // Regression pin (review round 2, MINOR 2): `--plan --dry-run` used to set
    // planPath = "--dry-run" and fail with `could not read plan "--dry-run"`,
    // naming a flag as if it were a filename the user had typed.
    const { status, stderr } = run(['--plan', '--dry-run']);
    expect(status).toBe(2);
    expect(stderr).toContain('--plan needs a value, but the next argument is the flag "--dry-run"');
    expect(stderr).not.toContain('could not read plan');
  });

  it('rejects a trailing flag with nothing after it', () => {
    const { status, stderr } = run(['--plan']);
    expect(status).toBe(2);
    expect(stderr).toContain('--plan needs a value, but nothing followed it');
  });

  it('does not advertise models a --only run will not touch', () => {
    // Regression pin (review round 3, MINOR 6): printGrid read its axis lines
    // off the PLAN while main() filtered the CELLS, so a one-cell run printed
    // "Models: m1, m2" above a single row.
    //
    // The discriminating axis is MODELS rather than cases (Task 8 Step 0):
    // validatePlan now requires every case id to be in the registry, and the
    // registry currently holds exactly one case, so a two-case plan is no
    // longer constructible. Two roster labels are.
    const file = writePlan({ ...BASE_PLAN, models: ['Claude Opus 5', 'Grok 4.5'] });
    const out = execFileSync(
      process.execPath,
      [CLI, '--plan', file, '--only', 'harness-battery|baseline|Claude Opus 5|current|0', '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(out).toContain('Models: Claude Opus 5\n');
    expect(out).toContain('1 cell:');
    expect(out).not.toContain('Grok 4.5');
    // ...and an UNFILTERED run of the same plan still lists both.
    const all = execFileSync(process.execPath, [CLI, '--plan', file, '--dry-run'], { encoding: 'utf8' });
    expect(all).toContain('Models: Claude Opus 5, Grok 4.5\n');
  });

  it('accepts a positive integer and expands that many repeats', () => {
    const file = writePlan(BASE_PLAN);
    const out = execFileSync(process.execPath, [CLI, '--plan', file, '--repeats', '3', '--dry-run'], {
      encoding: 'utf8',
      // No key in the environment at all — --dry-run must not need one.
      env: { ...process.env, OPENROUTER_API_KEY: undefined } as NodeJS.ProcessEnv,
    });
    expect(out).toContain('3 cells');
    // Repeats is a COUNT of distinct indices, not max(repeat): matrix.js
    // numbers repeats from 0, so a max would have printed "Repeats: 2" here.
    expect(out).toContain('Repeats: 3\n');
  });
});

describe('every path derived from a cell goes through cellFilename', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  // The characters that make a raw cell id unusable as a filename. '|' is
  // Windows-reserved and the model axis carries roster LABELS ("Claude Opus
  // 5"), so a real cell id contains both a reserved character and spaces.
  const UNSAFE = /[|\s]/;

  it('produces a result path with no "|" and no space, from a real plan', async () => {
    const { readPlanFile, expandPlanFile, cellResultPath } = await import('../test-engine/harness-eval.mjs');
    const cells = await expandPlanFile(await readPlanFile(writePlan(BASE_PLAN)));
    // Proof the input really did contain both hazards — otherwise this test
    // could pass by them never having been there at all.
    expect(cells[0].id).toMatch(/\|/);
    expect(cells[0].id).toMatch(/\s/);
    const resolved = await cellResultPath('/runs', cells[0]);
    expect(path.basename(resolved)).not.toMatch(UNSAFE);
    // ...and it is not merely a sanitised id: the digest suffix is what keeps
    // two cells whose readable slugs collapse to the same slug distinct.
    expect(path.basename(resolved)).toMatch(/^harness-battery_baseline_claude-opus-5_current_0_[0-9a-f]{16}\.json$/);
  });

  it('is the path the CLI actually prints, not just an unused helper', () => {
    // WHY this one exists on top of the unit test above: a helper nothing calls
    // proves nothing about the orchestrator. This asserts the example filename
    // in the CLI's own output — the end-to-end route from plan file, through
    // matrix.js's expandPlan, to a filesystem name.
    const file = writePlan({ ...BASE_PLAN, models: ['Claude Opus 5'] });
    const out = execFileSync(process.execPath, [CLI, '--plan', file, '--dry-run'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.trim().startsWith('e.g. '));
    expect(line).toBeDefined();
    const printed = line!.trim().replace(/^e\.g\. /, '').replace(/ \(one file per cell\)$/, '');
    expect(printed).not.toMatch(UNSAFE);
    expect(printed).toMatch(/^harness-battery_baseline_claude-opus-5_current_0_[0-9a-f]{16}\.json$/);
  });
});

describe('runCell refuses to run a cell it cannot run honestly', () => {
  // runCell() imports its graders from dist/ before it spawns, so this suite
  // has the same build dependency the grader-isolation one declares. It used to
  // have it silently: on an unbuilt tree it only passed because the FIRST
  // describe's hook had already compiled the file. See ensureBuiltGraders().
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  // A real case id and a real roster label (Task 8 Step 0): runCell now looks
  // both up, so an invented pair would fail on the lookup rather than on the
  // guard each test is about.
  const cell = {
    id: 'harness-battery|baseline|Claude Opus 5|current|0',
    caseId: 'harness-battery',
    instructionsId: 'baseline',
    instructionsFile: null as string | null,
    model: 'Claude Opus 5',
    buildId: 'current',
    dist: '/a/dist',
    repeat: 0,
  };

  it('throws when the cell names a case that is not in the registry', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // Regression pin, rewired: the case body used to be a caller-supplied
    // argument and an absent one made runCase() fall back to the harness-review
    // battery, so every cell in the matrix ran the same task under a different
    // label. The body now comes from the registry, so the hole closes one level
    // up — an unknown caseId cannot produce a body at all, and says so by name.
    // `.*harness-battery` for the same alphabetical reason as the plan-validation
    // test above: the assertion is that the unknown id is named and the valid set
    // is printed with it, not that harness-battery happens to sort first.
    await expect(runCell({ ...cell, caseId: 'nope' }, { apiKey: 'sk-fake' }))
      .rejects.toThrow(/Unknown case "nope"\. Known cases: .*harness-battery/);
  });

  it('throws when the cell has no dist, naming the build arm', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    await expect(runCell({ ...cell, dist: '' }, { apiKey: 'sk-fake' }))
      .rejects.toThrow(/build arm "current"\) has no "dist"/);
  });

  it.each(['.', 'dist', './dist', '../other/dist'])('refuses a RELATIVE dist (%s) before spawning anything', async (dist) => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // Fix pass 1 (2026-08-12 review, IMPORTANT 2): the money-boundary guard
    // rejected only a FALSY dist, and the value that actually reached here was
    // `'.'` — matrix.ts's old default build arm, which is truthy. So a relative
    // dist sailed through to a paid spawn and the worker resolved the harness
    // under test against whatever cwd it inherited: the run would silently test
    // whichever build the cwd pointed at while the report named build
    // "current".
    //
    // WHY `rejects` is itself the proof that nothing was spawned: every path
    // that reaches the child process RESOLVES with a result object (see the
    // worker-stderr suite below, where a bad dist comes back as
    // `result.error`). Only the pre-flight guards reject.
    await expect(runCell({ ...cell, dist }, { apiKey: 'sk-fake' }))
      .rejects.toThrow(/has a RELATIVE "dist"/);
  });

  it('throws when the cell names a model that is not a roster label', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // A plan's `models` are roster LABELS; OpenRouter needs the model ID. This
    // orchestrator used to send `cell.model` straight through as `modelId`, so
    // after the switch to a label-validated plan the provider would have
    // rejected "Claude Opus 5" as unknown — AFTER the fixture was seeded.
    await expect(runCell({ ...cell, model: 'Claude Opus 9' }, { apiKey: 'sk-fake' }))
      .rejects.toThrow(/names model "Claude Opus 9", which is not a label in .*review-roster\.json/);
  });

  it('throws when an instruction arm names a file nobody resolved, naming the arm', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 2): the case axis was guarded and the
    // instructions axis was not, so two arms produced byte-identical configs
    // differing only in the cell id — N paid runs of one task, reported as a
    // matrix.
    await expect(runCell(
      { ...cell, instructionsId: 'terse', instructionsFile: 'instructions/terse.md' },
      { apiKey: 'sk-fake' },
    )).rejects.toThrow(/instruction arm "terse" declares a file \("instructions\/terse\.md"\)/);
  });

  it('does not throw for the baseline arm, and delivers the config over stdin', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // Two things at once, and the SECOND one is why this assertion is worded
    // the way it is.
    //
    // 1. `file: null` has nothing to resolve, so it must NOT be blocked — the
    //    guard has to be about an unread file, not about instructions being
    //    absent. It still fails, but on the worker side, which proves it got
    //    past the pre-flight checks rather than being refused by them.
    //
    // 2. Fix (review round 3, IMPORTANT 1): this is the ONLY regression pin on
    //    the stdin config channel (the detector that verified that fix was a
    //    throwaway script, deliberately kept out of the repo). It used to assert
    //    `result.error === 'worker exited 1 (see its stderr above)'` — and exit
    //    1 is what the worker returns for EVERY guard path, including "stdin
    //    closed without a config". So deleting `child.stdin.end(config)` would
    //    have left this test green while the channel was dead. Measured: with
    //    the payload dropped the worker said "stdin closed without a config"
    //    and the old assertion still passed.
    //
    //    "could not load the harness under test from /a/dist" is a message ONLY
    //    a DELIVERED config can produce: the worker reaches the dist import only
    //    after reading stdin to EOF, parsing the JSON, and passing every
    //    required-field check — and the path it names is one that exists
    //    nowhere but inside the config this call wrote. (runCell pipes and
    //    captures the worker's stderr now; with stdio[2]: 'inherit' the caller
    //    could not see WHICH error occurred, which is what made the weak
    //    assertion the only one available.)
    const result = await runCell({ ...cell, instructionsFile: null }, { apiKey: 'sk-fake' });
    expect(result.error).toContain('could not load the harness under test from "/a/dist"');
    // The non-delivery messages, named explicitly so this test fails loudly
    // rather than confusingly if the config ever stops arriving.
    expect(result.error).not.toContain('stdin closed without a config');
    expect(result.error).not.toContain('is not valid JSON');
    // ...and the config it delivered carried the case body from the registry
    // rather than nothing: a config with no prompt is refused by the worker
    // BEFORE it ever tries the dist import, with a different message.
    expect(result.error).not.toContain('has no "prompt"');
  }, 15_000);
});

describe('expandPlan carries the instruction arm file onto every cell', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  it('copies arm.file so runCell can tell "nothing to load" from "not loaded yet"', async () => {
    const { readPlanFile, expandPlanFile } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'terse', file: 'instructions/terse.md' }],
    });
    const cells = await expandPlanFile(await readPlanFile(file));
    expect(cells.map((c: { instructionsFile: string | null }) => c.instructionsFile))
      .toEqual([null, 'instructions/terse.md']);
  });
});

describe('loadInstructionTexts — the instructions axis actually reads its files', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  const twoArms = (file: string) => ({
    ...BASE_PLAN,
    instructions: [{ id: 'baseline', file: null }, { id: 'draft', file }],
  });

  it('reads each arm\'s file relative to the PLAN FILE, not the cwd', async () => {
    const { readPlanFile, loadInstructionTexts } = await import('../test-engine/harness-eval.mjs');
    // The file exists ONLY beside the plan, in a temp dir that has nothing to do
    // with the working directory vitest runs in. If resolution were cwd-relative
    // this call would fail with ENOENT instead of returning the text — which is
    // the whole discrimination: same base as readPlanFile uses for build.dist.
    const planFile = writePlanWithFiles(
      twoArms('instructions/draft.md'),
      { 'instructions/draft.md': '# Draft rules\n\nAlways say banana.\n' },
    );
    const texts = loadInstructionTexts(await readPlanFile(planFile), planFile);
    expect(texts.get('draft')).toBe('# Draft rules\n\nAlways say banana.\n');
    // The baseline arm has nothing to read and must stay distinguishable from
    // "an arm whose file has not been read yet".
    expect(texts.get('baseline')).toBeNull();
  });

  it('fails before any spend when a declared file cannot be read, naming the path and the real errno', async () => {
    const { readPlanFile, loadInstructionTexts } = await import('../test-engine/harness-eval.mjs');
    const planFile = writePlanWithFiles(twoArms('instructions/missing.md'), {});
    const abs = path.join(path.dirname(planFile), 'instructions/missing.md');
    const plan = await readPlanFile(planFile);
    let err: Error | undefined;
    try {
      loadInstructionTexts(plan, planFile);
    } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(err!.message).toContain('instruction arm "draft"');
    // The RESOLVED path, because "instructions/missing.md" alone does not tell
    // the reader which directory it was looked for in.
    expect(err!.message).toContain(abs);
    // The REAL I/O error, verbatim. Never a guessed cause.
    expect(err!.message).toContain('ENOENT');
  });

  it('passes through a DIFFERENT io error verbatim, so the message is not a hardcoded "file not found"', async () => {
    const { readPlanFile, loadInstructionTexts } = await import('../test-engine/harness-eval.mjs');
    // A directory where a file was expected: EISDIR, a different mistake with a
    // different fix. A loader that hardcoded "no such file" would be wrong here
    // and this assertion is what stops that from being written.
    const planFile = writePlanWithFiles(twoArms('instructions'), { 'instructions/keep.md': 'x' });
    const plan = await readPlanFile(planFile);
    expect(() => loadInstructionTexts(plan, planFile)).toThrow(/EISDIR|illegal operation on a directory/);
    expect(() => loadInstructionTexts(plan, planFile)).not.toThrow(/ENOENT/);
  });

  it('rejects two arms whose files hold the SAME text — that is one arm run twice', async () => {
    const { readPlanFile, loadInstructionTexts } = await import('../test-engine/harness-eval.mjs');
    // validatePlan cannot catch this: it sees two different PATHS and has no
    // filesystem. Duplicating a file and forgetting to edit the copy is the
    // ordinary way this happens, and it bills a full matrix for a comparison
    // between identical arms.
    const body = '# Rules\n\nBe terse.\n';
    const planFile = writePlanWithFiles({
      ...BASE_PLAN,
      instructions: [{ id: 'draft', file: 'draft.md' }, { id: 'tightened', file: 'tightened.md' }],
    }, { 'draft.md': body, 'tightened.md': body });
    const plan = await readPlanFile(planFile);
    expect(() => loadInstructionTexts(plan, planFile))
      .toThrow(/arms "draft" and "tightened" resolve to the SAME instructions text/);
  });

  it('counts two files that differ only in trailing whitespace as the same text', async () => {
    const { readPlanFile, loadInstructionTexts } = await import('../test-engine/harness-eval.mjs');
    // A trailing newline changes no instruction the model reads, so treating it
    // as a difference would let the identical-arms check be defeated by one
    // keystroke.
    const planFile = writePlanWithFiles({
      ...BASE_PLAN,
      instructions: [{ id: 'draft', file: 'draft.md' }, { id: 'tightened', file: 'tightened.md' }],
    }, { 'draft.md': '# Rules\n\nBe terse.', 'tightened.md': '# Rules\n\nBe terse.\n\n  ' });
    const plan = await readPlanFile(planFile);
    expect(() => loadInstructionTexts(plan, planFile)).toThrow(/resolve to the SAME instructions text/);
  });

  it('rejects an arm whose file is empty or whitespace-only — the same condition as the null baseline', async () => {
    const { readPlanFile, loadInstructionTexts } = await import('../test-engine/harness-eval.mjs');
    // THE null-VS-EMPTY CASE. `baseline` has no instructions; `draft` names a
    // file that contains none. Those are the same condition wearing two names,
    // and paying to compare them is the exact failure this tool exists to
    // prevent — but neither validatePlan (which sees a path, not its contents)
    // nor runCell (whose message would blame "no text supplied", which is not
    // what went wrong) can say so.
    const planFile = writePlanWithFiles(twoArms('draft.md'), { 'draft.md': '\n \t\n' });
    const plan = await readPlanFile(planFile);
    expect(() => loadInstructionTexts(plan, planFile))
      .toThrow(/instruction arm "draft" declares "draft\.md".*that file is empty/s);
    expect(() => loadInstructionTexts(plan, planFile)).toThrow(/same condition as "file": null/);
  });

  it('accepts two arms whose files genuinely differ', async () => {
    const { readPlanFile, loadInstructionTexts } = await import('../test-engine/harness-eval.mjs');
    const planFile = writePlanWithFiles({
      ...BASE_PLAN,
      instructions: [
        { id: 'baseline', file: null },
        { id: 'draft', file: 'draft.md' },
        { id: 'tightened', file: 'tightened.md' },
      ],
    }, { 'draft.md': '# Draft\n\nSay banana.\n', 'tightened.md': '# Tightened\n\nSay kumquat.\n' });
    const texts = loadInstructionTexts(await readPlanFile(planFile), planFile);
    expect([...texts.keys()]).toEqual(['baseline', 'draft', 'tightened']);
    expect(texts.get('draft')).toContain('banana');
    expect(texts.get('tightened')).toContain('kumquat');
  });
});

describe('two instruction arms produce two different CLAUDE.md bodies reaching the session', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  // WHY this test and not the shape guard that already exists: the Task 7 guard
  // proves an arm DECLARED a file. This one follows the whole chain the tool is
  // built on — plan file on disk → loadInstructionTexts → runCase's
  // `instructions` option → a real CLAUDE.md in the disposable fixture →
  // assembleSystemPrompt's <project-instructions> block → the system prompt the
  // model is actually handed (captured by capturingFactory, which keeps its
  // doStream argument because the system prompt never reaches the model
  // FACTORY). If the loader returned one text for both arms, or null for both,
  // the two captured prompts would be identical and this fails.
  //
  // The one hop it does not cover is runCell's subprocess. That is covered
  // end-to-end through the real CLI further down ("both arms reach the worker
  // with their OWN text"), which reads the two per-cell result files off disk.
  it('carries each arm\'s own file into its own project-instructions block', async () => {
    const { readPlanFile, loadInstructionTexts } = await import('../test-engine/harness-eval.mjs');
    const planFile = writePlanWithFiles({
      ...BASE_PLAN,
      instructions: [{ id: 'draft', file: 'draft.md' }, { id: 'tightened', file: 'tightened.md' }],
    }, {
      'draft.md': '# Draft guidance\n\nALWAYS_SAY_BANANA before answering.\n',
      'tightened.md': '# Tightened guidance\n\nALWAYS_SAY_KUMQUAT before answering.\n',
    });
    const texts = loadInstructionTexts(await readPlanFile(planFile), planFile);

    const captured: string[] = [];
    for (const armId of ['draft', 'tightened']) {
      await runCase({
        modelFactory: capturingFactory(captured),
        modelId: 'test/model', label: 'test', prompt: 'hi', contextLength: 64_000,
        instructions: texts.get(armId),
      });
    }

    const [draftPrompt, tightenedPrompt] = captured;
    // Both went through the REAL project-instructions path, not a pretend one.
    expect(draftPrompt).toContain('<project-instructions source="CLAUDE.md">');
    expect(tightenedPrompt).toContain('<project-instructions source="CLAUDE.md">');
    // ...and each carries ITS OWN arm's text and not the other's. Two arms
    // resolving to one text would fail both negative assertions at once.
    expect(draftPrompt).toContain('ALWAYS_SAY_BANANA');
    expect(draftPrompt).not.toContain('ALWAYS_SAY_KUMQUAT');
    expect(tightenedPrompt).toContain('ALWAYS_SAY_KUMQUAT');
    expect(tightenedPrompt).not.toContain('ALWAYS_SAY_BANANA');
    expect(draftPrompt).not.toBe(tightenedPrompt);
  }, 30_000);
});

describe('worker stderr is redacted before it can reach a transcript', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  // Regression pin (review round 4): runCell captures the worker's stderr tail
  // verbatim into `result.error`, and `result` is what the caller writes to disk
  // as a transcript. That is a FOURTH channel in this branch's long-running
  // credential-leak story (argv, then the environment, then /proc/environ one
  // process up). No current failure path prints the key, so this guards the
  // future: an uncaught throw or a provider-SDK warning would otherwise be filed
  // verbatim.
  it('replaces every occurrence of the key, anywhere in the text', async () => {
    const { redactKey } = await import('../test-engine/harness-eval.mjs');
    const key = 'sk-or-v1-CANARY';
    const out = redactKey(`boom ${key} mid ${key}\ntrailing ${key}`, key);
    expect(out).not.toContain(key);
    expect(out.match(/\[REDACTED credential\]/g)).toHaveLength(3);
  });

  it('scrubs a real worker run, not just the helper in isolation', async () => {
    // WHY this one exists on top of the unit tests above: those pin redactKey
    // itself, and a first draft of them passed with the call site DELETED —
    // exactly the tautological-test shape this branch's reviews have caught
    // twice. This exercises the wiring instead.
    //
    // The trick is getting the key into real worker stderr without any code
    // that prints it: the worker's dist-load failure interpolates the `dist`
    // path it was given, so a path CONTAINING the canary makes the worker emit
    // the canary in its own words, through the same stderr -> result.error ->
    // transcript route a provider-SDK warning would take.
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    const key = 'sk-or-v1-CANARY-IN-A-PATH';
    const result = await runCell(
      {
        id: 'harness-battery|baseline|Claude Opus 5|current|0',
        caseId: 'harness-battery',
        instructionsId: 'baseline',
        instructionsFile: null,
        model: 'Claude Opus 5',
        buildId: 'current',
        dist: `/nonexistent/${key}/dist`,
        repeat: 0,
      },
      { apiKey: key },
    );
    // Proof the worker really did echo the path back (otherwise this test could
    // pass by the key never having been there at all).
    expect(result.error).toContain('could not load the harness under test');
    expect(result.error).toContain('[REDACTED credential]');
    expect(result.error).not.toContain(key);
  }, 15_000);

  it('is a no-op when there is no key, so --dry-run takes the same path', async () => {
    const { redactKey } = await import('../test-engine/harness-eval.mjs');
    expect(redactKey('plain text', undefined)).toBe('plain text');
    expect(redactKey('plain text', '')).toBe('plain text');
  });

  it('survives a key containing regex metacharacters', async () => {
    const { redactKey } = await import('../test-engine/harness-eval.mjs');
    // WHY this case: building a RegExp from the key would throw on an unbalanced
    // bracket, or silently match the wrong span. split/join cannot.
    const key = 'sk-a+b[c).*d';
    expect(redactKey(`x ${key} y`, key)).toBe('x [REDACTED credential] y');
  });
});

describe('the worker environment is an allowlist, not the operator shell', () => {
  it('drops unrelated credentials and keeps what the harness needs', async () => {
    const { workerEnv } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 2, MINOR 1): the worker used to get
    // `{ ...process.env }`, and the model's Bash tool spawns ITS children from
    // that same env — so every secret in the operator's shell reached a tool
    // subprocess and, via run.events, a saved transcript on disk.
    const saved = { ...process.env };
    try {
      process.env.ANTHROPIC_API_KEY = 'canary-anthropic';
      process.env.GITHUB_TOKEN = 'canary-github';
      process.env.OPENROUTER_API_KEY = 'canary-openrouter';
      const env = workerEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      // The OpenRouter key travels in the stdin config now — not here.
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(Object.values(env)).not.toContain('canary-openrouter');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      process.env = saved;
    }
  });
});

describe('the worker refuses a config on argv', () => {
  it('names the stdin channel and the reason instead of running', () => {
    const worker = path.join(DESKTOP, 'test-engine/harness-eval-worker.mjs');
    let stderr = '';
    let status: number | null = 0;
    try {
      execFileSync(process.execPath, [worker, '{"cellId":"c1"}'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      const e = err as { status: number | null; stderr: string };
      status = e.status;
      stderr = e.stderr;
    }
    expect(status).toBe(1);
    expect(stderr).toContain('read from STDIN, not argv');
    expect(stderr).toContain('/proc/<pid>/cmdline');
  });
});

// ===========================================================================
// Task 8 — the credential channel, the estimate gate, the spend cap, and the
// per-cell timeout.
// ===========================================================================

describe('the credential never arrives in an environment variable', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  function keyFileWith(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-key-'));
    const file = path.join(dir, 'key');
    fs.writeFileSync(file, contents, { mode: 0o600 });
    return file;
  }

  it('refuses to run when OPENROUTER_API_KEY is in the environment, and says why', async () => {
    const { loadApiKey } = await import('../test-engine/harness-eval.mjs');
    // The mechanism, in one assertion: `delete process.env.X` is unsetenv, which
    // edits the in-heap array and never rewrites /proc/<pid>/environ. By the time
    // this process is running, an inherited key has ALREADY leaked to every
    // descendant — including the Bash tool the model under test drives. There is
    // no fix at this point, so the only honest response is to refuse.
    expect(() => loadApiKey({ env: { OPENROUTER_API_KEY: 'sk-or-v1-CANARY' } }))
      .toThrow(/refusing to run/);
    expect(() => loadApiKey({ env: { OPENROUTER_API_KEY: 'sk-or-v1-CANARY' } }))
      .toThrow(/\/proc\/<pid>\/environ/);
    // The remedy has to be in the message: the reader is a non-developer.
    expect(() => loadApiKey({ env: { OPENROUTER_API_KEY: 'sk-or-v1-CANARY' } }))
      .toThrow(/--key-file/);
  });

  it('still refuses when a --key-file is ALSO given', async () => {
    const { loadApiKey } = await import('../test-engine/harness-eval.mjs');
    // The leak happened at exec, before this program had any say. Reading the key
    // from somewhere else does not un-leak the copy already in /proc.
    const file = keyFileWith('sk-or-v1-FROM-FILE');
    expect(() => loadApiKey({ keyFile: file, env: { OPENROUTER_API_KEY: 'sk-or-v1-FROM-ENV' } }))
      .toThrow(/refusing to run/);
  });

  it('requires --key-file when the environment is clean', async () => {
    const { loadApiKey } = await import('../test-engine/harness-eval.mjs');
    expect(() => loadApiKey({ env: {} })).toThrow(/--key-file <path> is required/);
  });

  it('reads and trims the key from the file', async () => {
    const { loadApiKey } = await import('../test-engine/harness-eval.mjs');
    // Trailing newline is what every `echo "sk-..." > file` produces.
    expect(loadApiKey({ keyFile: keyFileWith('sk-or-v1-REAL\n'), env: {} })).toBe('sk-or-v1-REAL');
  });

  it('names the real errno for an unreadable key file, not a guess', async () => {
    const { loadApiKey } = await import('../test-engine/harness-eval.mjs');
    expect(() => loadApiKey({ keyFile: '/nonexistent/key', env: {} }))
      .toThrow(/could not read --key-file "\/nonexistent\/key": ENOENT/);
  });

  it('rejects an empty file rather than sending an empty key', async () => {
    const { loadApiKey } = await import('../test-engine/harness-eval.mjs');
    expect(() => loadApiKey({ keyFile: keyFileWith('   \n'), env: {} })).toThrow(/is empty/);
  });

  it('rejects a shell export line, which would otherwise 401 opaquely', async () => {
    const { loadApiKey } = await import('../test-engine/harness-eval.mjs');
    expect(() => loadApiKey({ keyFile: keyFileWith('export OPENROUTER_API_KEY=sk-or-v1-X'), env: {} }))
      .toThrow(/contains whitespace inside the key/);
  });

  // --- and the same rules through the real CLI, where they actually apply ----

  function runCli(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number | null; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  /** The operator's environment with the key definitively absent — `delete` on a
   *  plain object is a real delete (this is not process.env). */
  function cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;
    return env;
  }

  it('--dry-run works with no key anywhere and prints a dollar figure', () => {
    const file = writePlan(BASE_PLAN);
    const { status, stdout } = runCli(['--plan', file, '--dry-run'], cleanEnv());
    expect(status).toBe(0);
    expect(stdout).toContain('Estimated cost');
    expect(stdout).toContain('TOTAL');
    expect(stdout).toContain('(dry run: nothing was spawned and nothing was spent)');
    // No key was read, so no key-file error can have been printed.
    expect(stdout).not.toContain('--key-file <path> is required');
  });

  it('a PAID run refuses an inherited key, before spawning anything', () => {
    const file = writePlan(BASE_PLAN);
    const { status, stderr } = runCli(
      ['--plan', file, '--yes'],
      { ...process.env, OPENROUTER_API_KEY: 'sk-or-v1-CANARY-INHERITED' },
    );
    expect(status).toBe(2);
    expect(stderr).toContain('refusing to run');
    expect(stderr).toContain('/proc/<pid>/environ');
  });

  it('a PAID run with a clean environment still demands --key-file', () => {
    const file = writePlan(BASE_PLAN);
    const { status, stderr } = runCli(['--plan', file, '--yes'], cleanEnv());
    expect(status).toBe(2);
    expect(stderr).toContain('--key-file <path> is required');
  });

  it('validates --max-spend and --timeout before printing anything', () => {
    const file = writePlan(BASE_PLAN);
    expect(runCli(['--plan', file, '--max-spend', 'abc', '--dry-run'], cleanEnv()).stderr)
      .toContain('--max-spend must be a positive number of dollars (got "abc")');
    expect(runCli(['--plan', file, '--max-spend', '0', '--dry-run'], cleanEnv()).status).toBe(2);
    expect(runCli(['--plan', file, '--timeout', '-1', '--dry-run'], cleanEnv()).status).toBe(2);
  });
});

describe('the spend cap', () => {
  const cells = ['a', 'b', 'c', 'd'].map((id) => ({ id, model: 'Claude Opus 5' }));

  /** A fake cell runner that records what it was asked to run. */
  function recorder() {
    const ran: string[] = [];
    return {
      ran,
      runOne: async (cell: { id: string }) => { ran.push(cell.id); return { cellId: cell.id, run: {} }; },
    };
  }

  it('runs every cell and never asks about usage when no cap was given', async () => {
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const { ran, runOne } = recorder();
    let usageCalls = 0;
    const out = await runMatrix(cells, {
      runOne,
      readUsage: async () => { usageCalls++; return 0; },
      maxSpendUsd: undefined,
    });
    expect(ran).toEqual(['a', 'b', 'c', 'd']);
    expect(out.skipped).toEqual([]);
    expect(out.stopReason).toBeUndefined();
    // A cap that was not requested must not cost a network round trip per cell.
    expect(usageCalls).toBe(0);
  });

  it('stops when real spend passes the cap and names exactly which cells never ran', async () => {
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const { ran, runOne } = recorder();
    // Baseline 10, then +2 per cell. Cap 5 → tripped after the third cell
    // (spend 6 >= 5), so 'd' never runs.
    const usage = [10, 12, 14, 16];
    let i = 0;
    const out = await runMatrix(cells, { runOne, readUsage: async () => usage[i++], maxSpendUsd: 5 });
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(out.results.map((r: { cellId: string }) => r.cellId)).toEqual(['a', 'b', 'c']);
    expect(out.skipped.map((c: { id: string }) => c.id)).toEqual(['d']);
    expect(out.stopReason).toContain('--max-spend $5.00 reached');
    // The figures in the message are the measured ones, not the estimate's.
    expect(out.stopReason).toContain('$6.0000 billed');
    expect(out.stopReason).toContain('Stopped after 3 of 4 cells');
  });

  it('lets the cell that trips the cap FINISH — a half-run costs the same and yields nothing', async () => {
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const { ran, runOne } = recorder();
    // The very first cell blows the cap wide open.
    const usage = [0, 1000];
    let i = 0;
    const out = await runMatrix(cells, { runOne, readUsage: async () => usage[i++], maxSpendUsd: 1 });
    expect(ran).toEqual(['a']);
    // The result for the offending cell is KEPT, not discarded.
    expect(out.results).toHaveLength(1);
    expect(out.results[0].cellId).toBe('a');
    expect(out.skipped.map((c: { id: string }) => c.id)).toEqual(['b', 'c', 'd']);
  });

  it('does not check usage after the last cell', async () => {
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const { runOne } = recorder();
    let usageCalls = 0;
    await runMatrix(cells, {
      runOne,
      readUsage: async () => { usageCalls++; return 0; },
      maxSpendUsd: 1000,
    });
    // 1 baseline + 3 between-cell checks. A fifth would be a network call whose
    // answer cannot change anything.
    expect(usageCalls).toBe(4);
  });

  it('refuses to start when the BASELINE usage read fails — an unmeasurable cap is not a cap', async () => {
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const { ran, runOne } = recorder();
    await expect(runMatrix(cells, {
      runOne,
      readUsage: async () => { throw new Error('HTTP 401 Unauthorized'); },
      maxSpendUsd: 5,
    })).rejects.toThrow(/HTTP 401 Unauthorized/);
    // Nothing was spent: the read happens before the first cell.
    expect(ran).toEqual([]);
  });

  it('stops rather than continuing uncapped when a MID-RUN usage read fails', async () => {
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const { ran, runOne } = recorder();
    let call = 0;
    const out = await runMatrix(cells, {
      runOne,
      readUsage: async () => { if (++call > 1) throw new Error('ECONNRESET'); return 0; },
      maxSpendUsd: 5,
    });
    expect(ran).toEqual(['a']);
    expect(out.stopReason).toContain('could not read OpenRouter usage');
    // The real error, not a summary of it.
    expect(out.stopReason).toContain('ECONNRESET');
    expect(out.skipped.map((c: { id: string }) => c.id)).toEqual(['b', 'c', 'd']);
  });

  it('turns a runOne THROW into a stopReason instead of losing the whole matrix', async () => {
    // Fix pass 1 (2026-08-12 review, CRITICAL). runCell throws — rather than
    // resolving with an `error` field — for four per-cell conditions, all of them
    // reachable on cell N after cells 1..N-1 have been billed. That rejection used
    // to escape runMatrix, taking `results` and `skipped` with it.
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const ran: string[] = [];
    const out = await runMatrix(cells, {
      runOne: async (cell: { id: string }) => {
        if (cell.id === 'c') throw new Error('instruction arm "guided" declares a file');
        ran.push(cell.id);
        return { cellId: cell.id, run: {} };
      },
      readUsage: async () => 0,
      maxSpendUsd: undefined,
    });
    expect(ran).toEqual(['a', 'b']);
    expect(out.results.map((r: { cellId: string }) => r.cellId)).toEqual(['a', 'b']);
    // The failing cell produced nothing, so it is named alongside the ones after it.
    expect(out.skipped.map((c: { id: string }) => c.id)).toEqual(['c', 'd']);
    // The real error, not a summary or a guess at it.
    expect(out.stopReason).toContain('instruction arm "guided" declares a file');
    expect(out.stopReason).toContain('cell "c"');
  });

  it('turns an onResult write failure into a stopReason, keeping the cell that already ran', async () => {
    // ENOSPC / EACCES on cell N is not evidence that cells 1..N-1 did not happen.
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const { ran, runOne } = recorder();
    const out = await runMatrix(cells, {
      runOne,
      readUsage: async () => 0,
      maxSpendUsd: undefined,
      onResult: async (cell: { id: string }) => {
        if (cell.id === 'b') throw new Error("ENOSPC: no space left on device, open '/x/b.json'");
      },
    });
    expect(ran).toEqual(['a', 'b']);
    // 'b' RAN and was billed, so it is in results and NOT in neverRan.
    expect(out.results.map((r: { cellId: string }) => r.cellId)).toEqual(['a', 'b']);
    expect(out.skipped.map((c: { id: string }) => c.id)).toEqual(['c', 'd']);
    expect(out.stopReason).toContain('ENOSPC');
  });

  it('tags ONLY the baseline failure as "before the first cell"', async () => {
    // The tag is what lets the CLI say "nothing was spent" without guessing —
    // and, crucially, what stops it saying that about anything else.
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const { runOne } = recorder();
    const err = await runMatrix(cells, {
      runOne,
      readUsage: async () => { throw new Error('HTTP 401 Unauthorized'); },
      maxSpendUsd: 5,
    }).catch((e: Error & { beforeFirstCell?: boolean }) => e);
    expect((err as Error & { beforeFirstCell?: boolean }).beforeFirstCell).toBe(true);
    // A non-Error rejection still gets tagged (ESM is strict mode, so assigning a
    // property to a primitive would throw and lose the failure entirely).
    const err2 = await runMatrix(cells, {
      runOne,
      readUsage: async () => { throw 'a bare string'; },
      maxSpendUsd: 5,
    }).catch((e: Error & { beforeFirstCell?: boolean }) => e);
    expect((err2 as Error & { beforeFirstCell?: boolean }).beforeFirstCell).toBe(true);
    expect((err2 as Error).message).toContain('a bare string');
  });

  it('hands every completed result to onResult BEFORE a later stop', async () => {
    const { runMatrix } = await import('../test-engine/harness-eval.mjs');
    const { runOne } = recorder();
    // Results are written to disk as each cell finishes, so a run stopped by the
    // cap does not also lose the cells that were already paid for.
    const written: string[] = [];
    const usage = [0, 99];
    let i = 0;
    await runMatrix(cells, {
      runOne,
      readUsage: async () => usage[i++],
      maxSpendUsd: 1,
      onResult: async (cell: { id: string }) => { written.push(cell.id); },
    });
    expect(written).toEqual(['a']);
  });
});

/**
 * END-TO-END THROUGH THE REAL CLI, with only `fetch` faked.
 *
 * WHY this block exists (fix pass 1, 2026-08-12 review, CRITICAL + IMPORTANT 3).
 * Every test above injects `runOne` / `readUsage` / `maxSpendUsd` straight into
 * `runMatrix`, so all of them keep passing if the CLI stops passing `maxSpendUsd`
 * at all — the cap would be inert in the shipped tool and nothing would notice.
 * That is the same shape as the three credential rounds that were each certified
 * one level below the behaviour they claimed to guard. These spawn the real
 * `harness-eval.mjs`, with a real plan, a real worker subprocess, and a real
 * `run-summary.json` on disk.
 *
 * NOTHING IS SPENT AND NO KEY IS USED: `--import` preloads a stub that replaces
 * `globalThis.fetch`, and the build arm points at a fake dist whose `runCase`
 * returns immediately without touching a network or a model.
 */
describe('the real CLI, end to end (fetch faked, no key, no spend)', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  /** A "dist under test" whose runCase resolves at once. The worker imports
   *  run-case.js / openrouter-factory.js from the CELL's dist, so this is a
   *  complete stand-in for a paid model run. */
  function fastDist(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-fast-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const dir = path.join(root, 'main/harness/eval');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'run-case.js'),
      'export const runCase = async (c) => ({ label: c.label, outcome: "completed", events: [] });\n',
    );
    fs.writeFileSync(
      path.join(dir, 'openrouter-factory.js'),
      'export const makeOpenRouterFactory = () => async () => ({});\n',
    );
    return root;
  }

  /** Like fastDist(), but the fake runCase ECHOES the `instructions` it was
   *  handed back out through the result. That is the only observable end of the
   *  orchestrator→worker hop that does not cost money: the real runCase would
   *  write this exact string into the fixture as CLAUDE.md (see the
   *  project-instructions suite above, which pins the rest of the chain). */
  function echoingDist(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-echo-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const dir = path.join(root, 'main/harness/eval');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'run-case.js'),
      'export const runCase = async (c) => ({ label: c.label, outcome: "completed", events: [],'
      + ' instructionsSeen: c.instructions ?? null });\n',
    );
    fs.writeFileSync(
      path.join(dir, 'openrouter-factory.js'),
      'export const makeOpenRouterFactory = () => async () => ({});\n',
    );
    return root;
  }

  /** A preload module that replaces `fetch`. `usage` is the sequence
   *  GET /api/v1/key hands back, one per call; a `null` entry answers with a
   *  non-numeric `data.usage` (a changed API shape), which fetchKeyUsage
   *  refuses to read as "$0 spent". The catalog defaults to empty, so every
   *  model comes back `unpriced` (which also pins the null-estimate branch);
   *  `catalog` seeds real `/api/v1/models` rows for the tests that need a
   *  PRICED model — the judge disclosure quotes the judge's own rate. */
  function fetchStub(usage: (number | null)[], catalog: unknown[] = []): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-stub-')), 'stub.mjs');
    fs.writeFileSync(file, `
const usage = ${JSON.stringify(usage)};
const catalog = ${JSON.stringify(catalog)};
let i = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/v1/models')) {
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: catalog }) };
  }
  if (u.includes('/api/v1/key')) {
    const value = usage[Math.min(i++, usage.length - 1)];
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: { usage: value } }) };
  }
  throw new Error('the CLI made an unexpected network call in a test: ' + u);
};
`);
    return file;
  }

  /** A key file holding an obvious canary. It is never sent anywhere — `fetch`
   *  is stubbed and the fake dist's runCase ignores its model factory. */
  function canaryKeyFile(): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-key-')), 'key');
    fs.writeFileSync(file, 'sk-or-v1-CANARY-NEVER-SENT');
    fs.chmodSync(file, 0o600); // keeps the group-readable warning out of stderr
    return file;
  }

  // Every CLI invocation in this file writes its results HERE, not into the
  // developer's real workspace. Before the YOUCODED_EVAL_RUNS_DIR override
  // existed, resolveRunsDir walked up to youcoded-dev and wrote into
  // docs/active/investigations/harness-eval-runs/<date>/ for real — see that
  // function's comment for what that cost. One directory for the whole file is
  // enough: it is unique per process, so concurrent suites cannot meet in it.
  const RUNS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-runs-'));

  function runCliStubbed(stub: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const env = { ...process.env, YOUCODED_EVAL_RUNS_DIR: RUNS_ROOT };
    delete env.OPENROUTER_API_KEY;
    try {
      const stdout = execFileSync(
        process.execPath,
        ['--import', pathToFileURL(stub).href, CLI, ...args],
        { encoding: 'utf8', stdio: 'pipe', env },
      );
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number | null; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  /**
   * The CLI writes into the workspace's `docs/active/investigations/...` by
   * design (resolveRunsDir), which is a REAL directory on a developer's machine
   * — so remember what was there and put it back. Anything the run created is
   * removed; anything that was already there is restored to what it was,
   * content and all.
   *
   * WHY content, not just presence (Defect 3, found by the coordinator running
   * this suite against the real workspace): `report.md` and `run-summary.json`
   * used to have no plan identifier, so a bare-bones "remove anything new"
   * guard was wrong by construction the moment the CLI under test wrote into
   * an entry that ALREADY EXISTED — it deleted only additions, so an in-place
   * overwrite of a real, committed experiment report sailed through
   * untouched. Defect 1's per-plan filenames make an accidental name collision
   * far less likely going forward, but this guard's whole job is protecting a
   * developer's real data from this test suite, so it has to hold even if a
   * future plan happens to share a name with a real one — the directory is
   * restored to its true prior state, not to "whatever names existed before".
   *
   * Snapshotting is eager (read now, not lazily) and shallow (top-level FILES
   * only, no recursion into subdirectories): every entry this directory has
   * ever held — report*.md, run-summary*.json, and per-cell
   * *.json/*.grades.json — is a flat file directly inside it, never a nested
   * tree, so there is nothing to recurse into. That keeps this cheap even
   * though individual transcripts can run several hundred KB: it is at most
   * one read per pre-existing file, once, before the run starts.
   */
  function runsDirGuard(dir: string): { restore: () => void; createdEntries: () => string[] } {
    const existed = fs.existsSync(dir);
    const beforeNames = existed ? fs.readdirSync(dir) : [];
    const before = new Set(beforeNames);
    const beforeContent = new Map<string, Buffer>();
    for (const name of beforeNames) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) beforeContent.set(name, fs.readFileSync(full));
    }
    // The CLI mkdirs RECURSIVELY, so a first run creates the `harness-eval-runs`
    // parent as well as the dated child. Remember whether that existed too, or
    // the tests leave an empty directory behind in the workspace every time.
    const parent = path.dirname(dir);
    const parentExisted = fs.existsSync(parent);
    // Every test in this file that needs to know "what did THIS run write"
    // must go through this instead of `fs.readdirSync(dir)` directly — a raw
    // listing includes whatever the developer's real workspace already had in
    // it (see Defect 2: two tests hit exactly this before they were fixed).
    const createdEntries = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((e) => !before.has(e)) : []);
    // Writes `name` back to its snapshotted bytes ONLY if it is currently
    // missing or different. Measured while building this fix: writing back
    // unconditionally put the right BYTES back but still bumped mtime/ctime on
    // every pre-existing file on every guarded run, including the ~40+ real,
    // untouched multi-hundred-KB transcripts already in a developer's real
    // `harness-eval-runs` directory — needless I/O and a false "recently
    // modified" signal on files this run never went near. A real file this
    // test suite corrupted through repeated dry-fire cycles, caught and
    // described in the final report rather than silently re-corrupted further.
    const restoreFile = (name: string, content: Buffer) => {
      const full = path.join(dir, name);
      const current = fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full) : null;
      if (current === null || !current.equals(content)) fs.writeFileSync(full, content);
    };
    const restore = () => {
      if (fs.existsSync(dir)) {
        if (existed) {
          for (const entry of fs.readdirSync(dir)) {
            if (!before.has(entry)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
          }
          // Put back every pre-existing file's ORIGINAL bytes. A file the run
          // never touched round-trips to itself and restoreFile skips the
          // write entirely in that case (see its own comment for why that
          // matters, not just why it's allowed).
          for (const [name, content] of beforeContent) restoreFile(name, content);
        } else {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
        }
      } else if (existed) {
        // The run deleted the directory outright. Recreate it and restore
        // every pre-existing file, not just leave an empty directory where a
        // developer's real data used to be.
        fs.mkdirSync(dir, { recursive: true });
        for (const [name, content] of beforeContent) restoreFile(name, content);
      }
      if (!parentExisted && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    };
    return { restore, createdEntries };
  }

  /** Ask the CLI itself where it would write, so the test never re-implements
   *  resolveRunsDir's workspace walk. --dry-run spends nothing and needs no key. */
  function runsDirOf(stub: string, planFile: string): string {
    const { status, stdout, stderr } = runCliStubbed(stub, ['--plan', planFile, '--dry-run']);
    const line = stdout.split('\n').find((l) => l.trim().startsWith('Results: '));
    if (!line) throw new Error(`the CLI printed no "Results:" line (exit ${status}):\n${stdout}\n--- stderr ---\n${stderr}`);
    return line.trim().slice('Results: '.length);
  }

  it('a MID-MATRIX stop still writes the summary, names the cells that never ran, and never claims nothing was spent', () => {
    // THE REPRODUCTION, as the review described it: a guidance-vs-baseline plan.
    // expandPlan emits the baseline cell first; it runs and (in a real run) is
    // BILLED. Something then stops the matrix on the guidance cell. The operator
    // used to be told "NOTHING WAS SPENT", handed exit 2 (usage error), and
    // given no run-summary.json at all.
    //
    // WHAT CHANGED IN TASK 8c, and why the trigger is not the original one: the
    // original stopper was the guidance arm's UNRESOLVED file — runCell threw on
    // cell 2 because nothing had read `guide.md`. That can no longer happen
    // through the CLI: main() resolves every arm's file before the first cell
    // (and a missing one now exits 2 having spawned nothing — pinned by the
    // "refuses a plan whose instruction file cannot be read" test below), so
    // none of runCell's four throws is reachable GIVEN THE CURRENT CASE
    // REGISTRY. That qualifier is load-bearing and was added after review:
    // `validatePlan` checks case-id MEMBERSHIP only, never prompt CONTENT, so
    // the empty-prompt throw is unreachable purely because the registry holds
    // one case whose prompt is non-empty. Register a second case with an empty
    // prompt and it becomes CLI-reachable again — which would silently
    // invalidate the reason this test was repointed rather than deleted.
    // The mid-matrix stop is therefore driven by the other CLI-reachable
    // after-the-first-cell failure: the between-cells usage read coming back in
    // a shape fetchKeyUsage refuses to read as "$0 spent". Everything this test
    // asserts about the SUMMARY is unchanged; only the cause is. The
    // runOne-throws-mid-matrix path itself is still pinned directly, one level
    // down, by 'turns a runOne THROW into a stopReason instead of losing the
    // whole matrix'.
    const stub = fetchStub([0, null]);
    const plan = writePlanWithFiles({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'guided', file: 'guide.md' }],
      builds: [{ id: 'fake', dist: fastDist() }],
    }, { 'guide.md': '# Guidance\n\nBe brief.\n' });
    const runsDir = runsDirOf(stub, plan);
    const { restore } = runsDirGuard(runsDir);
    try {
      const { status, stdout, stderr } = runCliStubbed(
        stub,
        ['--plan', plan, '--yes', '--key-file', canaryKeyFile(), '--max-spend', '5'],
      );
      const all = `${stdout}${stderr}`;

      // 1. The lie is gone.
      expect(all).not.toContain('NOTHING WAS SPENT');
      expect(all).not.toContain('nothing was spent');
      // 2. The REAL error, in the words the failing code used — no guessed cause.
      expect(stderr).toContain('could not read OpenRouter usage');
      expect(stderr).toContain('did not report a numeric data.usage');
      // 3. Stopped early (3), not usage error (2).
      expect(status).toBe(3);
      // 4. The cells that never ran are named.
      expect(stderr).toContain('STOPPED EARLY');
      expect(stderr).toContain('harness-battery|guided|Claude Opus 5|fake|0');

      // 5. And the summary exists, with the same facts in machine-readable form.
      const summaryFile = path.join(runsDir, SUMMARY_FILENAME);
      expect(fs.existsSync(summaryFile)).toBe(true);
      const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
      expect(summary.stoppedEarly).toBe(true);
      expect(summary.stopReason).toContain('could not read OpenRouter usage');
      expect(summary.completed).toEqual(['harness-battery|baseline|Claude Opus 5|fake|0']);
      expect(summary.neverRan).toEqual(['harness-battery|guided|Claude Opus 5|fake|0']);
      // The stubbed catalog is empty, so nothing could be priced: NULL, never 0.
      // A 0 here is the silent zero the human-facing output already refuses.
      expect(summary.estimateUsd).toBeNull();
    } finally {
      restore();
    }
  }, 60_000);

  it('--max-spend actually reaches runMatrix — the flag stops a real run, not just an injected one', () => {
    // Fix pass 1 (2026-08-12 review, IMPORTANT 3). Delete `maxSpendUsd` from the
    // options object main() passes to runMatrix and every OTHER cap test still
    // passes; this one does not. Two cells, and the stub reports $1000 billed
    // after the first, so the cap must trip between them.
    const stub = fetchStub([0, 1000]);
    const plan = writePlan({
      ...BASE_PLAN,
      builds: [{ id: 'fake', dist: fastDist() }],
      repeats: 2,
    });
    const runsDir = runsDirOf(stub, plan);
    const { restore } = runsDirGuard(runsDir);
    try {
      const { status, stdout, stderr } = runCliStubbed(
        stub,
        ['--plan', plan, '--yes', '--key-file', canaryKeyFile(), '--max-spend', '1'],
      );
      // The trip itself is the evidence the flag arrived: only runMatrix's
      // `capped` branch reads usage, and only it can produce this message.
      expect(stderr).toContain('--max-spend $1.00 reached');
      expect(stderr).toContain('Stopped after 1 of 2 cells');
      expect(status).toBe(3);
      // Cell 1 ran to completion through a real worker subprocess...
      expect(stdout).toContain('[1/2] harness-battery|baseline|Claude Opus 5|fake|0');
      // ...and cell 2 never started.
      expect(stdout).not.toContain('[2/2]');
      expect(stderr).toContain('harness-battery|baseline|Claude Opus 5|fake|1');

      const summary = JSON.parse(fs.readFileSync(path.join(runsDir, SUMMARY_FILENAME), 'utf8'));
      expect(summary.completed).toEqual(['harness-battery|baseline|Claude Opus 5|fake|0']);
      expect(summary.neverRan).toEqual(['harness-battery|baseline|Claude Opus 5|fake|1']);
    } finally {
      restore();
    }
  }, 60_000);

  it('both arms reach the worker with their OWN instructions text', () => {
    // Task 8c, end to end through the real CLI: plan file → loadInstructionTexts
    // → runCell → the config on the worker's stdin → runCase's `instructions`
    // option. The fake dist echoes what runCase was handed, and the two per-cell
    // result files on disk are read back and compared. Delete `instructionsText`
    // from main()'s runOne and this fails two ways at once: the guided cell
    // throws (runCell's backstop), and the file that would have carried the text
    // is never written.
    const stub = fetchStub([0]);
    const plan = writePlanWithFiles({
      ...BASE_PLAN,
      instructions: [{ id: 'draft', file: 'draft.md' }, { id: 'tightened', file: 'tightened.md' }],
      builds: [{ id: 'fake', dist: echoingDist() }],
    }, {
      'draft.md': '# Draft\n\nALWAYS_SAY_BANANA.\n',
      'tightened.md': '# Tightened\n\nALWAYS_SAY_KUMQUAT.\n',
    });
    const runsDir = runsDirOf(stub, plan);
    const { restore, createdEntries } = runsDirGuard(runsDir);
    try {
      const { status, stderr } = runCliStubbed(stub, ['--plan', plan, '--yes', '--key-file', canaryKeyFile()]);
      expect(stderr).toBe('');
      expect(status).toBe(0);

      const seen = new Map<string, string | null>();
      // Defect 2 fix: scoped to entries THIS run created, not the whole real
      // directory listing — a developer's real runs dir can hold results whose
      // shape differs (no `.run.instructionsSeen`), which threw a TypeError here
      // before this was scoped.
      for (const name of createdEntries()) {
        if (name === SUMMARY_FILENAME || !name.endsWith('.json')) continue;
        const result = JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8'));
        seen.set(result.cellId, result.run.instructionsSeen);
      }
      const draft = seen.get('harness-battery|draft|Claude Opus 5|fake|0');
      const tightened = seen.get('harness-battery|tightened|Claude Opus 5|fake|0');
      expect(draft).toContain('ALWAYS_SAY_BANANA');
      expect(tightened).toContain('ALWAYS_SAY_KUMQUAT');
      // The comparison is only a comparison if the two differ — the assertion
      // that fails if both arms are handed one text, or both handed none.
      expect(draft).not.toBe(tightened);
    } finally {
      restore();
    }
  }, 60_000);

  /** A "dist under test" whose runCase returns a run complete enough to be
   *  GRADED: real metrics, a written answer, and a tool list that makes the
   *  battery's three checks land on three different states. */
  function gradableDist(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-gradable-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const dir = path.join(root, 'main/harness/eval');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-case.js'), `
export const runCase = async (c) => ({
  label: c.label, modelId: 'anthropic/claude-opus-5',
  review: 'ANSWER_MARKER — I read the loader before changing anything.',
  events: [], toolCalls: 1, asks: 0, stepGates: 0, fixtureRoot: '/tmp/fixture', outcome: 'complete',
  metrics: { wallClockMs: 1000, toolCalls: 1, asks: 0, stepGates: 0, thinkingEvents: 0,
    inputTokens: 1, outputTokens: 1, stopReasons: ['stop'], toolsUsed: ['Read'], repeats: [] },
});
`);
    fs.writeFileSync(path.join(dir, 'openrouter-factory.js'), 'export const makeOpenRouterFactory = () => async () => ({});\n');
    return root;
  }

  it('writes a report.md that shows all three check states, next to the transcripts', () => {
    // Task 11 end to end: the CLI runs a cell, writes its transcript, grades it
    // with THIS checkout's checks, and renders the report. The battery's three
    // checks land on three different states for this run (no events at all →
    // the fixture-jail check never runs; a non-empty answer → passed; no Grep in
    // toolsUsed → failed), so one report exercises the whole three-state rule
    // that a passing/failing pair would not.
    const stub = fetchStub([0]);
    const plan = writePlan({ ...BASE_PLAN, builds: [{ id: 'fake', dist: gradableDist() }] });
    const runsDir = runsDirOf(stub, plan);
    const { restore } = runsDirGuard(runsDir);
    try {
      const { status, stdout } = runCliStubbed(stub, ['--plan', plan, '--yes', '--key-file', canaryKeyFile()]);
      expect(status).toBe(0);
      expect(stdout).toContain('Report: ');

      const report = fs.readFileSync(path.join(runsDir, REPORT_FILENAME), 'utf8');
      expect(report).toContain('# Harness eval — unit-test-plan');
      // All three states, spelled differently — the invariant a green-vs-red
      // report would silently lose.
      expect(report).toContain('**PASSED**');
      expect(report).toContain('**FAILED**');
      expect(report).toContain('**NEVER RAN**');
      // The model's answer, verbatim, on the same page as the grades.
      expect(report).toContain('ANSWER_MARKER — I read the loader before changing anything.');
      // No judge in this plan: an empty grade column must SAY it was not graded.
      expect(report).toContain('NOT GRADED');
      // Fix pass 1 (2026-08-12 review, IMPORTANT 3), asserted on the REAL path
      // rather than on a hand-written CellResult: judgeRun's no-judge return
      // used to be indistinguishable from "a judge answered and returned
      // nothing", so this page said "the judge returned no grades for this run"
      // about a call that was never made. Scoped to the grades block — the
      // header and the limits paragraph both mention judging on every report.
      const grades = report.slice(report.indexOf('**Grades**'), report.indexOf('**The answer, verbatim**'));
      expect(grades).toMatch(/no judge was configured for this plan/);
      expect(grades).not.toMatch(/the judge returned no grades/);
      // IMPORTANT 4's other half, end to end: this run grades fine, so the
      // checks are recorded and the page must not claim the case declares none.
      expect(report).not.toMatch(/declares no mechanical checks/);
      // And the transcript it names is really there, under the Windows-safe name.
      const named = report.match(/transcript `([^`]+)`/);
      expect(named).not.toBeNull();
      expect(fs.existsSync(path.join(runsDir, named![1]))).toBe(true);
    } finally {
      restore();
    }
  }, 60_000);

  it('writes the transcript BEFORE grading, and a grading failure neither stops the run nor loses the conversation', () => {
    // fastDist's run has no `metrics`, so collectRunFacts throws inside the
    // grading step — a real failure of exactly the kind that must not cost a
    // paid conversation. Two cells, so "did the matrix keep going" is testable.
    //
    // THE ORDERING ASSERTION IS THE STDOUT ORDER: the transcript write prints
    // "ok → <file>.json" and the grading failure prints "not graded: …". Swap
    // the two steps in main()'s onResult and this test fails on the order,
    // which is the only observable difference a passing run has.
    const stub = fetchStub([0]);
    const plan = writePlan({ ...BASE_PLAN, builds: [{ id: 'fake', dist: fastDist() }], repeats: 2 });
    const runsDir = runsDirOf(stub, plan);
    const { restore, createdEntries } = runsDirGuard(runsDir);
    try {
      const { status, stdout } = runCliStubbed(stub, ['--plan', plan, '--yes', '--key-file', canaryKeyFile()]);
      expect(status).toBe(0);

      const wroteAt = stdout.indexOf('ok → ');
      const gradeFailedAt = stdout.indexOf('not graded: ');
      expect(wroteAt).toBeGreaterThan(-1);
      expect(gradeFailedAt).toBeGreaterThan(-1);
      expect(wroteAt).toBeLessThan(gradeFailedAt);

      // Both cells ran despite both failing to grade.
      expect(stdout).toContain('[2/2]');
      expect(stdout).toContain('2 of 2 cells ran');

      // The conversations survived...
      // Defect 2 fix: scoped to entries THIS run created — the raw directory
      // listing picked up 46 pre-existing real-run transcripts instead of the
      // 2 this test actually produced.
      const transcripts = createdEntries().filter((f) => f.endsWith('.json') && f !== SUMMARY_FILENAME);
      expect(transcripts).toHaveLength(2);
      // ...and the report carries the grading failure in the words of whatever
      // actually threw, not a hardcoded guess.
      const realError = stdout.slice(gradeFailedAt + 'not graded: '.length).split('\n')[0].trim();
      expect(realError.length).toBeGreaterThan(10);
      const report = fs.readFileSync(path.join(runsDir, REPORT_FILENAME), 'utf8');
      expect(report).toContain(realError);

      // Fix pass 1 (2026-08-12 review, IMPORTANT 4). collectRunFacts throws on
      // this run, and gradeCell used to assign `facts` BEFORE `checks` — so the
      // throw left `checks` undefined and this page printed "This case declares
      // no mechanical checks." for a case that declares three. Checks are
      // recorded first now, and the renderer no longer reads absent as empty.
      const checkBlock = report.slice(report.indexOf('**Checks**'), report.indexOf('**Grades**'));
      expect(checkBlock).not.toMatch(/declares no mechanical checks/);
      expect(checkBlock).toContain('stayed-inside-test-folder');
      expect(checkBlock).toContain('ended-with-an-answer');
      expect(checkBlock).toContain('called-tool:Grep');
    } finally {
      restore();
    }
  }, 60_000);

  it('prints the judge calls the estimate does not price, with the figure and not after it', () => {
    // Fix pass 1 (2026-08-12 review, IMPORTANT 1). printEstimate prices CELLS —
    // one model run each — and grading adds a second paid call per graded cell
    // that the printed total never counted. The operator answers "Spend up to
    // $X?" against that number, and without --max-spend it is the only bound
    // there is.
    const stub = fetchStub([0], [
      { id: 'x-ai/grok-4.5', pricing: { prompt: '0.0000005', completion: '0.000002' } },
    ]);
    const plan = writePlan({ ...BASE_PLAN, judge: 'x-ai/grok-4.5' });
    const { status, stdout } = runCliStubbed(stub, ['--plan', plan, '--dry-run']);
    expect(status).toBe(0);
    // Scoped to the estimate block: the plan grid above it names the judge too.
    const block = stdout.slice(stdout.indexOf('Estimated cost'));
    expect(block).toContain('NOT IN THE TOTAL');
    expect(block).toContain('x-ai/grok-4.5');
    expect(block).toContain('up to 1 more call');
    // The judge's own catalog rate — the one number here that is measured.
    expect(block).toContain('$0.50/M input');
    expect(block).toContain('$2.00/M output');
    // And no invented dollar total for the judging itself.
    expect(block).toMatch(/no dollar figure for it is invented/);
  }, 60_000);

  it('says plainly when a plan grades nothing, so the figure is known to be whole', () => {
    const stub = fetchStub([0]);
    const { status, stdout } = runCliStubbed(stub, ['--plan', writePlan(BASE_PLAN), '--dry-run']);
    expect(status).toBe(0);
    const block = stdout.slice(stdout.indexOf('Estimated cost'));
    expect(block).toMatch(/names no judge/);
    expect(block).not.toContain('NOT IN THE TOTAL');
  }, 60_000);

  it('refuses a plan whose instruction file cannot be read, before spawning or spending anything', () => {
    // The failure this task exists to prevent is discovering a typo'd path after
    // half a matrix has been billed. Two cells here; neither may start.
    const stub = fetchStub([0]);
    const plan = writePlanWithFiles({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'guided', file: 'instructions/guide.md' }],
      builds: [{ id: 'fake', dist: fastDist() }],
    }, {});
    const { status, stdout, stderr } = runCliStubbed(stub, ['--plan', plan, '--yes', '--key-file', canaryKeyFile()]);
    // Usage/config error (2), not "stopped early" (3): nothing ran.
    expect(status).toBe(2);
    expect(stderr).toContain('instruction arm "guided"');
    expect(stderr).toContain(path.join(path.dirname(plan), 'instructions/guide.md'));
    expect(stderr).toContain('ENOENT');
    // It stopped BEFORE the grid, the estimate and the run — no cell header, no
    // runs directory line, so no result file and no summary can exist either.
    expect(stdout).not.toContain('[1/2]');
    expect(stdout).not.toContain('Running 2 cells');
  }, 60_000);

  it('--dry-run validates the instruction files too, with no key anywhere', () => {
    // A dry run's whole job is "tell me what this would do". Reporting a clean
    // grid and a dollar figure for a plan whose instruction files do not exist
    // would be the tool answering the one question it was asked, wrongly.
    const stub = fetchStub([0]);
    const plan = writePlanWithFiles({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'guided', file: 'guide.md' }],
    }, {});
    const { status, stdout, stderr } = runCliStubbed(stub, ['--plan', plan, '--dry-run']);
    expect(status).toBe(2);
    expect(stderr).toContain('could not be read');
    expect(stderr).toContain('ENOENT');
    // And it did NOT reach the "this would have worked" ending.
    expect(stdout).not.toContain('nothing was spawned and nothing was spent');
  }, 60_000);

  it('--dry-run still succeeds, with no key anywhere, when the instruction files are real', () => {
    const stub = fetchStub([0]);
    const plan = writePlanWithFiles({
      ...BASE_PLAN,
      instructions: [{ id: 'draft', file: 'draft.md' }, { id: 'tightened', file: 'tightened.md' }],
    }, { 'draft.md': '# Draft\n\nSay banana.\n', 'tightened.md': '# Tightened\n\nSay kumquat.\n' });
    const { status, stdout } = runCliStubbed(stub, ['--plan', plan, '--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toContain('(dry run: nothing was spawned and nothing was spent)');
  }, 60_000);

  it('restores a pre-existing file the run OVERWRITES, not just entries it created', () => {
    // Defect 3 (coordinator-flagged, 2026-08-13): running this suite against
    // the REAL workspace replaced a real, committed experiment report —
    // docs/active/investigations/harness-eval-runs/2026-08-13/report.md — with
    // this test file's own unit-test-plan output. Root cause: the old guard
    // snapshotted only which NAMES existed before the run, and on restore
    // deleted whatever wasn't in that set. A name that existed before AND
    // got overwritten in place round-tripped through that check untouched —
    // it was never new, so nothing flagged it for cleanup, and its new
    // (wrong) content just stayed.
    //
    // Reproduced directly, without depending on any other test's plan name:
    // plant a sentinel at the EXACT path this run's own report will land on
    // (BASE_PLAN's name is fixed across this file — see REPORT_FILENAME),
    // with content the CLI could not possibly produce, run the real CLI
    // against it, and check restore() puts the sentinel back byte-for-byte —
    // not just that the path still exists.
    const stub = fetchStub([0]);
    const plan = writePlan({ ...BASE_PLAN, builds: [{ id: 'fake', dist: gradableDist() }] });
    const runsDir = runsDirOf(stub, plan);
    fs.mkdirSync(runsDir, { recursive: true });
    const sentinelPath = path.join(runsDir, REPORT_FILENAME);
    const sentinelContent = 'SENTINEL — a real developer report that must survive this test run\n';
    // Remember what was ACTUALLY there before this test plants its sentinel —
    // this test is itself a guest in the real workspace, exactly like the CLI
    // run it is testing. Restoring only to "the sentinel" and stopping there
    // would leave the sentinel behind as a permanent fixture at this path,
    // which every LATER run of this very test (and every other test that
    // writes REPORT_FILENAME) would then treat as legitimately pre-existing —
    // this test would quietly start protecting its own leftover instead of a
    // developer's real file.
    const trulyExisted = fs.existsSync(sentinelPath);
    const trulyOriginal = trulyExisted ? fs.readFileSync(sentinelPath) : null;
    fs.writeFileSync(sentinelPath, sentinelContent);
    const { restore } = runsDirGuard(runsDir);
    try {
      try {
        const { status } = runCliStubbed(stub, ['--plan', plan, '--yes', '--key-file', canaryKeyFile()]);
        expect(status).toBe(0);
        // Prove the reproduction is real: the CLI genuinely overwrote the
        // sentinel (this is the clobber Defect 3 is about), so restoring it is
        // not a no-op that would pass even with no restore logic at all.
        expect(fs.readFileSync(sentinelPath, 'utf8')).not.toBe(sentinelContent);
      } finally {
        restore();
      }
      // The sentinel is back, byte for byte — checked AFTER restore(), and
      // outside the inner try/finally so a failure here is not masked by
      // `finally` having already run.
      expect(fs.readFileSync(sentinelPath, 'utf8')).toBe(sentinelContent);
    } finally {
      // Put the real workspace back exactly as this test found it, regardless
      // of whether any assertion above passed — this outer `finally` runs no
      // matter which expect() (if any) threw.
      if (trulyExisted) fs.writeFileSync(sentinelPath, trulyOriginal!);
      else fs.rmSync(sentinelPath, { force: true });
    }
  }, 60_000);
});

describe('fetchKeyUsage never reports an unreadable answer as zero spend', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('returns the billed dollar figure', async () => {
    const { fetchKeyUsage } = await import('../test-engine/harness-eval.mjs');
    globalThis.fetch = (async () => ({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ data: { usage: 12.5 } }),
    })) as unknown as typeof fetch;
    expect(await fetchKeyUsage('sk-fake')).toBe(12.5);
  });

  it('throws when data.usage is not a number, naming what came back', async () => {
    const { fetchKeyUsage } = await import('../test-engine/harness-eval.mjs');
    // A changed API shape must not read as "$0 spent", which would make the cap
    // silently un-trippable for the whole run.
    globalThis.fetch = (async () => ({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ data: { usage: null } }),
    })) as unknown as typeof fetch;
    await expect(fetchKeyUsage('sk-fake')).rejects.toThrow(/did not report a numeric data\.usage \(got null\)/);
  });

  it('reports the server status and body, and redacts the key from it', async () => {
    const { fetchKeyUsage } = await import('../test-engine/harness-eval.mjs');
    globalThis.fetch = (async () => ({
      ok: false, status: 401, statusText: 'Unauthorized',
      text: async () => 'no such key sk-canary-123',
    })) as unknown as typeof fetch;
    await expect(fetchKeyUsage('sk-canary-123')).rejects.toThrow(/HTTP 401 Unauthorized/);
    await expect(fetchKeyUsage('sk-canary-123')).rejects.toThrow(/\[REDACTED credential\]/);
  });
});

describe('a wedged worker is killed and labelled, not left to hang', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  /** A minimal "dist under test" whose runCase() never resolves. The worker
   *  imports run-case.js / openrouter-factory.js from the cell's dist, so this
   *  reproduces a genuinely wedged model run — a provider that accepts the
   *  connection and never streams — without a network or a key. */
  function hangingDist(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-hang-'));
    // Nearest package.json decides CJS-vs-ESM for the .js files below.
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const dir = path.join(root, 'main/harness/eval');
    fs.mkdirSync(dir, { recursive: true });
    // The setInterval is load-bearing: a promise that merely never resolves
    // leaves Node's event loop EMPTY, so the worker exits 13 with "Detected
    // unsettled top-level await" — measured, and a hang is exactly what this
    // test needs to reproduce. A live handle is also what a real wedge looks
    // like (an open socket waiting on bytes that never come).
    fs.writeFileSync(
      path.join(dir, 'run-case.js'),
      'export const runCase = () => new Promise(() => { setInterval(() => {}, 1000); });\n',
    );
    fs.writeFileSync(path.join(dir, 'openrouter-factory.js'), 'export const makeOpenRouterFactory = () => async () => ({});\n');
    return root;
  }

  it('kills a worker that outlives the timeout and returns a labelled result', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    const result = await runCell({
      id: 'harness-battery|baseline|Claude Opus 5|current|0',
      caseId: 'harness-battery',
      instructionsId: 'baseline',
      instructionsFile: null,
      model: 'Claude Opus 5',
      buildId: 'current',
      dist: hangingDist(),
      repeat: 0,
    }, { apiKey: 'sk-fake', timeoutMs: 2_000 });
    // The point of the fix: a result, not a hang, and one that says what happened.
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('exceeded the per-cell timeout of 2s');
    // Honest about what it cost: the tokens are gone either way.
    expect(result.error).toContain('already consumed are spent');
    expect(result.error).toContain('--timeout');
    // NOT reported as a signal death — the caller stopped it on purpose.
    expect(result.error).not.toContain('was killed by SIGTERM');
  }, 30_000);

  it('defaults to a backstop well above run-case.ts\'s own 20-minute deadline', async () => {
    const { DEFAULT_CELL_TIMEOUT_MS } = await import('../test-engine/harness-eval.mjs');
    // Setting it BELOW the in-run deadline would start killing runs that were
    // going to finish — paying for them and throwing the result away.
    expect(DEFAULT_CELL_TIMEOUT_MS).toBeGreaterThan(1_200_000);
  });
});
