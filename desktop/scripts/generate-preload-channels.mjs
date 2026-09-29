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
export const BEGIN = '// >>> GENERATED-CHANNELS — written by scripts/generate-preload-channels.mjs from shared/backend-contract.ts. Do not edit by hand.';
export const END = '// <<< GENERATED-CHANNELS';

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

/** The text that sits between (and including) the BEGIN and END markers. */
export function renderBlock(pairs) {
  const rows = pairs.map(([k, v]) => `  ${k}: '${v}',`).join('\n');
  return `${BEGIN}\nconst IPC = {\n${rows}\n} as const;\n${END}`;
}

/** preload.ts with its generated block replaced (or throws if the markers are missing). */
export function applyBlock(preloadSource, block) {
  const start = preloadSource.indexOf(BEGIN);
  const end = preloadSource.indexOf(END);
  if (start < 0 || end < start) throw new Error('GENERATED-CHANNELS markers not found in preload.ts');
  return preloadSource.slice(0, start) + block + preloadSource.slice(end + END.length);
}

export function expectedPreload() {
  const pairs = readContractChannels(fs.readFileSync(CONTRACT, 'utf8'));
  const current = fs.readFileSync(PRELOAD, 'utf8');
  return { current, next: applyBlock(current, renderBlock(pairs)) };
}

function main() {
  const { current, next } = expectedPreload();
  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error('preload.ts channel list is stale vs shared/backend-contract.ts — run: node scripts/generate-preload-channels.mjs');
      process.exit(1);
    }
    return;
  }
  if (current !== next) fs.writeFileSync(PRELOAD, next);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
