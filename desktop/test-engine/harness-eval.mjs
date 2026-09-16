#!/usr/bin/env node
// Orchestrator for the harness evaluator.
//
//   node test-engine/harness-eval.mjs --plan <file> --dry-run          # free, no key
//   node test-engine/harness-eval.mjs --plan <file> --key-file <path> --max-spend 5
//
// Flags: --plan <file> (required) · --key-file <path> (required to spend)
//        --dry-run · --yes · --max-spend <usd> · --timeout <seconds>
//        --only <cellId> · --repeats <n>
// Exit codes: 0 every cell ran · 2 usage/config error · 3 stopped early (cap).
//
// THIS TOOL SPENDS REAL MONEY, so the order of operations below is the point:
// load and validate the plan, read every instruction arm's file off disk (a
// missing one stops the run here, not halfway through a paid matrix), expand
// it into cells, print the grid, price it
// from OpenRouter's public catalog, print the dollar figure WITH everything
// that could make it wrong, and only then ask for confirmation and read the
// credential. --dry-run stops after the estimate and needs no key anywhere on
// the machine. Between cells, --max-spend re-reads what OpenRouter has actually
// billed and stops the run if the cap is passed — because the failure that
// costs the most (a model that loops) is exactly the one no past measurement
// predicts.
//
// THE CREDENTIAL ARRIVES BY FILE, NEVER BY ENVIRONMENT VARIABLE, and this
// process REFUSES to run if OPENROUTER_API_KEY is set. See loadApiKey() for the
// mechanism and the four rounds of measurement behind it.
//
// INTEGRATION (Task 8 Step 0, 2026-08-12). This file used to define its own
// local `loadPlan`/`expandPlan`, because matrix.ts and cases/ were sibling
// deliverables in other worktrees and this one was forbidden from importing
// them. All three merged cleanly — different files — and every test stayed
// green, which is exactly the hazard: there were then TWO plan validators that
// already disagreed (the local one never cross-checked case ids or roster
// labels, which is `validatePlan`'s whole job), and `cellFilename` — the
// Windows-safe filename builder that cost a full review round — was referenced
// zero times here. Both local copies are now DELETED and replaced by the real
// modules; nothing below re-implements any part of them.
//
// WHY every grader module is loaded through `graderRoot()` and never through
// `cell.dist`: matrix.js, cases/index.js and battery.js are GRADER-side. The
// harness under test varies per cell; the graders must not. Loading a grader
// from the cell's dist would mean a branch-vs-master comparison silently
// compares two different *graders* as well as two harnesses — a diff nobody
// can interpret, and not a crash. `src/main/harness/eval/paths.ts` exists for
// exactly this: `graderRoot()` ignores its argument by construction and always
// answers this checkout's own dist; `harnessRoot(cell)` answers the cell's.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, execFileSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const WORKER = path.join(HERE, 'harness-eval-worker.mjs');
/** The model roster — the same file review-harness.mjs runs its battery from,
 *  so "which models exist" has one answer for both CLIs. Its LABELS are what a
 *  plan's `models` array names (matrix.ts's EvalPlan documents them as roster
 *  labels), and the OpenRouter model id is looked up from it in runCell. */
const ROSTER_FILE = path.join(HERE, 'review-roster.json');

/** paths.js is the one module that has to be located by hand: it is the module
 *  that DEFINES where graders come from, so it cannot be located by itself.
 *  Everything after it goes through graderRoot(). */
const PATHS_BOOTSTRAP = path.join(DESKTOP, 'dist/main/harness/eval/paths.js');

let gradersPromise = null;

/** Load every grader-side module this orchestrator needs, once.
 *
 *  All four resolve through `graderRoot()` — this checkout's own `dist` —
 *  which is why the argument below is a literal reminder rather than a cell:
 *  graderRoot ignores it by construction (see paths.ts's `_cell`), and passing
 *  something cell-derived here would only invite a future edit to start
 *  honouring it.
 *
 *  THROWS with the real module-resolution error if `dist/` has not been built,
 *  plus the one-line remedy (`npm run build:main`) appended to it — see the
 *  catch below. The tests build on demand instead. */
function loadGraders() {
  if (!gradersPromise) {
    gradersPromise = (async () => {
      try {
        return await importGraders();
      } catch (err) {
        // Fix pass 1 (2026-08-12 review, MINOR 2): the graders moved into
        // dist/ in Task 8 Step 0, so an unbuilt checkout now fails EVERY
        // invocation including --dry-run — a prerequisite that did not exist
        // before. Node's own message ("Cannot find module .../dist/...") is
        // accurate but names no remedy. The real error is kept verbatim and
        // the remedy is APPENDED; the branch is narrowed to the one error code
        // that actually means "not built", so no other failure gets a guessed
        // cause attached to it.
        if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
          throw new Error(
            `${err.message}\n\n`
            + 'harness-eval: the graders (matrix, the case registry, the roster loader) are loaded from this '
            + `checkout's own compiled output, which does not look built. Run \`npm run build:main\` in `
            + `${DESKTOP} first, then re-run this command.`,
          );
        }
        throw err;
      }
    })();
  }
  return gradersPromise;
}

/** The actual grader loads — split out only so loadGraders() can wrap them in
 *  one try/catch without indenting the whole body. */
async function importGraders() {
  // WHY pathToFileURL: Node's ESM loader only accepts file:// URLs for absolute
  // specifiers — on Windows `import('D:\a\...')` throws
  // ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'd:'"), which is what
  // took down all 78 orchestrator tests on Windows CI. The URL still resolves
  // to the same CommonJS file, so the module-cache identity the orchestrator
  // test measures (require() vs import() of one dist file) is unchanged.
  const { graderRoot, harnessRoot } = await import(pathToFileURL(PATHS_BOOTSTRAP).href);
  const root = graderRoot({ dist: '(ignored — graderRoot never reads its argument)' });
  const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  const [matrix, cases, battery, estimate, judge, report, runFacts, factory] = await Promise.all([
    load('main/harness/eval/matrix.js'),
    load('main/harness/eval/cases/index.js'),
    load('main/harness/eval/battery.js'),
    // Grader-side too: the estimate is what a human agrees to before anything
    // spawns, so it must come from THIS checkout, never from the build under
    // test. A branch that changed its own price table would otherwise quote
    // itself.
    load('main/harness/eval/estimate.js'),
    // Task 11: the grading and reporting half. Every one of these is
    // grader-side by the same argument as the estimate — a branch-vs-master
    // comparison that graded each build with ITS OWN judge, ran ITS OWN
    // checks, or rendered ITS OWN report would produce a diff nobody could
    // attribute to the harness. The judge's model factory is grader-side too:
    // it is the grader's own provider call, not the harness's.
    load('main/harness/eval/judge.js'),
    load('main/harness/eval/report.js'),
    load('main/harness/eval/run-facts.js'),
    load('main/harness/eval/openrouter-factory.js'),
  ]);
  return {
    graderRoot,
    harnessRoot,
    validatePlan: matrix.validatePlan,
    expandPlan: matrix.expandPlan,
    cellFilename: matrix.cellFilename,
    // Defect 1 fix: shares matrix.ts's sanitizing step (see planFilenameSlug's
    // own comment) so report.md/run-summary.json can be named after the plan
    // without a second, subtly different sanitizer living here.
    planFilenameSlug: matrix.planFilenameSlug,
    allCaseIds: cases.allCaseIds,
    getCase: cases.getCase,
    roster: battery.loadRoster(ROSTER_FILE),
    estimateCells: estimate.estimateCells,
    parsePriceCatalog: estimate.parsePriceCatalog,
    formatUsd: estimate.formatUsd,
    // The judge's share of the bill, which the per-cell figure does not include
    // (fix pass 1, 2026-08-12 review, IMPORTANT 1).
    judgeCostLines: estimate.judgeCostLines,
    judgeRun: judge.judgeRun,
    renderReport: report.renderReport,
    collectRunFacts: runFacts.collectRunFacts,
    makeOpenRouterFactory: factory.makeOpenRouterFactory,
  };
}

/** Which commit produced the harness that ran this matrix, and whether the
 *  worktree was dirty. Copied in shape from review-harness.mjs's
 *  resolveBuildSha and for the identical reason: report.ts is PURE and cannot
 *  shell out to git itself, so this file resolves the build and hands it in as
 *  data. Every git failure (no git binary, not a repo) degrades to 'unknown'
 *  rather than aborting a paid run over metadata. */
function resolveBuildSha(cwd) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().length > 0;
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
}

// -- flag parsing -----------------------------------------------------------

function parseArgs(argv) {
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const value = argv[i + 1];
    // Fix (review round 2, MINOR 2): a flag's value used to be "whatever the
    // next argv element is", so `--plan --dry-run` set planPath = "--dry-run"
    // and then failed with `could not read plan "--dry-run"` — an error that
    // names a FLAG as though the user had typed it as a filename, hiding the
    // real mistake (the flag was given no value) behind a confusing one.
    if (value === undefined) {
      throw new Error(`harness-eval: ${name} needs a value, but nothing followed it.`);
    }
    if (value.startsWith('--')) {
      throw new Error(`harness-eval: ${name} needs a value, but the next argument is the flag "${value}" — ${name} was given no value.`);
    }
    return value;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    confirmed: argv.includes('--yes'),
    planPath: flagValue('--plan'),
    maxSpend: flagValue('--max-spend'),
    only: flagValue('--only'),
    repeatsFlag: flagValue('--repeats'),
    // The credential's ONLY channel. See loadApiKey() for why it is a file path
    // and not an environment variable.
    keyFile: flagValue('--key-file'),
    // Per-cell wall-clock backstop, in seconds. See DEFAULT_CELL_TIMEOUT_MS.
    timeoutFlag: flagValue('--timeout'),
  };
}

// -- the credential -----------------------------------------------------------

