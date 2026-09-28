// desktop/tests/helpers/main-blocking-calls.ts
//
// The scanner behind tests/main-blocking-calls.test.ts: finds every call in the
// Electron MAIN process that blocks its one thread — `fs.*Sync(...)`,
// child_process `execSync/execFileSync/spawnSync`, and the same names imported
// on their own (`import { readFileSync } from 'fs'`).
//
// WHY the TypeScript compiler API and not a text regex: the old per-file
// ast-grep rules each matched only the literal spelling `fs.XSync(...)`, so a
// named import (`readFileSync(p)`), an aliased one (`existsSync as exists`) or
// `require('fs').statSync(p)` slipped past all of them. Resolving each call back
// to the module it was imported from catches every spelling, and the AST also
// gives the enclosing function name the allowlist is keyed on.
import * as ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/** Modules whose `*Sync` members block the calling thread. */
const BLOCKING_MODULES = new Set([
  'fs', 'node:fs', 'original-fs', 'graceful-fs', 'fs-extra',
  'child_process', 'node:child_process',
]);

export interface BlockingCall {
  /** Path relative to src/main, forward slashes. */
  file: string;
  /** Named scopes enclosing the call, outermost first ('' = top level). */
  chain: string[];
  /** `chain.join('.')`, or `<top-level>`. The allowlist key. */
  fn: string;
  /** The callee as written: `fs.readFileSync`, `readFileSync`, `cp.execSync`. */
  call: string;
  /** Full call text, whitespace collapsed — for the targeted bans. */
  text: string;
  line: number;
}

export interface ScannedFile {
  file: string;
  source: ts.SourceFile;
  calls: BlockingCall[];
  /** Every named scope declared in the file (for "must still exist" checks). */
  scopes: Set<string>;
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n);
}

function propName(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

/** A readable first argument (`'ready'`, `IPC.SESSION_CREATE`) — see scopeName. */
function channelArg(arg: ts.Expression | undefined, sf: ts.SourceFile): string | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return `'${arg.text}'`;
  // Only a constant-looking name (`IPC.SESSION_CREATE`), not a local value
  // (`args.file_path`), which says nothing about which handler this is.
  if (ts.isPropertyAccessExpression(arg) && /^[A-Z]\w*(\.\w+)+$/.test(arg.getText(sf))) return arg.getText(sf);
  return undefined;
}

/**
 * The name a function-like node contributes to the enclosing chain, or
 * undefined for an anonymous callback (which belongs to its parent's scope).
 *
 * WHY the `on('ready')` / `handle(IPC.X)` form: ipc-handlers.ts registers ~200
 * anonymous handlers inside ONE function. Without this every blocking call in
 * the file would share one allowlist key and one big count; with it each IPC
 * channel is its own entry, so the list says which handler blocks.
 */
function scopeName(n: ts.Node, sf: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) return n.name?.text ?? 'default';
  if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) return propName(n.name, sf);
  if (ts.isConstructorDeclaration(n)) return 'constructor';
  if ((ts.isFunctionExpression(n) || ts.isClassExpression(n)) && n.name) return n.name.text;
  if (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isClassExpression(n)) {
    const p = n.parent;
    if (ts.isVariableDeclaration(p) && p.initializer === n) return propName(p.name, sf);
    if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.initializer === n) return propName(p.name, sf);
    if (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(p.left)) return p.left.name.text;
    if (ts.isCallExpression(p) && p.arguments[0] !== n) {
      const ch = channelArg(p.arguments[0], sf);
      if (ch) {
        const callee = ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : p.expression.getText(sf);
        return `${callee}(${ch})`;
      }
    }
  }
  return undefined;
}

function moduleOf(expr: ts.Expression | undefined): string | undefined {
  // require('fs')
  if (expr && ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'require' &&
      expr.arguments.length === 1 && ts.isStringLiteral(expr.arguments[0])) return expr.arguments[0].text;
  return undefined;
}

