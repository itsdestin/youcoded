// Blocks NEW silent failure-swallowing in desktop/src (R-1, code review 2026-11-18; Destin H-2 / H-6).
//
// A "silent catch" is a failure caught and ignored with nothing recorded:
//   try { ... } catch {}            (also a catch holding only a comment)
//   promise.catch(() => {})         (also () => null / undefined / false / [] / {} / void 0)
// Destin's rule (H-6): such a catch is allowed only with a one-line written reason beside it,
//   // benign: <why ignoring this failure is harmless>
// The ~480 that existed when the check was added are listed ONCE in silent-catch-baseline.json
// (file -> enclosing function -> count). The list may only SHRINK: a fix that removes a swallow
// must also lower its count, or this check says the list is stale. Keyed by function, not line
// number, so edits elsewhere in a file never break it.
//
// Usage: node scripts/silent-catch-check.mjs [srcDir]         check (exit 1 on any problem)
//        node scripts/silent-catch-check.mjs [srcDir] --write  rewrite the baseline from the source
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
export const BASELINE_PATH = path.join(HERE, 'silent-catch-baseline.json');

// Files whose swallows were reviewed as harmless in bulk, each with its reason (never add one without a reason).
const EXEMPT_FILES = {
  // 41 localStorage reads/writes: storage is blocked in private windows, so failing quietly is the design.
  'renderer/state/theme-context.tsx': 'localStorage blocked in private windows is expected; reviewed harmless 2026-11-18',
};

const EMPTY_VALUES = new Set(['NullKeyword', 'UndefinedKeyword', 'FalseKeyword', 'TrueKeyword']);

function isEmptyValue(node) {
  if (!node) return true;
  const k = ts.SyntaxKind[node.kind];
  if (EMPTY_VALUES.has(k)) return true;
  if (ts.isIdentifier(node) && node.text === 'undefined') return true;
  if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) return true;
  if (ts.isObjectLiteralExpression(node) && node.properties.length === 0) return true;
  if (ts.isVoidExpression(node)) return true;
  if (ts.isParenthesizedExpression(node)) return isEmptyValue(node.expression);
  return false;
}

function enclosingName(node) {
  for (let p = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
    if (ts.isConstructorDeclaration(p)) return 'constructor';
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent) {
      const q = p.parent;
      if (ts.isVariableDeclaration(q) && q.name) return q.name.getText();
      if ((ts.isPropertyAssignment(q) || ts.isPropertyDeclaration(q)) && q.name) return q.name.getText();
    }
  }
  return '<top-level>';
}

/** Every silent swallow in one source text: [{ fn, line, kind }]. Exported so the test can feed it samples. */
export function scanSource(text, fileName = 'x.tsx') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split('\n');
  const found = [];
  // A "benign:" reason on the line before the construct, or anywhere on its own lines, lets it through.
  const hasReason = (node) => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
    for (let i = Math.max(0, start - 1); i <= end; i++) if (/\bbenign:\s*\S/.test(lines[i] ?? '')) return true;
    return false;
  };
  const visit = (node) => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0 && !hasReason(node)) {
      found.push({ fn: enclosingName(node), kind: 'empty catch', line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch' && node.arguments.length === 1) {
      const a = node.arguments[0];
      if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters.length <= 1) {
        const body = a.body;
        const silent = ts.isBlock(body) ? body.statements.length === 0 : isEmptyValue(body);
        if (silent && !hasReason(node)) found.push({ fn: enclosingName(node), kind: '.catch(() => nothing)', line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** { 'renderer/x.tsx': { fnName: count } } for a source folder. */
export function scanDir(srcDir) {
  const result = Object.create(null);
  for (const file of walk(srcDir)) {
    const rel = path.relative(srcDir, file).split(path.sep).join('/');
    if (rel in EXEMPT_FILES) continue;
    for (const f of scanSource(fs.readFileSync(file, 'utf8'), file)) {
      // WHY a null-prototype map: a method named "constructor" or "toString" must not collide with Object's own.
      (result[rel] ??= Object.create(null));
      result[rel][f.fn] = (result[rel][f.fn] ?? 0) + 1;
    }
  }
  return result;
}

/** Compare a scan to the frozen list. Returns human-readable problems ([] = clean). */
export function compare(current, baseline) {
  const problems = [];
  const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const f of [...files].sort()) {
    const fns = new Set([...Object.keys(current[f] ?? {}), ...Object.keys(baseline[f] ?? {})]);
    for (const fn of [...fns].sort()) {
      const now = Object.hasOwn(current[f] ?? {}, fn) ? current[f][fn] : 0, was = Object.hasOwn(baseline[f] ?? {}, fn) ? baseline[f][fn] : 0;
      if (now > was) problems.push(`NEW silent catch in ${f} (${fn}): ${now} found, ${was} allowed. Report it with reportFailure(), or write "// benign: <why this is harmless>" beside it.`);
      if (now < was) problems.push(`STALE list: ${f} (${fn}) now has ${now}, list allows ${was}. Lower it (run with --write) so the list only shrinks.`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const srcDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(HERE, '..', 'src'));
  const current = scanDir(srcDir);
  if (args.includes('--write')) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
    const n = Object.values(current).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
    console.log(`wrote ${BASELINE_PATH}: ${n} allowed swallows`);
  } else {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const problems = compare(current, baseline);
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('silent-catch check: OK');
  }
}