/**
 * Read the OpenRouter key from a FILE, and refuse to run if it is also sitting
 * in this process's environment.
 *
 * WHY A FILE AND NOT AN ENVIRONMENT VARIABLE — this is the whole point, and it
 * is the fourth round of one bug on this branch.
 *
 * The model under test drives a Bash tool that spawns children with the
 * environment it was given, so those children are same-uid DESCENDANTS of this
 * orchestrator. Everything they print is captured into `run.events` and written
 * to a transcript on disk. A channel of THIS process that a descendant can read
 * is therefore a channel that writes the key into a file.
 *
 * `delete process.env.OPENROUTER_API_KEY` does NOT close that channel, and this
 * is the part that fooled three earlier rounds: `delete` compiles to `unsetenv`,
 * which edits the in-heap environ array. It never rewrites the
 * `mm->env_start..env_end` region the kernel exposes at `/proc/<pid>/environ`
 * and `ps eww` reads. So if this process is started as
 * `OPENROUTER_API_KEY=sk-... node test-engine/harness-eval.mjs`, the key stays
 * readable at `/proc/<this pid>/environ` for the process's entire lifetime, no
 * matter what we do to `process.env` afterwards — and a Bash-tool grandchild can
 * walk `ppid` links up to us and read it. Measured on the real three-process
 * topology: worker environ CLEAN, ORCHESTRATOR environ LEAKED, own inherited
 * env CLEAN. The obvious probes (`env`, `printenv`, `ps -eo args`,
 * `/proc/self/cmdline`) all read clean, which is exactly why it survived.
 *
 * A file NARROWS it because the key is only ever in this process's heap, which
 * has no `/proc` mirror the way `environ` and `cmdline` do. Fix pass 1
 * (2026-08-12 review, MINOR): this used to claim `/proc/<pid>/mem` is unreadable
 * "under any default ptrace_scope", which is more than was measured. What was
 * measured is this machine, `/proc/sys/kernel/yama/ptrace_scope` = 1, where a
 * same-uid non-ancestor process cannot attach and the read fails. Under
 * `ptrace_scope=0` — the default wherever Yama is not compiled in or not enabled
 * — a same-uid process CAN attach and read the heap, so this is a much narrower
 * channel than an environment variable, not a closed one.
 *
 * The FILE PATH is in argv, which is public — a path is
 * not a secret. (An interactive prompt would work too; a file was chosen because
 * a matrix run is long and unattended, and a prompt would make `--yes` mean
 * "confirm the spend" in one place and "there is a human at the keyboard" in
 * another.)
 *
 * WHY it REFUSES rather than warning when the env var is present: there is no
 * fix available at this point in the process's life — the leak already happened
 * at exec. Warning and continuing would spend real money into a known-leaking
 * run. The remedy is in the message.
 *
 * @param {{ keyFile?: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {string} the trimmed key
 */
