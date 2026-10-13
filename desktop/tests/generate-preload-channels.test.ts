// Preload's channel list is GENERATED from shared/backend-contract.ts (one-core R2, Destin
// 2026-09-29: generated, still statically enumerated). Three separate ways to fail:
//   1. STALE   — the committed block is not what the generator would write today. This is what
//                a contract edit without re-running the generator looks like.
//   2. DISAGREE — read independently of the generator (real IPC object vs a parse of preload's
//                literal), so a bug in the generator itself cannot hide behind test 1.
//   3. TYPO    — a string-literal channel preload calls that the contract has never heard of.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { IPC } from '../src/shared/backend-contract';

const root = path.join(__dirname, '..');
const preloadSource = fs.readFileSync(path.join(root, 'src', 'main', 'preload.ts'), 'utf8');

function parsePreload() {
  const sf = ts.createSourceFile('preload.ts', preloadSource, ts.ScriptTarget.Latest, true);
  const list = new Map<string, string>();
  const literals = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'IPC' && n.initializer) {
      let init = n.initializer;
      while (ts.isAsExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) {
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isStringLiteral(p.initializer)) list.set(p.name.text, p.initializer.text);
        }
      }
    }
    // ipcRenderer.invoke('x') / .send('x') / .on('x') with a literal name.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'ipcRenderer'
      && ['invoke', 'send', 'on', 'removeListener'].includes(n.expression.name.text)
      && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      literals.add(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { list, literals };
}

describe('preload channel list vs backend-contract', () => {
  it('is fresh: the committed block equals what the generator writes today', () => {
    expect(() => execFileSync(process.execPath, [path.join(root, 'scripts', 'generate-preload-channels.mjs'), '--check'], { stdio: 'pipe' }),
      'preload.ts is stale — run: node scripts/generate-preload-channels.mjs').not.toThrow();
  });

  it('agrees with the contract in both directions (name and value)', () => {
    const { list } = parsePreload();
    expect(list.size, 'the IPC literal in preload.ts was not parsed').toBeGreaterThan(300);
    const contract = new Map(Object.entries(IPC));
    const missingInPreload = [...contract.keys()].filter((k) => !list.has(k));
    const extraInPreload = [...list.keys()].filter((k) => !contract.has(k));
    const valueDiffers = [...list].filter(([k, v]) => contract.has(k) && contract.get(k) !== v).map(([k]) => k);
    expect({ missingInPreload, extraInPreload, valueDiffers }).toEqual({ missingInPreload: [], extraInPreload: [], valueDiffers: [] });
  });

  it('every channel preload names by string literal is a contract channel', () => {
    const { literals } = parsePreload();
    const known = new Set<string>(Object.values(IPC));
    expect([...literals].filter((c) => !known.has(c)).sort()).toEqual([]);
  });

  it('spells every channel out as a plain literal (no Proxy, no computed lookup)', () => {
    const block = preloadSource.slice(preloadSource.indexOf('// >>> GENERATED-CHANNELS'), preloadSource.indexOf('// <<< GENERATED-CHANNELS'));
    expect(block).not.toMatch(/Proxy|\[[^\]]*\]\s*:|Object\.(fromEntries|assign)|require\(/);
  });
});
