import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { describe, expect, it } from 'vitest';
import { assertPatternMatches, assertScopeIsPopulated, stripComments } from './helpers/guard-scope';

/**
 * The harness evaluator (src/main/harness/eval/) does not ship.
 *
 * It is developer tooling: a matrix runner driven by test-engine/harness-eval.mjs
 * that spends real money against OpenRouter. It lives under src/main so that each
 * evaluated build's `npm run build:main` compiles it beside the code it evaluates,
 * and that is the trap — tsc emits it into dist/, and electron-builder packages
 * `dist/**`. Until 2026-09-16 every installer carried it (~4,200 lines, 14 files,
 * its own OpenRouter factory and fixture manifest) with no IPC channel, npm
 * script or screen reaching any of it.
 *
 * Two things keep it out, and each is worthless without the other:
 *
 *  1. electron-builder.yml excludes dist/main/harness/eval/** from `files`.
 *  2. Nothing under src/ outside that directory imports from it. If something
 *     did, the exclusion would ship a broken require() instead of a smaller app.
 *
 * Source-text on purpose: the failure guarded against is a future import added
 * on a path no test drives, and a behaviour test only covers what it thought to
 * try. Relative specifiers are RESOLVED (a `./eval/...` from harness/ and a
 * `../harness/eval/...` from providers/ are the same edge), which is why this is
 * a test and not an ast-grep regex over specifier text.
 */

const DESKTOP = join(__dirname, '..');
const SRC = join(DESKTOP, 'src');
const EVAL_DIR = join(SRC, 'main', 'harness', 'eval');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(abs);
  }
  return out;
}

function isInsideEval(abs: string): boolean {
  const rel = relative(EVAL_DIR, abs);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

// Static imports, re-exports, dynamic import() and require() — every way one
// module names another. The specifier is group 1.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** Where a specifier written in `file` lands on disk, or null for a package. */
function resolveSpecifier(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return resolve(dirname(file), spec);
}

/** Every (file, specifier) edge in `file` whose target is inside the eval dir. */
function evalEdges(file: string): string[] {
  const src = stripComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  const edges: string[] = [];
  for (const m of src.matchAll(SPECIFIER)) {
    const target = resolveSpecifier(file, m[1]);
    if (target && isInsideEval(target)) edges.push(m[1]);
  }
  return edges;
}

describe('the harness evaluator does not ship', () => {
  it('electron-builder.yml excludes dist/main/harness/eval/** from the packaged files', () => {
    const yml = readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n');
    // The `files:` list, up to the next top-level key.
    const filesBlock = /^files:\n((?:[ \t].*\n|\n)*)/m.exec(yml)?.[1] ?? '';
    expect(filesBlock, 'electron-builder.yml has no top-level files: list').not.toBe('');
    const entries = [...filesBlock.matchAll(/^\s*-\s*"?([^"\n]+?)"?\s*$/gm)].map((m) => m[1]);
    expect(entries).toContain('dist/**/*');
    expect(
      entries,
      'dist/main/harness/eval/** is no longer excluded — the evaluator would ship in every installer',
    ).toContain('!dist/main/harness/eval/**');
  });

  it('nothing under src/ outside harness/eval imports from it', () => {
    const files = walk(SRC).filter((f) => !isInsideEval(f));
    assertScopeIsPopulated(files, 300);
    // Non-vacuity: the resolver must see the edge it exists to catch.
    assertPatternMatches(SPECIFIER, "import { isNumeric } from '../harness/eval/estimate';", 'a relative import');
    expect(resolveSpecifier(join(SRC, 'main', 'providers', 'model-catalog.ts'), '../harness/eval/estimate'))
      .toBe(join(EVAL_DIR, 'estimate'));
    expect(isInsideEval(join(EVAL_DIR, 'estimate'))).toBe(true);
    expect(isInsideEval(join(SRC, 'main', 'harness', 'evaluate.ts'))).toBe(false);

    const offenders = files.flatMap((f) => evalEdges(f).map((spec) => `${relative(DESKTOP, f)} → ${spec}`));
    expect(
      offenders,
      'packaged code imports the harness evaluator, which electron-builder.yml leaves out of the installer',
    ).toEqual([]);
  });

  it('the evaluator itself still resolves its imports inside src/ (the edge runs one way)', () => {
    // If the eval directory moved or emptied, the guard above would pass while
    // proving nothing. The directory must exist and be the only thing that
    // imports from it.
    const evalFiles = walk(EVAL_DIR);
    expect(evalFiles.length).toBeGreaterThanOrEqual(10);
    const internal = evalFiles.filter((f) => evalEdges(f).length > 0);
    expect(internal.length, 'no eval file imports another eval file — has the directory been hollowed out?').toBeGreaterThan(0);
  });
});