function loadApiKey({ keyFile, env = process.env } = {}) {
  if (env.OPENROUTER_API_KEY) {
    throw new Error(
      'harness-eval: OPENROUTER_API_KEY is set in this process\'s environment — refusing to run.\n'
      + '  The model under test drives a Bash tool whose subprocesses are descendants of this process, and a\n'
      + '  descendant can read /proc/<pid>/environ and `ps eww` for every ancestor. That region is written once at\n'
      + '  exec and is NOT rewritten by `delete process.env.X` (unsetenv only edits the in-heap copy), so the key is\n'
      + '  already readable and nothing this program does can un-leak it.\n'
      // Fix pass 1 (2026-08-12 review, MINOR): the remedy used to be `unset
      // OPENROUTER_API_KEY`, which destroys the variable for the operator's whole
      // shell — everything else he runs in that terminal loses the key. `env -u`
      // drops it for THIS command only, and is what the verification for this
      // branch actually used.
      + '  Fix: put the key in a file and pass --key-file, and drop the variable for THIS command only:\n'
      + '    printf %s "sk-or-v1-..." > ~/.openrouter-key && chmod 600 ~/.openrouter-key\n'
      + '    env -u OPENROUTER_API_KEY node test-engine/harness-eval.mjs --plan <file> --key-file ~/.openrouter-key',
    );
  }
  if (!keyFile) {
    throw new Error(
      'harness-eval: --key-file <path> is required for a run that spends money (--dry-run needs no key at all).\n'
      + '  The file must contain the OpenRouter key and nothing else. It is read as a file rather than an\n'
      + '  environment variable because an inherited env var is readable at /proc/<pid>/environ by every\n'
      + '  descendant of this process — including the Bash tool the model under test drives.',
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(keyFile, 'utf8');
  } catch (err) {
    // The real errno message ("ENOENT: no such file or directory, open '...'"),
    // never a guess at which of the several possible causes it was.
    throw new Error(`harness-eval: could not read --key-file "${keyFile}": ${err.message}`);
  }
  const key = raw.trim();
  if (!key) {
    throw new Error(`harness-eval: --key-file "${keyFile}" is empty (or only whitespace) — there is no key in it.`);
  }
  if (/\s/.test(key)) {
    // A file holding `export OPENROUTER_API_KEY=sk-...` would otherwise be sent
    // to OpenRouter verbatim and come back as an opaque 401.
    throw new Error(
      `harness-eval: --key-file "${keyFile}" contains whitespace inside the key, so it is not a bare key. `
      + 'The file must hold the key alone — not a shell `export` line, not JSON.',
    );
  }
  // Advisory, not fatal: a group/other-readable key file is a different (and
  // milder) exposure than the environ one, and it is the operator's call.
  try {
    // Fix pass 1 (2026-08-12 review, MINOR): ONE stat. This used to call
    // statSync twice — once for the test, once to print the mode — so the
    // warning could in principle describe a mode different from the one that
    // triggered it, and it did twice the filesystem work for one message.
    const mode = fs.statSync(keyFile).mode;
    if ((mode & 0o077) && process.platform !== 'win32') {
      console.error(`harness-eval: warning — ${keyFile} is readable by other users (mode ${(mode & 0o777).toString(8)}). chmod 600 it.`);
    }
  } catch { /* stat failing is not a reason to refuse a key we already read */ }
  return key;
}

/**
 * Overwrite this process's argv region so `/proc/<pid>/cmdline` and `ps` stop
 * naming the key FILE.
 *
 * WHY: --key-file puts a PATH in argv. A path is not a secret, but the file it
 * names is readable by any same-uid process, and the model's Bash tool runs as
 * the same uid — so a descendant that read `/proc/<ppid>/cmdline` learned
 * exactly where to `cat`. Measured with the leak detector
 * (tests/harness-eval-key-leak.test.ts) before this existed: the path was there,
 * and reading it returned the key.
 *
 * HOW: on Linux, libuv implements `process.title =` by writing into the original
 * argv memory — the same bytes the kernel exposes as `/proc/<pid>/cmdline` — and
 * clears the remainder. Measured: a cmdline of
 * `node t.mjs --key-file /home/destin/secret --plan foo` became `harness-eval`
 * with the rest blanked, and `/proc/<pid>/environ` was untouched.
 *
 * WHAT THIS IS NOT: it does not make the key file unreadable. A model that
 * learns the path another way can still read it — that residual is inherent to a
 * file-based credential and is pinned by a test rather than hidden. This only
 * removes the signpost, which is the part that was free to remove.
 *
 * Best-effort by design: on a platform where this is a no-op (or throws), the
 * fallback is the pre-existing behaviour, not a failed run.
 */
function scrubProcessTitle(label) {
  try {
    process.title = label;
  } catch { /* observability nicety, never a reason to fail a run */ }
}

// -- plan loading (validation + expansion both live in matrix.ts) ------------

/**
 * @typedef {import('../src/main/harness/eval/matrix').Cell} Cell
 */

/** The default build arm when a plan names none: this checkout's own current
 *  build. Same physical path graderRoot() resolves to (own checkout), but a
 *  DIFFERENT role — this is the harness UNDER TEST for the 'current' arm,
 *  resolved once here and then threaded through exactly like any other
 *  --dist. It is never treated as "the grader root" anywhere downstream.
 *
 *  WHY this is injected here and not defaulted inside matrix.ts: matrix.ts is a
 *  pure module with no filesystem access, so the only default it could offer
 *  was the RELATIVE `dist: '.'` — which a worker resolves against whatever cwd
 *  it happens to inherit, i.e. "the harness under test" would be decided by
 *  where you were standing when you typed the command. Fix pass 1 (2026-08-12
 *  review, IMPORTANT 2) DELETED that default rather than patching around it:
 *  `expandPlan` now throws if a plan reaches it with no builds, and this
 *  constant — resolved to an absolute path once, here, by the one layer that
 *  knows where the plan file lives — is what a plan file that names no builds
 *  gets instead. */
const CURRENT_BUILD = { id: 'current', dist: path.join(DESKTOP, 'dist') };

/** True only for a whole number >= 1. Used for the `--repeats` FLAG only —
 *  the plan file's own `repeats` field is validatePlan's business. Kept
 *  separate on purpose: a user who typed `--repeats abc` needs to be told the
 *  flag is wrong, not that the plan file is. Before this check existed,
 *  `--repeats abc` printed "Repeats: NaN" and 0 cells while exiting 0. */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

/** Read a plan file and hand it to the REAL validator.
 *
 *  Everything this function does is I/O and error framing: read, JSON.parse,
 *  then `validatePlan(plan, knownCaseIds, knownModels)` from matrix.js. There
 *  is deliberately no shape-checking here — a second validator is what Task 8
 *  Step 0 existed to remove, and the local one it replaced never cross-checked
 *  case ids or roster labels at all, so a plan naming a case that does not
 *  exist expanded happily and would have been billed as a real matrix.
 *
 *  `knownCaseIds` comes from the case registry (cases/index.js `allCaseIds()`)
 *  and `knownModels` from the roster's LABELS — both loaded from this
 *  checkout's own dist via graderRoot(), never from a cell's.
 *
 *  THROWS rather than calling process.exit so the validation is reachable from
 *  a test (main() below turns the throw into the same exit code 2 and the same
 *  stderr text a user saw before). The plan's path is prepended to
 *  validatePlan's message because validatePlan takes a parsed object and has
 *  no idea which file it came from — and "which file" is the first thing a
 *  user with several plans needs.
 */
async function readPlanFile(filePath) {
  const { validatePlan, allCaseIds, roster } = await loadGraders();
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`harness-eval: could not read plan "${filePath}": ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`harness-eval: plan "${filePath}" is not valid JSON: ${err.message}`);
  }
  let plan;
  try {
    plan = validatePlan(parsed, allCaseIds(), roster.map((entry) => entry.label));
  } catch (err) {
    throw new Error(`harness-eval: plan "${filePath}" is invalid: ${err.message}`);
  }

  // Build dists are resolved to absolute paths HERE, at the one boundary that
  // knows where the plan file lives. A relative `dist` in a hand-written plan
  // would otherwise be resolved by the worker against whatever cwd it inherits
  // — so the same plan would test a different harness depending on where you
  // stood when you ran it. Relative to the plan file, not to cwd, because that
  // is the directory the author was thinking in when they typed the path.
  const planDir = path.dirname(path.resolve(filePath));
  return {
    ...plan,
    builds: plan.builds && plan.builds.length
      ? plan.builds.map((build) => ({ ...build, dist: path.resolve(planDir, build.dist) }))
      : [CURRENT_BUILD],
  };
}

/** Read every instruction arm's file off disk, keyed by arm id (Task 8c).
 *
 *  THIS IS THE INSTRUCTIONS AXIS. The plan format has always defined
 *  `instructions: [{ id, file }]`, `expandPlan` has always copied `file` onto
 *  every cell, and `runCell` has always refused a cell whose arm declared a
 *  file nobody read — but nothing ever read one, so every guidance arm either
 *  refused to run or would have run byte-identically to the baseline. This
 *  function is the missing half: plan file → text → `runCell`'s
 *  `instructionsText` → the worker's config → `runCase`'s `instructions`
 *  option → a real CLAUDE.md in the disposable fixture → the
 *  `<project-instructions source="CLAUDE.md">` block of the system prompt the
 *  model is actually given.
 *
 *  RESOLVED AGAINST THE PLAN FILE'S OWN DIRECTORY, never the cwd — the same
 *  base `readPlanFile` resolves `build.dist` against, and for the same reason:
 *  a plan referenced from somewhere else (`node ... --plan ../other/plan.json`)
 *  must still find its own siblings, and "which instructions did that arm
 *  actually get" must not depend on where the operator was standing.
 *
 *  EVERY FAILURE HERE HAPPENS BEFORE ANY SPEND. main() calls this immediately
 *  after the plan is validated — before the grid, before the estimate, before
 *  the --dry-run return, and long before a key is read — because discovering a
 *  typo'd path after half a matrix has been billed is the exact failure this
 *  tool exists to prevent. The I/O error is passed through verbatim (ENOENT vs
 *  EACCES vs EISDIR are three different mistakes with three different fixes);
 *  nothing here guesses a cause.
 *
 *  @param {{ instructions: { id: string, file: string | null }[] }} plan
 *  @param {string} planPath  the plan file, as given on the command line
 *  @returns {Map<string, string | null>} arm id → its text (null = baseline arm)
 */
function loadInstructionTexts(plan, planPath) {
  const planDir = path.dirname(path.resolve(planPath));
  const byArmId = new Map();
  // normalized text → the FIRST arm id that produced it, so a collision can
  // name both halves of the pair rather than just the second one.
  const firstArmWithText = new Map();

  for (const arm of plan.instructions) {
    // `null` is the deliberate no-instructions baseline: nothing to read, and
    // runCase writes no CLAUDE.md at all for it.
    if (arm.file === null || arm.file === undefined) {
      byArmId.set(arm.id, null);
      continue;
    }
    const abs = path.resolve(planDir, arm.file);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      throw new Error(
        `harness-eval: instruction arm "${arm.id}" declares "${arm.file}", which could not be read at ${abs}: `
        + `${err.message}\n`
        + '  Instruction paths are resolved against the plan file\'s own directory, not the working directory.\n'
        + '  Refusing to start: nothing has been spawned and nothing has been spent.',
      );
    }
    // A declared file that holds nothing is the SAME condition as `file: null`
    // — runCase writes no usable CLAUDE.md either way — so the arm is a second
    // copy of the baseline wearing a different name. Two consequences if this
    // is let through: `runCell`'s guard reads `''` as falsy and refuses the
    // cell mid-matrix with a message about text "not being supplied" (which is
    // not what went wrong), and if it ever stopped refusing, the operator pays
    // for a comparison between two identical arms. Caught here, with the real
    // reason, before either can happen.
    if (!text.trim()) {
      throw new Error(
        `harness-eval: instruction arm "${arm.id}" declares "${arm.file}" (${abs}), but that file is empty `
        + `(${text.length} character(s), all whitespace). An arm with no instructions in it is the same condition as `
        + '"file": null — the no-instructions baseline — so running it would bill a comparison between two arms that '
        + 'are in fact identical. Either point the arm at the real file, or delete the arm and let the baseline be the baseline.',
      );
    }
    // The axis has to actually DIFFER. `validatePlan` already rejects two
    // `"file": null` arms for exactly this reason, but it only sees the plan's
    // paths — two different paths whose CONTENTS are the same (a copy-paste, a
    // file that was never edited after being duplicated) look fine to it and
    // are indistinguishable from a real comparison in the report. Compared on
    // the trimmed text so a stray trailing newline is not mistaken for a
    // difference: it changes no instruction the model reads.
    //
    // Line endings are normalized FIRST, for the same reason and a sharper one:
    // the failure this guard exists to catch is "duplicated the file and forgot
    // to edit the copy", and a copy that crossed an editor or a platform can
    // come back CRLF while the original is LF. Every byte then differs, the
    // guard sees two distinct arms, and you pay to run one arm twice — which is
    // exactly what it was built to prevent. `.trim()` alone only normalizes the
    // ENDS of the text, so interior line endings would sail through it.
    const key = text.replace(/\r\n/g, '\n').trim();
    const twin = firstArmWithText.get(key);
    if (twin !== undefined) {
      throw new Error(
        `harness-eval: instruction arms "${twin}" and "${arm.id}" resolve to the SAME instructions text, so they are `
        + 'not a comparison — they are one arm run twice, billed and reported as two. '
        + `("${arm.id}" reads ${abs}.) Either point one of them at different instructions, or delete it.`,
      );
    }
    firstArmWithText.set(key, arm.id);
    byArmId.set(arm.id, text);
  }
  return byArmId;
}

/** Expand a validated plan into cells — matrix.js's `expandPlan`, unmodified.
 *  It also verifies every cell's `cellFilename` is distinct across the whole
 *  matrix before anything runs, which is why expansion is not something this
 *  file may re-implement. */
async function expandPlanFile(plan) {
  const { expandPlan } = await loadGraders();
  return expandPlan(plan);
}

// -- where a cell's result file goes -----------------------------------------

/** The ONE place a filename is derived from a cell.
 *
 *  WHY never `cell.id`: the id is `|`-joined and carries roster labels like
 *  "Claude Opus 5", so it contains a Windows-reserved character AND spaces —
 *  it was never a valid filename on any platform. `cellFilename` (matrix.ts)
 *  is the slug-plus-digest builder that cost a full review round; every path
 *  derived from a cell goes through it, and nothing downstream should ever
 *  build one from a raw id. */
async function cellResultPath(runDir, cell) {
  const { cellFilename } = await loadGraders();
  return path.join(runDir, `${cellFilename(cell)}.json`);
}

/** Where a cell's GRADES go — a second file beside the transcript, never inside
 *  it.
 *
 *  WHY not append to the transcript file: the transcript is written first and
 *  is then never touched again (see onResult in main()). Rewriting it to add
 *  grades would put a paid, irreplaceable conversation back at risk on every
 *  grading pass, which is the exact class of loss the transcript-first rule
 *  exists to prevent — a previous round lost four paid conversations to a save
 *  that sat behind a throw. */
async function cellGradePath(runDir, cell) {
  const { cellFilename } = await loadGraders();
  return path.join(runDir, `${cellFilename(cell)}.grades.json`);
}

/**
 * Grade one finished cell: the case's mechanical checks, then the LLM judge.
 *
 * THIS RUNS AFTER THE TRANSCRIPT IS ON DISK, ALWAYS. Nothing in here can lose
 * a conversation that was paid for.
 *
 * NOTHING IN HERE MAY STOP THE MATRIX EITHER. Every failure becomes a sentence
 * in the report (`gradingError`, or the judge's own `unavailable`), because by
 * the time this is called the money for the cell is already spent and a
 * grading hiccup is not a reason to throw away the cells still to come.
 * `judgeRun` never throws by construction; the checks are third-party-ish code
 * from the case registry, so each one is wrapped individually.
 *
 * @returns {Promise<import('../src/main/harness/eval/report').CellResult>}
 */
async function gradeCell(cell, result, { apiKey, judgeModelId, runDir }) {
  const entry = { cell, run: result.run ?? null, error: result.error, timedOut: result.timedOut };
  // A cell that produced no run has nothing to check and nothing to grade. It
  // is still a row in the report, carrying its real error.
  if (!result.run) return entry;

  try {
    const { getCase, judgeRun, collectRunFacts, makeOpenRouterFactory } = await loadGraders();
    const caseBody = getCase(cell.caseId);
    // CHECKS FIRST, FACTS SECOND (fix pass 1, 2026-08-12 review, IMPORTANT 4).
    // These two were the other way round, and `collectRunFacts` throws on a run
    // with no `metrics` — so a facts failure left `entry.checks` UNDEFINED and
    // the report printed "This case declares no mechanical checks" for a case
    // that declares three. Nothing here depends on facts, so the cheapest fix is
    // to record the checks before anything that can throw can eat them. (The
    // renderer no longer reads `undefined` as "none declared" either — two
    // independent fixes, because either one alone leaves the other shape
    // reachable from a different caller.)
    entry.checks = caseBody.expect.map((check) => {
      try {
        return check.run(result.run);
      } catch (err) {
        // WHY 'never-ran' and not 'failed': the check produced no verdict at
        // all, and recording that as a failure would blame the model for a bug
        // in the checker. 'never-ran' is the state that means "nothing was
        // measured here", which is exactly what happened — and the report
        // renders it distinctly from both a pass and a failure.
        return { id: check.id, state: 'never-ran', detail: `This check could not be evaluated: ${errText(err)}` };
      }
    });
    entry.facts = collectRunFacts(result.run, caseBody.minToolCalls);
    entry.judge = await judgeRun(
      result.run,
      caseBody.rubric,
      judgeModelId ? { modelId: judgeModelId, factory: makeOpenRouterFactory(apiKey, judgeModelId) } : null,
      entry.checks,
    );
    const gradeFile = await cellGradePath(runDir, cell);
    fs.writeFileSync(gradeFile, JSON.stringify({
      cellId: cell.id, checks: entry.checks, judge: entry.judge,
    }, null, 2));
  } catch (err) {
    // The real message, never a guess at the cause. The transcript is already
    // safe on disk at this point, and the report will say this row is ungraded.
    entry.gradingError = redactKey(errText(err), apiKey);
  }
  return entry;
}

/** Directory a run's per-cell result files land in.
 *
 *  The workspace-marker walk is the same one review-harness.mjs uses and for
 *  the same reason (a git worktree sits one level deeper than the canonical
 *  checkout, so a fixed `../..` silently resolves to the wrong tree).
 *
 *  WHY a fallback instead of review-harness.mjs's `process.exit(2)`: this CLI
 *  has to keep working in a desktop-only checkout with no youcoded-dev
 *  workspace beside it — which is exactly what CI checks out and runs the
 *  tests in. Exiting there would make the orchestrator untestable on the only
 *  platform that tests it. The fallback is announced in the printed output, so
 *  nobody has to guess which one they got. */
function resolveRunsDir() {
  const stamp = new Date().toISOString().slice(0, 10);
  // Explicit override, checked first. WHY it exists: without it the ONLY way to
  // exercise this CLI end-to-end is to let it write into the developer's real
  // youcoded-dev workspace, which the test suite then has to snapshot and
  // restore file-by-file. That guard cannot be made correct under concurrency —
  // two suites running at once (the normal case here) snapshot the same
  // directory, write the same filenames, and restore over each other, which
  // showed up as `ENOENT: open .../run-summary-unit-test-plan.json` in an
  // unrelated test. It also left an empty dated directory in the workspace on
  // every run, so `git status` in youcoded-dev was permanently dirty (five such
  // directories had accumulated by 2026-08-28). Tests set this to a temp dir;
  // real runs never set it and keep the workspace behaviour below unchanged.
  const override = process.env.YOUCODED_EVAL_RUNS_DIR;
  if (override) return { dir: path.join(override, stamp), inWorkspace: false };
  const marker = 'docs/active/investigations';
  let candidate = DESKTOP;
  for (let i = 0; i < 6; i++) {
    candidate = path.resolve(candidate, '..');
    if (fs.existsSync(path.join(candidate, marker))) {
      return { dir: path.join(candidate, marker, 'harness-eval-runs', stamp), inWorkspace: true };
    }
  }
  return { dir: path.join(DESKTOP, 'test-engine/harness-eval-runs', stamp), inWorkspace: false };
}


/** Print the plan header and the table of cells.
 *
 *  Fix (review round 3, MINOR 6): every axis line is derived from `cells` — the
 *  rows that are actually going to run — and NOT from `plan`. They used to read
 *  straight off the plan, but main() applies `--only` BEFORE calling this, so a
 *  one-cell run printed "Cases: a, b / Models: m1, m2" above a single row:
 *  a summary advertising work that was not going to happen, right above the
 *  gate that will one day spend money. On an unfiltered run the output is
 *  byte-identical (expandPlan visits every axis value at least once), so the
 *  only behaviour that changed is the filtered one. */
async function printGrid(plan, cells) {
  const uniq = (values) => [...new Set(values)];
  console.log(`Plan: ${plan.name}`);
  console.log(`Cases: ${uniq(cells.map((c) => c.caseId)).join(', ')}`);
  console.log(`Instructions: ${uniq(cells.map((c) => c.instructionsId)).join(', ')}`);
  console.log(`Models: ${uniq(cells.map((c) => c.model)).join(', ')}`);
  console.log(`Builds: ${uniq(cells.map((c) => c.buildId)).join(', ')}`);
  // COUNT of distinct repeat indices, not max(repeat): matrix.js numbers
  // repeats from 0, so a max would print "Repeats: 2" for three runs. Counting
  // also stays truthful under --only, which can leave a single repeat index.
  console.log(`Repeats: ${uniq(cells.map((c) => c.repeat)).length}`);

  // Where results land, and — concretely — what one result file is called.
  // Printing a real cellFilename() output rather than describing it is the
  // point: the raw cell id contains '|' and spaces, so an example here is a
  // visible check that the Windows-safe builder is actually in the path.
  const runs = resolveRunsDir();
  console.log(`Results: ${runs.dir}`);
  if (!runs.inWorkspace) {
    console.log('  (no youcoded-dev workspace found beside this checkout — falling back to the checkout itself)');
  }
  console.log(`  e.g. ${path.basename(await cellResultPath(runs.dir, cells[0]))} (one file per cell)`);

  console.log(`\n${cells.length} cell${cells.length === 1 ? '' : 's'}:`);
  const header = ['case', 'instructions', 'model', 'build', 'repeat'];
  const widths = header.map((h, i) => Math.max(
    h.length,
    ...cells.map((c) => String([c.caseId, c.instructionsId, c.model, c.buildId, c.repeat][i]).length),
  ));
  console.log('  ' + header.map((h, i) => h.padEnd(widths[i])).join('  '));
  for (const c of cells) {
    console.log('  ' + [c.caseId, c.instructionsId, c.model, c.buildId, c.repeat]
      .map((v, i) => String(v).padEnd(widths[i])).join('  '));
  }
}

// -- the worker's environment -------------------------------------------------

/**
 * Fix (review round 2, MINOR 1): the worker used to be spawned with
 * `{ ...process.env, ... }` — the operator's WHOLE shell environment. The model
 * under test drives a Bash tool (src/main/harness/tools/bash.ts:511) that spawns
 * its children with `{ ...process.env, ... }` in turn, and every tool result is
 * recorded into `run.events` and saved as a transcript. So `ANTHROPIC_API_KEY`,
 * `GITHUB_TOKEN`, `AWS_*`, and anything else the operator happened to have
 * exported rode along into a file on disk the moment a case prompt said
 * `printenv`. Scrubbing only the OpenRouter key fixed one var out of hundreds.
 *
 * So: allowlist, not denylist. Everything here is either something the harness
 * demonstrably reads, or something Node / the OS / the shell cannot start
 * without. Measured, not guessed — the ONLY named env var anywhere under
 * src/main/harness is CLAUDE_CODE_GIT_BASH_PATH:
 *
 *   $ rg -o "process\.env\.[A-Za-z_0-9]+" src/main/harness/
 *   src/main/harness/tools/bash.ts:process.env.CLAUDE_CODE_GIT_BASH_PATH
 *
 * everything else below is read by a library or by the OS rather than by our
 * code, and is annotated with which. Adding to this list is the correct way to
 * fix "my tool needs $FOO" — re-forwarding the whole environment is not.
 */
const WORKER_ENV_ALLOWLIST = [
  // Command resolution: `which` (bash.ts's resolveOnPath) and every command
  // the model's Bash tool runs. Nothing works without it.
  'PATH',
  'PATHEXT', // which.sync on Windows: which extensions count as executable
  // os.homedir(). git, ssh, and shell rc files all resolve out of it, and the
  // fixture workspace deliberately sits OUTSIDE it (fixture-workspace.ts).
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  // os.tmpdir() — fixture-workspace.ts mkdtemps every case fixture in there,
  // so a worker without these would write fixtures somewhere unexpected.
  'TMPDIR', 'TEMP', 'TMP',
  // Text decoding of tool output. Without a UTF-8 locale, subprocess output
  // comes back mangled and the model is graded on garbage.
  'LANG', 'LC_ALL', 'LC_CTYPE',
  // Read by Node itself at startup: a machine behind a corporate TLS
  // interception CA cannot reach openrouter.ai without it.
  'NODE_EXTRA_CA_CERTS',
  // The one env var our own harness code reads (bash.ts:77).
  'CLAUDE_CODE_GIT_BASH_PATH',
  // Windows can't spawn a shell at all without these: cmd/PowerShell resolve
  // themselves and their module path out of them.
  'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'PSModulePath',
  'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
];
// Deliberately NOT forwarded, having checked rather than assumed: HTTP_PROXY /
// HTTPS_PROXY / NO_PROXY (the rg above found zero references, and Node's global
// fetch — what @ai-sdk/openai-compatible uses — does not honour them by
// default), and NODE_OPTIONS (an arbitrary-flag injection channel into the
// worker). If a proxied machine ever needs them, add them here on purpose.

/** Build the worker's environment from the allowlist above.
 *  Case-insensitive lookup because Windows env var names are case-insensitive
 *  (`Path` vs `PATH`), and a case-sensitive match there would silently hand the
 *  worker an empty PATH — which fails as "command not found" for every tool
 *  call, i.e. as a fake model result rather than an obvious crash. */
function workerEnv() {
  const byLower = new Map();
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) byLower.set(k.toLowerCase(), [k, v]);
  }
  const out = {};
  for (const name of WORKER_ENV_ALLOWLIST) {
    const hit = byLower.get(name.toLowerCase());
    if (hit) out[hit[0]] = hit[1];
  }
  return out;
}

// -- per-cell worker spawn ----------------------------------------------------

/** Replace every occurrence of the credential with a marker.
 *
 *  Split/join rather than a RegExp: an API key is untrusted-shaped text, and
 *  building a pattern from it would let a key containing regex metacharacters
 *  either throw or match the wrong thing. A falsy key is a no-op so --dry-run
 *  and the tests, which have no key at all, take the same path as a real run. */
function redactKey(text, apiKey) {
  return apiKey ? text.split(apiKey).join('[REDACTED credential]') : text;
}

/** Per-cell wall-clock backstop.
 *
 *  WHY 30 minutes and not something tighter: run-case.ts runs its own deadline
 *  (BATTERY_TIMEOUT_MS = 20 minutes for the testing phase) and then spends a
 *  wrap-up turn, so a HEALTHY battery cell can legitimately approach ~25
 *  minutes. This timeout is not a duplicate of that one — it is the backstop for
 *  the failures the in-run deadline cannot see, because they stop the loop that
 *  would check it (a socket that never delivers, a worker wedged before it ever
 *  reaches runCase). Set it below the in-run deadline and you would start
 *  killing runs that were going to finish, which costs the money and throws away
 *  the result. */
const DEFAULT_CELL_TIMEOUT_MS = 1_800_000;

/** How long a killed worker gets to die from SIGTERM before SIGKILL. A worker
 *  wedged inside a native call may ignore SIGTERM entirely; without the
 *  escalation the orchestrator would resolve while an orphan kept running. */
const KILL_GRACE_MS = 5_000;

/**
 * Runs one cell in its own worker process and resolves with its parsed
 * result. Not called anywhere in this skeleton's main flow yet — Task 8 wires
 * it in behind the estimate + confirmation + spend-cap gate. It exists now so
 * that gate has something to call.
 *
 * WHY a subprocess and not an in-process call: see harness-eval-worker.mjs's
 * header — two builds of HarnessSession cannot coexist in one Node process.
 *
 * WHY `harnessRoot(cell)` and not `cell.dist` directly: this is the one place
 * this orchestrator resolves "which dist does the harness under test come
 * from," and routing it through paths.ts keeps that resolution in the same
 * place the grader-isolation invariant is defined and tested. Note the
 * contrast with `loadGraders()` at the top of this file, which resolves the
 * case registry and the matrix through `graderRoot()` — this checkout, never
 * `cell.dist`. Only the harness under test varies per cell.
 *
 * WHY it THROWS instead of running something: every failure mode this function
 * refuses to paper over costs real money once Task 8's gate calls it.
 *
 * WHY the config goes over STDIN: it carries the OpenRouter key, and both of
 * the WORKER's other channels (its argv and its environment) are readable by a
 * descendant of the worker — which the model's own Bash tool is. That is the
 * scope of what was measured; see harness-eval-worker.mjs's header, including
 * its "SCOPE OF THAT GUARANTEE" paragraph, which records what this does NOT
 * cover (the orchestrator's own environment, closed by a Task 8 constraint).
 *
 * WHY there is a TIMEOUT (deferred here from the Task 7 review): the worker had
 * none, so a wedged model — a hung HTTP request, a provider that accepts the
 * connection and never streams — hung the ORCHESTRATOR forever, after the money
 * for that cell had already been spent, with no output and no way to tell it
 * from a slow run. The timeout produces a LABELLED result (`timedOut: true`)
 * rather than a silent hang or a crash, so the row appears in the report as
 * "this cell was killed at N seconds" and the rest of the matrix continues.
 *
 * @param {Cell} cell
 * @param {{ apiKey: string, instructionsText?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ cellId: string, run: unknown, error?: string, timedOut?: boolean }>}
 */
async function runCell(cell, { apiKey, instructionsText, timeoutMs = DEFAULT_CELL_TIMEOUT_MS }) {
  if (!apiKey) {
    throw new Error(`harness-eval: cell "${cell.id}" cannot run — no OpenRouter API key was supplied to runCell().`);
  }
  // Fix (review round 1, IMPORTANT 2): no silent `?? distRoot` fallback. A
  // cell whose build arm lost its dist must stop here, not quietly run this
  // checkout's build and be reported as some other arm. validatePlan rejects a
  // dist-less build arm too; this is the second half of the same guard, for
  // cells that reach here without having gone through a plan file.
  if (typeof cell.dist !== 'string' || !cell.dist) {
    throw new Error(`harness-eval: cell "${cell.id}" (build arm "${cell.buildId}") has no "dist" — refusing to run, because defaulting it would run this checkout's own build while the report claims build "${cell.buildId}".`);
  }
  // Fix pass 1 (2026-08-12 review, IMPORTANT 2): the check above only rejected
  // a FALSY dist, and the value that actually reached here was `'.'` — truthy,
  // and the old matrix.ts default. A relative dist is resolved by the worker
  // against whatever working directory it inherits, so the run would silently
  // test whichever build the cwd happened to point at while the report named
  // build "<buildId>". That is the same class of bug as a missing dist, so it
  // is refused in the same place, before anything is spawned or spent. The
  // source-side half of this fix removed matrix.ts's relative default outright.
  if (!path.isAbsolute(cell.dist)) {
    throw new Error(
      `harness-eval: cell "${cell.id}" (build arm "${cell.buildId}") has a RELATIVE "dist" ("${cell.dist}") — `
      + 'refusing to run. The worker resolves the harness under test against the working directory it inherits, so '
      + 'a relative dist means the same plan tests a different build depending on where the command was typed. '
      + 'Build dists must be absolute; a plan file\'s relative dist is made absolute against the plan file itself '
      + 'by readPlanFile().',
    );
  }
  const { harnessRoot, getCase, roster } = await loadGraders();
  // Fix (review round 1, IMPORTANT 1), rewired in Task 8 Step 0: the worker's
  // runCase() defaults an absent `prompt` to the harness-review BATTERY_PROMPT,
  // so a cell with no case body would run the same task N times while each row
  // was labelled with a different caseId — a real matrix's worth of money for
  // one repeated task. The body now comes from the case registry
  // (cases/index.js, loaded from THIS checkout via graderRoot), and getCase
  // throws naming every known id if the cell's caseId is not one of them, so
  // there is no path left on which a body can be absent. The prompt re-check
  // below stays because a future case could be registered with an empty prompt,
  // and that must fail here rather than silently become the battery.
  const caseBody = getCase(cell.caseId);
  if (typeof caseBody.prompt !== 'string' || !caseBody.prompt) {
    throw new Error(
      `harness-eval: cell "${cell.id}" cannot run — case "${cell.caseId}" is registered with an empty prompt. `
      + `Running it would silently execute the default battery prompt and bill it as case "${cell.caseId}".`,
    );
  }
  // Fix (review round 2, IMPORTANT 2): the same hole the check above closes for
  // the CASE axis was still wide open on the INSTRUCTIONS axis. `instructionsId`
  // reaches the worker, but nothing resolved the arm's `file` to text, so two
  // instruction arms produced byte-identical worker configs differing only in
  // the cell id — N paid runs of ONE task, reported as a matrix.
  //
  // The reading is wired up now (Task 8c: main() calls loadInstructionTexts and
  // passes each cell its own arm's text), so this guard is no longer the
  // everyday path — it is the backstop for a CALLER that skipped that step, and
  // it stays because runCell is exported and callable without main().
  // `file: null` (the baseline arm) is fine: there is nothing to resolve.
  if (cell.instructionsFile && (typeof instructionsText !== 'string' || !instructionsText)) {
    throw new Error(
      `harness-eval: cell "${cell.id}" cannot run — instruction arm "${cell.instructionsId}" declares a file `
      + `("${cell.instructionsFile}") but no instruction text was supplied for it. The caller must resolve the arm's file `
      + `first (loadInstructionTexts does this for every arm in the plan); running without it would send a config identical `
      + `to every other arm's, so the arms would be one repeated task billed and reported as an instructions comparison.`,
    );
  }
  // Fix (Task 8 Step 0): `cell.model` is a roster LABEL, not an OpenRouter
  // model id — matrix.ts's EvalPlan documents `models` that way and
  // validatePlan cross-checks the plan against the roster's labels. Sending
  // the label straight through as `modelId` (what this file did before the
  // integration, when it validated nothing and assumed the plan held ids)
  // would have OpenRouter reject "Claude Opus 5" as an unknown model AFTER the
  // fixture was seeded. The roster is also where contextLength comes from.
  const entry = roster.find((r) => r.label === cell.model);
  if (!entry) {
    throw new Error(
      `harness-eval: cell "${cell.id}" names model "${cell.model}", which is not a label in ${ROSTER_FILE}. `
      + `Known labels: ${roster.map((r) => r.label).join(', ')}.`,
    );
  }
  const config = {
    cellId: cell.id,
    // The key travels in the CONFIG, and the config travels over stdin — see
    // the spawn below. It is never in argv and never in the environment.
    apiKey,
    // Carried so the worker's own errors can name the case/arm, and so a
    // saved result is traceable back to a plan row without re-parsing the id.
    caseId: cell.caseId,
    instructionsId: cell.instructionsId,
    dist: harnessRoot(cell),
    // `cell.model` is the roster LABEL; `entry.modelId` is what OpenRouter
    // actually accepts. Both travel, because the label is what a report and
    // every error message names, and the id is what gets billed.
    modelId: entry.modelId,
    label: entry.label,
    prompt: caseBody.prompt,
    wrapUpPrompt: caseBody.wrapUpPrompt,
    // From the ROSTER, not the case: it is a property of the model, and
    // getting it wrong-high overflows the model and 400s mid-run (see the
    // RosterEntry doc comment in battery.ts).
    contextLength: entry.contextLength,
    instructions: instructionsText,
    // Sent so the worker can refuse the same unresolved-arm config independently
    // (a config assembled by something other than runCell, e.g. Task 6's
    // matrix.ts, must not be able to slip past the guard above).
    instructionsFile: cell.instructionsFile ?? null,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER], {
      // Fix (review round 2, CRITICAL): the config — key included — is written
      // to the worker's STDIN, so stdio[0] is a pipe rather than 'ignore'.
      // Round 1 had the key in argv (/proc/<pid>/cmdline). Round 2 moved it to
      // the environment and deleted it in the worker, which does NOT close the
      // hole: delete/unsetenv edits the in-heap environ array, it does not
      // rewrite the mm->env_start..env_end stack region that /proc/<pid>/environ
      // exposes, so a descendant could still read the ORIGINAL environment
      // (measured: /proc/<ppid>/environ and `ps eww -p <worker>` both LEAKED).
      // The model's Bash tool is exactly such a descendant, and everything it
      // prints lands in run.events and then in a saved transcript.
      // stdin has no /proc mirror at all: it is a pipe, consumed once, never
      // re-readable by anyone.
      //
      // Fix (review round 3, IMPORTANT 1): stderr is PIPED (and mirrored to
      // ours below) instead of 'inherit'. Inheriting kept it visible to a human
      // but threw it away for this process, so EVERY worker failure came back
      // as the same opaque "worker exited 1" — empty stdin, malformed JSON, a
      // missing apiKey and a dist that would not load were indistinguishable to
      // the caller, and no test could tell whether the stdin config had been
      // delivered at all.
      stdio: ['pipe', 'pipe', 'pipe'],
      // Fix (review round 2, MINOR 1): an ALLOWLISTED environment, not the
      // operator's whole shell. See WORKER_ENV_ALLOWLIST above. Note there is
      // no OPENROUTER_API_KEY here at all any more — the key's only channel is
      // the stdin config.
      env: workerEnv(),
    });
    // Writing the config can fail with EPIPE if the worker died before reading
    // it (bad node install, worker syntax error). Swallow it deliberately: the
    // 'close' handler below already reports the real non-zero exit and the
    // worker's own stderr, and an unhandled 'error' on this stream would crash
    // the orchestrator with a message about a pipe instead.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(config));
    // Fix (review round 1, IMPORTANT 3): decode as UTF-8 on the STREAM, not
    // per chunk. A transcript JSON is far bigger than one 64 KB chunk, and a
    // multi-byte character split across a chunk boundary decodes to U+FFFD
    // when each Buffer is coerced on its own — corrupting the JSON parse of a
    // run that already cost money.
    child.stdout.setEncoding('utf8');
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // Capture AND mirror: the human watching still sees worker diagnostics live
    // (that was the only thing 'inherit' bought us), and the text is also kept
    // so a failure can be reported in the worker's own words instead of a guess.
    // setEncoding for the same multi-byte reason as stdout above.
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });

    // The timeout. `resolve` is first-wins, so resolving here makes the later
    // 'close' resolve a no-op and the caller sees the timeout result rather than
    // "killed by SIGKILL" — the difference between "we stopped it, here is why"
    // and a signal the reader has to interpret. The result is still written to
    // disk by the caller, so a wedged cell is a labelled row in the report.
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const hardKill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      // Fix pass 1 (2026-08-12 review, MINOR): NOT unref'd. It was, "so a worker
      // that dies promptly does not hold the event loop open" — but a worker that
      // dies promptly clears this timer on 'close' one line below, so the unref
      // bought nothing in that case and cost everything in the case the timer
      // exists for: a worker that IGNORES SIGTERM. There, unref let the
      // orchestrator's loop empty and the process exit before SIGKILL was ever
      // sent, orphaning the worker that was wedged badly enough to need it.
      child.on('close', () => clearTimeout(hardKill));
      resolve({
        cellId: cell.id,
        run: null,
        timedOut: true,
        error:
          `worker exceeded the per-cell timeout of ${Math.round(timeoutMs / 1000)}s and was killed. `
          + 'The tokens this cell had already consumed are spent; nothing was produced. '
          + `Raise it with --timeout <seconds> if this model is legitimately slower than that.`
          + (stderr.trim() ? ` Last worker stderr: ${redactKey(stderr.trim().slice(-2000), apiKey)}` : ''),
      });
    }, timeoutMs);
    // NOT unref'd, deliberately: this timer is the only thing that ends a wedged
    // run, so it must be able to keep the loop alive on its own. It is cleared
    // on both the 'close' and 'error' paths, so a healthy cell never waits for it.

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ cellId: cell.id, run: null, error: `could not spawn worker: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      // Already reported as a timeout above; the exit that follows our own
      // SIGTERM must not overwrite that with "killed by SIGTERM".
      if (timedOut) return;
      if (code !== 0) {
        // The worker's OWN words, never a hardcoded guess at what went wrong.
        // Tail-capped rather than truncated from the front, because the reason a
        // process died is at the END of its stderr; the untruncated text was
        // already mirrored above for anyone watching.
        // Redact the credential before this text can reach a transcript.
        //
        // WHY, even though no CURRENT path puts it here: this branch's whole
        // review history is three rounds of the same bug — the key reached the
        // model first through argv, then through the environment, each time
        // certified clean by a check aimed at the channel it had just left.
        // Capturing arbitrary worker stderr verbatim into `result.error` opens a
        // fourth channel: `result` is what the caller writes to disk as a
        // transcript. Today's failure paths are clean (the worker's own fail()
        // messages never interpolate the key's value), but an uncaught throw, a
        // warning from the provider SDK, or a future bug in run-case.ts could all
        // land the literal key on stderr, and this code would file it. Scrubbing
        // an exact string is one line; discovering the fourth instance of this
        // bug in a saved transcript is not.
        const tail = redactKey(stderr.trim().slice(-2000), apiKey);
        const how = code === null ? `was killed by ${signal}` : `exited ${code}`;
        resolve({
          cellId: cell.id,
          run: null,
          error: tail ? `worker ${how}: ${tail}` : `worker ${how} without writing anything to stderr`,
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        resolve({ cellId: cell.id, run: null, error: `worker produced non-JSON stdout: ${err.message}` });
      }
    });
  });
}

// -- prices, the estimate, and the confirmation gate ---------------------------

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
/** Both OpenRouter calls here are metadata, not inference. If the catalog is
 *  slow, the right answer is "no prices, every model named as unpriced", not a
 *  CLI that appears to hang before it has said anything. */
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * Fetch the public OpenRouter model catalog and map it onto ROSTER LABELS.
 *
 * WHY fetched rather than hardcoded: a hardcoded price table for these models
 * would be numbers I do not actually know, wearing a "fetched on <date>" comment
 * — which is the exact dishonest-estimate failure this whole gate exists to
 * prevent. The catalog endpoint is public (no Authorization header, no key), so
 * --dry-run still gets real prices with no credential anywhere on the machine.
 *
 * WHY a failure is not fatal: an empty record makes every model `unpriced`, and
 * `printEstimate` names them all and refuses to show a total. That is the
 * honest degradation. The real fetch error is printed, never a guess at why.
 *
 * `judgeModelId` is looked up by MODEL ID rather than by roster label: the judge
 * is named as an OpenRouter id in the plan and need not be on the roster at all
 * (fix pass 1, 2026-08-12 review, IMPORTANT 1 — the judge's spend has to be
 * printed with the estimate, and its rate is the one honest number available).
 *
 * @returns {Promise<{ prices: Record<string, {inputPerM:number,outputPerM:number}>, judgePrice: {inputPerM:number,outputPerM:number}|null, error?: string }>}
 */
async function fetchPrices(roster, parsePriceCatalog, judgeModelId) {
  let byModelId;
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!res.ok) {
      // The server's own status line and body, capped — never "network error".
      const body = (await res.text().catch(() => '')).slice(0, 300);
      return { prices: {}, judgePrice: null, error: `GET ${OPENROUTER_MODELS_URL} returned HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ''}` };
    }
    byModelId = parsePriceCatalog(await res.json());
  } catch (err) {
    return { prices: {}, judgePrice: null, error: `GET ${OPENROUTER_MODELS_URL} failed: ${err.message}` };
  }
  // The catalog is keyed by OpenRouter model id; cells carry roster LABELS. The
  // roster is the only thing that knows the correspondence, so the mapping
  // happens here rather than inside the pure estimator.
  const prices = {};
  for (const entry of roster) {
    if (byModelId[entry.modelId]) prices[entry.label] = byModelId[entry.modelId];
  }
  return { prices, judgePrice: (judgeModelId && byModelId[judgeModelId]) || null };
}

/**
 * Print the dollar figure a human is about to agree to.
 *
 * Everything that could make the number wrong is printed WITH it: unpriced
 * models, models with no measured token count, cells priced from the
 * whole-battery table instead of a measurement of their own case (since
 * 2026-08-13 — see `estimate.ts`'s MEASURED_CASE_TOKENS comment for why that
 * distinction is an ~8x swing), a failed catalog fetch, the fact that the
 * fallback tokens come from whole-battery runs, and — since fix pass 1
 * (2026-08-12 review, IMPORTANT 1) — the JUDGE, which is a second paid call per
 * graded cell and is not in the total at all. That contract was false the moment
 * grading was wired in, and the figure below is the only bound a run without
 * --max-spend has. A total with no caveats next to it is a number someone will
 * act on.
 */
/** A plan that compares two or more BUILD arms with one run each cannot separate
 *  a real difference from run-to-run noise, and the judged items are where that
 *  bites: on 2026-09-05 the SAME build, case, model and judge scored
 *  plain-language 1 then 4, and unexplained-jargon 0 then 2, on two runs a few
 *  hours apart — a 2-3 point swing, which is the size of most effects anyone
 *  runs this tool to find. A session read that swing as a finding, reported it,
 *  and had to retract it after the second run.
 *
 *  The report already says "one run is noise, not evidence" in prose. Prose did
 *  not stop it, so this prints at the moment the money is about to be spent and
 *  names the flag that fixes it. It WARNS rather than refuses: a single run is a
 *  legitimate smoke test, and one arm's plan (no comparison) needs no repeats. */
function comparisonNoiseWarning(plan, cells) {
  const armCount = new Set(cells.map((c) => c.buildId)).size;
  const repeats = plan.repeats ?? 1;
  if (armCount < 2 || repeats > 1) return null;
  return [
    `  ! This plan compares ${armCount} build arms with ONE run each, so it cannot tell a real`,
    '    difference from run-to-run noise. Measured 2026-09-05: the same build, case, model and',
    '    judge moved 2-3 points on judged items between two runs — the size of most effects.',
    '    Add --repeats <n> (or "repeats" in the plan) before reading any gap as a finding.',
  ].join('\n');
}

function printEstimate(estimate, cells, {
  fetchError, formatUsd, judgeCostLines, judgeModelId, judgePrice,
}) {
  console.log('\nEstimated cost');
  const width = Math.max(...estimate.perCell.map((c) => c.cellId.length), 4);
  for (const row of estimate.perCell) {
    console.log(`  ${row.cellId.padEnd(width)}  ${row.usd === null ? '  (no price)' : formatUsd(row.usd).padStart(11)}`);
  }
  const pricedCount = estimate.perCell.filter((c) => c.usd !== null).length;
  // WHY the zero-priced case gets words instead of a figure: "$0.00" is the one
  // rendering of "we could not price anything" that a reader can act on, and
  // acting on it means spending an unknown amount believing it was free.
  console.log(`  ${'TOTAL'.padEnd(width)}  ${pricedCount === 0 ? '  UNKNOWN — nothing could be priced' : formatUsd(estimate.totalUsd).padStart(11)}`
    + (pricedCount === 0 || pricedCount === cells.length ? '' : `   — for ${pricedCount} of ${cells.length} cells only`));

  if (fetchError) {
    console.log(`\n  ! Prices could not be fetched, so NOTHING below is priced: ${fetchError}`);
  }
  if (estimate.unpriced.length) {
    console.log(`  ! No price for: ${estimate.unpriced.join(', ')} — these cells are NOT in the total above.`);
    console.log('    They are not free. Treat the total as a floor.');
  }
  if (estimate.unmeasured.length) {
    console.log(`  ! No measured token count for: ${estimate.unmeasured.join(', ')} — priced from the worst measured run,`);
    console.log('    so those rows read HIGH rather than low.');
  }
  // Fix (2026-08-13, eval-estimate-measured): a cell can now be priced from a
  // measurement of the SPECIFIC CASE it runs, or fall through to a measurement
  // of the whole 40-63-tool-call BATTERY — which was the ~8x-high estimate this
  // fix exists for. Printed separately from `unmeasured` (that means "no
  // measurement at all") so a battery-priced row is never mistaken for a
  // measurement of the case it is actually pricing.
  if (estimate.batteryPriced.length) {
    console.log(`  ! Priced from the whole-BATTERY table, not from this case: ${estimate.batteryPriced.join(', ')}`);
    console.log('    These are short cases costing a fraction of a 40-63-tool-call battery run — treat these rows as HIGH.');
  }
  // The judge, ALWAYS — including the "this plan has no judge" line, because
  // "the figure covers everything" is itself information the reader needs, and a
  // caveat that only prints sometimes teaches nobody to look for it.
  console.log('');
  for (const line of judgeCostLines({ modelId: judgeModelId ?? null, maxCalls: cells.length, price: judgePrice ?? null })) {
    console.log(`  ${line}`);
  }
  // Fix (2026-08-13, eval-estimate-measured): this used to say EVERY row here
  // comes from a whole-battery run, which stopped being true once
  // MEASURED_CASE_TOKENS shipped — most rows above are now priced from a
  // measurement of the exact case+model, not the battery. The blanket claim is
  // replaced with the honest one: it depends on the row, and `batteryPriced`
  // above names exactly which rows are still the battery-shaped guess.
  console.log('\n  Basis: rows not listed above (as unpriced/unmeasured/battery-priced) are priced from a measurement of');
  console.log('  that exact case on that exact model. A model that loops on a real run costs more than any of this.');
  // ROADMAP L161: the hand-copied "$3.46 a round on average" calibration line
  // that used to print here is gone. It was the mean of three rounds nobody
  // recorded separately, so it could not say whether this estimate reads high
  // or low. Every finished cell now carries OpenRouter's own bill for it
  // (`metrics.providerCostUsd`, on the report's "Run facts" line), which is
  // the comparison that CAN answer that — per model, per round.
  console.log('  Calibration: each finished cell reports what OpenRouter itself billed for it ("provider billed"');
  console.log('  on its Run facts line in the report). Compare that against the row above to see which way this');
  console.log('  estimate errs. Use --max-spend if the number matters.');
}

/**
 * Block until a human types y.
 *
 * WHY it refuses when stdin is not a TTY instead of assuming yes: a run started
 * from a script or a CI job has nobody to answer, and "no answer" must never
 * mean "go ahead and spend". `--yes` is the deliberate way to say so.
 */
async function confirmSpend(totalLabel) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `harness-eval: refusing to spend ${totalLabel} — stdin is not a terminal, so there is nobody to confirm. `
      + 'Pass --yes if you really mean to run this unattended.',
    );
  }
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((res) => rl.question(`\nSpend up to ${totalLabel}? [y/N] `, res));
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

// -- the spend cap ------------------------------------------------------------

/**
 * Ask OpenRouter what this key has ACTUALLY been billed, in dollars.
 *
 * WHY the real usage endpoint rather than trusting the estimate: the estimate is
 * built from measured tokens of past runs, and the failure mode that matters
 * most — a model that loops — is precisely the one no past measurement predicts.
 * One roster run already produced 1.4M input tokens from a looping model. The
 * cap therefore reads the biller, not our own arithmetic.
 *
 * THROWS on any failure, deliberately: a cap that cannot measure spend is not a
 * cap, and silently continuing without it is the one outcome nobody asked for.
 */
async function fetchKeyUsage(apiKey) {
  let res;
  try {
    res = await fetch(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`GET ${OPENROUTER_KEY_URL} failed: ${err.message}`);
  }
  if (!res.ok) {
    const body = redactKey((await res.text().catch(() => '')).slice(0, 300), apiKey);
    throw new Error(`GET ${OPENROUTER_KEY_URL} returned HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`GET ${OPENROUTER_KEY_URL} returned a body that is not JSON: ${err.message}`);
  }
  const usage = body?.data?.usage;
  if (typeof usage !== 'number' || !Number.isFinite(usage)) {
    // Name what actually came back. A changed API shape must not read as $0
    // spent, which would make the cap permanently un-trippable.
    throw new Error(
      `${OPENROUTER_KEY_URL} did not report a numeric data.usage (got ${JSON.stringify(usage)}). `
      + 'Refusing to treat that as zero spend.',
    );
  }
  return usage;
}

