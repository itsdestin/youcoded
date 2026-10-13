#!/usr/bin/env node
// Writes preload.ts's channel-name list from shared/backend-contract.ts.
//   node scripts/generate-preload-channels.mjs           rewrite the block in preload.ts
//   node scripts/generate-preload-channels.mjs --check   exit 1 (and say so) if it is stale
//
// WHY (2026-09-29 one-core R2, Destin 2026-09-29: generated, still statically enumerated):
// Electron's sandboxed preload cannot require another module at runtime, so the channel list
// has to live INSIDE preload.ts's own compiled output. It used to be a hand-kept copy of the
// contract's IPC constant (four hand lists drifting). Now the contract is the only place a
// name is written and this script copies it into preload as a plain object literal: every
// channel spelled out as a string, no Proxy, no lookup at call time, so the bridge stays as
// explicitly enumerated as it was when a human typed it. Reviewers read the generated block
// in preload.ts exactly like any other code.
//
// Wired into build, build:main, dev:main (write mode) and typecheck (--check) in package.json;
// tests/generate-preload-channels.test.ts fails when the committed block is stale.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.join(here, '..', 'src', 'shared', 'backend-contract.ts');
const PRELOAD = path.join(here, '..', 'src', 'main', 'preload.ts');
const CAPABILITIES = path.join(here, '..', 'src', 'shared', 'capabilities.ts');
export const BEGIN = '// >>> GENERATED-CHANNELS — written by scripts/generate-preload-channels.mjs from shared/backend-contract.ts. Do not edit by hand.';
export const END = '// <<< GENERATED-CHANNELS';
// WHY a second block (one-core R4-1): the desktop window reads the same `capabilities` object a phone is sent in
// `auth:ok`, and the preload cannot import it either. Same rule as the channels: written once in shared/, copied here.
export const CAP_BEGIN = '// >>> GENERATED-CAPABILITIES — written by scripts/generate-preload-channels.mjs from shared/capabilities.ts. Do not edit by hand.';
export const CAP_END = '// <<< GENERATED-CAPABILITIES';

/** [key, value] pairs of the contract's `export const IPC = { ... } as const`, in source order. */
export function readContractChannels(source) {
  const sf = ts.createSourceFile('backend-contract.ts', source, ts.ScriptTarget.Latest, true);
  let pairs = null;
  sf.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'IPC' || !decl.initializer) continue;
      let init = decl.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (!ts.isObjectLiteralExpression(init)) throw new Error('IPC is not an object literal');
      pairs = init.properties.map((p) => {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || !ts.isStringLiteral(p.initializer)) {
          throw new Error(`IPC entry "${p.getText(sf)}" must be KEY: 'literal' (the generator copies it verbatim)`);
        }
        return [p.name.text, p.initializer.text];
      });
    }
  });
  if (!pairs) throw new Error('export const IPC not found in backend-contract.ts');
  return pairs;
}

/** The literal value of `export const <name> = <literal>` in a source file: numbers, booleans, strings and plain objects of them. */
export function readConstLiteral(source, name) {
  const sf = ts.createSourceFile('capabilities.ts', source, ts.ScriptTarget.Latest, true);
  const evalNode = (n) => {
    while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression;
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (ts.isStringLiteral(n)) return n.text;
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isObjectLiteralExpression(n)) {
      return n.properties.map((p) => {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) throw new Error(`${name}: "${p.getText(sf)}" must be key: literal`);
        return [p.name.text, evalNode(p.initializer)];
      });
    }
    throw new Error(`${name}: "${n.getText(sf)}" is not a plain literal (the generator copies it verbatim)`);
  };
  let found;
  sf.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const d of node.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) found = evalNode(d.initializer);
    }
  });
  if (found === undefined) throw new Error(`export const ${name} not found in capabilities.ts`);
  return found;
}

/** The capabilities block: PROTOCOL_VERSION and the desktop window's capabilities as plain literals. */
export function renderCapabilitiesBlock(version, pairs) {
  const lit = (v) => (typeof v === 'string' ? `'${v}'` : String(v));
  const rows = pairs.map(([k, v]) => `  ${k}: ${lit(v)},`).join('\n');
  return `${CAP_BEGIN}\nconst PROTOCOL_VERSION = ${version};\nconst DESKTOP_WINDOW_CAPABILITIES = {\n${rows}\n} as const;\n${CAP_END}`;
}

/** The text that sits between (and including) the BEGIN and END markers. */
export function renderBlock(pairs) {
  const rows = pairs.map(([k, v]) => `  ${k}: '${v}',`).join('\n');
  return `${BEGIN}\nconst IPC = {\n${rows}\n} as const;\n${END}`;
}

/** preload.ts with its generated block replaced (or throws if the markers are missing). */
export function applyBlock(preloadSource, block, begin = BEGIN, end = END) {
  const start = preloadSource.indexOf(begin);
  const stop = preloadSource.indexOf(end);
  if (start < 0 || stop < start) throw new Error(`${end.replace('// <<< ', '')} markers not found in preload.ts`);
  return preloadSource.slice(0, start) + block + preloadSource.slice(stop + end.length);
}

export function expectedPreload() {
  const pairs = readContractChannels(fs.readFileSync(CONTRACT, 'utf8'));
  const current = fs.readFileSync(PRELOAD, 'utf8');
  const capSource = fs.readFileSync(CAPABILITIES, 'utf8');
  const caps = renderCapabilitiesBlock(readConstLiteral(capSource, 'PROTOCOL_VERSION'), readConstLiteral(capSource, 'DESKTOP_WINDOW_CAPABILITIES'));
  return { current, next: applyBlock(applyBlock(current, renderBlock(pairs)), caps, CAP_BEGIN, CAP_END) };
}

function main() {
  const { current, next } = expectedPreload();
  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error('preload.ts generated blocks are stale vs shared/backend-contract.ts / shared/capabilities.ts — run: node scripts/generate-preload-channels.mjs');
      process.exit(1);
    }
    return;
  }
  if (current !== next) fs.writeFileSync(PRELOAD, next);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