export function scanSource(file: string, text: string): ScannedFile {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** local name → true: a whole-module binding (`import * as fs`, `import fs`, `const fs = require('fs')`). */
  const moduleBindings = new Set<string>();
  /** local name → imported name, for named imports ending in Sync. */
  const namedSync = new Map<string, string>();

  const collect = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && BLOCKING_MODULES.has(n.moduleSpecifier.text)) {
      const c = n.importClause;
      if (c?.name) moduleBindings.add(c.name.text);
      const nb = c?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) moduleBindings.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (imported.endsWith('Sync')) namedSync.set(el.name.text, imported);
        }
      }
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
        ts.isStringLiteral(n.moduleReference.expression) && BLOCKING_MODULES.has(n.moduleReference.expression.text)) {
      moduleBindings.add(n.name.text);
    }
    if (ts.isVariableDeclaration(n)) {
      const mod = moduleOf(n.initializer);
      if (mod && BLOCKING_MODULES.has(mod)) {
        if (ts.isIdentifier(n.name)) moduleBindings.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const imported = el.propertyName ? propName(el.propertyName, sf)! : el.name.text;
            if (imported.endsWith('Sync')) namedSync.set(el.name.text, imported);
          }
        }
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  // A receiver literally named `fs` counts even when it arrived as a parameter
  // (`fs: typeof import('fs')`) rather than an import — that is how the old rules
  // matched it, and nothing else in src/main is called `fs`.
  moduleBindings.add('fs');

  const calls: BlockingCall[] = [];
  const scopes = new Set<string>();
  const visit = (n: ts.Node, chain: string[]): void => {
    let next = chain;
    if (isFunctionLike(n)) {
      const name = scopeName(n, sf);
      if (name) { next = [...chain, name]; scopes.add(name); }
    }
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      let blocking = false;
      // `fs.realpathSync.native(p)` blocks exactly like `fs.realpathSync(p)`.
      const target = ts.isPropertyAccessExpression(e) && e.name.text === 'native' && ts.isPropertyAccessExpression(e.expression)
        ? e.expression : e;
      if (ts.isPropertyAccessExpression(target) && target.name.text.endsWith('Sync')) {
        const obj = target.expression;
        if (ts.isIdentifier(obj) && moduleBindings.has(obj.text)) blocking = true;
        const mod = moduleOf(obj);
        if (mod && BLOCKING_MODULES.has(mod)) blocking = true;
      } else if (ts.isIdentifier(e) && namedSync.has(e.text)) {
        blocking = true;
      }
      if (blocking) {
        calls.push({
          file,
          chain: next,
          fn: next.length ? next.join('.') : '<top-level>',
          call: e.getText(sf).replace(/\s+/g, ''),
          text: n.getText(sf).replace(/\s+/g, ' '),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        });
      }
    }
    ts.forEachChild(n, (c) => visit(c, next));
  };
  visit(sf, []);
  return { file, source: sf, calls, scopes };
}

/** Every non-test .ts file under `mainDir`, relative paths with forward slashes. */
export function mainFiles(mainDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        walk(abs);
      } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
        out.push(relative(mainDir, abs).split('\\').join('/'));
      }
    }
  };
  walk(mainDir);
  return out.sort();
}

export function scanMain(mainDir: string): Map<string, ScannedFile> {
  const out = new Map<string, ScannedFile>();
  for (const f of mainFiles(mainDir)) {
    // WHY strip \r: the Windows CI checkout may be CRLF; keys must not differ by platform.
    out.set(f, scanSource(f, readFileSync(join(mainDir, f), 'utf8').replace(/\r/g, '')));
  }
  return out;
}

export interface AllowEntry { file: string; fn: string; call: string; count: number; reason?: string }

/** `file|fn|call` — the identity of one allowlist entry. */
export function keyOf(e: { file: string; fn: string; call: string }): string {
  return `${e.file}|${e.fn}|${e.call}`;
}