/** A thrown value's own text, whatever shape it was thrown in.
 *  WHY: a rejection is not guaranteed to be an Error, and `err.message` on a
 *  thrown string is `undefined` — which would turn "the real reason" into the
 *  word "undefined" in exactly the messages that exist to carry it. */
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the matrix cell by cell, stopping if the cap trips.
 *
 * `runOne` and `readUsage` are injected so this loop — the part that decides
 * whether more money is spent — is testable without spending any. main() passes
 * the real `runCell` and `fetchKeyUsage`.
 *
 * THE CAP IS CHECKED BETWEEN CELLS, NEVER DURING ONE. A cell killed halfway
 * costs exactly what a finished one costs and yields nothing, so interrupting is
 * strictly worse than letting it end. The consequence — an overshoot of up to
 * one cell's cost — is real and is printed rather than hidden.
 *
 * REJECTION CONTRACT (fix pass 1, 2026-08-12 review, CRITICAL). Exactly ONE
 * failure rejects: the BASELINE usage read, which happens before the first cell
 * and is tagged `err.beforeFirstCell = true`. It is the only failure after which
 * a caller may honestly tell a human that nothing was spent. Every other failure
 * — including a `runOne` that throws on cell N and an `onResult` that cannot
 * write cell N's file — comes back as a normal return with `results`, `skipped`
 * and a `stopReason`, because by then money HAS been spent and the list of cells
 * that never ran is the thing the operator needs.
 *
 * @returns {Promise<{ results: unknown[], skipped: Cell[], stopReason?: string }>}
 */
async function runMatrix(cells, { runOne, readUsage, maxSpendUsd, onResult }) {
  const capped = typeof maxSpendUsd === 'number';
  let baseline = 0;
  if (capped) {
    // Read BEFORE the first cell. If this throws we have spent nothing yet, and
    // "the cap could not be established" must stop the run rather than start it
    // uncapped — the flag was given precisely because the operator did not trust
    // the estimate.
    try {
      baseline = await readUsage();
    } catch (err) {
      // Fix pass 1 (2026-08-12 review, CRITICAL): TAG it. This is the one and
      // only failure of this function on which "nothing was spent" is true, and
      // the caller used to infer that from the mere fact of a rejection — so
      // every per-cell throw below (all four of them reachable after earlier
      // cells had already been billed) was reported to the operator as
      // "NOTHING WAS SPENT". The caller must be able to TELL, not guess.
      // Wrapped when it is not an Error, because ES modules are strict mode and
      // assigning a property to a primitive rejection would throw.
      const tagged = err instanceof Error ? err : new Error(String(err));
      tagged.beforeFirstCell = true;
      throw tagged;
    }
  }

  const results = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    console.log(`\n[${i + 1}/${cells.length}] ${cell.id}`);
    // Fix pass 1 (2026-08-12 review, CRITICAL): runOne is WRAPPED. runCell
    // THROWS (rather than resolving with an `error` field) for four per-cell
    // conditions — a non-absolute `dist`, a case registered with an empty
    // prompt, an instruction arm whose file nobody resolved, and a model that is
    // not a roster label — and every one of those is reachable on cell N after
    // cells 1..N-1 have run and been billed. (Task 8c closed the instructions
    // one for runs driven by main(), which now resolves every arm's file before
    // the first cell; runCell is exported and callable directly, so the wrapper
    // still has to assume any of the four can fire.)
    //
    // Letting that rejection escape threw away `results` and `skipped`, so the
    // caller could write no summary and name no cells — the exact "print exactly
    // which cells never ran" guarantee this loop exists to provide. It comes back
    // as a stopReason instead, like every other stop.
    //
    // The failing cell is counted as NEVER RAN: all four of runCell's throws fire
    // before the worker is spawned, so nothing was spent on it. A runOne that
    // could throw after spending would need this to say something weaker.
    let result;
    try {
      result = await runOne(cell);
    } catch (err) {
      return {
        results,
        skipped: cells.slice(i),
        // `String(err)` for a non-Error rejection rather than `undefined` — the
        // whole point of this branch is that the operator gets the REAL reason.
        stopReason: `cell "${cell.id}" could not be started, so the matrix stopped there: ${errText(err)}`,
      };
    }
    results.push(result);
    if (onResult) {
      // Wrapped for the same reason: onResult is a filesystem write in the real
      // caller, and ENOSPC / EACCES on cell N is not evidence that cells 1..N-1
      // did not happen. This cell DID run and was billed, so it stays in
      // `results` and is not listed as never-ran — but its result file may be
      // missing or truncated, which the stopReason says.
      try {
        await onResult(cell, result);
      } catch (err) {
        return {
          results,
          skipped: cells.slice(i + 1),
          stopReason:
            `cell "${cell.id}" ran, but its result could not be written to disk, so the matrix stopped rather than `
            + `spending more money it could not record: ${errText(err)}`,
        };
      }
    }

    if (!capped || i === cells.length - 1) continue;

    let spent;
    try {
      spent = (await readUsage()) - baseline;
    } catch (err) {
      // Same reasoning as the baseline read: an unmeasurable cap is not a cap.
      // Stop with the real error, keeping everything already produced.
      return {
        results,
        skipped: cells.slice(i + 1),
        stopReason: `could not read OpenRouter usage to enforce --max-spend, so the run stopped rather than continuing uncapped: ${err.message}`,
      };
    }
    console.log(`  spent so far: $${spent.toFixed(4)} of $${maxSpendUsd.toFixed(2)}`);
    if (spent >= maxSpendUsd) {
      return {
        results,
        skipped: cells.slice(i + 1),
        stopReason:
          `--max-spend $${maxSpendUsd.toFixed(2)} reached: OpenRouter reports $${spent.toFixed(4)} billed to this key `
          + `since the run started. Stopped after ${i + 1} of ${cells.length} cells. `
          + '(The cap is checked BETWEEN cells and never interrupts one, so the last cell may have carried the total past the cap.)',
      };
    }
  }
  return { results, skipped: [] };
}

// -- main ---------------------------------------------------------------------

async function main(argv) {
  let parsed;
  try {
    // parseArgs now THROWS on a flag given no value (see flagValue). Turned
    // into the same exit code 2 / stderr shape every other usage error uses.
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const { dryRun, confirmed, planPath, maxSpend, only, repeatsFlag, keyFile, timeoutFlag } = parsed;

  if (!planPath) {
    console.error('harness-eval: --plan <file> is required.');
    console.error('Usage: node test-engine/harness-eval.mjs --plan <file> --key-file <path>');
    console.error('       [--dry-run] [--yes] [--max-spend <usd>] [--timeout <seconds>] [--only <cellId>] [--repeats <n>]');
    process.exit(2);
  }

  // Both numeric flags are validated HERE, before the plan is even read, so a
  // typo is a usage error rather than something discovered after a grid has been
  // printed and a human has said yes.
  let maxSpendUsd;
  if (maxSpend !== undefined) {
    maxSpendUsd = Number(maxSpend);
    if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) {
      console.error(`harness-eval: --max-spend must be a positive number of dollars (got "${maxSpend}").`);
      process.exit(2);
    }
  }
  let timeoutMs = DEFAULT_CELL_TIMEOUT_MS;
  if (timeoutFlag !== undefined) {
    const seconds = Number(timeoutFlag);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      console.error(`harness-eval: --timeout must be a positive number of seconds (got "${timeoutFlag}").`);
      process.exit(2);
    }
    timeoutMs = seconds * 1000;
  }

  let plan;
  try {
    plan = await readPlanFile(planPath);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  // -- the instructions axis (Task 8c). Read HERE: after the plan validates and
  // before the grid, the estimate, the --dry-run return, and the credential. A
  // path typo, an unreadable file, an empty arm, or two arms that resolve to the
  // same text all stop the run at this point, which is the last one at which
  // "nothing was spawned and nothing was spent" is true without qualification.
  // --dry-run gets the same checks, deliberately: a dry run whose whole job is
  // "tell me what this would do" must not say "it would work" about a plan whose
  // instruction files are missing.
  let instructionsByArmId;
  try {
    instructionsByArmId = loadInstructionTexts(plan, planPath);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (repeatsFlag !== undefined) {
    // Fix (review round 1, MINOR 2): the flag now goes through the same check
    // the plan file's own `repeats` gets. It used to be a bare Number(), so
    // `--repeats abc` printed "Repeats: NaN" / "0 cells" and exited 0.
    // Named `repeatsValue`, not `parsed` (review round 3, MINOR 7): `parsed` is
    // already the parseArgs result in this same function, and shadowing it on a
    // line that decides how many paid runs happen is exactly where a confusing
    // name costs money.
    const repeatsValue = Number(repeatsFlag);
    if (!isPositiveInteger(repeatsValue)) {
      console.error(`harness-eval: --repeats must be a positive integer (got "${repeatsFlag}").`);
      process.exit(2);
    }
    plan.repeats = repeatsValue;
  }

  let cells;
  try {
    cells = await expandPlanFile(plan);
  } catch (err) {
    // expandPlan's own throw path is the cellFilename collision check, which
    // fires before any run starts. Reported in its own words, not summarised.
    console.error(`harness-eval: ${err.message}`);
    process.exit(2);
  }
  if (only) {
    cells = cells.filter((c) => c.id === only);
    if (!cells.length) {
      console.error(`harness-eval: --only "${only}" matched no cell in the expanded plan.`);
      process.exit(2);
    }
  }

  await printGrid(plan, cells);

  // -- the estimate. Printed for EVERY invocation, dry-run or not, because the
  // grid above is only half of what someone needs to decide. The prices come
  // from a public catalog endpoint, so this path needs no credential at all.
  const {
    roster, estimateCells, parsePriceCatalog, formatUsd, judgeCostLines,
  } = await loadGraders();
  const judgeModelId = plan.judge ?? null;
  const { prices, judgePrice, error: fetchError } = await fetchPrices(roster, parsePriceCatalog, judgeModelId);
  const estimate = estimateCells(cells, prices);
  printEstimate(estimate, cells, {
    fetchError, formatUsd, judgeCostLines, judgeModelId, judgePrice,
  });
  const noise = comparisonNoiseWarning(plan, cells);
  if (noise) console.log(`\n${noise}`);

  if (dryRun) {
    // Deliberately BEFORE any key handling: --dry-run must work on a machine
    // with no credential anywhere, which is also how the tests exercise it.
    if (process.env.OPENROUTER_API_KEY) {
      console.log('\n  ! OPENROUTER_API_KEY is set in this shell. A real run would REFUSE it — an inherited env var is');
      console.log('    readable at /proc/<pid>/environ by every descendant, including the Bash tool the model drives.');
      // Fix pass 1 (2026-08-12 review, MINOR): this used to say "see --help text
      // on a real run". parseArgs has never parsed --help, so that pointed at
      // nothing. The remedy is short enough to just say.
      console.log('    Run it as:  env -u OPENROUTER_API_KEY node test-engine/harness-eval.mjs --plan <file> --key-file <path>');
    }
    console.log('\n(dry run: nothing was spawned and nothing was spent)');
    return;
  }

  // -- the credential. Acquired BEFORE the confirmation prompt so a missing or
  // unreadable key fails immediately rather than after a human has typed y.
  let apiKey;
  try {
    apiKey = loadApiKey({ keyFile });
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(2);
  }
  // Immediately after the key is in hand: stop `/proc/<pid>/cmdline` telling a
  // descendant where the key file lives. The plan name is kept so the process is
  // still identifiable in `ps` — see scrubProcessTitle for what this does and
  // does not buy.
  scrubProcessTitle(`harness-eval (${path.basename(planPath)})`);

  // -- the gate.
  if (!confirmed) {
    // The prompt must never quote a figure it cannot stand behind. With nothing
    // priced there is no number to show; with a partial total, the prompt says so
    // in the same breath as the number.
    const pricedCount = estimate.perCell.filter((c) => c.usd !== null).length;
    const base = pricedCount === 0
      ? 'an UNKNOWN amount (no model in this plan could be priced — see above)'
      : estimate.unpriced.length
        ? `${formatUsd(estimate.totalUsd)} for ${pricedCount} of ${cells.length} cells, plus ${estimate.unpriced.length} unpriced model(s) — the real figure is HIGHER`
        : formatUsd(estimate.totalUsd);
    // …and the judge, which is not in that figure at all (fix pass 1,
    // 2026-08-12 review, IMPORTANT 1). "Spend up to $X?" was a false ceiling on
    // a graded plan: grading adds a call per cell that the total never counted.
    // Named in the same breath as the number, because this line IS the gate.
    const label = judgeModelId
      ? `${base}, PLUS up to ${cells.length} judge call${cells.length === 1 ? '' : 's'} to ${judgeModelId} that are NOT in that figure`
      : base;
    let ok;
    try {
      ok = await confirmSpend(label);
    } catch (err) {
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    if (!ok) {
      console.log('Cancelled — nothing was spawned and nothing was spent.');
      return;
    }
  }

  // -- the run.
  const runs = resolveRunsDir();
  fs.mkdirSync(runs.dir, { recursive: true });
  console.log(`\nRunning ${cells.length} cell${cells.length === 1 ? '' : 's'} → ${runs.dir}`);
  if (maxSpendUsd !== undefined) console.log(`Spend cap: $${maxSpendUsd.toFixed(2)}, checked between cells.`);

  // -- the summary writer, hoisted so EVERY exit path below can use it (fix pass
  // 1, 2026-08-12 review, CRITICAL). It used to be written only on the paths
  // that returned normally, so the whole class of failures that rejected out of
  // runMatrix left no run-summary.json at all — no `neverRan`, nothing.
  // Everything the report needs that only this file can know: when the run
  // started (report.ts is pure, so it has no clock) and which commit built the
  // harness. Captured BEFORE the first cell so the timestamp is the run's, not
  // the report-writing moment's.
  const startedISO = new Date().toISOString();
  const buildSha = resolveBuildSha(DESKTOP);
  /** Graded cells, in the order they finished. Filled by onResult below. */
  const graded = [];

  // Defect 1 fix (2026-08-13): report.md and run-summary.json used to have no
  // plan identifier at all, so every plan run on the same day landed in the
  // same runs.dir and a second experiment silently overwrote the first one's
  // report — the per-cell result files survive this because they are named
  // per-cell, but they're git-ignored, so the report was the durable record.
  // planFilenameSlug is matrix.ts's own sanitizer (the same one cellFilename
  // uses), reused here rather than re-implemented so the two never drift.
  const { planFilenameSlug } = await loadGraders();
  const planSlug = planFilenameSlug(plan.name);

  const reportFile = path.join(runs.dir, `report-${planSlug}.md`);
  /** Render and write the human-readable report.
   *
   *  Hoisted for the same reason writeSummary is: EVERY exit path that has
   *  results must write one. A stopped run's report is the whole point of
   *  having no resume — it is what the finished cells were paid for.
   *
   *  Wrapped: a failure to render must not also destroy the summary and the
   *  exit code. The real error is printed; the transcripts are already safe. */
  const writeReport = async ({ stopReason } = {}) => {
    if (!graded.length) return;
    try {
      const { renderReport } = await loadGraders();
      fs.writeFileSync(reportFile, renderReport(plan, graded, { startedISO, buildSha, stopReason }));
      console.log(`Report: ${reportFile}`);
    } catch (err) {
      console.error(`\nharness-eval: the results are on disk but the report could not be written: ${errText(err)}`);
      console.error(`  Per-cell transcripts and grades are in ${runs.dir}`);
    }
  };

  const summaryFile = path.join(runs.dir, `run-summary-${planSlug}.json`);
  const writeSummary = ({ stopReason, results, skipped }) => {
    fs.writeFileSync(summaryFile, JSON.stringify({
      plan: plan.name,
      stoppedEarly: Boolean(stopReason),
      stopReason: stopReason ?? null,
      // NULL, not 0, when nothing could be priced (fix pass 1, MINOR): a literal
      // 0 in a machine-readable file is the same silent zero the human-facing
      // output refuses to print, and a script summing these would read an
      // unpriced matrix as free.
      estimateUsd: estimate.perCell.some((c) => c.usd !== null) ? estimate.totalUsd : null,
      unpricedModels: estimate.unpriced,
      // `null` (not `[]`) means "this run failed in a way it could not attribute,
      // so which cells ran is unknown" — see the untagged branch below. An empty
      // array would be a claim that no cell ran.
      completed: results ? results.map((r) => r.cellId) : null,
      failed: results ? results.filter((r) => r.error).map((r) => ({ cellId: r.cellId, error: r.error })) : null,
      neverRan: skipped ? skipped.map((c) => c.id) : null,
    }, null, 2));
  };

  const matrix = await runMatrix(cells, {
    maxSpendUsd,
    // Task 8c: each cell gets ITS OWN arm's text. `?? undefined` because a
    // baseline arm maps to `null` here and runCell's option is optional — the
    // two spellings must not be confused, since `null` would be a value the
    // worker then carries into runCase as an explicit "no instructions".
    runOne: (cell) => runCell(cell, {
      apiKey,
      timeoutMs,
      instructionsText: instructionsByArmId.get(cell.instructionsId) ?? undefined,
    }),
    readUsage: () => fetchKeyUsage(apiKey),
    // Written as each cell finishes, not at the end: a run that is stopped —
    // by the cap, by Ctrl-C, or by a crash — must not also lose the results of
    // the cells that were already paid for.
    onResult: async (cell, result) => {
      // THE TRANSCRIPT IS WRITTEN FIRST — before the checks run, before the
      // judge is called, before the report is rendered. This ordering is a
      // hard-won rule, not a preference: a previous round lost four paid
      // conversations to a save that sat behind a throw. Everything after this
      // line can fail without costing the record of what was bought.
      const file = await cellResultPath(runs.dir, cell);
      fs.writeFileSync(file, JSON.stringify(result, null, 2));
      const label = result.timedOut ? 'TIMED OUT' : (result.error ? 'error' : 'ok');
      console.log(`  ${label} → ${path.basename(file)}`);

      // Now grade it. gradeCell never throws (see its header), so a broken
      // judge or a broken check cannot stop the matrix — which matters because
      // runMatrix treats a throw from onResult as "stop, the disk is failing".
      const gradedCell = await gradeCell(cell, result, { apiKey, judgeModelId: plan.judge ?? null, runDir: runs.dir });
      graded.push(gradedCell);
      if (gradedCell.gradingError) console.log(`  not graded: ${gradedCell.gradingError}`);
    },
  }).catch(async (err) => {
    // Fix pass 1 (2026-08-12 review, CRITICAL). This used to print one hardcoded
    // sentence — "--max-spend was given but the starting OpenRouter usage could
    // not be read ... NOTHING WAS SPENT" — for EVERY rejection, and runMatrix had
    // four other reachable rejection paths, all of them AFTER earlier cells had
    // been billed. A tool whose entire purpose is spend control told the operator
    // his money was safe when it was not. Two branches now, and neither guesses:
    // the tag comes from runMatrix, which is the only code that knows.
    //
    // Normalised first because a rejection is not guaranteed to be an Error, and
    // reading `.message` off `null` here would replace the real failure with a
    // TypeError from the error handler itself.
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (err instanceof Error && err.beforeFirstCell) {
      console.error(
        `\nharness-eval: the run stopped BEFORE the first cell, so nothing was spawned and nothing was spent.`
        + `\n  ${err.message}`,
      );
      process.exit(2);
    }
    // Not attributable. Say exactly that, print the real error, and do NOT claim
    // anything about what was spent — per-cell result files are written as each
    // cell finishes, so whatever ran is already on disk.
    writeSummary({ stopReason: `the run failed in a way it could not attribute: ${detail}` });
    // Cells that finished before this were BILLED, and there is no resume — so
    // whatever was graded still gets a report rather than being thrown away
    // with the failure. (`await` inside this handler is why it is async; both
    // of its branches exit, so nothing downstream sees its return value.)
    await writeReport({ stopReason: `the run failed in a way it could not attribute: ${detail}` });
    console.error(
      `\nharness-eval: the run stopped and could not attribute the failure to a cell.`
      + `\n  ${detail}`
      + `\n  Cells may already have run and been BILLED. Per-cell results, if any, are in ${runs.dir}`
      + `\n  Summary: ${summaryFile}`,
    );
    // 3 (stopped early), not 2 (usage error): whether the matrix is complete is
    // unknown, and a script must not read it as finished.
    process.exit(3);
  });
  const { results, skipped, stopReason } = matrix;

  // -- the summary. `skipped` is the list this whole gate exists to make
  // legible: exactly which rows of the printed grid never happened.
  writeSummary({ stopReason, results, skipped });
  // The report comes last, after every transcript and every grade file is
  // already on disk — it is a rendering of them, never the only copy.
  await writeReport({ stopReason });

  console.log(`\n${results.length} of ${cells.length} cells ran. Summary: ${summaryFile}`);
  if (stopReason) {
    console.error(`\nSTOPPED EARLY: ${stopReason}`);
    console.error(`\nThese ${skipped.length} cell${skipped.length === 1 ? '' : 's'} never ran:`);
    for (const cell of skipped) console.error(`  ${cell.id}`);
    // A distinct exit code so a script cannot read an incomplete matrix as a
    // finished one. 0 = every cell ran; 2 = usage error; 3 = stopped early.
    process.exit(3);
  }
}

// Fix (review round 1, MINOR 3): only run main when this file IS the process's
// entry point. Before this, main ran at module scope, so any `await
// import(...)` of this module from a test immediately printed the usage error
// and called process.exit(2) — which made the plan loader/runCell
// exported-but-unreachable and the validator untestable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // main is async now (the graders are ES-imported from dist at run time), so a
  // rejection would otherwise surface as an unhandled-rejection warning and a
  // zero exit code. Exit 1, with the real error, never a summary of it.
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}

export {
  readPlanFile, loadInstructionTexts, expandPlanFile, cellResultPath, resolveRunsDir, runCell, workerEnv, redactKey, loadGraders,
  loadApiKey, scrubProcessTitle, runMatrix, fetchKeyUsage, comparisonNoiseWarning, DEFAULT_CELL_TIMEOUT_MS,
};
